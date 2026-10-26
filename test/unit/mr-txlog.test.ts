// The run's transaction ledger and sender. MOCK TESTS: the chain is a stub
// (mr-chain-stub.ts); nothing is signed with a real key.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { getAddress, keccak256, RpcRequestError, TimeoutError, type Hex } from "viem"
import { readBigJson } from "../../src/margin-rescue/common.js"
import { ForeignTransactionError, GasBudgetError, StepRejectedError, TxLedger, TxSender, UnresolvedTransactionError, type RunLedger } from "../../src/margin-rescue/txlog.js"
import { GWEI, OWNER, STRANGER_TX, StubChain, stubSigner } from "./mr-chain-stub.js"

const TO = getAddress("0x478769e1177c0773c43a593dccc4ad15f15f1394")
const GAS_PER_TX = 13_000_000n

function setup(c: StubChain, opts: { cap?: bigint } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "mr-ledger-")), "run-ledger.json")
  const ledger = TxLedger.create(path, { planDigest: "d".repeat(64), account: OWNER, chainId: 50383, gasCap: opts.cap ?? 2n * 10n ** 18n, startNonce: c.nonceAt(OWNER, c.head) })
  const sender = new TxSender(ledger, c.client(), stubSigner, {
    chainId: 50383,
    gasCap: opts.cap ?? 2n * 10n ** 18n,
    maxGasPrice: 18n * GWEI,
    gasHeadroomPct: 30n,
    cleanupGasPerTx: GAS_PER_TX,
    receiptTimeoutMs: 3,
    resolveTimeoutMs: 3,
    pollMs: 1,
    sleep: async () => {},
  })
  return { ledger, sender, path }
}

const main = (id: string, cleanupTx = 0) => ({ id, phase: "main" as const, purpose: id, to: TO, data: "0x12345678" as Hex, cleanupTx })
const cleanup = (id: string) => ({ id, phase: "cleanup" as const, purpose: id, to: TO, data: "0x12345678" as Hex, allowForeignNonce: true })

