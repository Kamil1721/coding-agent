# Design fidelity gate — spec

**Date:** 2026-08-05
**Status:** design, not built. Nothing in this document is wired.
**Supersedes nothing. Narrows one decision (§3) and honours the open recommendation in
`docs/superpowers/specs/2026-07-30-visual-substance-resolution.md` §6 (see §11).**

---

## 0. THE ONE FACT THAT REORDERS EVERYTHING

**There is no visual gate. There never has been.** Not "at the wrong tier" — absent.

```
dashboard/server/src/design-prompt.ts:877     visualGatePrompt(...)          zero non-test callers
dashboard/server/src/visual-substance.ts:668  evaluateVisualSubstance(...)   zero non-test callers
dashboard/server/src/visual-substance.ts:904  renderVisualSubstanceReport()  zero non-test callers
dashboard/server/src/run-report.ts:429        renderVerdict(verdictInputFor(source))  never sets visualFindings
dashboard/server/src/verdict.ts:151           readonly visualFindings?:      optional, never populated in production
```

The code already says so, twice, independently of this review:

```
dashboard/server/src/run-report.ts:259-261       "nothing in the dashboard pipeline evaluates visual-criteria.ts yet"
dashboard/server/src/calibration/grade-fixture.ts:418-421  "calibration would stay green with the visual-criteria path dead"
```

Confirmed against the only passing run: `grep -rlo 'VIS-' dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb`
returns nothing, and there is no `review/visual-gate.md` in any run on disk.

So `VIS-F-EMPTY-FRAME` and `VIS-F-EMPTY-REGION` do not gate — **not because of `shadowLocked`
and not because of the mode flag, but because nothing constructs the `VisualSubstanceRecord`
that carries them.** Both levels of the lock (`visual-substance.ts:371-376`) are guarding a
door in a wall that has no house behind it.

**Consequence for this spec:** the first shipping unit is a CALL SITE, not an observation.
Adding an entry to `VISUAL_OBSERVATIONS` before §7's Wave A lands is furniture for a house
with no floor, and it is this repository's signature defect in its strongest form — a check
that can only be observed passing because it is never run.

---

## 1. THE OBSERVATIONS

### 1.0 The decision, up front

**Exactly ONE new entry joins `VISUAL_OBSERVATIONS`, and a model does not answer it.**
Two further checks ship, and neither belongs in that file: one is a deterministic static
scan (§1.3), one is a report at design-lock time (§1.4).

Every other fidelity candidate eight investigators proposed was measured against the artefacts
on disk and **fires on the one build that ever passed**. They are enumerated as rejected in §2.2
so they are not re-proposed as new — the same service `2026-07-29-visual-substance-design.md` §6
performs for the invented-numeric-bar family.

### 1.1 The line that decides membership

> **An observation may gate iff its answer is a two-valued fact or a count of zero, and the
> standard it is measured against is either the artefact itself or a value the run RECORDED
> BEFORE THE BUILD BEGAN.**

Having a locked reference does not make a question objective — it makes it *comparable*, and a
comparison returns a **distance**, which needs a threshold nobody set. "Uses the reference's
palette" returns a distance and cannot gate. "Inverted the reference's polarity" returns a bit
and can.

**A gate may read bits. A report may read distances.**

### 1.2 VIS-F-REF-GROUND-INVERTED — the one new entry

| field | value |
|---|---|
| `id` | `VIS-F-REF-GROUND-INVERTED` |
| `tier` | literal `"FUNCTIONAL"` |
| `shadowLocked` | `true` at ship (§1.2.4 states the unlock condition) |
| `corroboration` | `null` — the pixel answer IS the measurement (§1.2.2) |
| `answeredBy` | **`"measurement"`** — new field, see §1.2.2 |
| `question` | "The design that was locked for this run has a DARK ground. Does the delivered page render a LIGHT ground — or the mirror: the locked design has a LIGHT ground and the page renders a DARK one?" |
| `nonTrigger` | "Must NOT fire on: a different shade of the same polarity, however far apart — charcoal against near-black is not an inversion; a page whose ground sits near the middle of the lightness axis, which is `unknown` rather than either answer; a light section inside a dark page or the reverse, because the subject is the page's own ground and not any band within it; any run with no locked mockup, where there is no referent and the observation is not emitted at all." |
| `why` | "The locked mockup is an artefact on disk that a named agent chose with a recorded reason (`results/design-lock.json`), before the build began. Whether the delivered page is dark-on-light or light-on-dark is not a matter of taste, a house style, or the grader's mood — it is the single largest, least arguable statement a design makes, and a build that inverts it did not build the design that was chosen. A reader who disagrees about whether a palette is muddy will not disagree about whether the page is dark." |

#### 1.2.1 The mechanism, exactly

Two grounds, both measured host-side with the same function:

1. Decode the image (`sharp`, `fit: inside`, longest edge 160px).
2. Quantise to 16 levels per channel (`v >> 4`), count pixels per bucket.
3. The **ground** is the centroid of the largest bucket. Record its area share.
4. Convert to CIELAB. `L*` is the only channel read.

Let `Lref` = ground of the locked mockup, `Lbuild` = ground of the delivered page's capture
at the widest breakpoint (1280×800).

```
POLARITY_MIDPOINT = 50           // the definition of the CIELAB lightness axis midpoint, not a chosen number
POLARITY_MARGIN   = 15           // CHOSEN, NOT MEASURED. Named constant; see §1.2.3
GROUND_MIN_SHARE  = 0.20         // CHOSEN, NOT MEASURED. Named constant; see §1.2.3

unknown  if lockedMockup === null                      → observation NOT EMITTED (§1.2.5)
unknown  if refGroundShare < GROUND_MIN_SHARE           → reason: ref_has_no_ground
unknown  if |Lref - 50| < MARGIN or |Lbuild - 50| < MARGIN → reason: ground_polarity_ambiguous
violated if sign(Lref - 50) !== sign(Lbuild - 50)
satisfied otherwise
```

`unknown` is non-passing and non-gating (`verdict.ts:260-277` counts only
`verdict === "violated" && gating && declaredTier === tier`), so every ambiguous case degrades
to "does not fire", never to "fires". That direction is deliberate and matches
`corroborate()`'s own rule at `visual-substance.ts:557-607`: nothing here can manufacture a red.

