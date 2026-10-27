// Independent read-back of one live Margin Rescue run. Read-only: it never signs or
// sends, and never reads a key.
//
// From the run's files it takes only what identifies the run: the plan file (its digest
// must be the one the run was started under), the transaction hashes in run-ledger.json,
// the rescue's confirmation and the scenario fixed before execution. Everything else is
// read again from the chain:
//   1. every transaction and its canonical receipt: sender, nonce, destination, calldata
//      hash, value, status and fee; the call decoded; the fills and bank rows it caused
//   2. the account's nonce before and after: no other transaction was sent from it
//   3. the guard's deployment and code against the plan's approved hashes
//   4. the end state at ONE block: no position or resting order in any factory pool, no
//      live TP/SL stop, every grant the run made revoked, the bank account empty, the
//      allowance zero, no bank row or USDso transfer for the account outside the run
//   5. gas: STT before − STT after = Σ receipt fees; collateral: USDso before − after =
//      deposited − withdrawn, and withdrawn − deposited = Σ realized PnL − Σ funding − Σ fees
//   6. the rescue: the scenario's absolute prices re-derived from the chain at its
//      reference block and the plan's shocks (never re-applied to later prices), then the
//      account valued at those prices just before the reduction's block and at it
//
//   npm run mr:verify-run -- --run DIR [--plan FILE] [--block N] [--rpc URL] [--out DIR]
//
// Writes verification.json and verification.txt to --out (default: the run folder).
// Exit 0 only when every check holds.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { decodeEventLog, decodeFunctionData, keccak256, parseAbi, toEventSelector, type Abi, type Address, type Hex, type Log } from "viem"
import { erc20Abi, marginBankAbi, marginBankEventsAbi, marginBankWriteAbi, operatorRegistryAbi, orderBookEventsAbi, perpPoolAbi, perpPoolFactoryAbi, perpStopRegistryAbi, PLACE_ORDER_FOR_SELECTOR, reduceGuardAbi } from "../src/margin-rescue/abi.js"
import { MAX_CLOSE_ATTEMPTS } from "../src/margin-rescue/cleanup.js"
import { indexerWatermark, MARGIN_BANK, OPERATOR_REGISTRY, readBigJson, stopLister, USDSO } from "../src/margin-rescue/common.js"
import { loadConfig } from "../src/config.js"
import { prettyJson, sha256Hex, writeFileAtomic } from "../src/margin-rescue/json.js"
import { assertHideki, createHidekiClient, mapLimit } from "../src/margin-rescue/rpc.js"
import { verifyScenarioId, type Scenario } from "../src/margin-rescue/scenario.js"

export const VERIFY_VERSION = "mr-live-verify/1"

type Client = ReturnType<typeof createHidekiClient>
type Group = "run" | "transactions" | "guard" | "cleanup" | "reconciliation" | "rescue"

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])
const EVENTS = [...orderBookEventsAbi, ...marginBankEventsAbi, ...reduceGuardAbi, ...transferAbi] as unknown as Abi
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const asText = (detail: unknown) => (typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))

interface Check {
  group: Group
  name: string
  ok: boolean
  detail: string
}

interface Fill {
  pool: Address
  isBid: boolean
  quantity: bigint
  price: bigint
  limit: bigint | null
}

interface TxReport {
  n: number
  id: string
  phase: string
  hash: Hex
  ledgerState: string
  status: string | null
  block: bigint | null
  blockHash: Hex | null
  nonce: number | null
  to: Address | null
  call: string
  gasUsed: bigint | null
  effectiveGasPrice: bigint | null
  fee: bigint
  fills: Fill[]
  bank: { name: string; pool: Address | null; amount?: bigint; newSize?: bigint; realizedPnl?: bigint; payment?: bigint }[]
  guardEvent: { actionId: Hex; pool: Address; orderId: bigint; sizeBefore: bigint; sizeAfter: bigint; quantity: bigint; limitPrice: bigint } | null
  request: { pool: Address; expectedSignedSize: bigint; isBid: boolean; quantity: bigint; limitPrice: bigint; deadline: bigint } | null
  problems: { name: string; detail: string }[]
}

