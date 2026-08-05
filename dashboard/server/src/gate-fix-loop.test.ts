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
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIME_BUDGET_MS,
  NO_PROGRESS_WINDOW,
  fingerprint,
  maxAttemptsFrom,
  runGateFixLoop,
  timeBudgetFrom,
} from "./gate-fix-loop.js";
import type { AgentVisibleReport, FailureClass, FixableFailure } from "./gate-report.js";
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
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
  readonly abortCause?: () => "owner-cancelled" | "rate-limited";
  /** Defaults to the fullstack shortlist WITHOUT the design lane, as before. */
  readonly allowedAgents?: readonly string[];
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
    allowedAgents: options.allowedAgents ?? shortlistFor("fullstack"),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.abortCause === undefined ? {} : { abortCause: options.abortCause }),
  });
}

/**
 * A clock the test drives, in minutes, advancing only when a test says so.
 *
 * THE BUDGET IS FOUR HOURS AND THE TEST SUITE RUNS IN 100 MILLISECONDS. A test
 * that proved this bound by waiting would never be run, and a bound whose test
 * is never run is not a bound — which is precisely the class of defect this
 * lane's checks exist to catch, so it is not one to introduce while catching it.
 */
function fakeClock(): { now: () => number; advanceMinutes: (m: number) => void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advanceMinutes: (m: number) => {
      t += m * 60_000;
    },
  };
}

test("a run that goes green on the second attempt stops there", async () => {
  const { gate, calls } = stubGate([failing("build"), green()]);
  const r = await runLoop({ gate, maxAttempts: 4 });
  assert.equal(r.passed, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.reason, "green");
  assert.deepEqual(calls, [1, 2], "the gate ran once per attempt, with the attempt number");
});

/**
 * A gate report carrying `count` unmet FUNCTIONAL criteria and one tier-0
 * failure. The count is the ordinal the no-progress detector reads, so a
 * DECREASING sequence of these is a fixer that is demonstrably working.
 */
function closing(count: number, tag: string): ContainerResult {
  return containerFixture({
    tier0: [
      tier0Fixture({ id: GATE_IDS.noStubMarkers, outcome: "fail", detail: `stub marker at src/${tag}.ts` }),
    ],
    criterionCoverage: [...Array<undefined>(count)].map((_, i) =>
      coverageFixture({ criterionId: `C-${String(i)}`, tier: "FUNCTIONAL", outcome: "failed" }),
    ),
  });
}

test("the loop is BOUNDED — it stops at the cap and says so", async () => {
  // An unattended system that retries forever is worse than one that stops.
  //
  // THE REPORT MUST IMPROVE EVERY ROUND FOR THIS TEST TO MEASURE THE CAP, and
  // that is a change from the version of this test that predated the ordinal
  // detector. It used to vary only the failure DETAIL — which defeated the
  // fingerprint and nothing else. It no longer defeats `no-progress`, which
  // reads counts rather than text, so a stalled-but-reworded run now stops at
  // attempt 3 as `not-converging` and this test would have passed on the wrong
  // mechanism. A fixer closing one criterion per round reaches the cap honestly.
  const { gate } = stubGate([closing(5, "a"), closing(4, "b"), closing(3, "c"), closing(2, "d")]);
  const r = await runLoop({ gate, maxAttempts: 3 });
  assert.equal(r.passed, false);
  assert.equal(r.attempts, 3);
  assert.equal(r.reason, "retry-cap");
  assert.equal(r.cause, "attempt-cap", "the cap, not the clock and not the detector");
});

