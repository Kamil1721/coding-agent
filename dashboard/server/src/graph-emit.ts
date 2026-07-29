/**
 * graph-emit.ts — SDK messages in, canvas events out.
 *
 * WHY THIS IS NOT IN THE MESSAGE LOOP. `builders/claude-builder.ts` records
 * being bitten twice by code that could only be REVIEWED: its `for await` loop
 * needs a real CLI, so anything written inline there is untested by
 * construction. Everything here is a pure transform of one envelope; the loop
 * keeps ONE call per branch, and those call sites are themselves driven by
 * synthetic envelopes through the injected `SessionFactory` (see "THE LOOP:
 * the canvas" in claude-builder.test.ts). Testing this class alone would rebuild
 * the exact hole that file's header describes — `recordResultTokens` was lifted
 * into a well-tested pure function and an auditor then reverted the CALL SITE
 * with the suite green at 229/227/0/2.
 *
 * THE ONE JOB THAT MATTERS: NODE IDENTITY. Ids are minted here — `n1`, `n2`, … —
 * and they are minted here because `redactForPersistence` rewrites any 40+
 * character mixed-case-and-digit token to the IDENTICAL literal
 * `[REDACTED:HIGH_ENTROPY_TOKEN]`. `task_id` has no documented length bound, so
 * a canvas keyed on raw SDK ids merges two distinct agents into one node the
 * moment two ids cross that threshold, silently, with everything still
 * rendering. Raw ids ride along under `sdk` for the inspector and are keyed on
 * by nothing.
 *
 * THE INVARIANT IS UPHELD HERE, NOT HOPED FOR: a node id is never referenced
 * before its `graph_agent` event, because every method that needs the root node
 * calls {@link GraphProjection.rootNode}, which EMITS the root's `graph_agent`
 * into the same output array the first time it is asked. `foldGraph` drops an
 * event naming an unknown node, so a violation would lose pills rather than
 * fabricate an agent — but the point is that there is nothing to drop.
 *
 * WHAT `attribution` MEANS ON EACH ROUTE, since the field is required precisely
 * so that nobody can leave the question open:
 *
 *   exact     the message itself carried the identity — `task_started` names its
 *             own `task_id`; an assistant turn with `parent_tool_use_id: null`
 *             IS the orchestrator's own turn; a non-null one that maps to a task
 *             we started is that task.
 *   inferred  we worked it out. An assistant turn whose `parent_tool_use_id` we
 *             never saw is attributed to the root, and a hook decision is
 *             attributed to the root because HOOK INPUT CARRIES NO TASK IDENTITY
 *             AT ALL. That is the case the field exists for.
 *
 * WHAT IS DROPPED RATHER THAN GUESSED: a `task_notification` for a task that was
 * never started. `attribution: "inferred"` marks a GUESSED edge; it cannot
 * launder a WRONG node, and pinning another agent's result onto the root would
 * be exactly that.
 */

import type {
  GraphAgentState,
  GraphAttribution,
  GraphSseEvent,
  ApiLane,
} from "./api-types.js";
import { laneOf } from "./agent-shortlist.js";
import { environmentHash } from "./build-environment.js";
import type { RunEnvironment } from "./build-environment.js";
import { summariseToolInput, truncate } from "./claude-common.js";

/**
 * The shape of `SDKTaskStartedMessage`, as far as this file cares.
 *
 * STRUCTURAL, like `InitEnvelope` and `TaskStartedEnvelope`: a real SDK message
 * satisfies it, and a CLI that stops sending an optional field degrades to a
 * less descriptive node instead of taking the run down while trying to DRAW it.
 */
export interface GraphTaskStarted {
  readonly task_id: string;
  readonly subagent_type?: string;
  /** The Agent tool_use block that spawned this task, when the CLI says. */
  readonly tool_use_id?: string;
  readonly description?: string;
  /** Ambient/housekeeping work the CLI asks hosts to hide by default. */
  readonly skip_transcript?: boolean;
}

