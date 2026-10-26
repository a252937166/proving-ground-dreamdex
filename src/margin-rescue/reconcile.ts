// Independent reconstruction of the account's health from raw state, compared field
// by field with the deployed MarginBank's own getters at the same block.
//
// Inputs are only raw values: unlocked and locked collateral, each position's signed
// size, entry price and entry funding index, and each market's mark, projected
// cumulative funding, oneBase and margin rates. The bank's equity and requirements are
// read separately and only compared, never used as inputs.
import { accountFigures, fundingOwed, type AccountFigures, type PricedLeg } from "./math.js"
import { poolOf, type AccountSnapshot } from "./snapshot.js"

export const RECONCILIATION_VERSION = "mr-reconciliation/1"

export type ReconciliationVerdict = "EXACT" | "UNEXPLAINED" | "UNAVAILABLE"

export interface Reconciliation {
  version: typeof RECONCILIATION_VERSION
  account: string
  block: { number: bigint; hash: string }
  model: { pnl: "floor"; funding: "ceil"; requirements: "ceil per leg on floored notional" }
  independent: AccountFigures
  truncation: { eRisk: bigint; minusBank: bigint; legsRoundingDifferently: number }
  bank: { equity: bigint; imReq: bigint; mmReq: bigint; cmReq: bigint; collateralBasis: bigint }
  diffs: { equity: bigint; imReq: bigint; mmReq: bigint; cmReq: bigint; collateralBasis: bigint }
  verdict: ReconciliationVerdict
  reasons: string[]
}

// The account's legs priced at the snapshot's own marks, with funding owed at the
// snapshot's projected cumulative index.
export function snapshotLegs(snapshot: AccountSnapshot): PricedLeg[] {
  return snapshot.positions.map((p) => {
    const info = poolOf(snapshot, p.pool)
    return {
      pool: p.pool,
      size: p.size,
      avgEntryPrice: p.avgEntryPrice,
      fundingOwed: fundingOwed(p.size, p.entryFundingIndex, info.projectedCumulativeFunding, info.oneBase),
      price: info.markPrice,
      risk: {
        oneBase: info.oneBase,
        initialMarginBps: info.effectiveImfBps,
        maintenanceMarginBps: info.maintenanceMarginBps,
        closeOutMarginBps: info.closeOutMarginBps,
      },
    }
  })
}

export function reconcile(snapshot: AccountSnapshot): Reconciliation {
  const reasons: string[] = []
  const unpriced = snapshot.positions.filter((p) => !poolOf(snapshot, p.pool).priceable)
  if (unpriced.length) reasons.push(`no fresh mark for ${unpriced.map((p) => poolOf(snapshot, p.pool).symbol).join(", ")}`)
  if (!snapshot.canonical.ok) reasons.push("snapshot block is not canonical")
  if (snapshot.coverage.nonzeroOutsideActive.length) reasons.push("a position sits outside the bank's active pools")

  const legs = snapshotLegs(snapshot)
  const independent = accountFigures(snapshot.collateral.unlocked, snapshot.collateral.locked, legs, "floor")
  const truncated = accountFigures(snapshot.collateral.unlocked, snapshot.collateral.locked, legs, "trunc")
  const bank = { ...snapshot.bank, collateralBasis: snapshot.collateral.collateralBasis }
  const basis = snapshot.collateral.unlocked + snapshot.collateral.locked
  const independentBasis = basis > 0n ? basis : 0n
  const diffs = {
    equity: bank.equity - independent.eRisk,
    imReq: bank.imReq - independent.im,
    mmReq: bank.mmReq - independent.mm,
    cmReq: bank.cmReq - independent.cm,
    collateralBasis: bank.collateralBasis - independentBasis,
  }
  if (snapshot.bank.tryEquityOk && snapshot.bank.tryEquity !== snapshot.bank.equity) reasons.push("tryGetAccountEquity disagrees with getAccountHealth")

  let verdict: ReconciliationVerdict
  if (unpriced.length || !snapshot.canonical.ok || snapshot.coverage.nonzeroOutsideActive.length) {
    verdict = "UNAVAILABLE"
  } else if (Object.values(diffs).every((d) => d === 0n)) {
    verdict = "EXACT"
  } else {
    verdict = "UNEXPLAINED"
    for (const [field, d] of Object.entries(diffs)) if (d !== 0n) reasons.push(`${field}: bank − independent = ${d} raw units`)
  }
  const legsRoundingDifferently = independent.legs.filter((l) => l.pnlRoundsDifferently).length
  return {
    version: RECONCILIATION_VERSION,
    account: snapshot.account,
    block: { number: snapshot.block.number, hash: snapshot.block.hash },
    model: { pnl: "floor", funding: "ceil", requirements: "ceil per leg on floored notional" },
    independent,
    truncation: { eRisk: truncated.eRisk, minusBank: truncated.eRisk - bank.equity, legsRoundingDifferently },
    bank,
    diffs,
    verdict,
    reasons,
  }
}
