#!/usr/bin/env node
/**
 * calibration-authoring.mjs — Phase 2e Task 4B.
 * docs/superpowers/plans/2026-07-28-phase-2e-grader.md, Revision 2 R1.
 *
 * THE ONE QUESTION THIS ANSWERS: DOES THE GRADER DISCRIMINATE?
 *
 * Task 4A scores seven fixtures against a suite that was COMMITTED — written by
 * an author who had read all seven artefacts and knew which one had to fail.
 * That hardcodes the discrimination it reports, which is the shape of every
 * entry in this project's `probe-needs-negative-control` list. 4A says so in its
 * own header and is right to.
 *
 * Here the suite is authored from `PORTFOLIO_TICKET` by the real `spec-agent`,
 * over the subscription seat, with NO fixture knowledge whatsoever, audited by
 * the real `spec-validate` deterministic pass plus the adversarial judge, and
 * only THEN executed against the seven artefacts. Nobody decided in advance
 * that `blank-page` should fail. This is the only measurement in Phase 2e that
 * answers Gap 4.
 *
 * ONE SUITE, SEVEN SCORES. The ticket is identical for all seven fixtures, so a
 * per-fixture suite would reintroduce exactly the tuning 4A avoids. The harness
 * asserts the seven tickets are byte-identical before it spends a token.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT AN OUTCOME COLUMN CANNOT TELL YOU, AND WHY THIS FILE MEASURES MORE
 *
 * The spec seat authors `suite.manifest.json` from the ticket alone. It does not
 * know the seven artefacts are static one-page HTML with no lockfile —
 * `blank-page` is a single `index.html`. If the authored manifest declares a
 * server (`execution.start`/`port`/`healthPath`) or an install step, then
 * `GATE:boot` or the install gate fails on ALL SEVEN, `correct-portfolio`
 * included. `bakeoff/test/scorer-modes.e2e.mjs` exists because of exactly that:
 * a correct static site failing a BLOCKING boot gate is, in the aggregate,
 * "indistinguishable from 'the model shipped a broken app'".
 *
 * In that world `blank-page` still FAILS — and a report that stopped at the
 * outcome column would read as if the grader discriminated. It did not. It never
 * got to express a judgement.
 *
 * So this harness computes a separate DISCRIMINATION check that does not look at
 * outcomes at all:
 *
 *     which AUTHORED criteria failed on `blank-page` and passed on
 *     `correct-portfolio`?
 *
 * Empty set → discrimination is UNMEASURED, whatever the outcomes say, and the
 * harness goes red with `INCONCLUSIVE`. Non-empty → those criterion ids are the
 * measurement, and they are printed by id.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXIT CODE — stated here so nobody has to guess. (The old
 * `enforcement-probe.mjs` gate keyed on one string and EXITED 0 on a run with
 * three FAILs; the per-name allow-list below is that file's repaired shape,
 * copied rather than imported because `evaluateGate` there is not exported.)
 *
 *   2  NOT RUN — `GRADER_CALIBRATION_LIVE` is not `1`, or docker/the scorer
 *      image is absent. Never a silent green.
 *   1  RED — the authored suite failed its audit (nothing was scored), OR a
 *      fixture errored, OR there is a FALSE PASS, OR discrimination could not
 *      be measured.
 *   0  GREEN — every fixture was scored, no false pass, and the authored
 *      criteria separated `blank-page` from `correct-portfolio`.
 *
 * A FALSE FAIL IS PRINTED AS A FINDING AND DOES NOT FLIP THE CODE. 4B "informs
 * rather than gates" (the plan's own words): a `correct-portfolio` false fail is
 * something the owner must read, not a broken harness. It is listed second,
 * right after the false passes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT AUTHORED, AND MUST NOT BE READ AS IF IT WERE
 *
 * `stock-motion-only` earns `pass_with_notes` from `qualityFindingsFor` in
 * `src/calibration/grade-fixture.ts`, NOT from the authored suite. A QUALITY
 * criterion cannot be carried by a frozen test — any failing frozen test fails
 * the BLOCKING `GATE:suite-green` — so the QUALITY half comes from outside the
 * suite in 4A and in 4B alike. Its row is labelled `QUALITY-proxy` and says so.
 *
 * MEASURED HERE, 2026-07-29, answering the risk the visual-criteria agent
 * forward-flagged for this task: `visualCriteriaFor` returns TWO motion criteria
 * (`VIS-MOTION-AUTHORED`, `VIS-MOTION-RESTRAINT`) and `qualityFindingsFor`
 * grades only the first. `correct-portfolio` therefore produces ZERO quality
 * findings and grades a clean `pass`; the stagger-cap criterion has no
 * deterministic proxy and is not evaluated. The flagged false-fail risk does not
 * materialise in either 4A or 4B.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HELD-OUT BOUNDARY. `probes/results/calibration-4b.json` is a COMMITTED file.
 * `CriterionResult.detail` and `.evidenceRef` are filled by the sealed container
 * and can carry held-out test titles, so nothing derived from them is written
 * there: every carrier in the committed record is a `criterionId` — a `GATE:*`
 * id or a `REQ-nnn`. Authored test sources, test titles and `expectedTestIds`
 * never leave `dashboard/results/calibration-4b/`, which is gitignored.
 *
 * USAGE
 *   GRADER_CALIBRATION_LIVE=1 node probes/calibration-authoring.mjs
 *   node probes/calibration-authoring.mjs                  # prints NOT RUN, exit 2
 *   node probes/calibration-authoring.mjs --self-test=green
 *   node probes/calibration-authoring.mjs --self-test=false-pass
 *   node probes/calibration-authoring.mjs --self-test=audit-blocked
 *
 * The three self-tests are this harness's own negative controls. They drive the
 * SAME `classify`, `evaluateGate` and `assertAuditPassed` the live path uses,
 * over synthetic outcomes; they print `SELF-TEST — NOT A REAL RUN`, they write
 * only to a scratch path under the OS temp directory, and they cannot set
 * `liveRunExecuted` — that field is written `false` on every self-test path by
 * construction. `--self-test=green` exists so that a gate which is
 * unconditionally red — a check that can only observe failure, the same defect
 * pointing the other way — cannot hide.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "..");
const ARTEFACT_ROOT = join(SERVER, "calibration");

/** Committed record. Criterion ids only — see the held-out note above. */
const RESULTS_DIR = process.env["CALIBRATION_4B_RESULTS_DIR"]
  ? resolve(process.env["CALIBRATION_4B_RESULTS_DIR"])
  : join(HERE, "results");

