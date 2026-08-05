# Motion capture — design, 2026-08-04

Read a reference site's ANIMATION into deterministic words a text-only spec seat can
author from, and then MEASURE the built site against those numbers inside the sealed
scorer. Capture and enforcement, not capture alone.

Every anchor below was opened and read. Where a claim could not be measured in this
session it says so, in the sentence that makes it.

---

## 0. WHAT WAS DECIDED, AND BY WHOM

Five decisions were the owner's, taken 2026-08-04 before any code was designed:

| decision | choice |
|---|---|
| scope | capture **and** enforce at the gate |
| fidelity | parity within a tolerance band, not "same character" |
| families | all four proposed, plus "and more" — the extended list in §3 |
| link intake | its own field, motion-only; the brief's own URL keeps its meaning |
| weak families | tier explicitly — parity families gate, presence-only families report |
| provenance | a THIRD bucket: *traced to your reference* |

Everything else below follows from those five plus what the code turned out to be.

---

## 1. THE MEASUREMENTS THIS DESIGN RESTS ON

Four spikes were run this session against real pages and the real sealed image. They
are throwaway scripts in the session scratchpad, not repository code, and they exist
because three of the four contradicted the obvious design.

### 1.1 `document.getAnimations()` is BLIND to the libraries that matter

gsap.com — the reference implementation of scroll animation — returns **8** animations
at load, decaying to **0**, and **0 running at every one of six scroll offsets**. GSAP
writes inline styles from `requestAnimationFrame` and never registers with the Web
Animations API. Framer Motion, Lenis and Locomotive behave the same way.

**A capture built on the animation API would report "this site has no motion" for
exactly the sites worth referencing.** The extractor therefore samples OBSERVED
computed style per animation frame. This is the single most important finding here.

### 1.2 Durations reproduce; absolute start times do not

Two cold runs of the same page, normalized and compared:

```
run A   li.header__menu-item | opacity   | 150ms | start 200ms
run B   li.header__menu-item | opacity   | 150ms | start 600ms
run A   div.home-hero__flair | transform | 1000ms| start 950ms
run B   div.home-hero__flair | transform | 1000ms| start 950ms
```

Durations were identical across runs. Start times drifted 200 ↔ 600 ms, because they
are measured from when sampling began, which depends on network and parse timing.

**Consequence, and it is a hard rule: the brief may carry duration, property set and
sibling stagger. It may never carry an absolute start time.** Volatile bytes in the
brief re-mint the ticket id and re-author the acceptance suite on every submission.

### 1.3 An init script roughly quadruples coverage

Sampler installed via `addInitScript`, before any page script runs, against the same
page: **21 distinct moving elements versus 5** for a sampler that starts at
`domcontentloaded`. A hero entrance that runs during parse is invisible to the later
start. Init-script installation is not a refinement; it is most of the coverage.

### 1.4 Host and sealed container agree within 4%, at 2.3× different frame rates

The same sampler, the same fixture page, run on the host and inside
`bakeoff-scorer:1` with `--network=none`:

| measurement | host | container | declared |
|---|---|---|---|
| hero entrance | 796 ms | 799 ms | 800 ms |
| card reveal ×3 | 499 / 500 / 498 | 483 / 481 / 485 | 500 ms |
| frames sampled in 2.5 s | **355** | **151** | — |
| parallax at scrollY 400 / 800 / 1200 | 100 / 200 / 300 px | 100 / 200 / 300 px | exact |
| hover transition | changed, 0.25 s | changed, 0.25 s | 250 ms |

The container renders at less than half the host's frame rate and durations still
agree within **3.8% worst case**, because duration is derived from timestamps rather
than frame counts. Scroll-linked values are integer-exact.

**A ±40% tolerance band therefore sits about ten times above the instrument's noise
floor.** A failure inside that band is a real design difference. This is what makes
"parity" a mechanism rather than a hope.

---

