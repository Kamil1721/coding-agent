/**
 * design-directions.ts — the design park's clock, and the one string the reply
 * box is allowed to send.
 *
 * =========================================================================
 * THE DEADLINE IS NOT ON THE WIRE, SO IT COMES OFF THE LOG — OR IT IS ABSENT
 * =========================================================================
 *
 * `ApiDesignLock` carries neither `parkedAt` nor the configured timeout, and
 * `design-lock.tsx` refused to invent one in writing: "a clock invented in the
 * browser would be a number the owner could plan around and be wrong about."
 * That refusal still stands. What has changed is that the owner is now being
 * asked to spend renders and turns at this park, so "how long have I got" is a
 * question the screen has to answer or say it cannot.
 *
 * SO THE SOURCE IS THE SERVER'S OWN PARK LINE, exactly as `plan-dialogue.ts`
 * derives the plan clock: `#parkForDesignLock` emits one `info` line naming the
 * window in minutes, and the event's own instant IS the park instant — the line
 * is emitted from the same synchronous block that writes `parkedAt`, and
 * `reconcileOnBoot` re-arms with the ORIGINAL `parkedAt` rather than a fresh
 * one. A reload therefore replays the same line with the same timestamp and the
 * countdown does not reset, which is the property the panel claims on screen.
 *
 * TWO INDEPENDENT MATCHES, BOTH REQUIRED, FIRST LINE WINS. A partial match
 * yields NO clock rather than a clock computed from a default nobody configured
 * (`DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN` is settable). The server is rewriting
 * this line as the frozen-suite sentence goes onto it, so no-number is the
 * EXPECTED reading until those two land together — which is why the consequence
 * sentence under the clock renders whether or not there is a number.
 *
 * WHAT THIS CLOCK CANNOT PROMISE, said rather than left to be discovered: the
 * trace is capped (3000 entries) and a long dialogue can push the first park
 * line off the top. A re-park line would then be the earliest one this sees and
 * the deadline would read LATER than it is. The cap is the client's, the park is
 * the server's, and nothing on this side can tell a first line from a survivor —
 * so the honest fix is `parkedAt` on `ApiDesignLock`, not more parsing here.
 */

import type { TraceEntry } from "./use-run-stream";
import { planCountdown, type PlanCountdown } from "./plan-dialogue";

/**
 * The design park's announcement. Matched on the two things that identify it
 * rather than on the sentence, because the sentence is being rewritten.
 */
const DESIGN_PARK = /DESIGN lane/i;
/** `waiting for one to be chosen`, `waiting for a direction to be chosen`, … */
const DESIGN_PARK_WAITING = /waiting for [^.]{0,40}to be chosen/i;

/** `with no choice inside 30 minutes` — the window, wherever it sits in the line. */
const DESIGN_PARK_WINDOW = /inside\s+(\d+(?:\.\d+)?)\s+minutes/i;

export interface DesignParkClock {
  /** When the window runs out, or null when the log never said. */
  readonly deadlineMs: number | null;
  /** The configured window in minutes, for the sentence under the clock. */
  readonly windowMin: number | null;
}

/** Everything the run's own log said about when this park closes. */
export function designParkClock(trace: readonly TraceEntry[]): DesignParkClock {
  const rows = Array.isArray(trace) ? trace : [];
  for (const entry of rows) {
    const text = entry.text;
    if (!DESIGN_PARK.test(text) || !DESIGN_PARK_WAITING.test(text)) continue;
    const minutes = DESIGN_PARK_WINDOW.exec(text)?.[1];
    if (minutes === undefined) continue;
    const windowMin = Number.parseFloat(minutes);
    // THE FIRST MATCH, NOT THE LAST. Every re-park carries the original
    // `parkedAt` forward, so a later announcement must not push the deadline out.
    return { deadlineMs: entry.atMs + windowMin * 60_000, windowMin };
  }
  return { deadlineMs: null, windowMin: null };
}

/**
 * How long is left, or null when the wire never said.
 *
 * DELEGATED TO THE PLAN PARK'S OWN FUNCTION rather than reimplemented: the two
 * parks close the same way (the timer fires, the server proceeds, and the row
 * can still read `awaiting_input` for a beat), so a second countdown here would
 * be a second chance to get `closing` wrong.
 */
export function designCountdown(deadlineMs: number | null, nowMs: number): PlanCountdown | null {
  return planCountdown(deadlineMs, nowMs);
}

/* -------------------------------------------------------------------------
 * THE REQUEST
 * ---------------------------------------------------------------------- */

/**
 * `show me the contact section in editorial-slab`.
 *
 * COMPOSED, NOT TYPED FREEHAND, AND THE PANEL SHOWS THE EXACT STRING IT SENDS —
 * `plan-dialogue.ts`'s rule, for the same measured reason. The server's
 * `parseDesignRequest` returns null when a message names neither a section nor a
 * direction, and a null parse means the message is NOT claimed by the design
 * dialogue: it stays pending for the next segment boundary, so the owner's
 * "show me the contact page in 3" would look sent, cost nothing, and answer
 * nothing. Addressing a direction by its SLUG rather than by an ordinal or a
 * name removes the only part of that parse this side can get wrong.
 *
 * THE SECTION IS HIS OWN WORDS, deliberately. The brief's section names are not
 * on the wire, and a picker built from the canvassed stills could only offer the
 * two sections the canvass rendered — which is the opposite of the question he
 * is being invited to ask.
 */
export function composeDesignRequest(section: string, slug: string): string {
  return `show me the ${section.trim()} in ${slug}`;
}

/* -------------------------------------------------------------------------
 * WHAT BECAME OF A REQUEST
 * ---------------------------------------------------------------------- */

export interface RequestOutcomeView {
  readonly label: string;
  /** True when the outcome spent a render and produced no image. */
  readonly refused: boolean;
}

/**
 * The outcome vocabulary, WITH A DEFAULT BRANCH — `outcome` is typed `string` on
 * both sides on purpose, and a value this build has never heard of is a newer
 * server rather than a bug. An unknown outcome renders as itself.
 *
 * `rendered-off-brief` IS NOT A REFUSAL AND MUST NOT READ AS ONE: the still
 * exists and is shown; what the label adds is that the build will not produce
 * that section, so no verdict will ever mention it.
 */
export function requestOutcome(outcome: string): RequestOutcomeView {
  switch (outcome) {
    case "rendered":
      return { label: "rendered", refused: false };
    case "rendered-off-brief":
      return { label: "rendered — not a section the build will produce", refused: false };
    case "unknown-direction":
      return { label: "no direction by that name — nothing was rendered", refused: true };
    case "no-section":
      return { label: "no section named — nothing was rendered", refused: true };
    case "turn-cap":
      return { label: "the turn cap was reached", refused: true };
    case "render-cap":
      return { label: "the render cap was reached", refused: true };
    case "failed":
      return { label: "the render failed, and it still spent one", refused: true };
    default:
      return { label: outcome, refused: false };
  }
}
