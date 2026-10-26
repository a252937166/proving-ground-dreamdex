// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console} from "forge-std/Test.sol";
import {ReduceOnlyGuard} from "../../src/ReduceOnlyGuard.sol";
import {Position, BookParams} from "../../src/interfaces/IDreamDex.sol";

struct Level {
    uint256 price;
    uint256 quantity;
}

struct AccountState {
    int256 unlocked;
    uint256 locked;
    address[] activePerpPools;
}

struct HealthSnapshot {
    uint256 oneBase;
    uint256 markPrice;
    int256 projectedCumulativeFunding;
    uint256 effectiveIMFBps;
    uint256 maintenanceMarginBps;
    uint256 closeOutMarginBps;
}

struct ReducingCapacity {
    int128 positionSize;
    uint256 pendingBidQuantity;
    uint256 pendingAskQuantity;
    uint256 pendingOppositeQuantity;
    uint256 effectiveReducingCapacity;
}

interface IBank {
    function getPosition(address account, address pool) external view returns (Position memory);
    function getAccountState(address account) external view returns (AccountState memory);
    function getAccountHealth(address account) external view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq);
    function deposit(uint256 amount) external;
}

interface IPool {
    function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) external;
    function getBookLevels(bool isBid, uint64 numLevels) external view returns (Level[] memory);
    function getOrderBookParameters() external view returns (BookParams memory);
    function tryGetHealthSnapshot() external view returns (bool ok, HealthSnapshot memory snapshot);
    function getReducingCapacity(address account) external view returns (ReducingCapacity memory);
    function cancelOrder(uint128 orderId) external;
    function getOwnOpenOrders() external view returns (uint128[] memory);
    function getOpenInterest() external view returns (uint256);
    function oracle() external view returns (address);
}

interface IRegistry {
    function setOperatorApprovalForPool(address pool, address operator, bytes4[] calldata selectors, bool approved) external;
}

interface IToken {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

// Venue errors, declared for their selectors (somnia-dex OrderBook / PerpPool).
error ImmediateOrCancelNoFill();
error OnlyApprovedContracts();
error SelfMatchCancelTaker();
error OrderAlreadyExpired();

/// Shared setup for the guard's fork tests: a fork of the REAL Hideki deployment at a
/// pinned block, with the block clock left at the fork block's own timestamp (the
/// venue rejects marks older than 5 s, so no test warps time). The owner is a fresh
/// account funded with forked USDso that opens a BTC long and an ETH short against
/// the real order books, so the tests run against real makers, real margin and the
/// real matching engine.
abstract contract GuardForkBase is Test {
    address internal constant BANK = 0x478769E1177C0773c43A593DCCc4Ad15F15F1394;
    address internal constant BTC = 0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0;
    address internal constant ETH = 0xD6Cb1DD58580B84D76068aC21594219ce03aeddf;
    address internal constant SOL = 0xB483ec1fb34996638677c20ab087b16F1896FA53;
    address internal constant USDSO = 0xed7993A74dAe1e6656B704A424DcD8711aAf4F72;
    address internal constant REGISTRY = 0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a;
    address internal constant LIQUIDATION_ENGINE = 0xA66d3C24Ad4a389d863846905D8173e1017e9F4D;
    bytes4 internal constant PLACE_ORDER_FOR = 0x80054449;
    uint256 internal constant DEFAULT_FORK_BLOCK = 33472615;

    bytes32 internal constant ORDER_FILLED = keccak256("OrderFilled(uint128,uint128,uint256,uint256,uint256,uint256)");
    bytes32 internal constant ORDER_RESTED = keccak256("OrderRested(uint128)");
    bytes32 internal constant POSITION_UPDATED = keccak256("PositionUpdated(address,address,int128,uint128,int256,int256)");
    bytes32 internal constant FUNDING_SETTLED = keccak256("FundingSettled(address,address,int256)");
    bytes32 internal constant FEE_CHARGED = keccak256("FeeCharged(address,address,uint256,uint256)");
    bytes32 internal constant DEPOSITED = keccak256("Deposited(address,uint256)");
    bytes32 internal constant DEPOSITED_FOR = keccak256("DepositedFor(address,address,uint256)");
    bytes32 internal constant WITHDRAWN = keccak256("Withdrawn(address,uint256)");
    bytes32 internal constant REDUCE_EXECUTED = keccak256("ReduceExecuted(bytes32,address,uint128,int128,int128,uint256,uint256)");

    address internal owner;
    ReduceOnlyGuard internal guard;
    uint256 internal forkTimestamp;
    uint256 private _nonce;

    function setUp() public virtual {
        _fork();
        _openOwnerAccount();
    }

    function _fork() internal {
        vm.createSelectFork(vm.envOr("HIDEKI_FORK_RPC", string("http://127.0.0.1:8546")), vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK));
        forkTimestamp = block.timestamp;
        assertEq(block.chainid, 50383, "not a Hideki fork");
        _assertFreshMark(BTC);
        _assertFreshMark(ETH);
    }

    function _openOwnerAccount() internal {
        owner = makeAddr("margin-rescue-owner");
        deal(USDSO, owner, 50_000e18);
        vm.startPrank(owner);
        IToken(USDSO).approve(BANK, type(uint256).max);
        IBank(BANK).deposit(20_000e18);
        // 0.05 BTC long and 2 ETH short, taken from the real book.
        _ioc(BTC, true, 5_000_000, _levels(BTC, false, 20)[19].price);
        _ioc(ETH, false, 2e18, _levels(ETH, true, 20)[19].price);
        vm.stopPrank();
        assertEq(_size(BTC), 5_000_000, "BTC long not opened");
        assertEq(_size(ETH), -2e18, "ETH short not opened");

        guard = _deployGuard(owner);
        _grant(owner, address(guard), BTC, true);
        _grant(owner, address(guard), ETH, true);
    }

