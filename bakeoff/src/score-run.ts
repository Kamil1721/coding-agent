/**
 * score-run.ts — drive the sealed gate across a results tree.
 *
 * INTEGRATION GAP THIS CLOSES. `screen` wrote run records. `report` read score
 * records. Nothing in the tree turned the first into the second: `score`
 * validated the gate seam and returned. The pipeline had no middle, so the
 * co-primary metrics could never be produced, with or without credentials.
 *
 * WHAT THIS MODULE MAY AND MAY NOT DO:
 *
 *  - It NEVER opens a suite file. It reads FROZEN.json (the manifest) and hands
 *    the {@link AcceptanceSuite} to the gate, which is the only code that
 *    touches the held-out bytes, and only inside the sealed container.
 *  - It NEVER computes `heldOutPass` or `falseFinish`. Those come back from the
 *    gate, computed by the single definitions in contracts.ts.
 *  - It refuses to score a run whose recorded suite digest is not the digest of
 *    the suite on disk. A run built against suite X scored against suite Y is a
 *    number that looks like a result and is not one.
 *  - It scores only runs the harness itself completed. A run that ended in
 *    `error` is a harness fault and is excluded from every denominator; scoring
 *    it would charge a harness bug to a configuration.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BakeoffError } from "./contracts.js";
import type { AcceptanceGate, AcceptanceSuite, RunRecord, RunStatus } from "./contracts.js";
import { redactForPersistence } from "./redact.js";
import { PERSIST_REDACT_OPTIONS } from "./ledger.js";
import { readFrozenSuite } from "./campaign.js";

/** The file the runner writes, one JSON line, per run directory. */
export const RUN_RECORD_FILENAME = "run.jsonl";
/** Written beside it. `.jsonl` because the reporter collects `**\/*.jsonl`. */
export const SCORE_RECORD_FILENAME = "score.jsonl";

/**
 * Statuses worth scoring.
 *
 * `completed`, `timeout` and `budget_exceeded` are all real outcomes of a real
 * attempt and all three can still produce a passing artefact — a run killed on
 * a budget boundary may well have finished the work first. `error` is a harness
 * fault. `blocked` is a first-class outcome (doc 03 section 8.3) and is scored
 * too: a builder that declared BLOCKED and shipped a working app is a fact
 * worth measuring, and one that declared BLOCKED and shipped nothing simply
 * fails the suite, which is the honest reading.
 */
const SCORABLE: readonly RunStatus[] = Object.freeze([
  "completed",
  "timeout",
  "budget_exceeded",
  "blocked",
]);

export interface LoadedRun {
  readonly record: RunRecord;
  /** Directory the run.jsonl was read from. The score is written beside it. */
  readonly dir: string;
}

function fail(message: string, remediation: string): never {
  throw new BakeoffError("invalid_usage_shape", message, remediation);
}

/**
 * Validate the fields the gate and the reporter actually consume.
 *
 * Deliberately not a full structural clone of RunRecord: this checks what is
 * load-bearing here and names the missing field when something is wrong, rather
 * than surfacing `undefined is not an object` three frames deeper.
 */
