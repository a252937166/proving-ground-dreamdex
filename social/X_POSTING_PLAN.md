# Margin Rescue: X posting plan

Prepared: 2026-10-27. Dates and daily delivery time use America/New_York.

## Purpose and current status

Build an understandable public record while the product is being built. Every post should tell a trader one useful thing and, where possible, show the evidence. The submission requirement supplied by the user is 2 or 3 real posts about the MVP, each tagging @DreamDEXSomnia, with their published links in the README. Daily posting is our plan; it is not an additional official requirement.

As checked on 2026-10-27, Margin Rescue has independent reconciliation, fixed-price scenarios, candidate comparisons, a reduce-only guard and actual-fill recomputation. The validated execution evidence is from local forks. The live-write evidence directory has no completed run. The read-only website is publicly deployed on GitHub Pages at https://a252937166.github.io/proving-ground-dreamdex/; the public example account reconciled EXACT in a browser check at block 34,634,624 (13.3 s).

The user has published two posts on 2026-10-27: https://x.com/Mrooo03/status/2115008447959925191 (product introduction, 05:11 EDT) and https://x.com/Mrooo03/status/2115107366480035978 (public web app, 11:44 EDT, quoting the first). Both were read back in full: text, @DreamDEXSomnia mention, link and attached image, each image matching its capture in `social/assets/`. Both are recorded in POST_LOG.md and the README. The user confirmed: provide the content; the user publishes it themselves. Do not post, schedule posts on X, or ask again about publishing on their behalf. The daily automation prepares the package only.

Editorial correction (2026-10-27): lead with the current product, its intended users, one useful feature and its value. Every daily package needs a relevant actual product image and a real project/product link, with its public availability checked. Development and test results support the story; they are not the product introduction.

Public-link gap resolved (2026-10-27): https://github.com/a252937166/proving-ground-dreamdex now has public `main` at `5f84545`, including Margin Rescue and the static website deployment. The repository description and homepage point to the current product. Use https://a252937166.github.io/proving-ground-dreamdex/ as the public product entry point; recheck current availability before future posts. Never advertise a localhost URL as a publicly usable product.

## Daily topics

The working daily delivery time is 18:00 America/New_York, through November 1. Each day gets one distinct product angle, supported by verified evidence, a real image and a checked link. Deliver the content to the user; the user decides when to publish it. If a milestone completes earlier, prepare its verified update then.

| Date | Topic | Useful attachment | Publication condition |
| --- | --- | --- | --- |
| Oct 27 | Introduce Margin Rescue: how reducing the wrong leg can worsen a chosen stress scenario | Verified local comparison or clearly labelled fork output | Today's draft is ready; recheck current status before posting |
| Oct 28 | Partial fills: half the requested reduction filled and the target remained unmet | Partial-fill result showing the actual fill and 43.67 USDso buffer versus the 45 target | Existing fork evidence; label it local fork |
| Oct 29 | Execution guard: exact expected position and no flip or growth | A small readable diagram or a verified guard test/result | Describe the tested contract behavior and its fork scope; no guarantee about profitability or liquidation |
| Oct 30 | Show the account → scenario → candidate comparison flow | A short capture of the working Margin Rescue UI | Verify the actual page first; state local preview if it is local. If it is not ready, use another verified result instead |
| Oct 31 | First verified live Tokyo reduction and actual-fill recomputation | Actual transaction link, before/after result and cleanup status | Only after real live evidence exists. Otherwise publish an honest progress update; no invented trade or date commitment |
| Nov 1 | Final demo and how to reproduce the MVP | Public code/demo links that actually work | Check public accessibility and live-order evidence; select the strongest 2–3 published posts for the README |

## Ready-to-use drafts

### 1. Published: product introduction, image and project link

236 X-weighted characters (266 literal characters; the URL counts as 23). See [the historical draft](drafts/2026-10-27.md) for the screenshot and checks made at preparation time. The user published this introduction as the first post; the repository and public website were subsequently updated at `5f84545`. The second published post's final wording and screenshot are in [the public web app package](drafts/2026-10-27-public-web-app.md).

