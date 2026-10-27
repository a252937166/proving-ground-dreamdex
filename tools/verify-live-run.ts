// Independent read-back of one live run (src/margin-rescue/verify.ts). Read-only.
//
//   npm run mr:verify-run -- --run DIR --approved <sha256> [--plan FILE] [--block N] [--rpc URL] [--out DIR]
//
// --approved is the SHA-256 of the plan the owner approved, given from outside the run
// (the approval itself): the run's files could name any plan. --plan defaults to
// DIR/live-plan.json (a published bundle) or ./live-plan.json. Writes
// verification.json and verification.txt to --out (default: the run folder; a published
// bundle is never written into: it changes only by publishing again). Exit 0 only when
// every check holds, 3 when one fails, 1 when the run cannot be read.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { loadConfig } from "../src/config.js"
import { indexerWatermark, readAgain, stopLister } from "../src/margin-rescue/common.js"
import { prettyJson, writeFileAtomic } from "../src/margin-rescue/json.js"
import { MANIFEST } from "../src/margin-rescue/publication.js"
import { createHidekiClient } from "../src/margin-rescue/rpc.js"
import { renderVerification, verifyRun } from "../src/margin-rescue/verify.js"

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { run: { type: "string" }, approved: { type: "string" }, plan: { type: "string" }, block: { type: "string" }, rpc: { type: "string" }, out: { type: "string" } } })
  if (!values.run) throw new Error("--run DIR is required")
  if (!values.approved || !/^[0-9a-f]{64}$/i.test(values.approved)) throw new Error("--approved <sha256> is required: the digest of the plan the owner approved")
  const out = values.out ?? values.run
  if (existsSync(join(out, MANIFEST))) throw new Error(`${out} is a published bundle; write the verification elsewhere with --out (and publish again from the run folder)`)
  const cfg = loadConfig()
  const rpc = values.rpc ?? cfg.rpcUrl
  const report = await verifyRun({
    dir: values.run,
    plan: values.plan ?? (existsSync(join(values.run, "live-plan.json")) ? join(values.run, "live-plan.json") : "live-plan.json"),
    client: createHidekiClient(rpc, { timeoutMs: 120_000 }),
    indexer: { watermark: () => readAgain(() => indexerWatermark(cfg.indexerUrl)), listStops: stopLister(cfg.indexerUrl) },
    rpc,
    block: values.block ? BigInt(values.block) : undefined,
    approvedDigest: values.approved,
  })
  writeFileAtomic(join(out, "verification.json"), prettyJson(report))
  writeFileAtomic(join(out, "verification.txt"), renderVerification(report))
  console.log(renderVerification(report))
  return report.verdict.allChecksHold ? 0 : 3
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`)
    process.exit(1)
  },
)
