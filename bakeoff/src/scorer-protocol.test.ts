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
  GATE_IDS,
  TITLE_PATH_SEPARATOR,
  criterionNamedInTestTitle,
  isSuiteTestFailure,
  parseContainerResult,
  triageSuiteFailures,
} from "./scorer-protocol.js";
import type { SuiteTestOutcome } from "./scorer-protocol.js";
import { gateToCriterion } from "./scorer.js";

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

/* -------------------------------------------------------------------------
 * `unknown`: the gate that did not run is not the gate that passed (#35)
 *
 * THIS IS THE WHOLE FIX, IN ONE ASSERTION. `unknown` only means anything
 * because `gateToCriterion` refuses to call it a pass; if that mapping ever
 * changes, `GATE:build` goes back to being switched off by a manifest that
 * declared a build step absent, and every test above would stay green while it
 * happened. The mapping is in scorer.ts and is READ here, never redefined.
 * ---------------------------------------------------------------------- */

test("an `unknown` gate is NOT a pass, and carries its reason into the criterion", () => {
  const unknown = gateToCriterion({
    id: GATE_IDS.build,
    name: "build succeeds",
    outcome: "unknown",
    detail: "THE BUILD GATE WAS NEVER EVALUATED, and this is not a pass.",
    durationMs: 0,
    command: null,
    exitCode: null,
  });
  assert.equal(unknown.passed, false, "an unevaluated BLOCKING gate must never score as passed");
  assert.equal(unknown.tier, "BLOCKING");
  assert.match(unknown.detail ?? "", /NEVER EVALUATED/, "a non-pass with no reason is unactionable");
});

test("`not_applicable` still passes, and still says why — the corroborated case", () => {
  const na = gateToCriterion({
    id: GATE_IDS.build,
    name: "build succeeds",
    outcome: "not_applicable",
    detail: "the frozen manifest declares no build step, and the artefact agrees",
    durationMs: 0,
    command: null,
    exitCode: null,
  });
  assert.equal(na.passed, true);
  assert.match(na.detail ?? "", /^NOT APPLICABLE: /);
});

test("a container result carrying `unknown` parses; an invented outcome is refused", () => {
  // The host and the image are built from the same tree, but they are shipped
  // separately: an image built before this change emits no `unknown`, and a host
  // built before it REFUSES one. That asymmetry is the safe direction and it is
  // asserted here so the vocabulary cannot widen by accident.
  const result = parseContainerResult(containerResultWithBuildOutcome("unknown"));
  assert.equal(result.tier0[0]?.outcome, "unknown");
  assert.throws(
    () => parseContainerResult(containerResultWithBuildOutcome("skipped")),
    /tier0\[0\]\.outcome is "skipped"/,
  );
});

/** A minimal, valid container result whose single gate carries `outcome`. */
function containerResultWithBuildOutcome(outcome: string): unknown {
  return {
    protocolVersion: 1,
    ticketId: "T",
    acceptanceSuiteSha256: "0".repeat(64),
    startedAt: "2026-07-29T00:00:00.000Z",
    endedAt: "2026-07-29T00:00:01.000Z",
    nodeVersion: "v22.12.0",
    playwrightVersion: "1.62.0",
    tier0: [
      {
        id: GATE_IDS.build,
        name: "build succeeds",
        outcome,
        detail: "d",
        durationMs: 0,
        command: null,
        exitCode: null,
      },
    ],
    exploitFindings: [],
    suiteExecution: {
      exitCode: 0,
      durationMs: 1,
      testsTotal: 1,
      testsPassed: 1,
      testsFailed: 0,
      timedOut: false,
      reportProblem: null,
    },
    criterionCoverage: [],
    screenshots: [],
    domFindings: [],
    infrastructureErrors: [],
  };
}
