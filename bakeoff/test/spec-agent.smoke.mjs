/**
 * Offline regression suite for the spec-agent module.
 *
 *   npm run build && node test/spec-agent.smoke.mjs
 *
 * Covers every path that does not require a vendor API key: draft parsing, all
 * 28 deterministic bad-test checks, the freeze, four distinct tamper modes
 * against verifySuiteIntact, the visible/held-out gap, the pre-call spend
 * ceiling, per-vendor usage normalisation, and the credential guards.
 *
 * Plain .mjs on purpose. It imports the BUILT module from dist/ rather than the
 * source, so it exercises what actually ships, and it runs the same `node`
 * that spec-validate.ts shells out to for its `node --check` syntax gate.
 */
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const D = new URL("../dist/", import.meta.url).href.replace(/\/$/, "");
const T = await import(`${D}/spec-types.js`);
const V = await import(`${D}/spec-validate.js`);
const F = await import(`${D}/spec-freeze.js`);
const A = await import(`${D}/spec-agent.js`);
const S = await import(`${D}/anthropic-seat.js`);
const C = await import(`${D}/contracts.js`);
const H = await import(`${D}/hash.js`);
const CFG = await import(`${D}/config.js`);

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; } else { fails.push(`${name}${extra ? ` :: ${extra}` : ""}`); }
}
function throws(name, fn, needle) {
  try { fn(); fails.push(`${name} :: expected a throw`); }
  catch (e) {
    const s = `${e.code ?? ""} ${e.message ?? e} ${e.remediation ?? ""}`;
    if (s.includes(needle)) pass += 1;
    else fails.push(`${name} :: wrong error: ${s.slice(0, 220)}`);
  }
}

/* ---------------- fixtures ---------------- */

const brief = "Build a tee-time booking page. A visitor picks a date and a time and submits; the booking is stored and appears on the confirmation page.";
const ticket = { id: "T5", tier: "hard", title: "golf booking", brief, sha256: H.ticketDigest(brief) };

const holdoutSrc = `import { test } from "node:test";
import assert from "node:assert/strict";
const BASE = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
test("[REQ-002] T-1 booking a tee time persists a row", async () => {
  const res = await fetch(\`\${BASE}/bookings\`, { method: "POST", body: JSON.stringify({ date: "2026-09-14", time: "07:40" }) });
  assert.equal(res.status, 201);
  const rows = await (await fetch(\`\${BASE}/bookings\`)).json();
  assert.ok(rows.some((r) => r.time === "07:40"), "the 07:40 booking is absent");
});
test("[REQ-001] T-2 the confirmation page shows the stored time", async () => {
  const page = await (await fetch(\`\${BASE}/confirmation\`)).text();
  assert.match(page, /07:40/);
});
`;

const visibleSrc = `import { test } from "node:test";
import assert from "node:assert/strict";
const BASE = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
test("[REQ-002] T-20 booking a tee time persists a row", async () => {
  const res = await fetch(\`\${BASE}/bookings\`, { method: "POST", body: JSON.stringify({ date: "2026-11-02", time: "15:05" }) });
  assert.equal(res.status, 201);
  const rows = await (await fetch(\`\${BASE}/bookings\`)).json();
  assert.ok(rows.some((r) => r.time === "15:05"), "the 15:05 booking is absent");
});
`;

const uiSrc = `import { test, expect } from "@playwright/test";
test("[REQ-003] T-3 the booking form submits and renders a confirmation", async ({ page }) => {
  await page.goto(process.env.APP_BASE_URL ?? "http://127.0.0.1:3000");
  await page.fill("#time", "07:40");
  await page.click("#book");
  await expect(page.locator("#confirmation")).toContainText("07:40");
});
`;

