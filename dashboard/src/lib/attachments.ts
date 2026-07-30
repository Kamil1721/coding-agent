/**
 * attachments.ts — ONE declaration of what may be attached, for both intakes.
 *
 * WHY THIS FILE EXISTS: IT WAS TWO HAND COPIES. `Attachment`, `readAsDataUrl`,
 * `MAX_IMAGES`/`MAX_REFERENCE_IMAGES` and `MAX_IMAGE_BYTES` were declared once in
 * `components/canvas/orchestrator-chat.tsx` and again in `app/page.tsx`, with
 * nothing keeping them in step — the previous phase said so in `page.tsx`'s own
 * comment and left it as a handoff. The two copies had ALREADY drifted in the way
 * that matters: the chat filtered on `type.startsWith("image/")` under a comment
 * claiming it "matches the server's caps", while `decodeReferenceDataUrl`
 * (`server/src/ticket-refs.ts:113`) accepts exactly png/jpeg/jpg/webp/gif — so an
 * SVG passed the chat's pre-flight, was uploaded, and came back 400. That filter
 * is gone; both surfaces now decide with {@link planAttachmentIntake}.
 *
 * WHY THE LISTS ARE TRANSCRIBED AND NOT IMPORTED, WHICH IS THE HONEST SEAM HERE.
 * A cross-package import IS possible in this app and is not a blanket taboo —
 * `src/lib/graph.ts` imports the server's reducer into the browser bundle and
 * explains at length why it can — but `server/src/document-intake.ts` imports
 * `node:fs`, `node:path` and `bakeoff/dist/redact.js` AT MODULE SCOPE, so pulling
 * it in would drag Node built-ins into a client component. `ticket-refs.ts` is
 * worse still (it writes files). So the caps and the media types below are a
 * TRANSCRIPTION of two server declarations:
 *
 *   images     `server/src/ticket-refs.ts`  — `MAX_REFERENCE_IMAGES`,
 *              `MAX_REFERENCE_IMAGE_BYTES`, and the alternation inside
 *              `decodeReferenceDataUrl`'s regex;
 *   documents  `server/src/document-intake.ts` — `MAX_REFERENCE_DOCUMENTS`,
 *              `MAX_DOCUMENT_BYTES`, and the `ACCEPTED` media-type → extension
 *              map.
 *
 * NOTHING IN THE TYPE SYSTEM KEEPS THE TRANSCRIPTION HONEST. What does is
 * `tests/document-intake.browser.spec.ts`, which reads both server files AS TEXT
 * and fails when a type, an extension or a cap here stops matching the one there.
 * That test also asserts its own anchors matched, so a renamed declaration fails
 * as "the declaration moved" rather than silently comparing against nothing.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not post anything, does not know which
 * route an attachment is bound for, and — importantly — makes no claim about who
 * READS an attachment. `api-types.ts` is explicit that a ticket document's bytes
 * are stored and folded into the ticket id, while whether a seat is shown it is
 * decided by the server's build/spec wiring; and that a CHAT document is stored
 * and NOT delivered to the running agent at all. Copy that says "attached" must
 * not be written to mean "the run has read your scope".
 */

/**
 * WHICH INTAKE A FILE BELONGS TO — and therefore which cap, which array on the
 * wire (`references` vs `documents`) and which chip it renders as.
 */
export type AttachmentKind = "image" | "document";

export interface Attachment {
  readonly name: string;
  readonly kind: AttachmentKind;
  /** Normalised: lower-cased, parameters stripped. `""` never reaches here. */
  readonly mediaType: string;
  /** `data:application/pdf;base64,…` — what both routes take. */
  readonly dataUrl: string;
}

/**
 * The three facts {@link planAttachmentIntake} needs from a picked file.
 *
 * STRUCTURAL, NOT `File`, SO THE PLANNER IS TESTABLE OUTSIDE A BROWSER. A DOM
 * `File` satisfies it, so call sites pass one unchanged; a spec passes an object
 * literal and exercises the caps and refusals with no page at all. The planner is
 * where every silent-drop bug in this feature would live, so it is deliberately
 * the part that does not need a browser to reach.
 */
export interface AttachmentCandidate {
  readonly name: string;
  /** The browser's reported MIME type. May be `""`; see {@link normalizeMediaType}. */
  readonly type: string;
  /** DECODED bytes — the same quantity both servers cap. */
  readonly size: number;
}

