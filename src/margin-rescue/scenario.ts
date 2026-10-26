// An immutable, versioned price scenario and the static valuation of a portfolio
// under it.
//
// The scenario fixes an ABSOLUTE price for every market the account holds at the
// reference block: BTC and ETH may be shocked; every other market keeps its reference
// mark. Any portfolio, the original or the one left after an action, is valued at
// those same prices with the frozen risk parameters. The shock is instantaneous and
// static: no price path, no stop or liquidation along the way, no further funding
// accrual (each portfolio carries the funding owed as of its own snapshot).
import { accountFigures, healthRatioBps, type AccountFigures, type PricedLeg } from "./math.js"
import { canonicalJson, sha256Hex } from "./json.js"
import { poolOf, sameAddress, type AccountSnapshot } from "./snapshot.js"
import type { Reconciliation } from "./reconcile.js"
import { fundingOwed } from "./math.js"

export const SCENARIO_VERSION = "mr-scenario/1"
export const MODEL_VERSION = "mr-model/1 (static shock; pnl floor, funding ceil, requirements ceil per leg)"
export const SHOCKABLE = ["BTC", "ETH"] as const

export interface ScenarioMarket {
  pool: string
  symbol: string
  baseDecimals: number
  oneBase: string
  referenceMark: string
  scenarioPrice: string
  shockBps: number | null // null when the price was given absolutely or left at reference
  // effectiveImfBps is market state (it scales with open interest) and only feeds the
  // IM figure; the configured rates below are what a later snapshot must still match.
  risk: { effectiveImfBps: string; initialMarginBps: string; maintenanceMarginBps: string; closeOutMarginBps: string; maxPositionSize: string }
  grid: { tickSize: string; minQuantity: string; lotSize: string }
  fees: { takerFeeBpsTimes1k: string; makerFeeBpsTimes1k: string }
}

export interface ScenarioBody {
  version: typeof SCENARIO_VERSION
  model: string
  chainId: number
  marginBank: string
  account: string
  reference: { blockNumber: string; blockHash: string; blockTimestamp: string }
  createdAt: string
  integrity: { reconciliation: string; snapshotProblems: string[] }
  shock: "instantaneous static"
  funding: "frozen: each portfolio keeps the funding owed as of its own snapshot; none accrues during the shock"
  numericBound: { perLegRawUnits: string; basis: string }
  markets: ScenarioMarket[]
  targetBuffer: string // raw USDso
  riskFingerprint: string
}

export interface Scenario extends ScenarioBody {
  id: string // sha256 of the canonical body
}

export interface ScenarioInput {
  shocksBps?: Record<string, number> // symbol -> signed bps, BTC/ETH only
  prices?: Record<string, bigint> // symbol -> absolute raw price, BTC/ETH only
  targetBuffer: bigint
  perLegBound?: bigint // proven numerical error per leg, raw units; 0 when the model is exact
  createdAt?: string
}

function riskFingerprint(markets: ScenarioMarket[]): string {
  return sha256Hex(
    canonicalJson(
      markets.map((m) => ({
        pool: m.pool.toLowerCase(),
        oneBase: m.oneBase,
        initialMarginBps: m.risk.initialMarginBps,
        maintenanceMarginBps: m.risk.maintenanceMarginBps,
        closeOutMarginBps: m.risk.closeOutMarginBps,
        maxPositionSize: m.risk.maxPositionSize,
        grid: m.grid,
        fees: m.fees,
      })),
    ),
  )
}

