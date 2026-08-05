"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cx } from "./ui";

/**
 * explain.tsx — the one "i" this app has, and the rule for what goes behind it.
 *
 * THE OWNER'S ASK, VERBATIM, 2026-08-04: "are you also clearning up these long
 * explanations for everything. These are through the app. They explain
 * everything. If something really must have a explanation it should have little
 * i icon to when i hover over it brings it up".
 *
 * WHAT WAS THERE. Roughly 1,700 words of permanent explanatory prose across
 * eighteen components — 239 in the design lock, 202 in the sheet, 145 in the
 * design directions, 117 under the chat composer. Two paragraphs sat under the
 * send button forever, explaining what happens to a message AFTER it is sent.
 * The Result panel explained "Failed", then explained PROJECT, then explained
 * ACCEPTANCE CRITERIA, then explained it a second time two lines further down.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "BEHIND AN i" MEANS, AND WHAT IT DOES NOT MEAN
 *
 * This control is not a place to put prose you did not want to think about. It
 * is the middle outcome of three, and the other two are more common:
 *
 *   DELETE. The sentence restates the label above it, or it describes a
 *     consequence of an action the reader has not taken yet. Most of the 1,700
 *     words are this. An "i" is not cheaper than deleting them — it is a second
 *     affordance a reader has to notice, decide about and dismiss, and eighty of
 *     them is its own kind of noise.
 *
 *   BEHIND THIS CONTROL. The fact would change what the reader DOES if they knew
 *     it. The composer's "send it before you resume, or that prompt is composed
 *     without it" is the type specimen: it changes the ORDER of two things the
 *     reader is about to do. Hiding the paragraph is fine. Losing the fact is
 *     not.
 *
 *   KEEP INLINE. Rare, and it has to earn it: the reader must need it BEFORE
 *     acting and be unable to recover if they miss it. A destructive action's
 *     scope, a cost that is about to be spent. If the reader can undo it or
 *     re-read it afterwards, it is not this category.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, stated once so every lane can quote it:
 * A FACT THAT CHANGES WHAT THE USER DOES MAY BE HIDDEN. IT MAY NEVER BE DELETED.
 * This product's whole value is that it tells the truth about what it did, so a
 * shorter screen that quietly drops a constraint is a worse screen, not a
 * cleaner one. If plain words change the meaning, keep the meaning and find
 * different plain words.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT A `title` ATTRIBUTE, which would have been one line of code.
 *
 * `title` never appears on touch, appears after a ~1s delay nobody can shorten,
 * cannot be styled to this palette, truncates at the OS's own width, and is not
 * reliably announced by screen readers. It is also unreachable from the keyboard
 * in every browser. The rail uses `title` on its icons and that is correct there
 * — a one-word name for an icon-only button is exactly what `title` is for. A
 * sentence the reader may NEED is a different job.
 *
 * WHY HOVER IS NOT ENOUGH, and this is the part that is not negotiable. The ask
 * says "when i hover over it". A hover-only reveal is invisible to a keyboard,
 * unreachable on a touchpad-less tablet, and on touch it either does nothing or
 * fires once and sticks. Replacing a paragraph everyone can read with a bubble
 * only a mouse can open is a downgrade wearing a cleanup's clothes. So it opens
 * on hover AND on click/tap AND on keyboard focus, and closes on Escape, on
 * blur, and on a click outside.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM, AND THE THREE THINGS IT HAD TO GET RIGHT
 *
 *   1. IT DOES NOT MOVE THE PAGE. The bubble is `position: fixed` inside a
 *      portal on `document.body`, so opening it cannot reflow a single element
 *      around the trigger. A tooltip that pushes the paragraph it is explaining
 *      is worse than the paragraph.
 *
 *   2. IT IS NOT CLIPPED. The rail's panel body is `min-h-0 flex-1
 *      overflow-y-auto` (`canvas/rail.tsx:518`) and the run view itself is
 *      `overflow-hidden` (`runs/[runId]/page.tsx:894`), so a bubble rendered in
 *      place would be cut off by whichever ancestor scrolls — silently, and only
 *      near an edge, which is exactly the kind of half-working a spot check
 *      passes. The portal escapes every overflow ancestor AND every stacking
 *      context, which is the same correction `Lightbox` in `ui.tsx` already
 *      records paying for once.
 *
 *   3. THE DESCRIPTION IS IN THE ACCESSIBILITY TREE EVEN WHEN THE BUBBLE IS
 *      SHUT. The content element is ALWAYS rendered — `sr-only` and inline when
 *      closed, portaled and painted when open — and `aria-describedby` on the
 *      trigger always points at it. A screen-reader user reading the page in
 *      browse mode never moves DOM focus, so a tooltip that only exists while
 *      open is a tooltip they never hear. One element, one id, two homes.
 *
 * NO ENTRANCE ANIMATION, and that is a decision rather than an omission. The
 * app's keyframes all live in `globals.css` next to the rule they belong to; a
 * component-local `<style>` tag to buy a 90ms fade would put a second home for
 * motion in the tree for no information gain. Nothing here moves, so there is
 * nothing for `prefers-reduced-motion` to switch off.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADOPTING IT — the whole API, and it is one line:
 *
 *   <Explain about="acceptance criteria">
 *     Written from your ticket before any code existed, then locked.
 *   </Explain>
 *
 * `about` is REQUIRED and is not decoration: it becomes the trigger's accessible
 * name ("Explain: acceptance criteria"). Sixty buttons all named "More info" is
 * a screen reader reading out a wall of prose, which is the defect this control
 * was built to remove.
 *
 * ONE IMPLEMENTATION, EVERYWHERE. Six bespoke tooltips is the same disease as
 * six paragraphs: six hover behaviours, six focus bugs, six palettes. If this
 * component is wrong for a call site, fix this component.
 */

