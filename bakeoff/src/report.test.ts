/**
 * report.test.ts — end-to-end checks on the reporter.
 *
 * The fixtures are built from the FROZEN contract types (`RunRecord`,
 * `ScoreRecord`) and from the real `PRICE_TABLE`, so this suite also proves the
 * records round-trip through JSON and back through the loader without loss.
 *
 * NO CREDENTIAL, REAL OR OTHERWISE, IS WRITTEN INTO THIS FILE. The redaction
 * test needs a key-SHAPED string; it is assembled at runtime from harmless
 * fragments so that no such literal exists in the source tree.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BakeoffError,
  computeHeldOutPass,
  deriveFalseFinish,
  pricingBasisOf,
  resolvePrice,
  vendorCacheHitFraction,
  BAKEOFF_SCHEMA_VERSION,
} from "./contracts.js";
import type {
  CriterionResult,
  HarnessIdentity,
  ModelSeat,
  RunRecord,
  RunStatus,
  SandboxSpec,
  ScoreRecord,
  VendorUsage,
} from "./contracts.js";
import {
  DEEPSEEK_V4_PRO_SUBAGENT,
  DEFAULT_BUDGET,
  JUDGE_SEAT,
  OPUS_5_ORCHESTRATOR,
  SEALED_NETWORK_POLICY,
  SONNET_5_SUBAGENT,
  SPEC_SEAT,
  getConfig,
  heldConstantsFor,
} from "./config.js";
import { sha256Hex } from "./hash.js";
import { aggregateCacheHitFraction } from "./aggregate.js";
import { writeReport } from "./report.js";

/* -------------------------------------------------------------------------
 * Fixture construction
 * ---------------------------------------------------------------------- */

const STARTED_AT = "2026-07-27T09:00:00.000Z";
const ENDED_AT = "2026-07-27T10:00:00.000Z";

const HARNESS: HarnessIdentity = { id: "bakeoff", version: "0.1.0", commit: "unversioned" };

const SANDBOX: SandboxSpec = {
  imageRef: "bakeoff-sandbox:pinned",
  imageDigest: `sha256:${"b".repeat(64)}`,
  networkPolicy: SEALED_NETWORK_POLICY,
};

function suiteDigestFor(ticketId: string): string {
  return sha256Hex(`suite-${ticketId}`);
}

function usageRow(
  seat: ModelSeat,
  counts: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  },
): VendorUsage {
  return {
    provider: seat.provider,
    inputTokens: counts.inputTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    outputTokens: counts.outputTokens,
    costUsd: counts.costUsd,
    modelId: seat.modelId,
    role: seat.role,
    effort: seat.effort,
    callCount: 40,
    cacheWrite5mTokens: counts.cacheWriteTokens,
    cacheWrite1hTokens: 0,
    thinkingTokens: null,
  };
}

interface RunSpec {
  readonly configId: string;
  readonly ticketId: string;
  readonly status: RunStatus;
  readonly agentDeclaredDone: boolean;
  readonly wallClockMs: number;
  readonly harnessErrors?: readonly string[];
}

