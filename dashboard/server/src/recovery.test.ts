/**
 * recovery.test.ts — the decision that spends the owner's subscription while
 * nobody is watching, driven through every arm it has.
 *
 * WHAT THIS FILE IS WATCHING FOR. Almost every test below asserts that NOTHING
 * happened: no continuation, no timer, no window restarted from now. A check
 * that can only observe a successful retry is the defect this repository keeps
 * finding, and for a retry feature it is fatal — a test that passes whether or
 * not the retry happened would let "retries nine times, reports three" ship
 * green. So the file is organised around the four ways this module can be wrong
 * in the expensive direction:
 *
 *   1. It recognises a class and decides the wrong thing about it (§2).
 *   2. Its bound does not bound (§4). The cap is the only thing between
 *      park -> continue -> park and an unattended loop through a 51-minute phase.
 *   3. It retries something it does not recognise (§3). THE RUNAWAY GUARD, and
 *      the single most important test here.
 *   4. It arms a wait it cannot justify — zero, invented, or days long (§5, §6).
 *
 * NO CLOCK AND NO TIMER. `now` is a string argument, so the five-day window this
 * machine actually reports is exercised in microseconds. A test that slept for a
 * real window is a test nobody runs.
 *
 * ONE IMPORT FROM `orchestrator.ts`, AND ONLY IN THIS FILE: §1 asserts that the
 * abort-reason strings this module copies still equal the constants the
 * orchestrator aborts with. The module may not import them (it would stop being
 * pure); the test may, and that is what turns a rename over there red over here
 * instead of silently reclassifying every cancellation as an unknown fault.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { ABORT_CANCELLED, ABORT_SHUTDOWN } from "./orchestrator.js";
import {
  AUTO_CONTINUE_MAX,
  RECOVERY_ABORT_CANCELLED,
  RECOVERY_ABORT_SHUTDOWN,
  RECOVERY_ENABLED_ENV,
  RECOVERY_MAX_AUTO_WAIT_MS,
  RECOVERY_MAX_WAIT_ENV,
  RECOVERY_TIMER_MAX_DELAY_MS,
  TRANSIENT_BACKOFF_MS,
  TRANSIENT_MAX,
  autoRecoverEnabled,
  boundFor,
  classifyPhaseFailure,
  interruptedSignals,
  mayAutoContinue,
  planRecovery,
  recoveryMaxWaitMs,
  signalsFor,
  throttleHintFromMessage,
} from "./recovery.js";
import type { PhaseFailureSignals, RecoveryDecision, RecoveryInput, RefusalEvidence } from "./recovery.js";

/* =========================================================================
 * 0. Fixtures — all instants literal, all numbers measured where they can be
 * ====================================================================== */

const REFUSED_AT = "2026-08-04T01:00:00.000Z";
const NOW = "2026-08-04T01:20:00.000Z";
const HALF_HOUR_SEC = 1_800;

/**
 * The real thing, off this machine's own `runs.db`: every `rate_limit` frame
 * ever recorded here reports kind `seven_day`, 2.2-5.0 days out. 431 997 s is
 * five days minus three seconds — the far end of the measured range, and the
 * number the ceiling test drives, because a ceiling proved only against an
 * invented value is a ceiling proved against nothing.
 */
const SEVEN_DAY_SEC = 431_997;

const NO_SIGNALS: PhaseFailureSignals = {
  aborted: false,
  abortReason: null,
  interrupted: false,
  bakeoffCode: null,
  seatKind: null,
  refusal: null,
};

function refusal(over: Partial<RefusalEvidence> = {}): RefusalEvidence {
  return { limited: true, retryAfterSec: HALF_HOUR_SEC, kind: "five_hour", observedAt: REFUSED_AT, ...over };
}

