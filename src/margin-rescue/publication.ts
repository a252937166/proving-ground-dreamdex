// How a live run's evidence becomes public, and how a published bundle is checked.
//
// A run writes its journals to a private folder (paths.ts). publishRun copies them into
// evidence/margin-rescue/live-write/run-<name>/ after scanning every file for what must
// never be published: the signing key (any 32-byte value from which the run's account
// derives), the signed bytes of a transaction (a hex string whose keccak is one of the
// run's transaction hashes, or that parses as a signed transaction) and a BIP-39
// mnemonic; it replaces absolute local paths and every URL that is not one of the fixed
// public endpoints (endpoints.ts). It writes a manifest, PUBLICATION.json, with the
// SHA-256 of every original and of every published copy, and SANITIZATION.md, rendered
// from the manifest; then it checks the finished bundle with validateBundle before
// moving it into place. The originals are only read.
//
// validateBundle checks a published bundle from scratch, as the static build and the
// local server do before showing it: no marker file is trusted. The bundle must hold
// exactly the files its manifest lists, each with the listed hash; the report must be the
// one the manifest renders; the run's files must agree with each other and with the plan
// file whose SHA-256 is the run's plan digest; and every file, the manifest and the
// report included, is scanned again.
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { keccak256, parseTransaction, type Hex } from "viem"
import { english, privateKeyToAccount } from "viem/accounts"
import { isPublicEndpoint } from "./endpoints.js"
import { sha256Hex } from "./json.js"
import { privateOutDir, publishedBundleDir, REPO_ROOT, RefusedError } from "./paths.js"

export const PUBLICATION_VERSION = "mr-publication/1"
export const MANIFEST = "PUBLICATION.json"
export const isBundleName = (name: string) => /^run-\d+$/.test(name)
export const REPORT = "SANITIZATION.md"
export const PLAN_FILE = "live-plan.json"

// What a run folder may contribute: the files the executor, cleanup, the command and the
// verifier write. Anything else stays private and is listed as left out.
export const RUN_FILES = [
  /^run-state\.json$/,
  /^run-ledger\.json$/,
  /^run-log\.jsonl$/,
  /^results?\.jsonl?$/,
  /^preflight(-snapshot)?\.json$/,
  /^guard\.json$/,
  /^analysis-snapshot\.json$/,
  /^analysis\.txt$/,
  /^scenario\.json$/,
  /^candidates\.json$/,
  /^refresh-\d+\.json$/,
  /^refresh-analysis\.json$/,
  /^receipt\.json$/,
  /^post-snapshot\.json$/,
  /^recompute\.(json|txt)$/,
  /^cleanup\.json$/,
  /^verification\.(json|txt)$/,
  /^journal\/0x[0-9a-f]{64}\.json$/,
]

export type FindingKind = "signing key" | "signed transaction" | "mnemonic" | "local path" | "private url"
export interface Finding {
  file: string
  kind: FindingKind
  detail: string
}

// Never published: a bundle holding any of these is refused outright.
export const FATAL: FindingKind[] = ["signing key", "signed transaction", "mnemonic"]

export interface ScanContext {
  account: string // the run's account: a 32-byte value deriving it is the key
  txHashes: Set<string> // the run's transaction hashes, lower case
}

export interface ScanCounts {
  keyCandidates: number
  longHex: number
  words: number
}

// An absolute path outside a URL (the lookbehind skips the host and scheme of one): any
// path under a usual system root, any other absolute path of three or more segments, a
// home-relative path, or a Windows drive path (C:\ or C:/).
const ROOTS = "Users|home|root|private|var|tmp|Volumes|opt|mnt|srv|media|run|etc|usr|Library|System|Applications|nix|data|workspace|builds|runner|cygdrive"
const LOCAL_PATH = new RegExp(`(?<![\\w.:/~\\\\-])/(?:(?:${ROOTS})/[^\\s"'\`,)<>\\]]*|[A-Za-z][\\w.-]*/[\\w.-]+/[^\\s"'\`,)<>\\]]*)|(?<![\\w/.])~/[^\\s"'\`,)<>\\]]+|\\b[A-Za-z]:[\\\\/][^\\s"'\`,)<>\\]]+`, "g")
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>,)\]}]+/gi
const HEX_RE = /(?:0[xX])?[0-9a-fA-F]{64,}/g