function baseDraft() {
  return {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [
      { id: "REQ-001", tier: "BLOCKING", statement: "The application shall boot and answer GET /health with a non-5xx status.",
        evidenceRequired: "holdout test T-2 PASS", holdoutTestIds: ["T-2"], visibleTestIds: [], evidenceArtifacts: [] },
      { id: "REQ-002", tier: "FUNCTIONAL", statement: "When a visitor submits a tee time, the system shall persist a booking row for that time.",
        evidenceRequired: "holdout test T-1 PASS AND a bookings row exists for the submitted time",
        holdoutTestIds: ["T-1"], visibleTestIds: ["T-20"], evidenceArtifacts: ["db-query-7 count >= 1"] },
      { id: "REQ-003", tier: "QUALITY", statement: "When the booking form is submitted with no time, the system shall render an inline error message.",
        evidenceRequired: "holdout test T-3 PASS", holdoutTestIds: ["T-3"], visibleTestIds: [], evidenceArtifacts: [] },
    ],
    files: [
      { path: "holdout/booking.test.mjs", visibility: "holdout", runner: "node-test", description: "persistence",
        expectedTestIds: ["T-1", "T-2"], criterionIds: ["REQ-001", "REQ-002"], source: holdoutSrc },
      { path: "holdout/form.spec.mjs", visibility: "holdout", runner: "playwright", description: "ui flow",
        expectedTestIds: ["T-3"], criterionIds: ["REQ-003"], source: uiSrc },
      { path: "visible/booking.test.mjs", visibility: "visible", runner: "node-test", description: "visible twin",
        expectedTestIds: ["T-20"], criterionIds: ["REQ-002"], source: visibleSrc },
    ],
  };
}

const clone = (d) => JSON.parse(JSON.stringify(d));
const blockers = (fs) => fs.filter((f) => f.mustRegenerate);

/* ---------------- 1. clean draft ---------------- */

const clean = V.deterministicAudit(baseDraft());
ok("clean draft has no blocking findings", blockers(clean).length === 0,
   JSON.stringify(blockers(clean).map((f) => f.detail).slice(0, 3)));

/* ---------------- 2. each defect class is caught ---------------- */

function expectBlocking(name, mutate, needle) {
  const d = clone(baseDraft());
  mutate(d);
  const f = blockers(V.deterministicAudit(d));
  ok(name, f.some((x) => x.detail.includes(needle)), JSON.stringify(f.map((x) => x.detail).slice(0, 2)).slice(0, 300));
}

expectBlocking("skipped test blocked", (d) => { d.files[0].source += '\ntest.skip("T-9 later", () => {});\n'; }, "skipped or todo");
expectBlocking("only-focus blocked", (d) => { d.files[0].source += '\ntest.only("T-9 x", () => { assert.ok(1); });\n'; }, ".only()");
expectBlocking("assert(true) blocked", (d) => { d.files[0].source += "\nassert.ok(true);\n"; }, "cannot fail");
expectBlocking("literal self-equality blocked", (d) => { d.files[0].source += "\nassert.strictEqual(1, 1);\n"; }, "literal equals itself");
expectBlocking("process.exit blocked", (d) => { d.files[0].source += "\nprocess.exit(0);\n"; }, "sys.exit(0)");
expectBlocking("TODO marker blocked", (d) => { d.files[0].source += "\n// TODO tighten\n"; }, "TODO/FIXME/XXX");
expectBlocking("external network blocked", (d) => { d.files[0].source += '\nawait fetch("https://api.example.com/x");\n'; }, "non-loopback");
expectBlocking("visible referencing holdout blocked", (d) => { d.files[2].source += '\n// see holdout/booking.test.mjs\n'; }, "holdout/");
expectBlocking("credential-shaped fixture blocked", (d) => { d.files[0].source += '\nconst key = "' + ["sk", "ant", "api03", "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"].join("-") + '";\n'; }, "credential-shaped");
expectBlocking("a hardcoded JWT fixture is blocked", (d) => { d.files[0].source += '\nconst t = "' + ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".") + '";\n'; }, "credential-shaped");
{
  // Reading a secret from the environment BY NAME is the correct pattern and
  // must not cost an authoring cycle, even though it matches SECRET_ASSIGNMENT.
  const d = clone(baseDraft());
  d.files[0].source += '\nconst apiKey = process.env.PARTNER_API_KEY;\nconst tok = process.env["SESSION_TOKEN"];\n';
  const f = V.deterministicAudit(d);
  ok("reading a credential from process.env by NAME is not flagged",
     !f.some((x) => x.detail.includes("credential-shaped")),
     JSON.stringify(f.filter((x) => x.detail.includes("credential-shaped")).map((x) => x.detail)).slice(0, 200));
}
expectBlocking("declared id absent from source blocked", (d) => { d.files[0].expectedTestIds.push("T-77"); }, "does not appear");
expectBlocking("duplicate test id blocked", (d) => { d.files[1].expectedTestIds = ["T-1"]; d.files[1].source = d.files[1].source.replace("T-3", "T-1"); }, "declared by both");
expectBlocking("non-EARS statement blocked", (d) => { d.criteria[1].statement = "Booking works properly."; }, "EARS");
expectBlocking("scale language blocked", (d) => { d.criteria[1].statement = "The system shall render a page rated on a scale of quality."; }, "BINARY only");
expectBlocking("criterion with no holdout evidence blocked", (d) => { d.criteria[1].holdoutTestIds = []; }, "bound to no HELD-OUT test");
expectBlocking("evidence prose not naming its test blocked", (d) => { d.criteria[1].evidenceRequired = "it works"; }, "does not name any of its held-out test ids");
expectBlocking("bad REQ-ID blocked", (d) => { d.criteria[1].id = "REQ2"; d.files[0].criterionIds = ["REQ-001", "REQ2"]; }, "not of the form REQ-001");
// MEASURED, not theorised: a real authored suite whose titles carried only
// T-ids scored 0 of 12 criteria with 24 of 24 tests green, because the scorer
// attributes a criterion by finding its REQ-id in the test's TITLE path.
expectBlocking("a title carrying no REQ-id is blocked (it would score UNASSERTED)",
  (d) => { d.files[0].source = d.files[0].source.replace(/\[REQ-00\d\] /g, ""); },
  "no test or describe TITLE in it carries that id");
