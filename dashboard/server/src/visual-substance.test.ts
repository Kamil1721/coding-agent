/**
 * visual-substance.test.ts
 *
 * WHAT THIS FILE HAS TO BE ABLE TO FAIL ON, because this project's signature
 * defect is a check that can only observe success and there are eleven recorded
 * instances:
 *
 *   1. THE SET GOING EMPTY OR SHRINKING. Design note §7.1: a gate that fires on
 *      NOTHING sorts all seven calibration fixtures correctly, which is the M4
 *      defect exactly (emptying `MUST_FAIL` left calibration green at 7/7). No
 *      calibration assertion can notice an inert observation set. This file is
 *      the only thing that can, so the ids are asserted by literal.
 *   2. THE GATE GOING LIVE BY ACCIDENT. Shadow must contribute zero to the
 *      verdict, and `shadowLocked` must survive the flag being flipped.
 *   3. THE GATE GOING INERT WHEN FLIPPED. The mirror of 2, and the easier one to
 *      miss: if every entry were locked, turning the flag on would change
 *      nothing and the flag itself would be decoration.
 *   4. SILENCE BECOMING A PASS. Defect #35's shape — `GATE:build` reported NOT
 *      APPLICABLE, therefore passed, on the artefact whose purpose is not to
 *      compile. An unanswered question here must be `unknown`, never satisfied.
 *   5. A SCREENSHOT PATH REACHING A RECORD. Enforced, and the enforcement is
 *      itself tested in both directions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

import { visualGatePrompt } from "./design-prompt.js";
import type { VisualCriterion } from "./visual-criteria.js";
import { visualCriteriaFor } from "./visual-criteria.js";
import type {
  VisualAnswerVerdict,
  VisualFrame,
  VisualObservationAnswer,
  VisualSubstanceMode,
} from "./visual-substance.js";
import { FIXTURES, HOLLOW_SECTION_FIXTURE, artefactDir } from "./calibration/fixtures.js";
import {
  assertNoScreenshotReference,
  DEFAULT_VISUAL_SUBSTANCE_MODE,
  evaluateVisualSubstance,
  gatingFindingCount,
  groundPolarityAnswer,
  GROUND_MIN_SHARE,
  POLARITY_MARGIN,
  POLARITY_MIDPOINT,
  REF_GROUND_INVERTED_ID,
  isGatingObservation,
  renderVisualSubstanceReport,
  TASTE_TIER,
  VISUAL_ANSWER_MARKER,
  VISUAL_OBSERVATIONS,
  parseVisualObservationAnswers,
  verdictFindings,
  visualObservationBlock,
  visualObservationLabel,
} from "./visual-substance.js";

const FRAME: VisualFrame = { flowId: "home", breakpoint: "375x812" };
const WIDE: VisualFrame = { flowId: "home", breakpoint: "1280x800" };

function answer(
  observationId: string,
  overrides: Partial<VisualObservationAnswer> = {},
): VisualObservationAnswer {
  return {
    observationId,
    frame: FRAME,
    verdict: "satisfied",
    note: "the frame carries a hero heading and three project cards",
    ...overrides,
  };
}

/**
 * The page measurement `VIS-F-EMPTY-FRAME` needs before a `violated` answer is a
 * finding at all.
 *
 * FOUR TESTS IN THIS FILE WENT RED WHEN THE CORROBORATION LANDED and are listed
 * here rather than quietly patched, because that is the negative control for the
 * rule and it was free: "SHADOW: an observation that FIRES contributes ZERO",
 * "GATING: an unlocked observation that fires produces exactly one verdict
 * finding", "the report carries both halves", and "SHADOW contributes nothing to a
 * FUNCTIONAL count even when everything fires" all asserted that a `violated`
 * EMPTY-FRAME answer produces a violation, and with no measurement it now produces
 * `unknown`/`corroboration_missing`. Deleting the rule turns them red again.
 */
const BLANK_PAGE_EVIDENCE = [
  { frame: FRAME, innerTextLength: 0 },
  { frame: WIDE, innerTextLength: 0 },
];

/** Every observation answered `satisfied` on one frame — the quiet baseline. */
function allSatisfied(frame: VisualFrame = FRAME): VisualObservationAnswer[] {
  return VISUAL_OBSERVATIONS.map((o) => answer(o.id, { frame }));
}

/* ---- 1. The set itself, against M4 ------------------------------------ */

test("THE SET IS EXACTLY THE FOUR ENUMERATED IDS — an emptied or widened set fails here", () => {
  // ASSERTED BY LITERAL, NOT BY LENGTH. `length === 4` stays green if an entry
  // is swapped for an invented one, and design note §4 fixes membership: a model
  // never decides what counts as gating, and neither does a later refactor.
  assert.deepEqual(
    VISUAL_OBSERVATIONS.map((o) => o.id),
    ["VIS-F-EMPTY-FRAME", "VIS-F-EMPTY-REGION", "VIS-F-PLACEHOLDER-MEDIA", "VIS-F-REF-GROUND-INVERTED"],
  );
});

test("every entry carries a question, a non-trigger and a reason it is not taste", () => {
  assert.ok(VISUAL_OBSERVATIONS.length > 0, "a for-of over an empty array asserts nothing");
  for (const observation of VISUAL_OBSERVATIONS) {
    assert.equal(observation.tier, "FUNCTIONAL", `${observation.id}: tier`);
    assert.ok(observation.question.trim().endsWith("?"), `${observation.id}: not a question`);
    assert.ok(
      /must not fire on/i.test(observation.nonTrigger),
      `${observation.id}: a question shipped without its false-fail case is a finding generator`,
    );
    assert.ok(observation.why.length > 40, `${observation.id}: no stated reason it is not taste`);
    if (observation.shadowLocked) {
      assert.ok(
        observation.lockReason !== null && observation.lockReason.length > 40,
        `${observation.id}: locked with no recorded reason is a lock nobody can lift correctly`,
      );
    }
  }
});

test("at least one entry is UNLOCKED — otherwise the mode flag is decoration", () => {
  // THE MIRROR OF THE SHADOW TESTS BELOW, and the easier failure to miss. If
  // every entry were shadow-locked, flipping the flag would change nothing and
  // every shadow assertion in this file would still pass.
  const unlocked = VISUAL_OBSERVATIONS.filter((o) => !o.shadowLocked);
  assert.deepEqual(unlocked.map((o) => o.id), ["VIS-F-EMPTY-FRAME"]);
});

test("the three locked entries are locked, and the flag cannot lift them", () => {
  // Design note §7.2: these "stay shadowed regardless of how the seven sort".
  // REF-GROUND-INVERTED joins them on a MEASURED disqualifier rather than on a
  // missing fixture — see its lockReason, and the calibration section below that
  // renders the collision rather than describing it.
  for (const id of ["VIS-F-EMPTY-REGION", "VIS-F-PLACEHOLDER-MEDIA", "VIS-F-REF-GROUND-INVERTED"]) {
    const observation = VISUAL_OBSERVATIONS.find((o) => o.id === id);
    assert.ok(observation !== undefined, `${id} is missing from the set`);
    assert.equal(observation.shadowLocked, true, `${id} must be shadow-locked`);
    assert.equal(isGatingObservation(observation, "gating"), false, `${id} gated with the flag on`);
  }
});

/* ---- 2. Mode ---------------------------------------------------------- */