export function scanText(file: string, text: string, ctx: ScanContext | null, counts: ScanCounts = { keyCandidates: 0, longHex: 0, words: 0 }, keyCache = new Map<string, boolean>()): Finding[] {
  const found: Finding[] = []
  for (const m of text.matchAll(HEX_RE)) {
    const hex = (/^0x/i.test(m[0]) ? m[0].slice(2) : m[0]).toLowerCase()
    if (hex.length === 64) {
      counts.keyCandidates++
      if (!ctx) continue
      if (!keyCache.has(hex)) {
        let derives = false
        try {
          derives = privateKeyToAccount(`0x${hex}`).address.toLowerCase() === ctx.account.toLowerCase()
        } catch {
          // not a valid secp256k1 scalar
        }
        keyCache.set(hex, derives)
      }
      if (keyCache.get(hex)) found.push({ file, kind: "signing key", detail: `a 32-byte value at offset ${m.index} derives the run's account` })
    } else if (hex.length >= 160 && hex.length % 2 === 0) {
      counts.longHex++
      if (ctx?.txHashes.has(keccak256(`0x${hex}`).toLowerCase())) {
        found.push({ file, kind: "signed transaction", detail: `bytes at offset ${m.index} hash to a transaction of the run` })
        continue
      }
      try {
        const tx = parseTransaction(`0x${hex}` as Hex)
        if (tx.r !== undefined && tx.s !== undefined) found.push({ file, kind: "signed transaction", detail: `bytes at offset ${m.index} parse as a signed transaction` })
      } catch {
        // calldata, code or a hash list: not a transaction
      }
    }
  }
  counts.words += (text.match(/[a-z]+/gi) ?? []).length
  for (const run of phraseRuns(text)) if (hasMnemonic(run.words)) found.push({ file, kind: "mnemonic", detail: `a BIP-39 phrase at offset ${run.at}` })
  for (const m of text.matchAll(LOCAL_PATH)) found.push({ file, kind: "local path", detail: m[0].replace(/^\/(Users|home)\/[^/]+/, "/$1/<user>").slice(0, 80) })
  for (const m of text.matchAll(URL_RE)) if (!isPublicEndpoint(m[0])) found.push({ file, kind: "private url", detail: hostOf(m[0]) })
  return found
}

const WORD_INDEX = new Map(english.map((w, i) => [w, i]))

// What may stand between two words of a phrase as people write one down: spaces or line
// breaks, commas, the quotes and brackets of a list or a JSON array, a bullet, a list
// number ("1." "2)" "3 "), a table's bars. Never a colon or an equals sign, so the keys
// and values of JSON or YAML do not chain into one phrase.
const PHRASE_GAP = /^[\s,"'`[\]|*•-]*(?:\d{1,2}(?:[.)]|\s)[\s,"'`[\]|*•-]*)?$/

// Runs of 12 or more consecutive words of the BIP-39 English list, in any case, joined by
// PHRASE_GAP. JSON's escaped line breaks and tabs count as breaks.
export function phraseRuns(text: string): { at: number; words: string[] }[] {
  const plain = text.replace(/\\(?:\\|[nrt])/g, (e) => (e === "\\\\" ? e : "  "))
  const runs: { at: number; words: string[] }[] = []
  let cur: { at: number; words: string[] } | null = null
  let end = 0
  const close = () => {
    if (cur && cur.words.length >= 12) runs.push(cur)
    cur = null
  }
  for (const m of plain.matchAll(/[a-z]+/gi)) {
    const word = m[0].toLowerCase()
    if (!WORD_INDEX.has(word)) {
      close()
      continue
    }
    if (cur && PHRASE_GAP.test(plain.slice(end, m.index))) cur.words.push(word)
    else {
      close()
      cur = { at: m.index!, words: [word] }
    }
    end = m.index! + m[0].length
  }
  close()
  return runs
}

// A BIP-39 mnemonic among `words`: 12, 15, 18, 21 or 24 consecutive words of the English
// list whose last bits are the SHA-256 checksum of the rest, as every wallet phrase is.
// Ordinary prose made of common words almost never passes the checksum.
export function hasMnemonic(words: string[]): boolean {
  for (const n of [12, 15, 18, 21, 24]) {
    for (let start = 0; start + n <= words.length; start++) {
      const ids = words.slice(start, start + n).map((w) => WORD_INDEX.get(w.toLowerCase()))
      if (ids.some((i) => i === undefined)) continue
      const bits = ids.map((i) => i!.toString(2).padStart(11, "0")).join("")
      const cs = n / 3
      const entropy = bits.slice(0, bits.length - cs)
      const bytes = new Uint8Array(entropy.length / 8)
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(entropy.slice(i * 8, i * 8 + 8), 2)
      const hash = createHash("sha256").update(bytes).digest()
      const want = [...hash].map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, cs)
      if (bits.slice(bits.length - cs) === want) return true
    }
  }
  return false
}

