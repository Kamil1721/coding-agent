/**
 * defect-record.ts — the two records a terminal transition leaves behind, and
 * the reason they are written even when there is nothing to say.
 *
 * ─── WHAT THIS REPLACES ───
 *
 * Run `a913c871` died at 22:31:04.532Z after 1h26m54s and left, in the harness,
 * a `runs` row with a status and a prose `failure_reason`. Its three authoring
 * attempts existed in NO harness artefact at all: they were reconstructed nine
 * hours later from the Claude Code CLI's own session transcripts, keyed by the
 * seat's cwd. A different cwd, or retention off, and the post-mortem would have
 * had nothing.
 *
 * So two files are written at every terminal transition:
 *
 *   results/defect.json          — one machine-readable row per terminal run
 *   results/authoring-trail.json — what the spec phase attempted, on BOTH paths
 *
 * plus an append-only, content-addressed shard at
 * `data/defects/<signature>.jsonl`, so the second occurrence of a class is
 * findable without reading every run directory.
 *
 * ─── THE RULE THIS MODULE IS BUILT AROUND ───
 *
 * ABSENCE IS NOT EMPTINESS. `violations: []` reads as "the classifier looked and
 * found none"; `attempts: []` reads as "the seat made no attempt". Both are
 * false on a run whose evidence simply does not travel yet — the structured
 * `DefectDetail` of the design's §3.2 is a digest-moving change that has not
 * landed, and `BakeoffError` carries no `attempts`. Every unavailable field
 * therefore carries an explicit `*Available: false` flag and a sentence saying
 * why. A record that quietly reports zero is this repository's signature defect
 * with a JSON file behind it.
 *
 * ─── AND WHY NOTHING HERE PARSES PROSE ───
 *
 * `PhaseFailureSignals` has no `message` field and its docblock forbids one,
 * citing the 2026-08-04 death by name. The signature is built from a SITE and a
 * sorted list of FIELD PATHS — structured values written at the throw site —
 * and never from the failure text. `failureReason` is carried verbatim into the
 * record for a human to read; nothing in this file reads it back.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One field the validator refused, as the design's shared contract carries it. */
export interface DefectViolation {
  readonly path: string;
  readonly expected: string;
  readonly got: string;
}

/**
 * One authoring attempt as the record carries it.
 *
 * `at` IS OFTEN THE EMPTY STRING, AND THAT IS A MEASUREMENT. `AuthoringAttempt`
 * (spec-agent.ts) has no clock field, so an attempt read from the frozen audit
 * file has no timestamp to report. Empty means "this attempt carries no
 * instant", never "the epoch": `attemptsAvailable` and this field are read
 * together.
 */
export interface DefectAttempt {
  readonly n: number;
  readonly at: string;
  readonly problems: readonly string[];
}

export interface DefectRecord {
  readonly runId: string;
  readonly at: string;
  readonly phase: string;
  readonly failureClass: string;
  readonly bakeoffCode: string | null;
  /** sha256 hex of the site plus the sorted field paths. Never prose. */
  readonly signature: string;
  readonly violations: readonly DefectViolation[];
  readonly attempts: readonly DefectAttempt[];
  readonly artefacts: readonly string[];
  readonly repairable: boolean;

  /* ---- beyond the shared contract, and each one earns its place ---- */

  /** The terminal status this record was written at. `passed` records exist too. */
  readonly status: string;
  /** The signature's first ingredient, kept readable beside the digest. */
  readonly site: string;
  /** The signature's second ingredient, already sorted. */
  readonly fieldPaths: readonly string[];
  /** False when nothing structured was available — see the module docblock. */
  readonly violationsAvailable: boolean;
  readonly attemptsAvailable: boolean;
  /** Non-empty exactly when something above is `false`. */
  readonly unavailable: readonly string[];
  /** Carried verbatim for a human. NOTHING in this program parses it. */
  readonly failureReason: string | null;
}

