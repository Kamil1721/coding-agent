/**
 * gate-report.test.ts — the held-out boundary, at the seam where the gate's
 * report becomes something an agent is allowed to read.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL IN THIS FILE. Every leak assertion here
 * is a `doesNotMatch`, and `toAgentVisible = () => ({})` satisfies every one of
 * them. So each leak test also asserts what MUST survive — the per-tier unmet
 * count, the compiler error, the failing gate id — and would go red on a
 * redactor that redacted everything.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import {
  ALL_FAILURE_CLASSES,
  WITHHELD_DETAIL,
  classify,
  isGreen,
  toAgentVisible,
} from "./gate-report.js";
import {
  containerFixture,
  coverageFixture,
  domFindingFixture,
  exploitFindingFixture,
  tier0Fixture,
} from "./container-fixture.js";

/** A title only the held-out suite knows. If this string moves, the boundary broke. */
const HELD_OUT_TITLE = "renders the hero heading";
const HELD_OUT_TITLE_2 = "nav links resolve";
const HELD_OUT_ASSERTION = "expected h1 to contain 'Kamil'";

test("HELD-OUT LEAK: no test title survives into the agent-visible report", () => {
  // criterionCoverage[].testRefs is documented as "Test titles that asserted it".
  // Phase 0 sealed results/scorer-out for exactly this. If a title reaches a
  // fixing agent, it can target the held-out tests and heldOutPass means nothing.
  //
  // THE SENTINEL IS PLANTED IN EVERY CARRIER THE CONTAINER HAS, not just in
  // testRefs: a fixture that only poisons one field cannot notice a redactor
  // that copies a different one through.
  const c = containerFixture({
    criterionCoverage: [
      coverageFixture({
        criterionId: "C-1",
        tier: "FUNCTIONAL",
        outcome: "failed",
        testRefs: [HELD_OUT_TITLE, HELD_OUT_TITLE_2],
        detail: HELD_OUT_ASSERTION,
      }),
    ],
    suiteExecution: {
      exitCode: 1,
      durationMs: 900,
      testsTotal: 6,
      testsPassed: 5,
      testsFailed: 1,
      timedOut: false,
      reportProblem: `1 failing: ${HELD_OUT_TITLE}`,
    },
  });

  const report = toAgentVisible(c);
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /renders the hero heading/);
  assert.doesNotMatch(json, /nav links resolve/);
  assert.doesNotMatch(json, /expected h1 to contain/);

  // POSITIVE CONTROL. Without this, an implementation returning nothing at all
  // passes every assertion above.
  assert.equal(report.heldOutUnmet.FUNCTIONAL, 1, "the COUNT survives — that is the signal");
  assert.equal(report.heldOutUnmet.BLOCKING, 0);
  assert.equal(report.heldOutUnmet.QUALITY, 0);
});

test("HELD-OUT LEAK: the suite-green gate's own detail is held out too", () => {
  // NOT IN THE PLAN, AND THE PLAN IS WRONG ABOUT IT. "tier0 failures survive in
  // full — they are objective, not test-derived" is true of build/boot/routes
  // and FALSE of GATE:suite-green, whose detail is assembled in
  // bakeoff/src/scorer-container.ts from the held-out runner's own output tail
  // (4,000 characters of it), the titlePath of each excused failure, and the
  // paths of uncollected frozen files. That is the held-out suite, quoted.
  const c = containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.suiteGreen,
        name: "the frozen held-out suite goes green",
        outcome: "fail",
        detail:
          "playwright: 3 file(s), exit 1, 5/6 passed; 1 failed of 6; output tail: " +
          `[playwright] 1) held/hero.spec.mjs:12 › ${HELD_OUT_TITLE} — ${HELD_OUT_ASSERTION}`,
        command: "npx playwright test",
        exitCode: 1,
      }),
    ],
  });

  const report = toAgentVisible(c);
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /renders the hero heading/);
  assert.doesNotMatch(json, /expected h1 to contain/);
  assert.doesNotMatch(json, /hero\.spec\.mjs/, "not even the held-out FILE name");

  // POSITIVE CONTROL, and the reason this is a redaction and not a drop: the
  // fixer still has to know the held-out suite is not green, or it stops early
  // believing there is nothing left to do.
  const suite = report.failures.find((f) => f.id === GATE_IDS.suiteGreen);
  assert.ok(suite !== undefined, "the failure is reported — it is the detail that is withheld");
  assert.match(suite.detail, /withheld/i, "and it says so, rather than looking like an empty detail");
  assert.equal(suite.command, null, "the command names the held-out runner's invocation; it does not cross either");
});

test("tier0 failures survive in full — they are objective, not test-derived", () => {
  const c = containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.build,
        name: "npm run build",
        outcome: "fail",
        detail: "TS2345: Argument of type 'string' is not assignable",
        command: "npm run build",
        exitCode: 2,
        durationMs: 900,
      }),
    ],
  });
  const r = toAgentVisible(c);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0]!.detail, /TS2345/, "the fixer needs the real compiler error");
  assert.equal(r.failures[0]!.command, "npm run build");
  assert.equal(r.failures[0]!.exitCode, 2);
  assert.equal(r.failures[0]!.klass, "build");
});

