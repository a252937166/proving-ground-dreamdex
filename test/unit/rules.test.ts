// Unit tests for the local v2.2 Blitz pre-check. FIXTURE DATA ONLY: no network.
// The fixture market mirrors BTC-PERP's parameters with a round 100,000 mark so
// the ±0.2% band edges are exact (99,800.0 and 100,200.0).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BLITZ, bandEdges, classify, precheck, withinBand, type MarketRules, type PrecheckInput } from "../../src/rules.js"
import { parseDecimal } from "../../src/units.js"

const market: MarketRules = {
  tickSize: 10n ** 17n, // 0.1 USDso
  lotSize: 1_000n, // 0.00001 BTC
  minQuantity: 13_000n, // 0.00013 BTC
  baseDecimals: 8,
  maxPositionSize: 10_000_000_000n, // 100 BTC
  takerFeeBpsTimes1k: 0n,
}
const P = (s: string) => parseDecimal(s, 18, { signed: true })
const Q = (s: string) => parseDecimal(s, 8, { signed: true })
const MARK = P("100000")

function order(o: { side: "buy" | "sell"; qty: string; price?: string; position?: string; equity?: string; markOk?: boolean }): PrecheckInput {
  return {
    side: o.side,
    quantity: Q(o.qty),
    price: P(o.price ?? "100000"),
    positionSize: Q(o.position ?? "0"),
    equity: P(o.equity ?? "1000"),
    mark: MARK,
    markOk: o.markOk ?? true,
  }
}
const status = (r: ReturnType<typeof precheck>, rule: string) => r.checks.find((c) => c.rule === rule)?.status

describe("classify", () => {
  it("treats any order from flat as risk-increasing", () => {
    assert.equal(classify("buy", Q("0.01"), 0n), "RISK_INCREASING")
    assert.equal(classify("sell", Q("0.01"), 0n), "RISK_INCREASING")
  })
  it("treats a same-side order as risk-increasing", () => {
    assert.equal(classify("buy", Q("0.01"), Q("0.02")), "RISK_INCREASING")
    assert.equal(classify("sell", Q("0.01"), Q("-0.02")), "RISK_INCREASING")
  })
  it("treats an opposite-side order up to |position| as reducing, including closing to zero", () => {
    assert.equal(classify("sell", Q("0.01"), Q("0.02")), "REDUCING")
    assert.equal(classify("sell", Q("0.02"), Q("0.02")), "REDUCING")
    assert.equal(classify("buy", Q("0.02"), Q("-0.02")), "REDUCING")
  })
  it("treats an opposite-side order larger than |position| as a reversal", () => {
    assert.equal(classify("sell", Q("0.02001"), Q("0.02")), "REVERSAL")
    assert.equal(classify("buy", Q("0.03"), Q("-0.02")), "REVERSAL")
  })
})

describe("price band (±0.2% of mark, inclusive)", () => {
  it("computes exact tick-aligned edges", () => {
    assert.deepEqual(bandEdges(MARK, market.tickSize), { low: P("99800"), high: P("100200") })
  })
  it("admits the edges and rejects one tick beyond", () => {
    assert.equal(withinBand(P("100200"), MARK), true)
    assert.equal(withinBand(P("100200.1"), MARK), false)
    assert.equal(withinBand(P("99800"), MARK), true)
    assert.equal(withinBand(P("99799.9"), MARK), false)
  })
  it("keeps edges inside the band for an irregular mark", () => {
    const mark = P("83484.217744198300000001")
    const { low, high } = bandEdges(mark, market.tickSize)
    assert.equal(low % market.tickSize, 0n)
    assert.equal(high % market.tickSize, 0n)
    assert.equal(withinBand(low, mark), true)
    assert.equal(withinBand(high, mark), true)
    assert.equal(withinBand(low - market.tickSize, mark), false)
    assert.equal(withinBand(high + market.tickSize, mark), false)
  })
  it("rejects an out-of-band limit with the planned BAND error", () => {
    const r = precheck(order({ side: "buy", qty: "0.01", price: "100200.1" }), market)
    assert.equal(r.verdict, "REJECT")
    assert.deepEqual(r.failed, ["PRICE_BAND"])
    assert.equal(r.checks.find((c) => c.rule === "PRICE_BAND")?.plannedError, "PreTradeViolation(BAND)")
  })
})

describe("venue order format", () => {
  it("rejects a price off the tick grid", () => {
    assert.deepEqual(precheck(order({ side: "buy", qty: "0.01", price: "100000.05" }), market).failed, ["TICK_SIZE"])
  })
  it("rejects a quantity off the lot grid", () => {
    assert.deepEqual(precheck(order({ side: "buy", qty: "0.000135" }), market).failed, ["LOT_SIZE"])
  })
  it("rejects a quantity below the minimum and accepts exactly the minimum", () => {
    assert.deepEqual(precheck(order({ side: "buy", qty: "0.00012" }), market).failed, ["MIN_QUANTITY"])
    assert.equal(precheck(order({ side: "buy", qty: "0.00013" }), market).verdict, "ADMIT")
  })
  it("rejects a zero quantity", () => {
    const r = precheck(order({ side: "buy", qty: "0" }), market)
    assert.ok(r.failed.includes("LOT_SIZE") && r.failed.includes("MIN_QUANTITY"))
  })
  it("rejects a position that would exceed the venue maximum", () => {
    const r = precheck(order({ side: "buy", qty: "0.02", position: "99.99", equity: "100000000" }), market)
    assert.deepEqual(r.failed, ["MAX_POSITION_SIZE"])
  })
})

