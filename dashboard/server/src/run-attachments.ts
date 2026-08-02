/**
 * run-attachments.ts — the owner's OWN uploads, as something a browser can open.
 *
 * WHAT WAS BROKEN. A ticket's reference images and documents land on disk under
 * `runs/<id>/references/` and `runs/<id>/documents/`, and the only record of
 * them is `ReferenceImage.path` / `ReferenceDocument.path` — ABSOLUTE HOST
 * PATHS, written for an agent that calls `Read`. Nothing served them over HTTP,
 * so the dashboard could not show the owner the CV and the design board he had
 * just attached; measured this session, the ticket form renders them as bare
 * text chips and `document.querySelectorAll('img')` returns zero elements.
 * This module is the missing half: one place that decides what may be served,
 * what content type it is served as, and what URL says so on `RunDetail`.
 *
 * THE LOOKUP IS THE MANIFEST, NOT THE DIRECTORY, AND THAT IS THE WHOLE SECURITY
 * ARGUMENT OF THIS FILE. `serveScreenshot` in http.ts takes `basename(file)` and
 * joins it under the run's screenshot directory, which is safe THERE because
 * that directory holds nothing but PNGs the harness captured. `references/`
 * holds three different kinds of thing: the owner's uploads, the screenshots
 * `runCapture` writes when a ticket names a page, and `references.json` itself —
 * a manifest of absolute host paths and digests off the owner's machine. A
 * basename-join handler serves all three. Gating on the manifest's own entry
 * list is the only lookup that cannot, and it costs one small JSON parse per
 * request on a loopback socket (`readAdversaryPass` and `readDesignLock` in
 * http.ts already pay the same price per run detail).
 *
 * THE READ NEVER USES THE MANIFEST'S PATH. The manifest supplies the ALLOWED
 * NAMES, the recorded size and the media type; the bytes are always read from
 * `join(<this run's own directory>, file)`. So a manifest entry that somehow
 * named `/etc/passwd` could not redirect the read — its basename would have to
 * also exist inside the run's directory, and the realpath check below would
 * still have to pass.
 *
 * FOUR REFUSALS, IN THIS ORDER, AND THEY ARE NOT INTERCHANGEABLE. (1) the
 * filename allowlist, (2) the manifest membership test, (3) realpath
 * containment AFTER symlink resolution, (4) regular-file.
 *
 * AN EARLIER VERSION OF THIS HEADER SAID "EACH ONE IS SUFFICIENT ALONE …
 * removing any single one leaves the route safe". THAT WAS FALSE, and it was
 * false in the direction that matters — it invited a reader to delete one. The
 * measured negative controls recorded in `api-attachments.test.ts` disprove it
 * twice over. What each one actually covers:
 *
 *   (1) ALLOWLIST — DEFENCE IN DEPTH, AND INDIVIDUALLY REMOVABLE. Every hostile
 *       spelling it refuses is also refused by (2), because a traversal string
 *       is not a name the manifest lists. It earns its place by refusing them
 *       BY NAME, where a test can point at them, and by keeping the route safe
 *       if the lookup is ever changed to something directory-based. Through HTTP
 *       it is unobservable: the WHATWG URL parser in `http.ts` collapses literal
 *       and `%2e%2e` segments before any handler runs, which is why its test
 *       calls it directly.
 *
 *   (2) MEMBERSHIP — LOAD-BEARING, NOT REMOVABLE. Measured: replacing it with
 *       the basename-join `existsSync` shape `serveScreenshot` uses served
 *       `references.json`, `capture-1280.png` and `dropped.png` with HTTP 200.
 *       The first of those is the MANIFEST — absolute host paths and sha256
 *       digests off the owner's machine, sitting in the directory being served.
 *       No other refusal sees it: it is a real, regular file, spelled safely,
 *       resolving inside the run's own directory.
 *
 *   (3) CONTAINMENT — LOAD-BEARING, NOT REMOVABLE, AND ORTHOGONAL TO (2).
 *       Measured: commenting out the `startsWith` line served a planted symlink
 *       named `reference-1.png` pointing outside the run, HTTP 200, carrying the
 *       bait. (2) cannot see it — the manifest really does list that name — and
 *       the traversal test stays GREEN with this line gone, which is why the two
 *       tests are separate.
 *
 *   (4) REGULAR-FILE — A GUARD, NOT A SECURITY REFUSAL, AND UNMEASURED. It
 *       covers a directory or a device node occupying a manifest-listed name;
 *       the failure it prevents is a read that errors mid-response rather than a
 *       disclosure. NO TEST IN `api-attachments.test.ts` NAMES A MUTATION FOR
 *       IT — said here rather than implied, because the sentence this header
 *       replaced implied all four were equally pinned.
 *
 * SO THE LOAD-BEARING COMBINATION IS (2) AND (3) TOGETHER: neither covers the
 * other's case, and each alone leaves a measured leak. (1) and (4) are worth
 * keeping and are not what makes the route safe.
 *
 * EVERY REFUSAL IS 404, NEVER 403. A 403 on "that file is outside the
 * directory" and a 404 on "no such file" together turn this route into an
 * existence oracle for the host filesystem. One status for both means a caller
 * learns nothing it did not already know.
 *
 * ONE DERIVATION OF THE CONTENT TYPE, USED BY BOTH SIDES. `listAttachments`
 * puts it on `ApiAttachment.mediaType` and `resolveAttachment` puts the same
 * string in the `Content-Type` header, because the second one calls the first.
 * A client that decides how to render from the JSON therefore cannot be told one
 * thing and sent another; `api-attachments.test.ts` asserts the two are equal on
 * the wire rather than trusting the call graph to stay this shape.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

import type { ApiAttachment } from "./api-types.js";
import { previewContentType } from "./code-files.js";
import { documentDirFor, manifestDocuments, readReferenceManifest, referenceDirFor } from "./ticket-refs.js";

/**
 * Which of a run's two attachment directories a request means.
 *
 * The strings ARE the URL segments and ARE the directory names, deliberately:
 * `runs/<id>/references/` is served at `/api/runs/<id>/references/`, so there is
 * no mapping table to get out of step.
 */
