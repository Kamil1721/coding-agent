/**
 * gate-fix-loop.test.ts — the bounded convergence loop.
 *
 * THE LOOP IS TESTED THROUGH ITS REAL SEAMS. `gate` and `runFix` are injected,
 * but everything between them — `toAgentVisible`, `planFixes`, `buildFixPrompt`
 * — is the production code, not a double of it. That matters most for the leak
 * test at the bottom: a test that built its own prompt would be checking a
 * string this program never sends.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import { shortlistFor } from "./agent-shortlist.js";
import { containerFixture, coverageFixture, tier0Fixture } from "./container-fixture.js";
import { DEFAULT_MAX_ATTEMPTS, maxAttemptsFrom, runGateFixLoop } from "./gate-fix-loop.js";
import type { FixTask } from "./fix-triage.js";

const HELD_OUT_TITLE = "renders the hero heading";

/** A gate that returns a prepared result per attempt, and records the attempts. */
function stubGate(sequence: readonly (ContainerResult | null)[]): {
  gate: (attempt: number) => Promise<ContainerResult | null>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    gate: (attempt: number) => {
      calls.push(attempt);
      const index = Math.min(attempt - 1, sequence.length - 1);
      return Promise.resolve(sequence[index] ?? null);
    },
  };
}

function failing(klass: "build" | "logic", detail = "TS2345 at src/app.ts:12"): ContainerResult {
  const id = klass === "build" ? GATE_IDS.build : GATE_IDS.noStubMarkers;
  return containerFixture({
    tier0: [tier0Fixture({ id, name: id, outcome: "fail", detail, command: "npm run build", exitCode: 2 })],
  });
}

function green(): ContainerResult {
  return containerFixture({
    tier0: [tier0Fixture({ id: GATE_IDS.build, outcome: "pass", detail: "built in 4s" })],
    criterionCoverage: [coverageFixture({ criterionId: "C-1", outcome: "passed" })],
  });
}

function infra(message: string): ContainerResult {
  return containerFixture({ infrastructureErrors: [message] });
}

/** A failing gate whose every held-out carrier is poisoned with a test title. */
function failingWithTestRefs(title: string): ContainerResult {
  return containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.build,
        name: "npm run build",
        outcome: "fail",
        detail: "TS2345: Argument of type 'string' is not assignable",
        command: "npm run build",
        exitCode: 2,
      }),
      tier0Fixture({
        id: GATE_IDS.suiteGreen,
        name: "the frozen held-out suite goes green",
        outcome: "fail",
        detail: `output tail: [playwright] 1) held/hero.spec.mjs:12 › ${title} — expected h1 to contain 'Kamil'`,
        command: "npx playwright test held/hero.spec.mjs",
        exitCode: 1,
      }),
    ],
    criterionCoverage: [
      coverageFixture({
        criterionId: "C-1",
        tier: "FUNCTIONAL",
        outcome: "failed",
        testRefs: [title],
        detail: `expected h1 to contain 'Kamil' (${title})`,
      }),
    ],
    suiteExecution: {
      exitCode: 1,
      durationMs: 900,
      testsTotal: 6,
      testsPassed: 5,
      testsFailed: 1,
      timedOut: false,
      reportProblem: `1 failing: ${title}`,
    },
  });
}

interface LoopOptions {
  readonly gate: (attempt: number) => Promise<ContainerResult | null>;
  readonly maxAttempts: number;
  readonly onAgentPrompt?: (prompt: string) => void;
  readonly signal?: AbortSignal;
}

