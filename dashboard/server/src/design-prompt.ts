/**
 * design-prompt.ts — what the DESIGN lane is actually told.
 *
 * EVERY FLAG, THE MODEL DEFAULT, THE ASPECT SET AND THE RETRY CAP ARE COPIED,
 * NOT RECALLED. Sources: spec §7.2 and `~/.claude/agents/taste-frontend-expert.md`
 * (:46 for the closed loop). `-i` is the term that matters most: it is "what
 * holds the palette across the set, and why generation is strictly sequential"
 * (§7.2). Drop it and five images become five unrelated pictures with a manifest
 * claiming they are a set.
 *
 * THE KEY IS NEVER MENTIONED. The script resolves it itself
 * (`$GEMINI_API_KEY` → `$NANOBANANA_API_KEY` → `~/.gemini/api_key`), so an agent
 * never needs it — and a prompt that so much as told it where to look would put
 * the key in the transcript, the build log, `prompt.txt` and the canvas.
 *
 * THE VIDEO ASK IS GATED ON `capability.video`, WHICH IS FALSE THROUGH 2b
 * (§7.1a). The flag gates what is ASKED FOR; it never removes an accepted
 * satisfier from the Layer-2 gate. Those are different things and conflating them
 * would make the gate stricter, which is the opposite of degrade-don't-block.
 *
 * THIS FILE IS PHASE 2C'S ONLY PRODUCTION TRIGGER, and until 2026-07-30 it was
 * not one. `planVideoLegs` gates every leg on `animate === true` in the manifest
 * and `orchestrator.ts:855` says the DESIGN segment writes it — while the branch
 * below said only "Sections you mark for animation", naming the capability and
 * never the field, the value or the file. Seven committed 2c commits were
 * therefore unreachable: the live run's `results/video.json` read
 * `available: true, legsAttempted: 0`, indistinguishable from a manifest that
 * marked nothing, which is exactly what it was. The mark now lives in the
 * TEMPLATE the agent copies, so what pins it is not a grep for a word but
 * `design-prompt.test.ts` parsing that template with `parseDesignManifest` and
 * planning it with `planVideoLegs` — measured red at 0 legs before this change.
 */

import { join } from "node:path";

import type { DesignCapability } from "./design-capability.js";
// THE CAP AND THE ASPECT SET ARE IMPORTED FROM THE PLANNER THAT ENFORCES THEM.
// A `2` and a `"16:9" or "9:16"` typed into this file would be a second
// declaration site for numbers `video-legs.ts` owns, and the failure would be
// silent in the worst direction: a prompt that invites 3 marks while the planner
// drops the third, or invites 21:9 while the planner rejects it. Nothing else is
// imported from the video lane here — the prompt asks for the mark, it does not
// know what is done with it.
import { DEFAULT_VIDEO_LEG_CAP, VEO_ASPECTS } from "./design/video-legs.js";
import type { DesignLaneMode } from "./design-lane.js";
import type { DesignManifest } from "./design-manifest.js";
import { manifestPathFor, refsDirFor } from "./design-manifest.js";
import type { VisualSubstanceMode } from "./visual-substance.js";
import { DEFAULT_VISUAL_SUBSTANCE_MODE, visualObservationBlock } from "./visual-substance.js";

/** Spec §7.3, verbatim. Injected here and again into every build agent's prompt. */
export const DESIGN_DIALS = ["DESIGN_VARIANCE", "MOTION_INTENSITY", "VISUAL_DENSITY"] as const;

/** Spec §7.2: "≥5 PNGs land in `design-refs/`". */
export const MIN_DESIGN_REFS = 5;

/** taste-frontend-expert.md:46 — "max 2 retries per image". */
export const MAX_IMAGE_RETRIES = 2;

/** Where the auto-chooser writes its scoring. Read and validated by the host. */
export const DESIGN_CHOICE_FILE = "choice.json";

