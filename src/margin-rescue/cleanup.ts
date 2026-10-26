// Unwind a live run, every order through the ReduceOnlyGuard.
//
// Cleanup is driven by what the chain shows, not by what the run thinks it did. It
// first resolves any open transaction (it sends nothing while one is unknown), then
// closes each remaining position with a guarded full close: the exact signed position
// just read, the opposite side, the whole size, a protective IOC limit, a short
// deadline, journalled before it is sent. There is no unguarded fallback: if the guard
// cannot close a position (no verified guard, no liquidity inside the limit, a revert
// after the attempts) the position is left and reported. Then it revokes the guard's
// grants, withdraws the collateral only once no position or order remains, clears the
// allowance, and verifies the end state at one pinned block across every pool before
// calling the cleanup verified.
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem"
import { erc20Abi, marginBankAbi, marginBankWriteAbi, operatorRegistryAbi, perpPoolAbi, PLACE_ORDER_FOR_SELECTOR } from "./abi.js"
import { actionIdOf, newNonce, reduceCalldata, type ReduceRequest } from "./action.js"
import { protectiveLimit, simulateIoc } from "./book.js"
import { MARGIN_BANK, OPERATOR_REGISTRY, USDSO } from "./common.js"
import { verifyDeployedGuard, type GuardDeployment } from "./guardArtifact.js"
import { ActionJournal, mirrorStep } from "./journal.js"
import { abs } from "./math.js"
import { readActionReceipt, verifyBinding } from "./receipt.js"
import { poolOf, readAccountSnapshot, sameAddress, type AccountSnapshot, type StopLister } from "./snapshot.js"
import { StepRejectedError, StepRevertedError, StepWouldRevertError, UnresolvedTransactionError, type TxSender } from "./txlog.js"

export const CLEANUP_VERSION = "mr-cleanup/1"
export const MAX_CLOSE_ATTEMPTS = 3

// What a cleanup may have to undo: the pools with (possibly) open positions, the pools
// the guard (possibly) holds a grant on, and whether collateral may sit in the bank.
export interface Footprint {
  legs: string[]
  granted: string[]
  collateral: boolean
}

// Every transaction a guarded cleanup can send for `f`: per open leg, a grant if its pool
// has none yet and up to MAX_CLOSE_ATTEMPTS guarded closes; one revoke per pool that may
// hold a grant by then; one withdrawal if collateral may be there; and one allowance
// reset, always (cleanup clears any allowance it finds, whoever set it).
export function cleanupTxBound(f: Footprint): number {
  const key = (p: string) => p.toLowerCase()
  const legs = new Set(f.legs.map(key))
  const granted = new Set(f.granted.map(key))
  const grants = [...legs].filter((p) => !granted.has(p)).length
  const revokes = new Set([...legs, ...granted]).size
  return grants + legs.size * MAX_CLOSE_ATTEMPTS + revokes + (f.collateral ? 1 : 0) + 1
}

export interface CleanupCheck {
  name: string
  ok: boolean
  detail: string
}

export interface CleanupReport {
  version: typeof CLEANUP_VERSION
  verified: boolean
  closes: { pool: Address; symbol: string; attempt: number; actionId: Hex; expected: bigint; quantity: bigint; limit: bigint; tx: Hex | null; state: string; filled: bigint; bindingOk: boolean | null; note?: string }[]
  remaining: string[]
  checks: CleanupCheck[]
  final: { block: bigint; blockHash: Hex; stt: bigint; usdso: bigint } | null
}

export interface CleanupContext {
  client: PublicClient
  sender: TxSender
  journal: ActionJournal
  owner: Address
  guard: Address | null
  deployment: GuardDeployment
  pools: Address[] // pools the run may have touched (the guard's trusted pools)
  slippageBps: bigint
  closeDeadlineSeconds: number
  listStops: StopLister
  beforeClose?: (pool: Address, attempt: number) => Promise<void>
  log: (entry: Record<string, unknown>) => void
}

