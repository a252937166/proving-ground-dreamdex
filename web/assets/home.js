// Overview and Features: the live ticker, the rescue lifecycle console that replays the fork
// run, the walkthrough, the distribution chart, the proof track, and the feature demos. Every
// figure animated here is already printed in the page; motion only travels toward it.
import { esc, getJson, liveStatus, qty, usd } from "./data.js"
import { countUp, onVisible, reduced, rollTo, scramble, sleep, splitWords, tooltip, tween, whileVisible } from "./motion.js"

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const ICON = {
  ok: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 8 14.5 16 5.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  tri: '<svg class="tri" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5 9 8.5H1z" fill="currentColor"/></svg>',
}

// Two headlines rise word by word: the hero's on arrival and the close's as it scrolls in.
if (!reduced()) for (const h of $$("[data-split], .final .title")) splitWords(h)

// ---- live ticker: BTC-PERP and ETH-PERP read from the testnet every 10 s ----

const ONE = 10n ** 18n
const price = (raw) => (raw === null || raw === undefined ? "—" : usd(raw, BigInt(raw) < 10n * ONE ? 4 : 2))
function fundingPct(rate) {
  const r = BigInt(rate)
  const v = ((r < 0n ? -r : r) * 1_000_000n) / ONE
  return `${r < 0n ? "−" : "+"}${(Number(v) / 10_000).toFixed(4)}%`
}

function tickerItems(markets) {
  const one = (m) => {
    const base = m.market.symbol.split("-")[0]
    return `<span class="tick" data-sym="${esc(m.market.symbol)}">
      <b>${esc(m.market.symbol)}</b><b data-k="mark">${m.mark.ok ? price(m.mark.price) : "stale"}</b>${ICON.tri}
      <span class="sep"></span>Index <b data-k="index">${price(m.state.indexPrice)}</b>
      <span class="sep"></span>Funding <b data-k="funding">${fundingPct(m.state.fundingRate)}</b> / ${m.state.fundingWindowSec / 3600} h
      <span class="sep"></span>Spread <b data-k="spread">${m.derived.spreadBps === null ? "—" : `${m.derived.spreadBps} bps`}</b>
      <span class="sep"></span>Open interest <b data-k="oi">${qty(m.state.openInterest, m.market.baseDecimals)}</b> ${esc(base)}
    </span>`
  }
  const block = markets[0]?.block?.number
  return markets.map(one).join("") + `<span class="tick">Block <b data-k="block">${block ? Number(block).toLocaleString("en-US") : "—"}</b><span class="sep"></span>Chain 50383</span>`
}

function startTicker() {
  const root = $("[data-ticker]")
  if (!root) return
  const track = $("[data-ticker-track]", root)
  let built = ""
  const last = new Map()
  const read = async () => {
    let markets
    try {
      ;({ markets } = await getJson("/api/markets"))
    } catch (err) {
      if (!built) track.innerHTML = `<span class="tick muted">Markets unavailable: ${esc(err.message)}</span>`
      return
    }
    const shape = markets.map((m) => m.market.symbol).join()
    if (shape !== built) {
      const html = tickerItems(markets)
      track.innerHTML = `<div class="ticker-items">${html}</div><div class="ticker-items" aria-hidden="true">${html}</div>`
      built = shape
      requestAnimationFrame(() => track.style.setProperty("--dur", `${Math.max(30, track.scrollWidth / 2 / 42)}s`))
    }
    for (const m of markets) {
      const prev = last.get(m.market.symbol)
      const now = m.mark.ok ? BigInt(m.mark.price) : null
      for (const tick of $$(`.tick[data-sym="${m.market.symbol}"]`, track)) {
        const set = (k, v) => {
          const el = $(`[data-k="${k}"]`, tick)
          if (el && el.textContent !== v) el.textContent = v
        }
        set("mark", now === null ? "stale" : price(m.mark.price))
        set("index", price(m.state.indexPrice))
        set("funding", fundingPct(m.state.fundingRate))
        set("spread", m.derived.spreadBps === null ? "—" : `${m.derived.spreadBps} bps`)
        set("oi", qty(m.state.openInterest, m.market.baseDecimals))
        if (prev !== undefined && now !== null && now !== prev) {
          const up = now > prev
          tick.classList.toggle("up", up)
          tick.classList.toggle("down", !up)
          tick.title = "Arrow: direction of the mark since the previous read, 10 s earlier"
          const b = $('[data-k="mark"]', tick)
          b.classList.remove("flash-up", "flash-down")
          void b.offsetWidth
          b.classList.add(up ? "flash-up" : "flash-down")
        }
      }
      if (now !== null) last.set(m.market.symbol, now)
    }
    for (const b of $$('[data-k="block"]', track)) b.textContent = Number(markets[0].block.number).toLocaleString("en-US")
  }
  whileVisible(root, async (signal) => {
    for (;;) {
      await read()
      await sleep(10_000, signal)
    }
  }, { threshold: 0 })
}

