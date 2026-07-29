/**
 * subscription-caller.ts — how the EXISTING spec agent runs with no API key.
 *
 * THE PROBLEM. `generateAuditedSuite` (bakeoff/src/spec-agent.ts) is the whole
 * gate machinery: author, deterministic 28-check bad-test audit, adversarial
 * judge pass, regenerate-on-blocking-finding, then build the `AcceptanceSuite`
 * that `freezeSuite` seals and the scorer later verifies by digest. It reaches
 * the model through `AnthropicSeatCaller`, which requires `ANTHROPIC_API_KEY`.
 * The dashboard has no API key and must never require one.
 *
 * THE CHOICE. Re-implementing the loop was rejected: `buildAcceptanceSuite` is
 * internal to spec-agent.ts, so a re-implementation would have to hand-assemble
 * the `AcceptanceSuite` whose `acceptanceSuiteDigest` is then checked three
 * ways downstream (`assertRunMatchesSuite`, `verifySuiteIntact`, the freeze
 * itself). A single field out of place there does not surface as a bug — it
 * surfaces as `suite_hash_mismatch`, which the scorer reports as TAMPERING.
 *
 * So this subclasses `AnthropicSeatCaller` and overrides exactly one method:
 * `call()`. Everything above it — prompts, parsing, audit, regeneration,
 * freeze — is the bake-off's own code, unmodified.
 *
 * WHAT THE PLACEHOLDER CREDENTIAL IS AND IS NOT. The base constructor calls
 * `checkCredential(seat.envKeyName, env)` and throws if the variable is absent.
 * It is handed an env in which that ONE variable holds a fixed, non-secret
 * sentinel, following the precedent of `dryRunEnv()` in bakeoff/src/dryrun.ts.
 * It is not a key, it is not key-shaped, and it authenticates nothing: the
 * `Anthropic` HTTP client the base class builds from it is never used, because
 * the only method that touches it is the one overridden here. `assertUnused()`
 * exists so that a future edit which reintroduces a base-class call path fails
 * loudly instead of firing an unauthenticated request at the API.
 *
 * WHAT THE CEILING STILL DOES, AND WHAT IT NO LONGER DOES. `SpendCeiling` is
 * denominated in dollars. A subscription call has no dollar cost, so the
 * worst-case passed to `checkBeforeCall` is 0 and the COST ceiling can never
 * fire. That is stated here rather than left to be discovered, because
 * bakeoff's own STATUS holds that a documented ceiling which cannot fire is
 * worse than no ceiling. Two boundaries do remain live and are the real ones:
 * `checkBeforeCall` still enforces `maxWallClockMs`, and the binding constraint
 * on a subscription is the provider's rate limit — a 5-hour rolling window plus
 * a weekly cap — which is surfaced, persisted and resumable rather than
 * treated as an error.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AnthropicSeatCaller, SeatCallError, SpendCeiling } from "bakeoff/dist/anthropic-seat.js";
import type { SeatCallRequest, SeatCallResult, SpendEvent } from "bakeoff/dist/anthropic-seat.js";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import type {
  AnthropicSeat,
  BudgetPolicy,
  PriceField,
  PriceStatus,
  PricingBasis,
  VendorUsage,
} from "bakeoff/dist/contracts.js";
import { PRICE_FIELDS } from "bakeoff/dist/contracts.js";
import { redactText } from "bakeoff/dist/redact.js";
import {
  NOT_RATE_LIMITED,
  assistantText,
  extractTokens,
  rateLimitFrom,
  resultErrorText,
} from "./claude-common.js";
import type { RateLimitState } from "./claude-common.js";
import { subscriptionSubprocessEnv } from "./subprocess-env.js";
import { addTokens, zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";

/**
 * The sentinel that satisfies `checkCredential` without being a credential.
 *
 * Assembled at runtime rather than written as one literal so that no
 * key-shaped constant exists in this tree even by coincidence, matching the
 * treatment of the bake-off's own test fixtures (STATUS section 6 item 8). It
 * must not match `PLACEHOLDER_RE` in bakeoff/src/env.ts — that regex is
 * anchored and matches whole words like "placeholder" or "changeme", not this.
 */
export const SUBSCRIPTION_SENTINEL = ["DASHBOARD", "SUBSCRIPTION", "OAUTH", "NO", "API", "KEY"].join("-");