test("the default mode is SHADOW", () => {
  assert.equal(DEFAULT_VISUAL_SUBSTANCE_MODE, "shadow");
  const record = evaluateVisualSubstance({ frames: [FRAME], answers: allSatisfied() });
  assert.equal(record.mode, "shadow");
});

test("SHADOW: an observation that FIRES contributes ZERO to the verdict", () => {
  const record = evaluateVisualSubstance({
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME", { verdict: "violated", note: "a flat field of colour" })],
    pageEvidence: BLANK_PAGE_EVIDENCE,
  });
  assert.equal(record.violations.length, 1, "it must still be RECORDED");
  assert.equal(gatingFindingCount(record), 0, "and it must not be able to fail the run");
  assert.deepEqual(verdictFindings(record), []);
});

test("GATING: an unlocked observation that fires produces exactly one verdict finding", () => {
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME", { verdict: "violated", note: "a flat field of colour" })],
    pageEvidence: BLANK_PAGE_EVIDENCE,
  });
  assert.equal(gatingFindingCount(record), 1);
  assert.equal(verdictFindings(record)[0]?.observationId, "VIS-F-EMPTY-FRAME");
  assert.equal(verdictFindings(record)[0]?.declaredTier, "FUNCTIONAL");
});

test("GATING DOES NOT UNLOCK A LOCKED ENTRY — the flag is the weaker of the two levels", () => {
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [
      answer("VIS-F-EMPTY-REGION", { verdict: "violated", note: "a heading over nothing" }),
      answer("VIS-F-PLACEHOLDER-MEDIA", { verdict: "violated", note: "a broken image glyph" }),
    ],
  });
  assert.equal(record.violations.length, 2, "both must be recorded");
  assert.equal(gatingFindingCount(record), 0, "and neither may fail the run");
  for (const row of record.violations) assert.equal(row.withheldBecause, "entry_shadow_locked");
});

test("the record states which mode it ran in — a silent shadow run is not a clean gating run", () => {
  const shadow = evaluateVisualSubstance({ frames: [FRAME], answers: allSatisfied() });
  const gating = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: allSatisfied(),
  });
  assert.equal(shadow.mode, "shadow");
  assert.equal(gating.mode, "gating");
  assert.notEqual(
    renderVisualSubstanceReport({ record: shadow, taste: [] }),
    renderVisualSubstanceReport({ record: gating, taste: [] }),
    "two modes that found the same thing must not produce the same document",
  );
});

/* ---- 3. UNKNOWN is never a pass --------------------------------------- */

test("an UNANSWERED observation is unknown/not_answered — never satisfied", () => {
  // The loop is over VISUAL_OBSERVATIONS, never over the answers, and this is
  // what that direction buys: answering two of three questions produces one
  // `unknown`, not two rows and a silence.
  const record = evaluateVisualSubstance({
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME")],
  });
  assert.equal(record.outcomes.length, VISUAL_OBSERVATIONS.length);
  const missing = record.outcomes.filter((o) => o.observationId !== "VIS-F-EMPTY-FRAME");
  // THE LITERAL MOVES WITH THE SET AND IS STILL A LITERAL. `VISUAL_OBSERVATIONS
  // .length - 1` would stay green if the set were emptied to one entry, which is
  // the M4 shape this file exists to catch.
  assert.equal(missing.length, 3);
  for (const row of missing) {
    assert.equal(row.verdict, "unknown");
    assert.equal(row.unknownReason, "not_answered");
  }
  assert.equal(record.outcomes.filter((o) => o.verdict === "satisfied").length, 1);
});

test("with NO frames every observation is unknown/no_screenshot", () => {
  const record = evaluateVisualSubstance({ frames: [], answers: [] });
  assert.equal(record.unknowns.length, VISUAL_OBSERVATIONS.length);
  for (const row of record.unknowns) assert.equal(row.unknownReason, "no_screenshot");
  assert.equal(record.outcomes.filter((o) => o.verdict === "satisfied").length, 0);
});

test("BELOW THE FOLD is unknown, not satisfied — the capture is one viewport", () => {
  const record = evaluateVisualSubstance({
    frames: [FRAME],
    answers: [
      answer("VIS-F-EMPTY-REGION", {
        verdict: "unknown",
        unknownReason: "below_the_fold",
        note: "the contact section is not inside the captured viewport at this breakpoint",
      }),
    ],
  });
  const row = record.outcomes.find((o) => o.observationId === "VIS-F-EMPTY-REGION");
  assert.equal(row?.verdict, "unknown");
  assert.equal(row?.unknownReason, "below_the_fold");
  assert.equal(gatingFindingCount(record), 0, "an unknown never gates either");
});

test("an unknown with no stated reason degrades to cannot_tell, never to satisfied", () => {
  const record = evaluateVisualSubstance({
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME", { verdict: "unknown", note: "could not decide" })],
  });
  const row = record.outcomes.find((o) => o.observationId === "VIS-F-EMPTY-FRAME");
  assert.equal(row?.verdict, "unknown");
  assert.equal(row?.unknownReason, "cannot_tell");
});

test("an answer naming an id the set does not contain is DISCARDED", () => {
  // A model may not add a gating check by inventing an id.
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [
      answer("VIS-F-UGLY-PALETTE", { verdict: "violated", note: "the palette is muddy" }),
      ...allSatisfied(),
    ],
  });
  assert.equal(record.violations.length, 0);
  assert.equal(gatingFindingCount(record), 0);
  assert.ok(!record.outcomes.some((o) => o.observationId === "VIS-F-UGLY-PALETTE"));
});

test("every observation is evaluated at EVERY frame — one row per pair, never sparse", () => {
  const record = evaluateVisualSubstance({
    frames: [FRAME, WIDE],
    answers: allSatisfied(FRAME),
  });
  assert.equal(record.outcomes.length, VISUAL_OBSERVATIONS.length * 2);
  const wide = record.outcomes.filter((o) => o.frame.breakpoint === WIDE.breakpoint);
  assert.equal(wide.length, VISUAL_OBSERVATIONS.length);
  for (const row of wide) assert.equal(row.verdict, "unknown", "a breakpoint nobody answered");
});

/* ---- 4. Taste stays QUALITY, in the same report, visibly separated ----- */

test("the real taste criteria are ALL QUALITY, and there is at least one", () => {
  const taste = visualCriteriaFor({ lockedMockup: null });
  assert.ok(taste.length > 0, "an empty taste set would make this loop vacuous");
  for (const criterion of taste) assert.equal(criterion.tier, TASTE_TIER);
});

