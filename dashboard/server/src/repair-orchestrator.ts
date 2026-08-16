/**
 * repair-orchestrator.ts — the repair lane's loop.
 *
 * Implements `docs/DESIGN-repair-lane-2026-08-16.md` §2 (the goal predicate), §3
 * (loose in diagnosis, strict at the boundary), §3A (the firing boundary), §10.5
 * (Codex asks first) and §13 (a child of the run that surfaced the defect).
 *
 * WHAT THIS FILE IS FOR. Every part of a repair already existed and nothing
 * sequenced them: `adjudicate.ts` decides whether the lane should wake,
 * `repair-questions.ts` asks and answers, `repair-author.ts` writes a patch,
 * `tools/repair/cycle.mjs` proves one, `tools/tier3/gate.mjs` authorises it and
 * `tools/repair/supervisor-gate.mjs` applies it. This sequences them.
 *
 * IT IS NOT YET WIRED TO ANY OF THEM, AND THE FIRST DRAFT OF THIS PARAGRAPH SAID
 * OTHERWISE. Corrected 2026-08-16: calling it "the conductor of existing parts"
 * implied it calls `cycle.mjs`; it does not. It defines {@link RepairDeps} and
 * expresses the ablation itself, so today it is a tested SHAPE with the real
 * implementations still to be bound to those seams. Whoever binds them should
 * check that `cycle.mjs` is not being re-implemented here rather than called.
 *
 * ─── THE ONE RULE THAT SHAPES EVERYTHING BELOW ──────────────────────────────
 *
 * `/goal` — the Claude Code built-in the owner pointed at — lets the MODEL
 * decide whether its own stop condition is met. This lane may not. A model that
 * decides it has finished repairing itself is the same self-report this
 * repository removes from the build lane, reintroduced one level up where
 * nothing is watching.
 *
 *   Judgment is free in HOW it diagnoses and WHAT it tries.
 *   The stop condition is a command that exits 0.
 *
 * So {@link goalMet} is a pure function over RUNNER results. No seam in this
 * file may return "I think this is fixed"; every seam returns what a process
 * did. {@link RepairDeps} is written that way deliberately — read its members
 * and note that the model-backed ones (`ask`, `answer`, `authorPatch`, `review`)
 * feed the DIAGNOSIS, and none of them can reach {@link goalMet}.
 *
 * ─── THE FOUR CONJUNCTS, AND WHY THE FOURTH EXISTS ──────────────────────────
 *
 *   1. the defect REPRODUCED before anything changed        (red)
 *   2. the patch made it stop                               (green)
 *   3. reverting the patch brought it back                  (red again)
 *   4. every suite still passes                             (no regression)
 *
 * 1-3 are the ablation and they are the whole difference between "a change was
 * made and the symptom went away" and "this change is what fixed it". 4 is the
 * owner's *"without it actually causing any regressions"*, and it is the one a
 * repair loop most often omits because the defect it was chasing is gone.
 *
 * ─── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
 *
 *  - It never touches the artefact. `dashboard/runs/` is refused by
 *    `repair-author.ts`'s {@link REFUSED_PATH_PREFIXES} with the right reason
 *    ("a forged measurement, not a repair"), and {@link scopeRefusal} re-checks
 *    every path in the authored patch rather than trusting that it was checked.
 *  - It never edits a suite. Same list, same reason.
 *  - It never decides an ARTEFACT failure is worth repairing. `wakeRepairLane`
 *    from `adjudicate.ts` is the gate, and {@link runRepair} returns `NOT_MINE`
 *    without spending a token when it is false.
 */

import { diffShape, normaliseRequestedPath, refusedPathReason } from "./repair-author.js";
import type { Adjudication } from "./adjudicate.js";

/* =========================================================================
 * 1. The goal predicate — the only thing that may end the loop successfully
 * ====================================================================== */

