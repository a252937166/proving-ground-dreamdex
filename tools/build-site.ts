// Static build of the website for GitHub Pages, which has no server: every page with its
// header and footer, the assets, the evidence folder, the evidence endpoints as JSON files
// written now, and the live endpoints bundled to run in the visitor's browser
// (src/browser.ts, loaded by web/assets/static-api.js).
//
//   SITE_BASE=/proving-ground-dreamdex/ npm run build:site     # writes dist/site/
import { build, type Plugin } from "esbuild"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { sdkVersion } from "../src/config.js"
import { listRuns, proofSummary, readRun } from "../src/margin-rescue/site.js"
import { EVIDENCE, EVIDENCE_TYPES, PAGES, WEB, renderPage } from "../src/pages.js"
import { toJson } from "../src/snapshot.js"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const OUT = join(ROOT, "dist/site")
const BASE = process.env.SITE_BASE || "/"
if (!/^\/([\w.-]+\/)*$/.test(BASE)) throw new Error(`SITE_BASE must start and end with "/", got ${BASE}`)

function write(path: string, body: string) {
  mkdirSync(dirname(join(OUT, path)), { recursive: true })
  writeFileSync(join(OUT, path), body)
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function replaceOnce(html: string, from: string, to: string, file: string): string {
  if (!html.includes(from)) throw new Error(`${file}: expected ${from}`)
  return html.replace(from, to)
}

rmSync(OUT, { recursive: true, force: true })

// Pages. Links to the site's own pages and files gain the base; /api/ paths stay as they
// are, because static-api.js answers them in the browser.
for (const [route, file] of Object.entries(PAGES)) {
  let html = renderPage(file, route)
  html = replaceOnce(html, `<html lang="en">`, `<html lang="en" data-base="${BASE}" data-static>`, file)
  html = replaceOnce(html, "<script", `<script src="/assets/static-api.js"></script>\n<script`, file)
  html = html.replace(/(href|src|action)="\/(?!\/|api\/)/g, `$1="${BASE}`)
  write(file, html)
}

cpSync(join(WEB, "assets"), join(OUT, "assets"), { recursive: true })

// The evidence folder, as the local server serves it.
let evidenceFiles = 0
for (const path of files(EVIDENCE)) {
  if (!EVIDENCE_TYPES.has(extname(path))) continue
  cpSync(path, join(OUT, "evidence", relative(EVIDENCE, path)))
  evidenceFiles++
}

// The evidence endpoints, answered now from the evidence folder.
write("api/proof.json", toJson(proofSummary()))
const runs = listRuns()
write("api/runs.json", toJson({ runs }))
for (const run of runs) write(`api/runs/${run.id}.json`, toJson(readRun(run.id)))

// The bundled modules import Node built-ins for file helpers a browser never reaches;
// only SHA-256 is needed (scenario ids), and viem provides it.
const unavailable = (mod: string, names: string[]) =>
  names.map((n) => `export function ${n}() { throw new Error("${mod} ${n} is not available in the browser") }`).join("\n")
const NODE_SHIMS: Record<string, string> = {
  "node:crypto": `import { concat, sha256, stringToBytes } from "viem"
export function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error(algorithm + " is not available in the browser")
  const parts = []
  return {
    update(data) { parts.push(typeof data === "string" ? stringToBytes(data) : data); return this },
    digest(encoding) {
      if (encoding !== "hex") throw new Error("only hex digests are available in the browser")
      return sha256(concat(parts)).slice(2)
    },
  }
}`,
  "node:fs": unavailable("node:fs", ["readFileSync", "writeFileSync", "existsSync", "mkdirSync", "renameSync", "openSync", "fsyncSync", "closeSync", "readdirSync", "statSync", "appendFileSync"]),
  "node:path": unavailable("node:path", ["join", "dirname", "resolve", "relative", "basename", "extname", "normalize"]),
}
const nodeShims: Plugin = {
  name: "node-shims",
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => {
      if (!NODE_SHIMS[args.path]) throw new Error(`${args.importer} imports ${args.path}, which has no browser shim`)
      return { path: args.path, namespace: "node-shim" }
    })
    b.onLoad({ filter: /.*/, namespace: "node-shim" }, (args) => ({ contents: NODE_SHIMS[args.path], loader: "js", resolveDir: ROOT }))
  },
}

const bundle = await build({
  entryPoints: [join(ROOT, "src/browser.ts")],
  outfile: join(OUT, "assets/chain.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  metafile: true,
  plugins: [nodeShims],
  define: { "process.env": "{}", __MARKETS_SDK_VERSION__: JSON.stringify(sdkVersion()) },
  logLevel: "warning",
})

// Scenario ids are SHA-256 hashes: the browser's must match Node's.
const probe = await build({
  stdin: { contents: `export { sha256Hex } from "./src/margin-rescue/json.ts"`, resolveDir: ROOT, loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  plugins: [nodeShims],
  logLevel: "warning",
})
const { sha256Hex } = await import(`data:text/javascript;base64,${Buffer.from(probe.outputFiles[0].text).toString("base64")}`)
const sample = '{"scenario":"BTC −8%, ETH −12%","target":"0"}'
if (sha256Hex(sample) !== createHash("sha256").update(sample).digest("hex")) throw new Error("the browser build's SHA-256 differs from Node's")

// No Jekyll processing: the files are served as they are.
write(".nojekyll", "")

const chainKb = Math.round(bundle.metafile.outputs[relative(ROOT, join(OUT, "assets/chain.js"))].bytes / 1024)
console.log(`dist/site: ${Object.keys(PAGES).length} pages, ${runs.length} runs, ${evidenceFiles} evidence files, chain.js ${chainKb} KB, base ${BASE}`)
