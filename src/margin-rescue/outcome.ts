// What became of one transaction, from chain data alone.
//
// A lookup answers in one of three ways: found, explicitly not found (the node returned
// null, which viem raises as TransactionReceiptNotFoundError / TransactionNotFoundError
// / BlockNotFoundError), or failed (timeout, HTTP error, JSON-RPC error). Only the first
// two are evidence; a failed lookup leaves the outcome UNKNOWN.
//
// A consumed nonce is not evidence of replacement either: the account's own transaction
// may have been mined while its receipt is unavailable. So the transaction that consumed
// the nonce is located (the first block whose account nonce passed it, by binary search,
// then that block's transactions), and only a DIFFERENT hash there makes this one
// REPLACED. If the consumer cannot be located, or it is this very transaction, the
// outcome stays UNKNOWN until a receipt settles it.
import { BaseError, BlockNotFoundError, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem"

export type Probe =
  | { state: "MINED"; receipt: TransactionReceipt; detail: string }
  | { state: "PENDING"; detail: string }
  | { state: "REPLACED"; by: Hex; blockNumber: bigint; detail: string }
  | { state: "UNKNOWN"; detail: string }

export interface ProbeTarget {
  hash: Hex
  from: Address
  nonce: number
  // The latest block seen before the transaction was signed: its nonce was still free
  // there, so the consumer is after it. Without it the search looks back LOOKBACK blocks.
  sentAfterBlock?: bigint
}

export const LOOKBACK = 20_000n

type Lookup<T> = { kind: "found"; value: T } | { kind: "notFound" } | { kind: "failed"; error: string }

async function lookup<T>(f: () => Promise<T | null | undefined>): Promise<Lookup<T>> {
  try {
    const value = await f()
    return value === null || value === undefined ? { kind: "notFound" } : { kind: "found", value }
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError || e instanceof TransactionNotFoundError || e instanceof BlockNotFoundError) return { kind: "notFound" }
    return { kind: "failed", error: shortError(e) }
  }
}

export async function probeTransaction(client: PublicClient, t: ProbeTarget): Promise<Probe> {
  const receipt = await lookup(() => client.getTransactionReceipt({ hash: t.hash }))
  if (receipt.kind === "failed") return { state: "UNKNOWN", detail: `receipt lookup failed (${receipt.error})` }
  if (receipt.kind === "found") {
    const r = receipt.value
    const block = await lookup(() => client.getBlock({ blockNumber: r.blockNumber }))
    if (block.kind === "failed") return { state: "UNKNOWN", detail: `receipt in block ${r.blockNumber}, canonical check failed (${block.error})` }
    if (block.kind === "notFound" || block.value.hash !== r.blockHash) return { state: "UNKNOWN", detail: `receipt block ${r.blockNumber} ${r.blockHash} is not canonical (yet)` }
    return { state: "MINED", receipt: r, detail: `${r.status} in block ${r.blockNumber}` }
  }

  const tx = await lookup(() => client.getTransaction({ hash: t.hash }))
  if (tx.kind === "failed") return { state: "UNKNOWN", detail: `no receipt; transaction lookup failed (${tx.error})` }
  if (tx.kind === "found") {
    return tx.value.blockNumber === null
      ? { state: "PENDING", detail: "in the node's pool, not mined" }
      : { state: "UNKNOWN", detail: `mined in block ${tx.value.blockNumber}; its receipt is not served yet` }
  }

  const latest = await lookup(() => client.getTransactionCount({ address: t.from, blockTag: "latest" }))
  if (latest.kind !== "found") return { state: "UNKNOWN", detail: "not known to the node; account nonce unavailable" }
  if (latest.value <= t.nonce) return { state: "UNKNOWN", detail: `not known to the node and nonce ${t.nonce} is still free (never received, or dropped)` }

  const consumer = await findNonceConsumer(client, t.from, t.nonce, t.sentAfterBlock)
  if (consumer.kind === "failed") return { state: "UNKNOWN", detail: `nonce ${t.nonce} is used; its transaction could not be located (${consumer.error})` }
  if (consumer.kind === "notFound") return { state: "UNKNOWN", detail: `nonce ${t.nonce} is used; no transaction for it was found in the searched blocks` }
  const { hash, blockNumber } = consumer.value
  if (hash.toLowerCase() === t.hash.toLowerCase()) return { state: "UNKNOWN", detail: `mined in block ${blockNumber} (located by nonce); its receipt is not served yet` }
  return { state: "REPLACED", by: hash, blockNumber, detail: `nonce ${t.nonce} was consumed by ${hash} in block ${blockNumber}` }
}

// The transaction from `from` with nonce `nonce`: the first block whose account nonce is
// past it, by binary search on eth_getTransactionCount, then that block's transactions.
export async function findNonceConsumer(client: PublicClient, from: Address, nonce: number, sentAfterBlock?: bigint): Promise<Lookup<{ hash: Hex; blockNumber: bigint }>> {
  const head = await lookup(() => client.getBlockNumber())
  if (head.kind !== "found") return head.kind === "failed" ? head : { kind: "failed", error: "no head block" }
  const count = (blockNumber: bigint) => lookup(() => client.getTransactionCount({ address: from, blockNumber }))
  let lo = sentAfterBlock ?? (head.value > LOOKBACK ? head.value - LOOKBACK : 0n)
  let hi = head.value
  const atLo = await count(lo)
  if (atLo.kind !== "found") return atLo.kind === "failed" ? atLo : { kind: "failed", error: `no nonce at block ${lo}` }
  if (atLo.value > nonce) return { kind: "failed", error: `nonce ${nonce} was already used at block ${lo}, before the searched range` }
  // Invariant: nonce is free at lo and used at hi.
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    const c = await count(mid)
    if (c.kind !== "found") return c.kind === "failed" ? c : { kind: "failed", error: `no nonce at block ${mid}` }
    if (c.value > nonce) hi = mid
    else lo = mid
  }
  const block = await lookup(() => client.getBlock({ blockNumber: hi, includeTransactions: true }))
  if (block.kind !== "found") return block.kind === "failed" ? block : { kind: "failed", error: `block ${hi} not found` }
  for (const tx of block.value.transactions) {
    if (typeof tx !== "string" && tx.from.toLowerCase() === from.toLowerCase() && tx.nonce === nonce) return { kind: "found", value: { hash: tx.hash, blockNumber: hi } }
  }
  return { kind: "notFound" }
}

function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; name?: string }
  const text = e instanceof BaseError ? `${e.name}: ${e.shortMessage}` : (err?.shortMessage ?? err?.message ?? String(e))
  return text.split("\n")[0].slice(0, 160)
}
