/**
 * ticket-refs.ts — the references a ticket carries, and where each seat may see
 * them.
 *
 * THE PROBLEM THIS SOLVES. "Make a copy of kamilborzecki.dev" reaches three
 * seats with three different capabilities, verified in this session:
 *
 *   BUILDER   host process, unrestricted egress, full tool preset. Can fetch the
 *             web and can `Read` an image file.
 *   SPEC SEAT `tools: []`, `settingSources: []` (subscription-caller.ts). TEXT
 *             ONLY. It cannot open a file or a URL, ever, and that is deliberate:
 *             the suite it authors must never see an implementation.
 *   GATE      `docker run --network none`. Never sees the original at all.
 *
 * So a reference has to be split by AUDIENCE, and this module is where that
 * split is made:
 *
 *   - TEXT (the captured page's outline) is composed into `Ticket.brief`, which
 *     is the only channel into the spec seat (`spec-agent.ts:712` puts the brief
 *     verbatim between markers and sends nothing else). Criteria can then name
 *     real sections of the real site.
 *   - PATHS (uploaded images, screenshots) are rendered into the BUILD and
 *     DESIGN prompts only, with an explicit instruction to read them.
 *
 * WHAT MUST NEVER CROSS. No absolute path, no filename, and no sentence like
 * "the owner attached 2 images" may enter the brief. Naming an attachment to an
 * agent that cannot open it produces a run whose criteria acknowledge a
 * reference it never looked at — a criterion written about an unseen image is
 * worse than no criterion, because it grades green or red for reasons nothing
 * can trace. `ticket-refs.test.ts` asserts the absence directly.
 *
 * IDENTITY: WHAT ENTERS THE TICKET ID, AND WHY THE LINE IS DRAWN THERE.
 * The owner decided explicitly that the same words with a different reference
 * image must be a DIFFERENT ticket with its own frozen suite, accepting that a
 * byte-identical re-export mints a new ticket and re-authors a suite. So:
 *
 *   UPLOADED IMAGE DIGESTS  -> enter the id. They are stable per upload: the
 *                             same file uploaded twice digests the same.
 *   ATTACHED DOCUMENT       -> enter the id, on the SAME grounds and by the same
 *   DIGESTS                   mechanism. A scope, a brief or a CV is a reference:
 *                             a run whose scope document changed is not the same
 *                             ticket and must not be graded against a suite
 *                             authored from the old one. Same accepted cost as
 *                             the images — re-uploading a byte-identical file
 *                             mints a new ticket only if its BYTES changed, so a
 *                             genuine re-upload of the same PDF reuses the suite.
 *   THE CAPTURED OUTLINE    -> enters the id, unavoidably, because it is part of
 *                             the brief and the brief is digested. It is kept
 *                             deliberately coarse for exactly this reason
 *                             (site-capture.ts says which fields and why).
 *   SCREENSHOT BYTES        -> DO NOT ENTER THE ID, and this is the load-bearing
 *                             exclusion. A live page never re-renders
 *                             byte-identically — fonts settle differently, a
 *                             date changes, a carousel is on a different frame.
 *                             Folding those bytes in would mint a new ticket on
 *                             EVERY submission of the same brief, re-authoring a
 *                             suite each time and destroying the reuse branch in
 *                             `orchestrator.ts` that exists to stop exactly that
 *                             spend. Their digests are recorded in the manifest
 *                             for provenance and are not identity.
 *
 * A CONSEQUENCE, STATED PLAINLY: if the captured site CHANGES between two
 * submissions of the same words, the outline changes, so the id changes, so a
 * fresh suite is authored. That is correct — the ticket is "copy what is there
 * now" and what is there is different — but it is a real quota cost and it is
 * not obvious from the outside.
 *
 * A SECOND CONSEQUENCE: if the capture FAILS (site down, browser missing), the
 * brief is the prose alone and the ticket id is the prose-only id. The same
 * words therefore address a different frozen suite depending on whether the
 * network was up. Nothing here hides that; the caller records the failure on the
 * run's event stream.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MOTION_BLOCK_BEGIN, motionBriefLines } from "./motion-brief.js";
import type { MotionSpec } from "./motion-types.js";
import { safeSegment } from "./paths.js";
import type { SiteCapture, SiteOutline } from "./site-capture.js";

/* -------------------------------------------------------------------------
 * Intake caps — ONE definition, shared with the chat route
 * ---------------------------------------------------------------------- */

/**
 * How many images one intake may carry.
 *
 * THE SAME NUMBERS THE CHAT ROUTE ALREADY USED, moved here rather than copied,
 * because two intakes with drifting caps is how one of them quietly stops
 * accepting what the other documents. `http.ts` imports these for both routes.
 */
export const MAX_REFERENCE_IMAGES = 6;