## 2. THE THREE FINDINGS THAT CHANGED THE DESIGN

### 2.1 The existing container capture is configured to see NO motion

```
bakeoff/src/scorer-container.ts:633      reducedMotion: "reduce",
bakeoff/src/scorer-container.ts:678          animations: "disabled",
```

A motion probe that clones `captureFlows`' context options measures zero, and zero
passes a tolerance band trivially. That is a probe which can only observe success —
this repository's signature defect, sitting at the exact line a new probe would be
written against.

**Rule:** the probe opens its OWN context at `reducedMotion: "no-preference"`, and it
ships with two fixtures — one with motion, one with motion disabled — so the probe is
proven able to return both answers before it is trusted with either.

### 2.2 QUALITY cannot gate, so enforcement must be a GATE

```
bakeoff/src/contracts.ts:268    export type CriterionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";
bakeoff/src/contracts.ts:1438   const gating = criteriaResults.filter((c) => c.tier === "BLOCKING" || c.tier === "FUNCTIONAL");
dashboard/server/src/visual-criteria.ts:71    readonly tier: "QUALITY"; // owner decision: report, never block
```

Every visual criterion is QUALITY by an owner decision, and the tier is a LITERAL type
precisely so that decision cannot erode. A motion criterion authored on that surface
can never affect `heldOutPass`. The only channel with teeth is a gate:

```
bakeoff/src/scorer.ts:1169   container.tier0.map((gate) => gateToCriterion(gate));
```

### 2.3 A gate that always exists is a silent green

```
bakeoff/src/scorer.ts:1253   if (gate.outcome === "not_applicable") {   // → passed: true
```

`not_applicable` passes. A motion gate present on every ticket would report
`not_applicable` — and therefore GREEN — on every ticket that has no motion reference.
`unknown` maps to `passed: false` and would fail all of them instead.

**Rule: the gate is EMITTED ONLY when the plan carries a motion baseline.** A gate
absent from `tier0` is not a failing gate, which is the behaviour wanted here. This
also leaves `stock-motion-only` (`dashboard/server/src/calibration/fixtures.ts:269`,
committed as `pass_with_notes` / QUALITY — an artefact whose recorded expectation is
that motion must NOT gate) untouched, so calibration stays green.

### 2.4 A gate is BLOCKING and there is no way to ask for less

```
bakeoff/src/scorer.ts:1256      tier: "BLOCKING",      // not_applicable branch
bakeoff/src/scorer.ts:1264      tier: "BLOCKING",      // every other outcome
```

`gateToCriterion` stamps BLOCKING on both branches, unconditionally. There is no
per-gate tier and no FUNCTIONAL option without changing a function every other gate
shares.

**Taken naively this contradicts the tolerance band.** A ±40% band exists because a
difference inside it is not worth arguing about; a gate that fails the entire run
because one hover transition measured 41% off is a stricter instrument than the band
describes, and it would fail runs for reasons the owner would overrule every time.

**Resolution: the gate is an AGGREGATE judgement, and the per-family numbers ride
QUALITY findings where they can be read without gating.** `GATE:motion-parity` fails
when EITHER:

1. the **load-entrance** family is outside band — the one family a visitor cannot
   miss and the reason a reference was supplied at all; or
2. **more than half** the captured parity families are outside band.

Both thresholds are CHOSEN, NOT MEASURED. Nothing has run that could calibrate them.
They are named constants so a measured change is a one-line change, following the
convention `plan-question.ts` already sets for its own uncalibrated numbers.

Every family's measured-vs-captured pair is emitted as a QUALITY finding regardless of
the gate's verdict, so a run that passes still shows exactly how far each family
drifted. The alternative — one gate per family, each BLOCKING — was rejected: it makes
the verdict's severity depend on how many families the reference happened to use, which
is a property of their site rather than of ours.

---

## 3. THE FAMILIES

Ten hold to parity. Two are presence-only and say so in their own text.

