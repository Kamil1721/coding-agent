"use client";

/* eslint-disable @next/next/no-img-element -- `next/image` needs a configured
   loader and a known remote host. Screenshot locations come from the backend at
   runtime and may not be HTTP at all, so a plain <img> with an explicit error
   fallback is the honest primitive here. */

/**
 * screenshots.tsx — the finished site first, the references it was built from
 * second, and the file paths last.
 *
 * WHAT THIS PANEL USED TO DO, AND WHY IT WAS THE WRONG WAY ROUND. It rendered
 * `RunDetail.screenshots` as one undifferentiated grid in `captured_at ASC`
 * order. The DESIGN lane publishes its five mockups BEFORE the build runs and
 * the scorer captures the built site AFTER it, so the only screen in the app
 * that shows the finished product opened on five AI mockups the owner had
 * already seen full-size on the design dock, with the three captures of their
 * actual site last, 128px tall, cropped by `object-cover`, and clickable only
 * into a raw PNG dumped in a new browser tab — while the mockups, on the dock,
 * got the in-app `Lightbox`.
 *
 * SO THE ORDER IS NOW EXPLICIT AND THE GROUPS ARE NAMED. `splitCaptures`
 * (src/lib/mockups.ts) partitions on membership in the server-computed
 * `designLock.mockups`, with the mockup label as a fail-soft secondary; read its
 * docblock for what that does and does not guarantee. The product captures come
 * first under a heading that says whose site they are; the references collapse
 * into shut `<details>` below, because the dock already showed them big at the
 * moment they mattered.
 *
 * AND SINCE 2026-08-03 THAT IS UP TO FOUR DISCLOSURES RATHER THAN ONE, because
 * "reference" stopped being one thing. A canvassed run publishes the direction
 * it was BUILT to, the directions that were OFFERED AND NOT BUILT, and stills
 * the owner ASKED FOR while parked — and the single old heading, "the mockups
 * the run was built to", is a false claim about two of those three. The grouping
 * is `groupReferences`, which decides it from `directions[]` and `requests[]`
 * rather than from filenames; a run with neither yields one group and the
 * original heading, verbatim.
 *
 * NATURAL ASPECT, NO CROP, NO HEIGHT CAP. The captures are VIEWPORT-sized by
 * construction — the scorer shoots one per breakpoint, and the three on the run
 * measured here are 1280x800, 768x1024 and 375x812 — so `h-auto` renders each
 * whole at its own shape inside a two-up grid. THE ASSUMPTION IS NAMED because
 * it is an assumption: a full-page capture (a tall PNG) would render tall and
 * push the rest of the tab down. That was chosen over a `max-h` + `object-contain`
 * cap, which would letterbox a narrow phone capture into a sliver, and over the
 * old `object-cover`, which cropped.
 *
 * THE PATHS DID NOT GO AWAY, THEY WENT DOWN. `design-lock.tsx:250-253` removed
 * the path from each mockup card explicitly on the grounds that "the path is
 * carried in full, with a copy button, by the screenshots panel further down the
 * same page". So the technical-details disclosure at the bottom lists EVERY
 * capture, references included; trimming it to the product captures would make
 * that comment false in a file this one cannot edit.
 */

import { useState, type ReactNode } from "react";

import type { DesignLockState, Screenshot } from "@/lib/api-types";
import { formatClock } from "@/lib/format";
import { groupReferences, splitCaptures } from "@/lib/mockups";
import { screenshotSrc } from "@/lib/screenshots";
import { EmptyState, Lightbox, MonoPath, Panel } from "@/components/ui";