/** Dollars. There is no per-token price on a subscription; there is no bill. */
const SUBSCRIPTION_COST_USD = 0;

/**
 * Turn cap for a seat call, and the variable that raises it.
 *
 * THE DEFAULT IS A MEASURED FLOOR, NOT A BOUND. At `maxTurns: 1` an audit call
 * came back `error_max_turns` — "Reached maximum number of turns (1)" — and
 * killed a run in the spec phase. 8 was then observed to be enough for one
 * suite (twelve criteria, five files). That is all that is known: it is the
 * smallest number proved sufficient once, not a limit anything was measured
 * against.
 *
 * WHY MORE THAN ONE TURN IS NEEDED AT ALL IS INFERENCE, NOT OBSERVATION. The
 * seat has NO TOOLS, so it cannot loop on tool use. The likely consumer is the
 * CLI's own structured-output retry, since the SDK declares a distinct
 * `error_max_structured_output_retries` result subtype — but that mechanism was
 * not watched directly, and this comment should not be read as if it had been.
 *
 * It is a BOUNDARY, not a heuristic — the distinction doc 03 section 7.8 draws.
 * Nothing here inspects progress or decides the seat is stuck.
 */
export const SEAT_MAX_TURNS_ENV = "DASHBOARD_SEAT_MAX_TURNS";
export const DEFAULT_SEAT_CALL_MAX_TURNS = 8;

function seatMaxTurns(env: NodeJS.ProcessEnv): number {
  const raw = (env[SEAT_MAX_TURNS_ENV] ?? "").trim();
  if (raw.length === 0) return DEFAULT_SEAT_CALL_MAX_TURNS;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SEAT_CALL_MAX_TURNS;
}

function subscriptionFieldStatus(): Readonly<Record<PriceField, PriceStatus>> {
  const status: Partial<Record<PriceField, PriceStatus>> = {};
  for (const field of PRICE_FIELDS) status[field] = "unverified";
  return status as Record<PriceField, PriceStatus>;
}

/**
 * Pricing provenance for a subscription call.
 *
 * Every field is `unverified`, which contracts.ts defines as "no known value:
 * usage touching one of these cannot be costed". That is exactly the truth
 * here — not a missing lookup, but an absent concept. Anything that later tries
 * to turn this row into dollars will find the provenance says it cannot.
 */
export function subscriptionPricingBasis(modelId: string, pricedAt: string): PricingBasis {
  return {
    provider: "anthropic",
    modelId,
    priceLabel: "subscription (claude setup-token) — quota consumed, not billed per token",
    priceEffectiveFrom: pricedAt.slice(0, 10),
    priceEffectiveUntil: null,
    pricedAt,
    fieldStatus: subscriptionFieldStatus(),
    assumedFields: [],
    assumedCacheWriteMultiplier: null,
    sourcedOn: pricedAt.slice(0, 10),
    source:
      "No source, because there is no per-token price to source. This seat runs against the owner's " +
      "Claude subscription through the Agent SDK's subprocess CLI. The SDK's own total_cost_usd is " +
      "an API-list-price equivalent, not a bill, and is dropped at the SDK boundary.",
  };
}

/** A usage row for a subscription call: real token counts, no dollars. */
export function subscriptionUsage(
  seat: AnthropicSeat,
  tokens: TokenTotals,
  thinkingTokens: number | null,
): VendorUsage {
  return {
    provider: "anthropic",
    inputTokens: tokens.inputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    outputTokens: tokens.outputTokens,
    costUsd: SUBSCRIPTION_COST_USD,
    modelId: seat.modelId,
    role: seat.role,
    effort: seat.effort,
    callCount: tokens.callCount,
    // The Agent SDK reports no 5m/1h cache-write split. Null means "not
    // reported"; 0 would mean "reported as zero" and would be a lie.
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    thinkingTokens,
  };
}

export interface SubscriptionCallerOptions {
  readonly budget: BudgetPolicy;
  readonly ceiling?: SpendCeiling;
  readonly onEvent?: (event: SpendEvent) => void;
  /** Working directory for the CLI subprocess. Keep it off the workspace. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Notified whenever the provider reports rate-limit state. */
  readonly onRateLimit?: (state: RateLimitState) => void;
  readonly abortController?: AbortController;
}

/** Environment for the base constructor: process env plus the one sentinel. */
export function sentinelEnv(envKeyName: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, [envKeyName]: SUBSCRIPTION_SENTINEL };
}

