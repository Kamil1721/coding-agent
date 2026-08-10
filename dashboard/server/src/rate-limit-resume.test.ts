/**
 * rate-limit-resume.test.ts — the opt-in auto-resume for a run the provider
 * refused, and the four ways it must REFUSE to arm.
 *
 * WHAT THIS FILE IS WATCHING FOR. The feature spends the owner's subscription
 * while nobody is present, so almost every test here asserts that NOTHING
 * happened: no timer, no requeue, no restarted window. A check that can only
 * observe a successful resume is exactly the defect this repo keeps finding —
 * an auto-resume that fires whenever it feels like it would pass one.
 *
 * THREE LAYERS, BECAUSE THE BUG CAN LIVE IN ANY OF THEM:
 *
 *  1. `planRateLimitResume` — pure, so the overflow and unparseable-instant arms
 *     are reachable without a clock or a 115-day wait.
 *  2. The `rate_limited_at` migration — every other test opens a store under
 *     `mkdtemp`, where `CREATE TABLE IF NOT EXISTS` always has the newest
 *     column, so the ALTER path is only ever taken on the owner's own
 *     `dashboard/data/runs.db`. Same fixture shape as `db.test.ts`: reproduce
 *     the old schema with `DROP COLUMN`, assert the drop, then reopen.
 *  3. `reconcileOnBoot` — the durable half. These are the tests that catch a
 *     re-arm from `now`: a run refused 20 minutes into a 30-minute window must
 *     come back with 10 minutes left and must NOT resume, while the same run
 *     with the window elapsed must.
 *
 * NO TIMER IS EVER WAITED ON. The boot path is the observable surface: it either
 * moves the row to `queued` or it does not, synchronously. A test that slept for
 * a real window would be a test nobody runs.
 *
 * `shutdown()` IS CALLED BEFORE `reconcileOnBoot()`, following the pattern
 * orchestrator.test.ts states at the top of itself. `#stopped` neuters `pump()`
 * only, so every transition under test still happens and asserts — while
 * `resume()` -> `pump()` -> `#start` cannot spawn a builder and spend the
 * subscription to prove an integer.
 *
 * WHAT IS NOT COVERED HERE, SAID OUT LOUD. The ARM-AT-REFUSAL path —
 * `#rateLimited` writing `rate_limited_at` and announcing the decision the
 * instant the provider says no — is reached by no test in this file. Every run
 * below is seeded into `rate_limited` through the store, because reaching
 * `#rateLimited` for real needs a builder whose outcome carries
 * `rateLimit.limited: true`, and the only fake builder in this repo lives inside
 * orchestrator.test.ts (`designRun`/`FakeBuilder`, module-local) and has no
 * option for it. So what is proved here is that a row already carrying a refusal
 * instant is handled correctly; that the instant is WRITTEN at the refusal is
 * proved by nothing. That test belongs beside `FakeBuilder` and is listed as a
 * handoff rather than faked here.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator, RATE_LIMIT_AUTO_RESUME_ENV, rateLimitAutoResume } from "./orchestrator.js";
import {
  AUTO_CONTINUE_MAX,
  RECOVERY_ENABLED_ENV,
  RECOVERY_MAX_AUTO_WAIT_MS,
  RECOVERY_TIMER_MAX_DELAY_MS,
  REFUSAL_BLIND_WAIT_MS,
  planRecovery,
} from "./recovery.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";

/* =========================================================================
 * 1. The pure decision
 *
 * IT MOVED. `planRateLimitResume` used to live in orchestrator.ts and is now
 * `planRecovery` in recovery.ts, which generalises a rate limit into one CLASS
 * of failure a run may continue itself through. The arms below are the SAME
 * ARMS IN THE SAME ORDER — that was the condition on the move, so the
 * substitution is mechanical — with two differences the review of the design
 * required, both asserted here:
 *
 *  · A SECOND CEILING. The 32-bit guard refuses a delay the PROGRAM cannot
 *    hold; every window this machine has ever recorded is a `seven_day` reset
 *    2.2-5.0 days out, which sails straight through it. `RECOVERY_MAX_AUTO_WAIT_MS`
 *    refuses a delay the OWNER did not agree to hold.
 *  · THE CAP IS ON AUTOMATIC CONTINUATIONS, not on total resumes. The old one
 *    counted the owner's own presses of Resume, so a run he had nursed by hand
 *    three times could never continue itself.
 * ====================================================================== */