#### 1.2.2 `answeredBy: "measurement"` — why a model must NOT answer this

`VISUAL_OBSERVATIONS` is currently a set of questions handed to a grader and parsed back
(`parseVisualObservationAnswers`, `visual-substance.ts:806-866`). This entry does not use that
path, and the reason is the file's own rule:

> asking a model what two recorded numbers already answer is the mistake this file exists to avoid.

Worse, a model answering from pixels alone reintroduces the exact false-fail class the
corroboration rule was built to kill: a correct build with a full-bleed dark hero over a light
body reads dark in the frame and light in the DOM.

So: add `readonly answeredBy: "grader" | "measurement"` to `VisualObservation`. A deterministic
producer constructs `VisualObservationAnswer` values directly and hands them to
`evaluateVisualSubstance` — the record shape, the two-level lock, the boundary guard
(`assertNoScreenshotReference`), the report renderer and the `verdict.ts` wiring are all reused
unchanged. **Membership is still never decided by a model**, which is the invariant at
`visual-substance.ts:26-29`.

`visualObservationBlock()` (`visual-substance.ts:1012-1065`) MUST filter to
`answeredBy === "grader"`. Handing a grader a question whose evidence it does not have is how
the tree acquires a finding generator.

#### 1.2.3 The three constants, named as chosen

`POLARITY_MARGIN` and `GROUND_MIN_SHARE` are **CHOSEN, NOT MEASURED**. Nothing on disk exercises
the ambiguous band — both real mockups sit at the extremes (`L* 5.9` and `L* 95.6`). They are
named constants so a measured change is a one-line change, following the convention
`2026-08-04-motion-capture-design.md` §2.3 set for its own uncalibrated thresholds and
`plan-question.ts` set before it.

`POLARITY_MIDPOINT = 50` is **not** in that category: it is the midpoint of the CIELAB lightness
axis by the colour space's definition, not a number about this ticket.

#### 1.2.4 Calibration against the real artefacts — MEASURED, first-hand

Measured 2026-08-05 with `sharp` from `dashboard/node_modules`, on read-only run directories:

| pair | ground | L* | verdict |
|---|---|---|---|
| locked mockup `01-hero.png` | `rgb(20,19,15)` = `#14130f`, share **33.5%** | **5.9** | — |
| known-good build (`styles.css:8` `--bg: #1c1a17`) | `#1c1a17` | **9.4** | **satisfied** (same side, dE 3.6) |
| palette-inverted mutation of the same build (`--bg: #f8fafc`) | `#f8fafc` | 97.6 | **violated** (dE 92.4) |
| 2026-07-30 build vs its own reference | `#eef3f9` L* 95.6 vs `#ffffff` | both light | **satisfied** |

Two other mockups from the same locked set, for the share floor: `02-services.png` ground
`rgb(20,20,14)` share 45.2%; `03-hours.png` ground `rgb(19,20,14)` share 32.4%. All three clear
`GROUND_MIN_SHARE`.

**It does not fire on the known-good build**, and the separation between the correct pair and
the inverted mutation is ~25×. Area 1 and Area 6 reached the same numbers by two independent
harnesses (a Playwright render and a `sharp` quantiser); this section reproduces them a third
time from the declared CSS value at `styles.css:8`, which removes the renderer from the loop
entirely for the build half.

**The honest weakness, stated rather than buried:** the *fire* direction has never been
exercised by a real artefact. Both runs that carry a reference match its polarity. The positive
control is a synthetic mutation. That is why the entry ships `shadowLocked: true`.

#### 1.2.5 Emitted only when a baseline exists

**Rule, taken directly from `2026-08-04-motion-capture-design.md` §2.3:** the observation is
emitted only when the run carries a non-null `lockedMockup`. An observation absent from the
record is not a failing observation.

This is not fastidiousness. `scorer.ts:1253` maps `not_applicable` to `passed: true`; a fidelity
check present on every ticket reports GREEN on every ticket that supplied no design, which is a
gate that can only observe success. It also leaves every calibration fixture untouched — none of
the eight carries a locked mockup (`calibration/fixtures.ts:107,159,179,197,217,250,269,368`) —
so the standing calibration stays green by construction rather than by luck.

#### 1.2.6 Unlock condition (what moves `shadowLocked` to `false`)

Both of:

1. **A fixture pair that inverts its own locked still** exists and is committed — built as a
   ONE-DECLARATION mutation of a correct fixture, never as a second directory. `hollow-section`
   is the pattern (`calibration/hollow-section/style.css:7`, `var(--paper)` ↔ `var(--ink)`):
   "a second directory drifts from the first and a mutation cannot."
2. **Shadow mode has accumulated a rate on real runs** — at least five runs carrying a locked
   mockup, zero `violated` outcomes on runs the owner accepted. One pass is not a rate
   (`2026-07-30-visual-substance-resolution.md`, on `VIS-F-EMPTY-REGION`).

Until both hold, the entry records and reports and contributes zero.

### 1.3 R4-ORIGIN — asset provenance, and it does NOT go in `VISUAL_OBSERVATIONS`

A grep question is not a pixel question. This ships as a **deterministic host-side static scan**
in its own module, whose findings enter the report at **FUNCTIONAL**.

**Subject:** the positions a browser FETCHES, and nothing else —
`img/source/video/audio/track/script/iframe/embed/object/use/input` on `src|srcset|poster|data|href`;
`<link href>` for `stylesheet|preload|prefetch|modulepreload|icon|apple-touch-icon|manifest|mask-icon|preconnect|dns-prefetch`;
CSS `url()` and `@import`, including inline `<style>`.
**Never** `<a href>`, never a namespace URI, never prose, never `canonical`/`og:url`/JSON-LD.
`data:` and `blob:` are local.

**Three finding kinds:** `remote_subresource` (absolute or scheme-relative origin),
`subresource_escapes_workspace`, `subresource_missing`.

**Override:** hosts named in the OWNER'S ticket are allowed, read from `runs.ticket_text` with
`runs.ticket_sha256` as the seal — **never** from `workspace/TICKET.md`, which sits inside
`sandbox.filesystem.allowWrite: [workspace]` (`builders/claude-builder.ts:1034`). A builder that
wants a CDN can otherwise authorise its own CDN in one `Write` call and the gate becomes
decorative.