// ---- the rescue lifecycle console: a replay of the fork run, figures from its evidence ----

const LEGS = {
  btc: { ref: "79,976.86", scn: "73,578.71", move: "−8%", pnlRef: "(225.91)", pnlScn: "(581.33)" },
  eth: { ref: "2,316.66", scn: "2,038.66", move: "−12%", pnlRef: "(150.36)", pnlScn: "(604.33)", pnlAfter: "(299.50)" },
  sol: { ref: "100.82", pnlRef: "(129.20)" },
  xrp: { ref: "1.2830", pnlRef: "(115.52)" },
  bnb: { ref: "738.85", pnlRef: "7.18" },
  sui: { ref: "0.9083", pnlRef: "(171.07)" },
}
const PNL_SPAN = 650 // USDso from the zero line to the end of a leg's bar
const METER_SPAN = 1100 // USDso across the margin meter
const STATE = {
  ref: { eq: "1,019.20", mm: "492.10", buf: "527.10" },
  scn: { eq: "209.81", mm: "471.87", buf: "(262.05)" },
  after: { eq: "436.73", mm: "430.25", buf: "6.48" },
}
const num = (t) => (/^\(/.test(t) ? -1 : 1) * Number(t.replace(/[^\d.]/g, ""))
const BADGE = {
  reading: '<span class="ping" aria-hidden="true"></span>Reading',
  exact: `${ICON.ok}Reconciled exact`,
  call: '<span class="ping" aria-hidden="true"></span>Margin call',
  met: `${ICON.ok}Call met`,
}

function startConsole() {
  const root = $("#console")
  if (!root || reduced()) return
  const c = {
    stages: $$("[data-stages] li", root),
    stagesEl: $("[data-stages]", root),
    chips: $$("[data-chips] .chip", root),
    meter: $("[data-meter]", root),
    eq: $("[data-eq]", root),
    mm: $("[data-mm]", root),
    buf: $("[data-buf]", root),
    badge: $("[data-badge]", root),
    note: $("[data-note]", root),
    block: $("[data-block]", root),
    legs: Object.fromEntries($$("[data-leg]", root).map((el) => [el.dataset.leg, el])),
  }
  for (const chip of c.chips) chip.dataset.final = chip.className
  const leg = (sym, k) => $(`[data-${k}]`, c.legs[sym])

  const setBar = (sym, text) => {
    const bar = leg(sym, "bar")
    const v = num(text)
    bar.classList.toggle("neg", v < 0)
    bar.style.setProperty("--v", String(Math.min(1, Math.abs(v) / PNL_SPAN)))
  }
  const setPnl = (sym, text) => {
    const el = leg(sym, "pnl")
    el.textContent = text
    el.classList.toggle("neg", num(text) < 0)
    setBar(sym, text)
  }
  const setBadge = (kind) => {
    c.badge.className = `badge big pop ${{ reading: "", exact: "info", call: "call", met: "met" }[kind]}`
    c.badge.innerHTML = BADGE[kind]
  }
  const setNote = (text) => {
    c.note.textContent = text
    c.note.animate?.([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 400, easing: "cubic-bezier(0.16, 1, 0.3, 1)" })
  }
  const stage = (n) => {
    c.stages.forEach((li, i) => {
      li.classList.toggle("done", i < n)
      li.classList.toggle("active", i === n)
    })
    c.stagesEl.style.setProperty("--sp", String(Math.min(1, Math.max(0, n / (c.stages.length - 1)))))
  }
  const hot = (sym) => Object.entries(c.legs).forEach(([k, el]) => el.classList.toggle("hot", k === sym))
  const meterTo = (to, signal) => {
    const fromEq = num(c.eq.textContent)
    const fromMm = num(c.mm.textContent)
    const toEq = num(to.eq)
    const toMm = num(to.mm)
    return Promise.all([
      tween(1100, (k) => {
        c.meter.style.setProperty("--eq", String(Math.max(0, fromEq + (toEq - fromEq) * k) / METER_SPAN))
        c.meter.style.setProperty("--mm", String((fromMm + (toMm - fromMm) * k) / METER_SPAN))
      }, { signal }),
      rollTo(c.eq, c.eq.textContent, to.eq, { ms: 1100, signal }),
      rollTo(c.mm, c.mm.textContent, to.mm, { ms: 1100, signal }),
      rollTo(c.buf, c.buf.textContent, to.buf, { ms: 1100, signal }),
    ])
  }

  const reset = () => {
    for (const [sym, d] of Object.entries(LEGS)) {
      leg(sym, "mark").textContent = d.ref
      const mv = leg(sym, "move")
      mv.textContent = "—"
      mv.classList.add("held")
      setPnl(sym, d.pnlRef)
    }
    hot(null)
    c.eq.textContent = STATE.ref.eq
    c.mm.textContent = STATE.ref.mm
    c.buf.textContent = STATE.ref.buf
    c.buf.className = "num"
    c.meter.dataset.state = "ok"
    c.meter.style.setProperty("--eq", String(num(STATE.ref.eq) / METER_SPAN))
    c.meter.style.setProperty("--mm", String(num(STATE.ref.mm) / METER_SPAN))
    for (const chip of c.chips) chip.className = "chip idle"
    c.block.textContent = "33,472,616"
    stage(-1)
    setBadge("reading")
    setNote("Reading the account at one block across all 21 pools")
  }

  const play = async (signal) => {
    let first = true
    for (;;) {
      // Each loop after the first resets behind a fade, so no figure visibly snaps back.
      if (!first) {
        root.classList.add("fading")
        await sleep(450, signal)
      }
      reset()
      root.classList.remove("fading")
      await sleep(first ? 1500 : 800, signal)
      first = false

      stage(0)
      setNote("Health rebuilt from raw state matches the bank's getter to the raw unit")
      setBadge("exact")
      await sleep(1700, signal)

      stage(1)
      setNote("BTC −8% and ETH −12% at fixed prices; every other market held at its mark")
      for (const sym of ["btc", "eth"]) {
        const d = LEGS[sym]
        hot(sym)
        const mv = leg(sym, "move")
        mv.textContent = d.move
        mv.classList.remove("held")
        await Promise.all([rollTo(leg(sym, "mark"), d.ref, d.scn, { ms: 900, signal }), rollTo(leg(sym, "pnl"), d.pnlRef, d.pnlScn, { ms: 900, signal })])
        setPnl(sym, d.pnlScn)
      }
      for (const sym of ["sol", "xrp", "bnb", "sui"]) leg(sym, "move").textContent = "held"
      hot(null)
      await meterTo(STATE.scn, signal)
      c.meter.dataset.state = "call"
      c.buf.className = "num neg"
      setBadge("call")
      setNote("Buffer (262.05) under the move: the account would be under maintenance")
      await sleep(1700, signal)

      stage(2)
      setNote("Each reduction filled now against the book, the rest valued at the scenario")
      for (const chip of c.chips) {
        chip.className = "chip checking"
        await sleep(190, signal)
        chip.className = chip.dataset.final.replace(" preferred", "")
      }
      await sleep(350, signal)
      for (const chip of c.chips) chip.className = chip.dataset.final.includes("preferred") ? chip.dataset.final : `${chip.dataset.final} dim`
      setNote("ETH −50%: the smallest cut that meets the target, 1,891.55 against BTC −75%'s 3,331.84")
      await sleep(2200, signal)

      stage(3)
      hot("eth")
      setNote("Guarded sell of 0.8165 ETH, IOC, limit 2,305.06; the live position equals the confirmed 1.633 ETH")
      await sleep(2000, signal)

      stage(4)
      await rollTo(c.block, "33,472,616", "33,472,619", { ms: 500, signal })
      setNote("Filled 0.4316 at 2,316.64 and 0.3849 at 2,316.50, inside the limit")
      await rollTo(leg("eth", "pnl"), LEGS.eth.pnlScn, LEGS.eth.pnlAfter, { ms: 900, signal })
      setPnl("eth", LEGS.eth.pnlAfter)
      await sleep(1300, signal)

      stage(5)
      setNote("Recomputed from the fills, at the same scenario prices")
      await meterTo(STATE.after, signal)
      c.meter.dataset.state = "met"
      c.buf.className = "num pos"
      hot(null)
      stage(6)
      setBadge("met")
      await sleep(5200, signal)
    }
  }

  whileVisible(root, async (signal) => {
    try {
      await play(signal)
    } finally {
      root.classList.remove("fading")
    }
  }, { threshold: 0.25 })
}

// ---- diverging bars in tables: zero in the middle, length from each row's value ----

function setBars(table) {
  const span = Number(table.dataset.domain)
  for (const tr of $$("tr[data-v]", table)) {
    const v = Number(tr.dataset.v)
    const i = $(".dbar i", tr)
    if (!i) continue
    i.classList.toggle("neg", v < 0)
    i.style.setProperty("--w", String(Math.max(0.012, Math.min(1, Math.abs(v) / span))))
  }
}

// ---- the walkthrough: on wide screens the step crossing mid-screen picks the window ----

function startStory() {
  const root = $("[data-story]")
  if (!root) return
  for (const t of $$("table.bars", root)) setBars(t)
  const steps = $$(".step", root)
  const panes = $$(".pane", root)
  const wide = matchMedia("(min-width: 1081px)")
  let active = -1
  const activate = (i) => {
    if (i === active || i < 0) return
    active = i
    steps.forEach((s, k) => s.classList.toggle("is-active", k === i))
    panes.forEach((p, k) => p.classList.toggle("is-active", k === i))
  }
  const spy = new IntersectionObserver(
    (entries) => {
      if (!wide.matches) return
      for (const e of entries) if (e.isIntersecting) activate(steps.indexOf(e.target))
    },
    { rootMargin: "-45% 0px -45% 0px" },
  )
  steps.forEach((s) => spy.observe(s))
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || wide.matches) continue
        e.target.classList.add("seen")
        seen.unobserve(e.target)
      }
    },
    { threshold: 0.2 },
  )
  panes.forEach((p) => seen.observe(p))
  // Each window centres itself on the reading line at its own height, so a short record is
  // never padded out and the cross-fade meets on the same centre.
  const size = () => {
    for (const p of panes) {
      const w = $(".window", p)
      if (wide.matches) w.style.setProperty("--h", `${Math.ceil(w.offsetHeight)}px`)
      else w.style.removeProperty("--h")
    }
  }
  size()
  document.fonts?.ready.then(size)
  addEventListener("resize", size)
  if (wide.matches) activate(0)
  wide.addEventListener("change", () => {
    size()
    if (wide.matches && active < 0) activate(0)
  })
}

