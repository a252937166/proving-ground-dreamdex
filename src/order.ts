// Turns user-supplied order text into a pre-check against a live snapshot.
import { precheck, type PrecheckInput, type PrecheckResult } from "./rules.js"
import { marketRules, type Snapshot } from "./snapshot.js"
import { PRICE_DECIMALS, USD_DECIMALS, parseDecimal } from "./units.js"

export interface OrderArgs {
  side?: string
  qty?: string
  price?: string // omitted: see defaultLimit
  position?: string // hypothetical signed BTC position, default 0
  equity?: string // hypothetical equity in USDso, default the 1,000 allocation
}

export interface PrecheckRun {
  input: PrecheckInput
  priceSource: string
  result: PrecheckResult
}

// The least aggressive in-band limit that still reaches the touch. A buy IOC
// fills asks priced at or below its limit, so it needs limit >= best ask; a
// sell needs limit <= best bid. When the touch is beyond the band, no in-band
// limit reaches it, and the touch price itself is used so the band check fails.
export function defaultLimit(s: Snapshot, side: "buy" | "sell"): { price: bigint; priceSource: string } {
  const { band, bestAsk, bestBid } = s.derived
  if (side === "buy") {
    if (!bestAsk) throw new Error("the book has no asks; pass a price")
    if (bestAsk.price > band.high) return { price: bestAsk.price, priceSource: "best ask, above the band" }
    if (bestAsk.price < band.low) return { price: band.low, priceSource: "band low; reaches the best ask" }
    return { price: bestAsk.price, priceSource: "best ask" }
  }
  if (!bestBid) throw new Error("the book has no bids; pass a price")
  if (bestBid.price < band.low) return { price: bestBid.price, priceSource: "best bid, below the band" }
  if (bestBid.price > band.high) return { price: band.high, priceSource: "band high; reaches the best bid" }
  return { price: bestBid.price, priceSource: "best bid" }
}

export function runPrecheck(s: Snapshot, a: OrderArgs): PrecheckRun {
  const side = a.side?.toLowerCase()
  if (side !== "buy" && side !== "sell") throw new Error('side must be "buy" or "sell"')
  if (!a.qty) throw new Error("qty is required (BTC, e.g. 0.01)")
  const decimals = s.market.baseDecimals
  const quantity = parseDecimal(a.qty, decimals)

  const { price, priceSource } = a.price ? { price: parseDecimal(a.price, PRICE_DECIMALS), priceSource: "given" } : defaultLimit(s, side)

  const input: PrecheckInput = {
    side,
    price,
    quantity,
    positionSize: parseDecimal(a.position || "0", decimals, { signed: true }),
    equity: parseDecimal(a.equity || "1000", USD_DECIMALS, { signed: true }),
    mark: s.mark.price,
    markOk: s.mark.ok,
  }
  return { input, priceSource, result: precheck(input, marketRules(s)) }
}
