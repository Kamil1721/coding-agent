"use client";

/* eslint-disable @next/next/no-img-element -- the same reason `run/screenshots.tsx`
   gives: mockup locations come from the backend at runtime and may not be HTTP at
   all, so `next/image`'s configured loader and known remote host do not apply. A
   plain <img> with an explicit error fallback is the honest primitive. */

/**
 * design-lock.tsx — the five mockups, as the decision the run is parked on.
 *
 * SPEC §17's DIAGRAM SAYS "UI shows the 5 mockups as clickable cards", and until
 * this file existed nothing in the app could answer that park: the design lane
 * would produce five images, the run would stop, and the only thing on screen was
 * a generic "waiting on input" notice saying the API had no channel to reply on.
 *
 * THE MOTION IS BORROWED, NOT INVENTED. The strip under the header is the
 * canvas's delegation edge (`flow-edge.tsx`, `globals.css`) rendered flat: a soft
 * glow tube with a lighter dashed core travelling along it WHILE THE RUN IS
 * ACTUALLY PARKED HERE, and one flat hairline the moment it is not. That is the
 * same rule the canvas plays by — a finished branch does not move — so the page
 * has one motion vocabulary rather than two. Reduced motion is already handled
 * for both classes in `globals.css`.
 *
 * §17.3 RULE 1 IS WHY THE COPY READS THE WAY IT DOES. The lock never blocks
 * indefinitely: with no choice inside the window, `ui-designer` picks and the
 * record says the pick was automatic. So nothing here may imply the run is
 * waiting on the owner — it is offering them the decision, not requiring it. Nor
 * may a card keep looking interactive once the lock has resolved: outside
 * `pending` there is no button in the tree at all, not a disabled one.
 *
 * WHAT IS DELIBERATELY NOT SHOWN. There is no countdown, because the deadline is
 * not on the wire — `ApiDesignLock` carries neither `parkedAt` nor the configured
 * timeout, and a clock invented in the browser would be a number the owner could
 * plan around and be wrong about. And there is no `intent` line: `DesignRef`
 * carries one on the server, `Screenshot` does not, and the label is the only
 * place a section reaches this side.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { RunDetail, Screenshot } from "@/lib/api-types";
import {
  designLockPhase,
  isPublishedAs,
  lockedMockup,
  mockupSection,
  type DesignLockPhase,
} from "@/lib/mockups";
import { screenshotSrc } from "@/lib/screenshots";
import { Badge, EmptyState, Lightbox, MonoPath, Panel, cx } from "@/components/ui";
import type { Tone } from "@/lib/presentation";

/* ------------------------------------------------------------------ */

/**
 * The connector, flat.
 *
 * Three layers while live and one while settled, matching `DelegationEdge`
 * exactly: the wide soft tube, a dim continuous stroke so the tube still reads as
 * a connection between the travelling dashes, then the travelling core.
 *
 * SHORT AND LEFT-ALIGNED, WHICH TOOK LOOKING AT IT TO GET RIGHT. Spanning the
 * panel, the `2 11` dash pattern repeats about a hundred times and stops being a
 * travelling core at all — it reads as a dotted rule under the header, which is
 * decoration, and decoration that moves is the thing this app's motion rules
 * exist to keep off the screen. At 96px the dashes are countable and the mark
 * reads as what it is: the run arriving here and stopping.
 *
 * `<line>` takes a percentage for `x2`, so it spans its box without a viewBox —
 * a stretched viewBox would scale the dash pattern with the panel's width and
 * the rhythm would differ on every screen.
 */
