import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DesignCapability } from "./design-capability.js";
import { GEMINI_IMAGE_SCRIPT } from "./design-capability.js";
import { designReferenceSection } from "./ticket-refs.js";
import { legPlannerInput } from "./design/video-lane.js";
import type { VideoLegPlan } from "./design/video-legs.js";
import { DEFAULT_VIDEO_LEG_CAP, planVideoLegs, resolveLegCap, VEO_ASPECTS } from "./design/video-legs.js";
import type { DesignDirection, DesignManifest } from "./design-manifest.js";
import { auditCanvass, parseDesignManifest, toVisualManifest } from "./design-manifest.js";
import {
  designHandoffSection,
  designSegmentPrompt,
  DESIGN_CANVASS_SECTIONS,
  DESIGN_DIALS,
  DESIGN_DIRECTION_CHOICE_FILE,
  DESIGN_DIRECTION_COUNT,
  IMAGE_TO_CODE_SKILL,
  MIN_CANVASS_REFS,
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
    // THE DEFAULT IS THE CANVASS, because that is what a fresh run now gets.
    // Every test written before 2026-08-03 was written against the ONE-direction
    // deliverable, and `expand({...})` below is where that shape now lives.
    stage: "canvass",
    chosen: null,
    ...overrides,
  });
}

/**
 * THE ONE-DIRECTION DELIVERABLE, WHICH IS NOW STAGE B.
 *
 * Every assertion about "at least five PNGs, one per section" and about the
 * motion mark moved here when the canvass landed, and they MOVED rather than
 * being deleted: the expansion IS today's shape, applied to the chosen direction
 * alone. A test that had stayed on `full()` would have gone green against a
 * canvass brief that never mentions five PNGs — the assertion surviving while the
 * thing it measured moved out from under it.
 */
const CHOSEN: DesignDirection = {
  slug: "editorial-slab",
  name: "Editorial slab",
  distinction: "A slab-serif masthead over a two-column measure; the others are grotesk and single-column.",
  notes: `${WS}/design-refs/direction-editorial-slab.md`,
};

function expand(overrides: Partial<Parameters<typeof designSegmentPrompt>[0]> = {}): string {
  return full({ stage: "expand", chosen: CHOSEN, ...overrides });
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
  // STAGE B. This is the deliverable the whole pipeline was built around, and it
  // is now what the CHOSEN direction is expanded to — same floor, same one-per-
  // section shape, same manifest path.
  const p = expand();
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
    stage: "canvass",
    chosen: null,
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
  // ON THE EXPANSION, NOT THE CANVASS. A leg spends on a metered key and two of
  // three directions are about to be discarded, so the mark is asked for only
  // once a direction has been chosen.
  const p = expand({ capability: { ...CAP, video: true } });
  assert.match(p, /\.mp4/);
});

/* ---- PHASE 2C'S PRODUCTION TRIGGER -------------------------------------
 *
 * WHY THE ASSERTION IS A PLAN AND NOT A GREP. Until this test existed, the only
 * thing pinned about the video branch was that the string `.mp4` appears in it —
 * and an auditor's mutation proved that: rewriting the branch to instruct
 * `"animate": true` left the whole suite green, because `.mp4` survived the
 * rewrite. Grepping for the word `animate` would have the same defect in reverse.
 * The question is not "does the prompt contain a string", it is "does the file an
 * agent produces by copying this template plan a leg", and that is answerable
 * only by running the HOST'S OWN parser and the HOST'S OWN planner over the
 * template, through the same `refs`→`sections` join production uses
 * (`legPlannerInput` — imported, never re-implemented here, because a hand-rolled
 * `{ sections: refs }` in this file would pin the join to itself).
 *
 * MEASURED RED BEFORE IT WAS MEASURED GREEN. Against the prompt as shipped in
 * Phase 2b this test failed at `legs.length` — expected 1, got 0 — which is the
 * live defect and a better negative control than any mutation, because nobody
 * designed the code to be caught by it.
 */
function manifestTemplate(prompt: string): string {
  const anchor = prompt.indexOf('"version": 1');
  assert.notEqual(anchor, -1, "the prompt must hand the agent a manifest template");
  const start = prompt.lastIndexOf("{", anchor);
  let depth = 0;
  for (let index = start; index < prompt.length; index += 1) {
    if (prompt[index] === "{") depth += 1;
    else if (prompt[index] === "}") {
      depth -= 1;
      if (depth === 0) return prompt.slice(start, index + 1);
    }
  }
  return assert.fail("the manifest template's braces do not balance — an agent cannot copy it");
}

