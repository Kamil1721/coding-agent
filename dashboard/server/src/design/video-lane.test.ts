/**
 * video-lane.test.ts — the lane, and the two facts its unit assertions alone
 * cannot establish.
 *
 * A FAKE `emitGraph` PROVES A CALLBACK RAN, NOT THAT THE CANVAS SAW ANYTHING.
 * `foldGraph` drops a `graph_tool` naming a node it does not know
 * (`graph.ts:180-183`), so the plan's drafted canvas test — "two graph_tool
 * events were pushed into an array" — is green for a node id that lands nowhere.
 * "THE PILL SURVIVES THE REAL REDUCER" below runs the lane's own events through
 * `foldGraphAll` and asserts the count on the folded node, with the paired
 * negative control immediately under it.
 *
 * AND A `sections` FIXTURE PROVES NOTHING ABOUT A FILE THIS PROGRAM WRITES.
 * Every manifest fixture here is a real `DesignManifest`, whose container key is
 * `refs`; the last test drives one through `writeDesignManifest` /
 * `readDesignManifest` and compares the adapter against its absence.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GraphSseEvent } from "../api-types.js";
import { graphResumeState } from "../build-segment.js";
import {
  readDesignManifest,
  writeDesignManifest,
  type DesignManifest,
} from "../design-manifest.js";
import { foldGraphAll } from "../graph.js";
import type { VideoCapability } from "./video-capability.js";
import { planVideoLegs, resolveLegCap } from "./video-legs.js";
import {
  legPlannerInput,
  runVideoLane,
  videoConsumptionPrompt,
  videoLaneEnv,
  workspaceTmpDir,
  type VideoLaneDeps,
} from "./video-lane.js";

const KEY = "AIza-SENTINEL-NEVER-PRINT-1234567890";

const AVAILABLE: VideoCapability = {
  available: true,
  reason: "ok",
  scriptPath: "/home/u/.claude/scripts/gemini-video.sh",
  scriptSha256: "a".repeat(64),
  keySource: "GEMINI_API_KEY",
};

/** A REAL `DesignManifest`. The container key is `refs`; see `legPlannerInput`. */
const MANIFEST: DesignManifest = {
  version: 1,
  refs: [
    { path: "/ws/design-refs/01.png", section: "descent", aspect: "16:9", intent: "i", animate: true },
    { path: "/ws/design-refs/02.png", section: "arrival", aspect: "16:9", intent: "i", animate: true },
    { path: "/ws/design-refs/03.png", section: "outro", aspect: "16:9", intent: "i", animate: true },
  ],
  lockedMockup: null,
  lockedBy: null,
  lockedReason: null,
  lockedAt: null,
};

function deps(over: Partial<VideoLaneDeps> = {}): {
  d: VideoLaneDeps;
  events: GraphSseEvent[];
  written: string[];
  spawned: string[];
} {
  const events: GraphSseEvent[] = [];
  const written: string[] = [];
  const spawned: string[] = [];
  const d: VideoLaneDeps = {
    workspace: "/ws",
    recordPath: "/runs/r1/results/video.json",
    node: "n7",
    env: { GEMINI_API_KEY: KEY },
    capability: AVAILABLE,
    readManifest: () => MANIFEST,
    spawnLeg: async (leg) => {
      spawned.push(leg.out);
      return { ok: true, detail: "" };
    },
    emitGraph: (e) => events.push(e),
    writeRecord: (_p, json) => written.push(json),
    ensureDir: () => {},
    fileExists: () => false,
    ...over,
  };
  return { d, events, written, spawned };
}

test("the lane runs two legs, records them, and writes the spend line", async () => {
  const { d, written, spawned } = deps();
  const { record } = await runVideoLane(d);
  assert.equal(spawned.length, 2, "the cap holds through the lane, not just the planner");
  assert.equal(record?.legsProduced, 2);
  assert.equal(record?.costUsd, null);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /"legsProduced": *2/);
});

test("NO CAPABILITY DEGRADES, IT DOES NOT BLOCK — and it still leaves a record", async () => {
  // Same posture as §6.5's geminiKeyAvailable(): blocking a build on an absent
  // key is a worse failure than shipping without the video.
  const { d, spawned, written } = deps({
    capability: {
      available: false,
      reason: "no key resolved",
      scriptPath: null,
      scriptSha256: null,
      keySource: null,
    },
  });
  const { record, prompt } = await runVideoLane(d);
  assert.equal(spawned.length, 0, "nothing was spawned");
  assert.equal(record?.legsProduced, 0);
  assert.equal(written.length, 1, "a degraded lane is still explainable after the fact");
  assert.equal(prompt, "", "and the build agents are told nothing about legs that do not exist");
});

