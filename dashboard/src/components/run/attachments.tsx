"use client";

/* eslint-disable @next/next/no-img-element -- `next/image` needs a configured
   loader and a known host. These `src` values are minted by the API at runtime
   (`Attachment.url`, joined to `API_BASE`), so a plain <img> with an explicit
   `onError` fallback is the honest primitive — the same call `screenshots.tsx`
   makes, for the same reason. */

/**
 * attachments.tsx — WHAT THE OWNER HANDED THE TICKET, on the tab about the
 * ticket.
 *
 * THE CONFUSION THIS FILE EXISTS TO PREVENT, first, because it is the only way
 * to read anything below correctly. `screenshots.tsx` renders a disclosure
 * called "Design references". Those are `ui-designer`'s GENERATED mockups —
 * `splitCaptures` (lib/mockups.ts) pulls them out of `RunDetail.screenshots` by
 * membership in `designLock.mockups` — and they answer WHAT DID THE MACHINE
 * PROPOSE. This panel renders `RunDetail.references` and `RunDetail.documents`,
 * the files the owner uploaded with the brief, and they answer WHAT DID I GIVE
 * IT. A reader who merges the two mis-reads every verdict on the page.
 *
 * THE SEPARATION IS STRUCTURAL BEFORE IT IS TEXTUAL, and that is deliberate: a
 * label can be skimmed, a surface cannot be. RE-STATED FOR THE RAIL, 2026-08-05,
 * because the tabs this paragraph used to name are gone: mockups live in
 * `ScreenshotsPanel` inside the RESULT panel, and this component is mounted
 * inside OVERVIEW's "what you asked for" section, under the brief it arrived
 * with. `canvas/rail.tsx` opens exactly one panel at a time, so no screen in the
 * app can show the two under one heading — the same guarantee the two tabs gave,
 * by a different mechanism. The wording — "uploaded with this ticket", plus one
 * sentence pointing at Result — is the second line of defence, not the first.
 *
 * NOTHING AT ALL FOR A RUN WITH NO ATTACHMENTS, and that is the COMMON case,
 * not the edge: every run recorded before these two fields existed answers
 * `GET /api/runs/:id` with neither key. Measured 2026-08-02 against the running
 * backend — `run-2026-07-30T20-16-40-242Z-052c6e02` returns a body whose keys do
 * not include `references` or `documents`, and `lib/api.ts` casts the response
 * with `parsed as T` and no runtime validation, so the declared type is a lie
 * about that payload. The caller flattens with `?? []` (see `RunSheet`'s Ticket
 * tab) and this component returns `null` for two empty lists. An empty box
 * announcing an absence would sit on 100% of the runs on this machine, which is
 * the argument `AdversaryPanel` already makes for the same shape.
 *
 * A 404 IS A ROW, NEVER A BROKEN IMAGE. `AttachmentImage` fails over into the
 * same named row a document uses, with a sentence saying the bytes did not come
 * back and the recorded path underneath. A DOCUMENT is not probed: it is a link,
 * and clicking one whose bytes are gone shows the server's own `not_found`
 * envelope. That is unprobed BY CHOICE — a HEAD per document on every render of
 * the Ticket tab would buy a nicer row with a request the reader did not ask
 * for, and the route answers 404 for a refusal as well as for a missing file
 * (`run-attachments.ts`), so a probe could not tell the reader which it was.
 *
 * THE NAME ON A ROW IS THE SERVER'S, NOT THE OWNER'S. Intake takes base64 data
 * URLs, which carry no filename, so the browser discards `Kamil_Borzecki_CV.pdf`
 * before the POST and the server mints `document-1.pdf`. Nothing here invents a
 * friendlier name; the rows are labelled "as stored" so the difference is on
 * screen rather than in a docblock.
 *
 * EVERY BRANCH SWITCHES ON `mediaType`, NEVER ON THE EXTENSION. The server
 * derives that field and the route's `Content-Type` from one function, so a
 * thumbnail is attempted exactly when the route will answer with an image.
 *
 * `ink-dim` FOR A SENTENCE, `ink-faint` FOR A NUMBER, AND THE SPLIT IS MEASURED.
 * Against `--color-surface` (#11141a) the tokens compute to 4.14:1 for
 * `ink-faint` and 7.97:1 for `ink-dim`, so faint is UNDER WCAG AA for body text
 * at any size. Every string here that carries a claim — the "these bytes did not
 * come back" line, the failed-image notes — is `ink-dim`; `ink-faint` is left to
 * byte counts, media types and digests, which are scannable metadata beside a
 * name that is already `ink`. No new colour was introduced to do it: both tokens
 * are the ones the neighbouring panels already use.
 *
 * THE TWO GROUP PARAGRAPHS ARE NO LONGER ON SCREEN, 2026-08-05 — the sentence
 * above named them and they were the biggest block of prose on this panel. Both
 * are now behind the `Explain` glyph on their group's heading, MOVED and not
 * cut: each one changes what a reader concludes (a path was handed over but not
 * necessarily opened; an edited document is a different ticket). See the note at
 * each call site. What was actually deleted is smaller and is listed here so the
 * next reader does not go looking for it: the subtitle's "before the run
 * started, served back from this run's own directory", which described where the
 * bytes come from rather than anything a reader can act on, and the words
 * "Technical details" and "and their fingerprints" from the disclosure at the
 * foot, which still lists the digest inside it.
 */

