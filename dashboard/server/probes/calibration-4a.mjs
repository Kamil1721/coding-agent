#!/usr/bin/env node
/**
 * calibration-4a.mjs — MEASURE the scoring path, then write down what happened.
 *
 * This is step 3 of Phase 2e Task 4A: run all seven calibration fixtures through
 * the REAL sealed scorer and record the actual outcome, failing tier, failed
 * gate ids, failed criterion ids, QUALITY findings and exploit findings into
 * `probes/results/calibration-4a.json` — BEFORE any expectation is written into
 * `calibration.test.ts`. An assertion written before the measurement is a guess
 * with a green badge on it.
 *
 * It is a check as well as a recorder: it exits non-zero when a fixture
 * disagrees with `fixtures.ts`, and non-zero when it could not run at all. A
 * probe that exits 0 on FAIL is a defect this repo has already shipped.
 *
 * Usage:
 *   node probes/calibration-4a.mjs                 # all seven
 *   node probes/calibration-4a.mjs blank-page      # one
 *   CAL_CONCURRENCY=1 node probes/calibration-4a.mjs
 *   CAL_LABEL=mutation-M2 node probes/calibration-4a.mjs   # writes a labelled record
 *   CAL_DIST=../dist-mine node probes/calibration-4a.mjs   # a private build
 *
 * Exit: 0 every fixture matched, 1 a fixture disagreed, 2 it could not run.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// CAL_DIST exists because `npm run build` writes a SHARED dist/ that concurrent
// agents in this package also compile into, and a probe that recompiles under
// someone else's feet corrupts their run as well as its own. The compiled tree
// must stay at `dashboard/server/<dir>/`, though: `artefactDir()` and
// `CALIBRATION_RUN_ROOT` resolve fixtures and results by walking up from
// `import.meta.url`, so a build at any other depth silently looks for the
// artefacts in a directory that does not exist.
const DIST = process.env["CAL_DIST"]
  ? isAbsolute(process.env["CAL_DIST"])
    ? process.env["CAL_DIST"]
    : resolve(HERE, process.env["CAL_DIST"])
  : join(HERE, "..", "dist");
const RESULTS = join(HERE, "results");

let gradeFixture;
let FIXTURES;
let byName;
try {
  ({ gradeFixture } = await import(join(DIST, "calibration", "grade-fixture.js")));
  ({ FIXTURES, byName } = await import(join(DIST, "calibration", "fixtures.js")));
} catch (error) {
  process.stderr.write(`dist/ is not built or does not export the calibration modules: ${error?.message ?? error}\n`);
  process.stderr.write("Run: npm run build\n");
  process.exit(2);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = only.length > 0 ? only.map((name) => byName(name)) : [...FIXTURES];
const concurrency = Math.max(1, Number(process.env["CAL_CONCURRENCY"] ?? "3") || 1);
const label = process.env["CAL_LABEL"] ?? "baseline";

process.stdout.write(
  `CALIBRATION 4A — SCORING PATH MEASUREMENT (label: ${label})\n` +
    `${selected.length} fixture(s), concurrency ${concurrency}, real sealed container\n\n`,
);

const rows = [];
let couldNotRun = null;

async function gradeOne(fixture) {
  const startedAt = Date.now();
  try {
    const verdict = await gradeFixture(fixture);
    const row = {
      name: fixture.name,
      expected: fixture.expected,
      actual: verdict.outcome,
      expectedFailingTier: fixture.failingTier,
      actualFailingTier: verdict.failingTier,
      failedGates: verdict.failedGates,
      failedCriteria: verdict.failedCriteria,
      qualityCriteria: verdict.qualityCriteria,
      qualityFindings: verdict.qualityFindings,
      exploitFindings: verdict.exploitFindings.map((f) => ({
        rule: f.rule,
        path: f.path,
        line: f.line,
        kind: f.kind,
        blocking: f.blocking,
      })),
      blockingExploitFindings: verdict.exploitFindings.filter((f) => f.blocking).length,
      heldOutPass: verdict.heldOutPass,
      suiteSha256: verdict.suiteSha256,
      verdictHeadline: verdict.verdictMarkdown.split("\n")[0] ?? "",
      verdictBytes: verdict.verdictMarkdown.length,
      scoreRecordPath: verdict.scoreRecordPath,
      outcomeMatches: verdict.outcome === fixture.expected,
      tierMatches: verdict.failingTier === fixture.failingTier,
      // BOTH FLAVOURS OF PASS. `pass_with_notes` renders as "PASSED WITH NOTES"
      // and an owner reading it walks away trusting the artefact, so counting
      // only `pass` here would have reported "FALSE PASSES: none" for the
      // mutation run, where three broken fixtures graded PASSED WITH NOTES.
      // Measured 2026-07-29; the first version of this line did exactly that.
      falsePass: fixture.expected === "fail" && verdict.outcome !== "fail",
      wallClockMs: Date.now() - startedAt,
      error: null,
    };
    rows.push(row);
    process.stdout.write(
      `  ${row.outcomeMatches && row.tierMatches ? "MATCH" : "DIFFER"}  ${fixture.name}: ` +
        `${verdict.outcome}/${String(verdict.failingTier)} (fixture says ${fixture.expected}/${String(fixture.failingTier)}) ` +
        `[${Math.round(row.wallClockMs / 1000)}s]\n` +
        `          gates: ${verdict.failedGates.join(", ") || "(none failed)"}\n` +
        `          criteria: ${verdict.failedCriteria.join(", ") || "(none failed)"}\n` +
        `          quality: ${[...verdict.qualityCriteria, ...verdict.qualityFindings.map((f) => f.slice(0, 40))].join(" | ") || "(none)"}\n`,
    );
  } catch (error) {
    // A fixture that could not be scored is NOT a fixture that failed. It is
    // reported as an environment failure and the process exits 2, because a
    // calibration that did not run must never read as one that did.
    couldNotRun = couldNotRun ?? `${fixture.name}: ${error?.message ?? String(error)}`;
    rows.push({
      name: fixture.name,
      expected: fixture.expected,
      actual: null,
      error: String(error?.stack ?? error?.message ?? error).slice(0, 4_000),
      wallClockMs: Date.now() - startedAt,
    });
    process.stdout.write(`  COULD NOT RUN  ${fixture.name}: ${error?.message ?? error}\n`);
  }
}

const queue = [...selected];
const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (;;) {
    const next = queue.shift();
    if (next === undefined) return;
    await gradeOne(next);
  }
});
await Promise.all(workers);

rows.sort((a, b) => (a.name < b.name ? -1 : 1));

const falsePasses = rows.filter((r) => r.falsePass === true);
const outcomeMismatches = rows.filter((r) => r.error === null && r.outcomeMatches === false);
const tierMismatches = rows.filter((r) => r.error === null && r.tierMatches === false);

const record = {
  probe: "calibration-4a",
  label,
  what: "Scoring-path calibration. Committed suites, real sealed container. This measures the SCORING PATH: " +
    "Tier-0 gates, exploit detection, tier arithmetic and verdict rendering. It does NOT measure whether the " +
    "grader discriminates — the suites are committed, so their discrimination was chosen by their author, not " +
    "measured. Task 4B measures that.",
  measuredAt: new Date().toISOString(),
  scorerImage: process.env["BAKEOFF_SCORER_IMAGE"] ?? "bakeoff-scorer:1",
  concurrency,
  fixtures: rows,
  summary: {
    graded: rows.filter((r) => r.error === null).length,
    couldNotRun: rows.filter((r) => r.error !== null).length,
    outcomeMismatches: outcomeMismatches.map((r) => r.name),
    tierMismatches: tierMismatches.map((r) => r.name),
    falsePasses: falsePasses.map((r) => r.name),
    totalWallClockMs: rows.reduce((sum, r) => sum + r.wallClockMs, 0),
  },
  // Things this run MEASURED that a reader would otherwise take on trust. Each
  // one changed a design decision or is a backlog item for the owner; none of
  // them was worked around by moving an expectation.
  caveats: [
    "GATE:suite-green is a BLOCKING container gate that fails whenever ANY frozen test fails, whatever " +
      "tier its criterion declares. Every fixture the content criteria catch therefore fails at BLOCKING, " +
      "and FUNCTIONAL can never be the STRICTEST failing tier. Revision 2's R2 — 'assert the tier, it stops " +
      "a grader failing everything for the wrong reason' — is weaker than it looks; the per-fixture gate " +
      "and criterion assertions in calibration.test.ts are what actually carry that job.",
    "A QUALITY criterion cannot be carried by a frozen test, for the same reason: it would fail the run at " +
      "BLOCKING through GATE:suite-green. QUALITY findings come from qualityFindingsFor() in " +
      "src/calibration/grade-fixture.ts, outside the suite.",
    "broken-build: GATE:build fires, but with `exit 127; sh: 1: tsc: not found`. The container has no " +
      "network and the fixture's typescript is an uninstalled devDependency, so this fixture proves the " +
      "build gate catches an artefact that does not build — NOT that the grader sees the TS2345 it was " +
      "authored around. BACKLOG for the owner.",
    "stub-markers: GATE:no-stub-markers PASSES — it 'scanned 0 source file(s) of 2 walked', because " +
      "SOURCE_EXTENSIONS in bakeoff/src/tier0.ts has no .html and this fixture's TODO/FIXME markers are in " +
      "markup. The fixture still fails, via the content criteria, but the gate it is named for is inert on " +
      "it. BACKLOG for the owner; the fix is a fixture change or a bakeoff/ change.",
    "reward-hacked: GATE:no-reward-hack-exploits FIRES with one blocking finding (JS_HARD_EXIT at " +
      "tests/acceptance.spec.mjs:10). Only ONE of the three planted exploit families is detected: the " +
      "equality override is written `Object.defineProperty(C.prototype, Symbol.toPrimitive, ...)`, which " +
      "JS_PRIMITIVE_COERCION_OVERRIDE misses (it requires a computed key `[Symbol.toPrimitive]`), and the " +
      "assertion-free test carries an expect() call so no rule applies. BACKLOG for the owner.",
    "The uiFlow's waitForSelector is null, and that was measured rather than chosen: the container waits " +
      "for the selector to be VISIBLE, and blank-page's empty <body> is hidden, so any selector timed out " +
      "30 s per breakpoint, produced zero screenshots, failed GATE:screenshots-present and raised a " +
      "scorer-side infrastructure error. The fixture that fails hardest would have produced the least " +
      "evidence.",
    "correct-portfolio raised ZERO QUALITY findings, including none from the container's DOM observations. " +
      "No QUALITY signal is filtered out of the verdict input anywhere in this path.",
  ],
};

mkdirSync(RESULTS, { recursive: true });
const outFile = join(RESULTS, label === "baseline" ? "calibration-4a.json" : `calibration-4a.${label}.json`);
// The mutation records are the one thing in this file that a re-run cannot
// reproduce — each took a temporary edit to committed source. Losing them on the
// next measurement would quietly delete the evidence that calibration can fail,
// which is the only evidence that it is a test rather than a report.
try {
  const previous = JSON.parse(readFileSync(outFile, "utf8"));
  for (const key of ["mutations", "motionSatisfierSplit"]) {
    if (previous[key] !== undefined) record[key] = previous[key];
  }
} catch {
  /* no previous record: nothing to carry forward */
}
if (record.mutations === undefined) {
  // Said out loud rather than left as an absent key. A measurement file with no
  // mutation record is a file nobody has watched fail.
  record.mutationsMissing =
    "NO MUTATION RECORD. This measurement has not been shown capable of going red. See " +
    "docs/superpowers/plans/2026-07-28-phase-2e-grader.md, Revision 2 R4.";
}

