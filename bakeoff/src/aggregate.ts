/**
 * aggregate.ts — run records + score records -> the numbers the report prints.
 *
 * This module makes no presentation decisions and no editorial ones. It joins,
 * counts, audits and applies the frozen definitions. Everything it computes is
 * either mandated by doc 03 section 7.5 or is an integrity check on whether the
 * experiment held together.
 *
 * FIVE CONVENTIONS, STATED HERE BECAUSE THE REPORT MUST DISCLOSE THEM:
 *
 *  1. PHASES ARE NEVER MIXED. Runs are grouped by `heldConstants.repeatCount`,
 *     which is held-constant variable 4 ("same for every configuration within a
 *     phase"). Pooling a 1-repeat screen run with a 3-repeat finals run weights
 *     the finalists' hard tickets three times and silently breaks the control.
 *     The phase name is DERIVED from the repeat count, not recorded.
 *
 *  2. DENOMINATORS. `attempts` excludes `status: "error"` — mandated by
 *     {@link ConfigOutcome}, because a harness failure is not a model outcome.
 *     It also excludes a non-error run with no score record, because that run's
 *     outcome is unknown and counting it either way is a guess. Both exclusions
 *     are counted, listed by runId, and bounded: the report prints what the
 *     co-primary rates would be if every unscored run had failed.
 *
 *  3. THE FROZEN DEFINITIONS ARE RECOMPUTED, NOT TRUSTED.
 *     `computeHeldOutPass` and `deriveFalseFinish` are re-run over the
 *     criteria results, and a disagreement with the persisted field is raised
 *     at BLOCKING severity naming the runIds. A scorer that wrote a pass its
 *     own criteria do not support invalidates constraint 1 of the protocol.
 *
 *  4. MONEY, NOT TOKENS, IS AGGREGATED ACROSS VENDORS. Token counts are
 *     summed only within one (provider, modelId, role). There is no
 *     cross-vendor token total anywhere in this file.
 *
 *  5. $ PER HELD-OUT PASS uses spend on COUNTED attempts. doc 04 section 9.4
 *     argues for total spend across all attempts; that convention is computed
 *     too, and the report states whether the decision-rule verdict is invariant
 *     between them.
 */

import {
  applyDecisionRule,
  assertNoDuplicateUsageRows,
  BakeoffError,
  computeHeldOutPass,
  deriveFalseFinish,
  dollarsPerHeldOutPass,
  PROVIDERS,
  resolvePrice,
  sumCostUsd,
} from "./contracts.js";
import type {
  ConfigOutcome,
  DecisionRuleResult,
  Effort,
  Provider,
  SeatRole,
  TicketTier,
} from "./contracts.js";
import { BASELINE_CONFIG_ID, CONFIGS, PHASES, REFERENCE_TICKET_SLOTS } from "./config.js";
import { compareProportions, estimateProportion, mean, median } from "./analyze.js";
import type { DifferenceEstimate, ProportionEstimate } from "./analyze.js";
import type { LoadedResults, LoadedRun, LoadedScore } from "./results-io.js";
import type { VisibleRunResult } from "./visible.js";

/* -------------------------------------------------------------------------
 * Alerts
 * ---------------------------------------------------------------------- */

/**
 * - `blocking` — a result computed from this data cannot be trusted at all.
 * - `critical` — a comparison is invalidated or a headline number is wrong.
 * - `warning`  — a stated caveat that changes how a number should be read.
 * - `note`     — disclosure, no action implied.
 */
export type AlertSeverity = "blocking" | "critical" | "warning" | "note";

export interface Alert {
  readonly severity: AlertSeverity;
  /** Stable machine key, so an alert can be grepped for across reports. */
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  /** runIds, configIds or providers the alert attaches to. */
  readonly affected: readonly string[];
}

const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = {
  blocking: 0,
  critical: 1,
  warning: 2,
  note: 3,
};

