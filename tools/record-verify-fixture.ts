// Records the fixture of the independent verifier's unit tests (test/unit/mr-verify.test.ts):
// the live command run once on a local anvil fork of Hideki (the real venue contracts; a
// throwaway key generated in memory and never written), then every JSON-RPC answer the
// verifier needs for that run. test/fixtures/verify-fork-run.json.gz holds the run folder,
// the plan and those answers; the tests replay them, unaltered and tampered. Fork only:
// nothing reaches Hideki.
//
//   SHIM_CACHE=1 node tools/rpc-shim.mjs 8556 &
//   (cd contracts && forge build)
//   npx tsx tools/record-verify-fixture.ts --block N [--upstream http://127.0.0.1:8556] [--port 8553]
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseArgs } from "node:util"
import { gzipSync } from "node:zlib"
import { createPublicClient, custom, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { defineChain, hidekiTestnet } from "@somnia-chain/markets-sdk/chains"
import { USDSO } from "../src/margin-rescue/common.js"
import { startAnvil, stopAnvil, waitReceipt } from "../src/margin-rescue/forkTools.js"
import { prettyJson, sha256Hex } from "../src/margin-rescue/json.js"
import { buildLivePlan, DEFAULT_PLAN, TEST_EOA } from "../src/margin-rescue/livePlan.js"
import { createHidekiClient, sampleBlock } from "../src/margin-rescue/rpc.js"
import { verifyRun } from "../src/margin-rescue/verify.js"

export const FIXTURE_WATERMARK = 10n ** 12n // the replayed indexer: processed far past the run

const { values } = parseArgs({ options: { block: { type: "string" }, upstream: { type: "string", default: "http://127.0.0.1:8556" }, port: { type: "string", default: "8553" }, out: { type: "string", default: "test/fixtures/verify-fork-run.json.gz" } } })
if (!values.block) throw new Error("--block N is required")
const block = BigInt(values.block)
const rpc = `http://127.0.0.1:${values.port}`
const anvil = await startAnvil(values.upstream!, block, values.port!)
try {
  const client = createHidekiClient(rpc, { timeoutMs: 900_000 })
  const call = <T = unknown>(method: string, params: unknown[] = []) => client.request({ method, params } as never) as Promise<T>
  const fork = await sampleBlock(client, block)
  await call("anvil_setBlockTimestampInterval", [0])
  await call("evm_setNextBlockTimestamp", [`0x${fork.timestamp.toString(16)}`])
  await call("evm_mine")
  const key = generatePrivateKey() // in memory only
  const owner = privateKeyToAccount(key).address
  await call("anvil_setBalance", [owner, "0x8ac7230489e80000"])
  await call("anvil_impersonateAccount", [TEST_EOA])
  const transfer = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"])
  await waitReceipt(client, await call<Hex>("eth_sendTransaction", [{ from: TEST_EOA, to: USDSO, data: encodeFunctionData({ abi: transfer, functionName: "transfer", args: [owner as Address, 100n * 10n ** 18n] }), gas: "0x1c9c380" }]))
  await call("anvil_stopImpersonatingAccount", [TEST_EOA])

  const work = join(".margin-rescue", "fixture", `${block}-${Date.now()}`)
  const runDir = join(work, "run")
  mkdirSync(work, { recursive: true })
  const planPath = join(work, "live-plan.json")
  writeFileSync(planPath, prettyJson({ ...(await buildLivePlan(client, undefined, { ...DEFAULT_PLAN, account: owner })), status: "FORK FIXTURE: throwaway account on a local fork; not a live plan" }))
  const digest = sha256Hex(readFileSync(planPath))
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/margin-rescue/liveRun.ts", "--plan", planPath, "--approve", digest, "--rpc", rpc, "--out", runDir], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, MR_SIGNER_KEY: key } })
    child.on("exit", (c) => resolve(c ?? 1))
  })
  if (code !== 0) throw new Error(`the fork run exited ${code}; no fixture recorded`)

  // The verifier's every request and answer, through a recording transport. A transaction
  // is kept without its signature (r, s, v, yParity): with it, the answer would amount to
  // the signed bytes, which no fixture holds, even for a throwaway fork key. The verifier
  // reads only the transaction's fields.
  const calls: [string, unknown, unknown, string | null][] = []
  const unsigned = (method: string, result: unknown) =>
    method === "eth_getTransactionByHash" && result && typeof result === "object" ? Object.fromEntries(Object.entries(result).filter(([k]) => !["r", "s", "v", "yParity"].includes(k))) : result
  const recording = createPublicClient({
    chain: defineChain({ ...hidekiTestnet, rpcUrls: { default: { http: [rpc] } } }),
    transport: custom({
      async request({ method, params }) {
        try {
          const result = await client.request({ method, params } as never)
          calls.push([method, params, unsigned(method, result), null])
          return result
        } catch (e) {
          calls.push([method, params, null, String((e as Error).message).split("\n")[0]])
          throw e
        }
      },
    }),
  }) as PublicClient
  const report = await verifyRun({ dir: runDir, plan: planPath, client: recording, indexer: { watermark: async () => FIXTURE_WATERMARK, listStops: async () => ({ rows: [], pages: 1, indexedThrough: FIXTURE_WATERMARK }) }, rpc, approvedDigest: digest })
  if (!report.verdict.allChecksHold) throw new Error(`the read-back of the fork run fails: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`)

  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(runDir, path)] = readFileSync(path, "utf8")
    }
  }
  walk(runDir)
  const fixture = { recordedAt: new Date().toISOString(), forkBlock: block.toString(), account: owner, plan: readFileSync(planPath, "utf8"), files, calls }
  writeFileSync(values.out!, gzipSync(JSON.stringify(fixture), { level: 9 }))
  console.log(`fixture: ${values.out} (${calls.length} calls, ${Object.keys(files).length} files, ${report.checks.length} checks hold, goal ${report.verdict.goal})`)
} finally {
  await stopAnvil(anvil)
}
