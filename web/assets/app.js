// The app's three screens: an account read at one block under a fixed joint move, the
// evaluated reductions, and a recorded guarded execution. Everything comes from the site's
// read-only endpoints (the local server, or the visitor's browser on the static site);
// nothing here signs or sends.
import { copyable, esc, getJson, href, pct, qty, short, usd } from "./data.js"
import { countUp, reduced } from "./motion.js"

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const ICON = {
  ok: '<svg class="icon ok-ink" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 8 14.5 16 5.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  bad: '<svg class="icon bad-ink" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  wait: '<svg class="icon wait-ink" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 6v4.5l3 2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  arrow: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  copy: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 4.5h-7a2 2 0 0 0-2 2v7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
}
const ONE = 10n ** 18n

// Prices below 10 USDso keep four decimals, the rest two.
const price = (raw) => usd(raw, BigInt(raw) < 10n * ONE ? 4 : 2)
// Statement amounts: negatives in parentheses.
const money = (raw) => `<span class="num${BigInt(raw ?? 0) < 0n ? " neg" : ""}">${usd(raw, 2, { paren: true })}</span>`
// A raw 1e18 amount as a float, for drawing only; every printed figure stays BigInt.
const float = (raw) => Number(BigInt(raw ?? 0) / 10n ** 12n) / 1e6
const when = (ts) => new Date(Number(ts) * 1000).toISOString().replace(".000Z", " UTC").replace("T", " ")
const blockNo = (n) => Number(n).toLocaleString("en-US")
const candidateName = (c) =>
  c.kind === "NONE" ? "No action" : c.kind === "CANCEL_ORDERS" ? "Cancel resting orders" : c.id.replace(/^([A-Z]+)-(\d+)$/, (_, s, p) => `${s} −${p}%`)

// After new markup lands: numbers count up, meters and bars travel from their armed start.
function animateIn(root) {
  $$(".out > .panel", root.closest(".out") ?? root).forEach((p, i) => p.style.setProperty("--i", String(i)))
  const settle = () => {
    $$(".armed", root).forEach((el) => el.classList.remove("armed"))
    $$(".mm-row[data-tone]", root).forEach((el) => el.dataset.tone && el.classList.add(el.dataset.tone))
  }
  if (reduced()) return settle()
  for (const el of $$("[data-count]", root)) countUp(el, { ms: 900 }).catch(() => {})
  requestAnimationFrame(() => requestAnimationFrame(settle))
}

