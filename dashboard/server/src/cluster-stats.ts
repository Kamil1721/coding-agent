export type BinaryObservation = 0 | 1;

export interface BinaryObservationCluster {
  readonly id: string;
  readonly observations: readonly BinaryObservation[];
  readonly successes?: never;
  readonly n?: never;
}

export interface BinaryCountCluster {
  readonly id: string;
  readonly successes: number;
  readonly n: number;
  readonly observations?: never;
}

export type BinaryCluster = BinaryObservationCluster | BinaryCountCluster;

export interface PlanningEstimate {
  readonly basis: "mean-cluster-size" | "size-weighted-cluster-size";
  readonly effectiveClusterSize: number;
  readonly designEffect: number;
  readonly effectiveSampleSize: number;
  readonly recommendation: "reproducibility-only" | "recommended";
}

export interface ClusterStatsResult {
  readonly clusterCount: number;
  readonly observationCount: number;
  readonly successes: number;
  readonly mean: number;
  readonly meanClusterSize: number;
  readonly sumSquaredClusterSizes: number;
  /** sum(n_i^2) / N, used by the recommended unequal-size design effect. */
  readonly sizeWeightedM: number;
  readonly m0: number;
  readonly betweenMeanSquare: number;
  readonly withinMeanSquare: number;
  /** The ANOVA estimate, retained even when sampling noise makes it negative. */
  readonly rawIcc: number;
  /** max(0, rawIcc), used only for planning calculations. */
  readonly rhoForPlanning: number;
  readonly planning: {
    /** Equal-mean approximation retained to reproduce historical reports. */
    readonly meanSizeApproximation: PlanningEstimate;
    /** Unequal-size design effect; the primary estimate for clustered data. */
    readonly unequalSizeRecommended: PlanningEstimate;
  };
}

export interface DesignEffectAtClusterSize {
  readonly clusterSize: number;
  readonly designEffect: number;
}

export class ClusterStatsValidationError extends Error {
  override readonly name = "ClusterStatsValidationError";
}

interface NormalizedCluster {
  readonly id: string;
  readonly successes: number;
  readonly n: number;
}

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new ClusterStatsValidationError(`${label} must be a safe integer; got ${String(value)}`);
  }
}

function normalizeCluster(cluster: BinaryCluster, index: number): NormalizedCluster {
  if (typeof cluster !== "object" || cluster === null) {
    throw new ClusterStatsValidationError(`cluster at index ${String(index)} must be an object`);
  }
  if (typeof cluster.id !== "string" || cluster.id.trim() === "") {
    throw new ClusterStatsValidationError(`cluster at index ${String(index)} must have a non-empty id`);
  }

  const hasObservations = hasOwn(cluster, "observations");
  const hasCounts = hasOwn(cluster, "successes") || hasOwn(cluster, "n");
  if (hasObservations === hasCounts) {
    throw new ClusterStatsValidationError(
      `cluster ${cluster.id} must provide exactly one representation: observations or successes with n`,
    );
  }

  if (hasObservations) {
    const observations = cluster.observations;
    if (!Array.isArray(observations)) {
      throw new ClusterStatsValidationError(`cluster ${cluster.id} observations must be an array`);
    }
    if (observations.length < 2) {
      throw new ClusterStatsValidationError(
        `cluster ${cluster.id} has ${String(observations.length)} observation(s); each cluster must have n >= 2`,
      );
    }
    let successes = 0;
    for (const [observationIndex, observation] of observations.entries()) {
      if (observation !== 0 && observation !== 1) {
        throw new ClusterStatsValidationError(
          `cluster ${cluster.id} observation ${String(observationIndex)} must be binary (0 or 1)`,
        );
      }
      successes += observation;
    }
    return { id: cluster.id, successes, n: observations.length };
  }

  const { successes, n } = cluster;
  if (typeof n !== "number" || typeof successes !== "number") {
    throw new ClusterStatsValidationError(`cluster ${cluster.id} must provide numeric successes and n`);
  }
  requireSafeInteger(n, `cluster ${cluster.id} n`);
  requireSafeInteger(successes, `cluster ${cluster.id} successes`);
  if (n < 2) {
    throw new ClusterStatsValidationError(`cluster ${cluster.id} has n=${String(n)}; each cluster must have n >= 2`);
  }
  if (successes < 0 || successes > n) {
    throw new ClusterStatsValidationError(
      `cluster ${cluster.id} successes must be between 0 and n; got ${String(successes)}/${String(n)}`,
    );
  }
  return { id: cluster.id, successes, n };
}

