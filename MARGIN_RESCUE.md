# Margin Rescue: first validation milestone

Margin Rescue asks one question about a dreamDEX perps account on the Somnia Hideki ("Tokyo") testnet: **if BTC and ETH move together by a stated amount, how much of the account's maintenance buffer is left, and which of a few concrete reductions would bring it back to a target?** It then executes one chosen reduction through a guard that cannot flip or grow the position, and recomputes the same fixed scenario from what actually filled.

> **Status: live run authorized, not yet executed.** Accounting, scenario analysis, the reduce-only guard and the live executor are implemented and tested; the executor has been run against the real venue on local forks, normally and with injected faults. **Nothing has been signed or sent on the live network yet**: no guard is deployed, no margin deposited, no order placed. The run's plan was regenerated read-only on 2026-10-27 at block 34,671,145 (`mr-live-plan/3`, SHA-256 `a21e43c579d47b04ce5cdaec14a2c38c973a54e81c0e3213e22fd3fe90dc18a7`; the same calls and bounds as [`evidence/margin-rescue/live-read-only/live-plan.json`](evidence/margin-rescue/), at that block's prices). It is signed only in the owner's terminal, which holds the test account's key; its evidence will be published in [`evidence/margin-rescue/live-write/`](evidence/margin-rescue/live-write/).
>
> It is an engineering milestone, not a product: no UI beyond the CLI, no hosting, and the candidate set is finite (no global optimisation).

## Correctness pass (second round)

| Gap | Fix | Where |
|---|---|---|
| Execution evidence was not tied to the confirmed action | Every receipt is bound to the saved confirmation before anything is credited: sender, destination (the guard), exact calldata (pool, expected size, side, quantity, limit, deadline, nonce), transaction hash and nonce, value, chain, the guard's single `ReduceExecuted` event (action id, pool, quantity, limit, size before), the taker order's owner, and the blocks of the snapshots before and at the receipt. A mismatch is `EVIDENCE_MISMATCH`, never `GOAL_MET` | `receipt.ts` (`verifyBinding`), `recompute.ts` |
| The account was not re-read before sending | Right before sending, the whole account is read again at one pinned block, compared with the analysed snapshot, and every candidate is re-evaluated under the ORIGINAL scenario; the confirmed request itself is previewed against the fresh book. Any structural change invalidates the confirmation | `refresh.ts`, `executor.ts`, `mr -- refresh` |
| Cleanup used ordinary reverse IOCs | Every cleanup order is a guarded full close with the exact signed position just read; there is no unguarded fallback | `cleanup.ts` |
| Unknown transactions could be followed by dependent ones | Every step (deploy, approve, deposit, orders, grants, cleanup) is persisted with its hash and nonce before broadcast and resolved before the next is sent; gas is reserved for cleanup | `txlog.ts` |
| Plan not bound to bytecode; loss stop overstated; 200-stop cap; exit 0 on failure; cleanup not verified | The plan binds the guard's creation code, deployment data, source and expected runtime code; the deployed code is checked before any grant. The 15 USDso threshold is described as a soft stop. Stop discovery pages to the end and refuses an indexer behind the pinned block. Failed or incomplete runs exit non-zero. Cleanup is verified at one block across every pool | `livePlan.ts`, `guardArtifact.ts`, `common.ts`, `executor.ts` |

Third round:

