#!/usr/bin/env node
/**
 * scorer-modes.e2e.mjs — PROOF BY EXECUTION for owner decision D2
 * (STATUS.md blocker 1.2): a correct STATIC artefact scores green through the
 * sealed gate, and the SERVER path still works.
 *
 * It is an end-to-end run of the real thing, not a unit test. For each of two
 * tickets it:
 *
 *   1. builds a draft suite and runs the REAL deterministic bad-test audit,
 *   2. freezes it (real digests, real 0444 suite files),
 *   3. writes a build artefact by hand — the "builder" here is this file,
 *   4. scores it through the REAL SealedScorerGate: `docker run --network=none`
 *      from an image resolved by content digest, with the frozen suite mounted
 *      read-only,
 *   5. asserts heldOutPass === true and falseFinish === false.
 *
 * THE STATIC TICKET SHIPS NO SERVER AT ALL — one index.html and one stylesheet.
 * Before D2 its manifest could not even be authored: `parseSuiteManifest`
 * required `execution.start`, `port` and `healthPath`, so a correct static site
 * failed a BLOCKING boot gate it never needed, which in the aggregate report is
 * indistinguishable from "the model shipped a broken app".
 *
 * BOTH FIXTURES USE PLAYWRIGHT (`*.spec.mjs`) ONLY. That is deliberate and it
 * is not a workaround for D2: `node --test` is STATUS.md blocker 1.1, a
 * separate decision (D1), and a node:test fixture here would go red for that
 * reason and say nothing about this one.
 *
 * Usage:  node test/scorer-modes.e2e.mjs [--root <dir>] [--scorer-image <ref>]
 * Exit:   0 every check passed, 1 a check failed, 2 the environment could not
 *         run it (no docker, image not built).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const { DEFAULT_BUDGET, SEALED_NETWORK_POLICY, SPEC_SEAT, JUDGE_SEAT, getConfig, heldConstantsFor } =
  await import(join(DIST, "config.js"));
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
const ROOT = ((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)))(
  flag("root", join(REPO, ".scorer-modes-e2e")),
);
const SCORER_IMAGE = flag("scorer-image", "bakeoff-scorer:1");
const SANDBOX_IMAGE = flag("builder-image", "node:22");

/* ---- fixtures ---------------------------------------------------------- */

const STATIC_BRIEF =
  "Build a one-page site for a portrait photographer called Aperture Studio. It shows the studio " +
  "name, a one-line description of the work, and a way to get in touch by email.\n";

const SERVER_BRIEF =
  "Build a page that greets a visitor by name from a query parameter, served by the application " +
  "itself, with a health endpoint the operator can poll.\n";

