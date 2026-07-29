# Phase 2a — anti-slop enforcement at WRITE time

**Date:** 2026-07-29
**Spec:** `docs/superpowers/specs/2026-07-28-orchestration-canvas-design.md` §8 (headed "Phase 2b", ordered
**2a** in §12), Layers 1–2.
**Status:** plan, then implementation in the same session.

---

## 0. What this phase is, and what it is not

Layer 1 is a **craft gate**, not a security boundary. It stops a *write* whose text carries an
unambiguous slop signal, and it hands the model a reason it can act on. The sealed-suite boundary
lives in `managedSettings.permissions.deny` (policy tier) and in the delegation `PreToolUse` slot;
**nothing in this phase touches either**, and nothing here is load-bearing for `heldOutPass`.

That framing decides the two arguments this phase would otherwise lose:

- **A craft gate must never wedge the builder.** The spec's retry cap ("the same rule firing 3×
  escalates to the orchestrator rather than looping") is therefore implemented as
  *escalate-and-ALLOW*, not *escalate-and-keep-denying*. A build that cannot write is a mysterious
  failure; a build that wrote slop three times after being told why is a reported finding.
- **A craft gate may abstain.** Any rule that needs the rendered page, the computed style, or the
  whole document tree is *excluded with the reason attached* rather than approximated. Grading
  (`visual-criteria.ts`, another agent's file) already reports those after the fact.

## 1. Sources, kept separate and never merged

| Rule | Source |
|---|---|
| gradient text; coloured `border-left`/`border-right` above 1px; tracking floor −0.04em; tracked uppercase eyebrow over every section | `~/.claude/skills/impeccable/reference/craft-floor.md` (globally installed `impeccable` skill; spec §6.3 names it authoritative; **not vendored in this repo** — verified absent by a previous agent with `find` + repo-wide grep) |
| `picsum` / `placehold.co` / `unsplash.com/random` / lorem ipsum; purple→pink gradient; Inter-and-slate with no custom type scale | spec §8 **Layer 1** |
| the three motion satisfiers and the named failing case | spec §8 **Layer 2** |

`dashboard/server/src/visual-criteria.ts` encodes overlapping material as **grading** criteria. It is
read, not edited, and not imported: grading reports after the fact and may be vague; a hook stops a
write and must be exact. Where both speak, the citation above is the source, not that file.

## 2. Mechanism — the slot the engine actually asks

`canUseTool` is never consulted for the Agent tool (probe A, three permission modes). A programmatic
`Options.hooks.PreToolUse` callback is (probes E/F, and live adversarial run 2). So Layer 1 goes in
the same slot.

**One `HookCallbackMatcher`, one callback, chained — not a second matcher.** Probe E registered three
slots, all three fired for the same `tool_use_id`, and *which one carried the decision was never
measured*. Adding a second slot would put a brand-new craft rule on top of an unmeasured precedence
question. Instead `chainPreToolUse(delegation, antiSlop)` flattens both into the single no-matcher
slot that was measured to fire and to deny:

- delegation is consulted **first** and its decision strings pass through byte-identical (they are
  pinned by tests and reach the model verbatim);
- the first `permissionDecision: "deny"` wins;
- everything else returns `{continue: true}` — the slot fires for *every* tool, Bash included, so
  anything that is not judged must fall straight through.

Layer 2 goes in `Stop` and `SubagentStop`.

## 3. Layer 1 — what is scanned

Read out of the SDK's own `sdk-tools.d.ts` for 0.3.220 rather than assumed:

| Tool | Path key | Text key |
|---|---|---|
| `Write` (`FileWriteInput`) | `file_path` | `content` |
| `Edit` (`FileEditInput`) | `file_path` | `new_string` (never `old_string` — that text is being removed) |
| `NotebookEdit` (`NotebookEditInput`) | `notebook_path` | `new_source` |

**There is no `MultiEdit` in 0.3.220** — checked against `ToolInputSchemas`.

Routing is by **shape, not tool name** (the READ_TOOLS lesson, and `Agent`-vs-`Task`): any input
carrying one of those three text keys at the top level is scanned, whatever the tool is called, so an
`mcp__*` file-writer is covered too.

**Scoped by artefact extension**: `.html .htm .css .scss .sass .less .js .jsx .mjs .cjs .ts .tsx .vue
.svelte .astro`. A `.md` or `.txt` that *discusses* placeholder media is prose about pages, not a
page — and the denial reasons themselves quote the banned literals, so an unscoped rule would deny
the model writing down why it was denied.

**Known uncovered path, stated rather than implied closed:** a heredoc write through `Bash`
(`cat > index.html <<EOF`) carries no `content`/`new_string`/`new_source` key and is not scanned.
Layer 2 and grading still see the result.

## 4. Layer 1 — the rules that ship

Each carries an `id`, a `source`, and a `reason` written as an instruction the model can act on.

1. **`AS-PLACEHOLDER-IMAGE`** [spec §8] — a URL authority of `picsum.photos` / `placehold.co`, or the
   path `unsplash.com/random`. Anchored to the URL shape, so `https://images.unsplash.com/photo-…`
   (a *chosen* photograph) is a near-miss that must ALLOW.
2. **`AS-LOREM-IPSUM`** [spec §8] — `lorem ipsum` / `dolor sit amet` as adjacent words.
3. **`AS-PURPLE-PINK-GRADIENT`** [spec §8] — a CSS gradient function whose stops include one hue in
   the purple band and one in the pink/magenta band, or a Tailwind `from-{violet,purple,indigo}-N`
   near a `to-{pink,fuchsia,rose}-N`. Hue is computed from the literal, so blue→teal and orange→red
   ALLOW.
4. **`AS-GRADIENT-TEXT`** [craft-floor] — the **pair**, inside one declaration block or one class
   run: `background-clip:text` (or `-webkit-`) with `color:transparent` /
   `-webkit-text-fill-color:transparent`; Tailwind `bg-clip-text` with `text-transparent`. Either
   half alone ALLOWS.
5. **`AS-COLORED-BORDER-SIDE`** [craft-floor] — `border-left` / `border-right` /
   `border-inline-start` / `border-inline-end` above 1px carrying a colour; Tailwind `border-l-N`
   (N ≥ 2) with a colour utility. `border-top` and a 1px rule ALLOW; `transparent` /
   `currentColor` ALLOW.
6. **`AS-TIGHT-TRACKING`** [craft-floor] — `letter-spacing` tighter than −0.04em, in `em`/`rem` only.
   Abstains on `px` (not comparable without a font size). `-.03em` — correct-portfolio's actual
   value, note the missing leading zero — ALLOWS, and `-0.04em` exactly ALLOWS: it is the floor.
7. **`AS-EYEBROW-EVERYWHERE`** [craft-floor] — three or more tracked-uppercase eyebrow shapes in one
   written file. One or two ALLOW: *"one named kicker is a system; an eyebrow everywhere is grammar
   you did not choose."*
8. **`AS-INTER-SLATE-DEFAULT`** [spec §8] — Inter as the leading family **and** the slate ramp
   (Tailwind `slate-N` or the slate hexes) **and** no custom type-scale signal. Ships only if it
   measures clean; §7 says what happens if it does not.

## 5. Layer 1 — the rules that are EXCLUDED, and the measurement that excludes them

Recorded as findings, not omissions.

| Not shipped | Why — measured where it says measured |
|---|---|
| display type capped at 6rem [craft-floor] | **MEASURED false positive.** `calibration/correct-portfolio/style.css` is `font-size:clamp(3rem,9vw,7rem)`. A GOOD artefact. |
| centred hero over three cards [spec §8] | **MEASURED false positive.** correct-portfolio is `<header class="hero">` plus exactly three `<article class="project">`. |
| zero-offset shadow halo [craft-floor] | The canonical `:focus-visible` ring **is** the banned shape (`0 0 0 3px <colour>`), and Tailwind's `ring-*` utilities compile to it with no selector in the written text at all. Cannot separate decoration from an accessibility affordance at write time. |
| contrast ≥4.5:1 [craft-floor] | Needs the rendered page. `VIS-CONTRAST-FLOOR` grades it. |
| body measure 65–75ch [craft-floor] | craft-floor's own words: *"Read the computed values."* |
| nested cards / cards-as-page-structure [craft-floor] | Needs the document tree; a hook sees text. `VIS-LAYOUT-SCAFFOLD` grades it. |
| motion poverty [listed under spec §8 Layer 1] | A single write cannot see the page's total motion. **This is Layer 2's job**, and it is done there. |

## 6. Layer 2 — the completion gate

`Stop` and `SubagentStop`. Pure decision over the workspace's artefact files.

- **Abstains** when the workspace has no web surface — a CLI or library build must not be gated on
  motion.
- **Abstains** when `stop_hook_active` is true. Both inputs carry it; it is the SDK's own
  re-entrancy flag and ignoring it is how a completion gate loops.
- **Satisfied by ANY of** (spec §8 Layer 2, and §7.1a's staging — video is one satisfier among
  three, never a requirement, so nothing here waits on Phase 2c):
  scroll-scrubbed `currentTime = f(scroll)`; a real GSAP/ScrollTrigger timeline (pinned, scrubbed,
  staggered); rAF-driven element scrubbing; a Framer `useScroll`/`useTransform` drive.
- **Failed by** hover/fade/`transition-all` alone, or an animation library imported and never driven.
- **Bounded**: after 2 blocks it escalates and allows, same reason as Layer 1.
- **OPT-IN (`DASHBOARD_MOTION_BAR=1`), off by default — REVISED after measurement.** It shipped
  always-on for one commit. Then `decideMotion` was run over `dashboard/src` — *this repo's own
  client*, the surface spec decision #6 dogfoods — and returned `unsatisfied`. Always-on would
  therefore block a legitimate build of a working internal UI: a rule firing on correct work, one
  layer up from Layer 1's corpus. The spec already scopes the bar: §8 Layer 2 says "a **frontend
  agent**" and "derived from the **design stills**" (there are none before Phase 2b), and §6.5
  carves out the internal admin CRUD screen by name. Phase 2b's lane routing is what flips it on.
  **This is degrade-don't-block, not a disabled feature — but it is stated plainly rather than
  rounded up to "Layer 2 ships enforcing."**
- **One hook instance, two slots.** The escalate-after budget lives in the closure, so two
  instances would give `Stop` and `SubagentStop` independent budgets.

Both directions come from fixtures this phase did not author: `calibration/correct-portfolio`
(Georgia, warm palette, IntersectionObserver + `requestAnimationFrame` + stagger) must PASS;
`calibration/stock-motion-only` (Inter, slate, hover box-shadow and an opacity fade, nothing
scroll-driven) must FAIL.

**Which return value gates completion — MEASURED, arms 3 and 4.**
`StopHookSpecificOutput` carries only `additionalContext`; `prevent_continuation` is a field on
`SDKInformationalMessage` — what the SDK **emits** when a Stop hook denied continuation, not what a
hook returns. Coding to it would have produced a hook that returns cheerfully and gates nothing.
Paired live arms, one session each:

| return | hook fired | assistant turns |
|---|---|---|
| `{continue: true}` (baseline) | 1 | 1 |
| `{decision: "block", reason}` | 2 | **2** — the second responding to the reason text |

`decision: "block"` makes the model **keep working with the reason in hand**, which is what §8
Layer 2 asks for. The baseline arm is what makes the second number mean anything. No
`prevent_continuation` informational message appeared in either arm; recorded because it is the
claim the typings tempted us into.

## 7. Measuring the false-positive rate — and the check that stops FP=0 being free

A ruleset that matches nothing scores a perfect false-positive rate. That is this project's recorded
signature defect, aimed at the exact number the task asks for. So the harness
(`dashboard/server/antislop-corpus.mjs`) reports **two** counts per rule and **exits non-zero on
either**:

- **False positives** — hits over `dashboard/server/src`, `dashboard/server/calibration/**`, and
  `dashboard/**` client sources. `calibration/correct-portfolio` is called out separately: a hit
  there is a shipping blocker, because it is a GOOD artefact and a rule that fires on it will fire
  on real work.
- **True positives** — hits over a corpus the rules were not written against: the bad calibration
  fixtures, plus the repo's own rule-bearing prose (`visual-criteria.ts` and the spec necessarily
  contain `picsum`, `placehold.co`, `unsplash.com/random`, lorem ipsum, "purple-to-pink"). **Any
  shipped rule with zero true positives anywhere fails the harness.** That is what catches the
  silent no-op — e.g. a rule reading `content` when `Edit` actually sends `new_string`.