test("THE NEW BOUND — a fixer that changes text but closes nothing stops at the no-progress window", async () => {
  // THIS IS THE REAL FAILING ARTEFACT'S SHAPE, not an invented one. `GATE:boot`'s
  // detail embeds a poll count and an elapsed-milliseconds figure
  // (bakeoff/src/scorer-container.ts), so on the one failing build in this tree
  // every round produces a different STRING and an identical SITUATION.
  // `fingerprint` is exact equality over that string and is therefore defeated by
  // it: with a no-op fixer, a loop watching only the fingerprint ran to its cap.
  const jitter = (poll: number): ContainerResult =>
    containerFixture({
      tier0: [
        tier0Fixture({
          id: GATE_IDS.boot,
          name: "the app answers its health path",
          outcome: "fail",
          detail: `no response after ${String(poll)} polls (${String(poll * 500)} ms elapsed)`,
          command: "npm start",
          exitCode: null,
        }),
      ],
      criterionCoverage: [coverageFixture({ criterionId: "C-1", tier: "FUNCTIONAL", outcome: "failed" })],
    });
  const { gate, calls } = stubGate([jitter(60), jitter(61), jitter(59), jitter(62), jitter(58), jitter(63)]);
  const r = await runLoop({ gate, maxAttempts: 6 });
  assert.equal(r.reason, "not-converging");
  assert.equal(r.cause, "no-progress", "not `identical-report` — no two of those strings are equal");
  assert.equal(r.attempts, NO_PROGRESS_WINDOW);
  assert.equal(calls.length, NO_PROGRESS_WINDOW, "it did not spend the other three rounds re-proving it");
});

test("…and the same detector does NOT stop a fixer that is closing criteria", async () => {
  // The other half, and the half that decides whether the bound above is a bound
  // or a wall. If `improved` were inverted, constant, or read something that
  // never moves, every real run would stop at attempt 3 with work left it could
  // have finished — which is a worse product than no detector at all.
  const { gate } = stubGate([closing(4, "a"), closing(3, "b"), closing(2, "c"), closing(1, "d"), green()]);
  const r = await runLoop({ gate, maxAttempts: 6 });
  assert.equal(r.reason, "green");
  assert.equal(r.cause, "green");
  assert.equal(r.attempts, 5, "five gates, four fix rounds, no early stop");
});

test("…and closing tier-0 failures counts as progress even when the criteria stand still", async () => {
  // The pair is lexicographic for a reason: a build can grind down its tier-0
  // failures for several rounds before a single held-out criterion flips. Reading
  // only the criterion count would call that fixer non-converging while it was
  // doing the work that eventually flips it.
  const withFailures = (n: number): ContainerResult =>
    containerFixture({
      tier0: [...Array<undefined>(n)].map((_, i) =>
        tier0Fixture({ id: GATE_IDS.noStubMarkers, outcome: "fail", detail: `stub ${String(i)}` }),
      ),
      criterionCoverage: [coverageFixture({ criterionId: "C-1", tier: "FUNCTIONAL", outcome: "failed" })],
    });
  const { gate } = stubGate([withFailures(4), withFailures(3), withFailures(2), withFailures(1), green()]);
  const r = await runLoop({ gate, maxAttempts: 6 });
  assert.equal(r.reason, "green");
  assert.equal(r.attempts, 5);
});

test("THE NEW BOUND — the wall-clock budget stops the loop, and says the clock did it", async () => {
  // The owner's ask is an unattended overnight run. The bound that matters
  // overnight is not "how many rounds" — no run has ever performed a second gate
  // attempt — it is "how long", and until now this loop had no answer to that at
  // all: with a cap of 10 and a fix round of unknown duration, the only ceiling
  // was the caller's patience.
  const clock = fakeClock();
  const { gate, calls } = stubGate([closing(5, "a"), closing(4, "b"), closing(3, "c"), closing(2, "d")]);
  const r = await runLoop({
    gate: async (attempt) => {
      const result = await gate(attempt);
      clock.advanceMinutes(90); // a fix round costs roughly a build; a build cost 24.4 min
      return result;
    },
    maxAttempts: 10,
    timeBudgetMs: 240 * 60_000,
    now: clock.now,
  });
  assert.equal(r.reason, "retry-cap", "the coarse persisted vocabulary has no member for a clock");
  assert.equal(r.cause, "time-budget", "and the cause says which of the two it was");
  assert.equal(r.passed, false);
  assert.equal(calls.length, 3, "three rounds at 90 minutes fits in 240; a fourth does not start");
});

test("…and the budget never fires before the first gate has produced a verdict", async () => {
  // A budget that could stop at attempt 0 returns a run with NO measurement,
  // which is the failure this whole program keeps insisting must not look like
  // any other: "the gate could not run" and "the gate says no" are different
  // claims. A budget already spent when the loop opens still buys one gate.
  const clock = fakeClock();
  const { gate, calls } = stubGate([green()]);
  const r = await runLoop({ gate, maxAttempts: 3, timeBudgetMs: 0, now: clock.now });
  assert.equal(r.reason, "green");
  assert.equal(calls.length, 1, "the gate ran once even with the budget already gone");
});