describe("risk-increasing admission (5x, equity >= 950)", () => {
  it("admits exactly 5x and rejects one lot more", () => {
    const at = precheck(order({ side: "buy", qty: "0.05" }), market)
    assert.equal(at.estimate.postLeverageX1000, 5_000n)
    assert.equal(at.verdict, "ADMIT")
    const over = precheck(order({ side: "buy", qty: "0.05001" }), market)
    assert.deepEqual(over.failed, ["LEVERAGE_AFTER"])
    assert.equal(over.checks.find((c) => c.rule === "LEVERAGE_AFTER")?.plannedError, "PostTradeViolation")
  })
  it("counts the fill cost against equity: 4.98x at mark becomes > 5x at the band edge", () => {
    const r = precheck(order({ side: "buy", qty: "0.0498", price: "100200" }), market)
    assert.equal(r.estimate.markToMarket, -P("9.96"))
    assert.equal(r.estimate.postEquity, P("990.04"))
    assert.deepEqual(r.failed, ["LEVERAGE_AFTER"])
  })
  it("rejects when equity is already below the threshold", () => {
    const r = precheck(order({ side: "buy", qty: "0.01", equity: "949.9999" }), market)
    assert.ok(r.failed.includes("EQUITY_BEFORE"))
    assert.equal(r.checks.find((c) => c.rule === "EQUITY_BEFORE")?.plannedError, "PreTradeViolation(EQUITY_BELOW_THRESHOLD)")
    assert.equal(precheck(order({ side: "buy", qty: "0.01", equity: "950" }), market).verdict, "ADMIT")
  })
  it("rejects when the worst-case fill would take equity below the threshold", () => {
    const r = precheck(order({ side: "buy", qty: "0.04", price: "100200", equity: "951" }), market)
    assert.equal(r.estimate.postEquity, P("943"))
    assert.deepEqual(r.failed, ["EQUITY_AFTER"])
  })
  it("charges the taker fee", () => {
    const r = precheck(order({ side: "buy", qty: "0.01" }), { ...market, takerFeeBpsTimes1k: 5_000n }) // 5 bps
    assert.equal(r.estimate.fee, P("0.5"))
    assert.equal(r.estimate.postEquity, P("999.5"))
  })
  it("treats a short the same way", () => {
    const r = precheck(order({ side: "sell", qty: "0.05", price: "99800" }), market)
    assert.equal(r.classification, "RISK_INCREASING")
    assert.equal(r.estimate.newSize, -Q("0.05"))
    assert.deepEqual(r.failed, ["LEVERAGE_AFTER"])
  })
})

describe("genuine reducing orders", () => {
  it("are exempt from the leverage limit: a 6x position may be cut to 5.5x", () => {
    const r = precheck(order({ side: "sell", qty: "0.005", position: "0.06" }), market)
    assert.equal(r.classification, "REDUCING")
    assert.equal(r.estimate.postLeverageX1000, 5_500n)
    assert.equal(r.verdict, "ADMIT")
    assert.equal(status(r, "LEVERAGE_AFTER"), "exempt")
  })
  it("commit even when the realised loss crosses the floor, then breach", () => {
    const r = precheck(order({ side: "sell", qty: "0.05", price: "99800", position: "0.05", equity: "952" }), market)
    assert.equal(r.estimate.postEquity, P("942"))
    assert.equal(r.estimate.newSize, 0n)
    assert.equal(r.verdict, "ADMIT_THEN_BREACH")
  })
  it("are allowed below the threshold where a risk-increasing order is not", () => {
    const reduce = precheck(order({ side: "sell", qty: "0.01", position: "0.02", equity: "900" }), market)
    assert.equal(reduce.verdict, "ADMIT_THEN_BREACH")
    const increase = precheck(order({ side: "buy", qty: "0.01", position: "0.02", equity: "900" }), market)
    assert.equal(increase.verdict, "REJECT")
    assert.ok(increase.failed.includes("EQUITY_BEFORE"))
  })
  it("still have to respect the price band", () => {
    const r = precheck(order({ side: "buy", qty: "0.01", price: "100300", position: "-0.02" }), market)
    assert.equal(r.classification, "REDUCING")
    assert.deepEqual(r.failed, ["PRICE_BAND"])
  })
})

describe("prohibited reversal", () => {
  it("is rejected with the planned ReversalNotAllowed error", () => {
    const r = precheck(order({ side: "sell", qty: "0.02", position: "0.01" }), market)
    assert.equal(r.classification, "REVERSAL")
    assert.deepEqual(r.failed, ["NO_REVERSAL"])
    assert.equal(r.checks.find((c) => c.rule === "NO_REVERSAL")?.plannedError, "ReversalNotAllowed")
    assert.equal(status(r, "LEVERAGE_AFTER"), undefined)
  })
})

describe("mark unavailable", () => {
  it("rejects without evaluating mark-dependent rules", () => {
    const r = precheck(order({ side: "buy", qty: "0.01", markOk: false }), market)
    assert.equal(r.verdict, "REJECT")
    assert.deepEqual(r.failed, ["MARK_AVAILABLE"])
    assert.equal(r.band, null)
    assert.equal(status(r, "PRICE_BAND"), undefined)
    assert.equal(status(r, "LEVERAGE_AFTER"), undefined)
  })
})

describe("published constants", () => {
  it("match the v2.2 Blitz table", () => {
    assert.equal(BLITZ.allocation, P("1000"))
    assert.equal(BLITZ.breachThreshold, P("950"))
    assert.equal(BLITZ.passTarget, P("1030"))
    assert.equal(BLITZ.maxLeverageX1000, 5_000n)
    assert.equal(BLITZ.priceBandBps, 20n)
    assert.equal(BLITZ.durationSec, 3_600)
  })
})