// ---- accounts by markets held: columns built from the table beside them ----

function startDistribution() {
  const fig = $(".scan")
  if (!fig) return
  const rows = $$("[data-dist] tbody tr", fig).map((tr) => ({ m: Number(tr.cells[0].textContent), n: Number(tr.cells[1].textContent.replace(/,/g, "")) }))
  const tail = rows.filter((r) => r.m >= 2)
  const top = 350
  const cols = $("[data-cols]", fig)
  cols.removeAttribute("aria-hidden")
  cols.setAttribute("role", "group")
  cols.setAttribute("aria-label", "Accounts holding 2 to 21 markets; each column is one count")
  for (const t of [0, 100, 200, 300]) {
    const g = document.createElement("div")
    g.className = "grid"
    g.setAttribute("aria-hidden", "true")
    g.style.bottom = `calc(22px + ${t / top} * (100% - 22px))`
    const s = document.createElement("span")
    s.textContent = String(t)
    g.append(s)
    cols.append(g)
  }
  const plot = document.createElement("div")
  plot.className = "plot"
  const maxRow = tail.reduce((a, b) => (b.n > a.n ? b : a))
  for (const [i, r] of tail.entries()) {
    const col = document.createElement("div")
    col.className = `col${r.n === 0 ? " zero" : ""}`
    col.tabIndex = 0
    col.setAttribute("role", "img")
    col.setAttribute("aria-label", `${r.m} markets: ${r.n.toLocaleString("en-US")} accounts`)
    col.style.setProperty("--h", `${(r.n / top) * 100}%`)
    col.style.setProperty("--i", String(i))
    col.dataset.m = String(r.m)
    col.dataset.n = r.n.toLocaleString("en-US")
    const bar = document.createElement("i")
    const x = document.createElement("span")
    x.className = "x"
    x.textContent = String(r.m)
    x.setAttribute("aria-hidden", "true")
    if (r.m % 2 === 1 && r.m !== 21) x.classList.add("odd")
    col.append(bar, x)
    if (r === maxRow || r.m === 21) {
      const lbl = document.createElement("span")
      lbl.className = "lbl"
      lbl.setAttribute("aria-hidden", "true")
      lbl.textContent = r.m === 21 ? `21 markets: ${r.n}` : r.n.toLocaleString("en-US")
      col.append(lbl)
    }
    plot.append(col)
  }
  cols.append(plot)
  const tip = tooltip(cols)
  const show = (e) => {
    const col = e.target.closest(".col")
    if (col) tip.show(col.querySelector("i").offsetHeight ? col.querySelector("i") : col, `${col.dataset.n} accounts`, `${col.dataset.m} markets held`)
  }
  plot.addEventListener("pointerover", show)
  plot.addEventListener("focusin", show)
  plot.addEventListener("pointerleave", () => tip.hide())
  plot.addEventListener("focusout", () => tip.hide())
}

