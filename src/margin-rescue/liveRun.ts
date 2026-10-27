// `npm run mr:live`: one live run of an approved plan. The command, its refusals, its
// private output folder and its exit codes are in liveCli.ts; the run itself is
// executor.ts. It has been exercised only on local forks (forkRehearsal.ts); on the live
// network it must not be run without the owner's explicit approval of that exact plan.
import { EXIT } from "./executor.js"
import { runCli } from "./liveCli.js"
import { localText } from "./paths.js"

runCli(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (err) => {
    // runCli handles every error itself; reaching this is a bug, so nothing is assumed.
    console.error(`error: ${localText(err instanceof Error ? err.message.split("\n")[0] : String(err))}`)
    process.exit(EXIT.STATE_UNKNOWN)
  },
)