const REFUSED_AT = "2026-07-30T01:00:00.000Z";
const HALF_HOUR_SEC = 1_800;

interface PlanOver {
  readonly enabled?: boolean;
  readonly rateLimitedAt?: string | null;
  readonly retryAfterSec?: number | null;
  readonly autoContinueCount?: number;
  readonly now?: string;
  readonly maxWaitMs?: number;
}

/** Enabled, refused half an hour ago, and the window is half an hour long. */
function plan(over: PlanOver = {}) {
  return planRecovery({
    signals: {
      aborted: false,
      abortReason: null,
      interrupted: false,
      bakeoffCode: null,
      seatKind: null,
      // THE REFUSAL IS CARRIED, not read off a row. That is the whole shape of
      // `RefusalEvidence`: the row's `rate_limited` / `rate_limit_retry_after_sec`
      // are routine telemetry, overwritten by every `limited: false` frame.
      refusal: {
        limited: true,
        retryAfterSec: over.retryAfterSec === undefined ? HALF_HOUR_SEC : over.retryAfterSec,
        kind: "five_hour",
        observedAt: over.rateLimitedAt === undefined ? REFUSED_AT : over.rateLimitedAt,
      },
    },
    autoContinueCount: over.autoContinueCount ?? 0,
    enabled: over.enabled ?? true,
    now: over.now ?? "2026-07-30T01:20:00.000Z",
    maxWaitMs: over.maxWaitMs ?? RECOVERY_MAX_AUTO_WAIT_MS,
  });
}

test("OFF IS THE DEFAULT, and the refusal names the switch and the human", () => {
  const decision = plan({ enabled: false });
  assert.equal(decision.kind, "stop");
  const reason = decision.kind === "stop" ? decision.reason : "";
  assert.match(reason, new RegExp(RECOVERY_ENABLED_ENV));
  assert.match(reason, /human has to resume/i, "the whole point of the fix is saying who resumes it");
});

test("only an explicit opt-in value turns it on; anything else is off", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(rateLimitAutoResume({ [RATE_LIMIT_AUTO_RESUME_ENV]: value }), true, value);
  }
  // A TYPO MUST NOT ENROL A MACHINE INTO UNATTENDED SPENDING. This inverts
  // `designLockPolicy`, where an unrecognised value falls to the arm that
  // FINISHES a park; ending a park costs nothing and a resume costs quota.
  for (const value of ["", "0", "false", "off", "no", "yes please", "maybe"]) {
    assert.equal(rateLimitAutoResume({ [RATE_LIMIT_AUTO_RESUME_ENV]: value }), false, value);
  }
  assert.equal(rateLimitAutoResume({}), false, "an absent variable is off");
});

test("A NULL retryAfterSec IS HELD FOR A BOUNDED CHOSEN LENGTH — the whole error-text path", () => {
  // WHAT THIS TEST SAID UNTIL 2026-08-09, and why it changed. It asserted
  // `stop`, on the grounds that "a countdown from a number nobody reported is
  // exactly the invention this repo refuses". The reasoning was sound and its
  // consequence was not: the error-text path was the ONLY path a refusal could
  // take on this machine (`subscription-caller.ts` hardcoded
  // `retryAfterSec: null` for every one), so this arm parked every unattended
  // run that met a rate limit, and no ceiling could be raised past it because
  // it returned before the ceiling was read.
  //
  // The invention is still refused, in the only sense that matters: the length
  // is declared a CHOICE in the reason the owner reads, and it is bounded by
  // `REFUSAL_BLIND_WAIT_MS` — not read off the row's routine telemetry, which
  // is the substitution `RefusalEvidence` exists to prevent.
  const decision = plan({ retryAfterSec: null });
  assert.equal(decision.kind, "wait", "a refusal with no instant must no longer sit until a human arrives");
  // Refused 20 minutes before `now`, so what remains is the chosen length minus
  // those 20 minutes — the same elapsed subtraction a reported window gets.
  assert.equal(decision.kind === "wait" ? decision.delayMs : -1, REFUSAL_BLIND_WAIT_MS - 20 * 60_000);
  assert.match(decision.reason, /chosen length/i, "the owner must not read this number as a measurement");
  assert.match(decision.reason, /named no reset instant/i);
  assert.doesNotMatch(decision.reason, new RegExp(RECOVERY_ENABLED_ENV), "enabled was true; not the off path");
});

