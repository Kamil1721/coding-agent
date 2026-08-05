/**
 * visual-substance.ts — the narrow, enumerated set of visual observations that
 * may fail a run, and the machinery that keeps them from doing so until they
 * have been calibrated.
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN ASSERTED. The committed acceptance suite
 * carries exactly three length assertions — `t.length > 1`, `named.length >= 3`
 * and `title.trim().length > 2`. When `correct-portfolio` was re-implemented on
 * 2026-07-29 from 189 characters of body copy to 2144, not one criterion result
 * moved. Nothing in the tree measures whether a build has substance. A
 * screenshot can show hollow in a way no `.length` assertion can — and, unlike a
 * character floor, without inventing a number the ticket never stated. A live
 * authoring run already invented a 200-character body floor and a
 * 40-character-per-description floor; both failed the CORRECT artefact on every
 * run. That family is REJECTED here and enumerated as rejected in
 * `docs/superpowers/specs/2026-07-29-visual-substance-design.md` §6 so it is not
 * re-proposed as new.
 *
 * THE OWNER'S DECISION AND ITS EXACT SCOPE. Taste stays QUALITY and never
 * blocks — "the palette is muddy", "the type pairing is weak", "the motion is
 * stock" are unchanged and non-gating, and they live in `visual-criteria.ts`
 * where every `tier` is the LITERAL `"QUALITY"`. Only a narrow, ENUMERATED set
 * of OBJECTIVE observations may reach FUNCTIONAL. They answer *did you build the
 * thing*, never *is it nice*.
 *
 * A MODEL NEVER DECIDES MEMBERSHIP. {@link VISUAL_OBSERVATIONS} below is the
 * whole set. The grader is handed the questions and answers them; it cannot add
 * an entry, promote one, or decide that something it disliked belongs here.
 * That is the difference between a gate and a mood.
 *
 * SHADOW BY DEFAULT, AND THAT IS THE RELIABILITY CONDITION RATHER THAN A
 * NICETY. {@link DEFAULT_VISUAL_SUBSTANCE_MODE} is `"shadow"`: the set is
 * evaluated, recorded and reported, and contributes ZERO to the verdict. An
 * uncalibrated gate is strictly worse than none — a false fail burns a fix round
 * the builder cannot win, and the artefact is not the thing that is wrong.
 *
 * SHADOW MEANS "NOT IN THE VERDICT", NOT "IN THE VERDICT AT A GENTLER TIER".
 * `verdict.ts:202` adds `qualityFindings.length` to the QUALITY count, so
 * routing a shadow finding through `qualityFindings` would flip
 * `correct-portfolio` from `pass`/`failingTier: null` to
 * `pass_with_notes`/`QUALITY` on a single false fire — the must-pass control
 * broken by the mechanism installed to protect it. {@link verdictFindings}
 * therefore returns `[]` in shadow mode, and {@link VisualSubstanceRecord.mode}
 * is on the record so a shadow run cannot be read as a gating run that found
 * nothing.
 *
 * NOT EVERY ENTRY IS ANSWERED BY A MODEL, AND ONE IS ANSWERED BY NEITHER A MODEL
 * NOR THE CAPTURE ALONE. `VIS-F-REF-GROUND-INVERTED` compares the delivered
 * capture's ground against the LOCKED MOCKUP's — an image on disk that a named
 * agent chose with a recorded reason before the build began — and it is answered
 * by {@link groundPolarityAnswer}, a pure function of four numbers, with no
 * grader in the path at all. {@link VisualAnsweredBy} explains why that is
 * enforced at the PARSER and not only in the prompt. Membership is still never
 * decided by a model: the set below is the whole of it either way.
 *
 * THE FLIP CONDITION IS NOT MET TODAY AND THE CODE SAYS SO. Three entries are
 * `shadowLocked`, which the mode flag CANNOT override
 * ({@link isGatingObservation}). The design note §7.2 requires an eighth
 * fixture — `hollow-section`, a complete shell carrying a section whose heading
 * renders and whose body renders no glyphs, placed ABOVE `#projects` so it sits
 * inside a 375×812 frame with the geometry asserted rather than assumed. Until
 * that fixture exists, `VIS-F-EMPTY-REGION` cannot be shown to fire alone and
 * `VIS-F-PLACEHOLDER-MEDIA` cannot be shown in either direction (zero of the
 * seven artefacts contain a single image: `grep -rniE "<img|<svg|<picture|
 * <video|background-image|url\("` returns nothing).
 *
 * AN UNANSWERABLE OBSERVATION IS `unknown`, NEVER A PASS. `scorer-protocol.ts`
 * added `"unknown"` to `GateOutcome` for exactly this reason after defect #35,
 * where `GATE:build` reported NOT APPLICABLE — and therefore PASSED — on
 * `broken-build`: "no gate failed" and "the gate was never evaluated" looked
 * identical. Here the same shape is structural rather than remembered:
 * {@link evaluateVisualSubstance} enumerates one outcome per observation per
 * frame from {@link VISUAL_OBSERVATIONS}, and an observation with no answer
 * becomes `unknown`. There is no code path by which silence becomes `satisfied`.
 *
 * THE CAPTURE IS VIEWPORT-ONLY, AND IT BOUNDS THE WHOLE SET. `page.screenshot()`
 * at `bakeoff/src/scorer-container.ts:674` passes no `fullPage`; `grep -n
 * fullPage` on that file returns nothing. Measured geometry: `#contact` is below
 * the fold at all three `DEFAULT_BREAKPOINTS` on every fixture that has one.
 * Every question below is therefore scoped to what is IN FRAME, and
 * "below the fold" is a named `unknown` reason rather than a silent pass.
 *
 * THE PIXEL ANSWER IS NOT ADMITTED ALONE — MEASURED, AND THIS IS THE CHANGE THAT
 * MADE THE ENTRY SAFE. The adversarial control set
 * (`docs/superpowers/specs/2026-07-29-visual-substance-false-fail-set.md`) found
 * TWO of eight CORRECT builds producing a single-colour capture at the tightest
 * breakpoint, both for reasons invisible to a reader of the image: a page whose
 * full-bleed cover comes from a photo host unreachable under `--network=none`
 * (928 characters of `innerText`, capture 2541 B / luminance stddev 0.000 / one
 * distinct colour — byte-identical to `blank-page` at all three breakpoints), and
 * a correct `writing-mode: vertical-rl` Japanese page whose viewport screenshot
 * does not correspond to its layout viewport (367 characters, 2541 B at 375).
 * Under `"gating"` those were four live FUNCTIONAL false fails.
 * {@link VISUAL_OBSERVATIONS} therefore carries a `corroboration` rule, and
 * `VIS-F-EMPTY-FRAME` may only produce a FINDING when the page's own measured
 * `document.body.innerText.trim().length` is ZERO for that flow and breakpoint.
 * Re-scored over the 57-frame blind pool: both true positives kept, both false
 * fails killed, zero remaining. The conjunction is strictly STRONGER than either
 * half — `innerText === 0` alone would fail a legitimately image-only page and
 * the pixel answer alone fails the two builds above — so it is not the
 * subset shape design-note rule 4 rejects.
 *
 * THE BLOCKED-HOST CLAUSE WAS CONSIDERED AND IS DELIBERATELY NOT HERE. The
 * control set proposed a second clause, "no `sealed_network_request_blocked` for
 * that flow", and then recommended against it: one reference to one external
 * host — a favicon, a font, a tracking pixel — would switch the entry off for
 * that flow permanently, INCLUDING on a genuinely blank page. In a project that
 * ships `GATE:no-reward-hack-exploits`, a gate condition one line of markup
 * disables is a finding in itself. The `innerText` clause cannot be gamed: a
 * builder cannot make a page hollow and `innerText` non-empty without putting
 * real rendered text on it.
 *
 * CORROBORATION DOWNGRADES TO `unknown`, NEVER TO `satisfied`. A capture that
 * reads as a flat field over a page carrying 928 characters is a question the
 * evidence cannot answer, not a page that passed. The grader's own word survives
 * on {@link VisualObservationOutcome.rawVerdict} so shadow mode still measures
 * the MODEL's rate rather than the corroborated check's, and
 * {@link VisualSubstanceRecord.corroborationWithheld} lists every row the rule
 * took out.
 *
 * NO SCREENSHOT PATH EVER REACHES A RECORD. `bakeoff/.gitignore` states the
 * boundary: masking is applied at capture time and is the only masking there is,
 * so "a secret rendered by a selector nobody anticipated is in the pixels
 * permanently, and no later commit can un-publish it". A record here carries a
 * flow id and a breakpoint label and nothing else that could locate an image;
 * {@link assertNoScreenshotReference} enforces it on every note that crosses in.
 */

