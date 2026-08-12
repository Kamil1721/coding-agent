/**
 * defect-record.reproduction.test.ts — the block that decides whether the
 * self-repair evidence bar is reachable at all, and both arms of every rule in it.
 *
 * ═══ WHAT WAS WRONG, MEASURED (2026-08-12) ═══
 *
 * `tools/repair/cycle.mjs` will not let a candidate patch near the Tier 3 gate
 * until it has watched the defect REPRODUCE on an isolated copy of HEAD. It gets
 * the command from the run's `results/defect.json`. Every one of the 7 records
 * under `dashboard/runs` was grepped for `command`: zero hits, because
 * `DefectRecord` had no such field. So every real ticket stopped at
 * `NO_REPRODUCTION_COMMAND` and the entire chain behind it was unreachable in
 * production — 110 tests and 16 arm checks grading a path nothing could enter.
 *
 * ═══ WHY MOST OF THIS FILE ASSERTS AN ABSENCE ═══
 *
 * The copy is `git archive HEAD`: no `node_modules`, no `dist`, no
 * `dashboard/runs`. A command that fails there for the wrong reason is read by
 * the bar as "the defect reproduced" before the patch and as `NOT_FIXED` after
 * it, so a working patch is recorded as a broken one. A reproduction that cannot
 * run is worse than none. `planReproduction` therefore emits a command for the
 * one class whose failing call takes arguments this record holds and whose
 * callee loads with bare node, and a NAMED absence for the rest — and this file
 * pins which is which, in both directions.
 *
 * ═══ THE CONSUMER IS IMPORTED, NEVER RESTATED ═══
 *
 * The shape is only correct if `tools/repair/supervisor-cycle.mjs#readReproduction`
 * accepts it, so that function is loaded from the real file and run against real
 * records. A test that re-implemented its predicates would agree with itself for
 * ever, which is this repository's catalogued signature defect.
 *
 * ═══ EXECUTED, NOT REASONED (2026-08-12) ═══
 *
 * The emitted command was run inside a real `git archive HEAD` copy with no
 * node_modules and no dist, before a patch, after it, and with the fix reverted.
 * Exit codes 1 / 0 / 1. The transcript is quoted in the report for this change;
 * the arithmetic bound it has to fit is asserted below against
 * `MAX_PROVED_RUNS`, read out of the same module the bar reads it from.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { buildDefectRecord, defectSignature, planReproduction } from "./defect-record.js";
import type { DefectRecordInput, DefectReproduction, ReproductionInput } from "./defect-record.js";

/* -------------------------------------------------------------------------
 * The real consumer, loaded from the tree rather than described
 * ---------------------------------------------------------------------- */

interface Reproduction {
  readonly ok: boolean;
  readonly code?: string;
  readonly command?: string;
  readonly cases?: readonly { readonly name: string; readonly command: string; readonly targeted: boolean }[];
}

/**
 * Walk up until the repository root is found, rather than counting `..`.
 *
 * `npm test` compiles to `dist/` and runs from there, so a fixed relative path is
 * right for exactly one of the two ways this file is executed. The marker is the
 * file being imported, so a miss is a thrown sentence naming what was looked for
 * — never a silently skipped test, which would let this whole file pass on a tree
 * where the bar's reader does not exist.
 */
