/**
 * design-reuse.ts — one run building to another run's art, and the four ways
 * that is refused.
 *
 * THE MEASUREMENT THIS EXISTS FOR. `results/design-lane.json` from the
 * 2026-08-12 portfolio run: `"mode": "full", "images": 11, "imageCalls": 5,
 * "imageModel": "gemini-3.1-flash-image-preview"`. Three directions were
 * canvassed (desk-scatter, margin-annotation, ruled-ledger), ONE was locked, and
 * the other two were discarded the moment the choice landed. Eleven runs of the
 * same ticket have each paid for that, and the owner's Gemini credits are the
 * binding constraint on how often this pipeline can be exercised at all. Before
 * today there was no reuse path anywhere: `designLaneMode`'s `degraded` means NO
 * KEY, not "reuse".
 *
 * WHY THE IMPURE HALF LIVES HERE AND NOT IN design-lane.ts. That file's header
 * stakes its purity — the mode it returns fills `allowedAgents`, which is a
 * permission boundary, and `surface.ts`'s rule is that a boundary which can await
 * or throw is not a boundary. Everything below opens files. The two halves meet at
 * one string: the source run id, validated HERE at intake and handed to
 * `designLaneMode` as `reusedFrom` there.
 *
 * WHY A PARTIAL COPY IS THE FAILURE THIS FILE IS SHAPED AROUND. Half a direction
 * puts the build agent in front of `Read` targets that resolve to nothing, several
 * turns deep, reported as the agent's confusion rather than as a design fault
 * (`pruneMissingRefs` says the same thing about the same seam); and it puts the
 * visual gate in front of a missing reference, which grades against the rule-based
 * floor while `design-lane.json` claims a locked design. So: the source is verified
 * ON DISK before a run id is minted, and the copy itself is staged outside the
 * workspace and moved into place in ONE rename.
 *
 * EVERY PATH IN THE COPIED MANIFEST IS REWRITTEN TO THIS RUN'S OWN WORKSPACE, and
 * that is not cosmetic. `parseDesignManifest` fences `refs[].path` to
 * `<workspace>/design-refs/` and drops the whole manifest when a ref falls
 * outside it, and it honours `locked` only when it matches a ref path by EXACT
 * STRING EQUALITY. A copy that kept the source's paths therefore does not point at
 * another run's files — it produces no manifest at all. A copy that rewrote the
 * refs and not the lock produces `lockedMockup: null` and a silent fall back to
 * rule-based scoring. Both are asserted in `design-reuse.test.ts`. And the harm
 * behind the fence is one this repository has already been bitten by once: a
 * shared preview host served one run's site under another run's URL.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { readDesignLock } from "./design-lock.js";
import type { DesignManifest, DesignRef } from "./design-manifest.js";
import {
  DESIGN_MANIFEST_FILE,
  countDesignPngs,
  manifestPathFor,
  parseDesignManifest,
  readDesignManifest,
  refsDirFor,
  serialiseDesignManifest,
} from "./design-manifest.js";
import type { RunPaths } from "./paths.js";

/**
 * `runs/<id>/design-reuse.json` — THE INTENT, AS A FILE IN THE RUN'S OWN
 * DIRECTORY.
 *
 * WHY A MARKER FILE AND NOT A `runs` COLUMN. The alternative considered was a
 * column on the runs table, and it was rejected on two counts. It needs a schema
 * migration in `db.ts` for a fact that is not about the run's identity, its spend
 * or its status; and the fact itself is about BYTES ON DISK — the run directory
 * already carries `references/` and `documents/` written by the same request, at
 * the same moment, for the same reason. A file beside them needs no migration, is
 * readable by a human debugging a run directory, and cannot be half-written into a
 * row that then disagrees with what is actually on disk.
 *
 * WHAT IT COSTS, STATED: a marker is not queryable. `GET /api/runs` cannot filter
 * "runs that reused art" without opening N files, and it does not try to. The
 * honest record of the decision is `results/design-lane.json`, which every reader
 * of a run's outcome opens anyway.
 */
