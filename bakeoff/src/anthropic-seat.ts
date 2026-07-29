/**
 * anthropic-seat.ts — one Anthropic seat, one hard spend ceiling.
 *
 * This is the only place in the spec-agent path that talks to a vendor. It
 * exists so that constraint 3 — "HARD COST CEILING + KILL SWITCH, enforced
 * OUT-OF-PROCESS, checked BEFORE each API call" — has exactly one
 * implementation that every call must pass through, rather than a check that
 * some call sites remember.
 *
 * FIVE RULES ENCODED HERE:
 *
 *  1. THE CEILING IS CHECKED BEFORE DISPATCH, against the WORST CASE of the
 *     call about to be made: estimated input at the cache-MISS rate plus the
 *     full planned `max_tokens` at the output rate. A ceiling checked against
 *     an optimistic estimate is not a ceiling, and a ceiling checked afterwards
 *     can be exceeded by one arbitrarily expensive call.
 *
 *  2. TERMINATION IS ON A BUDGET BOUNDARY ONLY. {@link KillReason} has no
 *     "stuck" member and this module adds none. Long-Horizon Terminal-Bench
 *     measured 79% of unresolved runs timing out WHILE STILL MAKING PROGRESS
 *     (doc 03 section 8.1).
 *
 *  3. NO CREDENTIAL EVER LEAVES THIS MODULE. The value is read from the
 *     environment variable NAMED by the seat, handed to the SDK constructor,
 *     and never returned, logged, hashed, length-reported or persisted. Every
 *     error message this module raises is passed through the redactor first.
 *
 *  4. USAGE IS RECORDED PER VENDOR AND NEVER CROSS-SUMMED. {@link mergeSeatUsage}
 *     merges rows for ONE (provider, modelId, role) — the same tokenizer, so
 *     the addition is meaningful. There is deliberately no helper that adds
 *     token counts across providers; contracts.ts's `sumCostUsd` sums dollars.
 *
 *  5. A FIELD THE VENDOR DID NOT REPORT IS NEVER RECORDED AS 0. An unreported
 *     cache-write count understates the bill and corrupts the cache-hit
 *     fraction, which is one of the bake-off's secondary metrics
 *     (doc 04 section 3.4).
 *
 * API SHAPES, from the claude-api skill and verified against
 * @anthropic-ai/sdk 0.115.0's own type declarations:
 *   - model id `claude-opus-5`
 *   - `thinking: { type: "adaptive" }` — `budget_tokens` is REMOVED (400)
 *   - `output_config: { effort }` — `low|medium|high|xhigh|max`, not top-level
 *   - NO `temperature` / `top_p` / `top_k` — rejected on Opus 5 (400)
 *   - stream, because at effort `xhigh` `max_tokens` must be >= 64,000 and a
 *     non-streaming request at that size hits SDK HTTP timeouts
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  BakeoffError,
  priceVendorUsage,
  pricingBasisOf,
  resolvePrice,
} from "./contracts.js";
import type {
  AnthropicSeat,
  BudgetPolicy,
  KillReason,
  PreCallDecision,
  PricingBasis,
  UsageCounts,
  VendorUsage,
} from "./contracts.js";
import { baseUrlEnvNameFor, checkCredential } from "./env.js";
import { redactText } from "./redact.js";

/* -------------------------------------------------------------------------
 * 1. Errors
 * ---------------------------------------------------------------------- */

/**
 * A vendor API or transport failure.
 *
 * DELIBERATELY NOT A `BakeoffError`. `BakeoffErrorCode` is a frozen union with
 * no member for "the vendor returned 503"; forcing one of the existing codes
 * onto a transport failure would make every downstream `catch (e) if
 * (e.code === ...)` lie about what happened. This class carries the same
 * `remediation` discipline instead: a clean message, an operator action, and
 * never a stack trace in the operator's face.
 *
 * Auth failures and ceiling breaches ARE `BakeoffError`s — those codes exist.
 */
