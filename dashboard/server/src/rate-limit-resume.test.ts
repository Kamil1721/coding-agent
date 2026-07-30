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
import {
  Orchestrator,
  RATE_LIMIT_AUTO_RESUME_ENV,
  RATE_LIMIT_AUTO_RESUME_MAX_RESUMES,
  RATE_LIMIT_RESUME_MAX_DELAY_MS,
  planRateLimitResume,
  rateLimitAutoResume,
} from "./orchestrator.js";
import type { RateLimitResumeInput } from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";

/* =========================================================================
 * 1. The pure decision
 * ====================================================================== */

const REFUSED_AT = "2026-07-30T01:00:00.000Z";
const HALF_HOUR_SEC = 1_800;

/** Enabled, refused half an hour ago, and the window is half an hour long. */
function plan(over: Partial<RateLimitResumeInput> = {}): ReturnType<typeof planRateLimitResume> {
  return planRateLimitResume({
    enabled: true,
    rateLimitedAt: REFUSED_AT,
    retryAfterSec: HALF_HOUR_SEC,
    resumeCount: 0,
    now: "2026-07-30T01:20:00.000Z",
    ...over,
  });
}

test("OFF IS THE DEFAULT, and the refusal names the switch and the human", () => {
  const decision = plan({ enabled: false });
  assert.equal(decision.kind, "disabled");
  const reason = decision.kind === "disabled" ? decision.reason : "";
  assert.match(reason, new RegExp(RATE_LIMIT_AUTO_RESUME_ENV));
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

test("A NULL retryAfterSec ARMS NOTHING — the whole error-text path", () => {
  // The provider reports `resetsAt` on the structured path and nothing at all on
  // the error-text path, where `retryAfterSec` stays null (claude-common.ts). A
  // countdown from a number nobody reported is exactly the invention this repo
  // refuses, so this must be `disabled` — and it must be disabled FOR THAT
  // REASON, not because the flag happened to be off.
  const decision = plan({ retryAfterSec: null });
  assert.equal(decision.kind, "disabled");
  const reason = decision.kind === "disabled" ? decision.reason : "";
  assert.match(reason, /no reset instant/i);
  assert.doesNotMatch(reason, new RegExp(RATE_LIMIT_AUTO_RESUME_ENV), "enabled was true; this is not the off path");
});

test("a reported reset that is not in the future arms nothing either", () => {
  // `Math.max(0, ...)` in claude-common.ts makes 0 reachable: the provider
  // refused while naming an instant already past. Answering it with no wait
  // walks straight back into the same refusal.
  for (const retryAfterSec of [0, -5]) {
    const decision = plan({ retryAfterSec });
    assert.equal(decision.kind, "disabled", String(retryAfterSec));
    assert.notEqual(decision.kind, "due", "zero seconds is not a drained window");
  }
});

test("NO RECORDED REFUSAL INSTANT IS A REFUSAL, NOT A FRESH WINDOW", () => {
  // The inversion of `designLockExpired`, which treats an unparseable timestamp
  // as expired because ending a park is the safe direction there. Here the safe
  // direction is the opposite: with no idea when the refusal happened there is
  // no idea what remains, and arming from `now` would renew the window.
  for (const rateLimitedAt of [null, "not-a-date", ""]) {
    const decision = plan({ rateLimitedAt });
    assert.equal(decision.kind, "disabled", String(rateLimitedAt));
    const reason = decision.kind === "disabled" ? decision.reason : "";
    assert.match(reason, /remaining wait cannot be computed/i);
  }
});

test("THE REMAINDER, NOT A FRESH WINDOW: 20 minutes served of 30 leaves 10", () => {
  const decision = plan();
  assert.equal(decision.kind, "armed");
  assert.equal(decision.kind === "armed" ? decision.delayMs : -1, 600_000);
  assert.ok(
    (decision.kind === "armed" ? decision.delayMs : Infinity) < HALF_HOUR_SEC * 1_000,
    "an implementation that timed from `now` would arm the full window here",
  );
});

test("a clock that moved backwards cannot lengthen the wait past what was reported", () => {
  // `now` BEFORE the refusal instant. Elapsed is floored at zero, exactly as
  // `#parkForDesignLock` floors it, so the worst case is the full window.
  const decision = plan({ now: "2026-07-30T00:30:00.000Z" });
  assert.equal(decision.kind, "armed");
  assert.equal(decision.kind === "armed" ? decision.delayMs : -1, HALF_HOUR_SEC * 1_000);
});

test("a window that fully elapsed while the dashboard was down is DUE", () => {
  assert.equal(plan({ now: "2026-07-30T09:00:00.000Z" }).kind, "due");
});

test("AN UNREPRESENTABLE WAIT IS REFUSED, NOT CLAMPED — the 32-bit inversion", () => {
  // setTimeout keeps its delay in a signed 32-bit int: anything above
  // 2_147_483_647 ms FIRES IMMEDIATELY. Clamping would turn "wait 115 days" into
  // "resume in one millisecond", unattended, into a window that is certainly
  // still shut — the worst possible inversion of this feature.
  const decision = plan({ retryAfterSec: 10_000_000 });
  assert.ok(10_000_000 * 1_000 > RATE_LIMIT_RESUME_MAX_DELAY_MS, "the fixture has to exceed the ceiling");
  assert.equal(decision.kind, "disabled");
  assert.notEqual(decision.kind, "armed", "an armed timer this long fires immediately");
  assert.notEqual(decision.kind, "due");
});

test("the total-resume cap stops the loop a weekly cap would otherwise create", () => {
  const decision = plan({ resumeCount: RATE_LIMIT_AUTO_RESUME_MAX_RESUMES });
  assert.equal(decision.kind, "disabled");
  const reason = decision.kind === "disabled" ? decision.reason : "";
  assert.match(reason, /owner's own resumes too/i, "the cap counts human resumes and must say so");
  assert.equal(plan({ resumeCount: RATE_LIMIT_AUTO_RESUME_MAX_RESUMES - 1 }).kind, "armed");
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

test("BOOT, AUTO-RESUME ON, NO REPORTED RESET: the run stays parked and the log says so", async () => {
  const h = harness({ [RATE_LIMIT_AUTO_RESUME_ENV]: "1" });
  try {
    // The error-text path: refused long ago, with no `resetsAt` anywhere.
    seedRateLimited(h.store, "run-unknown", { minutesAgo: 600, retryAfterSec: null });
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-unknown");
    assert.equal(row?.status, "rate_limited", "a null retryAfterSec must not become a countdown from zero");
    assert.equal(row?.resumeCount, 0);
    assert.ok(
      logsOf(h.store, "run-unknown").some((text) => /no automatic resume is armed.*no reset instant/is.test(text)),
      "disabled WITH A REASON, on the run's own stream",
    );
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
  const h = harness({});
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
