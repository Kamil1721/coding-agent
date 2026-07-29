/**
 * design-lane.ts — does the DESIGN lane run, and in which of its two working
 * states.
 *
 * SPEC §6.5, VERBATIM:
 *
 *   designLane = surface ∈ {web-ui, fullstack}
 *             && (visualIntent(ticket) || surface === "web-ui")
 *             && geminiKeyAvailable()
 *
 * AND THE SENTENCE THAT FOLLOWS IT IS WHY THIS RETURNS THREE VALUES AND NOT A
 * BOOLEAN: "If false, DESIGN degrades — it does not block. `taste-frontend-expert`
 * still art-directs and produces written direction; the visual gate falls back to
 * rule-based scoring with no reference PNGs; the canvas shows the lane as
 * degraded. Blocking a build on an absent image key is a worse failure than
 * shipping without mockups."
 *
 * So the third term does not turn the lane OFF; it moves it to `degraded`. The
 * first two terms are what turn it off. Collapsing the two into one boolean is
 * precisely how a lane that could not generate becomes indistinguishable from a
 * lane that had nothing to generate — see design-outcome.ts, which exists to keep
 * those two apart.
 *
 * PURE AND SYNCHRONOUS, like `classifySurface` and for the same reason: the mode
 * decides `allowedAgents` for segment 1, which is a permission boundary, and a
 * boundary that can await has a failure mode.
 */

import type { Surface } from "./agent-shortlist.js";
import type { DesignCapability } from "./design-capability.js";

export type DesignLaneMode = "full" | "degraded" | "off";

/**
 * Whole words only, for the reason `surface.ts` spells out: `includes("ui")`
 * matches "build", and a substring hit here would route an API ticket into five
 * paid image generations.
 *
 * DEVIATION FROM THE PLAN, RECORDED: the plan's literal list carries `"designs"`
 * alongside `"design"`, and its own test asserts
 * `visualIntent("fix the database migration for the designs table") === false`.
 * The two cannot both hold — the match is whole-word, so `"designs"` matches that
 * ticket exactly. The plural is dropped rather than the test relaxed, because the
 * prose on `visualIntent` below ("the designs table is a schema, not a brief")
 * says which of the two the author meant. `"redesign"` is listed separately for
 * the same whole-word reason and is NOT an oversight: `design` does not match
 * inside `redesign`.
 */
const VISUAL_INTENT = [
  "design",
  "designed",
  "redesign",
  "art direction",
  "art-directed",
  "visual",
  "visuals",
  "aesthetic",
  "aesthetics",
  "look and feel",
  "brand",
  "branding",
  "mockup",
  "mockups",
  "beautiful",
  "polished",
  "considered",
  "typography",
  "palette",
  "motion",
  "animation",
  "animations",
] as const;

function mentions(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const literal = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![a-z0-9])${literal}(?![a-z0-9])`, "u").test(text);
  });
}

/**
 * Does the ticket ASK for design?
 *
 * "the designs table" is a schema, not a brief, so the match is on the word in
 * isolation and the surface gate in front of it does the rest of the work: a
 * `fullstack` ticket has to say so, a `web-ui` ticket never has to.
 */
export function visualIntent(ticketText: string): boolean {
  return mentions(ticketText.toLowerCase(), VISUAL_INTENT);
}

/**
 * THE PURE HALF, AND THE ONLY HALF THAT CAN SAY "off".
 *
 * `shortlistFor` feeds a permission boundary, and `surface.ts` is explicit that a
 * boundary which can await or fail is not a boundary. Everything that decides
 * whether the DESIGN agents are shortlisted lives in this function: surface and
 * `visualIntent`, both pure, both total. The capability terms below can only
 * choose between `full` and `degraded`, which shortlist identically.
 *
 * Exported so the orchestrator can ask it BEFORE running the preflight — a `cli`
 * ticket has no business spending 20 seconds probing `npx`.
 */
export function designSurfaceGate(surface: Surface, ticketText: string): boolean {
  if (surface !== "web-ui" && surface !== "fullstack") return false;
  return visualIntent(ticketText) || surface === "web-ui";
}

export function designLaneMode(input: {
  surface: Surface;
  ticketText: string;
  capability: DesignCapability;
  preflightOk: boolean;
}): DesignLaneMode {
  if (!designSurfaceGate(input.surface, input.ticketText)) return "off";
  // The third term of §6.5's predicate. False here means DEGRADED, never off.
  if (!input.capability.key.available || input.capability.imageScript === null) return "degraded";
  if (!input.preflightOk) return "degraded";
  return "full";
}