test("the report carries both halves, labelled with what each can do", () => {
  const taste = visualCriteriaFor({ lockedMockup: null });
  const record = evaluateVisualSubstance({
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME", { verdict: "violated", note: "a flat field of colour" })],
    tasteFindings: ["VIS-MOTION-AUTHORED: no authored motion; only a hover box-shadow."],
    pageEvidence: BLANK_PAGE_EVIDENCE,
  });
  const report = renderVisualSubstanceReport({ record, taste });
  assert.match(report, /SECTION 1 — OBJECTIVE OBSERVATIONS \(FUNCTIONAL tier/);
  assert.match(report, /SECTION 2 — TASTE \(QUALITY tier: reports, and NEVER blocks a run\)/);
  assert.match(report, /MODE: SHADOW/);
  assert.match(report, /VIS-F-EMPTY-FRAME — FIRED/);
  assert.match(report, /no authored motion/);
  assert.ok(
    report.indexOf("SECTION 1") < report.indexOf("SECTION 2"),
    "the half that can fail a run comes first",
  );
});

test("the report REFUSES to print a taste criterion that is not QUALITY", () => {
  // The cross-module half of visual-criteria.ts's literal `tier: "QUALITY"`. A
  // widened tier there surfaces here rather than quietly printing a taste note
  // under the heading that says it can fail a run.
  const promoted = {
    id: "VIS-LAYOUT-SCAFFOLD",
    tier: "FUNCTIONAL",
    statement: "the scaffold is the category default",
    reference: null,
    check: "layout",
  } as unknown as VisualCriterion;
  const record = evaluateVisualSubstance({ frames: [FRAME], answers: allSatisfied() });
  assert.throws(
    () => renderVisualSubstanceReport({ record, taste: [promoted] }),
    /carries tier FUNCTIONAL, not QUALITY/,
  );
});

test("a SHADOW report says plainly that nothing in it can fail the run", () => {
  const record = evaluateVisualSubstance({
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME", { verdict: "violated", note: "a flat field of colour" })],
    pageEvidence: BLANK_PAGE_EVIDENCE,
  });
  const report = renderVisualSubstanceReport({ record, taste: [] });
  assert.match(report, /NONE of them can fail this run/);
  assert.match(report, /Observations that can fail this run: none\./);
});

test("a GATING report names exactly which observations can fail the run", () => {
  const record = evaluateVisualSubstance({ mode: "gating", frames: [FRAME], answers: allSatisfied() });
  const report = renderVisualSubstanceReport({ record, taste: [] });
  assert.match(report, /MODE: GATING/);
  assert.match(report, /Observations that can fail this run: VIS-F-EMPTY-FRAME\./);
  assert.match(report, /VIS-F-EMPTY-REGION — clear \(declared FUNCTIONAL; withheld: this entry is shadow-locked/);
});

/* ---- 5. The screenshot-path boundary ---------------------------------- */

test("assertNoScreenshotReference fires on paths and image filenames, and only on those", () => {
  for (const bad of [
    "see results/screenshots/r1/home-375.png",
    "the capture home.webp shows nothing",
    "/runs/r1/results/screenshots/x",
    "saved to ./shot.jpeg",
    "~/captures/hero.avif",
  ]) {
    assert.throws(() => assertNoScreenshotReference(bad, "t"), /file path or image filename/, bad);
  }
  for (const good of [
    "a flat field of background colour, no glyphs anywhere in the frame",
    "the projects heading sits above three filled cards",
    "the contact section is below the fold at 375x812",
  ]) {
    assert.doesNotThrow(() => assertNoScreenshotReference(good, "t"), good);
  }
});

test("a note carrying a path is rejected AT THE BOUNDARY, when the record is built", () => {
  assert.throws(
    () =>
      evaluateVisualSubstance({
        frames: [FRAME],
        answers: [answer("VIS-F-EMPTY-FRAME", { note: "see results/screenshots/home-375.png" })],
      }),
    /file path or image filename/,
  );
});

test("no rendered report contains a path or an image filename", () => {
  const record = evaluateVisualSubstance({
    frames: [FRAME, WIDE],
    answers: [answer("VIS-F-EMPTY-FRAME", { verdict: "violated", note: "a flat field of colour" })],
    tasteFindings: ["VIS-CONTRAST-FLOOR: body text measures 3.1:1 on the hero surface."],
    pageEvidence: BLANK_PAGE_EVIDENCE,
  });
  const report = renderVisualSubstanceReport({ record, taste: visualCriteriaFor({ lockedMockup: null }) });
  assert.doesNotMatch(report, /\.(png|jpe?g|webp|gif|avif)\b/i);
});

/* ---- 6. The prompt the grader actually reads -------------------------- */

const GATE_INPUT = { manifest: null, workspace: "/runs/r1/workspace", previewUrl: "http://127.0.0.1:4180" };

test("the prompt carries EVERY GRADER-ANSWERED observation, with its question and its non-trigger", () => {
  // SINGLE-SOURCED: a prompt that restates the set in prose is a second
  // declaration site, and the two drift until the model is answering a question
  // the code does not score.
  const p = visualGatePrompt(GATE_INPUT);
  const asked = VISUAL_OBSERVATIONS.filter((o) => o.answeredBy === "grader");
  assert.ok(asked.length > 0, "a for-of over an empty array asserts nothing");
  for (const observation of asked) {
    assert.ok(p.includes(observation.id), `${observation.id} absent from the prompt`);
    assert.ok(p.includes(observation.question), `${observation.id}: question not carried verbatim`);
    assert.ok(p.includes(observation.nonTrigger), `${observation.id}: non-trigger not carried`);
  }
});

test("a MEASUREMENT-answered observation is not in the prompt at all — and there is one", () => {
  // THE MIRROR, and without it the filter above is untested: if every entry were
  // grader-answered the loop would still pass and `answeredBy` would be
  // decoration. Asking a model whether the build inverted the LOCKED MOCKUP's
  // polarity is asking it about a file it was never shown.
  const measured = VISUAL_OBSERVATIONS.filter((o) => o.answeredBy === "measurement");
  assert.deepEqual(measured.map((o) => o.id), ["VIS-F-REF-GROUND-INVERTED"]);
  const p = visualGatePrompt(GATE_INPUT);
  for (const observation of measured) {
    assert.ok(!p.includes(observation.id), `${observation.id} was handed to the grader`);
    assert.ok(!p.includes(observation.question), `${observation.id}: its question reached the grader`);
  }
});

test("a GRADER MAY NOT ANSWER a measured question — the parser refuses the line, not just the prompt", () => {
  // THE FLAW THIS CLOSES, stated exactly: `answerFor` matches on observationId
  // plus frame with no `answeredBy` awareness, so a grader line and the
  // producer's measurement would land in ONE array and the first match would
  // win. Filtering the prompt is not a defence — a prompt is advice. A model
  // that volunteers the id anyway must be refused at the boundary.
  const parsed = parseVisualObservationAnswers({
    text: `${VISUAL_ANSWER_MARKER} | VIS-F-REF-GROUND-INVERTED | home | 375x812 | satisfied | looked on-brand to me`,
    frames: [FRAME],
  });
  assert.deepEqual(parsed.answers, [], "a grader answer to a measured question was accepted");
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]?.reason ?? "", /answered by measurement, not by a grader/);

  // AND THE REFUSAL IS NOT A PASS. The question comes back unknown, exactly as
  // if the grader had said nothing — which is what it did say, correctly.
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: parsed.answers,
  });
  const row = record.outcomes.find((o) => o.observationId === "VIS-F-REF-GROUND-INVERTED");
  assert.equal(row?.verdict, "unknown");
  assert.equal(row?.unknownReason, "not_answered");
  // The owner-facing note must not blame a grader nobody asked.
  assert.doesNotMatch(row?.note ?? "", /the grader returned no answer/);
  assert.match(row?.note ?? "", /no host-side measurement was supplied/);
});

test("the prompt makes the TIER SPLIT explicit — taste never blocks, the objective set can", () => {
  const p = visualGatePrompt(GATE_INPUT);
  assert.match(p, /TASTE IS QUALITY TIER AND IT NEVER BLOCKS A RUN/);
  assert.match(p, /OBJECTIVE OBSERVATIONS BELOW ARE FUNCTIONAL TIER/);
  assert.match(p, /you do not decide what belongs in/);
});

