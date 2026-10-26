// The pre-send refresh: a confirmation survives only an unchanged account, and is
// re-evaluated under the ORIGINAL scenario at the fresh state. SYNTHETIC FIXTURES ONLY.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { reconcile } from "../../src/margin-rescue/reconcile.js"
import { refreshConfirmation, relevantChanges } from "../../src/margin-rescue/refresh.js"
import type { AccountSnapshot } from "../../src/margin-rescue/snapshot.js"
import { C0, POOL, U, analysed, confirmationFor, usd } from "./mr-exec-fixtures.js"
import { atBlock, settleBank } from "./mr-fixtures.js"

function setup() {
  const { snapshot, scenario, analysis } = analysed()
  const record = { ...confirmationFor(analysis, snapshot, scenario), tx: { state: "NOT_SENT" as const } }
  return { snapshot, scenario, analysis, record }
}

function refresh(s: ReturnType<typeof setup>, fresh: AccountSnapshot, minSecondsLeft = 30) {
  return refreshConfirmation({ scenario: s.scenario, confirmation: s.record, analysisSnapshot: s.snapshot, original: s.analysis, fresh, freshRecon: reconcile(fresh), slippageBps: 0n, minSecondsLeft })
}

// The same account two blocks later, edited by `edit`, with the bank's figures settled.
function later(s: ReturnType<typeof setup>, edit: (x: AccountSnapshot) => void = () => {}): AccountSnapshot {
  const fresh = atBlock(s.snapshot, s.snapshot.block.number + 2n)
  edit(fresh)
  return settleBank(fresh)
}

describe("pre-send refresh", () => {
  it("an unchanged account keeps the confirmation, re-evaluated at the same scenario", () => {
    const s = setup()
    const r = refresh(s, later(s))
    assert.equal(r.verdict, "STILL_VALID", r.reasons.join("; "))
    assert.equal(r.reanalysis.scenarioId, s.scenario.id)
    assert.equal(r.reanalysis.selected, "BTC-25")
    assert.equal(r.refreshed!.reduce!.limitPrice, BigInt(s.record.request.limitPrice), "the confirmed limit, not a new one")
    assert.equal(r.refreshed!.scenario!.buffer, usd("5.4875"))
    assert.equal(r.fundingDrift, 0n)
  })

  it("funding accrual alone is not a structural change; the drift is reported and priced in", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.pools.find((p) => p.pool === POOL.BTC)!.projectedCumulativeFunding = C0 + 25n * 10n ** 33n)))
    assert.equal(r.verdict, "STILL_VALID", r.reasons.join("; "))
    assert.equal(r.fundingDrift, usd("0.002"))
    assert.equal(r.refreshed!.scenario!.buffer, usd("5.4855"))
  })

  it("a position that moved after the analysis invalidates the confirmation", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.positions.find((p) => p.pool === POOL.BTC)!.size = 7_000_000n)))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /BTC position changed from 8000000 to 7000000/)
    assert.match(r.reasons.join("; "), /position is 7000000, not the confirmed 8000000/)
    assert.equal(r.refreshed, null)
  })

  it("collateral that moved (a deposit or a settlement) invalidates it", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.collateral.unlocked += usd("1"))))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.stateChanges.join("; "), /unlocked collateral changed/)
  })

  it("a new resting order invalidates it", () => {
    const s = setup()
    const r = refresh(
      s,
      later(s, (x) => {
        x.orders = [{ pool: POOL.ETH, orderId: 9n, isBid: true, price: 90n * U, fullQuantity: 10n ** 16n, quantityRemaining: 10n ** 16n, expireTimestampNs: 10n ** 19n, userData: 0n, expired: false }]
        x.collateral.locked = usd("0.1")
        x.collateral.unlocked -= usd("0.1")
      }),
    )
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.stateChanges.join("; "), /resting orders changed/)
  })

  it("a funding settlement on a leg (entry index moved) invalidates it", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.positions.find((p) => p.pool === POOL.ETH)!.entryFundingIndex += 1n)))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.stateChanges.join("; "), /ETH funding was settled/)
  })

  it("a thinner book that would fill less at the confirmed limit invalidates it", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.books.find((b) => b.pool === POOL.BTC)!.bids = [{ price: 100n * U, quantity: 1_000_000n }])))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /now fills 1000000, not the forecast 2000000/)
    assert.equal(r.refreshed!.reduce!.expectedFill, 1_000_000n)
  })

  it("no liquidity inside the confirmed limit invalidates it", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.books.find((b) => b.pool === POOL.BTC)!.bids = [{ price: 99n * U, quantity: 10n ** 9n }])))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /nothing on the book inside the confirmed limit/)
  })

  it("drift that changes which candidate the same scenario selects invalidates it", () => {
    const s = setup()
    // BTC now owes 0.1: BTC-25 falls to 5.3975 < 5.4 and BTC-50 is selected instead.
    const r = refresh(s, later(s, (x) => (x.pools.find((p) => p.pool === POOL.BTC)!.projectedCumulativeFunding = C0 + 1125n * 10n ** 33n)))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /now selects BTC-50, not the confirmed BTC-25/)
    assert.match(r.reasons.join("; "), /no longer meets the target/)
    assert.equal(r.reanalysis.selected, "BTC-50")
  })

  it("a changed risk parameter makes the scenario inapplicable", () => {
    const s = setup()
    const r = refresh(s, later(s, (x) => (x.pools.find((p) => p.pool === POOL.ETH)!.maintenanceMarginBps = 300n)))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /risk configuration of ETH changed/)
  })

  it("a deadline too close to send invalidates it", () => {
    const s = setup()
    const fresh = atBlock(s.snapshot, s.snapshot.block.number + 2n, BigInt(s.record.request.deadline) - 10n)
    const r = refresh(s, settleBank(fresh))
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /deadline leaves 10s/)
  })

  it("a refresh at the analysed block itself is the same state and keeps the confirmation", () => {
    const s = setup()
    const r = refresh(s, structuredClone(s.snapshot))
    assert.equal(r.verdict, "STILL_VALID", r.reasons.join("; "))
  })

  it("a refresh from an older block, or from another block at the same height, is refused", () => {
    const s = setup()
    const older = refresh(s, settleBank(atBlock(s.snapshot, s.snapshot.block.number - 1n)))
    assert.equal(older.verdict, "INVALIDATED")
    assert.match(older.reasons.join("; "), /older than the analysis block/)
    const other = structuredClone(s.snapshot)
    other.block.hash = `0x${"ee".repeat(32)}`
    const sibling = refresh(s, other)
    assert.equal(sibling.verdict, "INVALIDATED")
    assert.match(sibling.reasons.join("; "), /another hash than the one analysed/)
  })

  it("an unreconciled snapshot is refused", () => {
    const s = setup()
    const fresh = later(s)
    fresh.bank.equity += 1n
    const r = refresh(s, fresh)
    assert.equal(r.verdict, "INVALIDATED")
    assert.match(r.reasons.join("; "), /reconciliation UNEXPLAINED/)
  })

  it("marks moving is not a structural change", () => {
    const s = setup()
    const fresh = later(s, (x) => (x.pools.find((p) => p.pool === POOL.BTC)!.markPrice = 101n * U))
    assert.deepEqual(relevantChanges(s.snapshot, fresh), [])
  })
})
