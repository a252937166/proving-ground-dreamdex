// Margin Rescue accounting and scenario arithmetic. SYNTHETIC FIXTURES ONLY: no
// network. These validate the arithmetic, not whether an account survives a real
// price path or that any fill or liquidation outcome is guaranteed.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  accountFigures,
  divCeil,
  divCeilSigned,
  divFloor,
  fillFee,
  fundingOwed,
  healthRatioBps,
  realizedPnl,
  unrealizedPnl,
} from "../../src/margin-rescue/math.js"
import { reconcile } from "../../src/margin-rescue/reconcile.js"
import {
  buildScenario,
  goalStatus,
  portfolioOf,
  scenarioCompatibility,
  valuePortfolio,
  verifyScenarioId,
  ScenarioMismatchError,
} from "../../src/margin-rescue/scenario.js"
import { previewReduce } from "../../src/margin-rescue/candidates.js"
import { fixtureSnapshot, POOL } from "./mr-fixtures.js"
import { parseDecimal } from "../../src/units.js"

const U = 10n ** 18n // one USDso
const usd = (amount: number | string) => parseDecimal(String(amount), 18, { signed: true })

describe("rounding primitives", () => {
  it("floors, truncates and ceils signed quotients the way the bank does", () => {
    assert.equal(divFloor(-7n, 2n), -4n)
    assert.equal(-7n / 2n, -3n) // truncation, what the SDK uses for unrealized PnL
    assert.equal(divFloor(7n, 2n), 3n)
    assert.equal(divCeilSigned(7n, 2n), 4n) // a payer pays at least what is owed
    assert.equal(divCeilSigned(-7n, 2n), -3n) // a receiver receives at most it
    assert.equal(divCeil(7n, 2n), 4n)
    assert.equal(divCeil(0n, 2n), 0n)
    assert.throws(() => divCeil(-1n, 2n))
  })

  it("negative fractional PnL floors one raw unit below truncation", () => {
    // long 3 base units (oneBase 10) entered at 100, mark 99.5 -> PnL -0.15 -> floor -1 raw
    const leg = { size: 3n, avgEntryPrice: 1000n }
    assert.equal(unrealizedPnl(leg, 995n, 10n, "floor"), -2n) // (995-1000)*3/10 = -1.5 -> -2
    assert.equal(unrealizedPnl(leg, 995n, 10n, "trunc"), -1n)
    // an exact negative quotient does not differ
    assert.equal(unrealizedPnl({ size: 2n, avgEntryPrice: 1000n }, 995n, 10n, "floor"), -1n)
    assert.equal(unrealizedPnl({ size: 2n, avgEntryPrice: 1000n }, 995n, 10n, "trunc"), -1n)
  })

  it("funding owed ceils for payers and receivers alike", () => {
    // size 3, delta index 0.5e18 per unit, oneBase 1 -> 1.5 owed -> 2
    assert.equal(fundingOwed(3n, 0n, 5n * 10n ** 17n, 1n), 2n)
    // short with the index rising: receives 1.5 -> -1 (ceil toward +inf)
    assert.equal(fundingOwed(-3n, 0n, 5n * 10n ** 17n, 1n), -1n)
    assert.equal(fundingOwed(0n, 0n, 10n ** 30n, 1n), 0n)
  })

  it("realized PnL floors per fill and fees use the floored fill notional", () => {
    assert.equal(realizedPnl(10n, 1000n, 3n, 995n, 10n), -2n) // -1.5 -> -2
    assert.equal(realizedPnl(-10n, 1000n, 3n, 995n, 10n), 1n) // +1.5 -> 1
    assert.equal(fillFee(1n, 99n, 1n, 101_011n), 1n) // floor(99 * 101011 / 1e7) = 1
    assert.equal(fillFee(3n, 995n, 10n, 50_000n), 1n) // 50 bps of the floored notional 298 = 1.49 -> 1
  })

  it("health ratio is not applicable when MM is zero", () => {
    assert.equal(healthRatioBps(100n, 0n), null)
    assert.equal(healthRatioBps(150n, 100n), 15_000n)
    assert.equal(healthRatioBps(-1n, 3n), -3_334n) // floor(-3333.3)
  })
})

