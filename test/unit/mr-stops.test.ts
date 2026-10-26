// TP/SL stop discovery: paged to the end, de-duplicated, and refused when the indexer
// is behind the pinned block. MOCK TESTS: the indexer and the registry are stubs.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getAddress, type Address } from "viem"
import { pageAllStops } from "../../src/margin-rescue/common.js"
import { listStops, type At, type StopLister } from "../../src/margin-rescue/snapshot.js"

const OWNER = getAddress("0x8579fd904c93ee96fb7767db0c85e92461a2abe7")
const REGISTRY = getAddress("0x00000000000000000000000000000000000057a9")
const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ registry: REGISTRY, orderIdRaw: String(from + i + 1), status: i % 50 === 0 ? "PENDING" : "CANCELLED" }))

describe("stop discovery", () => {
  it("pages past the first 200 records (385 records, 2 pages)", async () => {
    const all = rows(385)
    const asked: number[] = []
    const r = await pageAllStops(async (offset, limit) => (asked.push(offset), all.slice(offset, offset + limit)))
    assert.equal(r.rows.length, 385)
    assert.equal(r.pages, 2)
    assert.deepEqual(asked, [0, 200])
  })

  it("an exact multiple of the page size reads one empty page to know it is done", async () => {
    const all = rows(400)
    const r = await pageAllStops(async (offset, limit) => all.slice(offset, offset + limit))
    assert.equal(r.rows.length, 400)
    assert.equal(r.pages, 3)
  })

  it("a stop created while paging repeats a row instead of skipping one, and it is counted once", async () => {
    let all = rows(250)
    const r = await pageAllStops(async (offset, limit) => {
      const page = all.slice(offset, offset + limit)
      if (offset === 0) all = [{ registry: REGISTRY, orderIdRaw: "9999", status: "PENDING" }, ...all] // newest first
      return page
    })
    assert.equal(r.rows.length, 250, "the new stop arrived after the first page; every old one is still there once")
    assert.equal(new Set(r.rows.map((x) => x.orderIdRaw)).size, 250)
  })

  it("refuses to return a truncated listing", async () => {
    await assert.rejects(pageAllStops(async (_o, limit) => rows(limit), 200, 3), /more than 600 stop records/)
  })

  const pool = { pool: getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0"), stopRegistry: REGISTRY } as never
  const at: At = async <T>(_address: Address, _abi: unknown, _fn: string, args?: readonly unknown[]) => {
    const live = BigInt(args![0] as bigint) % 50n === 1n
    return [live, { orderWithTrigger: { order: { isBid: false, owner: OWNER, quantity: 1n }, orderType: 0, triggerPrice: 1n, triggerOperator: 0 }, somiPaid: 0n, intent: 0 }] as unknown as T
  }
  const block = { number: 1_000n, hash: "0x01" as const, timestamp: 1n }

  it("checks every listed stop on chain at the pinned block", async () => {
    const lister: StopLister = async () => ({ rows: rows(385), pages: 2, indexedThrough: 1_005n })
    const s = await listStops({ account: OWNER, listStops: lister }, [pool], at, block)
    assert.equal(s.error, null)
    assert.equal(s.rows.length, 385)
    assert.equal(s.rows.filter((r) => r.liveAtBlock).length, 8)
    assert.equal(s.pages, 2)
  })

  it("refuses a listing from an indexer that has not reached the pinned block", async () => {
    const lister: StopLister = async () => ({ rows: rows(3), pages: 1, indexedThrough: 999n })
    const s = await listStops({ account: OWNER, listStops: lister }, [pool], at, block)
    assert.match(s.error!, /processed only through block 999, before the pinned block 1000/)
    assert.equal(s.rows.length, 0)
  })

  it("refuses a listing whose indexer height is unknown", async () => {
    const lister: StopLister = async () => ({ rows: [], pages: 1, indexedThrough: null })
    const s = await listStops({ account: OWNER, listStops: lister }, [pool], at, block)
    assert.match(s.error!, /did not report its processed height/)
  })
})
