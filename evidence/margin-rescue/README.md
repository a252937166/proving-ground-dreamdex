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
| `fixture/npm-test.txt` | fixture | All TypeScript unit tests (Proving Ground and Margin Rescue), including the plan's fixtures A and B |
| `fixture/forge-unit-mock.txt` | fixture | Solidity unit tests with mocks: reentrancy, constructor validation, venue failure report, postcondition matrix and fuzz, action-id vector |
| `fork/forge-fork-tests.txt` | fork | Every Solidity fork suite at block 33472615: guard execution and preconditions, postcondition rollback, account ledger, raw venue semantics |
| `fork/trace-postcondition-rollback.txt` | fork | `-vvvv` call trace: the venue's fills and margin updates inside `placeOrderFor`, then `PositionFlippedOrIncreased`, then the revert of everything |
| `fork/trace-per-fill-bound.txt` | fork | `-vvvv` traces of the per-fill limit tests on both sides |
| `fork/e2e-33472615/` | fork | End-to-end on anvil: analysis of a real 6-market account, guard deployment, grant, journalled send, receipt, recomputation, a replayed confirmation and an expired quote |
| `fork/live-rehearsal-33472615/` | fork | The live executor (`liveRun.ts`) run unchanged against a fork with a throwaway key: plan digest check, approve, deposit, two opening IOCs, guard, analysis, grant, guarded reduction, recomputation, cleanup |
| `live-read-only/reconcile-<account>/` | live-read-only | Hash-pinned snapshots and field-by-field reconciliation of real accounts with 3, 6, 9 and 21 markets |
| `live-read-only/analysis-0x2E3631D9/` | live-read-only | Scenario (BTC −8%, ETH −12%, others at reference) and the candidate comparison for a real 6-market account |
| `live-read-only/rounding-study.json` | live-read-only | Every holder of every pool at one block, rebuilt with floor and with truncation |
| `live-read-only/live-plan.json` | live-read-only | The proposed live plan for the dedicated test EOA: balances, markets, gas estimates, every call and bound. **A proposal, not executed** |
| `regression/` | live-read-only | The earlier Proving Ground commands still work (`test:live`, `snapshot`, `precheck`) |
| `live-write/README.md` | — | Why there is no live-write evidence |

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