export function designSegmentPrompt(input: {
  ticketText: string;
  workspace: string;
  mode: DesignLaneMode;
  capability: DesignCapability;
  autoChoose: boolean;
}): string {
  const refsDir = refsDirFor(input.workspace);
  const manifest = manifestPathFor(input.workspace);
  const lines: string[] = [
    "DESIGN LANE — art direction, before any markup exists.",
    "",
    "This segment produces the design the build is then held to. It writes no",
    "application code: the next segment does that, and it will be given exactly",
    "what you leave behind on disk.",
    "",
    `Ticket: ${input.ticketText}`,
    "",
  ];

  if (input.mode === "degraded") {
    lines.push(
      "IMAGE GENERATION IS UNAVAILABLE ON THIS RUN, and that is expected rather than a",
      "fault — no Gemini key resolves, or the preflight found the chain broken. Do not",
      "attempt it and do not look for a key.",
      "",
      "Produce WRITTEN ART DIRECTION instead, at " + join(refsDir, "direction.md") + ":",
      "the palette with hex values and the role of each, the type system with families,",
      "scale steps and tracking, the section order with the weight each carries, and the",
      "one motion moment the page is built around. Written direction is what the build",
      "segment will be given in place of stills, so it has to be specific enough to",
      "build from.",
      "",
      "DO NOT substitute placeholder imagery. picsum, placehold.co and",
      "unsplash.com/random are denied at write time by the anti-slop hook, so reaching",
      "for them costs the run a denial loop rather than an image. A chosen photograph",
      "with a real URL is fine; a random one is not.",
      "",
    );
  } else {
    lines.push(
      "IMAGE GENERATION",
      "",
      `Use the local tool at ${String(input.capability.imageScript)} — that exact absolute`,
      "path. It resolves its own API credential; you never need one and must never look",
      "for one.",
      "",
      `  ${String(input.capability.imageScript)} "<full art-directed prompt>" -a 16:9 -o ${join(refsDir, "01-hero.png")}`,
      "",
      "  -a  aspect ratio: 1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9   (default 16:9)",
      "  -o  output path",
      "  -i  a reference image, for style-consistency and edit passes",
      "  -m  model override (default gemini-3.1-flash-image-preview — Nano Banana 2)",
      "",
      "It prints the output path on success.",
      "",
      "STRICTLY SEQUENTIAL, ONE IMAGE AT A TIME. After the first image, pass the",
      "previous image with `-i` on every subsequent generation. That is what holds the",
      "palette across the set; generating in parallel produces five unrelated pictures.",
      "",
      `CLOSED LOOP, MANDATORY. After each generation, Read the image file and critique it`,
      `against the routed skill's rules. Regenerate a weak image with a corrected prompt —`,
      `max ${String(MAX_IMAGE_RETRIES)} retries per image — using -i with the best sibling to hold the palette.`,
      "",
      `DELIVERABLE: at least ${String(MIN_DESIGN_REFS)} PNGs in ${refsDir}/, one per section, plus a`,
      `manifest at ${manifest}:`,
      "",
      "  {",
      '    "version": 1,',
      '    "refs": [',
      `      { "path": "${join(refsDir, "01-hero.png")}",`,
      '        "section": "hero",',
      `        "aspect": "${VEO_ASPECTS[0]}",`,
      // THE MARK IS IN THE TEMPLATE, NOT ONLY IN THE PROSE, and the second ref
      // exists so the template can show the mark being WITHHELD. A one-ref
      // example carrying `"animate": true` is copied five times by an agent
      // asked for five sections — the cap violated by the example rather than
      // by the agent. `02-work` also carries a non-Veo aspect on purpose: it is
      // the shape of a ref that is free to be any aspect BECAUSE it is unmarked.
      ...(input.capability.video ? ['        "animate": true,'] : []),
      '        "intent": "what this image is FOR, in one sentence" },',
      `      { "path": "${join(refsDir, "02-work.png")}",`,
      '        "section": "work",',
      '        "aspect": "3:2",',
      '        "intent": "as above, for this section" }',
      "    ]",
      "  }",
      "",
      "`path` must be ABSOLUTE and inside that directory. A manifest with a path",
      "outside it is rejected wholesale by the host, and the lane then counts as having",
      "produced nothing.",
      "",
    );
    if (input.capability.video) {
      lines.push(
        'MOTION LEGS ARE AVAILABLE ON THIS RUN, and `"animate": true` on a ref — exactly as',
        "in the manifest above — is the ONLY thing that asks for one. A marked ref is turned",
        "into a scrubbable .mp4 and a .webp poster, driven from that still as its first",
        "frame. The host does that between this segment and the build, so there is no video",
        "tool for you to run here and you must not go looking for one.",
        "",
        `MARK AT MOST ${String(DEFAULT_VIDEO_LEG_CAP)} REFS, and mark none where the motion does not earn it. ${String(DEFAULT_VIDEO_LEG_CAP)} is a`,
        "cost cap rather than a target: a leg spends on a metered key rather than subscription",
        "quota and takes minutes rather than seconds. A mark past the cap is planned and then",
        "dropped, so marking five buys nothing and records a request nobody honoured. Earlier",
        `refs win, so order the ${String(DEFAULT_VIDEO_LEG_CAP)} you choose ahead of the rest.`,
        "",
        `A MARKED REF MUST BE GENERATED AT ${VEO_ASPECTS.join(" OR ")}. Those two are all the video model`,
        "takes, and the aspect is decided when you generate the still, not when you write the",
        "manifest: a 21:9 still marked for animation is rejected at planning time and yields",
        "no video at all. Leave the mark off the others and they may use any aspect above.",
        "",
        "Mark only a ref whose PNG you have already generated and critiqued. The mark is",
        "resolved against the file on disk, so a mark on a still that does not exist is a",
        "failed leg rather than a skipped one.",
        "",
      );
    } else {
      // DELIBERATELY NAMES NO FILE EXTENSION. The plan's draft of this branch read
      // "do not reference an .mp4 that will not exist" — which put the literal
      // `.mp4` into a prompt built with `capability.video === false`, and Step 1's
      // own `assert.doesNotMatch(p, /\.mp4/)` is the check that 2b never asks for
      // video. The test is what §7.1a constrains, so the wording moved rather than
      // the assertion: the `.mp4` string now appears ONLY under the branch above,
      // which is exactly what makes that branch removable and observable.
      lines.push(
        "NO VIDEO ON THIS RUN. There is no image-to-video tool installed, so do not plan",
        "a scroll-scrubbed video world and do not reference a video file that will not",
        "exist. Motion is authored in code by the build segment, from these stills.",
        "",
      );
    }
  }

  lines.push(
    "THE THREE DIALS. State a value for each, in the manifest's sibling",
    `${join(refsDir, "direction.md")}, and justify it in one line. These exact names are`,
    "carried verbatim into every build agent's prompt, so the build is held to them:",
    ...DESIGN_DIALS.map((dial) => `  - ${dial}`),
    "",
  );

  if (input.autoChoose) {
    lines.push(
      "CHOOSING THE DESIGN. This run selects automatically. Delegate to `ui-designer` —",
      "not to yourself — to score every mockup against the brief and the taste rules,",
      `pick ONE, and write ${join(refsDir, DESIGN_CHOICE_FILE)}:`,
      "",
      '  { "chosen": "<absolute path of one ref>", "reason": "why, in two sentences" }',
      "",
      "The agent that authored the art direction does not grade or choose it. The host",
      "validates the chosen path against the manifest and records who chose and why.",
      "",
    );
  }

  lines.push(
    "WHEN THIS SEGMENT IS DONE, stop. Do not start implementation: the build agents",
    "are not reachable from this segment and every attempt to start one is denied.",
  );
  return lines.join("\n");
}

