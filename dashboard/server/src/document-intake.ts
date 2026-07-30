/**
 * document-intake.ts — a brief, a scope, a CV: an attached DOCUMENT, decoded,
 * turned into something a seat can actually read, and marked where it was cut.
 *
 * WHAT THE OWNER ASKED FOR. "Say for example i hand it a brief of the project, a
 * scope or a cv or something it will be able to analyse it and use it
 * accordingly so its not just images." Plus: "It needs to be accurate the
 * extraction to capture all the details in a clear and actionable format."
 * Accuracy is the hard half, and everything below is arranged around two
 * measurements taken this session.
 *
 * MEASUREMENT 1 — THE MODEL CAN READ A PDF ITSELF, SO EXTRACTION IS THE
 * FALLBACK AND NOT THE PLAN. A `DocumentBlockParam` carrying a base64 PDF was
 * pushed through the SDK's streaming-input form against the real Claude Code
 * subprocess with the SPEC SEAT's own options (`tools: []`,
 * `settingSources: []`) and came back `success`, having answered a question that
 * required reading table ROW associations correctly. `tools: []` does not block
 * it because a document is CONTENT, not a tool call. That is why this module
 * exposes {@link nativeDocumentBlock} as well as {@link extractDocumentText}: a
 * caller with a PDF inside budget should send the real thing, where layout,
 * tables and page structure survive, and fall back to text only when it cannot.
 *
 * MEASUREMENT 2 — PLAIN EXTRACTION CORRUPTS TABLES, AND ONE FLAG FIXES IT.
 * `pdftotext file.pdf` on a three-column table serialised every column, severing
 * each row's cells from each other: "Discovery" ended up detached from its owner
 * and its budget. `pdftotext -layout` preserved the rows exactly. On a CV that
 * difference silently attaches the wrong dates to the wrong role, which is
 * precisely the "accurate … capture all the details" the owner asked for
 * failing while every status line stays green. {@link pdftotextArgv} is
 * therefore asserted by a test rather than trusted to review.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide which seat sees what, does
 * not write anything to disk, does not touch the ticket id, and does not build
 * an SDK message. Those belong to the callers wiring it up. It also never
 * renders an absolute host path into seat-facing text — see
 * {@link documentPromptText} — which is the rule `ticket-refs.ts` states for the
 * brief and which does not stop being true because the payload is a document.
 *
 * REDACTION, AND EXACTLY HOW FAR IT REACHES. Extracted text is run through
 * `redactForPersistence` (bakeoff/src/redact.ts) — the same chokepoint the
 * owner's chat text goes through at `db.ts:844` and the backlog at
 * `backlog.ts:145` — BEFORE it is truncated, because the rules need minimum
 * spans (`sk-ant-[A-Za-z0-9_-]{16,}`) and cutting a key in half produces a
 * survivor no rule matches, i.e. a credential PREFIX in the prompt, which
 * redact.ts's own header calls a leak. It is PATTERN-BASED: it catches
 * credential SHAPES (PEM blocks, `sk-ant-…`, Stripe/GitHub/AWS/Google/Slack
 * tokens, JWTs, `Authorization:` headers, URL userinfo, `SECRET=…` assignments,
 * high-entropy strings) and the known values of a fixed list of environment
 * variables. IT IS NOT A PII PASS: the name, address, phone number, employer and
 * dates on a CV are not credential-shaped and pass through untouched, by design
 * — they are the document's content and removing them would defeat the feature.
 * A caller must not treat "redacted" as "safe to publish".
 *
 * AND ONE PLACE REDACTION CANNOT REACH: {@link nativeDocumentBlock} carries the
 * ORIGINAL BYTES. `redactForPersistence` is a pass over decoded text and there
 * is no equivalent for a PDF's content streams, so a PDF containing a live key
 * reaches the model unredacted — exactly as an uploaded screenshot of that key
 * already does. The consequence for the caller is stated in that function's
 * docblock: the base64 must not be persisted.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

import { redactForPersistence } from "bakeoff/dist/redact.js";

import { extractorIsUsable, spawnCapture } from "./document-capability.js";
import type { CaptureRunner, DocumentCapability, ExtractorHealth } from "./document-capability.js";

/* -------------------------------------------------------------------------
 * What may be attached, and how much of it
 * ---------------------------------------------------------------------- */

