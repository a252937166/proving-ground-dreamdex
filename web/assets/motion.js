// Motion shared by every page. The HTML already holds the finished state; these helpers only
// animate toward it, honour prefers-reduced-motion, and stop every loop that cannot be seen.

window.__mr = true

const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)")
export const reduced = () => reducedQuery.matches

export const easeOut = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

const aborted = () => new DOMException("aborted", "AbortError")

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(aborted())), { once: true })
  })
}

// Calls onFrame(k) with k eased from 0 to 1 over `ms`; resolves on the last frame.
export function tween(ms, onFrame, { ease = easeOut, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    if (reduced() || ms <= 0) {
      onFrame(1)
      return resolve()
    }
    const start = performance.now()
    let raf = 0
    const stop = () => (cancelAnimationFrame(raf), reject(aborted()))
    signal?.addEventListener("abort", stop, { once: true })
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms)
      onFrame(ease(t))
      if (t < 1) raf = requestAnimationFrame(step)
      else {
        signal?.removeEventListener("abort", stop)
        resolve()
      }
    }
    raf = requestAnimationFrame(step)
  })
}

// Prints a number the way the site's statements do: grouped, fixed decimals, negatives in
// parentheses (or with a minus sign when paren is false).
export function fmt(value, decimals = 2, { paren = true } = {}) {
  const body = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  if (value < 0 && /[1-9]/.test(body)) return paren ? `(${body})` : `−${body}`
  return body
}

// Reads a printed figure back: "1,019.20", "(262.05)", "−8%", "7,700".
export function parse(text) {
  const t = String(text).trim()
  const digits = t.replace(/[^\d.]/g, "")
  if (!/\d/.test(digits)) return null
  const neg = /^\(/.test(t) || /^[−-]/.test(t)
  return { value: (neg ? -1 : 1) * Number(digits), decimals: digits.includes(".") ? digits.split(".")[1].length : 0, paren: /^\(/.test(t) }
}

// Counts an element's printed figure up from `from`, ending on its exact original text.
export function countUp(el, { from = 0, ms = 1000, signal } = {}) {
  const final = el.textContent
  const p = parse(final)
  if (!p) return Promise.resolve()
  return tween(ms, (k) => (el.textContent = k >= 1 ? final : fmt(from + (p.value - from) * k, p.decimals, { paren: p.paren })), { signal })
}

// Tweens an element between two printed figures.
export function rollTo(el, fromText, toText, { ms = 900, signal } = {}) {
  const a = parse(fromText)
  const b = parse(toText)
  if (!a || !b) {
    el.textContent = toText
    return Promise.resolve()
  }
  const decimals = Math.max(a.decimals, b.decimals)
  return tween(ms, (k) => (el.textContent = k >= 1 ? toText : fmt(a.value + (b.value - a.value) * k, decimals, { paren: a.paren || b.paren })), { signal })
}

// Hex and digits shuffle, then settle left to right on the element's own text.
const GLYPHS = "0123456789abcdef"
export function scramble(el, { ms = 700, signal } = {}) {
  const final = el.textContent
  return tween(
    ms,
    (k) => {
      if (k >= 1) return void (el.textContent = final)
      const settled = Math.floor(final.length * k)
      el.textContent = final.slice(0, settled) + [...final.slice(settled)].map((c) => (/[0-9a-f]/i.test(c) ? GLYPHS[(Math.random() * 16) | 0] : c)).join("")
    },
    { signal, ease: (t) => t },
  )
}

// Fires once when the element first enters the viewport.
export function onVisible(el, cb, { threshold = 0.3, rootMargin = "0px" } = {}) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.disconnect()
        cb(e.target)
      }
    },
    { threshold, rootMargin },
  )
  io.observe(el)
  return () => io.disconnect()
}

// Runs play(signal) while `el` is on screen, the tab is visible and nobody paused it; the
// signal aborts the moment any of those stops being true, and play starts over afterwards.
export function whileVisible(el, play, { threshold = 0.2 } = {}) {
  let ctrl = null
  let onScreen = false
  const update = () => {
    const want = onScreen && !document.hidden && !el.closest("[data-paused]")
    if (want && !ctrl) {
      const c = new AbortController()
      ctrl = c
      Promise.resolve()
        .then(() => play(c.signal))
        .catch((err) => {
          if (err?.name !== "AbortError") console.error(err)
        })
        .finally(() => {
          if (ctrl === c) ctrl = null
        })
    } else if (!want && ctrl) {
      ctrl.abort()
      ctrl = null
    }
  }
  const io = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting)
      update()
    },
    { threshold },
  )
  io.observe(el)
  document.addEventListener("visibilitychange", update)
  el.addEventListener("motion:toggle", update)
  return update
}

// Adds .is-in to [data-reveal] and .mline elements as they scroll into view.
export function reveal(root = document) {
  const els = [...root.querySelectorAll("[data-reveal]:not(.is-in), .mline:not(.is-in), .stack:not(.is-in)")]
  if (!("IntersectionObserver" in window)) return els.forEach((e) => e.classList.add("is-in"))
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add("is-in")
        io.unobserve(e.target)
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  )
  for (const e of els) io.observe(e)
}

// Wraps each word of a heading in two spans so the words can rise out of their line box;
// the text itself, and what assistive technology reads, is unchanged.
export function splitWords(el) {
  let i = 0
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment()
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) {
            frag.append(part)
            continue
          }
          const outer = document.createElement("span")
          outer.className = "w"
          const inner = document.createElement("span")
          inner.textContent = part
          inner.style.setProperty("--i", i++)
          outer.append(inner)
          frag.append(outer)
        }
        child.replaceWith(frag)
      } else if (child.nodeType === Node.ELEMENT_NODE && !child.classList.contains("dot")) walk(child)
    }
  }
  walk(el)
}

// A tooltip for chart marks. Values reach it as text, never as markup.
export function tooltip(container) {
  const tip = document.createElement("div")
  tip.className = "tip"
  tip.setAttribute("aria-hidden", "true")
  const value = document.createElement("b")
  const label = document.createElement("span")
  tip.append(value, label)
  container.append(tip)
  return {
    show(target, v, l) {
      value.textContent = v
      label.textContent = l
      const r = target.getBoundingClientRect()
      const c = container.getBoundingClientRect()
      tip.style.left = `${r.left - c.left + r.width / 2}px`
      tip.style.top = `${r.top - c.top}px`
      tip.classList.add("on")
    },
    hide() {
      tip.classList.remove("on")
    },
  }
}
