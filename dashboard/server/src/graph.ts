/**
 * graph.ts — `foldGraph`, the ONE reducer behind both the live canvas and the
 * replay of a finished run.
 *
 * WHY IT TAKES THE WHOLE `SseEvent` UNION AND NOT A `graph_*` SUB-UNION. Both
 * real inputs are full event streams — `store.eventsSince(runId, 0)` on the
 * server and the SSE tail in the browser — and the requirement that makes this
 * phase worth doing at all ("an agent must not show running inside a cancelled
 * run", spec §9.1) is only expressible if the fold SEES the `status` event. A
 * sub-union would have forced a filter at every call site and lost the one
 * ordering guarantee `seq` was giving away for free.
 *
 * FOUR RULES, AND EACH ONE IS A CHECK RATHER THAN A COMMENT — see graph.test.ts,
 * where each is proven by the mutation that turns it red.
 *
 * 1. IT KEYS ON `node` AND ON NOTHING ELSE. Never `sdk.taskId`, never
 *    `sdk.toolUseId`. `redactForPersistence` rewrites any 40+ character
 *    mixed-case-and-digit token to the IDENTICAL literal
 *    `[REDACTED:HIGH_ENTROPY_TOKEN]`, and `task_id` has no documented length
 *    bound — so two distinct agents come back from the events table carrying the
 *    same string, and a fold keyed on it MERGES THEM INTO ONE NODE while the
 *    canvas still renders and every test that uses short fixture ids stays green.
 *    That is why node ids are minted `n1`, `n2`, … on this side.
 *
 * 2. AN EVENT NAMING AN UNKNOWN NODE IS DROPPED. The invariant is that a node id
 *    is never referenced before its `graph_agent`; dropping is what makes the
 *    invariant CHECKED instead of assumed. Creating the node on demand would
 *    fabricate an agent out of a pill.
 *
 * 3. AN UNRECOGNISED EVENT RETURNS THE SAME STATE OBJECT. Every run before this
 *    phase is a stream of `log`/`tool`/`status` rows and nothing else, and it
 *    must fold to an empty canvas without a feature flag and without throwing.
 *    Returning the SAME object (not a copy) is also what keeps the client mirror
 *    from re-rendering on every log line, matching `applyRunEvent`'s contract.
 *
 * 4. A TERMINAL `status` RESOLVES A STILL-RUNNING NODE TO `unresolved`, NEVER TO
 *    `failed`. A cancelled run's in-flight agents did not fail. This codebase
 *    refuses that conflation everywhere else — `heldOutPass: null` is not
 *    `false` — and a canvas that renders a red X for "we stopped watching" is
 *    the same lie in pixels.
 *
 * PURE, TOTAL, AND IN ITS OWN FILE so it is EXECUTED by tests rather than
 * reviewed inside a route handler that only a live server reaches. That is the
 * lesson `build-environment.ts` and `build-context.ts` were written from.
 */

/*
 * `import type`, AND IT MUST STAY THAT WAY. The browser reaches this module through
 * `src/lib/graph.ts`, and a type-only import is erased before Turbopack resolves
 * anything. Import a VALUE from `./api-types.js` here and the run page 500s with
 * `Module not found: Can't resolve './api-types.js'` while `tsc` stays green —
 * observed on 2026-07-30, and the reason `ACTIVITY_CAP` is declared below rather
 * than beside the interface it caps.
 */
import type {
  GraphActivityEntry,
  GraphEdge,
  GraphHookPill,
  GraphNode,
  GraphSkillPill,
  GraphState,
  GraphToolPill,
  SseEvent,
  SseWireEvent,
} from "./api-types.js";

/**
 * How many DISTINCT pill names one node keeps.
 *
 * The call COUNTS are exact and unbounded (`toolCalls` on the node); only the
 * per-name breakdown is capped. A build that reaches 64 distinct tool names has
 * already told the reader everything the 65th would, and an uncapped map on a
 * node that ran for four hours is a memory leak in a browser tab.
 *
 * Chosen against the measured surface: a run with every MCP server connected
 * enumerated 620 tools, of which 589 were `mcp__*` — so the cap binds only on
 * exactly the runs where the list had stopped being readable anyway.
 */
export const PILL_KINDS_CAP = 64;

/**
 * How many ordered activity entries one node keeps.
 *
 * NOT A DISPLAY LIMIT — a wire-size one. `RunGraphResponse` is already 7.01 MB on a
 * 32,000-row run, and `activity` is the first field on `GraphNode` that grows with
 * the LENGTH of a run rather than with its number of distinct names. The busiest
 * node of the one real run recorded 109 calls, so this holds a run several times
 * that size whole; past it `activityDropped` says how much is missing rather than
 * the list quietly ending.
 *
 * Declared here beside `PILL_KINDS_CAP` and not in `api-types.ts` — see the import
 * note above; a runtime export from that file breaks the browser bundle.
 */
export const ACTIVITY_CAP = 400;

