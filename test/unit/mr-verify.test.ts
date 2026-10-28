// The independent verifier (verify.ts) on a real-venue fork run. REPLAYED CHAIN: the
// fixture holds one live-command run on a local anvil fork of Hideki and the chain's
// answers to every read the verifier makes (mr-fork-fixture.ts). The run as recorded
// passes; tampered files fail, also when every hash inside them is recomputed so the
// files agree with each other: the chain decides, not the files.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem"
import { reduceGuardAbi } from "../../src/margin-rescue/abi.js"
import { canonicalJson, sha256Hex } from "../../src/margin-rescue/json.js"
import { cleanupNonce, rescueNonce } from "../../src/margin-rescue/action.js"
import { BTC_POOL } from "../../src/margin-rescue/common.js"
import { contractActionId, verifyRun, type Request } from "../../src/margin-rescue/verify.js"
import { loadFixture, replayClient, replayIndexer, writeRun, type ForkFixture } from "./mr-fork-fixture.js"

const fx = loadFixture()

// `answers`: chain answers added to the recording, [method, params, result, error].
function run(tamper?: (dir: string) => void, approvedDigest = sha256Hex(fx.plan), answers: ForkFixture["calls"] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mr-verify-"))
  writeRun(fx, dir)
  const plan = join(mkdtempSync(join(tmpdir(), "mr-verify-plan-")), "live-plan.json")
  writeFileSync(plan, fx.plan)
  tamper?.(dir)
  return verifyRun({ dir, plan, client: replayClient({ ...fx, calls: [...fx.calls, ...answers] }), indexer: replayIndexer, rpc: "http://127.0.0.1:8553", approvedDigest })
}

const json = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"))
const put = (dir: string, f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v, null, 2) + "\n")
const rescueFile = (dir: string) => {
  const id = json(dir, "run-state.json").rescueActionId as string
  return `journal/${id}.json`
}
const failed = (r: Awaited<ReturnType<typeof run>>) => r.checks.filter((c) => !c.ok).map((c) => c.name)
// A scenario edited and given back a matching id, as a careful forger would.
const reScenario = (dir: string, edit: (s: any) => void) => {
  const s = json(dir, "scenario.json")
  edit(s)
  const { id: _id, ...body } = s
  put(dir, "scenario.json", { ...body, id: sha256Hex(canonicalJson(body)) })
  const rec = json(dir, rescueFile(dir))
  rec.scenarioId = sha256Hex(canonicalJson(body))
  put(dir, rescueFile(dir), rec)
}

