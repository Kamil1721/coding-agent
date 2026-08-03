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
import type { DesignDirection, DesignManifest } from "./design-manifest.js";
import { builtManifest, manifestPathFor, refsDirFor } from "./design-manifest.js";
import type { VisualSubstanceMode } from "./visual-substance.js";
import { DEFAULT_VISUAL_SUBSTANCE_MODE, visualObservationBlock } from "./visual-substance.js";

/** Spec §7.3, verbatim. Injected here and again into every build agent's prompt. */
export const DESIGN_DIALS = ["DESIGN_VARIANCE", "MOTION_INTENSITY", "VISUAL_DENSITY"] as const;

/** Spec §7.2: "≥5 PNGs land in `design-refs/`". THE STAGE-B FLOOR, unchanged. */
export const MIN_DESIGN_REFS = 5;

/** taste-frontend-expert.md:46 — "max 2 retries per image". */
export const MAX_IMAGE_RETRIES = 2;

/** Where the auto-chooser writes its scoring. Read and validated by the host. */
export const DESIGN_CHOICE_FILE = "choice.json";

/**
 * Stage A: how many DISTINCT directions the canvass offers.
 *
 * THREE, AND THE ARITHMETIC IS THE ARGUMENT. A naive three-direction canvass
 * renders every direction at full section coverage: 3 × 7 = 21 generations
 * against today's measured 5–7. This shape renders 3 × 2 = 6 and then expands
 * only the chosen one (5–7), so a run with no dialogue costs 11–13. Saturating
 * BOTH caps below still lands at 6 + 6 + 7 = 19, under the naive canvass alone.
 */
export const DESIGN_DIRECTION_COUNT = 3;

/**
 * Stage A: sections per direction — the hero plus one signature section, SAME
 * aspect across all three.
 *
 * COMPARABILITY IS THE FEATURE. If the three directions render different
 * sections, the owner is not choosing between directions, he is choosing between
 * pictures: direction 1's hero against direction 3's footer answers nothing.
 */
export const DESIGN_CANVASS_SECTIONS = 2;

/** The stage-A floor. `MIN_DESIGN_REFS` is the stage-B floor and is unchanged. */
export const MIN_CANVASS_REFS = DESIGN_DIRECTION_COUNT * DESIGN_CANVASS_SECTIONS;

/**
 * Owner turns at the design park. Every claimed message costs one, whatever it
 * contained — `plan-state.ts` rule 6's precedent, and the reason a refusal
 * ("that direction does not exist") still spends a turn while spending no image.
 *
 * STRICTLY ABOVE `MAX_DESIGN_ON_DEMAND_RENDERS`, AND THE ARITHMETIC IS THE
 * ARGUMENT. Every render also spends a turn, so a turn cap at or below the render
 * cap makes the render cap unreachable: at 4 against 6 (measured 2026-08-03) a
 * burst of six requests produced FOUR images and a turn-cap refusal on the fifth,
 * while `rendersMax: 6` went out on the wire and the panel told the owner he had
 * six renders left. Eight is six renders plus two refusals — a direction that
 * does not exist, a message that names no section — and it does not move the
 * spend: the images are bounded by the render cap below, which is what the
 * canvass cost arithmetic (6 + 6 + 7 = 19) counts.
 */
export const MAX_DESIGN_LOCK_TURNS = 8;

/**
 * On-demand generations for the whole run. ONE per request, retries included —
 * there are none.
 *
 * AN ON-DEMAND STILL IS A PREVIEW, NOT A BUILD REFERENCE, so it carries no
 * closed-loop critique and `MAX_IMAGE_RETRIES` does not apply to it. A failed
 * generation still spends its render and is recorded as failed, which is what
 * makes the cost arithmetic above exact rather than optimistic.
 *
 * THIS IS THE BINDING CAP ON SPEND, and `MAX_DESIGN_LOCK_TURNS` sits above it so
 * that stays true — a turn cap underneath would bound the images instead, at a
 * number the wire never carries.
 */
export const MAX_DESIGN_ON_DEMAND_RENDERS = 6;

/** Where the auto-chooser writes its DIRECTION choice. Sibling of `DESIGN_CHOICE_FILE`. */
export const DESIGN_DIRECTION_CHOICE_FILE = "direction-choice.json";

