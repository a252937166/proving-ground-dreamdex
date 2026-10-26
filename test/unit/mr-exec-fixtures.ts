// SYNTHETIC execution fixtures: a hedged account, its analysis under one fixed
// scenario, a journalled confirmation, and the receipt and post snapshot a guarded
// reduction would produce if the bank settled it the way the deployed bank does
// (realized PnL floored per fill, the whole position's funding settled once, entry
// kept). Every number here is invented; none is a market quote or live evidence.
import { keccak256, toBytes, type Address, type Hex } from "viem"
import { actionIdOf, reduceCalldata, requestFromCandidate } from "../../src/margin-rescue/action.js"
import { analyzeCandidates, type CandidateAnalysis } from "../../src/margin-rescue/candidates.js"
import type { ActionRecord } from "../../src/margin-rescue/journal.js"
import { fundingOwed, realizedPnl } from "../../src/margin-rescue/math.js"
import { reconcile } from "../../src/margin-rescue/reconcile.js"
import { summarize, type ActionReceipt, type DecodedLog } from "../../src/margin-rescue/receipt.js"
import { buildScenario, type Scenario } from "../../src/margin-rescue/scenario.js"
import type { AccountSnapshot } from "../../src/margin-rescue/snapshot.js"
import { parseDecimal } from "../../src/units.js"
import { ACCOUNT, BANK, POOL, atBlock, fixtureSnapshot, settleBank } from "./mr-fixtures.js"

export const U = 10n ** 18n
export const usd = (amount: string) => parseDecimal(amount, 18, { signed: true })
export const GUARD = "0x00000000000000000000000000000000000600a2" as Address
export const TX_HASH = keccak256(toBytes("fixture reduction")) as Hex
export const TAKER_ORDER = 777n
export const C0 = 10n ** 36n // both markets' cumulative funding index at the analysis

// BTC long 0.08 and ETH short 0.03 at a synthetic 100, MM 2.5%, 6 USDso unlocked, the
// BTC leg owing 0.01 USDso of funding. Under BTC −10% / ETH −10% doing nothing leaves a
// buffer of 5.2425; reducing BTC by 25% (sold at 100) leaves 5.4875.
export function hedgedAccount(opts: { btcBidQty?: bigint; unlocked?: bigint } = {}): AccountSnapshot {
  return fixtureSnapshot({
    unlocked: opts.unlocked ?? usd("6"),
    markets: [
      { symbol: "BTC", decimals: 8, mark: 100n * U, mmBps: 250n, tick: U / 10n, lot: 1_000n, minQuantity: 13_000n, cumulativeFunding: C0, bids: [{ price: 100n * U, quantity: opts.btcBidQty ?? 10n ** 9n }], asks: [{ price: 100n * U, quantity: 10n ** 9n }] },
      { symbol: "ETH", decimals: 18, mark: 100n * U, mmBps: 250n, tick: U / 100n, lot: 10n ** 14n, minQuantity: 4n * 10n ** 15n, cumulativeFunding: C0, bids: [{ price: 100n * U, quantity: 10n * U }], asks: [{ price: 100n * U, quantity: 10n * U }] },
    ],
    positions: [
      { symbol: "BTC", size: 8_000_000n, entry: 100n * U, fundingOwed: usd("0.01") },
      { symbol: "ETH", size: -3n * 10n ** 16n, entry: 100n * U },
    ],
  })
}

export function analysed(snapshot = hedgedAccount(), target = usd("5.4")): { snapshot: AccountSnapshot; scenario: Scenario; analysis: CandidateAnalysis } {
  const recon = reconcile(snapshot)
  const scenario = buildScenario(snapshot, recon, { shocksBps: { BTC: -1_000, ETH: -1_000 }, targetBuffer: target, createdAt: "fixture" })
  return { snapshot, scenario, analysis: analyzeCandidates(scenario, snapshot, recon, { slippageBps: 0n }) }
}

export function confirmationFor(analysis: CandidateAnalysis, snapshot: AccountSnapshot, scenario: Scenario, candidateId = analysis.selected!): ActionRecord {
  const { request, candidate } = requestFromCandidate(analysis, candidateId, snapshot, { deadlineSeconds: 120, nowSeconds: snapshot.block.timestamp, nonce: keccak256(toBytes(`nonce ${candidateId}`)) })
  const binding = { chainId: 50383, guard: GUARD, marginBank: BANK, owner: ACCOUNT }
  return {
    version: "mr-action/1",
    actionId: actionIdOf(binding, request),
    kind: "RESCUE",
    createdAt: "fixture",
    binding,
    scenarioId: scenario.id,
    candidateId,
    request: { pool: request.pool, expectedSignedSize: request.expectedSignedSize.toString(), isBid: request.isBid, quantity: request.quantity.toString(), limitPrice: request.limitPrice.toString(), deadline: request.deadline.toString(), nonce: request.nonce },
    calldata: reduceCalldata(request),
    forecast: { expectedFill: candidate.reduce!.expectedFill.toString(), scenarioBuffer: candidate.scenario!.buffer.toString(), goal: candidate.goal! },
    quote: { blockNumber: snapshot.block.number.toString(), blockHash: snapshot.block.hash, validUntil: request.deadline.toString() },
    tx: { state: "CONFIRMED", from: ACCOUNT, nonce: 7, hash: TX_HASH },
    fill: { state: "NOT_APPLICABLE", requested: request.quantity.toString() },
    goal: { state: "NOT_EVALUATED" },
    history: [],
  }
}

