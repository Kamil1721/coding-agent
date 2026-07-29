/**
 * claude-agent.ts — drives `@anthropic-ai/claude-agent-sdk` on the owner's
 * personal Claude subscription.
 *
 * =========================================================================
 * NO API KEY. EVER. AND THE ENVIRONMENT IS SANITISED SO IT CANNOT SNEAK IN.
 * =========================================================================
 *
 * Auth is the long-lived OAuth login held by the Claude CLI (`claude
 * setup-token`, or a `claude auth login` session). No `apiKey` option is passed
 * and none is accepted.
 *
 * That is not sufficient on its own, and the reason is MEASURED, not assumed.
 * On this machine, with an empty config directory:
 *
 *     $ CLAUDE_CONFIG_DIR=<empty> claude auth status --json
 *     { "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" }
 *
 *     $ ANTHROPIC_API_KEY=<any value> CLAUDE_CONFIG_DIR=<empty> claude auth status --json
 *     { "loggedIn": true,  "authMethod": "api_key", "apiProvider": "firstParty",
 *       "apiKeySource": "ANTHROPIC_API_KEY" }
 *
 * READ THE SECOND ONE AGAIN. An `ANTHROPIC_API_KEY` in the ambient environment
 * makes an unauthenticated machine report `loggedIn: true` — and every token
 * spent under it is BILLED to the API account. This harness's README requires
 * `ANTHROPIC_API_KEY` for the bake-off campaign, so the owner's shell very
 * plausibly has one. A dashboard that inherited it would spend real money while
 * displaying no cost, because a subscription run HAS no cost to display. That
 * is the worst failure this module could have: silent spend behind a UI that is
 * telling the truth about the wrong thing.
 *
 * So `ANTHROPIC_API_KEY` is stripped from the child environment
 * ({@link ANTHROPIC_BILLED_ENV_NAMES}), after the caller's overrides are
 * merged, and `authStatus()` probes with the SAME sanitised environment — so
 * what it reports is what a run will actually do, not what the shell happens to
 * contain. `ANTHROPIC_AUTH_TOKEN` is deliberately KEPT: it was measured to
 * produce `authMethod: "oauth_token"`, which is a subscription login, not a
 * billed key.
 *
 * =========================================================================
 * THE AUTH PROBE IS A LOCAL READ, NOT AN API CALL
 * =========================================================================
 *
 * `claude auth status --json` reads the same credential store the SDK reads,
 * emits machine-readable JSON, consumes no quota and costs nothing. It is
 * `AuthProbe: "cli_json"`, the strongest probe either provider offers.
 *
 * IT RETURNS `email`, `orgId` AND `orgName`. None of the three is read into
 * {@link SubscriptionAuthStatus}. That is a construction-time omission rather
 * than a redaction pass: a value never read cannot escape through a persistence
 * path that forgot to redact it.
 */

import { stat } from "node:fs/promises";
import type {
  ModuleLoader,
  RateLimitState,
  SubscriptionAdapter,
  SubscriptionAuthStatus,
  SubscriptionEvent,
  SubscriptionFailure,
  SubscriptionFailureKind,
  SubscriptionResumeOptions,
  SubscriptionRunOptions,
  SubscriptionUsage,
} from "./types.js";
import { RESUME_CONTINUATION_PROMPT, defaultModuleLoader, emptyUsage } from "./types.js";
import {
  anthropicRateLimitState,
  matchesVendorPrefix,
  mergeRateLimitState,
  rateLimitFromAssistantError,
  rateLimitFromHttpStatus,
  rateLimitFromVendorPrefix,
  readAnthropicRateLimitInfo,
} from "./rate-limit.js";
import {
  asRecord,
  childEnv,
  describeThrown,
  isAbortError,
  mergeUsageField,
  nowIso,
  readNumber,
  readString,
  readStringArray,
  runCliProbe,
  safeText,
} from "./internal.js";

/**
 * The npm package. Typed as `string` rather than left as a literal ON PURPOSE:
 * with a literal, `import(SPECIFIER)` makes TypeScript resolve the module at
 * compile time and fail with TS2307 on a tree where it is not installed — which
 * is this tree, deliberately. See {@link ModuleLoader}.
 */
const AGENT_SDK_SPECIFIER: string = "@anthropic-ai/claude-agent-sdk";

/** The CLI the SDK spawns, and the binary the auth probe runs. */
export const CLAUDE_CLI_NAME = "claude";

