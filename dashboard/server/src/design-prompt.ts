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
 */

import { join } from "node:path";

import type { DesignCapability } from "./design-capability.js";
import type { DesignLaneMode } from "./design-lane.js";
import type { DesignManifest } from "./design-manifest.js";
import { manifestPathFor, refsDirFor } from "./design-manifest.js";

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
      '        "aspect": "16:9",',
      '        "intent": "what this image is FOR, in one sentence" }',
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
        "MOTION LEGS ARE AVAILABLE ON THIS RUN. Sections you mark for animation may be",
        "given a scrubbable .mp4 and a .webp poster; generate those stills at 16:9 or",
        "9:16, which is all the video model accepts.",
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

export function visualGatePrompt(input: {
  manifest: DesignManifest | null;
  workspace: string;
  previewUrl: string | null;
}): string {
  const lines: string[] = [
    "VISUAL GATE — QUALITY tier, and it NEVER blocks a run.",
    "",
    "You are grading, not building, and you did not author what you are grading.",
    "Report what you find; a finding informs the owner and does not fail the build.",
    "",
  ];
  lines.push(
    input.previewUrl === null
      ? "There is no preview URL for this run, so no screenshots can be captured. Grade what " +
        "you can from the source in the workspace and say plainly which criteria you could not " +
        "answer — an unanswerable criterion reported as a pass is worse than one reported as unknown."
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

  lines.push(
    `Write ${VISUAL_GATE_REPORT}: one verdict per section, each naming the criterion, what you saw,`,
    "and what would close the gap. Every criterion is QUALITY tier — it reports, it never blocks.",
  );
  return lines.join("\n");
}
