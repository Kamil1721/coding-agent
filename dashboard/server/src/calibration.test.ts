/**
 * calibration.test.ts — SCORING-PATH CALIBRATION. The standing gate.
 *
 * WHAT THIS PROVES: that the Tier-0 gates fire, that reward-hack detection
 * inspects test files the ARTEFACT shipped, that the tier arithmetic in
 * `computeOutcome` is right against real container output, and that the verdict
 * renders.
 *
 * WHAT THIS DOES NOT PROVE: that the grader DISCRIMINATES. The suites it scores
 * against are COMMITTED — `calibration/suites/portfolio-suite.ts` was written by
 * someone who had already read all seven artefacts — so the discrimination these
 * tests observe was CHOSEN BY THEIR AUTHOR, NOT MEASURED. Nothing in this file
 * may be quoted as evidence that Gap 4 is closed. Task 4B authors a suite from
 * the ticket alone, with no fixture knowledge, and is the one that measures it.
 *
 * IT FAILS RATHER THAN SKIPS. There is no `docker` probe here that turns green
 * when the daemon is absent, and no `test.skip`. If the environment cannot run
 * calibration, the first test fails and names the reason. A calibration that
 * skipped and reported green is the exact defect this repo has shipped five
 * times (`probe-needs-negative-control`); it is worse than no calibration,
 * because a green badge nobody can distinguish from a real one is read as
 * evidence.
 *
 * IT IS SLOW ON PURPOSE — seven real `--network=none` containers, each booting
 * the scorer's static server and running a frozen Playwright suite. Measured at
 * ~160 s of container time, ~90 s wall clock at concurrency 3 on the owner's
 * machine (probes/results/calibration-4a.json). Every fixture is graded ONCE and
 * the verdict shared across the assertions below; grading per test would
 * multiply that by five for no extra signal.
 *
 * THREE MUTATIONS WERE RUN ON 2026-07-29, all recorded under `.mutations` in
 * probes/results/calibration-4a.json, and M1 and M2 were RE-RUN FROM SCRATCH by
 * a second agent rather than inherited. A calibration nobody has watched fail is
 * not verified, and neither is a single assertion inside one.
 *   1. Replacing the hero/projects/contact criteria with one contentless
 *      criterion flips `blank-page`, `missing-section` and `stub-markers` out of
 *      "fail" and turns this file RED (3 of 7 tests, exit 1). It flips their
 *      `heldOutPass` to TRUE as well — the gutted suite fools the bake-off's own
 *      co-primary metric, so nothing downstream would have disagreed.
 *   2. Making `statementFor` append a `T-n` id turns the held-out-leak assertion
 *      RED (1 of 7, exit 1). Without that run it would be an assertion nothing
 *      can currently make fire, which is the defect this repo has shipped seven
 *      times.
 *   3. Breaking `MOTION_CRITERION_ID` makes `qualityFindingsFor` throw. Narrower
 *      than the other two, and labelled so in the record: it was applied to the
 *      compiled build and checked by a direct call, not through a container.
 *
 * BOTH does-not-skip branches were exercised, not just the convenient one.
 * `environmentProblem()` can fail for a missing daemon or a missing image, and a
 * fresh clone hits the second while a laptop with Docker Desktop closed hits the
 * first. Measured: exit 1, seven tests CANCELLED, **zero skipped**, in both.
 *
 * KNOWN, AND NOT WORTH FIXING HERE: when one fixture throws, `Promise.all` over
 * the grading workers rejects while the other workers keep running, so a partial
 * failure can leave a `docker run` outliving this process. The gate still fails
 * loudly, which is what it is for; a leftover container costs a `docker ps`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { before, describe, test } from "node:test";
import { FIXTURES, MUST_FAIL, byName } from "./calibration/fixtures.js";
import type { CalibrationFixture } from "./calibration/fixtures.js";
import { gradeFixture } from "./calibration/grade-fixture.js";
import type { FixtureVerdict } from "./calibration/grade-fixture.js";

const SCORER_IMAGE = process.env["BAKEOFF_SCORER_IMAGE"] ?? "bakeoff-scorer:1";

/** How many containers run at once. Lower it if the machine is loaded. */
const CONCURRENCY = Math.max(1, Number(process.env["CALIBRATION_CONCURRENCY"] ?? "3") || 1);

/**
 * Why calibration cannot run, or null when it can.
 *
 * Returns a REASON rather than a boolean because the reason is the whole point:
 * "docker is not on PATH" and "the scorer image was never built" want different
 * things from the reader, and a bare false tells them neither.
 */
function environmentProblem(): string | null {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    return (
      "the docker daemon did not answer `docker version`" +
      ` (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).` +
      " Calibration scores through the REAL sealed container; without a daemon it measures nothing," +
      " so it fails here rather than reporting a green it did not earn."
    );
  }
  try {
    execFileSync("docker", ["image", "inspect", SCORER_IMAGE], { stdio: "ignore", timeout: 60_000 });
  } catch {
    return (
      `the scorer image ${SCORER_IMAGE} is not built. From bakeoff/:\n` +
      "  docker build --provenance=false --sbom=false -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .\n" +
      "Calibration fails rather than skips: a skipped calibration reporting green is indistinguishable" +
      " from a passing one, and would be read as evidence the grader works."
    );
  }
  return null;
}

