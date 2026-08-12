#!/usr/bin/env node
/**
 * THE SUPERVISOR'S REPAIR ENTRY POINT — one defect record in, one JSON line out.
 *
 * ─── WHY THIS FILE EXISTS ───
 *
 * Measured 2026-08-10: `grep -rn 'tools/repair\|tools/tier3\|tools/replay'
 * dashboard/server/src dashboard/src bakeoff/src | wc -l` → **0**. 110 tests and
 * 16 arm checks, all green, none of them reachable from any process. On the other
 * side of the same gap, `supervisor.ts` settled a structural failure to
 * `repairing` with the sentence "waiting for a repair proposal" and nothing in
 * the tree ever produced one. This is the seam between those two facts: the
 * supervisor spawns this, and this answers with an outcome the supervisor's
 * router already knows how to act on.
 *
 * ─── THE CHAIN, AND WHO DECIDES WHAT ───
 *
 *   defect record          this file reads it, and refuses to invent one
 *   anti-loop guard        loop-guard.mjs — signature comparison, never a count
 *   ruled-out ledger       ruled-out.mjs — a failed idea is refused on sight
 *   candidate diff         an INPUT. Design §5.3: the patch author is not built
 *   THE EVIDENCE BAR       cycle.mjs#runRepairCycle on an isolated copy of HEAD —
 *                          reproduce, prove, replay independently, validate. Only
 *                          an ACCEPTED verdict is allowed to reach the gate.
 *   THE TIER 3 GATE        tools/tier3/gate.mjs — the ONLY thing that authorises
 *                          a patch. It is spawned; its record is read; its apply
 *                          token is what `supervisor-gate.mjs` verifies.
 *   apply / rollback       supervisor-gate.mjs, and only on the gate's token
 *
 * NOTHING IN THIS FILE MAY DECIDE THAT A PATCH IS GOOD. It reads the gate's own
 * record and classifies it. If this file could reach `applied` by any other path,
 * that path would be the bug — so there is exactly one function in the tree that
 * writes a patch (`applyGatedPatch`) and it refuses any decision whose intent is
 * not `APPLY`, which `classifyGateRecord` produces only for a verdict of APPLY
 * carrying a token that re-mints over this exact diff.
 *
 * ─── WHAT IT DOES AND DOES NOT DO, STATED BECAUSE IT IS THE HONEST PART ───
 *
 * IT DOES NOT AUTHOR A PATCH. Design §5.3 records that the patch author is
 * deliberately not built, so on a tree with no candidate diff the truthful answer
 * is `NO_PATCH_AUTHOR` — a NAMED outcome the supervisor turns into `blocked` with
 * a sentence, which is the whole point: an honest terminal state beats a dead end.
 *
 * IT DOES NOW PROVE ONE, AND THAT IS THE CHANGE OF 2026-08-12. MEASURED:
 * `grep -rn runRepairCycle` found callers only in `arm.mjs`, which is that
 * function's own arm check — so `cycle.mjs`'s evidence bar (reproduce, prove,
 * replay independently, validate, record) was excellent, tested, and dead code,
 * while the real path built a proposal out of a hand-authored diff and handed it
 * straight to the gate. A candidate patch reached the gate having never been
 * watched failing or passing anything. The bar now runs BEFORE the proposal is
 * built, on an isolated copy of HEAD (`isolate.mjs`), and only an ACCEPTED verdict
 * reaches the gate; every other verdict is a named terminal outcome.
 *
 * AND THE BAR IS UNREACHABLE IN PRODUCTION TODAY, WHICH IS THE REST OF THE HONEST
 * PART. MEASURED 2026-08-12 against `dashboard/server/src/defect-record.ts`: a
 * `DefectRecord` carries runId, at, phase, failureClass, bakeoffCode, signature,
 * violations, attempts, artefacts, repairable, status, site, fieldPaths, three
 * availability flags and `failureReason` — and NO reproduction command. All 7
 * `results/defect.json` files under `dashboard/runs` were grepped for `command`:
 * zero hits. So every real ticket now stops at `NO_REPRODUCTION_COMMAND` until
 * something writes a `reproduction` block at the throw site (see
 * {@link readReproduction}). A guessed reproduction command is a guessed defect,
 * and `failureReason` is prose that nothing in this program may parse; so the
 * refusal is the honest state of the pipeline rather than a gap a default fills.
 *
 * THE REACHABLE CEILING ON A MACHINE WITH NO DOCKER IS THEREFORE REFUSED OR
 * PARKED, NEVER APPLIED — and that is by construction, not by accident: the
 * gate's container arms are how an inside-closure patch satisfies its four
 * proofs, and `proofsFor` counts only container-mode evidence.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frozenClosure } from "../tier3/closure.mjs";
import { runRepairCycle } from "./cycle.mjs";
import { countHunks, filesInDiff } from "./diff.mjs";
import { proposalFingerprint } from "./evidence.mjs";
import { isolateRepairRoot } from "./isolate.mjs";
import { evaluateAttempts, shouldEscalate } from "./loop-guard.mjs";
import { openLedger } from "./ruled-out.mjs";
import { applyGatedPatch, armCheck as armGateSeam, classifyGateRecord } from "./supervisor-gate.mjs";

/** Where the supervisor looks for a hand-authored candidate diff. */
export const DEFAULT_PROPOSALS_DIR = "dashboard/data/repair-proposals";
/** Where a rollback record is written so an applied patch can be undone unattended. */
export const DEFAULT_ROLLBACK_DIR = "dashboard/data/repair-rollback";
/**
 * How long one gate cycle may run before it is killed. A bound, not a hope.
 *
 * IT IS STRICTLY SHORTER THAN THE SUPERVISOR'S OUTER CLOCK, AND THAT ORDERING IS
 * THE WHOLE POINT OF THE NUMBER.
 *
 * `REPAIR_CYCLE_TIMEOUT_MS` in `dashboard/server/src/supervisor-boot.ts` is ten
 * minutes and it starts FIRST, because it times this whole process. Both clocks
 * used to be ten minutes, so a hanging gate was always killed from the OUTSIDE
 * first — and `spawnSync` signals the child only, with no `detached: true` and no
 * process-group kill on either path, so the gate was ORPHANED every time: the
 * supervisor filed REPAIR_CYCLE_TIMED_OUT, moved to the next ticket, and an
 * unparented `gate.mjs` carried on writing `dashboard/data/tier3` (and, with
 * docker present, holding containers) for up to another ten minutes.
 *
 * Eight minutes means the INNER clock fires first, inside the process that is the
 * gate's real parent and can therefore see it die, and the outer kill becomes the
 * fail-safe rather than the normal path. It does NOT reap a grandchild of the
 * gate; that needs an async spawn plus `process.kill(-pid)` and is carried
 * forward. `supervisor-cycle.test.mjs` asserts the inequality against the number
 * read out of `supervisor-boot.ts`, so closing the gap again is a RED test rather
 * than a silent return to orphaning.
 */
export const GATE_TIMEOUT_MS = 8 * 60 * 1_000;

/**
 * THE EVIDENCE BAR'S SHARE OF THE SAME TEN MINUTES, AND THE ARITHMETIC THAT MAKES
 * IT A BOUND RATHER THAN A HOPE.
 *
 * The bar now runs INSIDE the same awaited tick as the gate, so the two clocks add
 * up and the sum is what has to fit:
 *
 *   PROVE_BUDGET_MS   60_000    isolation + every command run the bar makes
 * + GATE_TIMEOUT_MS  480_000    the spawned Tier 3 gate
 * = 540_000 < REPAIR_CYCLE_TIMEOUT_MS (600_000, supervisor-boot.ts)
 *
 * with 60s left over — the same margin the gate/supervisor inequality already
 * keeps, and for the same reason: a stage killed one millisecond before its parent
 * has had no time to write its row. `supervisor-cycle.test.mjs` asserts the whole
 * inequality against the number read out of `supervisor-boot.ts`, so closing the
 * gap is a RED test rather than a silent return to the queue stopping on a hang.
 *
 * `runRepairCycle` HAS NO OVERALL CLOCK — it takes a PER-COMMAND `timeoutMs` and
 * this file does not own it — so the budget is enforced by division, and the
 * division has to be bounded by construction: the prover runs the command 3 times
 * (red, green, mutant), once more per hunk on a multi-hunk diff, and the replay
 * runs every recorded case twice. Both of those terms come from INPUTS, so a
 * 50-hunk diff would drive the per-command share to the floor and the total to
 * 250s. Hence {@link MAX_PROVED_RUNS}: a diff needing more runs than the budget
 * pays for at the floor is refused BEFORE anything is spent, by name.
 */
export const PROVE_BUDGET_MS = 60 * 1_000;

/**
 * The shortest per-command timeout the bar will impose. Below this the bound stops
 * measuring the defect and starts measuring process start-up: `node --test` on one
 * file in this repository takes ~6s, so a 1s share would report every reproduction
 * as a timeout — RED for a reason that has nothing to do with the patch.
 */
