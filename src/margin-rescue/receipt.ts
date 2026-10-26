// Decode what one guarded reduction actually did, from its canonical receipt and the
// transaction itself: the guard's event, the IOC's own fills (OrderFilled with this
// taker order id), and every MarginBank row naming the owner. Nothing here trusts the
// receipt status alone, and nothing is credited to an action until verifyBinding has
// tied the transaction, its calldata and the guard's event to the saved confirmation.
import { decodeEventLog, type Abi, type Address, type Hex, type Log, type PublicClient } from "viem"
import { marginBankEventsAbi, orderBookEventsAbi, perpPoolEventsAbi, reduceGuardAbi } from "./abi.js"
import { actionIdOf, reduceCalldata, type ReduceRequest } from "./action.js"
import { sameAddress, type AccountSnapshot } from "./snapshot.js"
import type { ActionRecord, FillState } from "./journal.js"

const ABI = [...orderBookEventsAbi, ...marginBankEventsAbi, ...perpPoolEventsAbi, ...reduceGuardAbi] as unknown as Abi

export interface DecodedLog {
  address: Address
  logIndex: number
  name: string
  args: Record<string, unknown>
}

export interface ReceiptFill {
  makerOrderId: bigint
  quantity: bigint
  price: bigint
}

export interface ActionReceipt {
  txHash: Hex
  status: "success" | "reverted"
  blockNumber: bigint
  blockHash: Hex
  canonical: boolean
  from: Address
  to: Address | null
  gasUsed: bigint
  // The transaction as the node returns it (eth_getTransactionByHash).
  tx: { from: Address; to: Address | null; input: Hex; nonce: number; value: bigint; chainId: number | null }
  guardEvents: number // ReduceExecuted events from ANY address in this transaction
  placedBy: Address | null // owner of the pool's OrderPlaced row for the taker order
  guard: { actionId: Hex; pool: Address; orderId: bigint; sizeBefore: bigint; sizeAfter: bigint; quantity: bigint; limitPrice: bigint } | null
  takerOrderId: bigint | null
  fills: ReceiptFill[]
  filled: bigint
  rested: boolean
  priceBoundRespected: boolean
  owner: {
    positionUpdates: { pool: Address; newSize: bigint; avgEntryPrice: bigint; realizedPnl: bigint; entryFundingIndex: bigint }[]
    fundingSettled: { pool: Address; payment: bigint }[]
    fees: { pool: Address; amount: bigint }[]
    locked: bigint
    unlocked: bigint
    walletMoves: string[] // Deposited / DepositedFor / Withdrawn rows: must be empty
    otherPools: string[] // bank rows for the owner in any pool but the target
    other: string[] // any other bank row naming the owner
  }
  logs: DecodedLog[]
}

export interface ReceiptExpectation {
  guard: Address
  pool: Address
  owner: Address
  marginBank: Address
  isBid: boolean
  limitPrice: bigint
  requested: bigint
}

export function decodeLogs(logs: Log[]): DecodedLog[] {
  const out: DecodedLog[] = []
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] })
      out.push({ address: l.address, logIndex: Number(l.logIndex), name: String(d.eventName), args: d.args as unknown as Record<string, unknown> })
    } catch {
      out.push({ address: l.address, logIndex: Number(l.logIndex), name: "unknown", args: { topic0: l.topics[0] } })
    }
  }
  return out
}

export async function readActionReceipt(client: PublicClient, txHash: Hex, expect: ReceiptExpectation): Promise<ActionReceipt> {
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: txHash }), client.getTransaction({ hash: txHash })])
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  return summarize(
    {
      txHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      canonical: block.hash === receipt.blockHash,
      from: receipt.from,
      to: receipt.to,
      gasUsed: receipt.gasUsed,
      tx: { from: tx.from, to: tx.to ?? null, input: tx.input, nonce: tx.nonce, value: tx.value, chainId: tx.chainId ?? null },
    },
    decodeLogs(receipt.logs as Log[]),
    expect,
  )
}

