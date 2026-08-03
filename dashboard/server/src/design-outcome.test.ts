/**
 * design-outcome.test.ts — THE TRAP, and the one control in this phase that is
 * mandatory rather than advisory.
 *
 * THE UNIT TESTS BELOW CANNOT PROVE THE THING THIS FILE EXISTS TO PROVE. Every
 * one of them hands `classifyDesignLane` a `pngCount` it made up; a classifier
 * that agrees with its own fixtures is exactly the defect this phase is built to
 * avoid. So the last two tests run the lane FOR REAL against a stub script —
 * once broken, once working, through the same harness, differing only in the
 * script's body — and assert the broken arm is loud in every place this task can
 * reach: the `DesignLaneRecord`, `results/design-lane.json` on disk, the failure
 * message the orchestrator logs, and the script's own stderr.
 *
 * WHAT THE EXECUTED ARM DOES NOT COVER, said here rather than implied by its
 * absence: the orchestrator calling any of this (Task 10 owns `#buildPhase`, and
 * `orchestrator.ts` contains the string "design" nowhere as this was written),
 * and a real agent actually running the command the prompt names. The arm covers
 * every hop between `DASHBOARD_GEMINI_IMAGE_SCRIPT` and the JSON on disk.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DESIGN_SCRIPT_ENV,
  canWriteDir,
  designPreflight,
  designScriptPath,
  detectDesignCapability,
  type PreflightCheck,
} from "./design-capability.js";
import { designLaneMode, type DesignLaneMode } from "./design-lane.js";
import {
  countDesignPngs,
  parseDesignManifest,
  readDesignManifest,
  refsDirFor,
  refsForDirection,
  type DesignManifest,
} from "./design-manifest.js";
import {
  DESIGN_CANVASS_SECTIONS,
  DESIGN_DIRECTION_COUNT,
  MIN_CANVASS_REFS,
  MIN_DESIGN_REFS,
  designSegmentPrompt,
} from "./design-prompt.js";
import {
  DESIGN_LANE_RECORD_FILE,
  classifyDesignLane,
  designLaneFailureMessage,
  readDesignLaneRecord,
  writeDesignLaneRecord,
  type DesignLaneRecord,
} from "./design-outcome.js";

const WS = "/runs/r1/workspace";
const OK_PREFLIGHT: readonly PreflightCheck[] = [
  { id: "python3", ok: true, blocking: true, detail: "python3 is on PATH" },
];

function manifestWith(count: number): DesignManifest {
  return {
    version: 1,
    refs: Array.from({ length: count }, (_unused, index) => ({
      path: `${WS}/design-refs/0${String(index + 1)}.png`,
      section: `s${String(index + 1)}`,
      aspect: "16:9" as const,
      intent: "x",
      direction: null,
      origin: null,
    })),
    directions: [],
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: null,
    lockedBy: null,
    lockedReason: null,
    lockedAt: null,
  };
}

function classify(over: Partial<Parameters<typeof classifyDesignLane>[0]> = {}): DesignLaneRecord {
  return classifyDesignLane({
    mode: "full",
    manifest: manifestWith(5),
    pngCount: 5,
    imageCalls: 6,
    keySource: "GEMINI_API_KEY",
    preflight: OK_PREFLIGHT,
    ...over,
  });
}

test("THE TRAP: a FULL lane with zero images is a NAMED FAILURE, not a quiet success", () => {
  const record = classify({ manifest: null, pngCount: 0, imageCalls: 3 });
  assert.equal(record.failure, "no-images");
  const message = designLaneFailureMessage(record);
  assert.ok(message !== null, "a zero-image full lane MUST produce a message");
  assert.match(message, /DESIGN/);
  assert.match(message, /no images/i);
  assert.match(message, /3 generation/i, "the attempts are named — they are the evidence it tried");
});

test("THE TRAP: a DEGRADED lane with zero images is NOT a failure — and the two never collapse", () => {
  // Same file count, opposite meaning. If these ever return the same record, a
  // broken image chain becomes indistinguishable from a machine with no key.
  const degraded = classify({ mode: "degraded", manifest: null, pngCount: 0, imageCalls: 0 });
  assert.equal(degraded.failure, null);
  assert.equal(designLaneFailureMessage(degraded), null);
  assert.ok(degraded.degradeReason !== null, "a degraded lane always says WHY it degraded");

  const broken = classify({ manifest: null, pngCount: 0, imageCalls: 3 });
  assert.notEqual(degraded.failure, broken.failure);
});

test("A LANE THAT NEVER CALLED THE SCRIPT AND ONE THAT CALLED IT FIVE TIMES DO NOT RENDER ALIKE", () => {
  // Both are `no-images` — the union is what Tasks 10 and 11 render and widening
  // it is a signature they cannot call — but they are different faults and point
  // at different places. Five failed calls is a broken image chain: read the
  // script's stderr. Zero calls is a lane that never reached the tool at all: a
  // prompt the agent did not follow, a segment that ended early, or a shortlist
  // with no DESIGN agent in it. A single sentence covering both sends whoever
  // reads it at 3am to the wrong log.
  const never = classify({ manifest: null, pngCount: 0, imageCalls: 0 });
  const tried = classify({ manifest: null, pngCount: 0, imageCalls: 5 });
  assert.equal(never.failure, "no-images");
  assert.equal(tried.failure, "no-images");
  assert.notEqual(never.detail, tried.detail);
  assert.match(never.detail, /never invoked/i, "the zero-call case names itself");
  assert.match(String(designLaneFailureMessage(tried)), /5 generation attempt/);
});

test("fewer than five images is its own failure — a partial set is not a set", () => {
  const record = classify({ manifest: manifestWith(2), pngCount: 2 });
  assert.equal(record.failure, "too-few-images");
  assert.match(String(designLaneFailureMessage(record)), /2 of 5/);
});

test("a manifest that NAMES fewer refs than the disk holds is too-few, not a pass", () => {
  // DEVIATION FROM THE PLAN, RECORDED IN THE FILE THAT NEEDS IT. The plan's
  // `manifest-invalid` fires only when refs OUTNUMBER files. The other direction
  // — seven PNGs on disk, three named — passes the file count and still hands
  // the build a three-section design, because `designHandoffSection` iterates
  // `refs` and never reads the directory. The loud case would be the quiet one.
  const record = classify({ manifest: manifestWith(3), pngCount: 7 });
  assert.equal(record.failure, "too-few-images");
  assert.match(record.detail, /3 of 5/);
  assert.match(record.detail, /7 file/, "the discrepancy is kept, not smoothed over");
});

test("images on disk with no manifest is a failure — nothing downstream can read them", () => {
  // §7.3 mechanism 2 reads manifest.json. Five PNGs no prompt names might as well
  // not exist.
  const record = classify({ manifest: null, pngCount: 5 });
  assert.equal(record.failure, "no-manifest");
});

test("a manifest that claims more refs than exist on disk is INVALID, not trusted", () => {
  const record = classify({ manifest: manifestWith(5), pngCount: 3 });
  assert.equal(record.failure, "manifest-invalid");
  assert.match(String(designLaneFailureMessage(record)), /3 file/);
});

test("an OFF lane claims nothing at all", () => {
  const record = classify({ mode: "off", manifest: null, pngCount: 0, imageCalls: 0 });
  assert.equal(record.failure, null);
  assert.equal(record.degradeReason, null);
  assert.equal(designLaneFailureMessage(record), null);
});

test("the happy path is silent", () => {
  assert.equal(classify().failure, null);
  assert.equal(designLaneFailureMessage(classify()), null);
});

test("SPEND IS A COUNT, NEVER A DOLLAR FIGURE", () => {
  // The DESIGN lane spends real money through a key read from ~/.gemini/api_key,
  // and nothing in this program knows the price. costUsd stays null for the run;
  // design spend is a call count and a model name, on its own line.
  //
  // SCOPED TO THE RECORD'S OWN KEYS, not to its serialised text: a preflight
  // detail or a degrade reason may legitimately contain the word "cost", and a
  // test that went red for that would be red for the wrong reason and get
  // loosened by whoever hit it.
  const record = classify({ imageCalls: 7 });
  assert.equal(record.imageCalls, 7);
  for (const key of Object.keys(record)) {
    assert.doesNotMatch(key, /usd|cost|dollar|price/i, `${key} looks like money`);
  }
});

test("the record carries the key SOURCE and never anything key-shaped", () => {
  const json = JSON.stringify(classify({ keySource: "~/.gemini/api_key" }));
  assert.match(json, /~\/\.gemini\/api_key/);
  assert.doesNotMatch(json, /sk-/);
});

test("the record round-trips through disk — an unattended run is explained after the fact", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-record-"));
  const record = classify({ manifest: null, pngCount: 0, imageCalls: 3 });
  writeDesignLaneRecord(dir, record);
  assert.deepEqual(readDesignLaneRecord(dir), record);
  assert.equal(readDesignLaneRecord(mkdtempSync(join(tmpdir(), "design-empty-"))), null);
});

test("DESIGN_SCRIPT_ENV resolves the way production resolves it", () => {
  // The override exists so THE CONTROL below can run without overwriting the
  // owner's ~/.claude/scripts/gemini-image.sh. It is also the only reason a
  // wrong resolution here would be visible at all: the agent body reaches the
  // script by absolute path, so no PATH shim intercepts it.
  const home = "/home/somebody";
  const real = join(home, ".claude", "scripts", "gemini-image.sh");
  assert.equal(designScriptPath({}, home), real);
  assert.equal(designScriptPath({ [DESIGN_SCRIPT_ENV]: "/tmp/stub.sh" }, home), "/tmp/stub.sh");
  assert.equal(designScriptPath({ [DESIGN_SCRIPT_ENV]: "   " }, home), real, "a blank override is not an override");
});

/* ---- THE EXECUTED CONTROL --------------------------------------------------
 *
 * Two arms, ONE harness. The failure arm and the positive arm differ in exactly
 * one thing — the body of the stub script — because an arm that took a different
 * code path would not be a control, just a second test that happens to be green.
 *
 * The script path is resolved the way production resolves it:
 *   env[DASHBOARD_GEMINI_IMAGE_SCRIPT] → designScriptPath() →
 *   detectDesignCapability({ imageScript }) → capability.imageScript
 * and the same value is asserted to appear in `designSegmentPrompt`, which is
 * the only channel that tells an agent what to run. A wrong resolution turns
 * this red rather than quietly sending a real run at the owner's real script.
 */

