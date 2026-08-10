import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSandbox, independentReplay, proveRepair, REPO_ROOT, runCommand } from "./prover.mjs";

const TMP = process.env.REPAIR_TEST_TMP ?? tmpdir();

const WIDGET_BROKEN = `// widget: a deliberately tiny product for the prover's own tests

export function add(a, b) {
  return a - b;
}

// ---------------------------------------------------------------

export const LABEL = "widget";

// trailing note: unchanged
`;

const CHECK = `import { add } from "./widget.mjs";
if (add(2, 3) !== 5) {
  console.error("FAIL: add(2, 3) === " + add(2, 3));
  process.exit(1);
}
console.log("ok: add(2, 3) === 5");
`;

const FIX = `--- a/widget.mjs
+++ b/widget.mjs
@@ -2,4 +2,4 @@

 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

const FIX_PLUS_SCAFFOLD = `--- a/widget.mjs
+++ b/widget.mjs
@@ -2,4 +2,4 @@

 export function add(a, b) {
-  return a + b;
+  return a + b;
 }
@@ -9,3 +9,3 @@
 export const LABEL = "widget";

-// trailing note: unchanged
+// trailing note: touched by a hunk that changes no behaviour
`;

function sandbox(files) {
  const root = mkdtempSync(join(TMP, "repair-prover-"));
  for (const [name, body] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, "utf8");
  }
  return root;
}

function fresh(extra = {}) {
  return sandbox({ "widget.mjs": WIDGET_BROKEN, "check.mjs": CHECK, ...extra });
}

test("ARM: the prover actually executes — a known-failing command is observed non-zero and a known-passing one zero", () => {
  const root = fresh();
  try {
    const red = runCommand("node check.mjs", { cwd: root });
    assert.equal(red.ok, false);
    assert.equal(red.exitCode, 1);
    assert.match(red.transcript, /FAIL: add\(2, 3\) === -1/);
    assert.match(red.transcript, /# exit code: 1/);
    const green = runCommand("node -e \"process.exit(0)\"", { cwd: root });
    assert.equal(green.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the whole loop on a real defect: RED, GREEN, and RED under a revert of the fix", () => {
  const root = fresh();
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX });
    assert.equal(r.outcome, "PROVEN");
    assert.equal(r.ok, true);
    assert.match(r.evidence.redBefore, /FAIL: add\(2, 3\) === -1\n# exit code: 1/);
    assert.match(r.evidence.greenAfter, /ok: add\(2, 3\) === 5\n# exit code: 0/);
    assert.match(r.evidence.mutationRed, /FAIL: add\(2, 3\) === -1\n# exit code: 1/);
    assert.notEqual(r.evidence.redBefore, r.evidence.greenAfter);
    assert.match(readFileSync(join(root, "widget.mjs"), "utf8"), /return a \+ b;/, "the patch is left applied for the caller to bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REPRODUCTION IS NOT OPTIONAL: a defect whose command already passes produces no proposal", () => {
  const root = fresh({ "widget.mjs": WIDGET_BROKEN.replace("a - b", "a + b") });
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX });
    assert.equal(r.outcome, "COULD_NOT_REPRODUCE");
    assert.equal(r.ok, false);
    assert.equal(r.evidence, undefined, "no evidence bundle may be produced for a defect that was never observed");
    assert.equal(r.transcripts.greenAfter, undefined, "the patch must not even be applied");
    assert.match(r.detail, /guess/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch that does not fix the defect is NOT_FIXED, and the tree is restored", () => {
  const root = fresh();
  const noop = `--- a/widget.mjs
+++ b/widget.mjs
@@ -9,3 +9,3 @@
 export const LABEL = "widget";

-// trailing note: unchanged
+// trailing note: changed, and irrelevant
`;
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: noop });
    assert.equal(r.outcome, "NOT_FIXED");
    assert.match(readFileSync(join(root, "widget.mjs"), "utf8"), /trailing note: unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MUTATION_SURVIVED: a check that caches its own success is caught by the fix-hunk revert", () => {
  // The nasty real case. The check goes green under the patch, and stays green when the fix
  // is reverted, because it is observing its own cache rather than the product. A proposal
  // built on it would carry three transcripts and prove nothing.
  const cachingCheck = `import { existsSync, writeFileSync } from "node:fs";