test("THE CANVAS SEES A LONG-RUNNING LEG START", async () => {
  // Spec §7.6.3.4: a leg takes minutes, and without an event the canvas looks
  // stalled. graph_tool is emitted at launch, not at completion, because a
  // completion-only event is exactly the silence being fixed.
  const { d, events } = deps();
  await runVideoLane(d);
  // A TYPE PREDICATE, not a bare boolean: `summary` and `node` do not exist on
  // every GraphSseEvent member, so a plain `.filter` leaves the union unnarrowed
  // and this file does not compile.
  const tools = events.filter(
    (e): e is Extract<GraphSseEvent, { type: "graph_tool" }> => e.type === "graph_tool",
  );
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.node, "n7");
  assert.match(tools[0]?.summary ?? "", /minutes/iu, "the caption says this is slow ON PURPOSE");
  assert.match(tools[0]?.summary ?? "", /leg-1/u);
  assert.ok(!JSON.stringify(events).includes(KEY), "and no key on the canvas (§7.5, CLAUDE.md:18)");
});

test("EMITTED BEFORE THE SPAWN, not after it — the ordering IS the feature", async () => {
  // The test above counts events after the lane has finished, which is the same
  // count whether the emit runs before `spawnLeg` or after it. This one is the
  // clause that distinguishes them, and it fails alone when the emit moves.
  const seen: number[] = [];
  const { d, events } = deps();
  await runVideoLane({
    ...d,
    spawnLeg: async () => {
      seen.push(events.length);
      return { ok: true, detail: "" };
    },
  });
  assert.deepEqual(seen, [1, 2], "each leg's event was already on the canvas when the leg started");
});

test("THE PILL SURVIVES THE REAL REDUCER — and the negative control shows what that is worth", async () => {
  // THE DEFECT THIS EXISTS FOR. Every other canvas assertion in this file reads
  // an array a fake `emitGraph` pushed into. `foldGraph` DROPS a `graph_tool`
  // whose node it has never seen (`graph.ts:180-183`) — "an event whose node
  // cannot be determined is dropped, not re-pointed at the root" — so a lane
  // emitting a well-formed event against a plausible id renders NOTHING and no
  // unit test above can tell. The node is therefore derived here the way
  // `#buildPhase` derives it, from the run's already-stored graph.
  const prior: GraphSseEvent[] = [
    {
      type: "graph_agent",
      node: "n1",
      parent: null,
      agent: null,
      lane: null,
      description: "the run's own session",
      ambient: false,
      attribution: "exact",
      sdk: null,
    },
    {
      type: "graph_agent",
      node: "n2",
      parent: "n1",
      agent: "taste-frontend-expert",
      lane: null,
      description: "taste-frontend-expert",
      ambient: false,
      attribution: "exact",
      sdk: null,
    },
  ];
  const root = graphResumeState(prior).rootNode;
  assert.equal(root, "n1", "the run's root is what the lane's pills hang on");

  const { d, events } = deps({ node: root ?? "" });
  await runVideoLane(d);
  const folded = foldGraphAll([...prior, ...events]);
  const node = folded.nodes.find((n) => n.id === root);
  assert.equal(node?.toolCalls, 2, "the canvas counted both legs");
  assert.deepEqual(
    node?.tools.map((p) => `${p.name}x${String(p.count)}`),
    ["gemini-video.shx2"],
    "and the pill is the script's own name",
  );

  // THE NEGATIVE CONTROL, in the same test so it cannot be deleted separately.
  // Identical events, a node id nothing minted: everything is silently gone.
  const other = deps({ node: "n99" });
  await runVideoLane(other.d);
  const lost = foldGraphAll([...prior, ...other.events]);
  assert.equal(
    lost.nodes.reduce((sum, n) => sum + n.toolCalls, 0),
    0,
    "an unknown node loses the pill entirely — which is what makes the assertion above a check",
  );
});

test("TMPDIR IS MOVED INSIDE THE WORKSPACE, and the key is NOT stripped", () => {
  // Spec §7.5 row 1: the script does `mktemp -d` in the SYSTEM temp dir while
  // sandbox allowWrite is [workspace]. "Most likely silent breakage."
  const env = videoLaneEnv(
    { GEMINI_API_KEY: KEY, ANTHROPIC_API_KEY: "nope", TMPDIR: "/var/folders/x" },
    "/ws",
  );
  assert.equal(env["TMPDIR"], workspaceTmpDir("/ws"));
  assert.equal(env["GEMINI_API_KEY"], KEY, "deliberately NOT in STRIPPED_ENV_NAMES — spec §7.5");
  assert.equal(env["ANTHROPIC_API_KEY"], undefined, "the subscription invariant still holds");
});

