"use client";

/* eslint-disable @next/next/no-img-element -- the same reason `design-lock.tsx`
   and `screenshots.tsx` give: mockup locations come from the backend at runtime
   and may not be HTTP at all, so `next/image`'s configured loader and known
   remote host do not apply. A plain <img> with an explicit error fallback is the
   honest primitive. */

/**
 * design-directions.tsx — the one decision on this run the owner cannot undo,
 * shown as a comparison rather than as a file listing.
 *
 * ─── WHAT THIS REPLACES, AND WHY IT WAS THE WRONG QUESTION ───
 *
 * Before the canvass, the DESIGN lane rendered SEVEN SECTIONS OF ONE DIRECTION
 * (`design-01-hero.png … design-07-contact.png`, measured on the last real run)
 * and the park asked the owner to pick a "mockup". The pick decided which still
 * the visual gate would grade against — not which design would be built. The
 * owner's own question is what named the gap: "will it give me design
 * alternatives of the image I sent if I ask?" The answer was no, and the panel
 * implied yes.
 *
 * So stage A offers DISTINCT DIRECTIONS, each rendering the SAME small set of
 * sections at the SAME aspect, and this component's whole job is making them
 * comparable: like against like, at a size where a type scale can be judged,
 * with the one sentence that says what each does differently.
 *
 * ─── THREE COLUMNS DO NOT FIT IN A 360px DOCK, SO THE COMPARISON IS A LAYER ───
 *
 * The run page's HUD is `w-[min(360px,calc(100vw-32px))]`; three directions in
 * it are 110px each, which is the thumbnail strip the brief rules out by name.
 * The deck is therefore ONE component rendered in two places — `auto-fit` at
 * `minmax(250px,1fr)` stacks it to a single readable column in the dock and
 * fans it out side by side in the layer — and the layer OPENS ITSELF ONCE per
 * park, because a decision the run is stopped on cannot be behind a click. It
 * closes three ways (×, backdrop, Escape) and reopens from the dock, because a
 * layer that will not get out of the way of the canvas is a second complaint.
 *
 * ─── ZOOM STATE IS LIFTED, AND THAT IS NOT A STYLE CHOICE ───
 *
 * `Lightbox` closes itself on Escape through a `window` listener. The layer
 * needs Escape too, so with both listening, one keypress would close the still
 * AND the chooser under it — the owner asks for his image back and loses the
 * comparison. The container owns which still is zoomed, so its own handler can
 * consume the key: zoomed first, layer second, one step per press.
 *
 * ─── AND THE LIMIT IS ON SCREEN, WHERE HE IS TYPING ───
 *
 * The acceptance tests were written and locked in the `spec` phase, which is over
 * before this park opens. Asking here changes what gets BUILT and what the build
 * is compared against VISUALLY; it changes nothing about what counts as done.
 * That sentence sits against the reply box rather than in this docblock, because
 * an owner who asks for a whole new page at this point is asking for something
 * the run will never check.
 *
 * ─── 2026-08-05: 145 WORDS OF EXPLANATION CAME OFF THIS FILE ───
 *
 * The owner's ask was "If something really must have a explanation it should have
 * little i icon", and the two words he named as meaningless are on this surface:
 * "suite" and "freeze". What each paragraph became is recorded at its own call
 * site; the two rules the whole pass followed are here.
 *
 * A FACT THAT CHANGES WHAT HE DOES MAY BE HIDDEN AND MAY NOT BE DELETED. The one
 * sentence in this file that survives at reading size is the ask limit, because
 * he reads it while spending a capped, unrecoverable render. Everything that
 * described a CONSEQUENCE of a click he has not made yet is gone.
 *
 * ONE VERB FOR THE VISUAL COMPARISON, shared with `design-lock.tsx`: "compared
 * against". "The visual gate grades the finished site" was the internal name for
 * the same mechanism, and a screen that uses both names for it is worse than one
 * that uses the jargon twice.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { DesignDirectionState, DesignLockState, Screenshot } from "@/lib/api-types";
import {
  composeDesignRequest,
  designCountdown,
  requestOutcome,
  type DesignParkClock,
} from "@/lib/design-directions";
import { formatTimeOnly } from "@/lib/format";
import { countOf, directionsOf, isPublishedAs, mockupSection, requestsOf } from "@/lib/mockups";
import { screenshotSrc } from "@/lib/screenshots";
import { Explain } from "@/components/explain";
import { Badge, Button, Lightbox, MonoPath, cx } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* Glyphs — inline SVG at the 1.5 stroke weight the rest of the app uses */
/* ------------------------------------------------------------------ */

