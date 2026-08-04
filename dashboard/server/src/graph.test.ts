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
import type { GraphDiffHunk, GraphState, SseEvent, SseWireEvent } from "./api-types.js";
import {
  ACTIVITY_CAP,
  ACTIVITY_DETAIL_CHARS,
  DIFF_BODIES_CAP,
  DIFF_LINE_CHARS,
  DIFF_MAX_HUNKS,
  DIFF_MAX_LINES,
  NARRATION_CHARS,
  PILL_KINDS_CAP,
  emptyGraph,
  foldGraph,
  foldGraphAll,
} from "./graph.js";
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
  /*
   * THE AGENT CANVAS IS STILL EMPTY, AND THE PRE-BUILD LANE NO LONGER IS. This
   * test used to `deepEqual(state, emptyGraph())` on a stream containing
   * `phase: spec`, which was correct while the fold ignored phases. A run IN the
   * spec phase does have a pre-build lane — that is the whole of ask D — so the
   * assertion is split rather than relaxed: nodes, edges and inventory are checked
   * to be exactly what they were, and the lane is checked separately below.
   *
   * The "no key at all" half of the invariant has its own test further down, on a
   * stream that never mentions a pre-build phase.
   */
  const state = foldGraphAll([
    { type: "status", status: "queued" },
    { type: "phase", phase: "spec" },
    { type: "log", level: "info", text: "starting" },
    { type: "tool", name: "Read", summary: "a.ts" },
    { type: "status", status: "passed" },
  ]);
  assert.deepEqual(state.nodes, []);
  assert.deepEqual(state.edges, []);
  assert.equal(state.inventory, null, "an absent inventory must not read as an empty one");
  assert.deepEqual(
    state.stages?.map((stage) => stage.id),
    ["capture", "author", "audit", "freeze", "orchestrator"],
    "a run that reached the spec phase has a pre-build lane even before any agent exists",
  );
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

/* ==================================================================
 * The ordered activity — the timeline `tools` cannot hold.
 * ================================================================== */

/** A tool event carrying the wire's recorded instant. */
function timedTool(node: string, name: string, summary: string, at: string): SseWireEvent {
  return { type: "graph_tool", node, name, mcpServer: null, summary, attribution: "exact", at };
}

test("ACTIVITY: the order survives, and the duplicate `tools` collapses does not", () => {
  /*
   * THE POINT OF THE FIELD, in one assertion. `Read` twice then `Write` is three
   * things that happened in an order; `tools` reports it as
   * `[{Read,count:2},{Write,count:1}]`, which answers a different question. The
   * owner asked for "what it was looking at in order", so the ordering and the
   * repeat both have to survive.
   *
   * MUTATION THIS CATCHES: building `activity` from `node.tools` (the tempting
   * derivation) yields two entries in name order, not three in time order.
   */
  const state = foldGraphAll([
    agent("n1"),
    timedTool("n1", "Read", "file_path: /w/hero.png", "2026-07-29T23:49:22.000Z"),
    timedTool("n1", "Read", "file_path: /w/services.png", "2026-07-29T23:49:56.000Z"),
    timedTool("n1", "Write", "file_path: /w/index.html", "2026-07-29T23:50:15.000Z"),
  ]);
  const node = state.nodes[0];
  assert.ok(node !== undefined);

  assert.equal(node.tools.length, 2, "`tools` should still aggregate by name");
  assert.equal(node.activity.length, 3, "`activity` must keep every call, including the repeat");
  assert.deepEqual(
    node.activity.map((entry) => entry.detail),
    ["file_path: /w/hero.png", "file_path: /w/services.png", "file_path: /w/index.html"],
    "the entries are in the order they happened",
  );
  assert.deepEqual(
    node.activity.map((entry) => entry.at),
    [
      "2026-07-29T23:49:22.000Z",
      "2026-07-29T23:49:56.000Z",
      "2026-07-29T23:50:15.000Z",
    ],
    "each entry carries the SERVER's recorded instant",
  );
});

test("ACTIVITY: a bare event folds to `at: null` rather than a fabricated time", () => {
  /*
   * EVERY RUN RECORDED BEFORE 2026-07-30 IS THIS SHAPE — the wire carried no `at`
   * — and the only honest answer for those is "not recorded". The failure this
   * guards is the one that would look perfect in a demo: stamping the fold's own
   * clock, which dates a two-hour-old run to the moment somebody opened the page.
   */
  const state = foldGraphAll([agent("n1"), tool("n1", "Bash")]);
  const entry = state.nodes[0]?.activity[0];
  assert.ok(entry !== undefined, "a bare tool event must still produce an entry");
  assert.equal(entry.at, null, "no recorded time must read as null, never as `now`");
});

