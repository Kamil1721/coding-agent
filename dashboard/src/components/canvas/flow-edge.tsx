"use client";

/**
 * flow-edge.tsx — the delegation connector, rebuilt as a conduit.
 *
 * WHAT THIS REPLACED AND WHY. The previous connector was a 9px translucent glow
 * path with a 2px dashed core sliding along it. The owner's verdict was "mega
 * basic", and it was right: a uniform dash pattern travelling along a hairline is
 * the most recognisable cheap-diagram effect there is, and a thicker version of
 * it is a bigger cheap effect. The quality in a real node editor comes from
 * CONSTRUCTION, not motion — a cable that reads as a physical object lying on the
 * surface — so this file now stacks four static strokes per edge and spends
 * motion sparingly on top. See globals.css for what each of the four layers is
 * doing; the ordering here is bottom-to-top and is load-bearing.
 *
 * THE THREE TREATMENTS SURVIVE, AND WHICH ONE AN EDGE GETS IS STILL DECIDED
 * ENTIRELY BY DATA THE SERVER SENT:
 *
 *   1. INFERRED — dim, dotted, grey, static, and LABELLED.
 *      `attribution: "inferred"` means the server GUESSED which agent a message
 *      belonged to: hook messages carry no task identity, so hook->agent
 *      attribution is an inference and the contract makes every emitter admit
 *      it. An inferred edge gets no casing, no role gradient, no bloom and never
 *      animates — even when its child is running. A guess drawn with a fact's
 *      ceremony is the canvas lying about how much it knows. The word `inferred`
 *      rides on the edge so the difference does not depend on a legend somewhere
 *      else on the page.
 *
 *   2. DELEGATED, SETTLED — the full four-layer conduit, unlit. The delegation
 *      happened and is over.
 *
 *   3. DELEGATED, ENERGISED — the conduit plus a real `feGaussianBlur` bloom and
 *      a travelling comet. Three things energise an edge and they mean different
 *      things: the child is RUNNING (loops forever), the reader is POINTING at
 *      one of its ends (loops while they are), or the graph is playing its
 *      one-shot ARRIVAL sweep (fires once, staggered by depth, then stops).
 *
 * THE GRADIENT IS THE IDEA WORTH KEEPING. Each conduit's body is filled with a
 * per-edge gradient running from the PARENT's role hue to the CHILD's, along the
 * source-to-target axis. So a wire from the orchestrator to a design agent
 * visibly carries brass into orchid, and a reader can see design work being
 * handed to a build agent without reading either card. It costs one `<defs>` per
 * edge and no animation frames at all — which is why it, and not the comet, is
 * the layer doing most of the work.
 *
 * WHY THE BLOOM FILTER IS PER-EDGE INSTEAD OF ONE SHARED `<defs>`. A shared
 * filter would have to be sized in `objectBoundingBox` units, and the SVG spec
 * DISABLES a filter whose referencing element has a zero-height bounding box —
 * which is exactly what a connector between two cards at the same y is, and
 * centred columns produce those constantly. So the region is computed in user
 * space from the endpoints. The filtered path is the STATIC full-length body,
 * never the animated comet: a blur re-rasterises whenever its input changes, and
 * filtering the comet would pay for a Gaussian on every frame.
 *
 * REDUCED MOTION is handled in globals.css, where the comet's dash pattern is
 * replaced by a solid stroke as well as being stopped — the same reasoning the
 * previous implementation used, for the sharper version of the same failure: a
 * frozen comet parks one bright blob at an arbitrary point on the wire.
 */