export function buildScenario(snapshot: AccountSnapshot, recon: Reconciliation, input: ScenarioInput): Scenario {
  for (const sym of [...Object.keys(input.shocksBps ?? {}), ...Object.keys(input.prices ?? {})]) {
    if (!SHOCKABLE.includes(sym.toUpperCase() as (typeof SHOCKABLE)[number])) throw new Error(`only ${SHOCKABLE.join(" and ")} can be shocked in this version (got ${sym})`)
  }
  const held = [...new Set(snapshot.positions.map((p) => p.pool.toLowerCase()))]
  const markets: ScenarioMarket[] = held
    .map((pool) => poolOf(snapshot, pool))
    .sort((a, b) => a.pool.toLowerCase().localeCompare(b.pool.toLowerCase()))
    .map((info) => {
      const sym = info.symbol.toUpperCase()
      const absolute = Object.entries(input.prices ?? {}).find(([k]) => k.toUpperCase() === sym)?.[1]
      const bps = Object.entries(input.shocksBps ?? {}).find(([k]) => k.toUpperCase() === sym)?.[1]
      if (absolute !== undefined && bps !== undefined) throw new Error(`${sym}: give a shock or a price, not both`)
      if (bps !== undefined && (!Number.isInteger(bps) || bps <= -10_000)) throw new Error(`${sym}: shock must be an integer number of bps above -10000`)
      const scenarioPrice = absolute ?? (bps !== undefined ? (info.markPrice * BigInt(10_000 + bps)) / 10_000n : info.markPrice)
      if (scenarioPrice <= 0n) throw new Error(`${sym}: scenario price must be positive`)
      return {
        pool: info.pool,
        symbol: info.symbol,
        baseDecimals: info.baseDecimals,
        oneBase: info.oneBase.toString(),
        referenceMark: info.markPrice.toString(),
        scenarioPrice: scenarioPrice.toString(),
        shockBps: bps ?? null,
        risk: {
          effectiveImfBps: info.effectiveImfBps.toString(),
          initialMarginBps: info.params.initialMarginBps.toString(),
          maintenanceMarginBps: info.maintenanceMarginBps.toString(),
          closeOutMarginBps: info.closeOutMarginBps.toString(),
          maxPositionSize: info.params.maxPositionSize.toString(),
        },
        grid: { tickSize: info.grid.tickSize.toString(), minQuantity: info.grid.minQuantity.toString(), lotSize: info.grid.lotSize.toString() },
        fees: { takerFeeBpsTimes1k: info.params.takerFeeBpsTimes1k.toString(), makerFeeBpsTimes1k: info.params.makerFeeBpsTimes1k.toString() },
      }
    })
  const body: ScenarioBody = {
    version: SCENARIO_VERSION,
    model: MODEL_VERSION,
    chainId: snapshot.chainId,
    marginBank: snapshot.marginBank,
    account: snapshot.account,
    reference: { blockNumber: snapshot.block.number.toString(), blockHash: snapshot.block.hash, blockTimestamp: snapshot.block.timestamp.toString() },
    createdAt: input.createdAt ?? new Date().toISOString(),
    integrity: { reconciliation: recon.verdict, snapshotProblems: [...snapshot.problems] },
    shock: "instantaneous static",
    funding: "frozen: each portfolio keeps the funding owed as of its own snapshot; none accrues during the shock",
    numericBound: {
      perLegRawUnits: (input.perLegBound ?? 0n).toString(),
      basis:
        (input.perLegBound ?? 0n) === 0n
          ? "deployment-exact: the reconstruction matched the bank to the raw unit at the reference block"
          : "caller-supplied bound per leg",
    },
    markets,
    targetBuffer: input.targetBuffer.toString(),
    riskFingerprint: riskFingerprint(markets),
  }
  return { ...body, id: scenarioId(body) }
}

export function scenarioId(body: ScenarioBody): string {
  return sha256Hex(canonicalJson(body))
}

// Recompute the id; a scenario edited after creation no longer matches it.
export function verifyScenarioId(s: Scenario): boolean {
  const { id, ...body } = s
  return scenarioId(body) === id
}

export interface PortfolioLeg {
  pool: string
  size: bigint
  avgEntryPrice: bigint
  fundingOwed: bigint
}

export interface Portfolio {
  unlocked: bigint
  locked: bigint
  legs: PortfolioLeg[]
}

// The portfolio a snapshot shows, with funding owed fixed at that snapshot.
export function portfolioOf(snapshot: AccountSnapshot): Portfolio {
  return {
    unlocked: snapshot.collateral.unlocked,
    locked: snapshot.collateral.locked,
    legs: snapshot.positions.map((p) => {
      const info = poolOf(snapshot, p.pool)
      return { pool: p.pool, size: p.size, avgEntryPrice: p.avgEntryPrice, fundingOwed: fundingOwed(p.size, p.entryFundingIndex, info.projectedCumulativeFunding, info.oneBase) }
    }),
  }
}

