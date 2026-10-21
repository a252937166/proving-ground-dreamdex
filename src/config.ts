// Network configuration. Defaults are the Hideki v2 endpoints that ship with
// @somnia-chain/markets-sdk 0.32.1; environment variables may override them.
// This prototype never reads a private key and never signs anything.
import { readFileSync } from "node:fs"
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk"
import { defineChain, hidekiTestnet } from "@somnia-chain/markets-sdk/chains"

export const EXPECTED_CHAIN_ID = 50383
export const DEFAULT_INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql"

export interface NetworkConfig {
  chainId: number
  rpcUrl: string
  wsUrl: string
  indexerUrl: string
  baseSymbol: string
  quoteSymbol: string
  bookDepth: number
}

try {
  process.loadEnvFile(".env")
} catch {
  // .env is optional
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const depth = Number(env.BOOK_DEPTH ?? 20)
  if (!Number.isInteger(depth) || depth < 1 || depth > 100) throw new Error(`BOOK_DEPTH must be an integer in 1..100, got ${env.BOOK_DEPTH}`)
  return {
    chainId: EXPECTED_CHAIN_ID,
    rpcUrl: env.HIDEKI_RPC_URL || hidekiTestnet.rpcUrls.default.http[0],
    wsUrl: env.HIDEKI_WS_URL || hidekiTestnet.rpcUrls.default.webSocket![0],
    indexerUrl: env.DREAMDEX_INDEXER_URL || DEFAULT_INDEXER_URL,
    baseSymbol: "BTC",
    quoteSymbol: "USDso",
    bookDepth: depth,
  }
}

export function createMarkets(cfg: NetworkConfig): SomniaMarkets {
  const chain = defineChain({
    ...hidekiTestnet,
    rpcUrls: { default: { http: [cfg.rpcUrl], webSocket: [cfg.wsUrl] } },
  })
  return new SomniaMarkets({ chain, indexerUrl: cfg.indexerUrl, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES })
}

export function sdkVersion(): string {
  const url = new URL("../node_modules/@somnia-chain/markets-sdk/package.json", import.meta.url)
  return JSON.parse(readFileSync(url, "utf8")).version
}
