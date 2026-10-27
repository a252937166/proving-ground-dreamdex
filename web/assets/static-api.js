// Static site only (GitHub Pages, no server); the local server never loads this file.
// It answers the pages' /api/* requests in the browser: the live endpoints run the
// bundled public reads in chain.js, and the evidence endpoints read JSON files written
// when the site was built. A classic script, so it is in place before any page script runs.
;(() => {
  const base = document.documentElement.dataset.base || "/"
  const realFetch = window.fetch.bind(window)
  let chain = null

  const json = (status, body) => new Response(body, { status, headers: { "content-type": "application/json" } })
  const error = (status, message) => json(status, JSON.stringify({ error: message }))

  async function answer(url) {
    const path = url.pathname
    if (path === "/api/proof" || path === "/api/runs" || path.startsWith("/api/runs/")) {
      const res = await realFetch(`${base}${path.slice(1)}.json`)
      return res.ok ? res : error(404, path.startsWith("/api/runs/") ? "no such run" : "not found")
    }
    chain ??= import(`${base}assets/chain.js`)
    const a = await (await chain).answer(path, url.search)
    return a ? json(a.status, a.body) : error(404, "not found")
  }

  // An aborted request rejects as it would with a real fetch, even if its read goes on.
  function abortable(promise, signal) {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
      promise.then(resolve, reject)
    })
  }

  window.fetch = (input, init) => {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url
    const url = new URL(raw, location.href)
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init)
    const reply = answer(url).catch((err) => error(502, `network read failed: ${err?.message ?? err}`))
    return abortable(reply, init?.signal ?? (input instanceof Request ? input.signal : undefined))
  }

  // Links to a live endpoint (the Proving Ground page's raw data) open its answer as JSON.
  document.addEventListener("click", async (e) => {
    const a = e.target.closest?.('a[href^="/api/"]')
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    const res = await window.fetch(a.getAttribute("href"))
    location.href = URL.createObjectURL(new Blob([await res.text()], { type: "application/json" }))
  })
})()
