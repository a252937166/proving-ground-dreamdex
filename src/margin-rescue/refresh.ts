// The last check before a confirmed reduction is sent.
//
// The whole account is read again at one pinned block (balances, every position,
// resting orders, stops, risk parameters) and compared with the snapshot the
// confirmation was analysed on. Then every candidate is evaluated again under the
// ORIGINAL scenario (its absolute prices and frozen risk rates) at the fresh state, and
// the confirmed request itself, with its quantity and limit unchanged, is previewed
// against the fresh book. The confirmation stays valid only if the account's structure
// is unchanged, the same candidate is still the one selected, the confirmed request
// still fills what was forecast and still meets the target, and its deadline leaves
// room to send. Otherwise it is INVALIDATED and must not be sent; a new confirmation
// has to be made from the new analysis.
//
// Funding keeps accruing between the two reads. That is not a structural change: the
// fresh analysis already uses the fresh funding owed, and the drift is reported.
import { abs } from "./math.js"
import { analyzeCandidates, previewReduce, type CandidateAnalysis, type CandidateResult } from "./candidates.js"
import { simulateIoc } from "./book.js"
import { goalStatus, portfolioOf, valuePortfolio, type Scenario } from "./scenario.js"
import { poolOf, sameAddress, type AccountSnapshot } from "./snapshot.js"
import type { Reconciliation } from "./reconcile.js"
import type { ActionRecord } from "./journal.js"
import { requestOf } from "./receipt.js"

export const REFRESH_VERSION = "mr-refresh/1"

export interface RefreshResult {
  version: typeof REFRESH_VERSION
  verdict: "STILL_VALID" | "INVALIDATED"
  reasons: string[]
  stateChanges: string[]
  block: { number: bigint; hash: string; timestamp: bigint }
  fundingDrift: bigint // Σ funding owed now − Σ funding owed at the analysis (raw USDso)
  reanalysis: CandidateAnalysis
  // The confirmed request previewed now (same id, quantity and limit), and the fresh
  // analysis with that preview in place of its own candidate: the forecast that the
  // recomputation compares with.
  refreshed: CandidateResult | null
  analysisForRecompute: CandidateAnalysis
}

export interface RefreshInput {
  scenario: Scenario
  confirmation: ActionRecord
  analysisSnapshot: AccountSnapshot // the snapshot the confirmation was analysed on
  original: CandidateAnalysis
  fresh: AccountSnapshot
  freshRecon: Reconciliation
  slippageBps: bigint
  minSecondsLeft: number // the deadline must leave at least this long to send
}

export function refreshConfirmation(input: RefreshInput): RefreshResult {
  const { scenario, confirmation, analysisSnapshot, original, fresh, freshRecon } = input
  const reasons: string[] = []
  const req = requestOf(confirmation)

  if (fresh.problems.length) reasons.push(`snapshot problems: ${fresh.problems.join("; ")}`)
  if (freshRecon.verdict !== "EXACT") reasons.push(`reconciliation ${freshRecon.verdict}: ${freshRecon.reasons.join("; ")}`)
  // The same block (same hash) is the same state; an older block, or another block at
  // the same height, is not a refresh of this analysis.
  if (fresh.block.number < analysisSnapshot.block.number) reasons.push(`refresh block ${fresh.block.number} is older than the analysis block ${analysisSnapshot.block.number}`)
  else if (fresh.block.number === analysisSnapshot.block.number && fresh.block.hash.toLowerCase() !== analysisSnapshot.block.hash.toLowerCase()) reasons.push(`block ${fresh.block.number} has another hash than the one analysed`)
  if (!sameAddress(fresh.account, confirmation.binding.owner)) reasons.push("refresh read another account")
  const stateChanges = relevantChanges(analysisSnapshot, fresh)
  reasons.push(...stateChanges)

  const reanalysis = analyzeCandidates(scenario, fresh, freshRecon, { slippageBps: input.slippageBps, laterSnapshot: true })
  if (reanalysis.outcome !== "CANDIDATE_SELECTED") reasons.push(`re-analysis under the same scenario: ${reanalysis.outcome}${reanalysis.blockers.length ? ` (${reanalysis.blockers.join("; ")})` : ""}`)
  else if (reanalysis.selected !== confirmation.candidateId) reasons.push(`re-analysis now selects ${reanalysis.selected}, not the confirmed ${confirmation.candidateId}`)

  // The confirmed request, unchanged, against the fresh book.
  const before = original.candidates.find((c) => c.id === confirmation.candidateId)
  let refreshed: CandidateResult | null = null
  const position = fresh.positions.find((p) => sameAddress(p.pool, req.pool))
  const book = fresh.books.find((b) => sameAddress(b.pool, req.pool))
  if (!before?.reduce) reasons.push(`${confirmation.candidateId} is not a reduction in the original analysis`)
  else if (!position || position.size !== req.expectedSignedSize) reasons.push(`position is ${position?.size ?? 0n}, not the confirmed ${req.expectedSignedSize}`)
  else if (!book) reasons.push("the confirmed pool's book was not read")
  else {
    const side = req.isBid ? book.asks : book.bids
    const sim = simulateIoc(side, req.isBid, req.quantity, req.limitPrice)
    const baseline = portfolioOf(fresh)
    if (sim.filled === 0n) reasons.push("nothing on the book inside the confirmed limit now")
    else {
      const { post, ...reduce } = previewReduce(fresh, baseline, req.pool, req.isBid, req.quantity, req.limitPrice, side[0].price, sim.fills)
      const valued = valuePortfolio(scenario, post, "scenario")
      const reference = valuePortfolio(scenario, post, "reference")
      const baseReference = valuePortfolio(scenario, baseline, "reference")
      refreshed = {
        ...before,
        reduce: { ...reduce, depthReadExhausted: sim.depthReadExhausted },
        post,
        costNow: baseReference.eRisk - reference.eRisk,
        notionalReductionNow: baseReference.notional - reference.notional,
        scenario: valued,
        goal: goalStatus(valued, BigInt(scenario.targetBuffer)),
        remaining: post.legs.map((l) => ({ pool: l.pool, symbol: poolOf(fresh, l.pool).symbol, size: l.size })),
      }
      if (sim.filled !== before.reduce.expectedFill) reasons.push(`the book inside the limit now fills ${sim.filled}, not the forecast ${before.reduce.expectedFill}`)
      if (refreshed.goal !== "MEETS") reasons.push(`the confirmed request no longer meets the target under the scenario (${refreshed.goal}, buffer ${valued.buffer})`)
      const left = abs(position.size) - sim.filled
      if (left > 0n && left < poolOf(fresh, req.pool).grid.minQuantity) reasons.push(`the expected fill would leave ${left}, below the venue minimum`)
    }
  }
  const secondsLeft = req.deadline - fresh.block.timestamp
  if (secondsLeft < BigInt(input.minSecondsLeft)) reasons.push(`the confirmation's deadline leaves ${secondsLeft}s (< ${input.minSecondsLeft}s)`)

  const fundingDrift = totalFunding(fresh) - totalFunding(analysisSnapshot)
  const analysisForRecompute: CandidateAnalysis = {
    ...reanalysis,
    candidates: reanalysis.candidates.map((c) => (c.id === confirmation.candidateId && refreshed ? refreshed : c)),
  }
  return {
    version: REFRESH_VERSION,
    verdict: reasons.length ? "INVALIDATED" : "STILL_VALID",
    reasons,
    stateChanges,
    block: { number: fresh.block.number, hash: fresh.block.hash, timestamp: fresh.block.timestamp },
    fundingDrift,
    reanalysis,
    refreshed,
    analysisForRecompute,
  }
}

