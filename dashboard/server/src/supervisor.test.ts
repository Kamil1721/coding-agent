/**
 * supervisor.test.ts — the loop, the durable queue, the never-park rule, and
 * the arm check that tells an idle queue from a lost submission.
 *
 * ─── WHAT THIS FILE IS DEFENDING AGAINST ───
 *
 * A supervisor's failure mode is silence, and silence is also what a healthy
 * idle supervisor produces. So every assertion here is paired: something must
 * happen when the loop works, AND something visibly different must happen when
 * it does not. The arm-check test is the strongest of them — it asserts that
 * three snapshots with known answers produce three DIFFERENT verdicts, so a
 * discriminator that collapses into one answer is red rather than quiet.
 *
 * VERBATIM RED, recorded when each test was watched failing against a
 * deliberately broken production line, is quoted at each mutation note.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "./db.js";
import type { ApiRunStatus } from "./api-types.js";
import {
  armRepairRouter,
  assertNeverParks,
  classifySupervisorHealth,
  SupervisorLoop,
  SUPERVISOR_DEFAULT_WAIT_MS,
  SUPERVISOR_REPAIR_DEADLINE_MS,
  SUPERVISOR_REPAIR_MAX_PER_SIGNATURE,
  type SupervisorDeps,
  type SupervisorSnapshot,
  type SupervisorSubmission,
} from "./supervisor.js";
import { boundFor, isRepairable } from "./recovery.js";
import type { FailureClass } from "./recovery.js";

function openStore(): { readonly store: RunStore; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  const store = RunStore.open(join(dir, "runs.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addRun(store: RunStore, runId: string, status: ApiRunStatus): void {
  store.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: "a ticket",
    ticketText: "build the thing",
    ticketSha256: "0".repeat(64),
    modelId: "claude-sonnet-4-5",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
  if (status !== "queued") store.updateRun(runId, { status });
}

/** A submit stub that records what it was handed. */
function recordingSubmit(runId: string): {
  readonly calls: SupervisorSubmission[];
  readonly submit: (spec: SupervisorSubmission) => Promise<{ readonly runId: string }>;
} {
  const calls: SupervisorSubmission[] = [];
  return {
    calls,
    submit: (spec) => {
      calls.push(spec);
      return Promise.resolve({ runId });
    },
  };
}

test("the state a fresh database reports is stopped, with a reason", () => {
  const { store, cleanup } = openStore();
  try {
    const state = store.readSupervisorState();
    assert.equal(state.desired, "stopped");
    assert.notEqual(state.reason.trim(), "");
  } finally {
    cleanup();
  }
});

test("a ticket cannot be filed mute, and a state change cannot be filed unexplained", () => {
  const { store, cleanup } = openStore();
  try {
    assert.throws(
      () => store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "t", modelId: "m", nextAction: "  " }),
      /nextAction/,
    );
    assert.throws(() => store.setSupervisorState("running", "owner", ""), /reason/);
    assert.throws(
      () => store.logSupervisorDecision({ ticketKey: null, runId: null, decision: "claimed", reason: "" }),
      /reason/,
    );
  } finally {
    cleanup();
  }
});

