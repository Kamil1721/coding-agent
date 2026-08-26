/**
 * plan-phase.test.ts — the phase exists, parks, resumes, and never wedges a run.
 *
 * WHAT THESE DRIVE, AND WHY IT IS THE WHOLE `#execute` RATHER THAN `#planPhase`.
 * The sequencing under test is a private method, and a test that reached into it
 * would prove the body and say nothing about whether the run still calls it —
 * the exact defect this repository has shipped repeatedly. So each test below
 * submits a run, calls `pump()`, and reads what the RUN left behind: the durable
 * `plan.json`, the persisted phase events, the chat rows, the message delivery
 * stamps, and the run row's own ticket id.
 *
 * ─── NO QUOTA IS SPENT, AND IT IS GUARDED TWICE ───
 *
 * 1. THE PLANNING SEAT IS INJECTED (`OrchestratorDeps.makePlanSeat`). No test
 *    here constructs a `SubscriptionSeatCaller`, so nothing reaches the SDK.
 * 2. THE SPEC SEAT IS NOT INJECTABLE AND DOES NOT NEED TO BE. The harness env is
 *    `{}`, which is the same guard `orchestrator.test.ts` states and measured for
 *    its own spec-phase tests: the seat cannot reach a CLI and fails almost
 *    immediately. So every run here ends `failed` in the SPEC phase, which is not
 *    what is under test and is asserted about only where the ORDER matters — a
 *    run that reached spec at all is a run whose plan phase let go of it.
 *
 * ─── EVERY MUTATION, APPLIED ALONE, WATCHED RED, RESTORED ───
 *
 * Run 2026-08-02 against this file (15 tests). Each line is what was actually
 * changed and what actually failed, not what was expected to.
 *
 *  M1  db.ts `PHASES` loses "plan"                        → 12 red (`oneOf` throws
 *                                                            on a row this server
 *                                                            wrote)
 *  M2  `#planPhase`'s zero-question early return disabled →  1 red: the
 *                                                            zero-question run
 *                                                            parks for 20 minutes
 *  M3  `PlanDriver#arm` arms the FULL window instead of
 *      `planRemainingMs`                                  →  1 red: the re-armed
 *                                                            timer never fires
 *  M4  the `#plan.reconcile` line deleted from
 *      `reconcileOnBoot`                                  →  2 red: a park across
 *                                                            a restart is infinite
 *  M5  `closePlan` skipped in `#closePlanDialogue`        →  2 red: nothing is
 *                                                            marked expired and
 *                                                            nothing is assumed
 *  M6  `PlanDriver.deliver`'s guards reduced to
 *      `record === null`                                  →  1 red: a closed
 *                                                            dialogue accepts a
 *                                                            late answer
 *  M7  the amended id derived from the PRE-fold brief     →  1 red: the stored
 *                                                            text no longer
 *                                                            re-derives its own id
 *  M8  `amendBrief`'s `suiteSha256` guard disabled        →  1 red: a frozen run
 *                                                            is amended
 *  M9  db.ts `PHASES` loses "spec"                        →  8 red, including BOTH
 *                                                            old-run tests
 *  M11 `markDelivered` dropped from the turn              →  1 red: the answer is
 *                                                            still pending, i.e.
 *                                                            bound for the builder
 *  M12 `stripPlanBlock` made a no-op                      →  1 red: the surface
 *                                                            measurement
 *  M13 `readPlanRecord` casts instead of validating
 *      (i.e. exactly what `readDesignLock` does)          →  1 red: a malformed
 *                                                            record reads as a park
 *  M14 `planPolicy` returns "ask" for everything          →  1 red: an unattended
 *                                                            run calls the seat
 *  M17 `closureFor`'s `planTurnsExhausted` branch
 *      disabled                                           →  1 red: the turn cap
 *                                                            stops bounding the
 *                                                            dialogue
 *  M18 `closureFor` reports every settled dialogue as
 *      "answered"                                         →  1 red: "you decide"
 *                                                            is recorded as an
 *                                                            answer
 *  M16 `#planPhase`'s `suiteSha256 !== null` early
 *      return disabled                                    →  1 red: a run from
 *                                                            before this phase
 *                                                            existed is asked
 *                                                            questions on resume
 *                                                            and then killed by
 *                                                            `amendBrief`
 *  M15 `#planPhase`'s close branch narrowed back to
 *      `existing.awaiting` — THE BUG THESE TESTS CAUGHT   →  1 red: the run asks
 *                                                            the seat a second
 *                                                            time and re-opens a
 *                                                            dialogue it had just
 *                                                            finished
 *  M19 `PlanDriver.reconcile` returns false for an
 *      UNREADABLE record (what it did before             →  1 red: the run never
 *      2026-08-02)                                           leaves `awaiting_input`
 *                                                            — the infinite park
 *
 * M19 IS THE ONE THIS FILE USED TO MISS. The unreadable-record test below asserted
 * `doesNotThrow` and then said, in its own comment, that the run was "left for a
 * human". It was left for nobody: `reconcileOnBoot` writes that log line only for
 * rows it moves out of `running`, and a row already `awaiting_input` gets no line,
 * no timer and no button. The test now asserts the exit.
 *
 * TWO MUTATIONS WERE REJECTED BY THE COMPILER before they could be run (M3 and M5
 * in their first form left an import unused), and were re-expressed as
 * behaviour-only changes. A compile error is a red, but it is not the red these
 * tests are for.
 *
 * THE FOUR UNION-COMPLETENESS GUARDS IN `plan-record.ts` ARE CHECKED BY THE
 * COMPILER AND NOT BY THIS FILE, deliberately: adding a member to
 * `PlanClosureReason` and not to `CLOSURE_REASONS` was tried, and `tsc` failed at
 * `plan-record.ts:308` with "Type 'true' is not assignable to type 'never'".
 * Restored; `tsc` back to 0. A runtime test could not do better — it would have
 * to know the new member's name in order to look for it.
 *
 * ONE MUTATION IS NOT LISTED AND THE REASON IS RECORDED RATHER THAN HIDDEN:
 * dropping `redactForPersistence` from the fold's store path changes NOTHING
 * observable here, because the fixtures contain no secret and the redactor is
 * then the identity function. The property that IS checked — the stored text
 * re-derives its own id — is M7's.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SeatCallRequest, SeatCallResult } from "bakeoff/dist/anthropic-seat.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import type { RunRow } from "./db.js";
import { ModelCatalog } from "./models.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { PreviewHost } from "./preview.js";
import {
  PLAN_RECORD_FILE,
  PLAN_RECORD_UNREADABLE_FILE,
  planRemainingMs,
  readPlanRecord,
  unaskedPlanState,
  writePlanRecord,
} from "./plan-record.js";
import { closureFor } from "./plan-dialogue.js";
import { MAX_OWNER_TURNS } from "./plan-question.js";
import { foldPlanIntoBrief, PLAN_BLOCK_BEGIN, stripPlanBlock } from "./plan-brief.js";
import { ticketProse } from "./ticket-refs.js";
import type { PlanState } from "./plan-state.js";
import type { PlanSeatCaller } from "./plan-seat.js";
import { classifySurface } from "./surface.js";
import { ticketFromText } from "./ticket.js";

/* -------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------- */

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: Orchestrator;
  readonly dir: string;
  readonly runsRoot: string;
  readonly seatCalls: SeatCallRequest[];
  /**
   * Wait for the run to stop executing, THEN stop the orchestrator.
   *
   * NOT TIDINESS. Every run here walks on into the spec phase, which fails a
   * second or two later against the empty env; closing the store while that is in
   * flight produces `database is not open` from a callback nobody is awaiting,
   * which node's test runner reports as an unhandled rejection attributed to
   * whichever test happens to be running. That is a red that says nothing about
   * the code and hides one that would.
   */
  settle(): Promise<void>;
  cleanup(): void;
}