export function sortAlerts(alerts: readonly Alert[]): readonly Alert[] {
  return [...alerts].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------
 * Joined records
 * ---------------------------------------------------------------------- */

/** How a run's visible-test outcome was obtained. */
export type VisibleSource = "measured" | "self-report-proxy";

/** One run that counts toward a configuration's rates. */
export interface CountedRun {
  readonly run: LoadedRun;
  readonly score: LoadedScore;
  /** Recomputed from the criteria, never read from the persisted field. */
  readonly heldOutPass: boolean;
  /** Recomputed as `agentDeclaredDone && !heldOutPass`. */
  readonly falseFinish: boolean;
  readonly visiblePassed: boolean;
  readonly visibleSource: VisibleSource;
  readonly tier: TicketTier | "unknown";
}

/* -------------------------------------------------------------------------
 * Vendor aggregates
 * ---------------------------------------------------------------------- */

/** Token and dollar totals for one (provider, modelId, role) within one config. */
export interface VendorAggregate {
  readonly provider: Provider;
  readonly modelId: string;
  readonly role: SeatRole;
  /** All rows in this group must agree; a disagreement raises an alert. */
  readonly effort: Effort;
  readonly callCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Null when no run reported it. Never 0 as a substitute for "not reported". */
  readonly thinkingTokens: number | null;
  readonly costUsd: number;
  readonly runsCovered: number;
  readonly cacheHitFraction: number | null;
}

/** Cache behaviour for one provider within one config, summed then divided. */
export interface ProviderCacheAggregate {
  readonly provider: Provider;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly billedInputTokens: number;
  readonly hitFraction: number | null;
  /**
   * True when the traffic shows no evidence of caching at all.
   *
   * PROVIDER-AWARE ON PURPOSE. On Anthropic and Moonshot the signal is
   * `cache_read == 0 AND cache_write == 0` (doc 04 section 3.4: a prefix below
   * the minimum cacheable length fails silently, no error is returned, and the
   * block is billed at 10x). On DeepSeek `cacheWriteTokens` is ALWAYS 0 by
   * construction — PRICE_TABLE's own note requires adapters to report writes as
   * ordinary input, because DeepSeek bills no separate write line item — so the
   * two-field test would fire on every DeepSeek run and cry wolf on exactly the
   * configuration whose 138x-cheaper cache read is the headline claim.
   */
  readonly notCachedAtAll: boolean;
  readonly costUsd: number;
}

/**
 * Aggregate cache-hit fraction: `cache_read / (cache_read + cache_write + input)`.
 *
 * The same definition as the frozen per-row `vendorCacheHitFraction`, applied to
 * summed counts. It must be computed from sums, never as the mean of per-run
 * fractions: a mean of ratios weights a 300-token call the same as a 3M-token
 * one. src/report.test.ts asserts this function agrees with the frozen one on a
 * single row.
 */
export function aggregateCacheHitFraction(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  inputTokens: number,
): number | null {
  const total = cacheReadTokens + cacheWriteTokens + inputTokens;
  if (total <= 0) return null;
  return cacheReadTokens / total;
}

/* -------------------------------------------------------------------------
 * Cost
 * ---------------------------------------------------------------------- */

export interface CostSummary {
  /** Spend on runs that count toward the rates. */
  readonly countedSpendUsd: number;
  /** Spend on runs excluded as harness/infrastructure failures. */
  readonly harnessErrorSpendUsd: number;
  /** Spend on non-error runs that were never scored. */
  readonly unscoredSpendUsd: number;
  /** Every dollar this configuration spent, whatever the outcome. */
  readonly allSpendUsd: number;
  readonly dollarsPerAttempt: number | null;
  /** Counted-attempt spend divided by held-out passes. Null when nothing passed. */
  readonly dollarsPerHeldOutPass: number | null;
  /** doc 04 section 9.4's convention: every dollar, divided by passes. */
  readonly dollarsPerHeldOutPassAllSpend: number | null;
}

/**
 * What one config's dollar figures would become if a price this harness ASSUMED
 * turns out to carry a premium.
 *
 * Only Moonshot triggers this today: PRICE_TABLE records Kimi K3's cache-write
 * charge as `assumed` at multiplier 1.0 on the input rate, because Moonshot
 * documents neither a TTL nor a write charge, and states the sensitivity —
 * "at an Anthropic-style 1.25x premium the write rate is $3.75/MTok". Condition
 * (ii) of the decision rule is a 30% DOLLAR threshold, so if this delta can move
 * a configuration across that line the assumption is deciding the verdict and
 * the operator must see it there, not in a pricing footnote.
 */
export interface AssumedPriceSensitivity {
  readonly provider: Provider;
  readonly modelId: string;
  readonly assumedMultiplier: number;
  readonly alternativeMultiplier: number;
  readonly cacheWriteTokens: number;
  readonly inputUsdPerMTok: number;
  /** Additional spend if the alternative multiplier is the real one. */
  readonly deltaUsd: number;
}

/**
 * The premium tested against every assumed cache-write price.
 *
 * 1.25x is Anthropic's documented 5-minute write premium and is the exact
 * sensitivity PRICE_TABLE's Kimi K3 note names. It is a stated alternative, not
 * a claim about Moonshot's real pricing — which remains undocumented, and which
 * measuring is one of the two reasons the Kimi configurations are in the matrix.
 */
export const ALTERNATIVE_CACHE_WRITE_MULTIPLIER = 1.25;

const TOKENS_PER_MTOK = 1_000_000;

/* -------------------------------------------------------------------------
 * Per-config summary
 * ---------------------------------------------------------------------- */

export interface ConfigSummary {
  readonly configId: string;
  /** From CONFIGS, or null when the results contain a config the matrix does not. */
  readonly label: string | null;
  /** Null when the configuration has no counted attempts in this phase. */
  readonly outcome: ConfigOutcome | null;
  readonly heldOut: ProportionEstimate | null;
  readonly falseFinish: ProportionEstimate | null;
  readonly visible: ProportionEstimate | null;
  readonly visibleSource: VisibleSource | "none";
  /** visible rate minus held-out rate, in percentage points. */
  readonly gapPp: number | null;
  readonly meanWallClockMs: number | null;
  readonly medianWallClockMs: number | null;
  readonly counted: readonly CountedRun[];
  readonly unscoredRunIds: readonly string[];
  /** Unscored AND the agent declared done: an excluded potential false finish. */
  readonly unscoredDeclaredDoneRunIds: readonly string[];
  readonly errorRunIds: readonly string[];
  readonly cost: CostSummary;
  readonly vendors: readonly VendorAggregate[];
  readonly providerCache: readonly ProviderCacheAggregate[];
  readonly sensitivities: readonly AssumedPriceSensitivity[];
  /** e.g. "moonshot/kimi-k3: cacheWrite5m, cacheWrite1h". */
  readonly assumedPriceNotes: readonly string[];
  readonly ticketIds: readonly string[];
}

/* -------------------------------------------------------------------------
 * The decision rule, applied
 * ---------------------------------------------------------------------- */

export interface DecisionApplication {
  readonly configId: string;
  readonly result: DecisionRuleResult;
  /** The Wald standard error fed to condition (i). */
  readonly baselineStdErr: number;
  readonly baselineStdErrDegenerate: boolean;
  /** The baseline rate the standard error was computed from. Reported so a degenerate SE can be explained. */
  readonly baselineHeldOutPassRate: number;
  /** Filled arithmetic for each condition, e.g. "0.500 >= 0.667 - 0.192 = 0.475". */
  readonly conditionOneArithmetic: string;
  readonly conditionTwoArithmetic: string;
  readonly conditionThreeArithmetic: string;
  /**
   * Whether condition (ii) reaches the same answer under doc 04 section 9.4's
   * all-spend convention. Null when it cannot be computed under both.
   */
  readonly costConventionInvariant: boolean | null;
  /** Whether condition (ii) survives the assumed-cache-write sensitivity. */
  readonly assumedPriceInvariant: boolean | null;
  readonly assumedPriceDeltaUsd: number;
  /** Newcombe comparison of held-out pass rates against baseline. */
  readonly heldOutDifference: DifferenceEstimate | null;
  readonly falseFinishDifference: DifferenceEstimate | null;
}

/* -------------------------------------------------------------------------
 * Phase
 * ---------------------------------------------------------------------- */

export interface TierSummary {
  readonly tier: TicketTier | "unknown";
  readonly attempts: number;
  readonly heldOutPasses: number;
  readonly visiblePasses: number;
  readonly gapPp: number | null;
}

export interface PhaseReport {
  /** Derived from repeatCount, never read from a record. */
  readonly phaseId: string;
  readonly derivedFrom: string;
  readonly repeatCount: number;
  readonly runCount: number;
  readonly configs: readonly ConfigSummary[];
  readonly baselineConfigId: string;
  readonly baselinePresent: boolean;
  readonly decisions: readonly DecisionApplication[];
  readonly ticketIds: readonly string[];
  readonly tiers: readonly TierSummary[];
  readonly alerts: readonly Alert[];
}

export interface Aggregation {
  readonly generatedAt: string;
  readonly files: readonly string[];
  readonly runCount: number;
  readonly scoreCount: number;
  readonly visibleCount: number;
  readonly ledgerEventCount: number;
  readonly unrecognisedLineCount: number;
  readonly totalLines: number;
  readonly phases: readonly PhaseReport[];
  readonly alerts: readonly Alert[];
  /** True when at least one measured visible-test record was supplied. */
  readonly visibleRecordsPresent: boolean;
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(byString);
}

function tierOf(ticketId: string): TicketTier | "unknown" {
  const slot = REFERENCE_TICKET_SLOTS.find((s) => s.id === ticketId);
  return slot === undefined ? "unknown" : slot.tier;
}

function labelOf(configId: string): string | null {
  const config = CONFIGS.find((c) => c.id === configId);
  return config === undefined ? null : config.label;
}

function phaseIdFor(repeatCount: number): string {
  for (const phase of Object.values(PHASES)) {
    if (phase.repeatCount === repeatCount) return phase.id;
  }
  return `repeat-${String(repeatCount)}`;
}

/** Relative comparison for money; absolute for values near zero. */
function nearlyEqual(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-6 * scale;
}

/* -------------------------------------------------------------------------
 * Integrity audits
 * ---------------------------------------------------------------------- */

function auditRecordIntegrity(
  runs: readonly LoadedRun[],
  scoreByRunId: ReadonlyMap<string, LoadedScore>,
  visibleByRunId: ReadonlyMap<string, VisibleRunResult>,
): readonly Alert[] {
  const alerts: Alert[] = [];
  const runById = new Map(runs.map((run) => [run.runId, run]));

  const fabricatedPass: string[] = [];
  const falseFinishMismatch: string[] = [];
  const declaredDoneMismatch: string[] = [];
  const suiteDigestMismatch: string[] = [];
  const costMismatch: string[] = [];
  const repeatIndexOutOfRange: string[] = [];
  const ticketMismatch: string[] = [];
  const orphanScores: string[] = [];
  const orphanVisible: string[] = [];

  for (const run of runs) {
    try {
      assertNoDuplicateUsageRows(run.usage);
    } catch (error) {
      if (error instanceof BakeoffError) {
        alerts.push({
          severity: "critical",
          kind: "duplicate_usage_row",
          title: "A run record contains duplicate usage rows",
          detail:
            `${run.runId}: ${error.message}. Duplicated rows double-count that vendor's tokens ` +
            "and dollars and corrupt the per-vendor cache-hit fraction.",
          affected: [run.runId],
        });
      } else {
        throw error;
      }
    }

    if (!nearlyEqual(sumCostUsd(run.usage), run.totalCostUsd)) {
      costMismatch.push(run.runId);
    }
    if (run.repeatIndex >= run.heldConstants.repeatCount) {
      repeatIndexOutOfRange.push(run.runId);
    }

    const score = scoreByRunId.get(run.runId);
    if (score === undefined) continue;

    const recomputedPass = computeHeldOutPass(score.criteriaResults, score.protectedPathViolations);
    if (recomputedPass !== score.heldOutPass) fabricatedPass.push(run.runId);

    const recomputedFalseFinish = deriveFalseFinish(run.agentDeclaredDone, recomputedPass);
    if (recomputedFalseFinish !== score.falseFinish) falseFinishMismatch.push(run.runId);

    if (score.agentDeclaredDone !== run.agentDeclaredDone) declaredDoneMismatch.push(run.runId);
    if (score.acceptanceSuiteSha256 !== run.heldConstants.acceptanceSuiteSha256) {
      suiteDigestMismatch.push(run.runId);
    }
    if (score.ticketId !== run.ticketId) ticketMismatch.push(run.runId);
  }

  for (const runId of scoreByRunId.keys()) {
    if (!runById.has(runId)) orphanScores.push(runId);
  }
  for (const runId of visibleByRunId.keys()) {
    if (!runById.has(runId)) orphanVisible.push(runId);
  }

  if (fabricatedPass.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "held_out_pass_disagrees_with_criteria",
      title: "A score record's heldOutPass does not follow from its own criteria",
      detail:
        "computeHeldOutPass() recomputed from criteriaResults and protectedPathViolations " +
        "disagrees with the persisted heldOutPass. THIS REPORT USES THE RECOMPUTED VALUE. A " +
        "scorer that recorded a pass its own criteria do not support invalidates the sealed gate, " +
        "which is constraint 1 of the protocol — do not act on any number in this report until it " +
        "is explained.",
      affected: unique(fabricatedPass),
    });
  }
  if (falseFinishMismatch.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "false_finish_disagrees_with_definition",
      title: "A score record's falseFinish is not `agentDeclaredDone && !heldOutPass`",
      detail:
        "deriveFalseFinish() is the only definition of the co-primary metric that decides whether " +
        "a configuration ships broken apps. THIS REPORT USES THE RECOMPUTED VALUE.",
      affected: unique(falseFinishMismatch),
    });
  }
  if (declaredDoneMismatch.length > 0) {
    alerts.push({
      severity: "critical",
      kind: "agent_declared_done_mismatch",
      title: "Run record and score record disagree on the agent's self-report",
      detail:
        "The RUN RECORD is authoritative: it is written by the supervising process, while the " +
        "score record copies the field so it can stand alone. A disagreement means the copy was " +
        "made from something else.",
      affected: unique(declaredDoneMismatch),
    });
  }
  if (suiteDigestMismatch.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "acceptance_suite_digest_mismatch",
      title: "The suite that was scored is not the suite the run was held to",
      detail:
        "score.acceptanceSuiteSha256 differs from run.heldConstants.acceptanceSuiteSha256. Either " +
        "the frozen suite changed between build and score, or the run was scored against another " +
        "ticket's suite. Held-constant variable 5 is broken for these runs.",
      affected: unique(suiteDigestMismatch),
    });
  }
  if (ticketMismatch.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "ticket_id_mismatch",
      title: "A run and its score record name different tickets",
      detail: "The join is wrong, or a score record was written against the wrong run.",
      affected: unique(ticketMismatch),
    });
  }
  if (costMismatch.length > 0) {
    alerts.push({
      severity: "critical",
      kind: "total_cost_disagrees_with_usage",
      title: "totalCostUsd does not equal the sum of its usage rows",
      detail:
        "sumCostUsd(run.usage) differs from run.totalCostUsd. Every dollar figure in this report " +
        "is built from the run-level total; a mismatch means spend is being attributed to a vendor " +
        "it did not come from, or is missing entirely.",
      affected: unique(costMismatch),
    });
  }
  if (repeatIndexOutOfRange.length > 0) {
    alerts.push({
      severity: "critical",
      kind: "repeat_index_out_of_range",
      title: "repeatIndex is outside the phase's repeat count",
      detail:
        "A run with repeatIndex >= heldConstants.repeatCount was written. Phase membership in this " +
        "report is DERIVED from repeatCount, so such a run has been grouped with a phase it does " +
        "not belong to, and held-constant variable 4 is not what the records claim.",
      affected: unique(repeatIndexOutOfRange),
    });
  }
  if (orphanScores.length > 0) {
    alerts.push({
      severity: "critical",
      kind: "score_without_run",
      title: "Score records exist for runs that are not in the results",
      detail:
        "A scored run with no run record contributes no spend, no wall clock and no held constants, " +
        "and cannot be counted. Its build record is missing.",
      affected: unique(orphanScores),
    });
  }
  if (orphanVisible.length > 0) {
    alerts.push({
      severity: "warning",
      kind: "visible_result_without_run",
      title: "Visible-test records exist for runs that are not in the results",
      detail: "These records are ignored. The run records they refer to are missing.",
      affected: unique(orphanVisible),
    });
  }

  return alerts;
}