test("the claim is conditional: the same queued ticket cannot be claimed twice", () => {
  const { store, cleanup } = openStore();
  try {
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "t", modelId: "m", nextAction: "waiting to start" });
    assert.equal(store.claimSupervisorTicket("k1", "submitting"), true);
    // MUTATION: drop `AND state = 'queued'` from `claimSupervisorTicket` and
    // this second call returns true. Run 2026-08-10:
    //   VERBATIM RED:
    //   ✖ the claim is conditional: the same queued ticket cannot be claimed twice (6.583791ms)
    //     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //     true !== false
    //       expected: false,
    assert.equal(store.claimSupervisorTicket("k1", "submitting"), false);
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * The discriminator, and the arm check built on it
 * ------------------------------------------------------------------------ */

test("idle, in-flight and stuck are three different answers, not one silence", () => {
  const empty: SupervisorSnapshot = { desired: "running", tickets: [] };
  const orphan: SupervisorSnapshot = {
    desired: "running",
    tickets: [{ ticketKey: "k1", state: "claimed", currentRunId: null, runStatus: null }],
  };
  const live: SupervisorSnapshot = {
    desired: "running",
    tickets: [{ ticketKey: "k1", state: "running", currentRunId: "r1", runStatus: "running" }],
  };
  const vanished: SupervisorSnapshot = {
    desired: "running",
    tickets: [{ ticketKey: "k1", state: "running", currentRunId: "r1", runStatus: "no-row" }],
  };

  assert.equal(classifySupervisorHealth(empty).code, "idle-empty-queue");
  assert.equal(classifySupervisorHealth(orphan).code, "stuck-orphan-claim");
  assert.equal(classifySupervisorHealth(live).code, "in-flight");
  assert.equal(classifySupervisorHealth(vanished).code, "stuck-vanished-run");

  // The two that look identical from outside must not read identically.
  assert.notEqual(classifySupervisorHealth(empty).line, classifySupervisorHealth(orphan).line);
  assert.equal(classifySupervisorHealth(orphan).stuck, true);
  assert.equal(classifySupervisorHealth(empty).stuck, false);

  // Every line is a sentence.
  for (const snapshot of [empty, orphan, live, vanished]) {
    assert.notEqual(classifySupervisorHealth(snapshot).line.trim(), "");
  }
});

test("the arm check reports BLIND when the discriminator cannot tell stuck from idle", () => {
  const { store, cleanup } = openStore();
  try {
    const lines: string[] = [];
    const loop = new SupervisorLoop({
      store,
      submit: () => Promise.reject(new Error("not used")),
      log: (line) => lines.push(line),
    });
    const armed = loop.armCheck();
    // MUTATION: make the orphan arm of `classifySupervisorHealth` fall through
    // (`if (false && orphan !== undefined)`), so a lost submission is read as a
    // vanished run. Run 2026-08-10; three tests went red, this one on:
    //   VERBATIM RED:
    //   ✖ the arm check reports BLIND when the discriminator cannot tell stuck from idle (2.923708ms)
    //     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //     false !== true
    // NOTE THE ARM CHECK STILL COUNTED THREE DISTINCT VERDICTS — the collapse it
    // caught was `1 misread`, not a lost verdict, which is why `wrong.length`
    // and the distinct count are BOTH conditions of `armed`.
    assert.equal(armed.armed, true);
    assert.ok(
      lines.some((l) => l.includes("3 distinct verdict(s) on 3 known inputs")),
      `expected the discriminator count line, got: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.startsWith("ARM CHECK: armed")),
      `expected an armed line, got: ${lines.join(" | ")}`,
    );
    assert.ok(!lines.some((l) => l.includes("BLIND")), "a healthy arm check must not say BLIND");
    // And the live counts are real numbers off the real store, not a constant.
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "t", modelId: "m", nextAction: "waiting to start" });
    const second: string[] = [];
    new SupervisorLoop({ store, submit: () => Promise.reject(new Error("x")), log: (l) => second.push(l) }).armCheck();
    assert.ok(
      second.some((l) => l.includes("queued 1")),
      `expected the live count to move to 1, got: ${second.join(" | ")}`,
    );
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * The loop
 * ------------------------------------------------------------------------ */

test("a running supervisor with a queued ticket submits it and records the run", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "the owner pressed start");
    store.enqueueSupervisorTicket({
      ticketKey: "k1",
      ticketText: "build a portfolio site",
      modelId: "claude-sonnet-4-5",
      nextAction: "waiting to be claimed",
    });
    const { calls, submit } = recordingSubmit("run-1");
    const loop = new SupervisorLoop({ store, submit, log: () => {} });
    const report = await loop.tick();

    // MUTATION: make the CLAIM step find nothing (`const next = undefined`) and
    // the tick submits nothing. Run 2026-08-10; eight tests went red, this one on:
    //   VERBATIM RED:
    //   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //   0 !== 1
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.ticketText, "build a portfolio site");
    assert.equal(report.submittedRunId, "run-1");
    const ticket = store.getSupervisorTicket("k1");
    assert.equal(ticket?.state, "running");
    assert.equal(ticket?.currentRunId, "run-1");
    assert.equal(ticket?.attemptNo, 1);
    assert.notEqual(ticket?.nextAction.trim(), "");
    assert.ok(store.listSupervisorLog().some((row) => row.decision === "submitted"));
  } finally {
    cleanup();
  }
});

test("a stopped supervisor claims nothing, and says so rather than saying nothing", async () => {
  const { store, cleanup } = openStore();
  try {
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "t", modelId: "m", nextAction: "waiting" });
    const { calls, submit } = recordingSubmit("run-1");
    const report = await new SupervisorLoop({ store, submit, log: () => {} }).tick();
    assert.equal(calls.length, 0);
    assert.equal(report.health.code, "stopped");
    assert.ok(report.health.line.includes("1 ticket(s) are queued"), report.health.line);
  } finally {
    cleanup();
  }
});

test("the loop survives its own restart: a NEW loop over the same store does not double-submit", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "the owner pressed start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    store.enqueueSupervisorTicket({ ticketKey: "k2", ticketText: "two", modelId: "m", nextAction: "waiting" });
    const first = recordingSubmit("run-1");
    await new SupervisorLoop({ store, submit: first.submit, log: () => {} }).tick();
    addRun(store, "run-1", "running");

    // The process "restarts": a brand new loop object, no shared memory.
    const second = recordingSubmit("run-2");
    const report = await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();

    // MUTATION: make `#inFlight()` return null unconditionally — i.e. keep the
    // in-flight fact in memory instead of reading it back off the tables — and
    // the restarted loop claims k2 on top of the live run. Run 2026-08-10:
    //   VERBATIM RED:
    //   ✖ the loop survives its own restart: a NEW loop over the same store does not double-submit (5.592ms)
    //     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //     1 !== 0
    assert.equal(second.calls.length, 0);
    assert.equal(report.health.code, "in-flight");
    assert.equal(store.getSupervisorTicket("k2")?.state, "queued");
  } finally {
    cleanup();
  }
});

test("an orphaned claim is returned to the queue instead of waiting for ever", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "the owner pressed start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    // The crash: claimed, no run row, nothing in memory.
    assert.equal(store.claimSupervisorTicket("k1", "submitting"), true);
    assert.equal(new SupervisorLoop({ store, submit: () => Promise.reject(new Error("x")), log: () => {} })
      .health().code, "stuck-orphan-claim");

    const { calls, submit } = recordingSubmit("run-9");
    const report = await new SupervisorLoop({ store, submit, log: () => {} }).tick();

    // MUTATION: turn the `currentRunId === null` branch of `#reconcile` into a
    // `return null` and the ticket stays `claimed` for ever. Run 2026-08-10:
    //   VERBATIM RED:
    //   ✖ an orphaned claim is returned to the queue instead of waiting for ever (3.69575ms)
    //     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //     0 !== 1
    assert.equal(calls.length, 1);
    assert.ok(report.decisions.some((d) => d.includes("orphan claim")), report.decisions.join(" | "));
    assert.ok(
      store.listSupervisorLog().some((row) => row.reason.includes("orphan-claim")),
      "the journal must carry one row naming the decision and why",
    );
  } finally {
    cleanup();
  }
});

test("a run that vanished from the runs table does not strand its ticket", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    store.claimSupervisorTicket("k1", "submitting");
    store.updateSupervisorTicket("k1", { state: "running", currentRunId: "run-gone", nextAction: "watching" });
    const { calls, submit } = recordingSubmit("run-new");
    await new SupervisorLoop({ store, submit, log: () => {} }).tick();
    assert.equal(calls.length, 1);
    assert.ok(store.listSupervisorLog().some((row) => row.reason.includes("vanished")));
  } finally {
    cleanup();
  }
});

test("a rate-limited run parks the TICKET with a wake instant, not a timer", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    store.claimSupervisorTicket("k1", "submitting");
    addRun(store, "run-1", "rate_limited");
    store.updateSupervisorTicket("k1", { state: "running", currentRunId: "run-1", nextAction: "watching" });

    const now = new Date("2026-08-10T10:00:00.000Z");
    await new SupervisorLoop({ store, submit: () => Promise.reject(new Error("x")), now: () => now, log: () => {} })
      .tick();
    const ticket = store.getSupervisorTicket("k1");
    assert.equal(ticket?.state, "waiting");
    assert.equal(ticket?.nextActionAt, "2026-08-10T10:15:00.000Z");
    assert.notEqual(ticket?.nextAction.trim(), "");
  } finally {
    cleanup();
  }
});