/** The `unknown` build detail, in the shape `absentBuildVerdict` really emits it. */
const NEVER_EVALUATED_BUILD =
  "THE BUILD GATE WAS NEVER EVALUATED, and this is not a pass. The frozen manifest declares no build " +
  'step, but the artefact contradicts that declaration: package.json declares scripts.build = "npm install && vite build"; ' +
  "vite.config.ts is a bundler/framework configuration. Nothing was compiled, so nothing here says the artefact builds.";

test("an UNKNOWN tier-0 gate is fix work — 'never evaluated' is not a pass, and not a silence either", () => {
  // `GATE:build` gained an `unknown` outcome in bakeoff/src/tier0.ts +
  // scorer-container.ts (defect #35): the frozen manifest declared no build step
  // and the ARTEFACT contradicts it, so the gate ran nothing and established
  // nothing. `gateToCriterion` maps it to `passed: false`, so the RUN fails —
  // but a loop that only forwards `fail` never tells the fixing agent WHY, and
  // an agent that is not told cannot act. The gate that was never evaluated then
  // looks, from inside the loop, exactly like a gate that passed.
  const c = containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.build,
        name: "build succeeds",
        outcome: "unknown",
        detail: NEVER_EVALUATED_BUILD,
        // An absent command is emitted as gate(id, name, outcome, detail, 0, null, null).
        durationMs: 0,
        command: null,
        exitCode: null,
      }),
      tier0Fixture({ id: GATE_IDS.boot, outcome: "pass", detail: "200 in 40ms" }),
    ],
  });

  const r = toAgentVisible(c);
  assert.equal(r.failures.length, 1, "the unknown gate is fix work; the passing one is not");
  const build = r.failures[0]!;
  assert.equal(build.id, GATE_IDS.build);
  assert.match(build.detail, /NEVER EVALUATED/, "and it says what happened, in the gate's own words");
  assert.match(build.detail, /scripts\.build/, "GATE:build is on DETAIL_ALLOWLIST, so its artefact-derived detail crosses");

  // NOT `install`. The install markers exist to read a FAILED command's output;
  // this gate ran no command, and the only reason "npm install" appears at all
  // is that the artefact's own build script is quoted back. Routing a
  // never-evaluated gate to the dependency specialist spends a round on a
  // dependency tree nobody has touched.
  assert.equal(build.klass, "build", "an unrun gate is not evidence of a dependency failure");

  assert.ok(isGreen(toAgentVisible(containerFixture({}))), "control: an empty report is still green");
  assert.equal(isGreen(r), false, "so the loop does not stop believing there is nothing left to do");
});

test("an UNKNOWN gate that is NOT on the detail allowlist crosses with its detail withheld", () => {
  // Admitting `unknown` must not widen the boundary by one gate. The allowlist
  // is keyed on the gate ID and nothing else, so an unknown-outcome
  // GATE:suite-green — whose detail quotes the held-out runner verbatim — has to
  // fail closed exactly as a failing one does.
  const c = containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.suiteGreen,
        name: "the frozen held-out suite goes green",
        outcome: "unknown",
        detail: `never ran; last known output: held/hero.spec.mjs › ${HELD_OUT_TITLE} — ${HELD_OUT_ASSERTION}`,
        command: "npx playwright test",
      }),
    ],
  });

  const r = toAgentVisible(c);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /renders the hero heading/);
  assert.doesNotMatch(json, /expected h1 to contain/);
  assert.doesNotMatch(json, /hero\.spec\.mjs/);

  const suite = r.failures.find((f) => f.id === GATE_IDS.suiteGreen);
  assert.ok(suite !== undefined, "reported, so the loop knows it is not green");
  assert.equal(suite.detail, WITHHELD_DETAIL, "and withheld, so the boundary is where it was");
  assert.equal(suite.command, null);
});

test("a gate that passed is not fix work", () => {
  const c = containerFixture({
    tier0: [
      tier0Fixture({ id: GATE_IDS.build, outcome: "pass", detail: "built in 4s" }),
      tier0Fixture({ id: GATE_IDS.lint, outcome: "not_applicable", detail: "no lint command declared" }),
    ],
  });
  assert.equal(toAgentVisible(c).failures.length, 0, "pass and not_applicable are not failures");
});