function makeRun(spec: RunSpec): RunRecord {
  const config = getConfig(spec.configId);
  const orchestrator = OPUS_5_ORCHESTRATOR;
  const subagent = spec.configId === "B" ? DEEPSEEK_V4_PRO_SUBAGENT : SONNET_5_SUBAGENT;

  const usage: VendorUsage[] = [
    usageRow(orchestrator, {
      inputTokens: 900_000,
      cacheReadTokens: 7_500_000,
      cacheWriteTokens: 600_000,
      outputTokens: 500_000,
      costUsd: 22.5,
    }),
    spec.configId === "B"
      ? // DeepSeek bills misses as ordinary input and reports NO cache-write line
        // item at all (PRICE_TABLE requires cacheWriteTokens = 0). A cold run
        // therefore shows cacheRead = 0 AND cacheWrite = 0, which is why the
        // no-caching alert has to be provider-aware.
        usageRow(subagent, {
          inputTokens: 30_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1_800_000,
          costUsd: 14.6,
        })
      : usageRow(subagent, {
          inputTokens: 3_500_000,
          cacheReadTokens: 32_000_000,
          cacheWriteTokens: 3_000_000,
          outputTokens: 1_800_000,
          costUsd: 38.0,
        }),
  ];

  const providers = [orchestrator, subagent];
  const pricingBasis = providers.map((seat) =>
    pricingBasisOf(resolvePrice(seat.provider, seat.modelId, STARTED_AT), STARTED_AT),
  );

  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: `${spec.configId}-${spec.ticketId}-0`,
    ticketId: spec.ticketId,
    ticketSha256: sha256Hex(`brief-${spec.ticketId}`),
    configId: spec.configId,
    repeatIndex: 0,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    wallClockMs: spec.wallClockMs,
    status: spec.status,
    killReason: spec.status === "timeout" ? "wall_clock_ceiling" : null,
    agentDeclaredDone: spec.agentDeclaredDone,
    selfReportPath: null,
    usage,
    totalCostUsd: usage.reduce((total, row) => total + row.costUsd, 0),
    pricingBasis,
    seats: [orchestrator, subagent, SPEC_SEAT, JUDGE_SEAT],
    heldConstants: heldConstantsFor({
      config,
      harness: HARNESS,
      sandbox: SANDBOX,
      repeatCount: 1,
      acceptanceSuiteSha256: suiteDigestFor(spec.ticketId),
    }),
    budget: DEFAULT_BUDGET,
    artifactPath: `/workspaces/${spec.configId}/${spec.ticketId}`,
    logPath: `/logs/${spec.configId}/${spec.ticketId}.log`,
    ledgerPath: `/ledger/${spec.configId}/${spec.ticketId}.jsonl`,
    harnessErrors: spec.harnessErrors ?? [],
  };
}

function makeScore(run: RunRecord, pass: boolean): ScoreRecord {
  const criteriaResults: readonly CriterionResult[] = [
    { criterionId: "REQ-001", tier: "BLOCKING", passed: pass, evidenceRef: "T-1", detail: null },
    { criterionId: "REQ-002", tier: "FUNCTIONAL", passed: pass, evidenceRef: "T-2", detail: null },
    // QUALITY never gates: it is false on every run and must not change the outcome.
    { criterionId: "REQ-003", tier: "QUALITY", passed: false, evidenceRef: null, detail: "a11y" },
  ];
  const heldOutPass = computeHeldOutPass(criteriaResults, []);
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: run.runId,
    ticketId: run.ticketId,
    acceptanceSuiteSha256: run.heldConstants.acceptanceSuiteSha256,
    heldOutPass,
    criteriaResults,
    falseFinish: deriveFalseFinish(run.agentDeclaredDone, heldOutPass),
    agentDeclaredDone: run.agentDeclaredDone,
    scoredAt: ENDED_AT,
    scorerImageDigest: `sha256:${"c".repeat(64)}`,
    suiteExecution: {
      exitCode: heldOutPass ? 0 : 1,
      durationMs: 42_000,
      testsTotal: 12,
      testsPassed: heldOutPass ? 12 : 7,
      testsFailed: heldOutPass ? 0 : 5,
      logPath: null,
    },
    protectedPathViolations: [],
  };
}

interface Fixture {
  readonly dir: string;
  readonly cleanup: () => void;
}

/** config A passes 4 of 6; config B passes 2 of 6 with two false finishes. */
const RUN_PLAN: readonly (RunSpec & { readonly pass: boolean })[] = [
  { configId: "A", ticketId: "T1", status: "completed", agentDeclaredDone: true, wallClockMs: 1_200_000, pass: true },
  { configId: "A", ticketId: "T2", status: "completed", agentDeclaredDone: true, wallClockMs: 1_500_000, pass: true },
  { configId: "A", ticketId: "T3", status: "completed", agentDeclaredDone: true, wallClockMs: 3_600_000, pass: true },
  { configId: "A", ticketId: "T4", status: "completed", agentDeclaredDone: true, wallClockMs: 4_000_000, pass: true },
  { configId: "A", ticketId: "T5", status: "completed", agentDeclaredDone: true, wallClockMs: 6_000_000, pass: false },
  { configId: "A", ticketId: "T6", status: "blocked", agentDeclaredDone: false, wallClockMs: 7_000_000, pass: false },
  { configId: "B", ticketId: "T1", status: "completed", agentDeclaredDone: true, wallClockMs: 900_000, pass: true },
  { configId: "B", ticketId: "T2", status: "completed", agentDeclaredDone: true, wallClockMs: 1_100_000, pass: true },
  { configId: "B", ticketId: "T3", status: "completed", agentDeclaredDone: true, wallClockMs: 2_400_000, pass: false },
  { configId: "B", ticketId: "T4", status: "completed", agentDeclaredDone: true, wallClockMs: 2_600_000, pass: false },
  { configId: "B", ticketId: "T5", status: "timeout", agentDeclaredDone: false, wallClockMs: 14_400_000, pass: false },
  { configId: "B", ticketId: "T6", status: "blocked", agentDeclaredDone: false, wallClockMs: 5_000_000, pass: false },
];

