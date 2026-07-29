/**
 * The image→video lane: plan, spend, record, and hand the build agents the one
 * thing they cannot infer — HOW to consume an mp4 that is meant to be scrubbed.
 *
 * DEGRADE, DO NOT BLOCK. No capability, no manifest, or no `animate` section all
 * produce a record and an empty prompt. Spec §6.5's posture, verbatim: blocking
 * a build on an absent image key is a worse failure than shipping without
 * mockups, and the same is true of video.
 *
 * COST IS A CALL COUNT AND A DURATION, NEVER A PRICE. `costUsd` is `null` by
 * construction in `renderVideoSpend`; the script prints a path, the API response
 * carries no price, and this program has no price table. A dollar figure here
 * would be the fabrication `api-types.ts`'s header forbids.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GraphSseEvent } from "../api-types.js";
import type { DesignManifest } from "../design-manifest.js";
import { subscriptionSubprocessEnv } from "../subprocess-env.js";
import type { VideoCapability } from "./video-capability.js";
import {
  planVideoLegs,
  renderVideoSpend,
  resolveLegCap,
  runVideoLegs,
  type VideoLeg,
  type VideoLegPlan,
  type VideoSpendRecord,
} from "./video-legs.js";

const MODEL = "veo-3.1-generate-preview";
const RESOLUTION = "720p";
/** 4 s at 720p — spec §7.6, and REVISION 1 measured exactly this against Veo. */
const DURATION_SECONDS = 4;
const TIMEOUT_SECONDS = 900;

export interface VideoLaneDeps {
  readonly workspace: string;
  readonly recordPath: string;
  /** The graph node this lane's tool pills attach to. See {@link runVideoLane}. */
  readonly node: string;
  readonly env: NodeJS.ProcessEnv;
  readonly capability: VideoCapability;
  /** The parsed manifest, or null. Given as a thunk so a degraded lane never reads. */
  readonly readManifest: () => DesignManifest | null;
  readonly spawnLeg: (leg: VideoLeg, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail: string }>;
  readonly emitGraph: (event: GraphSseEvent) => void;
  readonly writeRecord: (path: string, json: string) => void;
  /** `mkdir -p`. Injected so the TMPDIR it creates is OBSERVABLE in a test. */
  readonly ensureDir: (path: string) => void;
  /**
   * `existsSync`. Two jobs, both about money.
   *
   * It decides whether this run has ALREADY spent (see {@link runVideoLane}), and
   * on that path it decides which legs are real enough to advertise.
   */
  readonly fileExists: (path: string) => boolean;
}

/** Derived in ONE place. `videoLaneEnv` points at it, `runVideoLane` creates it. */
export function workspaceTmpDir(workspace: string): string {
  return join(workspace, ".tmp");
}

/**
 * TMPDIR IS MOVED INSIDE THE WORKSPACE, and that is spec §7.5's "most likely
 * silent breakage" for the image sibling, inherited here verbatim: the script
 * does `mktemp -d` in the SYSTEM temp dir while `sandbox.filesystem.allowWrite`
 * is `[workspace]`.
 *
 * POINTING AT IT IS HALF THE JOB. `mktemp -d` against a directory that does not
 * exist fails outright — "mkdtemp failed on …: No such file or directory" — and
 * under `set -e` the script is dead at exit 1 for a reason nothing in the ticket
 * predicts. `runVideoLane` therefore creates it before the first leg, via an
 * injected `ensureDir`, so the creation is observable in a test rather than a
 * side effect nothing can see.
 *
 * GEMINI_API_KEY SURVIVES, ON PURPOSE. It is absent from `STRIPPED_ENV_NAMES`
 * (`subprocess-env.ts:39-55`, "a subtraction, never an allowlist") and spec §7.5
 * records that as intended — this lane is the metered spend the note is about.
 */
export function videoLaneEnv(env: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  return { ...subscriptionSubprocessEnv(env), TMPDIR: workspaceTmpDir(workspace) };
}

