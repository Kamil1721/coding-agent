import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DesignCapability } from "./design-capability.js";
import type { DesignManifest } from "./design-manifest.js";
import { toVisualManifest } from "./design-manifest.js";
import {
  designHandoffSection,
  designSegmentPrompt,
  DESIGN_DIALS,
  IMAGE_TO_CODE_SKILL,
  MIN_DESIGN_REFS,
  visualGatePrompt,
  VISUAL_GATE_AGENT,
  VISUAL_GATE_AUTHOR,
  VISUAL_GATE_REPORT,
} from "./design-prompt.js";
import { visualCriteriaFor } from "./visual-criteria.js";

const WS = "/runs/r1/workspace";
const CAP: DesignCapability = {
  imageScript: "/Users/o/.claude/scripts/gemini-image.sh",
  key: { available: true, source: "GEMINI_API_KEY" },
  video: false,
};

function full(overrides: Partial<Parameters<typeof designSegmentPrompt>[0]> = {}): string {
  return designSegmentPrompt({
    ticketText: "a portfolio",
    workspace: WS,
    mode: "full",
    capability: CAP,
    autoChoose: false,
    ...overrides,
  });
}

test("the prompt names the script by its ABSOLUTE path — nothing on PATH substitutes", () => {
  assert.match(full(), /\/Users\/o\/\.claude\/scripts\/gemini-image\.sh/);
});

test("the flags are the script's flags, verbatim", () => {
  const p = full();
  assert.match(p, /-a\b/);
  assert.match(p, /-o\b/);
  assert.match(p, /-i\b/);
  assert.match(p, /1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9/);
});

test("the model default is stated and is Nano Banana 2", () => {
  assert.match(full(), /gemini-3\.1-flash-image-preview/);
});

test("generation is STRICTLY SEQUENTIAL and -i chains off the last image", () => {
  // Spec §7.2: `-i reference.png` "is what holds the palette across the set, and
  // why generation is strictly sequential". A prompt that permits parallel
  // generation produces five unrelated images and a manifest that lies about
  // being a set.
  const p = full();
  assert.match(p, /sequential/i);
  assert.match(p, /-i .*(previous|last|best sibling)/i);
});

test("the closed loop and its cap are stated: Read, critique, max 2 retries", () => {
  const p = full();
  assert.match(p, /max(imum)? 2 retries/i);
  assert.match(p, /Read the image/i);
});

