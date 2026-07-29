/**
 * adapters.ts — vendor integrations. Implements {@link ProviderAdapter} from
 * contracts.ts for all four providers in the matrix.
 *
 * WHY THIS FILE EXISTS. The scaffold README lists provider adapters as "not
 * here". The cost ledger cannot compute a single dollar without
 * `normalizeUsage` (raw wire payload -> {@link VendorUsage}) and
 * `worstCaseCallCostUsd` (the pre-call ceiling check), so the ledger module
 * ships them. Nothing in contracts.ts or config.ts is modified.
 *
 * THREE RULES, ALL FROM THE FROZEN CONTRACT:
 *
 *  1. A FIELD THE VENDOR DID NOT REPORT IS NEVER RECORDED AS 0. An unreported
 *     cache-write count understates the bill and corrupts the per-vendor
 *     cache-hit fraction, which is one of the bake-off's secondary metrics and
 *     the single fact that decides config C (doc 03 section 7.2). Unrecognised
 *     payloads throw `invalid_usage_shape` with the KEY NAMES that were present
 *     — never a value — so the adapter can be extended after one cheap failed
 *     call rather than after a whole mis-costed campaign.
 *
 *  2. TOKEN COUNTS ARE PER VENDOR AND ARE NEVER SUMMED ACROSS VENDORS. This
 *     file returns one {@link VendorUsage} row per call, tagged with its
 *     provider. It offers no aggregation of any kind.
 *
 *  3. THE WORST-CASE ESTIMATE MUST NOT BE OPTIMISTIC. A ceiling checked against
 *     an optimistic estimate is not a ceiling.
 *
 * SECURITY: adapters declare the NAME of the environment variable they need and
 * never receive, store, return or log a value.
 */

import {
  BakeoffError,
  priceVendorUsage,
  resolvePrice,
  validateSeatEffort,
} from "./contracts.js";
import type {
  EffortValidation,
  ModelSeat,
  Provider,
  ProviderAdapter,
  UsageCounts,
  VendorUsage,
} from "./contracts.js";

/* -------------------------------------------------------------------------
 * Endpoints
 * ---------------------------------------------------------------------- */

/**
 * The wire protocol a seat's endpoint speaks.
 *
 * Held-constant variable 2 is "one harness, ours, for every configuration"
 * (doc 03 section 7.3). This harness speaks the Anthropic Messages API, which
 * is what makes a single harness able to drive Claude, Kimi and DeepSeek: both
 * Moonshot and DeepSeek publish an Anthropic-format endpoint (doc 03 section
 * 6.4, quoted in {@link DEFAULT_BASE_URLS}).
 *
 * OpenAI does not. That is a SECOND, INDEPENDENT blocker on config E, on top of
 * the missing price: routing it would require a wire translator, and a
 * translator is a second harness wearing the first one's name — precisely what
 * held-constant variable 2 forbids. Stated here rather than discovered mid-run.
 */
export type WireFormat = "anthropic-messages" | "openai-chat-completions";

/**
 * First-party endpoints.
 *
 * The Moonshot and DeepSeek Anthropic-format URLs are quoted verbatim from doc
 * 03 section 6.4: "DeepSeek publishes an Anthropic-format endpoint at
 * `https://api.deepseek.com/anthropic` and maps `claude-opus*` ->
 * `deepseek-v4-pro`, `claude-sonnet*`/`claude-haiku*` -> `deepseek-v4-flash`;
 * Moonshot publishes `https://api.moonshot.ai/anthropic`".
 *
 * >>> THE DEEPSEEK ALIAS MAP IS A TRAP, AND IT IS LOAD-BEARING FOR CONFIG B.
 * >>> Config B's subagent seat is DeepSeek V4 **Pro** (doc 03 section 3.4:
 * >>> "V4 PRO, not V4 Flash: AA-Briefcase puts Flash (833) below Sonnet 5 at
 * >>> low (928)"). A subagent that reaches that endpoint under a `claude-sonnet*`
 * >>> name is silently served V4 FLASH — a different, weaker model, invisible in
 * >>> every log. This harness therefore rewrites the outgoing `model` field to
 * >>> `seat.modelId` verbatim and ASSERTS the response's `model` field agrees
 * >>> (see assertResponseModel). A substitution kills the run as an
 * >>> infrastructure failure rather than producing a number for the wrong model.
 */
export const DEFAULT_BASE_URLS: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: "https://api.anthropic.com",
  moonshot: "https://api.moonshot.ai/anthropic",
  deepseek: "https://api.deepseek.com/anthropic",
  openai: "https://api.openai.com/v1",
});

