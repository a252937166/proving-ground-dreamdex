// SYNTHETIC fixtures for the Margin Rescue unit tests. Every price, size, rate and
// balance here is invented; none is a market quote or live evidence.
import type { Address } from "viem"
import { FUNDING_PRECISION } from "../../src/margin-rescue/math.js"
import type { AccountSnapshot, Level, OrderRow, PoolInfo } from "../../src/margin-rescue/snapshot.js"
import { reconcile } from "../../src/margin-rescue/reconcile.js"
import { accountFigures } from "../../src/margin-rescue/math.js"
import { snapshotLegs } from "../../src/margin-rescue/reconcile.js"

export const BANK = "0x00000000000000000000000000000000000b4a2c" as Address
export const ACCOUNT = "0x000000000000000000000000000000000000a11c" as Address
export const POOL = {
  BTC: "0x0000000000000000000000000000000000000b7c" as Address,
  ETH: "0x0000000000000000000000000000000000000e7f" as Address,
  SOL: "0x0000000000000000000000000000000000000501" as Address,
}

export interface FixtureMarket {
  symbol: keyof typeof POOL
  decimals: number
  mark: bigint
  mmBps: bigint
  imfBps?: bigint
  cmBps?: bigint
  tick?: bigint
  lot?: bigint
  minQuantity?: bigint
  takerFeeBpsTimes1k?: bigint
  cumulativeFunding?: bigint
  bids?: Level[]
  asks?: Level[]
}

export interface FixturePosition {
  symbol: keyof typeof POOL
  size: bigint
  entry: bigint
  // Funding owed to produce, as a raw amount; converted to an entry index for the leg.
  fundingOwed?: bigint
}

export interface FixtureAccount {
  unlocked: bigint
  locked?: bigint
  markets: FixtureMarket[]
  positions: FixturePosition[]
  orders?: (Pick<OrderRow, "isBid" | "price" | "quantityRemaining"> & { orderId?: bigint; symbol: keyof typeof POOL })[]
  problems?: string[]
}

export function fixtureSnapshot(f: FixtureAccount): AccountSnapshot {
  const pools: PoolInfo[] = f.markets.map((m) => {
    const oneBase = 10n ** BigInt(m.decimals)
    return {
      pool: POOL[m.symbol],
      symbol: m.symbol,
      baseToken: POOL[m.symbol],
      baseDecimals: m.decimals,
      oneBase,
      marginBank: BANK,
      registered: true,
      restricted: false,
      marketStatus: 0,
      priceable: true,
      markPrice: m.mark,
      projectedCumulativeFunding: m.cumulativeFunding ?? 0n,
      effectiveImfBps: m.imfBps ?? m.mmBps * 2n,
      maintenanceMarginBps: m.mmBps,
      closeOutMarginBps: m.cmBps ?? m.mmBps / 2n,
      params: {
        initialMarginBps: m.imfBps ?? m.mmBps * 2n,
        maintenanceMarginBps: m.mmBps,
        closeOutMarginBps: m.cmBps ?? m.mmBps / 2n,
        maxOpenInterest: 10n ** 30n,
        maxPositionSize: 10n ** 30n,
        takerFeeBpsTimes1k: m.takerFeeBpsTimes1k ?? 0n,
        makerFeeBpsTimes1k: 0n,
        insuranceFundShareBps: 0n,
      },
      grid: { tickSize: m.tick ?? 1n, minQuantity: m.minQuantity ?? 1n, lotSize: m.lot ?? 1n },
      stopRegistry: null,
    }
  })
  const positions = f.positions.map((p) => {
    const info = pools.find((x) => x.symbol === p.symbol)!
    // fundingOwed = ceil(size × (cum − entryIndex) / (1e18 × oneBase)); choose the
    // entry index so the quotient is exact.
    const owed = p.fundingOwed ?? 0n
    const entryFundingIndex = info.projectedCumulativeFunding - (owed * FUNDING_PRECISION * info.oneBase) / p.size
    return { pool: info.pool, size: p.size, avgEntryPrice: p.entry, entryFundingIndex, lastUpdatedTimestampNs: 0n }
  })
  const orders: OrderRow[] = (f.orders ?? []).map((o, i) => ({
    pool: POOL[o.symbol],
    orderId: o.orderId ?? BigInt(i + 1),
    isBid: o.isBid,
    price: o.price,
    fullQuantity: o.quantityRemaining,
    quantityRemaining: o.quantityRemaining,
    expireTimestampNs: 10n ** 19n,
    userData: 0n,
    expired: false,
  }))
  const snapshot: AccountSnapshot = {
    version: "mr-account-snapshot/1",
    chainId: 50383,
    block: { number: 1_000n, hash: "0x00000000000000000000000000000000000000000000000000000000000f1a7e", timestamp: 1_700_000_000n },
    canonical: { ok: true, observedHash: "0x00000000000000000000000000000000000000000000000000000000000f1a7e", checkedAt: "fixture" },
    readStartedAt: "fixture",
    account: ACCOUNT,
    marginBank: BANK,
    collateralToken: BANK,
    factory: BANK,
    system: { fullyWired: true, liquidationEngine: BANK },
    coverage: { factoryPools: pools.map((p) => p.pool), activePools: pools.map((p) => p.pool), nonzeroOutsideActive: [], pendingOutsideActive: [] },
    pools,
    collateral: { unlocked: f.unlocked, locked: f.locked ?? 0n, collateralBasis: 0n },
    bank: { equity: 0n, imReq: 0n, mmReq: 0n, cmReq: 0n, marginStatus: 0, tryEquityOk: true, tryEquity: 0n },
    positions,
    orders,
    capacities: pools.map((p) => {
      const size = positions.find((x) => x.pool === p.pool)?.size ?? 0n
      return { pool: p.pool, positionSize: size, pendingBidQuantity: 0n, pendingAskQuantity: 0n, pendingOppositeQuantity: 0n, effectiveReducingCapacity: size < 0n ? -size : size }
    }),
    stops: { source: "indexer-listed, chain-checked", rows: [], error: null },
    accountMode: { isolated: false, creditFloor: 0n, fundingPayer: "0x0000000000000000000000000000000000000000", mainFundedPrincipal: 0n },
    wallet: { usdso: 0n, allowanceToBank: 0n },
    books: f.markets.map((m) => ({ pool: POOL[m.symbol], bids: m.bids ?? [], asks: m.asks ?? [] })),
    problems: f.problems ?? [],
  }
  // The fixture's "bank" answers exactly what the deployment formulas give, so the
  // reconciliation is EXACT by construction. Live reconciliation is tested elsewhere.
  const fig = accountFigures(snapshot.collateral.unlocked, snapshot.collateral.locked, snapshotLegs(snapshot))
  const basis = f.unlocked + (f.locked ?? 0n)
  snapshot.collateral.collateralBasis = basis > 0n ? basis : 0n
  snapshot.bank = { equity: fig.eRisk, imReq: fig.im, mmReq: fig.mm, cmReq: fig.cm, marginStatus: 0, tryEquityOk: true, tryEquity: fig.eRisk }
  return snapshot
}

export function fixtureReconciliation(s: AccountSnapshot) {
  return reconcile(s)
}