/** A throttle the provider refused half an hour ago into a half-hour window. */
function decide(over: Partial<RecoveryInput> = {}): RecoveryDecision {
  return planRecovery({
    signals: { ...NO_SIGNALS, seatKind: "throttled", refusal: refusal() },
    autoContinueCount: 0,
    enabled: true,
    now: NOW,
    maxWaitMs: RECOVERY_MAX_AUTO_WAIT_MS,
    ...over,
  });
}

function reasonOf(d: RecoveryDecision): string {
  return d.reason;
}

/* =========================================================================
 * 1. The copied constants
 * ====================================================================== */

test("the abort reasons this module copies still equal the ones the orchestrator aborts with", () => {
  assert.equal(RECOVERY_ABORT_CANCELLED, ABORT_CANCELLED);
  assert.equal(RECOVERY_ABORT_SHUTDOWN, ABORT_SHUTDOWN);
});

/* =========================================================================
 * 2. One test per class: the class is recognised AND the decision is right
 * ====================================================================== */

test("intentional: a cancelled run is classified intentional and is NOT continued", () => {
  const ctrl = new AbortController();
  ctrl.abort(ABORT_CANCELLED);
  const signals = signalsFor(new Error("Claude Code process aborted by user"), ctrl.signal, null);

  assert.equal(classifyPhaseFailure(signals), "intentional");
  assert.equal(signals.abortReason, "cancelled");

  const d = decide({ signals });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "class_terminal");
  assert.match(reasonOf(d), /stopped on purpose/i);
});

test("intentional beats throttled: an abort carrying a live refusal is still NOT continued", () => {
  // The ordering trap, stated as a test. A classifier that asked "was it rate
  // limited?" first would restart runs the owner deliberately killed, and the
  // refusal evidence here is exactly as real as it is on a genuine throttle.
  const ctrl = new AbortController();
  ctrl.abort(ABORT_CANCELLED);
  const signals = signalsFor(new Error("rate limit reached"), ctrl.signal, refusal());

  assert.equal(classifyPhaseFailure(signals), "intentional");
  assert.equal(decide({ signals }).kind, "stop");
});

test("intentional: a shutdown abort is intentional too, and reads its reason from the signal", () => {
  const ctrl = new AbortController();
  ctrl.abort(ABORT_SHUTDOWN);
  const signals = signalsFor(new Error("aborted"), ctrl.signal, null);
  assert.equal(signals.abortReason, "shutdown");
  assert.equal(classifyPhaseFailure(signals), "intentional");
});

test("interrupted: a run the process died under continues NOW, with no wait", () => {
  const d = decide({ signals: interruptedSignals() });
  assert.equal(classifyPhaseFailure(interruptedSignals()), "interrupted");
  assert.equal(d.kind, "continue");
  assert.match(reasonOf(d), /died under this run/i);
});

test("structural: a BakeoffError is classified structural and is NOT retried at the phase level", () => {
  // THE 2026-08-04 DEATH, in the shape it actually arrives in. The call level
  // exhausted its one ceiling rung and converted the result into a BakeoffError
  // whose remediation says regenerating cannot fix it. If the phase level
  // retried this, a 51-minute spec phase would be re-run against a ceiling that
  // cannot move — three times, reported as one.
  const err = Object.assign(new Error("the authored suite exceeded the streamable ceiling"), {
    name: "BakeoffError",
    code: "invalid_usage_shape",
    remediation: "regenerating cannot fix it — there is no higher max_tokens to retry at",
  });
  const signals = signalsFor(err, null, null);

  assert.equal(signals.bakeoffCode, "invalid_usage_shape");
  assert.equal(classifyPhaseFailure(signals), "structural");

  const d = decide({ signals });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "class_terminal");
  assert.equal(boundFor("structural"), 0);
});

