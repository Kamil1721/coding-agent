/**
 * TESTS FOR THE REPLAY HARNESS — and every one of them is a NEGATIVE control.
 *
 *   node --test tools/replay/*.test.mjs
 *
 * (`node --test tools/replay/` MODULE_NOT_FOUNDs on Node 25.9 — the directory
 * form is resolved as a module. Measured, not assumed.)
 *
 * WHY THEY ARE SHAPED LIKE THIS. This repository catalogues twenty-one checks
 * that can only observe success. A replay harness is a prime candidate for the
 * twenty-second: it "passes" whenever nothing disagrees, and nothing disagrees
 * when it is looking at nothing. So the tests below do not assert that the
 * corpus passes. They assert that the harness FAILS when it should:
 *
 *   - an empty corpus is a failure, not "0 failures, PASS"
 *   - a checker that accepts everything is caught (this is the one that matters:
 *     a corpus of three recorded REJECTIONS is green against a reject-everything
 *     stub, and a must-accept case plus this arm is what closes that hole)
 *   - a checker that rejects everything is caught, in the other direction
 *   - a corrupted fixture is caught
 *   - a flipped recorded expectation is caught
 *   - three identical fixtures are caught
 *
 * MUTATION PROOFS: each `mutation` comment names a change to the PRODUCTION line
 * (not the test) that was applied, watched go red, and reverted. The verbatim red
 * output is in the lane report.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KNOWN_BAD_EXPECTED_FIELD, KNOWN_GOOD_MANIFEST, checkManifest, knownBadManifest, loadChecker } from "./checker.mjs";
import { loadCorpus } from "./corpus.mjs";
import { armChecker, armFixtureIntegrity, armFixturesDistinct, roundsToAccept, runReplay } from "./replay.mjs";
import { defectSignature, normaliseFieldPath } from "./signature.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "replay-test-"));
}

/** A stub checker module, written to disk so `loadChecker` really imports it. */
function stubChecker(dir, body) {
  const file = path.join(dir, "stub-checker.mjs");
  writeFileSync(file, body);
  return file;
}

const ACCEPT_EVERYTHING = `
export function parseSuiteManifest(raw) { return raw; }
export function collectManifestProblems() { return []; }
`;

const REJECT_EVERYTHING = `
export function parseSuiteManifest() { throw new Error("nope"); }
export function collectManifestProblems() { return [{ field: "suite.manifest.json", message: "nope", remediation: "" }]; }
`;

test("ARM 2 catches a checker that accepts everything", async () => {
  // The single most important test here. Three of the five corpus cases are
  // recorded REJECTIONS; against this stub every one of them would still be
  // "reject expected, reject got"... no — it would flip to accept, which is why
  // the must-accept cases and this arm exist together.
  const dir = scratch();
  const checker = await loadChecker(stubChecker(dir, ACCEPT_EVERYTHING));
  const arm = armChecker(checker);
  assert.equal(arm.armed, false, "a checker that accepts everything must read as BLIND");
  assert.match(arm.detail, /known-bad.*ACCEPTED/s);
});

test("ARM 2 catches a checker that rejects everything", async () => {
  const dir = scratch();
  const checker = await loadChecker(stubChecker(dir, REJECT_EVERYTHING));
  const arm = armChecker(checker);
  assert.equal(arm.armed, false, "a checker that rejects everything must read as BLIND");
  assert.match(arm.detail, /known-good manifest -> REJECTED/);
});

test("ARM 2 is ARMED against the real checker, and names the field", async () => {
  const checker = await loadChecker();
  const arm = armChecker(checker);
  assert.equal(arm.armed, true, arm.detail);
  assert.match(arm.detail, /names dataExpectations\[0\]\.minRows: yes/);
});

test("the real checker accepts the known-good and rejects the known-bad BY NAME", async () => {
  // mutation: delete the `delete bad.dataExpectations[0].minRows` line in
  // checker.mjs -> this goes red on `accepted`.
  const checker = await loadChecker();
  assert.equal(checkManifest(checker, KNOWN_GOOD_MANIFEST).accepted, true);
  const bad = checkManifest(checker, knownBadManifest());
  assert.equal(bad.accepted, false);
  assert.ok(bad.collectAllFields.includes(KNOWN_BAD_EXPECTED_FIELD), bad.collectAllFields.join(","));
});

