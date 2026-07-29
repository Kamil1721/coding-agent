/**
 * SUBSCRIPTION ADAPTERS — the shared contract.
 *
 * =========================================================================
 * WHY THIS IS NOT `ProviderAdapter`
 * =========================================================================
 *
 * `src/contracts.ts` exports `ProviderAdapter`. It is the right shape for the
 * BAKE-OFF path and the wrong shape for this one, in three ways that are not
 * cosmetic:
 *
 *   | axis      | ProviderAdapter (bake-off)        | SubscriptionAdapter (dashboard) |
 *   |-----------|-----------------------------------|---------------------------------|
 *   | transport | HTTP, through the budget proxy    | a CLI SUBPROCESS the SDK spawns |
 *   | auth      | an API key, by env-var NAME       | an OAuth login held by the CLI  |
 *   | money     | priced; a ceiling in dollars      | UNPRICED; quota, not dollars    |
 *
 * `ProviderAdapter.requiredEnvNames()` would have to return `[]` — and a seat
 * that needs no credential is exactly what `preflight` treats as an error.
 * `worstCaseCallCostUsd()` would have to invent a dollar figure for a call that
 * is never billed. Forcing this path into that interface would not be a tidy
 * reuse; it would require both of those lies. So the two live side by side and
 * share nothing but `src/redact.ts`.
 *
 * =========================================================================
 * THE UNPRICED INVARIANT — enforced by the type system, not by convention
 * =========================================================================
 *
 * NOTHING in this file carries a cost, a price or a dollar figure, and nothing
 * downstream may add one. A run driven by the owner's personal Claude or ChatGPT
 * subscription consumes QUOTA. It is not billed per token, so there is no
 * dollar figure to report and inventing one would be fabrication.
 *
 * This is not hypothetical. `SDKResultSuccess.total_cost_usd` is a real field on
 * a real message the Anthropic Agent SDK really emits, and it is a MODELLED
 * API-equivalent price, not a bill. `claude-agent.ts` reads that message and
 * deliberately drops the field. {@link assertUnpriced} is the runtime backstop.
 *
 * What IS reported instead: token counts (per provider, never summed across
 * providers — `TOKEN_ACCOUNTING_RULE` in contracts.ts applies here too) and
 * {@link RateLimitState}.
 *
 * =========================================================================
 * NO METHOD ON THIS INTERFACE THROWS FOR AN EXPECTED CONDITION
 * =========================================================================
 *
 * Not logged in, rate limited, SDK not installed, workspace is not a git repo,
 * cancelled — every one of these is an EXPECTED state of a personal-subscription
 * tool, and every one is delivered as data:
 *
 *   - `authStatus()` resolves to a {@link SubscriptionAuthStatus}. It never rejects.
 *   - `run()` / `resume()` yield a terminal `failed` event. They never throw.
 *
 * A stack trace escaping into the dashboard would be a defect. A 429 in
 * particular is a NORMAL outcome: the run is preserved with its session id and
 * `resumable: true`, because losing four hours of agent work to a rolling
 * five-hour window would be the single most expensive bug this module could have.
 */

/**
 * Providers reachable through a personal subscription with no API key.
 *
 * A strict subset of `Provider` in contracts.ts. Moonshot and DeepSeek have no
 * subscription CLI, so they exist only in the `metered` tier of the registry.
 */
export type SubscriptionProvider = "anthropic" | "openai";

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = Object.freeze([
  "anthropic",
  "openai",
]);

/**
 * How much the agent may do to the workspace.
 *
 * The two SDKs do not offer the same dial, so this is a NAMED APPROXIMATION
 * rather than a shared setting. Each adapter documents its own mapping at the
 * point where it applies it, so a reader can see what was actually requested.
 */
export type Autonomy = "read-only" | "workspace-write";

/** Everything a run needs except the prompt, which `run()` takes separately. */
export interface SubscriptionRunOptions {
  /** Absolute path the agent works in. Must exist. */
  readonly workspaceDir: string;
  /** Vendor-native model id, or null for the CLI's own default. */
  readonly model: string | null;
  /**
   * Vendor-native reasoning-effort rung, or null for the CLI's default.
   *
   * RUNG NAMES ARE NOT COMPARABLE ACROSS VENDORS — the same warning that
   * `EFFORT_LADDERS` carries in contracts.ts. "high" on Codex and "high" on
   * Claude are two different settings that share a spelling.
   */
  readonly effort: string | null;
  /** Hard cap on agent turns, or null for the CLI's default. */
  readonly maxTurns: number | null;
  /** Text appended to the CLI's own system prompt, or null. */
  readonly systemPromptAppend: string | null;
  /** Workspace autonomy. See {@link Autonomy}. */
  readonly autonomy: Autonomy;
  /**
   * Extra environment for the spawned CLI, or null.
   *
   * MUST NOT carry a credential. Each adapter strips the variables that would
   * divert it off the subscription and on to a billed account, AFTER merging
   * these — an override cannot re-introduce one.
   */
  readonly envOverrides: Readonly<Record<string, string>> | null;
}

