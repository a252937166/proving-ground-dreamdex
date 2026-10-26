// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {BookParams} from "../../src/interfaces/IDreamDex.sol";
import {
    GuardForkBase,
    Level,
    AccountState,
    ReducingCapacity,
    IBank,
    IPool,
    IToken,
    ImmediateOrCancelNoFill,
    OnlyApprovedContracts,
    SelfMatchCancelTaker,
    OrderAlreadyExpired
} from "./GuardForkBase.sol";

interface IPoolFor {
    function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)
        external
        payable
        returns (bool, uint128);
}

/// A bare operator contract, to show what the venue itself allows an operator to do.
contract BareOperator {
    function place(address pool, address owner, bool isBid, uint256 price, uint256 qty) external returns (bool ok, uint128 id) {
        (ok, id) = IPoolFor(pool).placeOrderFor(owner, isBid, 0, price, qty, uint64(block.timestamp + 600) * 1e9, 2, 0, address(0), 0);
    }
}

/// The raw venue behaviours the guard and the planner rely on, observed on the real
/// deployment (no guard involved).
contract VenueSemanticsForkTest is GuardForkBase {
    function _exp() internal view returns (uint64) {
        return uint64(block.timestamp + 600) * 1e9;
    }

    /// A contract operator needs the owner's grant, per pool; once granted it trades the
    /// owner's account and pulls nothing from the owner's wallet, even for an order that
    /// opens size (the guard never sends one; this shows the route itself cannot pull).
    function test_operatorRoute_perPoolGrant_noWalletPull() public {
        BareOperator op = new BareOperator();
        uint256 ask = _levels(BTC, false, 6)[5].price;
        vm.expectRevert(OnlyApprovedContracts.selector);
        op.place(BTC, owner, true, ask, 13_000);

        _grant(owner, address(op), BTC, true);
        uint256 wallet = IToken(USDSO).balanceOf(owner);
        uint256 allowance = IToken(USDSO).allowance(owner, BANK);
        int128 before = _size(BTC);
        op.place(BTC, owner, true, ask, 13_000);
        assertEq(_size(BTC), before + 13_000, "the order is the owner's");
        assertEq(IToken(USDSO).balanceOf(owner), wallet, "no wallet pull through an operator");
        assertEq(IToken(USDSO).allowance(owner, BANK), allowance, "allowance untouched");

        uint256 ethAsk = _levels(ETH, false, 6)[5].price;
        vm.expectRevert(OnlyApprovedContracts.selector);
        op.place(ETH, owner, true, ethAsk, 4e15);
    }

    function test_ioc_zeroFill_reverts() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        uint256 aboveBid = _levels(BTC, true, 1)[0].price + 100 * p.tickSize;
        vm.prank(owner);
        vm.expectRevert(ImmediateOrCancelNoFill.selector);
        IPool(BTC).placeOrder(false, 0, aboveBid, 13_000, _exp(), 2, 0, address(0), 0);
    }

    /// Expiry is compared in nanoseconds against the block time: equal is accepted,
    /// earlier (or zero) is rejected.
    function test_expiryBoundary() public {
        uint256 bid = _levels(BTC, true, 4)[3].price;
        uint64 nowNs = uint64(block.timestamp) * 1e9;
        vm.prank(owner);
        IPool(BTC).placeOrder(false, 0, bid, 13_000, nowNs, 2, 0, address(0), 0);
        vm.prank(owner);
        vm.expectRevert(OrderAlreadyExpired.selector);
        IPool(BTC).placeOrder(false, 0, bid, 13_000, nowNs - 1, 2, 0, address(0), 0);
        vm.prank(owner);
        vm.expectRevert(OrderAlreadyExpired.selector);
        IPool(BTC).placeOrder(false, 0, bid, 13_000, 0, 2, 0, address(0), 0);
    }

    function test_selfMatch_cancelTaker_reverts() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        Level[] memory bids = _levels(BTC, true, 1);
        vm.prank(owner);
        IPool(BTC).placeOrder(true, 0, bids[0].price + p.tickSize, 13_000, _exp(), 0, 0, address(0), 0);
        vm.prank(owner);
        vm.expectRevert(SelfMatchCancelTaker.selector);
        IPool(BTC).placeOrder(false, 0, bids[0].price, 1_000_000, _exp(), 2, 0, address(0), 0);
    }

    /// A resting reduce-side order is not tied to the position: after an IOC closes the
    /// position, the resting ask stays on the book with nothing locked behind it and would
    /// OPEN a short if it filled. This is why the planner lists resting orders as
    /// exposure the static model does not cover.
    function test_restingReduceOrder_outlivesPosition() public {
        BookParams memory p = IPool(BTC).getOrderBookParameters();
        uint256 far = (_levels(BTC, false, 1)[0].price * 101 / 100 / p.tickSize) * p.tickSize;
        vm.prank(owner);
        IPool(BTC).placeOrder(false, 0, far, 3_000_000, _exp(), 0, 0, address(0), 0);
        ReducingCapacity memory c = IPool(BTC).getReducingCapacity(owner);
        assertEq(c.pendingAskQuantity, 3_000_000);
        assertEq(c.effectiveReducingCapacity, 2_000_000, "the resting ask claims part of the long");
        uint256 deep = _levels(BTC, true, 12)[11].price;
        vm.prank(owner);
        IPool(BTC).placeOrder(false, 0, deep, 5_000_000, _exp(), 2, 0, address(0), 0);
        assertEq(_size(BTC), 0, "the IOC closed the long");
        c = IPool(BTC).getReducingCapacity(owner);
        AccountState memory s = IBank(BANK).getAccountState(owner);
        console.log("pending ask after close", c.pendingAskQuantity, "locked", s.locked);
        assertEq(c.pendingAskQuantity, 3_000_000, "the resting ask is still there");
        assertEq(c.effectiveReducingCapacity, 0, "and now reduces nothing");
    }

    /// The order type is a closed enum of four (limit, FOK, IOC, post-only); there is no
    /// fifth value, such as an immediate reduce-only type, on the deployed pool.
    function test_noFifthOrderType() public {
        uint256 bid = _levels(BTC, true, 4)[3].price;
        for (uint8 t = 4; t < 8; ++t) {
            vm.prank(owner);
            (bool ok,) = BTC.call(abi.encodeWithSelector(IPool.placeOrder.selector, false, uint64(0), bid, uint256(13_000), _exp(), t, uint8(0), address(0), uint96(0)));
            assertFalse(ok, "an order type above 3 must be rejected");
        }
        assertEq(_size(BTC), 5_000_000, "nothing traded");
    }
}