test("an EMPTY corpus is a failure, never a vacuous pass", async () => {
  // mutation: change `armed: corpus.cases.length > 0` to `armed: true` in
  // replay.mjs -> this goes red.
  const dir = scratch();
  const empty = path.join(dir, "corpus.json");
  writeFileSync(empty, JSON.stringify({ site: "spec/suite.manifest.json", cases: [] }));
  const corpus = await loadCorpus({ expectationsFile: empty });
  assert.equal(corpus.cases.length, 0);

  const run = await runReplayWithCorpus(empty);
  assert.equal(run.ok, false, "0 cases must not report ok");
  const sizeArm = run.arms.find((a) => a.name === "corpus size");
  assert.equal(sizeArm.armed, false);
});

test("a MISSING fixture is UNARMED, not silently dropped", async () => {
  const dir = scratch();
  const spec = JSON.parse(readFileSync(path.join(HERE, "corpus.json"), "utf8"));
  const file = path.join(dir, "corpus.json");
  writeFileSync(file, JSON.stringify(spec));
  const corpus = await loadCorpus({ expectationsFile: file, fixtureDir: path.join(dir, "nowhere") });
  const unarmed = corpus.cases.filter((c) => c.manifest === null);
  assert.equal(unarmed.length, 3, "all three fixture cases must report unarmed");
  for (const c of unarmed) assert.match(c.unarmed, /fixture missing/);
});

test("ARM 3 catches a corrupted fixture", () => {
  // mutation: make armFixtureIntegrity return `armed: true` unconditionally ->
  // this goes red.
  const dir = scratch();
  cpSync(FIXTURES, dir, { recursive: true });
  assert.equal(armFixtureIntegrity(dir).armed, true, "control: the untouched copy must be ARMED");

  const target = path.join(dir, "a913c871-attempt3.manifest.json");
  const doc = JSON.parse(readFileSync(target, "utf8"));
  doc.dataExpectations.pop();
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);

  const after = armFixtureIntegrity(dir);
  assert.equal(after.armed, false, "an edited fixture must read as BLIND");
  assert.match(after.detail, /on-disk .* != recorded/);
});

test("ARM 4 catches three fixtures that are the same fixture", () => {
  // The extractor bug most likely to survive review: writing attempt 1's
  // manifest three times. Every case would still 'pass' its recorded
  // expectations if those were regenerated, and the corpus would cover one case.
  const dir = scratch();
  cpSync(FIXTURES, dir, { recursive: true });
  assert.equal(armFixturesDistinct(dir).armed, true, "control: the real fixtures differ");

  const one = readFileSync(path.join(dir, "a913c871-attempt1.manifest.json"), "utf8");
  writeFileSync(path.join(dir, "a913c871-attempt2.manifest.json"), one);
  writeFileSync(path.join(dir, "a913c871-attempt3.manifest.json"), one);
  assert.equal(armFixturesDistinct(dir).armed, false, "three copies of one manifest must read as BLIND");
});

test("a flipped recorded expectation FAILS the corpus", async () => {
  const dir = scratch();
  const spec = JSON.parse(readFileSync(path.join(HERE, "corpus.json"), "utf8"));
  const victim = spec.cases.find((c) => c.id === "a913c871-attempt3");
  victim.expect = "accept";
  const file = path.join(dir, "corpus.json");
  writeFileSync(file, JSON.stringify(spec));

  const run = await runReplayWithCorpus(file);
  assert.equal(run.ok, false);
  const got = run.results.find((r) => r.id === "a913c871-attempt3");
  assert.equal(got.verdict, "FAIL");
  assert.match(got.problems.join(" "), /outcome accept -> reject/);
});