import type { VisualCriterion } from "./visual-criteria.js";

/* -------------------------------------------------------------------------
 * The enumerated set
 * ---------------------------------------------------------------------- */

/**
 * One enumerated observation.
 *
 * `tier` IS THE LITERAL `"FUNCTIONAL"`, NOT A VARIABLE, for the same reason
 * `visual-criteria.ts` pins its own to the literal `"QUALITY"`: a widened type
 * is how a tier decision erodes one refactor at a time. Whether an entry may
 * gate TODAY is `shadowLocked` plus the run's mode — two separate facts, never
 * folded into the tier.
 */
/**
 * The measured, page-side fact an observation's FINDING must agree with before it
 * is admitted.
 *
 * `"page_text_empty"` — `document.body.innerText.trim().length === 0` for that
 * flow and breakpoint. The scorer already collects it; nothing new is captured
 * and the capture is not widened.
 *
 * A UNION OF ONE, ON PURPOSE. `VIS-F-EMPTY-REGION` needs a different fact — the
 * region's own `getBoundingClientRect()` carried alongside the capture, so the
 * threshold between "an empty band that is the crop ending" and "an empty band
 * that is a hollow region" is measured rather than chosen by whoever is reading
 * (calibration note §5, §9.5). The scorer does not record that today, which is
 * why that entry stays `shadowLocked` and why this union does not yet name it.
 */
export type VisualCorroborationRule = "page_text_empty";

/**
 * WHO ANSWERS THE QUESTION — and it is a property of the ENTRY, never of the run.
 *
 * `"grader"` is the original path: the question is rendered into the prompt by
 * {@link visualObservationBlock}, a model answers it, and
 * {@link parseVisualObservationAnswers} reads the answer back.
 *
 * `"measurement"` means a deterministic host-side producer constructs the
 * {@link VisualObservationAnswer} from numbers, and NO MODEL IS ASKED. Asking a
 * model what two recorded numbers already answer is the mistake this file exists
 * to avoid, and it is worse than merely redundant: a model answering
 * `VIS-F-REF-GROUND-INVERTED` from pixels alone would be answering a question
 * about a REFERENCE IMAGE IT WAS NEVER SHOWN.
 *
 * THE FLAG IS LOAD-BEARING IN TWO PLACES AND BOTH ARE ENFORCED HERE.
 * {@link visualObservationBlock} filters the prompt to `"grader"` entries —
 * handing a grader a question whose evidence it does not have is how a tree
 * acquires a finding generator. And {@link parseVisualObservationAnswers}
 * REFUSES a parsed line naming a `"measurement"` entry, because otherwise the
 * two answer sources share one array, {@link answerFor} takes the first match
 * with no `answeredBy` awareness, and a model that volunteers a line could
 * overwrite the measurement. Filtering the prompt alone is not a defence: the
 * prompt is advice, and the parser is the boundary.
 */
export type VisualAnsweredBy = "grader" | "measurement";

export interface VisualObservation {
  readonly id: string;
  /** Asked of the grader verbatim. If it is not a question, it is a mood. */
  readonly question: string;
  /** Who produces the answer. See {@link VisualAnsweredBy}; both ends enforce it. */
  readonly answeredBy: VisualAnsweredBy;
  /** What it would carry if it gated. Literal by design; see above. */
  readonly tier: "FUNCTIONAL";
  /** The false-fail case, stated before the check ships. Also asked verbatim. */
  readonly nonTrigger: string;
  /** Why this is an observation and not taste — the *did you build the thing* test. */
  readonly why: string;
  /**
   * True when this entry may not gate EVEN WITH the mode flag on, because
   * calibration is impossible on the fixtures that exist. Design note §7.2:
   * these "stay shadowed regardless of how the seven sort".
   */
  readonly shadowLocked: boolean;
  /** Why it is locked, or null when only the run-level mode governs it. */
  readonly lockReason: string | null;
  /**
   * The measured fact a FINDING here must agree with, or null when the pixel
   * answer stands alone. See the header: for `VIS-F-EMPTY-FRAME` this is the
   * difference between two live false fails and none.
   *
   * It gates the FINDING, never the pass. A `satisfied` answer needs no
   * corroboration — the rule exists to stop an unsupported red, not to
   * manufacture one.
   */
  readonly corroboration: VisualCorroborationRule | null;
}

/**
 * THE SET. Four entries: three from
 * `docs/superpowers/specs/2026-07-29-visual-substance-design.md` §4, and
 * `VIS-F-REF-GROUND-INVERTED` from `2026-08-05-design-fidelity-gate.md` §1.2.
 *
 * THE FOURTH IS THE FIRST ENTRY WITH AN EXTERNAL REFERENT, and the line that let
 * it in is §1.1: an observation may gate iff its answer is a two-valued fact or a
 * count of zero, AND the standard it is measured against is either the artefact
 * itself or a value the run RECORDED BEFORE THE BUILD BEGAN. A locked reference
 * does not make a question objective — it makes it COMPARABLE, and a comparison
 * returns a distance, which needs a threshold nobody set. "Uses the reference's
 * palette" returns a distance and stays at QUALITY. "Inverted the reference's
 * polarity" returns a bit. A gate may read bits; a report may read distances.
 * Every other fidelity candidate measured against the artefacts on disk fires on
 * the build that passed, and they are enumerated as rejected in
 * `2026-08-05-design-fidelity-gate.md` §2.2 so they are not re-proposed as new.
 *
 * Everything else considered is at QUALITY or rejected, each with the
 * measurement that decided it (§5, §6). The two that matter most, because they
 * are the ones a reader will try to re-add:
 *
 *   - "a card or region with no MEANINGFUL content" — "meaningful" is density,
 *     and density fires on `stock-motion-only`, whose project cards differ from
 *     `missing-section`'s by ONE WORD (`Annotations.` vs `Annotations and
 *     translation.`). One must fail and one must pass. A FUNCTIONAL finding on
 *     `stock-motion-only` turns `pass_with_notes` into `fail` (`verdict.ts:210`).
 *   - "a ticket-named section is absent" — not answerable from a capture at all
 *     (knowing a section was OWED requires the ticket), and the discriminating
 *     evidence is below the fold in every capture. Already carried by unmet
 *     REQ-004 at FUNCTIONAL, which is louder.
 */
