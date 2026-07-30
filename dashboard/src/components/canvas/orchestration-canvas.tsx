"use client";

/**
 * orchestration-canvas.tsx — the run, as a picture, filling the screen.
 *
 * THE MOUNT IS THE FRAGILE PART, so it is the part with the most rules:
 *
 *   - `<ReactFlow>` IS ALWAYS MOUNTED, INCLUDING WITH ZERO NODES. The obvious
 *     shape — `nodes.length === 0 ? <Empty/> : <ReactFlow/>` — remounts the
 *     flow when the first agent arrives and throws away the reader's pan and
 *     zoom mid-run. The empty and loading states are OVERLAYS inside a flow
 *     that never unmounts (spec §9.3).
 *   - NO `key` THAT CHANGES. Same failure, quieter cause.
 *
 * FIT TO VIEW, AND WHY IT IS NOT THE DECLARATIVE `fitView` PROP ALONE. The prop
 * fits on first render, and on first render this graph has zero nodes — so it
 * frames an empty box and every agent that arrives afterwards lands outside the
 * viewport. It also fits before the browser has MEASURED the cards, which are
 * auto-height, so even with nodes present it would frame them against stale
 * boxes. `useNodesInitialized()` is the hook that answers both: it goes true
 * once React Flow has measured every node it has, and the fit below waits for
 * it. One fit, on the 0 -> some transition, and never again — a re-fit on every
 * arrival would yank the canvas out from under someone reading it, and a re-fit
 * after a drag would undo the drag.
 *
 * THE LEGIBILITY FLOOR IS GONE, AND THAT IS THE OWNER'S CALL. The previous fit
 * clamped to `minZoom: 0.85` because an unclamped fit of a six-column graph
 * inside a 780px pane landed at scale 0.245 and rendered 268px cards as 66px
 * smudges. Two things changed: the pane is now the whole viewport rather than a
 * third of it, and repeated siblings fold, so the graph this had to defend
 * against is roughly half as wide. The instruction was "zoomed in on the whole
 * flow by default", which a floor contradicts — a floor means the whole flow is
 * NOT in frame. It is unclamped, and `run-canvas.browser.spec.ts` measures both
 * halves of the resulting property: every node inside the pane, AND the graph
 * filling enough of it to be worth looking at.
 *
 * An old run — every run recorded before this phase — carries no `graph_*`
 * events at all, folds to an empty graph, and lands here with zero nodes. That
 * is a first-class state with its own copy, not an error and not a feature flag.
 */

import "@xyflow/react/dist/base.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type XYPosition,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { GraphState } from "@/lib/api-types";
import { Button, cx } from "@/components/ui";
import {
  AgentNode,
  ColumnNode,
  GroupNode,
  shellIdFor,
  type AgentFlowNode,
  type ColumnFlowNode,
  type GroupFlowNode,
} from "./agent-node";
import { DelegationEdge, type FlowEdge } from "./flow-edge";
import { NODE_WIDTH, placeGraph, type PlacedNode } from "./layout";
import { ROLE_LABEL, ROLE_MEANING, ROLE_ORDER, roleColorVar, type AgentRole } from "./roles";

/**
 * Declared at module scope, NOT inline.
 *
 * React Flow compares these by identity and logs a console warning on every
 * render when they are rebuilt — which is both noise and a real re-render of
 * every node on the canvas.
 */
const NODE_TYPES = { agent: AgentNode, group: GroupNode, column: ColumnNode } as const;
const EDGE_TYPES = { flow: DelegationEdge } as const;

const MIN_ZOOM = 0.12;
const MAX_ZOOM = 1.5;

/**
 * THE FIT'S PADDING IS ASYMMETRIC, AND THAT IS THE WHOLE TRICK.
 *
 * A symmetric 8% fit frames the graph inside the PANE, and the pane is not what
 * the reader can see: the run chip and any notice float over its top-left corner,
 * and the legend over its bottom edge. Measured with a symmetric fit, the session
 * column — the root of the flow, the card everything else hangs off — landed
 * squarely underneath the design-lock panel and was invisible on the one run this
 * redesign was built against. "Fit to view" has to mean fit to what is VISIBLE.
 *
 * So the left reservation is the HUD's own width plus a gutter, the bottom clears
 * the legend and the zoom controls, and below 900px — where the HUD is as wide as
 * the pane and cannot be flanked — the reservation moves to the top instead.
 *
 * `maxZoom: 1` stops a two-node run being blown up to 150%: cards are designed at
 * 1 and a magnified 268px card looks like a mistake.
 */
const HUD_WIDTH = 360;
const WIDE_ENOUGH_TO_FLANK = 900;

/**
 * The HUD's reservation, as a `PaddingWithUnit`.
 *
 * The assertion is here rather than at the use site because React Flow types
 * padding as the template literal `` `${number}${PaddingUnit}` ``, and a template
 * string built from `String(360 + 28)` widens to `` `${string}px` `` — which is
 * the same string and a different type. Written out so the arithmetic stays next
 * to `HUD_WIDTH` instead of becoming a second magic number.
 */
