/** Fixed pre-Batch-2B inputs. The author recorder stops before creating a vendor session. */
import { strict as assert } from "node:assert";
import { JUDGE_SEAT } from "bakeoff/dist/config.js";
import { authorCreativeContract } from "../creative-contract-author.js";
import type { CreativeAuthorRepairFinding } from "../creative-contract-author.js";
import { designSegmentPrompt } from "../design-prompt.js";
import { DESIGN_INPUT } from "./wave2-prompt-inputs.js";

export function batch2bDesignPrompts(): Record<string, string> {
  const canvass = { ...DESIGN_INPUT, stage: "canvass" as const, chosen: null };
  return {
    "landing-canvass-manual": designSegmentPrompt(canvass),
    "landing-canvass-auto": designSegmentPrompt({ ...canvass, autoChoose: true }),
    "landing-expansion-video": designSegmentPrompt(DESIGN_INPUT),
    "landing-expansion-no-video": designSegmentPrompt({ ...DESIGN_INPUT, capability: { ...DESIGN_INPUT.capability, video: false } }),
    "degraded-canvass-manual": designSegmentPrompt({ ...canvass, mode: "degraded" }),
    "degraded-canvass-auto": designSegmentPrompt({ ...canvass, mode: "degraded", autoChoose: true }),
    "degraded-expansion": designSegmentPrompt({ ...DESIGN_INPUT, mode: "degraded" }),
  };
}

export async function batch2bAuthorPrompt(repair = false): Promise<string> {
  const evidence = { kind: "owner_message", locator: "message:batch2b-baseline", sha256: "a".repeat(64), excerptSha256: "b".repeat(64) } as const;
  const repairFindings: readonly CreativeAuthorRepairFinding[] = repair
    ? [{ code: "MOBILE_COLLAPSE_REQUIRED", path: "/sections/0/mobile", message: "Multi-column and asymmetric layout families require a collapsing mobile strategy." }]
    : [];
  let captured: string | undefined;
  let calls = 0;
  await authorCreativeContract({
    input: {
      contractId: "batch2b-baseline-contract",
      ticket: {
        id: "batch2b-baseline-ticket", sha256: "c".repeat(64),
        facts: [{ id: "goal", kind: "goal", statement: "Build an illustrator portfolio.", evidence }],
      },
      designFacts: [{ id: "direction", kind: "design_direction", statement: "Use direct hierarchy and restrained motion.", evidence }],
      referenceFacts: [],
    },
    evidenceResolver: { resolve: () => ({ sha256: evidence.sha256, excerptSha256: evidence.excerptSha256 }) },
    repairFindings,
    seat: JUDGE_SEAT,
    budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxCampaignCostUsd: 1, warnAtFraction: 0.8, perVendorMaxOutputTokens: null, vendorAdvisoryBudgets: [] },
    cwd: "/tmp", env: {}, signal: new AbortController().signal,
    startQuery: ({ prompt }) => {
      calls += 1;
      assert.equal(typeof prompt, "string");
      captured = prompt as string;
      throw new Error("Batch 2B baseline recorder: stop before vendor session");
    },
  });
  assert.equal(calls, 1, "capture must traverse the actual author prompt boundary exactly once");
  assert.ok(captured !== undefined);
  return captured;
}

export async function batch2bPromptBytes(): Promise<Record<string, string>> {
  return {
    ...batch2bDesignPrompts(),
    "author-initial": await batch2bAuthorPrompt(),
    "author-repair": await batch2bAuthorPrompt(true),
  };
}
