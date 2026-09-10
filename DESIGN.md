---
name: JobSeeker Dashboard
description: A dark-first local instrument panel where every destination carries its own hue and every number is fixed-width.
colors:
  bg: "#0f1220"
  card: "#181c2f"
  line: "#2a2f48"
  fg: "#e7e9f3"
  mut: "#9aa0bd"
  instrument-blue: "#6ea8fe"
  bg-light: "#f7f5f0"
  card-light: "#fffdf9"
  line-light: "#e8e3d9"
  fg-light: "#1f1c17"
  mut-light: "#6b6355"
  instrument-blue-light: "#2f5fd0"
  good: "#3fb950"
  good-strong: "#2ea06e"
  warn: "#d68a00"
  warn-text: "#f0b357"
  bad: "#f85149"
  danger: "#d0224a"
typography:
  h1:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  metric:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    fontFeature: "tabular-nums"
  body:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  table:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.09em"
  micro:
    fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "6px"
  sm: "7px"
  md: "8px"
  lg: "9px"
  xl: "12px"
  xxl: "14px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "9px"
  md: "14px"
  lg: "18px"
  xl: "22px"
  gutter: "clamp(16px, 3.2vw, 40px)"
  maxw: "1480px"
components:
  button-primary:
    backgroundColor: "{colors.instrument-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "{colors.line}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-small:
    backgroundColor: "{colors.card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
  button-danger:
    backgroundColor: "#c0392b"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.instrument-blue}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  tab:
    backgroundColor: "oklch(0.255 0.055 var(--h))"
    textColor: "oklch(0.855 0.095 var(--h))"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  tab-active:
    backgroundColor: "oklch(0.470 0.120 var(--h))"
    textColor: "oklch(0.985 0.020 var(--h))"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  subpill:
    backgroundColor: "#1b1f33"
    textColor: "#b6bcd6"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  subpill-active:
    backgroundColor: "#2f3757"
    textColor: "#f2f4ff"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xl}"
    padding: "14px 18px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  pill-ok:
    backgroundColor: "rgba(46,160,67,.16)"
    textColor: "{colors.good}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  pill-warn:
    backgroundColor: "rgba(214,138,0,.16)"
    textColor: "{colors.warn}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  tag-lead:
    backgroundColor: "rgba(110,168,254,.16)"
    textColor: "{colors.instrument-blue}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  tag-application:
    backgroundColor: "rgba(46,160,67,.18)"
    textColor: "{colors.good}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  popover:
    backgroundColor: "{colors.card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xl}"
    padding: "14px"
  modal:
    backgroundColor: "{colors.card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xxl}"
    padding: "0 26px 26px"
---

# Design System: JobSeeker Dashboard

## Overview

**Creative North Star: "The Instrument Panel"**

This is a console read at a glance, once a morning, on a laptop that belongs to one person. It is dark
by default because that is the surface a lit instrument reads best against, and it is calm because
nothing on it should demand attention unless something is actually overdue. Every destination carries
its own hue, every number is fixed-width, and every state that matters — a lead versus an
application, a run in progress, an application that has gone quiet — is legible without opening
anything.

Colour here is a filing system, not decoration. The tab strip runs eight hues around the wheel, and
every colour derives from a single `--h` per tab, expressed in OKLCH rather than HSL because HSL
lightness is not perceptual: at one HSL stop the greens read far brighter than the blues, and two
tabs failed AA while their neighbours passed. One set of OKLCH lightness stops holds for all eight
hues across both themes, and the worst case across hue × theme × active/resting is now 5.85:1 against
a 4.50 bar. Colour is always an additional cue and never the only one — the active pill also carries
heavier weight, an inset ring, and `aria-selected`.

The whole interface is one dependency-free Node file with no framework, no build step, and no web
font. Density is the working constraint: a real dataset is tables of dozens of rows, so the system
prefers hairline dividers over boxes, tight radii, tabular figures, and a hard character measure on
every prose column. This is deliberately not enterprise ATS software — the grey chrome and
undifferentiated blue-link soup the product exists to escape — and deliberately not the AI-product
visual cliché: no sparkles, no glow orbs, no chat-bubble hero.

**Key Characteristics:**