test("the prompt names BELOW THE FOLD as an unknown, with the reason the capture is bounded", () => {
  // Requirement 4 at the point it actually fails: without this the grader
  // answers 'satisfied' about a section it never saw. Defect #35's shape.
  const p = visualGatePrompt(GATE_INPUT);
  assert.match(p, /below_the_fold/);
  assert.match(p, /no fullPage/);
  assert.match(p, /UNKNOWN IS A REAL ANSWER AND IT IS NOT A PASS/);
});

test("the prompt states which MODE the run is in, and defaults to shadow", () => {
  const dflt = visualGatePrompt(GATE_INPUT);
  assert.match(dflt, /shadow mode, so none of them can fail the run/);
  const gating = visualGatePrompt({ ...GATE_INPUT, mode: "gating" });
  assert.match(gating, /CAN FAIL THE RUN at FUNCTIONAL tier/);
  assert.notEqual(dflt, gating, "the grader must be able to tell the two runs apart");
});

test("with no preview URL the prompt says the objective set is unanswerable, not satisfied", () => {
  const p = visualGatePrompt({ ...GATE_INPUT, previewUrl: null });
  assert.match(p, /UNKNOWN\/no_screenshot/);
  assert.match(p, /questions about pixels/);
});

test("the prompt forbids widening the capture and naming a screenshot path", () => {
  const p = visualGatePrompt(GATE_INPUT);
  assert.match(p, /Never widen the capture/);
  assert.match(p, /never name a screenshot file/i);
});

test("the observation block reflects the LOCK, so the grader is not told a locked entry gates", () => {
  const gating = visualObservationBlock("gating");
  assert.match(gating, /VIS-F-EMPTY-REGION \[FUNCTIONAL, shadow-locked: cannot fail a run\]/);
  assert.match(gating, /VIS-F-EMPTY-FRAME \[FUNCTIONAL\]/);
});

/* ---- 7. The measured answers, from the blind run ---------------------- */

/**
 * WHAT THIS SECTION IS. On 2026-07-29 seven captures were taken at 375x812 with
 * the container's own settings (`newContext` locale/timezone/colorScheme/
 * reducedMotion per `scorer-container.ts:625-633`; `page.screenshot` with
 * `animations:"disabled"`, `caret:"hide"`, `scale:"css"` and NO `fullPage` per
 * :674-680), copied under random UUID names, and answered against
 * {@link VISUAL_OBSERVATIONS} BEFORE the name-to-artefact mapping was opened.
 * 7/7 matched. The answers are transcribed here because they are the only
 * evidence that these questions are ANSWERABLE FROM A CAPTURE — the design note
 * argued answerability from geometry and explicitly did not demonstrate it.
 *
 * TWO OF THE SEVEN WERE BUILT FOR IT. `hollow-section` is now COMMITTED, at
 * `calibration/hollow-section/` and registered as
 * {@link HOLLOW_SECTION_FIXTURE} rather than in `FIXTURES` — read that export's
 * comment for the two `calibration.test.ts` assertions that go red if it is moved.
 * `filled-control` stays a MUTATION of the committed copy rather than a second
 * committed directory, because a second directory drifts from the first and a
 * mutation cannot. The two are the SAME markup and differ by ONE CSS declaration — `#about-body p{color:var(--paper)}` against
 * `{color:var(--ink)}` on a `--paper` background. Measured: `#about-body`
 * `innerText` is 272 characters in BOTH and body `innerText` is 468 in both, so
 * every text assertion in the tree passes on both; computed colour is
 * `rgb(255,255,255)` against a `rgb(255,255,255)` page in the hollow one. The
 * region geometry was ASSERTED rather than assumed, at all three breakpoints:
 * `#about h2` [172,210] and `#about-body` [230,542] inside a 812-tall frame at
 * 375, [204,243]/[263,457] inside 1024 at 768, [172,210]/[230,424] inside 800 at
 * 1280 — heading and empty body both in frame, `#about` entirely above
 * `#projects`, 0 failures. A fixture whose discriminating evidence is off-screen
 * reports green because the check cannot see it.
 */
const MEASURED_375: readonly { artefact: string; emptyFrame: VisualAnswerVerdict; emptyRegion: VisualAnswerVerdict }[] = [
  { artefact: "hollow-section", emptyFrame: "satisfied", emptyRegion: "violated" },
  { artefact: "filled-control", emptyFrame: "satisfied", emptyRegion: "satisfied" },
  { artefact: "correct-portfolio", emptyFrame: "satisfied", emptyRegion: "satisfied" },
  { artefact: "stock-motion-only", emptyFrame: "satisfied", emptyRegion: "satisfied" },
  { artefact: "missing-section", emptyFrame: "satisfied", emptyRegion: "satisfied" },
  { artefact: "stub-markers", emptyFrame: "satisfied", emptyRegion: "satisfied" },
  { artefact: "blank-page", emptyFrame: "violated", emptyRegion: "satisfied" },
];

test("MEASURED: the two entries' fire sets are DISJOINT — EMPTY-FRAME is not a subset", () => {
  // Design note §8: if EMPTY-REGION also fired on `blank-page`, EMPTY-FRAME
  // would be a strict subset of it and the two entries would have to collapse
  // into one. Measured blind, they fire on different artefacts and never on the
  // same one: `blank-page` (nothing is here) against `hollow-section` (the page
  // drew a container and did not fill it). Two questions, not one phrased twice.
  const frameFires = MEASURED_375.filter((m) => m.emptyFrame === "violated").map((m) => m.artefact);
  const regionFires = MEASURED_375.filter((m) => m.emptyRegion === "violated").map((m) => m.artefact);
  assert.deepEqual(frameFires, ["blank-page"]);
  assert.deepEqual(regionFires, ["hollow-section"]);
  assert.equal(frameFires.filter((a) => regionFires.includes(a)).length, 0, "the sets overlap");
});

test("MEASURED: neither entry fires on ANY of the five committed calibration fixtures", () => {
  // The half of calibration that matters most. A FUNCTIONAL finding on
  // `stock-motion-only` turns `pass_with_notes` into `fail` (verdict.ts:210),
  // and one on `correct-portfolio` turns `pass` into `fail`. Both are must-pass.
  const committed = ["correct-portfolio", "stock-motion-only", "missing-section", "stub-markers", "blank-page"];
  for (const name of committed) {
    const row = MEASURED_375.find((m) => m.artefact === name);
    assert.ok(row !== undefined, `${name} was not in the measured set`);
    assert.equal(row.emptyRegion, "satisfied", `${name}: EMPTY-REGION fired on a committed fixture`);
  }
  // `blank-page` is the one exception, and it is a fixture that must FAIL.
  const frameFires = committed.filter((n) => MEASURED_375.find((m) => m.artefact === n)?.emptyFrame === "violated");
  assert.deepEqual(frameFires, ["blank-page"]);
});