/** One suite's result. `ran` is separate from `green` for the reason below. */
export interface SuiteResult {
  readonly name: string;
  /**
   * DID IT EXECUTE. Separate from {@link green} because a suite that did not run
   * is not a passing suite, and collapsing them is this repository's signature
   * defect: a check that can only observe success. A runner that cannot start
   * reports `{ran: false, green: false}` and {@link goalMet} refuses the repair.
   */
  readonly ran: boolean;
  readonly green: boolean;
  /** Whatever the runner said, for the report. Never parsed for a decision. */
  readonly detail: string;
}

/**
 * The evidence the loop collects. EVERY FIELD IS A PROCESS RESULT.
 *
 * There is deliberately no field a model can populate. If a future change adds
 * one, the sentence at the head of this file stops being true.
 */
export interface GoalEvidence {
  /** The reproduction command exited NON-ZERO before the patch. */
  readonly reproducedRedBefore: boolean;
  /** …and exited ZERO after it. */
  readonly greenAfterPatch: boolean;
  /** …and exited NON-ZERO again once the patch was reverted. */
  readonly redAgainWhenReverted: boolean;
  /** Every suite the repo has. An empty array fails: nothing was checked. */
  readonly suites: readonly SuiteResult[];
}

export interface GoalVerdict {
  readonly met: boolean;
  /** Why, in the owner's words. Always populated, for both answers. */
  readonly why: string;
  /** The conjunct that failed first, or null when all four held. */
  readonly failedConjunct: "reproduce" | "fix" | "ablate" | "regress" | null;
}

/**
 * THE STOP CONDITION. Pure, total, and the only path to `APPLIED`.
 *
 * ORDER MATTERS AND IS NOT COSMETIC. `reproduce` is checked first because a
 * defect that never reproduced cannot have been fixed by anything — reporting
 * "green after patch" for a command that was already green is the single
 * easiest way to manufacture a false repair, and it is what an eager loop does
 * when the defect is intermittent.
 *
 * AN EMPTY `suites` ARRAY FAILS. `.every()` on `[]` is `true`, so a naive
 * fourth conjunct would report "no regressions" for a run that executed no
 * tests at all. That is the exact shape of the defect this repo keeps finding
 * in itself, so it is refused explicitly and has its own test.
 */
export function goalMet(evidence: GoalEvidence): GoalVerdict {
  if (!evidence.reproducedRedBefore) {
    return {
      met: false,
      failedConjunct: "reproduce",
      why:
        "the defect did not reproduce before anything was changed, so there is nothing here to have " +
        "fixed. A repair that cannot first make the fault happen on purpose is a guess with a green " +
        "test next to it.",
    };
  }
  if (!evidence.greenAfterPatch) {
    return { met: false, failedConjunct: "fix", why: "the change did not stop the fault happening." };
  }
  if (!evidence.redAgainWhenReverted) {
    return {
      met: false,
      failedConjunct: "ablate",
      why:
        "undoing the change did NOT bring the fault back, so something else fixed it and this change " +
        "is not the reason. Applying it would record a repair that did nothing.",
    };
  }
  if (evidence.suites.length === 0) {
    return {
      met: false,
      failedConjunct: "regress",
      why: "no test suite was run at all, so nothing is known about whether the rest of the system still works.",
    };
  }
  const notRun = evidence.suites.filter((suite) => !suite.ran);
  if (notRun.length > 0) {
    return {
      met: false,
      failedConjunct: "regress",
      why:
        `${String(notRun.length)} test suite(s) did not run (${notRun.map((s) => s.name).join(", ")}), and a ` +
        "suite that did not run is not a suite that passed.",
    };
  }
  const red = evidence.suites.filter((suite) => !suite.green);
  if (red.length > 0) {
    return {
      met: false,
      failedConjunct: "regress",
      why: `the change broke ${red.map((s) => s.name).join(", ")}, so it fixed one thing and cost another.`,
    };
  }
  return {
    met: true,
    failedConjunct: null,
    why:
      "the fault was made to happen on purpose, the change stopped it, undoing the change brought it " +
      `straight back, and all ${String(evidence.suites.length)} test suites still pass.`,
  };
}

/* =========================================================================
 * 2. Write scope — re-checked here, never assumed
 * ====================================================================== */