Self-hits in rule-definition text are reported as such and are **never** a reason to loosen an
anchor. Recorded because a previous rule in this codebase matched the English word "fit" inside CSS
`object-fit`: anchors are to shape — a URL authority, a declaration, a hue band — never to a
substring.

## 8. Mutation — both directions, executed

For **every** shipped rule: construct the violation it targets, confirm the hook DENIES; construct
the legitimate near-miss named beside it in §4, confirm the hook ALLOWS. Unit tests drive the real
`PreToolUseHookInput`, with the real `tool_name` and the real key (`content` / `new_string` /
`new_source`), through the chained matcher `buildOptions` hands the SDK — not a fresh matcher a test
built for itself, which is `settings-plumbing.test.ts` again.

Live probe (`dashboard/server/antislop-probe.mjs`, on the owner's subscription login; `probes/` is
another agent's directory and is not touched):

| Arm | Observation |
|---|---|
| armed | one violating Write and one clean Write **in the same session**: the violating file is ABSENT on disk, the clean file is PRESENT, and the denial reason arrives as an `is_error` tool_result |
| control | byte-identical prompt, anti-slop chain disarmed: the violating file is PRESENT |
| stop | a Stop hook returning `{decision:"block", reason}` once — does the session continue, or end? Settles §6's unmeasured return shape |

The filesystem is the observation because it cannot be faked by a model narrating success.

## 9. Files

| Path | Change |
|---|---|
| `dashboard/server/src/builders/antislop-rules.ts` | new — Layer 1 rules + scanner, Layer 2 pure motion decision |
| `dashboard/server/src/builders/antislop-hook.ts` | new — `chainPreToolUse`, `makeAntiSlopHook`, `makeMotionStopHook` |
| `dashboard/server/src/builders/antislop-rules.test.ts` | new |
| `dashboard/server/src/builders/antislop-hook.test.ts` | new |
| `dashboard/server/antislop-corpus.mjs` | new — the FP/TP harness of §7 |
| `dashboard/server/antislop-probe.mjs` | new — the live probe of §8 |
| `dashboard/server/src/builders/claude-builder.ts` | edit — register the chained slot and the Stop hooks |

Tests run under a private outDir (`dist-antislop`) per the house rules; `calibration.test.js` needs
Docker and fixtures this task does not own and is excluded, and that exclusion is stated in the
result rather than rounded up to a pass.

---

## 10. RESULTS — what was measured

### 10.1 False positives — 97 artefact files, `bakeoff/` excluded (unstable, another agent is rebuilding it)

| corpus | files | hits |
|---|---|---|
| `calibration/correct-portfolio` (GOOD) | 3 | **0** |
| other calibration fixtures (known bad) | 14 | 1 — `AS-INTER-SLATE-DEFAULT` on `stock-motion-only/style.css`, a TRUE positive |
| `dashboard/server/src` | 58 | 6, **all in the files that define or grade the rules** |
| `dashboard/src` (client) | 22 | 0 |

Per rule, `FP / onCorrectPortfolio / self-reference / truePositives`:

```
AS-PLACEHOLDER-IMAGE     0 / 0 / 1 / 2     AS-COLORED-BORDER-SIDE   0 / 0 / 0 / 1
AS-LOREM-IPSUM           0 / 0 / 4 / 5     AS-TIGHT-TRACKING        0 / 0 / 1 / 2
AS-PURPLE-PINK-GRADIENT  0 / 0 / 0 / 1     AS-EYEBROW-EVERYWHERE    0 / 0 / 0 / 1
AS-GRADIENT-TEXT         0 / 0 / 0 / 1     AS-INTER-SLATE-DEFAULT   0 / 0 / 0 / 2
```

**Zero rules fire on `correct-portfolio`.** Outside the six self-reference hits (in
`antislop-rules.ts`, its test, and `visual-criteria.ts` — the files that necessarily contain the
banned literals) and the one true positive on a known-bad fixture, the ruleset is silent across the
whole repo.

**Stated rather than rounded up:** `AS-PURPLE-PINK-GRADIENT`, `AS-GRADIENT-TEXT`,
`AS-COLORED-BORDER-SIDE` and `AS-EYEBROW-EVERYWHERE` have **constructed-only** evidence — they fire,
their near-misses are allowed, but no file in the corpus violates them, so they are unproven against
text this phase did not author. The harness prints this every run.

### 10.2 The two exclusions of §5 are now MEASURED, not asserted

Both were implemented as mutations, run, and confirmed to fire on the GOOD artefact:

```
AS-DISPLAY-CAP        correct-portfolio/style.css: font-size:clamp(3rem,9vw,7rem)   harness exit 1
AS-HERO-THREE-CARDS   correct-portfolio/index.html: hero + 3 cards                  harness exit 1
```

### 10.3 Mutations executed, all of them

| # | Mutation | Observed |
|---|---|---|
| A | `TEXT_KEYS`: `new_string` → `new_str` | 8 × `WIRING FAILURE … via Edit`, exit 1 |
| B | ship the 6rem display cap | `FALSE POSITIVE` on correct-portfolio, exit 1 |
| C | tracking anchor −0.04em → −0.02em | near-miss `-.03em` flagged **and** false positive on correct-portfolio, exit 1 |
| D | ship centred-hero + 3 cards | `FALSE POSITIVE` on correct-portfolio, exit 1 |
| E | remove `makeAntiSlopHook` from the chain in `claude-builder.ts` | the Layer-1 WIRING test fails |
| F | remove the `Stop`/`SubagentStop` registration | the Layer-2 WIRING test fails |

Restored after each; harness green and 340/340 tests green at the end.

### 10.4 The live probe — `antislop-probe-result.json`

| arm | observation |
|---|---|
| **armed** | the model **attempted** the violating write; `hero.html` **absent** on disk; `about.html` **present** — selectivity inside one session; the denial arrived as an `is_error` tool_result naming `AS-PLACEHOLDER-IMAGE`, citing `spec §8 Layer 1`, quoting `picsum.photos`, and stating the remedy |
| **control** | byte-identical prompt, anti-slop link removed → `hero.html` **present and containing `picsum.photos`**. This is what makes "absent" mean something |
| **stop-baseline / stop-block** | see §6 |

`layer1: PASS` (positive **and** negative control). Both layers observed firing in a live session.

### 10.5 Layer 2 got the same corpus treatment — and it changed the code twice

`decideMotion` is a ninth rule, and the one that gates *completion*, so it is measured over real
corpora rather than only the two fixtures it was written for:

```
  3 files  satisfied    calibration/correct-portfolio (GOOD)
  3 files  unsatisfied  calibration/stock-motion-only (BAD)
  2 files  unsatisfied  calibration/missing-section
  3 files  unsatisfied  calibration/reward-hacked
  3 files  unsatisfied  calibration/broken-build
  2 files  unsatisfied  calibration/stub-markers
  1 files  unsatisfied  calibration/blank-page
 60 files  abstain      dashboard/server/src (non-web node package)
 22 files  unsatisfied  dashboard/src (THIS REPO'S CLIENT)  <- reported, not gated
```

**Two corrections came out of this, both from the measurement rather than from review:**

1. `.css`/`.scss` were in the web-surface set. A constructed near-miss — a CLI of `src/index.ts` +
   `report.css` + `README.md` — came back `unsatisfied`, i.e. a program that prints a styled report
   told to add a scroll-scrubbed video. **A stylesheet is evidence something is styled, never that
   something is a page.** Removed; the harness now fails if it creeps back (mutation G).
2. `dashboard/src` came back `unsatisfied`, which is why the hook is opt-in. See §6.

### 10.6 Mutations on the second pass

| # | Mutation | Observed |
|---|---|---|
| G | put `.css` back in the web-surface set | `MOTION FAILURE — a CLI that ships a stylesheet got "unsatisfied"`, exit 1 |
| H | motion bar always-on, flag ignored | the OFF-by-default half of the WIRING test fails |
| I | motion bar never arms | the ARMED half of the same test fails |
| J | two motion-hook instances instead of one shared | the shared-budget assertion fails |

### 10.7 What is NOT measured

- **Bash heredoc writes are not scanned.** `cat > index.html <<EOF` carries none of the three text
  keys. Layer 2 and grading still see the result; Layer 1 does not.
- **A write whose tool carries no recognisable path key is not scanned** — a deliberate fail-open,
  because guessing that an unknown key is a filename is how a craft gate denies legitimate work.
- **`AS-EYEBROW-EVERYWHERE` counts within one file only.** A component library that spreads three
  eyebrows across three files passes it.
- **Layer 2 has no live end-to-end arm** — the block/continue behaviour of the return value is
  measured, but no live session was run in which a real motion-poor build was blocked and then
  fixed. The decision itself is exercised against nine corpora (§10.5).
- **Six of the eight rules have no independent true positive.** `AS-PLACEHOLDER-IMAGE`,
  `AS-PURPLE-PINK-GRADIENT`, `AS-GRADIENT-TEXT`, `AS-COLORED-BORDER-SIDE`, `AS-TIGHT-TRACKING` and
  `AS-EYEBROW-EVERYWHERE` fire only on text **this phase authored** (`[constructed]` and
  `[own-source]`). They fire, their near-misses are allowed, and the wiring is proven — but no
  pre-existing file in the corpus violates them. Only `AS-LOREM-IPSUM` (`visual-criteria.ts`) and
  `AS-INTER-SLATE-DEFAULT` (`stock-motion-only`) have evidence from another hand. The harness
  prints this every run.
- **`AS-INTER-SLATE-DEFAULT`'s third conjunct is per-file, and that is its residual risk.** A real
  Tailwind project with `--font-sans: Inter` plus slate in `globals.css` and its type scale in
  `tailwind.config.ts` would be denied twice before escalating, because the hook only ever sees the
  file being written. Zero hits on `dashboard/src` is real evidence it is not firing here, but it is
  the one shipped rule whose false-positive risk lives *outside* the file the hook can see.
- **`calibration.test.js` was not run** (Docker plus fixtures this task does not own).
