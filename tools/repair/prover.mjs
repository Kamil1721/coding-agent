/**
 * THE PROVER — it executes, or it produces nothing.
 *
 * A verify component that cannot run a command silently degrades mutation testing into code
 * review; this repository has a standing lesson to that effect. Everything here goes through
 * spawnSync and every transcript in a proposal is the bytes a real process wrote.
 *
 * THE ORDER IS THE POINT:
 *   1. REPRODUCE FIRST. Run the recorded command on the unpatched tree and require it to
 *      FAIL. A repair for a defect that could not be reproduced is a guess, and the defect
 *      record exists precisely so nobody has to guess. No RED, no repair — the run stops
 *      and files COULD_NOT_REPRODUCE, which is itself a useful record.
 *   2. APPLY, and require GREEN.
 *   3. MUTATE BY REVERTING THE FIX, and require RED. The mutant is derived from the patch,
 *      never chosen by the agent, so the agent cannot set its own exam.
 *   4. NO-OP ABLATION, and require RED. Remove the fix's ADDED lines from the patched tree —
 *      leaving neither the old implementation nor the new one — and run the check again. A
 *      check that still passes against that no-op does not observe the thing this patch
 *      changes, so its GREEN proves nothing. That is a refusal (ABLATION_SURVIVED), not a
 *      pass. Step 3 cannot see this: see the fixture in prover.test.mjs whose check greps for
 *      the ABSENCE of the old line — it goes RED under a revert and GREEN under the no-op.
 *   5. PER-HUNK REVERT (multi-hunk patches only). A hunk whose individual revert leaves the
 *      check GREEN is unproven scaffolding — the broad, poorly-scoped diff that automated
 *      repair produces when it attributes at the outcome level. Named, not hidden.
 *
 * SANDBOX. `root` must be outside this repository. A concurrent round owns files here and
 * the hard rules forbid touching the working tree, so pointing the prover at the repo is a
 * refusal, not a warning — and arm.mjs exercises that refusal at start-up.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { countHunks, parseUnifiedDiff, splitHunks } from "./diff.mjs";
import { proposalFingerprint } from "./evidence.mjs";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Throws unless `root` is a directory outside this repository. */
export function assertSandbox(root) {
  const r = resolve(String(root ?? ""));
  if (r === REPO_ROOT || r.startsWith(REPO_ROOT + sep)) {
    throw new Error(`prover: refusing to operate inside the repository (${r}); the prover runs on an isolated copy only`);
  }
  return r;
}

/**
 * Run one command and return a verbatim transcript.
 * The transcript is the process's own bytes, framed by the command line and the exit code
 * so that a silent pass and a silent failure are not the same string.
 */
