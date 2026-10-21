// Proving Ground v2.2 "Blitz" order rules, evaluated LOCALLY (off-chain).
//
// No Proving Ground contract is deployed. This module mirrors the checks the
// planned ChallengeAccount is designed to run, so an order can be inspected
// against live market data first. A result here is a local calculation, not
// evidence that anything is enforced on-chain.
import { PRICE_DECIMALS, USD_DECIMALS, absBig, formatDecimal, notional } from "./units.js"

const E18 = 10n ** 18n

export const BLITZ = {
  market: "BTC-PERP",
  orderType: "IOC",
  allocation: 1_000n * E18,
  breachThreshold: 950n * E18,
  passTarget: 1_030n * E18,
  maxLeverageX1000: 5_000n,
  priceBandBps: 20n,
  durationSec: 3_600,
} as const

export type Side = "buy" | "sell"
export type OrderClass = "RISK_INCREASING" | "REDUCING" | "REVERSAL"
export type Verdict = "ADMIT" | "ADMIT_THEN_BREACH" | "REJECT"

export interface MarketRules {
  tickSize: bigint
  lotSize: bigint
  minQuantity: bigint
  baseDecimals: number
  maxPositionSize: bigint
  takerFeeBpsTimes1k: bigint
}

export interface PrecheckInput {
  side: Side
  price: bigint // IOC limit price, 18 decimals
  quantity: bigint // base units
  positionSize: bigint // hypothetical current position, signed base units
  equity: bigint // hypothetical current equity at mark, USDso 18 decimals
  mark: bigint
  markOk: boolean
}

export interface Check {
  rule: string
  source: "venue" | "blitz"
  status: "pass" | "fail" | "exempt"
  detail: string
  // The revert the planned contract would raise; undefined for venue rules.
  plannedError?: string
}

export interface Estimate {
  newSize: bigint
  fillNotional: bigint
  fee: bigint
  markToMarket: bigint
  postEquity: bigint
  postNotional: bigint
  postLeverageX1000: bigint | null
}

export interface PrecheckResult {
  classification: OrderClass
  verdict: Verdict
  failed: string[]
  checks: Check[]
  band: { low: bigint; high: bigint } | null
  estimate: Estimate
}

export function classify(side: Side, quantity: bigint, positionSize: bigint): OrderClass {
  if (positionSize === 0n) return "RISK_INCREASING"
  const sameSide = (side === "buy") === positionSize > 0n
  if (sameSide) return "RISK_INCREASING"
  return quantity <= absBig(positionSize) ? "REDUCING" : "REVERSAL"
}

// Tick-aligned prices that still satisfy |price - mark| <= bandBps of mark.
export function bandEdges(mark: bigint, tickSize: bigint, bandBps: bigint = BLITZ.priceBandBps) {
  const hiRaw = (mark * (10_000n + bandBps)) / 10_000n
  const loNum = mark * (10_000n - bandBps)
  const loRaw = (loNum + 9_999n) / 10_000n
  return { low: ((loRaw + tickSize - 1n) / tickSize) * tickSize, high: (hiRaw / tickSize) * tickSize }
}

export function withinBand(price: bigint, mark: bigint, bandBps: bigint = BLITZ.priceBandBps): boolean {
  return absBig(price - mark) * 10_000n <= bandBps * mark
}

// Worst case for the order: a full fill at the limit price with the mark
// unchanged. An IOC cannot fill worse than its limit, and for a risk-increasing
// order a larger fill only raises leverage, so this bounds the post-trade state.
export function estimate(input: PrecheckInput, market: MarketRules): Estimate {
  const { side, price, quantity, positionSize, equity, mark } = input
  const fillNotional = notional(quantity, price, market.baseDecimals)
  const atMark = notional(quantity, mark, market.baseDecimals)
  const fee = (fillNotional * market.takerFeeBpsTimes1k) / 10_000_000n
  const markToMarket = side === "buy" ? atMark - fillNotional : fillNotional - atMark
  const postEquity = equity + markToMarket - fee
  const newSize = positionSize + (side === "buy" ? quantity : -quantity)
  const postNotional = notional(absBig(newSize), mark, market.baseDecimals)
  const postLeverageX1000 = postEquity > 0n ? (postNotional * 1_000n) / postEquity : null
  return { newSize, fillNotional, fee, markToMarket, postEquity, postNotional, postLeverageX1000 }
}