/** Everything bulky, and everything container-derived. `dashboard/results/` is gitignored. */
const RUN_ROOT = resolve(SERVER, "..", "results", "calibration-4b");

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const SCORER_IMAGE = process.env["BAKEOFF_SCORER_IMAGE"] ?? "bakeoff-scorer:1";

/**
 * Private compile target for `dashboard/server/src`.
 *
 * NOT the shared `dist/`. Two sibling agents are running `npm test` into that
 * directory right now, and importing a half-written module would produce a
 * failure with nothing to do with the grader. Compiling here also guarantees the
 * modules under test are the ones on disk rather than whatever was last built.
 *
 * The `node_modules` symlink is load-bearing: `grade-fixture.js` imports the
 * `bakeoff` package, which resolves through `dashboard/server/node_modules`, and
 * a build tree outside the package cannot see it.
 */
const BUILD_DIR = process.env["CALIBRATION_4B_BUILD_DIR"]
  ? resolve(process.env["CALIBRATION_4B_BUILD_DIR"])
  : join(tmpdir(), "calibration-4b-build");

/**
 * Seat selection and the spend boundary, DEFINED HERE rather than imported from
 * `orchestrator.ts` — and the reason is measured, not stylistic.
 *
 * `orchestrator.ts` is the dashboard's whole run engine and it is being edited
 * by a sibling agent right now; its emitted JS was, at the time of writing, not
 * importable at all. A one-shot measurement that spends the owner's quota must
 * not be hostage to that.
 *
 * The values mirror `orchestrator.ts` exactly, and the divergence risk is small
 * in the direction that matters: `subscription-caller.ts` records that the
 * DOLLAR ceiling can never fire on a subscription (the worst case passed to
 * `checkBeforeCall` is 0), so the only live boundary here is `maxWallClockMs`,
 * which is this probe's own boundary to set. `"default"` is a real id in the
 * Claude CLI's model list and means "the model the CLI recommends"; pinning a
 * literal wire id would trade a true statement for a brittle one.
 */
const SPEC_MODEL_ENV = "DASHBOARD_SPEC_MODEL";
const DEFAULT_SPEC_MODEL = "default";
const CALIBRATION_BUDGET = Object.freeze({
  maxCostUsd: 1,
  maxWallClockMs: 60 * 60 * 1000,
  maxCampaignCostUsd: 1,
  warnAtFraction: 0.8,
  perVendorMaxOutputTokens: null,
  vendorAdvisoryBudgets: [],
});

/* ---------------------------------------------------------------------------
 * Reporting primitives
 * ------------------------------------------------------------------------ */

const out = (line = "") => process.stdout.write(`${line}\n`);

/** Terminal states a fixture row can land in. Order matters in the report. */
const FALSE_PASS = "FALSE-PASS";
const FALSE_FAIL = "FALSE-FAIL";
const MISMATCH = "MISMATCH";
const MATCH = "MATCH";
const ERROR = "ERROR";

/**
 * One fixture's row.
 *
 * `carriedBy` is derived from criterion IDS ONLY. Deriving it from
 * `CriterionResult.detail` would be the natural thing to write and would put
 * container-authored text — which can quote a held-out test title — into a
 * committed file.
 */
function classifyOne(fixture, outcome) {
  if (outcome.error !== null && outcome.error !== undefined) {
    return {
      name: fixture.name,
      expected: fixture.expected,
      actual: "error",
      failingTier: null,
      carriedBy: `ERROR: ${outcome.error}`,
      status: ERROR,
    };
  }

  const carriers = [...outcome.failedGates, ...outcome.failedCriteria];
  let carriedBy;
  if (outcome.actual === "fail") {
    carriedBy = carriers.length > 0 ? carriers.join(" + ") : "(failed with no named criterion)";
  } else if (outcome.actual === "pass_with_notes") {
    const ids = outcome.qualityFindingIds.join(", ");
    carriedBy = `QUALITY-proxy: ${ids.length > 0 ? ids : "(unnamed)"} — NOT authored by the suite`;
  } else {
    carriedBy = "—";
  }

  // THE CATASTROPHIC DIRECTION. A fixture that must fail and did not is a false
  // pass whether it graded `pass` or `pass_with_notes`: both leave the owner
  // with a run that did not fail.
  let status;
  if (fixture.expected === "fail" && outcome.actual !== "fail") {
    status = FALSE_PASS;
  } else if (fixture.expected !== "fail" && outcome.actual === "fail") {
    status = FALSE_FAIL;
  } else if (fixture.expected === outcome.actual) {
    status = MATCH;
  } else {
    status = MISMATCH;
  }

  return {
    name: fixture.name,
    expected: fixture.expected,
    actual: outcome.actual,
    failingTier: outcome.failingTier,
    carriedBy,
    status,
  };
}

/**
 * The whole matrix, plus the discrimination check that outcomes cannot give.
 *
 * `outcomes` is a Map name -> { actual, failingTier, failedGates, failedCriteria,
 * qualityFindingIds, error }. Synthetic in the self-tests, container-derived in
 * the live run — deliberately the same function, so the self-tests exercise the
 * code the live run depends on rather than a copy of it.
 */