// The margin meter: each row draws health equity against the maintenance line on one scale;
// a row with `from` travels from that state to its own.
function meterHTML(rows) {
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

// A figure with a diverging bar beside it, zero in the middle; colour carries the goal,
// direction the sign. The bar is drawing only; the figure is the value.
function barred(raw, span, tone, i) {
  if (raw === undefined || raw === null) return "—"
  const v = float(raw)
  const w = Math.max(0.012, Math.min(1, Math.abs(v) / span)).toFixed(4)
  return `<span class="bv"><span class="dbar" aria-hidden="true"><i class="${v < 0 ? "neg " : ""}${tone}" style="--w:${w};--i:${i}"></i></span>${money(raw)}</span>`
}

// ---- tabs ----

const SCREENS = ["account", "compare", "result"]
const ink = $(".tab-ink")
function placeInk() {
  const tab = $(`.screens [aria-selected="true"]`)
  if (!tab || !ink) return
  ink.style.setProperty("--x", `${tab.offsetLeft}px`)
  ink.style.setProperty("--w", `${tab.offsetWidth}px`)
}
function show(name, { focus = false } = {}) {
  for (const s of SCREENS) {
    const on = s === name
    const tab = $(`#tab-${s}`)
    tab.setAttribute("aria-selected", String(on))
    tab.tabIndex = on ? 0 : -1
    const screen = $(`#screen-${s}`)
    const wasHidden = screen.hidden
    screen.hidden = !on
    if (on && wasHidden) {
      screen.classList.remove("entering")
      void screen.offsetWidth
      screen.classList.add("entering")
    }
  }
  placeInk()
  if (focus) $(`#tab-${name}`).focus()
  history.replaceState(null, "", `${location.pathname}${location.search}${name === "account" ? "" : `#${name}`}`)
  if (name === "result") loadRuns()
}
for (const s of SCREENS) $(`#tab-${s}`).addEventListener("click", () => show(s))
$(".screens").addEventListener("keydown", (e) => {
  const i = SCREENS.findIndex((s) => $(`#tab-${s}`).getAttribute("aria-selected") === "true")
  const next = e.key === "ArrowRight" ? (i + 1) % 3 : e.key === "ArrowLeft" ? (i + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : -1
  if (next < 0) return
  e.preventDefault()
  show(SCREENS[next], { focus: true })
})
document.addEventListener("click", (e) => {
  const go = e.target.closest?.("[data-go]")
  if (go) show(go.dataset.go, { focus: true })
})
addEventListener("resize", placeInk)
document.fonts?.ready.then(placeInk)

// ---- screen 1: read the account ----

const form = $("#analyze")
const PCT = /^-?\d{1,2}(\.\d{1,2})?$/
const USD = /^-?\d{1,9}(\.\d{1,6})?$/

function readForm() {
  const f = new FormData(form)
  return { account: String(f.get("account")).trim(), btc: String(f.get("btc")).trim(), eth: String(f.get("eth")).trim(), target: String(f.get("target")).trim() }
}

function problemsOf(q) {
  const p = {}
  if (!/^0x[0-9a-fA-F]{40}$/.test(q.account)) p.account = "Enter a 0x address: 0x followed by 40 hex characters."
  for (const k of ["btc", "eth"]) if (!PCT.test(q[k]) || Math.abs(Number(q[k])) >= 90) p[k] = "A move between −90% and 90%, up to two decimals."
  if (!USD.test(q.target)) p.target = "A USDso amount, up to six decimals."
  return p
}

function markFields(p) {
  for (const name of ["account", "btc", "eth", "target"]) {
    const field = form.elements[name].closest(".field")
    if (p[name]) field.setAttribute("data-invalid", "")
    else field.removeAttribute("data-invalid")
    form.elements[name].setAttribute("aria-invalid", String(!!p[name]))
  }
  $("#account-error").textContent = p.account ?? p.btc ?? p.eth ?? p.target ?? ""
}

// Presets fill both moves; the pressed state follows whatever the fields hold.
function syncPresets() {
  const now = `${form.elements.btc.value.trim()},${form.elements.eth.value.trim()}`
  for (const b of $$("[data-preset]", form)) b.setAttribute("aria-pressed", String(b.dataset.preset === now))
}
form.addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]")
  if (!b) return
  const [btc, eth] = b.dataset.preset.split(",")
  form.elements.btc.value = btc
  form.elements.eth.value = eth
  syncPresets()
})
form.addEventListener("input", syncPresets)

let inflight = null

async function analyze(q) {
  const p = problemsOf(q)
  markFields(p)
  if (Object.keys(p).length) {
    form.elements[Object.keys(p)[0]].focus()
    return
  }
  const params = new URLSearchParams(q)
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`)
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  const started = Date.now()
  const btn = $("#analyze-btn")
  btn.disabled = true
  btn.classList.add("busy")
  btn.textContent = "Reading…"
  $("#tab-compare").removeAttribute("data-ready")
  $("#account-out").innerHTML = loading(q)
  $("#compare-out").innerHTML = `<div class="panel empty"><h2>Reading the account…</h2><p>The candidates appear here when the analysis is done.</p><div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div></div>`
  const tick = setInterval(() => {
    const el = $("#elapsed")
    if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)} s`
  }, 1000)
  try {
    const r = await getJson(`/api/analyze?${params}`, { signal: ctrl.signal })
    $("#account-out").innerHTML = renderAccount(r)
    $("#compare-out").innerHTML = renderCompare(r)
    animateIn($("#account-out"))
    animateIn($("#compare-out"))
    $("#tab-compare").setAttribute("data-ready", "")
  } catch (err) {
    if (err.name === "AbortError") return
    $("#account-out").innerHTML = failure(err.message)
    $("#compare-out").innerHTML = `<div class="panel empty"><h2>No analysis</h2><p>The last read failed; see the first screen.</p></div>`
  } finally {
    clearInterval(tick)
    if (inflight === ctrl) {
      inflight = null
      btn.disabled = false
      btn.classList.remove("busy")
      btn.textContent = "Analyze"
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault()
  analyze(readForm())
})
form.addEventListener("click", (e) => {
  const ex = e.target.closest("[data-example]")
  if (!ex) return
  form.elements.account.value = ex.dataset.example
  form.elements.btc.value = ex.dataset.btc
  form.elements.eth.value = ex.dataset.eth
  form.elements.target.value = ex.dataset.target
  syncPresets()
  analyze(readForm())
})

