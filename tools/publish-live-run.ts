// Publish one live run's evidence: a scanned copy of the private run folder in
// evidence/margin-rescue/live-write/run-<name>/, with PUBLICATION.json and SANITIZATION.md
// (src/margin-rescue/publication.ts says what is refused, replaced and checked).
//
//   npm run mr:publish-run -- --from .margin-rescue/live/run-1 --to evidence/margin-rescue/live-write/run-1 [--plan live-plan.json] [--replace]
//
// Exit 0 published; 2 refused, nothing written (key, signed transaction or mnemonic
// found, or the finished bundle failed its own check); 1 bad arguments or paths.
import { parseArgs } from "node:util"
import { publishRun } from "../src/margin-rescue/publication.js"

try {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, plan: { type: "string", default: "live-plan.json" }, replace: { type: "boolean", default: false } } })
  if (!values.from || !values.to) throw new Error("--from and --to are required")
  const r = publishRun({ from: values.from, to: values.to, plan: values.plan!, replace: values.replace })
  if (!r.ok) {
    console.error("NOT PUBLISHED; nothing was written:")
    for (const p of r.problems) console.error(`  ${p}`)
    process.exit(2)
  }
  console.log(`published ${r.published.length} files to ${values.to}`)
  for (const x of r.replaced) console.log(`  ${x.file}: ${x.change}`)
  console.log(`left out: ${r.leftOut.join(", ") || "nothing"}`)
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`)
  process.exit(1)
}