interface Valuation {
  block: bigint
  unlocked: bigint
  locked: bigint
  legs: { symbol: string; size: bigint; avgEntryPrice: bigint; fundingOwed: bigint; price: bigint; pnl: bigint; mm: bigint }[]
  eRisk: bigint
  mm: bigint
  buffer: bigint
  bufferLower: bigint
  bufferUpper: bigint
  problems: string[]
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { run: { type: "string" }, plan: { type: "string" }, block: { type: "string" }, rpc: { type: "string" }, out: { type: "string" } } })
  if (!values.run) throw new Error("--run DIR is required")
  const dir = values.run
  const planPath = values.plan ?? (existsSync(join(dir, "live-plan.json")) ? join(dir, "live-plan.json") : "live-plan.json")
  const cfg = loadConfig()
  const rpc = values.rpc ?? cfg.rpcUrl
  const client = createHidekiClient(rpc, { timeoutMs: 120_000 })
  await assertHideki(client)

  const checks: Check[] = []
  const check = (group: Group, name: string, ok: boolean, detail: unknown = "") => {
    checks.push({ group, name, ok, detail: asText(detail) })
    return ok
  }

  // ---- what identifies the run ----
  const planBytes = readFileSync(planPath)
  const planDigest = sha256Hex(planBytes)
  const plan = JSON.parse(planBytes.toString("utf8"))
  type Step = { n: number; id: string; phase: string; to: Address | null; dataKeccak: Hex; nonce: number; hash: Hex; state: string; receipt?: { fee: bigint } }
  const ledger = readBigJson<{ planDigest: string; account: Address; chainId: number; startNonce: bigint; steps: Step[] }>(join(dir, "run-ledger.json"))
  const state = JSON.parse(readFileSync(join(dir, "run-state.json"), "utf8")) as { planDigest: string; account: Address; guard: Address | null; rescueActionId: Hex | null }
  const account = ledger.account
  const guard = state.guard
  const startNonce = Number(ledger.startNonce)
  const pools: Address[] = plan.guard.constructorArgs.pools
  const oneBaseOf = (pool: Address) => BigInt(plan.markets.find((m: { pool: string }) => same(m.pool, pool)).oneBase)
  check("run", "the plan file is the one the run was started under", planDigest === ledger.planDigest && planDigest === state.planDigest, { planFile: planDigest, ledger: ledger.planDigest, state: state.planDigest })
  check("run", "chain 50383 and the plan's account", plan.network?.chainId === 50383 && Number(ledger.chainId) === 50383 && same(plan.account?.address, account) && same(state.account, account), { plan: plan.account?.address, ledger: account })

  // ---- 1. transactions ----
  const txs: TxReport[] = []
  const grantsMade: { pool: Address; operator: Address; selector: Hex }[] = []
  for (const step of ledger.steps) txs.push(await readTx(client, step, { account, guard, plan, pools, grantsMade }))
  for (const t of txs) for (const p of t.problems) check("transactions", `tx ${t.n} ${t.id}: ${p.name}`, false, p.detail)
  const mined = txs.filter((t) => t.block !== null)
  if (!mined.length) throw new Error("no transaction of this run is on chain; nothing to verify")
  check("transactions", "every recorded transaction read back from a canonical receipt", txs.every((t) => t.problems.length === 0), `${mined.length} mined, ${txs.length - mined.length} not included`)
  check("transactions", "no more transactions than the plan allows", txs.length <= Number(plan.bounds.gas.transactions), `${txs.length} of ${plan.bounds.gas.transactions}`)
  const reductions = mined.filter((t) => t.phase === "main" && same(t.to, guard))
  check("transactions", "at most one guarded reduction in the main phase", reductions.length <= 1, reductions.map((t) => t.hash).join(", ") || "none")
  const closes = new Map<string, number>()
  for (const t of mined) if (t.phase === "cleanup" && same(t.to, guard)) closes.set(t.request!.pool.toLowerCase(), (closes.get(t.request!.pool.toLowerCase()) ?? 0) + 1)
  check("transactions", `at most ${MAX_CLOSE_ATTEMPTS} guarded closes per leg`, [...closes.values()].every((n) => n <= MAX_CLOSE_ATTEMPTS), Object.fromEntries(closes))
  const toPool = txs.filter((t) => t.phase === "cleanup" && pools.some((p) => same(p, t.to)))
  check("transactions", "every cleanup order went through the guard", toPool.length === 0, toPool.map((t) => t.id).join(", ") || "none sent straight to a pool")
  for (const [id, planned] of [["open-BTC-long", plan.bounds.openingQuantities.btc], ["open-ETH-short", plan.bounds.openingQuantities.eth]] as const) {
    const t = mined.find((x) => x.id === id)
    if (!t) continue
    const filled = t.fills.reduce((s, f) => s + f.quantity, 0n)
    check("transactions", `${id}: filled no more than the planned quantity`, filled > 0n && filled <= BigInt(planned), `${filled} of ${planned}`)
  }

  // ---- 2. nonces; the end block ----
  const firstBlock = mined.reduce((m, t) => (t.block! < m ? t.block! : m), mined[0].block!)
  const lastBlock = mined.reduce((m, t) => (t.block! > m ? t.block! : m), mined[0].block!)
  const before = firstBlock - 1n
  // One block for every end-state read; not past what the indexer (stop listing) has processed.
  const latest = await client.getBlockNumber()
  const indexed = await indexerWatermark(cfg.indexerUrl)
  const B = values.block ? BigInt(values.block) : indexed !== null && indexed < latest ? indexed : latest
  if (B < lastBlock) throw new Error(`end block ${B} is before the run's last transaction (block ${lastBlock}); the indexer is behind, try again shortly`)
  const endBlock = await client.getBlock({ blockNumber: B })
  const nonces = mined.map((t) => t.nonce!).sort((a, b) => a - b)
  const [nonceBefore, nonceAfter] = await Promise.all([client.getTransactionCount({ address: account, blockNumber: before }), client.getTransactionCount({ address: account, blockNumber: B })])
  check("transactions", "no other transaction from the account", nonceBefore === startNonce && nonceAfter === startNonce + mined.length && nonces.every((n, i) => n === startNonce + i), { before: nonceBefore, startNonce, mined: mined.length, after: nonceAfter })

  // ---- 3. the guard ----
  const at = { blockNumber: B }
  let guardReport: Record<string, unknown> | null = null
  if (guard) {
    const code = await client.getCode({ address: guard, ...at })
    const read = <T>(fn: string, args: readonly unknown[] = []) => client.readContract({ address: guard, abi: reduceGuardAbi, functionName: fn as never, args: args as never, ...at }) as Promise<T>
    const [owner, bank, trusted] = await Promise.all([read<Address>("OWNER"), read<Address>("MARGIN_BANK"), Promise.all(pools.map((p) => read<boolean>("trustedPool", [p])))])
    const runtime = code ? keccak256(code) : null
    const deploy = mined.find((t) => t.to === null)
    guardReport = { address: guard, deployTx: deploy?.hash ?? null, deployBlock: deploy?.block ?? null, runtimeKeccak: runtime, approvedRuntimeKeccak: plan.guard.expectedRuntimeKeccak, owner, marginBank: bank, trustedPools: pools.filter((_p, i) => trusted[i]) }
    check("guard", "deployed by this run from the approved build", !!deploy && deploy.problems.length === 0, deploy?.hash ?? "no deployment transaction")
    check("guard", "code on chain is the approved runtime", runtime === plan.guard.expectedRuntimeKeccak, { runtime, approved: plan.guard.expectedRuntimeKeccak })
    check("guard", "OWNER, MARGIN_BANK and trusted pools as approved", same(owner, account) && same(bank, MARGIN_BANK) && trusted.every(Boolean), { owner, bank, trusted })
  }

  // ---- 4. the end state at block B ----
  const bankRead = <T>(fn: string, args: readonly unknown[], blockNumber = B) => client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: fn as never, args: args as never, blockNumber }) as Promise<T>
  const system = await bankRead<{ perpPoolFactory: Address }>("getSystemConfig", [])
  const factoryPools = (await client.readContract({ address: system.perpPoolFactory, abi: perpPoolFactoryAbi, functionName: "getPerpPools", ...at })) as readonly Address[]
  const perPool = await mapLimit(factoryPools, 6, async (pool) => {
    const [pos, cap, own, registry, venue] = await Promise.all([
      bankRead<{ size: bigint }>("getPosition", [account, pool]),
      client.readContract({ address: pool, abi: perpPoolAbi, functionName: "getReducingCapacity", args: [account], ...at }),
      client.readContract({ address: pool, abi: perpPoolAbi, functionName: "getOwnOpenOrders", account, ...at }),
      guard ? client.readContract({ address: OPERATOR_REGISTRY, abi: operatorRegistryAbi, functionName: "isApprovedForPool", args: [pool, account, guard, PLACE_ORDER_FOR_SELECTOR], ...at }) : false,
      guard ? client.readContract({ address: pool, abi: perpPoolAbi, functionName: "isOperatorAuthorized", args: [account, guard, PLACE_ORDER_FOR_SELECTOR], ...at }) : false,
    ])
    return { pool, size: pos.size, pending: cap.pendingBidQuantity + cap.pendingAskQuantity, orders: own.length, granted: registry || venue }
  })
  type BankState = { unlockedCollateralBalance: bigint; lockedCollateral: bigint; activePerpPools: readonly Address[] }
  const runGrants = await Promise.all(
    grantsMade.map(async (g) => {
      const [registry, venue] = await Promise.all([
        client.readContract({ address: OPERATOR_REGISTRY, abi: operatorRegistryAbi, functionName: "isApprovedForPool", args: [g.pool, account, g.operator, g.selector], ...at }),
        client.readContract({ address: g.pool, abi: perpPoolAbi, functionName: "isOperatorAuthorized", args: [account, g.operator, g.selector], ...at }),
      ])
      return { ...g, stillGranted: registry || venue }
    }),
  )
  const [accountState, stateBefore, globalGrant, allowanceBank, allowanceGuard, sttBefore, sttAfter, usdBefore, usdAfter] = await Promise.all([
    bankRead<BankState>("getAccountState", [account]),
    bankRead<BankState>("getAccountState", [account], before),
    guard ? client.readContract({ address: OPERATOR_REGISTRY, abi: operatorRegistryAbi, functionName: "isGloballyApproved", args: [account, guard, PLACE_ORDER_FOR_SELECTOR], ...at }) : false,
    client.readContract({ address: USDSO, abi: erc20Abi, functionName: "allowance", args: [account, MARGIN_BANK], ...at }),
    guard ? client.readContract({ address: USDSO, abi: erc20Abi, functionName: "allowance", args: [account, guard], ...at }) : 0n,
    client.getBalance({ address: account, blockNumber: before }),
    client.getBalance({ address: account, blockNumber: B }),
    client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: before }),
    client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [account], ...at }),
  ])
  const stops = await stopLister(cfg.indexerUrl)(account)
  const liveStops = await mapLimit(stops.rows, 4, async (s) => {
    const [live, o] = (await client.readContract({ address: s.registry as Address, abi: perpStopRegistryAbi, functionName: "getPendingOrder", args: [BigInt(s.orderIdRaw)], ...at })) as readonly [boolean, { orderWithTrigger: { order: { owner: Address } } }]
    return live && same(o.orderWithTrigger.order.owner, account)
  })
  const external = await outsideActivity(client, account, firstBlock, B, new Set(mined.map((t) => t.hash.toLowerCase())))
  const endBlockAgain = await client.getBlock({ blockNumber: B })

  const open = perPool.filter((p) => p.size !== 0n)
  const resting = perPool.filter((p) => p.pending > 0n || p.orders > 0)
  check("cleanup", "end block still canonical after the reads", endBlockAgain.hash === endBlock.hash, `${B} ${endBlock.hash}`)
  check("cleanup", "no position in any factory pool", open.length === 0, open.map((p) => `${p.pool}:${p.size}`).join(", ") || `${factoryPools.length} pools read at block ${B}`)
  check("cleanup", "no resting order in any factory pool", resting.length === 0, resting.map((p) => p.pool).join(", ") || `${factoryPools.length} pools read`)
  check("cleanup", "no live TP/SL stop", stops.indexedThrough !== null && stops.indexedThrough >= B && liveStops.every((l) => !l), `${stops.rows.length} listed by the indexer (processed through ${stops.indexedThrough}), ${liveStops.filter(Boolean).length} live at block ${B}`)
  check("cleanup", "MarginBank account empty", accountState.unlockedCollateralBalance === 0n && accountState.lockedCollateral === 0n && accountState.activePerpPools.length === 0, { unlocked: accountState.unlockedCollateralBalance, locked: accountState.lockedCollateral, activePools: accountState.activePerpPools.length })
  check("cleanup", "USDso allowance to the bank and to the guard is zero", allowanceBank === 0n && allowanceGuard === 0n, { bank: allowanceBank, guard: allowanceGuard })
  check("cleanup", "every grant the run made is revoked", runGrants.every((g) => !g.stillGranted), runGrants.map((g) => `${g.pool} → ${g.operator}: ${g.stillGranted ? "STILL GRANTED" : "revoked"}`).join("; ") || "the run made no grant")
  check("cleanup", "the guard holds no grant on any pool, nor a global one", perPool.every((p) => !p.granted) && !globalGrant, `${factoryPools.length} pools checked; global ${globalGrant}`)
  check("cleanup", "no bank row or USDso transfer for the account outside the run", external.length === 0, external.join("; ") || `blocks ${firstBlock}–${B}`)

  // ---- 5. gas and collateral ----
  const rows = mined.flatMap((t) => t.bank)
  const total = (name: string, pick: (b: TxReport["bank"][number]) => bigint | undefined) => rows.filter((b) => b.name === name).reduce((s, b) => s + (pick(b) ?? 0n), 0n)
  const fees = mined.reduce((s, t) => s + t.fee, 0n)
  const deposited = total("Deposited", (b) => b.amount)
  const withdrawn = total("Withdrawn", (b) => b.amount)
  const realized = total("PositionUpdated", (b) => b.realizedPnl)
  const funding = total("FundingSettled", (b) => b.payment)
  const tradingFees = total("FeeCharged", (b) => b.amount)
  // What the fills alone imply: received for sells minus paid for buys, per market.
  const fills = mined.flatMap((t) => t.fills)
  const fillPnl = pools.reduce((s, pool) => s + fills.filter((f) => same(f.pool, pool)).reduce((x, f) => x + (f.isBid ? -1n : 1n) * f.quantity * f.price, 0n) / oneBaseOf(pool), 0n)
  const flat = pools.every((pool) => fills.filter((f) => same(f.pool, pool)).reduce((x, f) => x + (f.isBid ? f.quantity : -f.quantity), 0n) === 0n)
  const gap = realized > fillPnl ? realized - fillPnl : fillPnl - realized
  check("reconciliation", "STT spent = Σ receipt fees", sttBefore - sttAfter === fees, { before: sttBefore, after: sttAfter, spent: sttBefore - sttAfter, fees })
  check("reconciliation", "STT spent within the plan's 2 STT cap", fees <= BigInt(plan.bounds.gas.sttCap), { fees, cap: plan.bounds.gas.sttCap })
  check("reconciliation", "bank account empty before the run", stateBefore.unlockedCollateralBalance === 0n && stateBefore.lockedCollateral === 0n, { unlocked: stateBefore.unlockedCollateralBalance, locked: stateBefore.lockedCollateral })
  check("reconciliation", "deposit exactly as planned", deposited === BigInt(plan.bounds.maxDepositUsdso), { deposited, planned: plan.bounds.maxDepositUsdso })
  check("reconciliation", "wallet USDso change = deposited − withdrawn", usdBefore - usdAfter === deposited - withdrawn, { before: usdBefore, after: usdAfter, deposited, withdrawn })
  check("reconciliation", "withdrawn − deposited = Σ realized − Σ funding − Σ fees", withdrawn - deposited === realized - funding - tradingFees, { result: withdrawn - deposited, realized, funding, fees: tradingFees })
  check("reconciliation", "every leg opened was closed (fills net to zero)", flat, fills.map((f) => `${f.pool.slice(0, 8)} ${f.isBid ? "+" : "-"}${f.quantity}`).join(" "))
  check("reconciliation", "bank realized PnL agrees with the fills (≤ 10 raw units per fill)", gap <= BigInt(fills.length) * 10n, { bank: realized, fills: fillPnl, gap })

  // ---- 6. the rescue under the scenario fixed before execution ----
  const rescue = await verifyRescue(client, { dir, plan, account, rescueActionId: state.rescueActionId, txs, check })

  const groupOk = (g: Group) => checks.filter((c) => c.group === g).every((c) => c.ok)
  const report = {
    version: VERIFY_VERSION,
    verifiedAt: new Date().toISOString(),
    rpc,
    chainId: 50383,
    account,
    planDigest,
    guard: guardReport,
    endBlock: { number: B, hash: endBlock.hash, timestamp: endBlock.timestamp },
    window: { before, firstBlock, lastBlock },
    transactions: txs,
    nonces: { before: nonceBefore, after: nonceAfter, mined: mined.length },
    endState: { pools: factoryPools.length, positions: open, resting, stops: { listed: stops.rows.length, live: liveStops.filter(Boolean).length, indexedThrough: stops.indexedThrough }, bank: accountState, allowance: { bank: allowanceBank, guard: allowanceGuard }, grants: runGrants, globalGrant },
    reconciliation: {
      stt: { before: sttBefore, after: sttAfter, spent: sttBefore - sttAfter, receiptFees: fees, cap: plan.bounds.gas.sttCap },
      usdso: { before: usdBefore, after: usdAfter, deposited, withdrawn, result: withdrawn - deposited, realizedPnl: realized, funding, fees: tradingFees, fillImpliedPnl: fillPnl },
    },
    rescue,
    checks,
    verdict: {
      allChecksHold: checks.every((c) => c.ok),
      transactionsVerified: groupOk("run") && groupOk("transactions") && groupOk("guard"),
      reductionFilled: rescue.filled > 0n,
      goal: rescue.goal,
      cleanupVerified: groupOk("cleanup"),
      reconciled: groupOk("reconciliation"),
      rescueVerified: groupOk("rescue"),
    },
  }
  const out = values.out ?? dir
  writeFileAtomic(join(out, "verification.json"), prettyJson(report))
  writeFileAtomic(join(out, "verification.txt"), render(report))
  console.log(render(report))
  return report.verdict.allChecksHold ? 0 : 3
}

