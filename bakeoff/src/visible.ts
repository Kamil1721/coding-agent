/**
 * visible.ts — the builder's OWN, VISIBLE test result.
 *
 * WHY THIS FILE EXISTS, STATED PLAINLY: contracts.ts is frozen and records no
 * such thing. It records `agentDeclaredDone` (the self-report, which scores
 * nothing) and `heldOutPass` (the sealed gate). Neither is the visible-test
 * pass rate.
 *
 * doc 02 section 5.4 requires the VISIBLE-vs-HELD-OUT pass-rate GAP as a
 * first-class number, because that gap IS the reward-hacking metric and it
 * widens ~27pp per 10x LOC (doc 03 section 5 rank 3; doc 02 section 5.4 states
 * 28pp), reaching 100pp above 25K LOC — so it is widest on exactly the
 * ambitious tickets this product exists to serve. The gap compares TWO TEST
 * SUITES: the tests the builder could see and run, against the sealed suite it
 * could not.
 *
 * >>> "THE AGENT SAID IT WAS DONE" IS NOT A VISIBLE-TEST PASS RATE. An agent
 * >>> can declare done without running a test at all. Substituting the
 * >>> self-report yields a different quantity — a lower bound on the
 * >>> false-finish rate — and the report labels it as such rather than calling
 * >>> it the reward-hacking metric. See src/report.ts section 4.
 *
 * These records are OPTIONAL INPUT. The runner writes one per build attempt if
 * it observed the builder's own suite; the report reads them from the same
 * results/*.jsonl stream and falls back to the labelled proxy when none exist.
 * Nothing in the frozen scoring path depends on them, and nothing here may ever
 * influence `heldOutPass`: this is the builder's own marking of its own
 * homework, recorded so the gap can be measured, exactly as
 * `agentDeclaredDone` is recorded so `falseFinish` can be.
 */

import { BAKEOFF_SCHEMA_VERSION, BakeoffError } from "./contracts.js";

/** Discriminator. Present so these records survive being interleaved in a shared .jsonl stream. */
export const VISIBLE_RUN_RESULT_KIND = "visible_run_result" as const;

/**
 * Where the visible result came from.
 *
 * - `builder-authored-suite` — the builder wrote the tests and the harness ran
 *   them. This is the doc 02 section 5.4 quantity.
 * - `harness-observed-command` — the harness observed the exit status of the
 *   verification command the builder itself chose to run.
 *
 * There is deliberately no `self-report` member: a self-report is not a test
 * result, and admitting it here would let the proxy be silently promoted into
 * the measured column.
 */
export type VisibleResultSource = "builder-authored-suite" | "harness-observed-command";

export const VISIBLE_RESULT_SOURCES: readonly VisibleResultSource[] = Object.freeze([
  "builder-authored-suite",
  "harness-observed-command",
]);

/**
 * The builder's own visible test result for one build attempt.
 *
 * Joined to a {@link import("./contracts.js").RunRecord} on `runId`. Written by
 * the runner, never by the builder: a record the builder can write is a record
 * the builder can fake, and this one exists precisely to measure faking.
 */
export interface VisibleRunResult {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly kind: typeof VISIBLE_RUN_RESULT_KIND;
  readonly runId: string;
  readonly ticketId: string;
  readonly configId: string;
  /** True when the builder's own visible suite went green in the build workspace. */
  readonly visibleSuitePassed: boolean;
  readonly source: VisibleResultSource;
  /** Null when the runner produced no machine-readable report. Never 0 as a substitute. */
  readonly testsTotal: number | null;
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
  /** The command whose exit status was observed, redacted. Null when not recorded. */
  readonly command: string | null;
  /** ISO-8601 instant. */
  readonly observedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a parsed JSON value is tagged as a visible-result record. */
export function looksLikeVisibleRunResult(value: unknown): boolean {
  return isRecord(value) && value["kind"] === VISIBLE_RUN_RESULT_KIND;
}

/**
 * Validate a tagged record. Throws rather than dropping a malformed one: a
 * silently skipped visible result understates the gap, which is the direction
 * that flatters a reward-hacking configuration.
 */
export function parseVisibleRunResult(value: unknown, where: string): VisibleRunResult {
  if (!isRecord(value)) {
    throw new BakeoffError("invalid_usage_shape", `${where}: not a JSON object`, "Fix the writer.");
  }

  const fail = (detail: string): never => {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${where}: ${detail}`,
      "Fix the runner that writes visible_run_result records, or delete the malformed line. " +
        "The report will not guess at a visible-test outcome.",
    );
  };

  if (value["schemaVersion"] !== BAKEOFF_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${String(BAKEOFF_SCHEMA_VERSION)}`);
  }

  const str = (key: string): string => {
    const raw = value[key];
    if (typeof raw !== "string" || raw.length === 0) fail(`"${key}" must be a non-empty string`);
    return raw as string;
  };
  const nullableStr = (key: string): string | null => {
    const raw = value[key];
    if (raw === null) return null;
    if (typeof raw !== "string") fail(`"${key}" must be a string or null`);
    return raw as string;
  };
  const nullableInt = (key: string): number | null => {
    const raw = value[key];
    if (raw === null) return null;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      fail(`"${key}" must be a non-negative integer or null (never 0 to mean "not reported")`);
    }
    return raw as number;
  };

  const passed = value["visibleSuitePassed"];
  if (typeof passed !== "boolean") fail('"visibleSuitePassed" must be a boolean');

  const source = value["source"];
  if (typeof source !== "string" || !VISIBLE_RESULT_SOURCES.includes(source as VisibleResultSource)) {
    fail(`"source" must be one of ${VISIBLE_RESULT_SOURCES.join(", ")}`);
  }

  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    kind: VISIBLE_RUN_RESULT_KIND,
    runId: str("runId"),
    ticketId: str("ticketId"),
    configId: str("configId"),
    visibleSuitePassed: passed as boolean,
    source: source as VisibleResultSource,
    testsTotal: nullableInt("testsTotal"),
    testsPassed: nullableInt("testsPassed"),
    testsFailed: nullableInt("testsFailed"),
    command: nullableStr("command"),
    observedAt: str("observedAt"),
  };
}