export function precheck(input: PrecheckInput, market: MarketRules, rules = BLITZ): PrecheckResult {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)
  const pass = (ok: boolean): Check["status"] => (ok ? "pass" : "fail")
  const { price, quantity, equity, mark } = input

  const fp = (v: bigint) => formatDecimal(v, PRICE_DECIMALS, 2)
  const fu = (v: bigint) => formatDecimal(v, USD_DECIMALS, 4)
  const fq = (v: bigint) => `${formatDecimal(v, market.baseDecimals)} BTC`

  const markOk = input.markOk && mark > 0n
  add({ rule: "MARK_AVAILABLE", source: "venue", status: pass(markOk), detail: markOk ? `on-chain mark ${fp(mark)} is readable` : "mark price unavailable; the order would revert" })
  add({ rule: "TICK_SIZE", source: "venue", status: pass(price > 0n && price % market.tickSize === 0n), detail: `limit ${fp(price)} must be a positive multiple of ${fp(market.tickSize)}` })
  add({ rule: "LOT_SIZE", source: "venue", status: pass(quantity > 0n && quantity % market.lotSize === 0n), detail: `quantity ${fq(quantity)} must be a positive multiple of ${fq(market.lotSize)}` })
  add({ rule: "MIN_QUANTITY", source: "venue", status: pass(quantity >= market.minQuantity), detail: `quantity must be at least ${fq(market.minQuantity)}` })

  const classification = classify(input.side, quantity, input.positionSize)
  const est = estimate(input, market)
  const band = markOk ? bandEdges(mark, market.tickSize, rules.priceBandBps) : null

  if (band) {
    add({ rule: "PRICE_BAND", source: "blitz", status: pass(withinBand(price, mark, rules.priceBandBps)), detail: `limit ${fp(price)} must be within ${fp(band.low)} .. ${fp(band.high)} (±${Number(rules.priceBandBps) / 100}% of mark)`, plannedError: "PreTradeViolation(BAND)" })
  }
  add({ rule: "NO_REVERSAL", source: "blitz", status: pass(classification !== "REVERSAL"), detail: `an opposite-side order may not exceed |position| ${fq(absBig(input.positionSize))}; close to zero first`, plannedError: "ReversalNotAllowed" })

  if (classification === "RISK_INCREASING") {
    add({ rule: "MAX_POSITION_SIZE", source: "venue", status: pass(absBig(est.newSize) <= market.maxPositionSize), detail: `|position| after the fill ${fq(absBig(est.newSize))} must not exceed ${fq(market.maxPositionSize)}` })
    add({ rule: "EQUITY_BEFORE", source: "blitz", status: pass(equity >= rules.breachThreshold), detail: `equity ${fu(equity)} must be at least the threshold ${fu(rules.breachThreshold)} USDso`, plannedError: "PreTradeViolation(EQUITY_BELOW_THRESHOLD)" })
    if (markOk) {
      const levOk = est.postEquity > 0n && est.postNotional * 1_000n <= rules.maxLeverageX1000 * est.postEquity
      const lev = est.postLeverageX1000 === null ? "unbounded" : `${Number(est.postLeverageX1000) / 1000}x`
      add({ rule: "LEVERAGE_AFTER", source: "blitz", status: pass(levOk), detail: `worst-case leverage after ${lev} must be at most ${Number(rules.maxLeverageX1000) / 1000}x`, plannedError: "PostTradeViolation" })
      add({ rule: "EQUITY_AFTER", source: "blitz", status: pass(est.postEquity >= rules.breachThreshold), detail: `worst-case equity after ${fu(est.postEquity)} must be at least ${fu(rules.breachThreshold)} USDso`, plannedError: "PostTradeViolation" })
    }
  } else if (classification === "REDUCING") {
    for (const rule of ["EQUITY_BEFORE", "LEVERAGE_AFTER", "EQUITY_AFTER"]) {
      add({ rule, source: "blitz", status: "exempt", detail: "a genuine reducing order is exempt; it commits even below the threshold" })
    }
  }

  const failed = checks.filter((c) => c.status === "fail").map((c) => c.rule)
  let verdict: Verdict = failed.length ? "REJECT" : "ADMIT"
  if (verdict === "ADMIT" && classification === "REDUCING" && est.postEquity < rules.breachThreshold) verdict = "ADMIT_THEN_BREACH"
  return { classification, verdict, failed, checks, band, estimate: est }
}