export function runCommand(command, { cwd, env, timeoutMs = 120_000 } = {}) {
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...(env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  const code = res.status === null ? (res.signal ? `signal:${res.signal}` : "null") : res.status;
  const transcript = `$ ${command}\n${res.stdout ?? ""}${res.stderr ?? ""}# exit code: ${code}\n`;
  return { ok: res.status === 0, exitCode: res.status, transcript };
}

function patchFile(text) {
  const dir = mkdtempSync(join(tmpdir(), "repair-patch-"));
  const file = join(dir, "p.diff");
  writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Apply or revert a patch in the sandbox. Exported because the cycle has to hand the tree
 * between the prover (which leaves the patch APPLIED) and the independent replay (which
 * needs to measure the unpatched state first). Getting that handover wrong is silent: the
 * replay's apply fails, `ran` comes back false, and the proposal is refused for the wrong
 * reason. The arm check caught exactly that.
 */
export function applyDiff(root, text, opts = {}) {
  return gitApply(assertSandbox(root), text, opts);
}

function gitApply(root, text, { reverse = false, check = false } = {}) {
  const { file, cleanup } = patchFile(text);
  try {
    const args = ["apply", "-p1", ...(reverse ? ["-R"] : []), ...(check ? ["--check"] : []), file];
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  } finally {
    cleanup();
  }
}

/* ===========================================================================
 * THE NO-OP ABLATION.
 *
 * WHAT IT IS. Applied to the PATCHED tree, the ablation patch deletes exactly the lines the
 * fix ADDED. What is left is neither the old implementation nor the new one — the fix's
 * contribution is simply absent, which is the mechanical reading of "a no-op implementation
 * of the thing being fixed" (gate.mjs:117, RESEARCH R8). Like the mutant, it is DERIVED FROM
 * THE PATCH and never chosen by the agent.
 *
 * WHY IT IS NOT THE MUTANT AGAIN, MEASURED. The mutant restores the OLD code, so a check that
 * only observes the old code's ABSENCE — the grep-for-the-smell check that automated repair
 * writes constantly — goes RED under the mutant and stays GREEN under the ablation. That pair
 * is the ABLATION_SURVIVED fixture in prover.test.mjs, and it is the reason step 4 exists at
 * all: on that input step 3 reports a clean mutation proof for a vacuous check.
 *
 * WHY MINIMAL AND NOT WHOLE-FILE. Blanking the file would make almost any check fail, and a
 * control that is trivial to satisfy is not a control. Deleting only the added lines is the
 * TIGHTEST ablation available from the diff, so the check has to observe the fix's own
 * contribution to go red.
 * ======================================================================== */

const ABLATION_HEADER = /^# no-op ablation of repair ([0-9a-f]{32}): /;

/**
 * Build the patch that guts the fix: '+' lines become removals, '-' lines are dropped
 * (they are not in the patched tree), context is kept.
 *
 * The hunk arithmetic is stated rather than assumed, because a header whose counts are wrong
 * makes `git apply` refuse and that refusal must not be readable as "the ablation ran":
 *   old side = the PATCHED file  → start = the original hunk's NEW-side start, len = context + added
 *   new side = the ABLATED file  → start = that, minus every line already removed from this
 *                                   file by earlier hunks, len = context
 * The `newLen === 0` start convention (a hunk that empties the region) is the one `git diff`
 * emits, and it is verified by execution: prover.test.mjs proves the patch APPLIES on a
 * one-line file, on a two-hunk diff, and on the widget fix, rather than reasoning about it.
 *
 * @returns {{ ok: true, text: string, files: string[], addedLines: number }
 *          | { ok: false, reason: string, files: string[], addedLines: number }}
 */
export function noOpAblationPatch(diff) {
  let files;
  try {
    files = parseUnifiedDiff(diff);
  } catch (err) {
    return { ok: false, reason: `the diff could not be parsed, so no ablation could be derived: ${err.message}`, files: [], addedLines: 0 };
  }

  const blocks = [];
  const touched = [];
  let addedLines = 0;

  for (const f of files) {
    const hunks = [];
    let removedSoFar = 0;
    for (const h of f.hunks) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h.header);
      if (m === null) {
        return { ok: false, reason: `hunk header not understood: ${h.header}`, files: touched, addedLines };
      }
      const lines = h.lines.filter((l, i) => !(l === "" && i === h.lines.length - 1));
      const body = [];
      let context = 0;
      let added = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i];
        if (l === "" || l[0] === " ") {
          body.push(l);
          context += 1;
        } else if (l[0] === "+") {
          body.push(`-${l.slice(1)}`);
          added += 1;
        } else if (l[0] === "-") {
          // Not present in the patched tree, so it is not in the ablation's old side either.
          // Its "\ No newline at end of file" marker goes with it or the patch is malformed.
          if (lines[i + 1] !== undefined && lines[i + 1][0] === "\\") i += 1;
        } else if (l[0] === "\\") {
          body.push(l);
        }
      }
      if (added === 0) continue; // nothing was added here, so there is nothing to gut
      const oldStart = Number(m[1]);
      const newLen = context;
      const newStart = newLen === 0 ? Math.max(0, oldStart - removedSoFar - 1) : oldStart - removedSoFar;
      hunks.push(`@@ -${String(oldStart)},${String(context + added)} +${String(newStart)},${String(newLen)} @@`, ...body);
      removedSoFar += added;
      addedLines += added;
    }
    if (hunks.length === 0) continue;
    touched.push(f.path);
    blocks.push([`--- a/${f.path}`, `+++ b/${f.path}`, ...hunks].join("\n"));
  }

  if (blocks.length === 0) {
    return {
      ok: false,
      files: touched,
      addedLines: 0,
      reason:
        "this diff adds no lines, so removing its added lines changes nothing and no no-op ablation exists for it. " +
        "For a deletion-only fix the no-op IS the unpatched tree, which is byte-for-byte the fix revert already " +
        "recorded as mutationRed; copying that transcript into noOpAblation would collapse two independent controls " +
        "into one, so the key is omitted instead and the patch parks downstream",
    };
  }
  return { ok: true, text: `${blocks.join("\n")}\n`, files: touched, addedLines };
}