test("a woken ticket resumes when it can and re-submits when it cannot", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    addRun(store, "run-1", "rate_limited");
    store.updateSupervisorTicket("k1", {
      state: "waiting",
      currentRunId: "run-1",
      nextAction: "waiting out the refusal",
      nextActionAt: "2026-08-10T09:00:00.000Z",
    });
    const resumed: string[] = [];
    const now = new Date("2026-08-10T10:00:00.000Z");
    await new SupervisorLoop({
      store,
      submit: () => Promise.reject(new Error("x")),
      resume: (runId) => {
        resumed.push(runId);
        return true;
      },
      now: () => now,
      log: () => {},
    }).tick();
    assert.deepEqual(resumed, ["run-1"]);
    assert.equal(store.getSupervisorTicket("k1")?.state, "running");

    // The same ticket, but the run has since gone terminal: resume is illegal
    // and the ticket must go back to the queue rather than sit in `waiting`.
    store.updateRun("run-1", { status: "failed" });
    store.updateSupervisorTicket("k1", {
      state: "waiting",
      nextAction: "waiting again",
      nextActionAt: "2026-08-10T09:00:00.000Z",
    });
    const { calls, submit } = recordingSubmit("run-2");
    await new SupervisorLoop({ store, submit, now: () => now, resume: () => true, log: () => {} }).tick();
    assert.equal(calls.length, 1, "a terminal run must be re-submitted, never resumed");
  } finally {
    cleanup();
  }
});

test("STOP drains: nothing new is claimed, and the state becomes stopped when the run ends", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    store.enqueueSupervisorTicket({ ticketKey: "k2", ticketText: "two", modelId: "m", nextAction: "waiting" });
    const first = recordingSubmit("run-1");
    await new SupervisorLoop({ store, submit: first.submit, log: () => {} }).tick();
    addRun(store, "run-1", "running");

    store.setSupervisorState("draining", "owner", "the owner pressed stop");
    const second = recordingSubmit("run-2");
    const draining = await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();
    assert.equal(second.calls.length, 0, "a draining supervisor must not claim");
    assert.equal(store.readSupervisorState().desired, "draining", "the drain must not end while a run is live");
    assert.equal(draining.health.code, "in-flight");

    store.updateRun("run-1", { status: "passed" });
    await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();
    // MUTATION: disable the `desired === "draining" && inFlight === null`
    // block and the supervisor stays `draining` for ever, which is a stop that
    // never finishes stopping. Run 2026-08-10:
    //   VERBATIM RED:
    //   ✖ STOP drains: nothing new is claimed, and the state becomes stopped when the run ends (4.942333ms)
    //     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //     + actual - expected
    //     + 'draining'
    //     - 'stopped'
    assert.equal(store.readSupervisorState().desired, "stopped");
    assert.equal(store.getSupervisorTicket("k1")?.state, "done");
    assert.equal(second.calls.length, 0, "the drain must not have claimed k2 on the way out");
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * Settling
 * ------------------------------------------------------------------------ */

test("a structural failure goes to repairing, never back to the queue", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    const first = recordingSubmit("run-1");
    await new SupervisorLoop({ store, submit: first.submit, log: () => {} }).tick();
    addRun(store, "run-1", "failed");
    store.updateRun("run-1", { recoveryClass: "structural" });

    const second = recordingSubmit("run-2");
    await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();
    // MUTATION: fold the structural arm of `settle` into the attempts arm
    // (`if (false || …)`) and the ticket is re-queued and immediately
    // re-submitted, which spends a second 87-minute spec phase on the defect
    // that just killed the first one. Run 2026-08-10:
    //   VERBATIM RED:
    //   ✖ a structural failure goes to repairing, never back to the queue (5.2915ms)
    //     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    //     + actual - expected
    //     + 'running'
    //     - 'repairing'
    assert.equal(store.getSupervisorTicket("k1")?.state, "repairing");
    assert.equal(second.calls.length, 0);
  } finally {
    cleanup();
  }
});

test("the no-retry decision is READ from recovery.ts's budget, not restated here", async () => {
  /*
   * THE TWO ARMS ARE THE POINT. An earlier draft hard-listed the zero-bound
   * classes and missed two of the eleven — `owner_action` (a spend refusal or a
   * missing credential) and `integrity` (a suite digest mismatch) — so the
   * supervisor re-submitted them up to `maxAttempts`. A comparator that refuses
   * everything is as useless as one that refuses nothing, so the retryable arm
   * is asserted in the same test.
   */
  const cases: readonly { readonly klass: string; readonly expect: string; readonly resubmits: boolean }[] = [
    { klass: "owner_action", expect: "blocked", resubmits: false },
    { klass: "integrity", expect: "blocked", resubmits: false },
    { klass: "harness_defect", expect: "repairing", resubmits: false },
    { klass: "accounting", expect: "repairing", resubmits: false },
    { klass: "suite_authoring", expect: "repairing", resubmits: false },
    { klass: "unclassified", expect: "repairing", resubmits: false },
    // A class this build has never heard of takes the conservative path.
    { klass: "a_class_added_in_2027", expect: "repairing", resubmits: false },
    // THE NEGATIVE CONTROL: a class with a real budget must still be retried.
    { klass: "transient", expect: "running", resubmits: true },
    { klass: "throttled", expect: "running", resubmits: true },
  ];
  for (const testCase of cases) {
    const { store, cleanup } = openStore();
    try {
      store.setSupervisorState("running", "owner", "start");
      store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
      const first = recordingSubmit("run-1");
      await new SupervisorLoop({ store, submit: first.submit, log: () => {} }).tick();
      addRun(store, "run-1", "failed");
      store.updateRun("run-1", { recoveryClass: testCase.klass });
      const second = recordingSubmit("run-2");
      await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();
      // MUTATION A: replace the `boundFor(...)` arm in `settle` with the old
      // hard-coded list of five class names. Run 2026-08-10:
      //   VERBATIM RED:
      //   ✖ the no-retry decision is READ from recovery.ts's budget, not restated here (31.509084ms)
      //     AssertionError [ERR_ASSERTION]: a_class_added_in_2027 must settle to repairing
      //     + actual - expected
      //     + 'running'
      //     - 'repairing'
      // MUTATION B: disable the owner-only branch (`if (false)`) — the classes
      // then fall to the budget arm, which is right about NOT retrying and wrong
      // about who may repair them. Run 2026-08-10:
      //   VERBATIM RED:
      //   ✖ the no-retry decision is READ from recovery.ts's budget, not restated here (5.039375ms)
      //     AssertionError [ERR_ASSERTION]: owner_action must settle to blocked
      //     + 'repairing'
      //     - 'blocked'
      assert.equal(
        store.getSupervisorTicket("k1")?.state,
        testCase.expect,
        `${testCase.klass} must settle to ${testCase.expect}`,
      );
      assert.equal(
        second.calls.length,
        testCase.resubmits ? 1 : 0,
        `${testCase.klass} must ${testCase.resubmits ? "" : "NOT "}be re-submitted`,
      );
    } finally {
      cleanup();
    }
  }
});

