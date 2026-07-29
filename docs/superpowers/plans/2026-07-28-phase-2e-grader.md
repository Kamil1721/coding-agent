# Phase 2e — The Grader

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make the acceptance grader trustworthy enough to replace the owner's judgement on an unattended run.

**Architecture:** A capable grader already exists in `bakeoff/src` — `spec-agent.ts` authors the suite, `spec-validate.ts` audits it, `spec-freeze.ts` seals it, and `SealedScorerGate` executes it in a `--network=none` container. This phase does **not** rewrite them. It closes four gaps that appear only when the grader stops serving frozen harness-authored tickets and starts serving the owner's prose while they are asleep.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test`. Reuses the existing spec machinery and the real sealed gate.

---

## REVISION 2 — 2026-07-29. Read this before any task.

Revision 1 was written before the pipeline was mapped. Five measurements invalidated
parts of it. What changed, and why:

### R1. Calibration splits in two, because the fixtures do not measure one thing

Walk the seven fixtures against the pipeline as it actually is:

| Fixture | Where it fails | What that measures |
|---|---|---|
| `broken-build` | `GATE:build` — Tier-0, in-container | the **scoring path** |
| `reward-hacked` | `GATE:no-reward-hack-exploits` — Tier-0 | the **scoring path** |
| `stub-markers` | `GATE:no-stub-markers` — Tier-0 | the **scoring path** |
| `blank-page` | only if authored criteria assert content exists | **criterion authoring** |
| `missing-section` | only if a criterion asserts a contact section | **criterion authoring** |
| `correct-portfolio` | passes only if authored criteria are satisfiable | **criterion authoring** |
| `stock-motion-only` | needs Task 2's QUALITY criteria to exist at all | **criterion authoring** |

Four of seven measure **what the grader decided to check**, not whether the container
checks it correctly. That splits `gradeFixture` and the split is not cosmetic:

- **Commit hand-authored frozen suites next to each fixture** — deterministic, no quota,
  runs in `npm test`. But you would be writing a suite *knowing* `blank-page` must fail
  it. That hardcodes the discrimination it claims to measure. It is the same shape as
  every instance in `probe-needs-negative-control`: a check that can only observe the
  outcome its author already chose.
- **Author suites from `PORTFOLIO_TICKET` at grade time** — real measurement of Gap 4,
  but LLM-driven, nondeterministic, cannot be a standing gate.

**Both are built, and each is labelled for exactly what it proves:**

- **Task 4A — scoring-path calibration.** Committed suites, real sealed container, runs in
  `npm test`. Proves the Tier-0 gates, exploit detection, tier arithmetic and verdict
  rendering behave. It **does not** prove the grader discriminates, and its test names,
  its file header and `STATUS.md` must all say so in those words.
- **Task 4B — authoring calibration.** Authors from the ticket via `spec-agent`, then
  scores. Opt-in behind `GRADER_CALIBRATION_LIVE=1`, lives beside `probes/`. This is the
  one that answers Gap 4. It reports; it never silently skips into green.

The DoD lines "all 7 fixtures grade correctly" and "calibration runs as a standing gate"
were pulling apart. They are now two lines with two owners.

### R2. Assert the tier, not just the outcome

`fixtures.ts:46-50` already says asserting the tier "stops a grader passing calibration
by failing everything for the wrong reason" — and Revision 1's own test then checked only
`v.outcome`. Concretely: `reward-hacked` is a blank artefact carrying a rigged suite. If
`exploitFindings` never inspects artefact-shipped test files, it grades `fail` via unmet
content criteria at FUNCTIONAL while the fixture declares BLOCKING — and calibration goes
green with the entire exploit path dead. **Assert `failingTier`.**

### R3. `pass_with_notes` must be earned, not inferred from absence

If the outcome collapses to `pass` when there are no blockers, or if `visualCriteriaFor()`
returns `[]`, then `stock-motion-only` and `correct-portfolio` become indistinguishable —
and Task 2 can be entirely non-functional with calibration still green. **`pass_with_notes`
requires ≥1 actual QUALITY finding**, derived from findings, never from the absence of
blockers.

### R4. Prove calibration is not vacuous, by breaking it

Before Task 4A is done: gut the content assertions in the committed suites, confirm
`blank-page` flips to `pass` **and calibration goes red**, restore. If calibration stays
green with the criteria gutted, it is testing nothing. Record which mutation produced
which failure, the way Phase 1.1 did.

