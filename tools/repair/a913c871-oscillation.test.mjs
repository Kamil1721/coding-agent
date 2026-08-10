/**
 * THE ANTI-LOOP COMPARATOR, ON RUN `a913c871`'s OWN THREE MANIFESTS.
 *
 * ─── WHY THIS FILE IS NOT ANOTHER SYNTHETIC FIXTURE ───
 *
 * `loop-guard.test.mjs` proves the four escalating arms and the three quiet ones
 * against hand-written path sets. That is the right test for the classifier and it
 * proves nothing about the SEQUENCE that actually killed a run: the paths in it
 * were typed by the same person who typed the expectations.
 *
 * This drives the comparator from the three manifest documents run `a913c871`
 * really emitted (`tools/replay/fixtures/a913c871-attempt{1,2,3}.manifest.json`,
 * extracted from the CLI session transcripts nine hours after it died), through
 * the LIVE sealed parser on disk — `bakeoff/dist/scorer-protocol.js`, loaded by
 * `tools/replay/checker.mjs`, never vendored. Nothing about the expected verdicts
 * is derivable from anything this file wrote.
 *
 * ─── WHAT IT MEASURES, AND ONE OF THE THREE IS BAD NEWS ───
 *
 *   1. The real sequence escalates, with the arm named OSCILLATION, at attempt 3.
 *   2. The real SHRINK (attempt 1 -> attempt 2, which genuinely fixed `id`) does
 *      NOT escalate. Without this half a comparator that always escalates would
 *      pass, and for an unattended machine a false stop costs the same as a miss.
 *   3. THE PRODUCTION RECORD SHAPE IS BLIND. `DefectRecord.attempts` carries
 *      `problems: string[]` — prose — and `violations: null`, so the comparator
 *      reports BLIND on the very run it was built for. That is recorded here as a
 *      failing-by-design measurement rather than a note, so the day the field
 *      travels this assertion is what has to change.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadChecker, REPO_ROOT } from "../replay/checker.mjs";
import { evaluateAttempts, classifyTransition } from "./loop-guard.mjs";
import { attemptsFromManifests, armCheck, manifestFieldPaths, manifestPathReport } from "./manifest-paths.mjs";
import { attemptPaths } from "./signature.mjs";

const FIXTURES = path.join(REPO_ROOT, "tools", "replay", "fixtures");
const SITE = "spec/failed/suite_not_audited";

function manifest(n) {
  return JSON.parse(readFileSync(path.join(FIXTURES, `a913c871-attempt${String(n)}.manifest.json`), "utf8"));
}

const checker = await loadChecker();
const documents = [manifest(1), manifest(2), manifest(3)];

test("the derivation is armed: an accepted manifest yields no paths, a refused one yields some", () => {
  /*
   * THE NEGATIVE CONTROL COMES FIRST, because every assertion below is worthless
   * if the extractor reports fields for documents that are fine. The "good"
   * document is attempt 3's with its `dataExpectations` removed — the parser
   * accepts a manifest with no data expectations, and that is checked here rather
   * than assumed.
   */
  const good = { ...manifest(3) };
  delete good.dataExpectations;
  const arm = armCheck(checker.collectManifestProblems, { good, bad: manifest(1) });
  assert.equal(arm.armed, true, `${arm.wrong.join("; ")} :: ${arm.lines.join(" | ")}`);
  assert.match(arm.lines[1], /^ARM CHECK: armed/);
});

test("the three real manifests produce the three field-path sets the post-mortem describes", () => {
  const sets = documents.map((d) => manifestFieldPaths(checker.collectManifestProblems, d));

  // MEASURED 2026-08-10 through the parser on disk. Array subscripts collapse, so
  // attempt 1's six problems over two entries are three DISTINCT paths — without
  // that collapse `[0].id` and `[1].id` are two defects and the same seat mistake
  // shards two ways.
  assert.deepEqual(sets[0], ["dataExpectations[].id", "dataExpectations[].kind", "dataExpectations[].minRows"]);
  assert.deepEqual(sets[1], ["dataExpectations[].kind", "dataExpectations[].minRows"]);
  assert.deepEqual(sets[2], [
    "dataExpectations[].file",
    "dataExpectations[].id",
    "dataExpectations[].minRows",
    "dataExpectations[].sql",
    "dataExpectations[].table",
  ]);

  // The collapse is a real reduction and not an artefact of a short list: attempt
  // 1's survey named six problems and three paths.
  const first = manifestPathReport(checker.collectManifestProblems, documents[0]);
  assert.ok(first.problems > first.paths.length, `${first.problems} problems collapsed to ${first.paths.length} paths`);
});

test("attempt 1 -> 2 is a SHRINK and does not escalate: the feedback channel was working", () => {
  const attempts = attemptsFromManifests(checker.collectManifestProblems, [documents[0], documents[1]]);
  const verdict = evaluateAttempts(attempts, { site: SITE, bakeoffCode: "suite_not_audited" });

  // `id` was named on attempt 1 and CLEARED on attempt 2 — a strict subset. A
  // comparator that escalated here would stop every ticket whose second attempt
  // made progress, and a false stop on an unattended machine costs a night.
  assert.equal(verdict.escalate, false, `a shrinking sequence escalated as ${String(verdict.arm)}: ${String(verdict.why)}`);
  assert.equal(verdict.transitions.length, 1);
  assert.equal(verdict.transitions[0].arm, "SHRINK");
  assert.equal(verdict.blind, false);
});

