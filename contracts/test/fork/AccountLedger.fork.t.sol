// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm, console} from "forge-std/Test.sol";
import {ReduceOnlyGuard} from "../../src/ReduceOnlyGuard.sol";
import {Position, BookParams} from "../../src/interfaces/IDreamDex.sol";
import {GuardForkBase, Level, AccountState, HealthSnapshot, IBank, IPool} from "./GuardForkBase.sol";

interface ILiquidationEngine {
    function liquidate(address account) external;
}

interface IOracle {
    function getPrice() external view returns (uint256 price, uint256 updatedAt);
    function getMarkPrice() external view returns (uint256 price, uint256 updatedAt);
}

interface IBankStatus {
    function getMarginStatus(address account) external view returns (uint8);
    function withdraw(uint256 amount) external;
}

/// Ledger semantics the off-chain recomputation relies on, observed on the real venue:
/// whole-position funding settlement and floored realized PnL on a partial reduce of a
/// real multi-market account, cancellation conserving collateral, and a liquidation
/// invalidating a confirmed action.
contract AccountLedgerForkTest is GuardForkBase {
    /// A real account holding BTC, ETH and other markets at the pinned block, with no
    /// resting orders and funding owed on BTC. Override with REAL_ACCOUNT for another block.
    address internal constant DEFAULT_REAL_ACCOUNT = 0x2E3631D9c6497103BE981Fe3a48B11ba06fDB745;

    function _divFloor(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && ((a < 0) != (b < 0))) q -= 1;
    }

    function _divCeil(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && ((a < 0) == (b < 0))) q += 1;
    }

    struct Leg {
        address pool;
        Position pos;
    }

    function _legs(address account) internal view returns (Leg[] memory legs, AccountState memory s) {
        s = IBank(BANK).getAccountState(account);
        legs = new Leg[](s.activePerpPools.length);
        for (uint256 i; i < legs.length; ++i) {
            legs[i] = Leg(s.activePerpPools[i], IBank(BANK).getPosition(account, s.activePerpPools[i]));
        }
    }

    /// Independent equity: unlocked + sum(floor PnL) - sum(ceil funding owed).
    function _equity(address account) internal view returns (int256 e) {
        (Leg[] memory legs, AccountState memory s) = _legs(account);
        e = s.unlocked;
        for (uint256 i; i < legs.length; ++i) {
            (bool ok, HealthSnapshot memory h) = IPool(legs[i].pool).tryGetHealthSnapshot();
            require(ok, "unpriceable market");
            int256 size = legs[i].pos.size;
            e += _divFloor((int256(h.markPrice) - int256(uint256(legs[i].pos.avgEntryPrice))) * size, int256(h.oneBase));
            e -= _divCeil(size * (h.projectedCumulativeFunding - legs[i].pos.entryFundingIndex), int256(1e18 * h.oneBase));
        }
    }

    struct Ledger {
        int256 settled;
        uint256 settlements;
        int256 realized;
        int256 expectedRealized;
        int256 newIndex;
        uint256 fees;
    }

    /// The account's ledger rows in one transaction's logs: funding settlements,
    /// realized PnL and the reset funding index from PositionUpdated, fee rows, and the
    /// realized PnL recomputed per fill of taker order `orderId` with floor rounding.
    function _ledger(Vm.Log[] memory logs, address account, uint128 orderId, uint128 entry, uint256 oneBase)
        internal
        pure
        returns (Ledger memory led)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            bool mine = l.topics.length > 1 && address(uint160(uint256(l.topics[1]))) == account;
            if (l.emitter == BANK && mine && l.topics[0] == FUNDING_SETTLED) {
                led.settlements++;
                led.settled += abi.decode(l.data, (int256));
            } else if (l.emitter == BANK && mine && l.topics[0] == POSITION_UPDATED) {
                (,, int256 pnl, int256 idx) = abi.decode(l.data, (int128, uint128, int256, int256));
                led.realized += pnl;
                led.newIndex = idx;
            } else if (l.emitter == BANK && mine && l.topics[0] == FEE_CHARGED) {
                led.fees++;
            } else if (l.emitter == BTC && l.topics[0] == ORDER_FILLED && uint256(l.topics[1]) == orderId) {
                (uint256 q,,, uint256 px) = abi.decode(l.data, (uint256, uint256, uint256, uint256));
                led.expectedRealized += _divFloor((int256(px) - int256(uint256(entry))) * int256(q), int256(oneBase));
            }
        }
    }

    struct RealRun {
        address account;
        Position p0;
        Leg[] legs0;
        AccountState s0;
        HealthSnapshot h;
        int256 owed;
        uint256 qty;
        int128 sizeAfter;
        Ledger led;
    }

    /// Reduce half of a real account's BTC long through the guard and check, from the
    /// receipt, that funding settles on the WHOLE position, realized PnL is floored per
    /// fill, the bank's unlocked balance moves by exactly those amounts, and no other
    /// market moves.
    function test_realAccount_partialReduce_ledger() public {
        _fork();
        RealRun memory run = _prepareRealRun(vm.envOr("REAL_ACCOUNT", DEFAULT_REAL_ACCOUNT));
        _executeRealRun(run);
        _assertRealRun(run);
    }

    function _prepareRealRun(address account) internal view returns (RealRun memory run) {
        run.account = account;
        run.p0 = IBank(BANK).getPosition(account, BTC);
        (run.legs0, run.s0) = _legs(account);
        require(run.p0.size > 0, "REAL_ACCOUNT must hold a BTC long at FORK_BLOCK");
        require(run.s0.locked == 0, "REAL_ACCOUNT must have no resting orders");
        console.log("account", account, "active markets", run.legs0.length);
        (int256 bankEquity0,,,) = IBank(BANK).getAccountHealth(account);
        assertEq(_equity(account), bankEquity0, "independent equity before");
        (, run.h) = IPool(BTC).tryGetHealthSnapshot();
        run.owed = _divCeil(int256(run.p0.size) * (run.h.projectedCumulativeFunding - run.p0.entryFundingIndex), int256(1e18 * run.h.oneBase));
        console.log("funding owed on the whole BTC position (raw)");
        console.logInt(run.owed);
    }

    function _executeRealRun(RealRun memory run) internal {
        address[] memory pools = new address[](2);
        pools[0] = BTC;
        pools[1] = ETH;
        ReduceOnlyGuard g = new ReduceOnlyGuard(run.account, BANK, pools);
        _grant(run.account, address(g), BTC, true);
        BookParams memory grid = IPool(BTC).getOrderBookParameters();
        run.qty = (uint256(int256(run.p0.size)) / 2 / grid.lotSize) * grid.lotSize;
        ReduceOnlyGuard.ReduceRequest memory r = ReduceOnlyGuard.ReduceRequest({
            pool: BTC,
            expectedSignedSize: run.p0.size,
            isBid: false,
            quantity: run.qty,
            limitPrice: _levels(BTC, true, 12)[11].price,
            deadline: uint64(block.timestamp + 120),
            nonce: keccak256("real-account")
        });
        vm.recordLogs();
        vm.prank(run.account);
        uint128 orderId;
        (, orderId, run.sizeAfter) = g.reduce(r);
        run.led = _ledger(vm.getRecordedLogs(), run.account, orderId, run.p0.avgEntryPrice, run.h.oneBase);
    }

    function _assertRealRun(RealRun memory run) internal view {
        console.log("funding settled (raw)");
        console.logInt(run.led.settled);
        console.log("realized PnL (raw)");
        console.logInt(run.led.realized);
        assertEq(run.led.settlements, 1, "one funding settlement");
        assertEq(run.led.settled, run.owed, "settled on the whole position, ceil-rounded");
        assertEq(run.led.realized, run.led.expectedRealized, "realized PnL floored per fill");
        assertEq(run.led.newIndex, run.h.projectedCumulativeFunding, "entry funding index reset to the projected index");
        assertEq(run.led.fees, 0, "fees are zero on this deployment");

        (Leg[] memory legs1, AccountState memory s1) = _legs(run.account);
        assertEq(s1.unlocked - run.s0.unlocked, run.led.realized - run.led.settled, "unlocked moved by realized PnL minus funding");
        assertEq(s1.locked, run.s0.locked, "locked unchanged");
        assertEq(uint256(int256(run.sizeAfter)), uint256(int256(run.p0.size)) - run.qty, "requested quantity filled");
        assertEq(legs1.length, run.legs0.length, "same active markets");
        for (uint256 i; i < run.legs0.length; ++i) {
            if (run.legs0[i].pool == BTC) {
                assertEq(legs1[i].pos.avgEntryPrice, run.p0.avgEntryPrice, "BTC entry kept on a partial reduce");
                continue;
            }
            _assertSamePosition(legs1[i].pos, run.legs0[i].pos, "other market");
        }
        (int256 bankEquity1,,,) = IBank(BANK).getAccountHealth(run.account);
        assertEq(_equity(run.account), bankEquity1, "independent equity after");
    }

    /// Cancelling an ordinary resting order moves its lock back to unlocked collateral:
    /// total collateral, positions and maintenance margin are unchanged, and bank equity
    /// (which excludes locked collateral) rises by exactly the released amount.
    function test_cancelOrdinaryOrder_conservesCollateral() public {
        BookParams memory grid = IPool(BTC).getOrderBookParameters();
        uint256 price = (_levels(BTC, true, 1)[0].price * 99 / 100 / grid.tickSize) * grid.tickSize;
        vm.prank(owner);
        IPool(BTC).placeOrder(true, 0, price, 2_000_000, uint64(block.timestamp + 600) * 1e9, 0, 0, address(0), 0);
        vm.prank(owner);
        uint128[] memory ids = IPool(BTC).getOwnOpenOrders();
        assertEq(ids.length, 1, "one resting order");

        AccountView memory v1 = _view(owner);
        (int256 eq1, uint256 im1, uint256 mm1, uint256 cm1) = IBank(BANK).getAccountHealth(owner);
        assertGt(v1.locked, 0, "opening order locks collateral");

        vm.prank(owner);
        IPool(BTC).cancelOrder(ids[0]);

        AccountView memory v2 = _view(owner);
        (int256 eq2, uint256 im2, uint256 mm2, uint256 cm2) = IBank(BANK).getAccountHealth(owner);
        uint256 released = v1.locked - v2.locked;
        console.log("released lock (raw)", released);
        assertEq(v2.locked, 0, "lock released");
        assertEq(v2.unlocked, v1.unlocked + int256(released), "moved to unlocked");
        assertEq(v2.unlocked + int256(v2.locked), v1.unlocked + int256(v1.locked), "collateral conserved");
        _assertSamePosition(v2.btc, v1.btc, "BTC");
        _assertSamePosition(v2.eth, v1.eth, "ETH");
        assertEq(mm2, mm1, "maintenance margin unchanged");
        assertEq(im2, im1, "initial margin unchanged");
        assertEq(cm2, cm1, "close-out margin unchanged");
        assertEq(eq2, eq1 + int256(released), "health equity rises by the released lock");
        assertEq(eq2 + int256(v2.locked), eq1 + int256(v1.locked), "total equity unchanged");
    }

    /// A liquidation after confirmation changes the position; the guard then refuses.
    /// The oracle mock is test-only fault injection used to make the account
    /// liquidatable; it is cleared before the guard is called.
    function test_priorLiquidation_invalidatesConfirmedAction() public {
        // Thin the account so a 25% BTC drop puts it below maintenance.
        vm.prank(owner);
        IBankStatus(BANK).withdraw(19_300e18);
        uint256 limit = _levels(BTC, true, 4)[3].price;
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 2_000_000, limit);

        address oracle = IPool(BTC).oracle();
        (uint256 mark,) = IOracle(oracle).getMarkPrice();
        (uint256 index,) = IOracle(oracle).getPrice();
        vm.mockCall(oracle, abi.encodeWithSelector(IOracle.getMarkPrice.selector), abi.encode(mark * 75 / 100, block.timestamp));
        vm.mockCall(oracle, abi.encodeWithSelector(IOracle.getPrice.selector), abi.encode(index * 75 / 100, block.timestamp));
        uint8 status = IBankStatus(BANK).getMarginStatus(owner);
        console.log("margin status under the mocked mark", status);
        assertGe(status, 2, "account must be liquidatable under the mock");

        vm.prank(makeAddr("keeper"));
        ILiquidationEngine(LIQUIDATION_ENGINE).liquidate(owner);
        vm.clearMockedCalls();
        int128 afterLiquidation = _size(BTC);
        console.log("BTC size after liquidation");
        console.logInt(afterLiquidation);
        assertTrue(afterLiquidation != int128(5_000_000), "liquidation changed the position");

        vm.expectCall(BTC, abi.encodeWithSelector(PLACE_ORDER_FOR), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.PositionMismatch.selector, int128(5_000_000), afterLiquidation));
        guard.reduce(r);
    }
}
