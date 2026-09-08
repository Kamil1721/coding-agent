/** First-commit controls: expected strings come only from frozen captures. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { WAVE2_PROMPT_GOLDENS } from "./test-fixtures/wave2-prompt-goldens.js";
import { WAVE2B_PROMPT_GOLDENS } from "./test-fixtures/wave2b-prompt-goldens.js";
import { batch2bPromptBytes } from "./test-fixtures/wave2b-prompt-inputs.js";

const goldens = {
  // Reuse the first Batch 2A captures, without copying or changing their bytes.
  "landing-canvass-manual": WAVE2_PROMPT_GOLDENS["design-canvass-available"],
  "landing-expansion-video": WAVE2_PROMPT_GOLDENS["design-expansion-available"],
  "landing-expansion-no-video": WAVE2_PROMPT_GOLDENS["design-expansion-no-video"],
  ...WAVE2B_PROMPT_GOLDENS,
};
const hash = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
function assertGolden(actual: string, expected: { readonly bytes: string; readonly sha256: string }): void {
  assert.equal(hash(expected.bytes), expected.sha256, "stored Batch 2B bytes must match the captured hash");
  assert.equal(hash(actual), expected.sha256, "runtime Batch 2B bytes must match the captured hash");
  assert.equal(actual, expected.bytes, "runtime Batch 2B bytes must equal the frozen capture");
}

const current = await batch2bPromptBytes();
test("Batch 2B capture set covers every declared branch", () => {
  assert.deepEqual(Object.keys(current).sort(), Object.keys(goldens).sort());
});
for (const [name, expected] of Object.entries(goldens)) {
  test(`Batch 2B runtime golden: ${name}`, () => {
    const actual = current[name];
    assert.ok(actual !== undefined);
    assertGolden(actual, expected);
  });
  test(`Batch 2B one-byte negative control: ${name}`, () => {
    const changed = Buffer.from(expected.bytes, "utf8");
    assert.ok(changed[0] !== undefined);
    changed[0] ^= 1;
    const mutation = changed.toString("utf8");
    assert.throws(() => assertGolden(mutation, expected), /runtime Batch 2B bytes must match the captured hash/);
    assert.notEqual(hash(mutation), expected.sha256);
    assert.notEqual(mutation, expected.bytes);
  });
}

test("Batch 2B author repair and chooser controls exercise distinct prompt branches", () => {
  assert.match(current["author-repair"] ?? "", /PRIOR ATTEMPT REJECTED BY THE DETERMINISTIC COMPILER/);
  assert.match(current["author-repair"] ?? "", /MOBILE_COLLAPSE_REQUIRED/);
  assert.doesNotMatch(current["author-initial"] ?? "", /PRIOR ATTEMPT REJECTED BY THE DETERMINISTIC COMPILER/);
  assert.match(current["landing-canvass-auto"] ?? "", /CHOOSING THE DIRECTION/);
  assert.doesNotMatch(current["landing-canvass-manual"] ?? "", /CHOOSING THE DIRECTION/);
});
