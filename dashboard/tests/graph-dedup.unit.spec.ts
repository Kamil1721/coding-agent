/**
 * The seq watermark — the guard that keeps the canvas from counting the run
 * twice.
 *
 * THE FAILURE THIS PINS DOWN. The snapshot endpoint folds every durable row up
 * to `atSeq`; the socket then REPLAYS FROM ZERO, because the trace pane wants
 * the whole history. Those are the same rows. `foldGraph` is not idempotent —
 * `graph_tool` increments a call count — so a client that folds the replay on
 * top of the snapshot does not go stale, it goes WRONG: every tool pill on the
 * run reads double. `use-run-graph.ts` drops any frame at or below the
 * watermark, and this spec is the thing that notices if that line leaves.
 *
 * It runs with no browser. The reducer is a pure function of (state, action),
 * the fixture's rows are the real event union, and the base state is folded by
 * the real `foldGraphAll` — so "the snapshot, then its own replay" is
 * reproduced exactly, at the speed of arithmetic.
 */

import { expect, test } from "@playwright/test";

import type { GraphState } from "../src/lib/api-types";
import { emptyGraph } from "../src/lib/graph";
import { UNKNOWN_SEQ, graphReducer } from "../src/lib/use-run-graph";
import { RUN_ID } from "./fixtures/config";
import { AT_SEQ, GRAPH_EVENTS, GRAPH_SNAPSHOT } from "./fixtures/run-fixture";

/**
 * The reducer's own types are module-private on purpose; reaching for them
 * through the function's signature keeps this spec honest about the shape
 * instead of declaring a parallel one that could drift.
 */
type Accumulator = Parameters<typeof graphReducer>[0];

const START: Accumulator = {
  runId: null,
  state: emptyGraph(),
  atSeq: 0,
  settled: false,
};

/** The discriminator: `root` called `Read` exactly twice. */
function readCount(state: GraphState): number {
  const root = state.nodes.find((node) => node.id === "root");
  if (root === undefined) throw new Error("fixture lost its root node");
  return root.tools.find((tool) => tool.name === "Read")?.count ?? 0;
}

/** The state as the browser has it the instant the snapshot lands. */
function settled(): Accumulator {
  const reset = graphReducer(START, { kind: "reset", runId: RUN_ID });
  return graphReducer(reset, {
    kind: "snapshot",
    state: GRAPH_SNAPSHOT,
    atSeq: AT_SEQ,
  });
}

test("the snapshot lands with the run's real counts", () => {
  const base = settled();
  expect(base.settled).toBe(true);
  expect(base.atSeq).toBe(AT_SEQ);
  expect(readCount(base.state)).toBe(2);
  expect(base.state.nodes.map((node) => node.id).sort()).toEqual([
    "builder",
    "guard",
    "reviewer",
    "root",
  ]);
});

test("the stream's replay of rows the snapshot already folded is not counted again", () => {
  const base = settled();

  // Exactly what `attachSse` sends on connect: every durable row from the
  // beginning, each carrying its own seq as the frame's `id:`.
  let accumulator = base;
  GRAPH_EVENTS.forEach((event, index) => {
    accumulator = graphReducer(accumulator, {
      kind: "event",
      event,
      seq: index + 1,
    });
  });

  // Two, not four. Four is what this reads with the watermark guard deleted.
  expect(readCount(accumulator.state)).toBe(2);
  expect(accumulator.atSeq).toBe(AT_SEQ);
  expect(accumulator.state.nodes).toHaveLength(4);

  // Nothing changed at all, down to object identity — which is also what keeps
  // the canvas from re-rendering on every replayed log line.
  expect(accumulator.state).toBe(base.state);
  expect(accumulator).toBe(base);
});

test("a row PAST the watermark still folds — the guard is a watermark, not a mute", () => {
  const base = settled();

  const next = graphReducer(base, {
    kind: "event",
    event: {
      type: "graph_tool",
      node: "root",
      name: "Read",
      mcpServer: null,
      summary: "third read, live",
      attribution: "exact",
    },
    seq: AT_SEQ + 1,
  });

  expect(readCount(next.state)).toBe(3);
  expect(next.atSeq).toBe(AT_SEQ + 1);
  expect(next.state).not.toBe(base.state);
});

test("a frame the browser could not put a seq on is folded rather than dropped", () => {
  const base = settled();

  const next = graphReducer(base, {
    kind: "event",
    event: {
      type: "graph_tool",
      node: "root",
      name: "Read",
      mcpServer: null,
      summary: "no id line on this frame",
      attribution: "exact",
    },
    seq: UNKNOWN_SEQ,
  });

  // Folded — an unidentifiable frame is not silently lost — and the watermark
  // does not move, because there is no number to move it to.
  expect(readCount(next.state)).toBe(3);
  expect(next.atSeq).toBe(AT_SEQ);
});

test("a reconnect that replays the tail as well is still counted once", () => {
  // The tail: one row past the snapshot, folded live.
  const live = graphReducer(settled(), {
    kind: "event",
    event: {
      type: "graph_tool",
      node: "root",
      name: "Read",
      mcpServer: null,
      summary: "third read, live",
      attribution: "exact",
    },
    seq: AT_SEQ + 1,
  });
  expect(readCount(live.state)).toBe(3);

  // The socket drops and replays everything, including the row above.
  let accumulator = live;
  [...GRAPH_EVENTS].forEach((event, index) => {
    accumulator = graphReducer(accumulator, {
      kind: "event",
      event,
      seq: index + 1,
    });
  });
  accumulator = graphReducer(accumulator, {
    kind: "event",
    event: {
      type: "graph_tool",
      node: "root",
      name: "Read",
      mcpServer: null,
      summary: "third read, replayed",
      attribution: "exact",
    },
    seq: AT_SEQ + 1,
  });

  expect(readCount(accumulator.state)).toBe(3);
  expect(accumulator.atSeq).toBe(AT_SEQ + 1);
});
