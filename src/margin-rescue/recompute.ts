// Recompute the SAME scenario from what actually happened.
//
// Inputs: the scenario and the candidate's forecast, the snapshot taken just before
// sending (pre), the decoded receipt, a snapshot at the receipt's block (post), and
// every MarginBank row naming the owner between the two. The ledger between pre and
// post must be explained by this transaction's own rows; anything else marks the
// result BASELINE_CHANGED rather than crediting the action with it. The remaining
// portfolio is then valued at the scenario's ORIGINAL absolute prices.
import type { Address, Hex, Log, PublicClient } from "viem"
import { fillFee, fundingOwed, realizedPnl } from "./math.js"
import { goalStatus, portfolioOf, scenarioCompatibility, valuePortfolio, type Scenario, type ScenarioValuation } from "./scenario.js"
import { poolOf, sameAddress, type AccountSnapshot } from "./snapshot.js"
import { reconcile } from "./reconcile.js"
import { decodeLogs, fillState, type ActionReceipt, type DecodedLog } from "./receipt.js"
import type { CandidateAnalysis } from "./candidates.js"
import type { FillState, GoalState } from "./journal.js"

export const RECOMPUTE_VERSION = "mr-recompute/1"

export interface LedgerCheck {
  name: string
  ok: boolean
  expected: string
  observed: string
}

export interface RecomputeResult {
  version: typeof RECOMPUTE_VERSION
  scenarioId: string
  candidateId: string
  actionId: Hex
  tx: { hash: Hex | null; status: string; blockNumber: bigint | null; blockHash: Hex | null; canonical: boolean }
  fill: { state: FillState; requested: bigint; filled: bigint; unfilled: bigint; fills: { price: bigint; quantity: bigint }[]; priceBoundRespected: boolean }
  ledger: { realizedPnl: bigint; fundingSettled: bigint; fees: bigint; checks: LedgerCheck[] }
  externalChanges: string[]
  postReconciliation: string
  planned: { requested: bigint; expectedFill: bigint; scenario: ScenarioValuation | null }
  actual: { scenario: ScenarioValuation | null; currentHealth: { eRisk: bigint; mm: bigint; buffer: bigint } }
  baseline: { scenario: ScenarioValuation }
  differences: { fillVsForecast: bigint; bufferVsForecast: bigint | null; untouchedLegsFundingDrift: bigint }
  goal: { state: GoalState; reason: string }
}

export interface RecomputeInput {
  scenario: Scenario
  analysis: CandidateAnalysis
  candidateId: string
  actionId: Hex
  pre: AccountSnapshot
  post: AccountSnapshot
  receipt: ActionReceipt | null
  externalLogs: DecodedLog[]
}

