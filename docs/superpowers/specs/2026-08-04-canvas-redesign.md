# Canvas redesign: one Plan node, one left panel, plain names

Design spec. 2026-08-04. Written by the design lead; no component code was touched
producing it. Two implementation agents build from this. Every number here is a
number, not a direction: if you find yourself guessing, that is a defect in this
document and it should be reported rather than guessed past.

Source of truth for the current behaviour is the code, cited by `file:line`
throughout. Where this document and the code disagree, the code wins and the
disagreement is a correction to report.

---

## 0. Design read and dials

**Reading this as:** a redesign of an existing dark console dashboard for its sole
owner, who is expert about what he wants built and deliberately not expert about
this pipeline's internal vocabulary, with a dense terminal language already fully
specified in `dashboard/src/app/globals.css`, leaning toward extending that token
system rather than layering an aesthetic on top of it.

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | 4 | redesign-preserve. The canvas is a directed graph on a grid. Asymmetry is decided by the run, not by taste. |
| `MOTION_INTENSITY` | 3 | redesign-preserve, +1 for the one new panel transition. The existing rule in `globals.css:310-318` (motion is spent on liveness, arrival and attention, and a settled edge nobody is pointing at does not move) is kept verbatim. |
| `VISUAL_DENSITY` | 8 on the canvas, 5 in the left panel | The canvas stays a cockpit. The panel is the surface the owner called cramped, and it is the one place density comes down. |

**Skills loaded:** `redesign-skill/SKILL.md` (full, the correct route for product UI),
`taste-skill/SKILL.md` (Sections 0 to 5 and Section 14 pre-flight),
`imagegen-frontend-web/SKILL.md` (for the two generated assets).

**No aesthetic add-on is loaded, and that is a decision rather than an omission.**
soft, minimalist and brutalist each carry a palette, a type scale and a radius
system. This project already has all three, locked and reasoned in source:
`@theme` in `globals.css:13-109`, `--node-radius: 10px` at `globals.css:197`, and a
13 / 16 / 24 type scale whose derivation is recorded at `globals.css:43-101`.
Importing a fourth system would be exactly the "one system per project" violation
taste-skill Section 2.A forbids. The aesthetic here is the one already on screen.

**No new dependency.** `dashboard/package.json` has four runtime deps
(`@xyflow/react`, `next`, `react`, `react-dom`, `swr`). There is no icon library
and no animation library, so per the existing-project override: no icon package is
introduced, no hand-rolled decorative SVG is drawn, and every affordance in this
spec is either a word, a CSS primitive, or one of the two generated PNGs in
Section 5.

---

## 1. Corrections to the brief

Report these; do not silently absorb them.

1. **The Plan node folds FIVE stages, not four.** `GraphStageId` is
   `plan | capture | author | audit | freeze | orchestrator`
   (`dashboard/src/lib/api-types.ts:1135-1141`). The brief says "four underlying
   stages", which is the four spec stages and omits `plan`. `orchestrator` stays
   its own node. So: five sections in the panel, five segments in the rail.

2. **The rename lands on the SERVER.** The literals the owner objects to are
   `STAGE_LABEL` at `dashboard/server/src/graph.ts:474-481`, with the detail
   sentences in the constants immediately below it. The client copy in
   `dashboard/src/lib/spec-pipeline.ts:317-355` is the superseded derivation its own
   docblock (lines 13 to 47) says nothing renders. Editing only the client ships
   nothing. Editing only the server is correct; the client copy is dead code that
   another lane owns and should not be touched here.

3. **The Plan panel must not replace a stop.** The dock at
   `dashboard/src/app/runs/[runId]/page.tsx:693-878` carries `RunHud`, the chat
   button, notices, `PlanDialoguePanel` and `DesignLockPanel`. The owner said the
   menu "replaces this". Taken literally that hides the plan park's answer surface
   and the design lock's mockup deck, which are the two panels a run is *stopped*
   on. The panel replaces the run chip and the chat button only. Everything below
   them keeps rendering, unchanged, underneath. See Section 3.7.

4. **No custom mark on the Plan node.** The brief lists "a mark for the Plan node"
   as a candidate asset. Two generated candidates were rejected on inspection and
   the third concept was cut on principle: a static mark that carries lit and unlit
   parts will claim a progress state it cannot know, which is this repository's
   signature defect rendered as a picture; and a centred-aperture mark read as a
   power button, i.e. as a control. The node's identity comes from its progress
   rail, which is real state. The two assets that shipped went to the surfaces that
   are genuinely text-only. See Section 5.

---

## 2. The collapsed Plan node

### 2.1 What replaces what

Before: six cards at `STAGE_WIDTH` 216, drawn from `graph.stages` by
`placeGraph` (`dashboard/src/components/canvas/layout.ts:1010-1017`), each
rendered by `StageCard` (`stage-node.tsx:169`), plus a lane header
(`StageHeaderNode`, `stage-node.tsx:260`).

After, the whole canvas before the build is:

```
  Plan  ──────────  Orchestrator  ──────────  (whatever the orchestrator spawned)
```

`plan`, `capture`, `author`, `audit`, `freeze` fold into ONE node keyed
`stage:plan`. `orchestrator` keeps its own card and keeps the existing
"orchestrator stage OR root card, never both" rule at `layout.ts:998-1004`
untouched.

`StageHeaderNode`, `PlacedStageHeader` and `Placement.stageHeader` are **deleted**.
A lane header reading "Before the build 1" above a single card is chrome with no
content. When you delete it, replace the header's docblock reasoning with a note
recording the removal and why (house rule 3: comments are load-bearing, UI copy is
the task).

### 2.2 Geometry, exact

