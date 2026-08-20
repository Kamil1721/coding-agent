import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  isReviewPackageName,
  isSupportedReviewVersionRange,
} from "./review-claims.js";

test("package and version vocabularies admit npm identities and reject command-like input", () => {
  assert.equal(isReviewPackageName("@anthropic-ai/claude-agent-sdk"), true);
  assert.equal(isReviewPackageName("next"), true);
  assert.equal(isReviewPackageName("next/latest"), false);
  assert.equal(isReviewPackageName("next && curl example.test"), false);

  for (const version of ["16", "16.x", "16.1.*", "16.1.2", "v16.1.2-beta.1", "^16.1.2", "~16.1.2"]) {
    assert.equal(isSupportedReviewVersionRange(version), true, version);
  }
  for (const version of ["latest", ">=16", "16 || 17", "workspace:*", "https://example.test/pkg.tgz"]) {
    assert.equal(isSupportedReviewVersionRange(version), false, version);
  }
});
