import test from "node:test";
import assert from "node:assert/strict";
import { computeSignature, normalisePath, pathSet, attemptPaths, writerSignature } from "./signature.mjs";
import { A913C871_ATTEMPTS, A913C871_SITE, PROSE_ONLY_ATTEMPTS } from "./fixtures.mjs";

const sig = (violations, site = A913C871_SITE) => computeSignature({ site, violations });

test("ARM: two genuinely different defects get different signatures (a comparator whose signature never moves sees nothing)", () => {
  const a = sig([{ path: "dataExpectations[0].id" }]);
  const b = sig([{ path: "dataExpectations[0].kind" }]);
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("the same defect at a different array index is the SAME signature", () => {
  // a913c871's paths are all [0]; a fixture drawn only from it cannot see this clause.
  assert.equal(sig([{ path: "dataExpectations[0].id" }]), sig([{ path: "dataExpectations[3].id" }]));
  assert.equal(normalisePath("uiFlows[12].steps[0].selector"), "uiFlows[].steps[].selector");
});

test("field order does not move the signature", () => {
  const a = sig([{ path: "dataExpectations[0].id" }, { path: "dataExpectations[0].kind" }]);
  const b = sig([{ path: "dataExpectations[0].kind" }, { path: "dataExpectations[0].id" }]);
  assert.equal(a, b);
});

test("prose does not move the signature, and prose alone cannot produce one", () => {
  const a = sig([{ path: "dataExpectations[0].id", expected: "a non-empty string", got: "undefined" }]);
  const b = sig([{ path: "dataExpectations[0].id", expected: "TOTALLY DIFFERENT WORDING", got: "null" }]);
  assert.equal(a, b);
  // and a prose-only attempt yields null rather than a guessed path
  assert.equal(attemptPaths(PROSE_ONLY_ATTEMPTS[0]), null);
  assert.deepEqual(attemptPaths(A913C871_ATTEMPTS[0]), ["dataExpectations[].id"]);
});

test("the site is part of the signature: the same field at a different throw site is a different defect", () => {
  assert.notEqual(sig([{ path: "dataExpectations[0].id" }], "collectManifestProblems"), sig([{ path: "dataExpectations[0].id" }], "parseSuiteManifest"));
});

test("duplicate and blank paths collapse", () => {
  assert.deepEqual(pathSet([{ path: "a.b" }, { path: "a.b" }, { path: "  " }, "a.b"]), ["a.b"]);
});

test("HANDOFF PINNED: the record writer's signature formula is NOT this module's, and the store is keyed by it", () => {
  const site = A913C871_SITE;
  const paths = ["dataExpectations[0].id"];
  const mine = computeSignature({ site, violations: paths });
  const theirs = writerSignature(site, paths);
  assert.notEqual(mine, theirs, "if these ever agree, delete writerSignature and this test");

  // The substantive divergence, not just a different salt: the writer keeps array indices,
  // so the same defect at another index is a different shard file for it and the same shard
  // for us. Whichever formula wins, both sides must use exactly one.
  assert.notEqual(writerSignature(site, ["dataExpectations[0].id"]), writerSignature(site, ["dataExpectations[3].id"]));
  assert.equal(computeSignature({ site, violations: ["dataExpectations[0].id"] }), computeSignature({ site, violations: ["dataExpectations[3].id"] }));

  // and it is a real hex filename either way
  assert.match(theirs, /^[a-f0-9]{64}$/);
});
