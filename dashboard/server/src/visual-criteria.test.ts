/**
 * visual-criteria.test.ts — the QUALITY criteria, and the one that must never be empty.
 *
 * THE LOAD-BEARING TEST IS THE LAST ONE. Everything above it checks the shape of
 * what `visualCriteriaFor` returns; the last one checks that it returns anything
 * at all. That is not a formality. Task 3's rule is "any unmet BLOCKING or
 * FUNCTIONAL -> fail, otherwise >=1 QUALITY finding -> pass_with_notes,
 * otherwise pass" — so an empty criteria set silently collapses
 * `pass_with_notes` into `pass`, and calibration can no longer tell
 * `stock-motion-only` (hover box-shadow, opacity fade, Inter-and-slate) from
 * `correct-portfolio` (scroll-driven staggered reveals). Both grade `pass`, the
 * suite stays green, and Task 2 could be entirely non-functional without anyone
 * finding out. (Revision 2, R3.)
 *
 * THE MOTION TEST IS THE OTHER ONE WORTH READING. It asserts what the criterion
 * may NOT say. The owner's own site, kamilborzecki.dev, is scroll-scrubbed video
 * with zero CSS animations — a criterion demanding GSAP or Framer would grade the
 * reference site a failure. The satisfiers are a disjunction, and the assertion
 * that no single library is mandated is the part that stops that regressing.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DesignManifest } from "./visual-criteria.js";
import { visualCriteriaFor } from "./visual-criteria.js";

/** The DESIGN lane's happy path: the owner clicked a mockup and it was recorded. */
function manifestWithLock(lockedMockup = "/ws/design-refs/02-hero.png"): DesignManifest {
  return { lockedMockup };
}

test("visual criteria are QUALITY tier — they report, they never block", () => {
  // Owner decision 2026-07-28: subjective judgement must not false-fail a run.
  for (const v of visualCriteriaFor(manifestWithLock())) assert.equal(v.tier, "QUALITY");
});

test("every visual criterion points at the LOCKED mockup, not the whole set", () => {
  const m = manifestWithLock("/ws/design-refs/02-hero.png");
  const v = visualCriteriaFor(m);
  for (const c of v) {
    if (c.reference !== null) assert.equal(c.reference, "/ws/design-refs/02-hero.png");
  }
  // The loop above is vacuously green when NOTHING carries a reference, which an
  // implementation that never reads `lockedMockup` satisfies perfectly. A locked
  // mockup nobody points at is not a lock.
  assert.ok(
    v.some((c) => c.reference !== null),
    "a locked mockup nobody points at is not a lock",
  );
});

test("with no locked design, criteria fall back to rule-based and say so", () => {
  // The DESIGN lane degrades rather than blocks when no Gemini key resolves.
  const v = visualCriteriaFor({ lockedMockup: null });
  assert.ok(v.length > 0, "still graded, just without a reference");
  assert.ok(v.every((x) => x.reference === null));
});

test("a motion criterion accepts EVERY satisfier the owner's own site uses", () => {
  // kamilborzecki.dev uses scroll-scrubbed video and ZERO CSS animations.
  // A criterion demanding GSAP would fail the owner's own reference site.
  const motion = visualCriteriaFor(manifestWithLock()).filter((v) => v.check === "motion");
  assert.ok(motion.length > 0);
  const text = motion.map((m) => m.statement).join(" ");
  assert.match(text, /scroll|scrub|timeline|rAF|stagger|pin/i);
  assert.doesNotMatch(text, /\bmust use (GSAP|Framer)\b/i, "no single library may be mandated");
});

// NEGATIVE CONTROL (Revision 2, R3). If this set can be empty, `pass_with_notes`
// collapses into `pass` and Task 4A cannot tell `stock-motion-only` from
// `correct-portfolio` — with calibration still green.
test("the criteria set is never empty, in either manifest state", () => {
  assert.ok(visualCriteriaFor(manifestWithLock()).length > 0);
  assert.ok(visualCriteriaFor({ lockedMockup: null }).length > 0);
});
