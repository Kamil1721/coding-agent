/**
 * analyze.ts — the statistics for the bake-off report.
 *
 * No statistics library. Four things are needed and all four are short enough
 * to read, which matters more here than generality: a reviewer must be able to
 * check by eye that the numbers deciding a $3,000 experiment are computed the
 * way the protocol says they are.
 *
 *   1. The standard error of a proportion (Wald). This is the quantity
 *      doc 03 section 7.6 condition (i) is written in terms of, and the
 *      quantity {@link DecisionRuleInput.baselineHeldOutPassStdErr} in
 *      contracts.ts documents. It is fed to the decision rule UNCHANGED.
 *
 *   2. The Wilson score interval. The Wald interval is indefensible at the
 *      sample sizes this bake-off produces — six tickets per configuration in
 *      the screen phase — because it has zero width at 0/6 and 6/6 and
 *      systematically undercovers everywhere else. Wilson is reported as the
 *      honesty number and is NEVER fed to the decision rule: the rule was
 *      committed to before results were seen and swapping its inputs after the
 *      fact is exactly the reinterpretation the protocol forbids.
 *
 *   3. Newcombe's hybrid score interval for the DIFFERENCE of two independent
 *      proportions (Newcombe 1998, method 10), built from the two Wilson
 *      intervals. This is the noise check: a difference whose interval
 *      contains zero is not distinguishable from chance at this sample size.
 *
 *   4. Mean and median, which exist here rather than inline so that
 *      `medianWallClockMs` in a report can be checked against one definition.
 *
 * EVERY FUNCTION THROWS ON AN IMPOSSIBLE INPUT rather than returning a
 * plausible number. A silently wrong denominator is the single most damaging
 * defect a results aggregator can have.
 */

import { BakeoffError } from "./contracts.js";

/* -------------------------------------------------------------------------
 * Critical values
 * ---------------------------------------------------------------------- */

/** The confidence level used throughout the report unless stated otherwise. */
export const CONFIDENCE_95 = 0.95;

/**
 * Two-sided normal critical values.
 *
 * A table rather than an inverse-normal implementation: three levels are all
 * this harness uses, and a table cannot be wrong in a way that is hard to see.
 */
const Z_BY_CONFIDENCE: ReadonlyMap<number, number> = new Map<number, number>([
  [0.9, 1.6448536269514722],
  [0.95, 1.959963984540054],
  [0.99, 2.5758293035489004],
]);

/** Two-sided normal critical value for a supported confidence level. */
export function zForConfidence(confidence: number): number {
  const z = Z_BY_CONFIDENCE.get(confidence);
  if (z === undefined) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `no critical value tabulated for confidence ${String(confidence)}`,
      `Use one of ${[...Z_BY_CONFIDENCE.keys()].join(", ")}, or add the critical value to ` +
        "Z_BY_CONFIDENCE in src/analyze.ts. Do not interpolate one.",
    );
  }
  return z;
}

/* -------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------- */

function assertCounts(successes: number, n: number, where: string): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${where}: n must be a positive integer, got ${String(n)}`,
      "A configuration with no counted attempts has no rate. Report it as 'no data' rather than " +
        "computing a proportion over an empty denominator.",
    );
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${where}: successes must be an integer in [0, ${String(n)}], got ${String(successes)}`,
      "Fix the aggregation. A success count outside the denominator means runs were counted twice " +
        "or a denominator excluded a run its numerator included.",
    );
  }
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/* -------------------------------------------------------------------------
 * Proportions
 * ---------------------------------------------------------------------- */

/** A closed interval. Both ends are inclusive. */
export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * Standard error of a proportion, Wald form: `sqrt(p(1-p)/n)`.
 *
 * >>> THIS IS EXACTLY ZERO WHEN p IS 0 OR 1, AND THAT IS NOT A BUG — it is the
 * >>> Wald estimator behaving as defined on a sample that contains no
 * >>> variation. It matters because doc 03 section 7.6 condition (i) is
 * >>> `candidate >= baseline - SE(baseline)`: at a baseline of 6/6 the
 * >>> condition becomes `candidate >= 1.0` and no imperfect challenger can pass
 * >>> it; at a baseline of 0/6 it becomes `candidate >= 0` and every challenger
 * >>> passes it trivially. The report must say which way it cut.
 */
export function standardErrorOfProportion(successes: number, n: number): number {
  assertCounts(successes, n, "standardErrorOfProportion");
  const p = successes / n;
  return Math.sqrt((p * (1 - p)) / n);
}

