// One account, read completely at one block.
//
// Every contract read is pinned to the sampled block hash. The pool set comes from
// the bank (activePerpPools) and is cross-checked against EVERY pool the factory has
// deployed: a nonzero position or a resting order outside the bank's list makes the
// snapshot incomplete. The indexer is used only to list TP/SL stops, which have no
// on-chain enumeration; each listed stop is then checked live at the pinned block.
import type { Address, PublicClient } from "viem"
import { erc20Abi, marginBankAbi, perpPoolAbi, perpPoolFactoryAbi, perpStopRegistryAbi } from "./abi.js"
import { assertHideki, checkCanonical, mapLimit, readAt, sampleBlock, type BlockRef, type CanonicalCheck } from "./rpc.js"

export const SNAPSHOT_VERSION = "mr-account-snapshot/1"
export const MAX_ORDERS_PER_POOL = 500

export interface Level {
  price: bigint
  quantity: bigint
}

export interface PoolInfo {
  pool: Address
  symbol: string
  baseToken: Address
  baseDecimals: number
  oneBase: bigint
  marginBank: Address
  registered: boolean
  restricted: boolean
  marketStatus: number
  priceable: boolean
  markPrice: bigint
  projectedCumulativeFunding: bigint
  effectiveImfBps: bigint
  maintenanceMarginBps: bigint
  closeOutMarginBps: bigint
  params: {
    initialMarginBps: bigint
    maintenanceMarginBps: bigint
    closeOutMarginBps: bigint
    maxOpenInterest: bigint
    maxPositionSize: bigint
    takerFeeBpsTimes1k: bigint
    makerFeeBpsTimes1k: bigint
    insuranceFundShareBps: bigint
  }
  grid: { tickSize: bigint; minQuantity: bigint; lotSize: bigint }
  stopRegistry: Address | null
}

export interface PositionRow {
  pool: Address
  size: bigint
  avgEntryPrice: bigint
  entryFundingIndex: bigint
  lastUpdatedTimestampNs: bigint
}

export interface OrderRow {
  pool: Address
  orderId: bigint
  isBid: boolean
  price: bigint
  fullQuantity: bigint
  quantityRemaining: bigint
  expireTimestampNs: bigint
  userData: bigint
  expired: boolean
}

export interface CapacityRow {
  pool: Address
  positionSize: bigint
  pendingBidQuantity: bigint
  pendingAskQuantity: bigint
  pendingOppositeQuantity: bigint
  effectiveReducingCapacity: bigint
}

export interface StopRow {
  registry: Address
  pool: Address | null
  orderId: bigint
  indexedStatus: string
  liveAtBlock: boolean
  isBid: boolean
  quantity: bigint
  triggerPrice: bigint
  triggerOperator: number
  orderType: number
  intent: number | null
  somiPaid: bigint
}

export interface StopListing {
  source: "indexer-listed, chain-checked" | "not listed"
  rows: StopRow[]
  error: string | null
  pages?: number
  indexedThrough?: bigint | null
}

export type StopLister = (account: Address) => Promise<{ rows: { registry: string; orderIdRaw: string; status: string }[]; pages: number; indexedThrough: bigint | null }>

export interface AccountSnapshot {
  version: typeof SNAPSHOT_VERSION
  chainId: number
  block: BlockRef
  canonical: CanonicalCheck
  readStartedAt: string
  account: Address
  marginBank: Address
  collateralToken: Address
  factory: Address
  system: { fullyWired: boolean; liquidationEngine: Address }
  coverage: {
    factoryPools: Address[]
    activePools: Address[]
    nonzeroOutsideActive: Address[]
    pendingOutsideActive: Address[]
  }
  pools: PoolInfo[]
  collateral: { unlocked: bigint; locked: bigint; collateralBasis: bigint }
  bank: { equity: bigint; imReq: bigint; mmReq: bigint; cmReq: bigint; marginStatus: number; tryEquityOk: boolean; tryEquity: bigint }
  positions: PositionRow[]
  orders: OrderRow[]
  capacities: CapacityRow[]
  stops: StopListing
  accountMode: { isolated: boolean; creditFloor: bigint; fundingPayer: Address; mainFundedPrincipal: bigint }
  wallet: { usdso: bigint; allowanceToBank: bigint }
  books: { pool: Address; bids: Level[]; asks: Level[] }[]
  problems: string[]
}