function repairModule(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "tools", "repair", name);
    if (existsSync(candidate)) return candidate;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not find tools/repair/${name} above ${fileURLToPath(import.meta.url)}`);
}

const supervisorCycle = (await import(pathToFileURL(repairModule("supervisor-cycle.mjs")).href)) as {
  readReproduction: (defect: unknown) => Reproduction;
  MAX_PROVED_RUNS: number;
};

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const AT = "2026-08-12T09:00:35.066Z";

function inputFor(over: Partial<ReproductionInput>): ReproductionInput {
  return {
    status: "failed",
    phase: "build",
    failureClass: "accounting",
    bakeoffCode: "unknown_model_price",
    provider: "anthropic",
    modelId: "claude-opus-6",
    at: AT,
    ...over,
  };
}

function recordFor(over: Partial<DefectRecordInput>): ReturnType<typeof buildDefectRecord> {
  const base: DefectRecordInput = {
    runId: "run-2026-08-12T09-00-35-066Z-6ec44b2f",
    at: AT,
    phase: "build",
    status: "failed",
    failureClass: "accounting",
    bakeoffCode: "unknown_model_price",
    failureReason: "no price window covers anthropic/claude-opus-6 on 2026-08-12",
    site: "build/failed/unknown_model_price",
    violations: null,
    attempts: null,
    artefacts: [],
    provider: "anthropic",
    modelId: "claude-opus-6",
    repairable: true,
  };
  return buildDefectRecord({ ...base, ...over });
}

function runnable(plan: DefectReproduction): Extract<DefectReproduction, { available: true }> {
  assert.equal(plan.available, true, `expected a runnable reproduction, got ${JSON.stringify(plan)}`);
  if (!plan.available) throw new Error("unreachable");
  return plan;
}

/* =========================================================================
 * 1. THE ONE RUNNABLE ARM — it fires, and it fires with a real command
 * ====================================================================== */

test("a price-lookup defect gets a command that names the run's own model", () => {
  const plan = runnable(planReproduction(inputFor({})));
  // The command must call the real function on the real module in the copy — not
  // grep the source for a model id, which is the 2026-08-04 prose-matching
  // mechanism wearing a different hat.
  assert.match(plan.command, /await import\("\.\/bakeoff\/src\/contracts\.ts"\)/);
  assert.match(plan.command, /resolvePrice\("anthropic", "claude-opus-6", "2026-08-12T09:00:35\.066Z"\)/);
  assert.ok(!plan.command.includes("dist/"), "the copy has no dist; a command naming one is red for the wrong reason");
  assert.ok(!plan.command.includes("npm "), "the copy has no node_modules; npm would be red for the wrong reason");
});

test("BOTH DIRECTIONS OF THE SAME RULE: the same run with a different code gets NO command", () => {
  /*
   * THE MUST-NOT-FIRE TWIN. Every field is identical to the test above except
   * the bakeoff code. Without this arm, a `planReproduction` that returned the
   * price command unconditionally would pass the whole runnable half of this
   * file — a check that can only observe success.
   */
  const plan = planReproduction(inputFor({ bakeoffCode: "suite_not_audited", failureClass: "suite_authoring" }));
  assert.equal(plan.available, false);
  assert.ok(!Object.hasOwn(plan, "command"), "an absence that carries a command is the lie this arm exists to prevent");
  assert.ok(!Object.hasOwn(plan, "cases"));
});

/* =========================================================================
 * 2. THE REPLAY CASES — the shape `independentReplay` refuses without
 * ====================================================================== */

test("the recorded cases satisfy independentReplay's two refusals", () => {
  const plan = runnable(planReproduction(inputFor({})));
  // REPLAY_NOT_INDEPENDENT, arm 1: "[] because nothing was damaged" is
  // byte-identical to "[] because nothing was executed" without an unrelated case.
  assert.ok(
    plan.cases.some((c) => c.targeted !== true),
    "at least one case must be UNRELATED or unrelatedChanged: [] means nothing ran",
  );
  // INDEPENDENT_CHECK_MISSED_TARGET (evidence.mjs): a targeted case must exist to
  // change, or the replay proves the patch touched nothing at all.
  assert.ok(plan.cases.some((c) => c.targeted === true));
  // REPLAY_NOT_INDEPENDENT, arm 2: a case that re-runs the reproduction is the
  // test the patch was written against, wearing the word "independent".
  for (const c of plan.cases) assert.notEqual(c.command, plan.command);
  for (const c of plan.cases) assert.ok(c.name.trim() !== "", "a nameless case cannot be reported as changed");
});

test("the unrelated case refuses an emptied price table instead of passing vacuously", () => {
  const plan = runnable(planReproduction(inputFor({})));
  const unrelated = plan.cases.filter((c) => c.targeted !== true);
  assert.equal(unrelated.length, 1);
  const control = unrelated[0]?.command ?? "";
  /*
   * THE CONTROL'S OWN CONTROL. The case loops over PRICE_TABLE; a patch that
   * deleted the table would make it loop zero times and exit 0 — zero rows, zero
   * failures, green. `PRICE_TABLE.length === 0 -> exit 1` is the negative control
   * inside the negative control, and it is asserted here because it is the line
   * most likely to be "simplified" away.
   */
  assert.match(control, /PRICE_TABLE\.length === 0\) process\.exit\(1\)/);
  // And it must derive its model ids from the table, never carry one written by
  // hand: a hard-coded row that later expires is a control that refuses every patch.
  assert.ok(!control.includes("claude-opus-5"), "the control must read the table, not name a row");
});

test("the proof fits the bar's budget, read from the bar's own module", () => {
  const plan = runnable(planReproduction(inputFor({})));
  /*
   * `runEvidenceBar` computes runs = 3 + (hunks > 1 ? hunks : 0) + 2 × cases and
   * refuses PROOF_BUDGET_EXCEEDED above MAX_PROVED_RUNS. The 4 here is headroom
   * for a four-hunk patch: a record whose case list alone eats the budget makes
   * every candidate diff unprovable, and the refusal would name the budget rather
   * than this file.
   */
  const runs = 3 + 4 + 2 * plan.cases.length;
  assert.ok(
    runs <= supervisorCycle.MAX_PROVED_RUNS,
    `${String(runs)} command runs for a 4-hunk patch exceeds MAX_PROVED_RUNS=${String(supervisorCycle.MAX_PROVED_RUNS)}`,
  );
});

/* =========================================================================
 * 3. THE SHELL GUARD — both arms
 * ====================================================================== */

test("a model id that cannot be written into a shell command is an absence, not an escape", () => {
  const hostile = 'claude-opus-6"; rm -rf /tmp/x; echo "';
  const plan = planReproduction(inputFor({ modelId: hostile }));
  assert.equal(plan.available, false);
  if (plan.available) throw new Error("unreachable");
  assert.equal(plan.code, "REPRODUCTION_PARAMETERS_UNSAFE");
  assert.ok(!Object.hasOwn(plan, "command"));
  // The refusal quotes what it refused, so the operator can see it was the model
  // id and not the code that stopped the reproduction.
  assert.ok(plan.reason.includes(JSON.stringify(hostile)));
});

test("BOTH DIRECTIONS: a safe model id of the same class DOES produce a command", () => {
  // Without this arm a `SHELL_SAFE` that rejected everything would pass the test
  // above and silently disable the only runnable class.
  const plan = planReproduction(inputFor({ modelId: "gpt-5.6-luna" }));
  assert.equal(plan.available, true);
});

test("a clock value resolvePrice cannot read is refused rather than emitted", () => {
  /*
   * `utcDatePart` throws `ambiguous_price_window` for an instant it cannot slice a
   * date out of, so a malformed `at` would produce a command that is RED at HEAD
   * for a reason that has nothing to do with the price table — a confounded red
   * the bar cannot tell from the defect.
   */
  const plan = planReproduction(inputFor({ at: "12/08/2026" }));
  assert.equal(plan.available, false);
  if (plan.available) throw new Error("unreachable");
  assert.equal(plan.code, "REPRODUCTION_PARAMETERS_UNSAFE");
});

test("BOTH DIRECTIONS: a real recorded instant is accepted", () => {
  // `at` is `new Date().toISOString()` at the throw site; the record of run
  // 6ec44b2f carries exactly this shape.
  assert.equal(planReproduction(inputFor({ at: "2026-08-12T09:00:35.066Z" })).available, true);
});

/* =========================================================================
 * 4. EVERY ABSENCE IS ITS OWN NAME, AND NAMES ITS OWN BLOCKER
 * ====================================================================== */

const ABSENCES: readonly (readonly [string, Partial<ReproductionInput>, string])[] = [
  /*
   * 3 of the 7 real records. The blocker WAS a missing build output plus a manifest
   * that lives outside the archive. As of 2026-08-12 the build output half is gone
   * — `isolate.mjs` provisions bakeoff/node_modules and proves the copy compiles —
   * so the code names what is actually left: the run's own rejected manifest never
   * reaches this record. See `theRemainingBlockerIsNamed` below, which is the arm
   * that stops this absence being renamed without the reason moving with it.
   */
  ["suite authoring", { failureClass: "suite_authoring", bakeoffCode: "suite_not_audited", phase: "spec" }, "REPRODUCTION_NEEDS_THE_RECORDED_MANIFEST"],
  // 2 of the 7. The subject of the experiment is the built project, not the harness.
  ["held-out suite red in the container", { phase: "done", bakeoffCode: null, failureClass: "unclassified" }, "REPRODUCTION_NEEDS_THE_SEALED_CONTAINER"],
  // 2 of the 7. A run somebody stopped is not a run to reason about.
  ["cancelled", { status: "cancelled", bakeoffCode: null, failureClass: "unclassified" }, "REPRODUCTION_NOT_A_DEFECT"],
  ["passed", { status: "passed", bakeoffCode: null, failureClass: "none" }, "REPRODUCTION_NOT_A_DEFECT"],
  // The default. BakeoffError carries no arguments, so nothing structured travels.
  ["structural with a code that takes no recorded arguments", { bakeoffCode: "suite_hash_mismatch", failureClass: "integrity" }, "REPRODUCTION_PARAMETERS_DO_NOT_TRAVEL"],
  ["unclassified failure with no code", { bakeoffCode: null, failureClass: "unclassified" }, "REPRODUCTION_PARAMETERS_DO_NOT_TRAVEL"],
];

for (const [label, over, code] of ABSENCES) {
  test(`the absence for ${label} is named ${code}, with its own blocker`, () => {
    const plan = planReproduction(inputFor(over));
    assert.equal(plan.available, false, `${label} must not produce a command`);
    if (plan.available) throw new Error("unreachable");
    assert.equal(plan.code, code);
    assert.ok(!Object.hasOwn(plan, "command"));
    /*
     * NOT ONE GENERIC SENTENCE. The blockers are different — a build output, a
     * docker image, a missing throw-site payload — and an operator who reads the
     * same paragraph for all of them learns nothing about which one to remove.
     * 200 characters is well under every reason written today; the arm is against
     * a future edit collapsing them into "no reproduction".
     */
    assert.ok(plan.reason.length > 200, `${code} needs a reason that names its blocker, got ${String(plan.reason.length)} chars`);
  });
}

test("the suite-authoring absence names the blocker that is LEFT, and not the one that was removed", () => {
  /*
   * THE ARM THAT KEEPS THE NARROWING HONEST — and it needs both directions,
   * because either one alone passes on a sentence that says nothing.
   *
   * The temptation this refuses is renaming the code and leaving the paragraph
   * describing a build output that `isolate.mjs` now provisions (measured: 0.30s
   * copy-on-write clone of bakeoff/node_modules, `tsc --noEmit` probe 1.31s, and a
   * command carrying its own build driven through proveRepair on a real copy —
   * red 1046ms / green 1050ms / red 1049ms, PROVEN). An operator reading a stale
   * blocker goes and removes something that is already gone.
   */
  const plan = planReproduction(inputFor({ failureClass: "suite_authoring", bakeoffCode: "suite_not_audited", phase: "spec" }));
  assert.equal(plan.available, false);
  if (plan.available) throw new Error("unreachable");

  // IT NAMES WHAT IS LEFT: the run's own manifest, and where it is instead.
  assert.match(plan.reason, /manifest/i, "the absence does not name the artefact that is missing");
  assert.match(plan.reason, /dashboard\/runs/, "the absence does not say WHERE the manifest is instead");

  // AND IT NAMES WHY A CLASS-GENERIC COMMAND IS NOT A SUBSTITUTE. Measured in a
  // built copy: `node tools/replay/replay.mjs` exit 0, `node --test
  // dist/spec-validate.test.js` exit 0 — green before a patch and green after it.
  assert.match(plan.reason, /replay\.mjs/, "the absence does not say why the harness that DOES run is not a reproduction");
  assert.match(plan.reason, /COULD_NOT_REPRODUCE/, "the absence does not name what the bar would actually answer");

  // AND THE REMOVED BLOCKER IS NOT STILL BEING BLAMED. `bakeoff/dist` missing from
  // the archive was the old reason; a sentence that still leads with it sends the
  // owner to fix a solved problem.
  assert.ok(
    !/dist\/scorer-protocol\.js is (?:a build output )?absent|does not run on the isolated copy/.test(plan.reason),
    `the absence still blames the build output isolate.mjs now provisions: ${plan.reason}`,
  );
});

