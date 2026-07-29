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
import type { DesignLockedBy, DesignManifest } from "./design-manifest.js";
import { MIN_DESIGN_REFS } from "./design-prompt.js";

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
}): DesignLaneRecord {
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
  // BOTH COUNTS, AND THE SMALLER ONE DECIDES. A lane is short of a set when it
  // has too few FILES or when the manifest NAMES too few of them: the handoff
  // and the visual gate both iterate `refs` and never read the directory, so
  // seven PNGs with three named is a three-section design however the disk
  // looks. `manifest-invalid` above only catches the opposite direction.
  const named = input.manifest.refs.length;
  if (input.pngCount < MIN_DESIGN_REFS || named < MIN_DESIGN_REFS) {
    const usable = Math.min(input.pngCount, named);
    return {
      ...base,
      degradeReason: null,
      failure: "too-few-images",
      detail:
        `the DESIGN lane produced ${String(usable)} of ${String(MIN_DESIGN_REFS)} required images ` +
        `(${String(input.pngCount)} file(s) on disk, ${String(named)} named in the manifest; only ` +
        `named refs cross the handoff). A partial set does not cover the page, and the sections with ` +
        `no still get built from nothing.`,
    };
  }
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
