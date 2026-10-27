// The live validation run for ONE approved plan, as a library so the fork rehearsal can
// drive exactly the code the live command runs.
//
//   preflight → deploy the guard and verify its code → exact allowance → deposit →
//   open the BTC long and the ETH short → analyse under the plan's scenario and journal
//   the confirmation → grant the guard on that pool only → refresh the whole account
//   and re-check the confirmation → send the guarded reduction → bind the receipt to
//   the confirmation and recompute the same scenario → guarded cleanup → verify.
//
// Every transaction goes through TxSender (persisted before broadcast, never re-sent,
// resolved before anything dependent is sent, gas reserved for cleanup). The loss
// threshold is a SOFT stop: equity is checked between steps, so a loss can exceed it
// before the next check and while unwinding. Hooks exist only for fork rehearsals that
// inject faults; the live command passes none.
import { encodeFunctionData, getContractAddress, type Address, type Hex, type PublicClient } from "viem"
import { join } from "node:path"
import { appendFileSync, existsSync } from "node:fs"
import { erc20Abi, marginBankAbi, marginBankWriteAbi, operatorRegistryAbi, ORDER_TYPE_IOC, PLACE_ORDER_FOR_SELECTOR, perpPoolAbi, SELF_MATCH_CANCEL_TAKER } from "./abi.js"
import { actionIdOf, reduceCalldata, requestFromCandidate, rescueNonce } from "./action.js"
import { protectiveLimit } from "./book.js"
import { analyzeCandidates, type CandidateAnalysis } from "./candidates.js"
import { cleanupTxBound, guardedCleanup, isGranted, type CleanupReport, type Footprint } from "./cleanup.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, OPERATOR_REGISTRY, readBigJson, USDSO } from "./common.js"
import { guardDeployment, loadGuardArtifact, verifyDeployedGuard, type GuardDeployment } from "./guardArtifact.js"
import { ActionJournal, mirrorStep, resolveAction, type ActionRecord } from "./journal.js"
import { prettyJson, readJson, writeFileAtomic } from "./json.js"
import type { LivePlan } from "./livePlan.js"
import { liveWriteDir, realOf, within } from "./paths.js"
import { reconcile } from "./reconcile.js"
import { bankLogsForOwner, recompute, type RecomputeResult } from "./recompute.js"
import { readActionReceipt } from "./receipt.js"
import { refreshConfirmation } from "./refresh.js"
import { renderAnalysis, renderRecompute } from "./report.js"
import { assertHideki } from "./rpc.js"
import { buildScenario, type Scenario } from "./scenario.js"
import { poolOf, readAccountSnapshot, sameAddress, type AccountSnapshot, type StopLister } from "./snapshot.js"
import { GasBudgetError, NOT_BROADCAST, StepRejectedError, StepRevertedError, StepWouldRevertError, TxLedger, TxSender, UnresolvedTransactionError, type RunTracker, type Signer, type SenderTiming } from "./txlog.js"

export const RUN_VERSION = "mr-live-run/4"

// REFUSED: the run stopped before it signed anything (a failed preflight, say) and left
// the account exactly as it found it; no cleanup runs for it. SIGNED_NOT_SENT: it signed
// a transaction but none of its transactions ever reached the node; no cleanup either.
// FAILED_AFTER_START and STATE_UNKNOWN are given by the command (liveCli.ts) to a run
// that ends in an unexpected error: after transactions reached the network with none
// left unresolved, and when the run's state cannot be read back.
export type RunStatus = "COMPLETE" | "REFUSED" | "SIGNED_NOT_SENT" | "NOT_DEMONSTRATED" | "ABORTED" | "CLEANUP_INCOMPLETE" | "UNRESOLVED_TX" | "FAILED_AFTER_START" | "STATE_UNKNOWN"
// Exit codes of `npm run mr:live`. Only COMPLETE is 0.
export const EXIT: Record<RunStatus, number> = { COMPLETE: 0, REFUSED: 1, SIGNED_NOT_SENT: 2, NOT_DEMONSTRATED: 10, ABORTED: 20, CLEANUP_INCOMPLETE: 30, UNRESOLVED_TX: 40, FAILED_AFTER_START: 50, STATE_UNKNOWN: 60 }

// The run ended, but its result could not be written: the command reports the run's
// state from the ledger instead of trusting a status nobody can read back.
export class ResultNotPersistedError extends Error {
  constructor(
    readonly result: RunResult,
    cause: unknown,
  ) {
    super(`the run ended ${result.status}, but result.json could not be written: ${(cause as Error)?.message?.split("\n")[0] ?? String(cause)}`)
  }
}