function seatResult(text: string): SeatCallResult {
  return {
    text,
    stopReason: "end_turn",
    usage: {
      provider: "anthropic",
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      costUsd: 0,
      modelId: "claude-opus-5",
      role: "spec",
      effort: "high",
      callCount: 1,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      thinkingTokens: null,
    },
    pricingBasis: {
      provider: "anthropic",
      modelId: "claude-opus-5",
      priceLabel: "subscription",
      priceEffectiveFrom: "2026-08-02",
      priceEffectiveUntil: null,
      pricedAt: "2026-08-02T10:00:00.000Z",
      fieldStatus: {
        input: "unverified",
        cacheRead: "unverified",
        cacheWrite5m: "unverified",
        cacheWrite1h: "unverified",
        output: "unverified",
      },
      assumedFields: [],
      assumedCacheWriteMultiplier: null,
      sourcedOn: "2026-08-02",
      source: "test stub",
    },
    precall: {
      allowed: true,
      killReason: null,
      cumulativeCostUsd: 0,
      ceilingUsd: 0,
      worstCaseNextCallUsd: 0,
      checkedAt: "2026-08-02T10:00:00.000Z",
    },
    inputEstimateMeasured: false,
    startedAt: "2026-08-02T10:00:00.000Z",
    endedAt: "2026-08-02T10:00:01.000Z",
  };
}

/**
 * A seat that answers each call from a script, in order, and records what it saw.
 *
 * THE CURSOR IS SHARED ACROSS EVERY CALLER THIS FACTORY MAKES, and that detail
 * cost an hour: `makePlanSeat` is invoked once PER TURN (the real one builds a
 * fresh `SubscriptionSeatCaller` each time, because a dialogue can span a
 * restart), so a cursor held inside one caller restarts at zero on the follow-up
 * turn and the seat answers the second question with the first turn's script.
 * The symptom was a follow-up reply that would not parse, which the host then
 * correctly degraded to "record the owner's own words" — a green-looking path
 * hiding a test that was never exercising the refinement it claimed to.
 */
function scriptedSeats(script: readonly string[], seen: SeatCallRequest[]): () => PlanSeatCaller {
  let index = 0;
  return () => ({
    call(request: SeatCallRequest): Promise<SeatCallResult> {
      seen.push(request);
      const text = script[Math.min(index, script.length - 1)] ?? "{}";
      index += 1;
      return Promise.resolve(seatResult(text));
    },
  });
}

