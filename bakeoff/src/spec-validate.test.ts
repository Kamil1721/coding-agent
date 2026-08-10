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
  blockingFindingSummary,
  deterministicAudit,
  numericAssertionDriftFindings,
  proseLengthFloorFindings,
  shapeHeuristicProbeFindings,
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