export const VISUAL_OBSERVATIONS: readonly VisualObservation[] = [
  {
    id: "VIS-F-EMPTY-FRAME",
    answeredBy: "grader",
    question:
      "Does this screenshot show a page with nothing in it — no text, no image, no interactive " +
      "control — only a field of background colour?",
    tier: "FUNCTIONAL",
    nonTrigger:
      "Must NOT fire on: a hero with one line of type and a great deal of space around it; a " +
      "full-bleed image or video with no text over it; a deliberately spare landing frame. The " +
      "trigger is NOTHING PRESENT, never LITTLE PRESENT and never MUCH SPACE. If a single heading, " +
      "word, control or image is visible anywhere in the frame, the answer is no.",
    why:
      "The answer does not depend on the ticket, the brand, the category or anyone's preference. " +
      "There is no design in which the top viewport of a delivered page is legitimately void of " +
      "every element. A reader who disagrees about whether a palette is muddy will not disagree " +
      "about whether anything is there.",
    // NOT LOCKED, and the reason is a measurement rather than confidence.
    // `GATE:screenshots-present` does NOT catch this: `nonBlank` is
    // `bytes.byteLength >= MIN_SCREENSHOT_BYTES` with the floor at 1024
    // (`scorer-container.ts:694`, `scorer-protocol.ts:809`), and `blank-page` —
    // zero glyphs — measures 2541/4468/4718 B at the three breakpoints and is
    // recorded `nonBlank: true` at all three. That floor detects a TRUNCATED
    // CAPTURE, not blankness. This entry is not a subset of that gate; it is
    // the check that gate is mistaken for.
    shadowLocked: false,
    lockReason: null,
    // THE MEASURED PRECONDITION, and it is what took the adversarial false-fail
    // count from four to zero. Two of eight CORRECT builds answered `violated`
    // here on the pixels alone: a sanctioned remote photo under `--network=none`
    // (928 chars of innerText, 2541/4468/4718 B — byte-identical to `blank-page`)
    // and a correct vertical-rl Japanese page at 375 (367 chars, 2541 B).
    // Both carry text; `blank-page` and `reward-hacked` carry none.
    corroboration: "page_text_empty",
  },
  {
    id: "VIS-F-EMPTY-REGION",
    answeredBy: "grader",
    question:
      "In this screenshot, is there a region the layout has visibly set aside for content — a " +
      "heading with the space beneath it, or a bordered or filled container — that contains " +
      "nothing at all?",
    tier: "FUNCTIONAL",
    nonTrigger:
      "Must NOT fire on: whitespace around content, however generous — a minimal, high-craft " +
      "design is not hollow, and whitespace ALONE must never be the trigger; a section whose " +
      "content is one short line; a decorative rule, spacer or divider that was never meant to " +
      "hold content; a container holding only an image, because an image is content; anything " +
      "below the fold, which is not in evidence and is `unknown` rather than either answer.",
    why:
      "A heading over emptiness, or a drawn container with nothing inside it, is a structure the " +
      "page itself declared and then did not fill — the page supplies its own referent, so no " +
      "external standard of taste is invoked. This is also the one entry that catches what no " +
      "`.length` assertion can: text present in the DOM but invisible in the pixels " +
      "(same-colour-on-same-colour, zero-height clipped, opacity 0 and never revealed) passes " +
      "every text assertion in the tree and shows as an empty region here.",
    shadowLocked: true,
    lockReason:
      "No fixture is non-blank-but-hollow, so it cannot be shown to fire ALONE. `stub-markers` " +
      "comes closest and does not qualify — it renders 'Coming soon' and 'TODO: implement', which " +
      "are content, visibly present. Design note §7.2 specifies the prerequisite: an eighth " +
      "fixture `hollow-section` whose empty region sits ABOVE `#projects` inside a 375x812 frame, " +
      "with `getBoundingClientRect().bottom <= viewport height` ASSERTED at all three breakpoints " +
      "rather than assumed from markup order. A fixture whose discriminating evidence is " +
      "off-screen reports green because the check cannot see it. THAT FIXTURE NOW EXISTS — " +
      "`calibration/hollow-section`, and the geometry is asserted at all three breakpoints: " +
      "`#about h2` [172,210] and `#about-body` [230,542] inside 812 at 375, [204,243]/[263,457] " +
      "inside 1024 at 768, [172,210]/[230,424] inside 800 at 1280, `#about` entirely above " +
      "`#projects`, 0 failures. It is still locked, and the remaining blocker is NOT the fixture " +
      "and NOT whether a model can see hollow (measured 6 frames of 6, on two independently built " +
      "hollow artefacts, with zero fires on ten correct builds). It is that the threshold between " +
      "'an empty band that is the crop ending' and 'an empty band that is a hollow region' was set " +
      "by the reader: on the adversarial set's fold-orphaned-heading pair, two of three breakpoints " +
      "separated only on 341px-against-50px and 185px-against-48px of empty frame, a magnitude no " +
      "wording here supplies. Unlocking it needs the region's own geometry carried alongside the " +
      "capture, which is a change to what the SCORER records.",
    // No rule can be named for it yet: the fact it needs — the region's
    // `getBoundingClientRect()` at that breakpoint — is not in the scorer's
    // output. Naming `page_text_empty` here would be actively wrong; the hollow
    // fixture's body `innerText` is 468 characters, which is the entire point.
    corroboration: null,
  },
  {
    id: "VIS-F-PLACEHOLDER-MEDIA",
    answeredBy: "grader",
    question:
      "Does this screenshot show an image slot that is a stand-in rather than an image — a " +
      "broken-image glyph, a grey or diagonal-cross placeholder tile, or a visible watermark from " +
      "a placeholder service?",
    tier: "FUNCTIONAL",
    nonTrigger:
      "Must NOT fire on: a deliberately flat or monochrome image; an abstract or gradient " +
      "background treatment chosen as art direction; an illustration in a minimal style; an SVG " +
      "icon; a solid colour block used compositionally. The trigger is THE STAND-IN ANNOUNCES " +
      "ITSELF, never THE IMAGE IS PLAIN. Whether the photograph is any good is taste, and stays " +
      "at QUALITY under `VIS-MEDIA-REAL`.",
    why:
      "A broken-image icon or a picsum/placehold.co watermark is a self-identifying artefact of " +
      "unfinished work: it states its own status in the pixels. Only partially overlapped by the " +
      "existing DOM finding `image_natural_width_zero` (`scorer-container.ts:731`), which catches " +
      "a broken `<img>` but not a CSS `background-image` that 404s, and not a placeholder-service " +
      "image that loads perfectly and is therefore invisible to `naturalWidth`.",
    shadowLocked: true,
    lockReason:
      "Locked harder than the entry above: ZERO fixtures contain any image whatsoever. " +
      '`grep -rniE "<img|<svg|<picture|<video|background-image|url\\("` across all seven artefact ' +
      "trees returns nothing, so BOTH calibration directions are unavailable — it cannot be shown " +
      "to fire, and it cannot be shown not to false-fail. Enumerated rather than dropped so the " +
      "reason is on record and it is not re-proposed as new. The adversarial set added the harder " +
      "half: its case 07 is a lime-paint colour chart whose first swatch is a flat `#8a8d8b` film " +
      "measured fully in frame at 375 containing zero characters — pixel for pixel this entry's " +
      "named trigger ('a uniform grey tile') AND its named non-trigger ('a solid colour block used " +
      "compositionally') at once. The separator is what the page is for, which the capture does not " +
      "carry. This entry needs a ticket, not a better prompt.",
    corroboration: null,
  },
  {
    id: "VIS-F-REF-GROUND-INVERTED",
    // NO MODEL ANSWERS THIS ONE, and that is the entry's whole shape. The
    // referent is an image on disk the grader is never shown; a grader asked
    // "does this match the locked design" from the build capture alone would be
    // answering from memory of a file it does not have. See VisualAnsweredBy.
    answeredBy: "measurement",
    question:
      "The design locked for this run has a ground on one side of the lightness axis. Does the " +
      "delivered capture render its ground on the OTHER side — dark where the locked design is " +
      "light, or light where the locked design is dark?",
    tier: "FUNCTIONAL",
    nonTrigger:
      "Must NOT fire on: a different shade of the SAME polarity, however far apart — charcoal " +
      "against near-black is not an inversion, and the separation is deliberately not a distance; " +
      "either ground sitting within `POLARITY_MARGIN` of the axis midpoint, which is `unknown` " +
      "rather than either answer; a locked reference with no dominant ground at all, below " +
      "`GROUND_MIN_SHARE`, which is `unknown`; a run carrying no locked mockup, where there is no " +
      "referent and the answer is `unknown`/`no_locked_reference` rather than a pass. The trigger " +
      "is A SIGN CHANGE, never A LARGE DIFFERENCE.",
    why:
      "Both sides are artefacts on disk that this run did not author for grading: the locked " +
      "mockup was chosen by a named agent with a recorded reason before the build began " +
      "(`results/design-lock.json`), and the capture is the container's own. The answer is a SIGN " +
      "COMPARISON — a bit — not a distance, so there is no threshold to invent and no character " +
      "floor wearing new clothes: the two chosen constants can only widen `unknown`, and `unknown` " +
      "is non-passing and non-gating, so neither of them can manufacture a red. Whether a page is " +
      "dark-on-light or light-on-dark is the single largest, least arguable statement a design " +
      "makes; a reader who disagrees about whether a palette is muddy will not disagree about it.",
    shadowLocked: true,
    lockReason:
      "MEASURED DISQUALIFIER, 2026-08-05, and it is why this ships locked rather than merely " +
      "uncalibrated. `scorer-container.ts:632` pins every capture context to `colorScheme: " +
      '"light"`. A build that implements the SAME locked dark ground behind `@media ' +
      "(prefers-color-scheme: dark)` — legitimate, arguably better craft — was rendered here under " +
      "the container's own settings and measured ground `#f8fafc`, share 56.7%, L* 98.2: BYTE-FOR-" +
      "BYTE THE SAME GROUND as the deliberately inverted mutation of the same build (`--bg` " +
      "`#1c1a17` to `#f8fafc`, also L* 98.2, share 56.7%). The mechanism cannot tell a correct " +
      "dark-mode implementation from an inversion, so under `\"gating\"` this is a live FUNCTIONAL " +
      "false fail on a CORRECT artefact — the class the whole file exists to keep out. Unlocking " +
      "needs the ground read from a source the capture context cannot invert, or a second capture " +
      "under the reference's own scheme. TWO FURTHER BLOCKERS, both measured rather than argued. " +
      "(1) THE SUBJECT IS A BAND, NOT THE PAGE. The capture is one viewport (`page.screenshot()` " +
      "with no `fullPage`, `scorer-container.ts:673-680`); on the known-good build the hero is " +
      "`min-height: 100vh` (`styles.css:171`) and its rect at 1280x800 is exactly [0,800] against " +
      "a 1966px document, so the capture IS the hero band and not the page's ground. It happens to " +
      "be honest there because the locked mockup is also a hero — that is a coincidence of one " +
      "run, not a property. (2) FLOW IDENTITY IS UNDECIDED. One locked mockup against N flow " +
      "captures: both suites on disk declare exactly one flow, so a login page and an app shell " +
      "with opposite grounds has never been exercised, and nothing here says which pair is the " +
      "pair. THE FIRE DIRECTION IS ALSO UNEXERCISED BY ANY REAL RUN: all five mockups of the " +
      "2026-07-29 lock measure L* 5.4-6.1 and its build measures 9.3-9.4 at every breakpoint, so " +
      "both artefacts that carry a reference agree with it and the only red is a synthetic " +
      "mutation. Enumerated rather than dropped, on this file's own convention, so the reason is " +
      "on record and the entry is not re-proposed as new.",
    // NULL, AND NOT FOR WANT OF A RULE. The corroboration rules exist to stop a
    // model's unsupported red; here there is no model, and the answer already
    // degrades to `unknown` on every ambiguity by construction. Naming
    // `page_text_empty` would be actively wrong — the known-good build renders
    // 326 characters and is the artefact that must PASS.
    corroboration: null,
  },
];

