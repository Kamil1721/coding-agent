/**
 * results-io.ts — reading and validating results/*.jsonl.
 *
 * Three rules govern this module, all of them consequences of the protocol:
 *
 *  1. NOTHING IS SILENTLY SKIPPED. A malformed record throws with its file and
 *     line number. A well-formed record of an unrecognised shape is counted and
 *     surfaced in the report. A results file that the reporter quietly ignored
 *     is a run that silently left the denominator.
 *
 *  2. NOTHING IS GUESSED. Every field the report consumes is checked for type
 *     and range here, once, so that downstream code can be written against the
 *     frozen contract types rather than against `unknown`.
 *
 *  3. DUPLICATES ARE FATAL. Two run records with one runId double-count a
 *     configuration's spend and corrupt every rate computed from it. That is
 *     not a warning-level defect.
 *
 * Error messages name FIELDS, never VALUES: a results file can contain a
 * redaction failure, and an error message is one more place a secret could be
 * copied to.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import {
  BAKEOFF_SCHEMA_VERSION,
  BakeoffError,
  EFFORT_LADDERS,
  PRICE_FIELDS,
  PROVIDERS,
} from "./contracts.js";
import type {
  CriterionResult,
  CriterionTier,
  Effort,
  EffortSource,
  HeldConstants,
  KillReason,
  PriceField,
  PriceStatus,
  PricingBasis,
  Provider,
  RecordedEffort,
  RunRecord,
  RunStatus,
  ScoreRecord,
  SeatRole,
  SuiteExecution,
  VendorUsage,
} from "./contracts.js";
import { looksLikeVisibleRunResult, parseVisibleRunResult } from "./visible.js";
import type { VisibleRunResult } from "./visible.js";

/* -------------------------------------------------------------------------
 * The projections the report consumes
 *
 * `Pick` rather than a hand-written interface, so that renaming a field in the
 * frozen contract breaks this build instead of silently producing a report full
 * of undefined.
 * ---------------------------------------------------------------------- */

export type LoadedRun = Pick<
  RunRecord,
  | "schemaVersion"
  | "runId"
  | "ticketId"
  | "ticketSha256"
  | "configId"
  | "repeatIndex"
  | "startedAt"
  | "endedAt"
  | "wallClockMs"
  | "status"
  | "killReason"
  | "agentDeclaredDone"
  | "usage"
  | "totalCostUsd"
  | "pricingBasis"
  | "heldConstants"
  | "harnessErrors"
>;

export type LoadedScore = Pick<
  ScoreRecord,
  | "schemaVersion"
  | "runId"
  | "ticketId"
  | "acceptanceSuiteSha256"
  | "heldOutPass"
  | "criteriaResults"
  | "falseFinish"
  | "agentDeclaredDone"
  | "scoredAt"
  | "scorerImageDigest"
  | "suiteExecution"
  | "protectedPathViolations"
>;

/** A ledger event, read only far enough to count it. The ledger scores nothing. */
export interface LedgerEventSummary {
  readonly kind: string;
  readonly runId: string;
}

/** A well-formed JSON object whose shape matched no known record type. */
export interface UnrecognisedLine {
  readonly file: string;
  readonly line: number;
  /** Sorted top-level keys. Never a value. */
  readonly keys: readonly string[];
}

export interface LoadedResults {
  /** POSIX-relative paths of the files read, sorted. */
  readonly files: readonly string[];
  readonly runs: readonly LoadedRun[];
  readonly scores: readonly LoadedScore[];
  readonly visible: readonly VisibleRunResult[];
  readonly ledgerEvents: readonly LedgerEventSummary[];
  readonly unrecognisedLines: readonly UnrecognisedLine[];
  readonly totalLines: number;
}

/* -------------------------------------------------------------------------
 * Primitive validation
 * ---------------------------------------------------------------------- */

const REMEDIATION =
  "Fix the writer that produced this record, or remove the line. The report will not " +
  "substitute a default: a fabricated field silently changes a rate that decides a $3,000 experiment.";

