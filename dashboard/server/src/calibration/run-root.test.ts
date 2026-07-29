/**
 * calibration/run-root.test.ts — where a calibration run puts its files, and
 * the proof that two runs do not land on top of each other.
 *
 * THE INCIDENT THIS EXISTS FOR, 2026-07-29. `CALIBRATION_RUN_ROOT` was a module
 * constant with no override, and `prepareFixtureDirs` opens every fixture with
 * an `rm -rf` of `<root>/<fixture>`. Two processes therefore shared one tree:
 * one running `dist/calibration.test.js` while a second's container died with
 * `ENOENT: mkdir '/scorer/out'` on 5 of 7 fixtures, twice. It presents as a
 * GRADER failure — the fixture "did not score" — so the person debugging the
 * calibration regression is chasing a phantom, and this repo's whole thesis is
 * that a check must not be able to lie about what it saw.
 *
 * THE ASSERTION THAT CARRIES THE FIX IS THE SENTINEL, NOT THE PATH STRING. A
 * test that only compared `calibrationRunRoot(env)` to the env value would pass
 * against an implementation that reads the override and then resets the default
 * tree anyway, which is the failure that happened. So the reset is RUN, against
 * two real roots, and each root's own file is checked afterwards — the one that
 * was pointed at must be gone and the other must still be there.
 *
 * NOT A FIXTURE NAME ANY CALIBRATION USES. `PROBE` is deliberately not in
 * `FIXTURES`: this test hands `prepareFixtureDirs` a destructive operation, and
 * an implementation that ignored the override would aim it at the default root —
 * where a concurrent calibration's real run state lives.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { BAKEOFF_ROOT } from "../paths.js";
import {
  CALIBRATION_ROOT_ENV,
  DEFAULT_CALIBRATION_RUN_ROOT,
  calibrationRunRoot,
  prepareFixtureDirs,
} from "./grade-fixture.js";

/** A name no calibration fixture has, so nothing here can aim at a real run. */
const PROBE = "__run-root-probe__";

/** A previous run's output, in the place a real one would leave it. */
function seedPreviousRun(root: string): string {
  const sentinel = join(root, PROBE, "results", "scores", "cal-probe.json");
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, '{"note":"a previous run\'s score record"}', "utf8");
  return sentinel;
}

test("the calibration run root defaults to dashboard/results/calibration-4a and is overridable", () => {
  // NO SIDE EFFECT IN THIS TEST. The default is asserted as a path only: the
  // real directory is live run state and `prepareFixtureDirs` deletes what it
  // is pointed at.
  assert.equal(calibrationRunRoot({}), DEFAULT_CALIBRATION_RUN_ROOT, "no env set is the shipped path");
  assert.match(
    DEFAULT_CALIBRATION_RUN_ROOT,
    /dashboard\/results\/calibration-4a\/?$/,
    "and the shipped path is still under dashboard/results, which .gitignore excludes as run state",
  );
  assert.equal(
    calibrationRunRoot({ [CALIBRATION_ROOT_ENV]: "   " }),
    DEFAULT_CALIBRATION_RUN_ROOT,
    "whitespace is not a path; an empty override takes the default rather than resetting the cwd",
  );

  const absolute = join(tmpdir(), "cal-root-absolute");
  assert.equal(calibrationRunRoot({ [CALIBRATION_ROOT_ENV]: absolute }), absolute);
  assert.equal(
    calibrationRunRoot({ [CALIBRATION_ROOT_ENV]: "relative/cal" }),
    resolve(process.cwd(), "relative/cal"),
    "a relative override resolves against cwd, exactly as DASHBOARD_HOME does in paths.ts",
  );
});