/**
 * The stable fingerprint.
 *
 * SITE PLUS SORTED FIELD PATHS, HASHED. Sorted because `a913c871`'s attempts
 * named `id`, then `kind`, then `kind` again with `id` lost — the same defect
 * arriving in three orders, and an order-sensitive fingerprint would call them
 * three different defects and never fire the oscillation arm.
 *
 * HEX, BECAUSE IT IS ALSO A FILENAME. The shard is
 * `data/defects/<signature>.jsonl`, and a signature built by joining a site and
 * some field paths with separators would carry `/` and escape the directory.
 */
export function defectSignature(site: string, fieldPaths: readonly string[]): string {
  const material = `site=${site}\n${[...fieldPaths].sort().join("\n")}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export interface DefectRecordInput {
  readonly runId: string;
  readonly at: string;
  readonly phase: string;
  readonly status: string;
  readonly failureClass: string;
  readonly bakeoffCode: string | null;
  readonly failureReason: string | null;
  /** Where the failure was raised, structurally. Never a message. */
  readonly site: string;
  /** Null means "no structured violations travel yet", NOT "there were none". */
  readonly violations: readonly DefectViolation[] | null;
  /** Null means "the attempts did not reach this record", NOT "there were none". */
  readonly attempts: readonly DefectAttempt[] | null;
  readonly artefacts: readonly string[];
  /**
   * May an automated agent propose a repair for this class. `isRepairable`
   * (recovery.ts), NOT `boundFor(klass) > 0` — see that function's docblock for
   * the disagreement the two predicates produced. Corrected 2026-08-10; the
   * comment here used to describe the retry budget.
   */
  readonly repairable: boolean;
}

export function buildDefectRecord(input: DefectRecordInput): DefectRecord {
  const violations = input.violations ?? [];
  const attempts = input.attempts ?? [];
  const unavailable: string[] = [];
  if (input.violations === null) {
    unavailable.push(
      "violations: no structured DefectDetail travels on this failure yet (design §3.2 is a " +
        "digest-moving change that has not landed), so the offending field paths are UNKNOWN — " +
        "not absent. Read failureReason for what the layer that threw actually said.",
    );
  }
  if (input.attempts === null) {
    unavailable.push(
      "attempts: the authoring trail did not reach this record. On the failure path the thrown " +
        "BakeoffError carries no attempts array; on the success path the trail is in the frozen " +
        "audit file. Zero attempts here would be a lie.",
    );
  }
  return {
    runId: input.runId,
    at: input.at,
    phase: input.phase,
    failureClass: input.failureClass,
    bakeoffCode: input.bakeoffCode,
    signature: defectSignature(
      input.site,
      violations.map((v) => v.path),
    ),
    violations,
    attempts,
    artefacts: input.artefacts,
    repairable: input.repairable,
    status: input.status,
    site: input.site,
    fieldPaths: [...violations.map((v) => v.path)].sort(),
    violationsAvailable: input.violations !== null,
    attemptsAvailable: input.attempts !== null,
    unavailable,
    failureReason: input.failureReason,
  };
}

export interface DefectWriteTargets {
  /** `dashboard/runs/<runId>/results` — the per-run copy. */
  readonly resultsDir: string;
  /** `dashboard/data/defects` — the append-only, content-addressed shards. */
  readonly defectsDir: string;
}

export interface DefectWriteResult {
  readonly recordPath: string;
  readonly shardPath: string;
}

/**
 * Both writes, in that order.
 *
 * THE SHARD IS APPEND-ONLY AND CONTENT-ADDRESSED BY SIGNATURE, which is what
 * makes "has this happened before?" a `wc -l` rather than a walk of every run
 * directory. Appending never rewrites, so an earlier occurrence cannot be lost
 * by a later one — the retention rule the research round insisted on
 * (accumulate, never replace).
 */
export function writeDefectRecord(record: DefectRecord, targets: DefectWriteTargets): DefectWriteResult {
  mkdirSync(targets.resultsDir, { recursive: true });
  mkdirSync(targets.defectsDir, { recursive: true });
  const recordPath = join(targets.resultsDir, "defect.json");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const shardPath = join(targets.defectsDir, `${record.signature}.jsonl`);
  appendFileSync(shardPath, `${JSON.stringify(record)}\n`, "utf8");
  return { recordPath, shardPath };
}

/* =========================================================================
 * The authoring trail
 * ====================================================================== */

export interface AuthoringTrailFile {
  readonly runId: string;
  readonly at: string;
  readonly ticketId: string;
  /** `frozen` — a suite was sealed. `failed` — the phase threw. */
  readonly outcome: "frozen" | "failed";
  readonly suiteSha256: string | null;
  readonly attempts: readonly DefectAttempt[];
  readonly attemptsAvailable: boolean;
  /** Where the attempts came from, or why there are none. Never blank. */
  readonly source: string;
}

/**
 * Read the attempts out of whatever is actually available, STRUCTURALLY.
 *
 * `candidate` is either the parsed frozen audit file (success) or the thrown
 * error (failure). Both are probed the same way — is there an array called
 * `attempts` (the error's shape once the digest-moving §8.0a change lands) or
 * `authoringTrail` (the audit file's shape today)? — because the alternative is
 * matching on the message, and the one hard constraint the recovery layer
 * states is that no discrimination in this program may be a prose match.
 *
 * IT RETURNS `null` RATHER THAN `[]` WHEN IT FINDS NOTHING. That distinction is
 * the whole point of the module: today the failure path finds nothing, and it
 * must say so out loud rather than file a run with three authoring calls as a
 * run with zero.
 */
export function readAuthoringAttempts(candidate: unknown): readonly DefectAttempt[] | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const bag = candidate as Record<string, unknown>;
  const raw = Array.isArray(bag["attempts"])
    ? (bag["attempts"] as unknown[])
    : Array.isArray(bag["authoringTrail"])
      ? (bag["authoringTrail"] as unknown[])
      : null;
  if (raw === null) return null;
  return raw.map((entry, index) => {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const n = typeof item["attempt"] === "number" ? item["attempt"] : index + 1;
    // `at` only if the entry really carries one. See {@link DefectAttempt}.
    const at = typeof item["at"] === "string" ? item["at"] : "";
    const problems: string[] = [];
    /*
     * ABANDONMENT IS THE FIRST PROBLEM ON THE ROW WHEN IT HAPPENED, and it goes
     * on `problems` rather than into a new field because `problems` is the one
     * channel a reader of `DefectAttempt` already reads. An attempt that was cut
     * off by the harness produced nothing, so every other problem on the row is
     * downstream of that fact and reading it second inverts the cause.
     *
     * `=== true`, NEVER TRUTHINESS. `timedOut` is optional on
     * `AuthoringTrailEntry` precisely so that a trail frozen before 2026-08-10
     * reads as "not recorded" rather than as "did not time out"; a loose check
     * would turn every absent field into a claim.
     */
    if (item["timedOut"] === true) {
      problems.push(
        "the authoring call was ABANDONED on the per-call wall-clock bound and produced nothing — " +
          "this attempt was cut off by the harness, not answered by the seat",
      );
    }
    if (Array.isArray(item["problems"])) {
      for (const p of item["problems"] as unknown[]) if (typeof p === "string") problems.push(p);
    }
    if (Array.isArray(item["findings"])) {
      for (const f of item["findings"] as unknown[]) {
        if (typeof f === "object" && f !== null) {
          const finding = f as Record<string, unknown>;
          const id = typeof finding["criterionId"] === "string" ? finding["criterionId"] : "(no criterion)";
          const kind = typeof finding["kind"] === "string" ? finding["kind"] : "(no kind)";
          problems.push(`${kind} :: ${id}`);
        }
      }
    }
    return { n, at, problems };
  });
}

export function writeAuthoringTrail(trail: AuthoringTrailFile, resultsDir: string): string {
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, "authoring-trail.json");
  writeFileSync(path, `${JSON.stringify(trail, null, 2)}\n`, "utf8");
  return path;
}

/** The artefacts a replay would need, filtered to the ones that actually exist. */
export function existingArtefacts(candidates: readonly string[]): readonly string[] {
  return candidates.filter((path) => path !== "" && existsSync(path) && existsSync(dirname(path)));
}
