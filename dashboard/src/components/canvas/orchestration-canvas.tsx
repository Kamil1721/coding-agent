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
 *
 * TWO THINGS ON THIS CANVAS ARE NOT AGENTS, AND BOTH SAY SO. The PRE-BUILD LANE
 * at the left, and the terminal preview card at the end of the flow. Both are
 * LAYOUT CONSTRUCTS the canvas draws from what the run recorded — never
 * `graph_agent` events, because every invariant in the server's graph is keyed on
 * a real agent event arriving first for its node id, and a synthetic id would be
 * a forged event. `PreviewSiteCard` below is the card, and it is deliberately the
 * only thing on the canvas that is not selectable, not in the arrow-key grid, and
 * not the width of an agent card.
 *
 * THE LANE USED TO BE A PANEL AND IS NOW PART OF THE GRAPH — 2026-08-04, the
 * owner's ask D. It was rendered inside the `showEmptyOverlay || !ready` branch
 * at the bottom of this file: a box floating over a canvas with zero nodes, which
 * VANISHED the moment the build started. So the run's first eighty minutes and
 * the rest of it were two different pictures, and "you're still on the actual
 * same canvas" was false by construction. It is now `placement.stages` —
 * `stage`-type React Flow nodes wired by `LaneEdge` into the root card — present
 * continuously, pannable, focusable and openable like everything else here.
 *
 * ITS DATA COMES FROM `GraphState.stages`, WHICH IS WHY IT SURVIVES A RELOAD. The
 * old panel read `specPipelineFrom(trace, …)`, and `trace` is the live SSE sink:
 * `use-run-stream.ts` never opens a socket for a terminal run, so the lane was
 * blank on every run the owner opened after it finished. `foldGraph` is the one
 * reducer behind both the REST snapshot and the live tail, so a stage folded
 * there is identical replayed and live. `src/lib/spec-pipeline.ts` still holds the
 * superseded derivation and says so at its head.
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
  type NodeProps,
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

import type { GraphState, RunStatus } from "@/lib/api-types";
import { apiUrl } from "@/lib/api";
import { useNow } from "@/lib/use-run-stream";
import {
  PREVIEW_UNREACHABLE,
  previewSiteFrom,
  type PreviewSite,
  type TerminalPreview,
} from "@/lib/spec-pipeline";
import { Button, Dot, cx } from "@/components/ui";
import {
  AgentNode,
  ColumnNode,
  GroupNode,
  shellIdFor,
  type AgentFlowNode,
  type ColumnFlowNode,
  type GroupFlowNode,
} from "./agent-node";
import { StageNode, type StageFlowNode } from "./stage-node";
import { DelegationEdge, LaneEdge, type FlowEdge, type LaneFlowEdge } from "./flow-edge";
import { NODE_WIDTH, PREVIEW_WIDTH, STAGE_WIDTH, placeGraph, stageKeyOf } from "./layout";

/**
 * The folded pre-build card's React Flow id, and a constant rather than a lookup.
 *
 * `placeGraph` keys that card `stage:plan` whichever section it actually leads
 * with, precisely so this is knowable without asking the placement — the key names
 * the CARD, which is called Plan everywhere a reader meets it. The orchestrator's
 * own card is the other stage id and it opens nothing.
 */
const PLAN_STAGE_KEY = stageKeyOf("plan");
import { ROLE_LABEL, ROLE_MEANING, ROLE_ORDER, roleColorVar, type AgentRole } from "./roles";

/**
 * Declared at module scope, NOT inline.
 *
 * React Flow compares these by identity and logs a console warning on every
 * render when they are rebuilt — which is both noise and a real re-render of
 * every node on the canvas.
 */
const NODE_TYPES = {
  agent: AgentNode,
  group: GroupNode,
  column: ColumnNode,
  stage: StageNode,
  /*
   * `stageHeader` IS GONE — 2026-08-04. The lane it labelled was six cards; it is
   * two, and both of them are named on their own faces. See the note at the foot
   * of `stage-node.tsx`.
   */
  // A function DECLARATION below, so it is hoisted and this const can name it.
  preview: PreviewSiteCard,
} as const;
const EDGE_TYPES = { flow: DelegationEdge, lane: LaneEdge } as const;

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
/*
 * 360 -> 400 ON 2026-08-04, and the dock's own `w-[min(…)]` moved with it in the
 * same commit. The left dock now carries the pre-build panel — a five-row list
 * with a sentence per row — and 40px is the difference between two-line and
 * three-line wraps on every one of them. It is the one structural number this
 * redesign moved; `HUD_RESERVE` below is built from it, so the fit follows.
 */
const HUD_WIDTH = 400;
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