test("ACTIVITY: past the cap the list stops and the DROPPED COUNT rises", () => {
  /*
   * Same honesty rule as `toolCalls` vs `tools`: a list that silently stops
   * growing reads as "this is everything it did". `activityDropped` is what makes
   * a truncated timeline legible as truncated.
   */
  const events: (SseEvent | SseWireEvent)[] = [agent("n1")];
  const overshoot = 5;
  for (let i = 0; i < ACTIVITY_CAP + overshoot; i += 1) {
    events.push(tool("n1", `Tool${String(i)}`));
  }
  const node = foldGraphAll(events).nodes[0];
  assert.ok(node !== undefined);

  assert.equal(node.activity.length, ACTIVITY_CAP, "the list is held at the cap");
  assert.equal(node.activityDropped, overshoot, "everything past the cap is counted");
  assert.equal(
    node.toolCalls,
    ACTIVITY_CAP + overshoot,
    "`toolCalls` stays exact regardless of the activity cap",
  );
});

test("ACTIVITY: a long summary is cut AND says it was cut", () => {
  // A clipped path that does not admit to being clipped is a wrong path.
  const long = "command: ".concat("x".repeat(ACTIVITY_DETAIL_CHARS + 50));
  const state = foldGraphAll([
    agent("n1"),
    timedTool("n1", "Bash", long, "2026-07-29T23:49:22.000Z"),
  ]);
  const entry = state.nodes[0]?.activity[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.detail.length, ACTIVITY_DETAIL_CHARS);
  assert.equal(entry.truncated, true, "a cut summary must be flagged as cut");
});

/* ==================================================================
 * NARRATION — ask B's achievable half
 *
 * WHAT IS BEING CHECKED IS THE FOLD, NOT THE EMISSION. Nothing produces a
 * `graph_narration` event yet; the capture is the next wave's. That is the same
 * split "THE LOOP: the canvas" in `builders/claude-builder.test.ts` covers for
 * the events that do have producers, and the header of this file says why
 * neither substitutes for the other.
 * ================================================================== */

function narration(node: string, text: string, truncated = false): SseEvent {
  return { type: "graph_narration", node, text, truncated, attribution: "exact" };
}

test("NARRATION: a turn of prose lands on the node's timeline, in order, unnamed", () => {
  /*
   * THE INTERLEAVING IS THE FEATURE. Prose, then the tool it was about, then more
   * prose is what the terminal shows and what the owner asked for; three parallel
   * lists would have to be merged back by `at`, which is nullable and therefore
   * cannot always do it.
   *
   * `name` IS THE EMPTY STRING AND THAT IS DELIBERATE — a turn of prose has no
   * name, and filling it with the agent's would put an attribution on every line
   * that the model never made.
   */
  const state = foldGraphAll([
    agent("n1"),
    narration("n1", "Reading the CV to work out what the page has to say."),
    tool("n1", "Read"),
    narration("n1", "The hero needs a second line."),
  ]);
  const node = state.nodes[0];
  assert.ok(node !== undefined);
  assert.deepEqual(
    node.activity.map((entry) => entry.kind),
    ["narration", "tool", "narration"],
  );
  assert.equal(node.activity[0]?.detail, "Reading the CV to work out what the page has to say.");
  assert.equal(node.activity[0]?.name, "");
  assert.equal(node.activity[0]?.truncated, false);
  // NOT A TOOL CALL. A narration turn that bumped `toolCalls` would inflate the
  // one number on the node that is documented as exact.
  assert.equal(node.toolCalls, 1);
});