test("THE TMPDIR IS CREATED BEFORE THE FIRST LEG, not merely named", async () => {
  // A string assertion on TMPDIR is NOT a test of TMPDIR. `mktemp -d` against a
  // directory that does not exist fails with "mkdtemp failed on /ws/.tmp/…: No
  // such file or directory", the script dies at exit 1, and nobody connects that
  // message to this env var. The pointing and the existing are two facts.
  const order: string[] = [];
  const { d } = deps();
  await runVideoLane({
    ...d,
    ensureDir: (p) => order.push(`mkdir ${p}`),
    spawnLeg: async (leg) => {
      order.push(`spawn leg-${String(leg.index)}`);
      return { ok: true, detail: "" };
    },
  });
  assert.equal(order[0], `mkdir ${workspaceTmpDir("/ws")}`, "created FIRST");
  assert.equal(order[1], "spawn leg-1");
});

test("the consumption prompt is §7.6.4's pattern, with the real paths in it", () => {
  const p = videoConsumptionPrompt([
    {
      index: 1,
      still: "/ws/design-refs/01.png",
      section: "descent",
      aspect: "16:9",
      out: "/ws/assets/world/leg-1.mp4",
      poster: "/ws/assets/world/leg-1-poster.webp",
    },
  ]);
  assert.match(p, /\/ws\/assets\/world\/leg-1\.mp4/u, "absolute paths are what make a Read/fetch happen");
  assert.match(p, /leg-1-poster\.webp/u);
  assert.match(p, /fetch/u);
  assert.match(p, /blob:/u);
  assert.match(p, /muted/u);
  assert.match(p, /playsInline/u);
  assert.match(p, /currentTime/u);
  assert.match(p, /requestAnimationFrame|rAF/u);
  assert.match(p, /object-fit: *cover|objectFit/u);
  assert.match(p, /no autoplay/iu);
  assert.match(p, /no loop/iu);
  assert.match(p, /scrub, do not play/iu);
  assert.match(p, /audio/iu, "§7.6.3.3: audio is generated and IGNORED — say so, or someone builds on it");
  assert.ok(!p.includes(KEY));
});

/**
 * §7.6.4 AS FOUR EXACT LINES, copied from
 * `docs/superpowers/specs/2026-07-28-orchestration-canvas-design.md:377-380`.
 *
 * The only two departures from the spec's bytes are stated rather than assumed:
 * the `→` glyph is written `->` (the plan's own rendering of §7.6.4 does the
 * same), and the block is indented two spaces inside the prompt. Verified
 * mechanically against the spec file when this test was written: strip the two
 * spaces, map `->` back to `→`, and all four lines are byte-identical.
 */
const PATTERN_BLOCK = [
  "  fetch(mp4) -> blob: URL -> <video muted playsInline preload paused, no autoplay, no loop>",
  "  poster=<leg-N-poster.webp>                       instant first paint",
  "  rAF loop: video.currentTime = f(scrollProgress)   scrub, do not play",
  "  layers: position:absolute, object-fit:cover       full-bleed world",
].join("\n");

test("§7.6.4 IS COPIED, NOT PARAPHRASED — the four lines appear verbatim and in order", () => {
  // THE TOKEN-BY-TOKEN TEST BELOW CANNOT SEE A PARAPHRASE, and that was MEASURED
  // rather than reasoned about. Two mutations of `videoConsumptionPrompt` left
  // every test in this file, all 35 in `orchestrator.test.ts` and all 20 in the
  // harness green:
  //
  //   · deleting `  poster=<leg-N-poster.webp>  instant first paint` outright —
  //     both `/leg-1-poster\.webp/` assertions are satisfied by the per-leg
  //     LIST above the block, so the instruction that produces instant first
  //     paint was deletable with nothing red;
  //   · dropping `preload paused` from the <video> attributes AND reversing the
  //     fetch->blob direction into `blob: URL <- fetch(mp4)` — `/fetch/` and
  //     `/blob:/` are presence-only and order-blind, and no assertion mentions
  //     `preload` or `paused` at all. The arrow direction is the one step §7.6.4
  //     explains: "the fetch->blob step is what makes seeking instant".
  //
  // A prompt is not a set of tokens; it is an instruction an agent follows in
  // order. So the whole block is pinned as one substring, and any deletion,
  // reordering or rewording of those four lines fails HERE.
  const p = videoConsumptionPrompt([
    {
      index: 1,
      still: "/ws/design-refs/01.png",
      section: "descent",
      aspect: "16:9",
      out: "/ws/assets/world/leg-1.mp4",
      poster: "/ws/assets/world/leg-1-poster.webp",
    },
  ]);
  assert.ok(
    p.includes(PATTERN_BLOCK),
    `the §7.6.4 block is not present verbatim. Prompt was:\n${p}`,
  );
  // AND THE PATTERN COMES AFTER THE PATHS. The block names `leg-N`; the list
  // names leg 1. Read in the other order the placeholder has nothing to bind to.
  assert.ok(
    p.indexOf("/ws/assets/world/leg-1.mp4") < p.indexOf(PATTERN_BLOCK),
    "the concrete paths precede the pattern that refers to them",
  );
});