/* -------------------------------------------------------------------------
 * The caps, transcribed. See the header for the seam and the test that guards it.
 * ---------------------------------------------------------------------- */

/** `ticket-refs.ts#MAX_REFERENCE_IMAGES`. */
export const MAX_REFERENCE_IMAGES = 6;

/** `ticket-refs.ts#MAX_REFERENCE_IMAGE_BYTES` — DECODED, not base64 length. */
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

/** `document-intake.ts#MAX_REFERENCE_DOCUMENTS`. Four, not six — see its docblock. */
export const MAX_REFERENCE_DOCUMENTS = 4;

/** `document-intake.ts#MAX_DOCUMENT_BYTES` — DECODED. Higher than the image cap: scans. */
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

/**
 * The image types `decodeReferenceDataUrl`'s regex accepts, written out.
 *
 * `image/jpg` IS IN THE SERVER'S ALTERNATION as well as `image/jpeg`, and both
 * are here: a browser has been observed to report either, and a file the server
 * would take must not be refused before it is offered one.
 */
export const ACCEPTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/**
 * The document types the server accepts, mapped to the extension it stores each
 * under — the whole of `document-intake.ts`'s `ACCEPTED`, values included.
 *
 * THE VALUES ARE NOT DECORATION: they are what a document chip shows as its tag,
 * so a `.docx` renders `DOCX` rather than a guess derived from a 71-character
 * OOXML media type. Transcribing the map rather than the keys also means the
 * parity test can catch a server-side rename of the extension, which would
 * otherwise change where the bytes land on disk with no client-visible symptom.
 *
 * BOTH RTF SPELLINGS ARE HERE because both are emitted in the wild.
 */
export const ACCEPTED_DOCUMENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/csv", "csv"],
  ["application/json", "json"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/msword", "doc"],
  ["application/rtf", "rtf"],
  ["text/rtf", "rtf"],
]);

/* -------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------- */

/**
 * `text/plain;charset=utf-8` → `text/plain`.
 *
 * THE SERVER DOES THE SAME THING TO THE DATA URL (`decodeDocumentDataUrl` parses
 * parameters off and compares lower-cased), so a file the browser labels with a
 * charset must not be refused here for a difference the server ignores.
 *
 * AN EMPTY TYPE STAYS EMPTY AND IS REFUSED. The OS reports no MIME type for some
 * extensions (`.md` on some platforms), and guessing one from the filename would
 * be this client claiming a type the server will not agree with — the upload
 * would come back `invalid_document` after the round trip. Refusing up front
 * names the missing type instead.
 */
export function normalizeMediaType(raw: string): string {
  const [head = ""] = raw.split(";");
  return head.trim().toLowerCase();
}

/** Which intake this media type belongs to, or `null` when neither accepts it. */
export function attachmentKind(mediaType: string): AttachmentKind | null {
  if (ACCEPTED_IMAGE_TYPES.has(mediaType)) return "image";
  if (ACCEPTED_DOCUMENT_TYPES.has(mediaType)) return "document";
  return null;
}

/**
 * The short uppercase tag on a document chip — `PDF`, `DOCX`, `MD`.
 *
 * `FILE` IS THE FALLBACK AND SHOULD BE UNREACHABLE: nothing becomes an
 * `Attachment` of kind `document` without a hit in {@link ACCEPTED_DOCUMENT_TYPES}.
 * It is not an assertion, because a tag is not worth throwing in a render.
 */
export function documentTag(attachment: Attachment): string {
  return (ACCEPTED_DOCUMENT_TYPES.get(attachment.mediaType) ?? "file").toUpperCase();
}

/** `png, jpeg, jpg, webp, gif` — derived, so a refusal cannot list a stale set. */
const IMAGE_EXTENSIONS = [...ACCEPTED_IMAGE_TYPES]
  .map((type) => type.slice(type.indexOf("/") + 1))
  .join(", ");

/** `pdf, txt, md, csv, json, docx, doc, rtf` — the map's values, de-duplicated. */
const DOCUMENT_EXTENSIONS = [...new Set(ACCEPTED_DOCUMENT_TYPES.values())].join(", ");

/* -------------------------------------------------------------------------
 * Planning an intake
 * ---------------------------------------------------------------------- */