export class SeatCallError extends Error {
  /** HTTP status, or null for a transport-level failure. */
  readonly status: number | null;
  /** Exact operator action that clears this. Never contains a secret. */
  readonly remediation: string;
  /** True for 429 and 5xx: retrying the same request may succeed. */
  readonly retryable: boolean;

  constructor(message: string, status: number | null, remediation: string, retryable: boolean) {
    super(message);
    this.name = "SeatCallError";
    this.status = status;
    this.remediation = remediation;
    this.retryable = retryable;
  }
}

/* -------------------------------------------------------------------------
 * 2. The out-of-process spend ceiling
 * ---------------------------------------------------------------------- */

/** What a {@link SpendCeiling} emitted. Mirrors LedgerEvent's spend subset. */
export type SpendEvent =
  | {
      readonly kind: "precall_check";
      readonly at: string;
      readonly decision: PreCallDecision;
      readonly purpose: string;
    }
  | {
      readonly kind: "budget_warning";
      readonly at: string;
      readonly cumulativeCostUsd: number;
      readonly ceilingUsd: number;
      readonly fractionUsed: number;
    }
  | {
      readonly kind: "usage_recorded";
      readonly at: string;
      readonly costUsd: number;
      readonly cumulativeCostUsd: number;
      readonly purpose: string;
    }
  | {
      readonly kind: "kill_issued";
      readonly at: string;
      readonly reason: KillReason;
      readonly cumulativeCostUsd: number;
      readonly detail: string;
    };

export interface SpendCeilingOptions {
  /** Epoch millis the clock starts. Defaults to now. */
  readonly startedAtMs?: number;
  /** Injected clock, for tests. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** Called for every spend event. Never receives a credential. */
  readonly onEvent?: (event: SpendEvent) => void;
}

/**
 * The kill switch. Supervises spend for a bounded piece of work.
 *
 * Held OUT OF PROCESS relative to the model: the model cannot see it, cannot
 * argue with it, and no vendor-side `task_budget` parameter substitutes for it.
 * Anthropic's own docs on that beta: "Claude may occasionally exceed the budget
 * if it is in the middle of an action."
 */
export class SpendCeiling {
  readonly policy: BudgetPolicy;
  #spentUsd = 0;
  #startedAtMs: number;
  #nowMs: () => number;
  #onEvent: ((event: SpendEvent) => void) | null;
  #warned = false;
  #decisions: PreCallDecision[] = [];

  constructor(policy: BudgetPolicy, options: SpendCeilingOptions = {}) {
    this.policy = policy;
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#startedAtMs = options.startedAtMs ?? this.#nowMs();
    this.#onEvent = options.onEvent ?? null;
  }

  /** Dollars committed so far. Only ever grows. */
  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** Milliseconds since the ceiling started supervising. */
  get elapsedMs(): number {
    return this.#nowMs() - this.#startedAtMs;
  }

  /** Every pre-call decision taken, in order. For the run log. */
  get decisions(): readonly PreCallDecision[] {
    return this.#decisions;
  }

  #emit(event: SpendEvent): void {
    if (this.#onEvent !== null) this.#onEvent(event);
  }

