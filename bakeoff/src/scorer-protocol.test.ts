/**
 * scorer-protocol.test.ts — unit tests for the QUALITY exception in
 * `GATE:suite-green`.
 *
 * WHY THESE EXIST SEPARATELY FROM THE e2e. `test/quality-gating.e2e.mjs` proves
 * the rule end-to-end through the real sealed container, which is the proof that
 * matters — but a container run cannot cheaply reach the cases that are only
 * dangerous when they are rare: a report whose failure count exceeds the
 * outcomes it emitted, a runner status neither vocabulary explains, a filename
 * that happens to contain a criterion id. Those decide whether the narrowing is
 * a scope or a hole, so they are asserted directly against the pure function.
 *
 * EVERY TEST HERE IS A NEGATIVE CONTROL EXCEPT THE FIRST. The change makes a
 * gate fire less often; the failure mode being guarded is the gate not firing at
 * all, so almost all of this file asserts that something STILL gates.
 *
 * Run with `npm test` (builds, then `node --test dist`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AcceptanceCriterion, CriterionTier } from "./contracts.js";
import {
  TITLE_PATH_SEPARATOR,
  criterionNamedInTestTitle,
  isSuiteTestFailure,
  triageSuiteFailures,
} from "./scorer-protocol.js";
import type { SuiteTestOutcome } from "./scorer-protocol.js";

const criterion = (id: string, tier: CriterionTier): AcceptanceCriterion => ({
  id,
  tier,
  statement: `The system shall satisfy ${id}.`,
  evidenceRequired: `holdout test for ${id}`,
});

/** REQ-001 FUNCTIONAL, REQ-002 BLOCKING, REQ-900 QUALITY. */
const CRITERIA: readonly AcceptanceCriterion[] = [
  criterion("REQ-001", "FUNCTIONAL"),
  criterion("REQ-002", "BLOCKING"),
  criterion("REQ-900", "QUALITY"),
];

/** A failing outcome, titled the way both runners title one. */
const failing = (title: string, file = "holdout/site.spec.mjs"): SuiteTestOutcome => ({
  titlePath: [file, title].join(TITLE_PATH_SEPARATOR),
  ok: false,
  statuses: ["unexpected"],
});

const passing = (title: string, file = "holdout/site.spec.mjs"): SuiteTestOutcome => ({
  titlePath: [file, title].join(TITLE_PATH_SEPARATOR),
  ok: true,
  statuses: ["expected"],
});

/* -------------------------------------------------------------------------
 * The change: QUALITY reports, it never gates
 * ---------------------------------------------------------------------- */

test("a failure bound solely to a QUALITY criterion is excused, not gating", () => {
  const triage = triageSuiteFailures(CRITERIA, [passing("[REQ-001] T-1 ok"), failing("[REQ-900] T-9 a11y")], 1);
  assert.equal(triage.failures.length, 1);
  assert.equal(triage.qualityOnly.length, 1);
  assert.equal(triage.gating.length, 0);
  assert.equal(triage.excusable, true);
});

test("two QUALITY-only failures are excused together, and both are still reported", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-8 a11y"), failing("[REQ-900] T-9 contrast")], 2);
  assert.equal(triage.excusable, true);
  assert.equal(triage.qualityOnly.length, 2);
});

/* -------------------------------------------------------------------------
 * The negative controls: everything else STILL gates
 * ---------------------------------------------------------------------- */

test("an UNTAGGED failure gates — this is what the catch-all is for", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("T-9 nobody claims me")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.qualityOnly.length, 0);
  assert.equal(triage.excusable, false);
});

test("a failure naming a FUNCTIONAL criterion gates", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-001] T-9 the feature")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a failure naming a BLOCKING criterion gates", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-002] T-9 it boots")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a failure naming BOTH a QUALITY and a FUNCTIONAL criterion gates — 'solely' means solely", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] [REQ-001] T-9 both")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.qualityOnly.length, 0);
  assert.equal(triage.excusable, false);
});

test("one excusable failure never carries a gating one with it", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-8 a11y"), failing("[REQ-001] T-9 feature")], 2);
  assert.equal(triage.qualityOnly.length, 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a QUALITY id in the FILE NAME cannot excuse an untagged test in that file", () => {
  // The leading segment of a title path is the file. If it counted, naming a
  // file `REQ-900-a11y.spec.mjs` would switch the catch-all off for everything
  // inside it — a gate disabled by a filename.
  const triage = triageSuiteFailures(CRITERIA, [failing("T-9 untagged", "holdout/REQ-900-a11y.spec.mjs")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a title path with no test title at all names nothing, and gates", () => {
  const triage = triageSuiteFailures(
    CRITERIA,
    [{ titlePath: "holdout/REQ-900.spec.mjs", ok: false, statuses: ["unexpected"] }],
    1,
  );
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a criterion id must be a WHOLE token — REQ-9000 is not REQ-900", () => {
  assert.equal(criterionNamedInTestTitle(`file.spec.mjs${TITLE_PATH_SEPARATOR}[REQ-9000] T-9`, "REQ-900"), false);
  assert.equal(criterionNamedInTestTitle(`file.spec.mjs${TITLE_PATH_SEPARATOR}[REQ-900] T-9`, "REQ-900"), true);
});

/* -------------------------------------------------------------------------
 * Excusing by silence is impossible
 * ---------------------------------------------------------------------- */

test("a report counting MORE failures than it emitted outcomes is never excusable", () => {
  // Two counted, one visible: the invisible one is unattributed, so it could be
  // anything — including a FUNCTIONAL failure. Excusing it would be excusing by
  // silence.
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-9 a11y")], 2);
  assert.equal(triage.attributionComplete, false);
  assert.equal(triage.excusable, false);
});

test("an unparseable failure count (null) is never excusable", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-9 a11y")], null);
  assert.equal(triage.attributionComplete, false);
  assert.equal(triage.excusable, false);
});

test("a pass with NO failures is not excusable, so a bare crash exit can never be excused", () => {
  const triage = triageSuiteFailures(CRITERIA, [passing("[REQ-001] T-1 ok")], 0);
  assert.equal(triage.failures.length, 0);
  assert.equal(triage.excusable, false);
});

/* -------------------------------------------------------------------------
 * What counts as a failure at all
 * ---------------------------------------------------------------------- */

test("skipped and todo outcomes are not failures of this gate", () => {
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["skipped"] }), false);
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["todo"] }), false);
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: true, statuses: ["expected"] }), false);
});

test("a not-ok outcome with an UNRECOGNISED status counts as a failure and gates", () => {
  // The safe direction: a status neither runner's vocabulary explains becomes a
  // failure that must be excused explicitly, never one silently ignored.
  const odd: SuiteTestOutcome = { titlePath: `f.spec.mjs${TITLE_PATH_SEPARATOR}T-9`, ok: false, statuses: ["weird"] };
  assert.equal(isSuiteTestFailure(odd), true);
  assert.equal(triageSuiteFailures(CRITERIA, [odd], 1).excusable, false);
});

test("a not-ok outcome with NO statuses counts as a failure", () => {
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: [] }), true);
});

test("a retried test that ends skipped is not a failure; one that ends unexpected is", () => {
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["skipped", "skipped"] }), false);
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["skipped", "unexpected"] }), true);
});