/**
 * ONE FIELD, WHICH IS BOTH THE POLICY AND THE SENTENCE.
 *
 * `null` means documents are accepted. A STRING means they are refused, and it is
 * the refusal shown to the owner — so a surface that cannot carry a document
 * cannot switch the intake off without also saying why. That coupling is the
 * point: a boolean flag would let a control go quietly inert, which is the
 * failure this whole feature is being built to stop happening elsewhere.
 */
export interface IntakePolicy {
  readonly documentsRefused: string | null;
}

/** The default: both kinds accepted. */
export const OPEN_INTAKE: IntakePolicy = { documentsRefused: null };

/**
 * The `accept` attribute for a file input.
 *
 * IT IS A HINT, NOT A CONTROL: every browser offers "all files" past it, drag and
 * drop ignores it entirely, and a paste has no dialog at all. So it narrows the
 * picker and nothing more — {@link planAttachmentIntake} is what actually decides,
 * on all three intakes.
 */
export function acceptAttribute(policy: IntakePolicy = OPEN_INTAKE): string {
  const types = [...ACCEPTED_IMAGE_TYPES];
  if (policy.documentsRefused === null) types.push(...ACCEPTED_DOCUMENT_TYPES.keys());
  return types.join(",");
}

export interface IntakePlan<T> {
  /** The files to read. Never longer than the room that was actually left. */
  readonly take: readonly T[];
  /**
   * Every reason something was NOT taken, in one string, or `null` when nothing
   * was refused. Never empty, and never `""`.
   */
  readonly refusal: string | null;
}

/**
 * `8 MB`, `13.5 MB` — one decimal, and no decimal when it is round.
 *
 * A CAP IS ROUNDED TO NEAREST AND A FILE IS ROUNDED UP, which is not fussiness:
 * one byte over 12 MB rounds to `12` both ways, and the refusal then reads
 * "huge.pdf is 12 MB and the limit is 12 MB" — a sentence that looks like a bug
 * in the form rather than a fact about the file, on the one file the owner most
 * wants an explanation for. Rounding the file up makes the two numbers differ
 * whenever the comparison did.
 */
