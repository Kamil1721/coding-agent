/**
 * RATE-LIMIT DETECTION — for both subscription SDKs.
 *
 * A 429 IS AN EXPECTED OUTCOME OF A PERSONAL SUBSCRIPTION, NOT AN ERROR. Both
 * providers meter a rolling five-hour window plus a weekly cap. Hitting one is
 * an ordinary Tuesday, and the only wrong response is to lose the run.
 *
 * =========================================================================
 * THE TWO PROVIDERS ARE ASYMMETRIC, AND THIS FILE DOES NOT SMOOTH THAT OVER
 * =========================================================================
 *
 * ANTHROPIC gives a structured signal — `SDKRateLimitEvent.rate_limit_info`,
 * verified against the 0.3.220 type definitions:
 *
 *     { status: 'allowed' | 'allowed_warning' | 'rejected',
 *       resetsAt?: number, rateLimitType?: 'five_hour' | 'seven_day' | ...,
 *       utilization?: number, errorCode?: 'credits_required' }
 *
 * plus `SDKAssistantMessageError === 'rate_limit'`, plus
 * `SDKResultSuccess.api_error_status`, plus THREE EXPORTED PREFIX TABLES
 * (`USAGE_LIMIT_ERROR_PREFIXES`, `USAGE_WARNING_PREFIXES`,
 * `ORG_POLICY_LIMIT_PREFIXES`). Those tables are read off the loaded module at
 * run time rather than copied into this file: a hard-coded copy of a vendor's
 * string table is wrong the day the vendor edits it and gives no sign of it.
 *
 * CODEX GIVES NOTHING STRUCTURED. Every error it can produce is a string:
 * `{type:"error", message}`, `turn.failed.error.message`, and the thrown
 * `Codex Exec exited with code N: <stderr>`. Verified by running the SDK
 * against an empty CODEX_HOME and reading every event it emitted. So the Codex
 * path is a pattern match, is labelled `message_text` — the weakest
 * {@link RateLimitSignal} — and RETURNS `retryAfterSeconds: null` UNLESS THE
 * TEXT ACTUALLY CONTAINS ONE. There is no house default. A dashboard counting
 * down from a number nobody reported is worse than a dashboard showing a blank,
 * because the blank is honest about what is not known.
 */

import type { RateLimitKind, RateLimitSignal, RateLimitState } from "./types.js";
import { notRateLimited } from "./types.js";

/** Below this, a numeric timestamp is read as epoch SECONDS. See {@link resetsAtToIso}. */
const EPOCH_MS_THRESHOLD = 1e12;

/** Plausibility window for a decoded reset instant, in epoch milliseconds. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
const LATEST_PLAUSIBLE_OFFSET_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Decode Anthropic's `resetsAt` to an ISO instant.
 *
 * THE UNIT IS NOT DOCUMENTED. The 0.3.220 type definitions say `resetsAt?:
 * number` and nothing more, so this disambiguates by magnitude: below 1e12 is
 * read as seconds, at or above as milliseconds. The rule is unambiguous in
 * practice — 1e12 ms is 2001 and 1e12 s is the year 33658, so no instant this
 * decade is near the boundary.
 *
 * A value that decodes outside a plausible window returns null rather than a
 * countdown to 1970 or to the year 5000.
 */
export function resetsAtToIso(resetsAt: number, nowMs: number = Date.now()): string | null {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const ms = resetsAt < EPOCH_MS_THRESHOLD ? resetsAt * 1000 : resetsAt;
  if (ms < EARLIEST_PLAUSIBLE_MS) return null;
  if (ms > nowMs + LATEST_PLAUSIBLE_OFFSET_MS) return null;
  return new Date(ms).toISOString();
}

/** Seconds from now until an ISO instant, or null. Never negative. */
export function secondsUntil(iso: string | null, nowMs: number = Date.now()): number | null {
  if (iso === null) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.round((target - nowMs) / 1000));
}

/**
 * Normalise a reported utilization to a 0..1 fraction.
 *
 * ALSO UNDOCUMENTED as to unit. `0.42` and `42` both plausibly mean the same
 * thing, so a value in (1, 100] is read as a percentage. Anything outside
 * [0, 100] is not interpreted at all — null, not a clamp. A clamp would turn a
 * shape surprise into a confident "100% consumed" banner.
 */
export function normalizeUtilization(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return null;
}

/** Map Anthropic's `rateLimitType` on to {@link RateLimitKind}. */
export function anthropicLimitKind(rateLimitType: string | null): RateLimitKind {
  switch (rateLimitType) {
    case "five_hour":
      return "five_hour";
    case "seven_day":
    case "seven_day_overage_included":
      return "weekly";
    case "seven_day_opus":
    case "seven_day_sonnet":
      // Per-model weekly cap. Kept distinct from `weekly`: the owner can still
      // work on the other model, and collapsing the two would hide that.
      return "weekly_model";
    case "overage":
      return "overage";
    default:
      return "unknown";
  }
}

