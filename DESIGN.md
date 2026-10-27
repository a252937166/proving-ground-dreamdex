---
name: Margin Rescue
description: An independent cross-margin stress and rescue tool built on dreamDEX perps, in warm graphite with rescue orange and the margin meter.
colors:
  graphite-ground: "#0c0a09"
  graphite-surface: "#151210"
  graphite-raised: "#1e1a17"
  graphite-elevated: "#2a2420"
  graphite-well: "#100d0c"
  hairline: "#221d1a"
  hairline-strong: "#332c27"
  hairline-bright: "#4a413a"
  warm-ink: "#f6f1ec"
  warm-text: "#d9d1ca"
  warm-text-muted: "#b0a69d"
  warm-text-faint: "#8f857c"
  rescue-orange: "#ff6a1f"
  rescue-orange-lit: "#ff8240"
  rescue-orange-ink: "#ff9a63"
  on-rescue: "#160b04"
  rescue-wash: "rgb(255 106 31 / 0.12)"
  met-mint: "#00fa89"
  met-mint-ink: "#3ee69c"
  call-cherry: "#dc0b4a"
  call-cherry-ink: "#f0708f"
  pending-amber: "#f5b400"
  pending-amber-ink: "#ffc94a"
  dreamdex-periwinkle: "#6e6eed"
  dreamdex-periwinkle-ink: "#a8a8f4"
typography:
  display:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "clamp(34px, 3.5vw, 50px)"
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 87.5"
  headline:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "clamp(28px, 3.4vw, 44px)"
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 87.5"
  title:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 87.5"
  panel-title:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "14.5px"
    fontWeight: 650
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 87.5"
  subline:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.55
    fontVariation: "'wdth' 87.5"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  body-reading:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  figure:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 500
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.08em"
  button:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1
rounded:
  meter: "4px"
  chip: "6px"
  control: "8px"
  panel: "12px"
  window: "14px"
  console: "16px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 4vw, 48px)"
  container: "1240px"
  row-gap: "12px"
  panel-pad: "18px 20px 20px"
  section: "104px"
  section-mobile: "80px"
components:
  button-primary:
    backgroundColor: "{colors.rescue-orange}"
    textColor: "{colors.on-rescue}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.rescue-orange-lit}"
    textColor: "{colors.on-rescue}"
  button-secondary:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.warm-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.graphite-elevated}"
  badge-met:
    textColor: "{colors.met-mint-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
    height: "26px"
  badge-call:
    textColor: "{colors.call-cherry-ink}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
    height: "26px"
  badge-pending:
    textColor: "{colors.pending-amber-ink}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
    height: "26px"
  input-box:
    backgroundColor: "{colors.graphite-well}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "44px"
  panel:
    backgroundColor: "{colors.graphite-surface}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  tab-step-selected:
    backgroundColor: "{colors.rescue-orange}"
    textColor: "{colors.on-rescue}"
    rounded: "{rounded.chip}"
    size: "22px"
  margin-meter-track:
    backgroundColor: "{colors.graphite-raised}"
    rounded: "{rounded.meter}"
    height: "12px"
  nav-action:
    backgroundColor: "{colors.rescue-orange}"
    textColor: "{colors.on-rescue}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
---

# Design System: Margin Rescue

## Overview

**Creative North Star: "The Margin Meter"**

Margin Rescue is a third-party tool that stands openly on dreamDEX. It lives in the venue's dark, computational family, but it is not a replica: the ground is warm graphite, not the venue's neutral black. The one loud colour is rescue orange, not dreamDEX periwinkle. The headlines are Martian Mono, narrowed to 87.5% width and set in sentence case. Every surface is organised around a single instrument, the margin meter: a fill measured against a dashed maintenance line. The meter is the mark in the header. It is the underline under the hero's highlighted phrase, the section opener, the console's health bar, the App's before-and-after rows and the closing meter, which shows the fork run's real before and after. When a screen needs a picture, it draws that line again.