// A describe() wrapper is a title path too, and must satisfy the same rule.
{
  const d = baseDraft();
  d.files[0].source = d.files[0].source.replace(/\[REQ-00\d\] /g, "");
  d.files[0].source = `import { describe } from "node:test";\ndescribe("[REQ-001][REQ-002] booking", () => {});\n` + d.files[0].source;
  const f = V.deterministicAudit(d);
  ok("a describe() title satisfies criterion attribution",
     !f.some((x) => x.mustRegenerate && x.detail.includes("carries that id")),
     JSON.stringify(f.filter((x) => x.mustRegenerate).map((x) => x.detail)).slice(0, 300));
}
expectBlocking("bad path blocked", (d) => { d.files[0].path = "../escape.test.mjs"; }, '".."');
expectBlocking("runner/suffix mismatch blocked", (d) => { d.files[0].runner = "playwright"; }, "suffix implies");
expectBlocking("visibility/path mismatch blocked", (d) => { d.files[2].visibility = "holdout"; }, "path says");
expectBlocking("no visible half blocked", (d) => { d.files = d.files.slice(0, 2); d.criteria[1].visibleTestIds = []; }, "no visible test files");
expectBlocking("byte-identical twin blocked", (d) => { d.files[2].source = d.files[0].source; d.files[2].expectedTestIds = ["T-1"]; }, "byte-identical");
expectBlocking("syntax error blocked", (d) => { d.files[0].source += "\nconst = ;\n"; }, "does not parse as ESM");
expectBlocking("over-cap criteria blocked", (d) => {
  for (let i = 4; i <= 40; i += 1) {
    d.criteria.push({ id: `REQ-${String(i).padStart(3, "0")}`, tier: "QUALITY",
      statement: "The system shall do a thing.", evidenceRequired: "holdout test T-2 PASS",
      holdoutTestIds: ["T-2"], visibleTestIds: [], evidenceArtifacts: [] });
  }
}, "exceeds the cap");
expectBlocking("no BLOCKING tier blocked", (d) => { d.criteria[0].tier = "QUALITY"; }, "no BLOCKING-tier criterion");
expectBlocking("no FUNCTIONAL tier blocked", (d) => { d.criteria[1].tier = "QUALITY"; }, "no FUNCTIONAL-tier criterion");
expectBlocking("no paired criterion blocked", (d) => { d.criteria[1].visibleTestIds = []; d.files = d.files.slice(0, 2); }, "no criterion has BOTH");
expectBlocking("holdout id living in a visible file blocked", (d) => { d.criteria[1].holdoutTestIds = ["T-20"]; d.criteria[1].evidenceRequired = "holdout test T-20 PASS"; }, "lives in the VISIBLE file");