/**
 * How many documents one intake may carry.
 *
 * FOUR, NOT SIX. The image cap is six because six mockups is a plausible art
 * direction; four briefs is already more prose than a spec prompt can hold
 * after {@link DEFAULT_DOCUMENT_PROMPT_CHARS} is applied to each, and the number
 * exists mostly to bound the request envelope below.
 */
export const MAX_REFERENCE_DOCUMENTS = 4;

/**
 * How much ONE document may be, DECODED.
 *
 * RAISED FROM THE IMAGE CAP'S 8 MB TO 12 MB, and the reason is scans: a
 * text-layer PDF brief is usually well under 1 MB, but a scanned scope or a
 * design-heavy deck runs to eight figures of bytes, and refusing it would refuse
 * exactly the documents that most need the native path.
 *
 * THE NUMBER IS CHOSEN SO THE ENVELOPE STAYS THE SIZE THE SERVER ALREADY
 * ACCEPTS: 12 MB × 4/3 is exactly 16 MB of base64, so four of them plus slack is
 * {@link MAX_DOCUMENT_BODY_BYTES} ≈ 64.25 MB — within two bytes of the
 * `MAX_IMAGE_BODY_BYTES` that `http.ts` already allows on the two image routes.
 * See that constant for the handoff a route must honour.
 */
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

/**
 * The request-body cap a route carrying documents MUST pass to `readBody`.
 *
 * DERIVED, NOT TYPED AS A NUMBER, for the reason `http.ts:162` gives: a measured
 * defect lived there, where the documented per-image limit was unreachable by a
 * factor of ten because the route used the 1 MB default envelope, so every
 * attachment over ~750 KB died as "request body too large" while the refusal
 * named a limit no request could reach. A document route that forgets an
 * explicit `maxBytes` reproduces that defect exactly.
 *
 * THIS IS A DOCUMENTS-ONLY BUDGET. A route that carries documents AND images in
 * one request needs the SUM of this and `MAX_IMAGE_BODY_BYTES`, not the larger
 * of the two.
 */
export const MAX_DOCUMENT_BODY_BYTES =
  MAX_REFERENCE_DOCUMENTS * Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 256 * 1024;

/**
 * The largest PDF this module will hand over as a NATIVE document block.
 *
 * A CHOSEN BUDGET, NOT A MEASURED API CEILING, and it is important not to read
 * it as one: the measurement behind the native path proves a PDF works, not how
 * large a PDF may be. The reasons for the number are local and honest — base64
 * inflates 4 MB to ~5.3 MB inside a single JSON message on the CLI subprocess's
 * stdin, and every page additionally costs input tokens on a subscription seat
 * whose budget the run is already spending.
 *
 * A DOCUMENT OVER IT IS NOT DROPPED. It falls back to extraction, which is the
 * whole point of this module having two paths; {@link nativeDocumentBlock} says
 * so by name in its refusal. Callers may pass their own budget.
 */
export const MAX_NATIVE_PDF_BYTES = 4 * 1024 * 1024;

/**
 * The media types accepted, and the extension each one is stored under.
 *
 * AN EXPLICIT MAP RATHER THAN A CHARACTER CLASS, unlike `decodeReferenceDataUrl`
 * whose `image/(png|jpeg|jpg|webp|gif)` alternation is legible. The OOXML type
 * for .docx is
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document` —
 * 71 characters of dots and dashes that no naive pattern survives — and a
 * hand-rolled class is how one of these silently stops matching.
 *
 * BOTH RTF SPELLINGS ARE ACCEPTED. Browsers disagree: `application/rtf` and
 * `text/rtf` are both emitted in the wild for the same file.
 */
const ACCEPTED: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
};

/** The accepted media types, for a refusal message that can list them. */
export const ACCEPTED_DOCUMENT_MEDIA_TYPES: readonly string[] = Object.freeze(Object.keys(ACCEPTED));

/* -------------------------------------------------------------------------
 * Decoding
 * ---------------------------------------------------------------------- */

export interface DecodedDocument {
  readonly ok: true;
  /** Lower-cased, parameters stripped: `text/plain;charset=utf-8` → `text/plain`. */
  readonly mediaType: string;
  /** `pdf`, `docx`, … — what the bytes should be stored under. */
  readonly extension: string;
  readonly bytes: Buffer;
}