export function summarize(
  head: Pick<ActionReceipt, "txHash" | "status" | "blockNumber" | "blockHash" | "canonical" | "from" | "to" | "gasUsed" | "tx">,
  logs: DecodedLog[],
  expect: ReceiptExpectation,
): ActionReceipt {
  const isOwner = (a: unknown) => typeof a === "string" && sameAddress(a, expect.owner)
  const guardLog = logs.find((l) => l.name === "ReduceExecuted" && sameAddress(l.address, expect.guard))
  const guard = guardLog
    ? {
        actionId: guardLog.args.actionId as Hex,
        pool: guardLog.args.pool as Address,
        orderId: guardLog.args.orderId as bigint,
        sizeBefore: guardLog.args.sizeBefore as bigint,
        sizeAfter: guardLog.args.sizeAfter as bigint,
        quantity: guardLog.args.quantity as bigint,
        limitPrice: guardLog.args.limitPrice as bigint,
      }
    : null
  const takerOrderId = guard?.orderId ?? null
  const placed = logs.find((l) => l.name === "OrderPlaced" && sameAddress(l.address, expect.pool) && (l.args.orderId as bigint) === takerOrderId)
  const placedBy = placed ? ((placed.args.placedOrder as { owner: Address }).owner ?? null) : null
  const fills: ReceiptFill[] = logs
    .filter((l) => l.name === "OrderFilled" && sameAddress(l.address, expect.pool) && takerOrderId !== null && (l.args.takerOrderId as bigint) === takerOrderId)
    .map((l) => ({ makerOrderId: l.args.makerOrderId as bigint, quantity: l.args.quantityFilled as bigint, price: l.args.fillPrice as bigint }))
  const filled = fills.reduce((s, f) => s + f.quantity, 0n)
  const rested = logs.some((l) => l.name === "OrderRested" && sameAddress(l.address, expect.pool) && (l.args.orderId as bigint) === takerOrderId)
  const priceBoundRespected = fills.every((f) => (expect.isBid ? f.price <= expect.limitPrice : f.price >= expect.limitPrice))

  const owner: ActionReceipt["owner"] = { positionUpdates: [], fundingSettled: [], fees: [], locked: 0n, unlocked: 0n, walletMoves: [], otherPools: [], other: [] }
  for (const l of logs) {
    if (!sameAddress(l.address, expect.marginBank)) continue
    const a = l.args
    const mine = isOwner(a.account) || isOwner(a.from) || isOwner(a.to) || isOwner(a.counterparty) || isOwner(a.bankrupt) || isOwner(a.payer) || isOwner(a.child)
    if (!mine) continue
    const pool = (a.perpPool as Address | undefined) ?? null
    if (pool && !sameAddress(pool, expect.pool)) {
      owner.otherPools.push(`${l.name} in ${pool}`)
      continue
    }
    switch (l.name) {
      case "PositionUpdated":
        owner.positionUpdates.push({ pool: pool!, newSize: a.newSize as bigint, avgEntryPrice: a.avgEntryPrice as bigint, realizedPnl: a.realizedPnl as bigint, entryFundingIndex: a.entryFundingIndex as bigint })
        break
      case "FundingSettled":
        owner.fundingSettled.push({ pool: pool!, payment: a.payment as bigint })
        break
      case "FeeCharged":
        owner.fees.push({ pool: pool!, amount: a.amount as bigint })
        break
      case "CollateralLocked":
        owner.locked += a.amount as bigint
        break
      case "CollateralUnlocked":
        owner.unlocked += a.amount as bigint
        break
      case "Deposited":
      case "DepositedFor":
      case "Withdrawn":
      case "MainFundedChild":
        owner.walletMoves.push(`${l.name} ${a.amount}`)
        break
      default:
        owner.other.push(l.name)
    }
  }
  const guardEvents = logs.filter((l) => l.name === "ReduceExecuted").length
  return { ...head, guardEvents, placedBy, guard, takerOrderId, fills, filled, rested, priceBoundRespected, owner, logs }
}

export function requestOf(r: ActionRecord): ReduceRequest {
  return {
    pool: r.request.pool,
    expectedSignedSize: BigInt(r.request.expectedSignedSize),
    isBid: r.request.isBid,
    quantity: BigInt(r.request.quantity),
    limitPrice: BigInt(r.request.limitPrice),
    deadline: BigInt(r.request.deadline),
    nonce: r.request.nonce,
  }
}

export interface BindingResult {
  ok: boolean
  failures: string[]
}

