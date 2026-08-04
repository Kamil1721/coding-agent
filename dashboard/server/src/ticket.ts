/**
 * ticket.ts — turn the dashboard's free-text ticket into a frozen `Ticket`.
 *
 * THE ID IS DERIVED FROM THE BRIEF, NOT FROM THE RUN. Two runs submitted with
 * byte-identical text get the same ticket id, therefore the same sealed
 * acceptance suite, therefore a comparable result — held-constant variable 5
 * ("the held-out acceptance suite") holding across repeats of the same ticket,
 * for free. It also means resubmitting a ticket does not spend quota
 * re-authoring a suite that already exists, and a resumed run cannot end up
 * measured against a freshly authored, subtly different yardstick.
 *
 * One byte of difference is a different ticket. That is the same rule the
 * bake-off enforces with `ticketDigestMatches`: a changed brief invalidates its
 * suite, because a suite authored from a different brief is not comparable to
 * one authored from this brief.
 *
 * FOUR WAYS IN, AND THE OLDEST ONE IS UNTOUCHED. `ticketFromText` is exactly
 * what it was — every existing caller and every suite already frozen on disk
 * keeps its id. `ticketWithReferences` is the INTAKE path for a ticket that also
 * carries reference images, attached documents or a captured page; with an empty
 * reference set it produces the same five field values as `ticketFromText`, byte
 * for byte, which is the only reason it is safe to add at all.
 * `ticketFromStoredReferences` is the READ-BACK path for a caller holding the
 * manifest, and `ticketFromStoredBrief` is its predecessor, kept for callers
 * outside this file and honest in its docblock about the digests it cannot see.
 *
 * Read `ticketWithReferences` before changing any of them: the id and the
 * `sha256` deliberately cover DIFFERENT material, and the bake-off refuses a
 * ticket that gets that backwards.
 */

import type { Ticket, TicketTier } from "bakeoff/dist/contracts.js";
import { ticketDigest } from "bakeoff/dist/hash.js";
import { composeBrief, manifestDocuments, manifestMotion, referenceIdentityMaterial } from "./ticket-refs.js";
import type { ReferenceDocument, ReferenceImage, ReferenceManifest } from "./ticket-refs.js";
import type { MotionSpec } from "./motion-types.js";
import type { SiteCapture } from "./site-capture.js";

/** Longest title kept. Titles are for the UI list; they are never sent anywhere. */
const MAX_TITLE = 80;

/**
 * Tier recorded on every dashboard ticket.
 *
 * The dashboard does NOT classify tickets, and nothing in its pipeline reads
 * this field: it gates nothing, it selects nothing, and it appears in no
 * dashboard output. It exists because `Ticket` is a frozen contract type. A
 * guessed tier would be a fabricated fact about the owner's work, so the field
 * is filled with one constant and this comment, rather than with an inference.
 */
export const DASHBOARD_TICKET_TIER: TicketTier = "medium";

/**
 * A short label for the run list.
 *
 * `Ticket.title` is documented as "never given to the builder", and it is not:
 * only `brief` reaches the build prompt.
 */
/**
 * Does this brief say anything a person could read?
 *
 * `trim().length > 0` IS NOT THAT, AND THE DIFFERENCE WAS DEMONSTRATED against
 * the running dashboard on 2026-08-03. A brief of eight U+200B (zero-width
 * space) characters renders as a visibly EMPTY textarea, and:
 *
 *     "​​​​​​​​".trim().length          -> 8   (passes a > 0 check)
 *     visible graphemes                 -> 0
 *
 * `String.prototype.trim` removes whitespace, which by its definition includes
 * NBSP and the BOM but NOT the format category — so U+200B, U+00AD (soft
 * hyphen), U+2060 (word joiner) and U+202E (right-to-left override) all read as
 * content. Both guards on this app's most expensive action were that check: the
 * client's disabled-submit at `src/app/page.tsx`, and this package's own
 * `POST /api/runs` validation. An owner who pastes a line copied out of a PDF or
 * a web page — which routinely carries these — could arm a billed build from a
 * field he can see is empty.
 *
 * WHY IT IS WORSE THAN A WASTED RUN. The acceptance suite is authored from the
 * brief and then FROZEN BY DIGEST before any code exists. A suite authored from
 * nothing is not a yardstick; it is sixteen inferred criteria and a verdict that
 * describes guesses. That is the exact failure `spec-assumptions.ts` and the
 * plan phase exist to reduce.
 *
 * `\p{Cf}` IS THE WHOLE FORMAT CATEGORY, deliberately, rather than the four
 * code points that were demonstrated: enumerating them is how the next one gets
 * in. Combining marks are NOT stripped — a lone combining mark is degenerate,
 * but stripping the category would break scripts where marks carry meaning, and
 * this predicate must never refuse a brief written in one.
 *
 * THE CLIENT HAS ITS OWN COPY, at `dashboard/src/lib/attachments.ts`, because the
 * two packages share no code. This one is the authority: the client's copy only
 * decides whether a button looks pressable.
 */
