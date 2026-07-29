/**
 * codex.ts — drives `@openai/codex-sdk` on the owner's personal ChatGPT
 * subscription.
 *
 * =========================================================================
 * CONSTRUCTED WITH NO `apiKey`. VERIFIED IN THE SDK'S OWN SOURCE.
 * =========================================================================
 *
 * `@openai/codex-sdk@0.145.0`, `dist/index.js`, in `CodexExec.run`:
 *
 *     if (args.apiKey) {
 *       env.CODEX_API_KEY = args.apiKey;
 *     }
 *
 * That is the ONLY place the SDK touches a credential. Pass no `apiKey` and the
 * spawned `codex` binary inherits the CLI's own login — the browser OAuth
 * session `codex login` writes under `CODEX_HOME` (default `~/.codex`). This
 * adapter never sets the option, and {@link CODEX_BILLED_ENV_NAMES} strips
 * `CODEX_API_KEY` from the child environment as well, so an inherited or
 * caller-supplied one cannot re-introduce billing.
 *
 * MEASURED, so the strip list is not guesswork: with `CODEX_HOME` pointed at an
 * empty directory and `OPENAI_API_KEY` set to a junk value, the CLI still
 * failed with *"Missing bearer or basic authentication in header"* — i.e. the
 * codex CLI at 0.145.0 does NOT read `OPENAI_API_KEY`. It is stripped anyway,
 * defensively, because a future version reading it would turn subscription runs
 * into billed ones with no local sign.
 *
 * =========================================================================
 * WHAT NOT-LOGGED-IN ACTUALLY LOOKS LIKE — OBSERVED, NOT ASSUMED
 * =========================================================================
 *
 * Running the SDK against an empty `CODEX_HOME` produced, in order:
 *
 *     {"type":"thread.started","thread_id":"019fa4c4-…"}      <- id issued FIRST
 *     {"type":"turn.started"}
 *     {"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 …"}
 *     …ten retries, five over WebSocket then five over HTTPS, ~20 seconds…
 *     {"type":"turn.failed","error":{"message":"unexpected status 401 …"}}
 *     then a THROWN Error: "Codex Exec exited with code 1: <stderr>"
 *
 * Three things follow, and all three are implemented:
 *
 *   1. A 401 is reported as `authStatus` `missing` with the login command — not
 *      as a crash, and not as a rate limit. They are different states with
 *      different remediations.
 *   2. The run STOPS at the first 401 instead of sitting through ten retries.
 *      Returning early from the `for await` calls `.return()` on the SDK's
 *      generator, whose `finally` kills the child process.
 *   3. `thread_id` is issued BEFORE the failure, so even a run that never
 *      reached the model has a resumable session id. It is emitted immediately.
 *
 * =========================================================================
 * CODEX REPORTS NOTHING STRUCTURED ABOUT RATE LIMITS
 * =========================================================================
 *
 * Every error channel it has is a free-text string. So rate limits are detected
 * by pattern, labelled `message_text` (the weakest {@link RateLimitSignal}), and
 * `retryAfterSeconds` stays `null` unless the text literally contains one. See
 * rate-limit.ts.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModuleLoader,
  RateLimitState,
  SubscriptionAdapter,
  SubscriptionAuthStatus,
  SubscriptionEvent,
  SubscriptionFailure,
  SubscriptionResumeOptions,
  SubscriptionRunOptions,
  SubscriptionUsage,
  ToolStatus,
} from "./types.js";
import { RESUME_CONTINUATION_PROMPT, defaultModuleLoader, emptyUsage } from "./types.js";
import { mergeRateLimitState, rateLimitFromText } from "./rate-limit.js";
import {
  asRecord,
  childEnv,
  describeThrown,
  isAbortError,
  mergeUsageField,
  nowIso,
  readNumber,
  readString,
  runCliProbe,
  safeText,
} from "./internal.js";

/** Typed as `string` so `import()` is not resolved at compile time. See types.ts. */
const CODEX_SDK_SPECIFIER: string = "@openai/codex-sdk";

