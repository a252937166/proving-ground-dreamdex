// `npm run mr:live`: the command around one live run (executor.ts). Before anything is
// signed it refuses unless --approve is the SHA-256 of the exact plan file, the key in
// MR_SIGNER_KEY belongs to the plan's account, the output folder is private (under the
// git-ignored .margin-rescue/ or outside the repository: never evidence/ or any other
// tracked path) and no earlier run of the account is unresolved. It never prints or
// writes the key or any signed bytes.
//
//   MR_SIGNER_KEY=… npm run mr:live -- --plan live-plan.json --approve <sha256> [--out DIR] [--rpc URL]
//   MR_SIGNER_KEY=… npm run mr:live -- --plan live-plan.json --approve <sha256> --out DIR --resume
//
// Without --out a run goes to .margin-rescue/live/run-<time>. Its evidence reaches the
// repository only through `npm run mr:publish-run`.
//
// Exit codes (EXIT in executor.ts): 0 COMPLETE by the executor's own checks (the
// independent read-back is `npm run mr:verify-run`); 1 REFUSED: nothing was signed;
// 2 SIGNED_NOT_SENT: a transaction was signed and none reached the node; 10
// NOT_DEMONSTRATED and 20 ABORTED, with cleanup verified; 30 CLEANUP_INCOMPLETE; 40
// UNRESOLVED_TX: a transaction may be pending or mined, nothing after it was sent; 50
// FAILED_AFTER_START: an unexpected error after transactions reached the network, none of
// them unresolved; 60 STATE_UNKNOWN: the run's own record cannot be read back.
//
// An unexpected error is never taken for a refusal. It is classified from the persisted
// run ledger and from this process's count of signatures and broadcasts, and the
// classification is written to result.json and results.jsonl. After 40, 50 or 60 nothing
// is started again: inspect, then resume the same run with --resume.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Hex, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains"
import { readBigJson, stopLister } from "./common.js"
import { describeEndpoint } from "./endpoints.js"
import { EXIT, RUN_VERSION, ResultNotPersistedError, runLive, type RunOptions, type RunResult, type RunStatus } from "./executor.js"
import { prettyJson, writeFileAtomic } from "./json.js"
import { readApprovedPlan } from "./livePlan.js"
import { localText, privateOutDir, realOf, REPO_ROOT, within } from "./paths.js"
import { createHidekiClient } from "./rpc.js"
import type { StopLister } from "./snapshot.js"
import { NOT_BROADCAST, type RunLedger, type RunTracker, type Signer, type TxStep } from "./txlog.js"

const UNSETTLED_RESULTS = ["UNRESOLVED_TX", "FAILED_AFTER_START", "STATE_UNKNOWN", "CLEANUP_INCOMPLETE"]

// Every run the command starts is recorded here first, wherever its folder is, so an
// unfinished run outside .margin-rescue/live/ still blocks a fresh one.
export const runRegistry = (root = REPO_ROOT) => join(root, ".margin-rescue", "live", "runs.jsonl")

// Run folders to check: those under .margin-rescue/live/ and every registered one, with the
// account it was registered for (null when the line cannot be read: then it counts for all).
function registeredRuns(root: string): { dir: string; account: string | null }[] {
  const base = join(root, ".margin-rescue", "live")
  const runs = existsSync(base) ? readdirSync(base).map((n) => ({ dir: join(base, n), account: null as string | null })).filter((r) => existsSync(join(r.dir, "run-ledger.json"))) : []
  if (existsSync(runRegistry(root))) {
    for (const line of readFileSync(runRegistry(root), "utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line) as { out: string; account: string }
        runs.push({ dir: e.out, account: e.account })
      } catch {
        runs.push({ dir: `(an unreadable line of ${runRegistry(root)})`, account: null })
      }
    }
  }
  const seen = new Map<string, string | null>()
  for (const r of runs) {
    const key = resolve(r.dir)
    if (!seen.has(key) || seen.get(key) === null) seen.set(key, r.account)
  }
  return [...seen.entries()].map(([dir, acct]) => ({ dir, account: acct }))
}

