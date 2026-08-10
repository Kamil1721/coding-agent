#!/usr/bin/env node
/**
 * quality-gating.e2e.mjs — PROOF BY EXECUTION that QUALITY reports and never
 * gates, and that scoping `GATE:suite-green` to say so did not disable it.
 *
 * THE DEFECT THIS MEASURES. `AUTHORING_SYSTEM_PROMPT` in spec-agent.ts tells the
 * spec seat "QUALITY … REPORTED, NEVER GATING", and `computeHeldOutPass` in
 * contracts.ts honours it by reading BLOCKING and FUNCTIONAL only. But
 * `GATE:suite-green` is itself a BLOCKING criterion, and it used to fail
 * whenever ANY frozen test failed — including a test bound only to a QUALITY
 * criterion. A QUALITY failure therefore reached the verdict at BLOCKING, the
 * owner's stated decision was silently overridden, and `pass_with_notes` was
 * unreachable through the authored path.
 *
 * WHAT SUITE-GREEN IS FOR, AND WHAT MUST SURVIVE. Criterion-level mapping is not
 * total: a frozen test that fails while carrying no criterion tag would gate
 * nothing at all, because `computeHeldOutPass` reads only `criteriaResults`. So
 * suite-green is the CATCH-ALL for untagged tests, and narrowing it to "a
 * failure bound solely to QUALITY criteria does not fail this gate" must not
 * turn it off. Three of the four cases below are that negative control.
 *
 * FOUR CASES, ONE ARTEFACT, ONE FAILING ASSERTION. Every case scores the SAME
 * static one-pager through the REAL sealed container with the SAME genuinely
 * red accessibility test (the page's only link carries no accessible name).
 * Only the tier of the criterion that test's TITLE names differs:
 *
 *   A  quality-only  [REQ-003] is QUALITY          -> suite-green PASSES, heldOutPass TRUE
 *   B  untagged      the title names no criterion  -> suite-green FAILS  (the catch-all)
 *   C  functional    [REQ-003] is FUNCTIONAL       -> suite-green FAILS
 *   D  mixed         [REQ-003] QUALITY + [REQ-004] FUNCTIONAL -> suite-green FAILS
 *
 * Holding the artefact, the manifest and the assertion constant is what makes B,
 * C and D controls rather than decoration: nothing but the tagging can explain a
 * difference in verdict, and a boot or screenshot failure cannot masquerade as
 * one — `GATE:boot` is asserted to PASS in every case.
 *
 * IT GOES RED. Run against a scorer image built BEFORE the fix, case A fails
 * (`GATE:suite-green` false, `heldOutPass` false) and this script exits 1.
 *
 * Usage:  node test/quality-gating.e2e.mjs [--root <dir>] [--scorer-image <ref>]
 * Exit:   0 every check passed, 1 a check failed, 2 the environment could not
 *         run it (no docker, image not built).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DIST = join(REPO, "dist");

if (!existsSync(join(DIST, "gate.js"))) {
  process.stderr.write("dist/ is not built. Run: npm run build\n");
  process.exit(2);
}

const { BAKEOFF_SCHEMA_VERSION } = await import(join(DIST, "contracts.js"));
const { DEFAULT_BUDGET, SEALED_NETWORK_POLICY, SPEC_SEAT, JUDGE_SEAT, getConfig, heldConstantsFor } = await import(
  join(DIST, "config.js")
);
const { acceptanceSuiteDigest, sha256Hex, ticketDigest } = await import(join(DIST, "hash.js"));
const { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } = await import(join(DIST, "spec-types.js"));
const { deterministicAudit } = await import(join(DIST, "spec-validate.js"));
const { freezeSuite, verifySuiteIntact } = await import(join(DIST, "spec-freeze.js"));
const { createGate } = await import(join(DIST, "gate.js"));

/* ---- options ----------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};
const ROOT = ((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)))(flag("root", join(REPO, ".quality-gating-e2e")));
const SCORER_IMAGE = flag("scorer-image", "bakeoff-scorer:1");
const SANDBOX_IMAGE = flag("builder-image", "node:22");

/* ---- the artefact: identical in all four cases -------------------------- */

