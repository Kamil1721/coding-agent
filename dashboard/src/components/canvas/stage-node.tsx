"use client";

/**
 * stage-node.tsx — one thing the run did before it had agents, as a card.
 *
 * WHY THIS IS A CARD ON THE CANVAS AND NOT A PANEL OVER IT. The lane used to be
 * a floating box inside `orchestration-canvas.tsx`'s empty-state branch: it was
 * drawn only while the graph had zero nodes and it was replaced the instant the
 * build started. So the ~80 minutes before the first agent and the rest of the
 * run were two unrelated pictures, and the owner's ask was to join them —
 * "Planning (node) ----- Orchestrator (node) ------ (then whatever the
 * orchestrator spawns)". A card that pans, zooms, takes focus and takes an edge
 * is the only version of that which is actually the same canvas.
 *
 * EVERY WORD ON IT CAME OFF A ROW THE SERVER WROTE. `GraphStage` is projected by
 * `foldGraph` from `phase` and `log` rows — see the pre-build lane section in
 * `server/src/graph.ts` — and its rule is that nothing advances on a clock. This
 * component adds no state of its own: `state`, `detail` and `at` are rendered as
 * given, and where the server said nothing, this says nothing.
 *
 * THE ONE NUMBER THAT IS COMPUTED HERE IS THE ELAPSED CLOCK, AND IT IS COMPUTED
 * FROM `stage.at`, NEVER FROM THE PAGE OPENING. `at` is the server's instant for
 * the row that set the state, and it is nullable — a row written before the wire
 * carried one has none. In that case the card shows no time at all rather than
 * dating a two-hour-old run to the moment somebody opened it, which is the same
 * rule `GraphActivityEntry.at` states for the agent cards.
 *
 * NO HEADING ELEMENT FOR THE LABEL, DELIBERATELY. The run panel already renders
 * `<h_>Plan</h_>` for the plan dialogue, and a second accessible heading named
 * "Plan" on the same page makes `getByRole("heading", {name: "Plan"})` ambiguous
 * — `plan-dialogue.browser.spec.ts:58` resolves exactly that. The stage's name
 * is a `<p>`; the card's accessible name is on its shell.
 */

import { useMemo, type ReactNode } from "react";
import type { Node, NodeProps } from "@xyflow/react";

import type { GraphStage, GraphStageState } from "@/lib/api-types";
import { useNow } from "@/lib/use-run-stream";
import { cx } from "@/components/ui";
import { NodeShell, type AgentNodeData } from "./agent-node";
import { STAGE_WIDTH } from "./layout";

/**
 * State -> appearance and what the word MEANS, in one table.
 *
 * `unresolved` IS THE ROW WORTH READING, and it is the one the old overlay could
 * not express at all: the run moved on — or ended — while this stage still read
 * `running`, and nothing ever said how it finished. It is not a failure and it is
 * not `pending`, which on a finished run would read as "still to come". It gets
 * the neutral palette and a dashed edge, the same treatment `stateLook` gives an
 * agent that was still in flight when the stream stopped.
 *
 * EVERY `bg-` NAME HERE EXISTS IN THE THEME. A colour `globals.css` does not
 * define compiles to nothing, and the marker for the one stage a reader is
 * looking for then renders INVISIBLE — that shipped once, as `bg-run`. The check
 * lives in `prebuild-lane.browser.spec.ts`, which scans this file's source.
 */
export const STAGE_LOOK: Readonly<
  Record<GraphStageState, { label: string; dot: string; chip: string; card: string; meaning: string }>
> = {
  running: {
    label: "running",
    dot: "bg-accent motion-safe:animate-pulse",
    chip: "border-accent/35 bg-accent-dim/45 text-accent",
    card: "border-accent/55",
    meaning: "The run said this started and has not said it finished.",
  },
  done: {
    label: "done",
    dot: "bg-pass",
    chip: "border-pass/30 bg-pass-dim/70 text-pass",
    card: "border-pass/30",
    meaning: "The run said this finished.",
  },
  pending: {
    label: "pending",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-line",
    meaning: "The run has not mentioned this yet.",
  },
  skipped: {
    label: "skipped",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-line border-dashed",
    meaning: "The run said this was not needed.",
  },
  unresolved: {
    label: "unresolved",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-dashed border-line-strong",
    meaning:
      "The run moved on while this still read running, and never said how it ended. Not a failure — nobody was watching by then.",
  },
};

/**
 * A type alias rather than an interface: React Flow's `Node<T>` constrains `T` to
 * `Record<string, unknown>` and only aliases carry the implicit index signature.
 */
export type StageNodeData = {
  readonly stage: GraphStage;
  /** The reader has opened this card. Its detail is then shown in full. */
  readonly expanded: boolean;
  readonly tabbable: boolean;
  readonly onCardKeyDown: AgentNodeData["onCardKeyDown"];
};

export type StageFlowNode = Node<StageNodeData, "stage">;