test("failures are classified so triage can route them", () => {
  assert.equal(classify({ id: "build" }), "build");
  assert.equal(classify({ id: "boot" }), "boot");
  assert.equal(classify({ id: "routes" }), "route");
  assert.equal(classify({ id: "screenshots" }), "visual");
  assert.equal(classify({ id: "something-new" }), "logic", "unknown class falls back to logic, never dropped");

  // The real ids carry a "GATE:" prefix. Both forms classify the same, because
  // a table keyed only on the bare word would route every REAL gate to "logic".
  assert.equal(classify({ id: GATE_IDS.build }), "build");
  assert.equal(classify({ id: GATE_IDS.typecheck }), "build");
  assert.equal(classify({ id: GATE_IDS.lint }), "structure");
  assert.equal(classify({ id: GATE_IDS.boot }), "boot");
  assert.equal(classify({ id: GATE_IDS.routes }), "route");
  assert.equal(classify({ id: GATE_IDS.screenshotsPresent }), "visual");
  assert.equal(classify({ id: GATE_IDS.noStubMarkers }), "logic");
  assert.equal(classify({ id: GATE_IDS.noRewardHackExploits }), "test-infra");
  assert.equal(classify({ id: GATE_IDS.dataPresent }), "logic");
  assert.equal(classify({ id: GATE_IDS.suiteGreen }), "logic");
});

test("an install failure is routed as one, even though the container folds it into build", () => {
  // bakeoff/src/scorer-container.ts: "Install (when declared) and build, as one
  // gate: a failed install is a failed build." So there is no GATE:install to
  // key on, and without this the `install` class has no producer at all — a
  // dead branch and a dependency-manager route that can never fire.
  assert.equal(
    classify({ id: GATE_IDS.build, detail: "npm error ERESOLVE unable to resolve dependency tree" }),
    "install",
  );
  assert.equal(
    classify({ id: GATE_IDS.build, detail: "TS2345: Argument of type 'string' is not assignable" }),
    "build",
    "a compiler error is still a build failure",
  );
});

test("exploit and DOM findings become fix work, with their class", () => {
  const c = containerFixture({
    exploitFindings: [
      exploitFindingFixture({
        kind: "hard_exit_in_test_path",
        path: "tests/setup.mjs",
        blocking: true,
        detail: "process.exit(0) before assertions execute",
      }),
      // Non-blocking: reported so a reviewer can see it, gates nothing. A
      // bounded loop fixes what stands between the run and green.
      exploitFindingFixture({ kind: "equality_override", path: "src/util.ts", blocking: false }),
    ],
    domFindings: [
      domFindingFixture({ kind: "horizontal_overflow", detail: "body scrollWidth 1400 > 1280 at 1280x800" }),
    ],
  });
  const r = toAgentVisible(c);
  assert.equal(r.failures.length, 2, "the non-blocking finding is not fix work");
  assert.ok(r.failures.some((f) => f.klass === "test-infra" && /process\.exit/.test(f.detail)));
  assert.ok(r.failures.some((f) => f.klass === "visual" && /scrollWidth/.test(f.detail)));
});

test("unasserted counts as unmet — absence of evidence is not evidence of satisfaction", () => {
  const c = containerFixture({
    criterionCoverage: [
      coverageFixture({ criterionId: "C-1", tier: "BLOCKING", outcome: "unasserted", testRefs: [] }),
      coverageFixture({ criterionId: "C-2", tier: "FUNCTIONAL", outcome: "failed", testRefs: [HELD_OUT_TITLE] }),
      coverageFixture({ criterionId: "C-3", tier: "QUALITY", outcome: "passed", testRefs: [HELD_OUT_TITLE_2] }),
    ],
  });
  const r = toAgentVisible(c);
  assert.deepEqual({ ...r.heldOutUnmet }, { BLOCKING: 1, FUNCTIONAL: 1, QUALITY: 0 });
  assert.doesNotMatch(JSON.stringify(r), /renders the hero heading|nav links resolve/);
});

test("an infra failure is surfaced, not turned into fix work", () => {
  // infrastructureErrors means the SCORER failed — a browser that would not
  // launch. Entering the loop here burns quota fixing a problem the artefact
  // does not have.
  const r = toAgentVisible(
    containerFixture({
      infrastructureErrors: ["chromium failed to launch"],
      tier0: [tier0Fixture({ id: GATE_IDS.build, outcome: "fail", detail: "TS2345" })],
    }),
  );
  assert.match(String(r.infraFailure), /chromium/);
  assert.equal(r.failures.length, 0, "no fix work is proposed for an infra failure");
});

test("a null container is an infra failure, not a green report", () => {
  // "The gate could not run" and "the gate passed" must never look alike. A
  // report with no failures IS the loop's green condition.
  const r = toAgentVisible(null);
  assert.equal(r.failures.length, 0);
  assert.ok(r.infraFailure !== null, "so the loop stops on infra rather than declaring victory");
});

test("every failure class is reachable and none is silently dropped", () => {
  assert.equal(new Set(ALL_FAILURE_CLASSES).size, ALL_FAILURE_CLASSES.length);
  assert.ok(ALL_FAILURE_CLASSES.includes("install"));
  assert.ok(ALL_FAILURE_CLASSES.includes("visual"));
});