const BRIEF =
  "Build a one-page site for a portrait photographer called Aperture Studio. It shows the studio " +
  "name, a one-line description of the work, and a way to get in touch by email.\n";

/**
 * The SAME artefact scorer-modes.e2e.mjs scores green, verbatim.
 *
 * Its one link carries no accessible name, which is what the accessibility test
 * below genuinely fails on. That is deliberate: a tautological failure
 * (`expect(1).toBe(2)`) would be caught by the bad-test audit's
 * `tautological` patterns, and a contrived one would leave the reader unable to
 * tell a real QUALITY finding from a rigged one.
 */
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aperture Studio</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header><h1 id="studio-name">Aperture Studio</h1></header>
    <main>
      <p id="tagline">Portrait photography made in daylight, printed by hand.</p>
      <p id="contact">Get in touch: <a href="mailto:hello@aperture.example">hello@aperture.example</a></p>
    </main>
  </body>
</html>
`;

const STYLES_CSS = `:root { color-scheme: light; }
body {
  margin: 0;
  padding: 3rem 1.5rem;
  font-family: "Helvetica Neue", Arial, sans-serif;
  max-width: 42rem;
}
h1 { font-size: 2.25rem; letter-spacing: -0.02em; }
#tagline { font-size: 1.125rem; }
`;

const writeArtifact = (dir) => {
  writeFileSync(join(dir, "index.html"), INDEX_HTML, "utf8");
  writeFileSync(join(dir, "styles.css"), STYLES_CSS, "utf8");
};

/** Static mode: start / port / healthPath all null (owner decision D2). */
const staticManifest = (ticketId) =>
  `${JSON.stringify(
    {
      manifestVersion: 1,
      ticketId,
      target: "web",
      execution: {
        install: null,
        build: null,
        typecheck: null,
        lint: null,
        start: null,
        port: null,
        healthPath: null,
        bootTimeoutMs: null,
        commandTimeoutMs: null,
      },
      sourceDirs: ["."],
      uiFlows: [{ id: "home", path: "/", description: "the one page", waitForSelector: "#studio-name" }],
      dataExpectations: [],
    },
    null,
    2,
  )}\n`;

const manifestFile = (source) => ({
  path: "suite.manifest.json",
  visibility: "holdout",
  runner: "node-test",
  description: "the scorer's execution manifest — a declaration, not a test",
  expectedTestIds: [],
  criterionIds: [],
  source,
});

/* ---- the suite: one failing assertion, four taggings -------------------- */

/**
 * Passes on this artefact. Present so the suite is not one red test alone.
 *
 * T-2 USED TO CARRY A PROSE BAR, AND THE HARNESS IT TESTS REJECTED IT. It read
 * `const rendered = (await page.locator("body").innerText()).trim();` followed by
 * a floor of 20 on that value. `proseLengthFloorFindings` (spec-validate.ts, rule
 * 1) is BLOCKING and fires at a threshold of `PROSE_LENGTH_FLOOR_MIN = 20` or
 * above, so `deterministicAudit` rejected this very fixture — and `gradeSuite`
 * refuses to run builds against a suite the audit rejected. The consequence was
 * not a soft warning: all four cases died at step 1, NO SCORER CONTAINER WAS EVER
 * STARTED, and the file reported 0/4 from 2026-07-29 to 2026-08-09 without anyone
 * seeing it, because `bakeoff`'s `npm test` globs `dist/*.test.js` and cannot
 * reach a `test/*.e2e.mjs` at all.
 *
 * THE REPLACEMENT IS WHAT THE RULE ASKS FOR, NOT A WAY ROUND IT. The rule's own
 * remedy is "assert the THING the ticket asked for … not that its copy is long
 * enough", and the brief names exactly three things: the studio name, a one-line
 * description of the work, and a way to get in touch by email. REQ-002 is
 * "serve the home document with a substantive body", so T-2 now asserts 200 plus
 * the presence of the description line and the contact route. Lowering the floor
 * under 20 to slip past the rule's minimum was available and was NOT done: it
 * would have left the fixture asserting the thing the harness exists to condemn,
 * while reporting green.
 *
 * IT STILL FAILS AN EMPTY SHELL, which is the whole of REQ-002. `blank-page` in
 * the calibration set — valid HTML, 200 on every route, an empty `<div id=root>`
 * — has no `<main> <p>` and no `mailto:` anchor, so both awaits below fail on it.
 * The old character floor is the one that could not tell that artefact from this
 * one without counting.
 */
