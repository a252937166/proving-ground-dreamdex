// LIVE, READ-ONLY test against the Somnia Hideki (Tokyo) testnet and the dreamDEX
// indexer. Needs network access. Sends no transactions and uses no key.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { createMarkets, EXPECTED_CHAIN_ID, loadConfig } from "../../src/config.js"
import { runPrecheck } from "../../src/order.js"
import { readSnapshot, type Snapshot } from "../../src/snapshot.js"
import { formatDecimal } from "../../src/units.js"

const cfg = loadConfig()
const markets = createMarkets(cfg)
let s: Snapshot

describe("live BTC-PERP snapshot", { timeout: 90_000 }, () => {
  before(async () => {
    s = await readSnapshot(markets, cfg)
    console.log(`# block ${s.block.number} (${s.block.isoTime}), pool ${s.market.poolAddress}, mark ${formatDecimal(s.mark.price, 18, 2)}`)
  })
  after(() => markets.client.stopLive())

  it("is on chain 50383", () => {
    assert.equal(s.chainId, EXPECTED_CHAIN_ID)
  })

  it("finds the BTC-PERP pool and it has contract code", async () => {
    assert.equal(s.market.symbol, "BTC-PERP")
    assert.match(s.market.poolAddress, /^0x[0-9a-fA-F]{40}$/)
    const code = await markets.client.getViemClient().getCode({ address: s.market.poolAddress })
    assert.ok(code && code.length > 2, "pool has no bytecode")
  })

  it("indexer market config matches the on-chain book parameters", () => {
    assert.equal(s.market.onchainBookParamsMatchIndexer, true)
    assert.ok(s.market.tickSize > 0n && s.market.lotSize > 0n && s.market.minQuantity >= s.market.lotSize)
  })

  it("reads a live mark price at the book's block", () => {
    assert.equal(s.mark.ok, true)
    assert.ok(s.mark.price > 0n)
    assert.equal(s.block.bookBlockKnown, true)
  })

  it("block time is close to local time", () => {
    const skew = Math.abs(Date.now() / 1000 - s.block.timestamp)
    assert.ok(skew < 300, `block is ${skew}s away from local time`)
  })

  it("book is non-empty, uncrossed, sorted and on the tick/lot grid", () => {
    const { bids, asks } = s.book
    assert.ok(bids.length > 0 && asks.length > 0, "empty book side")
    assert.ok(bids[0].price < asks[0].price, "crossed book")
    for (let i = 1; i < bids.length; i++) assert.ok(bids[i].price < bids[i - 1].price, "bids not descending")
    for (let i = 1; i < asks.length; i++) assert.ok(asks[i].price > asks[i - 1].price, "asks not ascending")
    for (const l of [...bids, ...asks]) {
      assert.equal(l.price % s.market.tickSize, 0n)
      assert.equal(l.quantity % s.market.lotSize, 0n)
    }
  })

  it("mark is within 5% of the mid (sanity)", () => {
    assert.ok(s.derived.mid !== null)
    assert.ok(Math.abs(s.derived.markVsMidBps ?? Infinity) < 500)
  })

  it("runs the local pre-check on live data", () => {
    const qty = formatDecimal(s.market.minQuantity, s.market.baseDecimals)
    for (const side of ["buy", "sell"] as const) {
      const run = runPrecheck(s, { side, qty })
      assert.ok(["ADMIT", "REJECT"].includes(run.result.verdict))
      assert.equal(run.result.classification, "RISK_INCREASING")
      // Venue-format checks must pass for the touch price and the minimum size.
      for (const rule of ["MARK_AVAILABLE", "TICK_SIZE", "LOT_SIZE", "MIN_QUANTITY"]) {
        assert.equal(run.result.checks.find((c) => c.rule === rule)?.status, "pass", `${side} ${rule}`)
      }
    }
  })
})