function planningEstimate(
  basis: PlanningEstimate["basis"],
  effectiveClusterSize: number,
  observationCount: number,
  rhoForPlanning: number,
): PlanningEstimate {
  const designEffect = planningDesignEffect(rhoForPlanning, effectiveClusterSize);
  return {
    basis,
    effectiveClusterSize,
    designEffect,
    effectiveSampleSize: observationCount / designEffect,
    recommendation: basis === "size-weighted-cluster-size" ? "recommended" : "reproducibility-only",
  };
}

/**
 * Planning design effect for a chosen cluster size.
 *
 * Negative ANOVA ICC estimates are reported by {@link analyzeClusteredBinary},
 * but are clamped to zero here so planning never claims more independent
 * information than the observed row count.
 */
export function planningDesignEffect(rawIcc: number, clusterSize: number): number {
  if (!Number.isFinite(rawIcc)) {
    throw new ClusterStatsValidationError(`raw ICC must be finite; got ${String(rawIcc)}`);
  }
  if (!Number.isFinite(clusterSize) || clusterSize < 1) {
    throw new ClusterStatsValidationError(`cluster size must be finite and at least 1; got ${String(clusterSize)}`);
  }
  return 1 + (clusterSize - 1) * Math.max(0, rawIcc);
}

export function designEffectByClusterSize(
  rawIcc: number,
  clusterSizes: readonly number[],
): readonly DesignEffectAtClusterSize[] {
  return clusterSizes.map((clusterSize) => ({
    clusterSize,
    designEffect: planningDesignEffect(rawIcc, clusterSize),
  }));
}

/**
 * One-way random-effects ANOVA ICC for clustered binary observations.
 *
 * Unequal cluster sizes use m0 = (N - sum(n_i^2) / N) / (K - 1) in the ICC
 * denominator. Planning exposes both the historical mean-size approximation and
 * the recommended unequal-size design effect based on sum(n_i^2) / N.
 */
export function analyzeClusteredBinary(clusters: readonly BinaryCluster[]): ClusterStatsResult {
  if (!Array.isArray(clusters)) {
    throw new ClusterStatsValidationError("clusters must be an array");
  }
  if (clusters.length < 8) {
    throw new ClusterStatsValidationError(
      `cluster count must be at least 8 for this estimator; got ${String(clusters.length)}`,
    );
  }

  const normalized = clusters.map(normalizeCluster);
  const ids = new Set<string>();
  for (const cluster of normalized) {
    if (ids.has(cluster.id)) {
      throw new ClusterStatsValidationError(`cluster id must be unique; duplicate ${cluster.id}`);
    }
    ids.add(cluster.id);
  }

  const clusterCount = normalized.length;
  const observationCount = normalized.reduce((sum, cluster) => sum + cluster.n, 0);
  const successes = normalized.reduce((sum, cluster) => sum + cluster.successes, 0);
  const mean = successes / observationCount;
  const meanClusterSize = observationCount / clusterCount;
  const sumSquaredClusterSizes = normalized.reduce((sum, cluster) => sum + cluster.n ** 2, 0);
  const sizeWeightedM = sumSquaredClusterSizes / observationCount;
  const m0 = (observationCount - sizeWeightedM) / (clusterCount - 1);

  const betweenSumSquares = normalized.reduce((sum, cluster) => {
    const clusterMean = cluster.successes / cluster.n;
    return sum + cluster.n * (clusterMean - mean) ** 2;
  }, 0);
  const withinSumSquares = normalized.reduce((sum, cluster) => {
    const clusterMean = cluster.successes / cluster.n;
    return sum + cluster.n * clusterMean * (1 - clusterMean);
  }, 0);
  const betweenMeanSquare = betweenSumSquares / (clusterCount - 1);
  const withinMeanSquare = withinSumSquares / (observationCount - clusterCount);
  const iccDenominator = betweenMeanSquare + (m0 - 1) * withinMeanSquare;
  if (iccDenominator === 0) {
    throw new ClusterStatsValidationError("raw ICC is undefined because all observations have zero variance");
  }
  const rawIcc = (betweenMeanSquare - withinMeanSquare) / iccDenominator;
  const rhoForPlanning = Math.max(0, rawIcc);

  return {
    clusterCount,
    observationCount,
    successes,
    mean,
    meanClusterSize,
    sumSquaredClusterSizes,
    sizeWeightedM,
    m0,
    betweenMeanSquare,
    withinMeanSquare,
    rawIcc,
    rhoForPlanning,
    planning: {
      meanSizeApproximation: planningEstimate(
        "mean-cluster-size",
        meanClusterSize,
        observationCount,
        rhoForPlanning,
      ),
      unequalSizeRecommended: planningEstimate(
        "size-weighted-cluster-size",
        sizeWeightedM,
        observationCount,
        rhoForPlanning,
      ),
    },
  };
}