import { useState, type ReactNode } from "react";

import type { Attachment } from "@/lib/api-types";
import { apiUrl } from "@/lib/api";
import { formatBytes } from "@/lib/code-tree";
import { Explain } from "@/components/explain";
import { MonoPath, Panel } from "@/components/ui";

/** The route will answer with an image, so an `<img>` is worth attempting. */
function isImage(attachment: Attachment): boolean {
  return attachment.mediaType.startsWith("image/");
}

/**
 * `image/png` -> `PNG`, `text/plain; charset=utf-8` -> `TEXT`.
 *
 * FOR THE EYE ONLY. The full media type is on the row's `title` and in the
 * technical details, because the subtype is what the route actually sends and
 * this collapses `application/vnd.openxmlformats-…` to something readable at
 * 10px. Anything it cannot shorten is shown whole rather than truncated into a
 * word that means something else.
 */
function typeLabel(mediaType: string): string {
  const subtype = mediaType.split(";")[0]?.split("/")[1] ?? "";
  if (subtype === "") return mediaType;
  if (subtype === "plain" || subtype === "markdown") return "TEXT";
  if (subtype.length > 12) return subtype.toUpperCase().slice(0, 12);
  return subtype.toUpperCase();
}

/**
 * Name, type, size — the row every attachment falls back to.
 *
 * ONE COMPONENT FOR BOTH KINDS ON PURPOSE: a document and a reference image
 * whose bytes did not come back are the same fact ("this file is recorded, here
 * is what is known about it"), and giving them two shapes would make a failed
 * image look like a different KIND of thing rather than the same thing in a
 * worse state.
 */
function AttachmentRow({
  attachment,
  note,
}: {
  attachment: Attachment;
  /** Why this row is not an image, when there is a reason worth a sentence. */
  note?: string;
}): ReactNode {
  const href = attachment.url.trim() === "" ? null : apiUrl(attachment.url);

  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{attachment.file}</span>
      <span
        title={attachment.mediaType}
        className="shrink-0 rounded-sm border border-line px-1.5 py-[1px] font-mono text-[9.5px] tracking-[0.08em] text-ink-faint"
      >
        {typeLabel(attachment.mediaType)}
      </span>
      <span className="numeric shrink-0 text-[11px] text-ink-faint">
        {formatBytes(attachment.bytes)}
      </span>
    </>
  );

  return (
    <li className="min-w-0">
      {href === null ? (
        <div className="flex min-w-0 items-center gap-2 rounded border border-line bg-canvas/40 px-2.5 py-2">
          {body}
        </div>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={`Open ${attachment.file} (${attachment.mediaType}) in a new tab`}
          className="flex min-w-0 items-center gap-2 rounded border border-line bg-canvas/40 px-2.5 py-2 transition-colors duration-150 hover:border-line-strong hover:bg-surface-raised active:translate-y-[1px]"
        >
          {body}
        </a>
      )}
      {note !== undefined && (
        <p className="mt-1 px-1 text-[11.5px] leading-snug text-ink-dim">{note}</p>
      )}
    </li>
  );
}

/**
 * A thumbnail, or the row — never a broken frame.
 *
 * `failed` is one-way. A `src` that 404s once will 404 again on the same render
 * pass, and re-attempting on every re-render is how a panel gets a request loop
 * on a tab the reader left open.
 */
