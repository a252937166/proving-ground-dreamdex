// End-to-end run on a LOCAL FORK of Hideki (anvil): analyse a real account, deploy the
// guard for it, grant the guard placeOrderFor, send the selected reduction through the
// journal, read the receipt, recompute the same scenario, then show that a replayed
// confirmation and an expired quote cannot execute.
//
// Everything here happens on the fork. The real account is IMPERSONATED by anvil (no
// key is involved) and is given fork-only gas money; nothing is broadcast to Hideki.
// Evidence written by this script is labelled "fork" and must never be presented as a
// live transaction.
//
//   npm run rpc-shim &            # anvil needs it too (see tools/rpc-shim.mjs)
//   (cd contracts && forge build)
//   npm run mr:fork-e2e -- [--block 33472615] [--account 0x…] [--out DIR]
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { BaseError, decodeErrorResult, encodeDeployData, encodeFunctionData, keccak256, type Abi, type Address, type Hex, type PublicClient } from "viem"
import { contractErrorsAbi, operatorRegistryAbi, PLACE_ORDER_FOR_SELECTOR, reduceGuardAbi } from "./abi.js"
import { actionIdOf, reduceCalldata, requestFromCandidate, type ReduceRequest } from "./action.js"
import { analyzeCandidates } from "./candidates.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, OPERATOR_REGISTRY, stopLister } from "./common.js"
import { ActionJournal, broadcast, resolveAction } from "./journal.js"
import { prettyJson, writeFileAtomic } from "./json.js"
import { anvilVersion, checksums, startAnvil, stopAnvil, waitReceipt } from "./forkTools.js"
import { reconcile } from "./reconcile.js"
import { bankLogsForOwner, recompute } from "./recompute.js"
import { readActionReceipt } from "./receipt.js"
import { refreshConfirmation } from "./refresh.js"
import { renderAnalysis, renderReconciliation, renderRecompute } from "./report.js"
import { createHidekiClient, sampleBlock } from "./rpc.js"
import { buildScenario } from "./scenario.js"
import { poolOf, readAccountSnapshot, type AccountSnapshot } from "./snapshot.js"

const ARTIFACT = new URL("../../contracts/out/ReduceOnlyGuard.sol/ReduceOnlyGuard.json", import.meta.url)