test("MEASURED: the hollow build fires EMPTY-REGION ALONE, and the restore silences it", () => {
  // BREAK IT, WATCH IT GO RED, RESTORE IT, WATCH IT GO GREEN — over the module,
  // with the answers that were given blind. `GATE:screenshots-present` PASSES on
  // the hollow build: 19060 / 33002 / 27832 bytes against MIN_SCREENSHOT_BYTES
  // = 1024, so `nonBlank` is true at all three breakpoints, 18.6x the floor at
  // the tightest. This is not a subset of that gate.
  const frame: VisualFrame = { flowId: "home", breakpoint: "375" };
  const base: VisualObservationAnswer[] = [
    { observationId: "VIS-F-EMPTY-FRAME", frame, verdict: "satisfied", note: "a hero name, an About heading, a Projects section with filled cards" },
    { observationId: "VIS-F-PLACEHOLDER-MEDIA", frame, verdict: "satisfied", note: "the frame contains no image slot at all" },
  ];
  const hollow = evaluateVisualSubstance({
    frames: [frame],
    answers: [
      ...base,
      { observationId: "VIS-F-EMPTY-REGION", frame, verdict: "violated", note: "an About heading over a bordered panel containing no glyph, no image and no control" },
    ],
  });
  assert.deepEqual(hollow.violations.map((v) => v.observationId), ["VIS-F-EMPTY-REGION"], "it must fire ALONE");

  const restored = evaluateVisualSubstance({
    frames: [frame],
    answers: [
      ...base,
      { observationId: "VIS-F-EMPTY-REGION", frame, verdict: "satisfied", note: "the same bordered panel, full of body copy" },
    ],
  });
  assert.deepEqual(restored.violations, [], "the restore must go green");
});

/* ---- 8. The arithmetic verdict.ts would see --------------------------- */

test("SHADOW contributes nothing to a FUNCTIONAL count even when everything fires", () => {
  // verdict.ts:210 — any BLOCKING or FUNCTIONAL finding means `fail`. This is
  // the assertion that stands between a shadow run and `stock-motion-only`
  // flipping from pass_with_notes to fail.
  for (const mode of ["shadow", "gating"] as const satisfies readonly VisualSubstanceMode[]) {
    const record = evaluateVisualSubstance({
      mode,
      frames: [FRAME],
      answers: VISUAL_OBSERVATIONS.map((o) =>
        answer(o.id, { verdict: "violated", note: "fired on every enumerated question" }),
      ),
      pageEvidence: BLANK_PAGE_EVIDENCE,
    });
    assert.equal(record.violations.length, 4, `${mode}: all four must be recorded`);
    assert.equal(
      gatingFindingCount(record),
      mode === "shadow" ? 0 : 1,
      `${mode}: only the unlocked entry may ever count`,
    );
  }
});

/* ---- 9. Corroboration — the change that took four false fails to zero -- */

/**
 * WHAT THIS SECTION PROTECTS. `VIS-F-EMPTY-FRAME` shipped `shadowLocked: false`,
 * which made it the one entry a `"gating"` run unlocks. The adversarial control
 * set then measured TWO of eight CORRECT builds answering `violated` on it — a
 * page whose full-bleed cover comes from a photo host denied by `--network=none`
 * (928 chars of `innerText`, capture 2541/4468/4718 B, luminance stddev 0.000,
 * one distinct colour — byte-identical to `blank-page`), and a correct
 * `writing-mode: vertical-rl` Japanese page at 375 (367 chars, 2541 B). Four live
 * FUNCTIONAL false fails. The rule below is what removes them, and the tests are
 * written so that DELETING it turns them red rather than merely changing a count.
 */
const CORROBORATED: VisualObservationAnswer = {
  observationId: "VIS-F-EMPTY-FRAME",
  frame: FRAME,
  verdict: "violated",
  note: "a single flat field of background colour, no glyph and no control anywhere in the frame",
};

test("exactly the entries that need corroboration declare it, and EMPTY-FRAME is one", () => {
  // ASSERTED BY LITERAL. `filter(o => o.corroboration !== null).length === 1`
  // stays green if the rule migrates to the wrong entry — and on the hollow
  // fixture `page_text_empty` is actively WRONG: its body innerText is 468.
  assert.deepEqual(
    VISUAL_OBSERVATIONS.filter((o) => o.corroboration !== null).map((o) => [o.id, o.corroboration]),
    [["VIS-F-EMPTY-FRAME", "page_text_empty"]],
  );
});

test("MEASURED: with innerText 0 the finding STANDS — blank-page and reward-hacked keep firing", () => {
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [CORROBORATED],
    pageEvidence: [{ frame: FRAME, innerTextLength: 0 }],
  });
  assert.equal(record.violations.length, 1);
  assert.equal(gatingFindingCount(record), 1);
  assert.equal(record.corroborationWithheld.length, 0);
});

test("MEASURED: case 03's 928 characters kill the false fail, and it is unknown not satisfied", () => {
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [CORROBORATED],
    pageEvidence: [{ frame: FRAME, innerTextLength: 928 }],
  });
  assert.equal(gatingFindingCount(record), 0, "the false fail survived");
  const row = record.outcomes.find((o) => o.observationId === "VIS-F-EMPTY-FRAME");
  assert.equal(row?.verdict, "unknown");
  assert.equal(row?.unknownReason, "corroboration_contradicted");
  // NOT `satisfied`. A capture reading as a flat field over a page carrying 928
  // characters is a question the evidence cannot answer, not a page that passed.
  assert.notEqual(row?.verdict, "satisfied");
  // AND THE GRADER'S OWN WORD SURVIVES, so shadow mode still measures the MODEL.
  assert.equal(row?.rawVerdict, "violated");
  assert.equal(record.corroborationWithheld.length, 1);
});

test("MEASURED: case 06's 367 characters kill it at 375 too — one bad breakpoint was enough", () => {
  // Case 06 answered `violated` at 375 and `satisfied` at 768 and 1280, so a
  // per-frame finding meant a single breakpoint failed the run.
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME, WIDE],
    answers: [CORROBORATED, answer("VIS-F-EMPTY-FRAME", { frame: WIDE })],
    pageEvidence: [
      { frame: FRAME, innerTextLength: 367 },
      { frame: WIDE, innerTextLength: 367 },
    ],
  });
  assert.equal(gatingFindingCount(record), 0);
});

test("a finding with NO measurement is withheld — not admitted, and not a pass either", () => {
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [CORROBORATED],
  });
  assert.equal(gatingFindingCount(record), 0, "an uncorroborated finding reached the verdict");
  const row = record.outcomes.find((o) => o.observationId === "VIS-F-EMPTY-FRAME");
  assert.equal(row?.verdict, "unknown");
  assert.equal(row?.unknownReason, "corroboration_missing");
});

test("corroboration NEVER manufactures a finding — a satisfied answer stays satisfied", () => {
  // The rule is a precondition on RED, not a second detector. A page with zero
  // rendered text and a frame the grader says has content in it (an image-only
  // hero) must not be failed by the measurement alone.
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME],
    answers: [answer("VIS-F-EMPTY-FRAME", { note: "a full-bleed photograph fills the frame" })],
    pageEvidence: [{ frame: FRAME, innerTextLength: 0 }],
  });
  assert.equal(record.violations.length, 0);
  assert.equal(gatingFindingCount(record), 0);
});

test("corroboration is PER FRAME, not per flow — the evidence must match the breakpoint", () => {
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [FRAME, WIDE],
    answers: [CORROBORATED, { ...CORROBORATED, frame: WIDE }],
    pageEvidence: [
      { frame: FRAME, innerTextLength: 0 },
      { frame: WIDE, innerTextLength: 240 },
    ],
  });
  assert.equal(gatingFindingCount(record), 1, "the wide frame's 240 characters must not be borrowed");
  assert.equal(verdictFindings(record)[0]?.frame.breakpoint, FRAME.breakpoint);
});