test("NARRATION: a long turn is cut to the narration budget, not to the tool-summary one", () => {
  /*
   * THE MUTATION THIS EXISTS FOR, AND IT IS A ONE-CHARACTER ONE: dropping the
   * `NARRATION_CHARS` argument at the `graph_narration` arm. `clip`'s default is
   * `ACTIVITY_DETAIL_CHARS` (220), so the fold would still cut, still set
   * `truncated`, and still look perfectly correct — while silently delivering a
   * fifth of the measured budget. Asserting `truncated === true` alone cannot see
   * that; the LENGTH is what sees it.
   */
  const state = foldGraphAll([agent("n1"), narration("n1", "x".repeat(NARRATION_CHARS + 500))]);
  const entry = state.nodes[0]?.activity[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.detail.length, NARRATION_CHARS);
  assert.notEqual(
    entry.detail.length,
    ACTIVITY_DETAIL_CHARS,
    "narration was cut to the tool-summary budget: 220 characters of prose is a fragment",
  );
  assert.equal(entry.truncated, true);
});

test("NARRATION: the emitter's own cut is not overwritten by a short turn", () => {
  // EITHER END MAY HAVE CUT IT. A turn the emitter already trimmed arrives short
  // enough to pass `clip` untouched, and a fold that recomputed `truncated` from
  // its own budget would report the trimmed turn as whole.
  const state = foldGraphAll([agent("n1"), narration("n1", "the first paragraph only", true)]);
  assert.equal(state.nodes[0]?.activity[0]?.truncated, true);
});

test("NARRATION: an empty turn is a no-op, and an unknown node is dropped", () => {
  // `assistantText` joins the `text` blocks of a turn, so a turn whose only block
  // is a tool call joins to "". Folding that in would put a blank row beside every
  // tool call. Identity is asserted, not equality: a new object re-renders the
  // client canvas.
  const state = foldGraphAll([agent("n1")]);
  assert.equal(foldGraph(state, narration("n1", "   \n  ")), state);
  assert.equal(foldGraph(state, narration("n9", "an agent nobody declared")), state);
});

/* ==================================================================
 * DIFFS — ask C
 * ================================================================== */

function hunk(lines: readonly string[], oldStart = 1, newStart = 1): GraphDiffHunk {
  return { oldStart, oldLines: lines.length, newStart, newLines: lines.length, lines };
}

function diffEvent(
  node: string,
  overrides: Partial<Extract<SseEvent, { type: "graph_diff" }>> = {},
): SseEvent {
  return {
    type: "graph_diff",
    node,
    path: "src/app/page.tsx",
    tool: "Edit",
    change: "modified",
    additions: 2,
    deletions: 1,
    hunks: [hunk([" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;"])],
    capped: false,
    droppedHunks: 0,
    droppedLines: 0,
    attribution: "exact",
    ...overrides,
  };
}

test("DIFF: an applied edit lands as a timeline entry carrying its lines and its counts", () => {
  const state = foldGraphAll([agent("n1"), diffEvent("n1")]);
  const entry = state.nodes[0]?.activity[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, "diff");
  assert.equal(entry.name, "Edit", "a diff entry is named by the tool that produced it");
  assert.equal(entry.detail, "+2 -1 src/app/page.tsx");
  assert.equal(entry.diff?.additions, 2);
  assert.equal(entry.diff?.deletions, 1);
  assert.equal(entry.diff?.capped, false);
  assert.deepEqual(entry.diff?.hunks[0]?.lines, [
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
  ]);
});

test("DIFF: `diff` is present on a diff entry and ABSENT on every other kind", () => {
  /*
   * BOTH HALVES OF THE "IF AND ONLY IF". The presence half is what the renderer
   * branches on; the ABSENCE half is what keeps the fold's output byte-identical
   * to the tool and skill entries `graph-fixture.ts` documents, which is what lets
   * the mirror contract go on comparing whole objects.
   */
  const state = foldGraphAll([
    agent("n1"),
    tool("n1", "Read"),
    { type: "graph_skill", node: "n1", skill: "frontend-design", source: "invoked", attribution: "exact" },
    narration("n1", "about to edit"),
    diffEvent("n1"),
  ]);
  const activity = state.nodes[0]?.activity ?? [];
  for (const entry of activity) {
    if (entry.kind === "diff") {
      assert.notEqual(entry.diff, undefined, "a diff entry with no diff on it");
    } else {
      assert.ok(
        !("diff" in entry),
        `a ${entry.kind} entry carries a \`diff\` key, which the wire shape says it never does`,
      );
    }
  }
});