{
  const d = clone(baseDraft());
  d.criteria[1].statement = "When a visitor submits a tee time, the system should ideally persist a booking row and shall store it.";
  const f = V.deterministicAudit(d);
  ok("weak modal is advisory only", f.some((x) => !x.mustRegenerate && x.detail.includes("weak modal")));
}
{
  const d = clone(baseDraft());
  d.files[0].source += '\ntest("T-9 nothing", () => { const x = 1; });\n';
  d.files[0].expectedTestIds.push("T-9");
  const f = V.deterministicAudit(d);
  ok("assertion-free body is advisory only",
     f.some((x) => !x.mustRegenerate && x.detail.includes("no assertion")) &&
     !blockers(f).some((x) => x.detail.includes("no assertion")));
}

/* ---------------- 3. parsing ---------------- */

{
  const b = baseDraft();
  const raw = { criteria: b.criteria, testFiles: b.files.map((f) => ({
    path: f.path, visibility: f.visibility, runner: f.runner, description: f.description,
    testIds: f.expectedTestIds, criterionIds: f.criterionIds, source: f.source })) };
  const r = V.parseSuiteDraft(raw, ticket);
  ok("parseSuiteDraft accepts a well-formed response", r.ok === true, r.ok ? "" : JSON.stringify(r.problems));
  const bad = V.parseSuiteDraft({ criteria: [{ id: 1 }], testFiles: [] }, ticket);
  ok("parseSuiteDraft reports problems instead of throwing", bad.ok === false && bad.problems.length > 0);
}

ok("extractJsonObject survives braces inside strings",
   A.extractJsonObject('noise {"source":"function f(){ return {a:1}; }","x":1} trailing') ===
   '{"source":"function f(){ return {a:1}; }","x":1}');
ok("extractJsonObject strips code fences", JSON.parse(A.extractJsonObject('```json\n{"a":2}\n```')).a === 2);
ok("extractJsonObject returns null with no object", A.extractJsonObject("no json here") === null);

/* ---------------- 4. freeze + verify ---------------- */

const root = mkdtempSync(join(tmpdir(), "bakeoff-smoke-"));
const acceptanceRoot = join(root, "acceptance");

function unlock(dir) {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) unlock(p); else chmodSync(p, 0o644);
  }
}