function fail(loc: string, detail: string): never {
  throw new BakeoffError("invalid_usage_shape", `${loc}: ${detail}`, REMEDIATION);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, loc: string): Record<string, unknown> {
  if (!isRecord(value)) fail(loc, "expected a JSON object");
  return value as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, loc: string): string {
  const raw = o[key];
  if (typeof raw !== "string" || raw.length === 0) fail(loc, `"${key}" must be a non-empty string`);
  return raw as string;
}

function nullableStr(o: Record<string, unknown>, key: string, loc: string): string | null {
  const raw = o[key];
  if (raw === null) return null;
  if (typeof raw !== "string") fail(loc, `"${key}" must be a string or null`);
  return raw as string;
}

function bool(o: Record<string, unknown>, key: string, loc: string): boolean {
  const raw = o[key];
  if (typeof raw !== "boolean") fail(loc, `"${key}" must be a boolean`);
  return raw as boolean;
}

function finiteNumber(o: Record<string, unknown>, key: string, loc: string): number {
  const raw = o[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) fail(loc, `"${key}" must be a finite number`);
  return raw as number;
}

function nonNegativeNumber(o: Record<string, unknown>, key: string, loc: string): number {
  const value = finiteNumber(o, key, loc);
  if (value < 0) fail(loc, `"${key}" must not be negative`);
  return value;
}

function nonNegativeInt(o: Record<string, unknown>, key: string, loc: string): number {
  const raw = o[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    fail(loc, `"${key}" must be a non-negative integer`);
  }
  return raw as number;
}

function nullableNonNegativeInt(
  o: Record<string, unknown>,
  key: string,
  loc: string,
): number | null {
  if (o[key] === null) return null;
  return nonNegativeInt(o, key, loc);
}

function nullableFiniteNumber(
  o: Record<string, unknown>,
  key: string,
  loc: string,
): number | null {
  if (o[key] === null) return null;
  return finiteNumber(o, key, loc);
}

function array(o: Record<string, unknown>, key: string, loc: string): readonly unknown[] {
  const raw = o[key];
  if (!Array.isArray(raw)) fail(loc, `"${key}" must be an array`);
  return raw as readonly unknown[];
}

function stringArray(o: Record<string, unknown>, key: string, loc: string): readonly string[] {
  return array(o, key, loc).map((entry, index) => {
    if (typeof entry !== "string") fail(`${loc}.${key}[${String(index)}]`, "expected a string");
    return entry as string;
  });
}

function oneOf<T extends string>(
  o: Record<string, unknown>,
  key: string,
  loc: string,
  allowed: readonly T[],
): T {
  const raw = o[key];
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    fail(loc, `"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

function assertSchemaVersion(o: Record<string, unknown>, loc: string): void {
  if (o["schemaVersion"] !== BAKEOFF_SCHEMA_VERSION) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${loc}: schemaVersion must be ${String(BAKEOFF_SCHEMA_VERSION)}`,
      "This report reads schema version " +
        `${String(BAKEOFF_SCHEMA_VERSION)} only. A record written under a different version may ` +
        "have different field semantics; reading it as if it did not would produce a plausible, " +
        "wrong report. Migrate the records or use the matching harness version.",
    );
  }
}

/* -------------------------------------------------------------------------
 * Enumerations
 * ---------------------------------------------------------------------- */

const RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "blocked",
  "timeout",
  "budget_exceeded",
  "error",
];

/**
 * The closed kill-reason union from contracts.ts, repeated for runtime
 * validation. There is deliberately no "stuck"/"looping"/"no_progress" member
 * and none may be added: 79% of unresolved long-horizon runs time out while
 * still actively making progress, so a heuristic stuck-detector kills runs that
 * were converging (doc 03 sections 7.8 and 8.1). A results file containing such
 * a reason means someone built one, and this validator will reject it.
 */