// Gas reserved per cleanup transaction: the SDK's 10M per-order ceiling with the
// sender's 30% headroom, since the gas LIMIT is what the wallet must be able to cover.
export const CLEANUP_GAS_PER_TX = 13_000_000n
// The largest cleanup this two-leg plan can need (cleanup.ts cleanupTxBound with
// MAX_CLOSE_ATTEMPTS = 3): 2 grants + 2×3 closes + 2 revokes + withdraw + allowance = 12.
export const CLEANUP_TX_WORST_CASE = cleanupTxBound({ legs: [BTC_POOL, ETH_POOL], granted: [], collateral: true })

export type Checkpoint = "afterDeploy" | "afterOpen" | "afterAnalysis" | "beforeRefresh" | "beforeReduceSend" | "afterReduce" | "beforeCleanupClose"

export interface Timing extends SenderTiming {
  deadlineSeconds: number // confirmation deadline after its analysis block
  closeDeadlineSeconds: number
  minSecondsLeft: number // the refresh refuses a confirmation with less time left
}

export const LIVE_TIMING: Timing = { receiptTimeoutMs: 120_000, resolveTimeoutMs: 300_000, pollMs: 2_000, deadlineSeconds: 180, closeDeadlineSeconds: 120, minSecondsLeft: 30 }

export interface RunOptions {
  plan: LivePlan
  planDigest: string
  client: PublicClient
  signer: Signer
  out: string
  listStops: StopLister
  timing?: Timing
  resume?: boolean
  hooks?: Partial<Record<Checkpoint, (info: HookInfo) => Promise<void>>>
  log?: (entry: Record<string, unknown>) => void
  tracker?: RunTracker // shared with the command, which classifies an unexpected error
}

// What a fork rehearsal's fault injector is told at each checkpoint.
export interface HookInfo {
  owner: Address
  guard: Address | null
  pool?: Address
  attempt?: number
  record?: ActionRecord
}

export interface RunResult {
  version: typeof RUN_VERSION
  status: RunStatus
  exitCode: number
  reason: string | null
  guard: Address | null
  rescue: { actionId: Hex; tx: Hex | null; txState: string; fill: string; goal: string; goalReason: string } | null
  invalidated: { actionId: Hex; reasons: string[] }[]
  cleanup: CleanupReport | null
  foreignActivity: { at: string; detail: string }[]
  // spent: fees of settled steps; committed: worst-case fees of steps still unresolved.
  gas: { cap: bigint; spent: bigint; committed: bigint }
  sentTransactions: number
  // false when some log lines could not be written; the ledger and journal are the record.
  logComplete: boolean
}

interface RunState {
  version: typeof RUN_VERSION
  planDigest: string
  account: Address
  guard: Address | null
  rescueActionId: Hex | null
  invalidated: { actionId: Hex; reasons: string[] }[]
  notDemonstrated: string | null
  abort: string | null
}

class Abort extends Error {}
class NotDemonstrated extends Error {}