/**
 * The skill that turns "here are pictures" into a mechanical implementation
 * procedure (spec §7.3 mechanism 3).
 *
 * NAMED FOR INVOCATION, NOT PRELOADED, AND THAT IS A MEASURED CONSTRAINT RATHER
 * THAN A PREFERENCE. §6.3 says "preloaded on frontend builders", but
 * `Options.agents` no longer exists: probe I measured that an `AgentDefinition`
 * registered under a name that also exists in ~/.claude/agents/ is not consulted
 * at all, and every name in DELIVERY_LANES exists on disk. So
 * `AgentDefinition.skills` preloads nothing (api-types.ts:303-308 says exactly
 * this, which is why `graph_skill.source: "preloaded"` has no producer today).
 * The only channel measured to reach a child is the Agent call's own `prompt`.
 *
 * `image-to-code` is the SKILL.md `name:`; the directory is
 * `image-to-code-skill`. §6.3's correction records that the SDK accepts either,
 * so the canonical name is used here.
 */
export const IMAGE_TO_CODE_SKILL = "image-to-code";

/**
 * The block the orchestrator injects into EVERY build agent's prompt.
 *
 * ALL THREE OF §7.3's MECHANISMS OR NONE OF THEM. Subagents do not share
 * context: a mockup living only in the designer's transcript is invisible
 * downstream, so the filesystem location, every absolute path, and the skill that
 * knows what to do with them all have to cross this seam together. Ship two and
 * the third's absence is silent — the build simply looks like it ignored the
 * design.
 *
 * EACH MECHANISM IS SEPARATELY REMOVABLE AND SEPARATELY OBSERVED. The directory
 * sentence below is not decoration: it is the only line that states mechanism 1
 * independently of the ref paths, which all contain the directory as a substring.
 * Delete it and `MECHANISM 1` goes red while `MECHANISM 2` stays green — that
 * control was executed, and it is the difference between three mechanisms and
 * one mechanism with two decorations.
 */