// Fixture A: E_risk 600; BTC long notional 8,000; ETH short notional 3,000; both -10%;
// MM 2.5% on both; reductions at the reference price with no cost. BTC uses 8 base
// decimals and ETH 18, so the table also checks mixed decimals.
function fixtureA() {
  const P100 = 100n * U
  return fixtureSnapshot({
    unlocked: usd(600),
    markets: [
      { symbol: "BTC", decimals: 8, mark: P100, mmBps: 250n, bids: [{ price: P100, quantity: 80n * 10n ** 8n }], asks: [{ price: P100, quantity: 80n * 10n ** 8n }] },
      { symbol: "ETH", decimals: 18, mark: P100, mmBps: 250n, bids: [{ price: P100, quantity: 30n * U }], asks: [{ price: P100, quantity: 30n * U }] },
    ],
    positions: [
      { symbol: "BTC", size: 80n * 10n ** 8n, entry: P100 },
      { symbol: "ETH", size: -30n * U, entry: P100 },
    ],
  })
}

describe("fixture A: joint downside shock, reductions before the shock", () => {
  const snap = fixtureA()
  const recon = reconcile(snap)
  const scenario = buildScenario(snap, recon, { shocksBps: { BTC: -1000, ETH: -1000 }, targetBuffer: 0n, createdAt: "fixture" })
  const base = portfolioOf(snap)
  const at = (qtyBtc: bigint, qtyEth: bigint) => {
    let p = base
    if (qtyBtc) p = previewReduce(snap, p, POOL.BTC, false, qtyBtc, 100n * U, 100n * U, [{ price: 100n * U, quantity: qtyBtc }]).post
    if (qtyEth) p = previewReduce(snap, p, POOL.ETH, true, qtyEth, 100n * U, 100n * U, [{ price: 100n * U, quantity: qtyEth }]).post
    return valuePortfolio(scenario, p)
  }

  it("reconciles at the reference marks", () => {
    assert.equal(recon.verdict, "EXACT")
    assert.equal(recon.independent.eRisk, usd(600))
    assert.equal(scenario.markets.find((m) => m.symbol === "BTC")!.scenarioPrice, (90n * U).toString())
  })

  it("no action: E_risk 100, MM 247.5, buffer -147.5", () => {
    const v = at(0n, 0n)
    assert.equal(v.eRisk, usd(100))
    assert.equal(v.mm, usd(247.5))
    assert.equal(v.buffer, usd(-147.5))
  })

  it("reduce the BTC long by 2,000 notional: E_risk 300, MM 202.5, buffer 97.5", () => {
    const v = at(20n * 10n ** 8n, 0n)
    assert.equal(v.eRisk, usd(300))
    assert.equal(v.mm, usd(202.5))
    assert.equal(v.buffer, usd(97.5))
  })

  it("reduce the ETH short by 2,000 notional: E_risk -100, MM 202.5, buffer -302.5 (removing the hedge hurts)", () => {
    const v = at(0n, 20n * U)
    assert.equal(v.eRisk, usd(-100))
    assert.equal(v.mm, usd(202.5))
    assert.equal(v.buffer, usd(-302.5))
  })

  it("BTC planned 2,000 but filled 1,000: E_risk 200, MM 225, buffer -25", () => {
    const v = at(10n * 10n ** 8n, 0n)
    assert.equal(v.eRisk, usd(200))
    assert.equal(v.mm, usd(225))
    assert.equal(v.buffer, usd(-25))
  })

  it("never re-applies the percentage to a new mark", () => {
    // After execution the live BTC mark is 94; the scenario still values BTC at 90.
    const moved = fixtureSnapshot({
      unlocked: usd(600),
      markets: [
        { symbol: "BTC", decimals: 8, mark: 94n * U, mmBps: 250n },
        { symbol: "ETH", decimals: 18, mark: 100n * U, mmBps: 250n },
      ],
      positions: [
        { symbol: "BTC", size: 60n * 10n ** 8n, entry: 100n * U },
        { symbol: "ETH", size: -30n * U, entry: 100n * U },
      ],
    })
    const v = valuePortfolio(scenario, portfolioOf(moved))
    assert.equal(v.eRisk, usd(300)) // same as the 2,000 reduction row, priced at 90 not 84.6
    assert.equal(v.mm, usd(202.5))
  })
})