The system has three modes, and they share one world. **Persuade** (Overview, Features) is spacious: 104px sections, a dot-grid and a faint orange glow behind the hero and the close, word-rise headlines and replayed evidence. **Operate** (App, Dashboard) is dense: 13–14px rows, tabular figures, hairline-ringed panels on a framed header bar and an order-entry panel on the right. **Read** (Technology, Guide) is calm: Geist at 16px in a column of about 68 characters, a sticky sidebar with an orange indicator, and code and tables in graphite wells. Everything moves toward a finished state that already exists in the HTML. Motion explains what happens to the money, and every motion has a reduced-motion path.

dreamDEX appears only through its own unmodified logo, in "built on" lockups, and through periwinkle where dreamDEX components are named. The footer states that the project is independent.

**Key Characteristics:**
- Warm graphite ground with tonal surface steps and 1px inset hairline rings instead of borders.
- Rescue orange for actions, the highlighted phrase, the mark and the current selection; mint, cherry and amber carry state.
- Martian Mono at 87.5% width for headlines, titles, labels and buttons; Geist for reading; Geist Mono for figures, hashes and commands.
- The margin meter (a fill against a dashed maintenance line) is the recurring motif at every scale.
- Every figure carries its provenance (fixture, fork, live) as a label or badge.

## Colors

The palette is a warm near-black ladder lit by one hot orange, with three state colours and a guest periwinkle that belongs to dreamDEX.

### Primary
- **Rescue Orange** (rescue-orange): the primary button and the header's "Open app" action. Also the orange words in the hero and closing headlines, with their fill bar; the fill in the mark; and current-position indicators: the current nav underline, the selected App tab's step chip and tab ink, the active walkthrough step's rail, the preferred candidate chip, the sidebar indicator, the reading-progress bar and the passed step rails.
- **Rescue Orange Lit** (rescue-orange-lit): the hover state of orange actions only.
- **Rescue Orange Ink** (rescue-orange-ink): orange as text and focus: focus rings, console status text, step numbers and link hovers. Wherever orange must be read as type, it uses this lighter step for contrast.
- **On Rescue** (on-rescue): text and icons on an orange fill.
- **Rescue Wash** (rescue-wash): a 12% orange tint. It marks the chosen candidate row, the hot console leg, the "ours" layer of the built-on stack, the selected run option, info badges and orange callouts.

### Secondary (state)
- **Met Mint** (met-mint) with **Met Mint Ink** (met-mint-ink) for text: GOAL_MET, met badges, positive buffers, the meter fill once it clears the line, bids, passed checks and completed console stages.
- **Call Cherry** (call-cherry) with **Call Cherry Ink** (call-cherry-ink) for text: margin calls, negative buffers in parentheses, shock moves, asks, sell sides and refused input.
- **Pending Amber** (pending-amber) with **Pending Amber Ink** (pending-amber-ink) for text: the pending live run, blockers and warning callouts.

### Tertiary (guest)
- **dreamDEX Periwinkle** (dreamdex-periwinkle) and **dreamDEX Periwinkle Ink** (dreamdex-periwinkle-ink): only on the built-on stack's dreamDEX layers (the layer swatch and the component code names).

### Neutral
- **Graphite Ground** (graphite-ground): the page and the reading column.
- **Graphite Surface** (graphite-surface): panels, windows, proof cards, chips and the framed header bar on the Operate and Read pages.
- **Graphite Raised** (graphite-raised) and **Graphite Elevated** (graphite-elevated): meter tracks, secondary buttons, facts cells and hover fills.
- **Graphite Well** (graphite-well): sunken areas such as inputs, the verdict box, market cards, the order ladder and run options.
- **Hairline** (hairline), **Hairline Strong** (hairline-strong) and **Hairline Bright** (hairline-bright): row dividers, panel rings and hover rings, from quietest to brightest.
- **Warm Ink** (warm-ink): headlines, figures and the dashed maintenance line. **Warm Text** (warm-text): body copy. **Warm Text Muted** (warm-text-muted): secondary copy. **Warm Text Faint** (warm-text-faint): captions, table headers and axis labels.