function hostOf(u: string): string {
  try {
    return new URL(u).host || "unparsable"
  } catch {
    return "unparsable"
  }
}

// Local paths and non-public URLs replaced; everything else byte for byte. The change
// notes (published in the report) name only the kind of replacement: a redacted path
// still shows a folder layout, and a private node's host name can identify an account.
export function sanitizeText(text: string): { text: string; changes: string[] } {
  let paths = 0
  let urls = 0
  const out = text
    .replace(LOCAL_PATH, () => {
      paths++
      return "<local path>"
    })
    .replace(URL_RE, (u) => {
      if (isPublicEndpoint(u)) return u
      urls++
      return "<url withheld>"
    })
  const changes = [...(paths ? [`${paths} local path(s) replaced`] : []), ...(urls ? [`${urls} non-public URL(s) withheld`] : [])]
  return { text: out, changes }
}

export interface Manifest {
  version: typeof PUBLICATION_VERSION
  publishedAt: string
  tool: string
  run: { chainId: number; account: string; planDigest: string; transactions: string[]; result: { status: string; exitCode: number } | null }
  files: Record<string, { original: string | null; published: string; changes: string[] }>
  leftOut: string[]
  scan: ScanCounts & { files: number }
}

export function renderReport(m: Manifest): string {
  const rows = Object.entries(m.files)
    .filter(([f]) => f !== REPORT)
    .map(([f, x]) => `| \`${f}\` | ${x.original ? `\`${x.original}\`` : x.changes.length ? "kept privately (redacted file)" : "—"} | ${x.original === x.published ? "same" : `\`${x.published}\``} | ${x.changes.join("; ") || "copied unchanged"} |`)
  return [
    "# Publication of this run's evidence",
    "",
    `The run was written to a private, git-ignored folder; \`tools/publish-live-run.ts\` copied it here on ${m.publishedAt}. The originals are kept unchanged outside the repository. \`${PLAN_FILE}\` is the plan file the run was started under: its SHA-256 is the run's plan digest \`${m.run.planDigest}\`. \`${MANIFEST}\` lists the SHA-256 of every file here and of every original copied unchanged; the original of a redacted file is hashed only in the private provenance record, since its hash would let anyone test guesses for what was redacted. The site's build checks this folder against the manifest, and scans every file again, before publishing it.`,
    "",
    "Scanned for, and not found (any one of them stops the publication):",
    "",
    `- signed transaction bytes: ${m.scan.longHex} hex strings of 80 bytes or more were hashed and compared with the ${m.run.transactions.length} transaction hashes in the run ledger, and parsed as transactions`,
    `- the signing key: ${m.scan.keyCandidates} 32-byte values were each tried as a private key; none derives the account \`${m.run.account}\``,
    `- a BIP-39 mnemonic: ${m.scan.words} words checked for a phrase of 12 to 24 words of the English list with a valid checksum, in any case, separated by spaces, line breaks, commas, list numbers or bullets, or written as a JSON array`,
    "",
    "Replaced: absolute local paths, and every URL other than the fixed public Hideki RPC and dreamDEX indexer addresses.",
    "",
    "| File | SHA-256 of the original | SHA-256 here | Changes |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    m.leftOut.length ? `Left out (not written by the executor, the command or the verifier): ${m.leftOut.map((f) => `\`${f}\``).join(", ")}.` : "Nothing was left out.",
    "",
  ].join("\n")
}

export interface PublishResult {
  ok: boolean
  published: string[]
  leftOut: string[]
  fatal: Finding[]
  problems: string[]
  replaced: { file: string; change: string }[]
}