// Fixture B: unlocked 100, locked 20; BTC +1 at 100 owing 5; ETH -2 at 50 owed 2 (F=-2);
// MM 10% on both. Units are synthetic: 1 raw unit = 1 USDso, oneBase 1.
function fixtureB(extra?: { takerFeeBpsTimes1k?: bigint }) {
  return fixtureSnapshot({
    unlocked: 100n,
    locked: 20n,
    markets: [
      { symbol: "BTC", decimals: 0, mark: 100n, mmBps: 1_000n, takerFeeBpsTimes1k: extra?.takerFeeBpsTimes1k, cumulativeFunding: 10n ** 21n },
      { symbol: "ETH", decimals: 0, mark: 50n, mmBps: 1_000n, cumulativeFunding: 10n ** 21n },
    ],
    positions: [
      { symbol: "BTC", size: 1n, entry: 100n, fundingOwed: 5n },
      { symbol: "ETH", size: -2n, entry: 50n, fundingOwed: -2n },
    ],
  })
}

describe("fixture B: locks, funding and an absolute-price scenario", () => {
  const snap = fixtureB({ takerFeeBpsTimes1k: 101_011n }) // makes a fill of 1 at 99 cost exactly 1
  const recon = reconcile(snap)
  const scenario = buildScenario(snap, recon, { prices: { BTC: 60n, ETH: 80n }, targetBuffer: 10n, createdAt: "fixture" })

  it("reference: E_risk 97, E_total 117, MM 20, buffer 77", () => {
    const v = valuePortfolio(scenario, portfolioOf(snap), "reference")
    assert.deepEqual([v.eRisk, v.eTotal, v.mm, v.buffer], [97n, 117n, 20n, 77n])
    assert.equal(recon.independent.eRisk, 97n)
  })

  it("scenario BTC 60 / ETH 80, no action: E_risk -3, E_total 17, MM 22, buffer -25", () => {
    const v = valuePortfolio(scenario, portfolioOf(snap))
    assert.deepEqual([v.eRisk, v.eTotal, v.mm, v.buffer], [-3n, 17n, 22n, -25n])
    assert.equal(goalStatus(v, 10n), "FAILS")
  })

  it("cancelling the ordinary order (no fee): E_risk 17, E_total 17, MM 22, buffer -5", () => {
    const base = portfolioOf(snap)
    const v = valuePortfolio(scenario, { unlocked: base.unlocked + base.locked, locked: 0n, legs: base.legs })
    assert.deepEqual([v.eRisk, v.eTotal, v.mm, v.buffer], [17n, 17n, 22n, -5n])
    const before = valuePortfolio(scenario, base)
    assert.equal(v.mm, before.mm, "cancelling releases no maintenance margin")
    assert.equal(v.eTotal, before.eTotal, "and creates no profit")
  })

  it("closing BTC at 99 with fee 1 settles its funding once: unlocked 93; E_risk 35, E_total 55, MM 16, buffer 19", () => {
    const r = previewReduce(snap, portfolioOf(snap), POOL.BTC, false, 1n, 99n, 100n, [{ price: 99n, quantity: 1n }])
    assert.equal(r.realizedPnl, -1n)
    assert.equal(r.fees, 1n)
    assert.equal(r.fundingSettled, 5n)
    assert.equal(r.post.unlocked, 93n)
    assert.equal(r.post.locked, 20n)
    assert.deepEqual(r.post.legs.map((l) => [l.pool, l.size, l.fundingOwed]), [[POOL.ETH, -2n, -2n]])
    const v = valuePortfolio(scenario, r.post)
    assert.deepEqual([v.eRisk, v.eTotal, v.mm, v.buffer], [35n, 55n, 16n, 19n])
    assert.equal(goalStatus(v, 10n), "MEETS")
  })
})

