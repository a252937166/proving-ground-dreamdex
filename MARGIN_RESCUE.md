# Margin Rescue: first validation milestone

Margin Rescue asks one question about a dreamDEX perps account on the Somnia Hideki ("Tokyo") testnet: **if BTC and ETH move together by a stated amount, how much of the account's maintenance buffer is left, and which of a few concrete reductions would bring it back to a target?** It then executes one chosen reduction through a guard that cannot flip or grow the position, and recomputes the same fixed scenario from what actually filled.

> **Status: BLOCKED_LIVE.** Accounting, scenario analysis and the reduce-only guard are implemented and tested; the guard has been exercised against the real venue on a local fork. **Nothing has been signed or sent on the live network**: no guard is deployed, no margin deposited, no order placed. The live step needs one approval; its exact calls and bounds are in [`evidence/margin-rescue/live-read-only/live-plan.json`](evidence/margin-rescue/).
>
> It is an engineering milestone, not a product: no UI beyond the CLI, no hosting, and the candidate set is finite (no global optimisation).

## What is verified, and how

| Claim | How it is checked | Evidence |
|---|---|---|
| The account's health equity, IM, MM and CM can be rebuilt from raw state to the raw unit | Snapshot pinned to one block hash; every nonzero position in every pool (bank list cross-checked against all 21 factory pools); compared with `MarginBank.getAccountHealth` at the same block | live, read-only: real accounts with 3, 6, 9 and 21 markets (the last with 175 resting orders) reconcile `EXACT` at blocks 33515595–33516096 |
| The bank floors unrealized PnL (the SDK truncates) | All holders of all 21 pools from the bank's own holder roster at one block, rebuilt under both roundings | live, read-only, block 33516436: 7,700 / 7,700 accounts exact with floor (IM, MM, CM also 7,700 / 7,700); truncation exact for 2,271, wrong for every account with a negative inexact PnL leg |
| Scenario arithmetic, locks, funding and rounding | Synthetic fixtures A and B from the plan, plus mixed decimals, negative balances, a third market, MM = 0, upside shocks, partial fills with fees, exact-target ±1 | fixture: `npm test` |
| An IOC never fills beyond its limit | Real venue on a fork, both sides, with the book deeper than the limit | fork: `VenueSemantics`, `ReduceOnlyGuard` suites |
| The guard cannot flip or grow a position, and a failed postcondition rolls back the venue's fills | Fork tests; a test-only harness that skips the guard's preconditions makes the real venue flip the position, then the production postcondition reverts everything | fork: `PostconditionRollback` suite and its `-vvvv` trace |
| A reduction settles funding on the whole position and floors realized PnL per fill | Partial reduce of a real 6-market account through the guard on a fork, decoded from the receipt | fork: `AccountLedger` suite, end-to-end run |
| The same scenario recomputed from actual execution | Fork end-to-end on a real 6-market account: analyse → deploy guard → grant → journalled send → receipt → recompute; then a replayed confirmation and an expired quote | fork: `evidence/margin-rescue/fork/e2e-33472615/` — 0.8165 ETH filled inside the limit, 17/17 ledger checks, recomputed buffer = forecast, `GOAL_MET`; the replay reverts `PositionMismatch`, the expired quote is `INVALIDATED` unsent |
| The live executor does what the plan says | `liveRun.ts` run unchanged against a fork, signing locally with a throwaway key: approve, deposit, two opening IOCs, guard, analysis, grant, guarded reduction, recompute, cleanup | fork: `evidence/margin-rescue/fork/live-rehearsal-33472615/` — `GOAL_MET`, bank account empty afterwards |

Evidence is labelled `fixture`, `fork`, `live-read-only` or `live-write`. There is no `live-write` evidence.

## Layout