/**
 * Does the usage actually billed match the configuration the run claims?
 *
 * A run tagged `configId: "C"` that billed no Moonshot tokens did not run
 * config C, whatever its record says — the harness dispatched a different
 * model, and every number attributed to that configuration is attributed to the
 * wrong thing. Nothing else in this pipeline would catch it: the record is
 * internally consistent, the join succeeds and the rates compute.
 *
 * The `spec` and `judge` seats are deliberately not required to appear: the
 * acceptance suite is authored once per ticket BEFORE any build, so its spend
 * legitimately sits outside the build run's usage.
 */
function auditSeatUsage(runs: readonly LoadedRun[]): readonly Alert[] {
  const alerts: Alert[] = [];
  const mismatches: string[] = [];
  const missing: string[] = [];
  const unknownConfigs = new Set<string>();
  const underTest: readonly SeatRole[] = ["orchestrator", "subagent"];

  for (const run of runs) {
    const config = CONFIGS.find((c) => c.id === run.configId);
    if (config === undefined) {
      unknownConfigs.add(run.configId);
      continue;
    }
    for (const role of underTest) {
      const seat = config.seats.find((s) => s.role === role);
      if (seat === undefined) continue;
      const rows = run.usage.filter((u) => u.role === role);
      if (rows.length === 0) {
        missing.push(`${run.runId} (no ${role} usage)`);
        continue;
      }
      for (const row of rows) {
        if (row.provider !== seat.provider || row.modelId !== seat.modelId) {
          mismatches.push(
            `${run.runId}: ${role} billed ${row.provider}/${row.modelId}, but config ` +
              `${config.id} declares ${seat.provider}/${seat.modelId}`,
          );
        }
      }
    }
  }

  if (mismatches.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "usage_does_not_match_configuration",
      title: "A run billed a model its configuration does not declare",
      detail:
        "The configuration under test is the orchestrator/subagent pair. A run whose usage names a " +
        "different model did not run the configuration it is filed under, and every rate and dollar " +
        "figure attributed to that configuration is attributed to the wrong thing.",
      affected: unique(mismatches),
    });
  }
  if (missing.length > 0) {
    alerts.push({
      severity: "warning",
      kind: "seat_billed_nothing",
      title: "A seat under test billed no usage at all",
      detail:
        "A subagent seat that billed nothing may simply never have been delegated to on that " +
        "ticket, which is a real and reportable outcome. An orchestrator seat that billed nothing " +
        "is an instrumentation failure: the run cannot have happened without it.",
      affected: unique(missing),
    });
  }
  if (unknownConfigs.size > 0) {
    alerts.push({
      severity: "warning",
      kind: "config_not_in_matrix",
      title: "The results contain a configuration the matrix does not define",
      detail:
        "Its rows are still reported, but its seats, efforts and evidence cannot be checked against " +
        "src/config.ts, so none of the held-constant audits cover it.",
      affected: [...unknownConfigs].sort(byString),
    });
  }

  return alerts;
}