export type AttachmentKind = "references" | "documents";

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = Object.freeze(["references", "documents"]);

export function isAttachmentKind(value: string): value is AttachmentKind {
  return value === "references" || value === "documents";
}

/**
 * The only filenames this route will look at.
 *
 * Anchored, and the first character may not be a dot, so `..` and `.` are out
 * along with every dotfile. `/`, `\`, `%` and NUL are outside the class, which
 * closes absolute paths, nested paths, percent-encoded separators (`%2f`,
 * `%5c`, `%00`) and the double-decode hole in one line — this module NEVER
 * decodes, and refusing `%` outright means it never has to reason about how many
 * times something upstream did.
 *
 * IT IS THE FIRST OF FOUR REFUSALS AND NOT THE LOAD-BEARING ONE. The manifest
 * membership test below would refuse all of the above anyway; this exists so the
 * route is still safe if the lookup is ever changed to something directory-based
 * and so the hostile spellings are refused by NAME, where a test can point at
 * them. `api-attachments.test.ts` tests it directly for that reason: through
 * HTTP it is unobservable, because the WHATWG URL parser in `http.ts` has
 * already collapsed literal and `%2e%2e` traversal segments before any handler
 * sees them.
 */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeAttachmentFile(file: string): boolean {
  return SAFE_FILE.test(file);
}

/** `runs/<id>/references` or `runs/<id>/documents`, from the two existing declarations. */
function attachmentDirFor(runsRoot: string, runId: string, kind: AttachmentKind): string {
  return kind === "references" ? referenceDirFor(runsRoot, runId) : documentDirFor(runsRoot, runId);
}

/**
 * The same-origin URL that serves one attachment.
 *
 * NEITHER SEGMENT IS PERCENT-ENCODED, AND THAT IS NOT AN OVERSIGHT. Run ids are
 * minted by this process from a timestamp and a uuid, and attachment filenames
 * are minted by the intake as `reference-<n>.<ext>` / `document-<n>.<ext>`, so
 * both are already inside {@link SAFE_FILE}'s character class. Encoding would
 * only ever change a string this route's own allowlist then REFUSES — an escape
 * sequence contains `%`. The agreement is proven on the wire instead: the happy
 * path in `api-attachments.test.ts` fetches the URL this function produced and
 * asserts the bytes come back.
 */
