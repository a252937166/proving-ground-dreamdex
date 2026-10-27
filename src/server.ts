// Local site: the Margin Rescue pages, live BTC/ETH market data, the evidence summary, the
// recorded runs and a read-only account analysis, plus the earlier Proving Ground page.
// Binds to 127.0.0.1 only. Read-only: no key, no signing, no transactions.
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { extname, join, normalize, sep } from "node:path"
import { loadConfig } from "./config.js"
import { createLiveApi } from "./live-api.js"
import { listRuns, proofSummary, readRun } from "./margin-rescue/site.js"
import { EVIDENCE, EVIDENCE_TYPES, PAGES, WEB, renderPage } from "./pages.js"
import { toJson } from "./snapshot.js"

const live = createLiveApi(loadConfig())
const PORT = Number(process.env.PORT || 8787)
const HOST = "127.0.0.1"
const ASSETS = join(WEB, "assets")

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

  const answer = await live(url.pathname, url.searchParams)
  if (answer) return send(res, answer.status, answer.body)

  send(res, 404, toJson({ error: "not found" }))
})

server.listen(PORT, HOST, () => {
  console.log(`Margin Rescue site: http://${HOST}:${PORT}  (read-only; Ctrl+C to stop)`)
})