export function publishRun(opts: { from: string; to: string; plan: string; replace?: boolean; root?: string; now?: Date }): PublishResult {
  const root = opts.root ?? REPO_ROOT
  const from = privateOutDir(opts.from, root) // the source must be a private run folder
  const to = publishedBundleDir(opts.to, root)
  if (existsSync(to) && !opts.replace) throw new RefusedError(`${opts.to} exists; pass --replace to publish again from the run folder`)
  const ledger = JSON.parse(readFileSync(join(from, "run-ledger.json"), "utf8")) as { planDigest: string; account: string; chainId: number | string; steps: { hash: string }[] }
  const planBytes = readFileSync(opts.plan)
  if (sha256Hex(planBytes) !== ledger.planDigest) throw new RefusedError(`${opts.plan} (SHA-256 ${sha256Hex(planBytes)}) is not the plan this run was started under (${ledger.planDigest})`)
  const result = existsSync(join(from, "result.json")) ? (JSON.parse(readFileSync(join(from, "result.json"), "utf8")) as { status: string; exitCode: number }) : null
  const ctx: ScanContext = { account: ledger.account, txHashes: new Set(ledger.steps.map((s) => s.hash.toLowerCase())) }

  const { files: all, links } = walk(from)
  const files = all.filter((f) => RUN_FILES.some((k) => k.test(f)))
  const leftOut = [...all.filter((f) => !files.includes(f)), ...links.map((l) => `${l} (symbolic link)`)]
  const counts: ScanCounts = { keyCandidates: 0, longHex: 0, words: 0 }
  const keyCache = new Map<string, boolean>()
  const fatal: Finding[] = []
  const replaced: { file: string; change: string }[] = []
  const out = new Map<string, { original: Buffer; bytes: Buffer; changes: string[] }>()
  for (const file of [...files, PLAN_FILE]) {
    const original = file === PLAN_FILE ? planBytes : readFileSync(join(from, file))
    const text = original.toString("utf8")
    fatal.push(...scanText(file, text, ctx, counts, keyCache).filter((f) => FATAL.includes(f.kind)))
    const clean = sanitizeText(text)
    for (const change of clean.changes) replaced.push({ file, change })
    out.set(file, { original, bytes: clean.text === text ? original : Buffer.from(clean.text, "utf8"), changes: clean.changes })
  }
  if (fatal.length) return { ok: false, published: [], leftOut, fatal, problems: fatal.map((f) => `${f.file}: ${f.kind}`), replaced }

  const manifest: Manifest = {
    version: PUBLICATION_VERSION,
    publishedAt: (opts.now ?? new Date()).toISOString(),
    tool: "tools/publish-live-run.ts",
    run: { chainId: Number(ledger.chainId), account: ledger.account, planDigest: ledger.planDigest, transactions: ledger.steps.map((s) => s.hash), result: result ? { status: result.status, exitCode: result.exitCode } : null },
    // A redacted file's original hash would let anyone test guesses for what was redacted
    // (a user name, a private host): it goes to the private provenance record instead.
    files: Object.fromEntries([...out.entries()].map(([f, x]) => [f, { original: x.changes.length ? null : sha256Hex(x.original), published: sha256Hex(x.bytes), changes: x.changes }])),
    leftOut,
    scan: { ...counts, files: out.size },
  }
  const report = renderReport(manifest)
  manifest.files[REPORT] = { original: null, published: sha256Hex(report), changes: ["generated from the manifest"] }

  // Assembled beside the repository's private files, checked, then moved into place.
  const tmp = join(root, ".margin-rescue", "publishing", `${Date.now()}-${process.pid}`)
  rmSync(tmp, { recursive: true, force: true })
  for (const [f, x] of out) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true })
    writeFileSync(join(tmp, f), x.bytes)
  }
  writeFileSync(join(tmp, REPORT), report)
  writeFileSync(join(tmp, MANIFEST), JSON.stringify(manifest, null, 2) + "\n")
  const check = validateBundle(tmp)
  if (!check.ok) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, published: [], leftOut, fatal: [], problems: check.problems, replaced }
  }
  // The private provenance record: every original's hash, beside the private run folders.
  const provenance = join(root, ".margin-rescue", "publications", `${basename(to)}-${manifest.publishedAt.replace(/[:.]/g, "-")}.json`)
  mkdirSync(dirname(provenance), { recursive: true })
  writeFileSync(provenance, JSON.stringify({ publishedAt: manifest.publishedAt, bundle: basename(to), originals: Object.fromEntries([...out.entries()].map(([f, x]) => [f, sha256Hex(x.original)])), published: Object.fromEntries(Object.entries(manifest.files).map(([f, x]) => [f, x.published])) }, null, 2) + "\n")
  if (existsSync(to)) rmSync(to, { recursive: true })
  mkdirSync(dirname(to), { recursive: true })
  renameSync(tmp, to)
  return { ok: true, published: Object.keys(manifest.files), leftOut, fatal: [], problems: [], replaced }
}

