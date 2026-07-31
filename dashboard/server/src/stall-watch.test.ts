/**
 * stall-watch.test.ts — the silence watch, and the four ways it must refuse to
 * fire.
 *
 * WHAT THIS FILE IS WATCHING FOR. The feature says a run has gone quiet. Almost
 * every failure of such a thing is a FALSE POSITIVE — a working run reported as
 * silent — or a check that can only ever observe silence it created itself. So
 * most assertions here are that NOTHING happened: no warning on a run that keeps
 * speaking, no warning on a park that is quiet on purpose, no row touched by an
 * announcement, and no second measurement taken from the watch's own footprints.
 *
 * THE THREE MEASUREMENTS EVERY NUMBER BELOW RESTS ON, taken from this machine's
 * own `events` table on 2026-07-31 rather than assumed:
 *
 *   · 43.5 min — the largest quiet gap in the ONE finished run on this machine
 *     (`run-2026-07-29T23-28-46-665Z-3d4d1ccb`, 388 events, gap at seq 8, spec
 *     phase). The run was working through all of it. n = 1, and the default's
 *     justification is only as strong as that.
 *   · 31.8 min — the second largest in the same run. Every other gap is < 4.1.
 *   · 506.6 min — the gap between seq 328 and seq 329 of
 *     `run-2026-07-30T20-16-40-242Z-052c6e02`: the eight-and-a-half-hour hang
 *     that cost the owner a night, sitting in the events table where nothing was
 *     reading it.
 *
 * WHY THE FALSE-POSITIVE TEST IS THE POINT. `the default's own justification`
 * below evaluates the SAME 43.5-minute gap at a 30-minute threshold and requires
 * it to be reported as silence. That is the cost of a shorter threshold, made
 * executable: the default is not "a big number that feels safe", it is a number
 * whose failure mode can be produced on demand.
 *
 * NO TIMER IS EVER WAITED ON, following rate-limit-resume.test.ts. The watch's
 * whole callback body is `Orchestrator.noteSilence(runId, now)`, which takes its
 * instant as an argument, so ninety minutes of silence costs a string literal.
 * The only waits in this file are two 10 ms sleeps in the store section, and
 * they exist because two `appendEvent` calls in the same millisecond produce the
 * same `at` — which would make the "the watch cannot hear itself" assertion pass
 * without measuring anything. That precondition is asserted, not assumed.
 *
 * WHAT THIS FILE DOES NOT COVER, SAID PLAINLY:
 *   · The INTERVAL. `#armSilenceWatch` firing every `SILENCE_CHECK_MS` is
 *     reached by nothing here; what is proved is that the body it calls is
 *     correct at any instant it is called with. Arming and clearing are wired
 *     into `#execute` and `#start`'s `finally`, which no test in this repository
 *     can reach without spending the owner's subscription on a builder.
 *   · The RENDER. Nothing here proves a browser shows the field.
 *   · Whether a silent run is actually dead. Nothing can prove that from here,
 *     which is the whole reason this feature reports and never acts.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore, SILENCE_NOTICE_PREFIX } from "./db.js";
import { ModelCatalog } from "./models.js";
import {
  DEFAULT_SILENCE_WARN_MIN,
  MEASURED_QUIET_GAP_MIN,
  Orchestrator,
  SILENCE_WARN_ENV,
  describeSilence,
  silenceOf,
  silenceWarnMin,
} from "./orchestrator.js";
import type { SilenceInput } from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";

/* =========================================================================
 * 1. The pure decision
 * ====================================================================== */

const T0 = "2026-07-30T20:00:00.000Z";

/** Minutes after {@link T0}, as an instant. */
function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

/** A running run, last heard from at T0, evaluated at the default threshold. */
function silence(over: Partial<SilenceInput> = {}): ReturnType<typeof describeSilence> {
  return describeSilence({
    status: "running",
    startedAt: T0,
    lastEventAt: T0,
    now: at(1),
    thresholdMin: DEFAULT_SILENCE_WARN_MIN,
    ...over,
  });
}