- Dark-first (`#0f1220`) with a genuine warm-paper light theme (`#f7f5f0`), and a true three-state appearance control: Auto follows the OS, an explicit choice beats it in both directions.
- One hue per destination, derived in OKLCH from a single `--h` custom property.
- Tabular figures (`font-variant-numeric: tabular-nums`) on every number that will be compared.
- Hairline dividers (`1px solid var(--line)`) rather than boxed cells; cards are the exception, not the rule.
- Status carried by low-alpha tinted pills, never by full-saturation fills.
- Semantic colour reserved: amber for unfinished, green for confirmed, red for destructive only.

## Colors

Cool near-black instrument ground in dark; warm paper in light, sharing the site's own light tokens so
the app and the marketing site read as one family.

### Primary

- **Instrument Blue** (`#6ea8fe` dark / `#2f5fd0` light): the single interactive signal. Every link, every primary button, every focus ring, every "this is the control" border. It is also the `today` tab's hue (213), which is why Today reads as the landing destination.

### Secondary — the destination hues

Each tab owns one hue angle, spaced around the wheel so no two neighbours read alike. Only the angle
is declared; every colour is derived from it.

- **Today** (213, blue) · **Proposals** (187, teal) · **Pipeline** (152, green, echoing the interview status pill) · **People** (30, orange) · **Activity** (228 at 0.3 chroma — muted on purpose, because it is a log) · **Companies** (152) · **CV** (296, violet). Settings sub-pages reuse the same angles so the two pages read as one system.

### Tertiary — the semantic set

- **Amber** (`#d68a00`, text `#f0b357`): unfinished. A send on its way, a partial run, an overdue age, a company whose board has not been investigated. Always as a 10–16% alpha wash with a 3px inset left bar, never as a fill.
- **Green** (`#3fb950`, strong `#2ea06e`): confirmed. An application (as opposed to a lead), a healthy check, a newly found role.
- **Red** (`#f85149`, danger `#d0224a`, destructive `#c0392b`): only destruction and hard failure — the trash control, a stale overdue age, a failed flash, the confirm-modal's danger button.

### Neutral

- **Ground** (`#0f1220` / `#f7f5f0`): the page.
- **Card** (`#181c2f` / `#fffdf9`): panels, popovers, modals, sticky table headers.
- **Line** (`#2a2f48` / `#e8e3d9`): every divider, border, resting pill ground and toggle track.
- **Foreground** (`#e7e9f3` / `#1f1c17`) and **Muted** (`#9aa0bd` / `#6b6355`): text and secondary text.

### Named Rules

**The One Signal Rule.** Instrument Blue means interactive. It is never used for status, decoration, or emphasis — a status is a tinted pill, and emphasis is weight.

**The Derived Hue Rule.** A destination declares only `--h`. Every background, foreground and ring is `oklch(<stop> <chroma × --tab-c> var(--h))`, so a new destination is one line and both themes come for free. Never hand-write a second palette for the light theme.

**The Scalars-On-Root Rule.** Only lightness and chroma scalars live on `:root`. A `var()` inside a custom property declared on `:root` resolves *on* `:root`, where `--h` does not exist — which makes the whole token invalid and the pill transparent. The `oklch()` calls must sit in the rules where `--h` is in scope.

**The Never-Only-Colour Rule.** Colour is an additional cue. Every state that colour marks also carries weight, a ring, an icon, a word, or an ARIA attribute.

## Typography

**One face:** the system UI sans (`-apple-system`, Segoe UI, Roboto). No web font is loaded.
**Mono** (`ui-monospace`, SFMono-Regular, Menlo) appears only in digests, transcripts, tour step
counters and endpoint values — places where the characters are data rather than prose.

**Character:** Utilitarian and quiet. The type does no expressive work at all; the system's voice is
carried by colour, density and rhythm. Weight is the primary hierarchy device (400 → 550 → 600 → 650
→ 700), which is what lets a 13px table stay scannable without a size jump on every row.

### Hierarchy

- **H1** (700, 20px, `-0.01em`; 17px below 720px): the app title in the header.
- **H2** (700, 15–16px, `-0.01em`): section and panel headings.
- **Metric** (700, 26px, tabular): KPI and spend figures.
- **Body** (400, 14px, 1.5): the base.
- **Table** (13px, `9px 12px` cell padding): every data row.
- **Micro** (11–12.5px): hints, sub-labels, timestamps, counts. This is where most of the interface actually lives.
- **Label** (600, 11px, `0.09em`, uppercase, muted): block headings inside Today, modal sub-heads, and the advanced-disclosure summary.
- **Mono** (12px, 1.6): digests and transcripts.