// One recorded transaction, read back: the transaction, its canonical receipt, the call
// decoded, and the account's fills, bank rows and the guard's event in its logs.
async function readTx(client: Client, step: { n: number; id: string; phase: string; to: Address | null; dataKeccak: Hex; nonce: number; hash: Hex; state: string; receipt?: { fee: bigint } }, ctx: { account: Address; guard: Address | null; plan: any; pools: Address[]; grantsMade: { pool: Address; operator: Address; selector: Hex }[] }): Promise<TxReport> {
  const { account, guard, plan, pools } = ctx
  const r: TxReport = { n: step.n, id: step.id, phase: step.phase, hash: step.hash, ledgerState: step.state, status: null, block: null, blockHash: null, nonce: null, to: step.to, call: "", gasUsed: null, effectiveGasPrice: null, fee: 0n, fills: [], bank: [], guardEvent: null, request: null, problems: [] }
  const expect = (ok: boolean, name: string, detail: unknown = "") => {
    if (!ok) r.problems.push({ name, detail: asText(detail) })
  }
  const tx = await client.getTransaction({ hash: step.hash }).catch(() => null)
  if (!tx) {
    expect(step.state === "NOT_INCLUDED", "not on chain, but the ledger does not say NOT_INCLUDED", step.state)
    return r
  }
  const receipt = await client.getTransactionReceipt({ hash: step.hash })
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  r.status = receipt.status
  r.block = receipt.blockNumber
  r.blockHash = receipt.blockHash
  r.nonce = tx.nonce
  r.to = tx.to ?? null
  r.gasUsed = receipt.gasUsed
  r.effectiveGasPrice = receipt.effectiveGasPrice ?? tx.gasPrice ?? 0n
  r.fee = receipt.gasUsed * r.effectiveGasPrice
  expect(block.hash === receipt.blockHash, "receipt block is not canonical", `${receipt.blockNumber} ${receipt.blockHash} (canonical ${block.hash})`)
  expect(same(tx.from, account) && same(receipt.from, account), "not sent by the account", tx.from)
  expect(tx.nonce === step.nonce, "nonce differs from the ledger", `${tx.nonce} (ledger ${step.nonce})`)
  expect(r.to === null ? step.to === null : same(r.to, step.to), "destination differs from the ledger", `${r.to} (ledger ${step.to})`)
  expect(keccak256(tx.input) === step.dataKeccak, "calldata hash differs from the ledger", step.dataKeccak)
  expect(tx.value === 0n, "carries value", tx.value)
  expect(tx.chainId === undefined || tx.chainId === 50383, "signed for another chain", tx.chainId)
  expect((receipt.status === "success" ? "CONFIRMED" : "REVERTED") === step.state, "status differs from the ledger", `${receipt.status} (ledger ${step.state})`)
  expect(step.receipt?.fee === r.fee, "fee differs from the ledger", `${r.fee} (ledger ${step.receipt?.fee})`)

  // The call.
  let limit: bigint | null = null
  let side: boolean | null = null
  if (r.to === null) {
    r.call = "deploy ReduceOnlyGuard"
    expect(keccak256(tx.input) === plan.guard.deployDataKeccak, "deployment data is not the approved build", plan.guard.deployDataKeccak)
    expect(same(receipt.contractAddress, guard), "deployed somewhere other than the run's guard", `${receipt.contractAddress} (run ${guard})`)
  } else if (same(r.to, USDSO)) {
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.input })
    r.call = `USDso.${d.functionName}(${(d.args ?? []).map(String).join(", ")})`
    expect(d.functionName === "approve" && same(d.args?.[0] as string, MARGIN_BANK), "a token call other than approve(MarginBank, …)", r.call)
  } else if (same(r.to, MARGIN_BANK)) {
    const d = decodeFunctionData({ abi: marginBankWriteAbi, data: tx.input })
    r.call = `MarginBank.${d.functionName}(${(d.args ?? []).map(String).join(", ")})`
  } else if (same(r.to, OPERATOR_REGISTRY)) {
    const d = decodeFunctionData({ abi: operatorRegistryAbi, data: tx.input })
    const [pool, operator, selectors, approved] = d.args as unknown as [Address, Address, Hex[], boolean]
    r.call = `setOperatorApprovalForPool(${pool}, ${operator}, [${selectors.join(", ")}], ${approved})`
    expect(same(operator, guard) && selectors.length === 1 && same(selectors[0], PLACE_ORDER_FOR_SELECTOR), "a grant to something other than the guard's placeOrderFor", r.call)
    if (approved) for (const s of selectors) ctx.grantsMade.push({ pool, operator, selector: s })
  } else if (pools.some((p) => same(p, r.to))) {
    const d = decodeFunctionData({ abi: perpPoolAbi, data: tx.input })
    const a = d.args as unknown as [boolean, bigint, bigint, bigint, bigint, number]
    r.call = `${d.functionName}(isBid=${a[0]}, limit=${a[2]}, quantity=${a[3]}, orderType=${a[5]})`
    expect(step.phase === "main" && d.functionName === "placeOrder" && step.id.startsWith("open-"), "a direct order outside the opening steps", `${step.phase} ${step.id}`)
    expect(a[5] === 2, "not an IOC order", a[5])
    limit = a[2]
    side = a[0]
  } else if (same(r.to, guard)) {
    const d = decodeFunctionData({ abi: reduceGuardAbi, data: tx.input })
    const q = (d.args as unknown as [{ pool: Address; expectedSignedSize: bigint; isBid: boolean; quantity: bigint; limitPrice: bigint; deadline: bigint }])[0]
    r.request = { pool: q.pool, expectedSignedSize: q.expectedSignedSize, isBid: q.isBid, quantity: q.quantity, limitPrice: q.limitPrice, deadline: q.deadline }
    r.call = `guard.reduce(pool=${q.pool}, expected=${q.expectedSignedSize}, isBid=${q.isBid}, quantity=${q.quantity}, limit=${q.limitPrice}, deadline=${q.deadline})`
    expect(receipt.status !== "success" || block.timestamp <= q.deadline, "included after its deadline", `${block.timestamp} > ${q.deadline}`)
    limit = q.limitPrice
    side = q.isBid
  } else {
    r.call = `call to ${r.to}`
    expect(false, "a destination the plan does not name", r.to)
  }

  // What it caused.
  const logs: { address: Address; name: string; args: Record<string, unknown> }[] = []
  for (const l of receipt.logs as Log[]) {
    try {
      const d = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics as [Hex, ...Hex[]] })
      logs.push({ address: l.address, name: String(d.eventName), args: d.args as unknown as Record<string, unknown> })
    } catch {
      // an event of no interest here
    }
  }
  const mine = new Map<bigint, { pool: Address; isBid: boolean }>()
  for (const l of logs) {
    const o = l.args.placedOrder as { owner: Address; isBid: boolean } | undefined
    if (l.name === "OrderPlaced" && o && same(o.owner, account)) mine.set(l.args.orderId as bigint, { pool: l.address, isBid: o.isBid })
  }
  for (const l of logs) {
    const taker = l.name === "OrderFilled" ? mine.get(l.args.takerOrderId as bigint) : undefined
    if (taker && same(taker.pool, l.address)) r.fills.push({ pool: l.address, isBid: taker.isBid, quantity: l.args.quantityFilled as bigint, price: l.args.fillPrice as bigint, limit })
    if (l.name === "OrderFilled" && mine.has(l.args.makerOrderId as bigint)) expect(false, "an order of the account was filled as a resting maker", l.args.makerOrderId)
    if (l.name === "OrderRested" && mine.has(l.args.orderId as bigint)) expect(false, "an IOC order was left resting", l.args.orderId)
    if (l.name === "ReduceExecuted" && same(l.address, guard)) {
      const a = l.args
      r.guardEvent = { actionId: a.actionId as Hex, pool: a.pool as Address, orderId: a.orderId as bigint, sizeBefore: a.sizeBefore as bigint, sizeAfter: a.sizeAfter as bigint, quantity: a.quantity as bigint, limitPrice: a.limitPrice as bigint }
    }
    if (same(l.address, MARGIN_BANK) && [l.args.account, l.args.payer].some((x) => same(x as string, account))) {
      const a = l.args
      r.bank.push({ name: l.name, pool: (a.perpPool as Address | undefined) ?? null, amount: a.amount as bigint | undefined, newSize: a.newSize as bigint | undefined, realizedPnl: a.realizedPnl as bigint | undefined, payment: a.payment as bigint | undefined })
    }
  }
  if (side !== null) expect(r.fills.every((f) => f.isBid === side && (side ? f.price <= limit! : f.price >= limit!)), "a fill outside the order's side or limit", r.fills.map((f) => `${f.quantity}@${f.price}`).join(", ") || "no fills")
  if (same(r.to, guard) && receipt.status === "success") {
    const g = r.guardEvent
    const moved = g ? (g.sizeBefore > 0n ? g.sizeBefore - g.sizeAfter : g.sizeAfter - g.sizeBefore) : -1n
    expect(!!g && moved === r.fills.reduce((s, f) => s + f.quantity, 0n), "the guard's event does not match the fills", g)
  }
  return r
}

