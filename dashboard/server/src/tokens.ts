/**
 * tokens.ts — token arithmetic, and the one rule that governs it.
 *
 * TOKEN COUNTS ARE PER VENDOR AND ARE NEVER SUMMED ACROSS VENDORS. Tokenizers
 * differ; Anthropic's own docs state its 4.7+ tokenizer produces ~30% more
 * tokens for the same text than earlier Claude models, and nobody has measured
 * tokens-per-identical-source-text across vendors. contracts.ts encodes this by
 * shipping `sumCostUsd` and deliberately shipping no token-summing helper at
 * all (`TOKEN_ACCOUNTING_RULE`).
 *
 * This module therefore adds totals WITHIN one vendor only, and `TokenTotals`
 * carries the vendor it belongs to so the two cannot be mixed up by accident.
 *
 * A consequence the API contract inherits: `RunDetail.tokens` reports the
 * BUILDER's vendor only — the model the owner actually picked. On a Codex run
 * the spec and judge seats are Claude, and adding those counts to OpenAI's
 * would produce a number that means nothing. Spec and judge token counts are
 * reported in the run's log stream instead, with their vendor named.
 *
 * WITHIN ONE VENDOR, THE SPLIT IS PER MODEL, AND THAT IS NOT COSMETIC. Delegation
 * is the architecture: a haiku orchestrator hands the work to opus subagents, and
 * on a measured Phase 1 build three quarters of the spend ran on a model the run
 * never named. One scalar labelled with the run's `modelId` is not a coarser
 * truth — it is a false statement about which model did the work, and the two
 * models' quota windows are not interchangeable. {@link ModelTokens} rows carry
 * that split, and {@link addTokens} merges them by the SAME rule it uses for the
 * scalars, so the breakdown can never disagree with the total it breaks down.
 *
 * WHY THE ROWS ARE OPTIONAL. Only a provider that reports per-model figures can
 * fill them; the Codex driver has no equivalent field and states its totals
 * without a split. A required array would force every such driver to assert a
 * breakdown it never measured, so absence means "this vendor did not say", and
 * {@link unattributedTokens} makes that remainder visible rather than silently
 * assigning it to whichever model happens to be listed.
 */

import { BakeoffError } from "bakeoff/dist/contracts.js";
import type { Provider } from "bakeoff/dist/contracts.js";
import type { ApiTokens } from "./api-types.js";

/** One model's share of a vendor's token spend. */
export interface ModelTokens extends ApiTokens {
  /** The provider's own key for the model, verbatim. */
  readonly model: string;
}

export interface TokenTotals extends ApiTokens {
  readonly provider: Provider;
  /** Number of model calls (or turns) aggregated into this row. */
  readonly callCount: number;
  /** Per-model split of the four counts above. */
  readonly byModel?: readonly ModelTokens[];
}

/** The per-model rows, or none. Never a placeholder model. */
export function modelRows(totals: TokenTotals): readonly ModelTokens[] {
  return totals.byModel ?? [];
}

/** Tokens no model claimed: the totals minus what the rows account for. */
export function unattributedTokens(totals: TokenTotals): ApiTokens {
  const rows = modelRows(totals);
  const sum = (pick: (row: ModelTokens) => number): number => rows.reduce((n, r) => n + pick(r), 0);
  return {
    inputTokens: totals.inputTokens - sum((r) => r.inputTokens),
    outputTokens: totals.outputTokens - sum((r) => r.outputTokens),
    cacheReadTokens: totals.cacheReadTokens - sum((r) => r.cacheReadTokens),
    cacheWriteTokens: totals.cacheWriteTokens - sum((r) => r.cacheWriteTokens),
  };
}

export function zeroTokens(provider: Provider): TokenTotals {
  return {
    provider,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    callCount: 0,
    byModel: [],
  };
}

/**
 * Merge two sets of per-model rows, summing the models they share.
 *
 * ORDER IS FIRST-SEEN, not sorted: the orchestrator's own model is the first
 * thing a run reports, and a reader scanning the log for "what did this run
 * actually use" reads the rows in the order the run acquired them. A model on
 * the right-hand side only is APPENDED — dropping it is exactly the defect this
 * file was changed to fix, one level down.
 */
function mergeModelRows(
  a: readonly ModelTokens[],
  b: readonly ModelTokens[],
): readonly ModelTokens[] {
  const merged = new Map<string, ModelTokens>();
  for (const row of [...a, ...b]) {
    const seen = merged.get(row.model);
    merged.set(
      row.model,
      seen === undefined
        ? { ...row }
        : {
            model: row.model,
            inputTokens: seen.inputTokens + row.inputTokens,
            outputTokens: seen.outputTokens + row.outputTokens,
            cacheReadTokens: seen.cacheReadTokens + row.cacheReadTokens,
            cacheWriteTokens: seen.cacheWriteTokens + row.cacheWriteTokens,
          },
    );
  }
  return [...merged.values()];
}

/** Add two rows for the SAME vendor. Throws rather than mixing vendors. */
export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  if (a.provider !== b.provider) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `refusing to add ${b.provider} tokens to ${a.provider} tokens`,
      "Token counts are per vendor and are never summed across vendors: tokenizers differ, so the " +
        "sum is not a quantity. Keep one row per vendor and compare outcomes, not tokens.",
    );
  }
  return {
    provider: a.provider,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    callCount: a.callCount + b.callCount,
    // The rows are summed by the same rule as the scalars above, so a breakdown
    // that disagrees with its own total is not reachable through addition.
    byModel: mergeModelRows(modelRows(a), modelRows(b)),
  };
}

export function toApiTokens(totals: TokenTotals): ApiTokens {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
  };
}

function describeCounts(counts: ApiTokens): string {
  return (
    `${String(counts.inputTokens)} input, ${String(counts.cacheReadTokens)} cache read, ` +
    `${String(counts.cacheWriteTokens)} cache write, ${String(counts.outputTokens)} output`
  );
}

function anyTokens(counts: ApiTokens): boolean {
  return (
    counts.inputTokens !== 0 ||
    counts.outputTokens !== 0 ||
    counts.cacheReadTokens !== 0 ||
    counts.cacheWriteTokens !== 0
  );
}

/**
 * Human-readable, vendor-labelled, for a log line. Never a dollar figure.
 *
 * IT NAMES THE MODELS, because this line is where the defect was visible: a run
 * whose orchestrator was haiku and whose subagents were opus printed one figure,
 * and the reader had no way to know most of it was not haiku's. A run with no
 * per-model report prints exactly what it always did — an empty "by model" list
 * would read as "one model, unnamed", which is a claim nobody made.
 */
export function describeTokens(totals: TokenTotals): string {
  const head =
    `${totals.provider}: ${String(totals.inputTokens)} input, ` +
    `${String(totals.cacheReadTokens)} cache read, ${String(totals.cacheWriteTokens)} cache write, ` +
    `${String(totals.outputTokens)} output over ${String(totals.callCount)} call(s)`;

  const rows = modelRows(totals);
  if (rows.length === 0) return head;

  const parts = rows.map((row) => `${row.model}: ${describeCounts(row)}`);
  const remainder = unattributedTokens(totals);
  if (anyTokens(remainder)) parts.push(`unattributed: ${describeCounts(remainder)}`);
  return `${head} — by model: ${parts.join("; ")}`;
}
