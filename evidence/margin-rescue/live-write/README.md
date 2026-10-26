# live-write: not run

No transaction has been signed or sent on the live Hideki network for Margin Rescue.

The live step needs the owner's explicit approval of one plan file, and that approval has
not been given. The proposal is [`../live-read-only/live-plan.json`](../live-read-only/live-plan.json)
(`mr-live-plan/2`): deploy `ReduceOnlyGuard` for the dedicated test EOA and verify its code
against the hashes in the plan, approve and deposit exactly 60 USDso, open a BTC long and an
ETH short, analyse under BTC −10% / ETH +5% with a 45 USDso target, grant the guard
`placeOrderFor` on the selected pool only, refresh the account, send one guarded reduction,
bind its receipt and recompute the same scenario, then unwind every leg through the guard,
revoke, withdraw, clear the allowance and verify the end state.

The executor that would run it (`src/margin-rescue/executor.ts`, `liveRun.ts`) has been
rehearsed only on local forks, normally and with injected faults
([`../fork/rehearsal-33472615/`](../fork/), [`../fork/rehearsal-33609475/`](../fork/)).

Milestone result: `BLOCKED_LIVE` (live transactions pending authorization; not a technical
failure). A live run will write its evidence to `live-write/run-*/`: the run ledger, the
action journal, every snapshot, the bound receipt, the recomputation, the cleanup report
and `result.json`.