### Named Rules
**The Orange Means Act Rule.** Rescue orange is for things to press, the phrase that matters, the mark, and where you are now. It never reports a state: met, call and pending always use mint, cherry and amber.

**The Guest Colour Rule.** Periwinkle appears only where dreamDEX itself is named. Margin Rescue's own components never wear it.

**The Ink-Step Rule.** Each accent comes in two steps: a fill step (for bars, swatches and buttons) and a lighter ink step for text on graphite. Coloured type always uses the ink step.

## Typography

**Display Font:** Martian Mono (fallback: ui-monospace, SFMono-Regular, Menlo), self-hosted as a variable font with weight 100–800 and width 75–112.5%.
**Body Font:** Geist (fallback: ui-sans-serif, system-ui).
**Label/Mono Font:** Geist Mono for figures, hashes, addresses and commands.

**Character:** a narrowed, engineered monospace speaks for the product in sentence case, while Geist, the ecosystem's reading face, carries the explanation. Numbers are always tabular.

### Hierarchy
- **Display** (700, clamp(34px, 3.5vw, 50px), 1.16, 87.5% width): the hero H1 on Overview, larger on Features (up to 60px). Its highlighted phrase is orange with a fill bar underneath and a dashed tick through it.
- **Headline** (700, clamp(28px, 3.4vw, 44px), 1.16, 87.5% width): section titles. The closing headlines use a larger step of up to 58px.
- **Title** (650, 21px, 1.3, 87.5% width): the Read pages' H2s and walkthrough step titles (20–25px). The App H1 sits at 26px and panel titles at 14.5px.
- **Subline** (Martian Mono 500, 14px, 87.5% width, muted): the one-line mono summary directly under a headline.
- **Body** (Geist 400, 15px, 1.6): general copy. Ledes run at 16.5–17px with a 54–66ch measure. **Reading body** is 16px with a line height of 1.7 and a maximum of 68ch.
- **Figure** (Geist Mono 500, 12–13.5px, tabular): hashes, marks, PnL and commands. Large readouts go up to 18px. The dashboard mark price is Geist 600 at 30px with tabular figures.
- **Label** (Martian Mono 600, 11–12px, tracked 0.06–0.1em, uppercase): footer column titles, sidebar group labels, the ticker tag, provenance labels on proof cards and stack-layer owners. Uppercase lives only at this size.

### Named Rules
**The Sentence Case Rule.** Headlines, titles and buttons are in sentence case. Uppercase is reserved for 11–12px tracked labels, and lowercase-only voice is dreamDEX's, not ours.

**The Tabular Rule.** Every figure that can change or be compared uses tabular numerals, and negatives print in parentheses.

## Layout

The content container is 1240px wide. The gutter is clamp(16px, 4vw, 48px), and the header and ticker align to a computed edge, so full-bleed bands line up with the content. Persuade sections are 104px tall top and bottom (80px on mobile) and are built on asymmetric two-column grids (5/7, 7/5, 5/6, 4/7) with a clamp(32px, 5vw, 80px) gap. These grids collapse to one column below 1080px. The walkthrough is a sticky window on the left with scrolling steps on the right, and it becomes a stacked list below 1080px. The proof track pins and scrolls sideways on wide screens and falls back to a grid elsewhere.

Operate pages use a 12px rhythm: panels stack 12px apart. On screen 1, a 340px sticky order-entry panel sits on the right and moves above the output below 1100px. Figures sit in 1px-gap grids on a hairline background (four or five across, then two, then one). The header becomes a framed, rounded bar inset by 6px.

Read pages use a 236px sticky sidebar, a 64px gap and a main column of up to 780px whose text is capped at 68ch. Below 980px the sidebar collapses into a disclosure above the article.

## Elevation & Depth