function auditHeldConstants(runs: readonly LoadedRun[]): readonly Alert[] {
  const alerts: Alert[] = [];

  const distinct = (values: readonly string[]): readonly string[] => unique(values);

  const imageDigests = distinct(runs.map((r) => r.heldConstants.sandbox.imageDigest));
  if (imageDigests.length > 1) {
    alerts.push({
      severity: "blocking",
      kind: "sandbox_image_varied",
      title: "Held-constant variable 3 broken: more than one sandbox image was used",
      detail:
        `${String(imageDigests.length)} distinct image digests appear across these runs. The ` +
        "sandbox image and network policy must be identical for every configuration; Cursor " +
        "measured 14.1-20.7pp of apparent quality evaporating when exactly this environment was " +
        "sealed, which is larger than any model difference this bake-off can detect.",
      affected: imageDigests,
    });
  }

  const networkPolicies = distinct(
    runs.map(
      (r) =>
        `${r.heldConstants.sandbox.networkPolicy.egress}[${[...r.heldConstants.sandbox.networkPolicy.allowedHosts]
          .sort(byString)
          .join(",")}]`,
    ),
  );
  if (networkPolicies.length > 1) {
    alerts.push({
      severity: "blocking",
      kind: "network_policy_varied",
      title: "Held-constant variable 3 broken: the network policy changed between runs",
      detail:
        "The egress policy or the host allowlist is not identical across runs. The allowlist is " +
        "part of the held-constant sandbox; changing it mid-bake-off invalidates the comparison.",
      affected: networkPolicies,
    });
  }

  const harnesses = distinct(
    runs.map((r) => `${r.heldConstants.harness.id}@${r.heldConstants.harness.version}+${r.heldConstants.harness.commit}`),
  );
  if (harnesses.length > 1) {
    alerts.push({
      severity: "critical",
      kind: "harness_varied",
      title: "Held-constant variable 2 broken: more than one harness build produced these runs",
      detail:
        "One harness, ours, for every configuration. A silent harness change is the documented " +
        "cause of every cost blowup in the community trackers (doc 04 section 9.2) and the " +
        "measured harness effect is 0 to +5.1pp — the same order as the model gap being measured.",
      affected: harnesses,
    });
  }

  const efforts = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const effort of run.heldConstants.efforts) {
      const key = `${effort.provider}/${effort.modelId} as ${effort.role}`;
      const set = efforts.get(key) ?? new Set<string>();
      set.add(`${effort.effort} (${effort.effortSource})`);
      efforts.set(key, set);
    }
  }
  const variedEfforts = [...efforts.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([key, set]) => `${key}: ${[...set].sort(byString).join(" | ")}`)
    .sort(byString);
  if (variedEfforts.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "effort_varied",
      title: "Held-constant variable 1 broken: a seat ran at more than one reasoning effort",
      detail:
        "Effort alone is worth 250-497 Elo on AA-Briefcase, against an 11.24pp spread across " +
        "frontier models. A seat that ran at two rungs is not a controlled variable and the " +
        "configurations that used it cannot be compared.",
      affected: variedEfforts,
    });
  }

  const suiteByTicket = new Map<string, Set<string>>();
  const briefByTicket = new Map<string, Set<string>>();
  for (const run of runs) {
    const suites = suiteByTicket.get(run.ticketId) ?? new Set<string>();
    suites.add(run.heldConstants.acceptanceSuiteSha256);
    suiteByTicket.set(run.ticketId, suites);

    const briefs = briefByTicket.get(run.ticketId) ?? new Set<string>();
    briefs.add(run.ticketSha256);
    briefByTicket.set(run.ticketId, briefs);
  }
  const variedSuites = [...suiteByTicket.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([ticketId]) => ticketId)
    .sort(byString);
  if (variedSuites.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "acceptance_suite_varied",
      title: "Held-constant variable 5 broken: one ticket was run against more than one suite",
      detail:
        "Every configuration must build against the same frozen suite for the same ticket. " +
        "Different suites means the configurations were graded against different exams.",
      affected: variedSuites,
    });
  }
  const variedBriefs = [...briefByTicket.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([ticketId]) => ticketId)
    .sort(byString);
  if (variedBriefs.length > 0) {
    alerts.push({
      severity: "blocking",
      kind: "ticket_text_varied",
      title: "A ticket brief was edited between runs",
      detail:
        "ticketSha256 is not constant for this ticket id. The ticket text is frozen verbatim and " +
        "is never edited between runs (doc 03 section 7.1). Runs before and after the edit are not " +
        "the same experiment.",
      affected: variedBriefs,
    });
  }

  return alerts;
}

