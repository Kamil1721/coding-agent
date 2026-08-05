import { notFound } from "next/navigation";

import { Explain } from "@/components/explain";

/**
 * A BENCH FOR `Explain`, AND NOTHING ELSE. Not linked from anywhere, not part of
 * the product, `notFound()` in a production build.
 *
 * WHY IT EXISTS. `explain.tsx` landed BEFORE the six lanes that wrap prose in it,
 * so on the day it was written there was no screen in this app that rendered one.
 * The alternatives were both worse: assert nothing until somebody else's lane
 * lands (a component with no negative control, which is this repository's
 * signature defect), or assert it against a hand-written HTML copy in
 * `page.setContent` (a test of the copy, not of the component).
 *
 * WHAT IT REPRODUCES, deliberately rather than decoratively:
 *
 *   - A KEYBOARD ANCHOR. One focusable control before the first glyph, so a spec
 *     can arrive at the trigger with a real Tab rather than a programmatic
 *     `.focus()`. `:focus-visible` is what decides whether focus opens the
 *     bubble, and only a real key press sets it.
 *   - A NEIGHBOUR TO MEASURE. A sibling whose rect must not move when the bubble
 *     opens.
 *   - A SCROLLING PANEL WITH THE RAIL'S OWN GEOMETRY. `min-h-0 flex-1
 *     overflow-y-auto` inside a fixed-height `overflow-hidden` box is
 *     `canvas/rail.tsx:518` inside `runs/[runId]/page.tsx:894`, which is where
 *     every adopted `Explain` will actually live. A bubble rendered in place is
 *     cut off here and nowhere else.
 *   - A TRIGGER AGAINST THE BOTTOM EDGE, so the flip-above branch of `place()`
 *     is a branch a test can reach.
 *
 * DELETE IT once a real screen carries an `Explain` and the spec has been
 * retargeted at that screen. A bench that outlives its subject starts being
 * maintained for its own sake.
 */
export default function ExplainProbePage(): React.ReactNode {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="flex h-dvh flex-col gap-4 overflow-hidden p-6">
      <h1 className="text-lede font-semibold text-ink">Explain bench</h1>

      <p className="text-[13px] text-ink-dim">
        <button
          type="button"
          data-testid="probe-before"
          className="rounded-sm border border-line-strong px-2 py-1 text-[12px] text-ink"
        >
          before
        </button>
        <span data-testid="probe-neighbour" className="ml-3">
          Acceptance criteria
        </span>
        <Explain about="acceptance criteria" className="ml-1" testId="explain-flow">
          Written from your ticket before any code existed, then locked.
        </Explain>
        <span data-testid="probe-after" className="ml-3">
          after
        </span>
      </p>

      {/* The rail's panel body, to the class. */}
      <div className="flex h-40 w-[400px] flex-col overflow-hidden rounded border border-line bg-surface">
        <div data-testid="probe-scroller" className="min-h-0 flex-1 overflow-y-auto p-3">
          <p className="text-[12px] text-ink-dim">Filler above the trigger.</p>
          <p className="mt-24 text-[12px] text-ink-dim">Still filler.</p>
          <p className="mt-24 text-[12px] text-ink-dim">
            Project
            <Explain about="project" className="ml-1" testId="explain-clipped">
              The workspace holds no publishable file yet.
            </Explain>
          </p>
          <p className="mt-24 text-[12px] text-ink-dim">Filler below the trigger.</p>
        </div>
      </div>

      {/*
       * THE CANVAS, IN THE ONE RESPECT THAT MATTERS HERE. React Flow draws every
       * node inside `.react-flow__viewport`, which carries a `transform`, inside
       * a `.react-flow` pane that is `overflow: hidden`. A transform makes an
       * element the CONTAINING BLOCK for `position: fixed` descendants, so a
       * bubble rendered in place there is both mispositioned (its viewport
       * coordinates are re-based onto the transformed box) and clipped by the
       * pane. Plain `overflow` alone does not do this — `fixed` escapes it —
       * which is why the rail-shaped panel above cannot prove the portal is
       * needed and this box can. Measured: without the portal the hit test in
       * `explain.browser.spec.ts` finds the pane instead of the bubble.
       */}
      <div className="h-24 w-[320px] overflow-hidden rounded border border-line bg-surface">
        {/* `justify-end` puts the glyph against the pane's bottom edge, so the
            bubble is placed OUTSIDE the clip rather than comfortably inside it —
            without that, the test measures nothing. */}
        <div
          className="flex h-full flex-col justify-end p-3"
          style={{ transform: "translate(10px, 6px)" }}
        >
          <p className="text-[12px] text-ink-dim">
            Node
            <Explain about="a canvas card" className="ml-1" testId="explain-canvas">
              What this card did, in one sentence.
            </Explain>
          </p>
        </div>
      </div>

      <p className="mt-auto text-[12px] text-ink-dim">
        Bottom edge
        <Explain about="the bottom edge" className="ml-1" testId="explain-bottom">
          Send it before you resume, or that prompt is composed without it.
        </Explain>
      </p>
    </main>
  );
}