export function designHandoffSection(input: {
  manifest: DesignManifest | null;
  mode: DesignLaneMode;
  workspace: string;
  dials: string;
}): string {
  if (input.mode === "off") return "";
  const refsDir = refsDirFor(input.workspace);

  if (input.mode === "degraded" || input.manifest === null || input.manifest.refs.length === 0) {
    // TWO REASONS FOR ZERO STILLS, AND THEY MUST NOT READ THE SAME. THE TRAP:
    // "`degraded` and `full`-with-zero produce the same file count and must never
    // produce the same report." This function is one of the two reports a build
    // agent actually reads, and the plan's draft keyed the whole branch on
    // `manifest === null` — so a `full` lane whose image chain died was told
    // "image generation was unavailable", which is false about the one thing the
    // phase exists to keep honest.
    //
    // `dials` IS THE PRESENCE OF direction.md, per this function's own contract
    // ("the text of direction.md, or \"\" when absent"), so it is also what decides
    // whether pointing a child at that file is a Read it can satisfy. A `Read` on
    // a file nobody wrote surfaces several turns deep as an agent's confusion
    // rather than as a design fault — the same reason `pruneMissingRefs` exists.
    const wroteDirection = input.dials.length > 0;
    const zero: string[] =
      input.mode === "degraded"
        ? [
            "THE DESIGN LANE PRODUCED NO STILLS on this run — image generation was",
            "unavailable on this machine, which is expected rather than a fault.",
          ]
        : [
            "THE DESIGN LANE PRODUCED NO STILLS on this run, and it was EXPECTED TO.",
            "Image generation was available and the lane came back with nothing, so this",
            "run has no chosen design and no reference to build against. Build the ticket",
            "on your own judgement, and do not describe the result as matching a design.",
          ];
    if (wroteDirection) {
      zero.push(
        "",
        "What the lane did leave is written art direction:",
        "",
        `  Read ${join(refsDir, "direction.md")}`,
        "",
        "Build to that document. It is the only design input this run has, so it is the",
        "one the visual gate will read your work against.",
        "",
        input.dials,
      );
    } else {
      zero.push(
        "",
        "There is no written art direction either, so this run has no design input at",
        "all. Do not go looking for one.",
      );
    }
    return zero.join("\n");
  }

  const lines: string[] = [
    "THE DESIGN IS ALREADY MADE. Build to it; do not re-invent it.",
    "",
    `  Mockups live in ${refsDir}/ — inside this workspace, which is the only`,
    "  directory anything here may write to.",
    "",
    "Read each of these. They render visually to you; they are not filenames to",
    "guess at:",
    "",
  ];
  for (const ref of input.manifest.refs) {
    const locked = ref.path === input.manifest.lockedMockup;
    lines.push(
      `  ${locked ? "LOCKED  " : "        "}${ref.path}` +
        `   [${ref.section}, ${ref.aspect}] ${ref.intent}`,
    );
  }
  lines.push("");
  lines.push(
    input.manifest.lockedMockup === null
      ? "No mockup is locked on this run, so the set as a whole is the reference."
      : `The LOCKED mockup is the design that was chosen: ${input.manifest.lockedMockup}. ` +
        `Resembling a different one from the set is not a pass.`,
    "",
    `Invoke the \`${IMAGE_TO_CODE_SKILL}\` skill before you write markup. It is the`,
    "procedure for turning these images into an implementation — read the images",
    "deeply first, then build to them section by section.",
    "",
  );
  if (input.dials.length > 0) {
    lines.push("THE DIALS THE DESIGN WAS SET TO. Build to these values:", "", input.dials, "");
  }
  return lines.join("\n");
}

/**
 * The visual gate is `ui-designer`, and the author is named here only so the
 * separation is checkable rather than remembered (spec §7.4: "an agent grading
 * its own art direction is not a gate").
 */
export const VISUAL_GATE_AGENT = "ui-designer";
export const VISUAL_GATE_AUTHOR = "taste-frontend-expert";
export const VISUAL_GATE_REPORT = "review/visual-gate.md";