describe("goal boundaries", () => {
  it("meets at exactly the target, fails one raw unit below, meets one above", () => {
    const v = (b: bigint) => ({ bufferLower: b, bufferUpper: b })
    assert.equal(goalStatus(v(1_000n), 1_000n), "MEETS")
    assert.equal(goalStatus(v(999n), 1_000n), "FAILS")
    assert.equal(goalStatus(v(1_001n), 1_000n), "MEETS")
  })
  it("an interval crossing the target is uncertain, never met", () => {
    assert.equal(goalStatus({ bufferLower: 999n, bufferUpper: 1_001n }, 1_000n), "UNCERTAIN")
    assert.equal(goalStatus({ bufferLower: 1_000n, bufferUpper: 1_002n }, 1_000n), "MEETS")
    assert.equal(goalStatus({ bufferLower: 997n, bufferUpper: 999n }, 1_000n), "FAILS")
  })
  it("a per-leg numerical bound widens the buffer on both sides", () => {
    const snap = fixtureB()
    const s = buildScenario(snap, reconcile(snap), { prices: { BTC: 60n, ETH: 80n }, targetBuffer: 0n, perLegBound: 1n, createdAt: "fixture" })
    const v = valuePortfolio(s, portfolioOf(snap))
    assert.equal(v.buffer, -25n)
    assert.equal(v.bufferLower, -29n) // 2 legs x (1 on equity + 1 on MM)
    assert.equal(v.bufferUpper, -21n)
    assert.equal(goalStatus(v, -27n), "UNCERTAIN")
  })
})

describe("edge cases", () => {
  it("includes a third market at its reference price and refuses to shock it", () => {
    const snap = fixtureSnapshot({
      unlocked: usd(1_000),
      markets: [
        { symbol: "BTC", decimals: 8, mark: 100n * U, mmBps: 250n },
        { symbol: "SOL", decimals: 9, mark: 20n * U, mmBps: 500n },
      ],
      positions: [
        { symbol: "BTC", size: 10n ** 8n, entry: 100n * U },
        { symbol: "SOL", size: -5n * 10n ** 9n, entry: 21n * U },
      ],
    })
    const recon = reconcile(snap)
    assert.throws(() => buildScenario(snap, recon, { shocksBps: { SOL: -500 }, targetBuffer: 0n }), /only BTC and ETH/)
    const s = buildScenario(snap, recon, { shocksBps: { BTC: -2_000 }, targetBuffer: 0n, createdAt: "fixture" })
    const sol = s.markets.find((m) => m.symbol === "SOL")!
    assert.equal(sol.scenarioPrice, sol.referenceMark)
    const v = valuePortfolio(s, portfolioOf(snap))
    // 1000 + (80-100)*1 + (20-21)*(-5) = 985; MM = 2.5% of 80 + 5% of 100 = 2 + 5 = 7
    assert.equal(v.eRisk, usd(985))
    assert.equal(v.mm, usd(7))
    assert.equal(v.legs.length, 2)
  })

  it("handles a negative unlocked balance", () => {
    const snap = fixtureSnapshot({
      unlocked: usd(-50),
      markets: [{ symbol: "ETH", decimals: 18, mark: 100n * U, mmBps: 250n }],
      positions: [{ symbol: "ETH", size: U, entry: 40n * U }],
    })
    const f = accountFigures(snap.collateral.unlocked, 0n, [
      { pool: POOL.ETH, size: U, avgEntryPrice: 40n * U, fundingOwed: 0n, price: 100n * U, risk: { oneBase: U, initialMarginBps: 500n, maintenanceMarginBps: 250n, closeOutMarginBps: 125n } },
    ])
    assert.equal(f.eRisk, usd(10))
    assert.equal(f.buffer, usd(7.5))
    assert.equal(reconcile(snap).verdict, "EXACT")
  })

  it("an account with no positions has MM zero and no health ratio", () => {
    const snap = fixtureSnapshot({ unlocked: usd(25), markets: [{ symbol: "BTC", decimals: 8, mark: 100n * U, mmBps: 250n }], positions: [] })
    const s = buildScenario(snap, reconcile(snap), { shocksBps: {}, targetBuffer: usd(20), createdAt: "fixture" })
    const v = valuePortfolio(s, portfolioOf(snap))
    assert.equal(v.mm, 0n)
    assert.equal(v.healthRatioBps, null)
    assert.equal(v.buffer, usd(25))
    assert.equal(s.markets.length, 0)
  })

  it("an upside scenario hurts the short and helps the long", () => {
    const snap = fixtureA()
    const s = buildScenario(snap, reconcile(snap), { shocksBps: { BTC: 1_000, ETH: 1_000 }, targetBuffer: 0n, createdAt: "fixture" })
    const v = valuePortfolio(s, portfolioOf(snap))
    // 600 + 80*10 - 30*10 = 1100; MM = 2.5% of (8800 + 3300) = 302.5
    assert.equal(v.eRisk, usd(1_100))
    assert.equal(v.mm, usd(302.5))
  })

  it("partial execution with fees across two levels", () => {
    const snap = fixtureSnapshot({
      unlocked: usd(500),
      markets: [{ symbol: "BTC", decimals: 8, mark: 100n * U, mmBps: 250n, takerFeeBpsTimes1k: 50_000n }],
      positions: [{ symbol: "BTC", size: 4n * 10n ** 8n, entry: 90n * U, fundingOwed: usd(1.25) }],
    })
    const fills = [
      { price: 99n * U, quantity: 10n ** 8n },
      { price: 98n * U, quantity: 5n * 10n ** 7n },
    ]
    const r = previewReduce(snap, portfolioOf(snap), POOL.BTC, false, 2n * 10n ** 8n, 98n * U, 99n * U, fills)
    assert.equal(r.expectedFill, 15n * 10n ** 7n)
    assert.equal(r.unfilled, 5n * 10n ** 7n)
    assert.equal(r.realizedPnl, usd(9) + usd(4)) // (99-90)*1 + (98-90)*0.5
    assert.equal(r.fees, usd(0.495) + usd(0.245)) // 50 bps of 99 and of 49
    assert.equal(r.fundingSettled, usd(1.25)) // the whole position's funding, once
    assert.equal(r.post.unlocked, usd(500) + usd(13) - usd(0.74) - usd(1.25))
    assert.deepEqual(r.post.legs.map((l) => [l.size, l.avgEntryPrice, l.fundingOwed]), [[25n * 10n ** 7n, 90n * U, 0n]])
  })
})

