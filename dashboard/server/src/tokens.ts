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
 * would produce a number that means nothing.
 *
 * THAT RULE WAS RIGHT AND THE PLACE IT LEFT THE OTHER SEATS WAS NOT. Until
 * {@link spendByVendor} below, "reported in the run's log stream instead" was
 * the whole of it: the spec seat's 416,111 output tokens, the audit seat's
 * 17,603 and the judge's 3,228 were printed by {@link describeTokens} and
 * accumulated NOWHERE, so a run that spent 525,471 output tokens reported the
 * builder's 88,529 as its figure — 16.8% of itself. A log line is not a record.
 * The per-vendor rule is kept exactly as it was: the seats are accumulated PER
 * VENDOR, one row each, and no cross-vendor scalar is produced anywhere in this
 * file. `ApiRunSpend` in api-types.ts is the shape, `RunStore.runSpend` is where
 * it is assembled from persisted rows.
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
import type {
  ApiMeteredSpend,
  ApiPricingBasis,
  ApiProvider,
  ApiRunSpend,
  ApiSeatSpend,
  ApiSpendSeat,
  ApiTokens,
  ApiVendorSpend,
} from "./api-types.js";

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
 *
 * SO ADDITION IS COMMUTATIVE IN THE SUMS AND NOT IN THE ROW ORDER, and both
 * halves are asserted in tokens.test.ts ("addition is order-independent IN THE
 * SUMS — row ORDER is not canonical"). The whole-object comparison a reader
 * reaches for first — `deepEqual(addTokens(a, b), addTokens(b, a))` — goes RED
 * the moment either side carries rows, which is a property of the design rather
 * than a bug in it, and the test says so instead of leaving it to be rediscovered.
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

/**
 * The run's totals after one more build SEGMENT reported its own.
 *
 * THE DEFECT IT FIXES. The build phase is two `builder.build()` calls against ONE
 * session (build-segment.ts), and `orchestrator.ts` wrote
 * `toApiTokens(outcome.tokens)` onto the row after each call — so a design
 * segment that spent 1000 followed by a build segment that reported 10 left the
 * run claiming 10, a number smaller than what the owner had already been shown.
 *
 * A FIELD-WISE SUM, AND THAT IS MEASURED RATHER THAN CHOSEN. Whether a RESUMED
 * session's `outcome.tokens` is per-call or already cumulative was not knowable
 * from this repo — nothing in it had ever run two segments against one session —
 * and the two readings need opposite arithmetic: summing a cumulative stream
 * double-counts segment 1, maxing a per-call one drops segment 2's share of every
 * field segment 1 led on. `design-segment-probe.mjs` settled it against the live
 * SDK on 2026-07-29, twice:
 *
 *   segment 1 (fresh)   input 10, output 61, cacheRead 15232, cacheWrite 2469
 *   segment 2 (resumed) input 10, output 71, cacheRead 17701, cacheWrite   91
 *
 * `cacheWrite` FELL, from 2469 to 91, and a running total cannot go down. Totals
 * are PER-CALL, so the run's spend is their sum. (`sink.tokens` is cumulative
 * WITHIN one call — `claude-builder.ts` builds it with `addTokens(running, …)` —
 * which is why the orchestrator adds each segment's growing total to what the row
 * held BEFORE that segment rather than to the row as it stands.)
 *
 * NO PROVIDER FIELD, DELIBERATELY. This merges the run ROW's `ApiTokens`, which
 * is one vendor's by construction (`RunDetail.tokens` reports the builder's
 * vendor only — see this file's header). A `TokenTotals`-shaped merge would need
 * a vendor check it cannot fail, which is a guard with no reachable branch.
 */
export function mergeTokenTotals(previous: ApiTokens | null, incoming: ApiTokens): ApiTokens {
  if (previous === null) return incoming;
  return {
    inputTokens: previous.inputTokens + incoming.inputTokens,
    outputTokens: previous.outputTokens + incoming.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + incoming.cacheReadTokens,
    cacheWriteTokens: previous.cacheWriteTokens + incoming.cacheWriteTokens,
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

/* -------------------------------------------------------------------------
 * Spend, attributed by seat
 * ---------------------------------------------------------------------- */

/**
 * The one value of `ApiRunSpend.pricing`, typed so it cannot drift from the
 * contract.
 *
 * IT LIVES HERE AND NOT IN api-types.ts BECAUSE THAT FILE IS A TYPE FILE. Its
 * only runtime export is `SSE_EVENT_TYPES`, which exists so the CLIENT can be
 * compared against it; a second runtime constant there would be a second reason
 * for the wire contract to be imported at run time. The annotation is the join:
 * changing the literal in either place stops compiling.
 */
export const NOT_PRICED: ApiPricingBasis = "not-priced-subscription-seat";

/** One seat's contribution, as its caller knows it before it is persisted. */
export interface SeatContribution {
  readonly seat: ApiSpendSeat;
  /** The seat's configured model. See `ApiSeatSpend.modelId`. */
  readonly modelId: string;
  readonly totals: TokenTotals;
}

/** A contribution flattened into the wire row. The vendor rides along. */
export function toSeatSpend(entry: SeatContribution): ApiSeatSpend {
  return {
    seat: entry.seat,
    provider: entry.totals.provider,
    modelId: entry.modelId,
    tokens: toApiTokens(entry.totals),
    callCount: entry.totals.callCount,
  };
}

/**
 * The seats folded into ONE ROW PER VENDOR. This is the run's total.
 *
 * GROUPED FIRST, ADDED SECOND, AND THE ORDER OF THOSE TWO IS THE WHOLE
 * CORRECTNESS ARGUMENT. `addTokens` THROWS on a vendor mismatch — deliberately,
 * see its docblock — so `rows.reduce(addTokens)` over a mixed list takes down
 * whatever was writing the record on every Codex run, where the builder is
 * OpenAI and three other seats are Anthropic. Grouping by provider before adding
 * means the refusal can only fire if the grouping itself is broken, which is the
 * one occasion it MUST fire rather than be engineered away.
 *
 * AND IT GOES THROUGH `addTokens` RATHER THAN ADDING FOUR NUMBERS IN A LOOP,
 * because that function is the only place in this program where token counts are
 * summed and the vendor rule is enforced. A local sum here would be a second
 * adder with no guard — `mergeTokenTotals` is exactly that (it takes `ApiTokens`,
 * which carries no vendor at all) and routing seats through it would silently
 * produce the cross-vendor figure this file's header forbids.
 *
 * VENDOR ORDER IS FIRST-SEEN, for the reason `mergeModelRows` gives: a reader
 * asking "what did this run spend" reads the vendors in the order the run
 * acquired them, and the seats list inside each row is in that same order.
 */
export function spendByVendor(rows: readonly ApiSeatSpend[]): readonly ApiVendorSpend[] {
  const groups = new Map<ApiProvider, { total: TokenTotals; readonly seats: ApiSpendSeat[] }>();
  for (const row of rows) {
    const contribution: TokenTotals = {
      provider: row.provider,
      inputTokens: row.tokens.inputTokens,
      outputTokens: row.tokens.outputTokens,
      cacheReadTokens: row.tokens.cacheReadTokens,
      cacheWriteTokens: row.tokens.cacheWriteTokens,
      callCount: row.callCount,
    };
    const group = groups.get(row.provider);
    if (group === undefined) {
      groups.set(row.provider, { total: contribution, seats: [row.seat] });
      continue;
    }
    groups.set(row.provider, {
      total: addTokens(group.total, contribution),
      seats: group.seats.includes(row.seat) ? group.seats : [...group.seats, row.seat],
    });
  }
  return [...groups.entries()].map(([provider, group]) => ({
    provider,
    tokens: toApiTokens(group.total),
    callCount: group.total.callCount,
    seats: [...group.seats],
  }));
}

/**
 * The whole spend record, assembled from rows that were already persisted.
 *
 * `byVendor` IS DERIVED HERE AND NEVER STORED, so it cannot disagree with the
 * seat rows it totals — the same argument `addTokens` makes about `byModel`. A
 * persisted total is a second source of truth that goes stale the moment one
 * seat is recorded and the other is not, which is the state every interrupted
 * run is in.
 */
export function runSpend(
  seats: readonly ApiSeatSpend[],
  metered: readonly ApiMeteredSpend[],
): ApiRunSpend {
  return {
    bySeat: [...seats],
    byVendor: spendByVendor(seats),
    metered: [...metered],
    pricing: NOT_PRICED,
  };
}

/** One vendor's row out of a spend record, or null when it spent nothing. */
export function vendorSpend(spend: ApiRunSpend, provider: ApiProvider): ApiVendorSpend | null {
  return spend.byVendor.find((row) => row.provider === provider) ?? null;
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
