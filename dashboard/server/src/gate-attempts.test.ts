/**
 * gate-attempts.test.ts — the fix loop re-gates, so the gate's output has to
 * survive being produced more than once.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { containerFixture, tier0Fixture } from "./container-fixture.js";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import { archiveAttempt, attemptPath, readAttempt, scorerOutRoot } from "./gate-attempts.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

const dirs: string[] = [];

function tmpPaths(): DashboardPaths {
  const dir = mkdtempSync(join(tmpdir(), "dash-attempt-"));
  dirs.push(dir);
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  return paths;
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * What the SEALED SCORER writes, at the one path it writes it.
 *
 * `bakeoff/src/scorer.ts` builds its out-dir as
 * `join(resultsDir, "scorer-out", safeSegment(run.runId))` and `bakeoff/` is not
 * ours to modify, so a second gate run overwrites the first in place. The test
 * therefore simulates the overwrite rather than pretending each attempt gets its
 * own directory for free.
 */
function scorerWrites(paths: DashboardPaths, runId: string, container: ContainerResult): void {
  const dir = join(scorerOutRoot(paths), runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(container), "utf8");
}

test("two gate attempts do not collide", () => {
  // The loop re-gates. If attempt 2 overwrites attempt 1, the run record loses
  // the history that explains WHY it took three rounds — and a partial write
  // could be read as a complete result.
  const paths = tmpPaths();

  scorerWrites(paths, "r1", containerFixture({ tier0: [tier0Fixture({ id: "GATE:build", outcome: "fail" })] }));
  assert.equal(archiveAttempt(paths, "r1", 1), true, "attempt 1 had a result to archive");

  // The scorer runs again and clobbers its own output, exactly as it does live.
  scorerWrites(paths, "r1", containerFixture({ tier0: [tier0Fixture({ id: "GATE:build", outcome: "pass" })] }));
  assert.equal(archiveAttempt(paths, "r1", 2), true);

  assert.equal(readAttempt(paths, "r1", 1)?.tier0[0]?.outcome, "fail", "attempt 1 survived attempt 2");
  assert.equal(readAttempt(paths, "r1", 2)?.tier0[0]?.outcome, "pass");
});

test("attempt paths stay inside the sealed root's deny", () => {
  // scorer-out is a sealed root (Phase 0) — it is named in `sealedRoots` and
  // denied to every builder. Sub-paths must inherit that, or the loop quietly
  // creates a readable copy of held-out test titles beside it.
  const paths = tmpPaths();
  const p = attemptPath(paths, "r1", 2);
  const rel = relative(scorerOutRoot(paths), p);
  assert.ok(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel), `${p} escaped the sealed root`);
  assert.match(p, /attempt-2/, "the attempt number is in the path, so attempts cannot overwrite each other");
});

test("a gate that produced no result archives nothing and reads back null", () => {
  // "The gate could not run" must not be indistinguishable from "the gate
  // passed" — including one level down, in the file the loop reads.
  const paths = tmpPaths();
  assert.equal(archiveAttempt(paths, "r-empty", 1), false, "there was nothing to archive");
  assert.equal(readAttempt(paths, "r-empty", 1), null);
});

test("an unparseable attempt is null, not a half-read result", () => {
  const paths = tmpPaths();
  const dir = join(scorerOutRoot(paths), "r-bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), "{ not json", "utf8");
  assert.equal(archiveAttempt(paths, "r-bad", 1), true, "the bytes were archived; reading them is a separate question");
  assert.equal(readAttempt(paths, "r-bad", 1), null);
});