/* -------------------------------------------------------------------------
 * VIS-F-REF-GROUND-INVERTED — the measurement that answers it
 * ---------------------------------------------------------------------- */

/** The id, single-sourced: the producer, the parser guard and the set agree. */
export const REF_GROUND_INVERTED_ID = "VIS-F-REF-GROUND-INVERTED";

/**
 * The midpoint of the CIELAB lightness axis, BY THE COLOUR SPACE'S DEFINITION.
 *
 * This one is NOT in the chosen-constant family below. `L*` runs 0 to 100 and 50
 * is its midpoint the way 0 is the midpoint of a signed integer — it is not a
 * number about this ticket, this project or anybody's taste, and moving it would
 * not be a recalibration but a different question.
 */
export const POLARITY_MIDPOINT = 50;

/**
 * CHOSEN, NOT MEASURED — and named so a measured change is a one-line change.
 *
 * Nothing on disk exercises the ambiguous band: every real ground measured for
 * this entry sits at an extreme (`L*` 5.4, 5.9, 6.1, 9.3, 9.4, 95.2, 95.6, 98.2,
 * 100.0), the nearest approach to 50 being 40.6 away. So this number has never
 * decided anything, and the convention `2026-08-04-motion-capture-design.md` §2.3
 * set for its own uncalibrated thresholds applies: name it, say it was chosen,
 * do not pretend a measurement produced it.
 *
 * IT CAN ONLY WIDEN `unknown`. Raising it turns findings into `unknown`; it can
 * never turn an `unknown` into a finding. That direction is what keeps this from
 * being the rejected character-floor family in new clothes — §6 of the
 * 2026-07-29 design note. A floor that fires on the correct artefact is the trap;
 * this constant cannot manufacture a red at any value.
 */
export const POLARITY_MARGIN = 15;

/**
 * CHOSEN, NOT MEASURED. The minimum area share the locked reference's dominant
 * bucket must hold before "the reference's ground" means anything.
 *
 * Measured for orientation only, never to fit this number: the five mockups of
 * the 2026-07-29 lock hold 33.5%, 45.2%, 32.4%, 52.8% and 52.8%; the 2026-07-30
 * lock holds 38.7%. All clear it, and none is near it. Same direction as
 * `POLARITY_MARGIN`: below the floor the answer is `unknown`, never a finding.
 */
export const GROUND_MIN_SHARE = 0.2;

/**
 * One quantised ground, as the host measures it.
 *
 * DELIBERATELY NOT AN IMAGE, A PATH OR A BUFFER. This module may not learn how to
 * locate a capture — see the header on `bakeoff/.gitignore` — so the decoding
 * (`sharp`, longest edge 160px, 16 levels per channel, centroid of the largest
 * bucket, converted to CIELAB) lives in the host-side producer and only these two
 * numbers cross the boundary. It also makes the decision below a pure function of
 * four numbers, which is why it can be calibrated in a unit test against values
 * measured from the real artefacts rather than only inside a live run.
 */
export interface VisualGroundMeasurement {
  /** CIELAB `L*`, 0 (black) to 100 (white). */
  readonly lightness: number;
  /** Area share of the dominant quantised bucket, 0 to 1. */
  readonly share: number;
}

/**
 * Answer `VIS-F-REF-GROUND-INVERTED` from two measured grounds. No model runs.
 *
 * EVERY BRANCH THAT IS NOT A CLEAN SIGN COMPARISON RETURNS `unknown`, and that is
 * the design rather than caution. `unknown` is non-passing (`verdict.ts` counts
 * only `violated` rows) and non-gating, so a missing lock, a reference with no
 * ground, and a ground sitting near the axis midpoint all degrade to "does not
 * fire" and NEVER to "fires". Read the whole function for the property: there is
 * exactly one `return "violated"` and it is guarded by a sign change on two
 * values that have each already cleared the margin.
 *
 * IT IS ALSO NEVER A PASS BY DEFAULT. `no_locked_reference` is what a run with no
 * design supplies, and it is `unknown` rather than `satisfied` — `scorer.ts:1253`
 * maps `not_applicable` to `passed: true`, and a fidelity check that reported
 * GREEN on every ticket that supplied no design would be a gate that can only
 * observe success, which is this project's signature defect.
 */
export function groundPolarityAnswer(input: {
  readonly frame: VisualFrame;
  /** The locked mockup's ground, or null when the run locked nothing. */
  readonly reference: VisualGroundMeasurement | null;
  /** The delivered capture's ground, or null when nothing was captured. */
  readonly build: VisualGroundMeasurement | null;
}): VisualObservationAnswer {
  const unknown = (unknownReason: VisualUnknownReason, note: string): VisualObservationAnswer => ({
    observationId: REF_GROUND_INVERTED_ID,
    frame: input.frame,
    verdict: "unknown",
    note,
    unknownReason,
  });

  if (input.reference === null) {
    return unknown(
      "no_locked_reference",
      "this run locked no design reference, so there is nothing to compare the delivered ground " +
        "against; this is unanswered rather than answered clean",
    );
  }
  if (input.build === null) {
    return unknown(
      "no_screenshot",
      "no capture exists for this flow at this breakpoint, so the delivered ground was never measured",
    );
  }
  if (input.reference.share < GROUND_MIN_SHARE) {
    return unknown(
      "ref_has_no_ground",
      `the locked reference has no dominant ground — its largest colour holds ${sharePct(input.reference.share)} ` +
        `of the image, under the ${sharePct(GROUND_MIN_SHARE)} floor — so "the reference's polarity" names nothing`,
    );
  }

  const refOffset = input.reference.lightness - POLARITY_MIDPOINT;
  const buildOffset = input.build.lightness - POLARITY_MIDPOINT;
  if (Math.abs(refOffset) < POLARITY_MARGIN || Math.abs(buildOffset) < POLARITY_MARGIN) {
    return unknown(
      "ground_polarity_ambiguous",
      `one of the two grounds sits near the middle of the lightness axis (reference L* ` +
        `${fixed(input.reference.lightness)}, delivered L* ${fixed(input.build.lightness)}, margin ` +
        `${String(POLARITY_MARGIN)}), so neither is decidably dark or light and there is no sign to compare`,
    );
  }

  const polarity = (offset: number): string => (offset > 0 ? "light" : "dark");
  if (Math.sign(refOffset) !== Math.sign(buildOffset)) {
    return {
      observationId: REF_GROUND_INVERTED_ID,
      frame: input.frame,
      verdict: "violated",
      note:
        `the locked design's ground is ${polarity(refOffset)} (L* ${fixed(input.reference.lightness)}) and the ` +
        `delivered page's ground is ${polarity(buildOffset)} (L* ${fixed(input.build.lightness)}) — the build ` +
        "inverted the polarity of the design that was chosen",
    };
  }
  return {
    observationId: REF_GROUND_INVERTED_ID,
    frame: input.frame,
    verdict: "satisfied",
    note:
      `both grounds are ${polarity(refOffset)} (locked L* ${fixed(input.reference.lightness)}, delivered L* ` +
      `${fixed(input.build.lightness)}); a difference of shade within one polarity is not an inversion`,
  };
}

function fixed(value: number): string {
  return value.toFixed(1);
}

function sharePct(share: number): string {
  return `${(share * 100).toFixed(1)} percent`;
}