/* -------------------------------------------------------------------------
 * PROVENANCE — STAMPED ON EVERY WRITE, NOT CARRIED FORWARD
 *
 * Two kinds of claim live in this file and they do not deserve the same trust.
 * `.fixtures[*]` is DERIVED: every field on it, including outcomeMatches /
 * tierMatches / falsePass, comes from a live gradeFixture() call in the run that
 * wrote the file. `.mutations[*]` is TESTIMONY: every boolean under it is a
 * literal an author typed, carried forward verbatim by the block above, and no
 * run recomputes any of it.
 *
 * That is exactly the shape of this repo's ledger defect #4 — a probe that
 * shipped `positive: true` hardcoded — and commit e7f9a1b exists precisely
 * because a wrong literal shipped in THIS block (M3 claimed a red calibration
 * run that had never happened) and nothing caught it. So the block is labelled
 * in the artefact itself: a reader scanning `.mutations[*].calibrationWentRed`
 * must be able to see, without leaving the JSON, that they are reading a claim.
 *
 * IT IS STAMPED RATHER THAN HAND-WRITTEN because the carry-forward above copies
 * only `mutations` and `motionSatisfierSplit`. A marker typed once into the JSON
 * would be dropped on the next baseline write and the file would quietly go back
 * to reading as machine-derived — the same drift it exists to prevent. Stamping
 * unconditionally also means it cannot be edited out of a single entry.
 * ---------------------------------------------------------------------- */
