// Finite candidate evaluation. SYNTHETIC FIXTURES ONLY: no network.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { analyzeCandidates } from "../../src/margin-rescue/candidates.js"
import { reconcile } from "../../src/margin-rescue/reconcile.js"
import { buildScenario } from "../../src/margin-rescue/scenario.js"
import { protectiveLimit, simulateIoc } from "../../src/margin-rescue/book.js"
import { fixtureSnapshot } from "./mr-fixtures.js"
import { parseDecimal } from "../../src/units.js"

const U = 10n ** 18n
const B = 10n ** 8n // BTC base unit
const usd = (amount: string) => parseDecimal(amount, 18, { signed: true })

// A hedged account: BTC long 0.08 (notional 8) and ETH short 0.03 (notional 3) at a
// synthetic price of 100, books at exactly the mark so reductions are cost-free, MM 2.5%.
function hedged(
  opts: { unlocked?: bigint; locked?: bigint; btcBids?: bigint; orders?: Parameters<typeof fixtureSnapshot>[0]["orders"]; problems?: string[]; lot?: bigint; min?: bigint } = {},
) {
  return fixtureSnapshot({
    unlocked: opts.unlocked ?? usd("6"),
    locked: opts.locked,
    markets: [
      {
        symbol: "BTC",
        decimals: 8,
        mark: 100n * U,
        mmBps: 250n,
        tick: U / 10n,
        lot: opts.lot ?? 1_000n,
        minQuantity: opts.min ?? 13_000n,
        bids: [{ price: 100n * U, quantity: opts.btcBids ?? 10n * B }],
        asks: [{ price: 100n * U, quantity: 10n * B }],
      },
      { symbol: "ETH", decimals: 18, mark: 100n * U, mmBps: 250n, tick: U / 100n, lot: 10n ** 14n, minQuantity: 4n * 10n ** 15n, bids: [{ price: 100n * U, quantity: 10n * U }], asks: [{ price: 100n * U, quantity: 10n * U }] },
    ],
    positions: [
      { symbol: "BTC", size: 8n * 10n ** 6n, entry: 100n * U },
      { symbol: "ETH", size: -3n * 10n ** 16n, entry: 100n * U },
    ],
    orders: opts.orders,
    problems: opts.problems,
  })
}

function analyze(snap: ReturnType<typeof hedged>, target: bigint, extra: { includeCancel?: boolean; shocks?: Record<string, number> } = {}) {
  const recon = reconcile(snap)
  const s = buildScenario(snap, recon, { shocksBps: extra.shocks ?? { BTC: -1_000, ETH: -1_000 }, targetBuffer: target, createdAt: "fixture" })
  return analyzeCandidates(s, snap, recon, { slippageBps: 0n, includeCancel: extra.includeCancel })
}

describe("IOC simulation", () => {
  it("stops at the limit on each side", () => {
    const bids = [
      { price: 105n, quantity: 2n },
      { price: 104n, quantity: 2n },
      { price: 103n, quantity: 10n },
    ]
    const sell = simulateIoc(bids, false, 10n, 104n)
    assert.deepEqual(sell.fills, [
      { price: 105n, quantity: 2n },
      { price: 104n, quantity: 2n },
    ])
    assert.equal(sell.unfilled, 6n)
    assert.equal(sell.depthReadExhausted, false)
    const asks = [
      { price: 100n, quantity: 1n },
      { price: 101n, quantity: 1n },
    ]
    const buy = simulateIoc(asks, true, 5n, 105n)
    assert.equal(buy.filled, 2n)
    assert.equal(buy.depthReadExhausted, true, "every level read was inside the limit")
  })
  it("rounds protective limits toward the trader", () => {
    assert.equal(protectiveLimit(1_000n, false, 50n, 10n), 1_000n) // 995 -> up to 1000
    assert.equal(protectiveLimit(1_000n, true, 50n, 10n), 1_000n) // 1005 -> down to 1000
    assert.equal(protectiveLimit(10_000n, false, 50n, 10n), 9_950n)
  })
})