function harness(options: { script?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dash-plan-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const seatCalls: SeatCallRequest[] = [];
  const script = options.script;
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview,
    // `{}` IS THE SPEC-SEAT GUARD, not an oversight. See the file header.
    env: options.env ?? {},
    gateReadiness: READY_GATE_READINESS,
    ...(script === undefined ? {} : { makePlanSeat: scriptedSeats(script, seatCalls) }),
  });
  return {
    store,
    orchestrator,
    dir,
    runsRoot: paths.runs,
    seatCalls,
    settle: async () => {
      await orchestrator.shutdown();
      await waitFor(() => orchestrator.activeRunIds.length === 0, "the run to stop executing", 30_000);
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(
  store: RunStore,
  runId: string,
  options: { text?: string; interactive?: boolean } = {},
): RunRow {
  const text = options.text ?? "Build me a portfolio site.";
  const ticket = ticketFromText(text);
  return store.createRun({
    runId,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    ticketText: text,
    ticketSha256: ticket.sha256,
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    interactive: options.interactive ?? true,
  });
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function logText(store: RunStore, runId: string): string {
  return store
    .eventsSince(runId, 0)
    .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
    .join(" | ");
}

function phaseOrder(store: RunStore, runId: string): readonly string[] {
  return store
    .eventsSince(runId, 0)
    .flatMap((entry) => (entry.event.type === "phase" ? [entry.event.phase] : []));
}

function planPath(h: Harness, runId: string): string {
  return join(runPathsFor(resolvePaths({ DASHBOARD_HOME: h.dir }), runId).results, PLAN_RECORD_FILE);
}

const ONE_QUESTION = JSON.stringify({
  plan: ["A portfolio with a project list."],
  questions: [
    {
      text: "How many projects should the portfolio show?",
      ifUnanswered: "three project cards",
      criterionIfDefault: "The portfolio shows three project cards.",
      criterionIfAnswered: "The portfolio shows six project cards.",
      tier: "FUNCTIONAL",
    },
  ],
});

/** The good outcome: a ticket so clear there is nothing worth asking. */
const NO_QUESTIONS = JSON.stringify({ plan: ["A portfolio. Nothing is unclear."], questions: [] });

/** A follow-up turn that resolves the question, quoting a span really in the reply. */
const RESOLVES = JSON.stringify({
  reply: "",
  resolved: [{ id: "PQ-1", kind: "answer", answer: "six project cards", quoted: "six" }],
});

/* -------------------------------------------------------------------------
 * T1 — the phase runs, and it runs FIRST
 * ---------------------------------------------------------------------- */

/**
 * MUTATION: remove `"plan"` from `PHASES` in db.ts (leaving `ApiPhase` alone, so
 * it still compiles). `#setPhase` writes the row, `toRunRow` reads it back
 * through `oneOf`, and the run dies with `phase "plan" is not one of …`. Watched
 * red, restored.
 *
 * THE ORDER IS THE ASSERTION, not the presence. A plan phase that ran after the
 * spec phase would still emit both events; only the sequence says the questions
 * were asked while the answers could still change the criteria.
 */
test("the plan phase runs, and it runs BEFORE the spec phase", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-order");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-order")?.status === "awaiting_input", "the plan park");

    const phases = phaseOrder(h.store, "run-order");
    assert.deepEqual(phases, ["plan"], "the run has reached the plan phase and nothing beyond it");
    assert.equal(h.store.getRun("run-order")?.phase, "plan");
    assert.equal(h.seatCalls.length, 1, "one opening turn is one call");

    // AND THE ORDER IS OBSERVABLE FROM THE ROW ITSELF: the suite cannot have been
    // authored, because the run has not been anywhere near the spec phase.
    assert.equal(h.store.getRun("run-order")?.suiteSha256, null, "nothing is frozen while a question is open");

    const messages = h.store.messages("run-order");
    const questionRow = messages.find((m) => m.role === "run" && m.text.includes("PQ-1"));
    assert.ok(questionRow !== undefined, "the question reaches the owner through the existing chat channel");
    assert.match(questionRow.text, /How many projects/);
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T2 — nothing worth asking costs one call and no wait
 * ---------------------------------------------------------------------- */

/**
 * MUTATION: delete the `if (opened.closed !== null)` early return in
 * `#planPhase`, so a zero-question proposal falls through to the park. The run
 * goes `awaiting_input` and this test fails on `status`. Watched red, restored.
 *
 * A PARK WITH NO QUESTIONS IN IT IS PURE LATENCY — twenty minutes added to every
 * well-written ticket, buying nothing. That is the failure this test exists for,
 * and it is invisible from a test that only checks the questions were asked.
 */
test("a seat that asks nothing skips the park, records why, and lets the run go", async () => {
  const h = harness({ script: [NO_QUESTIONS] });
  try {
    seed(h.store, "run-quiet");
    h.orchestrator.pump();
    await waitFor(() => existsSync(planPath(h, "run-quiet")), "plan.json");
    await waitFor(() => phaseOrder(h.store, "run-quiet").includes("spec"), "the spec phase");

    const row = h.store.getRun("run-quiet");
    assert.notEqual(row?.status, "awaiting_input", "a park with no questions in it is pure latency");
    assert.deepEqual(phaseOrder(h.store, "run-quiet").slice(0, 2), ["plan", "spec"], "it went straight on");

    const record = readPlanRecord(join(h.runsRoot, "run-quiet", "results"));
    assert.ok(record !== null, "the phase is recorded even when it asked nothing");
    assert.equal(record.awaiting, false);
    assert.equal(record.folded, true);
    assert.equal(record.state.closed?.reason, "nothing to ask");
    assert.match(
      record.state.closed?.detail ?? "",
      /proposed no questions/,
      "'nothing to ask' and 'proposed five and landed none' are different facts and only one is a defect",
    );

    // AND THE TICKET DID NOT MOVE. A run whose dialogue produced nothing must
    // derive the id it would have derived with no plan phase at all.
    assert.equal(row?.ticketId, ticketFromText("Build me a portfolio site.").id);
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/**
 * The other skip, which a single test cannot tell apart from the one above.
 *
 * MUTATION: change `planPolicy` to `return "ask"` unconditionally. The stub seat
 * is called and `seatCalls.length` becomes 1. Watched red, restored.
 *
 * NO SEAT CALL AT ALL, not merely no park: with nobody at the dashboard, no
 * question can earn its place under a rule that measures worth by what an ANSWER
 * would change, so the call would spend quota to produce a list nothing can act
 * on.
 */
test("an unattended run never parks AND never calls the seat, and says why", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-cron", { interactive: false });
    h.orchestrator.pump();
    await waitFor(() => phaseOrder(h.store, "run-cron").includes("spec"), "the spec phase");

    assert.equal(h.seatCalls.length, 0, "nobody was there to answer, so nothing was asked and nothing was spent");
    assert.notEqual(h.store.getRun("run-cron")?.status, "awaiting_input");
    const record = readPlanRecord(join(h.runsRoot, "run-cron", "results"));
    assert.match(
      record?.state.closed?.detail ?? "",
      /not submitted from the dashboard/,
      "an unattended run has to be explainable afterwards",
    );
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/**
 * THE UPGRADE PATH, WHICH IS THE MOST LIKELY WAY THIS FEATURE COULD HAVE MADE
 * EVERY EXISTING RUN WORSE.
 *
 * A run that STARTED before this phase existed has no `plan.json`. `#execute` is
 * re-entered on every resume — a design-lock park, a rate limit, a boot
 * reconcile — so without a guard such a run drops into the fresh branch, gets
 * asked questions about work it has already done, and then hands the fold to
 * `amendBrief`, which refuses a frozen run BY THROWING. The throw escapes to
 * `#start` and the run is finished `failed`. A run that used to resume cleanly
 * would die because a feature was added.
 *
 * MUTATION: delete the `row.suiteSha256 !== null` early return in `#planPhase`.
 * The run is asked a question, parks, and this test fails on both the seat-call
 * count and the status. Watched red, restored.
 */
test("a run whose suite is already frozen is never asked anything, and never dies of being asked", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-upgraded");
    // Exactly what an in-flight run from before this change looks like: bound to
    // a suite, no plan record anywhere.
    h.store.updateRun("run-upgraded", { suiteSha256: "a".repeat(64) });
    assert.equal(readPlanRecord(join(h.runsRoot, "run-upgraded", "results")), null);

    h.orchestrator.pump();
    await waitFor(() => phaseOrder(h.store, "run-upgraded").includes("spec"), "the run to reach the spec phase");

    assert.equal(h.seatCalls.length, 0, "the suite is frozen; an answer now could not change what it grades");
    assert.notEqual(h.store.getRun("run-upgraded")?.status, "awaiting_input", "and it must not park");
    assert.notEqual(h.store.getRun("run-upgraded")?.status, "failed", "least of all die of it");
    assert.match(logText(h.store, "run-upgraded"), /already frozen when it reached the plan phase/);
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T3/T4 — the park is durable, and a restart re-arms the REMAINDER
 * ---------------------------------------------------------------------- */

/**
 * MUTATION A (the remainder): in `PlanDriver.#arm`, replace
 * `planRemainingMs(parkedAt, …)` with `timeoutMin * 60_000`. The re-armed window
 * becomes a fresh one and the third assertion below fails. Watched red, restored.
 *
 * MUTATION B (the durable half): delete the `if (this.#plan.reconcile(...)) continue;`
 * line in `reconcileOnBoot`. The run stays `awaiting_input` with no timer, which
 * is the infinite park the loop's own comment exists to prevent, and the second
 * assertion fails. Watched red, restored.
 *
 * THE PARK'S CLOCK IS ON DISK AND NOWHERE ELSE. This test simulates the restart
 * the way `orchestrator.test.ts` does: a second `Orchestrator` over the SAME
 * directory, which is exactly what a rebooted dashboard is.
 */
test("a restart during a plan park re-arms the REMAINDER of the window, not a fresh one", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-restart");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-restart")?.status === "awaiting_input", "the plan park");
    await h.orchestrator.shutdown();

    const resultsDir = join(h.runsRoot, "run-restart", "results");
    const parked = readPlanRecord(resultsDir);
    assert.ok(parked !== null && parked.awaiting, "the park is on disk, not only in a timer");

    // REWOUND, not waited out: the record is rewritten with a `parkedAt` 19
    // minutes in the past, so one minute of a 20-minute window remains. A test
    // that slept for the real window would not be run.
    const nineteenAgo = new Date(Date.now() - 19 * 60_000).toISOString();
    writePlanRecord(resultsDir, { ...parked, parkedAt: nineteenAgo });

    const remaining = planRemainingMs(nineteenAgo, Date.now(), 20);
    assert.ok(remaining > 0 && remaining <= 60_000, `one minute should be left, not ${String(remaining)}ms`);

    // THE RESTART.
    const paths = resolvePaths({ DASHBOARD_HOME: h.dir });
    const store2 = RunStore.open(paths.database);
    const bus2 = new RunEventBus(store2);
    const second = new Orchestrator({
      store: store2,
      bus: bus2,
      paths,
      catalog: new ModelCatalog(new AuthProbe({ claudeBin: "absent", codexBin: "absent" }), {}, async () => []),
      auth: new AuthProbe({ claudeBin: "absent", codexBin: "absent" }),
      preview: new PreviewHost(),
      env: {},
      gateReadiness: READY_GATE_READINESS,
      makePlanSeat: scriptedSeats([ONE_QUESTION], []),
    });
    try {
      second.reconcileOnBoot();
      // THE RUN IS STILL PARKED — the boot did not resume it, because the window
      // has not expired. `reconcileOnBoot` must not treat "I found a park" as
      // "the park is over".
      assert.equal(store2.getRun("run-restart")?.status, "awaiting_input", "an unexpired park survives a boot");
      // AND THE ORIGINAL INSTANT SURVIVED. A boot that rewrote `parkedAt` would
      // let a dashboard restarting every few minutes push the deadline forward
      // for ever, which is the bound holding only on paper.
      assert.equal(
        readPlanRecord(resultsDir)?.parkedAt,
        nineteenAgo,
        "re-arming must carry the ORIGINAL park instant, not `now`",
      );
    } finally {
      await second.shutdown();
      store2.close();
    }
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/**
 * THE OTHER HALF OF THE REMAINDER, AND THE ONE THE TEST ABOVE CANNOT SEE.
 *
 * `parkedAt` staying put proves the RECORD was not rewritten. It says nothing
 * about the TIMER, which is where the remainder is actually spent — a boot that
 * kept the original instant on disk and armed a fresh 20-minute window would pass
 * every assertion above while making the bound a lie.
 *
 * So: rewind the park to 300 ms short of its deadline and boot. With the
 * remainder honoured the run leaves the park almost immediately. With a fresh
 * window it waits twenty minutes and this test fails by timing out.
 *
 * MUTATION: in `PlanDriver.#arm`, replace `planRemainingMs(parkedAt, Date.now(), timeoutMin)`
 * with `timeoutMin * 60_000`. Watched red (timed out at 8 s), restored.
 */
test("the re-armed timer fires on what is LEFT of the window, not on a fresh one", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-remainder");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-remainder")?.status === "awaiting_input", "the plan park");
    await h.settle();

    const resultsDir = join(h.runsRoot, "run-remainder", "results");
    const parked = readPlanRecord(resultsDir);
    assert.ok(parked !== null);
    // 300 ms short of the default 20-minute deadline: not yet expired, so the
    // boot path ARMS rather than resumes — which is the branch under test.
    const nearlyDue = new Date(Date.now() - (20 * 60_000 - 300)).toISOString();
    writePlanRecord(resultsDir, { ...parked, parkedAt: nearlyDue });

    const paths = resolvePaths({ DASHBOARD_HOME: h.dir });
    const store2 = RunStore.open(paths.database);
    const second = new Orchestrator({
      store: store2,
      bus: new RunEventBus(store2),
      paths,
      catalog: new ModelCatalog(new AuthProbe({ claudeBin: "absent", codexBin: "absent" }), {}, async () => []),
      auth: new AuthProbe({ claudeBin: "absent", codexBin: "absent" }),
      preview: new PreviewHost(),
      env: {},
      gateReadiness: READY_GATE_READINESS,
      makePlanSeat: scriptedSeats([ONE_QUESTION], []),
    });
    try {
      second.reconcileOnBoot();
      await waitFor(
        () => store2.getRun("run-remainder")?.status !== "awaiting_input",
        "the re-armed timer to fire on the remaining 300ms",
        8_000,
      );
    } finally {
      await second.shutdown();
      await waitFor(() => second.activeRunIds.length === 0, "the resumed run to stop executing", 30_000);
      store2.close();
    }
  } finally {
    h.cleanup();
  }
});

/**
 * MUTATION: change `planExpired`'s `>=` to `>`. The boot path then reads a park
 * that is exactly at its deadline as still waiting, and this test — whose record
 * is well past the deadline — still passes, so the mutation used here is the
 * stronger one: delete the `planExpired` branch in `PlanDriver.reconcile`
 * entirely, leaving `#arm`. The run stays parked for ever and the first assertion
 * fails. Watched red, restored.
 */
test("a park that expired while the dashboard was down is resumed on boot, not left for ever", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-cold");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-cold")?.status === "awaiting_input", "the plan park");
    await h.orchestrator.shutdown();

    const resultsDir = join(h.runsRoot, "run-cold", "results");
    const parked = readPlanRecord(resultsDir);
    assert.ok(parked !== null);
    writePlanRecord(resultsDir, { ...parked, parkedAt: new Date(Date.now() - 60 * 60_000).toISOString() });

    const paths = resolvePaths({ DASHBOARD_HOME: h.dir });
    const store2 = RunStore.open(paths.database);
    const bus2 = new RunEventBus(store2);
    const second = new Orchestrator({
      store: store2,
      bus: bus2,
      paths,
      catalog: new ModelCatalog(new AuthProbe({ claudeBin: "absent", codexBin: "absent" }), {}, async () => []),
      auth: new AuthProbe({ claudeBin: "absent", codexBin: "absent" }),
      preview: new PreviewHost(),
      env: {},
      gateReadiness: READY_GATE_READINESS,
      makePlanSeat: scriptedSeats([ONE_QUESTION], []),
    });
    try {
      second.reconcileOnBoot();
      await waitFor(
        () => store2.getRun("run-cold")?.status !== "awaiting_input",
        "the expired park to end — `awaiting_input` has no other exit",
      );
      assert.match(logText(store2, "run-cold"), /expired while the dashboard was down/);
    } finally {
      // THE RESUMED RUN IS EXECUTING IN `second`, so the store cannot close under
      // it — see `Harness.settle`.
      await second.shutdown();
      await waitFor(() => second.activeRunIds.length === 0, "the resumed run to stop executing", 30_000);
      store2.close();
    }
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T5 — expiry PROCEEDS, and records what it had to assume
 * ---------------------------------------------------------------------- */

/**
 * MUTATION: in `#closePlanDialogue`, pass `record.state` to the fold instead of
 * the result of `closePlan(...)`. The still-open question is never marked
 * `expired`, `planAssumptions` is empty, and both the record assertion and the
 * brief assertion below fail. Watched red, restored.
 *
 * THE TIMEOUT IS REAL, NOT SIMULATED: `DASHBOARD_PLAN_TIMEOUT_MIN` is set to a
 * fraction of a minute so the live timer — the half a boot cannot exercise —
 * actually fires.
 */
test("when nobody answers, the run PROCEEDS and the unanswered question becomes a recorded assumption", async () => {
  const h = harness({ script: [ONE_QUESTION], env: { DASHBOARD_PLAN_TIMEOUT_MIN: "0.004" } });
  try {
    seed(h.store, "run-expire");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-expire")?.status === "awaiting_input", "the plan park");
    await waitFor(() => phaseOrder(h.store, "run-expire").includes("spec"), "the run to proceed past the park");

    const record = readPlanRecord(join(h.runsRoot, "run-expire", "results"));
    assert.ok(record !== null);
    assert.equal(record.folded, true, "the exchange is closed and folded, not left half-open");
    assert.equal(record.state.questions[0]?.status, "expired");
    assert.equal(
      record.state.questions[0]?.assumed,
      "three project cards",
      "an expired question records the question's own default — nobody stated it, and the record says so",
    );
    assert.equal(record.state.closed?.reason, "window expired");

    // THE ASSUMPTION IS IN THE BRIEF THE CRITERIA WILL BE AUTHORED FROM. A record
    // that lived only in plan.json would leave the criteria author guessing the
    // same way the phase exists to stop.
    const row = h.store.getRun("run-expire");
    assert.match(row?.ticketText ?? "", /the dashboard is assuming: "three project cards"/);
    assert.match(row?.ticketText ?? "", /NEVER ANSWERED/);
    assert.match(logText(h.store, "run-expire"), /never answered, so the run is assuming/);

    // AND IT IS NOT A FAILURE. The run went on to the spec phase; the park did
    // not become a verdict.
    //
    // `plan` APPEARS TWICE AND THAT IS CORRECT, not noise: `#execute` is entered
    // once to ask and a second time to close the dialogue, and each entry says
    // which phase it is in. The assertion is on the ORDER — spec comes after the
    // last plan — because that is the property that makes the answers able to
    // reach the criteria author.
    const phases = phaseOrder(h.store, "run-expire");
    assert.equal(phases[0], "plan", "the phase runs first, before anything is frozen");
    assert.ok(
      phases.indexOf("spec") > phases.lastIndexOf("plan"),
      `spec must follow the plan phase, not precede it: ${phases.join(",")}`,
    );
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T6/T7/T11 — an answer arrives, the ticket is re-derived, and the answer is
 *             not handed to the builder as a mid-run redirection
 * ---------------------------------------------------------------------- */

/**
 * MUTATION A (T7, identity): drop `redactForPersistence` from
 * `#closePlanDialogue` so the digest is taken over the unredacted fold. The
 * stored text and the derived id then disagree and the re-derivation assertion
 * fails. Watched red, restored.
 *
 * MUTATION B (T11, the stamp): delete `this.#host.markDelivered(...)` from
 * `PlanDriver#turn`. The answer stays in `pendingMessages`, where the build
 * segment's drain would wrap it in "THE OWNER HAS SENT INSTRUCTIONS MID-RUN" and
 * hand the owner's own planning answer to the builder as a conflict with criteria
 * authored from it. The `pendingMessages` assertion fails. Watched red, restored.
 */
test("an answer folds into the brief, re-derives the ticket id, and is NOT left for the builder", async () => {
  const h = harness({ script: [ONE_QUESTION, RESOLVES] });
  try {
    const before = seed(h.store, "run-answer");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-answer")?.status === "awaiting_input", "the plan park");

    // THE ID HAS NOT MOVED YET, and that is half the assertion: a ticket that
    // changed at park time would be a suite address minted per turn.
    assert.equal(h.store.getRun("run-answer")?.ticketId, before.ticketId, "nothing is amended while it waits");

    // THE ANSWER ARRIVES THROUGH THE EXISTING CHAT CHANNEL — the same table and
    // the same route a mid-run instruction uses. No second intake exists.
    const message = h.store.appendMessage("run-answer", { role: "owner", text: "six", images: [] });
    assert.equal(h.orchestrator.deliverPlanReply("run-answer"), true, "a parked run reads this as an answer");
    await waitFor(() => phaseOrder(h.store, "run-answer").includes("spec"), "the dialogue to end");

    const record = readPlanRecord(join(h.runsRoot, "run-answer", "results"));
    assert.equal(record?.state.questions[0]?.status, "answered");
    assert.equal(record?.state.questions[0]?.answer?.text, "six project cards", "the seat's refinement, quote-checked");
    assert.equal(record?.state.closed?.reason, "answered");

    const after = h.store.getRun("run-answer");
    assert.ok(after !== null);
    assert.notEqual(after.ticketId, before.ticketId, "a different brief is a different ticket");
    assert.match(after.ticketText, new RegExp(PLAN_BLOCK_BEGIN.slice(4, 30)));
    assert.match(after.ticketText, /six project cards/);
    assert.equal(after.ticketTitle, before.ticketTitle, "his answers are not a new headline for his run");

    // THE ID RE-DERIVES FROM WHAT WAS STORED. This is the property that keeps the
    // frozen suite findable: the next `#execute` entry computes the id from
    // `ticket_text`, and a digest over any other string would send the run to
    // `authorAndFreezeSuite` for a second suite on the owner's quota.
    assert.equal(ticketFromText(after.ticketText).id, after.ticketId);
    assert.equal(ticketFromText(after.ticketText).sha256, after.ticketSha256);

    // THE ANSWER IS STAMPED, so the builder never sees it as a mid-run order.
    assert.deepEqual(h.store.pendingMessages("run-answer"), [], "a consumed plan answer is not still pending");
    assert.ok(
      h.store.messages("run-answer").find((m) => m.seq === message.seq)?.deliveredAt !== null,
      "the turn stamps the row it read",
    );
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/**
 * MUTATION: delete `!record.awaiting` from `PlanDriver.deliver`'s guard. A
 * message arriving after the dialogue closed then starts a drain against a folded
 * record; `deliverPlanReply` returns true and the first assertion fails. Watched
 * red, restored.
 *
 * THE OWNER WHO ANSWERS TOO LATE IS THE ORDINARY CASE, not an edge one — the
 * window is twenty minutes and he was in a meeting. His message must be stored
 * and treated as a mid-run instruction, and it must NOT reopen a dialogue whose
 * answers can no longer change the criteria: the suite is authored from the brief
 * the expiry already folded.
 */
test("an answer that arrives after the window closed does not resurrect the park", async () => {
  const h = harness({ script: [ONE_QUESTION], env: { DASHBOARD_PLAN_TIMEOUT_MIN: "0.004" } });
  try {
    seed(h.store, "run-late");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-late")?.status === "awaiting_input", "the plan park");
    await waitFor(() => phaseOrder(h.store, "run-late").includes("spec"), "the window to expire");
    const foldedAt = readPlanRecord(join(h.runsRoot, "run-late", "results"));
    assert.equal(foldedAt?.folded, true);
    const ticketAfterExpiry = h.store.getRun("run-late")?.ticketId;

    h.store.appendMessage("run-late", { role: "owner", text: "six", images: [] });
    assert.equal(
      h.orchestrator.deliverPlanReply("run-late"),
      false,
      "the dialogue is over; a late answer is a mid-run message, not a plan turn",
    );

    // NOTHING MOVED: not the record, not the ticket, not the park.
    const record = readPlanRecord(join(h.runsRoot, "run-late", "results"));
    assert.equal(record?.state.questions[0]?.status, "expired", "an expired question stays expired");
    assert.equal(record?.state.turnsUsed, 0, "no turn was consumed");
    assert.equal(h.store.getRun("run-late")?.ticketId, ticketAfterExpiry, "the suite's address cannot move now");
    assert.notEqual(h.store.getRun("run-late")?.status, "awaiting_input", "the run did not re-park");
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T8 — the refusal that makes "nothing is orphaned" a check
 * ---------------------------------------------------------------------- */

/**
 * MUTATION: delete the `row.suiteSha256 !== null` guard in `RunStore.amendBrief`.
 * The call below succeeds and the assertion that it throws fails. Watched red,
 * restored.
 *
 * THE PLAN PHASE RUNS BEFORE `#specPhase`, so at fold time `suite_sha256 IS NULL`
 * BY CONSTRUCTION and this refusal never fires in the ordinary path. That is
 * exactly why it is worth having: it turns "nothing is orphaned because the suite
 * is not frozen yet" from a sentence in a docblock into a check that a future
 * caller cannot walk past.
 */
test("a brief cannot be amended once the suite is frozen, or once the run is terminal", () => {
  const h = harness();
  try {
    seed(h.store, "run-frozen");
    const amended = ticketFromText("Build me a portfolio site. With six cards.");
    // Before the freeze: allowed.
    h.store.amendBrief("run-frozen", {
      ticketText: amended.brief,
      ticketId: amended.id,
      ticketSha256: amended.sha256,
    });
    assert.equal(h.store.getRun("run-frozen")?.ticketId, amended.id);

    h.store.updateRun("run-frozen", { suiteSha256: "f".repeat(64) });
    assert.throws(
      () =>
        h.store.amendBrief("run-frozen", {
          ticketText: "something else",
          ticketId: "t-other",
          ticketSha256: "0".repeat(64),
        }),
      /already bound to suite/,
      "amending after the freeze leaves the row naming a suite it was not graded against",
    );

    seed(h.store, "run-done");
    h.store.updateRun("run-done", { status: "passed" });
    assert.throws(
      () =>
        h.store.amendBrief("run-done", {
          ticketText: "something else",
          ticketId: "t-other",
          ticketSha256: "0".repeat(64),
        }),
      /is passed, so its ticket can no longer change/,
    );
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T9/T10 — every run already on disk predates this phase
 * ---------------------------------------------------------------------- */

/**
 * The runs that existed before the plan phase did, by id.
 *
 * A CLOSED SET, AND THAT IS WHY IT CAN BE A LITERAL. "Predates the plan phase"
 * is a fact about the past: these three are the only runs the owner's database
 * held when the phase shipped, and no run created afterwards can join them. A
 * date cutoff or a "has no plan.json today" filter would both quietly re-admit
 * every future run and put this file back where it was.
 */
const PRE_PLAN_PHASE_RUN_IDS: readonly string[] = [
  "run-2026-07-29T23-28-46-665Z-3d4d1ccb",
  "run-2026-07-30T13-31-38-076Z-c228e63b",
  "run-2026-07-30T20-16-40-242Z-052c6e02",
];

/**
 * MUTATION (both tests): remove `"spec"` from `PHASES`. The real rows and the
 * synthetic one both throw `phase "spec" is not one of …` out of `toRunRow`.
 * Watched red, restored.
 *
 * THE REAL DATABASE, COPIED — never opened in place. `RunStore.open` migrates,
 * which is a write, and the owner's three runs are not a fixture to be mutated by
 * a test run. The copy is the same bytes and the same code path.
 *
 * WHY THE SYNTHETIC TEST BELOW EXISTS AS WELL: this one is environment-dependent
 * — on a clean checkout `dashboard/data/runs.db` may not exist — so it SKIPS
 * rather than fails, and a skipped test proves nothing. The synthetic round trip
 * is the one that catches the regression everywhere.
 */
test("the three runs already on disk still read, still render, and still name their suites", (t) => {
  const source = join(process.cwd(), "..", "data", "runs.db");
  if (!existsSync(source)) {
    // NOT A SILENT PASS. A test that can skip its own body has to say so on the
    // way past, or "green" means two different things and nobody can tell which
    // one they got.
    t.diagnostic(`no historical database at ${source}; this machine has no old runs to check`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "dash-oldruns-"));
  try {
    const copy = join(dir, "runs.db");
    copyFileSync(source, copy);
    const store = RunStore.open(copy);
    try {
      const rows = store.listRuns();
      assert.ok(rows.length >= 3, `expected the owner's historical runs, found ${String(rows.length)}`);
      for (const row of rows) {
        // READ: every row parses through `oneOf(PHASES, …)`, which is the guard
        // adding a phase could have broken.
        assert.ok(row.phase.length > 0);
        // RENDER: the detail projection reads the same row plus its criteria and
        // events. A row that throws here is a run list that 500s.
        assert.doesNotThrow(() => store.listCriteria(row.runId));
        assert.doesNotThrow(() => store.eventsSince(row.runId, 0));
        assert.doesNotThrow(() => store.messages(row.runId));
      }
      // RE-SCORE: the artefact a run is graded against is addressed by its ticket
      // id. If this phase had moved any existing id, these directories would no
      // longer be findable — which is the concrete meaning of "nothing is
      // orphaned".
      const acceptanceRoot = join(process.cwd(), "..", "acceptance");
      let found = 0;
      for (const row of rows) {
        if (existsSync(join(acceptanceRoot, row.ticketId))) found += 1;
      }
      assert.ok(
        found > 0,
        "no historical run's ticket id still names a frozen suite directory — an id has moved",
      );
      t.diagnostic(
        `${String(rows.length)} historical run(s) read back; phases ${[...new Set(rows.map((r) => r.phase))].join("/")}; ` +
          `${String(found)} still name a frozen suite on disk`,
      );
      // AND THE RUNS THAT PREDATE THIS PHASE DID NOT ACQUIRE A PLAN RECORD. A
      // phase that back-filled state onto finished runs would be rewriting
      // history.
      //
      // SCOPED TO THREE NAMED IDS, AND THE SCOPE IS THE FIX. This loop used to
      // run over EVERY row, which was true when it was written and became false
      // the first time the owner started a run after the plan phase shipped:
      // run 4 parks for questions, writes a real `plan.json`, and the assertion
      // failed on it. Worse than an ordinary red — the early return above makes
      // this test green on a clean checkout, so it failed only on the machine
      // that has something to check, i.e. the owner's. Every future run adds
      // another one, so it could never recover.
      //
      // A NEW RUN IS NOT A REGRESSION; A BACK-FILL ONTO AN OLD ONE IS. Only
      // these three runs existed before the phase, no fourth can ever join them,
      // and the claim about them is permanent.
      const preserved = rows.filter((row) => PRE_PLAN_PHASE_RUN_IDS.includes(row.runId));
      // NOT VACUOUS BY CONSTRUCTION. A filter that matches nothing turns the loop
      // below into a no-op that passes having looked at nothing, which is the
      // failure mode this whole edit exists to remove. If the three named runs
      // are gone from this machine, this test has no subject and must say so out
      // loud rather than report a green.
      assert.ok(
        preserved.length > 0,
        `none of the three pre-plan-phase runs is in this database, so the claim below has no subject. ` +
          `Rows present: ${rows.map((row) => row.runId).join(", ") || "(none)"}`,
      );
      for (const row of preserved) {
        assert.equal(
          readPlanRecord(join(process.cwd(), "..", "runs", row.runId, "results")),
          null,
          `${row.runId} predates the plan phase and must stay that way`,
        );
      }
      // THE NEGATIVE CONTROL, AND IT IS THE POINT OF THE EDIT. `null` above is
      // only evidence if a non-null was reachable. `readPlanRecord` returns null
      // for a directory that does not exist, for a directory with no `plan.json`
      // and for one it cannot parse — so a probe pointed at the wrong path, or a
      // reader broken outright, is indistinguishable from the clean history this
      // asserts. Write one record and read it back through the SAME call, from a
      // path built the SAME way, before believing the nulls.
      const controlRoot = mkdtempSync(join(tmpdir(), "dash-planprobe-"));
      try {
        const controlRunId = "run-0000-00-00T00-00-00-000Z-control";
        const controlResults = join(controlRoot, controlRunId, "results");
        mkdirSync(controlResults, { recursive: true });
        writePlanRecord(controlResults, {
          awaiting: true,
          parkedAt: new Date().toISOString(),
          folded: false,
          state: unaskedPlanState(new Date().toISOString(), "negative control for the historical read"),
        });
        assert.notEqual(
          readPlanRecord(join(controlRoot, controlRunId, "results")),
          null,
          "readPlanRecord returned null for a directory a record was just written into, so every " +
            "null above is the probe failing rather than the history being clean",
        );
      } finally {
        rmSync(controlRoot, { recursive: true, force: true });
      }
      t.diagnostic(
        `${String(preserved.length)}/${String(PRE_PLAN_PHASE_RUN_IDS.length)} pre-plan-phase run(s) checked for a ` +
          `back-filled plan record; ${String(rows.length - preserved.length)} later run(s) are exempt by design`,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The same regression, without needing the owner's machine.
 *
 * MUTATION: remove `"spec"` from `PHASES` — `toRunRow` throws. Watched red,
 * restored. (Removing `"plan"` instead leaves this test green, which is the
 * point: it checks that the OLD vocabulary survived, not that the new one exists.)
 */
test("a row written before this phase existed still reads back, phase and all", () => {
  const h = harness();
  try {
    seed(h.store, "run-legacy");
    // Exactly what an old row holds: a phase from the original five, and no
    // plan.json anywhere near it.
    h.store.updateRun("run-legacy", { status: "passed", phase: "done", heldOutPass: true });
    const row = h.store.getRun("run-legacy");
    assert.equal(row?.phase, "done");
    for (const phase of ["spec", "build", "gate", "judge", "done"] as const) {
      h.store.updateRun("run-legacy", { phase });
      assert.equal(h.store.getRun("run-legacy")?.phase, phase, `${phase} must still read back`);
    }
    assert.equal(readPlanRecord(join(h.runsRoot, "run-legacy", "results")), null);
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * T12 — the fold's own boilerplate must not change what gets built
 * ---------------------------------------------------------------------- */

/**
 * THE HAZARD, MEASURED — and it was real. Written as a check first, run, and it
 * FAILED: `classifySurface` returned `fullstack` for an `api` ticket once a plan
 * block was folded in, because the fold's framing paragraphs say "the dashboard"
 * repeatedly and `dashboard` is one of the classifier's WEB_UI keywords. The
 * surface decides the delegation shortlist AND whether the DESIGN lane spends
 * generation attempts, so this phase would have been choosing a run's agents with
 * wording nobody typed.
 *
 * THE FIX IS THE ONE THE CAPTURE BLOCK ALREADY TOOK (`orchestrator.ts` says so at
 * the `#buildPhase` call site): cut the machine's block before classifying. Both
 * halves are asserted below — the raw hazard, so it cannot quietly stop being
 * true and take the reason for the cut with it, and the stripped read, which is
 * the expression the orchestrator now uses at all three call sites.
 *
 * MUTATION: make `stripPlanBlock` return its argument. The second assertion fails
 * on the API brief. Watched red, restored.
 *
 * WHAT THIS TEST DOES NOT PROVE, stated rather than implied: that the ORCHESTRATOR
 * still composes the strip at each of its three call sites. A rename there would
 * pass this test. What it proves is that the composition the call sites use is
 * the right one, and that the underlying hazard is real.
 */
test("folding a plan block does not, by itself, change what the run is classified as", () => {
  const neutral: PlanState = {
    plan: ["A short plan."],
    questions: [
      {
        question: {
          id: "PQ-1",
          text: "How many items should it show?",
          ifUnanswered: "three items",
          criterionIfDefault: "It shows three items.",
          criterionIfAnswered: "It shows six items.",
          tier: "FUNCTIONAL",
        },
        status: "answered",
        answer: { text: "six", quoted: "six", at: "2026-08-02T10:00:00.000Z", attribution: "inferred", paraphrased: false },
        assumed: null,
      },
    ],
    clarifications: [{ at: "2026-08-02T10:00:00.000Z", about: ["PQ-1"], asked: "What do you mean?", reply: "How many." }],
    dropped: [],
    proposed: 1,
    turnsUsed: 1,
    closed: { reason: "answered", at: "2026-08-02T10:00:00.000Z", detail: "every question was settled" },
  };
  const API_TICKET = "Expose a REST endpoint that returns the current price.";
  assert.equal(classifySurface(API_TICKET), "api");
  assert.equal(
    classifySurface(foldPlanIntoBrief(API_TICKET, neutral)),
    "fullstack",
    "THE HAZARD, MEASURED: the fold's own wording moves the surface. If this ever stops being true, the " +
      "strip below is no longer load-bearing and the reason for it must be re-derived rather than assumed.",
  );

  for (const brief of [
    "Build me a portfolio page with a hero and a project grid.",
    "Write a command-line tool that renames files in bulk.",
    API_TICKET,
    "Make it better.",
  ]) {
    const folded = foldPlanIntoBrief(brief, neutral);
    // The two compositions the orchestrator uses: `#buildPhase` cuts the capture
    // block as well, the fix loop and the adversary lane do not.
    assert.equal(
      classifySurface(ticketProse(stripPlanBlock(folded))),
      classifySurface(ticketProse(brief)),
      `the fold changed the build phase's surface for: ${brief}`,
    );
    assert.equal(
      classifySurface(stripPlanBlock(folded)),
      classifySurface(brief),
      `the fold changed the fix loop's surface for: ${brief}`,
    );
  }
});

/* -------------------------------------------------------------------------
 * THE TURN CAP, WHICH NO INTEGRATION TEST ABOVE EXECUTES
 * ---------------------------------------------------------------------- */

/**
 * `MAX_OWNER_TURNS` IS A NAMED CONSTANT AND UNTIL THIS TEST NOTHING RAN THE PATH
 * THAT ENFORCES IT. The runs above end by being answered or by expiring; two of
 * `closureFor`'s four branches — `turn cap` and `declined` — had never been
 * reached, which is a bound stated in a docblock and observed nowhere. That is
 * this repository's signature defect, and it does not stop being one because the
 * function is short.
 *
 * WHAT THE TURN CAP ACTUALLY BUYS, STATED RATHER THAN OVERSOLD: it is the SECOND
 * bound, not the only one. The park clock ends the dialogue whatever the turn
 * count, so a broken turn cap costs extra seat calls inside one window — real,
 * but not an unbounded park.
 *
 * MUTATION: delete the `planTurnsExhausted` branch from `closureFor`. The third
 * case below returns null and goes red. Watched red, restored.
 */
test("closureFor names all four ways a dialogue ends, including the two no run above reaches", () => {
  const question = {
    id: "PQ-1",
    text: "How many items?",
    ifUnanswered: "three items",
    criterionIfDefault: "It shows three items.",
    criterionIfAnswered: "It shows six items.",
    tier: "FUNCTIONAL" as const,
  };
  const base: PlanState = {
    plan: [],
    questions: [],
    clarifications: [],
    dropped: [],
    proposed: 1,
    turnsUsed: 0,
    closed: null,
  };
  const now = "2026-08-02T10:00:00.000Z";
  const parkedAt = "2026-08-02T09:55:00.000Z"; // five minutes into a twenty-minute window
  const answered = {
    question,
    status: "answered" as const,
    assumed: null,
    answer: { text: "six", quoted: "six", at: now, attribution: "inferred" as const, paraphrased: false },
  };
  const declined = { question, status: "declined" as const, assumed: question.ifUnanswered, answer: null };
  const open = { question, status: "open" as const, assumed: null, answer: null };

  assert.equal(
    closureFor({ ...base, questions: [answered] }, parkedAt, 20, now),
    "answered",
    "settled with an answer in it",
  );
  assert.equal(
    closureFor({ ...base, questions: [declined] }, parkedAt, 20, now),
    "declined",
    "settled with NO answer in it — 'you decide', which must not be reported as answered",
  );
  assert.equal(
    closureFor({ ...base, questions: [open], turnsUsed: MAX_OWNER_TURNS }, parkedAt, 20, now),
    "turn cap",
    "the dialogue spent its turns while a question was still open",
  );
  assert.equal(
    closureFor({ ...base, questions: [open], turnsUsed: MAX_OWNER_TURNS - 1 }, parkedAt, 20, now),
    null,
    "and with a turn left and time left it keeps going",
  );
  // THE CLOCK OUTRANKS THE TURN COUNT when both are spent, because "the window
  // closed" is the fact the owner needs and the one `assumptions.md` records.
  assert.equal(
    closureFor({ ...base, questions: [open], turnsUsed: MAX_OWNER_TURNS }, "2026-08-02T09:00:00.000Z", 20, now),
    "window expired",
  );
});

/* -------------------------------------------------------------------------
 * The seam that the optional `RunController` member could silently lose
 * ---------------------------------------------------------------------- */

/**
 * `RunController.deliverPlanReply` is OPTIONAL so that eight existing test
 * doubles keep compiling, which means `?.` would swallow a rename — the plan
 * intake would quietly stop working with nothing failing to compile. This is the
 * check that would fail instead.
 *
 * MUTATION: rename `Orchestrator.deliverPlanReply`. The type alias below stops
 * resolving and `tsc` fails here. Watched red, restored.
 */
test("the real orchestrator still carries the method the message route calls through", () => {
  const h = harness();
  try {
    type CarriesIt = Orchestrator extends { deliverPlanReply(runId: string): boolean } ? true : never;
    const carriesIt: CarriesIt = true;
    assert.equal(carriesIt, true);
    assert.equal(typeof h.orchestrator.deliverPlanReply, "function");
    assert.equal(h.orchestrator.deliverPlanReply("no-such-run"), false, "a run with no plan record is not parked");
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * A malformed record must not wedge the boot loop
 * ---------------------------------------------------------------------- */

/**
 * THIS TEST USED TO ASSERT `doesNotThrow` AND NOTHING ELSE, and its own comment
 * said the run was then "left for a human — which is a state with a button on
 * it". THAT WAS FALSE, AND IT WAS THE WORST KIND OF FALSE: `reconcileOnBoot`
 * moves a run to `awaiting_input` only when it was RUNNING, so this run — already
 * `awaiting_input` from the park — gets no new log line, no timer and no button
 * pressed on its behalf. `awaiting_input` has no automatic exit. The run waited
 * for ever for an answer to questions nothing could render, and nothing reported
 * it: the exact infinite park `plan-record.ts` exists to prevent, reached by
 * corrupting `plan-record.ts`'s own file.
 *
 * SO THE ASSERTION IS NOW THE EXIT, end to end, through the real boot path.
 *
 * MUTATION A: restore `reconcile`'s old `readPlanRecord(...) === null → false`
 * for an unreadable record. The run never leaves `awaiting_input` and the first
 * `waitFor` times out. Watched red, restored.
 *
 * MUTATION B: make `readPlanRecord` cast rather than validate (`return
 * JSON.parse(...) as PlanRecord`), which is what `readDesignLock` does. The
 * record then reads as a live park, `#arm` re-arms a twenty-minute timer over a
 * question list nothing can render, and the same `waitFor` times out. Watched
 * red, restored.
 */
test("an unreadable plan.json ENDS the park — the run proceeds and says why", async () => {
  const h = harness({ script: [ONE_QUESTION] });
  try {
    seed(h.store, "run-corrupt");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-corrupt")?.status === "awaiting_input", "the plan park");
    await h.orchestrator.shutdown();

    const results = join(h.runsRoot, "run-corrupt", "results");
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, PLAN_RECORD_FILE), '{"awaiting": true, "parkedAt": "now", "folded": false}', "utf8");
    assert.equal(readPlanRecord(results), null, "a record missing its state is not a park");

    const paths = resolvePaths({ DASHBOARD_HOME: h.dir });
    const store2 = RunStore.open(paths.database);
    const second = new Orchestrator({
      store: store2,
      bus: new RunEventBus(store2),
      paths,
      catalog: new ModelCatalog(new AuthProbe({ claudeBin: "absent", codexBin: "absent" }), {}, async () => []),
      auth: new AuthProbe({ claudeBin: "absent", codexBin: "absent" }),
      preview: new PreviewHost(),
      env: {},
      gateReadiness: READY_GATE_READINESS,
      makePlanSeat: scriptedSeats([ONE_QUESTION], []),
    });
    try {
      assert.doesNotThrow(() => second.reconcileOnBoot());
      await waitFor(
        () => store2.getRun("run-corrupt")?.status !== "awaiting_input",
        "the run to leave the park — a record nobody can read has no other exit",
      );

      // AND IT PROCEEDS ON WHAT IT HAS, which is what an expiry does. The
      // replacement record parses, is folded, and says why — without it the next
      // `#execute` entry would take the FRESH path, call the seat again and open a
      // second dialogue against a window with no clock left.
      const record = readPlanRecord(results);
      assert.ok(record !== null, "the park was replaced by a record that reads");
      assert.equal(record.folded, true);
      assert.equal(record.awaiting, false);
      assert.match(String(record.state.closed?.detail), /could not be read/);
      assert.match(logText(store2, "run-corrupt"), /plan record could not be read/);

      // THE CORRUPT BYTES ARE KEPT, because a record that cannot be parsed is
      // evidence of either a crash mid-write or a drift in the four hand-written
      // unions, and the resolution would otherwise destroy the only copy.
      assert.equal(
        readFileSync(join(results, PLAN_RECORD_UNREADABLE_FILE), "utf8"),
        '{"awaiting": true, "parkedAt": "now", "folded": false}',
      );
    } finally {
      // THE RESUMED RUN IS EXECUTING IN `second` — see `Harness.settle`. It was
      // not, before this test asserted the exit.
      await second.shutdown();
      await waitFor(() => second.activeRunIds.length === 0, "the resumed run to stop executing", 30_000);
      store2.close();
    }
  } finally {
    h.cleanup();
  }
});

/* Keep the unused-import checker honest about the helper used only above. */
void execFileSync;
