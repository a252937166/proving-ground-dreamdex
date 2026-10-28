// Independent read-back of one live run. Read-only: it never signs or sends, never reads
// a key, and does not use the executor's code (action ids, snapshots, recomputation and
// the accounting are written out again here from the contracts' own rules).
//
// From the run's files it takes only what identifies the run and what was fixed before
// execution: the plan (its SHA-256 must be the run's plan digest), the transaction hashes
// in run-ledger.json, the journalled confirmations and the scenario. Every one of those is
// checked against the chain, never trusted:
//   1. every transaction and its canonical receipt: sender, nonce, destination, calldata
//      hash, value, status, fee; the call decoded; its fills and bank rows
//   2. every guarded action bound to its journalled confirmation: the saved request field
//      by field against the calldata the chain executed, the action id recomputed with the
//      contract's encoding and domain and asked from the deployed guard itself, the
//      guard's event, the order's userData, the fills, and `used` before and after
//   3. the account's nonce before and after: no other transaction was sent from it
//   4. the guard's code against the plan's approved runtime hash
//   5. the end state at ONE block: no position or resting order in any factory pool, no
//      live TP/SL stop, every grant the run made revoked, the bank account empty, the
//      allowance zero, no bank row or USDso transfer for the account outside the run
//   6. gas: STT before − after = Σ receipt fees; collateral: USDso before − after =
//      deposited − withdrawn, and withdrawn − deposited = Σ realized − Σ funding − Σ fees
//   7. the scenario, read again at its reference block for the plan's approved pools:
//      base token, decimals and oneBase, mark, maintenance margin; the BTC and ETH shocks
//      applied once, to those pools; the model and its numerical bound (derived here, not
//      read from the file). Then the account valued at those fixed absolute prices just
//      before the reduction's block and at it.
// The report is bound to the exact run: chain, account, plan digest, transaction set,
// scenario and the SHA-256 of the evidence files it read (runBinding).
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BaseError, decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, toBytes, toEventSelector, TransactionNotFoundError, type Abi, type Address, type Hex, type Log, type PublicClient } from "viem"
import { erc20Abi, marginBankAbi, marginBankEventsAbi, marginBankWriteAbi, operatorRegistryAbi, orderBookEventsAbi, perpPoolAbi, perpPoolFactoryAbi, perpStopRegistryAbi, PLACE_ORDER_FOR_SELECTOR, reduceGuardAbi } from "./abi.js"
import { MARGIN_BANK, OPERATOR_REGISTRY, readBigJson, USDSO } from "./common.js"
import { describeEndpoint } from "./endpoints.js"
import { sanitizeText } from "./publication.js"
import { canonicalJson, sha256Hex } from "./json.js"
import type { StopLister } from "./snapshot.js"

export const VERIFY_VERSION = "mr-live-verify/2"

// ReduceOnlyGuard.sol, actionIdOf: keccak256(abi.encode(REDUCE_TYPEHASH, block.chainid,
// address(this), MARGIN_BANK, OWNER, pool, expectedSignedSize, isBid, quantity,
// limitPrice, deadline, ORDER_TYPE_IOC, nonce)).
const REDUCE_ACTION_TYPE =
  "ReduceAction(uint256 chainId,address guard,address marginBank,address owner,address pool,int128 expectedSignedSize,bool isBid,uint256 quantity,uint256 limitPrice,uint64 deadline,uint8 orderType,bytes32 nonce)"
const ORDER_TYPE_IOC = 2
const guardViews = parseAbi(["function REDUCE_TYPEHASH() view returns (bytes32)", "function CHAIN_ID() view returns (uint256)", "function ORDER_TYPE_IOC() view returns (uint8)"])

// The models this verifier can value, with the numerical bound each one has. mr-model/1
// is the bank's own integer arithmetic (PnL floored, funding ceiled, requirements ceiled
// on the floored notional per leg), verified to the raw unit on every holder: bound 0.
export const SUPPORTED_MODELS: Record<string, bigint> = { "mr-model/1 (static shock; pnl floor, funding ceil, requirements ceil per leg)": 0n }

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])
const EVENTS = [...orderBookEventsAbi, ...marginBankEventsAbi, ...reduceGuardAbi, ...transferAbi] as unknown as Abi
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const asText = (detail: unknown) => (typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
// One line for a failed read: viem's summary and, when it has them, the node's own words.
const short = (e: unknown) => {
  const text = e instanceof BaseError ? [...new Set([e.shortMessage, e.details].filter(Boolean))].join(": ") : String((e as Error)?.message ?? e)
  return text.split("\n")[0].slice(0, 200)
}

export type Group = "run" | "transactions" | "confirmations" | "guard" | "cleanup" | "reconciliation" | "scenario" | "rescue"

export interface Check {
  group: Group
  name: string
  ok: boolean
  detail: string
}

export interface Fill {
  pool: Address
  isBid: boolean
  quantity: bigint
  price: bigint
  limit: bigint | null
}

export interface Request {
  pool: Address
  expectedSignedSize: bigint
  isBid: boolean
  quantity: bigint
  limitPrice: bigint
  deadline: bigint
  nonce: Hex
}

export interface TxReport {
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
  input: Hex | null
  call: string
  gasUsed: bigint | null
  effectiveGasPrice: bigint | null
  fee: bigint
  fills: Fill[]
  takerOrders: { orderId: bigint; pool: Address; isBid: boolean; userData: bigint }[]
  bank: { name: string; pool: Address | null; amount?: bigint; newSize?: bigint; realizedPnl?: bigint; payment?: bigint }[]
  guardEvent: { actionId: Hex; pool: Address; orderId: bigint; sizeBefore: bigint; sizeAfter: bigint; quantity: bigint; limitPrice: bigint } | null
  request: Request | null
  problems: { name: string; detail: string }[]
}

export interface GuardReport {
  address: Address
  deployTx: Hex | null
  deployBlock: bigint | null
  runtimeKeccak: Hex | null
  approvedRuntimeKeccak: string
  owner: Address
  marginBank: Address
  trustedPools: Address[]
}

export interface Valuation {
  block: bigint
  unlocked: bigint
  locked: bigint
  legs: { symbol: string; size: bigint; avgEntryPrice: bigint; fundingOwed: bigint; price: bigint; pnl: bigint; mm: bigint }[]
  eRisk: bigint
  mm: bigint
  buffer: bigint
  bufferLower: bigint
  problems: string[]
}

export interface Indexer {
  watermark: () => Promise<bigint | null>
  listStops: StopLister
}

export interface VerifyOptions {
  dir: string // the run folder (private or published)
  plan: string // the plan file the run was started under
  client: PublicClient
  indexer: Indexer
  rpc: string // for the report, shown only if it is a public endpoint
  block?: bigint // the end-state block; default min(latest, indexer watermark)
  // The SHA-256 of the plan the owner approved, taken from outside the run's files (the
  // approval, or the authorized plan committed before the run): the run's own files can
  // name any plan, so only this anchors the scenario's shocks and target.
  approvedDigest: string
}

// The evidence a verification is bound to: the files it read, by SHA-256 (absent: null).
export const BOUND_FILES = ["run-ledger.json", "run-state.json", "result.json", "scenario.json", "candidates.json", "refresh-analysis.json", "preflight-snapshot.json", "post-snapshot.json", "receipt.json", "recompute.json", "cleanup.json", "guard.json"]

export interface RunBinding {
  chainId: number
  account: string
  planDigest: string
  transactions: string[]
  scenarioId: string | null
  files: Record<string, string | null>
}

// Each file is hashed as it is published (publication.ts sanitizeText: local paths and
// non-public URLs replaced), so the binding holds for the published copy and never carries
// the hash of a redacted original; a file without either is hashed as it is.
export function runBinding(dir: string): RunBinding {
  const ledger = JSON.parse(readFileSync(join(dir, "run-ledger.json"), "utf8")) as { chainId: number | string; account: string; planDigest: string; steps: { hash: string }[] }
  const files: Record<string, string | null> = {}
  const hash = (path: string) => sha256Hex(sanitizeText(readFileSync(path, "utf8")).text)
  for (const f of BOUND_FILES) files[f] = existsSync(join(dir, f)) ? hash(join(dir, f)) : null
  const journal = join(dir, "journal")
  if (existsSync(journal)) for (const f of readdirSync(journal).filter((n) => n.endsWith(".json")).sort()) files[`journal/${f}`] = hash(join(journal, f))
  const scenario = files["scenario.json"] ? (JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as { id?: string }) : null
  return { chainId: Number(ledger.chainId), account: ledger.account, planDigest: ledger.planDigest, transactions: ledger.steps.map((s) => s.hash.toLowerCase()), scenarioId: scenario?.id ?? null, files }
}

export function contractActionId(chainId: bigint, guard: Address, marginBank: Address, owner: Address, r: Request): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, uint256, address, address, address, address, int128, bool, uint256, uint256, uint64, uint8, bytes32"), [
      keccak256(toBytes(REDUCE_ACTION_TYPE)),
      chainId,
      guard,
      marginBank,
      owner,
      r.pool,
      r.expectedSignedSize,
      r.isBid,
      r.quantity,
      r.limitPrice,
      r.deadline,
      ORDER_TYPE_IOC,
      r.nonce,
    ]),
  )
}