/** How to install the SDK, quoted verbatim in the `sdk_unavailable` remediation. */
export const AGENT_SDK_INSTALL_HINT = `npm install ${AGENT_SDK_SPECIFIER}`;

/** The exact command that clears a missing Anthropic subscription login. */
export const CLAUDE_LOGIN_REMEDIATION =
  'Run `claude setup-token` (or `claude auth login`) in a terminal and complete the browser sign-in. It stores a long-lived OAuth token in the Claude CLI\'s own credential store. Do NOT set ANTHROPIC_API_KEY for this — that is the billed API path, and this adapter strips it.';

/**
 * Environment variables removed from the spawned CLI's environment because each
 * one can divert the run off the subscription and on to a BILLED account.
 *
 * - `ANTHROPIC_API_KEY` — measured above. Flips `authMethod` to `api_key`.
 * - `ANTHROPIC_BASE_URL` — points the CLI at a gateway. The harness README
 *   already records two community cost blowups caused by gateway bugs that
 *   silently broke prompt caching; on a subscription path a gateway can also
 *   route to a keyed upstream, which would bill without any local sign of it.
 *
 * NOT stripped: `ANTHROPIC_AUTH_TOKEN`, which was measured to produce
 * `authMethod: "oauth_token"` — a subscription login. Stripping it would break
 * the very path this adapter exists to drive.
 */
export const ANTHROPIC_BILLED_ENV_NAMES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
]);

/**
 * `authMethod` values from `claude auth status --json` that mean a SUBSCRIPTION.
 *
 * `"claude.ai"` was observed directly on this machine (a Max subscription);
 * `"oauth_token"` was observed by setting `ANTHROPIC_AUTH_TOKEN`. Both are OAuth
 * logins. `"api_key"` is deliberately absent — it is billed, and it maps to
 * {@link SubscriptionAuthState} `"metered_key"`.
 *
 * AN UNRECOGNISED VALUE IS NOT OPTIMISTICALLY ACCEPTED. It becomes `"unknown"`
 * with the observed value named in `detail`, so a new vendor auth mode shows up
 * as a question rather than as a silent pass.
 */
export const ANTHROPIC_SUBSCRIPTION_AUTH_METHODS: readonly string[] = Object.freeze([
  "claude.ai",
  "oauth_token",
]);

/**
 * `apiKeySource` values on the SDK's `system/init` message that mean the live
 * session is spending an API KEY rather than the subscription.
 *
 * Only these four fail the run. An absent or unrecognised value produces a
 * WARNING and the run continues — the asymmetry is deliberate. The pre-run
 * `claude auth status --json` gate is the real protection and it is structured
 * and verified; this is a second look at a field whose full value set has not
 * been observed here, so it must not be able to refuse a good session over a
 * value nobody has seen.
 */
const BILLED_API_KEY_SOURCES: readonly string[] = Object.freeze([
  "user",
  "project",
  "org",
  "temporary",
]);

/** Construction seams. All optional; the defaults are the real thing. */
export interface ClaudeAgentAdapterOptions {
  /** Override the SDK loader. Defaults to a dynamic import. */
  readonly loadModule?: ModuleLoader;
  /** Base environment. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `claude` binary for the auth probe. Defaults to PATH resolution. */
  readonly cliPath?: string;
  /** Passed to the SDK as `pathToClaudeCodeExecutable`. */
  readonly claudeExecutablePath?: string;
  /**
   * Replace the auth probe. DIAGNOSTIC AND TEST SEAM ONLY.
   *
   * It exists so the `sdk_unavailable` path can be exercised on a machine that
   * is not logged in, and the `auth` path on one that is — without credentials
   * either way. It is the same class of seam as `loadModule`. Nothing in
   * production should pass it: a probe that always says "authenticated" would
   * disable the gate described at the top of this file.
   */
  readonly authProbe?: () => Promise<SubscriptionAuthStatus>;
}

/** Minimal structural mirror of the ONE SDK function this adapter calls. */
interface AgentSdkModule {
  readonly query: (params: {
    prompt: string;
    options: Record<string, unknown>;
  }) => AsyncIterable<unknown>;
  /** The vendor's own wording tables, when the installed version exports them. */
  readonly USAGE_LIMIT_ERROR_PREFIXES?: readonly string[];
  readonly USAGE_WARNING_PREFIXES?: readonly string[];
  readonly ORG_POLICY_LIMIT_PREFIXES?: readonly string[];
}