function makeSuite(d, { auditPassed = true, findings = [] } = {}) {
  const criteria = T.criteriaFromDraft(d);
  const testFiles = T.testFileRefsFromDraft(d);
  return {
    schemaVersion: C.BAKEOFF_SCHEMA_VERSION,
    ticketId: d.ticketId,
    ticketSha256: d.ticketSha256,
    criteria, testFiles,
    sha256: H.acceptanceSuiteDigest({ ticketId: d.ticketId, ticketSha256: d.ticketSha256, criteria, testFiles }),
    generatedBy: CFG.SPEC_SEAT,
    generatedByHarness: { id: "bakeoff-spec-agent", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: H.sha256Hex("prompt"),
    generatedAt: "2026-07-27T12:00:00.000Z",
    auditPassed, auditFindings: findings,
    auditedBy: CFG.JUDGE_SEAT, auditedAt: "2026-07-27T12:05:00.000Z",
  };
}

const draft = baseDraft();
const plan = T.planFromDraft(draft);
const suite = makeSuite(draft);

throws("freezeSuite refuses an unaudited suite",
  () => F.freezeSuite({ suite: makeSuite(draft, { auditPassed: false }), plan, files: draft.files }, { acceptanceRoot }),
  "suite_not_audited");
throws("freezeSuite refuses a suite with a mustRegenerate finding",
  () => F.freezeSuite({ suite: makeSuite(draft, { findings: [{ criterionId: null, kind: "vacuous", detail: "x", mustRegenerate: true }] }), plan, files: draft.files }, { acceptanceRoot }),
  "suite_not_audited");

const trail = [{ attempt: 1, promptSha256: H.sha256Hex("p1"), parsed: true,
  problems: [], findings: [{ criterionId: "REQ-002", kind: "vacuous", detail: "T-1 asserted nothing", mustRegenerate: true }],
  judgeRan: true, accepted: false, costUsd: 2.5 },
  { attempt: 2, promptSha256: H.sha256Hex("prompt"), parsed: true, problems: [], findings: [], judgeRan: true, accepted: true, costUsd: 3.1 }];
const record = F.freezeSuite({ suite, plan, files: draft.files, auditFindings: [], authoringTrail: trail }, { acceptanceRoot });
ok("freeze wrote a manifest", existsSync(join(acceptanceRoot, "T5", "FROZEN.json")));
ok("freeze recorded the suite digest", record.suite.sha256 === suite.sha256);
ok("freeze attempted read-only", record.permissions.attempted === true);
ok("freeze made files read-only", record.permissions.filesReadOnly === true, record.permissions.problem ?? "");
const mode = statSync(join(acceptanceRoot, "T5", "suite", "holdout", "booking.test.mjs")).mode & 0o777;
ok("holdout file is 0444 on disk", mode === 0o444, `mode=${mode.toString(8)}`);

const v1 = F.verifySuiteIntact("T5", { acceptanceRoot });
ok("a freshly frozen suite verifies intact", v1.intact === true, JSON.stringify(v1.violations).slice(0, 400));
ok("verify reports the digest the scorer must record", v1.acceptanceSuiteSha256 === suite.sha256);

throws("re-freezing is refused by default",
  () => F.freezeSuite({ suite, plan, files: draft.files }, { acceptanceRoot }),
  "already exists");

const ws = join(root, "workspace");
const written = F.materialiseVisibleSubset("T5", ws, { acceptanceRoot });
ok("only the visible half is materialised", written.length === 1 && written[0].endsWith("booking.test.mjs"));
ok("materialised copy has no directory hint of a holdout sibling",
   readdirSync(join(ws, "tests")).join(",") === "booking.test.mjs");
ok("materialised copy is writable", (statSync(written[0]).mode & 0o200) !== 0);
throws("materialising inside the acceptance root is refused",
  () => F.materialiseVisibleSubset("T5", join(acceptanceRoot, "T5", "leak"), { acceptanceRoot }),
  "inside the acceptance root");

const holdoutFile = join(acceptanceRoot, "T5", "suite", "holdout", "booking.test.mjs");
chmodSync(join(acceptanceRoot, "T5", "suite"), 0o755);
chmodSync(join(acceptanceRoot, "T5", "suite", "holdout"), 0o755);
chmodSync(holdoutFile, 0o644);
const original = readFileSync(holdoutFile, "utf8");
writeFileSync(holdoutFile, `${original}\n// edited by a builder\n`, "utf8");
const v2 = F.verifySuiteIntact("T5", { acceptanceRoot });
ok("an edited frozen file is detected", v2.intact === false && v2.violations.some((x) => x.kind === "file_digest_mismatch"));
throws("assertSuiteIntact throws on a tampered suite", () => F.assertSuiteIntact("T5", { acceptanceRoot }), "suite_hash_mismatch");
writeFileSync(holdoutFile, original, "utf8");
ok("restoring the bytes restores intactness", F.verifySuiteIntact("T5", { acceptanceRoot }).intact === true);

const added = join(acceptanceRoot, "T5", "suite", "holdout", "conftest.mjs");
writeFileSync(added, "// monkey patch\n", "utf8");
const v3 = F.verifySuiteIntact("T5", { acceptanceRoot });
ok("an ADDED file inside the sealed suite is detected", v3.intact === false && v3.violations.some((x) => x.kind === "file_added"));
rmSync(added);

const manifestPath = join(acceptanceRoot, "T5", "FROZEN.json");
chmodSync(manifestPath, 0o644);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.plan.evidence[1].holdoutTestIds = ["T-2"];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
const v4 = F.verifySuiteIntact("T5", { acceptanceRoot });
ok("a re-bound criterion is detected even though no file changed",
   v4.intact === false && v4.violations.some((x) => x.kind === "plan_digest_mismatch"),
   JSON.stringify(v4.violations.map((x) => x.kind)));

const manifest2 = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest2.plan.evidence[1].holdoutTestIds = ["T-1"];
manifest2.suite.auditPassed = false;
writeFileSync(manifestPath, JSON.stringify(manifest2, null, 2), "utf8");
const v5 = F.verifySuiteIntact("T5", { acceptanceRoot });
ok("flipping auditPassed is caught by the record digest and the usability guard",
   v5.intact === false &&
   v5.violations.some((x) => x.kind === "record_digest_mismatch") &&
   v5.violations.some((x) => x.kind === "audit_not_passed"),
   JSON.stringify(v5.violations.map((x) => x.kind)));

ok("verify on a ticket with no suite reports missing_manifest",
   F.verifySuiteIntact("T9", { acceptanceRoot }).violations[0].kind === "missing_manifest");

/* ---------------- 5. the gap metric ---------------- */

const gapAllPass = T.computeVisibleHoldoutGap(plan, [
  { testId: "T-1", passed: true }, { testId: "T-20", passed: true },
]);
ok("gap is 0 when both halves pass", gapAllPass.pairedCriteria === 1 && gapAllPass.gapPercentagePoints === 0);

const gapOverfit = T.computeVisibleHoldoutGap(plan, [
  { testId: "T-1", passed: false }, { testId: "T-20", passed: true },
]);
ok("gap is +100pp when the visible half passes and the held-out half fails",
   gapOverfit.gapPercentagePoints === 100 && gapOverfit.visiblePassRate === 1 && gapOverfit.holdoutPassRate === 0);

const gapMissing = T.computeVisibleHoldoutGap(plan, [{ testId: "T-20", passed: true }]);
ok("a missing outcome refuses to produce a rate",
   gapMissing.gapPercentagePoints === null && gapMissing.unreportedTestIds.includes("T-1"));

ok("expectedTestIds covers both halves", T.expectedTestIds(plan).join(",") === "T-1,T-2,T-20,T-3");
ok("expectedTestIds filters by visibility", T.expectedTestIds(plan, "visible").join(",") === "T-20");

throws("a runner that collected nothing is an infrastructure error, not a failure",
  () => T.assertAllExpectedTestsReported(plan, []), "infrastructure error");
T.assertAllExpectedTestsReported(plan, T.expectedTestIds(plan).map((id) => ({ testId: id, passed: false })));
pass += 1;

/* ---------------- 6. digests ---------------- */

ok("plan digest is order-independent", T.holdoutPlanDigest(plan) ===
   T.holdoutPlanDigest({ ...plan, files: [...plan.files].reverse(), evidence: [...plan.evidence].reverse() }));
ok("plan digest changes when a binding changes", T.holdoutPlanDigest(plan) !==
   T.holdoutPlanDigest({ ...plan, evidence: plan.evidence.map((e) => e.criterionId === "REQ-002" ? { ...e, holdoutTestIds: ["T-2"] } : e) }));
ok("in-memory file digests equal on-disk digests",
   T.testFileRefsFromDraft(draft).every((r) =>
     H.fileDigest(join(acceptanceRoot, "T5", "suite"), r.path).sha256 === r.sha256));
ok("flipping a file's visibility changes the FROZEN suite digest", (() => {
  const flipped = { ...draft, files: draft.files.map((f) => f.path === "visible/booking.test.mjs"
    ? { ...f, path: "holdout/booking2.test.mjs", visibility: "holdout" } : f) };
  return makeSuite(flipped).sha256 !== suite.sha256;
})());

/* ---------------- 7. the spend ceiling ---------------- */

{
  const events = [];
  const policy = { maxCostUsd: 10, maxWallClockMs: 60000, maxCampaignCostUsd: 100, warnAtFraction: 0.8,
                   perVendorMaxOutputTokens: null, vendorAdvisoryBudgets: [] };
  let clock = 0;
  const ceiling = new S.SpendCeiling(policy, { nowMs: () => clock, startedAtMs: 0, onEvent: (e) => events.push(e) });

  const d1 = ceiling.checkBeforeCall(3, "call 1");
  ok("ceiling allows a call inside the budget", d1.allowed === true && d1.killReason === null);
  ceiling.record(3, "call 1");
  const d2 = ceiling.checkBeforeCall(9, "call 2");
  ok("ceiling refuses on the WORST case, not the expected case", d2.allowed === false && d2.killReason === "cost_ceiling_usd");
  throws("assertAllowed throws budget_exceeded", () => ceiling.assertAllowed(d2, "call 2"), "budget_exceeded");
  ceiling.record(5, "call 3");
  ok("warning fires at warnAtFraction", events.some((e) => e.kind === "budget_warning"));
  clock = 61000;
  const d3 = ceiling.checkBeforeCall(0.01, "call 4");
  ok("wall-clock boundary terminates", d3.allowed === false && d3.killReason === "wall_clock_ceiling");
  const legal = ["cost_ceiling_usd", "campaign_cost_ceiling_usd", "wall_clock_ceiling", "vendor_output_token_ceiling", "operator_abort", "infrastructure_failure", "credential_failure"];
  ok("every kill reason is a budget boundary — none is a progress judgement",
     events.filter((e) => e.kind === "kill_issued").every((e) => legal.includes(e.reason)));
}

ok("worst case prices input at the cache-MISS rate and output at full max_tokens", (() => {
  const usd = S.worstCaseCallCostUsd(CFG.SPEC_SEAT, 64000, 20000, "2026-07-27T00:00:00.000Z");
  return Math.abs(usd - (20000 / 1e6 * 5 + 64000 / 1e6 * 25)) < 1e-9;
})());
ok("token upper bound uses UTF-8 bytes, not characters",
   S.upperBoundInputTokens("\u{1F600}") === 4 && S.upperBoundInputTokens("abc") === 3);

{
  const norm = S.normalizeAnthropicUsage(
    { input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
      output_tokens_details: { thinking_tokens: 1500 }, server_tool_use: null, service_tier: "standard", inference_geo: null },
    CFG.SPEC_SEAT, "2026-07-27T00:00:00.000Z");
  const expected = 100 / 1e6 * 5 + 9000 / 1e6 * 0.5 + 2000 / 1e6 * 25 + 500 / 1e6 * 6.25;
  ok("usage costs at the per-field Opus 5 rates", Math.abs(norm.usage.costUsd - expected) < 1e-9);
  ok("thinking tokens are recorded", norm.usage.thinkingTokens === 1500);
  ok("cache-hit fraction uses read/(read+write+input)",
     Math.abs(C.vendorCacheHitFraction(norm.usage) - 9000 / 9600) < 1e-9);
  ok("pricing provenance rides on the row", norm.pricingBasis.source.includes("doc 03 table 2.1"));

  throws("an unreported cache field is never recorded as 0",
    () => S.normalizeAnthropicUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null,
      cache_creation_input_tokens: 0, cache_creation: null, output_tokens_details: null }, CFG.SPEC_SEAT, "2026-07-27T00:00:00.000Z"),
    "did not report usage.cache_read_input_tokens");

  const merged = S.mergeSeatUsage([norm.usage, norm.usage]);
  ok("merging within one seat sums counts and calls", merged.inputTokens === 200 && merged.callCount === 2);
  throws("merging across vendors is refused",
    () => S.mergeSeatUsage([norm.usage, { ...norm.usage, provider: "moonshot", modelId: "kimi-k3" }]),
    "never summed across vendors");
  const nullThinking = { ...norm.usage, thinkingTokens: null };
  ok("a nullable field stays null unless every row reported it",
     S.mergeSeatUsage([norm.usage, nullThinking]).thinkingTokens === null);
}

