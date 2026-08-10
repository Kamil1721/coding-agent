/**
 * THE ANTI-LOOP RULE — signature comparison, because a counter cannot see last night.
 *
 * Run a913c871: three authoring attempts, budget NEVER exceeded (3 of 3), and attempt 3
 * threw away the `id` it had got right on attempt 2. A counter reports "2 of 3 spent,
 * healthy". The measured sequence of reported violation paths was:
 *
 *     attempt 1 -> {dataExpectations[0].id}     (RUN-a913c871-observations.md:388)
 *     attempt 2 -> {dataExpectations[0].kind}   (:389)
 *     attempt 3 -> {dataExpectations[0].id}     (:336-339, the verbatim failure_reason)
 *
 * Note what the 1->2 transition is NOT. It is not identical. It is not yet an oscillation
 * (that needs the third point). It is not a shrink. Design §3.4's three arms cannot fire
 * there — so a comparator built only from §3.4 escalates at attempt 3, after 87 minutes,
 * and the brief requires attempt 2. The fourth arm below is what fires at 2: the reported
 * set is DISJOINT from the previous one. The channel is proven to be handing out one field
 * at a time over a seven-field object, which is arithmetically non-convergent. Research R4
 * licenses this arm explicitly ("if attempt N breaks a constraint attempt N-1 satisfied,
 * that is a loop defect to log, not a normal retry").
 *
 * ARMS THAT ESCALATE          ARMS THAT DO NOT (and they are the negative control)
 *   IDENTICAL                   SHRINK    strict subset - the feedback channel is working
 *   OSCILLATION                 GROW      more fields named at once; collect-all does this
 *   NON_MONOTONE (disjoint)     OVERLAP   partial progress
 *   BLIND (no structure)
 *
 * A comparator that always escalates is exactly as useless as one that never does, so both
 * directions are fixtures in loop-guard.test.mjs and both were watched red under mutation.
 */

import { attemptPaths, computeSignature } from "./signature.mjs";

const ESCALATING = new Set(["IDENTICAL", "OSCILLATION", "NON_MONOTONE", "BLIND"]);

/**
 * Classify one transition. `history` is the union of every set strictly before `prev`.
 * @returns {{arm: string, escalate: boolean, why: string}}
 */
export function classifyTransition(prev, cur, history = []) {
  if (prev === null || cur === null) {
    return {
      arm: "BLIND",
      escalate: true,
      why: "an attempt carries no structured violation paths, so the comparator cannot see repetition; refusing to guess from prose",
    };
  }
  const prevSet = new Set(prev);
  const curSet = new Set(cur);
  const histSet = new Set(history);

  const same = prev.length === cur.length && prev.every((p) => curSet.has(p));
  if (same) {
    return { arm: "IDENTICAL", escalate: true, why: "the same violation set came back; the feedback channel changed nothing" };
  }

  // A path reported earlier, absent from the immediately previous attempt, now back.
  const returned = cur.filter((p) => !prevSet.has(p) && histSet.has(p));
  if (returned.length > 0) {
    return {
      arm: "OSCILLATION",
      escalate: true,
      why: `a previously cleared path came back: ${returned.join(", ")}; the channel cannot converge`,
    };
  }

  const shared = cur.filter((p) => prevSet.has(p));
  if (shared.length === 0 && cur.length > 0 && prev.length > 0) {
    return {
      arm: "NON_MONOTONE",
      escalate: true,
      why: `the violation set is disjoint from the previous one (${prev.join(", ")} -> ${cur.join(", ")}); the attempt replaced its answer rather than repairing it`,
    };
  }

  const isSubset = cur.every((p) => prevSet.has(p));
  if (isSubset && cur.length < prev.length) {
    return { arm: "SHRINK", escalate: false, why: "the violation set strictly shrank; the feedback channel is working" };
  }
  const isSuperset = prev.every((p) => curSet.has(p));
  if (isSuperset) {
    return { arm: "GROW", escalate: false, why: "more paths are named than before; a collect-all validator does this legitimately" };
  }
  return { arm: "OVERLAP", escalate: false, why: "the sets partially overlap; some paths cleared and others appeared" };
}

/**
 * Walk a whole attempt sequence and return the first transition that escalates.
 *
 * @param {readonly object[]} attempts  DefectRecord.attempts, or anything carrying
 *        `violations[]`/`paths[]` per attempt. Prose-only attempts produce BLIND.
 * @param {{site?: string, bakeoffCode?: string|null, criterionId?: string|null}} [ctx]
 */
export function evaluateAttempts(attempts, ctx = {}) {
  const list = [...(attempts ?? [])];
  const sets = list.map((a) => attemptPaths(a));
  const signatures = sets.map((s) =>
    s === null ? null : computeSignature({ site: ctx.site ?? "", violations: s, bakeoffCode: ctx.bakeoffCode ?? null, criterionId: ctx.criterionId ?? null }),
  );
  const transitions = [];
  let escalateAtAttempt = null;
  let firstEscalation = null;

  for (let i = 1; i < list.length; i += 1) {
    const history = sets.slice(0, i - 1).flatMap((s) => s ?? []);
    const t = { n: i + 1, ...classifyTransition(sets[i - 1], sets[i], history) };
    transitions.push(t);
    if (t.escalate && escalateAtAttempt === null) {
      escalateAtAttempt = t.n;
      firstEscalation = t;
    }
  }

  return {
    attempts: list.length,
    signatures,
    signatureHistory: signatures.filter((s) => s !== null),
    transitions,
    escalate: escalateAtAttempt !== null,
    escalateAtAttempt,
    arm: firstEscalation?.arm ?? null,
    why: firstEscalation?.why ?? null,
    blind: sets.some((s) => s === null),
  };
}

/** True when this sequence must go to Tier 2 instead of spending the remaining budget. */
export function shouldEscalate(verdict) {
  return Boolean(verdict?.escalate) && ESCALATING.has(verdict.arm);
}