async function runLoop(options: LoopOptions): ReturnType<typeof runGateFixLoop> {
  const record = options.onAgentPrompt;
  return runGateFixLoop({
    gate: options.gate,
    runFix: (_task: FixTask, prompt: string) => {
      record?.(prompt);
      return Promise.resolve();
    },
    maxAttempts: options.maxAttempts,
    workspace: "/tmp/ws",
    allowedAgents: shortlistFor("fullstack"),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

test("a run that goes green on the second attempt stops there", async () => {
  const { gate, calls } = stubGate([failing("build"), green()]);
  const r = await runLoop({ gate, maxAttempts: 4 });
  assert.equal(r.passed, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.reason, "green");
  assert.deepEqual(calls, [1, 2], "the gate ran once per attempt, with the attempt number");
});

test("the loop is BOUNDED — it stops at the cap and says so", async () => {
  // An unattended system that retries forever is worse than one that stops.
  //
  // THE DETAIL VARIES PER ATTEMPT ON PURPOSE. Five identical failures would trip
  // the non-convergence check first and this test would pass while measuring the
  // wrong mechanism entirely.
  const { gate } = stubGate([
    failing("logic", "stub marker at src/a.ts"),
    failing("logic", "stub marker at src/b.ts"),
    failing("logic", "stub marker at src/c.ts"),
    failing("logic", "stub marker at src/d.ts"),
    failing("logic", "stub marker at src/e.ts"),
  ]);
  const r = await runLoop({ gate, maxAttempts: 3 });
  assert.equal(r.passed, false);
  assert.equal(r.attempts, 3);
  assert.equal(r.reason, "retry-cap");
});

test("identical failures twice in a row means NOT CONVERGING — stop early", async () => {
  // Same failure, same detail, after a fix attempt = the fix changed nothing.
  // Burning the remaining budget proves nothing.
  const same = failing("logic", "TS2345 at src/app.ts:12");
  const { gate } = stubGate([same, same, same]);
  const r = await runLoop({ gate, maxAttempts: 6 });
  assert.equal(r.reason, "not-converging");
  assert.equal(r.passed, false);
  assert.ok(r.attempts <= 3, `stopped after ${String(r.attempts)}, should not have used all 6`);
});

test("a fix that changes SOMETHING is not non-convergence", async () => {
  // The negative control for the check above: if the fingerprint were constant,
  // or compared something that never changes, every run would stop at attempt 2.
  const { gate } = stubGate([
    failing("logic", "three stub markers"),
    failing("logic", "one stub marker"),
    green(),
  ]);
  const r = await runLoop({ gate, maxAttempts: 6 });
  assert.equal(r.reason, "green");
  assert.equal(r.attempts, 3);
});

test("an infra failure aborts instead of entering the loop", async () => {
  const prompts: string[] = [];
  const { gate } = stubGate([infra("chromium failed to launch"), green()]);
  const r = await runLoop({ gate, maxAttempts: 4, onAgentPrompt: (p) => prompts.push(p) });
  assert.equal(r.reason, "infra");
  assert.equal(r.attempts, 1, "no fix work is attempted");
  assert.equal(r.passed, false);
  assert.equal(prompts.length, 0, "quota is not spent fixing a problem the artefact does not have");
  assert.match(String(r.report.infraFailure), /chromium/);
});

test("a gate that produced no result at all is infra, not green", async () => {
  const { gate } = stubGate([null]);
  const r = await runLoop({ gate, maxAttempts: 4 });
  assert.equal(r.reason, "infra");
  assert.equal(r.passed, false);
});

test("no fixing agent ever receives a raw ContainerResult", async () => {
  // The Task 2 boundary, enforced at the seam it actually crosses: the string
  // this loop hands to `runFix` is the string the builder is given.
  const seen: string[] = [];
  const { gate } = stubGate([failingWithTestRefs(HELD_OUT_TITLE), green()]);
  const r = await runLoop({ gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });

  // POSITIVE CONTROL FIRST. `for (const p of seen) doesNotMatch(...)` over an
  // empty array passes, and so does a loop that never built a prompt at all.
  assert.ok(seen.length > 0, "a prompt must actually have been built and delivered");
  assert.equal(r.reason, "green");
  for (const p of seen) {
    assert.match(p, /TS2345/, "the fixer got the real compiler error");
  }

  for (const p of seen) {
    assert.doesNotMatch(p, /renders the hero heading/);
    assert.doesNotMatch(p, /expected h1 to contain/);
    assert.doesNotMatch(p, /hero\.spec\.mjs/);
  }
});

test("the held-out signal that DOES cross is a count, and it crosses", async () => {
  const seen: string[] = [];
  const unmet = containerFixture({
    criterionCoverage: [
      coverageFixture({ criterionId: "C-1", tier: "FUNCTIONAL", outcome: "failed", testRefs: [HELD_OUT_TITLE] }),
      coverageFixture({ criterionId: "C-2", tier: "FUNCTIONAL", outcome: "unasserted", testRefs: [] }),
    ],
  });
  const { gate } = stubGate([unmet, green()]);
  await runLoop({ gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  assert.ok(seen.length > 0);
  assert.match(seen[0] ?? "", /2 FUNCTIONAL/);
  assert.doesNotMatch(seen[0] ?? "", /renders the hero heading/);
});

test("an aborted run stops as cancelled, not as a verdict", async () => {
  const controller = new AbortController();
  const { gate } = stubGate([failing("build"), green()]);
  const r = await runLoop({
    gate: (attempt: number) => {
      controller.abort();
      return gate(attempt);
    },
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.equal(r.reason, "cancelled");
  assert.equal(r.passed, false, "cancelled is never a pass");
});

test("a QUALITY-only shortfall is GREEN — the loop stops where the verdict stops", async () => {
  // `computeHeldOutPass` (bakeoff/src/contracts.ts:1438) filters to BLOCKING and
  // FUNCTIONAL. QUALITY is "REPORTED, NEVER GATING" — the scorer went out of its
  // way to fix exactly this after the 4B run, because a BLOCKING gate carrying
  // QUALITY failures made `pass_with_notes` unreachable.
  //
  // If this loop's green condition counted QUALITY, it would spend a fix round
  // and two extra container runs, out of the owner's shared rate-limit window,
  // on work that cannot change the verdict — and then finish `passed` anyway.
  const qualityOnly = containerFixture({
    tier0: [tier0Fixture({ id: GATE_IDS.build, outcome: "pass", detail: "built in 4s" })],
    criterionCoverage: [
      coverageFixture({ criterionId: "C-1", tier: "BLOCKING", outcome: "passed" }),
      coverageFixture({ criterionId: "C-2", tier: "QUALITY", outcome: "failed" }),
      coverageFixture({ criterionId: "C-3", tier: "QUALITY", outcome: "unasserted" }),
    ],
  });
  const seen: string[] = [];
  const { gate, calls } = stubGate([qualityOnly]);
  const r = await runLoop({ gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  assert.equal(r.reason, "green");
  assert.equal(calls.length, 1, "no second container run for something that cannot fail the run");
  assert.equal(seen.length, 0, "and no fix round");

  // POSITIVE CONTROL, and the negative control for the line above: the identical
  // shape at FUNCTIONAL is not green and does spend a round.
  const functional = containerFixture({
    tier0: [tier0Fixture({ id: GATE_IDS.build, outcome: "pass", detail: "built in 4s" })],
    criterionCoverage: [coverageFixture({ criterionId: "C-2", tier: "FUNCTIONAL", outcome: "failed" })],
  });
  const second = stubGate([functional, green()]);
  const r2 = await runLoop({ gate: second.gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  assert.equal(r2.reason, "green");
  assert.equal(second.calls.length, 2, "it did fix and re-gate");
  assert.equal(seen.length, 1);
});

test("a QUALITY shortfall still reaches the fixer when something else is broken", async () => {
  // Reported, never gating: it does not hold the loop open, and it is not hidden
  // from a round that is happening anyway.
  const seen: string[] = [];
  const mixed = containerFixture({
    tier0: [tier0Fixture({ id: GATE_IDS.build, outcome: "fail", detail: "TS2345", command: "npm run build" })],
    criterionCoverage: [coverageFixture({ criterionId: "C-2", tier: "QUALITY", outcome: "failed" })],
  });
  const { gate } = stubGate([mixed, green()]);
  await runLoop({ gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  assert.match(seen[0] ?? "", /1 QUALITY/);
});

test("a gate interrupted by a cancel is cancelled, not an infrastructure fault", async () => {
  // An aborted gate produces no result, which looks exactly like a scorer that
  // broke. Reporting it as infra blames the machine for something the owner did.
  const controller = new AbortController();
  const r = await runLoop({
    gate: () => {
      controller.abort();
      return Promise.resolve(null);
    },
    maxAttempts: 3,
    signal: controller.signal,
  });
  assert.equal(r.reason, "cancelled");
});

test("the attempt cap comes from the environment, and refuses nonsense", () => {
  assert.equal(maxAttemptsFrom({}), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "5" }), 5);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "1" }), 1);
  // Not clamped: a clamp would run "100" as 10 and read in the log as if the
  // owner's number had been honoured.
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "100" }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "0" }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "-1" }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "2.5" }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "many" }), DEFAULT_MAX_ATTEMPTS);
});

test("work routed to an agent this run may not use stops the loop instead of spinning", async () => {
  // A visual failure on a `cli` ticket routes to taste-frontend-expert, which is
  // not on that surface's shortlist. Re-gating without having run anything would
  // produce the identical report and burn the whole budget one round at a time.
  const visual = containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.screenshotsPresent,
        name: "a masked, non-blank screenshot exists for every declared flow",
        outcome: "fail",
        detail: "flow home produced a blank PNG",
      }),
    ],
  });
  const { gate, calls } = stubGate([visual, visual, visual]);
  const r = await runGateFixLoop({
    gate,
    runFix: () => Promise.resolve(),
    maxAttempts: 5,
    workspace: "/tmp/ws",
    allowedAgents: shortlistFor("cli"),
  });
  assert.equal(r.reason, "not-converging");
  assert.equal(calls.length, 1, "it did not re-gate to discover the same denial again");
  assert.equal(r.deniedTasks.length, 1);
  assert.equal(r.deniedTasks[0]?.agent, "taste-frontend-expert");
});
