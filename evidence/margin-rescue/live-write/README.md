# live-write: not run yet (`BLOCKED_SIGNER`)

No transaction has been signed or sent on the live Hideki network for Margin Rescue.

The live run is authorized. Its plan was regenerated read-only on 2026-10-27: `mr-live-plan/4`,
read at block 34,756,532, SHA-256 `7f0903286d5f59cbb98abb739aea9873ef68e6466231bdd355bcd4e1ea3d1175`. It deploys `ReduceOnlyGuard` for the
dedicated test EOA (`0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12`) and verifies its code against the
hashes in the plan, approves and deposits exactly 60 USDso, opens a BTC long of about 100 USDso
and an ETH short of about 90 USDso (IOC, at most 50 bps beyond the touch), analyses under
BTC −10% / ETH +5% with a 45 USDso target, grants the guard `placeOrderFor` on the selected pool
only, refreshes the account, sends one guarded reduction, binds its receipt and recomputes the
same scenario, then unwinds every leg through the guard, revokes, withdraws, clears the allowance
and verifies the end state. Gas is capped at 2 STT; 15 USDso is a soft stop, not a loss cap.
Earlier plans (`6c255a58…d233699`, `a21e43c5…dc18a7`) were never run and are superseded.
Before handing the run over it was checked again read-only after the fifth round's fixes
(`../live-read-only/plan-recheck.txt`): the account untouched at block 35,044,107 (nonce 0, no
position, order, stop or collateral, no guard deployed), the local guard build equal to the plan's
hashes, and the plan regenerated with the final code at block 35,044,503 identical except for
market data (BTC +0.33%, ETH +0.52%), the read block and the opening lots that follow from the
price, so this plan and its SHA-256 remain the ones to run.

The one blocker is signing: the test account's key is held only in the owner's terminal. The run
writes its journals to a private, git-ignored folder (`.margin-rescue/live/run-1`). They reach
this folder only through two steps:

1. `npm run mr:verify-run` reads every transaction, receipt and the end state again from the
   chain, without the executor's code, binds each guarded action to its confirmation, checks the
   scenario against the chain at its reference block, reconciles gas and collateral, and records
   which run files it verified (`verification.json`).
2. `npm run mr:publish-run` copies the run folder to `run-1/` after scanning every file for the
   key, signed transactions, a mnemonic, local paths and non-public URLs, with `PUBLICATION.json`
   (the SHA-256 of every published file, and of every original copied unchanged; a redacted
   file's original is hashed only in a private provenance record) and `SANITIZATION.md`.

The site's build accepts `run-1/` only if it passes that check again from scratch, and shows the
run as verified only if `verification.json` is valid for exactly these files and was made against
the plan authorized before the run (`../live-read-only/authorized/<sha256>.json`).

Milestone result: pending. Until `run-1/` exists and is independently verified, nothing on this
site or in this repository claims a live write.
