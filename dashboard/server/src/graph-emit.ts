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
 *
 * WHAT REACHES THIS FILE FROM A SUBAGENT, AND WHAT DOES NOT — read out of the
 * shipped CLI binary rather than assumed, because it decides how much of the two
 * features below actually work.
 *
 * The CLI splits every message one-per-content-block and then filters what it
 * forwards from a delegated agent with exactly this line:
 *
 *     if (!forwardSubagentText && block.type !== "tool_use" && block.type !== "tool_result") continue;
 *
 * `Options.forwardSubagentText` defaults to false and `claude-builder.ts` does not
 * set it. So:
 *
 *   DIFFS FROM SUBAGENTS DO ARRIVE. A subagent's tool RESULT is a `tool_result`
 *   block, it passes that filter, and the converter yields it as
 *   `{type:"user", parent_tool_use_id: <the Agent block's id>, tool_use_result: …}`
 *   — which is the exact key {@link GraphProjection.toolResult} attributes on, so
 *   a subagent's edits land on the SUBAGENT's node, not the root's.
 *
 *   NARRATION FROM SUBAGENTS DOES NOT. A prose block is `type: "text"`, it is
 *   dropped by that same line, and no later message repeats it. Every
 *   `graph_narration` this file emits is therefore the ORCHESTRATOR's own prose.
 *   That is a real hole in what the canvas can show — most of the work in this
 *   architecture happens inside delegated agents — and it is a ONE-LINE change to
 *   close (`forwardSubagentText: true` in `buildOptions`), deliberately not made
 *   here: it multiplies event volume on every run by an unmeasured factor, and
 *   `attachSse` now DISCONNECTS a client past 4 MiB of queued bytes rather than
 *   buffering it. It is a measurement and an owner decision, not a tidy-up.
 */

import type {
  GraphAgentState,
  GraphAttribution,
  GraphDiffHunk,
  GraphSseEvent,
  ApiLane,
} from "./api-types.js";
import { laneOf } from "./agent-shortlist.js";
import { environmentHash } from "./build-environment.js";
import type { RunEnvironment } from "./build-environment.js";
import { summariseToolInput, truncate } from "./claude-common.js";
import type { SdkToolResult } from "./claude-common.js";
// THE SAME FOUR NUMBERS THE FOLD ENFORCES, AND THE SAME SCRUB. Imported rather
// than restated: `graph.ts` imports nothing but types from `api-types.ts`, so
// there is no cycle, and a second copy of the budget is a second thing to drift.
import {
  DIFF_LINE_CHARS,
  DIFF_MAX_HUNKS,
  DIFF_MAX_LINES,
  NARRATION_CHARS,
  scrubHostPaths,
} from "./graph.js";

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

/**
 * The shape of `SDKUserMessage`, as far as this file cares.
 *
 * IDENTICAL TO {@link GraphAssistantEnvelope} AND DECLARED SEPARATELY ANYWAY.
 * The two are the same field for the same reason — a tool result is attributed by
 * the turn that produced it — but a user message is not an assistant message, and
 * a reader who finds `graph.toolResult(assistantEnvelope)` type-checking has been
 * told the wrong thing about what the CLI sends.
 */
export interface GraphUserEnvelope {
  readonly parent_tool_use_id: string | null;
}

/**
 * ONE APPLIED FILE EDIT, read off the tool RESULT.
 *
 * READING THE RESULT RATHER THAN THE `tool_use` BLOCK IS THE WHOLE CORRECTNESS
 * ARGUMENT, and it is a property of WHERE the data comes from rather than of a
 * check anyone has to remember to write: `FileEditOutput` is what the tool
 * PRODUCED, so a refused, failed or string-not-found edit produces none and there
 * is nothing here to emit. `summariseToolInput` reads the block instead and would
 * draw green and red lines for edits that never happened.
 */
export interface GraphFileEdit {
  readonly path: string;
  readonly change: "added" | "modified";
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly GraphDiffHunk[];
  readonly capped: boolean;
  readonly droppedHunks: number;
  readonly droppedLines: number;
}