test("at least five PNGs and a manifest, at the exact paths the host will read", () => {
  const p = full();
  assert.match(p, new RegExp(`at least ${String(MIN_DESIGN_REFS)}`, "i"));
  assert.match(p, /\/runs\/r1\/workspace\/design-refs\//);
  assert.match(p, /\/runs\/r1\/workspace\/design-refs\/manifest\.json/);
  for (const field of ["section", "aspect", "intent"]) assert.ok(p.includes(field), `manifest field ${field}`);
});

test("THE KEY IS NEVER IN THE PROMPT — not the value, not a read instruction", () => {
  // CLAUDE.md:18 and spec §7.5. The script resolves the key itself; an agent
  // never needs to see it, and a prompt that told it to `cat ~/.gemini/api_key`
  // would put the key in the transcript, the build log and the canvas.
  const p = designSegmentPrompt({
    ticketText: "a portfolio",
    workspace: WS,
    mode: "full",
    capability: { ...CAP, key: { available: true, source: "~/.gemini/api_key" } },
    autoChoose: false,
  });
  assert.doesNotMatch(p, /cat .*api_key/i);
  assert.doesNotMatch(p, /\$GEMINI_API_KEY/);
  assert.doesNotMatch(p, /echo .*KEY/i);
  // ADDED BEYOND THE PLAN, because the plan's own negative control for this test
  // — "add `Your key is at ~/.gemini/api_key` to the generation block" — matches
  // none of the three assertions above and was measured NOT to turn this test
  // red. Three specific spellings are not "the key is never in the prompt": the
  // name of the file and the names of the variables are the general case, and
  // they are what the control actually writes.
  assert.doesNotMatch(p, /api_key/i, "not even the PATH of the key file may appear");
  assert.doesNotMatch(p, /GEMINI_API_KEY|NANOBANANA_API_KEY/i, "nor the variable names");
});

test("2b NEVER asks for video — the capability flag is false and the ask is gated on it", () => {
  // §7.1a: "Until 2c lands, the gate must not demand video." An agent told to
  // produce a scroll-scrubbed .mp4 with no gemini-video.sh either fakes it or
  // burns the lane's turns discovering it cannot.
  const p = full();
  assert.doesNotMatch(p, /\.mp4/);
  assert.doesNotMatch(p, /gemini-video\.sh/);
});

test("with the video capability present, the ask appears — the flag is load-bearing", () => {
  const p = full({ capability: { ...CAP, video: true } });
  assert.match(p, /\.mp4/);
});

test("a degraded lane is told to art-direct in WRITING and NOT to fake images", () => {
  // Spec §6.5: "taste-frontend-expert still art-directs and produces written
  // direction". And Phase 2a's AS-PLACEHOLDER-IMAGE denies picsum/placehold.co
  // at write time, so a fallback to placeholder art is a denial loop, not a fix.
  const p = full({ mode: "degraded", capability: { ...CAP, key: { available: false, source: null } } });
  assert.match(p, /written (art )?direction/i);
  assert.doesNotMatch(p, /gemini-image\.sh/);
  assert.match(p, /picsum|placehold\.co/i, "it must name what it may not reach for");
});

test("the three dials are named verbatim, and in the prompt the builders will inherit", () => {
  const p = full();
  for (const dial of DESIGN_DIALS) assert.ok(p.includes(dial), `${dial} is missing`);
});

test("auto-choose asks ui-designer, never the author (§17.3 rule 3)", () => {
  const p = full({ autoChoose: true });
  assert.match(p, /ui-designer/);
  assert.match(p, /choice\.json/);
  assert.doesNotMatch(p, /taste-frontend-expert (picks|chooses|selects)/i);
});

test("without auto-choose the prompt does NOT ask anyone to pick — the owner will", () => {
  assert.doesNotMatch(full({ autoChoose: false }), /choice\.json/);
});

/* ---- Task 6: the DESIGN -> BUILD handoff, all three mechanisms -------- */

const HERO = `${WS}/design-refs/01-hero.png`;
const WORK = `${WS}/design-refs/02-work.png`;

const LOCKED: DesignManifest = {
  version: 1,
  refs: [
    { path: HERO, section: "hero", aspect: "21:9", intent: "full-bleed opening statement" },
    { path: WORK, section: "work", aspect: "16:9", intent: "three projects, uneven weight" },
  ],
  lockedMockup: HERO,
  lockedBy: "owner",
  lockedReason: "chosen in the dashboard",
  lockedAt: "2026-07-29T10:00:00.000Z",
};

function handoff(overrides: Partial<Parameters<typeof designHandoffSection>[0]> = {}): string {
  return designHandoffSection({
    manifest: LOCKED,
    mode: "full",
    workspace: WS,
    dials: "DESIGN_VARIANCE: high\nMOTION_INTENSITY: medium\nVISUAL_DENSITY: low",
    ...overrides,
  });
}

test("MECHANISM 1 — the filesystem location is named AS A LOCATION, inside the workspace", () => {
  // REWRITTEN FROM THE PLAN, WHICH ASSERTED `match(handoff(), /<ws>\/design-refs/)`.
  // Every absolute ref path mechanism 2 prints CONTAINS that substring, so the
  // plan's assertion passed automatically whenever the ref loop emitted anything
  // and could not go red on its own — a check whose failure mode is a strict
  // subset of a louder check's is not a second check. This one demands a line
  // that names the directory and is NOT one of the ref lines, and Step 5 control
  // 4 removes exactly that line and watches this test fail ALONE.
  const p = handoff();
  const refsDir = `${WS}/design-refs`;
  const locationLines = p
    .split("\n")
    .filter((line) => line.includes(refsDir) && !line.includes(HERO) && !line.includes(WORK));
  assert.ok(locationLines.length > 0, "the mockup directory is never stated as a directory");
  assert.match(locationLines.join("\n"), /workspace/i, "and it is named as being inside the workspace");
});

test("MECHANISM 2 — EVERY ref appears as an ABSOLUTE path, not a count and not a directory", () => {
  // "Paths in a prompt are what make Read on a PNG actually happen" (§7.3).
  // A prompt that says "five mockups are in design-refs/" is a mechanism that
  // does not work: the child has to guess filenames.
  const p = handoff();
  assert.ok(p.includes(HERO), "the hero path is missing");
  assert.ok(p.includes(WORK), "the second path is missing");
  assert.match(p, /Read/);
});

test("MECHANISM 2 — the LOCKED mockup is marked as the one being built to", () => {
  const p = handoff();
  assert.match(p, /LOCKED/);
  const lockedLine = p.split("\n").find((line) => line.includes("LOCKED") && line.includes(HERO));
  assert.ok(lockedLine !== undefined, "the locked path is not identified on its own line");
});

test("MECHANISM 2 — the three dials are carried through VERBATIM", () => {
  const p = handoff();
  for (const dial of DESIGN_DIALS) assert.ok(p.includes(dial), `${dial} did not survive the handoff`);
  assert.match(p, /MOTION_INTENSITY: medium/);
});

test("MECHANISM 3 — the skill bridge is an INVOCATION instruction, not a preload", () => {
  // Options.agents is gone (probe I): AgentDefinition.skills preloads nothing for
  // any name that exists on disk, which is every shortlisted agent. The only
  // channel measured to reach a child is the Agent call's own prompt.
  const p = handoff();
  assert.ok(p.includes(IMAGE_TO_CODE_SKILL), "the skill is not named");
  assert.match(p, /invoke|use the .*skill/i);
});

test("ALL THREE mechanisms are present in one block — two of three is nothing", () => {
  const p = handoff();
  const present = [
    p.includes("design-refs"),
    p.includes(HERO) && p.includes(WORK),
    p.includes(IMAGE_TO_CODE_SKILL),
  ];
  assert.deepEqual(present, [true, true, true], "a handoff missing any mechanism is not a handoff");
});

test("a DEGRADED lane hands over the written direction and says there are no stills", () => {
  const p = handoff({ manifest: null, mode: "degraded" });
  assert.match(p, /direction\.md/);
  assert.match(p, /no (design )?stills/i);
  assert.doesNotMatch(p, /\.png/);
});

test("an OFF lane produces an EMPTY handoff — never a paragraph about images that do not exist", () => {
  assert.equal(handoff({ manifest: null, mode: "off", dials: "" }), "");
});

test("an unlocked manifest still hands over every path, and says nothing is locked", () => {
  const unlocked: DesignManifest = { ...LOCKED, lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null };
  const p = handoff({ manifest: unlocked });
  assert.ok(p.includes(HERO));
  assert.match(p, /no mockup (is |was )?locked/i);
});

/* ---- Task 12: the visual gate, and the author who may not grade -------- */

test("the gate is ui-designer and NEVER the author", () => {
  assert.equal(VISUAL_GATE_AGENT, "ui-designer");
  assert.notEqual(VISUAL_GATE_AGENT, VISUAL_GATE_AUTHOR);
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: "http://127.0.0.1:4180" });
  assert.doesNotMatch(p, /taste-frontend-expert/, "an agent grading its own art direction is not a gate");
});