function walk(dir: string, base = dir): { files: string[]; links: string[] } {
  const files: string[] = []
  const links: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) links.push(relative(base, path))
    else if (st.isDirectory()) {
      const sub = walk(path, base)
      files.push(...sub.files)
      links.push(...sub.links)
    } else files.push(relative(base, path))
  }
  return { files: files.sort(), links }
}

export interface BundleCheck {
  ok: boolean
  problems: string[]
  manifest: Manifest | null
}

// A published bundle, checked from scratch (see the top of this file). Anything malformed
// is a failed check, never an exception.
export function validateBundle(dir: string): BundleCheck {
  try {
    return checkBundle(dir)
  } catch (e) {
    return { ok: false, problems: [`the bundle could not be checked: ${String((e as Error)?.message ?? e).split("\n")[0]}`], manifest: null }
  }
}

function checkBundle(dir: string): BundleCheck {
  const problems: string[] = []
  const fail = (p: string): BundleCheck => ({ ok: false, problems: [...problems, p], manifest: null })
  if (!existsSync(join(dir, MANIFEST))) return fail(`no ${MANIFEST}: not a published bundle (a raw run folder is never published)`)
  let m: Manifest
  try {
    m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest
  } catch (e) {
    return fail(`${MANIFEST} does not parse: ${(e as Error).message.split("\n")[0]}`)
  }
  const run = m?.run as Partial<Manifest["run"]> | undefined
  const wellFormed =
    m?.version === PUBLICATION_VERSION &&
    typeof m.files === "object" &&
    m.files !== null &&
    Object.values(m.files).every((x) => typeof x?.published === "string" && Array.isArray(x.changes)) &&
    typeof run?.account === "string" &&
    typeof run.planDigest === "string" &&
    typeof run.chainId === "number" &&
    Array.isArray(run.transactions) &&
    run.transactions.every((h) => typeof h === "string")
  if (!wellFormed) return fail(`${MANIFEST} is not ${PUBLICATION_VERSION}`)
  const { files, links } = walk(dir)
  for (const l of links) problems.push(`${l} is a symbolic link`)
  const listed = Object.keys(m.files)
  for (const f of files) if (f !== MANIFEST && !listed.includes(f)) problems.push(`${f} is not in ${MANIFEST}`)
  for (const f of listed) {
    if (!files.includes(f)) {
      problems.push(`${f} is listed in ${MANIFEST} but missing`)
      continue
    }
    if (f !== PLAN_FILE && f !== REPORT && !RUN_FILES.some((k) => k.test(f))) problems.push(`${f} is not a file a run writes`)
    if (sha256Hex(readFileSync(join(dir, f))) !== m.files[f].published) problems.push(`${f} differs from its SHA-256 in ${MANIFEST}`)
  }
  if (existsSync(join(dir, REPORT)) && readFileSync(join(dir, REPORT), "utf8") !== renderReport(m)) problems.push(`${REPORT} is not the report ${MANIFEST} renders`)

  // The run's own files agree with each other, with the manifest and with the plan.
  const read = <T>(f: string): T | null => {
    try {
      return existsSync(join(dir, f)) ? (JSON.parse(readFileSync(join(dir, f), "utf8")) as T) : null
    } catch {
      problems.push(`${f} does not parse`)
      return null
    }
  }
  const ledger = read<{ planDigest: string; account: string; chainId: number | string; steps: { hash: string }[] }>("run-ledger.json")
  const state = read<{ planDigest: string; account: string }>("run-state.json")
  const plan = read<{ network?: { chainId?: number }; account?: { address?: string } }>(PLAN_FILE)
  const result = read<{ status: string; exitCode: number }>("result.json")
  if (!ledger) problems.push("no run-ledger.json")
  if (!plan) problems.push(`no ${PLAN_FILE}`)
  if (ledger && plan) {
    const digest = sha256Hex(readFileSync(join(dir, PLAN_FILE)))
    if (ledger.planDigest !== digest || m.run.planDigest !== digest || (state && state.planDigest !== digest)) problems.push(`${PLAN_FILE} (SHA-256 ${digest}) is not the plan the run ledger, run state and manifest name`)
    const account = ledger.account.toLowerCase()
    if (m.run.account.toLowerCase() !== account || String(plan.account?.address).toLowerCase() !== account || (state && state.account.toLowerCase() !== account)) problems.push("the manifest, plan, run state and run ledger name different accounts")
    if (Number(ledger.chainId) !== 50383 || m.run.chainId !== 50383 || plan.network?.chainId !== 50383) problems.push("not chain 50383")
    if (JSON.stringify(m.run.transactions.map((h) => h.toLowerCase())) !== JSON.stringify(ledger.steps.map((s) => s.hash.toLowerCase()))) problems.push(`the transactions in ${MANIFEST} are not the run ledger's`)
  }
  if ((result?.status ?? null) !== (m.run.result?.status ?? null)) problems.push(`the result in ${MANIFEST} is not result.json's`)

  // Every file scanned again, the manifest and the report included.
  if (ledger) {
    const ctx: ScanContext = { account: ledger.account, txHashes: new Set(ledger.steps.map((s) => s.hash.toLowerCase())) }
    const cache = new Map<string, boolean>()
    for (const f of files) for (const x of scanText(f, readFileSync(join(dir, f), "utf8"), ctx, undefined, cache)) problems.push(`${f}: ${x.kind} (${x.detail})`)
  }
  return { ok: problems.length === 0, problems, manifest: problems.length ? null : m }
}