/**
 * The OWNER-FACING sentence for an observation, in the observed voice.
 *
 * A CONSTANT TABLE, AND NEVER THE GRADER'S NOTE. `verdict.ts` renders this and
 * not `outcome.note`, for the reason its own header gives about `detail` and
 * `evidenceRef`: a field produced during the run can quote things the sealed
 * boundary exists to keep out of `results/`, and a verdict file is served to the
 * UI. This mirrors `gateLabel` in `spec-assumptions.ts` — the label comes from a
 * constant, the machine id comes along in brackets, and nothing written by a
 * model during the run reaches the page.
 *
 * IT RETURNS THE ID RATHER THAN AN EMPTY STRING for an unknown key. An
 * observation that renders as nothing is a finding the owner never sees, which is
 * the same false pass in a smaller font; `visual-substance.test.ts` asserts every
 * enumerated id has a real label, so the fallback is a safety net and not a
 * substitute for one.
 */
const OBSERVATION_LABELS: Readonly<Record<string, string>> = {
  "VIS-F-EMPTY-FRAME":
    "the top of the delivered page shows nothing at all — no text, no image, no control, " +
    "only a field of background colour",
  "VIS-F-EMPTY-REGION":
    "the page set aside a region for content — a heading with space beneath it, or a drawn " +
    "container — and left it empty",
  "VIS-F-PLACEHOLDER-MEDIA":
    "an image slot shows a stand-in rather than an image — a broken-image glyph, a placeholder " +
    "tile, or a placeholder service's watermark",
  "VIS-F-REF-GROUND-INVERTED":
    "the delivered page inverted the locked design's polarity — the design that was chosen has a " +
    "dark ground and the page renders a light one, or the reverse",
};

export function visualObservationLabel(id: string): string {
  return OBSERVATION_LABELS[id] ?? id;
}

/** The tier every taste criterion carries, and the only one it may carry. */
export const TASTE_TIER = "QUALITY" as const;

/* -------------------------------------------------------------------------
 * Mode
 * ---------------------------------------------------------------------- */

/**
 * `"shadow"` evaluates, records and reports, and contributes nothing to the
 * verdict. `"gating"` lets an unlocked entry produce a FUNCTIONAL finding that
 * can fail a run.
 */
export type VisualSubstanceMode = "shadow" | "gating";

/** The default, and it is OFF. See the header for why this is not a nicety. */
export const DEFAULT_VISUAL_SUBSTANCE_MODE: VisualSubstanceMode = "shadow";

/**
 * TWO LEVELS, AND THE FLAG IS THE WEAKER ONE. A locked entry does not gate even
 * with the flag on, because §7.2's clause is "regardless of how the seven sort".
 * Encoding it here rather than in prose is what makes it enforceable.
 */
export function isGatingObservation(
  observation: VisualObservation,
  mode: VisualSubstanceMode,
): boolean {
  return mode === "gating" && !observation.shadowLocked;
}

/* -------------------------------------------------------------------------
 * Frames, answers, outcomes
 * ---------------------------------------------------------------------- */

/**
 * One capture, identified by what it is OF — never by where it lives.
 *
 * There is deliberately no `file`, no `path` and no `sha256` field. See the
 * header: a record that can locate an image is a record that can republish a
 * secret the masking never anticipated.
 */
export interface VisualFrame {
  readonly flowId: string;
  readonly breakpoint: string;
}

/**
 * The page-side measurement a corroborated observation is checked against.
 *
 * `innerTextLength` is `document.body.innerText.trim().length` for that flow at
 * that breakpoint — a number the scorer already collects. There is deliberately
 * no `blockedHosts` field: see the header for why that clause was rejected
 * rather than merely unimplemented.
 */
export interface VisualPageEvidence {
  readonly frame: VisualFrame;
  readonly innerTextLength: number;
}

/** `satisfied` = looked and it is fine. `violated` = fires. `unknown` = neither. */
export type VisualAnswerVerdict = "satisfied" | "violated" | "unknown";

/**
 * Why an observation could not be answered. Every value is NON-PASSING; there is
 * no "probably fine" member and adding one would reintroduce defect #35.
 */
export type VisualUnknownReason =
  /** No capture exists for this flow at all. */
  | "no_screenshot"
  /** The grader returned nothing for this observation on this frame. */
  | "not_answered"
  /** The subject of the question is outside the captured viewport. */
  | "below_the_fold"
  /** The grader looked and could not decide. */
  | "cannot_tell"
  /**
   * The grader answered `violated`, and the page's own MEASURED evidence
   * disagrees — e.g. an empty-frame answer over a page rendering 928 characters.
   * The capture is unrepresentative of the page, so the question is unanswered
   * from this evidence. It is NOT a pass: see the header.
   */
  | "corroboration_contradicted"
  /**
   * The grader answered `violated`, the entry requires corroboration, and no
   * measurement was supplied for that flow and breakpoint. Also not a pass —
   * a finding with no supporting measurement is exactly the thing that produced
   * four false fails.
   */
  | "corroboration_missing"
  /**
   * `VIS-F-REF-GROUND-INVERTED` on a run that locked no design. There is no
   * referent, so the question has no answer — and it is deliberately NOT
   * `satisfied`: a fidelity check reporting green on every ticket that supplied
   * no design is a gate that can only observe success.
   */
  | "no_locked_reference"
  /**
   * The locked reference's dominant colour holds less than
   * {@link GROUND_MIN_SHARE} of the image, so "the reference's ground" names
   * nothing to compare against.
   */
  | "ref_has_no_ground"
  /**
   * One of the two grounds sits within {@link POLARITY_MARGIN} of the lightness
   * axis midpoint, so it is not decidably dark or light and there is no sign to
   * compare. The whole point of the margin: it widens this, and can never widen
   * `violated`.
   */
  | "ground_polarity_ambiguous";

export interface VisualObservationAnswer {
  readonly observationId: string;
  readonly frame: VisualFrame;
  readonly verdict: VisualAnswerVerdict;
  /** What the grader saw, in words. Never a filename, never a path. */
  readonly note: string;
  /** Required when `verdict` is `"unknown"`; ignored otherwise. */
  readonly unknownReason?: VisualUnknownReason;
}

/** One row per observation per frame. The set is enumerated, so this is total. */
export interface VisualObservationOutcome {
  readonly observationId: string;
  readonly frame: VisualFrame;
  /** The answer AFTER corroboration. This is the one that can fail a run. */
  readonly verdict: VisualAnswerVerdict;
  /**
   * WHAT THE GRADER ACTUALLY SAID, before any corroboration rule touched it.
   *
   * Without this, shadow mode measures the corroborated check's rate rather than
   * the MODEL's, and the two are different numbers — on the adversarial set they
   * differ by four frames. Reading a model's calibration off the post-rule
   * verdict is the M4 shape: an inert rule and a working one would look the same.
   */
  readonly rawVerdict: VisualAnswerVerdict;
  readonly note: string;
  readonly unknownReason: VisualUnknownReason | null;
  /** The rule that was applied to this row, or null when the entry has none. */
  readonly corroborationRule: VisualCorroborationRule | null;
  /** What it would carry if it gated. Present on every row, satisfied included. */
  readonly declaredTier: "FUNCTIONAL";
  /** Whether THIS row counts toward the verdict on THIS run. */
  readonly gating: boolean;
  /** Why it does not count, or null when it does. */
  readonly withheldBecause: "shadow_mode" | "entry_shadow_locked" | null;
}

export interface VisualSubstanceRecord {
  /**
   * WHICH MODE THIS RUN ACTUALLY RAN IN. Without it a shadow run reads as a
   * gating run that found nothing — the M4 defect, where emptying `MUST_FAIL`
   * left calibration green at 7/7 because an inert check and a working one
   * produce the same output.
   */
  readonly mode: VisualSubstanceMode;
  /** One row per observation per frame; never sparse. */
  readonly outcomes: readonly VisualObservationOutcome[];
  /** Rows that fired, gating or not. */
  readonly violations: readonly VisualObservationOutcome[];
  /** Rows that could not be answered. Reported; never counted as satisfied. */
  readonly unknowns: readonly VisualObservationOutcome[];
  /**
   * Rows where the grader said `violated` and a corroboration rule took it out.
   *
   * ON THE RECORD RATHER THAN DROPPED. These are the rows that would have been
   * false fails, and the count is the only thing that can show the rule is doing
   * work: a rule that never withholds anything is indistinguishable from no rule,
   * which is this project's signature defect one layer down.
   */
  readonly corroborationWithheld: readonly VisualObservationOutcome[];
  /** The taste half, verbatim, for the same report. Always QUALITY. */
  readonly tasteFindings: readonly string[];
  readonly tasteTier: typeof TASTE_TIER;
}

