/**
 * layout.ts — where every node sits, and nothing else.
 *
 * PURE AND SEPARATE FROM THE RENDERER on purpose: placement is the part of the
 * canvas that has a right answer, so it is a function that can be called from a
 * test rather than behaviour that only a browser can observe.
 *
 * THE TWO AXES ARE DECIDED BY DIFFERENT THINGS, AND NEITHER IS A GUESS.
 *
 *   x — THE LANE. `graph_agent` carries the lane the server derived from the
 *       agent's own name (`laneOf`), so the columns are authored, not inferred
 *       from graph shape. Lane-less nodes — the root session, anything the CLI
 *       named nothing for — take column 0, which is also where the delegation
 *       arrows start. No dagre, no elk: the x-axis was never free.
 *
 *   y — FIRST SIGHTING, AND IT NEVER MOVES AGAIN (spec §9.3). `foldGraph`
 *       appends nodes in arrival order and never re-sorts, so a node's row is
 *       its index among the nodes already in its column. That is what makes the
 *       layout STICKY: an agent that appears at minute 40 lands under the ones
 *       already drawn instead of shuffling forty nodes under the reader's
 *       cursor. Sorting by state, duration or name would all look tidier and
 *       all break this.
 *
 * SPACING IS DELIBERATELY LOOSE. The gutters below are wide enough that every
 * edge has visible run length rather than nodes butting into each other — the
 * one change the owner asked for against the reference image. `estimateHeight`
 * OVER-estimates for the same reason: a wrong guess adds whitespace, never
 * overlap, and whitespace is what was asked for.
 */

import type { GraphNode, GraphState, RunLane } from "@/lib/api-types";

/** Card width. Also `--node-width` in globals.css; change both together. */
export const NODE_WIDTH = 268;

/** Horizontal gap BETWEEN cards, not between column origins. */
export const COLUMN_GAP = 176;
export const COLUMN_STEP = NODE_WIDTH + COLUMN_GAP;

/** Vertical gap between two cards in the same column. */
export const ROW_GAP = 64;

/** Headroom above the first card, where the lane label sits. */
export const LANE_LABEL_HEIGHT = 52;

/**
 * How many pills of each kind a card shows before it collapses the rest into a
 * `+N` chip.
 *
 * The reducer already caps DISTINCT names at 64 per node; this is the much
 * tighter display cap, and it is here rather than in the component so the
 * height estimate below and the render agree by construction.
 */
export const PILL_CAP = { skills: 4, tools: 6, hooks: 3 } as const;

/**
 * Column order.
 *
 * `null` is not in this list and does not need to be: it is column 0, ahead of
 * every lane, because that is where the session that delegates lives.
 */
export const LANE_ORDER: readonly RunLane[] = [
  "spec",
  "design",
  "build",
  "review",
  "gate",
];

export const LANE_LABEL: Readonly<Record<RunLane, string>> = {
  spec: "Spec",
  design: "Design",
  build: "Build",
  review: "Review",
  gate: "Gate",
};

export interface PlacedNode {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  /** Which lane column it landed in. `null` is the session column. */
  readonly lane: RunLane | null;
}