/**
 * THE GATE NOW CARRIES TWO TIERS, AND THE PROMPT SAYS WHICH IS WHICH.
 *
 * Until 2026-07-29 this prompt opened "QUALITY tier, and it NEVER blocks a run",
 * full stop. That is still true of TASTE and it is stated more loudly than
 * before — the owner's standing decision holds, because subjective judgement
 * rendered in red trains the owner to ignore red. What changed is that a narrow,
 * ENUMERATED set of OBJECTIVE observations (`visual-substance.ts`) now rides in
 * the same report at FUNCTIONAL, and a grader that believes everything it writes
 * is non-blocking will write the objective half like a note.
 *
 * THE SPLIT IS IN THE TEXT THE GRADER READS, not only in the code that scores
 * it. A model told "nothing here can fail" and then scored as if something could
 * is being graded against a rubric it was never shown.
 *
 * THE MODE IS IN THE PROMPT TOO. `mode` defaults to
 * `DEFAULT_VISUAL_SUBSTANCE_MODE`, which is `"shadow"` — evaluated, recorded,
 * gating nothing. It is optional so that every existing call site keeps
 * compiling and keeps getting the safe default; a required parameter here would
 * have made "which mode" a thing each caller decides afresh.
 */
export function visualGatePrompt(input: {
  manifest: DesignManifest | null;
  workspace: string;
  previewUrl: string | null;
  mode?: VisualSubstanceMode;
}): string {
  const mode = input.mode ?? DEFAULT_VISUAL_SUBSTANCE_MODE;
  const lines: string[] = [
    "VISUAL GATE — TWO TIERS IN ONE REPORT, AND ONLY ONE OF THEM CAN FAIL A RUN.",
    "",
    "You are grading, not building, and you did not author what you are grading.",
    "",
    "TASTE IS QUALITY TIER AND IT NEVER BLOCKS A RUN. The palette, the type pairing, the motion",
    "character, the layout scaffold, how it compares to the mockup — every one of those informs the",
    "owner and none of them fail the build. Write them as notes, because that is what they are.",
    "",
    "THE OBJECTIVE OBSERVATIONS BELOW ARE FUNCTIONAL TIER. They ask *did you build the thing*, not",
    "*is it nice*, and the set is fixed in code — you answer it, you do not decide what belongs in",
    "it. Keep the two halves separate in your report; a taste note filed as an objective observation",
    "is a false fail, and an objective observation filed as taste is a false pass.",
    "",
  ];
  lines.push(
    input.previewUrl === null
      ? "There is no preview URL for this run, so no screenshots can be captured. Grade what " +
        "you can from the source in the workspace and say plainly which criteria you could not " +
        "answer — an unanswerable criterion reported as a pass is worse than one reported as " +
        "unknown. Every objective observation below is therefore UNKNOWN/no_screenshot on this " +
        "run: none of them may be answered from source, because they are questions about pixels."
      : `The built site is running at ${input.previewUrl}. Capture ONE screenshot per section with ` +
        `Playwright, at the aspect ratio of that section's mockup, so the pair is comparable.`,
    "",
  );

  if (input.manifest === null || input.manifest.refs.length === 0) {
    lines.push(
      "THERE IS NO REFERENCE IMAGE for this run — the DESIGN lane degraded. Grade against the",
      "rule-based floor alone and say so in the report; do not invent a reference.",
      "",
    );
  } else {
    lines.push("Read each mockup and its screenshot as a pair:", "");
    for (const ref of input.manifest.refs) {
      const locked = ref.path === input.manifest.lockedMockup;
      lines.push(`  ${locked ? "LOCKED  " : "        "}${ref.path}   [${ref.section}, ${ref.aspect}] ${ref.intent}`);
    }
    lines.push(
      "",
      input.manifest.lockedMockup === null
        ? "No mockup was locked, so grade against the set and say that the comparison is loose."
        : `Grade against the LOCKED mockup: ${input.manifest.lockedMockup}. The question is "does this ` +
          `match the design that was CHOSEN", not "does this resemble something we generated". ` +
          `Resembling a different mockup from the set is not a pass.`,
      "",
    );
  }

  lines.push(visualObservationBlock(mode), "");

  lines.push(
    `Write ${VISUAL_GATE_REPORT} in TWO CLEARLY SEPARATED SECTIONS.`,
    "",
    "  SECTION 1 — OBJECTIVE OBSERVATIONS (FUNCTIONAL). One line per observation per screenshot:",
    "  the observation id, satisfied / violated / unknown, the unknown reason where it applies,",
    "  and one sentence of what you saw. Nothing that is not on the fixed list may appear here.",
    "",
    "  SECTION 2 — TASTE (QUALITY). One verdict per section, each naming the criterion, what you",
    "  saw, and what would close the gap. Every criterion here is QUALITY tier — it reports, it",
    "  never blocks.",
    "",
    "Name no screenshot file and no path in the report. Masking is applied at capture time and is",
    "the only masking there is, so a path in a committed record outlives any later correction.",
  );
  return lines.join("\n");
}
