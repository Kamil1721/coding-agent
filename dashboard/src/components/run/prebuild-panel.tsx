"use client";

/**
 * prebuild-panel.tsx — the five things the run does before it writes any code,
 * as a list you can read, docked where the run chip was.
 *
 * THE OWNER'S ASK, VERBATIM: "when i click them they break funny. Also Is it
 * really necessary to have all these different nodes? I think there should just be
 * one plan node linking to orchestrator. When you click on the plan node a menu on
 * the left side of the screen comes up … replacing this. and instead on that menu
 * you have the different sections that show what it is doing right now. Also need
 * to make that menu look better."
 *
 * ─── IT REPLACES THE RUN CHIP AND THE CHAT BUTTON, AND NOTHING ELSE ───
 *
 * "Replacing this" pointed at the whole left dock, and taken literally that would
 * hide `PlanDialoguePanel` and `DesignLockPanel` — the two surfaces a run is
 * STOPPED on, waiting for him. Clicking a card on the canvas would then cost him
 * the only control that can un-stick his own run. So the swap is the chip and the
 * chat button; every notice and both park panels keep rendering underneath. The
 * run page's dock is where that is enforced, and it has its own note.
 *
 * ─── WHY A DOCKED PANEL AND NOT THE RIGHT-HAND SHEET ───
 *
 * `DetailSheet` resolves its subject against `graph.nodes` and takes a
 * `GraphNode`. A stage is not one and never will be — it is projected from `phase`
 * and `log` rows, not from `graph_agent`. Handing it a stage would mean forging a
 * node. It is also the wrong side of the screen: the owner named the left.
 *
 * ─── EVERY SENTENCE ON IT IS THE SERVER'S, EXCEPT TWO THAT REFUSE A PROMISE ───
 *
 * A section's `detail` is the line `foldGraph` wrote — a capture URL, a token
 * report, a `sealed suite <hash>` — and it renders unclamped, because the panel
 * scrolls and this is exactly the string the deleted open/close toggle existed to
 * reveal. The two exceptions are the fixed lines in `layout.ts`
 * (`SECTION_NEVER_MENTIONED`, `NOTHING_WAS_MENTIONED`): on a run that is OVER, the
 * server's forward-looking pending sentence ("Waiting to read the page your ticket
 * links to.") is a promise about a run that will never continue. That is the same
 * defect the rollup's `never ran` branch exists to refuse, one level down, so the
 * row says the true thing instead.
 *
 * ─── IT READS THE GRAPH SNAPSHOT, NEVER THE LIVE TRACE ───
 *
 * `members` comes from `GraphState.stages`, folded by the same reducer on the REST
 * snapshot and on the socket. `use-run-stream.ts:820-822` never opens an
 * EventSource for a terminal run, so anything sourced from `trace` is BLANK on
 * every finished run — which is most of the runs anyone opens, including the one
 * this redesign was built against.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { GraphStage, GraphStageState } from "@/lib/api-types";
import { cx } from "@/components/ui";
import {
  Elapsed,
  RollupChip,
  StageRail,
  useStageAt,
} from "@/components/canvas/stage-node";
import {
  SECTION_NEVER_MENTIONED,
  rollupAtOf,
  rollupDoneCount,
  rollupOf,
} from "@/components/canvas/layout";

/** The one line that says what the whole panel is about. */
const PANEL_BLURB = "Everything the run does before it writes any code.";

/**
 * The two generated assets, at their render size.
 *
 * Both are 2x, drawn on `--color-canvas` with the grid at `--canvas-grid`, so they
 * sit flush on the surface with no transparency and no cutout. They carry the
 * accent and no other hue. `object-cover` on a `bg-canvas` container: a failed
 * load matches the dark around it instead of flashing white, and `object-contain`
 * would put back the dead margin the tight crop removed.
 */
const EMPTY_ASSET = {
  src: "/pre-build-empty.png",
  alt: "Five unlit segments on a rail, meaning nothing has been reported yet.",
} as const;
const SEALED_ASSET = {
  src: "/pre-build-sealed.png",
  alt: "Five segments joined by one continuous line, meaning the tests are sealed.",
} as const;

/**
 * What a row SHOWS, which is not always what the wire says.
 *
 * A SECTION STILL READING `running` ON A RUN THAT IS OVER IS `unresolved`, and
 * this was found by a test rather than reasoned in advance: the folded card's
 * rollup already collapses that case (`rollupOf` rule 2 — "the run moved on while
 * one of these was still working"), so a panel that left the same section pulsing
 * `working` underneath a card reading `stopped` had the two surfaces contradicting
 * each other about one fact. It is also the rule `spec-pipeline.ts` already
 * states in its own words: a terminal run has no running stage.
 *
 * Nothing else is rewritten. `pending` stays `pending` and is handled at the two
 * places where a dead run changes what it MEANS.
 */