/** The shape of `SDKTaskNotificationMessage`. Note: no `subagent_type`. */
export interface GraphTaskFinished {
  readonly task_id: string;
  /** The CLI's own word: `completed`, `failed` or `stopped`. */
  readonly status: string;
  readonly summary?: string;
  readonly usage?: {
    readonly total_tokens?: number;
    readonly tool_uses?: number;
    readonly duration_ms?: number;
  };
}

/**
 * The shape of `SDKAssistantMessage`, as far as this file cares.
 *
 * `parent_tool_use_id` is the ONLY identity an assistant turn carries — there is
 * no `task_id` on it — which is why tool attribution goes through the
 * tool_use-id map rather than reading a field.
 */
export interface GraphAssistantEnvelope {
  readonly parent_tool_use_id: string | null;
}

/** One `tool_use` content block. `id` is what a later `task_started` names. */
export interface GraphToolUse {
  readonly id: string | null;
  readonly name: string;
  readonly input: unknown;
}

/** A decision the in-process `PreToolUse` guard actually made. */
export interface GraphHookDecision {
  readonly event: string;
  readonly tool: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

/** The root node's label. It is the session, not a delegated agent. */
export const ROOT_AGENT = "orchestrator";

/**
 * Which states the CLI's own words map to.
 *
 * ANYTHING UNRECOGNISED BECOMES `stopped`, NOT `failed`. The CLI documents
 * `completed | failed | stopped`; a fourth word arriving from a newer CLI means
 * "it ended and we do not know how", and `stopped` is the member that says that
 * without inventing a failure.
 */
function stateOf(status: string): GraphAgentState {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

/**
 * The MCP server behind a tool name, or null.
 *
 * MCP IS NOT A SEPARATE EVENT TYPE (spec §9.1). An MCP call IS a `tool_use`
 * whose name matches `mcp__<server>__<tool>`, so the server is READ OFF THE NAME
 * rather than classified — there is no list to keep complete and nothing to get
 * wrong, which is the same argument that removed READ_TOOLS from the permission
 * guard. Non-greedy on the server half: measured names look like
 * `mcp__plugin_railway_railway__railway-agent`.
 */
export function mcpServerOf(toolName: string): string | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match?.[1] ?? null;
}

/** The skill a `Skill` tool call names, or null when it named none. */
export function skillOf(use: GraphToolUse): string | null {
  if (use.name !== "Skill") return null;
  const input = use.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const skill = (input as Record<string, unknown>)["skill"];
  return typeof skill === "string" && skill.length > 0 ? skill : null;
}

/**
 * Tools that can spawn a delegation, and whose block ids are therefore worth
 * remembering.
 *
 * BOUNDED ON PURPOSE. Remembering every `tool_use` block id would be an
 * unbounded map on a four-hour run; remembering only the blocks that can produce
 * a `task_started` keeps it at one entry per delegation. The membership test is
 * the same NAME-OR-SHAPE pair the delegation hook uses, for the same measured
 * reason: `mcp__plugin_railway_railway__railway-agent` matches no name we would
 * enumerate and carries `isolation`, while a schema-valid bare
 * `Agent{description, prompt}` carries no shape fields at all.
 */
function canSpawn(use: GraphToolUse): boolean {
  if (use.name === "Agent" || use.name === "Task") return true;
  const input = use.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  return "subagent_type" in input || "isolation" in input;
}

/** Bound on remembered delegation blocks. Far above any real run's count. */
const SPAWN_MEMORY = 512;

/**
 * The projection: SDK envelopes in, `graph_*` events out, node ids minted here.
 *
 * ONE INSTANCE PER BUILD. A resumed build gets a fresh one and mints from `n1`
 * again, which is why `foldGraph` IGNORES a repeated node id rather than
 * overwriting: the second `graph_agent` for `n1` would otherwise hand the
 * resumed session's root the first session's pills.
 */
export class GraphProjection {
  #next = 1;
  #root: string | null = null;
  /** task_id -> node. The one map the canvas's identity depends on. */
  readonly #byTask = new Map<string, string>();
  /** the task's own tool_use_id -> node, for attributing its assistant turns. */
  readonly #byToolUse = new Map<string, string>();
  /** a delegation-shaped tool_use block id -> the node that made the call. */
  readonly #spawnOrigin = new Map<string, string>();