/**
 * Why a value was refused. NAMED, so a route can map each to its own message
 * and a test can assert the specific one rather than "it returned null".
 */
export type DocumentRefusalCode =
  | "not-a-string"
  | "not-a-data-url"
  | "unsupported-media-type"
  | "empty"
  | "too-large";

export interface DocumentRefusal {
  readonly ok: false;
  readonly code: DocumentRefusalCode;
  /** A sentence naming the actual cap or the actual type. Never empty. */
  readonly detail: string;
}

export type DocumentDecode = DecodedDocument | DocumentRefusal;

/**
 * `data:application/pdf;base64,…` → the type, the extension and the bytes.
 *
 * A NAMED REFUSAL, WHICH IS AN EXTENSION OF `decodeReferenceDataUrl`'S DIALECT
 * AND NOT A CONTRADICTION OF IT. That function flattens every failure to `null`,
 * and for images that is right: the route has one sentence to say and it lists
 * four extensions. Documents have nine accepted types, two size ceilings and a
 * fallback path, and "the .docx was refused" needs to be distinguishable from
 * "the PDF was 40 MB" — the second is fixable by the owner, the first is not.
 * Everything else here is deliberately identical: same data-URL-not-multipart
 * decision (`secret-intake.ts` is the one multipart parser here and it is
 * narrow), same strict base64 character class, same rule that a decoded length
 * of zero is a refusal.
 *
 * `;charset=…` IS TOLERATED because browsers emit it for text types
 * (`data:text/plain;charset=utf-8;base64,…`); the parameters are parsed off and
 * ignored, and the media type is compared lower-cased.
 *
 * THE MIME TYPE IS NOT VERIFIED AGAINST THE BYTES — the same statement
 * `decodeReferenceDataUrl` makes, with one extra consequence worth naming: a
 * file claiming `application/pdf` that is not one reaches `pdftotext`, which
 * exits 1 with "May not be a PDF file" (measured), and that surfaces as a named
 * extraction failure rather than as text. The size cap is the control that
 * matters; an unbounded base64 body is the only way this endpoint hurts the
 * machine it runs on.
 */
export function decodeDocumentDataUrl(value: unknown): DocumentDecode {
  if (typeof value !== "string") {
    return { ok: false, code: "not-a-string", detail: "a document must be a base64 data URL string" };
  }
  const match = /^data:([^;,]+)((?:;[^;,]+)*);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (match === null) {
    return {
      ok: false,
      code: "not-a-data-url",
      detail:
        "not a base64 data URL of the form data:<media-type>[;charset=…];base64,<payload>. " +
        "Only the standard base64 alphabet is accepted; whitespace or line breaks in the payload are not.",
    };
  }

  const mediaType = (match[1] ?? "").toLowerCase();
  const extension = ACCEPTED[mediaType];
  if (extension === undefined) {
    return {
      ok: false,
      code: "unsupported-media-type",
      detail:
        `${mediaType} is not an accepted document type. Accepted: ` +
        `${ACCEPTED_DOCUMENT_MEDIA_TYPES.join(", ")}.`,
    };
  }

  const bytes = Buffer.from(match[3] ?? "", "base64");
  if (bytes.length === 0) {
    return { ok: false, code: "empty", detail: `the ${mediaType} payload decoded to zero bytes` };
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "too-large",
      detail:
        `the ${mediaType} payload is ${String(bytes.length)} bytes decoded; the limit is ` +
        `${String(MAX_DOCUMENT_BYTES)} bytes`,
    };
  }
  return { ok: true, mediaType, extension, bytes };
}

/* -------------------------------------------------------------------------
 * The native path — primary for PDFs
 * ---------------------------------------------------------------------- */

/**
 * A base64 PDF as the API's `document` content block.
 *
 * DECLARED STRUCTURALLY HERE RATHER THAN IMPORTED. The real type is
 * `DocumentBlockParam` from `@anthropic-ai/sdk/resources`, which is a
 * TRANSITIVE dependency (the agent SDK's `sdk.d.ts` imports it) and not
 * something `dashboard-server/package.json` declares — importing it from `src`
 * would make this module depend on a package no lockfile entry of ours pins.
 * The shape is instead asserted assignable to `DocumentBlockParam` inside
 * `document-intake.test.ts`, where the import is a test-only concern and where
 * `npm run build` turns any SDK drift into a compile error rather than a comment
 * that has quietly gone out of date.
 */
