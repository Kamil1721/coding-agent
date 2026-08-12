import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff, assertSandbox, independentReplay, noOpAblationHolds, noOpAblationPatch, proveRepair, REPO_ROOT, runCommand } from "./prover.mjs";

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

/* ===========================================================================
 * THE NO-OP ABLATION (step 4). Every test below has a named mutation that
 * reddened it, watched on 2026-08-12 and quoted verbatim.
 * ======================================================================== */

/* MUTATION A5 — in prover.mjs step 4, claim the ablation was staged without staging it
 * (`const gutted = { ok: true, output: "" };`), which is the "the field exists, nothing
 * executed" shape this whole task was opened against. Watched RED 2026-08-12 in SIX tests,
 * this one included; the first of them:
 *     AssertionError: Expected values to be strictly equal:
 *       actual: 'MUTANT_NOT_CONSTRUCTIBLE', expected: 'PROVEN'
 * (the un-applied ablation's reverse-apply then fails, so the lie does not even stay quiet). */
test("the proven bundle carries a no-op ablation that was actually constructed, run, and observed FAILING", () => {
  const root = fresh();
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX });
    assert.equal(r.outcome, "PROVEN");

    // IT RAN. `ran:false` here would mean the key came from somewhere other than a process.
    assert.equal(r.ablation.ran, true, "no ablation was executed, so the transcript below cannot be a record of one");
    assert.equal(r.ablation.holds, true);
    assert.equal(r.ablation.addedLines, 1);
    assert.deepEqual(r.ablation.files, ["widget.mjs"]);

    const t = r.evidence.noOpAblation;
    assert.match(t, /^# no-op ablation of repair [0-9a-f]{32}: 1 added line\(s\) removed from widget\.mjs\n/);
    assert.match(t, /\$ node check\.mjs/, "the ablation transcript does not carry the command that was run");
    assert.match(t, /# exit code: 1\n?$/, "the accepting check did not FAIL against the no-op");

    /*
     * THE ABLATION IS NOT THE MUTANT AGAIN, AND THE BYTES SAY SO. Reverting the fix restores
     * `a - b`, so the check reports `-1`; removing the added line leaves `add` with no body at
     * all, so it reports `undefined`. Two different no-op-shaped states, two different runs.
     */
    assert.match(r.evidence.mutationRed, /add\(2, 3\) === -1/);
    assert.match(t, /add\(2, 3\) === undefined/, "the ablation transcript is the fix-revert transcript wearing a header");
    assert.notEqual(t, r.evidence.mutationRed);

    assert.equal(noOpAblationHolds(t, { diff: FIX }).holds, true, "the prover's own ablation transcript did not satisfy the prover's own reader");
    // The tree is handed back PATCHED, ablation undone: cycle.mjs restores by reverse-applying
    // the ORIGINAL diff, and an ablated tree makes that fail.
    assert.match(readFileSync(join(root, "widget.mjs"), "utf8"), /return a \+ b;/, "the ablation was left in the tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* THE CASE STEP 3 CANNOT SEE, WHICH IS THE WHOLE REASON STEP 4 EXISTS.
 *
 * The check greps for the ABSENCE of the old line — the shape an agent writes when it
 * attributes at the outcome level. Watch what each control reports on it:
 *   mutationRed  : `FAIL: the source still contains the bad subtraction` — exit 1. HOLDS.
 *   noOpAblation : `ok: no subtraction in the source`                    — exit 0. VACUOUS.
 * A revert-based mutation proof grades this check clean. The ablation refuses it.
 *
 * THE OUTCOME WORD IS `MUTATION_SURVIVED` AND THE PRECISE NAME IS IN `ablation.code`. Both
 * mean "a mutant derived from this patch left the check green", which is the sentence the
 * supervisor routes on; prover.mjs's step-4 docblock records the measurement that forced the
 * shared word (supervisor-cycle.test.mjs scans this prover for outcome literals it classifies).
 *
 * MUTATION A1 — in prover.mjs step 4, treat a passing ablation as a pass (`if (false) {`).
 * Watched RED 2026-08-12:
 *     AssertionError: a check that passes against the no-op was PROVEN: it never observes
 *     what the patch changes + expected 'PROVEN' !== 'MUTATION_SURVIVED' */
test("ABLATION_SURVIVED: a check that only observes the OLD code's absence is refused, though its mutation proof holds", () => {
  const smellCheck = `import { readFileSync } from "node:fs";
if (readFileSync("widget.mjs", "utf8").includes("a - b")) {
  console.error("FAIL: the source still contains the bad subtraction");
  process.exit(1);
}
console.log("ok: no subtraction in the source");
`;
  const root = fresh({ "check.mjs": smellCheck });
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX });
    assert.equal(r.outcome, "MUTATION_SURVIVED", "a check that passes against the no-op was PROVEN: it never observes what the patch changes");
    assert.equal(r.ablation.code, "ABLATION_SURVIVED", "the refusal does not say WHICH mutant survived, so the ledger row cannot be acted on");
    assert.equal(r.ok, false);
    assert.equal(r.evidence, undefined, "a refused ablation must not be shipped as evidence: gate.mjs:114 reads any non-empty string as the proof");
    assert.match(r.detail, /the fix-hunk revert did not/, "the sentence lets a reader think the revert mutation survived, which it did not");

    // THE POINT, MEASURED: step 3 was satisfied on this same input.
    assert.match(r.transcripts.mutationRed, /still contains the bad subtraction/);
    assert.match(r.transcripts.mutationRed, /# exit code: 1/, "the mutation proof did NOT hold here, so this fixture is not showing what it claims");
    assert.match(r.transcripts.noOpAblation, /# exit code: 0/, "the ablation was supposed to survive on this fixture");
    assert.equal(r.ablation.ran, true);
    assert.equal(r.ablation.holds, false);

    // ...and the reader agrees, from the transcript alone.
    assert.equal(noOpAblationHolds(r.transcripts.noOpAblation, { diff: FIX }).holds, false);
    assert.match(noOpAblationHolds(r.transcripts.noOpAblation, { diff: FIX }).why, /vacuous/);
    // The tree is still the patched tree, ablation undone.
    assert.match(readFileSync(join(root, "widget.mjs"), "utf8"), /return a \+ b;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* A DELETION-ONLY FIX HAS NO ABLATION, AND SAYS SO INSTEAD OF FAKING ONE.
 *
 * Removing the added lines of a diff that adds none changes nothing. The honest no-op for
 * such a fix IS the unpatched tree — byte-for-byte the revert already recorded as
 * mutationRed — so copying that transcript across would collapse two independent controls
 * into one. The key is omitted, `ok` stays true (refusing here would make an entire class of
 * legitimate repair unprovable), and the Tier 3 gate parks the patch for want of the proof.
 *
 * MUTATION A2 — in prover.mjs, fall back to the mutation transcript
 * (`...(ablation.holds || true ? { noOpAblation: ablationTranscript ?? transcripts.mutationRed } : {})`).
 * Watched RED 2026-08-12:
 *     AssertionError: a deletion-only fix shipped a noOpAblation key; nothing was ablated
 *     + expected false !== true */
test("a deletion-only fix carries NO noOpAblation key rather than a borrowed one", () => {
  const flagged = `// widget: deletion-only fixture
export function add(a, b) {
  return a + b;
}

export const BROKEN = true;

export const LABEL = "widget";
`;
  const check = `import * as w from "./widget.mjs";
if (w.BROKEN) { console.error("FAIL: the broken flag is still set"); process.exit(1); }
console.log("ok: the flag is gone");
`;
  const deletionOnly = "--- a/widget.mjs\n+++ b/widget.mjs\n@@ -5,3 +5,2 @@\n \n-export const BROKEN = true;\n \n";
  const root = fresh({ "widget.mjs": flagged, "check.mjs": check });
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: deletionOnly });
    assert.equal(r.outcome, "PROVEN", `a deletion-only repair was refused: ${r.detail ?? ""}`);
    assert.equal(Object.hasOwn(r.evidence, "noOpAblation"), false, "a deletion-only fix shipped a noOpAblation key; nothing was ablated");
    assert.equal(r.evidence.mutationRed.length > 0, true, "the rest of the bundle went missing too, so this proves nothing about the ablation key");
    assert.equal(r.ablation.ran, false);
    assert.equal(r.ablation.code, "ABLATION_ABSENT", "a deletion-only fix must say the ablation is ABSENT, not that it held");
    assert.match(r.ablation.reason, /adds no lines/);
    assert.match(r.ablation.reason, /mutationRed/, "the reason does not say why the mutation transcript may not stand in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* "COULD NOT BE STAGED" IS A DIFFERENT ANSWER FROM "HAS NO ABLATION".
 *
 * If those were reported the same way, a bug in the hunk arithmetic would read as "this diff
 * has no ablation" and every fixture above would stay green while nothing was ever ablated.
 * The input here is a check WITH SIDE EFFECTS ON THE SOURCE: on its third run (the mutant run)
 * it clobbers the file, so the unchecked re-apply of the fix at the end of step 3 silently
 * fails and the ablation cannot be staged. */
test("ABLATION_NOT_APPLICABLE: an ablation that could not be staged is a named refusal, not a skipped step", () => {
  const clobbering = `import { readFileSync, writeFileSync, existsSync } from "node:fs";
const n = (existsSync("runs") ? Number(readFileSync("runs", "utf8")) : 0) + 1;
writeFileSync("runs", String(n));
if (n === 3) { writeFileSync("widget.mjs", "// clobbered by the check itself\\n"); console.error("FAIL"); process.exit(1); }
const { add } = await import("./widget.mjs?" + n);
if (add(2, 3) !== 5) { console.error("FAIL: add(2, 3) === " + add(2, 3)); process.exit(1); }
console.log("ok");
`;
  const root = fresh({ "check.mjs": clobbering });
  try {
    const r = proveRepair({ root, command: "node check.mjs", diff: FIX });
    assert.equal(r.ablation.code, "ABLATION_NOT_APPLICABLE", `expected a staging refusal, got ${r.ablation.code}: ${r.detail ?? ""}`);
    assert.equal(r.outcome, "MUTANT_NOT_CONSTRUCTIBLE", "a mutant that could not be staged must route as a judgement on the COPY, not on the patch");
    assert.equal(r.ok, false);
    assert.equal(r.evidence, undefined);
    assert.equal(r.ablation.ran, false);
    assert.match(r.ablation.reason, /did not apply/);
    assert.match(r.detail, /never watched against a no-op/);

    // NEGATIVE HALF: the same diff on a check with no side effects stages fine, so this
    // outcome is reporting the tree and not an arithmetic bug in the patch builder.
    const clean = fresh();
    try {
      const ok = proveRepair({ root: clean, command: "node check.mjs", diff: FIX });
      assert.equal(ok.outcome, "PROVEN");
      assert.equal(ok.ablation.code, "ABLATION_HELD");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* THE HEADERS ARE PINNED AS TEXT, BECAUSE EXECUTION DOES NOT PIN THEM ALL.
 *
 * MEASURED 2026-08-12, and it is the reason this test exists as well as the applying one
 * below: mutating `noOpAblationPatch`'s running offset (`: oldStart - removedSoFar` →
 * `: oldStart`) emits `@@ -9,3 +9,2 @@` for the second hunk — a header whose new-side start is
 * arithmetically wrong — and `git apply` ACCEPTS IT AND PRODUCES THE RIGHT FILE. It locates
 * hunks by old-side start plus context and never verifies the new-side start. So the
 * apply-it-and-see test below CANNOT observe that mutation, and a byte assertion has to.
 *
 * MUTATION A3 — that same offset. Watched RED 2026-08-12 against this test:
 *     AssertionError: the second hunk's new-side start ignores the lines the first hunk
 *     already removed
 *     + actual - expected ... +   '@@ -9,3 +9,2 @@\n' + ... -   '@@ -9,3 +8,2 @@\n' + */
test("the derived ablation patch's hunk headers count exactly what it removes", () => {
  assert.equal(
    noOpAblationPatch(FIX_PLUS_SCAFFOLD).text,
    ["--- a/widget.mjs", "+++ b/widget.mjs", "@@ -2,4 +2,3 @@", "", " export function add(a, b) {", "-  return a + b;", " }", "@@ -9,3 +8,2 @@", ' export const LABEL = "widget";', "", "-// trailing note: touched by a hunk that changes no behaviour", ""].join("\n"),
    "the second hunk's new-side start ignores the lines the first hunk already removed",
  );
  // A hunk that empties its region takes the `+0,0` form `git diff` writes, not `+1,0`.
  assert.equal(
    noOpAblationPatch("--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1 +1 @@\n-old\n+new\n").text,
    "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1,1 +0,0 @@\n-new\n",
  );
});

/* AND THE SAME PATCHES ARE HANDED TO `git apply`, WHICH IS THE OTHER HALF: a header whose
 * OLD-side counts are wrong is refused outright, and every repair of that shape would then be
 * reported as an ablation that could not be staged. */
test("the derived ablation patch APPLIES on every diff shape the repair lane produces", () => {
  const shapes = [
    { label: "one hunk", files: { "widget.mjs": WIDGET_BROKEN }, diff: FIX, target: "widget.mjs", added: 1 },
    {
      label: "a one-line file the ablation empties",
      files: { "src/thing.mjs": "old\n" },
      diff: "--- a/src/thing.mjs\n+++ b/src/thing.mjs\n@@ -1 +1 @@\n-old\n+new\n",
      target: "src/thing.mjs",
      added: 1,
    },
    {
      label: "two hunks in one file",
      files: { "widget.mjs": WIDGET_BROKEN.replace("return a - b;", "return a + b;") },
      diff: FIX_PLUS_SCAFFOLD,
      target: "widget.mjs",
      added: 2,
    },
  ];
  for (const s of shapes) {
    const root = sandbox(s.files);
    try {
      const patch = noOpAblationPatch(s.diff);
      assert.equal(patch.ok, true, `no ablation patch for ${s.label}: ${patch.reason ?? ""}`);
      assert.equal(patch.addedLines, s.added, s.label);
      assert.equal(applyDiff(root, s.diff).ok, true, `the fixture's own diff did not apply for ${s.label}`);
      const before = readFileSync(join(root, s.target), "utf8");
      const gutted = applyDiff(root, patch.text);
      assert.equal(gutted.ok, true, `the derived ablation patch did not apply for ${s.label}: ${gutted.output.trim()}`);
      const ablated = readFileSync(join(root, s.target), "utf8");
      assert.notEqual(ablated, before, `${s.label}: the ablation applied but changed nothing`);
      assert.equal(before.split("\n").length - ablated.split("\n").length, s.added, `${s.label}: the wrong number of lines was removed`);
      assert.equal(applyDiff(root, patch.text, { reverse: true }).ok, true, `${s.label}: the ablation could not be undone`);
      assert.equal(readFileSync(join(root, s.target), "utf8"), before, `${s.label}: undoing the ablation did not restore the patched tree`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/* THE READER. It is satisfied by EVIDENCE, not by truthiness — which is the defect it was
 * written against: `proofsFor` in tools/tier3/gate.mjs:113-119 satisfies this same proof on
 * ANY non-empty string, measured by a reviewer on 2026-08-12 with the literal "x".
 *
 * The two hand-authored fixtures below are quoted VERBATIM from tools/tier3/gate.test.mjs
 * (lines 64 and 126). Both satisfy the live gate today; neither satisfies this reader. That
 * is the measurement behind the report's claim that hardening `proofsFor` reddens those two
 * tests — it is not an estimate.
 *
 * MUTATION A4 — in prover.mjs `noOpAblationHolds`, `return { holds: true, why: "" }` at the
 * top. Watched RED 2026-08-12:
 *     AssertionError: the literal string "x" satisfied the ablation proof + expected true !== false */
test("the ablation reader refuses prose, foreign transcripts and a check that passed — and accepts the prover's own", () => {
  const root = fresh();
  try {
    const good = proveRepair({ root, command: "node check.mjs", diff: FIX }).evidence.noOpAblation;

    // THE ACCEPTING ARM FIRST, or every assertion below passes against `return false`.
    assert.equal(noOpAblationHolds(good, { diff: FIX }).holds, true, "the prover's own transcript was refused — this reader can only refuse");

    const refused = [
      ["x", /does not begin with the prover's ablation header/, 'the literal string "x" satisfied the ablation proof'],
      ["", /absence is treated exactly like failure/, "a blank transcript satisfied the ablation proof"],
      [undefined, /absence is treated exactly like failure/, "a missing transcript satisfied the ablation proof"],
      [
        "the accepting check against a no-op implementation: FAIL dataExpectations[0].id\n# exit code: 1",
        /does not begin with the prover's ablation header/,
        "gate.test.mjs's hand-authored ablation string satisfied the reader; nothing ran to produce it",
      ],
      [
        "the accepting check against a no-op: FAIL — verbatim red",
        /does not begin with the prover's ablation header/,
        "a sentence claiming a red satisfied the reader",
      ],
      [good.replace(/# exit code: 1/, "# exit code: 0"), /vacuous/, "an ablation the check PASSED under satisfied the reader"],
      [good.replace(/\r?\n\$ node check\.mjs/, "\n"), /no command line/, "a transcript with no command in it satisfied the reader"],
    ];
    for (const [text, why, message] of refused) {
      const got = noOpAblationHolds(text, { diff: FIX });
      assert.equal(got.holds, false, message);
      assert.match(got.why, why, `wrong refusal reason for ${JSON.stringify(String(text).slice(0, 40))}: ${got.why}`);
    }

    // A REAL TRANSCRIPT ABOUT A DIFFERENT REPAIR IS STILL REFUSED — the fingerprint binds the
    // evidence to this diff, so a bundle cannot be recycled across proposals.
    const other = noOpAblationHolds(good, { diff: FIX_PLUS_SCAFFOLD });
    assert.equal(other.holds, false, "a transcript proved for a different diff satisfied this one's proof");
    assert.match(other.why, /is about repair [0-9a-f]{32}, not this one/);
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
