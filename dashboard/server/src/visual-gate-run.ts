/**
 * visual-gate-run.ts — the CALL SITE. Everything else in the fidelity family was
 * built and never invoked.
 *
 * WHY THIS FILE EXISTS, STATED AS THE DEFECT IT CLOSES. On 2026-08-05 the
 * design-fidelity spec opened with the sentence "There is no visual gate. There
 * never has been. Not 'at the wrong tier' — absent", and listed five entry points
 * with zero non-test callers. Four of them are still true one wave later:
 * `evaluateVisualSubstance` (visual-substance.ts:1024), `renderVisualSubstance-
 * Report` (:1276), `groundPolarityAnswer` (:564) and `verdictFindings` (:1247)
 * were all reachable only from their own tests, and `VerdictInput.visualFindings`
 * (verdict.ts:151) was DECLARED and CONSUMED at four sites with nothing on earth
 * assigning it. `visualFindingsAt` therefore returned 0 forever, which is the
 * shape of defect this repository has shipped repeatedly: a check that can only
 * be observed passing, because it is never run.
 *
 * THE SPEC'S OWN SEQUENCING PUT THIS FIRST AND IT DID NOT SHIP.
 * `2026-08-05-design-fidelity-gate.md` §7 Wave A: "the first shipping unit is a
 * CALL SITE, not an observation. Adding an entry to `VISUAL_OBSERVATIONS` before
 * §7's Wave A lands is furniture for a house with no floor." Wave C landed the
 * entry (`VIS-F-REF-GROUND-INVERTED`, visual-substance.ts:420) and the decision
 * function that answers it; Wave A never landed, so the entry has been furniture
 * ever since. This module is the floor.
 *
 * IT ALSO CARRIES WAVE C's `groundOf`, WHICH THE SPEC PUT IN A SEPARATE
 * `design-fidelity.ts`. Both waves are being done by one hand here, and the
 * measurement has exactly one caller — the assembly below. A second module whose
 * only consumer is this one would be a second file to keep in step and nothing
 * else. What is NOT merged is the DECISION: `groundPolarityAnswer` stays in
 * `visual-substance.ts` beside the entry it answers, so the rule that decides a
 * verdict lives with the set it belongs to and can be unit-tested from four
 * numbers without decoding an image.
 *
 * WHAT THIS MODULE MAY NOT DO, AND THE BOUNDARY IS THE POINT:
 *
 *   It may not decide what gates. `isGatingObservation` (visual-substance.ts:699)
 *   owns that, `verdictFindings` (:1247) is the only export allowed to reach
 *   `verdict.ts`, and this module calls it rather than filtering `violations`
 *   itself. Passing violations straight through "is how a shadow gate becomes a
 *   live one by accident" — that file's own words — and a fresh call site is
 *   exactly where that accident would happen.
 *
 *   It may not author a criterion. `visual-criteria.ts` owns the statements and
 *   pins every one of them to the literal tier `QUALITY`; this module hands them
 *   to `renderVisualSubstanceReport`, which throws if any of them is not.
 *
 *   It may not widen the owner-reference fence. `ownerReferenceFor`
 *   (owner-reference.ts:193) validates directory, extension, `lstat`-not-`stat`
 *   and the sha256 the ticket id was minted from. This module calls that function
 *   and never constructs an `OwnerReference` of its own — the type is the fence,
 *   and a `string` path parameter anywhere in this file would be a way around it.
 *
 * IT SHIPS IN SHADOW AND THAT IS NOT TIMIDITY. `DEFAULT_VISUAL_SUBSTANCE_MODE` is
 * `"shadow"` and this module defaults to it. The one entry that could gate today
 * is `VIS-F-REF-GROUND-INVERTED`, and it is `shadowLocked` for a MEASURED reason
 * that is still live: `bakeoff/src/scorer-container.ts:632` pins `colorScheme:
 * "light"` in every capture context, so a correct dark-mode build under
 * `prefers-color-scheme` is byte-identical to a deliberate inversion. Turning it
 * on would fail correct builds, and a gate that fails the owner's best build gets
 * switched off and takes the honest ones with it.
 *
 * SO WHAT DOES THE OWNER GET TODAY. Two things that are new and one that is not:
 *   - `results/visual-gate.md`, a real artefact per run, recording every
 *     observation, every measured ground, and the criteria the run was judged
 *     against — including, for the first time, criteria pointing at HIS OWN
 *     attached image rather than at a mockup a model generated.
 *   - A QUALITY note on `verdict.md` when the design that was LOCKED has the
 *     opposite ground polarity to the image he attached (§4.3). It reports and
 *     never blocks, and it is the cheap correction: at lock time the fix is one
 *     regeneration, and no build-versus-mockup check can ever see it.
 *   - `visualFindings` reaching the verdict at all, so that the day an
 *     observation is calibrated the wire is already carrying current rather than
 *     needing to be discovered.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDesignManifest } from "./design-manifest.js";
import { ownerReferenceFor } from "./owner-reference.js";
import type { OwnerReference } from "./owner-reference.js";
import { visualCriteriaFor } from "./visual-criteria.js";
import type { VisualCriterion } from "./visual-criteria.js";
import {
  DEFAULT_VISUAL_SUBSTANCE_MODE,
  GROUND_MIN_SHARE,
  POLARITY_MARGIN,
  POLARITY_MIDPOINT,
  evaluateVisualSubstance,
  groundPolarityAnswer,
  renderVisualSubstanceReport,
  verdictFindings,
} from "./visual-substance.js";
import type {
  VisualFrame,
  VisualGroundMeasurement,
  VisualObservationAnswer,
  VisualObservationOutcome,
  VisualSubstanceMode,
  VisualSubstanceRecord,
} from "./visual-substance.js";

/* -------------------------------------------------------------------------
 * The measurement (design-fidelity spec §1.2.1)
 * ---------------------------------------------------------------------- */