function LockConnector({ flowing }: { flowing: boolean }): ReactNode {
  return (
    // Pulled toward the deck so it reads as arriving AT the cards rather than
    // floating between two blocks of equal air.
    <svg className="-mb-2 block h-3 w-24" aria-hidden="true" focusable="false">
      {flowing && <line x1="0" y1="6" x2="100%" y2="6" className="edge-glow" />}
      <line
        x1="0"
        y1="6"
        x2="100%"
        y2="6"
        className="edge-line"
        style={
          flowing
            ? { stroke: "var(--color-accent)", strokeWidth: 1.25, opacity: 0.4 }
            : { stroke: "var(--color-line-strong)", strokeWidth: 1.5 }
        }
      />
      {flowing && (
        <line x1="0" y1="6" x2="100%" y2="6" className="edge-core edge-core--flowing" />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */

interface Chooser {
  readonly tone: Tone;
  readonly badge: string;
  readonly sentence: string;
}

/**
 * Who chose, in words that do not flatter a fallback into a judgement.
 *
 * `fallback` is not one of §17.3's two choosers and must not be dressed up as
 * one: it means the first mockup in manifest order was taken because nothing
 * else could be, and an owner reading this page later needs that distinction to
 * know how much the locked design means.
 */
function chooserOf(lockedBy: "owner" | "ui-designer" | "fallback" | null): Chooser {
  if (lockedBy === "owner") {
    return { tone: "accent", badge: "your choice", sentence: "You picked this one." };
  }
  if (lockedBy === "ui-designer") {
    return {
      tone: "info",
      badge: "chosen automatically",
      sentence: "No choice arrived in time, so ui-designer picked.",
    };
  }
  if (lockedBy === "fallback") {
    return {
      tone: "warn",
      badge: "no judgement applied",
      sentence:
        "Neither you nor ui-designer produced a usable choice, so the first mockup in manifest order was taken.",
    };
  }
  return { tone: "neutral", badge: "locked", sentence: "The run recorded no chooser." };
}

/* ------------------------------------------------------------------ */

function MockupCard({
  shot,
  runId,
  locked,
  lockedTone,
  onChoose,
  pendingChoice,
  disabled,
}: {
  shot: Screenshot;
  runId: string;
  locked: boolean;
  /**
   * The badge's tone follows WHO LOCKED IT while the ring stays accent, because
   * the two answer different questions: the ring says which card was built to,
   * the badge says how it came to be picked. An amber `no judgement applied`
   * chip on the highlighted card is the whole point — a fallback lock is not an
   * endorsement and must not be coloured like one.
   */
  lockedTone: Tone;
  /** Null outside `pending` — an unclickable card renders NO button, not a disabled one. */
  onChoose: ((path: string) => void) | null;
  pendingChoice: boolean;
  disabled: boolean;
}): ReactNode {
  const src = screenshotSrc(runId, shot.path);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const showImage = src !== null && !failed;
  const section = mockupSection(shot.label);
  const interactive = onChoose !== null;

  return (
    <figure
      className={cx(
        "group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded border bg-surface-raised",
        "transition-[transform,border-color,box-shadow] duration-200",
        locked
          ? "border-accent/60 shadow-[0_0_0_1px_var(--color-accent-dim),0_10px_28px_-18px_var(--color-accent)]"
          : "border-line",
        interactive &&
          !disabled &&
          "cursor-pointer group-hover:border-accent hover:-translate-y-px hover:border-accent/70 hover:shadow-[0_10px_30px_-20px_var(--color-accent)] active:translate-y-0",
        pendingChoice && "border-accent/70",
      )}
    >
      {/*
       * THE WHOLE CARD IS THE TARGET, and it is one button rather than a nest of
       * them: a `<figure>` inside a `<button>` is not valid content, and a small
       * "choose" button under an image would put the click somewhere other than
       * where the eye already is. `inset-0` covers the card, so the hit area is
       * the card; `aria-label` carries the section, since the visible label is
       * outside the button.
       */}
      {interactive && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChoose(shot.path)}
          aria-label={`Build to the ${section} mockup`}
          className="absolute inset-0 z-10 cursor-pointer rounded disabled:cursor-wait"
        />
      )}

      {showImage ? (
        /*
         * CLICK TO ENLARGE — but only when the deck is NOT asking for a choice.
         *
         * While `interactive`, an invisible full-card button above this one means
         * "build to this mockup", and two overlapping click targets on one card is
         * how an owner locks a design when they meant to look at it. So the zoom is
         * the settled-record affordance; during the choice, the card's job is the
         * choice.
         */
        interactive ? (
          <img
            src={src}
            alt={`Design mockup of the ${section} section`}
            loading="lazy"
            onError={() => setFailed(true)}
            className="block h-[156px] w-full bg-canvas object-cover object-top"
          />
        ) : (
          <button
            type="button"
            onClick={() => setZoomed(true)}
            aria-label={`Enlarge the ${section} mockup`}
            className="block w-full cursor-zoom-in"
          >
            <img
              src={src}
              alt={`Design mockup of the ${section} section`}
              loading="lazy"
              onError={() => setFailed(true)}
              className="block h-[156px] w-full bg-canvas object-cover object-top"
            />
          </button>
        )
      ) : (
        <div className="flex h-[156px] items-center justify-center bg-canvas px-3 text-center text-[11px] leading-snug text-ink-faint">
          {src === null
            ? "This mockup is on disk. Nothing here can turn that path into a URL — it is shown below instead."
            : "The server did not return this mockup. It is still on disk at the path below."}
        </div>
      )}

      {/*
       * ONE ROW: THE SECTION, AND ITS STATE IF IT HAS ONE.
       *
       * The capture time and the path were both here and both came off. Five
       * mockups are written in one batch, so five timestamps a second apart are
       * noise on a card whose whole job is a visual comparison; and the path is
       * carried in full, with a copy button, by the screenshots panel further
       * down the same page — where a mockup already appears, because a mockup IS
       * a screenshot. Nothing was lost from the page, and the card now reads at a
       * glance.
       */}
      {zoomed && src !== null && (
        <Lightbox
          src={src}
          alt={`Design mockup of the ${section} section`}
          caption={section}
          onClose={() => setZoomed(false)}
        />
      )}

      <figcaption className="flex min-w-0 items-center justify-between gap-2 border-t border-line px-2.5 py-2">
        <span className="min-w-0 truncate text-[13px] text-ink" title={section}>
          {section}
        </span>
        {locked ? (
          <Badge tone={lockedTone} className="shrink-0">
            locked
          </Badge>
        ) : pendingChoice ? (
          <span className="shrink-0 text-[11px] text-accent">Locking…</span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */

const SUBTITLE: Readonly<Record<DesignLockPhase, string>> = {
  pending:
    "One of these is built and graded against. Pick it, or let the window close and ui-designer picks.",
  closing: "The window closed. Re-reading the run to see which design was locked.",
  settled: "The design this run was built to, and graded against.",
  unlocked: "The DESIGN lane finished without a design to lock.",
};

/**
 * Where a paragraph break belongs in a string nobody formatted.
 *
 * `ui-designer` writes `reason` as prose, and on the recorded run that is one
 * 480-character sentence chained with semicolons and parentheses. Split on sentence
 * ends only — `. ` followed by a capital — which is the one break that cannot invent
 * structure the author did not write. A semicolon split reads better and would be
 * this component deciding where the argument turns, which is not its call.
 *
 * The lookbehind is deliberately narrow so `ui-designer.` or `01-hero.png` cannot
 * open a paragraph: it requires whitespace after the stop and a capital after that.
 */
function paragraphs(reason: string): readonly string[] {
  return reason
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The chooser's verbatim reason: clamped, with an unfold that shows all of it.
 *
 * WHY IT IS CLAMPED RATHER THAN JUST WRAPPED. This panel is DOCKED over the canvas
 * and capped (132px, 200px above 900px) precisely so a settled record cannot cover
 * the graph — a cap that was added after an unconstrained version covered it
 * completely. So the text cannot simply be allowed to run: the fix for the wall of
 * text must not reintroduce the takeover the cap exists to prevent.
 *
 * Hence three lines by default and a control that says how much more there is. The
 * owner asked for "a unfold button where i see the whole lot", so open state is the
 * WHOLE string — no second clamp, no inner scroll to hunt through.
 */
function ReasonBlock({ reason }: { reason: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const parts = paragraphs(reason);

  return (
    <div className="rounded-sm border-l-2 border-line-strong bg-canvas/40 pl-2.5 pr-2 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        ui-designer's recorded reason
      </p>
      <div
        className={cx(
          "mt-1 max-w-[68ch] space-y-1.5 text-[12px] leading-relaxed text-ink-dim",
          // `line-clamp` needs a single block to clamp, so the collapsed state
          // renders ONE paragraph; the split only applies once it is open.
          !open && "line-clamp-3",
        )}
      >
        {open ? (
          parts.map((part, index) => <p key={String(index)}>{part}</p>)
        ) : (
          <p>{reason}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className="mt-1.5 text-[11px] text-accent underline-offset-2 hover:underline"
      >
        {open
          ? "fold"
          : `unfold the whole reason${parts.length > 1 ? ` (${String(parts.length)} sentences)` : ""}`}
      </button>
    </div>
  );
}

export function DesignLockPanel({
  run,
  busy,
  onChoose,
  onRefresh,
}: {
  run: RunDetail;
  busy: boolean;
  onChoose: (path: string) => void;
  onRefresh: () => void;
}): ReactNode {
  const lock = run.designLock;
  const phase = lock === null ? null : designLockPhase(run.status, lock);

  const [choosing, setChoosing] = useState<string | null>(null);
  // The sanctioned adjust-during-render pattern, as in `RateLimitNotice`: the
  // in-flight card clears when the request settles, without a frame of stale
  // "Locking…" that an effect would cost.
  if (!busy && choosing !== null) setChoosing(null);

  // The card reports WHICH path is in flight; the page owns whether anything is.
  const choose = useCallback(
    (path: string): void => {
      setChoosing(path);
      onChoose(path);
    },
    [onChoose],
  );

  /*
   * THE ONE REFETCH THIS COMPONENT ASKS FOR, and the window it closes.
   *
   * When the timeout fires, the server locks automatically and moves the run to
   * `queued`. `queued` is neither terminal nor stalled, so `useLiveRun` does not
   * reconcile against REST on it — the poll does, up to 15 seconds later. Until
   * then the cached lock still reads `{awaiting: true, locked: null}`, which is
   * byte-identical to a lane that produced nothing to lock. Asking once, on the
   * transition, is what keeps those two apart on screen.
   */
  useEffect(() => {
    if (phase === "closing") onRefresh();
  }, [phase, onRefresh]);

  if (lock === null || phase === null) return null;

  const chosen = lockedMockup(lock);
  const chooser = chooserOf(lock.lockedBy);
  const pending = phase === "pending";

  return (
    <Panel
      title="Design lock"
      subtitle={SUBTITLE[phase]}
      actions={
        phase === "settled" ? (
          <Badge tone={chooser.tone}>{chooser.badge}</Badge>
        ) : phase === "unlocked" ? (
          <Badge tone="warn">nothing locked</Badge>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      <div className="space-y-3 px-3 py-3">
        {phase === "pending" && (
          <p className="max-w-[68ch] text-[12px] leading-relaxed text-ink-dim">
            Every build agent is given the locked mockup, and the visual gate grades the
            finished site against it rather than against the set. Choosing is not required:
            if the window closes first, ui-designer picks and the run records that the pick
            was automatic.
          </p>
        )}

        {phase === "settled" && (
          <div className="space-y-2">
            <p className="max-w-[68ch] text-[12px] leading-relaxed text-ink-dim">
              {chooser.sentence}
            </p>
            {/*
             * THE VERBATIM REASON IS SHOWN FOR `ui-designer` ONLY, and that is
             * not the record being hidden. §17.3 rule 4's "why" reaches the
             * screen in every case — as the sentence just above it. What differs
             * is WHO WROTE THE STRING: for an owner click and for a fallback the
             * HOST composes it ("chosen by the owner in the dashboard", "…the
             * first mockup in manifest order was locked automatically, with no
             * judgement applied"), so printing it verbatim restates the sentence
             * word for word and dresses a host-composed string as testimony.
             * `ui-designer`'s comes out of the choice file it wrote and is the
             * only one carrying a judgement the page does not already make.
             *
             * IT IS NO LONGER INLINED INTO THE SENTENCE ABOVE. It was
             * `{chooser.sentence} <span>Recorded reason: {lock.reason}</span>` in one
             * `<p>`, and on the real run that string is 480 characters of
             * semicolon-joined clauses. Run together with the host's own sentence and
             * clipped by the dock's 132px cap it came out as a wall of grey text
             * ending mid-word — the owner's words were "either too much text or its
             * formated poorly causing it to be just a wall of text".
             */}
            {lock.reason !== null && lock.lockedBy === "ui-designer" && (
              <ReasonBlock reason={lock.reason} />
            )}
          </div>
        )}

        {phase === "unlocked" && (
          <p className="max-w-[68ch] text-[12px] leading-relaxed text-ink-dim">
            No mockup was locked, so the visual gate fell back to its rule-based floor. This
            run was graded without a reference design — which is a weaker judgement, not a
            failing one.
          </p>
        )}

        {/*
         * BETWEEN THE EXPLANATION AND THE DECK, pointing into the first card:
         * the run arrived here and stopped. Above the prose it read as a stray
         * mark; spanning the panel it read as a dotted rule.
         */}
        <LockConnector flowing={pending} />

        {lock.mockups.length === 0 ? (
          <EmptyState>
            The DESIGN lane recorded no mockups on this run. Nothing here is missing from the
            page; there was nothing to publish.
          </EmptyState>
        ) : (
          <ul className="grid list-none grid-cols-[repeat(auto-fit,minmax(212px,1fr))] gap-3">
            {lock.mockups.map((shot) => (
              <li key={`${shot.path}:${shot.capturedAt}`} className="flex min-w-0">
                <MockupCard
                  shot={shot}
                  runId={run.runId}
                  locked={chosen !== null && isPublishedAs(shot.path, chosen.path)}
                  lockedTone={chooser.tone}
                  onChoose={pending ? choose : null}
                  pendingChoice={choosing === shot.path}
                  disabled={busy}
                />
              </li>
            ))}
          </ul>
        )}

        {/*
         * A LOCK WHOSE CARD IS NOT ON THIS PAGE IS SAID OUT LOUD. `locked` is the
         * workspace ref and the cards are its published copies; when no copy
         * matches, distinguishing nothing would read as "no design was locked",
         * which is the opposite of what the record says.
         */}
        {phase === "settled" && chosen === null && lock.locked !== null && (
          <p className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
            The locked design is not among the mockups published for this run:
            <MonoPath path={lock.locked} max={56} />
          </p>
        )}
      </div>
    </Panel>
  );
}

/* Re-exported so the page can place the panel by phase without a second import. */
export { designLockPhase };