/**
 * Options for resuming. Adds the continuation turn.
 *
 * Both SDKs require an input turn to resume: `thread.run(input)` on Codex,
 * `query({prompt, options:{resume}})` on the Agent SDK. Neither has a
 * "just carry on with no new input" call. `prompt: null` therefore does not
 * mean "send nothing"; it means "send {@link RESUME_CONTINUATION_PROMPT}",
 * and that substitution is named here rather than hidden in an adapter.
 */
export interface SubscriptionResumeOptions extends SubscriptionRunOptions {
  readonly prompt: string | null;
}

/**
 * The continuation turn used when `resume()` is given no prompt.
 *
 * Deliberately minimal. A resumed run already holds the whole task in its
 * session history; a long re-statement here would compete with it.
 */
export const RESUME_CONTINUATION_PROMPT =
  "Continue the task from where you left off. Do not restart it.";

/**
 * Token counts for one run. PER PROVIDER, NEVER SUMMED ACROSS PROVIDERS.
 *
 * Every field is `number | null`, and `null` means THE PROVIDER DID NOT REPORT
 * IT. It is never rounded down to 0. That is the same discipline
 * `ProviderAdapter.normalizeUsage` enforces by throwing `invalid_usage_shape`;
 * the difference is the consequence. In the bake-off an unreported field
 * silently understates a BILL, so refusing to guess must cost a run. Here
 * nothing is billed, so refusing to guess costs a number on a dashboard — and
 * killing an hour of the owner's agent work over a missing token count would be
 * a far worse trade. So: record null, name the problem in `shapeProblem`, keep
 * the run.
 *
 * NOTE THE ABSENT FIELD: there is no cost. See the header of this file.
 */
export interface SubscriptionUsage {
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  /** Reasoning/thinking tokens where the provider reports them separately. */
  readonly reasoningTokens: number | null;
  /** Non-null when a usage payload arrived but did not have the expected shape. */
  readonly shapeProblem: string | null;
}

/** A usage row with nothing reported yet. Not zeroes — nulls. */
export function emptyUsage(): SubscriptionUsage {
  return {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    shapeProblem: null,
  };
}

/**
 * HOW an auth verdict was reached. Recorded so a wrong answer is traceable to
 * the thing that produced it, and so prose parsing can be told apart from a
 * structured read.
 *
 * - `cli_json`  — `claude auth status --json`. Structured. Authoritative.
 * - `cli_text`  — `codex login status`. PROSE. The Codex CLI has no `--json`
 *                 (verified against `codex login status --help`, 0.145.0), so
 *                 this one match is the whole verdict. A wording change must
 *                 degrade to `unknown`, never to a confident wrong answer.
 * - `sdk_event` — an authenticated signal inside a live run.
 * - `sdk_error` — inferred from a 401 raised during a run.
 * - `not_probed`— no probe ran (e.g. the SDK itself is missing).
 */
export type AuthProbe = "cli_json" | "cli_text" | "sdk_event" | "sdk_error" | "not_probed";

/**
 * - `authenticated` — a SUBSCRIPTION login is present. Not merely "some
 *   credential is present": see `detail` on the Anthropic adapter for why the
 *   distinction is load-bearing and expensive.
 * - `missing`       — no login. The remediation is the exact command to fix it.
 * - `metered_key`   — an API KEY is in force, so this path would be BILLED.
 *   Reported separately from `authenticated` on purpose. Treating it as
 *   authenticated is the one failure mode that spends real money while the UI
 *   shows no cost, because there is no cost to show for a subscription run.
 * - `unknown`       — the probe ran and its answer could not be interpreted.
 *   Never optimistically resolved.
 * - `unavailable`   — the probe could not run at all (CLI or SDK not installed).
 */
export type SubscriptionAuthState =
  | "authenticated"
  | "missing"
  | "metered_key"
  | "unknown"
  | "unavailable";

