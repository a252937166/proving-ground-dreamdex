// The ReduceOnlyGuard build an approved plan is bound to.
//
// The plan records the keccak of the compiled creation code, of the exact deployment
// data (creation code + constructor arguments for this owner, bank and pool list), of
// the source files, and of the runtime code the deployment must leave on chain. The
// runtime hash is the compiled runtime with the two immutables (OWNER, MARGIN_BANK)
// written into the offsets the compiler reports. The executor recomputes all of it
// from the local build before deploying, and compares the code at the deployed address
// with the expected runtime before it grants the guard anything.
import { readFileSync } from "node:fs"
import { encodeDeployData, getAddress, keccak256, type Abi, type Address, type Hex, type PublicClient } from "viem"
import { reduceGuardAbi } from "./abi.js"
import { sha256Hex } from "./json.js"

export const GUARD_ARTIFACT = new URL("../../contracts/out/ReduceOnlyGuard.sol/ReduceOnlyGuard.json", import.meta.url)
export const GUARD_SOURCES = ["ReduceOnlyGuard.sol", "ReduceGuardChecks.sol", "interfaces/IDreamDex.sol"].map((f) => new URL(`../../contracts/src/${f}`, import.meta.url))

export interface GuardArtifact {
  abi: Abi
  creationCode: Hex
  runtimeCode: Hex
  // Immutable offsets in the runtime code, by declaration order: OWNER, then MARGIN_BANK.
  immutables: { start: number; length: number }[][]
  compiler: string
  optimizer: unknown
}

export function loadGuardArtifact(url: URL = GUARD_ARTIFACT): GuardArtifact {
  const a = JSON.parse(readFileSync(url, "utf8")) as {
    abi: Abi
    bytecode: { object: Hex }
    deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> }
    metadata?: { compiler?: { version?: string }; settings?: { optimizer?: unknown } }
  }
  const refs = a.deployedBytecode.immutableReferences ?? {}
  // solc numbers AST nodes in source order, so the lower id is the first declared
  // immutable (OWNER). A wrong order would only make the expected runtime differ from
  // the deployed one, which refuses the grant; the fork runs check it matches.
  const ids = Object.keys(refs).sort((x, y) => Number(x) - Number(y))
  if (ids.length !== 2) throw new Error(`expected 2 immutables in the guard runtime, found ${ids.length}`)
  return {
    abi: a.abi,
    creationCode: a.bytecode.object,
    runtimeCode: a.deployedBytecode.object,
    immutables: ids.map((id) => refs[id]),
    compiler: a.metadata?.compiler?.version ?? "unknown",
    optimizer: a.metadata?.settings?.optimizer ?? null,
  }
}

export interface GuardDeployment {
  owner: Address
  marginBank: Address
  pools: Address[]
  deployData: Hex
  creationCodeKeccak: Hex
  deployDataKeccak: Hex
  expectedRuntimeKeccak: Hex
  runtimeBytes: number
  compiler: string
  optimizer: unknown
  sourceSha256: Record<string, string>
}

export function guardDeployment(artifact: GuardArtifact, owner: Address, marginBank: Address, pools: Address[]): GuardDeployment {
  const deployData = encodeDeployData({ abi: artifact.abi, bytecode: artifact.creationCode, args: [owner, marginBank, pools] })
  const runtime = expectedRuntime(artifact, owner, marginBank)
  return {
    owner,
    marginBank,
    pools,
    deployData,
    creationCodeKeccak: keccak256(artifact.creationCode),
    deployDataKeccak: keccak256(deployData),
    expectedRuntimeKeccak: keccak256(runtime),
    runtimeBytes: (runtime.length - 2) / 2,
    compiler: artifact.compiler,
    optimizer: artifact.optimizer,
    sourceSha256: Object.fromEntries(GUARD_SOURCES.map((u) => [u.pathname.split("/contracts/")[1], sha256Hex(readFileSync(u))])),
  }
}

export function expectedRuntime(artifact: GuardArtifact, owner: Address, marginBank: Address): Hex {
  const code = artifact.runtimeCode.slice(2).split("")
  const word = (a: Address) => a.slice(2).toLowerCase().padStart(64, "0")
  artifact.immutables.forEach((refs, i) => {
    const value = word(i === 0 ? owner : marginBank)
    for (const r of refs) {
      if (r.length !== 32) throw new Error("immutable reference is not one word")
      code.splice(r.start * 2, 64, ...value.split(""))
    }
  })
  return `0x${code.join("")}` as Hex
}

// Everything the deployed guard must show before it is granted any permission.
export async function verifyDeployedGuard(client: PublicClient, guard: Address, d: GuardDeployment, blockNumber?: bigint): Promise<string[]> {
  const problems: string[] = []
  const code = await client.getCode({ address: guard, blockNumber })
  if (!code || code === "0x") return [`no code at ${guard}`]
  if (keccak256(code) !== d.expectedRuntimeKeccak) problems.push(`runtime keccak ${keccak256(code)} ≠ approved ${d.expectedRuntimeKeccak}`)
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: guard, abi: reduceGuardAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>
  const [owner, bank] = await Promise.all([read<Address>("OWNER"), read<Address>("MARGIN_BANK")])
  if (getAddress(owner) !== getAddress(d.owner)) problems.push(`OWNER() is ${owner}, not ${d.owner}`)
  if (getAddress(bank) !== getAddress(d.marginBank)) problems.push(`MARGIN_BANK() is ${bank}, not ${d.marginBank}`)
  for (const p of d.pools) if (!(await read<boolean>("trustedPool", [p]))) problems.push(`pool ${p} is not trusted`)
  return problems
}
