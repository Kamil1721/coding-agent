/**
 * layout.ts — where every node sits, what it is grouped with, and nothing else.
 *
 * PURE AND SEPARATE FROM THE RENDERER on purpose: placement is the part of the
 * canvas that has a right answer, so it is a function that can be called from a
 * test rather than behaviour that only a browser can observe. The grouping rule
 * added below is in here for the same reason — it is the change the owner asked
 * for by name, so it had better be checkable without a browser.
 *
 * THE TWO AXES ARE DECIDED BY DIFFERENT THINGS, AND NEITHER IS A GUESS.
 *
 *   x — THE COLUMN. `graph_agent` carries the lane the server derived from the
 *       agent's own name (`laneOf`), so the pipeline columns are authored, not
 *       inferred from graph shape. No dagre, no elk: the x-axis was never free.
 *
 *   y — FIRST SIGHTING, AND IT NEVER MOVES AGAIN (spec §9.3). `foldGraph`
 *       appends nodes in arrival order and never re-sorts, so a node's row is
 *       its index among the nodes already in its column. That is what makes the
 *       layout STICKY: an agent that appears at minute 40 lands under the ones
 *       already drawn instead of shuffling forty nodes under the reader's
 *       cursor. Sorting by state, duration or name would all look tidier and
 *       all break this. A GROUP inherits the row of its FIRST member, so
 *       collapsing does not move anything either.
 *
 * WHAT CHANGED, AND WHY THE OWNER WAS RIGHT ABOUT IT.
 *
 * The run this was rebuilt against draws TEN sibling cards in one column under
 * the orchestrator — six of them captioned "Generate <section> design reference
 * image" — because every node the CLI named no lane for landed in column 0,
 * which is also the column the orchestrator itself sits in. So the root had ten
 * equal siblings and the graph read as a list with a title, not as a flow. Two
 * changes fix it, and both are structural rather than cosmetic:
 *
 *   1. THE ROOT GETS A COLUMN OF ITS OWN (`"root"`). It is the only node with no
 *      parent, so this is a fact about the graph, not a special case. Everything
 *      it did directly, and named no lane for, goes in `"tasks"` beside it.
 *
 *   2. REPEATED LEAF SIBLINGS COLLAPSE INTO ONE CARD. See `SIBLING_GROUP_KEY`
 *      below for the four things members must share and the three things that
 *      disqualify a node from ever being folded into a group. The short version:
 *      a group can never hide a failure, never hide a guess, and never hide a
 *      node that delegated to something else.
 *
 * SPACING IS DELIBERATELY LOOSE. The gutters below are wide enough that every
 * edge has visible run length rather than nodes butting into each other — the
 * one change the owner asked for against the connector reference. `estimateHeight`
 * OVER-estimates for the same reason: a wrong guess adds whitespace, never
 * overlap, and whitespace is what was asked for.
 */

import type { GraphNode, GraphNodeState, GraphState, RunLane } from "@/lib/api-types";
import { roleOf, type AgentRole } from "./roles";

/** Card width. Also `--node-width` in globals.css; change both together. */
export const NODE_WIDTH = 268;

/**
 * Horizontal gap BETWEEN cards, not between column origins.
 *
 * Wide enough that the cable bus has a gutter to run in: every edge entering a
 * column turns vertical at `COLUMN_GAP / 2` before it, so this number is also
 * the trunk's clearance from both neighbours.
 */
export const COLUMN_GAP = 184;
export const COLUMN_STEP = NODE_WIDTH + COLUMN_GAP;

/** Vertical gap between two cards in the same column. */
export const ROW_GAP = 64;

/** A group header and its expanded members sit closer than two unrelated cards. */
export const MEMBER_GAP = 22;

/** Headroom above the first card, where the column label sits. */
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

/** How many member captions a collapsed group lists before saying `+N more`. */
export const GROUP_PREVIEW = 3;

/**
 * The smallest run of identical siblings that is worth folding.
 *
 * THREE, NOT TWO, and the reason is what collapsing costs. A group replaces N
 * readable cards with one card and a click; at N = 2 that trades two visible
 * facts for one hidden pair and saves a single row, which is machinery for
 * nothing. At N = 3 the column is already reading as a stack rather than as a
 * flow, and the run this was built against has a run of SIX.
 */
export const MIN_GROUP = 3;

