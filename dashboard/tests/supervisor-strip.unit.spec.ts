/**
 * THE THREE-STATE READ, TESTED IN BOTH DIRECTIONS FOR EVERY ARM.
 *
 * WHY EVERY TEST HERE HAS A NEGATIVE HALF. This repository's catalogued
 * signature defect is a check that can only observe success — twenty-one
 * instances, five found in the last two days — and a liveness classifier is the
 * single easiest place to add the twenty-second. `expect(liveness).toBe("running")`
 * on a healthy input passes against `return "running"`. So no arm below is
 * asserted alone: each one is paired with the nearest input that must land
 * somewhere else, and `armSupervisorStrip` is asserted to produce FOUR DISTINCT
 * answers rather than four correct-looking ones.
 *
 * THE INPUT FOR THE OSCILLATION ARM IS QUOTED FROM THE RUN, NOT INVENTED.
 * `run-2026-08-09T21-04-00-713Z-a913c871` was rejected on
 * `dataExpectations[0].id`, then on `dataExpectations[0].kind`, then attempt 3
 * added `kind` and LOST `id` and the run died — 1h26m54s, three attempts, a
 * budget of three never exceeded. A counter cannot see that and neither can any
 * quiet-time threshold; the set comparator is the only thing that can.
 */

import { expect, test } from "@playwright/test";

import type {
  SupervisorAttemptView,
  SupervisorState,
} from "../src/lib/api-types";
import type { SupervisorReadingInput } from "../src/lib/supervisor";
import {
  A913C871_ATTEMPTS,
  STALE_AFTER_MS,
  STUCK_AFTER_MS,
  armSupervisorStrip,
  attemptProgress,
  censusCounts,
  censusIsTerminal,
  classifySupervisor,
  failedTicketAction,
  probeLiveness,
  probeVerdict,
  repairCycleSummary,
  repairSummary,
} from "../src/lib/supervisor";
import golden from "./fixtures/supervisor-wire.golden.json";

const NOW = Date.parse("2026-08-10T03:00:00.000Z");

/**
 * THE FIXTURE SHAPE IS THE WIRE'S SHAPE, AND FROM 2026-08-10 THAT IS CHECKED
 * RATHER THAN CLAIMED.
 *
 * Everything below is built from `SupervisorState`, which was rewritten in that
 * pass to match `ApiSupervisorState` field for field — the previous version
 * disagreed in fifteen and every test in this file was green against it. A helper
 * is not evidence of the wire; `tests/fixtures/supervisor-wire.golden.json`, which
 * the server's own composer produced, is, and the test at the bottom of this file
 * drives the classifier with it.
 */
const PROBE: SupervisorState["probe"] = {
  ticketsSeen: 0,
  runsSeen: 0,
  eventsSeen: 0,
  wired: true,
  armed: true,
  armNote: "the route distinguished its own three outputs",
  unsourced: ["attempts", "lastDefect", "lastRepair"],
};

function state(over: Partial<SupervisorState>): SupervisorState {
  return {
    desired: "running",
    changedAt: "2026-08-10T02:00:00.000Z",
    changedBy: "owner",
    reason: "the owner pressed start",
    at: "2026-08-10T03:00:00.000Z",
    ticket: null,
    run: null,
    attempts: [],
    lastDefect: null,
    lastDefectId: null,
    lastRepair: null,
    lastPatchId: null,
    nextAction: "claim the oldest queued ticket",
    nextActionAt: null,
    queueDepth: 0,
    queuedRuns: 0,
    probe: PROBE,
    ...over,
  };
}

const TICKET = {
  ticketKey: "t-b79ff5e2a1b314e4",
  title: "a portfolio site",
  state: "running",
  attemptNo: 1,
  maxAttempts: 3,
} as const;

/** Every call names `receivedAtMs` explicitly, because arm 3 turns on it. */
function read(
  snapshot: SupervisorState | null,
  over: Partial<Omit<SupervisorReadingInput, "snapshot">> = {},
) {
  return classifySupervisor({
    snapshot,
    error: null,
    receivedAtMs: NOW - 2_000,
    nowMs: NOW,
    /*
     * NO CENSUS BY DEFAULT, AND THAT IS WHAT MAKES EVERY TEST WRITTEN BEFORE
     * 2026-08-10 STILL A TEST OF THE SAME THING.
     *
     * `GET /api/supervisor/tickets` has no producer, so ARM 6b is gated on a
     * READABLE census and cannot fire from this default. Every arm above it is
     * therefore exercised by exactly the inputs it always was; a red test in this
     * file after the census landed would mean the arm order moved, which is the
     * signal to want. The census arms are driven explicitly, from `census()` below.
     */
    censusBody: null,
    censusError: null,
    ...over,
  });
}

/**
 * A CENSUS BODY, BUILT AS JSON RATHER THAN AS A TYPED VALUE — deliberately.
 *
 * `classifySupervisor` takes `censusBody: unknown` because the only honest source
 * for it is a parsed HTTP body that nothing has checked. A helper returning
 * `SupervisorTicketCensus` would hand the classifier a value TypeScript has already
 * vouched for, and every validator test below would be testing a path the real app
 * never takes. `Record<string, unknown>` rows are what the wire produces, and they
 * are what lets a test omit a column the way a first version of the route will.
 */
function census(rows: readonly Record<string, unknown>[], over: Record<string, unknown> = {}): unknown {
  return { tickets: rows, ...over };
}

const DONE_ROW = { ticketKey: "t-done", state: "done" };
const BLOCKED_ROW = {
  ticketKey: "t-blocked",
  state: "blocked",
  updatedAt: "2026-08-10T02:00:00.000Z",
  lastClass: "structural",
  nextAction: "no repair driver is wired; run tools/repair/cycle.mjs against a copy by hand",
};

/**
 * THE ARGUMENT IS SECONDS AND THE WIRE FIELD IS MILLISECONDS, and the conversion
 * is HERE rather than in the module under test. That is the direction the bug went:
 * the mirror declared a top-level `quietForSeconds` the server has never sent and
 * `classifySupervisor` multiplied it by 1000, so the strip's clock was `undefined *
 * 1000` on every real poll. A helper that converts keeps these call sites readable
 * without putting arithmetic back into the classifier.
 */
function withRun(
  quietForSeconds: number | null,
  over: Partial<SupervisorState> = {},
): SupervisorState {
  return state({
    ticket: TICKET,
    run: {
      runId: "run-2026-08-09T21-04-00-713Z-a913c871",
      phase: "spec",
      status: "running",
      quietForMs: quietForSeconds === null ? null : quietForSeconds * 1_000,
    },
    probe: { ...PROBE, ticketsSeen: 1, runsSeen: 1, eventsSeen: 412 },
    ...over,
  });
}

/** Seconds, because that is what these helpers take. */
const STUCK_AFTER_S = STUCK_AFTER_MS / 1_000;

function attempt(n: number, problems: readonly string[]): SupervisorAttemptView {
  return { n, at: `2026-08-09T2${String(n)}:00:00.000Z`, problems };
}

/* ------------------------------------------------------------------ */
/* THE FOUR STATES, EACH AGAINST ITS NEAREST NEIGHBOUR                 */
/* ------------------------------------------------------------------ */

test("a live run with a recent event is running — and the SAME run with the clock past the ceiling is not", () => {
  const alive = read(withRun(45));
  expect(alive.liveness).toBe("running");

  // ONE FIELD DIFFERENT. If this pair does not separate, the threshold is
  // decoration.
  const silent = read(withRun(STUCK_AFTER_S + 1));
  expect(silent.liveness).toBe("stuck");
  expect(silent.because).toContain("past the");

  // And the boundary is inclusive on the healthy side, so the number in the
  // module is the number under test rather than "somewhere around 40 minutes".
  expect(read(withRun(STUCK_AFTER_S)).liveness).toBe("running");
});

test("a run with NO progress clock is stuck, not running — absence is not health", () => {
  const blind = read(withRun(null));
  expect(blind.liveness).toBe("stuck");
  expect(blind.headline).toBe("no sign of progress");
  expect(blind.because).toContain("nothing here can show it is alive");

  // The negative half: a clock reading ZERO seconds is the healthiest possible
  // input and must not be confused with `null`. A falsy check instead of a null
  // check would collapse these two, and the wire can legitimately send 0.
  expect(read(withRun(0)).liveness).toBe("running");
});

test("a claimed ticket with no run is stuck; an unclaimed queue-empty supervisor is idle", () => {
  const orphan = read(withRun(30, { run: null }));
  expect(orphan.liveness).toBe("stuck");
  expect(orphan.headline).toBe("ticket taken, no run started");

  const idle = read(state({ desired: "running", ticket: null, queueDepth: 0 }));
  expect(idle.liveness).toBe("idle");
});

test("RUNNING with work queued and nothing claimed is STUCK — the supervisor that thinks it is running", () => {
  /*
   * This is the failure mode the brief names: a supervisor that believes it is
   * running. `desired='running'`, tickets waiting, nothing claimed, and today
   * that renders as a calm green bar for eight hours.
   */
  const wedged = read(state({ desired: "running", ticket: null, queueDepth: 4 }));
  expect(wedged.liveness).toBe("stuck");
  expect(wedged.because).toContain("has claimed none of them");

  // NEGATIVE HALF, AND IT IS THE ONE THAT MATTERS: a DRAINED supervisor with a
  // queue is idle, not stuck. It is not claiming because it was told not to.
  const drained = read(
    state({
      desired: "stopped",
      ticket: null,
      queueDepth: 4,
      reason: "the owner pressed stop",
    }),
  );
  expect(drained.liveness).toBe("idle");
  expect(drained.because).toContain("the owner pressed stop");
});

/* ------------------------------------------------------------------ */
/* THE ONE THE BRIEF CALLS THE IMPORTANT ONE                            */
/* ------------------------------------------------------------------ */

test("an unreachable endpoint says SO — it never renders the kept snapshot as live", () => {
  /*
   * SWR's `keepPreviousData` leaves the last good body in `data` when a poll
   * fails, which is right for reading history and catastrophic for reading
   * state. Yesterday's preview card told the owner his backend was down while
   * it was up; this is the inverse, and it is worse.
   */
  const healthy = withRun(20);
  const lost = read(healthy, {
    error: new Error("Cannot reach the dashboard API at http://127.0.0.1:4176"),
  });

  expect(lost.liveness).toBe("unreachable");
  expect(lost.stale).toBe(true);
  expect(lost.because).toContain("Cannot reach the dashboard API");
  expect(lost.because).toContain("history, not state");
  // The snapshot is still carried, because the detail pane reads it.
  expect(lost.snapshot).toBe(healthy);

  // NEGATIVE HALF: the identical snapshot with no error is the live read.
  expect(read(healthy).liveness).toBe("running");
});

test("a reading older than the poll is unreachable, and one inside it is not", () => {
  const stale = read(withRun(20), { receivedAtMs: NOW - STALE_AFTER_MS - 1 });
  expect(stale.liveness).toBe("unreachable");
  expect(stale.headline).toBe("reading is stale");

  expect(
    read(withRun(20), { receivedAtMs: NOW - STALE_AFTER_MS + 1_000 }).liveness,
  ).toBe("running");
});

test("with no clock at all — the first paint — nothing is called running", () => {
  // `receivedAtMs: null` is the component before its first interval tick. A
  // classifier that let this through would paint a confident green bar on
  // frame one, every reload, whatever the backend was doing.
  expect(read(withRun(20), { receivedAtMs: null }).liveness).toBe("unreachable");
});

test("the route saying it is NOT WIRED is never rendered as state", () => {
  /*
   * `probe.wired === false` means no supervisor is behind the route and every
   * other field is a DEFAULT — including `desired`. A strip that read those
   * defaults would report a considered decision that nobody made.
   */
  const bare = read(
    state({
      desired: "stopped",
      probe: { ...PROBE, wired: false, armed: false, armNote: "no supervisor is constructed in this process" },
    }),
  );
  expect(bare.liveness).toBe("unreachable");
  expect(bare.headline).toBe("no supervisor wired");
  expect(bare.because).toContain("no supervisor is constructed in this process");

  // NEGATIVE HALF: the identical body with `wired: true` is a plain idle.
  expect(read(state({ desired: "stopped" })).liveness).toBe("idle");
});

