# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Product users:** dreamDEX perps traders and bot operators who hold positions in several markets inside one cross-margin account on the Somnia Hideki ("Tokyo") testnet, chain 50383. Their job: learn what a joint BTC/ETH move would do to the account's maintenance buffer, and choose a concrete reduction that restores a target buffer before the move happens.
- **First audience of the website (confirmed 2026-10-26):** reviewers of the DoraHacks dreamDEX perps bounty. In one visit they need the problem, the mechanism and the real evidence. Traders come second, served through the app.

## Product Purpose

Margin Rescue answers one question about a dreamDEX cross-margin account: if BTC and ETH move together by a stated amount, how much maintenance buffer is left, and which of a few concrete reductions would bring it back to a target? It then executes one chosen reduction through a reduce-only guard that cannot flip or grow the position, and recomputes the same fixed scenario from what actually filled. Success is a recomputed buffer, from actual fills bound to a canonical receipt, that meets the target (`GOAL_MET`).

## Positioning

The complete loop has four steps:

1. Apply one joint multi-market shock at fixed absolute prices.
2. Compare concrete reductions, costed against the live book.
3. Execute one guarded reduction.
4. Recompute the same fixed scenario from the actual fills.

On 2026-10-26, none of the public bounty projects checked covered this loop. Its neighbours were single-position stress labs, account terminals, auto-deleveraging bots and stop checkers. Margin Rescue also rebuilds account health independently from raw chain state and matches it to the bank's getter down to the raw unit.

## Operating Context

- **Venue:** dreamDEX perps on Somnia Hideki, chain 50383 only. USDso collateral; MarginBank `0x478769E1177C0773c43A593DCCc4Ad15F15F1394`; 21 pools. Marks expire after about 5 s and funding settles hourly.
- **Existing tools:**
  - The CLI: `npm run mr -- reconcile | analyze | plan | refresh | recompute | actions | live-plan`.
  - The live executor, `npm run mr:live`. It runs only in the owner's terminal, against a plan approved by its SHA-256.
  - The Foundry contracts, including `ReduceOnlyGuard`.
  - The read-only local server, `npm run serve` (127.0.0.1), and the earlier Proving Ground prototype page.
- **Evidence:** `evidence/margin-rescue/`, labelled fixture, fork, live-read-only or live-write, with SHA256SUMS.
- **Bounty:** the DoraHacks dreamDEX perps bounty closes 2026-11-01 23:59 UTC. A submission needs real Tokyo-testnet perps orders, a repo, a demo and X posts. Each of those outward actions needs separate authorization.

## Capabilities and Constraints

- **App (confirmed):** read-only, with no wallet in the browser. It has three screens:
  1. Account and scenario, for any public address.
  2. Compare reductions.
  3. A recorded execution result: the fork run now, the live run once it passes.

  Execution stays in the reviewed CLI flow, with plan approval.
- **Dashboard (confirmed):** live BTC and ETH market data, plus verification status from the evidence folder: tests, fork scenarios, and the live run with its transaction hashes.
- **Candidates are finite:** BTC and ETH reductions of 25, 50, 75 and 100%. A selection is described as "preferred among the evaluated candidates only; not a global optimum".
- **A static what-if:** it predicts no prices, guarantees nothing about liquidation, and an expected fill is not a guaranteed fill. Resting orders and TP/SL stops are listed, not simulated.
- **Terminology:**
  - Accounting: E_risk, E_total, MM, buffer, target.
  - The method: scenario (fixed absolute prices), candidate, guard.
  - Run outcomes: `GOAL_MET`, `EVIDENCE_MISMATCH`, `BASELINE_CHANGED`.
  - Milestone verdicts: `GO`, `NO_GO`, `BLOCKED_LIVE`.
- **Deferred:** public hosting, pushes, X posts, the DoraHacks submission, copy trading, keepers, Reactivity, House accounts, EIP-7702 and global optimisation. Never mainnet.
- **Security:** keys, mnemonics and signed transaction bytes never appear anywhere. The browser never holds a key.

## Brand Commitments

- The name is Margin Rescue. The repository stays `proving-ground-dreamdex`, with no rename.
- dreamDEX and Somnia are third parties. Margin Rescue is an independent tool built on dreamDEX; the footer says it is not affiliated with or endorsed by dreamDEX or Somnia.
- Visual language (standing preference, user requests 2026-10-27): in dreamDEX's dark, computational family, never a replica of dreamDEX's own site. Margin Rescue keeps its own identity (warm graphite, rescue orange, Martian Mono headlines in sentence case, the margin-meter mark); dreamDEX's periwinkle appears only where dreamDEX is named.
- Co-branding (user request 2026-10-27): a "built on dreamDEX" lockup beside the Margin Rescue name, using dreamDEX's official logo file from its published brand assets, unmodified, off-white on dark, with clear space of 0.3x the mark height. The site names the specific dreamDEX components it uses and never copies dreamDEX's copy.
- Voice: precise, sober, evidence-first. Every number carries its source (fixture, fork or live) and its block. No hype, and no promises about profit or safety.
- The Feedback workflow's materials belong to a separate project and are never used here. That covers `assets/branding/dreamdex-feedback-logo-*`, `feedback-submission/` and `submission-draft/`.

## Evidence on Hand

- **Live, read-only:**
  - Real accounts with 3, 6, 9 and 21 markets reconcile `EXACT` against the bank.
  - A rounding study at block 33516436 rebuilds 7,700 of 7,700 holders exactly with floor rounding.
  - A real 6-market account analysis is in `evidence/margin-rescue/live-read-only/analysis-0x2E3631D9`.
- **Fork:**
  - An end-to-end run at block 33472615 selected ETH-50. 0.8165 ETH filled inside the limit, the recomputed buffer equals the forecast, and the outcome is `GOAL_MET`.
  - Eleven rehearsal scenarios at block 33472615 (the happy run also read back by the independent verifier, 93/93 checks), plus funding drift at block 33609475: 12/12.
  - Forge fork tests pass 38/38, with traces.
- **Fixture:** 260/260 unit tests, 9/9 Solidity mock tests, and a clean typecheck.
- **Live write:** live run 1, 2026-10-28, `VERIFIED_COMPLETE`. The authorized plan `7f090328…3d1175` (`mr-live-plan/4`) ran once on the project's test account, signed in the owner's terminal. Execution `COMPLETE`: 13 transactions, all successful. Rescue goal `GOAL_MET`: one guarded reduction (BTC-50, 0.00062 BTC at 81,180.8), and the buffer at the fixed scenario prices rose from 40.538097 to 46.785772 USDso against a 45 USDso target. Cleanup verified. The independent read-back holds 93/93 checks. Evidence: `evidence/margin-rescue/live-write/run-1/`. Every view shows the run's state from the run-state model, and only this evidence; live transaction hashes, fills or results are never invented.
- **Market research:** an indexer scan on 2026-10-26 found 1,203 of 7,677 accounts (about 15.7%) holding two or more markets. The scan was paged, not atomic.
- **Absent:** no testimonials, users, partners or press exist. None may be implied.

## Product Principles

1. **Prove, don't claim.** Every figure leads to its evidence and its block.
2. **Read-only by default.** The browser never signs. Execution is a reviewed plan that the owner approves and runs.
3. **Honest status.** Fixture, fork and live labels appear everywhere, and pending is shown as pending.
4. **One account, every market.** No leg, order or stop is left out of the arithmetic.
5. **A fixed scenario.** Results are recomputed at the original absolute prices, never re-shocked from new prices.
