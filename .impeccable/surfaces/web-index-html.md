---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/features.html"]
---

# Surface brief: Overview and Features

Scope: the website's Persuade pages, Overview (`/`, web/index.html) and Features (`/features`, web/features.html). Mode: Persuade.

Audience: reviewers of the DoraHacks dreamDEX perps bounty first; multi-market dreamDEX traders second.
Action: analyze an account in the working form (account, BTC move, ETH move, target, opening /app with those values), or open the app.
Proof on the page: the fork end-to-end run at block 33,472,615 (real 6-market account: buffer 527.10 at the reference marks, (262.05) under BTC −8% / ETH −12%; ETH −50% filled 0.8165 ETH inside the limit; recomputed from fills 6.48, GOAL_MET); the dreamDEX components the tool is built on (markets SDK 0.32.1, OperatorPermissionsRegistry, perps pools and placeOrderFor, MarginBank, stop registry and indexer, Hideki chain 50383); the indexer scan of 7,677 accounts by markets held; 12 fork scenarios; 260 / 9 / 38 tests; live reconciliations EXACT; 7,700 / 7,700 rounding study; live run 1 pending under plan 7f090328… (`BLOCKED_SIGNER`; its state comes from the run-state model in /api/proof and is shown as verified only after the independent read-back; never invented).
Constraints: PRODUCT.md (fixture / fork / live labels on every figure, no hype). User direction 2026-10-27: in line with dreamDEX's aesthetic but never a replica; highlight the dreamDEX technologies used; a co-branded logo. dreamDEX's official logo is placed unmodified (off-white on dark, clear space 0.3x mark height) only in "built on" lockups; the footer states independence. Self-hosted fonts.
Memorable moment: the lifecycle console replays the real rescue: the shock drops equity under the dashed maintenance line, the candidates race, the guarded sell fills twice, and the buffer climbs back to +6.48.
Unresolved: live run 1 figures stay pending until its evidence exists.

## Direction contract

THESIS: Margin Rescue is a third-party tool that stands openly on dreamDEX: the venue's dark, computational family, but its own identity. A co-branded lockup and a "built on dreamDEX" stack say exactly which venue components it uses, and the page replays the real rescue instead of describing it. Refuses a replica of dreamDEX's own site (its type, palette, pixel steps, lowercase voice) and a generic crypto landing.

OWN-WORLD: Warm graphite (#0c0a09, #151210, #1e1a17; lines #332c27) with rescue orange #ff6a1f only for actions, the hero's and the close's highlighted phrase, and our mark; mint for met, cherry for calls, amber for pending; dreamDEX periwinkle only where dreamDEX is named. Martian Mono 650–700 at 87.5% width for headlines and labels, in sentence case; Geist for reading, the ecosystem tie; Geist Mono for figures. Motif: the margin meter, a fill crossing a dashed maintenance line.

STORY: A reviewer sees at once that this is an independent tool built on dreamDEX, watches a real 6-market account replayed through the whole loop, reads the stack of dreamDEX components it uses, checks where each claim was proven, then pastes an account or opens the app.

FIRST VIEWPORT: Header: our mark and "Margin Rescue", a divider, "built on" with dreamDEX's logo, sentence-case nav, orange "Open app"; a live BTC/ETH-PERP ticker beneath, tagged "Live · Hideki". Left half: H1 "Know the call before the market sends it." with "the call" in orange over its fill bar, a muted mono subline, one paragraph, the working analyze form, a "built on dreamDEX" line. Right half: the rescue lifecycle console replaying the fork evidence, its badge turning from margin call to call met. Signature interaction: the 16 s replay loop; reduced motion shows the final state.

FORM: user-pinned twice on 2026-10-27 ("more in line with the dreamDEX aesthetic", then "not an exact replica; highlight the dreamDEX technologies used; a co-branded logo"), overriding this surface's direction roll; dreamDEX's family with Margin Rescue's own identity and an explicit co-brand. seed:c86d60faa0ebf461

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