function templateRefs(prompt: string): DesignManifest {
  const parsed = parseDesignManifest(manifestTemplate(prompt), WS);
  assert.notEqual(
    parsed,
    null,
    "the template the agent is told to copy must itself survive the host's parser — " +
      "`readRef` is all-or-nothing, so one malformed example ref rejects the whole file",
  );
  return parsed as DesignManifest;
}

function planFromTemplate(prompt: string): VideoLegPlan {
  return planVideoLegs(legPlannerInput(templateRefs(prompt)), WS, resolveLegCap({}));
}

test("THE VIDEO BRANCH IS 2C'S TRIGGER: the template, copied literally, PLANS A LEG", () => {
  const p = expand({ capability: { ...CAP, video: true } });

  // THE PLAN IS ASSERTED BEFORE THE COUNTS, AND THE ORDER WAS CHOSEN BY A
  // MEASUREMENT. With `marked.length === 1` first, two of the controls below
  // (a 21:9 marked example; a second ref marked at a rejected aspect) died on
  // the count and never reached `rejected`, so `rejected` and `droppedByCap`
  // were assertions no mutation could turn red — dominated lines that read as
  // checks. Planning first makes each of the three separately observable.
  const plan = planFromTemplate(p);
  assert.equal(
    plan.legs.length,
    1,
    "the mark reaches the planner: parseDesignManifest -> legPlannerInput -> planVideoLegs. " +
      "0 here is Phase 2c unreachable — the manifest marked nothing, which is exactly what " +
      "the live run's video.json recorded (available: true, legsAttempted: 0)",
  );
  assert.deepEqual(
    [...plan.rejected],
    [],
    "and NOTHING the template marks is refused: an example ref that is itself rejected " +
      "teaches the agent to produce a manifest the lane throws away (spec §7.6.3.1)",
  );
  // TWO ASSERTIONS STOOD HERE AND BOTH WERE DELETED FOR THE SAME REASON: no
  // mutation of this file can turn either red, so each read as a check while
  // being true by construction.
  //
  //   `plan.droppedByCap === 0` — the template carries two refs against a cap of
  //   2, so nothing can be dropped, and a template that grew a third marked ref
  //   is caught by `legs.length === 1` one assertion earlier. The cap is observed
  //   where it is ENFORCED, by `video-legs.test.ts` counting invocations.
  //
  //   `VEO_ASPECTS.includes(plan.legs[0].aspect)` — `planVideoLegs` pushes a leg
  //   only after `isVeoAspect` (video-legs.ts:127), so every element of
  //   `plan.legs` has a Veo aspect by construction. What the template's aspect is
  //   actually pinned by is `rejected` being empty, which control (i) turned red.

  const refs = templateRefs(p);
  const marked = refs.refs.filter((ref) => ref.animate === true);
  assert.equal(marked.length, 1, "exactly one ref in the template carries the mark");
  assert.ok(
    refs.refs.length > marked.length,
    "AND AT LEAST ONE DOES NOT. A template whose every ref is marked is an instruction to " +
      "mark every section — the cap violated by the example rather than by the agent",
  );
});

test("NO VIDEO CAPABILITY, NO MARK — the field does not appear and the template plans nothing", () => {
  // Requirement 1 of §7.6.3, and the control that makes the test above about the
  // FLAG rather than about the prompt: instructing `animate` on a run with no
  // gemini-video.sh invites a manifest the lane must then reject, and a rejection
  // the host prints for a capability the run never had reads as a design fault.
  const p = full();
  assert.doesNotMatch(p, /"animate"/, "not the field name");
  assert.doesNotMatch(p, /animate/i, "not the word, in any casing");
  assert.equal(planFromTemplate(p).legs.length, 0);
});

/**
 * The prose half, sliced to the block it belongs to.
 *
 * Asserting these strings against the WHOLE prompt would let the aspect pair be
 * satisfied by the `-a` flag list — which names `16:9` and `9:16` on every run,
 * video or not — so the restriction would be "pinned" by a line that predates
 * this feature and says nothing about animation.
 */
function motionBlock(prompt: string): string {
  const start = prompt.indexOf("MOTION LEGS ARE AVAILABLE");
  assert.notEqual(start, -1, "the video branch must announce itself");
  const end = prompt.indexOf("THE THREE DIALS", start);
  assert.notEqual(end, -1, "and the dials block must follow it");
  return prompt.slice(start, end);
}

