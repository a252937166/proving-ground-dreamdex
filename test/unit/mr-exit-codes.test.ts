// Exit codes of `npm run mr:live` when a run ends in an error (liveCli.ts). MOCK TESTS: the
// chain is a stub (mr-chain-stub.ts) and the run is the real transaction ledger and sender
// driven by a small script, with faults injected before the first signature, around
// signing and ledger persistence, after broadcast but before the receipt is persisted,
// after confirmation, and while the final result or the log is written. Each test checks
// the exit code, what was persisted for recovery, and whether anything more was sent.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import type { Hex, PublicClient } from "viem"
import { readBigJson } from "../../src/margin-rescue/common.js"
import { EXIT, ResultNotPersistedError, RUN_VERSION, runLive, type RunOptions, type RunResult, type RunStatus } from "../../src/margin-rescue/executor.js"
import { sha256Hex, writeFileAtomic } from "../../src/margin-rescue/json.js"
import { runCli, type CliDeps } from "../../src/margin-rescue/liveCli.js"
import type { LivePlan } from "../../src/margin-rescue/livePlan.js"
import { NOT_BROADCAST, TxLedger, TxSender, type RunLedger } from "../../src/margin-rescue/txlog.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK } from "../../src/margin-rescue/common.js"
import { GUARD_ARTIFACT, guardDeployment, loadGuardArtifact } from "../../src/margin-rescue/guardArtifact.js"
import { GWEI, OWNER, StubChain, stubSigner } from "./mr-chain-stub.js"

const TO = "0x478769E1177C0773c43A593DCCc4Ad15F15F1394" as const

function world() {
  const root = mkdtempSync(join(tmpdir(), "mr-cli-"))
  mkdirSync(join(root, ".margin-rescue"), { recursive: true })
  mkdirSync(join(root, "evidence", "margin-rescue", "live-write"), { recursive: true })
  const plan = join(root, "live-plan.json")
  writeFileSync(plan, JSON.stringify({ version: "mr-live-plan/4", network: { chainId: 50383, maxGasPrice: "18000000000" }, account: { address: OWNER, nonce: 5 }, bounds: { gas: { sttCap: "2000000000000000000" } } }))
  const digest = sha256Hex(readFileSync(plan))
  const chain = new StubChain()
  const out: string[] = []
  let clock = 1_000
  const deps = (runner: CliDeps["runLive"]): Partial<CliDeps> => ({
    root,
    now: () => clock++,
    createClient: () => chain.client(),
    createSigner: () => stubSigner,
    listStops: () => async () => ({ rows: [], pages: 1, indexedThrough: 0n }),
    runLive: runner,
    print: (l) => out.push(l),
    printErr: (l) => out.push(l),
  })
  const cli = (runner: CliDeps["runLive"], extra: string[] = []) => runCli(["--plan", plan, "--approve", digest, ...extra], { MR_SIGNER_KEY: "0x01" }, deps(runner))
  return { root, plan, digest, chain, out, cli }
}

function resultOf(status: RunStatus, ledger: TxLedger): RunResult {
  return { version: RUN_VERSION, status, exitCode: EXIT[status], reason: null, guard: null, rescue: null, invalidated: [], cleanup: null, foreignActivity: [], gas: { cap: 2n * 10n ** 18n, spent: ledger.spent(), committed: ledger.committed() }, sentTransactions: ledger.data.steps.length, logComplete: true }
}

// The real ledger and sender, as runLive builds them, driven by `script`.
function scripted(chain: StubChain, script: (s: { sender: TxSender; ledger: TxLedger; opts: RunOptions }) => Promise<RunResult | void>, signer?: RunOptions["signer"]) {
  return async (opts: RunOptions): Promise<RunResult> => {
    const path = join(opts.out, "run-ledger.json")
    const ledger = opts.resume ? new TxLedger(path, readBigJson<RunLedger>(path)) : TxLedger.create(path, { planDigest: opts.planDigest, account: OWNER, chainId: 50383, gasCap: 2n * 10n ** 18n, startNonce: chain.nonceAt(OWNER, chain.head) })
    const sender = new TxSender(ledger, opts.client, signer ?? opts.signer, { chainId: 50383, gasCap: 2n * 10n ** 18n, maxGasPrice: 18n * GWEI, gasHeadroomPct: 30n, cleanupGasPerTx: 13_000_000n, receiptTimeoutMs: 3, resolveTimeoutMs: 3, pollMs: 1, sleep: async () => {}, tracker: opts.tracker })
    return (await script({ sender, ledger, opts })) ?? resultOf("COMPLETE", ledger)
  }
}

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, phase: "main" as const, purpose: id, to: TO, data: "0x12345678" as Hex, cleanupTx: 0, ...extra })