/* ---------------- 8. credentials ---------------- */

throws("a missing credential fails clean, with the variable NAME only",
  () => new S.AnthropicSeatCaller(CFG.SPEC_SEAT, { budget: T.AUTHORING_BUDGET, env: {} }),
  "missing_credential");
{
  let msg = "";
  try { new S.AnthropicSeatCaller(CFG.SPEC_SEAT, { budget: T.AUTHORING_BUDGET, env: { ANTHROPIC_API_KEY: "changeme" } }); }
  catch (e) { msg = `${e.message} ${e.remediation}`; }
  ok("a placeholder credential is rejected", msg.includes("placeholder"));
  ok("the failure names the variable and never a value", msg.includes("ANTHROPIC_API_KEY") && !msg.includes("changeme"));
}

/* ---------------- 9. seat-role and ticket guards ---------------- */

throws("the spec seat role is enforced", () => new A.SpecAgent({ specSeat: CFG.JUDGE_SEAT }), 'expected "spec"');
throws("the judge seat role is enforced", () => new A.SuiteAuditor({ judgeSeat: CFG.SPEC_SEAT }), 'expected "judge"');

await A.generateAuditedSuite({ ...ticket, brief: `${brief} edited` }, {})
  .then(() => fails.push("an edited ticket brief should be refused"),
        (e) => ok("an edited ticket brief is refused before any spend", `${e.code} ${e.message}`.includes("does not match its recorded sha256")));

