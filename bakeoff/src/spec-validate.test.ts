/**
 * spec-validate.test.ts — the two rules that catch a spec seat inventing bars
 * the ticket never asked for.
 *
 * WHERE THE FIXTURES COME FROM. Every `source` below is copied VERBATIM out of
 * the frozen suite at
 *   dashboard/results/calibration-4b/2026-07-29T05-37-40-117Z/acceptance/CAL4B-PORTFOLIO/
 * which is the authoring-calibration run (Phase 2e task 4B) that produced the
 * defect: 12 criteria authored from a three-sentence portfolio ticket, run
 * against seven artefacts, ZERO false passes — and seven criteria that failed on
 * EVERY artefact including the correct one, so the correct portfolio graded
 * `fail`. The excerpts keep their surrounding imports and `const` declarations
 * because both rules read those lines; an excerpt trimmed to the assertion alone
 * would pass for the wrong reason.
 *
 * NEGATIVE CONTROLS ARE THE POINT OF THIS FILE. Both rules are conjunctions, and
 * a conjunction can be satisfied by one half while the other half is dead. So
 * each rule is broken one conjunct at a time and asserted SILENT:
 *
 *   rule 1, control A — swap the rendered-text producer for an HTTP body read,
 *                       keep the 200-character floor        => must go quiet
 *   rule 1, control B — keep the producer, drop the floor to 3
 *                                                           => must go quiet
 *   rule 3, control   — keep the test byte-identical, add the hidden assertion
 *                       to the criterion STATEMENT           => must go quiet
 *
 * Deleting a test file and watching a finding disappear proves NOTHING: it only
 * shows the rule reads its input. Do not weaken these controls into that.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AuditFinding } from "./contracts.js";
import {
  PROSE_LENGTH_FLOOR_MIN,
  acceptanceCoverage,
  acceptanceSignals,
  blockingFindingSummary,
  deterministicAudit,
  numericAssertionDriftFindings,
  parseSuiteDraft,
  proseLengthFloorFindings,
  shapeHeuristicProbeFindings,
  statementProblems,
  statesToken,
  unstatedEnvContractFindings,
} from "./spec-validate.js";
import { SUITE_ENV_NAMES } from "./scorer-protocol.js";
import type { DraftCriterion, DraftTestFile, SuiteDraft } from "./spec-types.js";

/* -------------------------------------------------------------------------
 * Fixture builders
 * ---------------------------------------------------------------------- */

interface FileSpec {
  readonly path: string;
  readonly source: string;
  readonly testIds: readonly string[];
  readonly criterionIds: readonly string[];
}

function draftFile(spec: FileSpec): DraftTestFile {
  return {
    path: spec.path,
    visibility: spec.path.startsWith("visible/") ? "visible" : "holdout",
    runner: spec.path.endsWith(".spec.mjs") ? "playwright" : "node-test",
    description: spec.path,
    expectedTestIds: spec.testIds,
    criterionIds: spec.criterionIds,
    source: spec.source,
  };
}

function criterion(
  id: string,
  statement: string,
  holdoutTestIds: readonly string[],
  visibleTestIds: readonly string[] = [],
): DraftCriterion {
  return {
    id,
    statement,
    evidenceRequired: `holdout test ${holdoutTestIds.join(", ")} PASS`,
    tier: "FUNCTIONAL",
    holdoutTestIds,
    visibleTestIds,
    evidenceArtifacts: [],
  };
}

function draftOf(criteria: readonly DraftCriterion[], files: readonly FileSpec[]): SuiteDraft {
  return {
    ticketId: "CAL4B-PORTFOLIO",
    ticketSha256: "0".repeat(64),
    criteria,
    files: files.map(draftFile),
  };
}

const criterionIdsOf = (findings: readonly AuditFinding[]): readonly string[] =>
  [...new Set(findings.map((f) => f.criterionId ?? "(suite)"))].sort();

/* -------------------------------------------------------------------------
 * The real ticket, verbatim. Note it contains NO digits at all — "three" is a
 * word — which is why a naive "a number the ticket does not state" scan
 * false-positives on the one bar (REQ-005's `>= 3` entries) that IS justified.
 * ---------------------------------------------------------------------- */

const TICKET_BRIEF =
  "Build a portfolio site for Ada Lovelace. It needs a hero with her name, a projects " +
  "section listing at least three projects, and a contact form that confirms when submitted.";

/* -------------------------------------------------------------------------
 * Verbatim excerpts
 * ---------------------------------------------------------------------- */

/** holdout/hero-and-projects.spec.mjs, T-6 (REQ-002). The 200-character bar. */
const HOLDOUT_T6 = [
  'import { test, expect } from "@playwright/test";',
  "",
  'const BASE = (process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").replace(/\\/+$/, "");',
  "",
  'test("[REQ-002] T-6 the rendered page shows real copy and no filler markers", async ({ page }) => {',
  '  await page.goto(BASE + "/", { waitUntil: "load" });',
  '  const rendered = (await page.locator("body").innerText()).replace(/\\s+/g, " ").trim();',
  "  expect(rendered.length, `the page renders only ${rendered.length} characters of text`).toBeGreaterThan(200);",
  "});",
].join("\n");

/** holdout/site-delivery.test.mjs, T-1 (REQ-001). A 200-char floor on the HTTP
 *  response body — legitimate, and the whole file contains no rendered-text
 *  producer. This is the criterion that carries a good 200 and a bad 200. */
const HOLDOUT_T1 = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'const BASE = (process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").replace(/\\/+$/, "");',
  "",
  "async function getDocument(path) {",
  "  const url = BASE + path;",
  '  const response = await fetch(url, { redirect: "follow" });',
  "  const body = await response.text();",
  '  return { url, status: response.status, contentType: response.headers.get("content-type") ?? "", body };',
  "}",
  "",
  'test("[REQ-001] T-1 the site root answers 200 with a non-empty HTML document", async () => {',
  '  const home = await getDocument("/");',
  "  assert.equal(home.status, 200, `GET ${home.url} answered ${home.status}`);",
  "  const body = home.body.trim();",
  "  assert.ok(body.length >= 200, `the root document body is only ${body.length} characters long`);",
  "});",
].join("\n");

/** holdout/hero-and-projects.spec.mjs, T-4 (REQ-004). 28px, 900px and a
 *  `candidates.length > 0` existence check. All legitimate; none is prose. */
