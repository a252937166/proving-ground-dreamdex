// Plain-text rendering of Margin Rescue results. Amounts are exact decimal renderings
// of raw integers; nothing is rounded through floating point.
import { formatDecimal } from "../units.js"
import type { Reconciliation } from "./reconcile.js"
import type { AccountSnapshot } from "./snapshot.js"
import { poolOf } from "./snapshot.js"
import type { Scenario, ScenarioValuation } from "./scenario.js"
import type { CandidateAnalysis, CandidateResult } from "./candidates.js"
import type { RecomputeResult } from "./recompute.js"

const usd = (v: bigint, frac = 6) => formatDecimal(v, 18, frac)
const qty = (v: bigint, decimals: number) => formatDecimal(v, decimals, decimals)
const ratio = (bps: bigint | null) => (bps === null ? "n/a (MM is zero)" : `${formatDecimal(bps, 4, 4)}x`)
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length))
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s)

export function renderReconciliation(s: AccountSnapshot, r: Reconciliation): string {
  const lines = [
    "Margin Rescue: independent account reconciliation (read-only)",
    `  account             ${s.account}`,
    `  chain / bank        ${s.chainId} / ${s.marginBank}`,
    `  block               ${s.block.number}  ${s.block.hash}  (${new Date(Number(s.block.timestamp) * 1000).toISOString()})`,
    `  canonical recheck   ${s.canonical.ok ? "yes" : "NO"} at ${s.canonical.checkedAt}`,
    `  pools               ${s.coverage.activePools.length} active of ${s.coverage.factoryPools.length} deployed; outside active: positions ${s.coverage.nonzeroOutsideActive.length}, orders ${s.coverage.pendingOutsideActive.length}`,
    `  resting orders      ${s.orders.length}   stops listed ${s.stops.rows.length} (live at block: ${s.stops.rows.filter((x) => x.liveAtBlock).length}; ${s.stops.source}${s.stops.error ? `, error: ${s.stops.error}` : ""})`,
    "",
    "  leg      size                        entry             mark              PnL (floor)        funding owed     MM",
  ]
  for (const leg of r.independent.legs) {
    const info = poolOf(s, leg.pool)
    const pos = s.positions.find((p) => p.pool === leg.pool)!
    lines.push(
      `  ${pad(info.symbol, 8)} ${lpad(qty(leg.size, info.baseDecimals), 26)}  ${lpad(usd(pos.avgEntryPrice, 4), 16)}  ${lpad(usd(leg.price, 4), 16)}  ${lpad(usd(leg.unrealizedPnl), 17)}  ${lpad(usd(leg.fundingOwed), 15)}  ${usd(leg.mm)}`,
    )
  }
  lines.push(
    "",
    "                      independent                 bank getter                 bank − independent (raw)",
    `  E_risk (equity)     ${pad(usd(r.independent.eRisk), 27)} ${pad(usd(r.bank.equity), 27)} ${r.diffs.equity}`,
    `  MM                  ${pad(usd(r.independent.mm), 27)} ${pad(usd(r.bank.mmReq), 27)} ${r.diffs.mmReq}`,
    `  IM                  ${pad(usd(r.independent.im), 27)} ${pad(usd(r.bank.imReq), 27)} ${r.diffs.imReq}`,
    `  CM                  ${pad(usd(r.independent.cm), 27)} ${pad(usd(r.bank.cmReq), 27)} ${r.diffs.cmReq}`,
    `  unlocked / locked   ${usd(s.collateral.unlocked)} / ${usd(s.collateral.locked)}`,
    `  E_total             ${usd(r.independent.eTotal)}  (E_risk + locked)`,
    `  buffer              ${usd(r.independent.buffer)}  (E_risk − MM)`,
    `  SDK truncation      E_risk would be ${usd(r.truncation.eRisk)} (${r.truncation.minusBank} raw from the bank; ${r.truncation.legsRoundingDifferently} legs round differently)`,
    "",
    `VERDICT: ${r.verdict}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`,
  )
  if (s.problems.length) lines.push(`PROBLEMS: ${s.problems.join("; ")}`)
  return lines.join("\n") + "\n"
}

function valuationLine(v: ScenarioValuation): string {
  return `E_risk ${usd(v.eRisk)}  E_total ${usd(v.eTotal)}  MM ${usd(v.mm)}  buffer ${usd(v.buffer)}  health ${ratio(v.healthRatioBps)}`
}

