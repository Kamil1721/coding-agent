/**
 * TIER 3 GATE — THE TESTS, AND EVERY ONE OF THEM HAS A NAMED MUTATION.
 *
 * The mutation is recorded on the assertion it reddened, in the idiom
 * `bakeoff/src/scorer-protocol.test.ts` uses. A test with no watched RED is
 * not landed in this repository: twenty-one catalogued instances of a check
 * that can only observe success, five of them found in the last two days, and
 * the components under test here — a gate, a router, a liveness-shaped arm
 * check — are exactly the kind that fail silently.
 *
 * Run:  node --test tools/tier3/gate.test.mjs
 *       (`node --test tools/tier3/` errors MODULE_NOT_FOUND on Node 25.9 —
 *        measured, not assumed. Name the file, or use a glob.)
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { CLOSURE_FLOOR, classifyDiff, classifyPath, frozenClosure } from "./closure.mjs";
import { buildFrozenManifest, isolateGateRoot, verifyFrozenManifest } from "./manifest.mjs";
import { KNOWN_BAD_FLOOR, aggregateKnownBad, loadImpossibleSet, runKnownBad } from "./known-bad.mjs";
import { proposalFingerprint } from "../repair/evidence.mjs";
import { runArmChecks } from "./armcheck.mjs";
import { decideApply, mintApplyToken, validateProposal } from "./proposal.mjs";
import { appendTrail } from "./trail.mjs";
import { CLOSURE_PROOFS, decide, proofsFor, runGate } from "./gate.mjs";
import { buildPersistenceArtefacts } from "./fixture-g.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const scratch = () => mkdtempSync(join(tmpdir(), "tier3-test-"));

function diffFor(paths) {
  return paths
    .map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-old\n+new\n`)
    .join("");
}

function proposalFor(paths, extra = {}) {
  const diff = diffFor(paths);
  return {
    signature: "sig-schema-shape-dataExpectations",
    diff,
    filesChanged: [...paths].sort(),
    touchesFrozenClosure: undefined,
    /*
     * PROVER-SHAPED, AND THE TRAILERS ARE NOT DECORATION. `validateProposal` now
     * adopts `tools/repair/evidence.mjs`'s exit-code check, which is the cheapest
     * available discriminator against a hand-written transcript: the prover is
     * the only legal producer of these strings and it always ends one with the
     * process's exit code, so a RED that exited 0 is not a RED.
     *
     * CHANGED DELIBERATELY, 2026-08-10, and the five tests it reddened were
     * re-run and re-greened rather than relaxed. Before the change this fixture's
     * transcripts were prose with no trailers and no `noOpAblation`, which is
     * exactly the bundle the accept path used to APPLY on.
     */
    evidence: {
      redBefore: "FAIL dataExpectations[0].id — verbatim red\n# exit code: 1",
      greenAfter: "pass 1 fail 0 — verbatim green\n# exit code: 0",
      mutationRed: "reverting the fix hunk: FAIL dataExpectations[0].id — verbatim red\n# exit code: 1",
      /*
       * THE HEADER AND THE FINGERPRINT ARE LOAD-BEARING SINCE 2026-08-12.
       * `proofsFor` no longer weighs this string, it READS it through the
       * prover's own `noOpAblationHolds`: prover header, a fingerprint over THIS
       * diff, a command line, and a non-zero exit trailer. The prose version
       * that used to sit here satisfied the proof, and a reviewer walked a patch
       * all the way to `applyGatedPatch` with a hand-typed sentence in this
       * field. Built from `proposalFingerprint` rather than pasted, so a fixture
       * whose diff changes cannot keep an ablation about the old one.
       */
      noOpAblation:
        `# no-op ablation of repair ${proposalFingerprint({ diff })}: 1 added line(s) removed\n` +
        "$ node --test acceptance.test.mjs\n" +
        "FAIL dataExpectations[0].id — the accepting check against a no-op implementation\n" +
        "# exit code: 1\n",
    },
    proposedAt: new Date().toISOString(),
    ...extra,
  };
}

async function gate(proposal) {
  const s = scratch();
  return await runGate({
    repoRoot: REPO_ROOT,
    proposal,
    scratch: s,
    trailDir: join(s, "trail"),
    manifestDir: join(s, "manifest"),
  });
}

/* ---------------------------------------------------------------------------
 * 1. THE CENTREPIECE. With no container evidence, an inside-closure diff can
 *    never reach APPLY.
 *
 * MUTATION M1a — in gate.mjs `decide`, stop counting the unmet proofs:
 *     const unmet = [];   // was: proofs.filter((p) => p.satisfied !== true)
 * Watched RED 2026-08-10 (this is the hunk that produced this transcript; the
 * mode filter is a DIFFERENT hunk and it is pinned separately below, because
 * on its own it survived):
 *     AssertionError: an inside-closure diff reached APPLY on host-import
 *     evidence alone. A host import proves the function on disk still rejects
 *     bad input; it does not prove the sealed scorer still fails bad work.
 *       actual: 'APPLY', expected: 'APPLY'   [assert.notEqual]
 * ------------------------------------------------------------------------- */
test("an inside-closure diff can never reach APPLY while the container legs are unarmed", async () => {
  const result = await gate(proposalFor(["bakeoff/src/scorer.ts"]));
  assert.equal(result.record.route, "INSIDE-CLOSURE");
  assert.notEqual(
    result.verdict,
    "APPLY",
    "an inside-closure diff reached APPLY on host-import evidence alone. A host import proves the function " +
      "on disk still rejects bad input; it does not prove the sealed scorer still fails bad work.",
  );
  assert.equal(result.verdict, "SELF-PROPOSE");
  assert.match(result.reason, /Tiers 1 and 2 keep running/);

  // ...and the reason is the container evidence, named proof by proof.
  const unmet = result.proofs.filter((p) => p.satisfied !== true).map((p) => p.id);
  assert.ok(unmet.includes("rescore-run1-21-20-1"), `unmet proofs were ${unmet.join(", ")}`);
  assert.ok(unmet.includes("impossible-set-failing"));
  assert.deepEqual([...CLOSURE_PROOFS].sort(), result.proofs.map((p) => p.id).sort(), "the four proofs must be the named four");
});

