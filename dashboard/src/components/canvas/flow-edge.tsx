"use client";

/**
 * flow-edge.tsx — the delegation connector.
 *
 * THE MOTION IS THE MESSAGE. Three treatments, and which one an edge gets is
 * decided entirely by data the server sent:
 *
 *   1. LIVE + EXACT — a soft glow tube with a lighter dashed core travelling
 *      along it, per the owner's connector reference. Drawn only while the
 *      CHILD agent is still `running`. Work is moving down this edge right now.
 *
 *   2. SETTLED + EXACT — the same path, one flat hairline, no glow, no motion.
 *      The delegation happened and is over. Nothing on a finished branch moves,
 *      which is what makes the moving ones worth looking at.
 *
 *   3. INFERRED — dim, dotted, static, and LABELLED. `attribution: "inferred"`
 *      means the server GUESSED which agent a message belonged to: hook
 *      messages carry no task identity, so hook->agent attribution is an
 *      inference and the contract makes every emitter admit it. An inferred
 *      edge therefore never gets the glow and never flows, even when its child
 *      is running — a guess animated as confidently as a fact is the canvas
 *      lying about how much it knows. The word `inferred` rides on the edge so
 *      the difference does not depend on a legend somewhere else on the page.
 *
 * Reduced motion is handled in globals.css, where the travelling dash is turned
 * off AND the dash pattern is replaced by a solid stroke — a frozen dash would
 * make a live exact edge look like an inferred one to exactly the readers who
 * cannot use the motion to tell them apart.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { ReactNode } from "react";

export type FlowEdgeData = {
  /** The child agent is running AND the attribution is exact. */
  readonly flowing: boolean;
  readonly inferred: boolean;
};

export type FlowEdge = Edge<FlowEdgeData, "flow">;

export function DelegationEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdge>): ReactNode {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    // A gentle curve. The default (0.25) kinks hard when two cards are close in
    // y, which is common inside one lane.
    curvature: 0.42,
  });

  const inferred = data?.inferred === true;
  const flowing = data?.flowing === true && !inferred;

  if (inferred) {
    return (
      <>
        <BaseEdge
          id={`${String(sourceX)}-${String(targetX)}-inferred`}
          path={path}
          className="edge-line"
          style={{
            stroke: "var(--color-ink-faint)",
            strokeWidth: 1.25,
            strokeDasharray: "1 5",
            opacity: 0.5,
          }}
        />
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-full border border-dashed border-line-strong bg-canvas/90 px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint"
            style={{
              transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
            }}
          >
            inferred
          </div>
        </EdgeLabelRenderer>
      </>
    );
  }

  if (!flowing) {
    return (
      <BaseEdge
        id={`${String(sourceX)}-${String(targetX)}-settled`}
        path={path}
        className="edge-line"
        style={{ stroke: "var(--color-line-strong)", strokeWidth: 1.5 }}
      />
    );
  }

  return (
    <>
      {/* The tube: wide, soft, low opacity. Underneath everything. */}
      <path d={path} className="edge-glow" />
      {/* A dim continuous stroke so the tube still reads as a connection
          between the travelling dashes rather than as a row of loose dots. */}
      <path
        d={path}
        className="edge-line"
        style={{ stroke: "var(--color-accent)", strokeWidth: 1.25, opacity: 0.4 }}
      />
      {/* The travelling core. */}
      <path d={path} className="edge-core edge-core--flowing" />
    </>
  );
}
