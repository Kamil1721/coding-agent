/**
 * THE EVIDENCE BAR. This file is the product; the patch author is not.
 *
 * A RepairProposal is REFUSED unless it carries three verbatim transcripts — RED before,
 * GREEN after, and RED under a revert of the fix. Absence is treated exactly like failure,
 * and a refusal is written to the ledger as loudly as a rejection, because a refusal that
 * returns quietly is this repository's signature defect wearing a new hat.
 *
 * WHAT THE MUTATION PROOF IS, AND WHAT IT IS NOT.
 * The mutant is the fix-hunk revert, derived mechanically by prover.mjs, so the agent
 * cannot choose its own exam. But a mutation proof is a VACUITY control, not a correctness
 * control: it shows the test can fail, and says nothing about whether the patch is right.
 * Overfitting is the central failure mode of automated program repair. So two more bars,
 * neither of which is the test the patch was written against:
 *
 *   1. SCOPE. Every changed file must be implicated by the evidence itself. Outcome-level
 *      attribution produces broad, poorly-scoped diffs; a file the RED transcript never
 *      names is not evidence-backed, it is a guess with a diff around it.
 *   2. AN INDEPENDENT CHECK. Recorded behaviour on UNRELATED recorded inputs must not move,
 *      and the targeted behaviour must. Absent -> refused, same as a missing transcript.
 *
 * And one memory bar: a repair already RULED OUT for this signature is refused before it is
 * proved again. A corpus of successes alone re-suggests a failed repair forever.
 */

import { filesInDiff, normaliseDiff, parseUnifiedDiff } from "./diff.mjs";
import { createHash } from "node:crypto";

export const REASONS = {
  MISSING_SIGNATURE: "the proposal names no defect signature, so it cannot be attributed or de-duplicated",
  EMPTY_DIFF: "the proposal carries no diff",
  DIFF_UNPARSEABLE: "the diff could not be parsed as a unified diff",
  MISSING_EVIDENCE_RED_BEFORE: "evidence.redBefore is absent or blank: the defect was never watched failing",
  MISSING_EVIDENCE_GREEN_AFTER: "evidence.greenAfter is absent or blank: the fix was never watched passing",
  MISSING_EVIDENCE_MUTATION_RED: "evidence.mutationRed is absent or blank: the check was never watched failing under a revert of the fix",
  RED_EQUALS_GREEN: "redBefore and greenAfter are byte-identical: the check did not change state, so it observes nothing",
  MUTATION_RED_EQUALS_GREEN: "mutationRed and greenAfter are byte-identical: reverting the fix changed nothing, so the check is not pinned to this patch",
  EVIDENCE_EXIT_CODES_INCONSISTENT: "a transcript does not carry the exit code the run it claims to be would have produced",
  FILES_UNDER_DECLARED: "the diff touches files the proposal does not declare in filesChanged",
  FILES_OVER_DECLARED: "filesChanged names files the diff does not touch",
  TOUCHES_FROZEN_CLOSURE: "the minimal diff reaches the frozen closure; this is owner-only regardless of how good the evidence is",
  NO_FROZEN_CLOSURE:
    "no frozen closure was supplied, so the owner-only check could not be performed; absence is treated exactly like " +
    "failure — a TOUCHES_FROZEN_CLOSURE check with an empty closure refuses nothing and reports a clean ACCEPT",
  SCOPE_UNIMPLICATED_FILE: "a changed file is not implicated by the evidence",
  ALREADY_RULED_OUT: "this repair was already tried against this signature and did not clear it",
  NO_INDEPENDENT_CHECK: "no independent check accompanied the proposal; a mutation proof alone is a vacuity control, not a correctness control",
  INDEPENDENT_CHECK_FAILED: "the independent replay changed recorded behaviour on inputs this defect does not implicate",
  INDEPENDENT_CHECK_MISSED_TARGET: "the independent replay shows the targeted recorded behaviour did not change",
};

const SOURCEISH = /[\w./-]*[\w-]+\.(?:m?[jt]sx?|json|jsonl|md|sql|ya?ml|sh|mjs|cjs)/g;

function blank(s) {
  return typeof s !== "string" || s.trim() === "";
}

/**
 * The files the evidence itself implicates: whatever the RED transcript names, plus the
 * artefacts and candidate paths the defect record carried. Nothing else.
 */
