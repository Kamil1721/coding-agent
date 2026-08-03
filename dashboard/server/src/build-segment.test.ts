import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphSseEvent } from "./api-types.js";
import { graphResumeState, makeSegmentRemap, nextBuildSegment } from "./build-segment.js";

function segment(over: Partial<Parameters<typeof nextBuildSegment>[0]> = {}) {
  return nextBuildSegment({
    laneMode: "full",
    manifestExists: false,
    manifestLocked: false,
    sessionId: null,
    designSegmentDone: false,
    // THE PRE-2026-08-03 SHAPE IS THE DEFAULT: no directions, so no choice and
    // nothing to expand. Every test written before the canvass therefore keeps
    // measuring exactly what it measured, which is the point — a lane that does
    // not canvass must degrade to today's behaviour rather than hang.
    directionsOffered: false,
    directionChosen: false,
    expanded: false,
    ...over,
  });
}

test("a fresh visual run starts in the DESIGN segment", () => {
  assert.equal(segment(), "design");
});

test("a run with no DESIGN lane goes straight to BUILD", () => {
  assert.equal(segment({ laneMode: "off" }), "build");
});

test("a LOCKED manifest means the design segment is finished — build next", () => {
  assert.equal(segment({ sessionId: "s1", manifestExists: true, manifestLocked: true }), "build-resume");
});

test("THE TRAP IN THIS TASK: an interrupted DESIGN segment resumes as DESIGN, not as BUILD", () => {
  // `resuming = row.builderSessionId !== null` (orchestrator.ts:624) is TRUE for
  // both a rate-limited design segment and a post-lock build segment. Reading
  // only that flag sends `resumeBuilderPrompt("the dashboard was interrupted")`,
  // which names no locked mockup — §7.3 mechanism 2 then fails with nothing
  // reporting it, and the build looks successful.
  assert.equal(
    segment({ sessionId: "s1", manifestExists: false, manifestLocked: false, designSegmentDone: false }),
    "design-resume",
  );
  assert.equal(
    segment({ sessionId: "s1", manifestExists: true, manifestLocked: false, designSegmentDone: false }),
    "design-resume",
    "a manifest with no lock is still an unfinished design segment",
  );
});

test("a degraded lane still runs a DESIGN segment — written direction is design work", () => {
  assert.equal(segment({ laneMode: "degraded" }), "design");
  assert.equal(
    segment({ laneMode: "degraded", sessionId: "s1", designSegmentDone: true }),
    "build-resume",
    "and it hands over without a lock, because there is nothing to lock",
  );
});

/* ---- node identity across the two segments ---------------------------- */

function agentEvent(node: string, parent: string | null, agent: string): GraphSseEvent {
  return {
    type: "graph_agent",
    node,
    parent,
    agent,
    lane: null,
    description: "d",
    ambient: false,
    attribution: "exact",
    sdk: null,
  };
}

function toolEvent(node: string, name: string): GraphSseEvent {
  return { type: "graph_tool", node, name, mcpServer: null, summary: "s", attribution: "exact" };
}

function resultEvent(node: string): GraphSseEvent {
  return {
    type: "graph_result",
    node,
    state: "completed",
    summary: "done",
    totalTokens: null,
    toolUses: null,
    durationMs: null,
    attribution: "exact",
  };
}

const SEGMENT_ONE: readonly GraphSseEvent[] = [
  agentEvent("n1", null, "orchestrator"),
  agentEvent("n2", "n1", "taste-frontend-expert"),
  toolEvent("n2", "Bash"),
  agentEvent("n3", "n1", "ui-designer"),
];

test("graphResumeState finds the root and the high-water mark", () => {
  const state = graphResumeState(SEGMENT_ONE);
  assert.equal(state.rootNode, "n1");
  assert.equal(state.minted, 3);
});

test("the high-water mark is a MAX, not the last id seen — a segment does not end on its highest node", () => {
  // Written because the docblock's claim had no check behind it: with SEGMENT_ONE
  // alone (n1, n2, n2, n3) `Math.max` and "last seen" are indistinguishable, so
  // dropping the max stayed green. A real segment ends on whatever finished last
  // — `graph_result{node:"n1"}` for the run's own session routinely lands after a
  // later agent's `graph_agent`. Last-seen would hand segment 2 a mark of 1 and
  // put its build agent straight back on top of the designer.
  const outOfOrder: readonly GraphSseEvent[] = [...SEGMENT_ONE, resultEvent("n1")];
  assert.equal(graphResumeState(outOfOrder).minted, 3);
  assert.equal(graphResumeState(outOfOrder).rootNode, "n1");
});