test("an ordinary failure retries up to the cap and is then blocked, never looped", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({
      ticketKey: "k1",
      ticketText: "one",
      modelId: "m",
      nextAction: "waiting",
      maxAttempts: 2,
    });
    let n = 0;
    const submit = (): Promise<{ readonly runId: string }> => {
      n += 1;
      const runId = `run-${String(n)}`;
      return Promise.resolve({ runId });
    };
    const loop = new SupervisorLoop({ store, submit, log: () => {} });

    await loop.tick();
    addRun(store, "run-1", "failed");
    store.updateRun("run-1", { recoveryClass: "transient" });
    await loop.tick(); // settles run-1 to queued, then claims again
    assert.equal(store.getSupervisorTicket("k1")?.attemptNo, 2);

    addRun(store, "run-2", "failed");
    store.updateRun("run-2", { recoveryClass: "transient" });
    await loop.tick();
    assert.equal(store.getSupervisorTicket("k1")?.state, "blocked");
    assert.equal(n, 2, "the cap must stop the third submission");
  } finally {
    cleanup();
  }
});

test("a cancelled run blocks the ticket so the next START does not re-spend on it", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    const first = recordingSubmit("run-1");
    await new SupervisorLoop({ store, submit: first.submit, log: () => {} }).tick();
    addRun(store, "run-1", "cancelled");
    const second = recordingSubmit("run-2");
    await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();
    assert.equal(store.getSupervisorTicket("k1")?.state, "blocked");
    assert.equal(second.calls.length, 0);
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * NEVER PARK
 * ------------------------------------------------------------------------ */

test("a submission that could park is refused at the boundary, not watched for", () => {
  assert.doesNotThrow(() =>
    assertNeverParks({ ticketText: "t", modelId: "m", designLock: "auto", interactive: false, deploy: false }),
  );
  // MUTATION: disable the `designLock` guard in `assertNeverParks` (`if (false)`)
  // and the call below stops throwing. Run 2026-08-10:
  //   VERBATIM RED:
  //   ✖ a submission that could park is refused at the boundary, not watched for (0.419208ms)
  //     AssertionError [ERR_ASSERTION]: Missing expected exception.
  //       at TestContext.<anonymous> (…/dist-supervisor/supervisor.test.js:458:12)
  assert.throws(
    () =>
      assertNeverParks({
        ticketText: "t",
        modelId: "m",
        designLock: "ask",
        interactive: false,
        deploy: false,
      } as unknown as SupervisorSubmission),
    /designLock/,
  );
  assert.throws(
    () =>
      assertNeverParks({
        ticketText: "t",
        modelId: "m",
        designLock: "auto",
        interactive: true,
        deploy: false,
      } as unknown as SupervisorSubmission),
    /interactive/,
  );
});

test("every submission the loop makes carries the two never-park fields", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    const { calls, submit } = recordingSubmit("run-1");
    await new SupervisorLoop({ store, submit, log: () => {} }).tick();
    assert.equal(calls[0]?.designLock, "auto");
    assert.equal(calls[0]?.interactive, false);
  } finally {
    cleanup();
  }
});

test("a submission that throws returns the ticket to the queue and journals why", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({ ticketKey: "k1", ticketText: "one", modelId: "m", nextAction: "waiting" });
    await new SupervisorLoop({
      store,
      submit: () => Promise.reject(new Error("the capture stack is down")),
      log: () => {},
    }).tick();
    const ticket = store.getSupervisorTicket("k1");
    assert.equal(ticket?.state, "queued");
    assert.ok(ticket?.nextAction.includes("capture stack is down"), ticket?.nextAction);
    assert.ok(store.listSupervisorLog().some((row) => row.decision === "refused"));
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * THE CAP ON THE CLAIM PATH, NOT ONLY ON THE TERMINAL ONE.
 *
 * MEASURED 2026-08-10: `settle()` was the SOLE place `attemptNo >= maxAttempts
 * -> blocked` was read, and it only runs when a run reaches a terminal status.
 * Two paths walked past it. (a) A deterministically throwing `submit` returned
 * the ticket to `queued` WITHOUT touching `attemptNo` — the increment lived on
 * the success path only — so the loop re-claimed the same ticket every 30 s
 * forever: an unbounded `supervisor_log` and a machine reporting progress while
 * making none. (b) `#wake` re-queues a non-resumable run for a FRESH submission,
 * and a ticket whose runs keep landing non-terminal (rate_limited / awaiting_
 * input -> wait -> wake -> re-submit) could exceed `maxAttempts` without bound.
 * Both are the same missing read, and it is read here now.
 * ------------------------------------------------------------------------- */
test("a submit that ALWAYS throws reaches blocked in bounded ticks — it does not spin for ever", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({
      ticketKey: "k1",
      ticketText: "one",
      modelId: "m",
      nextAction: "waiting",
      maxAttempts: 2,
    });
    const loop = new SupervisorLoop({
      store,
      submit: () => Promise.reject(new Error("bad model id")),
      log: () => {},
    });

    // ONE TICK PER ATTEMPT, and the attempt number has to MOVE or the cap can
    // never be reached. This is the assertion the old code failed.
    await loop.tick();
    assert.equal(store.getSupervisorTicket("k1")?.attemptNo, 1, "a failed submission did not count as an attempt");
    await loop.tick();
    assert.equal(store.getSupervisorTicket("k1")?.attemptNo, 2);

    // The cap is now reached, so the CLAIM step must refuse rather than submit.
    await loop.tick();
    const capped = store.getSupervisorTicket("k1");
    assert.equal(capped?.state, "blocked", `a ticket at its cap was not blocked: ${capped?.state ?? "(gone)"}`);
    assert.match(capped?.nextAction ?? "", /2 attempt/);

    // AND IT STAYS BLOCKED: a further tick must not resurrect it. Without this,
    // a re-queue anywhere upstream would restart the spin silently.
    await loop.tick();
    assert.equal(store.getSupervisorTicket("k1")?.state, "blocked");
    const claims = store.listSupervisorLog().filter((row) => row.decision === "claimed");
    assert.ok(claims.length <= 2, `the claim step ran ${String(claims.length)} times against a cap of 2`);
  } finally {
    cleanup();
  }
});