export function recompute(input: RecomputeInput): RecomputeResult {
  const { scenario, analysis, pre, post, receipt } = input
  const candidate = analysis.candidates.find((c) => c.id === input.candidateId)
  if (!candidate?.reduce) throw new Error(`${input.candidateId} is not a reduction candidate`)
  const pool = candidate.reduce.pool
  const info = poolOf(pre, pool)
  const target = BigInt(scenario.targetBuffer)
  const requested = candidate.reduce.requestedQuantity
  const preLeg = pre.positions.find((p) => sameAddress(p.pool, pool))
  const postLeg = post.positions.find((p) => sameAddress(p.pool, pool))
  const checks: LedgerCheck[] = []
  const check = (name: string, ok: boolean, expected: unknown, observed: unknown) =>
    checks.push({ name, ok, expected: String(expected), observed: String(observed) })

  const success = receipt?.status === "success"
  const filled = success ? receipt!.filled : 0n
  let realized = 0n
  let funding = 0n
  let fees = 0n
  const externalChanges: string[] = input.externalLogs.map((l) => `bank ${l.name} for the owner outside this transaction (log ${l.logIndex})`)

  if (!preLeg) externalChanges.push("the target position was gone before sending")
  if (receipt && success && preLeg) {
    const sign = preLeg.size > 0n ? 1n : -1n
    let expectedRealized = 0n
    let expectedFees = 0n
    for (const f of receipt.fills) {
      expectedRealized += realizedPnl(preLeg.size, preLeg.avgEntryPrice, f.quantity, f.price, info.oneBase)
      expectedFees += fillFee(f.quantity, f.price, info.oneBase, info.params.takerFeeBpsTimes1k)
    }
    realized = receipt.owner.positionUpdates.reduce((s, u) => s + u.realizedPnl, 0n)
    funding = receipt.owner.fundingSettled.reduce((s, x) => s + x.payment, 0n)
    fees = receipt.owner.fees.reduce((s, x) => s + x.amount, 0n)
    const newIndex = receipt.owner.positionUpdates.at(-1)?.entryFundingIndex
    const expectedFunding = newIndex === undefined ? 0n : fundingOwed(preLeg.size, preLeg.entryFundingIndex, newIndex, info.oneBase)
    const postSize = postLeg?.size ?? 0n

    check("guard saw the confirmed position", receipt.guard?.sizeBefore === preLeg.size, preLeg.size, receipt.guard?.sizeBefore)
    check("guard event matches the post size", receipt.guard?.sizeAfter === postSize, postSize, receipt.guard?.sizeAfter)
    check("size moved by exactly the fills", postSize === preLeg.size - sign * filled, preLeg.size - sign * filled, postSize)
    check("no flip and no growth", sign > 0n ? postSize >= 0n && postSize <= preLeg.size : postSize <= 0n && postSize >= preLeg.size, "same side or flat", postSize)
    check("every fill inside the confirmed limit", receipt.priceBoundRespected, `limit ${candidate.reduce.limitPrice}`, receipt.fills.map((f) => f.price).join(","))
    check("IOC left nothing resting", !receipt.rested, false, receipt.rested)
    check("realized PnL = floor per fill", realized === expectedRealized, expectedRealized, realized)
    check("funding settled once, on the whole position", receipt.owner.fundingSettled.length <= 1 && funding === expectedFunding, expectedFunding, funding)
    check("fees = rate on each fill's notional", fees === expectedFees, expectedFees, fees)
    check("entry kept on a partial close", postSize === 0n ? (postLeg?.avgEntryPrice ?? 0n) === 0n : postLeg!.avgEntryPrice === preLeg.avgEntryPrice, preLeg.avgEntryPrice, postLeg?.avgEntryPrice ?? 0n)
    check("funding index reset", postSize === 0n || postLeg!.entryFundingIndex === newIndex, newIndex, postLeg?.entryFundingIndex)
    check("transient margin lock released", receipt.owner.locked === receipt.owner.unlocked, receipt.owner.locked, receipt.owner.unlocked)
    check("unlocked moved by realized − funding − fees", post.collateral.unlocked - pre.collateral.unlocked === realized - funding - fees, realized - funding - fees, post.collateral.unlocked - pre.collateral.unlocked)
    check("locked collateral unchanged", post.collateral.locked === pre.collateral.locked, pre.collateral.locked, post.collateral.locked)
    check("no wallet pull, deposit or withdrawal", receipt.owner.walletMoves.length === 0, "none", receipt.owner.walletMoves.join("; ") || "none")
    check("wallet USDso and allowance unchanged", post.wallet.usdso === pre.wallet.usdso && post.wallet.allowanceToBank === pre.wallet.allowanceToBank, `${pre.wallet.usdso}/${pre.wallet.allowanceToBank}`, `${post.wallet.usdso}/${post.wallet.allowanceToBank}`)
    check("no other bank rows for the owner", receipt.owner.otherPools.length === 0 && receipt.owner.other.length === 0, "none", [...receipt.owner.otherPools, ...receipt.owner.other].join("; ") || "none")
  } else if (receipt && !success) {
    check("reverted: position unchanged", (postLeg?.size ?? 0n) === (preLeg?.size ?? 0n), preLeg?.size, postLeg?.size)
    check("reverted: collateral unchanged", post.collateral.unlocked === pre.collateral.unlocked && post.collateral.locked === pre.collateral.locked, `${pre.collateral.unlocked}/${pre.collateral.locked}`, `${post.collateral.unlocked}/${post.collateral.locked}`)
  }

  // Every other market must be untouched, and no market may appear or vanish.
  for (const p of pre.positions) {
    if (sameAddress(p.pool, pool)) continue
    const q = post.positions.find((x) => sameAddress(x.pool, p.pool))
    if (!q || q.size !== p.size || q.avgEntryPrice !== p.avgEntryPrice || q.entryFundingIndex !== p.entryFundingIndex) {
      externalChanges.push(`${poolOf(pre, p.pool).symbol} position changed outside the action`)
    }
  }
  for (const q of post.positions) {
    if (!pre.positions.some((p) => sameAddress(p.pool, q.pool))) externalChanges.push(`new position in ${poolOf(post, q.pool).symbol}`)
  }
  const ordersBefore = pre.orders.map((o) => `${o.pool}:${o.orderId}:${o.quantityRemaining}`).sort().join("|")
  const ordersAfter = post.orders.map((o) => `${o.pool}:${o.orderId}:${o.quantityRemaining}`).sort().join("|")
  if (ordersBefore !== ordersAfter) externalChanges.push("resting orders changed between the pre and post snapshots")
  for (const c of checks) if (!c.ok) externalChanges.push(`unexplained: ${c.name} (expected ${c.expected}, observed ${c.observed})`)

  const postRecon = reconcile(post)
  const compat = scenarioCompatibility(scenario, post)
  let actualScenario: ScenarioValuation | null = null
  if (compat.length === 0) actualScenario = valuePortfolio(scenario, portfolioOf(post))

  const untouchedDrift = pre.positions
    .filter((p) => !sameAddress(p.pool, pool))
    .reduce((s, p) => {
      const q = post.positions.find((x) => sameAddress(x.pool, p.pool))
      if (!q) return s
      const a = fundingOwed(p.size, p.entryFundingIndex, poolOf(pre, p.pool).projectedCumulativeFunding, poolOf(pre, p.pool).oneBase)
      const b = fundingOwed(q.size, q.entryFundingIndex, poolOf(post, q.pool).projectedCumulativeFunding, poolOf(post, q.pool).oneBase)
      return s + (b - a)
    }, 0n)

  let goal: { state: GoalState; reason: string }
  if (!receipt) goal = { state: "UNAVAILABLE", reason: "no receipt" }
  else if (!receipt.canonical || !post.canonical.ok) goal = { state: "UNAVAILABLE", reason: "receipt or post snapshot not canonical" }
  else if (postRecon.verdict !== "EXACT") goal = { state: "UNAVAILABLE", reason: `post-state reconciliation ${postRecon.verdict}: ${postRecon.reasons.join("; ")}` }
  else if (compat.length) goal = { state: "BASELINE_CHANGED", reason: compat.join("; ") }
  else if (externalChanges.length) goal = { state: "BASELINE_CHANGED", reason: externalChanges.join("; ") }
  else if (!success) goal = { state: "GOAL_NOT_MET", reason: "transaction reverted; the account is unchanged" }
  else {
    const g = goalStatus(actualScenario!, target)
    goal =
      g === "MEETS"
        ? { state: "GOAL_MET", reason: `scenario buffer ${actualScenario!.buffer} ≥ target ${target}` }
        : { state: "GOAL_NOT_MET", reason: `scenario buffer ${actualScenario!.buffer} < target ${target}${g === "UNCERTAIN" ? " (interval crosses the target)" : ""}` }
  }

  return {
    version: RECOMPUTE_VERSION,
    scenarioId: scenario.id,
    candidateId: input.candidateId,
    actionId: input.actionId,
    tx: {
      hash: receipt?.txHash ?? null,
      status: receipt?.status ?? "not sent",
      blockNumber: receipt?.blockNumber ?? null,
      blockHash: receipt?.blockHash ?? null,
      canonical: receipt?.canonical ?? false,
    },
    fill: {
      state: receipt ? fillState(receipt, requested) : "NO_FILL",
      requested,
      filled,
      unfilled: requested - filled,
      fills: receipt?.fills.map((f) => ({ price: f.price, quantity: f.quantity })) ?? [],
      priceBoundRespected: receipt?.priceBoundRespected ?? true,
    },
    ledger: { realizedPnl: realized, fundingSettled: funding, fees, checks },
    externalChanges,
    postReconciliation: postRecon.verdict,
    planned: { requested, expectedFill: candidate.reduce.expectedFill, scenario: candidate.scenario ?? null },
    actual: { scenario: actualScenario, currentHealth: { eRisk: postRecon.independent.eRisk, mm: postRecon.independent.mm, buffer: postRecon.independent.buffer } },
    baseline: { scenario: analysis.baseline.scenario },
    differences: {
      fillVsForecast: filled - candidate.reduce.expectedFill,
      bufferVsForecast: actualScenario && candidate.scenario ? actualScenario.buffer - candidate.scenario.buffer : null,
      untouchedLegsFundingDrift: untouchedDrift,
    },
    goal,
  }
}