export function renderAnalysis(s: AccountSnapshot, sc: Scenario, a: CandidateAnalysis): string {
  const lines = [
    "Margin Rescue: finite repair candidates under one fixed scenario (read-only analysis)",
    `  scenario id         ${sc.id}`,
    `  reference           block ${sc.reference.blockNumber} ${sc.reference.blockHash}`,
    `  model               ${sc.model}; ${sc.shock}; funding ${sc.funding.split(":")[0]}`,
    `  target buffer       ${usd(a.target)} USDso (scenario E_risk − scenario MM)`,
    "",
    "  market   reference mark      scenario price      shock",
  ]
  for (const m of sc.markets) lines.push(`  ${pad(m.symbol, 8)} ${lpad(usd(BigInt(m.referenceMark), 4), 18)}  ${lpad(usd(BigInt(m.scenarioPrice), 4), 18)}  ${m.shockBps === null ? "held at reference" : `${formatDecimal(BigInt(m.shockBps), 2, 2)}%`}`)
  lines.push("", `  baseline now        ${valuationLine(a.baseline.reference)}`, `  baseline scenario   ${valuationLine(a.baseline.scenario)}  -> ${a.baseline.goal}`, "")
  lines.push("  id          status       goal       notional cut now     cost now (slippage+fees)   scenario buffer        notes")
  for (const c of a.candidates) lines.push(candidateLine(s, c))
  lines.push("", `OUTCOME: ${a.outcome}${a.selected ? ` -> ${a.selected} (preferred among the evaluated candidates only; not a global optimum)` : ""}`)
  if (a.blockers.length) lines.push(`BLOCKERS: ${a.blockers.join("; ")}`)
  lines.push(
    `Not modelled (listed): ${a.excludedFromModel.orders.length} resting orders, ${a.excludedFromModel.stops.length} live stops. ${a.excludedFromModel.note}`,
    "This is a static what-if on the stated prices. It does not predict prices, fills or liquidation, and an expected fill is not a guaranteed fill.",
  )
  return lines.join("\n") + "\n"
}

function candidateLine(s: AccountSnapshot, c: CandidateResult): string {
  const notes = [...c.reasons, ...c.warnings]
  if (c.reduce) {
    const info = poolOf(s, c.reduce.pool)
    notes.unshift(`${c.reduce.isBid ? "buy" : "sell"} ${qty(c.reduce.requestedQuantity, info.baseDecimals)} limit ${usd(c.reduce.limitPrice, 4)}, expect ${qty(c.reduce.expectedFill, info.baseDecimals)}`)
  }
  return [
    "  " + pad(c.id, 11),
    pad(c.status, 12),
    pad(c.goal ?? "-", 10),
    lpad(c.notionalReductionNow === undefined ? "-" : usd(c.notionalReductionNow, 2), 18),
    lpad(c.costNow === undefined ? "-" : usd(c.costNow), 26),
    lpad(c.scenario ? usd(c.scenario.buffer) : "-", 22),
    "  " + (c.harmful ? "HARMFUL; " : "") + notes.join("; "),
  ].join(" ")
}

export function renderRecompute(r: RecomputeResult, decimals: number): string {
  const lines = [
    "Margin Rescue: recomputed from the actual execution",
    `  action              ${r.actionId}`,
    `  scenario            ${r.scenarioId}`,
    `  transaction         ${r.tx.hash ?? "none"}  ${r.tx.status}  block ${r.tx.blockNumber ?? "-"}  canonical ${r.tx.canonical ? "yes" : "no"}`,
    `  fill                ${r.fill.state}: ${qty(r.fill.filled, decimals)} of ${qty(r.fill.requested, decimals)} (expected ${qty(r.planned.expectedFill, decimals)}); unfilled ${qty(r.fill.unfilled, decimals)}`,
    `  fills               ${r.fill.fills.map((f) => `${qty(f.quantity, decimals)} @ ${usd(f.price, 4)}`).join(", ") || "none"}; all inside the limit: ${r.fill.priceBoundRespected ? "yes" : "NO"}`,
    `  ledger              realized ${usd(r.ledger.realizedPnl)}  funding settled ${usd(r.ledger.fundingSettled)}  fees ${usd(r.ledger.fees)}`,
  ]
  for (const c of r.ledger.checks) lines.push(`    ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` (expected ${c.expected}, observed ${c.observed})`}`)
  lines.push(
    `  external changes    ${r.externalChanges.length ? r.externalChanges.join("; ") : "none detected"}`,
    `  post reconciliation ${r.postReconciliation}`,
    "",
    `  baseline (scenario) ${valuationLine(r.baseline.scenario)}`,
    `  forecast (scenario) ${r.planned.scenario ? valuationLine(r.planned.scenario) : "-"}`,
    `  actual   (scenario) ${r.actual.scenario ? valuationLine(r.actual.scenario) : "not computable under this scenario"}`,
    `  actual health now   E_risk ${usd(r.actual.currentHealth.eRisk)}  MM ${usd(r.actual.currentHealth.mm)}  buffer ${usd(r.actual.currentHealth.buffer)} (at current marks)`,
    `  vs forecast         fill ${r.differences.fillVsForecast}  buffer ${r.differences.bufferVsForecast === null ? "-" : usd(r.differences.bufferVsForecast)}  funding drift on untouched legs ${usd(r.differences.untouchedLegsFundingDrift)}`,
    "",
    `GOAL: ${r.goal.state} (${r.goal.reason})`,
  )
  return lines.join("\n") + "\n"
}