/**
 * The pixel budget the ground is measured over.
 *
 * NOT A TUNING KNOB AND NOT A QUALITY SETTING. The question is "what colour is
 * most of this image", and a 160px longest edge answers it identically to a
 * 1376px one while costing about a millisecond. It is written down because
 * `2026-08-05-design-fidelity-gate.md` §1.2.1 fixes it, and because the §1.2.4
 * calibration numbers quoted in `visual-substance.ts:504` were taken at this
 * size — changing it would move those measurements out from under the constants
 * they justify.
 */
const GROUND_LONGEST_EDGE = 160;

/**
 * Bits dropped per channel before bucketing: 8-bit colour to 16 levels.
 *
 * FROM THE SPEC (§1.2.1, "quantise to 16 levels per channel, `v >> 4`"), and the
 * reason it is a shift rather than a cluster: a page ground is not one exact RGB
 * value once JPEG has been near it, and a k-means over an image is a second thing
 * that can be wrong. Sixteen levels is coarse enough to absorb compression and
 * fine enough that a charcoal and a near-black do not merge — which matters,
 * because "charcoal against near-black is not an inversion" is the entry's own
 * `nonTrigger` clause.
 */
const QUANTISE_SHIFT = 4;

/**
 * sRGB component to linear light. The inverse companding of IEC 61966-2-1.
 *
 * SPELLED OUT RATHER THAN IMPORTED because the only channel this module reads is
 * `L*`, and pulling a colour library in for one transfer function would add a
 * dependency whose upgrade could silently move a threshold. The constants are the
 * standard's, not chosen here.
 */
function sRgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * CIELAB `L*` for an sRGB triple, against the D65 white the sRGB primaries assume.
 *
 * ONLY `L*`, AND THE NARROWNESS IS THE DESIGN. §1.1 of the spec draws the line
 * this whole family sits behind: "a gate may read bits, a report may read
 * distances". Hue and chroma produce a distance and would need a threshold nobody
 * set; lightness against the axis midpoint produces a SIGN, which is a bit. So
 * `a*` and `b*` are never computed — not because they are hard, but because
 * having them in hand is how a distance ends up being compared to an invented
 * number six months from now.
 */
export function lightnessOf(red: number, green: number, blue: number): number {
  const y =
    0.2126 * sRgbToLinear(red) + 0.7152 * sRgbToLinear(green) + 0.0722 * sRgbToLinear(blue);
  // The CIE's own two-armed f(t): the cube root above the knee, the linear
  // segment below it. `216/24389` and `24389/27` are the exact rational forms of
  // the standard's epsilon and kappa — written as fractions rather than as
  // 0.008856 and 903.3 so nobody has to wonder how many digits were kept.
  const fy = y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116;
  return 116 * fy - 16;
}