function authStatusOf(
  state: SubscriptionAuthStatus["state"],
  probe: SubscriptionAuthStatus["probe"],
  detail: string,
  method: string | null = null,
  subscriptionTier: string | null = null,
): SubscriptionAuthStatus {
  return {
    provider: "anthropic",
    state,
    method,
    subscriptionTier,
    probe,
    detail,
    remediation: state === "authenticated" ? "" : CLAUDE_LOGIN_REMEDIATION,
  };
}

/**
 * Drives Claude Code over the Agent SDK, on a personal subscription.
 *
 * One adapter instance drives one run at a time. `run()` and `resume()` never
 * throw; `authStatus()` never rejects. See `types.ts` for why.
 */
export class ClaudeAgentAdapter implements SubscriptionAdapter {
  readonly provider = "anthropic" as const;
  readonly displayName = "Claude Code";
  readonly cliName = CLAUDE_CLI_NAME;

  readonly #loadModule: ModuleLoader;
  readonly #env: NodeJS.ProcessEnv;
  readonly #cliPath: string;
  readonly #claudeExecutablePath: string | null;
  readonly #authProbe: (() => Promise<SubscriptionAuthStatus>) | null;

  #abort: AbortController | null = null;
  #cancelled = false;
  #running = false;
  #lastOptions: SubscriptionRunOptions | null = null;

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.#loadModule = options.loadModule ?? defaultModuleLoader;
    this.#env = options.env ?? process.env;
    this.#cliPath = options.cliPath ?? CLAUDE_CLI_NAME;
    this.#claudeExecutablePath = options.claudeExecutablePath ?? null;
    this.#authProbe = options.authProbe ?? null;
  }

  /**
   * Probe the subscription login. Local read; consumes no quota; never rejects.
   *
   * Probed with the SAME sanitised environment a run uses, so the answer
   * describes what a run will do rather than what the shell contains.
   */
  async authStatus(): Promise<SubscriptionAuthStatus> {
    if (this.#authProbe !== null) return this.#authProbe();

    const env = childEnv(this.#env, null, ANTHROPIC_BILLED_ENV_NAMES);
    const probe = await runCliProbe(this.#cliPath, ["auth", "status", "--json"], env);

    if (probe.spawnProblem !== null) {
      return authStatusOf(
        "unavailable",
        "not_probed",
        `${probe.spawnProblem}. Install the Claude Code CLI and make sure "${this.#cliPath}" is on PATH.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(probe.stdout) as unknown;
    } catch {
      // The CLI answered but not in JSON. Do NOT fall back to matching prose:
      // a wrong "authenticated" here is the expensive direction.
      return authStatusOf(
        "unknown",
        "cli_json",
        `\`${this.#cliPath} auth status --json\` did not return JSON, so the login state could not be read. Run it yourself to see what it says.`,
      );
    }

    const record = asRecord(parsed);
    if (record === null) {
      return authStatusOf(
        "unknown",
        "cli_json",
        "the auth probe returned JSON that was not an object; the login state could not be read.",
      );
    }

    // Read exactly three fields. email / orgId / orgName are NOT read. See the
    // file header.
    const loggedIn = record["loggedIn"];
    const method = readString(record, "authMethod");
    const tier = readString(record, "subscriptionType");

    if (loggedIn !== true) {
      return authStatusOf(
        "missing",
        "cli_json",
        "no Claude subscription login was found on this machine.",
        method,
      );
    }
    if (method === "api_key") {
      return authStatusOf(
        "metered_key",
        "cli_json",
        "an Anthropic API KEY is configured, not a subscription login. Runs on this path would be BILLED per token, and this adapter reports no cost because a subscription run has none — so it refuses rather than spend silently. (ANTHROPIC_API_KEY from the environment is already stripped, so this key comes from a settings file or an apiKeyHelper.)",
        method,
        tier,
      );
    }
    if (method === null || !ANTHROPIC_SUBSCRIPTION_AUTH_METHODS.includes(method)) {
      return authStatusOf(
        "unknown",
        "cli_json",
        `the CLI reports it is logged in with authMethod "${method ?? "unreported"}", which is not a method this adapter has verified as subscription-backed. Not treated as usable, because the failure direction is silent spending.`,
        method,
        tier,
      );
    }

    return authStatusOf(
      "authenticated",
      "cli_json",
      `signed in with a Claude subscription (${method}${tier === null ? "" : `, ${tier} plan`}).`,
      method,
      tier,
    );
  }

  run(prompt: string, opts: SubscriptionRunOptions): AsyncIterable<SubscriptionEvent> {
    this.#lastOptions = opts;
    return this.#drive(prompt, opts, null);
  }

  resume(sessionId: string, opts?: SubscriptionResumeOptions): AsyncIterable<SubscriptionEvent> {
    const resolved = opts ?? this.#lastResumeOptions();
    if (resolved === null) {
      return onlyFailure(
        {
          kind: "sdk_error",
          message: `cannot resume session ${sessionId}: no run options were supplied and this adapter instance has none recorded.`,
          remediation:
            "Pass the SubscriptionResumeOptions that were persisted alongside the session id. After a dashboard restart the in-memory ones are gone, which is exactly the case resume exists for.",
          authStatus: null,
          rateLimit: null,
          resumable: true,
          usage: emptyUsage(),
        },
        sessionId,
      );
    }
    this.#lastOptions = resolved;
    return this.#drive(resolved.prompt ?? RESUME_CONTINUATION_PROMPT, resolved, sessionId);
  }

  /**
   * Cancel the live run. Idempotent; a no-op when nothing is running.
   *
   * `run()` returns a LAZY generator: its body does not start until the first
   * `next()`, so a `cancel()` issued before iteration begins has nothing to
   * cancel and is silently dropped. Harmless for a caller written as
   * `for await`, which is the only shape the dashboard uses.
   */
  cancel(): void {
    if (this.#abort === null) return;
    this.#cancelled = true;
    this.#abort.abort();
  }

  #lastResumeOptions(): SubscriptionResumeOptions | null {
    if (this.#lastOptions === null) return null;
    return { ...this.#lastOptions, prompt: null };
  }

  /**
   * The whole run, as a generator that NEVER THROWS.
   *
   * Order of the pre-flight gates is deliberate: workspace, then auth, then
   * SDK. Auth before SDK because "log in" is the answer the owner can act on
   * fastest, and because it is the gate that stops a billed session.
   */
  async *#drive(
    prompt: string,
    opts: SubscriptionRunOptions,
    resumeSessionId: string | null,
  ): AsyncGenerator<SubscriptionEvent, void> {
    if (this.#running) {
      yield failEvent(
        {
          kind: "sdk_error",
          message: "this adapter is already driving a run.",
          remediation: "Call cancel() first, or use a second adapter instance.",
          authStatus: null,
          rateLimit: null,
          resumable: resumeSessionId !== null,
          usage: emptyUsage(),
        },
        resumeSessionId,
      );
      return;
    }

    this.#running = true;
    this.#cancelled = false;
    const abort = new AbortController();
    this.#abort = abort;

    let sessionId: string | null = resumeSessionId;
    let usage: SubscriptionUsage = emptyUsage();
    let rateLimit: RateLimitState | null = null;
    let stderrTail = "";
    /**
     * An auth verdict reached DURING the run, which supersedes the pre-flight
     * one. Observed against the real SDK: with an empty config directory the
     * pre-flight gate can pass and the session still comes back
     * `authentication_failed` with the assistant saying "Not logged in · Please
     * run /login". Without this, the terminal failure reported `sdk_error` and
     * carried the STALE pre-flight status — so a dashboard reading only the
     * terminal event would say "inspect the message" instead of "log in".
     */
    let midRunAuth: SubscriptionAuthStatus | null = null;

    try {
      const workspaceProblem = await checkWorkspace(opts.workspaceDir);
      if (workspaceProblem !== null) {
        yield failEvent(
          {
            kind: "workspace",
            message: workspaceProblem,
            remediation: `Create the directory and pass its absolute path as workspaceDir.`,
            authStatus: null,
            rateLimit: null,
            resumable: resumeSessionId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }

      const auth = await this.authStatus();
      yield { type: "auth", status: auth, at: nowIso(), sessionId };
      if (auth.state !== "authenticated") {
        yield failEvent(
          {
            kind: "auth",
            message: `not signed in to a Claude subscription: ${auth.detail}`,
            remediation: auth.remediation,
            authStatus: auth,
            rateLimit: null,
            resumable: resumeSessionId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }

      const loaded = await this.#loadSdk();
      if (typeof loaded === "string") {
        yield failEvent(
          {
            kind: "sdk_unavailable",
            message: loaded,
            remediation: `${AGENT_SDK_INSTALL_HINT} — the SDK is deliberately NOT a dependency of this package, because adding it would change package-lock.json and the sealed scorer image is built with \`npm ci\`.`,
            authStatus: auth,
            rateLimit: null,
            resumable: resumeSessionId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }
      const sdk = loaded;

      const sdkOptions: Record<string, unknown> = {
        cwd: opts.workspaceDir,
        abortController: abort,
        permissionMode: permissionModeFor(opts.autonomy),
        env: childEnv(this.#env, opts.envOverrides, ANTHROPIC_BILLED_ENV_NAMES),
        stderr: (data: string): void => {
          stderrTail = safeText(`${stderrTail}${data}`.slice(-4000), 4000);
        },
      };
      if (opts.model !== null) sdkOptions["model"] = opts.model;
      if (opts.maxTurns !== null) sdkOptions["maxTurns"] = opts.maxTurns;
      if (this.#claudeExecutablePath !== null) {
        sdkOptions["pathToClaudeCodeExecutable"] = this.#claudeExecutablePath;
      }
      if (opts.systemPromptAppend !== null) {
        // The preset form APPENDS to Claude Code's own system prompt. A bare
        // string would REPLACE it, which would quietly remove the agent's
        // whole operating manual.
        sdkOptions["systemPrompt"] = {
          type: "preset",
          preset: "claude_code",
          append: opts.systemPromptAppend,
        };
      }
      if (resumeSessionId !== null) {
        sdkOptions["resume"] = resumeSessionId;
        // Continue the SAME session rather than branching it. A fork would give
        // the dashboard a second session id for one logical run, and the run
        // record would then point at a session that holds only half the work.
        sdkOptions["forkSession"] = false;
      }

      const started = Date.now();
      let sawTerminal = false;

      for await (const raw of sdk.query({ prompt, options: sdkOptions })) {
        const message = asRecord(raw);
        if (message === null) continue;

        const id = readString(message, "session_id");
        if (id !== null) sessionId = id;

        const type = readString(message, "type");

        if (type === "system" && readString(message, "subtype") === "init") {
          const apiKeySource = readString(message, "apiKeySource");
          yield {
            type: "session",
            model: readString(message, "model"),
            clientVersion: readString(message, "claude_code_version"),
            authMethod: apiKeySource,
            at: nowIso(),
            sessionId,
          };
          const billing = billingProblem(apiKeySource);
          if (billing !== null) {
            yield failEvent(
              {
                kind: "unexpected_billing",
                message: billing,
                remediation:
                  "Remove the API key from the Claude Code settings that supplied it, then sign in with `claude setup-token`. This adapter reports no cost because a subscription run has none; it will not run a session that is being billed.",
                authStatus: auth,
                rateLimit,
                resumable: sessionId !== null,
                usage,
              },
              sessionId,
            );
            this.cancel();
            return;
          }
          if (apiKeySource !== null && apiKeySource !== "oauth") {
            yield {
              type: "warning",
              message: `the session reports apiKeySource "${apiKeySource}", which this adapter has not verified as subscription-backed. Continuing, because the \`claude auth status --json\` gate already passed.`,
              at: nowIso(),
              sessionId,
            };
          }
          continue;
        }

        if (type === "rate_limit_event") {
          const info = readAnthropicRateLimitInfo(message["rate_limit_info"]);
          if (info !== null) {
            const state = anthropicRateLimitState(info);
            rateLimit = mergeRateLimitState(rateLimit, state);
            yield { type: "rate_limit", state, at: nowIso(), sessionId };
          }
          continue;
        }

        if (type === "assistant") {
          for (const event of assistantEvents(message, sessionId)) yield event;
          const assistantError = readString(message, "error");
          if (assistantError === "rate_limit") {
            const state = rateLimitFromAssistantError(
              "the provider rejected this turn for a rate limit",
            );
            rateLimit = mergeRateLimitState(rateLimit, state);
            yield { type: "rate_limit", state, at: nowIso(), sessionId };
          } else if (assistantError === "authentication_failed") {
            midRunAuth = authStatusOf(
              "missing",
              "sdk_error",
              "the provider rejected the session's credentials mid-run.",
            );
            yield { type: "auth", status: midRunAuth, at: nowIso(), sessionId };
          }
          continue;
        }

        if (type === "user") {
          for (const event of toolResultEvents(message, sessionId)) yield event;
          continue;
        }

        if (type === "auth_status") {
          const error = readString(message, "error");
          if (error !== null) {
            midRunAuth = authStatusOf("missing", "sdk_event", safeText(error));
            yield { type: "auth", status: midRunAuth, at: nowIso(), sessionId };
          }
          continue;
        }

        if (type === "result") {
          sawTerminal = true;
          usage = mergeAnthropicUsage(usage, message["usage"]);
          yield { type: "usage", usage, at: nowIso(), sessionId };

          const httpState = httpRateLimit(message);
          if (httpState !== null) rateLimit = mergeRateLimitState(rateLimit, httpState);

          const errors = readStringArray(message, "errors");
          const vendorState = vendorPrefixRateLimit(sdk, errors);
          if (vendorState !== null) rateLimit = mergeRateLimitState(rateLimit, vendorState);

          const subtype = readString(message, "subtype");
          const isError = message["is_error"] === true;
          const finalText = safeText(readString(message, "result") ?? "");

          if (subtype === "success" && !isError) {
            yield {
              type: "completed",
              outcome: {
                finalText,
                usage,
                turns: readNumber(message, "num_turns"),
                durationMs: readNumber(message, "duration_ms") ?? Date.now() - started,
                providerReportedError: false,
                resumable: sessionId !== null,
              },
              at: nowIso(),
              sessionId,
            };
            // NOTE: `total_cost_usd` is present on this very message and is
            // deliberately not read. It is a modelled API-equivalent price, not
            // a bill; a subscription run consumes quota. See types.ts.
            return;
          }

          const limited = rateLimit !== null && rateLimit.limited;
          // A mid-run auth verdict OUTRANKS the pre-flight one. It is the later
          // and more direct observation, and it is the difference between the
          // dashboard saying "log in" and saying "inspect the message".
          const authFailed = midRunAuth !== null;
          yield failEvent(
            {
              kind: authFailed ? "auth" : resultFailureKind(subtype, limited),
              message: safeText(
                errors.length > 0
                  ? errors.join("; ")
                  : finalText !== ""
                    ? finalText
                    : `the run ended with subtype "${subtype ?? "unreported"}"`,
              ),
              remediation: authFailed ? CLAUDE_LOGIN_REMEDIATION : resultRemediation(subtype, limited),
              authStatus: midRunAuth ?? auth,
              rateLimit,
              resumable: sessionId !== null,
              usage,
            },
            sessionId,
          );
          return;
        }
      }

      if (this.#cancelled) {
        yield failEvent(cancelledFailure(usage, rateLimit, sessionId), sessionId);
        return;
      }
      if (!sawTerminal) {
        // The SDK ended its stream without a result message. Reported rather
        // than papered over as a success: "it stopped" and "it finished" are
        // different outcomes, and only one of them means the work is done.
        yield failEvent(
          {
            kind: midRunAuth === null ? "sdk_error" : "auth",
            message: `the SDK ended the stream without a result message.${stderrTail === "" ? "" : ` Last stderr: ${stderrTail}`}`,
            remediation:
              midRunAuth === null
                ? "Re-run. If it repeats, run the same prompt through the `claude` CLI directly to see what the subprocess reports."
                : CLAUDE_LOGIN_REMEDIATION,
            authStatus: midRunAuth,
            rateLimit,
            resumable: sessionId !== null,
            usage,
          },
          sessionId,
        );
      }
    } catch (error) {
      if (this.#cancelled || isAbortError(error)) {
        yield failEvent(cancelledFailure(usage, rateLimit, sessionId), sessionId);
        return;
      }
      const text = describeThrown(error);
      const thrownAuth = authFailureFromText(text) ?? midRunAuth;
      if (thrownAuth !== null) {
        yield failEvent(
          {
            kind: "auth",
            message: text,
            remediation: CLAUDE_LOGIN_REMEDIATION,
            authStatus: thrownAuth,
            rateLimit,
            resumable: sessionId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }
      yield failEvent(
        {
          kind: "sdk_error",
          message: `${text}${stderrTail === "" ? "" : ` | stderr: ${stderrTail}`}`,
          remediation: "Re-run. The session id above can be resumed if one was issued.",
          authStatus: null,
          rateLimit,
          resumable: sessionId !== null,
          usage,
        },
        sessionId,
      );
    } finally {
      this.#running = false;
      this.#abort = null;
    }
  }

  /** Load and shape-check the SDK. Returns the module, or a problem string. */
  async #loadSdk(): Promise<AgentSdkModule | string> {
    let loaded: unknown;
    try {
      loaded = await this.#loadModule(AGENT_SDK_SPECIFIER);
    } catch (error) {
      return `the "${AGENT_SDK_SPECIFIER}" package is not installed or could not be loaded: ${describeThrown(error)}`;
    }
    const record = asRecord(loaded);
    if (record === null || typeof record["query"] !== "function") {
      return `"${AGENT_SDK_SPECIFIER}" loaded but does not export a query() function, so its API is not the one this adapter was written against.`;
    }
    return record as unknown as AgentSdkModule;
  }
}

/* ------------------------------------------------------------------------
 * Pure helpers
 * --------------------------------------------------------------------- */

/**
 * Map {@link Autonomy} on to a Claude Code permission mode.
 *
 * A NAMED APPROXIMATION, not an equivalence. `plan` is the closest the CLI
 * offers to read-only (it executes no tools), and `acceptEdits` is the closest
 * to Codex's `workspace-write`. Neither pair is identical, so the mapping is
 * written down here rather than assumed to be obvious.
 */
function permissionModeFor(autonomy: SubscriptionRunOptions["autonomy"]): string {
  return autonomy === "read-only" ? "plan" : "acceptEdits";
}

function billingProblem(apiKeySource: string | null): string | null {
  if (apiKeySource === null) return null;
  if (!BILLED_API_KEY_SOURCES.includes(apiKeySource)) return null;
  return `the live session authenticated with an API key (apiKeySource: "${apiKeySource}"), so every token would be BILLED. This adapter drives the personal subscription and reports no cost, so it will not proceed.`;
}

function resultFailureKind(subtype: string | null, limited: boolean): SubscriptionFailureKind {
  if (limited) return "rate_limit";
  if (subtype === "error_max_turns") return "sdk_error";
  return "sdk_error";
}

function resultRemediation(subtype: string | null, limited: boolean): string {
  if (limited) {
    return "Nothing is lost. Wait for the window to roll over, then resume(sessionId) — the session holds the work.";
  }
  if (subtype === "error_max_turns") {
    return "Raise maxTurns and resume(sessionId); the session holds the work done so far.";
  }
  return "Inspect the message above. resume(sessionId) continues from where it stopped.";
}

function cancelledFailure(
  usage: SubscriptionUsage,
  rateLimit: RateLimitState | null,
  sessionId: string | null,
): SubscriptionFailure {
  return {
    kind: "cancelled",
    message: "the run was cancelled.",
    remediation:
      sessionId === null
        ? ""
        : "resume(sessionId) picks it up where it stopped; nothing was discarded.",
    authStatus: null,
    rateLimit,
    resumable: sessionId !== null,
    usage,
  };
}

/** A 401 surfaced as a thrown error rather than as a message. */
function authFailureFromText(text: string): SubscriptionAuthStatus | null {
  if (!/\b401\b|unauthoriz|authentication[_ ]failed|invalid[ _]api[ _]key|not logged in/i.test(text)) {
    return null;
  }
  return authStatusOf(
    "missing",
    "sdk_error",
    `the provider rejected the session's credentials: ${text}`,
  );
}

function httpRateLimit(message: Record<string, unknown>): RateLimitState | null {
  const status = readNumber(message, "api_error_status");
  if (status === null) return null;
  return rateLimitFromHttpStatus(status, `the provider answered HTTP ${status}`);
}

/**
 * Match error strings against the SDK's OWN exported prefix tables.
 *
 * Read off the loaded module rather than copied here: a hard-coded copy of a
 * vendor's wording is wrong the day the vendor edits it, silently.
 * `USAGE_WARNING_PREFIXES` produces `limited: false` — the window filling, not
 * closed.
 */
function vendorPrefixRateLimit(sdk: AgentSdkModule, errors: readonly string[]): RateLimitState | null {
  const limitPrefixes = sdk.USAGE_LIMIT_ERROR_PREFIXES ?? [];
  const warningPrefixes = sdk.USAGE_WARNING_PREFIXES ?? [];
  for (const error of errors) {
    if (matchesVendorPrefix(error, limitPrefixes)) {
      return rateLimitFromVendorPrefix(safeText(error), true);
    }
    if (matchesVendorPrefix(error, warningPrefixes)) {
      return rateLimitFromVendorPrefix(safeText(error), false);
    }
  }
  return null;
}

/** Content blocks of an assistant message, as normalised events. */
function assistantEvents(
  message: Record<string, unknown>,
  sessionId: string | null,
): readonly SubscriptionEvent[] {
  const inner = asRecord(message["message"]);
  if (inner === null) return [];
  const content = inner["content"];
  if (!Array.isArray(content)) return [];

  const events: SubscriptionEvent[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null) continue;
    const blockType = readString(block, "type");
    if (blockType === "text") {
      const text = readString(block, "text");
      if (text !== null && text.trim() !== "") {
        events.push({ type: "message", text: safeText(text), at: nowIso(), sessionId });
      }
    } else if (blockType === "thinking") {
      const text = readString(block, "thinking");
      if (text !== null && text.trim() !== "") {
        events.push({ type: "reasoning", text: safeText(text), at: nowIso(), sessionId });
      }
    } else if (blockType === "tool_use") {
      events.push({
        type: "tool",
        status: "started",
        name: readString(block, "name") ?? "tool",
        detail: "",
        toolUseId: readString(block, "id"),
        at: nowIso(),
        sessionId,
      });
    }
  }
  return events;
}

/** Tool results arrive on `user` messages. */
function toolResultEvents(
  message: Record<string, unknown>,
  sessionId: string | null,
): readonly SubscriptionEvent[] {
  const inner = asRecord(message["message"]);
  if (inner === null) return [];
  const content = inner["content"];
  if (!Array.isArray(content)) return [];

  const events: SubscriptionEvent[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null) continue;
    if (readString(block, "type") !== "tool_result") continue;
    const isError = block["is_error"] === true;
    events.push({
      type: "tool",
      status: isError ? "failed" : "completed",
      name: "tool_result",
      detail: safeText(flattenToolResult(block["content"]), 4000),
      toolUseId: readString(block, "tool_use_id"),
      at: nowIso(),
      sessionId,
    });
  }
  return events;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const rawItem of content) {
    const item = asRecord(rawItem);
    if (item === null) continue;
    const text = readString(item, "text");
    if (text !== null) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Read Anthropic's usage payload.
 *
 * An absent field stays `null` — it is never recorded as 0. Anthropic reports
 * no separate reasoning-token count, so `reasoningTokens` is always null here;
 * that is the provider's shape, not a gap in this reader.
 */
function mergeAnthropicUsage(previous: SubscriptionUsage, raw: unknown): SubscriptionUsage {
  const record = asRecord(raw);
  if (record === null) {
    return {
      ...previous,
      shapeProblem:
        previous.shapeProblem ??
        "the result message carried no usage object, so token counts are unknown for this run.",
    };
  }
  const input = readNumber(record, "input_tokens");
  const output = readNumber(record, "output_tokens");
  const cacheRead = readNumber(record, "cache_read_input_tokens");
  const cacheWrite = readNumber(record, "cache_creation_input_tokens");

  const missing: string[] = [];
  if (input === null) missing.push("input_tokens");
  if (output === null) missing.push("output_tokens");
  if (cacheRead === null) missing.push("cache_read_input_tokens");
  if (cacheWrite === null) missing.push("cache_creation_input_tokens");

  return {
    inputTokens: mergeUsageField(previous.inputTokens, input),
    cacheReadTokens: mergeUsageField(previous.cacheReadTokens, cacheRead),
    cacheWriteTokens: mergeUsageField(previous.cacheWriteTokens, cacheWrite),
    outputTokens: mergeUsageField(previous.outputTokens, output),
    reasoningTokens: null,
    shapeProblem:
      missing.length === 0
        ? previous.shapeProblem
        : `the provider did not report ${missing.join(", ")}; those counts are unknown, NOT zero.`,
  };
}

async function checkWorkspace(dir: string): Promise<string | null> {
  if (dir === "") return "workspaceDir is empty.";
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return `workspaceDir "${dir}" is not a directory.`;
    return null;
  } catch {
    return `workspaceDir "${dir}" does not exist or is not readable.`;
  }
}

function failEvent(failure: SubscriptionFailure, sessionId: string | null): SubscriptionEvent {
  return { type: "failed", failure, at: nowIso(), sessionId };
}

/** An iterable whose only event is a terminal failure. */
async function* onlyFailure(
  failure: SubscriptionFailure,
  sessionId: string | null,
): AsyncGenerator<SubscriptionEvent, void> {
  yield failEvent(failure, sessionId);
}