/* -------------------------------------------------------------------------
 * The boundary guard
 * ---------------------------------------------------------------------- */

/**
 * Anything that could locate a captured image. Deliberately broad: a false
 * positive costs a reworded note, a false negative is permanent.
 */
const SCREENSHOT_REFERENCE = /(\.(png|jpe?g|webp|gif|avif)\b)|(^|[\s"'(])[~.]?\//i;

/**
 * Throws when a note carries a path or an image filename.
 *
 * NOT COSMETIC. `bakeoff/.gitignore`: masking is applied at capture time and is
 * the only masking there is, so a path in a committed record is an invitation to
 * open a file nobody vetted. This is enforced at the boundary — every note that
 * enters a record passes through here — rather than trusted to a convention.
 */
export function assertNoScreenshotReference(note: string, where: string): void {
  if (SCREENSHOT_REFERENCE.test(note)) {
    throw new Error(
      `visual-substance: ${where} carries what looks like a file path or image filename. ` +
        "A record here may name a flow and a breakpoint and nothing that can locate a capture " +
        "(bakeoff/.gitignore: masking is applied at capture time and is the only masking there is).",
    );
  }
}

/* -------------------------------------------------------------------------
 * Evaluation
 * ---------------------------------------------------------------------- */

function answerFor(
  answers: readonly VisualObservationAnswer[],
  observationId: string,
  frame: VisualFrame,
): VisualObservationAnswer | undefined {
  return answers.find(
    (a) =>
      a.observationId === observationId &&
      a.frame.flowId === frame.flowId &&
      a.frame.breakpoint === frame.breakpoint,
  );
}

function evidenceFor(
  evidence: readonly VisualPageEvidence[],
  frame: VisualFrame,
): VisualPageEvidence | undefined {
  return evidence.find(
    (e) => e.frame.flowId === frame.flowId && e.frame.breakpoint === frame.breakpoint,
  );
}

/**
 * Apply the entry's corroboration rule to a `violated` answer.
 *
 * Returns the verdict that survives, and the reason when it does not. Only a
 * `violated` answer is ever touched: the rule exists to stop an unsupported RED,
 * never to manufacture one, so a `satisfied` answer needs no measurement and an
 * `unknown` is already non-passing.
 *
 * NOTHING HERE CAN RETURN `satisfied`. A contradicted or unsupported finding
 * becomes `unknown` — reported, non-passing, non-gating. Returning `satisfied`
 * would let a missing measurement launder a genuinely blank page into a pass,
 * which is defect #35's shape wearing a corroboration rule's clothes.
 */
function corroborate(
  observation: VisualObservation,
  frame: VisualFrame,
  answer: VisualObservationAnswer,
  evidence: readonly VisualPageEvidence[],
): { readonly verdict: VisualAnswerVerdict; readonly unknownReason: VisualUnknownReason | null; readonly note: string } {
  const rule = observation.corroboration;
  if (rule === null || answer.verdict !== "violated") {
    return {
      verdict: answer.verdict,
      unknownReason: answer.verdict === "unknown" ? (answer.unknownReason ?? "cannot_tell") : null,
      note: answer.note,
    };
  }
  const measured = evidenceFor(evidence, frame);
  if (measured === undefined) {
    return {
      verdict: "unknown",
      unknownReason: "corroboration_missing",
      note:
        `${answer.note} — WITHHELD: this observation requires the page's own measured text length ` +
        "for this flow and breakpoint, and none was supplied. A finding with no supporting " +
        "measurement is what produced four false fails on correct builds.",
    };
  }
  if (measured.innerTextLength > 0) {
    return {
      verdict: "unknown",
      unknownReason: "corroboration_contradicted",
      note:
        `${answer.note} — WITHHELD: the page renders ${String(measured.innerTextLength)} characters of ` +
        "text at this breakpoint, so the capture is unrepresentative of the page rather than the " +
        "page being empty. Measured on two correct builds: a remote cover photo denied by " +
        "--network=none, and a vertical-rl document whose viewport capture is not its layout viewport.",
    };
  }
  return { verdict: "violated", unknownReason: null, note: answer.note };
}

function outcomeFor(
  observation: VisualObservation,
  frame: VisualFrame,
  answer: VisualObservationAnswer | undefined,
  mode: VisualSubstanceMode,
  evidence: readonly VisualPageEvidence[],
): VisualObservationOutcome {
  const gating = isGatingObservation(observation, mode);
  const withheldBecause = gating
    ? null
    : observation.shadowLocked
      ? ("entry_shadow_locked" as const)
      : ("shadow_mode" as const);

  if (answer === undefined) {
    // SILENCE IS `unknown`. The set is enumerated, so a missing answer is a
    // question nobody answered — not a question that came back clean.
    return {
      observationId: observation.id,
      frame,
      verdict: "unknown",
      rawVerdict: "unknown",
      // THE NOTE MUST NAME THE RIGHT ABSENTEE. This is the text the owner reads,
      // and "the grader returned no answer" is simply false for an entry no
      // grader is ever asked — it would send a reader looking for a model's
      // silence when what is missing is a host-side measurement.
      note:
        observation.answeredBy === "grader"
          ? "the grader returned no answer for this observation on this frame"
          : "no host-side measurement was supplied for this observation on this frame; it is " +
            "answered by measurement and no grader is asked for it",
      unknownReason: "not_answered",
      corroborationRule: observation.corroboration,
      declaredTier: observation.tier,
      gating,
      withheldBecause,
    };
  }

  assertNoScreenshotReference(answer.note, `${observation.id} note on ${frame.flowId}`);
  const settled = corroborate(observation, frame, answer, evidence);
  return {
    observationId: observation.id,
    frame,
    verdict: settled.verdict,
    rawVerdict: answer.verdict,
    note: settled.note,
    unknownReason: settled.unknownReason,
    corroborationRule: observation.corroboration,
    declaredTier: observation.tier,
    gating,
    withheldBecause,
  };
}

/**
 * Evaluate the enumerated set against a grader's answers.
 *
 * ITERATES {@link VISUAL_OBSERVATIONS}, NEVER THE ANSWERS. That direction is the
 * whole of requirement 4: a grader that answers two of three questions produces
 * one `unknown`, not two rows and a silence. Answers naming an observation the
 * set does not contain are DISCARDED — a model may not add a gating check by
 * inventing an id.
 *
 * WITH NO FRAMES, EVERY OBSERVATION IS `unknown`/`no_screenshot`. A run that
 * captured nothing has not satisfied anything.
 */
export function evaluateVisualSubstance(input: {
  readonly frames: readonly VisualFrame[];
  readonly answers: readonly VisualObservationAnswer[];
  readonly mode?: VisualSubstanceMode;
  readonly tasteFindings?: readonly string[];
  /**
   * The page's own measurements, per flow per breakpoint. Required for any entry
   * carrying a `corroboration` rule; a `violated` answer with no measurement
   * becomes `unknown`/`corroboration_missing` rather than a finding.
   */
  readonly pageEvidence?: readonly VisualPageEvidence[];
}): VisualSubstanceRecord {
  const mode = input.mode ?? DEFAULT_VISUAL_SUBSTANCE_MODE;
  const taste = input.tasteFindings ?? [];
  const evidence = input.pageEvidence ?? [];
  const outcomes: VisualObservationOutcome[] = [];

  for (const observation of VISUAL_OBSERVATIONS) {
    if (input.frames.length === 0) {
      const gating = isGatingObservation(observation, mode);
      outcomes.push({
        observationId: observation.id,
        frame: { flowId: "(none)", breakpoint: "(none)" },
        verdict: "unknown",
        rawVerdict: "unknown",
        note: "no screenshot was captured on this run, so this question has no evidence",
        unknownReason: "no_screenshot",
        corroborationRule: observation.corroboration,
        declaredTier: observation.tier,
        gating,
        withheldBecause: gating
          ? null
          : observation.shadowLocked
            ? "entry_shadow_locked"
            : "shadow_mode",
      });
      continue;
    }
    for (const frame of input.frames) {
      outcomes.push(
        outcomeFor(
          observation,
          frame,
          answerFor(input.answers, observation.id, frame),
          mode,
          evidence,
        ),
      );
    }
  }

  return {
    mode,
    outcomes,
    violations: outcomes.filter((o) => o.verdict === "violated"),
    unknowns: outcomes.filter((o) => o.verdict === "unknown"),
    corroborationWithheld: outcomes.filter(
      (o) => o.rawVerdict === "violated" && o.verdict !== "violated",
    ),
    tasteFindings: taste,
    tasteTier: TASTE_TIER,
  };
}

/* -------------------------------------------------------------------------
 * The parser — the other half of the loop
 * ---------------------------------------------------------------------- */

/**
 * The line marker, and the field separator, single-sourced.
 *
 * WHY A MARKER AND A PIPE RATHER THAN PROSE. Before this existed the module had
 * no parser at all: `visualObservationBlock` told the grader to answer
 * "satisfied / violated / unknown — plus one sentence" and nothing on the code
 * side could turn that into a {@link VisualObservationAnswer}. The loop was open
 * at both ends, so `"gating"` mode was a label. A prose answer is not parseable
 * without a second model, and a second model in the gating path is a second place
 * for the answer to change.
 *
 * {@link VISUAL_ANSWER_MARKER} is used by BOTH the prompt block and the parser,
 * so the format the grader is shown and the format the code reads cannot drift.
 * `visual-substance.test.ts` parses the prompt's own worked example to prove it.
 */
export const VISUAL_ANSWER_MARKER = "VIS-ANSWER";
const FIELD = "|";

/**
 * The unknown reasons a GRADER may claim. Deliberately not the whole union.
 *
 * `corroboration_contradicted` and `corroboration_missing` are conclusions drawn
 * from MEASUREMENT, and a grader that could assert them could talk its way out of
 * a finding — or into one — by naming a fact it did not measure. Anything outside
 * this list degrades to `cannot_tell`, which is non-passing.
 */
const GRADER_UNKNOWN_REASONS: readonly VisualUnknownReason[] = [
  "no_screenshot",
  "not_answered",
  "below_the_fold",
  "cannot_tell",
];

export interface VisualAnswerParseRejection {
  readonly line: string;
  readonly reason: string;
}

export interface VisualAnswerParseResult {
  readonly answers: readonly VisualObservationAnswer[];
  /**
   * Lines the parser refused, with why. ON THE RECORD RATHER THAN DROPPED: a
   * parser that silently discards half the grader's output produces a run with
   * two `unknown`s and no explanation, and the caller cannot tell a quiet grader
   * from a broken format.
   */
  readonly rejected: readonly VisualAnswerParseRejection[];
  /** Notes replaced because they carried a path or an image filename. */
  readonly redactedNotes: number;
}

/**
 * Turn a grader's answer block into answers, and refuse everything else.
 *
 * NOTHING UNPARSEABLE BECOMES `satisfied`. That is the whole contract, and it is
 * defect #35's shape restated at the parse boundary: a verdict word the parser
 * does not recognise becomes `unknown`/`cannot_tell`, a malformed line is
 * rejected and the enumerated question it was meant to answer is left with no
 * answer — which {@link evaluateVisualSubstance} turns into
 * `unknown`/`not_answered`. There is no path from garbage to a pass.
 *
 * A MODEL MAY NOT INVENT AN ID OR A FRAME. An id outside
 * {@link VISUAL_OBSERVATIONS} is rejected, because inventing an id is how a model
 * would add a gating check; a frame outside `frames` is rejected, because
 * answering about a capture that does not exist is an answer about nothing.
 *
 * THE FIRST ANSWER FOR A PAIR WINS. A grader that answers the same question twice
 * has the second answer rejected and recorded, rather than overwriting the first —
 * otherwise a trailing "satisfied" quietly erases a `violated` above it.
 */
export function parseVisualObservationAnswers(input: {
  readonly text: string;
  readonly frames: readonly VisualFrame[];
}): VisualAnswerParseResult {
  const answers: VisualObservationAnswer[] = [];
  const rejected: VisualAnswerParseRejection[] = [];
  let redactedNotes = 0;
  const seen = new Set<string>();

  for (const raw of input.text.split("\n")) {
    const line = raw.trim().replace(/^[-*>\s]+/, "");
    if (!line.toUpperCase().startsWith(VISUAL_ANSWER_MARKER)) continue;
    const fields = line
      .slice(VISUAL_ANSWER_MARKER.length)
      .split(FIELD)
      .map((f) => f.trim())
      .filter((f, index) => !(index === 0 && f.length === 0));
    if (fields.length < 4) {
      rejected.push({ line, reason: `expected 5 ${FIELD}-separated fields, found ${String(fields.length)}` });
      continue;
    }
    const [id, flowId, breakpoint, verdictField, ...rest] = fields as [string, string, string, string, ...string[]];
    const entry = VISUAL_OBSERVATIONS.find((o) => o.id === id);
    if (entry === undefined) {
      rejected.push({ line, reason: `${id} is not an enumerated observation — a model may not add one` });
      continue;
    }
    // A MODEL MAY NOT ANSWER A MEASURED QUESTION, and this is the boundary rather
    // than the prompt. `visualObservationBlock` already withholds these ids, but
    // a prompt is advice: a grader that volunteers the line anyway would put a
    // model's answer into the SAME array the producer's measurement is in, and
    // `answerFor` takes the first match with no `answeredBy` awareness. Whichever
    // came first would win, which is a coin toss deciding a FUNCTIONAL row.
    if (entry.answeredBy !== "grader") {
      rejected.push({
        line,
        reason:
          `${id} is answered by measurement, not by a grader — a model may not answer it, and it ` +
          "may not override the measurement by volunteering a line",
      });
      continue;
    }
    const frame = input.frames.find((f) => f.flowId === flowId && f.breakpoint === breakpoint);
    if (frame === undefined) {
      rejected.push({ line, reason: `no capture exists for flow ${flowId} at breakpoint ${breakpoint}` });
      continue;
    }
    const key = `${id}\u0000${flowId}\u0000${breakpoint}`;
    if (seen.has(key)) {
      rejected.push({ line, reason: `${id} was already answered for this frame; the first answer stands` });
      continue;
    }
    seen.add(key);

    const [word, claimedReason] = verdictField.toLowerCase().split(":").map((f) => f.trim());
    const verdict: VisualAnswerVerdict =
      word === "satisfied" || word === "violated" || word === "unknown" ? word : "unknown";
    const reason: VisualUnknownReason =
      verdict !== "unknown"
        ? "cannot_tell"
        : ((GRADER_UNKNOWN_REASONS.find((r) => r === claimedReason) ?? "cannot_tell"));

    let note = rest.join(FIELD).trim();
    if (note.length === 0) note = "the grader gave a verdict and no description of what it saw";
    if (word !== verdict) {
      note = `${note} [the verdict word "${word}" is not one of satisfied/violated/unknown; read as unknown]`;
    }
    if (SCREENSHOT_REFERENCE.test(note)) {
      redactedNotes += 1;
      note =
        "the grader's description named a file path or an image filename and was redacted at the " +
        "parse boundary; masking is applied at capture time and is the only masking there is";
    }
    answers.push(verdict === "unknown" ? { observationId: id, frame, verdict, note, unknownReason: reason } : { observationId: id, frame, verdict, note });
  }
  return { answers, rejected, redactedNotes };
}

/**
 * The rows that may FAIL THIS RUN — and in shadow mode there are none.
 *
 * This is the only function whose output is allowed to reach `verdict.ts`, and
 * it is deliberately not `record.violations`. Passing violations straight
 * through is how a shadow gate becomes a live one by accident.
 */
export function verdictFindings(
  record: VisualSubstanceRecord,
): readonly VisualObservationOutcome[] {
  return record.violations.filter((o) => o.gating);
}

/**
 * Count for `verdict.ts`'s FUNCTIONAL tier. Zero in shadow mode, by construction.
 */
export function gatingFindingCount(record: VisualSubstanceRecord): number {
  return verdictFindings(record).length;
}

/* -------------------------------------------------------------------------
 * The report — one document, two tiers, no ambiguity about which can fail
 * ---------------------------------------------------------------------- */

const RULE = "-".repeat(72);

/**
 * ONE REPORT, TWO VISIBLY SEPARATED HALVES. The owner reads a single document;
 * the halves are labelled with what each can do, because a report that mixes a
 * gating observation with a taste note trains the reader to discount both.
 *
 * THROWS IF A TASTE CRITERION IS NOT QUALITY. `visual-criteria.ts` pins its tier
 * to the literal `"QUALITY"`; this is the cross-module half of that guarantee,
 * so a widened tier there surfaces here rather than quietly printing a taste
 * note under the heading that says it can fail a run.
 */
export function renderVisualSubstanceReport(input: {
  readonly record: VisualSubstanceRecord;
  readonly taste: readonly VisualCriterion[];
}): string {
  const { record } = input;
  for (const criterion of input.taste) {
    if (criterion.tier !== TASTE_TIER) {
      throw new Error(
        `visual-substance: taste criterion ${criterion.id} carries tier ${criterion.tier}, not ` +
          `${TASTE_TIER}. Taste reports and never blocks (owner decision 2026-07-28); a taste ` +
          "criterion at a gating tier is the erosion visual-criteria.ts's literal type exists to stop.",
      );
    }
  }

  const gatingNow = VISUAL_OBSERVATIONS.filter((o) => isGatingObservation(o, record.mode));
  const lines: string[] = [
    "VISUAL SUBSTANCE REPORT",
    RULE,
    record.mode === "shadow"
      ? "MODE: SHADOW — every observation below was evaluated and recorded, and NONE of them can " +
        "fail this run. Read a silent section as 'nothing fired', never as 'the gate is calibrated'."
      : "MODE: GATING — unlocked observations below can fail this run at FUNCTIONAL tier.",
    `Observations that can fail this run: ${
      gatingNow.length === 0 ? "none" : gatingNow.map((o) => o.id).join(", ")
    }.`,
    // THE WITHHELD COUNT IS PRINTED EVEN WHEN IT IS ZERO. A corroboration rule
    // that never withholds anything is indistinguishable from no rule, and a
    // reader cannot tell "the rule found nothing to withhold" from "the rule was
    // never applied" unless the line is always there.
    `Findings withheld because the page's own measurements disagree: ${String(record.corroborationWithheld.length)}.`,
    "",
    "SECTION 1 — OBJECTIVE OBSERVATIONS (FUNCTIONAL tier: these answer *did you build the thing*)",
    RULE,
  ];

  for (const observation of VISUAL_OBSERVATIONS) {
    const rows = record.outcomes.filter((o) => o.observationId === observation.id);
    const fired = rows.filter((o) => o.verdict === "violated");
    const unknown = rows.filter((o) => o.verdict === "unknown");
    const gating = isGatingObservation(observation, record.mode);
    const withheld = rows.filter((o) => o.rawVerdict === "violated" && o.verdict !== "violated");
    const state = fired.length > 0 ? "FIRED" : unknown.length === rows.length ? "UNKNOWN" : "clear";
    lines.push(
      `${observation.id} — ${state} (declared ${observation.tier}; ` +
        `${gating ? "COUNTS toward this run's verdict" : "withheld: " + withheldLabel(observation, record.mode)}` +
        `${observation.corroboration === null ? "" : `; a finding here requires ${observation.corroboration}`})`,
    );
    for (const row of withheld) {
      lines.push(
        `    WITHHELD at ${row.frame.flowId} / ${row.frame.breakpoint} — the grader answered VIOLATED ` +
          `and it is not a finding (${row.unknownReason ?? "cannot_tell"}).`,
      );
    }
    for (const row of fired) {
      lines.push(`    FIRED at ${row.frame.flowId} / ${row.frame.breakpoint}: ${row.note}`);
    }
    for (const row of unknown) {
      lines.push(
        `    UNKNOWN at ${row.frame.flowId} / ${row.frame.breakpoint} ` +
          `(${row.unknownReason ?? "cannot_tell"}): ${row.note}`,
      );
    }
    if (fired.length === 0 && unknown.length === 0) {
      lines.push(`    clear on ${String(rows.length)} frame(s).`);
    }
  }

  lines.push(
    "",
    "UNKNOWN IS NOT A PASS. An observation with no evidence — no capture, no answer, or a subject " +
      "below the fold — is reported unknown and is never counted as satisfied.",
    "",
    `SECTION 2 — TASTE (${TASTE_TIER} tier: reports, and NEVER blocks a run)`,
    RULE,
  );
  if (record.tasteFindings.length === 0) {
    lines.push("No taste findings.");
  } else {
    for (const finding of record.tasteFindings) lines.push(`  - ${finding.replace(/\s+/g, " ").trim()}`);
  }
  lines.push(
    "",
    "Nothing in section 2 can fail a run, in either mode. Subjective judgement rendered in red " +
      "trains the owner to ignore red (owner decision, 2026-07-28).",
  );
  return lines.join("\n");
}

function withheldLabel(observation: VisualObservation, mode: VisualSubstanceMode): string {
  if (observation.shadowLocked) return "this entry is shadow-locked and the mode flag cannot unlock it";
  return mode === "shadow" ? "shadow mode" : "not gating";
}

/* -------------------------------------------------------------------------
 * The prompt block
 * ---------------------------------------------------------------------- */

/**
 * The enumerated set, rendered for the grader.
 *
 * SINGLE-SOURCED FROM {@link VISUAL_OBSERVATIONS} ON PURPOSE. A prompt that
 * restates the set in prose is a second declaration site, and the two drift —
 * at which point the model is answering a question the code does not score.
 *
 * THE NON-TRIGGER SHIPS WITH THE QUESTION, ALWAYS. It is the half that prevents
 * a false fail, and a question sent without it is a finding generator.
 */
export function visualObservationBlock(mode: VisualSubstanceMode): string {
  // ONLY THE GRADER-ANSWERED ENTRIES ARE RENDERED. A `"measurement"` entry's
  // referent is a file the grader was never shown, so putting its question here
  // would be asking a model to answer from evidence it does not have — a finding
  // generator. The parser refuses those ids too; this filter is the courtesy and
  // that refusal is the boundary.
  const asked = VISUAL_OBSERVATIONS.filter((o) => o.answeredBy === "grader");
  const lines: string[] = [
    "THE OBJECTIVE OBSERVATIONS — FUNCTIONAL tier. This list is fixed in code and you may not add",
    "to it, drop from it, or promote a taste judgement into it. Answer each question for each",
    "screenshot you captured, and nothing else belongs at this tier.",
    "",
    mode === "shadow"
      ? "ON THIS RUN THESE ARE RECORDED AND REPORTED ONLY — shadow mode, so none of them can fail " +
        "the run. Answer them exactly as carefully as if they could; the answers are what decides " +
        "whether the gate is ever turned on."
      : "ON THIS RUN AN UNLOCKED OBSERVATION BELOW CAN FAIL THE RUN at FUNCTIONAL tier. Answer only " +
        "what you can see; an answer you are unsure of belongs in UNKNOWN.",
    "",
  ];
  for (const observation of asked) {
    lines.push(
      `${observation.id} [${observation.tier}${observation.shadowLocked ? ", shadow-locked: cannot fail a run" : ""}]`,
      `  ASK: ${observation.question}`,
      `  DO NOT FIRE ON: ${observation.nonTrigger}`,
      "",
    );
  }
  const example = asked[0]?.id ?? "VIS-F-EMPTY-FRAME";
  lines.push(
    // THE FORMAT AND THE PARSER ARE THE SAME CONSTANT. A prompt that describes a
    // shape the parser does not read is how the loop stayed open: the set was
    // asked, answered in prose, and nothing on the code side could score it.
    "ANSWER FORMAT — one line per observation per screenshot, and nothing else on the line:",
    "",
    `  ${VISUAL_ANSWER_MARKER} | <OBSERVATION-ID> | <flow id> | <breakpoint> | <satisfied|violated|unknown[:reason]> | <one sentence of what you saw>`,
    "",
    "  Worked example:",
    `  ${VISUAL_ANSWER_MARKER} | ${example} | home | 375x812 | satisfied | the frame carries a name in large type and three bordered cards`,
    `  ${VISUAL_ANSWER_MARKER} | ${example} | home | 1280x800 | unknown:below_the_fold | the region the question asks about is not inside this frame`,
    "",
    "A LINE THE FORMAT DOES NOT MATCH IS DISCARDED, and the question it was meant to answer is then",
    "recorded UNKNOWN. A verdict word outside satisfied/violated/unknown is read as UNKNOWN. Neither",
    "becomes a pass, so a formatting slip costs a reported unknown and never a silent green.",
    "",
    "UNKNOWN IS A REAL ANSWER AND IT IS NOT A PASS. Use it, and name which:",
    "  no_screenshot   — no capture exists for that flow.",
    "  below_the_fold  — THE COMMON ONE. Captures are ONE VIEWPORT AT THE TOP OF THE PAGE: the",
    "                    container calls page.screenshot() with no fullPage, and measured geometry",
    "                    puts a contact section below the fold at every breakpoint on every fixture",
    "                    that has one. If the region a question is about is not inside the frame,",
    "                    the answer is UNKNOWN. Answering 'satisfied' about a section you never saw",
    "                    is the single most damaging thing you can do here.",
    "  cannot_tell     — you looked at the frame and genuinely could not decide.",
    "",
    "Never widen the capture, never take a full-page screenshot, and never name a screenshot file",
    "or path in the report. Masking is applied at capture time and is the only masking there is.",
  );
  return lines.join("\n");
}