export async function guardedCleanup(ctx: CleanupContext): Promise<CleanupReport> {
  const { client, sender, journal, owner } = ctx
  const report: CleanupReport = { version: CLEANUP_VERSION, verified: false, closes: [], remaining: [], checks: [], final: null }
  await sender.resolveOpen()
  const snap = () => readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, bookPools: ctx.pools, listStops: ctx.listStops })
  let s = await snap()

  // 1. Guarded closes.
  if (s.positions.length) {
    const guardProblems = ctx.guard ? await verifyDeployedGuard(client, ctx.guard, ctx.deployment) : ["no guard was deployed"]
    if (guardProblems.length) {
      report.remaining.push(`positions left open: the guard is not usable (${guardProblems.join("; ")}); no unguarded order is sent`)
    } else {
      for (const position of [...s.positions]) {
        if (!ctx.pools.some((p) => sameAddress(p, position.pool))) {
          report.remaining.push(`${poolOf(s, position.pool).symbol} position is in a pool the guard does not trust; left open`)
          continue
        }
        await closePosition(ctx, report, position.pool)
      }
    }
    s = await snap()
  }

  // 2. Revoke every grant the guard holds on any pool.
  if (ctx.guard) {
    for (const pool of s.coverage.factoryPools) {
      if (await isGranted(client, owner, ctx.guard, pool)) {
        await sendOrNote(ctx, report, `cleanup-revoke-${symbolOf(s, pool)}`, OPERATOR_REGISTRY, encodeFunctionData({ abi: operatorRegistryAbi, functionName: "setOperatorApprovalForPool", args: [pool, ctx.guard, [PLACE_ORDER_FOR_SELECTOR], false] }), "revoke the guard's placeOrderFor grant")
      }
    }
  }

  // 3. Withdraw, only when nothing is left that needs margin.
  s = await snap()
  if (s.positions.length || s.orders.length) {
    report.remaining.push(`collateral left in the bank: ${s.positions.length} position(s) and ${s.orders.length} order(s) remain`)
  } else if (s.collateral.locked > 0n) {
    report.remaining.push(`locked collateral ${s.collateral.locked} with no order to release it`)
  } else if (s.collateral.unlocked > 0n) {
    await sendOrNote(ctx, report, "cleanup-withdraw", MARGIN_BANK, encodeFunctionData({ abi: marginBankWriteAbi, functionName: "withdraw", args: [s.collateral.unlocked] }), "withdraw the whole unlocked balance to the wallet")
  } else if (s.collateral.unlocked < 0n) {
    report.remaining.push(`unlocked balance is negative (${s.collateral.unlocked}); nothing to withdraw`)
  }

  // 4. Allowance.
  const allowance = await client.readContract({ address: USDSO, abi: erc20Abi, functionName: "allowance", args: [owner, MARGIN_BANK] })
  if (allowance > 0n) {
    await sendOrNote(ctx, report, "cleanup-clear-allowance", USDSO, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, 0n] }), "clear the USDso allowance")
  }

  // 5. Verify the end state at one block.
  await verifyEndState(ctx, report)
  return report
}