/** How much one image may be, DECODED. Screenshots and mockups, not video. */
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * `data:image/png;base64,…` → the extension and the bytes, or null if not that.
 *
 * WHY DATA URLs AND NOT MULTIPART, unchanged from the chat route this came from:
 * the only client is this app's own form, `secret-intake.ts` is the one
 * multipart parser here and it is deliberately narrow, and a second hand-rolled
 * boundary parser for one caller is not worth its bug surface. Base64 costs 33%
 * over a loopback socket.
 *
 * THE MIME TYPE IS NOT VERIFIED AGAINST THE BYTES. The size cap is the control
 * that matters: these bytes go to a file an agent `Read`s, not to a renderer
 * that could be tricked, and an unbounded base64 body is the one way this
 * endpoint could hurt the machine it runs on.
 */
export function decodeReferenceDataUrl(value: unknown): { readonly ext: string; readonly bytes: Buffer } | null {
  if (typeof value !== "string") return null;
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (match === null) return null;
  const ext = match[1] === "jpeg" ? "jpg" : (match[1] ?? "png");
  const bytes = Buffer.from(match[2] ?? "", "base64");
  if (bytes.length === 0 || bytes.length > MAX_REFERENCE_IMAGE_BYTES) return null;
  return { ext, bytes };
}

/* -------------------------------------------------------------------------
 * The manifest
 * ---------------------------------------------------------------------- */