/** Distance between the glyph and the bubble. */
const GAP = 6;

/** Closest the bubble is ever placed to a viewport edge. */
const MARGIN = 8;

/**
 * Where the bubble goes: under the glyph, centred on it, flipped above when the
 * bottom of the viewport is closer than the bubble is tall, and clamped so it
 * can never be placed off-screen.
 *
 * READS ONLY WIDTH AND HEIGHT FROM THE BUBBLE. It must not read the bubble's
 * position, because the bubble's position is what this function sets — feeding
 * it back in makes the reposition-on-scroll listener chase its own tail.
 */
function place(
  trigger: DOMRect,
  bubbleWidth: number,
  bubbleHeight: number,
): { x: number; y: number } {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  let y = trigger.bottom + GAP;
  if (y + bubbleHeight > viewportHeight - MARGIN) {
    const above = trigger.top - GAP - bubbleHeight;
    y = above >= MARGIN ? above : Math.max(MARGIN, viewportHeight - MARGIN - bubbleHeight);
  }

  const centred = trigger.left + trigger.width / 2 - bubbleWidth / 2;
  const rightmost = Math.max(MARGIN, viewportWidth - MARGIN - bubbleWidth);
  const x = Math.min(Math.max(MARGIN, centred), rightmost);

  return { x, y };
}

/**
 * How it was opened, because the two ways close differently.
 *
 * `hover` closes when the pointer leaves. `sticky` — a click, a tap, or keyboard
 * focus — does not, because a reader who tapped a glyph on a touchscreen has no
 * pointer to move away and a reader who tabbed to it has no pointer at all.
 */
type OpenBy = "hover" | "sticky";

/**
 * ONE BUBBLE AT A TIME, ACROSS EVERY INSTANCE ON THE PAGE.
 *
 * Without this each glyph is independent, and a reader who clicks three of them
 * in a panel is left with three bubbles stacked over the content they were
 * reading — the wall of prose back again, and now floating. A click that opens
 * one is also a decision to stop reading the last one.
 *
 * A module-level set rather than context: the six adopting lanes wrap strings
 * wherever the string is, and requiring a provider around every one of them
 * would be an adoption cost paid on every screen for a rule with no options.
 */
const MOUNTED_CLOSERS = new Set<() => void>();

