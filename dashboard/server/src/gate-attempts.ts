/**
 * gate-attempts.ts — one gate run per attempt, and none of them overwriting the
 * one before it.
 *
 * WHY THIS FILE EXISTS. `#gatePhase` used to run exactly once per run, so the
 * scorer's habit of writing to a fixed path was harmless. The GATE/FIX loop
 * (Phase 2d) re-gates after every fix round, and the sealed scorer builds its
 * output directory as
 *
 *     join(resultsDir, "scorer-out", safeSegment(run.runId))          <- bakeoff/src/scorer.ts
 *
 * with no attempt in it. `bakeoff/` is not ours to modify, and mangling
 * `RunRecord.runId` to make the scorer choose a different directory is worse
 * than the problem: the same id also names `results/screenshots/<runId>/` (which
 * `#recordScreenshots` reads) and the tamper report path quoted in the
 * suite-tamper remediation. So the attempt boundary is drawn on the HOST, after
 * the scorer returns: the result is archived into `attempt-<n>/` before the next
 * attempt is allowed to clobber it.
 *
 * THE ARCHIVE STAYS INSIDE THE SEALED ROOT, and that is the whole reason it is a
 * subdirectory of `scorer-out/<runId>/` rather than somewhere more convenient.
 * `results/scorer-out` is passed to every builder as a `sealedRoot` (Phase 0)
 * because `result.json` carries `criterionCoverage[].testRefs` — held-out TEST
 * TITLES. An attempt archive is a copy of exactly that file. Anywhere outside
 * the sealed root and the loop would have quietly created a readable copy of the
 * held-out suite's identities, defeating the deny it inherits here for free.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseContainerResult } from "bakeoff/dist/scorer-protocol.js";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import { safeSegment } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

/** The sealed root. One definition — the orchestrator names it as a deny too. */
export function scorerOutRoot(paths: DashboardPaths): string {
  return join(paths.results, "scorer-out");
}

/**
 * The score-record root, and it is SEALED for the same reason `scorer-out` is.
 *
 * FOUND 2026-07-30 by inspecting a real run's output rather than the code. The
 * committed `ScoreRecord` for the live end-to-end run carries held-out test titles
 * VERBATIM — `criterionCoverage[].testRefs[0]` reads
 * `holdout/coglane-delivery.test.mjs › [REQ-001] T-1 the root document answers 200
 * …`, 24 such strings in one file — and `results/scores` was named in NO deny
 * layer. `sealedRoots` was `[acceptance, scorer-out]`.
 *
 * WHY THAT IS WORSE THAN IT LOOKS. The suite is frozen per ticket and reused
 * across attempts, so a builder that read a PREVIOUS run's score record would
 * learn the titles it is about to be graded against — and `heldOutPass` would
 * stay `true` while meaning nothing. Nothing detects that: the leak is a read the
 * builder is permitted to make, in a directory whose name suggests results rather
 * than answers.
 *
 * One definition, like `scorerOutRoot` above, and for the reason its comment
 * gives: spelling the path a second time at the deny site is how a later writer
 * lands outside the deny it was supposed to inherit.
 */
export function scoresRoot(paths: DashboardPaths): string {
  return join(paths.results, "scores");
}

/**
 * The repair lane's report root, and it is SEALED for the third time for the
 * SAME reason — which is the point of writing it here rather than at the deny.
 *
 * FOUND 2026-08-16 by a debugfix lens, and it is the third instance of one
 * pattern: a new artefact directory is added under `results/`, its content is
 * derived from held-out material, and the deny list is not updated because the
 * deny list is a hand-written array somewhere else. `results/scores` was the
 * second (see above, 2026-07-30). This is the third, caught BEFORE it shipped
 * rather than after.
 *
 * WHAT THE REPORTS CONTAIN. `repair-report.ts` composes owner-facing prose from
 * the defect record and from `adjudicate.ts`'s verdict reasons, which quote a
 * `TestFailure`'s `titlePath`, `expected` and `actual` verbatim. The scorer
 * protocol is explicit about that type (`scorer-protocol.ts`, {@link TestFailure}):
 * it "lives ONLY under `results/scorer-out`, which is a sealed root … copying a
 * `TestFailure` anywhere a build can read is a held-out leak, and there is no
 * tripwire that would catch it."
 *
 * SEALED WHILE THE LEAK IS STILL ONLY PLAUSIBLE, deliberately. Nothing calls
 * `deliverRepairReport` yet, so no report exists to be read and the exploit
 * cannot be demonstrated today. Containment costs one array entry; the leak it
 * prevents is undetectable after the fact, and the suite is frozen per ticket
 * and reused across attempts, so the window is every later attempt on the same
 * ticket. Waiting for it to become demonstrable means waiting for a run whose
 * `heldOutPass` is worthless and unmarked.
 */
