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
import { countDesignPngs, readDesignManifest, refsDirFor, type DesignManifest } from "./design-manifest.js";
import { MIN_DESIGN_REFS, designSegmentPrompt } from "./design-prompt.js";
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
    })),
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
  const prompt = designSegmentPrompt({ ticketText, workspace, mode, capability, autoChoose: true });

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