interface EmptyCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * FOUR EMPTY STATES, AND THEY WERE ONE — corrected 2026-07-30, extended the same day.
 *
 * A run 57 seconds old, in the SPEC phase, on Claude, was shown "This run emitted no
 * graph events. Runs recorded before the canvas existed, and runs on the Codex
 * provider, contain none." Every clause of that is false about that run, and the
 * owner reasonably read it as a bug: "when you start a new run why is there no
 * orchestator showing?"
 *
 * THE ACTUAL REASON, which nothing on screen said: the orchestrator node is minted by
 * the BUILD segment. While the spec is being authored, audited and frozen there is no
 * builder session, so there are no `graph_*` events to fold — measured on the live run
 * as 0 `graph_agent` of 6 total events. Nothing is wrong; the graph has not started
 * yet.
 *
 * THE FOURTH CASE IS A RUN THAT HAS NOT STARTED AT ALL. `queued` is non-terminal, so
 * the three-way version handed it the spec-phase sentence and told a run that is doing
 * nothing that its acceptance suite was being written. It is not: `pump()` starts the
 * head of the queue only when nothing is active, so a queued run has no process, no
 * segment and no events.
 *
 * IT DOES NOT NAME A POSITION, ON PURPOSE. `queuePosition` is persisted on the row and
 * deliberately kept off `RunSummary`/`RunDetail` — "a frozen contract with no position
 * field" (`server/src/orchestrator.ts:537-544`) — so this component is never given one.
 * The orchestrator does EMIT the number as a log line ("queued: position N of M",
 * `orchestrator.ts:572`) on the run's own stream, and the client parses `log` events —
 * whether that particular line survives replay and reaches the Trace tab for a run
 * opened later was NOT checked here, so nothing in this file may promise it. Either
 * way this component is not handed the value, and restating it from something it does
 * not hold would mean inventing it. So the copy states the property that IS known from
 * the code — the queue is serial — and stops there.
 *
 * Pure and module-scope so the four sentences are one lookup rather than a four-deep
 * ternary written twice. Called only when the PLACEMENT is empty; `graphNodeCount` is
 * the unfiltered count, so `> 0` here means every node on the run was filtered out as
 * housekeeping.
 *
 * THE BODIES WERE CUT TO A CLAUSE EACH — 2026-08-04 ("there is just too much text and
 * explanation around each button that almost looks like some sort of tutorial"). The
 * FOUR CASES SURVIVE, because the paragraphs above are about which fact is true, not
 * about how long it takes to say; what went is the explanation stacked on top of each
 * one. The spec-phase case in particular no longer has to explain that the suite is
 * written before any agent exists — the lane on the canvas now SHOWS that, beside
 * this box, with a wire into the orchestrator.
 */
function emptyCanvasCopy(state: {
  readonly graphNodeCount: number;
  readonly runStatus: RunStatus | undefined;
  readonly runIsActive: boolean;
}): EmptyCopy {
  if (state.graphNodeCount > 0) {
    return {
      title: "Only housekeeping so far",
      body: "Use the housekeeping toggle to show them.",
    };
  }
  if (state.runStatus === "queued") {
    return {
      title: "Waiting for the run ahead of it",
      body: "Runs go one at a time.",
    };
  }
  if (state.runIsActive) {
    return {
      title: "No agents yet",
      body: "The suite is written and frozen first.",
    };
  }
  return {
    title: "No delegation recorded",
    body: "This run emitted no graph events; the trace is its full record.",
  };
}


/**
 * "3 min ago", ticking, for the live-activity line.
 *
 * A SEPARATE COMPONENT so the 10-second clock re-renders THIS and not the whole
 * canvas. `useNow` at the canvas level would re-run the node builder and the
 * layout every tick, for a string nobody looks at while nodes exist.
 */
function RelativeSince({ atMs }: { atMs: number }): ReactNode {
  const nowMs = useNow(10_000);
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 45) return <>just now</>;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return <>{`${String(minutes)} min ago`}</>;
  const hours = Math.floor(minutes / 60);
  return <>{`${String(hours)}h ${String(minutes % 60)}m ago`}</>;
}


/*
 * `QuietNote`, `STAGE_TONE` AND `SpecStageCard` ARE DELETED — 2026-08-04. All
 * three belonged to the floating "Before the build" panel, which is now a row of
 * real nodes on the canvas (`stage-node.tsx`). What each of them was, and what
 * happened to the reasoning inside it:
 *
 *   · `SpecStageCard` drew a stage as an `<li>` with a hand-drawn connector — "a
 *     plain border between cards rather than a React Flow edge: these are not
 *     graph nodes and must not be reachable by the canvas's selection, keyboard or
 *     edge machinery". That constraint is GONE rather than violated: the stages
 *     are now first-class nodes with their own ids, their own edge type and their
 *     own place in the arrow-key grid, which is precisely what the owner asked
 *     for. Its halo-not-dot pulse note survives as `STAGE_LOOK.running` in
 *     `stage-node.tsx`, where the marker is a solid dot and the animation is on
 *     the card border instead.
 *   · `STAGE_TONE` was the four-state colour table; it is `STAGE_LOOK` there now,
 *     with the fifth state (`unresolved`) the fold can produce and the old table
 *     could not express.
 *   · `QuietNote` printed, after three minutes of silence, "Long gaps are normal
 *     here. The spec seat reports when it starts and when it finishes, not while
 *     it works — on the last run that passed, this phase took about 80 minutes and
 *     went quiet for 43 of them." The MEASUREMENT is still true and still worth
 *     knowing; the paragraph is not, for two reasons. It was the longest single
 *     piece of the tutorial copy the owner asked to be cut, and the silence it
 *     apologised for is no longer silence: `subscription-caller.ts` now reports
 *     the seat's progress every 30 seconds, so the run says something while it
 *     works. If the seat ever goes quiet again, the honest replacement is a stall
 *     detector, not a sentence explaining that stalls look like this.
 */

/* ------------------------------------------------------------------
 * The terminal preview card
 * ---------------------------------------------------------------- */

/**
 * The logical viewport the site is rendered at before it is scaled down.
 *
 * A DESKTOP WIDTH, NOT THE CARD'S. An iframe 390 CSS pixels wide makes every
 * responsive site serve its MOBILE layout, so the thumbnail would show a page
 * the owner never asked for and cannot compare against the design references.
 * The frame renders at 1280x760 and is scaled to fit, which is the same picture
 * a laptop would show.
 */
const PREVIEW_FRAME_WIDTH = 1280;
const PREVIEW_FRAME_HEIGHT = 760;

/** Card width minus its 14px padding on both sides and its 1px border. */
const PREVIEW_INNER_WIDTH = PREVIEW_WIDTH - 30;
const PREVIEW_SCALE = PREVIEW_INNER_WIDTH / PREVIEW_FRAME_WIDTH;
const PREVIEW_THUMB_HEIGHT = Math.round(PREVIEW_FRAME_HEIGHT * PREVIEW_SCALE);