const KILL_REASONS: readonly KillReason[] = [
  "cost_ceiling_usd",
  "campaign_cost_ceiling_usd",
  "wall_clock_ceiling",
  "vendor_output_token_ceiling",
  "operator_abort",
  "infrastructure_failure",
  "credential_failure",
];

const SEAT_ROLES: readonly SeatRole[] = ["orchestrator", "subagent", "spec", "judge"];
const CRITERION_TIERS: readonly CriterionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];
const PRICE_STATUSES: readonly PriceStatus[] = ["verified", "assumed", "unverified"];
const EFFORT_SOURCES: readonly EffortSource[] = ["doc-03-7.2", "task-spec", "harness-choice"];

const ALL_EFFORTS: readonly Effort[] = Object.freeze(
  [...new Set(PROVIDERS.flatMap((provider) => [...EFFORT_LADDERS[provider]]))],
);

function effortFor(
  o: Record<string, unknown>,
  key: string,
  loc: string,
  provider: Provider,
): Effort {
  const effort = oneOf<Effort>(o, key, loc, ALL_EFFORTS);
  if (!EFFORT_LADDERS[provider].includes(effort)) {
    fail(
      loc,
      `"${key}" is not on the ${provider} ladder (${EFFORT_LADDERS[provider].join(" < ")}). ` +
        "Rung names are not comparable across vendors; a rung from another vendor's ladder means " +
        "the run was dispatched with a setting that model does not have",
    );
  }
  return effort;
}

/* -------------------------------------------------------------------------
 * Nested structures
 * ---------------------------------------------------------------------- */

function parseVendorUsage(value: unknown, loc: string): VendorUsage {
  const o = objectAt(value, loc);
  const provider = oneOf<Provider>(o, "provider", loc, PROVIDERS);
  const cacheWriteTokens = nonNegativeInt(o, "cacheWriteTokens", loc);
  const cacheWrite5mTokens = nullableNonNegativeInt(o, "cacheWrite5mTokens", loc);
  const cacheWrite1hTokens = nullableNonNegativeInt(o, "cacheWrite1hTokens", loc);

  if (cacheWrite5mTokens !== null && cacheWrite1hTokens !== null) {
    if (cacheWrite5mTokens + cacheWrite1hTokens !== cacheWriteTokens) {
      fail(
        loc,
        "cacheWrite5mTokens + cacheWrite1hTokens does not equal cacheWriteTokens; the TTL split " +
          "must reconcile exactly and must not be rounded",
      );
    }
  }

  return {
    provider,
    inputTokens: nonNegativeInt(o, "inputTokens", loc),
    cacheReadTokens: nonNegativeInt(o, "cacheReadTokens", loc),
    cacheWriteTokens,
    outputTokens: nonNegativeInt(o, "outputTokens", loc),
    costUsd: nonNegativeNumber(o, "costUsd", loc),
    modelId: str(o, "modelId", loc),
    role: oneOf<SeatRole>(o, "role", loc, SEAT_ROLES),
    effort: effortFor(o, "effort", loc, provider),
    callCount: nonNegativeInt(o, "callCount", loc),
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    thinkingTokens: nullableNonNegativeInt(o, "thinkingTokens", loc),
  };
}

function parseFieldStatus(value: unknown, loc: string): Readonly<Record<PriceField, PriceStatus>> {
  const o = objectAt(value, loc);
  const out: Partial<Record<PriceField, PriceStatus>> = {};
  for (const field of PRICE_FIELDS) {
    out[field] = oneOf<PriceStatus>(o, field, loc, PRICE_STATUSES);
  }
  return out as Record<PriceField, PriceStatus>;
}