export interface NativeDocumentBlock {
  readonly type: "document";
  readonly source: {
    readonly type: "base64";
    readonly media_type: "application/pdf";
    /** Standard base64, no data-URL prefix. The API takes the payload alone. */
    readonly data: string;
  };
  /** What the model should call it. Never a host path — see `title` below. */
  readonly title: string;
}

export type NativeDecision =
  | { readonly kind: "native"; readonly block: NativeDocumentBlock; readonly bytes: number }
  | {
      readonly kind: "declined";
      readonly code: "not-a-pdf" | "over-native-budget";
      readonly detail: string;
    };

export interface NativeBlockOptions {
  /**
   * The document's display name. Defaults to "document". A caller passing a
   * filename should pass a BASENAME: this string goes to the model, and an
   * absolute host path in seat-facing content is the thing `ticket-refs.ts`
   * forbids for the brief.
   */
  readonly title?: string;
  readonly budgetBytes?: number;
}

/**
 * Turn decoded bytes into a native document block, or say why not.
 *
 * PDF ONLY, AND THAT IS NOT AN OVERSIGHT. `DocumentBlockParam`'s base64 source
 * is typed `media_type: 'application/pdf'` — there is no base64 .docx source —
 * so a Word file has no native form and must go through `textutil`. Plain text
 * could travel as a `PlainTextSource` block, but it is already text: putting it
 * in the prompt via {@link documentPromptText} keeps ONE truncation rule and one
 * place where the cut is marked, rather than two paths with different silence.
 *
 * THE BYTES ARE NOT REDACTED AND CANNOT BE — see the file header. A caller must
 * therefore treat `block.source.data` as transient: it may be handed to the
 * model, and it must NOT be written to SQLite, the event stream or a report.
 * `redactForPersistence` would not save such a write; it is a text pass and this
 * is a base64 blob it will simply see as one long high-entropy token.
 */
export function nativeDocumentBlock(
  document: DecodedDocument,
  options: NativeBlockOptions = {},
): NativeDecision {
  const budget = options.budgetBytes ?? MAX_NATIVE_PDF_BYTES;
  if (document.mediaType !== "application/pdf") {
    return {
      kind: "declined",
      code: "not-a-pdf",
      detail:
        `${document.mediaType} has no native base64 document form (the API's base64 document source is ` +
        "application/pdf only). Use extractDocumentText for it.",
    };
  }
  if (document.bytes.length > budget) {
    return {
      kind: "declined",
      code: "over-native-budget",
      detail:
        `the PDF is ${String(document.bytes.length)} bytes and the native budget is ${String(budget)}. ` +
        "Fall back to extractDocumentText; the document is not dropped.",
    };
  }
  return {
    kind: "native",
    bytes: document.bytes.length,
    block: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: document.bytes.toString("base64"),
      },
      title: options.title ?? "document",
    },
  };
}

/* -------------------------------------------------------------------------
 * The fallback path — extraction
 * ---------------------------------------------------------------------- */

/** Which extractor a media type needs, or `inline` when the bytes are text. */
export type ExtractionRoute = "pdftotext" | "textutil" | "inline";

/**
 * `application/json` and `text/*` are read directly, with NO subprocess: they
 * are already text, and spawning something to `cat` them would add a failure
 * mode (and a capability requirement) to the one case that has neither.
 */
export function routeFor(mediaType: string): ExtractionRoute | null {
  if (mediaType === "application/pdf") return "pdftotext";
  if (
    mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mediaType === "application/msword" ||
    mediaType === "application/rtf" ||
    mediaType === "text/rtf"
  ) {
    return "textutil";
  }
  if (mediaType === "application/json" || mediaType.startsWith("text/")) return "inline";
  return null;
}