test("A RUN WHOSE EVENTS KEEP ARRIVING IS NEVER SILENT, however long it runs", () => {
  // THE CONTROL THIS FEATURE LIVES OR DIES BY. Four hours of work, an event
  // every five minutes: far longer than the threshold, never quiet. An
  // implementation that read the run's AGE instead of the GAP — which is what
  // every previous attempt at this display in this repository did — reports this
  // run as silent from minute 90 onward, and goes red here.
  for (let minute = 0; minute <= 240; minute += 5) {
    const report = silence({ lastEventAt: at(minute), now: at(minute + 5), startedAt: T0 });
    assert.ok(report !== null, "a running run is watched");
    assert.equal(report.quietMin, 5, `at minute ${String(minute)} the gap is five minutes, not the run's age`);
    assert.equal(
      report.overThreshold,
      false,
      `a run four hours in that spoke five minutes ago is WORKING (minute ${String(minute)})`,
    );
  }
});

test("the measured 43.5-minute quiet spec phase is NOT reported at the default threshold", () => {
  // The real gap from the only finished run on this machine, evaluated at the
  // shipped default. This is the false alarm the default exists to avoid.
  const report = silence({ now: at(MEASURED_QUIET_GAP_MIN) });
  assert.ok(report !== null);
  assert.equal(report.quietMin, 43);
  assert.equal(
    report.overThreshold,
    false,
    "the one measured legitimately-quiet stretch on this machine must not trip the watch",
  );
});

test("THE DEFAULT'S OWN JUSTIFICATION: a shorter threshold provably produces a false positive", () => {
  // SAME GAP, SHORTER THRESHOLD. The run was working; at 30 minutes the watch
  // says it was not. This is what "the default is generous" costs to give up,
  // and it is executable rather than asserted in a comment.
  const shortThreshold = silence({ now: at(MEASURED_QUIET_GAP_MIN), thresholdMin: 30 });
  assert.ok(shortThreshold !== null);
  assert.equal(
    shortThreshold.overThreshold,
    true,
    "at 30 minutes the measured 43.5-minute working spec phase IS reported — that is the false positive",
  );
  // And the guard that keeps the default above the measurement it rests on. A
  // future edit that lowers the default under 43.5 buys exactly the false alarm
  // produced one line above, so it has to change this constant and say why.
  assert.ok(
    DEFAULT_SILENCE_WARN_MIN > MEASURED_QUIET_GAP_MIN,
    `the default (${String(DEFAULT_SILENCE_WARN_MIN)} min) is at or below the largest quiet gap measured ` +
      `on a WORKING run (${String(MEASURED_QUIET_GAP_MIN)} min), so it reports runs that are fine`,
  );
});

test("the 506-minute hang IS reported, in minutes, at the default threshold", () => {
  // The failure this whole feature exists for: run
  // `run-2026-07-30T20-16-40-242Z-052c6e02`, seq 328 -> 329.
  const report = silence({ now: at(506.6) });
  assert.ok(report !== null);
  assert.equal(report.quietMin, 506, "floored whole minutes, never rounded up");
  assert.equal(report.overThreshold, true);
  assert.ok(
    report.quietMin > DEFAULT_SILENCE_WARN_MIN,
    "the hang would have been reported ~90 minutes in rather than in the morning",
  );
});

test("only a running run is watched, and `null` NEVER means healthy", () => {
  // Every one of these is quiet for a week. None is a fault: `queued` has not
  // started, the two parks are quiet on purpose and carry their own timers, and
  // a terminal run is finished. A UI that renders `null` as a green tick is
  // inventing a health check nobody performed — which is why the field is
  // nullable rather than a boolean.
  for (const status of ["queued", "awaiting_input", "rate_limited", "passed", "failed", "cancelled"] as const) {
    assert.equal(
      silence({ status, now: at(10_080) }),
      null,
      `${status} is not watched, and a week of silence in it is not a finding`,
    );
  }
  assert.notEqual(silence({ status: "running", now: at(10_080) }), null, "a running run IS watched");
});

test("a run that has emitted NOTHING is measured from its start, and says so", () => {
  // The state of a run whose first event has not landed — and of a run whose
  // event writes are failing, which is the case worth not hiding. Reporting
  // `startedAt` under `sinceKind: "last-event"` would be a quiet lie about a run
  // that has never spoken.
  const report = silence({ lastEventAt: null, startedAt: T0, now: at(120) });
  assert.ok(report !== null);
  assert.equal(report.sinceKind, "run-start");
  assert.equal(report.since, T0);
  assert.equal(report.quietMin, 120);
  assert.equal(report.overThreshold, true);
  assert.equal(silence({ lastEventAt: T0 })?.sinceKind, "last-event");
});