import {
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { CSSProperties, ReactNode } from "react";

import { roleColorVar, type AgentRole } from "./roles";

export type FlowEdgeData = {
  readonly inferred: boolean;
  readonly fromRole: AgentRole;
  readonly toRole: AgentRole;
  /** The child agent is running AND the attribution is exact. */
  readonly live: boolean;
  /** The reader has selected, hovered or focused one of this edge's ends. */
  readonly focused: boolean;
  /** The one-shot arrival sweep is playing right now. */
  readonly sweep: boolean;
  /** Hops from the root, which is what staggers the sweep. */
  readonly depth: number;
  /**
   * The x every edge from this source into this column turns vertical at.
   * Shared, which is what merges a fan-out into one trunk. `null` when the
   * target is not to the right of the source.
   */
  readonly centerX: number | null;
};

export type FlowEdge = Edge<FlowEdgeData, "flow">;

/**
 * Corner radius and the gap the cable holds off a card before it turns.
 *
 * 22 against a 10.5px casing is very close to the ratio the generated reference
 * draws — a corner about twice the cable's own width, which is what makes the
 * turn read as a bent cable rather than as a mitred polyline. Below about 14 it
 * starts to look like a circuit trace.
 */
const CORNER_RADIUS = 22;
const HANDLE_OFFSET = 26;

/** Milliseconds of stagger per hop, for the arrival sweep. */
const SWEEP_STEP_MS = 190;

/**
 * SVG ids have to survive `url(#…)`, and a placed edge id is `n1->group:1`.
 *
 * `>` and `:` are legal in an HTML id and are NOT legal unescaped inside a CSS
 * `url()`, which is how the `filter` property below references one. Rather than
 * escape at each use site, the id is folded to word characters once.
 */
function safeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function DelegationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdge>): ReactNode {
  const centerX = data?.centerX;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: CORNER_RADIUS,
    offset: HANDLE_OFFSET,
    ...(centerX === null || centerX === undefined ? {} : { centerX }),
  });

  const inferred = data?.inferred === true;

  if (inferred) {
    return (
      <>
        {/* The same groove every wire gets, and nothing running in it. */}
        <path d={path} className="conduit-rim" />
        <path d={path} className="conduit-casing" />
        <path id={`${safeId(id)}-inferred`} d={path} className="conduit-guess" />
        <EdgeLabelRenderer>
          {/*
            * "GUESSED PARENT", NOT "INFERRED". The old label was this codebase's
            * word for the mechanism, not the reader's word for what happened:
            * `inferred` names the server's attribution step, while what the
            * owner needs to know is WHICH CLAIM is uncertain — that this edge
            * says who spawned whom, and that part is a guess. The node badge
            * keeps saying `inferred` because there it qualifies the AGENT and
            * the tooltip explains the mechanism; here the edge IS the claim.
            *
            * Coloured, not grey, and the border matches the stroke so the label
            * reads as part of the wire rather than as chrome floating over it.
            * See `--edge-guess` for why that hue.
            */}
          <div
            className="nodrag nopan pointer-events-none absolute rounded-full border border-dashed bg-canvas/90 px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.14em]"
            style={{
              transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
              borderColor: "var(--edge-guess)",
              color: "var(--edge-guess)",
            }}
          >
            guessed parent
          </div>
        </EdgeLabelRenderer>
      </>
    );
  }

  const key = safeId(id);
  const gradientId = `${key}-grad`;
  const bloomId = `${key}-bloom`;

  const fromColor = roleColorVar(data?.fromRole ?? "unmapped");
  const toColor = roleColorVar(data?.toRole ?? "unmapped");

  const live = data?.live === true;
  const focused = data?.focused === true;
  const sweep = data?.sweep === true;
  const energised = live || focused || sweep;

  /*
   * The bloom's region, in user space, padded well past the widest stroke.
   *
   * It has to cover the BEND as well as the endpoints: with a shared `centerX`
   * the cable leaves the source, runs to `centerX`, and only then turns, so the
   * path's x extent is the union of all three. 44px of padding is comfortably
   * more than the 12px standard deviation below needs.
   */
  const xs = [sourceX, targetX, ...(centerX === null || centerX === undefined ? [] : [centerX])];
  const pad = 44;
  const regionX = Math.min(...xs) - pad;
  const regionY = Math.min(sourceY, targetY) - pad;
  const regionW = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const regionH = Math.abs(targetY - sourceY) + pad * 2;

  const cometClass = live
    ? "conduit-comet--live"
    : focused
      ? "conduit-comet--focus"
      : "conduit-comet--sweep";

  const cometStyle: CSSProperties = {
    // Only the sweep reads this; the looping variants ignore it.
    ["--sweep-delay" as string]: `${String((data?.depth ?? 1) * SWEEP_STEP_MS)}ms`,
  };

  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          {/*
           * Four stops, not two. A straight two-stop ramp spends most of the
           * wire's length in the muddy mix halfway between two hues; holding
           * each end for the first and last fifth means both roles are legible
           * where the wire meets its card, and the blend happens in the middle
           * of the run where nothing has to be identified.
           */}
          <stop offset="0%" stopColor={fromColor} />
          <stop offset="22%" stopColor={fromColor} />
          <stop offset="78%" stopColor={toColor} />
          <stop offset="100%" stopColor={toColor} />
        </linearGradient>

        {energised && (
          <filter
            id={bloomId}
            filterUnits="userSpaceOnUse"
            x={regionX}
            y={regionY}
            width={regionW}
            height={regionH}
          >
            {/*
             * Two radii merged under the original, which is what makes this a
             * bloom rather than a blur: the tight pass gives the wire a hot
             * edge, the wide pass throws light onto the background, and the
             * unblurred source on top keeps the cable's own line crisp.
             */}
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="tight" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="wide" />
            <feMerge>
              <feMergeNode in="wide" />
              <feMergeNode in="tight" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>

      {/* 1. The rim: one step lighter than the ground, so the casing reads as a
             groove cut into the surface rather than a line laid on top of it. */}
      <path d={path} className="conduit-rim" />

      {/* 2. The casing: the dark body of the cable. */}
      <path d={path} className="conduit-casing" />

      {/* The static bloom of an energised wire. Filtered once, never animated,
          and under the coloured body so it reads as light escaping from it. */}
      {energised && (
        <path
          d={path}
          className="conduit-bloom"
          stroke={`url(#${gradientId})`}
          style={{ filter: `url(#${bloomId})` }}
        />
      )}

      {/* 3. The body: the role gradient. This is the layer carrying the
             information, and the one the settled spec measures. */}
      <path
        id={`${key}-settled`}
        d={path}
        className="conduit-body"
        stroke={`url(#${gradientId})`}
      />

      {/* 4. The specular core. Makes the stroke read as round. */}
      <path d={path} className="conduit-core" />

      {energised && (
        <>
          {/*
           * The comet: ONE dash, three times, round-capped, widest and dimmest
           * first. Three stacked strokes are a feathered falloff for the price of
           * three composites — no filter, so this is the only thing on the canvas
           * that runs per frame and it is cheap enough to.
           */}
          <path
            d={path}
            pathLength={1000}
            className={`conduit-comet conduit-comet--halo ${cometClass}`}
            stroke={`url(#${gradientId})`}
            style={cometStyle}
          />
          <path
            d={path}
            pathLength={1000}
            className={`conduit-comet conduit-comet--mid ${cometClass}`}
            stroke={`url(#${gradientId})`}
            style={cometStyle}
          />
          <path
            id={`${key}-hot`}
            d={path}
            pathLength={1000}
            className={`conduit-comet conduit-comet--hot ${cometClass}`}
            style={cometStyle}
          />
        </>
      )}
    </>
  );
}