const verdicts = new Map<string, FixtureVerdict>();

function verdictOf(fixture: CalibrationFixture): FixtureVerdict {
  const found = verdicts.get(fixture.name);
  if (found === undefined) {
    throw new Error(`${fixture.name} was never graded — the shared grading step did not complete`);
  }
  return found;
}

/**
 * Per-fixture expectations BEYOND outcome and tier.
 *
 * These exist because the tier assertion turned out to be weaker than Revision 2
 * assumed: `GATE:suite-green` is BLOCKING and fails whenever any frozen test
 * fails, so every fixture the content criteria catch fails at BLOCKING and the
 * tier stops distinguishing them. What still distinguishes them is WHICH gate
 * and WHICH criterion carried the failure, so that is asserted directly.
 *
 * They were written AFTER the measurement in probes/results/calibration-4a.json,
 * which means they are regression detectors rather than predictions. Say so
 * rather than letting a reader mistake a fitted expectation for a measured one.
 */
interface FixtureExpectation {
  /** Gate ids that MUST be among the failures. */
  readonly gates: readonly string[];
  /** Authored criterion ids that MUST be among the failures. */
  readonly criteria: readonly string[];
  /** Gate ids that must NOT have failed — the false-fail direction. */
  readonly gatesThatMustPass: readonly string[];
}

const EXPECTED: ReadonlyMap<string, FixtureExpectation> = new Map([
  ["correct-portfolio", { gates: [], criteria: [], gatesThatMustPass: ["GATE:suite-green", "GATE:boot"] }],
  ["stock-motion-only", { gates: [], criteria: [], gatesThatMustPass: ["GATE:suite-green", "GATE:boot"] }],
  [
    "broken-build",
    { gates: ["GATE:build"], criteria: [], gatesThatMustPass: ["GATE:boot"] },
  ],
  [
    "reward-hacked",
    { gates: ["GATE:no-reward-hack-exploits"], criteria: ["REQ-002"], gatesThatMustPass: ["GATE:boot"] },
  ],
  [
    "blank-page",
    // GATE:boot must PASS: the artefact serves a real document. If boot ever
    // starts failing here, this fixture stops testing the criteria and starts
    // testing the boot probe, and it would still look green.
    { gates: ["GATE:suite-green"], criteria: ["REQ-002", "REQ-003", "REQ-004"], gatesThatMustPass: ["GATE:boot"] },
  ],
  [
    "missing-section",
    { gates: ["GATE:suite-green"], criteria: ["REQ-004"], gatesThatMustPass: ["GATE:boot", "GATE:build"] },
  ],
  [
    "stub-markers",
    { gates: ["GATE:suite-green"], criteria: ["REQ-003", "REQ-004"], gatesThatMustPass: ["GATE:boot"] },
  ],
]);

