// Every function in src/margin-rescue/abi.ts must exist, with the same input and output
// types, in the ABIs shipped by @somnia-chain/markets-sdk 0.32.1 — except placeOrderFor,
// which the SDK does not wrap for perps; its selector is checked against the SDK's own
// constant instead. No network.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { toFunctionSelector, type Abi, type AbiParameter } from "viem"
import * as ours from "../../src/margin-rescue/abi.js"

const sdkDist = new URL("../../node_modules/@somnia-chain/markets-sdk/dist/", import.meta.url)

function canon(p: AbiParameter): string {
  if (p.type.startsWith("tuple")) {
    const components = (p as { components: readonly AbiParameter[] }).components
    return `(${components.map(canon).join(",")})${p.type.slice("tuple".length)}`
  }
  return p.type
}

type Fn = { type: "function"; name: string; inputs: readonly AbiParameter[]; outputs: readonly AbiParameter[] }
const signature = (f: Fn) => `${f.name}(${f.inputs.map(canon).join(",")})->(${f.outputs.map(canon).join(",")})`
const functions = (abi: Abi) => (abi as readonly { type: string }[]).filter((x) => x.type === "function") as unknown as Fn[]

describe("ABI drift against the SDK", async () => {
  const reads = (await import(new URL("readsAbi.js", sdkDist).href)) as Record<string, unknown>
  const trades = (await import(new URL("tradeAbi.js", sdkDist).href)) as Record<string, unknown>
  const sdkSignatures = new Set<string>()
  for (const mod of [reads, trades]) for (const value of Object.values(mod)) if (Array.isArray(value)) for (const f of functions(value as Abi)) sdkSignatures.add(signature(f))

  const mine: [string, Abi][] = [
    ["marginBankAbi", ours.marginBankAbi],
    ["perpPoolAbi", ours.perpPoolAbi],
    ["perpPoolFactoryAbi", ours.perpPoolFactoryAbi],
    ["erc20Abi", ours.erc20Abi],
    ["operatorRegistryAbi", ours.operatorRegistryAbi],
    ["perpStopRegistryAbi", ours.perpStopRegistryAbi],
    ["marginBankWriteAbi", ours.marginBankWriteAbi],
  ]
  for (const [name, abi] of mine) {
    it(`${name} matches the SDK`, () => {
      assert.ok(sdkSignatures.size > 100, "SDK ABIs loaded")
      const checked = functions(abi).filter((f) => f.name !== "placeOrderFor")
      assert.ok(checked.length > 0, "nothing to compare")
      for (const f of checked) assert.ok(sdkSignatures.has(signature(f)), `${name}.${signature(f)} is not in the SDK ABIs`)
    })
  }

  it("placeOrderFor has the selector the SDK grants to operators", () => {
    const source = readFileSync(new URL("../../node_modules/@somnia-chain/markets-sdk/src/perp/stops.ts", import.meta.url), "utf8")
    const sdkSelector = /PLACE_ORDER_FOR_SELECTOR = "(0x[0-9a-f]{8})"/.exec(source)?.[1]
    const f = functions(ours.perpPoolAbi).find((x) => x.name === "placeOrderFor")!
    assert.equal(toFunctionSelector(f as never), sdkSelector)
    assert.equal(ours.PLACE_ORDER_FOR_SELECTOR, sdkSelector)
  })
})