test("DIFF CAP: a 3,000-line write does not become a 3,000-line event", () => {
  /*
   * THE CASE THE CAP EXISTS FOR, AND IT IS ORDINARY. `Write` of a new page
   * produces ONE hunk whose `lines` is the whole file. Uncapped it goes onto the
   * event stream, into the events table and into every future replay of the run.
   *
   * THE MUTATION: delete the `budget` arithmetic in `capDiff` and push
   * `hunk.lines` through unchanged. Every count below stays plausible — the
   * additions are right, the path is right — and the assertion that goes red is
   * the LENGTH, which is the only thing standing between this and a 7 MB response
   * becoming a 90 MB one.
   *
   * AND THE COUNTS SURVIVE THE CAP. `additions` is 3,000 whether or not the body
   * fitted, because the reader is entitled to know how big the change was even
   * when the lines are not on screen.
   */
  const lines = Array.from({ length: 3000 }, (_, i) => `+line ${String(i)}`);
  const state = foldGraphAll([
    agent("n1"),
    diffEvent("n1", {
      tool: "Write",
      change: "added",
      additions: 3000,
      deletions: 0,
      hunks: [hunk(lines)],
    }),
  ]);
  const diff = state.nodes[0]?.activity[0]?.diff;
  assert.ok(diff !== undefined);
  const kept = diff.hunks.reduce((total, entry) => total + entry.lines.length, 0);
  assert.equal(kept, DIFF_MAX_LINES, "the body was not held at the line budget");
  assert.equal(diff.droppedLines, 3000 - DIFF_MAX_LINES);
  assert.equal(diff.capped, true, "a capped diff that does not say so reads as a whole one");
  assert.equal(diff.additions, 3000, "the counts describe the whole patch, capped or not");
  assert.equal(diff.change, "added");
});

test("DIFF CAP: a minified line is shortened, and that alone sets `capped`", () => {
  // `capped` IS NOT `droppedLines > 0`. One 40,000-character bundle line is a
  // whole diff cut in half with nothing missing from the line COUNT, and a flag
  // derived from the counters would call it complete.
  const state = foldGraphAll([
    agent("n1"),
    diffEvent("n1", { hunks: [hunk([`+${"x".repeat(DIFF_LINE_CHARS + 4000)}`])] }),
  ]);
  const diff = state.nodes[0]?.activity[0]?.diff;
  assert.ok(diff !== undefined);
  assert.equal(diff.hunks[0]?.lines[0]?.length, DIFF_LINE_CHARS);
  assert.equal(diff.droppedLines, 0, "no line went missing");
  assert.equal(diff.capped, true, "a shortened line is withheld content and must say so");
});

test("DIFF CAP: past the hunk budget the extra hunks are counted, not kept", () => {
  const many = Array.from({ length: DIFF_MAX_HUNKS + 3 }, (_, i) => hunk([`+${String(i)}`], i + 1, i + 1));
  const state = foldGraphAll([agent("n1"), diffEvent("n1", { hunks: many })]);
  const diff = state.nodes[0]?.activity[0]?.diff;
  assert.ok(diff !== undefined);
  assert.equal(diff.hunks.length, DIFF_MAX_HUNKS);
  assert.equal(diff.droppedHunks, 3);
  assert.equal(diff.capped, true);
});

test("DIFF CAP: the emitter's own dropped lines are ADDED to the fold's, never replaced", () => {
  // ONE NUMBER FOR "HOW MUCH OF THIS IS NOT ON SCREEN". An emitter that already
  // cut a patch reports its own count; this fold may cut more. Two independent
  // counters would make the sum something the UI has to remember to do.
  const state = foldGraphAll([
    agent("n1"),
    diffEvent("n1", {
      hunks: [hunk(Array.from({ length: DIFF_MAX_LINES + 10 }, () => "+x"))],
      capped: true,
      droppedLines: 900,
      droppedHunks: 2,
    }),
  ]);
  const diff = state.nodes[0]?.activity[0]?.diff;
  assert.equal(diff?.droppedLines, 910);
  assert.equal(diff?.droppedHunks, 2);
});