/*
 * THE NEGATIVE CONTROL THE LADDER DID NOT HAVE, AND WHAT IT COST.
 *
 * Every fixture above hands the classifier a WELL-FORMED `SupervisorState`, so
 * arms 1-3 could observe no-answer, failed-answer and stale-answer, and nothing
 * could observe a MALFORMED answer. A 200 whose body is not a `SupervisorState`
 * — a proxy page, a stale route, or any browser fixture whose catch-all
 * `page.route("**\/api/**")` fulfils every unmatched path with a run-detail
 * body — reached arm 4 and threw `Cannot read properties of undefined
 * (reading 'wired')` out of `classifySupervisor`, up through `SupervisorStrip`
 * and `AppShell` into `RootLayout`. A throwing RootLayout renders NOTHING: no
 * strip, no canvas, no error text. Measured: 24 failures across the 10 of 32
 * browser spec files that install such a catch-all, and zero outside them.
 *
 * The body below is the exact shape that did it — the run-detail JSON
 * `design-lock.browser.spec.ts` fulfils `/api/supervisor` with.
 */
test("a 200 whose body is NOT a SupervisorState is unreachable — it never throws, and the strip never renders it as state", () => {
  const runDetailBody = {
    run: { runId: "run-2026-08-09T21-04-00-713Z-a913c871", status: "running" },
    events: [],
    messages: [],
    designLock: null,
  } as unknown as SupervisorState;

  const malformed = read(runDetailBody);
  /*
   * `malformed` IS ITS OWN LIVENESS SINCE 2026-08-10, and the word is the fix.
   * This arm used to answer `unreachable`, which is what the strip also says for
   * a dead endpoint and a stale reading — three situations, one badge, and only
   * one of them is fixed by waiting. See `SupervisorLiveness`.
   */
  expect(malformed.liveness).toBe("malformed");
  expect(malformed.headline).toBe("supervisor answered with the wrong body");
  expect(malformed.because).toContain("probe");
  // THE SENTENCE MAY NOT BLAME THE RUN. Against the shipped server this state is
  // what a perfectly healthy supervisor produces, so a sentence that reads as
  // "your loop is broken" would be the false alarm this module exists to avoid.
  expect(malformed.because).toContain("the supervisor itself may be fine");

  // A body that is an ARRAY, and one that is a bare string parsed from JSON:
  // both are 200s, both are truthy, neither is a SupervisorState.
  expect(read([] as unknown as SupervisorState).liveness).toBe("malformed");
  expect(read("ok" as unknown as SupervisorState).liveness).toBe("malformed");

  // A body with a `probe` but a `desired` no build has ever emitted is also not
  // this contract, and reading its defaults would report a decision nobody made.
  expect(
    read(state({ desired: "paused" as unknown as SupervisorState["desired"] })).liveness,
  ).toBe("malformed");

  /*
   * NEGATIVE HALF — THREE OF THEM, because an arm that refuses everything is
   * exactly as useless as one that refuses nothing:
   *   a well-formed live run is still `running`;
   *   a well-formed unwired route still reaches ARM 4 and says so, rather than
   *     being swallowed by this arm above it;
   *   `probe: {}` is a shape this arm does NOT claim to catch — `wired` reads
   *     `undefined`, which is falsy, so arm 4 fires honestly and nothing throws.
   */
  expect(read(withRun(20)).liveness).toBe("running");
  expect(read(state({ desired: "stopped" })).headline).toBe("stopped, nothing in flight");
  const unwired = read(
    state({
      probe: { ...PROBE, wired: false, armed: false, armNote: "no supervisor is constructed in this process" },
    }),
  );
  expect(unwired.headline).toBe("no supervisor wired");

  /*
   * `probe: {}` IS NOW CAUGHT, AND THIS ASSERTION WAS REVERSED ON PURPOSE
   * (2026-08-10). It used to read "no supervisor wired" and the comment above it
   * called that a shape "this arm does NOT claim to catch": `wired` is
   * `undefined`, arm 4 fires, nothing throws. All true, and still the wrong
   * answer — "no supervisor is wired" is a claim about the SUPERVISOR that
   * nothing on the wire made, invented from an absent field. It is a claim about
   * the BODY now, and the sentence names the field.
   */
  const emptyProbe = read(state({ probe: {} as unknown as SupervisorState["probe"] }));
  expect(emptyProbe.liveness).toBe("malformed");
  expect(emptyProbe.because).toContain("probe.wired is absent");
  expect(emptyProbe.snapshot).toBe(null);
});

/**
 * THE HALF THE TEST ABOVE PROMISED IN ITS TITLE AND DID NOT CHECK, AND IT COST 77
 * BROWSER FAILURES.
 *
 * The test above is called "…and the strip never renders it as state" and asserts
 * `liveness`, `headline` and `because` — three text fields. It says nothing about
 * `reading.snapshot`, and the classifier left the MALFORMED BODY there, typed
 * `SupervisorState | null`. `supervisor-strip.tsx:205` believed the declaration:
 *
 *   const wired = snapshot !== null && snapshot.probe.wired;
 *
 * which threw `Cannot read properties of undefined (reading 'wired')` out of
 * `SupervisorStrip` -> `AppShell` -> `RootLayout`. A throwing RootLayout renders
 * NOTHING, so every page in the app was blank. MEASURED, not reasoned: 80 failed
 * / 186 passed across 11 browser spec files, 77 of them carrying that single
 * line — while the classifier's own suite was green, because it only ever looked
 * at the three strings.
 *
 * So the arm is asserted on the field a CONSUMER reads, in both directions, and
 * over every field the strip dereferences two levels deep rather than only the
 * one that happened to be measured. A guard that stops the classifier throwing
 * and hands the same body to the component has moved the throw, not removed it.
 */
test("a malformed 200 leaves NO snapshot on the reading — the field a consumer dereferences", () => {
  const runDetailBody = {
    run: { runId: "run-2026-08-09T21-04-00-713Z-a913c871", status: "running" },
    events: [],
    messages: [],
    designLock: null,
  } as unknown as SupervisorState;

  // THE EXACT BODY THAT DID IT: `design-lock.browser.spec.ts`'s catch-all
  // fulfils every unmatched `**/api/**` with this, `/api/supervisor` included.
  expect(read(runDetailBody).snapshot).toBe(null);
  expect(read([] as unknown as SupervisorState).snapshot).toBe(null);
  expect(read("ok" as unknown as SupervisorState).snapshot).toBe(null);
  expect(read(state({ desired: "paused" as unknown as SupervisorState["desired"] })).snapshot).toBe(
    null,
  );

  /*
   * THE FIELDS NO ARM READS AND THE STRIP DOES. `lastRepair` is NULLABLE on the
   * wire — a literal `null` is what the shipped route sends — and the detail pane
   * reads `patchId`, `appliedAt` and `filesChanged`. `absent` is still not `null`:
   * a body that dropped the key is a body from something that is not this route.
   */
  const noRepair = { ...state({}) } as Record<string, unknown>;
  delete noRepair["lastRepair"];
  const readNoRepair = read(noRepair as unknown as SupervisorState);
  expect(readNoRepair.snapshot).toBe(null);
  expect(readNoRepair.liveness).toBe("malformed");
  expect(readNoRepair.because).toContain("lastRepair is absent");

  const badFiles = state({
    lastRepair: {
      patchId: "p-1",
      filesChanged: null as unknown as readonly string[],
      appliedAt: "2026-08-10T00:30:00.000Z",
      rerunPassed: null,
    },
  });
  expect(read(badFiles).snapshot).toBe(null);
  expect(read(badFiles).because).toContain("lastRepair.filesChanged is not an array");

  /*
   * AND `lastRepair: null` IS LEGAL, WHICH IS THE OTHER HALF OF THE SAME CHECK.
   * The previous mirror declared this field non-nullable, so the body the server
   * actually sends every second of every day would have been rejected here.
   */
  expect(read(state({ lastRepair: null })).liveness).toBe("idle");

  /*
   * NEGATIVE HALF, AND IT IS THE ONE THAT MATTERS HERE: an arm that nulls every
   * snapshot is exactly as useless as one that nulls none. A well-formed body
   * KEEPS its snapshot on the reading — the strip's ticket cell, quiet clock,
   * defect cell and detail pane all render from it, and nulling it here would
   * blank the panel on every healthy read instead of on a malformed one.
   */
  const healthy = read(withRun(20));
  expect(healthy.liveness).toBe("running");
  expect(healthy.snapshot).not.toBe(null);
  expect(healthy.snapshot?.probe.wired).toBe(true);

  // An UNWIRED body is well-formed and keeps its snapshot too: arm 4 is a
  // reading about a real answer, not a rejection of its shape.
  const unwired = read(
    state({
      probe: { ...PROBE, wired: false, armed: false, armNote: "no supervisor is constructed in this process" },
    }),
  );
  expect(unwired.headline).toBe("no supervisor wired");
  expect(unwired.snapshot).not.toBe(null);

  // And a STALE reading keeps its snapshot — that is the whole point of arm 3:
  // history with an honest age on it, not an absence.
  const stale = read(state({}), { receivedAtMs: NOW - STALE_AFTER_MS - 1_000 });
  expect(stale.stale).toBe(true);
  expect(stale.snapshot).not.toBe(null);
});

/**
 * THE SAME CRASH, REACHED BY A PATH THE ARM'S OWN TEST DID NOT COVER — AND THIS TEST
 * IS THE ONE THAT WAS MISSING WHEN THE FIX WAS WRITTEN (2026-08-10).
 *
 * The shape check used to live INSIDE arm 3b, which sits BELOW the error arm and the
 * stale arm. Both of those keep the body and publish it on `reading.snapshot`. So a
 * malformed 200 followed by one failed poll — a wrong route plus a dropped request,
 * which is a minute of a restarting server — returned `unreachable` with the
 * MALFORMED body attached, under a field declared `SupervisorState | null`, and
 * `supervisor-strip.tsx`'s `snapshot.probe.wired` threw on it. Blank RootLayout,
 * again, from the same class of body, through a different arm.
 *
 * The shape is now checked ONCE before every arm, and the invariant is worth stating
 * as the thing under test: `reading.snapshot` is non-null ONLY for a body that
 * cleared `malformedReasons`, whichever of the five livenesses is reported. These are
 * the two orderings that had no assertion.
 */
