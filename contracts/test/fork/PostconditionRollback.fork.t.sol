// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReduceOnlyGuard} from "../../src/ReduceOnlyGuard.sol";
import {PositionFlippedOrIncreased, ReductionExceedsRequest} from "../../src/ReduceGuardChecks.sol";
import {UnsafeReduceHarness} from "../harness/UnsafeReduceHarness.sol";
import {GuardForkBase, Level, IPool, OnlyApprovedContracts} from "./GuardForkBase.sol";

/// The production postcondition (ReduceGuardChecks) firing AFTER a real venue fill,
/// through the test-only UnsafeReduceHarness, and the whole transaction rolling back.
///
/// Run with -vvvv to see the call trace: the venue's OrderFilled / PositionUpdated
/// events appear inside placeOrderFor, before the PositionFlippedOrIncreased revert.
contract PostconditionRollbackForkTest is GuardForkBase {
    UnsafeReduceHarness internal harness;

    function setUp() public override {
        super.setUp();
        harness = new UnsafeReduceHarness(owner, BANK);
        _grant(owner, address(harness), BTC, true);
    }

    struct Market {
        Level[] bids;
        Level[] asks;
        uint256 openInterest;
    }

    function _market(address pool) internal view returns (Market memory m) {
        m.bids = _levels(pool, true, 16);
        m.asks = _levels(pool, false, 16);
        m.openInterest = IPool(pool).getOpenInterest();
    }

    function _assertSameMarket(Market memory a, Market memory b) internal pure {
        assertEq(a.openInterest, b.openInterest, "open interest");
        assertEq(a.bids.length, b.bids.length, "bid levels");
        assertEq(a.asks.length, b.asks.length, "ask levels");
        for (uint256 i; i < a.bids.length; ++i) {
            assertEq(a.bids[i].price, b.bids[i].price, "bid price");
            assertEq(a.bids[i].quantity, b.bids[i].quantity, "bid depth");
        }
        for (uint256 i; i < a.asks.length; ++i) {
            assertEq(a.asks[i].price, b.asks[i].price, "ask price");
            assertEq(a.asks[i].quantity, b.asks[i].quantity, "ask depth");
        }
    }

    /// Sell 0.06 BTC against a 0.05 BTC long. The real venue fills it and flips the
    /// position to -0.01; the production postcondition then reverts with
    /// PositionFlippedOrIncreased(0.05, -0.01), and nothing the venue did survives.
    function test_realFlip_postconditionRevertsAfterFill_andAllStateRollsBack() public {
        uint256 limit = _levels(BTC, true, 12)[11].price;
        int128 sizeBefore = _size(BTC);
        assertEq(sizeBefore, 5_000_000);

        // The identical venue call without the check, inside a snapshot: it does flip.
        uint256 snap = vm.snapshotState();
        int128 flipped = harness.placeOnly(BTC, false, 6_000_000, limit);
        assertEq(flipped, -1_000_000, "the venue really flips the position");
        vm.revertToState(snap);

        AccountView memory accountBefore = _view(owner);
        Market memory marketBefore = _market(BTC);
        bytes32 id = keccak256("fault-injection");

        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, sizeBefore, int128(-1_000_000)));
        harness.placeThenCheck(BTC, false, 6_000_000, limit, 6_000_000, id);

        _assertSameView(_view(owner), accountBefore);
        _assertSameMarket(_market(BTC), marketBefore);
        assertFalse(harness.used(id), "the harness's own write rolled back");
    }

    /// A same-side order grows the position; the postcondition rejects that too.
    function test_realIncrease_postconditionReverts() public {
        uint256 limit = _levels(BTC, false, 12)[11].price;
        AccountView memory accountBefore = _view(owner);
        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, int128(5_000_000), int128(6_000_000)));
        harness.placeThenCheck(BTC, true, 1_000_000, limit, 1_000_000, keccak256("grow"));
        _assertSameView(_view(owner), accountBefore);
    }

    /// The venue reduces by 0.02 while the action claimed 0.01.
    function test_reductionBeyondClaim_postconditionReverts() public {
        uint256 limit = _levels(BTC, true, 12)[11].price;
        AccountView memory accountBefore = _view(owner);
        vm.expectRevert(abi.encodeWithSelector(ReductionExceedsRequest.selector, 2_000_000, 1_000_000));
        harness.placeThenCheck(BTC, false, 2_000_000, limit, 1_000_000, keccak256("over"));
        _assertSameView(_view(owner), accountBefore);
    }

    /// Negative controls: the errors that stop an unsafe request BEFORE the venue, or
    /// stop an unauthorized operator AT the venue, are different errors from the
    /// postcondition's, so a passing rollback test cannot be one of them in disguise.
    function test_negativeControls_areDistinctErrors() public {
        uint256 limit = _levels(BTC, true, 12)[11].price;

        // The production guard refuses the same oversize sell before calling the venue.
        ReduceOnlyGuard.ReduceRequest memory r = _req(BTC, 6_000_000, limit);
        vm.expectCall(BTC, abi.encodeWithSelector(PLACE_ORDER_FOR), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.QuantityExceedsPosition.selector, 6_000_000, 5_000_000));
        guard.reduce(r);

        // The harness has no grant on ETH: the venue refuses it outright.
        uint256 ethLimit = _levels(ETH, false, 12)[11].price;
        vm.expectRevert(OnlyApprovedContracts.selector);
        harness.placeThenCheck(ETH, true, 3e18, ethLimit, 3e18, keccak256("unauthorized"));

        bytes4 post = PositionFlippedOrIncreased.selector;
        assertTrue(post != ReduceOnlyGuard.QuantityExceedsPosition.selector);
        assertTrue(post != OnlyApprovedContracts.selector);
        assertTrue(post != ReduceOnlyGuard.PositionMismatch.selector);
        assertTrue(post != ReduceOnlyGuard.NotOwner.selector);
    }
}