/**
 * THE PDF ARGV. Three operands, and each one is load-bearing.
 *
 *   `-layout`   MEASUREMENT 2 in the file header. Without it a three-column
 *               table is serialised column-first and every row's cells are
 *               separated from each other. A CV's roles get the wrong dates and
 *               nothing anywhere reports a problem.
 *   `-enc UTF-8` The output encoding. Measured identical to the default on
 *               poppler 26.04.0, and passed explicitly because that default is a
 *               build-time setting of a HOST binary we do not control; an
 *               accented name silently mojibaking is the failure it prevents.
 *   the trailing `-`  The output operand, meaning stdout. THIS IS NOT
 *               COSMETIC: measured, `pdftotext -layout table.pdf` exits 0,
 *               writes NOTHING to stdout, and creates `table.txt` NEXT TO THE
 *               INPUT — during this session it silently overwrote a file of that
 *               name. Omitting it therefore both loses the text and writes into
 *               the run's own directory.
 *
 * EXPORTED SO A TEST CAN ASSERT THE ARGV ITSELF. A unit test cannot depend on a
 * real PDF being present, so the argv is the only part of this that can be
 * pinned without one — and it is the part that silently corrupts data.
 */
export function pdftotextArgv(path: string): readonly string[] {
  return ["-layout", "-enc", "UTF-8", path, "-"];
}

/**
 * THE OFFICE ARGV. `-stdout` is the same operand decision as the PDF's `-`:
 * without it `textutil -convert txt <file>` writes `<file>.txt` beside the
 * input instead of answering.
 */
export function textutilArgv(path: string): readonly string[] {
  return ["-convert", "txt", "-stdout", path];
}

/** Why a document produced no text. Every one is a sentence in `detail` too. */
export type DocumentDegradationCode =
  | "extractor-not-probed"
  | "extractor-unavailable"
  | "extractor-failed"
  | "extractor-timed-out"
  | "no-text-extracted"
  | "unreadable-file"
  | "unsupported-media-type";

export interface DocumentDegradation {
  readonly code: DocumentDegradationCode;
  readonly detail: string;
}

export interface ExtractedDocument {
  /**
   * The host path this came from. BUILDER-FACING ONLY, and never rendered by
   * {@link documentPromptText} — that function prints {@link label}.
   */
  readonly path: string;
  readonly mediaType: string;
  /** What produced the text, or `none` when nothing did. */
  readonly via: ExtractionRoute | "none";
  /**
   * The document as text, ALREADY REDACTED and NOT yet truncated.
   *
   * `""` IF AND ONLY IF `degraded !== null`. There is a test on that implication
   * in both directions, because an empty string with no reason attached is the
   * exact silent failure this module exists to prevent.
   */
  readonly text: string;
  readonly degraded: DocumentDegradation | null;
  /** The extractor's output hit the byte bound and the child was killed. */
  readonly outputCapped: boolean;
  /** Basename of `path`, redacted. What the model is told the document is called. */
  readonly label: string;
}

/**
 * How long one extraction may take before the child is killed.
 *
 * A 400-PAGE PDF MUST NOT HANG A REQUEST — the brief's words, and the reason
 * both bounds exist. 20 s matches the kill timer `design-capability.ts` uses for
 * its preflight spawns; poppler does a hundred pages in well under a second, so
 * this budget is for the pathological file, not the large one.
 */
export const EXTRACT_TIMEOUT_MS = 20_000;

/**
 * Hard bound on an extractor's stdout. ~4 MB of text is on the order of 700,000
 * words — far past anything {@link documentPromptText} will show — so hitting it
 * means the file is pathological, and `outputCapped` records that it was cut at
 * the extractor rather than at the prompt.
 */
export const MAX_EXTRACT_BYTES = 4 * 1024 * 1024;