function loading(q) {
  const steps = [
    "Pin the latest block and its hash",
    "Read the bank, all 21 pools, resting orders and the stop list at that block",
    "Rebuild health from raw state and compare it with the bank",
    `Apply BTC ${esc(q.btc)}% and ETH ${esc(q.eth)}% as fixed prices`,
    "Price each reduction against the order book",
  ]
  return `<div class="panel reading" aria-busy="true">
    <div class="panel-head"><h2>Reading ${esc(short(q.account, 8, 6))}</h2><span class="status"><span class="ping" aria-hidden="true"></span>Elapsed <span class="num" id="elapsed">0 s</span></span></div>
    <p>Usually 15 to 25 seconds. The read covers:</p>
    <div class="progress" aria-hidden="true"></div>
    <ol class="read-steps">${steps.map((s, i) => `<li style="--i:${i}">${s}</li>`).join("")}</ol>
  </div>`
}

function failure(message) {
  return `<div class="panel problem" role="alert">
    <h2>The account could not be read</h2>
    <p>${esc(message)}</p>
    <p>Nothing was changed anywhere. If the network was slow, try again; if the address is wrong, correct it.</p>
    <p class="next"><button type="button" class="btn secondary" id="retry">Try again</button></p>
  </div>`
}
document.addEventListener("click", (e) => {
  if (e.target.id === "retry") analyze(readForm())
})

function verdictBadge(a) {
  if (a.outcome === "BLOCKED") return `<span class="badge wait big pop">Blocked</span>`
  if (a.baseline.goal === "FAILS") return `<span class="badge call big pop"><span class="ping" aria-hidden="true"></span>Margin call</span>`
  if (a.baseline.goal === "MEETS") return `<span class="badge met big pop">${ICON.ok}Target met</span>`
  return `<span class="badge wait big pop">Uncertain</span>`
}