test("a reported reset that is not in the future arms nothing either", () => {
  // `Math.max(0, ...)` in claude-common.ts makes 0 reachable: the provider
  // refused while naming an instant already past. Answering it with no wait
  // walks straight back into the same refusal.
  for (const retryAfterSec of [0, -5]) {
    const decision = plan({ retryAfterSec });
    assert.equal(decision.kind, "stop", String(retryAfterSec));
    assert.notEqual(decision.kind, "continue", "zero seconds is not a drained window");
  }
});

test("NO RECORDED REFUSAL INSTANT IS A REFUSAL, NOT A FRESH WINDOW", () => {
  // The inversion of `designLockExpired`, which treats an unparseable timestamp
  // as expired because ending a park is the safe direction there. Here the safe
  // direction is the opposite: with no idea when the refusal happened there is
  // no idea what remains, and arming from `now` would renew the window.
  for (const rateLimitedAt of [null, "not-a-date", ""]) {
    const decision = plan({ rateLimitedAt });
    assert.equal(decision.kind, "stop", String(rateLimitedAt));
    const reason = decision.kind === "stop" ? decision.reason : "";
    assert.match(reason, /remaining wait cannot be computed/i);
  }
});

test("THE REMAINDER, NOT A FRESH WINDOW: 20 minutes served of 30 leaves 10", () => {
  const decision = plan();
  assert.equal(decision.kind, "wait");
  assert.equal(decision.kind === "wait" ? decision.delayMs : -1, 600_000);
  assert.ok(
    (decision.kind === "wait" ? decision.delayMs : Infinity) < HALF_HOUR_SEC * 1_000,
    "an implementation that timed from `now` would arm the full window here",
  );
  // AN INSTANT, NEVER A DURATION. A duration is stale the moment it is computed
  // and a countdown rendered from one gets worse with every second.
  assert.equal(decision.kind === "wait" ? decision.firesAt : "", "2026-07-30T01:30:00.000Z");
});

test("a clock that moved backwards cannot lengthen the wait past what was reported", () => {
  // `now` BEFORE the refusal instant. Elapsed is floored at zero, exactly as
  // `#parkForDesignLock` floors it, so the worst case is the full window.
  const decision = plan({ now: "2026-07-30T00:30:00.000Z" });
  assert.equal(decision.kind, "wait");
  assert.equal(decision.kind === "wait" ? decision.delayMs : -1, HALF_HOUR_SEC * 1_000);
});

test("a window that fully elapsed while the dashboard was down CONTINUES NOW", () => {
  assert.equal(plan({ now: "2026-07-30T09:00:00.000Z" }).kind, "continue");
});

test("AN UNREPRESENTABLE WAIT IS REFUSED, NOT CLAMPED — the 32-bit inversion", () => {
  // setTimeout keeps its delay in a signed 32-bit int: anything above
  // 2_147_483_647 ms FIRES IMMEDIATELY. Clamping would turn "wait 115 days" into
  // "resume in one millisecond", unattended, into a window that is certainly
  // still shut — the worst possible inversion of this feature.
  //
  // `maxWaitMs` IS RAISED ABOVE THE 32-BIT CEILING HERE ON PURPOSE, so this test
  // still measures the arm it is named after. With the default six-hour ceiling
  // the unattended arm would refuse first and this would pass without the 32-bit
  // guard existing at all.
  const decision = plan({ retryAfterSec: 10_000_000, maxWaitMs: RECOVERY_TIMER_MAX_DELAY_MS });
  assert.ok(10_000_000 * 1_000 > RECOVERY_TIMER_MAX_DELAY_MS, "the fixture has to exceed the ceiling");
  assert.equal(decision.kind, "stop");
  assert.equal(decision.kind === "stop" ? decision.code : "", "wait_unrepresentable");
  assert.notEqual(decision.kind, "wait", "an armed timer this long fires immediately");
  assert.notEqual(decision.kind, "continue");
});