describe("transaction ledger", () => {
  it("persists every step with its hash before the bytes are broadcast, and never the bytes", async () => {
    const c = new StubChain()
    const { sender, path } = setup(c)
    let onDisk: RunLedger | null = null
    c.onSend = () => (onDisk = readBigJson<RunLedger>(path))
    const s = await sender.send(main("approve"))
    assert.equal(onDisk!.steps.length, 1)
    assert.equal(onDisk!.steps[0].state, "PENDING")
    assert.equal(onDisk!.steps[0].hash, keccak256(c.sent[0]))
    assert.equal(onDisk!.steps[0].nonce, 5)
    assert.equal(onDisk!.steps[0].sentAfterBlock, 100n, "the head before the nonce was read")
    assert.equal(s.state, "CONFIRMED")
    assert.equal(s.receipt!.fee, 400_000n * 6n * GWEI)
    assert.ok(!readFileSync(path, "utf8").includes(c.sent[0].slice(2, 40)), "signed bytes are not written")
  })

  it("a send without a receipt becomes UNKNOWN and blocks every later send until it resolves", async () => {
    const c = new StubChain()
    c.mine = false
    const { ledger, sender } = setup(c)
    await assert.rejects(sender.send(main("deposit")), UnresolvedTransactionError)
    assert.equal(ledger.data.steps[0].state, "UNKNOWN")
    await assert.rejects(sender.send(main("open BTC")), UnresolvedTransactionError)
    assert.equal(c.sent.length, 1, "nothing dependent was broadcast")
    const first = ledger.data.steps[0]
    c.include({ hash: first.hash, from: OWNER, nonce: first.nonce })
    c.mine = true
    const next = await sender.send(main("open BTC"))
    assert.equal(ledger.data.steps[0].state, "CONFIRMED")
    assert.equal(next.nonce, 6)
    assert.equal(c.sent.length, 2, "the first transaction was never sent again")
  })

  it("an already-mined transaction whose receipt and transaction lookups time out stays UNKNOWN, keeps its fee reserved and blocks every later send", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    // Mined at once, but from then on the node cannot serve its receipt or transaction.
    c.onSend = () => {
      c.outage.add("receipt")
      c.outage.add("transaction")
      c.onSend = undefined
    }
    await assert.rejects(sender.send(main("reduce")), UnresolvedTransactionError)
    const step = ledger.data.steps[0]
    assert.equal(c.nonceAt(OWNER, c.head), 6, "its nonce is used: it was mined")
    assert.equal(step.state, "UNKNOWN", "a used nonce with failed lookups is not NOT_INCLUDED")
    assert.match(step.lastProbe ?? "", /lookup failed/)
    assert.equal(ledger.committed(), step.maxCost, "its worst-case fee stays reserved")
    assert.equal(ledger.spent(), 0n)
    await assert.rejects(sender.send(cleanup("cleanup-withdraw")), UnresolvedTransactionError, "nothing else is sent, cleanup included")
    assert.equal(c.sent.length, 1)
    // The node recovers: the same transaction settles from its receipt, fee recorded.
    c.outage.clear()
    const next = await sender.send(cleanup("cleanup-withdraw"))
    assert.equal(ledger.data.steps[0].state, "CONFIRMED")
    assert.equal(ledger.committed(), 0n)
    assert.equal(ledger.spent(), 2n * 400_000n * 6n * GWEI, "both fees are recorded")
    assert.equal(next.nonce, 6)
  })

  it("a used nonce whose transaction cannot be located stays UNKNOWN", async () => {
    const c = new StubChain()
    c.mine = false
    const { ledger, sender } = setup(c)
    c.onSend = (_raw, hash) => queueMicrotask(() => {
      c.mempool.delete(hash) // the node forgets it ...
      c.replace(5) // ... and a transaction for its nonce is mined,
      c.outage.add("block") // but no block can be read to tell which one.
    })
    await assert.rejects(sender.send(main("open ETH")), UnresolvedTransactionError)
    assert.equal(ledger.data.steps[0].state, "UNKNOWN")
    assert.match(ledger.data.steps[0].lastProbe ?? "", /could not be located/)
  })

  it("a used nonce located with this transaction's own hash stays UNKNOWN until its receipt is served", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    // Mined (its block lists it), but the node answers "not found" for its receipt and
    // for the transaction: a lagging index. The nonce search finds the block, and the
    // transaction there is this one, so nothing is settled.
    c.onSend = (_raw, hash) => queueMicrotask(() => c.receipts.delete(hash))
    await assert.rejects(sender.send(main("grant")), UnresolvedTransactionError)
    const step = ledger.data.steps[0]
    assert.equal(step.state, "UNKNOWN")
    assert.match(step.lastProbe ?? "", /mined in block 101 \(located by nonce\)/)
    assert.equal(ledger.committed(), step.maxCost)
  })

  it("a used nonce located with ANOTHER hash is NOT_INCLUDED, names the replacement and stops the run", async () => {
    const c = new StubChain()
    c.mine = false
    const { ledger, sender } = setup(c)
    c.onSend = (_raw, hash) => queueMicrotask(() => {
      c.mempool.delete(hash)
      c.replace(5)
    })
    await assert.rejects(sender.send(main("open ETH")), ForeignTransactionError)
    assert.equal(ledger.data.steps[0].state, "NOT_INCLUDED")
    assert.equal(ledger.data.steps[0].replacedBy, STRANGER_TX)
    assert.equal(ledger.committed(), 0n, "a located replacement settles the step")
  })

  it("a JSON-RPC error answer to a lookup is not 'not found'", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    const client = sender.client as unknown as Record<string, unknown>
    const real = client.getTransactionReceipt as (a: { hash: Hex }) => Promise<unknown>
    client.getTransactionReceipt = async () => {
      throw new RpcRequestError({ body: {}, error: { code: -32603, message: "internal error" }, url: "stub" })
    }
    await assert.rejects(sender.send(main("approve")), UnresolvedTransactionError)
    assert.equal(ledger.data.steps[0].state, "UNKNOWN")
    client.getTransactionReceipt = real
    await sender.resolveOpen()
    assert.equal(ledger.data.steps[0].state, "CONFIRMED")
  })

  it("a resumed run resolves open steps from chain data alone", async () => {
    const c = new StubChain()
    c.mine = false
    const { ledger, sender, path } = setup(c)
    await assert.rejects(sender.send(cleanup("withdraw")), UnresolvedTransactionError)
    const step = ledger.data.steps[0]
    c.include({ hash: step.hash, from: OWNER, nonce: step.nonce }, "reverted")
    const resumed = new TxSender(new TxLedger(path, readBigJson(path)), c.client(), stubSigner, { ...sender.opts })
    await resumed.resolveOpen()
    assert.equal(resumed.ledger.data.steps[0].state, "REVERTED")
    assert.equal(c.sent.length, 1)
  })

  it("an ambiguous transport failure is UNKNOWN, then settled from the receipt", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    c.onSend = (raw, hash) => {
      c.include({ hash, from: OWNER, nonce: 5 }) // the node got and mined it ...
      c.mine = false
      c.onSend = undefined
      throw new TimeoutError({ body: {}, url: "stub" }) // ... but the HTTP answer was lost
    }
    const s = await sender.send(main("grant"))
    assert.equal(s.state, "CONFIRMED")
    assert.ok(ledger.data.steps[0].history.some((h) => h.event === "broadcast outcome unknown"))
  })

  it("a node rejection is NOT_INCLUDED, and the next step reuses the free nonce", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    c.onSend = () => {
      throw new RpcRequestError({ body: {}, error: { code: -32000, message: "insufficient funds for gas * price + value" }, url: "stub" })
    }
    await assert.rejects(sender.send(main("deposit")), StepRejectedError)
    assert.equal(ledger.data.steps[0].state, "NOT_INCLUDED")
    c.onSend = undefined
    const next = await sender.send(main("deposit again"))
    assert.equal(next.nonce, 5)
  })

  it("refuses while the account has a pending transaction this run did not send", async () => {
    const c = new StubChain()
    c.mempool.set(STRANGER_TX, { hash: STRANGER_TX, from: OWNER, nonce: 5 })
    const { sender } = setup(c)
    await assert.rejects(sender.send(main("approve")), /pending transaction/)
    assert.equal(c.sent.length, 0)
  })

  it("a transaction sent from the account between steps stops the main flow; cleanup records it and continues", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    await sender.send(main("approve"))
    c.replace(6) // someone else used the key
    await assert.rejects(sender.send(main("deposit")), ForeignTransactionError)
    const s = await sender.send(cleanup("cleanup-clear-allowance"))
    assert.equal(s.state, "CONFIRMED")
    assert.equal(ledger.data.foreignActivity.length, 1)
  })

  it("refuses a gas price above the plan's maximum", async () => {
    const c = new StubChain()
    c.gasPrice = 19n * GWEI
    const { sender } = setup(c)
    await assert.rejects(sender.send(main("approve")), /gas price/)
  })

  it("a reverted step is settled, paid for, and reported", async () => {
    const c = new StubChain()
    const { ledger, sender } = setup(c)
    c.mine = false
    c.onSend = (_raw, hash) => queueMicrotask(() => c.include({ hash, from: OWNER, nonce: 5 }, "reverted"))
    await assert.rejects(sender.send(main("reduce")), /reverted/)
    assert.equal(ledger.data.steps[0].state, "REVERTED")
    assert.equal(ledger.spent(), 400_000n * 6n * GWEI)
  })
})