function renderAccount(r) {
  const a = r.analysis
  const rec = r.reconciliation
  const base = a.baseline.scenario
  const exact = rec.verdict === "EXACT"
  const tone = a.outcome === "BLOCKED" ? "wait" : a.baseline.goal === "FAILS" ? "call" : a.baseline.goal === "MEETS" ? "met" : "wait"
  const legs = r.legs.length
    ? r.legs
        .map(
          (l, i) => `<tr style="--i:${i}">
        <td class="sym">${esc(l.symbol)}</td>
        <td class="n">${BigInt(l.size) < 0n ? "short" : "long"} ${qty(BigInt(l.size) < 0n ? -BigInt(l.size) : l.size, l.baseDecimals)}</td>
        <td class="n opt">${price(l.entry)}</td>
        <td class="n opt2">${price(l.mark)}</td>
        <td class="n">${money(l.unrealizedPnl)}</td>
        <td class="n opt">${money(l.fundingOwed)}</td>
        <td class="n opt2">${usd(l.mm)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="none">This account holds no positions, so there is nothing a move can take from it.</td></tr>`
  const markets = r.scenario.markets.length
    ? [...r.scenario.markets]
        .sort((x, y) => (x.shockBps === null) - (y.shockBps === null) || x.symbol.localeCompare(y.symbol))
        .map((m, i) => `<tr style="--i:${i}"><td class="sym">${esc(m.symbol)}</td><td class="n">${price(m.referenceMark)}</td><td class="n">${price(m.scenarioPrice)}</td><td class="n${m.shockBps === null ? " muted" : " neg"}">${pct(m.shockBps)}</td></tr>`)
        .join("")
    : `<tr><td colspan="4" class="none">No held markets: the scenario has nothing to move.</td></tr>`
  const meter = meterHTML([
    { label: "Now", e: rec.independent.eRisk, mm: rec.independent.mm, buffer: rec.independent.buffer },
    { label: "At the scenario", e: base.eRisk, mm: base.mm, buffer: base.buffer, tone, from: { e: rec.independent.eRisk, mm: rec.independent.mm } },
  ])
  return `
  <div class="panel">
    <div class="panel-head">
      <h2>Statement at block ${blockNo(r.block.number)}</h2>
      <p class="status"><span class="source">Live, read-only</span> ${when(r.block.timestamp)} · read in ${(r.elapsedMs / 1000).toFixed(1)} s</p>
    </div>
    <dl class="facts">
      <div><dt>Account</dt><dd>${copyable(r.account, short(r.account, 8, 6))}</dd></div>
      <div><dt>Block hash</dt><dd>${copyable(r.block.hash, short(r.block.hash, 10, 6))} ${r.canonical?.ok ? `<span class="ok-ink">canonical</span>` : `<span class="bad-ink">not confirmed canonical</span>`}</dd></div>
      <div><dt>Reconciliation</dt><dd>${exact ? ICON.ok : ICON.bad}<b class="${exact ? "ok-ink" : "bad-ink"}">${esc(rec.verdict)}</b> ${exact ? "matches the bank to the raw unit" : esc(rec.reasons.join("; "))}</dd></div>
      <div><dt>Coverage</dt><dd>${r.coverage.activePools} active of ${r.coverage.factoryPools} pools · ${r.orders} resting orders · ${r.stops.listed} stops listed, ${r.stops.live} live</dd></div>
    </dl>
    <dl class="figures-row">
      <div><dt>Unlocked</dt><dd data-count>${usd(r.collateral.unlocked, 2, { paren: true })}</dd></div>
      <div><dt>Locked</dt><dd data-count>${usd(r.collateral.locked, 2, { paren: true })}</dd></div>
      <div><dt>Health equity</dt><dd data-count class="${BigInt(rec.independent.eRisk) < 0n ? "neg" : ""}">${usd(rec.independent.eRisk, 2, { paren: true })}</dd></div>
      <div><dt>Maintenance</dt><dd data-count>${usd(rec.independent.mm, 2, { paren: true })}</dd></div>
      <div><dt>Buffer now</dt><dd data-count class="${BigInt(rec.independent.buffer) < 0n ? "neg" : ""}">${usd(rec.independent.buffer, 2, { paren: true })}</dd></div>
    </dl>
    <div class="table-wrap">
      <table class="data">
        <caption>Positions at the current marks, USDso</caption>
        <thead><tr><th scope="col">Market</th><th scope="col" class="n">Size</th><th scope="col" class="n opt">Entry</th><th scope="col" class="n opt2">Mark</th><th scope="col" class="n">PnL</th><th scope="col" class="n opt">Funding owed</th><th scope="col" class="n opt2">Maintenance</th></tr></thead>
        <tbody class="stagger">${legs}</tbody>
      </table>
    </div>
  </div>

  <div class="panel scenario">
    <div class="panel-head">
      <h2>Under the move</h2>
      <p class="status"><span class="source">Live, read-only</span> scenario ${esc(r.scenario.id.slice(0, 12))}… · target buffer ${usd(r.scenario.targetBuffer)} USDso</p>
    </div>
    <div class="scenario-grid">
      <div class="table-wrap">
        <table class="data">
          <caption>Fixed prices; markets other than BTC and ETH stay at their reference</caption>
          <thead><tr><th scope="col">Market</th><th scope="col" class="n">Reference</th><th scope="col" class="n">Scenario</th><th scope="col" class="n">Move</th></tr></thead>
          <tbody class="stagger">${markets}</tbody>
        </table>
      </div>
      <div class="verdict">
        <div class="verdict-top"><h3>Health against maintenance</h3>${verdictBadge(a)}</div>
        ${meter}
        <dl class="figures-col">
          <div><dt>Health equity</dt><dd>${money(base.eRisk)}</dd></div>
          <div><dt>Maintenance</dt><dd>${money(base.mm)}</dd></div>
          <div class="big"><dt>Buffer at the scenario</dt><dd>${money(base.buffer)}</dd></div>
        </dl>
      </div>
    </div>
    ${a.blockers.length ? `<div class="blockers"><h3>Why there is no recommendation</h3><ul>${a.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
    <p class="model-note">${esc(a.excluded.note)}</p>
    <p class="next"><button type="button" class="btn" data-go="compare">Compare reductions ${ICON.arrow}</button></p>
  </div>`
}

// ---- screen 2: compare ----

const OUTCOME = {
  CANDIDATE_SELECTED: (a) => `<b>${esc(candidateName(a.candidates.find((c) => c.id === a.selected)))}</b> is the smallest evaluated reduction that meets the target. It is preferred among these candidates only, not a global optimum.`,
  NO_ACTION_NEEDED: () => "Doing nothing already meets the target under this move, so nothing is recommended. Try a larger move or a higher target to see the candidates compete.",
  NO_FEASIBLE_CANDIDATE: () => "No single evaluated reduction reaches the target. The table shows how close each one gets.",
  BLOCKED: () => "The account cannot be analysed safely, so nothing is recommended. The reasons are listed on the first screen.",
}
const OUTCOME_TITLE = {
  CANDIDATE_SELECTED: "A reduction meets the target",
  NO_ACTION_NEEDED: "No action needed",
  NO_FEASIBLE_CANDIDATE: "No evaluated reduction meets the target",
  BLOCKED: "Blocked",
}

function renderCompare(r) {
  const a = r.analysis
  const dec = Object.fromEntries(r.scenario.markets.map((m) => [m.symbol.toUpperCase(), m.baseDecimals]))
  const noteOf = (c) => c.duplicateOf || c.harmful || c.reasons.length || c.warnings.length || (c.reduce && BigInt(c.reduce.unfilled) > 0n)
  const withNotes = a.candidates.some(noteOf)
  const span = Math.max(1e-9, ...a.candidates.filter((c) => c.scenarioBuffer !== undefined).map((c) => Math.abs(float(c.scenarioBuffer)))) * 1.05
  const rows = a.candidates
    .map((c, i) => {
      const d = c.reduce ? dec[c.reduce.symbol.toUpperCase()] : 18
      const goal = c.status !== "EVALUATED" ? `<span class="muted">Unavailable</span>` : c.goal === "MEETS" ? `${ICON.ok}<span class="ok-ink">Meets</span>` : c.goal === "FAILS" ? `${ICON.bad}<span class="bad-ink">Fails</span>` : `${ICON.wait}<span class="wait-ink">Uncertain</span>`
      const tone = c.status !== "EVALUATED" ? "off" : c.goal === "MEETS" ? "good" : c.goal === "FAILS" ? "bad" : "off"
      const notes = [
        c.duplicateOf ? `same order as ${candidateName({ ...c, id: c.duplicateOf, kind: "REDUCE" })}` : "",
        c.harmful ? "worse than no action" : "",
        ...c.reasons,
        ...c.warnings,
        c.reduce && BigInt(c.reduce.unfilled) > 0n ? `only ${qty(c.reduce.expectedFill, d)} would fill inside the limit` : "",
      ].filter(Boolean)
      return `<tr class="${c.id === a.selected ? "chosen" : ""}" style="--i:${i}">
        <td><b>${esc(candidateName(c))}</b>${c.id === a.selected ? ' <span class="tag">Preferred</span>' : ""}</td>
        <td class="n opt">${c.reduce ? `${c.reduce.isBid ? "buy" : "sell"} ${qty(c.reduce.requestedQuantity, d)} · limit ${price(c.reduce.limitPrice)}` : "—"}</td>
        <td class="n opt2">${c.notionalReductionNow !== undefined ? usd(c.notionalReductionNow) : "—"}</td>
        <td class="n opt">${c.costNow !== undefined ? usd(c.costNow, 2, { paren: true }) : "—"}</td>
        <td class="n">${barred(c.scenarioBuffer, span, tone, i)}</td>
        <td class="goal-cell">${goal}</td>
        ${withNotes ? `<td class="notes opt">${notes.map(esc).join("; ")}</td>` : ""}
      </tr>`
    })
    .join("")
  const q = r.input
  const out = "/tmp/mr"
  return `
  <div class="panel">
    <div class="panel-head">
      <h2>${esc(OUTCOME_TITLE[a.outcome] ?? a.outcome)}</h2>
      <p class="status"><span class="source">Live, read-only</span> account ${esc(short(r.account, 8, 6))} · block ${blockNo(r.block.number)} · BTC ${esc(q.btcPct)}% · ETH ${esc(q.ethPct)}% · target ${esc(q.targetUsdso)}</p>
    </div>
    <p class="outcome">${OUTCOME[a.outcome]?.(a) ?? ""}</p>
    <div class="table-wrap">
      <table class="data candidates armed">
        <caption>Each reduction filled now against the book, the rest valued at the scenario prices, USDso. A cost in parentheses means the book paid more than the mark.</caption>
        <thead><tr><th scope="col">Candidate</th><th scope="col" class="n opt">Order</th><th scope="col" class="n opt2">Cut now</th><th scope="col" class="n opt">Cost now</th><th scope="col" class="n">Buffer at scenario</th><th scope="col">Goal</th>${withNotes ? '<th scope="col" class="opt">Notes</th>' : ""}</tr></thead>
        <tbody class="stagger">${rows}</tbody>
      </table>
    </div>
  </div>
  <div class="panel execute">
    <div class="panel-head"><h2>Executing a reduction</h2></div>
    <p class="outcome">The app never signs. On an account you own, the same analysis and a guarded order run from your own terminal, on the testnet, with your own wallet. The <a href="${href("guide#execute")}">guide</a> walks through deploying the guard and granting it first.</p>
    <div class="code">
      <div class="code-head"><span>Your terminal</span><button type="button" class="copy-btn">${ICON.copy}<span>Copy</span></button></div>
<pre><code>npm run mr -- analyze --account ${esc(r.account)} \\
  --shock BTC=${esc(q.btcPct)} --shock ETH=${esc(q.ethPct)} --target ${esc(q.targetUsdso)} --out ${out}
npm run mr -- plan --analysis ${out} --guard 0xYOUR_GUARD${a.selected ? ` --candidate ${esc(a.selected)}` : ""}
npm run mr -- refresh --analysis ${out} --action 0xACTION
npm run mr -- recompute --analysis ${out} --action 0xACTION --tx 0xHASH</code></pre>
    </div>
  </div>`
}

// ---- screen 3: recorded runs ----

let runs = null
let shownRun = null

async function loadRuns() {
  if (runs) return
  const box = $("#run-options")
  box.innerHTML = `<p class="muted">Loading the recorded runs…</p>`
  try {
    runs = (await getJson("/api/runs")).runs
  } catch (err) {
    box.innerHTML = `<p class="bad-ink">${esc(err.message)}</p>`
    return
  }
  const wanted = new URLSearchParams(location.search).get("run")
  const initial = runs.find((r) => r.id === wanted) ?? runs.find((r) => r.present && r.kind === "live") ?? runs.find((r) => r.id === "fork-e2e") ?? runs[0]
  box.innerHTML = runs
    .map(
      (r, i) => `<label class="run-option" style="--i:${i}">
        <input type="radio" name="run" value="${esc(r.id)}" ${r.id === initial.id ? "checked" : ""}>
        <span class="run-label">${esc(r.label)}</span>
        <span class="run-state ${r.present ? "ok-ink" : "wait-ink"}">${r.kind === "live" ? (r.present ? "Recorded" : "Not run yet") : "Recorded on a fork"}</span>
      </label>`,
    )
    .join("")
  box.classList.add("stack-in")
  box.addEventListener("change", (e) => showRun(e.target.value))
  showRun(initial.id)
}

async function showRun(id) {
  shownRun = id
  const params = new URLSearchParams(location.search)
  params.set("run", id)
  history.replaceState(null, "", `${location.pathname}?${params}#result`)
  const out = $("#run-out")
  out.innerHTML = `<div class="panel" aria-busy="true"><p class="muted">Reading the run's evidence…</p><div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div></div>`
  try {
    const run = await getJson(`/api/runs/${encodeURIComponent(id)}`)
    if (shownRun !== id) return
    out.innerHTML = run.present ? renderRun(run) : renderPending(run)
    animateIn(out)
  } catch (err) {
    out.innerHTML = `<div class="panel problem" role="alert"><h2>The run could not be read</h2><p>${esc(err.message)}</p></div>`
  }
}

function renderPending(run) {
  const p = run.plan
  const progress = run.progress?.state === "IN_PROGRESS" ? "A run has started and has not written its result yet." : p ? "The plan is approved and has not been run yet." : "It has not been run yet."
  return `<div class="panel">
    <div class="panel-head"><h2>${esc(run.label)}</h2><span class="badge wait big pop"><span class="ping" aria-hidden="true"></span>Pending</span></div>
    <p class="outcome">${progress} When it finishes, its transactions, fills, recomputation and cleanup appear here, read from <code>${esc(run.evidence)}</code>. Nothing on this page is a placeholder for them.</p>
    ${
      p
        ? `<dl class="facts">
      <div><dt>Plan SHA-256</dt><dd>${copyable(p.sha256, short(p.sha256, 12, 8))}</dd></div>
      <div><dt>Read at</dt><dd>block ${blockNo(p.readAt.block)} · chain ${p.chainId}</dd></div>
      <div><dt>Test account</dt><dd>${copyable(p.account, short(p.account, 8, 6))}</dd></div>
      <div><dt>Bounds</dt><dd>deposit ${usd(p.depositUsdso)} USDso · soft stop ${usd(p.softStopUsdso)} USDso · gas cap ${usd(p.gasCapStt)} STT · ${p.transactions} transactions at most</dd></div>
    </dl>`
        : ""
    }
    <p class="next"><button type="button" class="btn secondary" data-run="fork-plan">See the same plan rehearsed on a fork</button></p>
  </div>`
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-run]")
  if (!b) return
  const input = $(`#run-options input[value="${b.dataset.run}"]`)
  if (input) input.checked = true
  showRun(b.dataset.run)
})

