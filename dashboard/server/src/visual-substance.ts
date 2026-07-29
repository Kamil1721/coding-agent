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
 * THE FLIP CONDITION IS NOT MET TODAY AND THE CODE SAYS SO. Two entries are
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
export interface VisualObservation {
  readonly id: string;
  /** Asked of the grader verbatim. If it is not a question, it is a mood. */
  readonly question: string;
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
}

/**
 * THE SET. Three entries, taken from
 * `docs/superpowers/specs/2026-07-29-visual-substance-design.md` §4.
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
  },
  {
    id: "VIS-F-EMPTY-REGION",
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
      "off-screen reports green because the check cannot see it.",
  },
  {
    id: "VIS-F-PLACEHOLDER-MEDIA",
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
      "reason is on record and it is not re-proposed as new.",
  },
];

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
  | "cannot_tell";

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
  readonly verdict: VisualAnswerVerdict;
  readonly note: string;
  readonly unknownReason: VisualUnknownReason | null;
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

function outcomeFor(
  observation: VisualObservation,
  frame: VisualFrame,
  answer: VisualObservationAnswer | undefined,
  mode: VisualSubstanceMode,
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
      note: "the grader returned no answer for this observation on this frame",
      unknownReason: "not_answered",
      declaredTier: observation.tier,
      gating,
      withheldBecause,
    };
  }

  assertNoScreenshotReference(answer.note, `${observation.id} note on ${frame.flowId}`);
  const unknownReason =
    answer.verdict === "unknown" ? (answer.unknownReason ?? "cannot_tell") : null;
  return {
    observationId: observation.id,
    frame,
    verdict: answer.verdict,
    note: answer.note,
    unknownReason,
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
}): VisualSubstanceRecord {
  const mode = input.mode ?? DEFAULT_VISUAL_SUBSTANCE_MODE;
  const taste = input.tasteFindings ?? [];
  const outcomes: VisualObservationOutcome[] = [];

  for (const observation of VISUAL_OBSERVATIONS) {
    if (input.frames.length === 0) {
      const gating = isGatingObservation(observation, mode);
      outcomes.push({
        observationId: observation.id,
        frame: { flowId: "(none)", breakpoint: "(none)" },
        verdict: "unknown",
        note: "no screenshot was captured on this run, so this question has no evidence",
        unknownReason: "no_screenshot",
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
        outcomeFor(observation, frame, answerFor(input.answers, observation.id, frame), mode),
      );
    }
  }

  return {
    mode,
    outcomes,
    violations: outcomes.filter((o) => o.verdict === "violated"),
    unknowns: outcomes.filter((o) => o.verdict === "unknown"),
    tasteFindings: taste,
    tasteTier: TASTE_TIER,
  };
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
    "",
    "SECTION 1 — OBJECTIVE OBSERVATIONS (FUNCTIONAL tier: these answer *did you build the thing*)",
    RULE,
  ];

  for (const observation of VISUAL_OBSERVATIONS) {
    const rows = record.outcomes.filter((o) => o.observationId === observation.id);
    const fired = rows.filter((o) => o.verdict === "violated");
    const unknown = rows.filter((o) => o.verdict === "unknown");
    const gating = isGatingObservation(observation, record.mode);
    const state = fired.length > 0 ? "FIRED" : unknown.length === rows.length ? "UNKNOWN" : "clear";
    lines.push(
      `${observation.id} — ${state} (declared ${observation.tier}; ` +
        `${gating ? "COUNTS toward this run's verdict" : "withheld: " + withheldLabel(observation, record.mode)})`,
    );
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
  for (const observation of VISUAL_OBSERVATIONS) {
    lines.push(
      `${observation.id} [${observation.tier}${observation.shadowLocked ? ", shadow-locked: cannot fail a run" : ""}]`,
      `  ASK: ${observation.question}`,
      `  DO NOT FIRE ON: ${observation.nonTrigger}`,
      "",
    );
  }
  lines.push(
    "ANSWER EACH WITH ONE OF: satisfied / violated / unknown — plus one sentence of what you saw.",
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