**Parity (numbers compared, gate-bearing):** load entrance · scroll reveal ·
scroll-linked scrub · hover/focus · ambient loops · split-text stagger · SVG path draw ·
smooth-scroll inertia · magnetic/cursor-follow · 3D tilt.

**Presence only (measured as "it exists and it repaints", never compared):**
route transitions — needs the built site to have a client router and two routes, and
the numbers are flaky even when it does; canvas/WebGL ambient — pixels can be proven to
change every frame, resemblance cannot be proven at all.

Presence-only observations ride the existing QUALITY-finding channel, which already has
a `passed: true` precedent in `sealed_network_request_blocked`. Their text states what
was measured *and what was not*, so the verdict never claims more than it checked.

---

## 4. ARCHITECTURE

```
POST /api/runs { motionUrl }
        │
        ├─ captureMotion()  ── host, headless chromium, bounded ─┐
        │                                                        │
        ├─ motionBrief()  → deterministic text ──→ ticket.brief ──→ spec seat (text only)
        │                                          └→ referenceIdentityMaterial (id)
        │
        └─ motion.json  → reference manifest ──→ builder + design lane prompts
                                    │
                                    └→ ScorerPlan.motionBaseline
                                                │
                          sealed container ─────┴──→ GATE:motion-parity
                                                     (own context, no-preference)
```

Five units, each independently testable:

| unit | file | one job |
|---|---|---|
| `motion-capture.ts` | dashboard/server/src | drive the browser, return a raw reading |
| `motion-spec.ts` | dashboard/server/src | raw reading → normalized, quantized spec (PURE) |
| `motion-brief.ts` | dashboard/server/src | spec → brief prose (PURE) |
| `motion-probe.ts` | bakeoff/src | measure the built site in the container |
| `motion-compare.ts` | bakeoff/src | baseline + measurement → gate result (PURE) |

Four of the five are pure functions over data. Only `motion-capture.ts` and
`motion-probe.ts` touch a browser, and they are the two that need real-browser tests
rather than seam tests — see §7.

### 4.1 THIS IS TWO PLANS, AND THE SPLIT IS THE PROTOCOL BOUNDARY

**Plan A — capture, host-side only.** `motion-capture.ts`, `motion-spec.ts`,
`motion-brief.ts`, the `motionUrl` field and its opt-out, the client control, the
manifest field, the third provenance bucket (§6), the form-notice rewrite (§8). Touches
**zero** files under `bakeoff/`. No protocol bump, no image rebuild, no recalibration.

**Plan B — enforcement.** `GATE:motion-parity`, `motion-probe.ts`, `motion-compare.ts`,
`ScorerPlan` + `parseScorerPlan`, `ContainerResult` + `parseContainerResult`,
`GATE_IDS`, `GATE_LABELS`, protocol version 1 → 2, image rebuild, the two new
calibration fixtures (§7.2, §7.3).

**Why the split is at that line and not somewhere convenient.** A protocol bump makes
`calibration.test.ts` red until the image is rebuilt, and calibration FAILS rather than
skips when the image does not match (`calibration.test.ts:94-119`). A single plan would
spend its whole middle in a tree whose suite cannot go green, which is precisely the
state in which "measure the baseline before touching anything" stops being usable.
Plan A keeps calibration green from first commit to last.

**The second payoff is ordering.** Plan A's output IS Plan B's input. Capturing a real
reference site and reading the normalized spec it produces tells you whether it says
anything worth enforcing — BEFORE the thing that enforces it is written against a guess
about its shape. Plan B should not start until one real capture has been read by a human.

---

## 5. DETERMINISM — WHAT MAY ENTER THE BRIEF

The brief is hashed into `sha256` and, with the attachment digests, into the ticket id:

```
dashboard/server/src/ticket.ts:240   id: ticketIdFor(referenceIdentityMaterial(brief, images, documents)),
dashboard/server/src/ticket.ts:244   sha256: ticketDigest(brief),
```

