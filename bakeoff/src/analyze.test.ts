/**
 * analyze.test.ts — unit tests for the statistics.
 *
 * Reference values are checked against published figures where they exist
 * (Wilson 1/10 and 0/6 are standard textbook examples) and against closed forms
 * otherwise. The degenerate cases get more attention than the ordinary ones,
 * because they are the ones that appear at n=6 and decide condition (i).
 *
 * Run with `npm test` (builds, then `node --test dist`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BakeoffError } from "./contracts.js";
import {
  CONFIDENCE_95,
  compareProportions,
  estimateProportion,
  mean,
  median,
  standardErrorOfProportion,
  wilsonInterval,
  zForConfidence,
} from "./analyze.js";

const CLOSE = 1e-9;

function assertClose(actual: number, expected: number, tolerance = CLOSE): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${String(actual)} to be within ${String(tolerance)} of ${String(expected)}`,
  );
}

/* -------------------------------------------------------------------------
 * Critical values
 * ---------------------------------------------------------------------- */

test("zForConfidence returns the tabulated two-sided critical values", () => {
  assertClose(zForConfidence(0.95), 1.959963984540054);
  assertClose(zForConfidence(0.9), 1.6448536269514722);
  assertClose(zForConfidence(0.99), 2.5758293035489004);
  assert.equal(CONFIDENCE_95, 0.95);
});

test("zForConfidence throws rather than interpolating an untabulated level", () => {
  assert.throws(
    () => zForConfidence(0.975),
    (error: unknown) =>
      error instanceof BakeoffError && error.code === "invalid_usage_shape",
  );
});

/* -------------------------------------------------------------------------
 * Standard error
 * ---------------------------------------------------------------------- */

test("standardErrorOfProportion matches sqrt(p(1-p)/n)", () => {
  assertClose(standardErrorOfProportion(3, 6), Math.sqrt(0.25 / 6));
  assertClose(standardErrorOfProportion(4, 6), Math.sqrt(((4 / 6) * (2 / 6)) / 6));
  assertClose(standardErrorOfProportion(1, 10), Math.sqrt((0.1 * 0.9) / 10));
});

test("standardErrorOfProportion is exactly 0 at 0/n and n/n — the degeneracy that drives condition (i)", () => {
  assert.equal(standardErrorOfProportion(0, 6), 0);
  assert.equal(standardErrorOfProportion(6, 6), 0);
  assert.equal(estimateProportion(6, 6).standardErrorDegenerate, true);
  assert.equal(estimateProportion(0, 6).standardErrorDegenerate, true);
  assert.equal(estimateProportion(3, 6).standardErrorDegenerate, false);

  // The consequence the report must state: with a perfect baseline, condition
  // (i) `candidate >= baseline - SE` becomes `candidate >= 1`.
  const baseline = estimateProportion(6, 6);
  assert.equal(baseline.rate - baseline.standardError, 1);
  // With a zero baseline it becomes `candidate >= 0`, which everything passes.
  const floor = estimateProportion(0, 6);
  assert.equal(floor.rate - floor.standardError, 0);
});

/* -------------------------------------------------------------------------
 * Wilson
 * ---------------------------------------------------------------------- */

test("wilsonInterval reproduces the published 1/10 example", () => {
  // Textbook value at z = 1.96 is [0.018, 0.404]; these are the same figures at
  // the full-precision critical value 1.959963984540054.
  const ci = wilsonInterval(1, 10);
  assertClose(ci.low, 0.0178762, 1e-6);
  assertClose(ci.high, 0.4041500, 1e-6);
  assert.equal(ci.low.toFixed(3), "0.018");
  assert.equal(ci.high.toFixed(3), "0.404");
});

test("wilsonInterval has non-zero width at 0/6 and 6/6, unlike Wald", () => {
  const zero = wilsonInterval(0, 6);
  assert.equal(zero.low, 0);
  assertClose(zero.high, 0.3903343, 1e-6);

  const all = wilsonInterval(6, 6);
  assert.equal(all.high, 1);
  // Symmetric with the 0/6 case by construction.
  assertClose(all.low, 1 - 0.3903343, 1e-6);
});