async function closePosition(ctx: CleanupContext, report: CleanupReport, pool: Address): Promise<void> {
  const { client, sender, journal, owner } = ctx
  const guard = ctx.guard!
  let symbol = pool.slice(0, 10)
  for (let attempt = 1; attempt <= MAX_CLOSE_ATTEMPTS; attempt++) {
    const s = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, bookPools: [pool], listStops: ctx.listStops })
    const position = s.positions.find((p) => sameAddress(p.pool, pool))
    const info = poolOf(s, pool)
    symbol = info.symbol
    if (!position) return
    const size = abs(position.size)
    if (size < info.grid.minQuantity) {
      report.remaining.push(`${info.symbol} position ${position.size} is below the venue minimum order ${info.grid.minQuantity}; no order can close it`)
      return
    }
    if (!(await isGranted(client, owner, guard, pool))) {
      try {
        await sender.send({ id: `cleanup-grant-${info.symbol}`, phase: "cleanup", purpose: `grant the guard placeOrderFor on ${info.symbol} to close it`, to: OPERATOR_REGISTRY, data: encodeFunctionData({ abi: operatorRegistryAbi, functionName: "setOperatorApprovalForPool", args: [pool, guard, [PLACE_ORDER_FOR_SELECTOR], true] }), allowForeignNonce: true })
      } catch (e) {
        if (!(e instanceof StepRevertedError) && !(e instanceof StepRejectedError) && !(e instanceof StepWouldRevertError)) throw e
        report.remaining.push(`${info.symbol}: the grant needed to close it failed (${e.message}); left open`)
        return
      }
      if (!(await isGranted(client, owner, guard, pool))) {
        report.remaining.push(`${info.symbol}: the grant did not take effect; left open`)
        return
      }
    }
    const isBid = position.size < 0n
    const book = s.books.find((b) => sameAddress(b.pool, pool))
    const side = book ? (isBid ? book.asks : book.bids) : []
    if (!side.length) {
      report.remaining.push(`${info.symbol}: no resting counterparty on the book; left open`)
      return
    }
    const limit = protectiveLimit(side[0].price, isBid, ctx.slippageBps, info.grid.tickSize)
    const preview = simulateIoc(side, isBid, size, limit)
    if (preview.filled === 0n) {
      report.remaining.push(`${info.symbol}: nothing on the book inside the protective limit ${limit}; left open (no unguarded fallback)`)
      return
    }
    await ctx.beforeClose?.(pool, attempt)
    const request: ReduceRequest = { pool, expectedSignedSize: position.size, isBid, quantity: size, limitPrice: limit, deadline: s.block.timestamp + BigInt(ctx.closeDeadlineSeconds), nonce: newNonce() }
    const binding = { chainId: 50383, guard, marginBank: MARGIN_BANK, owner }
    const actionId = actionIdOf(binding, request)
    const calldata = reduceCalldata(request)
    journal.create({
      actionId,
      kind: "CLEANUP",
      createdAt: new Date().toISOString(),
      binding,
      scenarioId: "cleanup",
      candidateId: `CLOSE-${info.symbol}`,
      request: { pool, expectedSignedSize: request.expectedSignedSize.toString(), isBid, quantity: size.toString(), limitPrice: limit.toString(), deadline: request.deadline.toString(), nonce: request.nonce },
      calldata,
      forecast: { expectedFill: preview.filled.toString(), scenarioBuffer: "0", goal: "CLOSE" },
      quote: { blockNumber: s.block.number.toString(), blockHash: s.block.hash, validUntil: request.deadline.toString() },
    })
    const entry: CleanupReport["closes"][number] = { pool, symbol: info.symbol, attempt, actionId, expected: position.size, quantity: size, limit, tx: null, state: "NOT_SENT", filled: 0n, bindingOk: null }
    report.closes.push(entry)
    try {
      const step = await sender.send({
        id: `cleanup-close-${info.symbol}-${attempt}`,
        phase: "cleanup",
        purpose: `guarded full close of ${info.symbol} (${position.size})`,
        to: guard,
        data: calldata,
        actionId,
        allowForeignNonce: true,
        beforeBroadcast: (st) => journal.update(actionId, "pending", (r) => (r.tx = { state: "PENDING", from: owner, nonce: st.nonce, hash: st.hash, sentAt: new Date().toISOString(), sentAfterBlock: st.sentAfterBlock.toString() })),
      })
      entry.tx = step.hash
      mirrorStep(journal, actionId, step)
    } catch (e) {
      if (e instanceof StepWouldRevertError) {
        // Simulated, not sent: void this close and try again from a fresh read.
        journal.update(actionId, "not sent", (r) => (r.tx.state = "INVALIDATED"), e.message.slice(0, 200))
        entry.state = "WOULD_REVERT"
        entry.note = e.reason
        ctx.log({ step: "cleanup close", symbol: info.symbol, attempt, state: entry.state, reason: e.reason })
        continue
      }
      if (e instanceof UnresolvedTransactionError) mirrorStep(journal, actionId, e.step)
      if (!(e instanceof StepRevertedError) && !(e instanceof StepRejectedError)) throw e
      entry.tx = e.step.hash
      entry.note = e.message
      mirrorStep(journal, actionId, e.step)
    }
    const settled = journal.get(actionId)
    entry.state = settled.tx.state
    if (settled.tx.state === "CONFIRMED") {
      const receipt = await readActionReceipt(client, settled.tx.hash!, { guard, pool, owner, marginBank: MARGIN_BANK, isBid, limitPrice: limit, requested: size })
      const bound = verifyBinding(settled, receipt)
      entry.filled = receipt.filled
      entry.bindingOk = bound.ok
      journal.update(actionId, "closed", (r) => {
        r.fill = { state: receipt.filled >= size ? "REQUESTED_FILL" : receipt.filled > 0n ? "PARTIAL_FILL" : "NO_FILL", requested: size.toString(), filled: receipt.filled.toString() }
        r.goal = { state: bound.ok ? "NOT_EVALUATED" : "EVIDENCE_MISMATCH", reason: bound.ok ? "cleanup close; no scenario goal" : bound.failures.join("; ") }
      })
      if (!bound.ok) {
        report.remaining.push(`${info.symbol}: the close receipt does not match its confirmation (${bound.failures.join("; ")}); stopping`)
        return
      }
    }
    ctx.log({ step: "cleanup close", symbol: info.symbol, attempt, state: entry.state, filled: entry.filled })
  }
  const last = await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [owner, pool] })
  if (last.size !== 0n) report.remaining.push(`${symbol} position ${last.size} still open after ${MAX_CLOSE_ATTEMPTS} guarded attempts; no unguarded order was sent`)
}