test("structural: EVERY BakeoffError code stops, including one this file has never heard of", () => {
  // The bound is on the error TYPE, not on a list of codes. A list would drop a
  // code added later and the run would start retrying it unattended.
  for (const code of ["suite_not_audited", "suite_hash_mismatch", "missing_credential", "a_code_added_in_2027"]) {
    const err = Object.assign(new Error(code), { name: "BakeoffError", code, remediation: "x" });
    assert.equal(classifyPhaseFailure(signalsFor(err, null, null)), "structural", code);
  }
});

test("structural beats throttled: a BakeoffError thrown near a rate limit is still futile", () => {
  const err = Object.assign(new Error("boom"), { name: "BakeoffError", code: "budget_exceeded", remediation: "x" });
  const signals = signalsFor(err, null, refusal());
  assert.equal(classifyPhaseFailure(signals), "structural");
  assert.equal(decide({ signals }).kind, "stop");
});

test("structural: a seat `protocol` failure is structural, not transient", () => {
  // `error_max_turns` is an SDK result subtype. Retrying identically re-hits the
  // same turn cap; the fix is an env var, not another attempt.
  const err = Object.assign(new Error("error_max_turns"), { name: "SeatCallError", kind: "protocol" });
  assert.equal(classifyPhaseFailure(signalsFor(err, null, null)), "structural");
});

test("throttled: a typed seat throttle with a refusal waits, and the wait is the window's remainder", () => {
  const d = decide();
  assert.equal(d.kind, "wait");
  if (d.kind !== "wait") return;
  // Refused at 01:00 into a 1800 s window, asked at 01:20: 600 s remain. NOT
  // 1800 — re-arming the full window from now is the inversion the refusal
  // instant exists to prevent.
  assert.equal(d.delayMs, 600_000);
  assert.equal(d.firesAt, "2026-08-04T01:30:00.000Z");
});

test("throttled: a refusal carried with the failure is enough on its own, with no typed kind", () => {
  const signals: PhaseFailureSignals = { ...NO_SIGNALS, refusal: refusal() };
  assert.equal(classifyPhaseFailure(signals), "throttled");
  assert.equal(decide({ signals }).kind, "wait");
});

test("throttled: `limited:false` is telemetry, not a refusal, and does not classify as throttled", () => {
  // `#noteRateLimit` fires routinely with limited:false to report a window
  // filling. Classifying off that would park runs nothing ever refused.
  const signals: PhaseFailureSignals = { ...NO_SIGNALS, refusal: refusal({ limited: false }) };
  assert.equal(classifyPhaseFailure(signals), "unclassified");
  const d = decide({ signals });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "class_terminal");
});

test("transient: the arm exists, is reachable by injection, and waits a bounded backoff", () => {
  const signals: PhaseFailureSignals = { ...NO_SIGNALS, seatKind: "transport" };
  assert.equal(classifyPhaseFailure(signals), "transient");
  const d = decide({ signals });
  assert.equal(d.kind, "wait");
  assert.equal(d.kind === "wait" ? d.delayMs : -1, TRANSIENT_BACKOFF_MS);
  assert.equal(boundFor("transient"), TRANSIENT_MAX);
});

/* =========================================================================
 * 3. THE RUNAWAY GUARD — an unrecognised failure STOPS
 * ====================================================================== */

test("RUNAWAY GUARD: a failure nothing recognises stops, and says nothing recognises it", () => {
  // The most important test in the file. Everything this program has never seen
  // arrives here: a harness bug, an expired auth session, a fault invented in
  // 2027. Retrying it unattended spends the owner's quota to reproduce a failure
  // nobody can name.
  const d = decide({ signals: signalsFor(new Error("something nobody has ever seen"), null, null) });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "class_terminal");
  assert.match(reasonOf(d), /nothing here recognises this failure/i);
});

