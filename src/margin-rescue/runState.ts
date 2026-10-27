// The state of a recorded live run, as every view of the site shows it: the generated
// feeds, the homepage, the dashboard and the app. Execution, the rescue goal and cleanup
// are kept apart, and VERIFIED_COMPLETE means one thing only: a published bundle that
// passes its publication check (publication.ts), an executor result of COMPLETE with
// GOAL_MET and its own cleanup verified, AND an independent verification (verify.ts)
// bound to this exact run, every check of which holds, made against the plan that was
// authorized before the run (a content-addressed copy committed in
// evidence/margin-rescue/live-read-only/authorized/<sha256>.json: the run's own files can
// name any plan). A missing, failed, stale or mismatched verification leaves an executor's
// COMPLETE as COMPLETE_UNVERIFIED. A run that started is never NOT_STARTED, with or
// without a recomputation.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { sha256Hex } from "./json.js"
import { validateBundle } from "./publication.js"
import { runBinding, type RunBinding } from "./verify.js"

export type LiveState =
  | "NOT_STARTED"
  | "INVALID_BUNDLE"
  | "IN_PROGRESS"
  | "REFUSED"
  | "SIGNED_NOT_SENT"
  | "UNRESOLVED_TX"
  | "ABORTED"
  | "NOT_DEMONSTRATED"
  | "CLEANUP_INCOMPLETE"
  | "FAILED_AFTER_START"
  | "STATE_UNKNOWN"
  | "COMPLETE_UNVERIFIED"
  | "VERIFIED_COMPLETE"

export type VerificationState = "VALID" | "MISSING" | "FAILED" | "STALE" | "MISMATCHED"

export interface LiveRunView {
  state: LiveState
  headline: string
  started: boolean
  bundle: { published: boolean; ok: boolean; problems: string[] }
  execution: { status: string | null; exitCode: number | null; reason: string | null; sentTransactions: number; unresolved: number }
  rescue: { executorGoal: string | null; verifiedGoal: string | null; tx: string | null; fill: string | null }
  cleanup: { executorVerified: boolean | null; independentlyVerified: boolean | null }
  verification: { state: VerificationState; problems: string[]; endBlock: string | null; checks: number; failed: number }
  plan: { digest: string | null; authorized: boolean }
}

// Is `digest` a plan authorized before the run: a committed copy whose content hashes to it?
export function authorizedPlan(evidence: string, digest: string | null): boolean {
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return false
  const path = join(evidence, "live-read-only", "authorized", `${digest}.json`)
  return existsSync(path) && sha256Hex(readFileSync(path)) === digest
}

const EXECUTOR_STATES: LiveState[] = ["REFUSED", "SIGNED_NOT_SENT", "UNRESOLVED_TX", "ABORTED", "NOT_DEMONSTRATED", "CLEANUP_INCOMPLETE", "FAILED_AFTER_START", "STATE_UNKNOWN"]

const HEADLINES: Record<LiveState, string> = {
  NOT_STARTED: "not started",
  INVALID_BUNDLE: "evidence present but failing its publication check, so nothing from it is shown",
  IN_PROGRESS: "started; no result recorded yet",
  REFUSED: "refused before signing anything; the account was not touched",
  SIGNED_NOT_SENT: "signed a transaction that never reached the network; the account was not touched",
  UNRESOLVED_TX: "stopped with a transaction unresolved; to be resumed",
  ABORTED: "aborted; cleanup verified by the executor",
  NOT_DEMONSTRATED: "ran, but the guarded reduction was not demonstrated; cleanup verified by the executor",
  CLEANUP_INCOMPLETE: "cleanup is not complete",
  FAILED_AFTER_START: "failed after its transactions reached the network; to be inspected and resumed",
  STATE_UNKNOWN: "its state could not be established; to be inspected",
  COMPLETE_UNVERIFIED: "the executor reports complete, but no valid independent verification is bound to this run",
  VERIFIED_COMPLETE: "goal met and cleanup verified, independently read back from the chain",
}

const readJson = <T>(path: string): T | null => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null
  } catch {
    return null
  }
}

// Is `v` the verification of the run whose current files give `now`?
export function verificationState(v: { binding?: RunBinding; verdict?: { allChecksHold?: boolean } } | null, now: RunBinding | null): { state: VerificationState; problems: string[] } {
  try {
    return judge(v, now)
  } catch {
    return { state: "MISMATCHED", problems: ["the verification is malformed"] }
  }
}

function judge(v: { binding?: RunBinding; verdict?: { allChecksHold?: boolean } } | null, now: RunBinding | null): { state: VerificationState; problems: string[] } {
  if (!v) return { state: "MISSING", problems: ["no verification.json"] }
  if (!v.binding || !now) return { state: "MISMATCHED", problems: ["the verification names no run binding"] }
  const b = v.binding
  const problems: string[] = []
  if (b.chainId !== now.chainId || b.account.toLowerCase() !== now.account.toLowerCase() || b.planDigest !== now.planDigest) problems.push("it verified another run (chain, account or plan)")
  if ((b.scenarioId ?? null) !== (now.scenarioId ?? null)) problems.push("it verified another scenario")
  const was = b.transactions.map((h) => h.toLowerCase())
  const is = now.transactions
  const extended = was.length < is.length && was.every((h, i) => h === is[i])
  if (!extended && JSON.stringify(was) !== JSON.stringify(is)) problems.push("it verified another set of transactions")
  const changed = [...new Set([...Object.keys(b.files), ...Object.keys(now.files)])].filter((f) => (b.files[f] ?? null) !== (now.files[f] ?? null))
  if (problems.length) return { state: "MISMATCHED", problems }
  if (extended) return { state: "STALE", problems: [`the run sent ${is.length - was.length} transaction(s) after it was verified`] }
  if (changed.length) return { state: "MISMATCHED", problems: [`evidence changed after it was verified: ${changed.join(", ")}`] }
  if (v.verdict?.allChecksHold !== true) return { state: "FAILED", problems: ["some of its checks fail"] }
  return { state: "VALID", problems: [] }
}

