/** Pure bounded state machine for rendered creative review. */

import {
  MAX_CREATIVE_REVIEW_ATTEMPTS,
} from "./rendered-taste-critic.js";
import type {
  CriticDisposition,
  RenderedTasteCriticRecord,
} from "./rendered-taste-critic.js";

export type OwnerDecision = "pending" | "approved" | "revision_requested" | "waived" | "cancelled";
export type CreativeReviewStatus =
  | "reviewing"
  | "creative_ready"
  | "creative_review_required"
  | "not_converging"
  | "failed";
export type CreativeReviewStopReason =
  | "accepted"
  | "functional_red"
  | "compiler_red"
  | "prerequisite_unknown"
  | "artifact_contract"
  | "critic_unavailable"
  | "repeated_tree_and_findings"
  | "attempts_exhausted"
  | "invalid_attempt"
  | null;

export interface CreativeReviewAttempt {
  readonly attempt: number;
  readonly iteration: number;
  readonly treeHash: string;
  readonly renderManifestHash: string;
  readonly criticDisposition: CriticDisposition;
  readonly findingFingerprint: string | null;
}

/** Four independent authorities. No field is derived from another. */
export interface CreativeReviewState {
  readonly heldOutPass: boolean | null;
  readonly creativeCompilePass: boolean | null;
  readonly criticDisposition: CriticDisposition | "not_run";
  readonly ownerDecision: OwnerDecision;
  readonly status: CreativeReviewStatus;
  readonly stopReason: CreativeReviewStopReason;
  readonly attempts: readonly CreativeReviewAttempt[];
}

export interface CreativeReviewInitialState {
  readonly heldOutPass: boolean | null;
  readonly creativeCompilePass: boolean | null;
  readonly ownerDecision?: OwnerDecision;
}

export function initialCreativeReviewState(input: CreativeReviewInitialState): CreativeReviewState {
  const state: CreativeReviewState = {
    heldOutPass: input.heldOutPass,
    creativeCompilePass: input.creativeCompilePass,
    criticDisposition: "not_run",
    ownerDecision: input.ownerDecision ?? "pending",
    status: "reviewing",
    stopReason: null,
    attempts: [],
  };
  return stopForPrerequisiteAuthority(state) ?? state;
}

/**
 * Apply one independently persisted critic record. The function is deterministic
 * and never merges functional, compiler, critic, or owner authority.
 */
export function advanceCreativeReview(
  state: CreativeReviewState,
  critic: RenderedTasteCriticRecord,
): CreativeReviewState {
  if (state.status !== "reviewing") return state;
  const expectedAttempt = state.attempts.length + 1;
  if (critic.attempt !== expectedAttempt || expectedAttempt > MAX_CREATIVE_REVIEW_ATTEMPTS) {
    return {
      ...state,
      status: "creative_review_required",
      stopReason: "invalid_attempt",
    };
  }

  const attempt: CreativeReviewAttempt = {
    attempt: critic.attempt,
    iteration: critic.iteration,
    treeHash: critic.treeHash,
    renderManifestHash: critic.renderManifestHash,
    criticDisposition: critic.criticDisposition,
    findingFingerprint: critic.findingFingerprint,
  };
  const attempts = [...state.attempts, attempt];
  const base: CreativeReviewState = {
    ...state,
    criticDisposition: critic.criticDisposition,
    attempts,
  };

  // A subjective accept can never turn either deterministic authority green.
  const prerequisiteStop = stopForPrerequisiteAuthority(base);
  if (prerequisiteStop !== null) return prerequisiteStop;

  if (critic.criticDisposition === "accept") return stopped(base, "creative_ready", "accepted");
  if (critic.criticDisposition === "unavailable") {
    return stopped(base, "creative_review_required", "critic_unavailable");
  }

  if (critic.findingFingerprint === null) {
    return stopped(base, "creative_review_required", "invalid_attempt");
  }
  const repeated = state.attempts.some(
    (prior) =>
      prior.criticDisposition === "revise" &&
      prior.treeHash === critic.treeHash &&
      prior.findingFingerprint === critic.findingFingerprint,
  );
  if (repeated) return stopped(base, "not_converging", "repeated_tree_and_findings");
  if (attempts.length >= MAX_CREATIVE_REVIEW_ATTEMPTS) {
    return stopped(base, "creative_review_required", "attempts_exhausted");
  }
  return base;
}

function stopped(
  state: CreativeReviewState,
  status: Exclude<CreativeReviewStatus, "reviewing">,
  stopReason: Exclude<CreativeReviewStopReason, null>,
): CreativeReviewState {
  return { ...state, status, stopReason };
}

function stopForPrerequisiteAuthority(state: CreativeReviewState): CreativeReviewState | null {
  if (state.heldOutPass === false) return stopped(state, "failed", "functional_red");
  if (state.creativeCompilePass === false) return stopped(state, "failed", "compiler_red");
  if (state.heldOutPass !== true || state.creativeCompilePass !== true) {
    return stopped(state, "creative_review_required", "prerequisite_unknown");
  }
  return null;
}

/** Owner choice changes only its own authority column. */
export function withOwnerDecision(
  state: CreativeReviewState,
  ownerDecision: OwnerDecision,
): CreativeReviewState {
  return { ...state, ownerDecision };
}