/** A path the patch touches, and why the lane may not write it. */
export interface ScopeRefusal {
  readonly path: string;
  readonly why: string;
}

/**
 * Re-check every path in an authored patch against the refusal list.
 *
 * WHY RE-CHECK WHAT THE AUTHOR ALREADY CHECKED. `repair-author.ts` refuses these
 * prefixes when the SEAT ASKS for a file, which is a check on a request. This is
 * a check on the RESULT, and the two are not the same: a seat that requested an
 * allowed file can still emit a diff whose header names a refused one, and the
 * applier (`git apply -p1`) reads the header, not the request. One of these is a
 * guard and the other is the guard's negative control.
 *
 * `dashboard/runs/` is on that list, so §3A.1's hard boundary — the lane may
 * never write the artefact under measurement — is enforced here as well as
 * there.
 */
export function scopeRefusals(paths: readonly string[]): readonly ScopeRefusal[] {
  const out: ScopeRefusal[] = [];
  for (const path of paths) {
    /*
     * NORMALISE FIRST. `refusedPathReason` is a raw `startsWith` with no
     * normalisation, so `./bakeoff/src/x.ts`, `bakeoff/src/../src/x.ts` and an
     * absolute path all slip past a prefix test that a plain
     * `bakeoff/src/x.ts` fails. `normaliseRequestedPath` rejects absolutes and
     * `..` outright and returns null for anything it cannot reduce; a path that
     * cannot be reduced is refused rather than waved through.
     */
    const safe = normaliseRequestedPath(path);
    if (safe === null) {
      out.push({ path, why: "this path could not be reduced to a repo-relative form, so it cannot be checked" });
      continue;
    }
    const why = refusedPathReason(safe);
    if (why !== null) out.push({ path: safe, why });
  }
  return out;
}

/**
 * The files a patch will actually touch, read from the DIFF.
 *
 * WHY THIS EXISTS, AND IT IS THE WHOLE OF THE FIX. `runRepair` used to check
 * `proposal.paths` — a field the MODEL-BACKED patch author declares. `applyPatch`
 * hands `git apply` the `proposal.diff`. Nothing reconciled the two, so a
 * proposal could declare `dashboard/server/src/recovery.ts` while its diff
 * header named `bakeoff/src/scorer-container.ts` — the frozen grader closure —
 * and it passed the scope check, passed `classifyPatch` (which reads the same
 * declared array), reached the gate, and was applied and committed by the
 * unattended lane. Measured: `outcome.kind = APPLIED`.
 *
 * That defeated this file's own stated rule — that no model-backed seam may
 * decide anything the gate rests on — at the single point where it matters most.
 * The write scope is now derived from the bytes the applier reads.
 *
 * AN EMPTY DERIVED SET IS A REFUSAL, NOT AN EMPTY SCOPE. `diffShape` only reads
 * `--- `/`+++ ` header pairs, so a pure `rename from`/`rename to` diff yields no
 * files at all — and "no files" would sail through a scope check that only looks
 * for refused prefixes. A patch whose targets cannot be read is a patch that
 * cannot be scoped.
 */
export function patchTargets(diff: string): { readonly files: readonly string[]; readonly problem: string | null } {
  const files = diffShape(diff).files;
  if (files.length === 0) {
    return {
      files: [],
      problem:
        "no file could be read from this patch's headers. A diff that renames without a --- / +++ pair, " +
        "or that is malformed, has targets this check cannot see — and an unreadable scope is not an empty one.",
    };
  }
  return { files, problem: null };
}

/* =========================================================================
 * 3. Classification — the skill's three paths, repointed
 * ====================================================================== */

/**
 * `superpowers:brainstorming`'s three paths, which are already the routing rule
 * this lane needs (design §10.2).
 *
 * The skill cannot be invoked as written — its spine is a hard human-approval
 * gate on every path, and this lane exists because no human is present. What
 * survives is the CLASSIFICATION; what is repointed is the gate.
 *
 *   spike / bounded  ->  the ablation gate decides, unattended
 *   architectural    ->  the owner decides. The lane parks and reports.
 *
 * The skill's own rule comes along and is worth more here than in a chat:
 * *"hidden complexity discovered mid-task upgrades the path"*. A repair that
 * turns out to restructure an interface must STOP, not finish.
 */
