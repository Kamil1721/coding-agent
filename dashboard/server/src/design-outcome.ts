/**
 * design-outcome.ts — THE TRAP, and the only thing standing in front of it.
 *
 * A DESIGN LANE THAT PRODUCED ZERO IMAGES MUST NEVER LOOK SUCCESSFUL.
 *
 * `sandbox.autoAllowBashIfSandboxed: true` means Bash never reaches
 * `decideToolPermission` (claude-builder.ts), so every failure in the image
 * chain — a missing python3, an unresolvable `npx impeccable`, a TMPDIR outside
 * `allowWrite`, a key that does not resolve, an API that 4xxs through the whole
 * fallback model chain — surfaces as a script error on a stream the permission
 * layer cannot see. All of them produce the same observable: no PNGs, no error,
 * a completed build.
 *
 * The only way to tell those apart from a lane that was never going to generate
 * is to have decided WHICH LANE THIS IS before it ran (design-lane.ts) and to
 * write that down here alongside what actually appeared on disk. `mode:"full"`
 * with `images:0` and `mode:"degraded"` with `images:0` are the same directory
 * listing and the opposite conclusion.
 *
 * AND ZERO CALLS IS NOT THE SAME FAULT AS FIVE FAILED ONES. The failure NAME is
 * the same — `DesignFailure` is what Tasks 10 and 11 render, and a widened union
 * is a signature they cannot call — but the sentence is not: five failed calls
 * means read the script's stderr, while zero calls means the lane never reached
 * the tool at all and the stderr does not exist to be read.
 *
 * SPEND IS A COUNT. The DESIGN lane spends real money through a key read from
 * `~/.gemini/api_key`, and nothing in this program knows the price:
 * `gemini-image.sh` prints an output path and the API response carries no cost
 * field. `costUsd` stays `null` for the run (api-types.ts's file header is the
 * contract), and design-lane spend is `imageCalls` plus `imageModel` on its own
 * line in its own file. A dollar figure invented here would be exactly the lie
 * that header exists to prevent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreflightCheck } from "./design-capability.js";
import type { DesignLaneMode } from "./design-lane.js";
import type { CanvassDirectionAudit, DesignLockedBy, DesignManifest } from "./design-manifest.js";
import { auditCanvass, refsForStage, unresolvedDirectionRefs } from "./design-manifest.js";
import { DESIGN_CANVASS_SECTIONS, DESIGN_DIRECTION_COUNT, MIN_DESIGN_REFS } from "./design-prompt.js";

export const DESIGN_LANE_RECORD_FILE = "design-lane.json";

/** The default model `gemini-image.sh` uses when `-m` is not passed. */
export const DESIGN_IMAGE_MODEL = "gemini-3.1-flash-image-preview";

export type DesignFailure = "no-images" | "too-few-images" | "no-manifest" | "manifest-invalid";

export interface DesignLaneRecord {
  readonly mode: DesignLaneMode;
  readonly images: number;
  /** Generations ATTEMPTED, retries included. A COUNT. Never money. */
  readonly imageCalls: number;
  readonly imageModel: string;
  /** WHICH source resolved the key. Never a key. */
  readonly keySource: string | null;
  readonly preflight: readonly PreflightCheck[];
  readonly degradeReason: string | null;
  readonly failure: DesignFailure | null;
  readonly detail: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
}

/**
 * WHY THE LANE DEGRADED, from the checks that actually failed.
 *
 * The fallback does NOT name a cause. Every real degrade path arrives here with
 * at least one failing check (no key, no script, or a blocking preflight row),
 * so an empty list means something unexpected happened — and answering "no
 * Gemini key resolved" to that would be this file inventing the one kind of
 * detail it exists to keep honest.
 */
/** `hero, work` — a direction's sections as the report says them. */
function listOf(values: readonly string[]): string {
  return values.length === 0 ? "nothing" : values.join(", ");
}

/**
 * ONE CLAUSE PER DIRECTION, EVERY DIRECTION, INCLUDING THE HEALTHY ONES — the
 * opposite of the shortfall sentence in `classifyDesignLane`, which names ONLY
 * the directions that came up short, and the difference is deliberate.
 *
 * A comparability fault has no culprit. Two directions rendering `hero, work` and
 * one rendering `hero, footer` is a disagreement, not an offence: naming only the
 * odd one out would privilege whichever direction the manifest happened to list
 * first, and on a stage-B manifest whose choice was clobbered it would name the
 * two directions that did nothing wrong. So every direction says what it rendered
 * and at what aspect, and the reader sees which one is out of step.
 */