| Constant | Before | After | Why |
|---|---|---|---|
| `STAGE_WIDTH` (`layout.ts:226`) | 216 | **268** | The narrower width was justified by the card carrying less than an agent card (`layout.ts:216-224`). It now carries more. 268 is `NODE_WIDTH`, so when the orchestrator stage card is dropped for the real root card mid-run, nothing changes width under the reader. |
| `STAGE_HEIGHT` (`layout.ts:239`) | 118 | **136** | The row stack in 2.3 sums to 135. |
| `STAGE_GAP` (`layout.ts:227`) | 88 | **184** | `= COLUMN_GAP`. `STAGE_STEP` then equals `COLUMN_STEP` (452), so the pre-build chain sits on the same x rhythm as the agent columns instead of a second, tighter one. One spacing system on the canvas. |

The card top edge is fixed and the card never grows. `STAGE_HEIGHT` is a constant
and the component must render to it in every state.

### 2.3 Anatomy of the Plan node (268 x 136)

Padding: `px-3.5` (14) horizontal, `pt-3` (12) top, `pb-3` (12) bottom. Inner
width 240. Radius `rounded-[10px]` (matches `--node-radius`). Background
`bg-surface` plus the existing radial wash at `stage-node.tsx:184`.

Top to bottom:

| # | Row | Height | Content |
|---|---|---|---|
| 1 | header | 20 | Left: `Plan`, `text-[13px] font-semibold tracking-[-0.01em] text-ink`, rendered as `<p>` and **never a heading element** (`stage-node.tsx:43-48` records why: a second accessible heading named "Plan" makes `plan-dialogue.browser.spec.ts:58`'s `getByRole("heading")` ambiguous). Right: the rollup chip, 18px tall, from 2.4. |
| | gap | 10 | |
| 2 | progress rail | 4 | Five segments, 2.5. |
| | gap | 12 | |
| 3 | activity line | 32 | 2 lines reserved and `line-clamp-2`, `text-[11.5px] leading-[16px] text-ink-dim`. Content from 2.6. **Clamped permanently. There is no expand.** |
| | gap | 10 | |
| 4 | rule | 1 | `border-t border-line` |
| | gap | 8 | |
| 5 | footer | 14 | Left: elapsed, `text-[10px] numeric text-ink-faint`, from 2.7. Right: the word `details`, `font-mono text-[9.5px] uppercase tracking-[0.14em]`, colour per 2.8. |

12 + 20 + 10 + 4 + 12 + 32 + 10 + 1 + 8 + 14 + 12 = 135. `STAGE_HEIGHT` 136 gives
one pixel of slack in the direction the layout module already errs in
(`layout.ts:57-59`).

`data-testid="stage-card-plan"` is kept. Add `data-state` carrying the **rollup**
word from 2.4 (not a member state).

### 2.4 The rollup: one word from five states

Evaluated in this order over the five folded sections. First match wins.

| # | Condition | Chip word | Chip classes | Card border | Meaning (the chip's `title`) |
|---|---|---|---|---|---|
| 1 | any section is `running` | `working` | `border-accent/35 bg-accent-dim/45 text-accent`, dot `bg-accent motion-safe:animate-pulse` | `border-accent/55` | "The run said one of these started and has not said it finished." |
| 2 | else any section is `unresolved` | `stopped` | `border-line-strong bg-canvas/70 text-ink-dim`, dot `bg-ink-faint` | `border-dashed border-line-strong` | "The run moved on while one of these was still working, and never said how it ended. Not a failure. Nobody was watching by then." |
| 3 | else no section is `pending` | `done` | `border-pass/30 bg-pass-dim/70 text-pass`, dot `bg-pass` | `border-pass/30` | "The run said every one of these finished, or said it was not needed." |
| 4 | else any section is `done` or `skipped` | `waiting` | `border-line-strong bg-canvas/70 text-ink-dim`, dot `bg-ink-faint` | `border-line` | "Some of these finished. The run has not mentioned the next one." |
| 5 | else (all five `pending`) | `not started` | `border-line-strong bg-canvas/70 text-ink-dim`, dot `bg-ink-faint` | `border-line` | "The run has not mentioned any of this yet." |

Notes that are load-bearing:

- **`done` is unreachable while anything is pending.** Rule 3 fires only when the
  `pending` set is empty. A four-of-five node never says done.
- Rules 4 and 5 differ only in their word and their meaning sentence. Both are
  neutral. Keeping them apart is the difference between "we have heard nothing"
  and "we heard some of it", which are different facts about the same run.
- Every class name above already exists in the theme. That check is not optional:
  `prebuild-lane.browser.spec.ts:373` scans this file's source for colour names
  `globals.css` does not define, because an undefined `bg-` compiles to nothing and
  the marker renders invisible (`stage-node.tsx:69-73`).

**On the owner's actual run** (`run-2026-08-04T11-08-10-487Z-162b186d`, folded state
recorded at `stage-node.tsx:30-36`: `plan:done capture:pending author:unresolved
audit:pending freeze:pending`): rule 1 misses, rule 2 fires. The node reads
**`stopped`**, dashed border, no pulse. That is the primary rendering to build and
screenshot, not an edge case.

### 2.5 The progress rail

A flex row, `h-1 gap-[3px]`, five children each `flex-1 rounded-[2px]`. Total
width 240 on the node, 368 in the panel header. Order is chain order:
`plan, capture, author, audit, freeze`.

| Section state | Segment class |
|---|---|
| `done` | `bg-pass/70` |
| `running` | `bg-accent motion-safe:animate-pulse` |
| `unresolved` | `bg-ink-faint/70` |
| `skipped` | `bg-line-strong` |
| `pending` | `bg-line` |

