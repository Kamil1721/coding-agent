"use client";

/**
 * orchestration-canvas.tsx — the run, as a picture.
 *
 * THE MOUNT IS THE FRAGILE PART, so it is the part with the most rules:
 *
 *   - `<ReactFlow>` IS ALWAYS MOUNTED, INCLUDING WITH ZERO NODES. The obvious
 *     shape — `nodes.length === 0 ? <Empty/> : <ReactFlow/>` — remounts the
 *     flow when the first agent arrives and throws away the reader's pan and
 *     zoom mid-run. The empty and loading states are OVERLAYS inside a flow
 *     that never unmounts (spec §9.3).
 *   - NO `key` THAT CHANGES. Same failure, quieter cause.
 *   - `fitView` is initial-only and the initial state is empty, so an empty fit
 *     would leave the first agents parked outside the viewport. The one
 *     imperative fit below fires exactly once, on the 0 -> some transition, and
 *     never again — a re-fit on every arrival would yank the canvas out from
 *     under someone reading it.
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
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import type { GraphState } from "@/lib/api-types";
import { Button, cx } from "@/components/ui";
import { AgentNode, LaneNode, type AgentFlowNode, type LaneFlowNode } from "./agent-node";
import { DelegationEdge, type FlowEdge } from "./flow-edge";
import { NODE_WIDTH, estimateHeight, placeGraph } from "./layout";

/**
 * Declared at module scope, NOT inline.
 *
 * React Flow compares these by identity and logs a console warning on every
 * render when they are rebuilt — which is both noise and a real re-render of
 * every node on the canvas.
 */
const NODE_TYPES = { agent: AgentNode, lane: LaneNode } as const;
const EDGE_TYPES = { flow: DelegationEdge } as const;

/**
 * Zoom bounds, and the one number this file argued with.
 *
 * A run that used all five lanes is six columns and roughly 2,450px wide. An
 * unclamped `fitView` framed that inside a 780px pane at **scale 0.245** —
 * measured, in the browser, not estimated — which renders 268px cards as 66px
 * smudges. Every pill, every count and every status word on them is unreadable,
 * which is to say the entire reason this is a DOM canvas and not WebGL had been
 * thrown away by the default fit.
 *
 * `FIT_MIN_ZOOM` is therefore a legibility floor, not a preference. Below it the
 * canvas stops carrying information. A small graph still fits whole; a big one
 * opens READABLE and is panned, which is what every graph editor does and what
 * the pan/zoom affordances are for.
 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.5;
const FIT_MIN_ZOOM = 0.85;
const FIT_OPTIONS = { padding: 0.1, maxZoom: 1, minZoom: FIT_MIN_ZOOM } as const;

/** Where the graph's left edge sits when it is too wide to frame whole. */
const LEFT_GUTTER = 40;

export interface CanvasProps {
  readonly graph: GraphState;
  /** False while the snapshot is still in flight. Drives the loading overlay. */
  readonly ready: boolean;
  readonly selectedId: string | null;
  readonly onSelect: (nodeId: string | null) => void;
  readonly showAmbient: boolean;
  readonly onShowAmbient: (next: boolean) => void;
}