async function sendOrNote(ctx: CleanupContext, report: CleanupReport, id: string, to: Address, data: Hex, purpose: string): Promise<void> {
  try {
    await ctx.sender.send({ id, phase: "cleanup", purpose, to, data, allowForeignNonce: true })
  } catch (e) {
    if (!(e instanceof StepRevertedError) && !(e instanceof StepRejectedError) && !(e instanceof StepWouldRevertError)) throw e
    report.remaining.push(`${id}: ${e.message}`)
  }
}

export async function isGranted(client: PublicClient, owner: Address, operator: Address, pool: Address, blockNumber?: bigint): Promise<boolean> {
  const [registry, venue] = await Promise.all([
    client.readContract({ address: OPERATOR_REGISTRY, abi: operatorRegistryAbi, functionName: "isApprovedForPool", args: [pool, owner, operator, PLACE_ORDER_FOR_SELECTOR], blockNumber }),
    client.readContract({ address: pool, abi: perpPoolAbi, functionName: "isOperatorAuthorized", args: [owner, operator, PLACE_ORDER_FOR_SELECTOR], blockNumber }),
  ])
  return registry || venue
}

function symbolOf(s: AccountSnapshot, pool: Address): string {
  return s.pools.find((p) => sameAddress(p.pool, pool))?.symbol ?? pool.slice(0, 10)
}

// The end state, read at ONE block: nothing open anywhere, nothing in the bank, no
// allowance, no grant left for the guard, no unresolved or unguarded cleanup send.
async function verifyEndState(ctx: CleanupContext, report: CleanupReport): Promise<void> {
  const { client, owner } = ctx
  const s = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, listStops: ctx.listStops })
  const at = s.block.number
  const check = (name: string, ok: boolean, detail: string) => report.checks.push({ name, ok, detail })
  check("snapshot complete and canonical", s.problems.length === 0 && s.canonical.ok, s.problems.join("; ") || `block ${at}`)
  check("no position in any of the factory's pools", s.positions.length === 0, s.positions.map((p) => `${p.pool}:${p.size}`).join(", ") || `${s.coverage.factoryPools.length} pools read`)
  check("no resting order", s.orders.length === 0 && s.coverage.pendingOutsideActive.length === 0, `${s.orders.length} orders`)
  check("no live TP/SL stop", !s.stops.error && s.stops.rows.every((r) => !r.liveAtBlock), s.stops.error ?? `${s.stops.rows.length} listed, none live`)
  check("bank balance withdrawn", s.collateral.unlocked === 0n && s.collateral.locked === 0n, `unlocked ${s.collateral.unlocked}, locked ${s.collateral.locked}`)
  check("USDso allowance to the bank is zero", s.wallet.allowanceToBank === 0n, `${s.wallet.allowanceToBank}`)
  if (ctx.guard) {
    const granted: string[] = []
    for (const pool of s.coverage.factoryPools) if (await isGranted(client, owner, ctx.guard, pool, at)) granted.push(pool)
    const global = await client.readContract({ address: OPERATOR_REGISTRY, abi: operatorRegistryAbi, functionName: "isGloballyApproved", args: [owner, ctx.guard, PLACE_ORDER_FOR_SELECTOR], blockNumber: at })
    check("guard holds no grant on any pool, nor a global one", granted.length === 0 && !global, granted.join(", ") || `${s.coverage.factoryPools.length} pools checked; global ${global}`)
  }
  const open = ctx.sender.ledger.open()
  check("no unresolved transaction", open.length === 0, open.map((x) => `${x.id} ${x.state}`).join(", ") || "none")
  // An unguarded order is any cleanup call straight to a pool, or a placeOrder anywhere.
  const pools = new Set(s.coverage.factoryPools.map((p) => p.toLowerCase()))
  const unguarded = ctx.sender.ledger.data.steps.filter((x) => x.phase === "cleanup" && (x.selector.toLowerCase() === PLACE_ORDER_SEL || (x.to !== null && pools.has(x.to.toLowerCase()))))
  check("no unguarded order during cleanup", unguarded.length === 0, unguarded.map((x) => x.id).join(", ") || "every cleanup order went through the guard")
  const [stt, usdso] = await Promise.all([client.getBalance({ address: owner, blockNumber: at }), client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: at })])
  report.final = { block: at, blockHash: s.block.hash, stt, usdso }
  report.verified = report.checks.every((c) => c.ok) && report.remaining.length === 0
}

// placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)
const PLACE_ORDER_SEL = encodeFunctionData({ abi: perpPoolAbi, functionName: "placeOrder", args: [false, 0n, 0n, 0n, 0n, 0, 0, "0x0000000000000000000000000000000000000000", 0n] }).slice(0, 10).toLowerCase()