/**
 * Copied from `plan-dialogue.tsx` rather than imported, for that file's own
 * stated reason: this app ships no icon package, and the two marks are not worth
 * a shared module that would have to import a component tree either way.
 */
function ClockGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

/** Two panes side by side: the comparison, as a mark. */
function CompareGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3.5" width="4.5" height="9" rx="1" />
      <rect x="9.5" y="3.5" width="4.5" height="9" rx="1" />
    </svg>
  );
}

function CloseGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* THE ONE SENTENCE THAT STAYS AT READING SIZE                         */
/* ------------------------------------------------------------------ */

/**
 * The limit on what asking here can do — REQUIRED COPY, not a caption this
 * component may reword away. It exists so the owner cannot come to believe that
 * what he asks for here is what the run will be judged on.
 *
 * RENAMED AND REWRITTEN 2026-08-05, from `FROZEN_SUITE_SENTENCE`. It read: "The
 * acceptance suite was frozen in the spec phase. What you ask for here changes
 * what gets built and what the build is compared against visually — it does not
 * change what counts as done." Two of the owner's named-as-meaningless words
 * ("suite", "frozen") in the first clause, thirty-two words, and only the second
 * half was about anything he could act on. What survives is the operative half.
 *
 * WHAT THE FIRST CLAUSE CARRIED AND WHERE IT WENT: NOWHERE. That the tests were
 * written in an earlier phase is the REASON asking cannot move them, and a reason
 * does not change what he types — the limit itself does. It was deleted rather
 * than put behind an `i`, which this app's `Explain` docblock asks for by name:
 * "an `i` is not cheaper than deleting".
 *
 * THE SERVER STILL SAYS THE LONG ONE. `server/src/design-dialogue.ts`'s
 * `DESIGN_FROZEN_SUITE_NOTICE` is appended to the park's chat message and to
 * every rendered answer, so the old wording — "suite", "frozen" and all — is
 * still on screen in the transcript. That file is another lane's; the divergence
 * is deliberate and reported rather than silently mirrored here.
 */
export const ASK_LIMIT_SENTENCE =
  "Asking here changes what gets built, not what counts as done.";

/* ------------------------------------------------------------------ */
/* One direction                                                       */
/* ------------------------------------------------------------------ */

/** The stills of one direction, in the order the server published them. */
export function shotsFor(
  direction: DesignDirectionState,
  mockups: readonly Screenshot[],
): readonly Screenshot[] {
  const wanted = new Set(direction.mockups);
  return mockups.filter((shot) => wanted.has(shot.path));
}

