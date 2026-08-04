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
 * TWO KINDS OF BOX HERE ARE NOT AGENTS.
 *
 *   1. The terminal preview (`PREVIEW_KEY`), placed one column past the last one
 *      the run used. This module is told only WHETHER to reserve it — see
 *      `PlaceOptions.withPreview` — and never what it says, because "where every
 *      node sits" is the whole of this file's job and a verdict is not a position.
 *   2. The PRE-BUILD LANE (`stageKeyOf`), placed to the LEFT of the root column
 *      and running into it. See `THE PRE-BUILD LANE` below for why it is drawn as
 *      real nodes on this canvas rather than as a panel floating over it, and why
 *      the chain's last link lands on the root card itself.
 *
 * SPACING IS DELIBERATELY LOOSE. The gutters below are wide enough that every
 * edge has visible run length rather than nodes butting into each other — the
 * one change the owner asked for against the connector reference. `estimateHeight`
 * OVER-estimates for the same reason: a wrong guess adds whitespace, never
 * overlap, and whitespace is what was asked for.
 */

import type {
  GraphNode,
  GraphNodeState,
  GraphStage,
  GraphStageId,
  GraphState,
  RunLane,
} from "@/lib/api-types";
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

/*
 * `COLUMN_NOTE` IS GONE — 2026-08-04, at the owner's instruction ("there is just
 * too much text and explanation around each button that almost looks like some
 * sort of tutorial").
 *
 * It was a `title=` tooltip on each column header: "Writing it.", "Checking it.",
 * "Work the orchestrator ran directly, that the CLI named no lane for. Repeated
 * identical tasks are folded into one card." Every one of them restated the
 * column's own one-word label, and the longest one described a folding rule the
 * deck card already announces on its face. The LABEL survives; the gloss does
 * not, and `PlacedColumn` no longer carries a `note` for anything to render.
 */


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

/* ------------------------------------------------------------------
 * The pre-build lane
 * ---------------------------------------------------------------- */

/**
 * A stage card, and the gap between two of them.
 *
 * NARROWER THAN AN AGENT CARD (268px) BECAUSE IT CARRIES LESS. A stage has a
 * label, a state and one sentence the server wrote; an agent card carries pills,
 * counters and a result. Drawing them the same width would make the lane the
 * widest thing on the canvas while being the emptiest.
 *
 * THE STEP IS WIDER THAN THE CARD BY ROUGHLY THE COLUMN GUTTER, for the same
 * reason `COLUMN_GAP` is: every link needs visible run length, and the lane's
 * links are the only ones on this canvas that say "and then".
 */
export const STAGE_WIDTH = 216;
export const STAGE_GAP = 88;
export const STAGE_STEP = STAGE_WIDTH + STAGE_GAP;

/**
 * The collapsed card's height, used ONLY to centre the lane against the root.
 *
 * AN OPENED STAGE GROWS DOWNWARD FROM THE SAME TOP EDGE and this number does not
 * change, which is deliberate: the lane is one row, so a taller card cannot
 * collide with anything, and holding the top edge fixed means opening a stage
 * moves nothing else on the canvas. That is not true of the agent columns, where
 * `estimateHeight` has to be an upper bound or two cards overlap.
 */
export const STAGE_HEIGHT = 118;

/**
 * The React Flow id of a stage card.
 *
 * IT CANNOT COLLIDE WITH A NODE ID for the same reason `PREVIEW_KEY` cannot: the
 * server mints node ids as `n<number>`, and this canvas reserves `group:<n>`,
 * `column:<key>` and `layout:` for things it added itself. The prefix says out
 * loud that a stage is a projection of the run's log rows, not an agent.
 */
export function stageKeyOf(id: GraphStageId): string {
  return `stage:${id}`;
}

/** Where one stage card sits. Its content is the component's business. */
export interface PlacedStage {
  readonly key: string;
  readonly stage: GraphStage;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One link in the pre-build chain.
 *
 * IT IS NOT A `PlacedEdge`, AND THE DIFFERENCE IS THE CLAIM. Every `PlacedEdge`
 * on this canvas means "this agent delegated to that one"; these mean "this
 * happened, and then that did". Folding them into one list would put a sequence
 * and a delegation behind one renderer and one legend entry, which is the canvas
 * asserting something the run never said.
 */
export interface PlacedStageEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The thing at the FAR end is working now — the same rule delegation uses. */
  readonly live: boolean;
  /** Nothing downstream has started, so the link is drawn as unused. */
  readonly pending: boolean;
  /** The x the cable turns vertical at, or `null` for a straight run. */
  readonly centerX: number | null;
}