function CanvasInner({
  graph,
  ready,
  selectedId,
  onSelect,
  showAmbient,
  onShowAmbient,
}: CanvasProps): ReactNode {
  const placement = useMemo(
    () => placeGraph(graph, { showAmbient }),
    [graph, showAmbient],
  );

  const ambientCount = useMemo(
    () => graph.nodes.filter((node) => node.ambient).length,
    [graph.nodes],
  );

  const nodes = useMemo((): Node[] => {
    const lanes: LaneFlowNode[] = placement.lanes.map((lane) => ({
      id: `lane:${lane.lane ?? "session"}`,
      type: "lane",
      position: { x: lane.x, y: lane.y },
      data: { label: lane.label, count: lane.count },
      draggable: false,
      selectable: false,
      focusable: false,
      width: NODE_WIDTH,
    }));

    const agents: AgentFlowNode[] = placement.nodes.map((placed) => ({
      id: placed.node.id,
      type: "agent",
      position: { x: placed.x, y: placed.y },
      data: { graphNode: placed.node, isSelected: placed.node.id === selectedId },
      draggable: false,
      width: NODE_WIDTH,
    }));

    return [...lanes, ...agents];
  }, [placement, selectedId]);

  const edges = useMemo((): Edge[] => {
    const stateOf = new Map(graph.nodes.map((node) => [node.id, node.state]));
    return placement.edges.map((edge): FlowEdge => {
      // FLOW MEANS "THIS DELEGATION IS ACTIVE NOW", which is a fact about the
      // CHILD: the parent is almost always still running too, so keying on the
      // parent would light up every edge on the canvas for the whole run.
      const childRunning = stateOf.get(edge.to) === "running";
      return {
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "flow",
        data: { flowing: childRunning && !edge.inferred, inferred: edge.inferred },
        selectable: false,
        focusable: false,
      };
    });
  }, [placement.edges, graph.nodes]);

  const flow = useReactFlow();
  const hasFitted = useRef(false);
  const shell = useRef<HTMLDivElement | null>(null);

  /** The graph's own width, from the placement rather than from the DOM. */
  const graphWidth = useMemo(() => {
    let right = 0;
    for (const placed of placement.nodes) right = Math.max(right, placed.x + NODE_WIDTH);
    return right;
  }, [placement.nodes]);

  useEffect(() => {
    if (hasFitted.current || placement.nodes.length === 0) return;
    hasFitted.current = true;
    // One frame's delay: the cards are auto-height, so a fit computed before
    // the browser has measured them frames the graph against stale boxes.
    const raf = window.requestAnimationFrame(() => {
      void flow.fitView(FIT_OPTIONS).then(() => {
        // WHEN THE FIT HIT THE FLOOR, IT CENTRED A GRAPH THAT DOES NOT FIT —
        // which drops the reader in the middle of the pipeline with the session
        // that started it off-screen to the left. Re-anchor to the left edge so
        // the canvas opens where the run did. Only when it is genuinely too
        // wide; a graph that fits whole is left exactly where the fit put it.
        const width = shell.current?.clientWidth ?? 0;
        const { x, y, zoom } = flow.getViewport();
        if (width === 0 || graphWidth * zoom <= width) return;
        if (x >= LEFT_GUTTER) return;
        flow.setViewport({ x: LEFT_GUTTER, y, zoom });
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [placement.nodes.length, graphWidth, flow]);

  /*
   * SELECTING FROM THE LIST BRINGS THE CARD INTO VIEW.
   *
   * The roster and the canvas share one selection, which is worth nothing if
   * choosing an agent in the list highlights a card three columns off-screen.
   * This is motion as FEEDBACK for a user action — the one category that
   * earns an animation — and it only fires when the card is genuinely outside
   * the pane. A card already on screen is left where it is; re-centring it
   * would move the whole graph under someone who could already see what they
   * clicked.
   */
  const centred = useRef<string | null>(null);

  useEffect(() => {
    if (selectedId === null) {
      centred.current = null;
      return;
    }
    if (centred.current === selectedId) return;
    const target = placement.nodes.find((entry) => entry.node.id === selectedId);
    const box = shell.current?.getBoundingClientRect();
    if (target === undefined || box === undefined) return;
    centred.current = selectedId;

    const centreX = target.x + NODE_WIDTH / 2;
    const centreY = target.y + estimateHeight(target.node) / 2;
    const screen = flow.flowToScreenPosition({ x: centreX, y: centreY });
    const margin = 40;
    const onScreen =
      screen.x > box.left + margin &&
      screen.x < box.right - margin &&
      screen.y > box.top + margin &&
      screen.y < box.bottom - margin;
    if (onScreen) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void flow.setCenter(centreX, centreY, {
      zoom: flow.getZoom(),
      duration: reduce ? 0 : 380,
    });
  }, [selectedId, placement.nodes, flow]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (node.type !== "agent") return;
      onSelect(node.id === selectedId ? null : node.id);
    },
    [onSelect, selectedId],
  );

  const onPaneClick = useCallback((): void => {
    onSelect(null);
  }, [onSelect]);

  const empty = placement.nodes.length === 0;

  return (
    <div ref={shell} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        colorMode="dark"
        nodesDraggable={false}
        nodesConnectable={false}
        /*
         * Selection is driven by `onNodeClick` into this component's own state
         * rather than by React Flow's selection model, so the inspector, the
         * roster list and the card ring are all reading one value. The spec's
         * measured configuration is otherwise unchanged.
         */
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={FIT_OPTIONS}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        panOnScroll
        selectionOnDrag={false}
        /*
         * THE LABEL POINTS AT THE EQUIVALENT REPRESENTATION rather than
         * claiming this one is accessible. React Flow offers partial
         * affordances only (spec §9.3), so the honest thing is to name what
         * this is and say where the same data can be read as a list — which is
         * the roster beside it, a real `<ul>` of real buttons sharing this
         * canvas's selection. An earlier draft of this line paired an
         * `aria-label` with `role="presentation"`, which is a contradiction:
         * presentation removes the element from the accessibility tree, taking
         * the label with it.
         */
        aria-label="Agent delegation graph. A visual canvas — the agent list beside it carries the same data as text."
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={28}
          size={1}
          color="var(--canvas-grid)"
        />
        {/*
         * THE FIT BUTTON IS NOT THE INITIAL FIT, and that is the point. The
         * opening view is clamped to a zoom where the cards can be read; this
         * one is deliberately unclamped, so it answers "show me the whole run"
         * even when the whole run only fits at 0.25. Two different questions,
         * two different framings.
         */}
        <Controls
          showInteractive={false}
          fitViewOptions={{ padding: 0.12, minZoom: MIN_ZOOM, maxZoom: 1 }}
          className="!bottom-3 !left-3 !overflow-hidden !rounded !border !border-line !shadow-none"
        />
      </ReactFlow>

      {/* Toolbar. Sits above the flow; never re-parents it. */}
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
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
            <div className="max-w-[420px] rounded border border-line bg-surface/90 px-5 py-4 text-center">
              <p className="text-[13px] font-semibold text-ink">No delegation recorded</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">
                {graph.nodes.length > 0
                  ? "Every agent on this run is housekeeping. Use the housekeeping toggle to show them."
                  : "This run emitted no graph events. Runs recorded before the canvas existed, and runs on the Codex provider, contain none — the trace beside this is their full record."}
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
