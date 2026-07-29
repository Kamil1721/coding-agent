/**
 * auth.ts — is each subscription CLI logged in?
 *
 * NO API KEY IS EVER REQUIRED OR READ HERE, and none is accepted. Both
 * providers are driven by subprocess SDKs authenticated against the owner's
 * personal subscription:
 *
 *   Anthropic — `claude setup-token` / `claude auth login`, a long-lived OAuth
 *               token held by the Claude CLI (macOS: the login keychain, not a
 *               file, which is why probing the filesystem is the wrong check).
 *   OpenAI    — `codex login`, browser OAuth, credentials under CODEX_HOME.
 *
 * THE PROBE IS THE CLI'S OWN STATUS COMMAND, verified in this environment:
 *
 *   $ claude auth status        -> exit 0, JSON on stdout
 *   $ codex login status        -> exit 0 when logged in; exit 1 and
 *                                  "Not logged in" when not
 *
 * `claude auth status` also prints the account email, org id and org name.
 * NONE OF THAT IS RETURNED, PERSISTED OR LOGGED. Exactly one bit leaves this
 * module per provider. The email is not a credential, but it is not the
 * dashboard's to store either, and a status probe is a poor reason to start
 * keeping PII.
 *
 * TWO CORRECTIONS MADE BY THE INTEGRATOR, BOTH MEASURED ON THIS MACHINE.
 *
 * 1. THE PROBE MUST SEE THE SAME ENVIRONMENT THE RUN WILL GET. Measured, with
 *    an isolated empty CLAUDE_CONFIG_DIR:
 *
 *      CLAUDE_CONFIG_DIR=<empty>                     -> loggedIn:false, authMethod:"none"
 *      CLAUDE_CONFIG_DIR=<empty> ANTHROPIC_API_KEY=x -> loggedIn:true,  authMethod:"api_key"
 *
 *    An `ANTHROPIC_API_KEY` in the shell — which bakeoff's own `.env.example`
 *    asks the owner to set — therefore made an UNAUTHENTICATED machine report
 *    "logged in". Every build strips that variable (`subprocess-env.ts`), so
 *    `/api/health` said go, the model picker enabled the subscription models,
 *    and the build then failed mid-run on authentication. Health must probe
 *    through {@link subscriptionSubprocessEnv}, exactly like a build does.
 *
 * 2. `loggedIn` ALONE IS NOT THE ANSWER. `loggedIn:true` with
 *    `authMethod:"api_key"` is a BILLED session. The dashboard reports
 *    `costUsd: null` for every run and the UI says "Included in your plan", so
 *    accepting a billed identity here would be the fabrication this whole tree
 *    exists to avoid. The allowlist is bakeoff's own
 *    {@link ANTHROPIC_SUBSCRIPTION_AUTH_METHODS} — imported rather than
 *    re-spelled, because two independent notions of "this is a subscription"
 *    is how the two halves of a tree end up disagreeing.
 *
 * AN UNRECOGNISED `authMethod` READS AS MISSING, not as ok. The failure
 * direction here is silent spending, so the asymmetry is deliberate; the
 * observed value is named in the detail so a new auth mode surfaces as a
 * question rather than as either a silent pass or a mystery.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ANTHROPIC_SUBSCRIPTION_AUTH_METHODS } from "bakeoff/dist/subscription/claude-agent.js";
import { subscriptionSubprocessEnv } from "./subprocess-env.js";

const exec = promisify(execFile);

/** How long a probe result is reused. Health is polled; login state is not hot. */
export const AUTH_CACHE_MS = 10_000;

/** Probes are subprocess spawns; a hung CLI must not hang the health endpoint. */
export const AUTH_PROBE_TIMEOUT_MS = 20_000;

export type AuthState = "ok" | "missing";

export interface AuthStatus {
  readonly claude: AuthState;
  readonly codex: AuthState;
  /** Operator-facing detail. Never contains a token, an email or an org id. */
  readonly claudeDetail: string;
  readonly codexDetail: string;
  readonly checkedAt: string;
}

interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly claudeBin?: string;
  readonly codexBin?: string;
}