function Shot({ shot, runId }: { shot: Screenshot; runId: string }): ReactNode {
  const src = screenshotSrc(runId, shot.path);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const showImage = src !== null && !failed;

  /*
   * ESCAPE, LOCALLY, AND ONLY WHILE ZOOMED — because this panel lives inside
   * `RunSheet` and `Lightbox` has never been opened from in there before.
   *
   * `Sheet` (canvas/sheet.tsx:86) handles Escape with a React `onKeyDown` on the
   * sheet shell and closes the whole sheet; `Lightbox` (ui.tsx:373) handles it
   * with a native `window` listener. React's delegated handler runs at the root
   * container, which is inside `window`, so the sheet's handler wins the race and
   * Escape on an open lightbox would close the sheet out from under it — the
   * reader asks for their capture back and loses the Verdict tab instead. The
   * mockup lightbox in `design-lock.tsx` never hit this: it renders on the run
   * page's HUD, outside any sheet.
   *
   * REASONED FROM THE TWO HANDLERS, NOT OBSERVED IN A BROWSER — no run of the
   * suite backs this comment. It is a guard either way: stopping the synthetic
   * event keeps the sheet open, `setZoomed(false)` closes the viewer, and
   * `Lightbox`'s own window listener still fires and calls the same setter, which
   * is idempotent. `Lightbox` itself is not edited; another agent owns ui.tsx.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!zoomed || event.key !== "Escape") return;
    event.stopPropagation();
    setZoomed(false);
  };

  return (
    <figure
      onKeyDown={onKeyDown}
      className="min-w-0 overflow-hidden rounded border border-line bg-surface-raised"
    >
      {showImage ? (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={`Enlarge ${shot.label}`}
          className="block w-full cursor-zoom-in"
        >
          <img
            src={src}
            alt={shot.label}
            loading="lazy"
            onError={() => setFailed(true)}
            className="block h-auto w-full bg-canvas"
          />
        </button>
      ) : (
        <div className="flex h-[128px] items-center justify-center bg-canvas px-3 text-center text-[11px] leading-snug text-ink-faint">
          {src === null
            ? "Captured on disk. Nothing here can turn that path into a URL — it is in the technical details below."
            : "The server did not return this capture. It is still on disk, at the path in the technical details below."}
        </div>
      )}

      {zoomed && src !== null && (
        <Lightbox
          src={src}
          alt={shot.label}
          caption={shot.label}
          onClose={() => setZoomed(false)}
        />
      )}

      <figcaption className="space-y-0.5 border-t border-line px-2 py-1.5">
        <div className="truncate text-[12px] text-ink" title={shot.label}>
          {shot.label}
        </div>
        <div className="numeric text-[10.5px] text-ink-faint">
          {formatClock(shot.capturedAt)}
        </div>
      </figcaption>
    </figure>
  );
}

/**
 * One collapsed group of references. Shut by default, exactly as the single
 * disclosure was: the dock already showed these big at the moment they mattered.
 */
function ReferenceGroup({
  runId,
  shots,
  summary,
}: {
  runId: string;
  shots: readonly Screenshot[];
  summary: string;
}): ReactNode {
  return (
    <details className="mt-2 rounded border border-line bg-canvas/40">
      <summary className="cursor-pointer px-3 py-2 text-[11.5px] text-ink-dim marker:text-ink-faint">
        {summary}
      </summary>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-start gap-2 px-3 pb-3">
        {shots.map((shot) => (
          <Shot key={`${shot.path}:${shot.capturedAt}`} shot={shot} runId={runId} />
        ))}
      </div>
    </details>
  );
}

export function ScreenshotsPanel({
  runId,
  screenshots,
  designLock,
}: {
  runId: string;
  screenshots: readonly Screenshot[];
  /**
   * `run.designLock ?? null` — the whole lock, and REQUIRED rather than optional
   * so a caller with no design lane passes `null` explicitly.
   * (`exactOptionalPropertyTypes` is on: an optional prop here would refuse the
   * `undefined` that `?.` produces.)
   *
   * IT WAS `mockups: readonly Screenshot[]` UNTIL 2026-08-03, and the widening
   * is what lets the disclosure below stop making a false claim — see
   * `groupReferences`. `null` and a lock with no directions both collapse to the
   * pre-canvass rendering.
   */
  designLock: DesignLockState | null;
}): ReactNode {
  const mockups = designLock === null ? [] : designLock.mockups;
  const { product, references } = splitCaptures(screenshots, mockups);
  /*
   * THE REFERENCES, SPLIT AGAIN BY WHAT EACH STILL ACTUALLY IS.
   *
   * On a pre-canvass run every one of them lands in `ungrouped` and the
   * disclosure keeps its original heading verbatim — which is what "old runs
   * render unchanged" means here, mechanically rather than by intention.
   */
  const groups = groupReferences(references, designLock);

  return (
    <Panel
      title="The finished site"
      /*
       * NO SUBTITLE WHEN THERE IS NOTHING TO DESCRIBE. Every sentence available
       * here — the count, the masking rule — is a statement about captures that
       * exist, and on a run parked at the design lock none do. The empty state
       * below is the only true thing to say in that case, and it says it once.
       */
      subtitle={
        product.length === 0
          ? undefined
          : `${String(product.length)} capture${product.length === 1 ? "" : "s"} of the site this run built, taken by the scorer after the build. Masking is applied at capture time and cannot be undone or re-applied later.`
      }
    >
      {/*
       * THE EMPTY CASE IS NOT A FAILURE, AND IS THE NORMAL STATE OF A PARKED RUN.
       * A run stopped at the design lock has five references and no capture of
       * anything, because the scorer has not run yet. So this says WHEN they
       * arrive rather than reading as a missing artefact — and the references
       * disclosure below still renders, so the tab is not blank.
       */}
      {product.length === 0 ? (
        <EmptyState>
          No capture of the site yet. The scorer takes these after the build, in a
          sealed container.
        </EmptyState>
      ) : (
        // Two-up at this sheet's width (560px, so ~260px a column) rather than
        // one-up: at natural aspect a single column costs about twice the scroll
        // for the same three captures, and the lightbox is where a capture is
        // actually read. `items-start` because the breakpoints have different
        // shapes and a stretched row would reintroduce a crop.
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] items-start gap-2">
          {product.map((shot) => (
            <Shot key={`${shot.path}:${shot.capturedAt}`} shot={shot} runId={runId} />
          ))}
        </div>
      )}

      {/*
       * ONE DISCLOSURE PER KIND, AND THE HEADINGS ARE THE POINT.
       *
       * `built` really is "the mockups the run was built to". `offered` is a
       * direction the lane proposed and the owner did not take — the run was
       * never graded against it, and filing it under the first heading is the
       * exact wrong claim the two-stage shape exists to avoid. `requested` is a
       * still the owner commissioned at the park, which the build may not even
       * contain a section for.
       *
       * `ungrouped` KEEPS THE ORIGINAL SENTENCE, WORD FOR WORD. It is the whole
       * of a pre-canvass run, and this panel must read on those three runs
       * exactly as it read before directions existed.
       */}
      {groups.ungrouped.length > 0 && (
        <ReferenceGroup
          runId={runId}
          shots={groups.ungrouped}
          summary={`Design references (${String(groups.ungrouped.length)}) — the mockups the run was built to, shown full-size on the design dock`}
        />
      )}

      {groups.built.length > 0 && (
        <ReferenceGroup
          runId={runId}
          shots={groups.built}
          summary={`The direction that was built (${String(groups.built.length)}) — the mockups this run was made to, and graded against`}
        />
      )}

      {groups.offered.length > 0 && (
        <ReferenceGroup
          runId={runId}
          shots={groups.offered}
          summary={`Directions that were offered and not built (${String(groups.offered.length)}) — kept as a record of the choice; nothing was graded against these`}
        />
      )}

      {groups.requested.length > 0 && (
        <ReferenceGroup
          runId={runId}
          shots={groups.requested}
          summary={`Stills you asked for at the design park (${String(groups.requested.length)}) — previews, not necessarily sections the build produced`}
        />
      )}

      {screenshots.length > 0 && (
        <details className="mt-2 rounded border border-line bg-canvas/40">
          <summary className="cursor-pointer px-3 py-2 text-[11.5px] text-ink-dim marker:text-ink-faint">
            Technical details — where these files are on disk
          </summary>
          {/*
           * EVERY capture, product and reference alike, in the order the run
           * recorded them. These are absolute HOST paths: a browser cannot open
           * one, which is why they are copyable text and not links.
           */}
          <ul className="space-y-1.5 px-3 pb-3">
            {[...product, ...references].map((shot) => (
              <li
                key={`${shot.path}:${shot.capturedAt}`}
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span className="shrink-0 text-[11px] text-ink-faint">{shot.label}</span>
                <MonoPath path={shot.path} max={38} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