function parseRunRecord(value: unknown, where: string): RunRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where}: not a JSON object`, "Each run.jsonl holds exactly one RunRecord on one line.");
  }
  const o = value as Record<string, unknown>;
  const str = (name: string): string => {
    const v = o[name];
    if (typeof v !== "string" || v.length === 0) {
      fail(`${where}: field "${name}" is missing or not a non-empty string`, REGENERATE);
    }
    return v;
  };
  const bool = (name: string): boolean => {
    const v = o[name];
    if (typeof v !== "boolean") fail(`${where}: field "${name}" is missing or not a boolean`, REGENERATE);
    return v;
  };
  // Every field the gate or the reporter reads, checked here so a malformed
  // record names its own missing field rather than failing three frames deeper.
  for (const name of ["runId", "ticketId", "configId", "artifactPath"]) str(name);
  bool("agentDeclaredDone");

  const held = o["heldConstants"];
  if (held === null || typeof held !== "object") {
    fail(`${where}: field "heldConstants" is missing`, REGENERATE);
  }
  const heldObj = held as Record<string, unknown>;
  const suiteSha = heldObj["acceptanceSuiteSha256"];
  if (typeof suiteSha !== "string" || !/^[0-9a-f]{64}$/.test(suiteSha)) {
    fail(
      `${where}: heldConstants.acceptanceSuiteSha256 is missing or is not a sha-256 digest`,
      "Without the digest of the suite the run was built against, this run cannot be proved to be " +
        "comparable with any other. Re-run it; do not score it.",
    );
  }
  const status = o["status"];
  if (typeof status !== "string") fail(`${where}: field "status" is missing`, REGENERATE);

  // Cast is safe for the consumed surface: every field the gate reads has been
  // checked above. The gate itself re-verifies run/suite agreement.
  return o as unknown as RunRecord & { readonly status: RunStatus };
}

const REGENERATE =
  "This file is written by the runner. A run record that cannot be read cannot be scored — " +
  "re-run the attempt rather than hand-editing the record.";

/** Every `run.jsonl` under `resultsRoot`, recursively, in sorted path order. */
export function loadRunRecords(resultsRoot: string): readonly LoadedRun[] {
  if (!existsSync(resultsRoot)) {
    fail(
      `no results directory at ${resultsRoot}`,
      "Run `screen` (or `--dry-run`) first, or point --results at the directory the runner wrote to.",
    );
  }
  const found: LoadedRun[] = [];
  const seen = new Map<string, string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name !== RUN_RECORD_FILENAME) continue;
      const text = readFileSync(full, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length !== 1) {
        fail(
          `${full}: expected exactly one run record, found ${String(lines.length)}`,
          "The runner writes one RunRecord per run directory. More than one means two runs shared a " +
            "results directory, and their records cannot be told apart.",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[0] as string);
      } catch (error) {
        fail(
          `${full}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
          REGENERATE,
        );
      }
      const record = parseRunRecord(parsed, full);
      const previous = seen.get(record.runId);
      if (previous !== undefined) {
        fail(
          `duplicate runId ${JSON.stringify(record.runId)} in ${previous} and ${full}`,
          "Two records with the same runId would be counted twice in every rate. Remove the copy.",
        );
      }
      seen.set(record.runId, full);
      found.push({ record, dir: dirname(full) });
    }
  };

  walk(resultsRoot);
  return found;
}

/** Why a run was not scored. Never a silent omission. */
export interface SkippedRun {
  readonly runId: string;
  readonly reason: string;
}

export interface ScoringOutcome {
  readonly scored: number;
  readonly alreadyScored: number;
  readonly skipped: readonly SkippedRun[];
  /** Runs whose scoring threw. The campaign continues; the failure is reported. */
  readonly failed: readonly SkippedRun[];
  readonly heldOutPasses: number;
  readonly falseFinishes: number;
}

export interface ScoreRunsOptions {
  readonly resultsRoot: string;
  readonly acceptanceRoot: string;
  readonly gate: AcceptanceGate;
  /** Re-score runs that already have a score record. Default false. */
  readonly rescore?: boolean;
  /** Progress lines. Routed through the CLI's redaction chokepoint. */
  readonly emit: (text: string) => void;
}

/**
 * Score every scorable run that has no score record yet.
 *
 * A gate failure on one run does not abort the pass — except for
 * `suite_hash_mismatch`, which is a TAMPERING verdict and stops everything.
 * Continuing after tamper detection would score later runs against a yardstick
 * already known to have moved.
 */