/**
 * The result of an auth probe.
 *
 * CARRIES NO PERSONAL DATA BY CONSTRUCTION. `claude auth status --json` returns
 * `email`, `orgId` and `orgName`; none of them is read into this object. That is
 * a construction-time omission, not a redaction pass — a value never read
 * cannot leak through a persistence path that forgot to redact.
 */
export interface SubscriptionAuthStatus {
  readonly provider: SubscriptionProvider;
  readonly state: SubscriptionAuthState;
  /** Vendor-native auth method (e.g. "claude.ai", "oauth_token"), or null. */
  readonly method: string | null;
  /** Subscription tier where reported (e.g. "max"). Useful for quota expectations. */
  readonly subscriptionTier: string | null;
  readonly probe: AuthProbe;
  /** One line for the operator. Redacted, and never carries an identity. */
  readonly detail: string;
  /** The exact command that clears a non-authenticated state. */
  readonly remediation: string;
}

/**
 * Which limit was hit.
 *
 * `five_hour` and `weekly` are the two windows the owner actually lives under.
 * `unknown` exists because Codex reports rate limits as unstructured prose and
 * guessing which window closed would be worse than saying so.
 */
export type RateLimitKind =
  | "five_hour"
  | "weekly"
  | "weekly_model"
  | "overage"
  | "credits"
  | "unknown";

/**
 * WHICH SIGNAL produced the verdict, so a false positive is traceable.
 *
 * - `rate_limit_event`   — the Agent SDK's structured `rate_limit_event`. Best.
 * - `assistant_error`    — its `SDKAssistantMessageError === "rate_limit"`.
 * - `http_status`        — an HTTP 429 reported by the SDK.
 * - `vendor_prefix`      — matched against the vendor's OWN exported prefix
 *                          table, read off the loaded module at runtime.
 * - `message_text`       — a pattern match on an error string. Weakest. It is
 *                          all Codex offers.
 */
export type RateLimitSignal =
  | "rate_limit_event"
  | "assistant_error"
  | "http_status"
  | "vendor_prefix"
  | "message_text";

/**
 * Rate-limit state. A 429 IS AN EXPECTED OUTCOME, not an error.
 *
 * `resetsAtIso` and `retryAfterSeconds` are `null` WHENEVER THE PROVIDER DID
 * NOT SAY. Codex supplies no retry-after at all — verified by inspecting every
 * error shape it can emit (`{type:"error",message}`, `turn.failed.error.message`
 * and the thrown `Codex Exec exited with code N`), none of which carries one.
 * Synthesising "probably an hour" would produce a dashboard countdown that is
 * confidently wrong, which is worse than a blank.
 */
export interface RateLimitState {
  readonly limited: boolean;
  readonly kind: RateLimitKind;
  /** When the window reopens, or null if the provider did not say. */
  readonly resetsAtIso: string | null;
  /** Seconds until retry, or null if the provider did not say. */
  readonly retryAfterSeconds: number | null;
  /** Fraction of the window consumed (0..1), or null if not reported. */
  readonly utilization: number | null;
  /** Which signal decided this. See {@link RateLimitSignal}. */
  readonly source: RateLimitSignal | null;
  /** Redacted operator-facing text. */
  readonly detail: string;
}

/** A rate-limit state meaning "not limited". */
export function notRateLimited(): RateLimitState {
  return {
    limited: false,
    kind: "unknown",
    resetsAtIso: null,
    retryAfterSeconds: null,
    utilization: null,
    source: null,
    detail: "",
  };
}

/** Lifecycle of a tool/command the agent ran. */
export type ToolStatus = "started" | "updated" | "completed" | "failed";

/**
 * Why a run ended badly.
 *
 * - `auth`               — not logged in. Carries the full `authStatus`.
 * - `rate_limit`         — quota exhausted. EXPECTED. `resumable` is true.
 * - `sdk_unavailable`    — the npm SDK is not installed. See the loader note
 *                          in claude-agent.ts / codex.ts.
 * - `cli_unavailable`    — the SDK is installed but the CLI binary it spawns
 *                          is not on PATH.
 * - `not_a_git_repo`     — Codex refuses to run outside a git repository.
 * - `unexpected_billing` — the session authenticated with an API KEY rather
 *                          than the subscription. Fatal ON PURPOSE: see
 *                          claude-agent.ts.
 * - `cancelled`          — `cancel()` was called. Not a fault.
 * - `workspace`          — the workspace directory is unusable.
 * - `sdk_error`          — the SDK failed for some other reason.
 */