describe("scenario identity and invalidation", () => {
  const snap = fixtureA()
  const s = buildScenario(snap, reconcile(snap), { shocksBps: { BTC: -800, ETH: -1_200 }, targetBuffer: usd(50), createdAt: "fixture" })

  it("has a content id that any edit breaks", () => {
    assert.ok(verifyScenarioId(s))
    const edited = { ...s, targetBuffer: usd(10).toString() }
    assert.equal(verifyScenarioId(edited), false)
    const again = buildScenario(snap, reconcile(snap), { shocksBps: { BTC: -800, ETH: -1_200 }, targetBuffer: usd(50), createdAt: "fixture" })
    assert.equal(again.id, s.id, "deterministic")
  })

  it("stores absolute scenario prices for every held market", () => {
    assert.deepEqual(
      s.markets.map((m) => [m.symbol, m.scenarioPrice]),
      [
        ["BTC", (92n * U).toString()],
        ["ETH", (88n * U).toString()],
      ],
    )
  })

  it("is invalidated by a changed risk configuration or a newly held market", () => {
    const changed = fixtureSnapshot({
      unlocked: usd(600),
      markets: [
        { symbol: "BTC", decimals: 8, mark: 100n * U, mmBps: 300n },
        { symbol: "ETH", decimals: 18, mark: 100n * U, mmBps: 250n },
        { symbol: "SOL", decimals: 9, mark: 20n * U, mmBps: 500n },
      ],
      positions: [
        { symbol: "BTC", size: 80n * 10n ** 8n, entry: 100n * U },
        { symbol: "SOL", size: 10n ** 9n, entry: 20n * U },
      ],
    })
    const reasons = scenarioCompatibility(s, changed)
    assert.ok(reasons.some((r) => /risk configuration of BTC changed/.test(r)))
    assert.ok(reasons.some((r) => /new market held since the scenario: SOL/.test(r)))
    assert.throws(() => valuePortfolio(s, portfolioOf(changed)), ScenarioMismatchError)
  })
})