export async function scoreRuns(options: ScoreRunsOptions): Promise<ScoringOutcome> {
  const runs = loadRunRecords(options.resultsRoot);
  const suites = new Map<string, AcceptanceSuite>();
  const skipped: SkippedRun[] = [];
  const failed: SkippedRun[] = [];
  let scored = 0;
  let alreadyScored = 0;
  let heldOutPasses = 0;
  let falseFinishes = 0;

  for (const { record, dir } of runs) {
    const scorePath = join(dir, SCORE_RECORD_FILENAME);
    if (existsSync(scorePath) && options.rescore !== true) {
      alreadyScored += 1;
      continue;
    }
    if (!SCORABLE.includes(record.status)) {
      skipped.push({
        runId: record.runId,
        reason:
          `status "${record.status}" is a harness fault, not a model outcome. It is excluded from ` +
          "every denominator on purpose: charging a harness bug to a configuration is how a " +
          "measurement quietly becomes wrong.",
      });
      continue;
    }

    let suite = suites.get(record.ticketId);
    if (suite === undefined) {
      const loaded = readFrozenSuite(options.acceptanceRoot, record.ticketId);
      if (loaded === null) {
        skipped.push({
          runId: record.runId,
          reason:
            `no sealed suite for ticket ${record.ticketId} under ${options.acceptanceRoot}. The ` +
            "suite is authored once per ticket, before any build run, and must still be there to " +
            "score against.",
        });
        continue;
      }
      suite = loaded;
      suites.set(record.ticketId, suite);
    }

    // The run must have been built against THIS suite. The gate re-checks the
    // bytes on disk; this checks the recorded intent, which the gate cannot see.
    if (record.heldConstants.acceptanceSuiteSha256 !== suite.sha256) {
      skipped.push({
        runId: record.runId,
        reason:
          `the run was built against suite ${record.heldConstants.acceptanceSuiteSha256.slice(0, 12)}... ` +
          `but the sealed suite on disk is ${suite.sha256.slice(0, 12)}.... Held-constant variable 5 ` +
          "requires every configuration to build against the same suite for the same ticket. Do not " +
          "score this; re-run it against the current suite, or restore the suite it was run against.",
      });
      continue;
    }

    try {
      const score = await options.gate.score(record, suite);
      mkdirSync(dirname(scorePath), { recursive: true });
      writeFileSync(
        scorePath,
        `${JSON.stringify(redactForPersistence(score, PERSIST_REDACT_OPTIONS))}\n`,
        "utf8",
      );
      scored += 1;
      if (score.heldOutPass) heldOutPasses += 1;
      if (score.falseFinish) falseFinishes += 1;
      options.emit(
        `  ${record.runId}: heldOutPass=${String(score.heldOutPass)} ` +
          `falseFinish=${String(score.falseFinish)}`,
      );
    } catch (error) {
      if (error instanceof BakeoffError && error.code === "suite_hash_mismatch") {
        // Do not continue. Every later run would be scored against a yardstick
        // already known to have moved, which launders the tampering into a
        // normal-looking column of results.
        throw error;
      }
      failed.push({
        runId: record.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scored, alreadyScored, skipped, failed, heldOutPasses, falseFinishes };
}

/** Human-readable summary. Contains no test content and no credential. */
export function formatScoringOutcome(outcome: ScoringOutcome): string {
  const lines: string[] = [];
  lines.push(
    `scored ${String(outcome.scored)} run(s); ${String(outcome.alreadyScored)} already had a score record`,
  );
  if (outcome.scored > 0) {
    lines.push(
      `  held-out passes: ${String(outcome.heldOutPasses)}/${String(outcome.scored)}   ` +
        `false finishes: ${String(outcome.falseFinishes)}/${String(outcome.scored)}`,
    );
  }
  if (outcome.skipped.length > 0) {
    lines.push("", `NOT SCORED (${String(outcome.skipped.length)}) — never a silent omission:`);
    for (const s of outcome.skipped) lines.push(`  ${s.runId}: ${s.reason}`);
  }
  if (outcome.failed.length > 0) {
    lines.push("", `SCORING FAILED (${String(outcome.failed.length)}):`);
    for (const f of outcome.failed) lines.push(`  ${f.runId}: ${f.reason}`);
  }
  return lines.join("\n");
}

/** True when a run directory already holds a score record. */
export function hasScoreRecord(runDir: string): boolean {
  return existsSync(join(runDir, SCORE_RECORD_FILENAME)) && statSync(join(runDir, SCORE_RECORD_FILENAME)).isFile();
}
