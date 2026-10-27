// The publication boundary of live evidence (publication.ts, endpoints.ts, paths.ts).
// FIXTURE TESTS: run folders made up in a temporary repository with throwaway keys; no
// network. The static build calls evidenceToPublish, so its bypass attempts are tested
// here against that function.
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { keccak256, parseGwei } from "viem"
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { describeEndpoint, isPublicEndpoint } from "../../src/margin-rescue/endpoints.js"
import { sha256Hex } from "../../src/margin-rescue/json.js"
import { privateOutDir, RefusedError } from "../../src/margin-rescue/paths.js"
import { evidenceToPublish, MANIFEST, publishRun, renderReport, REPORT, scanEvidenceText, validateBundle, type Manifest } from "../../src/margin-rescue/publication.js"

const RPC = "https://api.hideki2.infra.testnet.somnia.network"
const TYPES = new Set([".txt", ".json", ".jsonl", ".md", ""])

async function repo(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mr-pub-"))
  const key = generatePrivateKey()
  const signer = privateKeyToAccount(key)
  const signed = await signer.signTransaction({ chainId: 50383, type: "legacy", to: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394", data: `0xb6b55f25${"00".repeat(32)}`, gas: 100_000n, gasPrice: parseGwei("6"), nonce: 0, value: 0n })
  const from = join(root, ".margin-rescue", "live", "run-1")
  const to = join(root, "evidence", "margin-rescue", "live-write", "run-1")
  mkdirSync(join(from, "journal"), { recursive: true })
  mkdirSync(join(root, "evidence", "margin-rescue", "live-write"), { recursive: true })
  writeFileSync(join(root, "evidence", "margin-rescue", "live-write", "README.md"), "# live-write\n")
  const plan = join(root, "live-plan.json")
  writeFileSync(plan, JSON.stringify({ version: "mr-live-plan/4", network: { chainId: 50383 }, account: { address: signer.address } }))
  const digest = sha256Hex(readFileSync(plan))
  const files: Record<string, string> = {
    "run-ledger.json": JSON.stringify({ planDigest: digest, account: signer.address, chainId: "50383", steps: [{ n: 1, id: "deposit", hash: keccak256(signed), dataKeccak: keccak256("0x00") }] }, null, 2),
    "run-state.json": JSON.stringify({ planDigest: digest, account: signer.address }),
    "run-log.jsonl": JSON.stringify({ step: "start", rpc: RPC, out: ".margin-rescue/live/run-1" }) + "\n",
    "result.json": JSON.stringify({ status: "COMPLETE", exitCode: 0 }),
    [`journal/${keccak256("0x01")}.json`]: JSON.stringify({ calldata: `0x${"ab".repeat(228)}`, blockHash: keccak256("0x02") }),
    "notes.tmp": "scratch",
    ...extra,
  }
  for (const [f, body] of Object.entries(files)) writeFileSync(join(from, f), body)
  return { root, from, to, plan, key, signed, address: signer.address }
}

// Rewrite a published file and its manifest entry (and the report the manifest renders),
// as someone covering their tracks would.
function forge(dir: string, file: string, body: string) {
  writeFileSync(join(dir, file), body)
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest
  m.files[file] = { ...(m.files[file] ?? { original: null, changes: [] }), published: sha256Hex(body) }
  const report = renderReport(m)
  m.files[REPORT].published = sha256Hex(report)
  writeFileSync(join(dir, REPORT), report)
  writeFileSync(join(dir, MANIFEST), JSON.stringify(m, null, 2) + "\n")
}

describe("publishing a run's evidence", () => {
  it("copies the run's files unchanged with a manifest and a report; the bundle passes its check; the originals are untouched", async () => {
    const r = await repo()
    const before = sha256Hex(readFileSync(join(r.from, "run-ledger.json")))
    const p = publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root })
    assert.ok(p.ok, p.problems.join("; "))
    assert.deepEqual(p.leftOut, ["notes.tmp"])
    assert.ok(!existsSync(join(r.to, "notes.tmp")))
    assert.equal(readFileSync(join(r.to, "run-ledger.json"), "utf8"), readFileSync(join(r.from, "run-ledger.json"), "utf8"))
    assert.equal(readFileSync(join(r.to, "live-plan.json"), "utf8"), readFileSync(r.plan, "utf8"))
    const m = JSON.parse(readFileSync(join(r.to, MANIFEST), "utf8")) as Manifest
    assert.equal(m.files["run-ledger.json"].original, before)
    assert.equal(m.files["run-ledger.json"].published, before)
    assert.equal(readFileSync(join(r.to, REPORT), "utf8"), renderReport(m))
    assert.ok(validateBundle(r.to).ok)
    assert.equal(sha256Hex(readFileSync(join(r.from, "run-ledger.json"))), before, "the private original is unchanged")
  })

  it("refuses the whole run when any file holds the signing key, with or without 0x; nothing is written", async () => {
    for (const k of ["0x", ""]) {
      const r = await repo()
      writeFileSync(join(r.from, "analysis.txt"), `debug ${k ? r.key : r.key.slice(2)}\n`)
      const p = publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root })
      assert.ok(!p.ok)
      assert.deepEqual(p.fatal.map((x) => [x.file, x.kind]), [["analysis.txt", "signing key"]])
      assert.ok(!existsSync(r.to))
    }
  })

  it("refuses signed transaction bytes, of the run or not, and a mnemonic", async () => {
    const r = await repo({ "recompute.txt": `words: ${generateMnemonic(english)}\n` })
    writeFileSync(join(r.from, "receipt.json"), JSON.stringify({ raw: r.signed }))
    const other = await privateKeyToAccount(generatePrivateKey()).signTransaction({ chainId: 50383, type: "legacy", to: r.address, data: `0x${"11".repeat(100)}`, gas: 21_000n, gasPrice: 1n, nonce: 3, value: 0n })
    writeFileSync(join(r.from, "cleanup.json"), JSON.stringify({ note: other }))
    const p = publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root })
    assert.deepEqual(p.fatal.map((x) => `${x.file}: ${x.kind}`).sort(), ["cleanup.json: signed transaction", "receipt.json: signed transaction", "recompute.txt: mnemonic"])
    assert.ok(!existsSync(r.to))
  })

  it("does not trust configured endpoints: a private RPC with credentials set through the environment is withheld, as are tokens on public hosts", async () => {
    const env = { HIDEKI_RPC_URL: process.env.HIDEKI_RPC_URL, DREAMDEX_INDEXER_URL: process.env.DREAMDEX_INDEXER_URL }
    process.env.HIDEKI_RPC_URL = "https://alice:s3cret@rpc.private.example/v1/0123456789abcdef0123456789abcdef?apikey=XYZ"
    process.env.DREAMDEX_INDEXER_URL = "https://indexer.private.example/graphql?token=abc"
    try {
      const lines = [
        { step: "start", rpc: process.env.HIDEKI_RPC_URL },
        { step: "stops", indexer: process.env.DREAMDEX_INDEXER_URL },
        { userinfo: `https://bob:pw@${RPC.slice(8)}` },
        { query: `${RPC}/?key=1` },
        { path: `${RPC}/v2/a1b2c3d4e5f6a7b8c9d0e1f2` },
        { public: RPC },
      ]
      const r = await repo({ "run-log.jsonl": lines.map((l) => JSON.stringify(l)).join("\n") + "\n" })
      const p = publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root })
      assert.ok(p.ok, p.problems.join("; "))
      const text = readFileSync(join(r.to, "run-log.jsonl"), "utf8")
      const everything = [text, readFileSync(join(r.to, REPORT), "utf8"), readFileSync(join(r.to, MANIFEST), "utf8")].join("\n")
      for (const secret of ["alice", "s3cret", "rpc.private", "apikey", "XYZ", "indexer.private", "token=abc", "bob:pw", "key=1", "a1b2c3d4e5f6"]) assert.ok(!everything.includes(secret), `${secret} must not be published, in the file, the report or the manifest`)
      assert.equal(text.match(/<url withheld>/g)?.length, 5)
      assert.ok(text.includes(`"public":"${RPC}"`), "the exact public RPC address stays")
      assert.equal(isPublicEndpoint(process.env.HIDEKI_RPC_URL), false)
      assert.equal(describeEndpoint(process.env.HIDEKI_RPC_URL!), "a private endpoint (address withheld)")
    } finally {
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("replaces absolute local paths and records them", async () => {
    const r = await repo({ "run-log.jsonl": JSON.stringify({ step: "start", out: "/Users/someone/project/.margin-rescue/live/run-1" }) + "\n" })
    const p = publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root })
    assert.ok(p.ok)
    const text = readFileSync(join(r.to, "run-log.jsonl"), "utf8")
    const report = readFileSync(join(r.to, REPORT), "utf8")
    assert.ok(!text.includes("someone") && !report.includes("someone") && !report.includes("/Users/"), "neither the copy nor the report shows the path")
    assert.match(report, /`run-log\.jsonl` \| kept privately \(redacted file\) \| `[0-9a-f]{64}` \| 1 local path\(s\) replaced/)
  })

  it("publishes only from a private run folder into evidence/margin-rescue/live-write/run-*", async () => {
    const r = await repo()
    const inEvidence = join(r.root, "evidence", "margin-rescue", "fork", "run-1")
    cpSync(r.from, inEvidence, { recursive: true })
    assert.throws(() => publishRun({ from: inEvidence, to: r.to, plan: r.plan, root: r.root }), RefusedError)
    assert.throws(() => publishRun({ from: r.from, to: join(r.root, "evidence", "margin-rescue", "fork", "run-2"), plan: r.plan, root: r.root }), RefusedError)
    assert.throws(() => publishRun({ from: r.from, to: join(r.root, "evidence", "margin-rescue", "live-write", "notes"), plan: r.plan, root: r.root }), RefusedError)
    assert.throws(() => publishRun({ from: r.from, to: join(r.root, "evidence", "margin-rescue", "live-write", "run-final"), plan: r.plan, root: r.root }), RefusedError, "bundles are numbered")
    writeFileSync(r.plan, "{}")
    assert.throws(() => publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root }), /not the plan this run was started under/)
  })

  it("a run's private folder: the default, outside the repository, never a tracked path", () => {
    const root = mkdtempSync(join(tmpdir(), "mr-paths-"))
    mkdirSync(join(root, ".margin-rescue"))
    assert.equal(privateOutDir(undefined, root, 42), join(root, ".margin-rescue", "live", "run-42"))
    assert.equal(privateOutDir(join(tmpdir(), "elsewhere"), root), join(tmpdir(), "elsewhere"))
    for (const p of ["evidence/margin-rescue/live-write/run-1", "web", ".margin-rescue"]) assert.throws(() => privateOutDir(join(root, p), root), RefusedError, p)
  })
})