export interface ExtractOptions {
  /** Injected so the failure branches are reachable without a real PDF. */
  readonly run?: CaptureRunner;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * Read a document as text, or say — by name — why it could not be read.
 *
 * THE CAPABILITY IS CONSULTED BEFORE ANYTHING IS SPAWNED, and `not-probed` is
 * treated as its own refusal rather than folded into "unavailable": a caller
 * that forgot to probe has a different bug from a machine without poppler, and
 * flattening them would send someone to `brew install` for a wiring mistake.
 *
 * NEVER THROWS AND NEVER RETURNS A BARE `""`. Every failure path sets
 * {@link ExtractedDocument.degraded} with a code and a sentence.
 */
export async function extractDocumentText(
  path: string,
  mediaType: string,
  capability: DocumentCapability,
  options: ExtractOptions = {},
): Promise<ExtractedDocument> {
  const label = redactForPersistence(basename(path));
  const base = { path, mediaType, label } as const;
  const route = routeFor(mediaType);

  if (route === null) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: false,
      degraded: {
        code: "unsupported-media-type",
        detail: `${mediaType} has no extraction route in this module`,
      },
    };
  }

  if (route === "inline") return readInline(base, options.maxBytes ?? MAX_EXTRACT_BYTES);

  const health: ExtractorHealth = route === "pdftotext" ? capability.pdftotext : capability.textutil;
  if (!extractorIsUsable(health)) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: false,
      degraded: {
        code: health.state === "not-probed" ? "extractor-not-probed" : "extractor-unavailable",
        // The probe's own sentence, verbatim. Re-spelling it here would produce
        // a second, worse explanation of the same machine state — the reason
        // `health-gate.ts` reuses `describeError` instead of writing its own.
        detail: health.detail,
      },
    };
  }

  const argv = route === "pdftotext" ? pdftotextArgv(path) : textutilArgv(path);
  const result = await (options.run ?? spawnCapture)(route, argv, {
    timeoutMs: options.timeoutMs ?? EXTRACT_TIMEOUT_MS,
    maxStdoutBytes: options.maxBytes ?? MAX_EXTRACT_BYTES,
  });

  if (result.timedOut) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: result.capped,
      degraded: {
        code: "extractor-timed-out",
        detail:
          `${route} did not finish within ${String(options.timeoutMs ?? EXTRACT_TIMEOUT_MS)} ms and was ` +
          "killed. Any text it had already written is discarded: a half-read document read as a whole " +
          "one is worse than none, because nothing downstream would know it stopped early.",
      },
    };
  }
  /*
   * THE ORDER OF THESE TWO CHECKS IS LOAD-BEARING, and getting it wrong cost
   * this module a defect that 47 green tests did not see.
   *
   * When stdout hits the byte bound, `spawnCapture` SIGKILLs the child, `close`
   * fires with a null code and `CaptureResult.code` becomes 1 — measured, three
   * runs out of three. Checked in the other order, a capped extraction is
   * indistinguishable from `pdftotext` rejecting the file, so 4 MB of perfectly
   * good text is discarded and reported as `extractor-failed`. Worse, it is
   * INTERMITTENT: a final chunk landing exactly on the bound can leave the child
   * already exited 0, so the same document comes back two different ways.
   *
   * WHY CAPPED KEEPS ITS TEXT WHILE TIMED-OUT DISCARDS ITS OWN. A cap is a cut
   * this server made at a known byte, with a known quantity of complete text
   * behind it, and `outputCapped` carries that fact all the way into the prompt.
   * A timeout is a tool that stopped somewhere unknown — possibly mid-write —
   * and nothing downstream could tell how much of the document it represents.
   */
  if (result.capped && result.stdout.length > 0) {
    const cappedText = redactForPersistence(result.stdout);
    if (hasVisibleText(cappedText)) {
      return { ...base, via: route, text: cappedText, outputCapped: true, degraded: null };
    }
  }
  if (result.spawnError !== null || result.code !== 0) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: false,
      degraded: {
        code: "extractor-failed",
        detail:
          `${route} exited ${String(result.code)}` +
          (result.spawnError === null ? "" : ` (${result.spawnError})`) +
          (result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().slice(0, 400)}`),
      },
    };
  }

  const text = redactForPersistence(result.stdout);
  if (!hasVisibleText(text)) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: result.capped,
      degraded: { code: "no-text-extracted", detail: emptyOutputDetail(route, result.stderr) },
    };
  }

  return { ...base, via: route, text, outputCapped: result.capped, degraded: null };
}

/**
 * "Exit 0 and nothing to show" is a REAL and COMMON outcome, and both tools
 * report it as success, so it is named here rather than passed off as text.
 *
 * MEASURED, on this machine, this session:
 *   · a PDF exported as page images (a scanned CV) gives `pdftotext` exit 0 and
 *     a stdout of exactly one byte, 0x0c — a form feed, one per page, no text;
 *   · `textutil -convert txt -stdout /nope/missing.docx` gives EXIT 0 with
 *     "Error reading … The file doesn't exist." on stderr. Its exit code cannot
 *     be trusted to signal failure at all, which is why this check exists for
 *     the office route as much as for the PDF one.
 */
function emptyOutputDetail(route: ExtractionRoute, stderr: string): string {
  const said = stderr.trim() === "" ? "" : ` It wrote to stderr: ${stderr.trim().slice(0, 400)}`;
  if (route === "pdftotext") {
    return (
      "pdftotext exited 0 but produced no text. The most likely cause is a PDF with no text layer — a " +
      "scan, or an export of page images — for which extraction can never work; measured, such a file " +
      "returns a single form feed per page and exit 0. Send this document natively instead, or run OCR " +
      `on it first.${said}`
    );
  }
  return (
    "textutil exited 0 but produced no text. Its exit code does not distinguish an empty document from " +
    "an unreadable one: measured, a missing path also exits 0 and only says so on stderr. Treat this as " +
    `'not read' rather than 'empty'.${said}`
  );
}

/**
 * True when the text carries anything a reader would see.
 *
 * FORM FEEDS ARE EXPLICITLY NOT CONTENT. `\s` in JavaScript already covers
 * `\f`, and that is exactly the measured image-only-PDF case above — but it is
 * spelled out here because a future "trim spaces only" simplification would turn
 * a scanned CV back into a silent success carrying one invisible byte.
 */
function hasVisibleText(text: string): boolean {
  return text.replace(/\s/gu, "").length > 0;
}

/**
 * The text routes: read the file itself, bounded.
 *
 * BOUNDED EVEN THOUGH INTAKE ALREADY CAPS THE UPLOAD, because this function
 * takes a PATH and nothing here can prove that path came through
 * {@link decodeDocumentDataUrl}. `readFileSync` on an attacker-chosen or
 * mistaken path is unbounded memory; `readSync` into a fixed buffer is not.
 */
function readInline(
  base: { readonly path: string; readonly mediaType: string; readonly label: string },
  maxBytes: number,
): ExtractedDocument {
  let raw: string;
  let capped = false;
  let fd: number | null = null;
  try {
    const size = statSync(base.path).size;
    const wanted = Math.min(size, maxBytes);
    capped = size > maxBytes;
    const buffer = Buffer.alloc(wanted);
    fd = openSync(base.path, "r");
    const read = readSync(fd, buffer, 0, wanted, 0);
    raw = buffer.subarray(0, read).toString("utf8");
  } catch (error) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: false,
      degraded: {
        code: "unreadable-file",
        detail: `${base.path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }

  const text = redactForPersistence(raw);
  if (!hasVisibleText(text)) {
    return {
      ...base,
      via: "none",
      text: "",
      outputCapped: capped,
      degraded: {
        code: "no-text-extracted",
        detail: `${base.mediaType} was read successfully but contains no visible characters`,
      },
    };
  }
  return { ...base, via: "inline", text, outputCapped: capped, degraded: null };
}