export type RepairPath = "spike" | "bounded" | "architectural";

export interface Classification {
  readonly path: RepairPath;
  readonly why: string;
}

/**
 * Classify from the PATCH, not from the model's self-description.
 *
 * A patch is architectural when it changes more files than a bounded fix plausibly
 * touches, or when it edits a file whose name marks it as a contract between
 * components. Both are structural facts about the diff, which is the point: a
 * seat asked "is this architectural?" has every incentive to say no.
 */
export function classifyPatch(paths: readonly string[], boundedFileCap: number): Classification {
  if (paths.length === 0) return { path: "spike", why: "the repair changed no files, so it is a finding rather than a fix" };
  const contracts = paths.filter((path) => /(?:^|\/)(?:contracts?|protocol|api-types|types)\.[cm]?tsx?$/.test(path));
  if (contracts.length > 0) {
    return {
      path: "architectural",
      why:
        `it edits ${contracts.join(", ")}, which other components are compiled against. Changing a shape ` +
        "others depend on is the skill's own definition of architectural, and it is the owner's call.",
    };
  }
  if (paths.length > boundedFileCap) {
    return {
      path: "architectural",
      why:
        `it touches ${String(paths.length)} files, past the ${String(boundedFileCap)} a bounded fix is ` +
        "allowed. A change this wide is a restructure wearing a bug fix's clothes.",
    };
  }
  return { path: "bounded", why: `it changes ${String(paths.length)} file(s) that already exist and no shared contract` };
}

/* =========================================================================
 * 4. Outcomes
 * ====================================================================== */

export type RepairOutcome =
  /** Adjudication says the BUILD failed. The main workflow owns it; the lane sleeps. */
  | { readonly kind: "NOT_MINE"; readonly why: string }
  /** Another run is already repairing this signature. Dedup is by defect, never by run. */
  | { readonly kind: "ALREADY_REPAIRING"; readonly signature: string; readonly underRunId: string }
  /** No runnable reproduction, so conjunct 1 can never hold. Nothing is attempted. */
  | { readonly kind: "NO_REPRODUCTION"; readonly signature: string; readonly why: string }
  /** The patch restructures something. Owner's call by design (§10.2). */
  | { readonly kind: "PARKED_ARCHITECTURAL"; readonly signature: string; readonly why: string }
  /** A question could be answered from no evidence source. Owner's call (§10.3). */
  | { readonly kind: "PARKED_FOR_OWNER"; readonly signature: string; readonly questions: readonly string[] }
  /** Diagnosed and patched, but the fix lands outside the lane's writable scope. */
  | {
      readonly kind: "PARKED_SCOPE_REFUSED";
      readonly signature: string;
      readonly refusals: readonly ScopeRefusal[];
      readonly diff: string;
    }
  /** The loop ran out of attempts without meeting the goal. */
  | { readonly kind: "GOAL_NOT_MET"; readonly signature: string; readonly attempts: number; readonly why: string }
  /** The goal held but the APPLY gate refused. The gate is never overridden. */
  | { readonly kind: "REFUSED_BY_GATE"; readonly signature: string; readonly why: string }
  /** Applied, committed, and proved. */
  | {
      readonly kind: "APPLIED";
      readonly signature: string;
      readonly attempts: number;
      readonly commit: string | null;
      readonly evidence: GoalEvidence;
    };

/* =========================================================================
 * 5. The seams
 * ====================================================================== */

export interface PatchProposal {
  readonly diff: string;
  /** Repo-relative paths the diff touches, as the APPLIER will read them. */
  readonly paths: readonly string[];
  readonly rationale: string;
}

export interface ProofRun {
  /** Exit code of the reproduction command. Non-zero is RED. */
  readonly exitCode: number;
  readonly detail: string;
}