function classify(fixtures, outcomes) {
  const rows = fixtures.map((fixture) => {
    const outcome = outcomes.get(fixture.name);
    if (outcome === undefined) {
      return {
        name: fixture.name,
        expected: fixture.expected,
        actual: "not-scored",
        failingTier: null,
        carriedBy: "ERROR: the fixture was never scored",
        status: ERROR,
      };
    }
    return classifyOne(fixture, outcome);
  });

  const blank = outcomes.get("blank-page");
  const correct = outcomes.get("correct-portfolio");
  const authoredFailedOnBlank = blank === undefined ? [] : blank.failedCriteria;
  const authoredFailedOnCorrect = correct === undefined ? [] : correct.failedCriteria;
  // The AUTHORED criteria that separate the killer fixture from the control. A
  // gate id can never appear here: `GATE:*` ids are the container's, not the
  // suite's, and a run carried entirely by gates measured the execution mode,
  // not the grader's judgement.
  const discriminatingCriteria = authoredFailedOnBlank.filter(
    (id) => !authoredFailedOnCorrect.includes(id),
  );

  const carriersOf = (o) => (o === undefined ? [] : [...o.failedGates, ...o.failedCriteria].sort());
  const blankCarriers = carriersOf(blank);
  const correctCarriers = carriersOf(correct);

  return {
    rows,
    falsePasses: rows.filter((r) => r.status === FALSE_PASS),
    falseFails: rows.filter((r) => r.status === FALSE_FAIL),
    mismatches: rows.filter((r) => r.status === MISMATCH),
    matches: rows.filter((r) => r.status === MATCH),
    errors: rows.filter((r) => r.status === ERROR),
    blankPageFailed: rows.find((r) => r.name === "blank-page")?.actual === "fail",
    discrimination: {
      measured: discriminatingCriteria.length > 0,
      discriminatingCriteria,
      blankPageCarriers: blankCarriers,
      correctPortfolioCarriers: correctCarriers,
      carriersIdentical:
        blankCarriers.length === correctCarriers.length &&
        blankCarriers.every((id, i) => id === correctCarriers[i]),
    },
  };
}

/**
 * The exit gate. One line per named condition, `ok` drives the exit code.
 *
 * Copied in SHAPE from the repaired gate in `enforcement-probe.mjs` (a per-name
 * allow-list, strictest default for anything unlisted, one printed line per
 * entry) rather than imported: `evaluateGate` there is not exported, and a
 * fifth hand-rolled gate that exits 0 on FAIL is precisely what the plan told
 * this task not to write.
 */
const GATE_CONDITIONS = [
  {
    name: "suite-audited",
    describe: (s) =>
      s.auditPassed === true
        ? `the authored suite passed the bad-test audit before any artefact was scored (${s.auditNote})`
        : `the authored suite FAILED the bad-test audit, so nothing was scored against it (${s.auditNote})`,
    ok: (s) => s.auditPassed === true,
  },
  {
    name: "all-scored",
    describe: (s) =>
      s.matrix.errors.length === 0
        ? "every fixture was scored"
        : `${String(s.matrix.errors.length)} fixture(s) errored: ${s.matrix.errors.map((r) => r.name).join(", ")}`,
    ok: (s) => s.matrix.errors.length === 0,
  },
  {
    name: "no-false-pass",
    describe: (s) =>
      s.matrix.falsePasses.length === 0
        ? "no fixture that must fail was graded green"
        : `FALSE PASS on ${s.matrix.falsePasses.map((r) => r.name).join(", ")} — the owner would trust a lie`,
    ok: (s) => s.matrix.falsePasses.length === 0,
  },
  {
    name: "discrimination-measured",
    describe: (s) =>
      s.matrix.discrimination.measured
        ? `authored criteria separated blank-page from correct-portfolio: ${s.matrix.discrimination.discriminatingCriteria.join(", ")}`
        : "INCONCLUSIVE: no AUTHORED criterion failed on blank-page and passed on correct-portfolio, so " +
          "whatever the outcome column says, the grader's JUDGEMENT was never measured — the run was " +
          "carried by container gates (execution mode), not by what the suite decided to check",
    ok: (s) => s.matrix.discrimination.measured === true,
  },
];

function evaluateGate(state) {
  const lines = [];
  let ok = true;
  for (const condition of GATE_CONDITIONS) {
    const passed = condition.ok(state) === true;
    if (!passed) ok = false;
    lines.push(`GATE  ${condition.name.padEnd(24)} ${passed ? "ok " : "RED"}  ${condition.describe(state)}`);
  }
  // Reported, never gating. See the exit-code note in the header.
  if (state.matrix.falseFails.length > 0) {
    lines.push(
      `NOTE  ${"false-fail".padEnd(24)} —    FALSE FAIL on ${state.matrix.falseFails
        .map((r) => r.name)
        .join(", ")} — burns fix rounds a real run cannot win. Reported, not gating.`,
    );
  }
  if (state.matrix.mismatches.length > 0) {
    lines.push(
      `NOTE  ${"mismatch".padEnd(24)} —    ${state.matrix.mismatches
        .map((r) => `${r.name}: expected ${r.expected}, got ${r.actual}`)
        .join("; ")}. Reported, not gating.`,
    );
  }
  return { ok, lines };
}

function printReport(state) {
  out();
  out("═══ FALSE PASSES — the catastrophic direction, listed first ═════════════════");
  if (state.matrix.falsePasses.length === 0) {
    out("  none. No fixture that must fail was graded green.");
  } else {
    for (const row of state.matrix.falsePasses) {
      out(`  ${row.name}: expected ${row.expected}, graded ${row.actual}. Carried by: ${row.carriedBy}`);
    }
  }

  out();
  out("═══ FALSE FAILS — reported, never gating ════════════════════════════════════");
  if (state.matrix.falseFails.length === 0) {
    out("  none.");
  } else {
    for (const row of state.matrix.falseFails) {
      out(`  ${row.name}: expected ${row.expected}, graded ${row.actual}. Carried by: ${row.carriedBy}`);
    }
  }

  out();
  out("═══ CONFUSION MATRIX ════════════════════════════════════════════════════════");
  out(
    `  ${"fixture".padEnd(19)}${"expected".padEnd(17)}${"actual".padEnd(17)}${"tier".padEnd(11)}${"status".padEnd(12)}carried by`,
  );
  for (const row of state.matrix.rows) {
    out(
      `  ${row.name.padEnd(19)}${row.expected.padEnd(17)}${String(row.actual).padEnd(17)}` +
        `${String(row.failingTier ?? "—").padEnd(11)}${row.status.padEnd(12)}${row.carriedBy}`,
    );
  }

  out();
  out("═══ DISCRIMINATION — what the outcome column cannot tell you ════════════════");
  const d = state.matrix.discrimination;
  out(`  authored criteria failing on blank-page but passing on correct-portfolio: ${d.discriminatingCriteria.join(", ") || "(none)"}`);
  out(`  blank-page carried by:        ${d.blankPageCarriers.join(", ") || "(nothing failed)"}`);
  out(`  correct-portfolio carried by: ${d.correctPortfolioCarriers.join(", ") || "(nothing failed)"}`);
  if (d.carriersIdentical) {
    out("  THE TWO CARRIER SETS ARE IDENTICAL. The killer fixture and the false-fail control failed for");
    out("  exactly the same reasons, so the grader's judgement was not exercised on this run.");
  }

  out();
  out(`  ${String(state.matrix.matches.length)}/${String(state.matrix.rows.length)} fixture(s) matched the expected outcome.`);
  out();
  for (const line of state.gate.lines) out(line);
  out();
  out(state.gate.ok ? "RESULT: GREEN" : "RESULT: RED");
}