**Calibration, already executed by Area 9 against real artefacts:** 0 findings on the known-good
2026-07-29 build; 0 on the 2026-07-30 build; 8/8 on real violations applied to a *copy* of the
good build (google-fonts `<link>`, unsplash `<img>`, jsdelivr `<script>`, protocol-relative
`//cdnjs`, css `url()` to gstatic, `@import` typekit, missing local `<img>`, `../../../Pictures`
escape); 0/4 on legitimate near-misses (a new outbound `<a href>`, `svg xmlns="http://…"`, a
`data:` URI, canonical + og:url + JSON-LD); green again on revert.

The 2026-07-30 build is the false-fail control that matters: it carries `github.com` and
`linkedin.com` anchors and four self-hosted `woff2` files, and it must pass. **Any regex over
`https?://` fails it outright.**

**This check is an EXCLUSION and must never become positive proof of generation.** The positive
form — "every shipped asset traces to a recorded `gemini-image.sh` output" — **fails the one
build that ever passed**: all six calls wrote into `design-refs/`, none into `assets/`, and the
two shipped jpgs are *crops* of the mockups (NCC 0.973 at offset (688,87) and 0.984 at (82,66);
MAD ≈ 2.4/255), which no md5 can see. That is `§6`'s "At least N images" wearing a
cryptographer's coat.

### 1.4 OWNER-REF-GROUND — R1, at the lock, and it reports rather than gates

See §4. Same measurement as §1.2, different pair: **locked mockup vs the owner's supplied image**,
evaluated at design-lock time. Report-only, permanently for now, because zero artefacts on disk
have ever exercised the owner-image branch.

---

## 2. WHAT STAYS AT QUALITY

### 2.1 Genuine taste — reports forever, never blocks

These keep their literal `"QUALITY"` tier in `visual-criteria.ts:71` and keep appearing in the
gate prompt's taste half (`design-prompt.ts:885-897`), unchanged:

- the palette is muddy · the type pairing is weak · the motion is stock · the copy reads like an
  LLM trying to sound thoughtful · the hierarchy is flat · the spacing rhythm is uniform
- `VIS-REF-LAYOUT`, `VIS-REF-PALETTE`, `VIS-REF-TYPE` (`visual-criteria.ts:163-187`) —
  **the whole comparison stays QUALITY.** §1.2 promotes ONE binary clause already inside
  `VIS-REF-PALETTE`'s statement text (`:176-181`, "light or dark taken from the locked still
  rather than re-picked by category"). The criterion itself is not moved, not narrowed and not
  duplicated; it keeps reporting the full comparison including everything §1.2 cannot see.
- `VIS-MEDIA-REAL`'s judgement half (`visual-criteria.ts:145-153`) — whether the photograph is
  any good. Its string-list half is now also covered deterministically by §1.3, from a different
  direction (URL origin, not watermark).

### 2.2 Rejected on measurement — each fires on the CORRECT artefact

Written down so they are not re-proposed as new. **Every row was measured against
`dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/`, the only build that ever
passed.**