export const WIRE_FORMATS: Readonly<Record<Provider, WireFormat>> = Object.freeze({
  anthropic: "anthropic-messages",
  moonshot: "anthropic-messages",
  deepseek: "anthropic-messages",
  openai: "openai-chat-completions",
});

/* -------------------------------------------------------------------------
 * Strict payload reading
 * ---------------------------------------------------------------------- */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Key NAMES present on a payload. Never a value: a value can be a secret. */
function keyNames(value: unknown): string {
  const record = asRecord(value);
  if (record === null) return `<${value === null ? "null" : typeof value}>`;
  const keys = Object.keys(record).sort();
  return keys.length === 0 ? "<no keys>" : keys.join(", ");
}

function shapeError(provider: Provider, modelId: string, problem: string, raw: unknown): BakeoffError {
  return new BakeoffError(
    "invalid_usage_shape",
    `${provider}/${modelId}: ${problem}. Keys present: ${keyNames(raw)}`,
    "Extend the adapter in src/adapters.ts to read this vendor's usage shape. Do NOT record the " +
      "missing field as 0: an unreported cache-write count understates the bill and corrupts the " +
      "per-vendor cache-hit fraction, which is a secondary metric of the bake-off. This error is " +
      "raised on the FIRST call with an unrecognised shape so that at most one call is mis-costed.",
  );
}

/** A token count that must be present: a non-negative safe integer. */
function requiredCount(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  provider: Provider,
  modelId: string,
): number {
  const value = raw[key];
  if (value === undefined || value === null) {
    throw shapeError(provider, modelId, `usage field "${key}" is absent`, raw);
  }
  return checkedCount(value, key, provider, modelId, raw);
}

/** A token count that may legitimately be absent. Absent means null, not 0. */
function optionalCount(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  provider: Provider,
  modelId: string,
): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  return checkedCount(value, key, provider, modelId, raw);
}

function checkedCount(
  value: unknown,
  key: string,
  provider: Provider,
  modelId: string,
  raw: unknown,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw shapeError(
      provider,
      modelId,
      `usage field "${key}" is not a non-negative integer (type ${typeof value})`,
      raw,
    );
  }
  return value;
}

/** First key present out of a candidate list, or null. */
function firstPresent(
  raw: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return key;
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Normalised counts -> VendorUsage
 * ---------------------------------------------------------------------- */

/** Counts pulled off the wire, before pricing. One API call. */
export interface NormalizedCounts extends UsageCounts {
  readonly thinkingTokens: number | null;
}

function toVendorUsage(
  counts: NormalizedCounts,
  seat: ModelSeat,
  atIsoInstant: string,
  callCount: number,
): VendorUsage {
  const resolved = resolvePrice(seat.provider, seat.modelId, atIsoInstant);
  // Anthropic reports the 5m/1h split, so no TTL assumption is needed there.
  // Moonshot and DeepSeek do not, and their 5m and 1h rates are equal in
  // PRICE_TABLE, so priceVendorUsage does not need assumeWriteTtl either. If a
  // future price entry gives them different write rates, priceVendorUsage
  // throws rather than silently choosing the cheaper one — that is intended.
  const costUsd = priceVendorUsage(counts, resolved);
  return {
    provider: seat.provider,
    inputTokens: counts.inputTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    outputTokens: counts.outputTokens,
    costUsd,
    modelId: seat.modelId,
    role: seat.role,
    effort: seat.effort,
    callCount,
    cacheWrite5mTokens: counts.cacheWrite5mTokens,
    cacheWrite1hTokens: counts.cacheWrite1hTokens,
    thinkingTokens: counts.thinkingTokens,
  };
}

/**
 * Merge two usage rows for the SAME (provider, modelId, role).
 *
 * This is the ONLY aggregation of token counts anywhere in the harness, and it
 * is within one vendor and one seat by construction: it throws otherwise.
 * `thinkingTokens` stays null unless at least one side reported it — a vendor
 * that never reports thinking tokens must not end up looking like it reported
 * zero (doc 04 section 4.2).
 */
export function mergeVendorUsage(a: VendorUsage, b: VendorUsage): VendorUsage {
  if (a.provider !== b.provider || a.modelId !== b.modelId || a.role !== b.role) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `refusing to merge usage across vendors or seats: ` +
        `${a.provider}/${a.modelId}/${a.role} vs ${b.provider}/${b.modelId}/${b.role}`,
      "Token counts are per vendor and are never summed across vendors. Keep one row per " +
        "(provider, modelId, role) and compare dollars only.",
    );
  }
  const addNullable = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    provider: a.provider,
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    modelId: a.modelId,
    role: a.role,
    effort: a.effort,
    callCount: a.callCount + b.callCount,
    cacheWrite5mTokens: addNullable(a.cacheWrite5mTokens, b.cacheWrite5mTokens),
    cacheWrite1hTokens: addNullable(a.cacheWrite1hTokens, b.cacheWrite1hTokens),
    thinkingTokens: addNullable(a.thinkingTokens, b.thinkingTokens),
  };
}

