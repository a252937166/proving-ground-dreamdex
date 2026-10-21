// Local page: live BTC-PERP data plus the local v2.2 pre-check.
// Binds to 127.0.0.1 only. Read-only: no key, no signing, no transactions.
import { readFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { createMarkets, loadConfig } from "./config.js"
import { runPrecheck } from "./order.js"
import { readSnapshot, toJson, type Snapshot } from "./snapshot.js"

const cfg = loadConfig()
const markets = createMarkets(cfg)
const PORT = Number(process.env.PORT || 8787)
const HOST = "127.0.0.1"
const MAX_AGE_MS = 2_000
const PAGE = new URL("../web/index.html", import.meta.url)

let cached: { at: number; snapshot: Snapshot } | null = null
let inflight: Promise<Snapshot> | null = null

// One network read at a time; requests within MAX_AGE_MS share the last result.
function latestSnapshot(): Promise<Snapshot> {
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.snapshot)
  inflight ??= readSnapshot(markets, cfg)
    .then((snapshot) => {
      cached = { at: Date.now(), snapshot }
      return snapshot
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function send(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`)
  if (req.method !== "GET") return send(res, 405, toJson({ error: "GET only" }))
  if (url.pathname === "/") return send(res, 200, readFileSync(PAGE, "utf8"), "text/html")

  if (url.pathname === "/api/snapshot" || url.pathname === "/api/precheck") {
    let snapshot: Snapshot
    try {
      snapshot = await latestSnapshot()
    } catch (err) {
      return send(res, 502, toJson({ error: `network read failed: ${err instanceof Error ? err.message : String(err)}` }))
    }
    if (url.pathname === "/api/snapshot") return send(res, 200, toJson(snapshot))
    try {
      const q = Object.fromEntries(url.searchParams)
      const run = runPrecheck(snapshot, q)
      return send(res, 200, toJson({ block: snapshot.block, ...run }))
    } catch (err) {
      return send(res, 400, toJson({ error: err instanceof Error ? err.message : String(err) }))
    }
  }
  send(res, 404, toJson({ error: "not found" }))
})

server.listen(PORT, HOST, () => {
  console.log(`Proving Ground prototype: http://${HOST}:${PORT}  (read-only; Ctrl+C to stop)`)
})
