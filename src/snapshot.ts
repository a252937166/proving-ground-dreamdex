// Read-only BTC-PERP snapshot from dreamDEX through @somnia-chain/markets-sdk.
// Every value comes from the live indexer or chain; nothing here is mocked.
import type { SomniaMarkets } from "@somnia-chain/markets-sdk"
import { parseAbi, type Address } from "viem"
import { BLITZ, bandEdges, type MarketRules } from "./rules.js"
import { bpsDiff } from "./units.js"
import { sdkVersion, type NetworkConfig } from "./config.js"

const poolAbi = parseAbi([
  "function tryGetMarkPrice() view returns (bool ok, uint256 price)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
])

export interface Level {
  price: bigint
  quantity: bigint
}

export interface Snapshot {
  queriedAt: string
  elapsedMs: number
  chainId: number
  sdk: { package: string; version: string }
  endpoints: { rpcUrl: string; wsUrl: string; indexerUrl: string }
  market: {
    symbol: string
    poolAddress: Address
    marginBank: Address
    stopRegistry: Address
    baseToken: Address
    quoteToken: Address
    baseDecimals: number
    quoteDecimals: number
    tickSize: bigint
    lotSize: bigint
    minQuantity: bigint
    onchainBookParamsMatchIndexer: boolean
    risk: {
      initialMarginBps: bigint
      maintenanceMarginBps: bigint
      closeOutMarginBps: bigint
      maxOpenInterest: bigint
      maxPositionSize: bigint
      takerFeeBpsTimes1k: bigint
      makerFeeBpsTimes1k: bigint
    }
    lastTradePrice: bigint | null
    lastTradeAt: number | null
  }
  // Order book and mark are read at the same block (bookBlockKnown: true).
  block: { number: bigint; timestamp: number; isoTime: string; bookBlockKnown: boolean }
  book: { bids: Level[]; asks: Level[]; depth: number }
  mark: { price: bigint; ok: boolean }
  // getPerpState is read at the latest block when the call runs.
  state: {
    markPrice: bigint
    indexPrice: bigint
    indexUpdatedAt: number
    fundingRate: bigint // 1e18-scaled fraction per funding window
    fundingWindowSec: number
    nextFundingAt: number
    openInterest: bigint
  }
  derived: {
    bestBid: Level | null
    bestAsk: Level | null
    mid: bigint | null
    spread: bigint | null
    spreadBps: number | null
    markVsMidBps: number | null
    band: { bps: number; low: bigint; high: bigint }
    bestAskWithinBand: boolean | null
    bestBidWithinBand: boolean | null
    askQtyWithinBand: bigint
    bidQtyWithinBand: bigint
  }
}

export function marketRules(s: Snapshot): MarketRules {
  return {
    tickSize: s.market.tickSize,
    lotSize: s.market.lotSize,
    minQuantity: s.market.minQuantity,
    baseDecimals: s.market.baseDecimals,
    maxPositionSize: s.market.risk.maxPositionSize,
    takerFeeBpsTimes1k: s.market.risk.takerFeeBpsTimes1k,
  }
}

// Pure: derived top-of-book and band figures from raw levels.
export function deriveBook(bids: Level[], asks: Level[], mark: bigint, tickSize: bigint): Snapshot["derived"] {
  const bestBid = bids[0] ?? null
  const bestAsk = asks[0] ?? null
  const mid = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2n : null
  const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null
  const band = bandEdges(mark, tickSize, BLITZ.priceBandBps)
  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps: mid && spread !== null ? Number((spread * 1_000_000n) / mid) / 100 : null,
    markVsMidBps: mid ? bpsDiff(mark, mid) : null,
    band: { bps: Number(BLITZ.priceBandBps), ...band },
    bestAskWithinBand: bestAsk ? bestAsk.price <= band.high : null,
    bestBidWithinBand: bestBid ? bestBid.price >= band.low : null,
    askQtyWithinBand: asks.filter((l) => l.price <= band.high).reduce((a, l) => a + l.quantity, 0n),
    bidQtyWithinBand: bids.filter((l) => l.price >= band.low).reduce((a, l) => a + l.quantity, 0n),
  }
}

