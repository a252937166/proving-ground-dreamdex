// Publishing a live run's evidence (tools/publish-live-run.ts). FIXTURE TESTS: a run
// folder made up in a temp directory with a throwaway key; no network.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { keccak256, parseGwei } from "viem"
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { sha256Hex } from "../../src/margin-rescue/json.js"
import { publishRun } from "../../tools/publish-live-run.js"

const RPC = "https://api.hideki2.infra.testnet.somnia.network"

async function fixture(extra: Record<string, string> = {}) {
  const key = generatePrivateKey()
  const signer = privateKeyToAccount(key)
  const signed = await signer.signTransaction({ chainId: 50383, type: "legacy", to: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394", data: `0xb6b55f25${"00".repeat(32)}`, gas: 100_000n, gasPrice: parseGwei("6"), nonce: 0, value: 0n })
  const dir = mkdtempSync(join(tmpdir(), "mr-publish-"))
  const from = join(dir, "run")
  mkdirSync(join(from, "journal"), { recursive: true })
  const plan = join(dir, "live-plan.json")
  writeFileSync(plan, JSON.stringify({ version: "mr-live-plan/3", account: { address: signer.address } }))
  const files: Record<string, string> = {
    "run-ledger.json": JSON.stringify({ planDigest: sha256Hex(readFileSync(plan)), account: signer.address, steps: [{ n: 1, id: "deposit", hash: keccak256(signed), dataKeccak: keccak256("0x00") }] }, null, 2),
    "run-log.jsonl": JSON.stringify({ step: "start", rpc: RPC, out: "run" }) + "\n",
    "result.json": JSON.stringify({ status: "COMPLETE", exitCode: 0 }),
    [`journal/${keccak256("0x01")}.json`]: JSON.stringify({ calldata: `0x${"ab".repeat(228)}`, blockHash: keccak256("0x02") }),
    "notes.tmp": "scratch",
    ...extra,
  }
  for (const [f, body] of Object.entries(files)) writeFileSync(join(from, f), body)
  return { dir, from, to: join(dir, "published"), plan, key, signed, address: signer.address }
}

describe("publishing a live run", () => {
  it("copies the executor's files unchanged, adds the plan, leaves out the rest and lists every file", async () => {
    const f = await fixture()
    const r = publishRun({ from: f.from, to: f.to, plan: f.plan, publicUrls: [RPC] })
    assert.deepEqual(r.fatal, [])
    assert.deepEqual(r.leftOut, ["notes.tmp"])
    for (const file of ["run-ledger.json", "run-log.jsonl", "result.json", "live-plan.json"]) assert.ok(existsSync(join(f.to, file)), file)
    assert.ok(!existsSync(join(f.to, "notes.tmp")))
    assert.equal(readFileSync(join(f.to, "run-log.jsonl"), "utf8"), readFileSync(join(f.from, "run-log.jsonl"), "utf8"))
    const md = readFileSync(join(f.to, "SANITIZATION.md"), "utf8")
    assert.match(md, /`run-ledger\.json` \| `[0-9a-f]{64}` \| same \| copied unchanged/)
    assert.match(md, /Left out .*`notes\.tmp`/)
  })

  it("refuses the whole run when any file holds the signing key, with or without 0x", async () => {
    for (const form of ["0x", ""]) {
      const f = await fixture()
      const k = form ? f.key : f.key.slice(2)
      writeFileSync(join(f.from, "analysis.txt"), `debug ${k}\n`)
      const r = publishRun({ from: f.from, to: f.to, plan: f.plan, publicUrls: [RPC] })
      assert.deepEqual(r.fatal.map((x) => [x.file, x.kind]), [["analysis.txt", "signing key"]])
      assert.ok(!existsSync(f.to), "nothing is written")
    }
  })

  it("refuses the run when a file holds the signed bytes of a transaction, in the ledger or not", async () => {
    const f = await fixture()
    writeFileSync(join(f.from, "receipt.json"), JSON.stringify({ raw: f.signed }))
    const other = await privateKeyToAccount(generatePrivateKey()).signTransaction({ chainId: 50383, type: "legacy", to: f.address, data: `0x${"11".repeat(100)}`, gas: 21_000n, gasPrice: 1n, nonce: 3, value: 0n })
    writeFileSync(join(f.from, "cleanup.json"), JSON.stringify({ note: other }))
    const r = publishRun({ from: f.from, to: f.to, plan: f.plan, publicUrls: [RPC] })
    assert.deepEqual(r.fatal.map((x) => `${x.file}: ${x.kind}`).sort(), ["cleanup.json: signed transaction", "receipt.json: signed transaction"])
    assert.ok(!existsSync(f.to))
  })

  it("refuses a mnemonic but not ordinary calldata or hashes", async () => {
    const f = await fixture({ "recompute.txt": `words: ${generateMnemonic(english)}\n` })
    const r = publishRun({ from: f.from, to: f.to, plan: f.plan, publicUrls: [RPC] })
    assert.deepEqual(r.fatal.map((x) => [x.file, x.kind]), [["recompute.txt", "mnemonic"]])
  })

  it("replaces local paths and non-public URLs, and records both", async () => {
    const f = await fixture({ "run-log.jsonl": JSON.stringify({ step: "start", rpc: "https://rpc.example.org/v1/0123secret", out: "/Users/someone/project/run" }) + "\n" })
    const r = publishRun({ from: f.from, to: f.to, plan: f.plan, publicUrls: [RPC] })
    assert.deepEqual(r.fatal, [])
    const text = readFileSync(join(f.to, "run-log.jsonl"), "utf8")
    assert.ok(!text.includes("someone") && !text.includes("secret") && !text.includes("example.org"), text)
    assert.match(text, /"rpc":"<url withheld>"/)
    assert.match(text, /"out":"<local path>"/)
    assert.deepEqual(r.replaced.map((x) => x.kind).sort(), ["local path", "url"])
    assert.match(readFileSync(join(f.to, "SANITIZATION.md"), "utf8"), /`run-log\.jsonl` \| `[0-9a-f]{64}` \| `[0-9a-f]{64}` \| (local path|url) replaced/)
  })

  it("refuses a plan file that is not the run's", async () => {
    const f = await fixture()
    writeFileSync(f.plan, "{}")
    assert.throws(() => publishRun({ from: f.from, to: f.to, plan: f.plan, publicUrls: [RPC] }), /not the plan this run was started under/)
  })
})