| Gap | Fix | Where |
|---|---|---|
| A failed lookup could clear an unresolved transaction | Lookups distinguish an explicit "not found" (the node returned null) from a failed request. A failed lookup settles nothing, and a used nonce is not taken as proof of replacement: the transaction that consumed it is located (binary search on the account's nonce by block, then that block's transactions), and only a different hash there makes the step `NOT_INCLUDED`. Otherwise it stays `UNKNOWN`, its worst-case fee stays reserved, and nothing else is sent | `outcome.ts`, `txlog.ts`, `journal.ts` |
| A refused preflight still ran cleanup | Cleanup runs only for a run whose persisted ledger shows it sent something. A run that stops before its first signature is `REFUSED` (exit 1) and touches nothing, also when resumed | `executor.ts` |
| The cleanup reserve assumed two close attempts | Each main-phase send reserves the cleanup the run could need right after it, from the real limit of three attempts: per open leg a grant and three closes, a revoke per pool, a withdrawal, an allowance reset (at most 12 for this plan), at 13M gas each (the 10M per-order ceiling plus the sender's 30% headroom), plus the worst-case fee of any unresolved step | `cleanup.ts` (`cleanupTxBound`), `executor.ts`, `txlog.ts` |
| The cleanup-failure scenario was described as reverted transactions | Its BTC close attempts were refused in the node's simulation (`WOULD_REVERT`, `tx: null`): nothing was signed or broadcast. The rehearsal now requires exactly that, and a separate scenario shows broadcast attempts that partially fill | docs, `forkRehearsal.ts` |

## What is verified, and how

| Claim | How it is checked | Evidence |
|---|---|---|
| The account's health equity, IM, MM and CM can be rebuilt from raw state to the raw unit | Snapshot pinned to one block hash; every nonzero position in every pool (bank list cross-checked against all 21 factory pools); compared with `MarginBank.getAccountHealth` at the same block | live, read-only: real accounts with 3, 6, 9 and 21 markets (the last with 181 resting orders) reconcile `EXACT` at blocks 33646741–33647348 (first round: 33515595–33516096) |
| The bank floors unrealized PnL (the SDK truncates) | All holders of all 21 pools from the bank's own holder roster at one block, rebuilt under both roundings | live, read-only, block 33516436: 7,700 / 7,700 accounts exact with floor (IM, MM, CM also 7,700 / 7,700); truncation exact for 2,271, wrong for every account with a negative inexact PnL leg |
| Scenario arithmetic, locks, funding and rounding | Synthetic fixtures A and B from the plan, plus mixed decimals, negative balances, a third market, MM = 0, upside shocks, partial fills with fees, exact-target ±1 | fixture: `npm test` |
| An IOC never fills beyond its limit | Real venue on a fork, both sides, with the book deeper than the limit | fork: `VenueSemantics`, `ReduceOnlyGuard` suites |
| The guard cannot flip or grow a position, and a failed postcondition rolls back the venue's fills | Fork tests; a test-only harness that skips the guard's preconditions makes the real venue flip the position, then the production postcondition reverts everything | fork: `PostconditionRollback` suite and its `-vvvv` trace |
| A reduction settles funding on the whole position and floors realized PnL per fill | Partial reduce of a real 6-market account through the guard on a fork, decoded from the receipt | fork: `AccountLedger` suite, end-to-end run |
| The same scenario recomputed from actual execution | Fork end-to-end on a real 6-market account: analyse → deploy guard → grant → refresh → journalled send → bound receipt → recompute; then a replayed confirmation and an expired quote | fork: `evidence/margin-rescue/fork/e2e-33472615/` — 0.8165 ETH filled inside the limit, binding holds, 17/17 ledger checks, recomputed buffer = forecast, `GOAL_MET`; the replay reverts `PositionMismatch`, the expired quote is `INVALIDATED` unsent |
| A receipt that is not the confirmed action is never credited | 19 synthetic tamperings (action id, calldata, destination, sender, hash, value, nonce, guard event fields, extra or missing guard event, taker owner, snapshot blocks, edited confirmation, scenario); and the fork run's own receipt altered six ways and recomputed | fixture: `mr-recompute.test.ts`; fork: `rehearsal-33472615/tamper/` — every variant `EVIDENCE_MISMATCH` |
| A changed account invalidates the confirmation before sending | Synthetic: moved position, collateral, new order, settled funding, thinner book, changed selection, risk change, deadline, unreconciled read; fork: a third party takes liquidity after the analysis, and the owner's own key trades after the analysis | fixture: `mr-refresh.test.ts`; fork: `rehearsal-33472615/book-change/`, `owner-change/` |
| Actual partial fills and funding drift are recomputed from what happened | Synthetic partial fill, two-maker fill, fill outside the limit, drift that keeps and drift that breaks the goal; fork: a third party leaves only half the confirmed quantity inside the limit right before the send; a real hourly funding settlement crosses between the analysis and the send | fixture: `mr-recompute.test.ts`; fork: `rehearsal-33472615/partial-fill/`, `rehearsal-33609475/funding-drift/` |
| Unknown transactions are resolved before anything else is sent | Stub chain: missing receipt, lost HTTP answer, node rejection, a mined transaction whose receipt and transaction lookups time out, a used nonce whose transaction cannot be located or is this one, a located replacement, a JSON-RPC error answer, foreign pending transaction; fork: the reduction left unmined (`timeout`), and the reduction mined while receipt and transaction lookups time out (`rpc-outage`): both stop with exit 40, the step `UNKNOWN` with its fee reserved and nothing else sent, then `--resume` settles the same hash with its real fee and finishes | fixture: `mr-txlog.test.ts`, `mr-action.test.ts`; fork: `rehearsal-33472615/timeout/`, `rpc-outage/` |
| A refused preflight touches nothing | Fork: the owner has already approved 10 USDso and deposited 4; the run is `REFUSED` (exit 1) with zero signatures and zero broadcasts, no block is mined, and the nonce, balances, allowance and collateral are unchanged; resuming it refuses again | fork: `rehearsal-33472615/preflight-refusal/` |
| The cleanup reserve covers the longest cleanup | Arithmetic over every main step's footprint; fork: the run is interrupted with both legs open while the owner sets an allowance, each leg's first two guarded closes fill only a part, and cleanup sends 12 transactions (2 grants, 6 closes, 2 revokes, a withdrawal, an allowance reset), all inside the 12 reserved by the last main step | fixture: `mr-cleanup-bound.test.ts`; fork: `rehearsal-33472615/cleanup-retries/` |
| Cleanup never falls back to an unguarded order and is verified | Fork: the happy run closes both legs through the guard and verifies 9 end-state checks across 21 pools. With the BTC book emptied inside each close's limit, the node's simulation rejects all three guarded BTC close attempts (`WOULD_REVERT`, `ImmediateOrCancelNoFill()`), so none is signed or broadcast (`tx: null`); BTC is reported open, ETH is still closed through the guard, the grants are revoked, and the run exits 30 | fork: `rehearsal-33472615/happy/`, `cleanup-fail/` |
| The deployed guard is the approved build | The executor compares the local build's hashes with the plan before deploying, then the code at the deployed address with the expected runtime (owner and bank written into the immutables) and reads back `OWNER`, `MARGIN_BANK`, `trustedPool` before any grant | fixture: `mr-guard-artifact.test.ts`; fork: every rehearsal scenario's `guard.json` (`verified: true`) |
| The live executor does what the approved plan says | `liveRun.ts` run as the live command (plan digest, raw signing) against a fork with a throwaway key | fork: `rehearsal-33472615/happy/` — exit 0, `COMPLETE`, `GOAL_MET`, cleanup verified |
| Stop discovery is complete | Paging past 200 records, duplicates, a stop created while paging, truncation refused, indexer height behind the pinned block refused; live: three accounts with 385, 249 and 202 stop records | fixture: `mr-stops.test.ts`; live-read-only: `stop-pagination.json` |

Evidence is labelled `fixture`, `fork`, `live-read-only` or `live-write`. There is no `live-write` evidence. `fork/live-rehearsal-33472615/` is the previous executor's rehearsal (plain IOC cleanup) and is kept only as history; it is superseded by `fork/rehearsal-33472615/`.

## Layout

| Path | What it is |
|---|---|
| `src/margin-rescue/snapshot.ts` | One account read completely at one block hash |
| `src/margin-rescue/math.ts`, `reconcile.ts` | Exact integer health arithmetic; field-by-field comparison with the bank |
| `src/margin-rescue/scenario.ts` | Immutable, hashed scenario; valuation of any portfolio at its absolute prices |
| `src/margin-rescue/book.ts`, `candidates.ts` | IOC fills against the bounded book; the finite candidate set and selection |
| `src/margin-rescue/action.ts`, `journal.ts` | Action id (identical to the contract's), persistent action journal, send and recovery |
| `src/margin-rescue/refresh.ts` | The pre-send refresh: structural comparison and re-evaluation under the original scenario |
| `src/margin-rescue/receipt.ts`, `recompute.ts` | Receipt decoding and binding to the confirmation; ledger reconciliation; recomputation under the scenario |
| `src/margin-rescue/txlog.ts`, `outcome.ts` | The run's transaction ledger and sender (persisted before broadcast, resolved before anything dependent, gas reserve); what became of a transaction, from chain data alone |
| `src/margin-rescue/guardArtifact.ts` | The guard build a plan is bound to; expected runtime code; deployed-code verification |
| `src/margin-rescue/executor.ts`, `cleanup.ts`, `liveRun.ts` | The live run as a library, its guarded cleanup and end-state verification, and the command |
| `src/margin-rescue/study.ts`, `livePlan.ts` | Rounding study; read-only live plan |
| `src/margin-rescue/cli.ts`, `forkE2e.ts`, `forkRehearsal.ts`, `forkTools.ts` | CLI; end-to-end run and executor rehearsal (with fault injection) on local forks |
| `contracts/src/ReduceOnlyGuard.sol` | The guard (production) |
| `contracts/src/ReduceGuardChecks.sol` | Its postcondition, shared with the test harness |
| `contracts/test/harness/UnsafeReduceHarness.sol` | **Test only**, deliberately unsafe; never deployed |
| `contracts/test/fork/*.sol`, `contracts/test/unit/*.sol` | Fork tests against the real venue; mock unit tests |
| `tools/rpc-shim.mjs` | Local JSON-RPC shim that lets Foundry fork Hideki (optionally caching state reads at a fixed block) |
| `tools/stops-compare.ts` | Read-only comparison of the previous 200-record stop listing with the paged one |

## Network and versions

| | |
|---|---|
| Network | Somnia Hideki testnet, chain **50383** (any other chain is refused) |
| MarginBank | `0x478769E1177C0773c43A593DCCc4Ad15F15F1394` (ERC-1967 proxy; implementation `0x78C989C9c5cD2Ed68b4486373c0e4b118C8F1D5C` at the time of testing) |
| BTC / ETH pools | `0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0` / `0xD6Cb1DD58580B84D76068aC21594219ce03aeddf` (beacon proxies) |
| OperatorPermissionsRegistry | `0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a` |
| SDK | `@somnia-chain/markets-sdk` 0.32.1, `viem` 2.57.7, `tsx` 4.23.15, TypeScript 5.9.3, Node 22 |
| Contracts | Solidity 0.8.28 (optimizer 200 runs, `cancun`), Foundry 1.8.4, forge-std v1.17.0 |

## Setup

```bash
npm ci
(cd contracts && forge install foundry-rs/forge-std@v1.17.0 --no-git && forge build)
```

Foundry cannot fork Hideki directly: the RPC rejects EIP-1898 block objects (`{"blockNumber": …}`) on `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount` and `eth_getStorageAt`, and Foundry's fork backend sends them. `tools/rpc-shim.mjs` rewrites them to plain block numbers (and resolves a block hash only if it is canonical). Start it before any fork test:

```bash
npm run rpc-shim                 # http://127.0.0.1:8546 -> Hideki
SHIM_CACHE=1 npm run rpc-shim    # same, remembering state reads at a fixed past block (repeated fork runs)
```

A cold anvil fork fetches every storage slot an order touches, one round trip at a time, so the first order of a fork run can take several minutes; `evm_revert` drops what anvil fetched, which is why the rehearsal is much faster through the caching shim (`--upstream`).

## Commands

Read-only, live network:

```bash
# Rebuild an account's health independently and compare it with the bank (exit 0 only if EXACT)
npm run mr -- reconcile --account 0x2E3631D9c6497103BE981Fe3a48B11ba06fDB745 --out /tmp/mr

# Fixed scenario: BTC -8%, ETH -12%, every other market at its reference mark; target buffer 0 USDso
npm run mr -- analyze --account 0x2E3631D9c6497103BE981Fe3a48B11ba06fDB745 \
  --shock BTC=-8 --shock ETH=-12 --target 0 --out /tmp/mr
#   options: --price ETH=2000 (absolute instead of a shock), --slippage-bps 50, --include-cancel, --block N

# Which rounding does the bank use? (every holder of every pool at one block)
npm run mr -- study-rounding --out /tmp/rounding.json

# The single live plan to approve (reads balances, books, gas; signs nothing)
npm run mr -- live-plan --out /tmp/live-plan.json
```

Execution path (used on the fork; on the live network only after approval):

```bash
npm run mr -- plan --analysis /tmp/mr --guard 0xGUARD          # pre-flight + refresh, action id, journal NOT_SENT, unsigned tx
npm run mr -- refresh --analysis /tmp/mr --action 0xACTION     # re-check right before signing; INVALIDATED if the account changed
npm run mr -- recompute --analysis /tmp/mr --action 0xACTION [--tx 0xHASH]   # binds the receipt to the confirmation first
npm run mr -- actions --resolve                                  # settle PENDING/UNKNOWN from chain data; never re-sends
```

Exit codes: `reconcile` 3 unless `EXACT`; `analyze` 3 when `BLOCKED`; `plan`/`refresh` 4 when the confirmation is refused or invalidated; `recompute` 0 only for `GOAL_MET` (5 not settled, 6 `EVIDENCE_MISMATCH`, 7 `BASELINE_CHANGED`/`UNAVAILABLE`, 8 `GOAL_NOT_MET`).

Tests:

```bash
npm run typecheck
npm test                 # TypeScript unit tests, fixtures and mocks only
npm run test:contracts   # Solidity unit tests with mocks (no network)
npm run test:fork        # Solidity fork tests against the real venue (needs the shim; slow on a cold cache)
npm run mr:fork-e2e      # end-to-end on a local anvil fork (needs the shim and forge build)
npm run mr:fork-rehearsal                                         # the live executor on a fork: happy path + tamper + 8 faults (block 33472615)
npm run mr:fork-rehearsal -- --block 33609475 --only funding-drift   # crosses a real hourly funding settlement
```

The live run itself (only after the owner approves one specific plan file; the key comes from the environment of that one terminal and is never typed on a command line or written anywhere). The run writes to a private, git-ignored folder; its evidence reaches the repository only through the read-back and the scanned copy below:

```bash
npm run mr -- live-plan --out live-plan.json      # regenerate (read-only), then approve this exact file
shasum -a 256 live-plan.json
read -rs "MR_SIGNER_KEY?Test account key: " && export MR_SIGNER_KEY      # zsh; the input is not echoed or kept in history
npm run mr:live -- --plan live-plan.json --approve <sha256> --out .margin-rescue/live/run-1
npm run mr:live -- --plan live-plan.json --approve <sha256> --out .margin-rescue/live/run-1 --resume   # only after exit 40
unset MR_SIGNER_KEY

npm run mr:verify-run -- --run .margin-rescue/live/run-1      # read-only: every receipt, the end state at one block, gas and collateral, the fixed-scenario recomputation
npm run mr:publish-run -- --from .margin-rescue/live/run-1 --to evidence/margin-rescue/live-write/run-1   # scanned copy for the repository
```

`mr:verify-run` reads every transaction of the run ledger and the account again from the chain, without the executor's code: sender, nonce, destination, calldata hash, status and fee of each receipt; no other transaction from the account; the deployed guard against the approved runtime hash; at one block, no position or resting order in any factory pool, no live stop, every grant revoked, the bank account empty and the allowance zero; STT spent equal to the receipt fees and the USDso result equal to realized PnL − funding − fees; and the scenario's absolute prices re-derived from the chain marks at its reference block, then the account valued at those prices just before and at the reduction's block. `mr:publish-run` refuses a folder that holds the key, a signed transaction or a mnemonic, replaces local paths and private URLs, and lists every file with the SHA-256 of the original and the copy in `SANITIZATION.md`.

`mr:live` exits 0 only when the guarded reduction is bound, recomputed `GOAL_MET` and cleanup is verified; 1 when it refused before signing anything (plan or key mismatch, a failed preflight such as an account that already holds collateral or an allowance, a read failure, a first step that would revert in simulation): nothing was broadcast and no cleanup ran; 10 when cleanup is verified but no reduction was demonstrated (no action needed, nothing feasible, confirmation invalidated, goal not met); 20 when a started run aborted (soft loss stop, a transaction from the account that the run did not send, an interruption) and cleanup is verified; 30 when cleanup is not verified; 40 when a transaction is unresolved (nothing else was sent; resume later).

Fork tests default to block **33472615**; set `FORK_BLOCK` to use another (the tests read the book at that block, so they adapt; `REAL_ACCOUNT` picks the real account for the ledger test). They hold the clock at the fork block's own timestamp, because the venue refuses marks older than 5 seconds.

## The accounting

```text
E_risk  = unlocked + Σ floor((mark − entry) × size / oneBase) − Σ ceil(size × (cumFunding − entryFundingIndex) / (1e18 × oneBase))
E_total = E_risk + locked
MM      = Σ ceil(floor(|size| × mark / oneBase) × mmBps / 10000)
buffer  = E_risk − MM
```

`E_risk` is what the bank compares with its requirements; collateral locked behind resting orders is not in it, and cancelling an order only moves collateral from locked to unlocked (positions, MM and `E_total` do not change; fork-verified). TP/SL stops prepay STT, which is not USDso collateral and is not touched.

The model is deployment-exact: every account in the rounding study and every account reconciled live matched the bank to the raw unit, so the numerical bound is zero. Had truncation been used, the error would be at most one raw unit per leg whose PnL quotient is negative and inexact.

## The scenario and the candidates

A scenario is a canonical JSON object whose id is its SHA-256. It fixes the chain, MarginBank, account, reference block number, hash and time, every held market's pool, units, reference mark, **absolute scenario price**, configured risk rates and fees, the funding assumption, the model version and the target buffer. BTC and ETH may be shocked; every other held market stays at its reference mark and stays in the calculation. The shock is instantaneous and static: no price path, no stop or liquidation on the way, no further funding accrual. A later snapshot with changed risk rates or a newly held market cannot be valued under the old scenario.

Candidates are: no action; 25/50/75/100% reductions of each BTC or ETH position (aligned down to the lot, deduplicated); and, with `--include-cancel`, cancelling all ordinary resting orders. Each reduction is previewed **now** against the order book read at the reference block, with a protective IOC limit (default 50 bps beyond the touch), realized PnL floored per fill, fees per fill, and funding owed on the whole position settled once; the remaining portfolio is then valued at the scenario prices. A candidate is unavailable if it rounds to zero, is below the minimum order, would leave a remainder below the minimum (which no single order could close later), would self-match an own resting order, or finds nothing inside its limit. If doing nothing meets the target, nothing is recommended; if no candidate meets it, the result is `NO_FEASIBLE_CANDIDATE`; any snapshot problem (stale mark, a pool outside the bank's list, a failed read, an unlisted stop set, an inexact reconciliation, a linked child account) blocks a recommendation. Among candidates that meet the target, the smallest current notional reduction is preferred, then the lowest cost. That is a choice among the evaluated candidates, not a global optimum.

## The guard

The venue has no immediate reduce-only order: `PlacePerpOrderParams` and the pool's `placeOrder`/`placeOrderFor` take no such flag, the order type is a closed enum of four (fork-checked), the official close helper sends a plain opposite-side IOC, and the only reduce-only paths are a market-wide close-only status and TP/SL stops. So `ReduceOnlyGuard` is the account's own operator:

- deployed per owner, with the chain (50383), MarginBank and trusted pools fixed at construction (each pool must name the bank and be registered);
- admitted by the owner's per-pool grant of `placeOrderFor` (selector `0x80054449`) in the OperatorPermissionsRegistry, the same grant the app's "Link a bot" writes; without it the venue reverts `OnlyApprovedContracts()`;
- callable only by the owner; it places only IOC orders for the owner, with `CANCEL_TAKER` self-matching;
- binds each action to an id that commits to chain, guard, bank, owner, pool, the exact signed position the owner confirmed, side, quantity, limit, a seconds deadline, the IOC type and a nonce (the TypeScript client computes the same id; a shared test vector pins it);
- before the venue call: owner, chain, trusted pool, bank, deadline, unused id, **live position exactly equal to the confirmed one**, opposite side, `0 < quantity ≤ |position|`, lot and minimum, limit on the tick; the id is reserved and a reentrancy lock held;
- after the venue call: the position must be on the same side or flat, no larger, and reduced by at most the quantity; otherwise the whole transaction reverts, venue fills included.

It holds no tokens and has no deposit, withdraw, approve, cancel or arbitrary-call function. The operator route pulls nothing from the owner's wallet (fork-checked). Per-fill price protection is the venue's IOC limit, checked on a fork on both sides.

Venue behaviours the planner relies on, all observed on the fork: a zero-fill IOC reverts `ImmediateOrCancelNoFill()` (the guard's id reservation reverts with it); a partial fill succeeds and consumes the id; an expiry equal to the block time in ns is accepted and an earlier one reverts `OrderAlreadyExpired()`; a self-match reverts `SelfMatchCancelTaker()`; a reduction may leave a remainder below the minimum order; a resting reduce-side order is not tied to the position and can outlive it with nothing locked, so resting orders are listed as exposure the static model does not cover.

## Execution: confirmation, refresh, send, binding, recomputation, cleanup

**Confirmation.** The action record is written before anything is broadcast and keeps three separate states: transaction (`NOT_SENT`, `PENDING`, `UNKNOWN`, `REVERTED`, `CONFIRMED`, `NOT_INCLUDED`, `INVALIDATED`), fill (`NO_FILL`, `PARTIAL_FILL`, `REQUESTED_FILL`) and goal (`GOAL_MET`, `GOAL_NOT_MET`, `BASELINE_CHANGED`, `UNAVAILABLE`, `EVIDENCE_MISMATCH`). One action per owner may be unsettled at a time; an expired quote is invalidated before sending; an ambiguous send is settled from its own hash and nonce and never re-sent.

**Refresh.** Right before sending, the account is read again at one pinned block. The confirmation is `INVALIDATED` (and never sent) if any position's size, entry or entry funding index changed, if collateral, resting orders, live stops, the account mode, the allowance or the bank's active pool list changed, if the snapshot has problems or does not reconcile `EXACT`, if a risk setting changed (the scenario no longer applies), if every candidate re-evaluated under the ORIGINAL scenario now selects a different one, if the confirmed request (same quantity and limit) would fill a different amount against the fresh book or no longer meets the target, or if less than 30 s remain to its deadline. Marks and funding accrual are not structural: the fresh analysis already prices them, and the funding drift is reported. The live run may make one new confirmation from the fresh analysis under the same scenario; a second invalidation stops the reduction.

**Run ledger.** Every transaction of a live run (deploy, approve, deposit, opening orders, grants, the reduction, every cleanup step) is persisted with its destination, selector, calldata hash, nonce, gas, gas price and the hash of the signed bytes before the bytes leave the process; the bytes are never written. A step without a receipt is resolved from its hash and nonce before anything else is sent (`outcome.ts`). Only a canonical receipt settles it (`CONFIRMED` or `REVERTED`, with its fee); it is `NOT_INCLUDED` only if the node rejected it or the transaction that consumed its nonce was located and has another hash. A lookup that fails (timeout, HTTP or JSON-RPC error) is not "not found", and a used nonce whose transaction cannot be located, or turns out to be this one, proves nothing: the step stays `UNKNOWN` with its worst-case fee reserved, the run stops with exit 40, and `--resume` continues from chain data once the outcome can be established. A transaction from the account that the run did not send stops the main flow; cleanup records it and proceeds. Every main-phase send must leave, under the plan's STT cap and in the wallet, 13M gas at the current price for each cleanup transaction the run could need if it stopped right after that send (per open leg a grant and up to three guarded closes, a revoke per pool, a withdrawal, an allowance reset: at most 12 for this plan), plus the worst-case fee of any unresolved step. A run that stops before its first signature runs no cleanup at all: whatever made it refuse (collateral, an allowance) stays as it was.

**Binding and recomputation.** `recompute` first binds the receipt to the saved confirmation (see the table above); a mismatch is `EVIDENCE_MISMATCH` and nothing in the receipt is credited. Then it reads the canonical receipt, decodes the guard event, the IOC's own fills and every MarginBank row for the owner, takes a snapshot at the receipt's block, and lists every bank row naming the owner between the refresh and the receipt. The ledger must be explained by the transaction's own rows (size moved by exactly the fills, realized PnL floored per fill, funding settled once on the whole position at the transaction's own index, fees, unlocked moved by realized − funding − fees, locked unchanged, no wallet movement, nothing resting, every other market untouched); anything else gives `BASELINE_CHANGED` instead of crediting the action. The remaining portfolio is then valued at the scenario's original absolute prices and shown beside the baseline, the forecast and the account's actual health.

**Cleanup.** Driven by chain state, not by what the run thinks it did. Each remaining position is closed by a guarded full close (exact signed position just read, protective limit, short deadline, journalled), at most three attempts per leg with a fresh read each time. An attempt the node's simulation already rejects is not signed or broadcast (`WOULD_REVERT`); one that is sent may fill only a part, and the next attempt starts from the new position. A leg the guard cannot close is reported, never closed with an unguarded order, and the other legs and the remaining steps still run. Then every grant to the guard is revoked, the collateral withdrawn only when no position or order remains, the allowance cleared, and the end state verified at one block: no position in any of the 21 pools, no order, no live stop, bank balance zero, allowance zero, no per-pool or global grant to the guard, no unresolved transaction, no unguarded cleanup order.

**Loss threshold.** The plan's 15 USDso is a soft stopping threshold: equity is checked after each opening order and after the reduction, and once it is found below the threshold the run stops and unwinds. Prices can move between checks and the unwind pays spread and slippage, so the realised loss can exceed it (it cannot exceed the deposit).

**Funding settles hourly.** On this deployment the projected cumulative funding index is flat between settlements and steps at `lastFundingUpdate + 3600 s` (live: the BTC index stepped at block 33609480 and the stored index caught up one block later). Funding drift between an analysis and its execution therefore appears only when a settlement falls in between; the fork rehearsal reproduces that at block 33609475, one second before a BTC settlement.

## Limitations

- No live write has been performed; the live milestone is blocked on approval, not on a technical failure.
- Faults on the fork are injected by the rehearsal (a funded third party taking liquidity, the owner's key trading, mining paused, the clock moved across a settlement); they show the executor's responses, not how often such events happen live.
- Gas figures from the fork are Ethereum's schedule, not Somnia's (Somnia charges about 4,928 gas per deployed byte; `live-plan` asks the live RPC for estimates).
- Stops are listed from the indexer (paged to the end, refused if the indexer has not processed the pinned block) and checked live at that block; the registry has no on-chain enumeration, so their completeness still rests on the indexer.
- The scenario is static. It says nothing about the path to the shocked prices, about fills of resting orders or stops on the way, or about liquidation; an expected fill is not a guaranteed fill.
- Book depth is what was read (30 levels by default).
- The venue contracts are upgradeable proxies; the guard's postcondition holds whatever they do, but the IOC price bound is the venue's behaviour as tested at the fork block.
