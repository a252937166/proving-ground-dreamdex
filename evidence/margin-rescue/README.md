# Margin Rescue evidence

Every file here is labelled by where it came from. Integers in JSON are decimal strings
of raw units (USDso and prices have 18 decimals; base sizes use each market's decimals).
`SHA256SUMS` lists a content hash for every file in this directory.

| Label | Meaning |
|---|---|
| `fixture` | Synthetic data or mocks; no network. Validates arithmetic and logic only |
| `fork` | A local fork (Foundry `forge` or `anvil`) of Hideki at a pinned block, running the REAL deployed venue contracts; accounts may be fresh test accounts or real accounts impersonated on the fork. Transaction hashes here exist only on that local fork |
| `live-read-only` | Calls (`eth_call`, `eth_getLogs`, `eth_estimateGas`) against the live Hideki RPC; nothing signed or sent |
| `live-write` | Transactions signed and sent on the live network. **There are none** |

## Layout

| Path | Label | What it shows |
|---|---|---|
| `versions.json` | — | Node, npm, TypeScript, tsx, viem, SDK, Foundry, solc, forge-std commit, guard source hashes and bytecode size |
| `fixture/typecheck.txt` | fixture | `tsc --noEmit` |
| `fixture/npm-test.txt` | fixture | All TypeScript unit tests (Proving Ground and Margin Rescue): fixtures A and B, receipt binding and its 19 tamperings, recomputation with partial fills, funding drift and external changes, the pre-send refresh, the transaction ledger and journal on a stub chain (lookup timeouts on a mined transaction, unlocatable or self-located nonce consumers, located replacements, node rejections, foreign nonces), the cleanup bound and gas reserve, stop paging |
| `fixture/forge-unit-mock.txt` | fixture | Solidity unit tests with mocks: reentrancy, constructor validation, venue failure report, postcondition matrix and fuzz, action-id vector |
| `fork/forge-fork-tests.txt` | fork | Every Solidity fork suite at block 33472615: guard execution and preconditions, postcondition rollback, account ledger, raw venue semantics |
| `fork/trace-postcondition-rollback.txt` | fork | `-vvvv` call trace: the venue's fills and margin updates inside `placeOrderFor`, then `PositionFlippedOrIncreased`, then the revert of everything |
| `fork/trace-per-fill-bound.txt` | fork | `-vvvv` traces of the per-fill limit tests on both sides |
| `fork/e2e-33472615/` | fork | End-to-end on anvil: analysis of a real 6-market account, guard deployment, grant, refresh, journalled send, bound receipt, recomputation, a replayed confirmation and an expired quote |
| `fork/rehearsal-33472615/` | fork | The live executor with a throwaway key: `happy` (liveRun.ts as the live command), `tamper` (its own evidence altered), and injected faults: `book-change`, `partial-fill`, `owner-change`, `timeout` (then `--resume`), `rpc-outage` (the reduction is mined while receipt and transaction lookups time out; then `--resume`), `preflight-refusal` (existing collateral and allowance: refused, nothing signed), `cleanup-retries` (both legs need all three guarded attempts; 12 cleanup transactions against 12 reserved) and `cleanup-fail` (every guarded BTC close is rejected in simulation, `WOULD_REVERT`, `tx: null`, so nothing is broadcast). Each scenario directory holds the run ledger, the action journal, every snapshot, the recomputation, the cleanup report, `result.json` and `outcome.json` (expected vs observed checks) |
| `fork/rehearsal-33609475/funding-drift/` | fork | The same executor forked one second before a real hourly BTC funding settlement, with the clock moved across it between the analysis and the refresh |
| `fork/live-rehearsal-33472615/` | fork | **Superseded** history: the previous executor's rehearsal, whose cleanup used plain IOCs |
| `live-read-only/reconcile-<account>/` | live-read-only | Hash-pinned snapshots and field-by-field reconciliation of real accounts with 3, 6, 9 and 21 markets |
| `live-read-only/analysis-0x2E3631D9/` | live-read-only | Scenario (BTC −8%, ETH −12%, others at reference) and the candidate comparison for a real 6-market account |
| `live-read-only/stop-pagination.json` | live-read-only | Three accounts with more than 200 indexed stop records: the old single 200-row request against the paged listing, each stop checked on chain at the pinned block |
| `live-read-only/funding-settlement.txt` | live-read-only | The projected funding index around a real hourly settlement (flat, then one step at `lastUpdate + 3600 s`) |
| `live-read-only/rounding-study.json` | live-read-only | Every holder of every pool at one block, rebuilt with floor and with truncation |
| `live-read-only/live-plan.json` | live-read-only | The proposed live plan (v2) for the dedicated test EOA: balances, markets, the guard build it is bound to, gas estimates, every call, bound and exit code. **A proposal, not executed** |
| `regression/` | live-read-only | The earlier Proving Ground commands still work (`test:live`, `snapshot`, `precheck`) |
| `live-write/README.md` | — | Why there is no live-write evidence |

## How this round's fork evidence was produced

- `fork/rehearsal-33472615/`, `fork/rehearsal-33609475/` and `fork/e2e-33472615/` were run in parallel against one caching RPC shim (`SHIM_CACHE=1 node tools/rpc-shim.mjs 8556`, which only remembers state reads at an explicit past block). Each rehearsal scenario directory has `outcome.json` (every expected-versus-observed check), `result.json` and `results.jsonl` (the executor's result; `timeout/` holds both the stopped run and the resumed one), `run-ledger.json` (every transaction, persisted before broadcast), `journal/` (every confirmation, including invalidated and cleanup ones), the snapshots, `recompute.json`/`.txt`, `cleanup.json` and `run-log.jsonl`. Transaction hashes exist only on those local forks.
- `fork/forge-fork-tests.txt` (38/38) is from the second round and was not rerun in the third: the contracts are unchanged, and the third round changed only TypeScript (transaction resolution, refusal, cleanup reserve). It was produced on its own through the plain shim; a first attempt that ran it concurrently with the anvil forks failed in `setUp` on upstream `fetch failed` errors (no test logic ran), that output was discarded, and the shim now retries transport failures.
- Third round: `fixture/`, `fork/e2e-33472615/`, `fork/rehearsal-33472615/` (10 scenarios, including the new `rpc-outage`, `preflight-refusal` and `cleanup-retries`), `fork/rehearsal-33609475/` and `live-read-only/live-plan.json` (`mr-live-plan/3`) were regenerated from the final code.
- The throwaway keys of the rehearsals were generated in memory and never written; the "third party" that takes liquidity in the fault scenarios is a second fork-only account funded from the MarginBank's own USDso by impersonation.

## Reading the traces

Foundry names only events whose ABI it compiled; the venue's own events appear in the
traces as raw `topic 0` values. The ones that matter:

| topic 0 | Event | Emitted by |
|---|---|---|
| `0xd90f62f6…639d` | `OrderPlaced(uint128,(…))` | PerpPool |
| `0xc87f4223…a399` | `OrderFilled(uint128 taker, uint128 maker, uint256 qty, uint256 takerRemaining, uint256 makerRemaining, uint256 price)` | PerpPool |
| `0xf7816a37…82de` | `PositionUpdated(address account, address pool, int128 newSize, uint128 entry, int256 realizedPnl, int256 entryFundingIndex)` | MarginBank |
| `0xa1506168…ca85` | `FundingSettled(address account, address pool, int256 payment)` | MarginBank |
| `0x9d952b90…3335` | `CollateralLocked(address,address,uint256)` | MarginBank |
| `0x5c87c81b…2e1a` | `CollateralUnlocked(address,address,uint256)` | MarginBank |
| `0x11fa725a…0a0e` | `DepositedFor(address,address,uint256)` (a wallet pull; never seen on the guard's route) | MarginBank |

`c663a157(…)` in the traces is the bank's per-fill settlement call from the pool.

## Third-party accounts

The live read-only runs and the fork end-to-end use public testnet accounts that hold
several markets (for example `0x2E3631D9c6497103BE981Fe3a48B11ba06fDB745`). They are read
from public chain state only; on the fork the account is impersonated locally and
nothing is sent to the network on its behalf.
