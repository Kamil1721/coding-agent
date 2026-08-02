"use client";

/**
 * attachment-chips.tsx — what the owner attached, shown as the thing it is.
 *
 * WHAT WAS MEASURED, 2026-08-02. Pasting a design board and a CV into the ticket
 * form produced the text `design-board.png ×` and `PDF Kamil_Borzecki_CV.pdf ×`,
 * and `document.querySelectorAll('img')` returned ZERO elements on the whole page.
 * The bytes were in the browser — the paste handler had already read them — and the
 * one question a reader has after a paste ("is that the right file?") could only be
 * answered by reading a truncated filename. The owner was about to hand this thing a
 * design he generated elsewhere and could not see it.
 *
 * THE PREVIEW IS LOCAL AND THE SERVER IS NOT INVOLVED. `RunDetail.references` and
 * `RunDetail.documents` hold ABSOLUTE FILESYSTEM PATHS (`server/src/api-types.ts`
 * :1426, :1455), no route serves `runs/<id>/references/*`, and none of that matters
 * here anyway: this list is pre-submit, the `File` is in memory, and the thumbnail
 * comes from `URL.createObjectURL`. Nothing on this surface can round-trip.
 *
 * ONE CHIP GRAMMAR FOR BOTH INTAKES, WHICH REPLACES TWO HAND COPIES. The ticket form
 * and the chat composer each had their own chip markup, and the comment on the chat's
 * copy justified the duplication with "the two chips differ in width and text size".
 * Half of that was already false — both were `text-[10.5px]`; only the filename's
 * `max-w` differed, 160 against 120 — and a thumbnail is far more than a width's
 * worth of markup to keep in step by hand. It is one component now.
 *
 * A CHIP IS 40px TALL AND BOTH KINDS ARE THE SAME SHAPE, deliberately: an image and
 * a document dropped together line up, and the kind is carried by the TILE (a real
 * thumbnail, or the document glyph) rather than by the border weight that used to
 * carry it when a chip was text. The image and document chips therefore share a
 * border and a background where they used to differ.
 *
 * WHY THE SIZE IS ON THE CHIP AT ALL. Two exports of the same deck differ in their
 * tail and in their weight; the caps are per-kind and per-byte (8 MB an image, 12 MB
 * a document), so a file's size is the number that predicts a refusal, and printing
 * it after the fact is what makes the cap legible before the next paste.
 *
 * ESCAPE IS STOPPED HERE, AND THE REASON IS A RACE THIS FILE INHERITED.
 * `Sheet` (canvas/sheet.tsx:105-112) closes the whole run sheet from a React
 * `onKeyDown` on the sheet shell; `Lightbox` (ui.tsx) handles Escape with a native
 * `window` listener. React's delegated handler runs first, so Escape on an open
 * lightbox would close the SHEET out from under it — the reader asks for his design
 * board back and loses the Chat tab instead. `screenshots.tsx:61-79` documents the
 * same trap and guards it the same way, from reasoning; this one is observed, in
 * Chromium, on the run page. On the ticket form there is no sheet and the guard is
 * inert.
 *
 * FOCUS: THE TRIGGER IS CAPTURED ON OPEN AND FOCUSED ON CLOSE, and the residual
 * limit is named rather than hidden. `Lightbox` never moves focus INTO the dialog,
 * so in practice focus never left the thumbnail button and the restore is a no-op
 * that stays correct if that changes. What it does not fix is that `Lightbox`
 * carries `aria-modal="true"` while nothing focusable inside it is ever reached —
 * a screen reader user gets the dialog's label (the filename) and the Escape key,
 * not its contents. Fixing that means editing `components/ui.tsx`, which this change
 * does not own; forking a second lightbox for four chips would be worse.
 */

import { useRef, useState, type ReactNode } from "react";

import { Lightbox, cx } from "@/components/ui";
import {
  attachmentTypeLabel,
  formatBytes,
  type HeldAttachment,
} from "@/lib/attachments";

/**
 * A sheet of paper with the corner turned, drawn rather than fetched.
 *
 * 1.5 STROKE ON A 24 GRID, RENDERED AT 20px — 1.25 device pixels, which is the
 * weight the rest of this app's hairlines land at (`--color-line` borders, the
 * conduit's specular core). `currentColor` so the tile's own text colour drives it
 * and a hover has one thing to change.
 */
function DocumentGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly HeldAttachment[];
  /** Index into `attachments`. The holder releases the object URL; see the module. */
  onRemove: (index: number) => void;
}): ReactNode {
  const [zoomed, setZoomed] = useState<number | null>(null);
  /* Where the lightbox was opened from, so closing it puts focus back. */
  const openedFrom = useRef<HTMLButtonElement | null>(null);

  const close = (): void => {
    setZoomed(null);
    openedFrom.current?.focus();
    openedFrom.current = null;
  };

  /**
   * A REMOVAL SHUTS THE VIEWER, because `zoomed` is an INDEX and a removal shifts
   * every index after it — open on the second image, drop the first, and the
   * lightbox would go on showing "the second image" while pointing at a different
   * file. Not a theoretical race: `Lightbox` does not trap focus (deliberately,
   * see the header), so the remove buttons stay tabbable behind the backdrop and a
   * keyboard reader can reach one without dismissing anything.
   *
   * IT DOES NOT RESTORE FOCUS. The element that opened the viewer may be the one
   * being removed, so `close()`'s focus call would either aim at a detached node
   * or move a reader somewhere they did not ask to go.
   */
  const removeAndClose = (index: number): void => {
    setZoomed(null);
    openedFrom.current = null;
    onRemove(index);
  };

  if (attachments.length === 0) return null;

  const open = zoomed === null ? null : (attachments[zoomed] ?? null);

  return (
    <div
      onKeyDown={(event) => {
        // Only while zoomed, and only Escape: see the module header. Unguarded,
        // this would eat the sheet's own Escape.
        if (zoomed === null || event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
    >
      <ul className="flex flex-wrap gap-1.5">
        {attachments.map((attachment, index) => {
          const typeLabel = attachmentTypeLabel(attachment);
          return (
            <li
              key={`${attachment.name}:${String(index)}`}
              className="flex items-center gap-2 rounded-sm border border-line bg-surface-raised py-1 pl-1 pr-1.5"
            >
              {attachment.previewUrl === null ? (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-sm border border-line bg-canvas text-ink-dim">
                  <DocumentGlyph />
                </span>
              ) : (
                <button
                  type="button"
                  // `type="button"` IS NOT DECORATION on this surface: the ticket
                  // chips sit inside the ticket `<form>`, where a button defaults
                  // to `submit` and opening a thumbnail would start the run.
                  onClick={(event) => {
                    openedFrom.current = event.currentTarget;
                    setZoomed(index);
                  }}
                  aria-label={`Open ${attachment.name} full size`}
                  className="block size-10 shrink-0 overflow-hidden rounded-sm border border-line bg-canvas transition-colors hover:border-ink-faint focus-visible:border-accent"
                >
                  {/*
                    * THE ALT NAMES THE FILE even though the button's own label
                    * carries the action, and that is worth the redundancy: if the
                    * object URL is ever revoked while the chip is still mounted,
                    * this is what renders in the broken image's place, and a
                    * filename there is a diagnosis where a broken-image glyph is a
                    * mystery. `next/image` is not used for the same reason
                    * `ui.tsx` does not use it — the source is a `blob:` URL with
                    * no intrinsic size and nothing to optimise.
                    */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="size-full object-cover"
                  />
                </button>
              )}

              {/*
                * THE FILENAME IS THE BRIGHTEST THING IN THE CHIP, one step above the
                * meta line, and the step is a contrast measurement rather than a
                * preference. `--color-ink-faint` (#6f7887) on `--color-surface-raised`
                * (#161a21) is 3.9:1 — under AA for text this small — which is fine
                * for the disclosure paragraphs it is used for elsewhere and not fine
                * for the one string a reader is scanning to answer "is that the right
                * file?". `ink` on raised is 13.4:1 and `ink-dim` is 7.4:1, so the
                * hierarchy is kept and both rungs clear AA.
                *
                * `title` CARRIES THE FULL NAME because the visible span truncates, and
                * two long exports of the same deck differ in their tail. It is also
                * the handle two specs already reach for — `getByTitle("hero.png")` in
                * `document-intake.browser.spec.ts:338` — so it stays on exactly ONE
                * element per chip; a second copy on the thumbnail would make that
                * locator strict-mode ambiguous.
                */}
              <span className="flex min-w-0 flex-col gap-[1px]">
                <span
                  className="max-w-[150px] truncate text-[11.5px] leading-tight text-ink"
                  title={attachment.name}
                >
                  {attachment.name}
                </span>
                {/*
                  * THREE ELEMENTS, NOT ONE STRING, AND A SPEC IS WHY.
                  * `document-intake.browser.spec.ts:259` asserts
                  * `getByText("PDF", { exact: true })` is visible, with the comment
                  * "the tag is matched EXACTLY, so it cannot be satisfied by the
                  * enclosing chip's concatenated text" — a deliberately strict
                  * locator, and the right one: it is what stops a document chip
                  * passing because the word PDF happened to appear in the filename.
                  * Interpolating `PDF · 203 KB` into a single span turned that spec
                  * red. The type keeps its own node, so the assertion still has
                  * something exact to find.
                  */}
                <span className="text-[10px] leading-tight text-ink-dim">
                  <span>{typeLabel}</span>
                  <span aria-hidden="true">{" · "}</span>
                  <span>{formatBytes(attachment.size)}</span>
                </span>
              </span>

              <button
                type="button"
                onClick={() => removeAndClose(index)}
                className={cx(
                  "shrink-0 self-center rounded-sm px-1 text-[13px] leading-none text-ink-dim",
                  "transition-colors hover:text-fail",
                )}
                aria-label={`remove ${attachment.name}`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        * INSIDE THIS ELEMENT IN THE REACT TREE, not beside it. `Lightbox` portals
        * to `document.body`, and a synthetic event raised inside a portal
        * propagates along the REACT tree — so keeping it here is what lets the
        * Escape guard above cover a keypress made while focus is in the dialog.
        */}
      {open !== null && open.previewUrl !== null && (
        <Lightbox
          src={open.previewUrl}
          alt={open.name}
          caption={`${open.name} · ${attachmentTypeLabel(open)} · ${formatBytes(open.size)}`}
          onClose={close}
        />
      )}
    </div>
  );
}
