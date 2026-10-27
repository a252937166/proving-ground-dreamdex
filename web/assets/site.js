// Shared behaviour on every page: the header and its menu, copy buttons, pause controls for
// anything that moves on its own, reveals, and on the reading pages the sidebar that follows
// the section being read, the pipeline line and the step rails.
import { getJson, liveStatus, wireCopy } from "./data.js"
import { reduced, reveal, sleep, whileVisible } from "./motion.js"

wireCopy(document)
reveal(document)

// ---- header ----

const head = document.querySelector(".site-head")
if (head) {
  const onScroll = () => head.classList.toggle("scrolled", scrollY > 8)
  onScroll()
  addEventListener("scroll", onScroll, { passive: true })

  const btn = head.querySelector(".menu-btn")
  const nav = head.querySelector(".site-nav")
  nav.querySelectorAll("a").forEach((a, i) => a.style.setProperty("--i", i))
  const setOpen = (open) => {
    head.toggleAttribute("data-open", open)
    btn.setAttribute("aria-expanded", String(open))
  }
  btn.addEventListener("click", () => {
    const open = !head.hasAttribute("data-open")
    setOpen(open)
    if (open) nav.querySelector("a")?.focus()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !head.hasAttribute("data-open")) return
    setOpen(false)
    btn.focus()
  })
  document.addEventListener("click", (e) => {
    if (head.hasAttribute("data-open") && !head.contains(e.target)) setOpen(false)
  })
}

// ---- copy buttons on code blocks ----

document.addEventListener("click", async (e) => {
  const b = e.target.closest?.(".copy-btn")
  if (!b) return
  const pre = b.closest(".code")?.querySelector("pre")
  if (!pre) return
  const label = b.querySelector("span")
  try {
    await navigator.clipboard.writeText(pre.innerText.trim())
    b.dataset.copied = ""
    if (label) label.textContent = "Copied"
    setTimeout(() => {
      delete b.dataset.copied
      if (label) label.textContent = "Copy"
    }, 1400)
  } catch {
    // Clipboard unavailable (insecure context or denied): the text stays selectable.
  }
})

// ---- pause controls: [data-pause] toggles data-paused on the element it names ----

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-pause]")
  if (!b) return
  const target = document.getElementById(b.dataset.pause)
  if (!target) return
  const paused = target.toggleAttribute("data-paused")
  b.setAttribute("aria-pressed", String(paused))
  b.setAttribute("aria-label", b.getAttribute("aria-label").replace(paused ? /^Pause/ : /^Play/, paused ? "Play" : "Pause"))
  target.dispatchEvent(new CustomEvent("motion:toggle"))
})

// ---- reading pages ----

const side = document.querySelector(".doc-side")
if (side) {
  const details = side.querySelector("details")
  if (details && matchMedia("(max-width: 980px)").matches) details.open = false
  const list = side.querySelector("[data-spy]")
  const ink = list?.querySelector(".side-ink")
  const links = new Map([...(list?.querySelectorAll("a[href^='#']") ?? [])].map((a) => [a.hash.slice(1), a]))
  const sections = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean)
  const bar = document.querySelector(".read-progress")
  const steps = [...document.querySelectorAll(".steps > li")]
  let current = null

  const mark = (id) => {
    if (id === current) return
    current = id
    for (const [k, a] of links) {
      if (k === id) a.setAttribute("aria-current", "location")
      else a.removeAttribute("aria-current")
    }
    const a = links.get(id)
    if (!a || !ink) return
    ink.style.setProperty("--y", `${a.offsetTop}px`)
    ink.style.setProperty("--h", `${a.offsetHeight}px`)
    ink.style.setProperty("--o", "1")
  }

  let queued = false
  const frame = () => {
    queued = false
    const line = innerHeight * 0.28
    let id = sections[0]?.id
    for (const s of sections) if (s.getBoundingClientRect().top <= line) id = s.id
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) id = sections.at(-1)?.id ?? id
    mark(id)
    const max = document.documentElement.scrollHeight - innerHeight
    bar?.style.setProperty("--p", String(max > 0 ? Math.min(1, scrollY / max) : 0))
    const passLine = innerHeight * 0.6
    for (const li of steps) li.classList.toggle("passed", li.getBoundingClientRect().top < passLine)
  }
  const onScroll = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(frame)
  }
  frame()
  addEventListener("scroll", onScroll, { passive: true })
  addEventListener("resize", onScroll)

  // Section headings carry a link to themselves.
  for (const h of document.querySelectorAll(".doc-main section[id] > h2")) {
    const a = document.createElement("a")
    a.className = "anchor"
    a.href = `#${h.parentElement.id}`
    a.textContent = "#"
    a.setAttribute("aria-label", `Link to “${h.textContent}”`)
    h.prepend(a)
  }
}

// Text that depends on the live run reads the evidence folder (the server's run-state
// model): once the run has started it says what was recorded, and the "met" wording only
// for a run that was independently verified.
const liveTexts = [...document.querySelectorAll("[data-live-run]")]
if (liveTexts.length) {
  getJson("/api/proof")
    .then((p) => {
      const s = liveStatus(p.liveWrite?.run)
      if (!s.started) return
      for (const el of liveTexts) el.textContent = s.verified ? el.dataset.met : `Live run 1: ${s.headline}.`
    })
    .catch(() => {})
}

// Technology: a packet travels the pipeline, lighting each stage as it arrives.
const route = document.querySelector(".route")
if (route && !reduced()) {
  const items = [...route.querySelectorAll("li")]
  const runner = document.createElement("span")
  runner.className = "runner"
  runner.setAttribute("aria-hidden", "true")
  route.append(runner)
  // The runner sits on the stage's square: square centre is 22.5px into the item, runner centre 13.5px below its own origin.
  const place = (li) => runner.style.setProperty("--ry", `${li.offsetTop + 9}px`)
  whileVisible(route, async (signal) => {
    for (;;) {
      for (const li of items) li.classList.remove("lit", "done")
      place(items[0])
      for (const [i, li] of items.entries()) {
        place(li)
        await sleep(i === 0 ? 300 : 700, signal)
        li.classList.add("lit")
        await sleep(650, signal)
        li.classList.replace("lit", "done")
      }
      await sleep(1600, signal)
    }
  })
}