| candidate | why it dies |
|---|---|
| palette-value match to the locked still | ground differs by 8/255 per channel, accent by 7/255, on a build that *honoured* the system (`styles.css:1-5` names it and cites `design-refs/direction.md`). Any tolerance tight enough to catch a build that ignored the still fails the build that honoured it. |
| "the reference's palette is present in the build" (top-K nearest-neighbour) | **REJECTED AS INERT.** Survives a total palette inversion at dE ≤ 12 — the unchanged hero photograph still supplies every dark cluster. A check that passes its own mutation is worse than none. |
| "no colour in the build that is absent from the reference" | the brand accent `#b3481f` sits 44.8 dE from the mockup's top-12 clusters purely because it occupies 1.32% of the frame. Fires on the correct build. |
| typography matches the still | the passing build loads **no webfont at all** — zero `@font-face`, zero `fonts.googleapis`, `-apple-system` at `styles.css:22` — and its own `direction.md` locked that choice. |
| composition matches the still | at 375×812 the correct build stacks the photograph below the CTA while the still is side-by-side (`styles.css:502-518`). Fires on a correct responsive build at every breakpoint but the still's own aspect. |
| "no pixels lifted from the reference" | **BOTH** shipped photographs are crops of the mockups (§1.3). The build that passed did this. The most seductive fidelity rule in the set, and it fails the only success. |
| build text matches the still | `02-services.png` invents €39/€29/€19; `TICKET.md:4` states no prices. The still is authoritative for form, the ticket for content. |
| "a still-named section is absent" | already relegated at `2026-07-29-visual-substance-design.md` §5.1, and not answerable from a viewport capture. |
| em-dash ban (taste-skill's self-declared #1 Tell) | 5 em/en dashes in the good build's visible text, including `<title>` (`index.html:6,77,79,129`). |
| eyebrow cap (max 1 per 3 sections) | 3 eyebrows over 3 regions — **and the locked mockup renders them**. This is fidelity, not slop. |
| hand-rolled-SVG-icon ban | 5 inline `<svg>`, 6 `<path>`, zero library markers — and `02-services.png` specifies exactly those three drawn marks. Also in **direct conflict with R4**: taste-skill §3.C/§9.E requires an icon library, R4 forbids one. R4 wins. |
| default/system font stack · three-equal-cards · `100vh` not `100dvh` · no max-width container · symmetrical vertical padding | all four fire on the good build (`styles.css:171,178,215,221`), and three of them are specified by the locked mockup. |
| emoji-as-iconography | naive form fires on the good build's CTA glyph U+2197 ↗, which is visibly in the mockup. The `\p{Emoji_Presentation}` form separates cleanly (0/0/3) but is a **house-style ban**, not a fidelity check — a ticket that asks for emoji makes it a false fail. QUALITY at most. |
| C2PA content credentials required on shipped images | present on 5/5 refs from 2026-07-29, **absent on 7/7 correctly generated refs from 2026-07-30**. Fails correct work. Record it when present; never require it. |
| uniform section rhythm · single visual weight | length thresholds in disguise. `§6`'s ink-coverage row already rejects the shape: "a whitespace metric with a technical costume". |
| icon-library name markers as a **gate** | a substring blocklist; `claude-builder.ts` already names that family ("the list is never complete"). QUALITY, where an incomplete list costs nothing. |

### 2.3 The R1/R2 structural conflict, recorded

Because R4 forces every reference to be Gemini-generated and one to be locked, **the mockups
themselves contain what the anti-slop skills call slop**: a tracked uppercase eyebrow over every
section, three equal columns, hand-drawn line icons. Any anti-slop rule promoted to FUNCTIONAL
will fail builds for faithfully reproducing the owner's own chosen design.

**Rule: a fidelity check never adjudicates between the reference and a style skill. The
reference wins.**

Corollary, and it is a live contradiction in shipped code:
`builders/antislop-rules.ts:259-270` tells the builder verbatim that "a specific chosen
photograph, e.g. an `images.unsplash.com/photo-...` URL, is fine". Under R4 it is not.
`~/.claude/skills/redesign-skill/SKILL.md:43` instructs the agent to use `picsum.photos`.
**Both must be reconciled before §1.3 ships, or the pipeline instructs the builder to do the
thing the gate then fails it for.** This is the "capability belongs in the system" rule: a
workaround that lives in a prompt the owner writes is a bug in the pipeline.

---

## 3. THE REVERSAL, STATED PLAINLY

### 3.1 What was decided on 2026-07-28

```
2026-07-28-orchestration-canvas-design.md:36    decision #9 — "Animation gate reports at QUALITY
                                                 tier, never blocks. Subjective judgement shouldn't
                                                 false-fail a run."
visual-criteria.ts:14-18                        "QUALITY, AND NEVER ANYTHING ELSE… A false fail on
                                                 taste burns a fix round the run cannot win, and
                                                 worse, it teaches the owner that red does not mean stop."
verdict.ts:32-36                                "Rendering subjective judgement in red trains the
                                                 owner to ignore red, and an ignored red badge is
                                                 worse than an unreported note."
```

That decision was about **the reliability of a signal**, not about how much the owner cares
about taste. Nothing in any of the three sources says taste is unimportant.

### 3.2 The decision was two propositions welded together

**(a) Subjective judgement reports and never blocks.** — the owner's, and correct.
**(b) Everything living in `visual-criteria.ts` is subjective.** — never measured, and false.
`VIS-REF-*` compare the build against a specific PNG on disk that a named agent chose with a
recorded reason (`results/design-lock.json`, 90 words, `lockedBy: "ui-designer"`). They carry a
**referent**. They are in the QUALITY set by co-location, not by measurement.

### 3.3 DECISION — 2026-08-05

> **Decision #9 is NARROWED, not reversed.**
>
> **PRESERVED, with its literal type intact:** subjective judgement reports and never blocks.
> `visual-criteria.ts:71` keeps `readonly tier: "QUALITY"` as a LITERAL. The taste half of the
> gate prompt keeps telling the grader so in the text it reads. R2 (no slop) does **not** become
> a gate; §2.2 is the measured reason why it cannot.
>
> **NARROWED:** a comparison against a locked, recorded reference is not taste. One binary,
> deterministically measured clause of it (§1.2) may reach FUNCTIONAL, and asset origin (§1.3),
> which is a grep and not a judgement, may reach FUNCTIONAL.
>
> **The test that replaces the file boundary:** *a check may gate iff its referent is an artefact
> on disk that the run did not author for the purpose of being graded, and its answer is a bit or
> a count of zero.*

**This is the third time the same exception has been carved, and the first two did not reverse
the decision either.** 2026-07-29: `visual-substance.ts:21-32` admits objective observations at
FUNCTIONAL — "they answer *did you build the thing*, never *is it nice*". 2026-08-04:
`2026-08-04-motion-capture-design.md` §2.2 routes parity against the owner's own reference site
into a tier-0 gate, explicitly because "the only channel with teeth is a gate".

**Where this is recorded:** a dated line beside decision #9 in
`2026-07-28-orchestration-canvas-design.md` §3, and the same paragraph at the head of
`visual-substance.ts`. **Do NOT widen `visual-criteria.ts`'s tier union to achieve this.**

---

## 4. FIDELITY TO THE OWNER'S OWN IMAGE (R1)

### 4.1 Today it cannot reach the grader, and that is enforced in code

```
dashboard/server/src/http.ts:1935-1945    owner image → runs/<id>/references/reference-N.<ext>, sha256'd
dashboard/server/src/design-lock.ts:123   lockManifest refuses any path not already in manifest.refs
dashboard/server/src/design-manifest.ts:467  readRef returns null for any path outside <workspace>/design-refs/
```

The owner's image lives **outside** `design-refs/`, so it can never be a ref and therefore never
`lockedMockup`. The gate — when it exists — grades against a **generated** mockup. "Follow the
design I gave you" is ungateable by construction.

And the chain never seeds from it: `design-prompt.ts:343-345,349` passes the **previous sibling**
image with `-i`, not the owner's. `ticket-refs.ts:754-757` says so in its own words: "nothing
checks that a mockup resembles the reference, and no code path fails a lane that ignores this
block."

### 4.2 The fence must NOT be widened — and it does not need to be

The fence exists because ref paths arrive from an **agent-written manifest**: "an unvalidated
absolute path there is a file-read primitive with a prompt attached" (`design-manifest.ts:9-13`).

The owner's reference path does not come from an agent. It is written by host code at
`http.ts:1935-1945`, digested, and recorded in `references/references.json`. **The fence's
purpose is fully preserved by a slot that only host code can populate.**

**DECIDED:** a new module `owner-reference.ts` exposes `ownerReferenceFor(runId)` reading
`runs/<id>/references/references.json` and returning `{path, sha256}` for image entries only.
It is **not** part of `manifest.refs`, is **not** lockable, and no agent-authored value ever
reaches it. `design-manifest.ts` is not modified.

### 4.3 What R1 actually gets: OWNER-REF-GROUND, at the lock, reporting

**The highest-value R1 check is not build-vs-mockup. It is mockup-vs-owner-image, at lock time.**
If the generated mockups do not resemble what the owner supplied, the chain is already wrong and
no build-vs-mockup check ever catches it — and at lock time the correction costs one regeneration
instead of 24 minutes of building plus fix rounds.

So: run the §1.2.1 measurement over (locked mockup, owner reference). Emit it into
`results/design-lock.json` and into `verdict.md` as a QUALITY note:

> "The design locked for this run has a DARK ground; the reference you attached has a LIGHT one."

**It reports and never gates, and the reason is not caution — it is that no artefact on disk has
ever exercised this branch.** The owner-image prompt block (`ticket-refs.ts:683`) has never
rendered in any run: the only `prompt.txt` carrying that heading belongs to the 2026-07-30 run,
whose `references.json` opens `"images": []` — that was the **capture** branch at `:671`. The one
run that did attach an image (`run-2026-08-04T11-08-10-487Z-162b186d`) died in SPEC with an empty
workspace.

**Stated honestly: R1 as the owner phrased it — "it builds the design I provided" — cannot be
gated today, and the nearest achievable thing is a report that tells him, before an hour of
building, that the design being built is not the one he pointed at.** Anything stronger would be
calibrated against nothing.

**Unlock path for making it gate:** three runs that attach an image and reach a lock, with the
measured pair recorded in shadow. Then the §1.2.6 bar applies unchanged.

---

## 5. THE FIX ROUTE

A gate whose failures cannot be routed produces a run that fails forever. The route already
exists and is one parameter short.

### 5.1 The class and the agent already exist

```
gate-report.ts:46-61     FailureClass includes "visual"
fix-triage.ts:33-42      ROUTES.visual = "taste-frontend-expert"   (total Record — a new class will not compile without a route)
gate-report.ts:284       klass: VISUAL_DOM_KINDS.has(finding.kind) ? "visual" : "logic"
```

### 5.2 The merge point — and the two wirings that fail silently

`toAgentVisible(container)` (`gate-report.ts:224`) takes a `ContainerResult` and nothing else.
**DECIDED:** it gains a second, optional parameter carrying host-side findings:

```ts
toAgentVisible(container: ContainerResult | null, hostFindings?: readonly HostFinding[])
```

Both wirings anyone will reach for first are wrong, and each fails in a different direction:

- **Through `verdict.ts` alone** → the loop reads a `ContainerResult`, sees green, stops after
  **zero fix rounds**, while the run's verdict says fail. A passing loop and a failing product.
- **Through `criterionCoverage` as a FUNCTIONAL criterion** → reaches the fixer only as a per-tier
  **count**, synthesised with `klass: "logic"` (`fix-triage.ts:64-80`), routed to `debugger`, with
  detail stating the criteria are deliberately unavailable. The design specialist never sees it.
- **Through a new `DomFindingKind`** → the union is closed and parsed strictly
  (`scorer-protocol.ts:1095-1103,1298-1300`); an unknown kind is a hard parse failure, and it
  would require a scorer rebuild for a fact the host already knows.

### 5.3 Redaction

A visual `FixableFailure`'s `detail` is **built from source literals only**:

- the observation's owner-facing label from the constant table (`visual-substance.ts`, the same
  table `verdict.ts` renders and *not* `outcome.note`),
