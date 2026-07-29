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
