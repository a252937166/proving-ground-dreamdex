// How a recorded live run is shown (runState.ts, site.ts feeds, and the app's run screen,
// web/assets/runs.js, rendered as text from those feeds). FIXTURE TESTS: published
// bundles in a temporary repository; the verified case is the real-venue fork run of
// mr-fork-fixture.ts, read back through the replayed chain and published with the real
// publisher. Only an independently verified, exactly bound run is VERIFIED_COMPLETE;
// execution, the goal and cleanup are reported apart; a run that started is never shown
// as not started.
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, describe, it } from "node:test"
import { keccak256, toHex } from "viem"
import { prettyJson, sha256Hex } from "../../src/margin-rescue/json.js"
import { publishRun } from "../../src/margin-rescue/publication.js"
import { liveRunView } from "../../src/margin-rescue/runState.js"
import { listRuns, readRun } from "../../src/margin-rescue/site.js"
import { renderVerification, verifyRun } from "../../src/margin-rescue/verify.js"
import { loadFixture, replayClient, replayIndexer, writeRun } from "./mr-fork-fixture.js"

const fx = loadFixture()
// An executor cleanup report (cleanup.ts) that verified the end state, and one item it left.
const CHECKS = [
  { name: "no position in any of the factory's pools", ok: true, detail: "21 pools read" },
  { name: "bank balance withdrawn", ok: true, detail: "unlocked 0, locked 0" },
]
const CLEANED = { verified: true, closes: [], remaining: [], checks: CHECKS, final: null }
const LEFT = "ETH position -38400000000000000 still open after 3 guarded attempts; no unguarded order was sent"

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
    const second = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20, reason: "", rescue: null, cleanup: CLEANED })
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
    let v = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20, reason: "soft loss stop", rescue: null, cleanup: CLEANED }).publish()
    assert.deepEqual([v.state, v.cleanup.executorVerified, v.rescue.executorGoal], ["ABORTED", true, null])
    v = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "CLEANUP_INCOMPLETE", exitCode: 30, reason: "BTC left open", rescue: { tx: null, goal: "GOAL_MET", fill: "REQUESTED_FILL" }, cleanup: { ...CLEANED, verified: false, remaining: [LEFT] } }).publish()
    assert.deepEqual([v.state, v.cleanup.executorVerified, v.rescue.executorGoal, v.rescue.verifiedGoal], ["CLEANUP_INCOMPLETE", false, "GOAL_MET", null])
  })

  it("cleanup checks that all hold, with something remaining, are not a verified cleanup in the run state or the app's feed", () => {
    // As the executor writes it: verified false. The checks alone used to make the feed say verified.
    let r = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "CLEANUP_INCOMPLETE", exitCode: 30, reason: LEFT, rescue: null, cleanup: { ...CLEANED, verified: false, remaining: [LEFT] } })
    let v = r.publish()
    assert.deepEqual([v.state, v.cleanup.executorVerified], ["CLEANUP_INCOMPLETE", false])
    let shown = readRun("live-1", r.evidence) as any
    assert.equal(shown.partial, true)
    assert.ok(shown.cleanup.checks.length === 2 && shown.cleanup.checks.every((c: { ok: boolean }) => c.ok), "the passing checks are still shown")
    assert.deepEqual([shown.cleanup.verified, shown.cleanup.remaining], [false, [LEFT]])
    // A report that says verified while something remains is not believed, and the status
    // that relies on it is shown as the executor labels an unverified cleanup.
    r = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20, reason: "soft loss stop", rescue: null, cleanup: { ...CLEANED, remaining: [LEFT] } })
    v = r.publish()
    assert.deepEqual([v.state, v.cleanup.executorVerified], ["CLEANUP_INCOMPLETE", false])
    shown = readRun("live-1", r.evidence) as any
    assert.deepEqual([shown.cleanup.verified, shown.cleanup.remaining], [false, [LEFT]])
    // No checks, or no list of what remains, verified nothing.
    for (const cleanup of [{ ...CLEANED, checks: [] }, { verified: true, checks: CHECKS }]) {
      v = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "ABORTED", exitCode: 20, reason: "", rescue: null, cleanup }).publish()
      assert.deepEqual([v.state, v.cleanup.executorVerified], ["CLEANUP_INCOMPLETE", false], JSON.stringify(cleanup))
    }
  })

  it("a completed run whose own cleanup report still lists something is not VERIFIED_COMPLETE, even when the chain read-back finds the end state clean", async () => {
    const r = await verifiedFork((dir) => {
      const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))
      result.cleanup.remaining = [LEFT]
      writeFileSync(join(dir, "result.json"), JSON.stringify(result))
    })
    const v = r.publish()
    assert.equal(v.verification.state, "VALID", v.verification.problems.join("; "))
    assert.deepEqual([v.state, v.cleanup.executorVerified, v.cleanup.independentlyVerified], ["CLEANUP_INCOMPLETE", false, true])
    const full = readRun("live-1", r.evidence) as any
    assert.equal(full.partial, undefined, "the recomputation is still shown")
    assert.ok(full.cleanup.checks.every((c: { ok: boolean }) => c.ok))
    assert.deepEqual([full.cleanup.verified, full.cleanup.remaining], [false, [LEFT]])
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