// ---- the proof track: pinned and carried sideways by the scroll on wide screens ----

function startProof() {
  const sec = $("[data-proof]")
  if (!sec) return
  const track = $("[data-track]", sec)
  const cards = [...track.children]
  const wide = matchMedia("(min-width: 1081px) and (min-height: 660px)")
  let travel = 0
  let queued = false
  const frame = () => {
    queued = false
    if (!sec.classList.contains("pinned")) return
    const top = sec.getBoundingClientRect().top
    const p = Math.min(1, Math.max(0, -top / Math.max(1, travel)))
    track.style.setProperty("--tx", `${-p * travel}px`)
    sec.style.setProperty("--pp", String(p))
    if (top < innerHeight * 0.5) for (const c of cards) if (c.getBoundingClientRect().left < innerWidth * 0.94) c.classList.add("is-in")
  }
  const layout = () => {
    const pin = wide.matches && !reduced()
    sec.classList.toggle("pinned", pin)
    if (!pin) {
      sec.style.height = ""
      track.style.removeProperty("--tx")
      return
    }
    travel = Math.max(0, track.scrollWidth - innerWidth)
    sec.style.height = `${innerHeight + travel}px`
    frame()
  }
  addEventListener("scroll", () => {
    if (queued) return
    queued = true
    requestAnimationFrame(frame)
  }, { passive: true })
  addEventListener("resize", layout)
  wide.addEventListener("change", layout)
  document.fonts?.ready.then(layout)
  layout()
}

