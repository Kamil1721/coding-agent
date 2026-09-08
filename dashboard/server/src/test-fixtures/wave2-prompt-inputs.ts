/** Deterministic inputs for pre-T19/T20 prompt snapshots. No disk or vendor access. */
import { strict as assert } from "node:assert";
import { JUDGE_SEAT } from "bakeoff/dist/config.js";
import { designSegmentPrompt } from "../design-prompt.js";
import { videoConsumptionPrompt } from "../design/video-lane.js";
import type { VideoLeg } from "../design/video-legs.js";
import { visualCriteriaFor } from "../visual-criteria.js";
import { decideMotion } from "../builders/antislop-rules.js";
import { authorCreativeContract } from "../creative-contract-author.js";

export const DESIGN_INPUT = {
  ticketText: "Build a portfolio for an independent illustrator.",
  workspace: "/runs/prompt-baseline/workspace",
  mode: "full",
  capability: { imageScript: "/fixture/gemini-image.sh", key: { available: true, source: "GEMINI_API_KEY" }, video: true },
  autoChoose: false,
  stage: "expand",
  chosen: { slug: "editorial-slab", name: "Editorial slab", distinction: "Slab-serif masthead and a two-column measure.", notes: "/runs/prompt-baseline/workspace/design-refs/direction-editorial-slab.md" },
} satisfies Parameters<typeof designSegmentPrompt>[0];

export const VIDEO_LEGS: readonly VideoLeg[] = [1, 2].map((index) => ({
  index, still: `/fixture/still-${String(index)}.png`, section: index === 1 ? "hero" : "work",
  aspect: "16:9", out: `/fixture/leg-${String(index)}.mp4`, poster: `/fixture/leg-${String(index)}-poster.webp`,
}));

export const MOTION_FILES = {
  absent: [{ path: "index.html", text: "<main>Portfolio</main>" }],
  stock: [{ path: "index.html", text: "<style>a:hover { opacity: .5; transition: opacity .2s }</style><main>Portfolio</main>" }],
  imported: [{ path: "app.tsx", text: 'import { motion } from "framer-motion"; export const App = () => <main>Portfolio</main>;' }],
} as const;

export async function authorMotionGuidance(): Promise<string> {
  let captured: string | undefined;
  const evidence = { kind: "owner_message", locator: "message:baseline", sha256: "a".repeat(64), excerptSha256: "b".repeat(64) } as const;
  await authorCreativeContract({
    input: {
      contractId: "baseline-contract",
      ticket: { id: "baseline-ticket", sha256: "c".repeat(64), facts: [{ id: "goal", kind: "goal", statement: "Build an illustrator portfolio.", evidence }] },
      designFacts: [{ id: "direction", kind: "design_direction", statement: "Use direct hierarchy and restrained motion.", evidence }], referenceFacts: [],
    },
    evidenceResolver: { resolve: () => ({ sha256: evidence.sha256, excerptSha256: evidence.excerptSha256 }) },
    seat: JUDGE_SEAT,
    budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxCampaignCostUsd: 1, warnAtFraction: 0.8, perVendorMaxOutputTokens: null, vendorAdvisoryBudgets: [] },
    cwd: "/tmp", env: {}, signal: new AbortController().signal,
    startQuery: ({ prompt }) => {
      assert.equal(typeof prompt, "string");
      captured = prompt as string;
      throw new Error("Baseline recorder: deliberately stop before creating any vendor session");
    },
  });
  assert.ok(captured, "the injected recorder must capture the author prompt");
  const lines = captured.split("\n").filter((line) => line.startsWith("- Motion is optional") || line.includes("motionIntensity is below"));
  assert.equal(lines.length, 2, "capture both author and compiler-owned motion guidance");
  return lines.join("\n");
}

export async function currentPromptBytes(): Promise<Record<string, string>> {
  const motion = visualCriteriaFor({ lockedMockup: null }).find((criterion) => criterion.id === "VIS-MOTION-AUTHORED");
  assert.ok(motion);
  const feedback = Object.fromEntries(Object.entries(MOTION_FILES).map(([name, files]) => {
    const verdict = decideMotion(files);
    assert.equal(verdict.kind, "unsatisfied");
    assert.ok(verdict.kind === "unsatisfied");
    return [`motion-${name}`, verdict.reason];
  }));
  return {
    "design-expansion-available": designSegmentPrompt(DESIGN_INPUT),
    "design-expansion-no-video": designSegmentPrompt({ ...DESIGN_INPUT, capability: { ...DESIGN_INPUT.capability, video: false } }),
    "design-canvass-available": designSegmentPrompt({ ...DESIGN_INPUT, stage: "canvass", chosen: null }),
    "video-consumption-original": videoConsumptionPrompt(VIDEO_LEGS),
    "visual-motion-statement": motion.statement,
    ...feedback,
    "author-motion-guidance": await authorMotionGuidance(),
  };
}