describe("what a reviewer tried against the boundary", () => {
  const caseInsensitive = existsSync(tmpdir().toUpperCase())
  it("a case variant of the repository's path is the same folder and is refused", { skip: caseInsensitive ? false : "this file system distinguishes case" }, () => {
    const root = mkdtempSync(join(tmpdir(), "mr-case-"))
    mkdirSync(join(root, ".margin-rescue"))
    mkdirSync(join(root, "evidence", "margin-rescue", "fork"), { recursive: true })
    assert.throws(() => privateOutDir(join(root.toUpperCase(), "evidence", "margin-rescue", "fork", "run-x"), root), RefusedError)
    assert.throws(() => privateOutDir(join(root, "EVIDENCE", "margin-rescue", "fork", "run-x"), root), RefusedError)
  })

  it("a .margin-rescue that is a symbolic link is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "mr-link-"))
    mkdirSync(join(root, "evidence", "margin-rescue", "fork"), { recursive: true })
    symlinkSync(join(root, "evidence", "margin-rescue", "fork"), join(root, ".margin-rescue"))
    assert.throws(() => privateOutDir(join(root, ".margin-rescue", "live", "run-1"), root), /symbolic link/)
  })

  it("a token hidden by .. or %2e%2e in a URL is withheld, and only the exact public text passes", async () => {
    for (const u of [`${RPC}/SECRET0123456789/..`, `${RPC}/tok3n/%2e%2e`, "https://hideki-dev.smk.somnia.host/v1/tok3n/../graphql", `${RPC}\\tok3n`]) assert.equal(isPublicEndpoint(u), false, u)
    assert.equal(isPublicEndpoint(`${RPC}/`), true)
    const r = await repo({ "run-log.jsonl": JSON.stringify({ rpc: `${RPC}/SECRET0123456789/..` }) + "\n" })
    assert.ok(publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root }).ok)
    assert.ok(!readFileSync(join(r.to, "run-log.jsonl"), "utf8").includes("SECRET"))
  })

  it("absolute paths under any system root are replaced, not only /Users and /home", async () => {
    const r = await repo({ "cleanup.json": JSON.stringify({ reason: "EACCES: permission denied, open '/Volumes/Work/mr-runs/run-1/result.json'", other: "/opt/mr/run", win: "C:/Users/bob/run", win2: "D:\\runs\\r1" }) })
    assert.ok(publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root }).ok)
    const text = readFileSync(join(r.to, "cleanup.json"), "utf8")
    for (const leak of ["Volumes", "/opt/", "bob", "runs"]) assert.ok(!text.includes(leak), `${leak}: ${text}`)
  })

  it("a redacted file's original hash is not published (it would let anyone test guesses); the private provenance record keeps it", async () => {
    const r = await repo({ "run-log.jsonl": JSON.stringify({ out: "/home/alice/run" }) + "\n" })
    const original = sha256Hex(readFileSync(join(r.from, "run-log.jsonl")))
    assert.ok(publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root }).ok)
    const m = JSON.parse(readFileSync(join(r.to, MANIFEST), "utf8")) as Manifest
    assert.equal(m.files["run-log.jsonl"].original, null)
    assert.ok(!readFileSync(join(r.to, MANIFEST), "utf8").includes(original) && !readFileSync(join(r.to, REPORT), "utf8").includes(original))
    const records = readdirSync(join(r.root, ".margin-rescue", "publications"))
    assert.equal(JSON.parse(readFileSync(join(r.root, ".margin-rescue", "publications", records[0]), "utf8")).originals["run-log.jsonl"], original)
  })

  it("a mnemonic is found however it is written down; JSON keys and values, or a wrong checksum, are not one", () => {
    const words = generateMnemonic(english).split(" ")
    const kinds = (t: string) => scanEvidenceText("x", t).map((f) => f.kind)
    for (const [how, text] of [
      ["capitalised", words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")],
      ["in capitals", words.join(" ").toUpperCase()],
      ["one word per line", words.join("\n")],
      ["tabs and runs of spaces", words.join(" \t  ")],
      ["a JSON array", JSON.stringify({ backup: words })],
      ["an indented JSON array", JSON.stringify({ backup: words }, null, 2)],
      ["escaped line breaks inside a JSON string", JSON.stringify({ note: words.join("\n") })],
      ["a numbered list", words.map((w, i) => `${i + 1}. ${w}`).join("\n")],
      ["numbered on one line", words.map((w, i) => `${i + 1}) ${w}`).join(" ")],
      ["bullets", words.map((w) => `- ${w}`).join("\n")],
      ["commas", words.join(", ")],
      ["a table", words.map((w, i) => `| ${i + 1} | ${w} |`).join("\n")],
    ] as const) assert.deepEqual(kinds(text), ["mnemonic"], how)
    const pairs = Object.fromEntries(words.map((w, i) => [w, words[(i + 1) % words.length]]))
    assert.deepEqual(kinds(JSON.stringify(pairs, null, 2)), [], "the words as JSON keys and values")
    const last = english.indexOf(words[11])
    const wrong = [...words.slice(0, 11), english[last ^ 1]] // the same entropy, the checksum's last bit flipped
    assert.deepEqual(kinds(wrong.join(" ")), [], "a checksum that fails")
  })

  it("a malformed manifest is a failed check, never an exception", async () => {
    const r = await repo()
    assert.ok(publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root }).ok)
    for (const bad of ['{"version":"mr-publication/1","files":{},"run":{}}', '{"version":"mr-publication/1","files":{"x":null},"run":{"account":1}}', "[]", "null"]) {
      writeFileSync(join(r.to, MANIFEST), bad)
      const v = validateBundle(r.to)
      assert.equal(v.ok, false, bad)
    }
  })
})