It is a state strip, not a percentage bar: there is no filled background track and
no fraction is claimed. It carries an `aria-hidden="true"`; the same information is
in the card's accessible name (2.9) and in the panel list.

`unresolved` is at `/70` and not lower **because it was measured in a mock and the
first value failed**: at `/40` the segment resolves to roughly `#2e3239`, which is
indistinguishable from `bg-line` `#232833` at 4px, so on the owner's own run the
one section that stopped was invisible in the rail. See
`design-refs/mock-01.png` versus `design-refs/mock-03.png`.

### 2.6 The activity line

One sentence. Chosen by:

1. If any section is `running`, its `detail`.
2. Else, the `detail` of the **last section in chain order whose state is not
   `pending`**. That is the furthest thing the run actually said.
3. Else (all five `pending`), the `detail` of `plan`.

On the owner's run this resolves to `author`'s sentence, so the node is not blank
on the run he opens. Clamped to two lines. The whole string lives in the panel.

### 2.7 Elapsed

`at` is nullable and the existing rule holds (`stage-node.tsx:21-27`): a row that
carried no instant gets **no time at all**, never the browser's clock.

- Take the maximum parseable `at` across the five sections.
- If none parse, render an empty string in the footer-left slot.
- Otherwise render the existing `Elapsed` component with `running={rollup ===
  "working"}`, which yields `12 min so far` while working and `7h 21m ago`
  otherwise.

### 2.8 Interaction states

| State | Treatment |
|---|---|
| rest | Border per 2.4. `details` label `text-accent/70`. |
| hover | `hover:bg-surface-raised`; when the 2.4 border is `border-line`, `hover:border-line-strong`; `details` goes to `text-accent`. `transition-colors duration-150`. |
| active (pressing) | `active:translate-y-[1px]`. Tactile feedback, which the canvas currently has nowhere. |
| focus-visible | Nothing new. The existing `.node-shell:focus-visible` rule (`globals.css:601-605`) gives a 2px accent outline at offset 3. |
| selected (panel open) | `border-accent` plus `ring-1 ring-accent/40`, and `details` at full `text-accent`. **No footer background tint.** A tinted footer band was mocked and cut: at `rounded-[10px]` it reads as a separate strip glued to the bottom of the card rather than as selection. |

**It does not expand.** `StageNodeData.expanded` is deleted, the ternary at
`stage-node.tsx:207` is deleted, and the `open`/`close` affordance at
`stage-node.tsx:223` is replaced by the static word `details`. This is the bug the
owner reported as "they break funny": the card grew inside a fixed React Flow
layout and collided with its neighbours. It is designed out, not patched.

Click, Enter and Space all open the panel. Clicking the node while its panel is
open closes the panel (toggle).

### 2.9 Accessible name

`stageLabel` (`stage-node.tsx:153`) becomes, for the Plan node:

> `Plan, <rollup word>. <activity line> Press Enter to see all five sections.`

The trailing sentence replaces "Press Enter for the full line", which described the
in-place expansion that no longer exists.

### 2.10 The Orchestrator node

Same 268 x 136 box, so the chain reads as two peers.

| # | Row | Height | Content |
|---|---|---|---|
| 1 | header | 20 | `Orchestrator` + its own state chip (unchanged `STAGE_LOOK` mapping, with the state words renamed per 4.3) |
| | gap | 12 | |
| 2 | detail | 64 | `line-clamp-4`, `text-[11.5px] leading-[16px] text-ink-dim` |
| | gap | 10 | |
| 3 | rule + footer | 23 | **Rendered only when there is an elapsed value.** `border-t border-line`, `pt-2`, elapsed left. **No `details` label, ever.** |

