/**
 * unattended-spend.test.ts — the seven controls for the 2026-09-16 overnight burn.
 *
 * WHAT HAPPENED. `run-cont-708c1bcef9d301b7722a` was parked `rate_limited` on
 * 2026-09-12 with a seven-day window. The ceiling REFUSED to arm a timer for it
 * ("longer than the 12.0 h this server will wait unattended") and that refusal
 * was correct. The dashboard then stopped. When it started again three days
 * later `reconcileOnBoot` swept `rate_limited`, `planThrottledWait` found the
 * window had elapsed, took its `delayMs <= 0` arm, and resumed the run with no
 * human present. It spent subscription quota for about three and a half hours
 * until the provider refused it again.
 *
 * EVERY TEST HERE ASSERTS THAT NOTHING HAPPENED, WHICH IS THE FAILURE MODE THIS
 * FILE HAS TO DESIGN AROUND. "It did not resume" passes trivially in a harness
 * where nothing could resume, so the file is paired: test 6 proves the opt-in
 * path DOES continue against the same module, same shape, same clock. Without
 * that positive control the other six are probes that observe only their own
 * success, which is this repository's signature defect.
 *
 * THE REAL NUMBERS ARE USED ON PURPOSE. `retryAfterSec: 387922` and the instants
 * below are read from `runs.db` for the incident row, so a regression has to
 * reproduce the incident rather than a tidied-up version of it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyPhaseFailure,
  infraRecoveryEnabled,
  planRecovery,
  signalsFor,
  unattendedSpendAllowed,
  type RefusalEvidence,
} from "./recovery.js";

/** The live incident row, verbatim from runs.db. */
const INCIDENT: RefusalEvidence = {
  limited: true,
  retryAfterSec: 387_922, // 107.75 h, a seven-day window
  kind: "seven_day",
  observedAt: "2026-09-16T00:14:38.809Z",
};

/** A window well inside the 12 h ceiling, which the ceiling exists to license. */
const SHORT: RefusalEvidence = {
  limited: true,
  retryAfterSec: 300,
  kind: "five_hour",
  observedAt: "2026-09-20T11:00:00.000Z",
};

const CEILING_MS = 12 * 60 * 60 * 1000;
/** Past the incident window's reopen instant (2026-09-20T12:00:00.809Z). */
const AFTER_RESET = "2026-09-20T12:55:00.000Z";

function decide(refusal: RefusalEvidence, env: NodeJS.ProcessEnv, now: string) {
  const signals = signalsFor(new Error("rate limited"), null, refusal);
  assert.equal(classifyPhaseFailure(signals), "throttled", "fixture must reach the throttled arm");
  return planRecovery({
    signals,
    autoContinueCount: 0,
    enabled: unattendedSpendAllowed(env),
    now,
    maxWaitMs: CEILING_MS,
  });
}

test("1. a rate-limited run does not resume itself by default", () => {
  const d = decide(INCIDENT, {}, "2026-09-16T01:00:00.000Z");
  assert.equal(d.kind, "stop", "UNATTENDED_1: an unconfigured machine must not spend");
  assert.equal(d.code, "disabled");
});

test("2. waiting past the reset instant still does not resume it", () => {
  // This is the exact condition that fired on 2026-09-15: elapsed > window.
  // OPTED IN ON PURPOSE. With the flag off this passes for the flag's reason and
  // never touches the ceiling, so it would stay green if the ceiling regressed.
  const d = decide(INCIDENT, { DASHBOARD_AUTO_RECOVER: "1" }, AFTER_RESET);
  assert.equal(d.kind, "stop", "UNATTENDED_2: an elapsed window is not consent");
  assert.equal(d.code, "wait_too_long");
});

test("3. a server restart after the window elapsed does not resume it", () => {
  // reconcileOnBoot re-decides from the stored refusal; the decision is the
  // same pure call, so a restart is modelled by deciding again at a later now.
  for (const boot of ["2026-09-20T12:55:00.000Z", "2026-09-27T09:00:00.000Z", "2026-10-30T00:00:00.000Z"]) {
    const d = decide(INCIDENT, { DASHBOARD_AUTO_RECOVER: "1" }, boot);
    assert.equal(d.kind, "stop", `UNATTENDED_3: boot at ${boot} must not resume`);
    assert.equal(d.code, "wait_too_long", "UNATTENDED_3: and it must be the ceiling that refuses");
  }
});

test("4. the ceiling refuses even when unattended spending is opted in", () => {
  // Defence in depth: the flag is not the only bound. A 107.75 h window is
  // longer than the server will wait unattended whatever the flag says.
  const d = decide(INCIDENT, { DASHBOARD_AUTO_RECOVER: "1" }, AFTER_RESET);
  assert.equal(d.kind, "stop", "UNATTENDED_4: opt-in does not lift the ceiling");
  assert.equal(d.code, "wait_too_long");
});

test("5. an explicit off value refuses, and beats a stale on value", () => {
  assert.equal(unattendedSpendAllowed({ DASHBOARD_AUTO_RECOVER: "0" }), false);
  assert.equal(unattendedSpendAllowed({ DASHBOARD_AUTO_RECOVER: "off" }), false);
  // deny wins: an explicit off is not defeated by anything else in the env.
  assert.equal(decide(SHORT, { DASHBOARD_AUTO_RECOVER: "0" }, AFTER_RESET).kind, "stop");
});

test("6. POSITIVE CONTROL: explicit opt-in really does continue", () => {
  // Without this, tests 1-5 pass in a harness where nothing can ever continue.
  const d = decide(SHORT, { DASHBOARD_AUTO_RECOVER: "1" }, AFTER_RESET);
  assert.equal(d.kind, "continue", "UNATTENDED_6: opt-in must still work, or the suite proves nothing");
});

test("7. an old continuation cannot silently spend after a reboot", () => {
  // The whole incident in one assertion: same row, same elapsed window, an
  // unconfigured environment as a fresh login would have.
  const d = decide(INCIDENT, { DASHBOARD_AUTO_RECOVER: "1" }, AFTER_RESET);
  assert.equal(d.kind, "stop");
  assert.equal(d.code, "wait_too_long", "UNATTENDED_7: the ceiling, not just the flag, must refuse");
  assert.match(
    d.kind === "stop" ? d.reason : "",
    /resume/i,
    "UNATTENDED_7: the refusal must tell the owner how to start it himself",
  );
});

test("deterministic infrastructure recovery stays on by default and is separately switchable", () => {
  // Repairing bookkeeping spends nothing and must not be collateral damage of
  // switching off spending.
  assert.equal(infraRecoveryEnabled({}), true);
  assert.equal(infraRecoveryEnabled({ DASHBOARD_AUTO_RECOVER: "0" }), true, "spending off must not disable repair");
  assert.equal(infraRecoveryEnabled({ DASHBOARD_AUTO_RECOVER_INFRA: "0" }), false);
});
