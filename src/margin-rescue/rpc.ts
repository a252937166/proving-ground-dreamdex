// Block-pinned reads. A snapshot samples one block (number, hash, timestamp) and makes
// every contract read with `eth_call` pinned to that block HASH (EIP-1898), which the
// Hideki RPC honours for eth_call: an unknown hash fails instead of falling back to
// another block. After the reads the hash is checked against the canonical chain.
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type Abi, type Address, type Hex, type PublicClient } from "viem"
import { hidekiTestnet, defineChain } from "@somnia-chain/markets-sdk/chains"

export const HIDEKI_CHAIN_ID = 50383

export function createHidekiClient(rpcUrl: string, opts: { timeoutMs?: number } = {}): PublicClient {
  const chain = defineChain({ ...hidekiTestnet, rpcUrls: { default: { http: [rpcUrl] } } })
  return createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 3, timeout: opts.timeoutMs ?? 30_000 }) }) as PublicClient
}

export async function assertHideki(client: PublicClient): Promise<void> {
  const id = await client.getChainId()
  if (id !== HIDEKI_CHAIN_ID) throw new Error(`refusing chain ${id}: Margin Rescue runs only on Somnia Hideki (${HIDEKI_CHAIN_ID})`)
}

export interface BlockRef {
  number: bigint
  hash: Hex
  timestamp: bigint
}

interface RpcBlock {
  number: Hex
  hash: Hex
  timestamp: Hex
}

export async function sampleBlock(client: PublicClient, blockNumber?: bigint): Promise<BlockRef> {
  const tag = blockNumber === undefined ? "latest" : `0x${blockNumber.toString(16)}`
  const b = (await client.request({ method: "eth_getBlockByNumber", params: [tag as Hex, false] })) as unknown as RpcBlock | null
  if (!b) throw new Error(`block ${tag} not found`)
  return { number: BigInt(b.number), hash: b.hash, timestamp: BigInt(b.timestamp) }
}

export interface CanonicalCheck {
  ok: boolean
  observedHash: Hex
  checkedAt: string
}

export async function checkCanonical(client: PublicClient, block: BlockRef): Promise<CanonicalCheck> {
  const again = await sampleBlock(client, block.number)
  return { ok: again.hash.toLowerCase() === block.hash.toLowerCase(), observedHash: again.hash, checkedAt: new Date().toISOString() }
}

export interface PinnedCall {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  from?: Address
}

// eth_call pinned to `block.hash`. Retries transport errors; a revert is not retried.
export async function readAt<T>(client: PublicClient, block: BlockRef, call: PinnedCall): Promise<T> {
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as never)
  const tx: Record<string, string> = { to: call.address, data }
  if (call.from) tx.from = call.from
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = (await client.request({ method: "eth_call", params: [tx, { blockHash: block.hash }] as never })) as Hex
      return decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data: raw } as never) as T
    } catch (err) {
      lastError = err
      const message = String((err as Error)?.message ?? err)
      if (/revert/i.test(message)) break
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  throw lastError
}

// Map with bounded concurrency, preserving order.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