const PASSING_TESTS = `test("[REQ-001] T-1 the studio name is rendered on the home page", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator("h1");
  await expect(heading).toHaveCount(1);
  await expect(heading).toContainText(/aperture studio/i);
});

test("[REQ-002] T-2 the home document is served with a body, not an empty shell", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.status()).toBe(200);
  await expect(page.locator("main p").first()).toBeVisible();
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(1);
});
`;

/**
 * THE RED TEST. Byte-identical in all four cases except its title.
 *
 * A real accessibility property, genuinely unmet: the page has exactly one
 * link, and it carries neither `aria-label` nor `title`, so a screen-reader
 * user hears the raw address. QUALITY content in the tier's own words —
 * "accessibility, responsive layout, error states, empty states".
 */
const redTestBody = `async ({ page }) => {
  await page.goto("/");
  const links = page.locator("a");
  const total = await links.count();
  expect(total).toBeGreaterThan(0);
  const named = await page.locator("a[aria-label], a[title]").count();
  expect(named).toBe(total);
}`;

const suiteSource = (redTitle) =>
  `import { test, expect } from "@playwright/test";

${PASSING_TESTS}
test(${JSON.stringify(redTitle)}, ${redTestBody});
`;

const VISIBLE_FILE = {
  path: "visible/name.spec.mjs",
  visibility: "visible",
  runner: "playwright",
  description: "visible twin: the page has a title",
  expectedTestIds: ["T-20"],
  criterionIds: ["REQ-001"],
  source: `import { test, expect } from "@playwright/test";

test("[REQ-001] T-20 the document has a non-empty title", async ({ page }) => {
  await page.goto("/");
  const title = await page.title();
  expect(title.trim().length).toBeGreaterThan(2);
});
`,
};

const REQ_001 = {
  id: "REQ-001",
  tier: "FUNCTIONAL",
  statement: "The site shall display the studio name on the home page.",
  evidenceRequired: "holdout test T-1 PASS: the rendered home page carries the studio name",
  holdoutTestIds: ["T-1"],
  visibleTestIds: ["T-20"],
  evidenceArtifacts: [],
};

const REQ_002 = {
  id: "REQ-002",
  tier: "BLOCKING",
  statement: "The system shall serve the home document with a substantive body.",
  evidenceRequired: "holdout test T-2 PASS: the home document answers 200 and is not blank",
  holdoutTestIds: ["T-2"],
  visibleTestIds: [],
  evidenceArtifacts: [],
};

/** The criterion the red test names. Its TIER is the only variable in this file. */
const a11yCriterion = (id, tier) => ({
  id,
  tier,
  statement: "The site shall give every link an accessible name.",
  evidenceRequired: `holdout test T-3 PASS: every anchor carries an aria-label or title`,
  holdoutTestIds: ["T-3"],
  visibleTestIds: [],
  evidenceArtifacts: [],
});

const holdoutFile = (criterionIds, redTitle) => ({
  path: "holdout/site.spec.mjs",
  visibility: "holdout",
  runner: "playwright",
  description: "the delivered page renders its content and names its links",
  expectedTestIds: ["T-1", "T-2", "T-3"],
  criterionIds,
  source: suiteSource(redTitle),
});

