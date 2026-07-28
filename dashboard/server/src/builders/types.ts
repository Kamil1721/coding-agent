/**
 * builders/types.ts — the seam between the orchestrator and the two
 * subscription SDKs.
 *
 * Both builders are SUBPROCESS SDKs authenticated by the owner's own CLI
 * login. Neither takes an API key and neither is given one:
 *
 *   Anthropic — `@anthropic-ai/claude-agent-sdk`, `claude setup-token`.
 *   OpenAI    — `@openai/codex-sdk`. Verified by reading the SDK's own source:
 *               it spawns the `codex` binary and sets `CODEX_API_KEY` in the
 *               child environment ONLY when an `apiKey` option is passed.
 *               `CodexOptions.apiKey` is therefore never set here, and the CLI
 *               falls through to the `codex login` credentials in CODEX_HOME.
 *
 * A build is RESUMABLE by design, not as a nicety. Both providers enforce a
 * 5-hour rolling window plus a weekly cap; hitting one mid-build is expected.
 * Each driver returns the provider's session/thread id, which is persisted and
 * handed back on resume so the run continues its conversation rather than
 * starting the ticket again from nothing.
 */

import type { AnthropicEffort } from "bakeoff/dist/contracts.js";
import type { RunEnvironment } from "../build-environment.js";
import type { RateLimitState } from "../claude-common.js";
import type { TokenTotals } from "../tokens.js";

/** Everything a driver emits as it runs. Implemented by the orchestrator. */
export interface BuildEventSink {
  log(level: "info" | "warn" | "error", text: string): void;
  tool(name: string, summary: string): void;
  /** Cumulative token totals for this build's vendor. Never a cost. */
  tokens(totals: TokenTotals): void;
  rateLimit(state: RateLimitState): void;
  /** The provider's session/thread id, as soon as it is known. */
  session(id: string): void;
  /**
   * What the CLI reported it had loaded: agents, skills, tools, MCP servers,
   * plugins, plus a hash of all of them.
   *
   * REQUIRED, NOT OPTIONAL, for the same reason `allowedAgents` is: an optional
   * hook is one a driver can quietly not implement, and the thing it records —
   * everything `settingSources: ["user"]` dragged in — is the largest input a
   * build has that appears nowhere in the ticket. Two runs of a byte-identical
   * ticket can build different things; this is what says so.
   *
   * EMITTED ONCE, by the Anthropic driver, from `system/init`. The Codex driver
   * has no equivalent message and never calls it — which is honest: it loads no
   * such environment. A driver that emits nothing here is recorded as having no
   * environment, not as having an unknown one.
   */
  environment(environment: RunEnvironment): void;
  /** Raw transcript text for the run's build log file. */
  raw(text: string): void;
}

export interface BuildRequest {
  readonly runId: string;
  /** The builder prompt. Recorded verbatim to the run directory. */
  readonly prompt: string;
  /** The git-initialised workspace. The builder's cwd and its only write root. */
  readonly workspace: string;
  /**
   * Paths this build MUST NOT READ OR WRITE. Currently two:
   *
   *   1. the sealed suite store (`dashboard/acceptance`)
   *   2. the scorer's own output (`dashboard/results/scorer-out`), which
   *      persists `criterionCoverage[].testRefs` — held-out TEST TITLES —
   *      outside the sealed store, readable by any later run of the same
   *      frozen ticket.
   *
   * They are passed in so each driver can deny them explicitly rather than
   * relying on the builder not going looking. Read {@link SubscriptionBuilder}
   * and `dashboard/STATUS.md` "The held-out boundary" before trusting this: the
   * bake-off keeps the held-out half out of a container the builder cannot
   * escape; the dashboard builder runs on the HOST as the same user, so what is
   * here is a policy inside each CLI, not a filesystem boundary. The Anthropic
   * driver enforces it in two layers; the Codex driver has no mechanism for it
   * at all.
   */
  readonly sealedRoots: readonly string[];
  /**
   * THE DELEGATION BOUNDARY. The `subagent_type` values this build may pass to
   * the Agent/Task tool, and nothing else is reachable.
   *
   * AN EMPTY ARRAY DENIES ALL DELEGATION, BY DESIGN. Fail-closed is the default
   * state: a caller that forgets this field cannot compile, and a caller that
   * passes `[]` gets a build that does everything itself rather than one that
   * may reach for any of the 144 agents `settingSources: ["user"]` makes
   * visible. Visibility is not permission — `settingSources` decides what the
   * orchestrator can SEE, this decides what it may USE, and neither compensates
   * for the other being widened.
   *
   * Populated from `shortlistFor(surface)` (`src/agent-shortlist.ts`), which is
   * pure and synchronous precisely because it feeds a permission boundary.
   *
   * ENFORCED BY THE ANTHROPIC DRIVER ONLY, in its `canUseTool` Agent branch. The
   * Codex driver ignores it completely — it has no per-tool permission callback
   * and is out of scope for orchestration (spec 14) — so this is a policy inside
   * one CLI, exactly like {@link sealedRoots} above.
   */
  readonly allowedAgents: readonly string[];
  /** Catalog model id, as chosen in the UI. */
  readonly modelId: string;
  /** Effort rung, or null when the model has no effort parameter. */
  readonly effort: AnthropicEffort | null;
  /** Non-null on resume: continue this session instead of starting fresh. */
  readonly resumeSessionId: string | null;
  readonly signal: AbortSignal;
  readonly sink: BuildEventSink;
  readonly env: NodeJS.ProcessEnv;
}

export interface BuildOutcome {
  /** Session/thread id for resume. Null when the provider never reported one. */
  readonly sessionId: string | null;
  readonly tokens: TokenTotals;
  readonly rateLimit: RateLimitState;
  /** True when the SDK reached a terminal result of its own accord. */
  readonly completed: boolean;
  /** True when the abort signal ended it. Not a failure. */
  readonly cancelled: boolean;
  /** Redacted failure detail with remediation, or null. */
  readonly failure: string | null;
}

export interface SubscriptionBuilder {
  readonly provider: "anthropic" | "openai";
  build(request: BuildRequest): Promise<BuildOutcome>;
}