function AttachmentImage({ attachment }: { attachment: Attachment }): ReactNode {
  const [failed, setFailed] = useState(false);
  const src = attachment.url.trim() === "" ? null : apiUrl(attachment.url);

  if (src === null || failed) {
    return (
      <AttachmentRow
        attachment={attachment}
        note={
          // BOTH SENTENCES SHORTENED, 2026-08-05, and both still name the two
          // facts a reader needs: why there is no picture, and that the path is
          // below. The deleted words ("on this API", "in the technical
          // details") described where the panel looks rather than what the
          // reader does next.
          src === null
            ? "No address for this file, so it cannot be shown. Its path is below."
            : "These bytes did not come back. The file's path is below."
        }
      />
    );
  }

  return (
    <li className="min-w-0">
      <figure className="min-w-0 overflow-hidden rounded border border-line bg-surface-raised">
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          title={`Open ${attachment.file} full size in a new tab`}
          className="block w-full cursor-zoom-in"
        >
          {/* The name is the server's ordinal, so it describes nothing; the alt
              text says what the file IS to this run instead. */}
          {/*
           * `object-contain`, CAPPED, NOT `object-cover` — THE OPPOSITE CALL TO
           * `design-lock.tsx`, ON PURPOSE.
           *
           * A mockup card grid crops to a uniform 156px because those five
           * images are the SAME shape and the grid is a comparison. These are
           * the owner's own uploads and their aspect is unknown: a design board
           * is wide, a phone screenshot is tall, a scanned page is A4. Cropping
           * one answers "what did I hand it" with a lie about the top third of
           * it. So the whole image renders inside a 200px cap at its own shape;
           * the cost is uneven cell heights, which `items-start` absorbs.
           */}
          <img
            src={src}
            alt={`Reference image uploaded with this ticket, stored as ${attachment.file}`}
            loading="lazy"
            onError={() => setFailed(true)}
            className="mx-auto block max-h-[200px] w-auto max-w-full bg-canvas object-contain"
          />
        </a>
        <figcaption className="flex min-w-0 items-center justify-between gap-2 border-t border-line px-2 py-1.5">
          <span className="min-w-0 truncate text-[11.5px] text-ink" title={attachment.file}>
            {attachment.file}
          </span>
          <span className="numeric shrink-0 text-[10.5px] text-ink-faint">
            {formatBytes(attachment.bytes)}
          </span>
        </figcaption>
      </figure>
    </li>
  );
}

function GroupHeading({ children }: { children: ReactNode }): ReactNode {
  return (
    <h3 className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
      {children}
    </h3>
  );
}

