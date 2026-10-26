// Persistent action journal. The action's identity is written to disk BEFORE anything
// is broadcast, and transaction state, actual fill and scenario-goal status are kept
// as three separate fields: a successful receipt is not a fill, and a fill is not a
// repair. At most one action per owner may be pending or unknown at a time, and an
// ambiguous send is resolved from its own hash and nonce (outcome.ts), never by sending
// again: a failed lookup or a bare nonce increase leaves it UNKNOWN.
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { keccak256, type Address, type Hex, type PublicClient } from "viem"
import { prettyJson, readJson, writeFileAtomic } from "./json.js"
import { findNonceConsumer, probeTransaction } from "./outcome.js"
import type { ActionBinding } from "./action.js"

export const ACTION_RECORD_VERSION = "mr-action/1"

export type TxState = "NOT_SENT" | "PENDING" | "UNKNOWN" | "REVERTED" | "CONFIRMED" | "NOT_INCLUDED" | "INVALIDATED"
export type FillState = "NOT_APPLICABLE" | "NO_FILL" | "PARTIAL_FILL" | "REQUESTED_FILL"
// EVIDENCE_MISMATCH: the receipt, its calldata or the guard's event does not match the
// saved confirmation, so nothing in it may be credited to the action.
export type GoalState = "NOT_EVALUATED" | "GOAL_MET" | "GOAL_NOT_MET" | "BASELINE_CHANGED" | "UNAVAILABLE" | "EVIDENCE_MISMATCH"

