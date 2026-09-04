import { strict as assert } from "node:assert";
import test from "node:test";
import {
  ClusterStatsValidationError,
  analyzeClusteredBinary,
  designEffectByClusterSize,
  planningDesignEffect,
} from "./cluster-stats.js";
import type { BinaryCluster, BinaryCountCluster, BinaryObservationCluster } from "./cluster-stats.js";

const GATING_COUNTS: readonly BinaryCountCluster[] = [
  { id: "01", n: 9, successes: 9 },
  { id: "02", n: 13, successes: 0 },
  { id: "03", n: 23, successes: 16 },
  { id: "04", n: 23, successes: 21 },
  { id: "05", n: 23, successes: 18 },
  { id: "06", n: 22, successes: 17 },
  { id: "07", n: 22, successes: 18 },
  { id: "08", n: 7, successes: 7 },
  { id: "09", n: 6, successes: 6 },
  { id: "10", n: 8, successes: 8 },
  { id: "11", n: 19, successes: 15 },
  { id: "12", n: 12, successes: 11 },
  { id: "13", n: 16, successes: 16 },
  { id: "14", n: 16, successes: 16 },
  { id: "15", n: 16, successes: 16 },
  { id: "16", n: 13, successes: 0 },
];

const QUALITY_COUNTS: readonly BinaryCountCluster[] = [
  { id: "01", n: 4, successes: 3 },
  { id: "02", n: 3, successes: 0 },
  { id: "03", n: 2, successes: 2 },
  { id: "04", n: 2, successes: 2 },
  { id: "05", n: 2, successes: 2 },
  { id: "06", n: 3, successes: 3 },
  { id: "07", n: 3, successes: 3 },
  { id: "08", n: 3, successes: 3 },
  { id: "09", n: 2, successes: 2 },
  { id: "10", n: 4, successes: 4 },
  { id: "11", n: 4, successes: 4 },
  { id: "12", n: 5, successes: 5 },
  { id: "13", n: 3, successes: 3 },
  { id: "14", n: 3, successes: 3 },
  { id: "15", n: 3, successes: 3 },
  { id: "16", n: 3, successes: 0 },
];