/** The CLI the SDK spawns, and the binary the auth probe runs. */
export const CODEX_CLI_NAME = "codex";

export const CODEX_SDK_INSTALL_HINT = `npm install ${CODEX_SDK_SPECIFIER}`;

/** The exact command that clears a missing ChatGPT subscription login. */
export const CODEX_LOGIN_REMEDIATION =
  "Run `codex login` in a terminal and complete the browser sign-in; it stores the session under CODEX_HOME (default ~/.codex). Do NOT use `codex login --with-api-key` for this — that is the billed API path, and this adapter strips CODEX_API_KEY.";

/**
 * Stripped from the child environment.
 *
 * - `CODEX_API_KEY` — the SDK's own billing lever, verified in its source above.
 * - `OPENAI_API_KEY` — measured INERT for the codex CLI at 0.145.0 (see the file
 *   header). Stripped as forward cover, not because it is currently read.
 */
export const CODEX_BILLED_ENV_NAMES: readonly string[] = Object.freeze([
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
]);

/**
 * `codex login status` is PROSE. There is no `--json` — verified against
 * `codex login status --help` on 0.145.0, whose only options are `--config`,
 * `--enable`, `--disable` and `--help`.
 *
 * "Not logged in" was observed directly (exit code 0, that exact string). The
 * LOGGED-IN wording could NOT be observed: this machine has no `~/.codex/auth`
 * entry and `codex login status` reports "Not logged in" for the real home too.
 * So the positive branch is matched loosely and, when nothing matches, the
 * verdict is `unknown` rather than an optimistic pass — and `probe: "cli_text"`
 * records that the answer came from prose, so a CLI wording change degrades to
 * a question instead of to a confident wrong answer.
 */
const CODEX_NOT_LOGGED_IN_RE = /\bnot\s+logged\s+in\b/i;
const CODEX_API_KEY_LOGIN_RE = /\bapi[\s_-]?key\b/i;
const CODEX_LOGGED_IN_RE = /\blogged\s+in\b/i;

/** Construction seams. All optional; the defaults are the real thing. */
export interface CodexAdapterOptions {
  /** Override the SDK loader. Defaults to a dynamic import. */
  readonly loadModule?: ModuleLoader;
  /** Base environment. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `codex` binary for the auth probe. Defaults to PATH resolution. */
  readonly cliPath?: string;
  /** Passed to the SDK as `codexPathOverride`. */
  readonly codexExecutablePath?: string;
  /**
   * Run even when the workspace is not a git repository.
   *
   * Defaults to FALSE, which is the safe default rather than the convenient
   * one. Codex refuses to run outside a git repo so that whatever the agent
   * does to your files is recoverable; `skipGitRepoCheck` turns that off. This
   * adapter will not disable a data-loss guard on the caller's behalf without
   * being told to — it fails with `not_a_git_repo` and the `git init` command.
   */
  readonly allowNonGitWorkspace?: boolean;
  /** Replace the auth probe. DIAGNOSTIC AND TEST SEAM ONLY. See claude-agent.ts. */
  readonly authProbe?: () => Promise<SubscriptionAuthStatus>;
}

/** Minimal structural mirror of the SDK surface this adapter calls. */
interface CodexThread {
  readonly id: string | null;
  readonly runStreamed: (
    input: string,
    turnOptions?: Record<string, unknown>,
  ) => Promise<{ readonly events: AsyncIterable<unknown> }>;
}

interface CodexModule {
  readonly Codex: new (options?: Record<string, unknown>) => {
    readonly startThread: (options?: Record<string, unknown>) => CodexThread;
    readonly resumeThread: (id: string, options?: Record<string, unknown>) => CodexThread;
  };
}