**Allowed in the brief:** family · element role · property set · duration bucketed to
50 ms · sibling stagger bucketed to 20 ms · easing family (one of six named curves) ·
direction · iteration count · a scroll-linked ratio rounded to two decimals.

**Only the duration bucket is backed by a measurement.** §1.2 measured duration
stability across cold runs; it did not measure stagger stability or ratio stability.
The 20 ms stagger bucket and the two-decimal ratio are CHOSEN, NOT MEASURED, and Plan
A's determinism test (§7.4) is what calibrates them — if either wobbles across two cold
captures of the same page, the bucket widens until it does not. Stated here rather than
discovered later, because a number that looks measured and is not is the failure this
whole document keeps circling.

**Forbidden in the brief:** absolute start times (§1.2) · raw floats · frame counts ·
element counts that depend on viewport · any path or filename · any sentence naming an
attachment. The last two are already enforced for the existing capture at
`ticket-refs.ts:26-30`, and naming an artefact the spec seat cannot open produces
criteria graded for reasons nothing can trace.

**Identity rules, both load-bearing:**

1. The motion digest enters `referenceIdentityMaterial` ONLY. It must never widen
   `sha256`, which `assertTicketUnedited` (`bakeoff/src/spec-agent.ts:654`) requires to
   be exactly `ticketDigest(brief)`.
2. Whatever is folded in at intake must be persisted in the manifest and read back by
   `ticketFromStoredReferences`. `ticket.ts:278-288` records a live instance of this
   exact defect class: the mismatch does not fail to compile, does not throw, and
   silently authors a SECOND suite on the owner's quota.

---

## 6. PROVENANCE — THE THIRD BUCKET

The assumptions tracer is fed `ticketProse(stripPlanBlock(ticket.brief))`
(`dashboard/server/src/orchestrator.ts:2679`), which strips the capture block back off
before token matching. Without a change, every motion criterion counts as INFERRED and
the run log escalates to `warn` — the feature would move its own headline metric the
wrong way.

Owner decision: a third provenance, *traced to your reference*, distinct from both
"inferred by the grader" and "traced to words you wrote". `assumptions.md` then reads
`3 traced to your words, 6 traced to your reference, 1 inferred`, and
`inferredCriteria` stays an honest measure of what nobody specified.

---

## 7. THE NEGATIVE CONTROLS — NON-NEGOTIABLE

This design ships with the probes that can fail, or it does not ship.

1. **Motion-present / motion-absent fixture pair.** The probe must return non-zero
   against a page with known motion AND zero against the same page with animations
   disabled. Without the second, §2.1's defect is undetectable.
2. **A calibration artefact that fails ONLY the motion gate** and passes everything
   else. `fixtures.ts:29-42` records what its absence produces verbatim: *"an inert
   check and a working one produced the same output"* at 7/7 green.
3. **A calibration artefact whose motion is correct**, so the gate is shown to pass for
   a reason rather than by default.
4. **A determinism test**: the same fixture captured twice must produce a byte-identical
   normalized spec. This is the test that would have caught §1.2 before it cost quota.
5. **A no-baseline test**: a plan with no motion baseline must emit NO motion gate —
   asserting absence, not `not_applicable`.

---

## 8. HAZARDS INHERITED FROM THE EXISTING CODE

Each was read this session and each will bite the implementation if unhandled.

- `PLAN_FORBIDDEN_KEYS` (`bakeoff/src/scorer-protocol.ts:873`) rejects `config`,
  `model`, `status`, `usage`, `messages`, `transcript` at ANY depth. A baseline
  structure using those key names throws before the container runs.
- A field added to `ScorerPlan` but not to `parseScorerPlan` is DROPPED without error —
  and the gate then legitimately has no baseline, which is §2.3's silent green again.
- `SCORER_PROTOCOL_VERSION` is checked for equality. Any wire change is a version bump
  plus an image rebuild (`--provenance=false --sbom=false`) plus recalibration.
