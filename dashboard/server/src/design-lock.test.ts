import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesignManifest } from "./design-manifest.js";
import {
  DEFAULT_DESIGN_LOCK_TIMEOUT_MIN,
  designLockExpired,
  designLockPolicy,
  designLockTimeoutMin,
  fallbackChoice,
  lockManifest,
  readChoiceFile,
  readDesignLock,
  writeDesignLock,
} from "./design-lock.js";

const WS = "/runs/r1/workspace";
const A = `${WS}/design-refs/01-hero.png`;
const B = `${WS}/design-refs/02-work.png`;
const AT = "2026-07-29T10:00:00.000Z";

const MANIFEST: DesignManifest = {
  version: 1,
  refs: [
    { path: A, section: "hero", aspect: "21:9", intent: "opening" },
    { path: B, section: "work", aspect: "16:9", intent: "projects" },
  ],
  lockedMockup: null,
  lockedBy: null,
  lockedReason: null,
  lockedAt: null,
};

test("RULE 2: a non-interactive request defaults to auto — a cron run never parks", () => {
  // "A scheduled run that parks forever waiting for a click is the exact failure
  // unattended operation exists to avoid."
  assert.equal(designLockPolicy(undefined, false), "auto");
  assert.equal(designLockPolicy(null, false), "auto");
  assert.equal(designLockPolicy("ask", false), "ask", "an EXPLICIT ask is still honoured");
  assert.equal(designLockPolicy(undefined, true), "ask", "an interactive request may pause");
  assert.equal(designLockPolicy("nonsense", false), "auto", "an unknown value is not an error, it is auto");
});

test("RULE 1: the timeout is finite, configurable, and never zero or infinite", () => {
  assert.equal(designLockTimeoutMin({}), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "5" }), 5);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "-1" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "nope" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
});

test("RULE 1: expiry is computed from the park time, so a server restart cannot make a park infinite", () => {
  assert.equal(designLockExpired(AT, "2026-07-29T10:29:00.000Z", 30), false);
  assert.equal(designLockExpired(AT, "2026-07-29T10:31:00.000Z", 30), true);
  assert.equal(designLockExpired("not a date", "2026-07-29T10:31:00.000Z", 30), true, "an unreadable park time expires");
});

test("RULE 4: a lock without a chooser and a reason cannot be constructed", () => {
  const locked = lockManifest(MANIFEST, { path: A, by: "owner", reason: "the type is doing the work", at: AT });
  assert.equal(locked.ok, true);
  assert.ok(locked.ok && locked.manifest.lockedMockup === A);
  assert.ok(locked.ok && locked.manifest.lockedBy === "owner");
  assert.ok(locked.ok && locked.manifest.lockedReason === "the type is doing the work");
  assert.ok(locked.ok && locked.manifest.lockedAt === AT);

  const empty = lockManifest(MANIFEST, { path: A, by: "owner", reason: "   ", at: AT });
  assert.equal(empty.ok, false, "an unattended run must be explainable after the fact");
});

test("a chosen path that is not one of the refs is REFUSED", () => {
  // The path arrives from an HTTP body and from an agent-written file. Either
  // could name ~/.gemini/api_key, and the locked path is injected into every
  // build prompt and Read by the visual gate.
  const forged = lockManifest(MANIFEST, { path: `${WS}/design-refs/99.png`, by: "owner", reason: "x", at: AT });
  assert.equal(forged.ok, false);
  assert.match(String(!forged.ok && forged.error), /not one of/iu);
  assert.equal(lockManifest(MANIFEST, { path: "/etc/passwd", by: "owner", reason: "x", at: AT }).ok, false);
});

test("locking twice is refused — a run has one chosen design", () => {
  const first = lockManifest(MANIFEST, { path: A, by: "owner", reason: "x", at: AT });
  assert.ok(first.ok);
  const second = lockManifest(first.manifest, { path: B, by: "ui-designer", reason: "y", at: AT });
  assert.equal(second.ok, false, "the gate would then grade against a reference the build never saw");
});