const HUD_RESERVE = `${HUD_WIDTH + 28}px` as `${number}px`;

function fitOptionsFor(paneWidth: number, hasHud: boolean) {
  if (!hasHud) {
    return { padding: 0.08, maxZoom: 1, minZoom: MIN_ZOOM } as const;
  }
  if (paneWidth >= WIDE_ENOUGH_TO_FLANK) {
    return {
      padding: {
        left: HUD_RESERVE,
        right: "28px",
        top: "28px",
        bottom: "76px",
      },
      maxZoom: 1,
      minZoom: MIN_ZOOM,
    } as const;
  }
  return {
    padding: { left: "16px", right: "16px", top: "150px", bottom: "76px" },
    maxZoom: 1,
    minZoom: MIN_ZOOM,
  } as const;
}

/** What the manual "fit" button in the zoom controls uses. Symmetric, on purpose:
 *  it answers "show me the whole run" and the reader has asked for it explicitly. */
const MANUAL_FIT_OPTIONS = { padding: 0.08, maxZoom: 1, minZoom: MIN_ZOOM } as const;

/**
 * How much the pane has to change before a re-fit is worth animating.
 *
 * Below this, a resize is jitter — a scrollbar inside the sheet, a subpixel
 * reflow — and re-fitting on it would move the graph while the reader is reading.
 */
const RESIZE_REFIT_THRESHOLD_PX = 24;

/** How long the arrival sweep runs before every edge settles. */
const SWEEP_STEP_MS = 190;
const SWEEP_TAIL_MS = 1_200;

export interface CanvasProps {
  readonly graph: GraphState;
  /** False while the snapshot is still in flight. Drives the loading overlay. */
  readonly ready: boolean;
  readonly selectedId: string | null;
  readonly onSelect: (nodeId: string | null) => void;
  readonly showAmbient: boolean;
  readonly onShowAmbient: (next: boolean) => void;
  /** The run-level affordance. Rendered top-left, over the canvas. */
  readonly hud?: ReactNode;
  /**
   * True while the run can still produce agents.
   *
   * The canvas cannot derive this: it is handed a `GraphState`, and an empty graph on
   * a RUNNING run ("the spec is still being written") and an empty graph on a finished
   * one ("this run never emitted graph events") are the same value and different
   * facts. Conflating them is what made a healthy new run look broken.
   */
  readonly runIsActive?: boolean;
  /**
   * How many pixels of the pane's right edge the page has covered with a sheet.
   *
   * DECLARED RATHER THAN ASSUMED. `DetailSheet` is rendered by the run page, over
   * this component, so this component cannot measure it — and it has to know,
   * because "is the selected card visible" is the question that decides whether
   * to pan, and a card sitting under a 420px sheet is not visible while being
   * perfectly on-screen. Without this the first thing a click did was hide the
   * card it selected.
   */
  readonly rightInset?: number;
}

interface NavCell {
  readonly key: string;
  readonly y: number;
}

