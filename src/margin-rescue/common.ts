// Deployment constants and file helpers shared by the CLI and the fork run.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Address } from "viem"
import { createMarkets, loadConfig } from "../config.js"
import { readJson } from "./json.js"
import { verifyScenarioId, type Scenario } from "./scenario.js"
import type { AccountSnapshot, StopLister } from "./snapshot.js"
import type { CandidateAnalysis } from "./candidates.js"

// Hideki v2 (chain 50383) perps deployment, as read from MarginBank.getSystemConfig()
// and the PerpPoolFactory; the snapshot re-reads and checks the wiring every run.
export const MARGIN_BANK = "0x478769E1177C0773c43A593DCCc4Ad15F15F1394" as Address
export const BTC_POOL = "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0" as Address
export const ETH_POOL = "0xD6Cb1DD58580B84D76068aC21594219ce03aeddf" as Address
export const OPERATOR_REGISTRY = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a" as Address
export const USDSO = "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72" as Address

// JSON written by prettyJson stores bigints as decimal strings; read them back.
// Scenario files are read with readJson instead: their numeric fields are strings by design.
export function readBigJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"), (_k, v) => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v)) as T
}

export const STOP_PAGE_SIZE = 200
export const STOP_MAX_PAGES = 100

type StopRef = { registry: string; orderIdRaw: string; status: string }

// TP/SL stops have no on-chain enumeration; list them from the indexer (every status,
// so a stop live at an older block is not missed) and let the snapshot check each one
// on chain at its pinned block. The listing is paged to the end, and the indexer's
// processed height is read first, so a snapshot pinned past it is refused instead of
// trusted.
export function stopLister(indexerUrl?: string): StopLister {
  const cfg = loadConfig()
  const url = indexerUrl ?? cfg.indexerUrl
  const markets = createMarkets({ ...cfg, indexerUrl: url })
  return (account) =>
    readAgain(async () => {
      const indexedThrough = await indexerWatermark(url)
      const listed = await pageAllStops((offset, limit) =>
        markets.client.listPerpStopOrders({ account, status: ["PENDING", "TRIGGERED", "TRIGGER_FAILED", "CANCELLED"], limit, offset }).then((rows) =>
          rows.map((s) => ({ registry: s.registry, orderIdRaw: s.orderIdRaw, status: s.status })),
        ),
      )
      return { ...listed, indexedThrough }
    })
}

// The indexer is a remote service whose requests fail now and then ("fetch failed"). A read
// of it that fails is made again from the start, up to INDEXER_ATTEMPTS times (1 s, then
// 3 s apart), before the failure stands. The read changes nothing and is taken whole each
// time, so reading again only lowers the odds that a passing outage blocks a run.
export const INDEXER_ATTEMPTS = 3

export async function readAgain<T>(read: () => Promise<T>, attempts = INDEXER_ATTEMPTS, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read()
    } catch (e) {
      if (attempt >= attempts) throw e
      await sleep(1_000 * 3 ** (attempt - 1))
    }
  }
}

// Page through a newest-first listing until a short page. A stop created while paging
// shifts later rows down one place, which repeats a row rather than skipping one, so
// rows are de-duplicated; every status is listed, so none drops out mid-way.
export async function pageAllStops(
  listPage: (offset: number, limit: number) => Promise<StopRef[]>,
  pageSize = STOP_PAGE_SIZE,
  maxPages = STOP_MAX_PAGES,
): Promise<{ rows: StopRef[]; pages: number }> {
  const seen = new Map<string, StopRef>()
  for (let page = 0; page < maxPages; page++) {
    const rows = await listPage(page * pageSize, pageSize)
    for (const r of rows) seen.set(`${r.registry.toLowerCase()}:${r.orderIdRaw}`, r)
    if (rows.length < pageSize) return { rows: [...seen.values()], pages: page + 1 }
  }
  throw new Error(`more than ${maxPages * pageSize} stop records; the listing was not completed`)
}

export async function indexerWatermark(url: string): Promise<bigint | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "query Watermark { chain_metadata { chain_id latest_processed_block } }" }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json()) as { data?: { chain_metadata?: { chain_id: number; latest_processed_block: number | null }[] } }
  const row = body.data?.chain_metadata?.find((r) => r.chain_id === 50383)
  return row?.latest_processed_block == null ? null : BigInt(row.latest_processed_block)
}

export interface AnalysisFiles {
  snapshot: AccountSnapshot
  scenario: Scenario
  analysis: CandidateAnalysis
}

export function loadAnalysis(dir: string): AnalysisFiles {
  const scenario = readJson<Scenario>(join(dir, "scenario.json"))
  if (!verifyScenarioId(scenario)) throw new Error(`scenario in ${dir} does not match its id; it was edited after creation`)
  return { snapshot: readBigJson<AccountSnapshot>(join(dir, "snapshot.json")), scenario, analysis: readBigJson<CandidateAnalysis>(join(dir, "candidates.json")) }
}