// Make the ledger's next save that matches `when` throw, once.
function failSave(ledger: TxLedger, when: (data: RunLedger) => boolean) {
  const save = ledger.save.bind(ledger)
  let fired = false
  ledger.save = () => {
    if (!fired && when(ledger.data)) {
      fired = true
      throw new Error("ENOSPC: no space left on device (injected)")
    }
    save()
  }
}

const runDirs = (root: string) => {
  const base = join(root, ".margin-rescue", "live")
  return existsSync(base) ? readdirSync(base).map((n) => join(base, n)) : []
}
const resultIn = (dir: string) => JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as { status: string; exitCode: number; open: { id: string; hash: string; nonce: number }[]; process: { signatures: number; broadcasts: number } }

describe("exit codes after an unexpected error", () => {
  it("an error before the first signature (the real executor) is a refusal: exit 1, nothing signed or sent", async () => {
    const w = world()
    const broken = { getChainId: async () => { throw new Error("connect ECONNREFUSED (injected)") } } as unknown as PublicClient
    const code = await runCli(["--plan", w.plan, "--approve", w.digest], { MR_SIGNER_KEY: "0x01" }, { root: w.root, now: () => 7, createClient: () => broken, createSigner: () => stubSigner, listStops: () => async () => ({ rows: [], pages: 1, indexedThrough: 0n }), runLive, print: () => {}, printErr: (l) => w.out.push(l) })
    assert.equal(code, EXIT.REFUSED)
    const r = resultIn(join(w.root, ".margin-rescue", "live", "run-7"))
    assert.equal(r.status, "REFUSED")
    assert.deepEqual(r.process, { signatures: 0, broadcasts: 0 })
    assert.equal(w.chain.sent.length, 0)
  })

  it("a signer that fails produces no signature: still a refusal, exit 1", async () => {
    const w = world()
    const failing = { address: OWNER, signTransaction: async (): Promise<Hex> => { throw new Error("hardware signer unavailable (injected)") } }
    const code = await w.cli(scripted(w.chain, async ({ sender }) => void (await sender.send(step("deploy-guard"))), failing))
    assert.equal(code, EXIT.REFUSED)
    assert.equal(w.chain.sent.length, 0)
  })

  it("a ledger that cannot record a signed transaction: the bytes are dropped, never broadcast, exit 2", async () => {
    const w = world()
    const code = await w.cli(
      scripted(w.chain, async ({ sender, ledger }) => {
        failSave(ledger, (d) => d.steps.length === 1 && d.steps[0].history.length === 1)
        await sender.send(step("deploy-guard"))
      }),
    )
    assert.equal(code, EXIT.SIGNED_NOT_SENT)
    assert.equal(w.chain.sent.length, 0, "nothing reached the node")
    const [dir] = runDirs(w.root)
    assert.equal(readBigJson<RunLedger>(join(dir, "run-ledger.json")).steps.length, 0, "no step on disk")
    const r = resultIn(dir)
    assert.equal(r.status, "SIGNED_NOT_SENT")
    assert.deepEqual(r.process, { signatures: 1, broadcasts: 0 })
  })

  it("a pre-broadcast step that fails after the ledger recorded the transaction: marked not broadcast, exit 2", async () => {
    const w = world()
    const code = await w.cli(
      scripted(w.chain, async ({ sender }) => {
        await sender.send(
          step("reduce", {
            beforeBroadcast: () => {
              throw new Error("journal write failed (injected)")
            },
          }),
        )
      }),
    )
    assert.equal(code, EXIT.SIGNED_NOT_SENT)
    assert.equal(w.chain.sent.length, 0)
    const [dir] = runDirs(w.root)
    const s = readBigJson<RunLedger>(join(dir, "run-ledger.json")).steps[0]
    assert.equal(s.state, "NOT_INCLUDED")
    assert.ok(s.history.some((h) => h.event === NOT_BROADCAST))
  })

  it("after a broadcast whose outcome could not be persisted: exit 40, the step stays open on disk, nothing else is sent, and --resume settles it without sending it again", async () => {
    const w = world()
    let runs = 0
    const code = await w.cli(
      scripted(w.chain, async ({ sender, ledger }) => {
        runs++
        await sender.send(step("deploy-guard"))
        failSave(ledger, (d) => d.steps.at(-1)?.history.at(-1)?.event === "accepted by the node")
        await sender.send(step("approve"))
        await sender.send(step("deposit"))
      }),
    )
    assert.equal(code, EXIT.UNRESOLVED_TX)
    assert.equal(w.chain.sent.length, 2, "deploy and approve were broadcast; the deposit never was")
    const [dir] = runDirs(w.root)
    const onDisk = readBigJson<RunLedger>(join(dir, "run-ledger.json"))
    assert.deepEqual(onDisk.steps.map((s) => `${s.id}:${s.state}`), ["deploy-guard:CONFIRMED", "approve:PENDING"])
    const r = resultIn(dir)
    assert.equal(r.status, "UNRESOLVED_TX")
    assert.equal(r.open[0].id, "approve")
    assert.equal(r.open[0].hash, onDisk.steps[1].hash)
    assert.ok(w.out.some((l) => l.includes("--resume")), "the command says how to resume")

    // A fresh run of the same account is refused while this one is open; nothing is signed.
    const fresh = await w.cli(scripted(w.chain, async () => assert.fail("a fresh run must not start")))
    assert.equal(fresh, EXIT.REFUSED)
    assert.ok(w.out.some((l) => /not finished/.test(l)))
    assert.equal(w.chain.sent.length, 2)

    // Resumed: settled from the chain by its own hash, never sent again.
    const resumed = await w.cli(
      scripted(w.chain, async ({ sender, ledger }) => {
        await sender.resolveOpen()
        return resultOf("COMPLETE", ledger)
      }),
      ["--out", dir, "--resume"],
    )
    assert.equal(resumed, EXIT.COMPLETE)
    assert.equal(w.chain.sent.length, 2)
    assert.equal(readBigJson<RunLedger>(join(dir, "run-ledger.json")).steps[1].state, "CONFIRMED")
    assert.equal(runs, 1)
  })

  it("an error after confirmed transactions is not a refusal: exit 50, the ledger intact, nothing more sent, no fresh run", async () => {
    const w = world()
    const code = await w.cli(
      scripted(w.chain, async ({ sender }) => {
        await sender.send(step("deploy-guard"))
        await sender.send(step("approve"))
        throw new TypeError("Cannot read properties of undefined (injected)")
      }),
    )
    assert.equal(code, EXIT.FAILED_AFTER_START)
    assert.equal(w.chain.sent.length, 2)
    const [dir] = runDirs(w.root)
    assert.deepEqual(readBigJson<RunLedger>(join(dir, "run-ledger.json")).steps.map((s) => s.state), ["CONFIRMED", "CONFIRMED"])
    assert.equal(resultIn(dir).status, "FAILED_AFTER_START")
    assert.equal(await w.cli(scripted(w.chain, async () => assert.fail("no fresh run"))), EXIT.REFUSED)
    assert.equal(w.chain.sent.length, 2)
  })

  it("a run whose result cannot be written is classified from its ledger (exit 50), even if the classification cannot be written either", async () => {
    const w = world()
    const code = await w.cli(
      scripted(w.chain, async ({ sender, ledger, opts }) => {
        await sender.send(step("deploy-guard"))
        mkdirSync(join(opts.out, "result.json")) // nothing can be written there
        try {
          writeFileAtomic(join(opts.out, "result.json"), "{}") // as runLive writes it: the disk's own error names the file
        } catch (e) {
          throw new ResultNotPersistedError(resultOf("COMPLETE", ledger), e)
        }
        assert.fail("the write must fail")
      }),
    )
    assert.equal(code, EXIT.FAILED_AFTER_START, "not 0: a COMPLETE nobody can read back is not reported as success")
    assert.ok(w.out.some((l) => /ended COMPLETE, but result.json could not be written/.test(l)))
    assert.ok(w.out.some((l) => /could NOT be written/.test(l)))
    assert.equal(w.chain.sent.length, 1)
    // What it prints names the run's files relative to the repository, and neither failed
    // write (the executor's, then the classification's) leaves a temporary copy behind.
    const line = w.out.find((l) => /could not be written: E/.test(l))!
    assert.match(line, / '\.margin-rescue\/live\/run-\d+\/result\.json\.\d+\.tmp' -> '\.margin-rescue\/live\/run-\d+\/result\.json'/, line)
    const [dir] = runDirs(w.root)
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [])
  })

  it("a log that cannot be written does not change the outcome", async () => {
    const w = world()
    mkdirSync(join(w.root, ".margin-rescue", "live", "run-1000", "run-log.jsonl"), { recursive: true }) // every append fails
    const code = await w.cli(
      scripted(w.chain, async ({ sender, ledger }) => {
        await sender.send(step("deploy-guard"))
        return resultOf("COMPLETE", ledger)
      }),
    )
    assert.equal(code, EXIT.COMPLETE)
  })

  // The executor's own path: its preflight cannot read the account, so it stops before
  // signing, and a log that throws on every line does not change that.
  const built = existsSync(GUARD_ARTIFACT)
  it("the real executor, stopped by a failed preflight read with an unwritable log: REFUSED, exit 1, no signature", { skip: built ? false : "contracts/out is missing; run forge build in contracts/ (this test needs the guard build)" }, async () => {
    const w = world()
    const d = guardDeployment(loadGuardArtifact(), OWNER, MARGIN_BANK, [BTC_POOL, ETH_POOL])
    writeFileSync(w.plan, JSON.stringify({ version: "mr-live-plan/4", network: { chainId: 50383, maxGasPrice: "18000000000" }, account: { address: OWNER, nonce: 5 }, guard: { creationCodeKeccak: d.creationCodeKeccak, deployDataKeccak: d.deployDataKeccak, expectedRuntimeKeccak: d.expectedRuntimeKeccak }, bounds: { gas: { sttCap: "2000000000000000000" } } }))
    const digest = sha256Hex(readFileSync(w.plan))
    const client = {
      getChainId: async () => 50383,
      getTransactionCount: async () => 5,
      request: async () => {
        throw new Error("eth_getBlockByNumber failed (injected)")
      },
    } as unknown as PublicClient
    let tracker = { signatures: -1, broadcasts: -1 }
    const code = await runCli(["--plan", w.plan, "--approve", digest], { MR_SIGNER_KEY: "0x01" }, {
      root: w.root,
      now: () => 9,
      createClient: () => client,
      createSigner: () => stubSigner,
      listStops: () => async () => ({ rows: [], pages: 1, indexedThrough: 0n }),
      runLive: (opts) => {
        tracker = opts.tracker!
        return runLive({ ...opts, log: () => { throw new Error("log disk full (injected)") } })
      },
      print: () => {},
      printErr: () => {},
    })
    assert.equal(code, EXIT.REFUSED)
    const r = resultIn(join(w.root, ".margin-rescue", "live", "run-9")) as unknown as RunResult
    assert.equal(r.status, "REFUSED")
    assert.equal(r.logComplete, false, "the lost log lines are reported")
    assert.deepEqual(tracker, { signatures: 0, broadcasts: 0 })
  })

  it("a ledger that cannot be read back: exit 60, inspect first", async () => {
    const w = world()
    const code = await w.cli(
      scripted(w.chain, async ({ sender, opts }) => {
        await sender.send(step("deploy-guard"))
        writeFileSync(join(opts.out, "run-ledger.json"), "{ torn")
        throw new Error("crash (injected)")
      }),
    )
    assert.equal(code, EXIT.STATE_UNKNOWN)
    assert.ok(w.out.some((l) => /Inspect the account on chain/.test(l)))
  })
})

