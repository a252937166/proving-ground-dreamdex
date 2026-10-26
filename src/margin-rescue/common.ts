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

// TP/SL stops have no on-chain enumeration; list them from the indexer (every status,
// so a stop live at an older block is not missed) and let the snapshot check each one
// on chain at its pinned block.
export function stopLister(indexerUrl?: string): StopLister {
  const cfg = loadConfig()
  const markets = createMarkets(indexerUrl ? { ...cfg, indexerUrl } : cfg)
  return async (account) =>
    (await markets.client.listPerpStopOrders({ account, status: ["PENDING", "TRIGGERED", "TRIGGER_FAILED", "CANCELLED"], limit: 200 })).map((s) => ({
      registry: s.registry,
      orderIdRaw: s.orderIdRaw,
      status: s.status,
    }))
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