/**
 * Everything this loop cannot do itself.
 *
 * READ THE SPLIT. `ask`, `answer`, `authorPatch` and `review` are model-backed
 * and shape the DIAGNOSIS. `reproduce`, `applyPatch`, `revertPatch` and
 * `runSuites` are process-backed.
 *
 * PRECISELY WHICH OF THEM REACH {@link goalMet}: `reproduce` (three times — the
 * red, the green and the ablation) and `runSuites`. That is all. `applyPatch`
 * and `revertPatch` gate whether the loop continues but contribute no field;
 * `gate` and `commit` run strictly AFTER the verdict. An earlier version of this
 * paragraph listed all six as inputs, which was wrong and made the guarantee
 * sound broader than it is. The guarantee that matters is unchanged and narrow:
 * **no model-backed member appears in {@link GoalEvidence} at all.**
 */
export interface RepairDeps {
  /** Codex, asking what must be known. Returns questions the answerer must source. */
  readonly ask: (signature: string) => Promise<readonly string[]>;
  /** Answer one question from CODE/DATA/EXPERIMENT/CODEX, or hand it to the owner. */
  readonly answer: (question: string) => Promise<{ readonly sourced: boolean; readonly answer: string }>;
  readonly authorPatch: (signature: string, notes: readonly string[]) => Promise<PatchProposal | null>;
  /** Codex again, adversarially. Advisory only — it is NOT a gate arm (§3C.2). */
  readonly review: (proposal: PatchProposal) => Promise<{ readonly concerns: readonly string[] }>;
  readonly reproduce: () => Promise<ProofRun>;
  readonly applyPatch: (proposal: PatchProposal) => Promise<{ readonly ok: boolean; readonly detail: string }>;
  readonly revertPatch: (proposal: PatchProposal) => Promise<{ readonly ok: boolean; readonly detail: string }>;
  readonly runSuites: () => Promise<readonly SuiteResult[]>;
  /** The APPLY gate. Its refusal is final. */
  readonly gate: (proposal: PatchProposal, evidence: GoalEvidence) => Promise<{ readonly authorised: boolean; readonly why: string }>;
  /** Commit, so the repair survives the next checkout (§3B). Null when unavailable. */
  readonly commit: (message: string) => Promise<string | null>;
  readonly log: (line: string) => void;
}

export interface RepairRequest {
  readonly signature: string;
  readonly adjudication: Pick<Adjudication, "wakeRepairLane">;
  /** Null when no reproduction is expressible — conjunct 1 can then never hold. */
  readonly reproductionCommand: string | null;
  /** Signature -> runId, for the dedup in §13.2. */
  readonly inFlight: ReadonlyMap<string, string>;
  readonly maxAttempts: number;
  readonly boundedFileCap: number;
}

/* =========================================================================
 * 6. The loop
 * ====================================================================== */

/**
 * One repair, start to finish.
 *
 * THE ORDER OF THE EARLY REFUSALS IS A COST ORDER. Each of the first three
 * returns before a single model token is spent, because all three are knowable
 * from data already in hand and the lane runs on the owner's own subscription
 * quota.
 */
