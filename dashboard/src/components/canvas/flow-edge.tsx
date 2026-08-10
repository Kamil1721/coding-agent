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
 * A SECOND CONNECTOR LIVES AT THE BOTTOM OF THIS FILE — 2026-08-04. `LaneEdge`
 * joins the pre-build stages to each other and to the orchestrator. It shares the
 * groove and nothing else, because "and then" is not "delegated to"; see its own
 * docblock for the argument. Everything above this line is about delegation.
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
 * How far ahead of the child's stop the parent's stop brightens, in ms.
 *
 * The flux keyframe is 2400ms and peaks at 45%, so a 600ms lead puts the
 * parent-side peak a quarter of a cycle before the child-side one: the bright
 * band is visibly moving DOWN the wire, in the direction the delegation went,
 * without either stop ever leaving its own role's hue for long. Zero would make
 * the whole conduit breathe in unison, which reads as a pulse rather than as
 * travel; a full half-cycle reads as two independent lights.
 */
const FLUX_LEAD_MS = 600;

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
  const stillGradientId = `${key}-still`;
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

  /**
   * A flux stop's own base hue and its place in the queue.
   *
   * The keyframe brightens `--flux-base` and returns to it, so each stop has to
   * carry the colour it is animating AROUND — one keyframe cannot know a
   * per-edge hue. The delay is what makes two stops read as one band travelling
   * rather than as the whole wire breathing: `FLUX_LEAD_MS` earlier on the
   * parent's stop means the bright band appears at the source and arrives at the
   * target, which is the direction the work went.
   */
  const fluxStyle = (base: string, delayMs: number): CSSProperties => ({
    ["--flux-base" as string]: base,
    animationDelay: `${String(delayMs)}ms`,
  });

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
          {/*
           * THE TWO INTERIOR STOPS ANIMATE WHEN THE EDGE IS ENERGISED —
           * 2026-08-09, the owner's "animated gradient stops".
           *
           * Each brightens toward a cold white and returns to its own role hue,
           * the parent's `FLUX_LEAD_MS` ahead of the child's, so a soft band of
           * light crosses the middle of the cable in the direction the
           * delegation went. `--flux-base` rides inline because one keyframe
           * cannot know a per-edge hue; see `conduit-flux` in `globals.css`.
           *
           * THE END STOPS NEVER MOVE. They are what makes each role
           * identifiable where the wire meets its card, and brightening them
           * would wash the hue out at exactly the two points a reader uses to
           * tell whose work is on the wire.
           *
           * ONLY WHEN ENERGISED, and that is doctrine rather than thrift: a
           * settled edge nobody is pointing at does not move, which is what
           * keeps the moving ones worth looking at. At rest these are ordinary
           * stops with no class and no animation.
           */}
          <stop offset="0%" stopColor={fromColor} />
          <stop
            {...(energised
              ? {
                  className: "conduit-flux-stop",
                  style: fluxStyle(fromColor, -FLUX_LEAD_MS),
                }
              : {})}
            offset="22%"
            stopColor={fromColor}
          />
          <stop
            {...(energised
              ? { className: "conduit-flux-stop", style: fluxStyle(toColor, 0) }
              : {})}
            offset="78%"
            stopColor={toColor}
          />
          <stop offset="100%" stopColor={toColor} />
        </linearGradient>

        {/*
         * A STATIC TWIN OF THE GRADIENT, FOR THE FILTERED PATH ONLY, AND ONLY
         * WHILE THE FIRST ONE IS MOVING.
         *
         * A gradient is a paint server: every element painting with it repaints
         * when one of its stops changes. `.conduit-bloom` is the one FILTERED
         * path on this edge, so if it shared the animated gradient the browser
         * would re-rasterise a two-pass Gaussian on every frame — exactly the
         * cost this file's header says was avoided by never filtering the comet.
         * The comets can keep the animated one; they are unfiltered, and they
         * are already repainting each frame for their own dash offset.
         *
         * WHY THE TWIN IS THE BLOOM'S AND NOT THE BODY'S. `.conduit-body`'s
         * `stroke` is pinned by `canvas-edges.browser.spec.ts` as
         * `url("#<edge>-grad")` — the fact that the wire carries the parent's
         * hue into the child's is a contract, and swapping the body onto a
         * second id to make room for an animation would have broken it for a
         * reason that has nothing to do with what that test defends. The bloom
         * has no such contract, so the duplicate lives there.
         *
         * IT DOES NOT EXIST AT REST. When the edge is settled the first gradient
         * is static and the bloom simply paints from it.
         */}
        {energised && (
          <linearGradient
            id={stillGradientId}
            gradientUnits="userSpaceOnUse"
            x1={sourceX}
            y1={sourceY}
            x2={targetX}
            y2={targetY}
          >
            <stop offset="0%" stopColor={fromColor} />
            <stop offset="22%" stopColor={fromColor} />
            <stop offset="78%" stopColor={toColor} />
            <stop offset="100%" stopColor={toColor} />
          </linearGradient>
        )}

        {/*
         * THE BLOOM FILTER IS NO LONGER GATED ON `energised` — 2026-08-09 (C5-4).
         *
         * A finished run used to have zero filters, zero blooms and zero
         * animations on the canvas: correct about the MOTION and wrong about the
         * light. Motion means "this is happening now" and must stop when it
         * stops; a bloom means "this cable carries current", which is a fact
         * about a delegation that happened and is still true afterwards. The
         * owner watched a run for an hour and then got a wireframe of it.
         *
         * SO THE FILTER IS ALWAYS BUILT AND ITS CONTENT IS THE STATE. Energised
         * keeps the two-radius merge under the original. Settled gets ONE pass and
         * no merge — the blurred halo alone, with no `SourceGraphic` on top,
         * because the crisp line is already drawn by `.conduit-body` directly
         * above this path. That is half the Gaussians of the energised form and it
         * cannot be mistaken for it: `canvas-presence.browser.spec.ts` reads the
         * primitive list out of the rendered document and pins both shapes.
         *
         * NEITHER FORM ANIMATES, so the cost lands at first paint and at each
         * zoom step rather than per frame — and it was MEASURED, not assumed.
         * Chrome tracing, `RasterTask` totalled across a twelve-step zoom
         * sweep, three repetitions per arm with the bloom's filter switched off
         * in place as the control: 135.5ms with it against 135.4ms without at
         * 1440x900, and 909ms against 886ms at 2000x1200.
         *
         * "IT IS FREE" USED TO FOLLOW THOSE NUMBERS AND THE NUMBERS DO NOT
         * SUPPORT IT — corrected 2026-08-09 after review. A 0.1ms difference is
         * an order of magnitude inside this instrument's own arm-to-arm spread:
         * in the same four-arm table (`globals.css`, below the flux keyframes)
         * the as-shipped arm comes out FASTER than the bloom-off arm at
         * 1440x900 live (703.5 against 717.5) and SLOWEST of all four at
         * 2000x1200 finished, and a difference whose SIGN flips between
         * viewports is a difference the instrument cannot resolve. The band is
         * roughly ±15-20ms. What the table supports is therefore: NOT
         * DISTINGUISHABLE FROM FREE at four to six edges, against an instrument
         * with a ±20ms spread. Calling it free at thirty edges — the number the
         * design doc plans for — would be extrapolation from a graph that was
         * never drawn.
         *
         * WHAT IS UNAFFECTED, because it is the same table read correctly: the
         * turbulence refusal. 216.8 against 135.4 and 1497 against 703 are five
         * to eighty times the spread above, and the stdDeviation-200 control
         * shows the instrument is not merely reporting "filters are expensive".
         * That measurement discriminates; this one does not.
         */}
        <filter
          id={bloomId}
          filterUnits="userSpaceOnUse"
          x={regionX}
          y={regionY}
          width={regionW}
          height={regionH}
        >
          {energised ? (
            <>
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
            </>
          ) : (
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" />
          )}
        </filter>
      </defs>

      {/* 1. The rim: one step lighter than the ground, so the casing reads as a
             groove cut into the surface rather than a line laid on top of it. */}
      <path d={path} className="conduit-rim" />

      {/* 2. The casing: the dark body of the cable. */}
      <path d={path} className="conduit-casing" />

      {/* The wire's own light. Filtered once, never animated, and under the
          coloured body so it reads as escaping from it. `data-state` is what
          `globals.css` dims it by — an energised cable is lit, a settled one
          still glows. It paints from the STATIC twin whenever the main gradient
          is animating; see the `<defs>` above for why that matters. */}
      <path
        d={path}
        className="conduit-bloom"
        data-state={energised ? "energised" : "settled"}
        stroke={`url(#${energised ? stillGradientId : gradientId})`}
        style={{ filter: `url(#${bloomId})` }}
      />

      {/* 3. The body: the role gradient. This is the layer carrying the
             information, and the one the settled spec measures. Always the same
             gradient id — when the edge is energised, two of that gradient's
             stops are the thing that moves. */}
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