function comparabilityClause(direction: CanvassDirectionAudit): string {
  const missing = direction.missing.length === 0 ? "" : ` (missing ${listOf(direction.missing)})`;
  return `${direction.slug} rendered ${listOf(direction.sections)} at ${listOf(direction.aspects)}${missing}`;
}

function degradeReasonFrom(preflight: readonly PreflightCheck[]): string {
  const failed = preflight.filter((check) => !check.ok);
  if (failed.length === 0) return "the lane degraded but no failing preflight check explains it";
  return failed.map((check) => `${check.id}: ${check.detail}`).join(" | ");
}

export function classifyDesignLane(input: {
  mode: DesignLaneMode;
  manifest: DesignManifest | null;
  pngCount: number;
  imageCalls: number;
  keySource: string | null;
  preflight: readonly PreflightCheck[];
  /**
   * HOW MANY STILLS THIS STAGE OWED, taken as an argument rather than read off
   * `MIN_DESIGN_REFS` here.
   *
   * The DESIGN lane is two stages with two floors: a canvass owes
   * `MIN_CANVASS_REFS` (DESIGN_DIRECTION_COUNT × DESIGN_CANVASS_SECTIONS = 6) and
   * an expansion owes `MIN_DESIGN_REFS` (5). Importing one constant here would
   * grade a canvass against the expansion's floor — six passes five only by luck,
   * and moving either direction constant would make a healthy canvass report
   * `too-few-images`. Defaulted so every pre-2026-08-03 caller keeps its meaning.
   *
   * WHAT IT IS COMPARED AGAINST IS PER-STAGE TOO, AND THAT HALF WAS MISSING
   * UNTIL 2026-08-03. A stage floor against a cumulative count is not a check:
   * `pngCount` is the whole flat refs directory and `refs.length` is every
   * direction, so stage A's six canvass stills satisfied stage B's five before
   * the expansion generated anything. {@link refsForStage} is what the floor now
   * meets; `pngCount` keeps its two cumulative jobs above (`no-images`, and the
   * manifest that claims more refs than exist) and is reported in the detail, but
   * it is never the number a stage is graded on.
   *
   * AND IT IS NOT THE WHOLE OF STAGE A, WHICH IS THE 2026-08-03 CORRECTION. This
   * number is a TOTAL, so six stills of one direction met it while two directions
   * carried nothing. {@link auditCanvass} holds the per-direction floor and the
   * comparability the canvass exists for, both applied below and both gated on
   * the MANIFEST'S own shape rather than on this argument — so passing a stage-B
   * floor can never switch stage A's checks off, and a caller that forgets the
   * floor entirely still cannot pass a lopsided canvass.
   */
  floor?: number;
}): DesignLaneRecord {
  const floor = input.floor ?? MIN_DESIGN_REFS;
  const base = {
    mode: input.mode,
    images: input.pngCount,
    imageCalls: input.imageCalls,
    imageModel: DESIGN_IMAGE_MODEL,
    keySource: input.keySource,
    preflight: input.preflight,
    locked: input.manifest?.lockedMockup ?? null,
    lockedBy: input.manifest?.lockedBy ?? null,
    lockedReason: input.manifest?.lockedReason ?? null,
  } as const;

  if (input.mode === "off") {
    return { ...base, degradeReason: null, failure: null, detail: "the DESIGN lane did not run" };
  }
  if (input.mode === "degraded") {
    return {
      ...base,
      degradeReason: degradeReasonFrom(input.preflight),
      failure: null,
      detail:
        "the DESIGN lane ran degraded: written art direction, no stills. The visual gate falls back " +
        "to rule-based scoring with no reference image.",
    };
  }

  // mode === "full": images were both possible and asked for.
  if (input.pngCount === 0) {
    return {
      ...base,
      degradeReason: null,
      failure: "no-images",
      detail:
        input.imageCalls === 0
          ? `the DESIGN lane ran in FULL mode and produced no images, having NEVER INVOKED the image ` +
            `script: 0 generation attempts. Nothing failed at generation time because nothing was ` +
            `attempted — this is a lane that never reached the tool, not a broken image chain. Look ` +
            `for the DESIGN agent's Bash call to the script in the build log; there is none.`
          : `the DESIGN lane ran in FULL mode and produced no images after ` +
            `${String(input.imageCalls)} generation attempt(s). Every failure in the image chain is ` +
            `invisible to the permission layer, so this is what it looks like: check the build log for ` +
            `gemini-image.sh stderr.`,
    };
  }
  if (input.manifest === null) {
    return {
      ...base,
      degradeReason: null,
      failure: "no-manifest",
      detail:
        `${String(input.pngCount)} image(s) exist but there is no readable manifest. Nothing ` +
        `downstream can name them, so no build agent will Read one and the visual gate has no ` +
        `reference — the images might as well not exist.`,
    };
  }
  if (input.manifest.refs.length > input.pngCount) {
    return {
      ...base,
      degradeReason: null,
      failure: "manifest-invalid",
      detail:
        `the manifest lists ${String(input.manifest.refs.length)} refs but ${String(input.pngCount)} ` +
        `file(s) exist. A path in a prompt that resolves to nothing is a Read failure inside every ` +
        `build agent.`,
    };
  }
  // A REF WHOSE DIRECTION DOES NOT RESOLVE, ADDED 2026-08-03, AND IT IS LOUD
  // RATHER THAN FATAL. `heroRefFor` reads `refsForDirection`, so a ref naming an
  // undeclared slug — or naming none at all on a manifest that HAS directions —
  // is a ref that cannot become the direction's hero. The observable is a run
  // that expands, locks nothing, and grades against the rule-based floor: exactly
  // what a DEGRADED run looks like, on a machine that generated every image it
  // was asked for. `DesignFailure` is NOT widened; the client switches on it.
  const unresolved = unresolvedDirectionRefs(input.manifest);
  if (unresolved.length > 0) {
    return {
      ...base,
      degradeReason: null,
      failure: "manifest-invalid",
      detail:
        `${String(unresolved.length)} ref(s) name a direction this manifest does not declare ` +
        `(${[...new Set(unresolved.map((ref) => ref.direction ?? "<none>"))].join(", ")}). Those stills ` +
        `belong to no direction, so they cannot be expanded, locked or grouped — the chosen direction ` +
        `may end up with no canonical still and the gate would then grade against nothing.`,
    };
  }
  // WHAT IS NAMED DECIDES, AND ONLY WHAT THIS STAGE NAMED. The handoff and the
  // visual gate both iterate `refs` and never read the directory, so seven PNGs
  // with three named is a three-section design however the disk looks — that half
  // is unchanged, and on a manifest with no directions this set IS `refs`.
  //
  // WHAT CHANGED 2026-08-03: the count is now the stage's, not the run's.
  // `pngCount` is the whole flat refs directory — every direction, every stage,
  // and every preview the owner asked for while choosing — so it answers "did
  // anything appear" and "does the manifest over-claim" (both above) and nothing
  // about the segment that just returned. Compared against a stage floor it made
  // `too-few-images` unable to fire on an expansion at all: stage A's six canvass
  // stills already cleared stage B's five. The disk total is no longer compared to
  // the floor and does not need to be — `refs.length > pngCount` above means the
  // named set is never larger than the directory, so a directory short of the
  // floor is a stage short of it too.
  //
  // `pngCount < floor` was dropped rather than kept as a belt, because a
  // comparison that cannot change an outcome reads as a check and is not one.
  const stage = refsForStage(input.manifest);
  if (stage.length < floor) {
    const chosen = input.manifest.chosenDirection;
    // THE SENTENCE SAYS WHAT THE TWO NUMBERS ACTUALLY MEASURE ON THIS MANIFEST,
    // AND THAT VARIES. On a manifest with no directions there is one stage and one
    // direction, so "across every direction and stage" would describe a shape the
    // file does not have — the pre-2026-08-03 wording is the true one there, and
    // it is what a reader of an old run's `design-lane.json` sees.
    const files =
      input.manifest.directions.length === 0
        ? `${String(input.pngCount)} file(s) on disk`
        : `${String(input.pngCount)} file(s) in the refs directory across every direction and stage`;
    const scope =
      input.manifest.directions.length === 0
        ? "named in the manifest"
        : chosen === null
          ? "named as canvass stills across the directions"
          : // THE EXPANSION MARK IS A COUNT, NOT A CONCLUSION. A lane that wrote
            // no `origin` reads as zero here and is NOT thereby a lane that
            // expanded nothing — the floor is met by the direction's set, and this
            // number is offered to whoever reads the record, not acted on.
            `named for the chosen "${chosen}" direction, ` +
            `${String(stage.filter((ref) => ref.origin === "expansion").length)} of them marked ` +
            `origin "expansion"`;
    return {
      ...base,
      degradeReason: null,
      failure: "too-few-images",
      detail:
        `the DESIGN lane produced ${String(stage.length)} of ${String(floor)} required images ` +
        `(${files}, ${String(stage.length)} ${scope}; only named refs cross the handoff). A partial ` +
        `set does not cover the page, and the sections with no still get built from nothing.`,
    };
  }
  /* ---- STAGE A IS A SHAPE, NOT A TOTAL (2026-08-03) ---------------------
   *
   * `MIN_CANVASS_REFS` above is DESIGN_DIRECTION_COUNT × DESIGN_CANVASS_SECTIONS
   * and, until here existed, was compared against the TOTAL and nothing else. A
   * canvass that wrote six stills for one direction and none for the other two
   * cleared it — and choosing the fat one then handed stage B a floor of five
   * already met by canvass stills, so an expansion that produced nothing was
   * silent as well. The reviewer's zero-expansion scenario was reachable through
   * a lopsided canvass, and this is the upstream hole it came through.
   *
   * AFTER THE TOTAL, NOT BEFORE IT. A canvass short overall is short overall —
   * "5 of 6" is the headline a reader wants first, and firing the per-direction
   * report instead would answer a question nobody asked yet.
   *
   * `DESIGN_CANVASS_SECTIONS` IS IMPORTED HERE WHILE THE STAGE FLOOR IS AN
   * ARGUMENT, and the asymmetry is the point: the floor above is whichever stage
   * ran, which only the caller knows, while these checks are gated by
   * {@link auditCanvass} on the MANIFEST'S own shape and are empty anywhere but a
   * canvass. A per-direction constant passed in could disagree with the total the
   * same call is graded against; an imported one moves with it.
   */
  const canvass = auditCanvass(input.manifest);
  // THE SAME HOLE FROM THE OTHER SIDE: DECLARING one direction rather than
  // STARVING two. Six comparable sections of a single direction satisfy the
  // total, the per-direction floor and comparability alike — there is nothing for
  // one direction to disagree with — and the owner is then shown a choice of one
  // while stage B's floor arrives already met. `canvass.length > 0` is what keeps
  // this off a pre-2026-08-03 manifest and off an expansion: {@link auditCanvass}
  // returns nothing for either, and a run with no directions is not a canvass
  // that offered too few.
  if (canvass.length > 0 && canvass.length < DESIGN_DIRECTION_COUNT) {
    return {
      ...base,
      degradeReason: null,
      failure: "too-few-images",
      detail:
        `the canvass offered ${String(canvass.length)} of ${String(DESIGN_DIRECTION_COUNT)} direction(s) ` +
        `(${listOf(canvass.map((direction) => direction.slug))}), whatever the stills look like. A choice ` +
        `between fewer directions than the lane was asked for is not the choice the owner was promised, and ` +
        `one direction carrying the whole canvass hands stage B a floor already met by canvass stills.`,
    };
  }
  const short = canvass.filter((direction) => direction.sections.length < DESIGN_CANVASS_SECTIONS);
  if (short.length > 0) {
    return {
      ...base,
      degradeReason: null,
      failure: "too-few-images",
      detail:
        `the canvass left ${String(short.length)} of ${String(canvass.length)} direction(s) short: ` +
        `${short
          .map(
            (direction) =>
              `${direction.slug} rendered ${String(direction.sections.length)} of ` +
              `${String(DESIGN_CANVASS_SECTIONS)} section(s)` +
              (direction.sections.length === 0 ? "" : ` (${listOf(direction.sections)})`),
          )
          .join("; ")}. ` +
        `The total of ${String(stage.length)} met the stage floor of ${String(floor)} anyway — stills the ` +
        `owner cannot compare count toward it just the same, and two stills of one section count twice. A ` +
        `direction he cannot see is a direction he cannot choose, and where one direction carried that ` +
        `total alone, choosing it hands stage B a floor already met by canvass stills.`,
    };
  }
  // TWO STILLS OF ONE SECTION ARE ONE SECTION, so the check above is met on
  // DISTINCT sections and this one can assume every direction has enough of them
  // to be compared at all.
  const incomparable = canvass.some((direction) => direction.missing.length > 0);
  const aspects = new Set(canvass.flatMap((direction) => direction.aspects));
  if (incomparable || aspects.size > 1) {
    const reasons = [
      ...(incomparable ? ["the directions did not render the same sections"] : []),
      ...(aspects.size > 1 ? ["the stills are not all at one aspect"] : []),
    ];
    return {
      ...base,
      degradeReason: null,
      failure: "manifest-invalid",
      detail:
        `the canvass is not comparable — ${reasons.join(" and ")}: ` +
        `${canvass.map(comparabilityClause).join("; ")}. The owner is then comparing PICTURES rather ` +
        `than directions — one direction's hero against another's footer, or one shape against ` +
        `another — and the set with the nicest picture wins for a reason that is not the design.`,
    };
  }
  /* ---- WHAT REACHES THIS `null` ANYWAY, WRITTEN DOWN RATHER THAN LEFT TO BE
   * REDISCOVERED. Three shapes are known to pass everything above. None is fixed
   * here and each says why, so the next reader inherits the list rather than the
   * search. All three are exercised in `design-outcome.test.ts`.
   *
   * 1. A STAGE-B MANIFEST WHOSE `chosenDirection` THE LANE CLOBBERED (finding K).
   *    `chosenDirection` and `directionChoice` are both-or-neither on parse, so a
   *    lane that rewrote either hands the host a file that READS as a canvass:
   *    `refsForStage` takes the canvass arm and counts every direction's stills
   *    against the expansion floor the caller passed. HALF of it is now loud, as a
   *    side effect rather than by design — an expansion that DID happen leaves the
   *    chosen direction holding sections the other two do not, which the
   *    comparability check names. The other half is not: clobbered AND a zero
   *    expansion is 2/2/2, comparable, one aspect, six stills over a floor of
   *    five, and identical to a healthy canvass in every field this file can read.
   *    A manifest cannot name the stage that produced it. The fix is the CALLER
   *    passing which stage it ran — `#buildPhase` already knows, it is what picks
   *    the floor — and that is orchestrator.ts, outside this change.
   *
   * 2. AN OVER-GENEROUS CANVASS. The per-direction floor is a MINIMUM, so three
   *    directions rendering five comparable sections each clear stage A and hand
   *    stage B a chosen direction that already meets `MIN_DESIGN_REFS`; a zero
   *    expansion is then silent. Not fixed because the alternative is failing a
   *    lane for over-delivering, and the only tighter stage-B count — refs marked
   *    `origin: "expansion"` — is the one `expandBrief` contradicts in writing.
   *
   * 3. A STAGE-B LANE THAT REPLACES `refs` INSTEAD OF APPENDING. The unchosen
   *    directions are erased, the chosen one's set still clears its floor, and
   *    nothing here compares this manifest against the one the canvass wrote —
   *    `classifyDesignLane` sees one file at one moment. The record of what the
   *    owner was offered is gone, which the panel reads. Reported, not fixed: the
   *    check needs the PREVIOUS manifest, which only the caller holds.
   */
  return {
    ...base,
    degradeReason: null,
    failure: null,
    detail: `${String(input.pngCount)} design still(s) in ${String(input.imageCalls)} generation(s)`,
  };
}

