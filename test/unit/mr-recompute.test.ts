// Receipt binding and recomputation from actual execution, including the negative
// paths: tampered evidence, partial fills, funding drift, block mismatches, external
// changes and reverts. SYNTHETIC FIXTURES ONLY: no network; see mr-exec-fixtures.ts.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getAddress, keccak256, toBytes } from "viem"
import { reduceCalldata } from "../../src/margin-rescue/action.js"
import { recompute, type RecomputeInput } from "../../src/margin-rescue/recompute.js"
import { requestOf, summarize, verifyBinding } from "../../src/margin-rescue/receipt.js"
import { ACCOUNT, BANK, C0, GUARD, POOL, TX_HASH, U, analysed, confirmationFor, execute, usd } from "./mr-exec-fixtures.js"
import { atBlock, settleBank } from "./mr-fixtures.js"

const OTHER = getAddress("0x00000000000000000000000000000000000b0b00")

// The analysed account, its confirmation (BTC-25: sell 0.02 BTC at 100) and a full fill.
function base() {
  const { snapshot, scenario, analysis } = analysed()
  const record = confirmationFor(analysis, snapshot, scenario)
  const full = execute(snapshot, record, { fills: [{ price: 100n * U, quantity: 2_000_000n }] })
  return { snapshot, scenario, analysis, record, ...full }
}

function input(b: ReturnType<typeof base>, over: Partial<RecomputeInput> = {}): RecomputeInput {
  return { confirmation: b.record, scenario: b.scenario, analysis: b.analysis, pre: b.snapshot, post: b.post, receipt: b.receipt, externalLogs: [], ...over }
}

// Rebuild a receipt from its own logs with a change, the way an attacker or a bug would.
function tampered(b: ReturnType<typeof base>, edit: { logs?: (l: ReturnType<typeof base>["receipt"]["logs"]) => typeof l; head?: Partial<ReturnType<typeof base>["receipt"]> }) {
  const logs = edit.logs ? edit.logs(structuredClone(b.receipt.logs)) : b.receipt.logs
  const { txHash, status, blockNumber, blockHash, canonical, from, to, gasUsed, tx } = { ...b.receipt, ...edit.head }
  return summarize({ txHash, status, blockNumber, blockHash, canonical, from, to, gasUsed, tx }, logs, {
    guard: GUARD,
    pool: b.record.request.pool,
    owner: ACCOUNT,
    marginBank: BANK,
    isBid: b.record.request.isBid,
    limitPrice: BigInt(b.record.request.limitPrice),
    requested: BigInt(b.record.request.quantity),
  })
}

describe("fixture execution", () => {
  it("the analysis selects BTC-25 and forecasts a 5.4875 buffer against a 5.4 target", () => {
    const { analysis, record } = base()
    assert.equal(analysis.outcome, "CANDIDATE_SELECTED")
    assert.equal(record.candidateId, "BTC-25")
    assert.equal(analysis.baseline.scenario.buffer, usd("5.2425")) // 6 − 0.01 funding − 0.8 + 0.3 − MM 0.2475
    assert.equal(record.forecast.scenarioBuffer, usd("5.4875").toString())
  })

  it("a matching receipt binds and recomputes to GOAL_MET at the forecast", () => {
    const b = base()
    const r = recompute(input(b))
    assert.deepEqual(r.binding, { ok: true, failures: [] })
    assert.ok(r.ledger.checks.every((c) => c.ok), JSON.stringify(r.ledger.checks.filter((c) => !c.ok)))
    assert.equal(r.fill.state, "REQUESTED_FILL")
    assert.equal(r.ledger.fundingSettled, usd("0.01"))
    assert.equal(r.actual.scenario!.buffer, usd("5.4875"))
    assert.equal(r.differences.bufferVsForecast, 0n)
    assert.equal(r.goal.state, "GOAL_MET")
  })
})

