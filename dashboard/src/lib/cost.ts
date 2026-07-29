import type { ModelOption, RunSummary, TokenCounts } from "./api-types";

/**
 * `costUsd: null` is AMBIGUOUS on the wire. It means both:
 *
 *   (a) "this run is on a subscription, so no dollar figure EXISTS", and
 *   (b) "this run is metered but the cost has not been computed yet".
 *
 * `RunDetail` carries no discriminator — the `tier` lives on `/api/models`.
 * So the two are told apart by joining on `modelId`, and the three outcomes
 * are rendered as three different things. A bare em dash is forbidden: on a
 * subscription run it reads as missing data when in fact no such number can
 * ever exist.
 */
export type CostDisplay =
  | {
      readonly kind: "included";
      readonly headline: string;
      readonly detail: string;
    }
  | {
      readonly kind: "amount";
      readonly headline: string;
      readonly detail: string;
      readonly usd: number;
    }
  | {
      readonly kind: "pending";
      readonly headline: string;
      readonly detail: string;
    }
  | {
      readonly kind: "unknown";
      readonly headline: string;
      readonly detail: string;
    };

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "n/a";
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function describeCost(
  costUsd: number | null,
  model: ModelOption | null,
): CostDisplay {
  if (model !== null && model.tier === "included") {
    // Guard the invariant rather than trusting it: if a backend ever attaches
    // a figure to a subscription run it is still not rendered as money.
    return {
      kind: "included",
      headline: "Included in your plan",
      detail:
        "Subscription quota is consumed, not billed. There is no dollar figure for this run — the token counts and the rate-limit window are the real numbers.",
    };
  }

  if (costUsd !== null && Number.isFinite(costUsd)) {
    return {
      kind: "amount",
      headline: formatUsd(costUsd),
      detail: "Metered API usage, billed per token.",
      usd: costUsd,
    };
  }

  if (model !== null && model.tier === "metered") {
    return {
      kind: "pending",
      headline: "Not yet computed",
      detail:
        "This model is billed per token; the cost is reported once the run's usage is priced.",
    };
  }

  return {
    kind: "unknown",
    headline: "No cost recorded",
    detail:
      "This run's model is not in the current model list, so its billing tier cannot be established. Token counts below are what was actually recorded.",
  };
}

export function totalTokens(tokens: TokenCounts): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWriteTokens
  );
}

/**
 * Cache-read share of the input side. This is the number that decides whether a
 * long run is cheap or ruinous, and on a subscription plan it is the closest
 * thing to a cost signal that honestly exists.
 */
export function cacheHitFraction(tokens: TokenCounts): number | null {
  const inputSide =
    tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  if (inputSide === 0) return null;
  return tokens.cacheReadTokens / inputSide;
}

export function findModel(
  models: readonly ModelOption[] | undefined,
  modelId: string,
): ModelOption | null {
  if (models === undefined) return null;
  return models.find((model) => model.id === modelId) ?? null;
}

/** True when we can state positively that this run cannot have a cost. */
export function isSubscriptionRun(
  run: Pick<RunSummary, "modelId">,
  models: readonly ModelOption[] | undefined,
): boolean {
  return findModel(models, run.modelId)?.tier === "included";
}