export type SubscriptionFailureKind =
  | "auth"
  | "rate_limit"
  | "sdk_unavailable"
  | "cli_unavailable"
  | "not_a_git_repo"
  | "unexpected_billing"
  | "cancelled"
  | "workspace"
  | "sdk_error";

export interface SubscriptionFailure {
  readonly kind: SubscriptionFailureKind;
  /** Redacted. Never a stack trace. */
  readonly message: string;
  /** The exact operator action that clears this, or "" when there is none. */
  readonly remediation: string;
  /** Non-null when the failure is or implies an auth verdict. */
  readonly authStatus: SubscriptionAuthStatus | null;
  /** Non-null when a rate limit caused or accompanied the failure. */
  readonly rateLimit: RateLimitState | null;
  /**
   * Whether `resume(sessionId)` can pick this up. True requires a session id:
   * a rate limit with no session id is not resumable however expected it is.
   */
  readonly resumable: boolean;
  /** Token counts observed before the failure. */
  readonly usage: SubscriptionUsage;
}

/** A run that finished on its own terms. */
export interface SubscriptionOutcome {
  /** The agent's final message. Redacted. */
  readonly finalText: string;
  readonly usage: SubscriptionUsage;
  readonly turns: number | null;
  readonly durationMs: number | null;
  /** True when the provider ended the turn with an error flag set. */
  readonly providerReportedError: boolean;
  /** Whether this session can be continued with `resume()`. */
  readonly resumable: boolean;
}

/** Fields every event carries. */
export interface SubscriptionEventEnvelope {
  /** ISO-8601 instant, host clock. For display and ordering within one run. */
  readonly at: string;
  /**
   * Session id once the provider has issued one, else null.
   *
   * PERSIST THIS THE MOMENT IT IS NON-NULL. It is the only handle that makes a
   * rate-limited or crashed run resumable, and both SDKs issue it BEFORE the
   * first API call can fail — verified against Codex, which emits
   * `thread.started` with a thread_id and only then fails a 401.
   */
  readonly sessionId: string | null;
}

type Ev<T> = T & SubscriptionEventEnvelope;

/**
 * The normalised event set. Both SDKs are mapped on to exactly this.
 *
 * Terminal events are `failed` and `completed`; exactly one of them is the last
 * event of any run, including a run that could not start.
 */
export type SubscriptionEvent =
  /** The provider issued a session id. Persist it now. */
  | Ev<{
      readonly type: "session";
      readonly model: string | null;
      readonly clientVersion: string | null;
      /** Vendor-native description of how this session authenticated. */
      readonly authMethod: string | null;
    }>
  /** A turn began. */
  | Ev<{ readonly type: "turn_started" }>
  /** Reasoning/thinking summary text. Redacted. */
  | Ev<{ readonly type: "reasoning"; readonly text: string }>
  /** Assistant prose. Redacted. */
  | Ev<{ readonly type: "message"; readonly text: string }>
  /** A tool, command or MCP call. `detail` is redacted output, possibly "". */
  | Ev<{
      readonly type: "tool";
      readonly status: ToolStatus;
      readonly name: string;
      readonly detail: string;
      readonly toolUseId: string | null;
    }>
  /** Files the agent changed. */
  | Ev<{
      readonly type: "file_change";
      readonly paths: readonly string[];
      readonly applied: boolean;
    }>
  /** Token counts. May arrive more than once; the last one wins. */
  | Ev<{ readonly type: "usage"; readonly usage: SubscriptionUsage }>
  /**
   * Rate-limit state changed. Emitted for WARNINGS as well as rejections
   * (`limited: false` with a non-null `utilization` is the warning shape), so
   * the dashboard can show the window filling instead of only its slamming shut.
   */
  | Ev<{ readonly type: "rate_limit"; readonly state: RateLimitState }>
  /** An auth verdict was reached mid-run. */
  | Ev<{ readonly type: "auth"; readonly status: SubscriptionAuthStatus }>
  /** Non-fatal. The run continues. Redacted. */
  | Ev<{ readonly type: "warning"; readonly message: string }>
  /** TERMINAL. */
  | Ev<{ readonly type: "failed"; readonly failure: SubscriptionFailure }>
  /** TERMINAL. */
  | Ev<{ readonly type: "completed"; readonly outcome: SubscriptionOutcome }>;

/**
 * Drives one subscription-authenticated coding agent over its SDK.
 *
 * See the file header for why this is not `ProviderAdapter`, why nothing here
 * carries a cost, and why nothing here throws for an expected condition.
 */
