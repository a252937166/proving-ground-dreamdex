// Local anvil forks of Hideki for the fork-only runs (forkE2e.ts, forkRehearsal.ts).
// Nothing here talks to the live network except through the read-only RPC shim that
// anvil forks from.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Hex, PublicClient } from "viem"
import { sha256Hex } from "./json.js"

// foundryup installs to ~/.foundry/bin, which npm scripts do not always have on PATH.
export const ANVIL = process.env.ANVIL ?? (existsSync(join(homedir(), ".foundry/bin/anvil")) ? join(homedir(), ".foundry/bin/anvil") : "anvil")

export async function rpcUp(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
    return res.ok
  } catch {
    return false
  }
}

export async function startAnvil(upstream: string, block: bigint, port: string): Promise<ChildProcess> {
  // Never reuse a node already on the port: its state would not be this fork.
  if (await rpcUp(port)) throw new Error(`port ${port} is already serving JSON-RPC; stop that node or pass --port`)
  const child = spawn(ANVIL, ["--fork-url", upstream, "--fork-block-number", block.toString(), "--port", port, "--chain-id", "50383", "--silent"], { stdio: "ignore" })
  process.on("exit", () => child.exitCode === null && child.kill("SIGKILL"))
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`)
    if (await rpcUp(port)) return child
  }
  child.kill("SIGTERM")
  throw new Error("anvil did not start; is the rpc shim running on the upstream URL?")
}

// SIGTERM lets anvil write its RPC cache (~/.foundry/cache/rpc), which makes the next run
// at the same block fast; SIGKILL only if it does not exit.
export async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const exited = new Promise((r) => child.once("exit", r))
  child.kill("SIGTERM")
  const timeout = new Promise((r) => setTimeout(r, 15_000, "timeout"))
  if ((await Promise.race([exited, timeout])) === "timeout") child.kill("SIGKILL")
}

export function anvilVersion(): string {
  return execFileSync(ANVIL, ["--version"]).toString().split("\n")[0]
}

// A cold fork fetches every storage slot a transaction touches from Hideki, one at a
// time, so the first execution of an order can take minutes.
export function waitReceipt(client: PublicClient, hash: Hex) {
  return client.waitForTransactionReceipt({ hash, timeout: 1_800_000, pollingInterval: 1_000 })
}

export function checksums(dir: string): string {
  const files = execFileSync("find", [dir, "-type", "f", "!", "-name", "SHA256SUMS"]).toString().trim().split("\n").sort()
  return files.map((f) => `${sha256Hex(readFileSync(f))}  ${f.slice(dir.length + 1)}`).join("\n") + "\n"
}