/**
 * Column order.
 *
 * `"root"` and `"tasks"` are not lanes and are not derived from `node.lane`:
 * `"root"` is the one node with no parent, `"tasks"` is everything else the CLI
 * named no lane for. `"tasks"` sits at index 1 — beside the root, ahead of the
 * pipeline — because that work is what the orchestrator did ITSELF, before and
 * beside delegating. Putting it after `gate` would read as a seventh pipeline
 * stage and would drag every one of its edges across the whole canvas.
 */
export type ColumnKey = "root" | "tasks" | RunLane;

export const COLUMN_ORDER: readonly ColumnKey[] = [
  "root",
  "tasks",
  "spec",
  "design",
  "build",
  "review",
  "gate",
];

export const COLUMN_LABEL: Readonly<Record<ColumnKey, string>> = {
  root: "Session",
  tasks: "Direct tasks",
  spec: "Spec",
  design: "Design",
  build: "Build",
  review: "Review",
  gate: "Gate",
};

export const COLUMN_NOTE: Readonly<Record<ColumnKey, string>> = {
  root: "The run's own session. Everything else was delegated from here.",
  tasks:
    "Work the orchestrator ran directly, that the CLI named no lane for. Repeated identical tasks are folded into one card.",
  spec: "Turning the ticket into requirements.",
  design: "Deciding how it should look.",
  build: "Writing it.",
  review: "Checking it.",
  gate: "The held-out gate.",
};

