"use client";

/**
 * stage-node.tsx — everything the run did before it wrote any code, as ONE card.
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
 * WHY IT IS ONE CARD AND NOT FIVE — 2026-08-04, the owner again: "Is it really
 * necessary to have all these different nodes? I think there should just be one
 * plan node linking to orchestrator. When you click on the plan node a menu on the
 * left side of the screen comes up." Five cards whose only relationship was "and
 * then" are one thing that happens in five parts. The parts are not lost: each one
 * is a segment of this card's rail and a row in the left panel, where a sentence
 * has room to be read. The canvas keeps the shape of the run; the panel keeps the
 * detail.
 *
 * IT DOES NOT EXPAND, AND THAT IS THE BUG BEING DESIGNED OUT. This card used to
 * swap `line-clamp-2 h-[32px]` for `whitespace-pre-wrap` when the reader clicked
 * it, growing inside a React Flow layout that had already reserved its box — the
 * owner's "when i click them they break funny". The height is now a constant
 * (`STAGE_HEIGHT`, 136) that the rows below sum to, and the click opens the panel.
 * There is no `expanded` anywhere in this file to reintroduce it with.
 *
 * EVERY WORD ON IT CAME OFF A ROW THE SERVER WROTE. `GraphStage` is projected by
 * `foldGraph` from `phase` and `log` rows — see the pre-build lane section in
 * `server/src/graph.ts` — and its rule is that nothing advances on a clock. This
 * component adds no state of its own: `state`, `detail` and `at` are rendered as
 * given, and where the server said nothing, this says nothing. The one word it
 * DOES compute is the rollup, and that computation is `rollupOf` in `layout.ts`,
 * where a test can call it.
 *
 * THE ONE NUMBER THAT IS COMPUTED HERE IS THE ELAPSED CLOCK, AND IT IS COMPUTED
 * FROM `stage.at`, NEVER FROM THE PAGE OPENING. `at` is the server's instant for
 * the row that set the state, and it is nullable — a row written before the wire
 * carried one has none. In that case the card shows no time at all rather than
 * dating a two-hour-old run to the moment somebody opened it, which is the same
 * rule `GraphActivityEntry.at` states for the agent cards.
 *
 * MEASURED AGAINST THE OWNER'S OWN DATABASE, NOT ONLY AGAINST A FIXTURE. All four
 * runs in `dashboard/data/runs.db` project a lane through the current fold, and
 * the two states no fixture exercises both appear there: `run-2026-08-04T11-08-10-
 * 487Z-162b186d` — the run this whole investigation started from — reads
 * `plan:done capture:pending author:UNRESOLVED audit:pending freeze:pending
 * orchestrator:pending` with ZERO agent nodes. That folds to rollup `stopped`: a
 * dashed border, no pulse, and the `author` sentence on the face of the card. It
 * is the primary rendering, not an edge case.
 *
 * `at` IS NOT NULL ON THE REAL SNAPSHOT even though the persisted payload has no
 * such field: `http.ts:1609` folds `{...row.event, at: row.at}`, so the instant
 * comes off the events table's own column. Folding the payload alone — which is
 * what a quick script does — shows every stage with `at: null` and is an artefact
 * of the script, not of production.
 *
 * NO HEADING ELEMENT FOR THE LABEL, DELIBERATELY. The run panel already renders
 * `<h_>Plan</h_>` for the plan dialogue, and a second accessible heading named
 * "Plan" on the same page makes `getByRole("heading", {name: "Plan"})` ambiguous
 * — `plan-dialogue.browser.spec.ts:58` resolves exactly that. The stage's name
 * is a `<p>`; the card's accessible name is on its shell. The left panel's own
 * title is a `<p>` for the same reason, and it is the same collision.
 */

import { useMemo, type ReactNode } from "react";
import type { Node, NodeProps } from "@xyflow/react";

import type { GraphStage, GraphStageState } from "@/lib/api-types";
import { useNow } from "@/lib/use-run-stream";
import { cx } from "@/components/ui";
import { NodeShell, type AgentNodeData } from "./agent-node";
import {
  STAGE_HEIGHT,
  STAGE_WIDTH,
  rollupActivityOf,
  rollupAtOf,
  rollupOf,
  type StageRollup,
} from "./layout";

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
 * THE WORDS CHANGED ON 2026-08-04 AND THE KEYS DID NOT. `running` became
 * `working` because "run" is a noun everywhere else in this app, so "running"
 * reads ambiguously; `pending` became `not started`; and `unresolved` became
 * `stopped`, which is the one word on the owner's own run that meant nothing to
 * him. The keys are the wire's, so nothing that keys on state moved.
 *
 * EVERY `bg-` NAME HERE EXISTS IN THE THEME. A colour `globals.css` does not
 * define compiles to nothing, and the marker for the one stage a reader is
 * looking for then renders INVISIBLE — that shipped once, as `bg-run`. The check
 * lives in `prebuild-lane.browser.spec.ts`, which scans this file's source and
 * the left panel's.
 */
