/** First-commit controls for T19/T20. Expected bytes are captured, never recomputed. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { WAVE2_PROMPT_GOLDENS } from "./test-fixtures/wave2-prompt-goldens.js";
import { decideMotion } from "./builders/antislop-rules.js";
import { visualCriteriaFor } from "./visual-criteria.js";
import { MOTION_FILES } from "./test-fixtures/wave2-prompt-inputs.js";
import { currentPromptBytes } from "./test-fixtures/wave2-prompt-inputs.js";

// The exact false sentence, including its wrapping. T19 may remove ONLY these bytes.
const FALSE_REFERENCE_SENTENCE = " It is measured from the\nreference site's runtime behaviour, not invented, and it is what the motion bar accepts.";
const hash = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");

function assertGolden(actual: string, expected: { readonly sha256: string; readonly bytes: string }): void {
  assert.equal(hash(expected.bytes), expected.sha256, "stored bytes must match the immutable capture hash");
  assert.equal(hash(actual), expected.sha256, "runtime bytes must match the captured hash");
  assert.equal(actual, expected.bytes, "runtime bytes must equal the independently captured bytes");
}

const current = await currentPromptBytes();
for (const [name, golden] of Object.entries(WAVE2_PROMPT_GOLDENS)) {
  test(`${name === "video-consumption-original" ? "historical capture hash integrity" : "runtime golden"}: ${name}`, () => {
    // The full original remains an immutable historical capture. T19's runtime
    // must now equal the independently captured sentence-removed remainder.
    const actual = name === "video-consumption-original"
      ? golden.bytes
      : name === "video-consumption-rest" ? current["video-consumption-original"] : current[name];
    assert.ok(actual !== undefined);
    assertGolden(actual, golden);
  });

  test(`one-byte negative control: ${name}`, () => {
    const changed = Buffer.from(golden.bytes, "utf8");
    assert.ok(changed[0] !== undefined);
    changed[0] ^= 1;
    const mutation = changed.toString("utf8");
    assert.throws(() => assertGolden(mutation, golden), { code: "ERR_ASSERTION" });
    // Independently prove both comparisons reject it, not just the first check.
    assert.notEqual(hash(mutation), golden.sha256);
    assert.notEqual(mutation, golden.bytes);
  });
}

test("consumption remainder removes exactly the original false sentence", () => {
  const original = WAVE2_PROMPT_GOLDENS["video-consumption-original"].bytes;
  assert.equal(original.split(FALSE_REFERENCE_SENTENCE).length, 2);
  assert.equal(original.replace(FALSE_REFERENCE_SENTENCE, ""), WAVE2_PROMPT_GOLDENS["video-consumption-rest"].bytes);
});


test("T20 mid high and empty policy preserve frozen legacy motion bytes", () => {
  for (const policy of [null, { motionIntensity: 3, motionIds: [] }, ...[5, 6, 7, 8, 9, 10].map(motionIntensity => ({ motionIntensity, motionIds: ["m.fade"] }))]) {
    const visual = visualCriteriaFor({ lockedMockup: null }, null, policy).find(c => c.id === "VIS-MOTION-AUTHORED");
    assert.ok(visual);
    assertGolden(visual.statement, WAVE2_PROMPT_GOLDENS["visual-motion-statement"]);
    for (const [name, files] of Object.entries(MOTION_FILES)) {
      const result = decideMotion(files, policy);
      assert.ok(result.kind === "unsatisfied");
      const golden = WAVE2_PROMPT_GOLDENS[`motion-${name}` as "motion-absent" | "motion-stock" | "motion-imported"];
      assertGolden(result.reason, golden);
    }
  }
});