export interface PlacedNode {
  /** The React Flow node id. A node's own id, or `group:<n>` for a fold. */
  readonly key: string;
  readonly kind: "agent" | "group";
  /** The node itself, or a group's FIRST member as its representative. */
  readonly node: GraphNode;
  /** One entry for an agent; every folded sibling for a group. */
  readonly members: readonly GraphNode[];
  readonly role: AgentRole;
  readonly column: ColumnKey;
  /** True only for a group the reader has opened; its members follow it. */
  readonly expanded: boolean;
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

export interface PlacedColumn {
  readonly column: ColumnKey;
  readonly label: string;
  readonly note: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export interface PlacedEdge {
  readonly id: string;
  /** Placed keys, so an edge into a folded sibling arrives at the group. */
  readonly from: string;
  readonly to: string;
  readonly inferred: boolean;
  readonly fromRole: AgentRole;
  readonly toRole: AgentRole;
  /** The CHILD's state. "Is work moving down this edge" is a fact about it. */
  readonly childState: GraphNodeState;
  /**
   * The x the cable turns vertical at — shared by every edge from one source
   * into one column, which is what merges them into a single trunk instead of a
   * spray of near-identical curves. `null` when the target is not to the right
   * of the source, where a shared bend would route the cable backwards.
   */
  readonly centerX: number | null;
  /** Hops from the root. Drives the one-shot arrival sweep's stagger. */
  readonly depth: number;
}

export interface Placement {
  readonly nodes: readonly PlacedNode[];
  readonly columns: readonly PlacedColumn[];
  readonly edges: readonly PlacedEdge[];
  /** Groups that exist in this placement, collapsed or not. For the HUD. */
  readonly groupKeys: readonly string[];
  /** How many nodes are currently folded out of sight. 0 when all are open. */
  readonly foldedCount: number;
}

/**
 * A card's height, over-estimated — and the estimate is WORST CASE, not typical.
 *
 * Every constant is the CSS box it names, rounded up. The direction of the error
 * is the whole point: under-estimating overlaps two cards, over-estimating adds
 * air, and air is what this canvas was asked for.
 *
 * PILLS ARE COUNTED ONE PER ROW, WHICH IS THE ONLY TRUE UPPER BOUND. An earlier
 * version assumed two fit on a line. That holds for `Read` and `Bash` and stops
 * holding the moment a node calls `mcp__context7__get-library-docs`, because one
 * MCP tool name fills the 236px of inner width by itself.
 *
 * MEASURED, NOT ARGUED, AND THE MEASUREMENT IS LESS DRAMATIC THAN THE ARGUMENT.
 * A card seeded with six long `mcp__*` names renders 352px tall. The two-per-row
 * estimate called it 294px — a 58px under-shoot, which `ROW_GAP` (64px) absorbed
 * with SIX PIXELS to spare. So the old estimate never actually overlapped
 * anything on screen; it had spent all but 6px of the gap, and one more wrapped
 * row would have collided. This change removes the dependence on `ROW_GAP`
 * happening to be larger than the error, rather than fixing a visible defect,
 * and it costs about 50px of extra whitespace on a busy card — the direction
 * this canvas was asked to err in anyway.
 *
 * NOTHING IN THIS REPOSITORY CHECKS THE NO-OVERLAP PROPERTY TODAY, AND THE
 * EARLIER CLAIM THAT SOMETHING DID IS RETRACTED HERE.
 *
 * What existed was a scratchpad `verify.mjs` driving headless Chromium. It ran
 * once, on 2026-07-29; it was never added to the repository; it cannot be re-run,
 * and 66499b8's message already recorded that it did not go red on the estimate
 * this function replaced. A check that cannot fail AND cannot run is not
 * coverage, and a comment asserting one is worse than no comment: it is the
 * defect that commit fixed twice and re-introduced here.
 *
 * The measurements above are facts about a session that happened and they stand.
 * What is left is an ARGUMENT, and only part of it is airtight: one pill per row
 * is a true upper bound on the PILL BLOCK for any pill name, with no dependence
 * on `ROW_GAP` exceeding an error. The rest of the card — fixed header rows, a
 * two-line clamp on the description — is an assumption about the CSS, and a
 * title that ever wrapped to three lines would break it silently.
 *
 * The property is "this number is >= what the browser renders", and only a
 * browser can measure the right-hand side. Making it durable means a COMMITTED
 * harness that seeds the widest `mcp__*` names, reads back every card's box and
 * compares — and mutation-proving it, which the scratchpad run did by halving
 * this function. No such harness is in the repository. Until one is, this
 * paragraph is the whole of what is known, and the paragraph it replaced was a
 * check nobody could run.
 */
export function estimateHeight(node: GraphNode): number {
  // padding 16 top + 16 bottom, lane/status header row, title row.
  let height = 32 + 22 + 22;

  // The role chip sits on its own row under the title.
  height += 20;

  // Description is clamped to two lines and the row is reserved either way, so
  // cards in a column keep a shared baseline instead of jittering by a line.
  height += 36;

  // The `inferred` chip is its own row when the attribution was a guess.
  if (node.attribution === "inferred") height += 26;

  // `cap + 1` because the group renders `cap` pills plus one `+N` overflow chip.
  const rows = (count: number, cap: number): number =>
    count === 0 ? 0 : Math.min(count, cap + 1) * 26 + 6;

  const groups =
    rows(node.skills.length, PILL_CAP.skills) +
    rows(node.tools.length, PILL_CAP.tools) +
    rows(node.hooks.length, PILL_CAP.hooks);
  // The divider above the pill block, present only when there is one.
  if (groups > 0) height += groups + 12;

  // The counters strip along the bottom.
  if (node.toolCalls > 0 || node.result !== null) height += 28;

  return height;
}

/**
 * A collapsed group card's height.
 *
 * SAME WORST-CASE DISCIPLINE AS `estimateHeight`, and it has to be here rather
 * than guessed by the column cursor: a group whose height the layout does not
 * know is a group that overlaps the card under it. `DECK_OFFSET` is the two
 * shadow cards peeking out behind the front one — they are inside the node's
 * box, so they count.
 */
export const DECK_OFFSET = 14;

export function groupHeight(members: readonly GraphNode[]): number {
  // padding 16+16, eyebrow row, count row, role chip row.
  let height = 32 + 20 + 30 + 20;
  // One caption line per previewed member, plus the `+N more` line when it bit.
  const previewed = Math.min(members.length, GROUP_PREVIEW);
  height += previewed * 18;
  if (members.length > previewed) height += 18;
  // The expand affordance along the bottom, and the deck behind the card.
  height += 26 + DECK_OFFSET;
  return height;
}

/** An open group keeps only its header row; the members are placed under it. */
export const GROUP_HEADER_HEIGHT = 46;

/**
 * Which column a node belongs to.
 *
 * The root is the ONLY node with no parent — `foldGraph` sets `parent: null`
 * exactly once — so this reads a fact rather than matching on a description or
 * an agent name.
 */
export function columnOf(node: GraphNode): ColumnKey {
  if (node.parent === null) return "root";
  return node.lane ?? "tasks";
}

function columnIndexOf(column: ColumnKey): number {
  const index = COLUMN_ORDER.indexOf(column);
  // A lane the client does not know is placed AFTER the known ones rather than
  // folded into the root column, where it would sit beside the orchestrator and
  // read as one.
  return index === -1 ? COLUMN_ORDER.length + 1 : index;
}

/**
 * The four things folded siblings must agree on, and why each one is in the key.
 *
 *   parent  — a group is a fan-out from ONE delegation. Folding across parents
 *             would draw an edge from a node that did not create these.
 *   column  — a fold that spanned two columns would have to be drawn in one of
 *             them, putting a `design` node in the `build` lane.
 *   role    — the group has one colour, so its members must have one role.
 *             Two roles behind one hue is the canvas asserting something false.
 *   state   — A GROUP CAN NEVER HIDE A FAILURE. Six completed image generations
 *             fold; a seventh that FAILED stays on the canvas as its own card,
 *             with its own red border, in its own row. This is the clause that
 *             makes collapsing safe rather than convenient.
 *   attribution — and it can never hide a guess either. The collapsed card has
 *             ONE edge to its parent, and that edge is drawn as a fact or as an
 *             inference; a mixed group would force it to lie in one direction.
 */
function groupKeyOf(node: GraphNode, column: ColumnKey, role: AgentRole): string {
  return [node.parent ?? "", column, role, node.state, node.attribution].join("|");
}

interface Candidate {
  readonly node: GraphNode;
  readonly column: ColumnKey;
  readonly role: AgentRole;
  readonly signature: string;
}

/**
 * Fold repeated leaf siblings.
 *
 * THREE DISQUALIFICATIONS, each of which would otherwise hide something:
 *
 *   1. THE ROOT IS NEVER FOLDED. It has no parent to fan out from.
 *   2. A NODE THAT DELEGATED IS NEVER FOLDED. If anything hangs off it, folding
 *      it would hide a whole subtree behind a count — and the edge out of it
 *      would have to start at a card that is not there.
 *   3. A RUN SHORTER THAN `MIN_GROUP` IS NEVER FOLDED. Two cards are not a
 *      stack.
 *
 * Returns, for every node, the group key it belongs to or `null`. Pure, and
 * exported so a unit spec can hand it a graph and read the answer.
 */
export function groupSiblings(
  nodes: readonly GraphNode[],
  hasChildren: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const candidates: Candidate[] = [];
  const counts = new Map<string, number>();

  for (const node of nodes) {
    if (node.parent === null) continue;
    if (hasChildren.has(node.id)) continue;
    const column = columnOf(node);
    const role = roleOf(node.agent, node.lane);
    const signature = groupKeyOf(node, column, role);
    candidates.push({ node, column, role, signature });
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  // Group keys are numbered by FIRST SIGHTING, not by signature string, so the
  // id a group carries is stable across a reload and readable in a test.
  const keyOf = new Map<string, string>();
  const assigned = new Map<string, string>();
  for (const candidate of candidates) {
    if ((counts.get(candidate.signature) ?? 0) < MIN_GROUP) continue;
    let key = keyOf.get(candidate.signature);
    if (key === undefined) {
      key = `group:${String(keyOf.size + 1)}`;
      keyOf.set(candidate.signature, key);
    }
    assigned.set(candidate.node.id, key);
  }

  return assigned;
}

export interface PlaceOptions {
  readonly showAmbient: boolean;
  /** Group keys the reader has opened. Everything else stays folded. */
  readonly expandedGroups?: ReadonlySet<string>;
}

/**
 * Place a folded graph.
 *
 * `showAmbient: false` drops the CLI's `skip_transcript` housekeeping agents —
 * the contract's own default — and, with them, any edge that would have ended
 * at one. An edge to a node that is not on screen is not a fainter edge, it is
 * a line pointing at nothing.
 */
export function placeGraph(graph: GraphState, options: PlaceOptions): Placement {
  const expanded = options.expandedGroups ?? new Set<string>();

  const visible = options.showAmbient
    ? graph.nodes
    : graph.nodes.filter((node) => !node.ambient);

  const onScreen = new Set(visible.map((node) => node.id));

  // Which nodes delegated to something that is also on screen. A node whose only
  // child was filtered out IS a leaf as far as this canvas is concerned, and
  // folding it hides nothing the reader can see.
  const hasChildren = new Set<string>();
  for (const edge of graph.edges) {
    if (onScreen.has(edge.from) && onScreen.has(edge.to)) hasChildren.add(edge.from);
  }

  const groupOf = groupSiblings(visible, hasChildren);

  const members = new Map<string, GraphNode[]>();
  for (const node of visible) {
    const key = groupOf.get(node.id);
    if (key === undefined) continue;
    const list = members.get(key);
    if (list === undefined) members.set(key, [node]);
    else list.push(node);
  }

  /*
   * PLACEMENT ORDER, WHICH IS STILL ARRIVAL ORDER.
   *
   * One pass over the visible nodes in the order the reducer appended them. A
   * grouped node emits its GROUP the first time one of its members is reached
   * and nothing on every later member — so the group inherits its first member's
   * row and the sticky first-sighting rule survives folding. An expanded group
   * emits a header at that row and then its members in their own arrival order,
   * which keeps a reader's place when they open it.
   */
  interface Stacked {
    readonly key: string;
    readonly kind: "agent" | "group";
    readonly node: GraphNode;
    readonly members: readonly GraphNode[];
    readonly role: AgentRole;
    readonly column: ColumnKey;
    readonly expanded: boolean;
    readonly height: number;
    readonly gapBefore: number;
  }

  const stacked: Stacked[] = [];
  const emittedGroups = new Set<string>();

  for (const node of visible) {
    const column = columnOf(node);
    const role = roleOf(node.agent, node.lane);
    const groupKey = groupOf.get(node.id);

    if (groupKey === undefined) {
      stacked.push({
        key: node.id,
        kind: "agent",
        node,
        members: [node],
        role,
        column,
        expanded: false,
        height: estimateHeight(node),
        gapBefore: ROW_GAP,
      });
      continue;
    }

    const groupMembers = members.get(groupKey) ?? [node];
    const isOpen = expanded.has(groupKey);

    if (!emittedGroups.has(groupKey)) {
      emittedGroups.add(groupKey);
      const first = groupMembers[0] ?? node;
      stacked.push({
        key: groupKey,
        kind: "group",
        node: first,
        members: groupMembers,
        role,
        column,
        expanded: isOpen,
        height: isOpen ? GROUP_HEADER_HEIGHT : groupHeight(groupMembers),
        gapBefore: ROW_GAP,
      });
    }

    if (isOpen) {
      stacked.push({
        key: node.id,
        kind: "agent",
        node,
        members: [node],
        role,
        column,
        expanded: false,
        height: estimateHeight(node),
        gapBefore: MEMBER_GAP,
      });
    }
  }

  // Empty columns are removed BEFORE positions are assigned, so a run that only
  // ever used `build` does not open with six columns of nothing.
  const occupied: ColumnKey[] = [];
  for (const entry of stacked) {
    if (!occupied.includes(entry.column)) occupied.push(entry.column);
  }
  occupied.sort((a, b) => columnIndexOf(a) - columnIndexOf(b));

  const xOf = new Map<ColumnKey, number>();
  occupied.forEach((column, index) => xOf.set(column, index * COLUMN_STEP));

  const cursor = new Map<ColumnKey, number>();
  const counts = new Map<ColumnKey, number>();

  interface Raw extends Stacked {
    readonly x: number;
    readonly y: number;
  }
  const raw: Raw[] = [];

  for (const entry of stacked) {
    const x = xOf.get(entry.column) ?? 0;
    const started = cursor.has(entry.column);
    const y = started
      ? (cursor.get(entry.column) ?? LANE_LABEL_HEIGHT) + entry.gapBefore
      : LANE_LABEL_HEIGHT;
    raw.push({ ...entry, x, y });
    cursor.set(entry.column, y + entry.height);
    // A group counts as its members, not as one card: the column label says how
    // many agents ran, and folding must not make a run look smaller than it was.
    counts.set(
      entry.column,
      (counts.get(entry.column) ?? 0) + (entry.kind === "group" ? entry.members.length : 1),
    );
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
  const columnHeight = new Map<ColumnKey, number>();
  for (const column of occupied) {
    const height = (cursor.get(column) ?? LANE_LABEL_HEIGHT) - LANE_LABEL_HEIGHT;
    columnHeight.set(column, height);
    tallest = Math.max(tallest, height);
  }

  const nodes: PlacedNode[] = raw.map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    node: entry.node,
    members: entry.members,
    role: entry.role,
    column: entry.column,
    expanded: entry.expanded,
    x: entry.x,
    y: entry.y + Math.round((tallest - (columnHeight.get(entry.column) ?? 0)) / 2),
    height: entry.height,
  }));