/** One image the owner attached to the ticket form. */
export interface ReferenceImage {
  /** Absolute host path. Builder-facing only. */
  readonly path: string;
  /** sha256 of the bytes. THIS is what enters the ticket id. */
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * One DOCUMENT the owner attached to the ticket form — a brief, a scope, a CV.
 *
 * THE SAME THREE FIELDS AS `ReferenceImage`, PLUS THE MEDIA TYPE, and the extra
 * field is not decoration: `document-intake.ts#routeFor` decides how a document
 * becomes text from its media type, and the extension on the path is chosen by
 * the intake rather than sent by the client, so the path is not a safe place to
 * recover it from. Recording it here is what lets a LATER reader of this
 * manifest — the build segment, a report — know it is holding a PDF and not a
 * .docx without opening the file.
 *
 * `sha256` IS THE DIGEST OF THE BYTES AND IT IS WHAT ENTERS THE TICKET ID. The
 * media type does NOT: two uploads of the same bytes under two spellings of the
 * same type (`application/rtf` and `text/rtf`, which browsers genuinely disagree
 * about — see `document-intake.ts`'s ACCEPTED map) are the same document, and
 * folding the type in would make the ticket id depend on which browser uploaded
 * it.
 *
 * THE BYTES ARE NOT HERE AND MUST NOT BE. Same rule as the images: a 4 MB PDF
 * has no business in a JSON row that is read on every build, and
 * `document-intake.ts` additionally states that a document's base64 cannot be
 * redacted, so persisting it would persist whatever credential the file happens
 * to contain.
 */
export interface ReferenceDocument {
  /** Absolute host path. Builder-facing only, exactly like an image's. */
  readonly path: string;
  /** sha256 of the bytes. THIS is what enters the ticket id. */
  readonly sha256: string;
  readonly bytes: number;
  /** Lower-cased, parameters stripped — `document-intake.ts` normalises it. */
  readonly mediaType: string;
}

/**
 * Everything a run's references amount to, as written beside the run.
 *
 * ON DISK RATHER THAN IN SQLITE, the same decision the chat images took: a 2 MB
 * PNG has no business in the database, so the bytes are files and the row-level
 * record is a small JSON manifest next to them. The orchestrator re-reads this
 * at build time, which is why it must be self-contained — it is the only thing
 * that survives a server restart between intake and the build segment.
 *
 * `documents` IS OPTIONAL, AND NOT BECAUSE IT IS LESS IMPORTANT. Every manifest
 * already written to disk lacks the key, and this type is also constructed as a
 * literal by callers outside this module; a required field would make those
 * literals stop compiling and would make an existing manifest read back as a
 * shape this type says is impossible. Read it through
 * {@link manifestDocuments}, never directly — that helper is the one place the
 * absent case is turned into an empty list.
 */
export interface ReferenceManifest {
  readonly images: readonly ReferenceImage[];
  readonly capture: SiteCapture | null;
  readonly documents?: readonly ReferenceDocument[];
  /**
   * How the page the owner named as a MOTION REFERENCE was observed to move.
   *
   * OPTIONAL FOR THE SAME REASON `documents` IS — every manifest already on disk
   * lacks the key, and a required field would make an existing manifest read
   * back as a shape this type says is impossible. Read it through
   * {@link manifestMotion}.
   *
   * IT IS THE QUANTIZED SPEC, NEVER THE RAW READING. `RawObservation` carries
   * `firstChangeMs`, an absolute start time measured to differ by 400 ms between
   * two readings of the same page (`motion-types.ts` records the measurement);
   * persisting it would put a number in the file the read-back path derives the
   * ticket id from, and a drifting id re-authors the acceptance suite.
   *
   * THIS FILE IS WHERE THE READ-BACK ID COMES FROM. `ticketFromStoredReferences`
   * folds `motion.url` into the identity material at build time, and the intake
   * folded the same string; if this key is lost, the run derives a different
   * ticket and authors a second suite.
   */
  readonly motion?: MotionSpec | null;
}

export const EMPTY_REFERENCES: ReferenceManifest = { images: [], capture: null, documents: [], motion: null };

/**
 * The documents a manifest carries, with "the key was never written" and "there
 * are none" flattened to the same empty list.
 *
 * THE FLATTENING IS SAFE HERE AND IS NOT SAFE FOR THE IMAGES. A manifest with no
 * `documents` key is one written before documents existed, which is a run that
 * genuinely had none — the two really are the same fact. There is no third state
 * ("documents were attached but the key is missing") that this hides, because
 * the intake writes the key and the bytes in the same statement.
 */
export function manifestDocuments(manifest: ReferenceManifest | null): readonly ReferenceDocument[] {
  return manifest?.documents ?? [];
}

/**
 * The motion reading a manifest carries, with "the key was never written",
 * "there is no manifest" and "no motion reference was given" flattened to the
 * same `null`.
 *
 * THE SAME FLATTENING ARGUMENT `manifestDocuments` MAKES, and it holds for the
 * same reason: a manifest with no `motion` key is one written before motion
 * existed, which is a run that genuinely had none. There is no third state this
 * hides, because the intake writes the key and the reading in one statement.
 *
 * WHAT IT DOES NOT FLATTEN, and the distinction is load-bearing: a spec with an
 * EMPTY `entries` list is not `null`. That is "a page was read and nothing moved
 * inside the sampling window", which `motion-capture.ts` insists is a different
 * answer from "nothing was read". Both {@link referenceIdentityMaterial} and
 * {@link hasReferences} treat them differently, in opposite directions — the
 * first counts an empty reading as a reference the owner chose, the second
 * refuses to print a prompt block about it.
 */
export function manifestMotion(manifest: ReferenceManifest | null): MotionSpec | null {
  return manifest?.motion ?? null;
}

/** `runs/<id>/references` — DERIVED IN ONE PLACE, imported by both writers. */
export function referenceDirFor(runsRoot: string, runId: string): string {
  return join(runsRoot, safeSegment(runId), "references");
}

/**
 * `runs/<id>/documents` — where a TICKET's attached documents' bytes live.
 *
 * A SEPARATE DIRECTORY FROM `references/`, WHICH IS THE OWNER'S ASK SPELLED
 * LITERALLY, and it costs nothing because the manifest records absolute paths:
 * nothing infers a document's location from the manifest's own directory.
 *
 * IT IS NOT WHERE THE CHAT'S DOCUMENTS GO. A document attached to a mid-run chat
 * message is NOT part of the ticket's identity — the ticket id was fixed when the
 * row was written, and moving it afterwards would point a running run at a
 * different frozen suite — so those bytes go to `runs/<id>/chat/` beside the chat
 * images. Keeping the two apart on disk means a future pass that folds
 * "everything in documents/" into an identity cannot silently absorb a message
 * attachment.
 */
export function documentDirFor(runsRoot: string, runId: string): string {
  return join(runsRoot, safeSegment(runId), "documents");
}

const MANIFEST_FILE = "references.json";

export function writeReferenceManifest(dir: string, manifest: ReferenceManifest): void {
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Read a run's manifest back, or `null`.
 *
 * EVERY FAILURE IS `null` AND THAT IS A DELIBERATE FLATTENING: absent, corrupt
 * and unreadable all mean "this build gets no reference paths in its prompt",
 * which is the same degraded-but-working outcome. The distinction that IS
 * preserved is the one that changes the run — a manifest that exists and lists
 * zero images is `{images: [], capture: null}`, not `null`, so a caller can tell
 * "no references were attached" from "the manifest could not be read".
 *
 * THE SHAPE IS NOT VALIDATED FIELD BY FIELD. It is written by this process, in
 * this process's own directory, one function above. A schema check here would be
 * guarding against this file editing itself.
 */
export function readReferenceManifest(dir: string): ReferenceManifest | null {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<ReferenceManifest>;
    if (!Array.isArray(record.images)) return null;
    // `documents` IS NORMALISED ON THE WAY OUT, so every manifest written before
    // documents existed reads back as "none attached" rather than as a shape
    // with a hole in it. `images` is deliberately NOT given the same treatment:
    // a manifest without that key is not an old manifest, it is a corrupt one,
    // and defaulting it would turn a run that had reference images into one that
    // silently derives the prose-only ticket id.
    return {
      images: record.images,
      capture: record.capture ?? null,
      documents: Array.isArray(record.documents) ? record.documents : [],
      // `motion` NORMALISES THE SAME WAY AND FOR THE SAME REASON as `documents`
      // — a manifest written before motion existed must read back as "there was
      // none" rather than as a hole. It is NOT validated field by field, on this
      // function's stated grounds: this process wrote it, in its own directory.
      motion: record.motion ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * True when this manifest gives an agent something to LOOK AT.
 *
 * DOCUMENTS ARE DELIBERATELY NOT COUNTED, and this is not an oversight to be
 * tidied. The only two callers are {@link builderReferenceSection} and
 * {@link designReferenceSection}, whose blocks say "READ EACH ONE BEFORE
 * ACTING" above a list of image and screenshot paths. Counting documents here
 * would print that heading for a ticket whose only attachment is a PDF and then
 * list nothing — an instruction to open nothing, which is the exact failure the
 * `shots.length > 0` check inside those functions already exists to prevent.
 *
 * SO A DOCUMENT ATTACHED TO A TICKET REACHES NO PROMPT FROM THIS MODULE. It is
 * recorded in the manifest and folded into the ticket id; putting it in front of
 * a seat is a separate, unwritten wiring step. Anything that changes that must
 * add a documents block with its own wording and its own emptiness check, not
 * widen this predicate.
 *
 * A MOTION READING IS COUNTED, AND THE RULE ABOVE IS WHY RATHER THAN AN
 * EXCEPTION TO IT. The test is not "is this reference important" but "does the
 * section below have anything to print". A document produces nothing — no path
 * either function renders, no sentence either function writes — so counting it
 * would print a heading over an empty list. A motion reading with entries
 * produces a block with an address and a statement in it, which those functions
 * do render, so it counts. A reading with NO entries produces nothing again, and
 * is deliberately not counted: `entries.length > 0` here is the same guard as
 * `shots.length > 0` inside the two sections, made once so the predicate and the
 * blocks cannot disagree about whether there is anything to say.
 */
export function hasReferences(manifest: ReferenceManifest | null): boolean {
  if (manifest === null) return false;
  return (
    manifest.images.length > 0 ||
    (manifest.capture?.shots.length ?? 0) > 0 ||
    (manifest.motion?.entries.length ?? 0) > 0
  );
}

/* -------------------------------------------------------------------------
 * The brief — the TEXT half, the only half the spec seat sees
 * ---------------------------------------------------------------------- */

/**
 * The marker that separates the owner's words from the machine's reading of the
 * site.
 *
 * GREPPABLE AND STABLE. It is a public constant because two other things depend
 * on the exact string: {@link ticketProse} strips it back off before the ticket
 * is classified, and the tests assert a composed brief round-trips.
 */
export const CAPTURE_BLOCK_BEGIN = "--- WHAT THE DASHBOARD READ FROM THE PAGE THIS TICKET NAMES ---";
const CAPTURE_BLOCK_END = "--- END OF THE PAGE READING ---";

/**
 * Compose the brief the spec seat and the builder are given.
 *
 * WITH NO CAPTURE THIS RETURNS THE PROSE UNCHANGED — the same object identity of
 * bytes, not merely an equal-looking string. That property is what keeps every
 * frozen suite on disk addressable: `ticketFromText(prose)` and
 * `ticketWithReferences({prose, images: [], capture: null})` must produce the
 * same id, or every suite already frozen is orphaned. There is a test on it.
 *
 * THE BLOCK IS LABELLED AS THE DASHBOARD'S READING, NOT AS THE SITE. It is a
 * partial, regex-derived summary of one page's markup at one moment; calling it
 * "the site" in front of a model that will write pass/fail criteria from it is
 * how a criterion ends up asserting a heading that a mis-parse invented.
 *
 * TWO BLOCKS NOW, AND THE ORDER IS FIXED RATHER THAN INCIDENTAL: prose, then the
 * markup reading, then the motion reading. {@link ticketProse} cuts at the
 * EARLIER marker present, so the order does not decide what the owner's prose is
 * — but it does decide the bytes of the brief, and the brief is the ticket id.
 * Reordering these two blocks changes every id minted from a ticket that carries
 * both, which orphans the suites already sealed under them.
 *
 * THE MOTION BLOCK IS OMITTED ENTIRELY FOR A READING WITH NO ENTRIES, which is
 * `motionBriefLines`' own rule and `outlineLines`' before it: a heading above an
 * empty list invites the spec seat to author a criterion about motion nobody
 * observed.
 */
export function composeBrief(
  prose: string,
  capture: SiteCapture | null,
  motion: MotionSpec | null = null,
): string {
  const lines: string[] = [prose];
  if (capture !== null) {
    lines.push("", "", CAPTURE_BLOCK_BEGIN, "", ...outlineLines(capture.outline), "", CAPTURE_BLOCK_END);
  }
  if (motion !== null) {
    const motionLines = motionBriefLines(motion);
    if (motionLines.length > 0) lines.push("", "", ...motionLines);
  }
  // WITH NEITHER BLOCK THIS RETURNS THE PROSE UNCHANGED, byte for byte: a
  // one-element join adds nothing. That is the property the golden id rests on.
  return lines.join("\n");
}

/**
 * The owner's own words, recovered from a composed brief.
 *
 * NEEDED BECAUSE `classifySurface` READS THE BRIEF. `orchestrator.ts` classifies
 * the ticket's surface from its text to decide the delegation shortlist and the
 * design lane; a captured navigation containing "Blog", "API" and "CLI" is
 * exactly the kind of noise that flips that classification, and the surface
 * would then be decided by someone else's nav bar.
 *
 * SPOOFABLE, AND HARMLESS WHEN SPOOFED. An owner who types the marker string
 * into their own prose gets their brief truncated here. The consequence is a
 * shorter string handed to a keyword classifier that fails towards the WIDEST
 * shortlist; it is not a boundary anything security-relevant depends on.
 *
 * THE EARLIEST MARKER WINS, AND `lastIndexOf` ALONE WOULD BE WRONG IN BOTH
 * DIRECTIONS NOW THAT THERE ARE TWO BLOCKS. A brief carrying only the motion
 * block would keep the whole reading in the prose (no capture marker to cut at),
 * and a reordering of the two blocks would keep whichever was composed first.
 * Taking the minimum of the markers that are PRESENT cuts everything machine-
 * written in one line, whatever order they were composed in.
 *
 * WHAT IT STILL DOES NOT CUT: the planning block. `plan-brief.ts:218-233` offers
 * `planBlockIndex` for exactly this minimum, and this function does not consult
 * it — `orchestrator.ts` composes `ticketProse(stripPlanBlock(brief))` instead,
 * and that composition is what removes it today. This function is unchanged in
 * that respect and claims nothing about it.
 *
 * `lastIndexOf` WITHIN EACH MARKER is kept: an owner who types a marker into his
 * own prose truncates his own brief rather than shifting the machine's block,
 * which is the harmless spoof the paragraph above describes.
 */
export function ticketProse(brief: string): string {
  const indexes = [CAPTURE_BLOCK_BEGIN, MOTION_BLOCK_BEGIN]
    .map((marker) => brief.lastIndexOf(`\n${marker}`))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return brief;
  return brief.slice(0, Math.min(...indexes)).replace(/\n+$/, "");
}

/**
 * The outline as prose.
 *
 * A FIELD THAT IS EMPTY IS OMITTED ENTIRELY rather than printed as "headings:
 * none". An empty list here means "the extractor found none", which for the
 * palette is the ordinary case on any site with an external stylesheet — and a
 * line saying the site has no colours would be a false statement about the site
 * rather than a true one about the extractor. The heading below says which it is.
 */
function outlineLines(outline: SiteOutline): readonly string[] {
  const lines: string[] = [
    "This is a partial, automated reading of the page's markup, taken once when the",
    "ticket was submitted. It is not the page itself and it is not complete: anything",
    "it does not mention may still be there.",
    "",
    `Address: ${outline.url}`,
  ];
  if (outline.title.length > 0) lines.push(`Page title: ${outline.title}`);

  if (outline.headings.length > 0) {
    lines.push("", "Headings, in the order they appear in the document:");
    for (const heading of outline.headings) {
      lines.push(`  ${"  ".repeat(Math.max(0, heading.level - 1))}h${String(heading.level)} — ${heading.text}`);
    }
  }
  if (outline.links.length > 0) {
    lines.push("", `Link labels found on the page: ${outline.links.join(" · ")}`);
  }
  if (outline.palette.length > 0) {
    lines.push(
      "",
      `Colours declared in the page's own markup, most used first: ${outline.palette.join(", ")}`,
      "(Colours defined in external stylesheets are not included and are not counted here.)",
    );
  }
  return lines;
}

/* -------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------- */

/**
 * The extra bytes an uploaded image contributes to the ticket id.
 *
 * SEPARATED FROM THE BRIEF BY A STRING THAT CANNOT OCCUR IN A BRIEF-PLUS-DIGESTS
 * ENCODING BY ACCIDENT, so that a brief ending in a hex string cannot collide
 * with a shorter brief plus a reference. Cheap, and the failure it prevents —
 * two different tickets sharing one frozen suite — is the failure this whole
 * mechanism exists to stop.
 *
 * ORDER-SENSITIVE ON PURPOSE. The same two images uploaded in the other order is
 * a different ticket. Sorting would be defensible, but the order is the owner's
 * stated priority ("this one first") and the owner has already accepted that a
 * re-upload mints a new ticket; a sort would make one kind of re-submission
 * cheap and leave the other expensive, which is harder to explain than "any
 * change to the references is a new ticket".
 */
/*
 * THE SEPARATOR IS A NUL-DELIMITED LABEL, AND IT IS NOW WRITTEN AS ESCAPES.
 *
 * THE VALUE IS UNCHANGED. "\u0000ticket-references\u0000" is byte for byte the
 * string this constant has always held, so every ticket id already minted and
 * every suite already frozen under one is unaffected — only the SPELLING in the
 * source moved. The literal used to carry RAW NUL BYTES, which made this entire
 * file `data` to grep(1): `grep -n referenceIdentityMaterial ticket-refs.ts`
 * printed nothing at all, and a reader could reasonably conclude the function
 * did not exist. That is not a hypothetical hazard in this repository — commit
 * c1f70e0, "three NUL bytes made grep skip this file silently", is the same
 * defect found in the gate.
 *
 * WHY NUL AT ALL, rather than a readable marker. It is one of the few bytes that
 * cannot be typed into the ticket form and cannot appear in a hex digest, which
 * is exactly what "cannot occur by accident" below requires. A printable
 * separator such as " ticket-references " could be written by an owner
 * describing this very feature, and would then let two different tickets encode
 * to the same material.
 */
const IDENTITY_SEPARATOR = "\u0000ticket-references\u0000";

/**
 * The documents' separator, and it carries a DIFFERENT LABEL on purpose.
 *
 * With one marker for both lists, a ticket carrying image A and no documents
 * would encode identically to the same ticket carrying document A and no
 * images — two different tickets sharing one frozen suite, which is the single
 * failure this encoding exists to prevent. Two labels make the position
 * unambiguous, and neither can occur inside a brief or a digest.
 */
const DOCUMENT_IDENTITY_SEPARATOR = "\u0000ticket-documents\u0000";

/**
 * The motion reference's separator — a THIRD label, on the argument the second
 * one makes: with a shared marker, a ticket carrying one image would encode
 * identically to the same ticket carrying a motion reference whose address
 * happened to spell that image's digest. Written as escapes for the reason the
 * comment above `IDENTITY_SEPARATOR` gives — a raw NUL makes this whole file
 * `data` to grep(1).
 */
const MOTION_IDENTITY_SEPARATOR = "\u0000ticket-motion\u0000";

/**
 * The bytes a ticket's id is taken over: the brief, then what it carries.
 *
 * IMAGES FIRST, THEN DOCUMENTS, THEN THE MOTION REFERENCE'S ADDRESS, each list
 * order-sensitive within itself for the reason the image separator gives above.
 * A list that is empty, and a `null` motion, append NOTHING — not an empty
 * separator, not a trailing marker — which is the property that keeps
 * `referenceIdentityMaterial(brief, [], [])` byte-identical to `brief` and
 * therefore keeps every suite frozen before this module existed addressable.
 * `ticket-refs.test.ts` pins that against a hardcoded golden id.
 *
 * `documents` AND `motion` ARE DEFAULTED RATHER THAN REQUIRED, and the reason is
 * that the DEFAULT IS THE IDENTITY-PRESERVING VALUE: a caller that has not heard
 * of either computes the id this function has always computed, rather than a
 * different one. The dangerous direction — a default that silently invents a new
 * id — is not reachable through these parameters. The place where a default
 * WOULD be dangerous is the read-back path in `ticket.ts`, and it does not have
 * one: see `ticketFromStoredReferences`.
 *
 * WHAT THE MOTION READING CONTRIBUTES IS ITS ADDRESS AND NOTHING ELSE, and the
 * omissions are the whole design:
 *
 *   THE ADDRESS is here because the brief does not carry it. `motionBriefLines`
 *   prints families, roles, durations and easings and never the URL, so two
 *   pages that move identically compose a BYTE-IDENTICAL brief. Without this
 *   line they would share one frozen suite while naming two different
 *   references, against the owner's rule at the top of this file — the same rule
 *   that puts an uploaded image's digest here even though the image adds no text.
 *
 *   `capturedAt` IS DELIBERATELY ABSENT. It is a fresh timestamp on every
 *   capture. Folding it in would mint a new ticket id on every resubmission of
 *   the same words against the same page, re-authoring the acceptance suite each
 *   time on the owner's quota. There is a named test on this.
 *
 *   THE ENTRIES ARE DELIBERATELY ABSENT TOO, and not because they do not matter:
 *   every number that survives normalisation is already printed into the brief,
 *   which is digested into `sha256` and the id together, so a page that moves
 *   differently already mints a different ticket. Adding them here would fold in
 *   the ONE part the brief drops — the numbers of the two presence-only families,
 *   which describe the sampling window rather than the page (`api-types.ts`
 *   states that) and would move between two readings of an unchanged site.
 *
 *   A READING WITH NO ENTRIES STILL CONTRIBUTES. `null` means no page was read;
 *   an empty spec means a page WAS read and nothing moved in the window, and
 *   `motion-capture.ts` insists those are different answers. The brief cannot
 *   carry the difference — it renders no block either way — so the id is the
 *   only place it survives, on the same rule an uploaded image follows.
 */
export function referenceIdentityMaterial(
  brief: string,
  images: readonly ReferenceImage[],
  documents: readonly ReferenceDocument[] = [],
  motion: MotionSpec | null = null,
): string {
  const withImages =
    images.length === 0
      ? brief
      : brief + IDENTITY_SEPARATOR + images.map((image) => image.sha256).join("\n");
  const withDocuments =
    documents.length === 0
      ? withImages
      : withImages + DOCUMENT_IDENTITY_SEPARATOR + documents.map((document) => document.sha256).join("\n");
  if (motion === null) return withDocuments;
  return withDocuments + MOTION_IDENTITY_SEPARATOR + motion.url;
}

/**
 * sha256 of raw bytes.
 *
 * NOT `ticketDigest`, which is the frozen brief-digest function and takes a
 * string; this hashes a file's contents. Different input domain, and calling the
 * ticket function on a base64 re-encoding of a PNG would be a digest of a
 * spelling rather than of the image.
 */
export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* -------------------------------------------------------------------------
 * The PATH half — build and design prompts only
 * ---------------------------------------------------------------------- */

/**
 * Absolute paths, plus the sentence that makes them get opened.
 *
 * "READ EACH ONE BEFORE ACTING" IS NOT DECORATION. It is the same mechanism the
 * chat images use (`owner-message.ts`) and the same one the design refs use
 * (spec §7.3 mechanism 2): a path mentioned in a prompt is what makes a `Read`
 * actually happen, and naming files without instructing the agent to open them
 * produces a run that acknowledges an attachment it never looked at.
 *
 * RETURNS "" FOR NOTHING TO SAY, so the caller can append it unconditionally —
 * the shape `ownerMessageBlock` and `videoPrompt` already use, and the reason
 * there is no `if` at the call site to forget.
 *
 * THIS IS AN INSTRUCTION, NOT A BOUND. Nothing verifies the builder read the
 * files; there is no hook that checks a `Read` happened against these paths.
 * A run that ignores the block is indistinguishable here from one that followed
 * it, and only the artefact shows the difference.
 */
export function builderReferenceSection(manifest: ReferenceManifest | null): string {
  if (!hasReferences(manifest)) return "";
  const refs = manifest as ReferenceManifest;

  const lines: string[] = ["", "", "REFERENCES THE OWNER ATTACHED TO THIS TICKET", ""];

  // `shots.length > 0`, NOT just `capture !== null`. A capture whose screenshots
  // all failed still carries an outline — which reached the brief and is doing
  // its job there — but rendering its block here would print "READ EACH ONE
  // BEFORE ACTING" above an empty list, which is an instruction to open nothing.
  if (refs.capture !== null && refs.capture.shots.length > 0) {
    lines.push(
      `The ticket names ${refs.capture.url}. That page was captured once, on ${refs.capture.capturedAt},`,
      "at three widths. These files are the page as it looked then. READ EACH ONE BEFORE ACTING:",
      ...refs.capture.shots.map((shot) => `    ${shot.path}   (${String(shot.width)}px wide)`),
      "",
      "The ticket text above already contains a written outline of that page. The pictures carry",
      "what the outline cannot: spacing, type scale, colour, and where things actually sit.",
      "",
    );
  }

  if (refs.images.length > 0) {
    lines.push(
      `The owner attached ${String(refs.images.length)} reference image(s). READ EACH ONE BEFORE ACTING:`,
      ...refs.images.map((image) => `    ${image.path}`),
      "",
      "They are art direction from the person who wrote the ticket. Where they and your own",
      "judgement disagree about how something should look, follow them.",
      "",
    );
  }

  // THE MOTION READING HAS NO FILE, and that is why this block reads differently
  // from the two above: there is nothing to open, so there is no "READ EACH ONE"
  // sentence to write. The reading itself is already in the ticket text — the
  // builder is handed `ticket.brief` — so repeating the numbers here would put
  // two copies of a hashed block in one prompt. This says where they are and
  // what they are not.
  lines.push(...motionPromptLines(refs.motion ?? null, "Match it."));

  lines.push(
    "WHAT THESE DO AND DO NOT CHANGE. They are the visual brief. They do not relax anything the",
    "ticket asks for in words, and they are not a licence to skip behaviour that is not visible in",
    "a picture. If a reference and the ticket text genuinely conflict, do what the words say and",
    "name the conflict in your final summary.",
    "",
  );

  return lines.join("\n");
}

/**
 * The motion reference, said once, for whichever prompt is asking.
 *
 * ONE FUNCTION AND TWO CLOSING SENTENCES, rather than two copies: the two facts
 * that matter (which page, and that nothing measures the result) are identical
 * for both seats, and the lane-specific part is one clause. The capture blocks
 * above are deliberately NOT shared, because their content genuinely differs.
 *
 * `entries.length > 0` IS THE GUARD, matching `shots.length > 0` above and
 * {@link hasReferences}: a reading that observed nothing has an address and no
 * content, and a heading over it would tell an agent to match motion nobody saw.
 *
 * IT PROMISES NOTHING, ON PURPOSE. No gate in this tree compares a built site's
 * motion to this reading — the sealed scorer runs `--network none` and there is
 * no motion check in it — so the block says so in its own words. A prompt that
 * implied a comparison would be describing a mechanism that does not exist.
 */
function motionPromptLines(motion: MotionSpec | null, closing: string): readonly string[] {
  if (motion === null || motion.entries.length === 0) return [];
  return [
    `The owner also named a page for how it MOVES: ${motion.url}, sampled once on ${motion.capturedAt}.`,
    `What was read off it is written out in the ticket text above, between the "MOTION READ FROM THE`,
    `REFERENCE PAGE" markers — families, roles, bucketed durations and easings. There is no file to`,
    `open for this one, and the numbers there are rounded rather than exact. ${closing}`,
    "",
    "NOTHING IN THIS RUN COMPARES WHAT YOU BUILD TO THAT PAGE. No check measures motion, and the",
    "sealed scorer has no network and never loads it. This is direction you are trusted with.",
    "",
  ];
}

/**
 * The same references, addressed to the DESIGN lane.
 *
 * WHY A SECOND WORDING RATHER THAN REUSING THE BUILDER'S. The design lane's job
 * is to produce mockups and hand one back; told only "here are references" it
 * will still generate five inventions, because that is what the lane's own
 * prompt asks it for. What it needs to hear is that the target already exists.
 *
 * IT IS STILL ONLY A PROMPT. Nothing here reduces the number of mockups the lane
 * generates, nothing checks that a mockup resembles the reference, and no code
 * path fails a lane that ignores this block. Read it as art direction that is
 * likely to be followed, not as a constraint that is enforced — the difference
 * matters, because a run whose mockups ignore the reference will still park and
 * still ask the owner to pick one.
 */
export function designReferenceSection(manifest: ReferenceManifest | null): string {
  if (!hasReferences(manifest)) return "";
  const refs = manifest as ReferenceManifest;

  const lines: string[] = ["", "", "THE OWNER GAVE YOU REFERENCES. START FROM THEM.", ""];

  // Same rule as the builder section: no pictures, no block.
  if (refs.capture !== null && refs.capture.shots.length > 0) {
    lines.push(
      `This ticket is about a page that already exists: ${refs.capture.url}. It was captured on`,
      `${refs.capture.capturedAt} at three widths. READ EACH ONE BEFORE YOU DESIGN ANYTHING:`,
      ...refs.capture.shots.map((shot) => `    ${shot.path}   (${String(shot.width)}px wide)`),
      "",
      "Your job is not to invent a direction for this. It is to read what is there — the type",
      "scale, the palette, the rhythm, the density — and produce work that would sit beside it",
      "without looking like a different site. Where you offer alternatives, make them variations",
      "on what you were shown, not departures from it.",
      "",
    );
  }

  if (refs.images.length > 0) {
    lines.push(
      `The owner attached ${String(refs.images.length)} reference image(s). READ EACH ONE BEFORE YOU DESIGN ANYTHING:`,
      ...refs.images.map((image) => `    ${image.path}`),
      "",
      "These are the direction the owner has already chosen. Derive from them.",
      "",
    );
  }

  // The lane's closing clause differs from the builder's because its output
  // does: a still mockup cannot move, so the instruction it can actually follow
  // is to design something the described motion would sit inside.
  lines.push(
    ...motionPromptLines(
      refs.motion ?? null,
      "Design for it: a layout that reveals in sequence is not the same layout as one that does not.",
    ),
  );

  return lines.join("\n");
}