  #mint(): string {
    const id = `n${String(this.#next)}`;
    this.#next += 1;
    return id;
  }

  /**
   * The run's own session, as a node — minted on demand, and ANNOUNCED into
   * `out` the first time, so nothing can reference it before its `graph_agent`.
   */
  rootNode(out: GraphSseEvent[]): string {
    const existing = this.#root;
    if (existing !== null) return existing;
    const node = this.#mint();
    this.#root = node;
    out.push({
      type: "graph_agent",
      node,
      parent: null,
      agent: ROOT_AGENT,
      lane: null,
      description: "the run's own session",
      ambient: false,
      // The session's existence is not a guess: this code is running inside it.
      attribution: "exact",
      sdk: null,
    });
    return node;
  }

  /**
   * The environment the CLI reported at `system/init`, as the inventory event —
   * and the root node, if it has not been announced yet.
   */
  session(environment: RunEnvironment, allowedAgents: readonly string[]): readonly GraphSseEvent[] {
    const out: GraphSseEvent[] = [];
    this.rootNode(out);
    out.push({
      type: "graph_inventory",
      agents: environment.agents.length,
      skills: environment.skills.length,
      tools: environment.tools.length,
      allowedAgents: [...allowedAgents],
      mcpServers: environment.mcpServers.map((server) => ({
        name: server.name,
        status: server.status,
      })),
      plugins: environment.plugins.map((plugin) => plugin.name),
      model: environment.model,
      claudeCodeVersion: environment.claudeCodeVersion,
      environmentHash: environmentHash(environment),
    });
    return out;
  }

  /**
   * A delegated agent started.
   *
   * A TASK WITH NO `subagent_type` STILL GETS A NODE, and that deliberately
   * diverges from `LaneWatch`, which skips it. The two are answering different
   * questions: a LANE would be a guess (which is why `LaneWatch` refuses), while
   * a NODE ID invents nothing — the task identity is present and exact, and the
   * agent name is simply reported as null. Skipping would blank the canvas
   * outright if a CLI version ever stopped sending the field, which is the
   * failure class this whole file is written against.
   */
  taskStarted(message: GraphTaskStarted): readonly GraphSseEvent[] {
    const out: GraphSseEvent[] = [];
    const known = this.#byTask.get(message.task_id);
    // A duplicate `task_started` (a resumed session replaying, a CLI retry) must
    // not mint a second node for the same task.
    if (known !== undefined) return out;

    const toolUseId = message.tool_use_id ?? null;
    const root = this.rootNode(out);
    // THE PARENT CHAIN IS EXACT WHERE IT CAN BE. `task_started.tool_use_id` names
    // the Agent block that spawned this task, and we recorded which node emitted
    // that block — so a subagent that delegates further is parented to the
    // subagent, not flattened onto the root.
    const spawned = toolUseId === null ? undefined : this.#spawnOrigin.get(toolUseId);
    const parent = spawned ?? root;
    const attribution: GraphAttribution = spawned === undefined ? "inferred" : "exact";

    const node = this.#mint();
    this.#byTask.set(message.task_id, node);
    if (toolUseId !== null) this.#byToolUse.set(toolUseId, node);

    const agent = message.subagent_type ?? null;
    const lane: ApiLane | null = agent === null ? null : laneOf(agent);
    out.push({
      type: "graph_agent",
      node,
      parent,
      agent,
      lane,
      description: truncate(message.description ?? "", 200),
      ambient: message.skip_transcript === true,
      attribution,
      // RAW IDS, FOR THE INSPECTOR ONLY. Nothing keys on them; see the header.
      sdk: { taskId: message.task_id, toolUseId },
    });
    out.push({ type: "graph_agent_status", node, state: "running", attribution: "exact" });
    return out;
  }