  /*
   * A COLUMN LABEL SITS ON ITS OWN COLUMN, not on a shared top rule.
   *
   * Pinning every label to y = 0 draws a straight header line, and centring the
   * columns then leaves a sparse column's label floating hundreds of pixels
   * above the single card it names — far enough that at the default zoom the
   * label is off-screen while the card is not. A ragged row of labels that each
   * touch their own column is the less tidy diagram and the more readable one.
   */
  const firstCardY = new Map<ColumnKey, number>();
  for (const entry of nodes) {
    const current = firstCardY.get(entry.column);
    if (current === undefined || entry.y < current) firstCardY.set(entry.column, entry.y);
  }

  const columns: PlacedColumn[] = occupied.map((column) => ({
    column,
    label: COLUMN_LABEL[column] ?? String(column),
    note: COLUMN_NOTE[column] ?? "",
    x: xOf.get(column) ?? 0,
    y: (firstCardY.get(column) ?? LANE_LABEL_HEIGHT) - LANE_LABEL_HEIGHT,
    count: counts.get(column) ?? 0,
  }));

  /* ----------------------------------------------------------------
   * Edges, remapped onto whatever is actually drawn.
   * ------------------------------------------------------------- */

  const placedKeyOf = new Map<string, string>();
  const roleByKey = new Map<string, AgentRole>();
  const columnByKey = new Map<string, ColumnKey>();
  for (const entry of nodes) {
    roleByKey.set(entry.key, entry.role);
    columnByKey.set(entry.key, entry.column);
    if (entry.kind === "agent") placedKeyOf.set(entry.node.id, entry.key);
  }
  // A folded member's edges arrive at the GROUP. An open group's members are on
  // the canvas in their own right, so their own key wins — set second on
  // purpose, because `nodes` holds both the header and the members.
  for (const [nodeId, groupKey] of groupOf) {
    if (!placedKeyOf.has(nodeId)) placedKeyOf.set(nodeId, groupKey);
  }