const MUTATION_EVIDENCE_KIND =
  "HAND-RECORDED TESTIMONY, NOT MEASURED BY THIS PROBE. Every boolean in this object — executed, " +
  "reExecutedInThisSession, restored, calibrationWentRed, guardThrew, blankPageFlip.*, fixtureFlips[*].* — " +
  "is a literal typed by the agent named in `attributedTo`. Nothing here is recomputed on a probe run. " +
  "To verify one, re-apply the edit in `whatWasChanged` and watch it yourself; do not cite this file.";

record.evidenceProvenance = {
  derived:
    ".fixtures[*] — outcome, failingTier, failedGates, failedCriteria, qualityCriteria, qualityFindings, " +
    "exploitFindings, heldOutPass, suiteSha256, verdictHeadline and the outcomeMatches / tierMatches / " +
    "falsePass verdicts computed from them. All produced by a live gradeFixture() call in the run that " +
    "wrote this file, and .summary is derived from those rows.",
  handRecorded:
    ".mutations[*] (see .mutations[*].evidenceKind, stamped on every write), .motionSatisfierSplit.perFixture " +
    "(which declares its own INHERITED provenance) and .caveats (authored prose). A mutation costs a " +
    "temporary edit to committed source plus a container run per fixture, so recomputing them on every " +
    "probe invocation is not the trade this file makes — naming them as testimony is.",
  whyThisKeyExists:
    "Ledger defect #4: a probe shipped `positive: true` as a hardcoded literal. Commit e7f9a1b exists " +
    "because a wrong literal shipped in .mutations here — M3 recorded a red calibration run that had " +
    "never been executed — and nothing caught it. Derived and hand-recorded claims sitting in one JSON " +
    "with no label between them is how that happens twice.",
  stampedOnEveryWrite: true,
};
for (const mutation of record.mutations ?? []) {
  mutation.evidenceKind = MUTATION_EVIDENCE_KIND;
}

writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

process.stdout.write(
  `\n===============================================================================\n` +
    `wrote ${outFile}\n` +
    `graded ${record.summary.graded}/${rows.length}; ` +
    `outcome mismatches: ${record.summary.outcomeMismatches.join(", ") || "none"}; ` +
    `tier mismatches: ${record.summary.tierMismatches.join(", ") || "none"}; ` +
    `FALSE PASSES: ${record.summary.falsePasses.join(", ") || "none"}\n`,
);

if (couldNotRun !== null) {
  process.stderr.write(`\nCOULD NOT RUN: ${couldNotRun}\n`);
  process.exit(2);
}
process.exit(outcomeMismatches.length === 0 && tierMismatches.length === 0 ? 0 : 1);