function renderRun(run) {
  const x = run.execution
  const rc = run.recompute
  const sym = x.candidateId.split("-")[0].toUpperCase()
  const d = run.scenario.markets.find((m) => m.symbol.toUpperCase() === sym)?.baseDecimals ?? 18
  const met = rc.goal.state === "GOAL_MET"
  const badge = met ? `<span class="badge met big pop">${ICON.ok}Goal met</span>` : `<span class="badge call big pop">${esc(rc.goal.state.replaceAll("_", " ").toLowerCase())}</span>`
  const fills = x.fill.fills.map((f, i) => `<tr style="--i:${i}"><td class="n">${qty(f.quantity, d)}</td><td class="n">${price(f.price)}</td></tr>`).join("")
  const row = (name, v, cls = "", i = 0) => `<tr class="${cls}" style="--i:${i}"><td class="text">${name}</td><td class="n">${money(v.eRisk)}</td><td class="n opt2">${money(v.mm)}</td><td class="n">${money(v.buffer)}</td></tr>`
  const checks = x.ledgerChecks.map((c, i) => `<li class="tick-draw" style="--i:${i}">${c.ok ? ICON.ok : ICON.bad}<span>${esc(c.name)}</span></li>`).join("")
  const evidence = href(`evidence/${run.evidence.replace("evidence/margin-rescue/", "")}`)
  const meter = meterHTML([
    { label: "Before", e: rc.baseline.eRisk, mm: rc.baseline.mm, buffer: rc.baseline.buffer, tone: BigInt(rc.baseline.buffer) < BigInt(run.scenario.targetBuffer) ? "call" : "" },
    { label: "From the fills", e: rc.actual.eRisk, mm: rc.actual.mm, buffer: rc.actual.buffer, tone: met ? "met" : "call", from: { e: rc.baseline.eRisk, mm: rc.baseline.mm } },
  ])
  return `
  <div class="panel">
    <div class="panel-head"><h2>${esc(run.label)}</h2>${badge}</div>
    <dl class="facts run">
      <div><dt>Account</dt><dd>${copyable(run.account, short(run.account, 8, 6))}</dd></div>
      <div><dt>Where</dt><dd>${run.kind === "fork" ? `local fork of Somnia Hideki at block ${blockNo(run.forkBlock)}` : "Somnia Hideki, chain 50383"}</dd></div>
      <div><dt>Scenario</dt><dd>${run.scenario.markets.filter((m) => m.shockBps !== null).map((m) => `${esc(m.symbol)} ${pct(m.shockBps)} to ${price(m.scenarioPrice)}`).join(" · ")} · target ${usd(run.scenario.targetBuffer)} USDso</dd></div>
      <div><dt>Chosen</dt><dd><b>${esc(candidateName({ id: x.candidateId, kind: "REDUCE" }))}</b> · ${run.analysis.selected === x.candidateId ? "the smallest evaluated reduction that met the target" : "a re-confirmation under the same scenario"}</dd></div>
      <div><dt>Transaction</dt><dd>${copyable(x.tx.hash, short(x.tx.hash, 10, 6))} · block ${blockNo(x.tx.blockNumber)} · ${esc(x.tx.status)}${x.tx.canonical ? " · canonical" : ""}</dd></div>
      ${run.guard ? `<div><dt>Guard</dt><dd>${copyable(run.guard.address, short(run.guard.address, 8, 6))} · ${run.guard.verified ? "deployed code verified" : "not verified"}</dd></div>` : ""}
      ${run.exitCode !== null ? `<div><dt>Run</dt><dd>${esc(run.status)} · exit ${run.exitCode}${run.gas ? ` · gas ${usd(run.gas.spent, 4)} of ${usd(run.gas.cap, 0)} STT cap` : ""}</dd></div>` : ""}
    </dl>
    <div class="run-grid">
      <div>
        <div class="verdict">
          <div class="verdict-top"><h3>At the scenario prices, before and after</h3></div>
          ${meter}
        </div>
        <div class="table-wrap">
          <table class="data">
            <caption>At the scenario prices, USDso</caption>
            <thead><tr><th scope="col">Statement</th><th scope="col" class="n">Health equity</th><th scope="col" class="n opt2">Maintenance</th><th scope="col" class="n">Buffer</th></tr></thead>
            <tbody class="stagger">
              ${row("Before", rc.baseline, "", 0)}
              ${row("Forecast", rc.forecast, "", 1)}
              ${row("<b>Actual, from the fills</b>", rc.actual, "chosen", 2)}
              ${row("Now, at current marks", rc.currentHealth, "", 3)}
            </tbody>
          </table>
        </div>
        <p class="model-note">${recomputeNote(rc, run.scenario.targetBuffer, d, sym)}</p>
      </div>
      <div>
        <div class="table-wrap">
          <table class="data">
            <caption>Fills: ${qty(x.fill.filled, d)} of ${qty(x.fill.requested, d)} ${esc(sym)} · ${x.fill.priceBoundRespected ? "all inside the limit" : "outside the limit"}</caption>
            <thead><tr><th scope="col" class="n">Quantity</th><th scope="col" class="n">Price</th></tr></thead>
            <tbody class="stagger">${fills}</tbody>
          </table>
        </div>
        <p class="model-note">Outside changes: ${x.externalChanges.length ? esc(x.externalChanges.join("; ")) : "none detected"} · after the trade the account ${x.postReconciliation === "EXACT" ? "reconciles exactly" : `reconciles ${esc(String(x.postReconciliation).toLowerCase())}`}.</p>
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h2>Ledger checks</h2><p class="status"><span class="num" data-count>${x.ledgerChecks.filter((c) => c.ok).length}</span> of ${x.ledgerChecks.length} hold</p></div>
    <ul class="check-list">${checks}</ul>
  </div>
  ${run.steps.length ? renderSteps(run) : ""}
  ${run.cleanup ? `<div class="panel"><div class="panel-head"><h2>Cleanup</h2><p class="status">${run.cleanup.verified ? "Verified" : "NOT verified"}</p></div><ul class="check-list">${run.cleanup.checks.map((c, i) => `<li class="tick-draw" style="--i:${i}">${c.ok ? ICON.ok : ICON.bad}<span>${esc(c.name)} <span class="muted">${esc(c.detail)}</span></span></li>`).join("")}</ul></div>` : ""}
  <p class="work-foot">Raw evidence: <a href="${esc(evidence)}/recompute.txt">recompute.txt</a> · <a href="${esc(evidence)}/analysis.txt">analysis.txt</a></p>`
}