    // ---------------------------------------------------------------- helpers

    function _deployGuard(address account) internal returns (ReduceOnlyGuard g) {
        address[] memory pools = new address[](2);
        pools[0] = BTC;
        pools[1] = ETH;
        g = new ReduceOnlyGuard(account, BANK, pools);
    }

    function _grant(address account, address operator, address pool, bool approved) internal {
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = PLACE_ORDER_FOR;
        vm.prank(account);
        IRegistry(REGISTRY).setOperatorApprovalForPool(pool, operator, sel, approved);
    }

    function _assertFreshMark(address pool) internal view {
        (bool ok,) = IPool(pool).tryGetHealthSnapshot();
        assertTrue(ok, "mark is stale at the fork block; pick another FORK_BLOCK");
    }

    function _levels(address pool, bool bids, uint64 n) internal view returns (Level[] memory) {
        return IPool(pool).getBookLevels(bids, n);
    }

    function _ioc(address pool, bool isBid, uint256 quantity, uint256 limit) internal {
        IPool(pool).placeOrder(isBid, 0, limit, quantity, uint64(block.timestamp + 600) * 1e9, 2, 0, address(0), 0);
    }

    function _size(address pool) internal view returns (int128) {
        return IBank(BANK).getPosition(owner, pool).size;
    }

    function _sizeOf(address account, address pool) internal view returns (int128) {
        return IBank(BANK).getPosition(account, pool).size;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    /// A reducing request for the owner's current position in `pool`.
    function _req(address pool, uint256 quantity, uint256 limit) internal returns (ReduceOnlyGuard.ReduceRequest memory r) {
        int128 s = _size(pool);
        r = ReduceOnlyGuard.ReduceRequest({
            pool: pool,
            expectedSignedSize: s,
            isBid: s < 0,
            quantity: quantity,
            limitPrice: limit,
            deadline: uint64(block.timestamp + 120),
            nonce: keccak256(abi.encode("nonce", ++_nonce))
        });
    }

    struct Fills {
        uint256 count;
        uint256 quantity;
        uint256 minPrice;
        uint256 maxPrice;
    }

    /// Fills of taker order `orderId` on `pool` in `logs`.
    function _fills(Vm.Log[] memory logs, address pool, uint128 orderId) internal pure returns (Fills memory f) {
        f.minPrice = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != pool || l.topics[0] != ORDER_FILLED || uint256(l.topics[1]) != orderId) continue;
            (uint256 q,,, uint256 px) = abi.decode(l.data, (uint256, uint256, uint256, uint256));
            f.count++;
            f.quantity += q;
            if (px < f.minPrice) f.minPrice = px;
            if (px > f.maxPrice) f.maxPrice = px;
        }
    }

    /// Number of logs from the bank naming `account` with topic0 `sig`.
    function _bankLogs(Vm.Log[] memory logs, bytes32 sig, address account) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == BANK && logs[i].topics[0] == sig && address(uint160(uint256(logs[i].topics[1]))) == account) n++;
        }
    }

    function _restedCount(Vm.Log[] memory logs, address pool, uint128 orderId) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == pool && logs[i].topics[0] == ORDER_RESTED && uint256(logs[i].topics[1]) == orderId) n++;
        }
    }

    struct AccountView {
        int256 unlocked;
        uint256 locked;
        Position btc;
        Position eth;
        int256 equity;
        uint256 mmReq;
        uint256 wallet;
        uint256 allowance;
        uint256 openOrdersBtc;
        uint256 openOrdersEth;
    }

    function _view(address account) internal returns (AccountView memory v) {
        AccountState memory s = IBank(BANK).getAccountState(account);
        v.unlocked = s.unlocked;
        v.locked = s.locked;
        v.btc = IBank(BANK).getPosition(account, BTC);
        v.eth = IBank(BANK).getPosition(account, ETH);
        (v.equity,, v.mmReq,) = IBank(BANK).getAccountHealth(account);
        v.wallet = IToken(USDSO).balanceOf(account);
        v.allowance = IToken(USDSO).allowance(account, BANK);
        vm.prank(account);
        v.openOrdersBtc = IPool(BTC).getOwnOpenOrders().length;
        vm.prank(account);
        v.openOrdersEth = IPool(ETH).getOwnOpenOrders().length;
    }

    function _assertSamePosition(Position memory a, Position memory b, string memory what) internal pure {
        assertEq(a.size, b.size, string.concat(what, ": size"));
        assertEq(a.avgEntryPrice, b.avgEntryPrice, string.concat(what, ": entry"));
        assertEq(a.entryFundingIndex, b.entryFundingIndex, string.concat(what, ": funding index"));
    }

    function _assertSameView(AccountView memory a, AccountView memory b) internal pure {
        assertEq(a.unlocked, b.unlocked, "unlocked collateral");
        assertEq(a.locked, b.locked, "locked collateral");
        _assertSamePosition(a.btc, b.btc, "BTC");
        _assertSamePosition(a.eth, b.eth, "ETH");
        assertEq(a.equity, b.equity, "bank equity");
        assertEq(a.mmReq, b.mmReq, "maintenance requirement");
        assertEq(a.wallet, b.wallet, "wallet USDso");
        assertEq(a.allowance, b.allowance, "allowance to bank");
        assertEq(a.openOrdersBtc, b.openOrdersBtc, "open BTC orders");
        assertEq(a.openOrdersEth, b.openOrdersEth, "open ETH orders");
    }
}
