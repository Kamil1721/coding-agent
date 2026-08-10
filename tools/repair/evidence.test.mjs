import test from "node:test";
import assert from "node:assert/strict";
import { validateProposal, formatVerdict, proposalFingerprint } from "./evidence.mjs";

const RED = `$ node --test tools/repair/widget.test.mjs
✖ the widget adds (1.2ms)
  AssertionError: 2 !== 5
      at tools/repair/widget.mjs:12:9
# exit code: 1
`;
const GREEN = `$ node --test tools/repair/widget.test.mjs
✔ the widget adds (1.1ms)
# exit code: 0
`;
const MUTANT = `$ node --test tools/repair/widget.test.mjs
✖ the widget adds (1.3ms)
  AssertionError: 2 !== 5
      at tools/repair/widget.mjs:12:9
# exit code: 1
`;

const DIFF = `--- a/tools/repair/widget.mjs
+++ b/tools/repair/widget.mjs
@@ -10,3 +10,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

const DEFECT = { artefacts: ["tools/repair/widget.mjs"], candidatePaths: ["tools/repair/widget.mjs"] };

function good(overrides = {}) {
  return {
    signature: "a".repeat(64),
    diff: DIFF,
    filesChanged: ["tools/repair/widget.mjs"],
    touchesFrozenClosure: false,
    evidence: { redBefore: RED, greenAfter: GREEN, mutationRed: MUTANT },
    proposedAt: "2026-08-10T09:00:00.000Z",
    ...overrides,
  };
}

const CTX = {
  defect: DEFECT,
  frozenClosure: ["bakeoff/src/contracts.ts", "bakeoff/src/scorer.ts"],
  ruledOutFingerprints: [],
  independentCheck: { ran: true, targetedChanged: true, unrelatedChanged: [] },
};

const codes = (v) => v.reasons.map((r) => r.code).sort();

test("ARM: a complete proposal is ACCEPTED (a bar that refuses everything is as blind as one that accepts everything)", () => {
  const v = validateProposal(good(), CTX);
  assert.deepEqual(codes(v), []);
  assert.equal(v.verdict, "ACCEPTED");
  assert.deepEqual(v.filesChanged, ["tools/repair/widget.mjs"]);
});

for (const [field, code] of [
  ["redBefore", "MISSING_EVIDENCE_RED_BEFORE"],
  ["greenAfter", "MISSING_EVIDENCE_GREEN_AFTER"],
  ["mutationRed", "MISSING_EVIDENCE_MUTATION_RED"],
]) {
  test(`a proposal missing evidence.${field} is REFUSED with exactly ${code}`, () => {
    const p = good();
    delete p.evidence[field];
    const v = validateProposal(p, CTX);
    assert.equal(v.verdict, "REFUSED");
    assert.deepEqual(codes(v), [code], "one missing transcript must produce one named reason, not a generic refusal");
  });

  test(`a blank (whitespace-only) evidence.${field} counts as absent`, () => {
    const p = good();
    p.evidence[field] = "   \n  ";
    assert.deepEqual(codes(validateProposal(p, CTX)), [code]);
  });
}

test("a transcript pair that did not change state is REFUSED: the check observes nothing", () => {
  const p = good({ evidence: { redBefore: GREEN, greenAfter: GREEN, mutationRed: MUTANT } });
  // and the exit-code discriminator sees it independently: a RED that exited 0 is not a RED
  assert.deepEqual(codes(validateProposal(p, CTX)), ["EVIDENCE_EXIT_CODES_INCONSISTENT", "RED_EQUALS_GREEN"]);
});

test("a mutation transcript identical to the green run is REFUSED: reverting the fix changed nothing", () => {
  const p = good({ evidence: { redBefore: RED, greenAfter: GREEN, mutationRed: GREEN } });
  assert.deepEqual(codes(validateProposal(p, CTX)), ["EVIDENCE_EXIT_CODES_INCONSISTENT", "MUTATION_RED_EQUALS_GREEN"]);
});

test("the independent check is not optional: its absence is treated exactly like failure", () => {
  assert.deepEqual(codes(validateProposal(good(), { ...CTX, independentCheck: null })), ["NO_INDEPENDENT_CHECK"]);
  assert.deepEqual(codes(validateProposal(good(), { ...CTX, independentCheck: { ran: false } })), ["NO_INDEPENDENT_CHECK"]);
});

test("an independent replay that moved unrelated recorded behaviour is REFUSED (the overfitting arm)", () => {
  const v = validateProposal(good(), { ...CTX, independentCheck: { ran: true, targetedChanged: true, unrelatedChanged: ["c228e63b-replay"] } });
  assert.deepEqual(codes(v), ["INDEPENDENT_CHECK_FAILED"]);
  assert.match(v.reasons[0].detail, /c228e63b-replay/);
});

test("an independent replay in which the targeted behaviour did NOT change is REFUSED", () => {
  const v = validateProposal(good(), { ...CTX, independentCheck: { ran: true, targetedChanged: false, unrelatedChanged: [] } });
  assert.deepEqual(codes(v), ["INDEPENDENT_CHECK_MISSED_TARGET"]);
});

test("a file the evidence does not implicate is REFUSED by name, even with perfect transcripts", () => {
  const wide =
    DIFF +
    `--- a/dashboard/server/src/orchestrator.ts