export class SubscriptionSeatCaller extends AnthropicSeatCaller {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #onRateLimit: ((state: RateLimitState) => void) | null;
  readonly #abortController: AbortController | null;
  #tokens: TokenTotals = zeroTokens("anthropic");
  #rateLimit: RateLimitState = NOT_RATE_LIMITED;
  #calls = 0;

  constructor(seat: AnthropicSeat, options: SubscriptionCallerOptions) {
    const base = options.env ?? process.env;
    super(seat, {
      budget: options.budget,
      env: sentinelEnv(seat.envKeyName, base),
      ...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    this.#cwd = options.cwd;
    // THE SUBPROCESS NEVER SEES A METERED CREDENTIAL. The sentinel above is
    // only for the base class's own credential check; the CLI must fall
    // through to its subscription login, and it will not if it finds a key.
    this.#env = subscriptionSubprocessEnv(base);
    this.#onRateLimit = options.onRateLimit ?? null;
    this.#abortController = options.abortController ?? null;
  }

  /** Token counts for every call this seat has made. Never a cost. */
  get tokens(): TokenTotals {
    return this.#tokens;
  }

  get callCount(): number {
    return this.#calls;
  }

  get rateLimit(): RateLimitState {
    return this.#rateLimit;
  }

  /**
   * One authoring or audit call, over the subscription CLI.
   *
   * The request is the bake-off's own `SeatCallRequest`, unaltered:
   *   - `system` becomes the SDK's `systemPrompt` as a plain string, which
   *     REPLACES the claude_code preset. The authoring prompt is a frozen
   *     constant and the whole point is that the spec seat sees it and nothing
   *     else.
   *   - `userTurns` are joined into the prompt in order.
   *   - `jsonSchema`, when present, becomes `outputFormat: {json_schema}`. It
   *     is applied, not dropped: a schema silently discarded here would turn
   *     into "the model keeps returning unparseable suites" three layers up.
   *   - `maxOutputTokens` has no SDK equivalent and is NOT silently ignored —
   *     it is enforced after the fact by the caller's own truncation check
   *     (`stop_reason`), which is what spec-agent already keys off.
   *
   * `tools: []` and `settingSources: []` are load-bearing. The spec seat must
   * be a structurally separate agent with no shared history and no access to
   * any implementation (doc 03 section 7.4); a spec seat that could read the
   * workspace, or that inherited the owner's CLAUDE.md, is not that agent.
   */
  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    if (request.userTurns.length === 0) {
      throw new BakeoffError(
        "invalid_usage_shape",
        "a seat call needs at least one user turn",
        "Pass the ticket brief (and any regeneration feedback) as user turns.",
      );
    }

    const startedAt = new Date().toISOString();

    // The dollar ceiling cannot fire on a subscription (worst case is 0), but
    // this call still enforces the WALL-CLOCK boundary, which can.
    const decision = this.ceiling.checkBeforeCall(0, request.purpose);
    this.ceiling.assertAllowed(decision, request.purpose);

    const abortController = this.#abortController ?? new AbortController();
    const options: Options = {
      abortController,
      cwd: this.#cwd,
      model: this.seat.modelId,
      effort: this.seat.effort,
      systemPrompt: request.system,
      tools: [],
      settingSources: [],
      maxTurns: seatMaxTurns(this.#env),
      includePartialMessages: false,
      env: { ...this.#env },
      ...(request.jsonSchema === null
        ? {}
        : { outputFormat: { type: "json_schema" as const, schema: request.jsonSchema } }),
    };

    let text = "";
    let structured: unknown;
    let stopReason: string | null = null;
    let tokens = zeroTokens("anthropic");
    let thinkingTokens: number | null = null;
    let failure: string | null = null;

    try {
      const session = query({ prompt: request.userTurns.join("\n\n"), options });
      for await (const message of session as AsyncIterable<SDKMessage>) {
        if (message.type === "assistant") {
          text += assistantText(message);
        } else if (message.type === "rate_limit_event") {
          this.#noteRateLimit(rateLimitFrom(message.rate_limit_info));
        } else if (message.type === "result") {
          stopReason = message.stop_reason;
          tokens = extractTokens(message.usage);
          thinkingTokens = readThinkingTokens(message.usage);
          if (message.subtype === "success") {
            structured = message.structured_output;
            if (text.length === 0) text = message.result;
          } else {
            failure = `${message.subtype}: ${resultErrorText(message)}`;
          }
        }
      }
    } catch (error) {
      throw this.#asCallError(error, request.purpose);
    }

    this.#tokens = addTokens(this.#tokens, tokens);
    this.#calls += 1;

    if (failure !== null) {
      throw new SeatCallError(
        `the ${this.seat.role} seat (${this.seat.modelId}) failed during "${request.purpose}": ` +
          redactText(failure).text,
        null,
        this.#rateLimit.limited
          ? "Rate limited. The 5-hour rolling window or the weekly cap is exhausted. This is an " +
            "expected state on a subscription, not a fault: wait for the window to reset and resume " +
            "the run, which continues the same session rather than starting over."
          : failure.startsWith("error_max_turns")
            ? `The seat hit its turn cap of ${String(seatMaxTurns(this.#env))}. The seat has no tools, ` +
              "so the turns are most likely the CLI re-asking after a response that did not validate " +
              `against the output schema. Raise ${SEAT_MAX_TURNS_ENV} and resume the run; if it keeps ` +
              "hitting the cap, the suite for this ticket does not fit the schema and the ticket text " +
              "is the thing to sharpen."
            : "Read the message above. If every authoring call fails on the output schema, retry with " +
              "structuredOutput disabled: the response then comes back as free-form text and " +
              "spec-agent's own JSON extractor reads the object out of it.",
        this.#rateLimit.limited,
      );
    }

    // Prefer the schema-validated object when one was requested and returned.
    // spec-agent parses text, so a structured result is re-serialised rather
    // than handed over as an object — same parse path, one less special case.
    const responseText = structured === undefined ? text : JSON.stringify(structured);

    return {
      text: responseText,
      stopReason,
      usage: subscriptionUsage(this.seat as AnthropicSeat, tokens, thinkingTokens),
      pricingBasis: subscriptionPricingBasis(this.seat.modelId, startedAt),
      precall: decision,
      // No `count_tokens` call is made: there is no ceiling for it to protect,
      // and it would spend quota to compute a number nothing consumes.
      inputEstimateMeasured: false,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }

  /**
   * Guard against a future edit reintroducing a base-class network path.
   *
   * The base class holds an `Anthropic` client built from the sentinel. Nothing
   * may use it. This cannot detect the call statically, so it is asserted where
   * it matters: after a run, `usage()`/`hasUsage` on the base class must still
   * be empty, because only the base `call()` populates them.
   */
  assertUnused(): void {
    if (this.hasUsage) {
      throw new BakeoffError(
        "invalid_usage_shape",
        "the base AnthropicSeatCaller recorded usage, which means a real API call was dispatched " +
          "with the placeholder credential",
        "A code path in AnthropicSeatCaller other than the overridden call() reached the network. " +
          "Find it and route it through the subscription SDK; the dashboard must never require or " +
          "use an API key.",
      );
    }
  }

  #noteRateLimit(state: RateLimitState): void {
    this.#rateLimit = state;
    if (this.#onRateLimit !== null) this.#onRateLimit(state);
  }

  #asCallError(error: unknown, purpose: string): Error {
    if (error instanceof BakeoffError || error instanceof SeatCallError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const rateLimited = /rate.?limit|429|usage limit/i.test(message);
    if (rateLimited) this.#noteRateLimit({ limited: true, retryAfterSec: null, kind: null, utilization: null });
    return new SeatCallError(
      `the ${this.seat.role} seat (${this.seat.modelId}) call "${purpose}" failed: ${redactText(message).text}`,
      null,
      rateLimited
        ? "Rate limited. Wait for the window to reset and resume the run."
        : "The Claude CLI subprocess failed. Check `claude auth status` — a session that expired " +
          "mid-run presents exactly like this. No API key is involved and none should be set.",
      rateLimited,
    );
  }
}

function readThinkingTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const details = (usage as { output_tokens_details?: unknown }).output_tokens_details;
  if (typeof details !== "object" || details === null) return null;
  const thinking = (details as { thinking_tokens?: unknown }).thinking_tokens;
  return typeof thinking === "number" && Number.isFinite(thinking) ? thinking : null;
}

/** A fresh ceiling for one ticket's authoring job. */
export function newAuthoringCeiling(budget: BudgetPolicy, onEvent?: (event: SpendEvent) => void): SpendCeiling {
  return new SpendCeiling(budget, onEvent === undefined ? {} : { onEvent });
}