/**
 * THE READER. Does this transcript SHOW the accepting check failing under the no-op?
 *
 * WHY THIS EXISTS AS AN EXPORT, AND WHERE IT IS NOT YET CALLED. The live reader of this proof
 * is `proofsFor` in tools/tier3/gate.mjs:113-119, which today is satisfied by ANY non-empty
 * string — measured by a reviewer on 2026-08-12 with the literal string "x", and recorded in
 * DESIGN §6.2 as "a string nothing executes". That file is owned by another worker this
 * round and was not edited. This predicate is the hardened reader it needs: two lines there
 * (import, and call it with the proposal's diff) replace the truthiness test, and its refusal
 * reasons are already written in the voice the trail wants.
 *
 * WHAT IT CHECKS, AND WHAT IT CANNOT. It requires the prover's own framing: the ablation
 * header, the FINGERPRINT OF THIS EXACT DIFF (so a transcript lifted from another proposal
 * fails), a command line proving something was executed, and a NON-ZERO exit trailer proving
 * the check FAILED. It is not unforgeable — nothing that reads a string can be. An unforgeable
 * version needs the gate to run the prover itself; that is UNMEASURED here and is not claimed.
 *
 * @param {string} transcript the candidate `evidence.noOpAblation`
 * @param {{ diff: string }} ctx the diff the transcript claims to be about
 * @returns {{ holds: boolean, why: string }}
 */