test("SEGMENT 2's NODES DO NOT COLLIDE WITH SEGMENT 1's", () => {
  // Without this, foldGraph drops segment 2's graph_agent for n2 and every
  // graph_tool{node:"n2"} from the build lands on taste-frontend-expert's node.
  // The canvas still renders, which is what makes it dangerous.
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const rebuilt = [
    agentEvent("n1", null, "orchestrator"),
    agentEvent("n2", "n1", "nextjs-developer"),
    toolEvent("n2", "Write"),
  ].map(remap);

  const builder = rebuilt[1] as Extract<GraphSseEvent, { type: "graph_agent" }>;
  assert.notEqual(builder.node, "n2", "the build agent must not reuse the designer's node id");
  assert.equal(builder.node, "n4");
  assert.equal((rebuilt[2] as Extract<GraphSseEvent, { type: "graph_tool" }>).node, "n4");
});

test("segment 2's ROOT maps back onto segment 1's root — one session, one root node", () => {
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const root = remap(agentEvent("n1", null, "orchestrator")) as Extract<GraphSseEvent, { type: "graph_agent" }>;
  assert.equal(root.node, "n1", "the resumed session is the SAME session, not a second one");
});

test("a parent reference inside segment 2 is remapped too — an edge to a dropped node is an edge to nothing", () => {
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const events = [agentEvent("n1", null, "orchestrator"), agentEvent("n2", "n1", "nextjs-developer")].map(remap);
  const child = events[1] as Extract<GraphSseEvent, { type: "graph_agent" }>;
  assert.equal(child.parent, "n1");
});

test("graph_inventory passes through untouched — it names no node", () => {
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const inventory: GraphSseEvent = {
    type: "graph_inventory",
    agents: 1, skills: 2, tools: 3,
    allowedAgents: ["a"], mcpServers: [], plugins: [],
    model: "m", claudeCodeVersion: "v", environmentHash: "h",
  };
  assert.deepEqual(remap(inventory), inventory);
});

test("a first segment that emitted nothing yields a remap that changes nothing", () => {
  const remap = makeSegmentRemap(graphResumeState([]));
  const event = agentEvent("n1", null, "orchestrator");
  assert.deepEqual(remap(event), event);
});

/**
 * THE CONSEQUENCE, NOT A SECOND CHECK.
 *
 * Stated plainly so nobody counts this twice: its failure mode is a SUBSET of
 * "SEGMENT 2's NODES DO NOT COLLIDE WITH SEGMENT 1's" — any id-level mutation
 * reds both. What it adds is the other thing this repo keeps getting wrong: it
 * connects the id assertion to the production consumer. `foldGraph` is what
 * actually drops the repeated `graph_agent`, and without running it the remap's
 * tests only prove two strings differ, never that the difference matters.
 */
test("FOLD-LEVEL PROOF: without the remap, the build's tools land on the designer's node", async () => {
  const { foldGraphAll } = await import("./graph.js");
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const state = foldGraphAll([
    ...SEGMENT_ONE,
    ...[agentEvent("n1", null, "orchestrator"), agentEvent("n2", "n1", "nextjs-developer"), toolEvent("n2", "Write")].map(remap),
  ]);
  const designer = state.nodes.find((n) => n.agent === "taste-frontend-expert");
  assert.ok(designer !== undefined);
  assert.equal(
    designer.tools.some((t) => t.name === "Write"), false,
    "the build agent's Write pill is attached to the DESIGNER's node",
  );
  assert.ok(state.nodes.some((n) => n.agent === "nextjs-developer"), "the build agent has a node of its own");
});

/**
 * A THIRD CALL IS REAL, so the remap has to be applicable twice.
 *
 * `BuildSegment` carries `"build-resume"`: a rate limit inside segment 2 resumes
 * the same session a third time. The high-water mark for that call is read off
 * the ALREADY-REMAPPED stream, so a remap that only worked against a pristine
 * first segment would collide on the third call instead of the second.
 */
test("remaps compose — a third segment extends the graph again rather than restarting", () => {
  const segmentTwo = [
    agentEvent("n1", null, "orchestrator"),
    agentEvent("n2", "n1", "nextjs-developer"),
    toolEvent("n2", "Write"),
  ].map(makeSegmentRemap(graphResumeState(SEGMENT_ONE)));

  const afterTwo = graphResumeState([...SEGMENT_ONE, ...segmentTwo]);
  assert.equal(afterTwo.rootNode, "n1", "still one root after two segments");
  assert.equal(afterTwo.minted, 4);

  const segmentThree = [
    agentEvent("n1", null, "orchestrator"),
    agentEvent("n2", "n1", "ui-designer"),
  ].map(makeSegmentRemap(afterTwo));
  assert.equal((segmentThree[0] as Extract<GraphSseEvent, { type: "graph_agent" }>).node, "n1");
  assert.equal((segmentThree[1] as Extract<GraphSseEvent, { type: "graph_agent" }>).node, "n5");
});

