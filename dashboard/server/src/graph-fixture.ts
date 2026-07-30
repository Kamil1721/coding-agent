/**
 * graph-fixture.ts — the MIRROR CONTRACT for `foldGraph`.
 *
 * WHY THIS FILE EXISTS. Spec §9.2 requires that the same `foldGraph` runs
 * server-side for the snapshot and client-side for the SSE tail. It cannot
 * literally be the same module today: the client tsconfig excludes `server/`,
 * the server's `rootDir` is `src`, and neither side can import the other — which
 * is the identical constraint that already makes `api-types.ts` a hand-mirrored
 * co-change rule rather than one file.
 *
 * SO THE MIRROR IS MADE CHECKABLE INSTEAD OF TRUSTED. This is one event sequence
 * and the exact state it must fold to. `graph.test.ts` asserts the server's
 * reducer against it; a client mirror at `dashboard/src/lib/graph.ts` asserts its
 * own against the same values. Two implementations that both satisfy this
 * document are two implementations that agree about everything the canvas shows.
 *
 * IT IS TYPED, NOT JSON, ON PURPOSE. `events` is
 * `readonly (SseEvent | SseWireEvent)[]`, so a fixture event that is not a legal
 * contract event is a COMPILE error here rather than a fold of something the wire
 * will never carry. The union is what lets the same array hold both the timed form
 * the wire now carries and the bare form every pre-2026-07-30 run is made of —
 * which is a case worth folding, not a legacy to paper over.
 *
 * THE SEQUENCE IS CHOSEN FOR THE CASES THAT BREAK QUIETLY, not for coverage:
 *
 *   - two agents whose `sdk.taskId` is THE SAME LITERAL, which is what
 *     `redactForPersistence` produces from two long ids — they must stay two
 *     nodes;
 *   - a `graph_tool` naming a node that was never declared, which must be
 *     dropped rather than fabricate an agent;
 *   - a pre-canvas `log` row, which every historical run is made of;
 *   - a terminal `status` arriving with an agent still running.
 *
 * WHAT IT IS NOT: a substitute for the per-rule tests in graph.test.ts. A single
 * deep-equal tells you the fold changed; it does not tell you which rule broke,
 * and a fixture updated to match a regression is how a broken fold ships green.
 */

import type { GraphState, SseEvent, SseWireEvent } from "./api-types.js";

/** What `redactForPersistence` turns EVERY long high-entropy id into. */
const REDACTED = "[REDACTED:HIGH_ENTROPY_TOKEN]";

