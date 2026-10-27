# live-write: not run yet

No transaction has been signed or sent on the live Hideki network for Margin Rescue.

The owner approved a plan file on 2026-10-26 (SHA-256 `6c255a58…d233699`, read at block
33,747,421) that was not run, and authorized the live run on 2026-10-27. Its plan was
regenerated read-only for that: `mr-live-plan/3`, read at block 34,671,145, SHA-256
`a21e43c579d47b04ce5cdaec14a2c38c973a54e81c0e3213e22fd3fe90dc18a7`. It deploys
`ReduceOnlyGuard` for the dedicated test EOA (`0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12`)
and verifies its code against the hashes in the plan, approves and deposits exactly 60 USDso,
opens a BTC long of about 100 USDso and an ETH short of about 90 USDso (IOC, at most 50 bps
beyond the touch), analyses under BTC −10% / ETH +5% with a 45 USDso target, grants the guard
`placeOrderFor` on the selected pool only, refreshes the account, sends one guarded reduction,
binds its receipt and recomputes the same scenario, then unwinds every leg through the guard,
revokes, withdraws, clears the allowance and verifies the end state. Gas is capped at 2 STT;
15 USDso is a soft stop, not a loss cap.

The run is signed only in the owner's terminal, which holds the test account's key, and it
writes to a private folder. Its evidence is published here, as `run-1/`, after two steps:
`tools/verify-live-run.ts` reads every receipt and the end state again from the chain, and
`tools/publish-live-run.ts` copies the files after scanning them for the key, signed
transactions and local paths (`run-1/SANITIZATION.md` lists every file).

Milestone result: pending. Until `run-1/` exists, nothing on this site or in this repository
claims a live write.
