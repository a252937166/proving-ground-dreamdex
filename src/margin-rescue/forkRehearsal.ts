// Rehearse the LIVE executor (liveRun.ts) end to end on a local anvil fork, with a
// throwaway key generated in memory for this run only. The key's account is funded on
// the fork (STT via anvil_setBalance, 100 USDso moved from an impersonated holder), a
// plan is generated for it, hashed, and liveRun.ts is executed with exactly the flags
// the live run would use, signing locally and broadcasting raw transactions.
//
// Fork only: nothing reaches Hideki. Evidence is labelled "fork".
//
//   npm run rpc-shim &
//   (cd contracts && forge build)
//   npm run mr:fork-rehearsal -- [--block N] [--out DIR]
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { encodeFunctionData, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { USDSO } from "./common.js"
import { prettyJson, sha256Hex, writeFileAtomic } from "./json.js"
import { buildLivePlan, DEFAULT_PLAN, TEST_EOA } from "./livePlan.js"
import { createHidekiClient, sampleBlock } from "./rpc.js"

const ANVIL = process.env.ANVIL ?? (existsSync(join(homedir(), ".foundry/bin/anvil")) ? join(homedir(), ".foundry/bin/anvil") : "anvil")
const ARTIFACT = new URL("../../contracts/out/ReduceOnlyGuard.sol/ReduceOnlyGuard.json", import.meta.url)

async function main() {
  const { values } = parseArgs({ options: { block: { type: "string", default: "33472615" }, port: { type: "string", default: "8548" }, upstream: { type: "string", default: "http://127.0.0.1:8546" }, out: { type: "string" } } })
  const out = values.out ?? join("evidence", "margin-rescue", "fork", `live-rehearsal-${values.block}`)
  const rpc = `http://127.0.0.1:${values.port}`
  const anvil = spawn(ANVIL, ["--fork-url", values.upstream!, "--fork-block-number", values.block!, "--port", values.port!, "--chain-id", "50383", "--silent"], { stdio: "ignore" })
  process.on("exit", () => anvil.exitCode === null && anvil.kill("SIGKILL"))
  try {
    await waitUp(rpc, anvil)
    const client = createHidekiClient(rpc, { timeoutMs: 600_000 })
    const call = (method: string, params: unknown[]) => client.request({ method, params } as never)
    // Hold the clock: every block keeps the fork block's timestamp (marks expire in 5 s).
    const fork = await sampleBlock(client, BigInt(values.block!))
    await call("anvil_setBlockTimestampInterval", [0])
    await call("evm_setNextBlockTimestamp", [`0x${fork.timestamp.toString(16)}`])
    await call("evm_mine", [])

    const key = generatePrivateKey() // fork-only throwaway; never written anywhere
    const owner = privateKeyToAccount(key).address
    await call("anvil_setBalance", [owner, "0x8ac7230489e80000"]) // 10 STT on the fork
    await call("anvil_impersonateAccount", [TEST_EOA])
    const transfer = (await call("eth_sendTransaction", [
      { from: TEST_EOA, to: USDSO, gas: "0x1c9c380", data: encodeFunctionData({ abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const, functionName: "transfer", args: [owner, 100n * 10n ** 18n] }) },
    ])) as Hex
    await client.waitForTransactionReceipt({ hash: transfer, timeout: 600_000 })
    await call("anvil_stopImpersonatingAccount", [TEST_EOA])

    const plan = await buildLivePlan(client, ARTIFACT, { ...DEFAULT_PLAN, account: owner })
    const planPath = join(out, "live-plan.fork.json")
    writeFileAtomic(planPath, prettyJson({ ...plan, label: "fork rehearsal: throwaway account funded on the fork" }))
    const digest = sha256Hex(readFileSync(planPath))
    console.log(`plan ${planPath} digest ${digest} for fork account ${owner}`)
    const code = await run(["--import", "tsx", "src/margin-rescue/liveRun.ts", "--plan", planPath, "--approve", digest, "--rpc", rpc, "--out", join(out, "run")], key)
    writeFileAtomic(join(out, "rehearsal.json"), prettyJson({ label: "fork", forkBlock: values.block, forkBlockHash: fork.hash, clockHeldAt: fork.timestamp, owner, planDigest: digest, liveRunExit: code }))
    console.log(`liveRun exited ${code}; evidence in ${out}`)
  } finally {
    anvil.kill("SIGTERM")
  }
}

function run(args: string[], key: Hex): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, MR_SIGNER_KEY: key } })
    child.on("exit", (c) => resolve(c ?? 1))
  })
}

async function waitUp(rpc: string, child: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) throw new Error(`anvil exited (${child.exitCode}); is the port free and the shim running?`)
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
      if (res.ok) return
    } catch {
      // not up yet
    }
  }
  throw new Error("anvil did not start")
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)

