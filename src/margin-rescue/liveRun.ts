// The live execution of ONE approved plan (see executor.ts for the steps). It refuses
// to start unless --approve is the SHA-256 of the exact plan file, the key in
// MR_SIGNER_KEY belongs to the plan's account, the chain is 50383, and the local guard
// build hashes to what the plan approved. It never prints or writes the key or any
// signed bytes.
//
//   MR_SIGNER_KEY=0x… npm run mr:live -- --plan live-plan.json --approve <sha256> [--out DIR] [--rpc URL]
//   MR_SIGNER_KEY=0x… npm run mr:live -- --plan live-plan.json --approve <sha256> --out DIR --resume
//
// Exit codes: 0 complete (guarded reduction GOAL_MET and cleanup verified); 10 cleanup
// verified but the reduction was not demonstrated; 20 aborted, cleanup verified; 30
// cleanup not verified; 40 a transaction is unresolved (resume later); 1 refused to
// start (nothing sent).
//
// It has been exercised only on local forks (forkRehearsal.ts). On the live network it
// must not be run without the owner's explicit approval of that exact plan file.
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains"
import { stopLister } from "./common.js"
import { runLive } from "./executor.js"
import { readApprovedPlan } from "./livePlan.js"
import { createHidekiClient } from "./rpc.js"

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { plan: { type: "string" }, approve: { type: "string" }, rpc: { type: "string" }, out: { type: "string" }, resume: { type: "boolean", default: false } } })
  if (!values.plan || !values.approve) throw new Error("--plan and --approve are required")
  if (values.resume && !values.out) throw new Error("--resume needs the --out directory of the run")
  const { plan, digest } = readApprovedPlan(values.plan, values.approve)
  const key = process.env.MR_SIGNER_KEY as Hex | undefined
  if (!key) throw new Error("MR_SIGNER_KEY is not set")
  const signer = privateKeyToAccount(key)
  const rpc = values.rpc ?? hidekiTestnet.rpcUrls.default.http[0]
  const out = values.out ?? join("evidence", "margin-rescue", "live-write", `run-${Date.now()}`)
  mkdirSync(out, { recursive: true })
  const log = (entry: Record<string, unknown>) => {
    const line = JSON.stringify(entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    appendFileSync(join(out, "run-log.jsonl"), line + "\n")
    console.log(line)
  }
  log({ step: "start", planDigest: digest, account: signer.address, rpc, out, resume: values.resume })
  const result = await runLive({
    plan,
    planDigest: digest,
    client: createHidekiClient(rpc, { timeoutMs: 600_000 }),
    signer,
    out,
    listStops: stopLister(),
    resume: values.resume,
    log,
  })
  console.log(`\n${result.status} (exit ${result.exitCode})${result.reason ? `: ${result.reason}` : ""}\nevidence: ${out}`)
  return result.exitCode
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