/* ---------------------------------------------------------------------------
 * The audit gate — `contracts.ts:314-317`
 * ------------------------------------------------------------------------ */

class AuditBlocked extends Error {}

/**
 * A suite that fails the audit must never have artefacts scored against it.
 * `contracts.ts:314-317`: "TDFlow's entire +26.3pp effect lives in bad-test
 * detection; a suite that fails the audit must never have builds run against it."
 *
 * `generateAuditedSuite` structurally cannot RETURN an unaudited suite — it
 * regenerates, then throws `suite_not_audited`. This asserts the invariant held
 * rather than reconstructing a `SuiteDraft` to re-run `deterministicAudit` over:
 * `criteriaFromDraft` is lossy, so a reconstruction would be testing itself.
 * The attempt count is recorded so the report shows how many regenerations the
 * audit forced.
 */
function assertAuditPassed(authored) {
  const blocking = authored.findings.filter((f) => f.mustRegenerate === true);
  if (authored.suite.auditPassed !== true || blocking.length > 0) {
    throw new AuditBlocked(
      "the AUTHORED suite did not pass the bad-test audit, so NO artefact was scored against it " +
        `(auditPassed=${String(authored.suite.auditPassed)}, ${String(blocking.length)} blocking finding(s)): ` +
        blocking.map((f) => `${String(f.criterionId ?? "-")} [${f.kind}] ${f.detail}`).join(" | "),
    );
  }
  return {
    attempts: authored.attempts.length,
    findings: authored.findings.length,
    blocking: blocking.length,
  };
}

/* ---------------------------------------------------------------------------
 * Pre-registration — deterministic, free, and written BEFORE anything is scored
 * ------------------------------------------------------------------------ */

/**
 * What each artefact actually contains, by a rule that knows nothing about
 * which fixture it is looking at.
 *
 * Recorded BEFORE the authored suite is scored, so that a `correct-portfolio`
 * failure is attributable rather than argued after the fact: either the grader
 * is too strict, or the fixture labelled THE FALSE-FAIL CONTROL does not
 * actually satisfy the ticket it is graded against. Post-hoc that distinction
 * is unfalsifiable; pre-registered it is a lookup.
 */
