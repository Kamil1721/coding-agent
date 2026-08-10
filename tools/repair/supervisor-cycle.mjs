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
 * ─── WHAT IT DOES NOT DO, STATED BECAUSE IT IS THE HONEST PART ───
 *
 * IT DOES NOT AUTHOR A PATCH, and it does not prove one. `runRepairCycle`
 * (`cycle.mjs`) takes the candidate diff and the reproduction command as INPUTS
 * and `prover.mjs` refuses to run inside this repository — proving a repair means
 * applying it, running a reproduction, reverting the fix hunk and running it
 * again, which on the owner's live tree is a corrupted workspace. So on a tree
 * with no candidate diff the truthful answer is `NO_PATCH_AUTHOR`, and with a
 * diff but no proved evidence bundle the gate's own bar refuses it. Both are
 * NAMED outcomes the supervisor turns into `blocked` with a sentence, which is
 * the whole point of the round: an honest terminal state beats a dead end.
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
import { filesInDiff } from "./diff.mjs";
import { proposalFingerprint } from "./evidence.mjs";
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

const HEX = /^[a-f0-9]{8,128}$/i;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
 *   3. NO PATCH AUTHOR, then the LEDGER, then THE GATE — cheapest refusal first,
 *      and the gate (the only expensive step) last.
 *
 * @param {{defect: unknown, diff: string|null, diffPath: string,
 *          ruledOutFingerprints: readonly string[], loop?: object|null,
 *          deadlinePassed?: boolean, gate?: object|null}} input
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

/* =========================================================================
 * THE IO HALF
 * ====================================================================== */

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
 * THE EVIDENCE BUNDLE IS PASSED THROUGH VERBATIM OR OMITTED. It is authored by
 * whoever wrote the diff (`<signature>.evidence.json`), and a bundle this file
 * synthesised would be a repair loop writing its own proof.
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
 *          gate?: (input: object) => object, now?: () => Date, timeoutMs?: number}} input
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
  let decision = decideRepairOutcome({ ...base, gate: null });

  /*
   * THE SECOND PASS. Only a decision that reached the gate stage runs the gate,
   * and the gate's own record — not this file's opinion of it — is what comes
   * back. `applied` is written on the row only after the tree really changed.
   */
  let applied = null;
  if (decision.stage === "gate" && decision.code === "NO_GATE_ANSWER") {
    const proposal = buildProposal({ signature, diff, evidence, now });
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
    decision = decideRepairOutcome({ ...base, gate: classified });
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
    ledger.append({
      signature,
      verdict: decision.ledgerVerdict,
      proposalFingerprint: decision.fingerprint,
      filesChanged: diff === null ? [] : filesInDiff(diff),
      reasons: [{ code: decision.code, detail: decision.detail }],
      note: "written by tools/repair/supervisor-cycle.mjs on behalf of the supervisor",
    });
  }
  return decision;
}

/**
 * THE ARM CHECK — nine known inputs, nine answers that must differ.
 *
 * It runs in a throwaway directory so it can be executed at start-up without
 * touching the owner's ledger, and it fails LOUDLY: merge any two arms of
 * {@link decideRepairOutcome} and the collapsed pair is named. An entry point
 * whose failure mode is "returns something plausible" is the defect this
 * repository has catalogued twenty-two times.
 *
 * IT ALSO DRIVES THE GATE SEAM'S OWN ARM CHECK, because this file's answer for a
 * graded patch is the gate seam's answer: a router that can tell its own nine
 * inputs apart while the thing it delegates to reads every gate verdict as APPLY
 * would report armed and be catastrophically wrong.
 */
export function armCheck() {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-cycle-arm-"));
  try {
    const sig = "a".repeat(64);
    const diff = "--- a\n+++ b\n";
    const withDiff = { defect: { signature: sig }, diff, diffPath: "x", ruledOutFingerprints: [] };
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
      { want: "NO_GATE_ANSWER", kind: "inconclusive", input: withDiff },
      {
        want: "GATE_REFUSE",
        kind: "refused",
        input: { ...withDiff, gate: { intent: "REFUSE", code: "GATE_REFUSE", detail: "the arm check's known refusal", ledgerVerdict: "REFUSED", ledgerFingerprint: "proposal" } },
      },
      {
        want: "GATE_APPLY",
        kind: "applied",
        input: { ...withDiff, gate: { intent: "APPLY", code: "GATE_APPLY", detail: "the arm check's known authorisation", ledgerVerdict: "ACCEPTED", ledgerFingerprint: "proposal" } },
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
     * AND EXACTLY ONE PROBE MAY BE `applied`. Nine distinct codes and nine
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
      ...withDiff,
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
      ...withDiff,
      loop: evaluateAttempts([{ violations: ["a.id", "a.kind"] }, { violations: ["a.id"] }], { site: "spec" }),
    });
    if (shrinking.code !== "NO_GATE_ANSWER") {
      wrong.push(`a SHRINKING attempt sequence escalated as ${shrinking.code}; the anti-loop guard refuses everything`);
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
        ? "ARM CHECK: armed — every outcome is named, only a gate-authorised patch reads as applied, and the ruled-out ledger reads back what it writes"
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