export interface Execution {
  fills: { price: bigint; quantity: bigint }[]
  // Cumulative funding index of each market when the transaction executes (drift).
  cumulative?: { BTC?: bigint; ETH?: bigint }
  receiptBlock?: bigint
}

// What the bank would record for the confirmed reduction, and the account read at the
// receipt's block.
export function execute(pre: AccountSnapshot, record: ActionRecord, ex: Execution): { receipt: ActionReceipt; post: AccountSnapshot } {
  const pool = record.request.pool
  const leg = pre.positions.find((p) => p.pool === pool)!
  const info = pre.pools.find((p) => p.pool === pool)!
  const sign = leg.size > 0n ? 1n : -1n
  const block = ex.receiptBlock ?? pre.block.number + 2n
  const post = atBlock(pre, block)
  for (const p of post.pools) {
    const sym = p.symbol as "BTC" | "ETH"
    p.projectedCumulativeFunding = ex.cumulative?.[sym] ?? p.projectedCumulativeFunding
  }
  const newIndex = post.pools.find((p) => p.pool === pool)!.projectedCumulativeFunding
  const filled = ex.fills.reduce((s, f) => s + f.quantity, 0n)
  const funding = filled > 0n ? fundingOwed(leg.size, leg.entryFundingIndex, newIndex, info.oneBase) : 0n
  const logs: DecodedLog[] = []
  let size = leg.size
  let realized = 0n
  let i = 0
  if (filled > 0n && funding !== 0n) logs.push({ address: BANK, logIndex: i++, name: "FundingSettled", args: { account: ACCOUNT, perpPool: pool, payment: funding } })
  for (const f of ex.fills) {
    const r = realizedPnl(leg.size, leg.avgEntryPrice, f.quantity, f.price, info.oneBase)
    realized += r
    size -= sign * f.quantity
    logs.push({ address: BANK, logIndex: i++, name: "PositionUpdated", args: { account: ACCOUNT, perpPool: pool, newSize: size, avgEntryPrice: size === 0n ? 0n : leg.avgEntryPrice, realizedPnl: r, entryFundingIndex: newIndex } })
    logs.push({ address: pool, logIndex: i++, name: "OrderFilled", args: { takerOrderId: TAKER_ORDER, makerOrderId: 1000n + BigInt(i), quantityFilled: f.quantity, fillPrice: f.price, makerRemainingQuantity: 0n, takerRemainingQuantity: 0n } })
  }
  logs.push({ address: pool, logIndex: i++, name: "OrderPlaced", args: { orderId: TAKER_ORDER, placedOrder: { owner: ACCOUNT } } })
  logs.push({
    address: GUARD,
    logIndex: i++,
    name: "ReduceExecuted",
    args: { actionId: record.actionId, pool, orderId: TAKER_ORDER, sizeBefore: leg.size, sizeAfter: size, quantity: BigInt(record.request.quantity), limitPrice: BigInt(record.request.limitPrice) },
  })
  const postLeg = post.positions.find((p) => p.pool === pool)!
  if (size === 0n) post.positions = post.positions.filter((p) => p.pool !== pool)
  else Object.assign(postLeg, { size, avgEntryPrice: leg.avgEntryPrice, entryFundingIndex: newIndex })
  post.collateral.unlocked = pre.collateral.unlocked + realized - funding
  settleBank(post)
  const receipt = summarize(
    {
      txHash: TX_HASH,
      status: "success",
      blockNumber: block,
      blockHash: post.block.hash,
      canonical: true,
      from: ACCOUNT,
      to: GUARD,
      gasUsed: 1n,
      tx: { from: ACCOUNT, to: GUARD, input: record.calldata, nonce: 7, value: 0n, chainId: 50383 },
    },
    logs,
    { guard: GUARD, pool, owner: ACCOUNT, marginBank: BANK, isBid: record.request.isBid, limitPrice: BigInt(record.request.limitPrice), requested: BigInt(record.request.quantity) },
  )
  return { receipt, post }
}

export { ACCOUNT, BANK, POOL }