export const DESIGN_REUSE_MARKER_FILE = "design-reuse.json";

export interface DesignReuseIntent {
  /** The run whose `design-refs/` this run copies. Validated before it is written. */
  readonly sourceRunId: string;
  readonly requestedAt: string;
}

/**
 * The four refusals, as codes a client can switch on.
 *
 * ONE CODE PER CAUSE, because the fixes are different: a wrong run id is a typo,
 * a run with no `design-refs/` is a run whose lane was off or degraded, a refs
 * directory with no readable manifest is a lane that came back broken, and a
 * source with no lock is a run whose design was never settled — the last is the
 * only one where "wait for that run to finish" is the remedy.
 */
export type DesignReuseRefusalCode =
  | "reuse_source_missing"
  | "reuse_source_no_design_refs"
  | "reuse_source_no_manifest"
  | "reuse_source_no_lock";

export interface DesignReuseSource {
  readonly runId: string;
  readonly refsDir: string;
  /** The source's manifest, VALIDATED against the source's own workspace. */
  readonly manifest: DesignManifest;
  /** ABSOLUTE, inside the source's refs dir, and its bytes are on disk. */
  readonly locked: string;
  /** Stills in the source's refs directory, counted BY CONTENT (`countDesignPngs`). */
  readonly images: number;
}

export type DesignReuseCheck =
  | { readonly ok: true; readonly source: DesignReuseSource }
  | {
      readonly ok: false;
      readonly code: DesignReuseRefusalCode;
      readonly message: string;
      readonly remediation: string | null;
    };

function refuse(
  code: DesignReuseRefusalCode,
  message: string,
  remediation: string | null = null,
): DesignReuseCheck {
  return { ok: false, code, message, remediation };
}

/**
 * Is this run's design set complete enough to build another run on?
 *
 * READ OFF DISK, NEVER OFF THE SOURCE RUN'S STATUS. A run row says `completed`
 * when the gate finished, which says nothing about whether its DESIGN lane
 * produced anything — a `degraded` run completes with no stills at all, and a
 * `full` run whose image chain died completes with a manifest listing refs that
 * were never written (`classifyDesignLane`'s `manifest-invalid` arm exists for
 * exactly that shape). Trusting the status is how a completed run with no art
 * becomes a new run with half a design.
 *
 * IT IS CALLED BEFORE A RUN ID IS MINTED, which is the invariant `createRun`'s
 * intake comments state for the reference and document decoders: a refused
 * submission costs no directory, no row, no capture and no spec phase.
 */