/* -------------------------------------------------------------------------
 * Vendor aggregation
 * ---------------------------------------------------------------------- */

interface MutableVendorTotals {
  provider: Provider;
  modelId: string;
  role: SeatRole;
  efforts: Set<string>;
  callCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number | null;
  costUsd: number;
  runsCovered: number;
}

function aggregateVendors(
  counted: readonly CountedRun[],
  configId: string,
  alerts: Alert[],
): readonly VendorAggregate[] {
  const totals = new Map<string, MutableVendorTotals>();

  for (const { run } of counted) {
    for (const usage of run.usage) {
      const key = `${usage.provider}|${usage.modelId}|${usage.role}`;
      const existing = totals.get(key);
      const entry: MutableVendorTotals = existing ?? {
        provider: usage.provider,
        modelId: usage.modelId,
        role: usage.role,
        efforts: new Set<string>(),
        callCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: null,
        costUsd: 0,
        runsCovered: 0,
      };
      entry.efforts.add(usage.effort);
      entry.callCount += usage.callCount;
      entry.inputTokens += usage.inputTokens;
      entry.cacheReadTokens += usage.cacheReadTokens;
      entry.cacheWriteTokens += usage.cacheWriteTokens;
      entry.outputTokens += usage.outputTokens;
      if (usage.thinkingTokens !== null) {
        entry.thinkingTokens = (entry.thinkingTokens ?? 0) + usage.thinkingTokens;
      }
      entry.costUsd += usage.costUsd;
      entry.runsCovered += 1;
      totals.set(key, entry);
    }
  }

  const out: VendorAggregate[] = [];
  for (const entry of totals.values()) {
    if (entry.efforts.size > 1) {
      alerts.push({
        severity: "blocking",
        kind: "effort_varied_within_usage",
        title: "One seat billed usage at more than one reasoning effort",
        detail:
          `config ${configId}, ${entry.provider}/${entry.modelId} as ${entry.role}: ` +
          `${[...entry.efforts].sort(byString).join(", ")}. Held-constant variable 1.`,
        affected: [configId],
      });
    }
    const effort = [...entry.efforts].sort(byString)[0];
    if (effort === undefined) continue;
    out.push({
      provider: entry.provider,
      modelId: entry.modelId,
      role: entry.role,
      effort: effort as Effort,
      callCount: entry.callCount,
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      costUsd: entry.costUsd,
      runsCovered: entry.runsCovered,
      cacheHitFraction: aggregateCacheHitFraction(
        entry.cacheReadTokens,
        entry.cacheWriteTokens,
        entry.inputTokens,
      ),
    });
  }

  return out.sort(
    (a, b) =>
      byString(a.provider, b.provider) || byString(a.modelId, b.modelId) || byString(a.role, b.role),
  );
}

