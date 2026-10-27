// Rehearse the LIVE executor (executor.ts, and liveRun.ts as a subprocess) on a local
// anvil fork of Hideki, with a throwaway key generated in memory for this run only,
// first as the live run would go and then with injected faults:
//
//   happy          liveRun.ts exactly as the live command runs it (plan digest, raw signing)
//   tamper         the happy run's own receipt and snapshots, altered, recomputed offline
//   book-change    a third party takes liquidity after the analysis: invalidate, re-confirm
//   funding-drift  an hourly funding settlement falls between the analysis and the
//                  refresh (needs a fork block 1–3 s before one: --block 33609475)
//   partial-fill   a third party takes liquidity right before the send: an actual partial fill
//   owner-change   the owner's key trades after the analysis: invalidate, then abort
//   timeout        the reduction is not mined in time: UNKNOWN, stop, then --resume
//   rpc-outage     the reduction IS mined, but receipt and transaction lookups time out:
//                  UNKNOWN with its fee reserved, nothing else sent; --resume after recovery
//   preflight-refusal  the account already holds collateral and an allowance: refused
//                  with nothing signed or sent, and the account left exactly as it was
//   cleanup-retries    interrupted after opening both legs (the owner also set an
//                  allowance meanwhile); each leg's first two guarded closes fill only a
//                  part, so cleanup needs all 12 reserved transactions
//   cleanup-fail   every guarded BTC close is refused in simulation: never broadcast, no
//                  unguarded fallback, exit 30
//   result-unwritable  liveRun.ts as the live command runs it, but result.json cannot be
//                  written at the end: exit 50 (FAILED_AFTER_START), every transaction
//                  settled in the ledger, nothing sent after the run's own steps
//
// The live command writes only to a private folder (.margin-rescue/), so `happy` and
// `result-unwritable` run it there and copy the folder into this rehearsal's evidence
// afterwards; `happy` is then read back with the independent verifier (verify.ts).
//
// Each scenario starts from the same funded fork state (evm_snapshot / evm_revert). The
// "third party" is a second throwaway account funded on the fork from the MarginBank's
// own USDso by impersonation; the clock is held at the fork block's timestamp unless a
// scenario moves it. Fork only: nothing reaches Hideki. Evidence is labelled "fork".
//
//   npm run rpc-shim &
//   (cd contracts && forge build)
//   npm run mr:fork-rehearsal -- [--block N] [--out DIR] [--only happy,timeout]
//   npm run mr:fork-rehearsal -- --block 33609475 --only funding-drift
import { spawn } from "node:child_process"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { encodeFunctionData, getContractAddress, parseAbi, TimeoutError, type Address, type Hex, type PublicClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { erc20Abi, marginBankAbi, marginBankWriteAbi, ORDER_TYPE_IOC, perpPoolAbi, SELF_MATCH_CANCEL_TAKER } from "./abi.js"
import { alignDown, protectiveLimit } from "./book.js"
import type { CandidateAnalysis } from "./candidates.js"
import { BTC_POOL, ETH_POOL, indexerWatermark, MARGIN_BANK, OPERATOR_REGISTRY, readAgain, readBigJson, stopLister, USDSO } from "./common.js"
import { loadConfig } from "../config.js"
import { renderVerification, verifyRun } from "./verify.js"
import { MAX_CLOSE_ATTEMPTS } from "./cleanup.js"
import { CLEANUP_GAS_PER_TX, CLEANUP_TX_WORST_CASE, runLive, type HookInfo, type RunResult, type Timing } from "./executor.js"
import { anvilVersion, checksums, startAnvil, stopAnvil, waitReceipt } from "./forkTools.js"
import { ActionJournal, type ActionRecord } from "./journal.js"
import { prettyJson, readJson, sha256Hex, writeFileAtomic } from "./json.js"
import { buildLivePlan, DEFAULT_PLAN, readApprovedPlan, TEST_EOA } from "./livePlan.js"
import { recompute } from "./recompute.js"
import { requestOf, type ActionReceipt } from "./receipt.js"
import { reduceCalldata } from "./action.js"
import { localText } from "./paths.js"
import { createHidekiClient, sampleBlock } from "./rpc.js"
import type { Scenario } from "./scenario.js"
import type { AccountSnapshot } from "./snapshot.js"
import type { RunLedger, Signer } from "./txlog.js"

const SCENARIOS = ["happy", "tamper", "book-change", "funding-drift", "partial-fill", "owner-change", "timeout", "rpc-outage", "preflight-refusal", "cleanup-retries", "cleanup-fail", "result-unwritable"] as const
type ScenarioName = (typeof SCENARIOS)[number]

// A cold fork can take minutes for a transaction that touches many order-book slots.
const FORK_TIMING: Timing = { receiptTimeoutMs: 900_000, resolveTimeoutMs: 60_000, pollMs: 1_000, deadlineSeconds: 180, closeDeadlineSeconds: 120, minSecondsLeft: 30 }

interface Outcome {
  scenario: ScenarioName
  expected: string
  observed: Record<string, unknown>
  checks: { name: string; ok: boolean; detail: string }[]
  pass: boolean
}

async function main() {
  const { values } = parseArgs({ options: { block: { type: "string", default: "33472615" }, port: { type: "string", default: "8548" }, upstream: { type: "string", default: "http://127.0.0.1:8546" }, out: { type: "string" }, only: { type: "string" } } })
  const block = BigInt(values.block!)
  const out = values.out ?? join("evidence", "margin-rescue", "fork", `rehearsal-${block}`)
  // funding-drift needs its own fork block (1–3 s before a funding settlement), so it
  // runs only when asked for: --block 33609475 --only funding-drift
  const only = (values.only?.split(",") ?? SCENARIOS.filter((x) => x !== "funding-drift")) as ScenarioName[]
  const rpc = `http://127.0.0.1:${values.port}`
  const anvil = await startAnvil(values.upstream!, block, values.port!)
  const outcomes: Outcome[] = []
  try {
    const client = createHidekiClient(rpc, { timeoutMs: 900_000 })
    const call = <T = unknown>(method: string, params: unknown[] = []) => client.request({ method, params } as never) as Promise<T>
    // Hold the clock: every block keeps the fork block's timestamp (marks expire in 5 s).
    const fork = await sampleBlock(client, block)
    await call("anvil_setBlockTimestampInterval", [0])
    await call("evm_setNextBlockTimestamp", [`0x${fork.timestamp.toString(16)}`])
    await call("evm_mine")

    // The owner (the account the plan is for) and a third party, both fork-only.
    const key = generatePrivateKey() // never written anywhere
    const owner = privateKeyToAccount(key).address
    const third = privateKeyToAccount(generatePrivateKey()).address
    const asImpersonated = async (from: Address, to: Address, data: Hex) => {
      await call("anvil_impersonateAccount", [from])
      const hash = await call<Hex>("eth_sendTransaction", [{ from, to, data, gas: "0x1c9c380" }])
      const receipt = await waitReceipt(client, hash)
      await call("anvil_stopImpersonatingAccount", [from])
      if (receipt.status !== "success") throw new Error(`fork setup transaction from ${from} reverted`)
      return receipt
    }
    const transfer = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"])
    await call("anvil_setBalance", [owner, "0x8ac7230489e80000"]) // 10 STT
    await call("anvil_setBalance", [third, "0x56bc75e2d63100000"]) // 100 STT
    await call("anvil_setBalance", [MARGIN_BANK, "0x8ac7230489e80000"])
    await asImpersonated(TEST_EOA, USDSO, encodeFunctionData({ abi: transfer, functionName: "transfer", args: [owner, 100n * 10n ** 18n] }))
    const thirdFunds = 1_000_000n * 10n ** 18n
    await asImpersonated(MARGIN_BANK, USDSO, encodeFunctionData({ abi: transfer, functionName: "transfer", args: [third, thirdFunds] }))
    await asImpersonated(third, USDSO, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, thirdFunds] }))
    await asImpersonated(third, MARGIN_BANK, encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [thirdFunds] }))

    mkdirSync(out, { recursive: true })
    const plan = await buildLivePlan(client, undefined, { ...DEFAULT_PLAN, account: owner })
    const planPath = join(out, "live-plan.fork.json")
    writeFileAtomic(planPath, prettyJson({ ...plan, status: "FORK REHEARSAL — throwaway account funded on a local fork; not a live plan" }))
    const digest = sha256Hex(readFileSync(planPath))
    const { plan: approved } = readApprovedPlan(planPath, digest)
    console.log(`fork of block ${block} (${fork.hash}); owner ${owner}; third party ${third}; plan digest ${digest}`)
    let base = await call<Hex>("evm_snapshot")

    // The third party takes the side the owner's order would take, inside `limit`,
    // leaving `keep` of it on the book.
    const take = async (pool: Address, takerIsBid: boolean, limit: bigint, keep: bigint) => {
      const [levels, grid] = await Promise.all([
        client.readContract({ address: pool, abi: perpPoolAbi, functionName: "getBookLevels", args: [!takerIsBid, 200n] }),
        client.readContract({ address: pool, abi: perpPoolAbi, functionName: "getOrderBookParameters" }),
      ])
      const inside = levels.filter((l) => (takerIsBid ? l.price <= limit : l.price >= limit)).reduce((s, l) => s + l.quantity, 0n)
      const qty = alignDown(inside > keep ? inside - keep : 0n, grid.lotSize)
      if (qty < grid.minQuantity) return 0n
      const now = (await client.getBlock()).timestamp
      await asImpersonated(third, pool, encodeFunctionData({ abi: perpPoolAbi, functionName: "placeOrder", args: [takerIsBid, 0n, limit, qty, (now + 60n) * 1_000_000_000n, ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, "0x0000000000000000000000000000000000000000", 0n] }))
      return qty
    }

    // The live command (liveRun.ts) in a private folder, as the owner runs it, then copied
    // into this rehearsal's evidence. `prepare` may alter the private folder first.
    const liveCommand = async (dir: string, prepare?: (priv: string) => void): Promise<number> => {
      const priv = join(".margin-rescue", "fork-rehearsal", `${block}-${process.pid}-${Date.now()}`)
      mkdirSync(priv, { recursive: true })
      prepare?.(priv)
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/margin-rescue/liveRun.ts", "--plan", planPath, "--approve", digest, "--rpc", rpc, "--out", priv], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, MR_SIGNER_KEY: key } })
        child.on("exit", (c) => resolve(c ?? 1))
      })
      // The directory planted in place of result.json is not evidence.
      const resultPath = join(priv, "result.json")
      if (existsSync(resultPath) && statSync(resultPath).isDirectory()) rmSync(resultPath, { recursive: true })
      cpSync(priv, dir, { recursive: true })
      return code
    }

    const runIn = (dir: string, hooks: Parameters<typeof runLive>[0]["hooks"] = {}, timing: Timing = FORK_TIMING, resume = false, use: { client?: PublicClient; signer?: Signer } = {}): Promise<RunResult> =>
      runLive({ plan: approved, planDigest: digest, client: use.client ?? client, signer: use.signer ?? privateKeyToAccount(key), out: dir, listStops: stopLister(), timing, resume, hooks, log: (e) => appendFileSync(join(dir, "run-log.jsonl"), JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n") })

    for (const name of only) {
      if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario ${name}`)
      if (name !== "tamper") {
        await call("evm_revert", [base])
        base = await call<Hex>("evm_snapshot")
      }
      const dir = join(out, name)
      mkdirSync(dir, { recursive: true })
      console.log(`\n== ${name}`)
      const started = Date.now()
      let outcome: Outcome
      try {
        outcome = await scenario(name, dir)
      } catch (e) {
        // A scenario that cannot reach its checks is a failed scenario, not the end of the rehearsal.
        const error = localText(String((e as Error)?.message ?? e).split("\n")[0])
        outcome = { scenario: name, expected: "the scenario runs to its checks", observed: { error }, checks: [{ name: "the scenario ran to its checks", ok: false, detail: error }], pass: false }
      }
      outcome.observed.seconds = Math.round((Date.now() - started) / 1000)
      outcomes.push(outcome)
      writeFileAtomic(join(dir, "outcome.json"), prettyJson(outcome))
      console.log(`${outcome.pass ? "PASS" : "FAIL"} ${name}: ${outcome.checks.filter((c) => !c.ok).map((c) => c.name).join("; ") || "all checks hold"}`)
    }

    async function scenario(name: ScenarioName, dir: string): Promise<Outcome> {
      const checks: Outcome["checks"] = []
      const check = (n: string, ok: boolean, detail: unknown = "") => checks.push({ name: n, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) })
      const done = (expected: string, observed: Record<string, unknown>): Outcome => ({ scenario: name, expected, observed, checks, pass: checks.every((c) => c.ok) })
      const ledgerOf = (d: string) => readBigJson<RunLedger>(join(d, "run-ledger.json"))
      const commonChecks = (r: RunResult, d: string) => {
        const ledger = ledgerOf(d)
        // Cleanup may call only the guard (orders), the registry (grants), the bank
        // (withdraw) and the token (allowance): never a pool directly.
        const allowed = [r.guard, OPERATOR_REGISTRY, MARGIN_BANK, USDSO].map((a) => a?.toLowerCase())
        check("every cleanup order went through the guard", ledger.steps.every((s) => s.phase !== "cleanup" || allowed.includes(s.to?.toLowerCase())), ledger.steps.filter((s) => s.phase === "cleanup").map((s) => `${s.id}→${s.to}`))
        const sent = ledger.steps.filter((s) => s.state !== "NOT_INCLUDED")
        check("no transaction was sent twice", new Set(sent.map((s) => s.hash)).size === sent.length && new Set(sent.map((s) => s.nonce)).size === sent.length, ledger.steps.map((s) => `${s.n}:${s.id}:${s.nonce}:${s.state}`))
        check("deployed guard verified against the approved runtime hash", readJson<{ verified: boolean }>(join(d, "guard.json")).verified, "guard.json")
        return ledger
      }

      if (name === "happy") {
        const code = await liveCommand(dir)
        const r = readBigJson<RunResult>(join(dir, "result.json"))
        commonChecks(r, dir)
        check("liveRun.ts exit code 0", code === 0, String(code))
        check("status COMPLETE", r.status === "COMPLETE", r.status)
        check("guarded reduction GOAL_MET", r.rescue?.goal === "GOAL_MET", r.rescue)
        check("receipt bound to the confirmation", readBigJson<{ binding: { ok: boolean } }>(join(dir, "recompute.json")).binding.ok, "recompute.json binding")
        check("cleanup verified", r.cleanup?.verified === true, r.cleanup?.checks.filter((c) => !c.ok))
        const cfg = loadConfig()
        const report = await verifyRun({ dir, plan: planPath, client, indexer: { watermark: () => readAgain(() => indexerWatermark(cfg.indexerUrl)), listStops: stopLister(cfg.indexerUrl) }, rpc, approvedDigest: digest })
        writeFileAtomic(join(dir, "verification.json"), prettyJson(report))
        writeFileAtomic(join(dir, "verification.txt"), renderVerification(report))
        check("independent read-back (verify.ts): every check holds", report.verdict.allChecksHold, report.checks.filter((c) => !c.ok))
        check("independent read-back reaches GOAL_MET from the chain", report.verdict.goal === "GOAL_MET", report.verdict.goal)
        return done("exit 0, COMPLETE, GOAL_MET, cleanup verified, and the independent read-back holds", { exitCode: code, status: r.status, rescue: r.rescue, gas: r.gas, readBack: `${report.checks.filter((c) => c.ok).length}/${report.checks.length}` })
      }

      if (name === "result-unwritable") {
        const startNonce = await client.getTransactionCount({ address: owner })
        const code = await liveCommand(dir, (priv) => mkdirSync(join(priv, "result.json"), { recursive: true }))
        const ledger = ledgerOf(dir)
        const settled = ledger.steps.every((x) => x.state === "CONFIRMED" || x.state === "REVERTED")
        const nonceAfter = await client.getTransactionCount({ address: owner })
        check("liveRun.ts exit code 50 (FAILED_AFTER_START), not 1", code === 50, String(code))
        check("every transaction of the run is settled in its ledger", ledger.steps.length > 0 && settled, ledger.steps.map((x) => `${x.id}:${x.state}`))
        check("nothing was sent besides the ledger's own steps", nonceAfter === startNonce + ledger.steps.length, `nonce ${startNonce} → ${nonceAfter}, ${ledger.steps.length} steps`)
        check("cleanup ran before the result write failed", readJson<{ verified: boolean }>(join(dir, "cleanup.json")).verified, "cleanup.json")
        return done("exit 50 with a complete, settled ledger; no transaction beyond it", { exitCode: code, steps: ledger.steps.length, nonce: [startNonce, nonceAfter] })
      }

      if (name === "tamper") {
        const src = join(out, "happy")
        const r = readBigJson<RunResult>(join(src, "result.json"))
        const record = new ActionJournal(join(src, "journal")).get(r.rescue!.actionId)
        const scenarioFile = readJson<Scenario>(join(src, "scenario.json"))
        const analysis = readBigJson<CandidateAnalysis>(join(src, "refresh-analysis.json"))
        const pre = readBigJson<AccountSnapshot>(join(src, "preflight-snapshot.json"))
        const post = readBigJson<AccountSnapshot>(join(src, "post-snapshot.json"))
        const receipt = readBigJson<ActionReceipt>(join(src, "receipt.json"))
        const base = { confirmation: record, scenario: scenarioFile, analysis, pre, post, receipt, externalLogs: [] }
        const variants: [string, Parameters<typeof recompute>[0]][] = [
          ["as recorded", base],
          ["guard event with another action id", { ...base, receipt: { ...receipt, guard: { ...receipt.guard!, actionId: `0x${"ab".repeat(32)}` as Hex } } }],
          ["calldata for a different limit", { ...base, receipt: { ...receipt, tx: { ...receipt.tx, input: reduceCalldata({ ...requestOf(record), limitPrice: requestOf(record).limitPrice + 1n }) } } }],
          ["another destination", { ...base, receipt: { ...receipt, to: third, tx: { ...receipt.tx, to: third } } }],
          ["another sender", { ...base, receipt: { ...receipt, from: third, tx: { ...receipt.tx, from: third } } }],
          ["post snapshot from the block before the receipt", { ...base, post: { ...post, block: { ...post.block, number: post.block.number - 1n } } }],
          ["a confirmation for another quantity", { ...base, confirmation: { ...record, request: { ...record.request, quantity: (BigInt(record.request.quantity) - 1n).toString() } } as ActionRecord }],
        ]
        const results = variants.map(([label, input]) => {
          const x = recompute(input)
          return { label, goal: x.goal.state, binding: x.binding }
        })
        writeFileAtomic(join(dir, "tamper-checks.json"), prettyJson({ label: "fork (offline recomputation of the happy run's evidence)", source: src, results }))
        check("the recorded evidence recomputes to GOAL_MET", results[0].goal === "GOAL_MET", results[0])
        for (const x of results.slice(1)) check(`${x.label} → EVIDENCE_MISMATCH`, x.goal === "EVIDENCE_MISMATCH", x.binding.failures)
        return done("recorded → GOAL_MET; every altered variant → EVIDENCE_MISMATCH", { results: results.map((x) => `${x.label}: ${x.goal}`) })
      }

      if (name === "book-change") {
        let taken = 0n
        const r = await runIn(dir, {
          beforeRefresh: async (i: HookInfo) => {
            if (i.attempt !== 1) return
            const q = i.record!.request
            taken = await take(q.pool, q.isBid, BigInt(q.limitPrice), BigInt(q.quantity) / 2n)
          },
        })
        commonChecks(r, dir)
        const first = r.invalidated[0]
        check("the third party took liquidity after the analysis", taken > 0n, String(taken))
        check("the first confirmation was invalidated by the refresh", r.invalidated.length === 1 && /now fills/.test(first?.reasons.join("; ") ?? ""), first)
        check("the invalidated confirmation was never sent", !new ActionJournal(join(dir, "journal")).get(first.actionId).tx.hash, first.actionId)
        check("a new confirmation under the same scenario was sent and bound", !!r.rescue && r.rescue.actionId !== first.actionId && r.rescue.txState === "CONFIRMED", r.rescue)
        check("status COMPLETE or NOT_DEMONSTRATED with cleanup verified", (r.status === "COMPLETE" || r.status === "NOT_DEMONSTRATED") && r.cleanup?.verified === true, `${r.status} ${r.reason ?? ""}`)
        return done("first confirmation INVALIDATED (book changed), one re-confirmation under the same scenario sent; cleanup verified", { status: r.status, exitCode: r.exitCode, invalidated: r.invalidated, rescue: r.rescue, thirdPartyTook: taken })
      }

      if (name === "funding-drift") {
        // Funding on this deployment settles hourly: the projected index is flat between
        // settlements and steps at lastFundingUpdate + interval (observed live at block
        // 33609480). Fork 1–3 s before a step (block 33609475 is 1 s before BTC's) and
        // cross it between the analysis and the refresh; marks stay inside their 5 s.
        const fundingAbi = parseAbi([
          "function getLastFundingUpdateTimestampNs() view returns (uint64)",
          "function getFundingParameters() view returns ((uint256 fundingCalculationWindowSec, uint256 fundingSettlementIntervalSec, int256 interestRatePerWindow, uint256 maxFundingRatePerWindow, uint256 dampener, uint256 emaSmoothingAlpha, uint256 maxOracleStalenessSec))",
        ])
        let crossed: { from: bigint; to: bigint } | null = null
        const r = await runIn(dir, {
          beforeRefresh: async (i: HookInfo) => {
            if (i.attempt !== 1) return
            const now = (await client.getBlock()).timestamp
            const steps = await Promise.all(
              [BTC_POOL, ETH_POOL].map(async (pool) => {
                const [last, params] = await Promise.all([client.readContract({ address: pool, abi: fundingAbi, functionName: "getLastFundingUpdateTimestampNs" }), client.readContract({ address: pool, abi: fundingAbi, functionName: "getFundingParameters" })])
                return last / 1_000_000_000n + params.fundingSettlementIntervalSec
              }),
            )
            const next = steps.filter((x) => x > now).sort((a, b) => (a < b ? -1 : 1))[0]
            if (next === undefined || next - now > 3n) throw new Error(`the fork clock ${now} is not within 3 s of a funding settlement (${steps.join(", ")}); fork 1–3 s before one, e.g. --block 33609475`)
            crossed = { from: now, to: next }
            await call("evm_setNextBlockTimestamp", [`0x${next.toString(16)}`])
            await call("evm_mine")
          },
        })
        commonChecks(r, dir)
        const refresh = readBigJson<{ verdict: string; reasons: string[]; fundingDrift: bigint }>(join(dir, "refresh-1.json"))
        const rc = readBigJson<{ ledger: { fundingSettled: bigint; checks: { ok: boolean; name: string }[] }; binding: { ok: boolean }; differences: { untouchedLegsFundingDrift: bigint; bufferVsForecast: bigint | null }; goal: { state: string } }>(join(dir, "recompute.json"))
        check("the clock crossed a funding settlement between the analysis and the refresh", crossed !== null, crossed)
        check("the refresh kept the confirmation (accrual is not a structural change)", refresh.verdict === "STILL_VALID", refresh.reasons)
        check("the refresh reported non-zero funding drift", refresh.fundingDrift !== 0n, String(refresh.fundingDrift))
        check("the reduction settled the drifted funding, and every ledger check holds", rc.ledger.fundingSettled !== 0n && rc.ledger.checks.every((c) => c.ok), { fundingSettled: rc.ledger.fundingSettled, failed: rc.ledger.checks.filter((c) => !c.ok) })
        check("the receipt is bound to the confirmation", rc.binding.ok, rc.binding)
        check("status COMPLETE and cleanup verified", r.status === "COMPLETE" && r.cleanup?.verified === true, `${r.status} ${r.reason ?? ""}`)
        return done("a funding settlement crossed after the analysis: STILL_VALID with the drift reported; the reduction settles the drifted funding exactly; COMPLETE", { status: r.status, crossed, fundingDrift: refresh.fundingDrift, fundingSettled: rc.ledger.fundingSettled, untouchedLegsFundingDrift: rc.differences.untouchedLegsFundingDrift, bufferVsForecast: rc.differences.bufferVsForecast, goal: rc.goal.state })
      }

      if (name === "partial-fill") {
        let taken = 0n
        const r = await runIn(dir, {
          beforeReduceSend: async (i: HookInfo) => {
            const q = i.record!.request
            taken = await take(q.pool, q.isBid, BigInt(q.limitPrice), BigInt(q.quantity) / 2n)
          },
        })
        commonChecks(r, dir)
        const rc = readBigJson<{ fill: { state: string; filled: bigint; requested: bigint }; ledger: { checks: { ok: boolean; name: string }[] }; binding: { ok: boolean }; goal: { state: string } }>(join(dir, "recompute.json"))
        check("the third party took liquidity right before the send", taken > 0n, String(taken))
        check("the guarded IOC filled only part of the request", rc.fill.state === "PARTIAL_FILL" && rc.fill.filled > 0n && rc.fill.filled < rc.fill.requested, rc.fill)
        check("the receipt is bound to the confirmation", rc.binding.ok, rc.binding)
        check("every ledger check holds for the actual fill", rc.ledger.checks.every((c) => c.ok), rc.ledger.checks.filter((c) => !c.ok))
        check("the goal is computed from the actual fill (not GOAL_MET by forecast)", rc.goal.state === "GOAL_MET" || rc.goal.state === "GOAL_NOT_MET", rc.goal)
        check("exit code is 0 only if the actual fill still met the goal", (r.exitCode === 0) === (rc.goal.state === "GOAL_MET"), `${r.exitCode} ${rc.goal.state}`)
        check("cleanup verified", r.cleanup?.verified === true, r.cleanup?.remaining)
        return done("PARTIAL_FILL recomputed from the fills; exit 10 unless the actual fill still meets the goal; cleanup verified", { status: r.status, exitCode: r.exitCode, fill: rc.fill, goal: rc.goal, thirdPartyTook: taken })
      }

      if (name === "owner-change") {
        let injected: Hex | null = null
        const r = await runIn(dir, {
          beforeRefresh: async (i: HookInfo) => {
            if (i.attempt !== 1) return
            // The owner trades in another tool after the analysis: a quarter of the confirmed leg.
            const q = i.record!.request
            const grid = await client.readContract({ address: q.pool, abi: perpPoolAbi, functionName: "getOrderBookParameters" })
            const qty = alignDown((BigInt(q.expectedSignedSize) < 0n ? -BigInt(q.expectedSignedSize) : BigInt(q.expectedSignedSize)) / 4n, grid.lotSize)
            const touch = (await client.readContract({ address: q.pool, abi: perpPoolAbi, functionName: "getBookLevels", args: [!q.isBid, 1n] }))[0].price
            const now = (await client.getBlock()).timestamp
            const rcpt = await asImpersonated(i.owner, q.pool, encodeFunctionData({ abi: perpPoolAbi, functionName: "placeOrder", args: [q.isBid, 0n, protectiveLimit(touch, q.isBid, 50n, grid.tickSize), qty < grid.minQuantity ? grid.minQuantity : qty, (now + 60n) * 1_000_000_000n, ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, "0x0000000000000000000000000000000000000000", 0n] }))
            injected = rcpt.transactionHash
          },
        })
        commonChecks(r, dir)
        const journal = new ActionJournal(join(dir, "journal"))
        const rescues = journal.list().filter((x) => x.kind === "RESCUE")
        check("the owner's own trade landed after the analysis", !!injected, String(injected))
        check("the refresh invalidated the first confirmation (position changed)", /position changed/.test(r.invalidated[0]?.reasons.join("; ") ?? ""), r.invalidated)
        check("no rescue confirmation was ever sent", rescues.every((x) => !x.tx.hash && x.tx.state === "INVALIDATED"), rescues.map((x) => `${x.actionId.slice(0, 10)} ${x.tx.state}`))
        check("the run detected the foreign transaction and aborted", r.status === "ABORTED" && r.exitCode === 20 && r.foreignActivity.length > 0, `${r.status} ${r.reason}`)
        check("cleanup verified despite the foreign transaction", r.cleanup?.verified === true, r.cleanup?.remaining)
        return done("INVALIDATED (position changed); nothing sent; ABORTED on foreign activity (exit 20); cleanup verified", { status: r.status, exitCode: r.exitCode, invalidated: r.invalidated, foreignActivity: r.foreignActivity, injected })
      }

      if (name === "timeout") {
        const short: Timing = { ...FORK_TIMING, receiptTimeoutMs: 4_000, resolveTimeoutMs: 4_000, pollMs: 500 }
        const r = await runIn(dir, { beforeReduceSend: async () => void (await call("evm_setAutomine", [false])) }, short)
        const ledger = ledgerOf(dir)
        const last = ledger.steps.at(-1)!
        const pending = await call<Record<string, Record<string, unknown>>>("txpool_content").catch(() => null)
        check("the run stopped with UNRESOLVED_TX (exit 40)", r.status === "UNRESOLVED_TX" && r.exitCode === 40, `${r.status} ${r.reason}`)
        check("the reduction is the last step and is UNKNOWN", last.id === "reduce" && last.state === "UNKNOWN", `${last.id} ${last.state}`)
        check("nothing dependent was sent (no cleanup ran)", r.cleanup === null && ledger.steps.every((s) => s.phase === "main"), ledger.steps.map((s) => s.id))
        check("the journal holds the action as unresolved, not failed", ["PENDING", "UNKNOWN"].includes(new ActionJournal(join(dir, "journal")).get(r.rescue!.actionId).tx.state), r.rescue)
        // The transaction is mined late; a resumed run settles it without re-sending.
        await call("evm_setAutomine", [true])
        await call("evm_mine")
        const resumed = await runIn(dir, {}, FORK_TIMING, true)
        const after = ledgerOf(dir)
        commonChecks(resumed, dir)
        check("resume settled the same transaction (CONFIRMED, same hash, sent once)", after.steps.filter((s) => s.id === "reduce").length === 1 && after.steps.find((s) => s.id === "reduce")!.state === "CONFIRMED" && after.steps.find((s) => s.id === "reduce")!.hash === last.hash, last.hash)
        check("resume recomputed the reduction: GOAL_MET", resumed.rescue?.goal === "GOAL_MET", resumed.rescue)
        check("resume finished with cleanup verified (exit 0)", resumed.status === "COMPLETE" && resumed.exitCode === 0 && resumed.cleanup?.verified === true, `${resumed.status} ${resumed.reason ?? ""}`)
        return done("exit 40 with the reduction UNKNOWN and nothing else sent; after mining, --resume settles it (sent once), recomputes, cleans up: exit 0", { first: { status: r.status, exitCode: r.exitCode }, pool: pending ? "txpool_content read" : "txpool_content unavailable", resumed: { status: resumed.status, exitCode: resumed.exitCode, rescue: resumed.rescue } })
      }

      if (name === "rpc-outage") {
        // The node keeps mining but stops serving receipt and transaction lookups, from
        // just before the reduction is sent until the rehearsal ends the outage.
        const outage = { on: false, hits: 0 }
        const flaky = new Proxy(client, {
          get(target, prop, receiver) {
            if (outage.on && (prop === "getTransactionReceipt" || prop === "getTransaction")) {
              return async () => {
                outage.hits++
                throw new TimeoutError({ body: { method: String(prop) }, url: "rehearsal: injected RPC outage" })
              }
            }
            return Reflect.get(target, prop, receiver)
          },
        }) as PublicClient
        const short: Timing = { ...FORK_TIMING, receiptTimeoutMs: 3_000, resolveTimeoutMs: 3_000, pollMs: 500 }
        const r = await runIn(dir, { beforeReduceSend: async () => void (outage.on = true) }, short, false, { client: flaky })
        const ledger = ledgerOf(dir)
        const step = ledger.steps.at(-1)!
        const mined = await client.getTransactionReceipt({ hash: step.hash }).catch(() => null)
        const nonceNow = await client.getTransactionCount({ address: owner })
        const action = new ActionJournal(join(dir, "journal")).get(r.rescue!.actionId)
        check("the reduction was in fact mined (seen without the outage)", mined?.status === "success" && nonceNow > step.nonce, `${mined?.status} nonce ${nonceNow} > ${step.nonce}`)
        check("the run stopped with UNRESOLVED_TX (exit 40)", r.status === "UNRESOLVED_TX" && r.exitCode === 40, `${r.status} ${r.reason}`)
        check("the reduction stays UNKNOWN, not NOT_INCLUDED, although its nonce is used", step.id === "reduce" && step.state === "UNKNOWN" && !step.replacedBy, `${step.id} ${step.state} ${step.lastProbe}`)
        check("its worst-case fee stays reserved and no fee is invented", r.gas.committed === step.maxCost && !step.receipt, `committed ${r.gas.committed}, maxCost ${step.maxCost}`)
        check("nothing else was sent (no cleanup)", r.cleanup === null && ledger.steps.every((x) => x.phase === "main"), ledger.steps.map((x) => x.id))
        check("the journal mirrors UNKNOWN, not NOT_INCLUDED", action.tx.state === "UNKNOWN", action.tx.state)
        outage.on = false
        const resumed = await runIn(dir, {}, FORK_TIMING, true, { client: flaky })
        const after = ledgerOf(dir)
        const settled = after.steps.find((x) => x.hash === step.hash)!
        commonChecks(resumed, dir)
        check("after recovery the same transaction settles CONFIRMED with its real fee", settled.state === "CONFIRMED" && settled.receipt?.fee === mined!.gasUsed * mined!.effectiveGasPrice && after.steps.filter((x) => x.id === "reduce").length === 1, `${settled.state} fee ${settled.receipt?.fee}`)
        check("resume recomputes GOAL_MET and finishes with cleanup verified (exit 0)", resumed.status === "COMPLETE" && resumed.exitCode === 0 && resumed.rescue?.goal === "GOAL_MET", `${resumed.status} ${resumed.reason ?? ""}`)
        return done("mined but unobservable: UNKNOWN, fee reserved, nothing else sent (exit 40); after recovery --resume settles it CONFIRMED with its fee and finishes (exit 0)", { first: { status: r.status, exitCode: r.exitCode, gas: r.gas, probe: step.lastProbe }, lookupsFailed: outage.hits, resumed: { status: resumed.status, exitCode: resumed.exitCode, gas: resumed.gas, rescue: resumed.rescue } })
      }

      if (name === "preflight-refusal") {
        // The owner already uses the account: 10 USDso approved, 4 of it deposited.
        await asImpersonated(owner, USDSO, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, 10n * 10n ** 18n] }))
        await asImpersonated(owner, MARGIN_BANK, encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [4n * 10n ** 18n] }))
        const read = async () => {
          const block = await client.getBlock()
          const [nonce, stt, usdso, allowance, state, guardCode] = await Promise.all([
            client.getTransactionCount({ address: owner, blockNumber: block.number }),
            client.getBalance({ address: owner, blockNumber: block.number }),
            client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number }),
            client.readContract({ address: USDSO, abi: erc20Abi, functionName: "allowance", args: [owner, MARGIN_BANK], blockNumber: block.number }),
            client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [owner], blockNumber: block.number }),
            client.getCode({ address: getContractAddress({ from: owner, nonce: BigInt(await client.getTransactionCount({ address: owner, blockNumber: block.number })) }), blockNumber: block.number }),
          ])
          return { block: block.number, nonce, stt, usdso, allowance, unlocked: state.unlockedCollateralBalance, locked: state.lockedCollateral, pools: state.activePerpPools.length, guardCode: guardCode ?? "0x" }
        }
        const before = await read()
        let signatures = 0
        const account = privateKeyToAccount(key)
        const counting: Signer = { address: account.address, signTransaction: async (tx) => (signatures++, account.signTransaction(tx)) }
        const r = await runIn(dir, {}, FORK_TIMING, false, { signer: counting })
        const after = await read()
        const ledger = ledgerOf(dir)
        check("the preflight refused the account (existing collateral and allowance)", /bank account is not empty/.test(r.reason ?? "") && /allowance/.test(r.reason ?? ""), r.reason)
        check("status REFUSED, exit 1, no cleanup", r.status === "REFUSED" && r.exitCode === 1 && r.cleanup === null, `${r.status} ${r.exitCode}`)
        check("nothing was signed or broadcast", signatures === 0 && ledger.steps.length === 0 && r.sentTransactions === 0, `${signatures} signatures, ${ledger.steps.length} steps`)
        check("the account is exactly as it was (no block mined, same nonce, balances, allowance and collateral; no guard)", JSON.stringify(after, big) === JSON.stringify(before, big), { before, after })
        const again = await runIn(dir, {}, FORK_TIMING, true, { signer: counting })
        check("a --resume of the refused run also refuses, touching nothing", again.status === "REFUSED" && signatures === 0 && JSON.stringify(await read(), big) === JSON.stringify(before, big), `${again.status} ${again.reason}`)
        return done("REFUSED (exit 1) with zero signatures and broadcasts; collateral 4 USDso and allowance 6 USDso untouched", { status: r.status, exitCode: r.exitCode, reason: r.reason, before, after })
      }

      if (name === "cleanup-retries") {
        let foreignApprove: Hex | null = null
        const fills: string[] = []
        const r = await runIn(dir, {
          afterOpen: async (i: HookInfo) => {
            // Meanwhile the owner approves the bank in another tool, then the run stops.
            foreignApprove = (await asImpersonated(i.owner, USDSO, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, 10n ** 18n] }))).transactionHash
            throw new Error("rehearsal: run interrupted after opening both legs")
          },
          beforeCleanupClose: async (i: HookInfo) => {
            if (i.attempt! >= MAX_CLOSE_ATTEMPTS) return
            const size = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [i.owner, i.pool!] })).size
            const isBid = size < 0n
            const grid = await client.readContract({ address: i.pool!, abi: perpPoolAbi, functionName: "getOrderBookParameters" })
            const touch = (await client.readContract({ address: i.pool!, abi: perpPoolAbi, functionName: "getBookLevels", args: [!isBid, 1n] }))[0].price
            const keep = alignDown((size < 0n ? -size : size) / 3n, grid.lotSize)
            const took = await take(i.pool!, isBid, protectiveLimit(touch, isBid, 50n, grid.tickSize), keep)
            fills.push(`${i.pool} attempt ${i.attempt}: third party took ${took}, left ${keep} inside the limit`)
          },
        })
        const ledger = commonChecks(r, dir)
        const cleanupSteps = ledger.steps.filter((x) => x.phase === "cleanup")
        const lastMain = ledger.steps.filter((x) => x.phase === "main").at(-1)!
        const closes = r.cleanup?.closes ?? []
        const perLeg = (sym: string) => closes.filter((c) => c.symbol === sym)
        check("the run was interrupted after opening both legs, and the owner's approval was recorded as foreign", lastMain.id === "open-ETH-short" && !!foreignApprove && r.foreignActivity.length > 0, `${lastMain.id} ${foreignApprove}`)
        check("each leg used all 3 guarded attempts: two partial fills, then the rest", ["BTC", "ETH"].every((sym) => perLeg(sym).length === 3 && perLeg(sym).every((c) => c.state === "CONFIRMED" && c.filled > 0n)), closes.map((c) => `${c.symbol} ${c.attempt} ${c.state} ${c.filled}`))
        check("cleanup sent 12 transactions: 2 grants, 6 closes, 2 revokes, a withdrawal, an allowance reset", cleanupSteps.length === 12 && cleanupSteps.filter((x) => x.id.startsWith("cleanup-grant")).length === 2 && cleanupSteps.filter((x) => x.id.startsWith("cleanup-close")).length === 6 && cleanupSteps.filter((x) => x.id.startsWith("cleanup-revoke")).length === 2 && cleanupSteps.some((x) => x.id === "cleanup-withdraw") && cleanupSteps.some((x) => x.id === "cleanup-clear-allowance"), cleanupSteps.map((x) => x.id))
        check("the last main step reserved for every one of them", lastMain.cleanupTxReserved === CLEANUP_TX_WORST_CASE && cleanupSteps.length <= lastMain.cleanupTxReserved, `reserved ${lastMain.cleanupTxReserved}, used ${cleanupSteps.length}`)
        check("each cleanup gas limit fits the per-transaction reserve, and their fees fit the reserve", cleanupSteps.every((x) => x.gas <= CLEANUP_GAS_PER_TX) && cleanupSteps.reduce((a, x) => a + (x.receipt?.fee ?? 0n), 0n) <= lastMain.reserveAtSend, { reserve: lastMain.reserveAtSend, fees: cleanupSteps.reduce((a, x) => a + (x.receipt?.fee ?? 0n), 0n) })
        check("cleanup verified: nothing open, everything withdrawn, allowance zero, no grant", r.cleanup?.verified === true, r.cleanup?.checks.filter((c) => !c.ok))
        check("status ABORTED (exit 20)", r.status === "ABORTED" && r.exitCode === 20, `${r.status} ${r.reason}`)
        return done("interrupted with both legs open and an allowance set: 12 cleanup transactions, all inside the reserve; cleanup verified (exit 20)", { status: r.status, exitCode: r.exitCode, reserved: lastMain.cleanupTxReserved, used: cleanupSteps.length, closes: closes.map((c) => ({ symbol: c.symbol, attempt: c.attempt, filled: c.filled })), fills })
      }

      // cleanup-fail: every guarded close of the BTC leg finds the book emptied inside
      // its limit (BTC's position cap leaves room for the third party's repeated takes).
      let drains = 0
      const r = await runIn(dir, {
        beforeCleanupClose: async (i: HookInfo) => {
          if (i.pool!.toLowerCase() !== BTC_POOL.toLowerCase()) return
          const position = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [i.owner, i.pool!] })).size
          const isBid = position < 0n
          const grid = await client.readContract({ address: i.pool!, abi: perpPoolAbi, functionName: "getOrderBookParameters" })
          const touch = (await client.readContract({ address: i.pool!, abi: perpPoolAbi, functionName: "getBookLevels", args: [!isBid, 1n] }))[0].price
          if ((await take(i.pool!, isBid, protectiveLimit(touch, isBid, 50n, grid.tickSize), 0n)) > 0n) drains++
        },
      })
      const ledger = commonChecks(r, dir)
      check("the third party emptied the book inside each close's limit", drains > 0, String(drains))
      // The emptied book makes the node's simulation reject each close, so none is signed
      // or broadcast: WOULD_REVERT with no transaction, not a reverted transaction.
      const btcAttempts = (r.cleanup?.closes ?? []).filter((c) => c.symbol === "BTC")
      check("every guarded BTC close was refused in simulation (WOULD_REVERT) and never broadcast (tx null); none filled", btcAttempts.length === MAX_CLOSE_ATTEMPTS && btcAttempts.every((c) => c.state === "WOULD_REVERT" && c.tx === null && c.filled === 0n), btcAttempts.map((c) => `${c.attempt} ${c.state} tx ${c.tx} ${c.note ?? ""}`))
      check("no BTC close appears in the run ledger", ledger.steps.every((x) => !x.id.startsWith("cleanup-close-BTC")), ledger.steps.map((x) => x.id))
      check("the other leg was still closed through the guard", (r.cleanup?.closes ?? []).some((c) => c.symbol !== "BTC" && c.state === "CONFIRMED" && c.filled > 0n), r.cleanup?.closes.filter((c) => c.symbol !== "BTC"))
      check("the BTC position is reported as left open", (r.cleanup?.remaining ?? []).some((x) => /^BTC .*still open|BTC.*left open/.test(x)), r.cleanup?.remaining)
      check("the guard's grants were still revoked", r.cleanup?.checks.find((c) => c.name.startsWith("guard holds no grant"))?.ok === true, r.cleanup?.checks.find((c) => c.name.startsWith("guard holds no grant")))
      const placeOrder = encodeFunctionData({ abi: perpPoolAbi, functionName: "placeOrder", args: [false, 0n, 0n, 0n, 0n, 0, 0, "0x0000000000000000000000000000000000000000", 0n] }).slice(0, 10)
      check("no unguarded order was sent instead", ledger.steps.every((s) => s.phase !== "cleanup" || s.selector !== placeOrder), ledger.steps.filter((s) => s.phase === "cleanup").map((s) => `${s.id} ${s.selector}`))
      check("the run reports CLEANUP_INCOMPLETE (exit 30)", r.status === "CLEANUP_INCOMPLETE" && r.exitCode === 30, `${r.status} ${r.reason}`)
      check("collateral was not withdrawn while a position remains", (r.cleanup?.checks.find((c) => c.name === "bank balance withdrawn")?.ok ?? true) === false, r.cleanup?.checks)
      return done("guarded BTC closes find no liquidity; no unguarded fallback; CLEANUP_INCOMPLETE (exit 30)", { status: r.status, exitCode: r.exitCode, remaining: r.cleanup?.remaining, closes: r.cleanup?.closes })
    }

    writeFileAtomic(
      join(out, "rehearsal.json"),
      prettyJson({
        label: "fork",
        warning: "Local anvil fork of Hideki with throwaway accounts funded on the fork. Nothing here was broadcast to the live network.",
        forkBlock: block,
        forkBlockHash: fork.hash,
        clockHeldAt: fork.timestamp,
        owner,
        thirdParty: third,
        planDigest: digest,
        anvil: anvilVersion(),
        outcomes: outcomes.map((o) => ({ scenario: o.scenario, pass: o.pass, expected: o.expected, failed: o.checks.filter((c) => !c.ok).map((c) => c.name) })),
      }),
    )
    writeFileAtomic(join(out, "SHA256SUMS"), checksums(out))
    console.log(`\n${outcomes.filter((o) => o.pass).length}/${outcomes.length} scenarios pass; evidence in ${out}`)
  } finally {
    await stopAnvil(anvil)
  }
  process.exitCode = outcomes.every((o) => o.pass) ? 0 : 1
}


function big(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v
}

main().catch((err) => {
  console.error(`error: ${localText(err instanceof Error ? err.stack ?? err.message : String(err))}`)
  process.exit(1)
})
