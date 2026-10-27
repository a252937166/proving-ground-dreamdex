// How a recorded live run is shown (runState.ts, site.ts feeds). FIXTURE TESTS: published
// bundles in a temporary repository; the verified case is the real-venue fork run of
// mr-fork-fixture.ts, read back through the replayed chain and published with the real
// publisher. Only an independently verified, exactly bound run is VERIFIED_COMPLETE;
// execution, the goal and cleanup are reported apart; a run that started is never shown
// as not started.
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { keccak256, toHex } from "viem"
import { prettyJson, sha256Hex } from "../../src/margin-rescue/json.js"
import { publishRun } from "../../src/margin-rescue/publication.js"
import { liveRunView } from "../../src/margin-rescue/runState.js"
import { listRuns, readRun } from "../../src/margin-rescue/site.js"
import { renderVerification, verifyRun } from "../../src/margin-rescue/verify.js"
import { loadFixture, replayClient, replayIndexer, writeRun } from "./mr-fork-fixture.js"

const fx = loadFixture()

// A temporary repository with one private run folder, published to live-write/run-1.
function repo() {
  const root = mkdtempSync(join(tmpdir(), "mr-state-"))
  const from = join(root, ".margin-rescue", "live", "run-1")
  const evidence = join(root, "evidence", "margin-rescue")
  mkdirSync(from, { recursive: true })
  mkdirSync(join(evidence, "live-write"), { recursive: true })
  const plan = join(root, "live-plan.json")
  // The plan as authorized before the run: a content-addressed committed copy.
  const authorize = () => {
    mkdirSync(join(evidence, "live-read-only", "authorized"), { recursive: true })
    writeFileSync(join(evidence, "live-read-only", "authorized", `${sha256Hex(readFileSync(plan))}.json`), readFileSync(plan))
  }
  const publish = () => {
    const p = publishRun({ from, to: join(evidence, "live-write", "run-1"), plan, root, replace: true })
    assert.ok(p.ok, p.problems.join("; "))
    return liveRunView(join(evidence, "live-write", "run-1"))
  }
  return { root, from, evidence, plan, publish, authorize }
}

async function verifiedFork(edit?: (dir: string) => void) {
  const r = repo()
  writeRun(fx, r.from)
  writeFileSync(r.plan, fx.plan)
  edit?.(r.from)
  r.authorize()
  const report = await verifyRun({ dir: r.from, plan: r.plan, client: replayClient(fx), indexer: replayIndexer, rpc: "http://127.0.0.1:8553", approvedDigest: sha256Hex(fx.plan) })
  writeFileSync(join(r.from, "verification.json"), prettyJson(report))
  writeFileSync(join(r.from, "verification.txt"), renderVerification(report))
  return r
}

// A run folder that stopped somewhere, made up: the ledger's steps and the result.
function synthetic(steps: { id: string; state: string }[], result: Record<string, unknown> | null) {
  const r = repo()
  const account = "0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12"
  writeFileSync(r.plan, JSON.stringify({ version: "mr-live-plan/4", network: { chainId: 50383 }, account: { address: account } }))
  const digest = sha256Hex(readFileSync(r.plan))
  const ledger = { planDigest: digest, account, chainId: "50383", startNonce: 0, steps: steps.map((s, i) => ({ n: i + 1, id: s.id, phase: "main", hash: keccak256(toHex(`${s.id}-${i}`)), nonce: i, state: s.state, history: [{ event: "signed and persisted; broadcasting" }] })) }
  writeFileSync(join(r.from, "run-ledger.json"), JSON.stringify(ledger, null, 2))
  writeFileSync(join(r.from, "run-state.json"), JSON.stringify({ planDigest: digest, account, guard: null, rescueActionId: null }))
  if (result) writeFileSync(join(r.from, "result.json"), JSON.stringify(result))
  return r
}