/** index.html + a stylesheet. No server, no package.json, no build step. */
const STATIC_INDEX_HTML = `<!doctype html>
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

const STATIC_STYLES_CSS = `:root { color-scheme: light; }
body {
  margin: 0;
  padding: 3rem 1.5rem;
  font-family: "Helvetica Neue", Arial, sans-serif;
  max-width: 42rem;
}
h1 { font-size: 2.25rem; letter-spacing: -0.02em; }
#tagline { font-size: 1.125rem; }
`;

const SERVER_MJS = `import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const name = (url.searchParams.get("name") ?? "visitor").replace(/[<>&]/g, "");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Greeting</title></head>' +
      '<body><h1 id="greeting">Hello, ' + name + '</h1></body></html>',
  );
}).listen(PORT, "0.0.0.0", () => {
  console.log("listening on " + PORT);
});
`;

const SERVER_PACKAGE_JSON = `${JSON.stringify(
  { name: "greeting-artifact", private: true, type: "module", version: "0.0.0" },
  null,
  2,
)}\n`;

/** The STATIC manifest: start / port / healthPath all null. This is D2. */
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
        // No server exists and none is demanded. The scorer serves the
        // artefact directory itself with the static server baked into its
        // image, and the boot gate asserts the root document is real.
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

/** The SERVER manifest: unchanged shape, to prove that path still works. */
const serverManifest = (ticketId) =>
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
        start: "node server.mjs",
        port: 3000,
        healthPath: "/health",
        bootTimeoutMs: 30_000,
        commandTimeoutMs: 60_000,
      },
      sourceDirs: ["."],
      uiFlows: [{ id: "home", path: "/", description: "the greeting", waitForSelector: "#greeting" }],
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

function staticDraft(ticket) {
  return {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [
      {
        id: "REQ-001",
        tier: "FUNCTIONAL",
        statement: "The site shall display the studio name on the home page.",
        evidenceRequired: "holdout test T-1 PASS: the rendered home page carries the studio name",
        holdoutTestIds: ["T-1"],
        visibleTestIds: ["T-20"],
        evidenceArtifacts: [],
      },
      {
        id: "REQ-002",
        tier: "FUNCTIONAL",
        statement: "The site shall provide an email address the reader can contact.",
        evidenceRequired: "holdout test T-2 PASS: a mailto link is present in the rendered page",
        holdoutTestIds: ["T-2"],
        visibleTestIds: [],
        evidenceArtifacts: [],
      },
      {
        id: "REQ-003",
        tier: "BLOCKING",
        statement: "The system shall serve the home document with a substantive body.",
        evidenceRequired: "holdout test T-3 PASS: the home document answers 200 and is not blank",
        holdoutTestIds: ["T-3"],
        visibleTestIds: [],
        evidenceArtifacts: [],
      },
    ],
    files: [
      {
        path: "holdout/site.spec.mjs",
        visibility: "holdout",
        runner: "playwright",
        description: "the delivered page renders its content",
        expectedTestIds: ["T-1", "T-2", "T-3"],
        criterionIds: ["REQ-001", "REQ-002", "REQ-003"],
        source: `import { test, expect } from "@playwright/test";

test("[REQ-001] T-1 the studio name is rendered on the home page", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator("h1");
  await expect(heading).toHaveCount(1);
  await expect(heading).toContainText(/aperture studio/i);
});

test("[REQ-002] T-2 a contactable email address is rendered", async ({ page }) => {
  await page.goto("/");
  const mailto = page.locator('a[href^="mailto:"]');
  await expect(mailto).toHaveCount(1);
  const href = await mailto.first().getAttribute("href");
  expect(href.slice("mailto:".length)).toMatch(/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/);
});

test("[REQ-003] T-3 the home document is served and is not blank", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.status()).toBe(200);
  const rendered = (await page.locator("body").innerText()).trim();
  expect(rendered.length).toBeGreaterThan(20);
});
`,
      },
      {
        path: "visible/name.spec.mjs",
        visibility: "visible",
        runner: "playwright",
        description: "visible twin: the page has a title and a heading",
        expectedTestIds: ["T-20"],
        criterionIds: ["REQ-001"],
        source: `import { test, expect } from "@playwright/test";

test("[REQ-001] T-20 the document has a non-empty title", async ({ page }) => {
  await page.goto("/");
  const title = await page.title();
  expect(title.trim().length).toBeGreaterThan(2);
});
`,
      },
      manifestFile(staticManifest(ticket.id)),
    ],
  };
}

function serverDraft(ticket) {
  return {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [
      {
        id: "REQ-001",
        tier: "FUNCTIONAL",
        statement: "When a name is supplied, the page shall greet the visitor by that name.",
        evidenceRequired: "holdout test T-1 PASS: the rendered page contains the supplied name",
        holdoutTestIds: ["T-1"],
        visibleTestIds: ["T-20"],
        evidenceArtifacts: [],
      },
      {
        id: "REQ-002",
        tier: "FUNCTIONAL",
        statement: "The application shall answer a health request with a machine-readable body.",
        evidenceRequired: "holdout test T-2 PASS: the health endpoint returns JSON",
        holdoutTestIds: ["T-2"],
        visibleTestIds: [],
        evidenceArtifacts: [],
      },
      {
        id: "REQ-003",
        tier: "BLOCKING",
        statement: "The system shall serve the home document with a substantive body.",
        evidenceRequired: "holdout test T-3 PASS: the home document answers 200 and is not blank",
        holdoutTestIds: ["T-3"],
        visibleTestIds: [],
        evidenceArtifacts: [],
      },
    ],
    files: [
      {
        path: "holdout/greeting.spec.mjs",
        visibility: "holdout",
        runner: "playwright",
        description: "the running application greets and reports health",
        expectedTestIds: ["T-1", "T-2", "T-3"],
        criterionIds: ["REQ-001", "REQ-002", "REQ-003"],
        source: `import { test, expect } from "@playwright/test";

