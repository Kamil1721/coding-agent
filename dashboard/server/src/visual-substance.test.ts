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
import {
  assertNoScreenshotReference,
  DEFAULT_VISUAL_SUBSTANCE_MODE,
  evaluateVisualSubstance,
  gatingFindingCount,
  isGatingObservation,
  renderVisualSubstanceReport,
  TASTE_TIER,
  VISUAL_OBSERVATIONS,
  verdictFindings,
  visualObservationBlock,
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

/** Every observation answered `satisfied` on one frame — the quiet baseline. */
function allSatisfied(frame: VisualFrame = FRAME): VisualObservationAnswer[] {
  return VISUAL_OBSERVATIONS.map((o) => answer(o.id, { frame }));
}

/* ---- 1. The set itself, against M4 ------------------------------------ */

test("THE SET IS EXACTLY THE THREE ENUMERATED IDS — an emptied or widened set fails here", () => {
  // ASSERTED BY LITERAL, NOT BY LENGTH. `length === 3` stays green if an entry
  // is swapped for an invented one, and design note §4 fixes membership: a model
  // never decides what counts as gating, and neither does a later refactor.
  assert.deepEqual(
    VISUAL_OBSERVATIONS.map((o) => o.id),
    ["VIS-F-EMPTY-FRAME", "VIS-F-EMPTY-REGION", "VIS-F-PLACEHOLDER-MEDIA"],
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

test("the two entries the design note locks are locked, and the flag cannot lift them", () => {
  // Design note §7.2: these "stay shadowed regardless of how the seven sort".
  for (const id of ["VIS-F-EMPTY-REGION", "VIS-F-PLACEHOLDER-MEDIA"]) {
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
  assert.equal(missing.length, 2);
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
  });
  const report = renderVisualSubstanceReport({ record, taste: visualCriteriaFor({ lockedMockup: null }) });
  assert.doesNotMatch(report, /\.(png|jpe?g|webp|gif|avif)\b/i);
});

/* ---- 6. The prompt the grader actually reads -------------------------- */

const GATE_INPUT = { manifest: null, workspace: "/runs/r1/workspace", previewUrl: "http://127.0.0.1:4180" };

test("the prompt carries EVERY enumerated observation, with its question and its non-trigger", () => {
  // SINGLE-SOURCED: a prompt that restates the set in prose is a second
  // declaration site, and the two drift until the model is answering a question
  // the code does not score.
  const p = visualGatePrompt(GATE_INPUT);
  assert.ok(VISUAL_OBSERVATIONS.length > 0);
  for (const observation of VISUAL_OBSERVATIONS) {
    assert.ok(p.includes(observation.id), `${observation.id} absent from the prompt`);
    assert.ok(p.includes(observation.question), `${observation.id}: question not carried verbatim`);
    assert.ok(p.includes(observation.nonTrigger), `${observation.id}: non-trigger not carried`);
  }
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
 * TWO OF THE SEVEN WERE BUILT FOR IT, in the session scratchpad, never
 * versioned: `hollow-section` and `filled-control` are the SAME markup and
 * differ by ONE CSS declaration — `#about-body p{color:var(--paper)}` against
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
    });
    assert.equal(record.violations.length, 3, `${mode}: all three must be recorded`);
    assert.equal(
      gatingFindingCount(record),
      mode === "shadow" ? 0 : 1,
      `${mode}: only the unlocked entry may ever count`,
    );
  }
});