describe("an existing run is never overwritten or bypassed", () => {
  const finished = async (w: ReturnType<typeof world>, out?: string) => {
    const code = await w.cli(
      scripted(w.chain, async ({ sender, ledger, opts }) => {
        await sender.send(step("deploy-guard"))
        const r = resultOf("COMPLETE", ledger)
        writeFileSync(join(opts.out, "result.json"), JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) // as runLive writes it
        return r
      }),
      out ? ["--out", out] : [],
    )
    assert.equal(code, EXIT.COMPLETE)
    return out ?? runDirs(w.root)[0]
  }

  it("a --resume that fails before signing anything writes nothing and reports the run's own state", async () => {
    const w = world()
    const dir = await finished(w)
    const before = readFileSync(join(dir, "result.json"), "utf8")
    const code = await w.cli(async () => {
      throw new Error("connect ECONNREFUSED (injected)")
    }, ["--out", dir, "--resume"])
    assert.equal(code, EXIT.COMPLETE, "the run is complete; this attempt changed nothing")
    assert.equal(readFileSync(join(dir, "result.json"), "utf8"), before, "the COMPLETE result is untouched")
    assert.ok(w.out.some((l) => /nothing was sent and nothing was written\. The run is unchanged: its record says COMPLETE \(exit 0\)/.test(l)))
    assert.equal(await w.cli(scripted(w.chain, async ({ ledger }) => resultOf("REFUSED", ledger))), EXIT.REFUSED, "fresh runs are not blocked by it (it is finished)")
  })

  it("a --resume that reaches a new result but cannot write it exits with that result, and never 0", async () => {
    const w = world()
    const dir = await finished(w)
    const before = readFileSync(join(dir, "result.json"), "utf8")
    const unwritable = (status: RunStatus) => async (opts: RunOptions): Promise<RunResult> => {
      const ledger = new TxLedger(join(opts.out, "run-ledger.json"), readBigJson<RunLedger>(join(opts.out, "run-ledger.json")))
      throw new ResultNotPersistedError(resultOf(status, ledger), new Error("EROFS: read-only file system (injected)"))
    }
    assert.equal(await w.cli(unwritable("CLEANUP_INCOMPLETE"), ["--out", dir, "--resume"]), EXIT.CLEANUP_INCOMPLETE, "the newer state, not the old COMPLETE record")
    assert.ok(w.out.some((l) => /signed and sent nothing; the run ended CLEANUP_INCOMPLETE, but result\.json could not be written.*result\.json still says COMPLETE; exit 30/.test(l)), w.out.join("\n"))
    assert.equal(await w.cli(unwritable("COMPLETE"), ["--out", dir, "--resume"]), EXIT.FAILED_AFTER_START, "a completion that could not be recorded is not exit 0")
    assert.equal(readFileSync(join(dir, "result.json"), "utf8"), before)
    assert.equal(w.chain.sent.length, 1, "only the first run's transaction")
  })

  it("resuming an unresolved run while the RPC is down keeps exit 40 and writes nothing", async () => {
    const w = world()
    await w.cli(
      scripted(w.chain, async ({ sender, ledger }) => {
        await sender.send(step("deploy-guard"))
        failSave(ledger, (d) => d.steps.at(-1)?.history.at(-1)?.event === "accepted by the node")
        await sender.send(step("approve"))
      }),
    )
    const [dir] = runDirs(w.root)
    const before = readFileSync(join(dir, "result.json"), "utf8")
    const code = await w.cli(async () => {
      throw new Error("connect ECONNREFUSED (injected)")
    }, ["--out", dir, "--resume"])
    assert.equal(code, EXIT.UNRESOLVED_TX)
    assert.equal(readFileSync(join(dir, "result.json"), "utf8"), before)
    assert.equal(w.chain.sent.length, 2)
  })

  it("a fresh run into a folder that already holds a run is refused before anything starts, and the folder is left alone", async () => {
    const w = world()
    const dir = await finished(w)
    const before = readFileSync(join(dir, "result.json"), "utf8")
    const code = await w.cli(async () => assert.fail("must not start"), ["--out", dir])
    assert.equal(code, EXIT.REFUSED)
    assert.equal(readFileSync(join(dir, "result.json"), "utf8"), before)
    assert.equal(await w.cli(async () => assert.fail("must not start"), ["--out", join(w.root, ".margin-rescue", "live", "empty"), "--resume"]), EXIT.REFUSED, "nothing to resume")
  })

  it("a registered run whose folder has gone missing blocks a fresh run", async () => {
    const w = world()
    const elsewhere = join(mkdtempSync(join(tmpdir(), "mr-gone-")), "run-b")
    await w.cli(
      scripted(w.chain, async ({ sender }) => {
        await sender.send(step("deploy-guard"))
        throw new Error("crash (injected)")
      }),
      ["--out", elsewhere],
    )
    rmSync(elsewhere, { recursive: true })
    assert.equal(await w.cli(async () => assert.fail("no fresh run")), EXIT.REFUSED)
    assert.ok(w.out.some((l) => /its folder is missing/.test(l)))
  })

  it("a missing folder registered for another account (a fork rehearsal's throwaway key) does not block this account", async () => {
    const w = world()
    const gone = (account: string) => JSON.stringify({ out: join(tmpdir(), `mr-never-${account.slice(2, 10)}`), account, planDigest: "0".repeat(64), startedAt: new Date(0).toISOString() }) + "\n"
    const registry = join(w.root, ".margin-rescue", "live", "runs.jsonl")
    mkdirSync(join(w.root, ".margin-rescue", "live"), { recursive: true })
    writeFileSync(registry, gone("0x00000000000000000000000000000000000000aa"))
    assert.equal(await w.cli(scripted(w.chain, async ({ ledger }) => resultOf("REFUSED", ledger))), EXIT.REFUSED, "it ran (and refused on its own)")
    assert.ok(!w.out.some((l) => /its folder is missing/.test(l)))
    writeFileSync(registry, gone(OWNER.toLowerCase()))
    assert.equal(await w.cli(async () => assert.fail("no fresh run")), EXIT.REFUSED, "this account's missing folder, whatever the case of the address")
    assert.ok(w.out.some((l) => /its folder is missing/.test(l)))
    writeFileSync(registry, "not json\n")
    assert.equal(await w.cli(async () => assert.fail("no fresh run")), EXIT.REFUSED, "a line that cannot be read counts for every account")
  })

  it("an unfinished run outside .margin-rescue/live/ still blocks a fresh run", async () => {
    const w = world()
    const elsewhere = join(mkdtempSync(join(tmpdir(), "mr-elsewhere-")), "run-a")
    const code = await w.cli(
      scripted(w.chain, async ({ sender }) => {
        await sender.send(step("deploy-guard"))
        throw new Error("crash (injected)")
      }),
      ["--out", elsewhere],
    )
    assert.equal(code, EXIT.FAILED_AFTER_START)
    assert.equal(await w.cli(async () => assert.fail("no fresh run")), EXIT.REFUSED)
    assert.ok(w.out.some((l) => l.includes("run-a") && /not finished/.test(l)))
  })
})