test("wilsonInterval is symmetric about 0.5 and stays inside [0, 1]", () => {
  const ci = wilsonInterval(3, 6);
  assertClose((ci.low + ci.high) / 2, 0.5, 1e-12);
  for (const successes of [0, 1, 2, 3, 4, 5, 6]) {
    const bounds = wilsonInterval(successes, 6);
    assert.ok(bounds.low >= 0 && bounds.high <= 1);
    assert.ok(bounds.low <= successes / 6 && successes / 6 <= bounds.high);
  }
});

test("wilsonInterval widens as confidence rises", () => {
  const ninety = wilsonInterval(4, 6, 0.9);
  const ninetyNine = wilsonInterval(4, 6, 0.99);
  assert.ok(ninetyNine.low < ninety.low);
  assert.ok(ninetyNine.high > ninety.high);
});

/* -------------------------------------------------------------------------
 * Input validation
 * ---------------------------------------------------------------------- */

test("proportion helpers refuse impossible inputs instead of returning a plausible number", () => {
  const bad: readonly (readonly [number, number])[] = [
    [0, 0], // empty denominator
    [1, 0],
    [7, 6], // more successes than trials
    [-1, 6],
    [1.5, 6],
    [1, 6.5],
  ];
  for (const [successes, n] of bad) {
    assert.throws(
      () => estimateProportion(successes, n),
      (error: unknown) => error instanceof BakeoffError && error.code === "invalid_usage_shape",
      `estimateProportion(${String(successes)}, ${String(n)}) should throw`,
    );
  }
});

/* -------------------------------------------------------------------------
 * The noise check
 * ---------------------------------------------------------------------- */

test("compareProportions reports zero difference and inside-noise for identical arms", () => {
  const d = compareProportions({ successes: 4, n: 6 }, { successes: 4, n: 6 });
  assert.equal(d.difference, 0);
  assert.equal(d.insideNoise, true);
  assert.ok(d.interval.low < 0 && d.interval.high > 0);
});

test("compareProportions calls a one-ticket difference at n=6 noise", () => {
  // 4/6 against 3/6 is the shape a screen phase actually produces.
  const d = compareProportions({ successes: 4, n: 6 }, { successes: 3, n: 6 });
  assertClose(d.difference, 1 / 6, 1e-12);
  assert.equal(d.insideNoise, true, "a single ticket of separation at n=6 must not read as a lead");
});

test("compareProportions separates 6/6 from 0/6", () => {
  const d = compareProportions({ successes: 6, n: 6 }, { successes: 0, n: 6 });
  assert.equal(d.difference, 1);
  assert.equal(d.insideNoise, false);
  assert.ok(d.interval.low > 0);
});

test("compareProportions leaves the Wald z undefined where the Wald SE collapses", () => {
  const d = compareProportions({ successes: 6, n: 6 }, { successes: 6, n: 6 });
  assert.equal(d.standardError, 0);
  assert.equal(d.z, null);
  assert.equal(d.insideNoise, true);
});

test("compareProportions is antisymmetric in its arguments", () => {
  const forward = compareProportions({ successes: 5, n: 6 }, { successes: 2, n: 6 });
  const backward = compareProportions({ successes: 2, n: 6 }, { successes: 5, n: 6 });
  assertClose(forward.difference, -backward.difference, 1e-12);
  assertClose(forward.interval.low, -backward.interval.high, 1e-12);
  assertClose(forward.interval.high, -backward.interval.low, 1e-12);
  assert.equal(forward.insideNoise, backward.insideNoise);
});

test("compareProportions intervals stay inside [-1, 1]", () => {
  for (let a = 0; a <= 6; a += 1) {
    for (let b = 0; b <= 6; b += 1) {
      const d = compareProportions({ successes: a, n: 6 }, { successes: b, n: 6 });
      assert.ok(d.interval.low >= -1 && d.interval.high <= 1);
      assert.ok(d.interval.low <= d.difference && d.difference <= d.interval.high);
    }
  }
});

/* -------------------------------------------------------------------------
 * Central tendency
 * ---------------------------------------------------------------------- */

test("mean and median return null on an empty sample rather than 0", () => {
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
});

test("median averages the two central values on an even sample", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test("mean and median do not mutate their input", () => {
  const values = [3, 1, 2];
  median(values);
  assert.deepEqual(values, [3, 1, 2]);
});

test("mean and median reject non-finite values instead of propagating NaN", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => mean([1, bad]),
      (error: unknown) => error instanceof BakeoffError,
    );
    assert.throws(
      () => median([1, bad]),
      (error: unknown) => error instanceof BakeoffError,
    );
  }
});