export function attachmentUrl(runId: string, kind: AttachmentKind, file: string): string {
  return `/api/runs/${runId}/${kind}/${file}`;
}

/**
 * The `Content-Type` for a DOCUMENT, from the type the intake recorded.
 *
 * FROM THE RECORD, NOT FROM THE EXTENSION. `document-intake.ts` chooses the
 * stored extension from the media type and collapses both RTF spellings onto
 * `rtf`, so the extension cannot recover which one the browser sent; the
 * manifest's `mediaType` is the only surviving statement of what the bytes are.
 *
 * THE CHARSET IS ADDED FOR TEXT, because the accepted set includes `text/plain`,
 * `text/markdown`, `text/csv` and `application/json` and a browser handed one of
 * those with no charset falls back to a locale default — which renders a UTF-8
 * CV as mojibake. The bytes came in over a JSON body, so UTF-8 is what they are.
 */
function documentContentType(mediaType: string): string {
  const textual = mediaType.startsWith("text/") || mediaType === "application/json";
  return textual ? `${mediaType}; charset=utf-8` : mediaType;
}

/**
 * Everything a run attached in one of its two directories, ready for the wire.
 *
 * READ PER REQUEST, LIKE `readDesignLock` AND `readAdversaryPass`. There is no
 * cache: the manifest is written once by `POST /api/runs` and never mutated, so
 * a cache would only add a second source of truth for a file that is already
 * final by the time any detail request can reach it.
 *
 * AN EMPTY LIST FLATTENS TWO FACTS: nothing was attached, and the manifest could
 * not be read. That is `readReferenceManifest`'s existing flattening and this
 * function does not add a third state — the distinction it preserves is the one
 * that matters to a renderer, which is whether there is anything to show.
 */
export function listAttachments(
  runsRoot: string,
  runId: string,
  kind: AttachmentKind,
): readonly ApiAttachment[] {
  // The manifest lives in `references/` for BOTH kinds — `writeReferenceManifest`
  // has exactly one call site and it passes the reference directory.
  const manifest = readReferenceManifest(referenceDirFor(runsRoot, runId));
  if (manifest === null) return [];
  if (kind === "references") {
    return manifest.images.map((image) => {
      const file = basename(image.path);
      return {
        file,
        path: image.path,
        sha256: image.sha256,
        bytes: image.bytes,
        // An image's manifest entry records no media type — the intake stores
        // png/jpg/webp/gif and the extension it chose is the whole record. The
        // table is `bakeoff`'s, through `previewContentType`, so this route
        // cannot describe a file differently from the preview route.
        mediaType: previewContentType(file),
        url: attachmentUrl(runId, kind, file),
      };
    });
  }
  return manifestDocuments(manifest).map((document) => {
    const file = basename(document.path);
    return {
      file,
      path: document.path,
      sha256: document.sha256,
      bytes: document.bytes,
      mediaType: documentContentType(document.mediaType),
      url: attachmentUrl(runId, kind, file),
    };
  });
}

/** One attachment that passed every refusal, and the bytes' real location. */
export interface ResolvedAttachment {
  readonly file: string;
  /** After `realpathSync`. Proven to be inside the run's own directory. */
  readonly realPath: string;
  /** Byte for byte what `ApiAttachment.mediaType` advertised. */
  readonly contentType: string;
  /** As digested at intake. NOT re-`stat`ed — see {@link attachmentHeaders}. */
  readonly bytes: number;
}

/**
 * Resolve one request to bytes on disk, or refuse.
 *
 * `null` MEANS 404 AND CARRIES NO REASON, deliberately. Callers cannot
 * distinguish "the name was hostile" from "the run has no such attachment" from
 * "it resolved outside the directory", because a caller that could would be an
 * existence oracle for paths outside this run.
 *
 * THE CONTAINMENT CHECK IS ON THE REAL PATH, NOT THE SPELLED ONE, and the root
 * is realpath'd too. `bakeoff/src/tier0.ts:1295` does the same and says why for
 * the scorer: a symlink inside the artefact resolves outside it. Here the
 * escape target is the owner's whole home directory — this process runs as his
 * UID — and the sealed acceptance suite sits two directories above the
 * workspaces. Realpath'ing the ROOT as well is not decoration: on macOS a
 * `mkdtemp` root under `/var/folders/…` realpaths to `/private/var/folders/…`,
 * so comparing a real target against a spelled root would refuse every single
 * request, and comparing a spelled target against a real root would pass for
 * the wrong reason.
 *
 * NO `real === rootReal` ESCAPE HATCH, unlike tier0's version. There the
 * directory itself is a legal answer (it resolves to `index.html`); here it
 * never is, so the prefix test is the whole test.
 */