/* MUTATION M1b — in gate.mjs `proofsFor`, let host evidence satisfy a closure
 * proof and let UNARMED count as held:
 *     const containerResults = knownBad.results;                 // drop the mode filter
 *     const held = (rows) => rows.length > 0 && rows.every((r) => r.outcome !== "DEVIATED");
 * Watched RED 2026-08-10:
 *     AssertionError: UNARMED container evidence satisfied a closure proof ...
 * This is the mutation that matters most: it is the exact shape of instance
 * twenty-two — a trail field that reads like container evidence, produced by a
 * host import. */
test("a no-op ablation transcript does not buy the container proofs it cannot replace", async () => {
  // THE FIXTURE'S ABLATION IS GENUINE, and that is the point: it satisfies its
  // OWN proof and none of the three container ones. Until 2026-08-12 this test
  // overwrote the field with prose, because prose satisfied the proof — the
  // scaffolding was itself the defect the hardening removed.
  const result = await gate(proposalFor(["bakeoff/src/scorer.ts"]));
  const satisfied = result.proofs.filter((x) => x.satisfied === true).map((x) => x.id);
  assert.deepEqual(
    satisfied,
    ["no-op-ablation-failing"],
    `UNARMED container evidence satisfied a closure proof. satisfied=${satisfied.join(",")}`,
  );
  assert.equal(result.verdict, "SELF-PROPOSE");
});

/* ---------------------------------------------------------------------------
 * A HAND-TYPED ABLATION BUYS NOTHING, AND A PATCH LANDED THROUGH THIS.
 *
 * MEASURED 2026-08-12 by an adversarial review, end to end in a throwaway
 * repository: `noOpAblation` set to "I did not run any ablation. This string was
 * typed by hand.\n# exit code: 1" produced verdict APPLY, a 64-character token
 * that verified, intent APPLY, and `applyGatedPatch` rewriting the file on disk.
 * `proofsFor` weighed the string instead of reading it.
 * ------------------------------------------------------------------------- */
test("a hand-typed ablation is refused, and an ablation about ANOTHER repair is too", async () => {
  const typed = proposalFor(["bakeoff/src/spec-agent.ts"]);
  typed.evidence.noOpAblation = "I did not run any ablation. This string was typed by hand.\n# exit code: 1";
  const handTyped = await gate(typed);
  assert.notEqual(handTyped.verdict, "APPLY", "a hand-typed ablation reached APPLY");
  assert.equal(handTyped.applyToken, null);
  assert.match(handTyped.reason, /ablation/i);

  // RECYCLED: a real prover transcript, correct in every way, about a DIFFERENT
  // diff. The fingerprint is what refuses it.
  const recycled = proposalFor(["bakeoff/src/spec-agent.ts"]);
  recycled.evidence.noOpAblation =
    `# no-op ablation of repair ${"0".repeat(32)}: 1 added line(s) removed\n` +
    "$ node --test acceptance.test.mjs\nFAIL — verbatim red\n# exit code: 1\n";
  const stale = await gate(recycled);
  assert.notEqual(stale.verdict, "APPLY", "an ablation about another repair reached APPLY");

  // AND THE CHECK THAT PASSED UNDER THE NO-OP is a refusal, not a pass: a
  // vacuous accepting check is the thing this proof exists to catch.
  const vacuous = proposalFor(["bakeoff/src/spec-agent.ts"]);
  vacuous.evidence.noOpAblation =
    `# no-op ablation of repair ${proposalFingerprint({ diff: vacuous.diff })}: 1 added line(s) removed\n` +
    "$ node --test acceptance.test.mjs\nok 1 — still passes with the fix gutted\n# exit code: 0\n";
  const passed = await gate(vacuous);
  assert.notEqual(passed.verdict, "APPLY", "a check that PASSED under the no-op was treated as proof");

  // THE OTHER ARM: the genuine fixture still applies, or this is a proof that
  // can never be satisfied.
  const real = await gate(proposalFor(["bakeoff/src/spec-agent.ts"]));
  assert.equal(real.verdict, "APPLY", `a genuine prover ablation was refused: ${real.reason}`);
});

/* MUTATION M1b-isolated — in gate.mjs `proofsFor`, drop ONLY the mode filter:
 *     const containerResults = knownBad.results;
 * The end-to-end tests above SURVIVED that hunk on its own (the UNARMED
 * container entries kept `held()` false), so the filter needed its own pin.
 * With this test present, watched RED 2026-08-10:
 *     AssertionError: a host-import result satisfied the impossible-set proof.
 *     A host import proves the function on disk rejects bad input; the proof
 *     claims the SEALED SCORER still fails bad work. + expected true !== false
 * ------------------------------------------------------------------------- */