+++ b/dashboard/server/src/orchestrator.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;
  const v = validateProposal(good({ diff: wide, filesChanged: ["tools/repair/widget.mjs", "dashboard/server/src/orchestrator.ts"] }), CTX);
  assert.deepEqual(codes(v), ["SCOPE_UNIMPLICATED_FILE"]);
  assert.match(v.reasons[0].detail, /orchestrator\.ts/);
});

test("under-declaring filesChanged does not hide a file: the diff is the source of truth", () => {
  const wide =
    DIFF +
    `--- a/dashboard/server/src/orchestrator.ts
+++ b/dashboard/server/src/orchestrator.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;
  const v = validateProposal(good({ diff: wide }), CTX);
  assert.deepEqual(codes(v), ["FILES_UNDER_DECLARED", "SCOPE_UNIMPLICATED_FILE"]);
});

test("over-declaring filesChanged is REFUSED too", () => {
  assert.deepEqual(codes(validateProposal(good({ filesChanged: ["tools/repair/widget.mjs", "docs/never-touched.md"] }), CTX)), ["FILES_OVER_DECLARED"]);
});

test("a diff reaching the frozen closure is REFUSED even when the proposal's own flag says otherwise", () => {
  const frozen = `--- a/bakeoff/src/contracts.ts
+++ b/bakeoff/src/contracts.ts
@@ -1430,3 +1430,3 @@
 export function computeHeldOutPass(x) {
-  return x.every(Boolean);
+  return true;
 }
`;
  const p = good({ diff: frozen, filesChanged: ["bakeoff/src/contracts.ts"], touchesFrozenClosure: false });
  const v = validateProposal(p, { ...CTX, defect: { candidatePaths: ["bakeoff/src/contracts.ts"] } });
  assert.deepEqual(codes(v), ["TOUCHES_FROZEN_CLOSURE"]);
  assert.match(v.reasons[0].detail, /contracts\.ts/);
});

test("a repair already ruled out for this signature is REFUSED before it is proved again", () => {
  const fp = proposalFingerprint(good());
  assert.deepEqual(codes(validateProposal(good(), { ...CTX, ruledOutFingerprints: [fp] })), ["ALREADY_RULED_OUT"]);
});

test("the ruled-out fingerprint survives regeneration: timestamps and index lines are not content", () => {
  const a = good();
  const b = good({
    diff: `diff --git a/tools/repair/widget.mjs b/tools/repair/widget.mjs
index 1111111..2222222 100644
--- a/tools/repair/widget.mjs\t2026-08-10 09:00:00
+++ b/tools/repair/widget.mjs\t2026-08-10 11:22:33
@@ -10,3 +10,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`,
  });
  assert.equal(proposalFingerprint(a), proposalFingerprint(b));
});

test("an empty or unparseable diff is REFUSED", () => {
  assert.ok(codes(validateProposal(good({ diff: "" }), CTX)).includes("EMPTY_DIFF"));
  assert.ok(codes(validateProposal(good({ diff: "@@ -1 +1 @@\n-a\n+b\n", filesChanged: [] }), CTX)).includes("DIFF_UNPARSEABLE"));
});

test("a refusal renders loudly, naming every reason", () => {
  const p = good();
  delete p.evidence.mutationRed;
  const text = formatVerdict(validateProposal(p, { ...CTX, independentCheck: null }), p);
  assert.match(text, /REPAIR PROPOSAL REFUSED/);
  assert.match(text, /MISSING_EVIDENCE_MUTATION_RED/);
  assert.match(text, /NO_INDEPENDENT_CHECK/);
  assert.match(text, /reasons=2/);
});

test("a transcript with no exit-code trailer did not come from the prover and is REFUSED", () => {
  const p = good({ evidence: { redBefore: "it failed, trust me", greenAfter: GREEN, mutationRed: MUTANT } });
  const v = validateProposal(p, CTX);
  assert.deepEqual(codes(v), ["EVIDENCE_EXIT_CODES_INCONSISTENT"]);
  assert.match(v.reasons[0].detail, /redBefore carries no exit-code trailer/);
});