// ---- the live run's status, from the evidence folder; never invented ----

async function startLiveStatus() {
  const card = $("[data-live-card]")
  const faq = $("[data-live-faq]")
  if (!card && !faq) return
  let p
  try {
    p = await getJson("/api/proof")
  } catch {
    return
  }
  const s = liveStatus(p.liveWrite?.run)
  if (!s.started) return // no run in the evidence: the page's own text stands
  const exit = p.liveWrite.run.execution?.exitCode
  if (card) {
    card.classList.toggle("pending", !s.verified)
    $("[data-live-result]", card).textContent = s.verified ? "Goal met" : exit !== null && exit !== undefined ? `Exit ${exit}` : "Started"
    const badge = $("[data-live-badge]", card)
    badge.className = `badge ${s.tone}`
    badge.innerHTML = s.verified ? `${ICON.ok}Verified` : esc(s.short)
  }
  if (faq) faq.textContent = `The live write, one guarded reduction on the project's own test account: ${s.headline}.`
}

// ---- features: the section index and the demos ----

function startSubnav() {
  const nav = $("[data-subnav]")
  if (!nav) return
  const scroller = nav.closest(".subnav-scroll")
  const ink = $(".subnav-ink", scroller)
  const links = new Map($$("a", nav).map((a) => [a.hash.slice(1), a]))
  const sections = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean)
  let current = null
  const mark = (id) => {
    if (id === current) return
    current = id
    for (const [k, a] of links) {
      if (k === id) a.setAttribute("aria-current", "location")
      else a.removeAttribute("aria-current")
    }
    const a = links.get(id)
    if (!a) return ink.style.setProperty("--o", "0")
    ink.style.setProperty("--x", `${a.offsetLeft}px`)
    ink.style.setProperty("--w", `${a.offsetWidth}px`)
    ink.style.setProperty("--o", "1")
    const left = a.offsetLeft - 16
    if (left < scroller.scrollLeft || a.offsetLeft + a.offsetWidth > scroller.scrollLeft + scroller.clientWidth) scroller.scrollTo({ left, behavior: reduced() ? "auto" : "smooth" })
  }
  let queued = false
  const frame = () => {
    queued = false
    let id = null
    for (const s of sections) if (s.getBoundingClientRect().top <= innerHeight * 0.4) id = s.id
    mark(id)
  }
  addEventListener("scroll", () => {
    if (queued) return
    queued = true
    requestAnimationFrame(frame)
  }, { passive: true })
  addEventListener("resize", () => {
    current = null
    frame()
  })
  frame()
}