function aggregateProviderCache(
  vendors: readonly VendorAggregate[],
): readonly ProviderCacheAggregate[] {
  const out: ProviderCacheAggregate[] = [];
  for (const provider of PROVIDERS) {
    const rows = vendors.filter((v) => v.provider === provider);
    if (rows.length === 0) continue;
    const inputTokens = rows.reduce((total, r) => total + r.inputTokens, 0);
    const cacheReadTokens = rows.reduce((total, r) => total + r.cacheReadTokens, 0);
    const cacheWriteTokens = rows.reduce((total, r) => total + r.cacheWriteTokens, 0);
    const billedInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
    const hasTraffic = billedInputTokens > 0;
    // See ProviderCacheAggregate.notCachedAtAll for why DeepSeek is tested differently.
    const notCachedAtAll =
      hasTraffic &&
      (provider === "deepseek"
        ? cacheReadTokens === 0
        : cacheReadTokens === 0 && cacheWriteTokens === 0);
    out.push({
      provider,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      billedInputTokens,
      hitFraction: aggregateCacheHitFraction(cacheReadTokens, cacheWriteTokens, inputTokens),
      notCachedAtAll,
      costUsd: rows.reduce((total, r) => total + r.costUsd, 0),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Assumed-price sensitivity
 * ---------------------------------------------------------------------- */

function computeSensitivities(
  counted: readonly CountedRun[],
  configId: string,
  alerts: Alert[],
): readonly AssumedPriceSensitivity[] {
  interface Accumulator {
    provider: Provider;
    modelId: string;
    assumedMultiplier: number;
    cacheWriteTokens: number;
    pricedAt: string;
  }
  const accumulators = new Map<string, Accumulator>();

  for (const { run } of counted) {
    for (const usage of run.usage) {
      if (usage.cacheWriteTokens <= 0) continue;
      const basis = run.pricingBasis.find(
        (b) => b.provider === usage.provider && b.modelId === usage.modelId,
      );
      if (basis === undefined) continue;
      const multiplier = basis.assumedCacheWriteMultiplier;
      const writeAssumed =
        basis.assumedFields.includes("cacheWrite5m") || basis.assumedFields.includes("cacheWrite1h");
      if (multiplier === null || !writeAssumed) continue;

      const key = `${usage.provider}|${usage.modelId}`;
      const entry = accumulators.get(key) ?? {
        provider: usage.provider,
        modelId: usage.modelId,
        assumedMultiplier: multiplier,
        cacheWriteTokens: 0,
        pricedAt: basis.pricedAt,
      };
      entry.cacheWriteTokens += usage.cacheWriteTokens;
      accumulators.set(key, entry);
    }
  }

  const out: AssumedPriceSensitivity[] = [];
  for (const entry of accumulators.values()) {
    let inputUsdPerMTok: number | null = null;
    try {
      inputUsdPerMTok = resolvePrice(entry.provider, entry.modelId, entry.pricedAt).price
        .inputUsdPerMTok;
    } catch (error) {
      alerts.push({
        severity: "warning",
        kind: "sensitivity_not_computable",
        title: "Could not price the assumed-cache-write sensitivity",
        detail:
          `config ${configId}, ${entry.provider}/${entry.modelId}: ` +
          (error instanceof BakeoffError ? error.message : "price lookup failed") +
          ". The dollar figures for this configuration rest on an assumed cache-write price whose " +
          "sensitivity could not be quantified.",
        affected: [configId],
      });
      continue;
    }
    if (inputUsdPerMTok === null) continue;

    out.push({
      provider: entry.provider,
      modelId: entry.modelId,
      assumedMultiplier: entry.assumedMultiplier,
      alternativeMultiplier: ALTERNATIVE_CACHE_WRITE_MULTIPLIER,
      cacheWriteTokens: entry.cacheWriteTokens,
      inputUsdPerMTok,
      deltaUsd:
        (entry.cacheWriteTokens / TOKENS_PER_MTOK) *
        inputUsdPerMTok *
        (ALTERNATIVE_CACHE_WRITE_MULTIPLIER - entry.assumedMultiplier),
    });
  }

  return out.sort((a, b) => byString(a.provider, b.provider) || byString(a.modelId, b.modelId));
}

function assumedPriceNotesFor(counted: readonly CountedRun[]): readonly string[] {
  const notes = new Set<string>();
  for (const { run } of counted) {
    for (const basis of run.pricingBasis) {
      if (basis.assumedFields.length > 0) {
        notes.add(
          `${basis.provider}/${basis.modelId}: ${[...basis.assumedFields].sort(byString).join(", ")} ` +
            `assumed (multiplier ${basis.assumedCacheWriteMultiplier ?? "n/a"}, source: ${basis.source})`,
        );
      }
      for (const [field, status] of Object.entries(basis.fieldStatus)) {
        if (status === "unverified") {
          notes.add(`${basis.provider}/${basis.modelId}: ${field} UNVERIFIED — no price is known`);
        }
      }
    }
  }
  return [...notes].sort(byString);
}

/* -------------------------------------------------------------------------
 * Config summary
 * ---------------------------------------------------------------------- */

function summariseConfig(
  configId: string,
  runs: readonly LoadedRun[],
  scoreByRunId: ReadonlyMap<string, LoadedScore>,
  visibleByRunId: ReadonlyMap<string, VisibleRunResult>,
  alerts: Alert[],
): ConfigSummary {
  const counted: CountedRun[] = [];
  const unscoredRunIds: string[] = [];
  const unscoredDeclaredDoneRunIds: string[] = [];
  const errorRunIds: string[] = [];
  let harnessErrorSpendUsd = 0;
  let unscoredSpendUsd = 0;

  for (const run of [...runs].sort((a, b) => byString(a.runId, b.runId))) {
    if (run.status === "error") {
      errorRunIds.push(run.runId);
      harnessErrorSpendUsd += run.totalCostUsd;
      continue;
    }
    const score = scoreByRunId.get(run.runId);
    if (score === undefined) {
      unscoredRunIds.push(run.runId);
      unscoredSpendUsd += run.totalCostUsd;
      if (run.agentDeclaredDone) unscoredDeclaredDoneRunIds.push(run.runId);
      continue;
    }
    const heldOutPass = computeHeldOutPass(score.criteriaResults, score.protectedPathViolations);
    const measured = visibleByRunId.get(run.runId);
    counted.push({
      run,
      score,
      heldOutPass,
      falseFinish: deriveFalseFinish(run.agentDeclaredDone, heldOutPass),
      visiblePassed: measured === undefined ? run.agentDeclaredDone : measured.visibleSuitePassed,
      visibleSource: measured === undefined ? "self-report-proxy" : "measured",
      tier: tierOf(run.ticketId),
    });
  }

  const attempts = counted.length;
  const countedSpendUsd = counted.reduce((total, c) => total + c.run.totalCostUsd, 0);
  const allSpendUsd = countedSpendUsd + harnessErrorSpendUsd + unscoredSpendUsd;
  const heldOutPasses = counted.filter((c) => c.heldOutPass).length;

  const cost: CostSummary = {
    countedSpendUsd,
    harnessErrorSpendUsd,
    unscoredSpendUsd,
    allSpendUsd,
    dollarsPerAttempt: attempts > 0 ? countedSpendUsd / attempts : null,
    dollarsPerHeldOutPass: dollarsPerHeldOutPass(countedSpendUsd, heldOutPasses),
    dollarsPerHeldOutPassAllSpend: dollarsPerHeldOutPass(allSpendUsd, heldOutPasses),
  };

  const vendors = aggregateVendors(counted, configId, alerts);
  const providerCache = aggregateProviderCache(vendors);
  const wallClocks = counted.map((c) => c.run.wallClockMs);

  const cacheHitFractionByProvider: Partial<Record<Provider, number>> = {};
  for (const entry of providerCache) {
    if (entry.hitFraction !== null) cacheHitFractionByProvider[entry.provider] = entry.hitFraction;
  }

  const sourcesUsed = new Set(counted.map((c) => c.visibleSource));
  const visibleSource: VisibleSource | "none" =
    attempts === 0
      ? "none"
      : sourcesUsed.has("self-report-proxy")
        ? "self-report-proxy"
        : "measured";
  if (sourcesUsed.size > 1) {
    alerts.push({
      severity: "warning",
      kind: "visible_source_mixed",
      title: "Visible-test outcomes come from two different sources within one configuration",
      detail:
        `config ${configId}: some runs have a measured visible-suite result and some fall back to ` +
        "the self-report proxy. The visible rate for this configuration mixes two quantities and " +
        "is reported at the weaker one's meaning.",
      affected: [configId],
    });
  }

  if (attempts === 0) {
    return {
      configId,
      label: labelOf(configId),
      outcome: null,
      heldOut: null,
      falseFinish: null,
      visible: null,
      visibleSource: "none",
      gapPp: null,
      meanWallClockMs: null,
      medianWallClockMs: null,
      counted,
      unscoredRunIds,
      unscoredDeclaredDoneRunIds,
      errorRunIds,
      cost,
      vendors,
      providerCache,
      sensitivities: [],
      assumedPriceNotes: [],
      ticketIds: unique(runs.map((r) => r.ticketId)),
    };
  }

  const falseFinishes = counted.filter((c) => c.falseFinish).length;
  const visiblePasses = counted.filter((c) => c.visiblePassed).length;
  const heldOut = estimateProportion(heldOutPasses, attempts);
  const falseFinish = estimateProportion(falseFinishes, attempts);
  const visible = estimateProportion(visiblePasses, attempts);

  const outcome: ConfigOutcome = {
    configId,
    attempts,
    harnessErrors: errorRunIds.length,
    heldOutPassRate: heldOut.rate,
    falseFinishRate: falseFinish.rate,
    timeoutRate: counted.filter((c) => c.run.status === "timeout").length / attempts,
    blockedRate: counted.filter((c) => c.run.status === "blocked").length / attempts,
    budgetExceededRate: counted.filter((c) => c.run.status === "budget_exceeded").length / attempts,
    medianWallClockMs: median(wallClocks) ?? 0,
    cacheHitFractionByProvider,
    dollarsPerAttempt: cost.dollarsPerAttempt ?? 0,
    dollarsPerHeldOutPass: cost.dollarsPerHeldOutPass,
  };

  return {
    configId,
    label: labelOf(configId),
    outcome,
    heldOut,
    falseFinish,
    visible,
    visibleSource,
    gapPp: (visible.rate - heldOut.rate) * 100,
    meanWallClockMs: mean(wallClocks),
    medianWallClockMs: median(wallClocks),
    counted,
    unscoredRunIds,
    unscoredDeclaredDoneRunIds,
    errorRunIds,
    cost,
    vendors,
    providerCache,
    sensitivities: computeSensitivities(counted, configId, alerts),
    assumedPriceNotes: assumedPriceNotesFor(counted),
    ticketIds: unique(counted.map((c) => c.run.ticketId)),
  };
}

/* -------------------------------------------------------------------------
 * Decision rule
 * ---------------------------------------------------------------------- */

function withCostPerPass(outcome: ConfigOutcome, cost: number | null): ConfigOutcome {
  return { ...outcome, dollarsPerHeldOutPass: cost };
}

/**
 * Four decimals, not three: the printed arithmetic must reconcile by eye.
 * At three, a baseline of 0.667 minus an SE of 0.192 reads as 0.475 while the
 * threshold actually used is 0.474, and a reader is entitled to conclude the
 * report cannot subtract.
 */
function fmt(value: number, digits = 4): string {
  return value.toFixed(digits);
}

function money(value: number | null): string {
  return value === null ? "undefined (no held-out pass)" : `$${value.toFixed(2)}`;
}

function applyRuleTo(
  baseline: ConfigSummary,
  candidate: ConfigSummary,
): DecisionApplication | null {
  const baseOutcome = baseline.outcome;
  const candOutcome = candidate.outcome;
  const baseHeldOut = baseline.heldOut;
  const candHeldOut = candidate.heldOut;
  if (baseOutcome === null || candOutcome === null || baseHeldOut === null || candHeldOut === null) {
    return null;
  }

  const baselineStdErr = baseHeldOut.standardError;
  const result = applyDecisionRule({
    baseline: baseOutcome,
    candidate: candOutcome,
    baselineHeldOutPassStdErr: baselineStdErr,
  });

  // doc 04 section 9.4's convention: every dollar spent, over passes.
  const allSpendResult = applyDecisionRule({
    baseline: withCostPerPass(baseOutcome, baseline.cost.dollarsPerHeldOutPassAllSpend),
    candidate: withCostPerPass(candOutcome, candidate.cost.dollarsPerHeldOutPassAllSpend),
    baselineHeldOutPassStdErr: baselineStdErr,
  });

  const baseDelta = baseline.sensitivities.reduce((total, s) => total + s.deltaUsd, 0);
  const candDelta = candidate.sensitivities.reduce((total, s) => total + s.deltaUsd, 0);
  const basePasses = baseHeldOut.successes;
  const candPasses = candHeldOut.successes;
  const sensitivityResult = applyDecisionRule({
    baseline: withCostPerPass(
      baseOutcome,
      dollarsPerHeldOutPass(baseline.cost.countedSpendUsd + baseDelta, basePasses),
    ),
    candidate: withCostPerPass(
      candOutcome,
      dollarsPerHeldOutPass(candidate.cost.countedSpendUsd + candDelta, candPasses),
    ),
    baselineHeldOutPassStdErr: baselineStdErr,
  });

  const threshold = baseOutcome.heldOutPassRate - baselineStdErr;
  const baseCost = baseline.cost.dollarsPerHeldOutPass;
  const candCost = candidate.cost.dollarsPerHeldOutPass;

  return {
    configId: candidate.configId,
    result,
    baselineStdErr,
    baselineStdErrDegenerate: baseHeldOut.standardErrorDegenerate,
    baselineHeldOutPassRate: baseOutcome.heldOutPassRate,
    conditionOneArithmetic:
      `candidate ${fmt(candOutcome.heldOutPassRate)} >= baseline ${fmt(baseOutcome.heldOutPassRate)} ` +
      `- SE ${fmt(baselineStdErr)} = ${fmt(threshold)}`,
    conditionTwoArithmetic:
      `candidate ${money(candCost)} <= 0.70 × baseline ${money(baseCost)}` +
      (baseCost === null ? "" : ` = ${money(baseCost * 0.7)}`),
    conditionThreeArithmetic:
      `candidate false-finish ${fmt(candOutcome.falseFinishRate)} <= baseline ` +
      `${fmt(baseOutcome.falseFinishRate)}`,
    costConventionInvariant:
      allSpendResult.costReductionAtLeast30Percent === result.costReductionAtLeast30Percent,
    assumedPriceInvariant:
      baseDelta === 0 && candDelta === 0
        ? null
        : sensitivityResult.costReductionAtLeast30Percent === result.costReductionAtLeast30Percent,
    assumedPriceDeltaUsd: candDelta,
    heldOutDifference: compareProportions(
      { successes: candHeldOut.successes, n: candHeldOut.n },
      { successes: baseHeldOut.successes, n: baseHeldOut.n },
    ),
    falseFinishDifference:
      candidate.falseFinish === null || baseline.falseFinish === null
        ? null
        : compareProportions(
            { successes: candidate.falseFinish.successes, n: candidate.falseFinish.n },
            { successes: baseline.falseFinish.successes, n: baseline.falseFinish.n },
          ),
  };
}

/* -------------------------------------------------------------------------
 * Tiers
 * ---------------------------------------------------------------------- */

const TIER_ORDER: readonly (TicketTier | "unknown")[] = ["trivial", "medium", "hard", "unknown"];

function summariseTiers(configs: readonly ConfigSummary[]): readonly TierSummary[] {
  const all = configs.flatMap((c) => c.counted);
  const out: TierSummary[] = [];
  for (const tier of TIER_ORDER) {
    const rows = all.filter((c) => c.tier === tier);
    if (rows.length === 0) continue;
    const heldOutPasses = rows.filter((c) => c.heldOutPass).length;
    const visiblePasses = rows.filter((c) => c.visiblePassed).length;
    out.push({
      tier,
      attempts: rows.length,
      heldOutPasses,
      visiblePasses,
      gapPp: ((visiblePasses - heldOutPasses) / rows.length) * 100,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

export interface AggregateOptions {
  /** ISO-8601 instant stamped on the report. */
  readonly generatedAt: string;
}

export function aggregate(loaded: LoadedResults, options: AggregateOptions): Aggregation {
  const scoreByRunId = new Map(loaded.scores.map((s) => [s.runId, s]));
  const visibleByRunId = new Map(loaded.visible.map((v) => [v.runId, v]));

  const globalAlerts: Alert[] = [
    ...auditRecordIntegrity(loaded.runs, scoreByRunId, visibleByRunId),
    ...auditHeldConstants(loaded.runs),
    ...auditSeatUsage(loaded.runs),
  ];

  if (loaded.unrecognisedLines.length > 0) {
    globalAlerts.push({
      severity: "warning",
      kind: "unrecognised_records",
      title: "Some results lines matched no known record shape",
      detail:
        `${String(loaded.unrecognisedLines.length)} line(s) were read but not recognised as a run ` +
        "record, score record, ledger event or visible-result record. They are listed below and " +
        "contribute to nothing. They are surfaced rather than dropped because a record the " +
        "reporter cannot see is a run that silently left the denominator.",
      affected: loaded.unrecognisedLines.map(
        (l) => `${l.file}:${String(l.line)} [${l.keys.join(",")}]`,
      ),
    });
  }

  const byRepeatCount = new Map<number, LoadedRun[]>();
  for (const run of loaded.runs) {
    const bucket = byRepeatCount.get(run.heldConstants.repeatCount) ?? [];
    bucket.push(run);
    byRepeatCount.set(run.heldConstants.repeatCount, bucket);
  }

  const phases: PhaseReport[] = [];
  for (const repeatCount of [...byRepeatCount.keys()].sort((a, b) => a - b)) {
    const runs = byRepeatCount.get(repeatCount) ?? [];
    const phaseAlerts: Alert[] = [];

    const configIds = unique(runs.map((r) => r.configId));
    const configs = configIds.map((configId) =>
      summariseConfig(
        configId,
        runs.filter((r) => r.configId === configId),
        scoreByRunId,
        visibleByRunId,
        phaseAlerts,
      ),
    );

    const baseline = configs.find((c) => c.configId === BASELINE_CONFIG_ID) ?? null;
    const decisions: DecisionApplication[] = [];
    if (baseline !== null) {
      for (const candidate of configs) {
        if (candidate.configId === BASELINE_CONFIG_ID) continue;
        const application = applyRuleTo(baseline, candidate);
        if (application !== null) decisions.push(application);
      }
    }

    // Cache alerts, per config and provider.
    for (const config of configs) {
      for (const entry of config.providerCache) {
        if (entry.notCachedAtAll) {
          phaseAlerts.push({
            severity: "critical",
            kind: "cache_not_used",
            title: `No caching observed for ${entry.provider} in config ${config.configId}`,
            detail:
              entry.provider === "deepseek"
                ? "Every billed input token was a cache miss. DeepSeek's cache is automatic and " +
                  "best-effort with no guarantee, so a cold run is possible — but a whole " +
                  "configuration with zero cache reads means the 138x-cheaper cache-hit rate that " +
                  "is this configuration's entire economic case never applied."
                : "cache_read and cache_write are both zero. The prompt was not cached at all, " +
                  "almost certainly a prefix below the model's minimum cacheable length, which " +
                  "fails SILENTLY with no error returned and is a 10x price increase on that " +
                  "block (doc 04 section 3.4). The cost comparison in this report is invalid for " +
                  "this configuration until it is fixed.",
            affected: [`${config.configId}/${entry.provider}`],
          });
        } else if (entry.hitFraction !== null && entry.hitFraction < 0.2) {
          phaseAlerts.push({
            severity: "critical",
            kind: "cache_hit_rate_near_zero",
            title:
              `Near-zero cache-hit fraction for ${entry.provider} in config ${config.configId} ` +
              `(${(entry.hitFraction * 100).toFixed(1)}%)`,
            detail:
              "A silent cache failure invalidates the cost comparison entirely: the 0-to-85% " +
              "caching spread is ~$103/ticket, larger than every other optimisation combined " +
              "(doc 04 section 0.2). Diagnose before comparing any dollar figure in this report.",
            affected: [`${config.configId}/${entry.provider}`],
          });
        } else if (entry.hitFraction !== null && entry.hitFraction < 0.5) {
          phaseAlerts.push({
            severity: "warning",
            kind: "cache_hit_rate_low",
            title:
              `Low cache-hit fraction for ${entry.provider} in config ${config.configId} ` +
              `(${(entry.hitFraction * 100).toFixed(1)}%)`,
            detail:
              "Well below the 85% the cost model assumes. Run the doc 04 section 3.3 audit " +
              "checklist before treating this configuration's dollar figures as its steady state.",
            affected: [`${config.configId}/${entry.provider}`],
          });
        }
      }

      if (config.unscoredRunIds.length > 0) {
        phaseAlerts.push({
          severity: "critical",
          kind: "unscored_runs",
          title: `config ${config.configId} has ${String(config.unscoredRunIds.length)} run(s) with no score record`,
          detail:
            "These runs are excluded from every rate: their outcome is unknown and counting them " +
            "either way would be a guess. They spent " +
            `$${config.cost.unscoredSpendUsd.toFixed(2)}. ` +
            `${String(config.unscoredDeclaredDoneRunIds.length)} of them declared done, so each is ` +
            "a potential false finish that the exclusion removes from the numerator AND the " +
            "denominator — the direction that flatters the configuration. Bounds are printed with " +
            "the co-primary metrics.",
          affected: config.unscoredRunIds,
        });
      }
    }

    phases.push({
      phaseId: phaseIdFor(repeatCount),
      derivedFrom: "heldConstants.repeatCount (derived, not recorded)",
      repeatCount,
      runCount: runs.length,
      configs,
      baselineConfigId: BASELINE_CONFIG_ID,
      baselinePresent: baseline !== null && baseline.outcome !== null,
      decisions,
      ticketIds: unique(runs.map((r) => r.ticketId)),
      tiers: summariseTiers(configs),
      alerts: sortAlerts(phaseAlerts),
    });
  }

  return {
    generatedAt: options.generatedAt,
    files: loaded.files,
    runCount: loaded.runs.length,
    scoreCount: loaded.scores.length,
    visibleCount: loaded.visible.length,
    ledgerEventCount: loaded.ledgerEvents.length,
    unrecognisedLineCount: loaded.unrecognisedLines.length,
    totalLines: loaded.totalLines,
    phases,
    alerts: sortAlerts(globalAlerts),
    visibleRecordsPresent: loaded.visible.length > 0,
  };
}