/* ------------------------------------------------------------------
 * The pre-build link — "and then", which is not "delegated to"
 * ---------------------------------------------------------------- */

/**
 * The connector between two pre-build stages, and from the last of them into the
 * orchestrator.
 *
 * IT IS A DIFFERENT COMPONENT BECAUSE IT MAKES A DIFFERENT CLAIM. Every
 * `DelegationEdge` on this canvas means "this agent spawned that one" — the
 * header above says there is no second meaning available, and until the lane
 * landed there was not. A stage link means "this happened, and then that did":
 * nothing was delegated, nothing was spawned, and the run reported both ends
 * itself. Drawing it with the role gradient would colour a sequence as a
 * hand-off between two agents, one of which does not exist.
 *
 * SO IT KEEPS THE GROOVE AND DROPS THE GRADIENT. Rim and casing are shared with
 * every other wire, because the lane is part of the same canvas and a hairline
 * beside a 10.5px cable would read as chrome. What it carries instead of a
 * per-edge gradient is ONE state colour, taken from the far end:
 *
 *   pending  — nothing downstream has started. Dim, and no core.
 *   live     — the far end is running. Accent, plus the same travelling comet a
 *              live delegation gets, because it means the same thing here.
 *   settled  — the far end has an outcome. The pass green the stage chip uses.
 *
 * THE COLOUR IS INLINE RATHER THAN A CLASS. A `.conduit-lane` rule would have to
 * live in `globals.css`, which was outside this change's file scope — the same
 * constraint `LiveRim` records. The class on the path is a test hook with no
 * styles behind it, so counting `path.lane-conduit` counts lane links and cannot
 * accidentally count delegations.
 */