// Earlier runs of `account` that are not finished: an open transaction, transactions sent
// but no result, a result that needs a resume, or a run whose record cannot be read.
export function unresolvedRuns(account: string, root = REPO_ROOT, except?: string): { dir: string; reason: string }[] {
  const found: { dir: string; reason: string }[] = []
  for (const { dir, account: registeredFor } of registeredRuns(root)) {
    if (except && resolve(dir) === resolve(except)) continue
    if (registeredFor && registeredFor.toLowerCase() !== account.toLowerCase()) continue // another account's run (a fork rehearsal, say)
    const ledgerPath = join(dir, "run-ledger.json")
    if (!existsSync(dir)) {
      // A registered run whose folder is gone (moved, an unmounted disk) cannot be judged.
      found.push({ dir, reason: `its folder is missing; find it, or remove its line from ${runRegistry(root)} once its transactions are known` })
      continue
    }
    if (!existsSync(ledgerPath)) continue // never reached its ledger: nothing was sent
    let ledger: RunLedger
    try {
      ledger = readBigJson<RunLedger>(ledgerPath)
    } catch {
      found.push({ dir, reason: "its run ledger cannot be read" })
      continue
    }
    if (ledger.account.toLowerCase() !== account.toLowerCase()) continue
    const open = ledger.steps.filter((s) => s.state === "PENDING" || s.state === "UNKNOWN")
    if (open.length) {
      found.push({ dir, reason: `${open.length} transaction(s) unresolved` })
      continue
    }
    let status: string | null = null
    try {
      status = existsSync(join(dir, "result.json")) ? (JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as { status: string }).status : null
    } catch {
      found.push({ dir, reason: "its result cannot be read" })
      continue
    }
    if (status === null && broadcastOf(ledger).length) found.push({ dir, reason: "it sent transactions and has no result" })
    else if (status !== null && UNSETTLED_RESULTS.includes(status)) found.push({ dir, reason: `it ended ${status}` })
  }
  return found
}

const broadcastOf = (ledger: RunLedger) => ledger.steps.filter((s) => !s.history.some((h) => h.event === NOT_BROADCAST))

export interface Classification {
  status: RunStatus
  exitCode: number
  reason: string
  open: Pick<TxStep, "n" | "id" | "hash" | "nonce" | "state">[]
  broadcast: number
  ledger: RunLedger | null
}

// A run that ended in an error the executor did not handle, from what was persisted and
// what this process did. Conservative: unless nothing was signed (REFUSED) or nothing
// was broadcast (SIGNED_NOT_SENT), the run counts as started.
export function classifyFailure(ledgerPath: string, tracker: RunTracker, root = REPO_ROOT): Classification {
  const make = (status: RunStatus, reason: string, ledger: RunLedger | null = null, open: TxStep[] = []): Classification => ({
    status,
    exitCode: EXIT[status],
    reason,
    open: open.map((s) => ({ n: s.n, id: s.id, hash: s.hash, nonce: s.nonce, state: s.state })),
    broadcast: ledger ? broadcastOf(ledger).length : 0,
    ledger,
  })
  let ledger: RunLedger | null = null
  if (existsSync(ledgerPath)) {
    try {
      ledger = readBigJson<RunLedger>(ledgerPath)
    } catch (e) {
      return make("STATE_UNKNOWN", `the run ledger cannot be read (${firstLine(e, root)}); inspect the account on chain before anything else`)
    }
  }
  const steps = ledger?.steps ?? []
  const open = steps.filter((s) => s.state === "PENDING" || s.state === "UNKNOWN")
  const sent = ledger ? broadcastOf(ledger) : []
  if (tracker.broadcasts > 0 && sent.length === 0) return make("STATE_UNKNOWN", "this process broadcast a transaction the run ledger does not show", ledger)
  if (open.length) return make("UNRESOLVED_TX", `${open.length} transaction(s) pending or unknown; their worst-case fees stay reserved and nothing else is sent until they settle`, ledger, open)
  if (sent.length) return make("FAILED_AFTER_START", `${sent.length} transaction(s) of this run reached the network and none is unresolved`, ledger)
  if (tracker.signatures > 0 || steps.length) return make("SIGNED_NOT_SENT", "a transaction was signed but none reached the node", ledger)
  return make("REFUSED", "nothing was signed", ledger)
}

function firstLine(e: unknown, root = REPO_ROOT): string {
  return localText(String((e as Error)?.message ?? e).split("\n")[0], root).slice(0, 300)
}

