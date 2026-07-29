/**
 * visual-criteria.ts — the part of the owner's bar that no unit test reaches.
 *
 * WHY THIS EXISTS. The sealed suite can prove a contact form submits. It cannot
 * prove the page does not read as templated, and it cannot prove the motion was
 * authored rather than reached for. That is most of what the owner actually
 * asked for — "it should feel considered, not templated" is a line in the
 * calibration ticket — and until §17's design lock it was not gradeable either:
 * comparing a build against FIVE mockups answers "does it resemble something we
 * generated", which is not a question. A locked mockup turns it into a precise
 * one: does it match the design that was CHOSEN. The lock-in is a grader
 * improvement wearing a UI feature's clothes.
 *
 * QUALITY, AND NEVER ANYTHING ELSE. Owner decision, 2026-07-28: subjective
 * judgement reports, it never blocks. Every criterion here is `QUALITY`, and the
 * literal type — not a variable — is what stops that eroding. A false fail on
 * taste burns a fix round the run cannot win, and worse, it teaches the owner
 * that red does not mean stop.
 *
 * THE SET MUST NEVER BE EMPTY, AND THAT IS A CORRECTNESS PROPERTY, NOT A NICETY.
 * Task 3's rule is: any unmet BLOCKING or FUNCTIONAL -> fail, otherwise >=1
 * QUALITY finding -> pass_with_notes, otherwise pass. Return `[]` here and
 * `pass_with_notes` quietly becomes unreachable — `stock-motion-only` and
 * `correct-portfolio` both grade `pass`, calibration stays green, and this
 * module can be doing nothing at all. Hence the rule-based floor below applies
 * in BOTH manifest states; the lock adds comparisons, it never gates whether
 * grading happens. (Revision 2, R3.)
 *
 * NO SINGLE MOTION LIBRARY MAY BE MANDATED. kamilborzecki.dev — the owner's own
 * site, and the closest thing this project has to a reference implementation —
 * is scroll-scrubbed video with zero CSS animations. A criterion reading "uses
 * GSAP" would grade the reference site a failure, which is how a quality bar
 * gets quietly deleted after it embarrasses itself once. The motion criteria are
 * therefore a DISJUNCTION of satisfiers plus a named failing case.
 *
 * WHERE THE RULES COME FROM, AND WHERE THEY DO NOT.
 *   - `~/.claude/skills/impeccable/reference/craft-floor.md` — "the quality
 *     floor, the absolute bans, the reflexes no detector catches". Owns
 *     contrast, measure, tracking, shadow, gradient text, and cards-as-page-
 *     structure. NOTE: that file is part of the globally installed `impeccable`
 *     skill and is NOT vendored in this repo; it is quoted here, not imported,
 *     and the design spec (§6.3) names it authoritative.
 *   - `docs/superpowers/specs/2026-07-28-orchestration-canvas-design.md` §8
 *     Layer 1 — the placeholder-media list (`picsum`, `placehold.co`,
 *     `unsplash.com/random`, lorem ipsum) and the Inter-and-slate default.
 *   - The same spec §8 Layer 2 — the three motion satisfiers and the failing
 *     case, verbatim in intent: scroll-scrubbed video, a real GSAP/ScrollTrigger
 *     timeline, or rAF-driven scrubbing; failed by hover/fade/`transition-all`
 *     alone, or a library imported but never driven.
 * Nothing here is invented where one of those already owns the rule.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not look at the build. Criteria are
 * authored before any code exists, and passing build output back into criterion
 * authoring is the one thing the phase forbids outright. It emits statements; a
 * grader elsewhere decides whether they hold.
 */

/**
 * MINIMAL — Phase 2b (DESIGN lane) owns the full manifest and will widen this.
 * Defined here because Phase 2e needs the locked-mockup path and Phase 2b is
 * not built. Do not add fields speculatively: a second declaration site for a
 * type Phase 2b owns is a merge conflict with a wrong answer in it.
 * (Revision 2, R6.)
 */
export interface DesignManifest {
  /** Absolute path to the mockup the owner locked, or null when the lane degraded. */
  readonly lockedMockup: string | null;
}

export interface VisualCriterion {
  readonly id: string;
  readonly tier: "QUALITY"; // owner decision: report, never block
  readonly statement: string;
  readonly reference: string | null; // absolute path to the LOCKED mockup
  readonly check: "layout" | "palette" | "typography" | "motion" | "media";
}

/** A criterion before it knows whether there is a mockup to point at. */
interface CriterionSeed {
  readonly id: string;
  readonly check: VisualCriterion["check"];
  readonly statement: string;
}

/**
 * THE FLOOR. Applies in both manifest states, carries no reference, and is the
 * reason `visualCriteriaFor` can never return an empty set. These are checks on
 * the built result, not on intentions — craft-floor.md's own framing.
 */