export function noOpAblationHolds(transcript, { diff } = {}) {
  if (typeof transcript !== "string" || transcript.trim() === "") {
    return { holds: false, why: "no no-op ablation transcript was supplied; absence is treated exactly like failure" };
  }
  const head = ABLATION_HEADER.exec(transcript.split("\n")[0] ?? "");
  if (head === null) {
    return {
      holds: false,
      why:
        "the ablation transcript does not begin with the prover's ablation header, so nothing shows an ablation was " +
        "ever constructed or run; prose asserting that a check failed is not a record of it failing",
    };
  }
  const want = proposalFingerprint({ diff });
  if (head[1] !== want) {
    return { holds: false, why: `the ablation transcript is about repair ${head[1]}, not this one (${want})` };
  }
  if (!/^\$ /m.test(transcript)) {
    return { holds: false, why: "the ablation transcript carries no command line, so no accepting check was run against the no-op" };
  }
  const exit = [...transcript.matchAll(/^# exit code: (.+)$/gm)].pop();
  if (exit === undefined) {
    return { holds: false, why: "the ablation transcript carries no exit-code trailer, so it did not come from the prover" };
  }
  if (exit[1].trim() === "0") {
    return {
      holds: false,
      why: `the accepting check PASSED against the no-op (exit code ${exit[1].trim()}): it does not observe what this patch changes, so the check is vacuous`,
    };
  }
  return { holds: true, why: `the accepting check was observed FAILING (exit code ${exit[1].trim()}) against a no-op ablation of repair ${want}` };
}

/**
 * @param {{ root: string, command: string, diff: string,
 *           env?: Record<string,string>, timeoutMs?: number, perHunk?: boolean }} input
 * @returns {{ ok: boolean, outcome: string,
 *             evidence?: {redBefore:string, greenAfter:string, mutationRed:string, noOpAblation?:string},
 *             ablation?: {code:string, ran:boolean, holds:boolean, reason:string|null, files:string[], addedLines:number},
 *             transcripts: Record<string,string>, hunks: number, unprovenHunks: number[], detail?: string }}
 *
 * `evidence.noOpAblation` is present ONLY when an ablation was constructed, executed, and
 * observed FAILING. Deletion-only diffs have no ablation and carry no key: absent, not faked.
 * `ablation` is undefined on the returns above step 4, where nothing was ablated yet.
 */
export function proveRepair(input) {
  const root = assertSandbox(input.root);
  const { command, diff } = input;
  if (typeof command !== "string" || command.trim() === "") throw new Error("prover: a reproduction command is required");
  if (typeof diff !== "string" || diff.trim() === "") throw new Error("prover: a diff is required");
  const opts = { cwd: root, env: input.env, timeoutMs: input.timeoutMs };
  const transcripts = {};
  const hunks = countHunks(diff);

  // 1. REPRODUCE. Must be RED before anything is applied.
  const red = runCommand(command, opts);
  transcripts.redBefore = red.transcript;
  if (red.ok) {
    return {
      ok: false,
      outcome: "COULD_NOT_REPRODUCE",
      transcripts,
      hunks,
      unprovenHunks: [],
      detail: "the recorded command passed on the unpatched tree; there is nothing here to repair and a patch would be a guess",
    };
  }

  // 2. APPLY.
  const applied = gitApply(root, diff);
  if (!applied.ok) {
    return { ok: false, outcome: "PATCH_DID_NOT_APPLY", transcripts, hunks, unprovenHunks: [], detail: applied.output.trim() };
  }

  const green = runCommand(command, opts);
  transcripts.greenAfter = green.transcript;
  if (!green.ok) {
    gitApply(root, diff, { reverse: true });
    return { ok: false, outcome: "NOT_FIXED", transcripts, hunks, unprovenHunks: [], detail: "the check still fails with the patch applied" };
  }

  // 3. MUTATE: revert the whole fix. Must be RED.
  const reverted = gitApply(root, diff, { reverse: true });
  if (!reverted.ok) {
    return { ok: false, outcome: "MUTANT_NOT_CONSTRUCTIBLE", transcripts, hunks, unprovenHunks: [], detail: reverted.output.trim() };
  }
  const mutant = runCommand(command, opts);
  transcripts.mutationRed = mutant.transcript;
  gitApply(root, diff); // restore the patch
  if (mutant.ok) {
    return {
      ok: false,
      outcome: "MUTATION_SURVIVED",
      transcripts,
      hunks,
      unprovenHunks: [],
      detail: "reverting the fix left the check green; the check does not observe this patch",
    };
  }

  /*
   * 4. NO-OP ABLATION. The tree is PATCHED here (step 3 restored it), which is the state the
   * ablation is defined against. It is reverted before every return below, including the
   * failing ones: cycle.mjs hands the tree back by reverse-applying the ORIGINAL diff
   * (cycle.mjs:96-102), and an ablated tree makes that fail into a warning and the next cycle
   * report COULD_NOT_REPRODUCE — the exact clean-plausible-wrong answer cycle.mjs:77-95 was
   * written to post-mortem.
   *
   * WHY STEP 4 INVENTS NO NEW `outcome` WORDS, AND WHERE ITS OWN NAME LIVES.
   * `supervisor-cycle.test.mjs:1436-1451` scans THIS FILE for `outcome:` literals and refuses
   * any that its classification table does not name — measured on 2026-08-12: the first draft
   * of this step returned ABLATION_SURVIVED and that test went red with *"prover.mjs can return
   * ABLATION_SURVIVED and nothing classifies it, so it reaches the ticket as an experiment that
   * could not be staged"*. It was right: `classifyBarResult` (supervisor-cycle.mjs:510-511)
   * carries two frozen literal lists, so an unclassified word would be filed as
   * `inconclusive`/`COULD_NOT_REPRODUCE` — "the copy could not run your command" — for a patch
   * whose experiment ran and refused it. That file belongs to another worker this round, so
   * step 4 reuses the vocabulary the supervisor already routes correctly:
   *   a surviving ablation  → MUTATION_SURVIVED       (refused: a derived mutant left it green)
   *   a mutant that would not stage or would not undo → MUTANT_NOT_CONSTRUCTIBLE (inconclusive)
   * and the precise name is carried in `ablation.code`, which nothing keys on and no scan
   * reads. The distinction is therefore recorded, not lost — and promoting those codes to real
   * outcome words is a three-line change stated in the handover.
   */
  const patch = noOpAblationPatch(diff);
  let ablation = {
    code: patch.ok ? "ABLATION_HELD" : "ABLATION_ABSENT",
    ran: false,
    holds: false,
    reason: patch.ok ? null : patch.reason,
    files: patch.files,
    addedLines: patch.addedLines,
  };
  let ablationTranscript = null;

  if (patch.ok) {
    const gutted = gitApply(root, patch.text);
    if (!gutted.ok) {
      /*
       * KEPT DISTINCT FROM "this diff has no ablation" BY `ablation.code`, and that separation
       * is the point: if a bug in the hunk arithmetic above were reported as the deletion-only
       * case, every fixture here would stay green while nothing was ever ablated — a check that
       * can only observe success, which is what this repository keeps shipping.
       */
      return {
        ok: false,
        outcome: "MUTANT_NOT_CONSTRUCTIBLE",
        transcripts,
        hunks,
        unprovenHunks: [],
        ablation: {
          ...ablation,
          code: "ABLATION_NOT_APPLICABLE",
          reason: `the derived ablation patch did not apply to the patched tree: ${gutted.output.trim()}`,
        },
        detail: `the no-op ablation mutant could not be staged, so the accepting check was never watched against a no-op: ${gutted.output.trim()}`,
      };
    }

    const ablated = runCommand(command, opts);
    ablationTranscript = `# no-op ablation of repair ${proposalFingerprint({ diff })}: ${String(patch.addedLines)} added line(s) removed from ${patch.files.join(", ")}\n${ablated.transcript}`;
    transcripts.noOpAblation = ablationTranscript;

    const restored = gitApply(root, patch.text, { reverse: true });
    if (!restored.ok) {
      return {
        ok: false,
        outcome: "MUTANT_NOT_CONSTRUCTIBLE",
        transcripts,
        hunks,
        unprovenHunks: [],
        ablation: {
          ...ablation,
          code: "ABLATION_NOT_REVERSIBLE",
          ran: true,
          reason: `the ablation was applied and could not be undone: ${restored.output.trim()}`,
        },
        detail:
          `the no-op ablation mutant ran and could not be undone (${restored.output.trim()}); the root is left ABLATED, ` +
          "so the caller must not treat it as a proof artefact",
      };
    }

    if (ablated.ok) {
      /*
       * The transcript stays in `transcripts` and is deliberately KEPT OUT of `evidence`.
       * gate.mjs:114 satisfies the ablation proof on any non-empty string (measured 2026-08-12
       * with the literal "x"), so an honest refusal written into `evidence.noOpAblation` would
       * be read by the gate as the proof it refutes.
       */
      return {
        ok: false,
        outcome: "MUTATION_SURVIVED",
        transcripts,
        hunks,
        unprovenHunks: [],
        ablation: { ...ablation, code: "ABLATION_SURVIVED", ran: true, holds: false, reason: "the accepting check passed against the no-op" },
        detail:
          "THE NO-OP ABLATION MUTANT SURVIVED (the fix-hunk revert did not — see mutationRed): the accepting check " +
          "still PASSED with the fix's added lines removed, so it does not observe what this patch changes and its " +
          "GREEN proves nothing. A revert-based mutation proof cannot see this — a check that only observes the " +
          "ABSENCE of the old code goes red under the revert and green here.",
      };
    }
    ablation = { ...ablation, ran: true, holds: noOpAblationHolds(ablationTranscript, { diff }).holds, reason: null };
  }

  /*
   * A deletion-only fix reaches here with `ran: false` and no `noOpAblation` key. It is not a
   * refusal — see noOpAblationPatch's reason string — and the downstream effect is the
   * designed one: with the key absent the Tier 3 gate's proof is unsatisfied and the patch
   * PARKS at SELF-PROPOSE while Tiers 1 and 2 keep running.
   */
  const bundle = () => ({
    redBefore: transcripts.redBefore,
    greenAfter: transcripts.greenAfter,
    mutationRed: transcripts.mutationRed,
    ...(ablation.holds ? { noOpAblation: ablationTranscript } : {}),
  });

  // 5. PER-HUNK. Each hunk must matter on its own, or it is scaffolding.
  const unprovenHunks = [];
  if (input.perHunk !== false && hunks > 1) {
    for (const h of splitHunks(diff)) {
      const off = gitApply(root, h.text, { reverse: true });
      if (!off.ok) {
        unprovenHunks.push(h.index);
        transcripts[`hunk${h.index}`] = `# hunk ${h.index} (${h.path}) could not be reverted on its own\n${off.output}`;
        continue;
      }
      const r = runCommand(command, opts);
      transcripts[`hunk${h.index}`] = r.transcript;
      gitApply(root, h.text);
      if (r.ok) unprovenHunks.push(h.index);
    }
  }

  if (unprovenHunks.length > 0) {
    return {
      ok: false,
      outcome: "UNPROVEN_HUNKS",
      transcripts,
      hunks,
      unprovenHunks,
      ablation,
      detail: `reverting hunk(s) ${unprovenHunks.join(", ")} on their own left the check green; that part of the diff is unproven scaffolding`,
      evidence: bundle(),
    };
  }

  return {
    ok: true,
    outcome: "PROVEN",
    transcripts,
    hunks,
    unprovenHunks: [],
    ablation,
    evidence: bundle(),
  };
}

/**
 * THE INDEPENDENT CHECK — recorded behaviour on inputs the patch was NOT written against.
 *
 * Each case is a command with a recorded exit code. The targeted case must change; every
 * other case must not. This is not the test the patch was written against, which is the
 * whole reason it is here: a mutation proof cannot see overfitting.
 *
 * INDEPENDENCE IS CHECKED, NOT ASSUMED. Two ways this degrades into the agent re-running
 * its own exam, and both produce a clean-looking result:
 *   - a case list with no UNRELATED case returns `unrelatedChanged: []`, and "[] because
 *     nothing was damaged" is byte-identical to "[] because nothing was executed";
 *   - a case whose command IS the reproduction command is the test the patch was written
 *     against, wearing the word "independent".
 * Both are refused by name here rather than reported as a pass.
 *
 * @param {{ root: string, cases: {name:string, command:string, targeted?:boolean}[],
 *           diff: string, reproductionCommand?: string,
 *           env?: Record<string,string>, timeoutMs?: number }} input
 */
export function independentReplay(input) {
  const root = assertSandbox(input.root);
  const cases = input.cases ?? [];
  const refuse = (code, detail) => ({ ran: false, code, targetedChanged: false, unrelatedChanged: [], detail });
  if (cases.length === 0) return refuse("REPLAY_NO_CASES", "no recorded cases were supplied");
  if (!cases.some((c) => c.targeted !== true)) {
    return refuse("REPLAY_NOT_INDEPENDENT", "every recorded case is the targeted one; an empty unrelatedChanged would mean nothing was executed, not that nothing was damaged");
  }
  if (typeof input.reproductionCommand === "string" && cases.some((c) => c.command === input.reproductionCommand)) {
    return refuse("REPLAY_NOT_INDEPENDENT", `a recorded case re-runs the reproduction command (${input.reproductionCommand}); that is the test the patch was written against`);
  }
  const opts = { cwd: root, env: input.env, timeoutMs: input.timeoutMs };

  const before = new Map();
  for (const c of cases) before.set(c.name, runCommand(c.command, opts).exitCode);

  const applied = gitApply(root, input.diff);
  if (!applied.ok) return refuse("REPLAY_PATCH_DID_NOT_APPLY", `patch did not apply: ${applied.output.trim()}`);

  const after = new Map();
  for (const c of cases) after.set(c.name, runCommand(c.command, opts).exitCode);
  gitApply(root, input.diff, { reverse: true });

  const changed = cases.filter((c) => before.get(c.name) !== after.get(c.name)).map((c) => c.name);
  const targeted = cases.filter((c) => c.targeted === true).map((c) => c.name);
  return {
    ran: true,
    targetedChanged: targeted.length > 0 && targeted.every((n) => changed.includes(n)),
    unrelatedChanged: changed.filter((n) => !targeted.includes(n)),
    before: Object.fromEntries(before),
    after: Object.fromEntries(after),
  };
}
