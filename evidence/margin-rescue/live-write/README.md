# live-write: not run

No transaction has been signed or sent on the live Hideki network for Margin Rescue.

The live step (deposit to the dedicated test EOA's MarginBank account, open a BTC long and
an ETH short, deploy `ReduceOnlyGuard`, grant it `placeOrderFor` on one pool, send one
guarded reduction, recompute, clean up) needs the owner's explicit approval of one plan
file; that approval has not been given. The proposal is
[`../live-read-only/live-plan.json`](../live-read-only/live-plan.json), and the executor that
would run it has been rehearsed only on a fork ([`../fork/live-rehearsal-33472615/`](../fork/)).

Milestone result: `BLOCKED_LIVE` (missing authority, not a technical failure).