test("a host-import result can never satisfy a closure proof, on its own", () => {
  const knownBad = {
    results: [
      { id: "imp-002-x", area: "impossible", mode: "host-import", expect: "must-fail", outcome: "AS-REQUIRED", detail: "" },
      { id: "kb-exfil", area: "suite-integrity", mode: "host-import", expect: "must-fail", outcome: "AS-REQUIRED", detail: "" },
      { id: "kb-fixture-g-hollow", area: "persistence", mode: "host-import", expect: "must-fail", outcome: "AS-REQUIRED", detail: "" },
      { id: "kb-rescore-run1-21-20-1", area: "grader", mode: "host-import", expect: "must-pass", outcome: "AS-REQUIRED", detail: "" },
    ],
  };
  const proofs = proofsFor({ knownBad, aggregate: { verdict: "PASS" }, proposal: null });
  const byId = Object.fromEntries(proofs.map((p) => [p.id, p]));
  assert.equal(
    byId["impossible-set-failing"].satisfied,
    false,
    "a host-import result satisfied the impossible-set proof. A host import proves the function on disk rejects " +
      "bad input; the proof claims the SEALED SCORER still fails bad work.",
  );
  assert.equal(byId["known-bad-set-failing"].satisfied, false);
  assert.equal(byId["rescore-run1-21-20-1"].satisfied, false, "a host-import row satisfied the run-1 re-score proof");
  for (const id of ["impossible-set-failing", "known-bad-set-failing", "rescore-run1-21-20-1"]) {
    assert.equal(byId[id].mode, "container", `${id} must declare container-mode evidence`);
  }

  // FALSE-FAIL CONTROL: the same rows in container mode DO satisfy them, or
  // this test would pass against a `proofsFor` that always returns false.
  const asContainer = { results: knownBad.results.map((r) => ({ ...r, mode: "container" })) };
  const containerProofs = Object.fromEntries(
    proofsFor({ knownBad: asContainer, aggregate: { verdict: "PASS" }, proposal: null }).map((p) => [p.id, p]),
  );
  assert.equal(containerProofs["impossible-set-failing"].satisfied, true, "container evidence did not satisfy the proof either — proofsFor is stuck on false");
  assert.equal(containerProofs["rescore-run1-21-20-1"].satisfied, true);
});

/* MUTATION M1c — same file, `decide`: return APPLY before the `unmet` check.
 * Watched RED 2026-08-10: expected 'APPLY' !== 'SELF-PROPOSE'. */
test("the pipeline never stops: an inconclusive patch parks and self-proposing stays on", async () => {
  const result = await gate(proposalFor(["bakeoff/src/scorer.ts"]));
  assert.equal(result.selfProposing, true, "an inconclusive patch must degrade to self-PROPOSING, not stop the pipeline");
});

/* ---------------------------------------------------------------------------
 * 2. THE ADMISSION SET IS REFUSED, NOT QUEUED, AND NOT MERELY 'INSIDE'.
 *
 * MUTATION M2 — in closure.mjs `classifyDiff`, drop the admission branch
 * (`if (touchesAdmission) route = "REFUSED"`). Watched RED 2026-08-10:
 *     AssertionError: a diff touching the impossible-ticket set was routed
 *     INSIDE-CLOSURE instead of REFUSED + expected 'REFUSED' !== 'INSIDE-CLOSURE'
 * ------------------------------------------------------------------------- */
test("a diff touching the impossible-ticket set is REFUSED, never queued", async () => {
  const closure = frozenClosure(REPO_ROOT);
  const c = classifyDiff(diffFor(["bakeoff/test/tier3-fixtures/impossible/imp-002-nonexistent-table.json"]), closure);
  assert.equal(c.route, "REFUSED", "a diff touching the impossible-ticket set was not refused. A movable anchor is not an anchor.");
  const result = await gate(proposalFor(["bakeoff/test/tier3-fixtures/impossible/imp-002-nonexistent-table.json"]));
  assert.equal(result.verdict, "REFUSED");
  assert.match(result.reason, /admission predicate is the objective function/);
});

test("a diff touching the gate's own code is REFUSED at any tier", () => {
  const closure = frozenClosure(REPO_ROOT);
  assert.equal(classifyPath("tools/tier3/known-bad.mjs", closure), "admission");
  assert.equal(classifyDiff(diffFor(["tools/tier3/known-bad.mjs"]), closure).route, "REFUSED");
});

/* ---------------------------------------------------------------------------
 * 3. THE CLOSURE IS DERIVED, AND ITS FLOOR IS MEMBERSHIP NOT COUNT.
 *
 * MUTATION M3 — in closure.mjs `importClosure`, stop enqueueing transitive
 * imports (walk the entry points only). Watched RED 2026-08-10:
 *     AssertionError: the derived closure lost spec-freeze.ts ... which decides
 *     which half of the suite is held out
 * ------------------------------------------------------------------------- */
test("the frozen closure is derived from the entry points and never loses a floor member", () => {
  const closure = frozenClosure(REPO_ROOT);
  assert.deepEqual(
    closure.missingFromFloor,
    [],
    `the derived closure lost ${closure.missingFromFloor.join(", ")}. Losing spec-freeze.ts makes "which half is ` +
      `held out" editable without touching a scorer file; losing any member is the softening direction.`,
  );
  for (const name of CLOSURE_FLOOR) {
    assert.ok(closure.grader.includes(`bakeoff/src/${name}`), `${name} is not in the derived closure`);
  }
  // Additions are logged, never failed: a legitimate new import must not fail
  // the gate for the wrong reason. Monotone ratchet.
  assert.ok(Array.isArray(closure.addedSinceFloor));
  assert.ok(closure.controls.length >= 4, `only ${String(closure.controls.length)} FROZEN-CONTROLS test files were derived`);
});

/* ---------------------------------------------------------------------------
 * 4. THE KNOWN-BAD REGISTRY. FLOOR FIRST, DEVIATIONS SECOND.
 *
 * MUTATION M4 — in known-bad.mjs `aggregateKnownBad`, delete the floor check.
 * Then empty the registry (`const entries = []`). Watched RED 2026-08-10:
 *     AssertionError: the known-bad registry reports PASS with 0 entries.
 *     Emptying MUST_FAIL left the calibration gate green at 7/7 for exactly
 *     this reason + expected 'PASS' !== 'REFUSE'
 * ------------------------------------------------------------------------- */
