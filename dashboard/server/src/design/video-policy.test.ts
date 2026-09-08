import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PAGE_KINDS } from "../creative-contract.js";
import { videoLegPolicy } from "./video-policy.js";

test("T19 every known page kind requires both applicable dials at eight or above", () => {
  for (const pageKind of PAGE_KINDS) {
    for (let contractDial = 1; contractDial <= 10; contractDial += 1) {
      for (const directionDial of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        const policy = videoLegPolicy({ pageKind, contractDial, directionDial });
        assert.equal(policy.allowed, contractDial >= 8 && (directionDial === null || directionDial >= 8), JSON.stringify({ pageKind, contractDial, directionDial }));
        assert.ok(policy.reason.includes(`contract dial ${String(contractDial)}`));
        assert.ok(policy.reason.includes(`direction dial ${directionDial ?? "unknown"}`));
      }
    }
  }
});

test("T19 app and invalid contract dials are declined without a legacy fallback", () => {
  assert.equal(videoLegPolicy({ pageKind: "app", contractDial: 10, directionDial: 10 }).allowed, false);
  for (const contractDial of [null, 0, 11, 8.5, NaN, Infinity]) {
    assert.equal(videoLegPolicy({ pageKind: "consumer_landing", contractDial, directionDial: 8 }).allowed, false);
  }
  assert.equal(videoLegPolicy({ pageKind: null, contractDial: 8, directionDial: 8 }).allowed, false);
  assert.equal(videoLegPolicy({ pageKind: "consumer_landing", contractDial: 8, directionDial: 8.5 }).allowed, false);
});

test("T19 only an explicitly missing contract preserves legacy behavior", () => {
  const missing = videoLegPolicy({ pageKind: null, contractDial: null, directionDial: 2, contractState: "missing" });
  assert.deepEqual(missing, { allowed: true, reason: "no contract; policy not applied" });
  const invalid = videoLegPolicy({ pageKind: null, contractDial: null, directionDial: 2, contractState: "invalid", contractProblem: "invalid JSON" });
  assert.equal(invalid.allowed, false);
  assert.match(invalid.reason, /declined.*contract dial unknown.*direction dial 2.*invalid JSON/);
});

test("T19 duplicate direction declarations name the first-use decision", () => {
  const policy = videoLegPolicy({ pageKind: "consumer_landing", contractDial: 8, directionDial: 2, directionOccurrences: 2 });
  assert.equal(policy.allowed, false);
  assert.match(policy.reason, /first of 2 direction dial declarations used/);
});

test("T19 an invalid first direction declaration cannot become an absent dial", () => {
  const invalid = videoLegPolicy({ pageKind: "consumer_landing", contractDial: 8, directionDial: null, directionOccurrences: 2 });
  assert.equal(invalid.allowed, false);
  assert.match(invalid.reason, /direction dial unknown.*first of 2.*first direction dial declaration is invalid/);
  assert.equal(videoLegPolicy({ pageKind: "consumer_landing", contractDial: 8, directionDial: null, directionOccurrences: 0 }).allowed, true);
});


test("T19 app remains declined when a future contract vocabulary includes it", () => {
  // Isolated Node process: no shared test constants are mutated.
  const script = `
    import { strict as assert } from "node:assert";
    import { PAGE_KINDS } from ${JSON.stringify(new URL("../creative-contract.js", import.meta.url).href)};
    import { videoLegPolicy } from ${JSON.stringify(new URL("./video-policy.js", import.meta.url).href)};
    PAGE_KINDS.push("app");
    assert.equal(videoLegPolicy({ pageKind: "app", contractDial: 8, directionDial: 8 }).allowed, false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});