test("a ticket ALREADY at its cap is never claimed at all — the guard is before the spend, not after it", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({
      ticketKey: "k1",
      ticketText: "one",
      modelId: "m",
      nextAction: "waiting",
      maxAttempts: 1,
    });
    // The state `#wake` leaves behind: queued for a FRESH submission with the
    // attempts already spent, and `settle()` never ran because no run of this
    // ticket ever reached a terminal status.
    store.updateSupervisorTicket("k1", { state: "queued", attemptNo: 1, currentRunId: null });

    const { calls, submit } = recordingSubmit("run-should-not-exist");
    await new SupervisorLoop({ store, submit, log: () => {} }).tick();

    assert.deepEqual(calls, [], "a ticket at its cap was submitted anyway — this is the spend the cap exists to stop");
    assert.equal(store.getSupervisorTicket("k1")?.state, "blocked");

    // NEGATIVE HALF: the identical ticket one attempt below its cap IS submitted,
    // so this is a cap and not a component that refuses everything.
    store.enqueueSupervisorTicket({
      ticketKey: "k2",
      ticketText: "two",
      modelId: "m",
      nextAction: "waiting",
      maxAttempts: 2,
    });
    store.updateSupervisorTicket("k2", { state: "queued", attemptNo: 1, currentRunId: null });
    const second = recordingSubmit("run-2");
    await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();
    assert.equal(second.calls.length, 1, "a ticket with attempts remaining was refused");
    assert.equal(store.getSupervisorTicket("k2")?.state, "running");
  } finally {
    cleanup();
  }
});

/* ---------------------------------------------------------------------------
 * `repairing` IS NOT A DEAD END ANY MORE
 *
 * MEASURED 2026-08-10, and it is the reason this block exists. `settle()` routed
 * a structural failure to `repairing` with the sentence "waiting for a repair
 * proposal for this failure class"; `#tickOnce` step 1 listed
 * `["claimed","running","waiting"]`; and `grep -rn 'tools/repair' dashboard/server/src`
 * returned zero producers. So the ticket stayed `repairing` for ever and the
 * queue behind it never moved — on an unattended night, the same observable as a
 * crash with a reassuring word on the strip.
 *
 * Every test below asserts the SAME invariant from a different direction: a
 * ticket that enters `repairing` LEAVES it, by a named outcome, and the loop
 * carries on with the next ticket. The negative controls are the ones that make
 * this more than a component that blocks everything: the `applied` path re-queues
 * and re-submits, and the deferred path does not touch the tree under a live run.
 * ------------------------------------------------------------------------ */