test("…and a loop that finishes inside its budget is not touched by it", async () => {
  const clock = fakeClock();
  const { gate } = stubGate([closing(2, "a"), green()]);
  const r = await runLoop({
    gate: async (attempt) => {
      const result = await gate(attempt);
      clock.advanceMinutes(30);
      return result;
    },
    maxAttempts: 6,
    timeBudgetMs: 240 * 60_000,
    now: clock.now,
  });
  assert.equal(r.reason, "green");
  assert.equal(r.cause, "green");
});

test("the wall-clock budget comes from the environment, in minutes, and refuses nonsense", () => {
  assert.equal(timeBudgetFrom({}), DEFAULT_TIME_BUDGET_MS);
  assert.equal(DEFAULT_TIME_BUDGET_MS, 240 * 60_000, "four hours, and stated as such");
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "60" }), 60 * 60_000);
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "1440" }), 1440 * 60_000);
  // Refused, not clamped — `maxAttemptsFrom`'s reason: a clamp runs the owner's
  // number as a different number and logs it as if it had been honoured.
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "1441" }), DEFAULT_TIME_BUDGET_MS);
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "0" }), DEFAULT_TIME_BUDGET_MS);
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "-5" }), DEFAULT_TIME_BUDGET_MS);
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "1.5" }), DEFAULT_TIME_BUDGET_MS);
  assert.equal(timeBudgetFrom({ DASHBOARD_GATE_TIME_BUDGET_MIN: "overnight" }), DEFAULT_TIME_BUDGET_MS);
});