- the flow id and breakpoint,
- the two measured `L*` values and the locked mockup's **basename** — never its path.

`assertNoScreenshotReference` (`visual-substance.ts:511-529`) MUST be called on every visual
detail before it enters the report. `gate-report.ts` has no equivalent guard today (only
`MAX_DETAIL = 1200`), and `domFindings.detail` / `exploitFindings.detail` already cross to a fix
prompt **verbatim with no allowlist** — the leak test's poisoned fixture does not plant a title
in either carrier. This is a pre-existing hole; §1.2's detail must not widen it.

**Held-out titles are structurally impossible here** — a visual finding never touches the suite.
Naming the observation id or its question leaks nothing new: the whole enumerated set is already
disclosed to the builder at `design-prompt.ts:942`. Naming a **capture or mockup path** would
breach a boundary `visual-substance.ts` enforces and `gate-report.ts` does not.

### 5.4 The shortlist trap

`partitionByPermission` sends work to `denied` when the agent is not in the run's shortlist, and
an empty `runnable` stops the loop as `not-converging` (`gate-fix-loop.ts:219-225`).
`taste-frontend-expert` is only shortlisted when the design lane runs (`agent-shortlist.ts:222`,
`design-lane.ts:104-107`) — true for all four real tickets, false for a fullstack ticket with a
UI but no visual vocabulary.

**RULE: if a run has a non-null `lockedMockup`, `taste-frontend-expert` is in the shortlist.**
A run that locked a design and then cannot route a fidelity failure is a run that fails forever
for a permissions reason, reported under a word that says "convergence".

Also note `fixAllowedAgents(task)` narrows a round to ONE agent — a visual fix that needs backend
work will be done by the design specialist or not at all. Accepted for now; recorded.

---

## 6. THE BOUND FOR AN OVERNIGHT RUN

Measured inputs: the gate itself costs **13.1 s** (passing run) and **30.1 s** (failing run,
dominated by the 30 s boot timeout). The passing run was 105 min: spec 79.5, build 24.4, gate
14.5 s, judge 47 s. Each fix round **resumes the same builder session**
(`orchestrator.ts:4770`), so the scarce resource is context, not gate time. No run has ever
performed a second gate attempt, so a fix round's duration has never been measured.

**DECIDED — four bounds, in the order they bite:**

| bound | value | rationale |
|---|---|---|
| `DEFAULT_MAX_ATTEMPTS` | **3 → 6** | 3 has never been reached. 6 doubles the budget without doubling context pressure on one resumed session; the owner has already lost a run to a 64k output-token ceiling. Env override `DASHBOARD_GATE_MAX_ATTEMPTS` keeps its 1..10 refusal band. |
| loop wall-clock budget | **240 min**, checked before each fix round | Derived from the 24.4-minute build phase — six rounds of roughly one build each, plus slack. **CHOSEN, NOT MEASURED**; named constant. New stop reason `time-budget`. |
| no-progress detector | strict-decrease over a **3-round window** on the ordinal pair `(gatingUnmet, failures.length)` | see §6.1. |
| literal-repeat catch | the existing fingerprint equality, **kept** | it catches the byte-identical case the ordinal test cannot. |

### 6.1 Why the existing detector must be replaced, not tuned

`fingerprint()` (`gate-fix-loop.ts:123-133`) is exact equality over free text, compared only
against the immediately previous round. **On the one real failing artefact in this tree it is
defeated:** `GATE:boot`'s detail embeds a poll count and elapsed ms
(`scorer-container.ts:426`). Measured — with only those jittering and a no-op fixer, the loop ran
all 10 attempts and stopped at `retry-cap`; byte-identical, it stopped at attempt 2.