export function validateDesignReuseSource(sourceRunId: string, sourcePaths: RunPaths): DesignReuseCheck {
  if (!existsSync(sourcePaths.root)) {
    return refuse(
      "reuse_source_missing",
      `there is no run ${sourceRunId} on disk at ${sourcePaths.root}`,
      "GET /api/runs lists the run ids this dashboard holds. Reuse needs the run's DIRECTORY, " +
        "not just its row — a run whose directory was deleted cannot lend its design.",
    );
  }
  const refsDir = refsDirFor(sourcePaths.workspace);
  if (!existsSync(refsDir)) {
    return refuse(
      "reuse_source_no_design_refs",
      `run ${sourceRunId} has no design-refs directory (${refsDir})`,
      "That run's DESIGN lane was off or degraded, so it has no stills to lend. Its " +
        "results/design-lane.json says which.",
    );
  }
  const manifestPath = manifestPathFor(sourcePaths.workspace);
  if (!existsSync(manifestPath)) {
    return refuse(
      "reuse_source_no_manifest",
      `run ${sourceRunId} has a design-refs directory with no ${DESIGN_MANIFEST_FILE}`,
      "Nothing names that run's stills, so nothing downstream could name the copies either.",
    );
  }
  let manifest: DesignManifest | null = null;
  try {
    manifest = parseDesignManifest(readFileSync(manifestPath, "utf8"), sourcePaths.workspace);
  } catch {
    manifest = null;
  }
  if (manifest === null) {
    // SAME CODE, DIFFERENT SENTENCE. "Absent" and "present but unreadable" are one
    // remedy away from each other — neither run can lend its design — but a caller
    // reading "no manifest.json" while the file is sitting there would go looking
    // in the wrong place.
    return refuse(
      "reuse_source_no_manifest",
      `run ${sourceRunId} has a ${DESIGN_MANIFEST_FILE} that did not parse`,
      "A manifest that fails validation is not half-honoured — see parseDesignManifest.",
    );
  }
  // THE LOCK IS CHECKED IN BOTH PLACES IT LIVES, AND THEN ON DISK.
  //
  // `manifest.lockedMockup` is what the VISUAL GATE reads; `design-lock.json`'s
  // `locked` is the run RECORD of the same decision (§17.3 rule 5). A source
  // carrying one and not the other has not settled its design, and copying it
  // would hand this run a gate input that no record accounts for.
  //
  // AND THE FILE ITSELF MUST EXIST. A lock naming a still somebody deleted passes
  // every null check above and then degrades the reused run silently: the copy
  // lands without that PNG, `pruneMissingRefs` drops the lock out of the handoff,
  // and the gate falls back to rule-based scoring on a run whose record claims a
  // locked design.
  const recorded = readDesignLock(sourcePaths.results)?.locked ?? null;
  if (manifest.lockedMockup === null || recorded === null) {
    return refuse(
      "reuse_source_no_lock",
      manifest.lockedMockup === null
        ? `run ${sourceRunId} locked no design still: its ${DESIGN_MANIFEST_FILE} has no \`locked\` path`
        : `run ${sourceRunId} has a locked still in its manifest and no design-lock.json record of it`,
      "Only a run whose design was settled can lend it. A run parked awaiting a choice has not " +
        "settled one yet.",
    );
  }
  if (!existsSync(manifest.lockedMockup)) {
    return refuse(
      "reuse_source_no_lock",
      `run ${sourceRunId} locks a still that is not on disk: ${manifest.lockedMockup}`,
      "The locked still is what the visual gate grades against. A reused run would inherit a " +
        "reference nobody can open.",
    );
  }
  return {
    ok: true,
    source: {
      runId: sourceRunId,
      refsDir,
      manifest,
      locked: manifest.lockedMockup,
      images: countDesignPngs(refsDir),
    },
  };
}

/* ---- the marker -------------------------------------------------------- */

/**
 * Write the intent into the new run's directory.
 *
 * `mkdirSync` FIRST, because the run root is not guaranteed to exist yet: intake
 * creates `references/` and `documents/` only when the ticket actually carries
 * some, so a plain brief with a `reuseDesignFrom` reaches here with nothing on
 * disk. `ensureRunDirs` runs later, in the orchestrator.
 */
export function writeDesignReuseMarker(runRoot: string, intent: DesignReuseIntent): void {
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, DESIGN_REUSE_MARKER_FILE), `${JSON.stringify(intent, null, 2)}\n`, "utf8");
}

/**
 * The intent, or null.
 *
 * WRITTEN BY THE HOST, INSIDE `runs/<id>/` BUT OUTSIDE `workspace/`, which is what
 * `sandbox.filesystem.allowWrite` fences a build to. So nothing in a build can
 * forge one, and this parses defensively only against a file the host itself may
 * have half-written — the same posture `readDesignLaneRecord` takes and for the
 * same reason.
 */
export function readDesignReuseMarker(runRoot: string): DesignReuseIntent | null {
  const path = join(runRoot, DESIGN_REUSE_MARKER_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const sourceRunId = record["sourceRunId"];
    if (typeof sourceRunId !== "string" || sourceRunId.trim().length === 0) return null;
    const requestedAt = record["requestedAt"];
    return { sourceRunId, requestedAt: typeof requestedAt === "string" ? requestedAt : "" };
  } catch {
    return null;
  }
}

