// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The slices of the deployed dreamDEX perps contracts (Somnia Hideki, chain 50383)
// that the guard touches. Signatures follow @somnia-chain/markets-sdk 0.32.1
// (src/readsAbi.ts) and the official dreamdex-bot-kit operator helper; the fork tests
// call them against the real deployment, so a wrong signature fails there.

struct Position {
    int128 size;
    uint128 avgEntryPrice;
    int256 entryFundingIndex;
    uint64 lastUpdatedTimestampNs;
}

struct BookParams {
    uint256 tickSize;
    uint256 minQuantity;
    uint256 lotSize;
}

interface IMarginBank {
    function getPosition(address account, address perpPool) external view returns (Position memory);
    function isPerpPoolRegistered(address perpPool) external view returns (bool);
}

interface IPerpPool {
    function marginBank() external view returns (address);
    function getOrderBookParameters() external view returns (BookParams memory);

    /// Places an order owned by `owner`. The pool admits the caller only through the
    /// owner's per-pool grant in the OperatorPermissionsRegistry (selector 0x80054449);
    /// otherwise it reverts OnlyApprovedContracts().
    function placeOrderFor(
        address owner,
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);
}
