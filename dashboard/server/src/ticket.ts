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
 */

import type { Ticket, TicketTier } from "bakeoff/dist/contracts.js";
import { ticketDigest } from "bakeoff/dist/hash.js";

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