test("DIFF CAP: past DIFF_BODIES_CAP a node keeps the counts and loses the lines", () => {
  /*
   * THE PER-NODE BOUND. `ACTIVITY_CAP` alone allows 400 diffs of ~12.8 KB on one
   * node — 5 MB of body on a response that is already 7 MB. Past the bodies cap an
   * edit still reports what it changed and stops carrying how.
   */
  const events: SseEvent[] = [agent("n1")];
  for (let i = 0; i < DIFF_BODIES_CAP + 2; i += 1) {
    events.push(diffEvent("n1", { path: `src/file${String(i)}.ts` }));
  }
  const activity = foldGraphAll(events).nodes[0]?.activity ?? [];
  const last = activity[activity.length - 1]?.diff;
  assert.ok(last !== undefined);
  assert.deepEqual(last.hunks, [], "the body must stop growing once the node's budget is spent");
  assert.equal(last.additions, 2, "the counts are the part that never stops being reported");
  assert.equal(last.capped, true);
  assert.equal(
    activity[0]?.diff?.hunks.length,
    1,
    "the EARLY diffs keep their bodies; the cap is a ceiling, not a switch",
  );
});

test("SECURITY: the owner's home directory never reaches the canvas", () => {
  /*
   * ESTABLISHED BY READING THE PERSISTENCE PATH, NOT BY TRUSTING A NAME.
   * `db.ts:1011` runs every event through `redactForPersistence`, which recurses
   * arrays and nested objects — so hunk lines ARE covered — but every rule in
   * `bakeoff/src/redact.ts` is a CREDENTIAL rule. There is no path rule, and
   * `/Users/<name>/...` matches none of them. Without this scrub the owner's home
   * directory is persisted, served and rendered verbatim.
   *
   * IT REWRITES THE HOME PREFIX AND LEAVES THE PATH A PATH. A blanket `[REDACTED]`
   * would make every diff card unattributable.
   */
  const state = foldGraphAll([
    agent("n1"),
    narration("n1", "I read /Users/kamilborzecki/Projects/coding-agent/dashboard/src/app/page.tsx"),
    diffEvent("n1", {
      path: "/Users/kamilborzecki/Projects/coding-agent/site/index.html",
      hunks: [hunk(["+import x from '/home/runner/work/thing.ts';"])],
    }),
  ]);
  const activity = state.nodes[0]?.activity ?? [];
  const rendered = JSON.stringify(activity);
  assert.ok(
    !rendered.includes("/Users/kamilborzecki"),
    "an absolute host path reached the canvas — nothing on the persistence path removes one",
  );
  assert.ok(!rendered.includes("/home/runner"), "a POSIX home outside macOS was left intact");
  assert.equal(activity[0]?.detail, "I read ~/Projects/coding-agent/dashboard/src/app/page.tsx");
  assert.equal(activity[1]?.diff?.path, "~/Projects/coding-agent/site/index.html");
});

/* ==================================================================
 * THE PRE-BUILD LANE — ask D, and the durable seam under it
 *
 * WHY IT IS FOLDED HERE AT ALL. The client's `spec-pipeline.ts` derived these
 * stages from the live `trace` sink, and `use-run-stream.ts:820-822` never opens
 * a socket for a terminal run — so every stage was blank on every finished run,
 * which is every run the owner opens after the fact. These tests all fold from a
 * plain event list, which is exactly what the durable snapshot does.
 * ================================================================== */

function log(text: string, at?: string): SseEvent | SseWireEvent {
  const event = { type: "log", level: "info", text } as const;
  return at === undefined ? event : { ...event, at };
}

function stageState(state: GraphState, id: string): string | undefined {
  return state.stages?.find((stage) => stage.id === id)?.state;
}

test("LANE: the plan phase draws ONE stage and the orchestrator, never five", () => {
  /*
   * PRESERVED FROM `spec-pipeline.ts`, WHOSE COMMENT ARGUES IT AT LENGTH: drawing
   * `capture` as running while the plan is still open claims a page is being
   * fetched that nothing has started, and four grey rows for stages nobody has
   * reported say nothing. One stage, in the phase the run is actually in — plus
   * the orchestrator, which is the owner's ask and must be representable BEFORE
   * any agent has spawned.
   */
  const state = foldGraphAll([{ type: "phase", phase: "plan" }]);
  assert.deepEqual(state.stages?.map((stage) => stage.id), ["plan", "orchestrator"]);
  assert.equal(stageState(state, "plan"), "running");
  assert.equal(stageState(state, "orchestrator"), "pending");
  assert.deepEqual(state.nodes, [], "the lane is not made of agents and must mint no node");
});