```text
Meet Margin Rescue for @DreamDEXSomnia perps traders.

Stress-test joint BTC/ETH moves, compare position cuts and costs, and review a recorded fork execution.

See which cut improves your margin buffer.

Project: https://github.com/a252937166/proving-ground-dreamdex
```

Attach [the actual product overview screenshot](assets/margin-rescue-overview-2026-10-27.png). The recorded result in it is labelled fork evidence. An optional second image is [the application's recorded-result screen](assets/margin-rescue-result-2026-10-27.png).

### 2. Partial fill: a concrete verified result

Product angle: the results screen shows whether the actual reduction met the user's target, including when only part fills. Evidence: [the partial-fill outcome](../evidence/margin-rescue/fork/rehearsal-33472615/partial-fill/outcome.json) and [its recomputation](../evidence/margin-rescue/fork/rehearsal-33472615/partial-fill/recompute.json). This is a template: replace the URL with a checked current public entry point and attach the corresponding actual result screenshot before giving it to the user as ready to post.

```text
Margin Rescue helps @DreamDEXSomnia traders check the result of a position cut. Our recorded fork example filled only half: the stress buffer reached 43.67 USDso against a 45 target. The app shows the missed target and actual fill together.
[CHECKED PUBLIC URL]
```

### 3. Guard: an available technical update

Product angle: understand what protects a confirmed reduction when the account changes. Evidence: [the runbook](../MARGIN_RESCUE.md) and [the fork test log](../evidence/margin-rescue/fork/forge-fork-tests.txt). Supply a verified feature-page image and checked URL; recalculate length after editing.

```text
Margin Rescue for @DreamDEXSomnia traders: compare a cut, confirm its size and price limit, and review what the guarded order did. The guard refuses a changed position or a trade that flips it. Browser preview; execution tested on local forks.
[CHECKED PUBLIC URL]
```

### 4. Live result: conditional template, not publishable yet

```text
Margin Rescue's first live Tokyo run on @DreamDEXSomnia: compared reductions, executed through the guard, then recomputed the same stress prices from actual fills.

Result: [ACTUAL GOAL STATUS]. Cleanup: [ACTUAL STATUS].
Tx: [VERIFIED EXPLORER URL]
```

Replace every placeholder from real `live-write/run-*/` evidence and verify the transaction on the public RPC/explorer. Include failures or incomplete cleanup truthfully. Recheck X's composed length after adding the URL; do not treat the template as a completed post or claim the live-order requirement is met.

## Publishing and link handling

1. Read the current code, public repository state, relevant evidence and [publication log](POST_LOG.md). Avoid repeating an already published angle.
2. Draft one English post introducing the current product or one user-facing feature, with the exact @DreamDEXSomnia tag. Include a real checked project/product URL and check the standard post length, counting URLs correctly. Do not deliver placeholders as ready-to-post content.
3. Include an actual product screenshot or short demo in every daily package. Save a downloadable local image and provide it with the text; label local/fork results visibly. Synthetic arithmetic is an example, not a real account or trade. Do not substitute a generic terminal image or an old Proving Ground screen for the current product.
4. Give the content, URL, image and any readiness limitation to the user. The user publishes it. Do not access their X account to publish or ask again about taking over posting.
5. When the user supplies a published link, read the public post to verify its text, tag and attachment; record the actual permalink and date in POST_LOG.md and the README's X posts section. Never infer publication from preparation.
6. For the final submission, choose 2–3 posts that together explain the trader problem, demonstrate a tested differentiator and show the actual Tokyo order workflow. All selected posts must be real and accessible; no compose links or fabricated URLs.

## Claims to avoid

- No liquidation guarantee, profit claim, hard loss cap or globally optimal reduction.
- No same-block guarantee, Reactivity integration or Somnia Agents bonus claim unless implemented and independently verified.
- No public deployment, current-code public repository, live transaction or product-user claim without current evidence.
- No private keys, recovery notes, signed raw transactions, personal email or unrelated Feedback material in text or attachments.
- A published post does not replace the real-order, README, code and submission requirements.