type Step = { n: number; id: string; phase: string; to: Address | null; dataKeccak: Hex; nonce: number; hash: Hex; state: string; actionId?: Hex; receipt?: { fee: bigint } }
type JournalRecord = {
  actionId: Hex
  kind?: string
  binding: { chainId: number; guard: Address; marginBank: Address; owner: Address }
  scenarioId: string
  candidateId: string
  request: { pool: Address; expectedSignedSize: string; isBid: boolean; quantity: string; limitPrice: string; deadline: string; nonce: Hex }
  calldata: Hex
  quote: { blockNumber: string; blockHash: Hex }
  tx: { state: string; hash?: Hex; nonce?: number }
}

export async function verifyRun(o: VerifyOptions) {
  const { dir, client } = o
  const checks: Check[] = []
  const check = (group: Group, name: string, ok: boolean, detail: unknown = "") => {
    checks.push({ group, name, ok, detail: asText(detail) })
    return ok
  }
  // A section whose chain reads fail cannot be verified: that is a failed check, not a pass.
  const section = async (group: Group, name: string, f: () => Promise<void>) => {
    try {
      await f()
    } catch (e) {
      check(group, `${name}: could not be read back`, false, short(e))
    }
  }

  check("run", "chain 50383", (await client.getChainId()) === 50383)
  const planBytes = readFileSync(o.plan)
  const planDigest = sha256Hex(planBytes)
  const plan = JSON.parse(planBytes.toString("utf8"))
  const ledger = readBigJson<{ planDigest: string; account: Address; chainId: bigint; startNonce: bigint; steps: Step[] }>(join(dir, "run-ledger.json"))
  const state = JSON.parse(readFileSync(join(dir, "run-state.json"), "utf8")) as { planDigest: string; account: Address; guard: Address | null; rescueActionId: Hex | null }
  const journal = new Map<string, JournalRecord>()
  if (existsSync(join(dir, "journal"))) for (const f of readdirSync(join(dir, "journal")).filter((n) => n.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(join(dir, "journal", f), "utf8")) as JournalRecord
    journal.set(r.actionId.toLowerCase(), r)
  }
  const account = ledger.account
  const guard = state.guard
  const startNonce = Number(ledger.startNonce)
  const pools: Address[] = plan.guard.constructorArgs.pools
  const markets: { symbol: string; pool: Address }[] = plan.markets
  const binding = runBinding(dir)
  check("run", "the plan file is the one the run was started under", planDigest === ledger.planDigest && planDigest === state.planDigest, { planFile: planDigest, ledger: ledger.planDigest, state: state.planDigest })
  check("run", "the plan is the one approved before the run", planDigest === o.approvedDigest.toLowerCase(), { plan: planDigest, approved: o.approvedDigest })
  check("run", "chain, account and approved pools as the plan states", plan.network?.chainId === 50383 && Number(ledger.chainId) === 50383 && same(plan.account?.address, account) && same(state.account, account) && pools.length === markets.length && markets.every((m) => pools.some((p) => same(p, m.pool))), { plan: plan.account?.address, ledger: account, pools })

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
  for (const t of mined) if (t.phase === "cleanup" && same(t.to, guard) && t.request) closes.set(t.request.pool.toLowerCase(), (closes.get(t.request.pool.toLowerCase()) ?? 0) + 1)
  check("transactions", "at most 3 guarded closes per leg", [...closes.values()].every((n) => n <= 3), Object.fromEntries(closes))
  const toPool = txs.filter((t) => t.phase === "cleanup" && pools.some((p) => same(p, t.to)))
  check("transactions", "every cleanup order went through the guard", toPool.length === 0, toPool.map((t) => t.id).join(", ") || "none sent straight to a pool")
  for (const [id, planned] of [["open-BTC-long", plan.bounds.openingQuantities.btc], ["open-ETH-short", plan.bounds.openingQuantities.eth]] as const) {
    const t = mined.find((x) => x.id === id)
    if (!t) continue
    const filled = t.fills.reduce((s, f) => s + f.quantity, 0n)
    check("transactions", `${id}: filled no more than the planned quantity`, filled > 0n && filled <= BigInt(planned), `${filled} of ${planned}`)
  }

  // ---- 2. every guarded action bound to its confirmation ----
  let guardDomain: { owner: Address; bank: Address; chainId: bigint; typehash: Hex; orderType: number } | null = null
  if (guard) {
    await section("confirmations", "the guard's domain", async () => {
      const lastBlock = mined.reduce((m, t) => (t.block! > m ? t.block! : m), mined[0].block!)
      const read = <T>(abi: Abi, fn: string) => client.readContract({ address: guard, abi, functionName: fn as never, blockNumber: lastBlock }) as Promise<T>
      const [owner, bank, chainId, typehash, orderType] = await Promise.all([read<Address>(reduceGuardAbi as unknown as Abi, "OWNER"), read<Address>(reduceGuardAbi as unknown as Abi, "MARGIN_BANK"), read<bigint>(guardViews, "CHAIN_ID"), read<Hex>(guardViews, "REDUCE_TYPEHASH"), read<number>(guardViews, "ORDER_TYPE_IOC")])
      guardDomain = { owner, bank, chainId, typehash, orderType }
      check("confirmations", "the deployed guard's action-id domain is the one recomputed here", same(owner, account) && same(bank, MARGIN_BANK) && chainId === 50383n && typehash === keccak256(toBytes(REDUCE_ACTION_TYPE)) && orderType === ORDER_TYPE_IOC, guardDomain)
    })
  }
  const guardTxs = mined.filter((t) => same(t.to, guard))
  const bound: Record<string, string> = {}
  for (const t of guardTxs) {
    await section("confirmations", `${t.id}`, async () => {
      const step = ledger.steps.find((s) => same(s.hash, t.hash))!
      const record = [...journal.values()].find((r) => same(r.tx?.hash, t.hash)) ?? (step.actionId ? journal.get(step.actionId.toLowerCase()) : undefined)
      if (!check("confirmations", `${t.id}: a journalled confirmation exists`, !!record, step.actionId ?? "no action id in the ledger")) return
      const r = record!
      const d = t.request!
      const saved: Request = { pool: r.request.pool, expectedSignedSize: BigInt(r.request.expectedSignedSize), isBid: r.request.isBid, quantity: BigInt(r.request.quantity), limitPrice: BigInt(r.request.limitPrice), deadline: BigInt(r.request.deadline), nonce: r.request.nonce }
      const fields = (["pool", "expectedSignedSize", "isBid", "quantity", "limitPrice", "deadline", "nonce"] as const).filter((k) => String(saved[k]).toLowerCase() !== String(d[k]).toLowerCase())
      check("confirmations", `${t.id}: the saved request is the calldata the chain executed, field by field`, fields.length === 0, fields.length ? `differs in ${fields.join(", ")}` : "pool, expected position, side, quantity, limit, deadline and nonce")
      check("confirmations", `${t.id}: the saved calldata is the transaction's`, same(r.calldata, t.input), r.calldata.slice(0, 18))
      check("confirmations", `${t.id}: the saved domain is this chain, guard, bank and owner`, r.binding.chainId === 50383 && same(r.binding.guard, guard) && same(r.binding.marginBank, MARGIN_BANK) && same(r.binding.owner, account), r.binding)
      const recomputed = contractActionId(50383n, guard!, MARGIN_BANK, account, saved)
      check("confirmations", `${t.id}: the action id recomputed from the saved request is the saved one`, recomputed === r.actionId.toLowerCase(), { recomputed, saved: r.actionId })
      const onChain = (await client.readContract({ address: guard!, abi: reduceGuardAbi, functionName: "actionIdOf", args: [d], blockNumber: t.block! })) as Hex
      check("confirmations", `${t.id}: the guard's own actionIdOf(executed request) is the saved action id`, same(onChain, r.actionId), { guard: onChain, saved: r.actionId })
      check("confirmations", `${t.id}: the ledger names the same action`, !step.actionId || same(step.actionId, r.actionId), step.actionId)
      check("confirmations", `${t.id}: the journal records this transaction`, same(r.tx.hash, t.hash) && (r.tx.nonce === undefined || r.tx.nonce === t.nonce), r.tx)
      const [usedBefore, usedAfter] = await Promise.all([
        client.readContract({ address: guard!, abi: reduceGuardAbi, functionName: "used", args: [r.actionId], blockNumber: t.block! - 1n }),
        client.readContract({ address: guard!, abi: reduceGuardAbi, functionName: "used", args: [r.actionId], blockNumber: t.block! }),
      ])
      if (t.status === "success") {
        const g = t.guardEvent
        const taker = t.takerOrders.find((x) => g && x.orderId === g.orderId)
        const filled = t.fills.reduce((s, f) => s + f.quantity, 0n)
        const position = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [account, d.pool], blockNumber: t.block! })) as { size: bigint }
        check("confirmations", `${t.id}: the guard's event is this action and request`, !!g && same(g.actionId, r.actionId) && same(g.pool, d.pool) && g.quantity === d.quantity && g.limitPrice === d.limitPrice && g.sizeBefore === d.expectedSignedSize, g)
        check("confirmations", `${t.id}: the venue order is the owner's, on the requested side, tagged with the action id`, !!taker && taker.isBid === d.isBid && same(taker.pool, d.pool) && taker.userData === BigInt(r.actionId) % 2n ** 64n, taker)
        check("confirmations", `${t.id}: the fills are that order's, on its side, inside its limit, and move the position by exactly their sum`, !!g && filled > 0n && filled <= d.quantity && filled === (g.sizeBefore > 0n ? g.sizeBefore - g.sizeAfter : g.sizeAfter - g.sizeBefore) && t.fills.every((f) => f.isBid === d.isBid && same(f.pool, d.pool) && (d.isBid ? f.price <= d.limitPrice : f.price >= d.limitPrice)) && position.size === g.sizeAfter, { filled, guardEvent: g, positionAfter: position.size })
        check("confirmations", `${t.id}: the guard marked the action used in this block, not before`, !usedBefore && usedAfter === true, { before: usedBefore, after: usedAfter })
      } else check("confirmations", `${t.id}: a reverted action left nothing marked used`, !usedAfter, { before: usedBefore, after: usedAfter })
      bound[t.hash] = r.actionId
    })
  }

  // ---- 3. nonces; the end block ----
  const firstBlock = mined.reduce((m, t) => (t.block! < m ? t.block! : m), mined[0].block!)
  const lastBlock = mined.reduce((m, t) => (t.block! > m ? t.block! : m), mined[0].block!)
  const before = firstBlock - 1n
  const latest = await client.getBlockNumber()
  const indexed = await o.indexer.watermark()
  const B = o.block ?? (indexed !== null && indexed < latest ? indexed : latest)
  if (B < lastBlock) throw new Error(`end block ${B} is before the run's last transaction (block ${lastBlock}); the indexer is behind, try again shortly`)
  const endBlock = await client.getBlock({ blockNumber: B })
  const nonces = mined.map((t) => t.nonce!).sort((a, b) => a - b)
  const [nonceBefore, nonceAfter] = await Promise.all([client.getTransactionCount({ address: account, blockNumber: before }), client.getTransactionCount({ address: account, blockNumber: B })])
  check("transactions", "no other transaction from the account", nonceBefore === startNonce && nonceAfter === startNonce + mined.length && nonces.every((n, i) => n === startNonce + i), { before: nonceBefore, startNonce, mined: mined.length, after: nonceAfter })

  // ---- 4. the guard ----
  const at = { blockNumber: B }
  const found: { guard: GuardReport | null } = { guard: null } // set inside the section below
  if (guard) {
    await section("guard", "the guard", async () => {
      const code = await client.getCode({ address: guard, ...at })
      const read = <T>(fn: string, args: readonly unknown[] = []) => client.readContract({ address: guard, abi: reduceGuardAbi, functionName: fn as never, args: args as never, ...at }) as Promise<T>
      const [owner, bank, trusted] = await Promise.all([read<Address>("OWNER"), read<Address>("MARGIN_BANK"), Promise.all(pools.map((p) => read<boolean>("trustedPool", [p])))])
      const runtime = code ? keccak256(code) : null
      const deploy = mined.find((t) => t.to === null)
      found.guard = { address: guard, deployTx: deploy?.hash ?? null, deployBlock: deploy?.block ?? null, runtimeKeccak: runtime, approvedRuntimeKeccak: plan.guard.expectedRuntimeKeccak, owner, marginBank: bank, trustedPools: pools.filter((_p, i) => trusted[i]) }
      check("guard", "deployed by this run from the approved build", !!deploy && deploy.problems.length === 0, deploy?.hash ?? "no deployment transaction")
      check("guard", "code on chain is the approved runtime", runtime === plan.guard.expectedRuntimeKeccak, { runtime, approved: plan.guard.expectedRuntimeKeccak })
      check("guard", "OWNER, MARGIN_BANK and trusted pools as approved", same(owner, account) && same(bank, MARGIN_BANK) && trusted.every(Boolean), { owner, bank, trusted })
    })
  }

  // ---- 5. the end state at block B ----
  const endState: Record<string, unknown> = {}
  const bankRead = <T>(fn: string, args: readonly unknown[], blockNumber = B) => client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: fn as never, args: args as never, blockNumber }) as Promise<T>
  type BankState = { unlockedCollateralBalance: bigint; lockedCollateral: bigint; activePerpPools: readonly Address[] }
  let balances = { sttBefore: 0n, sttAfter: 0n, usdBefore: 0n, usdAfter: 0n, stateBefore: null as BankState | null }
  await section("cleanup", "the end state", async () => {
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
    balances = { sttBefore, sttAfter, usdBefore, usdAfter, stateBefore }
    const stops = await o.indexer.listStops(account)
    const liveStops = await mapLimit(stops.rows, 4, async (s) => {
      const [live, ord] = (await client.readContract({ address: s.registry as Address, abi: perpStopRegistryAbi, functionName: "getPendingOrder", args: [BigInt(s.orderIdRaw)], ...at })) as readonly [boolean, { orderWithTrigger: { order: { owner: Address } } }]
      return live && same(ord.orderWithTrigger.order.owner, account)
    })
    const external = await outsideActivity(client, account, firstBlock, B, new Set(mined.map((t) => t.hash.toLowerCase())))
    const endBlockAgain = await client.getBlock({ blockNumber: B })
    const open = perPool.filter((p) => p.size !== 0n)
    const resting = perPool.filter((p) => p.pending > 0n || p.orders > 0)
    Object.assign(endState, { pools: factoryPools.length, positions: open, resting, stops: { listed: stops.rows.length, live: liveStops.filter(Boolean).length, indexedThrough: stops.indexedThrough }, bank: accountState, allowance: { bank: allowanceBank, guard: allowanceGuard }, grants: runGrants, globalGrant })
    check("cleanup", "end block still canonical after the reads", endBlockAgain.hash === endBlock.hash, `${B} ${endBlock.hash}`)
    check("cleanup", "no position in any factory pool", open.length === 0, open.map((p) => `${p.pool}:${p.size}`).join(", ") || `${factoryPools.length} pools read at block ${B}`)
    check("cleanup", "no resting order in any factory pool", resting.length === 0, resting.map((p) => p.pool).join(", ") || `${factoryPools.length} pools read`)
    check("cleanup", "no live TP/SL stop", stops.indexedThrough !== null && stops.indexedThrough >= B && liveStops.every((l) => !l), `${stops.rows.length} listed by the indexer (processed through ${stops.indexedThrough}), ${liveStops.filter(Boolean).length} live at block ${B}`)
    check("cleanup", "MarginBank account empty", accountState.unlockedCollateralBalance === 0n && accountState.lockedCollateral === 0n && accountState.activePerpPools.length === 0, { unlocked: accountState.unlockedCollateralBalance, locked: accountState.lockedCollateral, activePools: accountState.activePerpPools.length })
    check("cleanup", "USDso allowance to the bank and to the guard is zero", allowanceBank === 0n && allowanceGuard === 0n, { bank: allowanceBank, guard: allowanceGuard })
    check("cleanup", "every grant the run made is revoked", runGrants.every((g) => !g.stillGranted), runGrants.map((g) => `${g.pool} → ${g.operator}: ${g.stillGranted ? "STILL GRANTED" : "revoked"}`).join("; ") || "the run made no grant")
    check("cleanup", "the guard holds no grant on any pool, nor a global one", perPool.every((p) => !p.granted) && !globalGrant, `${factoryPools.length} pools checked; global ${globalGrant}`)
    check("cleanup", "no bank row or USDso transfer for the account outside the run", external.length === 0, external.join("; ") || `blocks ${firstBlock}–${B}`)
  })

  // ---- 6. gas and collateral ----
  const rows = mined.flatMap((t) => t.bank)
  const total = (name: string, pick: (b: TxReport["bank"][number]) => bigint | undefined) => rows.filter((b) => b.name === name).reduce((s, b) => s + (pick(b) ?? 0n), 0n)
  const fees = mined.reduce((s, t) => s + t.fee, 0n)
  const deposited = total("Deposited", (b) => b.amount)
  const withdrawn = total("Withdrawn", (b) => b.amount)
  const realized = total("PositionUpdated", (b) => b.realizedPnl)
  const funding = total("FundingSettled", (b) => b.payment)
  const tradingFees = total("FeeCharged", (b) => b.amount)
  const fills = mined.flatMap((t) => t.fills)
  const oneBaseOf = (pool: Address) => BigInt(plan.markets.find((m: { pool: string }) => same(m.pool, pool)).oneBase)
  const fillPnl = pools.reduce((s, pool) => s + fills.filter((f) => same(f.pool, pool)).reduce((x, f) => x + (f.isBid ? -1n : 1n) * f.quantity * f.price, 0n) / oneBaseOf(pool), 0n)
  const flat = pools.every((pool) => fills.filter((f) => same(f.pool, pool)).reduce((x, f) => x + (f.isBid ? f.quantity : -f.quantity), 0n) === 0n)
  const gap = realized > fillPnl ? realized - fillPnl : fillPnl - realized
  const { sttBefore, sttAfter, usdBefore, usdAfter, stateBefore } = balances
  check("reconciliation", "STT spent = Σ receipt fees", sttBefore - sttAfter === fees, { before: sttBefore, after: sttAfter, spent: sttBefore - sttAfter, fees })
  check("reconciliation", "STT spent within the plan's 2 STT cap", fees <= BigInt(plan.bounds.gas.sttCap), { fees, cap: plan.bounds.gas.sttCap })
  check("reconciliation", "bank account empty before the run", !!stateBefore && stateBefore.unlockedCollateralBalance === 0n && stateBefore.lockedCollateral === 0n, stateBefore)
  check("reconciliation", "deposit exactly as planned", deposited === BigInt(plan.bounds.maxDepositUsdso), { deposited, planned: plan.bounds.maxDepositUsdso })
  check("reconciliation", "wallet USDso change = deposited − withdrawn", usdBefore - usdAfter === deposited - withdrawn, { before: usdBefore, after: usdAfter, deposited, withdrawn })
  check("reconciliation", "withdrawn − deposited = Σ realized − Σ funding − Σ fees", withdrawn - deposited === realized - funding - tradingFees, { result: withdrawn - deposited, realized, funding, fees: tradingFees })
  check("reconciliation", "every leg opened was closed (fills net to zero)", flat, fills.map((f) => `${f.pool.slice(0, 8)} ${f.isBid ? "+" : "-"}${f.quantity}`).join(" "))
  check("reconciliation", "bank realized PnL agrees with the fills (≤ 10 raw units per fill)", gap <= BigInt(fills.length) * 10n, { bank: realized, fills: fillPnl, gap })

  // ---- 7. the scenario and the rescue ----
  let rescue: Awaited<ReturnType<typeof verifyRescue>>
  try {
    rescue = await verifyRescue(client, { dir, plan, planDigest, account, guard, rescueActionId: state.rescueActionId, journal, steps: ledger.steps, txs, pools, check, scenarioOk: () => checks.filter((c) => c.group === "scenario").every((c) => c.ok) })
  } catch (e) {
    check("rescue", "the rescue could not be read back", false, short(e))
    rescue = { actionId: state.rescueActionId, note: "could not be read back", tx: null, block: null, request: null, filled: 0n, fills: [], scenario: null, before: null, after: null, goal: "UNAVAILABLE", recorded: null }
  }

  const groupOk = (g: Group) => checks.filter((c) => c.group === g).every((c) => c.ok)
  return {
    version: VERIFY_VERSION,
    verifiedAt: new Date().toISOString(),
    rpc: describeEndpoint(o.rpc),
    chainId: 50383,
    account,
    planDigest,
    approvedDigest: o.approvedDigest.toLowerCase(),
    binding,
    guard: found.guard,
    endBlock: { number: B, hash: endBlock.hash, timestamp: endBlock.timestamp },
    window: { before, firstBlock, lastBlock },
    transactions: txs,
    confirmations: bound,
    nonces: { before: nonceBefore, after: nonceAfter, mined: mined.length },
    endState,
    reconciliation: {
      stt: { before: sttBefore, after: sttAfter, spent: sttBefore - sttAfter, receiptFees: fees, cap: plan.bounds.gas.sttCap },
      usdso: { before: usdBefore, after: usdAfter, deposited, withdrawn, result: withdrawn - deposited, realizedPnl: realized, funding, fees: tradingFees, fillImpliedPnl: fillPnl },
    },
    rescue,
    checks,
    verdict: {
      allChecksHold: checks.every((c) => c.ok),
      transactionsVerified: groupOk("run") && groupOk("transactions") && groupOk("confirmations") && groupOk("guard"),
      reductionFilled: rescue.filled > 0n,
      goal: rescue.goal,
      scenarioVerified: groupOk("scenario"),
      cleanupVerified: groupOk("cleanup"),
      reconciled: groupOk("reconciliation"),
      rescueVerified: groupOk("rescue"),
    },
  }
}