/* -------------------------------------------------------------------------
 * Shared adapter behaviour
 * ---------------------------------------------------------------------- */

abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly provider: Provider;
  abstract readonly displayName: string;

  requiredEnvNames(seat: ModelSeat): readonly string[] {
    this.assertSeat(seat);
    return [seat.envKeyName];
  }

  resolveBaseUrl(seat: ModelSeat): string | null {
    this.assertSeat(seat);
    return seat.baseUrl;
  }

  validateEffort(seat: ModelSeat): EffortValidation {
    this.assertSeat(seat);
    return validateSeatEffort(seat);
  }

  abstract normalizeUsage(raw: unknown, seat: ModelSeat, atIsoInstant: string): VendorUsage;

  /**
   * Worst-case USD cost of the call about to be dispatched.
   *
   * Output is priced at the FULL planned `max_tokens`, and input at the HIGHEST
   * of the model's input-side rates (cache-miss input, 5-minute write, 1-hour
   * write). The contract's floor is the cache-miss rate; a cache WRITE bills
   * above it on Anthropic (1.25x / 2.0x, doc 04 section 3.1), so pricing at the
   * miss rate alone would under-estimate a cold call by up to 2x. A ceiling
   * checked against an optimistic estimate is not a ceiling.
   */
  worstCaseCallCostUsd(
    seat: ModelSeat,
    plannedMaxOutputTokens: number,
    estimatedInputTokens: number,
    atIsoInstant: string,
  ): number {
    this.assertSeat(seat);
    assertNonNegativeInteger(plannedMaxOutputTokens, "plannedMaxOutputTokens");
    assertNonNegativeInteger(estimatedInputTokens, "estimatedInputTokens");

    const resolved = resolvePrice(seat.provider, seat.modelId, atIsoInstant);
    const p = resolved.price;
    const inputSideRates = [p.inputUsdPerMTok, p.cacheWrite5mUsdPerMTok, p.cacheWrite1hUsdPerMTok];
    if (inputSideRates.some((r) => r === null) || p.outputUsdPerMTok === null) {
      throw new BakeoffError(
        "unpriced_usage",
        `${seat.provider}/${seat.modelId} cannot be pre-checked against the cost ceiling: ` +
          "at least one input-side or output price is unknown",
        "Complete the PRICE_TABLE entry in src/contracts.ts before running this configuration. " +
          "The hard ceiling is denominated in dollars and checked before every call; running " +
          "unpriced means running uncapped.",
      );
    }
    const worstInputRate = Math.max(...(inputSideRates as number[]));
    const perMTok = 1_000_000;
    return (
      (estimatedInputTokens / perMTok) * worstInputRate +
      (plannedMaxOutputTokens / perMTok) * p.outputUsdPerMTok
    );
  }

  protected assertSeat(seat: ModelSeat): void {
    if (seat.provider !== this.provider) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `${this.displayName} adapter received a ${seat.provider} seat (${seat.role}/${seat.modelId})`,
        "Route each seat to the adapter for its own provider via adapterFor().",
      );
    }
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${name} must be a non-negative safe integer, got ${String(value)}`,
      "Fix the caller. A malformed pre-call estimate silently disables the cost ceiling.",
    );
  }
}

/* -------------------------------------------------------------------------
 * Anthropic (and the Anthropic-format endpoints that mirror it)
 * ---------------------------------------------------------------------- */

/**
 * Read the Anthropic Messages API `usage` object.
 *
 * Field meanings (doc 04 sections 3.4 and 9.1):
 *   input_tokens               tokens AFTER the last cache breakpoint — NEVER the total
 *   cache_read_input_tokens    hit volume, billed at 0.1x on Claude models
 *   cache_creation_input_tokens write volume
 *   cache_creation             { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }
 *   output_tokens_details.thinking_tokens  whether section 4 is a $15 or a $3 lever
 *
 * `requireCacheFields` is true for Anthropic itself, which documents all of
 * them. A mirror endpoint that omits them is an unrecognised shape and throws.
 */
function readAnthropicCounts(
  raw: unknown,
  provider: Provider,
  modelId: string,
): NormalizedCounts {
  const usage = asRecord(raw);
  if (usage === null) {
    throw shapeError(provider, modelId, "usage payload is not an object", raw);
  }

  const inputTokens = requiredCount(usage, "input_tokens", provider, modelId);
  const outputTokens = requiredCount(usage, "output_tokens", provider, modelId);
  const cacheReadTokens = requiredCount(usage, "cache_read_input_tokens", provider, modelId);
  const cacheWriteTokens = requiredCount(usage, "cache_creation_input_tokens", provider, modelId);

  let cacheWrite5mTokens: number | null = null;
  let cacheWrite1hTokens: number | null = null;
  const creation = asRecord(usage["cache_creation"]);
  if (creation !== null) {
    cacheWrite5mTokens = requiredCount(creation, "ephemeral_5m_input_tokens", provider, modelId);
    cacheWrite1hTokens = requiredCount(creation, "ephemeral_1h_input_tokens", provider, modelId);
  }

  let thinkingTokens: number | null = null;
  const details = asRecord(usage["output_tokens_details"]);
  if (details !== null) {
    thinkingTokens = optionalCount(details, "thinking_tokens", provider, modelId);
  }

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    thinkingTokens,
  };
}

class AnthropicAdapter extends BaseAdapter {
  readonly provider = "anthropic" as const;
  readonly displayName = "Anthropic";

  normalizeUsage(raw: unknown, seat: ModelSeat, atIsoInstant: string): VendorUsage {
    this.assertSeat(seat);
    const counts = readAnthropicCounts(raw, this.provider, seat.modelId);
    return toVendorUsage(counts, seat, atIsoInstant, 1);
  }
}

/* -------------------------------------------------------------------------
 * Moonshot
 * ---------------------------------------------------------------------- */

/**
 * Moonshot's Anthropic-format endpoint.
 *
 * Moonshot documents NEITHER a cache TTL NOR a cache-write charge (doc 03 table
 * 2.1, flagged [uncertain]), and measuring exactly that is one of the two stated
 * reasons a Kimi configuration is in this bake-off at all. So this adapter is
 * deliberately strict: it reads the Anthropic field names, and if a cache field
 * is missing it throws with the key names rather than assuming zero. Assuming
 * zero would silently answer, with a fabricated number, the precise question the
 * configuration exists to measure.
 */
class MoonshotAdapter extends BaseAdapter {
  readonly provider = "moonshot" as const;
  readonly displayName = "Moonshot";

  normalizeUsage(raw: unknown, seat: ModelSeat, atIsoInstant: string): VendorUsage {
    this.assertSeat(seat);
    const usage = asRecord(raw);
    if (usage === null) {
      throw shapeError(this.provider, seat.modelId, "usage payload is not an object", raw);
    }

    // Preferred: the Anthropic field names its /anthropic endpoint mirrors.
    if (usage["cache_read_input_tokens"] !== undefined) {
      const counts = readAnthropicCounts(usage, this.provider, seat.modelId);
      return toVendorUsage(counts, seat, atIsoInstant, 1);
    }

    // Documented OpenAI-style alternative: cached_tokens inside
    // prompt_tokens_details, with prompt_tokens as the INCLUSIVE total.
    const details = asRecord(usage["prompt_tokens_details"]);
    const cachedKey = details === null ? null : firstPresent(details, ["cached_tokens"]);
    if (details !== null && cachedKey !== null) {
      const promptTokens = requiredCount(usage, "prompt_tokens", this.provider, seat.modelId);
      const cacheReadTokens = requiredCount(details, cachedKey, this.provider, seat.modelId);
      const outputTokens = requiredCount(usage, "completion_tokens", this.provider, seat.modelId);
      if (cacheReadTokens > promptTokens) {
        throw shapeError(
          this.provider,
          seat.modelId,
          `cached_tokens ${cacheReadTokens} exceeds prompt_tokens ${promptTokens}`,
          usage,
        );
      }
      // No write line item is reported in this shape. Moonshot documents no
      // cache-write charge either, and PRICE_TABLE bills an assumed write at
      // the plain input rate (multiplier 1.0), so counting an uncached prompt
      // token as `input` matches the assumed bill exactly. The assumption rides
      // into RunRecord.pricingBasis on every dollar derived from it.
      return toVendorUsage(
        {
          inputTokens: promptTokens - cacheReadTokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
          outputTokens,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
          thinkingTokens: null,
        },
        seat,
        atIsoInstant,
        1,
      );
    }

    throw shapeError(
      this.provider,
      seat.modelId,
      "no recognised cache accounting fields (expected cache_read_input_tokens, or " +
        "prompt_tokens_details.cached_tokens)",
      usage,
    );
  }
}

/* -------------------------------------------------------------------------
 * DeepSeek
 * ---------------------------------------------------------------------- */

/**
 * DeepSeek's Anthropic-format endpoint.
 *
 * PRICE_TABLE states the invariant this class enforces: "DeepSeek's cache is
 * automatic with NO write premium and no separate write line item: a miss is
 * billed as ordinary input. Adapters MUST therefore report cacheWriteTokens = 0
 * and count misses as inputTokens."
 *
 * A non-zero cache-write count from DeepSeek is therefore not a number to
 * record — it is an unrecognised billing shape, and it throws.
 */
class DeepSeekAdapter extends BaseAdapter {
  readonly provider = "deepseek" as const;
  readonly displayName = "DeepSeek";

  normalizeUsage(raw: unknown, seat: ModelSeat, atIsoInstant: string): VendorUsage {
    this.assertSeat(seat);
    const usage = asRecord(raw);
    if (usage === null) {
      throw shapeError(this.provider, seat.modelId, "usage payload is not an object", raw);
    }

    // Anthropic-format shape.
    if (usage["cache_read_input_tokens"] !== undefined) {
      const counts = readAnthropicCounts(usage, this.provider, seat.modelId);
      if (counts.cacheWriteTokens !== 0) {
        throw shapeError(
          this.provider,
          seat.modelId,
          `reported ${counts.cacheWriteTokens} cache-creation tokens, but DeepSeek bills no separate ` +
            "cache-write line item (PRICE_TABLE). This is an unrecognised billing shape, not a number " +
            "to record",
          usage,
        );
      }
      return toVendorUsage(counts, seat, atIsoInstant, 1);
    }

    // DeepSeek-native shape: hit/miss split, both counted inside prompt_tokens.
    const hitKey = firstPresent(usage, ["prompt_cache_hit_tokens"]);
    const missKey = firstPresent(usage, ["prompt_cache_miss_tokens"]);
    if (hitKey !== null && missKey !== null) {
      const cacheReadTokens = requiredCount(usage, hitKey, this.provider, seat.modelId);
      const inputTokens = requiredCount(usage, missKey, this.provider, seat.modelId);
      const outputTokens = requiredCount(usage, "completion_tokens", this.provider, seat.modelId);
      const promptTokens = optionalCount(usage, "prompt_tokens", this.provider, seat.modelId);
      if (promptTokens !== null && promptTokens !== cacheReadTokens + inputTokens) {
        throw shapeError(
          this.provider,
          seat.modelId,
          `prompt_tokens ${promptTokens} does not equal hit ${cacheReadTokens} + miss ${inputTokens}`,
          usage,
        );
      }
      return toVendorUsage(
        {
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
          outputTokens,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
          thinkingTokens: null,
        },
        seat,
        atIsoInstant,
        1,
      );
    }

    throw shapeError(
      this.provider,
      seat.modelId,
      "no recognised cache accounting fields (expected cache_read_input_tokens, or " +
        "prompt_cache_hit_tokens + prompt_cache_miss_tokens)",
      usage,
    );
  }
}

/* -------------------------------------------------------------------------
 * OpenAI
 * ---------------------------------------------------------------------- */

/**
 * OpenAI.
 *
 * ONE BLOCKER LEFT, NOT TWO. Owner decision D3 (2026-07-27) added verified
 * per-MTok prices for gpt-5.6-luna, -sol and -terra, so `unpriced_usage` no
 * longer fires here and preflight no longer reports `unpriced_model` for config
 * E. What still stands is {@link WIRE_FORMATS}: OpenAI does not speak the
 * Anthropic Messages API, so the budget proxy refuses to route the seat. Adding
 * a wire translator would make config E run under a different harness from
 * every other configuration, which held-constant variable 2 forbids.
 *
 * >>> EXPOSURE CREATED BY PRICING THIS MODEL, AND IT IS UNVERIFIED. OpenAI's
 * >>> usage payload reports `prompt_tokens`, `prompt_tokens_details.cached_tokens`
 * >>> and `completion_tokens` — and NO cache-WRITE count. This adapter therefore
 * >>> records `cacheWriteTokens: 0` and the uncached remainder as `inputTokens`,
 * >>> which costs a cache write at the 1.00x input rate. If OpenAI does bill
 * >>> writes at the 1.25x rate D3 records, that UNDERSTATES the bill by 25% of
 * >>> whatever share of a run is cache writes. Nothing here has ever seen a real
 * >>> OpenAI response (STATUS.md section 4). Before config E is ever run, check
 * >>> one real response for a cache-write field; if one exists, map it and drop
 * >>> the hardcoded 0, which otherwise violates this module's own rule 1.
 */
class OpenAIAdapter extends BaseAdapter {
  readonly provider = "openai" as const;
  readonly displayName = "OpenAI";

  normalizeUsage(raw: unknown, seat: ModelSeat, atIsoInstant: string): VendorUsage {
    this.assertSeat(seat);
    const usage = asRecord(raw);
    if (usage === null) {
      throw shapeError(this.provider, seat.modelId, "usage payload is not an object", raw);
    }
    const details = asRecord(usage["prompt_tokens_details"]);
    if (details === null) {
      throw shapeError(
        this.provider,
        seat.modelId,
        "no prompt_tokens_details.cached_tokens; cache accounting cannot be reconstructed",
        usage,
      );
    }
    const promptTokens = requiredCount(usage, "prompt_tokens", this.provider, seat.modelId);
    const cacheReadTokens = requiredCount(details, "cached_tokens", this.provider, seat.modelId);
    const outputTokens = requiredCount(usage, "completion_tokens", this.provider, seat.modelId);
    const reasoning = asRecord(usage["completion_tokens_details"]);
    const thinkingTokens =
      reasoning === null
        ? null
        : optionalCount(reasoning, "reasoning_tokens", this.provider, seat.modelId);

    return toVendorUsage(
      {
        inputTokens: promptTokens - cacheReadTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        outputTokens,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
        thinkingTokens,
      },
      seat,
      atIsoInstant,
      1,
    );
  }
}

/* -------------------------------------------------------------------------
 * Registry
 * ---------------------------------------------------------------------- */

const ADAPTERS: Readonly<Record<Provider, ProviderAdapter>> = Object.freeze({
  anthropic: new AnthropicAdapter(),
  moonshot: new MoonshotAdapter(),
  deepseek: new DeepSeekAdapter(),
  openai: new OpenAIAdapter(),
});

/** The adapter for a provider. Total over {@link Provider}; never throws. */
export function adapterFor(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}

/** Effective upstream endpoint for a seat: explicit override, else first-party. */
export function upstreamBaseUrlFor(seat: ModelSeat): string {
  return seat.baseUrl ?? DEFAULT_BASE_URLS[seat.provider];
}

/** Wire protocol a seat's endpoint speaks. */
export function wireFormatFor(seat: ModelSeat): WireFormat {
  return WIRE_FORMATS[seat.provider];
}

/**
 * Assert the vendor served the model that was asked for.
 *
 * Vendors append a dated suffix ("claude-opus-5-20260114"), so a prefix match
 * is accepted; anything else is a SUBSTITUTION. The concrete case this exists
 * for: DeepSeek's Anthropic-format endpoint maps `claude-sonnet*` to
 * deepseek-v4-flash, and config B is only meaningful on deepseek-v4-pro
 * (doc 03 section 3.4). A substitution invalidates the run and every dollar
 * costed against it, and is invisible in every other signal.
 */
export function assertResponseModel(requestedModelId: string, responseModel: unknown): void {
  if (typeof responseModel !== "string" || responseModel.length === 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `response carried no model identifier; expected ${requestedModelId}`,
      "The upstream endpoint must echo the served model. Without it a silent model substitution " +
        "cannot be detected, and a substituted model invalidates the configuration under test.",
    );
  }
  if (responseModel === requestedModelId) return;
  if (responseModel.startsWith(`${requestedModelId}-`)) return;
  throw new BakeoffError(
    "invalid_usage_shape",
    `model substitution: requested ${requestedModelId}, served ${responseModel}`,
    "Do not score this run. The endpoint served a different model from the one under test — " +
      "DeepSeek's Anthropic-format endpoint maps claude-sonnet* to deepseek-v4-flash, which is a " +
      "weaker model than the deepseek-v4-pro config B measures. Send the vendor's own model id " +
      "verbatim, or use the vendor's alias environment variables, and re-run.",
  );
}