test("a malformed body publishes NO snapshot even when the arm above 3b answers first", () => {
  const runDetailBody = {
    run: { runId: "run-2026-08-09T21-04-00-713Z-a913c871", status: "running" },
    events: [],
    messages: [],
    designLock: null,
  } as unknown as SupervisorState;

  // ARM 2 FIRST: the last body was junk and THIS poll failed too.
  const junkThenDead = read(runDetailBody, { error: new Error("connection refused") });
  expect(junkThenDead.liveness).toBe("unreachable");
  expect(junkThenDead.stale).toBe(true);
  expect(
    junkThenDead.snapshot,
    "arm 2 published a body no consumer can dereference — this is the blank RootLayout",
  ).toBe(null);

  // ARM 3 FIRST: the last body was junk and the reading has aged past the poll.
  const junkAndOld = read(runDetailBody, { receivedAtMs: NOW - STALE_AFTER_MS - 1_000 });
  expect(junkAndOld.liveness).toBe("unreachable");
  expect(junkAndOld.headline).toBe("reading is stale");
  expect(junkAndOld.snapshot).toBe(null);

  /*
   * NEGATIVE HALF, AND IT IS WHAT STOPS THE FIX FROM BEING "NULL EVERYTHING": the
   * SAME two orderings with a WELL-FORMED body keep their snapshot, because the
   * detail pane renders history with an honest age on it. Nulling these would blank
   * the panel every time a poll dropped.
   */
  const goodThenDead = read(withRun(20), { error: new Error("connection refused") });
  expect(goodThenDead.liveness).toBe("unreachable");
  expect(goodThenDead.snapshot).not.toBe(null);
  expect(goodThenDead.snapshot?.run?.runId).toBe("run-2026-08-09T21-04-00-713Z-a913c871");

  const goodAndOld = read(withRun(20), { receivedAtMs: NOW - STALE_AFTER_MS - 1_000 });
  expect(goodAndOld.headline).toBe("reading is stale");
  expect(goodAndOld.snapshot).not.toBe(null);

  /*
   * AND THE TRAIL IS NOT COMPARED OFF AN UNVALIDATED BODY EITHER. `attemptProgress`
   * calls `.map`; a junk body whose `attempts` is a number reaching arm 2 would throw
   * inside the classifier, above every arm. `unknown` is the honest answer when there
   * is no readable trail.
   */
  const junkTrail = read({ ...(runDetailBody as unknown as Record<string, unknown>), attempts: 3 } as unknown as SupervisorState, {
    error: new Error("connection refused"),
  });
  expect(junkTrail.progress).toBe("unknown");
  expect(junkTrail.recurringPaths).toEqual([]);
});

test("the route reporting its OWN arm check failed is stuck, not running", () => {
  const blindRoute = read(
    withRun(20, {
      probe: {
        ...PROBE,
        armed: false,
        ticketsSeen: 1,
        runsSeen: 1,
        eventsSeen: 9,
        armNote: "the composer produced the same body for all three probes",
      },
    }),
  );
  expect(blindRoute.liveness).toBe("stuck");
  expect(blindRoute.headline).toBe("supervisor self-check failed");
  expect(blindRoute.because).toContain("the same body for all three probes");

  // NEGATIVE HALF: the same healthy run with `armed: true` is running.
  expect(read(withRun(20)).liveness).toBe("running");
});

test("every reading carries a non-empty sentence, whatever it is", () => {
  const inputs = [
    { snapshot: null, error: null },
    { snapshot: null, error: new Error("boom") },
    { snapshot: withRun(20), error: new Error("boom") },
    { snapshot: withRun(20), error: null },
    { snapshot: withRun(null), error: null },
    { snapshot: withRun(STUCK_AFTER_S + 1), error: null },
    { snapshot: state({}), error: null },
    { snapshot: state({ queueDepth: 2 }), error: null },
    {
      snapshot: state({
        probe: { ...PROBE, wired: false, armed: false, armNote: "no supervisor is constructed in this process" },
      }),
      error: null,
    },
  ];
  for (const input of inputs) {
    const reading = read(input.snapshot, { error: input.error });
    expect(reading.because.trim(), `blank sentence for ${JSON.stringify(input.snapshot)}`).not.toBe(
      "",
    );
    expect(reading.headline.trim()).not.toBe("");
  }
});

/* ------------------------------------------------------------------ */
/* THE COMPARATOR — a913c871, AND ITS NEGATIVE CONTROL                  */
/* ------------------------------------------------------------------ */

test("a913c871's three real rejection sets escalate at attempt 2 and name the field that came back", () => {
  const result = attemptProgress(A913C871_ATTEMPTS);

  expect(result.progress).toBe("oscillating");
  expect(result.escalatesAtAttempt).toBe(2);
  expect(result.recurringPaths).toEqual(["dataExpectations[0].id"]);
});

test("a SHRINKING sequence does not escalate — a comparator that always escalates is as useless as one that never does", () => {
  const result = attemptProgress([
    attempt(1, ["d[0].id", "d[0].kind", "d[0].minRows"]),
    attempt(2, ["d[0].id", "d[0].kind"]),
    attempt(3, ["d[0].id"]),
  ]);

  expect(result.progress).toBe("shrinking");
  expect(result.escalatesAtAttempt).toBeNull();
  expect(result.recurringPaths).toEqual([]);
});

test("the identical set twice is `repeating`; a brand-new field is `diverging`; neither is `shrinking`", () => {
  const repeated = attemptProgress([attempt(1, ["d[0].id"]), attempt(2, ["d[0].id"])]);
  expect(repeated.progress).toBe("repeating");
  expect(repeated.escalatesAtAttempt).toBe(2);

  const diverged = attemptProgress([attempt(1, ["d[0].id"]), attempt(2, ["d[0].kind"])]);
  expect(diverged.progress).toBe("diverging");
  expect(diverged.escalatesAtAttempt).toBe(2);
  // `kind` was never named before, so it is not a reappearance.
  expect(diverged.recurringPaths).toEqual([]);
});

test("one attempt, or an attempt with no findings, is `unknown` — missing evidence never reads as convergence", () => {
  expect(attemptProgress([]).progress).toBe("unknown");
  expect(attemptProgress([attempt(1, ["d[0].id"])]).progress).toBe("unknown");
  expect(attemptProgress([attempt(1, ["d[0].id"]), attempt(2, [])]).progress).toBe("unknown");
  expect(attemptProgress([attempt(1, ["d[0].id"]), attempt(2, [])]).escalatesAtAttempt).toBeNull();
});

test("ordering and whitespace do not change the verdict — the set is a set", () => {
  const a = attemptProgress([
    attempt(1, ["d[0].id", "d[0].kind"]),
    attempt(2, [" d[0].kind ", "d[0].id"]),
  ]);
  expect(a.progress).toBe("repeating");
});

test("a live run whose trail has stopped shrinking reads STUCK even while events are flowing", () => {
  /*
   * THE 87 MINUTES. a913c871 was never quiet — it was emitting attempt
   * boundaries the whole time — so no silence threshold could have caught it.
   * This is the arm that does, and the quiet clock below is deliberately
   * healthy so the test cannot pass for the other reason.
   */
  const looping = read(
    withRun(15, { ticket: { ...TICKET, attemptNo: 3 }, attempts: A913C871_ATTEMPTS }),
  );

  expect(looping.liveness).toBe("stuck");
  expect(looping.headline).toBe("retrying, not improving");
  expect(looping.because).toContain("dataExpectations[0].id");
  expect(looping.escalatesAtAttempt).toBe(2);
  // The paths are PUBLISHED on the reading, because the panel paints those rows
  // red and must not re-derive them from a second copy of the trail.
  expect(looping.recurringPaths).toEqual(["dataExpectations[0].id"]);

  // NEGATIVE HALF: the same live run with a shrinking trail is running.
  const converging = read(
    withRun(15, {
      ticket: { ...TICKET, attemptNo: 3 },
      attempts: [
        attempt(1, ["d[0].id", "d[0].kind", "d[0].minRows"]),
        attempt(2, ["d[0].id", "d[0].kind"]),
        attempt(3, ["d[0].id"]),
      ],
    }),
  );
  expect(converging.liveness).toBe("running");
  expect(converging.recurringPaths).toEqual([]);
});

/**
 * THE TRAIL COMES OFF THE VALIDATED BODY, WHICH IS WHAT MAKES IT SAFE TO READ AT
 * ALL — and this test is the one that would have caught the crash if the trail had
 * been wired to the component the obvious way.
 *
 * `attemptProgress` calls `.map`. Until 2026-08-10 the trail was a SEPARATE INPUT
 * to `classifySupervisor`, and the only live source for it was `data.body.attempts`
 * — an unvalidated field on an unvalidated body, read in the component. A 200
 * carrying `{"attempts": 3}` would have thrown INSIDE the classifier, above every
 * arm, including the arm written to survive exactly that body. The classifier reads
 * the trail itself now, after the shape check, and the shape check covers the
 * elements and not merely the array.
 */
test("a wrong-shaped trail is a malformed BODY, not a throw inside the classifier", () => {
  const notAnArray = read(state({ attempts: 3 as unknown as SupervisorState["attempts"] }));
  expect(notAnArray.liveness).toBe("malformed");
  expect(notAnArray.because).toContain("attempts is a number, not an array");

  const badElement = read(
    state({
      attempts: [{ n: 1, at: "2026-08-10T00:00:00.000Z", problems: "nope" }] as unknown as SupervisorState["attempts"],
    }),
  );
  expect(badElement.liveness).toBe("malformed");
  expect(badElement.because).toContain("attempts[0].problems is a string, not an array");

  const objectProblem = read(
    state({
      attempts: [
        { n: 1, at: "2026-08-10T00:00:00.000Z", problems: [{ path: "d[0].id" }] },
      ] as unknown as SupervisorState["attempts"],
    }),
  );
  expect(objectProblem.liveness).toBe("malformed");
  expect(objectProblem.because).toContain("attempts[0].problems holds something that is not a string");

  /*
   * NEGATIVE HALF, TWO WAYS: the EMPTY array the shipped route sends is legal, and
   * a well-formed trail is both legal and compared. A validator that rejected
   * either would put the strip in amber over a healthy supervisor.
   */
  expect(read(state({ attempts: [] })).liveness).toBe("idle");
  expect(read(withRun(15, { attempts: A913C871_ATTEMPTS })).progress).toBe("oscillating");
});

/* ------------------------------------------------------------------ */
/* THE ARM CHECK ITSELF                                                */
/* ------------------------------------------------------------------ */

test("the start-up arm check passes, and it passes by producing SIX DIFFERENT answers", () => {
  const report = armSupervisorStrip();

  expect(report.armed, report.line).toBe(true);
  /*
   * SIX, AND THE SIXTH LANDED IN THE SAME EDIT AS THE SIXTH STATE — which is the
   * second time this paragraph has been rewritten for that reason and the reason it
   * is worth rewriting. `malformed` became an always-on liveness on 2026-08-10 and
   * this count went from four to five; `blocked` landed later the same day and it
   * goes from five to six. An always-on state with no probe is a check that can only
   * observe success, and the count is asserted HERE so that adding a seventh state
   * under a six-probe arm reddens in this file rather than shipping as a confident
   * "6 distinct" about a state nothing measures.
   */
  expect(report.distinct, "the six probes did not resolve to six different states").toBe(6);
  expect(report.probes.filter((probe) => !probe.ok)).toEqual([]);
  expect(report.probes).toHaveLength(11);

  // The line is what a human reads in the console at 07:00, so its content is
  // asserted rather than its existence.
  expect(report.line).toContain("ARM CHECK:");
  expect(report.line).toContain(
    "unreachable · idle · running · stuck · malformed · blocked (6 distinct)",
  );
  /*
   * THE LINE MUST STATE WHAT IS WIRED. This is the same rule the server's boot line
   * is held to: a line that went on describing a five-state strip after the sixth
   * landed would be the honest-absence sentence turning into a lie. These three
   * clauses are the three distinctions this version can make and the previous one
   * could not.
   */
  expect(report.line).toContain("tells a FINISHED queue from an ALL-BLOCKED one");
  expect(report.line).toContain("ticket list reader tells absent/unreachable/malformed/readable apart");
  expect(report.line).toContain("repair cycle tells unreported from null");
  expect(report.line).toContain("escalates a913c871 at attempt 2");
  expect(report.line).toContain("clears a shrinking sequence");
});

test("the arm check's SIX probes are the liveness probes, and the census probes are not counted among them", () => {
  /*
   * THE NEGATIVE HALF OF THE COUNT ITSELF, AND IT CATCHES A REAL WAY TO CHEAT.
   *
   * `distinct` is `new Set(probes.slice(0, LIVENESS_PROBES))`, so the number is only
   * meaningful if the first six probes are the six LIVENESS probes. Append a
   * seventh liveness probe below the census probes and the slice would silently
   * measure the census probe's string instead — a six that counts the wrong six.
   * Asserting the names pins the boundary, which no assertion on the number can.
   */
  const report = armSupervisorStrip();
  expect(report.probes.slice(0, 6).map((probe) => probe.name)).toEqual([
    "unreachable",
    "idle",
    "running",
    "stuck",
    "malformed",
    "blocked",
  ]);
  expect(report.probes.slice(6).map((probe) => probe.name)).toEqual([
    "the three idle endings do not read the same",
    "the ticket list reader tells its four answers apart",
    "the repair cycle tells unreported from null from reported",
    "comparator escalates a913c871 at attempt 2",
    "comparator clears a shrinking sequence",
  ]);
});

