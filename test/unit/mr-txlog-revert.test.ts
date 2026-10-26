// A step the node's simulation already rejects is never signed or sent. MOCK TESTS.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { encodeErrorResult, EstimateGasExecutionError, ExecutionRevertedError, getAddress, TimeoutError, type Hex, type PublicClient } from "viem"
import { contractErrorsAbi } from "../../src/margin-rescue/abi.js"
import { StepWouldRevertError, TxLedger, TxSender } from "../../src/margin-rescue/txlog.js"

const OWNER = getAddress("0x66c626c59eddf06a7dca0401cf20fa2ce7033a12")
const signs: unknown[] = []
const signer = { address: OWNER, signTransaction: async (tx: unknown) => (signs.push(tx), "0x01" as Hex) }

function sender(estimateGas: () => Promise<bigint>) {
  const client = { getGasPrice: async () => 6n * 10n ** 9n, estimateGas, request: async () => assert.fail("nothing may be broadcast") } as unknown as PublicClient
  const ledger = TxLedger.create(join(mkdtempSync(join(tmpdir(), "mr-ledger-")), "run-ledger.json"), { planDigest: "d".repeat(64), account: OWNER, chainId: 50383, gasCap: 10n ** 18n, startNonce: 0 })
  return { ledger, s: new TxSender(ledger, client, signer, { chainId: 50383, gasCap: 10n ** 18n, maxGasPrice: 18n * 10n ** 9n, gasHeadroomPct: 30n, cleanupGasPerTx: 13_000_000n, receiptTimeoutMs: 1, resolveTimeoutMs: 1, pollMs: 1, sleep: async () => {} }) }
}

describe("simulation before signing", () => {
  it("a venue revert in eth_estimateGas is StepWouldRevertError, decoded, with nothing signed or recorded", async () => {
    const data = encodeErrorResult({ abi: contractErrorsAbi, errorName: "ImmediateOrCancelNoFill" } as never)
    const { ledger, s } = sender(async () => {
      throw new EstimateGasExecutionError(new ExecutionRevertedError({ cause: Object.assign(new Error("execution reverted"), { data }) as never, message: "execution reverted" }), { account: { address: OWNER, type: "json-rpc" } } as never)
    })
    signs.length = 0
    const err = await s.send({ id: "cleanup-close-BTC-1", phase: "cleanup", purpose: "close", to: OWNER, data: "0x12345678" }).catch((e) => e)
    assert.ok(err instanceof StepWouldRevertError, String(err))
    assert.match(err.reason, /ImmediateOrCancelNoFill|0xd48c4403/)
    assert.equal(signs.length, 0)
    assert.equal(ledger.data.steps.length, 0)
  })

  it("a transport timeout during simulation is not mistaken for a revert", async () => {
    const { s } = sender(async () => {
      throw new TimeoutError({ body: {}, url: "stub" })
    })
    const err = await s.send({ id: "approve", phase: "main", purpose: "approve", to: OWNER, data: "0x12345678", cleanupTx: 1 }).catch((e) => e)
    assert.ok(!(err instanceof StepWouldRevertError))
    assert.ok(err instanceof TimeoutError)
  })
})