describe("gas reserve", () => {
  // One step: 1M gas × 1.3 headroom × 6 gwei = 0.0078 STT. Cleanup: 13M × 6 gwei = 0.078 STT a tx.
  const stepCost = 1_300_000n * 6n * GWEI
  const perCleanupTx = GAS_PER_TX * 6n * GWEI

  it("a main step must leave every cleanup transaction it could require, under the cap", async () => {
    const cap = stepCost + 12n * perCleanupTx
    const ok = setup(new StubChain(), { cap })
    assert.equal((await ok.sender.send(main("open ETH", 12))).reserveAtSend, 12n * perCleanupTx)
    const tight = setup(new StubChain(), { cap: cap - 1n })
    await assert.rejects(tight.sender.send(main("open ETH", 12)), GasBudgetError)
  })

  it("a main step must say what cleanup it could require; a cleanup step reserves none", async () => {
    const c = new StubChain()
    const { sender } = setup(c, { cap: stepCost })
    await assert.rejects(sender.send({ id: "open", phase: "main", purpose: "open", to: TO, data: "0x12345678" }), /must state the cleanup/)
    assert.equal((await sender.send(cleanup("cleanup-close-BTC-1"))).reserveAtSend, 0n)
  })

  it("refuses a step the wallet cannot pay together with the reserve", async () => {
    const c = new StubChain()
    c.balance = stepCost + 2n * perCleanupTx - 1n
    const { sender } = setup(c)
    await assert.rejects(sender.send(main("deploy", 2)), /wallet STT/)
  })
})