It is a **change** detector, not a **progress** detector: one round of memory (A→B→A→B never
fires) and ordinally blind (5 failures becoming 5 different ones reads as progress; 3 becoming 7
reads as progress).

### 6.2 Two stop reasons that lie, and are split

- `cancelled` covers an owner abort **and** a provider rate-limit abort (`orchestrator.ts:4664-4667`),
  persisted identically to the run row. A run meant to resume is recorded as one the owner stopped.
  → split out `rate-limited`.
- `not-converging` covers fingerprint equality **and** "no fix task this run's shortlist permits"
  (`gate-fix-loop.ts:219-225`) — the second is a permissions problem. → split out `no-permitted-fixer`.

**Both stop-reason changes touch `orchestrator.ts`, which the recovery workflow owns. Sequence,
do not parallelise (§7, Wave D).**

### 6.3 The honest caveat about "overnight"

**Raising the loop's bound does not deliver R3.** The only overnight attempt stalled **8 h 39 m
at a segment boundary** — design lane complete at 21:09:57, no event until the owner intervened
at 05:49:28 — **before the gate ever ran**, with `rate_limited = 0`. The newest 10,645-char ticket
died in SPEC at 52 minutes on a 64k output-token ceiling, `gate_attempts = 0`. Those are the
recovery workflow's, not this spec's. Say so to the owner rather than implying a gate bound fixes
an unattended run.

---

## 7. WAVES — disjoint file lists

Every wave builds with the no-clobber pattern:
`cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-<LANE> && node --test "dist-<LANE>/**/*.test.js"`.
Never `npm test`. Calibration always with `DASHBOARD_CALIBRATION_ROOT=$(mktemp -d)` (§10).

### Wave A — THE CALL SITE (blocks C and D; nothing gates until it lands)

`dashboard/server/src/visual-gate-run.ts` *(new)* · `visual-gate-run.test.ts` *(new)*

Builds a `VisualSubstanceRecord` from a completed run and hands `visualFindings` to
`verdictInputFor`. Ships in `"shadow"` mode. **Two seam decisions it must make:**

1. **Frame identity.** `VisualFrame` is `{flowId, breakpoint}` and the parser rejects unknown
   frames (`visual-substance.ts:832-836`), while `design-prompt.ts:906-907` instructs a
   per-SECTION capture at the mockup's aspect. **DECIDED: frame means `{flowId, breakpoint}`,
   the scorer's meaning.** §1.2's measurement is per-page, not per-section, so it needs only the
   1280×800 flow capture the container already writes. The per-section instruction stays in the
   grader prompt for the QUALITY half, which is not frame-keyed.
2. **The one line in `orchestrator.ts`** that calls this module is **OUT OF SCOPE for Wave A** —
   `orchestrator.ts` belongs to the recovery workflow. Wave A ships the module and its tests;
   the call line is sequenced afterwards with that workflow's owner.

### Wave B — R4-ORIGIN (fully independent; start immediately)

`dashboard/server/src/asset-origin.ts` *(new)* · `asset-origin.test.ts` *(new)*

Port the prototype at `/tmp/r4probe/r4check.mjs` (known defect to fix: `@import url("…")`
double-counts because both scanners see it — dedupe by `(file, url, where)`). Enumerate files
with `readWorkspaceTree` (`code-files.ts:448`). Tests run against a **copy** of the run workspace;
never modify a run directory.

### Wave C — THE MEASUREMENT AND THE ENTRY (after A)

`dashboard/server/src/design-fidelity.ts` *(new)* · `design-fidelity.test.ts` *(new)* ·
`dashboard/server/src/visual-substance.ts` · `visual-substance.test.ts`

