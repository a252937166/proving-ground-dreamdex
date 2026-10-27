// Data behind the website: the evidence summary and the recorded runs, read from files
// under evidence/ (the live account analysis is in analyze.ts). It never signs or sends
// anything, and nothing here touches a key.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { slimCandidate } from "./analyze.js"
import type { CandidateAnalysis } from "./candidates.js"
import type { Scenario } from "./scenario.js"

const ROOT = new URL("../../", import.meta.url).pathname
const EVIDENCE = join(ROOT, "evidence/margin-rescue")
// The plan live run 1 executed, published with its evidence; before the run, the
// working copy's plan file (not committed).
const PLAN = [join(EVIDENCE, "live-write/run-1/live-plan.json"), join(ROOT, "live-plan.json")]

const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"))
const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null)

// "Ran 4 test suites …: 38 tests passed, 0 failed, 0 skipped (38 total tests)"
function forgeCounts(text: string | null) {
  const m = text && /(\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/.exec(text)
  return m ? { passed: Number(m[1]), failed: Number(m[2]), total: Number(m[4]) } : null
}

// node --test spec reporter footer: "ℹ tests 178" / "ℹ pass 178" / "ℹ fail 0"
function nodeTestCounts(text: string | null) {
  const n = (k: string) => Number(new RegExp(`ℹ ${k} (\\d+)`).exec(text ?? "")?.[1] ?? NaN)
  return text ? { passed: n("pass"), failed: n("fail"), total: n("tests") } : null
}

function gitHead(): { commit: string | null; branch: string | null } {
  try {
    const head = readFileSync(join(ROOT, ".git/HEAD"), "utf8").trim()
    if (!head.startsWith("ref: ")) return { commit: head, branch: null }
    const ref = head.slice(5)
    const loose = join(ROOT, ".git", ref)
    const commit = existsSync(loose)
      ? readFileSync(loose, "utf8").trim()
      : (readText(join(ROOT, ".git/packed-refs"))?.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? null)
    return { commit, branch: ref.replace("refs/heads/", "") }
  } catch {
    return { commit: null, branch: null }
  }
}

export function planSummary() {
  const path = PLAN.find((p) => existsSync(p))
  if (!path) return null
  const raw = readFileSync(path)
  const p = JSON.parse(raw.toString("utf8"))
  return {
    sha256: createHash("sha256").update(raw).digest("hex"),
    version: p.version,
    chainId: p.network?.chainId ?? 50383,
    readAt: p.readAt,
    account: p.account.address,
    depositUsdso: p.bounds.maxDepositUsdso,
    softStopUsdso: p.bounds.softLossStopUsdso,
    gasCapStt: p.bounds.gas.sttCap,
    worstCaseStt: p.bounds.gas.worstCaseSttAtCurrentPrice,
    transactions: p.bounds.gas.transactions,
    opening: p.bounds.openingNotionalUsdso,
  }
}

// Every proof the site shows, read from the evidence folder at request time.
export function proofSummary() {
  const rehearsals = readdirSync(join(EVIDENCE, "fork"))
    .filter((d) => d.startsWith("rehearsal-") && existsSync(join(EVIDENCE, "fork", d, "rehearsal.json")))
    .map((d) => {
      const r = readJson(join(EVIDENCE, "fork", d, "rehearsal.json"))
      return { forkBlock: r.forkBlock, dir: `fork/${d}`, outcomes: r.outcomes.map((o: any) => ({ scenario: o.scenario, pass: o.pass, expected: o.expected })) }
    })
  const e2eDir = join(EVIDENCE, "fork/e2e-33472615")
  const e2eRun = readJson(join(e2eDir, "run.json"))
  const e2eRecompute = readJson(join(e2eDir, "recompute.json"))
  const liveRo = join(EVIDENCE, "live-read-only")
  const reconciliations = readdirSync(liveRo)
    .filter((d) => d.startsWith("reconcile-") && existsSync(join(liveRo, d, "reconciliation.json")))
    .map((d) => {
      const r = readJson(join(liveRo, d, "reconciliation.json"))
      const s = readJson(join(liveRo, d, "snapshot.json"))
      return { account: r.account, block: r.block.number, verdict: r.verdict, markets: new Set(s.positions.map((p: any) => p.pool.toLowerCase())).size, orders: s.orders.length }
    })
    .sort((a, b) => a.markets - b.markets)
  const study = readJson(join(liveRo, "rounding-study.json"))
  return {
    generatedAt: new Date().toISOString(),
    git: gitHead(),
    fixture: {
      unit: nodeTestCounts(readText(join(EVIDENCE, "fixture/npm-test.txt"))),
      solidityMock: forgeCounts(readText(join(EVIDENCE, "fixture/forge-unit-mock.txt"))),
      typecheckClean: !/error TS\d+/.test(readText(join(EVIDENCE, "fixture/typecheck.txt")) ?? "error TS0"),
    },
    fork: {
      forgeFork: forgeCounts(readText(join(EVIDENCE, "fork/forge-fork-tests.txt"))),
      rehearsals,
      e2e: {
        forkBlock: e2eRun.forkBlock,
        account: e2eRun.account,
        selected: e2eRun.selected,
        goal: e2eRun.goal.state,
        tx: e2eRun.tx?.hash ?? e2eRecompute.tx.hash,
        filled: e2eRecompute.fill.filled,
        fills: e2eRecompute.fill.fills,
        baselineBuffer: e2eRecompute.baseline.scenario.buffer,
        actualBuffer: e2eRecompute.actual.scenario.buffer,
      },
    },
    liveReadOnly: {
      reconciliations,
      roundingStudy: { block: study.block.number, compared: study.compared, floorExact: study.equityFloorExact, truncExact: study.equityTruncExact, pools: study.pools, mismatches: study.mismatches.length },
    },
    liveWrite: { plan: planSummary(), run: runSummary(join(EVIDENCE, "live-write/run-1")) },
  }
}

function runSummary(dir: string) {
  if (!existsSync(join(dir, "result.json"))) return existsSync(dir) ? { state: "IN_PROGRESS" as const } : null
  const r = readJson(join(dir, "result.json"))
  return { state: "FINISHED" as const, status: r.status, exitCode: r.exitCode, reason: r.reason, rescue: r.rescue, sentTransactions: r.sentTransactions, verification: verificationSummary(dir) }
}

// tools/verify-live-run.ts: the run read back from the chain, independently of the executor.
function verificationSummary(dir: string) {
  if (!existsSync(join(dir, "verification.json"))) return null
  const v = readJson(join(dir, "verification.json"))
  return {
    verdict: v.verdict,
    verifiedAt: v.verifiedAt,
    endBlock: v.endBlock,
    reconciliation: v.reconciliation,
    rescue: v.rescue.tx ? { tx: v.rescue.tx, block: v.rescue.block, filled: v.rescue.filled, goal: v.rescue.goal, before: v.rescue.before.buffer, after: v.rescue.after.buffer, prices: v.rescue.scenario.prices } : null,
    checks: v.checks.map((c: { group: string; name: string; ok: boolean; detail: string }) => ({ group: c.group, name: c.name, ok: c.ok, detail: c.detail })),
  }
}

// ---- recorded runs (the app's third screen) ----

const RUNS = [
  { id: "live-1", kind: "live", dir: "live-write/run-1", label: "Live run 1 · Somnia Hideki" },
  { id: "fork-e2e", kind: "fork", dir: "fork/e2e-33472615", label: "Fork · real 6-market account" },
  { id: "fork-plan", kind: "fork", dir: "fork/rehearsal-33472615/happy", label: "Fork · rehearsal of the live plan" },
] as const

export function listRuns() {
  return RUNS.map((r) => ({ id: r.id, kind: r.kind, label: r.label, present: existsSync(join(EVIDENCE, r.dir, "recompute.json")) }))
}

export function readRun(id: string) {
  const run = RUNS.find((r) => r.id === id)
  if (!run) return null
  const dir = join(EVIDENCE, run.dir)
  const base = { id: run.id, kind: run.kind, label: run.label, evidence: `evidence/margin-rescue/${run.dir}` }
  if (!existsSync(join(dir, "recompute.json"))) return { ...base, present: false, progress: runSummary(dir), plan: run.kind === "live" ? planSummary() : null }

  const scenario = readJson<Scenario>(join(dir, "scenario.json"))
  const analysis = readJson<CandidateAnalysis>(join(dir, "candidates.json"))
  const recompute = readJson(join(dir, "recompute.json"))
  const result = existsSync(join(dir, "result.json")) ? readJson(join(dir, "result.json")) : null
  // run.json: the end-to-end script; a rehearsal scenario's fork block is in its parent's rehearsal.json.
  const meta = existsSync(join(dir, "run.json")) ? readJson(join(dir, "run.json")) : existsSync(join(dir, "../rehearsal.json")) ? readJson(join(dir, "../rehearsal.json")) : null
  const ledger = existsSync(join(dir, "run-ledger.json")) ? readJson(join(dir, "run-ledger.json")) : null
  const guard = existsSync(join(dir, "guard.json")) ? readJson(join(dir, "guard.json")) : null
  return {
    ...base,
    present: true,
    status: result?.status ?? (recompute.goal.state === "GOAL_MET" ? "COMPLETE" : "NOT_DEMONSTRATED"),
    exitCode: result?.exitCode ?? null,
    reason: result?.reason ?? null,
    account: scenario.account,
    forkBlock: meta?.forkBlock ?? null,
    scenario: { id: scenario.id, reference: scenario.reference, markets: scenario.markets.map((m) => ({ symbol: m.symbol, baseDecimals: m.baseDecimals, referenceMark: m.referenceMark, scenarioPrice: m.scenarioPrice, shockBps: m.shockBps })), targetBuffer: scenario.targetBuffer },
    analysis: { selected: analysis.selected, outcome: analysis.outcome, baseline: analysis.baseline, candidates: analysis.candidates.map(slimCandidate) },
    execution: { candidateId: recompute.candidateId, tx: recompute.tx, fill: recompute.fill, ledgerChecks: recompute.ledger.checks, externalChanges: recompute.externalChanges, postReconciliation: recompute.postReconciliation },
    recompute: { goal: recompute.goal, baseline: recompute.baseline.scenario, forecast: recompute.planned.scenario, actual: recompute.actual.scenario, currentHealth: recompute.actual.currentHealth, differences: recompute.differences },
    guard: guard ? { address: guard.guard, verified: guard.verified, deployTx: guard.deployTx } : meta ? { address: meta.guard, verified: true, deployTx: null } : null,
    steps: ledger?.steps.map((s: any) => ({ id: s.id, phase: s.phase, state: s.state, hash: s.hash ?? null, block: s.receipt?.blockNumber ?? null, fee: s.receipt?.fee ?? null })) ?? [],
    cleanup: result?.cleanup ? { verified: result.cleanup.checks.every((c: any) => c.ok), checks: result.cleanup.checks, final: result.cleanup.final ?? null } : null,
    gas: result?.gas ?? null,
    verification: verificationSummary(dir),
    files: readdirSync(dir).filter((f) => /\.(txt|md)$/.test(f)).sort(),
  }
}