// Whatever the folder holds, the view is computed, never thrown: unreadable evidence is a
// state of its own, and never a verified one.
export function liveRunView(dir: string): LiveRunView {
  try {
    return readView(dir)
  } catch (e) {
    const started = existsSync(dir)
    return {
      state: started ? "STATE_UNKNOWN" : "NOT_STARTED",
      headline: started ? `its evidence could not be read (${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120)})` : HEADLINES.NOT_STARTED,
      started,
      bundle: { published: existsSync(join(dir, "PUBLICATION.json")), ok: false, problems: ["the evidence could not be read"] },
      execution: { status: null, exitCode: null, reason: null, sentTransactions: 0, unresolved: 0 },
      rescue: { executorGoal: null, verifiedGoal: null, tx: null, fill: null },
      cleanup: { executorVerified: null, independentlyVerified: null },
      verification: { state: "MISMATCHED", problems: ["the evidence could not be read"], endBlock: null, checks: 0, failed: 0 },
      plan: { digest: null, authorized: false },
    }
  }
}

function readView(dir: string): LiveRunView {
  const view: LiveRunView = {
    state: "NOT_STARTED",
    headline: HEADLINES.NOT_STARTED,
    started: false,
    bundle: { published: false, ok: false, problems: [] },
    execution: { status: null, exitCode: null, reason: null, sentTransactions: 0, unresolved: 0 },
    rescue: { executorGoal: null, verifiedGoal: null, tx: null, fill: null },
    cleanup: { executorVerified: null, independentlyVerified: null },
    verification: { state: "MISSING", problems: [], endBlock: null, checks: 0, failed: 0 },
    plan: { digest: null, authorized: false },
  }
  const set = (state: LiveState) => {
    view.state = state
    view.headline = HEADLINES[state]
    return view
  }
  if (!existsSync(dir)) return view
  view.started = true // a folder in live-write/ is a run that was at least attempted
  const bundle = validateBundle(dir)
  view.bundle = { published: existsSync(join(dir, "PUBLICATION.json")), ok: bundle.ok, problems: bundle.problems }
  if (!bundle.ok) return set("INVALID_BUNDLE")

  type Ledger = { steps: { state: string; history: { event: string }[] }[] }
  const ledger = readJson<Ledger>(join(dir, "run-ledger.json"))
  const steps = ledger?.steps ?? []
  view.execution.sentTransactions = steps.filter((s) => !s.history.some((h) => h.event === "not broadcast")).length
  view.execution.unresolved = steps.filter((s) => s.state === "PENDING" || s.state === "UNKNOWN").length

  type Result = { status: string; exitCode: number; reason: string | null; rescue: { tx: string | null; goal: string; fill: string } | null; cleanup: { verified: boolean } | null }
  const result = readJson<Result>(join(dir, "result.json"))
  type Verification = { binding?: RunBinding; approvedDigest?: string; verdict?: { allChecksHold?: boolean; goal?: string; cleanupVerified?: boolean }; endBlock?: { number: string }; checks?: { ok: boolean }[]; rescue?: { goal?: string } }
  const verification = readJson<Verification>(join(dir, "verification.json"))
  let now: RunBinding | null = null
  try {
    now = runBinding(dir)
  } catch {
    now = null
  }
  view.plan = { digest: now?.planDigest ?? null, authorized: authorizedPlan(dirname(dirname(dir)), now?.planDigest ?? null) }
  let vs = verificationState(verification, now)
  // Valid only against the approval: the plan committed before the run, and the digest
  // the verification itself was told was approved.
  if (vs.state === "VALID" && (!view.plan.authorized || verification?.approvedDigest !== now?.planDigest)) {
    vs = { state: "MISMATCHED", problems: [view.plan.authorized ? "it was checked against another approved plan" : "the run's plan is not a plan authorized before the run (live-read-only/authorized/)"] }
  }
  view.verification = { state: vs.state, problems: vs.problems, endBlock: verification?.endBlock?.number ?? null, checks: verification?.checks?.length ?? 0, failed: verification?.checks?.filter((c) => !c.ok).length ?? 0 }
  const valid = vs.state === "VALID"
  view.rescue = { executorGoal: result?.rescue?.goal ?? null, verifiedGoal: valid ? (verification?.verdict?.goal ?? null) : null, tx: result?.rescue?.tx ?? null, fill: result?.rescue?.fill ?? null }
  view.cleanup = { executorVerified: result?.cleanup ? result.cleanup.verified === true : null, independentlyVerified: valid ? verification?.verdict?.cleanupVerified === true : null }

  if (!result) return set("IN_PROGRESS")
  view.execution = { ...view.execution, status: result.status, exitCode: result.exitCode, reason: result.reason }
  if (result.status === "REFUSED" && view.execution.sentTransactions > 0) return set("STATE_UNKNOWN")
  if (result.status === "COMPLETE") {
    const verified = valid && verification?.verdict?.allChecksHold === true && view.rescue.verifiedGoal === "GOAL_MET" && view.rescue.executorGoal === "GOAL_MET" && view.cleanup.independentlyVerified === true && view.cleanup.executorVerified === true
    return set(verified ? "VERIFIED_COMPLETE" : "COMPLETE_UNVERIFIED")
  }
  return set(EXECUTOR_STATES.includes(result.status as LiveState) ? (result.status as LiveState) : "STATE_UNKNOWN")
}