test("the motion instruction carries the cap, the two legal aspects, and no tool to run", () => {
  const block = motionBlock(expand({ capability: { ...CAP, video: true } }));
  assert.match(block, /"animate": true/, "the field and its value, spelled the way the file wants it");
  assert.match(
    block,
    new RegExp(`at most ${String(DEFAULT_VIDEO_LEG_CAP)}`, "i"),
    "spec §7.6.3.2 is a COST cap; an instruction that omits it invites five marks and three drops",
  );
  for (const aspect of VEO_ASPECTS) {
    assert.ok(block.includes(aspect), `the restriction must name ${aspect} beside the mark`);
  }
  assert.match(block, /21:9/, "and name a rejected one, because that is the mistake it prevents");
  assert.doesNotMatch(
    block,
    /gemini-video/,
    "THE AGENT DOES NOT SPEND THIS MONEY. The host runs the lane between the segments; " +
      "naming the script here is an invitation to a metered call from inside the design lane",
  );
  assert.doesNotMatch(
    block,
    /\b8 ?(s\b|seconds)/i,
    "no 8-second assumption: 4 s at 720p with an image was measured to be accepted, and " +
      "§7.6.1's '8 s required for reference images' attaches to config.referenceImages",
  );
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
    { path: HERO, section: "hero", aspect: "21:9", intent: "full-bleed opening statement", direction: null, origin: null },
    { path: WORK, section: "work", aspect: "16:9", intent: "three projects, uneven weight", direction: null, origin: null },
  ],
  directions: [],
  chosenDirection: null,
  directionChoice: null,
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

/* ---- R1: the owner's own reference reaches the model, not just the prose ---- */

test("THE FIRST GENERATION IS SEEDED FROM THE OWNER'S REFERENCE, via -i and not via prose", () => {
  // THE MEASUREMENT BEHIND THIS. `designReferenceSection` tells the lane that an
  // attached image is "the direction the owner has already chosen. Derive from
  // them." That reaches the lane as WORDS. The `-i` chain described in the same
  // prompt seeds every generation from the previous SIBLING, so on the one run
  // that passed, six generations ran mockup-to-mockup and Gemini was never shown
  // anything the owner supplied. "Derive from his reference" was a request the
  // tool call could not honour.
  const p = full();
  assert.match(p, /SEED THE FIRST GENERATION FROM THE OWNER'S OWN REFERENCE/);
  assert.match(p, /FIRST generation of EVERY direction/, "every direction, not just the first one rendered");
  assert.match(p, /`-i` is the only way the model is shown it/, "the reason, which is what generalises");
});

test("AND THE FORWARD REFERENCE RESOLVES — the heading it quotes is the heading that is appended", () => {
  // THE DISCRIMINATING HALF. `orchestrator.ts` composes
  // `designSegmentPrompt(...) + designReferenceSection(references)`, so the paths
  // arrive from a module this one cannot call. A paragraph naming a heading
  // nobody writes reads exactly as well as one that resolves, and every other
  // assertion above stays green while it is wrong.
  const heading = "THE OWNER GAVE YOU REFERENCES";
  const appended = designReferenceSection({
    images: [{ path: "/runs/r1/refs/owner-hero.png", sha256: "b".repeat(64), bytes: 2048 }],
    capture: null,
  });
  assert.ok(appended.includes(heading), "ticket-refs.ts no longer emits the heading design-prompt.ts quotes");
  assert.ok(full().includes(heading), "design-prompt.ts no longer quotes the heading ticket-refs.ts emits");
  // AND IT IS CONDITIONAL, because the section is: `hasReferences` renders "" when
  // he attached nothing, and an unconditional sentence would send the lane after a
  // heading that is not there.
  assert.equal(designReferenceSection({ images: [], capture: null }), "");
  assert.match(full(), /Where that section is present/);
});

test("A DEGRADED LANE NO LONGER BLESSES A BORROWED PHOTOGRAPH", () => {
  // THE SENTENCE THAT WAS HERE: "A chosen photograph with a real URL is fine; a
  // random one is not." Under the owner's standing rule it is false, and it was
  // this lane's own prompt contradicting it. The mechanical half agrees for an
  // unrelated reason: the artefact is judged by `docker run --network=none`, so a
  // remote URL is a broken image at the moment it is graded.
  const p = full({ mode: "degraded" });
  assert.doesNotMatch(p, /chosen photograph with a real URL is fine/i, "the blessing must be gone");
  assert.doesNotMatch(p, /photograph.{0,40}is fine/is, "and not restated in another spelling");
  assert.match(p, /every shipped visual is generated through the image tool/i);
  assert.match(p, /stock photo\s+host, an icon CDN/i, "the exclusion names what is reached for instead");
});

/* ---- R4: every shipped asset is generated, and nothing is fetched ------- */

test("R4 — THE BUILD IS TOLD TO GENERATE THE ASSETS IT SHIPS, with the tool and the path", () => {
  // THE GAP THIS CLOSES, MEASURED ON THE ONE RUN THAT PASSED. Six
  // `gemini-image.sh` calls, all six writing `design-refs/*.png` between 02:49 and
  // 02:52; the two files the site ships were written at 02:57 inside the BUILD
  // segment and are half-width crops of the mockups. The prompt got MOCKUPS
  // generated and said nothing whatever about the assets that ship.
  const p = handoff();
  assert.match(p, /EVERY IMAGE THIS SITE SHIPS IS GENERATED HERE/);
  assert.ok(p.includes(GEMINI_IMAGE_SCRIPT), "the tool is named by the path design-capability.ts owns");
  assert.ok(p.includes(`${WS}/assets/`), "and the output goes inside the workspace");
  assert.match(p, /-i <the locked mockup>/, "seeded from the design, so the photograph belongs to it");
  assert.match(p, /Read each result before you ship it/i, "a generation nobody looked at is not a closed loop");
  // AND THE BLOCK DOES NOT MODEL THE TELL IT GOES ON TO FORBID. Three paragraphs
  // later the same prompt calls the em-dash the single most reliable sign a
  // machine wrote the page; carrying one here gives the instruction a reason to be
  // discounted. Scoped to the lines this lane added, because two older lines in
  // the same function predate the ban and are left alone.
  const added = p.slice(p.indexOf("EVERY IMAGE THIS SITE SHIPS"));
  assert.doesNotMatch(added, /[—–]/, "the R4 and slop blocks must not contain the character they ban");
});

test("R4 — THE EXCLUSION IS ABOUT WHAT THE PAGE LOADS, and spares what the visitor clicks", () => {
  // THE NARROWNESS IS LOAD-BEARING AND IT IS CALIBRATED AGAINST A REAL ARTEFACT.
  // `run-2026-07-30T20-16-40-242Z-052c6e02` ships github.com and linkedin.com
  // anchors alongside four self-hosted woff2 files and is CORRECT by this rule. A
  // sentence that said "no external URLs" would condemn it, which is the false-fail
  // shape this repository has already been bitten by.
  const p = handoff();
  assert.match(p, /NOTHING THE PAGE LOADS MAY COME FROM OFF THIS MACHINE/);
  assert.match(p, /No icon library, no icon or\s+font CDN, no stock photo host/i);
  assert.match(p, /`src`.*`url\(\)`|`url\(\)` in the CSS/is, "the subject is named as subresources");
  assert.match(p, /A link the visitor CLICKS is not an asset/, "and an anchor is explicitly spared");
  assert.match(p, /no network/i, "the second, mechanical reason — the gate runs with none");
});

test("R4 — A DEGRADED RUN KEEPS THE EXCLUSION AND DROPS THE TOOL", () => {
  // The run with no stills is the run most tempted to fetch one, so the half that
  // forbids it must not be the half that only renders when the tool works. And
  // pointing a keyless machine at a script that cannot run is the one thing this
  // prompt must never do.
  const p = handoff({ manifest: null, mode: "degraded" });
  assert.match(p, /NOTHING THE PAGE LOADS MAY COME FROM OFF THIS MACHINE/, "the exclusion survives");
  assert.match(p, /THIS RUN SHIPS NO PHOTOGRAPHY/);
  assert.ok(!p.includes(GEMINI_IMAGE_SCRIPT), "a degraded lane is never pointed at a tool it does not have");
  assert.match(p, /an absent image is a smaller defect/i);
});

test("R4 — AN OFF LANE STILL SAYS NOTHING AT ALL", () => {
  // A CLI ticket has no assets and no page. The whole handoff is "" on that
  // branch and this must not be the addition that breaks it.
  assert.equal(handoff({ manifest: null, mode: "off", dials: "" }), "");
});

/* ---- R2: the slop signatures, named where they are cheaper than a gate --- */

test("R2 — THE KNOWN TELLS ARE NAMED, so avoiding one does not depend on taste", () => {
  const p = handoff();
  assert.match(p, /WHAT AN AI-BUILT PAGE LOOKS LIKE/);
  for (const tell of [
    "em-dash",
    "eyebrow over every section",
    "Three identical cards in a row",
    "faked out of divs",
    "lorem ipsum",
    "purple-to-pink gradient",
  ]) {
    assert.ok(p.includes(tell), `the tell "${tell}" is not named, so nothing but taste catches it`);
  }
  // AND THE FRAMING, which is the part that keeps a ban list from becoming the
  // brief: the design decides what the page is, this list decides what it is not.
  assert.match(p, /defaults to\s+avoid, not a checklist to satisfy/i);
});

test("R2 — THE SKILLS' ASSET ADVICE IS OVERRIDDEN AT THE POINT OF USE", () => {
  // PRIMARY SOURCE, VERIFIED: `taste-skill/SKILL.md:269, :277, :626` recommend
  // `picsum.photos` and `cdn.simpleicons.org`, and `redesign-skill/SKILL.md:43`
  // recommends `picsum.photos` for section backgrounds. Those files are the
  // owner's, shared with his other projects, and are NOT edited from here — so
  // the pipeline was instructing the builder to do the exact thing R4 forbids, in
  // the same run in which it forbade it. The conflict is resolved in the prompt,
  // which is the only place this repository controls.
  const p = handoff();
  assert.match(p, /WHERE A SKILL DISAGREES WITH THE PARAGRAPHS ABOVE, THE PARAGRAPHS WIN/);
  assert.match(p, /picsum\.photos/, "the conflicting recommendation is named, or the override is deniable");
  assert.match(p, /cdn\.simpleicons\.org/);
  assert.match(p, /so is the library/i, "an icon library is a library too");
  // AND IT IS A NARROW OVERRIDE. Discarding the skills wholesale would throw away
  // the layout, type and restraint rules this block relies on to mean anything.
  assert.match(p, /Everything\s+else those skills say/i);
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

/* ==================================================================
 * WHO AUTHORS THE ART DIRECTION.
 *
 * These exist because `VISUAL_GATE_AUTHOR` was exported, asserted below to differ
 * from `VISUAL_GATE_AGENT`, and NEVER PUT IN A PROMPT. That assertion passed for
 * the whole life of the file while the production path ignored the constant — the
 * exact "the assertion and the production path were never connected" shape
 * HANDOVER §3 catalogues.
 *
 * Measured consequence on `run-2026-07-29T23-28-46-665Z-3d4d1ccb`: zero
 * `graph_agent` events named `taste-frontend-expert`, the run made two Agent calls
 * (`context-manager`, `ui-designer`), and the orchestrator ran all six
 * `gemini-image.sh` calls itself — so `ui-designer` scored images the orchestrator
 * had authored.
 *
 * WHAT THESE CANNOT DO, said plainly: they assert the prompt ASKS. Whether the
 * model then delegates can only be established by a real run, which spends
 * subscription quota and needs a Docker daemon for the gate. Read-verified, never
 * executed — the same honesty STATUS §7 applies to `orchestrator.ts:1663-1665`.
 * ================================================================== */

test("the prompt DELEGATES authoring to the author seat, not to the orchestrator", () => {
  const p = full();
  assert.match(p, /WHO AUTHORS THIS/);
  assert.match(
    p,
    new RegExp(`${VISUAL_GATE_AUTHOR}\`? — delegate to it, not to yourself`),
    "the prompt must name the author seat as the delegate",
  );
});

test("the author seat's NAME reaches the prompt — the constant is wired, not decorative", () => {
  // The regression that matters: renaming the constant without updating the prompt,
  // or reverting the prompt block, must turn this red rather than pass quietly.
  assert.match(full(), new RegExp(VISUAL_GATE_AUTHOR));
});

test("the prompt forbids the GATE from authoring, in the same breath", () => {
  // Without this sentence "delegate the art direction" is satisfiable by delegating
  // it to `ui-designer`, which reintroduces the author-grades-itself problem the
  // two seats exist to prevent.
  assert.match(
    full(),
    new RegExp(`${VISUAL_GATE_AGENT}\`? MUST NOT be the author`),
  );
});

test("the delegation instruction is absent when there is no image capability", () => {
  /*
   * A DEGRADED LANE HAS NO STILLS TO AUTHOR. Asking for a delegation that has
   * nothing to do would spend a seat and a turn cap on an empty task — and spec §6.5
   * already says the lane degrades rather than blocks.
   */
  // The branch is keyed on `mode`, not on a capability flag: `mode: "degraded"` is
  // the no-stills path, where the prompt asks for WRITTEN art direction instead.
  const degraded = full({ mode: "degraded" });
  assert.doesNotMatch(degraded, /WHO AUTHORS THIS/);
});

/* ══ STAGE A — THE CANVASS (2026-08-03) ════════════════════════════════════ */

/**
 * The canvass template, parsed by the HOST'S OWN parser.
 *
 * SAME ARGUMENT AS `templateRefs` ABOVE, one stage earlier: the question is not
 * "does the prompt contain the word direction", it is "does the file an agent
 * produces by copying this template give the host three comparable directions".
 * A grep answers the first and nothing answers the second.
 */
function canvassTemplate(prompt: string): DesignManifest {
  const parsed = parseDesignManifest(manifestTemplate(prompt), WS);
  assert.notEqual(parsed, null, "the canvass template must survive the host's own parser");
  return parsed as DesignManifest;
}

test("THE CANVASS ASKS FOR THE SAME SECTIONS, IN THE SAME ORDER, AT THE SAME ASPECT", () => {
  // COMPARABILITY IS THE FEATURE. Three directions rendering hero/work,
  // hero/footer and hero/pricing are not three directions the owner can compare —
  // he is comparing pictures, and the nicest picture wins for a reason that has
  // nothing to do with the design.
  const p = full();
  const template = canvassTemplate(p);

  // THE TEMPLATE ITSELF IS COMPARABLE. Every ref carries one aspect, and the
  // sections repeat across directions rather than varying with them.
  const aspects = new Set(template.refs.map((ref) => ref.aspect));
  assert.equal(aspects.size, 1, "one aspect across the whole example set");
  const byDirection = new Map<string, string[]>();
  for (const ref of template.refs) {
    const slug = ref.direction ?? "";
    byDirection.set(slug, [...(byDirection.get(slug) ?? []), ref.section]);
  }
  assert.ok(byDirection.size >= 2, "the example shows more than one direction, or it shows nothing");
  const [first, ...rest] = [...byDirection.values()];
  for (const sections of rest) {
    assert.equal(sections[0], first?.[0], "every direction opens on the SAME section");
  }

  // AND THE INSTRUCTION SAYS IT IN WORDS, because the template shows two
  // directions and the lane must produce three. A model that read the template
  // and not the prose would render direction 3 however it liked.
  assert.match(p, /SAME SECTIONS, SAME ORDER, SAME ASPECT/);
  assert.match(p, new RegExp(`${String(DESIGN_DIRECTION_COUNT)} DISTINCT DIRECTIONS`));
  assert.match(p, new RegExp(`${String(DESIGN_CANVASS_SECTIONS)} STILLS`));
  assert.match(p, new RegExp(`${String(MIN_CANVASS_REFS)} PNGs`));
});

test("THE EXAMPLE THE LANE COPIES SURVIVES THE CHECK THE HOST APPLIES TO IT", () => {
  /*
   * THE PROMPT AND THE CLASSIFIER, BOUND RATHER THAN BOTH ASSERTED. Since
   * 2026-08-03 `auditCanvass` → `classifyDesignLane` fails a canvass whose
   * directions do not carry the same sections, and the brief now says so. A
   * template that could not itself pass that check would be this file handing an
   * agent a manifest the host rejects — the same defect the "valid JSON, not a
   * sketch with ellipses" rule exists for, one layer up.
   *
   * IT WAS RED BEFORE THE TEMPLATE GAINED ITS FOURTH REF: the example showed
   * `slugA` with two sections and `slugB` with one, so the host's own reader
   * reported `quiet-grid` short and missing the second section.
   */
  const template = canvassTemplate(full());
  const audited = auditCanvass(template);
  assert.ok(audited.length >= 2, "the example shows more than one direction, or it audits nothing");
  assert.deepEqual(
    audited.flatMap((direction) => direction.missing),
    [],
    "every direction in the example renders every section the others do",
  );
  for (const direction of audited) {
    assert.ok(
      direction.sections.length >= DESIGN_CANVASS_SECTIONS,
      `${direction.slug} shows ${String(direction.sections.length)} section(s); the check the brief names requires ${String(DESIGN_CANVASS_SECTIONS)}`,
    );
    assert.equal(direction.aspects.length, 1, "one aspect per direction, and the same one — see the aspects check above");
  }

  // AND THE BRIEF SAYS WHAT IS CHECKED, in the terms the check uses. A lane can
  // only correct what it is told is measured.
  const p = full();
  assert.match(p, /THE HOST CHECKS THIS OFF THE MANIFEST YOU WRITE/);
  assert.match(p, new RegExp(`all ${String(DESIGN_DIRECTION_COUNT)} directions must be declared`));
  assert.match(p, new RegExp(`at least\\s+${String(DESIGN_CANVASS_SECTIONS)} DISTINCT sections`));
  assert.match(p, /Two stills of\s+the same section count as ONE/);
  // THE FOURTH CHECK, IN THE BRIEF'S OWN WORDS: six stills of one direction is
  // the shape that cleared stage A before 2026-08-03.
  // WRAPPED ACROSS A LINE IN THE PROMPT, so the number is matched with `\s` for
  // the same reason `least two of` above is — a literal space here goes red on a
  // re-wrap that changed nothing about what the brief says.
  assert.match(p, new RegExp(`neither does\\s+${String(MIN_CANVASS_REFS)} stills of one direction`));
});

test("THE CANVASS DEMANDS DISTINCTNESS BY AXIS, and one sentence saying what differs", () => {
  // Three directions that differ only in accent colour are ONE direction shown
  // three times, and the owner's choice then decides nothing.
  const p = full();
  assert.match(p, /differ only in accent colour are/i);
  for (const axis of ["TYPE SYSTEM", "LAYOUT SCAFFOLD", "DENSITY", "MOTION IDEA"]) {
    assert.ok(p.includes(axis), `the axis ${axis} must be named — "make them different" is not an instruction`);
  }
  // WRAPPED ACROSS A LINE IN THE PROMPT, so the phrase is matched without the
  // leading word rather than with a `\s` that would also accept "at        least".
  assert.match(p, /least two of/i, "one axis is a variation; two is a direction");
  assert.match(p, /what THIS direction does that the OTHER TWO do not/);
  assert.ok(canvassTemplate(p).directions.every((d) => d.distinction.length > 0));
});

test("THREE DIRECTIONS ARE THREE READINGS OF THE OWNER'S REFERENCE, not departures from it", () => {
  // `designReferenceSection` already tells the lane an attached image is "the
  // direction the owner has already chosen. Derive from them." A canvass
  // instruction that did not say the same thing would turn this feature into
  // three unrelated designs and the owner's own image would stop mattering —
  // which is the exact question the whole change exists to answer.
  const p = full();
  assert.match(p, /every direction derives from it/i);
  assert.match(p, /unrelated designs/i);
});

test("THE CANVASS FORBIDS A LOCK AND A SUBDIRECTORY — both are silent breakages", () => {
  const p = full();
  assert.match(p, /DO NOT LOCK ANYTHING/);
  // `publishedMockupPath` builds the served copy from `basename(refPath)`, so
  // three directions each writing `01-hero.png` collide into one card; and
  // `countDesignPngs` is a non-recursive readdir, so a nested layout counts 0.
  assert.match(p, /NO SUBDIRECTORIES/);
});

test("THE CANVASS NAMES THE FROZEN SUITE — what is decided here is not what counts as done", () => {
  assert.match(full(), /acceptance suite was frozen in the spec phase/i);
  assert.match(full(), /does not change what counts as done/i);
});

test("THE AUTO-CHOOSER PICKS A DIRECTION BY SLUG, and never a still", () => {
  // A `choice.json` written at stage A would lock a CANVASS still, and
  // `lockManifest` would then refuse the real hero at the end of stage B with
  // "this run already locked X" — the choice arriving one stage too early and
  // blocking the one that matters.
  const p = full({ autoChoose: true });
  assert.ok(p.includes(DESIGN_DIRECTION_CHOICE_FILE), "the direction choice file is named");
  assert.match(p, /"chosen": "<the slug of one direction>"/);
  assert.match(p, /A SLUG, NOT A PATH/);
  assert.doesNotMatch(p, /"choice\.json"|\/choice\.json/, "the still-choice file has no business at stage A");
  // AND THE EXPANSION ASKS FOR NO CHOICE AT ALL: the host locks the hero itself.
  assert.doesNotMatch(expand({ autoChoose: true }), /CHOOSING THE DIRECTION/);
});

test("THE EXPANSION IS ADDITIVE AND NAMES ONLY THE CHOSEN DIRECTION", () => {
  const p = expand();
  assert.match(p, /STAGE B — EXPAND/);
  assert.ok(p.includes(CHOSEN.name), "the direction is named to the lane building it");
  assert.ok(p.includes(CHOSEN.distinction), "and so is what makes it that direction");
  assert.ok(p.includes(CHOSEN.notes ?? " "), "its own art direction is a Read target");
  assert.match(p, /APPEND TO `refs`, NEVER REPLACE IT/);
  assert.match(p, /EXPAND THAT ONE DIRECTION AND NOTHING ELSE/);
  assert.match(p, /leave their files and their manifest entries/i, "the unchosen ones are a record");
  // THE HOST OWNS THE CHOICE FIELDS. A lane that rewrote them would record a
  // decision nobody made.
  assert.match(p, /records a decision nobody made/);
  const template = canvassTemplate(p);
  assert.equal(template.chosenDirection, CHOSEN.slug, "the template carries the choice through the parser");
  assert.equal(template.directionChoice?.by, "owner");
});

test("DEGRADED MODE CANVASSES TOO — three WRITTEN directions and a manifest to park on", () => {
  // A degraded path that silently falls back to ONE direction is the feature
  // quietly not existing on the machine where the owner can least tell.
  const p = full({ mode: "degraded" });
  assert.match(p, new RegExp(`PRODUCE ${String(DESIGN_DIRECTION_COUNT)} WRITTEN ART DIRECTIONS`));
  assert.match(p, /direction-<slug>\.md/);
  assert.doesNotMatch(p, /gemini-image\.sh/, "a degraded lane is never pointed at the tool");

  // AND THE MANIFEST, WITHOUT WHICH THE OWNER IS NEVER ASKED. Every park
  // condition downstream reads `directions.length > 0 && chosenDirection === null`
  // off the manifest, so three documents and no manifest is a run that chose for
  // him and did not say so.
  const template = canvassTemplate(p);
  assert.deepEqual(template.refs, [], "no stills on a degraded run");
  assert.equal(template.directions.length, 1, "the shape of a direction entry, with its notes file");
  assert.equal(template.directions[0]?.notes, `${WS}/design-refs/direction-editorial-slab.md`);
  assert.match(p, /WITHOUT THAT FILE THE OWNER IS NEVER ASKED/);

  // AND IT MUST NOT WRITE `direction.md` YET — that filename means THE CHOSEN
  // direction, and handing the build one the owner never picked is the failure.
  assert.match(p, /DO NOT write .*direction\.md yet/);
});

test("DEGRADED EXPANSION WRITES direction.md — the two consumers that must not go blind", () => {
  // `readDesignDirection` and `designHandoffSection`'s `dials.length > 0` test.
  const p = expand({ mode: "degraded" });
  assert.match(p, /design-refs\/direction\.md/);
  assert.ok(p.includes(CHOSEN.notes ?? " "), "started from the direction's own document");
  assert.doesNotMatch(p, /PRODUCE 3 WRITTEN ART DIRECTIONS/);
});

test("THE DIALS FOLLOW THE DOCUMENT THE STAGE ACTUALLY WRITES", () => {
  // On a canvass there is no `direction.md` — that filename means THE CHOSEN
  // direction — so pointing the dials at it would ask the lane to write the
  // chosen direction's document before anything is chosen.
  const canvass = full();
  assert.match(canvass, /THE THREE DIALS, PER DIRECTION/);
  assert.match(canvass, /direction-<slug>\.md/);
  for (const dial of DESIGN_DIALS) assert.ok(canvass.includes(dial));
  const expanded = expand();
  assert.match(expanded, /design-refs\/direction\.md/);
  for (const dial of DESIGN_DIALS) assert.ok(expanded.includes(dial));
});

test("A CANVASS NEVER MARKS MOTION, even on a machine that has the video tool", () => {
  // `planVideoLegs` takes the FIRST marked refs up to the cap, and on a
  // canvass-then-expand manifest the canvass refs come FIRST — so a mark here
  // would animate a still from a direction the owner is about to discard, on a
  // metered key, before he has chosen.
  const p = full({ capability: { ...CAP, video: true } });
  assert.match(p, /DO NOT MARK ANYTHING FOR MOTION ON THIS STAGE/);
  assert.doesNotMatch(p, /"animate": true/, "the mark is not in the canvass template");
  assert.equal(planFromTemplate(p).legs.length, 0, "and the template, copied literally, plans no leg");
  // AND IT DOES NOT CLAIM THE MACHINE HAS NO TOOL. That sentence used to be the
  // `else` of the motion branch; adding a third arm to it would have emitted
  // "there is no image-to-video tool installed" on a video-capable canvass.
  assert.doesNotMatch(p, /no image-to-video tool installed/);
});

test("THE DISCARDED DIRECTIONS REACH NEITHER THE BUILD NOR THE GRADER", () => {
  // THE UNCHOSEN DIRECTIONS ARE A RECORD, NOT A RESULT. They stay on disk and on
  // the wire; nothing that builds or grades may name one.
  const chosenRef = `${WS}/design-refs/editorial-slab-01-hero.png`;
  const manifest = parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: [
        { slug: "editorial-slab", name: "Editorial slab", distinction: "d", notes: null },
        { slug: "quiet-grid", name: "Quiet grid", distinction: "d", notes: null },
      ],
      chosenDirection: "editorial-slab",
      directionChoice: { by: "owner", reason: "r", at: "2026-08-03T10:00:00.000Z" },
      refs: [
        { path: chosenRef, section: "hero", aspect: "16:9", intent: "chosen", direction: "editorial-slab" },
        {
          path: `${WS}/design-refs/quiet-grid-01-hero.png`,
          section: "hero",
          aspect: "16:9",
          intent: "offered",
          direction: "quiet-grid",
        },
      ],
      locked: chosenRef,
      lockedBy: "owner",
      lockedReason: "r",
      lockedAt: "2026-08-03T10:00:00.000Z",
    }),
    WS,
  ) as DesignManifest;
  assert.equal(manifest.refs.length, 2, "both are in the manifest");

  const handoff = designHandoffSection({ manifest, mode: "full", workspace: WS, dials: "" });
  assert.ok(handoff.includes("editorial-slab-01-hero.png"), "the chosen direction is what the build is given");
  assert.ok(!handoff.includes("quiet-grid-01-hero.png"), "the discarded one is not");

  const gate = visualGatePrompt({ manifest, workspace: WS, previewUrl: "http://127.0.0.1:4173" });
  assert.ok(gate.includes("editorial-slab-01-hero.png"));
  assert.ok(!gate.includes("quiet-grid-01-hero.png"), "the grader may not compare the build to a design nobody built");
  assert.match(gate, /Resembling a different mockup from the set is not a pass/, "the LOCKED rule is unchanged");
});