test("the six absence codes are distinct sentences, not one sentence six times", () => {
  const reasons = new Set(ABSENCES.map(([, over]) => {
    const plan = planReproduction(inputFor(over));
    return plan.available ? "" : plan.reason;
  }));
  // 6 inputs, 4 distinct codes, so 4 distinct sentences is the floor.
  assert.ok(reasons.size >= 4, `expected at least 4 distinct reasons, got ${String(reasons.size)}`);
});

/* =========================================================================
 * 5. THE REAL READER ACCEPTS THE RUNNABLE SHAPE AND REFUSES THE ABSENT ONE
 * ====================================================================== */

test("readReproduction — the bar's own reader — accepts the record this module writes", () => {
  const record = recordFor({});
  const read = supervisorCycle.readReproduction(record);
  assert.equal(read.ok, true, `the bar refused the record: ${String(read.code)}`);
  assert.equal(read.command, (record.reproduction as { command: string }).command);
  assert.equal(read.cases?.length, 2);
  assert.ok(read.cases?.some((c) => c.targeted !== true), "readReproduction requires an unrelated case");
});

test("BOTH DIRECTIONS: readReproduction still refuses every absence record by name", () => {
  /*
   * THE ABSENCE MUST NOT SATISFY THE READER. This is the arm that keeps the
   * change honest: a `reproduction` block that made `readReproduction` answer
   * `ok` without a runnable command would send a candidate patch to a prover that
   * runs nothing, and every patch would look proven.
   */
  for (const [label, over] of ABSENCES) {
    const record = recordFor({
      status: over.status ?? "failed",
      phase: over.phase ?? "build",
      failureClass: over.failureClass ?? "unclassified",
      bakeoffCode: over.bakeoffCode === undefined ? null : over.bakeoffCode,
    });
    const read = supervisorCycle.readReproduction(record);
    assert.equal(read.ok, false, `${label} must not read as reproducible`);
    assert.equal(read.code, "NO_REPRODUCTION_COMMAND", label);
  }
});