/**
 * A type alias for the same reason `AgentNodeData` is one: React Flow's `Node<T>`
 * constrains `T` to `Record<string, unknown>`, which only aliases satisfy.
 */
type PreviewCardData = {
  readonly preview: TerminalPreview;
  /** `null` = the dashboard has not answered yet. NOT "there is no site". */
  readonly site: PreviewSite | null;
  /**
   * The empty-canvas sentence, when this card is the only thing on the canvas.
   *
   * A run with a workspace and no `graph_*` events is not hypothetical — it is
   * every run recorded before the canvas existed — and suppressing the empty
   * overlay to make room for this card would silently drop the only sentence
   * explaining why there is no graph. It moves in here instead of being lost.
   */
  readonly note: EmptyCopy | null;
};

export type PreviewFlowNode = Node<PreviewCardData, "preview">;

/**
 * The site the run built, in a frame, at the end of the flow.
 *
 * WHAT THE FRAME IS AND IS NOT. It is an `<iframe>` on
 * `GET /api/runs/:id/preview/`, which the dashboard serves out of the run's own
 * workspace — live whenever anyone is looking at this page, because the
 * dashboard is by definition running. It is NOT `RunDetail.previewUrl`: that is
 * the loopback address a `deploy: true` run served on, the process behind it
 * exited with the run, and it was measured dead. `TerminalPreview.previewPath` is
 * built from the run id alone, so this component cannot reach the dead field
 * even by accident.
 *
 * IT IS NOT SANDBOXED AND THE WORD IS AVOIDED ON PURPOSE. `allow-same-origin`
 * keeps the framed document on the dashboard's origin, which is what lets ES
 * modules load and `localStorage` work — an opaque origin breaks both and a fair
 * number of generated sites with them. So the `sandbox` attribute here is not a
 * security boundary; the server's `connect-src 'none'; form-action 'none'` CSP is
 * the control. What the attribute DOES buy, and the only reason it is set, is
 * that the framed page cannot navigate the dashboard away, open a popup, or
 * throw a modal dialog at whoever is looking at the canvas.
 *
 * A 200 PROVES AN ENTRY DOCUMENT WAS SERVED, NOT THAT THE PAGE RENDERS. No copy
 * on this card says the site works. It says the dashboard can serve it.
 *
 * THE PICTURE IS NOT A LINK, WHICH IS A DECISION AND NOT AN OVERSIGHT. The card
 * is draggable, so a press that starts on the thumbnail and ends there after a
 * drag would fire a click on release — and a tab opening because someone moved a
 * card is worse than one more line of text. The link is that line of text.
 *
 * WITH `NEXT_PUBLIC_API_BASE_URL` SET, THE FRAME GOES BLANK AND NOTHING CAN TELL.
 * The preview's `frame-ancestors 'self'` is relative to the API's origin, so a
 * cross-origin dashboard is refused the frame — and a refused frame is an empty
 * box with no event. The link is therefore the load-bearing affordance and the
 * thumbnail is the nicety; that ordering is why the link is not hidden behind the
 * picture. Not measured in that configuration, because nothing here runs it.
 */