const FLOOR: readonly CriterionSeed[] = [
  {
    id: "VIS-MOTION-AUTHORED",
    check: "motion",
    statement:
      "The page carries at least one authored motion moment. Satisfied by ANY of: a scroll-scrubbed " +
      "video or world-journey whose currentTime is driven by scroll progress; a real GSAP or " +
      "ScrollTrigger timeline that is pinned, scrubbed or staggered with custom easing; or rAF-driven " +
      "element scrubbing. Not satisfied by hover lifts, opacity fades or transition-all alone, and not " +
      "by an animation library that is imported but never driven by a timeline.",
  },
  {
    id: "VIS-MOTION-RESTRAINT",
    check: "motion",
    statement:
      "Motion is authored rather than scattered: one focal sequence rather than the same entrance " +
      "replayed on every section, easing out from an already-visible default, with any sibling stagger " +
      "capped rather than reinterpreting every scrolled section as a staggered list. Duration expresses " +
      "distance — feedback stays under 150ms; only a deliberate focal entrance runs past 500ms.",
  },
  {
    id: "VIS-TYPE-FLOOR",
    check: "typography",
    statement:
      "Read from computed values at every breakpoint, not from the stylesheet's intent: body measure " +
      "holds 65-75ch, display type caps at 6rem, display tracking sits at or below -0.04em, headings " +
      "balance, and the scale has obvious size and weight steps. Inter-and-slate with no custom type " +
      "scale is the category default, not a decision.",
  },
  {
    id: "VIS-CONTRAST-FLOOR",
    check: "palette",
    statement:
      "Body and placeholder text clear 4.5:1 and large text clears 3:1, measured on the rendered page. " +
      "Secondary text on a coloured surface is tinted from that hue or from the foreground, never " +
      "dropped to gray.",
  },
  {
    id: "VIS-SURFACE-HABITS",
    check: "palette",
    statement:
      "The surface is decided rather than defaulted: no gradient text (emphasis comes from weight or " +
      "size), no purple-to-pink gradient reached for as a house style, no glass or blur used as " +
      "decoration rather than as a specific effect, no coloured border-left above 1px on cards or " +
      "callouts, and shadows that carry both an offset and a soft blur rather than a zero-offset halo.",
  },
  {
    id: "VIS-LAYOUT-SCAFFOLD",
    check: "layout",
    statement:
      "The page structure is not the category's default scaffold: same-size icon-plus-heading-plus-text " +
      "cards standing in as the page's structure, nested cards, a centred hero over three cards, the " +
      "hero-metric template, a tracked uppercase eyebrow over every section, or 01/02/03 section numbers " +
      "where the sequence carries no information the reader needs.",
  },
  {
    id: "VIS-MEDIA-REAL",
    check: "media",
    statement:
      "Every image, video and block of copy is real content: no picsum, no placehold.co, no " +
      "unsplash.com/random, no lorem ipsum, and no sparkline, progress ring or soft-shadowed rounded " +
      "rectangle standing in for content that was never written.",
  },
];

/**
 * THE COMPARISONS. Only meaningful once a mockup is locked — "does this match
 * the design that was chosen" has no referent otherwise, and asking it against
 * the whole set of five is the vague question §17.2 exists to replace.
 *
 * There is deliberately no motion entry here: a still cannot specify motion, so
 * a criterion claiming to compare motion against a PNG would be unanswerable —
 * and an unanswerable criterion is a finding generator, not a check.
 */
const AGAINST_LOCK: readonly CriterionSeed[] = [
  {
    id: "VIS-REF-LAYOUT",
    check: "layout",
    statement:
      "The built page's composition matches the LOCKED mockup: the same sections in the same order, " +
      "carrying the same relative weight and the same negative space. Resembling a different mockup " +
      "from the set is not a pass — the owner chose one.",
  },
  {
    id: "VIS-REF-PALETTE",
    check: "palette",
    statement:
      "The rendered palette is the locked mockup's palette: the same hues in the same roles, with the " +
      "same figure-to-ground relationship, and light or dark taken from the locked still rather than " +
      "re-picked by category.",
  },
  {
    id: "VIS-REF-TYPE",
    check: "typography",
    statement:
      "Typography in the build matches the locked still: the same family pairing, the same scale steps, " +
      "and the same display weight and tracking, at the breakpoint the still was rendered for.",
  },
];

function at(seed: CriterionSeed, reference: string | null): VisualCriterion {
  return {
    id: seed.id,
    tier: "QUALITY",
    statement: seed.statement,
    reference,
    check: seed.check,
  };
}

/**
 * The criteria the visual gate grades against.
 *
 * With a lock: the floor (unreferenced) plus the comparisons against that one
 * mockup. Without: the floor alone, every reference null — the DESIGN lane
 * degrades rather than blocks when no key resolves, and a degraded lane must
 * still be graded. Never empty in either state; see the header.
 */
export function visualCriteriaFor(manifest: DesignManifest): readonly VisualCriterion[] {
  const locked = manifest.lockedMockup;
  const floor = FLOOR.map((seed) => at(seed, null));
  if (locked === null) return floor;
  return [...floor, ...AGAINST_LOCK.map((seed) => at(seed, locked))];
}
