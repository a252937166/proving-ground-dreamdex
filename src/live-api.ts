// The site's live, read-only endpoints: BTC/ETH market snapshots, the account analysis,
// and the Proving Ground page's snapshot and pre-check. The local server answers them over
// HTTP; the static site's in-browser build (src/browser.ts) answers the same paths in the
// visitor's browser. Public reads only: no key, no signing, no transactions.
import { createMarkets, type NetworkConfig } from "./config.js"
import { analyzeAccount, parseAnalyzeInput, type AnalyzeInput } from "./margin-rescue/analyze.js"
import { createHidekiClient } from "./margin-rescue/rpc.js"
import { runPrecheck } from "./order.js"
import { readSnapshot, toJson, type Snapshot } from "./snapshot.js"

const MAX_AGE_MS = 2_000

export interface Answer {
  status: number
  body: string
}

// One network read per key at a time; requests within maxAge share the last result.
function cachedRead<T>(maxAgeMs: number, read: () => Promise<T>): () => Promise<T> {
  let cached: { at: number; value: T } | null = null
  let inflight: Promise<T> | null = null
  return () => {
    if (cached && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.value)
    inflight ??= read()
      .then((value) => {
        cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Answers a live endpoint, or returns null for any other path.
export function createLiveApi(cfg: NetworkConfig): (pathname: string, params: URLSearchParams) => Promise<Answer | null> {
  const markets = createMarkets(cfg)
  const client = createHidekiClient(cfg.rpcUrl)
  const latestSnapshot = cachedRead<Snapshot>(MAX_AGE_MS, () => readSnapshot(markets, cfg))
  const latestEth = cachedRead<Snapshot>(MAX_AGE_MS, () => readSnapshot(markets, { ...cfg, baseSymbol: "ETH" }))

  // Account analyses run one after another (each reads all 21 pools at one block) and a
  // repeated question within 20 s gets the same answer.
  const ANALYSIS_MAX_AGE_MS = 20_000
  const ANALYSIS_TIMEOUT_MS = 90_000
  const analyses = new Map<string, { at: number; value: Promise<unknown> }>()
  let queue: Promise<unknown> = Promise.resolve()
  function analysis(input: AnalyzeInput): Promise<unknown> {
    const key = JSON.stringify({ ...input, account: input.account.toLowerCase() })
    const hit = analyses.get(key)
    if (hit && Date.now() - hit.at < ANALYSIS_MAX_AGE_MS) return hit.value
    // A read that never answers must not hold the queue: give up after ANALYSIS_TIMEOUT_MS.
    const value = queue.then(() =>
      Promise.race([
        analyzeAccount(client, input),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer from the network within ${ANALYSIS_TIMEOUT_MS / 1000} s`)), ANALYSIS_TIMEOUT_MS)),
      ]),
    )
    queue = value.catch(() => undefined)
    analyses.set(key, { at: Date.now(), value })
    value.catch(() => analyses.delete(key))
    for (const [k, v] of analyses) if (Date.now() - v.at > ANALYSIS_MAX_AGE_MS) analyses.delete(k)
    return value
  }

  const answer = (status: number, value: unknown): Answer => ({ status, body: toJson(value) })

  return async (pathname, params) => {
    if (pathname === "/api/markets") {
      try {
        const [btc, eth] = await Promise.all([latestSnapshot(), latestEth()])
        return answer(200, { markets: [btc, eth] })
      } catch (err) {
        return answer(502, { error: `network read failed: ${message(err)}` })
      }
    }

    if (pathname === "/api/analyze") {
      let input: AnalyzeInput
      try {
        input = parseAnalyzeInput(Object.fromEntries(params))
      } catch (err) {
        return answer(400, { error: message(err) })
      }
      try {
        return answer(200, await analysis(input))
      } catch (err) {
        return answer(502, { error: `analysis failed: ${message(err)}` })
      }
    }

    // The earlier Proving Ground prototype's endpoints.
    if (pathname === "/api/snapshot" || pathname === "/api/precheck") {
      let snapshot: Snapshot
      try {
        snapshot = await latestSnapshot()
      } catch (err) {
        return answer(502, { error: `network read failed: ${message(err)}` })
      }
      if (pathname === "/api/snapshot") return answer(200, snapshot)
      try {
        const run = runPrecheck(snapshot, Object.fromEntries(params))
        return answer(200, { block: snapshot.block, ...run })
      } catch (err) {
        return answer(400, { error: message(err) })
      }
    }
    return null
  }
}