export async function runLive(opts: RunOptions): Promise<RunResult> {
  const { plan, client, signer, out } = opts
  const timing = opts.timing ?? LIVE_TIMING
  const owner = signer.address
  // Logging is best effort: a log line that cannot be written must not stop a run
  // halfway. The ledger and the journal, which are persisted, are what the run relies on.
  let logFailures = 0
  const log = (entry: Record<string, unknown>) => {
    try {
      opts.log?.({ at: new Date().toISOString(), ...entry })
    } catch {
      logFailures++
    }
  }
  const hook = async (c: Checkpoint, extra: Omit<HookInfo, "owner" | "guard"> = {}) => opts.hooks?.[c]?.({ owner, guard: state.guard, ...extra })

  // Published evidence is made only by `npm run mr:publish-run`, never written by a run.
  if (within(realOf(liveWriteDir()), realOf(out))) throw new Error(`refusing to write a run into ${out}: runs are published with npm run mr:publish-run`)
  await assertHideki(client)
  if (!sameAddress(owner, plan.account.address)) throw new Error("the signing key is not the plan's account")
  const deployment = guardDeployment(loadGuardArtifact(), owner, MARGIN_BANK, [BTC_POOL, ETH_POOL])
  for (const [k, v] of [
    ["creationCodeKeccak", deployment.creationCodeKeccak],
    ["deployDataKeccak", deployment.deployDataKeccak],
    ["expectedRuntimeKeccak", deployment.expectedRuntimeKeccak],
  ] as const) {
    if (plan.guard[k] !== v) throw new Error(`the local guard build does not match the approved plan (${k} ${v} ≠ ${plan.guard[k]}); rebuild from the approved source or re-approve`)
  }

  const statePath = join(out, "run-state.json")
  const ledgerPath = join(out, "run-ledger.json")
  const journal = new ActionJournal(join(out, "journal"))
  let state: RunState
  let ledger: TxLedger
  if (opts.resume) {
    if (!existsSync(statePath) || !existsSync(ledgerPath)) throw new Error(`nothing to resume in ${out}`)
    state = readJson<RunState>(statePath)
    if (state.planDigest !== opts.planDigest) throw new Error("the run being resumed was started under another plan")
    ledger = new TxLedger(ledgerPath, readBigJson(ledgerPath))
  } else {
    if (existsSync(ledgerPath)) throw new Error(`${out} already holds a run; resume it (--resume) or use a new --out`)
    state = { version: RUN_VERSION, planDigest: opts.planDigest, account: owner, guard: null, rescueActionId: null, invalidated: [], notDemonstrated: null, abort: null }
    ledger = TxLedger.create(ledgerPath, { planDigest: opts.planDigest, account: owner, chainId: 50383, gasCap: plan.bounds.gas.sttCap, startNonce: await client.getTransactionCount({ address: owner, blockTag: "latest" }) })
  }
  const saveState = () => writeFileAtomic(statePath, prettyJson(state))
  saveState()
  const sender = new TxSender(ledger, client, signer, {
    ...timing,
    chainId: 50383,
    gasCap: plan.bounds.gas.sttCap,
    maxGasPrice: plan.network.maxGasPrice,
    gasHeadroomPct: 30n,
    cleanupGasPerTx: CLEANUP_GAS_PER_TX,
    tracker: opts.tracker,
  })
  // What a cleanup would have to undo if the run stopped now; each main-phase send
  // reserves for the footprint it can leave behind.
  const footprint: Footprint = { legs: [], granted: [], collateral: false }
  const after = (change: Partial<{ leg: Address; granted: Address; collateral: boolean }>) =>
    cleanupTxBound({
      legs: change.leg ? [...footprint.legs, change.leg] : footprint.legs,
      granted: change.granted ? [...footprint.granted, change.granted] : footprint.granted,
      collateral: footprint.collateral || !!change.collateral,
    })
  const snapshot = (bookPools: Address[] = [BTC_POOL, ETH_POOL], blockNumber?: bigint) => readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, bookPools, blockNumber, listStops: opts.listStops })
  const s = plan.bounds.maxSlippageBpsPerOrder

  // E_total against the deposit, between steps. A soft stop, not a guaranteed cap.
  const softStop = async (where: string) => {
    const [h, st] = await Promise.all([
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountHealth", args: [owner] }),
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [owner] }),
    ])
    const eTotal = h[0] + st.lockedCollateral
    log({ step: "soft loss check", where, eTotal })
    if (eTotal < plan.bounds.maxDepositUsdso - plan.bounds.softLossStopUsdso) throw new Abort(`soft loss stop at ${where}: E_total ${eTotal}`)
  }

  const grant = async (pool: Address, id: string) => {
    const guard = state.guard!
    if (await isGranted(client, owner, guard, pool)) return
    await sender.send({ id, phase: "main", purpose: `grant the guard placeOrderFor on ${pool} only`, to: OPERATOR_REGISTRY, data: encodeFunctionData({ abi: operatorRegistryAbi, functionName: "setOperatorApprovalForPool", args: [pool, guard, [PLACE_ORDER_FOR_SELECTOR], true] }), cleanupTx: after({ granted: pool }) })
    footprint.granted.push(pool)
    if (!(await isGranted(client, owner, guard, pool))) throw new Abort(`the grant on ${pool} did not take effect`)
  }

  let cleanup: CleanupReport | null = null
  let status: RunStatus | null = null
  let reason: string | null = null

  try {
    if (opts.resume) {
      await sender.resolveOpen()
      for (const r of journal.list()) {
        if (r.tx.state !== "PENDING" && r.tx.state !== "UNKNOWN") continue
        const step = ledger.data.steps.find((x) => r.tx.hash && x.hash.toLowerCase() === r.tx.hash.toLowerCase())
        if (step) mirrorStep(journal, r.actionId, step)
        else await resolveAction(journal, r.actionId, client)
      }
      const rescue = state.rescueActionId ? journal.get(state.rescueActionId) : null
      if (rescue && (rescue.tx.state === "CONFIRMED" || rescue.tx.state === "REVERTED") && rescue.goal.state === "NOT_EVALUATED") await recomputeRescue(rescue)
      const after = state.rescueActionId ? journal.get(state.rescueActionId) : null
      if (!after || after.goal.state === "NOT_EVALUATED") state.abort ??= "the run was interrupted before its reduction settled; resumed into cleanup"
    } else {
      await mainFlow()
    }
  } catch (e) {
    if (e instanceof UnresolvedTransactionError) {
      status = "UNRESOLVED_TX"
      reason = e.message
    } else if (e instanceof NotDemonstrated) {
      state.notDemonstrated = e.message
    } else {
      state.abort = (e as Error).message.split("\n")[0]
    }
    saveState()
    log({ step: "main flow stopped", reason: state.notDemonstrated ?? state.abort ?? reason })
  }
  // A confirmation the run did not send must never be sent later (by the CLI, say).
  for (const r of journal.list()) {
    if (r.tx.state === "NOT_SENT") journal.update(r.actionId, "invalidated", (x) => (x.tx.state = "INVALIDATED"), `not sent: ${state.notDemonstrated ?? state.abort ?? reason ?? "the run ended"}`.slice(0, 200))
  }

  // Cleanup is only for a run that has sent something: the persisted ledger says so. A
  // run that stopped before its first signature (a refused preflight, a read failure, a
  // simulation that would revert) leaves the account exactly as it found it, including
  // any collateral or allowance that made the preflight refuse; so does a run whose only
  // signed transactions were never handed to the node.
  const broadcastSteps = () => ledger.data.steps.filter((s) => !s.history.some((h) => h.event === NOT_BROADCAST))
  if (status === null && broadcastSteps().length === 0) {
    const signed = sender.tracker.signatures > 0 || ledger.data.steps.length > 0
    status = signed ? "SIGNED_NOT_SENT" : "REFUSED"
    reason = state.abort ?? state.notDemonstrated ?? "nothing was sent"
    log({ step: signed ? "signed, not sent" : "refused", reason, note: signed ? "a transaction was signed but none reached the node; no cleanup" : "nothing was signed or broadcast; no cleanup" })
  }

  if (status === null) {
    try {
      cleanup = await guardedCleanup({
        planDigest: opts.planDigest,
        client,
        sender,
        journal,
        owner,
        guard: state.guard,
        deployment,
        pools: [BTC_POOL, ETH_POOL],
        slippageBps: s,
        closeDeadlineSeconds: timing.closeDeadlineSeconds,
        listStops: opts.listStops,
        beforeClose: (pool, attempt) => hook("beforeCleanupClose", { pool, attempt }),
        log,
      })
      writeFileAtomic(join(out, "cleanup.json"), prettyJson(cleanup))
    } catch (e) {
      if (e instanceof UnresolvedTransactionError) {
        status = "UNRESOLVED_TX"
        reason = e.message
      } else {
        status = "CLEANUP_INCOMPLETE"
        reason = `cleanup stopped: ${(e as Error).message.split("\n")[0]}`
      }
    }
  }

  const rescue = state.rescueActionId ? journal.get(state.rescueActionId) : null
  if (!status) {
    if (!cleanup?.verified) {
      status = "CLEANUP_INCOMPLETE"
      reason = [...(cleanup?.remaining ?? []), ...(cleanup?.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) ?? [])].join("; ")
    } else if (state.abort || ledger.data.foreignActivity.length) {
      status = "ABORTED"
      reason = state.abort ?? ledger.data.foreignActivity.map((f) => f.detail).join("; ")
    } else if (state.notDemonstrated || rescue?.goal.state !== "GOAL_MET") {
      status = "NOT_DEMONSTRATED"
      reason = state.notDemonstrated ?? `rescue goal ${rescue?.goal.state ?? "not evaluated"}: ${rescue?.goal.reason ?? ""}`
    } else {
      status = "COMPLETE"
    }
  }
  const result: RunResult = {
    version: RUN_VERSION,
    status,
    exitCode: EXIT[status],
    reason,
    guard: state.guard,
    rescue: rescue ? { actionId: rescue.actionId, tx: rescue.tx.hash ?? null, txState: rescue.tx.state, fill: rescue.fill.state, goal: rescue.goal.state, goalReason: rescue.goal.reason ?? "" } : null,
    invalidated: state.invalidated,
    cleanup,
    foreignActivity: ledger.data.foreignActivity,
    gas: { cap: plan.bounds.gas.sttCap, spent: ledger.spent(), committed: ledger.committed() },
    sentTransactions: broadcastSteps().length,
    logComplete: logFailures === 0,
  }
  try {
    writeFileAtomic(join(out, "result.json"), prettyJson(result))
  } catch (e) {
    throw new ResultNotPersistedError(result, e)
  }
  try {
    appendFileSync(join(out, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), resumed: !!opts.resume, ...result }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n")
  } catch {
    logFailures++
  }
  log({ step: "result", status, exitCode: result.exitCode, reason })
  return result

  async function mainFlow() {
    // 0. Preflight: an empty account, the balances the plan needs, unchanged markets.
    const pre0 = await snapshot()
    writeFileAtomic(join(out, "preflight.json"), prettyJson(pre0))
    const problems = [...pre0.problems]
    if (pre0.positions.length || pre0.orders.length || pre0.collateral.unlocked !== 0n || pre0.collateral.locked !== 0n) problems.push("the bank account is not empty")
    if (pre0.stops.rows.some((r) => r.liveAtBlock)) problems.push("the account has live TP/SL stops")
    if (pre0.wallet.usdso < plan.bounds.maxDepositUsdso) problems.push("USDso is below the deposit")
    if (pre0.wallet.allowanceToBank !== 0n) problems.push(`an allowance of ${pre0.wallet.allowanceToBank} to the bank already exists`)
    const stt = await client.getBalance({ address: owner, blockNumber: pre0.block.number })
    if (stt < plan.bounds.gas.sttCap) problems.push("STT is below the gas cap")
    // A plan is for the account as it was read: any transaction since (an earlier run's
    // included) changes the nonce, and a fresh run then needs a fresh plan.
    const [latestNonce, pendingNonce] = await Promise.all([client.getTransactionCount({ address: owner, blockTag: "latest" }), client.getTransactionCount({ address: owner, blockTag: "pending" })])
    if (latestNonce !== Number(plan.account.nonce) || pendingNonce !== latestNonce) problems.push(`the account's nonce is ${latestNonce} (pending ${pendingNonce}), not the plan's ${plan.account.nonce}: regenerate the plan`)
    for (const m of plan.markets) {
      const info = pre0.pools.find((p) => sameAddress(p.pool, m.pool))
      if (!info?.priceable) problems.push(`${m.symbol} has no fresh mark`)
      else if (info.grid.tickSize !== m.tick || info.grid.lotSize !== m.lot || info.grid.minQuantity !== m.min || info.params.takerFeeBpsTimes1k !== m.takerFee || info.maintenanceMarginBps !== m.mmBps) problems.push(`${m.symbol} market parameters differ from the plan`)
    }
    if (problems.length) throw new Abort(`preflight: ${problems.join("; ")}`)
    log({ step: "preflight", block: pre0.block.number, stt, usdso: pre0.wallet.usdso })

    // 1. Guard first, verified before it can be granted anything.
    const nonce = await client.getTransactionCount({ address: owner, blockTag: "latest" })
    const predicted = getContractAddress({ from: owner, nonce: BigInt(nonce) })
    const deployed = await sender.send({ id: "deploy-guard", phase: "main", purpose: "deploy ReduceOnlyGuard(owner, bank, [BTC, ETH])", to: null, data: deployment.deployData, cleanupTx: after({}) })
    const guard = deployed.receipt?.contractAddress ?? null
    if (!guard || !sameAddress(guard, predicted)) throw new Abort(`guard deployed at ${guard}, expected ${predicted}`)
    state.guard = guard
    saveState()
    const guardProblems = await verifyDeployedGuard(client, guard, deployment)
    writeFileAtomic(join(out, "guard.json"), prettyJson({ guard, deployTx: deployed.hash, deployment: { ...deployment, deployData: undefined }, verified: guardProblems.length === 0, problems: guardProblems }))
    if (guardProblems.length) throw new Abort(`deployed guard failed verification: ${guardProblems.join("; ")}`)
    log({ step: "guard verified", guard, runtimeKeccak: deployment.expectedRuntimeKeccak })
    await hook("afterDeploy")

    // 2-3. Exact allowance, deposit.
    const deposit = plan.bounds.maxDepositUsdso
    await sender.send({ id: "approve", phase: "main", purpose: `exact allowance of ${deposit} to the bank`, to: USDSO, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, deposit] }), cleanupTx: after({}) })
    if ((await client.readContract({ address: USDSO, abi: erc20Abi, functionName: "allowance", args: [owner, MARGIN_BANK] })) !== deposit) throw new Abort("allowance is not the approved amount")
    await sender.send({ id: "deposit", phase: "main", purpose: `deposit ${deposit}`, to: MARGIN_BANK, data: encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [deposit] }), cleanupTx: after({ collateral: true }) })
    footprint.collateral = true
    const afterDeposit = await snapshot()
    if (afterDeposit.collateral.unlocked !== deposit || afterDeposit.wallet.allowanceToBank !== 0n) throw new Abort("the deposit did not land as planned")

    // 4-5. The two legs, within the approved quantities and slippage.
    for (const leg of [
      { id: "open-BTC-long", pool: BTC_POOL, isBid: true, qty: plan.bounds.openingQuantities.btc, notional: plan.bounds.openingNotionalUsdso.btcLong },
      { id: "open-ETH-short", pool: ETH_POOL, isBid: false, qty: plan.bounds.openingQuantities.eth, notional: plan.bounds.openingNotionalUsdso.ethShort },
    ]) {
      const m = plan.markets.find((x) => sameAddress(x.pool, leg.pool))!
      const touch = (await client.readContract({ address: leg.pool, abi: perpPoolAbi, functionName: "getBookLevels", args: [!leg.isBid, 1n] }))[0]
      if (!touch) throw new Abort(`${m.symbol}: empty book`)
      if ((leg.qty * touch.price) / m.oneBase > (leg.notional * 11n) / 10n) throw new Abort(`${m.symbol} moved more than 10% since the plan`)
      const limit = protectiveLimit(touch.price, leg.isBid, s, m.tick)
      const block = await client.getBlock()
      await sender.send({
        id: leg.id,
        phase: "main",
        purpose: `open ${m.symbol} ${leg.isBid ? "long" : "short"} ${leg.qty} with IOC limit ${limit}`,
        to: leg.pool,
        data: encodeFunctionData({ abi: perpPoolAbi, functionName: "placeOrder", args: [leg.isBid, 0n, limit, leg.qty, (block.timestamp + 60n) * 1_000_000_000n, ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, "0x0000000000000000000000000000000000000000", 0n] }),
        cleanupTx: after({ leg: leg.pool }),
      })
      footprint.legs.push(leg.pool)
      const size = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [owner, leg.pool] })).size
      if (leg.isBid ? size <= 0n || size > leg.qty : size >= 0n || -size > leg.qty) throw new Abort(`${m.symbol} position ${size} is not the planned side and size`)
      await softStop(`after ${leg.id}`)
    }
    await hook("afterOpen")

    // 6. Analysis under the plan's scenario; journal the confirmation (NOT_SENT).
    const ref = await snapshot()
    const recon = reconcile(ref)
    const scenario = buildScenario(ref, recon, { shocksBps: plan.scenario.shocksBps, targetBuffer: plan.scenario.targetBufferUsdso })
    const analysis = analyzeCandidates(scenario, ref, recon, { slippageBps: s })
    writeFileAtomic(join(out, "analysis-snapshot.json"), prettyJson(ref))
    writeFileAtomic(join(out, "scenario.json"), prettyJson(scenario))
    writeFileAtomic(join(out, "candidates.json"), prettyJson(analysis))
    writeFileAtomic(join(out, "analysis.txt"), renderAnalysis(ref, scenario, analysis))
    log({ step: "analysis", block: ref.block.number, reconciliation: recon.verdict, outcome: analysis.outcome, selected: analysis.selected })
    if (analysis.outcome !== "CANDIDATE_SELECTED") throw new NotDemonstrated(`analysis outcome ${analysis.outcome}: no guarded reduction to send`)
    let current = { analysis, snapshot: ref, record: confirm(analysis, ref, scenario) }
    await hook("afterAnalysis", { record: current.record })

    // 7-8. Grant that pool only, then refresh; a changed account invalidates the
    // confirmation, and one new confirmation may be made under the same scenario.
    let forRecompute: CandidateAnalysis | null = null
    let refreshSnapshot: AccountSnapshot | null = null
    for (let attempt = 1; ; attempt++) {
      const pool = current.record.request.pool
      await grant(pool, `grant-${poolOf(current.snapshot, pool).symbol}${attempt > 1 ? `-${attempt}` : ""}`)
      await hook("beforeRefresh", { attempt, record: current.record })
      const fresh = await snapshot()
      const r = refreshConfirmation({ scenario, confirmation: current.record, analysisSnapshot: current.snapshot, original: current.analysis, fresh, freshRecon: reconcile(fresh), slippageBps: s, minSecondsLeft: timing.minSecondsLeft })
      writeFileAtomic(join(out, `refresh-${attempt}.json`), prettyJson({ verdict: r.verdict, reasons: r.reasons, stateChanges: r.stateChanges, block: r.block, fundingDrift: r.fundingDrift, refreshed: r.refreshed, reanalysis: { outcome: r.reanalysis.outcome, selected: r.reanalysis.selected, blockers: r.reanalysis.blockers } }))
      journal.update(current.record.actionId, r.verdict === "STILL_VALID" ? "refreshed" : "invalidated", (x) => {
        x.refreshes = [
          ...(x.refreshes ?? []),
          {
            at: new Date().toISOString(),
            blockNumber: r.block.number.toString(),
            blockHash: r.block.hash as Hex,
            verdict: r.verdict,
            reasons: r.reasons,
            fundingDrift: r.fundingDrift.toString(),
            forecast: r.refreshed?.reduce && r.refreshed.scenario ? { expectedFill: r.refreshed.reduce.expectedFill.toString(), scenarioBuffer: r.refreshed.scenario.buffer.toString(), goal: r.refreshed.goal! } : null,
          },
        ]
        if (r.verdict === "INVALIDATED") x.tx.state = "INVALIDATED"
      }, r.reasons.join("; ") || `funding drift ${r.fundingDrift}`)
      log({ step: "refresh", attempt, verdict: r.verdict, reasons: r.reasons, fundingDrift: r.fundingDrift })
      if (r.verdict === "STILL_VALID") {
        forRecompute = r.analysisForRecompute
        refreshSnapshot = fresh
        break
      }
      state.invalidated.push({ actionId: current.record.actionId, reasons: r.reasons })
      saveState()
      if (attempt >= 2) throw new NotDemonstrated(`the confirmation was invalidated twice (${r.reasons.join("; ")}); nothing was sent`)
      if (r.reanalysis.outcome !== "CANDIDATE_SELECTED") throw new NotDemonstrated(`after the account changed, the re-analysis gives ${r.reanalysis.outcome}; nothing was sent`)
      current = { analysis: r.reanalysis, snapshot: fresh, record: confirm(r.reanalysis, fresh, scenario) }
    }
    writeFileAtomic(join(out, "preflight-snapshot.json"), prettyJson(refreshSnapshot))
    writeFileAtomic(join(out, "refresh-analysis.json"), prettyJson(forRecompute))

    // 9. Send through the guard.
    const record = current.record
    await hook("beforeReduceSend", { record })
    const head = await client.getBlock()
    if (head.timestamp + BigInt(timing.minSecondsLeft) / 2n > BigInt(record.request.deadline)) {
      journal.update(record.actionId, "invalidated", (x) => (x.tx.state = "INVALIDATED"), "deadline too close to send")
      throw new NotDemonstrated("the confirmation expired before it could be sent")
    }
    try {
      const step = await sender.send({
        id: "reduce",
        phase: "main",
        purpose: `guarded reduction ${record.candidateId} (${record.actionId})`,
        to: state.guard!,
        data: record.calldata,
        actionId: record.actionId,
        cleanupTx: after({}),
        beforeBroadcast: (st) => journal.update(record.actionId, "pending", (x) => (x.tx = { state: "PENDING", from: owner, nonce: st.nonce, hash: st.hash, sentAt: new Date().toISOString(), sentAfterBlock: st.sentAfterBlock.toString() })),
      })
      mirrorStep(journal, record.actionId, step)
    } catch (e) {
      if (journal.get(record.actionId).tx.state === "NOT_SENT") {
        // Nothing left the process.
        journal.update(record.actionId, "not sent", (x) => (x.tx.state = "INVALIDATED"), (e as Error).message.slice(0, 200))
        if (e instanceof StepWouldRevertError) throw new NotDemonstrated(e.message)
        throw e instanceof GasBudgetError ? new Abort(e.message) : e
      }
      if (e instanceof UnresolvedTransactionError) {
        mirrorStep(journal, record.actionId, e.step)
        throw e
      }
      if (e instanceof StepRejectedError) {
        mirrorStep(journal, record.actionId, e.step)
        throw new NotDemonstrated(e.message)
      }
      if (!(e instanceof StepRevertedError)) throw e
      mirrorStep(journal, record.actionId, e.step)
    }
    const settled = journal.get(record.actionId)
    log({ step: "reduce", actionId: record.actionId, tx: settled.tx.hash, state: settled.tx.state })

    // 10. Bind the receipt to the confirmation and recompute (a revert is evidence too).
    await recomputeRescue(settled)
    if (settled.tx.state !== "CONFIRMED") throw new NotDemonstrated(`the guarded reduction ${settled.tx.state}`)
    await hook("afterReduce")
    await softStop("after the reduction")
  }

  function confirm(analysis: CandidateAnalysis, at: AccountSnapshot, scenario: Scenario): ActionRecord {
    const candidateId = analysis.selected!
    const { request, candidate } = requestFromCandidate(analysis, candidateId, at, { deadlineSeconds: timing.deadlineSeconds, nowSeconds: at.block.timestamp, nonce: rescueNonce(opts.planDigest, scenario.id, at.block.hash) })
    const binding = { chainId: 50383, guard: state.guard!, marginBank: MARGIN_BANK, owner }
    const actionId = actionIdOf(binding, request)
    const record = journal.create({
      actionId,
      kind: "RESCUE",
      createdAt: new Date().toISOString(),
      binding,
      scenarioId: scenario.id,
      candidateId,
      request: { pool: request.pool, expectedSignedSize: request.expectedSignedSize.toString(), isBid: request.isBid, quantity: request.quantity.toString(), limitPrice: request.limitPrice.toString(), deadline: request.deadline.toString(), nonce: request.nonce },
      calldata: reduceCalldata(request),
      forecast: { expectedFill: candidate.reduce!.expectedFill.toString(), scenarioBuffer: candidate.scenario!.buffer.toString(), goal: candidate.goal! },
      quote: { blockNumber: at.block.number.toString(), blockHash: at.block.hash, validUntil: request.deadline.toString() },
    })
    state.rescueActionId = actionId
    saveState()
    log({ step: "confirmation journalled", actionId, candidateId, expectedSignedSize: request.expectedSignedSize, quantity: request.quantity, limit: request.limitPrice, deadline: request.deadline })
    return record
  }

  async function recomputeRescue(record: ActionRecord): Promise<RecomputeResult> {
    const scenario = readJson<Scenario>(join(out, "scenario.json"))
    const analysis = readBigJson<CandidateAnalysis>(join(out, "refresh-analysis.json"))
    const pre = readBigJson<AccountSnapshot>(join(out, "preflight-snapshot.json"))
    const pool = record.request.pool
    const receipt = await readActionReceipt(client, record.tx.hash!, { guard: record.binding.guard, pool, owner, marginBank: MARGIN_BANK, isBid: record.request.isBid, limitPrice: BigInt(record.request.limitPrice), requested: BigInt(record.request.quantity) })
    const post = await snapshot([BTC_POOL, ETH_POOL], receipt.blockNumber)
    const external = (await bankLogsForOwner(client, MARGIN_BANK, owner, pre.block.number + 1n, receipt.blockNumber)).filter((l) => l.txHash !== receipt.txHash)
    const result = recompute({ confirmation: record, scenario, analysis, pre, post, receipt, externalLogs: external })
    journal.update(record.actionId, "recomputed", (r) => {
      r.fill = { state: result.fill.state, requested: result.fill.requested.toString(), filled: result.fill.filled.toString() }
      r.goal = { state: result.goal.state, reason: result.goal.reason }
    })
    writeFileAtomic(join(out, "receipt.json"), prettyJson(receipt))
    writeFileAtomic(join(out, "post-snapshot.json"), prettyJson(post))
    writeFileAtomic(join(out, "recompute.json"), prettyJson(result))
    writeFileAtomic(join(out, "recompute.txt"), renderRecompute(result, poolOf(pre, pool).baseDecimals))
    log({ step: "recompute", binding: result.binding.ok, fill: result.fill.state, goal: result.goal.state })
    return result
  }
}