test("RULE 3: the choice file is read as ui-designer's, and validated against the manifest", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-"));
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: B, reason: "denser grid" }), "utf8");
  const attempt = readChoiceFile(refsDir, MANIFEST, AT);
  assert.equal(attempt?.path, B);
  assert.equal(attempt?.by, "ui-designer");
  assert.match(String(attempt?.reason), /denser grid/u);
});

test("RULE 3: a choice file naming a path outside the manifest yields NO attempt", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-bad-"));
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: "/etc/passwd", reason: "x" }), "utf8");
  assert.equal(readChoiceFile(refsDir, MANIFEST, AT), null);
});

test("RULE 5: the lock record round-trips, and a park's clock is on DISK", () => {
  // The timeout has to survive a dashboard restart, and a timer does not. The
  // park time is written down so `reconcileOnBoot` can ask how long it has been.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-"));
  const record = { awaiting: true, parkedAt: AT, locked: null, lockedBy: null, reason: null } as const;
  writeDesignLock(dir, record);
  assert.deepEqual(readDesignLock(dir), record);
  assert.equal(readDesignLock(mkdtempSync(join(tmpdir(), "design-lock-empty-"))), null);
});

test("RULE 5: a RESOLVED lock round-trips — the path, the chooser and the reason all survive the disk", () => {
  // The parked record above is all nulls, so it cannot see a `writeDesignLock`
  // that drops the three fields that matter. This is the record Task 10 writes
  // once a lock is applied (`{awaiting: false, parkedAt: attempt.at, locked:
  // attempt.path, lockedBy: attempt.by, reason: attempt.reason}`), and `locked`
  // is the gate's input — rule 5 is exactly the claim that it is written down.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-resolved-"));
  const record = { awaiting: false, parkedAt: AT, locked: B, lockedBy: "ui-designer", reason: "denser grid" } as const;
  writeDesignLock(dir, record);
  assert.deepEqual(readDesignLock(dir), record);
  assert.equal(readDesignLock(dir)?.locked, B, "the gate's input is the field that must not be dropped");
  assert.equal(readDesignLock(dir)?.lockedBy, "ui-designer", "RULE 4: who made it, still there after the disk");
  assert.equal(readDesignLock(dir)?.reason, "denser grid", "RULE 4: and why");
});

test("RULE 4: when the chooser produced nothing, the fallback is RECORDED AS a fallback", () => {
  // Recording it as "ui-designer" would be a lie about provenance; recording
  // nothing would leave an unattended run unexplainable.
  const attempt = fallbackChoice(MANIFEST, AT, "ui-designer wrote no choice.json");
  assert.equal(attempt?.by, "fallback");
  assert.equal(attempt?.path, A, "first by manifest order, stated rather than dressed up as a judgement");
  assert.match(String(attempt?.reason), /wrote no choice\.json/u);
  assert.equal(fallbackChoice({ ...MANIFEST, refs: [] }, AT, "x"), null, "no refs, no lock — never an invented one");
});

/* ---- RULE 1, executed rather than asserted about ------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

type TimeoutOutcome =
  | { readonly kind: "locked"; readonly manifest: DesignManifest }
  | { readonly kind: "no-lock"; readonly why: string }
  | { readonly kind: "never-fired" };

/**
 * The park, run against a real clock.
 *
 * The body of the timer is the sequence Task 10's `resume(runId, null)` runs on
 * expiry, in its order: `readChoiceFile(...) ?? fallbackChoice(...)`, then
 * `lockManifest`. The delay is the expression its `#parkForDesignLock` schedules,
 * `designLockTimeoutMin(env) * 60_000`.
 *
 * THE WATCHDOG IS THE POINT. Without it a park that never expires would hang the
 * test until the runner's own timeout and report as an infrastructure problem;
 * with it, "the park never ended" is an assertion that fails by name — which is
 * the only observable rule 1 actually cares about.
 */