describe("the app's run screen (web/assets/runs.js)", () => {
  // runs.js imports data.js, which reads the site's base path from the page; nothing else
  // in it touches a document. The import is by URL so the type checker leaves the JS alone.
  let views: { renderRun: (run: unknown) => string; renderPartialRun: (run: unknown) => string }
  before(async () => {
    ;(globalThis as { document?: unknown }).document = { documentElement: { dataset: {} } }
    views = await import(new URL("../../web/assets/runs.js", import.meta.url).href)
  })
  const REASON = "the receipt's calldata is not the confirmation's"
  // What recompute.ts writes when the receipt does not bind to the confirmation.
  const mismatch = (dir: string) => {
    const rc = JSON.parse(readFileSync(join(dir, "recompute.json"), "utf8"))
    rc.actual.scenario = null
    rc.goal = { state: "EVIDENCE_MISMATCH", reason: REASON }
    rc.differences.bufferVsForecast = null
    writeFileSync(join(dir, "recompute.json"), JSON.stringify(rc))
  }

  it("a recomputation without actual figures (EVIDENCE_MISMATCH) is shown as unavailable; the transaction, the failure and cleanup stay", async () => {
    const r = await verifiedFork((dir) => {
      mismatch(dir)
      const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))
      Object.assign(result, { status: "NOT_DEMONSTRATED", exitCode: 10, reason: `rescue goal EVIDENCE_MISMATCH: ${REASON}` })
      result.rescue.goal = "EVIDENCE_MISMATCH"
      writeFileSync(join(dir, "result.json"), JSON.stringify(result))
    })
    r.publish()
    const feed = readRun("live-1", r.evidence) as any
    assert.equal(feed.recompute.actual, null)
    const html = views.renderRun(feed)
    assert.match(html, /<span class="badge wait">Unavailable<\/span>/)
    assert.ok(html.includes(`Recomputation unavailable (evidence mismatch): ${REASON.replaceAll("'", "&#39;")}`), "the failure, with its reason")
    assert.ok(!html.includes('class="mmeter'), "no buffer is drawn from it")
    assert.ok(html.includes(feed.execution.tx.hash), "the transaction")
    assert.match(html, /Fills: /)
    assert.match(html, /Every transaction the run sent/)
    assert.ok(feed.steps.length > 0 && feed.steps.every((s: { hash: string }) => html.includes(s.hash)), "every step sent")
    assert.match(html, /<h2>Cleanup<\/h2><p class="status">Verified by the executor<\/p>/)
    assert.match(html, /<h2>Status<\/h2>/)
    assert.match(html, /Not demonstrated/)

    // A fork run in the same state keeps its own label.
    const evidence = mkdtempSync(join(tmpdir(), "mr-views-"))
    cpSync(new URL("../../evidence/margin-rescue/fork/rehearsal-33472615", import.meta.url).pathname, join(evidence, "fork", "rehearsal-33472615"), { recursive: true })
    mismatch(join(evidence, "fork", "rehearsal-33472615", "happy"))
    const fork = views.renderRun(readRun("fork-plan", evidence))
    assert.match(fork, /<span class="badge call big pop">evidence mismatch<\/span>/)
    assert.ok(fork.includes("Recomputation unavailable (evidence mismatch)"))
  })

  it("the cleanup panel lists what remains and says verified only on the complete condition", async () => {
    const r = synthetic([{ id: "deploy-guard", state: "CONFIRMED" }], { status: "CLEANUP_INCOMPLETE", exitCode: 30, reason: LEFT, rescue: null, cleanup: { ...CLEANED, verified: false, remaining: [LEFT] } })
    r.publish()
    const partial = views.renderPartialRun(readRun("live-1", r.evidence))
    assert.match(partial, /<h2>Cleanup<\/h2><p class="status">NOT verified by the executor · 1 item remaining<\/p>/)
    assert.ok(partial.includes(`Remaining: ${LEFT}`))
    assert.equal((partial.match(/class="icon ok-ink"/g) ?? []).length, CHECKS.length, "the checks that held are still shown as holding")

    const full = await verifiedFork((dir) => {
      const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))
      result.cleanup.remaining = [LEFT]
      writeFileSync(join(dir, "result.json"), JSON.stringify(result))
    })
    full.publish()
    const html = views.renderRun(readRun("live-1", full.evidence))
    assert.match(html, /<h2>Cleanup<\/h2><p class="status">NOT verified by the executor · 1 item remaining<\/p>/)
    assert.ok(html.includes(`Remaining: ${LEFT}`))
    assert.match(html, /Cleanup incomplete/)
    assert.match(html, /verified on read-back from the chain; NOT verified in the executor's own report/)
  })

  it("a verified run is drawn with its figures, as before", async () => {
    const r = await verifiedFork()
    r.publish()
    const html = views.renderRun(readRun("live-1", r.evidence))
    assert.ok(html.includes('class="mmeter'))
    assert.match(html, /it equals the forecast to the raw unit/)
    assert.match(html, /<h2>Cleanup<\/h2><p class="status">Verified by the executor<\/p>/)
    assert.ok(!html.includes("Remaining:") && !html.includes("unavailable"))
  })
})