/**
 * The dominant ground of an image on disk, or `null` when it cannot be measured.
 *
 * `null` IS A FIRST-CLASS ANSWER AND IT NEVER BECOMES A FINDING.
 * `groundPolarityAnswer` maps a null reference to `unknown`/`no_locked_reference`
 * and a null build to `unknown`/`no_screenshot`, and `unknown` is non-passing AND
 * non-gating. So every way this function can fail — a missing file, a corrupt
 * PNG, an image decoder that is not installed — degrades to "does not fire" and
 * never to "fires". That direction is the same one `owner-reference.ts` states
 * for itself: the DESIGN lane degrades rather than blocks.
 *
 * THE DECODER IS IMPORTED DYNAMICALLY, ON PURPOSE. `sharp` is a native module.
 * Importing it at module scope would make a failure to load it a failure to load
 * the ORCHESTRATOR, which imports this file — turning a missing optional
 * measurement into a dead dashboard. Measured 2026-08-05: `sharp` 0.34.5 resolves
 * from `dashboard/node_modules`, and it is declared in
 * `dashboard/server/package.json` as of this change so that resolution is a
 * dependency rather than an accident (spec §7 Wave C names exactly this hazard:
 * "a transitive resolution is not a dependency and will vanish on an unrelated
 * upgrade").
 *
 * IT DECODES WHATEVER THE BYTES ARE, WHICH IS NOT A DETAIL. The locked mockups on
 * disk are JPEGs named `.png` (spec §8.6 measured it: "Could not decode expected
 * image as PNG" at 1376×768), because the design lane writes what the image model
 * returned under the name it promised. A decoder chosen by file extension would
 * measure nothing on every real run in this project's history.
 */
