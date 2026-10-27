// The site's pages: the file behind each route, the shared header and footer inserted
// into it, and the evidence files it links to. Used by the local server and by the
// static build (tools/build-site.ts).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const WEB = fileURLToPath(new URL("../web/", import.meta.url))
export const EVIDENCE = fileURLToPath(new URL("../evidence/margin-rescue", import.meta.url))
// Evidence is served as plain text, so every figure on the site can be checked.
export const EVIDENCE_TYPES = new Set([".txt", ".json", ".jsonl", ".md", ""])

export const PAGES: Record<string, string> = {
  "/": "index.html",
  "/features": "features.html",
  "/technology": "technology.html",
  "/guide": "guide.html",
  "/dashboard": "dashboard.html",
  "/app": "app.html",
  "/proving-ground": "proving-ground.html",
}

// Pages share one header and footer, inserted here; the current page's link is marked.
export function renderPage(file: string, path: string): string {
  const part = (name: string) => readFileSync(join(WEB, "partials", `${name}.html`), "utf8")
  const head = part("site-head").replaceAll(`href="${path}"`, `href="${path}" aria-current="page"`)
  return readFileSync(join(WEB, file), "utf8").replace("<!--site-head-->", head).replace("<!--site-foot-->", part("site-foot"))
}
