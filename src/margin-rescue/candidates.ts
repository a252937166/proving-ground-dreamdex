// A finite set of repair candidates, each previewed NOW against the bounded book read
// at the reference block and then valued under the fixed scenario.
//
// Candidates: no action; 25/50/75/100% reductions of each BTC or ETH position, aligned
// down to the lot; and, if asked, cancelling every ordinary resting order. Nothing is
// optimised beyond this set, and a choice among them is only "the preferred evaluated
// candidate", never a global optimum.
import { abs, fillFee, realizedPnl } from "./math.js"
import { alignDown, protectiveLimit, simulateIoc, type Fill } from "./book.js"
import { goalStatus, portfolioOf, valuePortfolio, SHOCKABLE, type GoalStatus, type Portfolio, type Scenario, type ScenarioValuation } from "./scenario.js"
import { poolOf, sameAddress, type AccountSnapshot, type OrderRow, type StopRow } from "./snapshot.js"
import type { Reconciliation } from "./reconcile.js"

export const CANDIDATES_VERSION = "mr-candidates/1"

export interface CandidateOptions {
  fractionsPct?: number[]
  slippageBps?: bigint
  includeCancel?: boolean
}

export interface ReducePreview {
  pool: string
  symbol: string
  isBid: boolean
  requestedQuantity: bigint
  limitPrice: bigint
  touch: bigint
  fills: Fill[]
  expectedFill: bigint
  unfilled: bigint
  depthReadExhausted: boolean
  realizedPnl: bigint
  fundingSettled: bigint
  fees: bigint
}

export interface CandidateResult {
  id: string
  kind: "NONE" | "REDUCE" | "CANCEL_ORDERS"
  label: string
  status: "EVALUATED" | "UNAVAILABLE"
  reasons: string[]
  warnings: string[]
  duplicateOf?: string
  reduce?: ReducePreview
  post?: Portfolio
  costNow?: bigint // E_risk at reference marks: before minus after (slippage vs mark + fees)
  notionalReductionNow?: bigint
  scenario?: ScenarioValuation
  goal?: GoalStatus
  harmful?: boolean // worse scenario buffer than doing nothing
  remaining?: { pool: string; symbol: string; size: bigint }[]
}

export type AnalysisOutcome = "NO_ACTION_NEEDED" | "CANDIDATE_SELECTED" | "NO_FEASIBLE_CANDIDATE" | "BLOCKED"

export interface CandidateAnalysis {
  version: typeof CANDIDATES_VERSION
  scenarioId: string
  account: string
  block: { number: bigint; hash: string }
  target: bigint
  blockers: string[]
  baseline: { reference: ScenarioValuation; scenario: ScenarioValuation; goal: GoalStatus }
  candidates: CandidateResult[]
  ranking: string[]
  outcome: AnalysisOutcome
  selected: string | null
  excludedFromModel: { orders: OrderRow[]; stops: StopRow[]; note: string }
}