describe("receipt binding rejects evidence that is not the confirmed action", () => {
  const cases: [string, (b: ReturnType<typeof base>) => RecomputeInput, RegExp][] = [
    [
      "a changed action id in the guard event",
      (b) => input(b, { receipt: tampered(b, { logs: (ls) => ls.map((l) => (l.name === "ReduceExecuted" ? { ...l, args: { ...l.args, actionId: keccak256(toBytes("another action")) } } : l)) }) }),
      /guard event action id/,
    ],
    ["calldata of a different request", (b) => input(b, { receipt: tampered(b, { head: { tx: { ...b.receipt.tx, input: reduceCalldata({ ...requestOf(b.record), limitPrice: requestOf(b.record).limitPrice - U / 10n }) } } }) }), /calldata differs/],
    ["a different destination", (b) => input(b, { receipt: tampered(b, { head: { to: OTHER, tx: { ...b.receipt.tx, to: OTHER } } }) }), /destination/],
    ["a different sender", (b) => input(b, { receipt: tampered(b, { head: { from: OTHER, tx: { ...b.receipt.tx, from: OTHER } } }) }), /sender/],
    ["another transaction hash", (b) => input(b, { receipt: tampered(b, { head: { txHash: keccak256(toBytes("other tx")) } }) }), /is not the journalled/],
    ["a non-zero value", (b) => input(b, { receipt: tampered(b, { head: { tx: { ...b.receipt.tx, value: 1n } } }) }), /carries value/],
    ["another nonce", (b) => input(b, { receipt: tampered(b, { head: { tx: { ...b.receipt.tx, nonce: 8 } } }) }), /nonce/],
    ["a guard event from another pool", (b) => input(b, { receipt: tampered(b, { logs: (ls) => ls.map((l) => (l.name === "ReduceExecuted" ? { ...l, args: { ...l.args, pool: POOL.ETH } } : l)) }) }), /guard event pool/],
    ["a guard event with another quantity", (b) => input(b, { receipt: tampered(b, { logs: (ls) => ls.map((l) => (l.name === "ReduceExecuted" ? { ...l, args: { ...l.args, quantity: 3_000_000n } } : l)) }) }), /guard event quantity/],
    ["a guard event with another limit", (b) => input(b, { receipt: tampered(b, { logs: (ls) => ls.map((l) => (l.name === "ReduceExecuted" ? { ...l, args: { ...l.args, limitPrice: 1n } } : l)) }) }), /guard event limit/],
    ["a second guard event", (b) => input(b, { receipt: tampered(b, { logs: (ls) => [...ls, { ...ls.find((l) => l.name === "ReduceExecuted")!, address: OTHER, logIndex: 99 }] }) }), /2 ReduceExecuted events/],
    ["no guard event at all", (b) => input(b, { receipt: tampered(b, { logs: (ls) => ls.filter((l) => l.name !== "ReduceExecuted") }) }), /no ReduceExecuted event/],
    ["a taker order placed for someone else", (b) => input(b, { receipt: tampered(b, { logs: (ls) => ls.map((l) => (l.name === "OrderPlaced" ? { ...l, args: { ...l.args, placedOrder: { owner: OTHER } } } : l)) }) }), /placed for/],
    ["a post snapshot read at another block than the receipt", (b) => input(b, { post: atBlock(b.post, b.post.block.number + 1n) }), /post snapshot block/],
    ["a pre snapshot that is not before the receipt", (b) => input(b, { pre: atBlock(b.snapshot, b.receipt.blockNumber) }), /not before the receipt block/],
    ["a saved confirmation whose calldata was edited", (b) => input(b, { confirmation: { ...b.record, calldata: reduceCalldata({ ...requestOf(b.record), quantity: 3_000_000n }) } }), /saved calldata/],
    ["a saved confirmation whose request was edited", (b) => input(b, { confirmation: { ...b.record, request: { ...b.record.request, quantity: "3000000" } } }), /saved action id/],
    ["a non-canonical receipt", (b) => input(b, { receipt: tampered(b, { head: { canonical: false } }) }), /not canonical/],
    ["a confirmation under another scenario", (b) => input(b, { confirmation: { ...b.record, scenarioId: "f".repeat(64) } }), /confirmation scenario/],
  ]
  for (const [name, make, why] of cases) {
    it(`${name} → EVIDENCE_MISMATCH, never GOAL_MET`, () => {
      const r = recompute(make(base()))
      assert.equal(r.goal.state, "EVIDENCE_MISMATCH")
      assert.equal(r.binding.ok, false)
      assert.match(r.binding.failures.join("; "), why)
      assert.equal(r.actual.scenario, null, "nothing is credited to the action")
      assert.equal(r.differences.bufferVsForecast, null)
    })
  }

  it("binding is checked on its own as well (verifyBinding)", () => {
    const b = base()
    assert.deepEqual(verifyBinding(b.record, b.receipt, { pre: b.snapshot, post: b.post }), { ok: true, failures: [] })
  })
})

