// Local site: the Margin Rescue pages, live BTC/ETH market data, the evidence summary, the
// recorded runs and a read-only account analysis, plus the earlier Proving Ground page.
// Binds to 127.0.0.1 only. Read-only: no key, no signing, no transactions.
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createMarkets, loadConfig } from "./config.js"
import { createHidekiClient } from "./margin-rescue/rpc.js"
import { analyzeAccount, listRuns, parseAnalyzeInput, proofSummary, readRun, type AnalyzeInput } from "./margin-rescue/site.js"
import { runPrecheck } from "./order.js"
import { readSnapshot, toJson, type Snapshot } from "./snapshot.js"

const cfg = loadConfig()
const markets = createMarkets(cfg)
const client = createHidekiClient(cfg.rpcUrl)
const PORT = Number(process.env.PORT || 8787)
const HOST = "127.0.0.1"
const MAX_AGE_MS = 2_000
const WEB = fileURLToPath(new URL("../web/", import.meta.url))
const ASSETS = join(WEB, "assets")
const EVIDENCE = fileURLToPath(new URL("../evidence/margin-rescue", import.meta.url))
const EVIDENCE_TYPES = new Set([".txt", ".json", ".jsonl", ".md", ""])

const PAGES: Record<string, string> = {
  "/": "index.html",
  "/features": "features.html",
  "/technology": "technology.html",
  "/guide": "guide.html",
  "/dashboard": "dashboard.html",
  "/app": "app.html",
  "/proving-ground": "proving-ground.html",
}

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
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

// Pages share one header and footer, inserted here; the current page's link is marked.
function renderPage(file: string, path: string): string {
  const part = (name: string) => readFileSync(join(WEB, "partials", `${name}.html`), "utf8")
  const head = part("site-head").replaceAll(`href="${path}"`, `href="${path}" aria-current="page"`)
  return readFileSync(join(WEB, file), "utf8").replace("<!--site-head-->", head).replace("<!--site-foot-->", part("site-foot"))
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" })
  res.end(body)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`)
  if (req.method !== "GET") return send(res, 405, toJson({ error: "GET only" }))

  const path = url.pathname.replace(/\/$/, "") || "/"
  const page = PAGES[path]
  if (page) return send(res, 200, renderPage(page, path), "text/html")

  if (url.pathname.startsWith("/assets/")) {
    const path = normalize(join(ASSETS, decodeURIComponent(url.pathname.slice("/assets/".length))))
    if (!path.startsWith(ASSETS + sep) || !existsSync(path) || !statSync(path).isFile()) return send(res, 404, "not found", "text/plain")
    return send(res, 200, readFileSync(path), TYPES[extname(path)] ?? "application/octet-stream")
  }

  // The evidence folder, read-only and as plain text, so every figure on the site can be checked.
  if (url.pathname.startsWith("/evidence/")) {
    const path = normalize(join(EVIDENCE, decodeURIComponent(url.pathname.slice("/evidence/".length))))
    if (!path.startsWith(EVIDENCE + sep) || !existsSync(path) || !statSync(path).isFile() || !EVIDENCE_TYPES.has(extname(path))) return send(res, 404, "not found", "text/plain")
    return send(res, 200, readFileSync(path), extname(path) === ".json" ? "application/json" : "text/plain")
  }

  if (url.pathname === "/api/markets") {
    try {
      const [btc, eth] = await Promise.all([latestSnapshot(), latestEth()])
      return send(res, 200, toJson({ markets: [btc, eth] }))
    } catch (err) {
      return send(res, 502, toJson({ error: `network read failed: ${message(err)}` }))
    }
  }

  if (url.pathname === "/api/proof") {
    try {
      return send(res, 200, toJson(proofSummary()))
    } catch (err) {
      return send(res, 500, toJson({ error: `evidence could not be read: ${message(err)}` }))
    }
  }

  if (url.pathname === "/api/runs") return send(res, 200, toJson({ runs: listRuns() }))
  if (url.pathname.startsWith("/api/runs/")) {
    const run = readRun(url.pathname.slice("/api/runs/".length))
    return run ? send(res, 200, toJson(run)) : send(res, 404, toJson({ error: "no such run" }))
  }

  if (url.pathname === "/api/analyze") {
    let input: AnalyzeInput
    try {
      input = parseAnalyzeInput(Object.fromEntries(url.searchParams))
    } catch (err) {
      return send(res, 400, toJson({ error: message(err) }))
    }
    try {
      return send(res, 200, toJson(await analysis(input)))
    } catch (err) {
      return send(res, 502, toJson({ error: `analysis failed: ${message(err)}` }))
    }
  }

  // The earlier Proving Ground prototype's endpoints.
  if (url.pathname === "/api/snapshot" || url.pathname === "/api/precheck") {
    let snapshot: Snapshot
    try {
      snapshot = await latestSnapshot()
    } catch (err) {
      return send(res, 502, toJson({ error: `network read failed: ${message(err)}` }))
    }
    if (url.pathname === "/api/snapshot") return send(res, 200, toJson(snapshot))
    try {
      const q = Object.fromEntries(url.searchParams)
      const run = runPrecheck(snapshot, q)
      return send(res, 200, toJson({ block: snapshot.block, ...run }))
    } catch (err) {
      return send(res, 400, toJson({ error: message(err) }))
    }
  }
  send(res, 404, toJson({ error: "not found" }))
})

server.listen(PORT, HOST, () => {
  console.log(`Margin Rescue site: http://${HOST}:${PORT}  (read-only; Ctrl+C to stop)`)
})