describe("the command's output folder", () => {
  it("without --out, the run goes to a private folder under .margin-rescue/live/", async () => {
    const w = world()
    let used = ""
    await w.cli(async (opts) => ((used = opts.out), resultOf("REFUSED", TxLedger.create(join(opts.out, "run-ledger.json"), { planDigest: w.digest, account: OWNER, chainId: 50383, gasCap: 1n, startNonce: 5 }))))
    assert.equal(used, join(w.root, ".margin-rescue", "live", "run-1000"))
  })

  it("refuses public output paths before signing anything: evidence/, other tracked paths, and links into them", async () => {
    for (const out of ["evidence/margin-rescue/live-write/run-1", "evidence/margin-rescue/fork/x", "web/run", "run-1"]) {
      const w = world()
      const code = await w.cli(async () => assert.fail("must not run"), ["--out", join(w.root, out)])
      assert.equal(code, EXIT.REFUSED, out)
      assert.ok(!existsSync(join(w.root, out)), `${out} was not created`)
      assert.equal(w.chain.sent.length, 0)
    }
    const w = world()
    symlinkSync(join(w.root, "evidence", "margin-rescue", "live-write"), join(w.root, ".margin-rescue", "link"))
    assert.equal(await w.cli(async () => assert.fail("must not run"), ["--out", join(w.root, ".margin-rescue", "link", "run-1")]), EXIT.REFUSED)
  })

  it("the executor itself refuses to write a run into the published live-write folder", async () => {
    const plan = { account: { address: OWNER } } as unknown as LivePlan
    const out = join(new URL("../../evidence/margin-rescue/live-write", import.meta.url).pathname, "run-test")
    await assert.rejects(runLive({ plan, planDigest: "d".repeat(64), client: {} as PublicClient, signer: stubSigner, out, listStops: async () => ({ rows: [], pages: 1, indexedThrough: null }) }), /npm run mr:publish-run/)
    assert.ok(!existsSync(out))
  })
})