  const stateOf = new Map(graph.nodes.map((node) => [node.id, node.state]));

  /* Depth from the root, over the edges that survived the filter. */
  const depthOf = new Map<string, number>();
  {
    const childrenOf = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (!onScreen.has(edge.from) || !onScreen.has(edge.to)) continue;
      const list = childrenOf.get(edge.from);
      if (list === undefined) childrenOf.set(edge.from, [edge.to]);
      else list.push(edge.to);
    }
    const roots = visible.filter((node) => node.parent === null).map((node) => node.id);
    const queue: string[] = roots.length > 0 ? roots : visible.slice(0, 1).map((n) => n.id);
    for (const id of queue) depthOf.set(id, 0);
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head];
      if (id === undefined) continue;
      const depth = depthOf.get(id) ?? 0;
      for (const child of childrenOf.get(id) ?? []) {
        if (depthOf.has(child)) continue;
        depthOf.set(child, depth + 1);
        queue.push(child);
      }
    }
  }

  const seen = new Set<string>();
  const edges: PlacedEdge[] = [];

  for (const edge of graph.edges) {
    if (!onScreen.has(edge.from) || !onScreen.has(edge.to)) continue;
    const from = placedKeyOf.get(edge.from);
    const to = placedKeyOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    // A fold turns six parallel edges into one. Self-edges appear when an open
    // group's header and its member would both map to the same key; drop them.
    if (from === to) continue;
    const id = `${from}->${to}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const sourceColumn = columnByKey.get(from);
    const targetColumn = columnByKey.get(to);
    const forward =
      sourceColumn !== undefined &&
      targetColumn !== undefined &&
      columnIndexOf(targetColumn) > columnIndexOf(sourceColumn);

    edges.push({
      id,
      from,
      to,
      inferred: edge.attribution === "inferred",
      fromRole: roleByKey.get(from) ?? "unmapped",
      toRole: roleByKey.get(to) ?? "unmapped",
      childState: stateOf.get(edge.to) ?? "unresolved",
      centerX: forward ? (xOf.get(targetColumn) ?? 0) - COLUMN_GAP / 2 : null,
      depth: depthOf.get(edge.to) ?? 1,
    });
  }

  const groupKeys = nodes.filter((entry) => entry.kind === "group").map((entry) => entry.key);
  const foldedCount = nodes
    .filter((entry) => entry.kind === "group" && !entry.expanded)
    .reduce((total, entry) => total + entry.members.length - 1, 0);

  return { nodes, columns, edges, groupKeys, foldedCount };
}
