// Minimal read/write ABIs for the Margin Rescue path. The SDK's read ABIs are not
// exported from its package entry, so the entries used here are copied from
// @somnia-chain/markets-sdk 0.32.1 (src/readsAbi.ts, src/tradeAbi.ts) and the
// dreamdex-bot-kit operator helper. test/unit/mr-abi.test.ts checks every
// signature against the SDK's own files so a drift fails a test, not a read.
import { parseAbi } from "viem"

export { contractErrorsAbi, marginBankEventsAbi, orderBookEventsAbi, perpPoolEventsAbi } from "@somnia-chain/markets-sdk"

export const marginBankAbi = parseAbi([
  "function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))",
  "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountState(address account) view returns ((int256 unlockedCollateralBalance, uint256 lockedCollateral, address[] activePerpPools))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
  "function getMarginStatus(address account) view returns (uint8)",
  "function tryGetAccountEquity(address account) view returns (bool ok, int256 equity)",
  "function getCollateralBasis(address account) view returns (uint256)",
  "function isPerpPoolRegistered(address perpPool) view returns (bool)",
  "function isolated(address account) view returns (bool)",
  "function getCreditFloor(address account) view returns (uint256)",
  "function quoteFundingPayer(address child) view returns (address payer)",
  "function getMainFundedPrincipal(address child) view returns (uint256)",
  "function getSideHolderStatesPaginated(address pool, bool isLong, uint256 start, uint256 count) view returns ((address account, bool priceable, uint8 status, int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq, (int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs) position, int256 unlockedCollateralBalance, uint256 lockedCollateral)[] states, uint256 listLength, bool poolPriceable, (uint256 oneBase, uint256 markPrice, int256 projectedCumulativeFunding, uint256 effectiveIMFBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps, uint256 staticIMFBps) poolSnapshot)",
])

export const perpPoolAbi = parseAbi([
  "function marginBank() view returns (address)",
  "function tryGetHealthSnapshot() view returns (bool ok, (uint256 oneBase, uint256 markPrice, int256 projectedCumulativeFunding, uint256 effectiveIMFBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps) snapshot)",
  "function getPerpPoolParameters() view returns ((uint256 initialMarginBps, uint256 maintenanceMarginBps, uint256 closeOutMarginBps, uint256 maxOpenInterest, uint256 maxPositionSize, uint256 takerFeeBpsTimes1k, int256 makerFeeBpsTimes1k, uint256 insuranceFundShareBps))",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function getReducingCapacity(address account) view returns ((int128 positionSize, uint256 pendingBidQuantity, uint256 pendingAskQuantity, uint256 pendingOppositeQuantity, uint256 effectiveReducingCapacity) capacity)",
  "function isRestricted() view returns (bool)",
  "function getMarketStatus() view returns (uint8)",
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function getOwnOpenOrders() view returns (uint128[])",
  "function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))",
  "function getOperatorPermissionsRegistry() view returns (address)",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
  "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)",
  "function cancelOrder(uint128 orderId)",
])

export const perpPoolFactoryAbi = parseAbi([
  "function getPerpPools() view returns (address[])",
  "function getBaseTokenForPool(address perpPool) view returns (address)",
  "function isDeployedByFactory(address perpPool) view returns (bool)",
  "function getStopOrderRegistry(address perpPool) view returns (address stopOrderRegistry)",
])

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
])

export const operatorRegistryAbi = parseAbi([
  "function setOperatorApprovalForPool(address pool, address operator, bytes4[] selectors, bool approved)",
  "function isApprovedForPool(address pool, address owner, address operator, bytes4 selector) view returns (bool)",
  "function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)",
])

export const perpStopRegistryAbi = parseAbi([
  "function getPendingOrder(uint128 orderId) view returns (bool live, (((bool isBid, address owner, uint64 userData, uint256 quantity) order, uint8 orderType, uint256 triggerPrice, uint8 triggerOperator, uint256 limitPrice, address builder, uint96 builderFeeBpsTimes1k) orderWithTrigger, uint128 orderId, uint256 somiPaid, uint128 siblingOrderId, uint8 intent) order)",
  "function unclaimedSomi(address user) view returns (uint256)",
])

export const marginBankWriteAbi = parseAbi(["function deposit(uint256 amount)", "function withdraw(uint256 amount)"])

// IOrderBook.placeOrderFor, as the OperatorPermissionsRegistry keys it.
export const PLACE_ORDER_FOR_SELECTOR = "0x80054449" as const

// OrderBook enums (SDK ORDER_TYPE / SELF_MATCHING_OPTION).
export const ORDER_TYPE_IOC = 2
export const SELF_MATCH_CANCEL_TAKER = 0

// ReduceOnlyGuard (contracts/src/ReduceOnlyGuard.sol). Kept in sync by
// test/unit/mr-action.test.ts, which checks the action id against the contract's
// typehash string.
export const reduceGuardAbi = parseAbi([
  "struct ReduceRequest { address pool; int128 expectedSignedSize; bool isBid; uint256 quantity; uint256 limitPrice; uint64 deadline; bytes32 nonce; }",
  "function reduce(ReduceRequest request) returns (bytes32 actionId, uint128 orderId, int128 sizeAfter)",
  "function actionIdOf(ReduceRequest request) view returns (bytes32)",
  "function used(bytes32 actionId) view returns (bool)",
  "function OWNER() view returns (address)",
  "function MARGIN_BANK() view returns (address)",
  "function trustedPool(address pool) view returns (bool)",
  "event ReduceExecuted(bytes32 indexed actionId, address indexed pool, uint128 orderId, int128 sizeBefore, int128 sizeAfter, uint256 quantity, uint256 limitPrice)",
  "error NotOwner(address caller)",
  "error WrongChain(uint256 chainId)",
  "error UntrustedPool(address pool)",
  "error PoolBankMismatch(address pool, address bank)",
  "error DeadlineExpired(uint64 deadline, uint256 timestamp)",
  "error InvalidDeadline(uint64 deadline)",
  "error ActionAlreadyUsed(bytes32 actionId)",
  "error NoPosition()",
  "error PositionMismatch(int128 expected, int128 actual)",
  "error NotReducingSide()",
  "error ZeroQuantity()",
  "error QuantityExceedsPosition(uint256 quantity, uint256 positionSize)",
  "error QuantityNotLotAligned(uint256 quantity, uint256 lotSize)",
  "error QuantityBelowMinimum(uint256 quantity, uint256 minQuantity)",
  "error InvalidLimitPrice(uint256 limitPrice, uint256 tickSize)",
  "error VenueRejected(uint128 orderId)",
  "error Reentrancy()",
  "error ZeroAddress()",
  "error PositionFlippedOrIncreased(int128 sizeBefore, int128 sizeAfter)",
  "error ReductionExceedsRequest(uint256 reduced, uint256 quantity)",
])