export interface PlacedLane {
  readonly lane: RunLane | null;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export interface Placement {
  readonly nodes: readonly PlacedNode[];
  readonly lanes: readonly PlacedLane[];
  /** Edges whose BOTH ends survived the ambient filter. */
  readonly edges: readonly { readonly from: string; readonly to: string; readonly inferred: boolean }[];
}

/**
 * A card's height, over-estimated.
 *
 * Every constant is the CSS box it names, rounded up. Under-estimating would
 * overlap two cards; over-estimating adds air, which is the direction this
 * canvas is supposed to err in.
 */
export function estimateHeight(node: GraphNode): number {
  // padding 16 top + 16 bottom, lane/status header row, title row.
  let height = 32 + 22 + 22;

  // Description is clamped to two lines and the row is reserved either way, so
  // cards in a column keep a shared baseline instead of jittering by a line.
  height += 36;

  const rows = (count: number, cap: number, perRow: number): number =>
    count === 0 ? 0 : Math.ceil(Math.min(count, cap + 1) / perRow) * 26 + 6;

  height += rows(node.skills.length, PILL_CAP.skills, 2);
  height += rows(node.tools.length, PILL_CAP.tools, 2);
  height += rows(node.hooks.length, PILL_CAP.hooks, 2);

  // The counters strip along the bottom.
  if (node.toolCalls > 0 || node.result !== null) height += 28;

  return height;
}

function columnKey(node: GraphNode): RunLane | null {
  return node.lane;
}

function columnIndexOf(lane: RunLane | null): number {
  if (lane === null) return 0;
  const index = LANE_ORDER.indexOf(lane);
  // A lane the client does not know is placed AFTER the known ones rather than
  // folded into column 0, where it would sit among the orchestrators and read
  // as one.
  return index === -1 ? LANE_ORDER.length + 1 : index + 1;
}

/**
 * Place a folded graph.
 *
 * `showAmbient: false` drops the CLI's `skip_transcript` housekeeping agents —
 * the contract's own default — and, with them, any edge that would have ended
 * at one. An edge to a node that is not on screen is not a fainter edge, it is
 * a line pointing at nothing.
 */
export function placeGraph(
  graph: GraphState,
  options: { readonly showAmbient: boolean },
): Placement {
  const visible = options.showAmbient
    ? graph.nodes
    : graph.nodes.filter((node) => !node.ambient);

  // Empty columns are removed BEFORE positions are assigned, so a run that only
  // ever used `build` does not open with four lanes of nothing.
  const occupied: (RunLane | null)[] = [];
  for (const node of visible) {
    const key = columnKey(node);
    if (!occupied.includes(key)) occupied.push(key);
  }
  occupied.sort((a, b) => columnIndexOf(a) - columnIndexOf(b));

  const xOf = new Map<RunLane | null, number>();
  occupied.forEach((lane, index) => xOf.set(lane, index * COLUMN_STEP));

  const cursor = new Map<RunLane | null, number>();
  const counts = new Map<RunLane | null, number>();
  const stacked: PlacedNode[] = [];

  for (const node of visible) {
    const lane = columnKey(node);
    const x = xOf.get(lane) ?? 0;
    const y = cursor.get(lane) ?? LANE_LABEL_HEIGHT;
    stacked.push({ node, x, y, lane });
    cursor.set(lane, y + estimateHeight(node) + ROW_GAP);
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }

  /*
   * COLUMNS ARE CENTRED AGAINST A SHARED AXIS, NOT TOP-ALIGNED.
   *
   * Top-aligning them looks tidy in a diagram and reads badly in practice: a
   * run with one spec agent and four build agents puts the session card in the
   * top-left corner with three quarters of the canvas empty underneath it, and
   * every edge leaving it rakes downward. Centring pulls the parent level with
   * the middle of the fan it produced, which is the shape the delegation
   * actually has and the shape the owner's reference draws.
   *
   * ROW ORDER INSIDE A COLUMN IS UNTOUCHED. This shifts a whole column by one
   * offset; it never reorders, so the sticky first-sighting rule survives it.
   */
  let tallest = 0;
  const columnHeight = new Map<RunLane | null, number>();
  for (const lane of occupied) {
    const height = (cursor.get(lane) ?? LANE_LABEL_HEIGHT) - ROW_GAP - LANE_LABEL_HEIGHT;
    columnHeight.set(lane, height);
    tallest = Math.max(tallest, height);
  }

  const placed: PlacedNode[] = stacked.map((entry) => ({
    ...entry,
    y: entry.y + Math.round((tallest - (columnHeight.get(entry.lane) ?? 0)) / 2),
  }));

  /*
   * A LANE LABEL SITS ON ITS OWN COLUMN, not on a shared top rule.
   *
   * Pinning every label to y = 0 draws a straight header line, and centring the
   * columns then leaves a sparse lane's label floating hundreds of pixels above
   * the single card it names — far enough that at the default zoom the label is
   * off-screen while the card is not. A ragged row of labels that each touch
   * their own column is the less tidy diagram and the more readable one.
   */
  const firstCardY = new Map<RunLane | null, number>();
  for (const entry of placed) {
    const current = firstCardY.get(entry.lane);
    if (current === undefined || entry.y < current) firstCardY.set(entry.lane, entry.y);
  }

  const lanes: PlacedLane[] = occupied.map((lane) => ({
    lane,
    label: lane === null ? "Session" : (LANE_LABEL[lane] ?? String(lane)),
    x: xOf.get(lane) ?? 0,
    y: (firstCardY.get(lane) ?? LANE_LABEL_HEIGHT) - LANE_LABEL_HEIGHT,
    count: counts.get(lane) ?? 0,
  }));

  const onScreen = new Set(placed.map((entry) => entry.node.id));
  const edges = graph.edges
    .filter((edge) => onScreen.has(edge.from) && onScreen.has(edge.to))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      inferred: edge.attribution === "inferred",
    }));

  return { nodes: placed, lanes, edges };
}