import { add } from "./widget.mjs";
if (existsSync(".passed")) { console.log("ok (cached)"); process.exit(0); }
if (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }
writeFileSync(".passed", "1");
console.log("ok");
`;
  const root = fresh({ "check.mjs": cachingCheck });
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX });
    assert.equal(r.outcome, "MUTATION_SURVIVED");
    assert.equal(r.ok, false);
    assert.equal(r.evidence, undefined);
    assert.match(r.transcripts.mutationRed, /ok \(cached\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UNPROVEN_HUNKS: a hunk whose own revert leaves the check green is named as scaffolding", () => {
  const root = fresh({ "widget.mjs": WIDGET_BROKEN.replace("return a - b;", "return a + b;") });
  // The product already computes correctly; the check below fails on LABEL, so hunk 2 is the
  // real fix and hunk 1 is inert. Reverting hunk 1 alone must leave the check green.
  writeFileSync(join(root, "check.mjs"), `import { readFileSync } from "node:fs";
if (!readFileSync("widget.mjs", "utf8").includes("touched by a hunk")) { console.error("FAIL: note not updated"); process.exit(1); }
console.log("ok");
`);
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX_PLUS_SCAFFOLD });
    assert.equal(r.outcome, "UNPROVEN_HUNKS");
    assert.deepEqual(r.unprovenHunks, [1]);
    assert.equal(r.hunks, 2);
    assert.match(r.detail, /scaffolding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch that does not apply is reported, not silently skipped", () => {
  const root = fresh();
  const stale = FIX.replace("return a - b;", "return a * b;");
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: stale });
    assert.equal(r.outcome, "PATCH_DID_NOT_APPLY");
    assert.ok(r.detail.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SANDBOX ARM: the prover refuses to operate inside this repository", () => {
  assert.throws(() => assertSandbox(REPO_ROOT), /refusing to operate inside the repository/);
  assert.throws(() => assertSandbox(join(REPO_ROOT, "bakeoff", "src")), /refusing to operate inside the repository/);
  const root = fresh();
  try {
    assert.equal(assertSandbox(root).length > 0, true, "and it accepts a real sandbox, or the guard is just an unconditional throw");
    assert.throws(() => proveRepair({ root: REPO_ROOT, command: "true", diff: FIX }), /refusing to operate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the independent replay sees a targeted change and no collateral", () => {
  const root = fresh({ "other.mjs": 'console.log("unrelated recorded behaviour"); process.exit(0);\n' });
  try {
    const r = independentReplay({
      root,
      diff: FIX,
      cases: [
        { name: "targeted", command: "node check.mjs", targeted: true },
        { name: "unrelated", command: "node other.mjs" },
      ],
    });
    assert.equal(r.ran, true);
    assert.equal(r.targetedChanged, true);
    assert.deepEqual(r.unrelatedChanged, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the independent replay CATCHES collateral damage on an unrelated recorded input", () => {
  const root = fresh({ "other.mjs": 'import { LABEL } from "./widget.mjs";\nif (LABEL !== "widget") process.exit(3);\nprocess.exit(0);\n' });
  const overBroad = `--- a/widget.mjs
+++ b/widget.mjs
@@ -2,4 +2,4 @@

 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
@@ -8,3 +8,3 @@

-export const LABEL = "widget";
+export const LABEL = "gadget";

`;
  try {
    const r = independentReplay({
      root,
      diff: overBroad,
      cases: [
        { name: "targeted", command: "node check.mjs", targeted: true },
        { name: "unrelated", command: "node other.mjs" },
      ],
    });
    assert.equal(r.ran, true);
    assert.equal(r.targetedChanged, true);
    assert.deepEqual(r.unrelatedChanged, ["unrelated"], "the mutation proof cannot see this; only an unrelated recorded input can");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replay with no unrelated case is REFUSED: an empty unrelatedChanged would mean nothing ran", () => {
  const root = fresh();
  try {
    const r = independentReplay({ root, diff: FIX, cases: [{ name: "targeted", command: "node check.mjs", targeted: true }] });
    assert.equal(r.ran, false);
    assert.equal(r.code, "REPLAY_NOT_INDEPENDENT");
    assert.match(r.detail, /nothing was executed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replay case that re-runs the reproduction command is REFUSED as not independent", () => {
  const root = fresh({ "other.mjs": "process.exit(0);\n" });
  try {
    const r = independentReplay({
      root,
      diff: FIX,
      reproductionCommand: "node check.mjs",
      cases: [
        { name: "targeted", command: "node check.mjs", targeted: true },
        { name: "unrelated", command: "node other.mjs" },
      ],
    });
    assert.equal(r.ran, false);
    assert.equal(r.code, "REPLAY_NOT_INDEPENDENT");
    assert.match(r.detail, /the test the patch was written against/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
