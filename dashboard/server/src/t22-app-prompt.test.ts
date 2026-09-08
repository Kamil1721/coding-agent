import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { designSegmentPrompt } from "./design-prompt.js";
import { DESIGN_INPUT } from "./test-fixtures/wave2-prompt-inputs.js";
import { T22_APP_PROMPT_GOLDENS } from "./test-fixtures/t22-app-prompt-goldens.js";

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

for (const mode of ["full", "degraded"] as const) {
  for (const autoChoose of [false, true]) {
    const name = `${mode}-${autoChoose ? "auto" : "manual"}` as const;
    test(`T22 app runtime golden: ${name}`, () => {
      const expected = T22_APP_PROMPT_GOLDENS[name];
      const actual = designSegmentPrompt({ ...DESIGN_INPUT, pageKind: "app", stage: "canvass", chosen: null, mode, autoChoose });
      assert.equal(hash(expected.bytes), expected.sha256, "capture hash must match stored bytes");
      assert.equal(hash(actual), expected.sha256, "runtime app prompt must match captured hash");
      assert.equal(actual, expected.bytes, "runtime app prompt must match captured bytes");
    });
  }
}
