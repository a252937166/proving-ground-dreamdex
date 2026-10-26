// Which rounding does the DEPLOYED bank use? Every holder of every perp pool, read
// from the bank's own per-(pool, side) holder roster at ONE block (no indexer), is
// reconstructed from raw position fields and the pool snapshot under both PnL
// roundings, and compared with the account-level equity and requirements the same
// call returns.
import type { Address, PublicClient } from "viem"
import { marginBankAbi, perpPoolAbi, perpPoolFactoryAbi } from "./abi.js"
import { accountFigures, fundingOwed, pnlRoundsDifferently, type PricedLeg } from "./math.js"
import { readAt, type BlockRef } from "./rpc.js"

export interface RoundingStudy {
  version: "mr-rounding-study/1"
  block: BlockRef
  pools: number
  sideEntries: number
  accounts: number
  compared: number
  multiMarketAccounts: number
  maxLegs: number
  skipped: { inconsistentRows: number; unpriceable: number }
  legs: number
  legsRoundingDifferently: number
  accountsWithSuchLeg: number
  equityFloorExact: number
  equityTruncExact: number
  truncFailuresWithoutSuchLeg: number
  mmExact: number
  imExact: number
  cmExact: number
  mismatches: { account: string; field: string; bankMinusIndependent: string }[]
}

type State = {
  account: Address
  priceable: boolean
  equity: bigint
  imReq: bigint
  mmReq: bigint
  cmReq: bigint
  position: { size: bigint; avgEntryPrice: bigint; entryFundingIndex: bigint }
  unlockedCollateralBalance: bigint
  lockedCollateral: bigint
}
type Snap = { oneBase: bigint; markPrice: bigint; projectedCumulativeFunding: bigint; effectiveIMFBps: bigint; maintenanceMarginBps: bigint; closeOutMarginBps: bigint }

export async function roundingStudy(client: PublicClient, bank: Address, block: BlockRef): Promise<RoundingStudy> {
  type Config = { perpPoolFactory: Address }
  const cfg = await readAt<Config>(client, block, { address: bank, abi: marginBankAbi, functionName: "getSystemConfig" })
  const pools = await readAt<readonly Address[]>(client, block, { address: cfg.perpPoolFactory, abi: perpPoolFactoryAbi, functionName: "getPerpPools" })
  const snaps = new Map<string, Snap | null>()
  for (const p of pools) {
    const [ok, s] = await readAt<readonly [boolean, Snap]>(client, block, { address: p, abi: perpPoolAbi, functionName: "tryGetHealthSnapshot" })
    snaps.set(p.toLowerCase(), ok ? s : null)
  }
  const byAccount = new Map<string, { legs: { pool: Address; s: State }[] }>()
  let sideEntries = 0
  for (const p of pools) {
    for (const isLong of [true, false]) {
      for (let start = 0n; ; start += 300n) {
        const [states, length] = await readAt<readonly [readonly State[], bigint]>(client, block, {
          address: bank,
          abi: marginBankAbi,
          functionName: "getSideHolderStatesPaginated",
          args: [p, isLong, start, 300n],
        })
        for (const s of states) {
          sideEntries++
          const e = byAccount.get(s.account.toLowerCase()) ?? { legs: [] }
          e.legs.push({ pool: p, s })
          byAccount.set(s.account.toLowerCase(), e)
        }
        if (start + 300n >= length) break
      }
    }
  }

  const out: RoundingStudy = {
    version: "mr-rounding-study/1",
    block,
    pools: pools.length,
    sideEntries,
    accounts: byAccount.size,
    compared: 0,
    multiMarketAccounts: 0,
    maxLegs: 0,
    skipped: { inconsistentRows: 0, unpriceable: 0 },
    legs: 0,
    legsRoundingDifferently: 0,
    accountsWithSuchLeg: 0,
    equityFloorExact: 0,
    equityTruncExact: 0,
    truncFailuresWithoutSuchLeg: 0,
    mmExact: 0,
    imExact: 0,
    cmExact: 0,
    mismatches: [],
  }
  for (const [account, e] of byAccount) {
    const s0 = e.legs[0].s
    if (e.legs.some(({ s }) => s.equity !== s0.equity || s.mmReq !== s0.mmReq || s.unlockedCollateralBalance !== s0.unlockedCollateralBalance)) {
      out.skipped.inconsistentRows++
      continue
    }
    if (!s0.priceable || e.legs.some(({ pool }) => !snaps.get(pool.toLowerCase()))) {
      out.skipped.unpriceable++
      continue
    }
    out.compared++
    if (e.legs.length > 1) out.multiMarketAccounts++
    out.maxLegs = Math.max(out.maxLegs, e.legs.length)
    const legs: PricedLeg[] = e.legs.map(({ pool, s }) => {
      const sn = snaps.get(pool.toLowerCase())!
      return {
        pool,
        size: s.position.size,
        avgEntryPrice: s.position.avgEntryPrice,
        fundingOwed: fundingOwed(s.position.size, s.position.entryFundingIndex, sn.projectedCumulativeFunding, sn.oneBase),
        price: sn.markPrice,
        risk: { oneBase: sn.oneBase, initialMarginBps: sn.effectiveIMFBps, maintenanceMarginBps: sn.maintenanceMarginBps, closeOutMarginBps: sn.closeOutMarginBps },
      }
    })
    const floor = accountFigures(s0.unlockedCollateralBalance, s0.lockedCollateral, legs, "floor")
    const trunc = accountFigures(s0.unlockedCollateralBalance, s0.lockedCollateral, legs, "trunc")
    const differing = legs.filter((l) => pnlRoundsDifferently(l, l.price, l.risk.oneBase)).length
    out.legs += legs.length
    out.legsRoundingDifferently += differing
    if (differing) out.accountsWithSuchLeg++
    const check = (field: string, bankValue: bigint, mine: bigint) => {
      if (bankValue === mine) return true
      if (out.mismatches.length < 50) out.mismatches.push({ account, field, bankMinusIndependent: (bankValue - mine).toString() })
      return false
    }
    if (check("equity", s0.equity, floor.eRisk)) out.equityFloorExact++
    if (s0.equity === trunc.eRisk) out.equityTruncExact++
    else if (differing === 0) out.truncFailuresWithoutSuchLeg++
    if (check("mmReq", s0.mmReq, floor.mm)) out.mmExact++
    if (check("imReq", s0.imReq, floor.im)) out.imExact++
    if (check("cmReq", s0.cmReq, floor.cm)) out.cmExact++
  }
  return out
}