/** The lane's own header, above its first card. Null when there is no lane. */
export interface PlacedStageHeader {
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export interface Placement {
  readonly nodes: readonly PlacedNode[];
  readonly columns: readonly PlacedColumn[];
  readonly edges: readonly PlacedEdge[];
  /**
   * The pre-build lane, left to right, ending where the agent graph begins.
   *
   * EMPTY FOR EVERY RUN THAT NEVER HAD ONE, which is most of them: `foldGraph`
   * only projects stages from `phase` and `log` rows, and a stream whose first
   * phase row is `build` folds to a state with no stages at all
   * (`server/src/graph.ts`'s `foldPhaseStages`). So an old run's canvas is
   * unchanged by this, node for node and edge for edge.
   */
  readonly stages: readonly PlacedStage[];
  readonly stageEdges: readonly PlacedStageEdge[];
  readonly stageHeader: PlacedStageHeader | null;
  /** Groups that exist in this placement, collapsed or not. For the HUD. */
  readonly groupKeys: readonly string[];
  /** How many nodes are currently folded out of sight. 0 when all are open. */
  readonly foldedCount: number;
  /**
   * Where the terminal preview goes, or `null` when the caller did not ask for
   * one. It is NOT in `nodes`: every `PlacedNode` carries a real `GraphNode`, and
   * the only way to put this in that list would be to forge one.
   */
  readonly preview: PlacedPreview | null;
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
/**
 * The last thing this agent SAID, or null when it has said nothing.
 *
 * `graph_narration` is one turn of the model's own prose, capped at 1,200
 * characters by the emitter and folded into `activity` as `kind: "narration"`
 * with an empty `name` — so this branches on the KIND and never on the name, per
 * the wire type's own instruction. Before that event existed the builder dropped
 * every prose-only turn into a generic `log` row beside the token telemetry, and
 * the canvas had no way to tell one from the other.
 *
 * NEWEST WINS, and only one is drawn. `activity` is the whole ordered
 * transcript — that belongs behind a click, not on a card that has to stay
 * readable at 0.3 zoom with twenty siblings.
 *
 * IT LIVES IN THIS FILE, NOT IN `agent-node.tsx`, TO AVOID AN IMPORT CYCLE:
 * `agent-node.tsx` already imports `NODE_WIDTH` and `PILL_CAP` from here, and
 * `estimateHeight` below has to reserve a row for exactly the same string the
 * card draws or the layout under-estimates and two cards collide.
 */
export function latestNarration(node: GraphNode): string | null {
  for (let index = node.activity.length - 1; index >= 0; index -= 1) {
    const entry = node.activity[index];
    if (entry === undefined || entry.kind !== "narration") continue;
    const text = entry.detail.trim();
    if (text !== "") return text;
  }
  return null;
}

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

  // The narration block: a rule, two clamped lines and the margin above it.
  // Reserved only when there IS one, so a run recorded before `graph_narration`
  // existed places identically to how it always did.
  if (latestNarration(node) !== null) height += 48;

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

/* ------------------------------------------------------------------
 * The terminal preview — the built site, at the end of the flow.
 * ---------------------------------------------------------------- */

/**
 * The React Flow id of the terminal preview card.
 *
 * IT CANNOT COLLIDE WITH A NODE ID. The server mints node ids as `n<number>`
 * (`graph-emit.ts`'s `#mint`), and this canvas already reserves `group:<n>` for
 * folds and `column:<key>` for headers. The `layout:` prefix says out loud what
 * this thing is: something the layout added, not something the run emitted.
 */
export const PREVIEW_KEY = "layout:preview";

/**
 * The preview card is WIDER THAN AN AGENT CARD, deliberately.
 *
 * It carries a picture of a web page, and a 268px thumbnail of a desktop layout
 * is a smudge — the same complaint the unclamped fit was fixed for. Nothing else
 * on the canvas is this wide, which is also the point: it does not read as one
 * more agent.
 */
export const PREVIEW_WIDTH = 420;

/**
 * Over-estimated, on the same rule as `estimateHeight`: a wrong guess must add
 * whitespace, never overlap.
 *
 * WHAT IS IN IT, worst case, at `PREVIEW_WIDTH`, margins and rules counted: 28
 * padding, 30 header, 232 thumbnail frame, 45 verdict row, 38 verdict detail (two
 * lines), 40 caveat (two lines, and only on a cancelled or failed run), 89 for
 * the "no delegation recorded" note the card carries when it is the ONLY thing on
 * the canvas (four lines), and 30 for the link row. That is 532 — a card carrying
 * every one of those at once, which a cancelled run with no graph events genuinely
 * is — and the constant is above it.
 *
 * NOTHING MEASURES THIS AGAINST THE BROWSER. Same retraction as `estimateHeight`:
 * the property is "this number is >= what the browser renders" and only a browser
 * can measure the right-hand side. The consequence of being wrong here is much
 * smaller than for an agent card — the preview is alone in its column, so an
 * under-estimate shifts its vertical centring rather than colliding with
 * anything.
 */
export const PREVIEW_HEIGHT = 560;

/** Where the terminal preview sits. Content is the component's; this is a box. */
export interface PlacedPreview {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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
  /**
   * Reserve a box for the terminal preview at the end of the flow.
   *
   * A BOOLEAN, NOT THE PREVIEW ITSELF, and that asymmetry is deliberate: this
   * module places boxes and has no business reading a verdict or a URL. Whether
   * a run HAS a terminal preview is `previewNodeFrom` in `src/lib/spec-pipeline.ts`;
   * all that reaches here is the answer.
   */
  readonly withPreview?: boolean;
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

  /*
   * THE TERMINAL PREVIEW, PAST THE LAST COLUMN.
   *
   * `occupied.length * COLUMN_STEP` — one step beyond whatever the run actually
   * used, INCLUDING a lane this build has never heard of. `columnIndexOf` sends
   * an unknown lane to `COLUMN_ORDER.length + 1` so it sorts last among the
   * columns, and counting occupied columns rather than naming a position in
   * `COLUMN_ORDER` is what keeps the preview to the right of it. Nothing here
   * needs a `ColumnKey` for the preview, and it does not get one: a key in that
   * union is a place `columnOf` could route an agent to, and no agent belongs
   * here.
   *
   * IT GETS NO COLUMN HEADER. Every header carries a count of the agents in its
   * column, and this column has none — a header reading "Result 1" would be
   * counting a thing that never ran. The card says what it is itself.
   *
   * AND IT GETS NO EDGE. Every `PlacedEdge` on this canvas means one agent
   * delegated to another, `inferred` already being "we guessed which agent".
   * Drawing a wire from the last agent to this box would assert a delegation that
   * did not happen, and this box is a fact about the WORKSPACE rather than about
   * anything an agent returned. The gap is the honest rendering.
   *
   * A SECOND EDGE KIND EXISTS NOW AND STILL DOES NOT APPLY HERE — 2026-08-04.
   * `PlacedStageEdge` below means "and then", not "delegated to", which is why it
   * is a separate list with a separate renderer. It does not reach the preview
   * either: the lane says what the run did BEFORE the agents, in the order the
   * server reported it, and nothing ever reported handing this artefact to
   * anybody. An "and then" into the preview would be a sequence claim about a
   * directory listing.
   *
   * CENTRED ON THE SAME AXIS AS THE COLUMNS, so it sits level with the middle of
   * the flow rather than at the top of an empty column. With no visible nodes at
   * all — an old run with a workspace and no `graph_*` events, which is exactly
   * the run this machine has recorded — `tallest` is 0 and it lands at the origin,
   * alone, which is the whole canvas and correct.
   */
  const preview: PlacedPreview | null =
    options.withPreview === true
      ? {
          key: PREVIEW_KEY,
          x: occupied.length * COLUMN_STEP,
          y: LANE_LABEL_HEIGHT + Math.round((tallest - PREVIEW_HEIGHT) / 2),
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
        }
      : null;

  /* ----------------------------------------------------------------
   * THE PRE-BUILD LANE — Planning ── Orchestrator ── whatever it spawned
   *
   * THE OWNER'S ASK, IN HIS OWN SKETCH: "Planning (node) ----- Orchestrator
   * (node) ------ (then whatever the orchestrator spawns.)" It used to be a panel
   * floating over the canvas, drawn ONLY while the graph had zero nodes and
   * replaced the moment the build started — so the run's first eighty minutes and
   * the rest of it were two different pictures with nothing joining them.
   *
   * THE CHAIN RUNS LEFTWARD FROM THE ROOT COLUMN'S ORIGIN, which is what makes it
   * continuous. The agent graph's own x-axis is untouched: the root column stays
   * at x = 0 and every lane card sits at a NEGATIVE x, so the build's layout is
   * identical with a lane and without one, and the arrival of the first agent does
   * not shove the lane sideways under the reader.
   *
   * THE ORCHESTRATOR IS ONE BOX ACROSS THE WHOLE RUN, AND THAT IS THE WHOLE POINT
   * OF THE ASK ("you don't have the thing where the orchestrator doesn't show").
   * Before the build there is no `graph_agent` for it, so the lane's own
   * `orchestrator` stage stands at x = 0 as a real card. The moment the builder
   * mints the root node, that card is dropped and the chain's last link lands on
   * the ROOT CARD instead — same position, same place in the chain, more
   * information. Two orchestrator boxes on one canvas would be the display
   * inventing a hand-off that nothing performed.
   *
   * THE LANE IS VERTICALLY CENTRED ON THE ROOT CARD when there is one, so the last
   * link is a straight horizontal run rather than a rake across the canvas. With
   * no root — the pre-build case — it centres on the same axis the columns do,
   * which with an empty graph is the origin.
   * ------------------------------------------------------------- */

  const lane = graph.stages ?? [];
  const rootEntry = nodes.find(
    (entry) => entry.kind === "agent" && entry.node.parent === null,
  );
  // The lane's `orchestrator` stage and the root card are the same actor. Exactly
  // one of them is ever drawn.
  const drawnStages = rootEntry === undefined ? lane : lane.filter((s) => s.id !== "orchestrator");
  const orchestratorDrawn = drawnStages.some((stage) => stage.id === "orchestrator");
  // Index of the card that owns x = 0. With the orchestrator drawn that is the
  // orchestrator itself; without it, the slot the root card occupies.
  const anchorIndex = drawnStages.length - (orchestratorDrawn ? 1 : 0);
  const laneY =
    rootEntry === undefined
      ? LANE_LABEL_HEIGHT + Math.round((tallest - STAGE_HEIGHT) / 2)
      : rootEntry.y + Math.round((rootEntry.height - STAGE_HEIGHT) / 2);

  const stages: PlacedStage[] = drawnStages.map((stage, index) => ({
    key: stageKeyOf(stage.id),
    stage,
    x: (index - anchorIndex) * STAGE_STEP,
    y: laneY,
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
  }));

  const stageEdges: PlacedStageEdge[] = [];
  for (let index = 0; index + 1 < stages.length; index += 1) {
    const from = stages[index];
    const to = stages[index + 1];
    if (from === undefined || to === undefined) continue;
    stageEdges.push({
      id: `${from.key}->${to.key}`,
      from: from.key,
      to: to.key,
      // THE FAR END'S STATE, which is the same rule `PlacedEdge.childState`
      // follows: the near end is almost always finished, so keying on it would
      // light the whole chain for the rest of the run.
      live: to.stage.state === "running",
      pending: to.stage.state === "pending",
      centerX: to.x - STAGE_GAP / 2,
    });
  }

  /*
   * THE LINK THE ASK IS ABOUT: `… ── Orchestrator`.
   *
   * Drawn only when both ends exist. A lane with no root card already ends at its
   * own orchestrator stage, and a root card with no lane — every run recorded
   * before the phases existed — gets nothing new attached to it.
   */
  const lastStage = stages[stages.length - 1];
  if (rootEntry !== undefined && lastStage !== undefined) {
    stageEdges.push({
      id: `${lastStage.key}->${rootEntry.key}`,
      from: lastStage.key,
      to: rootEntry.key,
      live: rootEntry.node.state === "running",
      pending: false,
      centerX: null,
    });
  }

  const first = stages[0];
  const stageHeader: PlacedStageHeader | null =
    first === undefined
      ? null
      : { x: first.x, y: first.y - LANE_LABEL_HEIGHT, count: stages.length };

  return {
    nodes,
    columns,
    edges,
    groupKeys,
    foldedCount,
    preview,
    stages,
    stageEdges,
    stageHeader,
  };
}
