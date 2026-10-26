// Margin Rescue CLI. Reads, analyses, plans and recomputes; it never signs or sends.
//
//   npm run mr -- reconcile --account 0x… [--block N] [--out DIR]
//   npm run mr -- analyze   --account 0x… --shock BTC=-8 --shock ETH=-12 --target 25 [--price ETH=2000] [--slippage-bps 50] [--include-cancel] [--block N] [--out DIR]
//   npm run mr -- plan      --analysis DIR --guard 0x… [--candidate ID] [--deadline 120] [--journal DIR]
//   npm run mr -- recompute --analysis DIR --action 0x… [--tx 0x…] [--journal DIR]
//   npm run mr -- actions   [--journal DIR] [--resolve]
//   npm run mr -- study-rounding [--block N] [--out FILE]
//   npm run mr -- live-plan [--out FILE]
//
// --rpc URL reads from another endpoint with the same chain id (a local fork, for
// example); everything else uses the Hideki RPC from .env or the SDK default.
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { Address, Hex, PublicClient } from "viem"
import { loadConfig, sdkVersion } from "../config.js"
import { parseDecimal } from "../units.js"
import { PLACE_ORDER_FOR_SELECTOR, perpPoolAbi, reduceGuardAbi } from "./abi.js"
import { actionIdOf, reduceCalldata, requestFromCandidate } from "./action.js"
import { analyzeCandidates } from "./candidates.js"
import { ActionJournal, resolveAction } from "./journal.js"
import { prettyJson, writeFileAtomic } from "./json.js"
import { reconcile } from "./reconcile.js"
import { bankLogsForOwner, recompute } from "./recompute.js"
import { readActionReceipt } from "./receipt.js"
import { renderAnalysis, renderReconciliation, renderRecompute } from "./report.js"
import { createHidekiClient, sampleBlock } from "./rpc.js"
import { buildScenario, scenarioCompatibility, type Scenario } from "./scenario.js"
import { poolOf, readAccountSnapshot, sameAddress, type AccountSnapshot } from "./snapshot.js"
import { BTC_POOL, ETH_POOL, MARGIN_BANK, loadAnalysis, readBigJson, stopLister } from "./common.js"
import { roundingStudy } from "./study.js"
import { simulateIoc } from "./book.js"
import { buildLivePlan, DEFAULT_PLAN, TEST_EOA } from "./livePlan.js"

const USAGE = `usage: npm run mr -- <command> [options]
  reconcile --account ADDR [--block N] [--out DIR]
  analyze --account ADDR --target USDSO [--shock BTC=-8] [--shock ETH=-12] [--price BTC=72000] [--slippage-bps 50] [--include-cancel] [--block N] [--out DIR]
  plan --analysis DIR --guard ADDR [--candidate ID] [--deadline SECONDS] [--journal DIR]
  recompute --analysis DIR --action ID [--tx HASH] [--journal DIR]
  actions [--journal DIR] [--resolve]
  study-rounding [--block N] [--out FILE]
  live-plan [--account ADDR] [--out FILE]     (read-only proposal for one consolidated approval)
common: --rpc URL (same chain id, e.g. a local fork), --no-stops (skip the indexer stop listing)`

function shockArg(list: string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of list ?? []) {
    const m = /^([A-Za-z]+)=(-?\d+(?:\.\d{1,2})?)$/.exec(item)
    if (!m) throw new Error(`--shock takes SYMBOL=PERCENT with up to two decimals, got ${item}`)
    out[m[1].toUpperCase()] = Number(parseDecimal(m[2], 2, { signed: true })) // percent → bps
  }
  return out
}

