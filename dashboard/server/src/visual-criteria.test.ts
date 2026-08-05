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
import type { OwnerReference } from "./owner-reference.js";
import type { DesignLock } from "./visual-criteria.js";
import { visualCriteriaFor } from "./visual-criteria.js";

/** The DESIGN lane's happy path: the owner clicked a mockup and it was recorded. */
function manifestWithLock(lockedMockup = "/ws/design-refs/02-hero.png"): DesignLock {
  return { lockedMockup };
}

/**
 * What `ownerReferenceFor` returns for the one run in this project's history
 * where the owner actually attached a design — same shape, same digest.
 * `owner-reference.test.ts` proves this value can be obtained from the real run
 * on disk; here it stands for "the owner supplied something".
 */
const OWNER: OwnerReference = {
  path: "/runs/r1/references/reference-1.png",
  sha256: "56c0c61c4e960bfe707284581827b7d074ad946dd0ec7d7f6f4bfe5f04b3cfe3",
  bytes: 559_692,
};

test("visual criteria are QUALITY tier — they report, they never block", () => {
  // Owner decision 2026-07-28: subjective judgement must not false-fail a run.
  // THE OWNER'S OWN IMAGE IS IN THE LOOP TOO. "Follow the design I gave you" is
  // the check most likely to be argued into a gate; it reports like the rest.
  for (const v of visualCriteriaFor(manifestWithLock(), OWNER)) assert.equal(v.tier, "QUALITY");
});

test("every mockup comparison points at the LOCKED mockup, not the whole set", () => {
  const m = manifestWithLock("/ws/design-refs/02-hero.png");
  // WITH THE OWNER'S IMAGE ALSO PRESENT, which is the case that makes this test
  // mean something it did not mean before 2026-08-05: two absolute PNG paths are
  // now in flight and only one of them is the design that was CHOSEN.
  const v = visualCriteriaFor(m, OWNER);
  for (const c of v) {
    if (c.referent === "locked-mockup") assert.equal(c.reference, "/ws/design-refs/02-hero.png");
    if (c.referent === "none") assert.equal(c.reference, null);
  }
  // The loop above is vacuously green when NOTHING carries a reference, which an
  // implementation that never reads `lockedMockup` satisfies perfectly. A locked
  // mockup nobody points at is not a lock.
  assert.ok(
    v.some((c) => c.referent === "locked-mockup"),
    "a locked mockup nobody points at is not a lock",
  );
  // AND THE TWO REFERENTS MAY NEVER CROSS. A criterion carrying the owner's file
  // under `locked-mockup` would report his attachment as the design that was
  // chosen — the exact confusion the lock exists to end.
  assert.equal(
    v.filter((c) => c.reference === OWNER.path).every((c) => c.referent === "owner-image"),
    true,
  );
  assert.equal(
    v.filter((c) => c.referent === "owner-image").every((c) => c.reference === OWNER.path),
    true,
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

/* -------------------------------------------------------------------------
 * R1 — "it builds the design I PROVIDED"
 *
 * Every comparison above this line compares the build against something a MODEL
 * generated: the lock is fenced to `<workspace>/design-refs/`, so `lockedMockup`
 * is always a mockup we invented. These are the tests that the owner's own
 * attachment reaches a criterion at all.
 * ---------------------------------------------------------------------- */

test("the owner's supplied image REACHES the criteria, as its own referent", () => {
  const withOwner = visualCriteriaFor(manifestWithLock(), OWNER);
  const owned = withOwner.filter((c) => c.referent === "owner-image");
  assert.ok(owned.length > 0, "the design he provided must reach the grader, or R1 is unmet");
  for (const c of owned) assert.equal(c.reference, OWNER.path);

  // THE MUTATION THIS TEST EXISTS FOR: falling back to a generated mockup. An
  // implementation that ignores `ownerReference` and points these at
  // `lockedMockup` — or that emits nothing new at all — satisfies every other
  // assertion in this file.
  assert.ok(
    owned.every((c) => c.reference !== manifestWithLock().lockedMockup),
    "an owner-image criterion pointing at a generated mockup is the fallback this rules out",
  );
  const withoutOwner = visualCriteriaFor(manifestWithLock());
  assert.ok(withOwner.length > withoutOwner.length, "attaching a design must change what is graded");
});

test("no attachment, no owner criteria — absent is absent, never a green by default", () => {
  // A fidelity check that reports on a ticket which supplied no design reports
  // GREEN on every such ticket: a check that can only observe success. Same rule
  // the design-fidelity spec §1.2.5 states for its measured observation.
  for (const manifest of [manifestWithLock(), { lockedMockup: null }]) {
    const v = visualCriteriaFor(manifest);
    assert.equal(
      v.some((c) => c.referent === "owner-image"),
      false,
    );
  }
});

test("with a lock the MOCKUP answers for the owner's image; without one, the build does", () => {
  // The build was held to the locked mockup — that is what the lock means — so a
  // divergence from the owner's reference was introduced upstream of the build,
  // and its fix is one regeneration rather than an hour of rebuilding. The
  // statement has to name the right seat or the report routes the wrong fix.
  const locked = visualCriteriaFor(manifestWithLock(), OWNER)
    .filter((c) => c.referent === "owner-image")
    .map((c) => c.statement)
    .join(" ");
  assert.match(locked, /LOCKED mockup/u);
  assert.match(locked, /regeneration/u);

  const degraded = visualCriteriaFor({ lockedMockup: null }, OWNER)
    .filter((c) => c.referent === "owner-image")
    .map((c) => c.statement)
    .join(" ");
  assert.ok(degraded.length > 0, "a degraded DESIGN lane must still grade against what he supplied");
  assert.match(degraded, /built page/u);
  assert.doesNotMatch(degraded, /LOCKED mockup/u, "there is no mockup to hold responsible");
});

test("the owner criteria do not demand a pixel match or a type match", () => {
  // "No pixels lifted from the reference" fails the only build that ever passed
  // — both its shipped photographs are crops of the mockups. And an attachment
  // can be a photograph or a moodboard with no type system at all, so a family
  // pairing demand is unanswerable on most real references.
  const owned = visualCriteriaFor(manifestWithLock(), OWNER).filter((c) => c.referent === "owner-image");
  const text = owned.map((c) => c.statement).join(" ");
  assert.match(text, /not a pixel match/iu);
  assert.equal(
    owned.some((c) => c.check === "typography"),
    false,
  );
});

// NEGATIVE CONTROL (Revision 2, R3). If this set can be empty, `pass_with_notes`
// collapses into `pass` and Task 4A cannot tell `stock-motion-only` from
// `correct-portfolio` — with calibration still green.
test("the criteria set is never empty, in either manifest state", () => {
  assert.ok(visualCriteriaFor(manifestWithLock()).length > 0);
  assert.ok(visualCriteriaFor({ lockedMockup: null }).length > 0);
});