test("LANE: every state is read off a line the server wrote", () => {
  /*
   * NOTHING HERE IS A TIMER. Each stage below moves because of a sentence in the
   * stream, and the two nobody spoke about stay `pending` — which is true ("we
   * have not been told") rather than lit on a guess.
   *
   * `audit` STAYS PENDING ON PURPOSE. The audit runs interleaved with authoring
   * inside `authorAndFreezeSuite` and the server reports only its token total at
   * the end, so this cannot show the audit starting and does not pretend to.
   */
  const state = foldGraphAll([
    { type: "phase", phase: "plan" },
    log("the plan dialogue is folded into the brief", "2026-08-04T11:00:00.000Z"),
    { type: "phase", phase: "spec" },
    log("captured https://example.com — 41 elements", "2026-08-04T11:01:00.000Z"),
    log("authoring the held-out acceptance suite", "2026-08-04T11:02:00.000Z"),
  ]);
  assert.equal(stageState(state, "plan"), "done");
  assert.equal(stageState(state, "capture"), "done");
  assert.equal(stageState(state, "author"), "running");
  assert.equal(stageState(state, "audit"), "pending");
  assert.equal(stageState(state, "freeze"), "pending");
  assert.equal(
    state.stages?.find((stage) => stage.id === "capture")?.at,
    "2026-08-04T11:01:00.000Z",
    "the stage carries the SERVER's instant for the line that set it",
  );
  assert.equal(
    state.stages?.find((stage) => stage.id === "capture")?.detail,
    "captured https://example.com — 41 elements",
    "a finished stage shows the sentence the server wrote, not one written here",
  );
});

test("LANE: a reused suite is not a pipeline", () => {
  // The ticket's text already had a sealed suite, so nothing is authored and
  // nothing is audited. Three stages that could never move would invent work that
  // is not happening, so they are removed rather than left grey.
  const state = foldGraphAll([
    { type: "phase", phase: "spec" },
    log("reusing the sealed acceptance suite for this ticket"),
  ]);
  assert.deepEqual(state.stages?.map((stage) => stage.id), ["freeze", "orchestrator"]);
  assert.equal(stageState(state, "freeze"), "done");
});

test("LANE: it survives the build boundary instead of deleting itself", () => {
  /*
   * THE GUARD THIS REPLACES: `spec-pipeline.ts:246`'s `if (phase !== "spec")
   * return []`, which deleted the whole lane the moment the build began — so the
   * owner's single continuous canvas could not exist. Here the finished stages
   * stay finished and the orchestrator lights up beside them.
   */
  const state = foldGraphAll([
    { type: "phase", phase: "spec" },
    log("captured https://example.com"),
    log("spec seat — anthropic: 14 input, 40187 cache read"),
    log("audit seat — anthropic: 9 input"),
    log("sealed suite 4f2a — frozen"),
    { type: "phase", phase: "build" },
    agent("n1"),
  ]);
  assert.equal(stageState(state, "capture"), "done");
  assert.equal(stageState(state, "author"), "done");
  assert.equal(stageState(state, "audit"), "done");
  assert.equal(stageState(state, "freeze"), "done");
  assert.equal(stageState(state, "orchestrator"), "running");
  assert.deepEqual(nodeIds(state), ["n1"], "the agent graph and the lane coexist");
});

test("LANE: a stage the run moved past while running is `unresolved`, never `pending`", () => {
  /*
   * RULE 4, APPLIED TO THE LANE. `pending` on a run that is over reads as "still
   * to come" and `failed` is a claim nothing made. The client's older
   * `SpecStageState` had no word for this and chose `pending`; this one does.
   *
   * BOTH DOORS ARE CHECKED: the phase moving on (the author, mid-turn) and the run
   * ending (the orchestrator, mid-build).
   */
  const moved = foldGraphAll([
    { type: "phase", phase: "spec" },
    log("authoring the held-out acceptance suite"),
    { type: "phase", phase: "build" },
  ]);
  assert.equal(stageState(moved, "author"), "unresolved");

  const stopped = foldGraphAll([
    { type: "phase", phase: "spec" },
    { type: "phase", phase: "build" },
    { type: "status", status: "cancelled" },
  ]);
  assert.equal(stageState(stopped, "orchestrator"), "unresolved");
  assert.notEqual(stageState(stopped, "orchestrator"), "failed");
});