test("the arm check FAILS LOUDLY when the classifier is blind — this is the mutation it exists to catch", () => {
  /*
   * The arm check's own negative control, and it cannot be written by mutating
   * the production module from inside a test. So it is written against the
   * property that makes the report meaningful: `armed` is a conjunction of
   * "every probe correct" AND "five distinct answers", and the second clause is
   * what a constant-returning classifier fails. A report built from four
   * identical answers must not be `armed`, and its line must name the state
   * rather than being a bare "failed".
   */
  const report = armSupervisorStrip();
  const collapsed = {
    ...report,
    probes: report.probes.map((probe) => ({ ...probe, got: "running", ok: probe.expected === "running" })),
  };
  const distinct = new Set(collapsed.probes.slice(0, 6).map((probe) => probe.got)).size;

  expect(distinct).toBe(1);
  expect(collapsed.probes.filter((probe) => !probe.ok).length).toBeGreaterThan(0);
  // And the real report is the control for THIS control: it is armed.
  expect(report.armed).toBe(true);
  expect(report.line.startsWith("ARM CHECK FAILED")).toBe(false);
});

/* ------------------------------------------------------------------ */
/* THE VALIDATOR OVER EVERY DECLARED FIELD, AND ITS NEGATIVE HALF      */
/* ------------------------------------------------------------------ */

/**
 * THE TWO BODIES THAT BLANKED THE PAGE AFTER IT WAS DECLARED FIXED, plus one per
 * remaining shape the contract declares.
 *
 * WHY THIS TEST IS A TABLE AND NOT A LIST OF CASES. The first shape arm checked
 * the five fields the classifier's own arms read; the second added the two the
 * detail pane reads. Both were enumerations of KNOWN crash sites, and both were
 * complete on the day they were written. On 2026-08-10 a browser test served
 * `{"lastDefectSignature": {…}}` and got
 *
 *   Uncaught TypeError: signature.slice is not a function
 *     at shortSignature (src/components/supervisor-strip.tsx:74)
 *     at SupervisorStrip -> AppShell -> RootLayout
 *
 * — the same blank page as the original `probe.wired` crash, one field to the
 * left, on a tree whose classifier suite was green. The lesson is not "check
 * `lastDefectSignature` too". It is that the set of fields a COMPONENT reads
 * changes silently and the set the CONTRACT declares does not, so the validator
 * has to be over the contract. Each row below is one declared field carrying the
 * wrong type; every row must be caught, must name the field, and must hand back
 * no snapshot.
 */
const RUN = {
  runId: "run-2026-08-09T21-04-00-713Z-a913c871",
  phase: "spec",
  status: "running",
  quietForMs: 20_000,
} as const;

const REPAIR = {
  patchId: "p-1",
  filesChanged: ["dashboard/src/lib/supervisor.ts"],
  appliedAt: "2026-08-10T00:30:00.000Z",
  rerunPassed: null,
} as const;

const DEFECT = {
  signature: "a1b2c3d4e5f60718",
  failureClass: "spec_manifest_rejected",
  bakeoffCode: null,
  at: "2026-08-10T00:20:00.000Z",
  repairable: true,
} as const;

const WRONG_FIELDS: readonly { readonly over: Record<string, unknown>; readonly names: string }[] = [
  { over: { desired: "paused" }, names: "desired" },
  { over: { changedAt: 17 }, names: "changedAt is a number" },
  { over: { changedBy: null }, names: "changedBy is null" },
  { over: { reason: {} }, names: "reason is an object" },
  { over: { at: null }, names: "at is null" },
  { over: { ticket: [] }, names: "ticket is an array" },
  { over: { ticket: { ...TICKET, ticketKey: {} } }, names: "ticket.ticketKey is an object" },
  { over: { ticket: { ...TICKET, attemptNo: "two" } }, names: "ticket.attemptNo is a string" },
  { over: { ticket: { ...TICKET, maxAttempts: null } }, names: "ticket.maxAttempts is null" },
  { over: { run: 5 }, names: "run is a number" },
  { over: { run: { ...RUN, runId: null } }, names: "run.runId is null" },
  { over: { run: { ...RUN, status: {} } }, names: "run.status is an object" },
  { over: { run: { ...RUN, phase: 3 } }, names: "run.phase is a number" },
  { over: { run: { ...RUN, quietForMs: "42" } }, names: "run.quietForMs is a string" },
  { over: { attempts: {} }, names: "attempts is an object" },
  { over: { attempts: [{ n: "1", at: "x", problems: [] }] }, names: "attempts[0].n is a string" },
  { over: { lastDefect: "a1b2" }, names: "lastDefect is a string" },
  { over: { lastDefect: { ...DEFECT, signature: {} } }, names: "lastDefect.signature is an object" },
  { over: { lastDefect: { ...DEFECT, repairable: "yes" } }, names: "lastDefect.repairable is a string" },
  { over: { lastDefectId: { signature: "a1" } }, names: "lastDefectId is an object" },
  { over: { lastRepair: 7 }, names: "lastRepair is a number" },
  { over: { lastRepair: { ...REPAIR, filesChanged: [7] } }, names: "filesChanged holds something that is not a string" },
  { over: { lastRepair: { ...REPAIR, rerunPassed: "yes" } }, names: "lastRepair.rerunPassed is a string" },
  { over: { lastRepair: { ...REPAIR, patchId: null } }, names: "lastRepair.patchId is null" },
  { over: { lastRepair: { ...REPAIR, appliedAt: null } }, names: "lastRepair.appliedAt is null" },
  { over: { lastPatchId: 12 }, names: "lastPatchId is a number" },
  { over: { queueDepth: "0" }, names: "queueDepth is a string" },
  { over: { queuedRuns: null }, names: "queuedRuns is null" },
  { over: { nextAction: 0 }, names: "nextAction is a number" },
  { over: { nextActionAt: 0 }, names: "nextActionAt is a number" },
  { over: { probe: { ...PROBE, wired: undefined } }, names: "probe.wired is absent" },
  { over: { probe: { ...PROBE, armed: undefined } }, names: "probe.armed is absent" },
  { over: { probe: { ...PROBE, ticketsSeen: "1" } }, names: "probe.ticketsSeen is a string" },
  { over: { probe: { ...PROBE, armNote: undefined } }, names: "probe.armNote is absent" },
  { over: { probe: { ...PROBE, unsourced: undefined } }, names: "probe.unsourced is absent" },
  { over: { probe: { ...PROBE, unsourced: ["attempts", 7] } }, names: "probe.unsourced holds something that is not a string" },
];

test("every declared field is validated: one wrong type is `malformed`, named, and carries no snapshot", () => {
  for (const row of WRONG_FIELDS) {
    const reading = read({ ...state({}), ...row.over } as unknown as SupervisorState);
    expect(reading.liveness, `${row.names} was not caught`).toBe("malformed");
    expect(reading.snapshot, `${row.names} left a snapshot a consumer will dereference`).toBe(null);
    expect(reading.because, `${row.names} was caught without being named`).toContain(
      row.names.split(" is ")[0] ?? row.names,
    );
    expect(reading.because.trim()).not.toBe("");
  }

  /*
   * THE NEGATIVE HALF, AND IT IS THE HALF THAT MATTERS FOR A VALIDATOR. One that
   * rejects everything is exactly as blind as one that rejects nothing, and it
   * fails WORSE: the strip would sit in `malformed` all night over a healthy
   * supervisor, which is the "your backend is down" lie this module was written
   * to prevent. So the four bodies the strip must read are asserted to pass, with
   * every nullable field at BOTH of its legal values.
   */
  expect(read(withRun(20)).liveness).toBe("running");
  expect(read(state({ desired: "stopped" })).liveness).toBe("idle");
  expect(read(withRun(STUCK_AFTER_S + 60)).liveness).toBe("stuck");
  /*
   * EVERY NULLABLE FIELD AT `null` — AND THIS IS THE BODY THE SHIPPED ROUTE
   * ACTUALLY SENDS. `composeSupervisorState` emits `run: null`, `attempts: []`,
   * `lastDefect: null`, `lastRepair: null`, `lastDefectId: null`, `lastPatchId:
   * null` on every idle poll, so a validator that rejected this combination would
   * hold the strip in amber all night over a perfectly healthy supervisor. That is
   * not hypothetical: it is what the previous mirror did, measured against a real
   * server, because it declared `lastRepair` non-nullable among fourteen others.
   */
  const everyNullTaken = read(
    state({
      ticket: null,
      run: null,
      attempts: [],
      lastDefect: null,
      lastDefectId: null,
      lastRepair: null,
      lastPatchId: null,
      nextActionAt: null,
    }),
  );
  expect(everyNullTaken.liveness, "a body with every legal null was rejected").toBe("idle");
  expect(everyNullTaken.snapshot).not.toBe(null);

  const everyValuePresent = read(
    withRun(20, {
      lastDefect: DEFECT,
      lastDefectId: "d-9f21",
      lastPatchId: "p-1",
      nextActionAt: "2026-08-10T01:00:00.000Z",
      lastRepair: { ...REPAIR, rerunPassed: true },
    }),
  );
  expect(everyValuePresent.liveness, "a fully populated body was rejected").toBe("running");
  expect(everyValuePresent.snapshot?.lastRepair?.patchId).toBe("p-1");
});

/* ------------------------------------------------------------------ */
/* THE BODY THE SERVER ACTUALLY SENDS                                  */
/* ------------------------------------------------------------------ */

/**
 * THE TEST THIS WHOLE FILE WAS MISSING, AND THE REASON THE STRIP WAS BLIND.
 *
 * Every other fixture here is built from the CLIENT's own `SupervisorState`, so all
 * of them agree with each other by construction and none of them is evidence about
 * the wire. On 2026-08-10 that was measured the expensive way: the mirror disagreed
 * with `ApiSupervisorState` in fifteen fields, this suite was green, the browser
 * suite was green, three typecheckers were clean — and against a real server booted
 * on a clone of the owner's home the strip read amber `MALFORMED` on every route,
 * naming eight absent fields. An instrument that reads the same amber when the loop
 * is healthy and when it is wedged is not an instrument.
 *
 * `supervisor-wire.golden.json` was GENERATED by running the server's own
 * `composeSupervisorState` (see `fixtures/supervisor-wire.golden.mjs`) and is
 * asserted from both ends: `server/src/supervisor-route.test.ts` deep-equals the
 * composer against it, so server drift reddens THERE; this test classifies it, so
 * client drift reddens HERE. Neither test can be satisfied by editing one side.
 *
 * THREE BODIES, THREE DIFFERENT ANSWERS, WHICH IS THE HALF THAT MAKES IT A TEST.
 * One golden body asserted `!== "malformed"` would pass against a validator that
 * accepted everything. `idle`, `running` and `unreachable` from three real composer
 * outputs cannot.
 */