export interface SnapshotOptions {
  marginBank: Address
  account: Address
  blockNumber?: bigint
  bookPools?: Address[] // pools whose book to read (in addition to nothing else)
  bookDepth?: number
  listStops?: StopLister
  concurrency?: number
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function readAccountSnapshot(client: PublicClient, opts: SnapshotOptions): Promise<AccountSnapshot> {
  await assertHideki(client)
  const readStartedAt = new Date().toISOString()
  const block = await sampleBlock(client, opts.blockNumber)
  const limit = opts.concurrency ?? 8
  const at = <T>(address: Address, abi: Parameters<typeof readAt>[2]["abi"], functionName: string, args: readonly unknown[] = [], from?: Address) =>
    readAt<T>(client, block, { address, abi, functionName, args, from })
  const bankCall = <T>(fn: string, args: readonly unknown[] = []) => at<T>(opts.marginBank, marginBankAbi, fn, args)
  const problems: string[] = []

  type SystemConfig = { collateralToken: Address; perpPoolFactory: Address; liquidationEngine: Address; fullyWired: boolean; marginBank: Address }
  const system = await bankCall<SystemConfig>("getSystemConfig")
  if (!sameAddress(system.marginBank, opts.marginBank)) problems.push(`bank reports itself as ${system.marginBank}`)
  if (!system.fullyWired) problems.push("MarginBank reports fullyWired = false")

  const factoryPools = await at<readonly Address[]>(system.perpPoolFactory, perpPoolFactoryAbi, "getPerpPools")
  type State = { unlockedCollateralBalance: bigint; lockedCollateral: bigint; activePerpPools: readonly Address[] }
  const state = await bankCall<State>("getAccountState", [opts.account])
  const activePools = [...state.activePerpPools]

  // Completeness: every factory pool, active or not, for position and resting orders.
  type Cap = { positionSize: bigint; pendingBidQuantity: bigint; pendingAskQuantity: bigint; pendingOppositeQuantity: bigint; effectiveReducingCapacity: bigint }
  type Pos = { size: bigint; avgEntryPrice: bigint; entryFundingIndex: bigint; lastUpdatedTimestampNs: bigint }
  const perPool = await mapLimit(factoryPools, limit, async (pool) => {
    const [pos, cap] = await Promise.all([
      bankCall<Pos>("getPosition", [opts.account, pool]),
      at<Cap>(pool, perpPoolAbi, "getReducingCapacity", [opts.account]),
    ])
    return { pool, pos, cap }
  })
  const isActive = (p: Address) => activePools.some((a) => sameAddress(a, p))
  const nonzeroOutsideActive = perPool.filter((r) => !isActive(r.pool) && r.pos.size !== 0n).map((r) => r.pool)
  const pendingOutsideActive = perPool.filter((r) => !isActive(r.pool) && r.cap.pendingBidQuantity + r.cap.pendingAskQuantity > 0n).map((r) => r.pool)
  if (nonzeroOutsideActive.length) problems.push(`positions outside the bank's active list: ${nonzeroOutsideActive.join(", ")}`)
  if (pendingOutsideActive.length) problems.push(`resting orders outside the bank's active list: ${pendingOutsideActive.join(", ")}`)
  for (const a of activePools) if (!factoryPools.some((p) => sameAddress(p, a))) problems.push(`active pool ${a} is not a factory pool`)

  const infoPools = unique([...activePools, ...(opts.bookPools ?? [])])
  const pools = await mapLimit(infoPools, limit, (pool) => readPoolInfo(pool, at, system.perpPoolFactory, opts.marginBank, problems))

  const positions: PositionRow[] = perPool
    .filter((r) => r.pos.size !== 0n)
    .map((r) => ({ pool: r.pool, size: r.pos.size, avgEntryPrice: r.pos.avgEntryPrice, entryFundingIndex: r.pos.entryFundingIndex, lastUpdatedTimestampNs: r.pos.lastUpdatedTimestampNs }))
  const capacities: CapacityRow[] = perPool
    .filter((r) => isActive(r.pool))
    .map((r) => ({ pool: r.pool, ...r.cap }))

  for (const p of pools) if (isActive(p.pool) && !p.priceable) problems.push(`no fresh mark for active market ${p.symbol} (${p.pool})`)

  // Resting orders: the pool answers getOwnOpenOrders for msg.sender, so the call is
  // made "from" the account (an eth_call, nothing is signed).
  const nowNs = block.timestamp * 1_000_000_000n
  const orders: OrderRow[] = []
  await mapLimit(activePools, limit, async (pool) => {
    const ids = await at<readonly bigint[]>(pool, perpPoolAbi, "getOwnOpenOrders", [], opts.account)
    if (ids.length > MAX_ORDERS_PER_POOL) {
      problems.push(`${ids.length} resting orders in ${pool}; more than ${MAX_ORDERS_PER_POOL} are not enumerated`)
      return
    }
    type Ord = { orderId: bigint; isBid: boolean; owner: Address; userData: bigint; price: bigint; fullQuantity: bigint; quantityRemaining: bigint; expireTimestampNs: bigint }
    const rows = await mapLimit(ids, limit, (id) => at<Ord>(pool, perpPoolAbi, "getOrder", [id]))
    for (const o of rows) {
      if (!sameAddress(o.owner, opts.account)) problems.push(`order ${o.orderId} in ${pool} belongs to ${o.owner}`)
      orders.push({ pool, orderId: o.orderId, isBid: o.isBid, price: o.price, fullQuantity: o.fullQuantity, quantityRemaining: o.quantityRemaining, expireTimestampNs: o.expireTimestampNs, userData: o.userData, expired: o.expireTimestampNs < nowNs })
    }
  })
  orders.sort((a, b) => (a.pool === b.pool ? Number(a.orderId - b.orderId) : a.pool.localeCompare(b.pool)))
  for (const c of capacities) {
    const bids = orders.filter((o) => sameAddress(o.pool, c.pool) && o.isBid).reduce((s, o) => s + o.quantityRemaining, 0n)
    const asks = orders.filter((o) => sameAddress(o.pool, c.pool) && !o.isBid).reduce((s, o) => s + o.quantityRemaining, 0n)
    if (bids !== c.pendingBidQuantity || asks !== c.pendingAskQuantity) {
      problems.push(`resting orders in ${c.pool} do not add up to the pool's pending quantities (bids ${bids}/${c.pendingBidQuantity}, asks ${asks}/${c.pendingAskQuantity})`)
    }
  }

  type Health = readonly [bigint, bigint, bigint, bigint]
  const [health, marginStatus, tryEquity, collateralBasis, isolated, creditFloor, fundingPayer, mainFundedPrincipal, usdso, allowanceToBank] = await Promise.all([
    bankCall<Health>("getAccountHealth", [opts.account]).catch((e) => {
      problems.push(`getAccountHealth reverted: ${shortError(e)}`)
      return [0n, 0n, 0n, 0n] as const
    }),
    bankCall<number>("getMarginStatus", [opts.account]).catch(() => -1),
    bankCall<readonly [boolean, bigint]>("tryGetAccountEquity", [opts.account]),
    bankCall<bigint>("getCollateralBasis", [opts.account]),
    bankCall<boolean>("isolated", [opts.account]),
    bankCall<bigint>("getCreditFloor", [opts.account]),
    bankCall<Address>("quoteFundingPayer", [opts.account]),
    bankCall<bigint>("getMainFundedPrincipal", [opts.account]),
    at<bigint>(system.collateralToken, erc20Abi, "balanceOf", [opts.account]),
    at<bigint>(system.collateralToken, erc20Abi, "allowance", [opts.account, opts.marginBank]),
  ])

  const books = await mapLimit(opts.bookPools ?? [], limit, async (pool) => {
    const depth = BigInt(opts.bookDepth ?? 30)
    const [bids, asks] = await Promise.all([
      at<readonly Level[]>(pool, perpPoolAbi, "getBookLevels", [true, depth]),
      at<readonly Level[]>(pool, perpPoolAbi, "getBookLevels", [false, depth]),
    ])
    return { pool, bids: bids.map((l) => ({ price: l.price, quantity: l.quantity })), asks: asks.map((l) => ({ price: l.price, quantity: l.quantity })) }
  })

  const stops = await listStops(opts, pools, at, block)
  if (stops.error) problems.push(`stops not listed: ${stops.error}`)

  const canonical = await checkCanonical(client, block)
  if (!canonical.ok) problems.push(`block ${block.number} hash ${block.hash} is no longer canonical (now ${canonical.observedHash})`)

  return {
    version: SNAPSHOT_VERSION,
    chainId: 50383,
    block,
    canonical,
    readStartedAt,
    account: opts.account,
    marginBank: opts.marginBank,
    collateralToken: system.collateralToken,
    factory: system.perpPoolFactory,
    system: { fullyWired: system.fullyWired, liquidationEngine: system.liquidationEngine },
    coverage: { factoryPools: [...factoryPools], activePools, nonzeroOutsideActive, pendingOutsideActive },
    pools,
    collateral: { unlocked: state.unlockedCollateralBalance, locked: state.lockedCollateral, collateralBasis },
    bank: { equity: health[0], imReq: health[1], mmReq: health[2], cmReq: health[3], marginStatus, tryEquityOk: tryEquity[0], tryEquity: tryEquity[1] },
    positions,
    orders,
    capacities,
    stops,
    accountMode: { isolated, creditFloor, fundingPayer, mainFundedPrincipal },
    wallet: { usdso, allowanceToBank },
    books,
    problems,
  }
}

export type At = <T>(address: Address, abi: Parameters<typeof readAt>[2]["abi"], functionName: string, args?: readonly unknown[], from?: Address) => Promise<T>

async function readPoolInfo(pool: Address, at: At, factory: Address, bank: Address, problems: string[]): Promise<PoolInfo> {
  type Snap = readonly [boolean, { oneBase: bigint; markPrice: bigint; projectedCumulativeFunding: bigint; effectiveIMFBps: bigint; maintenanceMarginBps: bigint; closeOutMarginBps: bigint }]
  const [snap, params, grid, restricted, marketStatus, poolBank, baseToken, registered, stopRegistry] = await Promise.all([
    at<Snap>(pool, perpPoolAbi, "tryGetHealthSnapshot"),
    at<PoolInfo["params"]>(pool, perpPoolAbi, "getPerpPoolParameters"),
    at<PoolInfo["grid"]>(pool, perpPoolAbi, "getOrderBookParameters"),
    at<boolean>(pool, perpPoolAbi, "isRestricted"),
    at<number>(pool, perpPoolAbi, "getMarketStatus"),
    at<Address>(pool, perpPoolAbi, "marginBank"),
    at<Address>(factory, perpPoolFactoryAbi, "getBaseTokenForPool", [pool]),
    at<boolean>(bank, marginBankAbi, "isPerpPoolRegistered", [pool]),
    at<Address>(factory, perpPoolFactoryAbi, "getStopOrderRegistry", [pool]).catch(() => ZERO),
  ])
  const [symbol, decimals] = await Promise.all([at<string>(baseToken, erc20Abi, "symbol"), at<number>(baseToken, erc20Abi, "decimals")])
  const [ok, s] = snap
  const oneBase = 10n ** BigInt(decimals)
  if (ok && s.oneBase !== oneBase) problems.push(`${symbol}: oneBase ${s.oneBase} differs from 10^decimals ${oneBase}`)
  if (!sameAddress(poolBank, bank)) problems.push(`${symbol}: pool names bank ${poolBank}`)
  if (!registered) problems.push(`${symbol}: pool is not registered in the bank`)
  return {
    pool,
    symbol,
    baseToken,
    baseDecimals: decimals,
    oneBase: ok ? s.oneBase : oneBase,
    marginBank: poolBank,
    registered,
    restricted,
    marketStatus,
    priceable: ok,
    markPrice: ok ? s.markPrice : 0n,
    projectedCumulativeFunding: ok ? s.projectedCumulativeFunding : 0n,
    effectiveImfBps: ok ? s.effectiveIMFBps : 0n,
    maintenanceMarginBps: ok ? s.maintenanceMarginBps : params.maintenanceMarginBps,
    closeOutMarginBps: ok ? s.closeOutMarginBps : params.closeOutMarginBps,
    params: { ...params },
    grid: { ...grid },
    stopRegistry: stopRegistry === ZERO ? null : stopRegistry,
  }
}

export async function listStops(opts: Pick<SnapshotOptions, "account" | "listStops">, pools: PoolInfo[], at: At, block: BlockRef): Promise<StopListing> {
  if (!opts.listStops) return { source: "not listed", rows: [], error: "no stop lister configured" }
  let listed: Awaited<ReturnType<StopLister>>
  try {
    listed = await opts.listStops(opts.account)
  } catch (e) {
    return { source: "not listed", rows: [], error: shortError(e) }
  }
  const { pages, indexedThrough } = listed
  if (indexedThrough === null) return { source: "not listed", rows: [], error: "the indexer did not report its processed height", pages, indexedThrough }
  if (indexedThrough < block.number) {
    return { source: "not listed", rows: [], error: `the indexer has processed only through block ${indexedThrough}, before the pinned block ${block.number}; stops created in between could be missing`, pages, indexedThrough }
  }
  type Pending = readonly [boolean, { orderWithTrigger: { order: { isBid: boolean; owner: Address; quantity: bigint }; orderType: number; triggerPrice: bigint; triggerOperator: number }; somiPaid: bigint; intent: number }]
  const rows = await mapLimit(listed.rows, 4, async (s) => {
    const registry = s.registry as Address
    const [live, o] = await at<Pending>(registry, perpStopRegistryAbi, "getPendingOrder", [BigInt(s.orderIdRaw)])
    const pool = pools.find((p) => p.stopRegistry && sameAddress(p.stopRegistry, registry))?.pool ?? null
    return {
      registry,
      pool,
      orderId: BigInt(s.orderIdRaw),
      indexedStatus: s.status,
      liveAtBlock: live && sameAddress(o.orderWithTrigger.order.owner, opts.account),
      isBid: o.orderWithTrigger.order.isBid,
      quantity: o.orderWithTrigger.order.quantity,
      triggerPrice: o.orderWithTrigger.triggerPrice,
      triggerOperator: o.orderWithTrigger.triggerOperator,
      orderType: o.orderWithTrigger.orderType,
      intent: o.intent,
      somiPaid: o.somiPaid,
    }
  })
  return { source: "indexer-listed, chain-checked", rows, error: null, pages, indexedThrough }
}

function unique(addresses: Address[]): Address[] {
  const seen = new Set<string>()
  return addresses.filter((a) => (seen.has(a.toLowerCase()) ? false : (seen.add(a.toLowerCase()), true)))
}

export function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string }
  return (err?.shortMessage ?? err?.message ?? String(e)).split("\n")[0].slice(0, 200)
}

export function poolOf(snapshot: AccountSnapshot, pool: string): PoolInfo {
  const p = snapshot.pools.find((x) => sameAddress(x.pool, pool))
  if (!p) throw new Error(`pool ${pool} is not in the snapshot`)
  return p
}

export { sameAddress }
