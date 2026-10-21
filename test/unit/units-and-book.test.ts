// Unit tests for fixed-point helpers and derived book figures. FIXTURE DATA ONLY: no network.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveBook } from "../../src/snapshot.js"
import { formatDecimal, notional, parseDecimal } from "../../src/units.js"
import { defaultLimit, runPrecheck } from "../../src/order.js"
import type { Snapshot } from "../../src/snapshot.js"

const P = (s: string) => parseDecimal(s, 18)

describe("parseDecimal", () => {
  it("parses exactly", () => {
    assert.equal(parseDecimal("0.01", 8), 1_000_000n)
    assert.equal(parseDecimal(" 2.5 ", 18), 2_500_000_000_000_000_000n)
    assert.equal(parseDecimal("-0.5", 8, { signed: true }), -50_000_000n)
  })
  it("refuses to round or guess", () => {
    assert.throws(() => parseDecimal("0.123456789", 8), /more than 8 decimal places/)
    assert.throws(() => parseDecimal("-1", 8), /negative/)
    assert.throws(() => parseDecimal("1e3", 8), /not a decimal/)
    assert.throws(() => parseDecimal("", 8), /not a decimal/)
  })
})

describe("formatDecimal and notional", () => {
  it("formats with grouping and trimmed zeros", () => {
    assert.equal(formatDecimal(83_484_210_000_000_000_000_000n, 18, 2), "83,484.21")
    assert.equal(formatDecimal(-1_500_000n, 8), "-0.015")
    assert.equal(formatDecimal(0n, 18), "0")
  })
  it("computes USDso notional from base units", () => {
    assert.equal(notional(1_000_000n, P("100000"), 8), P("1000")) // 0.01 BTC at 100,000
  })
})

describe("deriveBook", () => {
  const tick = 10n ** 17n
  const mark = P("100000")
  const bids = [
    { price: P("99900"), quantity: 2_000_000n },
    { price: P("99800"), quantity: 1_000_000n },
    { price: P("99700"), quantity: 5_000_000n },
  ]
  const asks = [
    { price: P("100100"), quantity: 3_000_000n },
    { price: P("100200"), quantity: 1_000_000n },
    { price: P("100300"), quantity: 9_000_000n },
  ]
  it("computes top of book, spread and band depth", () => {
    const d = deriveBook(bids, asks, mark, tick)
    assert.equal(d.bestBid?.price, P("99900"))
    assert.equal(d.bestAsk?.price, P("100100"))
    assert.equal(d.mid, P("100000"))
    assert.equal(d.spread, P("200"))
    assert.equal(d.spreadBps, 20)
    assert.equal(d.markVsMidBps, 0)
    assert.equal(d.bestAskWithinBand, true)
    assert.equal(d.bestBidWithinBand, true)
    assert.equal(d.askQtyWithinBand, 4_000_000n) // 100,100 and 100,200 are inside; 100,300 is not
    assert.equal(d.bidQtyWithinBand, 3_000_000n)
  })
  it("reports when the top of book is outside the band", () => {
    const d = deriveBook(bids, [{ price: P("100250"), quantity: 1n }], mark, tick)
    assert.equal(d.bestAskWithinBand, false)
    assert.equal(d.askQtyWithinBand, 0n)
  })
  it("handles an empty side", () => {
    const d = deriveBook([], asks, mark, tick)
    assert.equal(d.bestBid, null)
    assert.equal(d.mid, null)
    assert.equal(d.bestBidWithinBand, null)
  })
})

describe("runPrecheck input handling", () => {
  // Fixture: mark 100,000, so the band is 99,800 .. 100,200.
  const make = (bid: string, ask: string) =>
    ({
      market: { baseDecimals: 8, tickSize: 10n ** 17n, lotSize: 1_000n, minQuantity: 13_000n, risk: { maxPositionSize: 10n ** 10n, takerFeeBpsTimes1k: 0n } },
      mark: { price: P("100000"), ok: true },
      derived: { bestBid: { price: P(bid), quantity: 1n }, bestAsk: { price: P(ask), quantity: 1n }, band: { bps: 20, low: P("99800"), high: P("100200") } },
    }) as unknown as Snapshot
  const snapshot = make("99990", "100010")

  it("defaults the limit to the touch and the account to a fresh 1,000 USDso run", () => {
    const buy = runPrecheck(snapshot, { side: "buy", qty: "0.01" })
    assert.equal(buy.input.price, P("100010"))
    assert.equal(buy.priceSource, "best ask")
    assert.equal(buy.input.equity, P("1000"))
    assert.equal(buy.input.positionSize, 0n)
    assert.equal(runPrecheck(snapshot, { side: "SELL", qty: "0.01" }).input.price, P("99990"))
  })
  it("uses the band edge when it still reaches a touch beyond the band", () => {
    const high = make("100300", "100301") // book above the band: sells can reach the bid from 100,200
    assert.deepEqual(defaultLimit(high, "sell"), { price: P("100200"), priceSource: "band high; reaches the best bid" })
    assert.equal(runPrecheck(high, { side: "sell", qty: "0.01" }).result.verdict, "ADMIT")
    const low = make("99699", "99700") // book below the band: buys can reach the ask from 99,800
    assert.deepEqual(defaultLimit(low, "buy"), { price: P("99800"), priceSource: "band low; reaches the best ask" })
  })
  it("keeps the touch price when no in-band limit can reach it, so the band check fails", () => {
    const high = make("100300", "100301")
    assert.deepEqual(defaultLimit(high, "buy"), { price: P("100301"), priceSource: "best ask, above the band" })
    assert.deepEqual(runPrecheck(high, { side: "buy", qty: "0.01" }).result.failed, ["PRICE_BAND"])
    const low = make("99699", "99700")
    assert.deepEqual(defaultLimit(low, "sell"), { price: P("99699"), priceSource: "best bid, below the band" })
  })
  it("uses a given price as is", () => {
    const run = runPrecheck(snapshot, { side: "buy", qty: "0.01", price: "100000.1" })
    assert.equal(run.input.price, P("100000.1"))
    assert.equal(run.priceSource, "given")
  })
  it("rejects bad input", () => {
    assert.throws(() => runPrecheck(snapshot, { side: "long", qty: "0.01" }), /side/)
    assert.throws(() => runPrecheck(snapshot, { side: "buy" }), /qty is required/)
    assert.throws(() => runPrecheck(snapshot, { side: "buy", qty: "0.000000001" }), /decimal places/)
  })
})