/** The shape this module reads out of the Agent SDK's `rate_limit_info`. */
export interface AnthropicRateLimitInfo {
  readonly status: string | null;
  readonly resetsAt: number | null;
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly errorCode: string | null;
}

/**
 * Read `rate_limit_info` off an untyped SDK payload.
 *
 * Defensive by design: the SDK object is `unknown` at this boundary because the
 * module was loaded dynamically, so every field is checked rather than trusted.
 * A field that is absent or the wrong type becomes null and is reported as such.
 */
export function readAnthropicRateLimitInfo(raw: unknown): AnthropicRateLimitInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const status = record["status"];
  const resetsAt = record["resetsAt"];
  const rateLimitType = record["rateLimitType"];
  const utilization = record["utilization"];
  const errorCode = record["errorCode"];
  return {
    status: typeof status === "string" ? status : null,
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
    rateLimitType: typeof rateLimitType === "string" ? rateLimitType : null,
    utilization: typeof utilization === "number" ? utilization : null,
    errorCode: typeof errorCode === "string" ? errorCode : null,
  };
}

/**
 * Turn Anthropic's structured rate-limit payload into {@link RateLimitState}.
 *
 * `status: 'allowed_warning'` produces `limited: false` WITH a utilization —
 * the window filling up, which the dashboard should show before it slams shut
 * rather than after.
 */
export function anthropicRateLimitState(
  info: AnthropicRateLimitInfo,
  nowMs: number = Date.now(),
): RateLimitState {
  const rejected = info.status === "rejected";
  const resetsAtIso = info.resetsAt === null ? null : resetsAtToIso(info.resetsAt, nowMs);
  const utilization = info.utilization === null ? null : normalizeUtilization(info.utilization);
  const kind: RateLimitKind =
    info.errorCode === "credits_required" ? "credits" : anthropicLimitKind(info.rateLimitType);

  const parts: string[] = [];
  parts.push(rejected ? "rate limit reached" : `rate-limit status ${info.status ?? "unreported"}`);
  parts.push(`window: ${info.rateLimitType ?? "unreported"}`);
  if (utilization !== null) parts.push(`${Math.round(utilization * 100)}% consumed`);
  parts.push(resetsAtIso === null ? "reset time not reported" : `resets at ${resetsAtIso}`);

  return {
    limited: rejected,
    kind,
    resetsAtIso,
    retryAfterSeconds: secondsUntil(resetsAtIso, nowMs),
    utilization,
    source: "rate_limit_event",
    detail: parts.join("; "),
  };
}

/** A rate-limit state inferred from an HTTP status. */
export function rateLimitFromHttpStatus(status: number, detail: string): RateLimitState | null {
  if (status !== 429) return null;
  return {
    limited: true,
    kind: "unknown",
    resetsAtIso: null,
    retryAfterSeconds: null,
    utilization: null,
    source: "http_status",
    detail: detail === "" ? "HTTP 429 from the provider" : detail,
  };
}

/** A rate-limit state inferred from `SDKAssistantMessageError === "rate_limit"`. */
export function rateLimitFromAssistantError(detail: string): RateLimitState {
  return {
    limited: true,
    kind: "unknown",
    resetsAtIso: null,
    retryAfterSeconds: null,
    utilization: null,
    source: "assistant_error",
    detail: detail === "" ? "the provider reported a rate limit for this turn" : detail,
  };
}

/**
 * Match text against a vendor's OWN exported prefix table.
 *
 * `prefixes` is read off the dynamically-loaded SDK module
 * (`USAGE_LIMIT_ERROR_PREFIXES` and friends), never copied into this file, so
 * the vendor stays the source of truth for its own wording.
 */
export function matchesVendorPrefix(text: string, prefixes: readonly string[]): boolean {
  const trimmed = text.trimStart();
  return prefixes.some((prefix) => prefix.length > 0 && trimmed.startsWith(prefix));
}

/** A rate-limit state from a vendor prefix-table hit. */
export function rateLimitFromVendorPrefix(text: string, limited: boolean): RateLimitState {
  return {
    limited,
    kind: /credit/i.test(text) ? "credits" : "unknown",
    resetsAtIso: null,
    retryAfterSeconds: null,
    utilization: null,
    source: "vendor_prefix",
    detail: text,
  };
}

/**
 * Patterns that mean "quota exhausted" in a free-text provider error.
 *
 * Used for CODEX ONLY, and only because Codex offers nothing better. Ordered
 * most specific first; `kind` comes from the first match.
 */
