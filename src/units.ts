// Exact fixed-point helpers. Venue values are integers: prices and USDso use 18
// decimals, BTC quantities use the market's base decimals (8).
export const PRICE_DECIMALS = 18
export const USD_DECIMALS = 18

// Parses a decimal string exactly; rejects more fractional digits than `decimals`
// instead of rounding, so a typed quantity is never silently changed.
export function parseDecimal(input: string, decimals: number, { signed = false } = {}): bigint {
  const s = input.trim()
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new Error(`not a decimal number: "${input}"`)
  const [, minus, whole, frac = ""] = m
  if (minus && !signed) throw new Error(`negative value not allowed: "${input}"`)
  if (frac.length > decimals) throw new Error(`"${input}" has more than ${decimals} decimal places`)
  const v = BigInt(whole + frac.padEnd(decimals, "0"))
  return minus ? -v : v
}

export function formatDecimal(value: bigint, decimals: number, maxFraction = decimals): string {
  const neg = value < 0n
  const abs = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "")
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${neg ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}`
}

// Notional in USDso units (18 decimals) for a base quantity at a price.
export function notional(quantity: bigint, price: bigint, baseDecimals: number): bigint {
  return (quantity * price) / 10n ** BigInt(baseDecimals)
}

// Signed basis points of a relative to b, rounded toward zero, as a number for display.
export function bpsDiff(a: bigint, b: bigint): number {
  return Number(((a - b) * 1_000_000n) / b) / 100
}

export const absBig = (x: bigint) => (x < 0n ? -x : x)