test("the gate grades against the LOCKED mockup, one screenshot per section, at the mockup's aspect", () => {
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: "http://127.0.0.1:4180" });
  assert.ok(p.includes(HERO));
  assert.match(p, /21:9/, "the hero's aspect, so the screenshot is comparable to the still");
  assert.match(p, /http:\/\/127\.0\.0\.1:4180/);
  assert.ok(p.includes(VISUAL_GATE_REPORT));
});

test("the gate is told it is QUALITY and NON-BLOCKING", () => {
  // Owner decision, spec decision #9 and §7.4: subjective judgement informs, it
  // does not false-fail a run. A gate that thinks it can fail a build will write
  // a report that reads like one.
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: null });
  assert.match(p, /QUALITY/);
  assert.match(p, /never blocks|non-blocking/i);
});

test("every criterion the gate is handed is QUALITY tier — asserted through the real module", () => {
  const criteria = visualCriteriaFor(toVisualManifest(LOCKED));
  // ADDED BEYOND THE PLAN: a for-of over an empty array asserts nothing and
  // passes, so an emptied criteria list would leave this test green while the
  // gate was handed no criteria at all.
  assert.ok(criteria.length > 0, "a vacuous loop is not an assertion about tiers");
  for (const criterion of criteria) assert.equal(criterion.tier, "QUALITY");
});

test("with no mockups the gate still runs, on the rule-based floor", () => {
  // Spec §6.5: "the visual gate falls back to rule-based scoring with no
  // reference PNGs". A degraded lane must not silently skip the gate.
  const p = visualGatePrompt({ manifest: null, workspace: WS, previewUrl: null });
  assert.ok(p.length > 0);
  assert.match(p, /no reference/i);
  assert.ok(visualCriteriaFor({ lockedMockup: null }).length > 0);
});

test("with no preview URL the gate says what it cannot do rather than pretending", () => {
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: null });
  assert.match(p, /no preview/i);
});

/* ---- THE TRAP, at the handoff seam ------------------------------------ */

test("a FULL lane that produced ZERO images does not get the DEGRADED lane's sentence", () => {
  // THE TRAP, in the plan's own words: "`degraded` and `full`-with-zero produce
  // the same file count and must never produce the same report." This function
  // IS one of the two reports a build agent reads, and the plan's draft keyed the
  // whole branch on `manifest === null` — so a full lane whose image chain died
  // was told image generation had been unavailable, which is false.
  const degraded = handoff({ manifest: null, mode: "degraded" });
  const fullWithZero = handoff({ manifest: null, mode: "full" });
  assert.notEqual(fullWithZero, degraded, "a full lane with no images is not a degraded lane");
  assert.doesNotMatch(fullWithZero, /unavailable/i, "generation was AVAILABLE on a full lane; it failed");
  assert.match(fullWithZero, /EXPECTED TO/);
  assert.match(degraded, /unavailable/i);
});

test("with no written direction either, the handoff points at nothing rather than at a missing file", () => {
  // `dials` is this function's signal that direction.md exists ("the text of
  // direction.md, or "" when absent"). A `Read` on a file nobody wrote surfaces
  // turns deep inside a build agent as its own confusion, not as a design fault.
  for (const mode of ["degraded", "full"] as const) {
    const p = handoff({ manifest: null, mode, dials: "" });
    assert.doesNotMatch(p, /direction\.md/, `${mode}: pointed at a file the lane never wrote`);
    assert.match(p, /no design input/i);
  }
});