export type LaneEdgeData = {
  /** The far end is running now. */
  readonly live: boolean;
  /** The far end has not started, so nothing has gone down this link yet. */
  readonly pending: boolean;
  readonly centerX: number | null;
};

export type LaneFlowEdge = Edge<LaneEdgeData, "lane">;

export function LaneEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<LaneFlowEdge>): ReactNode {
  const centerX = data?.centerX;
  const [path] = getSmoothStepPath({
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

  const live = data?.live === true;
  const pending = data?.pending === true;
  const stroke = pending
    ? "var(--color-line-strong)"
    : live
      ? "var(--color-accent)"
      : "var(--color-pass)";

  return (
    <>
      <path d={path} className="conduit-rim" />
      <path d={path} className="conduit-casing" />
      <path
        id={`${safeId(id)}-lane`}
        d={path}
        className="lane-conduit"
        data-state={pending ? "pending" : live ? "live" : "settled"}
        fill="none"
        stroke={stroke}
        strokeWidth={pending ? 2.5 : 4.5}
        strokeLinecap="round"
        opacity={pending ? 0.5 : 1}
      />
      {live && (
        // The same comet as a live delegation, for the same reason: something is
        // moving down this link right now. It stops when the far end stops.
        <path
          d={path}
          pathLength={1000}
          className="conduit-comet conduit-comet--hot conduit-comet--live"
          stroke="var(--color-accent)"
        />
      )}
    </>
  );
}