// MarginBank rows naming `owner` in any indexed position, from `fromBlock` to `toBlock`
// inclusive, in chunks the RPC accepts (Hideki limits a range to 1,000 blocks).
export async function bankLogsForOwner(client: PublicClient, bank: Address, owner: Address, fromBlock: bigint, toBlock: bigint): Promise<(DecodedLog & { txHash: Hex })[]> {
  const topic = `0x${owner.toLowerCase().slice(2).padStart(64, "0")}` as Hex
  const out: (DecodedLog & { txHash: Hex })[] = []
  for (let start = fromBlock; start <= toBlock; start += 1000n) {
    const end = start + 999n < toBlock ? start + 999n : toBlock
    for (const position of [1, 2, 3]) {
      const topics: (Hex | null)[] = [null, null, null, null]
      topics[position] = topic
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [{ address: bank, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: topics.slice(0, position + 1) }],
      } as never)) as unknown as (Log & { transactionHash: Hex })[]
      const decoded = decodeLogs(logs as Log[])
      decoded.forEach((d, i) => out.push({ ...d, txHash: logs[i].transactionHash }))
    }
  }
  const seen = new Set<string>()
  return out.filter((l) => (seen.has(`${l.txHash}:${l.logIndex}`) ? false : (seen.add(`${l.txHash}:${l.logIndex}`), true)))
}

