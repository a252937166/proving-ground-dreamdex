// The recorded real-venue fork run (tools/record-verify-fixture.ts): one live-command run
// on a local anvil fork of Hideki, and every JSON-RPC answer the independent verifier
// needs for it. replayClient answers from that recording; a request it does not have
// fails like a node error, so tampered inputs cannot borrow answers they were not given.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { createPublicClient, custom, type PublicClient } from "viem"
import { defineChain, hidekiTestnet } from "@somnia-chain/markets-sdk/chains"
import type { Indexer } from "../../src/margin-rescue/verify.js"

export const FIXTURE = new URL("../fixtures/verify-fork-run.json.gz", import.meta.url)
export const WATERMARK = 10n ** 12n // as recorded: the indexer had processed far past the run

export interface ForkFixture {
  recordedAt: string
  forkBlock: string
  account: string
  plan: string
  files: Record<string, string>
  calls: [string, unknown, unknown, string | null][]
}

export function loadFixture(): ForkFixture {
  return JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString("utf8")) as ForkFixture
}

export function writeRun(fx: ForkFixture, dir: string): void {
  for (const [f, body] of Object.entries(fx.files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), body)
  }
}

export function replayClient(fx: ForkFixture): PublicClient {
  const answers = new Map(fx.calls.map(([method, params, result, error]) => [JSON.stringify([method, params]), { result, error }]))
  return createPublicClient({
    chain: defineChain({ ...hidekiTestnet, rpcUrls: { default: { http: ["http://replay.invalid"] } } }),
    transport: custom(
      {
        async request({ method, params }) {
          const a = answers.get(JSON.stringify([method, params]))
          if (!a) throw new Error(`not in the recording: ${method}`)
          if (a.error) throw new Error(a.error)
          return a.result
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient
}

export const replayIndexer: Indexer = { watermark: async () => WATERMARK, listStops: async () => ({ rows: [], pages: 1, indexedThrough: WATERMARK }) }