const TEXT_LIMIT_PATTERNS: readonly { readonly re: RegExp; readonly kind: RateLimitKind }[] =
  Object.freeze([
    { re: /\b5[\s-]?hour\b|\bfive[\s-]?hour\b/i, kind: "five_hour" },
    { re: /\bweekly\b|\bper[\s-]?week\b|\b7[\s-]?day\b|\bseven[\s-]?day\b/i, kind: "weekly" },
    { re: /\bcredit(s)?\b/i, kind: "credits" },
    { re: /\busage limit\b/i, kind: "unknown" },
    { re: /\brate[\s_-]?limit(ed|s)?\b/i, kind: "unknown" },
    { re: /\bquota\b/i, kind: "unknown" },
    { re: /\btoo many requests\b/i, kind: "unknown" },
    { re: /\b429\b/, kind: "unknown" },
  ]);

/**
 * Retry-after, IF AND ONLY IF the text actually states one.
 *
 * Codex has never been observed emitting one. This exists so that if it ever
 * does, the value is used — and returns null every other time rather than
 * inventing a plausible wait.
 */
export function retryAfterFromText(text: string): number | null {
  const header = /retry[-\s_]?after[:\s]+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)?/i.exec(
    text,
  );
  const phrase =
    header ??
    /\b(?:try again|retry|resets?|available again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i.exec(
      text,
    );
  if (phrase === null) return null;
  const rawValue = phrase[1];
  if (rawValue === undefined) return null;
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (phrase[2] ?? "s").toLowerCase();
  const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  return Math.round(value * multiplier);
}

/**
 * Detect a rate limit in free-text provider output. CODEX'S ONLY OPTION.
 *
 * A 401 is deliberately NOT matched here: "not logged in" and "out of quota"
 * are different states with different remediations, and conflating them would
 * tell the owner to wait when they need to log in.
 */
export function rateLimitFromText(text: string, nowMs: number = Date.now()): RateLimitState | null {
  if (text.length === 0) return null;
  const hit = TEXT_LIMIT_PATTERNS.find((pattern) => pattern.re.test(text));
  if (hit === undefined) return null;

  const retryAfterSeconds = retryAfterFromText(text);
  const resetsAtIso =
    retryAfterSeconds === null ? null : new Date(nowMs + retryAfterSeconds * 1000).toISOString();

  return {
    limited: true,
    kind: hit.kind,
    resetsAtIso,
    retryAfterSeconds,
    utilization: null,
    source: "message_text",
    detail: text,
  };
}

/** Rank of a signal's trustworthiness. Higher wins in {@link mergeRateLimitState}. */
const SIGNAL_RANK: Readonly<Record<RateLimitSignal, number>> = Object.freeze({
  rate_limit_event: 5,
  assistant_error: 4,
  http_status: 3,
  vendor_prefix: 2,
  message_text: 1,
});

function rank(state: RateLimitState): number {
  return state.source === null ? 0 : SIGNAL_RANK[state.source];
}

/**
 * Combine two observations of the same run.
 *
 * `limited: true` always beats `limited: false` — a window that closed did not
 * reopen because a later warning event said "allowed". Among two states with
 * the same `limited`, the better-sourced one wins, and a known reset instant is
 * carried across from the loser when the winner has none.
 */
export function mergeRateLimitState(
  previous: RateLimitState | null,
  next: RateLimitState,
): RateLimitState {
  if (previous === null) return next;
  if (previous.limited !== next.limited) {
    const winner = previous.limited ? previous : next;
    const other = previous.limited ? next : previous;
    return carryOver(winner, other);
  }
  const winner = rank(next) >= rank(previous) ? next : previous;
  const other = winner === next ? previous : next;
  return carryOver(winner, other);
}

function carryOver(winner: RateLimitState, other: RateLimitState): RateLimitState {
  return {
    limited: winner.limited,
    kind: winner.kind === "unknown" ? other.kind : winner.kind,
    resetsAtIso: winner.resetsAtIso ?? other.resetsAtIso,
    retryAfterSeconds: winner.retryAfterSeconds ?? other.retryAfterSeconds,
    utilization: winner.utilization ?? other.utilization,
    source: winner.source,
    detail: winner.detail === "" ? other.detail : winner.detail,
  };
}

/**
 * Operator-facing summary. Never contains a fabricated wait.
 *
 * The "when it reopens was not reported" branch is the Codex case, and saying
 * so is the point.
 */
export function describeRateLimit(state: RateLimitState): string {
  if (!state.limited) {
    if (state.utilization === null) return "not rate limited";
    return `not rate limited (${Math.round(state.utilization * 100)}% of the window consumed)`;
  }
  const window =
    state.kind === "unknown" ? "a usage window" : `the ${state.kind.replace(/_/g, " ")} window`;
  if (state.resetsAtIso !== null) {
    const seconds = state.retryAfterSeconds;
    const wait = seconds === null ? "" : ` (about ${Math.ceil(seconds / 60)} min)`;
    return `${window} is exhausted; it reopens at ${state.resetsAtIso}${wait}. The run is preserved — resume it then.`;
  }
  return `${window} is exhausted and the provider did not report when it reopens. The run is preserved — resume it once the window rolls over.`;
}

/** Re-exported so callers need only this module for rate-limit handling. */
export { notRateLimited };