test("the body composeSupervisorState ACTUALLY produces classifies three ways — not one amber", () => {
  const wire = golden as unknown as Record<string, SupervisorState>;

  /*
   * THE JSON ROUND TRIP IS THE POINT, NOT CEREMONY. `JSON.stringify` DELETES keys
   * whose value is `undefined`, so a server field that is `undefined` rather than
   * `null` arrives ABSENT — and `absent` is a failure wherever the contract says
   * `| null`. Reading the golden through the same transform the wire applies is
   * what makes this test measure the wire and not the file.
   */
  const overWire = (name: string): SupervisorState =>
    JSON.parse(JSON.stringify(wire[name])) as SupervisorState;

  const idle = read(overWire("idle"));
  expect(idle.liveness, `the composer's idle body: ${idle.because}`).toBe("idle");
  expect(idle.snapshot).not.toBe(null);
  // The sentence quotes the SERVER's own reason rather than inventing one, which is
  // the field `supervisor_state.reason` exists to carry.
  expect(idle.because).toContain("the owner pressed stop");
  // And the route's `nextAction` survives the trip: it is the sentence the owner
  // reads to know what will happen next, and the composer promises it is never blank.
  expect(idle.snapshot?.nextAction).toContain("POST /api/supervisor/start");

  const running = read(overWire("claimed"));
  expect(running.liveness, `the composer's claimed body: ${running.because}`).toBe("running");
  expect(running.headline).toBe("spec · attempt 1 of 3");
  expect(running.quietForMs).toBe(42_000);
  expect(running.snapshot?.ticket?.ticketKey).toBe("t-b17e54c98f1a0617");

  /*
   * AND THE THIRD IS THE ONE A STATUS PANEL MOST WANTS TO GET WRONG: the route is
   * up, `desired` reads `running`, and there is no loop behind it. Every field but
   * `probe` is a default nobody chose, so this may not read `running`.
   */
  const unwired = read(overWire("notWired"));
  expect(unwired.liveness).toBe("unreachable");
  expect(unwired.headline).toBe("no supervisor wired");

  // THREE DISTINCT ANSWERS FROM THREE REAL BODIES.
  expect(new Set([idle.liveness, running.liveness, unwired.liveness]).size).toBe(3);

  /*
   * THE FIELD-LEVEL HALF: the golden's own keys are compared with the mirror's, so
   * a field the server ADDS is reported here as a name rather than discovered in a
   * screenshot at 3am. Extra wire fields are not a fault — the validator ignores
   * them — but a mirror that has never heard of one cannot render it.
   */
  const wireKeys = Object.keys(overWire("claimed")).sort();
  const mirrorKeys = Object.keys(state({})).sort();
  expect(wireKeys, `the wire carries fields this mirror does not declare`).toEqual(mirrorKeys);
});

/**
 * A FIELD THE SERVER ADDS DOES NOT TURN A HEALTHY SUPERVISOR AMBER — MEASURED,
 * BECAUSE IT WAS FILED AS A RISK AND THE RISK IS NOT WHERE IT WAS THOUGHT TO BE.
 *
 * The review of the round that wrote this validator warned that "any field the
 * server adds … flips a HEALTHY supervisor to amber", which would make amber the
 * steady state and teach the owner to ignore it — and an owner who ignores amber
 * MALFORMED will ignore amber UNREACHABLE too. `malformedReasons` inspects only the
 * keys the contract DECLARES, so an added field is ignored; this test is that claim
 * as an assertion rather than a reading of the code.
 *
 * WHAT REMAINS TRUE, AND IS ASSERTED BELOW TOO: a field the server DROPS, renames,
 * or leaves `undefined` for `JSON.stringify` to delete IS caught. That is the whole
 * point — the fifteen-field drift this pass fixed was exactly that — and loosening
 * it so that `absent` reads as `null` would put back the blindness the arm exists
 * for. The two halves are one property: extra is fine, missing is not.
 */
test("an added wire field is ignored; a dropped one is not — amber does not become the steady state", () => {
  const wire = golden as unknown as Record<string, SupervisorState>;
  const grown = {
    ...(JSON.parse(JSON.stringify(wire["claimed"])) as Record<string, unknown>),
    // Three plausible next additions: a scalar, an object and an array.
    spendUsd: 1.42,
    lastRepair2: { patchId: "p-2" },
    warnings: ["the loop skipped a tick"],
  };
  const withExtras = read(grown as unknown as SupervisorState);
  expect(withExtras.liveness, `an added field turned the strip amber: ${withExtras.because}`).toBe(
    "running",
  );
  expect(withExtras.snapshot).not.toBe(null);

  // A nested addition, on the object the panel dereferences two levels deep.
  const grownProbe = {
    ...(JSON.parse(JSON.stringify(wire["idle"])) as Record<string, unknown>),
    probe: { ...PROBE, lastTickAt: "2026-08-10T03:00:00.000Z" },
  };
  expect(read(grownProbe as unknown as SupervisorState).liveness).toBe("idle");

  /*
   * AND THE OTHER HALF, ON THE SAME BODY: drop ONE declared key and it is amber with
   * the name in the sentence. Without this, the assertions above are satisfied by a
   * validator that accepts everything — which is the failure mode being guarded, one
   * level up.
   */
  const shrunk = JSON.parse(JSON.stringify(wire["claimed"])) as Record<string, unknown>;
  delete shrunk["queueDepth"];
  const missing = read(shrunk as unknown as SupervisorState);
  expect(missing.liveness).toBe("malformed");
  expect(missing.because).toContain("queueDepth is absent, not a number");

  /*
   * `undefined` IS THE ONE THAT ARRIVES BY ACCIDENT. A server field left `undefined`
   * rather than `null` is DELETED by `JSON.stringify`, so it reaches the client
   * absent — this is the shape of the accident, and it is caught for the same reason.
   */
  const undefinedField = JSON.parse(
    JSON.stringify({ ...(wire["idle"] as unknown as Record<string, unknown>), nextActionAt: undefined }),
  ) as Record<string, unknown>;
  expect(read(undefinedField as unknown as SupervisorState).because).toContain(
    "nextActionAt is absent",
  );
});

/* ------------------------------------------------------------------ */
/* THE ONE SENTENCE ABOUT THE LAST PATCH                               */
/* ------------------------------------------------------------------ */

/**
 * `repairSummary` OWNS A SENTENCE THE WIRE DOES NOT SEND, so it is tested rather
 * than trusted. The previous mirror declared a `lastRepair.summary` field and the
 * strip rendered it; the server has never sent one, which means the panel's repair
 * tooltip read `undefined` against a real backend.
 *
 * FOUR SHAPES, FOUR DIFFERENT SENTENCES. `rerunPassed === null` and
 * `rerunPassed === false` are the difference between waiting and reverting, and a
 * falsy check would print the second over the first.
 */
test("the repair sentence tells no-patch, unfinished, passed and FAILED apart", () => {
  const none = repairSummary(null);
  const waiting = repairSummary(REPAIR);
  const passed = repairSummary({ ...REPAIR, rerunPassed: true });
  const failed = repairSummary({ ...REPAIR, rerunPassed: false });

  expect(none).toBe("no patch has been applied");
  expect(waiting).toContain("has not finished");
  expect(passed).toContain("passed");
  expect(failed).toContain("FAILED");

  // FOUR DISTINCT SENTENCES, none blank — a function returning one constant would
  // pass every assertion above except this one.
  const all = [none, waiting, passed, failed];
  expect(new Set(all).size).toBe(4);
  for (const sentence of all) expect(sentence.trim()).not.toBe("");

  // And the patch id is in it, because that is what the owner greps for.
  expect(passed).toContain("p-1");
});

/**
 * THE FIFTH PROBE'S NEGATIVE CONTROL, WRITTEN THE ONLY WAY IT CAN BE FROM HERE.
 *
 * `armSupervisorStrip` cannot be mutated from inside a test, so the property the
 * report rests on is asserted directly: the malformed probe must produce a
 * liveness NO OTHER PROBE produces. If `malformedReasons` ever returns `null` for
 * the probe's input — the exact mutation applied to prove this test in the round
 * that wrote it — the probe answers `idle`, `distinct` reads 4, `armed` is false
 * and the strip prints "THE SUPERVISOR STRIP IS BLIND".
 */
test("the malformed probe is the fifth DIFFERENT answer, not a fifth copy of one", () => {
  const report = armSupervisorStrip();
  const got = report.probes.slice(0, 5).map((probe) => probe.got);

  expect(got).toEqual(["unreachable", "idle", "running", "stuck", "malformed"]);
  expect(new Set(got).size).toBe(5);

  const malformedProbe = report.probes.find((probe) => probe.name === "malformed");
  expect(malformedProbe?.expected).toBe("malformed");
  expect(malformedProbe?.ok).toBe(true);

  // AND THE COLLAPSE IS DETECTED: drop the fifth answer onto any of the other
  // four and `armed`'s second clause fails, which is what the strip renders the
  // alarm from.
  const collapsed = new Set([...got.slice(0, 4), "idle"]).size;
  expect(collapsed).toBe(4);
  expect(report.armed).toBe(true);
});

/**
 * THE ARM'S OWN CATCH, WHICH EXISTS BECAUSE OF A MUTATION AND NOW HAS A TEST.
 *
 * `armSupervisorStrip` runs inside `useState`'s initialiser — that is the render
 * body, ON THE SERVER AS WELL AS THE CLIENT — and it is the only code in the
 * strip that reaches the classifier before a single byte of wire data exists.
 * React error boundaries do not catch server-render throws, so `RenderGuard`
 * cannot help there: a throw in this one path is a blank page again.
 *
 * MEASURED (mutation M2, 2026-08-10): blinding `malformedReasons` let the arm's
 * missing-`probe` probe fall through to arm 4, which threw `Cannot read
 * properties of undefined (reading 'wired')` during the server render. The suite
 * died with `Timed out waiting 180000ms from config.webServer` — no strip, no
 * field, no clue. The catch turns that into a failed probe with a name on it.
 *
 * THE INPUT IS A BODY WHOSE `probe` GETTER THROWS. No JSON can produce one, and
 * that is deliberate: the point is not to guess which body throws, it is that a
 * classifier which throws for ANY reason is reported rather than fatal. A shape
 * check cannot see a getter, so this is the one input that reaches the catch from
 * outside the module.
 */
test("a probe whose classifier THROWS is a failed probe, not a dead server render", () => {
  const hostile = {} as SupervisorState;
  Object.defineProperty(hostile, "probe", {
    get(): never {
      throw new Error("this body throws when it is read");
    },
    enumerable: true,
  });

  const got = probeLiveness(hostile, null, NOW);
  expect(got).toBe("threw: this body throws when it is read");
  // AND IT MATCHES NO STATE, which is what makes the arm go BLIND rather than
  // quietly counting it as one of the five.
  expect(["running", "idle", "stuck", "unreachable", "malformed"]).not.toContain(got);

  /*
   * THE NEGATIVE HALF: a function that answered `threw: …` for everything would
   * pass the assertion above and make the whole arm useless, so the same helper
   * must still resolve real inputs to real states.
   */
  expect(probeLiveness(withRun(20), null, NOW)).toBe("running");
  expect(probeLiveness(state({ desired: "stopped" }), null, NOW)).toBe("idle");
  expect(probeLiveness(null, new Error("connection refused"), NOW)).toBe("unreachable");
});

/* ------------------------------------------------------------------ */
/* THE MORNING READOUT — "IT FINISHED" vs "IT ALL DIED"                */
/* ------------------------------------------------------------------ */

/**
 * THE MEASURED GAP THIS BLOCK EXISTS FOR, IN ONE SENTENCE.
 *
 * `/api/supervisor` sends `ticket: null` and `queueDepth: 0` both when the loop
 * finished the night's work and when every ticket terminated at `blocked` — the
 * server counts only rows in state `queued` (`http.ts:1256`), and `done`,
 * `blocked` and `abandoned` are all "not queued and not claimed". The strip
 * rendered `IDLE / idle, queue empty` for both, byte for byte. Eight hours of the
 * owner's subscription window and a readout that could not tell success from total
 * failure.
 *
 * EVERY TEST BELOW HAS A NEGATIVE HALF, and for these the negative half is not
 * decoration: the easiest way to "fix" this gap is a branch that reports `blocked`
 * whenever a census exists, which would paint a healthy finished queue red.
 */