export type VerificationReport = Awaited<ReturnType<typeof verifyRun>>

async function readTx(client: PublicClient, step: Step, ctx: { account: Address; guard: Address | null; plan: any; pools: Address[]; grantsMade: { pool: Address; operator: Address; selector: Hex }[] }): Promise<TxReport> {
  const { account, guard, plan, pools } = ctx
  const r: TxReport = { n: step.n, id: step.id, phase: step.phase, hash: step.hash, ledgerState: step.state, status: null, block: null, blockHash: null, nonce: null, to: step.to, input: null, call: "", gasUsed: null, effectiveGasPrice: null, fee: 0n, fills: [], takerOrders: [], bank: [], guardEvent: null, request: null, problems: [] }
  const expect = (ok: boolean, name: string, detail: unknown = "") => {
    if (!ok) r.problems.push({ name, detail: asText(detail) })
  }
  // Only the node's answer that it does not know the hash (null, which viem raises as
  // TransactionNotFoundError) is an absence. A failed lookup answers nothing, so it stops
  // the read-back: a NOT_INCLUDED in the ledger is never confirmed by an error
  // (outcome.ts draws the same line for the executor).
  const tx = await client.getTransaction({ hash: step.hash }).catch((e: unknown) => {
    if (e instanceof TransactionNotFoundError) return null
    throw new Error(`tx ${step.n} ${step.id}: looking up ${step.hash} failed (${short(e)}); a failed lookup is not an absence, so the run cannot be verified from this answer`)
  })
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
  r.input = tx.input
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
    expect(a[5] === ORDER_TYPE_IOC, "not an IOC order", a[5])
    limit = a[2]
    side = a[0]
  } else if (same(r.to, guard)) {
    const d = decodeFunctionData({ abi: reduceGuardAbi, data: tx.input })
    const q = (d.args as unknown as [Request])[0]
    r.request = { pool: q.pool, expectedSignedSize: q.expectedSignedSize, isBid: q.isBid, quantity: q.quantity, limitPrice: q.limitPrice, deadline: q.deadline, nonce: q.nonce }
    r.call = `guard.reduce(pool=${q.pool}, expected=${q.expectedSignedSize}, isBid=${q.isBid}, quantity=${q.quantity}, limit=${q.limitPrice}, deadline=${q.deadline})`
    expect(receipt.status !== "success" || block.timestamp <= q.deadline, "included after its deadline", `${block.timestamp} > ${q.deadline}`)
    limit = q.limitPrice
    side = q.isBid
  } else {
    r.call = `call to ${r.to}`
    expect(false, "a destination the plan does not name", r.to)
  }

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
    const o = l.args.placedOrder as { owner: Address; isBid: boolean; userData: bigint } | undefined
    if (l.name === "OrderPlaced" && o && same(o.owner, account)) {
      mine.set(l.args.orderId as bigint, { pool: l.address, isBid: o.isBid })
      r.takerOrders.push({ orderId: l.args.orderId as bigint, pool: l.address, isBid: o.isBid, userData: BigInt(o.userData) })
    }
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
  return r
}