export function briefHasContent(brief: string): boolean {
  return brief.replace(/\p{Cf}/gu, "").trim().length > 0;
}

export function titleFromBrief(brief: string): string {
  const firstMeaningfulLine =
    brief
      .split("\n")
      .map((line) => line.replace(/^\s*#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "";
  if (firstMeaningfulLine.length === 0) return "Untitled ticket";
  return firstMeaningfulLine.length > MAX_TITLE
    ? `${firstMeaningfulLine.slice(0, MAX_TITLE - 1)}…`
    : firstMeaningfulLine;
}

/**
 * Stable ticket id for a brief.
 *
 * A filesystem path segment (`dashboard/acceptance/<id>/`), so it is restricted
 * to characters that need no escaping anywhere.
 */
export function ticketIdFor(brief: string): string {
  return `t-${ticketDigest(brief).slice(0, 16)}`;
}

/**
 * Build the frozen `Ticket`.
 *
 * `sha256` is computed by `ticketDigest`, the only place in the tree permitted
 * to compute it: raw UTF-8 bytes, no normalisation, no trimming. The brief is
 * stored exactly as submitted — trimming it here would produce a ticket whose
 * digest does not match the text the owner sees in the UI.
 */
export function ticketFromText(brief: string): Ticket {
  return {
    id: ticketIdFor(brief),
    tier: DASHBOARD_TICKET_TIER,
    title: titleFromBrief(brief),
    brief,
    sha256: ticketDigest(brief),
  };
}

/**
 * What a ticket carries besides its words.
 *
 * `prose` IS WHAT THE OWNER TYPED, verbatim and untouched. `capture` is the
 * dashboard's reading of a page the prose names, which becomes TEXT inside the
 * brief; `images` are files only an agent with a filesystem can look at, and
 * they never become text.
 */
export interface TicketReferences {
  readonly prose: string;
  readonly images: readonly ReferenceImage[];
  readonly capture: SiteCapture | null;
  /**
   * Documents the owner attached — a scope, a brief, a CV.
   *
   * OPTIONAL, AND THE OMITTED CASE IS THE OLD BEHAVIOUR EXACTLY. Callers written
   * before documents existed (including `ticket-refs.test.ts`, which pins the
   * golden id) pass three fields and get the id they have always got, because an
   * empty document list contributes nothing to the identity material. With
   * `exactOptionalPropertyTypes` on, a caller that has none must OMIT this key or
   * pass `[]` — never `undefined`.
   *
   * THEY ARE IDENTITY, NOT TEXT. Their digests enter the id, exactly as an
   * image's does. Their CONTENTS do not enter `brief`: this module never opens a
   * file, and whether a document's extracted text is put in front of a seat is a
   * decision made elsewhere (`document-intake.ts` produces the text; nothing in
   * this file consumes it).
   */
  readonly documents?: readonly ReferenceDocument[];
  /**
   * How a page the owner named as a MOTION REFERENCE was observed to move.
   *
   * OPTIONAL ON THE SAME TERMS AS `documents`, and the omitted case is the old
   * behaviour exactly: a caller that passes four fields gets the id it has always
   * got, because a `null` motion contributes nothing to the brief and nothing to
   * the identity material. With `exactOptionalPropertyTypes` on, a caller that
   * has none must OMIT this key or pass `null` — never `undefined`.
   *
   * IT IS BOTH TEXT AND IDENTITY, WHICH NO OTHER FIELD HERE IS. Its prose is
   * composed into `brief` (so it moves `sha256` and the id together, like the
   * capture's outline) AND its address is folded into the identity material (so
   * it moves the id alone, like an image's digest). `referenceIdentityMaterial`
   * says why the address is the only part folded and why `capturedAt` is not.
   */
  readonly motion?: MotionSpec | null;
}

/**
 * A ticket whose identity covers its references as well as its words.
 *
 * THE OWNER MADE THIS CALL EXPLICITLY: the same sentence with a different
 * reference image is a DIFFERENT ticket with its OWN frozen suite. The
 * alternative — one id for both — means two runs with different visual briefs
 * share one sealed suite, and the verdict then cannot say which reference the
 * build was graded against. The accepted cost is that re-uploading the same file
 * mints a new ticket and re-authors a suite, spending quota.
 *
 * THREE FIELDS, THREE DIFFERENT ANSWERS, AND THE SPLIT IS THE WHOLE FUNCTION:
 *
 *   `brief`  = prose + the captured outline. TEXT ONLY. This is what the spec
 *              seat receives (`spec-agent.ts:712` sends the brief verbatim and
 *              nothing else) and what the builder is handed as the ticket.
 *   `sha256` = `ticketDigest(brief)` and NOTHING ELSE. It cannot cover the image
 *              digests: `spec-agent.ts:632` and `runner.ts:1124` both refuse a
 *              ticket whose `sha256` is not exactly the digest of its `brief`,
 *              so widening this field would fail the run at the first seat.
 *   `id`     = sha256(brief + the image digests + the document digests + the
 *              motion reference's address). Nothing
 *              in bakeoff recomputes an id from a brief — it is used as a path
 *              segment (`spec-freeze.ts:80`) and as a label — which is precisely
 *              why the extra material can live here and nowhere else. Grepped
 *              this session across `bakeoff/src` and `dashboard/server/src`; the
 *              only recomputation sites were `http.ts` and `orchestrator.ts`,
 *              both of which now take the id from the persisted row.
 *
 * WITH NO REFERENCES THIS IS BYTE-IDENTICAL TO `ticketFromText(prose)`. Not
 * approximately: `composeBrief` returns the prose unchanged when there is no
 * capture, and `referenceIdentityMaterial` returns the brief unchanged when
 * there are no images AND no documents, so all five fields are the same values.
 * That property is load-bearing — a silent id change would orphan every frozen
 * suite already on disk — and `ticket-refs.test.ts` asserts it, including
 * against a hardcoded golden id so that a change to either helper cannot move it
 * unnoticed.
 *
 * DOCUMENTS RIDE THE IMAGE RULE, AND THE OWNER ASKED FOR THAT SPECIFICALLY: a
 * changed scope document must re-author the suite, because a suite written from
 * the old scope is not a yardstick for work done against the new one. What that
 * costs is the same as for images and is not hidden — a re-uploaded PDF whose
 * bytes changed by one character mints a new ticket and spends quota authoring a
 * new suite.
 *
 * THE TITLE COMES FROM THE PROSE, not from the composed brief. They are the same
 * string in every reachable case (`http.ts` refuses an empty ticket), but a
 * title lifted out of a machine-written capture block would be a run list
 * labelled with somebody else's page title, and that is worth one line to
 * prevent.
 */
export function ticketWithReferences(references: TicketReferences): Ticket {
  const motion = references.motion ?? null;
  const brief = composeBrief(references.prose, references.capture, motion);
  return {
    ...ticketOver(brief, references.images, references.documents ?? [], motion),
    title: titleFromBrief(references.prose),
  };
}

/**
 * THE ONE PLACE A `Ticket`'S FIVE FIELDS ARE BUILT, for both ways in.
 *
 * Not extracted for tidiness: `id` and `sha256` cover deliberately DIFFERENT
 * material (see `ticketWithReferences`), and two constructions of that pair are
 * two chances for one of them to drift into covering the other's material — a
 * drift that shows up as `spec-agent.ts:632` refusing the ticket at the first
 * seat, or worse, as a silently different id that authors a second suite.
 *
 * EVERY PARAMETER IS REQUIRED, INCLUDING `motion`, AND THAT IS THE POINT OF
 * TAKING IT HERE. A default would let the read-back path below keep compiling
 * while computing an id the intake never minted — the failure `ticketFromStored-
 * Brief` documents as a live instance of this exact class. Required, the
 * compiler is what enforces that both paths fold the same material; a test could
 * only notice afterwards.
 */
function ticketOver(
  brief: string,
  images: readonly ReferenceImage[],
  documents: readonly ReferenceDocument[],
  motion: MotionSpec | null,
): Ticket {
  return {
    id: ticketIdFor(referenceIdentityMaterial(brief, images, documents, motion)),
    tier: DASHBOARD_TICKET_TIER,
    title: titleFromBrief(brief),
    brief,
    sha256: ticketDigest(brief),
  };
}

/**
 * THE READ-BACK PATH, AND THE ONE TO USE: rebuild a ticket from the brief stored
 * on the run row plus the WHOLE manifest written beside the run.
 *
 * WHY IT TAKES THE MANIFEST AND NOT A LIST. {@link ticketFromStoredBrief} takes
 * images alone and therefore cannot see documents; a caller holding a manifest
 * and passing `manifest.images` gets an id that silently disagrees with the one
 * the intake persisted, which sends the run to `authorAndFreezeSuite` — real
 * quota, and a suite the row's own `ticketId` does not name. Taking the manifest
 * itself removes the opportunity: every list it holds is folded in here, and a
 * list added to the manifest later is a change in ONE place.
 *
 * A `null` MANIFEST IS THE PROSE-ONLY TICKET, deliberately and unchanged: an
 * absent, corrupt or unreadable manifest all read as `null` (`ticket-refs.ts`
 * says why it flattens them), and the caller — `orchestrator.ts` — already
 * compares the derived id against `row.ticketId` and emits a `warn` when they
 * differ, which is the visible half of this failure.
 *
 * IT DOES NOT READ `row.ticketId`, for the reason stated on
 * {@link ticketFromStoredBrief}.
 */
export function ticketFromStoredReferences(brief: string, manifest: ReferenceManifest | null): Ticket {
  return ticketOver(brief, manifest?.images ?? [], manifestDocuments(manifest), manifestMotion(manifest));
}

/**
 * The READ-BACK path, IMAGES ONLY — superseded by
 * {@link ticketFromStoredReferences}, and NO PRODUCTION CALLER REMAINS.
 *
 * THE PARAGRAPH THAT USED TO BE HERE IS NOW FALSE, so it is gone rather than
 * softened: it said `orchestrator.ts` still derived its ticket through this
 * function and named the outstanding change. That change landed —
 * `orchestrator.ts:1745` reads `ticketFromStoredReferences(row0.ticketText,
 * manifest)` — and grepping `ticketFromStoredBrief` across
 * `dashboard/server/src` on 2026-08-04 returned this declaration, one comment,
 * and three lines of `ticket-refs.test.ts`. It is kept because that test is the
 * one that pins the lossy `ticketProse` round trip through it, and because a
 * caller outside this package could still exist.
 *
 * WHAT IT DOES NOT DO, SAID PLAINLY: it does not fold DOCUMENT digests, and
 * since 2026-08-04 it does not fold a MOTION reference's address either — its
 * signature holds neither, and both are passed as empty below. Any caller that
 * appears for a ticket carrying one of those derives a DIFFERENT id from the one
 * the intake wrote to `runs.ticket_id`, does not find that ticket's frozen
 * suite, and authors a second one on the owner's quota — with no throw and no
 * compile error. That is why the replacement takes the whole manifest and why
 * its `motion` parameter is required rather than defaulted.
 *
 * WHY THIS SIGNATURE WAS NOT SIMPLY WIDENED. A defaulted third parameter would
 * let that call site keep compiling while computing the wrong id with no warning
 * anywhere, and changing the parameter type outright breaks files this change is
 * not allowed to edit. A second, correct function that the old one points at is
 * the only option that neither lies nor breaks someone else's build.
 *
 * WHY THIS EXISTS AND WHY IT DOES NOT RE-COMPOSE. `ticketWithReferences` builds
 * the brief from prose + capture at intake. The orchestrator, later, has the
 * COMPOSED brief in `row.ticketText` and must arrive at the same ticket. It
 * could strip the capture block back off and re-compose — and that would be a
 * second composition site that has to agree with the first byte for byte, which
 * it would not: a prose ending in blank lines does not survive the round trip,
 * and the symptom would be a run authoring a fresh suite under an id nobody can
 * see is wrong.
 *
 * So the stored brief IS the brief. Only the id needs the extra material, and
 * the image digests are exactly what the manifest on disk holds.
 *
 * WITH NO IMAGES THIS IS `ticketFromText(brief)`, value for value —
 * `referenceIdentityMaterial` returns its input unchanged for an empty list. So
 * the orchestrator's behaviour on every run recorded before references existed,
 * and on every run that attaches none, is unchanged.
 *
 * IT DOES NOT READ `row.ticketId`. That column is written by the intake and is
 * the same string this produces, but the orchestrator has never trusted it — the
 * sequencing tests seed it with a placeholder precisely to prove the run finds
 * its frozen suite by derivation. Trusting it would send those tests (and any
 * row whose id was seeded by something other than the intake) to
 * `authorAndFreezeSuite`, which spawns the real CLI and spends quota.
 */
export function ticketFromStoredBrief(brief: string, images: readonly ReferenceImage[]): Ticket {
  return ticketOver(brief, images, [], null);
}