test("attempt 3 brings `id` back, and the comparator escalates with the OSCILLATION arm", () => {
  const attempts = attemptsFromManifests(checker.collectManifestProblems, documents);
  const verdict = evaluateAttempts(attempts, { site: SITE, bakeoffCode: "suite_not_audited" });

  /*
   * THE SEQUENCE, IN THE COMPARATOR'S OWN TERMS: {id,kind,minRows} ->
   * {kind,minRows} -> {id,file,minRows,sql,table}. `id` was reported on attempt 1,
   * absent from attempt 2, and is back on attempt 3 — a previously cleared path
   * that returned, which is the definition of the OSCILLATION arm and exactly what
   * a counter cannot see. The budget was NEVER exceeded: 3 of 3, "healthy", for
   * 1h26m54s.
   */
  assert.equal(verdict.escalate, true, "the real oscillation did not escalate at all");
  assert.equal(verdict.arm, "OSCILLATION", `escalated on the wrong arm: ${String(verdict.arm)}`);
  assert.equal(verdict.escalateAtAttempt, 3);
  assert.match(String(verdict.why), /dataExpectations\[\]\.id/, "the escalation does not name the path that came back");

  // AND THE TRANSITION IS THE ONE THE POST-MORTEM NAMES, not an accident of
  // ordering: the 1->2 step must still read SHRINK inside the full sequence.
  assert.deepEqual(verdict.transitions.map((t) => t.arm), ["SHRINK", "OSCILLATION"]);

  // Every attempt produced a signature, so the escalation is attributable.
  assert.equal(verdict.signatureHistory.length, 3);
  assert.equal(new Set(verdict.signatureHistory).size, 3, "three different defect sets hashed to fewer than three signatures");
});

test("MEASURED, AND IT IS THE GAP: on the shape the production record writes today the comparator is BLIND", () => {
  /*
   * `DefectRecord.attempts` entries are `{n, at, problems}` — see
   * defect-record.ts's `DefectAttempt` — and `violations` on the record is `null`
   * with a sentence saying why. So this is what `evaluateAttempts` is really handed
   * on the failure path today: the same three real attempts with their paths
   * flattened into prose.
   */
  const production = attemptsFromManifests(checker.collectManifestProblems, documents).map((a) => ({
    n: a.n,
    at: a.at,
    problems: a.problems,
  }));

  for (const attempt of production) {
    assert.notEqual(attempt.problems.length, 0, "the fixture lost the prose too, so this proves nothing");
    assert.equal(attemptPaths(attempt), null, "an attempt with only prose returned paths — that is the banned mechanism");
  }

  const verdict = evaluateAttempts(production, { site: SITE, bakeoffCode: "suite_not_audited" });
  assert.equal(verdict.blind, true);
  assert.equal(verdict.arm, "BLIND");
  // IT ESCALATES AT ATTEMPT 2, ON EVERY TICKET, FOR THE SAME REASON — which is why
  // this must not be wired to the strip as-is. "Refusing to guess from prose" is
  // the right behaviour for a classifier and the wrong thing to put in front of an
  // unattended machine: it stops runs that are converging.
  assert.equal(verdict.escalateAtAttempt, 2);

  // THE FIX IS ONE FIELD, AND THIS IS THE ASSERTION THAT PINS IT. The identical
  // attempts WITH `violations` see the real defect; the difference between the two
  // is `problem.field` surviving the trip out of `spec-validate.ts`.
  const sighted = evaluateAttempts(attemptsFromManifests(checker.collectManifestProblems, documents), {
    site: SITE,
    bakeoffCode: "suite_not_audited",
  });
  assert.equal(sighted.blind, false);
  assert.notEqual(sighted.arm, verdict.arm);
});

test("the checker that produced every verdict above is identified, not assumed", () => {
  // `bakeoff/dist` is a build output a concurrent lane can rebuild underneath this
  // process, and `dist/spec-agent.js` was already measurably stale against its
  // source once today. A replay result with no checker identity is unattributable.
  assert.match(checker.identity.path, /bakeoff\/dist\/scorer-protocol\.js$/);
  assert.equal(typeof checker.identity.sha256, "string");
  assert.equal(checker.identity.sha256.length, 64);
  assert.ok(checker.identity.bytes > 0);
  assert.equal(typeof checker.collectManifestProblems, "function");
  assert.equal(fileURLToPath(import.meta.url).endsWith("a913c871-oscillation.test.mjs"), true);
});

test("the comparator's quiet arms are still quiet on these paths — it is not a component that always escalates", () => {
  const sets = documents.map((d) => manifestFieldPaths(checker.collectManifestProblems, d));
  // Same real paths, arranged into the three sequences that must NOT escalate.
  assert.equal(classifyTransition(sets[0], sets[1], []).escalate, false); // shrink
  assert.equal(classifyTransition(sets[1], sets[0], []).escalate, false); // grow
  assert.equal(
    classifyTransition(sets[0], ["dataExpectations[].id", "dataExpectations[].file"], []).escalate,
    false,
    "a partial overlap escalated",
  );
  // And the one that must: the same set twice over.
  assert.equal(classifyTransition(sets[0], sets[0], []).arm, "IDENTICAL");
});
