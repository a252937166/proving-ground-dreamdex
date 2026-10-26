// Action identity and the persistent journal. MOCK/FIXTURE TESTS: no network; the
// chain is a stub that answers only what each case needs.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { getAddress, keccak256, toBytes, type Hex, type PublicClient } from "viem"
import { actionIdOf, REDUCE_TYPEHASH, reduceCalldata, type ReduceRequest } from "../../src/margin-rescue/action.js"
import { ActionJournal, broadcast, JournalError, resolveAction } from "../../src/margin-rescue/journal.js"

const binding = {
  chainId: 50383,
  guard: getAddress("0x00000000000000000000000000000000000a11ce"),
  marginBank: getAddress("0x478769e1177c0773c43a593dccc4ad15f15f1394"),
  owner: getAddress("0x66c626c59eddf06a7dca0401cf20fa2ce7033a12"),
}
const request: ReduceRequest = {
  pool: getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0"),
  expectedSignedSize: -2_500_000n,
  isBid: true,
  quantity: 1_250_000n,
  limitPrice: 80_123_400_000_000_000_000_000n,
  deadline: 1_793_000_000n,
  nonce: keccak256(toBytes("margin-rescue-vector")),
}

describe("action id", () => {
  it("matches the Solidity vector in contracts/test/unit (actionIdOf)", () => {
    assert.equal(REDUCE_TYPEHASH, "0x3c6d3d2ee88f5b7d075b465137a581151ff9081bd2396bb3c845f9d6d6249227")
    assert.equal(actionIdOf(binding, request), "0x293396790ce17fe3193c8d02e15c8c4244e26be8c02b4b306978efc0eac3d3cf")
  })
  it("commits to every field, the guard and the chain", () => {
    const base = actionIdOf(binding, request)
    const variants: [string, Hex][] = [
      ["chain", actionIdOf({ ...binding, chainId: 1 }, request)],
      ["guard", actionIdOf({ ...binding, guard: getAddress("0x00000000000000000000000000000000000b0b00") }, request)],
      ["owner", actionIdOf({ ...binding, owner: getAddress("0x00000000000000000000000000000000000b0b01") }, request)],
      ["bank", actionIdOf({ ...binding, marginBank: getAddress("0x00000000000000000000000000000000000b0b02") }, request)],
      ["expected size", actionIdOf(binding, { ...request, expectedSignedSize: -2_499_000n })],
      ["side", actionIdOf(binding, { ...request, isBid: false })],
      ["quantity", actionIdOf(binding, { ...request, quantity: 1_251_000n })],
      ["limit", actionIdOf(binding, { ...request, limitPrice: request.limitPrice + 1n })],
      ["deadline", actionIdOf(binding, { ...request, deadline: request.deadline + 1n })],
      ["nonce", actionIdOf(binding, { ...request, nonce: keccak256(toBytes("other")) })],
    ]
    for (const [field, id] of variants) assert.notEqual(id, base, field)
  })
  it("encodes the guard call", () => {
    assert.match(reduceCalldata(request), /^0x[0-9a-f]+$/)
  })
})

function journalWith() {
  const dir = mkdtempSync(join(tmpdir(), "mr-journal-"))
  const j = new ActionJournal(dir)
  const make = (nonce: string, validUntil = "2000000000") => {
    const r = { ...request, nonce: keccak256(toBytes(nonce)) }
    return j.create({
      actionId: actionIdOf(binding, r),
      createdAt: "test",
      binding,
      scenarioId: "s".repeat(64),
      candidateId: "BTC-50",
      request: { pool: r.pool, expectedSignedSize: r.expectedSignedSize.toString(), isBid: r.isBid, quantity: r.quantity.toString(), limitPrice: r.limitPrice.toString(), deadline: r.deadline.toString(), nonce: r.nonce },
      calldata: reduceCalldata(r),
      forecast: { expectedFill: r.quantity.toString(), scenarioBuffer: "1", goal: "MEETS" },
      quote: { blockNumber: "1", blockHash: "0x01", validUntil },
    })
  }
  return { j, make }
}