`design-fidelity.ts` owns `groundOf(imagePath)` and `polarityAnswer(refPath, capturePath)`.
`visual-substance.ts` gains the `answeredBy` field, the new entry, its label-table row, and the
`visualObservationBlock` filter. **Adding an entry turns `visual-substance.test.ts:98` and `:108`
red until they are updated — that friction is intended.** Keep `:127` ("at least one entry is
UNLOCKED — otherwise the mode flag is decoration") satisfied.

**Requires `sharp` as a DECLARED dependency of `dashboard/server`.** Measured 2026-08-05:
`grep -n sharp dashboard/server/package.json dashboard/package.json` returns **nothing** — it
resolves transitively from `dashboard/node_modules` today, which is how §1.2.4's measurements were
taken. A transitive resolution is not a dependency and will vanish on an unrelated upgrade. Declare
it, or implement `groundOf()` with a hand-rolled PNG/JPEG decode and pay that cost instead.

### Wave D — THE ROUTE AND THE BOUND (after A; C-independent)

`dashboard/server/src/gate-report.ts` · `fix-triage.ts` · `gate-fix-loop.ts` ·
`gate-report.test.ts` · `fix-triage.test.ts` · `gate-fix-loop.test.ts`

`toAgentVisible`'s second parameter, the `HostFinding → FixableFailure` mapping with
`assertNoScreenshotReference` on the detail, the ordinal no-progress detector, the wall-clock
budget, the two stop-reason splits. **The stop-reason vocabulary is read by `orchestrator.ts:4706`
— coordinate before landing.**

### Wave E — THE OWNER REFERENCE (fully independent; start immediately)

`dashboard/server/src/owner-reference.ts` *(new)* · `owner-reference.test.ts` *(new)*

`ownerReferenceFor(runId)`. Reads only; `design-manifest.ts`, `design-lock.ts`, `ticket-refs.ts`
and `http.ts` are **not** modified. Consumed by Wave C's measurement for §4.3's report.

### Wave F — THE FIXTURE PAIR (after C; unblocks the §1.2.6 unlock)

`dashboard/server/calibration/inverted-ground/**` *(new)* — a correct build carrying a locked
still, plus the ONE-DECLARATION mutation that inverts its `:root` ground.
**Not added to `FIXTURES` until it grades as declared THROUGH THE CONTAINER** — `hollow-section`'s
predicted tier was measured wrong, and adding it turns two assertions red in a file another lane
may own.

### Collision map

| file | wave |
|---|---|
| `visual-substance.ts` / `.test.ts` | **C only** |
| `gate-report.ts` / `fix-triage.ts` / `gate-fix-loop.ts` + tests | **D only** |
| `asset-origin.*` | **B only** |
| `owner-reference.*` | **E only** |
| `design-fidelity.*` | **C only** |
| `visual-gate-run.*` | **A only** |
| `calibration/inverted-ground/**` | **F only** |
| `orchestrator.ts`, `db.ts`, `api-types.ts`, `recovery.ts` | **NOBODY** — recovery workflow |
| `dashboard/src/**`, `dashboard/tests/**` | **NOBODY** — copy sweep |
| `bakeoff/**` | **NOBODY** — no scorer or protocol change is required by this spec (§8) |

---

## 8. OUT OF SCOPE

1. **Any change to `bakeoff/`.** §1.2 is measured host-side from the capture PNG the scorer
   already writes, which is why no `getComputedStyle(body).backgroundColor` field, no
   `SCORER_PROTOCOL_VERSION` bump and no `docker build` is needed. This was a live design fork;
   host-side won because it measures what is *visible* rather than what is *declared* — a
   full-bleed dark hero over a light body reads dark in pixels and light in the DOM.
2. **Unlocking `VIS-F-EMPTY-REGION`.** It needs the region's `getBoundingClientRect()`, which is a
   scorer change. Its cheap alternative (a `nonTrigger` wording clause,
   `2026-07-30-visual-substance-resolution.md` §6.2) is a separate decision.
3. **`VIS-F-PLACEHOLDER-MEDIA`'s fate.** §11.
4. **Ticket→criterion coverage.** Area 5 measured an under-covering suite passing
   `deterministicAudit` with 0 findings, yielding `heldOutPass = true` and `falseFinish = false`.
   Real and serious, and a §6-family trap if gated. Its one gateable sibling — a ticket naming an
   HTTP API/status code/persistence while the manifest declares `start: null` — belongs in
   `bakeoff/src/spec-validate.ts`, which is out of scope here.
5. **Unattended failure recovery**, segment-boundary stalls, and the SPEC-phase output-token
   ceiling. Recovery workflow (§6.3).
6. **Reference-vs-build pixel diffing.** Measured impossible four independent ways: the mockups
   are JPEGs named `.png` at 1376×768 ("Could not decode expected image as PNG"), size mismatch is
   a hard fail no `maxDiffPixelRatio` relaxes, baselines are platform-suffixed, and the snapshot
   directory is the read-only 0444 suite mount. A Gemini illustration of a page is not a rendering
   of that page.
7. **Live-run proof of anything.** House rule 10. Everything here is driven from artefacts on disk.
8. **Reconciling `antislop-rules.ts:259-270` and the taste/redesign skills with R4** (§2.3) — a
   contradiction this spec surfaces and does not fix; it needs the owner.

---

## 9. NEGATIVE CONTROLS THE IMPLEMENTATION MUST SATISFY

House rule 1: for each, **apply the mutation to production source, watch it go red, revert, watch
it go green, and report both outputs.** A passing test is not evidence; a test that stays green
under its own mutation is the defect.

| # | check | mutation to PRODUCTION code | must go RED |
|---|---|---|---|
| NC-1 | `VIS-F-REF-GROUND-INVERTED` fires | invert the polarity comparison (`sign(a) !== sign(b)` → `===`) | the known-good Coglane pair (L* 5.9 / 9.4) reports `violated`; the inverted-ground fixture reports `satisfied` |
| NC-2 | …is not inert | delete the entry from `VISUAL_OBSERVATIONS` | the set-membership assertion (`visual-substance.test.ts:98`) and the fixture's fire test |
| NC-3 | the ambiguous band degrades to `unknown`, not to a fire | `POLARITY_MARGIN` 15 → 0 | a synthetic pair at L* 49/51 that must be `unknown` reports `violated` |
| NC-4 | the ground-share floor is live | `GROUND_MIN_SHARE` 0.20 → 0 | a mockup with no dominant ground (largest bucket < 20%) reports a verdict instead of `ref_has_no_ground` |
| NC-5 | emitted-only-when-locked holds | remove the `lockedMockup !== null` guard | every calibration fixture (all eight carry no lock) acquires an outcome; the calibration suite must go red |
| NC-6 | `answeredBy` filtering holds | remove the `answeredBy === "grader"` filter in `visualObservationBlock` | the prompt-content assertion — the measurement entry must never be handed to a grader |
| NC-7 | `R4-ORIGIN` fires | neutralise the remote-origin branch (`return []` from the origin classifier) | all 8 must-fire mutations on the copied workspace |
| NC-8 | `R4-ORIGIN` does not false-fail | widen the subject to any `https?://` in HTML | the 2026-07-30 build (github/linkedin anchors) must go red — proving the narrow subject is load-bearing |
| NC-9 | the ticket override is sealed | read the allowlist from `workspace/TICKET.md` instead of `runs.ticket_text` | a test where the *workspace* ticket names a CDN the *owner's* ticket does not: the finding must survive |
| NC-10 | visual findings reach the fixer | drop the `hostFindings` parameter at the merge point | the routing test asserting `taste-frontend-expert` receives the visual failure |
| NC-11 | the redaction guard is live | remove the `assertNoScreenshotReference` call on visual detail | a test injecting `01-hero.png` into a detail must throw |
| NC-12 | the no-progress detector is ordinal | revert to previous-round equality only | the jittering-`GATE:boot` replay must run to the cap instead of stopping at the no-progress window |
| NC-13 | the wall-clock budget bites | set the budget to `Infinity` | a replay whose rounds exceed 240 min must reach `time-budget` |
| NC-14 | `OWNER-REF-GROUND` never gates | give it a gating tier | the verdict test asserting an owner-reference mismatch leaves `outcome` unchanged |

---

## 10. CALIBRATION PLAN

Both halves, for every check, **before it is allowed to gate**. Passing only the must-not-fire
half is the **M4 defect** recorded in this project's own history: "a gate that fires on nothing
at all also sorts all seven fixtures correctly… emptying `MUST_FAIL` left the gate green at 7/7."

**The bar is BOTH clauses: sorts the committed fixtures correctly AND fires on the bad artefact
AND fires on none of the correct-build set.**

### 10.1 Must-pass (the good artefacts)

- `dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/` — the only passing build.
  §1.2 measured **satisfied** (5.9 / 9.4). §1.3 measured **0 findings**.
- `dashboard/runs/run-2026-07-30T20-16-40-242Z-052c6e02/workspace/` — §1.2 **satisfied** (both
  light), §1.3 **0 findings**. *Not a validated correct artefact* (it was cancelled at 0/16); it
  is a false-fail control only and must not be promoted to a must-pass fixture.
- All eight committed fixtures at `dashboard/server/calibration/` — none carries a lock, so §1.2
  must be **not emitted** on every one (NC-5), and the standing 8/8 container calibration must
  stay green. Baseline measured **2026-08-05: tests 8, pass 8, fail 0, skipped 0, 88.7 s** on
  scorer image `b7a9fd0a`.

### 10.2 Must-fire (the bad artefacts)

- **§1.2:** the Wave F fixture — one CSS declaration inverting the ground against its own locked
  still. Until it exists, the only positive control is the measured synthetic mutation
  (`--bg: #1c1a17` → `#f8fafc`, L* 9.4 → 97.6, dE 92.4). **That is a design, not a calibration**,
  and it is why the entry stays `shadowLocked`.
- **§1.3:** the 8 mutations of §1.3, applied to a **copy** of the known-good workspace.

### 10.3 Blind adjudication does not apply here

`answeredBy: "measurement"` removes the model from §1.2 entirely, so the 171-answer blind
adjudication protocol — and its expensive prerequisite, rebuilding the 10-build adversarial pool
that was never committed — **is not required for this entry.** That is the strongest practical
argument for the measurement form and should not be lost when someone proposes making it a grader
question "for consistency".

### 10.4 Hazards that will corrupt a calibration run

- **`DASHBOARD_CALIBRATION_ROOT` is set by nothing in the repo** (10 grep hits, all prose or
  definitions), and `prepareFixtureDirs` `rm -rf`s `<root>/<fixture>` under a default root of
  `dashboard/results/calibration-4a/`, **which is occupied**. `assertOutsideBakeoff` guards only
  `bakeoff/`; `$HOME` and `/` are accepted. **Always `DASHBOARD_CALIBRATION_ROOT=$(mktemp -d)`.**
- Cleanup needs `chmod -R u+rwX` first — `freezeSuite` chmods the sealed suite to 0444 and plain
  `rm -rf` fails with ~60 permission errors.
- `bakeoff-scorer:1` is now `b7a9fd0a` (2026-08-02); every baseline in the docs and in
  `grade-fixture.ts`'s docblock is against `c98bad3a`, now tagged `bakeoff-scorer:pre-readmech`.
  Re-measure before quoting, or pin `BAKEOFF_SCORER_IMAGE=bakeoff-scorer:pre-readmech`.
- `environmentProblem()` proves only that an image with that tag exists — not that it was built
  from the current tree.

---

## 11. OPEN ITEMS CARRIED FORWARD (rule 7: never drop a deferred item)

1. **`2026-07-30-visual-substance-resolution.md` §6's per-entry recommendation was recorded and
   never applied**: delete `VIS-F-EMPTY-FRAME`'s gating capability, delete
   `VIS-F-PLACEHOLDER-MEDIA`, keep `VIS-F-EMPTY-REGION` locked. All three entries are still
   present, `EMPTY-FRAME` still carries `shadowLocked: false`. **This spec neither honours nor
   supersedes it — it is out of scope (§8.3) and still open.** Whoever next edits
   `visual-substance.ts` must state which.
2. **`visual-substance.ts:49-56` is stale.** It names "until the eighth fixture exists" as the
   blocker for `VIS-F-EMPTY-REGION`; `calibration/hollow-section/` has existed since 2026-07-30
   and `visual-substance.test.ts:522` ("the hollow build fires EMPTY-REGION ALONE, and the restore
   silences it") passes today. The live blocker is the empty-band threshold. That paragraph is
   load-bearing; correcting it is its own decision.
3. **`antislop-rules.ts:259-270` contradicts R4** (§2.3). Needs the owner.
4. **`taste-skill` §3.C/§9.E and `redesign-skill:43` steer the builder into R4 violations** — an
   icon library and `picsum.photos` respectively. They need an R4 override note before they are
   loaded by the build lane.
5. **The build lane is never told image generation is available to it.** The `gemini-image.sh`
   brief is in the DESIGN prompt only (`design-prompt.ts:330-345`); `build-prompt.ts` contains no
   mention. Every precondition for a build-segment call is verified (key on disk, not in
   `STRIPPED_ENV_NAMES`, no `denyRead`, no network allowlist, TMPDIR created) but the arm itself
   is inferred, not measured.
6. **`criterionCoverage[].outcome === "unasserted"`** (`scorer-protocol.ts:1130-1148`) is computed
   and persisted, and nobody checked whether it reaches the verdict page or whether an unasserted
   FUNCTIONAL criterion fails the run. A second, narrower coverage signal that already exists.
7. **Six untraced `live-*.png` captures** sit beside the container's three in the passing run,
   written nine minutes after the gate, produced by no code in `dashboard/server/src`.

---

## 12. WHAT THIS SPEC DOES NOT PROMISE THE OWNER

Stated so nothing downstream overclaims:

- **R1** is not gated. §4.3 is a report that tells him the locked design diverges from his image
  before an hour is spent building it. The gating form has no calibration data and would be a
  check that can only observe success.
- **R2** is mostly not gated, and §2.2 is the measured reason. The owner does not have a slop
  problem one screenshot check can measure; he has a fidelity problem and a provenance problem,
  and both of those are measurable. A build that matches a deliberately art-directed reference and
  ships only generated assets does not read as slop — which is exactly what the one passing build
  demonstrates.
- **R3** is bounded, not delivered. §6.3.
- **R4** ships as an **exclusion** — no remote subresource, nothing escaping the workspace, nothing
  missing — with the best two-directional calibration in this document. **A green R4-ORIGIN does
  NOT mean every asset was generated.** The 2026-07-30 build vendors four Google Fonts `woff2`
  files into `assets/fonts/` and passes cleanly. Reading the check's name instead of its mechanism
  is this repository's recorded signature defect, and it must be said in the docblock and in the
  verdict text.
