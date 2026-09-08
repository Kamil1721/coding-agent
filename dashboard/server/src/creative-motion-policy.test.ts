import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CREATIVE_CONTRACT_FILE, MAX_MOTION_POLICY_BYTES, readCreativeMotionPolicy } from "./creative-pilot.js";

const projection = () => ({ schemaVersion: 1, designRead: { pageKind: "consumer_landing" }, dials: { motionIntensity: 8 }, motion: [{ id: "m.step" }] });

test("T19 motion policy reader distinguishes missing, malformed and bounded valid fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "motion-policy-"));
  const path = join(dir, CREATIVE_CONTRACT_FILE);
  try {
    assert.deepEqual(readCreativeMotionPolicy(dir), { kind: "missing" });
    writeFileSync(path, JSON.stringify(projection()));
    assert.deepEqual(readCreativeMotionPolicy(dir), { kind: "present", pageKind: "consumer_landing", motionIntensity: 8, motionIds: ["m.step"] });
    // T20 consumes IDs only; empty motion is valid and other metadata is not compiled here.
    writeFileSync(path, JSON.stringify({ ...projection(), motion: [] }));
    assert.deepEqual(readCreativeMotionPolicy(dir), { kind: "present", pageKind: "consumer_landing", motionIntensity: 8, motionIds: [] });
    writeFileSync(path, JSON.stringify({ ...projection(), designRead: { pageKind: "app" }, motion: [{ id: "m.step", unrelatedMetadata: null }] }));
    assert.equal(readCreativeMotionPolicy(dir).kind, "present");
    for (const bad of ["{", "null", "[]", JSON.stringify({ ...projection(), schemaVersion: 2 }), JSON.stringify({ ...projection(), designRead: { pageKind: "unknown" } }), ...[null, "8", 0, 11, 8.5].map((motionIntensity) => JSON.stringify({ ...projection(), dials: { motionIntensity } }))]) {
      writeFileSync(path, bad);
      assert.equal(readCreativeMotionPolicy(dir).kind, "invalid", bad);
    }
    for (const motion of [null, [{ id: "" }], [{ id: "a".repeat(129) }], [{ id: "m step" }], [{ id: "m.x" }, { id: "m.x" }], Array.from({ length: 81 }, (_, i) => ({ id: `m.${String(i)}` }))]) {
      writeFileSync(path, JSON.stringify({ ...projection(), motion }));
      assert.equal(readCreativeMotionPolicy(dir).kind, "invalid");
    }
    writeFileSync(path, " ".repeat(MAX_MOTION_POLICY_BYTES + 1));
    assert.equal(readCreativeMotionPolicy(dir).kind, "invalid");
    rmSync(path); mkdirSync(path);
    assert.equal(readCreativeMotionPolicy(dir).kind, "invalid");
    rmSync(path, { recursive: true }); symlinkSync(join(dir, "absent-target"), path);
    assert.equal(readCreativeMotionPolicy(dir).kind, "invalid", "an existing dangling link is not an absent contract");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