/* ---- the copy ---------------------------------------------------------- */

export type DesignReuseResult =
  | {
      readonly ok: true;
      /** Re-read from THIS run's workspace, so it is what every consumer will see. */
      readonly manifest: DesignManifest;
      /** Stills that landed, counted by content in the DESTINATION. Never the intended number. */
      readonly images: number;
      /** Files copied, manifest included. */
      readonly files: number;
      /** Refs whose `animate: true` was dropped. See {@link stripVideoMarks}. */
      readonly videoMarksDropped: number;
      /** ABSOLUTE, inside THIS run's workspace. */
      readonly locked: string;
    }
  | { readonly ok: false; readonly detail: string };

/** `<source refs>/<name>` → `<this run's refs>/<name>`. The refs directory is flat. */
function rewritePath(path: string, destRefsDir: string): string {
  return join(destRefsDir, basename(path));
}

/**
 * THE VIDEO MARK IS DROPPED ON THE WAY ACROSS, AND IT IS A SPEND CONTROL.
 *
 * MEASURED: `grep -c '"animate": true'` over the 2026-08-12 run's `manifest.json`
 * returns 2. `runVideoLane` runs on the BUILD segment — which is the ONLY segment
 * a reused run takes, because there is no design segment — and `planVideoLegs`
 * buys one metered Veo leg per marked ref. So a reused run would have bought video
 * for art it did not make, on a key that is the binding constraint, on a run whose
 * whole purpose was to spend nothing on design. That is the same failure the
 * feature exists to prevent, arriving through the one lane nobody was looking at.
 *
 * DROPPED RATHER THAN COPIED, because the video is not in `design-refs/` — it is
 * an asset of the source run's own build — and copying a run's built assets is
 * outside what a design reuse is. The consequence is stated rather than hidden: a
 * reused run ships no motion of its own, and `#reuseDesignFor` says so on the
 * run's log with the number of marks it dropped.
 */
function stripVideoMarks(refs: readonly DesignRef[]): { refs: DesignRef[]; dropped: number } {
  let dropped = 0;
  const stripped = refs.map((ref) => {
    if (ref.animate !== true) return ref;
    dropped += 1;
    // `animate` is OMITTED, never set to `false`. `DesignRef` says absent means
    // "2b never considered it" and false would be an invention — the same
    // distinction `readOrigin` keeps.
    const { animate: _dropped, ...rest } = ref;
    return rest;
  });
  return { refs: stripped, dropped };
}

function rewriteManifest(manifest: DesignManifest, destRefsDir: string): DesignManifest {
  // EVERY PATH-SHAPED FIELD, AND THE LIST IS THE HAZARD. `refs[].path` is fenced
  // by `parseDesignManifest`; `directions[].notes` is fenced by the same function
  // and is a `Read` target in the build prompt; `lockedMockup` is honoured only on
  // EXACT string equality with a ref path, so it is rewritten by the same function
  // as the refs rather than by a second expression that could drift from it.
  return {
    ...manifest,
    refs: stripVideoMarks(manifest.refs).refs.map((ref) => ({ ...ref, path: rewritePath(ref.path, destRefsDir) })),
    directions: manifest.directions.map((direction) => ({
      ...direction,
      notes: direction.notes === null ? null : rewritePath(direction.notes, destRefsDir),
    })),
    lockedMockup: manifest.lockedMockup === null ? null : rewritePath(manifest.lockedMockup, destRefsDir),
  };
}