// Bank rows naming the account and USDso transfers to or from it, in [from, to], that no
// transaction of the run explains. Hideki answers at most 1,000 blocks per query.
async function outsideActivity(client: Client, account: Address, from: bigint, to: bigint, runTxs: Set<string>): Promise<string[]> {
  const topic = `0x${account.toLowerCase().slice(2).padStart(64, "0")}` as Hex
  const transfer = toEventSelector("Transfer(address,address,uint256)")
  const queries: { address: Address; topics: (Hex | null)[] }[] = [
    { address: MARGIN_BANK, topics: [null, topic] },
    { address: MARGIN_BANK, topics: [null, null, topic] },
    { address: MARGIN_BANK, topics: [null, null, null, topic] },
    { address: USDSO, topics: [transfer, topic] },
    { address: USDSO, topics: [transfer, null, topic] },
  ]
  const found = new Set<string>()
  for (let start = from; start <= to; start += 1000n) {
    const end = start + 999n < to ? start + 999n : to
    for (const q of queries) {
      const logs = (await client.request({ method: "eth_getLogs", params: [{ address: q.address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: q.topics }] } as never)) as unknown as { transactionHash: Hex; blockNumber: Hex; address: Address }[]
      for (const l of logs) if (!runTxs.has(l.transactionHash.toLowerCase())) found.add(`${same(l.address, USDSO) ? "USDso transfer" : "bank row"} in ${l.transactionHash} (block ${BigInt(l.blockNumber)})`)
    }
  }
  return [...found]
}