describe("the static build's evidence gate (evidenceToPublish, validateBundle)", () => {
  const roots: string[] = []
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
  const published = async () => {
    const r = await repo()
    roots.push(r.root)
    assert.ok(publishRun({ from: r.from, to: r.to, plan: r.plan, root: r.root }).ok)
    const gate = () => evidenceToPublish(join(r.root, "evidence", "margin-rescue"), TYPES).problems
    assert.deepEqual(gate(), [])
    return { ...r, gate }
  }

  it("a raw run folder copied into live-write/ stops the build", async () => {
    const r = await published()
    cpSync(r.from, join(r.root, "evidence", "margin-rescue", "live-write", "run-2"), { recursive: true })
    assert.ok(r.gate().some((p) => /run-2\/: no PUBLICATION\.json/.test(p)))
  })

  it("a marker is not enough: an empty manifest, or another bundle's manifest, stops the build", async () => {
    const r = await published()
    const raw = join(r.root, "evidence", "margin-rescue", "live-write", "run-2")
    cpSync(r.from, raw, { recursive: true })
    writeFileSync(join(raw, MANIFEST), "{}")
    assert.ok(r.gate().some((p) => /run-2\/: PUBLICATION\.json is not mr-publication\/1/.test(p)))
    cpSync(join(r.to, MANIFEST), join(raw, MANIFEST))
    cpSync(join(r.to, REPORT), join(raw, REPORT))
    assert.ok(r.gate().some((p) => /run-2\/: (notes\.tmp is not in PUBLICATION\.json|live-plan\.json is listed in PUBLICATION\.json but missing)/.test(p)))
  })

  it("an extra file, an altered file or an edited report stops the build", async () => {
    const r = await published()
    writeFileSync(join(r.to, "extra.json"), "{}")
    assert.ok(r.gate().some((p) => /extra\.json is not in PUBLICATION\.json/.test(p)))
    rmSync(join(r.to, "extra.json"))
    writeFileSync(join(r.to, "result.json"), JSON.stringify({ status: "COMPLETE", exitCode: 0, note: "edited" }))
    assert.ok(r.gate().some((p) => /result\.json differs from its SHA-256/.test(p)))
    const r2 = await published()
    writeFileSync(join(r2.to, REPORT), readFileSync(join(r2.to, REPORT), "utf8") + "\nAll good.\n")
    assert.ok(r2.gate().some((p) => /SANITIZATION\.md (is not the report|differs from its SHA-256)/.test(p)))
  })

  it("a self-consistent forgery is still scanned: the key, a local path or a private URL behind recomputed hashes stops the build", async () => {
    const cases = [(k: string) => `{"k":"${k}"}`, () => `{"out":"/home/someone/run"}`, () => `{"rpc":"https://user:pw@rpc.example/x"}`]
    const kinds = ["signing key", "local path", "private url"]
    for (let i = 0; i < cases.length; i++) {
      const r = await published()
      forge(r.to, "cleanup.json", cases[i](r.key))
      assert.ok(r.gate().some((p) => p.includes(`cleanup.json: ${kinds[i]}`)), kinds[i])
    }
    const r = await published()
    const m = JSON.parse(readFileSync(join(r.to, MANIFEST), "utf8"))
    m.tool = `publisher ${r.key}`
    writeFileSync(join(r.to, MANIFEST), JSON.stringify(m))
    assert.ok(r.gate().some((p) => p.includes("PUBLICATION.json: signing key")), "the manifest itself is scanned")
  })

  it("a bundle whose files disagree (another account in the ledger, behind recomputed hashes) stops the build", async () => {
    const r = await published()
    const ledger = JSON.parse(readFileSync(join(r.to, "run-ledger.json"), "utf8"))
    ledger.account = privateKeyToAccount(generatePrivateKey()).address
    forge(r.to, "run-ledger.json", JSON.stringify(ledger))
    assert.ok(r.gate().some((p) => /name different accounts/.test(p)))
  })

  it("symbolic links and stray files stop the build", async () => {
    const r = await published()
    symlinkSync("/etc/hosts", join(r.to, "hosts.json"))
    assert.ok(r.gate().some((p) => /symbolic link/.test(p)))
    const r2 = await published()
    writeFileSync(join(r2.root, "evidence", "margin-rescue", "live-write", "notes.json"), "{}")
    assert.ok(r2.gate().some((p) => /only README\.md and published bundles/.test(p)))
    const r3 = await published()
    symlinkSync("/etc/hosts", join(r3.root, "evidence", "margin-rescue", "hosts.txt"))
    assert.ok(r3.gate().some((p) => /hosts\.txt: a symbolic link/.test(p)))
  })

  it("a folder in live-write/ not named run-<number> stops the build, even holding a valid bundle", async () => {
    const r = await published()
    cpSync(r.to, join(r.root, "evidence", "margin-rescue", "live-write", "latest"), { recursive: true })
    assert.ok(r.gate().some((p) => /latest\/: a bundle folder is named run-<number>/.test(p)), r.gate().join("; "))
  })

  it("other evidence is scanned too, while local fork RPC addresses stay allowed", () => {
    assert.deepEqual(scanEvidenceText("fork/run-log.jsonl", JSON.stringify({ rpc: "http://127.0.0.1:8550" })), [])
    const kinds = (t: string) => scanEvidenceText("x", t).map((f) => f.kind)
    assert.deepEqual(kinds(`{"rpc":"https://u:p@rpc.example"}`), ["private url"])
    assert.deepEqual(kinds(`{"rpc":"https://rpc.example/?apikey=1"}`), ["private url"])
    assert.deepEqual(kinds(`{"out":"/Users/someone/x"}`), ["local path"])
    assert.deepEqual(kinds(generateMnemonic(english)), ["mnemonic"])
  })
})
