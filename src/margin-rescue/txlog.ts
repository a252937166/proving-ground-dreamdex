// Every transaction one live run sends, in order, persisted BEFORE it is broadcast.
//
// A step records its intent (destination, selector, keccak of the calldata, nonce, gas,
// gas price) and the hash of the signed bytes; the bytes themselves are never written.
// A step is PENDING from the moment it is persisted until a canonical receipt settles
// it, UNKNOWN if its outcome is not established in time, and NOT_INCLUDED only when the
// node explicitly rejected it or the transaction that consumed its nonce was located and
// is a different one (outcome.ts). A failed lookup or a bare nonce increase settles
// nothing. While any step is PENDING or UNKNOWN nothing else is sent and its worst-case
// fee stays reserved: the sender resolves it first, from its own hash and nonce, and
// never sends it again. If it cannot be resolved in the bounded wait the run stops
// (UnresolvedTransactionError) and can be resumed later.
//
// Gas: each send must fit the plan's STT cap after the fees already paid, and while the
// run is still opening exposure it must also leave a reserve for every cleanup step the
// current state may need, both under the cap and in the wallet.
import { keccak256, BaseError, decodeErrorResult, ExecutionRevertedError, HttpRequestError, TimeoutError, toFunctionSelector, type Abi, type Address, type Hex, type PublicClient, type TransactionSerializable } from "viem"
import { formatAbiItem } from "viem/utils"
import { contractErrorsAbi, reduceGuardAbi } from "./abi.js"
import { probeTransaction } from "./outcome.js"
import { prettyJson, writeFileAtomic } from "./json.js"

export const RUN_LEDGER_VERSION = "mr-run-ledger/1"

export type StepState = "PENDING" | "UNKNOWN" | "CONFIRMED" | "REVERTED" | "NOT_INCLUDED"
export type Phase = "main" | "cleanup"

export interface StepReceipt {
  blockNumber: bigint
  blockHash: Hex
  status: "success" | "reverted"
  gasUsed: bigint
  effectiveGasPrice: bigint
  fee: bigint
  contractAddress: Address | null
}

export interface TxStep {
  n: number
  id: string
  phase: Phase
  purpose: string
  actionId?: Hex
  from: Address
  to: Address | null
  selector: Hex
  dataKeccak: Hex
  nonce: number
  gas: bigint
  gasPrice: bigint
  maxCost: bigint
  reserveAtSend: bigint // STT kept aside at send time: cleanup reserve + unsettled steps
  cleanupTxReserved: number
  // Latest block seen before the nonce was read: the nonce was still free there.
  sentAfterBlock: bigint
  hash: Hex
  state: StepState
  receipt?: StepReceipt
  replacedBy?: Hex
  lastProbe?: string
  history: { at: string; event: string; detail?: string }[]
}

export interface RunLedger {
  version: typeof RUN_LEDGER_VERSION
  planDigest: string
  account: Address
  chainId: number
  gasCap: bigint
  startNonce: number
  createdAt: string
  steps: TxStep[]
  foreignActivity: { at: string; detail: string }[]
}

export interface Signer {
  address: Address
  signTransaction(tx: TransactionSerializable): Promise<Hex>
}

export interface SenderTiming {
  receiptTimeoutMs: number // wait for a receipt after broadcasting
  resolveTimeoutMs: number // further bounded resolution of a step that has none
  pollMs: number
}

export interface SenderOptions extends SenderTiming {
  chainId: number
  gasCap: bigint
  maxGasPrice: bigint
  gasHeadroomPct: bigint // gas limit = estimate × (100 + headroom) / 100
  cleanupGasPerTx: bigint // gas reserved for each cleanup transaction a main step may require
  sleep?: (ms: number) => Promise<void>
}