test("a finished queue, an all-blocked queue and no census are THREE DIFFERENT readings — the gap this round closed", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });

  const finished = read(settled, { censusBody: census([DONE_ROW, { ...DONE_ROW, ticketKey: "t-2" }]) });
  const died = read(settled, { censusBody: census([BLOCKED_ROW, { ...BLOCKED_ROW, ticketKey: "t-b2" }]) });
  const blind = read(settled);

  // THE POSITIVE HALVES, each naming its own count rather than a mood.
  expect(finished.liveness).toBe("idle");
  expect(finished.headline).toBe("queue finished · 2 done");
  expect(finished.because).toContain("2 of 2");

  expect(died.liveness).toBe("blocked");
  expect(died.headline).toBe("queue ended · 2 blocked");
  expect(died.because).toContain("2 of 2 ticket(s) ended blocked or abandoned");

  /*
   * THE NEGATIVE HALF, AND IT IS THE WHOLE POINT: the three readings must be
   * MUTUALLY DIFFERENT. A branch that always answered `blocked` when a census
   * exists would pass the second assertion above and fail here, and so would a
   * headline that read the same for a finished queue as for one nobody can see.
   */
  const verdicts = new Set([
    `${finished.liveness}·${finished.headline}`,
    `${died.liveness}·${died.headline}`,
    `${blind.liveness}·${blind.headline}`,
  ]);
  expect(verdicts.size, "two of the three endings render identically").toBe(3);

  // And the no-census reading must not have invented either count.
  expect(blind.liveness).toBe("idle");
  expect(blind.headline).toBe("idle, queue empty");
  expect(blind.census.counts).toBeNull();
  expect(blind.because).toContain("no ticket census has arrived yet");
});

test("a MIXED terminal queue counts the failures and does not round them away", () => {
  const mixed = read(state({ desired: "running", ticket: null, queueDepth: 0 }), {
    censusBody: census([
      DONE_ROW,
      { ...DONE_ROW, ticketKey: "t-d2" },
      { ...DONE_ROW, ticketKey: "t-d3" },
      BLOCKED_ROW,
      { ticketKey: "t-aband", state: "abandoned", updatedAt: "2026-08-10T01:00:00.000Z" },
    ]),
  });

  expect(mixed.liveness).toBe("blocked");
  // `blocked` AND `abandoned` ARE ADDED TOGETHER: a headline reading "1 blocked"
  // over a queue with one of each would undercount the failure by half.
  expect(mixed.headline).toBe("queue ended · 2 blocked");
  expect(mixed.because).toContain("2 of 5");
  expect(mixed.because).toContain("3 done");
  // THE NEGATIVE HALF: three successes did not make this a success.
  expect(mixed.liveness).not.toBe("idle");
});

test("a queue that is still working is NOT reported as finished, in either direction", () => {
  const settled = state({ desired: "stopped", ticket: null, queueDepth: 0 });

  // A backlog row: not terminal, so no verdict — and NOT `blocked` either, even
  // though a blocked row is sitting right beside it.
  const backlog = read(settled, {
    censusBody: census([BLOCKED_ROW, { ticketKey: "t-q", state: "queued" }]),
  });
  expect(backlog.liveness).toBe("idle");
  expect(backlog.headline).toBe("stopped, nothing in flight");
  expect(backlog.census.counts?.backlog).toBe(1);

  // An in-flight row: same refusal. THE DELIBERATE NON-ARM — two routes polled 5 s
  // and 15 s apart disagree for one tick as a matter of course, so this is reported
  // as a count and never as a red verdict.
  const inFlight = read(settled, {
    censusBody: census([DONE_ROW, { ticketKey: "t-r", state: "running" }]),
  });
  expect(inFlight.liveness).toBe("idle");
  expect(inFlight.headline).toBe("stopped, nothing in flight");
  expect(inFlight.census.counts?.inFlight).toBe(1);

  // THE POSITIVE CONTROL FOR BOTH: the same census with the open row removed DOES
  // produce a verdict, so the refusals above are about the open row and not about
  // the arm being unreachable.
  const settledRunning = state({ desired: "running", ticket: null, queueDepth: 0 });
  expect(read(settledRunning, { censusBody: census([BLOCKED_ROW]) }).liveness).toBe("blocked");
  expect(read(settledRunning, { censusBody: census([DONE_ROW]) }).headline).toBe(
    "queue finished · 1 done",
  );
});

test("an EMPTY census is 'never given anything', not 'finished'", () => {
  const empty = read(state({ desired: "running", ticket: null, queueDepth: 0 }), {
    censusBody: census([]),
  });
  expect(empty.liveness).toBe("idle");
  expect(empty.headline).toBe("idle, no tickets filed");
  expect(empty.because).toContain("No tickets have ever been filed");
  // THE NEGATIVE HALF: zero tickets is not a finished queue and not a failure.
  expect(empty.headline).not.toContain("finished");
  expect(empty.liveness).not.toBe("blocked");
});

test("a ticket state this build does not recognise is counted NOWHERE and blocks every verdict", () => {
  /*
   * The server types `state` as a string so a ninth state cannot break this client,
   * which means a ninth state WILL arrive. Folding it into any bucket would let a
   * queue full of an unreadable word report "finished, 3 done" — a confident answer
   * built out of something the build could not read.
   */
  const ninth = read(state({ desired: "running", ticket: null, queueDepth: 0 }), {
    censusBody: census([DONE_ROW, { ticketKey: "t-new", state: "quarantined" }]),
  });
  expect(ninth.census.counts?.unrecognised).toEqual(["quarantined"]);
  expect(ninth.census.counts?.done).toBe(1);
  expect(ninth.headline).toBe("idle, queue empty");
  expect(ninth.headline).not.toContain("finished");
  expect(ninth.census.note).toContain("this build does not recognise");

  // THE NEGATIVE HALF: remove the unknown state and the same census DOES claim it.
  const known = read(state({ desired: "running", ticket: null, queueDepth: 0 }), {
    censusBody: census([DONE_ROW]),
  });
  expect(known.headline).toBe("queue finished · 1 done");
});

test("censusCounts buckets the eight states and adds none of them twice", () => {
  const counts = censusCounts([
    { ticketKey: "a", state: "queued" },
    { ticketKey: "b", state: "claimed" },
    { ticketKey: "c", state: "running" },
    { ticketKey: "d", state: "repairing" },
    { ticketKey: "e", state: "waiting" },
    { ticketKey: "f", state: "done" },
    { ticketKey: "g", state: "blocked" },
    { ticketKey: "h", state: "abandoned" },
  ]);
  expect(counts).toEqual({
    total: 8,
    backlog: 1,
    inFlight: 4,
    done: 1,
    failed: 2,
    unrecognised: [],
  });
  // Every row landed in exactly one bucket — the arithmetic no `toEqual` on
  // individual fields would catch if two buckets both claimed a state.
  expect(counts.backlog + counts.inFlight + counts.done + counts.failed).toBe(counts.total);
  // AND THE NEGATIVE HALF: a blank state is not silently a bucket.
  const blank = censusCounts([{ ticketKey: "z", state: "  " }]);
  expect(blank.unrecognised).toEqual(["(blank)"]);
  expect(blank.done + blank.failed + blank.backlog + blank.inFlight).toBe(0);
});

test("censusIsTerminal refuses on each of its four disqualifiers, and clears when none applies", () => {
  const base = { total: 2, backlog: 0, inFlight: 0, done: 2, failed: 0, unrecognised: [] as string[] };
  expect(censusIsTerminal(base)).toBe(true);
  expect(censusIsTerminal({ ...base, total: 0, done: 0 })).toBe(false);
  expect(censusIsTerminal({ ...base, backlog: 1 })).toBe(false);
  expect(censusIsTerminal({ ...base, inFlight: 1 })).toBe(false);
  expect(censusIsTerminal({ ...base, unrecognised: ["quarantined"] })).toBe(false);
});

/* ------------------------------------------------------------------ */
/* THE CENSUS'S FOUR WAYS OF NOT BEING A CENSUS                        */
/* ------------------------------------------------------------------ */

test("absent, unreachable and malformed are three DIFFERENT census readings, and none of them invents a count", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });

  const absent = read(settled).census;
  const unreachable = read(settled, { censusError: new Error("404 not found") }).census;
  const malformed = read(settled, { censusBody: { tickets: "not an array" } }).census;
  const readable = read(settled, { censusBody: census([DONE_ROW]) }).census;

  expect(absent.availability).toBe("absent");
  expect(unreachable.availability).toBe("unreachable");
  expect(malformed.availability).toBe("malformed");
  expect(readable.availability).toBe("readable");

  // Four DIFFERENT sentences, not four spellings of "no data".
  expect(new Set([absent.note, unreachable.note, malformed.note, readable.note]).size).toBe(4);
  expect(unreachable.note).toContain("404 not found");
  expect(malformed.note).toContain("tickets is a string, not an array");
  expect(malformed.note).toContain("Waiting will not fix this one");

  /*
   * THE NEGATIVE HALF THAT MATTERS MOST: only the readable one carries counts. A
   * reading that answered `counts: {total: 0, …}` for a 404 would let the strip
   * print "0 blocked" about a route that does not exist — a number with no data
   * behind it, which is the exact class of defect this whole file is against.
   */
  expect(absent.counts).toBeNull();
  expect(unreachable.counts).toBeNull();
  expect(malformed.counts).toBeNull();
  expect(readable.counts?.total).toBe(1);
  for (const reading of [absent, unreachable, malformed]) {
    expect(reading.rows).toEqual([]);
    expect(reading.failedRows).toEqual([]);
    expect(reading.note.trim()).not.toBe("");
  }
});

test("a census whose ROWS are wrong is malformed and NAMES the row and the field", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });
  const cases: readonly { readonly body: unknown; readonly names: string }[] = [
    { body: { tickets: [{ state: "done" }] }, names: "tickets[0].ticketKey is absent, not a string" },
    { body: { tickets: [{ ticketKey: "a" }] }, names: "tickets[0].state is absent, not a string" },
    { body: { tickets: [DONE_ROW, "nope"] }, names: "tickets[1] is a string, not an object" },
    {
      body: { tickets: [{ ...DONE_ROW, nextAction: { text: "x" } }] },
      names: "tickets[0].nextAction is an object, not a string or null",
    },
    {
      body: { tickets: [{ ...DONE_ROW, attemptNo: "two" }] },
      names: "tickets[0].attemptNo is a string, not a number or null",
    },
    { body: { tickets: [DONE_ROW], probe: 7 }, names: "probe is a number rather than an object or null" },
    {
      body: { tickets: [DONE_ROW], probe: { armed: "yes" } },
      names: "probe.armed is a string, not a boolean or null",
    },
    {
      body: { tickets: [DONE_ROW], probe: { at: 1_754_000_000 } },
      names: "probe.at is a number, not a string or null",
    },
    /*
     * `attachments` IS NESTED AND ITS MEMBERS ARE CHECKED THOUGH NOTHING RENDERS
     * THEM YET. That is the lesson from `lastDefect`, whose members were validated
     * before it had a producer precisely because the day a panel `.slice`s one, an
     * object there is `signature.slice is not a function` out of RootLayout.
     */
    {
      body: { tickets: [{ ...DONE_ROW, attachments: 3 }] },
      names: "tickets[0].attachments is a number rather than an object or null",
    },
    {
      body: { tickets: [{ ...DONE_ROW, attachments: { manifest: {} } }] },
      names: "tickets[0].attachments.manifest is an object, not a string or null",
    },
    {
      body: { tickets: [{ ...DONE_ROW, attachments: { carriedIntoRun: "no" } }] },
      names: "tickets[0].attachments.carriedIntoRun is a string, not a boolean or null",
    },
    {
      body: { tickets: [{ ...DONE_ROW, attachments: { images: "two" } }] },
      names: "tickets[0].attachments.images is a string, not a number or null",
    },
    { body: [DONE_ROW], names: "the body is an array, not an object" },
    { body: 12, names: "the body is a number, not an object" },
  ];

  for (const row of cases) {
    const reading = read(settled, { censusBody: row.body }).census;
    expect(reading.availability, `${JSON.stringify(row.body)} was not caught`).toBe("malformed");
    expect(reading.note).toContain(row.names);
    // The invariant: a body that FAILED cannot reach a consumer.
    expect(reading.counts).toBeNull();
    expect(reading.rows).toEqual([]);
  }

  /*
   * THE POSITIVE CONTROL FOR THE WHOLE TABLE, and it is the assertion that stops
   * this validator being the fifteen-field amber all over again: the MINIMAL body a
   * first version of the route could send — two required fields per row and nothing
   * else — must be READABLE, and every optional column must be reported as absent
   * rather than as null.
   */
  const minimal = read(settled, { censusBody: census([DONE_ROW, BLOCKED_ROW]) }).census;
  expect(minimal.availability).toBe("readable");
  const bare = read(settled, {
    censusBody: census([{ ticketKey: "a", state: "done" }, { ticketKey: "b", state: "blocked" }]),
  }).census;
  expect(bare.availability).toBe("readable");
  expect(bare.counts?.failed).toBe(1);
  /*
   * THE LIST IS `ApiSupervisorTicketRow`'s COLUMNS MINUS THE TWO REQUIRED ONES,
   * AND ASSERTING IT WHOLE IS WHAT MAKES A MIRROR DRIFT VISIBLE HERE RATHER THAN
   * ON SCREEN. The first version of this list carried `lastRunId` — a name the wire
   * has never sent — and was missing five it does; the panel would have printed
   * "this build's census does not carry lastRunId" for ever, a confident sentence
   * about a gap that did not exist.
   */
  expect(bare.absentFields).toEqual([
    "title",
    "modelId",
    "attemptNo",
    "maxAttempts",
    "nextAction",
    "nextActionAt",
    "enqueuedAt",
    "updatedAt",
    "runId",
    "currentRunId",
    "lastClass",
    "lastDefectId",
    "patchId",
    "attachments",
  ]);
});