function authStatusOf(
  state: SubscriptionAuthStatus["state"],
  probe: SubscriptionAuthStatus["probe"],
  detail: string,
  method: string | null = null,
): SubscriptionAuthStatus {
  return {
    provider: "openai",
    state,
    method,
    subscriptionTier: null,
    probe,
    detail,
    remediation: state === "authenticated" ? "" : CODEX_LOGIN_REMEDIATION,
  };
}

/**
 * Drives Codex over its SDK, on a personal ChatGPT subscription.
 *
 * One adapter instance drives one run at a time. `run()` and `resume()` never
 * throw; `authStatus()` never rejects.
 */
export class CodexAdapter implements SubscriptionAdapter {
  readonly provider = "openai" as const;
  readonly displayName = "Codex";
  readonly cliName = CODEX_CLI_NAME;

  readonly #loadModule: ModuleLoader;
  readonly #env: NodeJS.ProcessEnv;
  readonly #cliPath: string;
  readonly #codexExecutablePath: string | null;
  readonly #allowNonGitWorkspace: boolean;
  readonly #authProbe: (() => Promise<SubscriptionAuthStatus>) | null;

  #abort: AbortController | null = null;
  #cancelled = false;
  #running = false;
  #lastOptions: SubscriptionRunOptions | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.#loadModule = options.loadModule ?? defaultModuleLoader;
    this.#env = options.env ?? process.env;
    this.#cliPath = options.cliPath ?? CODEX_CLI_NAME;
    this.#codexExecutablePath = options.codexExecutablePath ?? null;
    this.#allowNonGitWorkspace = options.allowNonGitWorkspace ?? false;
    this.#authProbe = options.authProbe ?? null;
  }

  /**
   * Probe the ChatGPT login with `codex login status`. Local read; no quota.
   *
   * PROSE PARSE — see {@link CODEX_NOT_LOGGED_IN_RE}. `probe` is `"cli_text"`
   * so the weaker provenance travels with the verdict.
   */
  async authStatus(): Promise<SubscriptionAuthStatus> {
    if (this.#authProbe !== null) return this.#authProbe();

    const env = childEnv(this.#env, null, CODEX_BILLED_ENV_NAMES);
    const probe = await runCliProbe(this.#cliPath, ["login", "status"], env);

    if (probe.spawnProblem !== null) {
      return authStatusOf(
        "unavailable",
        "not_probed",
        `${probe.spawnProblem}. Install the Codex CLI and make sure "${this.#cliPath}" is on PATH.`,
      );
    }

    const text = `${probe.stdout}\n${probe.stderr}`.trim();

    // "Not logged in" is checked FIRST because it contains "logged in".
    if (CODEX_NOT_LOGGED_IN_RE.test(text)) {
      return authStatusOf("missing", "cli_text", "no ChatGPT login was found for the Codex CLI.");
    }
    if (CODEX_API_KEY_LOGIN_RE.test(text)) {
      return authStatusOf(
        "metered_key",
        "cli_text",
        "the Codex CLI is logged in with an API KEY, not a ChatGPT subscription. Runs on that path are BILLED per token, and this adapter reports no cost because a subscription run has none — so it refuses rather than spend silently.",
        "api_key",
      );
    }
    if (CODEX_LOGGED_IN_RE.test(text)) {
      return authStatusOf(
        "authenticated",
        "cli_text",
        "the Codex CLI reports an active ChatGPT login.",
        "chatgpt",
      );
    }
    if (probe.exitCode !== null && probe.exitCode !== 0) {
      return authStatusOf(
        "missing",
        "cli_text",
        `\`${this.#cliPath} login status\` exited ${probe.exitCode} without reporting a login.`,
      );
    }
    return authStatusOf(
      "unknown",
      "cli_text",
      `\`${this.#cliPath} login status\` produced output this adapter does not recognise, so the login state could not be read. Run it yourself to see what it says. It is NOT assumed to be usable.`,
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
          message: `cannot resume thread ${sessionId}: no run options were supplied and this adapter instance has none recorded.`,
          remediation:
            "Pass the SubscriptionResumeOptions persisted alongside the thread id. After a dashboard restart the in-memory ones are gone, which is exactly the case resume exists for.",
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
   * `for await`, which is the only shape the dashboard uses; worth knowing if
   * you ever hold the iterable without consuming it.
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

  async *#drive(
    prompt: string,
    opts: SubscriptionRunOptions,
    resumeThreadId: string | null,
  ): AsyncGenerator<SubscriptionEvent, void> {
    if (this.#running) {
      yield failEvent(
        {
          kind: "sdk_error",
          message: "this adapter is already driving a run.",
          remediation: "Call cancel() first, or use a second adapter instance.",
          authStatus: null,
          rateLimit: null,
          resumable: resumeThreadId !== null,
          usage: emptyUsage(),
        },
        resumeThreadId,
      );
      return;
    }

    this.#running = true;
    this.#cancelled = false;
    const abort = new AbortController();
    this.#abort = abort;

    let sessionId: string | null = resumeThreadId;
    let usage: SubscriptionUsage = emptyUsage();
    let rateLimit: RateLimitState | null = null;

    try {
      const workspaceProblem = await checkWorkspace(opts.workspaceDir);
      if (workspaceProblem !== null) {
        yield failEvent(
          {
            kind: "workspace",
            message: workspaceProblem,
            remediation: "Create the directory and pass its absolute path as workspaceDir.",
            authStatus: null,
            rateLimit: null,
            resumable: resumeThreadId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }

      // Codex's git guard, handled HERE rather than left to the CLI, so the
      // failure names the fix instead of arriving as a subprocess error string.
      const isGitRepo = await hasGitDir(opts.workspaceDir);
      if (!isGitRepo && !this.#allowNonGitWorkspace) {
        yield failEvent(
          {
            kind: "not_a_git_repo",
            message: `Codex refuses to run outside a git repository, and "${opts.workspaceDir}" is not one.`,
            remediation: `Run \`git init\` in ${opts.workspaceDir} (the dashboard normally does this when it creates the workspace), or construct the adapter with allowNonGitWorkspace: true — which disables a guard that exists so the agent's edits stay recoverable.`,
            authStatus: null,
            rateLimit: null,
            resumable: resumeThreadId !== null,
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
            message: `not signed in to a ChatGPT subscription: ${auth.detail}`,
            remediation: auth.remediation,
            authStatus: auth,
            rateLimit: null,
            resumable: resumeThreadId !== null,
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
            remediation: `${CODEX_SDK_INSTALL_HINT} — the SDK is deliberately NOT a dependency of this package: it pulls in the @openai/codex binary, and \`npm ci --omit=dev\` would ship that into the sealed scorer image.`,
            authStatus: auth,
            rateLimit: null,
            resumable: resumeThreadId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }
      const sdk = loaded;

      // NOTE THE ABSENT OPTION: no `apiKey`. See the file header.
      const codexOptions: Record<string, unknown> = {
        env: childEnv(this.#env, opts.envOverrides, CODEX_BILLED_ENV_NAMES),
      };
      if (this.#codexExecutablePath !== null) {
        codexOptions["codexPathOverride"] = this.#codexExecutablePath;
      }

      const threadOptions: Record<string, unknown> = {
        workingDirectory: opts.workspaceDir,
        sandboxMode: opts.autonomy === "read-only" ? "read-only" : "workspace-write",
        // No human is watching a dashboard run, so an approval prompt would
        // hang until the timeout with nobody able to answer it. The sandbox is
        // the control here, not the prompt.
        approvalPolicy: "never",
        // A build agent that cannot reach a package registry cannot install a
        // dependency, and every non-trivial ticket needs one. Granted only with
        // write autonomy, so a read-only inspection stays offline.
        networkAccessEnabled: opts.autonomy !== "read-only",
        skipGitRepoCheck: !isGitRepo,
      };
      if (opts.model !== null) threadOptions["model"] = opts.model;
      if (opts.effort !== null) threadOptions["modelReasoningEffort"] = opts.effort;

      let thread: CodexThread;
      try {
        const client = new sdk.Codex(codexOptions);
        thread =
          resumeThreadId === null
            ? client.startThread(threadOptions)
            : client.resumeThread(resumeThreadId, threadOptions);
      } catch (error) {
        yield failEvent(
          {
            kind: "cli_unavailable",
            message: `the Codex SDK could not start: ${describeThrown(error)}`,
            remediation: `Check that the "${this.#cliPath}" binary is installed and runnable.`,
            authStatus: auth,
            rateLimit: null,
            resumable: resumeThreadId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }

      // Codex has no system-prompt option, so an append is folded into the
      // turn text. Announced rather than done silently: it changes the prompt
      // the model sees, which is not the same as changing a system prompt.
      let input = prompt;
      if (opts.systemPromptAppend !== null) {
        input = `${opts.systemPromptAppend}\n\n---\n\n${prompt}`;
        yield {
          type: "warning",
          message:
            "Codex exposes no system-prompt option, so systemPromptAppend was prepended to the prompt text instead. The model sees it as part of the user turn.",
          at: nowIso(),
          sessionId,
        };
      }
      if (opts.maxTurns !== null) {
        yield {
          type: "warning",
          message: `Codex exposes no turn cap, so maxTurns (${opts.maxTurns}) was NOT applied. Use cancel() to bound the run.`,
          at: nowIso(),
          sessionId,
        };
      }

      const started = Date.now();
      const streamed = await thread.runStreamed(input, { signal: abort.signal });
      let sawTerminal = false;
      let finalText = "";

      for await (const raw of streamed.events) {
        const event = asRecord(raw);
        if (event === null) continue;
        const type = readString(event, "type");

        if (type === "thread.started") {
          const id = readString(event, "thread_id");
          if (id !== null) sessionId = id;
          yield {
            type: "session",
            model: opts.model,
            clientVersion: null,
            authMethod: auth.method,
            at: nowIso(),
            sessionId,
          };
          continue;
        }

        if (type === "turn.started") {
          yield { type: "turn_started", at: nowIso(), sessionId };
          continue;
        }

        if (type === "turn.completed") {
          sawTerminal = true;
          usage = mergeCodexUsage(usage, event["usage"]);
          yield { type: "usage", usage, at: nowIso(), sessionId };
          yield {
            type: "completed",
            outcome: {
              finalText,
              usage,
              // Codex reports no turn count anywhere in its event stream, so
              // this is null rather than a guess. Stated, not fixed.
              turns: null,
              durationMs: Date.now() - started,
              providerReportedError: false,
              resumable: sessionId !== null,
            },
            at: nowIso(),
            sessionId,
          };
          return;
        }

        if (type === "turn.failed") {
          sawTerminal = true;
          const detail = safeText(readString(asRecord(event["error"]) ?? {}, "message") ?? "");
          const authFailure = authStatusFromText(detail);
          if (authFailure !== null) {
            yield { type: "auth", status: authFailure, at: nowIso(), sessionId };
            yield failEvent(
              {
                kind: "auth",
                message: `the turn failed because the Codex CLI is not authenticated: ${detail}`,
                remediation: CODEX_LOGIN_REMEDIATION,
                authStatus: authFailure,
                rateLimit,
                resumable: sessionId !== null,
                usage,
              },
              sessionId,
            );
            return;
          }
          const limitState = rateLimitFromText(detail);
          if (limitState !== null) {
            rateLimit = mergeRateLimitState(rateLimit, limitState);
            yield { type: "rate_limit", state: limitState, at: nowIso(), sessionId };
          }
          yield failEvent(
            {
              kind: limitState === null ? "sdk_error" : "rate_limit",
              message: detail === "" ? "the turn failed and Codex reported no reason." : detail,
              remediation:
                limitState === null
                  ? "resume(threadId) continues from where it stopped."
                  : "Nothing is lost. Wait for the window to roll over, then resume(threadId).",
              authStatus: null,
              rateLimit,
              resumable: sessionId !== null,
              usage,
            },
            sessionId,
          );
          return;
        }

        if (type === "error") {
          // ThreadErrorEvent. Often a transient retry notice — the observed
          // 401 storm arrives as ten of these — so it is a warning UNLESS it
          // carries an auth or quota signal.
          const text = safeText(readString(event, "message") ?? "");
          const authFailure = authStatusFromText(text);
          if (authFailure !== null) {
            // STOP HERE. Returning calls .return() on the SDK's generator,
            // whose finally kills the child — which is what saves the ~20
            // seconds of retries measured in the file header.
            yield { type: "auth", status: authFailure, at: nowIso(), sessionId };
            yield failEvent(
              {
                kind: "auth",
                message: `the Codex CLI is not authenticated: ${text}`,
                remediation: CODEX_LOGIN_REMEDIATION,
                authStatus: authFailure,
                rateLimit,
                resumable: sessionId !== null,
                usage,
              },
              sessionId,
            );
            return;
          }
          const limitState = rateLimitFromText(text);
          if (limitState !== null) {
            rateLimit = mergeRateLimitState(rateLimit, limitState);
            yield { type: "rate_limit", state: limitState, at: nowIso(), sessionId };
          }
          yield { type: "warning", message: text, at: nowIso(), sessionId };
          continue;
        }

        if (type === "item.started" || type === "item.updated" || type === "item.completed") {
          for (const mapped of itemEvents(event, type, sessionId)) {
            // Codex's `turn.completed` carries ONLY `usage` — the agent's final
            // answer arrives earlier, as a completed `agent_message` item. (The
            // SDK's `finalResponse` field is on the non-streamed `Turn` and
            // never reaches this path.) So it is accumulated here. Leaving it
            // "" would make "the agent said nothing" indistinguishable from
            // "nobody collected it" — the same trade this module refuses for an
            // unreported token count.
            if (mapped.type === "message") finalText = mapped.text;
            yield mapped;
          }
          continue;
        }
      }

      if (this.#cancelled) {
        yield failEvent(cancelledFailure(usage, rateLimit, sessionId), sessionId);
        return;
      }
      if (!sawTerminal) {
        yield failEvent(
          {
            kind: "sdk_error",
            message: "Codex ended the event stream without completing or failing a turn.",
            remediation: "Re-run, or resume(threadId) if one was issued above.",
            authStatus: null,
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
      // The SDK's terminal throw is `Codex Exec exited with code N: <stderr>`,
      // with the whole stderr appended. Redacted before it is shown anywhere.
      const text = describeThrown(error);
      const authFailure = authStatusFromText(text);
      if (authFailure !== null) {
        yield failEvent(
          {
            kind: "auth",
            message: `the Codex CLI is not authenticated: ${text}`,
            remediation: CODEX_LOGIN_REMEDIATION,
            authStatus: authFailure,
            rateLimit,
            resumable: sessionId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }
      const gitProblem = /not (?:inside|in) a (?:trusted )?git (?:repo|repository)|git repo/i.test(
        text,
      );
      if (gitProblem) {
        yield failEvent(
          {
            kind: "not_a_git_repo",
            message: text,
            remediation: `Run \`git init\` in ${opts.workspaceDir}, or construct the adapter with allowNonGitWorkspace: true.`,
            authStatus: null,
            rateLimit,
            resumable: sessionId !== null,
            usage,
          },
          sessionId,
        );
        return;
      }
      const limitState = rateLimitFromText(text);
      if (limitState !== null) {
        rateLimit = mergeRateLimitState(rateLimit, limitState);
        yield { type: "rate_limit", state: limitState, at: nowIso(), sessionId };
        yield failEvent(
          {
            kind: "rate_limit",
            message: text,
            remediation:
              "Nothing is lost. Wait for the window to roll over, then resume(threadId).",
            authStatus: null,
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
          message: text,
          remediation: "Re-run, or resume(threadId) if one was issued above.",
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

  async #loadSdk(): Promise<CodexModule | string> {
    let loaded: unknown;
    try {
      loaded = await this.#loadModule(CODEX_SDK_SPECIFIER);
    } catch (error) {
      return `the "${CODEX_SDK_SPECIFIER}" package is not installed or could not be loaded: ${describeThrown(error)}`;
    }
    const record = asRecord(loaded);
    if (record === null || typeof record["Codex"] !== "function") {
      return `"${CODEX_SDK_SPECIFIER}" loaded but does not export a Codex class, so its API is not the one this adapter was written against.`;
    }
    return record as unknown as CodexModule;
  }
}

/* ------------------------------------------------------------------------
 * Pure helpers
 * --------------------------------------------------------------------- */

/**
 * A 401 or an explicit "not logged in", as opposed to a quota problem.
 *
 * Kept strictly apart from rate-limit detection: telling the owner to wait when
 * they need to log in wastes a five-hour window on a fixable problem.
 */
function authStatusFromText(text: string): SubscriptionAuthStatus | null {
  if (text === "") return null;
  const unauthorised =
    /\b401\b|unauthoriz|missing bearer|not logged in|invalid[ _-]?api[ _-]?key|authentication[ _]failed/i.test(
      text,
    );
  if (!unauthorised) return null;
  return authStatusOf(
    "missing",
    "sdk_error",
    `the Codex CLI could not authenticate to OpenAI: ${text}`,
  );
}

/** Map a thread item on to normalised events. */
function itemEvents(
  event: Record<string, unknown>,
  eventType: string,
  sessionId: string | null,
): readonly SubscriptionEvent[] {
  const item = asRecord(event["item"]);
  if (item === null) return [];
  const itemType = readString(item, "type");
  const at = nowIso();

  if (itemType === "agent_message") {
    if (eventType !== "item.completed") return [];
    const text = readString(item, "text");
    if (text === null || text.trim() === "") return [];
    return [{ type: "message", text: safeText(text), at, sessionId }];
  }

  if (itemType === "reasoning") {
    if (eventType !== "item.completed") return [];
    const text = readString(item, "text");
    if (text === null || text.trim() === "") return [];
    return [{ type: "reasoning", text: safeText(text), at, sessionId }];
  }

  if (itemType === "command_execution") {
    const status = readString(item, "status");
    return [
      {
        type: "tool",
        status: toolStatusOf(status, eventType),
        name: readString(item, "command") ?? "command",
        detail: safeText(readString(item, "aggregated_output") ?? "", 8000),
        toolUseId: readString(item, "id"),
        at,
        sessionId,
      },
    ];
  }

  if (itemType === "file_change") {
    if (eventType !== "item.completed") return [];
    const changes = item["changes"];
    const paths: string[] = [];
    if (Array.isArray(changes)) {
      for (const rawChange of changes) {
        const change = asRecord(rawChange);
        if (change === null) continue;
        const path = readString(change, "path");
        if (path !== null) paths.push(path);
      }
    }
    return [
      {
        type: "file_change",
        paths,
        applied: readString(item, "status") === "completed",
        at,
        sessionId,
      },
    ];
  }

  if (itemType === "mcp_tool_call") {
    const server = readString(item, "server") ?? "mcp";
    const tool = readString(item, "tool") ?? "tool";
    const error = asRecord(item["error"]);
    return [
      {
        type: "tool",
        status: toolStatusOf(readString(item, "status"), eventType),
        name: `${server}/${tool}`,
        detail: error === null ? "" : safeText(readString(error, "message") ?? ""),
        toolUseId: readString(item, "id"),
        at,
        sessionId,
      },
    ];
  }

  if (itemType === "web_search") {
    if (eventType !== "item.completed") return [];
    return [
      {
        type: "tool",
        status: "completed",
        name: "web_search",
        detail: safeText(readString(item, "query") ?? ""),
        toolUseId: readString(item, "id"),
        at,
        sessionId,
      },
    ];
  }

  if (itemType === "error") {
    // ErrorItem is documented as NON-FATAL, so it is a warning. The fatal path
    // is turn.failed / the thread-level error event.
    const message = readString(item, "message");
    if (message === null) return [];
    return [{ type: "warning", message: safeText(message), at, sessionId }];
  }

  return [];
}

function toolStatusOf(itemStatus: string | null, eventType: string): ToolStatus {
  if (itemStatus === "failed") return "failed";
  if (itemStatus === "completed") return "completed";
  if (eventType === "item.started") return "started";
  return "updated";
}

/**
 * Read Codex's usage payload.
 *
 * Fields per the 0.145.0 type definitions: `input_tokens`,
 * `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
 * `reasoning_output_tokens`. An absent field stays null — never 0.
 *
 * WORTH KNOWING: `cache_write_input_tokens` exists here. STATUS.md section 1.3
 * records that "OpenAI reports no cache-write count" for the HTTP `OpenAIAdapter`
 * in src/adapters.ts, which costs those tokens at 1.00x rather than 1.25x. This
 * is a DIFFERENT transport — the codex CLI, not the Messages-format API — so it
 * does not settle that question, but it does show the count is not universally
 * absent from OpenAI's surfaces. Nothing here changes src/adapters.ts.
 */
function mergeCodexUsage(previous: SubscriptionUsage, raw: unknown): SubscriptionUsage {
  const record = asRecord(raw);
  if (record === null) {
    return {
      ...previous,
      shapeProblem:
        previous.shapeProblem ??
        "the turn reported no usage object, so token counts are unknown for this run.",
    };
  }
  const input = readNumber(record, "input_tokens");
  const cacheRead = readNumber(record, "cached_input_tokens");
  const cacheWrite = readNumber(record, "cache_write_input_tokens");
  const output = readNumber(record, "output_tokens");
  const reasoning = readNumber(record, "reasoning_output_tokens");

  const missing: string[] = [];
  if (input === null) missing.push("input_tokens");
  if (cacheRead === null) missing.push("cached_input_tokens");
  if (cacheWrite === null) missing.push("cache_write_input_tokens");
  if (output === null) missing.push("output_tokens");

  return {
    inputTokens: mergeUsageField(previous.inputTokens, input),
    cacheReadTokens: mergeUsageField(previous.cacheReadTokens, cacheRead),
    cacheWriteTokens: mergeUsageField(previous.cacheWriteTokens, cacheWrite),
    outputTokens: mergeUsageField(previous.outputTokens, output),
    reasoningTokens: mergeUsageField(previous.reasoningTokens, reasoning),
    shapeProblem:
      missing.length === 0
        ? previous.shapeProblem
        : `the provider did not report ${missing.join(", ")}; those counts are unknown, NOT zero.`,
  };
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
        : "resume(threadId) picks it up where it stopped; nothing was discarded.",
    authStatus: null,
    rateLimit,
    resumable: sessionId !== null,
    usage,
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

/** A `.git` entry directly in the workspace. A worktree file counts. */
async function hasGitDir(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function failEvent(failure: SubscriptionFailure, sessionId: string | null): SubscriptionEvent {
  return { type: "failed", failure, at: nowIso(), sessionId };
}

async function* onlyFailure(
  failure: SubscriptionFailure,
  sessionId: string | null,
): AsyncGenerator<SubscriptionEvent, void> {
  yield failEvent(failure, sessionId);
}
