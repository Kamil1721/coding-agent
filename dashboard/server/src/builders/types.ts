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
import type { GraphSseEvent } from "../api-types.js";
import type { CompactionRecord, ContextSample } from "../build-context.js";
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
  /**
   * How full the orchestrator's context window was when a lane went quiet.
   *
   * Sampled at lane boundaries rather than continuously: a boundary is where the
   * number is interpretable ("BUILD cost 60k") and polling would add turns of its
   * own. Emitted from Phase 1 even though nothing renders it until Phase 3 — the
   * data has to exist before the first long build, or that build is
   * unexplainable (spec 15.2, 15.4).
   */
  contextUsage(sample: ContextSample): void;
  /**
   * The context window was summarised to make room, and detail was lost.
   *
   * THE SINGLE BEST EXPLANATION for a run that produced mediocre output without
   * failing. It is not recoverable after the fact — the SDK says it once, in the
   * stream — so it is captured when it happens or not at all.
   */
  compaction(record: CompactionRecord): void;
  /**
   * One canvas event: an agent, its status, a tool, a skill, a hook decision, a
   * result, or the run's inventory (spec §9.1).
   *
   * TYPED AS `GraphSseEvent`, WHICH IS DERIVED FROM `SseEvent` RATHER THAN
   * WRITTEN OUT. A driver cannot post a `status` or a `tokens` event down this
   * seam, and a new `graph_*` member widens it automatically — a hand-written
   * list here would be a FOURTH declaration site of the union whose three
   * existing ones are the reason the type-level guard in `use-run-stream.ts`
   * exists at all.
   *
   * REQUIRED, NOT OPTIONAL, for the same reason `environment` is: an optional
   * hook is one a driver can quietly not implement, and the canvas then renders
   * empty with everything still compiling. The Codex driver has no equivalent
   * messages and calls it never, which is honest — it delegates to nothing.
   */
  graph(event: GraphSseEvent): void;
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
   * ENFORCED BY THE ANTHROPIC DRIVER ONLY, in its `PreToolUse` hook — not in
   * `canUseTool`, which probe A measured is consulted for no tool at all when the
   * model delegates. The Codex driver ignores this field completely (it has no
   * per-tool permission callback and is out of scope for orchestration, spec 14),
   * so this is a policy inside one CLI, exactly like {@link sealedRoots} above.
   *
   * IT BOUNDS WHICH AGENTS MAY START, NOT HOW MUCH WORK THEY RECEIVE. Measured:
   * `SendMessage` resumed a running agent with instructions no shortlist saw, so
   * that tool is denied outright in the same hook.
   */
  readonly allowedAgents: readonly string[];
  /**
   * Tool names this build may not use AT ALL, for a session whose entire job is
   * read-only. Absent means "deny nothing beyond what the driver already denies".
   *
   * IT IS SESSION-SCOPED, WHICH IS THE WHOLE REASON IT IS NOT ALWAYS SET. A build
   * that has to write the implementation cannot carry a denylist containing
   * `Write`; setting this on an ordinary build would disarm the builder. Its only
   * sensible caller is a session that IS one read-only agent from end to end —
   * the top-level adversary pass (`adversary.ts`, {@link
   * ADVERSARY_DISALLOWED_TOOLS}).
   *
   * IT IS THE ALTERNATIVE TO THE SHORTLIST ROUTE, NOT ITS COMPANION. There are
   * two ways to run `human-factors-adversary` and they carry the denylist
   * differently:
   *
   *   DELEGATED  its name is on `allowedAgents` (it is, for a web surface, since
   *              the Phase 2d follow-up put it in `DELIVERY_LANES.review`), the
   *              orchestrator spawns it through the Agent tool, and the denylist
   *              comes from the `disallowedTools:` frontmatter of
   *              ~/.claude/agents/human-factors-adversary.md — the channel probe I
   *              measured DOES bind for a name that exists on disk. This field is
   *              not involved.
   *   TOP-LEVEL  a whole `builder.build()` whose prompt is the adversary's. There
   *              is no agent file in play, so the denial has to ride on the
   *              request. That is this field.
   *
   * NO DRIVER READS IT YET, AND NO CALLER SETS IT. Said here rather than left to
   * be discovered. The Anthropic route would be session-level
   * `Options.disallowedTools` (it exists in the SDK typings); whether it binds is
   * UNMEASURED — probe G2 measured only the PER-AGENT `disallowedTools`, which did
   * not narrow anything — and measuring it costs a live subscription call. So the
   * carrier is declared and the mechanism is not claimed. Optional for the same
   * reason `NewRun.designLock` is: it lets the field land without every existing
   * caller changing in a file this wave does not own.
   */
  readonly disallowedTools?: readonly string[];
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
