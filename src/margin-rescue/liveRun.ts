// The live execution of ONE approved plan. It refuses to run unless --approve is the
// SHA-256 of the exact plan file, the key in MR_SIGNER_KEY belongs to the plan's
// account, and the chain is 50383. It never prints or writes the key, and it never
// sends anything the plan does not list: every transaction's hash is computed from the
// signed bytes and logged BEFORE the bytes are broadcast, gas is capped by the plan,
// and a loss stop or any failure jumps to cleanup (revoke, close, withdraw, approve 0).
//
//   MR_SIGNER_KEY=0x… npm run mr:live -- --plan live-plan.json --approve <sha256> [--rpc URL] [--out DIR]
//
// It has been exercised only on a local fork (see forkRehearsal.ts). On the live network
// it must not be run without the owner's explicit approval of that exact plan file.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { createWalletClient, encodeDeployData, encodeFunctionData, http, keccak256, type Abi, type Address, type Hex, type PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { defineChain } from "viem"
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains"
import { erc20Abi, marginBankAbi, marginBankWriteAbi, operatorRegistryAbi, perpPoolAbi, PLACE_ORDER_FOR_SELECTOR, ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER } from "./abi.js"
import { actionIdOf, reduceCalldata, requestFromCandidate } from "./action.js"
import { alignDown, alignUp } from "./book.js"
import { analyzeCandidates } from "./candidates.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, OPERATOR_REGISTRY, USDSO, stopLister } from "./common.js"
import { ActionJournal, broadcast, resolveAction } from "./journal.js"
import { prettyJson, sha256Hex, writeFileAtomic } from "./json.js"
import { reconcile } from "./reconcile.js"
import { bankLogsForOwner, recompute } from "./recompute.js"
import { readActionReceipt } from "./receipt.js"
import { renderAnalysis, renderRecompute } from "./report.js"
import { assertHideki, createHidekiClient } from "./rpc.js"
import { buildScenario } from "./scenario.js"
import { poolOf, readAccountSnapshot, sameAddress } from "./snapshot.js"
import type { LivePlan } from "./livePlan.js"

const ARTIFACT = new URL("../../contracts/out/ReduceOnlyGuard.sol/ReduceOnlyGuard.json", import.meta.url)