export class UnresolvedTransactionError extends Error {
  constructor(readonly step: TxStep) {
    super(`step ${step.n} ${step.id} (${step.hash}) is ${step.state}; resolve it before sending anything else`)
  }
}
export class GasBudgetError extends Error {}
export class ForeignTransactionError extends Error {}
export class StepRevertedError extends Error {
  constructor(readonly step: TxStep) {
    super(`step ${step.n} ${step.id} reverted (${step.hash})`)
  }
}
// The node's simulation (eth_estimateGas) says the call would revert now. Nothing was
// signed or sent; the caller decides whether to re-read and try again.
export class StepWouldRevertError extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(`${id} would revert now (${reason}); nothing was sent`)
  }
}
export class StepRejectedError extends Error {
  constructor(readonly step: TxStep) {
    super(`step ${step.n} ${step.id} was rejected by the node: ${step.history.at(-1)?.detail ?? ""}`)
  }
}

const OPEN: StepState[] = ["PENDING", "UNKNOWN"]

export class TxLedger {
  constructor(
    readonly path: string,
    readonly data: RunLedger,
  ) {}

  static create(path: string, init: Omit<RunLedger, "version" | "steps" | "createdAt" | "foreignActivity">): TxLedger {
    const l = new TxLedger(path, { version: RUN_LEDGER_VERSION, ...init, createdAt: new Date().toISOString(), steps: [], foreignActivity: [] })
    l.save()
    return l
  }

  save(): void {
    writeFileAtomic(this.path, prettyJson(this.data))
  }

  open(): TxStep[] {
    return this.data.steps.filter((s) => OPEN.includes(s.state))
  }

  // Fees actually paid by settled steps.
  spent(): bigint {
    return this.data.steps.reduce((s, x) => s + (x.receipt?.fee ?? 0n), 0n)
  }

  // Worst case still committed by steps whose outcome is not known.
  committed(): bigint {
    return this.open().reduce((s, x) => s + x.maxCost, 0n)
  }

  step(id: string): TxStep | undefined {
    return [...this.data.steps].reverse().find((s) => s.id === id)
  }

  mark(step: TxStep, event: string, mutate?: (s: TxStep) => void, detail?: string): TxStep {
    mutate?.(step)
    step.history.push({ at: new Date().toISOString(), event, detail })
    this.save()
    return step
  }
}

export interface SendSpec {
  id: string
  phase: Phase
  purpose: string
  to: Address | null
  data: Hex
  actionId?: Hex
  // Called after the step (with its hash) is persisted and before the bytes are sent.
  beforeBroadcast?: (step: TxStep) => void
  // Cleanup only: proceed even though another transaction was sent from the account
  // since this run's last step (it is recorded, and the run is reported as failed).
  allowForeignNonce?: boolean
  // Main phase: how many cleanup transactions the run could need if it stopped right
  // after this step (cleanup.ts cleanupTxBound). Reserved at cleanupGasPerTx each.
  cleanupTx?: number
}

