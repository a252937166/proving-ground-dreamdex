// The app's live, read-only account analysis (its first two screens) and the candidate
// shape every screen shows. It reads public chain and indexer data and never a file, so
// the local server and the static site's in-browser build run the same code.
import { isAddress, type Address, type PublicClient } from "viem"
import { analyzeCandidates, type CandidateAnalysis } from "./candidates.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, stopLister } from "./common.js"
import { accountFigures } from "./math.js"
import { reconcile, snapshotLegs } from "./reconcile.js"
import { buildScenario } from "./scenario.js"
import { poolOf, readAccountSnapshot } from "./snapshot.js"

export function slimCandidate(c: CandidateAnalysis["candidates"][number]) {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    status: c.status,
    reasons: c.reasons,
    warnings: c.warnings,
    duplicateOf: c.duplicateOf,
    goal: c.goal,
    harmful: c.harmful,
    costNow: c.costNow,
    notionalReductionNow: c.notionalReductionNow,
    scenarioBuffer: c.scenario?.buffer,
    scenarioERisk: c.scenario?.eRisk,
    scenarioMm: c.scenario?.mm,
    reduce: c.reduce && { symbol: c.reduce.symbol, isBid: c.reduce.isBid, requestedQuantity: c.reduce.requestedQuantity, expectedFill: c.reduce.expectedFill, limitPrice: c.reduce.limitPrice, touch: c.reduce.touch, unfilled: c.reduce.unfilled, fees: c.reduce.fees },
    remaining: c.remaining,
  }
}

export interface AnalyzeInput {
  account: string
  btcPct: string
  ethPct: string
  targetUsdso: string
}

const PCT = /^-?\d{1,2}(\.\d{1,2})?$/
const USD = /^-?\d{1,9}(\.\d{1,6})?$/

export function parseAnalyzeInput(q: Record<string, string>): AnalyzeInput {
  const account = (q.account ?? "").trim()
  if (!isAddress(account, { strict: false })) throw new Error("account must be a 0x address")
  const btcPct = q.btc ?? "-8"
  const ethPct = q.eth ?? "-12"
  const targetUsdso = q.target ?? "0"
  for (const [k, v] of [["BTC shock", btcPct], ["ETH shock", ethPct]]) if (!PCT.test(v) || Math.abs(Number(v)) >= 90) throw new Error(`${k} must be a percentage between -90 and 90 with up to two decimals`)
  if (!USD.test(targetUsdso)) throw new Error("target must be a USDso amount with up to six decimals")
  return { account, btcPct, ethPct, targetUsdso }
}

const toBps = (pct: string) => Math.round(Number(pct) * 100)
const toRaw = (usd: string) => {
  const neg = usd.startsWith("-")
  const [w, f = ""] = usd.replace("-", "").split(".")
  const raw = BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18))
  return neg ? -raw : raw
}

export async function analyzeAccount(client: PublicClient, input: AnalyzeInput) {
  const started = Date.now()
  const snapshot = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: input.account as Address, bookPools: [BTC_POOL, ETH_POOL], listStops: stopLister() })
  const recon = reconcile(snapshot)
  const scenario = buildScenario(snapshot, recon, { shocksBps: { BTC: toBps(input.btcPct), ETH: toBps(input.ethPct) }, targetBuffer: toRaw(input.targetUsdso) })
  const analysis = analyzeCandidates(scenario, snapshot, recon)
  const now = accountFigures(snapshot.collateral.unlocked, snapshot.collateral.locked, snapshotLegs(snapshot))
  return {
    input,
    elapsedMs: Date.now() - started,
    account: snapshot.account,
    block: snapshot.block,
    canonical: snapshot.canonical,
    problems: snapshot.problems,
    coverage: { factoryPools: snapshot.coverage.factoryPools.length, activePools: snapshot.coverage.activePools.length },
    collateral: snapshot.collateral,
    legs: now.legs.map((l) => {
      const info = poolOf(snapshot, l.pool)
      const p = snapshot.positions.find((x) => x.pool.toLowerCase() === l.pool.toLowerCase())!
      return { symbol: info.symbol, baseDecimals: info.baseDecimals, size: l.size, entry: p.avgEntryPrice, mark: l.price, notional: l.notional, unrealizedPnl: l.unrealizedPnl, fundingOwed: l.fundingOwed, mm: l.mm }
    }),
    orders: snapshot.orders.length,
    stops: { listed: snapshot.stops.rows.length, live: snapshot.stops.rows.filter((r) => r.liveAtBlock).length, error: snapshot.stops.error },
    reconciliation: { verdict: recon.verdict, reasons: recon.reasons, independent: { eRisk: recon.independent.eRisk, eTotal: recon.independent.eTotal, mm: recon.independent.mm, im: recon.independent.im, buffer: recon.independent.buffer }, bank: recon.bank, diffs: recon.diffs },
    scenario: { id: scenario.id, markets: scenario.markets.map((m) => ({ symbol: m.symbol, baseDecimals: m.baseDecimals, referenceMark: m.referenceMark, scenarioPrice: m.scenarioPrice, shockBps: m.shockBps })), targetBuffer: scenario.targetBuffer },
    analysis: { outcome: analysis.outcome, selected: analysis.selected, ranking: analysis.ranking, blockers: analysis.blockers, baseline: analysis.baseline, candidates: analysis.candidates.map(slimCandidate), excluded: { orders: analysis.excludedFromModel.orders.length, stops: analysis.excludedFromModel.stops.length, note: analysis.excludedFromModel.note } },
  }
}