export const STAGE_LOOK: Readonly<
  Record<GraphStageState, { label: string; dot: string; chip: string; card: string; meaning: string }>
> = {
  running: {
    label: "working",
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
    label: "not started",
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
    label: "stopped",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-dashed border-line-strong",
    meaning:
      "The run moved on while this was still working, and never said how it ended. Not a failure. Nobody was watching by then.",
  },
};

/**
 * The rollup word -> appearance and meaning, in the same shape as `STAGE_LOOK`.
 *
 * THE TOKEN AND THE VISIBLE WORD ARE DIFFERENT STRINGS ON PURPOSE. `data-state`
 * carries the hyphenated token so a selector can never be broken by a copy change,
 * and the chip carries the spaced words a reader wants.
 */
export const ROLLUP_LOOK: Readonly<
  Record<StageRollup, { word: string; dot: string; chip: string; card: string; meaning: string }>
> = {
  working: {
    word: "working",
    dot: "bg-accent motion-safe:animate-pulse",
    chip: "border-accent/35 bg-accent-dim/45 text-accent",
    card: "border-accent/55",
    meaning: "The run said one of these started and has not said it finished.",
  },
  stopped: {
    word: "stopped",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-dashed border-line-strong",
    meaning:
      "The run moved on while one of these was still working, and never said how it ended. Not a failure. Nobody was watching by then.",
  },
  done: {
    word: "done",
    dot: "bg-pass",
    chip: "border-pass/30 bg-pass-dim/70 text-pass",
    card: "border-pass/30",
    meaning: "The run said every one of these finished, or said it was not needed.",
  },
  waiting: {
    word: "waiting",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-line",
    meaning: "Some of these finished. The run has not mentioned the next one.",
  },
  "not-started": {
    word: "not started",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-line",
    meaning: "The run has not mentioned any of this yet.",
  },
  "never-ran": {
    word: "never ran",
    dot: "bg-ink-faint",
    chip: "border-line-strong bg-canvas/70 text-ink-dim",
    card: "border-dashed border-line",
    meaning: "The run ended before these were mentioned. Not a failure. They simply never happened.",
  },
};

/**
 * A type alias rather than an interface: React Flow's `Node<T>` constrains `T` to
 * `Record<string, unknown>` and only aliases carry the implicit index signature.
 */
export type StageNodeData = {
  /** The head stage: what the card is keyed on. */
  readonly stage: GraphStage;
  /** Every stage this card stands for. One for the orchestrator, five typically. */
  readonly members: readonly GraphStage[];
  /**
   * Whether the run can still say anything more.
   *
   * IT IS THE ARGUMENT MOST LIKELY TO LOOK UNUSED AND IT IS THE ONE THAT KEEPS
   * THE CARD HONEST: without it a cancelled run with four untouched sections says
   * "waiting", which promises future work about a run that will never continue.
   */
  readonly runIsActive: boolean;
  /** The left panel for this card is open. */
  readonly isSelected: boolean;
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
 *
 * EXPORTED, because the left panel needs the identical string beside every row it
 * lists. A second implementation of "how long ago" is a second thing to keep in
 * step with `useNow`'s tick.
 */
export function Elapsed({ atMs, running }: { atMs: number; running: boolean }): ReactNode {
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

/** The parsed instant a stage carried, or null when it carried none. */
export function useStageAt(stage: GraphStage): number | null {
  return useMemo(() => {
    if (stage.at === null) return null;
    const parsed = Date.parse(stage.at);
    return Number.isFinite(parsed) ? parsed : null;
  }, [stage.at]);
}

/**
 * One segment per section, in chain order.
 *
 * A STATE STRIP, NOT A PERCENTAGE BAR. There is no filled track behind it and no
 * fraction is claimed, because nothing here knows how long the remaining sections
 * take — the same reason the run chip carries a last line rather than a progress
 * bar. Five states, five colours, and the reader counts.
 *
 * `unresolved` IS AT /70 AND THE FIRST VALUE FAILED. At /40 the segment resolves
 * to about `#2e3239`, which cannot be told from `bg-line` `#232833` in a 4px bar —
 * so on the owner's own run the one section that stopped was invisible in the
 * strip that exists to show it.
 *
 * `aria-hidden`, because the same information is in the card's accessible name and
 * in the panel's list, both of which are words.
 */
export function StageRail({ members }: { members: readonly GraphStage[] }): ReactNode {
  return (
    <div aria-hidden="true" className="flex h-1 gap-[3px]">
      {members.map((member) => (
        <span
          key={member.id}
          className={cx("flex-1 rounded-[2px]", RAIL_SEGMENT[member.state])}
        />
      ))}
    </div>
  );
}

const RAIL_SEGMENT: Readonly<Record<GraphStageState, string>> = {
  done: "bg-pass/70",
  running: "bg-accent motion-safe:animate-pulse",
  unresolved: "bg-ink-faint/70",
  skipped: "bg-line-strong",
  pending: "bg-line",
};

/** The rollup, as the chip both the card and the panel header carry. */
export function RollupChip({ rollup }: { rollup: StageRollup }): ReactNode {
  const look = ROLLUP_LOOK[rollup];
  return (
    <span
      title={look.meaning}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[1px] text-[10px] font-medium",
        look.chip,
      )}
    >
      <span aria-hidden="true" className={cx("inline-block size-[5px] rounded-full", look.dot)} />
      {look.word}
    </span>
  );
}