/**
 * ONE ROW SHAPED EXACTLY LIKE `ApiSupervisorTicketRow`, FIELD FOR FIELD.
 *
 * NOT A CONVENIENCE FIXTURE — THE DRIFT DETECTOR. `api-types.ts` records what a
 * mirror that disagreed with the wire in fifteen fields cost: amber `MALFORMED` on
 * every route, "nothing crashed, and nothing was readable either", and three green
 * typecheckers that could not see it because nothing imports both declarations. The
 * census route landed while this readout was being written, so its shape is
 * transcribed here from the server's own declaration and asserted to read with ZERO
 * absent columns. A column the server renames appears in `absentFields` and reddens
 * the test below; a column this mirror invents does the same.
 */
const WIRE_ROW = {
  ticketKey: "t-b79ff5e2a1b314e4",
  title: "a portfolio site",
  state: "blocked",
  modelId: "claude-opus-4-6",
  attemptNo: 3,
  maxAttempts: 3,
  nextAction: "no repair driver is wired; run tools/repair/cycle.mjs against a copy by hand",
  nextActionAt: null,
  runId: "run-2026-08-10T13-11-12-836Z-54927ebc",
  currentRunId: null,
  lastClass: "structural",
  lastDefectId: "a1b2c3d4e5f60718",
  patchId: null,
  enqueuedAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T06:00:00.000Z",
  attachments: {
    manifest: "readable",
    images: 2,
    documents: 1,
    capture: false,
    motion: false,
    carriedIntoRun: false,
  },
} as const;

const WIRE_PROBE = {
  ticketsSeen: 1,
  manifestsUnreadable: 0,
  attachmentsDropped: 1,
  armed: true,
  armNote: "the route distinguished its own outputs",
  at: "2026-08-10T06:00:01.000Z",
} as const;

test("the ticket list the ROUTE actually declares reads with zero absent columns — the mirror-drift detector", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });
  const reading = read(settled, {
    censusBody: { tickets: [WIRE_ROW], probe: WIRE_PROBE },
  });

  expect(reading.census.availability).toBe("readable");
  /*
   * ZERO. A name in this list means the wire dropped a column or this mirror
   * invented one, and either way the panel would be printing a sentence about a
   * gap. The empty array is the assertion; a `toHaveLength(0)` would not name the
   * offender when it fails.
   */
  expect(reading.census.absentFields).toEqual([]);
  expect(reading.census.counts).toEqual({
    total: 1,
    backlog: 0,
    inFlight: 0,
    done: 0,
    failed: 1,
    unrecognised: [],
  });
  expect(reading.liveness).toBe("blocked");
  expect(reading.because).toContain("run tools/repair/cycle.mjs");

  // THE PROBE'S OWN NUMBERS REACH THE PANEL, including the alarm that only fires
  // when it is non-zero.
  expect(reading.census.probeNote).toContain("armed=true");
  expect(reading.census.probeNote).toContain("1 row(s) read");
  expect(reading.census.probeNote).toContain("2026-08-10T06:00:01.000Z");
  expect(reading.census.probeNote).toContain("did NOT reach their run");
  // AND THE NEGATIVE HALF: a zero count is silent rather than printed as an alarm.
  expect(reading.census.probeNote).not.toContain("would not parse");
});

test("`absent` and `null` are different answers for a census column, and a column present on SOME rows is not called absent", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });

  // KEY MISSING on every row -> reported absent.
  const missing = read(settled, {
    censusBody: census([{ ticketKey: "a", state: "done" }]),
  }).census;
  expect(missing.absentFields).toContain("lastClass");

  // KEY PRESENT AND null -> NOT absent. The route carries the column; this ticket
  // has no value. Calling that absent would tell the owner the build cannot report
  // a field it reports perfectly well.
  const explicitNull = read(settled, {
    censusBody: census([{ ticketKey: "a", state: "done", lastClass: null }]),
  }).census;
  expect(explicitNull.availability).toBe("readable");
  expect(explicitNull.absentFields).not.toContain("lastClass");

  // PRESENT ON ONE ROW OF TWO -> the route carries it, so it is not absent.
  const partial = read(settled, {
    censusBody: census([
      { ticketKey: "a", state: "done", lastClass: "structural" },
      { ticketKey: "b", state: "done" },
    ]),
  }).census;
  expect(partial.absentFields).not.toContain("lastClass");
});

/* ------------------------------------------------------------------ */
/* ITEM B — THE SENTENCE THAT SAYS WHAT TO RUN BY HAND                 */
/* ------------------------------------------------------------------ */

test("a blocked ticket's own next_action reaches the reading — and its absence is named, never blank", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });

  const withAction = read(settled, { censusBody: census([BLOCKED_ROW]) });
  expect(withAction.liveness).toBe("blocked");
  expect(withAction.because).toContain("run tools/repair/cycle.mjs against a copy by hand");
  // The failure class rides along, because "what do I run" is easier to act on
  // when you know what broke.
  expect(withAction.because).toContain("(structural)");

  /*
   * THE NEGATIVE HALF, AND IT IS THE ONE THAT KEEPS THIS HONEST WHEN LANE 2 LANDS
   * A ROUTE WITHOUT THE COLUMN. A blank would read as "there is nothing to do",
   * which is the opposite of true for a blocked ticket.
   */
  const noColumn = read(settled, {
    censusBody: census([{ ticketKey: "t-b", state: "blocked" }]),
  });
  expect(noColumn.liveness).toBe("blocked");
  expect(noColumn.because).toContain("the ticket list does not carry next_action");
  expect(noColumn.because).not.toContain("undefined");

  // AND THE THIRD ANSWER: the column IS on the wire and empty for this ticket.
  // "the route does not report this" and "the route reports it and it is blank"
  // are different facts about different things.
  const emptyColumn = read(settled, {
    censusBody: census([{ ticketKey: "t-b", state: "blocked", nextAction: "" }]),
  });
  expect(emptyColumn.because).toContain("carries no next_action text");
  expect(emptyColumn.because).toContain("the column is on the wire and empty");
});

test("the newest failed ticket is the one whose sentence is shown, and a row with no clock does not jump the queue", () => {
  const rows = [
    { ticketKey: "t-old", state: "blocked", updatedAt: "2026-08-10T01:00:00.000Z", nextAction: "OLD" },
    { ticketKey: "t-new", state: "blocked", updatedAt: "2026-08-10T05:00:00.000Z", nextAction: "NEW" },
  ];
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });
  const reading = read(settled, { censusBody: census(rows) });
  expect(reading.census.failedRows.map((row) => row.ticketKey)).toEqual(["t-new", "t-old"]);
  expect(reading.because).toContain("NEW");
  expect(reading.because).not.toContain("OLD");

  /*
   * A ROW WITH NO `updatedAt` SORTS LAST. THE NEGATIVE HALF: if a missing column
   * sorted first it would decide which failure the owner reads about, and a first
   * version of the route that omits `updated_at` would silently pick at random.
   */
  const withClockless = read(settled, {
    censusBody: census([{ ticketKey: "t-noclock", state: "blocked", nextAction: "CLOCKLESS" }, ...rows]),
  });
  expect(withClockless.census.failedRows.map((row) => row.ticketKey)).toEqual([
    "t-new",
    "t-old",
    "t-noclock",
  ]);
  expect(withClockless.because).toContain("NEW");
});

test("failedTicketAction answers nothing for no rows, rather than a sentence about nothing", () => {
  expect(failedTicketAction([])).toBe("");
  expect(failedTicketAction([{ ticketKey: "a", state: "blocked", nextAction: "do X" }])).toContain(
    "do X",
  );
});

/* ------------------------------------------------------------------ */
/* ITEM C — THE REPAIR CYCLE, AND ITS THREE-WAY ABSENCE                */
/* ------------------------------------------------------------------ */

test("the repair cycle tells UNREPORTED from an explicit null from a real cycle", () => {
  const unreported = repairCycleSummary(undefined);
  const none = repairCycleSummary(null);
  const refused = repairCycleSummary({
    signature: "a".repeat(64),
    outcomeKind: "refused",
    outcomeCode: "ALREADY_RULED_OUT",
    verdict: "REFUSED",
    applied: false,
    detail: "the ledger already ruled this proposal out.",
  });

  expect(unreported.kind).toBe("unreported");
  expect(none.kind).toBe("null");
  expect(refused.kind).toBe("reported");

  /*
   * THE THREE SENTENCES MUST DIFFER, and the pair that matters is the first two.
   * `repairSummary(null)` — the function that shipped before this one — answers "no
   * patch has been applied" for BOTH, which is how a dashboard tells its owner the
   * self-repair worked when the self-repair does not exist.
   */
  expect(new Set([unreported.sentence, none.sentence, refused.sentence]).size).toBe(3);
  expect(unreported.sentence).toContain("NOT the same as 'no repair was attempted'");
  expect(none.sentence).toContain("explicit null, not a missing field");
  expect(refused.label).toBe("REFUSED");
  expect(refused.sentence).toContain("ALREADY_RULED_OUT");
  expect(refused.sentence).toContain("no file was changed");

  // AND THE OLD FUNCTION IS THE CONTROL FOR THE NEW ONE: it cannot see any of this,
  // which is why the new one exists rather than replacing it.
  expect(repairSummary(null)).toBe("no patch has been applied");
});

test("an APPLIED patch with no rollback point is named as an edit, not left blank", () => {
  const applied = repairCycleSummary({
    signature: "b".repeat(64),
    outcomeKind: "applied",
    verdict: "ACCEPTED",
    applied: true,
  });
  expect(applied.sentence).toContain("A PATCH WAS APPLIED");
  expect(applied.sentence).toContain("NO ROLLBACK POINT WAS RECORDED");
  expect(applied.sentence).toContain("an edit, not a repair");
  // It also names the fields the producer did not send, rather than printing gaps.
  expect(applied.sentence).toContain("outcomeCode");

  // THE NEGATIVE HALF: with a rollback point that alarm must be GONE, or it is a
  // sentence that fires on every applied patch and means nothing.
  const withRollback = repairCycleSummary({
    signature: "b".repeat(64),
    outcomeKind: "applied",
    outcomeCode: "APPLIED",
    verdict: "ACCEPTED",
    applied: true,
    rollbackPoint: "stash@{0}",
  });
  expect(withRollback.sentence).toContain("rollback point stash@{0}");
  expect(withRollback.sentence).not.toContain("NO ROLLBACK POINT");
  expect(withRollback.sentence).not.toContain("Fields the producer did not send");
});