const draftFor = (ticket, { criteria, criterionIds, redTitle }) => ({
  ticketId: ticket.id,
  ticketSha256: ticket.sha256,
  criteria,
  files: [holdoutFile(criterionIds, redTitle), VISIBLE_FILE, manifestFile(staticManifest(ticket.id))],
});

/* ---- helpers (shape reproduced from test/scorer-modes.e2e.mjs) ---------- */

function localImageDigest(imageRef) {
  try {
    const raw = execFileSync("docker", ["image", "inspect", imageRef, "--format", "{{index .RepoDigests 0}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const at = raw.lastIndexOf("@");
    if (at === -1) return null;
    const digest = raw.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

function buildSuite(draft) {
  const criteria = criteriaFromDraft(draft);
  const testFiles = testFileRefsFromDraft(draft);
  const now = new Date().toISOString();
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    ticketId: draft.ticketId,
    ticketSha256: draft.ticketSha256,
    criteria,
    testFiles,
    sha256: acceptanceSuiteDigest({
      ticketId: draft.ticketId,
      ticketSha256: draft.ticketSha256,
      criteria,
      testFiles,
    }),
    generatedBy: SPEC_SEAT,
    generatedByHarness: { id: "bakeoff-quality-gating-e2e", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("quality-gating e2e: hand-written draft, no model was called"),
    generatedAt: now,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: now,
  };
}

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  process.stdout.write(`  ${passed ? "PASS" : "FAIL"}  ${name}\n`);
  if (detail) process.stdout.write(`        ${detail}\n`);
};

/* ---- one end-to-end scoring run ---------------------------------------- */

async function scoreOne({ label, draft, ticket, sandboxDigest }) {
  process.stdout.write(`\n=== ${label} =======================================================\n`);

  const acceptanceRoot = join(ROOT, label, "acceptance");
  const artifactDir = join(ROOT, label, "workspace");
  const resultsDir = join(ROOT, label, "results");
  const runDir = join(ROOT, label, "run");
  for (const dir of [acceptanceRoot, artifactDir, resultsDir, runDir]) mkdirSync(dir, { recursive: true });

  const findings = deterministicAudit(draft);
  const blocking = findings.filter((f) => f.mustRegenerate);
  check(
    `${label}: the real bad-test audit clears the draft`,
    blocking.length === 0,
    blocking.length === 0 ? `${findings.length} finding(s), none blocking` : blocking.map((f) => f.detail).join(" | "),
  );
  if (blocking.length > 0) return null;

  const suite = buildSuite(draft);
  freezeSuite(
    { suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [...findings] },
    { acceptanceRoot },
  );
  const intact = verifySuiteIntact(ticket.id, { acceptanceRoot });
  check(`${label}: the frozen suite verifies intact`, intact.intact === true, `digest ${suite.sha256.slice(0, 16)}…`);
  if (!intact.intact) return null;

  writeArtifact(artifactDir);

  const config = getConfig("A");
  const harness = { id: "bakeoff-quality-gating-e2e", version: "0.1.0", commit: "unversioned" };
  const sandbox = { imageRef: SANDBOX_IMAGE, imageDigest: sandboxDigest, networkPolicy: SEALED_NETWORK_POLICY };
  const startedAt = new Date().toISOString();
  const run = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: `e2e-${label}`,
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    configId: config.id,
    repeatIndex: 0,
    startedAt,
    endedAt: startedAt,
    wallClockMs: 0,
    status: "completed",
    killReason: null,
    // Recorded, never scoring. True so that a wrong verdict ALSO shows up as a
    // false finish, which is the metric an owner would act on.
    agentDeclaredDone: true,
    selfReportPath: null,
    usage: [],
    totalCostUsd: 0,
    pricingBasis: [],
    seats: config.seats,
    heldConstants: heldConstantsFor({
      config,
      harness,
      sandbox,
      repeatCount: 1,
      acceptanceSuiteSha256: suite.sha256,
    }),
    budget: DEFAULT_BUDGET,
    artifactPath: artifactDir,
    logPath: join(runDir, "run.log"),
    ledgerPath: join(runDir, "run.jsonl"),
    harnessErrors: [],
  };
  writeFileSync(run.logPath, "", "utf8");
  writeFileSync(run.ledgerPath, "", "utf8");

  const gate = await createGate({
    ...process.env,
    BAKEOFF_SCORER_IMAGE: SCORER_IMAGE,
    BAKEOFF_RESULTS_DIR: resultsDir,
    BAKEOFF_ACCEPTANCE_ROOT: acceptanceRoot,
  });
  process.stdout.write(`        scoring in the sealed --network=none container… (${gate.scorerImageDigest})\n`);
  const record = await gate.score(run, suite);

  const criterion = (id) => record.criteriaResults.find((c) => c.criterionId === id);
  const suiteGreen = criterion("GATE:suite-green");
  const boot = criterion("GATE:boot");

  // THE CASE-INDEPENDENT FLOOR. If boot ever fails here the artefact stopped
  // being the constant, and every verdict below would be about the boot probe
  // rather than about tagging — while still looking like a result.
  check(`${label}: GATE:boot passed (the artefact is the constant)`, boot?.passed === true, boot?.detail ?? "");
  check(
    `${label}: the red accessibility test really did fail`,
    record.suiteExecution.testsFailed === 1,
    `${record.suiteExecution.testsPassed}/${record.suiteExecution.testsTotal} passed, ` +
      `${record.suiteExecution.testsFailed} failed, runner exit ${record.suiteExecution.exitCode}`,
  );

  // THE GATE'S OWN WORDS. `gateToCriterion` on the host drops `detail` for every
  // gate that PASSED, so a passing gate's reasoning survives only in the
  // container record the host persists beside the score. That is where an
  // excusal has to be read from, and reading it anywhere else would report
  // "no detail" for a gate that in fact explained itself.
  const containerPath = join(resultsDir, "scores", `${run.runId}.container.json`);
  const containerGate =
    JSON.parse(readFileSync(containerPath, "utf8")).container?.tier0?.find((g) => g.id === "GATE:suite-green") ?? null;

  process.stdout.write(`  score record: ${join(resultsDir, "scores", `${run.runId}.json`)}\n`);
  return { record, suiteGreen, criterion, containerGate };
}

/* ---- driver ------------------------------------------------------------ */

const sandboxDigest = localImageDigest(SANDBOX_IMAGE);
if (sandboxDigest === null) {
  process.stderr.write(
    `the sandbox stand-in image ${SANDBOX_IMAGE} is not present locally with a content digest.\n` +
      `Run: docker pull ${SANDBOX_IMAGE}\n`,
  );
  process.exit(2);
}
try {
  execFileSync("docker", ["image", "inspect", SCORER_IMAGE], { stdio: "ignore" });
} catch {
  process.stderr.write(
    `the scorer image ${SCORER_IMAGE} is not built. From bakeoff/:\n` +
      "  docker build --provenance=false --sbom=false -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .\n",
  );
  process.exit(2);
}

// `freezeSuite` chmods the sealed suite to 0444 — that read-only mode IS part of
// the seal — so a previous tree cannot simply be unlinked.
if (existsSync(ROOT)) {
  try {
    execFileSync("chmod", ["-R", "u+rwX", ROOT], { stdio: "ignore" });
  } catch {
    /* best effort; rmSync reports the real problem with the real path */
  }
  rmSync(ROOT, { recursive: true, force: true });
}
mkdirSync(ROOT, { recursive: true });

process.stdout.write(
  "QUALITY-GATING PROOF — QUALITY reports, it never gates; suite-green still catches everything else\n" +
    `root: ${ROOT}\nscorer image: ${SCORER_IMAGE}\n`,
);

const ticketFor = (id) => ({ id, tier: "trivial", title: "static one-pager", brief: BRIEF, sha256: ticketDigest(BRIEF) });

/* ---- A. the change itself: a QUALITY-only failure does not gate --------- */

{
  const ticket = ticketFor("E2E-QG-QUALITY");
  const scored = await scoreOne({
    label: "A-quality-only",
    ticket,
    sandboxDigest,
    draft: draftFor(ticket, {
      criteria: [REQ_001, REQ_002, a11yCriterion("REQ-003", "QUALITY")],
      criterionIds: ["REQ-001", "REQ-002", "REQ-003"],
      redTitle: "[REQ-003] T-3 every link carries an accessible name",
    }),
  });
  if (scored !== null) {
    const { record, suiteGreen, criterion, containerGate } = scored;
    check(
      "A: GATE:suite-green PASSED with a QUALITY-only test failing",
      suiteGreen?.passed === true,
      containerGate?.detail ?? "(no detail)",
    );
    check(
      "A: the gate SAYS it excused a QUALITY-only failure, and names the test",
      typeof containerGate?.detail === "string" &&
        containerGate.detail.includes("SOLELY to QUALITY") &&
        containerGate.detail.includes("T-3 every link carries an accessible name"),
      containerGate?.detail ?? "(no detail — a silent excusal is not auditable)",
    );
    check(
      "A: the QUALITY criterion is still REPORTED as failed",
      criterion("REQ-003")?.tier === "QUALITY" && criterion("REQ-003")?.passed === false,
      criterion("REQ-003")?.detail ?? "(REQ-003 absent or passed — the finding was swallowed, not reported)",
    );
    check(
      "A: heldOutPass === true and falseFinish === false",
      record.heldOutPass === true && record.falseFinish === false,
      `heldOutPass=${record.heldOutPass}, falseFinish=${record.falseFinish}`,
    );
  }
}

/* ---- B. NEGATIVE CONTROL: an UNTAGGED failure still gates --------------- */

{
  const ticket = ticketFor("E2E-QG-UNTAGGED");
  const scored = await scoreOne({
    label: "B-untagged",
    ticket,
    sandboxDigest,
    draft: draftFor(ticket, {
      criteria: [REQ_001, REQ_002],
      criterionIds: ["REQ-001", "REQ-002"],
      // No criterion id in the title at all. This is the case suite-green
      // exists for: `computeHeldOutPass` reads only `criteriaResults`, and no
      // criterion is bound to this test, so nothing else can carry it.
      redTitle: "T-3 every link carries an accessible name",
    }),
  });
  if (scored !== null) {
    const { record, suiteGreen, criterion } = scored;
    check(
      "B: GATE:suite-green STILL FAILED on an untagged failing test",
      suiteGreen?.passed === false,
      suiteGreen?.detail ?? "(it passed — the catch-all was disabled, not scoped)",
    );
    check(
      "B: it failed for the right reason — the failure count, not some other gate",
      typeof suiteGreen?.detail === "string" && suiteGreen.detail.includes("1 failed of"),
      suiteGreen?.detail ?? "(no detail)",
    );
    check(
      "B: every authored criterion PASSED, so suite-green alone carried it",
      criterion("REQ-001")?.passed === true && criterion("REQ-002")?.passed === true,
      `REQ-001=${criterion("REQ-001")?.passed}, REQ-002=${criterion("REQ-002")?.passed}`,
    );
    check(
      "B: heldOutPass === false and falseFinish === true",
      record.heldOutPass === false && record.falseFinish === true,
      `heldOutPass=${record.heldOutPass}, falseFinish=${record.falseFinish}`,
    );
  }
}

/* ---- C. NEGATIVE CONTROL: a FUNCTIONAL failure still gates -------------- */

{
  const ticket = ticketFor("E2E-QG-FUNCTIONAL");
  const scored = await scoreOne({
    label: "C-functional",
    ticket,
    sandboxDigest,
    draft: draftFor(ticket, {
      criteria: [REQ_001, REQ_002, a11yCriterion("REQ-003", "FUNCTIONAL")],
      criterionIds: ["REQ-001", "REQ-002", "REQ-003"],
      redTitle: "[REQ-003] T-3 every link carries an accessible name",
    }),
  });
  if (scored !== null) {
    const { record, suiteGreen, criterion } = scored;
    check(
      "C: GATE:suite-green STILL FAILED on a FUNCTIONAL-tagged failing test",
      suiteGreen?.passed === false,
      suiteGreen?.detail ?? "(it passed — a FUNCTIONAL failure stopped gating)",
    );
    check(
      "C: it failed for the right reason — the failure count",
      typeof suiteGreen?.detail === "string" && suiteGreen.detail.includes("1 failed of"),
      suiteGreen?.detail ?? "(no detail)",
    );
    check(
      "C: the FUNCTIONAL criterion failed too",
      criterion("REQ-003")?.tier === "FUNCTIONAL" && criterion("REQ-003")?.passed === false,
      criterion("REQ-003")?.detail ?? "(REQ-003 absent or passed)",
    );
    check(
      "C: heldOutPass === false and falseFinish === true",
      record.heldOutPass === false && record.falseFinish === true,
      `heldOutPass=${record.heldOutPass}, falseFinish=${record.falseFinish}`,
    );
  }
}

/* ---- D. NEGATIVE CONTROL: QUALITY *and* FUNCTIONAL still gates ---------- */

{
  const ticket = ticketFor("E2E-QG-MIXED");
  const mixed = {
    ...a11yCriterion("REQ-004", "FUNCTIONAL"),
    statement: "The site shall reach the contact address through a named link.",
    evidenceRequired: "holdout test T-3 PASS: the contact link is reachable and named",
  };
  const scored = await scoreOne({
    label: "D-mixed",
    ticket,
    sandboxDigest,
    draft: draftFor(ticket, {
      criteria: [REQ_001, REQ_002, a11yCriterion("REQ-003", "QUALITY"), mixed],
      criterionIds: ["REQ-001", "REQ-002", "REQ-003", "REQ-004"],
      // ONE test, TWO criteria, one of them FUNCTIONAL. "Bound solely to
      // QUALITY" must mean solely.
      redTitle: "[REQ-003] [REQ-004] T-3 every link carries an accessible name",
    }),
  });
  if (scored !== null) {
    const { record, suiteGreen, criterion } = scored;
    check(
      "D: GATE:suite-green STILL FAILED on a QUALITY+FUNCTIONAL test",
      suiteGreen?.passed === false,
      suiteGreen?.detail ?? "(it passed — 'solely QUALITY' was read as 'any QUALITY')",
    );
    check(
      "D: both criteria are reported, and the FUNCTIONAL one failed",
      criterion("REQ-003")?.passed === false && criterion("REQ-004")?.passed === false,
      `REQ-003(QUALITY)=${criterion("REQ-003")?.passed}, REQ-004(FUNCTIONAL)=${criterion("REQ-004")?.passed}`,
    );
    check(
      "D: heldOutPass === false and falseFinish === true",
      record.heldOutPass === false && record.falseFinish === true,
      `heldOutPass=${record.heldOutPass}, falseFinish=${record.falseFinish}`,
    );
  }
}

/* ---- verdict ------------------------------------------------------------ */

const failed = results.filter((r) => !r.passed);
process.stdout.write(
  `\n===============================================================================\n` +
    `${results.length - failed.length}/${results.length} check(s) passed\n`,
);
if (failed.length > 0) {
  for (const f of failed) process.stdout.write(`FAILED: ${f.name}\n        ${f.detail}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