/** What a screen reader hears instead of the folded card. */
function planLabel(
  rollup: StageRollup,
  activity: string,
  memberCount: number,
): string {
  return `Plan, ${ROLLUP_LOOK[rollup].word}. ${activity} Press Enter to see all ${String(memberCount)} sections.`;
}

/** What a screen reader hears instead of the orchestrator card. */
function stageLabel(stage: GraphStage): string {
  return `${stage.label}, ${STAGE_LOOK[stage.state].label}. ${stage.detail}`;
}

/**
 * The folded card: one name, one rollup, one rail, one sentence, one time.
 *
 * THE ROWS SUM TO THE CARD, AND THE SUM COUNTS THE BORDER. 1 border + 12 top pad
 * + 20 header + 10 + 4 rail + 12 + 32 activity + (auto) + 1 rule + 8 + 14 footer +
 * 12 bottom pad + 1 border = 127 fixed inside a 136px border-box, so the gap above
 * the rule takes the remaining 9. The design spec's own sum came to 135 and left
 * "one pixel of slack"; it had counted the padding twice over and the 1px border
 * not at all, which overflowed by a pixel when built. The gap above the footer is
 * `mt-auto` rather than a number for exactly that reason: it absorbs the rounding
 * instead of pushing the footer through the bottom edge.
 *
 * Nothing in here may grow: the detail that used to grow lives in the panel now,
 * which scrolls.
 *
 * THE ACTIVITY LINE IS CLAMPED PERMANENTLY AND THERE IS NO AFFORDANCE TO UNCLAMP
 * IT. `details` in the footer is not a toggle and is not a disclosure triangle; it
 * names where the whole thing is, which is the panel.
 */
export function PlanCard({
  head,
  members,
  runIsActive,
  isSelected,
}: {
  /**
   * The section this card is keyed on, normally `plan`.
   *
   * IT IS HERE ONLY TO NAME THE CARD'S `data-testid`, and that is worth the prop:
   * with the id hard-coded, a mutation that un-folded one section back into its own
   * card would draw a SECOND element carrying the same testid, and every selector
   * would fail on a strict-mode violation rather than on the count that is the
   * actual claim. Derived, the extra card announces which section it is.
   */
  head: GraphStage;
  members: readonly GraphStage[];
  runIsActive: boolean;
  isSelected: boolean;
}): ReactNode {
  const rollup = rollupOf(members, runIsActive);
  const look = ROLLUP_LOOK[rollup];
  const activity = rollupActivityOf(members, runIsActive);
  const atMs = useMemo(() => rollupAtOf(members), [members]);

  return (
    <article
      style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT }}
      data-testid={`stage-card-${head.id}`}
      data-state={rollup}
      className={cx(
        "relative flex flex-col overflow-hidden rounded-[10px] border bg-surface px-3.5 pb-3 pt-3 text-left",
        "bg-[radial-gradient(120%_80%_at_18%_0%,rgba(110,168,254,0.05),transparent_60%)]",
        // Tactile feedback, which the canvas had nowhere before this card.
        "transition-colors duration-150 hover:bg-surface-raised active:translate-y-[1px]",
        look.card,
        rollup === "waiting" || rollup === "not-started"
          ? "hover:border-line-strong"
          : undefined,
        isSelected && "border-accent ring-1 ring-accent/40",
      )}
    >
      <header className="flex h-5 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">
          Plan
        </p>
        <RollupChip rollup={rollup} />
      </header>

      <div className="mt-2.5">
        <StageRail members={members} />
      </div>

      <p className="mt-3 line-clamp-2 h-[32px] text-[11.5px] leading-[16px] text-ink-dim">
        {activity}
      </p>

      <footer className="mt-auto flex h-[14px] items-center justify-between gap-2 border-t border-line pt-2 text-[10px] text-ink-faint">
        {/*
          * NO TIME AT ALL WHEN NO SECTION CARRIED ONE. The alternative — the
          * browser's clock — would date every stage of a run recorded last week to
          * the moment the page opened.
          */}
        <span className="numeric truncate">
          {atMs === null ? "" : <Elapsed atMs={atMs} running={rollup === "working"} />}
        </span>
        <span
          className={cx(
            "shrink-0 font-mono text-[9.5px] uppercase tracking-[0.14em]",
            isSelected ? "text-accent" : "text-accent/70",
          )}
        >
          details
        </span>
      </footer>
    </article>
  );
}