export interface ScenarioValuation extends AccountFigures {
  bufferLower: bigint
  bufferUpper: bigint
  healthRatioBps: bigint | null
}

function marketFor(s: Scenario, pool: string): ScenarioMarket {
  const m = s.markets.find((x) => sameAddress(x.pool, pool))
  if (!m) throw new ScenarioMismatchError(`market ${pool} is not part of scenario ${s.id.slice(0, 12)}; a new analysis is required`)
  return m
}

export class ScenarioMismatchError extends Error {}

export function pricedLegs(s: Scenario, portfolio: Portfolio, price: "scenario" | "reference"): PricedLeg[] {
  return portfolio.legs
    .filter((l) => l.size !== 0n)
    .map((l) => {
      const m = marketFor(s, l.pool)
      return {
        pool: l.pool,
        size: l.size,
        avgEntryPrice: l.avgEntryPrice,
        fundingOwed: l.fundingOwed,
        price: BigInt(price === "scenario" ? m.scenarioPrice : m.referenceMark),
        risk: {
          oneBase: BigInt(m.oneBase),
          initialMarginBps: BigInt(m.risk.effectiveImfBps),
          maintenanceMarginBps: BigInt(m.risk.maintenanceMarginBps),
          closeOutMarginBps: BigInt(m.risk.closeOutMarginBps),
        },
      }
    })
}

// Value at the scenario's absolute prices (or its reference marks). The numerical
// bound widens the buffer by the per-leg bound on equity and on MM separately.
export function valuePortfolio(s: Scenario, portfolio: Portfolio, price: "scenario" | "reference" = "scenario"): ScenarioValuation {
  const legs = pricedLegs(s, portfolio, price)
  const f = accountFigures(portfolio.unlocked, portfolio.locked, legs, "floor")
  const bound = BigInt(s.numericBound.perLegRawUnits) * BigInt(legs.length)
  return { ...f, bufferLower: f.buffer - 2n * bound, bufferUpper: f.buffer + 2n * bound, healthRatioBps: healthRatioBps(f.eRisk, f.mm) }
}

export type GoalStatus = "MEETS" | "FAILS" | "UNCERTAIN"

// Only a lower bound at or above the target counts as meeting it.
export function goalStatus(v: { bufferLower: bigint; bufferUpper: bigint }, target: bigint): GoalStatus {
  if (v.bufferLower >= target) return "MEETS"
  if (v.bufferUpper < target) return "FAILS"
  return "UNCERTAIN"
}

// Reasons a later snapshot cannot be valued under `s` without a new analysis.
export function scenarioCompatibility(s: Scenario, snapshot: AccountSnapshot): string[] {
  const reasons: string[] = []
  if (snapshot.chainId !== s.chainId) reasons.push(`chain ${snapshot.chainId} ≠ ${s.chainId}`)
  if (!sameAddress(snapshot.marginBank, s.marginBank)) reasons.push("different MarginBank")
  if (!sameAddress(snapshot.account, s.account)) reasons.push("different account")
  for (const p of snapshot.positions) {
    const m = s.markets.find((x) => sameAddress(x.pool, p.pool))
    if (!m) {
      reasons.push(`new market held since the scenario: ${poolOf(snapshot, p.pool).symbol}`)
      continue
    }
    const info = poolOf(snapshot, p.pool)
    const same =
      info.oneBase.toString() === m.oneBase &&
      info.params.initialMarginBps.toString() === m.risk.initialMarginBps &&
      info.params.maxPositionSize.toString() === m.risk.maxPositionSize &&
      info.maintenanceMarginBps.toString() === m.risk.maintenanceMarginBps &&
      info.closeOutMarginBps.toString() === m.risk.closeOutMarginBps &&
      info.grid.tickSize.toString() === m.grid.tickSize &&
      info.grid.lotSize.toString() === m.grid.lotSize &&
      info.grid.minQuantity.toString() === m.grid.minQuantity &&
      info.params.takerFeeBpsTimes1k.toString() === m.fees.takerFeeBpsTimes1k
    if (!same) reasons.push(`risk configuration of ${m.symbol} changed since the scenario`)
  }
  return reasons
}