describe("live run state", () => {
  it("a genuinely completed run, independently verified and bound to it, is VERIFIED_COMPLETE in every feed", async () => {
    const r = await verifiedFork()
    const v = r.publish()
    assert.equal(v.state, "VERIFIED_COMPLETE", v.verification.problems.join("; "))
    assert.equal(v.verification.state, "VALID")
    assert.deepEqual([v.rescue.executorGoal, v.rescue.verifiedGoal, v.cleanup.executorVerified, v.cleanup.independentlyVerified], ["GOAL_MET", "GOAL_MET", true, true])
    const listed = listRuns(r.evidence).find((x) => x.id === "live-1")!
    assert.deepEqual([listed.present, listed.state], [true, "VERIFIED_COMPLETE"])
    const full = readRun("live-1", r.evidence) as any
    assert.equal(full.live.state, "VERIFIED_COMPLETE")
    assert.ok(full.live.readBack, "the read-back's figures are served only because it is valid")
    assert.equal(full.partial, undefined)
  })

  it("a verified run whose plan was not authorized before the run is not verified", async () => {
    const r = await verifiedFork()
    rmSync(join(r.evidence, "live-read-only", "authorized"), { recursive: true })
    const v = r.publish()
    assert.deepEqual([v.state, v.verification.state, v.plan.authorized], ["COMPLETE_UNVERIFIED", "MISMATCHED", false])
    assert.match(v.verification.problems.join(" "), /not a plan authorized before the run/)
  })

  it("every published bundle is listed, the latest shown as the live run", async () => {
    const r = await verifiedFork()
    r.publish()
    const second = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20, reason: "", rescue: null, cleanup: { verified: true, checks: [] } })
    assert.throws(() => publishRun({ from: second.from, to: join(r.evidence, "live-write", "run-2"), plan: second.plan, root: second.root }), /not a bundle folder/, "a bundle is published only within its own repository")
    second.publish()
    cpSync(join(second.evidence, "live-write", "run-1"), join(r.evidence, "live-write", "run-2"), { recursive: true })
    const ids = listRuns(r.evidence).filter((x) => x.kind === "live").map((x) => `${x.id}:${x.state}`)
    assert.deepEqual(ids, ["live-1:VERIFIED_COMPLETE", "live-2:ABORTED"])
    assert.equal((readRun("live-2", r.evidence) as any).live.state, "ABORTED")
  })

  it("a malformed verification is a state, never an exception", async () => {
    const r = await verifiedFork()
    writeFileSync(join(r.from, "verification.json"), JSON.stringify({ binding: {} }))
    const v = r.publish()
    assert.deepEqual([v.state, v.verification.state], ["COMPLETE_UNVERIFIED", "MISMATCHED"])
    assert.doesNotThrow(() => listRuns(r.evidence))
  })

  it("a bound file that needed redaction still verifies, and its original's hash is published nowhere", async () => {
    const r = await verifiedFork((dir) => {
      const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))
      result.reason = "noted while writing /Users/someone/runs/result.json"
      writeFileSync(join(dir, "result.json"), JSON.stringify(result))
    })
    const original = sha256Hex(readFileSync(join(r.from, "result.json")))
    const v = r.publish()
    assert.equal(v.state, "VERIFIED_COMPLETE", v.verification.problems.join("; "))
    const bundle = join(r.evidence, "live-write", "run-1")
    for (const f of ["verification.json", "PUBLICATION.json", "SANITIZATION.md", "result.json"]) assert.ok(!readFileSync(join(bundle, f), "utf8").includes(original), f)
    assert.ok(!readFileSync(join(bundle, "result.json"), "utf8").includes("someone"))
  })

  it("executor success without a verification is not verified", async () => {
    const r = repo()
    writeRun(fx, r.from)
    writeFileSync(r.plan, fx.plan)
    const v = r.publish()
    assert.deepEqual([v.state, v.verification.state], ["COMPLETE_UNVERIFIED", "MISSING"])
    assert.equal((readRun("live-1", r.evidence) as any).live.readBack, null)
  })

  it("executor success with a failing verification is not verified", async () => {
    const r = await verifiedFork((dir) => {
      const rc = JSON.parse(readFileSync(join(dir, "recompute.json"), "utf8"))
      rc.actual.scenario.buffer = (BigInt(rc.actual.scenario.buffer) + 1n).toString()
      writeFileSync(join(dir, "recompute.json"), JSON.stringify(rc))
    })
    const v = r.publish()
    assert.deepEqual([v.state, v.verification.state], ["COMPLETE_UNVERIFIED", "FAILED"])
  })

  it("a verification copied from another run, or one whose evidence changed afterwards, is MISMATCHED", async () => {
    const r = await verifiedFork()
    const vpath = join(r.from, "verification.json")
    const report = JSON.parse(readFileSync(vpath, "utf8"))
    report.binding.account = "0x000000000000000000000000000000000000bEEF"
    writeFileSync(vpath, JSON.stringify(report))
    let v = r.publish()
    assert.deepEqual([v.state, v.verification.state], ["COMPLETE_UNVERIFIED", "MISMATCHED"])

    const r2 = await verifiedFork()
    const result = JSON.parse(readFileSync(join(r2.from, "result.json"), "utf8"))
    result.reason = "edited after the read-back"
    writeFileSync(join(r2.from, "result.json"), JSON.stringify(result))
    v = r2.publish()
    assert.deepEqual([v.state, v.verification.state], ["COMPLETE_UNVERIFIED", "MISMATCHED"])
    assert.match(v.verification.problems.join(" "), /result\.json/)
  })

  it("a verification made before the run sent more transactions is STALE", async () => {
    const r = await verifiedFork()
    const ledger = JSON.parse(readFileSync(join(r.from, "run-ledger.json"), "utf8"))
    ledger.steps.push({ ...ledger.steps.at(-1), n: ledger.steps.length + 1, id: "resumed-step", hash: keccak256(toHex("later")) })
    writeFileSync(join(r.from, "run-ledger.json"), JSON.stringify(ledger))
    const v = r.publish()
    assert.deepEqual([v.state, v.verification.state], ["COMPLETE_UNVERIFIED", "STALE"])
  })

  it("exit 40 before any recomputation: UNRESOLVED_TX, with what it sent, never 'not run'", () => {
    const r = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }, { id: "approve", state: "PENDING" }], { status: "UNRESOLVED_TX", exitCode: 40, reason: "approve is UNKNOWN", rescue: null, cleanup: null })
    const v = r.publish()
    assert.equal(v.state, "UNRESOLVED_TX")
    assert.deepEqual([v.started, v.execution.sentTransactions, v.execution.unresolved, v.execution.exitCode], [true, 2, 1, 40])
    const listed = listRuns(r.evidence).find((x) => x.id === "live-1")!
    assert.deepEqual([listed.present, listed.state], [true, "UNRESOLVED_TX"])
    const shown = readRun("live-1", r.evidence) as any
    assert.deepEqual([shown.present, shown.partial, shown.steps.length], [true, true, 2])
  })

  it("aborted runs and incomplete cleanup keep their own states; execution, goal and cleanup are separate", () => {
    let v = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20, reason: "soft loss stop", rescue: null, cleanup: { verified: true, checks: [] } }).publish()
    assert.deepEqual([v.state, v.cleanup.executorVerified, v.rescue.executorGoal], ["ABORTED", true, null])
    v = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "CLEANUP_INCOMPLETE", exitCode: 30, reason: "BTC left open", rescue: { tx: null, goal: "GOAL_MET", fill: "REQUESTED_FILL" }, cleanup: { verified: false, checks: [] } }).publish()
    assert.deepEqual([v.state, v.cleanup.executorVerified, v.rescue.executorGoal, v.rescue.verifiedGoal], ["CLEANUP_INCOMPLETE", false, "GOAL_MET", null])
  })

  it("not started, started without a result, and inconsistent results", () => {
    const empty = repo()
    assert.equal(liveRunView(join(empty.evidence, "live-write", "run-1")).state, "NOT_STARTED")
    assert.equal((readRun("live-1", empty.evidence) as any).present, false)
    const v = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], null).publish()
    assert.deepEqual([v.state, v.started], ["IN_PROGRESS", true])
    assert.equal(synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "REFUSED", exitCode: 1, reason: "", rescue: null, cleanup: null }).publish().state, "STATE_UNKNOWN", "a refusal with a sent transaction is not believed")
  })

  it("a raw or altered bundle shows nothing but its failure", () => {
    const r = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20 })
    r.publish()
    writeFileSync(join(r.evidence, "live-write", "run-1", "result.json"), JSON.stringify({ status: "COMPLETE", exitCode: 0 }))
    const v = liveRunView(join(r.evidence, "live-write", "run-1"))
    assert.deepEqual([v.state, v.started], ["INVALID_BUNDLE", true])
    assert.equal((readRun("live-1", r.evidence) as any).partial, true)
  })
})