export function resolveAttachment(
  runsRoot: string,
  runId: string,
  kind: AttachmentKind,
  file: string,
): ResolvedAttachment | null {
  if (!isSafeAttachmentFile(file)) return null;
  // MEMBERSHIP, NOT "THE FIRST ONE". Matching on `file` is what makes the
  // manifest the lookup; taking `[0]` would serve this run's first attachment
  // under ANY spelling and would advertise that entry's media type for it.
  const listed = listAttachments(runsRoot, runId, kind).find((entry) => entry.file === file);
  if (listed === undefined) return null;

  const dir = attachmentDirFor(runsRoot, runId, kind);
  let real: string;
  let rootReal: string;
  try {
    // `file`, NEVER `decodeURIComponent(file)`. The caller hands over the raw
    // URL segment; the allowlist above has no `%` in its class, so decoding here
    // would turn `%2e%2e%2f` back into `../` AFTER the one refusal that reads the
    // spelling has already passed it.
    real = realpathSync(join(dir, file));
    rootReal = realpathSync(dir);
  } catch {
    // Absent, or a broken symlink, or unreadable. All three are "no such file".
    return null;
  }
  if (!real.startsWith(rootReal + sep)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return { file, realPath: real, contentType: listed.mediaType, bytes: listed.bytes };
}

/** Rendered in place by the browser rather than pushed to the downloads folder. */
function rendersInline(contentType: string): boolean {
  return contentType.startsWith("image/") || contentType === "application/pdf";
}

/**
 * The headers one attachment is served with.
 *
 * NO `Content-Length`, so the response is chunked — the same call
 * `sendPreviewFile` makes, for a weaker version of the same reason: the size on
 * `ApiAttachment.bytes` is the size the intake DIGESTED, and a body that
 * disagrees with its own `Content-Length` is a hung tab rather than a visible
 * error. A re-`stat` here would be a second size that can disagree with the one
 * the ticket id was derived from.
 *
 * `nosniff` IS NOT OPTIONAL HERE, AND THIS IS WHERE THIS ROUTE DIFFERS FROM
 * `serveScreenshot`. That one only ever serves PNGs. The accepted document set
 * includes `text/plain`, `text/markdown`, `text/csv` and `application/json`, and
 * a browser allowed to sniff one of those into HTML would be running the
 * owner's uploaded file as a document on the dashboard's own origin — the origin
 * that can spend his Claude quota. Paired with `Content-Disposition: attachment`
 * for everything that is not an image or a PDF.
 *
 * THE PDF DOES NOT GET `sandbox`, AND THAT IS A REASONED TRADE, NOT A MEASURED
 * ONE. Chrome's built-in PDF viewer is itself a scripted document; a CSP
 * `sandbox` with no `allow-scripts` is the known way to get a blank frame
 * instead of a CV, and showing the owner his CV is the acceptance condition this
 * route exists for. What stops a PDF being read as HTML is the accurate
 * `Content-Type` plus `nosniff`, both of which stay. NOT VERIFIED IN A BROWSER
 * FROM THIS PACKAGE — the check that would settle it is opening a run's document
 * URL in Chrome with and without the directive.
 */
export function attachmentHeaders(resolved: ResolvedAttachment): Record<string, string> {
  const inline = rendersInline(resolved.contentType);
  return {
    "Content-Type": resolved.contentType,
    // The owner can amend a ticket's attachments only by minting a new ticket,
    // so these bytes never change under a URL — but a cached copy of a deleted
    // run's file is worse than a refetch on a loopback socket.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      resolved.contentType === "application/pdf" ? "default-src 'none'" : "default-src 'none'; sandbox",
    "Content-Disposition": inline ? "inline" : `attachment; filename="${resolved.file}"`,
  };
}