test("an emptied known-bad registry REFUSES rather than reporting no failures", () => {
  const empty = aggregateKnownBad({ results: [] });
  assert.equal(
    empty.verdict,
    "REFUSE",
    "the known-bad registry reports PASS with 0 entries. Emptying MUST_FAIL left the calibration gate green at 7/7 " +
      "for exactly this reason (calibration/fixtures.ts:33-38).",
  );
  assert.match(empty.reason, /below the floor/);
});

test("the live known-bad registry holds every arm it claims and none of them deviated", async () => {
  const s = scratch();
  const closure = frozenClosure(REPO_ROOT);
  const iso = isolateGateRoot(REPO_ROOT, join(s, "iso"), closure);
  const run = await runKnownBad({ repoRoot: REPO_ROOT, distRoot: iso.distRoot, scratch: join(s, "kb") });
  const agg = aggregateKnownBad(run);

  assert.ok(run.registrySize >= KNOWN_BAD_FLOOR, `the registry holds ${String(run.registrySize)}, floor is ${String(KNOWN_BAD_FLOOR)}`);
  assert.deepEqual(agg.deviated.map((r) => r.id), [], "a known-bad artefact stopped failing, or a false-FAIL control stopped passing");
  assert.deepEqual(agg.inconclusive.map((r) => r.id), []);
  // AND the mode split is recorded, so no host result can be read as container evidence.
  assert.equal(agg.containerExecuted.length, 0, "no container arm can have executed in a phase where docker is unavailable");
  assert.ok(agg.unarmed.length >= 5, "the container-only arms must be REGISTERED as unarmed, not omitted");
  assert.ok(agg.executed.every((r) => r.mode === "host-import"));
});

/* ---------------------------------------------------------------------------
 * 5. FIXTURE G — THE FIRST POPULATED `dataExpectations` IN THIS REPOSITORY,
 *    AND IT IS TWO-SIDED.
 *
 * MUTATION M5 — build the "hollow" artefact with the INSERT applied (pass
 * `true` for both sides in fixture-g.mjs `buildPersistenceArtefacts`). Watched
 * RED 2026-08-10:
 *     AssertionError: the hollow artefact SATISFIED a data expectation it
 *     stores nothing for + expected true !== false
 * ------------------------------------------------------------------------- */
test("fixture G: the hollow artefact fails the data expectation and the restored one passes it", async () => {
  const s = scratch();
  const closure = frozenClosure(REPO_ROOT);
  const iso = isolateGateRoot(REPO_ROOT, join(s, "iso"), closure);
  const pair = buildPersistenceArtefacts(REPO_ROOT, join(s, "fixture-g"));
  const tier0 = await import(`file://${join(iso.distRoot, "tier0.js")}`);

  const hollow = await tier0.evaluateSqliteExpectation(pair.hollow, "db-query-7", "data/app.db", "messages", null, 1);
  const restored = await tier0.evaluateSqliteExpectation(pair.restored, "db-query-7", "data/app.db", "messages", null, 1);

  assert.equal(hollow.satisfied, false, "the hollow artefact SATISFIED a data expectation it stores nothing for");
  assert.equal(restored.satisfied, true, "the restored artefact FAILED the expectation it satisfies — the control cries wolf");
  assert.equal(restored.observedRows, 1);
  // The pair must remain ONE mutation, or it has become two artefacts.
  assert.notEqual(
    readFileSync(join(pair.hollow, "server.mjs"), "utf8"),
    readFileSync(join(pair.restored, "server.mjs"), "utf8"),
  );
});

test("fixture G's manifest is accepted by the sealed parser, populated dataExpectations and all", async () => {
  const s = scratch();
  const closure = frozenClosure(REPO_ROOT);
  const iso = isolateGateRoot(REPO_ROOT, join(s, "iso"), closure);
  const protocol = await import(`file://${join(iso.distRoot, "scorer-protocol.js")}`);
  const { fixtureManifest } = await import("./fixture-g.mjs");
  const m = fixtureManifest(REPO_ROOT);
  assert.equal(m.__comment, undefined, "the commentary key survived into the parsed document");
  assert.deepEqual(protocol.collectManifestProblems(m), []);
  const parsed = protocol.parseSuiteManifest(m);
  assert.deepEqual([...parsed.dataExpectations].map((e) => e.kind).sort(), ["http", "sqlite"]);
  assert.equal(parsed.dataExpectations.length, 2, "both kind branches must be present or one of them never executes");
});

test("the impossible-ticket set is loaded from disk and every entry says why a PASS proves softening", () => {
  const set = loadImpossibleSet(REPO_ROOT);
  assert.ok(set.length >= 4, `the impossible set holds ${String(set.length)} tickets`);
  for (const t of set) {
    assert.ok(t.whyPassProvesSoftening.length > 40, `${t.id} does not say why a pass proves softening`);
    assert.ok(["container", "host-import"].includes(t.mode));
    assert.equal(t.expectedVerdict, "fail");
  }
  assert.ok(set.some((t) => t.kind === "spec-suite-contradiction"), "the anchor set has no spec/suite contradiction in it");
  assert.ok(set.some((t) => t.armed === true), "no impossible ticket is armed today");
});

/* ---------------------------------------------------------------------------
 * 6. THE FIVE ARM CHECKS, AND EACH ONE SHOWN ABLE TO FAIL.
 *
 * MUTATION M6 — in manifest.mjs `verifyFrozenManifest`, `return {ok:true,
 * checked:0, mismatches:[]}` unconditionally. Watched RED 2026-08-10:
 *     AssertionError: ARM CHECK A1 frozen-manifest: mismatch detected on 0
 *     planted byte (must be 1) ... — BLIND
 * ------------------------------------------------------------------------- */