  /**
   * A delegated agent finished.
   *
   * A NOTIFICATION FOR A TASK WE NEVER SAW START IS DROPPED. That happens on a
   * resumed session, which replays nothing, and re-pointing it at the root would
   * put one agent's result on another agent's node. `attribution: "inferred"`
   * marks a guessed EDGE; it is not a licence to name the wrong node.
   */
  taskFinished(message: GraphTaskFinished): readonly GraphSseEvent[] {
    const node = this.#byTask.get(message.task_id);
    if (node === undefined) return [];
    const state = stateOf(message.status);
    const usage = message.usage;
    return [
      { type: "graph_agent_status", node, state, attribution: "exact" },
      {
        type: "graph_result",
        node,
        state,
        summary: truncate(message.summary ?? "", 300),
        // NULL, NOT ZERO, when the CLI reported no usage. Zero would read as "it
        // used no tokens", which is a claim the message never made.
        totalTokens: usage?.total_tokens ?? null,
        toolUses: usage?.tool_uses ?? null,
        durationMs: usage?.duration_ms ?? null,
        attribution: "exact",
      },
    ];
  }

  /**
   * The tool calls in one assistant turn.
   *
   * A `Skill` CALL PRODUCES BOTH EVENTS, and that is not double-counting: it IS
   * a tool call (so the node's `toolCalls` counts it) and it IS a skill
   * invocation (so the canvas can draw a skill pill). `source: "invoked"` is the
   * only value any producer emits — `Options.agents` was deleted after probe I
   * measured it not binding, so `AgentDefinition.skills` preloads nothing and
   * `"preloaded"` is currently unreachable. It stays in the union so that a
   * future preload does not have to be told apart from an invocation afterwards.
   */
  assistant(
    message: GraphAssistantEnvelope,
    uses: readonly GraphToolUse[],
  ): readonly GraphSseEvent[] {
    const out: GraphSseEvent[] = [];
    if (uses.length === 0) return out;
    const parentToolUseId = message.parent_tool_use_id;
    const root = this.rootNode(out);
    const owner = parentToolUseId === null ? root : this.#byToolUse.get(parentToolUseId);
    const node = owner ?? root;
    // `null` IS EXACT: an assistant turn with no parent tool use is the
    // orchestrator's own turn, by the SDK's own definition of the field. Only an
    // id we never saw is a guess.
    const attribution: GraphAttribution = owner === undefined ? "inferred" : "exact";

    for (const use of uses) {
      if (use.id !== null && canSpawn(use) && this.#spawnOrigin.size < SPAWN_MEMORY) {
        this.#spawnOrigin.set(use.id, node);
      }
      out.push({
        type: "graph_tool",
        node,
        name: use.name,
        mcpServer: mcpServerOf(use.name),
        summary: summariseToolInput(use.input),
        attribution,
      });
      const skill = skillOf(use);
      if (skill !== null) {
        out.push({ type: "graph_skill", node, skill, source: "invoked", attribution });
      }
    }
    return out;
  }

  /**
   * A hook DECIDED something.
   *
   * ALWAYS `inferred`, BY CONSTRUCTION. A `PreToolUse` input carries the tool
   * name and the tool input and NO TASK IDENTITY WHATSOEVER, so which agent the
   * decision belongs to is worked out on this side — and on this side the only
   * defensible answer is the run's own session. This is the case the required
   * `attribution` field exists for: the canvas can draw it as an inference
   * instead of asserting the root made a call it may not have made.
   *
   * IT DESCRIBES DECISIONS, NOT FIRINGS. The slot fires for every tool call,
   * Bash included; a `{continue:true}` pass-through carries no information and
   * emitting one per tool call would double the run's event volume to say
   * nothing.
   */
  hookDecision(decision: GraphHookDecision): readonly GraphSseEvent[] {
    const out: GraphSseEvent[] = [];
    const node = this.rootNode(out);
    out.push({
      type: "graph_hook",
      node,
      event: decision.event,
      tool: decision.tool,
      decision: decision.decision,
      reason: truncate(decision.reason, 300),
      attribution: "inferred",
    });
    return out;
  }
}