test("RUNAWAY GUARD: the seat's residual kind `unknown` is unclassified and stops", () => {
  // `#asCallError` collapses every non-rate-limit subprocess failure into one
  // string, and the remediation names the case that matters: "a session that
  // expired mid-run presents exactly like this". Auth expiry must not be retried
  // unattended.
  const err = Object.assign(new Error("the claude CLI subprocess failed"), {
    name: "SeatCallError",
    kind: "unknown",
  });
  assert.equal(classifyPhaseFailure(signalsFor(err, null, null)), "unclassified");
  assert.equal(decide({ signals: signalsFor(err, null, null) }).kind, "stop");
  assert.equal(boundFor("unclassified"), 0);
});

test("RUNAWAY GUARD: a thrown non-Error, and an error with a plausible-looking `code`, both stop", () => {
  // A Node fs error has a string `code` too. Requiring the BakeoffError shape
  // keeps ENOENT out of `structural`; it lands in `unclassified`, which also
  // stops, so the safe direction is preserved either way.
  for (const thrown of ["a string", 42, null, Object.assign(new Error("enoent"), { code: "ENOENT" })]) {
    const d = decide({ signals: signalsFor(thrown, null, null) });
    assert.equal(d.kind, "stop", String(thrown));
  }
});

test("the classifier physically cannot see a message: prose alone yields no signals", () => {
  // PhaseFailureSignals has no message field. This asserts the adapter does not
  // smuggle one in: an error whose text screams "rate limit" produces the same
  // all-null signals as any other, and therefore stops.
  const signals = signalsFor(new Error("429 rate limit exceeded, usage limit reached"), null, null);
  assert.deepEqual(signals, NO_SIGNALS);
  assert.equal(classifyPhaseFailure(signals), "unclassified");
});

/* =========================================================================
 * 4. THE BOUND — feed it N+1 and watch the (N+1)th refuse
 * ====================================================================== */

test("THE BOUND BOUNDS: three throttles continue, the fourth stops and names the cap", () => {
  assert.equal(AUTO_CONTINUE_MAX, 3);
  const outcomes: string[] = [];
  for (let count = 0; count <= AUTO_CONTINUE_MAX; count += 1) {
    outcomes.push(decide({ autoContinueCount: count }).kind);
  }
  assert.deepEqual(outcomes, ["wait", "wait", "wait", "stop"]);

  const last = decide({ autoContinueCount: AUTO_CONTINUE_MAX });
  assert.equal(last.kind === "stop" ? last.code : "", "cap_reached");
  assert.match(reasonOf(last), /continued itself 3 time\(s\)/);
  assert.match(reasonOf(last), /press Resume/i, "a stopped run must say who continues it");
});

test("THE BOUND BOUNDS: a run at the cap arms NOTHING even with a perfectly good window", () => {
  // The wait is computed after the cap on purpose. A run at the cap must not be
  // able to talk its way past it with plausible numbers.
  const d = decide({ autoContinueCount: AUTO_CONTINUE_MAX, signals: { ...NO_SIGNALS, refusal: refusal() } });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "cap_reached");
});

test("THE BOUND BOUNDS: `interrupted` shares the counter, so a bounced run runs out too", () => {
  // One counter for every class, because the shape to fear is a run bouncing
  // between classes for ever: throttled, wait, continue, restart, interrupted,
  // requeue, throttled again.
  assert.equal(mayAutoContinue({ klass: "interrupted", autoContinueCount: 2, enabled: true }).ok, true);
  const spent = mayAutoContinue({ klass: "interrupted", autoContinueCount: 3, enabled: true });
  assert.equal(spent.ok, false);
  assert.equal(decide({ signals: interruptedSignals(), autoContinueCount: 3 }).kind, "stop");
});

test("THE BOUND BOUNDS: transient stops one attempt earlier than throttled, on its own smaller cap", () => {
  const signals: PhaseFailureSignals = { ...NO_SIGNALS, seatKind: "transport" };
  assert.equal(decide({ signals, autoContinueCount: TRANSIENT_MAX - 1 }).kind, "wait");
  const spent = decide({ signals, autoContinueCount: TRANSIENT_MAX });
  assert.equal(spent.kind, "stop");
  assert.equal(spent.kind === "stop" ? spent.code : "", "cap_reached");
});