describe("candidate analysis", () => {
  it("evaluates NONE and every valid 25/50/75/100% reduction", () => {
    const a = analyze(hedged(), 0n)
    assert.deepEqual(
      a.candidates.map((c) => [c.id, c.status]),
      [
        ["NONE", "EVALUATED"],
        ["BTC-25", "EVALUATED"],
        ["BTC-50", "EVALUATED"],
        ["BTC-75", "EVALUATED"],
        ["BTC-100", "EVALUATED"],
        ["ETH-25", "EVALUATED"],
        ["ETH-50", "EVALUATED"],
        ["ETH-75", "EVALUATED"],
        ["ETH-100", "EVALUATED"],
      ],
    )
  })

  it("does not manufacture a trade when doing nothing meets the target", () => {
    // Buffer under the -10% shock: 6 - 0.8 + 0.3 = 5.5 equity, MM 0.2475 -> 5.2525
    const a = analyze(hedged(), usd("5"))
    assert.equal(a.baseline.goal, "MEETS")
    assert.equal(a.outcome, "NO_ACTION_NEEDED")
    assert.equal(a.selected, null)
  })

  it("selects the smallest notional reduction that meets the target, and flags the hedge removal", () => {
    const a = analyze(hedged({ unlocked: usd("1") }), usd("0.7"))
    // NONE: 1 - 0.8 + 0.3 = 0.5, MM 0.2475 -> 0.2525 < 0.7
    assert.equal(a.baseline.goal, "FAILS")
    assert.equal(a.outcome, "CANDIDATE_SELECTED")
    const btc25 = a.candidates.find((c) => c.id === "BTC-25")!
    // 0.02 BTC sold at 100: equity 1 - 0.6 + 0.3 = 0.7, MM 0.2025 -> 0.4975 (fails)
    assert.equal(btc25.scenario!.buffer, usd("0.4975"))
    assert.equal(btc25.goal, "FAILS")
    const btc50 = a.candidates.find((c) => c.id === "BTC-50")!
    // 0.04 BTC: equity 1 - 0.4 + 0.3 = 0.9, MM 0.1575 -> 0.7425 (meets)
    assert.equal(btc50.scenario!.buffer, usd("0.7425"))
    assert.equal(a.selected, "BTC-50")
    assert.equal(a.ranking[0], "BTC-50")
    const eth = a.candidates.filter((c) => c.id.startsWith("ETH"))
    assert.ok(eth.every((c) => c.harmful && c.goal === "FAILS"), "reducing the ETH short removes the hedge")
    assert.ok(a.candidates.every((c) => c.costNow === undefined || c.costNow === 0n), "books at the mark: no cost")
  })

  it("returns NO_FEASIBLE_CANDIDATE when nothing evaluated meets the target", () => {
    const a = analyze(hedged({ unlocked: usd("1") }), usd("50"))
    assert.equal(a.outcome, "NO_FEASIBLE_CANDIDATE")
    assert.equal(a.selected, null)
  })

  it("refuses to recommend when the snapshot has problems", () => {
    const a = analyze(hedged({ unlocked: usd("1"), problems: ["no fresh mark for active market SOL"] }), usd("0.7"))
    assert.equal(a.outcome, "BLOCKED")
    assert.equal(a.selected, null)
    assert.ok(a.candidates.length > 1, "numbers are still shown")
  })

  it("refuses to recommend for a linked child account", () => {
    const snap = hedged({ unlocked: usd("1") })
    snap.accountMode.fundingPayer = "0x00000000000000000000000000000000000ba1a5"
    const a = analyze(snap, usd("0.7"))
    assert.equal(a.outcome, "BLOCKED")
    assert.match(a.blockers.join(" "), /linked child account/)
  })

  it("removes duplicates, sub-minimum sizes and dust remainders, saying why", () => {
    // position 0.08 BTC; lot 0.01 BTC, min 0.03 BTC
    const a = analyze(hedged({ lot: 10n ** 6n, min: 3n * 10n ** 6n }), 0n)
    const byId = Object.fromEntries(a.candidates.map((c) => [c.id, c]))
    assert.match(byId["BTC-25"].reasons[0], /below the venue minimum order/) // 0.02 < 0.03
    assert.equal(byId["BTC-50"].status, "EVALUATED") // 0.04, leaves 0.04
    assert.match(byId["BTC-75"].reasons[0], /leaves 2000000, below the venue minimum/) // 0.06 leaves 0.02
    assert.equal(byId["BTC-100"].status, "EVALUATED")
    const dup = analyze(hedged({ lot: 3n * 10n ** 6n, min: 3n * 10n ** 6n }), 0n)
    const d = Object.fromEntries(dup.candidates.map((c) => [c.id, c]))
    // 25% -> 0.02 -> 0; 50% -> 0.04 -> 0.03 (leaves 0.05); 75% -> 0.06 -> 0.06 (leaves 0.02: dust)
    assert.match(d["BTC-25"].reasons[0], /rounds to zero/)
    assert.equal(d["BTC-50"].reduce!.requestedQuantity, 3n * 10n ** 6n)
    assert.match(d["BTC-75"].reasons[0], /below the venue minimum/)
    // 100% -> 0.08 is not a multiple of 0.03: aligned down to 0.06, which leaves dust too
    assert.match(d["BTC-100"].reasons[0], /below the venue minimum/)
  })

  it("marks a reduction the book cannot fill inside the limit as unavailable", () => {
    const a = analyze(hedged({ btcBids: 0n }), 0n)
    assert.match(a.candidates.find((c) => c.id === "BTC-25")!.reasons[0], /ImmediateOrCancelNoFill/)
  })

  it("forecasts a depth-limited partial fill and says so", () => {
    const a = analyze(hedged({ btcBids: 3n * 10n ** 6n }), 0n)
    const c = a.candidates.find((x) => x.id === "BTC-100")!
    assert.equal(c.reduce!.expectedFill, 3n * 10n ** 6n)
    assert.ok(c.warnings.some((w) => /covers 3000000 of 8000000/.test(w)))
  })

  it("refuses a reduction that would self-match an own resting order", () => {
    const a = analyze(hedged({ orders: [{ symbol: "BTC", isBid: true, price: 100n * U, quantityRemaining: 13_000n }] }), 0n)
    assert.match(a.candidates.find((c) => c.id === "BTC-50")!.reasons[0], /SelfMatchCancelTaker/)
    assert.equal(a.excludedFromModel.orders.length, 1, "the resting order is listed as unmodelled exposure")
  })

  it("models cancelling ordinary orders as a lock release with no MM or equity gain", () => {
    const a = analyze(hedged({ unlocked: usd("1"), locked: usd("0.5") }), usd("0.7"), { includeCancel: true })
    const c = a.candidates.find((x) => x.id === "CANCEL-ORDERS")!
    assert.equal(c.status, "EVALUATED")
    assert.equal(c.scenario!.mm, a.baseline.scenario.mm)
    assert.equal(c.scenario!.eTotal, a.baseline.scenario.eTotal)
    assert.equal(c.scenario!.buffer - a.baseline.scenario.buffer, usd("0.5"))
    assert.equal(c.notionalReductionNow, 0n)
    assert.equal(a.selected, "CANCEL-ORDERS", "meets the target with no notional reduction")
  })
})