  /**
   * Decide whether the next call may be dispatched.
   *
   * `worstCaseNextCallUsd` MUST be the worst case, not the expected case.
   */
  checkBeforeCall(worstCaseNextCallUsd: number, purpose: string): PreCallDecision {
    const checkedAt = new Date(this.#nowMs()).toISOString();
    const projected = this.#spentUsd + worstCaseNextCallUsd;

    let killReason: KillReason | null = null;
    if (this.elapsedMs >= this.policy.maxWallClockMs) {
      killReason = "wall_clock_ceiling";
    } else if (projected > this.policy.maxCostUsd) {
      killReason = "cost_ceiling_usd";
    } else if (projected > this.policy.maxCampaignCostUsd) {
      killReason = "campaign_cost_ceiling_usd";
    }

    const decision: PreCallDecision = {
      allowed: killReason === null,
      killReason,
      cumulativeCostUsd: this.#spentUsd,
      ceilingUsd: this.policy.maxCostUsd,
      worstCaseNextCallUsd,
      checkedAt,
    };
    this.#decisions.push(decision);
    this.#emit({ kind: "precall_check", at: checkedAt, decision, purpose });
    return decision;
  }

  /** Throw cleanly when a decision refused the call. */
  assertAllowed(decision: PreCallDecision, purpose: string): void {
    if (decision.allowed) return;
    const reason = decision.killReason ?? "cost_ceiling_usd";
    this.#emit({
      kind: "kill_issued",
      at: decision.checkedAt,
      reason,
      cumulativeCostUsd: decision.cumulativeCostUsd,
      detail: `refused "${purpose}"`,
    });
    throw new BakeoffError(
      "budget_exceeded",
      `hard ceiling reached before "${purpose}": ${reason}. ` +
        `spent $${decision.cumulativeCostUsd.toFixed(4)}, worst case for this call ` +
        `$${decision.worstCaseNextCallUsd.toFixed(4)}, per-unit ceiling $${decision.ceilingUsd.toFixed(2)}, ` +
        `elapsed ${(this.elapsedMs / 1000).toFixed(0)}s of ${(this.policy.maxWallClockMs / 1000).toFixed(0)}s`,
      "This is a budget boundary, not a model failure and not a stuck-detector: nothing here inspects " +
        "progress. Raise the ceiling deliberately if the work genuinely needs it, or reduce max_tokens / " +
        "the attempt cap. Do not remove the check.",
    );
  }

  /** Commit the actual cost of a completed call. */
  record(costUsd: number, purpose: string): void {
    this.#spentUsd += costUsd;
    const at = new Date(this.#nowMs()).toISOString();
    this.#emit({ kind: "usage_recorded", at, costUsd, cumulativeCostUsd: this.#spentUsd, purpose });

    const fraction = this.policy.maxCostUsd > 0 ? this.#spentUsd / this.policy.maxCostUsd : 1;
    if (!this.#warned && fraction >= this.policy.warnAtFraction) {
      this.#warned = true;
      this.#emit({
        kind: "budget_warning",
        at,
        cumulativeCostUsd: this.#spentUsd,
        ceilingUsd: this.policy.maxCostUsd,
        fractionUsed: fraction,
      });
    }
  }
}

/* -------------------------------------------------------------------------
 * 3. Usage normalisation
 * ---------------------------------------------------------------------- */