/** How much of a tool's summary one activity entry keeps. */
export const ACTIVITY_DETAIL_CHARS = 220;

/** An empty canvas. What every run before this phase folds to. */
export function emptyGraph(): GraphState {
  return { nodes: [], edges: [], inventory: null };
}

/**
 * Find a node's index.
 *
 * The last node is checked first because events arrive in bursts for whichever
 * agent is currently talking, which turns the common case into one comparison.
 * The fallback is a linear scan: `nodes` is ordered by FIRST SIGHTING, which is
 * also the sticky row order the layout depends on (spec §9.3), so it cannot be
 * replaced by a hash map without losing that ordering from the wire shape.
 */
function indexOfNode(nodes: readonly GraphNode[], id: string): number {
  const last = nodes.length - 1;
  if (last >= 0 && nodes[last]?.id === id) return last;
  for (let i = last - 1; i >= 0; i -= 1) {
    if (nodes[i]?.id === id) return i;
  }
  return -1;
}

/** Replace one node, leaving the array's order — the sticky rows — untouched. */
function withNode(
  state: GraphState,
  index: number,
  node: GraphNode,
): GraphState {
  const nodes = [...state.nodes];
  nodes[index] = node;
  return { ...state, nodes };
}

/**
 * Add one to a counted pill, or append it.
 *
 * Over the cap the COUNT of an existing pill still rises — only a NEW name is
 * refused. Dropping updates to known names as well would freeze the display of a
 * long run at whatever it looked like when the 64th name appeared.
 */
function bump<T extends { readonly count: number }>(
  pills: readonly T[],
  match: (pill: T) => boolean,
  make: () => T,
): readonly T[] {
  const index = pills.findIndex(match);
  if (index >= 0) {
    const existing = pills[index];
    if (existing === undefined) return pills;
    const next = [...pills];
    next[index] = { ...existing, count: existing.count + 1 };
    return next;
  }
  if (pills.length >= PILL_KINDS_CAP) return pills;
  return [...pills, make()];
}

/**
 * Append one ordered activity entry, respecting the cap.
 *
 * OVER THE CAP THE COUNTER RISES AND THE LIST DOES NOT — the same shape as
 * `toolCalls` vs `tools`, and for the same reason: a list that silently stops
 * growing reads as "this is everything it did".
 */
function record(
  node: GraphNode,
  entry: GraphActivityEntry,
): Pick<GraphNode, "activity" | "activityDropped"> {
  if (node.activity.length >= ACTIVITY_CAP) {
    return { activity: node.activity, activityDropped: node.activityDropped + 1 };
  }
  return {
    activity: [...node.activity, entry],
    activityDropped: node.activityDropped,
  };
}

/** Cut a summary to the wire budget, and say so when it was cut. */
function clip(detail: string): { detail: string; truncated: boolean } {
  if (detail.length <= ACTIVITY_DETAIL_CHARS) {
    return { detail, truncated: false };
  }
  return { detail: detail.slice(0, ACTIVITY_DETAIL_CHARS), truncated: true };
}

/**
 * The instant an event was recorded, or null when it carries none.
 *
 * WHY IT IS SNIFFED RATHER THAN A REQUIRED PARAMETER. Both real callers hand this
 * a {@link SseWireEvent} — the browser gets `at` from the SSE frame, the server's
 * snapshot route gets it from the `events` row — while the tests fold bare
 * `SseEvent` literals. A required third argument would have meant editing forty
 * fixtures to pass a value none of them assert on, and an OPTIONAL one is this
 * repository's best-documented defect shape: a parameter the production path
 * forgets to pass while every test still passes (`auditSuite` never passing its
 * own `ticketBrief`).
 *
 * So the type carries it instead of the signature, and the guard against the
 * production path losing it is an executed check on the REAL fold, not a comment:
 * `graph.test.ts` asserts a wire event folds to a non-null `at`, and
 * `http.ts`'s snapshot is asserted to produce timed entries for the recorded run.
 */
function instantOf(event: SseEvent | SseWireEvent): string | null {
  return "at" in event && typeof event.at === "string" ? event.at : null;
}

/**
 * Fold one event into the canvas.
 *
 * Returns the SAME object when nothing changed. Never throws: this runs over
 * rows written by every previous version of this program.
 *
 * Accepts a bare `SseEvent` or an {@link SseWireEvent}; the latter is what both
 * production callers pass, and is what puts a time on the ordered activity.
 */