- `attributeCriteria` matches a criterion's REQ-id as a token in the test's TITLE PATH
  and consults nothing else. On record at `spec-validate.ts:1369-1381`: 24 of 24 tests
  passed and all 12 criteria came back `unasserted`.
- `GATE:` and `QUALITY:` are reserved prefixes; `REQ_ID_PATTERN` is `/^REQ-\d{3}$/`.
  A `MOTION:`-style id would be routed through the ticket-token tracer and stamped
  INFERRED — the defect the `QUALITY:` branch exists to fix.
- `ticketProse` strips everything after the LAST `CAPTURE_BLOCK_BEGIN`, so a second
  block appended after the capture block is stripped along with it.
- The site-capture budget test asserts an EXACT timeout count and an EXACT sum. New
  timed page calls must move `CAPTURE_BUDGET_MS` in lockstep; an untimed call silently
  inherits playwright's 30 s default, which is a defect that shipped once already.
- Five browser specs assert the whole POST body with `toEqual`. The new field uses the
  conditional-spread convention at `page.tsx:342-343`.
- A new `RunDetail` field not hand-added to the client mirror compiles clean on both
  sides, serialises, arrives, and never renders. `references`/`documents` shipped that
  way on 2026-08-02 with the suite at 1165/1163 green.
- `playwrightLaunch` is exercised by NO test. Its import-failure branch has never run.
- The ticket form's existing notice promises *"never a comparison against the live
  page"*. A motion-comparison gate contradicts it; leaving it unedited puts a false
  disclosure on the form. It must be rewritten in the same commit.
- `captureUrl: null` suppresses the site capture only. The motion capture needs its own
  opt-out or that documented opt-out silently becomes partial.

---

## 9. OUT OF SCOPE

- No visual diff, ever. The scorer's `--network=none` seal holds; the built site is
  compared to CAPTURED NUMBERS, never to the live original.
- No video capture of the reference. `gemini-video.sh` exists and this does not use it.
- Multiple reference URLs (the merge-conflict rule is real design work — deferred).
- Motion on the design lane's mockups. Stills stay stills.

---

## 10. CORRECTIONS FOUND WHILE MAPPING

Not part of this feature; found by reading and recorded so they are not lost.

1. `dashboard/server/src/spec-pipeline.ts` **does not exist**. The only
   `spec-pipeline.ts` is client-side and executes nothing.
2. `site-capture.ts:38-48` says playwright is not a declared dependency. **Stale** —
   `dashboard/server/package.json:29` declares it under devDependencies. Still absent
   under `npm install --omit=dev`.
3. `ticket.ts:183` and `ticket-refs.ts:20` both cite `spec-agent.ts:712`; the line is
   now **735**.
4. `computeVisibleHoldoutGap` (`spec-types.ts:599`) is **dead code** — defined,
   re-exported, called by nothing. The reward-hacking metric has never been computed.
5. `withoutScripts` does not strip `<style>` despite its docblock saying it does.
6. `bakeoff-scorer:1` is now `b7a9fd0a`; the digest `STATE-2026-08-02` calls "current"
   (`fae56a4e`) is now tagged `pre-specmode`. The §2 re-score question has three
   candidate images, not two.

---

## 11. CARRIED FORWARD (not dropped)

- **Move `runs.db` from local SQLite to Neon via MCP** (owner, 2026-08-04). Note for
  whoever picks it up: the database is **not** in OrbStack — it is a SQLite file at
  `dashboard/data/runs.db` (585 KB, verified). Docker hosts only the sealed scorer.
  The work is a SQLite → Postgres migration of `db.ts` plus every call site, not a
  container move. Route through the `postgres` and `postgres-database-migration`
  skills per CLAUDE.md.
- The §2 `GATE:boot` re-score of `…052c6e02`, now against three candidate images.
- Everything already listed in `docs/STATE-2026-08-02-end-to-end.md`.
