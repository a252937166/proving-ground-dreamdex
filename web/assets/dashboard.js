// The dashboard: live BTC and ETH markets every 5 s, and the state of every proof read
// from the evidence folder. Depth bars travel from the last read to this one, the mark
// flashes the way it moved, and the funding countdown ticks between reads.
import { copyable, esc, getJson, qty, short, usd } from "./data.js"
import { countUp, reduced } from "./motion.js"

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const ICON = {
  ok: '<svg class="icon ok-ink" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 8 14.5 16 5.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  bad: '<svg class="icon bad-ink" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  tri: '<svg class="tick-dir" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5 9 8.5H1z" fill="currentColor"/></svg>',
}
const ONE = 10n ** 18n
const price = (raw) => (raw === null || raw === undefined ? "—" : usd(raw, BigInt(raw) < 10n * ONE ? 4 : 2))
const blockNo = (n) => Number(n).toLocaleString("en-US")
const bps = (v) => (v === null || v === undefined ? "—" : `${v} bps`)
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false })

// ---- markets ----

const REFRESH_MS = 5_000
let timer = null
let lastOk = 0
const lastMark = new Map()
const lastDepth = new Map()
const funding = new Map()

function fundingPct(rate) {
  // rate is a 1e18 fraction per funding window; show it in percent with four decimals
  const r = BigInt(rate)
  const neg = r < 0n
  const v = ((neg ? -r : r) * 1_000_000n) / ONE
  return `${neg ? "−" : ""}${(Number(v) / 10_000).toFixed(4)}%`
}