function priceArg(list: string[] | undefined): Record<string, bigint> {
  const out: Record<string, bigint> = {}
  for (const item of list ?? []) {
    const m = /^([A-Za-z]+)=(\d+(?:\.\d+)?)$/.exec(item)
    if (!m) throw new Error(`--price takes SYMBOL=USDSO, got ${item}`)
    out[m[1].toUpperCase()] = parseDecimal(m[2], 18)
  }
  return out
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: {
      account: { type: "string" },
      block: { type: "string" },
      out: { type: "string" },
      rpc: { type: "string" },
      shock: { type: "string", multiple: true },
      price: { type: "string", multiple: true },
      target: { type: "string" },
      "slippage-bps": { type: "string" },
      "include-cancel": { type: "boolean", default: false },
      "no-stops": { type: "boolean", default: false },
      analysis: { type: "string" },
      guard: { type: "string" },
      candidate: { type: "string" },
      deadline: { type: "string" },
      journal: { type: "string" },
      action: { type: "string" },
      tx: { type: "string" },
      resolve: { type: "boolean", default: false },
    },
  })
  const cfg = loadConfig()
  const client = createHidekiClient(values.rpc ?? cfg.rpcUrl)
  const blockNumber = values.block ? BigInt(values.block) : undefined
  const journalDir = values.journal ?? ".margin-rescue/actions"
  const listStops = values["no-stops"] ? undefined : stopLister()

  if (command === "reconcile" || command === "analyze") {
    if (!values.account) throw new Error("--account is required")
    const snapshot = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: values.account as Address, blockNumber, bookPools: [BTC_POOL, ETH_POOL], listStops })
    const recon = reconcile(snapshot)
    const reconText = renderReconciliation(snapshot, recon)
    if (command === "reconcile") {
      console.log(reconText)
      if (values.out) {
        writeFileAtomic(join(values.out, "snapshot.json"), prettyJson(snapshot))
        writeFileAtomic(join(values.out, "reconciliation.json"), prettyJson(recon))
        writeFileAtomic(join(values.out, "reconciliation.txt"), reconText)
      }
      return recon.verdict === "EXACT" ? 0 : 3
    }
    if (!values.target) throw new Error("--target (USDso) is required")
    const scenario = buildScenario(snapshot, recon, { shocksBps: shockArg(values.shock), prices: priceArg(values.price), targetBuffer: parseDecimal(values.target, 18, { signed: true }) })
    const analysis = analyzeCandidates(scenario, snapshot, recon, {
      slippageBps: values["slippage-bps"] ? BigInt(values["slippage-bps"]) : undefined,
      includeCancel: values["include-cancel"],
    })
    const text = renderAnalysis(snapshot, scenario, analysis)
    console.log(reconText)
    console.log(text)
    if (values.out) {
      writeFileAtomic(join(values.out, "snapshot.json"), prettyJson(snapshot))
      writeFileAtomic(join(values.out, "reconciliation.json"), prettyJson(recon))
      writeFileAtomic(join(values.out, "reconciliation.txt"), reconText)
      writeFileAtomic(join(values.out, "scenario.json"), prettyJson(scenario))
      writeFileAtomic(join(values.out, "candidates.json"), prettyJson(analysis))
      writeFileAtomic(join(values.out, "analysis.txt"), text)
    }
    return 0
  }

  if (command === "plan") {
    if (!values.analysis || !values.guard) throw new Error("--analysis and --guard are required")
    const { snapshot: ref, scenario, analysis } = loadAnalysis(values.analysis)
    const candidateId = values.candidate ?? analysis.selected
    if (!candidateId) throw new Error(`the analysis selected nothing (${analysis.outcome}); pass --candidate to plan a specific one`)
    const pool = analysis.candidates.find((c) => c.id === candidateId)?.reduce?.pool as Address | undefined
    if (!pool) throw new Error(`${candidateId} is not a reduction`)
    const guard = values.guard as Address
    const pre = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: ref.account, bookPools: [pool], listStops })
    const problems = await planChecks(client, scenario, ref, pre, pool, guard)
    const { request, candidate } = requestFromCandidate(analysis, candidateId, ref, { deadlineSeconds: Number(values.deadline ?? 120), nowSeconds: pre.block.timestamp })
    const binding = { chainId: 50383, guard, marginBank: MARGIN_BANK, owner: ref.account }
    const actionId = actionIdOf(binding, request)
    const fresh = simulateIoc(request.isBid ? pre.books[0].asks : pre.books[0].bids, request.isBid, request.quantity, request.limitPrice)
    writeFileAtomic(join(values.analysis, `preflight-${actionId}.json`), prettyJson(pre))
    const summary = {
      actionId,
      candidateId,
      scenarioId: scenario.id,
      problems,
      unsignedTransaction: { chainId: 50383, from: ref.account, to: guard, value: "0", data: reduceCalldata(request) },
      request,
      preflight: { block: pre.block, expectedFillNow: fresh.filled, expectedFillAtAnalysis: candidate.reduce!.expectedFill },
    }
    if (problems.length) {
      console.log(prettyJson(summary))
      console.error(`not planned: ${problems.join("; ")}`)
      return 4
    }
    const journal = new ActionJournal(journalDir)
    journal.create({
      actionId,
      createdAt: new Date().toISOString(),
      binding,
      scenarioId: scenario.id,
      candidateId,
      request: { pool: request.pool, expectedSignedSize: request.expectedSignedSize.toString(), isBid: request.isBid, quantity: request.quantity.toString(), limitPrice: request.limitPrice.toString(), deadline: request.deadline.toString(), nonce: request.nonce },
      calldata: reduceCalldata(request),
      forecast: { expectedFill: candidate.reduce!.expectedFill.toString(), scenarioBuffer: candidate.scenario!.buffer.toString(), goal: candidate.goal! },
      quote: { blockNumber: pre.block.number.toString(), blockHash: pre.block.hash, validUntil: request.deadline.toString() },
    })
    console.log(prettyJson(summary))
    console.log(`journalled as NOT_SENT in ${journalDir}. Nothing was signed or sent.`)
    return 0
  }

  if (command === "recompute") {
    if (!values.analysis || !values.action) throw new Error("--analysis and --action are required")
    const { scenario, analysis } = loadAnalysis(values.analysis)
    const journal = new ActionJournal(journalDir)
    let record = journal.get(values.action)
    if (values.tx && record.tx.state === "NOT_SENT") {
      const tx = await client.getTransaction({ hash: values.tx as Hex })
      record = journal.update(record.actionId, "attached", (r) => (r.tx = { state: "PENDING", from: tx.from, nonce: tx.nonce, hash: tx.hash, sentAt: "sent outside this tool" }), values.tx)
    }
    record = await resolveAction(journal, record.actionId, client)
    if (!record.tx.hash || (record.tx.state !== "CONFIRMED" && record.tx.state !== "REVERTED")) {
      console.log(prettyJson(record))
      console.error(`transaction is ${record.tx.state}; nothing to recompute yet`)
      return 5
    }
    const pre = readBigJson<AccountSnapshot>(join(values.analysis, `preflight-${record.actionId}.json`))
    const candidate = analysis.candidates.find((c) => c.id === record.candidateId)!
    const pool = candidate.reduce!.pool as Address
    const receipt = await readActionReceipt(client, record.tx.hash, {
      guard: record.binding.guard,
      pool,
      owner: record.binding.owner,
      marginBank: record.binding.marginBank,
      isBid: record.request.isBid,
      limitPrice: BigInt(record.request.limitPrice),
      requested: BigInt(record.request.quantity),
    })
    const post = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account: record.binding.owner, blockNumber: receipt.blockNumber, bookPools: [pool], listStops })
    const external = (await bankLogsForOwner(client, MARGIN_BANK, record.binding.owner, pre.block.number + 1n, receipt.blockNumber)).filter((l) => l.txHash !== record.tx.hash)
    const result = recompute({ scenario, analysis, candidateId: record.candidateId, actionId: record.actionId, pre, post, receipt, externalLogs: external })
    journal.update(record.actionId, "recomputed", (r) => {
      r.fill = { state: result.fill.state, requested: result.fill.requested.toString(), filled: result.fill.filled.toString() }
      r.goal = { state: result.goal.state, reason: result.goal.reason }
    })
    const text = renderRecompute(result, poolOf(pre, pool).baseDecimals)
    console.log(text)
    writeFileAtomic(join(values.analysis, `recompute-${record.actionId}.json`), prettyJson({ result, receipt, post }))
    writeFileAtomic(join(values.analysis, `recompute-${record.actionId}.txt`), text)
    return 0
  }

  if (command === "actions") {
    const journal = new ActionJournal(journalDir)
    for (const r of journal.list()) {
      const settled = values.resolve ? await resolveAction(journal, r.actionId, client) : r
      console.log(`${settled.actionId}  ${settled.candidateId}  tx ${settled.tx.state}${settled.tx.hash ? ` ${settled.tx.hash}` : ""}  fill ${settled.fill.state}  goal ${settled.goal.state}`)
    }
    return 0
  }

  if (command === "live-plan") {
    const plan = await buildLivePlan(client, new URL("../../contracts/out/ReduceOnlyGuard.sol/ReduceOnlyGuard.json", import.meta.url), { ...DEFAULT_PLAN, account: (values.account as Address | undefined) ?? TEST_EOA })
    console.log(prettyJson(plan))
    if (values.out) writeFileAtomic(values.out, prettyJson(plan))
    return 0
  }

  if (command === "study-rounding") {
    const block = await sampleBlock(client, blockNumber)
    const study = await roundingStudy(client, MARGIN_BANK, block)
    console.log(prettyJson({ ...study, accounts: undefined }))
    if (values.out) writeFileAtomic(values.out, prettyJson({ sdk: sdkVersion(), ...study }))
    return study.equityFloorExact === study.compared && study.mmExact === study.compared ? 0 : 3
  }

  console.error(USAGE)
  return 2
}