const DEMOS = {
  async shock(fig, signal) {
    const sid = $("[data-scramble]", fig)
    const rows = $$("[data-mv]", fig)
    for (const r of rows) {
      const scn = $(".scn", r)
      if (scn) scn.textContent = r.dataset.ref
      $(".mv-track i", r)?.style.setProperty("--m", "0")
    }
    const scrambling = scramble(sid, { ms: 900, signal })
    await sleep(300, signal)
    for (const r of rows) {
      const scn = $(".scn", r)
      const track = $(".mv-track i", r)
      if (!scn || !track) continue
      track.style.setProperty("--m", r.dataset.m)
      await rollTo(scn, r.dataset.ref, r.dataset.to, { ms: 1100, signal })
    }
    await scrambling
  },

  async rebuild(fig, signal) {
    const rows = $$("tbody tr", fig)
    const badge = $("[data-badge]", fig)
    badge.style.visibility = "hidden"
    for (const td of $$("td.diff", fig)) td.style.visibility = "hidden"
    for (const tr of rows) {
      await Promise.all($$("[data-scramble]", tr).map((td) => scramble(td, { ms: 650, signal })))
      $("td.diff", tr).style.visibility = ""
      $("td.diff", tr).animate?.([{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 400, easing: "ease-out" })
    }
    badge.style.visibility = ""
    badge.classList.remove("pop")
    void badge.offsetWidth
    badge.classList.add("pop")
  },

  async price(fig, signal) {
    const rows = $$(".cut-row", fig)
    for (const r of rows) r.style.setProperty("--c", "0")
    const delta = $(".cut-delta", fig)
    delta.style.opacity = "0"
    await sleep(200, signal)
    for (const r of rows) {
      r.style.setProperty("--c", r.dataset.c)
      await countUp($(".r", r), { ms: 1000, signal })
    }
    delta.style.transition = "opacity 0.5s"
    delta.style.opacity = "1"
    await Promise.all($$(".figs dd[data-count]", fig).map((dd) => countUp(dd, { ms: 900, signal })))
  },

  async recompute(fig, signal) {
    const fills = $$("[data-fill]", fig)
    const bar = $(".fill-bar i", fig)
    const binds = $$(".bind span", fig)
    const agree = $$(".agree .bar", fig)
    const count = $("[data-ledger]", fig)
    const badge = $("[data-badge]", fig)
    for (const f of fills) f.style.opacity = "0"
    bar.style.setProperty("--f", "0")
    for (const b of binds) b.classList.remove("ok")
    for (const a of agree) a.style.setProperty("--a", "0")
    badge.style.visibility = "hidden"
    count.textContent = "0"
    await sleep(250, signal)
    for (const f of fills) {
      f.style.transition = "opacity 0.4s"
      f.style.opacity = "1"
      bar.style.setProperty("--f", f.dataset.f)
      await sleep(650, signal)
    }
    for (const b of binds) {
      b.classList.add("ok")
      await sleep(160, signal)
    }
    for (const a of agree) a.style.setProperty("--a", "1")
    count.textContent = "17"
    await countUp(count, { ms: 900, signal })
    badge.style.visibility = ""
    badge.classList.remove("pop")
    void badge.offsetWidth
    badge.classList.add("pop")
  },

  async stop(fig, signal) {
    const steps = $$(".ledger-run li:not(.phase)", fig)
    const badge = $("[data-badge]", fig)
    for (const li of steps) li.classList.remove("on", "cur")
    badge.style.visibility = "hidden"
    await sleep(250, signal)
    for (const li of steps) {
      li.classList.add("cur")
      await sleep(li.classList.contains("key") ? 700 : 380, signal)
      li.classList.replace("cur", "on")
    }
    badge.style.visibility = ""
    badge.classList.remove("pop")
    void badge.offsetWidth
    badge.classList.add("pop")
  },
}

// The guard demo loops: a guarded reduction that is allowed, then the fork test's harness
// that skips the preconditions and makes the venue flip the position, which the guard reverts.
async function guardLoop(fig, signal) {
  const flip = $("[data-flip]", fig)
  const bar = $("[data-flip-bar]", fig)
  const msg = $("[data-flip-msg]", fig)
  const say = (text, tone = "") => {
    msg.textContent = text
    msg.className = `flip-msg ${tone}`
  }
  const scaleTo = (s) => bar.style.setProperty("--s", String(s))
  for (;;) {
    flip.dataset.state = "idle"
    bar.classList.remove("short")
    scaleTo(1)
    say("Confirmed position: 1.633 ETH long")
    await sleep(1600, signal)
    say("Guarded sell of 0.8165 ETH")
    scaleTo(0.5)
    await sleep(1100, signal)
    say("Allowed: same side, smaller, reduced by at most 0.8165", "ok")
    await sleep(2200, signal)
    scaleTo(1)
    say("Fork test: a harness skips the guard's preconditions")
    await sleep(1800, signal)
    scaleTo(0)
    await sleep(650, signal)
    bar.classList.add("short")
    scaleTo(0.4)
    say("The venue fills past zero: the position flips short", "bad")
    await sleep(1500, signal)
    flip.dataset.state = "reverted"
    scaleTo(0)
    await sleep(500, signal)
    bar.classList.remove("short")
    scaleTo(1)
    say("Postcondition: the whole transaction reverts, venue fills included", "bad")
    await sleep(2800, signal)
  }
}

function startDemos() {
  for (const fig of $$("[data-demo]")) {
    const replay = $(".replay", fig)
    if (reduced()) {
      if (replay) replay.hidden = true
      continue
    }
    if (fig.dataset.demo === "guard") {
      whileVisible(fig, (signal) => guardLoop(fig, signal), { threshold: 0.35 })
      continue
    }
    const run = DEMOS[fig.dataset.demo]
    if (!run) continue
    let ctrl = null
    const start = () => {
      ctrl?.abort()
      const c = new AbortController()
      ctrl = c
      run(fig, c.signal).catch((err) => {
        if (err?.name !== "AbortError") console.error(err)
      })
    }
    onVisible(fig, start, { threshold: 0.4 })
    replay?.addEventListener("click", start)
  }
}

// The close: the fork run's account at the scenario prices on one meter. As it scrolls in, the
// fill and the dashed maintenance line travel from before the rescue (209.81 against 471.87) to
// after it (436.73 against 430.25); the figures under it are printed, never interpolated.
const FM = { span: 500, before: { eq: 209.81, mm: 471.87 }, after: { eq: 436.73, mm: 430.25 } }
function startFinalMeter() {
  const meter = $("[data-final-meter]")
  if (!meter || reduced()) return
  const track = $(".fm-track", meter)
  let queued = false
  const frame = () => {
    queued = false
    const r = track.getBoundingClientRect()
    const k = Math.min(1, Math.max(0, (innerHeight * 0.92 - r.top) / (innerHeight * 0.55)))
    const eq = FM.before.eq + (FM.after.eq - FM.before.eq) * k
    const mm = FM.before.mm + (FM.after.mm - FM.before.mm) * k
    meter.style.setProperty("--fe", (eq / FM.span).toFixed(4))
    meter.style.setProperty("--fl", (mm / FM.span).toFixed(4))
    meter.classList.toggle("below", eq < mm)
  }
  addEventListener("scroll", () => {
    if (queued) return
    queued = true
    requestAnimationFrame(frame)
  }, { passive: true })
  frame()
}

startTicker()
startConsole()
startFinalMeter()
startStory()
startDistribution()
startProof()
startLiveStatus()
startSubnav()
startDemos()
