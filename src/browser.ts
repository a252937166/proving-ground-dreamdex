// The static site's live endpoints, run in the visitor's browser: GitHub Pages has no
// server, so web/assets/static-api.js loads this bundle (built by tools/build-site.ts)
// and the same public RPC and indexer reads the local server makes happen here instead.
// Read-only: no key, no signing, no transactions.
import { loadConfig } from "./config.js"
import { createLiveApi, type Answer } from "./live-api.js"

const live = createLiveApi(loadConfig({}))

export function answer(pathname: string, search: string): Promise<Answer | null> {
  return live(pathname, new URLSearchParams(search))
}
