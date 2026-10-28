// Markup the app's screens share: icons, amounts and prices, block numbers, candidate
// names and the margin meter. Strings only; nothing here touches the page.
import { esc, usd } from "./data.js"

export const ICON = {
  ok: '<svg class="icon ok-ink" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 8 14.5 16 5.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  bad: '<svg class="icon bad-ink" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  wait: '<svg class="icon wait-ink" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 6v4.5l3 2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  arrow: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  copy: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 4.5h-7a2 2 0 0 0-2 2v7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
}
const ONE = 10n ** 18n

// Prices below 10 USDso keep four decimals, the rest two.
export const price = (raw) => usd(raw, BigInt(raw) < 10n * ONE ? 4 : 2)
// Statement amounts: negatives in parentheses.
export const money = (raw) => `<span class="num${BigInt(raw ?? 0) < 0n ? " neg" : ""}">${usd(raw, 2, { paren: true })}</span>`
// A raw 1e18 amount as a float, for drawing only; every printed figure stays BigInt.
export const float = (raw) => Number(BigInt(raw ?? 0) / 10n ** 12n) / 1e6
export const blockNo = (n) => Number(n).toLocaleString("en-US")
export const candidateName = (c) =>
  c.kind === "NONE" ? "No action" : c.kind === "CANCEL_ORDERS" ? "Cancel resting orders" : c.id.replace(/^([A-Z]+)-(\d+)$/, (_, s, p) => `${s} −${p}%`)

// The margin meter: each row draws health equity against the maintenance line on one scale;
// a row with `from` travels from that state to its own.
export function meterHTML(rows) {
  const scale = Math.max(1e-9, ...rows.flatMap((r) => [float(r.e), float(r.mm), r.from ? float(r.from.e) : 0, r.from ? float(r.from.mm) : 0])) * 1.08
  const ratio = (raw) => Math.max(0, Math.min(1, float(raw) / scale)).toFixed(4)
  const row = (r) => `<div class="mm-row" data-tone="${r.tone ?? ""}">
      <span class="mm-label">${esc(r.label)}</span>
      <div class="mm-track" role="img" aria-label="${esc(r.label)}: health equity ${esc(usd(r.e, 2, { paren: true }))} against maintenance ${esc(usd(r.mm))} USDso">
        <i class="mm-fill" style="--v:${ratio(r.e)};--from:${ratio(r.from?.e ?? 0)}"></i>
        <i class="mm-line" style="--m:${ratio(r.mm)};--mfrom:${ratio(r.from?.mm ?? r.mm)}"></i>
      </div>
      <span class="mm-val${BigInt(r.buffer) < 0n ? " neg" : ""}">${usd(r.buffer, 2, { paren: true })}</span>
    </div>`
  return `<div class="mmeter armed">${rows.map(row).join("")}<p class="mm-key"><span><i></i>health equity</span><span><i class="dash"></i>maintenance</span><span>buffer on the right, USDso</span></p></div>`
}