### R5. The Global Constraints contradicted themselves

Revision 1 said both "extend `spec-validate.ts`; do not fork it" and "`bakeoff/` is off
limits." Resolution, and it is binding: **read anything under `bakeoff/`, compose from
`dashboard/server/src/`, never edit a file under `bakeoff/`.** A check that genuinely
belongs in the shared audit gets recorded in the backlog for the owner, not written.

### R6. `DesignManifest` does not exist

Task 2's signature `visualCriteriaFor(manifest: DesignManifest)` referenced a type from
Phase 2b, which is not built. Task 2 therefore **defines the minimal `DesignManifest`
itself** — the locked-mockup path and nothing more — for Phase 2b to populate later.

### R7. `stub-markers` may fail at a stricter tier than the fixture declares

`GATE:no-stub-markers` is a BLOCKING container gate; `fixtures.ts` declares this fixture
`FUNCTIONAL`. Failing at a *stricter* tier than expected is not a grader defect. **Measure
it first, then record the measured tier with a one-line reason.** Do not edit the
artefact — that is the thing `fixtures.ts` forbids. Editing the fixture's declared
`failingTier` to match a measured, better-justified reality is a metadata correction and
is allowed, once, with the measurement quoted.

### R8. Task order

**1 → 2 → 3 → 4A → 4B → 5.** Task 3 owns the three-valued `outcome` that Task 4's test
needs to compile. Task 2 owns the QUALITY findings that `stock-motion-only` needs.

### R9. Git hygiene