test("a validator that stops naming a field FAILS the corpus", async () => {
  const dir = scratch();
  const spec = JSON.parse(readFileSync(path.join(HERE, "corpus.json"), "utf8"));
  const victim = spec.cases.find((c) => c.id === "a913c871-attempt2");
  victim.expectFields = [...victim.expectFields, "dataExpectations[].thisFieldNeverExisted"];
  const file = path.join(dir, "corpus.json");
  writeFileSync(file, JSON.stringify(spec));

  const run = await runReplayWithCorpus(file);
  assert.equal(run.ok, false);
  const got = run.results.find((r) => r.id === "a913c871-attempt2");
  assert.match(got.problems.join(" "), /no longer names dataExpectations\[\]\.thisFieldNeverExisted/);
});

test("the committed corpus is GREEN against the real checker, with every arm armed", async () => {
  const run = await runReplay();
  const blind = run.arms.filter((a) => !a.armed);
  assert.deepEqual(blind.map((a) => a.name), [], "no arm may be blind");
  /**
   * BOTH-DIRECTIONS ASSERTIONS FIRST, AND THE ORDER IS LOAD-BEARING. When the
   * case-count assertion came first, deleting every must-accept case threw on
   * the count and the accept assertion never executed — so the guard that makes
   * this corpus two-directional was itself never proved live. Exactly the defect
   * this file exists to refuse, found by mutation.
   */
  assert.ok(
    run.results.some((r) => r.outcome === "accept"),
    "the corpus MUST contain at least one must-accept case or it passes on a reject-everything checker",
  );
  assert.ok(
    run.results.some((r) => r.outcome === "reject"),
    "the corpus MUST contain at least one recorded rejection or it passes on an accept-everything checker",
  );
  assert.ok(run.results.length >= 5, `expected >=5 cases, got ${run.results.length}`);
  assert.equal(run.ok, true, JSON.stringify(run.results.filter((r) => r.verdict !== "OK"), null, 2));
});

test("signatures are stable across entry count and distinct across shapes", () => {
  // mutation: drop the `.replace(/\[\d+\]/g, "[]")` in signature.mjs -> the first
  // assertion goes red.
  assert.equal(normaliseFieldPath("dataExpectations[7].id"), "dataExpectations[].id");
  const a = defectSignature("s", ["dataExpectations[0].id", "dataExpectations[1].id"]);
  const b = defectSignature("s", ["dataExpectations[0].id"]);
  assert.equal(a, b, "the same defect on 1 vs 2 entries is ONE signature");
  assert.notEqual(a, defectSignature("s", ["dataExpectations[0].kind"]));
  assert.notEqual(a, defectSignature("other-site", ["dataExpectations[0].id"]));
});

test("rounds-to-accept reproduces the published collect-all figures 2/2/1", async () => {
  // The post-mortem measured these independently on 2026-08-10 from the shipped
  // bakeoff/dist. Reproducing them from an independently-extracted fixture is
  // the wiring proof: a number this harness did not produce.
  const checker = await loadChecker();
  const got = [1, 2, 3].map((n) => {
    const m = JSON.parse(readFileSync(path.join(FIXTURES, `a913c871-attempt${n}.manifest.json`), "utf8"));
    return roundsToAccept(checker, m, "collectAll");
  });
  assert.deepEqual(got, [2, 2, 1]);
});

test("rounds-to-accept shows fail-fast blowing the budget of 3", async () => {
  const checker = await loadChecker();
  const got = [1, 2, 3].map((n) => {
    const m = JSON.parse(readFileSync(path.join(FIXTURES, `a913c871-attempt${n}.manifest.json`), "utf8"));
    return roundsToAccept(checker, m, "failFast");
  });
  // 2x the post-mortem's 7/6/5 because each of these manifests carries TWO
  // dataExpectations entries; the published simulation repaired one.
  assert.deepEqual(got, [14, 12, 10]);
  for (const n of got) assert.ok(n > 3, "the point: fail-fast cannot fit in the budget of 3");
});

/**
 * Run the REAL replay against a substituted corpus file. Deliberately calls
 * `runReplay` rather than re-implementing the verdict loop: a test that scores
 * cases itself is a second, diverging harness and would keep passing after the
 * production loop broke.
 */
function runReplayWithCorpus(expectationsFile) {
  return runReplay({ corpusFile: expectationsFile });
}
