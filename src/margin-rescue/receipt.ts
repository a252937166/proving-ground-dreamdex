// Decode what one guarded reduction actually did, from its canonical receipt: the
// guard's event, the IOC's own fills (OrderFilled with this taker order id), and every
// MarginBank row naming the owner. Nothing here trusts the receipt status alone.
import { decodeEventLog, type Abi, type Address, type Hex, type Log, type PublicClient } from "viem"
import { marginBankEventsAbi, orderBookEventsAbi, perpPoolEventsAbi, reduceGuardAbi } from "./abi.js"
import { sameAddress } from "./snapshot.js"
import type { FillState } from "./journal.js"

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
  const receipt = await client.getTransactionReceipt({ hash: txHash })
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
    },
    decodeLogs(receipt.logs as Log[]),
    expect,
  )
}

export function summarize(
  head: Pick<ActionReceipt, "txHash" | "status" | "blockNumber" | "blockHash" | "canonical" | "from" | "to" | "gasUsed">,
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
  const placed = logs.find((l) => l.name === "OrderPlaced" && sameAddress(l.address, expect.pool) && isOwner((l.args.placedOrder as { owner: string }).owner))
  const takerOrderId = guard?.orderId ?? ((placed?.args.orderId as bigint | undefined) ?? null)
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
  return { ...head, guard, takerOrderId, fills, filled, rested, priceBoundRespected, owner, logs }
}

export function fillState(r: ActionReceipt, requested: bigint): FillState {
  if (r.status !== "success" || r.filled === 0n) return "NO_FILL"
  return r.filled >= requested ? "REQUESTED_FILL" : "PARTIAL_FILL"
}