// Tie one receipt (and the snapshot read after it) to the SAVED confirmation, field by
// field. Any mismatch rejects the evidence: nothing in it may be credited to the action.
export function verifyBinding(record: ActionRecord, receipt: ActionReceipt, snapshots: { pre?: AccountSnapshot; post?: AccountSnapshot } = {}): BindingResult {
  const f: string[] = []
  const expect = (ok: boolean, what: string) => {
    if (!ok) f.push(what)
  }
  const req = requestOf(record)
  const b = record.binding
  // The confirmation itself must be internally consistent.
  expect(b.chainId === 50383, `confirmation chain ${b.chainId} is not 50383`)
  expect(actionIdOf(b, req) === record.actionId, "the saved action id does not commit to the saved request and binding")
  expect(reduceCalldata(req).toLowerCase() === record.calldata.toLowerCase(), "the saved calldata does not encode the saved request")
  // The transaction is the one this confirmation sent.
  expect(!!record.tx.hash && receipt.txHash.toLowerCase() === record.tx.hash.toLowerCase(), `transaction ${receipt.txHash} is not the journalled ${record.tx.hash ?? "(none)"}`)
  expect(sameAddress(receipt.tx.from, b.owner) && sameAddress(receipt.from, b.owner), `sender ${receipt.tx.from} is not the owner ${b.owner}`)
  expect(!!receipt.tx.to && sameAddress(receipt.tx.to, b.guard) && !!receipt.to && sameAddress(receipt.to, b.guard), `destination ${receipt.tx.to} is not the guard ${b.guard}`)
  expect(receipt.tx.input.toLowerCase() === record.calldata.toLowerCase(), "transaction calldata differs from the confirmed calldata")
  expect(receipt.tx.value === 0n, `transaction carries value ${receipt.tx.value}`)
  expect(receipt.tx.chainId === null || receipt.tx.chainId === 50383, `transaction chain ${receipt.tx.chainId}`)
  expect(record.tx.nonce === undefined || receipt.tx.nonce === record.tx.nonce, `transaction nonce ${receipt.tx.nonce} is not the journalled ${record.tx.nonce}`)
  expect(receipt.canonical, "receipt block is not canonical")
  // The guard's own record of what it executed.
  if (receipt.status === "success") {
    expect(receipt.guardEvents === 1, `${receipt.guardEvents} ReduceExecuted events in the transaction (expected exactly 1)`)
    const g = receipt.guard
    if (!g) f.push(`no ReduceExecuted event from the guard ${b.guard}`)
    else {
      expect(g.actionId.toLowerCase() === record.actionId.toLowerCase(), `guard event action id ${g.actionId} is not the confirmed ${record.actionId}`)
      expect(sameAddress(g.pool, req.pool), `guard event pool ${g.pool} is not the confirmed ${req.pool}`)
      expect(g.quantity === req.quantity, `guard event quantity ${g.quantity} is not the confirmed ${req.quantity}`)
      expect(g.limitPrice === req.limitPrice, `guard event limit ${g.limitPrice} is not the confirmed ${req.limitPrice}`)
      expect(g.sizeBefore === req.expectedSignedSize, `guard event size before ${g.sizeBefore} is not the confirmed ${req.expectedSignedSize}`)
    }
    expect(!!receipt.placedBy && sameAddress(receipt.placedBy, b.owner), `the taker order was placed for ${receipt.placedBy ?? "nobody"}, not the owner`)
  } else {
    expect(receipt.guardEvents === 0 && receipt.fills.length === 0, "a reverted transaction shows guard events or fills")
  }
  // Snapshots must be the account's, read before the transaction and AT its block.
  const { pre, post } = snapshots
  if (pre) {
    expect(sameAddress(pre.account, b.owner), "pre-execution snapshot is another account")
    expect(pre.block.number < receipt.blockNumber, `pre-execution snapshot block ${pre.block.number} is not before the receipt block ${receipt.blockNumber}`)
  }
  if (post) {
    expect(sameAddress(post.account, b.owner), "post-execution snapshot is another account")
    expect(post.block.number === receipt.blockNumber && post.block.hash.toLowerCase() === receipt.blockHash.toLowerCase(), `post snapshot block ${post.block.number} ${post.block.hash} is not the receipt block ${receipt.blockNumber} ${receipt.blockHash}`)
  }
  return { ok: f.length === 0, failures: f }
}

export function fillState(r: ActionReceipt, requested: bigint): FillState {
  if (r.status !== "success" || r.filled === 0n) return "NO_FILL"
  return r.filled >= requested ? "REQUESTED_FILL" : "PARTIAL_FILL"
}
