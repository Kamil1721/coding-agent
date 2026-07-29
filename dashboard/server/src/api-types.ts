/**
 * api-types.ts — THE FROZEN HTTP CONTRACT.
 *
 * The UI builds against exactly these shapes. Nothing here may be widened,
 * narrowed or renamed without changing the UI in the same commit.
 *
 * ONE FIELD IS LOAD-BEARING AND EASY TO GET WRONG: `costUsd`.
 *
 * Dashboard runs are driven by SUBSCRIPTION-authenticated subprocess SDKs
 * (`claude setup-token`, `codex login`). A subscription consumes QUOTA; it is
 * not billed per token. There is therefore no dollar figure for a dashboard
 * run, and `costUsd` is `null` for every one of them. The Claude Agent SDK does
 * report `total_cost_usd` on its result message — that number is what the same
 * traffic WOULD have cost at API list price, not what the owner is charged, and
 * it is dropped at the SDK boundary (see builders/claude-builder.ts). Rendering
 * it would invent a bill that does not exist.
 *
 * What replaces it: token counts, which are real and are reported, and
 * rate-limit state, which is the constraint that actually binds.
 */

/** Providers the dashboard knows about. Mirrors `Provider` in contracts.ts. */
export type ApiProvider = "anthropic" | "openai" | "moonshot" | "deepseek";

/**
 * `included` — covered by a subscription the owner already pays for.
 * `metered`  — billed per token against an API key.
 */
export type ModelTier = "included" | "metered";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly provider: ApiProvider;
  readonly tier: ModelTier;
  /** False => the UI renders the option disabled and shows `reason`. */
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * Run lifecycle.
 *
 * `rate_limited` is NOT an error state. Both subscription providers enforce a
 * 5-hour rolling window plus a weekly cap; hitting one is an expected outcome
 * of a long build. The run is persisted, the session id is kept, and
 * `POST /api/runs/:id/resume` continues it.
 *
 * `awaiting_input` exists because doc 02 section 3d names
 * `PAUSED-AWAITING-HUMAN` as a first-class orchestrator state.
 */
export type ApiRunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "rate_limited"
  | "passed"
  | "failed"
  | "cancelled";

export type ApiPhase = "spec" | "build" | "gate" | "judge" | "done";

export type ApiCriterionResult = "pass" | "fail" | "pending";

/** Mirrors `CriterionTier` in contracts.ts. QUALITY is reported, never gating. */
export type ApiCriterionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";

export interface ApiCriterion {
  readonly id: string;
  readonly statement: string;
  readonly tier: ApiCriterionTier;
  readonly result: ApiCriterionResult;
}

export interface ApiTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ApiRateLimit {
  readonly limited: boolean;
  readonly retryAfterSec: number | null;
}

export interface ApiScreenshot {
  readonly path: string;
  readonly label: string;
  readonly capturedAt: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly ticketTitle: string;
  readonly modelId: string;
  readonly status: ApiRunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /**
   * CO-PRIMARY METRIC 1, from `computeHeldOutPass` in contracts.ts.
   * `null` means NOT DETERMINED — the sealed gate did not run (no Docker, run
   * cancelled, build never produced an artefact). A gate that could not run
   * must never be indistinguishable from a gate that passed.
   */
  readonly heldOutPass: boolean | null;
  /** CO-PRIMARY METRIC 2, from `deriveFalseFinish`. Null when undetermined. */
  readonly falseFinish: boolean | null;
}

export interface RunDetail extends RunSummary {
  readonly ticketText: string;
  readonly phase: ApiPhase;
  readonly criteria: readonly ApiCriterion[];
  readonly tokens: ApiTokens | null;
  /** ALWAYS null for a subscription run. See the file header. */
  readonly costUsd: number | null;
  readonly rateLimit: ApiRateLimit | null;
  readonly screenshots: readonly ApiScreenshot[];
  readonly artifactPath: string | null;
  readonly previewUrl: string | null;
  /**
   * Criteria this run was graded against that the owner did NOT state.
   *
   * The predicate is `Assumption.source !== "ticket"` — the grader's guesses AND
   * the house defaults — and it is the same one `verdict.ts` renders as "N of M
   * criteria were inferred rather than stated in your ticket". Two numbers under
   * one name is how an owner learns to distrust both, so `run-report.ts` owns
   * the single expression and `assumptions.md` splits it further into guesses
   * and defaults.
   *
   * 0 until the spec phase exits: nothing has been assumed yet, and 0 is then
   * the true count rather than a placeholder.
   */
  readonly inferredCriteria: number;
  /**
   * Absolute host path to `runs/<runId>/results/verdict.md`.
   *
   * EMPTY UNTIL THE RUN IS TERMINAL, and empty means "not written", not "not
   * found". A run that is still building, queued, or stopped on a rate limit has
   * no verdict yet — `rate_limited` is not terminal — and reporting a path to a
   * file that does not exist would be the same lie as reporting `heldOutPass:
   * false` for a gate that never ran.
   */
  readonly verdictPath: string;
}

/* -------------------------------------------------------------------------
 * SSE
 * ---------------------------------------------------------------------- */

export type SseEvent =
  | { readonly type: "phase"; readonly phase: ApiPhase }
  | { readonly type: "log"; readonly level: "info" | "warn" | "error"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly summary: string }
  | { readonly type: "criterion"; readonly id: string; readonly result: ApiCriterionResult }
  | { readonly type: "screenshot"; readonly path: string; readonly label: string }
  | {
      readonly type: "tokens";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
    }
  | { readonly type: "rate_limit"; readonly retryAfterSec: number | null }
  /**
   * The run wrote its verdict. Emitted once, immediately BEFORE the terminal
   * `status` event, so a client that revalidates on a terminal status already
   * finds `verdictPath` in the read model.
   *
   * Carries a path and a count and nothing else. The verdict's own content is a
   * file the UI can fetch; putting its text on the event stream would push
   * criterion prose through a second channel with a second set of rules.
   */
  | {
      readonly type: "verdict";
      readonly verdictPath: string;
      readonly inferredCriteria: number;
    }
  | { readonly type: "status"; readonly status: ApiRunStatus };

export type SseEventType = SseEvent["type"];

export interface HealthResponse {
  readonly ok: boolean;
  readonly claudeAuth: "ok" | "missing";
  readonly codexAuth: "ok" | "missing";
}

export interface CreateRunRequest {
  readonly ticketText: string;
  readonly modelId: string;
  readonly deploy: boolean | null;
}

export interface CreateRunResponse {
  readonly runId: string;
}

export interface OkResponse {
  readonly ok: true;
}

/** Every error body has this shape, and never contains a credential. */
export interface ApiErrorResponse {
  readonly error: string;
  readonly message: string;
  readonly remediation: string | null;
}