| Path | What it is |
|---|---|
| `src/margin-rescue/snapshot.ts` | One account read completely at one block hash |
| `src/margin-rescue/math.ts`, `reconcile.ts` | Exact integer health arithmetic; field-by-field comparison with the bank |
| `src/margin-rescue/scenario.ts` | Immutable, hashed scenario; valuation of any portfolio at its absolute prices |
| `src/margin-rescue/book.ts`, `candidates.ts` | IOC fills against the bounded book; the finite candidate set and selection |
| `src/margin-rescue/action.ts`, `journal.ts` | Action id (identical to the contract's), persistent journal, send and recovery |
| `src/margin-rescue/receipt.ts`, `recompute.ts` | Receipt decoding; ledger reconciliation; recomputation under the scenario |
| `src/margin-rescue/study.ts`, `livePlan.ts` | Rounding study; read-only live plan |
| `src/margin-rescue/cli.ts`, `forkE2e.ts` | CLI; end-to-end run on a local fork |
| `contracts/src/ReduceOnlyGuard.sol` | The guard (production) |
| `contracts/src/ReduceGuardChecks.sol` | Its postcondition, shared with the test harness |
| `contracts/test/harness/UnsafeReduceHarness.sol` | **Test only**, deliberately unsafe; never deployed |
| `contracts/test/fork/*.sol`, `contracts/test/unit/*.sol` | Fork tests against the real venue; mock unit tests |
| `tools/rpc-shim.mjs` | Local JSON-RPC shim that lets Foundry fork Hideki |

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
npm run rpc-shim            # http://127.0.0.1:8546 -> Hideki
```

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
npm run mr -- plan --analysis /tmp/mr --guard 0xGUARD          # pre-flight, action id, journal NOT_SENT, unsigned tx
npm run mr -- recompute --analysis /tmp/mr --action 0xACTION [--tx 0xHASH]
npm run mr -- actions --resolve                                  # settle PENDING/UNKNOWN from chain data; never re-sends
```

Tests:

```bash
npm run typecheck
npm test                 # TypeScript unit tests, fixtures and mocks only
npm run test:contracts   # Solidity unit tests with mocks (no network)
npm run test:fork        # Solidity fork tests against the real venue (needs the shim; slow on a cold cache)
npm run mr:fork-e2e      # end-to-end on a local anvil fork (needs the shim and forge build)
npm run mr:fork-rehearsal  # the live executor, unchanged, on a fork with a throwaway key
```

The live run itself (only after the owner approves one specific plan file; the key comes from the environment of that one command and is never written anywhere):

```bash
npm run mr -- live-plan --out live-plan.json      # regenerate, then approve this exact file
shasum -a 256 live-plan.json
MR_SIGNER_KEY=0x… npm run mr:live -- --plan live-plan.json --approve <sha256>
```

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

## Execution state and recomputation

The action record is written before anything is broadcast and keeps three separate states: transaction (`NOT_SENT`, `PENDING`, `UNKNOWN`, `REVERTED`, `CONFIRMED`, `NOT_INCLUDED`, `INVALIDATED`), fill (`NO_FILL`, `PARTIAL_FILL`, `REQUESTED_FILL`) and goal (`GOAL_MET`, `GOAL_NOT_MET`, `BASELINE_CHANGED`, `UNAVAILABLE`). One action per owner may be unsettled at a time; an expired quote is invalidated before sending; an ambiguous send is settled from its own hash and nonce and never re-sent.

`recompute` reads the canonical receipt, decodes the guard event, the IOC's own fills and every MarginBank row for the owner, takes a snapshot at the receipt's block, and lists every bank row naming the owner between the pre-flight and the receipt. The ledger must be explained by the transaction's own rows (size moved by exactly the fills, realized PnL floored per fill, funding settled once on the whole position, fees, unlocked moved by realized − funding − fees, locked unchanged, no wallet movement, nothing resting, every other market untouched); anything else gives `BASELINE_CHANGED` instead of crediting the action. The remaining portfolio is then valued at the scenario's original absolute prices and shown beside the baseline, the forecast and the account's actual health.

## Limitations

- No live write has been performed; the live milestone is blocked on approval, not on a technical failure.
- Gas figures from the fork are Ethereum's schedule, not Somnia's (Somnia charges about 4,928 gas per deployed byte; `live-plan` asks the live RPC for estimates).
- Stops are listed from the indexer and checked live at the pinned block; the registry has no on-chain enumeration, so their completeness rests on the indexer.
- The scenario is static. It says nothing about the path to the shocked prices, about fills of resting orders or stops on the way, or about liquidation; an expected fill is not a guaranteed fill.
- Book depth is what was read (30 levels by default).
- The venue contracts are upgradeable proxies; the guard's postcondition holds whatever they do, but the IOC price bound is the venue's behaviour as tested at the fork block.