// Bank rows naming the account and USDso transfers to or from it, in [from, to], that no
// transaction of the run explains. Hideki answers at most 1,000 blocks per query.
async function outsideActivity(client: PublicClient, account: Address, from: bigint, to: bigint, runTxs: Set<string>): Promise<string[]> {
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

interface ScenarioFile {
  id: string
  model: string
  chainId: number
  account: string
  reference: { blockNumber: string; blockHash: Hex }
  numericBound: { perLegRawUnits: string }
  markets: { pool: Address; symbol: string; baseDecimals: number; oneBase: string; referenceMark: string; scenarioPrice: string; shockBps: number | null; risk: { maintenanceMarginBps: string } }[]
  targetBuffer: string
}

interface ChainMarket {
  symbol: string
  pool: Address
  decimals: number
  oneBase: bigint
  mark: bigint
  mmBps: bigint
  shockBps: number | null
  price: bigint // the absolute scenario price: mark at the reference block × the plan's shock, once
}

async function verifyRescue(client: PublicClient, ctx: { dir: string; plan: any; planDigest: string; account: Address; guard: Address | null; rescueActionId: Hex | null; journal: Map<string, JournalRecord>; steps: Step[]; txs: TxReport[]; pools: Address[]; check: (group: Group, name: string, ok: boolean, detail?: unknown) => boolean; scenarioOk: () => boolean }) {
  const { dir, plan, planDigest, account, guard, rescueActionId, journal, steps, txs, pools, check, scenarioOk } = ctx
  const result = { actionId: rescueActionId, note: null as string | null, tx: null as Hex | null, block: null as bigint | null, request: null as Request | null, filled: 0n, fills: [] as Fill[], scenario: null as unknown, before: null as Valuation | null, after: null as Valuation | null, goal: "NOT_EVALUATED", recorded: null as unknown }
  if (!rescueActionId) return { ...result, note: "no reduction was confirmed" }
  const record = journal.get(rescueActionId.toLowerCase())
  if (!check("rescue", "the rescue's confirmation is in the journal", !!record, rescueActionId)) return { ...result, note: "the confirmation is missing" }
  const tx = txs.find((t) => same(t.hash, record!.tx?.hash))
  if (!tx || tx.block === null) return { ...result, note: `the confirmed reduction was not mined (journal: ${record!.tx?.state})` }
  const R = tx.block

  // Which transaction is the rescue is read from the chain's order, not taken from the
  // files: the run's first guarded reduction, after its two opening orders.
  const mined = txs.filter((t) => t.block !== null && t.nonce !== null).sort((a, b) => a.nonce! - b.nonce!)
  const firstGuarded = mined.find((t) => same(t.to, guard))
  const step = steps.find((x) => same(x.hash, tx.hash))
  check("rescue", "the rescue is the run's first guarded reduction, journalled as the rescue and sent as the main-phase reduction", !!firstGuarded && same(firstGuarded.hash, tx.hash) && record!.kind === "RESCUE" && step?.phase === "main" && step.id === "reduce", { first: firstGuarded?.hash ?? null, rescue: tx.hash, kind: record!.kind ?? null, step: step ? `${step.phase}/${step.id}` : null })
  const opens = mined.filter((t) => pools.some((p) => same(p, t.to)))
  const lastOpen = opens.at(-1)
  const next = lastOpen ? mined.find((t) => t.nonce === lastOpen.nonce! + 1) : undefined
  if (!existsSync(join(dir, "scenario.json"))) {
    check("scenario", "the scenario file is present", false)
    return { ...result, tx: tx.hash, block: R, note: "no scenario file" }
  }
  const s = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as ScenarioFile
  const { id, ...body } = s as ScenarioFile & Record<string, unknown>
  check("scenario", "the scenario file's id is the hash of its body", sha256Hex(canonicalJson(body)) === id, id)
  check("scenario", "the confirmation was made under this scenario", record!.scenarioId === id, record!.scenarioId)
  check("scenario", "the scenario is for this chain and account", s.chainId === 50383 && same(s.account, account), { chainId: s.chainId, account: s.account })
  check("scenario", "the scenario's target is the plan's", s.targetBuffer === String(plan.scenario.targetBufferUsdso), { scenario: s.targetBuffer, plan: plan.scenario.targetBufferUsdso })
  const bound = SUPPORTED_MODELS[s.model]
  check("scenario", "the scenario's model is one this verifier values exactly", bound !== undefined, s.model)
  check("scenario", "the scenario's numerical bound is the model's (derived here, not taken from the file)", bound !== undefined && String(s.numericBound?.perLegRawUnits) === bound.toString(), { file: s.numericBound?.perLegRawUnits, model: bound?.toString() ?? null })

  // The approved pools as the chain had them at the reference block.
  // The analysis block lies in the run's own window: at or after its last opening order,
  // before its next transaction. The quote it was confirmed on lies between that and the
  // reduction. A scenario taken at any other block, with other marks, does not fit.
  const refBlock = BigInt(s.reference.blockNumber)
  const quoteBlock = BigInt(record!.quote.blockNumber)
  const inWindow = !!lastOpen && !!next && refBlock >= lastOpen.block! && refBlock < next.block! && quoteBlock >= refBlock && quoteBlock < R
  check("scenario", "the scenario's reference block is the run's analysis window (after both opening orders, before the next transaction), and the quote lies between it and the reduction", inWindow, { lastOpening: lastOpen?.block ?? null, nextTransaction: next?.block ?? null, reference: refBlock, quote: quoteBlock, reduction: R })
  if (!inWindow) return { ...result, tx: tx.hash, block: R, request: tx.request, note: "the scenario does not belong to this run", goal: "UNAVAILABLE" }
  const ref = await client.getBlock({ blockNumber: refBlock })
  check("scenario", "the reference block is canonical", ref.hash === s.reference.blockHash, { reference: refBlock, hash: s.reference.blockHash, canonical: ref.hash })

  // The confirmation is a candidate of the run's own analysis, read from the chain at its
  // quote block (the analysis block, or after the grant for a re-confirmation): 25, 50, 75
  // or 100% of the position aligned down to the lot, on the reducing side, at the
  // protective limit of that block's touch (candidates.ts and book.ts, written out again).
  // A cleanup close relabelled as the rescue would need the touch and the deadline of
  // another block to line up by chance.
  const req = tx.request
  if (req) {
    const [grid, levels] = await Promise.all([
      client.readContract({ address: req.pool, abi: perpPoolAbi, functionName: "getOrderBookParameters", blockNumber: quoteBlock }) as Promise<{ tickSize: bigint; lotSize: bigint }>,
      client.readContract({ address: req.pool, abi: perpPoolAbi, functionName: "getBookLevels", args: [!req.isBid, 1n], blockNumber: quoteBlock }) as Promise<readonly { price: bigint }[]>,
    ])
    const size = req.expectedSignedSize < 0n ? -req.expectedSignedSize : req.expectedSignedSize
    const cuts = [25n, 50n, 75n, 100n].map((pct) => ((size * pct) / 100n / grid.lotSize) * grid.lotSize)
    const slip = BigInt(plan.bounds.maxSlippageBpsPerOrder)
    const touch = levels[0]?.price
    const limit = touch === undefined ? null : req.isBid ? ((touch * (10_000n + slip)) / 10_000n / grid.tickSize) * grid.tickSize : (((touch * (10_000n - slip)) / 10_000n + grid.tickSize - 1n) / grid.tickSize) * grid.tickSize
    const quoteFits = quoteBlock === refBlock || (!!next && quoteBlock >= next.block!)
    check("rescue", "the reduction is a candidate cut of the run's analysis at its quote block: a 25/50/75/100% cut on the lot, on the reducing side, at the protective limit of that block's touch", quoteFits && cuts.includes(req.quantity) && req.isBid === req.expectedSignedSize < 0n && limit === req.limitPrice, { quote: quoteBlock, quantity: req.quantity, cuts, limit: req.limitPrice, expectedLimit: limit, touch: touch ?? null })
  }
  const system = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getSystemConfig", blockNumber: refBlock })) as { perpPoolFactory: Address }
  const chain: ChainMarket[] = []
  for (const m of plan.markets as { symbol: string; pool: Address }[]) {
    const base = (await client.readContract({ address: system.perpPoolFactory, abi: perpPoolFactoryAbi, functionName: "getBaseTokenForPool", args: [m.pool], blockNumber: refBlock })) as Address
    const [symbol, decimals, snap] = await Promise.all([
      client.readContract({ address: base, abi: erc20Abi, functionName: "symbol", blockNumber: refBlock }) as Promise<string>,
      client.readContract({ address: base, abi: erc20Abi, functionName: "decimals", blockNumber: refBlock }) as Promise<number>,
      client.readContract({ address: m.pool, abi: perpPoolAbi, functionName: "tryGetHealthSnapshot", blockNumber: refBlock }) as Promise<readonly [boolean, { oneBase: bigint; markPrice: bigint; maintenanceMarginBps: bigint }]>,
    ])
    const shock = (plan.scenario.shocksBps[m.symbol.toUpperCase()] ?? null) as number | null
    check("scenario", `${m.symbol}: the approved pool's base token is ${m.symbol}, with a fresh mark and oneBase = 10^decimals at the reference block`, symbol.toUpperCase() === m.symbol.toUpperCase() && snap[0] && snap[1].oneBase === 10n ** BigInt(decimals), { symbol, decimals, fresh: snap[0], oneBase: snap[1].oneBase })
    chain.push({ symbol: m.symbol.toUpperCase(), pool: m.pool, decimals, oneBase: snap[1].oneBase, mark: snap[1].markPrice, mmBps: snap[1].maintenanceMarginBps, shockBps: shock, price: shock === null ? snap[1].markPrice : (snap[1].markPrice * BigInt(10_000 + shock)) / 10_000n })
  }
  const heldAtRef = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [account], blockNumber: refBlock })) as { activePerpPools: readonly Address[] }
  check("scenario", "the scenario covers exactly the approved pools the account held at the reference block", s.markets.length === chain.length && chain.every((c) => s.markets.some((m) => same(m.pool, c.pool))) && heldAtRef.activePerpPools.every((p) => chain.some((c) => same(c.pool, p))), { scenario: s.markets.map((m) => m.pool), approved: chain.map((c) => c.pool), held: heldAtRef.activePerpPools })
  for (const c of chain) {
    const m = s.markets.find((x) => same(x.pool, c.pool))
    if (!m) continue
    const differs: string[] = []
    if (m.symbol.toUpperCase() !== c.symbol) differs.push(`symbol ${m.symbol}`)
    if (m.baseDecimals !== c.decimals) differs.push(`decimals ${m.baseDecimals}`)
    if (m.oneBase !== c.oneBase.toString()) differs.push(`oneBase ${m.oneBase}`)
    if (m.referenceMark !== c.mark.toString()) differs.push(`reference mark ${m.referenceMark}`)
    if (m.risk?.maintenanceMarginBps !== c.mmBps.toString()) differs.push(`maintenance margin ${m.risk?.maintenanceMarginBps} bps`)
    if (m.shockBps !== c.shockBps) differs.push(`shock ${m.shockBps}`)
    if (m.scenarioPrice !== c.price.toString()) differs.push(`scenario price ${m.scenarioPrice}`)
    check("scenario", `${c.symbol}: pool, units, mark, maintenance margin, shock and absolute price match the chain at the reference block and the plan`, differs.length === 0, differs.length ? `scenario file differs: ${differs.join(", ")}` : { pool: c.pool, oneBase: c.oneBase, mark: c.mark, mmBps: c.mmBps, shockBps: c.shockBps, price: c.price })
  }

  // The reduction as confirmed, sent and filled (bound field by field in section 2).
  const g = tx.guardEvent
  check("rescue", "the reduction succeeded through the guard under the confirmed action id", tx.status === "success" && !!g && same(g.actionId, rescueActionId), g)
  const quote = await client.getBlock({ blockNumber: BigInt(record!.quote.blockNumber) })
  check("rescue", "the deadline is the planned seconds after the analysis block", !!tx.request && tx.request.deadline - quote.timestamp === BigInt(plan.execution.timing.deadlineSeconds), { deadline: tx.request?.deadline, analysisBlockTime: quote.timestamp, plannedSeconds: plan.execution.timing.deadlineSeconds })
  // action.ts rescueNonce, written out again: the executor derives the rescue's nonce from
  // the plan, the scenario and the quote block, and a cleanup close's in another domain,
  // so the chain itself tells the rescue from a close relabelled as one.
  const rescueDomain = keccak256(encodeAbiParameters(parseAbiParameters("string, bytes32, bytes32, bytes32"), ["margin-rescue/rescue", `0x${planDigest}`, `0x${s.id}`, quote.hash]))
  check("rescue", "the reduction carries the rescue nonce of this plan, scenario and quote block (cleanup closes are derived in another domain)", !!tx.request && tx.request.nonce.toLowerCase() === rescueDomain && same(record!.quote.blockHash, quote.hash), { nonce: tx.request?.nonce, expected: rescueDomain, quote: record!.quote })
  const filled = tx.fills.reduce((x, f) => x + f.quantity, 0n)

  // Valued at the fixed absolute prices, with the units and rates read at the reference
  // block, just before the reduction's block and at it; the derived bound, never the file's.
  const [beforeV, afterV] = await Promise.all([valueAt(client, chain, account, R - 1n, bound ?? 0n), valueAt(client, chain, account, R, bound ?? 0n)])
  const target = BigInt(s.targetBuffer)
  const goal = !scenarioOk() || afterV.problems.length || bound === undefined ? "UNAVAILABLE" : afterV.bufferLower >= target ? "GOAL_MET" : "GOAL_NOT_MET"
  check("rescue", "no market outside the scenario held around the reduction", beforeV.problems.length === 0 && afterV.problems.length === 0, [...beforeV.problems, ...afterV.problems].join("; ") || "only the scenario's markets")
  check("rescue", "the goal could be evaluated on a verified scenario", goal !== "UNAVAILABLE", goal)

  const recorded = existsSync(join(dir, "recompute.json")) ? JSON.parse(readFileSync(join(dir, "recompute.json"), "utf8")) : null
  if (recorded) {
    check("rescue", "the run's recomputation has the same fills", recorded.fill?.filled === filled.toString(), { recorded: recorded.fill?.filled, chain: filled })
    check("rescue", "the run's recomputation has the same scenario buffer", recorded.actual?.scenario?.buffer === afterV.buffer.toString(), { recorded: recorded.actual?.scenario?.buffer, chain: afterV.buffer })
    check("rescue", "the run's recomputation reaches the same goal", recorded.goal?.state === goal, { recorded: recorded.goal?.state, chain: goal })
  }
  return { ...result, tx: tx.hash, block: R, request: tx.request, filled, fills: tx.fills, scenario: { id, reference: s.reference, markets: chain, target: s.targetBuffer, perLegBound: (bound ?? 0n).toString() }, before: beforeV, after: afterV, goal, recorded: recorded ? { goal: recorded.goal, buffer: recorded.actual?.scenario?.buffer, baselineBuffer: recorded.baseline?.scenario?.buffer, forecastBuffer: recorded.planned?.scenario?.buffer } : null }
}