test("an unparseable instant yields NO measurement rather than a number from NaN", () => {
  assert.equal(silence({ lastEventAt: "not-an-instant" }), null);
  assert.equal(silence({ lastEventAt: null, startedAt: "" }), null);
  assert.equal(silence({ now: "whenever" }), null);
});

test("a clock that moved backwards reports zero, never negative silence", () => {
  const report = silence({ lastEventAt: at(30), now: T0 });
  assert.ok(report !== null);
  assert.equal(report.quietMin, 0);
  assert.equal(report.overThreshold, false);
});

test("the boundary is inclusive, so the timer and the field cannot disagree at it", () => {
  assert.equal(silence({ now: at(DEFAULT_SILENCE_WARN_MIN - 1) })?.overThreshold, false);
  assert.equal(
    silence({ now: at(DEFAULT_SILENCE_WARN_MIN) })?.overThreshold,
    true,
    "at exactly the threshold the watch fires, so the field must already read as over",
  );
});

test("the threshold is env-overridable, and nonsense falls back to the default", () => {
  assert.equal(silenceWarnMin({ [SILENCE_WARN_ENV]: "15" }), 15);
  assert.equal(silenceWarnMin({ [SILENCE_WARN_ENV]: "  240  " }), 240);
  assert.equal(silenceWarnMin({}), DEFAULT_SILENCE_WARN_MIN);
  // A typo must not disable the watch by making the threshold zero or negative —
  // at zero every run is permanently "silent" and the warning becomes noise
  // nobody reads, which is indistinguishable from no watch at all.
  assert.equal(silenceWarnMin({ [SILENCE_WARN_ENV]: "0" }), DEFAULT_SILENCE_WARN_MIN);
  assert.equal(silenceWarnMin({ [SILENCE_WARN_ENV]: "-5" }), DEFAULT_SILENCE_WARN_MIN);
  assert.equal(silenceWarnMin({ [SILENCE_WARN_ENV]: "soon" }), DEFAULT_SILENCE_WARN_MIN);
});

/* =========================================================================
 * 2. The store: the one query, and the sentence it must not hear
 * ====================================================================== */

interface StoreFixture {
  readonly store: RunStore;
  readonly cleanup: () => void;
}