class Abort extends Error {}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { plan: { type: "string" }, approve: { type: "string" }, rpc: { type: "string" }, out: { type: "string" } } })
  if (!values.plan || !values.approve) throw new Error("--plan and --approve are required")
  const bytes = readFileSync(values.plan)
  const digest = sha256Hex(bytes)
  if (digest !== values.approve.toLowerCase()) throw new Error(`plan digest ${digest} is not the approved digest; refusing`)
  const plan = JSON.parse(bytes.toString("utf8"), (_k, v) => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v)) as LivePlan
  const key = process.env.MR_SIGNER_KEY as Hex | undefined
  if (!key) throw new Error("MR_SIGNER_KEY is not set")
  const signer = privateKeyToAccount(key)
  if (!sameAddress(signer.address, plan.account.address)) throw new Error("the signing key is not the plan's account")

  const rpc = values.rpc ?? hidekiTestnet.rpcUrls.default.http[0]
  const client = createHidekiClient(rpc, { timeoutMs: 600_000 })
  await assertHideki(client)
  const chain = defineChain({ ...hidekiTestnet, rpcUrls: { default: { http: [rpc] } } })
  const wallet = createWalletClient({ account: signer, chain, transport: http(rpc, { timeout: 600_000 }) })
  const out = values.out ?? join("evidence", "margin-rescue", "live-write", `run-${Date.now()}`)
  const owner = signer.address
  const runLog: unknown[] = []
  const record = (entry: Record<string, unknown>) => {
    runLog.push({ at: new Date().toISOString(), ...entry })
    writeFileAtomic(join(out, "run-log.json"), prettyJson(runLog))
    console.log(JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
  }
  record({ step: "start", planDigest: digest, account: owner, rpc })

  let gasSpent = 0n
  const send = async (step: string, to: Address | undefined, data: Hex): Promise<{ hash: Hex; contractAddress: Address | null }> => {
    const gasPrice = await client.getGasPrice()
    if (gasPrice > plan.network.gasPrice * 3n) throw new Abort(`gas price ${gasPrice} is over 3x the plan's ${plan.network.gasPrice}`)
    const estimate = await client.estimateGas({ account: owner, to, data })
    const gas = (estimate * 13n) / 10n
    if (gasSpent + gas * gasPrice > plan.bounds.gas.sttCap) throw new Abort(`step ${step} would exceed the STT gas cap`)
    const nonce = await client.getTransactionCount({ address: owner, blockTag: "pending" })
    const serialized = await wallet.signTransaction({ to, data, gas, gasPrice, nonce, chain, type: "legacy" } as never)
    const hash = keccak256(serialized)
    record({ step, to: to ?? "contract creation", selector: data.slice(0, 10), nonce, gas, gasPrice, hash, state: "signed, about to broadcast" })
    await client.request({ method: "eth_sendRawTransaction", params: [serialized] })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 600_000 })
    gasSpent += receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice)
    record({ step, hash, status: receipt.status, block: receipt.blockNumber, gasUsed: receipt.gasUsed, gasSpent })
    if (receipt.status !== "success") throw new Abort(`step ${step} reverted (${hash})`)
    return { hash, contractAddress: receipt.contractAddress ?? null }
  }
  const equityTotal = async () => {
    const [h, s] = await Promise.all([
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountHealth", args: [owner] }),
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [owner] }),
    ])
    return h[0] + s.lockedCollateral
  }
  const lossStop = async (where: string) => {
    const e = await equityTotal()
    if (e < plan.bounds.maxDepositUsdso - plan.bounds.maxLossUsdso) throw new Abort(`loss stop at ${where}: E_total ${e}`)
  }
  const book = async (pool: Address, bids: boolean) => (await client.readContract({ address: pool, abi: perpPoolAbi, functionName: "getBookLevels", args: [bids, 1n] }))[0]
  const ioc = (pool: Address, isBid: boolean, qty: bigint, limit: bigint, expiry: bigint) =>
    encodeFunctionData({ abi: perpPoolAbi, functionName: "placeOrder", args: [isBid, 0n, limit, qty, expiry, ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, "0x0000000000000000000000000000000000000000", 0n] })
  const nowNs = async () => (await client.getBlock()).timestamp * 1_000_000_000n + 60_000_000_000n

  let granted: Address | null = null
  let deposited = false
  try {
    // 0. Pre-flight against the plan.
    const [stt, usdso, state] = await Promise.all([
      client.getBalance({ address: owner }),
      client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [owner] }),
    ])
    if (stt < plan.bounds.gas.sttCap) throw new Abort("STT below the gas cap")
    if (usdso < plan.bounds.maxDepositUsdso) throw new Abort("USDso below the deposit")
    if (state.activePerpPools.length || state.lockedCollateral > 0n || state.unlockedCollateralBalance !== 0n) throw new Abort("the bank account is not empty")
    for (const m of plan.markets) {
      const fee = (await client.readContract({ address: m.pool, abi: perpPoolAbi, functionName: "getPerpPoolParameters" })).takerFeeBpsTimes1k
      if (fee !== m.takerFee) throw new Abort(`${m.symbol} taker fee changed`)
    }
    record({ step: "preflight", stt, usdso })

    // 1-2. Exact allowance, deposit.
    await send("approve", USDSO, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, plan.bounds.maxDepositUsdso] }))
    await send("deposit", MARGIN_BANK, encodeFunctionData({ abi: marginBankWriteAbi, functionName: "deposit", args: [plan.bounds.maxDepositUsdso] }))
    deposited = true

    // 3-4. Open the two legs, within the approved notional and slippage.
    const [btc, eth] = plan.markets
    const s = plan.bounds.maxSlippageBpsPerOrder
    const ask = await book(BTC_POOL, false)
    if ((plan.bounds.openingQuantities.btc * ask.price) / btc.oneBase > (plan.bounds.openingNotionalUsdso.btcLong * 11n) / 10n) throw new Abort("BTC moved more than 10% since the plan")
    await send("open BTC long", BTC_POOL, ioc(BTC_POOL, true, plan.bounds.openingQuantities.btc, alignDown((ask.price * (10_000n + s)) / 10_000n, btc.tick), await nowNs()))
    await lossStop("after BTC open")
    const bid = await book(ETH_POOL, true)
    if ((plan.bounds.openingQuantities.eth * bid.price) / eth.oneBase > (plan.bounds.openingNotionalUsdso.ethShort * 11n) / 10n) throw new Abort("ETH moved more than 10% since the plan")
    await send("open ETH short", ETH_POOL, ioc(ETH_POOL, false, plan.bounds.openingQuantities.eth, alignUp((bid.price * (10_000n - s)) / 10_000n, eth.tick), await nowNs()))
    await lossStop("after ETH open")

    // 5. Guard.
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } }
    const deployed = await send("deploy guard", undefined, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner, MARGIN_BANK, [BTC_POOL, ETH_POOL]] }))
    const guard = deployed.contractAddress!
    record({ step: "guard", guard, runtimeKeccak: keccak256((await client.getCode({ address: guard }))!) })

    // 6. Analyse under the approved scenario.
    const listStops = stopLister()
    const ref = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, bookPools: [BTC_POOL, ETH_POOL], listStops })
    const recon = reconcile(ref)
    const scenario = buildScenario(ref, recon, { shocksBps: plan.scenario.shocksBps, targetBuffer: plan.scenario.targetBufferUsdso })
    const analysis = analyzeCandidates(scenario, ref, recon, { slippageBps: s })
    writeFileAtomic(join(out, "snapshot.json"), prettyJson(ref))
    writeFileAtomic(join(out, "scenario.json"), prettyJson(scenario))
    writeFileAtomic(join(out, "candidates.json"), prettyJson(analysis))
    writeFileAtomic(join(out, "analysis.txt"), renderAnalysis(ref, scenario, analysis))
    record({ step: "analysis", reconciliation: recon.verdict, outcome: analysis.outcome, selected: analysis.selected })
    if (analysis.outcome !== "CANDIDATE_SELECTED" || !analysis.selected) throw new Abort(`no reduction to execute: ${analysis.outcome}`)
    const candidate = analysis.candidates.find((c) => c.id === analysis.selected)!
    const pool = candidate.reduce!.pool as Address

    // 7-9. Grant on that pool only, journal, send through the guard.
    await send("grant", OPERATOR_REGISTRY, encodeFunctionData({ abi: operatorRegistryAbi, functionName: "setOperatorApprovalForPool", args: [pool, guard, [PLACE_ORDER_FOR_SELECTOR], true] }))
    granted = pool
    const pre = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, bookPools: [pool], listStops })
    if (pre.positions.find((p) => sameAddress(p.pool, pool))?.size !== ref.positions.find((p) => sameAddress(p.pool, pool))?.size) throw new Abort("position moved before sending")
    const { request } = requestFromCandidate(analysis, candidate.id, ref, { deadlineSeconds: 120, nowSeconds: pre.block.timestamp })
    const binding = { chainId: 50383, guard, marginBank: MARGIN_BANK, owner }
    const actionId = actionIdOf(binding, request)
    const journal = new ActionJournal(join(out, "journal"))
    journal.create({
      actionId,
      createdAt: new Date().toISOString(),
      binding,
      scenarioId: scenario.id,
      candidateId: candidate.id,
      request: { pool: request.pool, expectedSignedSize: request.expectedSignedSize.toString(), isBid: request.isBid, quantity: request.quantity.toString(), limitPrice: request.limitPrice.toString(), deadline: request.deadline.toString(), nonce: request.nonce },
      calldata: reduceCalldata(request),
      forecast: { expectedFill: candidate.reduce!.expectedFill.toString(), scenarioBuffer: candidate.scenario!.buffer.toString(), goal: candidate.goal! },
      quote: { blockNumber: pre.block.number.toString(), blockHash: pre.block.hash, validUntil: request.deadline.toString() },
    })
    writeFileAtomic(join(out, "preflight-snapshot.json"), prettyJson(pre))
    const data = reduceCalldata(request)
    const gasPrice = await client.getGasPrice()
    const gas = ((await client.estimateGas({ account: owner, to: guard, data })) * 13n) / 10n
    if (gasSpent + gas * gasPrice > plan.bounds.gas.sttCap) throw new Abort("the reduction would exceed the STT gas cap")
    const nonce = await client.getTransactionCount({ address: owner, blockTag: "pending" })
    const serialized = await wallet.signTransaction({ to: guard, data, gas, gasPrice, nonce, chain, type: "legacy" } as never)
    await broadcast(journal, actionId, { kind: "raw", serialized, from: owner, nonce }, client, (await client.getBlock()).timestamp)
    const hash = journal.get(actionId).tx.hash!
    await client.waitForTransactionReceipt({ hash, timeout: 600_000 }).catch(() => null)
    const settled = await resolveAction(journal, actionId, client)
    record({ step: "reduce", actionId, hash, state: settled.tx.state })

    // 10. Recompute.
    if (settled.tx.state === "CONFIRMED" || settled.tx.state === "REVERTED") {
      const receipt = await readActionReceipt(client, hash, { guard, pool, owner, marginBank: MARGIN_BANK, isBid: request.isBid, limitPrice: request.limitPrice, requested: request.quantity })
      gasSpent += receipt.gasUsed * gasPrice
      const post = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: owner, blockNumber: receipt.blockNumber, bookPools: [pool], listStops })
      const external = (await bankLogsForOwner(client, MARGIN_BANK, owner, pre.block.number + 1n, receipt.blockNumber)).filter((l) => l.txHash !== hash)
      const result = recompute({ scenario, analysis, candidateId: candidate.id, actionId, pre, post, receipt, externalLogs: external })
      journal.update(actionId, "recomputed", (r) => {
        r.fill = { state: result.fill.state, requested: result.fill.requested.toString(), filled: result.fill.filled.toString() }
        r.goal = { state: result.goal.state, reason: result.goal.reason }
      })
      writeFileAtomic(join(out, "receipt.json"), prettyJson(receipt))
      writeFileAtomic(join(out, "post-snapshot.json"), prettyJson(post))
      writeFileAtomic(join(out, "recompute.json"), prettyJson(result))
      writeFileAtomic(join(out, "recompute.txt"), renderRecompute(result, poolOf(pre, pool).baseDecimals))
      record({ step: "recompute", fill: result.fill.state, goal: result.goal.state })
    }
  } catch (e) {
    record({ step: "abort", reason: (e as Error).message.split("\n")[0] })
  } finally {
    await cleanup()
  }
  return 0

  async function cleanup() {
    const attempt = async (step: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (e) {
        record({ step, cleanupError: (e as Error).message.split("\n")[0] })
      }
    }
    if (granted) await attempt("revoke grant", () => send("revoke grant", OPERATOR_REGISTRY, encodeFunctionData({ abi: operatorRegistryAbi, functionName: "setOperatorApprovalForPool", args: [granted!, guardOf(), [PLACE_ORDER_FOR_SELECTOR], false] })))
    if (deposited) {
      for (const [pool, tick] of [
        [BTC_POOL, plan.markets[0].tick],
        [ETH_POOL, plan.markets[1].tick],
      ] as const) {
        for (let i = 0; i < 3; i++) {
          const size = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [owner, pool] })).size
          if (size === 0n) break
          const isBid = size < 0n
          const touch = await book(pool, !isBid)
          const s = plan.bounds.maxSlippageBpsPerOrder
          const limit = isBid ? alignDown((touch.price * (10_000n + s)) / 10_000n, tick) : alignUp((touch.price * (10_000n - s)) / 10_000n, tick)
          await attempt(`close ${pool}`, async () => send(`close ${pool}`, pool, ioc(pool, isBid, size < 0n ? -size : size, limit, await nowNs())))
        }
      }
      const unlocked = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [owner] })).unlockedCollateralBalance
      if (unlocked > 0n) await attempt("withdraw", () => send("withdraw", MARGIN_BANK, encodeFunctionData({ abi: marginBankWriteAbi, functionName: "withdraw", args: [unlocked] })))
    }
    const allowance = await client.readContract({ address: USDSO, abi: erc20Abi, functionName: "allowance", args: [owner, MARGIN_BANK] })
    if (allowance > 0n) await attempt("clear allowance", () => send("clear allowance", USDSO, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARGIN_BANK, 0n] })))
    const [stt, usdso, state] = await Promise.all([
      client.getBalance({ address: owner }),
      client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [owner] }),
    ])
    record({ step: "final", stt, usdso, bank: state, gasSpent })
  }

  function guardOf(): Address {
    const g = (runLog as { step: string; guard?: Address }[]).find((x) => x.step === "guard")?.guard
    if (!g) throw new Error("no guard recorded")
    return g
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