19 source files are already untracked (task #22). Every commit in this phase passes
**explicit file paths** to `git add`. Never `git add <dir>` — not even for a directory
holding one file; a recipe that models the banned form teaches it. This rule was violated
by this plan itself: Task 4A Step 8 shipped `git add dashboard/server/src/calibration/suites`
and was corrected to the explicit path on 2026-07-29. No AI-attribution trailer. No
`git push`.

**Note on what R9's "untracked" does and does not cover.** It describes the phase's
STARTING state and names no specific file. In particular it is not a statement about
`dashboard/server/src/calibration/suites/`, which this phase CREATED and COMMITTED (commit
`1733be0`). That file is tracked, so `git diff HEAD -- <path>` is a real restore check for
any mutation applied to it — unlike `bakeoff/`, which is wholly untracked and where the
no-edit rule can only be verified behaviourally.

---

## What already exists — do not rebuild

`spec-validate.ts` (1,140 lines) already detects, with `mustRegenerate` gating:

```
vacuous · tautological · mis_specified · trivially_satisfiable · ambiguous · leaks_implementation
```

plus assertion-free tests, near-duplicate detection by Jaccard similarity over string literals,
title-to-criterion token matching, and a deterministic syntax check. `contracts.ts:314-317` records
why this is load-bearing: *"TDFlow's entire +26.3pp effect lives in bad-test detection; a suite that
fails the audit must never have builds run against it."*

`SealedScorerGate` already runs the frozen suite in a `--network=none` container from a
digest-pinned image, and already emits these Tier-0 gates as BLOCKING `CriterionResult`s:

```
suite-intact · no-protected-path-writes · build · typecheck · lint · boot · routes
no-stub-markers · no-reward-hack-exploits · data-present · screenshots-present · suite-green
```

**Test quality and container execution are solved. This phase is about grader VALIDITY and
CALIBRATION** — different questions:

| Question | Status |
|---|---|
| Are the tests well-formed? | **Solved** by `spec-validate.ts` |
| Does the container execute them honestly? | **Solved** by `SealedScorerGate` |
| Do they measure what the owner actually asked for? | **Gap 1** — prose tickets underspecify |
| Do they cover what unit tests cannot — look and motion? | **Gap 2** |
| Can an absent owner understand the verdict? | **Gap 3** |
| **Do we know the grader works at all?** | **Gap 4 — and it is the one that matters** |

### The primary source for invoking the gate

`bakeoff/test/scorer-modes.e2e.mjs` already scores static artefacts through the **real**
sealed gate, including a blank-document negative case. Read it before writing any gate
plumbing: it shows the `AcceptanceSuite` shape, the run-record fields `gate.score()`
requires, and the `createGate({ BAKEOFF_SCORER_IMAGE, BAKEOFF_RESULTS_DIR,
BAKEOFF_ACCEPTANCE_ROOT })` env contract. `#runRecord` on the orchestrator is private;
that file is how you avoid reinventing it.

Measured, on this machine, 2026-07-29:
- `bakeoff-scorer:1` is built and the Docker daemon is running.
- `.scorer-modes-e2e/static-blank/` scored `heldOutPass: false` — a blank page already
  fails the real gate **when the suite asserts content**. That is the whole point of R1.

## Global Constraints

- **Read `bakeoff/`, compose in `dashboard/server/src/`, never edit `bakeoff/`.** (R5)
- **The grader never sees the implementation.** It is authored before any code exists. Nothing in this phase may pass build output back into criterion authoring.
- **Held-out stays held out.** Nothing here may surface a held-out test title outside the sealed store — the Phase 2d boundary applies identically.
- **Every check must be able to go red.** A calibration that cannot fail is worse than none, because it is read as evidence. (`probe-needs-negative-control`)
- **Verification that must *execute* goes to an agent with Bash.** Read-only agents silently degrade mutation testing into code review. (`verify-agents-need-bash`)
- **No AI-attribution trailer. No `git push`. Explicit paths to `git add`.**

---

### Task 1: Record what the grader assumed

**The gap:** the bake-off grades frozen, harness-authored briefs. The owner types *"portfolio website"*. The grader must infer a great deal — and **an unattended run that passes against inferred criteria the owner never saw is a false pass wearing a green badge.**

The fix is not to stop inferring. It is to make every inference **visible and correctable**, so the owner fixes the *ticket* rather than the code.

**Files:**
- Create: `dashboard/server/src/spec-assumptions.ts`, `dashboard/server/src/spec-assumptions.test.ts`

**Interfaces:**
```ts
export type AssumptionSource = "ticket" | "inferred" | "default";
export interface Assumption {
  readonly id: string;
  readonly criterionId: string | null;
  readonly statement: string;      // "the site has a contact section"
  readonly source: AssumptionSource;
  readonly because: string;        // why it was inferred — quoted ticket text, or the default rule
}
export function extractAssumptions(ticket: string, criteria: readonly AcceptanceCriterion[]): readonly Assumption[];
export function renderAssumptions(a: readonly Assumption[]): string;
```

**Interfaces — Consumes/Produces:**
- Consumes: `AcceptanceCriterion` from `bakeoff/dist/contracts.js` (`{ id, statement, evidenceRequired, tier }`).
- Produces: `extractAssumptions`, `renderAssumptions`, `Assumption`, `AssumptionSource` — Task 3 renders the inferred count, Task 5 writes the file.

> Revision 1 typed the second parameter as `SuiteDraft`. The dashboard holds an
> `AcceptanceSuite` whose `.criteria` are `AcceptanceCriterion`; take the criteria array
> directly and keep this module independent of draft shape.

- [ ] **Step 1: Write the failing test**

```ts
test("a criterion traceable to the ticket is marked `ticket`, not `inferred`", () => {
  const a = extractAssumptions("Build a portfolio with a contact form",
    [c("C-1", "the contact form submits and shows confirmation")]);
  assert.equal(a.find((x) => x.criterionId === "C-1")?.source, "ticket");
  assert.match(String(a.find((x) => x.criterionId === "C-1")?.because), /contact form/);
});

test("a criterion with no basis in the ticket is marked `inferred` and says why", () => {
  // "portfolio website" implies a project list. The owner never said so.
  const a = extractAssumptions("Build a portfolio website",
    [c("C-2", "a project list renders at least three entries")]);
  const x = a.find((v) => v.criterionId === "C-2");
  assert.equal(x?.source, "inferred");
  assert.ok(x?.because && x.because.length > 10, "an inference must justify itself");
});

test("every criterion is accounted for — silence is the failure mode", () => {
  const a = extractAssumptions("thin ticket", [c("C-1", "x"), c("C-2", "y"), c("C-3", "z")]);
  for (const id of ["C-1", "C-2", "C-3"]) {
    assert.ok(a.some((v) => v.criterionId === id), `${id} has no assumption record`);
  }
});

test("the rendered record leads with what was INFERRED — that is what needs review", () => {
  const md = renderAssumptions([
    { id: "A-1", criterionId: "C-1", statement: "s", source: "ticket", because: "b" },
    { id: "A-2", criterionId: "C-2", statement: "t", source: "inferred", because: "c" },
  ]);
  assert.ok(md.indexOf("INFERRED") < md.indexOf("FROM YOUR TICKET"), "inferences first");
});

// NEGATIVE CONTROL. Without this, a stub returning every criterion as `ticket`
// passes the first three tests. Stopword-only overlap must not count as support.
test("a criterion sharing only stopwords with the ticket is NOT `ticket`-sourced", () => {
  const a = extractAssumptions("Build a site for the studio",
    [c("C-9", "the build is for a site and the thing shall be there")]);
  assert.notEqual(a.find((x) => x.criterionId === "C-9")?.source, "ticket",
    "matching on 'the'/'for'/'a' would mark every inference as owner-approved");
});
```

- [ ] **Step 2: Run to verify it fails** — module does not exist.

Run: `cd dashboard/server && npm test 2>&1 | grep spec-assumptions`
Expected: FAIL — cannot resolve `./spec-assumptions.js`.

- [ ] **Step 3: Implement.** Trace each criterion back to ticket text by content-token overlap with a stopword list; anything unsupported is `inferred` and must carry a reason naming the rule that produced it. `default` is for criteria that come from the house rules rather than either the ticket or an inference about it.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/spec-assumptions.ts dashboard/server/src/spec-assumptions.test.ts
git commit -m "feat(grader): record what the grader assumed from a thin ticket

The bake-off grades frozen harness-authored briefs; the owner types 'portfolio
website'. An unattended pass against criteria the owner never saw is a false
pass. Every criterion now traces to the ticket or declares itself inferred."
```

---

### Task 2: Criteria for look and motion

**The gap:** the owner's actual bar — bespoke motion, a design that does not read as templated — is not unit-testable. §17's design lock makes it gradeable: the comparison stops being "does it resemble one of five mockups" and becomes **"does it match the one that was chosen."**

**Files:**
- Create: `dashboard/server/src/visual-criteria.ts`, `dashboard/server/src/visual-criteria.test.ts`

**Interfaces:**
```ts
/**
 * MINIMAL — Phase 2b (DESIGN lane) owns the full manifest and will widen this.
 * Defined here because Phase 2e needs the locked-mockup path and Phase 2b is
 * not built. (Revision 2, R6.)
 */
export interface DesignManifest {
  /** Absolute path to the mockup the owner locked, or null when the lane degraded. */
  readonly lockedMockup: string | null;
}

export interface VisualCriterion {
  readonly id: string;
  readonly tier: "QUALITY";          // owner decision: report, never block
  readonly statement: string;
  readonly reference: string | null; // absolute path to the LOCKED mockup
  readonly check: "layout" | "palette" | "typography" | "motion" | "media";
}
export function visualCriteriaFor(manifest: DesignManifest): readonly VisualCriterion[];
```

**Interfaces — Produces:** `visualCriteriaFor`, `VisualCriterion`, `DesignManifest`. Task 3
renders QUALITY findings from these; Task 4A's `stock-motion-only` fixture depends on
`visualCriteriaFor` returning a non-empty motion set.

- [ ] **Step 1: Write the failing test**

```ts
test("visual criteria are QUALITY tier — they report, they never block", () => {
  // Owner decision 2026-07-28: subjective judgement must not false-fail a run.
  for (const v of visualCriteriaFor(manifestWithLock())) assert.equal(v.tier, "QUALITY");
});

test("every visual criterion points at the LOCKED mockup, not the whole set", () => {
  const m = manifestWithLock("/ws/design-refs/02-hero.png");
  for (const v of visualCriteriaFor(m)) {
    if (v.reference !== null) assert.equal(v.reference, "/ws/design-refs/02-hero.png");
  }
});

test("with no locked design, criteria fall back to rule-based and say so", () => {
  // The DESIGN lane degrades rather than blocks when no Gemini key resolves.
  const v = visualCriteriaFor({ lockedMockup: null });
  assert.ok(v.length > 0, "still graded, just without a reference");
  assert.ok(v.every((x) => x.reference === null));
});

test("a motion criterion accepts EVERY satisfier the owner's own site uses", () => {
  // kamilborzecki.dev uses scroll-scrubbed video and ZERO CSS animations.
  // A criterion demanding GSAP would fail the owner's own reference site.
  const motion = visualCriteriaFor(manifestWithLock()).filter((v) => v.check === "motion");
  assert.ok(motion.length > 0);
  const text = motion.map((m) => m.statement).join(" ");
  assert.match(text, /scroll|scrub|timeline|rAF|stagger|pin/i);
  assert.doesNotMatch(text, /\bmust use (GSAP|Framer)\b/i, "no single library may be mandated");
});

// NEGATIVE CONTROL (Revision 2, R3). If this set can be empty, `pass_with_notes`
// collapses into `pass` and Task 4A cannot tell `stock-motion-only` from
// `correct-portfolio` — with calibration still green.
test("the criteria set is never empty, in either manifest state", () => {
  assert.ok(visualCriteriaFor(manifestWithLock()).length > 0);
  assert.ok(visualCriteriaFor({ lockedMockup: null }).length > 0);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** Derive criteria from the locked mockup plus `impeccable/reference/craft-floor.md` — *"the quality floor, the absolute bans, the reflexes no detector catches"*. Motion criteria must accept scroll-scrubbed video, GSAP/ScrollTrigger timelines, or rAF-driven scrubbing; they fail only stock hover/fade with nothing bespoke.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit** — explicit paths.

---

### Task 3: A verdict an absent owner can read

**The gap:** an unattended "FAILED" with no readable reason is unactionable. The owner comes back to a red badge and has to reconstruct why from logs.

**Files:**
- Create: `dashboard/server/src/verdict.ts`, `dashboard/server/src/verdict.test.ts`

**Interfaces — Produces:**
```ts
export type VerdictOutcome = "pass" | "fail" | "pass_with_notes";
export interface VerdictInput {
  readonly ticket: string;
  readonly criteriaResults: readonly CriterionResult[];   // bakeoff/dist/contracts.js
  readonly qualityFindings: readonly string[];
  readonly assumptions: readonly Assumption[];
  readonly heldOutUnmet: Readonly<Record<ApiCriterionTier, number>>;
}
export function computeOutcome(v: VerdictInput): VerdictOutcome;
export function renderVerdict(v: VerdictInput): string;
```

`computeOutcome` is exported **separately from rendering** so Task 4A can assert the
outcome and the failing tier without parsing markdown.

**The tier rule, and it is the whole of it (R3):**
- any unmet BLOCKING or FUNCTIONAL → `fail`
- otherwise, **≥1 QUALITY finding** → `pass_with_notes`
- otherwise → `pass`

`pass_with_notes` is earned by a finding that exists. It is never inferred from the
absence of blockers.

- [ ] **Step 1: Write the failing test**

```ts
test("the verdict leads with the answer, then the reason", () => {
  const md = renderVerdict(failingRun());
  assert.ok(md.indexOf("DID NOT PASS") < md.indexOf("Why"), "answer first");
});

test("the verdict names the ticket requirement that went unmet, in the owner's words", () => {
  // Not "C-3 unmet" — the owner did not write C-3, they wrote a sentence.
  const md = renderVerdict(runWith({ ticket: "the contact form must email me",
    unmet: [{ id: "C-3", statement: "the contact form submits and confirms" }] }));
  assert.match(md, /contact form/);
});

test("the verdict NEVER contains a held-out test title", () => {
  const md = renderVerdict(runWith({ heldOutUnmet: { BLOCKING: 1, FUNCTIONAL: 0, QUALITY: 0 },
    leakedTitles: ["renders the hero heading"] }));
  assert.doesNotMatch(md, /renders the hero heading/);
  assert.match(md, /1 BLOCKING/);
});

test("a QUALITY-only failure is reported as PASSED WITH NOTES, not FAILED", () => {
  // QUALITY never blocks. Rendering it as a failure would train the owner to
  // ignore red, which is worse than not reporting it.
  const md = renderVerdict(runWith({ blocking: 0, functional: 0, quality: 3 }));
  assert.match(md, /PASSED WITH NOTES/);
  assert.doesNotMatch(md, /^#.*FAILED/m);
});

test("assumptions are surfaced in the verdict when the run passed", () => {
  // A pass against inferred criteria is the dangerous case — the owner must see
  // WHAT it passed against, not just that it passed.
  const md = renderVerdict(passingRun({ inferred: 4 }));
  assert.match(md, /4 .*inferred/i);
});

// NEGATIVE CONTROLS (Revision 2, R3). The three-way outcome must be earned in
// both directions, or `pass_with_notes` is decoration.
test("QUALITY findings with no blockers give PASS_WITH_NOTES, not PASS", () => {
  assert.equal(computeOutcome(runWith({ blocking: 0, functional: 0, quality: 1 })), "pass_with_notes");
});

test("no findings at all give PASS, not PASS_WITH_NOTES", () => {
  assert.equal(computeOutcome(runWith({ blocking: 0, functional: 0, quality: 0 })), "pass");
});

test("a QUALITY finding never rescues a FUNCTIONAL failure into notes", () => {
  assert.equal(computeOutcome(runWith({ blocking: 0, functional: 1, quality: 5 })), "fail");
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** Write `runs/<runId>/results/verdict.md`. Structure: the answer, then unmet ticket requirements in the owner's own phrasing, then held-out **counts** by tier, then QUALITY notes, then the assumption summary, then the backlog link.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit** — explicit paths.

---

### Task 4A: Scoring-path calibration — the standing gate

**What this proves:** that the Tier-0 gates fire, that exploit detection inspects
artefact-shipped test files, that the tier arithmetic in `computeOutcome` is right, and
that the verdict renders. **It does not prove the grader discriminates** — the suites are
committed, so the discrimination was chosen by their author, not measured. Task 4B is the
one that measures. Say so in the file header and in `STATUS.md`, in those words.

**Files:**
- Create: `dashboard/server/src/calibration/suites/<fixture>/` (committed frozen suites),
  `dashboard/server/src/calibration/grade-fixture.ts`,
  `dashboard/server/src/calibration.test.ts`
- Read first, do not modify: `bakeoff/test/scorer-modes.e2e.mjs`

**Interfaces — Produces:**
```ts
export interface FixtureVerdict {
  readonly outcome: VerdictOutcome;
  /** The strictest tier carrying a failure, or null on pass. */
  readonly failingTier: ApiCriterionTier | null;
  /** Gate ids that failed, for the record. */
  readonly failedGates: readonly string[];
  readonly exploitFindings: readonly ExploitFinding[];
}
export async function gradeFixture(fx: CalibrationFixture): Promise<FixtureVerdict>;
```

- [ ] **Step 1: Read the primary source.** `bakeoff/test/scorer-modes.e2e.mjs` — the run
  record shape, `buildSuite`, `freezeSuite`, and the `createGate` env contract. Reproduce
  that shape in `grade-fixture.ts`. Do not modify anything under `bakeoff/`.

- [ ] **Step 2: Author and commit one frozen suite per fixture.** Content criteria assert
  hero / three projects / contact section against `PORTFOLIO_TICKET`. All seven fixtures
  share one criteria set — a per-fixture criteria set would be tuning the yardstick to the
  artefact, which is the defect this task is trying not to commit.

- [ ] **Step 3: Measure before asserting.** Run all seven through the real gate and record
  the actual outcome, failing tier, failed gate ids and exploit findings into
  `dashboard/server/probes/results/calibration-4a.json`. Two questions this answers, both
  currently unmeasured:
  - Does `GATE:no-reward-hack-exploits` actually fire on `reward-hacked`'s
    `tests/acceptance.spec.mjs`? `ExploitFinding.blocking` is true only for
    "test-adjacent" paths — verify that this path qualifies rather than assuming it.
  - Does `stub-markers` fail at BLOCKING (`GATE:no-stub-markers`) rather than the
    FUNCTIONAL the fixture declares? (R7)

- [ ] **Step 4: Reconcile, once, with the measurement quoted.** If `stub-markers` fails at
  BLOCKING, correct `failingTier` in `fixtures.ts` and quote the measured gate id in
  `discriminates`. **Never edit an artefact to make calibration pass.** If `reward-hacked`
  does *not* trip the exploit gate, that is a **grader defect** — record it as a blocking
  finding and do not paper over it by relaxing the expected tier.

- [ ] **Step 5: Write the test**

```ts
test("CALIBRATION(scoring-path): the committed suites produce the expected outcome AND tier", async () => {
  for (const fx of FIXTURES) {
    const v = await gradeFixture(fx);
    assert.equal(v.outcome, fx.expected, `${fx.name}: expected ${fx.expected}, got ${v.outcome}`);
    assert.equal(v.failingTier, fx.failingTier,
      `${fx.name}: failed at ${String(v.failingTier)}, expected ${String(fx.failingTier)} — ` +
      "failing for the wrong reason is not passing calibration");
  }
});

test("CALIBRATION(scoring-path): no fixture produces a FALSE PASS — the catastrophic direction", async () => {
  for (const fx of MUST_FAIL) {
    const v = await gradeFixture(fx);
    assert.notEqual(v.outcome, "pass", `FALSE PASS on ${fx.name} — the owner would trust a lie`);
  }
});

test("CALIBRATION(scoring-path): the reward-hacked suite trips the EXPLOIT gate, not merely some gate", async () => {
  // Without this, exploitFindings can be entirely dead while calibration is green.
  const v = await gradeFixture(byName("reward-hacked"));
  assert.ok(v.failedGates.includes("GATE:no-reward-hack-exploits"),
    `failed gates were ${v.failedGates.join(", ")} — the exploit path never ran`);
  assert.ok(v.exploitFindings.some((f) => f.blocking));
});

test("CALIBRATION(scoring-path): the correct artefact is not failed — false fails burn fix rounds", async () => {
  assert.equal((await gradeFixture(byName("correct-portfolio"))).outcome, "pass");
});

test("CALIBRATION(scoring-path): stock-motion-only earns PASS_WITH_NOTES via a real QUALITY finding", async () => {
  const v = await gradeFixture(byName("stock-motion-only"));
  assert.equal(v.outcome, "pass_with_notes");
  assert.equal(v.failingTier, "QUALITY", "notes with no QUALITY finding is just a pass wearing a label");
});
```

- [ ] **Step 6: THE MUTATION — prove calibration is not vacuous.** (R4) This step is not
  optional and its result is a returned boolean, not a narrated claim.
  1. Gut the content assertions in the committed suites (empty the hero/projects/contact
     criteria).
  2. Re-run calibration. **`blank-page` must flip to `pass` and the suite must go RED.**
  3. Restore. Confirm green.
  4. Record in `probes/results/calibration-4a.json`: which mutation produced which failure.

  If calibration stays green with the criteria gutted, it is testing nothing and Task 4A
  is not done.

- [ ] **Step 7: Make it a standing gate.** It runs in `npm test`. If Docker is unavailable
  the test **fails with a named reason** — it does not skip into green. A skipped
  calibration that reports green is the exact defect in `probe-needs-negative-control`.

- [ ] **Step 8: Commit** — explicit paths.

```bash
git add dashboard/server/src/calibration/grade-fixture.ts \
        dashboard/server/src/calibration.test.ts \
        dashboard/server/src/calibration/fixtures.ts \
        dashboard/server/src/calibration/suites/portfolio-suite.ts \
        dashboard/server/probes/results/calibration-4a.json
git commit -m "test(grader): calibrate the SCORING PATH against seven fixtures

Committed suites, real sealed container. Proves the Tier-0 gates fire, that the
exploit gate inspects artefact-shipped test files, and that the tier arithmetic
holds. It does NOT prove the grader discriminates — the suites are committed, so
that discrimination was chosen rather than measured. Task 4B measures it.

The mutation is recorded: gutting the content criteria flips blank-page to pass
and turns calibration red."
```

---

### Task 4B: Authoring calibration — does the grader actually discriminate?

**This is the task that answers Gap 4, and the one Revision 1 conflated with 4A.** Here
the suite is **authored from `PORTFOLIO_TICKET` by `spec-agent`**, with no fixture
knowledge, and only then executed. Nobody chose in advance that `blank-page` should fail.

**Files:**
- Create: `dashboard/server/probes/calibration-authoring.mjs`, results into `probes/results/`

- [ ] **Step 1: Author once, score seven times.** One authored suite per run, shared across
  all seven artefacts — the ticket is the same, so a per-fixture suite would reintroduce
  exactly the tuning 4A avoids. Audit it through `spec-validate` first; a suite that fails
  the audit must never have artefacts scored against it (`contracts.ts:314-317`).

- [ ] **Step 2: Report a confusion matrix, not a boolean.** For each fixture: expected,
  actual, failing tier, and the gate or criterion that carried it. **False passes are
  listed separately and first.**

- [ ] **Step 3: Opt-in, and honest when it does not run.** Gated behind
  `GRADER_CALIBRATION_LIVE=1`. When unset it prints `NOT RUN` and exits **non-zero if
  invoked directly** — never a silent green. The harness exit gate is the one from
  `enforcement-probe.mjs`; reuse it rather than writing a fifth one that exits 0 on FAIL.

- [ ] **Step 4: Record the result in `STATUS.md`,** including how many fixtures the
  *authored* suite got right. If the authored suite passes `blank-page`, that is the
  headline finding of this phase and it goes in `STATUS.md` under CRITICAL — not into a
  footnote.

- [ ] **Step 5: Commit** — explicit paths.

---

### Task 5: Wire it into the run

**Files:**
- Modify: `dashboard/server/src/orchestrator.ts` (spec phase, run end), `api-types.ts` + the two client mirrors

- [ ] **Step 1: Write the failing test**

```ts
test("a run exposes its assumption count and verdict path", async () => {
  const d = await runDetail(runIdOf(await runTicket("portfolio website")));
  assert.ok(typeof d.inferredCriteria === "number");
  assert.ok(typeof d.verdictPath === "string");
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement.** Emit `assumptions.md` at spec exit and `verdict.md` at run end. Widen `RunDetail` with `inferredCriteria` and `verdictPath`, updating **all three declaration sites in the same commit** — server `api-types.ts`, client `api-types.ts`, `EVENT_TYPES` in `use-run-stream.ts` — per the frozen-contract rule.

- [ ] **Step 4: Verify the wiring by mutation, not by grep.** Revert the *call site* that
  writes `verdict.md` and confirm the test goes red. A test that stays green when the call
  is removed is instance #6 of the signature defect, and this project has already shipped
  it once (`recordResultTokens`, Phase 1.1 Task 5).

- [ ] **Step 5: Run the full suite. Commit** — explicit paths, all three declaration sites
  in one commit.

---

## Definition of done

- [ ] `npm test` passes; every earlier-phase test still green. Record the count.
- [ ] **Task 4A:** all 7 fixtures produce the expected **outcome AND failing tier** against
      committed suites, and it runs as a standing gate that fails — never skips — when
      Docker is absent.
- [ ] **The 4A mutation is recorded:** gutting the content criteria flips `blank-page` to
      `pass` and turns calibration red. A calibration never watched failing is not verified.
- [ ] **`reward-hacked` fails via `GATE:no-reward-hack-exploits`**, with ≥1 blocking
      `ExploitFinding` — not merely via unmet content criteria.
- [ ] **Task 4B has been run once** and its confusion matrix is in `STATUS.md`, including
      any false pass, and including the count the *authored* suite got right.
- [ ] Every criterion traces to the ticket or declares itself inferred, with a reason.
- [ ] Visual criteria are QUALITY tier, non-empty in both manifest states, reference the
      locked mockup, and mandate no single motion library.
- [ ] `pass_with_notes` is produced only by ≥1 real QUALITY finding.
- [ ] `verdict.md` and `assumptions.md` are written on every run; neither contains a
      held-out test title; the write is verified by reverting the call site.
- [ ] `bakeoff/` untouched — `git status` under `bakeoff/` is clean. No attribution
      trailer. No `git push`. Every `git add` used explicit file paths.

## Explicitly NOT in Phase 2e

- **Rewriting `spec-agent.ts` or `spec-validate.ts`.** They work and they live in `bakeoff/`.
- **Making the grader adaptive.** It does not learn from past runs — spec §16.4 rules that out.
- **Blocking on QUALITY.** Owner decision: report, never fail.
- **The full `DesignManifest`.** Phase 2b owns it; Task 2 defines only the locked-mockup field.

## The honest limitation

Task 4A proves the scoring path behaves on seven fixtures **against suites we wrote** —
which means it proves the container and the arithmetic, not the judgement. Task 4B proves
the judgement, once, on those same seven fixtures **against a suite authored blind** —
which is the real measurement, and is nondeterministic, so it informs rather than gates.

Neither can prove the grader is right about a ticket nobody has written yet. The
assumption record (Task 1) is the mitigation: when the grader is wrong about a real
ticket, the owner can see *what it believed* and correct the ticket — cheaper than
debugging a verdict, and the only feedback path that does not require them to read the
code.
