/**
 * design-lane.ts — does the DESIGN lane run, and in which of its FOUR working
 * states.
 *
 * SPEC §6.5, VERBATIM:
 *
 *   designLane = surface ∈ {web-ui, fullstack}
 *             && (visualIntent(ticket) || surface === "web-ui")
 *             && geminiKeyAvailable()
 *
 * AND THE SENTENCE THAT FOLLOWS IT IS WHY THIS RETURNS A MODE AND NOT A
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
 * THE FOURTH STATE, `reused`, ADDED 2026-08-12, AND IT IS A SPEND CONTROL WITH AN
 * HONESTY REQUIREMENT ATTACHED. Measured on tonight's `results/design-lane.json`:
 * `"mode": "full", "images": 11, "imageCalls": 5` — three directions canvassed,
 * ONE locked, the other two discarded the moment the choice landed. Eleven runs of
 * the same portfolio ticket each paid that, against a Gemini key that is the
 * binding constraint on how often this pipeline can be tested at all. A run that
 * names `reuseDesignFrom` copies a previous run's `design-refs/` instead and makes
 * ZERO generation calls.
 *
 * IT IS A FOURTH STATE RATHER THAN A FLAG ON `full` BECAUSE THE LANE IS A VARIABLE
 * IN EVERY COMPARISON THIS DASHBOARD MAKES. A verdict from a run whose art came
 * from somewhere else is not the same experiment as one that made its own, and the
 * two must never be readable as one another — the same rule that keeps `degraded`
 * out of `off`. `design-outcome.ts` carries the other half: the record names the
 * SOURCE RUN and the count of stills copied.
 *
 * PURE AND SYNCHRONOUS, like `classifySurface` and for the same reason: the mode
 * decides `allowedAgents` for segment 1, which is a permission boundary, and a
 * boundary that can await has a failure mode. The reuse term keeps that property —
 * it is a run id the caller already validated at intake, not a filesystem probe.
 * Everything that touches disk lives in `design-reuse.ts`.
 */

import type { Surface } from "./agent-shortlist.js";
import type { DesignCapability } from "./design-capability.js";

export type DesignLaneMode = "full" | "degraded" | "off" | "reused";

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

/**
 * WHICH OF THE LANE'S FOUR STATES THIS RUN IS IN, AND THE CONDITION FOR EACH.
 *
 *   "off"      — `designSurfaceGate` is false: the surface is not `web-ui` or
 *                `fullstack`, or a `fullstack` ticket never asked for design. No
 *                DESIGN agents are shortlisted and no design segment runs. This is
 *                the ONLY answer the capability half cannot reach, which is what
 *                keeps the `allowedAgents` boundary total (see `designSurfaceGate`).
 *
 *   "reused"   — the lane is on AND this run was submitted with `reuseDesignFrom`,
 *                whose source `POST /api/runs` validated on disk before minting a
 *                run id. The stills, the manifest and the lock are COPIED from that
 *                run into this workspace before the build segment is prompted; no
 *                image is generated and no design segment runs.
 *
 *   "degraded" — the lane is on and this machine cannot generate: no Gemini key
 *                resolves, or the image script is not on disk, or the preflight
 *                found a blocking fault. `taste-frontend-expert` still art-directs
 *                and writes `direction.md`; the visual gate falls back to
 *                rule-based scoring with no reference image.
 *
 *   "full"     — the lane is on and can generate. Stills, a manifest, and a locked
 *                reference for the gate.
 *
 * THE REUSE TERM SITS BETWEEN THE SURFACE GATE AND THE CAPABILITY TERMS, AND BOTH
 * SIDES OF THAT PLACEMENT ARE LOAD-BEARING.
 *
 * AFTER the surface gate: a `cli` ticket has no lane to feed, so copying art into
 * it would spend disk to hand a terminal program a hero mockup.
 *
 * BEFORE the capability terms: reuse is precisely what a machine with NO KEY can
 * still do. `degraded` means "could not generate", and answering it here would
 * degrade a run that needs to generate nothing — it would lose the copied stills
 * from the handoff (`designHandoffSection` branches on `degraded` and tells the
 * builder no stills exist) and grade the build against the rule-based floor while
 * a locked reference sat in its own workspace.
 */
export function designLaneMode(input: {
  surface: Surface;
  ticketText: string;
  capability: DesignCapability;
  preflightOk: boolean;
  /**
   * The run this one copied its design assets from, or null.
   *
   * DEFAULTED so every caller written before 2026-08-12 keeps its exact meaning —
   * a lane cannot become `reused` by omission, only by a run id somebody asked
   * for and `validateDesignReuseSource` accepted.
   */
  reusedFrom?: string | null;
}): DesignLaneMode {
  if (!designSurfaceGate(input.surface, input.ticketText)) return "off";
  if ((input.reusedFrom ?? null) !== null) return "reused";
  // The third term of §6.5's predicate. False here means DEGRADED, never off.
  if (!input.capability.key.available || input.capability.imageScript === null) return "degraded";
  if (!input.preflightOk) return "degraded";
  return "full";
}