/**
 * WHICH HALF OF THE TWO-STAGE LANE THIS PROMPT IS FOR.
 *
 * `"canvass"` asks for DESIGN_DIRECTION_COUNT distinct directions at
 * DESIGN_CANVASS_SECTIONS comparable stills each; `"expand"` takes the direction
 * that was chosen and asks for today's full per-section set of it alone. The
 * choice happens BETWEEN them, at the existing design-lock park — which is inside
 * the `build` phase, AFTER the suite was frozen in `spec`. Nothing either stage
 * produces can change what counts as done.
 */
export type DesignPromptStage = "canvass" | "expand";

/**
 * WHAT MAKES TWO DIRECTIONS GENUINELY DIFFERENT, enumerated rather than implied.
 *
 * DISTINCTNESS IS THE FEATURE, and it is the half a model satisfies loosely by
 * default: three directions that differ only in accent colour are ONE direction
 * shown three times, and the owner's choice then decides nothing. Each axis below
 * is something a reader can SEE at thumbnail size in a hero, which is the size
 * these are actually compared at.
 */
const DIRECTION_AXES: readonly string[] = [
  "the TYPE SYSTEM — families, the display/text contrast, weight and tracking",
  "the LAYOUT SCAFFOLD — column structure, where the page's asymmetry lives, how the eye enters",
  "DENSITY — how much air, how big the smallest text is, how many things share a viewport",
  "the MOTION IDEA — the one thing that moves and what it is doing (this is authored in code later)",
];