export function Explain({
  about,
  children,
  className,
  testId = "explain",
}: {
  /** What is being explained. Becomes the trigger's accessible name. */
  about: string;
  children: ReactNode;
  className?: string;
  /** Set this when a spec has to single out one of several on a screen. */
  testId?: string;
}): ReactNode {
  const id = useId();
  const [openBy, setOpenBy] = useState<OpenBy | null>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

  const open = openBy !== null;

  const close = useCallback((): void => {
    setOpenBy(null);
    setCoords(null);
  }, []);

  useEffect(() => {
    MOUNTED_CLOSERS.add(close);
    return () => {
      MOUNTED_CLOSERS.delete(close);
    };
  }, [close]);

  /** Open this one and shut every other one on the page. */
  const show = useCallback(
    (mode: OpenBy): void => {
      for (const other of MOUNTED_CLOSERS) if (other !== close) other();
      setOpenBy(mode);
    },
    [close],
  );

  /*
   * POSITION, AND THEN KEEP POSITIONING. The scroll listener is CAPTURING, which
   * is the only way to hear the rail panel's own scroll — a scroll event on an
   * inner element does not bubble to `window`, it only passes through in the
   * capture phase.
   */
  useEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const bubble = bubbleRef.current?.getBoundingClientRect();
      if (trigger === undefined || bubble === undefined) return;
      setCoords(place(trigger, bubble.width, bubble.height));
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  /*
   * ESCAPE AND OUTSIDE-CLICK.
   *
   * The keydown listener is CAPTURING ON `window` for a reason worth writing
   * down: React 19 attaches its handlers at the app root, which is INSIDE
   * `window`, so a bubble-phase listener here runs after them and
   * `stopPropagation` would be too late to matter. The rail closes its whole
   * panel on Escape (`canvas/rail.tsx`, `onPanelKeyDown`), and a reader whose
   * first Escape closed the panel out from under the bubble they were reading
   * has been punished for using the keyboard. Innermost layer wins.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      /*
       * FOCUS COMES BACK ONLY IF THIS CONTROL HAD IT, and the guard is here
       * because the unguarded version was written first and measured: on the
       * keyboard path it is a NO-OP — focus is already on the trigger, so
       * deleting the whole line left every test green — and on the HOVER path it
       * is a focus steal, dragging the caret to a glyph a mouse reader merely
       * pointed at. Guarded, it does the one thing it is for: a bubble whose
       * children a lane made focusable hands focus back to the trigger instead
       * of dropping it on `<body>`.
       */
      const active = document.activeElement;
      const hadFocus =
        (active !== null && wrapRef.current?.contains(active) === true) ||
        (active !== null && bubbleRef.current?.contains(active) === true);
      close();
      if (hadFocus) triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && wrapRef.current?.contains(target) === true) return;
      if (target !== null && bubbleRef.current?.contains(target) === true) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  /*
   * FOCUS OPENS IT, BUT ONLY KEYBOARD FOCUS. A mouse click focuses the button
   * too, and an unconditional focus-open would fight the click toggle: pointer
   * down focuses (open), then click toggles (closed), and the control does
   * nothing when clicked. `:focus-visible` is the browser's own answer to "did a
   * keyboard do this", and Chromium does not apply it to a button clicked with a
   * mouse.
   */
  const onFocus = (event: ReactFocusEvent<HTMLButtonElement>): void => {
    let byKeyboard = true;
    try {
      byKeyboard = event.target.matches(":focus-visible");
    } catch {
      // A browser without :focus-visible gets the accessible behaviour rather
      // than the tidy one.
      byKeyboard = true;
    }
    if (byKeyboard) show("sticky");
  };

  /* Leaving the control entirely closes it — including into the bubble, which is
     not a child of this element once it is portaled. */
  const onBlur = (event: ReactFocusEvent<HTMLButtonElement>): void => {
    const next = event.relatedTarget;
    if (next !== null && wrapRef.current?.contains(next) === true) return;
    if (next !== null && bubbleRef.current?.contains(next) === true) return;
    close();
  };

  /* A click on a control that is already hover-open PROMOTES it rather than
     closing it: the reader is asking to keep reading, not to stop. */
  const onClick = (): void => {
    if (openBy === "sticky") close();
    else show("sticky");
  };

  const onPointerEnter = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    // Touch fires pointerenter immediately before click; opening here would make
    // the click that follows a close.
    if (event.pointerType !== "mouse") return;
    if (openBy === null) show("hover");
  };

  const onPointerLeave = (): void => {
    if (openBy === "hover") close();
  };

  /*
   * ONE ELEMENT, TWO HOMES. Closed, it is `sr-only` and inline — no layout, no
   * paint, still in the accessibility tree for `aria-describedby` to name. Open,
   * the same element is portaled to `document.body` and painted. A `<span>`
   * rather than a `<div>` because its closed home is inside an inline wrapper.
   *
   * `normal-case` IS ON BOTH BRANCHES, AND THAT IS NOT SYMMETRY FOR ITS OWN SAKE.
   * The closed body stays INLINE, so it inherits from wherever the glyph sits —
   * and these glyphs sit in section headings, which this dashboard sets in
   * `uppercase`. `text-transform` is inherited and applies to `sr-only` text: a
   * screen reader was being handed "PICKING ONE HERE SELECTS ITS CARD ON THE
   * CANVAS", which some screen readers spell out letter by letter. Measured on the
   * roster heading in `sheet.tsx`, and it was a browser spec reading `innerText`
   * that caught it rather than anything a sighted reviewer could see.
   *
   * FIXED HERE RATHER THAN AT THE CALL SITE. `criteria.tsx` already passes
   * `normal-case` in its trigger `className` for exactly this reason; leaving the
   * fix there makes it something all 32 call sites have to remember, and 31 of
   * them did not. The open branch keeps its own copy because it is portaled to
   * `document.body`, where it inherits nothing and the class is a no-op — harmless
   * there, and load-bearing the moment someone reorders these branches.
   */
  const bubble = (
    <span
      ref={bubbleRef}
      id={id}
      role="tooltip"
      data-testid={`${testId}-body`}
      className={
        open
          ? "fixed left-0 top-0 z-50 block max-w-[288px] rounded border border-line-strong bg-surface-raised px-2.5 py-2 text-[12px] font-normal normal-case leading-relaxed tracking-normal text-ink shadow-[0_10px_28px_rgba(0,0,0,0.55)]"
          : "sr-only normal-case"
      }
      style={
        open
          ? {
              transform: `translate3d(${String(coords?.x ?? 0)}px, ${String(coords?.y ?? 0)}px, 0)`,
              // One frame unpainted rather than one frame in the wrong place:
              // the bubble has to be measured before it can be placed.
              visibility: coords === null ? "hidden" : "visible",
            }
          : undefined
      }
    >
      {children}
    </span>
  );

  return (
    <span
      ref={wrapRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cx("inline-flex align-middle", className)}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-label={`Explain: ${about}`}
        aria-describedby={id}
        aria-expanded={open}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
        className={cx(
          // 18px drawn. `after:-inset-1` makes the POINTER target 26px without
          // costing a pixel of layout, which is how a glyph this small stays
          // hittable on a touchscreen next to a 13px label.
          "relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-full align-middle transition-colors",
          "after:absolute after:-inset-1 after:content-['']",
          open ? "text-accent" : "text-ink-faint hover:text-ink",
        )}
      >
        {/*
         * A DRAWN GLYPH, NOT THE LETTER. `ⓘ` and a styled "i" are letterforms:
         * they inherit the call site's font, weight, letter-spacing and casing,
         * so the same control renders differently inside an uppercase field
         * label than inside body copy. Strokes at 1.5 on a 16-unit box match the
         * weight of the rail's 24px masks; the rail's own PNGs are not reused
         * because they are a 24px activity-bar set and this is an 18px inline
         * mark.
         */}
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
          className="size-[14px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6.35" />
          <path d="M8 7.4v3.6" />
          <circle cx="8" cy="4.9" r="0.4" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(bubble, document.body)
        : bubble}
    </span>
  );
}