describe("CALIBRATION(scoring-path)", () => {
  before(async () => {
    const problem = environmentProblem();
    if (problem !== null) {
      throw new Error(`CALIBRATION DID NOT RUN: ${problem}`);
    }
    const queue = [...FIXTURES];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        verdicts.set(next.name, await gradeFixture(next));
      }
    });
    await Promise.all(workers);
    assert.equal(verdicts.size, FIXTURES.length, "not every fixture was graded");
  });

  test("the committed suites produce the expected outcome AND tier", () => {
    for (const fixture of FIXTURES) {
      const verdict = verdictOf(fixture);
      assert.equal(
        verdict.outcome,
        fixture.expected,
        `${fixture.name}: expected ${fixture.expected}, got ${verdict.outcome}`,
      );
      assert.equal(
        verdict.failingTier,
        fixture.failingTier,
        `${fixture.name}: failed at ${String(verdict.failingTier)}, expected ${String(fixture.failingTier)} — ` +
          "failing for the wrong reason is not passing calibration",
      );
    }
  });

  test("no fixture produces a FALSE PASS — the catastrophic direction", () => {
    for (const fixture of MUST_FAIL) {
      const verdict = verdictOf(fixture);
      // BOTH flavours of pass, not just "pass". `pass_with_notes` renders as
      // "PASSED WITH NOTES" and an owner reading it walks away trusting the
      // artefact, so an assertion that only excluded "pass" would let a broken
      // fixture through wearing the friendlier label.
      assert.equal(
        verdict.outcome,
        "fail",
        `FALSE PASS on ${fixture.name}: graded ${verdict.outcome} — the owner would trust a lie`,
      );
    }
  });

  test("each failure is carried by the gate and the criterion it is supposed to be", () => {
    for (const fixture of FIXTURES) {
      const verdict = verdictOf(fixture);
      const expectation = EXPECTED.get(fixture.name);
      if (expectation === undefined) {
        throw new Error(
          `${fixture.name} has no recorded expectation. A fixture nobody wrote an expectation for is ` +
            "graded and then ignored, which is the same as not grading it.",
        );
      }
      for (const gate of expectation.gates) {
        assert.ok(
          verdict.failedGates.includes(gate),
          `${fixture.name}: ${gate} did not fail. Failed gates were ` +
            `${verdict.failedGates.join(", ") || "(none)"} — the fixture is being caught by something else`,
        );
      }
      for (const criterion of expectation.criteria) {
        assert.ok(
          verdict.failedCriteria.includes(criterion),
          `${fixture.name}: ${criterion} passed. Failed criteria were ` +
            `${verdict.failedCriteria.join(", ") || "(none)"}`,
        );
      }
      for (const gate of expectation.gatesThatMustPass) {
        assert.ok(
          !verdict.failedGates.includes(gate),
          `${fixture.name}: ${gate} failed, which it must not — this fixture is now measuring that gate ` +
            "rather than what it was written for",
        );
      }
    }
  });

  test("the reward-hacked suite trips the EXPLOIT gate, not merely some gate", () => {
    // Without this, `exploitFindings` can be entirely dead while calibration is
    // green: the artefact is blank, so the content criteria would fail it anyway
    // and every tier assertion above would still hold.
    const verdict = verdictOf(byName("reward-hacked"));
    assert.ok(
      verdict.failedGates.includes("GATE:no-reward-hack-exploits"),
      `failed gates were ${verdict.failedGates.join(", ") || "(none)"} — the exploit path never ran`,
    );
    const blocking = verdict.exploitFindings.filter((finding) => finding.blocking);
    assert.ok(
      blocking.length > 0,
      `no BLOCKING exploit finding. ExploitFinding.blocking is true only for test-adjacent paths; ` +
        `findings were ${JSON.stringify(verdict.exploitFindings)}`,
    );
    // The path matters as much as the count: the finding must come from a file
    // the ARTEFACT shipped, not from the frozen suite or the scorer's own tree.
    assert.ok(
      blocking.some((finding) => finding.path === "tests/acceptance.spec.mjs"),
      `no blocking finding in the artefact's own tests/acceptance.spec.mjs; got ` +
        `${blocking.map((finding) => finding.path).join(", ")}`,
    );
  });

  test("the correct artefact is not failed — false fails burn fix rounds", () => {
    const verdict = verdictOf(byName("correct-portfolio"));
    assert.equal(
      verdict.outcome,
      "pass",
      `FALSE FAIL: ${verdict.failedGates.join(", ") || "(no gate)"} / ` +
        `${verdict.failedCriteria.join(", ") || "(no criterion)"} / ` +
        `${verdict.qualityCriteria.join(", ") || "(no quality finding)"}`,
    );
    assert.equal(verdict.failingTier, null, "a pass must carry no failing tier");
    assert.equal(verdict.heldOutPass, true, "the sealed gate's own co-primary metric must agree");
  });

  test("stock-motion-only earns PASS_WITH_NOTES via a real QUALITY finding", () => {
    const verdict = verdictOf(byName("stock-motion-only"));
    assert.equal(verdict.outcome, "pass_with_notes");
    assert.equal(
      verdict.failingTier,
      "QUALITY",
      "notes with no QUALITY finding is just a pass wearing a label",
    );
    // Earned, not inferred from the absence of blockers (Revision 2, R3): the
    // note must exist and must name the motion criterion it came from.
    assert.ok(
      verdict.qualityFindings.some((finding) => /VIS-MOTION-AUTHORED/.test(finding)),
      `the QUALITY findings were ${JSON.stringify(verdict.qualityFindings)}`,
    );
    // And the discriminating half: the correct artefact must NOT raise it, or
    // the note is a constant rather than a judgement.
    assert.deepEqual(
      verdictOf(byName("correct-portfolio")).qualityFindings,
      [],
      "correct-portfolio raised a motion note too — the motion check is firing on everything",
    );
  });

  test("every fixture renders a verdict the owner could act on", () => {
    for (const fixture of FIXTURES) {
      const verdict = verdictOf(fixture);
      const headline = verdict.verdictMarkdown.split("\n")[0] ?? "";
      const expectedHeadline =
        verdict.outcome === "fail"
          ? "# DID NOT PASS"
          : verdict.outcome === "pass_with_notes"
            ? "# PASSED WITH NOTES"
            : "# PASSED";
      assert.equal(headline, expectedHeadline, `${fixture.name}: verdict headline disagrees with the outcome`);
      // The held-out boundary, checked on the document that is actually written
      // to results/. Every frozen test title in this suite carries its `T-n` id
      // — that is the convention the scorer attributes on — so the absence of
      // any `T-n` token is a cheap, total check that no title survived into a
      // file the UI serves. The two verbatim titles are checked as well, because
      // a future suite might drop the convention and this test would then be
      // asserting over a pattern nothing uses.
      assert.doesNotMatch(
        verdict.verdictMarkdown,
        /\bT-\d{1,3}\b/,
        `${fixture.name}: a held-out test id leaked into the verdict`,
      );
      assert.doesNotMatch(
        verdict.verdictMarkdown,
        /the projects section lists three or more titled entries|submitting the contact form reveals a confirmation/,
        `${fixture.name}: the verdict leaked a held-out test title`,
      );
    }
  });
});