test("a counter that is not a usable number refuses rather than continuing without a cap", () => {
  for (const count of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const d = decide({ autoContinueCount: count });
    assert.equal(d.kind, "stop", String(count));
  }
});

test("OFF IS THE DEFAULT, and the refusal names the switch and the human", () => {
  const d = decide({ enabled: false });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "disabled");
  assert.match(reasonOf(d), new RegExp(RECOVERY_ENABLED_ENV));
  assert.match(reasonOf(d), /human has to resume/i);
});

test("only an explicit opt-in value turns it on; anything else — including a typo — is off", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(autoRecoverEnabled({ [RECOVERY_ENABLED_ENV]: value }), true, value);
  }
  for (const value of ["", "0", "no", "off", "ture", "2", "enabled"]) {
    assert.equal(autoRecoverEnabled({ [RECOVERY_ENABLED_ENV]: value }), false, value);
  }
  assert.equal(autoRecoverEnabled({}), false);
});

/* =========================================================================
 * 5. THE WAIT — derived from the reported window, never invented, never zero
 * ====================================================================== */

test("THE WAIT IS HONOURED: a missing retry-after refuses, it does not continue immediately", () => {
  // The dangerous substitution: treat "the provider said nothing" as "wait
  // nothing". A continuation with no wait attached walks straight back into the
  // same refusal, three times, in under a second.
  const d = decide({ signals: { ...NO_SIGNALS, refusal: refusal({ retryAfterSec: null }) } });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "no_retry_after");
  assert.match(reasonOf(d), /countdown from a number nobody reported is an invention/i);
});

test("THE WAIT IS HONOURED: a retry-after of 0 or a nonsense one refuses", () => {
  // claude-common.ts:214 produces 0 via Math.max(0, …) when the provider refused
  // while naming a reset instant already in the past. That is a refusal with no
  // wait attached, not a drained window.
  for (const sec of [0, -60, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = decide({ signals: { ...NO_SIGNALS, refusal: refusal({ retryAfterSec: sec }) } });
    assert.equal(d.kind, "stop", String(sec));
    assert.equal(d.kind === "stop" ? d.code : "", "retry_after_not_future", String(sec));
  }
});

test("THE WAIT IS HONOURED: no record of WHEN the refusal happened refuses", () => {
  for (const at of [null, "not an instant"]) {
    const d = decide({ signals: { ...NO_SIGNALS, refusal: refusal({ observedAt: at }) } });
    assert.equal(d.kind, "stop", String(at));
    assert.equal(d.kind === "stop" ? d.code : "", "no_refusal_instant", String(at));
    assert.match(reasonOf(d), /restart the whole window on every boot/i);
  }
});

test("a failure typed `throttled` with NO refusal reading refuses rather than reaching for the row", () => {
  const d = decide({ signals: { ...NO_SIGNALS, seatKind: "throttled", refusal: null } });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "no_refusal");
  assert.match(reasonOf(d), /routine frames that report a window filling/i);
});

test("an elapsed window continues now — and says the reopening is unknowable from here", () => {
  const d = decide({ now: "2026-08-04T01:40:00.000Z" });
  assert.equal(d.kind, "continue");
  assert.match(reasonOf(d), /already elapsed/i);
});

test("a clock that moved backwards does not lengthen the wait beyond what was reported", () => {
  // elapsed is floored at zero, so the wait can never exceed the window itself.
  const d = decide({ now: "2026-08-04T00:30:00.000Z" });
  assert.equal(d.kind, "wait");
  assert.equal(d.kind === "wait" ? d.delayMs : -1, HALF_HOUR_SEC * 1_000);
});

/* =========================================================================
 * 6. The two ceilings, and the one this machine actually hits
 * ====================================================================== */

