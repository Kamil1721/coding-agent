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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
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