/** A finite, non-negative, whole count off an unvalidated payload. */
function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : Math.floor(value);
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A path the canvas can show: workspace-relative where possible, `~`-prefixed
 * where not.
 *
 * TWO INDEPENDENT REASONS, AND ONLY ONE OF THEM IS COSMETIC. `src/app/page.tsx`
 * is what a diff card wants to say. But `filePath` is ABSOLUTE, and
 * `redactForPersistence` has no path rule at all — every rule in
 * `bakeoff/src/redact.ts` is a credential rule and `/Users/<name>/…` matches none
 * of them — so an unscrubbed path is persisted, served and rendered verbatim.
 * `scrubHostPaths` is applied even after the workspace prefix is stripped,
 * because an edit OUTSIDE the workspace still produces a `FileEditOutput`.
 */
function relativePath(filePath: string, workspace: string): string {
  const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
  const relative =
    workspace.length > 0 && filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
  return scrubHostPaths(relative);
}

/**
 * What `structuredPatch` says the change was, when the CLI did not say itself.
 *
 * COUNTED OVER THE WHOLE PATCH, BEFORE ANY CAP — see {@link GraphFileEdit}. The
 * prefixes are the unified-diff ones the SDK documents on `lines`; a `\` line
 * ("\ No newline at end of file") is neither and is counted as neither.
 */