test("LANE: the orchestrator closes on a PHASE, never on a passing run", () => {
  /*
   * A TERMINAL `status` IS A STATEMENT ABOUT THE RUN, NOT ABOUT THE ORCHESTRATOR.
   * The run leaving the build phase is a recorded fact that the build finished;
   * `status: passed` is a fact about the gate, three phases later, and reading it
   * backwards onto the orchestrator would be the fold inventing a transition.
   */
  const state = foldGraphAll([
    { type: "phase", phase: "spec" },
    { type: "phase", phase: "build" },
    { type: "phase", phase: "gate" },
    { type: "status", status: "passed" },
  ]);
  assert.equal(stageState(state, "orchestrator"), "done");
});

test("LANE: a stream that never mentions a pre-build phase folds to no `stages` KEY", () => {
  /*
   * THE COMPATIBILITY INVARIANT, AND IT IS LOAD-BEARING RATHER THAN TIDY. Every
   * run recorded before the phases existed is `log`/`tool`/`status` plus at most
   * `phase: build`, and rule 3 requires those to fold to an empty canvas with no
   * feature flag. `undefined` and `[]` are also not two spellings of one fact: the
   * key's ABSENCE is what says this stream never mentioned a lane, and it is what
   * keeps `deepEqual(body, {atSeq, nodes, edges, inventory})` in `api.test.ts`
   * describing the same object it always did.
   */
  const state = foldGraphAll([
    { type: "status", status: "queued" },
    { type: "phase", phase: "build" },
    { type: "log", level: "info", text: "an old run" },
    { type: "tool", name: "Read", summary: "a.ts" },
    { type: "status", status: "passed" },
  ]);
  assert.deepEqual(state, emptyGraph());
  assert.equal(state.stages, undefined);
  assert.ok(!("stages" in state), "the key itself must be absent, not present and empty");
});

test("LANE: an unrecognised log line returns the SAME state object", () => {
  // A build emits tens of thousands of log rows. Every one of them is now tested
  // against these patterns, and a new object for a line that matched nothing would
  // re-render the client canvas on each of them.
  const state = foldGraphAll([{ type: "phase", phase: "spec" }, agent("n1")]);
  assert.equal(foldGraph(state, log("Bash: npm run build")), state);
  assert.equal(foldGraph(state, { type: "phase", phase: "spec" }), state);
});

test("LANE: the lane survives a snapshot round-trip, which is the whole point", () => {
  /*
   * THE FAILURE THIS REPRODUCES IN A TEST INSTEAD OF IN PRODUCTION. The old
   * projection lived in the client and read the live `trace` sink, so it existed
   * only while you were watching: open the run afterwards and it was gone. The
   * server's snapshot route is `foldGraphAll(rows)` -> `JSON.stringify`, and the
   * browser then folds the live tail onto the parsed result — so this drives the
   * exact seam.
   *
   * MUTATION: drop `stages` from the serialised snapshot (`const {stages, ...rest}
   * = folded`), which is precisely what `use-run-graph.ts:204` does today by
   * rebuilding the object field by field. The first assertion below goes red,
   * naming the stage that vanished, and the SECOND one — folding the tail onto a
   * laneless snapshot — shows what the user would actually see: a run whose
   * pre-build lane restarts from whatever the tail happens to mention.
   */
  const durable: (SseEvent | SseWireEvent)[] = [
    { type: "phase", phase: "spec" },
    log("captured https://example.com", "2026-08-04T11:01:00.000Z"),
    log("sealed suite 4f2a — frozen", "2026-08-04T11:40:00.000Z"),
  ];
  const snapshot = foldGraphAll(durable);
  const reloaded = JSON.parse(JSON.stringify(snapshot)) as GraphState;

  assert.deepEqual(
    reloaded.stages?.map((stage) => `${stage.id}:${stage.state}`),
    [
      "capture:done",
      "author:pending",
      "audit:pending",
      "freeze:done",
      "orchestrator:pending",
    ],
    "the pre-build lane did not survive serialisation, so every finished run shows none of it",
  );
  assert.equal(
    reloaded.stages?.find((stage) => stage.id === "capture")?.at,
    "2026-08-04T11:01:00.000Z",
    "the recorded instant did not survive the round trip",
  );

  // AND THE TAIL FOLDS ONTO IT, which is what the browser does after the snapshot
  // settles. The stages already in the reloaded state must be built on, not reset.
  const live = foldGraph(reloaded, { type: "phase", phase: "build" });
  assert.equal(stageState(live, "orchestrator"), "running");
  assert.equal(stageState(live, "capture"), "done", "the replayed half of the lane was lost");
});