test("all five arm checks are exercised while the answer is known, and all five report", async () => {
  const s = scratch();
  const closure = frozenClosure(REPO_ROOT);
  const iso = isolateGateRoot(REPO_ROOT, join(s, "iso"), closure);
  const pair = buildPersistenceArtefacts(REPO_ROOT, join(s, "fixture-g"));
  const arm = await runArmChecks({
    repoRoot: REPO_ROOT,
    distRoot: iso.distRoot,
    isolatedRoot: iso.root,
    isolatedPaths: iso.copied,
    closure,
    pair,
  });
  assert.equal(arm.armed, 5, "the gate must run five armed checks; a shrinking arm block is the failure mode");
  assert.deepEqual(arm.blind, [], `blind arm(s): ${arm.lines.filter((l) => l.endsWith("BLIND")).join(" || ")}`);
  assert.equal(arm.ok, true);
  assert.deepEqual(arm.arms.map((a) => a.id), ["A1", "A2", "A3", "A4", "A5"]);
  // The container arms are REGISTERED, so their absence is visible in the block.
  assert.ok(arm.lines.some((l) => l.includes("A6 rescore: UNARMED")));
});

/* MUTATION M7 — in armcheck.mjs `armClassifier`, drop the `distinct` clause and
 * compare nothing. Then make closure.mjs `classifyPath` return "editable"
 * always. Watched RED 2026-08-10:
 *     AssertionError: ARM CHECK A4 classifier: scorer.ts→OUTSIDE-CLOSURE ... — BLIND */
test("A4 fails when the router answers the same thing for every diff", () => {
  const stuck = { grader: [], controls: [], dataPrefixes: [], admissionPrefixes: [] };
  const routes = [
    classifyDiff(diffFor(["bakeoff/src/scorer.ts"]), stuck).route,
    classifyDiff(diffFor(["tools/tier3/gate.mjs"]), stuck).route,
    classifyDiff(diffFor(["bakeoff/test/x.mjs"]), stuck).route,
  ];
  assert.equal(new Set(routes).size, 1, "the stuck-router simulation must be stuck");
  // ...and the real one must not be.
  const real = frozenClosure(REPO_ROOT);
  const realRoutes = [
    classifyDiff(diffFor(["bakeoff/src/scorer.ts"]), real).route,
    classifyDiff(diffFor(["tools/tier3/gate.mjs"]), real).route,
    classifyDiff(diffFor(["bakeoff/test/x.mjs"]), real).route,
  ];
  assert.equal(new Set(realRoutes).size, 3, `the real router answered ${realRoutes.join("/")} — it is not discriminating`);
});

/* ---------------------------------------------------------------------------
 * 7. THE TRAIL IS APPEND-ONLY, ENFORCED.
 *
 * MUTATION M8 — in trail.mjs `appendTrail`, delete the `existsSync` refusal.
 * Watched RED 2026-08-10:
 *     AssertionError: the trail overwrote an existing immutable record. Re-running
 *     until green becomes frictionless and invisible + expected true !== false
 * ------------------------------------------------------------------------- */
test("the trail refuses to overwrite an immutable history record", () => {
  const dir = scratch();
  const record = { runStamp: "2026-08-10T00-00-00-000Z", change: "c", at: "2026-08-10T00:00:00.000Z", verdict: "APPLY", applied: true };
  const first = appendTrail(record, dir);
  assert.equal(first.ok, true);
  const second = appendTrail(record, dir);
  assert.equal(
    second.ok,
    false,
    "the trail overwrote an existing immutable record. Re-running until green becomes frictionless and invisible — " +
      "the defect probes/README.md confesses and DESIGN §6.7 measures in calibration-4a.mjs today.",
  );
  const index = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n");
  assert.equal(index.length, 1, "the refused write still appended an index row");
  assert.equal(JSON.parse(index[0]).humanReviewed, null, "humanReviewed must start null and only a human may set it");
});

/* ---------------------------------------------------------------------------
 * 8. THE EVIDENCE BAR. ABSENCE IS FAILURE.
 *
 * MUTATION M9 — in proposal.mjs, loop over `[]` instead of EVIDENCE_KEYS.
 * Watched RED 2026-08-10:
 *     AssertionError: a proposal with no mutationRed transcript was accepted +
 *     expected true !== false
 * ------------------------------------------------------------------------- */
test("a proposal missing any one of the three transcripts is REFUSED, not queued", () => {
  const closure = frozenClosure(REPO_ROOT);
  for (const key of ["redBefore", "greenAfter", "mutationRed"]) {
    const p = proposalFor(["bakeoff/src/spec-agent.ts"]);
    delete p.evidence[key];
    const v = validateProposal(p, closure);
    assert.equal(v.ok, false, `a proposal with no ${key} transcript was accepted`);
    assert.equal(v.route, "REFUSED");
    assert.ok(v.refusals.some((r) => r.includes(key)));
  }
  // The false-FAIL control: a complete proposal is NOT refused.
  const good = validateProposal(proposalFor(["bakeoff/src/spec-agent.ts"]), closure);
  assert.equal(good.ok, true, `a complete proposal was refused: ${good.refusals.join("; ")}`);
});

/* ---------------------------------------------------------------------------
 * 8b. THE NEGATIVE CONTROL THE ACCEPT PATH HAD NO VERSION OF.
 *
 * MEASURED 2026-08-10, BY RUNNING IT: a proposal whose diff touched
 * `dashboard/server/src/orchestrator.ts` and whose entire evidence bundle was
 * `{redBefore:"x", greenAfter:"x", mutationRed:"x", noOpAblation:"x"}` got
 * `VERDICT APPLY: every changed path is EDITABLE and the normal gate held`,
 * `route: OUTSIDE-CLOSURE`, and a real 64-hex `applyToken`. `decide` returned
 * APPLY on OUTSIDE-CLOSURE before `proofs` was consulted at all, and the only
 * bar on that branch was `validateProposal`, which checked the three
 * transcripts for `nonEmptyString` and nothing else.
 *
 * THREE INDEPENDENT REFUSALS NOW FIRE ON THAT INPUT, and each is a check that
 * already existed, mutation-proved, in `tools/repair/evidence.mjs` with ZERO
 * cross-imports into this directory: redBefore === greenAfter, mutationRed ===
 * greenAfter, and no exit-code trailer from the prover. That last one is the
 * cheapest available discriminator against a hand-written transcript — the
 * prover is the only legal producer of these strings and it always ends one with
 * the process's exit code.
 * ------------------------------------------------------------------------- */