export async function groundOf(imagePath: string): Promise<VisualGroundMeasurement | null> {
  if (!existsSync(imagePath)) return null;
  let raw: { readonly data: Buffer; readonly info: { width: number; height: number } };
  try {
    const { default: sharp } = await import("sharp");
    raw = await sharp(imagePath)
      .resize({ width: GROUND_LONGEST_EDGE, height: GROUND_LONGEST_EDGE, fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }
  const pixels = raw.info.width * raw.info.height;
  if (pixels === 0) return null;
  // Sum inside the bucket rather than taking the bucket's nominal colour: the
  // centroid of the pixels that landed there is the ground as it actually
  // renders, and the bucket is only the grouping.
  const buckets = new Map<number, { count: number; red: number; green: number; blue: number }>();
  for (let i = 0; i < pixels; i += 1) {
    const red = raw.data[i * 3] ?? 0;
    const green = raw.data[i * 3 + 1] ?? 0;
    const blue = raw.data[i * 3 + 2] ?? 0;
    const key =
      ((red >> QUANTISE_SHIFT) << 8) | ((green >> QUANTISE_SHIFT) << 4) | (blue >> QUANTISE_SHIFT);
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }
  let largest: { count: number; red: number; green: number; blue: number } | null = null;
  for (const bucket of buckets.values()) {
    if (largest === null || bucket.count > largest.count) largest = bucket;
  }
  if (largest === null) return null;
  return {
    lightness: lightnessOf(
      largest.red / largest.count,
      largest.green / largest.count,
      largest.blue / largest.count,
    ),
    share: largest.count / pixels,
  };
}

/* -------------------------------------------------------------------------
 * The owner's own image, compared against the design that was LOCKED (§4.3)
 * ---------------------------------------------------------------------- */

/**
 * THE PREFIX EVERY OWNER-REFERENCE NOTE CARRIES. Exported so a test can assert
 * that the note reached `verdict.md` rather than that the page contains some
 * sentence somewhere, and so the wording lives in one place.
 */
export const OWNER_REF_GROUND_NOTE = "The design locked for this run does not match the ground of the image you attached:";

/**
 * The one QUALITY note the owner's attached image can produce, or none.
 *
 * IT COMPARES THE MOCKUP TO HIS IMAGE — NOT THE BUILD TO HIS IMAGE — AND THAT IS
 * THE WHOLE VALUE. Spec §4.3: "the highest-value R1 check is not build-vs-mockup.
 * It is mockup-vs-owner-image, at lock time. If the generated mockups do not
 * resemble what the owner supplied, the chain is already wrong and no
 * build-vs-mockup check ever catches it." The build was held to the locked
 * mockup — that is what a lock MEANS — so asking the build to answer for a
 * divergence introduced upstream of it is asking the wrong seat, and its fix
 * ("rebuild") is the expensive wrong fix. `visual-criteria.ts:229-253` states the
 * same rule for the authored criteria; this is its measured sibling.
 *
 * IT REPORTS AND NEVER GATES, AND THE REASON IS NOT CAUTION. No artefact on disk
 * has ever exercised this branch: the one run that attached an image
 * (`run-2026-08-04T11-08-10-487Z-162b186d`) died in SPEC with an empty workspace
 * and never reached a lock, and the 2026-07-30 run's `references.json` opens
 * `"images": []`. A check calibrated against nothing may not fail a run — §10's
 * bar is BOTH halves, and this one has neither yet. So it comes back as a string
 * for `qualityFindings`, which `verdict.ts` counts at QUALITY, which "reports and
 * never blocks" by the owner's 2026-07-28 decision.
 *
 * SILENCE HAS FOUR CAUSES AND ALL FOUR ARE HONEST: no image was attached, no
 * mockup was locked, one of the two has no dominant ground, or one of them sits
 * in the ambiguous band around the lightness midpoint. Each of those is "the
 * question has no answer", never "the answer was fine" — which is the same
 * direction `groundPolarityAnswer` takes for the observation it decides.
 *
 * NO PATH, NO FILENAME, NO DIGEST IN THE TEXT. `verdict.md` sits in `results/`
 * and is served to the UI; `verdict.ts`'s header is explicit that a field
 * produced during a run may not carry a path into that document, and
 * `assertNoScreenshotReference` exists because a note that names a capture leaks
 * the sealed half. The sentence names polarities and two lightness numbers.
 */
export function ownerReferenceGroundNote(input: {
  readonly locked: VisualGroundMeasurement | null;
  readonly owner: VisualGroundMeasurement | null;
}): string | null {
  const { locked, owner } = input;
  if (locked === null || owner === null) return null;
  if (locked.share < GROUND_MIN_SHARE || owner.share < GROUND_MIN_SHARE) return null;
  const lockedOffset = locked.lightness - POLARITY_MIDPOINT;
  const ownerOffset = owner.lightness - POLARITY_MIDPOINT;
  if (Math.abs(lockedOffset) < POLARITY_MARGIN || Math.abs(ownerOffset) < POLARITY_MARGIN) return null;
  if (Math.sign(lockedOffset) === Math.sign(ownerOffset)) return null;
  const polarity = (offset: number): string => (offset > 0 ? "LIGHT" : "DARK");
  return (
    `${OWNER_REF_GROUND_NOTE} the locked design's ground is ${polarity(lockedOffset)} ` +
    `(lightness ${locked.lightness.toFixed(1)} of 100) and your reference's is ` +
    `${polarity(ownerOffset)} (lightness ${owner.lightness.toFixed(1)}). The build faithfully ` +
    "reproduced the mockup it was given, so rebuilding cannot close this gap — the correction is " +
    "one regeneration of the design, and it is cheap."
  );
}

/* -------------------------------------------------------------------------
 * The assembly
 * ---------------------------------------------------------------------- */

/** One capture the container wrote, reduced to what this module needs. */
export interface VisualCapture {
  readonly flowId: string;
  readonly breakpoint: string;
  /** Filename inside `results/screenshots/<runId>/`. Never an absolute path. */
  readonly file: string;
}

export interface VisualGateRunInput {
  readonly runId: string;
  /** `paths.runs` — the root the owner-reference fence is computed against. */
  readonly runsRoot: string;
  /** This run's workspace, which is where `manifest.json` lives. */
  readonly workspace: string;
  /** `results/screenshots/<runId>` on the host. */
  readonly screenshotDir: string;
  /** `ContainerResult.screenshots`, or empty when the container wrote none. */
  readonly captures: readonly VisualCapture[];
  readonly mode?: VisualSubstanceMode;
}

export interface VisualGateRunResult {
  readonly record: VisualSubstanceRecord;
  /** The authored criteria, every one of them QUALITY. */
  readonly taste: readonly VisualCriterion[];
  /** `verdictFindings(record)` — the ONLY rows allowed to reach `verdict.ts`. */
  readonly findings: readonly VisualObservationOutcome[];
  /** QUALITY notes for `verdict.md`. See {@link ownerReferenceGroundNote}. */
  readonly qualityFindings: readonly string[];
  /** The document written to `results/visual-gate.md`. */
  readonly report: string;
  /** The owner's attached image, validated, or null. */
  readonly ownerReference: OwnerReference | null;
}

/**
 * Distinct frames, in capture order, with the file each one was measured from.
 *
 * A FRAME IS `{flowId, breakpoint}` — THE SCORER'S MEANING, NOT THE MOCKUP'S.
 * Spec §7 Wave A seam decision 1 settles this: `design-prompt.ts` instructs a
 * per-SECTION capture at the mockup's aspect for the taste half, and the
 * `VisualFrame` the parser accepts is the flow/breakpoint pair the container
 * writes. §1.2's measurement is per-PAGE, so the container's captures are exactly
 * what it needs and the per-section instruction stays where it is.
 *
 * DEDUPED, FIRST WINS. A flow captured twice at one breakpoint would otherwise
 * produce two rows per observation and double every count downstream;
 * `evaluateVisualSubstance` iterates frames and would faithfully report the
 * duplicate as two independent pieces of evidence.
 */
export function framesFrom(
  captures: readonly VisualCapture[],
): readonly { readonly frame: VisualFrame; readonly file: string }[] {
  const seen = new Set<string>();
  const frames: { frame: VisualFrame; file: string }[] = [];
  for (const capture of captures) {
    const key = `${capture.flowId} ${capture.breakpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push({ frame: { flowId: capture.flowId, breakpoint: capture.breakpoint }, file: capture.file });
  }
  return frames;
}

/**
 * Build this run's visual record, its report, and the rows the verdict may count.
 *
 * EVERY CAPTURE IS MEASURED, NOT ONLY THE WIDEST. Spec §1.2.1 names the 1280×800
 * capture because that is the one the measurement NEEDS — it is a per-page
 * question and one capture answers it. Measuring all of them is a superset with
 * two properties worth the extra millisecond: a page whose polarity changes with
 * viewport is real information rather than noise, and the §1.2.6 unlock condition
 * is "three runs recorded in shadow", which arrives sooner with three rows per
 * run than with one. It cannot manufacture a red — the entry is `shadowLocked`,
 * and every ambiguous branch of `groundPolarityAnswer` returns `unknown`.
 *
 * THE ANSWERS ARE MEASURED, SO NO MODEL RUNS AND NO QUOTA IS SPENT. The one
 * observation this module answers carries `answeredBy: "measurement"`, and
 * `parseVisualObservationAnswers` REFUSES a parsed line naming a measurement
 * entry precisely so a grader cannot overwrite it (visual-substance.ts:1195).
 * The three grader-answered observations get no answer here and come back
 * `unknown`/`not_answered`, which is the truth: no grader seat exists on this
 * path yet, and `unknown` is not a pass.
 */
export async function visualGateRun(input: VisualGateRunInput): Promise<VisualGateRunResult> {
  const mode = input.mode ?? DEFAULT_VISUAL_SUBSTANCE_MODE;
  const manifest = readDesignManifest(input.workspace);
  const lockedMockup = manifest?.lockedMockup ?? null;

  // THE VALIDATED VALUE, NEVER A PATH THIS MODULE ASSEMBLED. See the header: the
  // fence is the function, and `visualCriteriaFor`'s second parameter is typed
  // `OwnerReference | null` so that the only way to fill it is to have passed it.
  const ownerReference = ownerReferenceFor(input.runsRoot, input.runId);
  const taste = visualCriteriaFor({ lockedMockup }, ownerReference);

  const frames = framesFrom(input.captures);
  const referenceGround = lockedMockup === null ? null : await groundOf(lockedMockup);

  const answers: VisualObservationAnswer[] = [];
  const measuredGrounds: { frame: VisualFrame; ground: VisualGroundMeasurement | null }[] = [];
  for (const { frame, file } of frames) {
    const ground = await groundOf(join(input.screenshotDir, file));
    measuredGrounds.push({ frame, ground });
    answers.push(groundPolarityAnswer({ frame, reference: referenceGround, build: ground }));
  }

  const ownerGround = ownerReference === null ? null : await groundOf(ownerReference.path);
  const ownerNote = ownerReferenceGroundNote({ locked: referenceGround, owner: ownerGround });
  const qualityFindings = ownerNote === null ? [] : [ownerNote];

  const record = evaluateVisualSubstance({
    frames: frames.map((entry) => entry.frame),
    answers,
    mode,
    tasteFindings: qualityFindings,
  });

  const report = [
    renderVisualSubstanceReport({ record, taste }),
    "",
    renderCriteriaSection(taste),
    "",
    renderGroundSection(lockedMockup !== null, referenceGround, measuredGrounds, ownerReference !== null, ownerGround),
  ].join("\n");

  return {
    record,
    taste,
    findings: verdictFindings(record),
    qualityFindings,
    report,
    ownerReference,
  };
}

const RULE = "-".repeat(72);

/**
 * The criteria this run was judged against, WITH the artefact each one points at.
 *
 * THE REFERENT IS PRINTED AND THE PATH IS NOT. `VisualReferent`
 * (visual-criteria.ts:104) exists because "a consumer that assumed non-null means
 * the lock would silently re-label the owner's image as the design that was
 * CHOSEN" — so the report names which artefact the criterion is about, and does
 * not name the file, for `verdict.md`'s reason: a run document may not carry a
 * host path into a directory that is served.
 *
 * THIS IS THE ONLY PLACE THE OWNER'S OWN CRITERIA HAVE EVER APPEARED IN A RUN.
 * `visualCriteriaFor`'s only caller before this module was
 * `calibration/grade-fixture.ts:414`, which passes `{ lockedMockup: null }` and
 * no owner reference — so on a live run exactly zero owner criteria were emitted,
 * and the `AGAINST_OWNER` block added on 2026-08-05 has never been rendered
 * anywhere.
 */
function renderCriteriaSection(taste: readonly VisualCriterion[]): string {
  const referentLabel: Readonly<Record<string, string>> = {
    none: "the built page itself",
    "locked-mockup": "the LOCKED mockup",
    "owner-image": "the image YOU attached to the ticket",
  };
  const lines = [
    "SECTION 3 — WHAT THIS RUN WAS JUDGED AGAINST",
    RULE,
    "Every statement below is QUALITY tier and reports rather than blocks (owner decision,",
    "2026-07-28). What changes between runs is which artefact each one is about.",
    "",
  ];
  for (const criterion of taste) {
    lines.push(
      `${criterion.id} [${criterion.check}] — about ${referentLabel[criterion.referent] ?? criterion.referent}`,
      `  ${criterion.statement.replace(/\s+/g, " ").trim()}`,
      "",
    );
  }
  const owned = taste.filter((criterion) => criterion.referent === "owner-image");
  lines.push(
    owned.length === 0
      ? "No criterion on this run points at an image the owner supplied: none was attached, or none " +
        "could be validated against the digest the ticket was minted from."
      : `${String(owned.length)} of the statements above are about the image the OWNER supplied, not ` +
        "about a mockup this program generated.",
  );
  return lines.join("\n");
}

/**
 * The grounds, as numbers, so a reader can check the answer rather than trust it.
 *
 * PRINTED EVEN WHEN NOTHING FIRED, for `renderVisualSubstanceReport`'s stated
 * reason about its own withheld count: "a rule that never withholds anything is
 * indistinguishable from no rule, and a reader cannot tell 'the rule found
 * nothing' from 'the rule was never applied' unless the line is always there."
 * A measurement that only prints when it disagrees is a measurement nobody can
 * audit.
 */
function renderGroundSection(
  hasLock: boolean,
  reference: VisualGroundMeasurement | null,
  measured: readonly { frame: VisualFrame; ground: VisualGroundMeasurement | null }[],
  hasOwnerImage: boolean,
  owner: VisualGroundMeasurement | null,
): string {
  const describe = (ground: VisualGroundMeasurement | null, absent: string): string =>
    ground === null
      ? absent
      : `lightness ${ground.lightness.toFixed(1)} of 100 (${(ground.share * 100).toFixed(1)}% of the ` +
        `image), which reads ${ground.lightness > POLARITY_MIDPOINT ? "LIGHT" : "DARK"}`;
  const lines = [
    "SECTION 4 — THE MEASURED GROUNDS",
    RULE,
    `Locked design: ${describe(reference, hasLock ? "could not be measured" : "no design was locked on this run")}`,
    `Your reference: ${describe(owner, hasOwnerImage ? "could not be measured" : "no image was attached to this ticket")}`,
  ];
  if (measured.length === 0) {
    lines.push("Delivered page: no capture was written on this run, so nothing was measured.");
  } else {
    for (const entry of measured) {
      lines.push(
        `Delivered page at ${entry.frame.flowId} / ${entry.frame.breakpoint}: ` +
          `${describe(entry.ground, "could not be measured")}`,
      );
    }
  }
  lines.push(
    "",
    `A ground within ${String(POLARITY_MARGIN)} of the midpoint (${String(POLARITY_MIDPOINT)}) is treated as neither ` +
      `light nor dark, and a dominant colour holding less than ${(GROUND_MIN_SHARE * 100).toFixed(0)}% of the image is ` +
      "treated as no ground at all. Both cases are reported UNKNOWN and neither can produce a finding.",
  );
  return lines.join("\n");
}
