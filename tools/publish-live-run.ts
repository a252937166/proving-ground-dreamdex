// Publish one live run's evidence. `npm run mr:live` writes its run folder to a private,
// git-ignored place; this copies it into evidence/margin-rescue/live-write/<run>/ file by
// file, after scanning every file for what must never be published:
//   - the signed bytes of any of the run's transactions (a hex string whose keccak is a
//     transaction hash in the run ledger, or any hex string that parses as a signed
//     transaction)
//   - the signing key (any 32-byte hex value from which the run's account derives)
//   - a BIP-39 mnemonic (12 or more consecutive words of the English list)
//   - an absolute local path, or a URL other than the public Hideki RPC and indexer
// A signed transaction, the key or a mnemonic stops the publication and nothing is
// written. Paths and other URLs are replaced, and SANITIZATION.md lists every replacement
// with the SHA-256 of the original and of the published copy. Only the files the executor
// and the verifier write are published; anything else is left out and listed. The
// originals stay where they are.
//
//   npm run mr:publish-run -- --from .margin-rescue/live/run-1 --to evidence/margin-rescue/live-write/run-1 [--plan live-plan.json] [--replace]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { keccak256, parseTransaction, type Hex } from "viem"
import { english, privateKeyToAccount } from "viem/accounts"
import { loadConfig } from "../src/config.js"
import { sha256Hex } from "../src/margin-rescue/json.js"