test("a record with no reproduction block at all still reads as NO_REPRODUCTION_COMMAND", () => {
  // Every `results/defect.json` written before today is this shape, and the bar
  // must go on refusing them rather than throwing inside a supervisor tick.
  const legacy = { signature: "a".repeat(64), attempts: [] };
  assert.equal(supervisorCycle.readReproduction(legacy).code, "NO_REPRODUCTION_COMMAND");
});

/* =========================================================================
 * 6. THE SIGNATURE DID NOT MOVE
 * ====================================================================== */

test("the digest of a class already on disk is byte-identical after this change", () => {
  /*
   * READ OFF A REAL RECORD: `dashboard/runs/run-2026-08-11T00-24-14-388Z-aa6e721e/
   * results/defect.json` carries this digest for site `spec/failed/suite_not_audited`
   * with no violations, and so do two other runs. The shard is
   * `data/defects/<signature>.jsonl`, so a signature that moved would file the
   * next occurrence of an already-recorded class in a fresh file where it reads
   * as a first occurrence — and the anti-loop guard is signature comparison.
   */
  assert.equal(
    defectSignature("spec/failed/suite_not_audited", []),
    "2650ca82aa3e5ffc03074058d0d8320431bc65eba67108f7e9ae65c03d55c3f0",
  );
});