export const CANVAS_FIXTURE: {
  readonly events: readonly (SseEvent | SseWireEvent)[];
  readonly expected: GraphState;
} = {
  events: [
    // A run that predates the canvas is a stream of these and nothing else.
    { type: "log", level: "info", text: "starting the build" },
    {
      type: "graph_agent",
      node: "n1",
      parent: null,
      agent: "orchestrator",
      lane: null,
      description: "the run's own session",
      ambient: false,
      attribution: "exact",
      sdk: null,
    },
    {
      type: "graph_inventory",
      agents: 154,
      skills: 162,
      tools: 42,
      allowedAgents: ["code-reviewer", "typescript-pro"],
      mcpServers: [{ name: "context7", status: "connected" }],
      plugins: ["railway"],
      model: "claude-opus-5",
      claudeCodeVersion: "2.1.220",
      environmentHash: "d3adb33f",
    },
    {
      type: "graph_agent",
      node: "n2",
      parent: "n1",
      agent: "code-reviewer",
      lane: "review",
      description: "review the diff",
      ambient: false,
      attribution: "exact",
      // BOTH AGENTS CARRY THE SAME `sdk.taskId`. This is not a contrived
      // fixture: two 40+ character task ids come back from the events table as
      // this one literal, and a fold keyed on it merges these two nodes.
      sdk: { taskId: REDACTED, toolUseId: "toolu_1" },
    },
    { type: "graph_agent_status", node: "n2", state: "running", attribution: "exact" },
    {
      type: "graph_agent",
      node: "n3",
      parent: "n1",
      agent: "typescript-pro",
      lane: "build",
      description: "write the reducer",
      ambient: false,
      attribution: "exact",
      sdk: { taskId: REDACTED, toolUseId: "toolu_2" },
    },
    { type: "graph_agent_status", node: "n3", state: "running", attribution: "exact" },
    /*
     * THESE FOUR CARRY `at`, AND THE REST DELIBERATELY DO NOT.
     *
     * `at` is what `SseWireEvent` adds on the wire, and it is what turns
     * `GraphNode.activity` from a list into a timeline. Putting it on the tool and
     * skill events — the only two kinds that produce an activity entry — makes this
     * fixture exercise the TIMED path, so the browser specs render real clock times
     * and `graph.test.ts` can assert the ordering is chronological.
     *
     * Leaving it off every other event is the other half of the check: it proves a
     * bare `SseEvent` still folds (every run recorded before 2026-07-30 is one) and
     * that the absence surfaces as `at: null` rather than as a fabricated time.
     */
    {
      type: "graph_tool",
      node: "n2",
      name: "Read",
      mcpServer: null,
      summary: "file_path: /w/a.ts",
      attribution: "exact",
      at: "2026-07-29T23:41:02.000Z",
    },
    {
      type: "graph_tool",
      node: "n2",
      name: "Read",
      mcpServer: null,
      summary: "file_path: /w/b.ts",
      attribution: "exact",
      at: "2026-07-29T23:41:19.000Z",
    },
    {
      type: "graph_tool",
      node: "n2",
      name: "mcp__context7__get-library-docs",
      mcpServer: "context7",
      summary: "library: react",
      attribution: "inferred",
      at: "2026-07-29T23:41:44.000Z",
    },
    {
      type: "graph_skill",
      node: "n3",
      skill: "superpowers:brainstorming",
      source: "invoked",
      attribution: "exact",
      at: "2026-07-29T23:42:08.000Z",
    },
    {
      type: "graph_hook",
      node: "n1",
      event: "PreToolUse",
      tool: "Agent",
      decision: "deny",
      reason: "`wordpress-master` is not available to this run.",
      attribution: "inferred",
    },
    // NAMES A NODE THAT WAS NEVER DECLARED. Dropped; it appears nowhere below.
    {
      type: "graph_tool",
      node: "n99",
      name: "Write",
      mcpServer: null,
      summary: "file_path: /w/ghost.ts",
      attribution: "exact",
    },
    { type: "graph_agent_status", node: "n2", state: "completed", attribution: "exact" },
    {
      type: "graph_result",
      node: "n2",
      state: "completed",
      summary: "two findings",
      totalTokens: 13_842,
      toolUses: 9,
      durationMs: 42_000,
      attribution: "exact",
    },
    // n3 IS STILL RUNNING WHEN THE RUN IS CANCELLED. It must not be reported as
    // having failed: it did not.
    { type: "status", status: "cancelled" },
  ],
  expected: {
    nodes: [
      {
        id: "n1",
        parent: null,
        agent: "orchestrator",
        lane: null,
        description: "the run's own session",
        ambient: false,
        state: "unresolved",
        attribution: "exact",
        sdk: null,
        tools: [],
        skills: [],
        hooks: [{ event: "PreToolUse", tool: "Agent", decision: "deny", count: 1 }],
        toolCalls: 0,
        result: null,
        // n1 only ever produced a hook and a status, and neither is an activity
        // entry. An empty timeline is the correct answer, not a missing one.
        activity: [],
        activityDropped: 0,
      },
      {
        id: "n2",
        parent: "n1",
        agent: "code-reviewer",
        lane: "review",
        description: "review the diff",
        ambient: false,
        state: "completed",
        attribution: "exact",
        sdk: { taskId: REDACTED, toolUseId: "toolu_1" },
        tools: [
          { name: "Read", mcpServer: null, count: 2 },
          { name: "mcp__context7__get-library-docs", mcpServer: "context7", count: 1 },
        ],
        skills: [],
        hooks: [],
        toolCalls: 3,
        result: {
          state: "completed",
          summary: "two findings",
          totalTokens: 13_842,
          toolUses: 9,
          durationMs: 42_000,
        },
        /*
         * THREE ENTRIES WHERE `tools` HAS TWO, which is the whole point of the
         * field. `Read` was used twice and collapses to one counted pill; the
         * timeline keeps both, in order, because "it read a.ts then b.ts then
         * fetched the react docs" is the thing a counted pill cannot say.
         */
        activity: [
          {
            at: "2026-07-29T23:41:02.000Z",
            kind: "tool",
            name: "Read",
            detail: "file_path: /w/a.ts",
            truncated: false,
          },
          {
            at: "2026-07-29T23:41:19.000Z",
            kind: "tool",
            name: "Read",
            detail: "file_path: /w/b.ts",
            truncated: false,
          },
          {
            at: "2026-07-29T23:41:44.000Z",
            kind: "tool",
            name: "mcp__context7__get-library-docs",
            detail: "library: react",
            truncated: false,
          },
        ],
        activityDropped: 0,
      },
      {
        id: "n3",
        parent: "n1",
        agent: "typescript-pro",
        lane: "build",
        description: "write the reducer",
        ambient: false,
        state: "unresolved",
        attribution: "exact",
        sdk: { taskId: REDACTED, toolUseId: "toolu_2" },
        tools: [],
        skills: [{ skill: "superpowers:brainstorming", source: "invoked", count: 1 }],
        hooks: [],
        toolCalls: 0,
        result: null,
        // A skill load is a timeline entry: on a real run it is the moment the
        // work changes character, which is what the reader is looking for.
        activity: [
          {
            at: "2026-07-29T23:42:08.000Z",
            kind: "skill",
            name: "superpowers:brainstorming",
            detail: "invoked",
            truncated: false,
          },
        ],
        activityDropped: 0,
      },
    ],
    edges: [
      { from: "n1", to: "n2", attribution: "exact" },
      { from: "n1", to: "n3", attribution: "exact" },
    ],
    inventory: {
      agents: 154,
      skills: 162,
      tools: 42,
      allowedAgents: ["code-reviewer", "typescript-pro"],
      mcpServers: [{ name: "context7", status: "connected" }],
      plugins: ["railway"],
      model: "claude-opus-5",
      claudeCodeVersion: "2.1.220",
      environmentHash: "d3adb33f",
    },
  },
};