/**
 * THE CONTAINER KEY IS `refs` ON DISK AND `sections` IN THE PLANNER, and this
 * function is the whole of the join.
 *
 * `design-manifest.ts:26-33` flags it in as many words: the Phase 2c plan
 * sketches the on-disk shape as `{"sections": […]}` and `planVideoLegs` reads
 * `manifestJson.sections`, while `writeDesignManifest` — the only writer this
 * program has — writes `{"refs": […]}`. Against a real manifest that mismatch
 * yields an empty array, zero legs, and a lane that reports itself "degraded"
 * forever while every unit test on both sides stays green, because the planner's
 * tests feed it `sections` and the manifest module's tests never call it.
 *
 * The ELEMENT shape is already identical — `DesignRef` is `path`, `section`,
 * `aspect`, `intent`, `animate?`, which is field-for-field what the planner
 * reads — so this is a rename of one key and nothing else. It lives here rather
 * than in either neighbour because this is the module that reads the file from
 * disk and hands it to the planner; putting it in `video-legs.ts` would make the
 * planner know about a 2b type it is deliberately not typed against, and putting
 * it in `design-manifest.ts` would make 2b's contract carry 2c's spelling.
 */
export function legPlannerInput(manifest: DesignManifest | null): unknown {
  if (manifest === null) return null;
  return { sections: manifest.refs };
}

export function defaultSpawnLeg(scriptPath: string): VideoLaneDeps["spawnLeg"] {
  const run = promisify(execFile);
  return async (leg, env) => {
    try {
      await run(
        scriptPath,
        [
          motionPromptFor(leg),
          "-i",
          leg.still,
          "-a",
          leg.aspect,
          "-d",
          String(DURATION_SECONDS),
          "-r",
          RESOLUTION,
          "-o",
          leg.out,
          "-m",
          MODEL,
        ],
        // The script's own deadline is TIMEOUT_SECONDS; this one is a minute
        // wider so a script that times out cleanly reports ITS exit code 2
        // rather than being SIGKILLed a moment before it could.
        { env, timeout: (TIMEOUT_SECONDS + 60) * 1000, killSignal: "SIGKILL" },
      );
      return { ok: true, detail: "" };
    } catch (error) {
      // The script already redacts. This carries only its exit code and stderr,
      // and the harness's key-leak test is what covers that stderr.
      const e = error as { code?: number; stderr?: string };
      return { ok: false, detail: `exit ${String(e.code ?? "?")}: ${(e.stderr ?? "").slice(0, 500)}` };
    }
  };
}

function motionPromptFor(leg: VideoLeg): string {
  return (
    `A slow, continuous camera move through this exact scene, holding its palette, lighting and ` +
    `composition. No cuts, no new subjects, no text. The first frame is the supplied still. ` +
    `Section: ${leg.section}.`
  );
}

/**
 * Spec §7.6.4, taken from the reference site's runtime behaviour, not invented.
 *
 * ONLY LEGS THAT EXIST GET ADVERTISED. A path in a prompt is what makes a
 * `fetch` actually happen (§7.3) — which is exactly why a path to a leg that
 * failed is worse than no path at all: the build agent wires a world layer
 * around a URL that 404s, and the page it ships is blank where the video was.
 */
export function videoConsumptionPrompt(legs: readonly VideoLeg[]): string {
  if (legs.length === 0) return "";
  const list = legs
    .map((l) => `  leg ${String(l.index)} (${l.section}): ${l.out}\n    poster: ${l.poster}`)
    .join("\n");
  return [
    "SCROLL-SCRUBBED WORLD LAYER — implement exactly this pattern. It is measured from the",
    "reference site's runtime behaviour, not invented, and it is what the motion bar accepts.",
    "",
    list,
    "",
    "  fetch(mp4) -> blob: URL -> <video muted playsInline preload paused, no autoplay, no loop>",
    "  poster=<leg-N-poster.webp>                       instant first paint",
    "  rAF loop: video.currentTime = f(scrollProgress)   scrub, do not play",
    "  layers: position:absolute, object-fit:cover       full-bleed world",
    "",
    "The fetch->blob step is what makes seeking instant; a plain <video src> streams and scrubs",
    "badly. Do not call play(). Do not set loop.",
    "AUDIO IS GENERATED AND IGNORED: Veo 3.1 produces a native audio track and playback is muted",
    "and playsInline. Do not build on the audio track — no waveform, no sync, no unmute control.",
  ].join("\n");
}