const BROKEN_STUB = `#!/usr/bin/env bash
# Stands in for ~/.claude/scripts/gemini-image.sh with the chain broken. A missing
# python3, an unresolvable key, a sandbox-denied mktemp and a 4xx through the whole
# fallback model chain are all THIS from the host's side: a non-zero exit and a
# line on a stream the permission layer never sees.
echo "gemini-image: simulated failure — no API key" >&2
exit 1
`;

const WORKING_STUB = `#!/usr/bin/env bash
# The same script, working. It honours -o, writes a file whose first eight bytes
# are the PNG signature, and prints the output path — the real script's entire
# success contract.
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -a|-i|-m) shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$out" ]; then echo "gemini-image: no -o given" >&2; exit 1; fi
mkdir -p "$(dirname "$out")"
printf '\\211PNG\\r\\n\\032\\n' > "$out"
echo "$out"
`;

interface LaneArm {
  readonly mode: DesignLaneMode;
  readonly record: DesignLaneRecord;
  readonly stderr: string;
  readonly onDisk: string;
  readonly prompt: string;
  readonly scriptPath: string;
  readonly refsDir: string;
  readonly keySentinel: string;
}

async function spawnScript(script: string, args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(script, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      resolve({ code: 127, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

async function runDesignLaneAgainstStub(stub: string): Promise<LaneArm> {
  const home = mkdtempSync(join(tmpdir(), "design-arm-home-"));
  const keySentinel = "sk-STUB-SENTINEL-NOT-A-REAL-KEY";
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "api_key"), `${keySentinel}\n`, "utf8");

  const scriptPath = join(home, "stub-gemini-image.sh");
  writeFileSync(scriptPath, stub, "utf8");
  chmodSync(scriptPath, 0o755);

  const root = mkdtempSync(join(tmpdir(), "design-arm-run-"));
  const workspace = join(root, "workspace");
  const results = join(root, "results");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(results, { recursive: true });

  const env: NodeJS.ProcessEnv = { [DESIGN_SCRIPT_ENV]: scriptPath };
  const capability = detectDesignCapability({ env, homeDir: home, imageScript: designScriptPath(env, home) });
  const resolved = capability.imageScript ?? "<the override did not resolve>";
  assert.equal(resolved, scriptPath, "the override is what detectDesignCapability resolved");

  const preflight = await designPreflight({
    env,
    homeDir: home,
    workspace,
    capability,
    // Canned so the arm does not depend on this machine's PATH or on a registry
    // fetch. What is NOT canned is everything the trap turns on: the script, the
    // key, the manifest and the file count.
    run: async () => ({ code: 0, stderr: "" }),
    canWrite: canWriteDir,
  });
  const ticketText = "a portfolio landing page";
  const mode = designLaneMode({ surface: "web-ui", ticketText, capability, preflightOk: preflight.ok });
  const prompt = designSegmentPrompt({ ticketText, workspace, mode, capability, autoChoose: true, stage: "canvass", chosen: null });

  // ---- what the DESIGN agent does: sequential generation, then a manifest ----
  const refsDir = refsDirFor(workspace);
  const outputs: string[] = [];
  let imageCalls = 0;
  let stderr = "";
  let previous: string | null = null;
  for (let index = 0; index < MIN_DESIGN_REFS; index += 1) {
    const out = join(refsDir, `0${String(index + 1)}-section.png`);
    const args = [
      `art-directed prompt for section ${String(index + 1)}`,
      "-a",
      "16:9",
      "-o",
      out,
      ...(previous === null ? [] : ["-i", previous]),
    ];
    // Counted the way the orchestrator counts it: attempts, from the `tool` sink,
    // incremented per invocation regardless of what the invocation returns.
    imageCalls += 1;
    const result = await spawnScript(resolved, args);
    stderr += result.stderr;
    if (result.code === 0 && existsSync(out)) {
      outputs.push(out);
      previous = out;
    }
  }
  // An honest agent manifests what it actually produced. In the broken arm that
  // is an empty ref list — which is deliberately NOT the same as writing no
  // manifest at all, because zero PNGs must be `no-images` either way.
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(
    join(refsDir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        refs: outputs.map((path, index) => ({
          path,
          section: `section-${String(index + 1)}`,
          aspect: "16:9",
          // NO `direction` AND NO `origin`, deliberately: this stub writes the
          // manifest an agent wrote before 2026-08-03, and the lane must classify
          // it exactly as it always did.
          intent: "what this image is for",
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  // ---- what the host does ---------------------------------------------------
  const manifest = readDesignManifest(workspace);
  const record = classifyDesignLane({
    mode,
    manifest,
    pngCount: countDesignPngs(refsDir),
    imageCalls,
    keySource: capability.key.source,
    preflight: preflight.checks,
  });
  writeDesignLaneRecord(results, record);
  return {
    mode,
    record,
    stderr,
    onDisk: readFileSync(join(results, DESIGN_LANE_RECORD_FILE), "utf8"),
    prompt,
    scriptPath,
    refsDir,
    keySentinel,
  };
}

test("THE NEGATIVE CONTROL, EXECUTED: a FULL lane with a broken image script is loud", async () => {
  const arm = await runDesignLaneAgainstStub(BROKEN_STUB);

  // The mode is decided BEFORE the lane runs, and this is the arm the whole
  // phase turns on: script present, key resolves, preflight clean — so `full`.
  // A zero-image `full` lane and a zero-image `degraded` lane are the same
  // directory listing and the opposite conclusion.
  assert.equal(arm.mode, "full", "this is not a degraded lane; the chain was available and failed");
  assert.equal(arm.record.images, 0);
  assert.equal(arm.record.imageCalls, MIN_DESIGN_REFS, "it tried, and the count is the evidence");
  assert.equal(arm.record.failure, "no-images");
  assert.equal(arm.record.degradeReason, null, "nothing about this run was expected");
  assert.match(String(designLaneFailureMessage(arm.record)), /DESIGN LANE FAILED \(no-images\)/);

  // results/design-lane.json, on disk, as an operator would read it.
  assert.match(arm.onDisk, /"failure": "no-images"/);
  assert.match(arm.onDisk, /"imageCalls": 5/);
  assert.match(arm.onDisk, /"mode": "full"/);
  assert.equal(arm.record.locked, null, "a failed lane never carries a fabricated path");
  assert.doesNotMatch(arm.onDisk, new RegExp(arm.keySentinel), "the record never carries the key");

  // The script's own stderr existed. This task cannot write the build log — the
  // orchestrator owns it — so this is the honest partial for that row.
  assert.match(arm.stderr, /gemini-image: simulated failure/);

  // §7.3's channel: the path the host resolved is the path the agent is told to
  // run. Without this the override could resolve correctly and never be used.
  assert.ok(arm.prompt.includes(arm.scriptPath), "the resolved script path reaches the prompt");
});

test("THE POSITIVE ARM: the same harness with a working script reports nothing", async () => {
  // Without this arm, "the lane reported a failure" could simply mean the
  // detector reports a failure for everything.
  const arm = await runDesignLaneAgainstStub(WORKING_STUB);
  assert.equal(arm.mode, "full");
  assert.equal(arm.record.images, MIN_DESIGN_REFS);
  assert.equal(arm.record.imageCalls, MIN_DESIGN_REFS);
  assert.equal(arm.record.failure, null);
  assert.equal(designLaneFailureMessage(arm.record), null);
  assert.match(arm.onDisk, /"failure": null/);
  assert.equal(arm.stderr, "");
  const first = readFileSync(join(arm.refsDir, "01-section.png"));
  assert.deepEqual(
    [...first.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "the stub wrote a real PNG signature through -o, so the count is counting files it made",
  );
});

/* ══ THE TWO STAGE FLOORS, AND THE REF THAT BELONGS NOWHERE (2026-08-03) ═══ */

function directionsManifest(over: { refs?: number; declared?: readonly string[]; refDirection?: string | null } = {}): DesignManifest {
  const declared = over.declared ?? ["editorial-slab", "quiet-grid", "warm-stack"];
  const count = over.refs ?? 6;
  return {
    version: 1,
    refs: Array.from({ length: count }, (_unused, index) => ({
      path: `${WS}/design-refs/r${String(index + 1)}.png`,
      // THE SECTION IS THE ROUND, NOT THE INDEX, and the fixture was wrong about
      // this until 2026-08-03: `s${index + 1}` gave every ref a section of its
      // own, so the six-still canvass below was three directions rendering three
      // DIFFERENT pairs of sections — the exact shape `auditCanvass` now fails.
      // A fixture that a healthy-canvass assertion could not survive was the
      // fixture agreeing with the defect.
      section: `s${String(Math.floor(index / declared.length) + 1)}`,
      aspect: "16:9" as const,
      intent: "x",
      direction:
        over.refDirection === undefined ? (declared[index % declared.length] ?? null) : over.refDirection,
      origin: "canvass" as const,
    })),
    directions: declared.map((slug) => ({ slug, name: slug, distinction: "d", notes: null })),
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: null,
    lockedBy: null,
    lockedReason: null,
    lockedAt: null,
  };
}

test("THE STAGE DECIDES THE FLOOR — a canvass owes six, an expansion owes five", () => {
  // Six passes five ONLY BY LUCK today: move DESIGN_DIRECTION_COUNT to two, or
  // DESIGN_CANVASS_SECTIONS to one, and a perfectly healthy canvass would report
  // `too-few-images` against a floor that belongs to the other stage.
  const healthy = classify({ manifest: directionsManifest({ refs: 6 }), pngCount: 6, floor: MIN_CANVASS_REFS });
  assert.equal(healthy.failure, null);

  const short = classify({ manifest: directionsManifest({ refs: 5 }), pngCount: 5, floor: MIN_CANVASS_REFS });
  assert.equal(short.failure, "too-few-images", "five stills is a canvass a direction is missing from");
  assert.match(short.detail, new RegExp(`5 of ${String(MIN_CANVASS_REFS)}`));

  // THE SAME SET, GRADED AS AN EXPANSION, PASSES — which is what makes the floor
  // an input rather than a constant this file happens to import.
  //
  // ON A DIRECTIONLESS MANIFEST, DELIBERATELY. A five-still CANVASS is short a
  // direction by the per-direction floor as well as by the total, so grading one
  // at the expansion's floor would be answered by the stage-A check rather than
  // by the floor this pair is about — and the pair would then prove nothing
  // about the floor being an input. `manifestWith` has no directions, so stage
  // A's checks are gated off and the floor is the only thing that can speak.
  assert.equal(classify({ manifest: manifestWith(5), pngCount: 5 }).failure, null);
  assert.match(
    String(designLaneFailureMessage(classify({ manifest: manifestWith(5), pngCount: 5, floor: MIN_CANVASS_REFS }))),
    new RegExp(`5 of ${String(MIN_CANVASS_REFS)}`),
    "the same set, the other floor, the other answer",
  );
  assert.match(
    String(designLaneFailureMessage(classify({ manifest: manifestWith(4), pngCount: 4 }))),
    new RegExp(`4 of ${String(MIN_DESIGN_REFS)}`),
    "the default is unchanged, so every pre-2026-08-03 caller keeps its meaning",
  );
});

/**
 * A STAGE-B MANIFEST, BUILT THROUGH THE REAL PARSER.
 *
 * Through `parseDesignManifest` rather than as a literal on purpose: `readOrigin`
 * defaults an ABSENT `origin` to `"canvass"` when directions are present, and the
 * `marked: false` arm below exists to hold the floor honest against exactly that
 * default. A hand-built literal would let this file assert a shape the parser
 * never produces.
 *
 * `requested` stills are the previews the owner asked for while he was choosing —
 * they are in `refs`, they are on disk, and they are not stills of any stage.
 */
function expandedManifest(over: {
  expansion?: number;
  requested?: number;
  marked?: boolean;
  /** The lane overwrote `chosenDirection`, so the parser dropped it. See FINDING K. */
  clobbered?: boolean;
}): DesignManifest {
  const declared = ["editorial-slab", "quiet-grid", "warm-stack"];
  const chosen = "warm-stack";
  const expansion = over.expansion ?? 0;
  const requested = over.requested ?? 0;
  const ref = (path: string, section: string, direction: string, origin: string | null): Record<string, unknown> => ({
    path: `${WS}/design-refs/${path}`,
    section,
    aspect: "16:9",
    intent: "x",
    direction,
    ...(origin === null ? {} : { origin }),
  });
  const manifest = parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: declared.map((slug) => ({ slug, name: slug, distinction: "d", notes: null })),
      // THE PAIR, OR NEITHER OF THEM. `parseDesignManifest` drops a chosen slug
      // that arrives without its provenance, so a lane that rewrote either field
      // produces the `clobbered` shape — which is what the host then reads back.
      ...(over.clobbered === true
        ? {}
        : {
            chosenDirection: chosen,
            directionChoice: { by: "owner", reason: "he picked the stack", at: "2026-08-03T10:00:00.000Z" },
          }),
      refs: [
        // THE CANVASS: DESIGN_CANVASS_SECTIONS stills per direction, all three.
        ...declared.flatMap((slug) => [
          ref(`${slug}-01-hero.png`, "hero", slug, "canvass"),
          ref(`${slug}-02-work.png`, "work", slug, "canvass"),
        ]),
        ...Array.from({ length: requested }, (_unused, index) =>
          ref(`${chosen}-req-0${String(index + 1)}-pricing.png`, "pricing", chosen, "requested"),
        ),
        ...Array.from({ length: expansion }, (_unused, index) =>
          // `marked: false` OMITS THE FIELD, which is what a lane that ignored the
          // template's `"origin": "expansion"` writes — and it parses to "canvass".
          ref(`${chosen}-0${String(index + 3)}-section.png`, `s${String(index + 3)}`, chosen, over.marked === false ? null : "expansion"),
        ),
      ],
    }),
    WS,
  );
  assert.ok(manifest !== null, "the fixture itself must parse");
  return manifest;
}

test("THE EXPANSION CANNOT SILENTLY NOT HAPPEN — the floor counts THIS stage, not the directory", () => {
  /*
   * THE SCENARIO: the expand segment comes back having generated NOTHING — a rate
   * limit, a refusal, a lane that misread the brief. The canvass stills and the
   * previews the owner asked for while choosing are all still on disk and all
   * still in `refs`, so the cumulative counts clear a floor of five without a
   * single still of the stage that owed them. `heroRefFor` then returns the
   * direction's CANVASS hero, the lock lands on it, and a whole multi-section site
   * is built and graded against one 2-section canvass still with nothing in the
   * record saying the expansion did not happen.
   */
  const nothing = classify({ manifest: expandedManifest({ expansion: 0, requested: 3 }), pngCount: 9 });
  assert.equal(nothing.failure, "too-few-images", "nine files and nine named refs, and the stage produced none of them");
  assert.match(nothing.detail, new RegExp(`2 of ${String(MIN_DESIGN_REFS)}`), "the chosen direction's own set is what is short");
  assert.match(nothing.detail, /warm-stack/, "and it names WHICH direction, so the fault is actionable");
  assert.match(nothing.detail, /9 file/, "the directory total is kept, not smoothed over");

  // THE POSITIVE HALF. Three new stills take the chosen direction's set to five,
  // which is what `expandBrief` asks for ("at least 5 PNGs for the direction",
  // its two canvass stills included) — and a floor that fires here would be a
  // failure manufactured out of a healthy expansion.
  const expanded = classify({ manifest: expandedManifest({ expansion: 3, requested: 3 }), pngCount: 12 });
  assert.equal(expanded.failure, null);

  // THE CANVASS IS GRADED ACROSS DIRECTIONS, not per chosen one: the same six
  // canvass stills with no choice yet are a complete stage A.
  const canvass = classify({ manifest: directionsManifest({ refs: 6 }), pngCount: 6, floor: MIN_CANVASS_REFS });
  assert.equal(canvass.failure, null);
});

test("A MISSING `origin` IS NOT A MISSING EXPANSION — the stage count is the direction's SET", () => {
  /*
   * THE TEST THAT PINS THE PREDICATE, AND IT IS ITS OWN TEST so that tightening
   * the count to `origin === "expansion"` goes red HERE rather than behind
   * another assertion in another test.
   *
   * `readOrigin` defaults an ABSENT `origin` to "canvass" when directions are
   * present, so three expansion stills written without the field are three
   * canvass-marked stills of the chosen direction. `expandBrief` asks for "at
   * least MIN_DESIGN_REFS PNGs for the direction", its two canvass stills
   * included — so the direction's SET is what the floor meets. Counting only
   * `origin === "expansion"` would fail a lane that generated every image it was
   * asked for, and would make `readOrigin`'s own comment ("the worst this can get
   * wrong … changes nothing downstream") false.
   */
  const unmarked = classify({ manifest: expandedManifest({ expansion: 3, marked: false }), pngCount: 9 });
  assert.equal(unmarked.failure, null, "a missing `origin` is not a missing expansion");

  // AND THE SET IS STILL SHORT WHEN IT IS SHORT: two of the three unmarked stills
  // is a four-still direction, whatever the field says. Without this half the
  // assertion above would pass on a count that never fires.
  const short = classify({ manifest: expandedManifest({ expansion: 2, marked: false }), pngCount: 8 });
  assert.equal(short.failure, "too-few-images");
  assert.match(short.detail, new RegExp(`4 of ${String(MIN_DESIGN_REFS)}`));
  assert.match(short.detail, /0 of them marked/, "and the record says how many carry the expansion mark");
});

test("A REF WHOSE DIRECTION DOES NOT RESOLVE IS `manifest-invalid` AND NAMES THE SLUG", () => {
  // The observable it prevents: `heroRefFor` returns null, so the chosen
  // direction locks nothing and the gate grades against the rule-based floor —
  // which looks EXACTLY like a degraded run, on a machine that generated every
  // image it was asked for.
  const stray = directionsManifest({ refs: 6 });
  const invalid = classify({
    // MAPPED RATHER THAN INDEXED. The sixth ref used to be reached by index and
    // silenced with a non-null assertion — on a fixture this file builds, which is
    // the one place the compiler could have caught `directionsManifest` no longer
    // producing six refs. The map needs no assertion and cannot go out of bounds.
    manifest: {
      ...stray,
      refs: stray.refs.map((ref, index) => (index === 5 ? { ...ref, direction: "never-declared" } : ref)),
    },
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(invalid.failure, "manifest-invalid", "and the union is NOT widened — the client switches on it");
  assert.match(invalid.detail, /never-declared/, "the slug is named, so the fault is actionable");

  // THE OTHER SHAPE: a manifest that HAS directions and a ref naming none.
  const naked = classify({
    manifest: directionsManifest({ refs: 6, refDirection: null }),
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(naked.failure, "manifest-invalid");
  assert.match(naked.detail, /<none>/);

  // AND A PRE-2026-08-03 MANIFEST CANNOT REACH THIS BRANCH AT ALL: it has no
  // directions, so `unresolvedDirectionRefs` is gated off and the lane classifies
  // exactly as it always did.
  assert.equal(classify({ manifest: manifestWith(5), pngCount: 5 }).failure, null);
});

/* ══ STAGE A IS A SHAPE, NOT A TOTAL (2026-08-03) ══════════════════════════
 *
 * `MIN_CANVASS_REFS` is DESIGN_DIRECTION_COUNT × DESIGN_CANVASS_SECTIONS and was
 * compared against the canvass's TOTAL and nothing else, so six stills of ONE
 * direction cleared stage A. The tests below are the two halves of that hole —
 * the per-direction floor and the comparability the canvass exists for — and each
 * one was watched failing against the pre-fix classifier before the check existed.
 */

interface CanvassSpec {
  readonly slug: string;
  /** One still per entry, in this order. REPEATS ARE DELIBERATE where they appear. */
  readonly sections: readonly string[];
  /** Defaults to 16:9, the same for every direction. */
  readonly aspect?: string;
}

/**
 * A CANVASS BUILT DIRECTION BY DIRECTION, through the real parser.
 *
 * `chosen` moves the same file from stage A to stage B, which is how the two
 * stages are compared against ONE set of stills rather than against two fixtures
 * that could drift apart.
 */
function canvassOf(directions: readonly CanvassSpec[], chosen?: string): DesignManifest {
  const manifest = parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: directions.map((entry) => ({ slug: entry.slug, name: entry.slug, distinction: "d", notes: null })),
      ...(chosen === undefined
        ? {}
        : {
            chosenDirection: chosen,
            directionChoice: { by: "owner", reason: "he picked it", at: "2026-08-03T10:00:00.000Z" },
          }),
      refs: directions.flatMap((entry) =>
        entry.sections.map((section, index) => ({
          path: `${WS}/design-refs/${entry.slug}-0${String(index + 1)}-${section}.png`,
          section,
          aspect: entry.aspect ?? "16:9",
          intent: "x",
          direction: entry.slug,
          origin: "canvass",
        })),
      ),
    }),
    WS,
  );
  assert.ok(manifest !== null, "the fixture itself must parse");
  return manifest;
}

/** The canvass the brief asks for: three directions, the same two sections, one aspect. */
const WELL_FORMED: readonly CanvassSpec[] = [
  { slug: "editorial-slab", sections: ["hero", "work"] },
  { slug: "quiet-grid", sections: ["hero", "work"] },
  { slug: "warm-stack", sections: ["hero", "work"] },
];

test("A LOPSIDED CANVASS IS NOT A CANVASS — every direction owes stills, and the short ones are NAMED", () => {
  /*
   * THE SCENARIO, AND IT IS REACHABLE: the lane renders six stills for its
   * favourite direction and none for the other two. The total floor of six is
   * met, `unresolvedDirectionRefs` is empty (every ref names a declared slug),
   * and before this check stage A passed — offering the owner a "choice" of one
   * direction and two empty cards.
   */
  const lopsided: readonly CanvassSpec[] = [
    { slug: "editorial-slab", sections: ["hero", "work", "about", "contact", "footer", "services"] },
    { slug: "quiet-grid", sections: [] },
    { slug: "warm-stack", sections: [] },
  ];
  const stageA = classify({ manifest: canvassOf(lopsided), pngCount: 6, floor: MIN_CANVASS_REFS });
  assert.equal(stageA.failure, "too-few-images", "six stills of one direction is not a six-still canvass");
  assert.match(stageA.detail, /quiet-grid/, "the direction that came up short is named");
  assert.match(stageA.detail, /warm-stack/, "both of them");
  assert.doesNotMatch(stageA.detail, /editorial-slab/, "and the one that delivered is not accused");
  assert.match(stageA.detail, new RegExp(`0 of ${String(DESIGN_CANVASS_SECTIONS)}`), "with the count it owed");

  /*
   * WHY THE FLOOR BELONGS AT STAGE A AND CANNOT BE MOVED TO STAGE B. Choose the
   * fat direction and stage B's floor of five reads SIX — the canvass stills of
   * one direction — and passes an expansion that produced nothing. That is the
   * reviewer's scenario, and it is pinned here rather than argued: the assertion
   * below is the silence, and stage A is the only place that can prevent it.
   */
  const chosenFat = classify({ manifest: canvassOf(lopsided, "editorial-slab"), pngCount: 6 });
  assert.equal(chosenFat.failure, null, "stage B cannot see it: the direction's SET already meets the floor");
});

test("A CANVASS OF ONE DIRECTION IS NOT A CHOICE — the number of DIRECTIONS is checked, not just their stills", () => {
  /*
   * THE SAME HOLE FROM THE OTHER SIDE, and the per-direction floor alone does not
   * close it: a lane that DECLARES one direction and renders six comparable
   * sections of it satisfies the total (6 of 6), the per-direction floor (six
   * sections, one direction) and comparability (there is nothing to disagree
   * with). The owner is then shown a "choice" of one, the fallback picks the only
   * candidate, and stage B's floor of five reads six — a zero expansion, silent.
   * Starving two directions and never declaring them are the same run.
   */
  const alone = canvassOf([
    { slug: "editorial-slab", sections: ["hero", "work", "about", "contact", "footer", "services"] },
  ]);
  const stageA = classify({ manifest: alone, pngCount: 6, floor: MIN_CANVASS_REFS });
  assert.equal(stageA.failure, "too-few-images", "one direction is not a canvass, however many stills it holds");
  assert.match(stageA.detail, new RegExp(`1 of ${String(DESIGN_DIRECTION_COUNT)} direction`));
  assert.match(stageA.detail, /editorial-slab/, "and what it did offer is named");

  // TWO IS NOT THREE EITHER, and this arm is what keeps the check from being a
  // zero/non-zero test: two directions with three comparable sections each clears
  // the total of six and every other check here.
  const pair = classify({
    manifest: canvassOf([
      { slug: "editorial-slab", sections: ["hero", "work", "about"] },
      { slug: "quiet-grid", sections: ["hero", "work", "about"] },
    ]),
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(pair.failure, "too-few-images");
  assert.match(pair.detail, new RegExp(`2 of ${String(DESIGN_DIRECTION_COUNT)} direction`));

  // AND A PRE-2026-08-03 MANIFEST DECLARES NONE AND IS NOT A CANVASS AT ALL: the
  // check is gated on the audit, so a legacy run cannot be failed for having no
  // directions to count.
  assert.equal(classify({ manifest: manifestWith(6), pngCount: 6, floor: MIN_CANVASS_REFS }).failure, null);
});

test("THE CHAIN, END TO END: a canvass that clears stage A leaves two, and two is what stage B catches", () => {
  // NOT A FAILING-FIRST TEST — both halves passed before the per-direction floor
  // existed. It is the transitive claim the floor rests on, executed rather than
  // assumed: stage A now guarantees each direction carries at least
  // DESIGN_CANVASS_SECTIONS stills, so a chosen direction that expands into
  // nothing sits at 2 against MIN_DESIGN_REFS and is loud.
  assert.equal(classify({ manifest: canvassOf(WELL_FORMED), pngCount: 6, floor: MIN_CANVASS_REFS }).failure, null);

  const chosen = canvassOf(WELL_FORMED, "warm-stack");
  assert.equal(refsForDirection(chosen, "warm-stack").length, DESIGN_CANVASS_SECTIONS, "exactly what stage A owed");
  const stageB = classify({ manifest: chosen, pngCount: 6 });
  assert.equal(stageB.failure, "too-few-images", "a zero expansion on top of a well-formed canvass is loud");
  assert.match(stageB.detail, new RegExp(`2 of ${String(MIN_DESIGN_REFS)}`));

  /*
   * WHERE THE CHAIN STOPS, STATED RATHER THAN IMPLIED. Stage A's floor is a
   * MINIMUM, so a canvass that renders five comparable sections per direction —
   * against a brief that asks for two — clears stage A and hands stage B a chosen
   * direction that already meets its floor. A zero expansion is silent there.
   * Recorded, not fixed: the alternative is failing a lane for over-delivering,
   * and the only tighter stage-B count (`origin === "expansion"`) is the one
   * `expandBrief` contradicts.
   */
  const generous = canvassOf(
    WELL_FORMED.map((entry) => ({ ...entry, sections: ["hero", "work", "about", "contact", "footer"] })),
    "warm-stack",
  );
  assert.equal(classify({ manifest: generous, pngCount: 15 }).failure, null, "RESIDUAL, recorded in design-outcome.ts");
});

test("THREE DIRECTIONS RENDERING DIFFERENT SECTIONS ARE THREE PICTURES — the canvass fails and says which section is missing where", () => {
  // THE FEATURE'S CENTRAL CLAIM, and nothing checked it: "the SAME SECTIONS in
  // all three directions" was a sentence in a prompt. A request to a model is not
  // a feature. Six stills, three directions, two each — and the owner is
  // comparing direction 1's `work` against direction 3's `footer`.
  const incomparable = classify({
    manifest: canvassOf([
      { slug: "editorial-slab", sections: ["hero", "work"] },
      { slug: "quiet-grid", sections: ["hero", "work"] },
      { slug: "warm-stack", sections: ["hero", "footer"] },
    ]),
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(incomparable.failure, "manifest-invalid", "the union is NOT widened — the client switches on it");
  assert.match(incomparable.detail, /warm-stack/);
  assert.match(incomparable.detail, /work/, "the section it did not render");
  assert.match(incomparable.detail, /footer/, "and the one the other two did not");

  // THE POSITIVE HALF: the same six stills, comparable, pass.
  assert.equal(classify({ manifest: canvassOf(WELL_FORMED), pngCount: 6, floor: MIN_CANVASS_REFS }).failure, null);
});

test("TWO STILLS OF ONE SECTION ARE ONE SECTION — a direction that renders its hero twice is short", () => {
  // A COUNT ALONE WOULD PASS THIS. Six refs, two per direction, every ref naming
  // a declared slug: the per-direction floor is met on the number and not on the
  // thing the number stands for. What the owner sees is a card with the same
  // picture twice and no second section to compare.
  const doubled = classify({
    manifest: canvassOf([
      { slug: "editorial-slab", sections: ["hero", "work"] },
      { slug: "quiet-grid", sections: ["hero", "work"] },
      { slug: "warm-stack", sections: ["hero", "hero"] },
    ]),
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(doubled.failure, "too-few-images");
  assert.match(doubled.detail, /warm-stack/);
  assert.match(doubled.detail, new RegExp(`1 of ${String(DESIGN_CANVASS_SECTIONS)}`), "one DISTINCT section, not two stills");

  // AND CASE IS NOT A SECOND SECTION EITHER: "Hero" and "hero" are the same
  // section rendered twice, which is what a lane writing prose-cased sections
  // produces.
  const cased = classify({
    manifest: canvassOf([
      { slug: "editorial-slab", sections: ["hero", "work"] },
      { slug: "quiet-grid", sections: ["hero", "work"] },
      { slug: "warm-stack", sections: ["Hero", " hero "] },
    ]),
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(cased.failure, "too-few-images");
});

test("ONE ASPECT ACROSS THE CANVASS — a direction rendered at another shape is not comparable", () => {
  // `aspect` IS ON EVERY REF, so this is bindable from the manifest alone. A 3:2
  // card beside two 16:9 cards is a different picture before it is a different
  // design, and the owner's eye answers the wrong question.
  const mixed = classify({
    manifest: canvassOf([
      { slug: "editorial-slab", sections: ["hero", "work"] },
      { slug: "quiet-grid", sections: ["hero", "work"] },
      { slug: "warm-stack", sections: ["hero", "work"], aspect: "3:2" },
    ]),
    pngCount: 6,
    floor: MIN_CANVASS_REFS,
  });
  assert.equal(mixed.failure, "manifest-invalid");
  assert.match(mixed.detail, /warm-stack/);
  assert.match(mixed.detail, /3:2/, "the aspect it used");
  assert.match(mixed.detail, /16:9/, "against the one the others used");
});

test("FINDING K: a clobbered `chosenDirection` is loud when the expansion happened, and SILENT when it did not", () => {
  /*
   * THE SHAPE. `parseDesignManifest` drops `chosenDirection` when its provenance
   * is missing, so a stage-B lane that rewrote either field hands the host a file
   * that READS as a canvass. The floor it is graded against is still the
   * expansion's — `#buildPhase` passes it from `expandSegment`, which the file
   * cannot contradict — but `refsForStage` takes the canvass arm and counts every
   * direction's stills.
   *
   * HALF OF IT IS NOW LOUD, as a side effect of the comparability check rather
   * than by design: an expansion that DID happen leaves the chosen direction with
   * sections the other two do not have.
   */
  const expanded = classify({ manifest: expandedManifest({ expansion: 3, clobbered: true }), pngCount: 9 });
  assert.equal(expanded.failure, "manifest-invalid", "the chosen direction's extra sections give it away");
  assert.match(expanded.detail, /warm-stack/);

  /*
   * AND HALF OF IT IS NOT, WHICH IS RECORDED RATHER THAN CLAIMED CLOSED. Clobbered
   * AND the expansion produced nothing: 2/2/2, comparable, one aspect, six stills
   * against a floor of five. Identical to a healthy canvass in every field this
   * file can read — the manifest does not carry which stage produced it. The fix
   * is the host passing the STAGE it ran rather than only that stage's floor
   * (`#buildPhase` already knows: `expandSegment`), which is orchestrator.ts.
   */
  const silent = classify({ manifest: expandedManifest({ expansion: 0, clobbered: true }), pngCount: 6 });
  assert.equal(silent.failure, null, "RESIDUAL, recorded in design-outcome.ts — a manifest cannot name its own stage");
});

test("RECORDED, NOT FIXED: a stage-B lane that REPLACES `refs` erases the record and still passes", () => {
  // `expandBrief` says "APPEND TO `refs`, NEVER REPLACE IT. Every existing entry
  // stays exactly as it is, including the other directions' stills — they are the
  // record of what the owner was offered." A lane that replaces them leaves the
  // chosen direction's five stills, which meet the floor, and the two discarded
  // directions with nothing. The panel then shows a choice that has no evidence
  // behind it. Nothing here can see it: `classifyDesignLane` is handed ONE file at
  // ONE moment and the canvass it should be compared against is gone with the
  // refs. The third residual in design-outcome.ts, pinned so a later reader knows
  // it was measured rather than missed.
  const replaced = canvassOf(
    [
      { slug: "editorial-slab", sections: [] },
      { slug: "quiet-grid", sections: [] },
      { slug: "warm-stack", sections: ["hero", "work", "about", "contact", "footer"] },
    ],
    "warm-stack",
  );
  assert.equal(classify({ manifest: replaced, pngCount: 5 }).failure, null);
});