test("A LEG THAT FAILED IS NOT ADVERTISED — a 404 in a prompt is worse than a shorter prompt", async () => {
  // `LegRunSummary` counts produced legs; it does not say WHICH. Handing the
  // build agent every PLANNED path wires a world layer around a file that was
  // never written, and the page ships blank exactly where the video was.
  const { d, written } = deps({
    spawnLeg: async (leg) =>
      leg.index === 1 ? { ok: false, detail: "exit 4: truncated download" } : { ok: true, detail: "" },
  });
  const { prompt, record } = await runVideoLane(d);
  assert.equal(record?.legsAttempted, 2);
  assert.equal(record?.legsProduced, 1);
  assert.ok(!prompt.includes("leg-1.mp4"), "the leg that failed is absent from the prompt");
  assert.match(prompt, /leg-2\.mp4/u, "and the one that landed is still handed over");
  assert.match(written[0] ?? "", /truncated/u, "the failure is recorded even though it is not advertised");
});

test("A RUN THAT ALREADY SPENT DOES NOT SPEND AGAIN — resume is not a second cap", async () => {
  // `#buildPhase` is re-entered by `resume`: a rate-limited BUILD segment comes
  // back with its session intact and `nextBuildSegment` hands the same segment
  // over on the next entry. Without this, §7.6.3.2's "at most 2 video legs per
  // RUN" quietly becomes "at most 2 per attempt", with both of Task 7's
  // enforcement points still holding and still counting the wrong thing.
  const { d, spawned, written } = deps({
    fileExists: (p) => p === "/runs/r1/results/video.json" || p.endsWith("leg-1.mp4"),
  });
  const { record, prompt } = await runVideoLane(d);
  assert.equal(spawned.length, 0, "not one leg — this run has a video record already");
  assert.equal(written.length, 0, "and the record it wrote the first time is not overwritten");
  assert.equal(record, null, "a zero-spend record would read as 'this run spent nothing'");
  assert.match(prompt, /leg-1\.mp4/u, "the leg that survived is still handed to the build agents");
  assert.ok(!prompt.includes("leg-2.mp4"), "and the one that is not on disk is not");
});

test("THE MANIFEST THIS PROGRAM WRITES SAYS `refs`, AND THE PLANNER READS `sections`", () => {
  // `design-manifest.ts:26-33` flags this in as many words. Both sides' unit
  // tests are green: the planner's feed it `{sections:[…]}`, and the manifest
  // module's never call the planner. Against the only writer that exists, the
  // unadapted read yields zero legs — a silent zero, forever.
  const dir = mkdtempSync(join(tmpdir(), "video-lane-manifest-"));
  try {
    const refsDir = join(dir, "design-refs");
    mkdirSync(refsDir, { recursive: true });
    const refs = [1, 2, 3].map((n) => {
      const path = join(refsDir, `0${String(n)}-section.png`);
      writeFileSync(path, "not really a png", "utf8");
      return { path, section: `section-${String(n)}`, aspect: "16:9" as const, intent: "x", animate: true };
    });
    writeDesignManifest(dir, {
      version: 1,
      refs,
      lockedMockup: null,
      lockedBy: null,
      lockedReason: null,
      lockedAt: null,
    });

    const onDisk = readDesignManifest(dir);
    assert.notEqual(onDisk, null, "the fixture is a manifest this program can read back");

    const adapted = planVideoLegs(legPlannerInput(onDisk), dir, resolveLegCap({}));
    assert.equal(adapted.legs.length, 2, "three animate refs, capped at two");
    assert.equal(adapted.legs[0]?.section, "section-1");

    // THE NEGATIVE CONTROL: the plan's own wiring, handing the planner the
    // manifest object itself. This is the line the whole test exists for.
    const unadapted = planVideoLegs(onDisk, dir, resolveLegCap({}));
    assert.equal(
      unadapted.legs.length,
      0,
      "without the adapter the lane is inert against every real manifest, and reports 'degraded'",
    );
    assert.equal(unadapted.rejected.length, 0, "and it does not even report a rejection — it sees nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