async function run(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(bin, [...args], {
      env,
      timeout: AUTH_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const code = typeof err.code === "number" ? err.code : 1;
    return { code, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

/** The one command that clears a missing Anthropic login. Quoted verbatim in the UI. */
export const CLAUDE_LOGIN_COMMAND = "claude setup-token";

/** The one command that clears a missing OpenAI login. Quoted verbatim in the UI. */
export const CODEX_LOGIN_COMMAND = "codex login";

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Anthropic. Reads TWO fields — `loggedIn` and `authMethod` — out of the status
 * JSON, and probes with the metered credentials stripped.
 *
 * A non-zero exit, unparseable output, or a missing `loggedIn` field all read
 * as "missing" rather than as an error: from the dashboard's point of view
 * "the CLI cannot tell me it is logged in" and "the CLI is not logged in" have
 * the same remedy, and inventing a third state would just be a second way to
 * say the same thing in the UI.
 */
export async function probeClaudeAuth(options: ProbeOptions = {}): Promise<{ state: AuthState; detail: string }> {
  // The SAME environment a build gets. Probing the raw environment answers a
  // question about a session the dashboard will never open.
  const env = subscriptionSubprocessEnv(options.env ?? process.env);
  const bin = options.claudeBin ?? "claude";
  const result = await run(bin, ["auth", "status", "--json"], env);

  // The JSON is read BEFORE the exit code is judged. Measured on CLI 2.1.220:
  // `claude auth status --json` exits 1 when there is no session while still
  // printing a complete status object. Treating a non-zero exit as the whole
  // answer would throw away `authMethod` — and `authMethod: "api_key"` is the
  // one state whose remedy is not "log in" but "remove the billed key".
  let record: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === "object" && parsed !== null) record = parsed as Record<string, unknown>;
  } catch {
    record = null;
  }
  if (record === null) {
    return {
      state: "missing",
      detail:
        `\`${bin} auth status --json\` exited ${String(result.code)} without a JSON status. ` +
        `Run \`${CLAUDE_LOGIN_COMMAND}\` (or \`claude auth login\`) in a terminal.`,
    };
  }

  if (record["loggedIn"] !== true) {
    return {
      state: "missing",
      detail: `Claude CLI reports no authenticated session. Run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal.`,
    };
  }

  const method = readString(record, "authMethod");
  if (method !== null && ANTHROPIC_SUBSCRIPTION_AUTH_METHODS.includes(method)) {
    return { state: "ok", detail: "Claude CLI reports an authenticated subscription session." };
  }
  if (method === "api_key") {
    return {
      state: "missing",
      detail:
        "Claude CLI is authenticated with an API KEY, not a subscription login. Every token on that " +
        "path is BILLED, and this dashboard reports no cost because a subscription run has none — so " +
        "it will not drive a billed session. Unset ANTHROPIC_API_KEY (and any apiKeyHelper in the " +
        `Claude settings), then run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal.`,
    };
  }
  return {
    state: "missing",
    detail:
      `Claude CLI reports authMethod ${JSON.stringify(method ?? "(absent)")}, which is not a method ` +
      "this dashboard has verified as subscription-backed. It is not accepted, because the failure " +
      `direction is silent spending. Run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal, or check ` +
      "`claude auth status --json` yourself.",
  };
}

/**
 * OpenAI. `codex login status` exits 1 and prints "Not logged in" when there
 * is no session — verified in this environment, where it is currently the
 * actual state.
 */
export async function probeCodexAuth(options: ProbeOptions = {}): Promise<{ state: AuthState; detail: string }> {
  // Same reason as the Anthropic probe: a build strips OPENAI_API_KEY and
  // CODEX_API_KEY, so the probe must not answer for a session holding them.
  const env = subscriptionSubprocessEnv(options.env ?? process.env);
  const bin = options.codexBin ?? "codex";
  const result = await run(bin, ["login", "status"], env);
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0 && !/not logged in/i.test(text)) {
    return { state: "ok", detail: "Codex CLI reports an authenticated subscription session." };
  }
  return {
    state: "missing",
    detail: `Codex CLI reports no authenticated session. Run \`${CODEX_LOGIN_COMMAND}\` in a terminal (browser OAuth).`,
  };
}

/** Both probes, with a short cache so `/api/health` polling is cheap. */
export class AuthProbe {
  #cached: AuthStatus | null = null;
  #cachedAtMs = 0;
  readonly #options: ProbeOptions;
  readonly #nowMs: () => number;

  constructor(options: ProbeOptions = {}, nowMs: () => number = Date.now) {
    this.#options = options;
    this.#nowMs = nowMs;
  }

  async status(force = false): Promise<AuthStatus> {
    const cached = this.#cached;
    if (!force && cached !== null && this.#nowMs() - this.#cachedAtMs < AUTH_CACHE_MS) return cached;

    const [claude, codex] = await Promise.all([
      probeClaudeAuth(this.#options),
      probeCodexAuth(this.#options),
    ]);
    const status: AuthStatus = {
      claude: claude.state,
      codex: codex.state,
      claudeDetail: claude.detail,
      codexDetail: codex.detail,
      checkedAt: new Date().toISOString(),
    };
    this.#cached = status;
    this.#cachedAtMs = this.#nowMs();
    return status;
  }

  /** Drop the cache — call it after a run fails on authentication. */
  invalidate(): void {
    this.#cached = null;
  }
}
