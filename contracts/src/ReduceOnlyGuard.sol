// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMarginBank, IPerpPool, BookParams} from "./interfaces/IDreamDex.sol";
import {ReduceGuardChecks} from "./ReduceGuardChecks.sol";

/// @title ReduceOnlyGuard
/// @notice Immediate, reduce-only IOC execution for ONE dreamDEX perps account.
///
/// The deployed venue has no reduce-only flag on immediate orders (PlacePerpOrderParams
/// carries none, and the official close helper sends a plain opposite-side IOC). This
/// guard is the account's own operator: the owner grants it `placeOrderFor` on chosen
/// pools in the OperatorPermissionsRegistry, and only the owner can call it. The
/// orders it places are the owner's, margined from the owner's MarginBank balance.
///
/// What it enforces, in the same transaction as the order:
///  - the caller is the owner, the chain is 50383, the pool is one fixed at deployment
///    and still names this guard's MarginBank;
///  - the confirmed action has not run before (its id commits to every field below),
///    and its seconds-based deadline has not passed;
///  - the live signed position equals the position the owner confirmed, exactly;
///  - the order is on the opposite side, its quantity is positive, lot-aligned, at least
///    the venue minimum and no larger than the position, and its limit is on the tick;
///  - after the venue call, the position has not flipped or grown and has shrunk by at
///    most the confirmed quantity. Otherwise the whole transaction reverts, venue
///    fills and margin changes included.
///
/// What it does not do: hold tokens, approve, deposit, withdraw, cancel, make arbitrary
/// calls, or look at other markets. Per-fill price protection comes from the venue's IOC
/// limit, which the fork tests check on both sides. Fills, fees, funding and other
/// markets are reconciled off chain from the receipt.
contract ReduceOnlyGuard {
    uint256 public constant CHAIN_ID = 50383;
    uint8 public constant ORDER_TYPE_IOC = 2;
    uint8 public constant SELF_MATCH_CANCEL_TAKER = 0;
    /// Latest deadline whose nanosecond value still fits the venue's uint64 expiry.
    uint64 public constant MAX_DEADLINE = type(uint64).max / 1e9;
    bytes32 public constant REDUCE_TYPEHASH = keccak256(
        "ReduceAction(uint256 chainId,address guard,address marginBank,address owner,address pool,int128 expectedSignedSize,bool isBid,uint256 quantity,uint256 limitPrice,uint64 deadline,uint8 orderType,bytes32 nonce)"
    );

    address public immutable OWNER;
    address public immutable MARGIN_BANK;

    mapping(address pool => bool) public trustedPool;
    mapping(bytes32 actionId => bool) public used;
    uint256 private _lock = 1;

    /// @param pool        perp pool to reduce in; must be trusted
    /// @param expectedSignedSize  the signed position the owner confirmed; must match exactly
    /// @param isBid       order side; true buys back a short, false sells down a long
    /// @param quantity    raw base units to reduce by at most
    /// @param limitPrice  IOC limit; the venue fills nothing worse than this
    /// @param deadline    unix seconds; the action is void after it
    /// @param nonce       makes the action id unique
    struct ReduceRequest {
        address pool;
        int128 expectedSignedSize;
        bool isBid;
        uint256 quantity;
        uint256 limitPrice;
        uint64 deadline;
        bytes32 nonce;
    }

    event ReduceExecuted(
        bytes32 indexed actionId, address indexed pool, uint128 orderId, int128 sizeBefore, int128 sizeAfter, uint256 quantity, uint256 limitPrice
    );

    error NotOwner(address caller);
    error WrongChain(uint256 chainId);
    error UntrustedPool(address pool);
    error PoolBankMismatch(address pool, address bank);
    error DeadlineExpired(uint64 deadline, uint256 timestamp);
    error InvalidDeadline(uint64 deadline);
    error ActionAlreadyUsed(bytes32 actionId);
    error NoPosition();
    error PositionMismatch(int128 expected, int128 actual);
    error NotReducingSide();
    error ZeroQuantity();
    error QuantityExceedsPosition(uint256 quantity, uint256 positionSize);
    error QuantityNotLotAligned(uint256 quantity, uint256 lotSize);
    error QuantityBelowMinimum(uint256 quantity, uint256 minQuantity);
    error InvalidLimitPrice(uint256 limitPrice, uint256 tickSize);
    error VenueRejected(uint128 orderId);
    error Reentrancy();
    error ZeroAddress();

    constructor(address owner_, address marginBank_, address[] memory pools_) {
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        if (owner_ == address(0) || marginBank_ == address(0)) revert ZeroAddress();
        OWNER = owner_;
        MARGIN_BANK = marginBank_;
        for (uint256 i; i < pools_.length; ++i) {
            address pool = pools_[i];
            address bank = IPerpPool(pool).marginBank();
            if (bank != marginBank_) revert PoolBankMismatch(pool, bank);
            if (!IMarginBank(marginBank_).isPerpPoolRegistered(pool)) revert UntrustedPool(pool);
            trustedPool[pool] = true;
        }
    }

    /// @notice The id the guard records for `r`. It commits to the chain, this guard,
    /// the MarginBank, the owner, every request field and the IOC order type.
    function actionIdOf(ReduceRequest calldata r) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                REDUCE_TYPEHASH,
                block.chainid,
                address(this),
                MARGIN_BANK,
                OWNER,
                r.pool,
                r.expectedSignedSize,
                r.isBid,
                r.quantity,
                r.limitPrice,
                r.deadline,
                ORDER_TYPE_IOC,
                r.nonce
            )
        );
    }

    /// @notice Reduce the owner's position in `r.pool` with one IOC, or revert.
    /// @dev A zero-fill IOC reverts in the venue (ImmediateOrCancelNoFill), which rolls
    /// the id reservation back with everything else. A partial fill succeeds.
    function reduce(ReduceRequest calldata r) external returns (bytes32 actionId, uint128 orderId, int128 sizeAfter) {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;

        int128 sizeBefore;
        (actionId, sizeBefore) = _checkRequest(r);

        // Reserved before the venue call; a revert anywhere below undoes it.
        used[actionId] = true;

        // The venue rejects an expiry before now (in ns); an IOC never rests, so the
        // deadline in ns is only an upper bound the venue never reaches.
        bool ok;
        (ok, orderId) = IPerpPool(r.pool).placeOrderFor(
            OWNER, r.isBid, uint64(uint256(actionId)), r.limitPrice, r.quantity, r.deadline * 1e9, ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, address(0), 0
        );
        if (!ok) revert VenueRejected(orderId);

        sizeAfter = IMarginBank(MARGIN_BANK).getPosition(OWNER, r.pool).size;
        ReduceGuardChecks.checkPostcondition(sizeBefore, sizeAfter, r.quantity);

        emit ReduceExecuted(actionId, r.pool, orderId, sizeBefore, sizeAfter, r.quantity, r.limitPrice);
        _lock = 1;
    }

    /// Every check that must pass before the venue is called. Returns the action id and
    /// the live signed position, which equals `r.expectedSignedSize`.
    function _checkRequest(ReduceRequest calldata r) private view returns (bytes32 actionId, int128 sizeBefore) {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        if (!trustedPool[r.pool]) revert UntrustedPool(r.pool);
        address bank = IPerpPool(r.pool).marginBank();
        if (bank != MARGIN_BANK) revert PoolBankMismatch(r.pool, bank);
        if (block.timestamp > r.deadline) revert DeadlineExpired(r.deadline, block.timestamp);
        if (r.deadline > MAX_DEADLINE) revert InvalidDeadline(r.deadline);

        actionId = actionIdOf(r);
        if (used[actionId]) revert ActionAlreadyUsed(actionId);

        if (r.expectedSignedSize == 0) revert NoPosition();
        sizeBefore = IMarginBank(MARGIN_BANK).getPosition(OWNER, r.pool).size;
        if (sizeBefore != r.expectedSignedSize) revert PositionMismatch(r.expectedSignedSize, sizeBefore);
        if (r.isBid != (sizeBefore < 0)) revert NotReducingSide();
        uint256 absBefore = ReduceGuardChecks.abs(sizeBefore);
        if (r.quantity == 0) revert ZeroQuantity();
        if (r.quantity > absBefore) revert QuantityExceedsPosition(r.quantity, absBefore);

        BookParams memory grid = IPerpPool(r.pool).getOrderBookParameters();
        if (grid.lotSize == 0 || r.quantity % grid.lotSize != 0) revert QuantityNotLotAligned(r.quantity, grid.lotSize);
        if (r.quantity < grid.minQuantity) revert QuantityBelowMinimum(r.quantity, grid.minQuantity);
        if (r.limitPrice == 0 || grid.tickSize == 0 || r.limitPrice % grid.tickSize != 0) {
            revert InvalidLimitPrice(r.limitPrice, grid.tickSize);
        }
    }
}