// The classification as the run's result, best effort: a disk that refused result.json a
// moment ago may refuse it again, so it is also printed.
function persistClassification(out: string, c: Classification, reason: string, tracker: RunTracker, executorResult: RunResult | null, root: string): boolean {
  const ledger = c.ledger
  const spent = ledger?.steps.reduce((s, x) => s + (x.receipt?.fee ?? 0n), 0n) ?? 0n
  const committed = ledger?.steps.filter((x) => x.state === "PENDING" || x.state === "UNKNOWN").reduce((s, x) => s + x.maxCost, 0n) ?? 0n
  const result = {
    version: RUN_VERSION,
    status: c.status,
    exitCode: c.exitCode,
    reason: localText(`${reason}; ${c.reason}`, root),
    classifiedBy: "liveCli.ts after an unexpected error",
    process: { signatures: tracker.signatures, broadcasts: tracker.broadcasts },
    open: c.open,
    executorResult: executorResult ? { status: executorResult.status, reason: executorResult.reason === null ? null : localText(executorResult.reason, root), rescue: executorResult.rescue, cleanupVerified: executorResult.cleanup?.verified ?? null } : null,
    guard: null,
    rescue: null,
    invalidated: [],
    cleanup: null,
    foreignActivity: ledger?.foreignActivity ?? [],
    gas: { cap: ledger?.gasCap ?? null, spent, committed },
    sentTransactions: c.broadcast,
    logComplete: false,
  }
  try {
    writeFileAtomic(join(out, "result.json"), prettyJson(result))
    appendFileSync(join(out, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...result }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n")
    return true
  } catch {
    return false
  }
}

export interface CliDeps {
  root: string
  now: () => number
  createClient: (rpc: string) => PublicClient
  createSigner: (key: Hex) => Signer
  listStops: () => StopLister
  runLive: (opts: RunOptions) => Promise<RunResult>
  print: (line: string) => void
  printErr: (line: string) => void
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = {
    root: REPO_ROOT,
    now: Date.now,
    createClient: (rpc) => createHidekiClient(rpc, { timeoutMs: 600_000 }),
    createSigner: (key) => privateKeyToAccount(key),
    listStops: () => stopLister(),
    runLive,
    print: (l) => console.log(l),
    printErr: (l) => console.error(l),
    ...overrides,
  }
  const refuse = (reason: string) => {
    deps.printErr(`REFUSED (exit ${EXIT.REFUSED}): ${reason}. Nothing was signed or sent.`)
    return EXIT.REFUSED
  }
  let values: { plan?: string; approve?: string; rpc?: string; out?: string; resume?: boolean }
  try {
    values = parseArgs({ args: argv, options: { plan: { type: "string" }, approve: { type: "string" }, rpc: { type: "string" }, out: { type: "string" }, resume: { type: "boolean", default: false } } }).values
  } catch (e) {
    return refuse(firstLine(e, deps.root))
  }
  if (!values.plan || !values.approve) return refuse("--plan and --approve are required")
  if (values.resume && !values.out) return refuse("--resume needs the --out folder of the run")
  let approved: ReturnType<typeof readApprovedPlan>
  try {
    approved = readApprovedPlan(values.plan, values.approve)
  } catch (e) {
    return refuse(firstLine(e, deps.root))
  }
  const { plan, digest } = approved
  if (!env.MR_SIGNER_KEY) return refuse("MR_SIGNER_KEY is not set")
  let signer: Signer
  try {
    signer = deps.createSigner(env.MR_SIGNER_KEY as Hex)
  } catch {
    return refuse("MR_SIGNER_KEY is not a valid private key") // the key itself is never echoed
  }
  if (signer.address.toLowerCase() !== String(plan.account.address).toLowerCase()) return refuse("the signing key is not the plan's account")
  let out: string
  try {
    out = privateOutDir(values.out, deps.root, deps.now())
    if (!values.resume) {
      if (existsSync(join(out, "run-ledger.json"))) return refuse(`${values.out} already holds a run; resume it with --resume, or give a new folder`)
      const blocking = unresolvedRuns(signer.address, deps.root, out)
      if (blocking.length) {
        return refuse(`an earlier run of this account is not finished, so no fresh run is started: ${blocking.map((b) => `${relative(deps.root, b.dir)} (${b.reason})`).join("; ")}. Inspect it, then resume it with --resume --out <its folder>`)
      }
    } else if (!existsSync(join(out, "run-ledger.json"))) return refuse(`${values.out} holds no run to resume`)
    mkdirSync(out, { recursive: true })
    privateOutDir(out, deps.root) // again, now that the folder exists
    if (!values.resume) {
      mkdirSync(join(deps.root, ".margin-rescue", "live"), { recursive: true })
      appendFileSync(runRegistry(deps.root), JSON.stringify({ out: resolve(out), account: signer.address, planDigest: digest, startedAt: new Date(deps.now()).toISOString() }) + "\n")
    }
  } catch (e) {
    return refuse(firstLine(e, deps.root))
  }
  const shown = within(realOf(resolve(deps.root)), realOf(out)) ? relative(deps.root, out) : "a folder outside the repository"
  const rpc = values.rpc ?? hidekiTestnet.rpcUrls.default.http[0]
  const tracker: RunTracker = { signatures: 0, broadcasts: 0 }
  const log = (entry: Record<string, unknown>) => {
    const line = JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    deps.print(line)
    appendFileSync(join(out, "run-log.jsonl"), line + "\n") // a failure here is caught by the executor's log wrapper
  }
  try {
    log({ step: "start", planDigest: digest, account: signer.address, rpc: describeEndpoint(rpc), out: shown, resume: !!values.resume })
  } catch {
    // best effort; the run ledger is the record
  }
  const resumeHint = `npm run mr:live -- --plan ${values.plan} --approve ${digest} --out ${shown} --resume`
  try {
    const result = await deps.runLive({ plan, planDigest: digest, client: deps.createClient(rpc), signer, out, listStops: deps.listStops(), resume: values.resume, log, tracker })
    deps.print(`\n${result.status} (exit ${result.exitCode})${result.reason ? `: ${localText(result.reason, deps.root)}` : ""}\nrun folder (private): ${shown}`)
    if (result.status === "UNRESOLVED_TX") deps.print(`A transaction is unresolved and nothing after it was sent. Do not start a new run; when the RPC answers again: ${resumeHint}`)
    else if (result.sentTransactions > 0) deps.print(`Next: npm run mr:verify-run -- --run ${shown} --plan ${values.plan} --approved ${digest}`)
    return result.exitCode
  } catch (e) {
    const reason = localText(e instanceof ResultNotPersistedError ? e.message : `unexpected error: ${firstLine(e)}`, deps.root)
    // A resumed run that failed before this attempt signed or broadcast anything is as it
    // was: nothing is written, and the exit code is the run's own state, not a refusal (an
    // unresolved transaction stays 40).
    if (values.resume && tracker.signatures === 0 && tracker.broadcasts === 0) {
      const state = classifyFailure(join(out, "run-ledger.json"), tracker, deps.root)
      let recorded: { status: string; exitCode: number } | null = null
      try {
        recorded = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as { status: string; exitCode: number }
      } catch {
        // none, or unreadable: left as it is
      }
      // The executor may have read the run anew and reached a result it could not write
      // (say, cleanup found incomplete): that newer state wins over the old record, and a
      // success nobody could record is not reported as one.
      const fresh = e instanceof ResultNotPersistedError ? e.result : null
      const code = state.status === "UNRESOLVED_TX" || state.status === "STATE_UNKNOWN" ? state.exitCode : fresh ? (fresh.exitCode === 0 ? EXIT.FAILED_AFTER_START : fresh.exitCode) : !recorded || typeof recorded.exitCode !== "number" ? state.exitCode : recorded.exitCode
      deps.printErr(
        fresh
          ? `This resume signed and sent nothing; ${reason}. ${recorded && recorded.status !== fresh.status ? `result.json still says ${recorded.status}; ` : ""}exit ${code}${fresh.exitCode === 0 ? " (not 0: a result that could not be recorded is not reported as complete)" : ""}. Inspect the run folder, then resume again.`
          : `This resume stopped before signing anything (${reason}); nothing was sent and nothing was written. The run is unchanged: ${state.status === "UNRESOLVED_TX" ? state.reason : recorded ? `its record says ${recorded.status} (exit ${recorded.exitCode})` : state.reason}.`,
      )
      if (state.status === "UNRESOLVED_TX") deps.printErr(`When the RPC answers again: ${resumeHint}`)
      return code
    }
    const c = classifyFailure(join(out, "run-ledger.json"), tracker, deps.root)
    const persisted = persistClassification(out, c, reason, tracker, e instanceof ResultNotPersistedError ? e.result : null, deps.root)
    const lines = [`${c.status} (exit ${c.exitCode}): ${reason}`, c.reason]
    for (const s of c.open) lines.push(`  open: step ${s.n} ${s.id} ${s.hash} nonce ${s.nonce} (${s.state})`)
    lines.push(persisted ? `Recorded in ${shown}/result.json.` : `The classification could NOT be written to ${shown}: keep this output.`)
    if (c.status === "UNRESOLVED_TX") lines.push(`Do not start a new run. When the RPC answers again, resume this one: ${resumeHint}`)
    else if (c.status === "FAILED_AFTER_START") lines.push(`Do not start a new run. Inspect ${shown}/run-ledger.json, then resume (it resolves, cleans up through the guard and verifies): ${resumeHint}`)
    else if (c.status === "STATE_UNKNOWN") lines.push("Do not start a new run. Inspect the account on chain and the run folder before anything else.")
    else if (c.status === "SIGNED_NOT_SENT") lines.push("Nothing reached the network; the account is as it was. Find out why the run could not record its transaction before running again.")
    for (const l of lines) deps.printErr(localText(l, deps.root))
    return c.exitCode
  }
}