test("the report says how many findings corroboration withheld, even when the answer is zero", () => {
  // A rule that never withholds anything is indistinguishable from no rule.
  const clean = renderVisualSubstanceReport({
    record: evaluateVisualSubstance({ frames: [FRAME], answers: allSatisfied() }),
    taste: [],
  });
  assert.match(clean, /Findings withheld because the page's own measurements disagree: 0\./);
  const withheld = renderVisualSubstanceReport({
    record: evaluateVisualSubstance({
      mode: "gating",
      frames: [FRAME],
      answers: [CORROBORATED],
      pageEvidence: [{ frame: FRAME, innerTextLength: 928 }],
    }),
    taste: [],
  });
  assert.match(withheld, /Findings withheld because the page's own measurements disagree: 1\./);
  assert.match(withheld, /WITHHELD at home \/ 375x812 — the grader answered VIOLATED/);
});

/* ---- 10. The parser — the other end of the loop ------------------------ */

test("the PROMPT'S OWN worked example parses — the format and the parser cannot drift", () => {
  // Before this existed the module had no parser at all: the prompt asked for
  // "satisfied / violated / unknown plus one sentence" and nothing could score it,
  // so `"gating"` mode was a label. This asserts the two are the same format by
  // parsing the prompt itself rather than a hand-written imitation of it.
  const block = visualObservationBlock("gating");
  const frames: VisualFrame[] = [
    { flowId: "home", breakpoint: "375x812" },
    { flowId: "home", breakpoint: "1280x800" },
  ];
  const parsed = parseVisualObservationAnswers({ text: block, frames });
  assert.equal(parsed.answers.length, 2, "the worked example lines did not parse");
  // The prompt also prints the SCHEMA line, which starts with the same marker and
  // whose id is the literal `<OBSERVATION-ID>`. The parser refuses it, and that is
  // the property rather than an accident: a grader that echoes the template back
  // produces a rejection and an `unknown`, never a pass.
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]?.reason ?? "", /not an enumerated observation/);
  assert.equal(parsed.answers[0]?.verdict, "satisfied");
  assert.equal(parsed.answers[1]?.verdict, "unknown");
  assert.equal(parsed.answers[1]?.unknownReason, "below_the_fold");
});

test("a parsed VIOLATED answer reaches a verdict finding — the loop closes end to end", () => {
  const frames = [FRAME];
  const text = [
    "Here is what I saw.",
    `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-FRAME | home | 375x812 | violated | nothing in the frame but a field of colour`,
    `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-REGION | home | 375x812 | satisfied | no region is set aside and left empty`,
    `${VISUAL_ANSWER_MARKER} | VIS-F-PLACEHOLDER-MEDIA | home | 375x812 | satisfied | there is no image slot at all`,
  ].join("\n");
  const parsed = parseVisualObservationAnswers({ text, frames });
  assert.equal(parsed.answers.length, 3);
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames,
    answers: parsed.answers,
    pageEvidence: [{ frame: FRAME, innerTextLength: 0 }],
  });
  assert.equal(gatingFindingCount(record), 1);
  assert.equal(verdictFindings(record)[0]?.observationId, "VIS-F-EMPTY-FRAME");
});

test("NOTHING UNPARSEABLE BECOMES SATISFIED — defect #35's shape at the parse boundary", () => {
  const frames = [FRAME];
  const text = [
    "VIS-ANSWER | VIS-F-EMPTY-FRAME | home | 375x812 | pass | looked fine to me",
    "VIS-ANSWER | VIS-F-EMPTY-REGION | home",
    "the placeholder question is fine, honestly",
  ].join("\n");
  const parsed = parseVisualObservationAnswers({ text, frames });
  assert.equal(parsed.answers.length, 1, "only the first line has enough fields");
  assert.equal(parsed.answers[0]?.verdict, "unknown", '"pass" must not be read as satisfied');
  assert.equal(parsed.answers[0]?.unknownReason, "cannot_tell");
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0]?.reason ?? "", /expected 5 \|-separated fields/);
  // And the two questions nobody answered come back unknown, not clean.
  const record = evaluateVisualSubstance({ mode: "gating", frames, answers: parsed.answers });
  assert.equal(record.outcomes.filter((o) => o.verdict === "satisfied").length, 0);
  // FOUR, not three: the measured entry is unknown here too, because no producer
  // ran. A grader's formatting slip must not leave it looking answered.
  assert.equal(record.unknowns.length, 4);
});

test("a GRADER may not claim a corroboration reason — that conclusion comes from measurement", () => {
  // A grader that could assert `corroboration_contradicted` could talk its way
  // out of a finding by naming a fact it did not measure.
  const parsed = parseVisualObservationAnswers({
    text: `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-FRAME | home | 375x812 | unknown:corroboration_contradicted | trust me`,
    frames: [FRAME],
  });
  assert.equal(parsed.answers[0]?.unknownReason, "cannot_tell");
});

test("an INVENTED id and an INVENTED frame are both rejected, and recorded rather than dropped", () => {
  const parsed = parseVisualObservationAnswers({
    text: [
      `${VISUAL_ANSWER_MARKER} | VIS-F-UGLY-PALETTE | home | 375x812 | violated | the palette is muddy`,
      `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-FRAME | checkout | 375x812 | violated | a flow nobody captured`,
    ].join("\n"),
    frames: [FRAME],
  });
  assert.deepEqual(parsed.answers, []);
  assert.equal(parsed.rejected.length, 2);
  assert.match(parsed.rejected[0]?.reason ?? "", /not an enumerated observation/);
  assert.match(parsed.rejected[1]?.reason ?? "", /no capture exists for flow checkout/);
});

test("the FIRST answer for a pair stands — a trailing satisfied cannot erase a violated", () => {
  const parsed = parseVisualObservationAnswers({
    text: [
      `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-FRAME | home | 375x812 | violated | a flat field of colour`,
      `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-FRAME | home | 375x812 | satisfied | on reflection it was fine`,
    ].join("\n"),
    frames: [FRAME],
  });
  assert.equal(parsed.answers.length, 1);
  assert.equal(parsed.answers[0]?.verdict, "violated");
  assert.match(parsed.rejected[0]?.reason ?? "", /already answered/);
});

test("a note carrying a path is REDACTED at the parse boundary, not thrown and not kept", () => {
  // Throwing would fail a run for a formatting slip; keeping it would put a path
  // in a record. The boundary guard is still what decides, and the count is
  // reported so the redaction is visible.
  const parsed = parseVisualObservationAnswers({
    text: `${VISUAL_ANSWER_MARKER} | VIS-F-EMPTY-FRAME | home | 375x812 | violated | see results/screenshots/home-375.png`,
    frames: [FRAME],
  });
  assert.equal(parsed.redactedNotes, 1);
  assert.equal(parsed.answers.length, 1);
  assert.doesNotMatch(parsed.answers[0]?.note ?? "", /\.png/);
  assert.doesNotThrow(() =>
    evaluateVisualSubstance({ frames: [FRAME], answers: parsed.answers }),
  );
});

/* ---- 11. The owner-facing label, and the committed 8th artefact -------- */

test("every enumerated observation has a real owner-facing sentence, not its own id", () => {
  // `verdict.ts` renders this and never `outcome.note`. An entry added without a
  // label would render as a machine id at the owner — backlog #36's defect.
  assert.ok(VISUAL_OBSERVATIONS.length > 0);
  for (const observation of VISUAL_OBSERVATIONS) {
    const label = visualObservationLabel(observation.id);
    assert.notEqual(label, observation.id, `${observation.id} has no label`);
    assert.ok(label.length > 30, `${observation.id}: label too short to be a sentence`);
  }
});