function resolveParkOnTimeout(delayMs: number, refsDir: string, watchdogMs: number): Promise<TimeoutOutcome> {
  return new Promise<TimeoutOutcome>((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(watchdog);
      const at = new Date().toISOString();
      const attempt =
        readChoiceFile(refsDir, MANIFEST, at) ??
        fallbackChoice(MANIFEST, at, "no owner choice arrived before the timeout");
      if (attempt === null) {
        resolve({ kind: "no-lock", why: "neither the chooser nor the fallback produced an attempt" });
        return;
      }
      const result = lockManifest(MANIFEST, attempt);
      resolve(result.ok ? { kind: "locked", manifest: result.manifest } : { kind: "no-lock", why: result.error });
    }, delayMs);
    const watchdog = setTimeout(() => {
      clearTimeout(timer);
      resolve({ kind: "never-fired" });
    }, watchdogMs);
  });
}

test("RULE 1: the park EXPIRES ON ITS OWN and auto-selects — the timer fires, a lock exists", async () => {
  // Rule 1 is not "a constant exists". It is "a park that nobody clicks still
  // ends". So this schedules the real delay against the real clock and asserts a
  // lock came out of it — and a timeout that silently never arrives fails here
  // rather than being invisible until an unattended run parks overnight.
  //
  // THE BOUND IS ASSERTED BEFORE THE TIMER IS ARMED, DELIBERATELY: Node coerces a
  // non-finite or out-of-range `setTimeout` delay to 1ms, so an infinite timeout
  // would make a "did the callback run?" assertion pass. Firing is necessary
  // evidence and not sufficient evidence; the delay itself has to be finite.
  const env = { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0.002" };
  const delayMs = designLockTimeoutMin(env) * 60_000;
  assert.ok(Number.isFinite(delayMs) && delayMs > 0, `a park scheduled at ${String(delayMs)}ms never ends by itself`);
  assert.ok(delayMs <= DAY_MS, "a park longer than a day is indefinite in every sense that matters");
  const defaultDelayMs = designLockTimeoutMin({}) * 60_000;
  assert.ok(Number.isFinite(defaultDelayMs) && defaultDelayMs <= DAY_MS, "the DEFAULT park is bounded too");

  const chose = mkdtempSync(join(tmpdir(), "design-timeout-chose-"));
  writeFileSync(join(chose, "choice.json"), JSON.stringify({ chosen: B, reason: "denser grid" }), "utf8");
  const withChooser = await resolveParkOnTimeout(delayMs, chose, 5_000);
  assert.equal(withChooser.kind, "locked", "the park did not resolve itself within the configured timeout");
  assert.ok(withChooser.kind === "locked" && withChooser.manifest.lockedMockup === B);
  assert.ok(withChooser.kind === "locked" && withChooser.manifest.lockedBy === "ui-designer", "RULE 3 on the auto path");

  const silent = mkdtempSync(join(tmpdir(), "design-timeout-silent-"));
  const withoutChooser = await resolveParkOnTimeout(delayMs, silent, 5_000);
  assert.equal(withoutChooser.kind, "locked", "no chooser file must still end the park — with a lock, not with nothing");
  assert.ok(withoutChooser.kind === "locked" && withoutChooser.manifest.lockedMockup === A);
  assert.ok(withoutChooser.kind === "locked" && withoutChooser.manifest.lockedBy === "fallback", "RULE 4, named");
  assert.match(String(withoutChooser.kind === "locked" ? withoutChooser.manifest.lockedReason : ""), /timeout/u);
});

test("RULE 1: the timer's deadline and the restart deadline are the SAME instant", () => {
  // Task 10 arms `setTimeout(..., designLockTimeoutMin(env) * 60_000)`, and after
  // a restart `reconcileOnBoot` asks `designLockExpired(parkedAt, now, mins)`
  // instead. The two have to agree AT the deadline: a park the timer would have
  // resolved at exactly T+delay, that the boot path then calls "still waiting",
  // is a park with no remaining mechanism to end it — rule 1 broken by one
  // millisecond of disagreement between two files.
  const timeoutMin = designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" });
  const delayMs = timeoutMin * 60_000;
  const atDeadline = new Date(Date.parse(AT) + delayMs).toISOString();
  const oneBefore = new Date(Date.parse(AT) + delayMs - 1).toISOString();
  assert.equal(designLockExpired(AT, atDeadline, timeoutMin), true, "the instant the timer fires, the park IS expired");
  assert.equal(designLockExpired(AT, oneBefore, timeoutMin), false, "and not one millisecond before it");
});