export function implicatedFiles(proposal, defect = {}) {
  const found = new Set();
  const red = typeof proposal?.evidence?.redBefore === "string" ? proposal.evidence.redBefore : "";
  for (const m of red.matchAll(SOURCEISH)) found.add(m[0].replace(/^\.\//, ""));
  for (const p of defect.artefacts ?? []) found.add(String(p));
  for (const p of defect.candidatePaths ?? []) found.add(String(p));
  return [...found].sort();
}

function implicates(implicated, file) {
  const f = String(file).replace(/^\.\//, "");
  return implicated.some((i) => {
    const c = String(i).replace(/^\.\//, "");
    return c === f || c.endsWith("/" + f) || f.endsWith("/" + c);
  });
}

/** Stable identity for "this same repair", so a regenerated patch is still the same idea. */
export function proposalFingerprint(proposal) {
  return createHash("sha256").update(normaliseDiff(proposal?.diff ?? ""), "utf8").digest("hex").slice(0, 32);
}

/**
 * @param {object} proposal RepairProposal
 * @param {{ defect?: object,
 *           frozenClosure?: readonly string[],
 *           ruledOutFingerprints?: readonly string[],
 *           independentCheck?: { ran: boolean, targetedChanged: boolean, unrelatedChanged: readonly string[] } | null
 *         }} [ctx]
 * @returns {{ verdict: "ACCEPTED"|"REFUSED", reasons: {code:string, detail:string}[],
 *             signature: string|null, filesChanged: string[], at: string }}
 */
export function validateProposal(proposal, ctx = {}) {
  /** @type {{code:string, detail:string}[]} */
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, detail: detail ?? REASONS[code] ?? code });

  const signature = typeof proposal?.signature === "string" && proposal.signature.trim() !== "" ? proposal.signature.trim() : null;
  if (signature === null) add("MISSING_SIGNATURE");

  // --- the three transcripts. Absence is failure. -------------------------------------
  const ev = proposal?.evidence ?? {};
  if (blank(ev.redBefore)) add("MISSING_EVIDENCE_RED_BEFORE");
  if (blank(ev.greenAfter)) add("MISSING_EVIDENCE_GREEN_AFTER");
  if (blank(ev.mutationRed)) add("MISSING_EVIDENCE_MUTATION_RED");
  if (!blank(ev.redBefore) && !blank(ev.greenAfter) && ev.redBefore === ev.greenAfter) add("RED_EQUALS_GREEN");
  if (!blank(ev.mutationRed) && !blank(ev.greenAfter) && ev.mutationRed === ev.greenAfter) add("MUTATION_RED_EQUALS_GREEN");

  // The prover is the only legal producer of these strings and it always ends a transcript
  // with the process's exit code. Cheapest available discriminator against a fabricated or
  // hand-copied transcript: a RED that exited 0 is not a RED.
  const wrongWay = [
    ["redBefore", ev.redBefore, false],
    ["greenAfter", ev.greenAfter, true],
    ["mutationRed", ev.mutationRed, false],
  ]
    .filter(([, text]) => !blank(text))
    .map(([name, text, wantZero]) => {
      const m = [...String(text).matchAll(/^# exit code: (.+)$/gm)].pop();
      if (!m) return `${name} carries no exit-code trailer, so it did not come from the prover`;
      const zero = m[1].trim() === "0";
      if (zero !== wantZero) return `${name} ended with exit code ${m[1].trim()}`;
      return null;
    })
    .filter(Boolean);
  if (wrongWay.length > 0) add("EVIDENCE_EXIT_CODES_INCONSISTENT", `${REASONS.EVIDENCE_EXIT_CODES_INCONSISTENT}: ${wrongWay.join("; ")}`);

  // --- the diff ------------------------------------------------------------------------
  let actualFiles = [];
  const diffText = typeof proposal?.diff === "string" ? proposal.diff : "";
  if (diffText.trim() === "") {
    add("EMPTY_DIFF");
  } else {
    try {
      parseUnifiedDiff(diffText);
      actualFiles = filesInDiff(diffText);
      if (actualFiles.length === 0) add("EMPTY_DIFF");
    } catch (err) {
      add("DIFF_UNPARSEABLE", `${REASONS.DIFF_UNPARSEABLE}: ${err.message}`);
    }
  }

  const declared = [...new Set((proposal?.filesChanged ?? []).map(String))].sort();
  if (actualFiles.length > 0) {
    const under = actualFiles.filter((f) => !declared.includes(f));
    const over = declared.filter((f) => !actualFiles.includes(f));
    if (under.length > 0) add("FILES_UNDER_DECLARED", `${REASONS.FILES_UNDER_DECLARED}: ${under.join(", ")}`);
    if (over.length > 0) add("FILES_OVER_DECLARED", `${REASONS.FILES_OVER_DECLARED}: ${over.join(", ")}`);
  }

  /* --- frozen closure: owner-only, REQUIRED, and the flag is not trusted on its own ----
   *
   * IT USED TO BE `ctx.frozenClosure ?? []` AND THAT IS THE SILENT-SUCCESS SHAPE THIS
   * REPOSITORY KEEPS SHIPPING. A caller that omitted the closure got a
   * TOUCHES_FROZEN_CLOSURE check that refused nothing and a clean ACCEPT — the exact
   * asymmetry the three-transcript rule was written to forbid ("absence is treated exactly
   * like failure"). An empty list is refused for the same reason a missing one is: it is
   * indistinguishable from "nothing is frozen", which is never true in this repository.
   * `tools/tier3/closure.mjs#frozenClosure` computes the real §6.1 list from the entry
   * points, so there is no excuse for a caller not to pass it.
   */
  const closure = ctx.frozenClosure;
  if (!Array.isArray(closure) || closure.length === 0) {
    add("NO_FROZEN_CLOSURE");
  }
  const reaching = actualFiles.filter((f) => (closure ?? []).some((c) => f === c || f.endsWith("/" + c)));
  if (proposal?.touchesFrozenClosure === true || reaching.length > 0) {
    add("TOUCHES_FROZEN_CLOSURE", `${REASONS.TOUCHES_FROZEN_CLOSURE}${reaching.length > 0 ? `: ${reaching.join(", ")}` : ""}`);
  }

  // --- scope: the evidence must implicate every changed file ---------------------------
  const implicated = implicatedFiles(proposal, ctx.defect ?? {});
  for (const f of actualFiles) {
    if (!implicates(implicated, f)) add("SCOPE_UNIMPLICATED_FILE", `${REASONS.SCOPE_UNIMPLICATED_FILE}: ${f}`);
  }

  // --- the independent check, and its absence is failure -------------------------------
  const ind = ctx.independentCheck;
  if (!ind || ind.ran !== true) {
    add("NO_INDEPENDENT_CHECK");
  } else {
    if ((ind.unrelatedChanged ?? []).length > 0) {
      add("INDEPENDENT_CHECK_FAILED", `${REASONS.INDEPENDENT_CHECK_FAILED}: ${[...ind.unrelatedChanged].join(", ")}`);
    }
    if (ind.targetedChanged !== true) add("INDEPENDENT_CHECK_MISSED_TARGET");
  }

  // --- what was ruled out ---------------------------------------------------------------
  const fp = proposalFingerprint(proposal);
  if ((ctx.ruledOutFingerprints ?? []).includes(fp)) add("ALREADY_RULED_OUT", `${REASONS.ALREADY_RULED_OUT} (fingerprint ${fp})`);

  return {
    verdict: reasons.length === 0 ? "ACCEPTED" : "REFUSED",
    reasons,
    signature,
    filesChanged: actualFiles,
    proposalFingerprint: fp,
    at: new Date().toISOString(),
  };
}

/** A refusal has to be as loud as a rejection or nobody will ever see one. */
export function formatVerdict(verdict, proposal = {}) {
  if (verdict.verdict === "ACCEPTED") {
    return `REPAIR PROPOSAL ACCEPTED  signature=${verdict.signature} files=${verdict.filesChanged.join(",") || "(none)"} fingerprint=${verdict.proposalFingerprint}`;
  }
  const head = `REPAIR PROPOSAL REFUSED  signature=${verdict.signature ?? "(none)"} fingerprint=${verdict.proposalFingerprint} reasons=${verdict.reasons.length}`;
  const body = verdict.reasons.map((r, i) => `  ${i + 1}. [${r.code}] ${r.detail}`);
  return [head, ...body, `  proposedAt=${proposal.proposedAt ?? "(unrecorded)"}`].join("\n");
}