async function verifyRescue(client: Client, ctx: { dir: string; plan: any; account: Address; rescueActionId: Hex | null; txs: TxReport[]; check: (group: Group, name: string, ok: boolean, detail?: unknown) => boolean }) {
  const { dir, plan, account, rescueActionId, txs, check } = ctx
  const result = { actionId: rescueActionId, note: null as string | null, tx: null as Hex | null, block: null as bigint | null, request: null as TxReport["request"], filled: 0n, fills: [] as Fill[], scenario: null as unknown, before: null as Valuation | null, after: null as Valuation | null, goal: "NOT_EVALUATED", recorded: null as unknown }
  if (!rescueActionId) return { ...result, note: "no reduction was confirmed" }
  const record = JSON.parse(readFileSync(join(dir, "journal", `${rescueActionId}.json`), "utf8"))
  const tx = txs.find((t) => record.tx?.hash && same(t.hash, record.tx.hash))
  if (!tx || tx.block === null) return { ...result, note: `the confirmed reduction was not mined (journal: ${record.tx?.state})` }
  const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario
  const R = tx.block

  // The scenario: its own id, its reference block before the reduction, its marks as the
  // chain had them there, and its prices = those marks shocked once by the plan's bps.
  check("rescue", "scenario file unaltered (its id is the hash of its body)", verifyScenarioId(scenario), scenario.id)
  check("rescue", "the confirmation was made under this scenario", record.scenarioId === scenario.id, record.scenarioId)
  const refBlock = BigInt(scenario.reference.blockNumber)
  const ref = await client.getBlock({ blockNumber: refBlock })
  check("rescue", "scenario reference block canonical and before the reduction", ref.hash === scenario.reference.blockHash && refBlock < R, { reference: refBlock, reduction: R })
  check("rescue", "scenario target is the plan's", scenario.targetBuffer === String(plan.scenario.targetBufferUsdso), { scenario: scenario.targetBuffer, plan: plan.scenario.targetBufferUsdso })
  const prices = []
  for (const m of scenario.markets) {
    const [ok, snap] = (await client.readContract({ address: m.pool as Address, abi: perpPoolAbi, functionName: "tryGetHealthSnapshot", blockNumber: refBlock })) as readonly [boolean, { markPrice: bigint }]
    const shock = (plan.scenario.shocksBps[m.symbol.toUpperCase()] ?? null) as number | null
    const derived = shock === null ? snap.markPrice : (snap.markPrice * BigInt(10_000 + shock)) / 10_000n
    prices.push({ symbol: m.symbol, referenceMark: m.referenceMark, markOnChain: ok ? snap.markPrice.toString() : "stale", shockBps: m.shockBps, planShockBps: shock, scenarioPrice: m.scenarioPrice, derived: derived.toString() })
  }
  check("rescue", "scenario prices = chain marks at the reference block × the plan's shocks", prices.every((p) => p.referenceMark === p.markOnChain && p.shockBps === p.planShockBps && p.scenarioPrice === p.derived), prices)

  // The reduction as confirmed, sent and filled.
  const req = record.request
  const g = tx.guardEvent
  check("rescue", "the reduction is the confirmed request, executed by the guard", tx.status === "success" && !!g && same(g.actionId, rescueActionId) && same(g.pool, req.pool) && g.quantity === BigInt(req.quantity) && g.limitPrice === BigInt(req.limitPrice) && g.sizeBefore === BigInt(req.expectedSignedSize), { guardEvent: g, request: req })
  const quote = await client.getBlock({ blockNumber: BigInt(record.quote.blockNumber) })
  check("rescue", "deadline as planned after the analysis block", BigInt(req.deadline) - quote.timestamp === BigInt(plan.execution.timing.deadlineSeconds), { deadline: req.deadline, analysisBlockTime: quote.timestamp, plannedSeconds: plan.execution.timing.deadlineSeconds })
  const filled = tx.fills.reduce((s, f) => s + f.quantity, 0n)

  // The account at the scenario's absolute prices, just before the reduction's block and at it.
  const [beforeV, afterV] = await Promise.all([valueAt(client, scenario, account, R - 1n), valueAt(client, scenario, account, R)])
  const target = BigInt(scenario.targetBuffer)
  // Only a lower bound at or above the target meets it (scenario.ts goalStatus).
  const goal = afterV.problems.length ? "UNAVAILABLE" : afterV.bufferLower >= target ? "GOAL_MET" : "GOAL_NOT_MET"
  check("rescue", "no market outside the scenario held around the reduction", beforeV.problems.length === 0 && afterV.problems.length === 0, [...beforeV.problems, ...afterV.problems].join("; ") || "only the scenario's markets")

  // Compared with what the run recorded, never taken from it.
  const recorded = existsSync(join(dir, "recompute.json")) ? JSON.parse(readFileSync(join(dir, "recompute.json"), "utf8")) : null
  if (recorded) {
    check("rescue", "the run's recomputation has the same fills", recorded.fill.filled === filled.toString(), { recorded: recorded.fill.filled, chain: filled })
    check("rescue", "the run's recomputation has the same scenario buffer", recorded.actual?.scenario?.buffer === afterV.buffer.toString(), { recorded: recorded.actual?.scenario?.buffer, chain: afterV.buffer })
    check("rescue", "the run's recomputation reaches the same goal", recorded.goal.state === goal, { recorded: recorded.goal.state, chain: goal })
  }
  return { ...result, tx: tx.hash, block: R, request: tx.request, filled, fills: tx.fills, scenario: { id: scenario.id, reference: scenario.reference, prices, target: scenario.targetBuffer, perLegBound: scenario.numericBound.perLegRawUnits }, before: beforeV, after: afterV, goal, recorded: recorded ? { goal: recorded.goal, buffer: recorded.actual?.scenario?.buffer, baselineBuffer: recorded.baseline?.scenario?.buffer, forecastBuffer: recorded.planned?.scenario?.buffer } : null }
}