test("[REQ-001] T-1 a supplied name is greeted by name", async ({ page }) => {
  await page.goto("/?name=Wren");
  await expect(page.locator("#greeting")).toContainText("Wren");
});

test("[REQ-002] T-2 the health endpoint answers with JSON", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toHaveProperty("ok");
});

test("[REQ-003] T-3 the home document is served and is not blank", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.status()).toBe(200);
  const rendered = (await page.locator("body").innerText()).trim();
  expect(rendered.length).toBeGreaterThan(3);
});
`,
      },
      {
        path: "visible/greeting.spec.mjs",
        visibility: "visible",
        runner: "playwright",
        description: "visible twin: a different name, checked a different way",
        expectedTestIds: ["T-20"],
        criterionIds: ["REQ-001"],
        source: `import { test, expect } from "@playwright/test";

test("[REQ-001] T-20 the heading is present for an unnamed visitor", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator("h1");
  await expect(heading).toHaveCount(1);
  expect((await heading.innerText()).trim().length).toBeGreaterThan(3);
});
`,
      },
      manifestFile(serverManifest(ticket.id)),
    ],
  };
}

/* ---- helpers ----------------------------------------------------------- */

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
    generatedByHarness: { id: "bakeoff-scorer-modes-e2e", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("scorer-modes e2e: hand-written draft, no model was called"),
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

async function scoreOne({ label, ticket, draft, writeArtifact, sandboxDigest, expected = "pass" }) {
  process.stdout.write(`\n=== ${label} =======================================================\n`);

  const acceptanceRoot = join(ROOT, label, "acceptance");
  const artifactDir = join(ROOT, label, "workspace");
  const resultsDir = join(ROOT, label, "results");
  const runDir = join(ROOT, label, "run");
  for (const dir of [acceptanceRoot, artifactDir, resultsDir, runDir]) mkdirSync(dir, { recursive: true });

  // 1. the real deterministic bad-test audit
  const findings = deterministicAudit(draft);
  const blocking = findings.filter((f) => f.mustRegenerate);
  check(
    `${label}: the real bad-test audit clears the draft`,
    blocking.length === 0,
    blocking.length === 0 ? `${findings.length} finding(s), none blocking` : blocking.map((f) => f.detail).join(" | "),
  );
  if (blocking.length > 0) return false;

  // 2. freeze
  const suite = buildSuite(draft);
  freezeSuite({ suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [...findings] }, { acceptanceRoot });
  const intact = verifySuiteIntact(ticket.id, { acceptanceRoot });
  check(`${label}: the frozen suite verifies intact`, intact.intact === true, `digest ${suite.sha256.slice(0, 16)}…`);
  if (!intact.intact) return false;

  // 3. the "builder": write the artefact by hand
  writeArtifact(artifactDir);

  // 4. a run record for it
  const config = getConfig("A");
  const harness = { id: "bakeoff-scorer-modes-e2e", version: "0.1.0", commit: "unversioned" };
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
    // Recorded, never scoring. Set true so that a failure would ALSO show up as
    // a false finish — the metric that would misreport a harness bug as a model
    // shipping a broken app.
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

  // 5. the REAL sealed gate
  const gate = await createGate({
    ...process.env,
    BAKEOFF_SCORER_IMAGE: SCORER_IMAGE,
    BAKEOFF_RESULTS_DIR: resultsDir,
    BAKEOFF_ACCEPTANCE_ROOT: acceptanceRoot,
  });
  check(
    `${label}: the gate resolved the scorer image by content digest`,
    /^sha256:[0-9a-f]{64}$/.test(gate.scorerImageDigest),
    gate.scorerImageDigest,
  );

  process.stdout.write("        scoring in the sealed --network=none container…\n");
  const record = await gate.score(run, suite);

  const boot = record.criteriaResults.find((c) => c.criterionId === "GATE:boot");
  const suiteGreen = record.criteriaResults.find((c) => c.criterionId === "GATE:suite-green");
  const shots = record.criteriaResults.find((c) => c.criterionId === "GATE:screenshots-present");

  // THE NEGATIVE CASE. A gate that cannot fail is not a gate: if a blank
  // document scored green, the static path would be a rubber stamp rather than
  // a health check, and every static ticket would "pass" whatever was shipped.
  if (expected === "fail-blank-root") {
    const failedForTheRightReason =
      boot?.passed === false && (boot.detail ?? "").includes("empty body");
    check(
      `${label}: GATE:boot FAILED on a blank root document, naming the reason`,
      failedForTheRightReason,
      boot?.detail ?? "(GATE:boot passed — a blank page was accepted)",
    );
    check(
      `${label}: heldOutPass === false and falseFinish === true`,
      record.heldOutPass === false && record.falseFinish === true,
      `heldOutPass=${record.heldOutPass}, falseFinish=${record.falseFinish} ` +
        "(the artefact declared itself done, so a blank page is a false finish)",
    );
    process.stdout.write(`\n  score record: ${join(resultsDir, "scores", `${run.runId}.json`)}\n`);
    return record.heldOutPass === false && record.falseFinish === true && failedForTheRightReason;
  }

  check(`${label}: GATE:boot passed`, boot?.passed === true, boot?.detail ?? "(no detail: it passed)");
  check(`${label}: GATE:suite-green passed`, suiteGreen?.passed === true, suiteGreen?.detail ?? "(no detail: it passed)");
  check(
    `${label}: GATE:screenshots-present passed`,
    shots?.passed === true,
    shots?.detail ?? "(no detail: it passed)",
  );
  for (const criterion of suite.criteria) {
    const result = record.criteriaResults.find((c) => c.criterionId === criterion.id);
    check(`${label}: ${criterion.id} (${criterion.tier}) passed`, result?.passed === true, result?.detail ?? "");
  }
  check(
    `${label}: heldOutPass === true and falseFinish === false`,
    record.heldOutPass === true && record.falseFinish === false,
    `heldOutPass=${record.heldOutPass}, falseFinish=${record.falseFinish}, ` +
      `suite ${record.suiteExecution.testsPassed}/${record.suiteExecution.testsTotal} passed`,
  );

  process.stdout.write(
    `\n  score record: ${join(resultsDir, "scores", `${run.runId}.json`)}\n` +
      `  criteria: ${record.criteriaResults.filter((c) => c.passed).length}/${record.criteriaResults.length} passed\n`,
  );
  return record.heldOutPass === true && record.falseFinish === false;
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
  "SCORER MODE PROOF — owner decision D2 (STATUS.md blocker 1.2)\n" +
    `root: ${ROOT}\nscorer image: ${SCORER_IMAGE}\n`,
);

/* ---- the manifest contract, checked before any container starts -------- */

process.stdout.write("\n=== manifest contract ==============================================\n");
{
  const { parseSuiteManifest, resolveExecutionPlan, STATIC_SERVE_PORT } = await import(
    join(DIST, "scorer-protocol.js")
  );

  const parsedStatic = parseSuiteManifest(JSON.parse(staticManifest("E2E-STATIC")));
  const planStatic = resolveExecutionPlan(parsedStatic.execution);
  check(
    "a manifest with start/port/healthPath null parses, and resolves to static mode",
    planStatic.mode === "static" &&
      planStatic.port === STATIC_SERVE_PORT &&
      planStatic.rootDocument === "/",
    `mode=${planStatic.mode} port=${planStatic.port} rootDocument=${planStatic.rootDocument}`,
  );

  const planServer = resolveExecutionPlan(parseSuiteManifest(JSON.parse(serverManifest("E2E-SERVER"))).execution);
  check(
    "a manifest with a start command still resolves to server mode",
    planServer.mode === "server" && planServer.port === 3000 && planServer.healthPath === "/health",
    `mode=${planServer.mode} port=${planServer.port} healthPath=${planServer.healthPath}`,
  );

  // A start command with nothing to probe is a boot gate that cannot decide
  // anything. Nullable must not mean "any combination".
  const halfDeclared = JSON.parse(serverManifest("E2E-SERVER"));
  halfDeclared.execution.port = null;
  let rejected = null;
  try {
    parseSuiteManifest(halfDeclared);
  } catch (error) {
    rejected = error;
  }
  check(
    "a start command with no port is REJECTED, naming the static alternative",
    rejected !== null && String(rejected.remediation ?? "").includes("execution.start to null"),
    rejected === null ? "it parsed — a half-declared server was accepted" : rejected.message,
  );

  // The same document, through the authoring-time validator.
  const badDraft = staticDraft({ id: "E2E-STATIC", sha256: ticketDigest(STATIC_BRIEF) });
  badDraft.files = badDraft.files.map((f) =>
    f.path === "suite.manifest.json" ? { ...f, source: '{"manifestVersion":1}' } : f,
  );
  const badFindings = deterministicAudit(badDraft).filter((f) => f.mustRegenerate);
  check(
    "the bad-test audit rejects a manifest the sealed scorer could not execute",
    badFindings.some((f) => f.detail.includes("not executable by the sealed scorer")),
    badFindings.map((f) => f.detail.slice(0, 120)).join(" | ") || "(no blocking finding)",
  );
}

const staticTicket = {
  id: "E2E-STATIC",
  tier: "trivial",
  title: "static one-pager",
  brief: STATIC_BRIEF,
  sha256: ticketDigest(STATIC_BRIEF),
};
const serverTicket = {
  id: "E2E-SERVER",
  tier: "trivial",
  title: "greeting server",
  brief: SERVER_BRIEF,
  sha256: ticketDigest(SERVER_BRIEF),
};

let ok = true;
ok =
  (await scoreOne({
    label: "static",
    ticket: staticTicket,
    draft: staticDraft(staticTicket),
    sandboxDigest,
    writeArtifact: (dir) => {
      writeFileSync(join(dir, "index.html"), STATIC_INDEX_HTML, "utf8");
      writeFileSync(join(dir, "styles.css"), STATIC_STYLES_CSS, "utf8");
    },
  })) && ok;

ok =
  (await scoreOne({
    label: "server",
    ticket: serverTicket,
    draft: serverDraft(serverTicket),
    sandboxDigest,
    writeArtifact: (dir) => {
      writeFileSync(join(dir, "server.mjs"), SERVER_MJS, "utf8");
      writeFileSync(join(dir, "package.json"), SERVER_PACKAGE_JSON, "utf8");
    },
  })) && ok;

// The negative control. Same ticket, same frozen suite, an index.html that is
// blank. It must FAIL, and it must fail on the boot gate.
ok =
  (await scoreOne({
    label: "static-blank",
    ticket: staticTicket,
    draft: staticDraft(staticTicket),
    sandboxDigest,
    expected: "fail-blank-root",
    writeArtifact: (dir) => {
      writeFileSync(join(dir, "index.html"), "   \n\n  \n", "utf8");
      writeFileSync(join(dir, "styles.css"), STATIC_STYLES_CSS, "utf8");
    },
  })) && ok;

const failed = results.filter((r) => !r.passed);
process.stdout.write(
  `\n===============================================================================\n` +
    `${results.length - failed.length}/${results.length} check(s) passed\n`,
);
if (failed.length > 0) {
  for (const f of failed) process.stdout.write(`FAILED: ${f.name}\n        ${f.detail}\n`);
}
process.exit(ok && failed.length === 0 ? 0 : 1);
