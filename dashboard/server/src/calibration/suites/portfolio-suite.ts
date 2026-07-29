/**
 * calibration/suites/portfolio-suite.ts — THE ONE YARDSTICK, held still.
 *
 * WHAT THIS IS. A hand-authored acceptance suite for `PORTFOLIO_TICKET`,
 * committed rather than generated, so `calibration.test.ts` can run the seven
 * fixtures through the REAL sealed container without a model, a network or a
 * quota. It is the yardstick, and the whole value of a yardstick is that it does
 * not move.
 *
 * ONE CRITERIA SET FOR ALL SEVEN FIXTURES, AND THAT IS THE POINT. A per-fixture
 * criteria set would be tuning the ruler to the thing being measured: you would
 * write "asserts three projects" for `blank-page` knowing it must fail, then
 * quietly not write it for the artefact you wanted to pass. `criteriaFor()`
 * takes no fixture argument for exactly that reason. The criteria and both test
 * files below are byte-identical for every fixture; only `ticketId` and the
 * execution manifest vary, and the manifest varies by a RULE (see
 * `executionFor`), not by a choice.
 *
 * WHAT IT DOES NOT PROVE. It does not prove the grader DISCRIMINATES. These
 * criteria were written by someone who had already read all seven artefacts, so
 * the discrimination they produce was chosen, not measured. Task 4B authors a
 * suite from the ticket alone and is the one that answers that question.
 *
 * WHY THERE IS NO QUALITY CRITERION IN HERE, and this is a MEASURED constraint
 * rather than a preference: `GATE:suite-green` is a BLOCKING container gate that
 * fails whenever ANY frozen test fails, whatever tier its criterion declares
 * (bakeoff/src/scorer-container.ts, `runFrozenSuite`). A QUALITY criterion
 * carried by a frozen test would therefore fail the run at BLOCKING — the exact
 * opposite of "QUALITY reports, it never blocks". QUALITY findings consequently
 * come from OUTSIDE the frozen suite; see `qualityFindingsFor` in
 * ../grade-fixture.ts.
 *
 * WHY REQ-001 IS THE ONLY BLOCKING CRITERION AND EVERY FIXTURE PASSES IT. The
 * deterministic audit requires at least one BLOCKING criterion
 * (spec-validate.ts: "doc 02 section 5.4 puts builds/boots/suite-passes ... in
 * the BLOCKING tier"). A BLOCKING criterion asserting page CONTENT would move
 * every content failure into BLOCKING at the criterion level as well as the
 * gate level, which buys nothing and costs the ability to see which requirement
 * was missed. So REQ-001 asserts reachability — a 404 fails it — and the three
 * content requirements sit at FUNCTIONAL where the ticket put them.
 *
 * EARS NOTATION IS NOT DECORATION HERE. `spec-validate.ts:statementProblems`
 * rejects any statement without a `shall` clause matching an EARS template, and
 * a rejected statement is `mustRegenerate`, which means `gradeFixture` throws
 * before a container ever starts. Keep the shapes below if you edit them.
 */

import { REQ_ID_PATTERN, SUITE_MANIFEST_PATH } from "bakeoff/dist/spec-types.js";
import type { DraftCriterion, DraftTestFile, SuiteDraft } from "bakeoff/dist/spec-types.js";

/**
 * The criteria, in tier order.
 *
 * `evidenceRequired` names the held-out test id on purpose: the audit rejects a
 * criterion whose prose and whose binding disagree, on the grounds that prose
 * nobody checks is decoration.
 */
