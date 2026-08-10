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
 *   4. PER-HUNK REVERT (multi-hunk patches only). A hunk whose individual revert leaves the
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
import { countHunks, splitHunks } from "./diff.mjs";

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

/**
 * @param {{ root: string, command: string, diff: string,
 *           env?: Record<string,string>, timeoutMs?: number, perHunk?: boolean }} input
 * @returns {{ ok: boolean, outcome: string, evidence?: {redBefore:string,greenAfter:string,mutationRed:string},
 *             transcripts: Record<string,string>, hunks: number, unprovenHunks: number[], detail?: string }}
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

  // 4. PER-HUNK. Each hunk must matter on its own, or it is scaffolding.
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
      detail: `reverting hunk(s) ${unprovenHunks.join(", ")} on their own left the check green; that part of the diff is unproven scaffolding`,
      evidence: { redBefore: transcripts.redBefore, greenAfter: transcripts.greenAfter, mutationRed: transcripts.mutationRed },
    };
  }

  return {
    ok: true,
    outcome: "PROVEN",
    transcripts,
    hunks,
    unprovenHunks: [],
    evidence: { redBefore: transcripts.redBefore, greenAfter: transcripts.greenAfter, mutationRed: transcripts.mutationRed },
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
