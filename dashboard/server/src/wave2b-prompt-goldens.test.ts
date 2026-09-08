/** First-commit controls: expected strings come only from frozen captures. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { WAVE2_PROMPT_GOLDENS } from "./test-fixtures/wave2-prompt-goldens.js";
import { WAVE2B_PROMPT_GOLDENS } from "./test-fixtures/wave2b-prompt-goldens.js";
import { WAVE2B_T21_PROMPT_GOLDENS } from "./test-fixtures/wave2b-t21-prompt-goldens.js";
import { WAVE2B_T22_AUTHOR_PROMPT_GOLDENS } from "./test-fixtures/wave2b-t22-author-prompt-goldens.js";
import { batch2bPromptBytes } from "./test-fixtures/wave2b-prompt-inputs.js";

const goldens = {
  // Reuse the first Batch 2A captures, without copying or changing their bytes.
  "landing-canvass-manual": WAVE2_PROMPT_GOLDENS["design-canvass-available"],
  "landing-expansion-video": WAVE2_PROMPT_GOLDENS["design-expansion-available"],
  "landing-expansion-no-video": WAVE2_PROMPT_GOLDENS["design-expansion-no-video"],
  ...WAVE2B_PROMPT_GOLDENS,
  ...WAVE2B_T21_PROMPT_GOLDENS,
  ...WAVE2B_T22_AUTHOR_PROMPT_GOLDENS,
};
const hash = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
function assertGolden(actual: string, expected: { readonly bytes: string; readonly sha256: string }): void {
  assert.equal(hash(expected.bytes), expected.sha256, "stored Batch 2B bytes must match the captured hash");
  assert.equal(hash(actual), expected.sha256, "runtime Batch 2B bytes must match the captured hash");
  assert.equal(actual, expected.bytes, "runtime Batch 2B bytes must equal the frozen capture");
}

const current = await batch2bPromptBytes();
test("T22 author prompt changes only app vocabulary, structure, hero exemption and operating guidance", () => {
  const additions = [
    "- Choose app when the visitor operates the page rather than reads it: completing forms, using a tool or moving through a workflow.",
    "- For each app route, include at least one form section and at most one feature or editorial section combined. These route limits do not apply to landing or editorial page kinds.",
  ];
  const replacements = [
    ['"pageKind":["saas_landing","consumer_landing","agency_landing","event_landing","portfolio","editorial","app"]', '"pageKind":["saas_landing","consumer_landing","agency_landing","event_landing","portfolio","editorial"]'],
    ["pageKind is not editorial, event_landing or app", "pageKind is neither editorial nor event_landing"],
  ] as const;
  for (const name of ["author-initial", "author-repair"] as const) {
    let remainder: string = WAVE2B_T22_AUTHOR_PROMPT_GOLDENS[name].bytes;
    for (const addition of additions) {
      assert.equal(remainder.split(`${addition}\n`).length, 2, "T22 each planned prompt addition appears once");
      remainder = remainder.replace(`${addition}\n`, "");
    }
    for (const [after, before] of replacements) {
      assert.equal(remainder.split(after).length, 2, "T22 each planned prompt replacement appears once");
      remainder = remainder.replace(after, before);
    }
    assert.equal(hash(WAVE2B_T21_PROMPT_GOLDENS[name].bytes), WAVE2B_T21_PROMPT_GOLDENS[name].sha256);
    assert.equal(remainder, WAVE2B_T21_PROMPT_GOLDENS[name].bytes, "T22 author remainder must match the immutable T21 capture");
  }
});
test("T21 author prompt changes are exactly the requirement invariant and guidance additions", () => {
  const additions = [
    "- Facts of kind constraint, accessibility, technical_constraint or avoid describe implementation requirements, not page copy. Their contentProof entries may authorize only alt, never another content use or an action; no section may draw all its proof references from requirements.",
    "- Keep constraint, accessibility, technical_constraint and avoid facts out of visible page copy and actions; use them to guide implementation, with alt as their only permitted content use.",
  ];
  for (const name of ["author-initial", "author-repair"] as const) {
    const historical = WAVE2B_PROMPT_GOLDENS[name];
    assert.equal(hash(historical.bytes), historical.sha256, "T21 prechange author capture remains immutable");
    let remainder: string = WAVE2B_T21_PROMPT_GOLDENS[name].bytes;
    for (const addition of additions) {
      assert.equal(remainder.split(`${addition}\n`).length, 2, "T21 each planned prompt addition appears once");
      remainder = remainder.replace(`${addition}\n`, "");
    }
    assert.equal(remainder, historical.bytes, "T21 author prompt remainder must be byte-identical to prechange capture");
  }
});
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