/**
 * The orchestrator's own card, in the same box so the chain reads as two peers.
 *
 * ITS FOOTER IS CONDITIONAL AND THE DETAIL'S CLAMP FOLLOWS IT. A rule with an
 * empty row under it reads as a broken card, so a stage that carried no instant
 * simply has no rule and gets the fourth line of its sentence back.
 *
 * NO `details` LABEL, NO HOVER BORDER AND NO PRESS TRANSLATE. This card opens
 * nothing, so it must not look pressable.
 */
export function OrchestratorCard({ stage }: { stage: GraphStage }): ReactNode {
  const look = STAGE_LOOK[stage.state];
  const atMs = useStageAt(stage);

  return (
    <article
      style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT }}
      data-testid={`stage-card-${stage.id}`}
      data-state={stage.state}
      className={cx(
        "relative flex flex-col overflow-hidden rounded-[10px] border bg-surface px-3.5 pb-3 pt-3 text-left",
        "bg-[radial-gradient(120%_80%_at_18%_0%,rgba(110,168,254,0.05),transparent_60%)]",
        look.card,
      )}
    >
      <header className="flex h-5 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">
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
          "mt-3 text-[11.5px] leading-[16px] text-ink-dim",
          atMs === null ? "line-clamp-4" : "line-clamp-3",
        )}
      >
        {stage.detail}
      </p>

      {atMs !== null && (
        <footer className="mt-auto flex h-[14px] items-center border-t border-line pt-2 text-[10px] text-ink-faint">
          <span className="numeric truncate">
            <Elapsed atMs={atMs} running={stage.state === "running"} />
          </span>
        </footer>
      )}
    </article>
  );
}

export function StageNode({ id, data }: NodeProps<StageFlowNode>): ReactNode {
  const isOrchestrator = data.stage.id === "orchestrator";
  const rollup = rollupOf(data.members, data.runIsActive);
  return (
    <NodeShell
      nodeKey={id}
      data={{
        isSelected: data.isSelected,
        tabbable: data.tabbable,
        onCardKeyDown: data.onCardKeyDown,
      }}
      label={
        isOrchestrator
          ? stageLabel(data.stage)
          : planLabel(rollup, rollupActivityOf(data.members, data.runIsActive), data.members.length)
      }
      live={
        isOrchestrator ? data.stage.state === "running" : rollup === "working"
      }
    >
      {isOrchestrator ? (
        <OrchestratorCard stage={data.stage} />
      ) : (
        <PlanCard
          head={data.stage}
          members={data.members}
          runIsActive={data.runIsActive}
          isSelected={data.isSelected}
        />
      )}
    </NodeShell>
  );
}

/*
 * `StageHeaderNode`, `StageHeaderData` AND THE STRING "Before the build" ARE GONE
 * — 2026-08-04, with the five cards they headed.
 *
 * What the component was, and what its docblock argued: a lane header in the same
 * language as a column header, "one label and a count", which itself replaced a
 * paragraph that had stopped being true. The argument for keeping a header at all
 * was that the lane was a column of cards and columns are labelled.
 *
 * The lane is now two named cards — Plan and Orchestrator — and a header reading
 * "Before the build 2" over them is a label for something the cards already say in
 * larger type. The count moved into the left panel as `<n> of <total> done`, which
 * is a measurement rather than a caption. `PlacedStageHeader` and
 * `Placement.stageHeader` went with it; see the note where they were declared in
 * `layout.ts`.
 */