export async function readSnapshot(markets: SomniaMarkets, cfg: NetworkConfig): Promise<Snapshot> {
  const started = Date.now()
  const queriedAt = new Date(started).toISOString()
  const client = markets.client
  const viem = client.getViemClient()

  const chainId = await viem.getChainId()
  if (chainId !== cfg.chainId) throw new Error(`connected to chain ${chainId}, expected ${cfg.chainId}`)

  // Market discovery and configuration (indexer).
  const rows = await client.listPerpMarkets({ baseSymbol: cfg.baseSymbol, quoteSymbol: cfg.quoteSymbol })
  const perps = rows.filter((r) => r.marketType === "PERP")
  if (perps.length !== 1) throw new Error(`expected exactly one ${cfg.baseSymbol}/${cfg.quoteSymbol} perp market, found ${perps.length}`)
  const row = perps[0]
  if (row.chainId !== undefined && Number(row.chainId) !== cfg.chainId) throw new Error(`indexer row is for chain ${row.chainId}`)
  const pool = row.poolAddress as Address

  // Order book (chain), then the mark price and book parameters at that same block.
  const book = await client.getSpotOrderBook(pool, { depth: cfg.bookDepth })
  // The SDK reports the block it read the book at; if it ever does not, fall back
  // to the head block and say so in the output.
  const bookBlockKnown = book.blockNumber !== undefined
  const blockNumber = book.blockNumber ?? (await viem.getBlockNumber())
  const [markRead, bookParams, block, risk, state] = await Promise.all([
    viem.readContract({ address: pool, abi: poolAbi, functionName: "tryGetMarkPrice", blockNumber }),
    viem.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters", blockNumber }),
    viem.getBlock({ blockNumber }),
    client.getPerpRiskParams(pool),
    client.getPerpState(pool),
  ])
  const [markOk, markPrice] = markRead

  const tickSize = BigInt(row.tickSize)
  const lotSize = BigInt(row.lotSize)
  const minQuantity = BigInt(row.minQuantity)
  const bids = book.bids.map((l) => ({ price: l.price, quantity: l.quantity }))
  const asks = book.asks.map((l) => ({ price: l.price, quantity: l.quantity }))
  const timestamp = Number(block.timestamp)

  return {
    queriedAt,
    elapsedMs: Date.now() - started,
    chainId,
    sdk: { package: "@somnia-chain/markets-sdk", version: sdkVersion() },
    endpoints: { rpcUrl: cfg.rpcUrl, wsUrl: cfg.wsUrl, indexerUrl: cfg.indexerUrl },
    market: {
      symbol: `${row.baseSymbol}-PERP`,
      poolAddress: pool,
      marginBank: row.marginBank as Address,
      stopRegistry: row.stopRegistry as Address,
      baseToken: row.baseToken as Address,
      quoteToken: row.quoteToken as Address,
      baseDecimals: row.baseDecimals,
      quoteDecimals: row.quoteDecimals,
      tickSize,
      lotSize,
      minQuantity,
      onchainBookParamsMatchIndexer:
        bookParams.tickSize === tickSize && bookParams.lotSize === lotSize && bookParams.minQuantity === minQuantity,
      risk: {
        initialMarginBps: risk.initialMarginBps,
        maintenanceMarginBps: risk.maintenanceMarginBps,
        closeOutMarginBps: risk.closeOutMarginBps,
        maxOpenInterest: risk.maxOpenInterest,
        maxPositionSize: risk.maxPositionSize,
        takerFeeBpsTimes1k: risk.takerFeeBpsTimes1k,
        makerFeeBpsTimes1k: risk.makerFeeBpsTimes1k,
      },
      lastTradePrice: row.lastPrice ? BigInt(row.lastPrice) : null,
      lastTradeAt: row.lastTradeAt ? Number(row.lastTradeAt) : null,
    },
    block: { number: blockNumber, timestamp, isoTime: new Date(timestamp * 1000).toISOString(), bookBlockKnown },
    book: { bids, asks, depth: cfg.bookDepth },
    mark: { price: markPrice, ok: markOk },
    state: {
      markPrice: state.markPrice,
      indexPrice: state.indexPrice,
      indexUpdatedAt: Number(state.indexUpdatedAt),
      fundingRate: state.fundingRate,
      fundingWindowSec: state.fundingWindowSec,
      nextFundingAt: Number(state.nextFundingAt),
      openInterest: state.openInterest,
    },
    derived: deriveBook(bids, asks, markPrice, tickSize),
  }
}

// JSON with bigints as decimal strings, so evidence files stay exact.
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
}
