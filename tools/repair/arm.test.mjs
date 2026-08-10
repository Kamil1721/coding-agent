import test from "node:test";
import assert from "node:assert/strict";
import { runArmChecks, ARMS } from "./arm.mjs";

test("every arm is live on the shipped components", () => {
  const r = runArmChecks();
  const failed = r.arms.filter((a) => !a.ok);
  assert.deepEqual(failed.map((a) => `${a.name}: ${a.detail}`), []);
  assert.equal(r.ok, true);
  assert.equal(r.arms.length, ARMS.length);
});

// The arm check is itself a probe, so it needs one: each of these blinds one component in
// the way it would really go blind, and the corresponding arm must FAIL. An arm-check that
// cannot report a blind component is the defect it exists to catch.
const BLINDINGS = [
  ["signature", { computeSignature: () => "constant" }, "a signature that never moves"],
  ["anti-loop", { evaluateAttempts: () => ({ escalate: false, escalateAtAttempt: null, arm: null }) }, "a comparator that never escalates"],
  ["anti-loop", { evaluateAttempts: () => ({ escalate: true, escalateAtAttempt: 2, arm: "NON_MONOTONE" }) }, "a comparator that always escalates"],
  ["evidence-bar", { validateProposal: () => ({ verdict: "ACCEPTED", reasons: [] }) }, "a bar that accepts everything"],
  ["evidence-bar", { validateProposal: () => ({ verdict: "REFUSED", reasons: [{ code: "X" }] }) }, "a bar that refuses everything"],
  ["prover-executes", { runCommand: () => ({ ok: true, exitCode: 0, transcript: "" }) }, "a prover that reports success without executing"],
  ["sandbox-refusal", { assertSandbox: (p) => p }, "an isolation guard that accepts the repository"],
  ["ledger-writes", { openLedger: () => ({ read: () => [], append: () => {}, ruledOutFingerprints: () => [] }) }, "a ledger that writes nothing"],
];

for (const [armName, deps, what] of BLINDINGS) {
  test(`ARM-CHECK NEGATIVE CONTROL: ${what} makes the ${armName} arm fail`, () => {
    const r = runArmChecks({ deps });
    const arm = r.arms.find((a) => a.name === armName);
    assert.equal(arm.ok, false, `${what} was not detected by the ${armName} arm`);
    assert.equal(r.ok, false);
    assert.ok(arm.detail.length > 0, "a failing arm must say what it saw");
  });
}
