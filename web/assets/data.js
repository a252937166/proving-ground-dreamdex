// Formatting and fetching shared by the site's pages. Raw chain integers arrive as decimal
// strings and stay BigInt until they are printed; nothing passes through floating point.

export function units(raw, decimals, maxFrac = decimals, { sign = false, group = true, paren = false } = {}) {
  if (raw === null || raw === undefined || raw === "") return "—"
  let v = BigInt(raw)
  const neg = v < 0n
  if (neg) v = -v
  const base = 10n ** BigInt(decimals)
  // Round half away from zero at maxFrac digits.
  if (maxFrac < decimals) {
    const step = 10n ** BigInt(decimals - maxFrac)
    v = ((v + step / 2n) / step) * step
  }
  const whole = (v / base).toString()
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac)
  const grouped = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole
  const body = frac ? `${grouped}.${frac}` : grouped
  if (neg && v > 0n) return paren ? `(${body})` : `−${body}`
  return (sign && v > 0n ? "+" : "") + body
}

export const usd = (raw, frac = 2, opts) => units(raw, 18, frac, opts)
export const px = (raw, frac = 2) => units(raw, 18, frac)
export const qty = (raw, decimals) => {
  const s = units(raw, decimals, decimals)
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s
}

export function short(hex, head = 6, tail = 4) {
  if (!hex) return "—"
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`
}

export const pct = (bps) => (bps === null || bps === undefined ? "held" : `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps) / 100}%`)

export function ago(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

// A link to one of the site's own pages or files. The site sits at "/" locally; the
// static build (GitHub Pages) serves it under a path, set on <html data-base>.
const BASE = document.documentElement.dataset.base || "/"
export const href = (path) => BASE + path.replace(/^\//, "")

export async function getJson(url, { signal } = {}) {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } })
  let body
  try {
    body = await res.json()
  } catch {
    throw new Error(`${url} answered ${res.status} without JSON`)
  }
  if (!res.ok) throw new Error(body.error || `${url} answered ${res.status}`)
  return body
}

// Hideki's block explorer is not wired into this site; hashes are shown in full on hover
// and copied on click, so they can be checked in any explorer or with `cast`.
export function copyable(hex, label = short(hex)) {
  return `<button type="button" class="hash" data-copy="${esc(hex)}" title="${esc(hex)} (click to copy)">${esc(label)}</button>`
}

export function wireCopy(root = document) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest?.("[data-copy]")
    if (!b) return
    try {
      await navigator.clipboard.writeText(b.dataset.copy)
      b.dataset.copied = "true"
      setTimeout(() => delete b.dataset.copied, 1200)
    } catch {
      // Clipboard unavailable (insecure context or denied): the full value stays in the title.
    }
  })
}

// How live run 1 is shown everywhere (the server's run-state model, runState.ts). Only
// VERIFIED_COMPLETE, which requires a valid independent read-back bound to the run, is
// shown as verified; a run that started is never shown as not run.
const LIVE_SHORT = {
  NOT_STARTED: "Not run yet",
  INVALID_BUNDLE: "Evidence fails its check",
  IN_PROGRESS: "Started · no result yet",
  REFUSED: "Refused before signing",
  SIGNED_NOT_SENT: "Signed, never sent",
  UNRESOLVED_TX: "Unresolved transaction",
  ABORTED: "Aborted",
  NOT_DEMONSTRATED: "Not demonstrated",
  CLEANUP_INCOMPLETE: "Cleanup incomplete",
  FAILED_AFTER_START: "Failed after start",
  STATE_UNKNOWN: "State unknown",
  COMPLETE_UNVERIFIED: "Not independently verified",
  VERIFIED_COMPLETE: "Verified",
}
export function liveStatus(view) {
  const state = view?.state ?? "NOT_STARTED"
  return {
    state,
    started: !!view?.started,
    verified: state === "VERIFIED_COMPLETE",
    tone: state === "VERIFIED_COMPLETE" ? "met" : state === "NOT_STARTED" || state === "IN_PROGRESS" ? "wait" : "call",
    short: LIVE_SHORT[state] ?? state,
    headline: view?.headline ?? "not started",
  }
}
