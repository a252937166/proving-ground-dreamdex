// Read-only: for accounts with many indexed TP/SL stop records, compare the previous
// stop lister (one indexer request, limit 200) with the paged one, and check every
// listed stop on chain at the snapshot's pinned block. Signs and sends nothing.
//
//   OUT=stop-pagination.json npx tsx tools/stops-compare.ts 0xACCOUNT [0xACCOUNT …]
import type { Address } from "viem"
import { createMarkets, loadConfig } from "../src/config.js"
import { MARGIN_BANK, stopLister } from "../src/margin-rescue/common.js"
import { prettyJson, writeFileAtomic } from "../src/margin-rescue/json.js"
import { createHidekiClient } from "../src/margin-rescue/rpc.js"
import { readAccountSnapshot } from "../src/margin-rescue/snapshot.js"

const cfg = loadConfig()
const client = createHidekiClient(cfg.rpcUrl)
const markets = createMarkets(cfg)
const rows: unknown[] = []
for (const account of process.argv.slice(2) as Address[]) {
  const snap = await readAccountSnapshot(client, { marginBank: MARGIN_BANK, account, listStops: stopLister() })
  const old = (await markets.client.listPerpStopOrders({ account, status: ["PENDING", "TRIGGERED", "TRIGGER_FAILED", "CANCELLED"], limit: 200 })).map((s) => `${s.registry.toLowerCase()}:${s.orderIdRaw}`)
  const live = snap.stops.rows.filter((r) => r.liveAtBlock)
  const missed = live.filter((r) => !old.includes(`${r.registry.toLowerCase()}:${r.orderId}`))
  const row = {
    account,
    block: snap.block.number,
    blockHash: snap.block.hash,
    indexedThrough: snap.stops.indexedThrough,
    pages: snap.stops.pages,
    recordsListedNow: snap.stops.rows.length,
    recordsListedByOld200: old.length,
    recordsTheOldListerNeverRead: snap.stops.rows.length - old.length,
    liveAtBlock: live.length,
    liveMissedByOld200: missed.length,
    missed: missed.map((m) => ({ registry: m.registry, orderId: m.orderId, indexedStatus: m.indexedStatus })),
    stopsError: snap.stops.error,
    problems: snap.problems,
  }
  console.log(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
  rows.push(row)
}
if (process.env.OUT) {
  writeFileAtomic(
    process.env.OUT,
    prettyJson({ label: "live-read-only", old: "one indexer request with limit 200 (the previous lister)", now: "paged to the end, refused if the indexer is behind the pinned block, every listed stop checked on chain at that block", accounts: rows }),
  )
}