export const MIN_COMMAND_TIMEOUT_MS = 5 * 1_000;

/** 60_000 / 5_000. The most command runs one bar cycle may pay for. */
export const MAX_PROVED_RUNS = Math.floor(PROVE_BUDGET_MS / MIN_COMMAND_TIMEOUT_MS);

const HEX = /^[a-f0-9]{8,128}$/i;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * THE BAR VERDICTS THAT ARE A JUDGEMENT ON THE IDEA rather than on the copy.
 *
 * `cycle.mjs` returns the prover's outcome name as its verdict. These four mean
 * "the experiment ran and the patch did not survive it"; `COULD_NOT_REPRODUCE`,
 * `PATCH_DID_NOT_APPLY` and `MUTANT_NOT_CONSTRUCTIBLE` mean "the experiment could
 * not be staged on this copy", which is a different sentence and a different
 * `kind`. Neither set writes a fingerprint — see THE BAR NEVER BLACKLISTS below.
 */
const BAR_REFUSING_VERDICTS = Object.freeze(["REFUSED", "NOT_FIXED", "MUTATION_SURVIVED", "UNPROVEN_HUNKS"]);

/**
 * THE DECISION, PURE, WHICH IS WHY THE ARM CHECK CAN DRIVE IT.
 *
 * Every input is a value: the parsed record, the diff text (or null), the
 * fingerprints the ledger already knows, the anti-loop reading, and — on the
 * second pass — the gate's classified record. No file is read here and no clock
 * is consulted, so the arm check below can feed it inputs whose answers are
 * written in this source. That is the only kind of arm check that can run at
 * start-up without writing fake rows into the owner's data.
 *
 * THE ORDER OF THE ARMS IS THE POLICY:
 *
 *   1. THE WINDOW FIRST. A cycle that starts after its own deadline has passed
 *      spends a gate run the ticket cannot use — the supervisor is about to
 *      terminate it either way.
 *   2. THE ANTI-LOOP GUARD SECOND, BEFORE ANY SPEND. §3.4 / RESEARCH R4: a
 *      sequence that repeats or oscillates escalates IMMEDIATELY. Run a913c871
 *      never exceeded its budget and still went nowhere, so this arm is
 *      signature comparison and never a count.
 *   3. NO PATCH AUTHOR, then the LEDGER, then THE EVIDENCE BAR, then THE GATE —
 *      cheapest refusal first, and the two expensive steps last, in cost order.
 *      THE BAR IS BEFORE THE GATE AND NOT BESIDE IT: the gate grades a proposal's
 *      authority to land, and it cannot see whether the diff ever fixed anything,
 *      so a diff that reached it unproved was being asked the wrong question.
 *
 * @param {{defect: unknown, diff: string|null, diffPath: string,
 *          ruledOutFingerprints: readonly string[], loop?: object|null,
 *          deadlinePassed?: boolean, bar?: object|null, gate?: object|null}} input
 * @returns {{kind: "applied"|"refused"|"inconclusive", code: string, detail: string,
 *            ledgerVerdict: string|null, fingerprint: string|null, stage: string}}
 */
export function decideRepairOutcome(input) {
  const defect = input.defect;
  if (typeof defect !== "object" || defect === null) {
    return {
      kind: "inconclusive",
      code: "NO_DEFECT_RECORD",
      detail:
        "there is no readable defect record for this run, so there is nothing to attribute a repair to. " +
        "The record is written by orchestrator.ts at every terminal transition to results/defect.json.",
      ledgerVerdict: null,
      fingerprint: null,
      stage: "record",
    };
  }
  const signature = defect.signature;
  if (typeof signature !== "string" || !HEX.test(signature)) {
    return {
      kind: "inconclusive",
      code: "NO_DEFECT_SIGNATURE",
      detail:
        `the defect record carries no hex signature (${JSON.stringify(signature)}), so it cannot be attributed, ` +
        "de-duplicated or ruled out. The ledger is content-addressed by that digest and refuses anything else.",
      ledgerVerdict: null,
      fingerprint: null,
      stage: "record",
    };
  }

  if (input.deadlinePassed === true) {
    return {
      kind: "inconclusive",
      code: "REPAIR_WINDOW_CLOSED",
      detail:
        `the repair window for defect ${signature} had already closed when this cycle started, so no gate run was ` +
        "spent on a ticket the supervisor is about to terminate anyway. The wall clock bounds the cycle as well as " +
        "the ticket, because one hanging cycle inside an awaited tick stops the whole queue.",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      fingerprint: null,
      stage: "window",
    };
  }

  /*
   * THE ANTI-LOOP ARM. `loop` is `evaluateAttempts`' verdict, and the escalating
   * arms are IDENTICAL / OSCILLATION / NON_MONOTONE / BLIND — repetition and
   * oscillation, not a counter. a913c871 spent 3 of 3 attempts, never exceeded
   * its budget, and oscillated back to attempt 1's defect at attempt 3: a counter
   * reports "healthy" for that whole sequence.
   *
   * BLIND IS AN ESCALATION AND NOT A PASS, and it is the arm that fires most on
   * real records: `DefectAttempt.problems` is PROSE, `attemptPaths` returns null
   * for prose, and `signature.mjs` refuses to regex a field name out of a
   * sentence because that is the mechanism that died on 2026-08-04. So a record
   * with two prose attempts escalates with that named reason instead of being
   * guessed at.
   */
  const loop = input.loop ?? null;
  if (loop !== null && shouldEscalate(loop)) {
    return {
      kind: "refused",
      code: `ANTI_LOOP_${String(loop.arm)}`,
      detail:
        `the attempt sequence for defect ${signature} is not converging: ${String(loop.why)} (first escalating ` +
        `transition at attempt ${String(loop.escalateAtAttempt)} of ${String(loop.attempts)}, arm ${String(loop.arm)}). ` +
        "This is signature comparison and not a budget — a913c871 never exceeded its budget and still went nowhere, " +
        "so no gate run is spent here and the defect escalates to a human.",
      ledgerVerdict: "ESCALATED",
      // NULL, DELIBERATELY. This escalation is about the SEQUENCE, not about any
      // one proposal, and a fingerprint written here would rule out a diff that
      // was never graded — the ledger's `ruledOutFingerprints` treats every
      // non-ACCEPTED row carrying a fingerprint as ruled out.
      fingerprint: null,
      stage: "anti-loop",
    };
  }

  if (input.diff === null || input.diff.trim() === "") {
    return {
      kind: "inconclusive",
      code: "NO_PATCH_AUTHOR",
      detail:
        `no candidate diff exists at ${input.diffPath}, and nothing in this build authors one — design §5.3 ` +
        "records that the patch author is deliberately not built, because a component that both writes a patch " +
        "and grades it is the shape this repository keeps catching itself in. Write a diff to that path (or run " +
        "tools/repair/cycle.mjs against an isolated copy by hand) and re-enqueue the ticket.",
      ledgerVerdict: "NO_PATCH_AUTHOR",
      fingerprint: null,
      stage: "author",
    };
  }

  const fingerprint = proposalFingerprint({ diff: input.diff });
  if (input.ruledOutFingerprints.includes(fingerprint)) {
    return {
      kind: "refused",
      code: "ALREADY_RULED_OUT",
      detail:
        `proposal ${fingerprint} was already tried against defect ${signature} and did not clear it, so it is ` +
        "refused on sight rather than re-proved. This is the a913c871 shape at the repair level: attempt 3 " +
        "re-proposed attempt 1's answer because nothing on disk said it had failed.",
      ledgerVerdict: "REFUSED",
      fingerprint,
      stage: "ledger",
    };
  }

  /*
   * THE EVIDENCE BAR STAGE, AND IT IS SHAPED EXACTLY LIKE THE GATE STAGE BELOW.
   * On the first pass `bar` is absent and the caller's job is to see
   * `stage: "bar"` and go and run it; on the second pass the bar's classified
   * answer is here. A caller that never runs the bar gets `NO_EVIDENCE_BAR_ANSWER`
   * — `inconclusive`, never a pass, for the same reason `NO_GATE_ANSWER` is.
   *
   * THE BAR NEVER BLACKLISTS: every outcome on this arm carries
   * `fingerprint: null`, including the four that are a judgement on the idea.
   * The copy the bar proves on is `git archive HEAD`, so a `NOT_FIXED` produced by
   * a copy that could not run the command at all is byte-indistinguishable from a
   * `NOT_FIXED` produced by a patch that does not work. That confounding is
   * NARROWER than it was — since 2026-08-12 `isolate.mjs` provisions
   * `bakeoff/node_modules` (57 MB, cloned in 0.285s) and REFUSES with
   * COPY_NOT_BUILDABLE before running anything if the copy will not compile — but
   * it is not gone: `dashboard/node_modules` (476 MB) and
   * `dashboard/server/node_modules` (619 MB) are still absent, and the copy is
   * still HEAD rather than the working tree. The only discriminator for what is
   * left is a prose match on the transcript, which is the mechanism that died on
   * 2026-08-04. A permanent, content-addressed
   * blacklist keyed on a confounded signal is this file's own arm-check warning
   * one stage earlier: "one drift in the token inputs would blacklist every
   * gate-approved patch for ever". Re-proving costs one bar cycle (bounded at
   * 60s), the ticket is bounded at SUPERVISOR_REPAIR_MAX_PER_SIGNATURE cycles, and
   * the gate stage below still rules a genuinely refused proposal out.
   */
  const bar = input.bar ?? null;
  if (bar === null) {
    return {
      kind: "inconclusive",
      code: "NO_EVIDENCE_BAR_ANSWER",
      detail:
        `a candidate diff for defect ${signature} exists at ${input.diffPath} (fingerprint ${fingerprint}) and no ` +
        "evidence bar result accompanies it, so nothing has watched it reproduce the defect, fix it, or fail again " +
        "under a revert of the fix. The gate cannot answer that question — it grades a proposal's authority to land, " +
        "not whether the patch works — so a diff that reached it here would be graded on nobody's evidence.",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      fingerprint: null,
      stage: "bar",
    };
  }
  if (bar.ok !== true) {
    /*
     * A BAR ANSWER WITH NO CODE IS ITSELF NAMED. `bar` is a seam, and an answer
     * missing its code would put `undefined` in the ledger row and reach the
     * ticket as `NO_CODE` — a refusal nobody can act on, which is the same defect
     * as no refusal at all. `inconclusive` is the conservative direction here: an
     * answer this file cannot read must never read as a graded patch.
     */
    const named = typeof bar.code === "string" && bar.code.trim() !== "";
    return {
      kind: named && bar.kind === "refused" ? "refused" : "inconclusive",
      code: named ? bar.code : "BAR_UNREADABLE",
      detail:
        typeof bar.detail === "string" && bar.detail.trim() !== ""
          ? bar.detail
          : "the evidence bar answered without a code or a sentence, so nothing is known about this diff beyond the " +
            "fact that it was not accepted. The proposal is not ruled out.",
      ledgerVerdict: typeof bar.ledgerVerdict === "string" && bar.ledgerVerdict !== "" ? bar.ledgerVerdict : "COULD_NOT_REPRODUCE",
      fingerprint: null,
      stage: "bar",
    };
  }

  /*
   * THE GATE STAGE. On the FIRST pass `gate` is absent — the caller's job is to
   * see `stage: "gate"` and go and run the gate. On the second pass the gate's
   * classified record is here and it is the answer. A caller that never runs the
   * gate therefore gets `NO_GATE_ANSWER`, which is `inconclusive`: an ungraded
   * patch must never read as an applied one.
   */
  const gate = input.gate ?? null;
  if (gate === null) {
    return {
      kind: "inconclusive",
      code: "NO_GATE_ANSWER",
      detail:
        `a candidate diff for defect ${signature} exists at ${input.diffPath} (fingerprint ${fingerprint}) and no ` +
        "Tier 3 gate decision accompanies it, so nothing has graded it. The gate decides whether a patch lands; " +
        "a cycle that could answer 'applied' without one would be the bug this seam exists to prevent.",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      fingerprint,
      stage: "gate",
    };
  }

  return {
    kind: gate.intent === "APPLY" ? "applied" : gate.intent === "REFUSE" ? "refused" : "inconclusive",
    code: gate.code,
    detail: gate.detail,
    ledgerVerdict: gate.ledgerVerdict,
    // The gate's PARK outcomes deliberately do not rule the proposal out: a patch
    // parked for want of docker is not a patch that failed, and writing its
    // fingerprint here would refuse it for ever on a machine that later has
    // docker. `ledgerFingerprint` is the gate seam's own answer to that.
    fingerprint: gate.ledgerFingerprint === "proposal" ? fingerprint : null,
    stage: "gate",
  };
}