export class TxSender {
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    readonly ledger: TxLedger,
    readonly client: PublicClient,
    readonly signer: Signer,
    readonly opts: SenderOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  // Send one step and wait until it is settled. Throws UnresolvedTransactionError if it
  // is not, StepRevertedError if it reverted, and refuses to start while another step
  // is open or when the gas budget does not allow it.
  async send(spec: SendSpec): Promise<TxStep> {
    await this.resolveOpen()
    const { client, ledger, opts } = this
    const owner = this.signer.address
    const gasPrice = await client.getGasPrice()
    if (gasPrice > opts.maxGasPrice) throw new GasBudgetError(`gas price ${gasPrice} is above the plan's maximum ${opts.maxGasPrice}`)
    let estimate: bigint
    try {
      estimate = await client.estimateGas({ account: owner, to: spec.to ?? undefined, data: spec.data })
    } catch (e) {
      if (wouldRevert(e)) throw new StepWouldRevertError(spec.id, revertReason(e))
      throw e
    }
    const gas = (estimate * (100n + opts.gasHeadroomPct)) / 100n
    const maxCost = gas * gasPrice
    // Open steps were resolved above, so nothing is committed unless resolution is
    // bypassed; it is still counted, with the cleanup reserve, against cap and wallet.
    if (spec.phase === "main" && spec.cleanupTx === undefined) throw new GasBudgetError(`${spec.id}: a main-phase step must state the cleanup it could require`)
    const cleanupTx = spec.phase === "main" ? spec.cleanupTx! : 0
    const reserve = BigInt(cleanupTx) * opts.cleanupGasPerTx * gasPrice + ledger.committed()
    const spent = ledger.spent()
    if (spent + maxCost + reserve > opts.gasCap) {
      throw new GasBudgetError(`${spec.id}: fees paid ${spent} + this step up to ${maxCost} + reserve ${reserve} (cleanup and pending) exceed the STT cap ${opts.gasCap}`)
    }
    const balance = await client.getBalance({ address: owner })
    if (balance < maxCost + reserve) throw new GasBudgetError(`${spec.id}: wallet STT ${balance} is below this step's ${maxCost} plus the reserve ${reserve}`)
    const sentAfterBlock = await client.getBlockNumber()
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: owner, blockTag: "latest" }),
      client.getTransactionCount({ address: owner, blockTag: "pending" }),
    ])
    if (pending !== latest) throw new ForeignTransactionError(`the account has ${pending - latest} pending transaction(s) this run did not send`)
    const last = ledger.data.steps.at(-1)
    const expected = last ? (last.state === "NOT_INCLUDED" ? last.nonce : last.nonce + 1) : ledger.data.startNonce
    if (latest !== expected) {
      const note = `account nonce is ${latest}; this run expected ${expected}: another transaction was sent from the account`
      if (!spec.allowForeignNonce) throw new ForeignTransactionError(note)
      ledger.data.foreignActivity.push({ at: new Date().toISOString(), detail: note })
      ledger.save()
    }

    const serialized = await this.signer.signTransaction({ chainId: opts.chainId, type: "legacy", to: spec.to ?? undefined, data: spec.data, gas, gasPrice, nonce: latest, value: 0n })
    const step: TxStep = {
      n: ledger.data.steps.length + 1,
      id: spec.id,
      phase: spec.phase,
      purpose: spec.purpose,
      actionId: spec.actionId,
      from: owner,
      to: spec.to,
      selector: spec.data.slice(0, 10) as Hex,
      dataKeccak: keccak256(spec.data),
      nonce: latest,
      gas,
      gasPrice,
      maxCost,
      reserveAtSend: reserve,
      cleanupTxReserved: cleanupTx,
      sentAfterBlock,
      hash: keccak256(serialized),
      state: "PENDING",
      history: [{ at: new Date().toISOString(), event: "signed and persisted; broadcasting" }],
    }
    ledger.data.steps.push(step)
    ledger.save()
    spec.beforeBroadcast?.(step)

    try {
      await client.request({ method: "eth_sendRawTransaction", params: [serialized] })
      ledger.mark(step, "accepted by the node")
    } catch (e) {
      const message = shortMessage(e)
      if (ambiguous(e) || /already known|known transaction|nonce too low/i.test(message)) {
        ledger.mark(step, "broadcast outcome unknown", (s) => (s.state = "UNKNOWN"), message)
      } else {
        // A JSON-RPC error answer: the node refused the transaction, so it is not in
        // its pool and its nonce stays free.
        ledger.mark(step, "rejected by the node", (s) => (s.state = "NOT_INCLUDED"), message)
        throw new StepRejectedError(step)
      }
    }
    await this.settle(step, opts.receiptTimeoutMs)
    if (OPEN.includes(step.state)) await this.settle(step, opts.resolveTimeoutMs)
    if (OPEN.includes(step.state)) {
      ledger.mark(step, "unresolved after the bounded wait", (s) => (s.state = "UNKNOWN"))
      throw new UnresolvedTransactionError(step)
    }
    if (step.state === "NOT_INCLUDED") throw new ForeignTransactionError(`step ${step.id}: nonce ${step.nonce} was consumed by another transaction`)
    if (step.state === "REVERTED") throw new StepRevertedError(step)
    return step
  }

  // Resolve every open step of the ledger (a resumed run starts here). Throws if one
  // stays open.
  async resolveOpen(): Promise<void> {
    for (const step of this.ledger.open()) {
      await this.settle(step, this.opts.resolveTimeoutMs)
      if (OPEN.includes(step.state)) {
        this.ledger.mark(step, "unresolved after the bounded wait", (s) => (s.state = "UNKNOWN"))
        throw new UnresolvedTransactionError(step)
      }
    }
  }

  // Poll one open step from chain data alone until it settles or `budgetMs` runs out.
  // Only a canonical receipt (CONFIRMED / REVERTED, fee recorded) or a located
  // replacement (NOT_INCLUDED) settles it; everything else leaves it open.
  private async settle(step: TxStep, budgetMs: number): Promise<void> {
    const { client, ledger } = this
    for (let waited = 0; ; waited += this.opts.pollMs) {
      const p = await probeTransaction(client, { hash: step.hash, from: step.from, nonce: step.nonce, sentAfterBlock: step.sentAfterBlock })
      if (p.state === "MINED") {
        const receipt = p.receipt
        const effectiveGasPrice = receipt.effectiveGasPrice ?? step.gasPrice
        ledger.mark(step, receipt.status === "success" ? "confirmed" : "reverted", (s) => {
          s.state = receipt.status === "success" ? "CONFIRMED" : "REVERTED"
          s.lastProbe = p.detail
          s.receipt = {
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            status: receipt.status,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice,
            fee: receipt.gasUsed * effectiveGasPrice,
            contractAddress: receipt.contractAddress ?? null,
          }
        })
        return
      }
      if (p.state === "REPLACED") {
        ledger.mark(step, "nonce consumed by another transaction", (s) => {
          s.state = "NOT_INCLUDED"
          s.replacedBy = p.by
          s.lastProbe = p.detail
        }, p.detail)
        return
      }
      if (p.detail !== step.lastProbe) ledger.mark(step, p.state === "PENDING" ? "pending" : "outcome not established", (s) => (s.lastProbe = p.detail), p.detail)
      if (waited >= budgetMs) return
      await this.sleep(this.opts.pollMs)
    }
  }
}