Depth comes from tone and hairlines, not lift. Surfaces step up from ground to surface, raised and elevated. Panels are drawn with a 1px inset ring (`box-shadow: inset 0 0 0 1px`), never a border, and a ring brightens a step on hover. Real shadows belong only to the few floating showpieces (the lifecycle console, the walkthrough and demo windows, the distribution figure) and to overlays (the mobile menu, tooltips and the scrolled framed header). Persuade backgrounds may carry a faint dot grid and a soft orange radial glow; the Operate and Read pages carry neither.

### Shadow Vocabulary
- **Showpiece drop** (`box-shadow: inset 0 0 0 1px #332c27, 0 40px 80px -36px rgb(0 0 0 / 0.9)`): the console and the distribution figure. Windows use `0 32px 64px -32px`.
- **Overlay** (`box-shadow: 0 0 0 1px #332c27, 0 24px 48px -16px rgb(0 0 0 / 0.8)`): the mobile menu. The tooltip uses `0 14px 28px -10px`.
- **Focus glow** (`box-shadow: inset 0 0 0 1px #ff6a1f, 0 0 0 4px rgb(255 106 31 / 0.18)`): the hero's input field on focus.

### Named Rules
**The Hairline Rule.** Containers are drawn with inset 1px rings in hairline tones. A border is used only for a divider between rows or bands.

## Shapes

Corners are gently rounded and scale with the size of the container: 4px for meter tracks and bars, 6px for chips and step tiles, 8px for controls and inputs, 12px for panels, 14px for windows and proof cards, and 16px for the console. Badges, pills and the switch are fully round. Diverging bars sit on a zero axis and are rounded only on their outer end. The dashed 2px warm-ink line is the one recurring piece of non-rectangular geometry: it is the maintenance line, and it also marks zero on the position-flip demo. The mark is a 32px rounded tile with a two-tone bar crossed by that dashed line.

## Components

### Buttons
- **Shape:** gently rounded (8px), 44px tall (34px in the small size, 46–50px in forms).
- **Primary:** rescue orange with on-rescue text, Martian Mono 14px/600. A trailing arrow icon nudges 3px right on hover.
- **Hover / Focus:** the fill lightens to rescue-orange-lit and the button scales to 0.98 when pressed. Focus is a 2px rescue-orange-ink outline with a 3px offset.
- **Secondary:** a raised graphite fill with a strong hairline ring and ink text, lifting to elevated on hover.
- **Busy:** a light sheen sweeps across the button while an analysis runs.

### Badges and chips
- **Badges:** pills with a Martian Mono 11.5px/600 label. Each state is a 4–12% tint, a 30–42% inset ring and ink-step text: met (mint), call (cherry), pending (amber), info (orange wash). Badges always pair an icon or ping with the word.
- **Chips:** 6–8px rounded tiles on a surface with a hairline ring. Candidate chips in the console go idle, checking (orange ring), fails (cherry), meets (mint) or preferred (solid orange).

### Panels and windows
- **Corner Style:** 12px panels, 14px windows.
- **Background:** graphite-surface. Sunken sub-areas use graphite-well.
- **Shadow Strategy:** an inset hairline ring only (see Elevation); windows add the showpiece drop.
- **Internal Padding:** 18px 20px 20px for panels (16px 14px on mobile). A window has a 46px title bar with a Geist Mono title and tabs whose selected tab carries a 2px orange underline.

### Inputs / Fields
- **Style:** a 44px well-coloured box with an 8px radius and a strong hairline ring. The label sits above in Geist 12.5px muted text. Account addresses are set in Geist Mono and the caret is orange.
- **Focus:** a rescue-orange-ink ring plus a 3px orange glow at 25%.
- **Error:** a cherry-ink ring and cherry-ink message text beneath. Presets are small pressed toggles that take the orange wash when active.

### Navigation
- **Header:** the mark and "Margin Rescue" in Martian Mono, a hairline divider, then the built-on lockup. Nav links are sentence-case Geist 14.5px; the current page gets a 2px orange underline, and "Open app" is an orange action. Persuade headers are transparent until scrolled, then blur over 88% ground. Operate and Read headers are a framed surface bar. Below 920px the nav becomes a menu that opens with a clip-path reveal. The built-on lockup hides below 1180px.
- **Tabs (App):** three screens with numbered 22px step tiles. The selected tile is solid orange, and an orange ink bar slides under the selected tab.
- **Sidebar (Read):** Martian Mono group labels, links in Geist 13.5px and an orange-washed indicator with a 2px orange edge that follows the section being read.