function parsePricingBasis(value: unknown, loc: string): PricingBasis {
  const o = objectAt(value, loc);
  return {
    provider: oneOf<Provider>(o, "provider", loc, PROVIDERS),
    modelId: str(o, "modelId", loc),
    priceLabel: str(o, "priceLabel", loc),
    priceEffectiveFrom: str(o, "priceEffectiveFrom", loc),
    priceEffectiveUntil: nullableStr(o, "priceEffectiveUntil", loc),
    pricedAt: str(o, "pricedAt", loc),
    fieldStatus: parseFieldStatus(o["fieldStatus"], `${loc}.fieldStatus`),
    assumedFields: array(o, "assumedFields", loc).map((entry, index) => {
      if (typeof entry !== "string" || !PRICE_FIELDS.includes(entry as PriceField)) {
        fail(`${loc}.assumedFields[${String(index)}]`, `expected one of: ${PRICE_FIELDS.join(", ")}`);
      }
      return entry as PriceField;
    }),
    assumedCacheWriteMultiplier: nullableFiniteNumber(o, "assumedCacheWriteMultiplier", loc),
    sourcedOn: str(o, "sourcedOn", loc),
    source: str(o, "source", loc),
  };
}

function parseRecordedEffort(value: unknown, loc: string): RecordedEffort {
  const o = objectAt(value, loc);
  const provider = oneOf<Provider>(o, "provider", loc, PROVIDERS);
  return {
    role: oneOf<SeatRole>(o, "role", loc, SEAT_ROLES),
    provider,
    modelId: str(o, "modelId", loc),
    effort: effortFor(o, "effort", loc, provider),
    effortSource: oneOf<EffortSource>(o, "effortSource", loc, EFFORT_SOURCES),
  };
}

function parseHeldConstants(value: unknown, loc: string): HeldConstants {
  const o = objectAt(value, loc);

  const sandbox = objectAt(o["sandbox"], `${loc}.sandbox`);
  const networkPolicy = objectAt(sandbox["networkPolicy"], `${loc}.sandbox.networkPolicy`);
  const harness = objectAt(o["harness"], `${loc}.harness`);

  const rule = o["tokenAccountingRule"];
  if (rule !== "per-vendor-never-summed-only-dollars-compared") {
    fail(
      `${loc}.tokenAccountingRule`,
      'must be exactly "per-vendor-never-summed-only-dollars-compared" — held-constant variable 6. ' +
        "A run recorded under a different accounting rule is not comparable with the rest of the matrix",
    );
  }

  const repeatCount = nonNegativeInt(o, "repeatCount", loc);
  if (repeatCount < 1) fail(`${loc}.repeatCount`, "must be at least 1");

  return {
    efforts: array(o, "efforts", loc).map((entry, index) =>
      parseRecordedEffort(entry, `${loc}.efforts[${String(index)}]`),
    ),
    harness: {
      id: str(harness, "id", `${loc}.harness`),
      version: str(harness, "version", `${loc}.harness`),
      commit: str(harness, "commit", `${loc}.harness`),
    },
    sandbox: {
      imageRef: str(sandbox, "imageRef", `${loc}.sandbox`),
      imageDigest: str(sandbox, "imageDigest", `${loc}.sandbox`),
      networkPolicy: {
        egress: oneOf(networkPolicy, "egress", `${loc}.sandbox.networkPolicy`, [
          "denied",
          "pinned-mirror-only",
        ] as const),
        allowedHosts: stringArray(networkPolicy, "allowedHosts", `${loc}.sandbox.networkPolicy`),
      },
    },
    repeatCount,
    acceptanceSuiteSha256: str(o, "acceptanceSuiteSha256", loc),
    tokenAccountingRule: "per-vendor-never-summed-only-dollars-compared",
  };
}

function parseCriterionResult(value: unknown, loc: string): CriterionResult {
  const o = objectAt(value, loc);
  return {
    criterionId: str(o, "criterionId", loc),
    tier: oneOf<CriterionTier>(o, "tier", loc, CRITERION_TIERS),
    passed: bool(o, "passed", loc),
    evidenceRef: nullableStr(o, "evidenceRef", loc),
    detail: nullableStr(o, "detail", loc),
  };
}

