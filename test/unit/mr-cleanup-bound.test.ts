// How many cleanup transactions a run can need, and the reserve built from it.
// ARITHMETIC ONLY: no chain.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cleanupTxBound, MAX_CLOSE_ATTEMPTS } from "../../src/margin-rescue/cleanup.js"
import { BTC_POOL, ETH_POOL } from "../../src/margin-rescue/common.js"
import { CLEANUP_GAS_PER_TX, CLEANUP_TX_WORST_CASE } from "../../src/margin-rescue/executor.js"

describe("cleanup transaction bound", () => {
  it("uses the real retry limit: 2 grants + 2×3 closes + 2 revokes + withdraw + allowance = 12", () => {
    assert.equal(MAX_CLOSE_ATTEMPTS, 3)
    assert.equal(cleanupTxBound({ legs: [BTC_POOL, ETH_POOL], granted: [], collateral: true }), 12)
    assert.equal(CLEANUP_TX_WORST_CASE, 12)
  })

  it("follows the footprint each main step can leave behind", () => {
    const at = (legs: string[], granted: string[], collateral: boolean) => cleanupTxBound({ legs, granted, collateral })
    assert.equal(at([], [], false), 1, "deploy / approve: only an allowance to reset")
    assert.equal(at([], [], true), 2, "deposit: withdraw + allowance")
    assert.equal(at([BTC_POOL], [], true), 1 + 3 + 1 + 1 + 1, "first leg open")
    assert.equal(at([BTC_POOL, ETH_POOL], [], true), 12, "both legs open, nothing granted yet")
    assert.equal(at([BTC_POOL, ETH_POOL], [BTC_POOL], true), 1 + 6 + 2 + 1 + 1, "after the grant for the rescue")
    assert.equal(at([ETH_POOL], [BTC_POOL], true), 1 + 3 + 2 + 1 + 1, "a grant left on a pool whose position is gone still needs its revoke")
  })

  it("the reserve covers both legs exhausting their attempts, then revokes, withdrawal and allowance clearing", () => {
    // The path: grant BTC, 3 BTC closes, grant ETH, 3 ETH closes, revoke ×2, withdraw, approve(0).
    const path = ["grant", "close", "close", "close", "grant", "close", "close", "close", "revoke", "revoke", "withdraw", "approve0"]
    const reservedTx = cleanupTxBound({ legs: [BTC_POOL, ETH_POOL], granted: [], collateral: true })
    assert.ok(path.length <= reservedTx, `${path.length} cleanup transactions, ${reservedTx} reserved`)
    // Each is reserved at its worst gas LIMIT: a 10M estimate × 1.3 headroom.
    const gasPrice = 6_000_000_000n
    const worstLimit = (10_000_000n * 130n) / 100n
    assert.ok(CLEANUP_GAS_PER_TX >= worstLimit)
    assert.ok(BigInt(path.length) * worstLimit * gasPrice <= BigInt(reservedTx) * CLEANUP_GAS_PER_TX * gasPrice)
  })
})