function recomputeNote(rc, target, d, sym) {
  const buffer = BigInt(rc.differences.bufferVsForecast)
  const fill = BigInt(rc.differences.fillVsForecast)
  const vsTarget = `Buffer at the scenario ${usd(rc.actual.buffer)} against a target of ${usd(target)} USDso`
  const vsForecast = buffer === 0n ? "it equals the forecast to the raw unit" : `it differs from the forecast by ${usd(buffer, 6)} USDso`
  const vsFill = fill === 0n ? "the venue filled exactly the previewed quantity" : `the fill differs from the preview by ${qty(fill < 0n ? -fill : fill, d)} ${sym}`
  return `${vsTarget}; ${vsForecast}, and ${vsFill}.`
}

function renderSteps(run) {
  const rows = run.steps
    .map((s, i) => `<tr style="--i:${i}"><td class="step-id">${esc(s.id)}</td><td class="opt2">${esc(s.phase)}</td><td>${esc(s.state.toLowerCase())}</td><td>${s.hash ? copyable(s.hash) : "—"}</td><td class="n opt2">${s.block ? blockNo(s.block) : "—"}</td></tr>`)
    .join("")
  return `<div class="panel">
    <div class="panel-head"><h2>Every transaction the run sent</h2><p class="status">${run.steps.length} transactions</p></div>
    <div class="table-wrap"><table class="data compact">
      <thead><tr><th scope="col">Step</th><th scope="col" class="opt2">Phase</th><th scope="col">State</th><th scope="col">Hash</th><th scope="col" class="n opt2">Block</th></tr></thead>
      <tbody class="stagger">${rows}</tbody>
    </table></div>
  </div>`
}

// ---- start from the URL: /app?account=…&btc=…&eth=…&target=…#compare ----

const start = new URLSearchParams(location.search)
for (const k of ["account", "btc", "eth", "target"]) if (start.get(k)) form.elements[k].value = start.get(k)
syncPresets()
const initial = SCREENS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "account"
show(initial)
if (start.get("account")) analyze(readForm())