export function foldGraph(
  state: GraphState,
  event: SseEvent | SseWireEvent,
): GraphState {
  switch (event.type) {
    case "graph_agent": {
      // A repeat of a node id is IGNORED rather than merged. Two `graph_agent`
      // events for one id can only mean the emitter's counter was reset (a
      // resumed session mints from 1 again), and overwriting would hand the
      // second agent the first one's pills.
      if (indexOfNode(state.nodes, event.node) >= 0) return state;
      const node: GraphNode = {
        id: event.node,
        parent: event.parent,
        agent: event.agent,
        lane: event.lane,
        description: event.description,
        ambient: event.ambient,
        state: "running",
        attribution: event.attribution,
        sdk: event.sdk,
        tools: [],
        skills: [],
        hooks: [],
        toolCalls: 0,
        result: null,
        activity: [],
        activityDropped: 0,
      };
      // The edge is drawn only when the parent is already a node — same
      // invariant, other end. An edge to nothing is not a lighter-weight edge,
      // it is a dangling reference the renderer has to guess about.
      const edges: readonly GraphEdge[] =
        event.parent !== null && indexOfNode(state.nodes, event.parent) >= 0
          ? [
              ...state.edges,
              { from: event.parent, to: event.node, attribution: event.attribution },
            ]
          : state.edges;
      return { ...state, nodes: [...state.nodes, node], edges };
    }

    case "graph_agent_status": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      if (node.state === event.state) return state;
      return withNode(state, index, { ...node, state: event.state });
    }

    case "graph_tool": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const tools = bump<GraphToolPill>(
        node.tools,
        (pill) => pill.name === event.name,
        () => ({ name: event.name, mcpServer: event.mcpServer, count: 1 }),
      );
      // `toolCalls` rises even when the pill did not fit, so a capped node is
      // visibly capped rather than quietly under-reported.
      const clipped = clip(event.summary);
      return withNode(state, index, {
        ...node,
        tools,
        toolCalls: node.toolCalls + 1,
        ...record(node, {
          at: instantOf(event),
          kind: "tool",
          name: event.name,
          detail: clipped.detail,
          truncated: clipped.truncated,
        }),
      });
    }

    case "graph_skill": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const skills = bump<GraphSkillPill>(
        node.skills,
        (pill) => pill.skill === event.skill && pill.source === event.source,
        () => ({ skill: event.skill, source: event.source, count: 1 }),
      );
      return withNode(state, index, {
        ...node,
        skills,
        /*
         * A SKILL LOADING IS A TIMELINE EVENT, not just a pill. On the one real run
         * `imagegen-frontend-web` loading is the moment the design work starts —
         * the thing the owner wants to read first — and a counted pill cannot say
         * when it happened.
         */
        ...record(node, {
          at: instantOf(event),
          kind: "skill",
          name: event.skill,
          detail: event.source,
          truncated: false,
        }),
      });
    }

    case "graph_hook": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      const hooks = bump<GraphHookPill>(
        node.hooks,
        (pill) =>
          pill.event === event.event &&
          pill.tool === event.tool &&
          pill.decision === event.decision,
        () => ({ event: event.event, tool: event.tool, decision: event.decision, count: 1 }),
      );
      return withNode(state, index, { ...node, hooks });
    }

    case "graph_result": {
      const index = indexOfNode(state.nodes, event.node);
      const node = state.nodes[index];
      if (node === undefined) return state;
      return withNode(state, index, {
        ...node,
        state: event.state,
        result: {
          state: event.state,
          summary: event.summary,
          totalTokens: event.totalTokens,
          toolUses: event.toolUses,
          durationMs: event.durationMs,
        },
      });
    }

    case "graph_inventory":
      return {
        ...state,
        inventory: {
          agents: event.agents,
          skills: event.skills,
          tools: event.tools,
          allowedAgents: event.allowedAgents,
          mcpServers: event.mcpServers,
          plugins: event.plugins,
          model: event.model,
          claudeCodeVersion: event.claudeCodeVersion,
          environmentHash: event.environmentHash,
        },
      };

    case "status": {
      // THE REASON THIS FOLD SEES NON-GRAPH EVENTS AT ALL. A run that was
      // cancelled or that failed leaves agents mid-flight, and their last
      // `graph_agent_status` said `running`. Rendering that forever is the
      // "agent running inside a cancelled run" the total ordering exists to
      // prevent — and calling it `failed` would be a claim no message made.
      if (event.status !== "passed" && event.status !== "failed" && event.status !== "cancelled") {
        return state;
      }
      let touched = false;
      const nodes = state.nodes.map((node) => {
        if (node.state !== "running") return node;
        touched = true;
        return { ...node, state: "unresolved" as const };
      });
      return touched ? { ...state, nodes } : state;
    }

    default:
      // Every other member, INCLUDING ONES THAT DO NOT EXIST YET. A run recorded
      // by an older build of this program is a stream of `log` and `tool` rows;
      // throwing here would take the snapshot endpoint down on every historical
      // run, which is precisely the "old runs render an empty canvas with no
      // feature flag" requirement, inverted.
      return state;
  }
}

/**
 * Fold a whole stream. The snapshot's own body, and the fixture's.
 *
 * Takes wire events too, so the snapshot route can pass `{...row.event, at:
 * row.at}` and get a timed activity list out.
 */
export function foldGraphAll(
  events: Iterable<SseEvent | SseWireEvent>,
): GraphState {
  let state = emptyGraph();
  for (const event of events) state = foldGraph(state, event);
  return state;
}