ok("the authoring system prompt is a frozen constant with no ticket data",
   !A.AUTHORING_SYSTEM_PROMPT.includes("tee time") && !A.AUTHORING_SYSTEM_PROMPT.includes("2026-"));
ok("the audit system prompt is a frozen constant with no ticket data",
   !A.AUDIT_SYSTEM_PROMPT.includes("tee time") && !A.AUDIT_SYSTEM_PROMPT.includes("2026-"));
ok("the audit render shows the judge every source byte",
   A.renderSuiteForAudit(draft, ticket).includes(holdoutSrc.split("\n")[3]));

/* ---------------- 10. secrets never reach disk ---------------- */

{
  const all = [
    readFileSync(join(acceptanceRoot, "T5", "FROZEN.json"), "utf8"),
    readFileSync(join(acceptanceRoot, "T5", "AUDIT.json"), "utf8"),
  ].join("\n");
  const R = await import(`${D}/redact.js`);
  let threw = false;
  try { R.assertRedacted(all); } catch { threw = true; }
  ok("nothing credential-shaped reached the frozen artefacts", threw === false);
  ok("digests survived redaction of the audit report", all.includes(suite.sha256));

  const audit = JSON.parse(readFileSync(join(acceptanceRoot, "T5", "AUDIT.json"), "utf8"));
  ok("the discarded attempts are persisted, so a multi-attempt prompt digest is reconstructable",
     audit.authoringTrail.length === 2 &&
     audit.authoringTrail[0].accepted === false &&
     audit.authoringTrail[0].findings[0].detail.includes("asserted nothing") &&
     audit.authoringPromptSha256 === audit.authoringTrail[1].promptSha256);
}

