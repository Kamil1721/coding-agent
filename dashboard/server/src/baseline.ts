import {
  compareProportions,
  estimateProportion,
  wilsonInterval,
} from "bakeoff/dist/analyze.js";
import type { Interval } from "bakeoff/dist/analyze.js";

export const BASELINE_SCHEMA_VERSION = 1;
export const Z_ALPHA = 1.959963984540054;
export const Z_POWER = 0.8416212335729143;
export const DEFAULT_DELTAS = Object.freeze([0.1, 0.15, 0.2, 0.3] as const);

export interface ObservedCounts {
  readonly successes: number;
  readonly gatedDenominator: number;
}

export interface BaselineCounts extends ObservedCounts {
  readonly totalRuns: number;
  readonly failures: number;
  readonly noVerdict: number;
}

export interface RequiredRunsEstimate {
  readonly delta: number;
  readonly baseRate: number;
  readonly targetRate: number;
  readonly perArm: number;
  readonly perArmRange: {
    readonly low: number;
    readonly high: number;
  };
  readonly baseRateWilson95: Interval;
}

export interface BaselineRate {
  readonly successes: number;
  readonly n: number;
  readonly rate: number;
  readonly standardError: number;
  readonly interval: Interval;
  readonly confidence: number;
  readonly standardErrorDegenerate: boolean;
  readonly label: string;
  readonly denominatorLabel: "all runs" | "gated runs";
}

export interface BaselineReport {
  readonly schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly sourceDatabase: string;
  readonly counts: BaselineCounts;
  readonly rates: {
    readonly heldOutPass: BaselineRate;
    readonly heldOutFail: BaselineRate;
    readonly gateReach: BaselineRate;
    readonly noVerdict: BaselineRate;
  };
  readonly requiredRuns: readonly RequiredRunsEstimate[];
}

export type WilsonFunction = typeof wilsonInterval;

/** The shared analyzer surface used by later comparison reports. */
export const baselineStatistics = Object.freeze({ wilsonInterval, estimateProportion, compareProportions });

const PINNED_WILSON_VALUES = Object.freeze([
  { successes: 5, n: 30, low: 0.0733654237184855, high: 0.3356435050641603 },
  { successes: 7, n: 16, low: 0.23098652405492354, high: 0.6682144360118811 },
  { successes: 0, n: 30, low: 0, high: 0.11351339317396876 },
  { successes: 30, n: 30, low: 0.8864866068260312, high: 0.9999999999999999 },
] as const);

function assertFiniteInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, got ${String(value)}`);
  }
}

function approximatelyEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-12;
}

/** Refuses a substituted or drifting Wilson implementation before any report is emitted. */
export function validatePinnedWilson(wilson: WilsonFunction = wilsonInterval): void {
  for (const expected of PINNED_WILSON_VALUES) {
    const actual = wilson(expected.successes, expected.n);
    if (!approximatelyEqual(actual.low, expected.low) || !approximatelyEqual(actual.high, expected.high)) {
      throw new Error(
        `wilsonInterval pinned-value mismatch for ${String(expected.successes)}/${String(expected.n)}: ` +
          `expected [${String(expected.low)}, ${String(expected.high)}], ` +
          `received [${String(actual.low)}, ${String(actual.high)}]`,
      );
    }
  }
}

function validateObservedCounts(observed: ObservedCounts): number {
  assertFiniteInteger(observed.successes, "successes");
  assertFiniteInteger(observed.gatedDenominator, "gated denominator");
  if (observed.gatedDenominator < 10) {
    throw new Error(
      `gated denominator must be at least 10 before estimating required runs; got ${String(observed.gatedDenominator)}`,
    );
  }
  if (observed.successes > observed.gatedDenominator) {
    throw new Error(
      `successes cannot exceed gated denominator (${String(observed.successes)} > ${String(observed.gatedDenominator)})`,
    );
  }
  return observed.successes / observed.gatedDenominator;
}

function unroundedRunsPerArm(baseRate: number, delta: number): number {
  const targetRate = baseRate + delta;
  const variance = baseRate * (1 - baseRate) + targetRate * (1 - targetRate);
  return ((Z_ALPHA + Z_POWER) ** 2 * variance) / delta ** 2;
}

/**
 * Approximate two-independent-proportion sample size at alpha=.05 and power=.80.
 * The returned Wilson range includes the concave variance function's interior maximum.
 */
export function requiredRuns(
  observed: ObservedCounts,
  delta: number,
  wilson: WilsonFunction = wilsonInterval,
): RequiredRunsEstimate {
  const baseRate = validateObservedCounts(observed);
  if (!Number.isFinite(delta) || delta <= 0 || baseRate + delta > 1) {
    throw new Error(
      `delta must be positive and keep the target rate at or below 1; got ${String(delta)} from base ${String(baseRate)}`,
    );
  }

  const baseRateWilson95 = wilson(observed.successes, observed.gatedDenominator);
  const feasibleLow = baseRateWilson95.low;
  const feasibleHigh = Math.min(baseRateWilson95.high, 1 - delta);
  if (feasibleLow > feasibleHigh) {
    throw new Error(`the Wilson interval contains no base rate that can improve by ${String(delta)}`);
  }

  const candidates = [feasibleLow, feasibleHigh];
  const interiorMaximum = (1 - delta) / 2;
  if (interiorMaximum >= feasibleLow && interiorMaximum <= feasibleHigh) {
    candidates.push(interiorMaximum);
  }
  const unroundedRange = candidates.map((candidate) => unroundedRunsPerArm(candidate, delta));

  return {
    delta,
    baseRate,
    targetRate: baseRate + delta,
    perArm: Math.ceil(unroundedRunsPerArm(baseRate, delta)),
    perArmRange: {
      low: Math.ceil(Math.min(...unroundedRange)),
      high: Math.ceil(Math.max(...unroundedRange)),
    },
    baseRateWilson95,
  };
}

function rate(
  label: string,
  denominatorLabel: BaselineRate["denominatorLabel"],
  successes: number,
  denominator: number,
  wilson: WilsonFunction,
): BaselineRate {
  const estimate = estimateProportion(successes, denominator);
  return {
    successes: estimate.successes,
    n: estimate.n,
    rate: estimate.rate,
    standardError: estimate.standardError,
    interval: wilson(successes, denominator),
    confidence: estimate.confidence,
    standardErrorDegenerate: estimate.standardErrorDegenerate,
    label,
    denominatorLabel,
  };
}

export function createBaselineReport(
  counts: BaselineCounts,
  generatedAt: string,
  sourceDatabase: string,
  wilson: WilsonFunction = wilsonInterval,
): BaselineReport {
  assertFiniteInteger(counts.totalRuns, "total runs");
  assertFiniteInteger(counts.gatedDenominator, "gated denominator");
  assertFiniteInteger(counts.successes, "passes");
  assertFiniteInteger(counts.failures, "failures");
  assertFiniteInteger(counts.noVerdict, "no verdict");
  if (counts.gatedDenominator === 0) {
    throw new Error("gated denominator is zero: no held_out_pass verdicts are available");
  }
  if (counts.successes + counts.failures !== counts.gatedDenominator) {
    throw new Error("passes plus failures must equal the gated denominator");
  }
  if (counts.gatedDenominator + counts.noVerdict !== counts.totalRuns) {
    throw new Error("gated runs plus no-verdict runs must equal total runs");
  }
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`generatedAt must be an ISO timestamp, got ${generatedAt}`);
  }

  validatePinnedWilson(wilson);
  const observed = { successes: counts.successes, gatedDenominator: counts.gatedDenominator };
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generatedAt,
    sourceDatabase,
    counts,
    rates: {
      heldOutPass: rate("Held-out pass", "gated runs", counts.successes, counts.gatedDenominator, wilson),
      heldOutFail: rate("Held-out fail", "gated runs", counts.failures, counts.gatedDenominator, wilson),
      gateReach: rate("Gate reach", "all runs", counts.gatedDenominator, counts.totalRuns, wilson),
      noVerdict: rate("No verdict", "all runs", counts.noVerdict, counts.totalRuns, wilson),
    },
    requiredRuns: DEFAULT_DELTAS.map((delta) => requiredRuns(observed, delta, wilson)),
  };
}

function decimal(value: number): string {
  return value.toFixed(4);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function renderBaselineJson(report: BaselineReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderBaselineMarkdown(report: BaselineReport): string {
  const rateRows = Object.values(report.rates).map(
    (item) =>
      `| ${item.label} | ${String(item.successes)}/${String(item.n)} ${item.denominatorLabel} | ` +
      `${percent(item.rate)} | [${decimal(item.interval.low)}, ${decimal(item.interval.high)}] |`,
  );
  const requiredRows = report.requiredRuns.map(
    (item) =>
      `| +${String(Math.round(item.delta * 100))}pp | ${percent(item.targetRate)} | ` +
      `${String(item.perArm)} | ${String(item.perArmRange.low)}-${String(item.perArmRange.high)} |`,
  );

  return [
    "# Pipeline baseline",
    "",
    `Generated: ${report.generatedAt}`,
    `Source: \`${report.sourceDatabase}\` (opened read-only)`,
    "",
    "## Observed outcomes",
    "",
    `There are ${String(report.counts.totalRuns)} runs: ${String(report.counts.gatedDenominator)} gated ` +
      `(${String(report.counts.successes)} pass, ${String(report.counts.failures)} fail) and ` +
      `${String(report.counts.noVerdict)} with no verdict.`,
    "",
    "| Rate | Count and denominator | Estimate | Wilson 95% interval |",
    "|---|---:|---:|---:|",
    ...rateRows,
    "",
    "## Runs required",
    "",
    "Two-sided alpha 0.05, power 0.80. Counts are per arm and are rounded up only after the full-precision calculation.",
    "",
    "| Improvement | Target | Point estimate | Wilson-derived range |",
    "|---|---:|---:|---:|",
    ...requiredRows,
    "",
  ].join("\n");
}
