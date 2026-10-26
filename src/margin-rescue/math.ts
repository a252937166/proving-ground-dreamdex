// Exact integer arithmetic of the deployed MarginBank's account health.
//
// Verified against the bank itself (see `rounding-study` and evidence/margin-rescue):
// per leg, notional floors, unrealized PnL floors toward −∞, funding owed ceils toward
// +∞, and IM / MM / CM each ceil on the floored notional. The SDK's
// perpPositionAnalytics truncates PnL toward zero instead; on the deployment that is
// one raw unit too high for every leg whose PnL quotient is negative and inexact.
// Nothing here uses floating point.

export const FUNDING_PRECISION = 10n ** 18n
export const BPS = 10_000n
export const FEE_DENOMINATOR = 10_000_000n // fee rates are bps × 1000

export type PnlRounding = "floor" | "trunc"

export const abs = (x: bigint) => (x < 0n ? -x : x)

export function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q
}

export function divCeilSigned(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b !== 0n && a < 0n === b < 0n ? q + 1n : q
}

// Ceiling of a non-negative quotient (the protocol's divCeil).
export function divCeil(a: bigint, b: bigint): bigint {
  if (a < 0n) throw new Error("divCeil takes a non-negative numerator")
  return a === 0n ? 0n : (a - 1n) / b + 1n
}

export interface MarketRisk {
  oneBase: bigint
  initialMarginBps: bigint // the effective (OI-scaled) IMF used by health
  maintenanceMarginBps: bigint
  closeOutMarginBps: bigint
}

export interface LegState {
  size: bigint // signed raw base units
  avgEntryPrice: bigint
}

export function unrealizedPnl(leg: LegState, mark: bigint, oneBase: bigint, rounding: PnlRounding = "floor"): bigint {
  if (leg.size === 0n) return 0n
  const numerator = (mark - leg.avgEntryPrice) * leg.size
  return rounding === "floor" ? divFloor(numerator, oneBase) : numerator / oneBase
}

// True when floor and truncation disagree for this leg (a negative, inexact quotient).
export function pnlRoundsDifferently(leg: LegState, mark: bigint, oneBase: bigint): boolean {
  const numerator = (mark - leg.avgEntryPrice) * leg.size
  return numerator < 0n && numerator % oneBase !== 0n
}

// Funding owed since the leg's entry index; positive means the account pays.
export function fundingOwed(size: bigint, entryFundingIndex: bigint, cumulativeFunding: bigint, oneBase: bigint): bigint {
  if (size === 0n) return 0n
  return divCeilSigned(size * (cumulativeFunding - entryFundingIndex), FUNDING_PRECISION * oneBase)
}

export function notional(size: bigint, price: bigint, oneBase: bigint): bigint {
  return (abs(size) * price) / oneBase
}

export function requirement(notionalValue: bigint, bps: bigint): bigint {
  return divCeil(notionalValue * bps, BPS)
}

// A leg priced at `price`, with funding owed already fixed by the caller.
export interface PricedLeg {
  pool: string
  size: bigint
  avgEntryPrice: bigint
  fundingOwed: bigint
  price: bigint
  risk: MarketRisk
}

export interface LegFigures {
  pool: string
  size: bigint
  price: bigint
  notional: bigint
  unrealizedPnl: bigint
  fundingOwed: bigint
  contribution: bigint // unrealizedPnl − fundingOwed
  im: bigint
  mm: bigint
  cm: bigint
  pnlRoundsDifferently: boolean
}

export function legFigures(leg: PricedLeg, rounding: PnlRounding = "floor"): LegFigures {
  const n = notional(leg.size, leg.price, leg.risk.oneBase)
  const pnl = unrealizedPnl(leg, leg.price, leg.risk.oneBase, rounding)
  return {
    pool: leg.pool,
    size: leg.size,
    price: leg.price,
    notional: n,
    unrealizedPnl: pnl,
    fundingOwed: leg.fundingOwed,
    contribution: pnl - leg.fundingOwed,
    im: requirement(n, leg.risk.initialMarginBps),
    mm: requirement(n, leg.risk.maintenanceMarginBps),
    cm: requirement(n, leg.risk.closeOutMarginBps),
    pnlRoundsDifferently: leg.size !== 0n && pnlRoundsDifferently(leg, leg.price, leg.risk.oneBase),
  }
}

export interface AccountFigures {
  unlocked: bigint
  locked: bigint
  eRisk: bigint // unlocked + Σ PnL − Σ funding owed: the bank's health equity
  eTotal: bigint // eRisk + locked
  im: bigint
  mm: bigint
  cm: bigint
  buffer: bigint // eRisk − mm
  notional: bigint
  legs: LegFigures[]
}

export function accountFigures(unlocked: bigint, locked: bigint, legs: PricedLeg[], rounding: PnlRounding = "floor"): AccountFigures {
  const figures = legs.map((l) => legFigures(l, rounding))
  const sum = (pick: (f: LegFigures) => bigint) => figures.reduce((s, f) => s + pick(f), 0n)
  const eRisk = unlocked + sum((f) => f.contribution)
  const mm = sum((f) => f.mm)
  return {
    unlocked,
    locked,
    eRisk,
    eTotal: eRisk + locked,
    im: sum((f) => f.im),
    mm,
    cm: sum((f) => f.cm),
    buffer: eRisk - mm,
    notional: sum((f) => f.notional),
    legs: figures,
  }
}

// E_risk / MM in bps of 1x, floored. Not applicable (null) when MM is zero.
export function healthRatioBps(eRisk: bigint, mm: bigint): bigint | null {
  return mm === 0n ? null : divFloor(eRisk * BPS, mm)
}

// A fee on one fill: the pool charges the rate on the fill's floored notional.
export function fillFee(quantity: bigint, price: bigint, oneBase: bigint, feeBpsTimes1k: bigint): bigint {
  const n = (quantity * price) / oneBase
  return feeBpsTimes1k >= 0n ? (n * feeBpsTimes1k) / FEE_DENOMINATOR : -((n * -feeBpsTimes1k) / FEE_DENOMINATOR)
}

// Realized PnL on closing `quantity` of a position at `price` (MarginBank
// _realizedPnlForClose): floored toward −∞, per fill.
export function realizedPnl(size: bigint, avgEntryPrice: bigint, quantity: bigint, price: bigint, oneBase: bigint): bigint {
  const sign = size > 0n ? 1n : -1n
  return divFloor((price - avgEntryPrice) * sign * quantity, oneBase)
}
