// The endpoints whose address may appear in published evidence. The list is fixed here,
// never taken from configuration: HIDEKI_RPC_URL or DREAMDEX_INDEXER_URL may point at a
// private node with a token in it. A URL is public only when it is exactly one of these
// (scheme, host, port and path), with no user info, no query and no fragment; anything
// else, including a listed host with an extra path or another spelling, is withheld.
export const PUBLIC_ENDPOINTS = [
  "https://api.hideki2.infra.testnet.somnia.network", // Hideki JSON-RPC (markets-sdk 0.32.1 default)
  "wss://api.hideki2.infra.testnet.somnia.network/ws", // Hideki WebSocket
  "https://hideki-dev.smk.somnia.host/v1/graphql", // dreamDEX indexer (config.ts DEFAULT_INDEXER_URL)
] as const

// The text itself is compared, never a parsed URL: parsing resolves `..`, `%2e%2e` and
// backslashes, so `https://host/<token>/..` would otherwise pass as `https://host`.
export function isPublicEndpoint(text: string): boolean {
  const bare = text.endsWith("/") ? text.slice(0, -1) : text
  return (PUBLIC_ENDPOINTS as readonly string[]).includes(bare)
}

// What a log or report may say about an endpoint: the URL itself only when it is public.
export function describeEndpoint(text: string): string {
  return isPublicEndpoint(text) ? text : "a private endpoint (address withheld)"
}