test("`applied: false`, `applied: null` and an absent `applied` are three different sentences", () => {
  const cycle = { signature: "c".repeat(64), verdict: "COULD_NOT_REPRODUCE" };
  const no = repairCycleSummary({ ...cycle, applied: false });
  const dunno = repairCycleSummary({ ...cycle, applied: null });
  const silent = repairCycleSummary(cycle);

  expect(no.sentence).toContain("no file was changed");
  expect(dunno.sentence).toContain("does not know whether the tree was changed");
  expect(silent.sentence).toContain("whether the tree was changed is not reported");
  expect(new Set([no.sentence, dunno.sentence, silent.sentence]).size).toBe(3);
  /*
   * A falsy check on `applied` would print "no file was changed" over all three —
   * a claim about the working tree that two of them do not support.
   */
});

/* ------------------------------------------------------------------ */
/* THE VALIDATION INVARIANT, EXTENDED TO THE FIELDS ADDED TODAY        */
/* ------------------------------------------------------------------ */

test("an ABSENT `lastRepairCycle` does not make the body malformed — this is the regression that blanked the page twice", () => {
  /*
   * THE MOST DANGEROUS THING IN THIS ROUND, WRITTEN AS A TEST.
   *
   * `malformedReasons` rejects `absent` wherever the contract says `| null`, and
   * that rule is right for a field the server always sends. Applying it to a field
   * with NO PRODUCER would turn today's real body malformed and paint amber
   * `MALFORMED` on every route in the app — the fifteen-field failure recorded in
   * `api-types.ts`, whose outcome was "Nothing crashed, and nothing was readable
   * either". `grep -rn lastRepairCycle dashboard/server/src` was 0 when this landed.
   */
  const today = read(state({ desired: "running", ticket: null, queueDepth: 0 }));
  expect(today.liveness).not.toBe("malformed");
  expect(today.snapshot).not.toBeNull();

  // Present-and-null is legal too, and is a DIFFERENT sentence from absent.
  const explicitNull = read(
    state({ desired: "running", ticket: null, queueDepth: 0, lastRepairCycle: null }),
  );
  expect(explicitNull.liveness).not.toBe("malformed");
  expect(repairCycleSummary(explicitNull.snapshot?.lastRepairCycle).kind).toBe("null");
  expect(repairCycleSummary(today.snapshot?.lastRepairCycle).kind).toBe("unreported");

  // A REAL VALUE IS LEGAL AND READABLE.
  const present = read(
    state({
      desired: "running",
      ticket: null,
      queueDepth: 0,
      lastRepairCycle: { outcomeCode: "NO_PATCH_AUTHOR", verdict: "NO_PATCH_AUTHOR", applied: false },
    }),
  );
  expect(present.liveness).not.toBe("malformed");
  expect(repairCycleSummary(present.snapshot?.lastRepairCycle).label).toBe("NO_PATCH_AUTHOR");
});

test("a WRONG-TYPED `lastRepairCycle` member IS caught, named, and carries no snapshot", () => {
  /*
   * The other half of the optional-field rule: not required, but checked if
   * present. `repairCycleSummary` calls `.trim()` on four of these fields, so a
   * `rollbackPoint` that arrived as an object is the `signature.slice is not a
   * function` crash out of RootLayout with a new field name.
   */
  const cases: readonly { readonly value: unknown; readonly names: string }[] = [
    { value: 7, names: "lastRepairCycle is a number rather than an object or null" },
    { value: { rollbackPoint: {} }, names: "lastRepairCycle.rollbackPoint is an object, not a string or null" },
    { value: { applied: "yes" }, names: "lastRepairCycle.applied is a string, not a boolean or null" },
    { value: { verdict: [] }, names: "lastRepairCycle.verdict is an array, not a string or null" },
    { value: { detail: 3 }, names: "lastRepairCycle.detail is a number, not a string or null" },
  ];
  for (const row of cases) {
    const reading = read(
      state({ lastRepairCycle: row.value } as unknown as Partial<SupervisorState>),
    );
    expect(reading.liveness, `${JSON.stringify(row.value)} was not caught`).toBe("malformed");
    expect(reading.because).toContain(row.names);
    // THE INVARIANT: a failing body publishes NO snapshot, so no consumer can
    // dereference the field that was wrong.
    expect(reading.snapshot).toBeNull();
  }
});

test("a body that clears the census validator cannot make a consumer throw, whatever the consumer reads", () => {
  /*
   * The census's half of the invariant `malformedReasons` states for the state
   * body. The proof method is the same: take a body with every optional column
   * OMITTED — the shape most likely to make a consumer dereference `undefined` —
   * and drive the things that actually read it.
   */
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });
  const reading = read(settled, {
    censusBody: census([
      { ticketKey: "a", state: "blocked" },
      { ticketKey: "b", state: "done" },
      { ticketKey: "c", state: "quarantined" },
    ]),
  });
  const rows = reading.census.rows;
  expect(() => censusCounts(rows)).not.toThrow();
  expect(() => failedTicketAction(reading.census.failedRows)).not.toThrow();
  // The two things a component does with each row: string concatenation and a
  // `.trim()` on an optional column.
  expect(() =>
    rows.map((row) => `${row.ticketKey}·${row.state}·${(row.lastClass ?? "").trim()}`).join(),
  ).not.toThrow();
  expect(reading.census.probeNote).toContain("sent NO arm check");
});

test("the ticket list route's own probe is rendered when it sends one, and its ABSENCE never reads as armed", () => {
  const settled = state({ desired: "running", ticket: null, queueDepth: 0 });

  const noProbe = read(settled, { censusBody: census([DONE_ROW]) }).census;
  /*
   * AN ABSENT PROBE IS DRIFT, NOT A BUILD LIMITATION.
   * `ApiSupervisorTicketsResponse` has exactly two keys and `probe` is one of them,
   * so the shipping route always sends it. A sentence that read as normal here
   * would be the `lastRunId` failure inverted: the panel calmly describing a
   * dropped field as expected.
   */
  expect(noProbe.probeNote).toContain("sent NO arm check");
  expect(noProbe.probeNote).toContain("a field has been dropped");
  expect(noProbe.probeNote).not.toContain("armed=true");

  const withProbe = read(settled, {
    censusBody: census([DONE_ROW], {
      probe: {
        armed: false,
        ticketsSeen: 1,
        manifestsUnreadable: 2,
        armNote: "the route could not tell its outputs apart",
      },
    }),
  }).census;
  expect(withProbe.probeNote).toContain("armed=false");
  expect(withProbe.probeNote).toContain("could not tell its outputs apart");
  expect(withProbe.probeNote).toContain("2 ticket manifest(s) would not parse");

  // A probe with SOME fields is reported field by field — "not reported" per field
  // rather than a blank or an invented default.
  const partial = read(settled, {
    censusBody: census([DONE_ROW], { probe: { ticketsSeen: 4 } }),
  }).census;
  expect(partial.probeNote).toContain("armed=not reported");
  expect(partial.probeNote).toContain("4 row(s)");
  expect(partial.probeNote).toContain("at an unreported time");
  expect(partial.probeNote).toContain("the route sent no arm note");
});

test("the ticket list is read on EVERY arm, including the ones that never look at it", () => {
  /*
   * The census is a different route from the state, so a 404 on one says nothing
   * about the other — and a reading whose `census` were only filled on the arm that
   * uses it would give the panel two meanings for the same empty region.
   */
  const body = census([DONE_ROW, BLOCKED_ROW]);

  // Arm 1: nothing was ever read from the STATE route.
  const unreachable = read(null, { error: new Error("connection refused"), censusBody: body });
  expect(unreachable.liveness).toBe("unreachable");
  expect(unreachable.census.counts?.failed).toBe(1);

  // Arm 3b: the state route answered with rubbish.
  const malformed = read({ nonsense: true } as unknown as SupervisorState, { censusBody: body });
  expect(malformed.liveness).toBe("malformed");
  expect(malformed.census.counts?.done).toBe(1);

  // Arm 11: a healthy running run. The census does not override a live verdict.
  const running = read(withRun(20), { censusBody: body });
  expect(running.liveness).toBe("running");
  expect(running.census.counts?.total).toBe(2);
});

test("probeVerdict reports a THROW as an answer on all three of its fields, not as a dead render", () => {
  /*
   * `armSupervisorStrip` runs inside `useState`'s initialiser — in the render body,
   * ON THE SERVER — where React error boundaries do not catch. The existing test for
   * `probeLiveness` bought that guarantee with a measured `Timed out waiting
   * 180000ms from config.webServer`; `probeVerdict` reads `.headline` as well, so it
   * needs the same guarantee on the same hostile input.
   */
  const hostile = {} as unknown as SupervisorState;
  Object.defineProperty(hostile, "probe", {
    get() {
      throw new Error("the body fought back");
    },
  });
  const verdict = probeVerdict(hostile, null, NOW);
  expect(verdict.liveness).toContain("threw:");
  expect(verdict.headline).toContain("threw:");
  expect(verdict.verdict).toContain("the body fought back");

  // THE POSITIVE CONTROL: a normal body produces a normal verdict on all three.
  const healthy = probeVerdict(withRun(20), null, NOW);
  expect(healthy.liveness).toBe("running");
  expect(healthy.verdict).toBe(`running · ${healthy.headline}`);
});

test("a terminal queue under a DRAINED supervisor still says who stopped it, and a running one does not pad the sentence", () => {
  /*
   * WHAT ARM 6b BROKE ON ITS WAY IN, PINNED. The fall-through arm answers a
   * non-running supervisor with `${changedBy} set it to ${desired}: ${reason}` —
   * the only place this page says WHO drained the loop. ARM 6b fires regardless of
   * `desired`, so without the clause below a drained supervisor whose tickets had
   * all finished read "queue finished · 2 done" with no hint that nothing more will
   * be claimed, and the owner would wait all morning for a seventh ticket.
   */
  const drained = read(
    state({
      desired: "stopped",
      ticket: null,
      queueDepth: 0,
      changedBy: "guard",
      reason: "the nightly budget ran out",
    }),
    { censusBody: census([DONE_ROW, { ...DONE_ROW, ticketKey: "t-2" }]) },
  );
  expect(drained.liveness).toBe("idle");
  // The verdict is still the answer to "did it work" —
  expect(drained.headline).toBe("queue finished · 2 done");
  // — and the stop is still named.
  expect(drained.because).toContain("Nothing more will be claimed");
  expect(drained.because).toContain("guard set the supervisor to stopped");
  expect(drained.because).toContain("the nightly budget ran out");

  // A DRAINED QUEUE THAT DIED CARRIES BOTH FACTS TOO.
  const drainedDead = read(
    state({ desired: "draining", ticket: null, queueDepth: 0, changedBy: "owner", reason: "pressed stop" }),
    { censusBody: census([BLOCKED_ROW]) },
  );
  expect(drainedDead.liveness).toBe("blocked");
  expect(drainedDead.because).toContain("run tools/repair/cycle.mjs");
  expect(drainedDead.because).toContain("owner set the supervisor to draining");

  /*
   * THE NEGATIVE HALF: a RUNNING supervisor must not carry the clause. A sentence
   * that said "nothing more will be claimed" over a loop that is about to claim the
   * next ticket is a false statement in the row's most-read position, and it is the
   * mistake a clause appended unconditionally would make.
   */
  const running = read(state({ desired: "running", ticket: null, queueDepth: 0 }), {
    censusBody: census([DONE_ROW]),
  });
  expect(running.because).not.toContain("Nothing more will be claimed");
  expect(running.because).not.toContain("set the supervisor to");
});