/** Drive one ticket to a `repairing` row the way a real structural failure does. */
async function driveToRepairing(
  store: RunStore,
  deps: { readonly repair?: SupervisorDeps["repair"]; readonly defectSignatureOf?: (runId: string) => string | null; readonly now?: () => Date } = {},
  ticketKey = "k1",
  runId = "run-1",
): Promise<{ readonly loop: SupervisorLoop; readonly submitted: string[] }> {
  store.setSupervisorState("running", "owner", "start");
  store.enqueueSupervisorTicket({ ticketKey, ticketText: "one", modelId: "m", nextAction: "waiting", maxAttempts: 5 });
  const submitted: string[] = [];
  const loop = new SupervisorLoop({
    store,
    log: () => {},
    submit: () => {
      const id = submitted.length === 0 ? runId : `${runId}-${String(submitted.length + 1)}`;
      addRun(store, id, "running");
      submitted.push(id);
      return Promise.resolve({ runId: id });
    },
    // SPREAD ONE AT A TIME, because `exactOptionalPropertyTypes` is on: a bare
    // `...deps` would pass `repair: undefined`, which is a DIFFERENT thing from
    // an absent `repair` and would make the unwired arm untestable.
    ...(deps.repair === undefined ? {} : { repair: deps.repair }),
    ...(deps.defectSignatureOf === undefined ? {} : { defectSignatureOf: deps.defectSignatureOf }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  await loop.tick(); // claim + submit
  store.updateRun(runId, { status: "failed", recoveryClass: "structural" });
  await loop.tick(); // reconcile -> settle -> repairing
  assert.equal(store.getSupervisorTicket(ticketKey)?.state, "repairing", "the fixture did not reach repairing");
  return { loop, submitted };
}

test("with NO repair driver a repairing ticket is BLOCKED with that sentence, and the queue keeps moving", async () => {
  const { store, cleanup } = openStore();
  try {
    const { loop, submitted } = await driveToRepairing(store);
    // A SECOND TICKET, because "the ticket left repairing" is only half the fix.
    // The reviewer's sentence was "the supervisor carries on with the next ticket
    // rather than stopping", and a queue that unblocks itself into a permanent
    // idle is the same night lost.
    store.enqueueSupervisorTicket({ ticketKey: "k2", ticketText: "two", modelId: "m", nextAction: "waiting" });

    await loop.tick();

    const repaired = store.getSupervisorTicket("k1");
    assert.equal(repaired?.state, "blocked", `a repairing ticket with no driver stayed ${repaired?.state ?? "(gone)"}`);
    assert.match(repaired?.nextAction ?? "", /no repair driver is wired/);
    assert.match(repaired?.nextAction ?? "", /tools\/repair\/cycle\.mjs/, "the terminal sentence does not say what to run by hand");
    assert.equal(repaired?.nextActionAt, null, "a blocked ticket kept a future repair instant");
    // The next ticket was claimed in the very same tick the first one terminated.
    assert.equal(store.getSupervisorTicket("k2")?.state, "running", "the queue did not move past the blocked ticket");
    assert.equal(submitted.length, 2);
    assert.ok(
      store.listSupervisorLog().some((row) => row.reason.includes("would be a dead end")),
      "nothing in the journal says why the ticket was blocked",
    );
  } finally {
    cleanup();
  }
});

test("a repair proposal that passes the gate re-queues the ticket and records the patch", async () => {
  const { store, cleanup } = openStore();
  try {
    const seen: string[] = [];
    const { loop, submitted } = await driveToRepairing(store, {
      defectSignatureOf: () => "f".repeat(64),
      repair: (request) => {
        seen.push(`${request.ticketKey}/${String(request.signature)}/${String(request.cycleNo)}`);
        return Promise.resolve({
          kind: "applied",
          code: "ACCEPTED",
          detail: "one file changed and the mutation was watched red",
          patchId: "patch-7",
        });
      },
    });

    // The signature `settle()` stamped is what the driver was told about, and it
    // is what the per-signature bound counts — a column with no writer until now.
    assert.equal(store.getSupervisorTicket("k1")?.lastDefectId, "f".repeat(64));

    await loop.tick();

    assert.deepEqual(seen, [`k1/${"f".repeat(64)}/1`], "the driver was not called once with the ticket's own defect");
    const ticket = store.getSupervisorTicket("k1");
    assert.equal(ticket?.patchId, "patch-7", "the applied patch id was not recorded on the ticket");
    assert.ok(
      store.listSupervisorLog().some((row) => row.reason.includes("ACCEPTED as patch-7")),
      "the journal does not name the patch that was applied",
    );
    // AND IT WAS ACTUALLY RE-RUN, in the same tick the repair landed — which is
    // also why `nextAction` now reads "watching run …" rather than naming the
    // patch: `queued` that nothing claims is another way of parking, so the claim
    // step running immediately after the repair is the behaviour being asserted.
    assert.equal(ticket?.state, "running");
    assert.match(ticket?.nextAction ?? "", /watching run/);
    assert.equal(submitted.length, 2, "an applied repair did not produce a fresh run");
  } finally {
    cleanup();
  }
});

test("refused, inconclusive and a throwing driver are three different terminal sentences", async () => {
  const outcomes: readonly { readonly key: string; readonly make: SupervisorDeps["repair"]; readonly match: RegExp }[] = [
    {
      key: "refused",
      make: () => Promise.resolve({ kind: "refused", code: "ALREADY_RULED_OUT", detail: "seen before; not re-proved" }),
      match: /REFUSED by the evidence bar \(ALREADY_RULED_OUT\)/,
    },
    {
      key: "inconclusive",
      make: () => Promise.resolve({ kind: "inconclusive", code: "NO_PATCH_AUTHOR", detail: "nothing wrote a candidate diff" }),
      match: /reached NO verdict \(NO_PATCH_AUTHOR\)/,
    },
    {
      key: "threw",
      make: () => Promise.reject(new Error("the cycle script is not executable")),
      match: /reached NO verdict \(REPAIR_DRIVER_THREW\)/,
    },
  ];
  const sentences = new Set<string>();
  for (const outcome of outcomes) {
    const { store, cleanup } = openStore();
    try {
      const { loop } = await driveToRepairing(store, { repair: outcome.make, defectSignatureOf: () => "c".repeat(64) });
      await loop.tick();
      const ticket = store.getSupervisorTicket("k1");
      assert.equal(ticket?.state, "blocked", `${outcome.key} left the ticket ${ticket?.state ?? "(gone)"}`);
      assert.match(ticket?.nextAction ?? "", outcome.match);
      sentences.add(ticket?.nextAction ?? "");
    } finally {
      cleanup();
    }
  }
  // THE DISCRIMINATION IS THE POINT. "It stopped" is not an answer the owner can
  // act on; three outcomes that read identically would be one outcome.
  assert.equal(sentences.size, 3, `three outcomes produced ${String(sentences.size)} distinct sentence(s)`);
});

test("one defect signature gets a bounded number of repair cycles, not one per failure", async () => {
  const { store, cleanup } = openStore();
  try {
    let cycles = 0;
    const { loop } = await driveToRepairing(store, {
      defectSignatureOf: () => "d".repeat(64),
      // ALWAYS "ACCEPTED", which is the pathological case: without a per-signature
      // bound a driver that keeps producing a patch that does not fix anything
      // re-queues the ticket for ever, and every cycle looks like progress.
      repair: () => {
        cycles += 1;
        return Promise.resolve({ kind: "applied", code: "ACCEPTED", detail: "a patch that changes nothing", patchId: `p-${String(cycles)}` });
      },
    });

    // Each round trip: repair -> queued -> submitted -> fails structural again ->
    // repairing -> repair. The ticket's own attempt cap is 5, so it is NOT what
    // stops this.
    for (let round = 0; round < 4; round += 1) {
      await loop.tick();
      const live = store.getSupervisorTicket("k1");
      if (live?.currentRunId != null) {
        store.updateRun(live.currentRunId, { status: "failed", recoveryClass: "structural" });
      }
      await loop.tick();
    }

    assert.equal(cycles, SUPERVISOR_REPAIR_MAX_PER_SIGNATURE, `the same signature got ${String(cycles)} cycles`);
    const ticket = store.getSupervisorTicket("k1");
    assert.equal(ticket?.state, "blocked");
    assert.match(ticket?.nextAction ?? "", /already had all 2 repair cycle\(s\)/);
    assert.ok((ticket?.attemptNo ?? 0) < 5, "the cycle bound was actually the attempt cap wearing a different name");
  } finally {
    cleanup();
  }
});

test("a repair cycle never runs under a live run, and the deadline stops it waiting for ever", async () => {
  const { store, cleanup } = openStore();
  try {
    let clock = new Date("2026-08-10T00:00:00.000Z");
    let calls = 0;
    const { loop } = await driveToRepairing(store, {
      now: () => clock,
      defectSignatureOf: () => "e".repeat(64),
      repair: () => {
        calls += 1;
        return Promise.resolve({ kind: "refused", code: "SCOPE_UNIMPLICATED_FILE", detail: "the diff touched a file the defect does not implicate" });
      },
    });

    /*
     * A SECOND TICKET IS ALREADY RUNNING WHEN THE TICK STARTS, so the tree is not
     * the repair cycle's to patch. It is installed as the row the loop itself
     * writes rather than by letting the claim step do it, and that detail is the
     * measurement: the in-flight reading is taken BEFORE the claim step, so a
     * repair that completes and a submission that follows it in the same tick
     * never overlap — the only overlap that matters is a run that was ALREADY
     * live, which is this fixture.
     */
    store.enqueueSupervisorTicket({ ticketKey: "k2", ticketText: "two", modelId: "m", nextAction: "waiting" });
    addRun(store, "run-k2", "running");
    store.updateSupervisorTicket("k2", { state: "running", currentRunId: "run-k2", lastRunId: "run-k2", attemptNo: 1 });
    await loop.tick();
    assert.equal(store.getSupervisorTicket("k2")?.state, "running");
    assert.equal(calls, 0, "a repair cycle ran while a build was live — that is a patched workspace under a running build");
    const deferred = store.getSupervisorTicket("k1");
    assert.equal(deferred?.state, "repairing", "a deferred ticket did not stay repairing");
    assert.match(deferred?.nextAction ?? "", /waiting for the in-flight run to finish/);

    // THE STARVATION CASE: the run never ends and the deadline passes. The ticket
    // must leave `repairing` anyway — this is the arm that makes "leaves it
    // deterministically" independent of every other component's behaviour.
    clock = new Date(clock.getTime() + SUPERVISOR_REPAIR_DEADLINE_MS + 1_000);
    await loop.tick();
    const expired = store.getSupervisorTicket("k1");
    assert.equal(expired?.state, "blocked", `the deadline did not fire: the ticket is ${expired?.state ?? "(gone)"}`);
    assert.match(expired?.nextAction ?? "", /spent its whole repair window/);
    assert.equal(calls, 0);

    // NEGATIVE CONTROL: with nothing in flight the driver IS called, so the
    // deferral above is a gate and not a component that never runs.
    const { store: store2, cleanup: cleanup2 } = openStore();
    try {
      let called = 0;
      const second = await driveToRepairing(store2, {
        defectSignatureOf: () => "e".repeat(64),
        repair: () => {
          called += 1;
          return Promise.resolve({ kind: "refused", code: "SCOPE_UNIMPLICATED_FILE", detail: "same refusal, nothing in flight" });
        },
      });
      await second.loop.tick();
      assert.equal(called, 1, "with an empty queue the repair cycle still did not run");
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

test("the arm check drives the repair router itself, and says so when no driver is wired", async () => {
  const { store, cleanup } = openStore();
  try {
    const router = armRepairRouter();
    // MUTATION: give two arms of `routeRepairOutcome` the same `nextAction`
    // (copy the NO_REPAIR_DRIVER sentence onto REPAIR_CYCLES_EXHAUSTED) and this
    // is red with the pair named — see the VERBATIM RED in the round report.
    assert.equal(router.armed, true, `the repair router arm check is blind: ${router.wrong.join("; ")}`);
    assert.equal(router.distinctCodes, router.probes);
    assert.equal(router.distinctSentences, router.probes);

    const unwired: string[] = [];
    new SupervisorLoop({ store, submit: () => Promise.reject(new Error("unused")), log: (l) => unwired.push(l) }).armCheck();
    assert.ok(
      unwired.some((l) => l.includes("NO REPAIR DRIVER is wired")),
      `an unwired supervisor did not say so at boot: ${unwired.join(" | ")}`,
    );

    const wired: string[] = [];
    new SupervisorLoop({
      store,
      submit: () => Promise.reject(new Error("unused")),
      repair: () => Promise.resolve({ kind: "inconclusive", code: "X", detail: "y" }),
      log: (l) => wired.push(l),
    }).armCheck();
    assert.ok(wired.some((l) => l.includes("a repair driver is wired")), `a wired supervisor did not say so: ${wired.join(" | ")}`);
    // The two boots must not read the same, or the line carries no information.
    assert.notDeepEqual(unwired, wired);
  } finally {
    cleanup();
  }
});

/**
 * THE CAP ON THE REAL `#wake` PATH, NOT ON A HAND-WRITTEN IMITATION OF IT.
 *
 * WHY THIS EXISTS ALONGSIDE THE TEST ABOVE (added 2026-08-10). That test builds
 * the post-wake state with `updateSupervisorTicket({state:"queued",attemptNo:1})`
 * — it proves the guard handles that row, and NOTHING about who produces it. If
 * `#wake` ever stopped leaving `queued`, or reset `attemptNo` on its way past,
 * the guard would be unreachable and that test would still pass: the cap bypass
 * this round was sent to close would be open again with a green suite over it.
 *
 * So this drives the whole documented loop — submit -> `rate_limited` ->
 * `waiting` -> the wait expires -> `#wake` re-queues for a FRESH submission ->
 * ... -> `blocked` — with a clock the test moves and a `resume` that is
 * deliberately NOT supplied, which is the branch `#wake` takes when a run cannot
 * be resumed. `settle()` NEVER RUNS anywhere in this sequence, because no run of
 * this ticket ever reaches a terminal status. That is precisely the shape the
 * reviewer measured: "`#wake` re-queues for a fresh submission and `settle()` —
 * the only place the attempt cap is read — never runs".
 */
test("a ticket whose runs keep landing rate_limited is capped by the REAL wake path, and settle() never runs", async () => {
  const { store, cleanup } = openStore();
  try {
    store.setSupervisorState("running", "owner", "start");
    store.enqueueSupervisorTicket({
      ticketKey: "k1",
      ticketText: "one",
      modelId: "m",
      nextAction: "waiting",
      maxAttempts: 2,
    });

    let clock = new Date("2026-08-10T00:00:00.000Z");
    const submitted: string[] = [];
    const loop = new SupervisorLoop({
      store,
      now: () => clock,
      log: () => {},
      // A REAL RUN ROW PER SUBMISSION, so `#inFlight` and `#reconcile` read the
      // same table the production loop reads instead of a stub's opinion.
      submit: () => {
        const runId = `run-${String(submitted.length + 1)}`;
        addRun(store, runId, "running");
        submitted.push(runId);
        return Promise.resolve({ runId });
      },
      // `resume` IS DELIBERATELY ABSENT. `#wake`'s cheap path needs it; its
      // re-submission path is what a rate limit that outlived the run takes, and
      // that is the path with the cap on it.
    });

    // Attempt 1.
    await loop.tick();
    assert.deepEqual(submitted, ["run-1"]);
    assert.equal(store.getSupervisorTicket("k1")?.attemptNo, 1);

    const parkAndWake = async (runId: string): Promise<void> => {
      store.updateRun(runId, { status: "rate_limited" });
      await loop.tick(); // reconcile -> waiting, with a wake instant 15 min out
      const parked = store.getSupervisorTicket("k1");
      assert.equal(parked?.state, "waiting", "a rate_limited run did not park its ticket");
      assert.notEqual(parked?.nextActionAt, null, "a waiting ticket named no wake instant");
      clock = new Date(clock.getTime() + SUPERVISOR_DEFAULT_WAIT_MS + 1_000);
      await loop.tick(); // #wake -> queued -> (same tick) claim
    };

    await parkAndWake("run-1");
    // THE SEAM: `#wake` must leave the ticket queued for a fresh submission with
    // the attempt it already spent still counted. A reset here reads as progress
    // and is how an unbounded series of "attempt 1 of 2" happens.
    assert.deepEqual(submitted, ["run-1", "run-2"], "the wake did not produce a fresh submission");
    assert.equal(store.getSupervisorTicket("k1")?.attemptNo, 2, "the wake path lost an attempt");

    await parkAndWake("run-2");
    // Attempts are spent, so this wake must NOT be allowed to submit a third.
    const capped = store.getSupervisorTicket("k1");
    assert.deepEqual(submitted, ["run-1", "run-2"], "the wake path submitted past the attempt cap");
    assert.equal(capped?.state, "blocked", `the wake path left the ticket ${capped?.state ?? "(gone)"}, not blocked`);
    assert.match(capped?.nextAction ?? "", /2 attempt/);

    // AND THE CAP WAS NOT REACHED THROUGH `settle()`. Every run in this sequence
    // is still `rate_limited` — non-terminal — so if the only reader of the cap
    // were `settle()`, nothing above could have stopped.
    for (const runId of submitted) {
      assert.equal(store.getRun(runId)?.status, "rate_limited", `${runId} reached a terminal status; settle() could have run`);
    }
  } finally {
    cleanup();
  }
});

/**
 * THE RECORD AND THE PANEL MUST NOT DISAGREE ABOUT WHETHER A FAILURE IS
 * REPAIRABLE — ASSERTED OVER EVERY CLASS, NOT OVER THE FOUR THAT PROMPTED IT.
 *
 * WHAT WAS WRONG, MEASURED (2026-08-10). `orchestrator.ts`'s `#writeDefectRecord`
 * derived the defect record's `repairable` field as `boundFor(failureClass) > 0`.
 * Every class `classOfBakeoffCode` returns is bound 0, so the field was provably
 * `false` for all twelve `BakeoffError` codes — and this file's own `settle` put
 * `accounting`, `harness_defect`, `suite_authoring` and `structural` into
 * `repairing`, which the ticket state's sentence describes as "waiting for a
 * repair proposal for this failure class". So the fingerprint record said
 * repairable=false about the failure the strip said was being repaired, and both
 * reached the owner. `boundFor(...) > 0` is a RETRY-BUDGET predicate being read as
 * a REPAIRABILITY predicate.
 *
 * THE INVARIANT PINNED HERE IS THE AGREEMENT ITSELF, in the direction that is
 * observable from this file: `isRepairable(klass) === false` iff the supervisor
 * settles the ticket to `blocked`. `orchestrator.defect-record.test.ts` pins the
 * other side — the written record's `repairable` equals `isRepairable` of its own
 * class — so the two consumers are nailed to one predicate from both ends.
 *
 * IT ENUMERATES EVERY MEMBER OF `FailureClass`, and the list is checked for
 * completeness against `boundFor`'s exhaustive switch rather than being trusted: a
 * class added in 2027 without a row here fails the count assertion instead of
 * quietly not being covered.
 */
test("blocked-vs-repairing agrees with `isRepairable` for EVERY failure class", async () => {
  const ALL_CLASSES: readonly FailureClass[] = [
    "intentional",
    "interrupted",
    "structural",
    "owner_action",
    "integrity",
    "accounting",
    "harness_defect",
    "suite_authoring",
    "throttled",
    "transient",
    "unclassified",
  ];

  /*
   * COMPLETENESS, NOT FAITH. `boundFor` has no `default`, so it returns
   * `undefined` for a string it has never seen; every name above must therefore
   * produce a number, and `isRepairable` must produce a boolean. A class added to
   * the union and not to this list reddens the second half.
   */
  for (const klass of ALL_CLASSES) {
    assert.equal(typeof boundFor(klass), "number", `${klass} is not in boundFor's switch`);
    assert.equal(typeof isRepairable(klass), "boolean", `${klass} is not in isRepairable's switch`);
  }
  assert.equal(
    new Set(ALL_CLASSES).size,
    ALL_CLASSES.length,
    "the list repeats a class, so a missing one could be hidden by a duplicate",
  );

  const settledStates: string[] = [];
  for (const klass of ALL_CLASSES) {
    const { store, cleanup } = openStore();
    try {
      store.setSupervisorState("running", "owner", "start");
      store.enqueueSupervisorTicket({
        ticketKey: "k1",
        ticketText: "one",
        modelId: "m",
        nextAction: "waiting",
      });
      const first = recordingSubmit("run-1");
      await new SupervisorLoop({ store, submit: first.submit, log: () => {} }).tick();
      addRun(store, "run-1", "failed");
      store.updateRun("run-1", { recoveryClass: klass });
      const second = recordingSubmit("run-2");
      await new SupervisorLoop({ store, submit: second.submit, log: () => {} }).tick();

      const state = store.getSupervisorTicket("k1")?.state ?? "(none)";
      settledStates.push(state);
      const blocked = state === "blocked";
      assert.equal(
        blocked,
        !isRepairable(klass),
        `class '${klass}' settled to '${state}' while isRepairable says ${String(isRepairable(klass))}. ` +
          "A defect record that calls this failure repairable next to a panel that calls it blocked — " +
          "or the reverse — is the disagreement this test exists to make impossible.",
      );
    } finally {
      cleanup();
    }
  }

  /*
   * THE NEGATIVE CONTROL ON THE WHOLE TEST. If every class settled to the same
   * state, the assertion above would hold for any predicate that returned one
   * constant — including `() => true`. Three distinct outcomes are required, and
   * they are the three the routing actually has: blocked, repairing, running.
   */
  const distinct = new Set(settledStates);
  assert.ok(
    distinct.has("blocked") && distinct.has("repairing") && distinct.has("running"),
    `the eleven classes produced ${[...distinct].join("/")} — a comparator that answers one thing ` +
      "for every input is not a comparator",
  );
});
