/**
 * TIER 3 — PROPOSAL ADMISSION AND THE L4 APPLY TOKEN.
 *
 * THE EVIDENCE BAR IS MECHANICAL, NOT EDITORIAL. A proposal missing any of the
 * three verbatim transcripts — red before, green after, red under a revert of
 * the fix hunk — is REFUSED, not queued. Absence is treated exactly like
 * failure, because this repository has twenty-one catalogued instances of a
 * check that can only observe success and a repair agent writing its own test
 * is the highest-risk instance available.
 *
 * WHAT THE MUTATION TRANSCRIPT IS AND IS NOT. It is a VACUITY control: it
 * proves the test observes the patched behaviour. It is NOT evidence the patch
 * is correct — vacuity and overfitting are orthogonal axes (RESEARCH W5), and
 * this repository has the local proof: emptying `MUST_FAIL` left the gate
 * green at 7/7 under an outcome-only test. The trail records it under
 * `negativeControl`, never under `correctness`.
 *
 * L4 — THE APPLY TOKEN IS THE LAYER THE OTHER THREE NEED. The gate is invoked
 * from the EDITABLE dashboard package, so a patch that simply skips the gate
 * passes trivially. Enforcement is therefore at APPLY: the token digests
 * (frozen manifest digest ‖ diff digest ‖ the verdicts), and `apply` refuses
 * anything without a matching one. "The caller skipped the gate" then becomes
 * indistinguishable from "the gate refused", which is the correct fail-safe
 * direction.
 */

import { createHash } from "node:crypto";
import { classifyDiff } from "./closure.mjs";
import { validateProposal as gradeEvidence } from "../repair/evidence.mjs";

const EVIDENCE_KEYS = Object.freeze(["redBefore", "greenAfter", "mutationRed"]);

/**
 * THE CHECKS THIS FILE DELEGATES TO `tools/repair/evidence.mjs`, AND THE ONES IT
 * DELIBERATELY DOES NOT.
 *
 * MEASURED 2026-08-10: this validator checked the three transcripts for
 * `nonEmptyString` and nothing else, and the gate returned APPLY on
 * OUTSIDE-CLOSURE before `proofs` was consulted — so a proposal whose entire
 * bundle was `{redBefore:"x", greenAfter:"x", mutationRed:"x"}` got a real
 * 64-hex apply token for a diff against `dashboard/server/src/orchestrator.ts`.
 * Three checks that would have caught it already existed, mutation-proved, one
 * directory away, with zero cross-imports. This import is that fix.
 *
 * WHY A WHITELIST AND NOT THE WHOLE VERDICT. `evidence.mjs` also refuses
 * `NO_INDEPENDENT_CHECK` unless `ctx.independentCheck.ran === true` and
 * `SCOPE_UNIMPLICATED_FILE` unless `ctx.defect` names the paths — and `runGate`
 * supplies NEITHER. Adopting those two here would turn the gate into a component
 * that can only refuse, which is the mirror image of the bug and the one
 * direction that DOES stop the pipeline. They are carried, not silently dropped:
 * the gate needs a caller that supplies a defect record and an executed replay
 * before it can enforce them, and until then the repair cycle
 * (`tools/repair/cycle.mjs`) is the only place they are enforced.
 *
 * Every code below is decidable from the PROPOSAL ALONE, which is why it is safe
 * to adopt with no new inputs.
 */