describe("recomputation from what actually happened", () => {
  it("an actual partial fill is recomputed from the fill, not the forecast", () => {
    const b = base()
    const half = execute(b.snapshot, b.record, { fills: [{ price: 100n * U, quantity: 1_000_000n }] })
    const r = recompute(input(b, { receipt: half.receipt, post: half.post }))
    assert.equal(r.binding.ok, true)
    assert.equal(r.fill.state, "PARTIAL_FILL")
    assert.equal(r.fill.filled, 1_000_000n)
    assert.equal(r.fill.unfilled, 1_000_000n)
    assert.ok(r.ledger.checks.every((c) => c.ok))
    // BTC 0.07 at 90 and ETH −0.03 at 90 on 5.99 unlocked: E 5.59, MM 0.225.
    assert.equal(r.actual.scenario!.buffer, usd("5.365"))
    assert.equal(r.differences.fillVsForecast, -1_000_000n)
    assert.equal(r.goal.state, "GOAL_NOT_MET")
  })

  it("a fill from two makers settles funding once and realizes PnL per fill", () => {
    const b = base()
    const two = execute(b.snapshot, b.record, { fills: [{ price: 100n * U, quantity: 1_500_000n }, { price: 100n * U, quantity: 500_000n }] })
    const r = recompute(input(b, { receipt: two.receipt, post: two.post }))
    assert.equal(r.fill.state, "REQUESTED_FILL")
    assert.equal(r.fill.fills.length, 2)
    assert.ok(r.ledger.checks.every((c) => c.ok))
    assert.equal(r.goal.state, "GOAL_MET")
  })

  it("a fill outside the confirmed limit is BASELINE_CHANGED even if the binding holds", () => {
    const b = base()
    const worse = execute(b.snapshot, b.record, { fills: [{ price: 99n * U, quantity: 2_000_000n }] })
    const r = recompute(input(b, { receipt: worse.receipt, post: worse.post }))
    assert.equal(r.binding.ok, true)
    assert.equal(r.fill.priceBoundRespected, false)
    assert.equal(r.goal.state, "BASELINE_CHANGED")
    assert.match(r.goal.reason, /every fill inside the confirmed limit/)
  })

  it("funding drift between the analysis and the execution is settled exactly and shows in the difference", () => {
    const b = base()
    // BTC's index moves so the leg owes 0.012 instead of 0.01; ETH's so the short is owed 0.0003.
    const drift = execute(b.snapshot, b.record, { fills: [{ price: 100n * U, quantity: 2_000_000n }], cumulative: { BTC: C0 + 25n * 10n ** 33n, ETH: C0 + 10n ** 34n } })
    const r = recompute(input(b, { receipt: drift.receipt, post: drift.post }))
    assert.equal(r.binding.ok, true)
    assert.ok(r.ledger.checks.every((c) => c.ok), JSON.stringify(r.ledger.checks.filter((c) => !c.ok)))
    assert.equal(r.ledger.fundingSettled, usd("0.012"))
    assert.equal(r.differences.untouchedLegsFundingDrift, -usd("0.0003"))
    // 5.988 − 0.6 + 0.3 + 0.0003 − MM 0.2025
    assert.equal(r.actual.scenario!.buffer, usd("5.4858"))
    assert.equal(r.differences.bufferVsForecast, -usd("0.0017"))
    assert.equal(r.goal.state, "GOAL_MET")
  })

  it("funding drift that pushes the buffer under the target is GOAL_NOT_MET, not hidden", () => {
    const b = base()
    // BTC owes 0.1 by execution: 5.4875 − 0.09 < 5.4.
    const drift = execute(b.snapshot, b.record, { fills: [{ price: 100n * U, quantity: 2_000_000n }], cumulative: { BTC: C0 + 1125n * 10n ** 33n } })
    const r = recompute(input(b, { receipt: drift.receipt, post: drift.post }))
    assert.ok(r.ledger.checks.every((c) => c.ok))
    assert.equal(r.ledger.fundingSettled, usd("0.1"))
    assert.equal(r.goal.state, "GOAL_NOT_MET")
  })

  it("a change to another leg between the reads is BASELINE_CHANGED", () => {
    const b = base()
    const post = structuredClone(b.post)
    post.positions.find((p) => p.pool === POOL.ETH)!.size = -2n * 10n ** 16n
    settleBank(post)
    const r = recompute(input(b, { post }))
    assert.equal(r.binding.ok, true)
    assert.equal(r.goal.state, "BASELINE_CHANGED")
    assert.match(r.goal.reason, /ETH position changed outside the action/)
  })

  it("one raw unit of unexplained collateral is BASELINE_CHANGED", () => {
    const b = base()
    const post = structuredClone(b.post)
    post.collateral.unlocked += 1n
    settleBank(post)
    const r = recompute(input(b, { post }))
    assert.equal(r.goal.state, "BASELINE_CHANGED")
    assert.match(r.goal.reason, /unlocked moved by realized − funding − fees/)
  })

  it("a bank row for the owner in another transaction is BASELINE_CHANGED", () => {
    const b = base()
    const r = recompute(input(b, { externalLogs: [{ address: BANK, logIndex: 0, name: "Deposited", args: { account: ACCOUNT, amount: 1n } }] }))
    assert.equal(r.goal.state, "BASELINE_CHANGED")
  })

  it("a receipt that settles more funding than the position owed is BASELINE_CHANGED", () => {
    const b = base()
    const receipt = tampered(b, { logs: (ls) => ls.map((l) => (l.name === "FundingSettled" ? { ...l, args: { ...l.args, payment: usd("0.02") } } : l)) })
    const r = recompute(input(b, { receipt }))
    assert.equal(r.goal.state, "BASELINE_CHANGED")
    assert.match(r.goal.reason, /funding settled once/)
  })

  it("a reverted reduction with an unchanged account is GOAL_NOT_MET", () => {
    const b = base()
    const post = atBlock(b.snapshot, b.receipt.blockNumber)
    const receipt = tampered(b, { head: { status: "reverted" }, logs: () => [] })
    const r = recompute(input(b, { receipt, post }))
    assert.equal(r.binding.ok, true)
    assert.equal(r.fill.state, "NO_FILL")
    assert.equal(r.goal.state, "GOAL_NOT_MET")
  })

  it("a 'reverted' receipt that still carries fills is EVIDENCE_MISMATCH", () => {
    const b = base()
    const post = atBlock(b.snapshot, b.receipt.blockNumber)
    const receipt = tampered(b, { head: { status: "reverted" } })
    const r = recompute(input(b, { receipt, post }))
    assert.equal(r.goal.state, "EVIDENCE_MISMATCH")
  })

  it("without a receipt there is nothing to credit", () => {
    const r = recompute(input(base(), { receipt: null }))
    assert.equal(r.goal.state, "UNAVAILABLE")
    assert.equal(r.binding.ok, false)
  })
})

