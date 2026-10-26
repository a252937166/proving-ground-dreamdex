// Persistent action journal. The action's identity is written to disk BEFORE anything
// is broadcast, and transaction state, actual fill and scenario-goal status are kept
// as three separate fields: a successful receipt is not a fill, and a fill is not a
// repair. At most one action per owner may be pending or unknown at a time, and an
// ambiguous send is resolved from its own hash and nonce, never by sending again.
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { keccak256, type Address, type Hex, type PublicClient } from "viem"
import { prettyJson, readJson, writeFileAtomic } from "./json.js"
import type { ActionBinding } from "./action.js"

export const ACTION_RECORD_VERSION = "mr-action/1"

export type TxState = "NOT_SENT" | "PENDING" | "UNKNOWN" | "REVERTED" | "CONFIRMED" | "NOT_INCLUDED" | "INVALIDATED"
export type FillState = "NOT_APPLICABLE" | "NO_FILL" | "PARTIAL_FILL" | "REQUESTED_FILL"
export type GoalState = "NOT_EVALUATED" | "GOAL_MET" | "GOAL_NOT_MET" | "BASELINE_CHANGED" | "UNAVAILABLE"

const NEXT: Record<TxState, TxState[]> = {
  NOT_SENT: ["PENDING", "INVALIDATED"],
  PENDING: ["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN", "NOT_INCLUDED"],
  UNKNOWN: ["UNKNOWN", "CONFIRMED", "REVERTED", "NOT_INCLUDED"],
  REVERTED: [],
  CONFIRMED: [],
  NOT_INCLUDED: [],
  INVALIDATED: [],
}

export interface StoredRequest {
  pool: Address
  expectedSignedSize: string
  isBid: boolean
  quantity: string
  limitPrice: string
  deadline: string
  nonce: Hex
}

export interface ActionRecord {
  version: typeof ACTION_RECORD_VERSION
  actionId: Hex
  createdAt: string
  binding: ActionBinding
  scenarioId: string
  candidateId: string
  request: StoredRequest
  calldata: Hex
  forecast: { expectedFill: string; scenarioBuffer: string; goal: string }
  quote: { blockNumber: string; blockHash: Hex; validUntil: string }
  tx: { state: TxState; from?: Address; nonce?: number; hash?: Hex; sentAt?: string; blockNumber?: string; blockHash?: Hex; revert?: string }
  fill: { state: FillState; requested: string; filled?: string }
  goal: { state: GoalState; reason?: string }
  history: { at: string; event: string; detail?: string }[]
}

export class JournalError extends Error {}

export class ActionJournal {
  constructor(readonly dir: string) {}

  path(actionId: string): string {
    return join(this.dir, `${actionId}.json`)
  }

  list(): ActionRecord[] {
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"))
    } catch {
      return []
    }
    return names.map((n) => readJson<ActionRecord>(join(this.dir, n)))
  }

  get(actionId: string): ActionRecord {
    return readJson<ActionRecord>(this.path(actionId))
  }

  // Actions whose outcome is not settled. While one exists for an owner, nothing else
  // may be created or sent for that owner.
  open(owner: string): ActionRecord[] {
    return this.list().filter((r) => r.binding.owner.toLowerCase() === owner.toLowerCase() && (r.tx.state === "PENDING" || r.tx.state === "UNKNOWN"))
  }

  create(record: Omit<ActionRecord, "version" | "history" | "tx" | "fill" | "goal"> & { fill?: ActionRecord["fill"] }): ActionRecord {
    const blocking = this.open(record.binding.owner)
    if (blocking.length) throw new JournalError(`action ${blocking[0].actionId} is still ${blocking[0].tx.state}; resolve it before creating another`)
    const exists = this.list().find((r) => r.actionId === record.actionId)
    if (exists) throw new JournalError(`action ${record.actionId} already exists (${exists.tx.state})`)
    const full: ActionRecord = {
      version: ACTION_RECORD_VERSION,
      ...record,
      tx: { state: "NOT_SENT" },
      fill: record.fill ?? { state: "NOT_APPLICABLE", requested: record.request.quantity },
      goal: { state: "NOT_EVALUATED" },
      history: [{ at: new Date().toISOString(), event: "created", detail: `candidate ${record.candidateId}, scenario ${record.scenarioId.slice(0, 16)}` }],
    }
    writeFileAtomic(this.path(full.actionId), prettyJson(full))
    return full
  }

  update(actionId: string, event: string, mutate: (r: ActionRecord) => void, detail?: string): ActionRecord {
    const r = this.get(actionId)
    const before = r.tx.state
    mutate(r)
    if (r.tx.state !== before && !NEXT[before].includes(r.tx.state)) throw new JournalError(`illegal transition ${before} -> ${r.tx.state}`)
    r.history.push({ at: new Date().toISOString(), event, detail })
    writeFileAtomic(this.path(actionId), prettyJson(r))
    return r
  }
}