export function designSegmentPrompt(input: {
  ticketText: string;
  workspace: string;
  mode: DesignLaneMode;
  capability: DesignCapability;
  autoChoose: boolean;
  /** Which half of the two-stage lane. See {@link DesignPromptStage}. */
  stage: DesignPromptStage;
  /**
   * The direction the owner (or `ui-designer`, or the fallback) picked. Non-null
   * on `stage: "expand"` and null on `"canvass"` — the expand prompt is built
   * from it, so a null here on the expand stage would ask for a full set of
   * nothing in particular.
   */
  chosen: DesignDirection | null;
}): string {
  const refsDir = refsDirFor(input.workspace);
  const manifest = manifestPathFor(input.workspace);
  const canvass = input.stage === "canvass";
  const chosen = input.chosen;
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

  lines.push(
    ...(canvass
      ? [
          `STAGE A — CANVASS. You are offering ${String(DESIGN_DIRECTION_COUNT)} DISTINCT DIRECTIONS for the owner to`,
          "choose between, not one design. He picks one; only then is that one expanded to",
          "the full set, and the others are kept on disk as a record of what was offered.",
          "",
          "THE ACCEPTANCE SUITE WAS FROZEN IN THE SPEC PHASE, which is over. What is decided",
          "here changes what gets built and what the build is compared against VISUALLY — it",
          "does not change what counts as done. Do not propose a direction that requires a",
          "section, page or capability the ticket did not ask for.",
          "",
        ]
      : [
          "STAGE B — EXPAND. The direction has already been chosen and the canvass is over.",
          `The chosen direction is "${chosen?.name ?? "(unnamed)"}" (slug \`${chosen?.slug ?? ""}\`):`,
          `  ${chosen?.distinction ?? ""}`,
          "",
          ...(chosen?.notes === null || chosen?.notes === undefined
            ? []
            : [`Read ${chosen.notes} — that is this direction's own art direction, and`, "you are extending it, not reopening it.", ""]),
          "EXPAND THAT ONE DIRECTION AND NOTHING ELSE. The directions that were not chosen",
          "are a record of what was offered: leave their files and their manifest entries",
          "exactly as they are, do not improve them, and do not blend them into this one.",
          "",
        ]),
  );

  if (input.mode === "degraded") {
    lines.push(
      "IMAGE GENERATION IS UNAVAILABLE ON THIS RUN, and that is expected rather than a",
      "fault — no Gemini key resolves, or the preflight found the chain broken. Do not",
      "attempt it and do not look for a key.",
      "",
    );
    if (canvass) {
      /*
       * THE DEGRADED CANVASS IS NOT A SMALLER CANVASS — IT IS THE SAME CHOICE IN
       * WORDS. A degraded lane that produced ONE written direction is the feature
       * quietly not existing on the machine that has no key, which is the machine
       * where an owner is least able to tell.
       *
       * AND IT MUST WRITE A MANIFEST, WHICH IT NEVER DID BEFORE. `refs: []` with a
       * populated `directions` is what lets the host park at all: every park
       * condition downstream reads `directions.length > 0 && chosenDirection ===
       * null` off the manifest, so without this file a degraded run canvasses in
       * prose and then walks straight past the choice.
       */
      lines.push(
        `PRODUCE ${String(DESIGN_DIRECTION_COUNT)} WRITTEN ART DIRECTIONS, one per direction, at`,
        `${join(refsDir, "direction-<slug>.md")} — e.g. ${join(refsDir, "direction-editorial-slab.md")}.`,
        "Each one states: the palette with hex values and the role of each, the type system",
        "with families, scale steps and tracking, the section order with the weight each",
        "carries, and the one motion moment the page is built around. Written direction is",
        "what the build segment will be given in place of stills, so each has to be",
        "specific enough to build from on its own.",
        "",
        `DO NOT write ${join(refsDir, "direction.md")} yet. That filename means THE CHOSEN`,
        "direction, and nothing has been chosen. Writing it now would hand the build a",
        "direction the owner never picked.",
        "",
        `AND WRITE THE MANIFEST at ${manifest}, with an EMPTY refs array — there are no`,
        "stills on this run — and one entry per direction:",
        "",
        "  {",
        '    "version": 1,',
        '    "refs": [],',
        '    "directions": [',
        '      { "slug": "editorial-slab",',
        '        "name": "Editorial slab",',
        '        "distinction": "one sentence on what this does that the other two do not",',
        `        "notes": "${join(refsDir, "direction-editorial-slab.md")}" }`,
        "    ]",
        "  }",
        "",
        "WITHOUT THAT FILE THE OWNER IS NEVER ASKED. The dashboard reads `directions` out",
        "of the manifest to put the choice in front of him; three documents and no",
        "manifest is a run that chose for him and did not say so.",
        "",
      );
    } else {
      lines.push(
        `Produce the chosen direction's document at ${join(refsDir, "direction.md")}:`,
        "the palette with hex values and the role of each, the type system with families,",
        "scale steps and tracking, the section order with the weight each carries, and the",
        "one motion moment the page is built around. Written direction is what the build",
        "segment will be given in place of stills, so it has to be specific enough to",
        "build from.",
        "",
        ...(chosen?.notes === null || chosen?.notes === undefined
          ? []
          : [
              `Start from ${chosen.notes} and deepen it to that level of detail. Do not`,
              "restate the other directions and do not hedge between them.",
              "",
            ]),
        "LEAVE THE MANIFEST'S `directions`, `chosenDirection` and `directionChoice`",
        "EXACTLY AS THEY ARE. The host wrote the choice; rewriting it would record a",
        "decision nobody made.",
        "",
      );
    }
    lines.push(
      "DO NOT substitute placeholder imagery. picsum, placehold.co and",
      "unsplash.com/random are denied at write time by the anti-slop hook, so reaching",
      "for them costs the run a denial loop rather than an image. A chosen photograph",
      "with a real URL is fine; a random one is not.",
      "",
    );
  } else {
    lines.push(
      /*
       * WHO AUTHORS THE ART DIRECTION — ADDED 2026-07-30, AND IT WAS MISSING.
       *
       * `VISUAL_GATE_AUTHOR` has been exported from this file since it was written,
       * and `design-prompt.test.ts` asserts it differs from `VISUAL_GATE_AGENT`. It
       * was never put into a prompt. Its only non-declaration reader was that test.
       *
       * The consequence, measured on `run-2026-07-29T23-28-46-665Z-3d4d1ccb`: the
       * whole `IMAGE GENERATION` block below addresses the orchestrator in the second
       * person ("Use the local tool", "Read the image file and critique it"), so the
       * orchestrator ran all six `gemini-image.sh` calls itself. `taste-frontend-expert`
       * appeared only in `graph_inventory.allowedAgents` — permitted, never spawned —
       * and `ui-designer` then scored images the orchestrator had authored. Zero
       * `graph_agent` events named the author seat; the run made exactly two Agent
       * calls, `context-manager` and `ui-designer`.
       *
       * That is the "author does not grade its own work" rule holding in the letter
       * and failing in fact, and it is this repository's signature defect precisely:
       * the assertion and the production path were never connected. The paragraph
       * below is the connection.
       *
       * IT MIRRORS THE `CHOOSING THE DESIGN` WORDING ON PURPOSE — "Delegate to X, not
       * to yourself" is the phrasing the orchestrator already demonstrably obeys for
       * the choosing step, which is the one delegation this pipeline has been observed
       * to perform correctly.
       */
      "WHO AUTHORS THIS. The art direction is authored by",
      `\`${VISUAL_GATE_AUTHOR}\` — delegate to it, not to yourself. Carry the whole of`,
      "the IMAGE GENERATION brief below into its prompt verbatim, including the exact",
      "tool path, the sequential -i rule and the closed-loop critique. It owns the",
      "prompts, the retries and the critique; you own the manifest and the dials.",
      "",
      `\`${VISUAL_GATE_AGENT}\` MUST NOT be the author. It is the visual gate and the`,
      "design-lock chooser later in this run, and an agent that grades what it wrote is",
      "not a gate. That separation is why there are two seats and not one.",
      "",
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
      // THE FLAT-DIRECTORY RULE IS PROMPT TEXT BECAUSE NOTHING ELSE ENFORCES IT.
      // `insideDir` permits subdirectories, so a manifest naming
      // `design-refs/editorial-slab/01-hero.png` parses — and then two mechanical
      // things break at once, both measured. `publishedMockupPath` builds the
      // served copy from `basename(refPath)`, so three directions each writing
      // `01-hero.png` collide into ONE card and the click-to-ref translation
      // matches three cards to one ref; and `countDesignPngs` is a non-recursive
      // `readdirSync` whose content test returns false on a directory entry
      // (`readSync` on a directory throws EISDIR), so a nested layout counts 0
      // images and classifies a healthy lane `no-images`.
      `EVERYTHING GOES DIRECTLY IN ${refsDir}/ — NO SUBDIRECTORIES. The filename`,
      "carries the direction, not a folder. A still written one level down is not",
      "counted, is published under a name that collides with another direction's, and",
      "the lane is then reported as having produced nothing.",
      "",
    );
    lines.push(...(canvass ? canvassBrief(refsDir, manifest) : expandBrief(refsDir, manifest, chosen, input.capability.video)));
    lines.push(
      "`path` must be ABSOLUTE and inside that directory. A manifest with a path",
      "outside it is rejected wholesale by the host, and the lane then counts as having",
      "produced nothing.",
      "",
    );
    if (!input.capability.video) {
      // DELIBERATELY NAMES NO FILE EXTENSION. The plan's draft of this branch read
      // "do not reference an .mp4 that will not exist" — which put the literal
      // `.mp4` into a prompt built with `capability.video === false`, and Step 1's
      // own `assert.doesNotMatch(p, /\.mp4/)` is the check that 2b never asks for
      // video. The test is what §7.1a constrains, so the wording moved rather than
      // the assertion: the `.mp4` string now appears ONLY under the branch below,
      // which is exactly what makes that branch removable and observable.
      //
      // FIRST, NOT LAST, SINCE 2026-08-03. It used to be the `else` of the
      // motion-legs branch; adding the canvass arm to that branch would have made
      // "there is no image-to-video tool installed" the else of a THREE-way choice
      // and emitted it on a video-capable canvass — a false sentence about the
      // machine, in the one file whose job is not to say false things about it.
      lines.push(
        "NO VIDEO ON THIS RUN. There is no image-to-video tool installed, so do not plan",
        "a scroll-scrubbed video world and do not reference a video file that will not",
        "exist. Motion is authored in code by the build segment, from these stills.",
        "",
      );
    } else if (canvass) {
      /*
       * NO MOTION MARKS ON A CANVASS, AND THE REASON IS SPEND ON A DISCARDED
       * DESIGN. `planVideoLegs` takes the FIRST marked refs up to the cap, and on
       * a canvass-then-expand manifest the canvass refs come first — so a mark
       * here would animate a still from a direction the owner may be about to
       * throw away, on a metered key, before he has chosen. `builtManifest` is the
       * host-side half of the same guard; this paragraph is the half that keeps
       * the lane from spending the request in the first place.
       */
      lines.push(
        "DO NOT MARK ANYTHING FOR MOTION ON THIS STAGE. Motion legs exist on this run and",
        "they are asked for when the chosen direction is expanded, not here — a leg spends",
        "on a metered key, and two of these three directions are about to be discarded.",
        "Say which motion idea each direction is built around in its `direction-<slug>.md`;",
        "that is what carries forward.",
        "",
      );
    } else {
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
    }
  }

  // THE DIALS FOLLOW THE DOCUMENT THE STAGE ACTUALLY WRITES. On a canvass there
  // is no `direction.md` — that filename means THE CHOSEN direction — so pointing
  // the dials at it would ask the lane to write the chosen direction's document
  // before anything is chosen, which is the one file the degraded branch above is
  // explicit about not writing yet.
  lines.push(
    ...(canvass
      ? [
          "THE THREE DIALS, PER DIRECTION. State a value for each in that direction's own",
          `${join(refsDir, "direction-<slug>.md")}, and justify it in one line. They are part`,
          "of what makes the directions distinct, so do not give all three the same values:",
        ]
      : [
          "THE THREE DIALS. State a value for each, in the manifest's sibling",
          `${join(refsDir, "direction.md")}, and justify it in one line. These exact names are`,
          "carried verbatim into every build agent's prompt, so the build is held to them:",
        ]),
    ...DESIGN_DIALS.map((dial) => `  - ${dial}`),
    "",
  );

  if (input.autoChoose && canvass) {
    /*
     * THE AUTO-CHOOSER NOW PICKS A DIRECTION, NOT A STILL, and it writes a
     * different file to say so. `choice.json` still means "one of these refs is
     * the canonical still"; the host applies that itself at the END of stage B,
     * from `heroRefFor(chosen)`, so asking for it here would let `ui-designer`
     * lock a canvass still and `lockManifest` would then refuse the real hero
     * ("this run already locked X") — the choice arriving one stage too early and
     * blocking the one that matters.
     */
    lines.push(
      "CHOOSING THE DIRECTION. This run selects automatically. Delegate to `ui-designer`",
      "— not to yourself — to score the DIRECTIONS against the brief and the taste rules,",
      `pick ONE, and write ${join(refsDir, DESIGN_DIRECTION_CHOICE_FILE)}:`,
      "",
      '  { "chosen": "<the slug of one direction>", "reason": "why, in two sentences" }',
      "",
      "A SLUG, NOT A PATH. The agent that authored the art direction does not grade or",
      "choose it. The host validates the slug against the manifest, records who chose and",
      "why, and then asks for that direction to be expanded — you do not expand it here.",
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
 * STAGE A's DELIVERABLE — the part a model can satisfy loosely, written so it
 * cannot.
 *
 * TWO PROPERTIES CARRY THE WHOLE FEATURE AND BOTH ARE STATED AS COUNTS AND
 * NAMES rather than as adjectives:
 *
 *  COMPARABILITY. The same sections, in the same order, at the same aspect,
 *  across every direction. Three directions rendering hero/work, hero/footer and
 *  hero/pricing are not three directions the owner can compare — he is comparing
 *  pictures, and the one with the nicest picture wins for a reason that has
 *  nothing to do with the design. AND IT IS THE ONE OF THE TWO THAT IS CHECKED,
 *  since 2026-08-03: `auditCanvass` reads the section set and the aspect back off
 *  the manifest and `classifyDesignLane` fails the canvass by direction name.
 *  Until then this was a paragraph in a prompt, and a request to a model is not a
 *  feature. The brief says so below in the same terms the check uses — minus
 *  ORDER, which is asked for and not measured.
 *
 *  DISTINCTNESS. `DIRECTION_AXES` is enumerated into the prompt and the lane must
 *  state, per direction, one sentence on what it does that the others do not.
 *  Three palettes of one layout is one direction shown three times — AND NOTHING
 *  CHECKS IT. `distinction` is a sentence the lane wrote about its own work, and
 *  no property of a PNG this host can read says whether two designs differ. This
 *  half stays a request, which is why it is spelled out by axis rather than
 *  asked for as an adjective.
 *
 * AND DERIVE, DO NOT DEPART: `designReferenceSection` already tells the lane an
 * attached image is "the direction the owner has already chosen. Derive from
 * them." Three directions must be three READINGS of that reference, or the
 * feature turns into three unrelated designs and the owner's own image stops
 * mattering — which is the exact question this whole change exists to answer.
 */
function canvassBrief(refsDir: string, manifestPath: string, hero = "hero", second = "work"): readonly string[] {
  const slugA = "editorial-slab";
  const slugB = "quiet-grid";
  return [
    `DELIVERABLE: ${String(DESIGN_DIRECTION_COUNT)} DISTINCT DIRECTIONS × ${String(DESIGN_CANVASS_SECTIONS)} STILLS = ${String(MIN_CANVASS_REFS)} PNGs, plus a`,
    `manifest at ${manifestPath} and one ${join(refsDir, "direction-<slug>.md")} per`,
    "direction.",
    "",
    `SAME SECTIONS, SAME ORDER, SAME ASPECT, IN ALL ${String(DESIGN_DIRECTION_COUNT)} DIRECTIONS. Pick the ${String(DESIGN_CANVASS_SECTIONS)} sections`,
    `once — the ${hero} plus ONE signature section the ticket makes important — and render`,
    "exactly those, in that order, at one aspect ratio, for every direction. This is not",
    "a formality: the owner is choosing between DIRECTIONS, and a set where direction 1",
    `shows its ${hero} and direction 2 shows its footer makes him choose between pictures`,
    "instead. If the sections or the aspect differ between directions, the canvass has",
    "failed whatever the individual images look like.",
    "",
    // STATED AS A CHECK BECAUSE IT IS ONE, 2026-08-03. Everything above was a
    // request, and `auditCanvass` → `classifyDesignLane` now reads the same three
    // properties off the manifest and fails the lane by direction NAME. Saying so
    // here is not a threat: the lane can only correct what it knows is measured,
    // and the sentence stops at what the code actually binds — ORDER is asked for
    // above and is not among them.
    "THE HOST CHECKS THIS OFF THE MANIFEST YOU WRITE, and names the direction that broke",
    `it: all ${String(DESIGN_DIRECTION_COUNT)} directions must be declared, every direction must carry at least`,
    `${String(DESIGN_CANVASS_SECTIONS)} DISTINCT sections, all directions must carry the SAME sections, and every`,
    "still must be at ONE aspect. Two stills of the same section count as ONE —",
    `rendering the hero twice does not make a direction comparable, and neither does`,
    `${String(MIN_CANVASS_REFS)} stills of one direction. A direction with no stills fails the lane even`,
    `when the other ${String(DESIGN_DIRECTION_COUNT - 1)} carry ${String(MIN_CANVASS_REFS)} between them.`,
    "",
    "MAKE THEM GENUINELY DIFFERENT. Two directions that differ only in accent colour are",
    "one direction shown twice, and a choice between them decides nothing. Differ on at",
    "least two of:",
    ...DIRECTION_AXES.map((axis) => `  - ${axis}`),
    "",
    "AND THEY ARE ALL READINGS OF THE SAME BRIEF. Where the owner attached a reference,",
    "every direction derives from it — three ways of doing what he showed you, not three",
    "unrelated designs. A direction that departs from his reference is not an option he",
    "asked for.",
    "",
    "STATE THE DISTINCTION, ONE SENTENCE PER DIRECTION, in the manifest's `distinction`",
    "field: what THIS direction does that the OTHER TWO do not. Not what it is like —",
    "what it does differently. That sentence is what the owner reads under each set.",
    "",
    `FILENAMES CARRY THE DIRECTION: <slug>-NN-<section>.png, numbered from 01 in the`,
    `order above. So ${join(refsDir, `${slugA}-01-${hero}.png`)} and`,
    `${join(refsDir, `${slugA}-02-${second}.png`)}, then the same two for the next slug.`,
    "The slug is lowercase letters, digits and hyphens, at most 32 characters, and it is",
    "the same string in the filename, in `directions[].slug` and in each ref's",
    "`direction`. A ref naming a direction you did not declare fails the lane.",
    "",
    `  {`,
    `    "version": 1,`,
    `    "directions": [`,
    `      { "slug": "${slugA}",`,
    `        "name": "Editorial slab",`,
    `        "distinction": "one sentence: what this does that the other two do not",`,
    `        "notes": "${join(refsDir, `direction-${slugA}.md`)}" },`,
    `      { "slug": "${slugB}", "name": "Quiet grid", "distinction": "…",`,
    `        "notes": "${join(refsDir, `direction-${slugB}.md`)}" }`,
    `    ],`,
    `    "refs": [`,
    `      { "path": "${join(refsDir, `${slugA}-01-${hero}.png`)}",`,
    `        "section": "${hero}",`,
    `        "aspect": "${VEO_ASPECTS[0]}",`,
    `        "direction": "${slugA}",`,
    `        "intent": "what this image is FOR, in one sentence" },`,
    `      { "path": "${join(refsDir, `${slugA}-02-${second}.png`)}",`,
    `        "section": "${second}",`,
    `        "aspect": "${VEO_ASPECTS[0]}",`,
    `        "direction": "${slugA}",`,
    `        "intent": "as above, for this section" },`,
    `      { "path": "${join(refsDir, `${slugB}-01-${hero}.png`)}",`,
    `        "section": "${hero}",`,
    `        "aspect": "${VEO_ASPECTS[0]}",`,
    `        "direction": "${slugB}",`,
    `        "intent": "the SAME section, the other direction's reading of it" },`,
    // THE SECOND DIRECTION CARRIES BOTH SECTIONS TOO, ADDED 2026-08-03, AND IT IS
    // NOT DECORATION. `auditCanvass` fails a canvass whose directions do not
    // render the same sections; the three-ref example was itself short by that
    // reading, so a lane copying it produced the shape the host now rejects.
    // `design-prompt.test.ts` runs the host's own reader over this template.
    `      { "path": "${join(refsDir, `${slugB}-02-${second}.png`)}",`,
    `        "section": "${second}",`,
    `        "aspect": "${VEO_ASPECTS[0]}",`,
    `        "direction": "${slugB}",`,
    `        "intent": "the same second section, in that direction" }`,
    `    ]`,
    `  }`,
    "",
    // THE ASPECT IS IDENTICAL IN EVERY TEMPLATE REF ON PURPOSE. The 2b template
    // deliberately varied it (`16:9` then `3:2`) to show a ref free to choose;
    // here a varied example would be copied, and a canvass whose aspects vary is
    // the failure mode this brief spends four paragraphs on.
    "Every ref above carries the same `aspect` deliberately — copy that.",
    "",
    "DO NOT LOCK ANYTHING AND DO NOT WRITE A `locked` FIELD. The owner chooses which",
    "direction to pursue; the canonical still is settled after the chosen direction is",
    "expanded, by the host, and a lock written here is refused.",
    "",
  ];
}

/**
 * STAGE B's DELIVERABLE — today's shape, for ONE direction.
 *
 * THIS IS THE ADDITIVE STAGE AND THAT IS THE HAZARD. The manifest already holds
 * the canvass refs of all three directions and the `chosenDirection` the host
 * wrote; a lane that REPLACES `refs` erases the record of what was offered, and a
 * lane that rewrites `chosenDirection` records a decision nobody made. Both are
 * stated as instructions because both are things the host cannot undo after the
 * fact — it can only report them.
 */
function expandBrief(
  refsDir: string,
  manifestPath: string,
  chosen: DesignDirection | null,
  video: boolean,
): readonly string[] {
  // A STAND-IN RATHER THAN AN EMPTY STRING when `chosen` is null. That state
  // cannot arise from `#buildPhase` — the expand segment is only reached through
  // a recorded choice — but an empty slug would make the manifest template below
  // unparseable, and a template the host's own parser rejects is the one thing
  // this file must never hand an agent. The stand-in keeps it valid and reads as
  // obviously wrong, rather than failing silently.
  const slug = chosen?.slug ?? "chosen-direction";
  return [
    `DELIVERABLE: at least ${String(MIN_DESIGN_REFS)} PNGs for the "${chosen?.name ?? ""}" direction, ONE PER`,
    `SECTION, covering the whole page — and ${manifestPath} updated to name them.`,
    "",
    `THEY ARE ALL THAT ONE DIRECTION. Its ${String(DESIGN_CANVASS_SECTIONS)} canvass stills are already on disk and`,
    "already in the manifest; carry their palette, type and scaffold across the rest of",
    "the page with `-i`, starting from the first of them. The result must read as the",
    "same design continued, not as a fourth direction.",
    "",
    `FILENAMES CONTINUE THE NUMBERING: ${join(refsDir, `${slug}-03-<section>.png`)},`,
    `${join(refsDir, `${slug}-04-<section>.png`)}, and so on. Same slug, same flat`,
    "directory.",
    "",
    "APPEND TO `refs`, NEVER REPLACE IT. Every existing entry stays exactly as it is,",
    "including the other directions' stills — they are the record of what the owner was",
    "offered. The file then looks like this, with your new entries added at the end:",
    "",
    `  {`,
    `    "version": 1,`,
    // THE TEMPLATE IS VALID JSON, NOT A SKETCH WITH ELLIPSES IN IT, and that is a
    // measured rule rather than tidiness: `design-prompt.test.ts` copies this
    // template literally, parses it with the HOST'S parser and plans it with the
    // HOST'S video planner. An ellipsis would break that check — and an agent that
    // copies an ellipsis writes a manifest `parseDesignManifest` rejects
    // wholesale, which the lane reports as having produced nothing.
    `    "directions": [`,
    `      { "slug": "${slug}", "name": "${chosen?.name ?? ""}",`,
    `        "distinction": "${chosen?.distinction ?? ""}",`,
    `        "notes": ${chosen?.notes === null || chosen?.notes === undefined ? "null" : `"${chosen.notes}"`} }`,
    `    ],`,
    `    "chosenDirection": "${slug}",`,
    `    "directionChoice": { "by": "owner", "reason": "as recorded by the host", "at": "…" },`,
    `    "refs": [`,
    `      { "path": "${join(refsDir, `${slug}-01-hero.png`)}",`,
    `        "section": "hero",`,
    `        "aspect": "${VEO_ASPECTS[0]}",`,
    `        "direction": "${slug}",`,
    `        "origin": "canvass",`,
    `        "intent": "… the canvass entries, unchanged …" },`,
    `      { "path": "${join(refsDir, `${slug}-03-<section>.png`)}",`,
    `        "section": "<section>",`,
    `        "aspect": "${VEO_ASPECTS[0]}",`,
    `        "direction": "${slug}",`,
    `        "origin": "expansion",`,
    // THE MARK IS IN THE TEMPLATE, NOT ONLY IN THE PROSE, and the FIRST ref
    // exists so the template can show the mark being WITHHELD. A one-ref example
    // carrying `"animate": true` is copied five times by an agent asked for five
    // sections — the cap violated by the example rather than by the agent.
    ...(video ? ['        "animate": true,'] : []),
    `        "intent": "what this image is FOR, in one sentence" }`,
    `    ]`,
    `  }`,
    "",
    "THAT SHAPE, NOT THAT CONTENT. The file on disk already holds ALL the directions",
    "that were offered and the host's own `directionChoice` — read it and keep every one",
    "of those parts byte for byte. `directions`, `chosenDirection` and `directionChoice`",
    "are the host's: it wrote the choice and who made it, and rewriting any of them",
    "records a decision nobody made. Do not write `locked` either — the host locks the",
    "canonical still when this segment returns.",
    "",
  ];
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
  // THE DISCARDED DIRECTIONS DO NOT CROSS THIS SEAM. `builtManifest` removes the
  // stills of every direction that was offered and not chosen, so a build agent
  // is handed one design to build rather than three incompatible ones with an
  // instruction to build to "it". Identity on every manifest with no choice,
  // which is every manifest written before 2026-08-03.
  const manifest = input.manifest === null ? null : builtManifest(input.manifest);

  if (input.mode === "degraded" || manifest === null || manifest.refs.length === 0) {
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
  for (const ref of manifest.refs) {
    const locked = ref.path === manifest.lockedMockup;
    lines.push(
      `  ${locked ? "LOCKED  " : "        "}${ref.path}` +
        `   [${ref.section}, ${ref.aspect}] ${ref.intent}`,
    );
  }
  lines.push("");
  lines.push(
    manifest.lockedMockup === null
      ? "No mockup is locked on this run, so the set as a whole is the reference."
      : `The LOCKED mockup is the design that was chosen: ${manifest.lockedMockup}. ` +
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

  // THE GRADING SECTION MAY NOT NAME A DISCARDED DIRECTION. The unchosen
  // directions are a record of what was OFFERED; the build was never held to
  // them, so asking the gate to compare the built page against one would
  // manufacture a failure out of a design nobody chose to build. `builtManifest`
  // is identity on every run that has no direction choice, which is every run
  // before 2026-08-03 and every run whose lane produced no directions at all.
  const manifest = input.manifest === null ? null : builtManifest(input.manifest);

  if (manifest === null || manifest.refs.length === 0) {
    lines.push(
      "THERE IS NO REFERENCE IMAGE for this run — the DESIGN lane degraded. Grade against the",
      "rule-based floor alone and say so in the report; do not invent a reference.",
      "",
    );
  } else {
    lines.push("Read each mockup and its screenshot as a pair:", "");
    for (const ref of manifest.refs) {
      const locked = ref.path === manifest.lockedMockup;
      lines.push(`  ${locked ? "LOCKED  " : "        "}${ref.path}   [${ref.section}, ${ref.aspect}] ${ref.intent}`);
    }
    lines.push(
      "",
      manifest.lockedMockup === null
        ? "No mockup was locked, so grade against the set and say that the comparison is loose."
        : `Grade against the LOCKED mockup: ${manifest.lockedMockup}. The question is "does this ` +
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