test("two calibration roots genuinely isolate — one run's reset does not delete the other's tree", () => {
  const rootA = mkdtempSync(join(tmpdir(), "cal-root-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "cal-root-b-"));
  const sentinelA = seedPreviousRun(rootA);
  const sentinelB = seedPreviousRun(rootB);

  const paths = prepareFixtureDirs(PROBE, { [CALIBRATION_ROOT_ENV]: rootA });

  // The output really went where it was pointed — a directory that exists, not
  // a string that was returned.
  assert.equal(paths.base, join(rootA, PROBE));
  for (const dir of [paths.base, paths.acceptanceRoot, paths.resultsDir, paths.runDir]) {
    assert.ok(existsSync(dir), `${dir} was not created under the root this call was given`);
  }

  // The reset ran, so the "B survived" assertion below is not an inert path.
  assert.equal(existsSync(sentinelA), false, "the reset must really clear its OWN root, or it grades stale output");

  // THE FIX, IN ONE LINE. This is the file the second process was still using.
  assert.ok(
    existsSync(sentinelB),
    "a run under one root deleted another root's tree — the concurrent-calibration failure that " +
      "presents as `ENOENT: mkdir '/scorer/out'` and reads exactly like a grader failure",
  );

  // POSITIVE CONTROL, the other way round: B's sentinel IS deletable, so its
  // survival above was isolation rather than an unreachable path.
  prepareFixtureDirs(PROBE, { [CALIBRATION_ROOT_ENV]: rootB });
  assert.equal(existsSync(sentinelB), false, "control: pointed at B, the reset clears B");
  assert.equal(existsSync(join(rootA, PROBE)), true, "and A, freshly prepared, is still standing");
});

/**
 * The guard e6176eb deliberately shipped WITHOUT, because an unverified guard is
 * the defect that commit was fixing wearing a safety vest. This is its red test.
 *
 * WHY THE BAKE-OFF TREE SPECIFICALLY. `paths.ts` states it: `bakeoff`'s `score`
 * and `report` discover work by WALKING a results directory for `run.jsonl`, so
 * anything the dashboard writes under `bakeoff/` can be aggregated into a
 * campaign's co-primary metrics. `DASHBOARD_CALIBRATION_ROOT` was the one
 * dashboard-owned path with no such check, and it is the destructive one —
 * `prepareFixtureDirs` opens with an `rm -rf` of `<root>/<fixture>`.
 *
 * THE ASSERTION IS THE FILESYSTEM, NOT THE THROW. `assert.throws` alone fails
 * with "Missing expected exception", which says nothing about what the unguarded
 * call DID. So the call is made, the tree it left is observed, and the
 * observation is asserted. MEASURED RED before the guard existed: the call
 * created `<bakeoff>/results/__cal-root-guard-probe__/__run-root-probe__/` with
 * `acceptance/`, `results/` and `run/` inside it — an `rm -rf` and four mkdirs
 * aimed into the bake-off tree, which is the hazard rather than a missing
 * exception.
 *
 * IT CLEANS UP BEFORE IT ASSERTS, so a red run does not leave a tree inside
 * `bakeoff/` for whoever runs next.
 *
 * TWO MUTATIONS, 2026-07-29, and the second one's result is reported rather than
 * spun:
 *   A. `assertOutsideBakeoff` wrapped so containment still holds but the message
 *      does not (`throw new Error("MUTATION A: …")`). This test alone goes RED —
 *      1 of 3, on the `thrown.message` clause — while the `created` clause stays
 *      green. So the message clause is a real second check, not decoration.
 *   B. An unconditional throw in `calibrationRunRoot`. All THREE tests in this
 *      file go red. The `doesNotThrow` clauses below therefore do NOT fail alone:
 *      their failure mode is a subset of the two tests above, which already run
 *      legitimate roots through `calibrationRunRoot` and `prepareFixtureDirs`
 *      and are the real false-positive control for this guard. They are kept as
 *      REDUNDANCY, so this test states both directions without the reader having
 *      to hold the rest of the file in their head — not as an extra check. This
 *      repo's rule is that a check whose failure mode is a subset of a louder
 *      one's is not a second check; saying so beats letting them look like one.
 */
test("a run root inside bakeoff/ is REFUSED — the override drives an rm -rf", () => {
  // Under `bakeoff/results/`, which .gitignore already excludes: if the guard is
  // ever removed, the red run's debris cannot reach a commit. `prepareFixtureDirs`
  // writes no `run.jsonl`, so nothing here is discoverable by a campaign `score`.
  const probeRoot = join(BAKEOFF_ROOT, "results", "__cal-root-guard-probe__");
  assert.equal(existsSync(probeRoot), false, "the probe root must not pre-exist, or this test grades a leftover");

  let thrown: unknown = null;
  try {
    prepareFixtureDirs(PROBE, { [CALIBRATION_ROOT_ENV]: probeRoot });
  } catch (error) {
    thrown = error;
  }
  const created = existsSync(join(probeRoot, PROBE));
  rmSync(probeRoot, { recursive: true, force: true });

  assert.equal(
    created,
    false,
    `prepareFixtureDirs CREATED ${join(probeRoot, PROBE)} — it ran its rm -rf and four mkdirs inside the ` +
      "bake-off tree. `bakeoff score`/`report` discover runs by walking a results directory, so dashboard " +
      "state landing there is aggregated into a campaign's co-primary metrics (paths.ts)",
  );
  assert.ok(
    thrown instanceof Error && /inside the bake-off tree/.test(thrown.message),
    `the call did not refuse a root inside ${BAKEOFF_ROOT}; it threw ${
      thrown instanceof Error ? JSON.stringify(thrown.message) : String(thrown)
    }`,
  );

  // REDUNDANT BY MEASUREMENT (mutation B above), KEPT ANYWAY: a scratch root
  // outside both trees is still accepted, so the assertions above are
  // containment rather than a blanket refusal. The two tests above already fail
  // against a blanket refusal, so this cannot go red on its own.
  const outside = mkdtempSync(join(tmpdir(), "cal-root-outside-"));
  assert.doesNotThrow(() => prepareFixtureDirs(PROBE, { [CALIBRATION_ROOT_ENV]: outside }));
  assert.ok(existsSync(join(outside, PROBE)), "a legitimate scratch root must still be prepared");

  // AND THE SHIPPED DEFAULT, resolved but never prepared — `prepareFixtureDirs`
  // on it would delete a live calibration's run state. This is the path the
  // standing gate uses with no env set at all, and the reason the guard is
  // applied to the RESOLVED root rather than only to a non-empty override.
  assert.doesNotThrow(
    () => calibrationRunRoot({}),
    "the guard rejects the root calibration uses by default, which takes the whole gate down",
  );
});