// Broadcast one journalled action. With a raw signer the transaction hash is known and
// persisted before the bytes leave the process; when the node signs (a local fork with
// an impersonated account) the nonce is persisted first and the hash right after.
export async function broadcast(
  journal: ActionJournal,
  actionId: string,
  send: { kind: "raw"; serialized: Hex; from: Address; nonce: number } | { kind: "node"; from: Address; nonce: number; submit: () => Promise<Hex> },
  client: PublicClient,
  nowSeconds: bigint,
): Promise<ActionRecord> {
  const r = journal.get(actionId)
  if (r.tx.state !== "NOT_SENT") throw new JournalError(`action is ${r.tx.state}, not NOT_SENT`)
  const others = journal.open(r.binding.owner).filter((x) => x.actionId !== actionId)
  if (others.length) throw new JournalError(`action ${others[0].actionId} is still ${others[0].tx.state}`)
  if (nowSeconds > BigInt(r.quote.validUntil)) {
    journal.update(actionId, "invalidated", (x) => (x.tx.state = "INVALIDATED"), "quote expired before sending; replan")
    throw new JournalError("quote expired; the action was invalidated and must be replanned")
  }
  if (send.kind === "raw") {
    const hash = keccak256(send.serialized)
    journal.update(actionId, "pending", (x) => {
      x.tx = { state: "PENDING", from: send.from, nonce: send.nonce, hash, sentAt: new Date().toISOString() }
    })
    try {
      await client.request({ method: "eth_sendRawTransaction", params: [send.serialized] })
    } catch (e) {
      return journal.update(actionId, "send-error", (x) => (x.tx.state = "UNKNOWN"), String((e as Error).message).slice(0, 200))
    }
    return journal.get(actionId)
  }
  journal.update(actionId, "pending", (x) => {
    x.tx = { state: "PENDING", from: send.from, nonce: send.nonce, sentAt: new Date().toISOString() }
  })
  try {
    const hash = await send.submit()
    return journal.update(actionId, "submitted", (x) => (x.tx.hash = hash), hash)
  } catch (e) {
    return journal.update(actionId, "send-error", (x) => (x.tx.state = "UNKNOWN"), String((e as Error).message).slice(0, 200))
  }
}

// Settle a PENDING or UNKNOWN action from chain data alone. Never re-sends: a hash with
// no receipt stays pending; a consumed nonce without our hash is NOT_INCLUDED, which
// still requires a fresh analysis before anything else is sent.
export async function resolveAction(journal: ActionJournal, actionId: string, client: PublicClient): Promise<ActionRecord> {
  const r = journal.get(actionId)
  if (r.tx.state !== "PENDING" && r.tx.state !== "UNKNOWN") return r
  if (r.tx.hash) {
    const receipt = await client.getTransactionReceipt({ hash: r.tx.hash }).catch(() => null)
    if (receipt) {
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber }).then((b) => b.hash === receipt.blockHash)
      if (!canonical) return journal.update(actionId, "receipt-not-canonical", (x) => (x.tx.state = "UNKNOWN"), receipt.blockHash)
      return journal.update(actionId, receipt.status === "success" ? "confirmed" : "reverted", (x) => {
        x.tx.state = receipt.status === "success" ? "CONFIRMED" : "REVERTED"
        x.tx.blockNumber = receipt.blockNumber.toString()
        x.tx.blockHash = receipt.blockHash
      })
    }
    const pending = await client.getTransaction({ hash: r.tx.hash }).catch(() => null)
    if (pending) return journal.update(actionId, "still-pending", (x) => (x.tx.state = "PENDING"))
  }
  if (r.tx.from !== undefined && r.tx.nonce !== undefined) {
    const latest = await client.getTransactionCount({ address: r.tx.from, blockTag: "latest" })
    if (latest > r.tx.nonce) {
      if (!r.tx.hash) {
        // The node signed and the process stopped before the hash was saved: look for
        // the transaction by sender and nonce in recent blocks.
        const found = await findByNonce(client, r.tx.from, r.tx.nonce, 500n)
        if (found) {
          journal.update(actionId, "hash-recovered", (x) => (x.tx.hash = found), found)
          return resolveAction(journal, actionId, client)
        }
      }
      return journal.update(actionId, "nonce-consumed", (x) => (x.tx.state = r.tx.hash ? "NOT_INCLUDED" : "UNKNOWN"), `nonce ${r.tx.nonce} used; latest ${latest}`)
    }
  }
  return journal.update(actionId, "unresolved", (x) => (x.tx.state = "UNKNOWN"))
}

async function findByNonce(client: PublicClient, from: Address, nonce: number, lookback: bigint): Promise<Hex | null> {
  const head = await client.getBlockNumber()
  for (let n = head; n >= 0n && n > head - lookback; n--) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true })
    for (const tx of block.transactions) {
      if (typeof tx !== "string" && tx.from.toLowerCase() === from.toLowerCase() && tx.nonce === nonce) return tx.hash
    }
  }
  return null
}