### Named Rules

**The Tabular Figures Rule.** Any number a person will compare down a column — counts, percentages, ages, dates, spend — carries `font-variant-numeric: tabular-nums`. Digits that shift width between rows make a column impossible to scan.

**The Measure Rule.** Prose inside a data view is capped by a character measure: `74ch` for modal prose, `64ch` for a sub-line, `56ch` with a `30ch` floor for a clamped table cell. The floor is the important half — without it the browser starves a prose column into a one-word ribbon whenever a sibling column is longer.

**The Weight-Before-Size Rule.** Escalate weight before size. The interface is dense, and a size jump costs a row of vertical space on every screen it appears on.

## Layout

One shared gutter governs the entire page. `--gut: clamp(16px, 3.2vw, 40px)` and `--maxw: 1480px`
combine into `padding-inline: max(var(--gut), calc((100% - var(--maxw)) / 2))`, applied to the header,
the stat bar, the tab strip, `#panels` and the footer — so every band shares one left edge without a
wrapper element per block, and the content centres itself once the viewport passes the maximum.

The shell is header → sticky toolbar (stat bar + tab strip) → tab panel → footer. The toolbar is
sticky so the tab strip stays reachable while a long table scrolls. The tab strip itself scrolls
horizontally with its scrollbar hidden, and **Run now** is `position: sticky; right: 0` *inside* that
scroller with a background and a `-10px` shadow — a plain `margin-left: auto` would carry the primary
action off the side of a narrow screen.

Tables live inside a `.scroll` container with `overflow-x: auto`, a `12px` radius, a `--line` border
and a card ground; their `th` is sticky to the top of that scroller. Column behavior is explicit
where it has to be: dates never wrap (a date split as `2026-07-` / `13` is meaningless), the
Companies table is `table-layout: fixed` with percentage `<col>` widths because auto layout let a
200-character agent note push the actions column off the right edge, and that table then explicitly
overrides the global first-cell nowrap because its first cell carries a sentence.

Forms and grids are all `repeat(auto-fit, minmax(<200–300px>, 1fr))`. The single breakpoint is
`720px`, where the gutter drops to 16px, the header tightens, the stat bar sheds its spacer, and
Today's rows wrap; `600px` trims the modal.

## Elevation & Depth

Flat by default, lift on intent. Depth in the resting interface is tonal, not cast: three surface
steps (`--bg` → `--card` → `--line`) plus a single hairline border do all the structural work, and no
panel, card, table, pill or button carries a shadow at rest. Shadow appears only on things that are
genuinely floating above the page.

### Shadow Vocabulary

- **Popover** (`0 12px 32px rgba(0,0,0,.45)`): `.pop` — dismissal reasons, edits, the run menu. These are `position: fixed`, not absolute, because they open inside horizontally-scrolling tables where an absolutely-positioned child gets clipped; position is computed on open.
- **Busy bubble** (`0 14px 34px rgba(0,0,0,.34)`): the smaller "why did nothing happen?" balloon.
- **Tour bubble** (`0 18px 44px -16px rgba(0,0,0,.55)`): the coach mark.
- **Flash** (`0 6px 24px rgba(0,0,0,.35)`): the transient top-centre toast.
- **Spotlight** (`0 0 0 4px var(--acc), 0 0 0 9999px rgba(8,10,20,.55)`): the tour's ring — a ring drawn *around* the target with a huge second spread rather than a hole punched through a veil, so it is one element, needs no `clip-path`, and survives the target moving or resizing.

### Named Rules

**The Inset Bar Rule.** A row or block that needs a state edge gets `box-shadow: inset 3px 0 0 <semantic colour>` plus a 6–16% alpha wash — never a cast shadow and never a full-saturation background. This is how overdue rows, warning alerts, pending rows and impact notices are all marked.

**The Ring, Not Fill Rule.** Hover and focus on a pill are an *inset* 1px ring in the pill's own derived hue. A hover that changes fill makes a resting pill and a hovered pill look like two different states of the data.

## Shapes