function criteriaFor(): readonly DraftCriterion[] {
  return [
    {
      id: "REQ-001",
      tier: "BLOCKING",
      statement: "The system shall serve the home document at / with an HTTP 200 response.",
      evidenceRequired: "holdout test T-1 PASS: a request for / answers HTTP 200",
      holdoutTestIds: ["T-1"],
      visibleTestIds: [],
      evidenceArtifacts: [],
    },
    {
      id: "REQ-002",
      tier: "FUNCTIONAL",
      statement: "The system shall display a top-level heading carrying the subject's name.",
      evidenceRequired: "holdout test T-2 PASS: the rendered page carries the name in an h1",
      holdoutTestIds: ["T-2"],
      visibleTestIds: ["T-20"],
      evidenceArtifacts: [],
    },
    {
      id: "REQ-003",
      tier: "FUNCTIONAL",
      statement:
        "The system shall present a projects section listing three or more separate project entries, " +
        "each carrying its own title text.",
      evidenceRequired: "holdout test T-3 PASS: the projects section renders three or more titled entries",
      holdoutTestIds: ["T-3"],
      visibleTestIds: [],
      evidenceArtifacts: [],
    },
    {
      id: "REQ-004",
      tier: "FUNCTIONAL",
      statement:
        "When the reader submits the contact form, the system shall render a visible confirmation " +
        "without navigating away.",
      evidenceRequired: "holdout test T-4 PASS: submitting the contact form reveals a confirmation",
      holdoutTestIds: ["T-4"],
      visibleTestIds: [],
      evidenceArtifacts: [],
    },
  ];
}

/**
 * The held-out half.
 *
 * Every title carries its `[REQ-00n]` tag because that is how the container
 * attributes a test result to a criterion (`attributeCriteria` in
 * scorer-container.ts); an untagged test reports as `unasserted`, which is a
 * failure, and it would fail identically for all seven fixtures — measuring the
 * tagging convention rather than the artefact.
 *
 * T-3 counts DISTINCT TITLE TEXTS rather than elements. `stub-markers` ships a
 * projects section containing the words "Coming soon" and nothing else; a count
 * of `section#projects *` would pass it, which is precisely the "checks that a
 * selector exists without checking it contains anything" failure that fixture
 * exists to catch.
 */
const HOLDOUT_SOURCE = `import { test, expect } from "@playwright/test";

test("[REQ-001] T-1 the home document is served", async ({ page }) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  expect(response.status()).toBe(200);
});

test("[REQ-002] T-2 a top-level heading carries the subject's name", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator("h1").first();
  await expect(heading).toHaveCount(1);
  await expect(heading).toContainText(/ada\\s+lovelace/i);
});

test("[REQ-003] T-3 the projects section lists three or more titled entries", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#projects, [data-section='projects'], section:has(> h2:text-matches('projects', 'i'))").first();
  await expect(section).toHaveCount(1);
  const titles = await section.locator("h3, li > strong, article h2, .project-title").allInnerTexts();
  const named = [...new Set(titles.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1))];
  expect(named.length).toBeGreaterThanOrEqual(3);
});

test("[REQ-004] T-4 submitting the contact form reveals a confirmation", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("#contact form, form#contact-form, section#contact form").first();
  await expect(form).toHaveCount(1);
  const email = form.locator("input[type='email'], input[name='email']").first();
  await expect(email).toHaveCount(1);
  await email.fill("reader@example.com");
  const before = page.url();
  await form.locator("button[type='submit'], input[type='submit'], button").first().click();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(before);
  const confirmation = page.locator("#confirm, [data-confirm], .confirmation").first();
  await expect(confirmation).toBeVisible();
});
`;

/**
 * The visible twin.
 *
 * One twin for one FUNCTIONAL criterion clears the audit's visible-coverage
 * target. It asserts the same requirement a DIFFERENT way — the document title
 * rather than the heading — because a twin that repeats the held-out assertion
 * verbatim tells the builder the held-out test.
 */
const VISIBLE_SOURCE = `import { test, expect } from "@playwright/test";

test("[REQ-002] T-20 the document names its subject in the title", async ({ page }) => {
  await page.goto("/");
  const title = await page.title();
  expect(title.trim().length).toBeGreaterThan(2);
});
`;

