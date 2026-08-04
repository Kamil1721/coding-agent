/**
 * claude-common.ts — the bits every Claude Agent SDK call site needs.
 *
 * THE COST FIELD IS DROPPED HERE, ON PURPOSE, AT THE BOUNDARY.
 *
 * `SDKResultMessage` carries `total_cost_usd` and `modelUsage[].costUSD`.
 * Under `claude setup-token` those are what the same traffic WOULD have cost at
 * API list price — a modelled figure, not a bill. The owner is on a
 * subscription: quota is consumed, nothing is charged per token. Reading those
 * fields anywhere downstream is the single most likely way a fabricated dollar
 * amount reaches the UI, so `extractTokens` returns token counts and nothing
 * else, and no other module is given the raw result message.
 */

import type {
  NonNullableUsage,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ApiTokens } from "./api-types.js";
import type { ModelTokens, TokenTotals } from "./tokens.js";

/** Rate-limit state, normalised for the API contract. */
export interface RateLimitState {
  readonly limited: boolean;
  /** Seconds until the window resets, or null when the provider did not say. */
  readonly retryAfterSec: number | null;
  /** e.g. "five_hour", "seven_day". Verbatim from the provider. */
  readonly kind: string | null;
  /** 0-100 window utilisation where reported. */
  readonly utilization: number | null;
}

export const NOT_RATE_LIMITED: RateLimitState = Object.freeze({
  limited: false,
  retryAfterSec: null,
  kind: null,
  utilization: null,
});

/**
 * Read one usage payload into per-vendor token counts.
 *
 * A field the vendor did not report is recorded as 0 ONLY where the SDK's own
 * type says the field is non-nullable (`NonNullableUsage` is exactly that:
 * every `BetaUsage` field with the nulls removed). Nothing here invents a
 * missing count, and nothing here computes a price.
 */
export function extractTokens(usage: NonNullableUsage, callCount = 1): TokenTotals {
  return {
    provider: "anthropic",
    inputTokens: numberOr0(usage.input_tokens),
    outputTokens: numberOr0(usage.output_tokens),
    cacheReadTokens: numberOr0(usage.cache_read_input_tokens),
    cacheWriteTokens: numberOr0(usage.cache_creation_input_tokens),
    callCount,
    // ONE usage payload says nothing about which model produced it, so no model
    // is named. See `resultTokens` for the frame that does say.
    byModel: [],
  };
}

/**
 * The shape of one `ModelUsage` entry, as far as this file cares.
 *
 * STRUCTURAL AND DELIBERATELY NARROWER THAN THE SDK'S. The real entry also
 * carries `costUSD` — the modelled API list price of traffic that a subscription
 * did not charge for — plus `contextWindow`, `maxOutputTokens` and
 * `canonicalModel`. Naming only the four token fields means a spread can never
 * carry a dollar figure past this boundary by accident, which is the failure the
 * header of this file exists to prevent.
 *
 * Every field is optional so a CLI that stops reporting one degrades to 0 for
 * that count instead of taking a build down while INSTRUMENTING it.
 */