function parseSuiteExecution(value: unknown, loc: string): SuiteExecution {
  const o = objectAt(value, loc);
  return {
    exitCode: finiteNumber(o, "exitCode", loc),
    durationMs: nonNegativeNumber(o, "durationMs", loc),
    testsTotal: nullableNonNegativeInt(o, "testsTotal", loc),
    testsPassed: nullableNonNegativeInt(o, "testsPassed", loc),
    testsFailed: nullableNonNegativeInt(o, "testsFailed", loc),
    logPath: nullableStr(o, "logPath", loc),
  };
}

/* -------------------------------------------------------------------------
 * Record parsers
 * ---------------------------------------------------------------------- */

function parseRun(o: Record<string, unknown>, loc: string): LoadedRun {
  assertSchemaVersion(o, loc);

  const status = oneOf<RunStatus>(o, "status", loc, RUN_STATUSES);
  const killReasonRaw = o["killReason"];
  let killReason: KillReason | null = null;
  if (killReasonRaw !== null) {
    killReason = oneOf<KillReason>(o, "killReason", loc, KILL_REASONS);
  }

  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: str(o, "runId", loc),
    ticketId: str(o, "ticketId", loc),
    ticketSha256: str(o, "ticketSha256", loc),
    configId: str(o, "configId", loc),
    repeatIndex: nonNegativeInt(o, "repeatIndex", loc),
    startedAt: str(o, "startedAt", loc),
    endedAt: str(o, "endedAt", loc),
    wallClockMs: nonNegativeNumber(o, "wallClockMs", loc),
    status,
    killReason,
    agentDeclaredDone: bool(o, "agentDeclaredDone", loc),
    usage: array(o, "usage", loc).map((entry, index) =>
      parseVendorUsage(entry, `${loc}.usage[${String(index)}]`),
    ),
    totalCostUsd: nonNegativeNumber(o, "totalCostUsd", loc),
    pricingBasis: array(o, "pricingBasis", loc).map((entry, index) =>
      parsePricingBasis(entry, `${loc}.pricingBasis[${String(index)}]`),
    ),
    heldConstants: parseHeldConstants(o["heldConstants"], `${loc}.heldConstants`),
    harnessErrors: stringArray(o, "harnessErrors", loc),
  };
}

function parseScore(o: Record<string, unknown>, loc: string): LoadedScore {
  assertSchemaVersion(o, loc);
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: str(o, "runId", loc),
    ticketId: str(o, "ticketId", loc),
    acceptanceSuiteSha256: str(o, "acceptanceSuiteSha256", loc),
    heldOutPass: bool(o, "heldOutPass", loc),
    criteriaResults: array(o, "criteriaResults", loc).map((entry, index) =>
      parseCriterionResult(entry, `${loc}.criteriaResults[${String(index)}]`),
    ),
    falseFinish: bool(o, "falseFinish", loc),
    agentDeclaredDone: bool(o, "agentDeclaredDone", loc),
    scoredAt: str(o, "scoredAt", loc),
    scorerImageDigest: str(o, "scorerImageDigest", loc),
    suiteExecution: parseSuiteExecution(o["suiteExecution"], `${loc}.suiteExecution`),
    protectedPathViolations: stringArray(o, "protectedPathViolations", loc),
  };
}

/* -------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------- */

type RecordKind = "run" | "score" | "visible" | "ledger" | "unknown";

/**
 * Shape discrimination.
 *
 * The frozen contract types carry no discriminator field, so the reporter reads
 * whatever `results/*.jsonl` files exist and identifies records structurally.
 * Order matters: the visible-result and ledger tags are checked before the
 * structural tests so a tagged record can never be mistaken for an untagged one.
 */
function classify(o: Record<string, unknown>): RecordKind {
  if (looksLikeVisibleRunResult(o)) return "visible";
  if (typeof o["kind"] === "string" && "eventId" in o && "seq" in o) return "ledger";
  if ("heldOutPass" in o && "criteriaResults" in o) return "score";
  if ("status" in o && "usage" in o && "configId" in o && "wallClockMs" in o) return "run";
  return "unknown";
}

/* -------------------------------------------------------------------------
 * Discovery
 * ---------------------------------------------------------------------- */

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join(posix.sep);
}