test("THE 8TH ARTEFACT IS COMMITTED, and its hollowness is in the file rather than in a comment", () => {
  // The premise the geometry rests on, asserted statically so an edit that breaks
  // it goes red here rather than silently making the fixture unable to see itself.
  const dir = artefactDir(HOLLOW_SECTION_FIXTURE.name);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const css = readFileSync(join(dir, "style.css"), "utf8");

  // 1. The hollow declaration: the panel's copy is the page background colour.
  assert.match(css, /#about-body p\{color:var\(--paper\)\}/);
  assert.match(css, /--paper:#fff/);
  // 2. The panel is a DRAWN container, which is what the entry's trigger names.
  assert.match(css, /\.panel\{border:1px solid/);
  assert.match(css, /min-height:9rem/);
  // 3. The copy IS present, so every `.length` assertion in the tree passes.
  const panel = /<div class="panel" id="about-body"><p>([^<]+)<\/p><\/div>/.exec(html);
  assert.ok(panel !== null, "the panel markup changed shape");
  assert.ok((panel[1] ?? "").length > 200, "the hollow panel must still carry real copy");
  // 4. `#about` is ABOVE `#projects` in the markup, and the hero is short. Both
  //    are what put the region inside a 375x812 frame; the measured geometry is
  //    on HOLLOW_SECTION_FIXTURE.assertedGeometry.
  assert.ok(html.indexOf('id="about"') < html.indexOf('id="projects"'), "#about is not above #projects");
  assert.match(css, /\.hero\{min-height:18vh/);
  // 5. It still satisfies the portfolio suite, which is WHY it is not in FIXTURES.
  assert.match(html, /<h1>Ada Lovelace<\/h1>/);
  assert.equal((html.match(/<article class="project">/g) ?? []).length, 3);
  assert.match(html, /id="confirm"/);
});

test("the 8th artefact is NOT in FIXTURES, and the reason is on the export", () => {
  // Moving it in turns `calibration.test.ts` red on two assertions it does not
  // own: the container grades it `pass_with_notes` and its `heldOutPass` is true.
  assert.equal(
    FIXTURES.some((f) => f.name === HOLLOW_SECTION_FIXTURE.name),
    false,
    "hollow-section is in FIXTURES; calibration.test.ts will grade it in a container with no visual input",
  );
  assert.equal(HOLLOW_SECTION_FIXTURE.expectedWithoutVisualGate, "pass_with_notes");
  assert.equal(HOLLOW_SECTION_FIXTURE.expectedWithVisualGate, "fail");
  assert.deepEqual(HOLLOW_SECTION_FIXTURE.firesOn, ["VIS-F-EMPTY-REGION"]);
  assert.equal(HOLLOW_SECTION_FIXTURE.assertedGeometry.length, 3, "geometry must be asserted at all three");
});

/* ---- 12. VIS-F-REF-GROUND-INVERTED — measured on the real artefacts ---- */

/**
 * WHERE EVERY NUMBER IN THIS SECTION CAME FROM. Measured 2026-08-05 with `sharp`
 * 0.34.5 from `dashboard/node_modules`, over READ-ONLY run directories, by the
 * mechanism the entry declares: decode, longest edge 160px, quantise 16 levels
 * per channel, take the centroid and area share of the largest bucket, convert to
 * CIELAB and read `L*`.
 *
 * THE HARNESS WAS VALIDATED AGAINST THE RUN'S OWN CAPTURE BEFORE ANY OF IT WAS
 * TRUSTED. The known-good workspace was re-rendered here under the container's
 * own context (`viewport 1280x800`, `locale en-US`, `timezoneId UTC`,
 * `colorScheme light`, `reducedMotion reduce`; `page.screenshot` with
 * `animations disabled`, `caret hide`, `scale css` and NO `fullPage`, per
 * `scorer-container.ts:625-633` and `:673-680`) and reproduced the run's own
 * committed capture EXACTLY: ground `#1c1a17`, share 59.0 percent, `L*` 9.4.
 * A calibration whose harness disagrees with the artefact it is calibrating
 * against is measuring itself.
 *
 * THE FIRE DIRECTION IS A REAL RENDER, NOT A DECLARED CSS VALUE. The bad
 * artefact is a ONE-DECLARATION mutation of the known-good build — `--bg`
 * `#1c1a17` to `#f8fafc` at `styles.css:8`, nothing else, `diff` is two lines —
 * rendered through the same harness. That is `hollow-section`'s rule applied
 * here: "a second directory drifts from the first and a mutation cannot".
 *
 * AND THE MEASUREMENT THAT LOCKED THE ENTRY. A THIRD variant implements the SAME
 * locked dark ground legitimately, behind `@media (prefers-color-scheme: dark)`
 * with a light default. Under the container's pinned `colorScheme: "light"` it
 * renders `#f8fafc`, share 56.7 percent, `L*` 98.2 — identical to the deliberate
 * inversion in all three numbers. The mechanism cannot separate a correct build
 * from a broken one there, which is a FUNCTIONAL false fail on a CORRECT
 * artefact, which is the one thing this file may not ship. It is rendered as a
 * test below rather than left in a comment.
 */
const REF_2026_07_29 = { lightness: 5.9, share: 0.335 } as const; // locked 01-hero
const BUILD_2026_07_29_1280 = { lightness: 9.4, share: 0.59 } as const; // the run's own capture
const BUILD_2026_07_29_768 = { lightness: 9.3, share: 0.503 } as const;
const BUILD_2026_07_29_375 = { lightness: 9.4, share: 0.614 } as const;
const BUILD_INVERTED_1280 = { lightness: 98.2, share: 0.567 } as const; // one-declaration mutation, rendered
const BUILD_MEDIA_DARK_1280 = { lightness: 98.2, share: 0.567 } as const; // CORRECT, and indistinguishable
const REF_2026_07_30 = { lightness: 95.6, share: 0.387 } as const; // the other real lock, light
const BUILD_CORRECT_PORTFOLIO = { lightness: 95.2, share: 0.848 } as const; // a real light capture

test("MEASURED: it does NOT fire on the one build that ever passed, at any breakpoint", () => {
  // THE HALF THAT MATTERS MOST. A fidelity check that fails the only artefact
  // this project has ever shipped green is worse than no check, and the rejected
  // character-floor family failed exactly here (2026-07-29 design note §6).
  for (const build of [BUILD_2026_07_29_1280, BUILD_2026_07_29_768, BUILD_2026_07_29_375]) {
    const answer = groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_29, build });
    assert.equal(answer.verdict, "satisfied", `L* ${build.lightness} against locked L* 5.9`);
    assert.equal(answer.observationId, REF_GROUND_INVERTED_ID);
  }
  // And it reaches a clean record: no violation, nothing withheld, nothing unknown.
  const record = evaluateVisualSubstance({
    mode: "gating",
    frames: [WIDE],
    answers: [groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_29, build: BUILD_2026_07_29_1280 })],
  });
  const row = record.outcomes.find((o) => o.observationId === REF_GROUND_INVERTED_ID);
  assert.equal(row?.verdict, "satisfied");
  assert.equal(gatingFindingCount(record), 0);
});

