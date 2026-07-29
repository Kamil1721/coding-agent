/**
 * gate.ts — the module `score --gate` loads.
 *
 * INTEGRATION GAP THIS CLOSES. `cmdScore` requires `--gate <module>` exporting
 * `createGate()`, and refuses to substitute an in-process stand-in. That
 * refusal is correct — a gate running beside the runner is not a held-out gate.
 * But no module in the tree exported `createGate`, so the refusal was total:
 * there was no way to score anything, with or without credentials, and the
 * pipeline `screen -> score -> report` had no middle.
 *
 * This module is not a stand-in. It constructs the REAL {@link SealedScorerGate}
 * — the one that runs the frozen suite in a `--network=none` container, from an
 * image pinned by content digest, against a staged copy of the artefact with
 * `.git` and `.bakeoff` stripped. It is a separate module loaded by dynamic
 * import precisely so the seam stays a seam: the runner does not import it, and
 * swapping it for a different gate is a visible act on the command line.
 *
 * CONFIGURATION IS BY ENVIRONMENT VARIABLE, AND NONE OF THEM IS A SECRET. The
 * scorer container has no network and is given no credential; there is nothing
 * for it to authenticate to. If you find yourself wanting to pass a key here,
 * the suite is reaching the internet and the measurement is already invalid.
 */

import { isAbsolute, join, resolve } from "node:path";
import { BakeoffError } from "./contracts.js";
import type { AcceptanceGate } from "./contracts.js";
import { DEFAULT_SCORER_CONTAINER, SealedScorerGate, defaultScorerGateOptions } from "./scorer.js";
import { DEFAULT_ACCEPTANCE_ROOT } from "./spec-types.js";

/** Non-secret configuration. Names only, values read at run time. */
export const GATE_ENV = Object.freeze({
  /** Scorer image reference. PIN IT BY DIGEST: `bakeoff-scorer@sha256:...`. */
  image: "BAKEOFF_SCORER_IMAGE",
  /** Where score records, tamper reports, screenshots and staging go. */
  results: "BAKEOFF_RESULTS_DIR",
  /** Root of the sealed suite store. */
  acceptance: "BAKEOFF_ACCEPTANCE_ROOT",
  /** Hard ceiling on one scoring container, in minutes. A BOUNDARY, not a heuristic. */
  timeoutMinutes: "BAKEOFF_SCORER_TIMEOUT_MIN",
});

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function positiveMinutes(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${GATE_ENV.timeoutMinutes} must be a positive number of minutes, got ${JSON.stringify(raw)}`,
      `Unset ${GATE_ENV.timeoutMinutes} to use the default, or set it to a positive number. It is a ` +
        "hard boundary on one scoring container, not a judgement about whether the suite is making " +
        "progress.",
    );
  }
  return Math.round(value * 60_000);
}

/**
 * Build the sealed gate.
 *
 * Async because the image digest is resolved from the daemon before any run is
 * scored — `SealedScorerGate` re-resolves it on every `score()` and refuses to
 * continue if it moved, since a scorer that differs between configurations
 * makes every comparison in the bake-off meaningless (held-constant variable 3).
 */
export async function createGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptanceGate> {
  const imageRef = env[GATE_ENV.image] ?? DEFAULT_SCORER_CONTAINER.imageRef;
  const resultsDir = absolute(env[GATE_ENV.results] ?? "results");
  const acceptanceRoot = absolute(env[GATE_ENV.acceptance] ?? DEFAULT_ACCEPTANCE_ROOT);

  const base = defaultScorerGateOptions(resultsDir, acceptanceRoot, imageRef);
  const options = {
    ...base,
    stagingRoot: join(resultsDir, "staging"),
    containerTimeoutMs: positiveMinutes(env[GATE_ENV.timeoutMinutes], base.containerTimeoutMs),
  };

  try {
    return await SealedScorerGate.create(options, env);
  } catch (error) {
    if (error instanceof BakeoffError) throw error;
    // The overwhelmingly common cause is "the scorer image is not built yet".
    // Say that, with the command, instead of surfacing a docker CLI error.
    throw new BakeoffError(
      "invalid_usage_shape",
      `the scorer image ${JSON.stringify(imageRef)} could not be resolved: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      "Build it first, from bakeoff/:\n" +
        "  docker build --provenance=false --sbom=false \\\n" +
        "    -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .\n" +
        `then pin it by digest and set ${GATE_ENV.image} to the pinned reference. The ` +
        "--provenance=false --sbom=false flags are load-bearing: without them BuildKit's default " +
        "attestation moves the manifest digest on every rebuild from an identical context, and the " +
        "digest recorded in every ScoreRecord then certifies nothing.",
    );
  }
}