// The live-write folder: its README and published bundles named run-<number> (the only
// names publishRun writes and the site reads), nothing else. The README is evidence like
// any other and is scanned by evidenceToPublish; only a bundle is checked here.
export function validateLiveWrite(dir: string): { ok: boolean; problems: string[]; bundles: Record<string, BundleCheck> } {
  const problems: string[] = []
  const bundles: Record<string, BundleCheck> = {}
  if (!existsSync(dir)) return { ok: true, problems, bundles }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) problems.push(`${name} is a symbolic link`)
    else if (st.isDirectory() && !isBundleName(name)) problems.push(`${name}/: a bundle folder is named run-<number>`)
    else if (st.isDirectory()) {
      bundles[name] = validateBundle(path)
      for (const p of bundles[name].problems) problems.push(`${name}/: ${p}`)
    } else if (name !== "README.md") problems.push(`${name}: only README.md and published bundles belong in live-write/`)
  }
  return { ok: problems.length === 0, problems, bundles }
}

// Any other evidence file (fixtures, fork runs, read-only reads): never signed
// transactions, a mnemonic, local paths, or a URL that could carry a credential (user
// info, a query, or a token-like path segment). Fork evidence names its local fork RPCs,
// which are not secret, so other URLs are allowed there.
export function scanEvidenceText(file: string, text: string): Finding[] {
  const found = scanText(file, text, null).filter((f) => f.kind !== "private url")
  for (const m of text.matchAll(URL_RE)) {
    let u: URL
    try {
      u = new URL(m[0])
    } catch {
      continue
    }
    const tokenLike = u.pathname.split("/").some((seg) => seg.length >= 20 && /[A-Za-z]/.test(seg) && /\d/.test(seg))
    if (u.username || u.password || m[0].includes("?") || tokenLike) found.push({ file, kind: "private url", detail: `${hostOf(m[0])}: user info, a query or a token-like path` })
  }
  return found
}

// What the static build may publish from an evidence folder (evidence/margin-rescue): the
// files to copy, or the problems that stop the build. No symbolic link anywhere;
// live-write/ only as checked bundles beside its README; every file scanned, the README
// included. Only the files of a bundle that passed validateBundle skip the scan here: that
// check scanned them already, more strictly (no URL but the public endpoints).
export function evidenceToPublish(root: string, types: Set<string>): { files: string[]; problems: string[] } {
  const problems: string[] = []
  const files: string[] = []
  const walkAll = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const st = lstatSync(path)
      if (st.isSymbolicLink()) problems.push(`${relative(root, path)}: a symbolic link (evidence must be plain files)`)
      else if (st.isDirectory()) walkAll(path)
      else if (types.has(extOf(name))) files.push(path)
    }
  }
  walkAll(root)
  const live = validateLiveWrite(join(root, "live-write"))
  problems.push(...live.problems.map((p) => `live-write/${p}`))
  for (const path of files) {
    const rel = relative(root, path)
    const [area, bundle, ...inside] = rel.split(/[\\/]/)
    if (area === "live-write" && inside.length > 0 && Object.hasOwn(live.bundles, bundle) && live.bundles[bundle].ok) continue
    for (const f of scanEvidenceText(rel, readFileSync(path, "utf8"))) problems.push(`${rel}: ${f.kind} (${f.detail})`)
  }
  return { files, problems }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i <= 0 ? "" : name.slice(i)
}