/**
 * Copy a validated source's design set into this run's workspace, whole or not at
 * all.
 *
 * WHAT IS COPIED: every regular FILE in the source's `design-refs/`, which is the
 * stills, `direction.md`, the per-direction `direction-<slug>.md` notes and
 * `direction-choice.json` — the set the manifest and the lock between them name.
 * Nothing else from the source run is opened: not its `src/`, not its workspace
 * outside this one directory, not its database, not its `results/`. Sub-DIRECTORIES
 * are skipped rather than walked: nothing writes one today, and a recursive copy
 * out of a directory build agents can write to is an unbounded read.
 *
 * STAGED OUTSIDE THE WORKSPACE, THEN MOVED IN ONE `rename`. The staging directory
 * is a dot-directory in the run ROOT, so a crash halfway through leaves the
 * workspace with no `design-refs/` at all rather than with half a direction — and
 * leaves nothing for `project-publish` to pick up either, since it never reaches
 * the workspace. The manifest is written into the staging directory with the FINAL
 * paths already in it, so the set appears complete or not at all.
 *
 * IT DOES NOT THROW. A copy failure has to become a sentence on the run's own log
 * and a recorded lane state, not a harness fault that replaces the design failure
 * with a stack trace — the same rule `#recordDesignMockups` follows.
 */
export function copyDesignAssets(source: DesignReuseSource, dest: RunPaths): DesignReuseResult {
  const destRefsDir = refsDirFor(dest.workspace);
  const staging = join(dest.root, ".design-reuse-staging");
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    let files = 0;
    for (const name of readdirSync(source.refsDir)) {
      const from = join(source.refsDir, name);
      if (!statSync(from).isFile()) continue;
      // The manifest is not copied — it is REWRITTEN below. Copying it and then
      // overwriting would leave the source's absolute paths on disk for the
      // length of one syscall, and a reader of a half-finished staging directory
      // would see paths into another run.
      if (name === DESIGN_MANIFEST_FILE) continue;
      copyFileSync(from, join(staging, name));
      files += 1;
    }
    // THE MANIFEST, WITH THIS RUN'S PATHS ALREADY IN IT, WRITTEN INTO THE STAGING
    // DIRECTORY. `serialiseDesignManifest` is the same writer `writeDesignManifest`
    // uses, so the field list cannot drift from the one the host writes elsewhere —
    // that function's own docblock records the control for what an omitted field
    // costs (the next host write erases it).
    const rewritten = rewriteManifest(source.manifest, destRefsDir);
    writeFileSync(join(staging, DESIGN_MANIFEST_FILE), serialiseDesignManifest(rewritten), "utf8");
    mkdirSync(dirname(destRefsDir), { recursive: true });
    rmSync(destRefsDir, { recursive: true, force: true });
    renameSync(staging, destRefsDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  /*
   * READ BACK THROUGH THE ONE READ PATH, AND THIS IS A NEGATIVE CONTROL RATHER
   * THAN A FORMALITY.
   *
   * `readDesignManifest` runs `parseDesignManifest` against THIS run's workspace,
   * which is the same validation every downstream consumer will run. If a path
   * were left pointing at the source, the fence would drop the whole manifest and
   * this returns `ok: false` — the reused run then says so out loud instead of
   * building to a design nothing can name.
   */
  const manifest = readDesignManifest(dest.workspace);
  if (manifest === null) {
    rmSync(destRefsDir, { recursive: true, force: true });
    return { ok: false, detail: "the copied manifest did not parse against this run's own workspace" };
  }
  if (manifest.lockedMockup === null || !existsSync(manifest.lockedMockup)) {
    rmSync(destRefsDir, { recursive: true, force: true });
    return {
      ok: false,
      detail:
        manifest.lockedMockup === null
          ? "the copied manifest carries no locked still — the lock did not survive the path rewrite"
          : `the copied lock names ${manifest.lockedMockup}, which is not on disk`,
    };
  }
  return {
    ok: true,
    manifest,
    images: countDesignPngs(destRefsDir),
    files: readdirSync(destRefsDir).length,
    videoMarksDropped: stripVideoMarks(source.manifest.refs).dropped,
    locked: manifest.lockedMockup,
  };
}