function totalFunding(s: AccountSnapshot): bigint {
  return portfolioOf(s).legs.reduce((sum, l) => sum + l.fundingOwed, 0n)
}

// Differences in the account's structure between two snapshots. Marks, the funding
// index and the books are expected to move and are not listed here.
export function relevantChanges(a: AccountSnapshot, b: AccountSnapshot): string[] {
  const out: string[] = []
  const sym = (s: AccountSnapshot, pool: string) => s.pools.find((p) => sameAddress(p.pool, pool))?.symbol ?? pool
  for (const p of a.positions) {
    const q = b.positions.find((x) => sameAddress(x.pool, p.pool))
    if (!q) out.push(`${sym(a, p.pool)} position ${p.size} is gone`)
    else {
      if (q.size !== p.size) out.push(`${sym(a, p.pool)} position changed from ${p.size} to ${q.size}`)
      if (q.avgEntryPrice !== p.avgEntryPrice) out.push(`${sym(a, p.pool)} entry price changed`)
      if (q.entryFundingIndex !== p.entryFundingIndex) out.push(`${sym(a, p.pool)} funding was settled (entry index changed)`)
    }
  }
  for (const q of b.positions) if (!a.positions.some((p) => sameAddress(p.pool, q.pool))) out.push(`new ${sym(b, q.pool)} position ${q.size}`)
  if (a.collateral.unlocked !== b.collateral.unlocked) out.push(`unlocked collateral changed from ${a.collateral.unlocked} to ${b.collateral.unlocked}`)
  if (a.collateral.locked !== b.collateral.locked) out.push(`locked collateral changed from ${a.collateral.locked} to ${b.collateral.locked}`)
  const orders = (s: AccountSnapshot) => s.orders.map((o) => `${o.pool.toLowerCase()}:${o.orderId}:${o.isBid}:${o.price}:${o.quantityRemaining}`).sort().join("|")
  if (orders(a) !== orders(b)) out.push(`resting orders changed (${a.orders.length} → ${b.orders.length})`)
  const stops = (s: AccountSnapshot) => s.stops.rows.filter((r) => r.liveAtBlock).map((r) => `${r.registry.toLowerCase()}:${r.orderId}`).sort().join("|")
  if (stops(a) !== stops(b)) out.push("live TP/SL stops changed")
  if (a.stops.error !== b.stops.error && b.stops.error) out.push(`stops could not be listed: ${b.stops.error}`)
  const mode = (s: AccountSnapshot) => `${s.accountMode.isolated}:${s.accountMode.creditFloor}:${s.accountMode.fundingPayer.toLowerCase()}:${s.accountMode.mainFundedPrincipal}`
  if (mode(a) !== mode(b)) out.push("account mode changed")
  if (a.wallet.allowanceToBank !== b.wallet.allowanceToBank) out.push(`USDso allowance to the bank changed from ${a.wallet.allowanceToBank} to ${b.wallet.allowanceToBank}`)
  const active = (s: AccountSnapshot) => s.coverage.activePools.map((p) => p.toLowerCase()).sort().join("|")
  if (active(a) !== active(b)) out.push("the bank's active pool list changed")
  return out
}