function requireCount(value: number | null | undefined, field: string, seat: AnthropicSeat): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${seat.provider}/${seat.modelId} (${seat.role}) did not report usage.${field}`,
      "A usage field the vendor did not report must never be recorded as 0: it understates the bill " +
        "and corrupts the per-vendor cache-hit fraction (doc 04 section 3.4). Investigate the response " +
        "shape before recording anything.",
    );
  }
  return value;
}

/** Token counts and cost for one Anthropic response. */
export interface NormalizedUsage {
  readonly usage: VendorUsage;
  readonly pricingBasis: PricingBasis;
}

/**
 * Convert one Anthropic `usage` payload into a {@link VendorUsage} row.
 *
 * `input_tokens` on Anthropic counts only tokens AFTER the last cache
 * breakpoint — it is never the total (doc 04 section 3.4). It is recorded
 * unchanged and combined with the cache fields only inside
 * `vendorCacheHitFraction`, which is the one place that arithmetic is correct.
 */
export function normalizeAnthropicUsage(
  raw: Anthropic.Usage,
  seat: AnthropicSeat,
  atIsoInstant: string,
  callCount = 1,
): NormalizedUsage {
  const inputTokens = requireCount(raw.input_tokens, "input_tokens", seat);
  const outputTokens = requireCount(raw.output_tokens, "output_tokens", seat);
  const cacheReadTokens = requireCount(raw.cache_read_input_tokens, "cache_read_input_tokens", seat);
  const cacheWriteTokens = requireCount(
    raw.cache_creation_input_tokens,
    "cache_creation_input_tokens",
    seat,
  );

  const split = raw.cache_creation;
  const cacheWrite5mTokens = split === null || split === undefined ? null : split.ephemeral_5m_input_tokens;
  const cacheWrite1hTokens = split === null || split === undefined ? null : split.ephemeral_1h_input_tokens;

  const details = raw.output_tokens_details;
  const thinkingTokens =
    details === null || details === undefined || typeof details.thinking_tokens !== "number"
      ? null
      : details.thinking_tokens;

  const counts: UsageCounts = {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
  };

  const resolved = resolvePrice(seat.provider, seat.modelId, atIsoInstant);
  // This module never sets `cache_control.ttl`, so every write it can cause is
  // a 5-minute write. Stated explicitly rather than left to the default so the
  // assumption is recorded if the vendor ever omits the split.
  const costUsd =
    cacheWrite5mTokens === null || cacheWrite1hTokens === null
      ? priceVendorUsage(counts, resolved, { assumeWriteTtl: "5m" })
      : priceVendorUsage(counts, resolved);

  return {
    usage: {
      provider: seat.provider,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      costUsd,
      modelId: seat.modelId,
      role: seat.role,
      effort: seat.effort,
      callCount,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      thinkingTokens,
    },
    pricingBasis: pricingBasisOf(resolved, atIsoInstant),
  };
}

/**
 * Merge usage rows for ONE (provider, modelId, role) into the single row a run
 * record carries.
 *
 * LEGAL BECAUSE IT IS WITHIN ONE VENDOR AND ONE MODEL: the same tokenizer
 * produced every count, so the addition means something. There is deliberately
 * no cross-vendor equivalent — `sumCostUsd` in contracts.ts sums dollars, which
 * is the only quantity that is comparable across vendors.
 */
export function mergeSeatUsage(rows: readonly VendorUsage[]): VendorUsage {
  const first = rows[0];
  if (first === undefined) {
    throw new BakeoffError(
      "invalid_usage_shape",
      "mergeSeatUsage was given no rows",
      "Call it only after at least one API call has been recorded.",
    );
  }
  for (const row of rows) {
    if (row.provider !== first.provider || row.modelId !== first.modelId || row.role !== first.role) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `mergeSeatUsage refuses to merge ${row.provider}/${row.modelId}/${row.role} into ` +
          `${first.provider}/${first.modelId}/${first.role}`,
        "Token counts are per vendor and are never summed across vendors or models: tokenizers " +
          "differ. Merge within one (provider, modelId, role) and compare dollars and outcomes only.",
      );
    }
  }

  const sum = (pick: (row: VendorUsage) => number): number => rows.reduce((acc, r) => acc + pick(r), 0);
  // A nullable field stays null unless EVERY row reported it. Summing a
  // reported value with an unreported one would silently invent a zero.
  const sumNullable = (pick: (row: VendorUsage) => number | null): number | null => {
    let total = 0;
    for (const row of rows) {
      const value = pick(row);
      if (value === null) return null;
      total += value;
    }
    return total;
  };

  return {
    provider: first.provider,
    inputTokens: sum((r) => r.inputTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    cacheWriteTokens: sum((r) => r.cacheWriteTokens),
    outputTokens: sum((r) => r.outputTokens),
    costUsd: sum((r) => r.costUsd),
    modelId: first.modelId,
    role: first.role,
    effort: first.effort,
    callCount: sum((r) => r.callCount),
    cacheWrite5mTokens: sumNullable((r) => r.cacheWrite5mTokens),
    cacheWrite1hTokens: sumNullable((r) => r.cacheWrite1hTokens),
    thinkingTokens: sumNullable((r) => r.thinkingTokens),
  };
}

/* -------------------------------------------------------------------------
 * 4. Worst-case pre-call cost
 * ---------------------------------------------------------------------- */

/**
 * Worst-case USD for a call: estimated input priced at the cache-MISS rate,
 * plus the FULL planned `max_tokens` at the output rate.
 *
 * Cache reads are assumed to be zero on purpose. Pricing the estimate at the
 * discounted rate would let a cache miss carry the run past its ceiling.
 */
export function worstCaseCallCostUsd(
  seat: AnthropicSeat,
  plannedMaxOutputTokens: number,
  estimatedInputTokens: number,
  atIsoInstant: string,
): number {
  const resolved = resolvePrice(seat.provider, seat.modelId, atIsoInstant);
  return priceVendorUsage(
    {
      inputTokens: estimatedInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: plannedMaxOutputTokens,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
    },
    resolved,
  );
}

/**
 * Strict upper bound on the tokens a byte-level BPE tokenizer can produce for
 * a string: its UTF-8 byte length.
 *
 * Used only when `count_tokens` is unavailable. Character count is NOT a bound
 * — a 4-byte emoji can become several byte-level tokens — so bytes it is. The
 * bound is loose, which is the correct direction: a ceiling checked against an
 * optimistic estimate is not a ceiling.
 */
export function upperBoundInputTokens(...texts: readonly string[]): number {
  return texts.reduce((acc, text) => acc + Buffer.byteLength(text, "utf8"), 0);
}

/* -------------------------------------------------------------------------
 * 5. The seat caller
 * ---------------------------------------------------------------------- */

export interface SeatCallRequest {
  /**
   * The system prompt. Treated as a FROZEN CONSTANT and given the single cache
   * breakpoint: doc 04 section 3.2 orders the prompt by rate of change, and
   * section 3.3 item 1 names any per-request value interpolated before the last
   * breakpoint as the top cache killer.
   */
  readonly system: string;
  /** User turns, in order. Everything variable lives here, after the breakpoint. */
  readonly userTurns: readonly string[];
  readonly maxOutputTokens: number;
  /** JSON schema for `output_config.format`, or null for free-form text. */
  readonly jsonSchema: Record<string, unknown> | null;
  /** Tag for the ledger, e.g. "suite-authoring attempt 1". Never a secret. */
  readonly purpose: string;
}

export interface SeatCallResult {
  /** Concatenated text blocks. Thinking blocks are excluded. */
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: VendorUsage;
  readonly pricingBasis: PricingBasis;
  readonly precall: PreCallDecision;
  /** True when `count_tokens` supplied the pre-call input estimate. */
  readonly inputEstimateMeasured: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface SeatCallerOptions {
  readonly budget: BudgetPolicy;
  readonly env?: NodeJS.ProcessEnv;
  readonly ceiling?: SpendCeiling;
  readonly onEvent?: (event: SpendEvent) => void;
  /** SDK-level retries for 429/5xx. Default 2 (the SDK's own default). */
  readonly maxRetries?: number;
}

/** Redact, then trim, anything derived from a vendor response or error. */
function clean(text: string, limit = 600): string {
  const redacted = redactText(text).text;
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

/**
 * One Anthropic seat with its own hard ceiling.
 *
 * Construction resolves the credential by NAME and fails clean if it is absent
 * — the harness must never crash with a stack trace or silently skip a
 * configuration when a key is missing.
 */
export class AnthropicSeatCaller {
  readonly seat: AnthropicSeat;
  readonly ceiling: SpendCeiling;
  #client: Anthropic;
  #usageRows: VendorUsage[] = [];
  #pricingBases: PricingBasis[] = [];

  constructor(seat: AnthropicSeat, options: SeatCallerOptions) {
    const env = options.env ?? process.env;
    this.seat = seat;
    this.ceiling =
      options.ceiling ??
      new SpendCeiling(
        options.budget,
        options.onEvent === undefined ? {} : { onEvent: options.onEvent },
      );

    const credential = checkCredential(seat.envKeyName, env);
    if (!credential.present) {
      throw new BakeoffError(
        "missing_credential",
        `${seat.envKeyName} is ${credential.problem ?? "unusable"}; the ${seat.role} seat ` +
          `(${seat.provider}/${seat.modelId}) cannot run`,
        `Set ${seat.envKeyName} in the environment. Copy .env.example to .env and fill it in your ` +
          "editor, or export it in the shell that launches the harness. Never paste a key into a chat " +
          "transcript: transcripts are persisted, and a pasted key must then be rotated.",
      );
    }
    // Read once, hand straight to the SDK, never retain. Nothing below this
    // line can reach the value.
    const apiKey = (env[seat.envKeyName] ?? "").trim();
    const baseURL = seat.baseUrl ?? (env[baseUrlEnvNameFor(seat.provider)] ?? "").trim();
    const maxRetries = options.maxRetries ?? 2;
    this.#client =
      baseURL.length > 0
        ? new Anthropic({ apiKey, maxRetries, baseURL })
        : new Anthropic({ apiKey, maxRetries });
  }

  /** Merged usage for this seat, one row, ready for a run record. */
  usage(): VendorUsage {
    return mergeSeatUsage(this.#usageRows);
  }

  /** True once at least one call has completed. */
  get hasUsage(): boolean {
    return this.#usageRows.length > 0;
  }

  /** Pricing provenance for every call made, in order. */
  get pricingBases(): readonly PricingBasis[] {
    return this.#pricingBases;
  }

  /** Total dollars this seat has spent. The only cross-vendor-safe quantity. */
  get spentUsd(): number {
    return this.ceiling.spentUsd;
  }

  async #estimateInputTokens(
    system: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
  ): Promise<{ tokens: number; measured: boolean }> {
    try {
      const counted = await this.#client.messages.countTokens({
        model: this.seat.modelId,
        system,
        messages,
      });
      if (typeof counted.input_tokens === "number" && Number.isFinite(counted.input_tokens)) {
        return { tokens: counted.input_tokens, measured: true };
      }
    } catch {
      // Fall through to the conservative bound. count_tokens failing must not
      // stop the ceiling from being enforced — that would invert the control.
    }
    const texts = [
      ...system.map((block) => block.text),
      ...messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
    ];
    return { tokens: upperBoundInputTokens(...texts), measured: false };
  }

  /**
   * Dispatch one call.
   *
   * Order is load-bearing: build the request, ESTIMATE, CHECK THE CEILING,
   * then dispatch. Nothing reaches the network before the check.
   */
  async call(request: SeatCallRequest): Promise<SeatCallResult> {
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `maxOutputTokens must be a positive integer, got ${String(request.maxOutputTokens)}`,
        "At effort xhigh or max, Anthropic's own guidance is max_tokens >= 64000 or output truncates " +
          "mid-thought. See DEFAULT_MAX_OUTPUT_TOKENS in spec-types.ts.",
      );
    }
    if (request.userTurns.length === 0) {
      throw new BakeoffError(
        "invalid_usage_shape",
        "a seat call needs at least one user turn",
        "Pass the ticket brief (and any regeneration feedback) as user turns.",
      );
    }

    // LAYER 2 of doc 04 section 3.2: a frozen system prompt carrying the single
    // pinned cache breakpoint. Everything per-ticket sits after it.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
    ];
    const messages: Anthropic.MessageParam[] = request.userTurns.map((content) => ({
      role: "user",
      content,
    }));

    const startedAt = new Date().toISOString();
    const estimate = await this.#estimateInputTokens(system, messages);
    const worstCase = worstCaseCallCostUsd(
      this.seat,
      request.maxOutputTokens,
      estimate.tokens,
      startedAt,
    );

    const decision = this.ceiling.checkBeforeCall(worstCase, request.purpose);
    this.ceiling.assertAllowed(decision, request.purpose);

    const outputConfig: Anthropic.OutputConfig =
      request.jsonSchema === null
        ? { effort: this.seat.effort }
        : {
            effort: this.seat.effort,
            format: { type: "json_schema", schema: request.jsonSchema },
          };

    let message: Anthropic.Message;
    try {
      // Streamed because at effort xhigh max_tokens is >= 64,000 and a
      // non-streaming request at that size hits the SDK's HTTP timeout.
      // NO temperature / top_p / top_k: rejected with a 400 on Opus 5.
      // NO thinking.budget_tokens: removed, 400 on Opus 5.
      const stream = this.#client.messages.stream({
        model: this.seat.modelId,
        max_tokens: request.maxOutputTokens,
        system,
        messages,
        thinking: { type: "adaptive" },
        output_config: outputConfig,
      });
      message = await stream.finalMessage();
    } catch (error) {
      throw this.#asSeatCallError(error, request.purpose);
    }

    const endedAt = new Date().toISOString();
    const normalized = normalizeAnthropicUsage(message.usage, this.seat, startedAt);
    this.#usageRows.push(normalized.usage);
    this.#pricingBases.push(normalized.pricingBasis);
    this.ceiling.record(normalized.usage.costUsd, request.purpose);

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      stopReason: message.stop_reason,
      usage: normalized.usage,
      pricingBasis: normalized.pricingBasis,
      precall: decision,
      inputEstimateMeasured: estimate.measured,
      startedAt,
      endedAt,
    };
  }

  #asSeatCallError(error: unknown, purpose: string): Error {
    if (error instanceof BakeoffError) return error;

    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new BakeoffError(
        "missing_credential",
        `${this.seat.envKeyName} was rejected by ${this.seat.provider} during "${purpose}" ` +
          `(HTTP ${String(error.status)})`,
        `Check that ${this.seat.envKeyName} is a live key for an account with access to ` +
          `${this.seat.modelId}. doc 02 section 1.5 records that an invalid credential ` +
          '"does not block the session from continuing" — a bad key otherwise burns hours before ' +
          "anyone notices.",
      );
    }

    if (error instanceof Anthropic.APIError) {
      const status = typeof error.status === "number" ? error.status : null;
      const retryable = status !== null && (status === 429 || status >= 500);
      return new SeatCallError(
        `${this.seat.provider}/${this.seat.modelId} returned HTTP ${status === null ? "?" : String(status)} ` +
          `during "${purpose}": ${clean(error.message)}`,
        status,
        retryable
          ? "Transient. The SDK already retried; retry the whole authoring attempt, or reduce " +
            "concurrency. Cost already incurred is recorded."
          : "Not transient. This harness sends NO sampling parameter (temperature/top_p/top_k) and " +
            "NO thinking.budget_tokens — both are rejected with a 400 on Opus 5 and neither is in " +
            "the request. IF EVERY CALL IS FAILING WITH A 400, the first thing to try is " +
            "`structuredOutput: false`: the one parameter combination here that could not be " +
            "verified without a live key is output_config.format alongside thinking:{type:adaptive} " +
            "on a streamed request. With it off, the response is free-form and the module's JSON " +
            "extractor reads the object out of the text — the same parse path, one less constraint " +
            "on the request. Read the message above before assuming that is the cause.",
        retryable,
      );
    }

    return new SeatCallError(
      `${this.seat.provider}/${this.seat.modelId} call "${purpose}" failed before a response: ` +
        clean(error instanceof Error ? error.message : String(error)),
      null,
      "Transport or DNS failure. Check network reachability to the vendor endpoint, and whether an " +
        "endpoint override is set. No tokens were billed for a request that never completed.",
      true,
    );
  }
}