function countLines(hunks: readonly unknown[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    const shape = record(hunk);
    const lines = shape === null ? [] : shape["lines"];
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * One `FileEditOutput` / `FileWriteOutput`, capped and scrubbed — or null when
 * the payload is not one.
 *
 * DUCK-TYPED ON THE PAYLOAD, NOT SWITCHED ON THE TOOL NAME. `tool_use_result` is
 * "the tool's full Output object … keyed by the matching tool_use block's name"
 * (the SDK's own words), and a name list is a list to keep complete: a CLI that
 * ships a fourth file-editing tool would silently stop producing diffs. `filePath`
 * plus `structuredPatch` is the shape both editing outputs share and nothing else
 * in `sdk-tools.d.ts` carries — checked, not assumed: `structuredPatch` appears at
 * exactly two declarations in that file, `FileEditOutput` and `FileWriteOutput`.
 *
 * `gitDiff` IS NOT READ. See the block below: it is a `git diff` against a base
 * ref rather than a description of this operation, and it is gated behind
 * `CLAUDE_CODE_REMOTE`, which nothing here sets.
 *
 * `NotebookEdit` IS NOT ONE OF THEM, contrary to `api-types.ts`'s note on the
 * event's `tool` field. `NotebookEditOutput` carries `new_source`/`old_source` and
 * NO `structuredPatch`, so a notebook edit produces no diff card. Rendering one
 * would mean diffing two cell sources here, which is computing a patch rather than
 * reporting one.
 *
 * CAPPED HERE AS WELL AS IN THE FOLD, AND THE DUPLICATION IS THE POINT. The fold's
 * cap protects the CANVAS; it runs after the event has already been serialised
 * onto the SSE stream and written into the events table. A `Write` of a
 * 3,000-line file is one hunk whose `lines` is the whole file — ~150 KB on the
 * wire, in the row, and in every future replay of that run. The fold ADDS its own
 * drops to the ones reported here, so capping to the same constants means it adds
 * zero and one number still reaches the UI.
 */
export function fileEditFrom(result: unknown, workspace: string): GraphFileEdit | null {
  const output = record(result);
  if (output === null) return null;
  const filePath = output["filePath"];
  const patch = output["structuredPatch"];
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  if (!Array.isArray(patch)) return null;

  /*
   * COUNTED FROM `structuredPatch`, AND `gitDiff` IS DELIBERATELY NOT READ AT ALL
   * — which reverses this function's first draft, on evidence from the CLI.
   *
   * `gitDiff` LOOKS like the field to use: it carries `additions`, `deletions` and
   * a ready `patch`, and the plan for this work named it. Reading what produces it
   * settles what it means:
   *
   *     const base = await mergeBase(root);
   *     const { stdout, code } = await git(["--no-optional-locks", "diff", base, "--", relative]);
   *
   * It is the file's WHOLE divergence from a base ref, not this operation. The
   * findings doc measured the build workspace as a git repo with exactly one
   * commit (`workspace created`), so on the second edit to a file those counts
   * describe every change since the build began: a card saying `+47 −12` above two
   * drawn lines. Its `status: "added"` means "not in the base ref", which is true
   * of every file the build created for the rest of the run — so an edit to a file
   * created an hour ago would keep reporting itself as a creation.
   *
   * AND IT IS ABSENT HERE ANYWAY. Both producers are gated:
   * `if (isTruthy(process.env.CLAUDE_CODE_REMOTE)) { const d = await gitDiffFor(path); ... }`
   * — nothing in this repo sets that variable, so the field never arrives. Which
   * means a mistake here would have been invisible in every local run and would
   * have appeared only on a remote one.
   *
   * The patch is the right source on its own merits regardless: it is per-edit by
   * construction, and the counts then come from the same array the hunks are drawn
   * from, so what the card claims and what it shows cannot disagree.
   */
  const whole = countLines(patch);
  const additions = whole.additions;
  const deletions = whole.deletions;

  /*
   * WHICH SIGNAL SAYS THIS EDIT CREATED THE FILE.
   *   1. `FileWriteOutput.type` — `"create"` vs `"update"`, on writes only.
   *   2. `originalFile === null` — the SDK documents it as "null for new files".
   * Both answer the question being asked, about THIS operation. Anything else is
   * `modified`, the member that claims less: saying a file was CREATED when it was
   * edited invents a fact, and the reverse only loses one.
   */
  const change: "added" | "modified" =
    output["type"] === "create" || output["originalFile"] === null ? "added" : "modified";

  const hunks: GraphDiffHunk[] = [];
  let droppedHunks = 0;
  let droppedLines = 0;
  let shortened = false;
  let budget = DIFF_MAX_LINES;
  for (const entry of patch) {
    const hunk = record(entry);
    const lines = hunk === null || !Array.isArray(hunk["lines"]) ? [] : (hunk["lines"] as unknown[]);
    if (hunk === null || hunks.length >= DIFF_MAX_HUNKS || budget <= 0) {
      droppedHunks += 1;
      droppedLines += lines.length;
      continue;
    }
    const kept = lines.slice(0, budget);
    droppedLines += lines.length - kept.length;
    budget -= kept.length;
    hunks.push({
      oldStart: count(hunk["oldStart"]) ?? 0,
      oldLines: count(hunk["oldLines"]) ?? 0,
      newStart: count(hunk["newStart"]) ?? 0,
      newLines: count(hunk["newLines"]) ?? 0,
      lines: kept.map((line) => {
        const safe = scrubHostPaths(typeof line === "string" ? line : "");
        if (safe.length <= DIFF_LINE_CHARS) return safe;
        shortened = true;
        return safe.slice(0, DIFF_LINE_CHARS);
      }),
    });
  }

  return {
    path: relativePath(filePath, workspace),
    change,
    additions,
    deletions,
    hunks,
    // NOT `droppedLines > 0`: one 40,000-character minified line is a whole diff
    // cut in half with nothing missing from the line COUNT. Same rule as the fold.
    capped: shortened || droppedHunks > 0 || droppedLines > 0,
    droppedHunks,
    droppedLines,
  };
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
 * Bound on remembered tool NAMES — `tool_use` block id -> the tool it called.
 *
 * WHY IT IS BOUNDED DIFFERENTLY FROM {@link SPAWN_MEMORY}, which simply refuses
 * past the cap. Every tool call goes in here, not just delegations, so on a
 * four-hour run this is the map that could grow without limit. In steady state it
 * holds almost nothing: a result arrives immediately after its call and the entry
 * is deleted when it is read. What fills it is calls whose results never come
 * back — an aborted turn, a subagent that was interrupted — and for those the
 * OLDEST entry is the one that will never be claimed. So the cap EVICTS the
 * oldest (a `Map` iterates in insertion order) instead of refusing the newest,
 * which keeps the entry a diff is about to ask for.
 */
const TOOL_NAME_MEMORY = 512;

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
  /** any tool_use block id -> the tool's name, for naming its RESULT. */
  readonly #toolNames = new Map<string, string>();
  /** The build's directory, so a diff can name a file the way a human would. */
  readonly #workspace: string;

  /**
   * DEFAULTED SO THAT A CALLER WITH NO WORKSPACE GETS ABSOLUTE-BUT-SCRUBBED PATHS
   * rather than a compile error — `relativePath` treats "" as "nothing to strip"
   * and `scrubHostPaths` still runs, so the redaction property never depends on
   * this argument being passed.
   */
  constructor(workspace = "") {
    this.#workspace = workspace;
  }

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
   * Which node a turn belongs to, and how sure we are.
   *
   * THE ONE ATTRIBUTION RULE, IN ONE PLACE, because assistant turns and tool
   * results now both need it and the tempting second implementation for results
   * is the WRONG one: a result could be attributed through the `tool_use` block id
   * it answers, which we also remember — but that map holds a tool NAME, and the
   * node that ran a tool is not derivable from the tool. `parent_tool_use_id` is
   * the only identity either message carries.
   *
   * `null` IS EXACT: a turn with no parent tool use is the orchestrator's own, by
   * the SDK's own definition of the field. Only an id we never saw is a guess, and
   * it is attributed to the root and SAYS SO — the alternative is dropping real
   * work off the canvas because a resumed session never replayed its `task_started`.
   */
  #ownerOf(
    parentToolUseId: string | null,
    out: GraphSseEvent[],
  ): { node: string; attribution: GraphAttribution } {
    const root = this.rootNode(out);
    const owner = parentToolUseId === null ? root : this.#byToolUse.get(parentToolUseId);
    return { node: owner ?? root, attribution: owner === undefined ? "inferred" : "exact" };
  }

  /**
   * One assistant turn: what it SAID, then what it DID.
   *
   * `narration` IS A REQUIRED ARGUMENT AND THAT IS DELIBERATE. It used to be
   * captured by the loop and thrown away — `sink.log("info", truncate(text, 500))`
   * put the model's prose in the same generic `{type:"log", level:"info"}` channel
   * as `spec seat — anthropic: 14 input, 40187 cache read…`, where nothing
   * downstream could tell an agent explaining itself from a token count. A
   * defaulted parameter would let a future caller lose it again silently; a
   * required one makes forgetting a compile error.
   *
   * A PROSE-ONLY TURN NOW PRODUCES AN EVENT. This method opened with
   * `if (uses.length === 0) return out;` for its whole life, so a turn that was
   * pure reasoning — the turns the owner asked to see — emitted NOTHING to the
   * canvas at all. The early return is now over BOTH: a turn that neither said
   * nor did anything still emits nothing, and in particular does not announce the
   * root node just to say the model was silent.
   *
   * IT IS PROSE, NOT THINKING, AND MUST NEVER BE LABELLED AS THINKING. Measured
   * on the local transcript corpus: 7,037 `thinking` blocks across four models,
   * zero of them carrying any text — the value is `""` and the `signature` beside
   * it is encrypted. `assistantText` keeps `type: "text"` blocks only, and that
   * filter is left exactly as it is: there is nothing in the other blocks to show.
   *
   * NARRATION IS EMITTED BEFORE THE TOOL CALLS, so the node's single ordered
   * `activity` list reads "here is what I am about to do" and then the doing. The
   * fold appends in arrival order and cannot re-sort — `at` is nullable.
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
    narration: string,
  ): readonly GraphSseEvent[] {
    const out: GraphSseEvent[] = [];
    // SCRUBBED BEFORE IT IS MEASURED, not after: a turn whose only content is an
    // absolute host path becomes "~" and is still worth a row, but the emptiness
    // test has to see the text the canvas will see.
    const prose = scrubHostPaths(narration).trim();
    if (uses.length === 0 && prose === "") return out;
    const { node, attribution } = this.#ownerOf(message.parent_tool_use_id, out);

    if (prose !== "") {
      // CAPPED HERE AS WELL AS IN THE FOLD, for the reason `fileEditFrom` gives:
      // the fold protects the canvas, and by the time it runs the whole turn has
      // already been serialised onto the socket and written to the events table.
      out.push({
        type: "graph_narration",
        node,
        text: prose.length > NARRATION_CHARS ? prose.slice(0, NARRATION_CHARS) : prose,
        truncated: prose.length > NARRATION_CHARS,
        attribution,
      });
    }

    for (const use of uses) {
      if (use.id !== null && canSpawn(use) && this.#spawnOrigin.size < SPAWN_MEMORY) {
        this.#spawnOrigin.set(use.id, node);
      }
      if (use.id !== null) this.#rememberToolName(use.id, use.name);
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
   * Remember which tool a block id called, evicting the oldest at the cap.
   *
   * See {@link TOOL_NAME_MEMORY} for why this evicts rather than refuses.
   */
  #rememberToolName(id: string, name: string): void {
    if (this.#toolNames.size >= TOOL_NAME_MEMORY) {
      const oldest = this.#toolNames.keys().next();
      if (oldest.done !== true) this.#toolNames.delete(oldest.value);
    }
    this.#toolNames.set(id, name);
  }

  /**
   * ONE TOOL RESULT — the green and red lines, when the tool was a file edit.
   *
   * READ FROM THE RESULT, WHICH IS THE ENTIRE CORRECTNESS ARGUMENT. `FileEditOutput`
   * is what the tool PRODUCED, so an edit that was refused by a permission hook, or
   * whose `old_string` matched nothing, or that failed on a read-only file, produces
   * no output and therefore no card. The `tool_use` block — which is what
   * `summariseToolInput` reads today — describes what was ATTEMPTED and is present
   * whether or not anything happened, so a diff drawn from it shows the user changes
   * that are not in their files. That difference is not a detail; it is the feature.
   *
   * ANYTHING THAT IS NOT A FILE EDIT PRODUCES NOTHING, silently and correctly. A
   * `Read`, a `Grep`, an MCP call and — permanently — a `Bash`-driven edit all
   * arrive here. `sed -i`, a heredoc and `npm init` change files and emit no
   * structured output at all, so there will never be a diff card for them. That
   * carve-out has to be said in the UI: a file that changed with no card is not a
   * bug.
   *
   * THE TOOL NAME COMES FROM THE BLOCK WE SAW, AND ITS ABSENCE IS A DROP. A result
   * for a `tool_use` id this projection never recorded is a resumed session
   * replaying, which is the same situation `taskFinished` drops a `task_notification`
   * for and for the same reason: the honest options are "name a tool we never saw"
   * or "say nothing", and the entry is DELETED once read so a duplicated result
   * cannot draw the same edit twice.
   */
  toolResult(message: GraphUserEnvelope, result: SdkToolResult): readonly GraphSseEvent[] {
    const toolUseId = result.toolUseId;
    if (toolUseId === null) return [];
    const tool = this.#toolNames.get(toolUseId);
    if (tool === undefined) return [];
    const edit = fileEditFrom(result.result, this.#workspace);
    // DELETED ONLY ONCE THE PAYLOAD HAS BEEN READ, so a non-edit result does not
    // consume the name — nothing else reads the map today, but a second consumer
    // arriving later must not find the entry gone because a `Read` answered first.
    if (edit === null) return [];
    this.#toolNames.delete(toolUseId);

    const out: GraphSseEvent[] = [];
    const { node, attribution } = this.#ownerOf(message.parent_tool_use_id, out);
    out.push({
      type: "graph_diff",
      node,
      path: edit.path,
      tool,
      change: edit.change,
      additions: edit.additions,
      deletions: edit.deletions,
      hunks: edit.hunks,
      capped: edit.capped,
      droppedHunks: edit.droppedHunks,
      droppedLines: edit.droppedLines,
      attribution,
    });
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