/**
 * THE WHOLE RESULTS TREE, SEALED AS ONE — and this replaces enumerating its
 * children, because enumerating them has now missed a directory THREE TIMES.
 *
 *   2026-07-30  `results/scores` was in no deny layer. Held-out test titles,
 *               verbatim, 24 in one file.
 *   2026-08-16  `results/repair-reports` was in no deny layer (caught before it
 *               shipped, because nothing writes there yet).
 *   2026-08-16  and the fix for THAT sealed two directories which DO NOT EXIST
 *               while `results/calibration-4a` and `-4b` — 484 files holding
 *               complete held-out suite SOURCES, real `TestFailure` records and
 *               the reward-hacking detector's own rule corpus — stayed readable.
 *               Measured with the real permission predicate: ALLOW.
 *
 * The pattern is not carelessness, it is the shape of the check. A hand-written
 * list of children is a deny that fails OPEN for anything added later, and the
 * things added later are exactly the new artefact directories nobody thought to
 * re-check. Sealing the PARENT fails CLOSED instead: a new child is denied on
 * the day it is created, and the cost of being wrong is a build that cannot read
 * something it needs — loud, immediate, and fixable — rather than a held-out
 * leak, which is silent and undetectable after the fact.
 *
 * NOTHING UNDER HERE IS BUILD INPUT. The artefact is built in
 * `runs/<id>/workspace`; `results/` is where the GRADER's output goes.
 */
export function resultsRoot(paths: DashboardPaths): string {
  return paths.results;
}

export function repairReportsRoot(paths: DashboardPaths): string {
  return join(paths.results, "repair-reports");
}

/**
 * The repair lane's PROOF transcripts — the raw output of the reproduce/fix/
 * ablate runs, which quote the failing test's own output.
 *
 * Same reasoning as {@link repairReportsRoot}; named separately because it is a
 * separate directory and this file's own comments record what happens when a
 * path is assumed to be covered by a neighbouring deny.
 *
 * NEITHER OF THESE TWO IS LOAD-BEARING FOR THE DENY ANY MORE, and saying so
 * matters: {@link resultsRoot} seals their parent, so a writer that lands beside
 * them rather than inside them is still denied. They are kept as the single
 * definition of WHERE the repair lane writes, which `repair-report.ts` is bound
 * to by a test, and not as the thing that protects it.
 */
export function repairProofsRoot(paths: DashboardPaths): string {
  return join(paths.results, "repair-proofs");
}

/** Where the scorer itself writes, and therefore where every attempt starts. */
export function liveResultPath(paths: DashboardPaths, runId: string): string {
  return join(scorerOutRoot(paths), safeSegment(runId), "result.json");
}

export function attemptDir(paths: DashboardPaths, runId: string, attempt: number): string {
  return join(scorerOutRoot(paths), safeSegment(runId), `attempt-${String(Math.trunc(attempt))}`);
}

export function attemptPath(paths: DashboardPaths, runId: string, attempt: number): string {
  return join(attemptDir(paths, runId, attempt), "result.json");
}

/**
 * Preserve this attempt's `result.json` before the next attempt overwrites it.
 *
 * Returns false when the scorer produced no result at all — a gate that could
 * not run. That distinction is carried rather than smoothed over: "no result"
 * and "a passing result" must never look alike, at any level of this program.
 *
 * The bytes are copied verbatim and NOT parsed on the way through. An
 * unparseable result is still evidence about the attempt that produced it, and
 * an archive that silently dropped it would delete the only record of a scorer
 * that wrote garbage.
 */
export function archiveAttempt(paths: DashboardPaths, runId: string, attempt: number): boolean {
  const live = liveResultPath(paths, runId);
  if (!existsSync(live)) return false;
  const dir = attemptDir(paths, runId, attempt);
  mkdirSync(dir, { recursive: true });
  copyFileSync(live, join(dir, "result.json"));
  return true;
}

/** The archived result for one attempt, or null when there is none to read. */
export function readAttempt(paths: DashboardPaths, runId: string, attempt: number): ContainerResult | null {
  const path = attemptPath(paths, runId, attempt);
  if (!existsSync(path)) return null;
  try {
    return parseContainerResult(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}