With a footer: 12 + 20 + 12 + 64 + 10 + 1 + 8 + 14 (bottom pad reduced to 0 by the
footer's own height) sums past 136, so when the footer renders the detail clamps to
3 lines (48) instead of 4. When it does not render, the detail gets its 4 lines and
the remaining space is bottom padding. Either way the rendered box is 136.

The conditional footer was mocked both ways: an always-present rule with an empty
row under it reads as a broken card. A card with no time simply has no rule.

No rail (it is one thing, not five). No hover border change and no `active`
translate: it opens nothing, so it must not look pressable.

---

## 3. The left panel

### 3.1 Where it lives

It replaces `RunHud` and the chat `Button` inside the existing dock wrapper at
`dashboard/src/app/runs/[runId]/page.tsx:693`. It does **not** replace the wrapper,
the notices, `PlanDialoguePanel` or `DesignLockPanel` (see 3.7).

It is not the right-hand `DetailSheet`. Selecting the Plan node must clear
`selectedId` so the two panels can never both be open, and `DetailSheet` must never
receive a stage: it takes a `GraphNode`, and a stage is not one
(`spec-pipeline.ts:61-70`).

State: a new `planPanelOpen` boolean on the run page, not a value in `selectedId`.

### 3.2 Width

`HUD_WIDTH` (`orchestration-canvas.tsx:163`) **360 -> 400**, and the dock's own
`w-[min(360px,calc(100vw-32px))]` -> `w-[min(400px,calc(100vw-32px))]`, changed
together. `orchestration-canvas.tsx:171` records that the fit reserve is built as
`360 + 28`; that arithmetic follows the constant, so only the constant moves.

This is the one structural change this spec asks for. It buys 40px, which on a
five-row list with a sentence per row is the difference between two-line and
three-line wraps. If the fit measurably regresses at narrow viewports, keeping 360
is acceptable and everything else in this section still holds; report it.

Height: the panel wrapper gets `max-h-[78vh]` with `overflow-hidden`, and the
**section list alone** scrolls (`overflow-y-auto`). A `vh` cap, never a percentage:
`runs/[runId]/page.tsx:671-692` records the measurement showing percentage caps on
this dock resolve to `none` against an indefinite height, so they are inert.

### 3.3 Anatomy

Surface `bg-surface/95 backdrop-blur border border-line rounded`, matching the run
chip it replaces (`run-hud.tsx:95`). Inner width 368.

**A. Return bar.** Height 34. `px-3.5 py-2`, `border-b border-line`.
One left-aligned `<button>`: `Back to run`, `text-[12px] font-medium text-ink-dim
hover:text-ink transition-colors`. No glyph. Three other ways back exist, all of
which must work: `Escape` while focus is inside the panel; clicking the Plan node
again; clicking empty canvas, which already clears selection.

**B. Header block.** `px-4 pt-3.5 pb-3`.

| Line | Spec |
|---|---|
| 1 | Row. Left: `Plan`, `text-lede font-semibold text-ink` (16px, the existing token at `globals.css:102`), as a `<p>`, not a heading, for the reason in 2.3. Right: the same rollup chip as the node, identical classes. |
| 2 | `mt-1`. One sentence, `text-[11.5px] leading-snug text-ink-dim`: **"Everything the run does before it writes any code."** |
| 3 | `mt-2.5`. The five-segment rail from 2.5, full 368 width. |
| 4 | `mt-1.5`. Meta row, `text-[10.5px] text-ink-faint`, `flex justify-between`. Left: `<n> of 5 done`, `numeric`. Right: elapsed, per 2.7. |

The rail is the panel's focal point and it is the same object as the node's rail,
which is what ties the two surfaces together. It is the answer to "make that menu
look better": one strong horizontal element at the top, then a quiet list.

**C. Section list.** `divide-y divide-line`, `overflow-y-auto`, `flex-1 min-h-0`.
Five rows in chain order. Each row `px-4 py-3`, with `border-l-2` always present so
that no row shifts when the active one is marked.

Row layout:

| Element | Spec |
|---|---|
| Row header | `flex items-baseline justify-between gap-2` |
| Name | `text-[12.5px] font-medium`. Colour: `text-ink` for `done`, `running`, `unresolved`; `text-ink-dim` for `pending` and `skipped`. **Not `ink-faint`, and this was changed after looking at it:** an `ink-faint` name above an `ink-dim` sentence puts the row's heading DIMMER than its own body, which reads as an inversion rather than as "not started". `ink-dim` also clears AA where `ink-faint` does not. The recession is carried by the absent left rule and the absent right slot instead. |
| Right slot | see the state table below |
| Detail | `mt-1 text-[11.5px] leading-[17px] text-ink-dim whitespace-pre-wrap break-words`. **No clamp anywhere in this list.** The panel scrolls; growth is free here, which is precisely why the detail moved off the fixed-size node. |

| Section state | Left rule | Row background | Right slot |
|---|---|---|---|
| `running` | `border-l-accent` | `bg-accent-dim/20` | the word `working`, `font-mono text-[10px] uppercase tracking-[0.14em] text-accent` |
| `done` | `border-l-transparent` | none | relative time, `numeric text-[10.5px] text-ink-faint` |
| `unresolved` | `border-l-ink-faint/50` | none | the word `stopped`, `font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim` |
| `skipped` | `border-l-transparent` | none | the word `skipped`, same mono style, `text-ink-faint` |
| `pending` | `border-l-transparent` | none | empty |

That is how the active section is distinguished: an accent left rule, a tinted row,
and the only mono state word on screen. Everything else is quiet.

The right slot never carries two signals. A settled section shows *when*, an
active one shows *what*, and one that has said nothing shows nothing.

**Known cost, stated rather than discovered:** a `done` section's `detail` is the
server's own line, which for `author` and `audit` is a token report
(`spec seat - anthropic: 14 input, 40187 cache read, ...`). Unclamped, that row is
tall. That is the correct trade: it is exactly the string the deleted open/close
toggle existed to reveal, and the list scrolls. Do not reintroduce a clamp with a
toggle.

**D. Footer strip.** Only when the rollup is `done` (2.4 rule 3): the sealed asset
from Section 5, `368 x 80`, `object-cover object-center`, on a `bg-canvas`
container (so a failed load matches the surrounding dark rather than flashing
white), `border-t border-line`, with one caption under it,
`px-4 py-2 text-[11px] text-ink-faint`:

> **"The tests are sealed. The builder cannot see them."**

In every other state the footer is absent.

### 3.4 Empty state

When **all five** sections are `pending` (the run has said nothing at all), the
section list is replaced by:

- the empty asset from Section 5, `368 x 104`, `object-cover object-center`, on a
  `bg-canvas` container;
- one line under it, `px-4 py-3 text-center text-[11.5px] text-ink-dim`:
  **"The run has not said anything about this yet."**

The header block (B) still renders, with the rail all `bg-line` and the chip at
`not started`.

When `graph.stages` is absent or empty the Plan node is not drawn at all
(existing rule at `layout.ts:994-1000`), so the panel is unreachable and needs no
state for it.

### 3.5 Finished state

Rollup `done`: header chip `done`, rail all `bg-pass/70`, every row carries a time
in its right slot, and the sealed strip from 3.3.D sits at the bottom. The panel
stays reachable and is the record of what happened.

### 3.6 Motion

One transition, and it is motivated by "this came out of the node you clicked":
`panel-in`, 150ms, `cubic-bezier(0.22, 0.61, 0.36, 1)`, `opacity 0 -> 1` and
`translateX(-10px) -> 0`. Mirror of the existing `sheet-in`
(`globals.css:620-633`), which comes from the right.

Add the keyframe and the class to `globals.css`, and add the
`prefers-reduced-motion` override **below** the rule it overrides. A media query
adds no specificity, and this file already records the same trap twice
(`globals.css:466-471` and `globals.css:513-521`), where a reduced-motion override
written above its rule lost the cascade and was dead while looking implemented.

Nothing else animates. The rail's running segment reuses the existing
`motion-safe:animate-pulse`.

### 3.7 What the panel does NOT replace

Keep rendering, below the panel, in this order, unchanged:

1. `actionError` notice
2. `RateLimitNotice`
3. `AwaitingInputNotice`
4. `PlanDialoguePanel`
5. `DesignLockPanel`

Reason, stated so it does not get "tidied": items 4 and 5 are the answer surfaces
for a run that is *stopped* waiting on the owner. `runs/[runId]/page.tsx:747-772`
records what it cost the last time a generic notice sat where an answer surface
belonged. A Plan panel that covered a plan park would let the owner click Plan and
lose the only control that can un-stick his run.

---

## 4. Plain-English names

### 4.1 The pre-build stages (primary; do these)

Edit site: `STAGE_LABEL` at `dashboard/server/src/graph.ts:474-481`, and the detail
constants below it (`PLAN_RUNNING` :483, `PLAN_PARKED_DETAIL` :486,
`ORCHESTRATOR_PENDING` :489, `ORCHESTRATOR_RUNNING` :491, `ORCHESTRATOR_DONE` :492,
and the `STAGE_PENDING` table at :494).

| id | Before | After | Accurate because |
|---|---|---|---|
| `plan` | `Plan` | **Reading the ticket** | `#planPhase` reads the ticket and its attachments and works out what it cannot infer. Renaming it also removes the name collision with the node and the panel, which are both called Plan. |
| `capture` | `Reference capture` | **Reading the reference page** | It loads the URL the owner supplied and reads its structure and its motion. |
| `author` | `Spec seat` | **Writing the tests** | It authors the held-out acceptance suite from the ticket, before any code exists. |
| `audit` | `Audit seat` | **Attacking the tests** | A second seat attacks the suite for untestable and gameable criteria. "Checking" would be a friendly lie about an adversarial step, and this system's honesty about what it is doing is the property being protected. |
| `freeze` | `Freeze` | **Sealing the tests** | It seals the suite by digest so the builder can never see it. "Sealed" is the server's own word for the result (`sealed suite ...`), so the two vocabularies stay one. |
| `orchestrator` | `Orchestrator` | **Orchestrator** | Unchanged. The owner said it means something. |

### 4.2 Detail sentences, rewritten short

One sentence each. No em-dashes anywhere in shipped UI copy. Where the server has
already written a real line (a capture URL, a token report, a `sealed suite <hash>`),
that line is still what renders on `done`; these replace only the sentences this
codebase writes itself.

| id | State | Before | After |
|---|---|---|---|
| `plan` | running | "Reading the ticket and anything attached to it, and working out what it cannot infer. It reports when it has something to ask." | **"Reading your ticket and working out what it cannot guess."** |
| `plan` | parked | "Waiting for an answer in the run panel. The window closes on its own, and the run then proceeds on what it had to assume." | **"Waiting for your answer below. If you do not answer, it carries on with what it had to assume."** |
| `capture` | pending | (server `STAGE_PENDING`) | **"Waiting to read the page your ticket links to."** |
| `capture` | running | "Loading the page and reading its structure." | **"Reading the page your ticket links to."** |
| `capture` | skipped | "No URL in the ticket, so nothing was captured." | **"No link in the ticket, so there was nothing to read."** |
| `author` | pending | (server `STAGE_PENDING`) | **"Waiting for the reference page."** |
| `author` | running | "Writing the held-out acceptance suite from the ticket and the capture." | **"Writing the tests this build will be graded against."** |
| `audit` | pending | "Attacks the suite for untestable and gameable criteria. Reports only when it finishes." | **"A second seat will try to break these tests, looking for anything untestable or easy to fake. It only reports when it is done."** |
| `freeze` | pending | "Seals the suite by digest, so the builder can never see it." | **"Locks the tests so the builder cannot see them while it works."** |
| `orchestrator` | pending | "Waits for the sealed suite. Whatever it delegates to appears beside it." | **"Waiting for the sealed tests. Whatever it hands work to appears beside it."** |
| `orchestrator` | running | "Running the build. Every agent it spawned is on this canvas." | **"Running the build. Everything it handed work to is on this canvas."** |
| `orchestrator` | done | "The build phase is over." | **"The build is over."** |

### 4.3 State words

`STAGE_LOOK` at `stage-node.tsx:75-114`. Keys and semantics do not change; the
`label` and `meaning` strings do.

| key | Before | After | Meaning (the chip's `title`) |
|---|---|---|---|
| `running` | `running` | **working** | "The run said this started and has not said it finished." (unchanged) |
| `done` | `done` | **done** | "The run said this finished." (unchanged) |
| `pending` | `pending` | **not started** | "The run has not mentioned this yet." (unchanged) |
| `skipped` | `skipped` | **skipped** | "The run said this was not needed." (unchanged) |
| `unresolved` | `unresolved` | **stopped** | "The run moved on while this was still working, and never said how it ended. Not a failure. Nobody was watching by then." |

`running` becomes `working` because "run" is a noun everywhere else in this app, so
"running" reads ambiguously. `unresolved` is the one word on the owner's own run
that means nothing to him.

### 4.4 Canvas column labels (secondary; defer if the primary lane is at risk)

`COLUMN_LABEL` at `layout.ts:140-148`.

| key | Before | After | Why |
|---|---|---|---|
| `root` | `Session` | **Orchestrator** | The root column holds the one node with no parent, which is the orchestrator. "Session" names nothing the owner can see. |
| `tasks` | `Direct tasks` | `Direct tasks` | Already plain. No change. |
| `spec` | `Spec` | **Requirements** | Matches `ROLE_MEANING.spec` at `roles.ts:88`: "Turned the ticket into requirements and context." |
| `design` | `Design` | `Design` | No change. |
| `build` | `Build` | `Build` | No change. |
| `review` | `Review` | `Review` | No change. |
| `gate` | `Gate` | **Scoring** | The gate is where the sealed suite grades the build. "Gate" is internal vocabulary. |

Also delete the lane header string `Before the build` (`stage-node.tsx:265`) with
the component, per 2.1.

### 4.5 Strings that stay as they are, and why

- `unmapped` (`roles.ts:78`). It is deliberately not a role and its meaning line
  already explains itself in full at `roles.ts:93-94`. Renaming it to something
  friendlier would be the guess that docblock exists to refuse.
- `inferred` on a guessed edge. It is the one place the server admits what it does
  not know, and `globals.css:208-244` spends four paragraphs and a hue on making
  that legible. Do not soften it.

---

## 5. Custom assets

Both generated with `~/.claude/scripts/gemini-image.sh`, art-directed per
`imagegen-frontend-web` Section 13 (one palette, no gradient slop, no glow), read
back and iterated. Working files, the rejected candidates, and a standalone HTML mock of every state
in Sections 2 and 3 (`design-refs/mock.html`, screenshotted as `mock-01.png` and
`mock-03.png`) are in `design-refs/` at the repository root. **That folder is
deliberately not committed by this lane** (its file list is the spec plus
`dashboard/public/**`); it is session scratch, and the four numbers it caught are
written into this document rather than left in a picture. The shipped files are in
`dashboard/public/`, which is the directory Next serves static assets from and
which this task created (the app previously had none; `src/app/favicon.ico` is the
only asset it had, and it is untouched).

| Path | Size | Where | Why it earns its place |
|---|---|---|---|
| `dashboard/public/pre-build-empty.png` | 736 x 208, rendered at **368 x 104** (2x) | Left panel, 3.4 | Five unlit rail segments on the canvas dot grid. It appears only when the run has genuinely said nothing, so it cannot claim a state. It is the focal point of a panel that was otherwise grey text, which is the owner's complaint. |
| `dashboard/public/pre-build-sealed.png` | 736 x 160, rendered at **368 x 80** (2x) | Left panel footer, 3.3.D | The same rail, closed, with one continuous accent line threading all five segments. Appears only when the rollup is `done`. |

Both were generated at 3:2, then cropped tight to the rail and downsampled to
exactly 2x their render size. The first crop was looser (368 x 138 and 368 x 92)
and read as a black void in the mock; the tighter crop is what shipped. Do not
scale them up, and do not swap `object-cover` for `object-contain`, which would
reintroduce the dead margin.

Both are drawn on `#0b0d11` with the grid at `#262e3c`, which are
`--color-canvas` and `--canvas-grid` exactly, so no transparency and no cutout is
needed and they sit flush on the surface. `alt` text:

- empty: `"Five unlit segments on a rail, meaning nothing has been reported yet."`
- sealed: `"Five segments joined by one continuous line, meaning the tests are sealed."`

Rejected, recorded so nobody regenerates them:

- **Plan node mark, five-slot plate** (`design-refs/plan-mark-01.png`,
  `plan-mark-02.png`). Formally fine. Cut because a static mark with one lit and
  four unlit slots asserts "1 of 5" on every run regardless of state. A picture
  that reports progress it never observed is this repository's signature defect.
- **Plan node mark, sealed aperture** (`design-refs/plan-mark-03.png`). Read as a
  power button, i.e. as an on/off control, on a canvas full of clickable cards.
- **A header plate for the new-ticket screen.** Cut on the brief's own terms: the
  nav already highlights "New ticket", so a title band would be the redundancy the
  owner asked to remove.

---

## 6. The new-ticket screen

File: `dashboard/src/app/page.tsx`. The complaint is "a lot of redundant
information". Measured: the form renders four panel headers and roughly 190 words
of permanent explanatory prose above the fold, and two of those paragraphs restate
each other.

### 6.1 Structural change

Merge **Motion reference** (`page.tsx:684`), **Design** (`page.tsx:746`) and
**Delivery** (`page.tsx:779`) into ONE `Panel title="Options"` with three rows
separated by `divide-y divide-line`, in that order. Three panel headers become
one. The Ticket panel is unchanged structurally and stays first.

Ordering constraint that must survive: `ticket-motion.browser.spec.ts:161` asserts
the motion field sits below the brief so that `getByRole("textbox").first()` still
resolves to the ticket. Merging keeps it below. Verify, do not assume.

### 6.2 Copy: exact before and after

| # | Line | Now | Change |
|---|---|---|---|
| 1 | Ticket subtitle (`:382`) | "Describe what you want built, and how you will know it works." | **Keep.** It changes the output, not just the reader. |
| 2 | Attach hint (`:513`) | "or paste and drop them into the brief above." | **Cut.** Tutorial text for an affordance that is discoverable. |
| 3 | Ticket identity (`:553`) | "A reference or a document is part of the ticket's identity: the same words with a different file is a different ticket, with its own frozen acceptance suite." | **Shorten and make conditional on `attachments.length > 0`:** "A different file makes this a different ticket, with its own tests." Update the surrounding comment to record that the sentence became conditional and why. |
| 4 | Capture note (`:594`) | 4 lines | **Shorten to 2, keeping the pinned clause:** "The first link in this brief is captured before the tests are written. The live page is never opened again, so anything your build is measured against is what was taken now." `ticket-motion.browser.spec.ts:198` asserts `/the live page is never opened again/i` is visible; that clause is load-bearing and must survive verbatim. |
| 5 | Criteria note (`:607`) | "The acceptance criteria are authored from this text before any code is written. Ambiguity here becomes an untestable criterion later." | **Cut.** It restates the panel subtitle (#1) in longer words. |
| 6 | Gate limit (`:635`) | 3 lines about Stripe / hosted database / third-party login | **Shorten to 1, keep permanent:** "Grading runs with no network and no logins, so anything needing a real payment provider, database or login is graded against a stub." The substance is non-obvious and worth the line. Update the comment above it to record the compression. |
| 7 | Motion label (`:686`) | "A page whose animation you want matched" | **Keep verbatim.** `ticket-motion.browser.spec.ts:122` resolves the field by `getByLabel(/animation you want matched/i)`; four tests drive it. |
| 8 | Motion note (`:710`) | 3 lines | **Shorten to 2, keeping the pinned clause:** "Only the movement is taken from this page, not its words, layout or colours. What the run made of the link is on the run's own event stream." `ticket-motion.browser.spec.ts:185` asserts `/what the run made of the link is on the run/i`. |
| 9 | Design note (`:773`) | "Asking stops the run once the mockups exist and waits for your pick; if the window closes before you answer, ui-designer picks and the run carries on." | **Shorten:** "Asking stops the run and waits for your pick. If you do not answer in time, ui-designer picks and the run carries on." |
| 10 | Delivery note (`:791`) | "Off by default. When off the artifact stays on this machine and the run reports a local path instead of a URL." | **Shorten:** "When off, the build stays on this machine." "Off by default" restates the unchecked checkbox. |
| 11 | Submitting note (`:841`) | "A link in the brief is captured before the run is created, so this submit is slower than one without." | **Shorten:** "Capturing the link first, so this takes a moment." |
| 12 | Panel title (`:746`) | "Design" | Becomes a row label inside Options: **"Mockups"**. "Design" as a panel title next to a radio about who picks a mockup is vaguer than the thing it controls. |
| 13 | Panel title (`:779`) | "Delivery" | Becomes a row label inside Options: **"When it passes"**. |

Net effect: 4 panel headers to 2, and roughly 190 words of permanent prose to
roughly 70.

### 6.3 Spacing, after the cut

With the prose gone, the Ticket panel's textarea (`h-[420px]`, `:444`) plus one
attach row plus one gate line is a clean single focal block. Keep the `gap-4`
between panels. Do not add anything to fill the space that is freed; the freed
space is the deliverable.

---

## 7. Negative controls for the implementers

House rule 1: every test names AND runs the mutation that makes it fail. These are
the mutations. Apply, watch red, revert, watch green, report both.

| Claim | Test asserts | Mutation that must go red |
|---|---|---|
| The canvas draws exactly two pre-build cards | `page.locator('[data-testid^="stage-card-"]')` has count 2, and their testids are `stage-card-plan` and `stage-card-orchestrator` | Restore any one of `capture`, `author`, `audit`, `freeze` to `drawnStages` in `layout.ts`. Count goes to 3. |
| The Plan node never grows | Measure `boundingBox().height` of `stage-card-plan` before and after a click; assert equal and equal to 136 | Re-add `expanded ? "whitespace-pre-wrap" : "line-clamp-2 h-[32px]"` to the activity line. Height changes on click. |
| The rollup says `stopped`, not `done` or `working`, on the owner's fixture | `stage-card-plan` has `data-state="stopped"` and its chip text is `stopped`, on a fixture folding to `plan:done capture:pending author:unresolved audit:pending freeze:pending` | Reorder the rollup so rule 3 (`done`) is evaluated before rule 2 (`unresolved`). It flips to `waiting` or `done`. |
| The rollup never says `done` while a section is pending | Fixture `plan:done capture:done author:done audit:done freeze:pending` yields `waiting` | Change rule 3's condition from "no section is `pending`" to "at least one section is `done`". It flips to `done`. |
| The activity line shows the furthest thing that was said, not a blank | On the owner's fixture, `stage-card-plan` contains the `author` sentence | Change 2.6 step 2 to read the FIRST non-pending section. It shows the `plan` sentence instead. |
| Clicking Plan opens the panel and hides the run chip | After click: the panel's `Back to run` is visible AND the run chip's `run detail` button is not | Delete the `planPanelOpen` branch that swaps them, so both render. Second assertion goes red. |
| The panel does not hide a plan park | On an `awaiting_input` plan fixture with the panel open, `PlanDialoguePanel`'s question card is still visible | Move `PlanDialoguePanel` inside the `!planPanelOpen` branch. Goes red. |
| Escape returns the default sidebar | Panel open, `Escape` with focus inside, run chip visible again | Remove the Escape handler. Goes red. |
| Every section's detail is readable in full in the panel | Panel open on a fixture whose `author` detail is a 300-character token report; assert the panel's row text contains the report's LAST 20 characters | Add `line-clamp-2` to the panel row's detail. Playwright reads clamped text from the DOM, so assert on `evaluate` of `scrollHeight === clientHeight` for that element instead, and the mutation is the same class. |
| The panel's "Plan" is not a second heading | `page.getByRole("heading", { name: "Plan", exact: true })` still resolves to exactly one element with the panel open on a plan-parked run | Render the panel title as `<h2>Plan</h2>`. `plan-dialogue.browser.spec.ts:58` goes red on a strict-mode violation, because `PlanDialoguePanel` already owns that heading. This is not hypothetical: `stage-node.tsx:43-48` records that the same collision was hit once already. |
| The renames actually ship | `stage-card-plan` contains `Reading the ticket`, `Writing the tests`, `Attacking the tests` and `Sealing the tests` when the panel is open; and the page contains none of `Spec seat`, `Audit seat`, `Reference capture` | Revert one entry in `STAGE_LABEL` on the server. Both halves go red, and the "contains none of" half is the one that catches a half-done rename. |
| No stage colour names something the theme does not define | Existing check at `prebuild-lane.browser.spec.ts:373`, extended to the new rail classes | Add `bg-run` (a colour that does not exist) to one rail segment. Goes red. It shipped once before. |
| The ticket screen lost the redundant prose | `page.getByText(/Ambiguity here becomes an untestable criterion/)` has count 0, and `getByText(/the live page is never opened again/i)` is still visible | Restore the criteria paragraph. First assertion goes red. The second half is the control that proves the cut was surgical rather than a blanket delete. |
| The Options merge did not move the motion field above the brief | Existing `ticket-motion.browser.spec.ts:161` | Render the Options panel above the Ticket panel. Goes red. |

**Tests that must be rewritten, not just re-run:**
`dashboard/tests/prebuild-lane.browser.spec.ts` at 165 (`CHAIN`), 174, 205, 237-256,
260-275 (the whole open/close test, which asserts behaviour this redesign deletes),
290-311. `dashboard/tests/spec-pipeline.unit.spec.ts` is against the superseded
client derivation and is not in scope; leave it alone.

---

## 8. Pre-flight, run mechanically

- **Em-dashes in new UI copy:** zero. Every string in Sections 3, 4.1, 4.2, 4.3 and
  6.2 was re-read for `—` and `–`. Implementers: do not reintroduce one. The
  existing source comments keep theirs; comments are not UI.
- **Theme lock:** one theme. `globals.css:3-12` states there is no light mode and
  no `dark:` variant anywhere. Nothing here adds one.
- **Colour lock:** one accent, `--color-accent` `#6ea8fe`. State colours
  (`pass`, `fail`, `warn`) are used only for state. The generated assets carry the
  accent and nothing else. No new hue is introduced.
- **Shape lock:** `rounded-[10px]` on cards (`--node-radius`), `rounded` on the
  panel shell (matching the run chip it replaces), `rounded-full` on chips,
  `rounded-[2px]` on rail segments. That is the system already in the tree; nothing
  new.
- **Eyebrow count:** the panel has zero uppercase-tracking labels above headings.
  The only mono uppercase strings are the state words in the row right-slot and
  `details` on the node, both of which are state, not decoration.
- **Contrast, computed rather than eyeballed** (WCAG 2.1 relative luminance,
  against `--color-surface` `#11141a`):
  `--color-ink` `#e7eaf0` = 14.9:1, `--color-ink-dim` `#a2abbb` = **8.0:1**,
  `--color-accent` `#6ea8fe` = **7.6:1**, `--color-ink-faint` `#6f7887` = **4.1:1**.
  Every text colour in this spec is one of those four.
  **One honest failure, inherited rather than introduced:** `ink-faint` at 4.1:1 is
  below the AA 4.5:1 floor, and this spec uses it for timestamps, the `n of 5 done`
  counter and the `skipped` word. It is the app's existing convention for
  metadata (`stage-node.tsx:213`, `run-hud.tsx:297`), so changing it here would be
  a palette change across the whole dashboard, which is out of this task's scope.
  Recommendation to carry forward: lift `--color-ink-faint` from `#6f7887` to about
  `#7d8695` (4.9:1) in a pass of its own. Nothing in this spec depends on
  `ink-faint` carrying a sentence a reader has to parse.
- **Interactive states:** rest, hover, active, focus-visible and selected are all
  specified for the Plan node (2.8). Empty (3.4) and finished (3.5) states are
  specified for the panel. There is no loading state because the graph snapshot
  arrives with the run and the page already gates on `run === undefined`.
- **Reduced motion:** the one new keyframe is stilled, with the override placed
  below the rule it overrides.
- **Copy self-audit:** every visible string in Sections 3, 4 and 6 was re-read.
  None uses "seamless", "elevate", "unleash" or a forced metaphor. No exclamation
  marks. Active voice throughout.
- **No hand-rolled SVG, no icon library added, no fake screenshot.** The two raster
  assets are the only new imagery, both generated, both reviewed.
- **Mobile:** below 900px the canvas fit reserves the top rather than the left
  (`runs/[runId]/page.tsx:660-664`), and the dock overlaps the graph. That behaviour
  is unchanged; the panel inherits `w-[min(400px,calc(100vw-32px))]`, so on a 375px
  viewport it is 343px wide and the section list still scrolls.

Two rules are consciously broken, and both are stated rather than hidden:

1. **redesign-skill: "Dashboard always has a left sidebar. Try top navigation, a
   floating command menu, or a collapsible panel instead."** The panel is a
   floating, collapsible left dock, which is the closest the rule's alternatives
   get, and the position is the owner's explicit instruction ("a menu on the left
   side of the screen comes up"). Not negotiable.
2. **taste-skill 4.9: "long lists need a different UI component."** The panel is a
   five-row list with a hairline between rows. Five is under the rule's threshold
   of five-plus, and the rows are a fixed sequence, not a browsable set; tabs or a
   card grid would break the "and then" order that is the whole content.