// The bank's arithmetic, written out again: PnL floors, funding owed ceils (signed),
// notional floors, MM ceils on the floored notional. Funding uses the pool's own
// projected index at that block; prices and rates are the verified scenario's.
async function valueAt(client: PublicClient, markets: ChainMarket[], account: Address, block: bigint, perLegBound: bigint): Promise<Valuation> {
  const at = { blockNumber: block }
  const state = (await client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getAccountState", args: [account], ...at })) as { unlockedCollateralBalance: bigint; lockedCollateral: bigint; activePerpPools: readonly Address[] }
  const problems = state.activePerpPools.filter((p) => !markets.some((m) => same(m.pool, p))).map((p) => `position or order in ${p}, outside the scenario`)
  const floorDiv = (a: bigint, b: bigint) => (a % b !== 0n && a < 0n ? a / b - 1n : a / b)
  const ceilSigned = (a: bigint, b: bigint) => (a % b !== 0n && a > 0n ? a / b + 1n : a / b)
  const legs: Valuation["legs"] = []
  for (const m of markets) {
    const [pos, snap] = await Promise.all([
      client.readContract({ address: MARGIN_BANK, abi: marginBankAbi, functionName: "getPosition", args: [account, m.pool], ...at }) as Promise<{ size: bigint; avgEntryPrice: bigint; entryFundingIndex: bigint }>,
      client.readContract({ address: m.pool, abi: perpPoolAbi, functionName: "tryGetHealthSnapshot", ...at }) as Promise<readonly [boolean, { projectedCumulativeFunding: bigint }]>,
    ])
    if (pos.size === 0n) continue
    const fundingOwed = ceilSigned(pos.size * (snap[1].projectedCumulativeFunding - pos.entryFundingIndex), 10n ** 18n * m.oneBase)
    const pnl = floorDiv((m.price - pos.avgEntryPrice) * pos.size, m.oneBase)
    const notional = ((pos.size < 0n ? -pos.size : pos.size) * m.price) / m.oneBase
    const mmRaw = notional * m.mmBps
    const mm = mmRaw === 0n ? 0n : (mmRaw - 1n) / 10_000n + 1n
    legs.push({ symbol: m.symbol, size: pos.size, avgEntryPrice: pos.avgEntryPrice, fundingOwed, price: m.price, pnl, mm })
  }
  const eRisk = state.unlockedCollateralBalance + legs.reduce((x, l) => x + l.pnl - l.fundingOwed, 0n)
  const mm = legs.reduce((x, l) => x + l.mm, 0n)
  return { block, unlocked: state.unlockedCollateralBalance, locked: state.lockedCollateral, legs, eRisk, mm, buffer: eRisk - mm, bufferLower: eRisk - mm - 2n * perLegBound * BigInt(legs.length), problems }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

const usd = (raw: bigint | string | null | undefined, digits = 4) => {
  if (raw === null || raw === undefined) return "—"
  const v = BigInt(raw)
  const a = v < 0n ? -v : v
  const s = `${a / 10n ** 18n}.${(a % 10n ** 18n).toString().padStart(18, "0").slice(0, digits)}`
  return v < 0n ? `−${s}` : s
}

export function renderVerification(r: VerificationReport): string {
  const lines: string[] = []
  const p = (s = "") => lines.push(s)
  p("Margin Rescue: independent verification of a live run (read-only)")
  p(`  account        ${r.account}`)
  p(`  plan SHA-256   ${r.planDigest}`)
  p(`  end block      ${r.endBlock.number} ${r.endBlock.hash}`)
  p(`  run            blocks ${r.window.firstBlock}–${r.window.lastBlock} (state before: block ${r.window.before})`)
  p(`  read from      ${r.rpc}`)
  if (r.guard) p(`  guard          ${r.guard.address}, runtime ${r.guard.runtimeKeccak}`)
  p()
  p("  n   step                         block       status   fee STT     transaction")
  for (const t of r.transactions) p(`  ${String(t.n).padEnd(3)} ${t.id.padEnd(28)} ${String(t.block ?? "—").padEnd(11)} ${String(t.status ?? t.ledgerState).padEnd(8)} ${usd(t.fee, 6).padEnd(11)} ${t.hash}`)
  const fills = r.transactions.flatMap((t) => t.fills.map((f) => ({ t, f })))
  if (fills.length) {
    p()
    p("  fills of the account's own IOC orders")
    for (const { t, f } of fills) p(`    ${t.id.padEnd(26)} ${f.isBid ? "buy " : "sell"} ${String(f.quantity).padStart(18)} @ ${usd(f.price, 2)} (limit ${usd(f.limit, 2)})`)
  }
  p()
  const res = r.rescue
  if (res.tx && res.scenario && res.before && res.after) {
    const sc = res.scenario as { reference: { blockNumber: string }; markets: ChainMarket[]; target: string }
    p(`  rescue         ${res.tx} (block ${res.block}): filled ${res.filled} of ${res.request?.quantity}`)
    for (const m of sc.markets) p(`    ${m.symbol}: mark ${usd(m.mark, 2)} at block ${sc.reference.blockNumber}, shock ${m.shockBps ?? 0} bps → fixed price ${usd(m.price, 2)}`)
    p(`    buffer at the fixed prices: ${usd(res.before.buffer)} at block ${res.before.block} → ${usd(res.after.buffer)} at block ${res.after.block}; target ${usd(sc.target)}`)
    p(`    goal ${res.goal}`)
  } else p(`  rescue         ${res.note ?? "not evaluated"}`)
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
  p(`VERDICT: ${v.allChecksHold ? "ALL CHECKS HOLD" : "CHECKS FAILED"}. Transactions ${v.transactionsVerified ? "verified" : "NOT verified"}; scenario ${v.scenarioVerified ? "verified" : "NOT verified"}; reduction ${v.reductionFilled ? "filled" : "not filled"}; goal ${v.goal}; cleanup ${v.cleanupVerified ? "verified" : "NOT verified"}; gas and collateral ${v.reconciled ? "reconciled" : "NOT reconciled"}.`)
  return lines.join("\n") + "\n"
}