test('the "x"/"x"/"x" proposal is REFUSED and mints NO token — three non-blank strings are not evidence', async () => {
  const junk = {
    signature: "sig-junk-evidence",
    diff: diffFor(["dashboard/server/src/orchestrator.ts"]),
    filesChanged: ["dashboard/server/src/orchestrator.ts"],
    evidence: { redBefore: "x", greenAfter: "x", mutationRed: "x", noOpAblation: "x" },
    proposedAt: new Date().toISOString(),
  };
  const closure = frozenClosure(REPO_ROOT);
  const v = validateProposal(junk, closure);
  assert.equal(v.ok, false, "three non-blank strings were accepted as an evidence bundle");
  assert.equal(v.route, "REFUSED");
  assert.ok(v.refusals.some((r) => r.includes("RED_EQUALS_GREEN")), `no RED_EQUALS_GREEN refusal: ${v.refusals.join(" | ")}`);
  assert.ok(v.refusals.some((r) => r.includes("MUTATION_RED_EQUALS_GREEN")), `no MUTATION_RED_EQUALS_GREEN refusal: ${v.refusals.join(" | ")}`);
  assert.ok(
    v.refusals.some((r) => r.includes("EVIDENCE_EXIT_CODES_INCONSISTENT")),
    `no exit-code-trailer refusal: ${v.refusals.join(" | ")}`,
  );

  // THE WHOLE GATE, NOT ONLY THE VALIDATOR: the verdict and the token are what
  // authorise a write to the editable package.
  const ran = await gate(junk);
  assert.notEqual(ran.verdict, "APPLY", `the gate APPLIED junk evidence: ${ran.reason}`);
  assert.equal(ran.applyToken, null, "a token was minted for junk evidence");
  assert.equal(ran.record.route, "REFUSED");

  // NEGATIVE HALF: the SAME diff, same files, same signature, with transcripts
  // that differ from each other and carry the prover's exit-code trailers, is
  // NOT refused by the evidence bar. Without this, `return REFUSED` would pass.
  const honest = {
    ...junk,
    evidence: {
      redBefore: "FAIL dataExpectations[0].id\n# exit code: 1",
      greenAfter: "pass 1 fail 0\n# exit code: 0",
      mutationRed: "reverting the fix hunk: FAIL dataExpectations[0].id\n# exit code: 1",
      noOpAblation: "the accepting check against a no-op: FAIL\n# exit code: 1",
    },
  };
  const ok = validateProposal(honest, closure);
  assert.equal(ok.ok, true, `an honest bundle was refused: ${ok.refusals.join(" | ")}`);
});

/* ---------------------------------------------------------------------------
 * 8c. THE NO-OP ABLATION IS REQUIRED ON THE OUTSIDE-CLOSURE BRANCH TOO.
 *
 * It used to be consulted only for an inside-closure diff, so the branch that
 * authorises writing to the EDITABLE package — where the orchestrator, the
 * recovery classifier and the gate's own caller live — asked for less evidence
 * than the branch that authorises writing to the sealed one. The ablation is the
 * only bar that observes VACUITY of the accepting check (RESEARCH R8), and a
 * vacuous check is exactly how a self-repair loop marks its own homework.
 * ------------------------------------------------------------------------- */
test("an OUTSIDE-CLOSURE patch with no no-op ablation parks instead of applying", () => {
  const base = {
    arm: { ok: true, blind: [] },
    verify: { ok: true, mismatches: [] },
    validation: { ok: true, route: "OUTSIDE-CLOSURE", refusals: [], classified: { touchesAdmission: false } },
    aggregate: { verdict: "AS-REQUIRED", reason: "every known-bad arm held" },
  };
  const withAblation = [{ id: "no-op-ablation-failing", satisfied: true, why: "observed failing" }];
  const without = [{ id: "no-op-ablation-failing", satisfied: false, why: "no ablation transcript was supplied" }];

  const parked = decide({ ...base, proofs: without });
  assert.notEqual(parked.verdict, "APPLY", "an editable patch applied with no vacuity control on its accepting check");
  assert.equal(parked.selfProposing, true, "the patch must park while Tiers 1 and 2 keep running — it must not stop the pipeline");
  assert.match(parked.reason, /ablation/i);

  // NEGATIVE HALF: the identical inputs WITH the ablation satisfied do apply, so
  // this is not a gate that can never pass.
  assert.equal(decide({ ...base, proofs: withAblation }).verdict, "APPLY");
});

test("a proposal that under-reports its own blast radius is refused", () => {
  const closure = frozenClosure(REPO_ROOT);
  const p = proposalFor(["bakeoff/src/scorer.ts"], { touchesFrozenClosure: false });
  const v = validateProposal(p, closure);
  assert.equal(v.ok, false);
  assert.ok(v.refusals.some((r) => r.includes("touchesFrozenClosure=false")));
});

/* ---------------------------------------------------------------------------
 * 9. THE L4 APPLY TOKEN.
 *
 * MUTATION M10 — in proposal.mjs `verifyApplyToken`, `return true`. Watched RED
 * 2026-08-10:
 *     AssertionError: a token minted over a different diff was accepted +
 *     expected true !== false
 * ------------------------------------------------------------------------- */