function CanvasInner({
  graph,
  ready,
  selectedId,
  onSelect,
  showAmbient,
  onShowAmbient,
  hud,
  rightInset: requestedInset = 0,
  runIsActive = false,
}: CanvasProps): ReactNode {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /*
   * DRAGGED POSITIONS LIVE IN A REF, AND THEY OVERRIDE THE LAYOUT FOREVER.
   *
   * The layout is the starting position, not the position: the owner asked for
   * draggable nodes, and a node that snapped back the next time the graph folded
   * would not be draggable, it would be springy. So a drag records here, this map
   * wins whenever the node array is rebuilt, and nothing clears it — not a
   * re-fold, not an expand, not a new agent arriving. `fitView` runs exactly once
   * and never after a drag, so the two cannot fight.
   *
   * A REF RATHER THAN STATE, deliberately. React Flow emits a position change per
   * pointer move; holding them in state would re-run the whole node-building
   * effect sixty times a second for a value only the next rebuild needs to read.
   * The live position during a drag is applied by `applyNodeChanges` below, which
   * is what React Flow's own drag expects.
   */
  const draggedRef = useRef<Map<string, XYPosition>>(new Map());

  const placement = useMemo(
    () => placeGraph(graph, { showAmbient, expandedGroups }),
    [graph, showAmbient, expandedGroups],
  );

  const ambientCount = useMemo(
    () => graph.nodes.filter((node) => node.ambient).length,
    [graph.nodes],
  );

  /** Which key the pointer is over, and which one holds the tab stop. */
  const [hovered, setHovered] = useState<string | null>(null);
  const [tabbable, setTabbable] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  /*
   * THE NAVIGATION GRID — the canvas's answer to the list that used to sit
   * beside it.
   *
   * `roster.tsx` existed because spec §9.3 says not to claim the canvas is
   * accessible: React Flow gives partial affordances only. That list is now
   * behind the run sheet rather than on the canvas's frame, so this had to
   * become real rather than partial. Columns left to right, rows top to bottom,
   * built from the same placement the cards are drawn from — so what the arrow
   * keys traverse is what the eye traverses, by construction.
   */
  const nav = useMemo((): readonly (readonly NavCell[])[] => {
    const byColumn = new Map<string, NavCell[]>();
    const order: string[] = [];
    for (const entry of placement.nodes) {
      const list = byColumn.get(entry.column);
      if (list === undefined) {
        byColumn.set(entry.column, [{ key: entry.key, y: entry.y }]);
        order.push(entry.column);
      } else {
        list.push({ key: entry.key, y: entry.y });
      }
    }
    return order.map((column) =>
      [...(byColumn.get(column) ?? [])].sort((a, b) => a.y - b.y),
    );
  }, [placement.nodes]);

  const navRef = useRef(nav);
  navRef.current = nav;

  const groupsRef = useRef(placement.groupKeys);
  groupsRef.current = placement.groupKeys;

  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const hasFitted = useRef(false);
  const shell = useRef<HTMLDivElement | null>(null);

  /**
   * Latches true the first time the READER moves the view or a node.
   *
   * Read by the resize re-fit below, which stops re-fitting forever once this is
   * set: after a deliberate pan, zoom or drag, the viewport belongs to the reader
   * and a resize is not permission to take it back.
   */
  const viewAdjusted = useRef(false);
  const markViewAdjusted = useCallback((): void => {
    viewAdjusted.current = true;
  }, []);

  /**
   * `onMoveEnd` fires for this component's own `fitView` too. React Flow passes
   * the triggering event for a user gesture and `null` when the move was
   * programmatic, so the null check is what keeps our own fit from latching the
   * flag and disabling the next re-fit.
   */
  const onMoveEnd = useCallback(
    (event: MouseEvent | TouchEvent | null): void => {
      if (event !== null) viewAdjusted.current = true;
    },
    [],
  );

  /**
   * The sheet's inset, clamped to something that leaves a canvas behind it.
   *
   * `DetailSheet` is `min(420px, 100%)`, so on a 375px viewport the sheet covers
   * everything and an unclamped inset would make the "is the card visible" test
   * below always false and pan forever chasing a card that cannot be uncovered.
   * Half the pane is the most this is ever allowed to reserve.
   */
  const insetOf = useCallback(
    (paneWidth: number): number => Math.min(requestedInset, paneWidth * 0.5),
    [requestedInset],
  );

  /** Move focus to a card, and bring it into the pane if it is not already. */
  const focusKey = useCallback(
    (key: string): void => {
      setTabbable(key);
      const element = document.getElementById(shellIdFor(key));
      if (element === null) return;
      element.focus({ preventScroll: true });

      const target = placement.nodes.find((entry) => entry.key === key);
      const box = shell.current?.getBoundingClientRect();
      if (target === undefined || box === undefined) return;
      const centreX = target.x + NODE_WIDTH / 2;
      const centreY = target.y + target.height / 2;
      const screen = flow.flowToScreenPosition({ x: centreX, y: centreY });
      const margin = 60;
      const inset = insetOf(box.width);
      const onScreen =
        screen.x > box.left + margin &&
        screen.x < box.right - inset - margin &&
        screen.y > box.top + margin &&
        screen.y < box.bottom - margin;
      if (onScreen) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const zoom = flow.getZoom();
      void flow.setCenter(centreX + inset / 2 / zoom, centreY, {
        zoom,
        duration: reduce ? 0 : 320,
      });
    },
    [flow, placement.nodes, insetOf],
  );

  const toggleGroup = useCallback((key: string): void => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const activate = useCallback(
    (key: string): void => {
      if (groupsRef.current.includes(key)) {
        toggleGroup(key);
        return;
      }
      onSelect(key === selectedId ? null : key);
    },
    [onSelect, selectedId, toggleGroup],
  );

  /*
   * ONE KEY HANDLER FOR EVERY CARD, and it is stable.
   *
   * It reads the grid out of a ref rather than closing over it, so expanding a
   * group does not rebuild every node's `data` and re-render the whole canvas.
   */
  const onCardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, key: string): void => {
      const grid = navRef.current;
      let column = -1;
      let row = -1;
      grid.forEach((cells, columnIndex) => {
        cells.forEach((cell, rowIndex) => {
          if (cell.key === key) {
            column = columnIndex;
            row = rowIndex;
          }
        });
      });
      if (column === -1 || row === -1) return;

      const step = (nextColumn: number, nextRow: number): void => {
        const cells = grid[nextColumn];
        if (cells === undefined || cells.length === 0) return;
        const clamped = Math.max(0, Math.min(nextRow, cells.length - 1));
        const cell = cells[clamped];
        if (cell === undefined) return;
        event.preventDefault();
        focusKey(cell.key);
      };

      switch (event.key) {
        case "ArrowRight": {
          // Landing row is chosen by the closest y, not by the same index: two
          // columns rarely have the same number of cards, and index-matching
          // jumps the reader hundreds of pixels up or down for no reason.
          const cells = grid[column + 1];
          if (cells === undefined) return;
          const from = grid[column]?.[row]?.y ?? 0;
          let best = 0;
          cells.forEach((cell, index) => {
            const current = cells[best];
            if (current === undefined) return;
            if (Math.abs(cell.y - from) < Math.abs(current.y - from)) best = index;
          });
          step(column + 1, best);
          return;
        }
        case "ArrowLeft": {
          const cells = grid[column - 1];
          if (cells === undefined) return;
          const from = grid[column]?.[row]?.y ?? 0;
          let best = 0;
          cells.forEach((cell, index) => {
            const current = cells[best];
            if (current === undefined) return;
            if (Math.abs(cell.y - from) < Math.abs(current.y - from)) best = index;
          });
          step(column - 1, best);
          return;
        }
        case "ArrowDown":
          step(column, row + 1);
          return;
        case "ArrowUp":
          step(column, row - 1);
          return;
        case "Home":
          step(0, 0);
          return;
        case "End": {
          const last = grid.length - 1;
          step(last, (grid[last]?.length ?? 1) - 1);
          return;
        }
        case "Enter":
        case " ":
          event.preventDefault();
          activate(key);
          return;
        case "Escape":
          event.preventDefault();
          onSelect(null);
          return;
        default:
          return;
      }
    },
    [activate, focusKey, onSelect],
  );

  /* ----------------------------------------------------------------
   * Nodes
   * ------------------------------------------------------------- */

  /*
   * WHY AN EPOCH AND NOT JUST CLEARING THE MAP.
   *
   * `draggedRef` is a REF — deliberately, so a drag does not re-run the node builder
   * sixty times a second. The cost is that emptying it changes nothing on screen:
   * React has no idea the map it never subscribed to is now different, and the memo
   * below keeps returning its cached nodes at the dragged positions.
   *
   * So "tidy" clears the map AND bumps this, which is in the memo's dependency list
   * and is the only thing that makes the rebuild happen.
   */
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  /** How many cards the reader has dragged. Drives the tidy button's presence. */
  const [moved, setMoved] = useState(0);

  const positionOf = useCallback(
    (entry: PlacedNode): XYPosition =>
      draggedRef.current.get(entry.key) ?? { x: entry.x, y: entry.y },
    // `layoutEpoch` is not read here — it is what invalidates this callback, and
    // through it the node memo, after `draggedRef` is emptied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutEpoch],
  );

  /**
   * Put every card back where the layout says it goes, and re-fit.
   *
   * THE OWNER'S ASK: "there should also be a auto organise button where it puts a the
   * workflow in a lined up state instead of being messy when i organised it
   * incorrectly." Dragging is permanent by design — `draggedRef` is never cleared by a
   * re-fold, an expand, or a new agent arriving — which is right for a deliberate
   * arrangement and leaves no way back from an accidental one. This is the way back.
   *
   * IT ALSO CLEARS `viewAdjusted`. That latch exists so a resize cannot steal a
   * viewport the reader positioned themselves; but asking to tidy IS asking for the
   * automatic view again, so the latch is released and the resize re-fit resumes.
   */
  const tidy = useCallback((): void => {
    draggedRef.current.clear();
    viewAdjusted.current = false;
    setMoved(0);
    setLayoutEpoch((previous) => previous + 1);
    void flow.fitView(fitOptionsFor(shell.current?.clientWidth ?? 0, hudRef.current));
  }, [flow]);

  const firstKey = placement.nodes[0]?.key ?? null;
  const tabStop = tabbable ?? selectedId ?? firstKey;

  const built = useMemo((): Node[] => {
    const columns: ColumnFlowNode[] = placement.columns.map((column) => ({
      id: `column:${column.column}`,
      type: "column",
      position: { x: column.x, y: column.y },
      data: { label: column.label, note: column.note, count: column.count },
      draggable: false,
      selectable: false,
      focusable: false,
      width: NODE_WIDTH,
    }));

    const cards: (AgentFlowNode | GroupFlowNode)[] = placement.nodes.map((entry) => {
      const shared = {
        id: entry.key,
        position: positionOf(entry),
        // THE OWNER'S THIRD ASK. The layout is the starting position and every
        // card can be moved off it; see `dragged` above for why a moved card
        // stays moved.
        draggable: true,
        width: NODE_WIDTH,
      };
      if (entry.kind === "group") {
        return {
          ...shared,
          type: "group",
          data: {
            members: entry.members,
            role: entry.role,
            expanded: entry.expanded,
            isSelected: false,
            tabbable: entry.key === tabStop,
            onCardKeyDown,
          },
        } satisfies GroupFlowNode;
      }
      return {
        ...shared,
        type: "agent",
        data: {
          graphNode: entry.node,
          role: entry.role,
          isSelected: entry.node.id === selectedId,
          tabbable: entry.key === tabStop,
          onCardKeyDown,
        },
      } satisfies AgentFlowNode;
    });

    return [...columns, ...cards];
  }, [placement, positionOf, selectedId, tabStop, onCardKeyDown]);

  /*
   * THE NODE ARRAY IS STATE, AND `measured` IS THE REASON IT HAS TO BE.
   *
   * The obvious shape is a `useMemo` handed straight to `<ReactFlow nodes={…}>`,
   * and that is what this file did until it was measured. It cannot work, and the
   * failure is silent: React Flow's `adoptUserNodes` reads `measured` back OFF the
   * node objects the caller supplied, and sets its `nodesInitialized` flag false
   * for any node where it is missing. A derived array never carries `measured`, so
   * the flag NEVER goes true, `useNodesInitialized()` stays false forever, and the
   * one fit that frames the graph never fires. The symptom was a canvas at scale
   * exactly 1.0 with the session column off-screen to the left — which looks like
   * a bad default zoom and is actually a fit that never ran. Measured in Chromium
   * against this tree: `.react-flow__viewport` held `matrix(1,0,0,1,0,0)` and the
   * union of the node boxes ran 344px past the right edge of the pane.
   *
   * So changes are applied through `applyNodeChanges` — dimensions included — and
   * this effect re-derives structure on top of that, carrying two things forward
   * from the previous array: `measured`, so a re-fold does not un-initialise the
   * flow, and any position the reader dragged a card to.
   */
  const [nodes, setNodes] = useState<Node[]>([]);

  useEffect(() => {
    setNodes((previous) => {
      const prior = new Map(previous.map((node) => [node.id, node]));
      return built.map((next) => {
        const before = prior.get(next.id);
        if (before === undefined) return next;
        const carried: Node = {
          ...next,
          position: draggedRef.current.get(next.id) ?? next.position,
        };
        // Spread rather than assign: under `exactOptionalPropertyTypes` an
        // explicit `measured: undefined` is not the same as an absent one, and
        // React Flow treats the absent case as "not measured yet".
        return before.measured === undefined
          ? carried
          : { ...carried, measured: before.measured };
      });
    });
  }, [built]);

  /* ----------------------------------------------------------------
   * Edges
   * ------------------------------------------------------------- */

  /**
   * Which keys the reader is pointing at. An edge energises when either of its
   * ends is one of them — so clicking a card lights the wires into and out of
   * it, which is the answer to "the lines should be animated" on a run that
   * finished hours ago and has nothing genuinely live left to show.
   */
  const pointedAt = useMemo((): ReadonlySet<string> => {
    const set = new Set<string>();
    if (selectedId !== null) set.add(selectedId);
    if (hovered !== null) set.add(hovered);
    return set;
  }, [selectedId, hovered]);

  const edges = useMemo((): Edge[] => {
    return placement.edges.map((edge): FlowEdge => {
      // LIVE MEANS "THIS DELEGATION IS ACTIVE NOW", which is a fact about the
      // CHILD: the parent is almost always still running too, so keying on the
      // parent would light up every edge on the canvas for the whole run.
      const live = edge.childState === "running" && !edge.inferred;
      const focused =
        !edge.inferred && (pointedAt.has(edge.from) || pointedAt.has(edge.to));
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "flow",
        data: {
          inferred: edge.inferred,
          fromRole: edge.fromRole,
          toRole: edge.toRole,
          live,
          focused,
          sweep: sweeping && !edge.inferred && !live && !focused,
          depth: edge.depth,
          centerX: edge.centerX,
        },
        selectable: false,
        focusable: false,
      };
    });
  }, [placement.edges, pointedAt, sweeping]);

  /* ----------------------------------------------------------------
   * The one fit, and the one sweep
   * ------------------------------------------------------------- */

  const maxDepth = useMemo(
    () => placement.edges.reduce((deepest, edge) => Math.max(deepest, edge.depth), 0),
    [placement.edges],
  );

  /*
   * READ THROUGH REFS, AND THAT IS NOT A STYLE CHOICE.
   *
   * Both of these were dependencies of the fit effect below, and both change on
   * renders that have nothing to do with fitting: `hud` is a fresh JSX element
   * every time the page re-renders, and the page re-renders once a second because
   * the run clock ticks. The effect then re-ran once a second, returned early on
   * `hasFitted`, and its CLEANUP had already cancelled the sweep's timeout — so
   * `sweeping` was never set back to false and every connector on the canvas
   * pulsed forever. Measured, not theorised: the probe found six travelling
   * comets alive four seconds after a 1,390ms sweep should have ended.
   *
   * That is the exact failure mode this canvas has a rule against — motion that
   * is decoration because it never stops — introduced by the code meant to
   * introduce it correctly. So the fit effect depends only on things that decide
   * WHETHER to fit, and the sweep's timer is its own effect keyed on the flag it
   * clears.
   */
  const hudRef = useRef(hud !== undefined);
  hudRef.current = hud !== undefined;
  const maxDepthRef = useRef(maxDepth);
  maxDepthRef.current = maxDepth;

  useEffect(() => {
    if (hasFitted.current) return;
    if (!nodesInitialized) return;
    if (placement.nodes.length === 0) return;
    hasFitted.current = true;

    void flow.fitView(fitOptionsFor(shell.current?.clientWidth ?? 0, hudRef.current));

    /*
     * THE ARRIVAL SWEEP. One pulse down every connector, staggered by its depth
     * from the session, then over. This is what makes the graph read as a FLOW
     * at a glance rather than as a diagram — the owner's actual test of success —
     * and it is finite by construction, so it cannot become perpetual motion.
     *
     * NOT PLAYED AT ALL under `prefers-reduced-motion`. A reveal is exactly the
     * category of motion that query exists to refuse, and the graph is fully
     * legible without it.
     */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setSweeping(true);
  }, [nodesInitialized, placement.nodes.length, flow]);

  /*
   * RE-FIT WHEN THE PANE CHANGES SIZE — and only while the view is still the
   * one this component chose.
   *
   * WHY THIS IS NEEDED NOW. The fit above runs exactly once, against the pane
   * width it saw on mount, and `fitOptionsFor` reserves 388px on the left for the
   * HUD. That was survivable while `main` capped every route at 1440px, because
   * the pane was 1440px on mount and 1440px forever. It is not survivable now
   * that `/runs/<id>` is full bleed: the pane is as wide as the window, so
   * dragging the window — or opening the app on one monitor and moving it to
   * another — left a transform computed for a pane that no longer exists. The
   * graph stayed bunched at its old scale in the corner of a larger canvas, which
   * is the same complaint as the gutters wearing different clothes.
   *
   * WHY IT CANNOT JUST RE-FIT UNCONDITIONALLY. This file's contract is that a
   * dragged node keeps its position forever and "`fitView` runs exactly once and
   * never after a drag, so the two cannot fight". A resize-triggered fit would
   * fight it — and would also throw away a pan or zoom the reader performed
   * deliberately, which is worse than a stale fit because the reader chose the
   * thing being discarded.
   *
   * So `viewAdjusted` latches on the first USER-initiated change and this effect
   * gives up permanently once it does. The two signals:
   *
   *   - a node drag stopping (`onNodeDragStop`);
   *   - `onMoveEnd` with a non-null event. React Flow passes the triggering
   *     MouseEvent/TouchEvent for a user pan or zoom and `null` when the movement
   *     was programmatic — confirmed against the API reference, not assumed, and
   *     it is the whole reason this can tell its own `fitView` apart from a drag
   *     of the pane.
   *
   * WIDTH AND HEIGHT BOTH MATTER, but only a MATERIAL change re-fits. A 1px
   * jitter — a scrollbar appearing inside the sheet, a subpixel reflow — would
   * otherwise animate the graph for no reason.
   */
  useEffect(() => {
    const element = shell.current;
    if (element === null) return;

    let last = { width: element.clientWidth, height: element.clientHeight };

    const observer = new ResizeObserver(() => {
      if (viewAdjusted.current) return;
      if (!hasFitted.current) return;
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
      };
      if (
        Math.abs(next.width - last.width) < RESIZE_REFIT_THRESHOLD_PX &&
        Math.abs(next.height - last.height) < RESIZE_REFIT_THRESHOLD_PX
      ) {
        return;
      }
      last = next;
      void flow.fitView(fitOptionsFor(next.width, hudRef.current));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [flow]);

  /** The sweep's off switch, keyed on nothing but the flag it turns off. */
  useEffect(() => {
    if (!sweeping) return;
    const timer = window.setTimeout(
      () => setSweeping(false),
      maxDepthRef.current * SWEEP_STEP_MS + SWEEP_TAIL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [sweeping]);

  /*
   * SELECTING FROM ANYWHERE BRINGS THE CARD INTO VIEW.
   *
   * The run sheet's agent index and the canvas share one selection, which is
   * worth nothing if choosing an agent in the list highlights a card three
   * columns off-screen. This is motion as FEEDBACK for a user action — the one
   * category that earns an animation — and it only fires when the card is
   * genuinely outside the pane. A card already on screen is left where it is;
   * re-centring it would move the whole graph under someone who could already
   * see what they clicked.
   */
  const centred = useRef<string | null>(null);

  useEffect(() => {
    if (selectedId === null) {
      centred.current = null;
      return;
    }
    if (centred.current === selectedId) return;
    centred.current = selectedId;
    const target = placement.nodes.find((entry) => entry.key === selectedId);
    const box = shell.current?.getBoundingClientRect();
    if (target === undefined || box === undefined) return;

    const centreX = target.x + NODE_WIDTH / 2;
    const centreY = target.y + target.height / 2;
    const screen = flow.flowToScreenPosition({ x: centreX, y: centreY });
    const margin = 40;
    /*
     * THE VISIBLE RIGHT EDGE, NOT THE PANE'S. The detail sheet this selection
     * opens covers `rightInset` pixels of it, and the whole point of panning is
     * that the reader can see the card the sheet is describing.
     */
    const inset = insetOf(box.width);
    const onScreen =
      screen.x > box.left + margin &&
      screen.x < box.right - inset - margin &&
      screen.y > box.top + margin &&
      screen.y < box.bottom - margin;
    if (onScreen) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Half the inset, in flow units: `setCenter` centres on the PANE, so the
    // target has to be pushed right to land in the middle of what is left.
    const zoom = flow.getZoom();
    void flow.setCenter(centreX + inset / 2 / zoom, centreY, {
      zoom,
      duration: reduce ? 0 : 380,
    });
  }, [selectedId, placement.nodes, flow, insetOf]);

  /* ----------------------------------------------------------------
   * Handlers
   * ------------------------------------------------------------- */

  /**
   * Every change is applied, and position changes are ALSO recorded.
   *
   * `applyNodeChanges` is what keeps `measured` on the node objects, which is what
   * keeps `nodesInitialized` true — see the effect above for the failure that
   * taught this. The extra bookkeeping into `draggedRef` is what makes a drag
   * durable: `applyNodeChanges` writes the live position into the array, and the
   * array is rebuilt from the layout whenever the graph folds, so without a record
   * of the reader's intent every dragged card would spring home on the next
   * expand.
   */
  const onNodesChange = useCallback((changes: readonly NodeChange<Node>[]): void => {
    for (const change of changes) {
      if (change.type !== "position") continue;
      if (change.position === undefined) continue;
      draggedRef.current.set(change.id, change.position);
      // Mirrors the ref's SIZE into state so the tidy button can appear. The ref
      // stays the source of truth for positions — this is only a count, so it
      // re-renders once per newly-moved card rather than once per pointer move.
      setMoved(draggedRef.current.size);
    }
    setNodes((current) => applyNodeChanges([...changes], current));
  }, []);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (node.type === "column") return;
      activate(node.id);
    },
    [activate],
  );

  const onNodeMouseEnter = useCallback<NodeMouseHandler>((_event, node) => {
    if (node.type === "column") return;
    setHovered(node.id);
  }, []);

  const onNodeMouseLeave = useCallback<NodeMouseHandler>(() => {
    setHovered(null);
  }, []);

  const onPaneClick = useCallback((): void => {
    onSelect(null);
  }, [onSelect]);

  /** Roles actually present, so the legend is four entries and not always eight. */
  const rolesPresent = useMemo((): readonly AgentRole[] => {
    const present = new Set(placement.nodes.map((entry) => entry.role));
    return ROLE_ORDER.filter((role) => present.has(role));
  }, [placement.nodes]);

  const allExpanded =
    placement.groupKeys.length > 0 &&
    placement.groupKeys.every((key) => expandedGroups.has(key));

  /**
   * How many CARDS the unfold button would put on the canvas.
   *
   * Not `placement.foldedCount`, which is how many are hidden — members minus the
   * one the deck already stands for. A button reading "unfold 5" beside a deck
   * captioned "6 identical tasks" is two numbers for one thing, and the reader has
   * to work out which is which. This is the number they will see afterwards.
   */
  const foldedMembers = useMemo(
    () =>
      placement.nodes
        .filter((entry) => entry.kind === "group" && !entry.expanded)
        .reduce((total, entry) => total + entry.members.length, 0),
    [placement.nodes],
  );

  const toggleAllGroups = useCallback((): void => {
    setExpandedGroups((current) => {
      const every = placement.groupKeys.every((key) => current.has(key));
      return every ? new Set<string>() : new Set(placement.groupKeys);
    });
  }, [placement.groupKeys]);

  const empty = placement.nodes.length === 0;

  return (
    <div ref={shell} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        colorMode="dark"
        onNodesChange={onNodesChange}
        nodesDraggable
        nodesConnectable={false}
        /*
         * Selection is driven by `onNodeClick` into this component's own state
         * rather than by React Flow's selection model, so the sheet, the agent
         * index and the card ring are all reading one value.
         *
         * `nodesFocusable` STAYS OFF and that is not a contradiction of the
         * keyboard work above. React Flow's own focus handling puts a tab stop
         * on every node and binds the arrow keys to MOVING the focused node,
         * which is a different feature from navigating between them and cannot
         * coexist with it. The roving tabindex and the arrow keys live on the
         * card shells in `agent-node.tsx`, where the placement is known.
         */
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        /*
         * The two "the reader has taken the wheel" signals. Both feed one ref that
         * permanently disables the resize re-fit — see `viewAdjusted`.
         */
        onNodeDragStop={markViewAdjusted}
        onMoveEnd={onMoveEnd}
        proOptions={{ hideAttribution: true }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        panOnScroll
        selectionOnDrag={false}
        /*
         * THE LABEL DESCRIBES THE CONTROLS, because they are now real. The
         * previous version pointed at the list beside the canvas and said this
         * one offered "partial affordances only"; that list has moved behind the
         * run sheet, so this says how to drive the graph itself instead of
         * naming somewhere else to go.
         */
        aria-label="Agent delegation graph. Arrow keys move between agents, Enter opens an agent's detail, Escape closes it."
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={28}
          size={1}
          color="var(--canvas-grid)"
        />
        <Controls
          showInteractive={false}
          fitViewOptions={MANUAL_FIT_OPTIONS}
          className="!bottom-3 !left-3 !overflow-hidden !rounded !border !border-line !shadow-none"
        />
      </ReactFlow>

      {/* The run-level affordance. Top-left, over the flow, never re-parenting it. */}
      {hud !== undefined && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[min(560px,calc(100%-140px))] flex-col gap-2">
          {hud}
        </div>
      )}

      {/*
       * Canvas controls.
       *
       * TOP-RIGHT WHEN THERE IS ROOM, BOTTOM-RIGHT WHEN THERE IS NOT. The run
       * chip is `min(360px, 100vw - 32px)` wide, so on a 375px viewport it reaches
       * within 32px of the right edge and these buttons landed on top of its own
       * "run detail" button — measured in a 375px screenshot, not predicted. Below
       * the same 900px the fit uses, they move to the opposite corner from the
       * zoom controls.
       */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2 min-[900px]:bottom-auto min-[900px]:top-3">
        {placement.groupKeys.length > 0 && (
          <Button
            variant="default"
            className="pointer-events-auto"
            onClick={toggleAllGroups}
            title={
              allExpanded
                ? "Fold every group of identical tasks back into one card each."
                : "Show every folded task as its own card."
            }
          >
            {allExpanded
              ? `fold ${String(placement.groupKeys.length)}`
              : `unfold ${String(foldedMembers)}`}
          </Button>
        )}

        {/*
          * AUTO-ORGANISE. Shown only once something has actually been moved: a button
          * that tidies an untouched graph does nothing, and a control that does nothing
          * teaches the reader to distrust the others.
          */}
        {moved > 0 && (
          <Button
            variant="default"
            className="pointer-events-auto"
            onClick={tidy}
            title="Put every card back where the layout puts it, and frame the whole run again."
          >
            tidy up
          </Button>
        )}
        {ambientCount > 0 && (
          <Button
            variant={showAmbient ? "primary" : "default"}
            className="pointer-events-auto"
            onClick={() => onShowAmbient(!showAmbient)}
            title="Agents the CLI marked skip_transcript — housekeeping work that does not belong to the ticket."
          >
            housekeeping {ambientCount}
          </Button>
        )}
      </div>

      {/*
       * THE LEGEND, and it only lists roles this run actually used.
       *
       * Colour that has to be looked up is colour that is not working, so this is
       * small, permanent and at the bottom edge where it is out of the graph's
       * way. Eight fixed entries would be a chart nobody reads; four that are all
       * on screen is a key.
       *
       * HIDDEN BELOW 900px, and that costs nothing: every card carries its role as
       * a WORD in its role chip, so the legend is a convenience for reading the
       * wires at a glance rather than the only place the mapping is stated. On a
       * 375px canvas it wrapped to two lines across a third of the graph.
       */}
      {!empty && rolesPresent.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 hidden -translate-x-1/2 min-[900px]:block">
          <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full border border-line bg-canvas/85 px-3 py-1.5 backdrop-blur">
            {rolesPresent.map((role) => (
              <li
                key={role}
                title={ROLE_MEANING[role]}
                className="pointer-events-auto flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-dim"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-[6px] rounded-[1px]"
                  style={{ backgroundColor: roleColorVar(role) }}
                />
                {ROLE_LABEL[role]}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Overlays. Inside the flow's box, never wrapped around it. */}
      {(empty || !ready) && (
        <div
          className={cx(
            "pointer-events-none absolute inset-0 grid place-items-center p-8",
            // Loading gets a scrim; the empty state does not, so the dot grid
            // stays visible behind it and the canvas still reads as a surface.
            !ready && "bg-canvas/55 backdrop-blur-[1px]",
          )}
        >
          {!ready ? (
            <div className="flex items-center gap-2 text-[12px] text-ink-faint">
              <span
                aria-hidden="true"
                className="inline-block size-[6px] animate-pulse rounded-full bg-accent"
              />
              Reading the delegation graph…
            </div>
          ) : (
            /*
             * THREE EMPTY STATES, AND THEY WERE ONE — corrected 2026-07-30.
             *
             * A run 57 seconds old, in the SPEC phase, on Claude, was shown "This run
             * emitted no graph events. Runs recorded before the canvas existed, and runs
             * on the Codex provider, contain none." Every clause of that is false about
             * that run, and the owner reasonably read it as a bug: "when you start a new
             * run why is there no orchestator showing?"
             *
             * THE ACTUAL REASON, which nothing on screen said: the orchestrator node is
             * minted by the BUILD segment. While the spec is being authored, audited and
             * frozen there is no builder session, so there are no `graph_*` events to
             * fold — measured on the live run as 0 `graph_agent` of 6 total events.
             * Nothing is wrong; the graph has not started yet.
             *
             * So a run that is still WORKING says so and names what it is doing, and only
             * a run that is genuinely over falls through to the historical explanation.
             */
            <div className="max-w-[420px] rounded border border-line bg-surface/90 px-5 py-4 text-center">
              <p className="text-[13px] font-semibold text-ink">
                {graph.nodes.length > 0
                  ? "Only housekeeping so far"
                  : runIsActive
                    ? "The agents have not started yet"
                    : "No delegation recorded"}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">
                {graph.nodes.length > 0
                  ? "Every agent on this run is housekeeping. Use the housekeeping toggle to show them."
                  : runIsActive
                    ? "The acceptance suite is being written and frozen first — that happens before any agent is spawned, so there is nothing to draw yet. The graph appears as soon as the build starts."
                    : "This run emitted no graph events. Runs recorded before the canvas existed, and runs on the Codex provider, contain none — the run sheet's trace is their full record."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OrchestrationCanvas(props: CanvasProps): ReactNode {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