A tight, consistently small radius family — this is a dense information surface, and a large radius
costs usable width in every cell it touches. `6px` for micro-controls, `7px` for small buttons and
inputs inside popovers, `8px` for standard buttons, inputs and the gear/appearance controls, `9px`
for alerts and person cards, `12px` for cards, panels, popovers and table containers, `14px` for
modals, and `999px` for anything that classifies rather than contains — tabs, sub-pills, status pills,
kind tags, chips, filter buttons, toggle tracks.

Borders are a single hairline in `--line`. Interactive elements shift the border to `--acc` on hover
or focus-within rather than adding weight. Pointed edges on bubbles are drawn as a rotated square
behind the bubble, so they inherit the bubble's real background and border rather than needing a
second colour to fake the join.

**The Pill-Means-Category Rule.** A fully-round shape means "this is a label or a mode" — a status, a
tab, a tag, a filter. A rectangle with a small radius means "this is a surface or a control." Do not
mix them.

## Components

### Tabs

- **Shape:** pill (`999px`), `7px 14px`, 13px at weight 550; no border, no underline, no bottom rule on the strip.
- **Resting:** `oklch(0.255 0.055 <h>)` on `oklch(0.855 0.095 <h>)` in dark; `oklch(0.955 0.035 <h>)` on `oklch(0.440 0.110 <h>)` in light — chroma is pulled back against the warmer ground, because the saturation that reads as crisp on cool grey reads as garish on cream.
- **Active:** the deeper tonal stop, weight 700, and an inset 1px ring. `aria-selected` carries it for assistive tech.
- **Hover / Focus:** inset ring / a 2px outline at `2px` offset, both in the derived ring stop.
- **Count badge** (`.tn`): 11px, tabular, `0.75` opacity rising to `0.95` when active.
- **Sub-pills:** deliberately quieter and flat slate rather than hue-coded. One hue-coded pill row per page is a navigation system; two is a competition.

### Buttons

- **Primary:** Instrument Blue, white text, `8px` radius, `8px 14px`. Hover is `filter: brightness(1.08)` — one rule that works in both themes.
- **Secondary:** `--line` ground, foreground text, same shape.
- **Small** (`.btn-small`): card ground, `--line` border, `7px`, 12.5px; hover borders in accent.
- **Outline** (`.gearlink`, `.moonbtn`): transparent, `--line` border, accent text, `8px`, 13px. These two are deliberately built on the same shell so they sit as a pair, with `line-height: 1.5` matching their heights without a hard-coded pixel value.
- **Danger:** `#c0392b`, used only in the confirm modal. The row-level trash control is red *and only red* — a bare icon button at `#f85149` — because destructive actions must not look like the others.
- **Row action** (`.applybtn`): a 11.5px pill with a `--line` border and muted text, quiet until hovered, when it borders and colours in accent. It is one action among many on a long table, not the headline.

### Status pills and tags

- **Kind tag** — `.k-lead` (blue at 16% alpha) versus `.k-app` (green at 18%). This is the distinction the whole tracker is built to protect, so it stays visible at a glance and must never be reduced to a text suffix.
- **Result pills** — `.ok-pill` green, `.warn-pill` / `.bad-pill` amber, at `2px 9px`, 12px, `999px`.
- **Run badge** — amber pill with a 7px dot pulsing on a 1.6s `opacity` keyframe (removed under `prefers-reduced-motion`). One running job is stated identically in the stat bar, on Today, and beside every per-tab trigger.
- **Board and status tags** — flat, low-lightness solid backgrounds (`#1f5b46` readable, `#4a3a2a` queued, `#6b2330` needs-url, `#3a2f67` manual, `#2b3a67` pending, `#3a3f57` unknown). The four board states stay visually distinct on purpose: "not investigated yet" and "no board found" are different facts, and collapsing them is how 53 companies got written off.

### Cards and panels

- `.sec` and `.kpi`: card ground, `--line` border, `12px`, `14px 18px`. Inside a tab panel the section chrome is removed entirely (`border: 0; background: transparent`) and only the table's `.scroll` container keeps the card treatment — so a panel is one framed object, not a frame inside a frame.

### Inputs and controls

