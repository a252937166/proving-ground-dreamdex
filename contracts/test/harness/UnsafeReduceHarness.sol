// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMarginBank, IPerpPool} from "../../src/interfaces/IDreamDex.sol";
import {ReduceGuardChecks} from "../../src/ReduceGuardChecks.sol";

/// @notice TEST ONLY. Deliberately unsafe; never deploy.
///
/// It drops every precondition of ReduceOnlyGuard (owner, expected position, side,
/// quantity bound) so a real venue order can flip or grow the position, then runs the
/// production postcondition, ReduceGuardChecks.checkPostcondition, exactly as the guard
/// does. The fork tests use it to show that the postcondition fires after a real venue
/// fill and that the revert takes the fill, the margin changes and this contract's own
/// write back with it.
contract UnsafeReduceHarness {
    address public immutable OWNER;
    address public immutable MARGIN_BANK;
    mapping(bytes32 => bool) public used;

    constructor(address owner_, address marginBank_) {
        OWNER = owner_;
        MARGIN_BANK = marginBank_;
    }

    /// Place the order, then apply the production postcondition with `claimedQuantity`.
    function placeThenCheck(address pool, bool isBid, uint256 quantity, uint256 limitPrice, uint256 claimedQuantity, bytes32 id)
        external
        returns (int128 sizeBefore, int128 sizeAfter)
    {
        sizeBefore = IMarginBank(MARGIN_BANK).getPosition(OWNER, pool).size;
        used[id] = true;
        _place(pool, isBid, quantity, limitPrice);
        sizeAfter = IMarginBank(MARGIN_BANK).getPosition(OWNER, pool).size;
        ReduceGuardChecks.checkPostcondition(sizeBefore, sizeAfter, claimedQuantity);
    }

    /// The same venue call with no check, to show in a snapshot what the venue does.
    function placeOnly(address pool, bool isBid, uint256 quantity, uint256 limitPrice) external returns (int128 sizeAfter) {
        _place(pool, isBid, quantity, limitPrice);
        sizeAfter = IMarginBank(MARGIN_BANK).getPosition(OWNER, pool).size;
    }

    function _place(address pool, bool isBid, uint256 quantity, uint256 limitPrice) private {
        IPerpPool(pool).placeOrderFor(OWNER, isBid, 0, limitPrice, quantity, uint64(block.timestamp + 60) * 1e9, 2, 0, address(0), 0);
    }
}