describe("independent verification of a real-venue fork run", () => {
  it("the run as recorded passes every check, binds every guarded action, and reaches GOAL_MET from the chain", async () => {
    const r = await run()
    assert.deepEqual(failed(r), [])
    assert.equal(r.verdict.allChecksHold, true)
    assert.equal(r.verdict.goal, "GOAL_MET")
    assert.ok(r.verdict.scenarioVerified && r.verdict.cleanupVerified && r.verdict.reconciled && r.verdict.transactionsVerified)
    const guardTxs = r.transactions.filter((t) => t.request)
    assert.ok(guardTxs.length >= 2, "the reduction and the cleanup closes")
    for (const t of guardTxs) assert.ok(r.confirmations[t.hash], `${t.id} bound to its confirmation`)
    assert.deepEqual(r.binding.transactions, JSON.parse(fx.files["run-ledger.json"]).steps.map((s: { hash: string }) => s.hash.toLowerCase()))
  })

  for (const [field, change] of [
    ["isBid", (q: any) => (q.isBid = !q.isBid)],
    ["nonce", (q: any) => (q.nonce = `0x${"11".repeat(32)}`)],
  ] as const) {
    it(`a saved request with another ${field}, keeping the original action id and transaction hash, fails`, async () => {
      const r = await run((dir) => {
        const rec = json(dir, rescueFile(dir))
        change(rec.request)
        put(dir, rescueFile(dir), rec)
      })
      const f = failed(r)
      assert.ok(f.some((n) => /reduce: the saved request is the calldata the chain executed/.test(n)), f.join("; "))
      assert.ok(f.some((n) => /reduce: the action id recomputed from the saved request is the saved one/.test(n)))
      assert.equal(r.verdict.allChecksHold, false)
    })
  }

  it("the reduction's nonce is derived in the rescue domain, from the plan, the scenario and the quote block; a cleanup close's in another", async () => {
    const d = "ab".repeat(32)
    const sc = "cd".repeat(32)
    const h = keccak256("0x01")
    assert.equal(rescueNonce(d, sc, h), rescueNonce(d, sc, h), "reproducible from the run's files")
    assert.notEqual(rescueNonce(d, sc, h), rescueNonce("ef".repeat(32), sc, h))
    assert.notEqual(rescueNonce(d, sc, h), rescueNonce(d, "ef".repeat(32), h))
    assert.notEqual(rescueNonce(d, sc, h), rescueNonce(d, sc, keccak256("0x02")))
    assert.notEqual(rescueNonce(d, sc, h), cleanupNonce(d, BTC_POOL, 0, h))
    const r = await run()
    assert.ok(r.checks.find((c) => /carries the rescue nonce/.test(c.name))?.ok, "the recorded reduction")
    const rescue = JSON.parse(fx.files["run-state.json"]).rescueActionId as string
    const closes = Object.entries(fx.files).filter(([f]) => f.startsWith("journal/") && !f.includes(rescue)).map(([, body]) => JSON.parse(body).request?.nonce as string | undefined)
    assert.ok(closes.length >= 1 && closes.every((n) => n && n !== JSON.parse(fx.files[`journal/${rescue}.json`]).request.nonce), "no close shares it")
  })

  it("altered saved calldata or saved domain fails", async () => {
    let r = await run((dir) => {
      const rec = json(dir, rescueFile(dir))
      rec.calldata = `${rec.calldata.slice(0, -2)}${rec.calldata.endsWith("00") ? "01" : "00"}`
      put(dir, rescueFile(dir), rec)
    })
    assert.ok(failed(r).some((n) => /reduce: the saved calldata is the transaction's/.test(n)))
    r = await run((dir) => {
      const rec = json(dir, rescueFile(dir))
      rec.binding.marginBank = "0x000000000000000000000000000000000000dEaD"
      put(dir, rescueFile(dir), rec)
    })
    assert.ok(failed(r).some((n) => /reduce: the saved domain is this chain, guard, bank and owner/.test(n)))
  })

  it("a self-consistent forged confirmation (other side, its own action id and calldata, ledger and state updated) still fails against the chain", async () => {
    const r = await run((dir) => {
      const old = rescueFile(dir)
      const rec = json(dir, old)
      const state = json(dir, "run-state.json")
      const q: Request = { pool: rec.request.pool as Address, expectedSignedSize: BigInt(rec.request.expectedSignedSize), isBid: !rec.request.isBid, quantity: BigInt(rec.request.quantity), limitPrice: BigInt(rec.request.limitPrice), deadline: BigInt(rec.request.deadline), nonce: rec.request.nonce as Hex }
      const forgedId = contractActionId(50383n, state.guard, rec.binding.marginBank, rec.binding.owner, q)
      rec.request.isBid = q.isBid
      rec.actionId = forgedId
      rec.calldata = encodeFunctionData({ abi: reduceGuardAbi, functionName: "reduce", args: [q] })
      put(dir, `journal/${forgedId}.json`, rec)
      renameSync(join(dir, old), join(dir, `${old}.bak`))
      state.rescueActionId = forgedId
      put(dir, "run-state.json", state)
      const ledger = json(dir, "run-ledger.json")
      for (const s of ledger.steps) if (s.id === "reduce") s.actionId = forgedId
      put(dir, "run-ledger.json", ledger)
    })
    const f = failed(r)
    for (const want of [/the saved request is the calldata the chain executed/, /the saved calldata is the transaction's/, /the guard's own actionIdOf\(executed request\) is the saved action id/]) assert.ok(f.some((n) => want.test(n)), `${want}: ${f.join("; ")}`)
    assert.equal(r.verdict.allChecksHold, false)
  })

  const scenarioTampers: [string, (s: any) => void, RegExp][] = [
    ["oneBase", (s) => (s.markets.find((m: any) => m.symbol === "BTC").oneBase = "1000000000"), /BTC: pool, units, mark, maintenance margin, shock and absolute price match/],
    ["maintenance margin", (s) => (s.markets.find((m: any) => m.symbol === "ETH").risk.maintenanceMarginBps = "100"), /ETH: pool, units, mark, maintenance margin, shock and absolute price match/],
    [
      "pool/shock mapping",
      (s) => {
        const btc = s.markets.find((m: any) => m.symbol === "BTC")
        const eth = s.markets.find((m: any) => m.symbol === "ETH")
        ;[btc.shockBps, eth.shockBps] = [eth.shockBps, btc.shockBps]
        for (const m of [btc, eth]) m.scenarioPrice = ((BigInt(m.referenceMark) * BigInt(10_000 + m.shockBps)) / 10_000n).toString()
      },
      /BTC: pool, units, mark, maintenance margin, shock and absolute price match/,
    ],
    ["numerical bound", (s) => (s.numericBound.perLegRawUnits = "1000000000000000000"), /the scenario's numerical bound is the model's/],
  ]
  for (const [what, edit, want] of scenarioTampers) {
    it(`a scenario whose ${what} was changed, its id recomputed, fails, and no goal is reported from it`, async () => {
      const r = await run((dir) => reScenario(dir, edit))
      const f = failed(r)
      assert.ok(!f.some((n) => /id is the hash of its body/.test(n)), "the forged scenario is self-consistent")
      assert.ok(f.some((n) => want.test(n)), `${want}: ${f.join("; ")}`)
      assert.equal(r.verdict.scenarioVerified, false)
      assert.equal(r.verdict.goal, "UNAVAILABLE")
    })
  }

  it("a recomputation file that disagrees with the chain is reported, not believed", async () => {
    const r = await run((dir) => {
      const rc = json(dir, "recompute.json")
      rc.actual.scenario.buffer = (BigInt(rc.actual.scenario.buffer) + 10n ** 18n).toString()
      put(dir, "recompute.json", rc)
    })
    assert.ok(failed(r).some((n) => /the run's recomputation has the same scenario buffer/.test(n)))
    assert.equal(r.verdict.goal, "GOAL_MET", "the chain's own valuation still decides the goal")
  })

  it("a plan other than the approved one fails, however consistent the run's own files are", async () => {
    const r = await run(undefined, "e".repeat(64))
    assert.ok(failed(r).some((n) => /the plan is the one approved before the run/.test(n)))
    assert.equal(r.verdict.allChecksHold, false)
  })

  it("the rescue cannot be pointed at another guarded transaction (a cleanup close)", async () => {
    const r = await run((dir) => {
      const ledger = json(dir, "run-ledger.json")
      const close = ledger.steps.find((x: { id: string }) => x.id.startsWith("cleanup-close"))
      const state = json(dir, "run-state.json")
      state.rescueActionId = close.actionId
      put(dir, "run-state.json", state)
    })
    assert.ok(failed(r).some((n) => /the rescue is the run's first guarded reduction/.test(n)), failed(r).join("; "))
    assert.notEqual(r.verdict.goal, "GOAL_MET")
  })

  it("a cleanup close relabelled as the rescue, its journal record given the rescue's kind, scenario and quote, still fails on the chain's data", async () => {
    let relabelled = ""
    const r = await run((dir) => {
      const state = json(dir, "run-state.json")
      const rescue = json(dir, `journal/${state.rescueActionId}.json`)
      // The close of the rescue's own leg: same pool and side, a full cut at the protective limit.
      const close = json(dir, "run-ledger.json").steps.find((x: { id: string; actionId: string }) => x.id.startsWith("cleanup-close") && json(dir, `journal/${x.actionId}.json`).request.pool === rescue.request.pool)
      const rec = json(dir, `journal/${close.actionId}.json`)
      put(dir, `journal/${close.actionId}.json`, { ...rec, kind: rescue.kind, scenarioId: rescue.scenarioId, quote: rescue.quote })
      put(dir, "run-state.json", { ...state, rescueActionId: close.actionId })
      relabelled = close.id
    })
    assert.match(relabelled, /^cleanup-close-/)
    const f = failed(r)
    assert.ok(f.some((n) => /the rescue is the run's first guarded reduction/.test(n)), f.join("; "))
    assert.ok(f.some((n) => /the deadline is the planned seconds after the analysis block/.test(n)))
    assert.ok(f.some((n) => /carries the rescue nonce of this plan, scenario and quote block/.test(n)), "its nonce was derived in the cleanup domain")
    assert.notEqual(r.verdict.goal, "GOAL_MET")
    assert.equal(r.verdict.allChecksHold, false)
  })

  it("a scenario taken at a block outside the run's analysis window fails before any of its prices are used", async () => {
    const r = await run((dir) =>
      reScenario(dir, (s) => {
        const ledger = json(dir, "run-ledger.json")
        s.reference.blockNumber = (BigInt(ledger.steps[0].receipt.blockNumber) - 1n).toString() // before the run began
      }),
    )
    assert.ok(failed(r).some((n) => /reference block is the run's analysis window/.test(n)), failed(r).join("; "))
    assert.equal(r.verdict.goal, "UNAVAILABLE")
  })

  // The ledger records a step NOT_INCLUDED when the node rejected it or another transaction
  // took its nonce. Here one more step is recorded so, after the last one: a hash no node knows.
  const rejected = keccak256("0x72656a6563746564")
  const withRejectedStep = (dir: string) => {
    const ledger = json(dir, "run-ledger.json")
    const last = ledger.steps.at(-1)
    const { receipt: _r, lastProbe: _p, ...rest } = last
    ledger.steps.push({ ...rest, n: last.n + 1, id: "cleanup-withdraw-again", nonce: last.nonce + 1, hash: rejected, state: "NOT_INCLUDED", history: [{ at: last.history[0].at, event: "rejected by the node", detail: "replayed rejection" }] })
    put(dir, "run-ledger.json", ledger)
  }

  it("a NOT_INCLUDED step whose lookup fails is not verified: the read-back stops instead of taking the error for an absence", async () => {
    const stopped = /tx 14 cleanup-withdraw-again: looking up 0x[0-9a-f]{64} failed \((.+)\); a failed lookup is not an absence/
    // No recorded answer fails like a node error, as the reviewer's fixture did; then an explicit one.
    await assert.rejects(run(withRejectedStep), (e: Error) => stopped.test(e.message) && /not in the recording/.test(e.message))
    await assert.rejects(run(withRejectedStep, undefined, [["eth_getTransactionByHash", [rejected], null, "HTTP request failed. Status: 502"]]), (e: Error) => stopped.test(e.message) && /Status: 502/.test(e.message))
  })

  it("a NOT_INCLUDED step the node answers as unknown (null) is an absence, and the run still verifies", async () => {
    const r = await run(withRejectedStep, undefined, [["eth_getTransactionByHash", [rejected], null, null]])
    assert.deepEqual(failed(r), [])
    assert.equal(r.verdict.allChecksHold, true)
    const t = r.transactions.find((x) => x.hash === rejected)
    assert.ok(t && t.block === null && t.ledgerState === "NOT_INCLUDED" && t.problems.length === 0)
    assert.match(r.checks.find((c) => /every recorded transaction read back/.test(c.name))!.detail, /13 mined, 1 not included/)
    // The same null answer for a step the ledger calls CONFIRMED is a failed check.
    const lost = await run((dir) => {
      withRejectedStep(dir)
      const ledger = json(dir, "run-ledger.json")
      ledger.steps.at(-1).state = "CONFIRMED"
      put(dir, "run-ledger.json", ledger)
    }, undefined, [["eth_getTransactionByHash", [rejected], null, null]])
    assert.ok(failed(lost).some((n) => /tx 14 cleanup-withdraw-again: not on chain, but the ledger does not say NOT_INCLUDED/.test(n)), failed(lost).join("; "))
    assert.equal(lost.verdict.allChecksHold, false)
  })

  it("the recording holds no signed transaction: transactions are kept without r, s, v and yParity", () => {
    const txs = fx.calls.filter(([method]) => method === "eth_getTransactionByHash").map(([, , result]) => result as Record<string, unknown>)
    assert.ok(txs.length > 0)
    for (const t of txs) assert.deepEqual(["r", "s", "v", "yParity"].filter((k) => k in t), [], String(t.hash))
  })

  it("recorded every request it made: an unaltered run needs nothing outside the recording", async () => {
    const r = await run()
    assert.ok(!r.checks.some((c) => /could not be read back/.test(c.name)))
  })
})