function emptyPlan(cap: ReturnType<typeof resolveLegCap>): VideoLegPlan {
  return { legs: [], cap: cap.cap, capSource: cap.capSource, droppedByCap: 0, rejected: [] };
}

/**
 * Run the lane.
 *
 * `record` is `null` — and ONLY null — when this run had already written its
 * video record, which is the resume path below. The record on disk stands; this
 * call did not produce one, and returning a zero-spend record instead would read
 * as "this run spent nothing".
 *
 * THE SPEND IS ONCE PER RUN, NOT ONCE PER CALL, and that distinction is money.
 * `#buildPhase` is re-entered by `resume` — a BUILD segment that comes back
 * rate-limited returns with its session intact and `nextBuildSegment` picks the
 * same segment up on the next entry. Without this guard that second entry plans
 * the same manifest and spends the cap AGAIN, so §7.6.3.2's "at most 2 video
 * legs per run" becomes "at most 2 per attempt" — the cap holding at both of
 * Task 7's enforcement points and still being wrong about the run.
 *
 * THE GRAPH EVENT IS EMITTED AT LAUNCH, NOT AT COMPLETION (spec §7.6.3.4), and
 * `deps.node` must be a node the canvas ALREADY KNOWS: `foldGraph` drops a
 * `graph_tool` naming an unknown node (`graph.ts:180-183`) rather than
 * fabricating an agent for it, so a plausible-looking id lands nowhere and the
 * only shipped mitigation for a leg that takes minutes silently disappears.
 */
export async function runVideoLane(
  deps: VideoLaneDeps,
): Promise<{ record: VideoSpendRecord | null; prompt: string }> {
  const cap = resolveLegCap(deps.env);
  const plan = deps.capability.available
    ? planVideoLegs(legPlannerInput(deps.readManifest()), deps.workspace, cap)
    : emptyPlan(cap);

  if (deps.fileExists(deps.recordPath)) {
    // Already spent, this run. Say nothing new, spend nothing, overwrite
    // nothing — but still hand the build agents the legs that landed, because
    // this entry is the one whose prompt reaches them.
    return { record: null, prompt: videoConsumptionPrompt(plan.legs.filter((l) => deps.fileExists(l.out))) };
  }

  const env = videoLaneEnv(deps.env, deps.workspace);
  if (plan.legs.length > 0) deps.ensureDir(workspaceTmpDir(deps.workspace));

  // WHICH legs produced, not just HOW MANY. `LegRunSummary` counts, and a count
  // cannot tell the prompt builder that it was leg 2 rather than leg 1 that
  // failed. The invoker is ours, so the identity is free here.
  const produced: VideoLeg[] = [];
  const summary = await runVideoLegs(plan, async (leg) => {
    deps.emitGraph({
      type: "graph_tool",
      node: deps.node,
      name: "gemini-video.sh",
      mcpServer: null,
      summary: `generating leg-${String(leg.index)} (${leg.section}) — a Veo 3.1 leg takes minutes, not seconds`,
      attribution: "exact",
    });
    const result = await deps.spawnLeg(leg, env);
    if (result.ok) produced.push(leg);
    return result;
  });

  const record = renderVideoSpend({
    capability: deps.capability,
    plan,
    summary,
    model: MODEL,
    resolution: RESOLUTION,
    durationSeconds: DURATION_SECONDS,
    timeoutSeconds: TIMEOUT_SECONDS,
  });
  deps.writeRecord(deps.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { record, prompt: videoConsumptionPrompt(produced) };
}