test("MEASURED: the second real lock is LIGHT and the check is not hard-wired to dark", () => {
  // Without this the whole mechanism could be `L* < 50` and every assertion above
  // would still pass. The 2026-07-30 lock measures L* 95.6; a light build against
  // it is satisfied and the SAME dark build that passes above is violated.
  assert.equal(
    groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_30, build: BUILD_CORRECT_PORTFOLIO }).verdict,
    "satisfied",
  );
  assert.equal(
    groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_30, build: BUILD_2026_07_29_1280 }).verdict,
    "violated",
    "a dark build against a light lock must fire — the check is directionless, not dark-seeking",
  );
});

test("MEASURED: the one-declaration inverted render FIRES, and the restore silences it", () => {
  // BREAK IT, WATCH IT GO RED, RESTORE IT, WATCH IT GO GREEN — over the module,
  // on two real renders of the same markup differing by one CSS declaration.
  const fired = groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_29, build: BUILD_INVERTED_1280 });
  assert.equal(fired.verdict, "violated");
  assert.match(fired.note, /inverted the polarity of the design that was chosen/);

  const restored = groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_29, build: BUILD_2026_07_29_1280 });
  assert.equal(restored.verdict, "satisfied", "the restore must go green");
});

test("MEASURED, AND THIS IS WHY IT IS LOCKED: a CORRECT dark-mode build is indistinguishable", () => {
  // `scorer-container.ts:632` pins every capture to `colorScheme: "light"`. A
  // build implementing the locked dark ground behind
  // `@media (prefers-color-scheme: dark)` renders LIGHT in the only capture this
  // check can read. Rendered through the container's own settings, it produced
  // the same three numbers as the deliberate inversion, to the digit.
  assert.deepEqual(
    { ...BUILD_MEDIA_DARK_1280 },
    { ...BUILD_INVERTED_1280 },
    "if these ever diverge the disqualifier is gone and the lock can be revisited",
  );
  const correctBuild = groundPolarityAnswer({
    frame: WIDE,
    reference: REF_2026_07_29,
    build: BUILD_MEDIA_DARK_1280,
  });
  assert.equal(correctBuild.verdict, "violated", "the false fail is real and this test records it");

  // SO THE ENTRY MUST NOT BE ABLE TO ACT ON IT. This is the assertion that makes
  // the measurement above safe to have in the tree at all: even with the mode
  // flag ON, the false fail is recorded and cannot fail the run.
  const record = evaluateVisualSubstance({ mode: "gating", frames: [WIDE], answers: [correctBuild] });
  assert.equal(record.violations.length, 1, "it must still be RECORDED");
  assert.equal(gatingFindingCount(record), 0, "a measured false fail reached the verdict");
  assert.equal(record.violations[0]?.withheldBecause, "entry_shadow_locked");
});

test("NO LOCKED REFERENCE IS UNKNOWN, NEVER SATISFIED — a check that only observes success", () => {
  // `scorer.ts:1253` maps `not_applicable` to `passed: true`. A fidelity check
  // reporting GREEN on every ticket that supplied no design is this project's
  // signature defect with a fidelity label on it.
  const answer = groundPolarityAnswer({ frame: WIDE, reference: null, build: BUILD_INVERTED_1280 });
  assert.equal(answer.verdict, "unknown");
  assert.equal(answer.unknownReason, "no_locked_reference");
  assert.notEqual(answer.verdict, "satisfied");

  const record = evaluateVisualSubstance({ mode: "gating", frames: [WIDE], answers: [answer] });
  assert.equal(record.outcomes.filter((o) => o.verdict === "satisfied").length, 0);
  assert.equal(gatingFindingCount(record), 0);
});

test("a missing capture is unknown/no_screenshot, and a groundless reference is unknown too", () => {
  const noCapture = groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_29, build: null });
  assert.equal(noCapture.verdict, "unknown");
  assert.equal(noCapture.unknownReason, "no_screenshot");

  // A reference whose dominant colour holds less than the floor: "the
  // reference's ground" names nothing, so there is nothing to compare a sign to.
  const groundless = groundPolarityAnswer({
    frame: WIDE,
    reference: { lightness: 5.9, share: GROUND_MIN_SHARE - 0.01 },
    build: BUILD_INVERTED_1280,
  });
  assert.equal(groundless.verdict, "unknown");
  assert.equal(groundless.unknownReason, "ref_has_no_ground");
});

test("THE TWO CHOSEN CONSTANTS CAN ONLY WIDEN UNKNOWN — neither can manufacture a red", () => {
  // THE STRUCTURAL DIFFERENCE FROM THE REJECTED CHARACTER-FLOOR FAMILY. Those
  // numbers decided PASS or FAIL and fired on the correct artefact at every
  // value. These decide FIRE or UNKNOWN, and `unknown` is non-passing and
  // non-gating. Every ambiguity degrades away from red, in both directions.
  const midpointish = { lightness: POLARITY_MIDPOINT + POLARITY_MARGIN - 1, share: 0.9 };
  for (const [reference, build] of [
    [midpointish, BUILD_2026_07_29_1280],
    [REF_2026_07_29, midpointish],
  ] as const) {
    const answer = groundPolarityAnswer({ frame: WIDE, reference, build });
    assert.equal(answer.verdict, "unknown", "an ambiguous ground must not decide anything");
    assert.equal(answer.unknownReason, "ground_polarity_ambiguous");
  }
  // The mirror: just OUTSIDE the margin on both sides, the sign comparison runs.
  const justOutside = { lightness: POLARITY_MIDPOINT + POLARITY_MARGIN + 0.1, share: 0.9 };
  assert.equal(
    groundPolarityAnswer({ frame: WIDE, reference: REF_2026_07_29, build: justOutside }).verdict,
    "violated",
    "widening unknown must not be the only thing the margin can do",
  );
});

test("SAME POLARITY IS SATISFIED HOWEVER FAR APART — the answer is a sign, not a distance", () => {
  // The entry's own non-trigger, asserted: "charcoal against near-black is not an
  // inversion". Near-black L* 5.9 against a mid-dark L* 34.9 is 29 points of
  // distance and the same sign. A distance check would have a threshold here; a
  // sign check does not, which is the §1.1 line that admitted this entry.
  const answer = groundPolarityAnswer({
    frame: WIDE,
    reference: REF_2026_07_29,
    build: { lightness: 34.9, share: 0.6 },
  });
  assert.equal(answer.verdict, "satisfied");
  assert.match(answer.note, /not an inversion/);
});

test("the producer's notes clear the screenshot boundary on every branch", () => {
  // Every note this producer can emit crosses `assertNoScreenshotReference` when
  // the record is built. A note carrying a path would throw INSIDE a gate run.
  const grounds = [
    REF_2026_07_29,
    BUILD_INVERTED_1280,
    { lightness: 50, share: 0.9 },
    { lightness: 5.9, share: 0.01 },
  ];
  const answers = [
    groundPolarityAnswer({ frame: WIDE, reference: null, build: null }),
    ...grounds.flatMap((reference) =>
      [null, ...grounds].map((build) => groundPolarityAnswer({ frame: WIDE, reference, build })),
    ),
  ];
  assert.ok(answers.length > 10, "an empty list asserts nothing");
  for (const answer of answers) {
    assert.doesNotThrow(() => assertNoScreenshotReference(answer.note, "producer"), answer.note);
    assert.ok(answer.note.length > 30, "a note nobody can read is a finding the owner never sees");
  }
});