/**
 * THE REPRODUCTION COMMAND, READ FROM THE DEFECT RECORD — WHICH DOES NOT CARRY ONE.
 *
 * MEASURED 2026-08-12. `dashboard/server/src/defect-record.ts` defines every field
 * a `results/defect.json` has, and the list is: runId, at, phase, failureClass,
 * bakeoffCode, signature, violations, attempts, artefacts, repairable, status,
 * site, fieldPaths, violationsAvailable, attemptsAvailable, unavailable,
 * failureReason. All 7 records under `dashboard/runs` grep clean for `command`.
 * THERE IS NO REPRODUCTION COMMAND ANYWHERE IN THE RECORD, so this function's
 * production answer today is `NO_REPRODUCTION_COMMAND`, on every ticket.
 *
 * AND NOTHING IS GUESSED IN ITS PLACE. `failureReason` is carried verbatim for a
 * human and `defect-record.ts` states in its own header that nothing in the
 * program parses it — the 2026-08-04 death by prose-matching is named there and in
 * `signature.mjs`. `artefacts` are paths, not commands. A command derived from a
 * failure class would be this file inventing the experiment whose result it then
 * reports, which is the shape the whole repair lane is built to refuse.
 *
 * SO THIS READS A STRUCTURED EXTENSION WITH NO PRODUCER YET, AND SAYS SO:
 *
 *   "reproduction": {
 *     "command": "node --test bakeoff/src/spec-validate.test.ts",
 *     "cases": [ { "name": "…", "command": "…", "targeted": true }, … ]
 *   }
 *
 * written by the side that OBSERVED the failure (`orchestrator.ts`, at the throw
 * site, where the command that failed is a value and not an inference), never by
 * the side that authors the patch. `defect-record.ts` is owned by another worker
 * this round and is read-only here, so nothing shipped in this change can populate
 * it; the extension point exists so that the ACCEPT arm of the bar is reachable
 * and provable by execution rather than being a path no test ever takes.
 *
 * THE REPLAY CASES ARE REQUIRED HERE, BEFORE THE PROVER SPENDS ANYTHING, for the
 * reason `cycle.mjs` gives for demanding the frozen closure at entry:
 * `validateProposal` refuses `NO_INDEPENDENT_CHECK` at the END of the cycle, by
 * which time the reproduction has been run three times for an answer that was
 * knowable from the record. `independentReplay` also refuses a case list with no
 * UNRELATED case ("[] because nothing was damaged" is byte-identical to "[]
 * because nothing was executed"), and that is checked here too — the same
 * question, asked where it costs nothing.
 */
export function readReproduction(defect) {
  const block = typeof defect?.reproduction === "object" && defect?.reproduction !== null ? defect.reproduction : null;
  const command = typeof block?.command === "string" ? block.command.trim() : "";
  if (command === "") {
    return {
      ok: false,
      code: "NO_REPRODUCTION_COMMAND",
      detail:
        "the defect record carries no `reproduction.command`, so there is no way to watch this defect fail — and a " +
        "repair for a defect nobody reproduced is a guess, which is the one thing the evidence bar exists to refuse. " +
        "Measured 2026-08-12: DefectRecord (dashboard/server/src/defect-record.ts) has no such field at all, and none " +
        "of the 7 records under dashboard/runs carries one. `failureReason` is prose and nothing here may parse it. " +
        "The record writer has to record the command at the throw site before any candidate diff can be proved.",
    };
  }
  const cases = (Array.isArray(block.cases) ? block.cases : [])
    .filter((c) => typeof c?.command === "string" && c.command.trim() !== "")
    .map((c, i) => ({
      name: typeof c.name === "string" && c.name.trim() !== "" ? c.name.trim() : `case-${i + 1}`,
      command: c.command.trim(),
      targeted: c.targeted === true,
    }));
  if (cases.length === 0 || !cases.some((c) => c.targeted !== true)) {
    return {
      ok: false,
      code: "NO_RECORDED_REPLAY_CASES",
      detail:
        `the defect record names a reproduction command (${command}) and no independent replay case, so the bar could ` +
        "only ever refuse this diff with NO_INDEPENDENT_CHECK after running the reproduction three times. A mutation " +
        "proof is a vacuity control, not a correctness control: without a recorded UNRELATED case, `unrelatedChanged: " +
        "[]` means nothing was executed rather than nothing was damaged. `reproduction.cases` needs at least one entry " +
        `with targeted !== true (it currently has ${cases.length}, none unrelated).`,
    };
  }
  return { ok: true, command, cases };
}

/**
 * WHAT ONE `runRepairCycle` VERDICT MEANS FOR THE TICKET.
 *
 * ACCEPTED is the ONLY answer that lets the gate be spawned. Everything else is a
 * named terminal outcome, split by whether the experiment ran:
 *
 *   refused        the bar staged the experiment and the patch did not survive it
 *   inconclusive   the copy could not stage the experiment at all
 *
 * The split is not cosmetic — the supervisor's router branches on `kind`, and
 * telling the owner "your patch does not fix this" when the truth is "the copy
 * could not run your command" is the failure this file's ledger row would then
 * make permanent. Neither side writes a fingerprint; see THE BAR NEVER BLACKLISTS.
 */