async function main() {
  const { values } = parseArgs({
    options: {
      block: { type: "string", default: "33472615" },
      account: { type: "string", default: "0x2E3631D9c6497103BE981Fe3a48B11ba06fDB745" },
      port: { type: "string", default: "8547" },
      upstream: { type: "string", default: "http://127.0.0.1:8546" },
      out: { type: "string" },
      target: { type: "string", default: "0" },
    },
  })
  const forkBlock = BigInt(values.block!)
  const account = values.account as Address
  const out = values.out ?? join("evidence", "margin-rescue", `fork-${forkBlock}`)
  const rpc = `http://127.0.0.1:${values.port}`
  const log: string[] = []
  const note = (s: string) => {
    log.push(s)
    console.log(s)
  }

  const anvil = await startAnvil(values.upstream!, forkBlock, values.port!)
  try {
    // A fork fetches state from Hideki on first touch, so its calls can be slow.
    const client = createHidekiClient(rpc, { timeoutMs: 600_000 })
    const anvilCall = (method: string, params: unknown[]) => client.request({ method, params } as never)
    const forkHeader = await sampleBlock(client, forkBlock)
    const T = forkHeader.timestamp
    // Hold the fork clock at the fork block's own timestamp: marks older than 5 s are
    // refused by the venue, so letting time run would fake failures.
    const holdClock = () => anvilCall("evm_setNextBlockTimestamp", [`0x${T.toString(16)}`])
    await holdClock()
    await anvilCall("evm_mine", [])
    note(`fork of Hideki at block ${forkBlock} (${forkHeader.hash}), clock held at ${T}`)

    // 1. Read, reconcile, analyse.
    const listStops = stopLister()
    const ref = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account, bookPools: [BTC_POOL, ETH_POOL], listStops })
    const recon = reconcile(ref)
    note(`reference snapshot at fork block ${ref.block.number}: ${ref.positions.length} positions, reconciliation ${recon.verdict}`)
    if (recon.verdict !== "EXACT") throw new Error(`reconciliation ${recon.verdict}: ${recon.reasons.join("; ")}`)
    const scenario = buildScenario(ref, recon, { shocksBps: { BTC: -800, ETH: -1200 }, targetBuffer: BigInt(values.target!) * 10n ** 18n })
    const analysis = analyzeCandidates(scenario, ref, recon, {})
    note(`scenario ${scenario.id.slice(0, 16)}: baseline buffer ${analysis.baseline.scenario.buffer}, outcome ${analysis.outcome} ${analysis.selected ?? ""}`)
    writeFileAtomic(join(out, "reference-snapshot.json"), prettyJson(ref))
    writeFileAtomic(join(out, "reconciliation.txt"), renderReconciliation(ref, recon))
    writeFileAtomic(join(out, "scenario.json"), prettyJson(scenario))
    writeFileAtomic(join(out, "candidates.json"), prettyJson(analysis))
    writeFileAtomic(join(out, "analysis.txt"), renderAnalysis(ref, scenario, analysis))
    if (analysis.outcome !== "CANDIDATE_SELECTED" || !analysis.selected) throw new Error(`nothing to execute: ${analysis.outcome}`)
    const candidate = analysis.candidates.find((c) => c.id === analysis.selected)!
    const pool = candidate.reduce!.pool as Address

    // 2. Deploy the guard for the account and grant it placeOrderFor on that pool only.
    await anvilCall("anvil_impersonateAccount", [account])
    await anvilCall("anvil_setBalance", [account, "0x8ac7230489e80000"]) // 10 STT, fork only
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex } }
    const deployData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [account, MARGIN_BANK, [BTC_POOL, ETH_POOL]] })
    const deployReceipt = await send(client, holdClock, { from: account, data: deployData })
    const guard = deployReceipt.contractAddress as Address
    const runtime = (await client.getCode({ address: guard })) as Hex
    note(`guard deployed at ${guard} (runtime ${(runtime.length - 2) / 2} bytes, keccak ${keccak256(runtime)})`)
    await send(client, holdClock, {
      from: account,
      to: OPERATOR_REGISTRY,
      data: encodeFunctionData({ abi: operatorRegistryAbi, functionName: "setOperatorApprovalForPool", args: [pool, guard, [PLACE_ORDER_FOR_SELECTOR], true] }),
    })
    note(`owner granted the guard placeOrderFor on ${poolOf(ref, pool).symbol} only`)

    // 3. Pre-flight snapshot, action id (checked against the contract), journal, send.
    const journal = new ActionJournal(join(out, "journal"))
    const { request } = requestFromCandidate(analysis, candidate.id, ref, { deadlineSeconds: 120, nowSeconds: ref.block.timestamp })
    const binding = { chainId: 50383, guard, marginBank: MARGIN_BANK, owner: account }
    const actionId = actionIdOf(binding, request)
    const onchainId = (await client.readContract({ address: guard, abi: reduceGuardAbi, functionName: "actionIdOf", args: [request] })) as Hex
    if (onchainId !== actionId) throw new Error(`action id mismatch: client ${actionId}, guard ${onchainId}`)
    note(`action ${actionId} (client id equals guard.actionIdOf)`)
    createRecord(journal, binding, actionId, request, scenario.id, candidate, ref)
    // Refresh: the whole account again, the same scenario, the confirmed request now.
    const pre = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account, bookPools: [BTC_POOL, ETH_POOL], listStops })
    const check = refreshConfirmation({ scenario, confirmation: journal.get(actionId), analysisSnapshot: ref, original: analysis, fresh: pre, freshRecon: reconcile(pre), slippageBps: 50n, minSecondsLeft: 30 })
    note(`refresh at block ${pre.block.number}: ${check.verdict}${check.reasons.length ? ` (${check.reasons.join("; ")})` : ""}; funding drift ${check.fundingDrift}`)
    if (check.verdict !== "STILL_VALID") throw new Error("the confirmation did not survive the refresh")
    writeFileAtomic(join(out, "preflight-snapshot.json"), prettyJson(pre))
    writeFileAtomic(join(out, "refresh-analysis.json"), prettyJson(check.analysisForRecompute))
    const nonce = await client.getTransactionCount({ address: account })
    await holdClock()
    const sent = await broadcast(
      journal,
      actionId,
      { kind: "node", from: account, nonce, submit: () => client.request({ method: "eth_sendTransaction", params: [{ from: account, to: guard, data: reduceCalldata(request), gas: "0x1c9c380" }] } as never) as Promise<Hex> },
      client,
      pre.block.timestamp,
    )
    note(`sent ${sent.tx.hash}; journal ${sent.tx.state}`)
    await waitReceipt(client, sent.tx.hash!)
    const settled = await resolveAction(journal, actionId, client)
    note(`receipt read; journal ${settled.tx.state}`)

    // 4. Receipt, post snapshot, external rows, recompute.
    const receipt = await readActionReceipt(client, settled.tx.hash!, { guard, pool, owner: account, marginBank: MARGIN_BANK, isBid: request.isBid, limitPrice: request.limitPrice, requested: request.quantity })
    const post = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account, blockNumber: receipt.blockNumber, bookPools: [BTC_POOL, ETH_POOL], listStops })
    const external = (await bankLogsForOwner(client, MARGIN_BANK, account, pre.block.number + 1n, receipt.blockNumber)).filter((l) => l.txHash !== receipt.txHash)
    const result = recompute({ confirmation: journal.get(actionId), scenario, analysis: check.analysisForRecompute, pre, post, receipt, externalLogs: external })
    if (!result.binding.ok) throw new Error(`receipt binding failed: ${result.binding.failures.join("; ")}`)
    journal.update(actionId, "recomputed", (r) => {
      r.fill = { state: result.fill.state, requested: result.fill.requested.toString(), filled: result.fill.filled.toString() }
      r.goal = { state: result.goal.state, reason: result.goal.reason }
    })
    const text = renderRecompute(result, poolOf(pre, pool).baseDecimals)
    console.log(text)
    writeFileAtomic(join(out, "receipt.json"), prettyJson(receipt))
    writeFileAtomic(join(out, "post-snapshot.json"), prettyJson(post))
    writeFileAtomic(join(out, "recompute.json"), prettyJson(result))
    writeFileAtomic(join(out, "recompute.txt"), text)

    // 5. A second confirmation of the same analysis (fresh nonce, same stale expected
    //    position) must revert in the guard and change nothing.
    const { request: stale } = requestFromCandidate(analysis, candidate.id, ref, { deadlineSeconds: 120, nowSeconds: pre.block.timestamp })
    const staleId = actionIdOf(binding, stale)
    createRecord(journal, binding, staleId, stale, scenario.id, candidate, post)
    const before = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account, bookPools: [pool], listStops })
    await holdClock()
    const staleSent = await broadcast(
      journal,
      staleId,
      {
        kind: "node",
        from: account,
        nonce: await client.getTransactionCount({ address: account }),
        submit: () => client.request({ method: "eth_sendTransaction", params: [{ from: account, to: guard, data: reduceCalldata(stale), gas: "0x1c9c380" }] } as never) as Promise<Hex>,
      },
      client,
      before.block.timestamp,
    )
    await waitReceipt(client, staleSent.tx.hash!)
    const staleRecord = await resolveAction(journal, staleId, client)
    const reason = await revertReason(client, { from: account, to: guard, data: reduceCalldata(stale) }, BigInt(staleRecord.tx.blockNumber!) - 1n)
    const after = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account, bookPools: [pool], listStops })
    const unchanged = JSON.stringify(after.positions, big) === JSON.stringify(before.positions, big) && after.collateral.unlocked === before.collateral.unlocked
    journal.update(staleId, "evaluated", (r) => {
      r.fill = { state: "NO_FILL", requested: stale.quantity.toString(), filled: "0" }
      r.goal = { state: "GOAL_NOT_MET", reason: `reverted (${reason}); account unchanged: ${unchanged}` }
    })
    note(`stale confirmation ${staleId}: ${staleRecord.tx.state}, ${reason}; account unchanged: ${unchanged}`)

    // 6. An expired quote is invalidated before anything is sent.
    const { request: late } = requestFromCandidate(analysis, candidate.id, ref, { deadlineSeconds: 1, nowSeconds: after.block.timestamp - 10n })
    const lateId = actionIdOf(binding, late)
    createRecord(journal, binding, lateId, late, scenario.id, candidate, after)
    try {
      await broadcast(journal, lateId, { kind: "node", from: account, nonce: 0, submit: async () => "0x" }, client, after.block.timestamp)
    } catch (e) {
      note(`expired quote: ${(e as Error).message}; journal ${journal.get(lateId).tx.state}`)
    }

    writeFileAtomic(
      join(out, "run.json"),
      prettyJson({
        label: "fork",
        warning: "Local anvil fork of Hideki. The account was impersonated; nothing here was broadcast to the live network.",
        forkBlock,
        forkBlockHash: forkHeader.hash,
        clockHeldAt: T,
        account,
        guard,
        guardRuntimeKeccak: keccak256(runtime),
        guardRuntimeBytes: (runtime.length - 2) / 2,
        scenarioId: scenario.id,
        selected: candidate.id,
        actionId,
        tx: receipt.txHash,
        goal: result.goal,
        staleConfirmation: { actionId: staleId, tx: staleRecord.tx.hash, state: staleRecord.tx.state, revert: reason, accountUnchanged: unchanged },
        expiredQuote: { actionId: lateId, state: journal.get(lateId).tx.state },
        anvil: anvilVersion(),
        log,
      }),
    )
    writeFileAtomic(join(out, "SHA256SUMS"), checksums(out))
    note(`evidence written to ${out}`)
  } finally {
    await stopAnvil(anvil)
  }
}

