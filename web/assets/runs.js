// The app's third screen, a recorded run, as markup from the run feeds (site.ts readRun):
// a fork run or a published live bundle, its recomputation, every transaction it sent,
// its cleanup and, for a live run, its state (runState.ts). Strings only; app.js puts them
// on the page.
import { copyable, esc, href, liveStatus, pct, qty, short, usd } from "./data.js"
import { blockNo, candidateName, ICON, meterHTML, money, price } from "./markup.js"

export function renderPending(run) {
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

// A run with its recomputation. One that could not bind the receipt to its confirmation
// (EVIDENCE_MISMATCH) holds no actual figures: the recomputation is shown as unavailable,
// with its reason, and the transaction, its fills, the ledger checks, every step sent and
// the cleanup stay on the page.
export function renderRun(run) {
  const x = run.execution
  const rc = run.recompute
  const actual = rc.actual ?? null
  const sym = x.candidateId.split("-")[0].toUpperCase()
  const d = run.scenario.markets.find((m) => m.symbol.toUpperCase() === sym)?.baseDecimals ?? 18
  const met = rc.goal.state === "GOAL_MET"
  // A fork run is labelled by its own recomputation; the live run by its verified state only.
  const ls = run.kind === "live" ? liveStatus(run.live) : null
  const badge = ls ? `<span class="badge ${ls.tone} big pop">${ls.verified ? `${ICON.ok}Verified` : esc(ls.short)}</span>` : met ? `<span class="badge met big pop">${ICON.ok}Goal met</span>` : `<span class="badge call big pop">${esc(rc.goal.state.replaceAll("_", " ").toLowerCase())}</span>`
  const fills = x.fill.fills.map((f, i) => `<tr style="--i:${i}"><td class="n">${qty(f.quantity, d)}</td><td class="n">${price(f.price)}</td></tr>`).join("")
  const row = (name, v, cls = "", i = 0) => `<tr class="${cls}" style="--i:${i}"><td class="text">${name}</td><td class="n">${money(v.eRisk)}</td><td class="n opt2">${money(v.mm)}</td><td class="n">${money(v.buffer)}</td></tr>`
  // A statement the recomputation could not value: no figures, the reason below the table.
  const none = (name, cls = "", i = 0) => `<tr class="${cls}" style="--i:${i}"><td class="text">${name}</td><td class="n muted">—</td><td class="n opt2 muted">—</td><td class="n muted">unavailable</td></tr>`
  const checks = x.ledgerChecks.map((c, i) => `<li class="tick-draw" style="--i:${i}">${c.ok ? ICON.ok : ICON.bad}<span>${esc(c.name)}</span></li>`).join("")
  const evidence = href(`evidence/${run.evidence.replace("evidence/margin-rescue/", "")}`)
  const meter = actual
    ? meterHTML([
        { label: "Before", e: rc.baseline.eRisk, mm: rc.baseline.mm, buffer: rc.baseline.buffer, tone: BigInt(rc.baseline.buffer) < BigInt(run.scenario.targetBuffer) ? "call" : "" },
        { label: "From the fills", e: actual.eRisk, mm: actual.mm, buffer: actual.buffer, tone: met ? "met" : "call", from: { e: rc.baseline.eRisk, mm: rc.baseline.mm } },
      ])
    : `<p class="verdict-note">The recomputation is unavailable, so no buffer after the reduction is shown.</p>`
  const tx = x.tx.hash ? `${copyable(x.tx.hash, short(x.tx.hash, 10, 6))}${x.tx.blockNumber !== null ? ` · block ${blockNo(x.tx.blockNumber)}` : ""} · ${esc(x.tx.status)}${x.tx.canonical ? " · canonical" : ""}` : esc(x.tx.status)
  return `
  <div class="panel">
    <div class="panel-head"><h2>${esc(run.label)}</h2>${badge}</div>
    <dl class="facts run">
      <div><dt>Account</dt><dd>${copyable(run.account, short(run.account, 8, 6))}</dd></div>
      <div><dt>Where</dt><dd>${run.kind === "fork" ? `local fork of Somnia Hideki at block ${blockNo(run.forkBlock)}` : "the live Somnia Hideki testnet, chain 50383"}</dd></div>
      <div><dt>Scenario</dt><dd>${run.scenario.markets.filter((m) => m.shockBps !== null).map((m) => `${esc(m.symbol)} ${pct(m.shockBps)} to ${price(m.scenarioPrice)}`).join(" · ")} · target ${usd(run.scenario.targetBuffer)} USDso</dd></div>
      <div><dt>Chosen</dt><dd><b>${esc(candidateName({ id: x.candidateId, kind: "REDUCE" }))}</b> · ${run.analysis.selected === x.candidateId ? "the smallest evaluated reduction that met the target" : "a re-confirmation under the same scenario"}</dd></div>
      <div><dt>Transaction</dt><dd>${tx}</dd></div>
      ${run.guard ? `<div><dt>Guard</dt><dd>${copyable(run.guard.address, short(run.guard.address, 8, 6))} · ${run.guard.verified ? "deployed code verified" : "not verified"}</dd></div>` : ""}
      ${run.exitCode !== null ? `<div><dt>Run</dt><dd>${esc(run.status)} · exit ${run.exitCode}${run.gas ? ` · gas ${usd(run.gas.spent, 4)} of ${usd(run.gas.cap, 0)} STT cap` : ""}</dd></div>` : ""}
    </dl>
    <div class="run-grid">
      <div>
        <div class="verdict">
          <div class="verdict-top"><h3>At the scenario prices, before and after</h3>${actual ? "" : `<span class="badge wait">Unavailable</span>`}</div>
          ${meter}
        </div>
        <div class="table-wrap">
          <table class="data">
            <caption>At the scenario prices, USDso</caption>
            <thead><tr><th scope="col">Statement</th><th scope="col" class="n">Health equity</th><th scope="col" class="n opt2">Maintenance</th><th scope="col" class="n">Buffer</th></tr></thead>
            <tbody class="stagger">
              ${row("Before", rc.baseline, "", 0)}
              ${rc.forecast ? row("Forecast", rc.forecast, "", 1) : none("Forecast", "", 1)}
              ${actual ? row("<b>Actual, from the fills</b>", actual, "chosen", 2) : none("<b>Actual, from the fills</b>", "chosen", 2)}
              ${actual ? row("Now, at current marks", rc.currentHealth, "", 3) : ""}
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
  ${renderCleanup(run.cleanup)}
  ${run.kind === "live" ? renderLiveState(run.live, run.label) : ""}
  <p class="work-foot">Raw evidence: ${(run.files ?? ["recompute.txt", "analysis.txt"]).map((f) => `<a href="${esc(evidence)}/${esc(f)}">${esc(f)}</a>`).join(" · ")}</p>`
}

// The executor's cleanup report, verified only on the complete condition (site.ts
// cleanupFeed: every check holds and nothing remains); what it left is listed first.
function renderCleanup(c) {
  if (!c) return ""
  const remaining = c.remaining ?? []
  const items = [...remaining.map((r) => `${ICON.bad}<span>Remaining: ${esc(r)}</span>`), ...(c.checks ?? []).map((k) => `${k.ok ? ICON.ok : ICON.bad}<span>${esc(k.name)} <span class="muted">${esc(k.detail)}</span></span>`)]
  const status = c.verified ? "Verified by the executor" : `NOT verified by the executor${remaining.length ? ` · ${remaining.length} item${remaining.length === 1 ? "" : "s"} remaining` : ""}`
  return `<div class="panel"><div class="panel-head"><h2>Cleanup</h2><p class="status">${status}</p></div><ul class="check-list">${items.map((item, i) => `<li class="tick-draw" style="--i:${i}">${item}</li>`).join("")}</ul></div>`
}

// The live run's four statuses, kept apart, and the independent read-back when it is valid
// for this run; otherwise why it is not.
function renderLiveState(view, label = "Live run") {
  const s = liveStatus(view)
  const x = view.execution
  const rows = [
    ["Execution", x.status ? `${esc(x.status)} · exit ${x.exitCode} · ${x.sentTransactions} transaction(s) sent${x.unresolved ? ` · ${x.unresolved} unresolved` : ""}` : `${x.sentTransactions} transaction(s) sent · no result recorded`],
    ["Rescue goal", view.rescue.verifiedGoal ? `${esc(view.rescue.verifiedGoal)}, read back from the chain` : view.rescue.executorGoal ? `${esc(view.rescue.executorGoal)} by the executor's own account only` : "not evaluated"],
    ["Cleanup", view.cleanup.independentlyVerified !== null ? (view.cleanup.independentlyVerified ? (view.cleanup.executorVerified === false ? "verified on read-back from the chain; NOT verified in the executor's own report" : "verified, read back from the chain") : "NOT verified on read-back") : view.cleanup.executorVerified !== null ? (view.cleanup.executorVerified ? "verified by the executor only" : "not verified") : "not reached"],
    ["Independent verification", `${esc(view.verification.state.toLowerCase())}${view.verification.problems.length ? `: ${esc(view.verification.problems.join("; "))}` : ""}`],
  ]
  return `<div class="panel">
    <div class="panel-head"><h2>Status</h2><span class="badge ${s.tone}">${s.verified ? `${ICON.ok}Verified` : esc(s.short)}</span></div>
    <p class="outcome">${esc(label.split(" · ")[0])}: ${esc(s.headline)}.</p>
    <dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
  </div>
  ${view.readBack ? renderVerification(view.readBack) : ""}`
}

// A live run that started but has no recomputation: what it sent and how it ended.
export function renderPartialRun(run) {
  const evidence = href(`evidence/${run.evidence.replace("evidence/margin-rescue/", "")}`)
  return `
  ${renderLiveState(run.live, run.label)}
  ${run.state === "INVALID_BUNDLE" || run.live?.state === "INVALID_BUNDLE" ? "" : `<div class="panel">
    <div class="panel-head"><h2>${esc(run.label)}</h2></div>
    <dl class="facts run">
      ${run.account ? `<div><dt>Account</dt><dd>${copyable(run.account, short(run.account, 8, 6))}</dd></div>` : ""}
      <div><dt>Where</dt><dd>the live Somnia Hideki testnet, chain 50383</dd></div>
      ${run.reason ? `<div><dt>Reason</dt><dd>${esc(run.reason)}</dd></div>` : ""}
      ${run.guard ? `<div><dt>Guard</dt><dd>${copyable(run.guard.address, short(run.guard.address, 8, 6))} · ${run.guard.verified ? "deployed code verified" : "not verified"}</dd></div>` : ""}
      ${run.gas ? `<div><dt>Gas</dt><dd>${usd(run.gas.spent, 4)} STT spent${BigInt(run.gas.committed ?? 0) > 0n ? ` · ${usd(run.gas.committed, 4)} STT reserved for unresolved transactions` : ""}</dd></div>` : ""}
    </dl>
    <p class="model-note">No recomputation was recorded for this run, so no buffer, fill or goal is shown.</p>
  </div>
  ${run.steps?.length ? renderSteps(run) : ""}
  ${renderCleanup(run.cleanup)}
  ${run.files?.length ? `<p class="work-foot">Raw evidence: ${run.files.map((f) => `<a href="${esc(evidence)}/${esc(f)}">${esc(f)}</a>`).join(" · ")}</p>` : ""}`}`
}

// tools/verify-live-run.ts: every receipt and the end state read again from the chain,
// without the executor's code; its figures, not the executor's, are shown here.
function renderVerification(v) {
  const s = v.reconciliation.stt
  const u = v.reconciliation.usdso
  const groups = [
    ["transactions", "Transactions"],
    ["confirmations", "Each guarded action against its confirmation"],
    ["guard", "Guard"],
    ["scenario", "The scenario, read again at its reference block"],
    ["rescue", "Fixed-scenario recomputation"],
    ["cleanup", `End state at block ${blockNo(v.endBlock.number)}`],
    ["reconciliation", "Gas and collateral"],
  ]
  const held = v.checks.filter((c) => c.ok).length
  const list = groups
    .map(([g, title]) => {
      const cs = v.checks.filter((c) => c.group === g)
      if (!cs.length) return ""
      return `<h3 class="check-group">${esc(title)}</h3><ul class="check-list">${cs.map((c, i) => `<li class="tick-draw" style="--i:${i}">${c.ok ? ICON.ok : ICON.bad}<span>${esc(c.name)}${c.ok ? "" : ` <span class="muted">${esc(c.detail)}</span>`}</span></li>`).join("")}</ul>`
    })
    .join("")
  return `<div class="panel">
    <div class="panel-head"><h2>Read back from the chain</h2><p class="status"><span class="num" data-count>${held}</span> of ${v.checks.length} hold</p></div>
    <p class="outcome">A separate script read every transaction, its receipt and the account again from the public Hideki RPC, at one block for the end state, and recomputed the scenario from the chain at the scenario's fixed prices.</p>
    <dl class="facts">
      <div><dt>Gas</dt><dd>${usd(s.spent, 6)} STT spent = ${usd(s.receiptFees, 6)} STT in receipt fees · cap ${usd(s.cap, 0)} STT</dd></div>
      <div><dt>Collateral</dt><dd>deposited ${usd(u.deposited, 4)}, withdrawn ${usd(u.withdrawn, 4)} USDso: ${money(u.result)} = realized ${money(u.realizedPnl)} − funding ${money(u.funding)} − fees ${money(u.fees)}</dd></div>
      ${v.rescue ? `<div><dt>At the fixed prices</dt><dd>buffer ${money(v.rescue.before)} before, ${money(v.rescue.after)} after the reduction · ${esc(v.rescue.goal.replaceAll("_", " ").toLowerCase())}</dd></div>` : ""}
    </dl>
    ${list}
  </div>`
}

function recomputeNote(rc, target, d, sym) {
  const goal = esc(rc.goal.state.replaceAll("_", " ").toLowerCase())
  if (!rc.actual) return `Recomputation unavailable (${goal}): ${esc(rc.goal.reason)}. Nothing is valued from it; the transaction, its fills and the cleanup are shown as recorded.`
  const buffer = rc.differences.bufferVsForecast
  const fill = BigInt(rc.differences.fillVsForecast)
  const vsTarget = `Buffer at the scenario ${usd(rc.actual.buffer)} against a target of ${usd(target)} USDso`
  const vsForecast = buffer === null || buffer === undefined ? "there is no forecast to compare it with" : BigInt(buffer) === 0n ? "it equals the forecast to the raw unit" : `it differs from the forecast by ${usd(buffer, 6)} USDso`
  const vsFill = fill === 0n ? "the venue filled exactly the previewed quantity" : `the fill differs from the preview by ${qty(fill < 0n ? -fill : fill, d)} ${esc(sym)}`
  const why = rc.goal.state === "GOAL_MET" || rc.goal.state === "GOAL_NOT_MET" ? "" : ` The goal is ${goal}: ${esc(rc.goal.reason)}.`
  return `${vsTarget}; ${vsForecast}, and ${vsFill}.${why}`
}

function renderSteps(run) {
  const fees = run.kind === "live" && run.steps.some((s) => s.fee !== null && s.fee !== undefined)
  const rows = run.steps
    .map((s, i) => `<tr style="--i:${i}"><td class="step-id">${esc(s.id)}</td><td class="opt2">${esc(s.phase)}</td><td>${esc(s.state.toLowerCase())}</td><td>${s.hash ? copyable(s.hash) : "—"}</td><td class="n opt2">${s.block ? blockNo(s.block) : "—"}</td>${fees ? `<td class="n opt2">${s.fee ? usd(s.fee, 6) : "—"}</td>` : ""}</tr>`)
    .join("")
  return `<div class="panel">
    <div class="panel-head"><h2>Every transaction the run sent</h2><p class="status">${run.steps.length} transactions</p></div>
    <div class="table-wrap"><table class="data compact">
      <thead><tr><th scope="col">Step</th><th scope="col" class="opt2">Phase</th><th scope="col">State</th><th scope="col">Hash</th><th scope="col" class="n opt2">Block</th>${fees ? `<th scope="col" class="n opt2">Fee, STT</th>` : ""}</tr></thead>
      <tbody class="stagger">${rows}</tbody>
    </table></div>
    <p class="model-note">${run.kind === "live" ? "These are transactions on the live Somnia Hideki testnet (chain 50383); click a hash to copy it and look it up with <code>eth_getTransactionReceipt</code> on the public RPC." : "These hashes exist only on the local fork the run used; they are not on the live network."}</p>
  </div>`
}