export function classifyBarResult(result) {
  const verdict = typeof result?.verdict === "string" && result.verdict.trim() !== "" ? result.verdict.trim() : "NO_VERDICT";
  const reasons = (result?.reasons ?? [])
    .map((r) => `[${String(r?.code)}] ${String(r?.detail ?? "").trim()}`)
    .join("; ");
  if (verdict === "ACCEPTED") {
    return {
      ok: true,
      code: "BAR_ACCEPTED",
      kind: null,
      ledgerVerdict: null,
      detail:
        "the evidence bar accepted this diff on an isolated copy: the recorded command failed before it, passed with " +
        "it, failed again under a revert of the fix, and the recorded unrelated cases did not move.",
      proposal: result?.proposal ?? null,
    };
  }
  const refusing = BAR_REFUSING_VERDICTS.includes(verdict);
  const known = refusing || ["COULD_NOT_REPRODUCE", "PATCH_DID_NOT_APPLY", "MUTANT_NOT_CONSTRUCTIBLE"].includes(verdict);
  return {
    ok: false,
    code: `BAR_${verdict}`,
    kind: refusing ? "refused" : "inconclusive",
    // An unrecognised verdict is filed as COULD_NOT_REPRODUCE rather than under its
    // own word: the ledger's vocabulary is read back by `ruledOutFingerprints` and
    // a verdict name nothing else knows is a row nobody can act on.
    ledgerVerdict: known ? verdict : "COULD_NOT_REPRODUCE",
    detail:
      (refusing
        ? `the evidence bar refused this diff on an isolated copy of HEAD: ${verdict}.`
        : `the evidence bar could not stage the experiment on an isolated copy of HEAD: ${verdict}.`) +
      (reasons === "" ? "" : ` ${reasons}`) +
      " No fingerprint is written for a bar outcome, so the proposal is still proposable: the copy is HEAD rather " +
      "than the working tree, it carries only the dependencies isolate.mjs provisions, and a patch that cannot be " +
      "run is indistinguishable here from a patch that does not work.",
    proposal: null,
  };
}

/* =========================================================================
 * THE IO HALF
 * ====================================================================== */

/**
 * RUN THE EVIDENCE BAR ON AN ISOLATED COPY, AND RETURN A VALUE ON EVERY PATH.
 *
 * ─── WHY THE COPY, RESTATED WHERE THE CALL IS ───
 *
 * `prover.mjs#assertSandbox` THROWS for any path inside this repository. That
 * refusal is why this call was never wired: proving a repair applies the diff,
 * runs the reproduction, reverts the fix hunk and runs it again, and on the
 * owner's live tree — with a second worker mid-edit in `bakeoff/src` — that is a
 * corrupted workspace. `isolate.mjs` builds the copy from `git archive HEAD`
 * (measured 0.196s, 23 MB, 686 files) and its docblock carries the comparison
 * against `git worktree add` and against copying the 2.9 GB working tree.
 *
 * ─── AND IT NOW ARRIVES ABLE TO COMPILE, OR IT IS REFUSED BEFORE ANYTHING RUNS ───
 *
 * `isolate.mjs` clones `bakeoff/node_modules` into the copy (measured 2026-08-12:
 * 0.30s and 1.9 MB of real disk for a 57 MB tree, `cp -c` copy-on-write) and then
 * runs `tsc --noEmit` once to find out whether the result compiles — 1.01s for the
 * probe and 1454-1481ms for the whole isolate over three runs, against the 60s
 * {@link PROVE_BUDGET_MS} the bar then divides between its command runs, which for
 * a one-hunk diff with two replay cases is 7 runs at an 8.4s share. The probe emits
 * nothing, deliberately: a
 * `bakeoff/dist` left behind by isolation would be HEAD's, and a reproduction whose
 * own build step failed would silently read it. See COPY_NOT_BUILDABLE below.
 *
 * ─── THE CYCLE GETS A THROWAWAY LEDGER, AND THAT IS NOT AN OVERSIGHT ───
 *
 * `runRepairCycle` appends a row for every verdict it reaches, carrying the
 * proposal fingerprint. `ruled-out.mjs#ruledOutFingerprints` treats EVERY
 * non-ACCEPTED row that carries a fingerprint as ruled out, so pointing the cycle
 * at the supervisor's real ledger would permanently blacklist a diff the moment
 * the isolated copy failed to run its command — the confounded-signal blacklist
 * this file refuses one arm up. So the cycle writes into a temporary directory
 * that is deleted with the copy, and the ONE authoritative row is the one
 * `runSupervisorCycle` writes at the end, from a decision that has been through
 * `decideRepairOutcome`. The cost is that the cycle's own ALREADY_RULED_OUT arm
 * never fires against an empty ledger — which is correct here, because the real
 * ledger was already consulted, before this function was called at all.
 *
 * @param {{defect: object, diff: string, repoRoot?: string, log?: (line: string) => void}} input
 */
