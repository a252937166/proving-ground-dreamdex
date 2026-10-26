// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm, console} from "forge-std/Test.sol";
import {ReduceOnlyGuard} from "../../src/ReduceOnlyGuard.sol";
import {Position, BookParams} from "../../src/interfaces/IDreamDex.sol";
import {
    GuardForkBase,
    Level,
    IBank,
    IPool,
    IToken,
    ImmediateOrCancelNoFill,
    OnlyApprovedContracts,
    SelfMatchCancelTaker
} from "./GuardForkBase.sol";

/// Execution tests of ReduceOnlyGuard against the real venue on a pinned fork.
contract ReduceOnlyGuardForkTest is GuardForkBase {
    // ------------------------------------------------------------ successful paths

    /// Sell down half the long with a limit the book can fully satisfy.
    function test_reduceLong_requestedFill_onlyTargetMarketMoves() public {
        AccountView memory before = _view(owner);
        Level[] memory bids = _levels(BTC, true, 4);
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 2_500_000, bids[3].price);
        bytes32 id = guard.actionIdOf(r);

        vm.recordLogs();
        vm.prank(owner);
        (bytes32 actionId, uint128 orderId, int128 sizeAfter) = guard.reduce(r);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(actionId, id, "returned id");
        assertTrue(guard.used(id), "id consumed");
        assertEq(sizeAfter, int128(2_500_000), "requested quantity filled");
        Fills memory f = _fills(logs, BTC, orderId);
        assertEq(f.quantity, 2_500_000, "fills sum to the requested quantity");
        assertGe(f.minPrice, r.limitPrice, "no fill below the sell limit");
        assertEq(_restedCount(logs, BTC, orderId), 0, "IOC left nothing resting");

        AccountView memory afterView = _view(owner);
        _assertSamePosition(afterView.eth, before.eth, "ETH untouched");
        assertEq(afterView.btc.avgEntryPrice, before.btc.avgEntryPrice, "partial reduce keeps entry");
        assertEq(afterView.locked, before.locked, "no collateral left locked");
        assertEq(afterView.wallet, before.wallet, "wallet not pulled");
        assertEq(afterView.allowance, before.allowance, "allowance unchanged");
        assertEq(afterView.openOrdersBtc, before.openOrdersBtc, "no new resting BTC order");
        assertEq(_bankLogs(logs, DEPOSITED_FOR, owner) + _bankLogs(logs, DEPOSITED, owner) + _bankLogs(logs, WITHDRAWN, owner), 0, "no deposit or withdrawal");
        assertEq(IToken(USDSO).balanceOf(address(guard)), 0, "guard holds no USDso");
        assertEq(address(guard).balance, 0, "guard holds no native");
    }

    /// Buy back part of the short; every fill at or below the buy limit.
    function test_reduceShort_requestedFill() public {
        Level[] memory asks = _levels(ETH, false, 6);
        ReduceOnlyGuard.ReduceRequest memory r = _req(ETH, 5e17, asks[5].price);
        vm.recordLogs();
        vm.prank(owner);
        (, uint128 orderId, int128 sizeAfter) = guard.reduce(r);
        Fills memory f = _fills(vm.getRecordedLogs(), ETH, orderId);
        assertEq(sizeAfter, -15e17, "short reduced by 0.5 ETH");
        assertEq(f.quantity, 5e17);
        assertLe(f.maxPrice, r.limitPrice, "no fill above the buy limit");
    }

    /// Sell the whole long with a limit at the second bid level. The book holds less
    /// than the order inside the limit and much more beyond it: the fill must stop at
    /// the limit, leave the rest unfilled, and still succeed as a partial fill.
    function test_perFillBound_sell_depthBeyondLimit() public {
        Level[] memory bids = _levels(BTC, true, 3);
        uint256 inLimit = bids[0].quantity + bids[1].quantity;
        uint256 qty = uint256(int256(_size(BTC)));
        assertLt(inLimit, qty, "setup: in-limit depth must be below the order");
        assertGt(bids[2].quantity, 0, "setup: depth beyond the limit");
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, qty, bids[1].price);

        vm.recordLogs();
        vm.prank(owner);
        (, uint128 orderId, int128 sizeAfter) = guard.reduce(r);
        Fills memory f = _fills(vm.getRecordedLogs(), BTC, orderId);

        console.log("sell limit", r.limitPrice, "next bid", bids[2].price);
        console.log("fills", f.count, "min price", f.minPrice);
        assertGe(f.minPrice, r.limitPrice, "a fill crossed the sell limit");
        assertEq(f.quantity, inLimit, "filled exactly the in-limit depth");
        assertEq(uint256(int256(sizeAfter)), qty - inLimit, "unfilled remainder stays open");
        assertTrue(guard.used(guard.actionIdOf(r)), "a partial fill consumes the id");
        assertEq(_levels(BTC, true, 1)[0].price, bids[2].price, "the level beyond the limit is untouched");
        assertEq(_levels(BTC, true, 1)[0].quantity, bids[2].quantity, "and keeps its full depth");
    }

    /// The buy-side twin of the test above, on ETH.
    function test_perFillBound_buy_depthBeyondLimit() public {
        Level[] memory asks = _levels(ETH, false, 3);
        uint256 inLimit = asks[0].quantity;
        uint256 qty = uint256(-int256(_size(ETH)));
        assertLt(inLimit, qty, "setup: in-limit depth must be below the order");
        ReduceOnlyGuard.ReduceRequest memory r = _req(ETH, qty, asks[0].price);

        vm.recordLogs();
        vm.prank(owner);
        (, uint128 orderId, int128 sizeAfter) = guard.reduce(r);
        Fills memory f = _fills(vm.getRecordedLogs(), ETH, orderId);

        console.log("buy limit", r.limitPrice, "next ask", asks[1].price);
        console.log("fills", f.count, "max price", f.maxPrice);
        assertLe(f.maxPrice, r.limitPrice, "a fill crossed the buy limit");
        assertEq(f.quantity, inLimit, "filled exactly the in-limit depth");
        assertEq(sizeAfter, -int128(int256(qty - inLimit)), "unfilled remainder stays open");
        assertEq(_levels(ETH, false, 1)[0].price, asks[1].price, "the level beyond the limit is untouched");
    }

    function test_fullClose() public {
        uint256 qty = uint256(int256(_size(BTC)));
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, qty, _levels(BTC, true, 12)[11].price);
        vm.prank(owner);
        (,, int128 sizeAfter) = guard.reduce(r);
        assertEq(sizeAfter, 0, "flat");
        assertEq(IBank(BANK).getPosition(owner, BTC).avgEntryPrice, 0, "entry cleared on close");
    }

    /// The venue lets a reduction leave a remainder below its minimum order size; the
    /// guard does not forbid it either (the off-chain planner refuses such candidates).
    function test_dustRemainder_isVenueBehaviour() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        uint256 qty = uint256(int256(_size(BTC))) - p.lotSize;
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, qty, _levels(BTC, true, 12)[11].price);
        vm.prank(owner);
        (,, int128 sizeAfter) = guard.reduce(r);
        assertEq(uint256(int256(sizeAfter)), p.lotSize, "one lot left");
        assertLt(p.lotSize, p.minQuantity, "remainder is below the venue minimum");
    }

    /// A deadline equal to the block time is still valid; the venue accepts an expiry
    /// equal to now in ns.
    function test_deadlineAtBlockTime() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        r.deadline = uint64(block.timestamp);
        vm.prank(owner);
        guard.reduce(r);
        assertEq(_size(BTC), 4_000_000);
    }

    // ------------------------------------------------- zero fill and venue rejections

    /// A sell limit above the best bid crosses nothing. The venue reverts the IOC and
    /// the guard's reservation of the id goes with it.
    function test_zeroFill_revertsAndKeepsIdUnused() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 1)[0].price + 100 * p.tickSize);
        AccountView memory before = _view(owner);
        vm.prank(owner);
        vm.expectRevert(ImmediateOrCancelNoFill.selector);
        guard.reduce(r);
        assertFalse(guard.used(guard.actionIdOf(r)), "id must stay unused after a revert");
        _assertSameView(_view(owner), before);
    }

    /// Without the owner's grant the venue refuses the guard (authorization error).
    function test_revokedGrant_isAuthorizationError() public {
        _grant(owner, address(guard), BTC, false);
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        vm.prank(owner);
        vm.expectRevert(OnlyApprovedContracts.selector);
        guard.reduce(r);
        assertFalse(guard.used(guard.actionIdOf(r)));
    }

    /// The owner's own resting bid sits where the guarded sell would cross it. With
    /// CANCEL_TAKER the venue reverts the order instead of trading against itself.
    function test_selfMatch_reverts() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        Level[] memory bids = _levels(BTC, true, 1);
        uint256 ownBid = bids[0].price + p.tickSize;
        vm.prank(owner);
        IPool(BTC).placeOrder(true, 0, ownBid, p.minQuantity, uint64(block.timestamp + 600) * 1e9, 0, 0, address(0), 0);
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, bids[0].price);
        vm.prank(owner);
        vm.expectRevert(SelfMatchCancelTaker.selector);
        guard.reduce(r);
        assertFalse(guard.used(guard.actionIdOf(r)));
    }

    // ------------------------------------------------------------ preconditions

    function test_wrongCaller() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        address stranger = makeAddr("stranger");
        vm.expectCall(BTC, abi.encodeWithSelector(PLACE_ORDER_FOR), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.NotOwner.selector, stranger));
        guard.reduce(r);
    }

    /// SOL is a registered pool, but not one this guard was deployed for.
    function test_untrustedPool() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        r.pool = SOL;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.UntrustedPool.selector, SOL));
        guard.reduce(r);
        r.pool = address(0xBEEF);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.UntrustedPool.selector, address(0xBEEF)));
        guard.reduce(r);
    }

    function test_expiredDeadline() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        r.deadline = uint64(block.timestamp - 1);
        vm.expectCall(BTC, abi.encodeWithSelector(PLACE_ORDER_FOR), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.DeadlineExpired.selector, r.deadline, block.timestamp));
        guard.reduce(r);
    }

    function test_deadlineBeyondNanosecondRange() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        r.deadline = guard.MAX_DEADLINE() + 1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.InvalidDeadline.selector, r.deadline));
        guard.reduce(r);
    }

    /// The same confirmed action cannot run twice.
    function test_duplicateAction() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        vm.prank(owner);
        (bytes32 id,,) = guard.reduce(r);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.ActionAlreadyUsed.selector, id));
        guard.reduce(r);
        assertEq(_size(BTC), 4_000_000, "only one execution");
    }

    /// Two actions confirmed against the same position: the second must not run after
    /// the first changed it, even with a fresh nonce.
    function test_concurrentConfirmations_secondIsStale() public {
        uint256 limit = _levels(BTC, true, 4)[3].price;
        ReduceOnlyGuard.ReduceRequest memory a = _req(BTC, 1_000_000, limit);
        ReduceOnlyGuard.ReduceRequest memory b = _req(BTC, 1_000_000, limit);
        assertTrue(guard.actionIdOf(a) != guard.actionIdOf(b), "distinct ids");
        vm.prank(owner);
        guard.reduce(a);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.PositionMismatch.selector, int128(5_000_000), int128(4_000_000)));
        guard.reduce(b);
    }

    /// A partial close outside the guard after confirmation invalidates the action.
    function test_positionChangedAfterPriorPartialClose() public {
        uint256 limit = _levels(BTC, true, 4)[3].price;
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 2_000_000, limit);
        vm.prank(owner);
        _ioc(BTC, false, 1_000_000, limit);
        vm.expectCall(BTC, abi.encodeWithSelector(PLACE_ORDER_FOR), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.PositionMismatch.selector, int128(5_000_000), int128(4_000_000)));
        guard.reduce(r);
    }

    function test_positionNowFlat() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 2_000_000, _levels(BTC, true, 4)[3].price);
        uint256 deep = _levels(BTC, true, 12)[11].price;
        vm.prank(owner);
        _ioc(BTC, false, 5_000_000, deep);
        assertEq(_size(BTC), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.PositionMismatch.selector, int128(5_000_000), int128(0)));
        guard.reduce(r);
    }

    function test_positionNowReversed() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 2_000_000, _levels(BTC, true, 4)[3].price);
        uint256 deep = _levels(BTC, true, 12)[11].price;
        vm.prank(owner);
        _ioc(BTC, false, 6_000_000, deep);
        assertEq(_size(BTC), -1_000_000, "flipped short outside the guard");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.PositionMismatch.selector, int128(5_000_000), int128(-1_000_000)));
        guard.reduce(r);
    }

    function test_expectedZeroPosition() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        r.expectedSignedSize = 0;
        vm.prank(owner);
        vm.expectRevert(ReduceOnlyGuard.NoPosition.selector);
        guard.reduce(r);
    }

    /// A buy on a long would grow it.
    function test_sameSideIsRejected() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, false, 4)[3].price);
        r.isBid = true;
        vm.prank(owner);
        vm.expectRevert(ReduceOnlyGuard.NotReducingSide.selector);
        guard.reduce(r);
    }

    function test_malformedQuantities() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        uint256 limit = _levels(BTC, true, 4)[3].price;
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 0, limit);
        vm.prank(owner);
        vm.expectRevert(ReduceOnlyGuard.ZeroQuantity.selector);
        guard.reduce(r);

        r = _req(BTC, 5_000_000 + p.lotSize, limit);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.QuantityExceedsPosition.selector, 5_000_000 + p.lotSize, 5_000_000));
        guard.reduce(r);

        r = _req(BTC, 1_000_000 + 1, limit);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.QuantityNotLotAligned.selector, 1_000_001, p.lotSize));
        guard.reduce(r);

        r = _req(BTC, p.minQuantity - p.lotSize, limit);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.QuantityBelowMinimum.selector, p.minQuantity - p.lotSize, p.minQuantity));
        guard.reduce(r);
    }

    function test_malformedLimitPrice() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.InvalidLimitPrice.selector, r.limitPrice, p.tickSize));
        guard.reduce(r);
        r = _req(BTC, 1_000_000, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.InvalidLimitPrice.selector, 0, p.tickSize));
        guard.reduce(r);
    }

    // ------------------------------------------------------------ custody

    function test_guardCannotReceiveNative() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(guard).call{value: 1}("");
        assertFalse(ok, "guard must not accept native");
    }

    /// The guard reduces only for its own owner: another account's grant does not let
    /// anyone reach that account through it.
    function test_otherAccountsUnreachable() public {
        address other = makeAddr("other-account");
        _grant(other, address(guard), BTC, true);
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 1_000_000, _levels(BTC, true, 4)[3].price);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.NotOwner.selector, other));
        guard.reduce(r);
    }
}
