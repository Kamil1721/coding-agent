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
 *   GET    /api/runs/:id/graph  -> RunGraphResponse   (additive; spec §9.2)
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

/**
 * The DESIGN lane's lock — the server's `ApiDesignLock`, mirrored by hand.
 *
 * NOTHING BUT `contract-parity.test.ts` COMPARES THIS WITH THE SERVER. The two
 * packages are separate TypeScript programs, so a field that exists on the
 * server and not here compiles clean on both sides, is serialised, arrives, and
 * never renders. That test reads this file as text and asserts every field
 * below by name; if you change one, change it there in the same commit.
 *
 * `mockups[].path` is an ABSOLUTE HOST PATH, like `screenshots[].path` — a
 * browser cannot open it. `src/lib/screenshots.ts` turns it into a URL on
 * `GET /api/runs/:id/screenshots/:file`, which is the route these images are
 * served by (spec §17.1: no new image route exists for this).
 */
export interface DesignLockState {
  /** The run is parked RIGHT NOW waiting for a mockup to be chosen. */
  readonly awaiting: boolean;
  readonly mockups: readonly Screenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
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
  /**
   * The DESIGN lane's lock, or `null` when this run has no DESIGN lane.
   *
   * THE NULL IS LOAD-BEARING AND IS NOT THE SAME AS AN EMPTY LOCK. `null` means
   * "no DESIGN lane on this run"; `{awaiting: false, locked: null}` means "the
   * lane ran and produced nothing to lock" — degraded, or failed. Render
   * different things for them; a run whose lane silently produced no mockups is
   * the case the whole lane's reporting exists to make visible.
   */
  readonly designLock: DesignLockState | null;
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
  /**
   * Who picks the mockup: the owner (`"ask"`) or `ui-designer` (`"auto"`).
   *
   * OPTIONAL HERE, REQUIRED-BUT-NULLABLE ON THE SERVER, the same asymmetry
   * `deploy` already has: a caller omits what it has no opinion about, and the
   * wire carries the absence. `api.ts` fills in `"auto"` for every dashboard
   * submission — read the comment there before removing it.
   */
  readonly designLock?: "auto" | "ask" | null;
}

export interface CreateRunResponse {
  readonly runId: string;
}

export interface OkResponse {
  readonly ok: true;
}

/* ------------------------------------------------------------------ */
/* The orchestration canvas — spec §9.1                                */
/*                                                                     */
/* THE SEVEN `graph_*` MEMBERS RIDE THE EXISTING SSE UNION. There is no */
/* second channel and there must never be one: total ordering against  */
/* `status`/`phase` is a CORRECTNESS requirement — an agent must not    */
/* show "running" inside a cancelled run — and the stream's `seq` gives */
/* it for free, along with resumability that already works.            */
/* ------------------------------------------------------------------ */

/**
 * Did the emitter KNOW which node this belongs to, or work it out?
 *
 * REQUIRED, NEVER OPTIONAL. Hook messages carry no task identity, so hook→agent
 * attribution is a server-side inference; the required field is what forces
 * every emitter to say so, and what lets the canvas draw an inferred edge
 * differently instead of lying. It marks a GUESSED edge — a WRONG node is never
 * sent at all, it is dropped on the server.
 */
export type GraphAttribution = "exact" | "inferred";

/** Delivery lane. Declared once, by the node itself, on `graph_agent`. */
export type RunLane = "spec" | "design" | "build" | "review" | "gate";

/** An agent's state IN THE CLI'S OWN WORDS. See `GraphNodeState` for the rest. */
export type GraphAgentState = "running" | "completed" | "failed" | "stopped";

/**
 * Raw SDK identifiers, FOR THE INSPECTOR ONLY — never identity.
 *
 * The server's redactor rewrites any 40+ character mixed-case-and-digit token to
 * one identical literal, and `task_id` has no documented length bound, so two
 * distinct agents can arrive carrying the same string. Node identity is the
 * short server-assigned `id`; nothing here is ever keyed on, on either side.
 */
export interface GraphSdkRef {
  readonly taskId: string;
  readonly toolUseId: string | null;
}

export interface GraphMcpServer {
  readonly name: string;
  readonly status: string;
}

/**
 * A node's state, including the one no emitter may claim.
 *
 * `unresolved` = the run ended while this agent still read `running`, and the
 * stream never said how it finished. NOT `failed`: a cancelled run's in-flight
 * agents did not fail, and `heldOutPass: null` is not `false` for the same
 * reason. Render it as "we stopped watching", never as an error.
 */
export type GraphNodeState = GraphAgentState | "unresolved";

/** Distinct names with a call count — NOT one pill per call. */
export interface GraphToolPill {
  readonly name: string;
  readonly mcpServer: string | null;
  readonly count: number;
}

export interface GraphSkillPill {
  readonly skill: string;
  readonly source: "preloaded" | "invoked";
  readonly count: number;
}