/* ══ THE TWO-STAGE DESIGN LANE (2026-08-03) ════════════════════════════════ */

test("A CANVASS AWAITING A CHOICE IS NOT A FINISHED DESIGN", () => {
  // The canvass segment RETURNED, so `designSegmentDone` is true — and without
  // the second clause of `designFinished` the run would fall through to the build
  // arm the moment anything requeued it, and the owner's choice would decide
  // nothing. Nothing is locked either: stage B has not run.
  assert.equal(
    segment({ designSegmentDone: true, directionsOffered: true, directionChosen: false, sessionId: "s1" }),
    "design-resume",
  );
});

test("A CHOSEN DIRECTION IS THE NEXT WORK, WHATEVER ELSE IS TRUE", () => {
  // THE ORDER IS THE TEST. On the full path `designSegmentDone` is already true
  // when the choice lands, so a `designFinished` check ahead of the expand arm
  // answers "yes" and goes straight to the build — skipping the expansion and
  // building to two canvass stills.
  assert.equal(
    segment({ designSegmentDone: true, directionsOffered: true, directionChosen: true, sessionId: "s1" }),
    "design-expand-resume",
  );
  assert.equal(
    segment({ designSegmentDone: true, directionsOffered: true, directionChosen: true, sessionId: null }),
    "design-expand",
  );
});

test("ONCE EXPANDED, THE BUILD RUNS — and `expanded` is what says so, not the lock", () => {
  // A DEGRADED RUN NEVER LOCKS A STILL: `refs` is empty, `heroRefFor` is null, no
  // lock is applied. Deriving "stage B is over" from `manifestLocked` would send
  // it round the expand arm on every pass until the loop bound ran out, and
  // `#buildPhase` would return WITHOUT EVER RUNNING THE BUILD SEGMENT. Degraded
  // runs build fine today; this is the regression that input exists to prevent.
  assert.equal(
    segment({
      laneMode: "degraded",
      designSegmentDone: true,
      directionsOffered: true,
      directionChosen: true,
      expanded: true,
      manifestLocked: false,
      sessionId: "s1",
    }),
    "build-resume",
  );
  // And on the full path, where the hero DID lock, the same answer.
  assert.equal(
    segment({
      designSegmentDone: true,
      directionsOffered: true,
      directionChosen: true,
      expanded: true,
      manifestLocked: true,
      sessionId: "s1",
    }),
    "build-resume",
  );
});

test("THE THREE PASSES OF AN `auto` RUN, IN ORDER — canvass, expand, build", () => {
  // The sequence `#buildPhase` walks in ONE entry with no park between, which is
  // why its loop bound had to move from 2 to 3.
  const canvass = segment({ sessionId: null });
  assert.equal(canvass, "design");
  const expand = segment({
    designSegmentDone: true,
    directionsOffered: true,
    directionChosen: true,
    sessionId: "s1",
  });
  assert.equal(expand, "design-expand-resume");
  const build = segment({
    designSegmentDone: true,
    directionsOffered: true,
    directionChosen: true,
    expanded: true,
    manifestLocked: true,
    sessionId: "s1",
  });
  assert.equal(build, "build-resume");
});

test("A LANE THAT NEVER CANVASSED DEGRADES TO TODAY'S BEHAVIOUR, NOT TO A HANG", () => {
  // `directionsOffered: false` is every manifest written before 2026-08-03 and
  // every lane that ignored the canvass ask. Both take the pre-canvass branch
  // verbatim: the design is finished when it is locked or when the segment
  // returned, and there is nothing to expand.
  assert.equal(segment({ designSegmentDone: true, sessionId: "s1" }), "build-resume");
  assert.equal(segment({ manifestLocked: true, sessionId: "s1" }), "build-resume");
  assert.equal(segment({ sessionId: "s1" }), "design-resume");
  // AND `laneMode: "off"` STILL SHORT-CIRCUITS EVERYTHING, directions or not.
  assert.equal(
    segment({ laneMode: "off", directionsOffered: true, directionChosen: true, sessionId: null }),
    "build",
  );
});