// What `npm run mr:live` (executor.ts, cleanup.ts, liveRun.ts) and tools/verify-live-run.ts write.
const KNOWN = [
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

export interface Finding {
  file: string
  kind: string
  detail: string
}

export interface PublishResult {
  published: string[]
  leftOut: string[]
  fatal: Finding[]
  replaced: Finding[]
}

export function publishRun(opts: { from: string; to: string; plan: string; replace?: boolean; publicUrls?: string[] }): PublishResult {
  const { from, to } = opts
  if (existsSync(to) && !opts.replace) throw new Error(`${to} exists; pass --replace to publish again from ${from}`)
  const ledger = JSON.parse(readFileSync(join(from, "run-ledger.json"), "utf8")) as { planDigest: string; account: string; steps: { hash: string }[] }
  const account = ledger.account.toLowerCase()
  const txHashes = new Set(ledger.steps.map((s) => s.hash.toLowerCase()))
  const planBytes = readFileSync(opts.plan)
  if (sha256Hex(planBytes) !== ledger.planDigest) throw new Error(`${opts.plan} (SHA-256 ${sha256Hex(planBytes)}) is not the plan this run was started under (${ledger.planDigest})`)
  const cfg = loadConfig()
  const publicUrls = opts.publicUrls ?? [cfg.rpcUrl, cfg.wsUrl, cfg.indexerUrl]

  const all = walk(from).map((f) => relative(from, f))
  const files = all.filter((f) => KNOWN.some((k) => k.test(f)))
  const leftOut = all.filter((f) => !files.includes(f))

  const fatal: Finding[] = []
  const replaced: Finding[] = []
  const counts = { longHex: 0, keyCandidates: 0, words: 0 }
  const keyChecked = new Map<string, boolean>()
  const words = new Set(english)
  const out = new Map<string, { original: Buffer; bytes: Buffer }>()

  for (const file of [...files, "live-plan.json"]) {
    const original = file === "live-plan.json" ? planBytes : readFileSync(join(from, file))
    const text = original.toString("utf8")
    // Never published: signed transactions, the key, a mnemonic.
    for (const m of text.matchAll(/(?:0[xX])?[0-9a-fA-F]{64,}/g)) {
      const hex = (/^0x/i.test(m[0]) ? m[0].slice(2) : m[0]).toLowerCase()
      if (hex.length === 64) {
        counts.keyCandidates++
        if (!keyChecked.has(hex)) {
          let derives = false
          try {
            derives = privateKeyToAccount(`0x${hex}`).address.toLowerCase() === account
          } catch {
            // not a valid secp256k1 scalar
          }
          keyChecked.set(hex, derives)
        }
        if (keyChecked.get(hex)) fatal.push({ file, kind: "signing key", detail: `a 32-byte value at offset ${m.index} derives the account` })
      } else if (hex.length >= 160 && hex.length % 2 === 0) {
        counts.longHex++
        if (txHashes.has(keccak256(`0x${hex}`).toLowerCase())) fatal.push({ file, kind: "signed transaction", detail: `bytes at offset ${m.index} hash to a transaction of this run` })
        else {
          try {
            const tx = parseTransaction(`0x${hex}` as Hex)
            if (tx.r !== undefined && tx.s !== undefined) fatal.push({ file, kind: "signed transaction", detail: `bytes at offset ${m.index} parse as a signed transaction` })
          } catch {
            // calldata or code, not a transaction
          }
        }
      }
    }
    let run = 0
    for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      counts.words++
      run = words.has(w) ? run + 1 : 0
      if (run === 12) fatal.push({ file, kind: "mnemonic", detail: "12 consecutive BIP-39 words" })
    }
    // Replaced: absolute local paths, and URLs other than the public endpoints.
    let clean = text.replace(/(?:\/Users|\/home|\/private|\/var\/folders|\/tmp)\/[^\s"',)]*/g, (p) => {
      replaced.push({ file, kind: "local path", detail: p.replace(/^\/(Users|home)\/[^/]+/, "/$1/<user>").slice(0, 80) })
      return "<local path>"
    })
    clean = clean.replace(/\b(?:https?|wss?):\/\/[^\s"',)]+/g, (u) => {
      if (publicUrls.some((p) => u === p || u.startsWith(`${p}/`))) return u
      let host = "unparsable"
      try {
        host = new URL(u).host
      } catch {
        // keep "unparsable"
      }
      replaced.push({ file, kind: "url", detail: host })
      return "<url withheld>"
    })
    out.set(file, { original, bytes: clean === text ? original : Buffer.from(clean, "utf8") })
  }

  if (fatal.length) return { published: [], leftOut, fatal, replaced }

  if (existsSync(to)) rmSync(to, { recursive: true })
  for (const [file, { bytes }] of out) {
    mkdirSync(dirname(join(to, file)), { recursive: true })
    writeFileSync(join(to, file), bytes)
  }
  const rows = [...out.entries()].map(([file, { original, bytes }]) => {
    const changes = replaced.filter((r) => r.file === file)
    const a = sha256Hex(original)
    const b = sha256Hex(bytes)
    return `| \`${file}\` | \`${a}\` | ${a === b ? "same" : `\`${b}\``} | ${changes.map((c) => `${c.kind} replaced (${c.detail})`).join("; ") || "copied unchanged"} |`
  })
  const md = [
    "# Publication of this run's evidence",
    "",
    "`npm run mr:live` wrote this run to a private, git-ignored folder. `tools/publish-live-run.ts` copied it here after scanning every file; the originals are kept unchanged outside the repository. `live-plan.json` is the plan file the run was started under (its SHA-256 is the run's plan digest).",
    "",
    "Scanned for, and not found (any one of them stops the publication):",
    "",
    `- signed transaction bytes: ${counts.longHex} hex strings of 80 bytes or more were hashed and compared with the ${txHashes.size} transaction hashes in the run ledger, and parsed as transactions`,
    `- the signing key: ${keyChecked.size} distinct 32-byte values (${counts.keyCandidates} occurrences) were each tried as a private key; none derives the account \`${ledger.account}\``,
    `- a BIP-39 mnemonic: ${counts.words} words checked for 12 consecutive words of the English list`,
    "",
    "Replaced: absolute local paths, and URLs other than the public Hideki RPC and dreamDEX indexer.",
    "",
    "| File | SHA-256 of the original | SHA-256 here | Changes |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    leftOut.length ? `Left out (not written by the executor or the verifier): ${leftOut.map((f) => `\`${f}\``).join(", ")}.` : "Nothing was left out.",
    "",
  ].join("\n")
  writeFileSync(join(to, "SANITIZATION.md"), md)
  return { published: [...out.keys()], leftOut, fatal, replaced }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, plan: { type: "string", default: "live-plan.json" }, replace: { type: "boolean", default: false } } })
    if (!values.from || !values.to) throw new Error("--from and --to are required")
    const r = publishRun({ from: values.from, to: values.to, plan: values.plan!, replace: values.replace })
    if (r.fatal.length) {
      console.error("NOT PUBLISHED: the run folder holds material that must never be published:")
      for (const f of r.fatal) console.error(`  ${f.file}: ${f.kind}: ${f.detail}`)
      process.exit(2)
    }
    console.log(`published ${r.published.length} files to ${values.to}; ${r.replaced.length} replacement(s); left out: ${r.leftOut.join(", ") || "none"}`)
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