test("THE UNATTENDED CEILING, which the 32-bit guard does not substitute for", () => {
  // MEASURED: every `rate_limit` frame in the owner's runs.db reports kind
  // `seven_day` with a reset 2.2-5.0 DAYS out — about 4.3e8 ms, comfortably
  // representable, so the guard above lets all of them through. This is the
  // ceiling that refuses a wait the OWNER did not agree to hold, and the honest
  // consequence is that on today's evidence a throttled run PARKS AND SAYS HOW
  // LONG rather than waiting.
  const fiveDays = 5 * 24 * 60 * 60;
  assert.ok(fiveDays * 1_000 < RECOVERY_TIMER_MAX_DELAY_MS, "a five-day wait is representable; that is the point");
  const decision = plan({ retryAfterSec: fiveDays });
  assert.equal(decision.kind, "stop");
  assert.equal(decision.kind === "stop" ? decision.code : "", "wait_too_long");
  const reason = decision.kind === "stop" ? decision.reason : "";
  assert.match(reason, /DASHBOARD_RECOVERY_MAX_WAIT_MIN/, "a refusal has to name the setting that lifts it");
});

test("the automatic-continuation cap stops the loop a weekly cap would otherwise create", () => {
  const decision = plan({ autoContinueCount: AUTO_CONTINUE_MAX });
  assert.equal(decision.kind, "stop");
  assert.equal(decision.kind === "stop" ? decision.code : "", "cap_reached");
  const reason = decision.kind === "stop" ? decision.reason : "";
  assert.match(reason, /continued itself/i, "the cap counts automatic continuations and must say so");
  // THE COUNTER CHANGED MEANING, AND THIS IS WHERE THAT IS PINNED. It used to be
  // `resumeCount`, which `resume()` increments for the owner's own button too —
  // so a run he had nursed by hand three times could never continue itself. The
  // sentence must no longer claim to count human resumes.
  assert.doesNotMatch(reason, /owner's own resumes/i);
  assert.equal(plan({ autoContinueCount: AUTO_CONTINUE_MAX - 1 }).kind, "wait");
});

/* =========================================================================
 * 2. The column, on a database that predates it
 * ====================================================================== */

test("a database written before rate_limited_at gains it on open, and it is writable", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-rl-migrate-"));
  try {
    const databasePath = join(dir, "old.db");
    const old = RunStore.open(databasePath);
    old.createRun({
      runId: "run-old",
      ticketId: "t-old",
      ticketTitle: "old",
      ticketText: "a portfolio page",
      ticketSha256: "e".repeat(64),
      modelId: "default",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
    old.close();

    // The old schema is REPRODUCED rather than assumed: `migrateRuns` skips a
    // column `PRAGMA table_info` already sees, so a test that opened a fresh
    // store and found the column would stay green with the migration deleted.
    const stripper = new DatabaseSync(databasePath);
    stripper.exec("ALTER TABLE runs DROP COLUMN rate_limited_at");
    const columns = stripper
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((row) => String(row["name"]));
    assert.ok(!columns.includes("rate_limited_at"), "the fixture did not reproduce the pre-column schema");
    stripper.close();

    const migrated = RunStore.open(databasePath);
    try {
      const row = migrated.getRun("run-old");
      assert.ok(row !== null, "the pre-existing run must still be readable");
      assert.equal(row.rateLimitedAt, null, "a run that predates the column was refused at no instant we know");
      // Present is not the same as writable.
      const patched = migrated.updateRun("run-old", { rateLimitedAt: REFUSED_AT });
      assert.equal(patched.rateLimitedAt, REFUSED_AT);
      assert.equal(migrated.updateRun("run-old", { rateLimitedAt: null }).rateLimitedAt, null);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* =========================================================================
 * 3. The durable half: what a restart does to a rate-limited run
 * ====================================================================== */

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: Orchestrator;
  readonly cleanup: () => Promise<void>;
}

/**
 * An orchestrator with no network, no builder and no live run.
 *
 * `env` is the whole point: it is the only thing that turns auto-resume on, and
 * it is read per decision rather than at construction, so a test cannot get a
 * true from a stale capture.
 */
function harness(env: NodeJS.ProcessEnv): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dash-rl-boot-"));
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
    cleanup: async () => {
      // Clears both timer maps as well as stopping the pump — an armed wait from
      // the "still waiting" test must not outlive its store.
      await orchestrator.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A run parked exactly as `#rateLimited` parks one, `minutesAgo` in the past. */
function seedRateLimited(
  store: RunStore,
  runId: string,
  fields: { minutesAgo: number | null; retryAfterSec: number | null; resumeCount?: number },
): void {
  store.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: runId,
    ticketText: `build ${runId}`,
    ticketSha256: "f".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
  store.updateRun(runId, {
    status: "rate_limited",
    phase: "build",
    queuePosition: null,
    rateLimited: true,
    rateLimitedAt:
      fields.minutesAgo === null ? null : new Date(Date.now() - fields.minutesAgo * 60_000).toISOString(),
    rateLimitRetryAfterSec: fields.retryAfterSec,
    rateLimitKind: "five_hour",
    builderSessionId: "session-xyz",
    ...(fields.resumeCount === undefined ? {} : { resumeCount: fields.resumeCount }),
  });
}

function logsOf(store: RunStore, runId: string): readonly string[] {
  return store
    .eventsSince(runId, 0)
    .map((stored) => stored.event)
    .filter((event) => event.type === "log")
    .map((event) => event.text);
}

test("BOOT, AUTO-RESUME ON, WINDOW ELAPSED: the run is requeued and says why", async () => {
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    // Refused 40 minutes ago with a 30-minute window: the wait was served in
    // wall-clock time while the dashboard was down.
    seedRateLimited(h.store, "run-drained", { minutesAgo: 40, retryAfterSec: HALF_HOUR_SEC });
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-drained");
    assert.equal(row?.status, "queued", "the reported window had elapsed, so the run goes back in the queue");
    assert.equal(row?.rateLimited, false);
    assert.equal(row?.rateLimitedAt, null, "the refusal instant is cleared so a later boot cannot re-arm on it");
    assert.equal(row?.resumeCount, 1, "an automatic resume is a resume, and it counts against the cap");
    const said = logsOf(h.store, "run-drained");
    assert.ok(
      said.some((text) => /resuming automatically/i.test(text)),
      "an unattended state change the owner did not make has to explain itself on the run's own log",
    );
  } finally {
    await h.cleanup();
  }
});

test("BOOT, AUTO-RESUME ON, WINDOW STILL OPEN: nothing is resumed and the deadline is NOT renewed", async () => {
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    // Refused 20 minutes into a 30-minute window. Ten minutes remain.
    seedRateLimited(h.store, "run-waiting", { minutesAgo: 20, retryAfterSec: HALF_HOUR_SEC });
    const before = h.store.getRun("run-waiting")?.rateLimitedAt ?? null;
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-waiting");
    assert.equal(row?.status, "rate_limited", "ten minutes of the provider's window are still to run");
    assert.equal(row?.resumeCount, 0);
    // THE FRESH-WINDOW NEGATIVE CONTROL. An implementation that re-armed from
    // `now` would also leave the row `rate_limited` here — what it could not do
    // is leave the ORIGINAL instant in place, which is the value the next boot
    // subtracts from. A restart loop that rewrote this every few minutes would
    // push the deadline forward forever.
    assert.equal(row?.rateLimitedAt, before, "the refusal instant is the one the provider's refusal happened at");
    const said = logsOf(h.store, "run-waiting");
    const armed = said.filter((text) => /automatic resume armed/i.test(text));
    assert.equal(armed.length, 1, "exactly one arm per boot, announced with the instant it fires");
    assert.match(String(armed[0]), /in 10 min/, "the remainder, not the full window");
  } finally {
    await h.cleanup();
  }
});

test("BOOT, AUTO-RESUME ON, NO REPORTED RESET, LONG PAST: the chosen hold has elapsed and the run continues", async () => {
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    // The error-text path: refused ten hours ago, with no `resetsAt` anywhere.
    // Until 2026-08-09 this row sat `rate_limited` for ever — the run the owner
    // started on a Friday, found parked on Saturday, having burned the window.
    // Ten hours is past the five-hour chosen hold, so the boot sweep continues
    // it. Whether the window really reopened is unknowable from here; the next
    // call is the only evidence, and a refusal simply parks it again.
    seedRateLimited(h.store, "run-unknown", { minutesAgo: 600, retryAfterSec: null });
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-unknown");
    assert.equal(row?.status, "queued", "a refusal with no instant is no longer a run that waits for a human");
    assert.equal(row?.resumeCount, 1, "an automatic resume is a resume, and it counts against the cap");
    assert.ok(
      logsOf(h.store, "run-unknown").some((text) => /resuming automatically/i.test(text)),
      "an unattended state change the owner did not make has to explain itself on the run's own log",
    );
    assert.ok(
      logsOf(h.store, "run-unknown").some((text) => /chosen length/i.test(text)),
      "and it has to say the length it waited was chosen here, not reported by the provider",
    );
  } finally {
    await h.cleanup();
  }
});

test("BOOT, AUTO-RESUME ON, NO REPORTED RESET, RECENT: the hold is armed, NOT served immediately", async () => {
  // THE NEGATIVE CONTROL FOR THE TEST ABOVE, and the one the old `stop` arm made
  // unnecessary. Without it, "no reported reset" is satisfied by an
  // implementation that resumes every such run the moment it boots — a
  // countdown from zero, which is the invention the old arm was written to
  // refuse and which this change must not reintroduce.
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    seedRateLimited(h.store, "run-recent", { minutesAgo: 60, retryAfterSec: null });
    const before = h.store.getRun("run-recent")?.rateLimitedAt ?? null;
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-recent");
    assert.equal(row?.status, "rate_limited", "four of the five chosen hours are still to run");
    assert.equal(row?.resumeCount, 0);
    assert.equal(row?.rateLimitedAt, before, "the refusal instant is not rewritten, or a restart loop renews it");
    const armed = logsOf(h.store, "run-recent").filter((text) => /automatic resume armed/i.test(text));
    assert.equal(armed.length, 1, "exactly one arm per boot, announced with the instant it fires");
    assert.match(String(armed[0]), /restarts itself in 240 min/, "the remainder of the hold, not the whole of it");
    assert.match(String(armed[0]), /chosen length/i, "and the length is declared a choice, not a measurement");
  } finally {
    await h.cleanup();
  }
});

test("BOOT, AUTO-RESUME ON, ROW PREDATES THE COLUMN: no instant, no arm", async () => {
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    // `rate_limited_at` is NULL on every row written before the migration. The
    // tempting repair — treat it as `now` — hands a run that was refused
    // yesterday a brand new window on every restart.
    seedRateLimited(h.store, "run-legacy", { minutesAgo: null, retryAfterSec: HALF_HOUR_SEC });
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    assert.equal(h.store.getRun("run-legacy")?.status, "rate_limited");
    assert.ok(
      logsOf(h.store, "run-legacy").some((text) => /remaining wait cannot be computed/i.test(text)),
      "the run is told the wait is unknown rather than being given a new one",
    );
  } finally {
    await h.cleanup();
  }
});

test("BOOT, AUTO-RESUME OFF: an elapsed window resumes NOTHING and the boot sweep is silent", async () => {
  // THE FLAG IS NOW NAMED RATHER THAN ASSUMED — 2026-08-05. This test says "OFF"
  // in its own title and used to get it from an empty environment, because
  // `DASHBOARD_AUTO_RECOVER` was opt-in. It is now ON by default (nothing on the
  // owner's machine ever set it, so opt-in meant the feature never ran), which
  // makes `{}` the ENABLED case. Writing the off switch out is what keeps this
  // test measuring the arm it was written for.
  const h = harness({ [RECOVERY_ENABLED_ENV]: "0" });
  try {
    seedRateLimited(h.store, "run-off", { minutesAgo: 600, retryAfterSec: HALF_HOUR_SEC });
    const before = h.store.getRun("run-off")?.rateLimitedAt ?? null;
    assert.ok(before !== null, "the fixture must carry an instant, or this test proves nothing");
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-off");
    // THE DISCRIMINATING ASSERTION IS THIS ONE, not the silence below. With the
    // flag on, this same row (600 minutes past a 30-minute window) is requeued
    // and has its instant cleared — so "still rate_limited, still carrying the
    // original instant" is a state the enabled sweep could not have produced,
    // rather than an absence that a harness recording no events at all would
    // also satisfy.
    assert.equal(row?.status, "rate_limited", "the default install waits for a human, however long it has been");
    assert.equal(row?.rateLimitedAt, before, "nothing swept this row");
    assert.equal(row?.resumeCount, 0);
    // The "a human has to resume this" sentence is emitted where it is useful —
    // at the refusal, by `#rateLimited` — and not repeated on every boot, which
    // on a crash loop would bury the one that mattered. Weak on its own (an
    // empty list has many causes); it is here to pin the no-noise decision, and
    // the state assertions above are what pin the behaviour.
    assert.deepEqual(logsOf(h.store, "run-off"), [], "no boot sweep runs at all when the feature is off");
  } finally {
    await h.cleanup();
  }
});

test("THE KILL SWITCH BEATS THE LEGACY FLAG: 0 wins even with DASHBOARD_RATE_LIMIT_AUTO_RESUME=1", async () => {
  /*
   * THE SEAM THIS CLOSES, 2026-08-05. `#recoveryEnabled` read
   *
   *     if (autoRecoverEnabled(env)) return true;
   *     return klass === "throttled" && rateLimitAutoResume(env);
   *
   * which was correct while `DASHBOARD_AUTO_RECOVER` was OPT-IN: two flags that
   * could only ever ADD consent to each other. Now that it is an OFF SWITCH, the
   * second line let a stale legacy variable overrule the owner's "0" for the
   * `throttled` class — and a kill switch one forgotten plist entry can defeat
   * is not a kill switch. The whole reason the environment variable was kept is
   * that he can stop unattended spending WITHOUT A REBUILD.
   *
   * CONTROL: put the two lines back in `#recoveryEnabled` and this goes red at
   * `queued` — the run resumes itself on the legacy flag while the owner's own
   * switch says not to.
   */
  const h = harness({ [RECOVERY_ENABLED_ENV]: "0", [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    // Refused 40 minutes ago into a 30-minute window: the wait is served, so an
    // enabled sweep WOULD requeue this row. That is what makes the assertion
    // below discriminating rather than an absence with many causes.
    seedRateLimited(h.store, "run-killed", { minutesAgo: 40, retryAfterSec: HALF_HOUR_SEC });
    const before = h.store.getRun("run-killed")?.rateLimitedAt ?? null;
    assert.ok(before !== null, "the fixture must carry an instant, or this test proves nothing");
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-killed");
    assert.equal(row?.status, "rate_limited", "the owner switched it off; nothing may resume on the old flag");
    assert.equal(row?.rateLimitedAt, before, "and nothing swept this row");
    assert.equal(row?.resumeCount, 0);
    assert.equal(row?.autoContinueCount, 0, "a refusal charges nothing");
  } finally {
    await h.cleanup();
  }
});

test("a manual resume disarms the park: the instant is cleared and the cap counter moves", async () => {
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    seedRateLimited(h.store, "run-manual", { minutesAgo: 20, retryAfterSec: HALF_HOUR_SEC });
    await h.orchestrator.shutdown();
    h.orchestrator.reconcileOnBoot();
    assert.equal(h.store.getRun("run-manual")?.status, "rate_limited", "armed, still waiting");

    assert.equal(h.orchestrator.resume("run-manual"), true);

    const row = h.store.getRun("run-manual");
    assert.equal(row?.status, "queued");
    assert.equal(row?.rateLimitedAt, null, "a timer left armed on this row would requeue a RUNNING run later");
    assert.equal(row?.rateLimitRetryAfterSec, null);
    assert.equal(row?.resumeCount, 1);
  } finally {
    await h.cleanup();
  }
});