- **Text input / textarea:** page ground (`--bg`) inside a card, `--line` border, `8px`, `8px 10px`, inheriting the body font. Focus is a `2px` accent outline at `-1px` offset with the border going transparent.
- **Chip field** (`.chipbox`): a box that looks and focuses like one input, with chips living inside it; `focus-within` borders in accent. The label sits above and the hint *below* the field, so boxes stay aligned across a row.
- **Toggle** (`.tgl`): the real checkbox stays in the DOM, moved offscreen rather than `display: none`, so it keeps its place in the tab order and in form submission; the 38×22 track and 16px thumb are painted from `:checked`.
- **Weight sliders:** shown as share-of-total, because only the ratio between them means anything. `accent-color: var(--acc)`.

### Navigation and overlays

- **Header:** brand mark at 32px with an `8px` radius beside a 20px title; actions right-aligned.
- **Popover** (`.pop`): `320px`, card ground, `12px`, fixed positioning, a rotated-square arrow, right-aligned to the control that opened it. The wide variant (`560px`) exists because editing a message you will send under your own name needs room to see it, while a one-line reason does not.
- **Modal:** `760px` max, `14px`, scrolls itself with `max-height: calc(100vh - 64px)` and `overscroll-behavior: contain`, with a sticky head reserving `34px` on the right so the title can never slide under the absolutely-positioned close button.
- **Flash toast:** fixed top-centre, fades and rises out over `0.5s` rather than vanishing — `.flash.hide` deliberately overrides the global `.hide`.

### Signature component — the first-run tour

Coach marks: a dimmed veil, the described element left bright inside a spotlight ring, and a bubble
with a pointer aimed at it. It is shown once on first open and is **replayable from the footer** — a
tour you cannot get back is one people click past and then wish they had not. Both the veil and the
spotlight have theme-specific alphas (`rgba(8,10,20,.55)` dark, `rgba(31,28,23,.38)` light), and all
three layers drop their transitions under `prefers-reduced-motion`.

### Signature component — the activity timeline

A single hairline down the left with 7px dots hanging off it, entries at `16px` rhythm. Run
boundaries get the strongest treatment on the page — the active tonal stop plus an inset ring on the
type badge, and a 2px top border on the row — because a run boundary is the anchor a person scans
for.

## Do's and Don'ts

### Do:

- **Do** declare a new destination with a single `--h` and let every colour derive from it in OKLCH.
- **Do** keep the OKLCH lightness stops as they are. They were measured: the worst case across all eight hues × both themes × active/resting is 5.85:1 against a 4.50 AA bar.
- **Do** put `font-variant-numeric: tabular-nums` on any number that will be read down a column.
- **Do** mark state with a low-alpha wash plus `box-shadow: inset 3px 0 0 <colour>`, not with a saturated fill.
- **Do** support all three appearance states: no `data-theme` means Auto and the media query alone decides, an explicit choice must beat the OS in both directions, and `color-scheme` rides along so scrollbars and form controls follow.
- **Do** give every colour-carried state a second cue — weight, a ring, a word, or an ARIA attribute.
- **Do** position popovers `fixed` and compute their coordinates on open; they live inside horizontally-scrolling tables that would otherwise clip them.
- **Do** cap prose in a data view with both a `max-width` and a `min-width` character measure.
- **Do** give every animation a `prefers-reduced-motion: reduce` branch. The pulsing run dot, the tour transitions and the flash all already have one.
- **Do** keep the interface dependency-free: no framework, no build step, no web font, no icon package.

### Don't:

- **Don't** put an `oklch()` call that reads `--h` on `:root`. It resolves there, where `--h` does not exist, and the token silently becomes invalid — a transparent pill.
- **Don't** hand-write a second palette for the light theme. Change the lightness and chroma scalars instead.
- **Don't** use Instrument Blue for status or emphasis. It means interactive, and nothing else.
- **Don't** add a resting shadow to a card, panel, table, pill or button. Shadow belongs to popovers, bubbles, toasts and the tour spotlight.
- **Don't** give a second pill row on the same page hue coding. One hue-coded navigation system per page.
- **Don't** collapse distinct states into one colour to simplify a legend. Four board states exist because they are four different facts.
- **Don't** let a destructive control look like an ordinary one; red is reserved for destruction and hard failure.
- **Don't** let a date column wrap, and don't let a prose column run without a `min-width` floor.
- **Don't** use `display: none` on a real form control to style it; move it offscreen so it keeps its tab order and its value.
- **Don't** reach for enterprise-ATS grey chrome, or the AI-product visual clichés — sparkle icons, glow orbs, gradient panels. Those are the confirmed anti-references.