function wouldRevert(e: unknown): boolean {
  if (!(e instanceof BaseError) || ambiguous(e)) return false
  return !!e.walk((x) => x instanceof ExecutionRevertedError || /revert/i.test((x as Error).message ?? ""))
}

// The revert's custom error by name when the venue's or the guard's ABI knows it.
export function revertReason(e: unknown): string {
  const withData = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null) : null
  if (withData?.data && withData.data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: [...reduceGuardAbi, ...contractErrorsAbi] as unknown as Abi, data: withData.data })
      return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`
    } catch {
      return withData.data.slice(0, 10)
    }
  }
  const sig = /custom error (0x[0-9a-f]{8})/i.exec(shortMessage(e))?.[1]
  if (sig) {
    for (const item of [...reduceGuardAbi, ...contractErrorsAbi] as unknown as Abi) {
      if (item.type === "error" && toFunctionSelector(formatAbiItem(item)) === sig.toLowerCase()) return `${item.name}()`
    }
  }
  return shortMessage(e)
}

function shortMessage(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string }
  return String(err?.details ?? err?.shortMessage ?? err?.message ?? e).split("\n")[0].slice(0, 200)
}

// A transport failure (timeout, connection reset, HTTP error) does not say whether the
// node received the transaction.
function ambiguous(e: unknown): boolean {
  if (e instanceof BaseError) return !!e.walk((x) => x instanceof TimeoutError || x instanceof HttpRequestError)
  return true
}