test("THE ATTEMPT CAP IS UNCHANGED AT 3, AND THAT IS THE MEASURED CHOICE", () => {
  // The design proposed 3 -> 6. Both gated runs in the owner's database recorded
  // `gate_attempts = 1`: the cap has never been approached, so raising it is
  // unmeasured in both directions and doubles worst-case context pressure on a
  // builder session that is RESUMED per round and has already died once from an
  // output-token ceiling. The env override is how a longer night is bought.
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  assert.equal(maxAttemptsFrom({ DASHBOARD_GATE_MAX_ATTEMPTS: "6" }), 6);
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

/**
 * A gate that failed for a VISUAL reason and nothing else.
 *
 * `GATE:screenshots-present` classifies `visual` (gate-report.ts) and IS on the
 * detail allowlist, so its text crosses to a fixer — which is why this is also
 * the carrier the redaction tests below poison.
 */
function visualFailure(detail: string): ContainerResult {
  return containerFixture({
    tier0: [
      tier0Fixture({
        id: GATE_IDS.screenshotsPresent,
        name: "a masked, non-blank screenshot exists for every declared flow",
        outcome: "fail",
        detail,
      }),
    ],
  });
}

test("work routed to an agent this run may not use stops the loop instead of spinning", async () => {
  // A visual failure on a `cli` ticket routes to taste-frontend-expert, which is
  // not on that surface's shortlist. Re-gating without having run anything would
  // produce the identical report and burn the whole budget one round at a time.
  const visual = visualFailure("flow home produced a blank capture");
  const { gate, calls } = stubGate([visual, visual, visual]);
  const r = await runGateFixLoop({
    gate,
    runFix: () => Promise.resolve(),
    maxAttempts: 5,
    workspace: "/tmp/ws",
    allowedAgents: shortlistFor("cli"),
  });
  assert.equal(r.reason, "not-converging");
  // AND THE CAUSE SAYS WHICH OF THE TWO THINGS `not-converging` MEANS. Nothing
  // here failed to converge: nothing was permitted to try. Reported as a fixer
  // that changed nothing, this reads as a build problem, and the owner goes
  // looking at the build.
  assert.equal(r.cause, "no-permitted-fixer");
  assert.equal(calls.length, 1, "it did not re-gate to discover the same denial again");
  assert.equal(r.deniedTasks.length, 1);
  assert.equal(r.deniedTasks[0]?.agent, "taste-frontend-expert");
});

test("A VISUAL FAILURE BECOMES A FIX TASK AN AGENT CAN ACT ON — the whole point of routing it", async () => {
  // WITHOUT THIS THE VISUAL GATE IS WORSE THAN NO GATE. A finding that can be
  // raised and not acted on produces a run that fails, spends its rounds, and
  // stops — indistinguishable from a fixer that tried. The three things asserted
  // here are the three things missing from the generic prompt:
  //   1. it reaches taste-frontend-expert at all, on a surface with a design lane
  //   2. it is told how to CHECK a fix, because there is no command to re-run
  //   3. it is told the asset rule, at the one point in the program where a
  //      design agent is most likely to reach for an icon package
  const seen: { agent: string; prompt: string }[] = [];
  const { gate } = stubGate([visualFailure("flow home rendered with no styled content"), green()]);
  const r = await runGateFixLoop({
    gate,
    runFix: (task: FixTask, prompt: string) => {
      seen.push({ agent: task.agent, prompt });
      return Promise.resolve();
    },
    maxAttempts: 3,
    workspace: "/tmp/ws",
    // The design lane running is what puts taste-frontend-expert on the
    // shortlist, and orchestrator.ts passes the build's own lane mode here.
    allowedAgents: shortlistFor("fullstack", "full"),
  });

  // POSITIVE CONTROL FIRST: a `doesNotMatch` sweep over an empty array passes.
  assert.equal(seen.length, 1, "a visual failure must actually have produced a spawned fix task");
  assert.equal(r.reason, "green");
  assert.equal(seen[0]?.agent, "taste-frontend-expert", "not the debugger, and not dropped");

  const prompt = seen[0]?.prompt ?? "";
  assert.match(prompt, /no command to re-run/, "it must not be told to re-run a command that is null");
  assert.match(prompt, /render/i, "it must be told how to check a fix at all");
  assert.match(prompt, /design reference this run LOCKED/, "and what the build is being judged against");
  assert.match(prompt, /MUST BE GENERATED FOR THIS BUILD/, "the owner's standing rule on assets");
  assert.match(prompt, /No CDN link, no icon font, no icon package/);
  assert.doesNotMatch(
    prompt,
    /re-run the failing command yourself/,
    "the generic instruction is wrong here and must not survive alongside the visual one",
  );
});

test("a non-visual task is NOT given the visual instructions — the block is routed, not pasted", async () => {
  // The negative control for the test above. If the visual block were
  // unconditional, that test would pass over a prompt builder that had learned
  // nothing about classes, and every debugger in the system would be lectured
  // about icon packages while reading a compiler error.
  const seen: string[] = [];
  const { gate } = stubGate([failing("build"), green()]);
  await runLoop({ gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0] ?? "", /no command to re-run/);
  assert.doesNotMatch(seen[0] ?? "", /icon package/);
  assert.match(seen[0] ?? "", /re-run the failing command yourself/, "and it keeps its own instruction");
});

test("THE LEAK TEST, ON THE VISUAL PATH — a poisoned visual detail reaches no agent", async () => {
  // A VISUAL DETAIL IS WRITTEN ABOUT A RENDERED CAPTURE, so it is the one class
  // whose free text naturally names image files, and `gate-report.ts` copies it
  // to a `FixableFailure` with a length cap and no allowlist. The detail below is
  // the realistic poisoning of that carrier: a capture filename AND a held-out
  // test title in the same string, which is what a screenshot gate that had been
  // handed suite output would look like.
  //
  // THE MECHANISM IS FAIL-CLOSED WITHHOLDING OF THE WHOLE STRING, not detection
  // of the title. Say that plainly rather than let this test imply the program
  // can recognise a title: it cannot, and the title goes only because it is
  // travelling with a path.
  const seen: string[] = [];
  const poisoned = visualFailure(
    `flow home: review/screenshots/home__1280.png is blank — ${HELD_OUT_TITLE} expected an h1`,
  );
  const { gate } = stubGate([poisoned, green()]);
  const r = await runGateFixLoop({
    gate,
    runFix: (_task: FixTask, prompt: string) => {
      seen.push(prompt);
      return Promise.resolve();
    },
    maxAttempts: 3,
    workspace: "/tmp/ws",
    allowedAgents: shortlistFor("fullstack", "full"),
  });

  assert.equal(seen.length, 1, "a prompt must actually have been built and delivered");
  assert.equal(r.reason, "green");
  for (const p of seen) {
    assert.doesNotMatch(p, /renders the hero heading/, "a held-out test title reached a fixing agent");
    assert.doesNotMatch(p, /home__1280\.png/, "a capture filename reached a fixing agent");
    assert.doesNotMatch(p, /review\/screenshots/, "a capture path reached a fixing agent");
    // And it does not read as "there was nothing to say", which is the other way
    // a redaction lies. The fixer is told the evidence was withheld and why.
    assert.match(p, /detail withheld/);
    assert.match(p, /render that flow at that breakpoint yourself/);
  }
});

test("…and a clean visual detail still crosses, so the guard is not simply a wall", async () => {
  // THE OTHER HALF, and the one that decides whether the test above measures a
  // redactor or an empty function. A guard that withheld every visual detail
  // would pass the leak assertions perfectly and hand every design agent a task
  // stripped of its evidence.
  const seen: string[] = [];
  const { gate } = stubGate([visualFailure("flow home rendered 0 styled elements above the fold"), green()]);
  await runGateFixLoop({
    gate,
    runFix: (_task: FixTask, prompt: string) => {
      seen.push(prompt);
      return Promise.resolve();
    },
    maxAttempts: 3,
    workspace: "/tmp/ws",
    allowedAgents: shortlistFor("fullstack", "full"),
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", /0 styled elements above the fold/, "the finding's own evidence must cross");
  assert.doesNotMatch(seen[0] ?? "", /detail withheld/);
});

test("the suite-green gate — the ONE carrier that does quote the runner — is withheld and is not visual", async () => {
  // WHY THIS IS ASSERTED HERE AND NOT TAKEN ON TRUST. The claim that a visual
  // finding cannot carry a held-out title rests entirely on WHERE titles come
  // from: `GATE:suite-green` quotes the held-out runner, and it classifies
  // `logic` and is absent from the detail allowlist, so its text never crosses at
  // all. If either of those ever changed, the guard above — which looks for
  // paths, not titles — would not catch it, and this assertion is what fails.
  const seen: string[] = [];
  const { gate } = stubGate([failingWithTestRefs(HELD_OUT_TITLE), green()]);
  await runLoop({ gate, maxAttempts: 3, onAgentPrompt: (p) => seen.push(p) });
  assert.equal(seen.length, 1);
  const prompt = seen[0] ?? "";
  assert.match(prompt, /detail withheld: this gate's detail is derived from the held-out suite/);
  assert.doesNotMatch(prompt, /renders the hero heading/);
  // Routed to the debugger, not to the design specialist: a suite failure is not
  // a visual failure however it is worded.
  assert.doesNotMatch(prompt, /icon package/);
});

test("an abort the caller can explain is reported as what it was, not as the owner's doing", async () => {
  // `cancelled` covers an owner abort AND a provider rate-limit abort, and they
  // are persisted identically. One run is terminal and the other is meant to
  // resume; recorded as the same word, a run nobody abandoned is filed as
  // abandoned. The caller that knows the difference is orchestrator.ts, whose
  // `runFix` sets a local `rateLimit` and then aborts — one line away from this.
  const controller = new AbortController();
  const { gate } = stubGate([failing("build"), green()]);
  const r = await runLoop({
    gate: (attempt: number) => {
      controller.abort();
      return gate(attempt);
    },
    maxAttempts: 3,
    signal: controller.signal,
    abortCause: () => "rate-limited",
  });
  assert.equal(r.reason, "cancelled", "the persisted vocabulary is unchanged");
  assert.equal(r.cause, "rate-limited");
  assert.equal(r.passed, false);

  // AND THE DEFAULT IS UNCHANGED. A caller that says nothing gets exactly the
  // behaviour this loop has always had — the owner stopped it.
  const c2 = new AbortController();
  const second = stubGate([failing("build"), green()]);
  const r2 = await runLoop({
    gate: (attempt: number) => {
      c2.abort();
      return second.gate(attempt);
    },
    maxAttempts: 3,
    signal: c2.signal,
  });
  assert.equal(r2.cause, "owner-cancelled");
  assert.equal(r2.reason, "cancelled");
});

/* -------------------------------------------------------------------------
 * THE FIELD SEPARATOR — the property the NUL bytes were carrying, and the
 * property the escape that replaced them has to carry too.
 *
 * `fingerprint` concatenates `klass`, `id` and `detail` into one hash input.
 * `detail` is FREE TEXT a gate wrote, so without a separator that cannot occur
 * inside it two different reports can produce one hash input: `{id: "a",
 * detail: "bc"}` and `{id: "ab", detail: "c"}`. Equal fingerprints there means
 * the loop calls `not-converging` on a fixer that changed something real.
 *
 * The separator moved from three RAW NUL BYTES to the source escape for U+001F
 * on 2026-07-30, because a NUL makes the whole FILE binary to `grep`, which then
 * skips it without saying so. That is a tooling fix, and these tests are what
 * makes it a safe one: every digest VALUE changed, so what is asserted here is
 * the EQUALITY RELATION, which is the only thing any caller observes.
 * `fingerprint` is called at one site, compared against a local variable holding
 * the previous round's value, and never logged, returned or persisted — there is
 * no stored digest for a new one to disagree with.
 * ---------------------------------------------------------------------- */

function reportWith(
  failures: readonly FixableFailure[],
  unmet: Record<"BLOCKING" | "FUNCTIONAL" | "QUALITY", number> = { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
): AgentVisibleReport {
  return { failures, heldOutUnmet: unmet, infraFailure: null };
}

function failure(id: string, detail: string, klass: FailureClass = "logic"): FixableFailure {
  return { id, klass, summary: "s", detail, command: null, exitCode: null };
}

test("the field separator keeps two differently-split reports apart", () => {
  // The collision the separator exists to prevent, at the id/detail boundary.
  const split = fingerprint(reportWith([failure("GATE:x", "detail")]));
  const run = fingerprint(reportWith([failure("GATE:xdetail", "")]));
  assert.notEqual(split, run, "id and detail ran together: the separator is not separating");

  // And at the klass/id boundary. The cast is the point: `klass` is a union in
  // TypeScript and a string in the hash input, and the hash cannot rely on the
  // union to keep the fields apart.
  const klassSplit = fingerprint(reportWith([failure("y", "d", "build")]));
  const klassRun = fingerprint(reportWith([failure("", "d", "buildy" as FailureClass)]));
  assert.notEqual(klassSplit, klassRun, "klass and id ran together");

  // A detail that ENDS where the next field begins is the shape that collides
  // most easily, so it gets its own pair rather than being implied.
  assert.notEqual(
    fingerprint(reportWith([failure("a", "b"), failure("c", "d")])),
    fingerprint(reportWith([failure("a", "bc"), failure("", "d")])),
  );
});

test("the fingerprint is a function of what the loop compares, and nothing else", () => {
  // Identical input, twice: the relation the loop's `previous === current` check
  // reads. Without this the collision test above could pass over a hash that is
  // simply unstable, which would fail `not-converging` open forever.
  const r = reportWith([failure("GATE:a", "one"), failure("GATE:b", "two")], {
    BLOCKING: 1,
    FUNCTIONAL: 0,
    QUALITY: 2,
  });
  assert.equal(fingerprint(r), fingerprint(reportWith([...r.failures], { ...r.heldOutUnmet })));
  // Order of arrival is not state: the loop sorts before hashing.
  assert.equal(fingerprint(r), fingerprint(reportWith([...r.failures].reverse(), { ...r.heldOutUnmet })));
  // Each of the three inputs moves it.
  assert.notEqual(fingerprint(r), fingerprint(reportWith([failure("GATE:a", "one")], { ...r.heldOutUnmet })));
  assert.notEqual(
    fingerprint(r),
    fingerprint(reportWith([...r.failures], { BLOCKING: 1, FUNCTIONAL: 0, QUALITY: 1 })),
  );
  assert.notEqual(
    fingerprint(r),
    fingerprint(reportWith([failure("GATE:a", "ONE"), failure("GATE:b", "two")], { ...r.heldOutUnmet })),
  );
  // 64 hex characters, so a truncated or empty digest cannot read as agreement.
  assert.match(fingerprint(reportWith([])), /^[0-9a-f]{64}$/);
});