/* ---------------- 11. token cap and campaign ceiling ---------------- */

ok("the default output cap is the streamable ceiling, not the xhigh floor",
   T.DEFAULT_MAX_OUTPUT_TOKENS === T.MAX_STREAMABLE_OUTPUT_TOKENS && T.DEFAULT_MAX_OUTPUT_TOKENS === 128000);
ok("the per-ticket ceiling clears the true worst case of 3 attempts x 2 calls", (() => {
  const perCall = S.worstCaseCallCostUsd(CFG.SPEC_SEAT, T.DEFAULT_MAX_OUTPUT_TOKENS, 30000, "2026-07-27T00:00:00.000Z");
  return perCall * 6 < T.AUTHORING_BUDGET.maxCostUsd;
})());
ok("the campaign ceiling covers six reference tickets",
   T.AUTHORING_BUDGET.maxCampaignCostUsd >= T.AUTHORING_BUDGET.maxCostUsd * 6);
ok("the scorer-image prerequisite for Playwright names pre-baked browsers",
   T.SCORER_IMAGE_REQUIREMENTS.playwright.includes("pre-baked"));

{
  // With no credential every ticket fails, but the campaign REPORTS rather
  // than throwing, and no value ever appears in the report.
  const report = await A.authorAndFreezeAllSuites([ticket, { ...ticket, id: "T6" }], { env: {}, acceptanceRoot });
  ok("a campaign with no credential reports instead of throwing", report.allSucceeded === false && report.results.length === 2);
  ok("each ticket's failure names the variable and its remediation",
     report.results.every((r) => r.failure.includes("ANTHROPIC_API_KEY") && r.failure.includes("fix:")));
  ok("a failing campaign spends nothing", report.totalCostUsd === 0);

  // ONE ceiling, not one per ticket: prior spend on the supplied ceiling is
  // still visible after the campaign, which is what makes maxCampaignCostUsd
  // able to fire at all.
  const shared = new S.SpendCeiling(T.AUTHORING_BUDGET);
  shared.record(7, "earlier ticket");
  const report2 = await A.authorAndFreezeAllSuites([ticket], { env: {}, acceptanceRoot, ceiling: shared });
  ok("the campaign reads one shared ceiling rather than a fresh per-ticket one",
     report2.totalCostUsd === 7 && shared.spentUsd === 7);
}

unlock(acceptanceRoot);
rmSync(root, { recursive: true, force: true });

console.log(`\npassed ${pass} assertions`);
if (fails.length > 0) {
  console.log(`\nFAILED ${fails.length}:`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("all green");
}
