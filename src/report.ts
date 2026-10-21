// Plain-text rendering of a snapshot and a pre-check, shared by the CLI.
import type { PrecheckInput, PrecheckResult } from "./rules.js"
import { BLITZ } from "./rules.js"
import type { Snapshot } from "./snapshot.js"
import { PRICE_DECIMALS, USD_DECIMALS, formatDecimal } from "./units.js"

const px = (v: bigint) => formatDecimal(v, PRICE_DECIMALS, 2)
const usd = (v: bigint) => formatDecimal(v, USD_DECIMALS, 4)
const iso = (sec: number) => new Date(sec * 1000).toISOString()
const row = (k: string, v: string) => `  ${k.padEnd(20)}${v}`
const yesNo = (b: boolean | null) => (b === null ? "n/a" : b ? "yes" : "no")

export function renderSnapshot(s: Snapshot): string {
  const qty = (v: bigint) => formatDecimal(v, s.market.baseDecimals)
  const d = s.derived
  const r = s.market.risk
  const level = (l: { price: bigint; quantity: bigint } | null) => (l ? `${px(l.price)}  (${qty(l.quantity)} BTC)` : "empty")
  const fundingPct = Number((s.state.fundingRate * 1_000_000n) / 10n ** 18n) / 10_000
  return [
    "dreamDEX BTC-PERP snapshot (read-only, live network)",
    row("queried at", `${s.queriedAt}  (${s.elapsedMs} ms)`),
    row("chain id", `${s.chainId} (Somnia Hideki / Tokyo testnet)`),
    row("block", `${s.block.number}  at ${s.block.isoTime}  (${s.block.bookBlockKnown ? "book and mark read at this block" : "head block; the SDK did not report the book's block"})`),
    row("SDK", `${s.sdk.package} ${s.sdk.version}`),
    row("RPC", s.endpoints.rpcUrl),
    row("indexer", s.endpoints.indexerUrl),
    "",
    "Market configuration",
    row("market", s.market.symbol),
    row("pool address", s.market.poolAddress),
    row("margin bank", s.market.marginBank),
    row("stop registry", s.market.stopRegistry),
    row("tick size", `${px(s.market.tickSize)} USDso`),
    row("lot size", `${qty(s.market.lotSize)} BTC`),
    row("min quantity", `${qty(s.market.minQuantity)} BTC`),
    row("book params", `indexer config matches on-chain getOrderBookParameters(): ${yesNo(s.market.onchainBookParamsMatchIndexer)}`),
    row("margin (bps)", `initial ${r.initialMarginBps}, maintenance ${r.maintenanceMarginBps}, close-out ${r.closeOutMarginBps}`),
    row("max position", `${qty(r.maxPositionSize)} BTC`),
    row("max open interest", `${qty(r.maxOpenInterest)} BTC`),
    row("fees (bps x1000)", `taker ${r.takerFeeBpsTimes1k}, maker ${r.makerFeeBpsTimes1k}`),
    "",
    `Prices at block ${s.block.number}`,
    row("mark", `${px(s.mark.price)}  (tryGetMarkPrice ok: ${yesNo(s.mark.ok)})`),
    row("best bid", level(d.bestBid)),
    row("best ask", level(d.bestAsk)),
    row("mid / spread", d.mid !== null && d.spread !== null ? `${px(d.mid)} / ${px(d.spread)} (${d.spreadBps} bps)` : "n/a"),
    row("mark vs mid", d.markVsMidBps !== null ? `${d.markVsMidBps} bps` : "n/a"),
    "",
    "Latest perp state (getPerpState)",
    row("mark", px(s.state.markPrice)),
    row("index", `${px(s.state.indexPrice)}  (oracle time ${iso(s.state.indexUpdatedAt)})`),
    row("funding rate", `${fundingPct}% per ${s.state.fundingWindowSec / 3600} h window; next settlement ${iso(s.state.nextFundingAt)}`),
    row("open interest", `${qty(s.state.openInterest)} BTC`),
    "",
    `Proving Ground band: IOC limit within ±${d.band.bps / 100}% of mark (local calculation, not enforced on-chain)`,
    row("allowed limits", `${px(d.band.low)} .. ${px(d.band.high)}`),
    row("ask reachable", `${yesNo(d.bestAskWithinBand)}  (a buy IOC with an in-band limit ${d.bestAskWithinBand ? "can" : "cannot"} reach the best ask now)`),
    row("bid reachable", `${yesNo(d.bestBidWithinBand)}  (a sell IOC with an in-band limit ${d.bestBidWithinBand ? "can" : "cannot"} reach the best bid now)`),
    row("reachable depth", `asks ${qty(d.askQtyWithinBand)} BTC, bids ${qty(d.bidQtyWithinBand)} BTC (within the top ${s.book.depth} levels read)`),
  ].join("\n")
}

export function renderPrecheck(s: Snapshot, input: PrecheckInput, res: PrecheckResult, priceSource: string): string {
  const qty = (v: bigint) => formatDecimal(v, s.market.baseDecimals)
  const e = res.estimate
  const mark = (c: PrecheckResult["checks"][number]) => (c.status === "pass" ? "PASS  " : c.status === "fail" ? "FAIL  " : "EXEMPT")
  return [
    "Proving Ground v2.2 Blitz order pre-check",
    "LOCAL CALCULATION ONLY. No Proving Ground contract is deployed; nothing below is enforced on-chain.",
    row("market data", `live, block ${s.block.number} (${s.block.isoTime}), chain ${s.chainId}, pool ${s.market.poolAddress}`),
    row("order", `${input.side.toUpperCase()} ${qty(input.quantity)} BTC, IOC, limit ${px(input.price)} (${priceSource})`),
    row("account (assumed)", `position ${qty(input.positionSize)} BTC, equity ${usd(input.equity)} USDso; threshold ${usd(BLITZ.breachThreshold)}`),
    row("mark", px(input.mark)),
    row("classification", res.classification),
    "",
    ...res.checks.map((c) => `  ${mark(c)} ${c.rule.padEnd(18)} [${c.source}] ${c.detail}${c.plannedError && c.status === "fail" ? `  -> planned revert ${c.plannedError}` : ""}`),
    "",
    "Worst-case estimate (full fill at the limit, mark unchanged)",
    row("fill notional", `${usd(e.fillNotional)} USDso`),
    row("fee", `${usd(e.fee)} USDso`),
    row("mark-to-market", `${usd(e.markToMarket)} USDso`),
    row("equity after", `${usd(e.postEquity)} USDso`),
    row("position after", `${qty(e.newSize)} BTC (notional ${usd(e.postNotional)} USDso)`),
    row("leverage after", e.postLeverageX1000 === null ? "n/a (equity <= 0)" : `${Number(e.postLeverageX1000) / 1000}x (limit ${Number(BLITZ.maxLeverageX1000) / 1000}x for risk-increasing orders)`),
    "",
    `VERDICT: ${res.verdict}${res.failed.length ? ` (${res.failed.join(", ")})` : ""}`,
    res.verdict === "ADMIT_THEN_BREACH" ? "  The reducing order would commit, then the account would record EQUITY_FLOOR and start its exit." : "",
  ].filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n")
}