function buildFixture(options: { readonly harnessErrorOnFirstRun?: readonly string[] } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-report-test-"));
  const runLines: string[] = [];
  const scoreLines: string[] = [];

  for (const [index, spec] of RUN_PLAN.entries()) {
    const run = makeRun(
      index === 0 && options.harnessErrorOnFirstRun !== undefined
        ? { ...spec, harnessErrors: options.harnessErrorOnFirstRun }
        : spec,
    );
    runLines.push(JSON.stringify(run));
    scoreLines.push(JSON.stringify(makeScore(run, spec.pass)));
  }

  writeFileSync(join(dir, "runs.jsonl"), `${runLines.join("\n")}\n`, "utf8");
  writeFileSync(join(dir, "scores.jsonl"), `${scoreLines.join("\n")}\n`, "utf8");

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

test("the report states the decision rule before any result and applies it per config", () => {
  const fixture = buildFixture();
  try {
    const result = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    const md = result.markdown;

    const ruleIndex = md.indexOf("## 1. THE DECISION RULE");
    const resultsIndex = md.indexOf("### 3. Per-configuration results");
    assert.ok(ruleIndex >= 0, "the rule section must exist");
    assert.ok(resultsIndex > ruleIndex, "no results table may precede the rule");

    // The three conditions, each as a plain PASS/FAIL, and a mechanical verdict.
    assert.ok(md.includes("candidate ≥ baseline − SE(baseline)"));
    assert.ok(md.includes("candidate ≤ 0.70 × baseline"));
    assert.ok(md.includes("**PASS**") || md.includes("**FAIL**"));
    assert.ok(md.includes("**DO NOT SWITCH**") || md.includes("**SWITCH CONDITIONS MET**"));

    // Config B fails condition (i): 2/6 is far below 4/6 minus one standard error.
    const decision = result.aggregation.phases[0]?.decisions.find((d) => d.configId === "B");
    assert.ok(decision !== undefined);
    assert.equal(decision.result.withinOneStandardError, false);
    assert.equal(decision.result.switchRecommended, false);
  } finally {
    fixture.cleanup();
  }
});

test("co-primary metrics are computed from the frozen definitions, not from the persisted fields", () => {
  const fixture = buildFixture();
  try {
    const { aggregation } = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    const phase = aggregation.phases[0];
    assert.ok(phase !== undefined);

    const a = phase.configs.find((c) => c.configId === "A");
    const b = phase.configs.find((c) => c.configId === "B");
    assert.ok(a !== undefined && b !== undefined);

    assert.equal(a.heldOut?.successes, 4);
    assert.equal(a.heldOut?.n, 6);
    // T5 declared done and failed; T6 was BLOCKED and declared nothing.
    assert.equal(a.falseFinish?.successes, 1);
    assert.equal(b.heldOut?.successes, 2);
    // B: T3 and T4 declared done and failed. T5 timed out, T6 blocked — neither declared.
    assert.equal(b.falseFinish?.successes, 2);

    // BLOCKED and timeout are first-class outcomes and stay in the denominator.
    assert.equal(a.outcome?.blockedRate, 1 / 6);
    assert.equal(b.outcome?.timeoutRate, 1 / 6);
  } finally {
    fixture.cleanup();
  }
});

test("a fabricated heldOutPass is detected, reported as blocking, and overridden", () => {
  const fixture = buildFixture();
  try {
    // Rewrite one score so its heldOutPass claims a pass its criteria do not support.
    const run = makeRun(RUN_PLAN[4] as RunSpec);
    const honest = makeScore(run, false);
    const tampered = { ...honest, heldOutPass: true, falseFinish: false };
    const scores = RUN_PLAN.map((spec, index) => {
      const record = makeRun(spec);
      return index === 4 ? JSON.stringify(tampered) : JSON.stringify(makeScore(record, spec.pass));
    });
    writeFileSync(join(fixture.dir, "scores.jsonl"), `${scores.join("\n")}\n`, "utf8");

    const { aggregation, markdown, hasBlockingAlerts } = writeReport({
      resultsDir: fixture.dir,
      generatedAt: STARTED_AT,
    });

    assert.equal(hasBlockingAlerts, true);
    assert.ok(
      aggregation.alerts.some((alert) => alert.kind === "held_out_pass_disagrees_with_criteria"),
    );
    assert.ok(markdown.includes("STOP —"));
    // The recomputed value wins: config A still has 4 passes, not 5.
    const a = aggregation.phases[0]?.configs.find((c) => c.configId === "A");
    assert.equal(a?.heldOut?.successes, 4);
  } finally {
    fixture.cleanup();
  }
});

test("the no-caching alert is provider-aware: DeepSeek is judged on cache_read alone", () => {
  const fixture = buildFixture();
  try {
    const { aggregation } = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    const phase = aggregation.phases[0];
    assert.ok(phase !== undefined);

    const b = phase.configs.find((c) => c.configId === "B");
    const deepseek = b?.providerCache.find((p) => p.provider === "deepseek");
    assert.ok(deepseek !== undefined);
    assert.equal(deepseek.cacheWriteTokens, 0, "DeepSeek reports no cache-write line item");
    assert.equal(deepseek.notCachedAtAll, true);

    const anthropic = b?.providerCache.find((p) => p.provider === "anthropic");
    assert.ok(anthropic !== undefined);
    assert.equal(anthropic.notCachedAtAll, false);

    assert.ok(
      phase.alerts.some((alert) => alert.kind === "cache_not_used" && alert.affected.includes("B/deepseek")),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a run that billed a model its configuration does not declare is blocking", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-seat-mismatch-"));
  try {
    // Config C declares a Moonshot orchestrator. This run bills Anthropic in that
    // seat: internally consistent, joins cleanly, rates compute — and is not
    // config C. Nothing but this audit catches it.
    const run = makeRun({
      configId: "C",
      ticketId: "T1",
      status: "completed",
      agentDeclaredDone: true,
      wallClockMs: 1_000_000,
    });
    writeFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(run)}\n`, "utf8");
    writeFileSync(join(dir, "scores.jsonl"), `${JSON.stringify(makeScore(run, true))}\n`, "utf8");

    const { aggregation, hasBlockingAlerts } = writeReport({
      resultsDir: dir,
      generatedAt: STARTED_AT,
    });
    assert.equal(hasBlockingAlerts, true);
    assert.ok(
      aggregation.alerts.some((alert) => alert.kind === "usage_does_not_match_configuration"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the aggregate cache-hit fraction agrees with the frozen per-row definition", () => {
  const row = usageRow(OPUS_5_ORCHESTRATOR, {
    inputTokens: 900_000,
    cacheReadTokens: 7_500_000,
    cacheWriteTokens: 600_000,
    outputTokens: 500_000,
    costUsd: 22.5,
  });
  const frozen = vendorCacheHitFraction(row);
  const aggregated = aggregateCacheHitFraction(
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.inputTokens,
  );
  assert.equal(aggregated, frozen);
  assert.equal(aggregateCacheHitFraction(0, 0, 0), null);
});

test("a credential-shaped string in a run record never reaches the rendered report", () => {
  // Assembled at runtime so no key-shaped literal exists in this source file.
  const shaped = `${["sk", "ant", "api03"].join("-")}-${"N".repeat(32)}`;
  const fixture = buildFixture({
    harnessErrorOnFirstRun: [`upstream rejected the request: ${shaped}`],
  });
  try {
    const { markdown } = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    assert.ok(!markdown.includes(shaped), "the report must not contain the credential-shaped value");
    assert.ok(!markdown.includes("N".repeat(32)));
  } finally {
    fixture.cleanup();
  }
});

test("token accounting is presented per vendor, with the never-compare warning", () => {
  const fixture = buildFixture();
  try {
    const { markdown } = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    assert.ok(markdown.includes("TOKEN COUNTS BELOW ARE NOT COMPARABLE ACROSS THESE TABLES"));
    assert.ok(markdown.includes("### anthropic"));
    assert.ok(markdown.includes("### deepseek"));
    assert.ok(markdown.includes("COMPARE DOLLARS AND OUTCOMES ONLY"));
  } finally {
    fixture.cleanup();
  }
});

test("with no measured visible-test records the gap is declared not measured", () => {
  const fixture = buildFixture();
  try {
    const { markdown, aggregation } = writeReport({
      resultsDir: fixture.dir,
      generatedAt: STARTED_AT,
    });
    assert.equal(aggregation.visibleRecordsPresent, false);
    assert.ok(markdown.includes("THE REWARD-HACKING GAP IS NOT MEASURED IN THIS DATASET"));
    assert.ok(markdown.includes("lower bound on the false-finish rate"));
    // Proxy gap for config A: declared done on 5 of 6, held-out pass on 4 of 6.
    const a = aggregation.phases[0]?.configs.find((c) => c.configId === "A");
    assert.equal(a?.visibleSource, "self-report-proxy");
    assert.ok(Math.abs((a?.gapPp ?? 0) - (100 * (5 / 6 - 4 / 6))) < 1e-9);
  } finally {
    fixture.cleanup();
  }
});

test("the screen phase refuses to declare a finalist", () => {
  const fixture = buildFixture();
  try {
    const { markdown } = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    assert.ok(markdown.includes("WITH ONE RUN PER CELL, NO WINNER IS REPORTED"));
    assert.ok(markdown.includes("refuses to declare a finalist from the screen phase alone"));
    assert.ok(markdown.includes("this list is UNORDERED and is not a ranking"));
  } finally {
    fixture.cleanup();
  }
});

test("the report carries the 'what this does NOT tell you' section", () => {
  const fixture = buildFixture();
  try {
    const { markdown } = writeReport({ resultsDir: fixture.dir, generatedAt: STARTED_AT });
    assert.ok(markdown.includes("## 9. What this report does NOT tell you"));
    assert.ok(markdown.includes("It is not a general model ranking"));
    assert.ok(markdown.includes("Effort rungs are not comparable across vendors"));
  } finally {
    fixture.cleanup();
  }
});

test("an unscored run is excluded from the rates and bounded in both directions", () => {
  const fixture = buildFixture();
  try {
    // Drop the score for A/T5 — the run that declared done and failed.
    const scores = RUN_PLAN.filter((_, index) => index !== 4).map((spec) =>
      JSON.stringify(makeScore(makeRun(spec), spec.pass)),
    );
    writeFileSync(join(fixture.dir, "scores.jsonl"), `${scores.join("\n")}\n`, "utf8");

    const { aggregation, markdown } = writeReport({
      resultsDir: fixture.dir,
      generatedAt: STARTED_AT,
    });
    const a = aggregation.phases[0]?.configs.find((c) => c.configId === "A");
    assert.ok(a !== undefined);
    assert.equal(a.heldOut?.n, 5, "the unscored run leaves the denominator");
    assert.equal(a.unscoredRunIds.length, 1);
    assert.equal(a.unscoredDeclaredDoneRunIds.length, 1);
    assert.ok(aggregation.phases[0]?.alerts.some((alert) => alert.kind === "unscored_runs"));
    assert.ok(markdown.includes("worst case"));
  } finally {
    fixture.cleanup();
  }
});

test("failures are clean BakeoffErrors, never stack traces", () => {
  assert.throws(
    () => writeReport({ resultsDir: join(tmpdir(), "bakeoff-does-not-exist-9f2c") }),
    (error: unknown) =>
      error instanceof BakeoffError && error.message.includes("results directory not found"),
  );

  const empty = mkdtempSync(join(tmpdir(), "bakeoff-empty-"));
  try {
    assert.throws(
      () => writeReport({ resultsDir: empty }),
      (error: unknown) => error instanceof BakeoffError && error.message.includes("no run records"),
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  const dup = mkdtempSync(join(tmpdir(), "bakeoff-dup-"));
  try {
    const run = JSON.stringify(makeRun(RUN_PLAN[0] as RunSpec));
    writeFileSync(join(dup, "runs.jsonl"), `${run}\n${run}\n`, "utf8");
    assert.throws(
      () => writeReport({ resultsDir: dup }),
      (error: unknown) => error instanceof BakeoffError && error.message.includes("duplicate run record"),
    );
  } finally {
    rmSync(dup, { recursive: true, force: true });
  }

  const malformed = mkdtempSync(join(tmpdir(), "bakeoff-malformed-"));
  try {
    writeFileSync(join(malformed, "runs.jsonl"), '{"runId": "x", "usage"\n', "utf8");
    assert.throws(
      () => writeReport({ resultsDir: malformed }),
      (error: unknown) => error instanceof BakeoffError && error.message.includes("not valid JSON"),
    );
  } finally {
    rmSync(malformed, { recursive: true, force: true });
  }
});
