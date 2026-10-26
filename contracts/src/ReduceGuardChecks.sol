// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The position after a guarded reduction either flipped sign or grew in size.
error PositionFlippedOrIncreased(int128 sizeBefore, int128 sizeAfter);
/// The position shrank by more than the confirmed quantity.
error ReductionExceedsRequest(uint256 reduced, uint256 quantity);

/// @notice The guard's postcondition, kept in a library so the production guard and
/// the test-only fault harness run the same bytecode for it.
library ReduceGuardChecks {
    /// @dev Accepts only a result on the same side or flat, no larger in absolute
    /// size than before, and shrunk by at most `quantity`. A flat `sizeBefore` admits
    /// only a flat result.
    function checkPostcondition(int128 sizeBefore, int128 sizeAfter, uint256 quantity) internal pure {
        bool sameSideOrFlat = sizeBefore > 0 ? (sizeAfter >= 0 && sizeAfter <= sizeBefore) : (sizeAfter <= 0 && sizeAfter >= sizeBefore);
        if (!sameSideOrFlat) revert PositionFlippedOrIncreased(sizeBefore, sizeAfter);
        uint256 reduced = abs(sizeBefore) - abs(sizeAfter);
        if (reduced > quantity) revert ReductionExceedsRequest(reduced, quantity);
    }

    function abs(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-int256(x)) : uint256(int256(x));
    }
}