const ADOPTED_FROM_REPAIR_LANE = Object.freeze([
  "RED_EQUALS_GREEN",
  "MUTATION_RED_EQUALS_GREEN",
  "EVIDENCE_EXIT_CODES_INCONSISTENT",
  "DIFF_UNPARSEABLE",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a RepairProposal against the shared contract. Returns every refusal
 * reason, not the first: a proposal rejected one field at a time is run
 * a913c871 all over again, in the patch queue instead of the spec phase.
 */
export function validateProposal(proposal, closure) {
  const refusals = [];
  if (proposal === null || typeof proposal !== "object") {
    return { ok: false, refusals: ["the proposal is not an object"], route: "REFUSED" };
  }
  if (!nonEmptyString(proposal.signature)) refusals.push("signature is missing or blank");
  if (!nonEmptyString(proposal.diff)) refusals.push("diff is missing or blank");
  if (!Array.isArray(proposal.filesChanged) || proposal.filesChanged.length === 0) {
    refusals.push("filesChanged is missing or empty");
  }
  if (!nonEmptyString(proposal.proposedAt)) refusals.push("proposedAt is missing or blank");

  const evidence = proposal.evidence ?? {};
  for (const key of EVIDENCE_KEYS) {
    if (!nonEmptyString(evidence[key])) {
      refusals.push(
        `evidence.${key} is missing or blank — a proposal without a verbatim ${key} transcript is REFUSED, ` +
          "not queued; absence is treated exactly like failure",
      );
    }
  }

  /*
   * THE REPAIR LANE'S BAR, ADOPTED RATHER THAN RE-IMPLEMENTED. A second copy of
   * "is this transcript real" is a second answer to a question that must have
   * one, and the copy that drifts is always the one guarding the accept path.
   */
  for (const reason of gradeEvidence(proposal).reasons) {
    if (ADOPTED_FROM_REPAIR_LANE.includes(reason.code)) refusals.push(`${reason.code}: ${reason.detail}`);
  }

  // The blast radius is RECOMPUTED from the diff. A proposal that reports
  // `touchesFrozenClosure: false` about a diff that touches the closure is not
  // corrected quietly — it is refused, because the field is the one a caller
  // in the editable package would set.
  let classified = null;
  if (nonEmptyString(proposal.diff) && closure !== undefined) {
    classified = classifyDiff(proposal.diff, closure);
    if (typeof proposal.touchesFrozenClosure === "boolean" && proposal.touchesFrozenClosure !== classified.touchesFrozenClosure) {
      refusals.push(
        `the proposal claims touchesFrozenClosure=${String(proposal.touchesFrozenClosure)} but the diff ` +
          `classifies as ${String(classified.touchesFrozenClosure)} (${classified.reason})`,
      );
    }
    const declared = [...(proposal.filesChanged ?? [])].sort().join(",");
    const actual = classified.filesChanged.join(",");
    if (declared.length > 0 && declared !== actual) {
      refusals.push(`filesChanged (${declared}) does not match the paths in the diff (${actual})`);
    }
  }

  if (refusals.length > 0) return { ok: false, refusals, route: "REFUSED", classified };
  return { ok: true, refusals: [], route: classified?.route ?? "OUTSIDE-CLOSURE", classified };
}

export function diffDigest(diff) {
  return createHash("sha256").update(diff).digest("hex");
}

/** The token. Any input changing changes the token, which is the whole point. */
export function mintApplyToken({ frozenDigest, diff, verdicts }) {
  const body = JSON.stringify({ frozenDigest, diffDigest: diffDigest(diff), verdicts });
  return createHash("sha256").update(body).digest("hex");
}

export function verifyApplyToken(token, inputs) {
  return typeof token === "string" && token.length === 64 && token === mintApplyToken(inputs);
}

/**
 * The apply decision. NOTHING HERE WRITES TO THE TREE — applying is the
 * caller's job and it must present a token. This function is what makes a
 * missing token and a refused gate the same outcome.
 */
export function decideApply({ token, frozenDigest, diff, verdicts }) {
  if (!verifyApplyToken(token, { frozenDigest, diff, verdicts })) {
    return {
      apply: false,
      reason:
        "no matching apply token. Either the gate refused, or the caller skipped the gate — and those are " +
        "deliberately indistinguishable here, because the caller lives in the EDITABLE dashboard package.",
    };
  }
  return { apply: true, reason: "the token matches the frozen manifest, this diff and these verdicts" };
}
