import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DesignCapability } from "./design-capability.js";
import { designSegmentPrompt, DESIGN_DIALS, MIN_DESIGN_REFS } from "./design-prompt.js";

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
