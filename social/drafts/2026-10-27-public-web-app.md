# X post package: Margin Rescue's public web app

Prepared 2026-10-27 (America/New_York). Status: published by the user at 11:44 EDT on 2026-10-27; read back on X. Permalink: https://x.com/Mrooo03/status/2115107366480035978. The user publishes it themselves; the assistant does not post.

## Post

Published wording below: 254 of 280 X-weighted characters for the text and product URL (URL counted as 23), excluding the quoted first post. Full text and the `@DreamDEXSomnia` mention were confirmed in X's post body.

```text
Margin Rescue is online for @DreamDEXSomnia testnet perps traders.

Set a joint BTC/ETH move. Compare position cuts, estimated costs and the margin buffer under that scenario.

Read-only analysis. Execution demos use local forks.

https://a252937166.github.io/proving-ground-dreamdex/
```

- Product: Margin Rescue.
- Intended users: dreamDEX perps traders on Somnia's Hideki testnet (chain 50383), whose accounts are cross-margin.
- Concrete benefit: for a chosen joint BTC/ETH move, compare evaluated position cuts, estimated execution costs and the resulting scenario margin buffer.

## Link

https://a252937166.github.io/proving-ground-dreamdex/ is the public, read-only site, deployed by GitHub Pages from `main` at `5f84545` (workflow run 40529576250: typecheck, unit tests, build and deploy all passed). Checked on 2026-10-27 through the public URL:

- All seven pages and every internal link answer 200 over HTTPS, at 1440 and 390 px wide, with no failed requests, script errors, broken fonts or images, or horizontal scrolling.
- Live data runs in the browser against the public Hideki RPC and indexer: the ticker and dashboard show current BTC-PERP and ETH-PERP marks; an analysis of the 6-market example account finished in 13.8 s at block 34,623,885 and reconciled EXACT with the bank.
- The recorded runs read the evidence in the repository; Live run 1 shows "Not run yet".
- A fetch from outside this machine returned the page title, headline, navigation, the "Read-only; nothing is signed" text and the evidence feed for commit `5f84545`.

## Images

Both are actual captures of the public site at `5f84545`, taken on 2026-10-27; not mockups.

1. Primary: [margin-rescue-compare-2026-10-27.png](../assets/margin-rescue-compare-2026-10-27.png) (2560 × 1740). The "Compare reductions" screen, labelled "Live, read-only".

   Suggested alt text: "Margin Rescue web app, Compare reductions screen, labelled Live, read-only. A real 6-market dreamDEX testnet account is read at block 34,625,935 under BTC −20% and ETH −25%. With no action its margin buffer at those prices is −107.50 USDso. A table lists each candidate position cut with its order, cost now and buffer at the scenario; ETH −25% is marked Preferred as the smallest evaluated cut that keeps the account above maintenance, with a 149.92 USDso buffer."

2. Optional second image: [margin-rescue-fork-run-2026-10-27.png](../assets/margin-rescue-fork-run-2026-10-27.png) (2560 × 1700). The "Actual result" screen with its fork labels visible.

   Suggested alt text: "Margin Rescue web app, Actual result screen. Live run 1 on Somnia Hideki is marked Not run yet; the two other runs are marked Recorded on a fork. Shown: a real 6-market account on a local fork of Somnia Hideki at block 33,472,615, scenario BTC −8% and ETH −12%. The guarded ETH −50% reduction filled 0.8165 ETH inside its limit; recomputed from the fills, the buffer at the scenario went from −262.05 to 6.48 USDso. Goal met."

## Claim check

- The browser performs the analysis, read-only: on the public site the reads and calculations run in the visitor's browser; nothing asks for a key or signs.
- Executions shown are recorded on local forks of Somnia Hideki. No live Tokyo order is claimed: `evidence/margin-rescue/live-write/` has no run, and the post does not mention one.
- The published wording says "margin buffer under that scenario" rather than promising to keep an account above maintenance. Each candidate is evaluated at the selected scenario prices, among a finite set of candidates, not a global optimum. No liquidation guarantee, profit claim or safety promise.
- The primary image's figures come from a live read at block 34,625,935 and will differ on a later read; the image is labelled with its block.

## Publication readback

- Canonical permalink: https://x.com/Mrooo03/status/2115107366480035978 (user supplied it with `?s=20`).
- X shows 11:44 AM on Oct 27, 2026 in America/New_York.
- Read back the full wording above, the @DreamDEXSomnia mention, the displayed GitHub Pages product link, and the attached Compare reductions screenshot matching the primary image above. Confirmed again through X's public embed data: the downloaded attachment matches `margin-rescue-compare-2026-10-27.png` apart from JPEG compression.
- The post quotes the first Margin Rescue introduction: https://x.com/Mrooo03/status/2115008447959925191.
- Recorded in [POST_LOG.md](../POST_LOG.md) and the README's X posts section. These local record updates are not a push, deployment or live-order milestone.