test("apply refuses a token minted over a different diff, and refuses a missing one identically", () => {
  const inputs = { frozenDigest: "d".repeat(64), diff: diffFor(["bakeoff/src/spec-agent.ts"]), verdicts: { a: 1 } };
  const good = mintApplyToken(inputs);
  assert.equal(decideApply({ token: good, ...inputs }).apply, true);

  const other = mintApplyToken({ ...inputs, diff: diffFor(["bakeoff/src/tickets.ts"]) });
  assert.equal(decideApply({ token: other, ...inputs }).apply, false, "a token minted over a different diff was accepted");
  assert.equal(decideApply({ token: null, ...inputs }).apply, false, "a missing token was not treated like a refusal");
  assert.match(decideApply({ token: null, ...inputs }).reason, /skipped the gate/);
});

/* ---------------------------------------------------------------------------
 * 10. AN OUTSIDE-CLOSURE PATCH DOES SELF-APPLY — BUT NOT WHILE THE REGISTRY
 *     THAT PROVES THIS GATE WORKS IS UNARMED.
 *
 * REWRITTEN 2026-08-12, OWNER ARBITRATION, AND THE ORIGINAL IS QUOTED BELOW
 * BECAUSE IT WAS GREEN AND WRONG. It read:
 *
 *     test("an editable-only patch with full evidence self-applies and gets a token")
 *       assert.equal(result.verdict, "APPLY")
 *       assert.equal(result.applyToken.length, 64)
 *
 * and it passed on this machine AT THE SAME TIME as section 4's
 * `assert.equal(agg.containerExecuted.length, 0)`. Both green, together: the
 * gate minted a real apply token for a patch to the editable package on a run
 * where no container arm had executed. `decide()` never read
 * `PASS-WITH-UNARMED`, so the aggregator's own rule — "UNARMED is not PASS: it
 * degrades any proof that depends on it to INCONCLUSIVE" — was stated in one
 * file and ignored in the next.
 *
 * WHAT IS KEPT. The original's point was that the gate must be ABLE to pass:
 * without it the whole thing could be `return REFUSE` and every other test here
 * would still be green. That arm survives below as a `decide()` unit with a
 * clean aggregate, so MUTATION M11 (turn the OUTSIDE-CLOSURE branch into
 * SELF-PROPOSE) still goes red.
 *
 * WHAT IS LOST, STATED RATHER THAN HIDDEN. `runGate` has no injectable
 * known-bad seam, so the END-TO-END mint path — real gate, real token, real
 * trail — cannot execute on a machine whose container arms are unarmed, and no
 * test here exercises it any more. `mintApplyToken`/`decideApply` keep their
 * unit coverage in section 9. If the container arms are ever armed in CI, the
 * end-to-end arm should come back.
 * ------------------------------------------------------------------------- */
test("an editable-only patch self-applies when only the SEALED SCORER's legs are unarmed", async () => {
  // The four container legs are registered `armed: false` as literals — they
  // grade the sealed scorer, which an OUTSIDE-CLOSURE diff cannot touch. If this
  // parks, self-repair is inert for every patch for ever, which is how the blunt
  // version of the 2026-08-12 arbitration was measured.
  const result = await gate(proposalFor(["bakeoff/src/spec-agent.ts", "bakeoff/src/spec-validate.ts"]));
  assert.equal(result.record.route, "OUTSIDE-CLOSURE", "the a913c871 repair must classify as EDITABLE");
  assert.equal(
    result.verdict,
    "APPLY",
    `an editable patch parked although every arm that could run here held. reason: ${result.reason}`,
  );
  assert.equal(typeof result.applyToken, "string");
  assert.equal(result.applyToken.length, 64);
  assert.equal(result.trail.ok, true);

  // The unarmed legs really are all container-mode — otherwise this test is
  // asserting the rule from the wrong side.
  const written = JSON.parse(readFileSync(result.trail.file, "utf8"));
  assert.ok(written.knownBad.results.every((r) => typeof r.mode === "string"), "a known-bad result reached the trail with no execution mode");
  const unarmed = written.knownBad.results.filter((r) => r.outcome === "UNARMED");
  assert.ok(unarmed.length > 0, "no arm was unarmed, so this fixture cannot exercise the rule");
  assert.ok(unarmed.every((r) => r.mode === "container"), `a HOST arm was unarmed: ${unarmed.map((r) => r.id).join(", ")}`);
});

/* THE OTHER SIDE OF THE SAME RULE. An unarmed arm on the tier that IS doing the
 * grading is missing evidence, and no route tolerates it. */
test("an unarmed HOST arm parks the patch even when the diff is editable-only", () => {
  const base = {
    arm: { ok: true, blind: [] },
    verify: { ok: true, mismatches: [] },
    validation: { ok: true, route: "OUTSIDE-CLOSURE", refusals: [], classified: { touchesAdmission: false } },
    proofs: [{ id: "no-op-ablation-failing", satisfied: true, why: "observed failing" }],
  };
  const hostUnarmed = decide({
    ...base,
    aggregate: {
      verdict: "PASS-WITH-UNARMED",
      reason: "1 UNARMED",
      unarmed: [{ id: "kb-host-thing", mode: "host-import" }],
      executed: [{ id: "kb-other", mode: "host-import" }],
    },
  });
  assert.equal(hostUnarmed.verdict, "SELF-PROPOSE", "an unarmed HOST arm did not park an editable patch");
  assert.match(hostUnarmed.reason, /HOST arm/);

  // ...and the container-only case is the one that proceeds.
  const containerOnly = decide({
    ...base,
    aggregate: {
      verdict: "PASS-WITH-UNARMED",
      reason: "4 UNARMED",
      unarmed: [{ id: "kb-rescore-run1-21-20-1", mode: "container" }],
      executed: [{ id: "kb-other", mode: "host-import" }],
    },
  });
  assert.equal(containerOnly.verdict, "APPLY");

  // An INSIDE-CLOSURE diff never gets that tolerance.
  const inside = decide({
    ...base,
    validation: { ...base.validation, route: "INSIDE-CLOSURE" },
    aggregate: {
      verdict: "PASS-WITH-UNARMED",
      reason: "4 UNARMED",
      unarmed: [{ id: "kb-rescore-run1-21-20-1", mode: "container" }],
      executed: [{ id: "kb-other", mode: "host-import" }],
    },
  });
  assert.equal(inside.verdict, "SELF-PROPOSE", "an inside-closure diff was let through on host evidence");
});

