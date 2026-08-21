import { strict as assert } from "node:assert";
import test from "node:test";
import {
  advanceCreativeReview,
  initialCreativeReviewState,
  withOwnerDecision,
} from "./creative-review-loop.js";
import type { CreativeReviewState } from "./creative-review-loop.js";
import type { CriticDisposition, RenderedTasteCriticRecord } from "./rendered-taste-critic.js";

function critic(
  iteration: number,
  criticDisposition: CriticDisposition,
  tree = String(iteration).repeat(64),
  fingerprint = criticDisposition === "revise" ? String(iteration + 3).repeat(64) : null,
): RenderedTasteCriticRecord {
  return {
    schemaVersion: 1,
    attempt: iteration,
    iteration,
    treeHash: tree,
    contractHash: "a".repeat(64),
    renderManifestHash: String(iteration + 5).repeat(64),
    recordedAt: "2026-08-20T12:00:00.000Z",
    criticDisposition,
    ran: criticDisposition !== "unavailable",
    output: null,
    findingFingerprint: fingerprint,
    policyErrors: [],
    detail: criticDisposition,
    tokens: null,
    rateLimit: null,
    criticBy: "anthropic/default (subscription)",
  };
}

function green(): CreativeReviewState {
  return initialCreativeReviewState({ heldOutPass: true, creativeCompilePass: true });
}

test("critic accept stops the loop but remains separate from owner approval", () => {
  const state = advanceCreativeReview(green(), critic(1, "accept"));
  assert.equal(state.status, "creative_ready");
  assert.equal(state.stopReason, "accepted");
  assert.equal(state.heldOutPass, true);
  assert.equal(state.creativeCompilePass, true);
  assert.equal(state.criticDisposition, "accept");
  assert.equal(state.ownerDecision, "pending", "critic acceptance is not owner promotion approval");
});

test("functional and compiler red stop before a critic attempt can run", () => {
  const functional = initialCreativeReviewState({ heldOutPass: false, creativeCompilePass: true });
  assert.equal(functional.status, "failed");
  assert.equal(functional.stopReason, "functional_red");
  assert.equal(functional.criticDisposition, "not_run");
  assert.deepEqual(advanceCreativeReview(functional, critic(1, "accept")), functional);

  const compiler = initialCreativeReviewState({ heldOutPass: true, creativeCompilePass: false });
  assert.equal(compiler.status, "failed");
  assert.equal(compiler.stopReason, "compiler_red");
  assert.equal(compiler.criticDisposition, "not_run");
});

test("the same tree and finding fingerprint stops as not_converging", () => {
  const tree = "c".repeat(64);
  const fingerprint = "d".repeat(64);
  const first = advanceCreativeReview(green(), critic(1, "revise", tree, fingerprint));
  assert.equal(first.status, "reviewing");

  const repeated = advanceCreativeReview(first, critic(2, "revise", tree, fingerprint));
  assert.equal(repeated.status, "not_converging");
  assert.equal(repeated.stopReason, "repeated_tree_and_findings");
  assert.equal(repeated.attempts.length, 2);
});

test("three distinct revise attempts exhaust the bounded loop", () => {
  const first = advanceCreativeReview(green(), critic(1, "revise"));
  const second = advanceCreativeReview(first, critic(2, "revise"));
  const third = advanceCreativeReview(second, critic(3, "revise"));
  assert.equal(third.status, "creative_review_required");
  assert.equal(third.stopReason, "attempts_exhausted");
  assert.equal(third.attempts.length, 3);
});

test("unavailable, unknown prerequisites, and out-of-order attempts stop closed", () => {
  const unavailable = advanceCreativeReview(green(), critic(1, "unavailable"));
  assert.equal(unavailable.stopReason, "critic_unavailable");

  const unknown = initialCreativeReviewState({ heldOutPass: null, creativeCompilePass: true });
  assert.equal(unknown.stopReason, "prerequisite_unknown");

  const skipped = advanceCreativeReview(green(), critic(2, "accept"));
  assert.equal(skipped.stopReason, "invalid_attempt");
  assert.equal(skipped.attempts.length, 0, "an out-of-order record is not admitted into history");
  assert.equal(skipped.criticDisposition, "not_run", "an unadmitted record cannot change critic authority");
});

test("owner decisions update only the owner authority", () => {
  const state = advanceCreativeReview(green(), critic(1, "revise"));
  const waived = withOwnerDecision(state, "waived");
  assert.equal(waived.ownerDecision, "waived");
  assert.equal(waived.criticDisposition, "revise");
  assert.equal(waived.heldOutPass, true);
  assert.equal(waived.creativeCompilePass, true);
  assert.equal(waived.status, "reviewing", "waiver does not silently rewrite loop state");
});