function DirectionStill({
  shot,
  runId,
  onZoom,
  locked = false,
}: {
  shot: Screenshot;
  runId: string;
  onZoom: (shot: Screenshot) => void;
  /**
   * THE ONE CANONICAL STILL, and its meaning is unchanged by the two stages:
   * this is what the visual gate grades the finished site against. It is set at
   * the END of the expansion, on the chosen direction's hero, and nothing about
   * the canvass repurposes the field.
   */
  locked?: boolean;
}): ReactNode {
  const src = screenshotSrc(runId, shot.path);
  const [failed, setFailed] = useState(false);
  const section = mockupSection(shot.label);

  if (src === null || failed) {
    return (
      <div className="flex h-[120px] items-center justify-center border-t border-line bg-canvas px-3 text-center text-[11px] leading-snug text-ink-faint">
        {/*
         * WHICH OF THE TWO HAPPENED IS KEPT; WHY IT HAPPENED IS NOT. "Nothing
         * here can turn that path into a URL" described this app's own plumbing
         * to someone looking at a missing picture.
         */}
        {src === null
          ? "This image is on disk and cannot be shown here."
          : "The server did not return this image. It is on disk."}
      </div>
    );
  }

  return (
    <figure className="min-w-0 border-t border-line">
      {/*
       * NATURAL ASPECT, FULL WIDTH, NO CROP — the point of the whole panel. The
       * old mockup card is `h-[156px] object-cover object-top`: right for telling
       * five sections of ONE design apart, useless for judging a type scale,
       * because a 156px letterbox of a hero is a strip of headline with nothing
       * to compare it against.
       *
       * A COLUMN OF THESE IS TALLER THAN THE VIEWPORT and that is why the choose
       * button is in the card's HEAD rather than its foot — measured at 1440x900
       * against the one recorded run's real stills, two at natural aspect make an
       * 800px column, which put all three primary buttons below the fold of a
       * layer whose entire job is offering the choice. Cropping the stills to fit
       * was the other candidate and it loses the thing being compared.
       */}
      {/*
       * "still" IS GONE FROM EVERY LABEL A READER MEETS. It is the word this
       * file's own author used for one rendered image, and it reads as a verb
       * first — "The server did not return this still. It is still on disk" was
       * on screen. `mockup`/`image` costs nothing and is what he is looking at.
       */}
      <button
        type="button"
        onClick={() => onZoom(shot)}
        aria-label={`Enlarge the ${section} mockup`}
        className="block w-full cursor-zoom-in"
      >
        <img
          src={src}
          alt={`${section} mockup`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="block h-auto w-full bg-canvas"
        />
      </button>
      <figcaption className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-ink-faint">
        <span className="min-w-0 truncate">{section}</span>
        {locked && (
          <Badge tone="accent" className="shrink-0">
            locked
            {/*
             * THE FACT THAT USED TO BE A `title` ON THIS BADGE, and a paragraph
             * in `design-lock.tsx` besides ("The hero of that direction is the
             * one still the visual gate graded the finished site against"). Both
             * are this one sentence, attached to the image it is about, reachable
             * by keyboard and on touch — which `title` never was.
             */}
            {/* No `ml-1`: `Badge` is an inline-flex with its own `gap-1.5`. */}
            <Explain about="the locked image" testId="explain-locked-image">
              The finished site was compared against this one image.
            </Explain>
          </Badge>
        )}
      </figcaption>
    </figure>
  );
}

function DirectionCard({
  direction,
  ordinal,
  runId,
  shots,
  state,
  onChoose,
  choosing,
  disabled,
  onZoom,
  lockedPath,
}: {
  direction: DesignDirectionState;
  /** 1-based, and it is addressable: the owner may say "3" in the reply box. */
  ordinal: number;
  runId: string;
  shots: readonly Screenshot[];
  /** `DesignLockState.locked` — the WORKSPACE ref, matched with `isPublishedAs`. */
  lockedPath: string | null;
  /** `open` while the canvass is unanswered; then one of the two outcomes. */
  state: "open" | "chosen" | "discarded";
  /** Null outside the open canvass — a settled deck renders NO button, not a disabled one. */
  onChoose: ((slug: string) => void) | null;
  choosing: boolean;
  disabled: boolean;
  onZoom: (shot: Screenshot) => void;
}): ReactNode {
  return (
    <article
      data-testid={`design-direction-${direction.slug}`}
      className={cx(
        "flex min-w-0 flex-col overflow-hidden rounded border bg-surface-raised transition-[border-color,opacity] duration-200",
        state === "chosen"
          ? "border-accent/60 shadow-[0_0_0_1px_var(--color-accent-dim),0_10px_28px_-18px_var(--color-accent)]"
          : state === "discarded"
            ? "border-line opacity-70"
            : "border-line-strong",
      )}
    >
      <header className="flex min-w-0 items-start gap-2 px-2.5 py-2">
        <span className="numeric mt-[2px] text-[10px] font-semibold tracking-[0.08em] text-ink-faint">
          {String(ordinal).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-medium leading-tight text-ink" title={direction.name}>
            {direction.name}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{direction.distinction}</p>
        </div>
        {/*
         * "chosen", NOT "building this", AND THE ASYMMETRY WITH "not built" IS
         * DELIBERATE. `state` cannot tell stage B from a settled run — both are
         * `chosen` — so "building this" was already wrong twice: during the
         * expansion nothing is being built yet (sections are still rendering),
         * and on a finished run it was built, past tense. "chosen" is true in
         * both, and "not built" opposite it is true in both as well.
         *
         * The `title` on "not built" said "Offered, and not built. The run was
         * never graded against it" — a tooltip restating the two words under the
         * pointer.
         */}
        {state === "chosen" && (
          <Badge tone="accent" className="shrink-0">
            chosen
          </Badge>
        )}
        {state === "discarded" && (
          <Badge tone="neutral" className="shrink-0">
            not built
          </Badge>
        )}
      </header>

      {onChoose !== null && (
        /*
         * THE DECISION SITS WITH THE NAME IT NAMES, AND ABOVE THE EVIDENCE.
         *
         * It was at the foot of the card first, which reads better on paper —
         * look, then decide — and was measured off the bottom of the layer: a
         * column of full-aspect stills is taller than a laptop viewport, so all
         * three primary buttons were behind a scroll on the one screen whose job
         * is offering the choice. Here every direction's control is visible at
         * once, at the same height, and the stills are the argument underneath.
         */
        <div className="px-2.5 pb-2">
          {/*
           * THE `title` CAME OFF, NOT THE FACT. It was 28 words on hover — "The
           * rest of the sections are rendered in this direction, and the build is
           * made to it. The others are kept as a record of what was offered" —
           * repeated identically on all three buttons, invisible to a keyboard
           * and to touch. Its first half is behind the `i` on the panel's own
           * instruction line (`design-lock.tsx`, "picking a direction") and, in
           * the comparison layer, on the heading above these cards. Its second
           * half is the `not built` badge those two cards carry afterwards.
           */}
          <Button
            variant="primary"
            className="w-full justify-center"
            disabled={disabled}
            onClick={() => onChoose(direction.slug)}
          >
            {choosing ? "choosing…" : `Build in the ${direction.name} direction`}
          </Button>
        </div>
      )}

      {shots.length > 0 ? (
        shots.map((shot) => (
          <DirectionStill
            key={shot.path}
            shot={shot}
            runId={runId}
            onZoom={onZoom}
            locked={lockedPath !== null && isPublishedAs(shot.path, lockedPath)}
          />
        ))
      ) : (
        /*
         * THE DEGRADED RUN, AND IT IS A FIRST-CLASS RENDERING RATHER THAN AN
         * EMPTY STATE. With no image key the lane writes art direction instead of
         * stills, so this direction has a document and no picture — and a panel
         * that only draws directions when there are images shows the owner of
         * that machine nothing to choose from at all.
         */
        <div className="space-y-1.5 border-t border-line px-2.5 py-2">
          <p className="text-[11.5px] leading-relaxed text-ink-dim">
            Written art direction, no pictures: image generation was not available on this run.
          </p>
          {direction.notes !== null && <MonoPath path={direction.notes} max={44} />}
        </div>
      )}

    </article>
  );
}

/* ------------------------------------------------------------------ */
/* The deck                                                            */
/* ------------------------------------------------------------------ */

export function DirectionDeck({
  lock,
  runId,
  choosable,
  onChoose,
  choosing,
  busy,
  onZoom,
  minColumn = 250,
}: {
  lock: DesignLockState;
  runId: string;
  /** True only while the canvass is open AND the run is still parked on it. */
  choosable: boolean;
  onChoose: (slug: string) => void;
  /** The slug whose choice is in flight, or null. */
  choosing: string | null;
  busy: boolean;
  onZoom: (shot: Screenshot) => void;
  /** The column floor. 250 stacks in the 360px dock; 320 fans out in the layer. */
  minColumn?: number;
}): ReactNode {
  const directions = directionsOf(lock);
  const chosen = lock.chosenDirection;

  /*
   * MANIFEST ORDER WHILE THE CANVASS IS OPEN, CHOSEN FIRST ONCE IT IS ANSWERED.
   *
   * During the canvass no direction is privileged and the order is the lane's
   * own; re-sorting it would be this component recommending one. Afterwards the
   * question has changed — the reader is looking at a record — and leading with
   * a column badged "not built" puts a design the run was never graded against
   * at the top of the panel that says what the run was built to.
   *
   * THE ORDINAL DOES NOT MOVE WITH THE CARD. It is the number the owner may have
   * typed into the reply box, so it stays bound to the manifest index.
   */
  const ordered =
    chosen === null || chosen === undefined
      ? directions.map((direction, index) => ({ direction, ordinal: index + 1 }))
      : directions
          .map((direction, index) => ({ direction, ordinal: index + 1 }))
          .sort((left, right) =>
            left.direction.slug === chosen ? -1 : right.direction.slug === chosen ? 1 : 0,
          );

  return (
    <div
      className="grid list-none gap-2.5"
      style={{ gridTemplateColumns: `repeat(auto-fit,minmax(${String(minColumn)}px,1fr))` }}
    >
      {ordered.map(({ direction, ordinal }) => (
        <DirectionCard
          key={direction.slug}
          direction={direction}
          ordinal={ordinal}
          runId={runId}
          shots={shotsFor(direction, lock.mockups)}
          lockedPath={lock.locked}
          state={
            chosen === null || chosen === undefined
              ? "open"
              : direction.slug === chosen
                ? "chosen"
                : "discarded"
          }
          onChoose={choosable ? onChoose : null}
          choosing={choosing === direction.slug}
          disabled={busy || choosing !== null}
          onZoom={onZoom}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long the park has left, and what happens at the end of it.
 *
 * THE CONSEQUENCE IS STATED WHETHER OR NOT THERE IS A NUMBER, which is the same
 * rule `PlanClock` follows and matters more here: the number comes off the run's
 * own log line (`lib/design-directions.ts`), so a rewording on the server leaves
 * this clock silent — and "ui-designer picks and the run carries on" is a
 * property of the park, not of the parsing.
 *
 * IT DOES NOT RESET ON RELOAD, and that is the server's doing rather than this
 * component's: the park is re-armed for the REMAINDER of the original window
 * across a restart, and the log line replays with its original instant.
 */
function ParkClock({ clock, nowMs }: { clock: DesignParkClock; nowMs: number }): ReactNode {
  const countdown = designCountdown(clock.deadlineMs, nowMs);

  return (
    <div className="flex items-start gap-2 rounded-sm border border-info/25 bg-info-dim/40 px-2 py-1.5">
      <span className="mt-[1px] text-info">
        <ClockGlyph />
      </span>
      <div className="min-w-0">
        {countdown !== null && (
          <p className="text-[12px] font-medium text-info">
            {countdown.kind === "closing" ? (
              "The window has closed — it is choosing now."
            ) : (
              <>
                <span className="numeric">
                  {countdown.minutes < 1 ? "under 1" : String(countdown.minutes)}
                </span>{" "}
                {countdown.minutes === 1 ? "minute" : "minutes"} left
                {clock.windowMin !== null && (
                  <span className="font-normal text-ink-faint">
                    {" "}
                    of {String(clock.windowMin)}
                  </span>
                )}
              </>
            )}
          </p>
        )}
        {/*
         * KEPT INLINE, HALVED. It is the consequence of the countdown beside it,
         * and a reader who misses it does not know he can walk away — that is the
         * "before acting, cannot recover" case. What came off was the second
         * half: "its reason is recorded here — not a failure, and not something
         * you have to answer" is reassurance about a thing that has not happened,
         * and the record it promises is drawn by `design-lock.tsx` afterwards
         * whether or not this sentence said so.
         */}
        <p className={cx("text-[11px] leading-relaxed text-ink-dim", countdown !== null && "mt-0.5")}>
          If you do nothing, ui-designer picks and the run carries on.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Asking for more before committing                                   */
/* ------------------------------------------------------------------ */

/**
 * What the owner has already asked for, and what came back.
 *
 * A REFUSAL IS SHOWN AS LOUDLY AS A RENDER. Each request costs a turn whatever
 * it contained and a render whenever one was attempted, so an ask that produced
 * nothing is the case he most needs to see — finding out by being ignored is the
 * failure this list exists to prevent.
 */
function RequestLog({ lock, runId, onZoom }: {
  lock: DesignLockState;
  runId: string;
  onZoom: (shot: Screenshot) => void;
}): ReactNode {
  const requests = requestsOf(lock);
  if (requests.length === 0) return null;

  const byPath = new Map(lock.mockups.map((shot) => [shot.path, shot] as const));

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        what you asked for
      </p>
      <ul className="space-y-1.5">
        {requests.map((request, index) => {
          const outcome = requestOutcome(request.outcome);
          const shot = request.mockup === null ? undefined : byPath.get(request.mockup);
          return (
            <li
              key={`${request.at}:${String(index)}`}
              className={cx(
                "rounded-sm border px-2 py-1.5",
                outcome.refused ? "border-warn/30 bg-warn-dim/30" : "border-line bg-surface-raised",
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[12px] text-ink">{request.section}</span>
                <span className="text-[11px] text-ink-faint">in {request.direction}</span>
                <span className="numeric ml-auto text-[10px] text-ink-faint">
                  {formatTimeOnly(request.at)}
                </span>
              </div>
              <p
                className={cx(
                  "mt-0.5 text-[11px] leading-relaxed",
                  outcome.refused ? "text-warn" : "text-ink-dim",
                )}
              >
                {outcome.label}
                {request.detail.trim() !== "" && (
                  <span className="text-ink-faint"> — {request.detail}</span>
                )}
              </p>
              {shot !== undefined && (
                <div className="mt-1.5 overflow-hidden rounded-sm border border-line">
                  {/*
                   * MARKED AS SOMETHING HE ASKED FOR rather than something the
                   * lane offered — the manifest keeps that distinction on disk
                   * (`origin: "requested"`) and losing it here would let a
                   * commissioned still read as part of the canvass.
                   */}
                  <p className="border-b border-line bg-canvas/60 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                    you asked for this one
                  </p>
                  <DirectionStill shot={shot} runId={runId} onZoom={onZoom} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The reply box: a named section, in a named direction, before he commits.
 *
 * IT COMPOSES THE STRING AND SHOWS IT. `plan-dialogue.tsx`'s rule, for the same
 * measured reason: the server parses the message, a message that names neither a
 * section nor a direction is NOT claimed by the design dialogue, and an
 * unclaimed message stays pending for the next segment boundary — sent, free,
 * and answering nothing. Addressing the direction by SLUG removes the one part
 * of that parse this side could get wrong.
 *
 * BOTH CAPS ARE ON SCREEN AS THEY ARE SPENT, and the exhausted state says so in
 * words. He is spending image generations on a parked run; finding that out by
 * being refused is the wrong way round.
 */
function RequestBox({
  lock,
  sending,
  onSend,
}: {
  lock: DesignLockState;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
}): ReactNode {
  const directions = directionsOf(lock);
  const [section, setSection] = useState("");
  const [slug, setSlug] = useState<string>(directions[0]?.slug ?? "");
  const [error, setError] = useState<string | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);

  const turnsUsed = countOf(lock.turnsUsed);
  const turnsMax = countOf(lock.turnsMax);
  const rendersUsed = countOf(lock.rendersUsed);
  const rendersMax = countOf(lock.rendersMax);
  const turnsLeft = Math.max(0, turnsMax - turnsUsed);
  const rendersLeft = Math.max(0, rendersMax - rendersUsed);
  const spent = turnsLeft === 0 || rendersLeft === 0;

  const chosenSlug = directions.some((direction) => direction.slug === slug)
    ? slug
    : (directions[0]?.slug ?? "");
  const body = section.trim() === "" || chosenSlug === "" ? null : composeDesignRequest(section, chosenSlug);

  const submit = useCallback((): void => {
    if (body === null || sending || spent) return;
    setError(null);
    void onSend(body).then((ok) => {
      if (ok) {
        setSection("");
        setSentFor(body);
      } else {
        // "the box still has what you typed" described the box he is looking at.
        setError("That did not go through. Nothing was spent.");
      }
    });
  }, [body, onSend, sending, spent]);

  return (
    <div className="space-y-2 rounded-sm border border-line-strong bg-canvas/40 px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        ask for another section before you choose
      </p>

      {spent ? (
        /*
         * SAID PLAINLY, NOT ENFORCED SILENTLY. The server refuses past either cap
         * and records the refusal against a turn; a box that still looked live
         * would spend his last turn telling him it was his last turn.
         */
        <p className="text-[12px] leading-relaxed text-warn">
          {rendersLeft === 0
            ? "No renders left — pick one of the directions above."
            : "No turns left — pick one of the directions above."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={section}
              onChange={(event) => setSection(event.target.value.slice(0, 120))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              aria-label="The section to render"
              placeholder="the contact page"
              className="min-w-0 flex-1 rounded-sm border border-line bg-canvas px-2 py-1 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
          </div>

          {/*
           * A TOGGLE ROW RATHER THAN A DROPDOWN, matching `roster.tsx`'s
           * `aria-pressed` precedent: three options, all of them worth reading,
           * and the one that is selected has to be visible while he is typing the
           * section — which a collapsed `<select>` is, and a native option list
           * over a dark console is not.
           */}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Which direction to render it in">
            {directions.map((direction, index) => (
              <button
                key={direction.slug}
                type="button"
                aria-pressed={direction.slug === chosenSlug}
                onClick={() => setSlug(direction.slug)}
                className={cx(
                  "rounded-sm border px-1.5 py-[2px] text-[11px] transition-colors",
                  direction.slug === chosenSlug
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : "border-line bg-surface-raised text-ink-dim hover:border-line-strong hover:text-ink",
                )}
              >
                <span className="numeric mr-1 text-ink-faint">{String(index + 1)}</span>
                {direction.name}
              </button>
            ))}
          </div>

          {body !== null && (
            <p className="truncate font-mono text-[11px] text-ink-faint" title={body}>
              sends: {body}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={submit} disabled={body === null || sending}>
              {sending ? "asking…" : "ask for it"}
            </Button>
            {/*
             * BOTH CAPS, BOTH PHRASED AS WHAT IS LEFT. "3 of 4 turns" alone reads
             * as three spent; every number on this line is a remainder, and the
             * word is repeated rather than shared so neither can be misread.
             */}
            <span className="numeric text-[11px] text-ink-faint">
              {String(rendersLeft)} of {String(rendersMax)} renders left ·{" "}
              {String(turnsLeft)} of {String(turnsMax)} turns left
            </span>
          </div>

          {sentFor !== null && (
            // "the run stays parked meanwhile" answered a worry the panel around
            // it already answers: the countdown is still running above this box.
            <p className="text-[10.5px] leading-relaxed text-accent">
              Sent. The picture appears above when it is ready.
            </p>
          )}
          {error !== null && <p className="text-[11px] text-fail">{error}</p>}
        </>
      )}

      {/*
       * THE HONEST LIMIT, WHERE HE IS TYPING, AND THE ONE PARAGRAPH ON THIS
       * SURFACE THAT WAS NOT ALLOWED BEHIND THE `i`. He is about to spend one of
       * a capped, unrecoverable number of renders — "5 of 6 renders left" is on
       * the line above — and the distinction between "what gets built" and "what
       * counts as done" is what stops him spending it on a whole new page the run
       * will never check. Both halves are still here; only the clause about WHEN
       * the tests were written came off (see `ASK_LIMIT_SENTENCE`).
       */}
      <p className="text-[10.5px] leading-relaxed text-ink-faint">{ASK_LIMIT_SENTENCE}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The comparison layer                                                */
/* ------------------------------------------------------------------ */

/**
 * The deck, big, over everything — a portal for `Lightbox`'s measured reason:
 * `z-50` inside the HUD's `z-10` stacking context loses to the shell header, so
 * anything that must cover the page is mounted on `document.body`.
 */
function ChooserLayer({
  children,
  footer,
  onClose,
  onEscape,
}: {
  children: ReactNode;
  /**
   * PINNED UNDER THE SCROLL, NOT INSIDE IT, and that is not a layout preference.
   * The reply box carries the frozen-suite sentence and both caps, and measured
   * in the browser at 1440x900 the deck alone is taller than the viewport — so
   * inside the scroll, the one paragraph saying what asking here does NOT change
   * sits below the fold on the screen where he is being invited to ask.
   */
  footer: ReactNode;
  onClose: () => void;
  /** Returns true when it consumed the key — a zoomed still closes before the layer. */
  onEscape: () => boolean;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (onEscape()) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onEscape]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a design direction"
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/92 p-4 backdrop-blur-sm sm:p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-[1180px] flex-col overflow-hidden rounded border border-line-strong bg-surface shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-medium leading-tight text-ink">
              Choose a design direction
            </h2>
            {/*
             * THE FIRST SENTENCE DESCRIBED THE SCREEN IT WAS ON. "3 directions,
             * each rendering the same sections at the same size, so you are
             * comparing like with like" — the reader is looking at three columns
             * of matching sections; the count is the `{n} directions` badge and
             * the sameness is the layout's whole point, visible at a glance.
             * What is left is the half he cannot see: what the click does.
             */}
            <p className="mt-1 max-w-[80ch] text-[12px] leading-relaxed text-ink-dim">
              The one you pick is expanded into the rest of its sections, and the site is built
              to it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the comparison"
            className="shrink-0 rounded-sm border border-line-strong bg-surface-raised p-1.5 text-ink-dim hover:border-ink-faint hover:text-ink"
          >
            <CloseGlyph />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">{children}</div>
        <div className="border-t border-line bg-surface px-4 py-3">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* What this module exports to `design-lock.tsx`                       */
/* ------------------------------------------------------------------ */

export function DesignCanvass({
  lock,
  runId,
  clock,
  nowMs,
  /** The canvass is open AND the run is still parked on it. */
  choosable,
  busy,
  onChooseDirection,
  onSendRequest,
}: {
  lock: DesignLockState;
  runId: string;
  clock: DesignParkClock;
  nowMs: number;
  choosable: boolean;
  busy: boolean;
  onChooseDirection: (slug: string) => void;
  /**
   * Posts one chat message. REJECTS when the server refused it, exactly as
   * `PlanDialoguePanel.onSend` does — a refused ask must keep the owner's words
   * in the box rather than look sent.
   */
  onSendRequest: (text: string) => Promise<void>;
}): ReactNode {
  const directions = directionsOf(lock);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [zoomed, setZoomed] = useState<Screenshot | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /*
   * THE LAYER OPENS ITSELF ONCE PER MOUNT — not once per park, which is what
   * this comment said until it was checked against the code. `armed` is
   * component state, so closing it keeps it closed for as long as the page
   * lives, and a RELOAD opens it again. That is the honest behaviour and it is
   * the one worth having: the run is still stopped on the decision, and nothing
   * here records what this reader has already seen.
   *
   * The sanctioned adjust-during-render pattern, as in `DesignLockPanel`: a
   * decision the run is stopped on cannot be behind a click, and an effect would
   * cost a frame of the dock's summary flashing past.
   */
  if (choosable && !armed) {
    setArmed(true);
    setOpen(true);
  }
  // The in-flight choice clears when the request settles, with no stale frame.
  if (!busy && choosing !== null) setChoosing(null);
  // A choice that landed ends the comparison: there is nothing left to compare.
  if (!choosable && open) setOpen(false);

  const choose = useCallback(
    (slug: string): void => {
      // THE ONE GUARD AGAINST A DOUBLE FIRE, checked here as well as on the
      // disabled attribute: a second click before React paints the disabled
      // state would post a second, different, irreversible choice.
      if (choosing !== null || busy) return;
      setChoosing(slug);
      onChooseDirection(slug);
    },
    [busy, choosing, onChooseDirection],
  );

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (sending) return false;
      setSending(true);
      try {
        await onSendRequest(text);
        return true;
      } catch {
        return false;
      } finally {
        setSending(false);
      }
    },
    [onSendRequest, sending],
  );

  const consumeEscape = useCallback((): boolean => {
    if (zoomed === null) return false;
    setZoomed(null);
    return true;
  }, [zoomed]);

  const deck = (
    <>
      {choosable && <ParkClock clock={clock} nowMs={nowMs} />}
      <DirectionDeck
        lock={lock}
        runId={runId}
        choosable={choosable}
        onChoose={choose}
        choosing={choosing}
        busy={busy}
        onZoom={setZoomed}
        minColumn={open ? 320 : 250}
      />
      <RequestLog lock={lock} runId={runId} onZoom={setZoomed} />
    </>
  );

  const ask = choosable ? <RequestBox lock={lock} sending={sending} onSend={send} /> : null;

  return (
    <div className="space-y-2.5">
      {open ? (
        <>
          <p className="flex items-center gap-2 rounded-sm border border-line bg-surface-raised px-2 py-1.5 text-[11.5px] text-ink-dim">
            <span className="text-accent">
              <CompareGlyph />
            </span>
            The directions are open over the canvas.
          </p>
          <ChooserLayer
            onClose={() => setOpen(false)}
            onEscape={consumeEscape}
            footer={ask}
          >
            {deck}
          </ChooserLayer>
        </>
      ) : (
        <>
          {choosable && (
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={() => setOpen(true)}
            >
              <CompareGlyph />
              compare the {String(directions.length)} directions side by side
            </Button>
          )}
          {deck}
          {ask}
        </>
      )}

      {zoomed !== null && (
        <ZoomedStill runId={runId} shot={zoomed} onClose={() => setZoomed(null)} />
      )}
    </div>
  );
}

/**
 * The zoomed still, resolved to a URL at the last moment.
 *
 * SEPARATE FROM `DirectionStill` because the zoom state is LIFTED — see this
 * file's header: with `Lightbox` closing itself on Escape and the layer doing
 * the same, one keypress would close both.
 */
function ZoomedStill({
  runId,
  shot,
  onClose,
}: {
  runId: string;
  shot: Screenshot;
  onClose: () => void;
}): ReactNode {
  const src = screenshotSrc(runId, shot.path);
  if (src === null) return null;
  const section = mockupSection(shot.label);
  // `mockup`, like every other label on this surface — see `DirectionStill`.
  return <Lightbox src={src} alt={`${section} mockup`} caption={section} onClose={onClose} />;
}