function megabytes(bytes: number): string {
  return `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

function megabytesUp(bytes: number): string {
  return `${String(Math.ceil((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

/** `2 of these were not attached.` — and `1 of these was`. */
function droppedTail(count: number): string {
  return `${String(count)} of these ${count === 1 ? "was" : "were"} not attached.`;
}

/**
 * Decide what to attach out of a paste, a drop or a picker — and say what was not.
 *
 * NO REFUSAL IS SILENT, AND THAT IS THE WHOLE JOB. The chat's previous intake
 * ended in `.slice(0, MAX_IMAGES)` with no message, so dropping eight files
 * discarded two with the owner seeing six chips and no way to learn the other two
 * were ever read. Everything below counts what it drops and names it.
 *
 * THE TWO CAPS ARE COUNTED SEPARATELY, WHICH IS NOT A DETAIL. Six images and four
 * documents are six and four, not ten against one limit: the server holds two
 * independent caps (`MAX_REFERENCE_IMAGES` in `ticket-refs.ts`,
 * `MAX_REFERENCE_DOCUMENTS` in `document-intake.ts`) and a combined count here
 * would refuse a request the API would have accepted. There is a test that
 * attaches six of one and four of the other and expects all ten.
 *
 * EVERY REASON IS REPORTED, not just the last. The previous version had a single
 * error slot, so an SVG dropped alongside seven PNGs set the wrong-type message
 * and then overwrote it with the over-the-limit one; the reasons are collected
 * and joined instead. They are ordered by kind of problem, not by file order,
 * because a reader wants "what happened to my files" and not a transcript.
 *
 * SIZE IS CHECKED BEFORE ROOM, deliberately: a 40 MB PDF that is also the fifth
 * document should be reported as too large, which the owner can fix by attaching
 * a smaller file, rather than as overflow, which they would fix by removing a
 * different one.
 *
 * WHAT IT DOES NOT CHECK: that the bytes are what the type says. Neither server
 * does either (both say so), and a browser cannot without reading the file, which
 * is the expensive half. A `.zip` renamed `.pdf` is refused by `pdftotext` on the
 * server with a named extraction failure — not silently treated as text.
 */
export function planAttachmentIntake<T extends AttachmentCandidate>(
  files: readonly T[],
  existing: readonly Attachment[],
  policy: IntakePolicy = OPEN_INTAKE,
): IntakePlan<T> {
  const take: T[] = [];
  const wrongType: string[] = [];
  const empty: string[] = [];
  const tooBig: string[] = [];
  const documentsOff: string[] = [];
  let imagesDropped = 0;
  let documentsDropped = 0;

  let imageRoom =
    MAX_REFERENCE_IMAGES - existing.filter((one) => one.kind === "image").length;
  let documentRoom =
    MAX_REFERENCE_DOCUMENTS - existing.filter((one) => one.kind === "document").length;

  for (const file of files) {
    const mediaType = normalizeMediaType(file.type);
    const kind = attachmentKind(mediaType);
    if (kind === null) {
      wrongType.push(
        `${file.name} (${mediaType === "" ? "no type reported by the browser" : mediaType})`,
      );
      continue;
    }
    if (kind === "document" && policy.documentsRefused !== null) {
      documentsOff.push(file.name);
      continue;
    }
    // Zero bytes is a refusal on both server paths (`decodeReferenceDataUrl`
    // returns null, `decodeDocumentDataUrl` returns code `empty`), so it is one
    // here rather than a chip that 400s on submit.
    if (file.size === 0) {
      empty.push(file.name);
      continue;
    }
    const cap = kind === "image" ? MAX_REFERENCE_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (file.size > cap) {
      tooBig.push(`${file.name} is ${megabytesUp(file.size)} and the limit is ${megabytes(cap)}`);
      continue;
    }
    if (kind === "image") {
      if (imageRoom <= 0) {
        imagesDropped += 1;
        continue;
      }
      imageRoom -= 1;
    } else {
      if (documentRoom <= 0) {
        documentsDropped += 1;
        continue;
      }
      documentRoom -= 1;
    }
    take.push(file);
  }

  const reasons: string[] = [];
  if (wrongType.length > 0) {
    reasons.push(
      `${wrongType.join(", ")} cannot be attached — images are ${IMAGE_EXTENSIONS}; ` +
        `documents are ${DOCUMENT_EXTENSIONS}.`,
    );
  }
  if (documentsOff.length > 0 && policy.documentsRefused !== null) {
    reasons.push(`${documentsOff.join(", ")} — ${policy.documentsRefused}`);
  }
  if (empty.length > 0) {
    reasons.push(
      `${empty.join(", ")} ${empty.length === 1 ? "is" : "are"} empty, so there was ` +
        "nothing to attach.",
    );
  }
  if (tooBig.length > 0) {
    reasons.push(`${tooBig.join("; ")} — not attached.`);
  }
  if (imagesDropped > 0) {
    reasons.push(
      `${String(MAX_REFERENCE_IMAGES)} reference images is the limit, so ${droppedTail(imagesDropped)}`,
    );
  }
  if (documentsDropped > 0) {
    reasons.push(
      `${String(MAX_REFERENCE_DOCUMENTS)} documents is the limit, so ${droppedTail(documentsDropped)}`,
    );
  }

  return { take, refusal: reasons.length === 0 ? null : reasons.join(" ") };
}

/* -------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------- */

/**
 * One picked file as a data URL, tagged with the kind it was accepted as.
 *
 * `FileReader` RATHER THAN `file.arrayBuffer()` + a hand-rolled base64: the API
 * takes `data:<type>;base64,<payload>` and this is the one call that produces
 * exactly that string, including the media type the browser reported. A manual
 * encoder would be a second place for the prefix to be spelled wrong.
 *
 * THE KIND IS RE-DERIVED HERE rather than carried from the plan, so a caller
 * cannot label a PDF as an image by passing it through the wrong list. It falls
 * back to `image` only when the type matches neither set, which
 * {@link planAttachmentIntake} has already refused — an unreachable branch that
 * exists because the alternative is a nullable return every call site must handle
 * for a case that cannot happen.
 */
export function readAttachment(file: File): Promise<Attachment> {
  const mediaType = normalizeMediaType(file.type);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: file.name,
        kind: attachmentKind(mediaType) ?? "image",
        mediaType,
        dataUrl: typeof reader.result === "string" ? reader.result : "",
      });
    };
    reader.onerror = () => {
      reject(new Error(`could not read ${file.name}`));
    };
    reader.readAsDataURL(file);
  });
}

/** The data URLs of one kind, in chip order — which is the order on disk. */
export function dataUrlsOfKind(
  attachments: readonly Attachment[],
  kind: AttachmentKind,
): readonly string[] {
  return attachments.filter((one) => one.kind === kind).map((one) => one.dataUrl);
}
