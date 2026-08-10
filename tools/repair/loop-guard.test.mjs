import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAttempts, classifyTransition, shouldEscalate } from "./loop-guard.mjs";
import { A913C871_ATTEMPTS, A913C871_SITE, SHRINKING_ATTEMPTS, PROSE_ONLY_ATTEMPTS, CONTRACT_SHAPED_DEFECT } from "./fixtures.mjs";

test("a913c871 escalates at attempt 2, and the arm is NON_MONOTONE, not a count", () => {
  const v = evaluateAttempts(A913C871_ATTEMPTS, { site: A913C871_SITE });
  assert.equal(v.escalate, true);
  assert.equal(v.escalateAtAttempt, 2, "the counter never exceeded its budget; escalating at 3 is 87 minutes too late");
  assert.equal(v.arm, "NON_MONOTONE");
  assert.match(v.why, /disjoint/);
  assert.equal(shouldEscalate(v), true);
});

test("NEGATIVE CONTROL: a shrinking sequence does NOT escalate (a comparator that always escalates is as useless as one that never does)", () => {
  const v = evaluateAttempts(SHRINKING_ATTEMPTS, { site: A913C871_SITE });
  assert.equal(v.escalate, false);
  assert.equal(v.escalateAtAttempt, null);
  assert.deepEqual(
    v.transitions.map((t) => t.arm),
    ["SHRINK", "SHRINK"],
  );
});

test("oscillation A -> B -> A is caught on its own arm at attempt 3", () => {
  // Distinguished from the a913c871 case on purpose: here attempt 2 CLEARS a and adds b
  // alongside a shared path, so the 1->2 transition is legitimate OVERLAP and only the
  // return of `a` at attempt 3 escalates.
  const attempts = [
    { n: 1, violations: [{ path: "m.a" }, { path: "m.c" }] },
    { n: 2, violations: [{ path: "m.b" }, { path: "m.c" }] },
    { n: 3, violations: [{ path: "m.a" }, { path: "m.c" }] },
  ];
  const v = evaluateAttempts(attempts, { site: "x" });
  assert.equal(v.transitions[0].arm, "OVERLAP");
  assert.equal(v.transitions[0].escalate, false);
  assert.equal(v.escalateAtAttempt, 3);
  assert.equal(v.arm, "OSCILLATION");
  assert.match(v.why, /m\.a/);
});

test("an identical repeat escalates immediately", () => {
  const attempts = [{ n: 1, violations: [{ path: "m.a" }] }, { n: 2, violations: [{ path: "m.a" }] }];
  const v = evaluateAttempts(attempts, { site: "x" });
  assert.equal(v.escalateAtAttempt, 2);
  assert.equal(v.arm, "IDENTICAL");
});

test("BLIND: prose-only attempts escalate loudly instead of being regex-guessed", () => {
  const v = evaluateAttempts(PROSE_ONLY_ATTEMPTS, { site: A913C871_SITE });
  assert.equal(v.blind, true);
  assert.equal(v.arm, "BLIND");
  assert.equal(v.escalate, true, "a comparator that cannot see must say so, not report health");
  assert.match(v.why, /prose/);
});

test("a single attempt yields no transition and no escalation", () => {
  const v = evaluateAttempts([A913C871_ATTEMPTS[0]], { site: A913C871_SITE });
  assert.deepEqual(v.transitions, []);
  assert.equal(v.escalate, false);
});

test("a growing set is not an escalation: a collect-all validator legitimately names more", () => {
  assert.equal(classifyTransition(["m.a"], ["m.a", "m.b"]).arm, "GROW");
  assert.equal(classifyTransition(["m.a"], ["m.a", "m.b"]).escalate, false);
});

test("signatures are recorded per attempt so the escalation carries its evidence", () => {
  const v = evaluateAttempts(A913C871_ATTEMPTS, { site: A913C871_SITE });
  assert.equal(v.signatures.length, 3);
  assert.equal(v.signatures[0], v.signatures[2], "attempt 3 returned to attempt 1's defect");
  assert.notEqual(v.signatures[0], v.signatures[1]);
});

test("THE PRODUCTION SHAPE: a contract-exact DefectRecord makes this rule BLIND, and it says so", () => {
  // The DefectRecord contract gives attempts `problems: readonly string[]` — prose — and
  // carries `violations[]` only at the top level. On that shape every transition is BLIND,
  // so the comparator degenerates to "always escalate" and the SHRINK arm can never fire in
  // production. This test exists so that fact is asserted rather than discovered later; the
  // fix is on the record WRITER, which must carry structured per-attempt paths.
  const v = evaluateAttempts(CONTRACT_SHAPED_DEFECT.attempts, { site: A913C871_SITE, bakeoffCode: CONTRACT_SHAPED_DEFECT.bakeoffCode });
  assert.equal(v.blind, true);
  assert.equal(v.arm, "BLIND");
  assert.equal(v.escalateAtAttempt, 2);
  assert.deepEqual(v.signatures, [null, null, null], "no signature can be computed from prose, and none is invented");
  assert.match(v.why, /refusing to guess from prose/);
});