/**
 * Wilson score interval.
 *
 * Preferred over Wald at these sample sizes: it has non-zero width at 0/n and
 * n/n, stays inside [0, 1] by construction, and its coverage does not collapse
 * for small n. Reported, never fed to the decision rule.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  confidence: number = CONFIDENCE_95,
): Interval {
  assertCounts(successes, n, "wilsonInterval");
  const z = zForConfidence(confidence);
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: clamp(centre - margin, 0, 1), high: clamp(centre + margin, 0, 1) };
}

/** A proportion with everything the report is required to print beside it. */
export interface ProportionEstimate {
  readonly successes: number;
  /** Denominator. Printed everywhere the rate is printed. */
  readonly n: number;
  readonly rate: number;
  /** Wald standard error. The quantity the decision rule consumes. */
  readonly standardError: number;
  /** Wilson score interval at {@link ProportionEstimate.confidence}. */
  readonly interval: Interval;
  readonly confidence: number;
  /**
   * True when the Wald standard error is exactly 0 because the observed rate is
   * 0 or 1. See the warning on {@link standardErrorOfProportion}.
   */
  readonly standardErrorDegenerate: boolean;
}

export function estimateProportion(
  successes: number,
  n: number,
  confidence: number = CONFIDENCE_95,
): ProportionEstimate {
  assertCounts(successes, n, "estimateProportion");
  const rate = successes / n;
  const standardError = standardErrorOfProportion(successes, n);
  return {
    successes,
    n,
    rate,
    standardError,
    interval: wilsonInterval(successes, n, confidence),
    confidence,
    standardErrorDegenerate: standardError === 0,
  };
}

/* -------------------------------------------------------------------------
 * Differences — the noise check
 * ---------------------------------------------------------------------- */

/** Counts for one arm of a comparison. */
export interface ProportionCounts {
  readonly successes: number;
  readonly n: number;
}

/**
 * A difference of two independent proportions, with the noise verdict.
 *
 * `insideNoise` is decided by the Newcombe interval containing zero, not by the
 * Wald z: at 0/6 and 6/6 the Wald standard error is zero and the z is infinite,
 * which would declare a two-run difference "significant". The interval does not
 * have that failure mode.
 */
export interface DifferenceEstimate {
  /** `a.rate - b.rate`. Positive means arm A is higher. */
  readonly difference: number;
  /** Newcombe hybrid score interval on the difference. */
  readonly interval: Interval;
  readonly confidence: number;
  /**
   * Wald standard error of the difference, `sqrt(se_a^2 + se_b^2)`. Reported
   * for completeness; not used to decide {@link DifferenceEstimate.insideNoise}.
   */
  readonly standardError: number;
  /** `difference / standardError`, or null when the standard error is 0. */
  readonly z: number | null;
  /** True when the interval contains 0: the difference is not distinguishable from chance. */
  readonly insideNoise: boolean;
}

/**
 * Newcombe (1998) method 10: the hybrid score interval for the difference of
 * two independent binomial proportions, built from the two Wilson intervals.
 *
 *   low  = d - sqrt((p1 - l1)^2 + (u2 - p2)^2)
 *   high = d + sqrt((u1 - p1)^2 + (p2 - l2)^2)
 */
export function compareProportions(
  a: ProportionCounts,
  b: ProportionCounts,
  confidence: number = CONFIDENCE_95,
): DifferenceEstimate {
  assertCounts(a.successes, a.n, "compareProportions(a)");
  assertCounts(b.successes, b.n, "compareProportions(b)");

  const p1 = a.successes / a.n;
  const p2 = b.successes / b.n;
  const w1 = wilsonInterval(a.successes, a.n, confidence);
  const w2 = wilsonInterval(b.successes, b.n, confidence);

  const difference = p1 - p2;
  const low = difference - Math.sqrt((p1 - w1.low) ** 2 + (w2.high - p2) ** 2);
  const high = difference + Math.sqrt((w1.high - p1) ** 2 + (p2 - w2.low) ** 2);
  const interval: Interval = { low: clamp(low, -1, 1), high: clamp(high, -1, 1) };

  const se1 = standardErrorOfProportion(a.successes, a.n);
  const se2 = standardErrorOfProportion(b.successes, b.n);
  const standardError = Math.sqrt(se1 * se1 + se2 * se2);

  return {
    difference,
    interval,
    confidence,
    standardError,
    z: standardError === 0 ? null : difference / standardError,
    insideNoise: interval.low <= 0 && interval.high >= 0,
  };
}

/* -------------------------------------------------------------------------
 * Central tendency
 * ---------------------------------------------------------------------- */

function assertFinite(values: readonly number[], where: string): void {
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value)) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `${where}: element ${String(index)} is not a finite number`,
        "A non-finite wall clock or cost means a run record was written with a missing field. " +
          "Fix the runner rather than filtering the value out here.",
      );
    }
  }
}

/** Arithmetic mean, or null for an empty sample. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  assertFinite(values, "mean");
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Median, or null for an empty sample. Even-length samples average the two
 * central order statistics.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  assertFinite(values, "median");
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
