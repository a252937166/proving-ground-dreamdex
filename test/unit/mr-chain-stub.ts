// A stub chain for the transaction-ledger and journal tests. MOCK: blocks, receipts, a
// mempool, per-block account nonces and lookups that can be made to time out; "not
// found" is answered the way viem raises a null RPC result.
import { BlockNotFoundError, getAddress, hexToString, keccak256, TimeoutError, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionSerializable } from "viem"

export const OWNER = getAddress("0x66c626c59eddf06a7dca0401cf20fa2ce7033a12")
export const STRANGER_TX = keccak256(toHex("a transaction the run did not send"))
export const GWEI = 10n ** 9n

export type Lookup = "receipt" | "transaction" | "count" | "block" | "blockNumber"

interface MinedTx {
  hash: Hex
  from: Address
  nonce: number
}

export class StubChain {
  head = 100n
  gasPrice = 6n * GWEI
  estimate = 1_000_000n
  balance = 50n * 10n ** 18n
  mine = true // include every accepted transaction at once
  outage = new Set<Lookup>() // these lookups time out
  sent: Hex[] = []
  onSend?: (raw: Hex, hash: Hex) => void
  readonly blocks = new Map<bigint, { hash: Hex; txs: MinedTx[] }>()
  readonly receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex }>()
  readonly mempool = new Map<string, MinedTx>()
  private readonly nonceHistory: { block: bigint; from: string; nonce: number }[] = []

  constructor(startNonce = 5) {
    this.nonceHistory.push({ block: 0n, from: OWNER.toLowerCase(), nonce: startNonce })
  }

  static blockHash(n: bigint): Hex {
    return toHex(n, { size: 32 })
  }

  nonceAt(from: string, block: bigint): number {
    let n = 0
    for (const h of this.nonceHistory) if (h.from === from.toLowerCase() && h.block <= block) n = h.nonce
    return n
  }

  // Mine `tx` in a new block (its own, or another transaction for the same nonce).
  include(tx: MinedTx, status: "success" | "reverted" = "success"): bigint {
    this.head += 1n
    const hash = StubChain.blockHash(this.head)
    this.blocks.set(this.head, { hash, txs: [tx] })
    this.receipts.set(tx.hash, { status, blockNumber: this.head, blockHash: hash })
    this.nonceHistory.push({ block: this.head, from: tx.from.toLowerCase(), nonce: tx.nonce + 1 })
    for (const [h, m] of this.mempool) if (m.from === tx.from && m.nonce === tx.nonce) this.mempool.delete(h)
    return this.head
  }

  // Another transaction from the same account takes `nonce`.
  replace(nonce: number, from: Address = OWNER): bigint {
    return this.include({ hash: STRANGER_TX, from, nonce })
  }

  private timeout(what: Lookup) {
    if (this.outage.has(what)) throw new TimeoutError({ body: { method: what }, url: "stub" })
  }

  client(): PublicClient {
    const c = this
    return {
      getGasPrice: async () => c.gasPrice,
      estimateGas: async () => c.estimate,
      getBalance: async () => c.balance,
      getBlockNumber: async () => (c.timeout("blockNumber"), c.head),
      getTransactionCount: async ({ address, blockTag, blockNumber }: { address: Address; blockTag?: string; blockNumber?: bigint }) => {
        c.timeout("count")
        if (blockNumber !== undefined) return c.nonceAt(address, blockNumber)
        const latest = c.nonceAt(address, c.head)
        return blockTag === "pending" ? latest + [...c.mempool.values()].filter((m) => m.from.toLowerCase() === address.toLowerCase()).length : latest
      },
      request: async ({ method, params }: { method: string; params: [Hex] }) => {
        if (method !== "eth_sendRawTransaction") throw new Error(`unexpected ${method}`)
        const raw = params[0]
        const hash = keccak256(raw)
        c.onSend?.(raw, hash)
        c.sent.push(raw)
        const nonce = decodeNonce(raw) ?? c.nonceAt(OWNER, c.head)
        if (c.mine) c.include({ hash, from: OWNER, nonce })
        else c.mempool.set(hash, { hash, from: OWNER, nonce })
        return hash
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        c.timeout("receipt")
        const r = c.receipts.get(hash)
        if (!r) throw new TransactionReceiptNotFoundError({ hash })
        return { ...r, transactionHash: hash, gasUsed: 400_000n, effectiveGasPrice: c.gasPrice, contractAddress: null }
      },
      getTransaction: async ({ hash }: { hash: Hex }) => {
        c.timeout("transaction")
        const pending = c.mempool.get(hash)
        if (pending) return { ...pending, blockNumber: null }
        const r = c.receipts.get(hash)
        if (r) return { hash, blockNumber: r.blockNumber }
        throw new TransactionNotFoundError({ hash })
      },
      getBlock: async ({ blockNumber, includeTransactions }: { blockNumber: bigint; includeTransactions?: boolean }) => {
        c.timeout("block")
        if (blockNumber > c.head) throw new BlockNotFoundError({ blockNumber })
        const b = c.blocks.get(blockNumber) ?? { hash: StubChain.blockHash(blockNumber), txs: [] }
        return { number: blockNumber, hash: b.hash, transactions: includeTransactions ? b.txs : b.txs.map((t) => t.hash) }
      },
    } as unknown as PublicClient
  }
}

// Deterministic stand-in for signing: the bytes encode the fields, so the same intent and
// nonce always give the same hash, as RFC 6979 signatures do.
export const stubSigner = {
  address: OWNER,
  signTransaction: async (tx: TransactionSerializable) => toHex(JSON.stringify({ ...tx, gas: String(tx.gas), gasPrice: String(tx.gasPrice), value: String(tx.value) })),
}

function decodeNonce(raw: Hex): number | undefined {
  try {
    return (JSON.parse(hexToString(raw)) as { nonce?: number }).nonce
  } catch {
    return undefined
  }
}