export interface GraphHookPill {
  readonly event: string;
  readonly tool: string;
  readonly decision: "allow" | "deny";
  readonly count: number;
}

export interface GraphResult {
  readonly state: GraphAgentState;
  readonly summary: string;
  readonly totalTokens: number | null;
  readonly toolUses: number | null;
  readonly durationMs: number | null;
}

export interface GraphNode {
  readonly id: string;
  readonly parent: string | null;
  readonly agent: string | null;
  readonly lane: RunLane | null;
  readonly description: string;
  readonly ambient: boolean;
  readonly state: GraphNodeState;
  readonly attribution: GraphAttribution;
  readonly sdk: GraphSdkRef | null;
  readonly tools: readonly GraphToolPill[];
  readonly skills: readonly GraphSkillPill[];
  readonly hooks: readonly GraphHookPill[];
  /** Every tool call, including ones whose name did not fit in `tools`. */
  readonly toolCalls: number;
  readonly result: GraphResult | null;
}

/** `attribution` is the CHILD's: an edge to a guessed parent renders differently. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly attribution: GraphAttribution;
}

export interface GraphInventory {
  readonly agents: number;
  readonly skills: number;
  readonly tools: number;
  readonly allowedAgents: readonly string[];
  readonly mcpServers: readonly GraphMcpServer[];
  readonly plugins: readonly string[];
  readonly model: string;
  readonly claudeCodeVersion: string;
  readonly environmentHash: string;
}

/**
 * The whole canvas as a value.
 *
 * `inventory: null` means NOTHING WAS RECORDED — never "the CLI reported
 * nothing". An old run folds to exactly this, which is why the canvas needs no
 * feature flag.
 */
export interface GraphState {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly inventory: GraphInventory | null;
}

/**
 * `GET /api/runs/:id/graph` — snapshot, then subscribe.
 *
 * A WIRE-SIZE FIX, NOT A CPU ONE: a 32,000-row run is 7.01 MB of events but only
 * 22.7 ms to read. Fold this once, then open
 * `EventSource(/api/runs/:id/events?lastEventId=atSeq)`.
 *
 * `atSeq` IS A DURABLE WATERMARK — the seq of the last PERSISTED row that went
 * into the fold. The server replays from the same table, which is the only
 * reason the window between this response and the EventSource is not a race.
 */
export interface RunGraphResponse extends GraphState {
  readonly atSeq: number;
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
  | { readonly type: "status"; readonly status: RunStatus }
  /* ---- the orchestration canvas, spec §9.1 ---------------------------- */
  /**
   * A node exists. ALWAYS FIRST FOR ITS NODE — the invariant is that a node id
   * is never referenced before its `graph_agent`, which is why every event below
   * carries only `node` and none of them carries `lane`.
   *
   * `agent` is nullable because `subagent_type` is optional in the SDK's own
   * typing; the node is still real, its name simply was not reported.
   */
  | {
      readonly type: "graph_agent";
      readonly node: string;
      readonly parent: string | null;
      readonly agent: string | null;
      readonly lane: RunLane | null;
      readonly description: string;
      readonly ambient: boolean;
      readonly attribution: GraphAttribution;
      readonly sdk: GraphSdkRef | null;
    }
  | {
      readonly type: "graph_agent_status";
      readonly node: string;
      readonly state: GraphAgentState;
      readonly attribution: GraphAttribution;
    }
  /** An MCP call IS a tool call; `mcpServer` names the server, or is null. */
  | {
      readonly type: "graph_tool";
      readonly node: string;
      readonly name: string;
      readonly mcpServer: string | null;
      readonly summary: string;
      readonly attribution: GraphAttribution;
    }
  | {
      readonly type: "graph_skill";
      readonly node: string;
      readonly skill: string;
      readonly source: "preloaded" | "invoked";
      readonly attribution: GraphAttribution;
    }
  /** Always `attribution: "inferred"` — hook input carries no task identity. */
  | {
      readonly type: "graph_hook";
      readonly node: string;
      readonly event: string;
      readonly tool: string;
      readonly decision: "allow" | "deny";
      readonly reason: string;
      readonly attribution: GraphAttribution;
    }
  | {
      readonly type: "graph_result";
      readonly node: string;
      readonly state: GraphAgentState;
      readonly summary: string;
      /** Null when the CLI reported no usage. NOT 0, which is a claim. */
      readonly totalTokens: number | null;
      readonly toolUses: number | null;
      readonly durationMs: number | null;
      readonly attribution: GraphAttribution;
    }
  | {
      readonly type: "graph_inventory";
      readonly agents: number;
      readonly skills: number;
      readonly tools: number;
      /** The delegation shortlist. Visibility is not permission. */
      readonly allowedAgents: readonly string[];
      readonly mcpServers: readonly GraphMcpServer[];
      readonly plugins: readonly string[];
      readonly model: string;
      readonly claudeCodeVersion: string;
      readonly environmentHash: string;
    };

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