/**
 * How long ago the server's instant was, ticking.
 *
 * ITS OWN COMPONENT so the 10-second clock re-renders one line rather than the
 * whole canvas — the same reason `RelativeSince` in `orchestration-canvas.tsx` is
 * its own component, and the same failure it was extracted to avoid: a clock in
 * the canvas body re-runs the layout every tick.
 */
function Elapsed({ atMs, running }: { atMs: number; running: boolean }): ReactNode {
  const nowMs = useNow(10_000);
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  const minutes = Math.round(seconds / 60);
  const span =
    seconds < 45
      ? "just now"
      : minutes < 60
        ? `${String(minutes)} min`
        : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  if (span === "just now") return <>{running ? "just started" : "just now"}</>;
  return <>{running ? `${span} so far` : `${span} ago`}</>;
}

/** What a screen reader hears instead of the card. */
function stageLabel(stage: GraphStage): string {
  const look = STAGE_LOOK[stage.state];
  return `${stage.label}, ${look.label}. ${stage.detail} Press Enter for the full line.`;
}

/**
 * One stage, drawn in the agent cards' visual language and narrower than they
 * are — see `STAGE_WIDTH` for why.
 *
 * THE DETAIL IS CLAMPED UNTIL THE CARD IS OPENED, and opening it is the whole
 * interaction. The server's sentences run from three words ("No URL in the
 * ticket, so nothing was captured.") to a full token report ("spec seat —
 * anthropic: 14 input, 40187 cache read, …"), so a card sized for the long one
 * would be mostly empty on the short one and a card sized for the short one would
 * silently swallow the report. Clamped by default, whole on demand.
 */
export function StageCard({ stage, expanded }: { stage: GraphStage; expanded: boolean }): ReactNode {
  const look = STAGE_LOOK[stage.state];
  const atMs = useMemo(() => {
    if (stage.at === null) return null;
    const parsed = Date.parse(stage.at);
    return Number.isFinite(parsed) ? parsed : null;
  }, [stage.at]);

  return (
    <article
      style={{ width: STAGE_WIDTH }}
      data-testid={`stage-card-${stage.id}`}
      data-state={stage.state}
      className={cx(
        "relative overflow-hidden rounded-[10px] border bg-surface px-3.5 py-3 text-left transition-colors",
        "bg-[radial-gradient(120%_80%_at_18%_0%,rgba(110,168,254,0.05),transparent_60%)]",
        look.card,
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[12.5px] font-semibold tracking-[-0.01em] text-ink">
          {stage.label}
        </p>
        <span
          title={look.meaning}
          className={cx(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[1px] text-[10px] font-medium",
            look.chip,
          )}
        >
          <span aria-hidden="true" className={cx("inline-block size-[5px] rounded-full", look.dot)} />
          {look.label}
        </span>
      </header>

      <p
        className={cx(
          "mt-1.5 text-[11px] leading-[16px] text-ink-dim",
          expanded ? "whitespace-pre-wrap break-words" : "line-clamp-2 h-[32px]",
        )}
      >
        {stage.detail}
      </p>

      <footer className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-1.5 text-[10px] text-ink-faint">
        {/*
          * NO TIME AT ALL WHEN THE ROW CARRIED NONE. The alternative — the
          * browser's clock — would date every stage of a run recorded last week to
          * the moment the page opened.
          */}
        <span className="truncate">
          {atMs === null ? "" : <Elapsed atMs={atMs} running={stage.state === "running"} />}
        </span>
        <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.14em] text-accent">
          {expanded ? "close" : "open"}
        </span>
      </footer>
    </article>
  );
}

export function StageNode({ id, data }: NodeProps<StageFlowNode>): ReactNode {
  return (
    <NodeShell
      nodeKey={id}
      data={{
        isSelected: data.expanded,
        tabbable: data.tabbable,
        onCardKeyDown: data.onCardKeyDown,
      }}
      label={stageLabel(data.stage)}
      live={data.stage.state === "running"}
    >
      <StageCard stage={data.stage} expanded={data.expanded} />
    </NodeShell>
  );
}

/**
 * The lane's header, in the same language as a column header.
 *
 * ONE LABEL AND A COUNT. The panel this replaced carried a paragraph under the
 * stages — "These run before any agent is spawned, so there is no delegation
 * graph yet. It appears as soon as the build starts." — which described the
 * absence of the graph that is now drawn beside it, on the same surface, with a
 * wire between them. The sentence stopped being true and was cut rather than
 * reworded.
 */
export type StageHeaderData = { readonly count: number };
export type StageHeaderFlowNode = Node<StageHeaderData, "stageHeader">;

export function StageHeaderNode({ data }: NodeProps<StageHeaderFlowNode>): ReactNode {
  return (
    <div style={{ width: STAGE_WIDTH }} className="select-none">
      <div className="flex items-baseline gap-2 border-b border-line pb-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-dim">
          Before the build
        </span>
        <span className="numeric text-[10.5px] text-ink-faint">{data.count}</span>
      </div>
    </div>
  );
}