export function analyzeCandidates(s: Scenario, snapshot: AccountSnapshot, recon: Reconciliation, opts: CandidateOptions = {}): CandidateAnalysis {
  const fractions = opts.fractionsPct ?? [25, 50, 75, 100]
  const slippageBps = opts.slippageBps ?? 50n
  const target = BigInt(s.targetBuffer)
  const blockers = [...snapshot.problems]
  if (recon.verdict !== "EXACT") blockers.push(`reconciliation ${recon.verdict}: ${recon.reasons.join("; ")}`)
  if (snapshot.stops.error) blockers.push(`stops not listed: ${snapshot.stops.error}`)
  if (s.reference.blockHash.toLowerCase() !== snapshot.block.hash.toLowerCase()) blockers.push("scenario was built from a different snapshot")
  // Account modes this version does not execute for. A linked child draws margin from a
  // main wallet and owes it principal; the guard's route pulls nothing, but the ledger
  // and the action's meaning differ, so such accounts are analysed and not acted on.
  if (snapshot.accountMode.fundingPayer !== "0x0000000000000000000000000000000000000000") blockers.push(`linked child account funded by ${snapshot.accountMode.fundingPayer}: not supported`)
  if (snapshot.accountMode.mainFundedPrincipal > 0n) blockers.push(`main-funded principal outstanding (${snapshot.accountMode.mainFundedPrincipal}): not supported`)

  const baseline = portfolioOf(snapshot)
  const baseReference = valuePortfolio(s, baseline, "reference")
  const baseScenario = valuePortfolio(s, baseline, "scenario")
  const candidates: CandidateResult[] = [
    {
      id: "NONE",
      kind: "NONE",
      label: "no action",
      status: "EVALUATED",
      reasons: [],
      warnings: [],
      post: baseline,
      costNow: 0n,
      notionalReductionNow: 0n,
      scenario: baseScenario,
      goal: goalStatus(baseScenario, target),
      harmful: false,
      remaining: remainingOf(snapshot, baseline),
    },
  ]

  for (const position of snapshot.positions) {
    const info = poolOf(snapshot, position.pool)
    if (!SHOCKABLE.includes(info.symbol.toUpperCase() as (typeof SHOCKABLE)[number])) continue
    const absSize = abs(position.size)
    const isBid = position.size < 0n // buy back a short, sell down a long
    const book = snapshot.books.find((b) => sameAddress(b.pool, position.pool))
    const seen = new Map<bigint, string>()
    for (const pct of fractions) {
      const id = `${info.symbol.toUpperCase()}-${pct}`
      const label = `reduce ${info.symbol} ${isBid ? "short" : "long"} by ${pct}%`
      const qty = alignDown((absSize * BigInt(pct)) / 100n, info.grid.lotSize)
      const c: CandidateResult = { id, kind: "REDUCE", label, status: "UNAVAILABLE", reasons: [], warnings: [] }
      candidates.push(c)
      if (qty === 0n) {
        c.reasons.push("rounds to zero on the lot grid")
        continue
      }
      if (qty < info.grid.minQuantity) {
        c.reasons.push(`${qty} is below the venue minimum order ${info.grid.minQuantity}`)
        continue
      }
      const remainder = absSize - qty
      if (remainder > 0n && remainder < info.grid.minQuantity) {
        c.reasons.push(`leaves ${remainder}, below the venue minimum ${info.grid.minQuantity}: no single order could close it later`)
        continue
      }
      if (seen.has(qty)) {
        c.reasons.push(`same quantity as ${seen.get(qty)}`)
        c.duplicateOf = seen.get(qty)
        continue
      }
      seen.set(qty, id)
      if (!book) {
        c.reasons.push("order book was not read")
        continue
      }
      const side = isBid ? book.asks : book.bids
      if (side.length === 0) {
        c.reasons.push("no resting counterparty on the book")
        continue
      }
      const touch = side[0].price
      const limit = protectiveLimit(touch, isBid, slippageBps, info.grid.tickSize)
      const crossingOwn = snapshot.orders.filter((o) => sameAddress(o.pool, position.pool) && o.isBid !== isBid && !o.expired && (isBid ? o.price <= limit : o.price >= limit))
      if (crossingOwn.length) {
        c.reasons.push(`own resting order(s) ${crossingOwn.map((o) => o.orderId).join(", ")} sit inside the limit; the venue would revert SelfMatchCancelTaker`)
        continue
      }
      const sim = simulateIoc(side, isBid, qty, limit)
      if (sim.filled === 0n) {
        c.reasons.push("nothing on the book inside the protective limit (the venue would revert ImmediateOrCancelNoFill)")
        continue
      }
      if (sim.unfilled > 0n) c.warnings.push(`book inside the limit covers ${sim.filled} of ${qty}; the forecast uses the expected partial fill`)
      if (sim.depthReadExhausted) c.warnings.push("all levels read were inside the limit; the real fill may be larger")
      const left = absSize - sim.filled
      if (left > 0n && left < info.grid.minQuantity) c.warnings.push(`the expected partial fill would leave ${left}, below the venue minimum`)
      const capacity = snapshot.capacities.find((x) => sameAddress(x.pool, position.pool))
      if (capacity && qty > capacity.effectiveReducingCapacity) {
        c.warnings.push(`resting reduce-side orders already claim ${absSize - capacity.effectiveReducingCapacity}; the IOC must post initial margin for ${qty - capacity.effectiveReducingCapacity} while it runs`)
      }
      const { post, ...reduce } = previewReduce(snapshot, baseline, position.pool, isBid, qty, limit, touch, sim.fills)
      c.reduce = { ...reduce, depthReadExhausted: sim.depthReadExhausted }
      c.post = post
      c.status = "EVALUATED"
    }
  }

  if (opts.includeCancel) {
    const c: CandidateResult = { id: "CANCEL-ORDERS", kind: "CANCEL_ORDERS", label: "cancel every ordinary resting order", status: "UNAVAILABLE", reasons: [], warnings: [] }
    candidates.push(c)
    if (snapshot.collateral.locked === 0n) {
      c.reasons.push("no collateral is locked behind resting orders")
    } else {
      c.status = "EVALUATED"
      c.post = { unlocked: baseline.unlocked + baseline.locked, locked: 0n, legs: baseline.legs }
      c.warnings.push("moves locked collateral to unlocked; positions and maintenance margin do not change, and total equity does not rise (fork-verified)")
      if (snapshot.stops.rows.some((r) => r.liveAtBlock)) c.warnings.push("TP/SL stops are not cancelled; their prepaid STT is not USDso collateral")
    }
  }

  for (const c of candidates) {
    if (c.status !== "EVALUATED" || !c.post || c.kind === "NONE") continue
    const reference = valuePortfolio(s, c.post, "reference")
    c.costNow = baseReference.eRisk - reference.eRisk
    c.notionalReductionNow = baseReference.notional - reference.notional
    c.scenario = valuePortfolio(s, c.post, "scenario")
    c.goal = goalStatus(c.scenario, target)
    c.harmful = c.scenario.buffer < baseScenario.buffer
    if (c.harmful) c.warnings.push("worsens the scenario buffer compared with doing nothing (it removes a hedge under this scenario)")
    c.remaining = remainingOf(snapshot, c.post)
  }

  const meeting = candidates.filter((c) => c.kind !== "NONE" && c.status === "EVALUATED" && c.goal === "MEETS")
  meeting.sort(
    (a, b) =>
      cmp(a.notionalReductionNow!, b.notionalReductionNow!) || cmp(a.costNow!, b.costNow!) || cmp(b.scenario!.buffer, a.scenario!.buffer) || a.id.localeCompare(b.id),
  )
  const baselineGoal = goalStatus(baseScenario, target)
  let outcome: AnalysisOutcome
  let selected: string | null = null
  if (blockers.length) outcome = "BLOCKED"
  else if (baselineGoal === "MEETS") outcome = "NO_ACTION_NEEDED"
  else if (meeting.length) {
    outcome = "CANDIDATE_SELECTED"
    selected = meeting[0].id
  } else outcome = "NO_FEASIBLE_CANDIDATE"

  return {
    version: CANDIDATES_VERSION,
    scenarioId: s.id,
    account: snapshot.account,
    block: { number: snapshot.block.number, hash: snapshot.block.hash },
    target,
    blockers,
    baseline: { reference: baseReference, scenario: baseScenario, goal: baselineGoal },
    candidates,
    ranking: meeting.map((c) => c.id),
    outcome,
    selected,
    excludedFromModel: {
      orders: snapshot.orders,
      stops: snapshot.stops.rows.filter((r) => r.liveAtBlock),
      note: "Resting orders and TP/SL stops are listed, not simulated: the static shock does not fill orders or fire stops along the way.",
    },
  }
}