// A chain stub: tracks sent raw transactions and answers receipt/tx/nonce queries.
function stubClient(state: { receipts?: Record<string, { status: "success" | "reverted" }>; pending?: string[]; nonce?: number; sent?: string[] }): PublicClient {
  return {
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method === "eth_sendRawTransaction") {
        state.sent = [...(state.sent ?? []), params[0] as string]
        return "0x"
      }
      throw new Error(`unexpected ${method}`)
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = state.receipts?.[hash]
      if (!r) throw new Error("not found")
      return { ...r, blockNumber: 7n, blockHash: "0x07" }
    },
    getBlock: async () => ({ hash: "0x07" }),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (state.pending?.includes(hash)) return { hash }
      throw new Error("not found")
    },
    getTransactionCount: async () => state.nonce ?? 0,
    getBlockNumber: async () => 0n,
  } as unknown as PublicClient
}

describe("journal", () => {
  it("persists the action before anything is sent, with the hash known first for raw sends", async () => {
    const { j, make } = journalWith()
    const rec = make("a")
    assert.equal(j.get(rec.actionId).tx.state, "NOT_SENT")
    const state: { sent?: string[] } = {}
    const raw = "0x02f8" as Hex
    const after = await broadcast(j, rec.actionId, { kind: "raw", serialized: raw, from: binding.owner, nonce: 3 }, stubClient(state), 1_000n)
    assert.equal(after.tx.state, "PENDING")
    assert.equal(after.tx.hash, keccak256(raw))
    assert.equal(after.tx.nonce, 3)
    assert.deepEqual(state.sent, [raw])
    assert.deepEqual(
      j.get(rec.actionId).history.map((h) => h.event),
      ["created", "pending"],
    )
  })

  it("allows one unsettled action per owner at a time", async () => {
    const { j, make } = journalWith()
    const first = make("a")
    await broadcast(j, first.actionId, { kind: "raw", serialized: "0x01", from: binding.owner, nonce: 1 }, stubClient({}), 1_000n)
    assert.throws(() => make("b"), JournalError)
  })

  it("refuses to create the same action twice", () => {
    const { make } = journalWith()
    make("a")
    assert.throws(() => make("a"), /already exists/)
  })

  it("invalidates an expired quote instead of sending it", async () => {
    const { j, make } = journalWith()
    const rec = make("late", "999")
    const state: { sent?: string[] } = {}
    await assert.rejects(broadcast(j, rec.actionId, { kind: "raw", serialized: "0x01", from: binding.owner, nonce: 1 }, stubClient(state), 1_000n), /expired/)
    assert.equal(j.get(rec.actionId).tx.state, "INVALIDATED")
    assert.equal(state.sent, undefined, "nothing left the process")
  })

  it("settles from the original hash and never re-sends", async () => {
    const { j, make } = journalWith()
    const rec = make("a")
    const raw = "0x0abc" as Hex
    const hash = keccak256(raw)
    const state: { sent?: string[]; receipts?: Record<string, { status: "success" | "reverted" }>; pending?: string[]; nonce?: number } = { pending: [hash] }
    await broadcast(j, rec.actionId, { kind: "raw", serialized: raw, from: binding.owner, nonce: 5 }, stubClient(state), 1_000n)
    assert.equal((await resolveAction(j, rec.actionId, stubClient(state))).tx.state, "PENDING", "still in the mempool")
    state.pending = []
    state.nonce = 5
    assert.equal((await resolveAction(j, rec.actionId, stubClient(state))).tx.state, "UNKNOWN", "no receipt and nonce not yet used")
    state.receipts = { [hash]: { status: "reverted" } }
    const settled = await resolveAction(j, rec.actionId, stubClient(state))
    assert.equal(settled.tx.state, "REVERTED")
    assert.equal(state.sent?.length, 1, "the action was broadcast exactly once")
  })

  it("marks a hash that lost its nonce to another transaction as not included", async () => {
    const { j, make } = journalWith()
    const rec = make("a")
    const state: { nonce?: number } = {}
    await broadcast(j, rec.actionId, { kind: "raw", serialized: "0x0def", from: binding.owner, nonce: 9 }, stubClient(state), 1_000n)
    state.nonce = 10
    assert.equal((await resolveAction(j, rec.actionId, stubClient(state))).tx.state, "NOT_INCLUDED")
  })

  it("rejects illegal transitions", () => {
    const { j, make } = journalWith()
    const rec = make("a")
    assert.throws(() => j.update(rec.actionId, "bad", (r) => (r.tx.state = "CONFIRMED")), /illegal transition NOT_SENT -> CONFIRMED/)
  })
})