function artefactFacts(dir) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(join(current, entry.name), rel);
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  };
  walk(dir, "");

  let markup = "";
  for (const rel of files) {
    if (/\.(html?|js|mjs|cjs|ts)$/i.test(rel)) markup += `${readFileSync(join(dir, rel), "utf8")}\n`;
  }

  const count = (re) => (markup.match(re) ?? []).length;
  return {
    files: files.sort(),
    h1Count: count(/<h1[\s>]/gi),
    h3Count: count(/<h3[\s>]/gi),
    mentionsTicketSubject: /ada\s+lovelace/i.test(markup),
    hasProjectsSection: /id\s*=\s*["']?projects/i.test(markup),
    hasContactSection: /id\s*=\s*["']?contact/i.test(markup),
    hasForm: /<form[\s>]/i.test(markup),
    hasSubmitHandler: /addEventListener\s*\(\s*['"`]submit['"`]/i.test(markup),
    stubMarkers: count(/\b(TODO|FIXME|Coming soon)\b/gi),
    hasPackageJson: files.includes("package.json"),
    shipsOwnTests: files.some((f) => /(^|\/)tests?\//i.test(f) || /\.(spec|test)\.[cm]?[jt]s$/i.test(f)),
  };
}

/* ---------------------------------------------------------------------------
 * Build the private module tree
 * ------------------------------------------------------------------------ */

/**
 * The modules this probe actually loads. A `tsc` diagnostic in one of these is
 * FATAL; a diagnostic anywhere else is recorded and stepped over.
 *
 * WHY THE ASYMMETRY, AND IT IS NOT CONVENIENCE. `tsc -p` compiles the whole
 * `src/` tree, and two sibling agents are editing that tree right now. MEASURED
 * 2026-07-29: a mid-edit `orchestrator.ts` emitted `orchestrator.js` containing
 * `Private field '#recordAssumptions' must be declared in an enclosing class` —
 * a SYNTAX error in the emitted JavaScript, not merely a type complaint, so the
 * module could not be imported at all. This probe spends the owner's quota on a
 * model call and can only be run once; refusing to run because a file it never
 * loads was mid-save would waste that, and compiling the whole tree anyway is
 * what keeps a break in a file it DOES load from being stepped over silently.
 *
 * `tsconfig.json` does not set `noEmitOnError`, so `tsc` emits despite
 * diagnostics. Every diagnostic is printed and written into the committed
 * record, so a run compiled over a broken tree cannot look clean.
 */
const REQUIRED_MODULES = [
  "api-types",
  "calibration/fixtures",
  "calibration/grade-fixture",
  "calibration/suites/portfolio-suite",
  "claude-common",
  "spec-assumptions",
  "subprocess-env",
  "subscription-caller",
  "tokens",
  "verdict",
  "visual-criteria",
];

function compileServerSources() {
  mkdirSync(BUILD_DIR, { recursive: true });
  let diagnostics = "";
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--outDir", BUILD_DIR], {
      cwd: SERVER,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    diagnostics = `${String(error.stdout ?? "")}${String(error.stderr ?? "")}`.trim();
  }

  const lines = diagnostics.split("\n").filter((line) => line.trim().length > 0);
  const fatal = lines.filter((line) => {
    const match = /^src\/(.+?)\.ts\(/.exec(line.trim());
    return match !== null && REQUIRED_MODULES.includes(match[1]);
  });
  if (fatal.length > 0) {
    throw new NotRun(
      "a module this probe loads does not compile, so nothing below it can be measured:\n  " +
        fatal.join("\n  "),
    );
  }
  if (lines.length > 0) {
    out("  tsc reported diagnostics in files this probe does NOT load — stepping over them, recorded verbatim:");
    for (const line of lines) out(`    ${line}`);
  }

  const link = join(BUILD_DIR, "node_modules");
  try {
    if (existsSync(link)) unlinkSync(link);
  } catch {
    /* a stale link that cannot be removed will surface as a resolution error */
  }
  symlinkSync(join(SERVER, "node_modules"), link, "dir");
  return lines;
}

const importBuilt = (rel) => import(pathToFileURL(join(BUILD_DIR, rel)).href);

/* ---------------------------------------------------------------------------
 * Preflight — every one of these is NOT RUN, never a skip into green
 * ------------------------------------------------------------------------ */

class NotRun extends Error {}

function preflight() {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    throw new NotRun(
      "the docker daemon is not reachable, so the sealed scorer container could not run. " +
        "This is NOT RUN, not a pass: start Docker and re-run.",
    );
  }
  let imageId;
  try {
    imageId = execFileSync("docker", ["image", "inspect", SCORER_IMAGE, "--format", "{{.Id}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new NotRun(
      `the scorer image ${SCORER_IMAGE} is not built. From bakeoff/:\n` +
        "  docker build --provenance=false --sbom=false -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .",
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new NotRun(`docker reported ${JSON.stringify(imageId)} for ${SCORER_IMAGE}, which is not a content digest`);
  }
  return imageId;
}

/** `freezeSuite` writes 0444, so a previous tree cannot simply be unlinked. */
function resetDir(dir) {
  if (existsSync(dir)) {
    try {
      execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
    } catch {
      /* best effort; rmSync reports the real problem with the real path */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

/* ---------------------------------------------------------------------------
 * The live run
 * ------------------------------------------------------------------------ */

async function liveRun() {
  const imageId = preflight();

  out("compiling dashboard/server/src into a private build tree (the shared dist/ is in use by siblings)…");
  const compileDiagnostics = compileServerSources();
  out(`  build tree: ${BUILD_DIR}`);

  const { FIXTURES } = await importBuilt("calibration/fixtures.js");
  const { qualityFindingsFor } = await importBuilt("calibration/grade-fixture.js");
  const { computeOutcome, failingTier, renderVerdict } = await importBuilt("verdict.js");
  const { extractAssumptions } = await importBuilt("spec-assumptions.js");
  const { SubscriptionSeatCaller } = await importBuilt("subscription-caller.js");

  const bakeoff = (rel) => import(pathToFileURL(join(SERVER, "node_modules", "bakeoff", "dist", rel)).href);
  const { BAKEOFF_SCHEMA_VERSION } = await bakeoff("contracts.js");
  const { DEFAULT_BUDGET, JUDGE_SEAT, SEALED_NETWORK_POLICY, SPEC_SEAT, getConfig, heldConstantsFor } =
    await bakeoff("config.js");
  const { ticketDigest } = await bakeoff("hash.js");
  const { generateAuditedSuite } = await bakeoff("spec-agent.js");
  const { freezeSuite, verifySuiteIntact } = await bakeoff("spec-freeze.js");
  const { createGate } = await bakeoff("gate.js");

  /* ---- ONE ticket, or this is not one measurement ---------------------- */

  const tickets = new Set(FIXTURES.map((f) => f.ticket));
  if (tickets.size !== 1) {
    throw new NotRun(
      `the ${String(FIXTURES.length)} fixtures carry ${String(tickets.size)} distinct tickets. 4B authors ONE ` +
        "suite and scores every artefact against it; with more than one ticket that is not what would happen.",
    );
  }
  const brief = FIXTURES[0].ticket;
  const ticket = {
    id: "CAL4B-PORTFOLIO",
    // `TicketTier` is "trivial" | "medium" | "hard" (contracts.ts:234). The tier
    // is out-of-band metadata the spec seat is never shown — `ticketTurn` passes
    // the id and the brief only — so it cannot bias what gets authored.
    tier: "medium",
    title: "portfolio site (Phase 2e Task 4B authoring calibration)",
    brief,
    sha256: ticketDigest(brief),
  };

  /* ---- pre-registration, before a single token is spent ---------------- */

  const preRegistered = {};
  for (const fixture of FIXTURES) preRegistered[fixture.name] = artefactFacts(join(ARTEFACT_ROOT, fixture.name));

  const base = join(RUN_ROOT, RUN_STAMP);
  const acceptanceRoot = join(base, "acceptance");
  const resultsDir = join(base, "results");
  const runDir = join(base, "run");
  // A FRESH ROOT PER RUN, and it is load-bearing. `authorAndFreezeSuite` reuses
  // an intact freeze for the same ticket id; inheriting one would make "authored
  // blind, this run" false while the report went on claiming it.
  resetDir(base);
  for (const dir of [acceptanceRoot, resultsDir, runDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, "pre-registered-artefact-facts.json"), `${JSON.stringify(preRegistered, null, 2)}\n`, "utf8");

  /* ---- author, from the ticket alone ----------------------------------- */

  const env = { ...process.env };
  const modelId = (env[SPEC_MODEL_ENV] ?? "").trim() || DEFAULT_SPEC_MODEL;
  const specSeat = { ...SPEC_SEAT, modelId };
  const judgeSeat = { ...JUDGE_SEAT, modelId };

  const specCaller = new SubscriptionSeatCaller(specSeat, { budget: CALIBRATION_BUDGET, cwd: base, env });
  const judgeCaller = new SubscriptionSeatCaller(judgeSeat, {
    // ONE ceiling across author and judge, as the orchestrator does: a per-call
    // ceiling is a ceiling that never fires.
    budget: CALIBRATION_BUDGET,
    ceiling: specCaller.ceiling,
    cwd: base,
    env,
  });

  out();
  out(`authoring the acceptance suite from the ticket alone, over the subscription seat (${modelId})…`);
  out("  the spec seat is given the ticket brief and nothing else — no fixture, no artefact, no expectation.");
  const authoredAt = new Date().toISOString();
  const authored = await generateAuditedSuite(ticket, {
    specSeat,
    judgeSeat,
    specCaller,
    judgeCaller,
    ceiling: specCaller.ceiling,
    budget: CALIBRATION_BUDGET,
    harness: { id: "dashboard-calibration-4b", version: "0.1.0", commit: "unversioned" },
  });
  specCaller.assertUnused();
  judgeCaller.assertUnused();

  // PERSISTED BEFORE ANY CONTAINER STARTS. Seven scoring runs after a paid
  // Opus-xhigh authoring call is a lot of exposure to lose to a docker hiccup.
  // Sources go here, under the gitignored run root — never into probes/results.
  writeFileSync(
    join(base, "authored-suite.json"),
    `${JSON.stringify({ authoredAt, suite: authored.suite, files: authored.files, plan: authored.plan, findings: authored.findings, attempts: authored.attempts, usage: authored.usage }, null, 2)}\n`,
    "utf8",
  );
  out(`  authored ${String(authored.suite.criteria.length)} criteria in ${String(authored.attempts.length)} attempt(s); suite ${authored.suite.sha256.slice(0, 16)}…`);
  out(`  spec seat tokens: ${JSON.stringify(specCaller.tokens)}`);
  out(`  judge seat tokens: ${JSON.stringify(judgeCaller.tokens)}`);

  /* ---- the audit gate, BEFORE any artefact is scored ------------------- */

  const auditSummary = assertAuditPassed(authored);
  out(
    `  bad-test audit: PASSED after ${String(auditSummary.attempts)} attempt(s), ` +
      `${String(auditSummary.findings)} finding(s), ${String(auditSummary.blocking)} blocking.`,
  );

  /* ---- freeze ONCE, score seven times ---------------------------------- */

  freezeSuite(
    { suite: authored.suite, plan: authored.plan, files: authored.files, auditFindings: [...authored.findings] },
    { acceptanceRoot },
  );
  const intact = verifySuiteIntact(ticket.id, { acceptanceRoot });
  if (intact.intact !== true) {
    throw new NotRun(`the frozen authored suite for ${ticket.id} did not verify intact after freezing`);
  }

  const gate = await createGate({
    ...process.env,
    BAKEOFF_SCORER_IMAGE: SCORER_IMAGE,
    BAKEOFF_RESULTS_DIR: resultsDir,
    BAKEOFF_ACCEPTANCE_ROOT: acceptanceRoot,
  });

  const config = getConfig("A");
  const statementFor = new Map(authored.suite.criteria.map((c) => [c.id, c.statement]));

  const outcomes = new Map();
  const perFixture = {};

  for (const fixture of FIXTURES) {
    const dir = join(ARTEFACT_ROOT, fixture.name);
    out();
    out(`scoring ${fixture.name} in the sealed --network=none container…`);
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`no artefact directory at ${dir}`);
      }
      const runId = `cal4b-${fixture.name}`;
      const startedAt = new Date().toISOString();
      const logPath = join(runDir, `${runId}.log`);
      const ledgerPath = join(runDir, `${runId}.jsonl`);
      writeFileSync(logPath, "", "utf8");
      writeFileSync(ledgerPath, "", "utf8");

      const run = {
        schemaVersion: BAKEOFF_SCHEMA_VERSION,
        runId,
        ticketId: ticket.id,
        ticketSha256: ticket.sha256,
        configId: config.id,
        repeatIndex: 0,
        startedAt,
        endedAt: startedAt,
        wallClockMs: 0,
        status: "completed",
        killReason: null,
        // RECORDED, NEVER SCORING. True so a failing fixture also surfaces as a
        // false finish, the metric that would otherwise hide a harness bug
        // behind "the model shipped a broken app".
        agentDeclaredDone: true,
        selfReportPath: null,
        usage: [],
        totalCostUsd: 0,
        pricingBasis: [],
        seats: config.seats,
        heldConstants: heldConstantsFor({
          config,
          harness: { id: "dashboard-calibration-4b", version: "0.1.0", commit: "unversioned" },
          // STAND-IN, named as one: 4B builds nothing, so there is no builder
          // sandbox. The scorer image's own id fills a slot wanting a content
          // digest that nothing in this path reads.
          sandbox: { imageRef: SCORER_IMAGE, imageDigest: imageId, networkPolicy: SEALED_NETWORK_POLICY },
          repeatCount: 1,
          acceptanceSuiteSha256: authored.suite.sha256,
        }),
        budget: DEFAULT_BUDGET,
        artifactPath: dir,
        logPath,
        ledgerPath,
        harnessErrors: [],
      };

      const record = await gate.score(run, authored.suite);
      const criteriaResults = record.criteriaResults;
      const qualityFindings = qualityFindingsFor(dir);

      const input = {
        ticket: fixture.ticket,
        criteriaResults,
        qualityFindings,
        assumptions: extractAssumptions(
          fixture.ticket,
          criteriaResults.map((r) => ({
            id: r.criterionId,
            tier: r.tier,
            statement: statementFor.get(r.criterionId) ?? r.criterionId,
            evidenceRequired: "",
          })),
        ),
        // ZERO ON PURPOSE, NOT UNMEASURED — `criteriaResults` already carries one
        // entry per held-out criterion, so counting the failures again here would
        // double every summary line in the verdict.
        heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
      };

      const failed = criteriaResults.filter((r) => r.passed !== true);
      const outcome = {
        actual: computeOutcome(input),
        failingTier: failingTier(input),
        failedGates: failed.filter((r) => r.criterionId.startsWith("GATE:")).map((r) => r.criterionId),
        failedCriteria: failed.filter((r) => /^REQ-\d{3}$/.test(r.criterionId)).map((r) => r.criterionId),
        qualityFindingIds: qualityFindings.map((f) => String(f).split(":")[0].trim()),
        error: null,
      };
      outcomes.set(fixture.name, outcome);
      perFixture[fixture.name] = {
        ...outcome,
        // Committed record: ids, tiers and counts only. `detail` is written by
        // the container and can carry a held-out test title.
        criteriaTotal: criteriaResults.length,
        criteriaFailed: failed.length,
        failedQualityRollups: failed.filter((r) => r.criterionId.startsWith("QUALITY:")).map((r) => r.criterionId),
        heldOutPass: record.heldOutPass,
        falseFinish: record.falseFinish,
        suiteSha256: record.acceptanceSuiteSha256,
      };

      // The rendered verdict goes to the gitignored run root ONLY: it quotes
      // criterion statements the container filled in, and `verdict.ts` never
      // renders `detail`, but the rendered page is not a committed artefact.
      writeFileSync(join(runDir, `${runId}.verdict.md`), renderVerdict(input), "utf8");
      out(`  ${fixture.name}: ${outcome.actual} (tier ${String(outcome.failingTier ?? "—")})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.set(fixture.name, {
        actual: "error",
        failingTier: null,
        failedGates: [],
        failedCriteria: [],
        qualityFindingIds: [],
        error: message.slice(0, 400),
      });
      perFixture[fixture.name] = { error: message.slice(0, 400) };
      out(`  ${fixture.name}: ERROR — ${message.slice(0, 200)}`);
    }
  }

  const matrix = classify(FIXTURES, outcomes);
  const state = {
    auditPassed: true,
    auditNote: `${String(auditSummary.attempts)} attempt(s), ${String(auditSummary.blocking)} blocking finding(s)`,
    matrix,
  };
  state.gate = evaluateGate(state);

  const record = {
    probe: "calibration-4b-authoring",
    task: "Phase 2e Task 4B — authoring calibration: does the grader actually discriminate?",
    runStamp: RUN_STAMP,
    liveRunExecuted: true,
    selfTest: null,
    ticket: { id: ticket.id, sha256: ticket.sha256, brief },
    seat: {
      modelId,
      specRole: specSeat.role,
      judgeRole: judgeSeat.role,
      effort: specSeat.effort,
      // `subscription-caller.ts` documents the default 8 as "the smallest number
      // proved sufficient once", measured on a twelve-criterion suite. Recorded
      // so a run that hit the cap can be told from one that had headroom.
      maxTurns: (env["DASHBOARD_SEAT_MAX_TURNS"] ?? "").trim() || "8 (module default)",
    },
    scorerImage: { ref: SCORER_IMAGE, id: imageId },
    // Verbatim, so a run compiled over a tree a sibling had mid-save cannot look
    // clean. A diagnostic in a module this probe LOADS is fatal upstream of here.
    compileDiagnostics,
    authoring: {
      suiteSha256: authored.suite.sha256,
      criteriaCount: authored.suite.criteria.length,
      testFileCount: authored.suite.testFiles.length,
      attempts: authored.attempts.length,
      auditPassed: authored.suite.auditPassed,
      blockingFindings: auditSummary.blocking,
      // Criterion ids, tiers and STATEMENTS only. Statements are owner-facing by
      // design (`verdict.ts` renders them). Test sources and titles are not here.
      criteria: authored.suite.criteria.map((c) => ({ id: c.id, tier: c.tier, statement: c.statement })),
      findingKinds: authored.findings.map((f) => ({ criterionId: f.criterionId, kind: f.kind, mustRegenerate: f.mustRegenerate })),
      tokens: { spec: specCaller.tokens, judge: judgeCaller.tokens },
    },
    preRegisteredArtefactFacts: preRegistered,
    perFixture,
    matrix: {
      rows: matrix.rows,
      falsePasses: matrix.falsePasses.map((r) => r.name),
      falseFails: matrix.falseFails.map((r) => r.name),
      mismatches: matrix.mismatches.map((r) => r.name),
      correctCount: matrix.matches.length,
      total: matrix.rows.length,
      blankPageFailed: matrix.blankPageFailed,
      discrimination: matrix.discrimination,
    },
    gate: { ok: state.gate.ok, lines: state.gate.lines },
    runRoot: base,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const resultPath = join(RESULTS_DIR, "calibration-4b.json");
  writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  printReport(state);
  out();
  out(`  committed record: ${resultPath}`);
  out(`  full run state (gitignored, carries container detail): ${base}`);
  return state.gate.ok ? 0 : 1;
}

/* ---------------------------------------------------------------------------
 * Self-tests — this harness's own negative controls
 * ------------------------------------------------------------------------ */

/** Seven synthetic fixtures with the shape `fixtures.ts` produces. */
const SYNTHETIC_FIXTURES = [
  { name: "correct-portfolio", expected: "pass" },
  { name: "missing-section", expected: "fail" },
  { name: "broken-build", expected: "fail" },
  { name: "blank-page", expected: "fail" },
  { name: "stub-markers", expected: "fail" },
  { name: "reward-hacked", expected: "fail" },
  { name: "stock-motion-only", expected: "pass_with_notes" },
];

function syntheticOutcome(overrides = {}) {
  return {
    actual: "fail",
    failingTier: "BLOCKING",
    failedGates: ["GATE:suite-green"],
    failedCriteria: ["REQ-002"],
    qualityFindingIds: [],
    error: null,
    ...overrides,
  };
}

/** The green arm: everything as expected, with a real discriminator. */
function syntheticGreenOutcomes() {
  const m = new Map();
  m.set("correct-portfolio", syntheticOutcome({ actual: "pass", failingTier: null, failedGates: [], failedCriteria: [] }));
  m.set("missing-section", syntheticOutcome({ failedCriteria: ["REQ-004"] }));
  m.set("broken-build", syntheticOutcome({ failedGates: ["GATE:build"], failedCriteria: [] }));
  m.set("blank-page", syntheticOutcome({ failedCriteria: ["REQ-002", "REQ-003", "REQ-004"] }));
  m.set("stub-markers", syntheticOutcome({ failedCriteria: ["REQ-003"] }));
  m.set("reward-hacked", syntheticOutcome({ failedGates: ["GATE:no-reward-hack-exploits"], failedCriteria: [] }));
  m.set(
    "stock-motion-only",
    syntheticOutcome({
      actual: "pass_with_notes",
      failingTier: "QUALITY",
      failedGates: [],
      failedCriteria: [],
      qualityFindingIds: ["VIS-MOTION-AUTHORED"],
    }),
  );
  return m;
}

function runSelfTest(which) {
  out("╔══════════════════════════════════════════════════════════════════════════╗");
  out("║  SELF-TEST — NOT A REAL RUN. No model was called, no container started.  ║");
  out("║  Synthetic outcomes drive the SAME classify/evaluateGate/assertAudit-    ║");
  out("║  Passed the live path uses. `liveRunExecuted` is false by construction.  ║");
  out("╚══════════════════════════════════════════════════════════════════════════╝");
  out(`self-test: ${which}`);

  if (which === "audit-blocked") {
    // The suite that must never have artefacts scored against it.
    const authored = {
      suite: { auditPassed: false, criteria: [], sha256: "n/a" },
      findings: [
        { criterionId: "REQ-001", kind: "vacuous", mustRegenerate: true, detail: "asserts nothing about the page" },
      ],
      attempts: [{}, {}, {}],
    };
    let blocked = null;
    try {
      assertAuditPassed(authored);
    } catch (error) {
      blocked = error;
    }
    const ok = blocked instanceof AuditBlocked;
    out(ok ? `  REFUSED, as it must: ${blocked.message}` : "  NOT REFUSED — a suite that failed its audit would have been scored");
    // And the gate must be red on that state, with nothing scored.
    const state = {
      auditPassed: false,
      auditNote: "synthetic: the audit blocked",
      matrix: classify(SYNTHETIC_FIXTURES, new Map()),
    };
    state.gate = evaluateGate(state);
    printReport(state);
    writeSelfTestRecord(which, state, { refused: ok });
    const behaved = ok && !state.gate.ok;
    out();
    out(
      behaved
        ? "  SELF-TEST audit-blocked: the control behaved — the suite was REFUSED and the gate went RED. " +
          "Exiting 0 because the CONTROL passed, not because a calibration did."
        : "  SELF-TEST audit-blocked: THE CONTROL DID NOT BEHAVE — " +
          `refused=${String(ok)}, gate.ok=${String(state.gate.ok)}.`,
    );
    return behaved ? 0 : 1;
  }

  const outcomes = syntheticGreenOutcomes();
  let expectGreen = true;
  if (which === "false-pass") {
    // The killer fixture graded green. This MUST be listed first and MUST be red.
    outcomes.set(
      "blank-page",
      syntheticOutcome({ actual: "pass", failingTier: null, failedGates: [], failedCriteria: [] }),
    );
    expectGreen = false;
  } else if (which !== "green") {
    out(`  unknown self-test ${JSON.stringify(which)} — expected green | false-pass | audit-blocked`);
    return 2;
  }

  const state = {
    auditPassed: true,
    auditNote: "synthetic: 1 attempt, 0 blocking findings",
    matrix: classify(SYNTHETIC_FIXTURES, outcomes),
  };
  state.gate = evaluateGate(state);
  printReport(state);
  writeSelfTestRecord(which, state, {});

  const asExpected = state.gate.ok === expectGreen;
  out();
  out(
    asExpected
      ? `  SELF-TEST ${which}: the control behaved — the gate reported ok=${String(state.gate.ok)}, which is what ` +
        "this arm requires. Exiting 0 because the CONTROL passed, not because a calibration did."
      : `  SELF-TEST ${which}: THE GATE DID NOT BEHAVE — expected ok=${String(expectGreen)}, got ${String(state.gate.ok)}.`,
  );
  if (which === "false-pass" && state.matrix.falsePasses[0]?.name !== "blank-page") {
    out("  SELF-TEST false-pass: the false pass was not listed first.");
    return 1;
  }
  return asExpected ? 0 : 1;
}

/**
 * Self-test output goes to a SCRATCH path, never to `RESULTS_DIR`.
 *
 * A synthetic green must not be able to land in the committed record, and
 * `liveRunExecuted` is written `false` here with no code path that can change it.
 */
function writeSelfTestRecord(which, state, extra) {
  const dir = join(tmpdir(), "calibration-4b-selftest");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `selftest-${which}-${RUN_STAMP}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        probe: "calibration-4b-authoring",
        selfTest: which,
        liveRunExecuted: false,
        synthetic: true,
        matrix: state.matrix,
        gate: state.gate,
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  out(`  self-test record (scratch, never committed): ${path}`);
}

/* ---------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------ */

const USAGE = `calibration-authoring.mjs — Phase 2e Task 4B

  GRADER_CALIBRATION_LIVE=1 node probes/calibration-authoring.mjs
  node probes/calibration-authoring.mjs --self-test=green|false-pass|audit-blocked

Environment:
  GRADER_CALIBRATION_LIVE=1        required. Without it this prints NOT RUN and exits 2.
  DASHBOARD_SPEC_MODEL             pin the spec/judge model (default: the CLI's "default")
  DASHBOARD_SEAT_MAX_TURNS         raise the seat turn cap if authoring hits it
  BAKEOFF_SCORER_IMAGE             scorer image ref (default bakeoff-scorer:1)
  CALIBRATION_4B_RESULTS_DIR       write the committed record elsewhere
  CALIBRATION_4B_BUILD_DIR         private tsc output tree
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    out(USAGE);
    return 0;
  }

  const selfTest = argv.find((a) => a.startsWith("--self-test="));
  if (selfTest !== undefined) return runSelfTest(selfTest.slice("--self-test=".length));

  if (process.env["GRADER_CALIBRATION_LIVE"] !== "1") {
    out("NOT RUN");
    out();
    out("Phase 2e Task 4B authors an acceptance suite by calling a model, which spends the owner's");
    out("subscription quota, and then runs seven sealed scoring containers. It is opt-in:");
    out();
    out("  GRADER_CALIBRATION_LIVE=1 node probes/calibration-authoring.mjs");
    out();
    out("Exiting 2. A calibration that did not run is never reported as one that passed.");
    return 2;
  }

  out("PHASE 2e TASK 4B — AUTHORING CALIBRATION");
  out("Does the grader discriminate? The suite is authored from the ticket, with no fixture knowledge,");
  out("audited, and only then executed. Nobody decided in advance that blank-page should fail.");
  out(`run stamp: ${RUN_STAMP}`);
  out(`committed record dir: ${RESULTS_DIR}`);
  out();

  try {
    return await liveRun();
  } catch (error) {
    if (error instanceof NotRun) {
      out();
      out("NOT RUN");
      out(`  ${error.message}`);
      out("Exiting 2.");
      return 2;
    }
    if (error instanceof AuditBlocked) {
      out();
      out("═══ THE AUTHORED SUITE FAILED ITS AUDIT ═════════════════════════════════════");
      out(`  ${error.message}`);
      out();
      out("  contracts.ts:314-317: TDFlow's entire +26.3pp effect lives in bad-test detection; a suite");
      out("  that fails the audit must never have builds run against it. NOTHING WAS SCORED.");
      out();
      out("RESULT: RED");
      return 1;
    }
    out();
    out("═══ THE RUN ERRORED ═════════════════════════════════════════════════════════");
    out(`  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    out();
    out("RESULT: RED");
    return 1;
  }
}

process.exitCode = await main();