const HOLDOUT_T4 = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("[REQ-004] T-4 the hero presents the name Ada Lovelace prominently", async ({ page }) => {',
  "  const candidates = await page.evaluate(() => {",
  '    const norm = (value) => (value || "").replace(/\\s+/g, " ").trim();',
  "    const found = [];",
  '    for (const el of Array.from(document.body.querySelectorAll("*"))) {',
  "      const text = norm(el.textContent);",
  "      if (!/ada\\s*lovelace/i.test(text)) continue;",
  "      const style = window.getComputedStyle(el);",
  "      const rect = el.getBoundingClientRect();",
  "      found.push({ text: text.slice(0, 120), top: Math.round(rect.top), fontSize: parseFloat(style.fontSize) || 0 });",
  "    }",
  "    return found;",
  "  });",
  '  expect(candidates.length, "no visible element renders the name Ada Lovelace").toBeGreaterThan(0);',
  "  const hero = candidates.slice().sort((a, b) => b.fontSize - a.fontSize)[0];",
  "  expect(hero.fontSize, `the largest rendering of the name is ${hero.fontSize}px`).toBeGreaterThanOrEqual(28);",
  "  expect(hero.top, `the name first renders ${hero.top}px down the document`).toBeLessThan(900);",
  "});",
].join("\n");

/** holdout/presentation-quality.spec.mjs, T-13 (REQ-012). The statement says
 *  only "shall raise no uncaught JavaScript page errors"; the test ALSO demands
 *  200 characters of settled body text, and that hidden bar is what failed the
 *  correct artefact at 189 characters. */
const HOLDOUT_T13 = [
  'import { test, expect } from "@playwright/test";',
  "",
  'const BASE = (process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").replace(/\\/+$/, "");',
  "",
  'test("[REQ-012] T-13 loading the home page raises no uncaught script errors", async ({ page }) => {',
  "  const errors = [];",
  '  page.on("pageerror", (error) => errors.push(error.message));',
  '  await page.goto(BASE + "/", { waitUntil: "load" });',
  "  await page.waitForTimeout(1200);",
  '  const rendered = (await page.locator("body").innerText()).replace(/\\s+/g, " ").trim();',
  "  expect(rendered.length, `the settled page renders only ${rendered.length} characters of text`).toBeGreaterThan(200);",
  '  expect(errors, `uncaught page errors: ${errors.join(" | ")}`).toEqual([]);',
  "});",
].join("\n");

const REQ_012_STATEMENT =
  "When the home page loads, the portfolio site shall raise no uncaught JavaScript page errors.";

/** visible/site-basics.spec.mjs, T-30 (REQ-001) and T-31 (REQ-002) together.
 *  T-30's 300-character floor is on `page.content()` — HTML SOURCE, legitimate.
 *  T-31's 150-character floor is on `innerText` — rendered prose, invented.
 *  The two live in ONE file, so a file-level verdict cannot separate them. */
const VISIBLE_T30_T31 = [
  'import { test, expect } from "@playwright/test";',
  "",
  'const BASE = (process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").replace(/\\/+$/, "");',
  "",
  'test("[REQ-001] T-30 the site root is served as an HTML document", async ({ page }) => {',
  '  await page.goto(BASE + "/", { waitUntil: "load" });',
  "  const html = await page.content();",
  '  expect(html.length, "the root document is nearly empty").toBeGreaterThan(300);',
  "});",
  "",
  'test("[REQ-002] T-31 no filler copy is rendered on the page", async ({ page }) => {',
  '  await page.goto(BASE + "/", { waitUntil: "load" });',
  '  const rendered = (await page.locator("body").innerText()).toLowerCase();',
  '  expect(rendered.replace(/\\s+/g, " ").trim().length, "the page renders almost no text").toBeGreaterThan(150);',
  "});",
].join("\n");

/* -------------------------------------------------------------------------
 * RULE 1 — an invented character-count floor on rendered prose
 * ---------------------------------------------------------------------- */

test("rule 1 fires on the real 200-character rendered-text bar (REQ-002 / T-6)", () => {
  const draft = draftOf(
    [criterion("REQ-002", "The site shall render no filler markers.", ["T-6"])],
    [{ path: "holdout/hero.spec.mjs", source: HOLDOUT_T6, testIds: ["T-6"], criterionIds: ["REQ-002"] }],
  );
  const findings = proseLengthFloorFindings(draft);
  assert.equal(findings.length, 1, `expected exactly one finding, got ${findings.length}`);
  assert.equal(findings[0]?.criterionId, "REQ-002");
  assert.match(findings[0]?.detail ?? "", /character-count floor/);
  assert.match(findings[0]?.detail ?? "", /200/);
});

test("NEGATIVE CONTROL A: the same 200-char floor on an HTTP body read is SILENT", () => {
  // Only the producer changes. The floor, the threshold and the assertion shape
  // are byte-identical to the firing case above. If this still fires, the
  // producer conjunct is dead and the rule is a bare "number >= 20" scan.
  const source = HOLDOUT_T6.replace(
    'const rendered = (await page.locator("body").innerText()).replace(/\\s+/g, " ").trim();',
    'const rendered = (await (await fetch(BASE)).text()).replace(/\\s+/g, " ").trim();',
  );
  assert.ok(!source.includes("innerText"), "the control did not actually remove the producer");
  const draft = draftOf(
    [criterion("REQ-002", "The site shall render no filler markers.", ["T-6"])],
    [{ path: "holdout/hero.spec.mjs", source, testIds: ["T-6"], criterionIds: ["REQ-002"] }],
  );
  assert.deepEqual(proseLengthFloorFindings(draft), []);
});

test("NEGATIVE CONTROL B: the same rendered-text floor at a threshold of 3 is SILENT", () => {
  // Only the number changes. If this still fires, the magnitude conjunct is dead
  // and the rule would flag every `entries.length >= 3` count in the suite.
  const source = HOLDOUT_T6.replace(").toBeGreaterThan(200);", ").toBeGreaterThan(3);");
  assert.ok(source.includes("toBeGreaterThan(3)"), "the control did not actually change the threshold");
  assert.ok(source.includes("innerText"), "the control accidentally removed the producer too");
  const draft = draftOf(
    [criterion("REQ-002", "The site shall render no filler markers.", ["T-6"])],
    [{ path: "holdout/hero.spec.mjs", source, testIds: ["T-6"], criterionIds: ["REQ-002"] }],
  );
  assert.deepEqual(proseLengthFloorFindings(draft), []);
});

test("rule 1 does NOT fire on REQ-001: a 200-char floor on the HTTP response body", () => {
  const draft = draftOf(
    [criterion("REQ-001", "The site shall answer the root with status 200.", ["T-1"])],
    [{ path: "holdout/site-delivery.test.mjs", source: HOLDOUT_T1, testIds: ["T-1"], criterionIds: ["REQ-001"] }],
  );
  assert.deepEqual(proseLengthFloorFindings(draft), []);
});

test("rule 1 does NOT fire on REQ-004: 28px, 900px and an existence check", () => {
  const draft = draftOf(
    [criterion("REQ-004", "The site shall display the name as its largest text.", ["T-4"])],
    [{ path: "holdout/hero.spec.mjs", source: HOLDOUT_T4, testIds: ["T-4"], criterionIds: ["REQ-004"] }],
  );
  assert.deepEqual(proseLengthFloorFindings(draft), []);
});

test("rule 1 reaches the ASSERTION: one file, REQ-001's good 300 stays quiet, REQ-002's 150 fires", () => {
  // The two live in one file with one shared set of imports. A file-level or a
  // criterion-level verdict cannot tell them apart.
  const draft = draftOf(
    [
      criterion("REQ-001", "The site shall answer the root with status 200.", ["T-1"], ["T-30"]),
      criterion("REQ-002", "The site shall render no filler markers.", ["T-6"], ["T-31"]),
    ],
    [
      {
        path: "visible/site-basics.spec.mjs",
        source: VISIBLE_T30_T31,
        testIds: ["T-30", "T-31"],
        criterionIds: ["REQ-001", "REQ-002"],
      },
    ],
  );
  assert.deepEqual(criterionIdsOf(proseLengthFloorFindings(draft)), ["REQ-002"]);
});

test("NEGATIVE CONTROL: swapping T-30's page.content() for innerText makes REQ-001 fire too", () => {
  // Proves the HTML-source exclusion above is a live discrimination and not an
  // accident of which criterion the finding happened to be attributed to.
  const source = VISIBLE_T30_T31.replace(
    "const html = await page.content();",
    'const html = await page.locator("body").innerText();',
  );
  const draft = draftOf(
    [
      criterion("REQ-001", "The site shall answer the root with status 200.", ["T-1"], ["T-30"]),
      criterion("REQ-002", "The site shall render no filler markers.", ["T-6"], ["T-31"]),
    ],
    [
      {
        path: "visible/site-basics.spec.mjs",
        source,
        testIds: ["T-30", "T-31"],
        criterionIds: ["REQ-001", "REQ-002"],
      },
    ],
  );
  assert.deepEqual(criterionIdsOf(proseLengthFloorFindings(draft)), ["REQ-001", "REQ-002"]);
});

test("rule 1 is BLOCKING and forces a re-author", () => {
  const draft = draftOf(
    [criterion("REQ-002", "The site shall render no filler markers.", ["T-6"])],
    [{ path: "holdout/hero.spec.mjs", source: HOLDOUT_T6, testIds: ["T-6"], criterionIds: ["REQ-002"] }],
  );
  assert.equal(proseLengthFloorFindings(draft)[0]?.mustRegenerate, true);
});

test("a ticket that STATES the floor suppresses rule 1; the real ticket does not", () => {
  const draft = draftOf(
    [criterion("REQ-002", "The site shall render no filler markers.", ["T-6"])],
    [{ path: "holdout/hero.spec.mjs", source: HOLDOUT_T6, testIds: ["T-6"], criterionIds: ["REQ-002"] }],
  );
  const sourced = `${TICKET_BRIEF} The bio must run to at least 200 characters.`;
  assert.deepEqual(proseLengthFloorFindings(draft, sourced), []);
  // The real brief contains no digits at all, so nothing is suppressed by it.
  assert.equal(proseLengthFloorFindings(draft, TICKET_BRIEF).length, 1);
  assert.equal(proseLengthFloorFindings(draft).length, 1);
});

test("the magnitude cut sits in the gap between the suite's counts and its prose bars", () => {
  // The frozen suite's non-prose floors are 0, 1 and 3; its prose bars are 40,
  // 150, 200. Any cut in (5, 40] separates them, so the constant is not tuned
  // to a single observation.
  assert.ok(PROSE_LENGTH_FLOOR_MIN > 5, "the cut must clear REQ-011's 5-character title floor");
  assert.ok(PROSE_LENGTH_FLOOR_MIN <= 40, "the cut must catch REQ-005's 40-character description bar");
});

/* -------------------------------------------------------------------------
 * RULE 3 — an assertion the criterion's own statement never mentions
 * ---------------------------------------------------------------------- */

test("rule 3 fires on REQ-012's hidden 200-character bar", () => {
  const draft = draftOf(
    [criterion("REQ-012", REQ_012_STATEMENT, ["T-13"])],
    [{ path: "holdout/quality.spec.mjs", source: HOLDOUT_T13, testIds: ["T-13"], criterionIds: ["REQ-012"] }],
  );
  const findings = numericAssertionDriftFindings(draft);
  assert.equal(findings.length, 1, `expected exactly one finding, got ${findings.length}`);
  assert.equal(findings[0]?.criterionId, "REQ-012");
  assert.match(findings[0]?.detail ?? "", /200/);
  assert.equal(findings[0]?.mustRegenerate, false, "rule 3 is ADVISORY");
});

test("NEGATIVE CONTROL: naming the hidden bar in the STATEMENT silences rule 3", () => {
  // The test file is byte-identical. Only the criterion's own statement changes.
  // If this still fires, the comparison against the statement is dead and the
  // rule is a constant "any number in a test is drift".
  const draft = draftOf(
    [
      criterion(
        "REQ-012",
        "When the home page loads, the portfolio site shall raise no uncaught JavaScript page " +
          "errors and shall render more than 200 characters of settled text.",
        ["T-13"],
      ),
    ],
    [{ path: "holdout/quality.spec.mjs", source: HOLDOUT_T13, testIds: ["T-13"], criterionIds: ["REQ-012"] }],
  );
  assert.deepEqual(numericAssertionDriftFindings(draft), []);
});

test("rule 3 does NOT fire on REQ-004: 28 and 900 are both in the statement", () => {
  const draft = draftOf(
    [
      criterion(
        "REQ-004",
        "When a visitor opens the site root, the portfolio site shall display the name Ada Lovelace " +
          "as its largest rendered text at a computed font size of at least 28 pixels and within the " +
          "first 900 pixels of the page.",
        ["T-4"],
      ),
    ],
    [{ path: "holdout/hero.spec.mjs", source: HOLDOUT_T4, testIds: ["T-4"], criterionIds: ["REQ-004"] }],
  );
  assert.deepEqual(numericAssertionDriftFindings(draft), []);
});

test("rule 3 reads spelled-out numbers: REQ-005's `>= 3` matches the word 'three'", () => {
  const source = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("[REQ-005] T-5 the projects section lists three projects", async ({ page }) => {',
    "  const entries = await page.evaluate(() => []);",
    "  expect(entries.length, `the section yields ${entries.length} entries`).toBeGreaterThanOrEqual(3);",
    "});",
  ].join("\n");
  const statement =
    "The portfolio site shall present a projects section containing at least three project entries.";
  const draft = draftOf(
    [criterion("REQ-005", statement, ["T-5"])],
    [{ path: "holdout/projects.spec.mjs", source, testIds: ["T-5"], criterionIds: ["REQ-005"] }],
  );
  assert.deepEqual(numericAssertionDriftFindings(draft), []);
  // Control: with the word removed the same assertion IS drift.
  const stripped = draftOf(
    [criterion("REQ-005", "The portfolio site shall present a projects section.", ["T-5"])],
    [{ path: "holdout/projects.spec.mjs", source, testIds: ["T-5"], criterionIds: ["REQ-005"] }],
  );
  assert.equal(numericAssertionDriftFindings(stripped).length, 1);
});

/**
 * Rule 3 reaches a test only when BOTH halves of "held out" agree: the FILE is
 * under `holdout/` and the criterion names the test as HELD-OUT evidence. The
 * two are near-redundant on a well-formed suite, so a single fixture cannot show
 * either one is alive — an earlier version of this test passed with the file
 * filter deleted, because the evidence filter alone was doing the work. Each
 * conjunct therefore gets a fixture only IT can stop.
 */
test("rule 3 skips the VISIBLE half: the file-visibility conjunct is alive", () => {
  // The criterion names T-13 as HELD-OUT evidence, so the evidence filter lets
  // it through. Only the file's `visible/` path can keep this quiet.
  const draft = draftOf(
    [criterion("REQ-012", REQ_012_STATEMENT, ["T-13"])],
    [{ path: "visible/quality.spec.mjs", source: HOLDOUT_T13, testIds: ["T-13"], criterionIds: ["REQ-012"] }],
  );
  assert.deepEqual(numericAssertionDriftFindings(draft), []);
});

test("rule 3 skips the VISIBLE half: the evidence-half conjunct is alive", () => {
  // The file is under `holdout/`, so the file filter lets it through. Only the
  // criterion binding T-13 as VISIBLE evidence can keep this quiet.
  const draft = draftOf(
    [criterion("REQ-012", REQ_012_STATEMENT, ["T-99"], ["T-13"])],
    [{ path: "holdout/quality.spec.mjs", source: HOLDOUT_T13, testIds: ["T-13"], criterionIds: ["REQ-012"] }],
  );
  assert.deepEqual(numericAssertionDriftFindings(draft), []);
});

test("POSITIVE CONTROL: both conjuncts satisfied and the same file fires", () => {
  // Same source, same threshold, same statement as the two silent cases above.
  const draft = draftOf(
    [criterion("REQ-012", REQ_012_STATEMENT, ["T-13"])],
    [{ path: "holdout/quality.spec.mjs", source: HOLDOUT_T13, testIds: ["T-13"], criterionIds: ["REQ-012"] }],
  );
  assert.equal(numericAssertionDriftFindings(draft).length, 1);
});

/* -------------------------------------------------------------------------
 * Wiring — both rules ride on deterministicAudit, or they gate nothing
 * ---------------------------------------------------------------------- */

test("deterministicAudit emits both findings and blocks on rule 1", () => {
  const draft = draftOf(
    [
      criterion("REQ-002", "The site shall render no filler markers.", ["T-6"]),
      criterion("REQ-012", REQ_012_STATEMENT, ["T-13"]),
    ],
    [
      { path: "holdout/hero.spec.mjs", source: HOLDOUT_T6, testIds: ["T-6"], criterionIds: ["REQ-002"] },
      { path: "holdout/quality.spec.mjs", source: HOLDOUT_T13, testIds: ["T-13"], criterionIds: ["REQ-012"] },
    ],
  );
  const findings = deterministicAudit(draft, { syntaxCheck: false });
  const prose = findings.filter((f) => /character-count floor/.test(f.detail));
  const drift = findings.filter((f) => /the criterion's own statement/.test(f.detail));
  assert.equal(prose.length, 2, "both rendered-text bars must be reported");
  assert.ok(prose.every((f) => f.mustRegenerate), "rule 1 must be blocking through the audit");
  // Both statements are silent about 200, so both draw a drift advisory. That
  // overlap is expected: a bar invented in the test is drift from the statement
  // AND a prose floor, and the two rules see it independently.
  assert.deepEqual(criterionIdsOf(drift), ["REQ-002", "REQ-012"]);
  assert.ok(drift.every((f) => !f.mustRegenerate), "rule 3 must stay advisory through the audit");
});

/* -------------------------------------------------------------------------
 * Comments are not code
 *
 * FOUND BY THE REGRESSION IT CAUSED, not by review. `bakeoff/test/scorer-modes.e2e.mjs`
 * builds a throwaway suite whose T-3 used to assert `rendered.length > 20`.
 * Removing the bar and replacing it with `expect(rendered).not.toBe("")` did
 * NOT clear the finding — because the commit that removed it left a comment
 * saying what the assertion used to read, and rule 1 matched the comment. The
 * e2e stayed at 14/16 with the defect already gone.
 *
 * A comment can only ever be a FALSE POSITIVE: it does not execute, so it
 * cannot fail a correct artefact. And rule 1 is BLOCKING — it throws the suite
 * away and spends another authoring call. A rule that forces regeneration over
 * a line of prose is worse than the bar it was written to catch.
 *
 * The controls below are what stop the fix from over-swinging into a false
 * NEGATIVE, which is the direction that actually costs a measurement: masking
 * too much would let a real bar hide behind a `//` inside a string.
 * ---------------------------------------------------------------------- */

const T3_STRUCTURAL = [
  'import { expect, test } from "@playwright/test";',
  "",
  'test("[REQ-003] T-3 the home document is served and is not blank", async ({ page }) => {',
  '  const response = await page.goto("/");',
  "  expect(response.status()).toBe(200);",
  "  const rendered = (await page.locator(\"body\").innerText()).trim();",
  '  expect(rendered).not.toBe("");',
  "});",
].join("\n");

test("a LINE comment quoting a floor does not fire rule 1", () => {
  const source = T3_STRUCTURAL.replace(
    "  const rendered =",
    "  // it used to read `rendered.length > 20`, which the ticket never stated\n  const rendered =",
  );
  assert.ok(source.includes("rendered.length > 20"), "the fixture must carry the quoted bar");
  const draft = draftOf(
    [criterion("REQ-003", "The home document is served and is not blank.", ["T-3"])],
    [{ path: "holdout/site.spec.mjs", source, testIds: ["T-3"], criterionIds: ["REQ-003"] }],
  );
  assert.deepEqual(proseLengthFloorFindings(draft), []);
});

test("a BLOCK comment quoting a floor does not fire rule 1", () => {
  const source = T3_STRUCTURAL.replace(
    "  const rendered =",
    "  /* removed: expect(rendered.length).toBeGreaterThan(200) */\n  const rendered =",
  );
  const draft = draftOf(
    [criterion("REQ-003", "The home document is served and is not blank.", ["T-3"])],
    [{ path: "holdout/site.spec.mjs", source, testIds: ["T-3"], criterionIds: ["REQ-003"] }],
  );
  assert.deepEqual(proseLengthFloorFindings(draft), []);
});

test("POSITIVE CONTROL: masking comments does not disarm rule 1 on real code", () => {
  // The same file that goes quiet above, with the bar RESTORED as executable
  // code beside an unrelated comment. If this is silent, the fix over-swung and
  // the rule is dead — which is worse than the false positive it replaced.
  const source = T3_STRUCTURAL.replace(
    '  expect(rendered).not.toBe("");',
    "  // the document must carry real copy\n  expect(rendered.length).toBeGreaterThan(200);",
  );
  const draft = draftOf(
    [criterion("REQ-003", "The home document is served and is not blank.", ["T-3"])],
    [{ path: "holdout/site.spec.mjs", source, testIds: ["T-3"], criterionIds: ["REQ-003"] }],
  );
  const findings = proseLengthFloorFindings(draft);
  assert.equal(findings.length, 1, `expected the real bar to still fire, got ${findings.length}`);
  assert.match(findings[0]?.detail ?? "", /200/);
});

test("a `//` inside a STRING is not a comment — the producer survives masking", () => {
  // The masker must not treat the slashes in a URL as a comment start. If it
  // does, everything after them is blanked, the innerText producer disappears
  // with it, and the file-level gate turns the whole rule off for this file.
  const source = T3_STRUCTURAL.replace(
    '  const response = await page.goto("/");',
    '  const response = await page.goto("https://example.com/home");',
  ).replace('  expect(rendered).not.toBe("");', "  expect(rendered.length).toBeGreaterThan(200);");
  const draft = draftOf(
    [criterion("REQ-003", "The home document is served and is not blank.", ["T-3"])],
    [{ path: "holdout/site.spec.mjs", source, testIds: ["T-3"], criterionIds: ["REQ-003"] }],
  );
  assert.equal(
    proseLengthFloorFindings(draft).length,
    1,
    "a URL in a string must not blank the rest of the file",
  );
});

/* -------------------------------------------------------------------------
 * `assertionFreeTestIds` — the `T-1` inside `T-13` mis-segmentation
 *
 * The advisory used a bare `indexOf`, so in a file holding both ids where
 * `T-13` is written FIRST, `indexOf("T-1")` resolves to a position inside
 * `T-13`. Two segments then begin at the same offset and every assertion after
 * that point is attributed to the wrong test. `testSegments`, in the same file
 * and used by the two checks either side of this one, has been boundary-aware
 * all along; the fix is to stop having a second, weaker segmentation.
 *
 * ADVISORY-ONLY, so this never mis-GATED anything — it printed the wrong test
 * id at the author. That is the whole reason it sat in the backlog rather than
 * being an incident, and it is not a reason to leave it wrong: an advisory that
 * names the wrong test is worse than no advisory, because the author reads the
 * test it named, finds an assertion, and stops trusting the checker.
 * ---------------------------------------------------------------------- */

/**
 * T-13 written FIRST, T-1 second, and BOTH assert. The correct answer is [].
 *
 * THE FIXTURE HAD TO BE CHOSEN AGAINST THE BUG, not merely to contain both ids.
 * The first version of this test had T-1 genuinely vacuous, and the bug reported
 * ["T-1"] — the right answer, reached by accident: `indexOf("T-1")` lands inside
 * `T-13`, so T-1's segment is the EMPTY STRING, which contains no assertion and
 * is flagged. It agrees with the truth exactly when the truth is "vacuous". The
 * mutation ran green and the test proved nothing. With both tests asserting, the
 * empty segment produces a finding against a test that plainly asserts, which is
 * the defect made visible.
 */
const T13_BEFORE_T1 = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("[REQ-001] T-13 the page settles without errors", async ({ page }) => {',
  '  await page.goto("http://127.0.0.1:3000/");',
  "  expect(1).toBe(1);",
  "});",
  "",
  'test("[REQ-001] T-1 the page serves a document", async ({ page }) => {',
  '  const response = await page.goto("http://127.0.0.1:3000/");',
  "  expect(response.status()).toBe(200);",
  "});",
].join("\n");

function vacuousIds(source: string, testIds: readonly string[]): readonly string[] {
  const draft = draftOf([criterion("REQ-001", "The site shall serve a home page.", testIds)], [
    { path: "holdout/order.spec.mjs", source, testIds, criterionIds: ["REQ-001"] },
    // A held-out file is required for the draft to be well-formed; this one is
    // uninvolved and carries its own assertion so it cannot be the finding below.
    { path: "holdout/other.spec.mjs", source: T13_BEFORE_T1, testIds: ["T-13"], criterionIds: ["REQ-001"] },
  ]);
  return deterministicAudit(draft, { syntaxCheck: false })
    .filter((finding) => finding.detail.includes("contain no assertion"))
    .filter((finding) => finding.detail.includes("holdout/order.spec.mjs"))
    .map((finding) => /test "([^"]+)"/.exec(finding.detail)?.[1] ?? "(unparsed)")
    .sort();
}

test("T-1 is not found INSIDE T-13 — neither test is called assertion-free, because both assert", () => {
  // Under `indexOf`, `T-1` resolves to the offset of `T-13` on line 3, its
  // segment is empty, and the advisory tells the author that a test containing
  // `expect(response.status()).toBe(200)` has no assertion.
  assert.deepEqual(
    vacuousIds(T13_BEFORE_T1, ["T-1", "T-13"]),
    [],
    "a test that plainly asserts was reported as assertion-free",
  );
});

test("and it still fires at all — a checker that reports nothing is not a fixed checker", () => {
  // THE POSITIVE CONTROL for the test above. If `assertionFreeTestIds` returned
  // [] unconditionally, that assertion would be satisfied by the empty list on
  // one side and by nothing on the other.
  const bothVacuous = [
    'import { test } from "@playwright/test";',
    'test("[REQ-001] T-13 nothing", async ({ page }) => { await page.goto("/"); });',
    'test("[REQ-001] T-1 nothing either", async ({ page }) => { await page.goto("/"); });',
  ].join("\n");
  assert.deepEqual(vacuousIds(bothVacuous, ["T-1", "T-13"]), ["T-1", "T-13"]);
});

test("a declared id that appears only as another id's prefix is ABSENT, not vacuous", () => {
  // The consequence of anchoring, said out loud. `T-1` is declared and never
  // written; naming it assertion-free would report the wrong defect on a file
  // whose real problem is a missing test.
  const onlyT13 = [
    'import { test, expect } from "@playwright/test";',
    'test("[REQ-001] T-13 the page settles", async ({ page }) => { await page.goto("/"); expect(1).toBe(1); });',
  ].join("\n");
  assert.deepEqual(vacuousIds(onlyT13, ["T-1", "T-13"]), []);
});

/* -------------------------------------------------------------------------
 * THE MANIFEST REJECTION NAMES EVERY FIELD, NOT THE FIRST
 *
 * WHAT THIS REPLACES. Until 2026-08-10 the audit called `parseSuiteManifest`
 * inside a `try` and turned the single thrown error into a single finding. That
 * parser's `fail()` is typed `never`, so the feedback turn could name exactly
 * one field per attempt. Run `a913c871` spent 1h26m54s and three authoring
 * attempts learning three of the seven keys of ONE object, and its third attempt
 * dropped the key it had already got right.
 *
 * THE FIXTURE IS THE MANIFEST THAT KILLED IT, in shape: attempt 3's
 * {kind, method, path, expectStatus, description}.
 * ---------------------------------------------------------------------- */

const MANIFEST_SOURCE = (dataExpectations: unknown): string =>
  JSON.stringify(
    {
      manifestVersion: 1,
      ticketId: "CAL4B-PORTFOLIO",
      target: "web",
      execution: {
        install: null,
        build: null,
        typecheck: null,
        lint: null,
        start: "npm start",
        port: 8080,
        healthPath: "/api/health",
        bootTimeoutMs: null,
        commandTimeoutMs: null,
      },
      sourceDirs: ["."],
      uiFlows: [{ id: "home", path: "/", description: "landing", waitForSelector: null }],
      dataExpectations,
    },
    null,
    2,
  );

const HOLDOUT_MINIMAL = [
  'import { test, expect } from "@playwright/test";',
  'test("[REQ-001] T-1 the home page answers", async ({ page }) => {',
  '  const response = await page.goto("/");',
  "  expect(response.status()).toBe(200);",
  "});",
].join("\n");

function manifestFindings(dataExpectations: unknown): readonly AuditFinding[] {
  const draft = draftOf([criterion("REQ-001", "The site shall serve a home page.", ["T-1"])], [
    { path: "holdout/home.spec.mjs", source: HOLDOUT_MINIMAL, testIds: ["T-1"], criterionIds: ["REQ-001"] },
    { path: "suite.manifest.json", source: MANIFEST_SOURCE(dataExpectations), testIds: [], criterionIds: [] },
  ]);
  return deterministicAudit(draft, { syntaxCheck: false }).filter((f) =>
    f.detail.includes("not executable by the sealed scorer"),
  );
}

test("a manifest with three fields wrong produces three findings, not one", () => {
  const findings = manifestFindings([
    { kind: "http", method: "GET", path: "/api/messages", expectStatus: 200, description: "x" },
  ]);

  const text = findings.map((f) => f.detail).join("\n");
  for (const field of ["dataExpectations[0].id", "dataExpectations[0].file", "dataExpectations[0].minRows"]) {
    assert.ok(
      text.includes(field),
      `the audit did not name ${field}. Findings:\n${text || "(none)"}`,
    );
  }
  assert.ok(
    findings.length >= 3,
    `expected at least three manifest findings, got ${String(findings.length)}. One finding is one ` +
      "line in the regeneration prompt, however many fields it mentions.",
  );

  // EVERY ONE BLOCKS, and every one is suite-level. `criterionId === null` is
  // what the remediation branch in spec-agent.ts keys on to stop blaming the
  // ticket for a defect no criterion is involved in.
  for (const finding of findings) {
    assert.equal(finding.mustRegenerate, true, "a manifest the scorer cannot parse must force a re-author");
    assert.equal(finding.criterionId, null, "a manifest defect belongs to no criterion");
  }

  // AND ALL OF THEM REACH THE NEXT ATTEMPT. `blockingFindingSummary` renders one
  // line per finding and is the literal text the regeneration prompt carries;
  // the whole fix is worthless if the extra findings stop at the audit.
  const summary = blockingFindingSummary(findings);
  assert.equal(summary.length, findings.length);
  for (const field of ["dataExpectations[0].id", "dataExpectations[0].file", "dataExpectations[0].minRows"]) {
    assert.ok(summary.join("\n").includes(field), `${field} does not reach the regeneration prompt`);
  }
});

test("a manifest the scorer accepts produces no manifest finding at all", () => {
  // THE NEGATIVE CONTROL. Every assertion above counts findings; a rule that
  // fired on a correct manifest would satisfy them all and burn every authoring
  // attempt on a document that was already right.
  assert.deepEqual(
    manifestFindings([
      { id: "db-1", kind: "sqlite", file: "data/app.db", table: "messages", sql: null, path: null, minRows: 1 },
    ]),
    [],
  );
});

test("a manifest that is not JSON is still one finding, because it has one cause", () => {
  const draft = draftOf([criterion("REQ-001", "The site shall serve a home page.", ["T-1"])], [
    { path: "holdout/home.spec.mjs", source: HOLDOUT_MINIMAL, testIds: ["T-1"], criterionIds: ["REQ-001"] },
    { path: "suite.manifest.json", source: "export default { manifestVersion: 1 };", testIds: [], criterionIds: [] },
  ]);
  const findings = deterministicAudit(draft, { syntaxCheck: false }).filter((f) =>
    f.detail.includes("not executable by the sealed scorer"),
  );
  assert.equal(findings.length, 1, findings.map((f) => f.detail).join("\n"));
  assert.match(findings[0]?.detail ?? "", /JSON/);
});

/* -------------------------------------------------------------------------
 * RULE 4 — a held-out criterion turning on an env var the ticket never names
 *
 * THE RUN: `54927ebc`. The ticket asked for a bearer token from "an environment
 * variable" and never named it. The suite invented one, the builder invented
 * another, and all 7 FUNCTIONAL criteria — every one that reads a message back —
 * failed together on a single 401. The verdict reported one ambiguity as seven
 * defects in the artefact.
 * ---------------------------------------------------------------------- */

/** The ticket as the owner actually wrote it: names the concept, not the name. */
const UNDER_SPECIFIED_BRIEF =
  "Build a small message board with a JSON API. Writes must be authorised with a bearer " +
  "token read from an environment variable. Reads are public.";

/** holdout/auth.test.mjs — grades against a name the ticket never states. */
const HOLDOUT_TOKEN_AUTH = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'const BASE = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";',
  'const TOKEN = process.env.API_TOKEN;',
  "",
  'test("[REQ-003] T-3 a write with the bearer token is accepted", async () => {',
  '  const res = await fetch(BASE + "/messages", {',
  '    method: "POST",',
  '    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },',
  '    body: JSON.stringify({ body: "hello" }),',
  "  });",
  "  assert.equal(res.status, 201);",
  "});",
].join("\n");

const TOKEN_FILES = [
  {
    path: "holdout/auth.test.mjs",
    source: HOLDOUT_TOKEN_AUTH,
    testIds: ["T-3"],
    criterionIds: ["REQ-003"],
  },
];
const TOKEN_CRITERIA = [
  criterion("REQ-003", "An authorised write shall be accepted.", ["T-3"]),
];

test("rule 4 FIRES on the real defect: the suite grades against API_TOKEN, the ticket names no variable", () => {
  const draft = draftOf(TOKEN_CRITERIA, TOKEN_FILES);
  const findings = unstatedEnvContractFindings(draft, UNDER_SPECIFIED_BRIEF);
  assert.equal(findings.length, 1, findings.map((f) => f.detail).join("\n"));
  assert.equal(findings[0]?.criterionId, "REQ-003");
  assert.match(findings[0]?.detail ?? "", /API_TOKEN/);
});

test("NEGATIVE CONTROL A: the same suite is SILENT once the ticket names the variable", () => {
  // Only the BRIEF changes. If this still fires, the rule is not comparing
  // against the ticket at all — it is just reporting every env read.
  const named = `${UNDER_SPECIFIED_BRIEF} The variable is called API_TOKEN.`;
  assert.deepEqual(unstatedEnvContractFindings(draftOf(TOKEN_CRITERIA, TOKEN_FILES), named), []);
});

test("NEGATIVE CONTROL B: prose spelling counts — 'api token' states API_TOKEN", () => {
  const prose = "Build a message board. Writes are authorised with an api token from the environment.";
  assert.deepEqual(unstatedEnvContractFindings(draftOf(TOKEN_CRITERIA, TOKEN_FILES), prose), []);
  assert.ok(statesToken("send a BEARER_TOKEN header", "BEARER_TOKEN"));
  assert.ok(statesToken("send a bearer token header", "BEARER_TOKEN"));
  assert.ok(statesToken("send a bearer-token header", "BEARER_TOKEN"));
  assert.ok(!statesToken("send a token header", "BEARER_TOKEN"), "a partial match must not count");
});

test("NEGATIVE CONTROL C: a genuinely harness-supplied variable never fires, or every suite is destroyed", () => {
  // MEASURED: over every frozen suite on disk the env reads are APP_BASE_URL (17)
  // and APP_ROOT (2). Without an exemption for the supplied ones, a blocking
  // version of this rule throws away every suite it ever sees. Note the firing
  // fixture above ALSO reads APP_BASE_URL and produced exactly one finding — so
  // this exemption is already load-bearing in the positive case.
  const harnessOnly = HOLDOUT_TOKEN_AUTH.replace("process.env.API_TOKEN", "process.env.BAKEOFF_SUITE_DIR");
  assert.ok(!harnessOnly.includes("API_TOKEN"), "the control did not remove the unstated name");
  const draft = draftOf(TOKEN_CRITERIA, [{ ...TOKEN_FILES[0]!, source: harnessOnly }]);
  assert.deepEqual(unstatedEnvContractFindings(draft, UNDER_SPECIFIED_BRIEF), []);
});

test("THE ALLOWLIST IS ASKED OF THE CONTAINER, NOT COPIED — and APP_ROOT is really set", () => {
  /*
   * THE DEFECT THIS PINS, WHICH ALREADY COST TWO CRITERIA. For one draft the
   * allowlist contained APP_ROOT because a comment said the container injected
   * it. Nothing did. Run 54927ebc's holdout/contact-storage.test.mjs resolved
   * `process.env.APP_ROOT ?? <walk up from cwd for a package.json>`, the node
   * pass runs with cwd /opt/bakeoff-scorer which has its own package.json, so it
   * never reached /artifact. T-14 and T-15 died on their first statement and
   * REQ-010/REQ-011 were published as artefact defects.
   *
   * Both ends are now checked. If `suiteEnv` ever stops setting APP_ROOT, the
   * first assertion fails. If someone re-adds a name to the allowlist by hand
   * without the container setting it, the rule simply keeps firing on it — which
   * is the safe direction, and the reason the container half is derived.
   */
  assert.ok(
    SUITE_ENV_NAMES.includes("APP_ROOT"),
    "suiteEnv must set APP_ROOT, or a suite that inspects the artefact on disk searches the scorer's own install",
  );
  assert.ok(SUITE_ENV_NAMES.includes("APP_BASE_URL"), "and the origin the suite talks to");

  // The exemption is now TRUE, so the rule is silent on it — the opposite of the
  // draft behaviour, and correct for the opposite reason.
  const usesAppRoot = HOLDOUT_TOKEN_AUTH.replace("process.env.API_TOKEN", "process.env.APP_ROOT");
  const draft = draftOf(TOKEN_CRITERIA, [{ ...TOKEN_FILES[0]!, source: usesAppRoot }]);
  assert.deepEqual(unstatedEnvContractFindings(draft, UNDER_SPECIFIED_BRIEF), []);
});

test("A NAME THE CONTAINER DOES NOT SET IS NEVER EXEMPT, however harness-shaped it looks", () => {
  // The arm that survives the fix above. `BAKEOFF_ARTIFACT_ROOT` reads exactly
  // like a harness variable and is set by nothing; a suite depending on it is
  // unrunnable in precisely the way APP_ROOT was.
  assert.ok(!SUITE_ENV_NAMES.includes("BAKEOFF_ARTIFACT_ROOT"), "the control must name an UNSET variable");
  const invented = HOLDOUT_TOKEN_AUTH.replace("process.env.API_TOKEN", "process.env.BAKEOFF_ARTIFACT_ROOT");
  const draft = draftOf(TOKEN_CRITERIA, [{ ...TOKEN_FILES[0]!, source: invented }]);
  const findings = unstatedEnvContractFindings(draft, UNDER_SPECIFIED_BRIEF);
  assert.equal(findings.length, 1, "a harness-shaped name nothing supplies must still fire");
  assert.match(findings[0]?.detail ?? "", /BAKEOFF_ARTIFACT_ROOT/);
});

test("NEGATIVE CONTROL D: a name the VISIBLE half publishes is silent — the builder can read it", () => {
  // The visible half is copied into the builder's workspace by
  // `materialiseVisibleSubset`, so a name that appears there has been published
  // and the two sides can agree. This is the whole justification for scanning
  // only the held-out half, so it is asserted rather than assumed.
  const draft = draftOf(TOKEN_CRITERIA, [
    ...TOKEN_FILES,
    {
      path: "visible/auth.test.mjs",
      source: 'const TOKEN = process.env.API_TOKEN;\ntest("[REQ-003] T-9 ok", () => {});',
      testIds: ["T-9"],
      criterionIds: ["REQ-003"],
    },
  ]);
  assert.deepEqual(unstatedEnvContractFindings(draft, UNDER_SPECIFIED_BRIEF), []);
});

test("NO BRIEF IS 'DID NOT RUN', NOT 'PASSED' — the rule refuses to disarm silently", () => {
  // A rule that returns [] when its comparand is missing is indistinguishable
  // from a clean suite. That is the signature defect this whole module documents.
  const draft = draftOf(TOKEN_CRITERIA, TOKEN_FILES);
  const findings = unstatedEnvContractFindings(draft);
  assert.equal(findings.length, 1, "an absent brief must announce itself");
  assert.match(findings[0]?.detail ?? "", /did NOT run/i);
  assert.match(findings[0]?.detail ?? "", /API_TOKEN/);
  assert.deepEqual(unstatedEnvContractFindings(draft, "   "), findings, "whitespace is not a brief");
});

test("rule 4 is ADVISORY for now, and refuses nothing until it is promoted", () => {
  const findings = unstatedEnvContractFindings(draftOf(TOKEN_CRITERIA, TOKEN_FILES), UNDER_SPECIFIED_BRIEF);
  assert.equal(findings[0]?.mustRegenerate, false);
  assert.equal(blockingFindingSummary(findings).length, 0);
});

test("rule 4 is WIRED — deterministicAudit emits it, not just the exported function", () => {
  // The gap that makes a rule look landed while doing nothing: written, tested
  // directly, never pushed from the audit that actually runs.
  const draft = draftOf(TOKEN_CRITERIA, TOKEN_FILES);
  const wired = deterministicAudit(draft, { syntaxCheck: false, ticketBrief: UNDER_SPECIFIED_BRIEF }).filter(
    (f) => f.detail.includes("API_TOKEN"),
  );
  assert.equal(wired.length, 1, "the audit did not surface rule 3");
});

/* -------------------------------------------------------------------------
 * RULE 5 — a probe that finds its subject by DOM shape, then reports a
 * measurement it never took. REQ-016 and REQ-022 on run 54927ebc.
 * ---------------------------------------------------------------------- */

/** holdout/motion-a11y.spec.mjs, condensed to the mechanism, verbatim in shape. */
const HOLDOUT_LEAF_PROBE = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("[REQ-022] T-37 with reduced motion every card is fully opaque", async ({ page }) => {',
  '  await page.goto(process.env.APP_BASE_URL ?? "http://127.0.0.1:3000");',
  "  const faded = await page.evaluate((titles) => {",
  "    const leafFor = (t) => {",
  '      const nodes = document.querySelectorAll("h1,h2,h3,a,p,span,li,div");',
  "      for (const el of nodes) {",
  "        if (el.children.length === 0 && (el.textContent || '').toLowerCase().includes(t.toLowerCase())) return el;",
  "      }",
  "      return null;",
  "    };",
  "    const out = [];",
  "    for (const t of titles) {",
  "      const el = leafFor(t);",
  "      if (!el) { out.push(t); continue; }",
  "      if (parseFloat(getComputedStyle(el).opacity) < 0.9) out.push(t);",
  "    }",
  "    return out;",
  '  }, ["Teewise", "Kori"]);',
  '  expect(faded, "these project cards are hidden or faded when reduced motion is set").toEqual([]);',
  "});",
].join("\n");

const LEAF_CRITERIA = [criterion("REQ-022", "Under reduced motion every card renders at full opacity.", ["T-37"])];

test("rule 5 FIRES on the leaf-element locator that cost REQ-016 and REQ-022", () => {
  const draft = draftOf(LEAF_CRITERIA, [
    { path: "holdout/motion-a11y.spec.mjs", source: HOLDOUT_LEAF_PROBE, testIds: ["T-37"], criterionIds: ["REQ-022"] },
  ]);
  const findings = shapeHeuristicProbeFindings(draft);
  assert.equal(findings.length, 1, findings.map((f) => f.detail).join("\n"));
  assert.equal(findings[0]?.criterionId, "REQ-022");
  assert.match(findings[0]?.detail ?? "", /NO element children/);
  assert.equal(findings[0]?.mustRegenerate, false, "advisory until the fire rate is measured");
});

test("NEGATIVE CONTROL A: the SAME probe locating by text instead of shape is SILENT", () => {
  // Only the locator changes. The evaluate block, the opacity read, the message
  // and the assertion are byte-identical. If this still fires, the rule is a bare
  // "is a playwright holdout" scan.
  const byText = HOLDOUT_LEAF_PROBE.replace(
    "if (el.children.length === 0 && (el.textContent || '').toLowerCase().includes(t.toLowerCase())) return el;",
    "if ((el.textContent || '').toLowerCase().includes(t.toLowerCase())) return el;",
  );
  assert.ok(!byText.includes("children.length"), "the control did not remove the heuristic");
  const draft = draftOf(LEAF_CRITERIA, [
    { path: "holdout/motion-a11y.spec.mjs", source: byText, testIds: ["T-37"], criterionIds: ["REQ-022"] },
  ]);
  assert.deepEqual(shapeHeuristicProbeFindings(draft), []);
});

test("NEGATIVE CONTROL B: the same heuristic in the VISIBLE half is SILENT — the builder can read it", () => {
  const draft = draftOf(LEAF_CRITERIA, [
    { path: "visible/motion.spec.mjs", source: HOLDOUT_LEAF_PROBE, testIds: ["T-37"], criterionIds: ["REQ-022"] },
  ]);
  assert.deepEqual(shapeHeuristicProbeFindings(draft), []);
});

test("NEGATIVE CONTROL C: a node-test holdout is SILENT — there is no DOM to be wrong about", () => {
  const draft = draftOf(LEAF_CRITERIA, [
    { path: "holdout/api.test.mjs", source: HOLDOUT_LEAF_PROBE, testIds: ["T-37"], criterionIds: ["REQ-022"] },
  ]);
  assert.deepEqual(shapeHeuristicProbeFindings(draft), []);
});

test("NEGATIVE CONTROL D: the heuristic in a COMMENT does not count", () => {
  const commented = HOLDOUT_LEAF_PROBE.replace(
    "if (el.children.length === 0 &&",
    "// historical: el.children.length === 0\n      if (",
  );
  const draft = draftOf(LEAF_CRITERIA, [
    { path: "holdout/motion-a11y.spec.mjs", source: commented, testIds: ["T-37"], criterionIds: ["REQ-022"] },
  ]);
  assert.deepEqual(shapeHeuristicProbeFindings(draft), []);
});

test("rule 5 is WIRED into deterministicAudit", () => {
  const draft = draftOf(LEAF_CRITERIA, [
    { path: "holdout/motion-a11y.spec.mjs", source: HOLDOUT_LEAF_PROBE, testIds: ["T-37"], criterionIds: ["REQ-022"] },
  ]);
  const wired = deterministicAudit(draft, { syntaxCheck: false, ticketBrief: TICKET_BRIEF }).filter((f) =>
    f.detail.includes("NO element children"),
  );
  assert.equal(wired.length, 1, "the audit did not surface rule 5");
});

/* -------------------------------------------------------------------------
 * THE THREE RULES THAT KILLED FOUR OVERNIGHT RUNS, 2026-08-10/11
 *
 * Four runs died in the spec phase without ever reaching a builder, on three
 * DIFFERENT blocking rules. None was a defect in the artefact and none was a
 * defect in the test being written — each was the checker refusing work that was
 * correct, or the prompt commissioning what it forbade.
 * ---------------------------------------------------------------------- */

test("EARS accepts every determiner a requirement can honestly open with", () => {
  // run aa6e721e died on "Each project page shall present ..." — unambiguous,
  // binary, gradeable, refused for one word.
  for (const s of [
    "The project page shall present the project title.",
    "Each project page shall present the project title.",
    "Every project card shall display a distinct title.",
    "All submitted enquiries shall be stored with a timestamp.",
    "Any request without a token shall be refused with HTTP 401.",
    "A visitor shall be able to read the about page.",
  ]) {
    assert.deepEqual(
      statementProblems(s).filter((p) => p.detail.includes("EARS")),
      [],
      `EARS refused a gradeable statement: ${s}`,
    );
  }
});

test("NEGATIVE CONTROL: loosening the determiner did NOT open the gate to anything", () => {
  // If this passes vacuously the rule is dead and every statement is accepted.
  const refused = [
    "Project pages are nice to have.", // no shall
    "The site should present a projects section.", // weak modal, not shall
    "Rendering the page quickly.", // no subject, no shall
    "When a visitor submits the form the system shall store it.", // prefixed form, comma still required
  ];
  for (const s of refused) {
    assert.ok(
      statementProblems(s).length > 0,
      `EARS accepted a statement it must refuse: ${s}`,
    );
  }
});

test("a COMMENT explaining a test no longer discards the suite", () => {
  // run 0629aa6c died on a "not implemented" marker. The module's own policy
  // (see maskComments) says a comment can only ever be a false positive — and
  // that masking was applied to every advisory rule and to none of the blocking
  // ones, which are the only rules that can throw the suite away.
  const documented = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    "// The artefact must never render the words Not Implemented on a real route.",
    'test("[REQ-001] T-1 the home page renders real content", async () => {',
    '  const res = await fetch(process.env.APP_BASE_URL + "/");',
    "  const body = await res.text();",
    '  assert.ok(body.includes("Projects"), "the home page renders no project section");',
    "});",
  ].join("\n");
  const draft = draftOf(
    [criterion("REQ-001", "The home page shall render a projects section.", ["T-1"])],
    [{ path: "holdout/home.test.mjs", source: documented, testIds: ["T-1"], criterionIds: ["REQ-001"] }],
  );
  // Scoped to the rule under test. A one-file draft with no visible half trips
  // unrelated suite-level rules, and asserting "no findings at all" would make
  // this test about those instead — and would fail for the wrong reason forever.
  const stubFindings = deterministicAudit(draft, { syntaxCheck: false, ticketBrief: TICKET_BRIEF }).filter(
    (f) => f.mustRegenerate && f.detail.includes("not implemented"),
  );
  assert.deepEqual(stubFindings, [], stubFindings.map((f) => f.detail).join("\n"));
});

test("NEGATIVE CONTROL: the marker in EXECUTABLE code still discards the suite", () => {
  // The arm that must survive masking. If this goes quiet the rule is gone, and a
  // suite may ship a test that greps for a stub instead of asserting an effect.
  const real = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("[REQ-001] T-1 no stubs", async () => {',
    '  const res = await fetch(process.env.APP_BASE_URL + "/");',
    '  assert.ok(!/not implemented/i.test(await res.text()));',
    "});",
  ].join("\n");
  const draft = draftOf(
    [criterion("REQ-001", "The home page shall render a projects section.", ["T-1"])],
    [{ path: "holdout/home.test.mjs", source: real, testIds: ["T-1"], criterionIds: ["REQ-001"] }],
  );
  const fired = deterministicAudit(draft, { syntaxCheck: false, ticketBrief: TICKET_BRIEF }).filter(
    (f) => f.mustRegenerate && f.detail.includes("not implemented"),
  );
  assert.equal(fired.length, 1, "the stub-marker rule stopped firing on executable code");
});

/* -------------------------------------------------------------------------
 * RULE 6 — the owner's acceptance signals, and the suite that covers none of
 *          them.
 *
 * THE RUN. `6ec44b2f` produced a working portfolio site and its sealed suite
 * marked it DID NOT PASS. Four of the five failures were the grader; the worst
 * was that the brief below says, under HOW I WILL KNOW IT WORKS, *"Killing the
 * server and starting it again still returns messages submitted before."* — and
 * the spec seat wrote 25 criteria, none of which restarted anything. It checked
 * persistence structurally instead: find the files carrying the SQLite header,
 * grep them for the bytes just POSTed. The builder's `PRAGMA journal_mode = WAL`
 * is correct and conventional, so the row lived in `portfolio.db-wal` (WAL
 * magic, not the SQLite header) until a checkpoint. The artefact was booted and
 * the data proved durable — it reads back through the API and survives a real
 * kill-and-restart. The suite could not see it.
 *
 * WHAT THESE TESTS PIN, AND WHAT THEY DO NOT. They pin that the owner's
 * sentences are extracted, numbered and REQUIRED to be claimed. They do not —
 * and cannot — pin that a criterion claiming signal 5 actually restarts a
 * server. Coverage is not correctness; this rule raises a floor.
 *
 * BOTH ARMS OF EVERY ARM. A rule that only ever fires is as blind as one that
 * never does, so each of the three states is asserted directly: signals found
 * and all claimed (silent), signals found and one unclaimed (blocking), and no
 * acceptance section at all (a NO-OP that says so). The third is the one this
 * repository keeps getting wrong.
 * ---------------------------------------------------------------------- */

/**
 * The owner's real ticket, embedded verbatim.
 *
 * This is the brief run `6ec44b2f` was authored from, byte for byte, including
 * its hard wrapping — the wrapping is load-bearing, because two of the fifteen
 * bullets continue onto a second line and the extractor has to join them and
 * still return an exact substring of the brief.
 */
const OWNER_BRIEF = `Build my personal portfolio site — a real application with a working backend, not a
static page with a decorative contact form.

Content comes from the attached CV. Take the roles, dates, projects, skills and
contact details from it. Do not invent employers, job titles, dates or numbers. If
the CV is ambiguous about something, leave it out rather than filling the gap.

THE LOOK

Hand-drawn sketchbook, not a template. The attached image is the direction. In words,
so it can be graded:

Warm off-white paper background with faint coloured-pencil scribble at the edges of
the viewport. Content sits on slightly tilted white paper cards with soft drop shadows
and thin dark hand-inked rules, as if photographed on a desk. Headings are large,
uppercase, condensed and hand-lettered in near-black. Body copy is a plain readable
serif at normal weight — the drawing carries the personality, the text does not need
to. Illustrations are coloured-pencil line art with visible hatching, in a restrained
palette of purple, orange, green, red and blue on paper white. Buttons are small
outlined pills with lowercase labels. Section flows are numbered with circled digits
and hand-drawn curved arrows between steps. Top navigation is a single row of
uppercase links with a hand-drawn underline under the active one.

No gradients, no glassmorphism, no neon, no dark mode. If it could have come out of a
generic component library, it is wrong.

THE MOTION

Keep it to what the reference page actually does, which is very little: text spans
reveal once as they scroll into view, animating transform over about 250ms. Nothing
else moves on its own. Stay within about 40% of that duration, animate transform
rather than layout, and reveal each element once rather than every time it re-enters
the viewport. Everything must still work with
prefers-reduced-motion: reduce — motion is the finish, never the mechanism.

RESEARCH BEFORE YOU BUILD

You have network access while building; the graders do not. Before writing the
illustration and motion layer, look up how hand-drawn and sketch aesthetics are
actually implemented on the web today, and how the motion described above is
usually built. Say in your self-report what you looked at and what you
took from it. Vendor anything you depend on into the artefact — nothing is fetched at
grading time.

PAGES

/          hero with my name, role and one line about what I do; a short selected-work
           strip pulled from the CV.
/work      projects from the CV, each as its own paper card: title, what it is, the
           stack, my role.
/about     the career narrative, roles and dates from the CV, and the skills list.
/contact   the form described below.

THE BACKEND — THIS IS THE PART THAT MUST ACTUALLY WORK

A Node HTTP server. Zero runtime npm dependencies: node:http, node:sqlite and the
standard library only. Starts with \`npm start\`, listens on PORT defaulting to 3000,
serves every page and API route from one process, and persists to a SQLite file
created automatically on first boot.

  POST /api/contact   accepts {name, email, message} as JSON. Validates all three:
                      name non-empty, email structurally valid, message at least 20
                      characters. Rejects with 400 and a JSON body naming WHICH field
                      failed. On success stores the message with a timestamp and
                      returns 201 with the new record's id. An empty or invalid
                      submission must never be stored and must never return a success
                      response — a form that confirms a submission it discarded is the
                      failure I care most about.
  GET  /api/messages  stored messages as JSON, newest first. Requires a bearer token
                      read from an environment variable at boot: 401 without it, 401
                      with the wrong one. If the variable is unset the route stays
                      available and refuses every request rather than opening up.
  GET  /api/projects  the CV's projects as JSON, served from the database rather than
                      hardcoded in the page, seeded on first boot.
  GET  /api/health    200 with {"ok":true}.
  everything else     a real 404 page in the site's own visual style — not a stack
                      trace, not a blank body.

The contact page posts to /api/contact for real and renders the server's response: the
field-level error on a 400, a confirmation on a 201. No optimistic "thanks!" before the
server has answered. Rate-limit POST /api/contact to a handful of submissions per
minute per IP, in memory, returning 429 past that.

YOU CANNOT OPEN A PORT WHILE BUILDING THIS

The build sandbox denies listen() on every port with EPERM. That is measured. So
structure it to be testable without a socket: request handling in an exported router
function, \`server.mjs\` doing nothing but wiring it to node:http, every database access
behind functions taking a database handle as an argument. Write node --test tests that
call those directly. Cover the 400 on each invalid field, the 201, both 401s, the 429,
and survival of data across a reopen. Run them and get them passing before you declare
done, and say how many there are.

CONSTRAINTS

Runs entirely offline once built. No external API, no hosted database, no email
provider, no analytics, no third-party fonts or CDN — embed or self-host every asset.
No secrets in the repository; the one token is read from the environment. Responsive at
1440, 768 and 375 with no horizontal scrolling. Keyboard-navigable throughout, visible
focus rings, alt text on every illustration.

HOW I WILL KNOW IT WORKS

- \`npm start\` boots on one port and serves every page and every API route.
- Submitting the contact form with a blank message shows a field error and stores
  nothing; GET /api/messages with the right token proves the count did not change.
- A valid message returns 201 and then appears in GET /api/messages.
- GET /api/messages with no token and with a wrong token both return 401.
- Killing the server and starting it again still returns messages submitted before.
- Every project on /work traces to a line in the attached CV.
- All four pages render in the sketchbook style at 1440, 768 and 375.
- The motion matches what is described above, and the site is fully usable with reduced
  motion enabled.

--- WHAT IS DIFFERENT THIS TIME ---

You built this once already. It came out close. Everything above still stands; the list
below is in addition to it.

EACH PROJECT GETS ITS OWN PAGE

On /work the six project cards go nowhere. Clicking a project must open a page about that
project, the way it works on kamilborzecki.dev.

Treat the six project pages as ONE requirement, not six. They share a single template, and
one test that walks all six slugs is the right way to check them.

Stated one requirement at a time:

- When a visitor clicks a project card on /work, the site shall open that project's page.
- The site shall serve a page at /work/<slug> for each of the six projects, where slug is
  teewise, trade-assistant, jobsilver, kori, parts-agent and crewflow. Typing the URL
  directly shall work, not only clicking through.
- The site shall render, on each project page, the project name as the page heading.
- The site shall render, on each project page, a description of several sentences taken from
  the CV that does not appear on /work.
- The site shall render, on each project page, that project's role and stack from the CV.
- The site shall render, on each project page, that project's illustration.
- The site shall render, on each project page, a link back to /work.
- Where a project page is shown, the site shall keep the top navigation pinned and the
  sketchbook style identical to the rest of the site.
- If a project slug does not exist, then the site shall serve the styled 404 page rather than
  a crash or a blank body.
- The site shall make every project card reachable by keyboard, in the order the cards
  appear, with a visible focus ring.

GO ONE STEP PAST THE LITERAL MINIMUM

The site shall render, at the foot of each project page, links to the previous and next
project.

THREE THINGS THAT WERE MEASURABLY WRONG LAST TIME

Each one is stated on its own, with the measurement that decides it, because the last
build satisfied the prose and failed the check.

- Two poster images shipped STRETCHED, at 0.69 and 0.28 of their true aspect ratio, and
  nothing caught it. The site shall render every image so that its rendered box has the
  same width-to-height ratio as the image file it came from, within one percent, at 1440,
  768 and 375. A test that reads naturalWidth/naturalHeight and compares them to the
  rendered getBoundingClientRect() for every <img> on every page is the right way to
  check this.

- A submission that satisfies every documented validation rule did not answer 201. When a
  POST to /api/contact carries a non-empty name, a structurally valid email and a message
  of at least twenty characters, the site shall answer HTTP 201 with a JSON body carrying
  the new record's id. That exact request, with that exact shape, must not answer 400.

- Something that declares motion still animated under reduced motion. Where
  prefers-reduced-motion: reduce is set, the site shall run no animation at all:
  document.getAnimations() shall return an empty list after the page has settled, and no
  element shall change its opacity or transform over time. Reveal-on-scroll content shall
  be visible immediately in that mode rather than waiting for an animation that never runs.

HOW I WILL KNOW THIS PART WORKS

- Clicking any of the six cards on /work lands on that project's page.
- Each of the six URLs loads directly, with that project's own content.
- /work/nonsense returns the styled 404.
- No image renders at a shape different from the file it came from, on any page, at any of
  the three widths.
- A valid contact submission answers 201 and the message then appears in GET /api/messages.
- With reduced motion enabled, nothing on any page animates and nothing is left invisible.
- Every project page is readable at 375 with no horizontal scrolling.
`;

/** A criterion that claims some of the owner's acceptance signals. */
function claiming(id: string, covers: readonly number[], holdoutTestIds: readonly string[] = ["T-1"]): DraftCriterion {
  return { ...criterion(id, "The site shall serve the contact API.", holdoutTestIds), coversAcceptanceSignals: covers };
}

/** A draft whose criteria between them claim exactly `covers`. */
function draftClaiming(covers: readonly (readonly number[])[]): SuiteDraft {
  return draftOf(
    covers.map((c, i) => claiming(`REQ-${String(i + 1).padStart(3, "0")}`, c)),
    [{ path: "holdout/api.test.mjs", source: "// fixture", testIds: ["T-1"], criterionIds: [] }],
  );
}

/** Every signal number in the owner's brief, 1..15. */
const ALL_SIGNALS = Array.from({ length: 15 }, (_, i) => i + 1);

test("the owner's real brief yields exactly its acceptance bullets, verbatim", () => {
  const signals = acceptanceSignals(OWNER_BRIEF);
  assert.equal(signals.length, 15, signals.map((s) => s.text).join("\n---\n"));

  // THE ONE THE RUN TURNED ON. Named as a literal rather than by index alone:
  // an off-by-one in the numbering would still satisfy a count assertion.
  assert.equal(
    signals[4]?.text,
    "Killing the server and starting it again still returns messages submitted before.",
  );
  assert.equal(signals[4]?.index, 5, "the numbering shown to the seat is 1-based");
  assert.equal(signals[2]?.text, "A valid message returns 201 and then appears in GET /api/messages.");

  // INDEX N IS ALWAYS THE Nth SIGNAL. The prompt renders these numbers and the
  // rule decodes `coversAcceptanceSignals` against them; a gap or a 0-based
  // slip anywhere would make every claim point at the wrong sentence.
  signals.forEach((signal, i) => {
    assert.equal(signal.index, i + 1);
  });

  // VERBATIM, so a finding quoting one can be found in the brief by searching.
  for (const signal of signals) {
    assert.ok(
      OWNER_BRIEF.includes(signal.text),
      `signal ${String(signal.index)} is not a substring of the brief: ${JSON.stringify(signal.text)}`,
    );
  }

  // Both acceptance sections, and only those two.
  assert.deepEqual(
    [...new Set(signals.map((s) => s.heading))],
    ["HOW I WILL KNOW IT WORKS", "HOW I WILL KNOW THIS PART WORKS"],
  );
});

test("NEAR MISSES: bullets under a non-acceptance heading are NOT signals", () => {
  // The brief carries 10 bullets under EACH PROJECT GETS ITS OWN PAGE and 3
  // under THREE THINGS THAT WERE MEASURABLY WRONG LAST TIME. Both lists are
  // requirements, and both are the plausible way for the count to be wrong.
  const texts = acceptanceSignals(OWNER_BRIEF).map((s) => s.text);
  assert.ok(
    !texts.some((t) => t.includes("teewise, trade-assistant")),
    "a requirement bullet from EACH PROJECT GETS ITS OWN PAGE was read as an acceptance signal",
  );
  assert.ok(
    !texts.some((t) => t.includes("0.69 and 0.28")),
    "a bullet from THREE THINGS THAT WERE MEASURABLY WRONG LAST TIME was read as an acceptance signal",
  );
  assert.ok(
    OWNER_BRIEF.includes("- The site shall serve a page at /work/<slug> for each of the six projects"),
    "the fixture no longer contains the near-miss bullets, so this control proves nothing",
  );
});

test("a suite covering every signal passes, and says how many it checked", () => {
  const report = acceptanceCoverage(draftClaiming([ALL_SIGNALS]), OWNER_BRIEF);
  assert.equal(report.ran, true);
  assert.equal(report.signals.length, 15);
  assert.deepEqual(report.uncovered, []);
  assert.deepEqual(report.findings, [], report.findings.map((f) => f.detail).join("\n"));
});

test("a suite leaving one signal unclaimed is BLOCKING and names it verbatim", () => {
  // Signal 5 is the restart. Everything else is claimed, so the finding cannot
  // be passing for the trivial reason that nothing was claimed at all.
  const report = acceptanceCoverage(draftClaiming([ALL_SIGNALS.filter((n) => n !== 5)]), OWNER_BRIEF);
  assert.equal(report.ran, true);
  assert.equal(report.uncovered.length, 1);
  assert.equal(report.uncovered[0]?.index, 5);

  const blockers = report.findings.filter((f) => f.mustRegenerate);
  assert.equal(blockers.length, 1, report.findings.map((f) => f.detail).join("\n"));
  assert.ok(
    blockers[0]?.detail.includes(
      "Killing the server and starting it again still returns messages submitted before.",
    ),
    `the finding does not quote the signal: ${blockers[0]?.detail ?? "(none)"}`,
  );
});

test("ONE FINDING PER SIGNAL, ONE LINE EACH — the shape the next attempt reads", () => {
  // MEASURED, THEN FIXED. The first version emitted a single finding listing
  // every uncovered signal on its own line. `blockingFindingSummary` renders one
  // line per FINDING and `accumulatedConstraintsTurn` numbers that list, so the
  // seat received ONE numbered constraint with a 17-line body — and three of the
  // owner's bullets hard-wrap, so their second halves arrived looking exactly
  // like the start of the next signal.
  const report = acceptanceCoverage(draftClaiming([[1]]), OWNER_BRIEF);
  const blockers = report.findings.filter((f) => f.mustRegenerate);
  assert.equal(blockers.length, 14, "14 signals are unclaimed, so 14 constraints reach the next attempt");

  const summary = blockingFindingSummary(report.findings);
  assert.equal(summary.length, 14);
  for (const line of summary) {
    assert.ok(!line.includes("\n"), `a constraint spans more than one line: ${JSON.stringify(line)}`);
  }
  // The wrapped bullets are quoted whole, on one line. Signal 8 is one of the
  // three that wrap in the brief.
  assert.ok(
    summary.some((l) =>
      l.includes(
        "The motion matches what is described above, and the site is fully usable with reduced motion enabled.",
      ),
    ),
    "a hard-wrapped signal is not quoted whole on its constraint line",
  );
});

test("the finding's remedy is 'add' — no criterion that exists can close it", () => {
  // `spec-repair.ts` may only return artefacts it was handed, so a finding
  // about a MISSING criterion declared "edit" is localised onto criteria that
  // cannot fix it, the round returns, and the fresh re-audit does not re-raise
  // it. That is run `d143e52d`, and it turned a correct rejection into an
  // acceptance.
  const report = acceptanceCoverage(draftClaiming([[1]]), OWNER_BRIEF);
  const blockers = report.findings.filter((f) => f.mustRegenerate);
  assert.equal(blockers.length, 14);
  for (const finding of blockers) {
    assert.equal(finding.remedy, "add", `a coverage finding declared a remedy repair cannot deliver: ${finding.detail}`);
    // Suite-level by construction: the missing artefact has no id to name, and
    // `repairTargets` puts a null-criterionId "add" finding in its unlocalised
    // list, so the repair round is DECLINED rather than dispatched at criteria
    // that cannot close it.
    assert.equal(finding.criterionId, null);
  }
});

test("NO ACCEPTANCE SECTION: the rule is a no-op, and the fact is observable", () => {
  // Most tickets look like this. The rule must require nothing — and must not
  // report that as a pass, which is the defect this whole file exists against.
  const plain = "Build a portfolio site for Ada Lovelace. It needs a hero with her name.";
  const report = acceptanceCoverage(draftClaiming([[]]), plain);

  assert.equal(report.ran, true, "the rule ran: a brief was supplied");
  assert.equal(report.signals.length, 0, "a brief with no acceptance heading declares no signals");
  assert.deepEqual(report.uncovered, []);
  assert.deepEqual(
    report.findings.filter((f) => f.mustRegenerate),
    [],
    "a brief with no acceptance signals must never block a suite",
  );
  // THE OBSERVABLE. "0 signals found, so nothing was required" is a different
  // fact from "every signal is covered", and both `signals.length` and this
  // advisory distinguish them. Without it the two states are one silence.
  assert.equal(report.findings.length, 1);
  assert.ok(
    report.findings[0]?.detail.includes("declares NO acceptance signals"),
    report.findings[0]?.detail ?? "(no finding)",
  );
});

test("NO BRIEF AT ALL: the rule announces that it did not run", () => {
  const report = acceptanceCoverage(draftClaiming([[]]), undefined);
  assert.equal(report.ran, false, "with no brief the rule cannot have run");
  assert.deepEqual(report.findings.filter((f) => f.mustRegenerate), []);
  assert.equal(report.findings.length, 1);
  assert.ok(report.findings[0]?.detail.includes("did NOT run"), report.findings[0]?.detail ?? "(none)");
});

test("an index naming no signal covers nothing, and does not crash", () => {
  // 0 and 99 are the two ways a 1-based list gets miscounted. Neither may be
  // read as coverage, and neither gets a blocking finding of its own: the
  // signal they failed to claim is already blocking, and two findings for one
  // mistake read as two mistakes.
  const report = acceptanceCoverage(draftClaiming([[0, 99], ALL_SIGNALS.filter((n) => n !== 5)]), OWNER_BRIEF);
  assert.deepEqual(report.outOfRange, [0, 99]);
  assert.deepEqual(report.uncovered.map((s) => s.index), [5]);
  assert.equal(report.findings.filter((f) => f.mustRegenerate).length, 1);
  // DE-DUPLICATED: two criteria naming the same wrong number is one wrong number.
  const twice = acceptanceCoverage(draftClaiming([[99], [99], ALL_SIGNALS]), OWNER_BRIEF);
  assert.deepEqual(twice.outOfRange, [99]);
  assert.equal(
    report.findings.filter((f) => !f.mustRegenerate).length,
    1,
    "the out-of-range indices are reported, advisory, exactly once",
  );
});

test("the rule fires THROUGH deterministicAudit, not only when called directly", () => {
  // The wiring, which is its own defect class: a rule nobody calls is a rule
  // nobody has. `auditSuite` passes `ticketBrief: ticket.brief`.
  const uncovered = deterministicAudit(draftClaiming([[1]]), {
    syntaxCheck: false,
    ticketBrief: OWNER_BRIEF,
  }).filter((f) => f.mustRegenerate && f.detail.includes("acceptance signal"));
  assert.equal(uncovered.length, 14, "the coverage rule is not wired into the deterministic pass");
  assert.ok(uncovered.every((f) => f.remedy === "add"));

  const covered = deterministicAudit(draftClaiming([ALL_SIGNALS]), {
    syntaxCheck: false,
    ticketBrief: OWNER_BRIEF,
  }).filter((f) => f.detail.includes("acceptance signal"));
  assert.deepEqual(covered, [], "a fully-covered suite must draw no coverage finding at all");
});

test("parseSuiteDraft REQUIRES the declaration rather than defaulting it to []", () => {
  // [] is a CLAIM — "this criterion covers none of them" — and inferring it
  // from silence is how every signal ends up claimed by nobody with no
  // complaint recorded anywhere.
  const criterionJson = {
    id: "REQ-001",
    statement: "The system shall serve the contact API.",
    evidenceRequired: "holdout test T-1 PASS",
    tier: "FUNCTIONAL",
    holdoutTestIds: ["T-1"],
    visibleTestIds: [],
    evidenceArtifacts: [],
  };
  const files = [
    {
      path: "holdout/api.test.mjs",
      visibility: "holdout",
      runner: "node-test",
      description: "api",
      testIds: ["T-1"],
      criterionIds: ["REQ-001"],
      source: "// fixture",
    },
  ];
  const ticket = { id: "T-1", brief: OWNER_BRIEF, sha256: "0".repeat(64), tier: "hard", title: "t" } as const;

  const missing = parseSuiteDraft({ criteria: [criterionJson], testFiles: files }, ticket);
  assert.equal(missing.ok, false, "a criterion with no coverage declaration was accepted");
  assert.ok(
    !missing.ok && missing.problems.some((p) => p.includes("coversAcceptanceSignals")),
    !missing.ok ? missing.problems.join("; ") : "",
  );

  const present = parseSuiteDraft(
    { criteria: [{ ...criterionJson, coversAcceptanceSignals: [3, 5] }], testFiles: files },
    ticket,
  );
  assert.equal(present.ok, true, present.ok ? "" : present.problems.join("; "));
  assert.deepEqual(present.ok ? present.draft.criteria[0]?.coversAcceptanceSignals : null, [3, 5]);
});