function untilFunding(next, nowSec) {
  const s = Math.max(0, Math.round(Number(next) - nowSec))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

// Cumulative size from the touch outward, as a share of the deepest side shown.
function depths(asks, bids) {
  const cum = (levels) => {
    let t = 0n
    return levels.map((l) => (t += BigInt(l.quantity)))
  }
  const a = cum(asks)
  const b = cum(bids)
  const max = [...a, ...b].reduce((m, v) => (v > m ? v : m), 1n)
  const share = (v) => Number((v * 10_000n) / max) / 10_000
  return { asks: a.map(share), bids: b.map(share) }
}

function renderMarket(m) {
  const d = m.derived
  const dec = m.market.baseDecimals
  const asks = m.book.asks.slice(0, 5)
  const bids = m.book.bids.slice(0, 5)
  const depth = depths(asks, bids)
  const prev = lastDepth.get(m.market.symbol) ?? {}
  const lvl = (l, side, i, share) => {
    const key = `${side}${i}`
    return `<tr class="${side}"><td class="side">${side}</td><td class="n">${price(l.price)}</td><td class="n depth" style="--d:${prev[key] ?? 0}" data-d="${share}" data-key="${key}"><span>${qty(l.quantity, dec)}</span></td></tr>`
  }
  const askRows = asks.map((l, i) => lvl(l, "ask", i, depth.asks[i])).reverse().join("")
  const bidRows = bids.map((l, i) => lvl(l, "bid", i, depth.bids[i])).join("")
  const base = m.market.symbol.split("-")[0]
  return `
    <div class="market-head"><h3>${esc(m.market.symbol)}</h3><span class="status"><span class="ping ok-ink" aria-hidden="true"></span>block ${blockNo(m.block.number)}</span></div>
    <div class="mark-row">
      <div>
        <p class="mark-label">Mark, same block as the book</p>
        <p class="mark-price" data-mark>${m.mark.ok ? price(m.mark.price) : '<span class="bad-ink">stale</span>'}${ICON.tri}</p>
      </div>
      <dl class="touch">
        <div class="bid"><dt>Best bid</dt><dd>${d.bestBid ? price(d.bestBid.price) : "empty"}</dd></div>
        <div class="ask"><dt>Best ask</dt><dd>${d.bestAsk ? price(d.bestAsk.price) : "empty"}</dd></div>
      </dl>
    </div>
    <table class="data stats">
      <tbody>
        <tr><td>Spread</td><td class="n">${d.spread === null ? "—" : `${price(d.spread)} · ${bps(d.spreadBps)}`}</td></tr>
        <tr><td>Mark versus mid</td><td class="n">${bps(d.markVsMidBps)}</td></tr>
        <tr><td>Index</td><td class="n">${price(m.state.indexPrice)}</td></tr>
        <tr><td>Funding rate per ${m.state.fundingWindowSec / 3600} h</td><td class="n">${fundingPct(m.state.fundingRate)}</td></tr>
        <tr><td>Next funding settlement</td><td class="n" data-funding-in>in ${untilFunding(m.state.nextFundingAt, m.block.timestamp)}</td></tr>
        <tr><td>Open interest</td><td class="n">${qty(m.state.openInterest, dec)} ${esc(base)}</td></tr>
      </tbody>
    </table>
    <div class="table-wrap ladder">
      <table class="data compact">
        <caption>Top of the book · bars show cumulative size</caption>
        <thead><tr><th scope="col">Side</th><th scope="col" class="n">Price</th><th scope="col" class="n">Size</th></tr></thead>
        <tbody>${askRows}<tr class="spread-row"><td colspan="3">spread ${d.spread === null ? "—" : `${price(d.spread)} · ${bps(d.spreadBps)}`}</td></tr>${bidRows}</tbody>
      </table>
    </div>`
}

async function refreshMarkets() {
  const status = $("#markets-status")
  try {
    const { markets } = await getJson("/api/markets")
    for (const m of markets) {
      const card = document.querySelector(`.market[data-symbol="${m.market.symbol}"]`)
      if (!card) continue
      card.innerHTML = renderMarket(m)
      card.removeAttribute("aria-busy")
      // Depth bars travel from the last read's share to this one's.
      const next = {}
      requestAnimationFrame(() => {
        void card.offsetWidth
        for (const cell of $$(".depth", card)) {
          cell.style.setProperty("--d", cell.dataset.d)
          next[cell.dataset.key] = cell.dataset.d
        }
        lastDepth.set(m.market.symbol, next)
      })
      // The mark flashes the way it moved since the previous read.
      const mark = $("[data-mark]", card)
      const now = m.mark.ok ? BigInt(m.mark.price) : null
      const prev = lastMark.get(m.market.symbol)
      if (now !== null && prev !== undefined && now !== prev && !reduced()) {
        const up = now > prev
        mark.classList.add(up ? "up" : "down", up ? "flash-up" : "flash-down")
        mark.title = "Arrow: direction of the mark since the previous read"
      }
      if (now !== null) lastMark.set(m.market.symbol, now)
      funding.set(m.market.symbol, { next: Number(m.state.nextFundingAt), offset: Number(m.block.timestamp) - Date.now() / 1000 })
    }
    lastOk = Date.now()
    status.dataset.state = "ok"
    status.textContent = `Updated ${clock(lastOk)}`
  } catch (err) {
    status.dataset.state = "error"
    status.textContent = lastOk ? `Read failed at ${clock(Date.now())}; showing ${clock(lastOk)}` : `Read failed: ${err.message}`
  }
}

// The funding countdown ticks every second between reads, from the chain's clock.
setInterval(() => {
  for (const [symbol, f] of funding) {
    const cell = document.querySelector(`.market[data-symbol="${symbol}"] [data-funding-in]`)
    if (cell) cell.textContent = `in ${untilFunding(f.next, Date.now() / 1000 + f.offset)}`
  }
}, 1000)

const line = $("#refresh-line")
function schedule() {
  clearTimeout(timer)
  line.classList.remove("run")
  if (!$("#markets-live").checked || document.hidden) return
  void line.offsetWidth
  line.style.setProperty("--refresh", `${REFRESH_MS / 1000}s`)
  line.classList.add("run")
  timer = setTimeout(async () => {
    await refreshMarkets()
    schedule()
  }, REFRESH_MS)
}
$("#markets-live").addEventListener("change", schedule)
document.addEventListener("visibilitychange", () => (document.hidden ? (clearTimeout(timer), line.classList.remove("run")) : refreshMarkets().then(schedule)))

// ---- proof ----

const SCENARIO_NAMES = {
  happy: "Happy path: the live plan end to end",
  tamper: "Tampered receipts",
  "book-change": "The book changes after the analysis",
  "partial-fill": "Partial fill",
  "owner-change": "The owner trades after the analysis",
  timeout: "The reduction is not mined in time",
  "rpc-outage": "RPC outage after the reduction is mined",
  "preflight-refusal": "A preflight that must refuse",
  "cleanup-retries": "Cleanup needs every retry",
  "cleanup-fail": "Cleanup cannot close a leg",
  "funding-drift": "A funding settlement between analysis and send",
}

function renderLive(p) {
  const plan = p.liveWrite.plan
  const run = p.liveWrite.run
  if (run?.state === "FINISHED") {
    const met = run.status === "COMPLETE" && run.rescue?.goal === "GOAL_MET"
    return `<div>
        <h3>Live run 1 finished: ${esc(run.status)} (exit ${run.exitCode})</h3>
        <p class="panel-note">${met ? "The guarded reduction was bound, recomputed from its fills and met the goal, and cleanup was verified." : esc(run.reason ?? "See the run's evidence for what happened.")}</p>
        ${run.rescue?.tx ? `<p class="panel-note">Reduction ${copyable(run.rescue.tx)} · ${esc(run.rescue.txState)} · ${esc(run.rescue.fill)}</p>` : ""}
        <p class="next"><a class="btn secondary small" href="/app?run=live-1#result">Read the whole run</a></p>
      </div>
      <span class="badge ${met ? "met" : "call"} big pop">${met ? `${ICON.ok}Goal met` : esc(run.status.replaceAll("_", " ").toLowerCase())}</span>`
  }
  const started = run?.state === "IN_PROGRESS"
  return `<div>
      <h3>${started ? "Live run 1 has started and has not written its result yet" : "One guarded reduction on the live network, approved and not yet run"}</h3>
      ${
        plan
          ? `<dl class="facts">
        <div><dt>Plan SHA-256</dt><dd>${copyable(plan.sha256, short(plan.sha256, 12, 8))}</dd></div>
        <div><dt>Read at</dt><dd>block ${blockNo(plan.readAt.block)} · chain ${plan.chainId}</dd></div>
        <div><dt>Test account</dt><dd>${copyable(plan.account, short(plan.account, 8, 6))}</dd></div>
        <div><dt>Bounds</dt><dd>deposit ${usd(plan.depositUsdso)} USDso · soft stop ${usd(plan.softStopUsdso)} USDso · gas cap ${usd(plan.gasCapStt)} STT (worst case ${usd(plan.worstCaseStt)})</dd></div>
      </dl>`
          : `<p class="panel-note">No approved plan file is present.</p>`
      }
      <p class="model-note">Its evidence will appear in <code>evidence/margin-rescue/live-write/run-1</code>. Until then, nothing on this site claims a live write.</p>
    </div>
    <span class="badge wait big pop"><span class="ping" aria-hidden="true"></span>Pending</span>`
}

function renderTally(p) {
  let i = 0
  const pass = (c) => c && c.failed === 0 && c.passed === c.total
  const row = (name, where, c, what) =>
    `<tr style="--i:${i++}"><td class="text">${name}<span class="expected-inline">${where}</span><span class="expected-inline">${what}</span></td><td class="text opt2">${where}</td><td class="n">${c ? `<span class="count" data-count>${c.passed}</span> / ${c.total}` : "—"}</td><td class="result-pass">${pass(c) ? `<span class="badge met">${ICON.ok}pass</span>` : `<span class="badge call">${ICON.bad}check</span>`}</td></tr>`
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th scope="col">Suite</th><th scope="col" class="opt2">Where</th><th scope="col" class="n">Passed</th><th scope="col">Result</th></tr></thead>
    <tbody class="stagger">
      ${row("TypeScript unit tests", "Fixture", p.fixture.unit, "Scenario arithmetic, locks, funding, rounding, candidates, binding, the run ledger")}
      ${row("Guard with mocks", "Fixture", p.fixture.solidityMock, "ReduceOnlyGuard preconditions and errors")}
      ${row("Guard against the real venue", "Fork", p.fork.forgeFork, "IOC limits, invariants, rollback after venue fills, per-fill ledger")}
      <tr style="--i:${i++}"><td class="text">Typecheck<span class="expected-inline">Fixture</span></td><td class="text opt2">Fixture</td><td class="n">—</td><td class="result-pass">${p.fixture.typecheckClean ? `<span class="badge met">${ICON.ok}clean</span>` : `<span class="badge call">${ICON.bad}errors</span>`}</td></tr>
    </tbody>
  </table></div>`
}

async function loadProof() {
  const status = $("#proof-status")
  try {
    const p = await getJson("/api/proof")
    $("#live-run").innerHTML = renderLive(p)
    $("#live-run").removeAttribute("aria-busy")
    $("#tests").innerHTML = renderTally(p)
    $("#tests").removeAttribute("aria-busy")
    $("#rehearsals tbody").innerHTML = p.fork.rehearsals
      .flatMap((r) => r.outcomes.map((o) => ({ ...o, forkBlock: r.forkBlock })))
      .map((o, i) => `<tr style="--i:${i}"><td class="text">${esc(SCENARIO_NAMES[o.scenario] ?? o.scenario)}<span class="expected-inline">${esc(o.expected)}</span></td><td class="n opt2">${blockNo(o.forkBlock)}</td><td class="expected opt2">${esc(o.expected)}</td><td class="result-pass">${o.pass ? `<span class="badge met">${ICON.ok}as expected</span>` : `<span class="badge call">${ICON.bad}failed</span>`}</td></tr>`)
      .join("")
    const e = p.fork.e2e
    $("#e2e").innerHTML = `<p><b>Full loop on a real 6-market account</b> (${copyable(e.account, short(e.account, 8, 6))}, fork block ${blockNo(e.forkBlock)}): ${esc(e.selected)} filled ${qty(e.filled, 18)} ETH; buffer at the scenario from ${usd(e.baselineBuffer, 2, { paren: true })} to ${usd(e.actualBuffer, 2, { paren: true })} USDso, recomputed from the fills; ${esc(e.goal.replaceAll("_", " ").toLowerCase())}. Transaction ${copyable(e.tx)}. <a href="/app?run=fork-e2e#result">Read the run</a></p>`
    $("#recons tbody").innerHTML = p.liveReadOnly.reconciliations
      .map((r, i) => `<tr style="--i:${i}"><td>${copyable(r.account, short(r.account, 8, 6))}</td><td class="n">${r.markets}</td><td class="n opt2">${r.orders}</td><td class="n opt2">${blockNo(r.block)}</td><td class="result-pass">${r.verdict === "EXACT" ? `<span class="badge met">${ICON.ok}EXACT</span>` : `<span class="badge call">${ICON.bad}${esc(r.verdict)}</span>`}</td></tr>`)
      .join("")
    const s = p.liveReadOnly.roundingStudy
    $("#study").textContent = `Rounding study at block ${blockNo(s.block)}: every holder of all ${s.pools} pools rebuilt with the bank's floor, ${s.floorExact.toLocaleString("en-US")} of ${s.compared.toLocaleString("en-US")} exact; with the SDK's truncation, ${s.truncExact.toLocaleString("en-US")} exact.`
    $("#build-info").textContent = `Evidence read ${new Date(p.generatedAt).toISOString().replace(".000Z", "Z")} · commit ${p.git.commit ? p.git.commit.slice(0, 7) : "unknown"} on ${p.git.branch ?? "a detached head"}`
    status.dataset.state = "ok"
    status.textContent = "Read from the evidence folder"
    if (!reduced()) for (const el of $$("[data-count]")) countUp(el, { ms: 1100 }).catch(() => {})
  } catch (err) {
    status.dataset.state = "error"
    status.textContent = `Evidence could not be read: ${err.message}`
  }
}

refreshMarkets().then(schedule)
loadProof()