export function runEvidenceBar(input) {
  const startedAt = Date.now();
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const nowhere = (code, detail) => ({ ok: false, code, kind: "inconclusive", ledgerVerdict: "COULD_NOT_REPRODUCE", detail, isolatedRoot: null });

  const repro = readReproduction(input.defect);
  if (!repro.ok) return nowhere(repro.code, repro.detail);

  /*
   * THE CLOSURE COMES FROM `REPO_ROOT`, NOT FROM THE COPY. It is a property of
   * THIS repository — the §6.1 partition of the grader the supervisor repairs —
   * and the copy is a copy of it, so the two agree by construction; reading it
   * from the copy would only add a way for a truncated copy to produce an empty
   * list, and an empty list is what `evidence.mjs` documents as refusing nothing
   * and reporting a clean ACCEPT. Absence is checked here rather than left to
   * `cycle.mjs`, which would report it as a REFUSED verdict — the wrong `kind` for
   * an environment fault, and the wrong sentence for the owner.
   */
  let closure = [];
  try {
    const partition = frozenClosure(REPO_ROOT);
    closure = [...partition.grader, ...partition.controls];
  } catch (error) {
    return nowhere(
      "NO_FROZEN_CLOSURE",
      `the frozen closure could not be computed from ${REPO_ROOT}, so the owner-only check would refuse nothing and ` +
        `report a clean ACCEPT: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (closure.length === 0) {
    return nowhere(
      "NO_FROZEN_CLOSURE",
      `the frozen closure computed from ${REPO_ROOT} is EMPTY, so the owner-only check would refuse nothing and report ` +
        "a clean ACCEPT. Absence is treated exactly like failure: nothing is proved against a partition that says " +
        "nothing is frozen.",
    );
  }

  /*
   * THE BUDGET, SPENT BEFORE IT IS SPENT. See {@link PROVE_BUDGET_MS}: the prover
   * runs the command three times, once more per hunk on a multi-hunk diff, and
   * the replay runs every case twice. Both terms are inputs, so the arithmetic is
   * checked against the floor BEFORE the copy is built — a diff nobody can afford
   * to prove is refused for free rather than after 23 MB and four minutes.
   *
   * THIS ARM CANNOT FIRE ON A REAL TICKET TODAY, said next to the test that drives
   * it so nobody reads a tested bound as an observed one: both terms come from the
   * `reproduction` block, and nothing writes one (see {@link readReproduction}).
   * It is a bound placed before the capability it bounds.
   */
  let hunks = 0;
  try {
    hunks = countHunks(input.diff);
  } catch (error) {
    /*
     * MEASURED 2026-08-12 with a probe: `countHunks("--- a/x\n+++ b/x\n@@ bad @@\n")`
     * THROWS ("unified diff: file x has no hunks"), and this is the first thing the
     * bar asks of the diff — so a malformed candidate would have left this function
     * by exception, past its own `finally`, into a supervisor tick. A diff that
     * cannot be parsed is the author's to fix and costs nothing to name here; the
     * gate's own proposal check would refuse it too, four minutes later.
     */
    return nowhere(
      "DIFF_UNPARSEABLE",
      `the candidate diff could not be parsed as a unified diff, so nothing was copied and nothing was run: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const runs = 3 + (hunks > 1 ? hunks : 0) + 2 * repro.cases.length;
  if (runs > MAX_PROVED_RUNS) {
    return nowhere(
      "PROOF_BUDGET_EXCEEDED",
      `proving this diff needs ${runs} command runs (3 + ${hunks > 1 ? `${hunks} hunks` : "0 hunks"} + 2 × ` +
        `${repro.cases.length} replay cases) and the ${PROVE_BUDGET_MS}ms budget pays for at most ${MAX_PROVED_RUNS} at ` +
        `the ${MIN_COMMAND_TIMEOUT_MS}ms floor. The bar runs inside the same supervisor tick as the gate, so an ` +
        "unbounded proof stops every subsequent tick. Split the diff, or record fewer replay cases.",
    );
  }

  const iso = isolateRepairRoot({ repoRoot });
  if (!iso.ok) {
    return {
      ok: false,
      code: "ISOLATION_FAILED",
      kind: "inconclusive",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      detail:
        `no isolated copy of ${repoRoot} could be built, so nothing was proved and nothing was run against the ` +
        `owner's tree — the prover refuses to operate inside the repository by design (${iso.code}): ${iso.detail}`,
      isolatedRoot: iso.root,
    };
  }

  /*
   * A COPY THAT CANNOT COMPILE IS ITS OWN OUTCOME, AND THE REPRODUCTION IS NEVER
   * RUN ON IT.
   *
   * THE HAZARD, EXACTLY. Every reproduction for a suite-authoring defect has to
   * build the package before it can observe anything (`defect-record.ts`:
   * `DefectReproduction`), so its command starts with `tsc`. If that build fails —
   * no dependencies provisioned, no compiler, a copy the extraction truncated —
   * the command exits non-zero BEFORE the patch and non-zero AFTER it, and
   * `proveRepair` reads the first as "the defect reproduced" and the second as
   * `NOT_FIXED`. A correct patch is then recorded as a patch that does not work,
   * which is the confounded red the whole bar exists to refuse. `isolate.mjs`
   * therefore compiles the copy once, with `--noEmit`, and reports the answer as a
   * value; this arm is the value being acted on.
   *
   * IT REFUSES EVEN A COMMAND THAT NEEDS NO BUILD, AND THAT IS THE COST, NAMED.
   * The price-lookup reproduction runs `node --input-type=module` against
   * `bakeoff/src/contracts.ts` and would survive a broken toolchain, so this arm
   * costs that class an inconclusive tick it did not have to spend. The
   * alternative is deciding per command whether it builds — which means reading
   * the command string for a `tsc`, a prose match on the one input the record
   * controls, and prose matching is the mechanism that died on 2026-08-04. An
   * inconclusive tick on a machine whose compiler is broken is the cheap error;
   * `NOT_FIXED` on a correct patch is the expensive one.
   *
   * `cleanup()` IS CALLED HERE. The ISOLATION_FAILED arm above does not need it —
   * `isolate.mjs`'s failing paths clean up after themselves — but this copy
   * SUCCEEDED, so it exists, it is ~80 MB with the provisioned dependencies, and
   * this return is outside the try/finally that removes it.
   *
   * AND IT CANNOT FIRE ON THIS MACHINE TODAY, SAID HERE SO NOBODY READS A TESTED
   * ARM AS AN OBSERVED ONE. `isolateRepairRoot({repoRoot: REPO_ROOT})` was run four
   * times against this repository and answered `buildable: true` (`BUILDS`) every
   * time. It is a bound placed before the capability it bounds, exactly like
   * {@link PROOF_BUDGET_EXCEEDED} above. What DOES reach it: a checkout where
   * `cd bakeoff && npm install` has never been run (DEPENDENCIES_NOT_INSTALLED), a
   * scratch directory on a volume where both `cp -c` and `cp -R` fail
   * (PROVISION_FAILED), an extraction that dropped the package (TRUNCATED_COPY),
   * and a HEAD that does not type-check (BUILD_FAILED) — which is the one a
   * concurrent worker can produce at any time, since `bakeoff/src` is where this
   * repository's defects live.
   */
  if (iso.buildable !== true) {
    iso.cleanup();
    return {
      ok: false,
      code: "COPY_NOT_BUILDABLE",
      kind: "inconclusive",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      detail:
        `an isolated copy of ${repoRoot} was built at ${iso.root} but it cannot compile, so the reproduction was NOT ` +
        `run on it (${iso.build?.code ?? "NO_BUILD_ANSWER"}): ${iso.build?.detail ?? "the copy reported no build result at all"} ` +
        "A reproduction whose own build step fails is red before the patch and red after it, and the bar would file a " +
        "correct patch as NOT_FIXED. No fingerprint is written: this is a fact about the machine, not about the diff.",
      isolatedRoot: iso.root,
    };
  }

  const ledgerDir = mkdtempSync(join(tmpdir(), "supervisor-cycle-bar-ledger-"));
  const perCommandMs = Math.max(MIN_COMMAND_TIMEOUT_MS, Math.floor(Math.max(0, PROVE_BUDGET_MS - iso.elapsedMs) / runs));
  try {
    const result = runRepairCycle({
      defect: input.defect,
      candidateDiff: input.diff,
      root: iso.root,
      command: repro.command,
      replayCases: repro.cases,
      ledgerDir,
      frozenClosure: closure,
      timeoutMs: perCommandMs,
      /*
       * THE BAR'S OWN LINES GO TO STDERR. `cycle.mjs` logs to stdout by default and
       * the supervisor PARSES this process's stdout for exactly one JSON line, so
       * the default would have made every proved cycle unreadable to the driver
       * (`REPAIR_CYCLE_UNREADABLE`) — measured by spawning the CLI: one line out,
       * exit 0, the prover's lines on the other stream.
       *
       * WHERE THEY SURVIVE, EXACTLY. `createRepairDriver` (supervisor-boot.ts)
       * captures stderr and quotes it on `REPAIR_CYCLE_SILENT`, so a cycle that
       * printed no verdict carries its transcripts into the ticket. It does NOT on
       * the timeout path: `result.timedOut` is read BEFORE either stream, so a bar
       * cycle killed by the outer clock loses these lines entirely. That file is
       * another worker's this round; the gap is named here rather than claimed shut.
       */
      log: input.log ?? ((line) => process.stderr.write(line + "\n")),
    });
    const classified = classifyBarResult(result);
    return { ...classified, isolatedRoot: iso.root, verdict: result?.verdict ?? null, perCommandMs, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    /*
     * A THROW IN HERE IS A NAMED OUTCOME, NOT AN EXCEPTION IN A TICK. The bar runs
     * inside an awaited supervisor tick behind a re-entrancy flag; an exception
     * that escaped would lose the ticket and, worse, skip the `finally` that
     * removes the copy.
     */
    return {
      ok: false,
      code: "EVIDENCE_BAR_THREW",
      kind: "inconclusive",
      ledgerVerdict: "COULD_NOT_REPRODUCE",
      detail:
        `the evidence bar threw while proving this diff on ${iso.root}, so no verdict was reached and the proposal is ` +
        `not ruled out: ${error instanceof Error ? error.message : String(error)}`,
      isolatedRoot: iso.root,
    };
  } finally {
    // THE COPY IS REMOVED ON EVERY PATH. A bar cycle leaves an ACCEPTED tree
    // PATCHED by design (`cycle.mjs`: the applied root is the proof artefact), so
    // a leaked copy is both 23 MB and a patched tree nobody is tracking.
    iso.cleanup();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

/**
 * Spawn the real Tier 3 gate and return the record it wrote.
 *
 * SPAWNED, NEVER IMPORTED, AND THE REASON IS THE TRAIL. `runGate` builds a frozen
 * manifest, writes it, runs the known-bad registry and appends to an append-only
 * trail; importing it into this process would put those writes on the supervisor's
 * own stack, where a throw in the middle of a tick becomes a lost ticket. Spawning
 * makes the gate's failure a non-zero exit and a named outcome instead.
 *
 * IT IS TIMED OUT. `spawnSync`'s `timeout` is the per-cycle wall clock: the
 * supervisor awaits this call inside `tick()` behind a re-entrancy flag, so a
 * gate that hangs would stop every subsequent tick — the queue dying silently,
 * which is the exact failure the supervisor exists to end.
 */
export function spawnGate(input) {
  const gatePath = join(input.repoRoot ?? REPO_ROOT, "tools", "tier3", "gate.mjs");
  if (!existsSync(gatePath)) return { record: null, detail: `the Tier 3 gate is not present at ${gatePath}` };
  const res = spawnSync(
    process.execPath,
    [gatePath, "--proposal", input.proposalPath],
    {
      cwd: input.repoRoot ?? REPO_ROOT,
      encoding: "utf8",
      timeout: input.timeoutMs ?? GATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, TIER3_REPO_ROOT: input.repoRoot ?? REPO_ROOT },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const stdout = res.stdout ?? "";
  /*
   * THE RECORD IS READ FROM THE TRAIL FILE THE GATE WROTE, not from its stdout.
   * stdout carries a one-line VERDICT for a human; the trail carries the apply
   * token, the frozen manifest digest and the proof list — the three things the
   * token is minted over. Reading the verdict word off stdout and trusting it
   * would be exactly "the driver decided".
   */
  const trailLine = stdout.split("\n").find((l) => l.startsWith("TRAIL "));
  const trailPath = trailLine === undefined ? null : trailLine.slice("TRAIL ".length).trim();
  if (trailPath === null || trailPath.startsWith("REFUSED") || !existsSync(trailPath)) {
    return {
      record: null,
      detail:
        `the gate left no readable trail record (exit ${String(res.status)}${res.signal ? `, signal ${res.signal}` : ""}). ` +
        `stdout: ${stdout.trim().slice(-300) || "(empty)"} stderr: ${(res.stderr ?? "").trim().slice(-300) || "(empty)"}`,
    };
  }
  try {
    return { record: JSON.parse(readFileSync(trailPath, "utf8")), detail: `read from ${trailPath}`, trailPath };
  } catch (error) {
    return { record: null, detail: `the gate's trail at ${trailPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Build the proposal the gate grades.
 *
 * `filesChanged` IS RECOMPUTED FROM THE DIFF and `touchesFrozenClosure` is NOT
 * SET AT ALL. `tools/tier3/proposal.mjs` recomputes the blast radius from the
 * diff and refuses a proposal that under-reports it; a value asserted here would
 * be a second answer to a question the gate already answers, and the copy that
 * drifts is always the one guarding the accept path.
 *
 * THE EVIDENCE BUNDLE IS THE PROVER'S, AND ONLY FAILING THAT THE AUTHOR'S. Since
 * 2026-08-12 the gate is reached only through an ACCEPTED bar cycle, so the three
 * transcripts are the bytes real processes wrote on the isolated copy — RED before
 * the patch, GREEN after it, RED again under a revert of the fix. That is strictly
 * better than the hand-authored `<signature>.evidence.json` this used to pass
 * through, which is now only a fallback for a caller that injected its own bar.
 * Nothing here SYNTHESISES a bundle: a repair loop writing its own proof is the
 * shape the whole lane is built to refuse.
 */
export function buildProposal({ signature, diff, evidence, now }) {
  const proposal = {
    signature,
    diff,
    filesChanged: filesInDiff(diff),
    proposedAt: (now?.() ?? new Date()).toISOString(),
  };
  return evidence === null || evidence === undefined ? proposal : { ...proposal, evidence };
}

/**
 * The IO half: read the record, find the diff, ask the ledger, run the gate,
 * apply only on the gate's token, write the row.
 *
 * @param {{defectPath: string, ledgerDir: string, proposalsDir: string,
 *          rollbackDir?: string, repoRoot?: string, deadlineAt?: string|null,
 *          bar?: (input: object) => object, gate?: (input: object) => object,
 *          now?: () => Date, timeoutMs?: number}} input
 */
export function runSupervisorCycle(input) {
  const now = input.now ?? (() => new Date());
  let defect = null;
  if (existsSync(input.defectPath)) {
    try {
      defect = JSON.parse(readFileSync(input.defectPath, "utf8"));
    } catch {
      defect = null;
    }
  }
  const signature = typeof defect?.signature === "string" ? defect.signature : "";
  const diffPath = join(input.proposalsDir, `${signature === "" ? "unattributed" : signature}.diff`);
  const diff = existsSync(diffPath) ? readFileSync(diffPath, "utf8") : null;
  const evidencePath = `${diffPath.replace(/\.diff$/, "")}.evidence.json`;
  let evidence = null;
  if (existsSync(evidencePath)) {
    try {
      evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch {
      evidence = null;
    }
  }

  const ledger = openLedger(input.ledgerDir);
  const known = HEX.test(signature) ? ledger.ruledOutFingerprints(signature) : [];
  /*
   * THE ANTI-LOOP READING TRAVELS WITH THE CYCLE. `attempts` absent reads as
   * "no sequence to compare" and never as "converging": `evaluateAttempts([])`
   * produces no transitions and `shouldEscalate` is false, which is correct —
   * one attempt cannot repeat itself.
   */
  const loop = evaluateAttempts(defect?.attempts ?? [], {
    site: typeof defect?.failureClass === "string" ? defect.failureClass : "",
    bakeoffCode: defect?.bakeoffCode ?? null,
  });
  const deadlinePassed =
    typeof input.deadlineAt === "string" && input.deadlineAt !== ""
      ? new Date(input.deadlineAt).getTime() <= now().getTime()
      : false;

  const base = { defect, diff, diffPath, ruledOutFingerprints: known, loop, deadlinePassed };
  let decision = decideRepairOutcome({ ...base, bar: null, gate: null });

  /*
   * THE SECOND PASS — THE EVIDENCE BAR, AND IT IS WHAT THIS ROUND ADDED.
   *
   * Only a decision that reached the bar stage runs it, and only an ACCEPTED
   * verdict walks on to the gate. `input.bar` is a seam for the same reason
   * `input.gate` is: the real thing builds a 23 MB copy and runs a reproduction
   * three times, which no unit test may do per case. THE SEAM IS BOUNDED — a bar
   * that answers `ok` only buys a gate run. The gate still has to say APPLY with a
   * token that re-mints over this exact diff, and `applyGatedPatch` still refuses
   * any decision whose intent is not APPLY, so no injected bar can produce an
   * applied patch.
   */
  let barResult = null;
  if (decision.stage === "bar" && decision.code === "NO_EVIDENCE_BAR_ANSWER") {
    const runBar = input.bar ?? runEvidenceBar;
    try {
      barResult = runBar({ defect, diff, repoRoot: input.repoRoot ?? REPO_ROOT, signature, now });
    } catch (error) {
      // The bar's own catch handles a throw from the cycle; this one handles a
      // throw from the seam itself, so an injected bar cannot lose a ticket either.
      barResult = {
        ok: false,
        code: "EVIDENCE_BAR_THREW",
        kind: "inconclusive",
        ledgerVerdict: "COULD_NOT_REPRODUCE",
        detail: `the evidence bar could not be run: ${error instanceof Error ? error.message : String(error)}`,
        isolatedRoot: null,
      };
    }
    decision = decideRepairOutcome({ ...base, bar: barResult, gate: null });
    if (typeof barResult?.isolatedRoot === "string") decision = { ...decision, isolatedRoot: barResult.isolatedRoot };
  }

  /*
   * THE THIRD PASS. Only a decision that reached the gate stage runs the gate,
   * and the gate's own record — not this file's opinion of it — is what comes
   * back. `applied` is written on the row only after the tree really changed.
   */
  let applied = null;
  if (decision.stage === "gate" && decision.code === "NO_GATE_ANSWER") {
    /*
     * THE PROVED EVIDENCE WINS OVER THE HAND-AUTHORED SIDECAR. `barResult.proposal`
     * is `cycle.mjs`'s own RepairProposal and its `evidence` is three verbatim
     * transcripts from the isolated copy; the sidecar is whatever the author wrote.
     * When a caller injected a bar seam there is no proved bundle, and the sidecar
     * is what is left.
     */
    const provedEvidence = barResult?.proposal?.evidence ?? null;
    const proposal = buildProposal({ signature, diff, evidence: provedEvidence ?? evidence, now });
    const scratch = mkdtempSync(join(tmpdir(), "supervisor-cycle-proposal-"));
    let gateResult;
    try {
      const proposalPath = join(scratch, "proposal.json");
      writeFileSync(proposalPath, JSON.stringify(proposal, null, 2), "utf8");
      const runGate = input.gate ?? spawnGate;
      gateResult = runGate({
        repoRoot: input.repoRoot ?? REPO_ROOT,
        proposalPath,
        proposal,
        timeoutMs: input.timeoutMs ?? GATE_TIMEOUT_MS,
      });
    } catch (error) {
      gateResult = { record: null, detail: `the gate could not be run: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    const classified = classifyGateRecord({ record: gateResult?.record ?? null, diff });
    /*
     * `bar` TRAVELS INTO THE THIRD PASS. Without it this call falls back into the
     * bar arm and answers NO_EVIDENCE_BAR_ANSWER about a diff that just cleared it.
     * It cannot be null here by construction — reaching the gate stage at all
     * required `bar.ok === true` on the previous pass over the same `base`.
     */
    decision = decideRepairOutcome({ ...base, bar: barResult, gate: classified });
    if (typeof barResult?.isolatedRoot === "string") decision = { ...decision, isolatedRoot: barResult.isolatedRoot };
    if (gateResult?.record == null && typeof gateResult?.detail === "string" && gateResult.detail !== "") {
      decision = { ...decision, detail: `${decision.detail} The gate reported: ${gateResult.detail}` };
    }

    /*
     * THE WRITE, AND THE ONLY PLACE IT CAN HAPPEN. `applyGatedPatch` refuses any
     * decision whose intent is not APPLY, so a bug that let a PARK reach this
     * line still cannot patch the tree.
     */
    if (classified.intent === "APPLY") {
      applied = applyGatedPatch({
        root: input.repoRoot ?? REPO_ROOT,
        diff,
        decision: classified,
        signature,
        rollbackDir: input.rollbackDir ?? join(input.repoRoot ?? REPO_ROOT, DEFAULT_ROLLBACK_DIR),
        gateTrail: gateResult?.trailPath ?? null,
        now,
      });
      decision = applied.ok
        ? { ...decision, patchId: applied.patchId, rollbackPath: applied.rollbackPath, detail: `${decision.detail} ${applied.detail}` }
        : {
            /*
             * THE GATE SAID YES AND THE WRITE FAILED, so the ticket must NOT be
             * re-queued onto an unpatched tree believing it was patched. That is
             * `inconclusive`, with the write's own code, and the proposal is not
             * ruled out — the patch was never graded against a tree it fits.
             */
            ...decision,
            kind: "inconclusive",
            code: applied.code,
            detail: `${applied.detail} (the gate authorised this patch: ${decision.detail})`,
            ledgerVerdict: "COULD_NOT_REPRODUCE",
            fingerprint: null,
          };
    }
  }

  /*
   * THE ROW IS WRITTEN BEFORE THE ANSWER IS PRINTED, and only when there is a
   * signature to address it to. A ledger keyed by a digest cannot record a defect
   * that has no digest, and inventing a bucket for it would put unattributable
   * rows in the same namespace as the addressable ones.
   */
  if (decision.ledgerVerdict !== null && HEX.test(signature)) {
    /*
     * `filesInDiff` THROWS ON A MALFORMED DIFF, AND THIS LINE USED TO BE OUTSIDE
     * ANY CATCH. MEASURED 2026-08-12, by the DIFF_UNPARSEABLE test one lane down:
     * a candidate `@@ not a hunk header @@` reached here and `parseUnifiedDiff`
     * threw "unified diff: file src/thing.mjs has no hunks" — losing the decision,
     * the row, and the JSON line, and handing the supervisor an exception instead
     * of an outcome. The row is what makes a refusal visible, so it must survive a
     * diff nobody can parse; `[]` is not a claim that nothing changed, because the
     * reason on the same row names the code and says the diff is unreadable.
     */
    let filesChanged = [];
    try {
      filesChanged = diff === null ? [] : filesInDiff(diff);
    } catch {
      filesChanged = [];
    }
    ledger.append({
      signature,
      verdict: decision.ledgerVerdict,
      proposalFingerprint: decision.fingerprint,
      filesChanged,
      reasons: [{ code: decision.code, detail: decision.detail }],
      note: "written by tools/repair/supervisor-cycle.mjs on behalf of the supervisor",
    });
  }
  return decision;
}

/**
 * THE ARM CHECK — twelve known inputs, twelve answers that must differ.
 *
 * It runs in a throwaway directory so it can be executed at start-up without
 * touching the owner's ledger, and it fails LOUDLY: merge any two arms of
 * {@link decideRepairOutcome} and the collapsed pair is named. An entry point
 * whose failure mode is "returns something plausible" is the defect this
 * repository has catalogued twenty-two times.
 *
 * IT ALSO DRIVES THE GATE SEAM'S OWN ARM CHECK, because this file's answer for a
 * graded patch is the gate seam's answer: a router that can tell its own twelve
 * inputs apart while the thing it delegates to reads every gate verdict as APPLY
 * would report armed and be catastrophically wrong.
 *
 * AND SINCE 2026-08-12 IT DRIVES THE EVIDENCE BAR'S TWO READERS, both directions
 * each. A `readReproduction` that never finds a command refuses every ticket for
 * ever; a `classifyBarResult` that reads every verdict as ACCEPTED puts the bar
 * back where it was — present, tested, and not consulted.
 */
export function armCheck() {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-cycle-arm-"));
  try {
    const sig = "a".repeat(64);
    const diff = "--- a\n+++ b\n";
    const withDiff = { defect: { signature: sig }, diff, diffPath: "x", ruledOutFingerprints: [] };
    // A diff that has already cleared the bar. Every probe past the bar arm needs
    // one, and using the literal `{ ok: true }` here rather than a fabricated
    // cycle result keeps the seam's shape visible: `ok` is the only field the
    // router reads on the accepting side.
    const proved = { ...withDiff, bar: { ok: true } };
    const probes = [
      { want: "NO_DEFECT_RECORD", kind: "inconclusive", input: { defect: null, diff: null, diffPath: "x", ruledOutFingerprints: [] } },
      { want: "NO_DEFECT_SIGNATURE", kind: "inconclusive", input: { defect: { signature: "not-a-digest" }, diff: null, diffPath: "x", ruledOutFingerprints: [] } },
      { want: "REPAIR_WINDOW_CLOSED", kind: "inconclusive", input: { ...withDiff, deadlinePassed: true } },
      {
        /*
         * THE a913c871 SEQUENCE VERBATIM, and its answer is NON_MONOTONE at
         * attempt 2 — NOT oscillation at attempt 3. That is the measured point of
         * loop-guard.mjs's fourth arm: attempt 1 named `{a.id}`, attempt 2 named
         * `{a.kind}` (disjoint, so the channel is handing out one field at a time
         * over a seven-field object, arithmetically non-convergent), and only
         * attempt 3 came back to `{a.id}`. A comparator that waited for the
         * oscillation would escalate 87 minutes late.
         */
        want: "ANTI_LOOP_NON_MONOTONE",
        kind: "refused",
        input: {
          ...withDiff,
          loop: evaluateAttempts(
            [{ violations: ["a.id"] }, { violations: ["a.kind"] }, { violations: ["a.id"] }],
            { site: "spec" },
          ),
        },
      },
      { want: "NO_PATCH_AUTHOR", kind: "inconclusive", input: { defect: { signature: sig }, diff: null, diffPath: "x", ruledOutFingerprints: [] } },
      {
        want: "ALREADY_RULED_OUT",
        kind: "refused",
        input: { ...withDiff, ruledOutFingerprints: [proposalFingerprint({ diff })] },
      },
      /*
       * THE BAR ARM, BOTH DIRECTIONS AND BOTH KINDS. A diff with no bar answer
       * must not reach the gate; a bar that refused the IDEA is `refused`; a bar
       * that could not stage the experiment is `inconclusive`. The third is the
       * one that costs if it collapses into the second — the owner would be told
       * a patch does not work when the truth is that the copy could not run it.
       */
      { want: "NO_EVIDENCE_BAR_ANSWER", kind: "inconclusive", input: withDiff },
      {
        want: "BAR_NOT_FIXED",
        kind: "refused",
        input: { ...withDiff, bar: { ok: false, kind: "refused", code: "BAR_NOT_FIXED", ledgerVerdict: "NOT_FIXED", detail: "the arm check's known refusal by the bar" } },
      },
      {
        want: "BAR_COULD_NOT_REPRODUCE",
        kind: "inconclusive",
        input: { ...withDiff, bar: { ok: false, kind: "inconclusive", code: "BAR_COULD_NOT_REPRODUCE", ledgerVerdict: "COULD_NOT_REPRODUCE", detail: "the arm check's known unstageable experiment" } },
      },
      { want: "NO_GATE_ANSWER", kind: "inconclusive", input: proved },
      {
        want: "GATE_REFUSE",
        kind: "refused",
        input: { ...proved, gate: { intent: "REFUSE", code: "GATE_REFUSE", detail: "the arm check's known refusal", ledgerVerdict: "REFUSED", ledgerFingerprint: "proposal" } },
      },
      {
        want: "GATE_APPLY",
        kind: "applied",
        input: { ...proved, gate: { intent: "APPLY", code: "GATE_APPLY", detail: "the arm check's known authorisation", ledgerVerdict: "ACCEPTED", ledgerFingerprint: "proposal" } },
      },
    ];
    const got = probes.map((p) => decideRepairOutcome(p.input));
    const wrong = [];
    probes.forEach((p, i) => {
      if (got[i].code !== p.want) wrong.push(`${p.want} read as ${got[i].code}`);
      if (got[i].kind !== p.kind) wrong.push(`${p.want} answered kind '${got[i].kind}', wanted '${p.kind}'`);
      if (String(got[i].detail ?? "").trim() === "") wrong.push(`${p.want} carries a blank detail`);
    });
    const codes = new Set(got.map((g) => g.code)).size;
    const details = new Set(got.map((g) => g.detail)).size;
    if (codes !== probes.length) wrong.push(`${probes.length} inputs collapsed into ${codes} code(s)`);
    if (details !== probes.length) wrong.push(`${probes.length} inputs collapsed into ${details} sentence(s)`);
    /*
     * AND EXACTLY ONE PROBE MAY BE `applied`. Twelve distinct codes and twelve
     * distinct sentences would still be reported by a router that read the
     * ruled-out arm as a patch that landed; this is the check that sees it.
     */
    const appliedCount = got.filter((g) => g.kind === "applied").length;
    if (appliedCount !== 1) wrong.push(`${appliedCount} of ${probes.length} inputs were read as an applied patch; exactly one may be`);
    /*
     * AND A PARKED GATE OUTCOME MAY NOT RULE THE PROPOSAL OUT. A patch parked
     * for want of docker that got written to the ruled-out ledger would be
     * refused on sight for ever on a machine that later HAS docker — a
     * success-only memory in reverse, and RESEARCH is explicit that the ledger's
     * job is to stop re-suggesting FAILED repairs, not proposable ones.
     */
    const parked = decideRepairOutcome({
      ...proved,
      gate: { intent: "PARK", code: "GATE_BLIND", detail: "an arm did not report", ledgerVerdict: "COULD_NOT_REPRODUCE", ledgerFingerprint: "none" },
    });
    if (parked.fingerprint !== null) wrong.push("a PARKED gate outcome wrote a proposal fingerprint, which rules out a patch nobody refused");
    if (parked.kind !== "inconclusive") wrong.push(`a PARKED gate outcome answered kind '${parked.kind}', wanted 'inconclusive'`);
    /*
     * AND THE SAME FOR AN UNTOKENED APPLY, WHICH IS THE ARM THAT ALMOST GOT THIS
     * WRONG. "The gate said APPLY and the token does not verify" is a PLUMBING
     * disagreement — a drift in the token inputs — not a refusal of the idea. It
     * shipped ruling the fingerprint out, which would have blacklisted every
     * gate-approved patch for ever the first time a field path moved, silently,
     * with this arm check reporting armed throughout. Driven through the REAL
     * router rather than restated, so the assertion cannot drift from the code.
     */
    const untokened = classifyGateRecord({
      record: { verdict: "APPLY", reason: "no token", frozen: { digest: "f".repeat(64) }, knownBad: { verdict: "PASS" }, proofs: [], armCheck: { ok: true, blind: [] } },
      diff,
    });
    if (untokened.code !== "GATE_APPLY_UNTOKENED") wrong.push(`an untokened APPLY read as ${untokened.code}`);
    if (untokened.ledgerFingerprint !== "none") {
      wrong.push("an untokened APPLY rules the proposal out, so one drift in the token inputs would blacklist every gate-approved patch for ever");
    }

    /*
     * THE ANTI-LOOP GUARD'S NEGATIVE CONTROL, AND IT IS NOT OPTIONAL. A
     * comparator that escalates on every sequence is exactly as useless as one
     * that never does, and it is the more dangerous of the two here: it would
     * terminate every repairing ticket at `blocked` with a convincing sentence
     * about non-convergence and no repair would ever be attempted again. So a
     * SHRINKING sequence — the shape a working feedback channel produces — must
     * walk past the arm and reach the gate stage.
     */
    const shrinking = decideRepairOutcome({
      ...proved,
      loop: evaluateAttempts([{ violations: ["a.id", "a.kind"] }, { violations: ["a.id"] }], { site: "spec" }),
    });
    if (shrinking.code !== "NO_GATE_ANSWER") {
      wrong.push(`a SHRINKING attempt sequence escalated as ${shrinking.code}; the anti-loop guard refuses everything`);
    }

    /*
     * THE BAR'S OWN NEGATIVE CONTROLS, ALL THREE DRIVEN THROUGH THE REAL CODE.
     *
     * 1. NO BAR OUTCOME MAY WRITE A FINGERPRINT. The copy has no node_modules, so
     *    "the patch does not fix it" and "the copy could not run the command" are
     *    the same bytes; a fingerprint here is a permanent blacklist keyed on a
     *    confounded signal, on a diff nobody's gate ever refused.
     * 2. `readReproduction` MUST BE ABLE TO SAY YES. It answers
     *    NO_REPRODUCTION_COMMAND on every record this repository writes today, and
     *    a reader that could ONLY say that would refuse every ticket for ever
     *    while looking exactly like the honest refusal it is meant to be.
     * 3. `classifyBarResult` MUST BE ABLE TO SAY NO — and must split the two
     *    kinds. One that read every verdict as ACCEPTED would put the bar back
     *    where this round found it: present, tested, and not consulted.
     */
    const barRefused = decideRepairOutcome({
      ...withDiff,
      bar: { ok: false, kind: "refused", code: "BAR_MUTATION_SURVIVED", ledgerVerdict: "MUTATION_SURVIVED", detail: "reverting the fix left the check green" },
    });
    if (barRefused.fingerprint !== null) {
      wrong.push("a bar refusal wrote a proposal fingerprint, which blacklists for ever a diff that may only have met a copy with no dependencies");
    }
    if (barRefused.kind !== "refused") wrong.push(`a bar refusal answered kind '${barRefused.kind}', wanted 'refused'`);

    const noCommand = readReproduction({ signature: sig });
    const noCases = readReproduction({ signature: sig, reproduction: { command: "node check.mjs" } });
    const usable = readReproduction({
      signature: sig,
      reproduction: {
        command: "node check.mjs",
        cases: [
          { name: "targeted-via-another-input", command: "node probe.mjs", targeted: true },
          { name: "unrelated-recorded-input", command: "node unrelated.mjs" },
        ],
      },
    });
    if (noCommand.code !== "NO_REPRODUCTION_COMMAND") wrong.push(`a record with no reproduction block read as ${String(noCommand.code)}`);
    if (noCases.code !== "NO_RECORDED_REPLAY_CASES") wrong.push(`a record with a command and no independent case read as ${String(noCases.code)}`);
    if (usable.ok !== true || usable.cases.length !== 2) {
      wrong.push("a record carrying a command and two recorded cases was refused, so the bar can only ever refuse");
    }

    const barAccepted = classifyBarResult({ verdict: "ACCEPTED", proposal: { evidence: {} } });
    const barBroken = classifyBarResult({ verdict: "COULD_NOT_REPRODUCE", reasons: [{ code: "COULD_NOT_REPRODUCE", detail: "the command passed unpatched" }] });
    const barNo = classifyBarResult({ verdict: "NOT_FIXED", reasons: [{ code: "NOT_FIXED", detail: "still red with the patch" }] });
    if (barAccepted.ok !== true) wrong.push("the bar classifier refused an ACCEPTED cycle, so no proved patch can ever reach the gate");
    if (barNo.ok !== false || barNo.kind !== "refused") wrong.push(`a NOT_FIXED cycle classified as ok=${String(barNo.ok)} kind='${String(barNo.kind)}'`);
    if (barBroken.ok !== false || barBroken.kind !== "inconclusive") {
      wrong.push(`a COULD_NOT_REPRODUCE cycle classified as ok=${String(barBroken.ok)} kind='${String(barBroken.kind)}'; an unstageable experiment is not a refused idea`);
    }

    // AND THE LEDGER MUST ACTUALLY WRITE. A decision that records nothing is a
    // brake that cannot fire the second time: `ruledOutFingerprints` would return
    // [] for ever and the same proposal would be re-proved on every occurrence.
    const ledger = openLedger(dir);
    ledger.append({ signature: sig, verdict: "REFUSED", proposalFingerprint: "deadbeef", reasons: [] });
    if (!ledger.ruledOutFingerprints(sig).includes("deadbeef")) {
      wrong.push("the ruled-out ledger did not read back a row it had just written");
    }

    // THE GATE SEAM, DRIVEN. Its blindness is this file's blindness.
    const seam = armGateSeam();
    if (!seam.armed) wrong.push(`the gate seam is BLIND: ${seam.wrong.join("; ")}`);

    const lines = [
      `ARM CHECK: supervisor repair entry point returns ${codes} distinct code(s) and ${details} distinct sentence(s) ` +
        `on ${probes.length} known inputs, exactly ${appliedCount} of them applied; ${wrong.length} misread`,
      ...seam.lines,
      wrong.length === 0
        ? "ARM CHECK: armed — every outcome is named, only a proved-then-gate-authorised patch reads as applied, no bar " +
          "outcome blacklists a proposal, and the ruled-out ledger reads back what it writes"
        : `ARM CHECK: BLIND — ${wrong.join("; ")}. A repairing ticket may be told the wrong thing about why it stopped.`,
    ];
    return { armed: wrong.length === 0, wrong, lines, probes: probes.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/tools\/)/, ""))) {
  if (process.argv.includes("--armcheck")) {
    const arm = armCheck();
    for (const line of arm.lines) process.stdout.write(line + "\n");
    process.exit(arm.armed ? 0 : 1);
  }
  const defectPath = arg("defect");
  const ledgerDir = arg("ledger");
  if (defectPath === null || ledgerDir === null) {
    process.stderr.write(
      "usage: node tools/repair/supervisor-cycle.mjs --defect <results/defect.json> --ledger <dir> " +
        `[--proposals <dir, default ${DEFAULT_PROPOSALS_DIR}>] [--rollback <dir, default ${DEFAULT_ROLLBACK_DIR}>] ` +
        "[--deadline <iso instant>]\n   or: node tools/repair/supervisor-cycle.mjs --armcheck\n",
    );
    process.exit(2);
  }
  const decision = runSupervisorCycle({
    defectPath,
    ledgerDir,
    proposalsDir: arg("proposals", DEFAULT_PROPOSALS_DIR),
    rollbackDir: arg("rollback", join(REPO_ROOT, DEFAULT_ROLLBACK_DIR)),
    deadlineAt: arg("deadline"),
  });
  // ONE JSON LINE ON STDOUT AND NOTHING ELSE, because the supervisor parses this
  // stream. Every human-readable word is inside `detail`.
  process.stdout.write(JSON.stringify(decision) + "\n");
}