// The bank's arithmetic, written out again (math.ts states it; this does not import it):
// PnL floors, funding owed ceils (signed), notional floors, MM ceils on the floored
// notional. Funding uses the pool's own projected index at that block; the prices and
// risk rates are the ones the scenario froze.
async function valueAt(client: Client, s: Scenario, account: Address, block: bigint): Promise<Valuation> {
  const at = { blockNumber: block }
  const state = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [account], ...at })) as { unlockedCollateralBalance: bigint; lockedCollateral: bigint; activePerpPools: readonly Address[] }
  const problems = state.activePerpPools.filter((p) => !s.markets.some((m) => same(m.pool, p))).map((p) => `position or order in ${p}, outside the scenario`)
  const floorDiv = (a: bigint, b: bigint) => (a % b !== 0n && a < 0n ? a / b - 1n : a / b)
  const ceilSigned = (a: bigint, b: bigint) => (a % b !== 0n && a > 0n ? a / b + 1n : a / b)
  const legs: Valuation["legs"] = []
  for (const m of s.markets) {
    const [pos, snap] = await Promise.all([
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [account, m.pool as Address], ...at }) as Promise<{ size: bigint; avgEntryPrice: bigint; entryFundingIndex: bigint }>,
      client.readContract({ address: m.pool as Address, abi: perpPoolAbi, functionName: "tryGetHealthSnapshot", ...at }) as Promise<readonly [boolean, { projectedCumulativeFunding: bigint }]>,
    ])
    if (pos.size === 0n) continue
    const oneBase = BigInt(m.oneBase)
    const price = BigInt(m.scenarioPrice)
    const fundingOwed = ceilSigned(pos.size * (snap[1].projectedCumulativeFunding - pos.entryFundingIndex), 10n ** 18n * oneBase)
    const pnl = floorDiv((price - pos.avgEntryPrice) * pos.size, oneBase)
    const notional = ((pos.size < 0n ? -pos.size : pos.size) * price) / oneBase
    const mmRaw = notional * BigInt(m.risk.maintenanceMarginBps)
    const mm = mmRaw === 0n ? 0n : (mmRaw - 1n) / 10_000n + 1n
    legs.push({ symbol: m.symbol, size: pos.size, avgEntryPrice: pos.avgEntryPrice, fundingOwed, price, pnl, mm })
  }
  const eRisk = state.unlockedCollateralBalance + legs.reduce((x, l) => x + l.pnl - l.fundingOwed, 0n)
  const mm = legs.reduce((x, l) => x + l.mm, 0n)
  const bound = 2n * BigInt(s.numericBound.perLegRawUnits) * BigInt(legs.length)
  return { block, unlocked: state.unlockedCollateralBalance, locked: state.lockedCollateral, legs, eRisk, mm, buffer: eRisk - mm, bufferLower: eRisk - mm - bound, bufferUpper: eRisk - mm + bound, problems }
}