function collectJsonlFiles(root: string, current: string, out: string[]): void {
  const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(root, absolute, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(absolute);
    }
  }
}

function assertUnique(
  seen: Set<string>,
  key: string,
  kind: string,
  loc: string,
): void {
  if (seen.has(key)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${loc}: duplicate ${kind} for runId "${key}"`,
      "Two records for one run double-count that run's spend and corrupt every rate computed " +
        "from it. Deduplicate results/*.jsonl — most often this is one file appended twice, or a " +
        "re-scored run written alongside its original instead of replacing it.",
    );
  }
  seen.add(key);
}

/**
 * Read every `*.jsonl` under `resultsDir`, recursively, in sorted path order.
 *
 * Throws — with a remediation — when the directory is missing or contains no
 * run records. An empty report is worse than a clear refusal: it looks like a
 * result.
 */
export function loadResults(resultsDir: string): LoadedResults {
  let stats;
  try {
    stats = statSync(resultsDir);
  } catch {
    throw new BakeoffError(
      "invalid_usage_shape",
      `results directory not found: ${resultsDir}`,
      "Run the bake-off first, or pass --results <dir>. The reporter reads run records, score " +
        "records and (optionally) visible-result records from *.jsonl files under that directory.",
    );
  }
  if (!stats.isDirectory()) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `results path is not a directory: ${resultsDir}`,
      "Pass the directory containing results/*.jsonl, not a single file.",
    );
  }

  const absoluteFiles: string[] = [];
  collectJsonlFiles(resultsDir, resultsDir, absoluteFiles);

  const runs: LoadedRun[] = [];
  const scores: LoadedScore[] = [];
  const visible: VisibleRunResult[] = [];
  const ledgerEvents: LedgerEventSummary[] = [];
  const unrecognisedLines: UnrecognisedLine[] = [];
  const files: string[] = [];

  const runIds = new Set<string>();
  const scoredRunIds = new Set<string>();
  const visibleRunIds = new Set<string>();
  let totalLines = 0;

  for (const absolute of absoluteFiles) {
    const relative = toPosix(absolute.slice(resultsDir.length).replace(/^[\\/]/, ""));
    files.push(relative);

    const text = readFileSync(absolute, "utf8");
    const lines = text.split("\n");

    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      totalLines += 1;
      const loc = `${relative}:${String(index + 1)}`;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new BakeoffError(
          "invalid_usage_shape",
          `${loc}: not valid JSON`,
          "Every line of a .jsonl results file must be one complete JSON value. A truncated line " +
            "usually means a writer crashed mid-record; recover or delete that line, and check " +
            "whether the run it belongs to is missing from the matrix.",
        );
      }

      const o = objectAt(parsed, loc);
      switch (classify(o)) {
        case "run": {
          const run = parseRun(o, loc);
          assertUnique(runIds, run.runId, "run record", loc);
          runs.push(run);
          break;
        }
        case "score": {
          const score = parseScore(o, loc);
          assertUnique(scoredRunIds, score.runId, "score record", loc);
          scores.push(score);
          break;
        }
        case "visible": {
          const result = parseVisibleRunResult(o, loc);
          assertUnique(visibleRunIds, result.runId, "visible-result record", loc);
          visible.push(result);
          break;
        }
        case "ledger": {
          ledgerEvents.push({ kind: str(o, "kind", loc), runId: str(o, "runId", loc) });
          break;
        }
        case "unknown": {
          unrecognisedLines.push({ file: relative, line: index + 1, keys: Object.keys(o).sort() });
          break;
        }
      }
    }
  }

  if (runs.length === 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `no run records found under ${resultsDir} (${String(files.length)} .jsonl file(s), ` +
        `${String(totalLines)} line(s) read)`,
      "There is nothing to report. Run the bake-off, or point --results at the directory the " +
        "runner writes to. A report generated from zero runs would look like a result.",
    );
  }

  return { files, runs, scores, visible, ledgerEvents, unrecognisedLines, totalLines };
}