/* -------------------------------------------------------------------------
 * Rendering into a prompt — where the cut is announced
 * ---------------------------------------------------------------------- */

/**
 * How much of one document a prompt carries by default.
 *
 * 20,000 CHARACTERS IS ROUGHLY 5,000 TOKENS, or about ten pages of prose. A
 * 40-page scope is three to four times that and would crowd out the ticket it is
 * attached to, which is why there is a cap at all — and why the cap announces
 * itself rather than trimming quietly.
 */
export const DEFAULT_DOCUMENT_PROMPT_CHARS = 20_000;

/** The heading, greppable in a prompt dump, and asserted by the tests. */
export const DOCUMENT_BLOCK_BEGIN = "--- ATTACHED DOCUMENT ---";
const DOCUMENT_BLOCK_END = "--- END OF ATTACHED DOCUMENT ---";

/**
 * One extracted document as prompt text, with any truncation stated IN THE TEXT.
 *
 * WHY LOUD. A 40-page scope silently cut at 20,000 characters produces
 * acceptance criteria authored from half a scope, with nothing anywhere saying
 * so: the run looks complete, the criteria look confident, and the missing
 * requirements are invisible to every later reader. So the cut is announced
 * twice — before the text and after it — because a reader (human or model) that
 * arrives at the tail must learn it too. The counts are exact:
 * `showing N of M characters`, where M is the POST-REDACTION, PRE-TRUNCATION
 * length, so the two numbers reconcile with what is actually visible.
 *
 * THE CUT IS BY CHARACTER AND LANDS MID-SENTENCE. Nothing here looks for a
 * paragraph boundary: pretending the text ends where a paragraph ends would make
 * the truncation look like the document's own ending, which is precisely the
 * impression this is built to avoid.
 *
 * A DEGRADED DOCUMENT STILL RENDERS. It renders as an explicit statement that
 * the attachment could not be read, naming the reason, plus an instruction not
 * to infer its contents. Returning `""` for that case would hand the model a
 * prompt that has forgotten the attachment exists — and the owner attached it.
 *
 * NO HOST PATH IS EVER PRINTED, only {@link ExtractedDocument.label}. The rule
 * is `ticket-refs.ts`'s: seat-facing text carries no absolute path. There is a
 * test asserting the directory does not appear in the output.
 */