export interface ModelUsageEnvelope {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

/**
 * The shape of `SDKResultMessage`, as far as token accounting cares.
 *
 * `modelUsage` IS KEYED BY THE MODEL STRING THE CLI USED, and that key is
 * recorded verbatim. The SDK's own note says the entry's `canonicalModel` "may
 * differ from the raw model string this entry is keyed by (provider-specific
 * ids, aliases)", so mapping the key onto a catalog id here would be a guess
 * printed as a fact.
 */
export interface ResultUsageEnvelope {
  readonly usage: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly modelUsage?: Readonly<Record<string, ModelUsageEnvelope>>;
  readonly num_turns?: number;
}

/** The four counts one model spent, with the cost field left behind. */
function modelTokens(model: string, usage: ModelUsageEnvelope): ModelTokens {
  return {
    model,
    inputTokens: numberOr0(usage.inputTokens),
    outputTokens: numberOr0(usage.outputTokens),
    cacheReadTokens: numberOr0(usage.cacheReadInputTokens),
    cacheWriteTokens: numberOr0(usage.cacheCreationInputTokens),
  };
}

function sumRows(rows: readonly ModelTokens[]): ApiTokens {
  const sum = (pick: (row: ModelTokens) => number): number => rows.reduce((n, r) => n + pick(r), 0);
  return {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    cacheWriteTokens: sum((r) => r.cacheWriteTokens),
  };
}

/**
 * A run's whole token spend, keyed per model — the orchestrator AND everything
 * it delegated.
 *
 * WHY THIS EXISTS. `extractTokens(result.usage)` returns four scalars and no
 * model name. Delegation is the architecture here, so on a measured Phase 1
 * build 76% of the spend ran on OPUS subagents while the run's `modelId` said
 * `haiku`, and the dashboard had no field in which that fact could be stated.
 *
 * WHERE THE PER-MODEL NUMBERS COME FROM, verified in the CLI this SDK ships
 * rather than assumed. `modelUsage` is a per-model accumulator credited from the
 * shared API-response path, and the scalar `usage` on the same frame is COMPUTED
 * from it — the CLI builds it by summing `modelUsage`'s entries field by field.
 * The two are therefore one quantity at two resolutions, which is why the totals
 * below are taken from the rows: a total and a breakdown that can drift apart is
 * precisely the bug being fixed. When the CLI reports no rows at all the scalar
 * is used unchanged, so the arithmetic never gets worse than it was.
 *
 * THAT SENTENCE IS NOW PINNED BY A TEST THAT CAN TELL THE TWO APART. It was not
 * until 2026-07-28: because the shipped CLI's rows sum EXACTLY to its scalar,
 * every fixture shaped like a real frame returns the same four numbers whichever
 * source is used, so "taken from the rows" was asserted in this comment and by
 * nothing else. claude-common.test.ts now feeds a SKEWED frame — 40,000 input
 * against a 10,000 row sum — which is the only shape under which the two paths
 * disagree, and it is the same frame `usageDisagreement` speaks up about.
 *
 * WHAT IS NOT ADDED HERE, and this is the honest part of the fix. Two other
 * envelopes mention subagent tokens and NEITHER is a billed figure:
 * `task_notification.usage.total_tokens` is a progress estimate (latest input
 * plus cumulative output, or a characters/4 estimate for some task types), and
 * the Agent tool's own report carries the subagent's LAST assistant message's
 * usage, not its run. Adding either to a total would fabricate a number that
 * looks authoritative. They are left where they are.
 */
export function resultTokens(result: ResultUsageEnvelope): TokenTotals {
  const rows = Object.entries(result.modelUsage ?? {}).map(([model, usage]) =>
    modelTokens(model, usage),
  );
  const callCount = result.num_turns ?? 1;
  if (rows.length === 0) return extractTokens(result.usage as NonNullableUsage, callCount);
  return { provider: "anthropic", ...sumRows(rows), callCount, byModel: rows };
}

/**
 * Whether the CLI's scalar `usage` and its own per-model breakdown disagree, as
 * a sentence for the run log — or null when they agree or there is no breakdown.
 *
 * THE ASSUMPTION IS CHECKED RATHER THAN TRUSTED. `resultTokens` reports the sum
 * of the per-model rows because in the shipped CLI that IS the scalar. If a
 * later CLI changes what either field covers, this turns a silently wrong number
 * into a warning in the run's log, which is the difference between a figure
 * nobody can audit and one that says when it stopped being trustworthy.
 */
export function usageDisagreement(result: ResultUsageEnvelope): string | null {
  const rows = Object.entries(result.modelUsage ?? {}).map(([model, usage]) =>
    modelTokens(model, usage),
  );
  if (rows.length === 0) return null;
  const fromRows = sumRows(rows);
  const scalar = extractTokens(result.usage as NonNullableUsage);
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  const differences = fields
    .filter((field) => fromRows[field] !== scalar[field])
    .map((field) => `${field} ${String(scalar[field])} vs ${String(fromRows[field])} across models`);
  if (differences.length === 0) return null;
  return (
    `the CLI's own token totals disagree with its per-model breakdown (${differences.join(", ")}). ` +
    `The per-model figures were reported, since they say WHICH model spent what, but one of the two ` +
    `no longer covers what it used to and this run's totals should be treated as approximate.`
  );
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Turn a rate-limit event into API state.
 *
 * `resetsAt` is epoch SECONDS in the SDK's payload; the contract wants a
 * relative `retryAfterSec`, and a negative delta means the window has already
 * reset, so it clamps to 0 rather than reporting a time in the past.
 */
export function rateLimitFrom(info: SDKRateLimitInfo, nowMs: number = Date.now()): RateLimitState {
  const rejected = info.status === "rejected";
  const resetsAt = info.resetsAt;
  let retryAfterSec: number | null = null;
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    const resetMs = resetsAt > 1e11 ? resetsAt : resetsAt * 1000;
    retryAfterSec = Math.max(0, Math.round((resetMs - nowMs) / 1000));
  }
  return {
    limited: rejected,
    retryAfterSec,
    kind: info.rateLimitType ?? null,
    utilization: typeof info.utilization === "number" ? info.utilization : null,
  };
}

/** True when a message is the SDK's terminal result frame. */
export function isResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
}