function storeFixture(): StoreFixture {
  const dir = mkdtempSync(join(tmpdir(), "dash-silence-store-"));
  const store = RunStore.open(join(dir, "runs.db"));
  return {
    store,
    cleanup: (): void => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedRun(store: RunStore, runId: string): void {
  store.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: runId,
    ticketText: `build ${runId}`,
    ticketSha256: "a".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: T0,
    queuePosition: 1,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The watch's own warning, exactly as `noteSilence` writes it. */
function noticeText(minutes: number): string {
  return `${SILENCE_NOTICE_PREFIX}${String(minutes)} min (last event ${T0}), and this server expects better.`;
}

test("SILENCE_NOTICE_PREFIX carries no LIKE wildcards, which the query depends on", () => {
  // The exclusion interpolates this into `NOT LIKE` with no ESCAPE clause. A `_`
  // added to the sentence would match any single character in every position and
  // silently widen the filter to swallow real events; a `%` would swallow all of
  // them and the watch would measure nothing at all.
  assert.ok(!SILENCE_NOTICE_PREFIX.includes("%"), "a % in the notice makes the filter match everything");
  assert.ok(!SILENCE_NOTICE_PREFIX.includes("_"), "a _ in the notice widens the filter by one character");
  assert.ok(SILENCE_NOTICE_PREFIX.length > 20, "a short prefix would collide with ordinary log prose");
});

test("a run with no events has no last-event instant — and that is not zero silence", () => {
  const f = storeFixture();
  try {
    seedRun(f.store, "run-quiet");
    assert.equal(f.store.lastRunEventAt("run-quiet"), null);
    assert.equal(f.store.lastRunEventAt("run-that-does-not-exist"), null);
  } finally {
    f.cleanup();
  }
});

test("THE WATCH CANNOT HEAR ITSELF: its own warning does not reset the clock", async () => {
  const f = storeFixture();
  try {
    seedRun(f.store, "run-hang");
    const organic = f.store.appendEvent("run-hang", { type: "tool", name: "Bash", summary: "npm run build" });
    assert.equal(f.store.lastRunEventAt("run-hang"), organic.at);

    await sleep(10);
    const notice = f.store.appendEvent("run-hang", { type: "log", level: "warn", text: noticeText(90) });
    // PRECONDITION, ASSERTED. Two appends inside one millisecond carry the same
    // `at`, and the check below would then pass while measuring nothing.
    assert.notEqual(notice.at, organic.at, "the fixture failed to separate the two events in time");

    assert.equal(
      f.store.lastRunEventAt("run-hang"),
      organic.at,
      "the watch heard its own warning: every announcement would reset the silence it just reported, and " +
        "no run could ever be reported quiet for a second time",
    );

    // NEGATIVE CONTROL — the filter must be narrow. An ordinary warn line is the
    // run's own stream and MUST move the clock; a filter that swallowed it would
    // report silence on a run that was talking.
    await sleep(10);
    const ordinary = f.store.appendEvent("run-hang", {
      type: "log",
      level: "warn",
      text: "the builder wrote no self-report; recorded as not-declared-done",
    });
    assert.equal(
      f.store.lastRunEventAt("run-hang"),
      ordinary.at,
      "the exclusion is too wide: it swallowed an ordinary log line and would invent silence",
    );
  } finally {
    f.cleanup();
  }
});

test("the prefix survives `redactForPersistence`, which the filter silently depends on", () => {
  // `appendEvent` redacts every event on the way in. If that ever rewrote this
  // sentence the stored payload would stop matching the query, the watch would
  // start hearing itself again, and the test above would still be green because
  // it compares instants rather than reading the row back.
  const f = storeFixture();
  try {
    seedRun(f.store, "run-redact");
    f.store.appendEvent("run-redact", { type: "log", level: "warn", text: noticeText(120) });
    const stored = f.store.eventsSince("run-redact", 0);
    const last = stored[stored.length - 1];
    assert.ok(last !== undefined);
    assert.equal(last.event.type, "log");
    assert.ok(
      last.event.type === "log" && last.event.text.startsWith(SILENCE_NOTICE_PREFIX),
      "the persisted notice no longer starts with the prefix the exclusion matches on",
    );
  } finally {
    f.cleanup();
  }
});

test("an organic event after a notice is heard: the filter skips rows, it does not stop", async () => {
  const f = storeFixture();
  try {
    seedRun(f.store, "run-resumed");
    f.store.appendEvent("run-resumed", { type: "tool", name: "Read", summary: "index.html" });
    await sleep(10);
    f.store.appendEvent("run-resumed", { type: "log", level: "warn", text: noticeText(95) });
    await sleep(10);
    const spoke = f.store.appendEvent("run-resumed", { type: "tool", name: "Write", summary: "styles.css" });
    assert.equal(
      f.store.lastRunEventAt("run-resumed"),
      spoke.at,
      "a run that spoke AFTER a warning is not still silent; a query that stopped at the notice would say it was",
    );
  } finally {
    f.cleanup();
  }
});

/* =========================================================================
 * 3. `noteSilence`: what the timer's callback actually does — and does not
 * ====================================================================== */

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: Orchestrator;
  readonly env: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<void>;
}

/** An orchestrator with no network, no builder and no live run. */
function harness(env: NodeJS.ProcessEnv = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dash-silence-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const orchestrator = new Orchestrator({ store, bus, paths, catalog, auth, preview, env });
  return {
    store,
    orchestrator,
    env,
    cleanup: async (): Promise<void> => {
      // Clears the watch map too — an interval whose callback reads the store
      // must not outlive it.
      await orchestrator.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * An instant `minutes` after the run's newest event.
 *
 * NOT `at(minutes)`. Section 1 supplies both ends of the measurement, so it can
 * use a fixed T0; here the STORE stamps every event with the real clock, and a
 * `now` taken from T0 — a date in the past — would floor the elapsed time to
 * zero. Every "this run is quiet" assertion would then pass while measuring
 * nothing, which is the exact shape of check this file exists to refuse.
 *
 * It reads through `lastRunEventAt`, so the watch's own notices are excluded
 * from the base as well: a second call after an announcement measures from the
 * same organic event the first one did, which is the property section 3 asserts.
 */
function later(h: Harness, runId: string, minutes: number): string {
  const base = h.store.lastRunEventAt(runId);
  assert.ok(base !== null, `${runId} has no event to measure silence from — the fixture seeded nothing`);
  return new Date(Date.parse(base) + minutes * 60_000).toISOString();
}

function notices(store: RunStore, runId: string): readonly string[] {
  return store
    .eventsSince(runId, 0)
    .map((stored) => stored.event)
    .filter((event) => event.type === "log" && event.text.startsWith(SILENCE_NOTICE_PREFIX))
    .map((event) => (event.type === "log" ? event.text : ""));
}

/** A run that is running and last spoke at T0. */
function seedRunning(h: Harness, runId: string): void {
  seedRun(h.store, runId);
  h.store.updateRun(runId, { status: "running", phase: "build", queuePosition: 0, artifactPath: "/tmp/ws" });
  h.store.appendEvent(runId, { type: "status", status: "running" });
}

test("A QUIET RUN IS REPORTED ONCE, AND NOTHING ABOUT THE RUN IS CHANGED", async () => {
  const h = harness();
  try {
    seedRunning(h, "run-hang");
    const before = h.store.getRun("run-hang");
    assert.ok(before !== null);

    const report = h.orchestrator.noteSilence("run-hang", later(h, "run-hang", 120));
    assert.ok(report !== null);
    assert.equal(report.quietMin, 120, "the fixture must actually be quiet, or nothing below measures anything");
    assert.equal(report.overThreshold, true);
    assert.equal(notices(h.store, "run-hang").length, 1, "a silence past the threshold is announced");

    // REPORT, DO NOT ACT. The row must come back byte-identical: no status
    // change, no `endedAt`, no `failureReason`, no requeue. doc 03 §7.8 — 79% of
    // unresolved long-horizon runs are still working when they look stuck, and
    // killing one on this signal is how real work is lost.
    assert.deepEqual(
      h.store.getRun("run-hang"),
      before,
      "the watch changed the run. It may announce and nothing else.",
    );

    // ONE SILENCE, ONE WARNING. A line a minute would bury the one that mattered.
    h.orchestrator.noteSilence("run-hang", later(h, "run-hang", 121));
    h.orchestrator.noteSilence("run-hang", later(h, "run-hang", 400));
    assert.equal(notices(h.store, "run-hang").length, 1, "the same quiet stretch must not be re-announced");

    // AND THE MEASUREMENT KEPT GROWING while it was being announced — the proof
    // that the notice did not reset the clock it reads. `later` measures from
    // `lastRunEventAt`, which is the run's own last event and not the warning,
    // so a watch that heard itself would report a handful of minutes here.
    const grown = h.orchestrator.noteSilence("run-hang", later(h, "run-hang", 400));
    assert.ok(grown !== null);
    assert.equal(
      grown.quietMin,
      400,
      `the silence stopped growing (${String(grown.quietMin)} min): the watch is measuring its own warning`,
    );
    assert.equal(grown.since, report.since, "the instant the silence is measured from must not move");
  } finally {
    await h.cleanup();
  }
});

test("the warning says what it observed and refuses to diagnose", async () => {
  const h = harness();
  try {
    seedRunning(h, "run-words");
    h.orchestrator.noteSilence("run-words", later(h, "run-words", 120));
    const text = notices(h.store, "run-words")[0] ?? "";
    assert.match(text, /^no event has been recorded on this run's stream for 120 min/);
    assert.match(text, /NOTHING HAS BEEN KILLED/, "the owner must be told no state changed");
    assert.match(text, /79% of unresolved/, "the reason nothing is killed is a measurement, and it is cited");
    assert.match(text, /\/tmp\/ws/, "the owner is pointed at the workspace so they can decide for themselves");
    // THE WORDS THIS MAY NEVER USE. Each is a claim about a subprocess this
    // program has not inspected: it knows only that nothing arrived.
    for (const forbidden of [/\bdead\b/i, /\bhung\b/i, /\bcrashed\b/i, /\bstuck\b/i, /\bfrozen\b/i]) {
      assert.doesNotMatch(text, forbidden, `the notice claims more than silence: ${String(forbidden)}`);
    }
  } finally {
    await h.cleanup();
  }
});

test("A RUN THAT IS STILL SPEAKING IS NEVER ANNOUNCED", async () => {
  const h = harness();
  try {
    seedRunning(h, "run-busy");
    // Twelve checks across an hour, with the run emitting between each. The
    // watch fires every minute in production; this is that loop, with the clock
    // supplied instead of waited on.
    for (let minute = 5; minute <= 60; minute += 5) {
      h.store.appendEvent("run-busy", { type: "tool", name: "Bash", summary: `step ${String(minute)}` });
      // Five minutes after whatever it just said — the gap, not the run's age.
      const report = h.orchestrator.noteSilence("run-busy", later(h, "run-busy", 5));
      assert.ok(report !== null);
      assert.equal(report.quietMin, 5, `minute ${String(minute)}: the gap is five minutes`);
      assert.equal(report.overThreshold, false, `minute ${String(minute)}: this run just spoke`);
    }
    assert.equal(notices(h.store, "run-busy").length, 0, "a working run was reported silent");
  } finally {
    await h.cleanup();
  }
});

test("a run that speaks again and then goes quiet gets a SECOND warning", async () => {
  const h = harness();
  try {
    seedRunning(h, "run-two");
    h.orchestrator.noteSilence("run-two", later(h, "run-two", 120));
    assert.equal(notices(h.store, "run-two").length, 1);

    /*
     * It spoke. That ends the first silence; the next one is a new fact, and a
     * dedup keyed on a boolean rather than on the instant would swallow it.
     *
     * THE WAIT IS NOT PADDING, AND THE FLAKE IT FIXES IS INFORMATIVE. The dedup
     * is keyed on `silence.since` — an INSTANT, at millisecond resolution. This
     * test appends its event microseconds after `seedRunning` appended the last
     * one, so on a fast machine both carry the SAME millisecond, `since` does not
     * change, and the second warning is correctly suppressed. Measured: the test
     * failed 2 runs in 3 in-file and passed alone.
     *
     * The production limit that exposes is real and narrow: two events in the
     * same millisecond are indistinguishable to the dedup. Real runs put seconds
     * between events — the measured minimum on the recorded run is 9 s — so it
     * cannot bite there, and keying on the store's monotonic `seq` instead would
     * remove it entirely if that ever stops being true.
     */
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.store.appendEvent("run-two", { type: "tool", name: "Edit", summary: "script.js" });
    const spokeAt = h.store.lastRunEventAt("run-two");
    assert.ok(spokeAt !== null);
    const now = new Date(Date.parse(spokeAt) + 200 * 60_000).toISOString();
    h.orchestrator.noteSilence("run-two", now);
    assert.equal(notices(h.store, "run-two").length, 2, "the second silence is a second fact and must be said");
  } finally {
    await h.cleanup();
  }
});

test("PARKED AND FINISHED RUNS ARE NEVER ANNOUNCED, however long they are quiet", async () => {
  const h = harness();
  try {
    for (const status of ["queued", "awaiting_input", "rate_limited", "passed", "failed", "cancelled"] as const) {
      const runId = `run-${status}`;
      seedRun(h.store, runId);
      h.store.updateRun(runId, { status });
      h.store.appendEvent(runId, { type: "status", status });
      // A WEEK after the run's last event, measured from it rather than from a
      // fixed T0, so the test's name is literally true of the fixture.
      assert.equal(h.orchestrator.noteSilence(runId, later(h, runId, 10_080)), null, `${status} is not watched`);
      assert.equal(
        notices(h.store, runId).length,
        0,
        `${status} is quiet on purpose — a design park waiting for a click must not be reported as a fault`,
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("a run that does not exist is not a silent run", async () => {
  const h = harness();
  try {
    assert.equal(h.orchestrator.noteSilence("run-never-created", at(10_000)), null);
  } finally {
    await h.cleanup();
  }
});

test("the env override reaches the live decision, not just the pure helper", async () => {
  // Read per decision rather than captured at construction, so a test cannot get
  // its answer from a stale copy — and so an operator can widen the threshold on
  // a machine whose runs are quieter than this one's.
  const h = harness({ [SILENCE_WARN_ENV]: "10" });
  try {
    seedRunning(h, "run-tight");
    const report = h.orchestrator.noteSilence("run-tight", later(h, "run-tight", 11));
    assert.equal(report?.thresholdMin, 10, "the threshold on the wire must be the one in force");
    assert.equal(report?.overThreshold, true);
    assert.equal(notices(h.store, "run-tight").length, 1);
  } finally {
    await h.cleanup();
  }
});

test("`silenceOf` reports a hang the moment a restarted server answers, with no timer", async () => {
  // THE DURABLE HALF. The design park re-arms a timer in `reconcileOnBoot`
  // because its deadline exists nowhere else; this measurement is the gap
  // between rows in the `events` table, so a server that has just booted — and
  // has armed nothing — still answers correctly. `reconcileOnBoot` moves every
  // `running` row to `awaiting_input`, so this is the state of a run the owner
  // has resumed after a restart: watched again, and its recorded history intact.
  const h = harness();
  try {
    seedRunning(h, "run-booted");
    const row = h.store.getRun("run-booted");
    assert.ok(row !== null);
    const report = silenceOf(row, h.store, h.env, later(h, "run-booted", 300));
    assert.ok(report !== null, "a running run is measurable without any timer having run");
    assert.equal(report.quietMin, 300);
    assert.equal(report.overThreshold, true);
    assert.equal(notices(h.store, "run-booted").length, 0, "the read-only path must never write to the stream");
  } finally {
    await h.cleanup();
  }
});

test("KNOWN GAP, PINNED: an owner chat message resets the silence clock", async () => {
  // `postMessage` in http.ts emits a `log` line on the run's stream when the
  // owner types, and this measurement counts every event that is not the watch's
  // own notice. So the clock restarts from the owner's message — and the run an
  // owner types into is precisely the one that has gone quiet (fact E: the owner
  // asked a hung run for a link and nothing came back).
  //
  // NOT FIXED HERE. Closing it means marking that line in a file this change
  // does not own, and coupling this query to another module's prose would break
  // silently the next time the prose changed. The behaviour is PINNED instead:
  // whoever closes the gap has to come through this test rather than let the
  // next person rediscover it after another lost night.
  //
  // ASSERTED AT THE STORE, NOT THROUGH `noteSilence`, and that is what makes it
  // exact: the store stamps with the real clock, so "the owner typed two hours
  // into the silence" cannot be staged without waiting two hours. What CAN be
  // measured is the mechanism itself — whether the echo row moves the instant
  // every silence is computed from. It does.
  const f = storeFixture();
  try {
    seedRun(f.store, "run-typed-at");
    const working = f.store.appendEvent("run-typed-at", { type: "status", status: "running" });
    await sleep(10);
    const echo = f.store.appendEvent("run-typed-at", {
      type: "log",
      level: "info",
      text: "owner message delivered into the running session: are you alive?",
    });
    assert.notEqual(echo.at, working.at, "the fixture failed to separate the two events in time");
    assert.equal(
      f.store.lastRunEventAt("run-typed-at"),
      echo.at,
      "BEHAVIOUR CHANGED: the owner-message echo is no longer counted as the run speaking. If that is now " +
        "deliberate, delete this pin and update the docblock on `RunStore.lastRunEventAt`, which states the " +
        "gap as it stands.",
    );
  } finally {
    f.cleanup();
  }
});

/* =========================================================================
 * 4. The wire, across the package boundary
 *
 * Both packages declare this shape by hand and no typecheck spans them, so a
 * field named `quietMinutes` on one side and `quietMin` on the other compiles
 * clean everywhere and arrives at the browser as `undefined`. Same three-leg
 * idiom as contract-parity.test.ts: a HARDCODED expectation (so deleting a field
 * from both packages is red), then server text, then client text.
 * ====================================================================== */

const SERVER_TYPES = join(import.meta.dirname, "..", "src", "api-types.ts");
const CLIENT_TYPES = join(import.meta.dirname, "..", "..", "src", "lib", "api-types.ts");
const SERVER_HTTP = join(import.meta.dirname, "..", "src", "http.ts");

/** The fields of `ApiRunSilence`, and of its client mirror `RunSilence`. */
const SILENCE_FIELDS: readonly string[] = ["since", "sinceKind", "quietMin", "thresholdMin", "overThreshold"];

function read(file: string): string {
  assert.ok(
    existsSync(file),
    `this check reads ${file} and it is not there. The file moved, or this test is running from an ` +
      "outDir that is not directly under dashboard/server.",
  );
  return readFileSync(file, "utf8");
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * The `readonly` field names of one interface, in declaration order.
 *
 * COMMENTS ARE STRIPPED BEFORE THE CLOSING BRACE IS FOUND — contract-parity.ts
 * records the measurement behind that ordering: a docblock containing `{@link
 * Foo}` closes the region on the brace inside the comment and the check then
 * goes red naming the wrong cause.
 */
function fieldNames(source: string, file: string, open: string): readonly string[] {
  const stripped = withoutComments(source);
  const start = stripped.indexOf(open);
  assert.notEqual(start, -1, `${file}: the anchor \`${open}\` is gone. Re-point this parser, do not delete it.`);
  const from = start + open.length;
  const end = stripped.indexOf("}", from);
  assert.notEqual(end, -1, `${file}: \`${open}\` has no closing brace.`);
  const names: string[] = [];
  for (const match of stripped.slice(from, end).matchAll(/readonly\s+([A-Za-z][A-Za-z0-9]*)\s*[?:]/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  assert.notEqual(names.length, 0, `${file}: \`${open}\` parsed as ZERO fields — re-point this parser.`);
  return names;
}

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

test("CONTRACT: the client mirrors every field of the silence report, in both directions", () => {
  const onServer = fieldNames(read(SERVER_TYPES), SERVER_TYPES, "export interface ApiRunSilence {");
  const onClient = fieldNames(read(CLIENT_TYPES), CLIENT_TYPES, "export interface RunSilence {");
  assert.deepEqual(
    sorted(onClient),
    sorted(SILENCE_FIELDS),
    `RunSilence in the client declares ${onClient.join(", ")}, not ${SILENCE_FIELDS.join(", ")}`,
  );
  assert.deepEqual(
    sorted(onServer),
    sorted(onClient),
    `ApiRunSilence and RunSilence have drifted: server ${onServer.join(", ")}, client ${onClient.join(", ")}. ` +
      "Nothing but this test compares them, and a renamed field arrives at the browser as `undefined`.",
  );
});

test("CONTRACT: both RunDetails carry `silence`, nullable, and the null means NOT WATCHED", () => {
  const server = withoutComments(read(SERVER_TYPES));
  const client = withoutComments(read(CLIENT_TYPES));
  assert.match(
    server,
    /readonly silence: ApiRunSilence \| null;/,
    "the server's RunDetail does not declare silence",
  );
  assert.match(
    client,
    /readonly silence: RunSilence \| null;/,
    "the client's RunDetail mirror has no silence field: the server sends it and the UI cannot see it",
  );
  // NOT `boolean`. A `stalled: boolean` on the wire would be a claim this
  // program cannot support, and `null` would then have to mean "fine".
  assert.doesNotMatch(server, /readonly (stalled|dead|hung): boolean/, "no field may claim a diagnosis");
});

test("HANDOFF — RED UNTIL http.ts#toDetail IS PATCHED: the response carries a MEASURED silence", () => {
  // The compiler already forces `toDetail` to set the field, but it cannot stop
  // someone satisfying it with `silence: null` — which compiles, mirrors,
  // serialises, and reports every hang on this machine as "not watched". This is
  // the only check that can tell a served measurement from a served placeholder.
  //
  // THE ONE LINE, verbatim, inside the object literal `toDetail` returns:
  //   silence: silenceOf(row, store, deps.env),
  // with `silenceOf` imported from "./orchestrator.js" — and `deps.env` is not in
  // `toDetail`'s scope today, so the signature takes the env or `process.env` is
  // threaded the way the rest of that file does it.
  const http = withoutComments(read(SERVER_HTTP));
  assert.match(
    http,
    /silence:\s*silenceOf\(/,
    "http.ts#toDetail does not call silenceOf: the field is on the wire and is not a measurement of anything",
  );
  assert.doesNotMatch(
    http,
    /silence:\s*null\s*,/,
    "toDetail hardcodes `silence: null`, which reports every hang as an unwatched run",
  );
});