export function documentPromptText(
  extracted: ExtractedDocument,
  cap: number = DEFAULT_DOCUMENT_PROMPT_CHARS,
): string {
  const lines: string[] = ["", DOCUMENT_BLOCK_BEGIN, ""];

  if (extracted.degraded !== null) {
    lines.push(
      `The owner attached "${extracted.label}" (${extracted.mediaType}). IT COULD NOT BE READ.`,
      "",
      `Reason (${extracted.degraded.code}): ${extracted.degraded.detail}`,
      "",
      "None of its contents appear below, because none were recovered. Do not guess what it said and",
      "do not write anything that depends on it. If the work needs it, say plainly that the document",
      "was attached and could not be read.",
      "",
      DOCUMENT_BLOCK_END,
      "",
    );
    return lines.join("\n");
  }

  const total = extracted.text.length;
  const limit = Math.max(0, cap);
  const shown = total <= limit ? extracted.text : extracted.text.slice(0, limit);
  const truncated = shown.length < total;

  lines.push(
    `The owner attached "${extracted.label}" (${extracted.mediaType}), read with ${describeVia(extracted.via)}.`,
    "",
  );
  if (extracted.outputCapped) {
    lines.push(
      "THE EXTRACTOR ITSELF WAS CUT SHORT: it hit this server's output bound and was stopped, so the",
      "text below is not the whole document even before the display limit below is applied.",
      "",
    );
  }
  if (truncated) {
    lines.push(
      `TRUNCATED: showing ${String(shown.length)} of ${String(total)} characters. The document continues`,
      "past the cut and the rest is NOT in this prompt. Treat anything you do not see as unknown rather",
      "than absent — in particular, do not conclude that a requirement is missing from the document",
      "because it is missing from this excerpt.",
      "",
    );
  } else {
    lines.push(`Showing all ${String(total)} characters of the extracted text.`, "");
  }

  lines.push(shown, "");

  lines.push(
    truncated
      ? `--- END OF EXCERPT (TRUNCATED: ${String(shown.length)} of ${String(total)} characters shown) ---`
      : DOCUMENT_BLOCK_END,
    "",
  );
  return lines.join("\n");
}

/**
 * How the text was obtained, in words the model can weigh.
 *
 * THE `-layout` CAVEAT IS SAID OUT LOUD for the PDF route. Even with the flag,
 * a table's columns are reconstructed from x-coordinates and a complex layout
 * can still associate the wrong cells; telling the reader that the table
 * structure is a reconstruction is cheaper than a criterion authored from a
 * mis-joined row.
 */
function describeVia(via: ExtractionRoute | "none"): string {
  switch (via) {
    case "pdftotext":
      return (
        "pdftotext -layout (a text extraction, not the PDF itself: columns and tables are reconstructed " +
        "from position on the page and may be joined wrongly; images and anything without a text layer " +
        "are absent)"
      );
    case "textutil":
      return "textutil (a plain-text conversion: formatting, images and embedded objects are absent)";
    case "inline":
      return "a direct read of the file's own text";
    case "none":
      return "nothing";
  }
}