test("THE UNATTENDED CEILING: the seven-day window this machine really reports is REFUSED, with its length", () => {
  const d = decide({
    signals: { ...NO_SIGNALS, refusal: refusal({ retryAfterSec: SEVEN_DAY_SEC, kind: "seven_day", observedAt: NOW }) },
  });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "wait_too_long");
  assert.match(reasonOf(d), /seven_day/);
  assert.match(reasonOf(d), /120\.0 h/, "the refusal has to quote the wait it refused");
  assert.match(reasonOf(d), new RegExp(RECOVERY_MAX_WAIT_ENV), "and name the way to allow it");
});

test("THE UNATTENDED CEILING: raising it lets the same window through, so the escape hatch is real", () => {
  const week = recoveryMaxWaitMs({ [RECOVERY_MAX_WAIT_ENV]: "10080" });
  const d = decide({
    maxWaitMs: week,
    signals: { ...NO_SIGNALS, refusal: refusal({ retryAfterSec: SEVEN_DAY_SEC, kind: "seven_day", observedAt: NOW }) },
  });
  assert.equal(d.kind, "wait");
  assert.equal(d.kind === "wait" ? d.delayMs : -1, SEVEN_DAY_SEC * 1_000);
});

test("THE 32-BIT CEILING refuses before the unattended one, because firing immediately is the worse fault", () => {
  const huge = 10_000_000; // seconds; 1e10 ms, past what setTimeout can hold
  assert.ok(huge * 1_000 > RECOVERY_TIMER_MAX_DELAY_MS, "the fixture has to exceed the timer ceiling");
  const d = decide({
    maxWaitMs: RECOVERY_TIMER_MAX_DELAY_MS,
    signals: { ...NO_SIGNALS, refusal: refusal({ retryAfterSec: huge, observedAt: NOW }) },
  });
  assert.equal(d.kind, "stop");
  assert.equal(d.kind === "stop" ? d.code : "", "wait_unrepresentable");
  assert.match(reasonOf(d), /fires\s+IMMEDIATELY/i);
});

test("the ceiling default is six hours, and an unreadable override is the default rather than no ceiling", () => {
  assert.equal(RECOVERY_MAX_AUTO_WAIT_MS, 6 * 60 * 60 * 1_000);
  assert.equal(recoveryMaxWaitMs({}), RECOVERY_MAX_AUTO_WAIT_MS);
  for (const value of ["", " ", "soon", "0", "-5", "NaN"]) {
    assert.equal(recoveryMaxWaitMs({ [RECOVERY_MAX_WAIT_ENV]: value }), RECOVERY_MAX_AUTO_WAIT_MS, value);
  }
  assert.equal(recoveryMaxWaitMs({ [RECOVERY_MAX_WAIT_ENV]: "90" }), 90 * 60_000);
  // A configured ceiling above what a timer can hold is clamped, so a delay can
  // never slip past the 32-bit arm into "fires immediately".
  assert.equal(recoveryMaxWaitMs({ [RECOVERY_MAX_WAIT_ENV]: "999999999" }), RECOVERY_TIMER_MAX_DELAY_MS);
});

/* =========================================================================
 * 7. The one prose match, kept where it can be pointed at
 * ====================================================================== */

test("the prose hint matches what the seat layer needs it to, and NOTHING else", () => {
  for (const message of ["rate limit reached", "rate-limited", "HTTP 429", "usage limit exceeded"]) {
    assert.equal(throttleHintFromMessage(message), true, message);
  }
  // THE 2026-08-04 DEATH. If a future edit widens this until the overflow
  // message matches, a 51-minute spec phase gets retried against a ceiling that
  // cannot move — so this assertion is the guard, not the comment above it.
  assert.equal(
    throttleHintFromMessage("API Error: Claude's response exceeded the 64000 output token maximum"),
    false,
  );
  assert.equal(throttleHintFromMessage("Claude Code process aborted by user"), false);
  assert.equal(throttleHintFromMessage("the claude CLI subprocess failed"), false);
});