function big(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v
}

function createRecord(journal: ActionJournal, binding: { chainId: number; guard: Address; marginBank: Address; owner: Address }, actionId: Hex, r: ReduceRequest, scenarioId: string, candidate: ReturnType<typeof analyzeCandidates>["candidates"][number], at: AccountSnapshot) {
  journal.create({
    actionId,
    createdAt: new Date().toISOString(),
    binding,
    scenarioId,
    candidateId: candidate.id,
    request: { pool: r.pool, expectedSignedSize: r.expectedSignedSize.toString(), isBid: r.isBid, quantity: r.quantity.toString(), limitPrice: r.limitPrice.toString(), deadline: r.deadline.toString(), nonce: r.nonce },
    calldata: reduceCalldata(r),
    forecast: { expectedFill: candidate.reduce!.expectedFill.toString(), scenarioBuffer: candidate.scenario!.buffer.toString(), goal: candidate.goal! },
    quote: { blockNumber: at.block.number.toString(), blockHash: at.block.hash, validUntil: r.deadline.toString() },
  })
}

async function send(client: PublicClient, holdClock: () => Promise<unknown>, tx: { from: Address; to?: Address; data: Hex }) {
  await holdClock()
  const hash = (await client.request({ method: "eth_sendTransaction", params: [{ ...tx, gas: "0x1c9c380" }] } as never)) as Hex
  const receipt = await waitReceipt(client, hash)
  if (receipt.status !== "success") throw new Error(`fork transaction ${hash} reverted`)
  return receipt
}

async function revertReason(client: PublicClient, tx: { from: Address; to: Address; data: Hex }, blockNumber: bigint): Promise<string> {
  try {
    await client.call({ account: tx.from, to: tx.to, data: tx.data, blockNumber })
    return "no revert on replay"
  } catch (e) {
    let data: Hex | undefined
    if (e instanceof BaseError) {
      const withData = e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null
      data = withData?.data
    }
    if (!data) return (e as Error).message.split("\n")[0]
    try {
      const d = decodeErrorResult({ abi: [...reduceGuardAbi, ...contractErrorsAbi] as unknown as Abi, data })
      return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`
    } catch {
      return data
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