// Everything that must still hold before an analysed reduction may be sent.
async function planChecks(client: PublicClient, scenario: Scenario, ref: AccountSnapshot, pre: AccountSnapshot, pool: Address, guard: Address): Promise<string[]> {
  const problems = [...pre.problems, ...scenarioCompatibility(scenario, pre)]
  const before = ref.positions.find((p) => sameAddress(p.pool, pool))?.size
  const now = pre.positions.find((p) => sameAddress(p.pool, pool))?.size
  if (before !== now) problems.push(`position moved from ${before} to ${now} since the analysis; replan`)
  if (!existsSyncCode(await client.getCode({ address: guard }))) problems.push(`no contract at guard ${guard}`)
  else {
    const read = <T>(fn: string, args: readonly unknown[] = []) => client.readContract({ address: guard, abi: reduceGuardAbi, functionName: fn as never, args: args as never }) as Promise<T>
    const [owner, bank, trusted] = await Promise.all([read<Address>("OWNER"), read<Address>("MARGIN_BANK"), read<boolean>("trustedPool", [pool])])
    if (!sameAddress(owner, ref.account)) problems.push(`guard owner is ${owner}, not ${ref.account}`)
    if (!sameAddress(bank, MARGIN_BANK)) problems.push(`guard bank is ${bank}`)
    if (!trusted) problems.push(`guard does not trust ${pool}`)
    const authorized = await client.readContract({ address: pool, abi: perpPoolAbi, functionName: "isOperatorAuthorized", args: [ref.account, guard, PLACE_ORDER_FOR_SELECTOR] })
    if (!authorized) problems.push("the owner has not granted the guard placeOrderFor on this pool")
  }
  return problems
}

function existsSyncCode(code: Hex | undefined): boolean {
  return !!code && code !== "0x"
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