/* NOTHING EXECUTED AT ALL is not a pass either, on any route. */
test("a registry where nothing executed parks, however the diff is routed", () => {
  const parked = decide({
    arm: { ok: true, blind: [] },
    verify: { ok: true, mismatches: [] },
    validation: { ok: true, route: "OUTSIDE-CLOSURE", refusals: [], classified: { touchesAdmission: false } },
    proofs: [{ id: "no-op-ablation-failing", satisfied: true, why: "observed failing" }],
    aggregate: { verdict: "PASS-WITH-UNARMED", reason: "all unarmed", unarmed: [{ id: "a", mode: "container" }], executed: [] },
  });
  assert.equal(parked.verdict, "SELF-PROPOSE");
  assert.match(parked.reason, /NO arm executed/);
});

/* THE ARM THE ORIGINAL TEST EXISTED FOR: the gate CAN still pass. A gate that
 * can never pass is not a gate, and MUTATION M11 must still be caught. */
test("with every known-bad arm executed, the same editable patch DOES self-apply", () => {
  const base = {
    arm: { ok: true, blind: [] },
    verify: { ok: true, mismatches: [] },
    validation: { ok: true, route: "OUTSIDE-CLOSURE", refusals: [], classified: { touchesAdmission: false } },
    proofs: [{ id: "no-op-ablation-failing", satisfied: true, why: "observed failing" }],
  };
  assert.equal(
    decide({ ...base, aggregate: { verdict: "PASS", reason: "9 arm(s) held, none unarmed" } }).verdict,
    "APPLY",
    "an editable-only patch with full evidence and a fully armed registry did not self-apply — a gate that can never pass is not a gate",
  );
  // ...and the ONLY difference that parks it is the unarmed registry.
  const parked = decide({ ...base, aggregate: { verdict: "PASS-WITH-UNARMED", reason: "5 UNARMED" } });
  assert.equal(parked.verdict, "SELF-PROPOSE");
  assert.equal(parked.selfProposing, true);
});

/* ---------------------------------------------------------------------------
 * 11. FAIL CLOSED AND LOUD. A blind arm disables self-apply and says so, and
 *     it does NOT stop Tiers 1 and 2.
 *
 * MUTATION M12 — in gate.mjs `decide`, move the `!arm.ok` branch below the
 * APPLY return. Watched RED 2026-08-10:
 *     AssertionError: a blind gate applied a patch + expected 'APPLY' !== 'REFUSE-BLIND'
 * ------------------------------------------------------------------------- */
test("a blind arm check disables self-apply, names the arm, and leaves Tiers 1 and 2 running", () => {
  const blind = decide({
    arm: { ok: false, blind: ["A1"], armed: 5 },
    verify: { ok: true, mismatches: [] },
    validation: { ok: true, route: "OUTSIDE-CLOSURE", refusals: [], classified: { touchesAdmission: false } },
    aggregate: { verdict: "PASS", reason: "" },
    proofs: [],
  });
  assert.equal(blind.verdict, "REFUSE-BLIND", "a blind gate applied a patch");
  assert.match(blind.reason, /A1/);
  assert.match(blind.reason, /Tier 1 and Tier 2 continue and the run does not stop/);
  assert.equal(blind.selfProposing, true);
});

test("a frozen-manifest mismatch refuses before any verdict is trusted", () => {
  const s = scratch();
  const closure = frozenClosure(REPO_ROOT);
  const iso = isolateGateRoot(REPO_ROOT, join(s, "iso"), closure);
  const manifest = buildFrozenManifest(REPO_ROOT, { closure });
  const scoped = { ...manifest, entries: manifest.entries.filter((e) => iso.copied.includes(e.path)) };
  assert.equal(verifyFrozenManifest(scoped, iso.root).ok, true);

  const target = join(iso.root, iso.copied[0]);
  writeFileSync(target, `${readFileSync(target, "utf8")}\n// tampered`);
  const after = verifyFrozenManifest(scoped, iso.root);
  assert.equal(after.ok, false, "the verifier read a tampered isolated copy as intact");
  assert.equal(after.mismatches.length, 1);
  assert.equal(after.mismatches[0].path, iso.copied[0]);

  const refused = decide({
    arm: { ok: true, blind: [], armed: 5 },
    verify: after,
    validation: { ok: true, route: "OUTSIDE-CLOSURE", refusals: [], classified: { touchesAdmission: false } },
    aggregate: { verdict: "PASS", reason: "" },
    proofs: [],
  });
  assert.equal(refused.verdict, "REFUSE");
});

/* MUTATION M13 — in manifest.mjs `verifyFrozenManifest`, `continue` instead of
 * pushing a mismatch when the file is absent. Watched RED 2026-08-10:
 *     AssertionError: a deleted frozen file was read as intact + expected true !== false */
test("a frozen path that has been DELETED is a mismatch, not a skip", () => {
  const manifest = { entries: [{ path: "bakeoff/src/scorer.ts", sha256: "0".repeat(64) }] };
  const v = verifyFrozenManifest(manifest, scratch());
  assert.equal(v.ok, false, "a deleted frozen file was read as intact");
  assert.equal(v.mismatches[0].got, "ABSENT");
});