/**
 * The line the run says out loud. Null when there is nothing to say — and null
 * for a DEGRADED lane, which is expected rather than broken.
 */
export function designLaneFailureMessage(record: DesignLaneRecord): string | null {
  return record.failure === null ? null : `DESIGN LANE FAILED (${record.failure}): ${record.detail}`;
}

/**
 * `results/design-lane.json`, beside the run's other records.
 *
 * NO mkdir HERE, DELIBERATELY. `ensureRunPaths` creates `runPaths.results`
 * before any phase runs, so a missing directory means the caller is writing
 * somewhere it was not meant to — and a throw is louder than a record filed into
 * a directory nobody reads. This file is the report on a silent failure; it may
 * not fail silently itself.
 */
export function writeDesignLaneRecord(resultsDir: string, record: DesignLaneRecord): void {
  writeFileSync(join(resultsDir, DESIGN_LANE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * UNVALIDATED ON THE WAY BACK IN, AND THAT IS NOT AN OVERSIGHT — it is the one
 * place this phase's read paths differ. `parseDesignManifest` validates every
 * field because an AGENT writes the manifest, inside the workspace. This file is
 * written by the HOST into `results/`, which sits outside
 * `sandbox.filesystem.allowWrite: [workspace]`, so nothing in a build can forge
 * or edit it. A missing or unparseable file is `null`; a present one is ours.
 */
export function readDesignLaneRecord(resultsDir: string): DesignLaneRecord | null {
  const path = join(resultsDir, DESIGN_LANE_RECORD_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesignLaneRecord;
  } catch {
    return null;
  }
}