function PreviewSiteCard({ data }: NodeProps<PreviewFlowNode>): ReactNode {
  const { preview, site, note } = data;
  const href = apiUrl(preview.previewPath);
  const verdict = preview.verdict;

  return (
    <div
      style={{ width: PREVIEW_WIDTH }}
      className="rounded-[10px] border border-line-strong bg-surface p-3.5"
    >
      <header className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[12.5px] font-semibold text-ink">The site this run built</h3>
        {/*
          * SAYS WHAT IT IS. Every other card on this canvas is an agent the run
          * reported; this one is the layout's own addition, and a reader who
          * counts agents should not count it.
          */}
        <span
          title="Not an agent. The canvas adds this from the run's record once the run is over."
          className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-faint"
        >
          not an agent
        </span>
      </header>

      <div
        style={{ height: PREVIEW_THUMB_HEIGHT }}
        className="relative overflow-hidden rounded border border-line bg-canvas"
      >
        {site === null && (
          <p className="absolute inset-0 grid place-items-center px-4 text-center text-[11px] leading-relaxed text-ink-faint">
            Asking the dashboard whether this run left a site it can serve…
          </p>
        )}

        {site?.kind === "servable" && (
          <iframe
            src={href}
            title="The site this run built, as the dashboard serves it"
            /*
             * `nodrag` and `pointer-events-none` are BOTH needed and they do
             * different jobs: without `pointer-events-none` a click lands in the
             * site instead of the canvas, and without React Flow's `nodrag` a
             * press that starts on this element is swallowed rather than panning
             * or dragging the card.
             *
             * `tabIndex={-1}` takes the frame element out of the tab order.
             * Whether a browser lets sequential navigation descend into the
             * framed DOCUMENT anyway was NOT measured here, so this is not a
             * claim that the thumbnail is unreachable by keyboard — the link
             * below it is the affordance that is.
             */
            tabIndex={-1}
            className="nodrag pointer-events-none absolute left-0 top-0 origin-top-left border-0"
            style={{
              width: PREVIEW_FRAME_WIDTH,
              height: PREVIEW_FRAME_HEIGHT,
              transform: `scale(${String(PREVIEW_SCALE)})`,
            }}
            sandbox="allow-scripts allow-same-origin"
          />
        )}

        {site !== null && site.kind !== "servable" && (
          /*
           * THE SERVER'S OWN SENTENCE, NOT ONE WRITTEN HERE. `no_index_html`'s
           * remediation names the `.html` files it DID find, which is the only
           * thing that tells a wrongly-named entry point apart from a build that
           * produced nothing. `nowheel` keeps a scroll here from zooming the
           * canvas out from under the reader.
           */
          <div className="nodrag nowheel absolute inset-0 overflow-y-auto px-3 py-2.5 text-left">
            <p className="text-[11px] font-medium leading-relaxed text-ink">
              {site.kind === "no-index"
                ? "No page to show: this build left no index.html where the preview looks."
                : site.kind === "unreachable"
                  ? "Could not ask."
                  : "The dashboard would not serve this run's workspace."}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">{site.message}</p>
            {site.kind === "no-index" && (
              // A RUN IN THIS STATE HAS CODE WORTH OPENING, so it is pointed at
              // rather than left as a dead end. The Code tab is real — the run
              // sheet's `TABS` in `sheet.tsx` carries it and it renders
              // `CodeBrowser` — and this card cannot open it itself: the sheet is
              // the run page's, and the canvas is handed no callback to it.
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                The run sheet&apos;s Code tab lists what this run actually wrote.
              </p>
            )}
            {site.kind !== "unreachable" && site.remediation !== null && (
              <p className="mt-1.5 whitespace-pre-line text-[10.5px] leading-relaxed text-ink-dim/80">
                {site.remediation}
              </p>
            )}
            {site.kind === "refused" && (
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                {site.code}
              </p>
            )}
          </div>
        )}
      </div>

      {/*
        * THE TWO AXES, SIDE BY SIDE AND NEVER MERGED. Above: whether a site can
        * be served. Below: what the held-out gate said. A cancelled run with a
        * perfectly servable site is a real state, and so is a run that passed its
        * suite from a `site/` subdirectory this route will not guess at — so one
        * of these must never be allowed to colour the other.
        */}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <Dot tone={verdict.tone} />
        <span className="text-[12px] font-medium text-ink">{verdict.label}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">{verdict.detail}</p>
      {preview.caveat !== null && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">{preview.caveat}</p>
      )}

      {note !== null && (
        <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-dim">
          <span className="font-medium text-ink">{note.title}.</span> {note.body}
        </p>
      )}

      {site?.kind === "servable" && (
        <p className="mt-3">
          {/*
            * THE TRAILING SLASH IS ALREADY IN `previewPath` and must stay: without
            * it the document resolves its own `styles.css` one level too high and
            * every relative asset 404s, so the site opens unstyled and reads as a
            * broken build. `rel="noreferrer noopener"` because this opens a page
            * the run wrote.
            */}
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="nodrag text-[12px] text-accent underline underline-offset-2"
          >
            open this site in a new tab
          </a>
        </p>
      )}
    </div>
  );
}

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
   * The newest thing the run has SAID, for the ~80 minutes before any node exists.
   *
   * WHY THIS EXISTS. Measured on the run that passed: the spec phase ran
   * 23:28:46 -> 00:48:16, **79 minutes 30 seconds**, of a 105-minute run. For all
   * of it the canvas was a static box, so a working run and a hung one looked
   * identical — the owner's words were "there should be some animation or
   * something happening", and he was right: nothing on this screen distinguished
   * progress from death.
   *
   * IT IS THE LAST LINE, NOT A PROGRESS BAR, AND THAT IS DELIBERATE. Nothing
   * here knows how many authoring or audit passes remain, so any percentage or
   * ETA would be invented. What IS known is what it last said and when — which
   * is enough to tell "working" from "stopped", and claims nothing else.
   */
  readonly latestActivity?: { readonly text: string; readonly atMs: number } | null;
  /*
   * `specStages` IS GONE — 2026-08-04, and its removal is the ask, not a tidy-up.
   *
   * The run page used to compute the lane with `specPipelineFrom(trace, phase,
   * ticketText, runIsActive)` and hand it down here as a prop, and both halves of
   * that were wrong for the job: `trace` is the live socket, which a finished run
   * never opens, and the derivation returned `[]` for every phase past `spec`. The
   * lane now arrives inside `graph` as `GraphState.stages`, folded by the same
   * reducer as the nodes, so it is on the canvas replayed and live, before the
   * build and after it. Nothing needs to be passed.
   */
  /**
   * The run's status, when the caller knows it.
   *
   * WHY `runIsActive` IS NOT ENOUGH. `queued` and `running` are both non-terminal,
   * so `!isTerminalStatus(status)` folds them to one `true` — and the empty-state
   * copy keyed on that told a run WAITING BEHIND ANOTHER that its acceptance suite
   * was being written, which is a sentence about a run that has not begun. The
   * server's `pump()` starts `queued[0]` only when `#active === null`
   * (`server/src/orchestrator.ts:545-557`), so exactly one run executes at a time
   * and a queued run is doing nothing at all.
   *
   * NOT WIRED YET — SO THE QUEUED BRANCH BELOW CANNOT RENDER TODAY, AND THIS PROP
   * CHANGES NO PIXEL ON ITS OWN. The one call site,
   * `src/app/runs/[runId]/page.tsx:297`, passes `runIsActive={!isTerminalStatus(run.status)}`
   * and nothing else; that file belongs to a different change in this pass and was
   * not touched here. Until `runStatus={run.status}` is added beside it, a queued
   * run keeps getting the spec-phase copy exactly as before. Optional rather than
   * required for the same reason: making it required would break that call site.
   */
  readonly runStatus?: RunStatus;
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
  /**
   * The site this run built, as a terminal card at the end of the flow.
   *
   * THE OWNER'S ASK: "the website should show as a preview in a node on the
   * canvas after it is done." Built by `previewNodeFrom(run)` in
   * `src/lib/spec-pipeline.ts`, which returns `null` for every non-terminal run —
   * a preview of a half-written site is a lie about what was built, and the
   * workspace is written INTO while the run works.
   *
   * A PROP RATHER THAN SOMETHING THIS COMPONENT FETCHES. The canvas is handed a
   * `GraphState` and knows no run id; reading the route params and a run detail in
   * here would make "what is on the canvas" depend on where the canvas is mounted,
   * which is the same mistake `rightInset` exists not to make.
   *
   * NOT WIRED YET — SO THIS CARD CANNOT RENDER TODAY, AND THIS PROP CHANGES NO
   * PIXEL ON ITS OWN. The one call site, `src/app/runs/[runId]/page.tsx:404`,
   * passes `graph`, `ready`, selection, `runIsActive`, `specStages`,
   * `latestActivity`, `rightInset` and `hud`, and nothing else; that file belongs
   * to a different change in this pass and was not touched here. Until
   * `preview={previewNodeFrom(run)}` is added beside them, every branch below is
   * dead. Optional rather than required for the same reason: making it required
   * would break that call site.
   */
  readonly preview?: TerminalPreview | null;
  /**
   * The pre-build panel is open on the left dock.
   *
   * THE CANVAS DOES NOT OWN IT, and that is deliberate. The panel is docked by the
   * run page, over this component, and the page is also what sources it from
   * `GraphState.stages`; a copy of the flag in here would be a second value that
   * can disagree with the panel actually on screen. What this component does with
   * it is exactly two things: draw the Plan card as selected, and toggle it.
   */
  readonly planPanelOpen?: boolean;
  readonly onPlanPanel?: (open: boolean) => void;
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
  latestActivity = null,
  runStatus,
  preview = null,
  planPanelOpen = false,
  onPlanPanel,
}: CanvasProps): ReactNode {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /*
   * `expandedStages` IS GONE — 2026-08-04, and deleting it is the fix rather than
   * a tidy-up.
   *
   * It recorded which stage cards the reader had opened, and a card that was open
   * swapped its clamped sentence for the whole one — growing inside a React Flow
   * layout that had already reserved its box, into whatever was beside it. That is
   * the owner's "when i click them they break funny". The detail now lives in the
   * left dock's pre-build panel, which scrolls, so there is nothing left to open in
   * place and no state to hold it. Clicking the Plan card opens the panel; the
   * flag for that lives on the run page, beside the panel it controls.
   */

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

  /* ----------------------------------------------------------------
   * The terminal preview, taken apart so it stops churning
   * ------------------------------------------------------------- */

  /*
   * THE PREVIEW PROP IS A FRESH OBJECT ON EVERY RENDER, AND THE RUN PAGE
   * RE-RENDERS ONCE A SECOND.
   *
   * `previewNodeFrom(run)` builds a new object each call and the run clock ticks,
   * so depending on its IDENTITY anywhere below would re-run the placement,
   * rebuild every node and call `setNodes` once a second forever. This file has
   * already paid for that class of mistake once: a fresh `hud` element in the fit
   * effect's dependency list re-ran that effect every second, its cleanup killed
   * the sweep's timer, and every connector on the canvas pulsed forever.
   *
   * SO IT IS TAKEN APART INTO PRIMITIVES AND PUT BACK TOGETHER, RATHER THAN HELD
   * IN A REF. A ref read during render is what the React compiler's `react-hooks`
   * rules forbid, and — measured with `npx eslint` on this file — the taint
   * propagates: keying `placement` on a ref-derived value made the linter flag
   * `placement`, `built` and every memo downstream of them. Rebuilding the object
   * from its own fields costs seven lines and is the version the compiler can
   * reason about.
   *
   * AND IT CANNOT GO STALE THE WAY A SIGNATURE STRING COULD. A new field on
   * `TerminalPreview` makes the object literal below fail to typecheck, which is
   * a compiler error rather than a display that quietly shows an old value.
   */
  const previewRunId = preview?.runId ?? null;
  const previewPath = preview?.previewPath ?? null;
  const previewStatus = preview?.status ?? null;
  const verdictTone = preview?.verdict.tone ?? null;
  const verdictLabel = preview?.verdict.label ?? null;
  const verdictDetail = preview?.verdict.detail ?? null;
  const previewCaveat = preview?.caveat ?? null;

  const stablePreview = useMemo((): TerminalPreview | null => {
    /*
     * Six checks for one condition, and they are how TYPESCRIPT learns these came
     * off a non-null `preview` — not a guard against a partly-filled one. Every
     * field of `TerminalPreview` is required and non-nullable except `caveat`,
     * which is legitimately null on a run that passed and is therefore carried
     * rather than checked.
     */
    if (previewRunId === null || previewPath === null || previewStatus === null) return null;
    if (verdictTone === null || verdictLabel === null || verdictDetail === null) return null;
    return {
      runId: previewRunId,
      previewPath,
      status: previewStatus,
      verdict: { tone: verdictTone, label: verdictLabel, detail: verdictDetail },
      caveat: previewCaveat,
    };
  }, [
    previewRunId,
    previewPath,
    previewStatus,
    verdictTone,
    verdictLabel,
    verdictDetail,
    previewCaveat,
  ]);

  const placement = useMemo(
    // A BOOLEAN, NOT THE PREVIEW: the layout reserves a box and never reads a
    // verdict. Keyed on the path, so the placement does not churn per tick.
    () => placeGraph(graph, { showAmbient, expandedGroups, withPreview: previewPath !== null }),
    [graph, showAmbient, expandedGroups, previewPath],
  );

  /* ----------------------------------------------------------------
   * Is there a site to show? Only the dashboard's preview route knows.
   * ------------------------------------------------------------- */

  /**
   * The route's answer, TAGGED WITH THE PATH IT IS AN ANSWER ABOUT.
   *
   * The tag is what makes the "still asking" state derivable instead of reset in
   * an effect. Clearing this at the top of the effect below would have worked and
   * costs an extra render, and — more to the point — an answer that outlives the
   * question it was asked about is how a card ends up showing the previous run's
   * verdict for a beat after the reader opens a different one.
   */
  const [previewAnswer, setPreviewAnswer] = useState<{
    readonly path: string;
    readonly site: PreviewSite;
  } | null>(null);

  /** `null` while the question is out. NOT "there is no site". */
  const previewSite: PreviewSite | null =
    previewAnswer !== null && previewAnswer.path === previewPath ? previewAnswer.site : null;

  /*
   * ONE GET, ON A PRIMITIVE KEY, AND NO POLLING.
   *
   * WHY IT ASKS AT ALL. Nothing in `RunDetail` says whether the workspace has an
   * `index.html` — and it is not an academic question: of the two finished
   * workspaces on this machine one has it at the root and one keeps its site in a
   * `site/` subdirectory beside a `server.mjs`. Framing the second would show the
   * reader a 409 JSON body rendered as a web page, and linking it would hand them
   * a dead end. The route is the only thing that knows, so it is asked.
   *
   * WHY GET AND NOT HEAD. `http.ts` routes the preview on `method === "GET"`
   * alone, so a HEAD would come back as the router's own `not_found` — a refusal
   * about a route rather than about a site, which is exactly the confusion this
   * card exists to remove.
   *
   * WHY NOT `request<T>()` FROM `api.ts`. It reduces the body to one string,
   * preferring `message` over `error` and dropping `remediation` entirely — and
   * `remediation` is the sentence that names the `.html` files the build DID
   * produce. See `previewSiteFrom`.
   *
   * NO POLLING, because a terminal run's workspace does not change: the publish
   * step COPIES out of it, nothing writes back in. If that ever stops being true,
   * this becomes stale rather than wrong, and the card would need a reason to
   * re-ask rather than a timer.
   */
  useEffect(() => {
    const path = previewPath;
    if (path === null) return;
    let live = true;
    void (async (): Promise<void> => {
      try {
        const response = await fetch(apiUrl(path), { cache: "no-store" });
        let body: unknown = null;
        if (response.ok) {
          // The body of a 200 is the whole document and is never read; cancelling
          // it releases the socket rather than leaving it to the collector.
          await response.body?.cancel().catch(() => undefined);
        } else {
          body = await response.json().catch(() => null);
        }
        if (live) setPreviewAnswer({ path, site: previewSiteFrom(response.status, body) });
      } catch {
        // A throw here is the local backend not answering — never a refusal,
        // which arrives as a response with a status.
        if (live) setPreviewAnswer({ path, site: PREVIEW_UNREACHABLE });
      }
    })();
    return () => {
      live = false;
    };
  }, [previewPath]);

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
    /*
     * THE LANE IS PART OF THE GRID, one card per column, ahead of the agents.
     * Each stage is alone at its x, so it is its own column by the same rule the
     * agents follow — and ArrowLeft from the orchestrator walks back up the
     * pre-build chain, which is the order the run performed it in. Leaving the
     * stages out would have put cards on the canvas that the keyboard could not
     * reach, which is the accessibility failure this grid exists to prevent.
     */
    for (const stage of placement.stages) {
      byColumn.set(stage.key, [{ key: stage.key, y: stage.y }]);
      order.push(stage.key);
    }
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
  }, [placement.nodes, placement.stages]);

  const navRef = useRef(nav);
  navRef.current = nav;

  const groupsRef = useRef(placement.groupKeys);
  groupsRef.current = placement.groupKeys;

  /*
   * Read through a ref for the same reason `groupsRef` is: `activate` is handed to
   * every card as part of its `data`, so closing over the key list would rebuild
   * every node on the canvas each time the lane changed.
   */
  const stageKeys = useMemo(
    () => placement.stages.map((stage) => stage.key),
    [placement.stages],
  );
  const stageKeysRef = useRef(stageKeys);
  stageKeysRef.current = stageKeys;


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

      // Stages are on the canvas and in the arrow-key grid, so they are here too:
      // focusing a card the pane cannot show and then not panning to it is the
      // failure this whole function exists to avoid. Their box is narrower, which
      // is the only thing that differs.
      const placed = placement.nodes.find((entry) => entry.key === key);
      const stage = placement.stages.find((entry) => entry.key === key);
      const target =
        placed !== undefined
          ? { x: placed.x, y: placed.y, width: NODE_WIDTH, height: placed.height }
          : stage !== undefined
            ? { x: stage.x, y: stage.y, width: STAGE_WIDTH, height: stage.height }
            : undefined;
      const box = shell.current?.getBoundingClientRect();
      if (target === undefined || box === undefined) return;
      const centreX = target.x + target.width / 2;
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
    [flow, placement.nodes, placement.stages, insetOf],
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
      /*
       * THE PLAN CARD OPENS THE LEFT PANEL, AND IT IS NOT SELECTION.
       *
       * The run sheet resolves the selected key against `graph.nodes` —
       * `page.tsx` does `graph.nodes.find(node => node.id === selectedId)` — so
       * selecting a stage would clear the ring off whatever was selected and then
       * show nothing. Selection is cleared here instead, so the right-hand sheet
       * and the left panel can never both be open over the same card.
       *
       * THE ORCHESTRATOR CARD OPENS NOTHING, and swallowing the click is the
       * point: it stands for one stage, its whole sentence is already on its face,
       * and a panel listing one row is a panel with nothing in it. Its card is
       * drawn without hover or press feedback to say so.
       */
      if (stageKeysRef.current.includes(key)) {
        if (key === PLAN_STAGE_KEY && onPlanPanel !== undefined) {
          onSelect(null);
          onPlanPanel(!planPanelOpen);
        }
        return;
      }
      onSelect(key === selectedId ? null : key);
    },
    [onSelect, onPlanPanel, planPanelOpen, selectedId, toggleGroup],
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

  /*
   * TAKES THREE PRIMITIVES, NOT A `PlacedNode`, and the reason is the preview
   * card: it is placed by the same layout and dragged through the same map, but
   * it carries no `GraphNode` and there is no honest way to hand it a
   * `PlacedNode`. Widening the parameter list is cheaper than forging a node.
   */
  const positionOf = useCallback(
    (key: string, x: number, y: number): XYPosition =>
      draggedRef.current.get(key) ?? { x, y },
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

  // The lane comes first when the run has one and no agents yet: on a run parked
  // in the plan phase the only card on the canvas is a stage, and a tab stop
  // pointing at nothing would leave the keyboard with no way in.
  const firstKey = placement.nodes[0]?.key ?? placement.stages[0]?.key ?? null;
  const tabStop = tabbable ?? selectedId ?? firstKey;

  const built = useMemo((): Node[] => {
    const columns: ColumnFlowNode[] = placement.columns.map((column) => ({
      id: `column:${column.column}`,
      type: "column",
      position: { x: column.x, y: column.y },
      data: { label: column.label, count: column.count },
      draggable: false,
      selectable: false,
      focusable: false,
      width: NODE_WIDTH,
    }));

    /*
     * THE PRE-BUILD LANE, AS NODES.
     *
     * `draggable` LIKE EVERY OTHER CARD. These are not chrome pinned to a corner;
     * they are part of the graph, and the owner's arrangement of the graph is his.
     * The same `draggedRef`/`positionOf` machinery carries them, so a moved stage
     * stays moved and `tidy up` puts it back.
     */
    const stageCards: StageFlowNode[] = placement.stages.map((entry) => ({
      id: entry.key,
      type: "stage",
      position: positionOf(entry.key, entry.x, entry.y),
      data: {
        stage: entry.stage,
        members: entry.members,
        // Threaded from the page, which is the only thing that knows the run's
        // status. Without it the folded card promises future work on a run that
        // ended; `rollupOf` in `layout.ts` records what that costs.
        runIsActive,
        isSelected: planPanelOpen && entry.key === PLAN_STAGE_KEY,
        tabbable: entry.key === tabStop,
        onCardKeyDown,
      },
      draggable: true,
      width: STAGE_WIDTH,
    }));

    const cards: (AgentFlowNode | GroupFlowNode)[] = placement.nodes.map((entry) => {
      const shared = {
        id: entry.key,
        position: positionOf(entry.key, entry.x, entry.y),
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

    /*
     * THE TERMINAL PREVIEW, LAST IN THE ARRAY AND LAST IN THE FLOW.
     *
     * Both halves of the guard are load-bearing and neither implies the other:
     * `placement.preview` is the box the layout reserved, `stablePreview` is what
     * goes in it, and a card with one and not the other would be either an empty
     * box or a card with no position.
     *
     * IT CARRIES THE EMPTY-CANVAS SENTENCE when it is the only thing drawn. That
     * text is `emptyCanvasCopy`'s, called here rather than copied, so the run with
     * a workspace and no graph events keeps its explanation instead of having the
     * suppressed overlay take it away.
     */
    const previewNodes: PreviewFlowNode[] =
      placement.preview === null || stablePreview === null
        ? []
        : [
            {
              id: placement.preview.key,
              type: "preview",
              position: positionOf(
                placement.preview.key,
                placement.preview.x,
                placement.preview.y,
              ),
              data: {
                preview: stablePreview,
                site: previewSite,
                note:
                  placement.nodes.length === 0
                    ? emptyCanvasCopy({
                        graphNodeCount: graph.nodes.length,
                        runStatus,
                        runIsActive,
                      })
                    : null,
              },
              draggable: true,
              width: placement.preview.width,
            },
          ];

    return [...columns, ...stageCards, ...cards, ...previewNodes];
  }, [
    placement,
    positionOf,
    selectedId,
    tabStop,
    onCardKeyDown,
    planPanelOpen,
    stablePreview,
    previewSite,
    graph.nodes.length,
    runStatus,
    runIsActive,
  ]);

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
    /*
     * THE LANE'S LINKS, FIRST IN THE ARRAY AND FIRST IN THE RUN.
     *
     * A SEPARATE TYPE, NOT A `flow` EDGE WITH DIFFERENT DATA. `DelegationEdge`
     * draws a per-edge gradient from the parent's role hue to the child's, and a
     * stage has no role because nothing spawned it. Painting a sequence in two
     * agents' colours would be the canvas asserting a hand-off that no event
     * carried. See `LaneEdge`.
     */
    const lane: LaneFlowEdge[] = placement.stageEdges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "lane",
      data: { live: edge.live, pending: edge.pending, centerX: edge.centerX },
      selectable: false,
      focusable: false,
    }));

    const delegation = placement.edges.map((edge): FlowEdge => {
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

    return [...lane, ...delegation];
  }, [placement.edges, placement.stageEdges, pointedAt, sweeping]);

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

  /*
   * ANYTHING DRAWN COUNTS FOR THE FIT, NOT JUST AGENT CARDS.
   *
   * A terminal run with a workspace and no `graph_*` events draws exactly one
   * thing — the preview card — and the old `placement.nodes.length === 0` guard
   * returned early on it, leaving the viewport at the identity transform with the
   * card wherever the layout put it. That run is not hypothetical: it is every run
   * recorded before the canvas existed.
   *
   * THE LANE COUNTS TOO, for the same reason and a sharper case: a run parked in
   * the plan phase draws ONE stage and no agents, and it is the run the owner is
   * most likely to be watching live. An unfitted viewport would leave that card at
   * a negative x, off the left edge of the pane.
   */
  const drawnCount =
    placement.nodes.length + placement.stages.length + (placement.preview === null ? 0 : 1);

  useEffect(() => {
    if (hasFitted.current) return;
    if (!nodesInitialized) return;
    if (drawnCount === 0) return;
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
  }, [nodesInitialized, drawnCount, flow]);

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

  /*
   * COLUMNS AND THE PREVIEW ARE NOT SELECTABLE, for the same reason and by two
   * different mechanisms downstream. Selection means "show me this agent's
   * detail", and the sheet, the agent index and the card ring all resolve the
   * selected key against `graph.nodes` — a key that is not in there would select
   * nothing while switching the ring off whatever was selected before. The
   * preview's own affordance is the link on the card.
   */
  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      // A STAGE IS CLICKABLE and the other two are not: `activate` opens the left
      // panel for a stage rather than selecting it, so it never reaches the
      // sheet's `graph.nodes` lookup.
      if (node.type === "column" || node.type === "preview") {
        return;
      }
      activate(node.id);
    },
    [activate],
  );

  const onNodeMouseEnter = useCallback<NodeMouseHandler>((_event, node) => {
    // `hovered` energises the edges into and out of a key; the preview has none,
    // so hovering it would only clear whatever the reader was pointing at.
    if (node.type === "column" || node.type === "preview") {
      return;
    }
    setHovered(node.id);
  }, []);

  const onNodeMouseLeave = useCallback<NodeMouseHandler>(() => {
    setHovered(null);
  }, []);

  /*
   * EMPTY CANVAS CLEARS BOTH PANELS. It already cleared selection; the pre-build
   * panel is the fourth way back out of it and the most reachable one, because a
   * reader who wants the graph back clicks the graph.
   */
  const onPaneClick = useCallback((): void => {
    onSelect(null);
    onPlanPanel?.(false);
  }, [onSelect, onPlanPanel]);

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

  /*
   * THE EMPTY OVERLAY STANDS DOWN WHEN THE PREVIEW CARD IS DRAWN, because the
   * two occupy the same pixels: the overlay is a panel centred in the pane, the
   * fit centres the one card in the pane, and a terminal run with no graph events
   * has both. The sentence is not lost — `built` hands the same `emptyCanvasCopy`
   * text to the card, which renders it under the verdict.
   *
   * THE LOADING OVERLAY IS UNAFFECTED. `!ready` is about the graph snapshot being
   * in flight and says nothing about the workspace.
   *
   * AND IT STANDS DOWN WHEN THE LANE IS DRAWN, which is the same rule for a
   * stronger reason — 2026-08-04. "The agents have not started yet", centred over
   * a chain of stage cards that visibly say which of them is running, is the
   * display contradicting itself; the stages ARE the answer to "why is nothing
   * here yet", which is what the overlay's paragraph used to be for.
   */
  const showEmptyOverlay =
    empty && placement.preview === null && placement.stages.length === 0;

  /*
   * Derived unconditionally rather than inside the overlay's branch: it is four
   * string literals and a chain of comparisons, so memoising it would cost more
   * than it saves, and computing it here keeps the JSX to two lines.
   */
  const emptyCopy = emptyCanvasCopy({
    graphNodeCount: graph.nodes.length,
    runStatus,
    runIsActive,
  });

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
          /*
           * NO `title` ON ANY OF THESE THREE — 2026-08-04. Each carried a sentence
           * restating its own label ("Fold every group of identical tasks back into
           * one card each." over a button that reads `fold 2`), which is the
           * tutorial voice the owner asked to be cut. The labels are verbs with
           * counts and the effect is immediate and reversible.
           */
          <Button
            variant="default"
            className="pointer-events-auto"
            onClick={toggleAllGroups}
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
          <Button variant="default" className="pointer-events-auto" onClick={tidy}>
            tidy up
          </Button>
        )}
        {ambientCount > 0 && (
          /*
           * THE TOOLTIP IS GONE — 2026-08-04. It read "These agents are
           * housekeeping — not an agent step. Show or hide them on the canvas.",
           * which is the button's own label plus a description of what pressing a
           * toggle does. The 2026-07-30 note it replaced is still worth keeping:
           * the SDK field behind this filter is `skip_transcript`
           * (`GraphNode.ambient`), and naming it in UI copy asked the reader to
           * know an SDK flag to understand a button. It was not named then and it
           * is not named now.
           */
          <Button
            variant={showAmbient ? "primary" : "default"}
            className="pointer-events-auto"
            onClick={() => onShowAmbient(!showAmbient)}
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
      {(showEmptyOverlay || !ready) && (
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
             * A run that has not STARTED, a run that is working, a run whose agents are
             * all housekeeping and a run that is genuinely over are four different
             * facts. `emptyCanvasCopy` holds the four sentences and the reasoning for
             * each; note that the queued one cannot be reached until the run page
             * passes `runStatus` (see the prop).
             */
            /*
             * NO STAGES IN HERE ANY MORE. The lane they were drawn in is on the
             * canvas behind this overlay, and this branch cannot run while it has
             * cards — see `showEmptyOverlay`. What is left is the case the lane
             * genuinely cannot explain: a run with no pre-build rows at all, which
             * is every run recorded before the phases existed.
             */
            <div className="max-w-[380px] rounded border border-line bg-surface/90 px-5 py-4 text-center">
              <p className="text-[13px] font-semibold text-ink">{emptyCopy.title}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">{emptyCopy.body}</p>
              {runIsActive && latestActivity !== null && (
                /*
                 * SHOWN ONLY WHILE THE RUN IS LIVE. On a terminal run the last
                 * line is a fact about the past and a pulsing dot beside it would
                 * say the opposite of what is true.
                 */
                <div className="mt-3 border-t border-line pt-3">
                  <div className="flex items-center justify-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
                    />
                    {/*
                      * `aria-live="polite"`: a screen reader should hear the run
                      * move on, but must not have every log line interrupt it.
                      */}
                    <span
                      aria-live="polite"
                      className="line-clamp-1 text-[11px] text-ink-dim"
                    >
                      {latestActivity.text}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-ink-dim/70">
                    <RelativeSince atMs={latestActivity.atMs} />
                  </p>
                </div>
              )}
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