### Built-on lockup
The official dreamDEX logo file, unmodified, in off-white #F0F0F0 on dark, with clear space of at least 0.3x the mark height on every side (margins of 6px at 20px and 7px at 22px). It sits after the words "built on" and is used only in built-on lockups: 20px in the header, 22px in the footer, 15px under the hero, 13px in the stack join and 30px in the Built-on panel. It is never recoloured, outlined, stretched or given effects.

### The margin meter (signature)
A 12–18px raised track with a hairline ring. Its fill (scaleX from the left) is muted at rest, cherry when equity sits under the maintenance line and mint above it. The line is an absolutely positioned 2px dashed warm-ink rule. In the App, rows read "Before" and "From the fills" with the value on the right. The fill and the line travel from an armed state to their values over 1.1s. On the close, scrolling moves the fill and the line from the fork run's before (209.81 against 471.87) to its after (436.73 against 430.25). A key below always labels "health equity" and "maintenance".

### Diverging bars and the ladder
Candidate and PnL bars grow from a centre zero axis: mint to the right, cherry to the left, 10px tall, staggered 50–60ms. In the dashboard's order ladder, depth bars (cherry 16% for asks, mint 10% for bids) travel between reads. The mark price flashes in mint or cherry on each tick, and the touched row flashes orange.

### Motion grammar
- Two word-rise headlines only, the hero and the close: words rise out of their line box (1s, staggered 70ms). Section titles take an 8px, 0.6s rise; other content reveals 16px over 0.8s.
- The lifecycle console's 16s replay starts 1.5s after its entrance. Later loops reset behind a fade, and the status-line caret is its only blink.
- Scroll-driven pieces (the walkthrough, the pinned proof track and the closing meter) follow the reader's scroll rather than a clock.
- Feature demos play once when seen and offer a Replay button.
- In the app: count-ups, meters travelling from armed, depth bars travelling between reads and tick flashes.
- Easing is `cubic-bezier(0.16, 1, 0.3, 1)`; `cubic-bezier(0.65, 0, 0.35, 1)` is used for travel.
- Self-running loops pause when off-screen or when the tab is hidden. The ticker, the console, the Technology pipeline and the Features guard demo carry pause buttons; a pause button's icon follows its own `aria-pressed` state.
- Under reduced motion, the HTML's finished state is shown.

## Do's and Don'ts

### Do:
- **Do** draw any new risk or health visual as the margin meter: a fill against the 2px dashed warm-ink maintenance line, cherry below and mint above.
- **Do** give every figure its provenance (fixture, fork or live) and its block, and print negatives in parentheses with tabular numerals.
- **Do** set headlines and titles in Martian Mono at 87.5% width, in sentence case; set reading text in Geist and hashes or commands in Geist Mono.
- **Do** draw containers with inset 1px hairline rings on tonal graphite steps.
- **Do** place the dreamDEX logo only in "built on" lockups: unmodified, off-white on dark, with 0.3x clear space, at 20px in the header and 22px in the footer.
- **Do** give every new self-running animation a reduced-motion path that shows the finished state, and a pause control if it loops.

### Don't:
- **Don't** use rescue orange to report state; met, call and pending are mint, cherry and amber.
- **Don't** use dreamDEX periwinkle on Margin Rescue's own components or anywhere dreamDEX is not named.
- **Don't** recolour, outline, stretch or add effects to the dreamDEX logo, or use it outside a built-on lockup.
- **Don't** replicate dreamDEX's own site: its typefaces, its pixel steps or its lowercase voice.
- **Don't** set headlines in uppercase; uppercase is for 11–12px tracked labels only.
- **Don't** add a third word-rise headline or a second blinking element; the hero and the close own word-rise, and the console caret owns the blink.