export function TicketAttachmentsPanel({
  references,
  documents,
}: {
  /**
   * `run.references ?? []` — REQUIRED rather than optional, so the caller has
   * to state what an old run means. `exactOptionalPropertyTypes` is on, so an
   * optional prop here would refuse the `undefined` the flattening exists for.
   */
  references: readonly Attachment[];
  /** `run.documents ?? []`, same contract. */
  documents: readonly Attachment[];
}): ReactNode {
  const total = references.length + documents.length;
  // NOTHING, not an empty panel. See the header: this is the state of every run
  // on this machine today.
  if (total === 0) return null;

  return (
    <Panel
      title="Uploaded with this ticket"
      subtitle={
        <>
          {/*
           * ONE STRING, NOT AN INTERPOLATED SENTENCE. The first spelling was
           * `file{n === 1 ? "" : "s"} the owner…` and rendered "4 filesthe
           * owner" in the browser — JSX ate the space after the expression, and
           * it was invisible in the source. Anything with a count in it is built
           * here where a template literal can be read straight through.
           */}
          {`${String(total)} file${total === 1 ? "" : "s"} attached to this ticket. `}
          {/* THE ONE SENTENCE THAT KEEPS THE TWO KINDS APART IN WORDS. The
              structural separation is the panel; this is what a reader who
              remembers seeing images elsewhere needs in order to place them.

              IT NAMES WHERE THEY ACTUALLY ARE, CHECKED RATHER THAN ASSUMED:
              `ScreenshotsPanel` is mounted by `ResultPanel` (canvas/sheet.tsx),
              and its disclosures are headed "Design references (n)". Pointing at
              a surface that no longer exists — this sentence said "the Verdict
              tab" until 2026-08-05 — is worse than saying nothing, because the
              reader goes looking for it. */}
          <span className="text-ink-dim">
            Not the design references under Result — those are mockups
            ui-designer generated for this run.
          </span>
        </>
      }
    >
      <div className="space-y-3">
        {references.length > 0 && (
          <section className="space-y-1.5">
            {/*
             * THE TWO SENTENCES THAT WERE A PARAGRAPH HERE ARE NOW BEHIND THE
             * "i", 2026-08-05 — MOVED, NOT DELETED. They change what a reader
             * concludes from a run that ignored a reference (the paths WERE
             * handed over; opening them is not guaranteed), so they may be
             * hidden and may not be cut.
             *
             * THE CLAIM ABOUT THE SERVER IS UNCHANGED AND WAS TRACED TO THE LINE
             * RATHER THAN ASSUMED. `designReferenceSection` (server
             * ticket-refs.ts:588) and `builderReferenceSection` (:530) both do
             * `...refs.images.map(image => image.path)` — a plain iteration of
             * the manifest's image list with no filter — and
             * `RunDetail.references` is folded from that same list. So every row
             * in this group really does have its path in both prompts. The
             * second sentence is there because a path in a prompt is not a read:
             * ticket-refs.ts's own header says the block is "art direction that
             * is likely to be followed, not a constraint that is enforced".
             */}
            <GroupHeading>
              reference images ({String(references.length)}), as stored
              <Explain about="reference images" className="ml-1" testId="explain-references">
                Their paths are written into the design and build prompts.
                Whether an agent opened one is answered by this run&rsquo;s
                Activity.
              </Explain>
            </GroupHeading>
            {/* Two-up at the sheet's 560px, matching `ScreenshotsPanel`'s
                references grid rather than inventing a second card size on the
                same screen. `items-start` because a failed image collapses to a
                row and must not stretch its neighbour. */}
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-start gap-2">
              {references.map((attachment) =>
                /*
                 * THE LIST DOES NOT DECIDE THAT SOMETHING IS AN IMAGE, THE MEDIA
                 * TYPE DOES. `RunDetail.references` is folded from the manifest's
                 * image entries, so today every row here is `image/*` — but the
                 * fold is on the server and this file cannot enforce it, and an
                 * `<img>` pointed at a route that answers `application/pdf` is a
                 * broken frame, which is the one outcome the brief rules out. A
                 * non-image spelling degrades to the same named row a document
                 * gets, with the reason on it.
                 */
                isImage(attachment) ? (
                  <AttachmentImage
                    key={attachment.sha256 + attachment.file}
                    attachment={attachment}
                  />
                ) : (
                  <AttachmentRow
                    key={attachment.sha256 + attachment.file}
                    attachment={attachment}
                    note={`Filed as a reference image, but it is ${attachment.mediaType}, so it cannot be shown as one.`}
                  />
                ),
              )}
            </ul>
          </section>
        )}

        {documents.length > 0 && (
          <section className="space-y-1.5">
            {/*
             * SAME MOVE AS THE REFERENCES GROUP, 2026-08-05: this paragraph is
             * now the "i" beside the heading. It is a MOVE and not a cut — the
             * identity half changes what a reader DOES (re-uploading an edited
             * file starts a different ticket with different tests), which is
             * exactly the sentence the affordance exists for.
             *
             * WHAT IS CERTAIN, AND ONLY THAT — unchanged. The fingerprint half
             * is checkable: `referenceIdentityMaterial` folds it into the ticket
             * id. The consumption half is NOT settled in the server's own
             * source: `http.ts`'s intake note says STORED, NOT READ, while
             * `orchestrator.ts#seatDocuments` extracts text and hands it on.
             * This panel refuses to decide that argument and says where the
             * answer lives instead.
             */}
            <GroupHeading>
              documents ({String(documents.length)}), as stored
              <Explain about="documents" className="ml-1" testId="explain-documents">
                Each file&rsquo;s fingerprint is part of this ticket&rsquo;s
                identity, so changing one makes it a different ticket with tests
                of its own. Whether an agent was handed the text inside is
                answered by this run&rsquo;s Activity.
              </Explain>
            </GroupHeading>
            <ul className="space-y-1.5">
              {documents.map((attachment) => (
                <AttachmentRow key={attachment.sha256 + attachment.file} attachment={attachment} />
              ))}
            </ul>
          </section>
        )}

        {/*
         * THE HOST PATHS AND THE DIGESTS, SHUT BY DEFAULT — the same disclosure
         * `ScreenshotsPanel` ends with, for the same reason: `path` is what a
         * log line or a bug report has to be matched against, and it is not
         * openable from a page. The digest is here because it is the value that
         * entered the ticket id, which is the only thing on this panel that can
         * explain why two runs with identical text got different suites.
         */}
        <details className="rounded border border-line bg-canvas/40">
          <summary className="cursor-pointer px-3 py-2 text-[11.5px] text-ink-dim marker:text-ink-faint">
            Where these files are on disk
          </summary>
          <ul className="space-y-2 px-3 pb-3">
            {[...references, ...documents].map((attachment) => (
              <li key={attachment.sha256 + attachment.file} className="min-w-0 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="shrink-0 text-[11px] text-ink-faint">{attachment.file}</span>
                  <MonoPath path={attachment.path} max={38} />
                </div>
                <div className="numeric truncate font-mono text-[10.5px] text-ink-faint">
                  {attachment.mediaType} · sha256 {attachment.sha256.slice(0, 16)}
                </div>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Panel>
  );
}
