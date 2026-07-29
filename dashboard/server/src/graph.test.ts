/**
 * graph.test.ts — the reducer's four rules, one test each, each written so that
 * the mutation that breaks the rule turns it red.
 *
 * WHAT THESE DO NOT COVER, SAID PLAINLY: that the message loop CALLS the
 * projection. A well-tested pure function whose call site has been reverted is
 * this repository's signature failure — `recordResultTokens` shipped exactly
 * that, green at 229/227/0/2 — so the emission side is asserted against the SINK
 * in "THE LOOP: the canvas" in `builders/claude-builder.test.ts`, by driving
 * synthetic envelopes through `build()`. Neither file substitutes for the other.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { GraphState, SseEvent } from "./api-types.js";
import { PILL_KINDS_CAP, emptyGraph, foldGraph, foldGraphAll } from "./graph.js";
import { CANVAS_FIXTURE } from "./graph-fixture.js";

/** A node declaration, with only the interesting fields spelled out. */
function agent(node: string, overrides: Partial<Extract<SseEvent, { type: "graph_agent" }>> = {}): SseEvent {
  return {
    type: "graph_agent",
    node,
    parent: null,
    agent: "code-reviewer",
    lane: "review",
    description: "",
    ambient: false,
    attribution: "exact",
    sdk: null,
    ...overrides,
  };
}

function tool(node: string, name: string): SseEvent {
  return { type: "graph_tool", node, name, mcpServer: null, summary: "", attribution: "exact" };
}

function nodeIds(state: GraphState): readonly string[] {
  return state.nodes.map((node) => node.id);
}

test("RULE 1: two agents whose raw task_id REDACTED TO THE SAME LITERAL stay two nodes", () => {
  // THIS IS THE MEASUREMENT THAT FORCED SERVER-ASSIGNED IDS.
  // `redactForPersistence` rewrites any 40+ character mixed-case-and-digit token
  // to the IDENTICAL literal `[REDACTED:HIGH_ENTROPY_TOKEN]`, and `task_id` has
  // no documented length bound — so this is what two real agents look like after
  // a round-trip through the events table. A fold that treats the SDK id as
  // identity merges them into one node, drops half the canvas, and keeps
  // rendering.
  //
  // ONE TEST, NOT TWO. It carries the pills as well as the node count on
  // purpose: a second test asserting only that the pills landed correctly would
  // have had a failure mode that is a strict subset of this one's — a check that
  // cannot go red on its own, which is a defect this repository has shipped
  // before. Executed mutation: dedupe `graph_agent` on `event.sdk.taskId`
  // instead of on `event.node` — one node, `toolCalls: 3`, three assertions red.
  const collided = "[REDACTED:HIGH_ENTROPY_TOKEN]";
  const state = foldGraphAll([
    agent("n1", { sdk: { taskId: collided, toolUseId: collided } }),
    agent("n2", { agent: "typescript-pro", sdk: { taskId: collided, toolUseId: collided } }),
    tool("n1", "Read"),
    tool("n2", "Write"),
    tool("n2", "Write"),
  ]);

  assert.deepEqual(nodeIds(state), ["n1", "n2"]);
  assert.deepEqual(
    state.nodes.map((node) => node.agent),
    ["code-reviewer", "typescript-pro"],
    "two distinct agents were merged into one node by their redacted id",
  );
  assert.deepEqual(
    state.nodes.map((node) => node.toolCalls),
    [1, 2],
    "work was attributed by SDK id rather than by node",
  );
});

test("RULE 2: an event naming an unknown node is DROPPED, never creates one", () => {
  // The invariant is that a node id is never referenced before its
  // `graph_agent`. Dropping is what makes the invariant CHECKED rather than
  // assumed; creating on demand would fabricate an agent out of a pill, with no
  // name, no lane and no parent.
  const before = foldGraphAll([agent("n1")]);
  const after = foldGraphAll([
    agent("n1"),
    tool("n9", "Read"),
    { type: "graph_agent_status", node: "n9", state: "failed", attribution: "exact" },
    { type: "graph_skill", node: "n9", skill: "postgres", source: "invoked", attribution: "exact" },
    { type: "graph_hook", node: "n9", event: "PreToolUse", tool: "Agent", decision: "deny", reason: "", attribution: "inferred" },
    {
      type: "graph_result",
      node: "n9",
      state: "completed",
      summary: "",
      totalTokens: null,
      toolUses: null,
      durationMs: null,
      attribution: "exact",
    },
  ]);

  assert.deepEqual(nodeIds(after), ["n1"]);
  assert.deepEqual(after, before, "an unknown node id changed the canvas");
});

test("RULE 2: an edge is drawn only to a parent that exists", () => {
  const state = foldGraphAll([agent("n1"), agent("n2", { parent: "n1", attribution: "inferred" })]);
  assert.deepEqual(state.edges, [{ from: "n1", to: "n2", attribution: "inferred" }]);
  // THE CHILD'S ATTRIBUTION IS THE EDGE'S. An edge to a parent the emitter had
  // to guess renders differently, which is the entire reason the field is
  // required rather than optional.

  const dangling = foldGraphAll([agent("n2", { parent: "n404" })]);
  assert.deepEqual(dangling.edges, [], "an edge was drawn to a node that does not exist");
});