function closeTo(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${String(actual)} to be within ${String(tolerance)} of ${String(expected)}`,
  );
}

function observationsOf(cluster: BinaryCountCluster): BinaryObservationCluster {
  return {
    id: cluster.id,
    observations: [
      ...Array.from({ length: cluster.successes }, () => 1 as const),
      ...Array.from({ length: cluster.n - cluster.successes }, () => 0 as const),
    ],
  };
}

test("the archived gating fixture reproduces the unequal-cluster ANOVA ICC", () => {
  const result = analyzeClusteredBinary(GATING_COUNTS);

  assert.equal(result.observationCount, 248);
  assert.equal(result.clusterCount, 16);
  assert.equal(result.successes, 194);
  closeTo(result.mean, 0.782258064516129);
  closeTo(result.meanClusterSize, 15.5);
  assert.equal(result.sumSquaredClusterSizes, 4396);
  closeTo(result.sizeWeightedM, 17.725806451612904);
  closeTo(result.m0, 15.351612903225806);
  closeTo(result.betweenMeanSquare, 1.3614876527883097);
  closeTo(result.withinMeanSquare, 0.09405008918985483);
  closeTo(result.rawIcc, 0.4674721124035525);
  closeTo(result.rhoForPlanning, result.rawIcc);

  const meanSize = result.planning.meanSizeApproximation;
  assert.equal(meanSize.recommendation, "reproducibility-only");
  closeTo(meanSize.designEffect, 7.778345629851511);
  closeTo(meanSize.effectiveSampleSize, 31.88338649393937);

  const unequalSize = result.planning.unequalSizeRecommended;
  assert.equal(unequalSize.recommendation, "recommended");
  closeTo(unequalSize.effectiveClusterSize, 17.725806451612904);
  closeTo(unequalSize.designEffect, 8.818848073588452);
  closeTo(unequalSize.effectiveSampleSize, 28.12158662112965);
});

test("observation arrays and successes-with-n produce the same estimate", () => {
  assert.deepEqual(
    analyzeClusteredBinary(GATING_COUNTS.map(observationsOf)),
    analyzeClusteredBinary(GATING_COUNTS),
  );
});

test("the QUALITY fixture remains separate and exposes both effective sample sizes", () => {
  const result = analyzeClusteredBinary(QUALITY_COUNTS);
  assert.equal(result.observationCount, 49);
  assert.equal(result.successes, 42);
  closeTo(result.rawIcc, 0.8253275109170305);
  closeTo(result.planning.meanSizeApproximation.effectiveSampleSize, 18.133117866882134);
  closeTo(result.planning.unequalSizeRecommended.effectiveSampleSize, 16.975794251134644);
});

test("DEFF by cluster size uses the full-precision ICC and rounds only at presentation", () => {
  const rawIcc = analyzeClusteredBinary(GATING_COUNTS).rawIcc;
  const table = designEffectByClusterSize(rawIcc, [2, 3, 6, 10, 16]);
  assert.deepEqual(
    table.map(({ clusterSize, designEffect }) => [clusterSize, designEffect.toFixed(2)]),
    [
      [2, "1.47"],
      [3, "1.93"],
      [6, "3.34"],
      [10, "5.21"],
      [16, "8.01"],
    ],
  );
});

test("identical cluster rates preserve a negative raw ICC but clamp planning at DEFF 1", () => {
  const identicalRates = Array.from({ length: 8 }, (_, index) => ({
    id: `same-${String(index)}`,
    n: 4,
    successes: 2,
  }));
  const result = analyzeClusteredBinary(identicalRates);

  assert.ok(result.rawIcc <= 0);
  closeTo(result.rawIcc, -1 / 3);
  assert.equal(result.rhoForPlanning, 0);
  assert.equal(result.planning.meanSizeApproximation.designEffect, 1);
  assert.equal(result.planning.unequalSizeRecommended.designEffect, 1);
  assert.equal(planningDesignEffect(result.rawIcc, 100), 1);
});

test("perfectly separated clusters produce ICC 1", () => {
  const separated = Array.from({ length: 8 }, (_, index) => ({
    id: `separated-${String(index)}`,
    n: 4,
    successes: index < 4 ? 0 : 4,
  }));
  closeTo(analyzeClusteredBinary(separated).rawIcc, 1);
});

test("unbalanced clusters make the recommended weighted design effect differ", () => {
  const unbalanced = [2, 2, 2, 2, 20, 20, 20, 20].map((n, index) => ({
    id: `unbalanced-${String(index)}`,
    n,
    successes: index % 2 === 0 ? n : 0,
  }));
  const result = analyzeClusteredBinary(unbalanced);
  const meanSize = result.planning.meanSizeApproximation;
  const unequalSize = result.planning.unequalSizeRecommended;

  assert.equal(meanSize.effectiveClusterSize, 11);
  closeTo(unequalSize.effectiveClusterSize, 18.363636363636363);
  assert.ok(unequalSize.designEffect > meanSize.designEffect);
  assert.ok(unequalSize.effectiveSampleSize < meanSize.effectiveSampleSize);
});

test("validation failures name the cluster-count and undersized-cluster contracts", () => {
  const tooFew = GATING_COUNTS.slice(0, 7);
  assert.throws(
    () => analyzeClusteredBinary(tooFew),
    (error: unknown) =>
      error instanceof ClusterStatsValidationError && /cluster count must be at least 8.*got 7/.test(error.message),
  );

  const tooSmall: readonly BinaryCountCluster[] = [
    { id: "small", n: 1, successes: 1 },
    ...GATING_COUNTS.slice(1, 8),
  ];
  assert.throws(
    () => analyzeClusteredBinary(tooSmall),
    (error: unknown) =>
      error instanceof ClusterStatsValidationError && /cluster small has n=1.*n >= 2/.test(error.message),
  );
});

test("observation input rejects non-binary runtime values with the cluster id", () => {
  const invalid = GATING_COUNTS.map(observationsOf) as unknown as BinaryCluster[];
  invalid[0] = { id: "bad-binary", observations: [0, 2] } as unknown as BinaryCluster;
  assert.throws(() => analyzeClusteredBinary(invalid), /cluster bad-binary observation 1 must be binary/);
});