const NEXT: Record<TxState, TxState[]> = {
  NOT_SENT: ["PENDING", "INVALIDATED"],
  PENDING: ["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN", "NOT_INCLUDED"],
  UNKNOWN: ["UNKNOWN", "PENDING", "CONFIRMED", "REVERTED", "NOT_INCLUDED"],
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

export interface RefreshRecord {
  at: string
  blockNumber: string
  blockHash: Hex
  verdict: "STILL_VALID" | "INVALIDATED"
  reasons: string[]
  fundingDrift: string // raw USDso, change in total funding owed since the analysis
  forecast: { expectedFill: string; scenarioBuffer: string; goal: string } | null
}

export interface ActionRecord {
  version: typeof ACTION_RECORD_VERSION
  actionId: Hex
  // RESCUE: the analysed repair; CLEANUP: a guarded full close while unwinding a run.
  kind?: "RESCUE" | "CLEANUP"
  createdAt: string
  binding: ActionBinding
  scenarioId: string
  candidateId: string
  request: StoredRequest
  calldata: Hex
  forecast: { expectedFill: string; scenarioBuffer: string; goal: string }
  quote: { blockNumber: string; blockHash: Hex; validUntil: string }
  refreshes?: RefreshRecord[]
  tx: { state: TxState; from?: Address; nonce?: number; hash?: Hex; sentAt?: string; sentAfterBlock?: string; blockNumber?: string; blockHash?: Hex; revert?: string; replacedBy?: Hex }
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
  const sentAfterBlock = (await client.getBlockNumber()).toString()
  if (send.kind === "raw") {
    const hash = keccak256(send.serialized)
    journal.update(actionId, "pending", (x) => {
      x.tx = { state: "PENDING", from: send.from, nonce: send.nonce, hash, sentAt: new Date().toISOString(), sentAfterBlock }
    })
    try {
      await client.request({ method: "eth_sendRawTransaction", params: [send.serialized] })
    } catch (e) {
      return journal.update(actionId, "send-error", (x) => (x.tx.state = "UNKNOWN"), String((e as Error).message).slice(0, 200))
    }
    return journal.get(actionId)
  }
  journal.update(actionId, "pending", (x) => {
    x.tx = { state: "PENDING", from: send.from, nonce: send.nonce, sentAt: new Date().toISOString(), sentAfterBlock }
  })
  try {
    const hash = await send.submit()
    return journal.update(actionId, "submitted", (x) => (x.tx.hash = hash), hash)
  } catch (e) {
    return journal.update(actionId, "send-error", (x) => (x.tx.state = "UNKNOWN"), String((e as Error).message).slice(0, 200))
  }
}

// Settle a PENDING or UNKNOWN action from chain data alone (outcome.ts). Never re-sends.
// Only a canonical receipt settles it as CONFIRMED / REVERTED, and only a located
// transaction with another hash for its nonce makes it NOT_INCLUDED; a failed lookup,
// a hash the node does not know, or a used nonce whose transaction was not located
// leaves it UNKNOWN.
export async function resolveAction(journal: ActionJournal, actionId: string, client: PublicClient): Promise<ActionRecord> {
  const r = journal.get(actionId)
  if (r.tx.state !== "PENDING" && r.tx.state !== "UNKNOWN") return r
  if (r.tx.from === undefined || r.tx.nonce === undefined) return journal.update(actionId, "unresolved", (x) => (x.tx.state = "UNKNOWN"), "no sender and nonce recorded")
  const sentAfterBlock = r.tx.sentAfterBlock === undefined ? undefined : BigInt(r.tx.sentAfterBlock)
  if (!r.tx.hash) {
    // The node signed and the process stopped before the hash was saved: the hash is
    // whatever transaction consumed the recorded nonce, if it can be located.
    const found = await findNonceConsumer(client, r.tx.from, r.tx.nonce, sentAfterBlock)
    if (found.kind !== "found") return journal.update(actionId, "unresolved", (x) => (x.tx.state = "UNKNOWN"), "hash not saved; the transaction for its nonce was not located")
    journal.update(actionId, "hash-recovered", (x) => (x.tx.hash = found.value.hash), found.value.hash)
    return resolveAction(journal, actionId, client)
  }
  const p = await probeTransaction(client, { hash: r.tx.hash, from: r.tx.from, nonce: r.tx.nonce, sentAfterBlock })
  switch (p.state) {
    case "MINED":
      return journal.update(actionId, p.receipt.status === "success" ? "confirmed" : "reverted", (x) => {
        x.tx.state = p.receipt.status === "success" ? "CONFIRMED" : "REVERTED"
        x.tx.blockNumber = p.receipt.blockNumber.toString()
        x.tx.blockHash = p.receipt.blockHash
      })
    case "REPLACED":
      return journal.update(actionId, "nonce-consumed", (x) => {
        x.tx.state = "NOT_INCLUDED"
        x.tx.replacedBy = p.by
      }, p.detail)
    case "PENDING":
      return journal.update(actionId, "still-pending", (x) => (x.tx.state = "PENDING"), p.detail)
    case "UNKNOWN":
      return journal.update(actionId, "unresolved", (x) => (x.tx.state = "UNKNOWN"), p.detail)
  }
}

// For an action the run's own ledger sent (txlog.ts), the ledger is the authority: copy
// its settled state instead of looking the transaction up again.
export function mirrorStep(
  journal: ActionJournal,
  actionId: string,
  step: { state: TxState; hash: Hex; receipt?: { blockNumber: bigint; blockHash: Hex }; replacedBy?: Hex; lastProbe?: string },
): ActionRecord {
  const r = journal.get(actionId)
  if (r.tx.hash && r.tx.hash.toLowerCase() !== step.hash.toLowerCase()) throw new JournalError(`ledger step ${step.hash} is not action ${actionId}'s transaction ${r.tx.hash}`)
  if (r.tx.state === step.state && r.tx.blockHash === step.receipt?.blockHash) return r
  return journal.update(
    actionId,
    `ledger: ${step.state.toLowerCase()}`,
    (x) => {
      x.tx.state = step.state
      if (step.receipt) {
        x.tx.blockNumber = step.receipt.blockNumber.toString()
        x.tx.blockHash = step.receipt.blockHash
      }
      if (step.replacedBy) x.tx.replacedBy = step.replacedBy
    },
    step.lastProbe,
  )
}