test("RULE 3: an unrecognised event returns the SAME state object", () => {
  // Every run recorded before this phase is a stream of `log`, `tool` and
  // `status` rows and nothing else. Throwing here would take the snapshot
  // endpoint down on every historical run — the "old runs render an empty canvas
  // with no feature flag" requirement, inverted. Object IDENTITY is asserted,
  // not equality: the client mirror re-renders on a new object, and a canvas
  // that re-renders on every log line of a four-hour build is unusable.
  const state = foldGraphAll([agent("n1")]);
  for (const event of [
    { type: "log", level: "info", text: "hello" },
    { type: "tool", name: "Read", summary: "" },
    { type: "phase", phase: "build" },
    { type: "tokens", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { type: "status", status: "running" },
    // A member that does not exist yet, forced past the compiler exactly as an
    // older/newer writer's row would arrive from `JSON.parse(...) as SseEvent`.
    { type: "graph_something_new", node: "n1" } as unknown,
  ] as SseEvent[]) {
    assert.equal(foldGraph(state, event), state, `${event.type} was not folded as a no-op`);
  }
});

test("RULE 3: a run with no graph events at all folds to an empty canvas", () => {
  const state = foldGraphAll([
    { type: "status", status: "queued" },
    { type: "phase", phase: "spec" },
    { type: "log", level: "info", text: "starting" },
    { type: "tool", name: "Read", summary: "a.ts" },
    { type: "status", status: "passed" },
  ]);
  assert.deepEqual(state, emptyGraph());
  assert.equal(state.inventory, null, "an absent inventory must not read as an empty one");
});

test("RULE 4: a terminal status resolves a running agent to `unresolved`, NEVER to `failed`", () => {
  // A cancelled run's in-flight agents did not fail. This codebase refuses that
  // conflation everywhere else — `heldOutPass: null` is not `false` — and a red
  // X for "we stopped watching" is the same lie in pixels.
  const state = foldGraphAll([
    agent("n1"),
    agent("n2"),
    { type: "graph_agent_status", node: "n2", state: "completed", attribution: "exact" },
    { type: "status", status: "cancelled" },
  ]);

  assert.equal(state.nodes[0]?.state, "unresolved");
  assert.notEqual(state.nodes[0]?.state, "failed", "a cancelled run was reported as a failed agent");
  assert.equal(state.nodes[1]?.state, "completed", "a finished agent was overwritten by the run's status");
});

test("RULE 4: a NON-terminal status leaves a running agent running", () => {
  // `rate_limited` and `awaiting_input` are stopped, not finished. A run that
  // resumes must not have had its agents resolved out from under it.
  const state = foldGraphAll([agent("n1")]);
  for (const status of ["running", "queued", "rate_limited", "awaiting_input"] as const) {
    const next = foldGraph(state, { type: "status", status });
    assert.equal(next, state, `${status} resolved a running agent`);
  }
});

test("pills aggregate by name with an exact count, and the total survives the cap", () => {
  const events: SseEvent[] = [agent("n1")];
  for (let i = 0; i < 3; i += 1) events.push(tool("n1", "Read"));
  // Past the distinct-name cap. The COUNTS stay exact; only the breakdown stops.
  for (let i = 0; i < PILL_KINDS_CAP + 10; i += 1) events.push(tool("n1", `tool-${String(i)}`));

  const node = foldGraphAll(events).nodes[0];
  assert.ok(node);
  assert.equal(node.tools.length, PILL_KINDS_CAP, "an unbounded pill list is a leak in a browser tab");
  assert.equal(node.tools[0]?.count, 3, "repeat calls must aggregate, not append");
  assert.equal(
    node.toolCalls,
    3 + PILL_KINDS_CAP + 10,
    "a capped node under-reported its work instead of being visibly capped",
  );
});

test("a repeated node id is ignored, not merged", () => {
  // A resumed build gets a fresh projection and mints from `n1` again. Merging
  // would hand the resumed session's root the previous session's pills.
  const state = foldGraphAll([
    agent("n1", { agent: "code-reviewer" }),
    tool("n1", "Read"),
    agent("n1", { agent: "typescript-pro" }),
  ]);
  assert.equal(state.nodes.length, 1);
  assert.equal(state.nodes[0]?.agent, "code-reviewer");
  assert.equal(state.nodes[0]?.toolCalls, 1);
});

test("THE MIRROR CONTRACT: the fixture folds to exactly the state it documents", () => {
  // `dashboard/src/lib/graph.ts` (the client tail-fold) must satisfy this same
  // document. It is the only thing that makes "one reducer" checkable across two
  // files that cannot import each other — see graph-fixture.ts.
  assert.deepEqual(foldGraphAll(CANVAS_FIXTURE.events), CANVAS_FIXTURE.expected);
});
