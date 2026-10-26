// The guard build an approved plan is bound to. MOCK TESTS: reads the local forge
// artifact (run `forge build` in contracts/ first); the chain is a stub.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { concat, encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type PublicClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { BTC_POOL, ETH_POOL, MARGIN_BANK } from "../../src/margin-rescue/common.js"
import { runLive } from "../../src/margin-rescue/executor.js"
import { expectedRuntime, GUARD_ARTIFACT, guardDeployment, loadGuardArtifact } from "../../src/margin-rescue/guardArtifact.js"
import type { LivePlan } from "../../src/margin-rescue/livePlan.js"

const built = existsSync(GUARD_ARTIFACT)
const OWNER = getAddress("0x66c626c59eddf06a7dca0401cf20fa2ce7033a12")

describe("guard build binding", { skip: built ? false : "contracts/out is missing; run forge build in contracts/" }, () => {
  it("writes OWNER and MARGIN_BANK into exactly the compiler's immutable offsets", () => {
    const a = loadGuardArtifact()
    const runtime = expectedRuntime(a, OWNER, MARGIN_BANK)
    const word = (x: string) => x.slice(2).toLowerCase().padStart(64, "0")
    const offsets = new Set<number>()
    a.immutables.forEach((refs, i) => {
      for (const r of refs) {
        assert.equal(runtime.slice(2 + r.start * 2, 2 + (r.start + 32) * 2), word(i === 0 ? OWNER : MARGIN_BANK))
        for (let k = 0; k < 32; k++) offsets.add(r.start + k)
      }
    })
    const raw = a.runtimeCode.slice(2)
    for (let i = 0; i < raw.length / 2; i++) if (!offsets.has(i)) assert.equal(runtime.slice(2 + i * 2, 4 + i * 2), raw.slice(i * 2, i * 2 + 2), `byte ${i} changed`)
  })

  it("hashes the creation code and the exact deployment data for one owner", () => {
    const a = loadGuardArtifact()
    const d = guardDeployment(a, OWNER, MARGIN_BANK, [BTC_POOL, ETH_POOL])
    const args = encodeAbiParameters(parseAbiParameters("address, address, address[]"), [OWNER, MARGIN_BANK, [BTC_POOL, ETH_POOL]])
    assert.equal(d.deployData, concat([a.creationCode, args]))
    assert.equal(d.deployDataKeccak, keccak256(d.deployData))
    assert.equal(d.creationCodeKeccak, keccak256(a.creationCode))
    assert.notEqual(guardDeployment(a, getAddress("0x00000000000000000000000000000000000b0b00"), MARGIN_BANK, [BTC_POOL, ETH_POOL]).expectedRuntimeKeccak, d.expectedRuntimeKeccak, "another owner, another runtime")
    assert.ok(Object.keys(d.sourceSha256).includes("src/ReduceOnlyGuard.sol"))
  })

  // A stub chain that answers only the chain id: nothing may be read or sent.
  const chainOnly = { getChainId: async () => 50383 } as unknown as PublicClient
  const signer = privateKeyToAccount(generatePrivateKey()) // in memory for this test only
  const planFor = (account: string, guard: Partial<LivePlan["guard"]> = {}) => {
    const d = guardDeployment(loadGuardArtifact(), getAddress(account), MARGIN_BANK, [BTC_POOL, ETH_POOL])
    return { account: { address: account }, guard: { creationCodeKeccak: d.creationCodeKeccak, deployDataKeccak: d.deployDataKeccak, expectedRuntimeKeccak: d.expectedRuntimeKeccak, ...guard } } as unknown as LivePlan
  }
  const run = (plan: LivePlan) => runLive({ plan, planDigest: "d".repeat(64), client: chainOnly, signer, out: mkdtempSync(join(tmpdir(), "mr-run-")), listStops: async () => ({ rows: [], pages: 1, indexedThrough: null }) })

  it("refuses to start when the local build differs from the approved plan", async () => {
    await assert.rejects(run(planFor(signer.address, { expectedRuntimeKeccak: `0x${"00".repeat(32)}` })), /does not match the approved plan \(expectedRuntimeKeccak/)
    await assert.rejects(run(planFor(signer.address, { deployDataKeccak: `0x${"11".repeat(32)}` })), /deployDataKeccak/)
  })

  it("refuses a key that is not the plan's account", async () => {
    await assert.rejects(run(planFor(OWNER)), /not the plan's account/)
  })
})