export interface SubscriptionAdapter {
  readonly provider: SubscriptionProvider;
  /** For the UI, e.g. "Claude Code". */
  readonly displayName: string;
  /** The CLI binary the SDK spawns, e.g. "claude". For diagnostics. */
  readonly cliName: string;

  /**
   * Probe the login. Costs NOTHING and consumes no quota: both providers expose
   * a local status command that reads the same credential store the SDK reads.
   *
   * NEVER REJECTS. A failure to probe resolves to `unavailable`/`unknown`.
   */
  authStatus(): Promise<SubscriptionAuthStatus>;

  /**
   * Start a run.
   *
   * NEVER THROWS. Every failure arrives as a terminal `failed` event, so a
   * caller written as a plain `for await` cannot be broken by an expected
   * condition. One adapter drives one run at a time; starting a second run
   * while one is live yields a `failed` event rather than interleaving.
   */
  run(prompt: string, opts: SubscriptionRunOptions): AsyncIterable<SubscriptionEvent>;

  /**
   * Continue a previous session.
   *
   * `opts` may be omitted — `resume(sessionId)` reuses the options recorded by
   * the last `run()` on this adapter instance. After a dashboard restart there
   * are none, which is the case that matters most; pass the options persisted
   * alongside the session id. With neither, a `failed` event says exactly that.
   *
   * NEVER THROWS.
   */
  resume(sessionId: string, opts?: SubscriptionResumeOptions): AsyncIterable<SubscriptionEvent>;

  /**
   * Cancel the live run. Idempotent, and a no-op when nothing is running.
   *
   * The run then ends with `failed`/`cancelled` rather than by the iterator
   * simply stopping, so a cancelled run is distinguishable from a finished one
   * in whatever the dashboard persisted.
   */
  cancel(): void;
}

/**
 * How an adapter obtains its SDK module.
 *
 * NEITHER SDK IS A DEPENDENCY OF THIS PACKAGE, AND THAT IS DELIBERATE.
 * `docker/scorer.Dockerfile` builds the SEALED SCORER by running
 * `npm ci --omit=dev` and copying the result into the image whose integrity is
 * the whole experiment. `@openai/codex-sdk` depends on `@openai/codex`, so
 * adding it to `dependencies` would ship a coding-agent binary into that image
 * — against the Dockerfile's own stated inventory of what may go in. Adding it
 * to `devDependencies` instead would still force a `package-lock.json`
 * regeneration, and `npm ci` fails hard when the two files disagree, so a
 * mistake there makes the scorer image UNBUILDABLE.
 *
 * So the SDKs are loaded at run time, and a missing one is reported as
 * `sdk_unavailable` with the install command. Consequences worth knowing:
 * `npx tsc --noEmit` passes whether or not they are installed; the sealed
 * scorer image gains `dist/subscription/*.js` (inert — nothing in the scorer
 * calls it) and NO new dependency; and this seam is also what lets the smoke
 * test drive both adapters with no SDK and no credentials.
 */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

/**
 * Default loader: a plain dynamic import.
 *
 * The specifier is a `string`-typed parameter rather than a literal, so
 * TypeScript does not attempt to resolve the module at compile time. That is
 * load-bearing, not incidental: with a literal, `tsc` would fail with TS2307
 * on a tree where the SDK is not installed — which is this tree.
 */
export const defaultModuleLoader: ModuleLoader = (specifier: string): Promise<unknown> =>
  import(specifier) as Promise<unknown>;

/** Keys that would break the unpriced invariant. Used by {@link assertUnpriced}. */
const COST_KEY_PATTERN = /(cost|price|pricing|usd|dollar|billing|charge)/i;

/**
 * Runtime backstop for the unpriced invariant.
 *
 * The types already forbid a cost field, so this exists for the case the types
 * cannot see: a value widened to `unknown` somewhere, or a future edit that
 * spreads a raw SDK payload into an event. The Agent SDK's result message
 * really does carry `total_cost_usd`, so "we accidentally forwarded the vendor
 * object" is a live way to end up showing the owner a fabricated bill.
 *
 * Returns the offending key paths. Empty means clean.
 */
export function assertUnpriced(value: unknown, path = "$"): readonly string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => assertUnpriced(item, `${path}[${index}]`));
  }
  const found: string[] = [];
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const here = `${path}.${key}`;
    if (COST_KEY_PATTERN.test(key)) found.push(here);
    found.push(...assertUnpriced(record[key], here));
  }
  return found;
}