export async function runRepair(request: RepairRequest, deps: RepairDeps): Promise<RepairOutcome> {
  const { signature } = request;

  // 1. NOT OURS. §3A: the lane fires on a PIPELINE defect and nothing else. An
  //    artefact that failed its own suite is the main workflow SUCCEEDING.
  if (!request.adjudication.wakeRepairLane) {
    return {
      kind: "NOT_MINE",
      why: "adjudication found no pipeline defect, so this is the build's failure and the main workflow owns it",
    };
  }

  // 2. ALREADY BEING REPAIRED. Dedup is by DEFECT SIGNATURE, never by run
  //    (§13.2) — two runs can surface one defect and it is one repair.
  const under = request.inFlight.get(signature);
  if (under !== undefined) {
    return { kind: "ALREADY_REPAIRING", signature, underRunId: under };
  }

  // 3. NOTHING TO PROVE AGAINST. Without a reproduction, conjunct 1 cannot hold,
  //    so no amount of patching could ever reach APPLIED. Saying so up front is
  //    the honest answer; attempting it anyway would burn the attempt budget to
  //    arrive at the same place with a patch nobody can trust.
  if (request.reproductionCommand === null) {
    return {
      kind: "NO_REPRODUCTION",
      signature,
      why:
        "this defect has no runnable reproduction, so there is no way to show a change fixed it. " +
        "The repair lane will not apply a patch it cannot prove.",
    };
  }

  // 4. ASK FIRST, AND WITH THE OTHER MODEL (§10.5). Questions come from an
  //    independent model precisely so that the priors generating the question
  //    are not the priors generating the answer.
  const questions = await deps.ask(signature);
  deps.log(`the asker returned ${String(questions.length)} question(s) about ${signature}`);

  const notes: string[] = [];
  const forOwner: string[] = [];
  for (const question of questions) {
    const answered = await deps.answer(question);
    if (answered.sourced) notes.push(`${question} -> ${answered.answer}`);
    else forOwner.push(question);
  }

  // 5. A QUESTION WITH NO EVIDENCE SOURCE IS THE OWNER'S (§10.3). Answering it
  //    from the model's own priors is the failure this whole design refuses, so
  //    the lane stops rather than guesses — and the report says what it could
  //    not decide, which is the half of the email people forget.
  if (forOwner.length > 0) {
    return { kind: "PARKED_FOR_OWNER", signature, questions: forOwner };
  }

  let attempts = 0;
  let lastWhy = "no attempt was made";

  while (attempts < request.maxAttempts) {
    attempts += 1;
    deps.log(`repair attempt ${String(attempts)} of ${String(request.maxAttempts)} for ${signature}`);

    const proposal = await deps.authorPatch(signature, notes);
    if (proposal === null) {
      lastWhy = "the patch author produced nothing";
      continue;
    }

    /*
     * 6. SCOPE, READ FROM THE DIFF — NOT FROM WHAT THE AUTHOR SAID IT TOUCHES.
     *
     * The author is a model. `proposal.paths` is its own description of its own
     * patch, and `git apply` never reads it. Checking the description while
     * applying the bytes is the shape of every scope bypass, and it was measured
     * reaching APPLIED with a diff against the frozen grader.
     */
    const targets = patchTargets(proposal.diff);
    if (targets.problem !== null) {
      return {
        kind: "PARKED_SCOPE_REFUSED",
        signature,
        refusals: [{ path: "(unreadable)", why: targets.problem }],
        diff: proposal.diff,
      };
    }
    const refusals = scopeRefusals(targets.files);
    if (refusals.length > 0) {
      return { kind: "PARKED_SCOPE_REFUSED", signature, refusals, diff: proposal.diff };
    }
    /*
     * AND A DISAGREEMENT IS ITSELF EVIDENCE. If the declared paths and the diff's
     * real targets differ, one of them is wrong and the lane cannot tell which.
     * A patch author that misdescribes its own patch has either a defect or an
     * intent, and neither is something to apply unattended.
     */
    const declared = [...proposal.paths].map((path) => normaliseRequestedPath(path) ?? path).sort();
    const actual = [...targets.files].sort();
    if (declared.join("\u0000") !== actual.join("\u0000")) {
      return {
        kind: "PARKED_SCOPE_REFUSED",
        signature,
        refusals: [
          {
            path: actual.join(", "),
            why:
              `the patch says it touches [${declared.join(", ")}] and its diff actually touches ` +
              `[${actual.join(", ")}]. A proposal that misdescribes itself is not applied unattended.`,
          },
        ],
        diff: proposal.diff,
      };
    }

    // 7. ARCHITECTURAL WORK IS NOT THIS LANE'S TO DO, and the classification is
    //    made from the diff rather than from anybody's description of it.
    const classification = classifyPatch(targets.files, request.boundedFileCap);
    if (classification.path === "architectural") {
      return { kind: "PARKED_ARCHITECTURAL", signature, why: classification.why };
    }
    /*
     * A `spike` MEANS THE PATCH CHANGES NOTHING, and it was being computed and
     * then dropped — the loop carried on and applied an empty diff. Its own
     * words are "the repair changed no files, so it is a finding rather than a
     * fix", which is precisely a thing not to commit.
     */
    if (classification.path === "spike") {
      lastWhy = classification.why;
      deps.log(lastWhy);
      continue;
    }

    // 8. THE SECOND OPINION, WHICH IS ADVISORY AND SAYS SO. Codex reviewing is
    //    not a gate arm: two models approving each other is still two models
    //    approving themselves, and `heldOutPass` was never allowed to rest on
    //    that. Concerns are recorded for the report and for the next attempt.
    const reviewed = await deps.review(proposal);
    for (const concern of reviewed.concerns) deps.log(`reviewer: ${concern}`);
    /*
     * THE CONCERNS ARE CARRIED INTO THE NEXT ATTEMPT'S NOTES, which is what this
     * block's docblock always claimed and did not do — they reached `deps.log`
     * and nothing else, so a second attempt re-authored the same patch with no
     * knowledge of what the reviewer objected to. Advisory still: they inform the
     * author, and they never reach `goalMet`.
     */
    for (const concern of reviewed.concerns) notes.push(`reviewer concern: ${concern}`);

    // 9. THE ABLATION. Every value below is an exit code.
    const before = await deps.reproduce();
    const applied = await deps.applyPatch(proposal);
    /*
     * A PATCH THAT WOULD NOT APPLY IS NOT A PATCH THAT FAILED TO FIX ANYTHING.
     * This used to synthesise `{exitCode: 1}` from a failed apply, so `goalMet`
     * reported "the change did not stop the fault happening" — a sentence about
     * the patch's CONTENT for a patch that never reached the tree. The detail was
     * threaded into a field nothing read.
     */
    if (!applied.ok) {
      lastWhy = `the patch would not apply to the tree: ${applied.detail}`;
      deps.log(lastWhy);
      await deps.revertPatch(proposal);
      continue;
    }
    const after = await deps.reproduce();
    const suites = await deps.runSuites();
    await deps.revertPatch(proposal);
    const reverted = await deps.reproduce();

    const evidence: GoalEvidence = {
      reproducedRedBefore: before.exitCode !== 0,
      greenAfterPatch: after.exitCode === 0,
      redAgainWhenReverted: reverted.exitCode !== 0,
      suites,
    };
    const verdict = goalMet(evidence);
    if (!verdict.met) {
      lastWhy = verdict.why;
      deps.log(`attempt ${String(attempts)} did not meet the goal: ${verdict.why}`);
      continue;
    }

    // 10. THE GATE HAS THE LAST WORD AND IS NEVER OVERRIDDEN.
    const authorised = await deps.gate(proposal, evidence);
    if (!authorised.authorised) {
      return { kind: "REFUSED_BY_GATE", signature, why: authorised.why };
    }

    // 11. RE-APPLY, THEN COMMIT. The ablation left the tree clean, so the patch
    //     has to go back on. COMMITTING IS WHAT MAKES THE REPAIR OUTLIVE THE RUN
    //     (§3B): a patch that only ever reaches the working tree is erased by the
    //     next checkout, and the same defect fires again next week having taught
    //     the system nothing.
    const reapplied = await deps.applyPatch(proposal);
    if (!reapplied.ok) {
      /*
       * NOT `REFUSED_BY_GATE`. Corrected 2026-08-16: it was, and that conflated
       * "the gate said no" with "the gate said yes and the tree moved underneath
       * us". They call for opposite responses — a refusal means the patch is
       * wrong and must not be retried as-is; a failed re-apply means the patch
       * was PROVEN and something else changed, which is worth another attempt.
       * Reporting the second as the first also tells the owner the gate rejected
       * work it actually authorised.
       */
      lastWhy = `the gate authorised this patch and it would not re-apply afterwards: ${reapplied.detail}`;
      deps.log(lastWhy);
      continue;
    }
    const commit = await deps.commit(`fix(repair): ${signature}\n\n${proposal.rationale}`);

    return { kind: "APPLIED", signature, attempts, commit, evidence };
  }

  return { kind: "GOAL_NOT_MET", signature, attempts, why: lastWhy };
}