test("two records with the same site and different reproductions share one signature", () => {
  const priced = recordFor({ site: "build/failed/x" });
  const absent = recordFor({ site: "build/failed/x", bakeoffCode: "suite_not_audited", failureClass: "suite_authoring" });
  assert.notDeepEqual(priced.reproduction, absent.reproduction, "the fixtures must actually differ or this proves nothing");
  assert.equal(priced.signature, absent.signature);
});

/* =========================================================================
 * 7. THE FIELD IS ALWAYS THERE
 * ====================================================================== */

test("every record carries a reproduction, and an unavailable one says why", () => {
  for (const [, over] of ABSENCES) {
    const record = recordFor({
      status: over.status ?? "failed",
      phase: over.phase ?? "build",
      failureClass: over.failureClass ?? "unclassified",
      bakeoffCode: over.bakeoffCode === undefined ? null : over.bakeoffCode,
    });
    assert.equal(typeof record.reproduction, "object");
    assert.equal(record.reproduction.available, false);
    if (record.reproduction.available) throw new Error("unreachable");
    assert.ok(record.reproduction.code.trim() !== "", "an absence with no code is the same as no absence");
  }
});

test("the record survives JSON, which is how the bar actually receives it", () => {
  // `runSupervisorCycle` reads `results/defect.json` with JSON.parse, so anything
  // that does not round-trip is invisible to the bar however good it looks here.
  const record = recordFor({});
  const read = supervisorCycle.readReproduction(JSON.parse(JSON.stringify(record)));
  assert.equal(read.ok, true, `the bar refused the round-tripped record: ${String(read.code)}`);
});