/**
 * Concatenated text blocks from an assistant message.
 *
 * Thinking blocks are excluded, matching what `AnthropicSeatCaller.call` does
 * with the raw API. doc 02 section 5.2: builder chain-of-thought is an attack
 * surface, not evidence — 40-80% of misaligned responses were measured as
 * covert, i.e. misaligned reasoning under superficially aligned output.
 */
export function assistantText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  const content = message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Tool-use blocks in an assistant message, for the `tool` SSE event and for the
 * canvas.
 *
 * `id` IS CARRIED AND IS NULLABLE. It is the block id a later `task_started`
 * names in its `tool_use_id`, which is the ONLY route from a delegated task back
 * to the node that spawned it — an assistant message carries no `task_id` at
 * all. Nullable rather than skipped: a block without an id is still a tool call
 * worth showing, it simply cannot parent anything.
 */
export function toolUses(
  message: SDKMessage,
): readonly { id: string | null; name: string; input: unknown }[] {
  if (message.type !== "assistant") return [];
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const uses: { id: string | null; name: string; input: unknown }[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_use") {
      const named = block as { id?: unknown; name?: unknown; input?: unknown };
      if (typeof named.name === "string") {
        uses.push({
          id: typeof named.id === "string" ? named.id : null,
          name: named.name,
          input: named.input,
        });
      }
    }
  }
  return uses;
}

/**
 * One tool RESULT off a user message: the block id it answers, and the tool's
 * own structured output.
 *
 * `tool_use_result` IS THE FIELD, AND IT IS THE TOOL'S FULL Output OBJECT — not
 * the string the model sees. The SDK's own note on `SDKUserMessage`: "Structured
 * tool output — the tool's full Output object, not the string content sent to the
 * model. The shape is per-tool, keyed by the matching tool_use block's name". So
 * it stays `unknown` here and is duck-typed by whoever wants a particular shape;
 * `graph-emit.ts` reads `FileEditOutput`/`FileWriteOutput` off it.
 */
export interface SdkToolResult {
  /** The `tool_use` block this answers, or null when the block carried no id. */
  readonly toolUseId: string | null;
  readonly result: unknown;
}

/**
 * The tool result carried by one user message, or null when it carries none.
 *
 * ONE RESULT PER MESSAGE, AND THAT IS THE CLI'S OWN SHAPE RATHER THAN AN
 * ASSUMPTION. Verified by reading the shipped CLI: every message it converts
 * passes through a normaliser that maps `message.content` ONE ENTRY PER BLOCK —
 * `e.message.content.map((o, i) => ({...{content:[o], toolUseResult:e.toolUseResult}}))`
 * — so a turn that answered three tools arrives as three user messages, each with
 * a single `tool_result` block. Crucially that normaliser copies the SAME
 * `toolUseResult` onto every split, so pairing one structured output with more
 * than one block id would report a single edit under two different tool calls.
 * Taking the first `tool_result` block is therefore not a shortcut, it is the
 * only pairing that cannot double-count.
 *
 * NOTHING IS RETURNED FOR A MESSAGE WITH NO STRUCTURED OUTPUT. A `Bash` result,
 * a plain prompt, and a `tool_result` from a CLI too old to send the field all
 * land here; none of them says anything about a file, and inventing a result from
 * the text the model was shown is exactly the class of guess this file avoids.
 */
export function toolResultOf(message: SDKMessage): SdkToolResult | null {
  if (message.type !== "user") return null;
  const result = (message as { tool_use_result?: unknown }).tool_use_result;
  if (result === undefined || result === null) return null;
  const content = message.message.content;
  let toolUseId: string | null = null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_result"
      ) {
        const id = (block as { tool_use_id?: unknown }).tool_use_id;
        toolUseId = typeof id === "string" ? id : null;
        break;
      }
    }
  }
  return { toolUseId, result };
}

/**
 * A one-line summary of a tool call for the live trace.
 *
 * Bounded hard: a tool input can contain a whole file. The summary is for a
 * timeline row, and it is redacted downstream like every other persisted
 * string.
 */
export function summariseToolInput(input: unknown, limit = 160): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, limit);
  if (typeof input !== "object") return truncate(String(input), limit);

  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url", "description", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return truncate(`${key}: ${value}`, limit);
  }
  return truncate(JSON.stringify(input), limit);
}

export function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Errors from a non-success result frame, joined and bounded. */
export function resultErrorText(result: SDKResultMessage): string {
  if (result.subtype === "success") return "";
  return truncate(result.errors.join(" | "), 600);
}
