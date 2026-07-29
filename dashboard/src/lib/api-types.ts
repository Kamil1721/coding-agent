/**
 * The FROZEN dashboard HTTP API contract, transcribed exactly.
 *
 * This file is the UI's only statement about the wire format. It is owned by
 * the contract, not by this module: do not widen, narrow or "improve" a shape
 * here to make a component easier to write. Nullable fields are `T | null`,
 * never optional `T?`, matching the harness house style.
 *
 *   POST   /api/runs            {ticketText, modelId, deploy?} -> {runId}
 *   GET    /api/runs            -> RunSummary[]   (newest first)
 *   GET    /api/runs/:id        -> RunDetail
 *   GET    /api/runs/:id/events -> text/event-stream
 *   POST   /api/runs/:id/cancel -> {ok:true}
 *   POST   /api/runs/:id/resume -> {ok:true}
 *   GET    /api/models          -> ModelOption[]
 *   GET    /api/health          -> {ok, claudeAuth, codexAuth}
 */

export type Provider = "anthropic" | "openai" | "moonshot" | "deepseek";

/** `included` = covered by a subscription, so NO dollar figure exists. */
export type ModelTier = "included" | "metered";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly provider: Provider;
  readonly tier: ModelTier;
  /** false => render disabled, with `reason` shown. */
  readonly available: boolean;
  readonly reason: string | null;
}

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "rate_limited"
  | "passed"
  | "failed"
  | "cancelled";

export interface RunSummary {
  readonly runId: string;
  readonly ticketTitle: string;
  readonly modelId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** null = not scored yet. NOT the same as false. */
  readonly heldOutPass: boolean | null;
  /** null = not scored yet. NOT the same as false. */
  readonly falseFinish: boolean | null;
}

export type RunPhase = "spec" | "build" | "gate" | "judge" | "done";

/**
 * Gating tier, from `bakeoff/src/contracts.ts` and research doc 02 section 5.4.
 * QUALITY is REPORTED, NEVER GATING — a failing QUALITY criterion must never be
 * rendered the way a failing BLOCKING criterion is.
 */
export type CriterionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";

export type CriterionResult = "pass" | "fail" | "pending";

export interface RunCriterion {
  readonly id: string;
  readonly statement: string;
  readonly tier: CriterionTier;
  readonly result: CriterionResult;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface RateLimitState {
  readonly limited: boolean;
  readonly retryAfterSec: number | null;
}

export interface Screenshot {
  readonly path: string;
  readonly label: string;
  readonly capturedAt: string;
}

export interface RunDetail extends RunSummary {
  readonly ticketText: string;
  readonly phase: RunPhase;
  readonly criteria: readonly RunCriterion[];
  readonly tokens: TokenCounts | null;
  /**
   * ALWAYS null for subscription runs — quota is consumed, not billed.
   * Never invent one. See `describeCost` in `src/lib/cost.ts` for the only
   * sanctioned way to turn this into pixels.
   */
  readonly costUsd: number | null;
  readonly rateLimit: RateLimitState | null;
  readonly screenshots: readonly Screenshot[];
  readonly artifactPath: string | null;
  readonly previewUrl: string | null;
  /**
   * Criteria the run was graded against that the OWNER DID NOT STATE — the
   * grader's guesses plus the house defaults. A pass against criteria nobody
   * wrote is the dangerous case, so this is the number to render beside a green
   * badge, not to hide behind one.
   *
   * 0 until the spec phase exits, and 0 then means zero, not "unknown".
   */
  readonly inferredCriteria: number;
  /**
   * Absolute HOST path to the run's `verdict.md`. Like `screenshots[].path` and
   * `artifactPath`, a browser cannot open it directly.
   *
   * EMPTY UNTIL THE RUN IS TERMINAL. `rate_limited` and `awaiting_input` are
   * stopped, not finished, so they carry no verdict; "" is "not written yet" and
   * never "written but missing".
   */
  readonly verdictPath: string;
}

export interface HealthState {
  readonly ok: boolean;
  readonly claudeAuth: "ok" | "missing";
  readonly codexAuth: "ok" | "missing";
}

export interface CreateRunRequest {
  readonly ticketText: string;
  readonly modelId: string;
  readonly deploy?: boolean;
}

export interface CreateRunResponse {
  readonly runId: string;
}

export interface OkResponse {
  readonly ok: true;
}

/* ------------------------------------------------------------------ */
/* SSE event shapes on /api/runs/:id/events                            */
/* ------------------------------------------------------------------ */

export type LogLevel = "info" | "warn" | "error";

export type RunEvent =
  | { readonly type: "phase"; readonly phase: RunPhase }
  | { readonly type: "log"; readonly level: LogLevel; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly summary: string }
  | {
      readonly type: "criterion";
      readonly id: string;
      readonly result: CriterionResult;
    }
  | { readonly type: "screenshot"; readonly path: string; readonly label: string }
  | ({ readonly type: "tokens" } & TokenCounts)
  | { readonly type: "rate_limit"; readonly retryAfterSec: number }
  /**
   * The run wrote its verdict. Emitted once, immediately before the terminal
   * `status` event. A path and a count; never the verdict's text.
   */
  | {
      readonly type: "verdict";
      readonly verdictPath: string;
      readonly inferredCriteria: number;
    }
  | { readonly type: "status"; readonly status: RunStatus };

export type RunEventType = RunEvent["type"];

/* ------------------------------------------------------------------ */
/* Runtime narrowing                                                   */
/* ------------------------------------------------------------------ */

/**
 * These sets exist so that a value arriving over the wire that is NOT in the
 * frozen union is treated as unknown-but-harmless rather than silently typed
 * as a member of it. The UI renders a neutral badge for an unrecognised value;
 * it never throws at the user, and it never guesses a mapping.
 */
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "awaiting_input",
  "rate_limited",
  "passed",
  "failed",
  "cancelled",
]);

const RUN_PHASES: ReadonlySet<string> = new Set([
  "spec",
  "build",
  "gate",
  "judge",
  "done",
]);

const CRITERION_TIERS: ReadonlySet<string> = new Set([
  "BLOCKING",
  "FUNCTIONAL",
  "QUALITY",
]);

export function isRunStatus(value: string): value is RunStatus {
  return RUN_STATUSES.has(value);
}

export function isRunPhase(value: string): value is RunPhase {
  return RUN_PHASES.has(value);
}

export function isCriterionTier(value: string): value is CriterionTier {
  return CRITERION_TIERS.has(value);
}

/** A run that will not change again without an explicit resume. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === "passed" || status === "failed" || status === "cancelled";
}

/**
 * A run that is stopped but resumable. `rate_limited` is an EXPECTED state on
 * a subscription plan, not an error: the 5-hour rolling window has to drain.
 * `awaiting_input` is stalled on something the frozen API exposes no channel
 * for, so the only moves are resume and cancel.
 */
export function isStalledStatus(status: RunStatus): boolean {
  return status === "rate_limited" || status === "awaiting_input";
}