function rowStateOf(stage: GraphStage, runIsActive: boolean): GraphStageState {
  return stage.state === "running" && !runIsActive ? "unresolved" : stage.state;
}

/**
 * The word in a row's right slot, or null when the row shows a time instead.
 *
 * THE RIGHT SLOT NEVER CARRIES TWO SIGNALS. A settled section shows WHEN, an
 * active one shows WHAT, and one the run has said nothing about shows nothing at
 * all — unless the run is over, where "never ran" is the fact.
 */
function slotWordOf(state: GraphStageState, runIsActive: boolean): string | null {
  if (state === "running") return "working";
  if (state === "unresolved") return "stopped";
  if (state === "skipped") return "skipped";
  if (state === "pending") return runIsActive ? null : "never ran";
  return null;
}

function SectionRow({
  stage,
  runIsActive,
}: {
  stage: GraphStage;
  runIsActive: boolean;
}): ReactNode {
  const atMs = useStageAt(stage);
  const state = rowStateOf(stage, runIsActive);
  const word = slotWordOf(state, runIsActive);
  const dead = state === "pending" && !runIsActive;
  const detail = dead ? SECTION_NEVER_MENTIONED : stage.detail;

  return (
    <li
      data-testid={`plan-section-${stage.id}`}
      data-state={state}
      className={cx(
        // The left rule is ALWAYS present, transparent when it is not the active
        // section, so marking the active row shifts no text by two pixels.
        "border-l-2 px-4 py-3",
        state === "running"
          ? "border-l-accent bg-accent-dim/20"
          : state === "unresolved"
            ? "border-l-ink-faint/50"
            : "border-l-transparent",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p
          className={cx(
            "min-w-0 text-[12.5px] font-medium",
            /*
             * `ink-dim`, NOT `ink-faint`, FOR A SECTION THAT HAS NOT RUN — and
             * this was changed after looking at it. An `ink-faint` name above an
             * `ink-dim` sentence puts a row's heading dimmer than its own body,
             * which reads as an inversion rather than as recession, and it is
             * below the AA contrast floor besides. The recession is carried by the
             * absent left rule and the absent right slot instead.
             */
            state === "pending" || state === "skipped" ? "text-ink-dim" : "text-ink",
          )}
        >
          {stage.label}
        </p>
        <span className="shrink-0">
          {word !== null ? (
            <span
              className={cx(
                "font-mono text-[10px] uppercase tracking-[0.14em]",
                state === "running"
                  ? "text-accent"
                  : state === "unresolved"
                    ? "text-ink-dim"
                    : "text-ink-faint",
              )}
            >
              {word}
            </span>
          ) : atMs !== null ? (
            <span className="numeric text-[10.5px] text-ink-faint">
              <Elapsed atMs={atMs} running={false} />
            </span>
          ) : null}
        </span>
      </div>

      {/*
        * NO CLAMP, ANYWHERE IN THIS LIST, AND NO TOGGLE TO ADD ONE BACK. The
        * server's `done` line for a seat is a token report several hundred
        * characters long, and that string is precisely what the deleted in-place
        * expansion existed to show. Growth is free here: the list scrolls.
        */}
      <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-[17px] text-ink-dim">
        {detail}
      </p>
    </li>
  );
}

export function PreBuildPanel({
  members,
  runIsActive,
  ticketLabel,
  ticketTooltip,
  onClose,
}: {
  /** The folded card's sections, in chain order. From `GraphState.stages`. */
  readonly members: readonly GraphStage[];
  readonly runIsActive: boolean;
  /** The run's own name, for the heading this panel takes over. */
  readonly ticketLabel: string;
  readonly ticketTooltip: string;
  readonly onClose: () => void;
}): ReactNode {
  const rollup = rollupOf(members, runIsActive);
  const doneCount = rollupDoneCount(members);
  const atMs = useMemo(() => rollupAtOf(members), [members]);
  const everythingPending = members.every((member) => member.state === "pending");

  /*
   * ESCAPE CLOSES IT, FROM ANYWHERE ON THE PAGE.
   *
   * A handler on this element alone would only fire while focus is inside the
   * panel, and the click that opens it leaves focus on the CARD, out on the
   * canvas — so the most likely first press of Escape would do nothing. Listening
   * on the window costs one listener for the lifetime of an open panel. It cannot
   * fight `DetailSheet`'s own Escape: opening this clears `selectedId`, so the two
   * are never open at once.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  /*
   * THE ONE TRANSITION, AND IT IS MOTIVATED: "this came out of the card you just
   * clicked". 150ms, 10px from the left, mirroring `.sheet-in`, which comes from
   * the right for the same reason.
   *
   * IT IS A TRANSITION RATHER THAN A KEYFRAME because `globals.css` belongs to
   * another lane this wave and a `@keyframes` cannot be declared from here. The
   * flip has to cross a real frame or React batches both classes into one commit
   * and nothing moves while looking implemented, so it is a `requestAnimationFrame`
   * and not a bare `setState`. `motion-reduce:` stills it; the variant is the same
   * media query the CSS override would have used, and it cannot lose a cascade
   * fight the way an override written above its own rule does (`globals.css`
   * records that trap twice).
   */
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSettled(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section
      data-testid="prebuild-panel"
      data-state={rollup}
      className={cx(
        "flex max-h-[78vh] flex-col overflow-hidden rounded border border-line bg-surface/95 backdrop-blur",
        // `translate`, NOT `transform`: Tailwind v4 compiles `-translate-x-2.5` to
        // the standalone `translate` property, so a transition naming `transform`
        // fades the panel in while SNAPPING it sideways in one frame. Measured in
        // the browser, where `getComputedStyle(el).transform` came back `none` at
        // both ends of the animation while the panel visibly jumped.
        "transition-[opacity,translate] duration-150 ease-[cubic-bezier(0.22,0.61,0.36,1)]",
        "motion-reduce:transition-none",
        settled ? "translate-x-0 opacity-100" : "-translate-x-2.5 opacity-0",
      )}
    >
      {/*
        * THE RETURN BAR, AND THE PAGE'S ONLY `h1`.
        *
        * `RunHud` owns the run page's single top-level heading, and this panel
        * replaces `RunHud` — so without the heading here the page has none while
        * the panel is open. It is 12px on purpose: heading LEVEL is document
        * structure, heading SIZE is hierarchy, and the panel's own `Plan` title is
        * the visual head. It also keeps the reader told which run this is, which
        * is the other job the chip was doing.
        *
        * Three other ways back exist and all of them work: Escape, clicking the
        * Plan card again, and clicking empty canvas.
        */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3.5 py-2">
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[12px] font-medium text-ink-dim transition-colors hover:text-ink"
        >
          Back to run
        </button>
        <h1
          title={ticketTooltip}
          className="min-w-0 truncate text-[12px] font-medium text-ink-dim"
        >
          {ticketLabel}
        </h1>
      </div>

      <div className="shrink-0 px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          {/*
            * A `<p>` AND NOT A HEADING, for the reason `stage-node.tsx` records:
            * `PlanDialoguePanel` already owns an accessible heading named "Plan",
            * and a second one makes `getByRole("heading", {name: "Plan"})`
            * ambiguous on the one run where both are on screen.
            */}
          <p className="text-lede font-semibold text-ink">Plan</p>
          <RollupChip rollup={rollup} />
        </div>
        <p className="mt-1 text-[11.5px] leading-snug text-ink-dim">{PANEL_BLURB}</p>
        <div className="mt-2.5">
          <StageRail members={members} />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px] text-ink-faint">
          {/*
            * THE DENOMINATOR IS COUNTED, NOT ASSUMED. It is five on a normal run
            * and it is not always five: a reused acceptance suite makes the fold
            * drop `capture`, `author` and `audit` outright, and a stream that opens
            * at the spec phase never seeds `plan`. "n of 5" on a three-section lane
            * would be the panel asserting two sections nobody has.
            */}
          <span className="numeric">
            {String(doneCount)} of {String(members.length)} done
          </span>
          <span className="numeric">
            {atMs === null ? "" : <Elapsed atMs={atMs} running={rollup === "working"} />}
          </span>
        </div>
      </div>

      {everythingPending ? (
        /*
         * NOTHING HAS BEEN SAID YET, so there is nothing to list and the panel says
         * so once instead of five times. The asset appears ONLY here, which is what
         * makes it honest: five unlit segments cannot claim a state on a run that
         * has reported none.
         */
        <div className="shrink-0 border-t border-line">
          <div className="bg-canvas">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={EMPTY_ASSET.src}
              alt={EMPTY_ASSET.alt}
              width={368}
              height={104}
              className="h-[104px] w-full object-cover object-center"
            />
          </div>
          <p className="px-4 py-3 text-center text-[11.5px] text-ink-dim">
            The run has not said anything about this yet.
          </p>
        </div>
      ) : (
        <ul
          data-testid="prebuild-sections"
          className="min-h-0 flex-1 divide-y divide-line overflow-y-auto"
        >
          {members.map((member) => (
            <SectionRow key={member.id} stage={member} runIsActive={runIsActive} />
          ))}
        </ul>
      )}

      {rollup === "done" && (
        <div className="shrink-0 border-t border-line">
          <div className="bg-canvas">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={SEALED_ASSET.src}
              alt={SEALED_ASSET.alt}
              width={368}
              height={80}
              className="h-20 w-full object-cover object-center"
            />
          </div>
          <p className="px-4 py-2 text-[11px] text-ink-faint">
            The tests are sealed. The builder cannot see them.
          </p>
        </div>
      )}
    </section>
  );
}