const usd = (raw: bigint | string | null | undefined, digits = 4) => {
  if (raw === null || raw === undefined) return "—"
  const v = BigInt(raw)
  const a = v < 0n ? -v : v
  const s = `${a / 10n ** 18n}.${(a % 10n ** 18n).toString().padStart(18, "0").slice(0, digits)}`
  return v < 0n ? `−${s}` : s
}

function render(r: any): string {
  const lines: string[] = []
  const p = (s = "") => lines.push(s)
  p("Margin Rescue: independent verification of a live run (read-only)")
  p(`  account        ${r.account}`)
  p(`  plan SHA-256   ${r.planDigest}`)
  p(`  end block      ${r.endBlock.number} ${r.endBlock.hash}`)
  p(`  run            blocks ${r.window.firstBlock}–${r.window.lastBlock} (state before: block ${r.window.before})`)
  if (r.guard) p(`  guard          ${r.guard.address}, runtime ${r.guard.runtimeKeccak}`)
  p()
  p("  n   step                         block       status   fee STT     transaction")
  for (const t of r.transactions) p(`  ${String(t.n).padEnd(3)} ${t.id.padEnd(28)} ${String(t.block ?? "—").padEnd(11)} ${String(t.status ?? t.ledgerState).padEnd(8)} ${usd(t.fee, 6).padEnd(11)} ${t.hash}`)
  const fills = r.transactions.flatMap((t: TxReport) => t.fills.map((f) => ({ t, f })))
  if (fills.length) {
    p()
    p("  fills of the account's own IOC orders")
    for (const { t, f } of fills) p(`    ${t.id.padEnd(26)} ${f.isBid ? "buy " : "sell"} ${String(f.quantity).padStart(18)} @ ${usd(f.price, 2)} (limit ${usd(f.limit, 2)})`)
  }
  p()
  const res = r.rescue
  if (res.tx) {
    p(`  rescue         ${res.tx} (block ${res.block}): filled ${res.filled} of ${res.request?.quantity}`)
    for (const x of res.scenario.prices) p(`    ${x.symbol}: mark ${usd(x.referenceMark, 2)} at block ${res.scenario.reference.blockNumber} (chain: ${usd(x.markOnChain, 2)}), shock ${x.shockBps} bps → fixed price ${usd(x.scenarioPrice, 2)}`)
    p(`    buffer at the fixed prices: ${usd(res.before.buffer)} at block ${res.before.block} → ${usd(res.after.buffer)} at block ${res.after.block}; target ${usd(res.scenario.target)}`)
    p(`    goal ${res.goal}${res.recorded ? ` (the run recorded ${res.recorded.goal.state} with buffer ${usd(res.recorded.buffer)})` : ""}`)
  } else p(`  rescue         ${res.note}`)
  p()
  const s = r.reconciliation.stt
  const u = r.reconciliation.usdso
  p(`  STT            ${usd(s.before, 6)} → ${usd(s.after, 6)}: spent ${usd(s.spent, 6)}; receipt fees ${usd(s.receiptFees, 6)}; cap ${usd(s.cap, 2)}`)
  p(`  USDso          ${usd(u.before)} → ${usd(u.after)}: deposited ${usd(u.deposited)}, withdrawn ${usd(u.withdrawn)}, result ${usd(u.result)}`)
  p(`                 result = realized ${usd(u.realizedPnl)} − funding ${usd(u.funding)} − fees ${usd(u.fees)}; the fills alone imply ${usd(u.fillImpliedPnl)}`)
  p()
  for (const c of r.checks) p(`  ${c.ok ? "ok  " : "FAIL"} [${c.group}] ${c.name}${c.ok ? "" : `: ${c.detail}`}`)
  p()
  const v = r.verdict
  p(`VERDICT: ${v.allChecksHold ? "ALL CHECKS HOLD" : "CHECKS FAILED"}. Transactions ${v.transactionsVerified ? "verified" : "NOT verified"}; reduction ${v.reductionFilled ? "filled" : "not filled"}; goal ${v.goal}; cleanup ${v.cleanupVerified ? "verified" : "NOT verified"}; gas and collateral ${v.reconciled ? "reconciled" : "NOT reconciled"}.`)
  return lines.join("\n") + "\n"
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