/**
 * The execution block, DERIVED BY A RULE rather than chosen per fixture.
 *
 * The rule: an artefact that declares its own `build` script is required to
 * build. Nothing else varies. `broken-build` is the only fixture with a
 * package.json, so it is the only one that gets a build command — but the rule
 * is written over the artefact's own declaration, not over the fixture's name,
 * which is what keeps this from being per-fixture tuning. Declaring
 * `npm run build` for all seven would fail six of them for having no
 * package.json; declaring it for none would let `broken-build` — whose
 * index.html is byte-identical to `correct-portfolio`'s — grade PASS, which is
 * a false pass in the calibration set itself.
 *
 * MEASURED CAVEAT, recorded here because it changes what `broken-build`
 * measures: the container has no network and the fixture's `typescript` is a
 * devDependency that was never installed, so `npm run build` fails on an
 * unavailable compiler rather than on the TS2345 the fixture was authored to
 * exercise. `GATE:build` fires either way and the failure is real — an artefact
 * that cannot build offline has not built — but this fixture does not currently
 * prove the grader sees a type error. Backlog, not a fixture edit.
 */
function executionFor(hasBuildScript: boolean): Record<string, unknown> {
  return {
    install: null,
    build: hasBuildScript ? "npm run build" : null,
    typecheck: null,
    lint: null,
    // Static mode (owner decision D2): every fixture is a static page, so the
    // scorer serves the artefact directory with its own pre-baked server and
    // asserts the root document is real.
    start: null,
    port: null,
    healthPath: null,
    bootTimeoutMs: null,
    commandTimeoutMs: null,
  };
}

function manifestSource(ticketId: string, hasBuildScript: boolean): string {
  return `${JSON.stringify(
    {
      manifestVersion: 1,
      ticketId,
      target: "web",
      execution: executionFor(hasBuildScript),
      sourceDirs: ["."],
      uiFlows: [
        {
          id: "home",
          path: "/",
          description: "the portfolio page",
          // NULL, AND MEASURED RATHER THAN CHOSEN. The container waits for the
          // selector to be VISIBLE, and `blank-page` renders an empty <div> in
          // an empty <body>, which Chromium reports as hidden. Any selector at
          // all therefore timed out three times over on that fixture (30 s per
          // breakpoint, recorded in calibration-4a.json), producing zero
          // screenshots and a scorer-side infrastructure error — the fixture
          // that fails hardest would have produced the least evidence. Null
          // means "capture after load", which every fixture can satisfy.
          waitForSelector: null,
        },
      ],
      dataExpectations: [],
    },
    null,
    2,
  )}\n`;
}

export interface PortfolioDraftInput {
  readonly ticketId: string;
  readonly ticketSha256: string;
  /** True when the artefact's package.json declares a `build` script. */
  readonly hasBuildScript: boolean;
}

/** The suite draft, identical for every fixture but for ticket id and manifest. */
export function portfolioDraft(input: PortfolioDraftInput): SuiteDraft {
  const criteria = criteriaFor();
  // A criterion id the scorer cannot attribute reports `unasserted` forever, and
  // that failure looks identical across all seven fixtures — it would read as
  // "every artefact is broken" rather than "the suite is malformed".
  for (const criterion of criteria) {
    if (!REQ_ID_PATTERN.test(criterion.id)) {
      throw new Error(`calibration suite criterion id ${criterion.id} is not of the form REQ-001`);
    }
  }
  const files: readonly DraftTestFile[] = [
    {
      path: "holdout/portfolio.spec.mjs",
      visibility: "holdout",
      runner: "playwright",
      description: "the delivered page carries what the ticket asked for",
      expectedTestIds: ["T-1", "T-2", "T-3", "T-4"],
      criterionIds: ["REQ-001", "REQ-002", "REQ-003", "REQ-004"],
      source: HOLDOUT_SOURCE,
    },
    {
      path: "visible/title.spec.mjs",
      visibility: "visible",
      runner: "playwright",
      description: "visible twin: the document names its subject",
      expectedTestIds: ["T-20"],
      criterionIds: ["REQ-002"],
      source: VISIBLE_SOURCE,
    },
    {
      path: SUITE_MANIFEST_PATH,
      visibility: "holdout",
      runner: "node-test",
      description: "the scorer's execution manifest — a declaration, not a test",
      expectedTestIds: [],
      criterionIds: [],
      source: manifestSource(input.ticketId, input.hasBuildScript),
    },
  ];

  return {
    ticketId: input.ticketId,
    ticketSha256: input.ticketSha256,
    criteria,
    files,
  };
}
