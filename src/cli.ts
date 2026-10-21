// Read-only CLI. No private key, no signing, no transactions.
//
//   npm run snapshot -- [--json] [--save PREFIX]
//   npm run precheck -- --side buy --qty 0.01 [--price 83500] [--position 0] [--equity 1000] [--json] [--save PREFIX]
//
// --save PREFIX writes PREFIX.txt and PREFIX.json from the same network read.
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { createMarkets, loadConfig } from "./config.js"
import { runPrecheck } from "./order.js"
import { renderPrecheck, renderSnapshot } from "./report.js"
import { readSnapshot, toJson } from "./snapshot.js"

const USAGE = `usage:
  snapshot [--json] [--save PREFIX]
  precheck --side buy|sell --qty BTC [--price USDso] [--position BTC] [--equity USDso] [--json] [--save PREFIX]`

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      save: { type: "string" },
      side: { type: "string" },
      qty: { type: "string" },
      price: { type: "string" },
      position: { type: "string" },
      equity: { type: "string" },
    },
  })
  if (command !== "snapshot" && command !== "precheck") {
    console.error(USAGE)
    return 2
  }

  const cfg = loadConfig()
  const snapshot = await readSnapshot(createMarkets(cfg), cfg)

  let text: string
  let json: string
  if (command === "snapshot") {
    text = renderSnapshot(snapshot)
    json = toJson(snapshot)
  } else {
    const run = runPrecheck(snapshot, values)
    text = renderPrecheck(snapshot, run.input, run.result, run.priceSource)
    json = toJson({
      note: "Local calculation against live market data. No Proving Ground contract is deployed; nothing here is enforced on-chain.",
      snapshot: { queriedAt: snapshot.queriedAt, chainId: snapshot.chainId, block: snapshot.block, poolAddress: snapshot.market.poolAddress, mark: snapshot.mark, bestBid: snapshot.derived.bestBid, bestAsk: snapshot.derived.bestAsk },
      ...run,
    })
  }

  console.log(values.json ? json : text)
  if (values.save) {
    writeFileSync(`${values.save}.txt`, text + "\n")
    writeFileSync(`${values.save}.json`, json + "\n")
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