// One reduction executed now at the simulated fills: funding owed on the WHOLE
// position settles once, realized PnL floors per fill, fees per fill, the entry stays
// on a partial close, and locked collateral is unchanged (an IOC leaves nothing resting).
export function previewReduce(
  snapshot: AccountSnapshot,
  portfolio: Portfolio,
  pool: string,
  isBid: boolean,
  requestedQuantity: bigint,
  limitPrice: bigint,
  touch: bigint,
  fills: Fill[],
): ReducePreview & { post: Portfolio } {
  const info = poolOf(snapshot, pool)
  const leg = portfolio.legs.find((l) => sameAddress(l.pool, pool))
  if (!leg || leg.size === 0n) throw new Error(`no position in ${pool}`)
  const filled = fills.reduce((s, f) => s + f.quantity, 0n)
  if (filled > abs(leg.size)) throw new Error("fill larger than the position")
  let realized = 0n
  let fees = 0n
  for (const f of fills) {
    realized += realizedPnl(leg.size, leg.avgEntryPrice, f.quantity, f.price, info.oneBase)
    fees += fillFee(f.quantity, f.price, info.oneBase, info.params.takerFeeBpsTimes1k)
  }
  const fundingSettled = filled > 0n ? leg.fundingOwed : 0n
  const newSize = leg.size > 0n ? leg.size - filled : leg.size + filled
  const legs = portfolio.legs
    .map((l) => (sameAddress(l.pool, pool) ? { ...l, size: newSize, avgEntryPrice: newSize === 0n ? 0n : l.avgEntryPrice, fundingOwed: filled > 0n ? 0n : l.fundingOwed } : l))
    .filter((l) => l.size !== 0n)
  return {
    pool,
    symbol: info.symbol,
    isBid,
    requestedQuantity,
    limitPrice,
    touch,
    fills,
    expectedFill: filled,
    unfilled: requestedQuantity - filled,
    depthReadExhausted: false,
    realizedPnl: realized,
    fundingSettled,
    fees,
    post: { unlocked: portfolio.unlocked + realized - fees - fundingSettled, locked: portfolio.locked, legs },
  }
}

function remainingOf(snapshot: AccountSnapshot, p: Portfolio) {
  return p.legs.map((l) => ({ pool: l.pool, symbol: poolOf(snapshot, l.pool).symbol, size: l.size }))
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

