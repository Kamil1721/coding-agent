/**
 * adjudicate.test.ts — the router, driven from three real runs and its own edges.
 *
 * WHY THE NEGATIVE CONTROLS ARE THE POINT, STATED BEFORE THE FIRST TEST. A
 * classifier that answered PIPELINE unconditionally would pass a suite built
 * only from run `047f9872`, and it would wake an unsupervised repair lane on
 * every honest `DID NOT PASS` in the archive. So the ARTEFACT cases are not
 * decoration here: `6ec44b2f` REQ-020 and `e1c15359` REQ-022 are both real,
 * both already diagnosed as BUILD defects, and both must come back ARTEFACT
 * from the same function that returns PIPELINE for `047f9872`. §4 of this file
 * mutates the classifier into an over-eager one and shows them going red.
 *
 * WHERE THE FIXTURES COME FROM, FIELD BY FIELD. Every message, stack, code,
 * operator, `expected` and `actual` below was read out of
 * `dashboard/results/scorer-out/<run>/result.json` or `/suite-report.json` in
 * this session, with two exceptions that are labelled RECONSTRUCTED at the
 * fixture and explained there. The archived documents PREDATE
 * `suiteExecution.failures` (design §12.3), so the failure objects are assembled
 * from the transcript the scorer did record; that assembly is the fixture's
 * whole risk, and it is why §2 also runs the archive's LITERAL shape — no
 * failures at all — and requires UNKNOWN.
 *
 * WHAT EACH TEST'S DOCBLOCK OWES THE READER: the mutation that turns it red.
 * Every one below was applied to `adjudicate.ts` as a textual patch, compiled,
 * run against this file, observed RED, and reverted. A docblock claiming a
 * mutation nobody ran is the defect this repository has shipped seventeen times,
 * so the ledger is here, in the tree, rather than in a session note that will not
 * survive: 40 mutations, 40 red, no survivors.
 *
 *  M1  any non-empty message counts as pipeline .... 6 tests, incl. both ARTEFACT truths
 *  M2  `verdictFrom` never returns PIPELINE ........ 11 tests, incl. 047f9872
 *  M3  any expected/actual pair is a comparison .... 6ec44b2f · the boolean-pair unit
 *  M4  file rule ignores artefact evidence ......... the answering-file control
 *  M5  reasonless criterion defaults to PIPELINE ... archived · truncated · reasonless
 *  M6  file rule ignores a passing sibling TEST .... the passing-sibling control
 *  M7  file rule accepts a single failure .......... 4 tests
 *  M8  file rule needs no green sibling FILE ....... the all-red-run control
 *  M9  file rule ignores the cause signature ....... verified-text-only · varied-causes
 *  M10 testRefs cap read as 11 instead of 10 ....... the cap control
 *  M11 ERR_ASSERTION added to the harness codes .... 3 tests, incl. 6ec44b2f
 *  M12 install frame read from the MESSAGE ......... the scorer-frame half
 *  M12b install frame matches `/scorer` ............ 5 tests, incl. the suite-frame control
 *  M13 test-body frame names ignored ............... the helper-frame control
 *  M13b a bare frame counts as a helper ............ the Playwright-frame control
 *  M14 `stripAnsi` is the identity ................. the escape-hygiene test
 *  M15 `titleKey` window past the writer's cap ..... the truncated-title test
 *  M16 wake ignores run-level evidence ............. the infrastructure-error test
 *  M17 a contradictory failure resolves PIPELINE ... the contradiction test
 *  M18 a contradictory criterion resolves PIPELINE . the disagreeing-tests test
 *  M19 `unasserted` is UNKNOWN ..................... the unasserted test
 *  M20 file segment needs no extension ............. the file-segment test
 *  M21a–f each boot family neutered in turn ........ the boot-family table, one row each
 *  M21g no boot families at all .................... 3 tests, incl. 047f9872
 *  M21h one boot family widened to `/./` ........... 7 tests, incl. the prose control
 *  M22 `unattributedFailures` emptied .............. the orphan half
 *  M23 charging by `criterionIds` only ............. the testRefs-fallback half
 *  M24 artefact grammars switched off .............. both ARTEFACT truths + the sleep test
 *  M25 `wakeRepairLane: true` ...................... 9 tests
 *  M26 a `Math.random()` note ...................... determinism · 047f9872
 *  M27 the file rule's evidence never pushed ....... 3 tests, incl. 6ec44b2f's sqlite pair
 *  M28 harness code list emptied ................... the harness-code half
 *  M29 the two `unasserted` reasons collapsed ...... the second unasserted half
 *  M30 shape rules always usable ................... truncated · testRefs cap
 *  M31 an unmeasured run is UNKNOWN ................ the "nothing was measured" half
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { CriterionCoverage } from "bakeoff/dist/scorer-protocol.js";
import { adjudicate, fileOfTitlePath, isSubstantiveComparison } from "./adjudicate.js";
import type { AdjudicableFailure, AdjudicationInput, CriterionVerdict } from "./adjudicate.js";

/*
 * THE COMPILE-TIME BRIDGE, TO UNCOMMENT WHEN INCREMENT 1 LANDS.
 *
 * `AdjudicableFailure` is a local restatement of bakeoff's `TestFailure`
 * (`scorer-protocol.ts:1552` in the increment-1 tree) because this worktree's
 * HEAD does not carry that type. The two lines below are the check that the
 * restatement never drifted: they fail to COMPILE if a real `ContainerResult`
 * stops satisfying this module's input. They are code rather than a prose TODO
 * on purpose — design §12.1 is a table of prose that rotted.
 *
 * import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
 * export const containerResultSatisfiesInput = (r: ContainerResult): AdjudicationInput => r;
 */

/* -------------------------------------------------------------------------
 * Fixture builders.
 * ---------------------------------------------------------------------- */

const ESC = String.fromCharCode(27);

function failure(patch: Partial<AdjudicableFailure> & { readonly titlePath: string }): AdjudicableFailure {
  return {
    runner: "node-test",
    criterionIds: [],
    name: null,
    message: null,
    stack: null,
    operator: null,
    code: null,
    expected: null,
    actual: null,
    ...patch,
  };
}

function coverage(patch: Partial<CriterionCoverage> & { readonly criterionId: string }): CriterionCoverage {
  return { tier: "FUNCTIONAL", outcome: "failed", testRefs: [], detail: "", ...patch };
}

function input(patch: {
  readonly failures: readonly AdjudicableFailure[];
  readonly criterionCoverage: readonly CriterionCoverage[];
  readonly testsFailed?: number | null;
  readonly reportProblem?: string | null;
  readonly infrastructureErrors?: readonly string[];
}): AdjudicationInput {
  return {
    suiteExecution: {
      testsFailed: patch.testsFailed === undefined ? patch.failures.length : patch.testsFailed,
      reportProblem: patch.reportProblem ?? null,
      failures: patch.failures,
    },
    criterionCoverage: patch.criterionCoverage,
    infrastructureErrors: patch.infrastructureErrors ?? [],
  };
}

function verdictOf(rows: readonly CriterionVerdict[], criterionId: string): CriterionVerdict {
  const row = rows.find((entry) => entry.criterionId === criterionId);
  assert.ok(row !== undefined, `no verdict row for ${criterionId}`);
  return row;
}

/* ---- 047f9872 ------------------------------------------------------------
 *
 * `dashboard/results/scorer-out/run-2026-08-12T15-21-03-226Z-047f9872/`.
 * `node-test-report.ndjson` gives the census: api-contact 3/3, api-core 4/4 and
 * visible/api-routes 6/6 GREEN, `messages-persistence` 0/4 and `inbox-token`
 * 0/3. `result.json`'s `GATE:suite-green` transcript gives the reason, VERBATIM
 * for the first two failures — the transcript is then cut at
 * "… (5743 more characters)".
 *
 * THE OTHER FIVE MESSAGES ARE RECONSTRUCTED AND THE PORTS ARE INVENTED. The
 * archive does not contain them and this session could not read them. What IS
 * recorded, in the design's §1.2 and in the four criteria's own `detail`
 * strings, is that all seven failed the same way inside the same two files.
 * `run047f9872VerifiedTextOnly` below is the same run with ONLY the two
 * messages that can be quoted, and it is the honest floor: it shows which
 * verdicts survive when the reconstruction is withdrawn.
 */
const BOOT_MESSAGE = (port: number, log: string): string =>
  `npm start did not answer /api/health on port ${port} within 45s  npm error Missing script: "start"\n` +
  `npm error\nnpm error Did you mean one of these?\nnpm error   npm star # Mark your favorite packages\n` +
  `npm error   npm stars # View packages marked as favorites\nnpm error\n` +
  `npm error To see a list of scripts, run:\nnpm error   npm run\n` +
  `npm error A complete log of this run can be found in: /tmp/.npm/_logs/${log}-debug-0.log`;

const BOOT_STACK = (file: string, line: number): string =>
  `AssertionError [ERR_ASSERTION]: npm start did not answer /api/health\n` +
  `    at startServer (file:///scorer/suite/${file}:116:12)\n` +
  `    at async TestContext.<anonymous> (file:///scorer/suite/${file}:${line}:17)\n` +
  `    at async Test.run (node:internal/test_runner/test:1332:7)\n` +
  `    at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3)`;

function bootFailure(titlePath: string, criterionIds: readonly string[], port: number, log: string, line: number): AdjudicableFailure {
  const file = titlePath.split(" › ")[0] ?? "";
  return failure({
    titlePath,
    criterionIds,
    name: "AssertionError",
    code: "ERR_ASSERTION",
    operator: "fail",
    message: BOOT_MESSAGE(port, log),
    stack: BOOT_STACK(file, line),
  });
}

const MP = "holdout/messages-persistence.test.mjs";
const IT = "visible/inbox-token.test.mjs";

const T108 = `${MP} › [REQ-006] T-108 a blank message is refused and never reaches the store`;
const T109 = `${MP} › [REQ-007] T-109 stored messages read back with the configured bearer value, newest first`;
const T110 = `${MP} › [REQ-009] T-110 a message submitted before the process is killed is returned after a restart`;
const T111 = `${MP} › [REQ-010] T-111 rapid submissions from one address are limited with 429`;
const T207 = `${IT} › [REQ-006] T-207 a refused submission does not change the stored count`;
const T208 = `${IT} › [REQ-007] T-208 stored messages come back newest first`;
const T209 = `${IT} › [REQ-009] T-209 a message survives killing and restarting the server`;

/** The passing half of 047f9872's node pass, verbatim from `result.json`. */
const RUN_047_PASSED: readonly CriterionCoverage[] = [
  coverage({
    criterionId: "REQ-001",
    tier: "BLOCKING",
    outcome: "passed",
    testRefs: [
      "holdout/api-core.test.mjs › [REQ-001] T-101 GET /api/health answers 200 with ok true",
      "visible/api-routes.test.mjs › [REQ-001] T-201 the health route answers 200 with ok true",
    ],
  }),
  coverage({
    criterionId: "REQ-002",
    tier: "BLOCKING",
    outcome: "passed",
    testRefs: [
      "holdout/api-core.test.mjs › [REQ-002] T-102 every page of the site is served as a real HTML document",
      "holdout/api-core.test.mjs › [REQ-002] T-103 every API route answers from the same process without a server error",
      "visible/api-routes.test.mjs › [REQ-002] T-202 the pages and API routes are served from one process",
    ],
  }),
  coverage({
    criterionId: "REQ-004",
    outcome: "passed",
    testRefs: [
      "holdout/api-contact.test.mjs › [REQ-004] T-105 a fully valid submission answers 201 with the new record id",
      "visible/api-routes.test.mjs › [REQ-004] T-204 a valid submission answers 201 with an id",
    ],
  }),
  coverage({
    criterionId: "REQ-008",
    outcome: "passed",
    testRefs: [
      "holdout/api-contact.test.mjs › [REQ-008] T-107 GET /api/messages refuses a missing and a wrong bearer value",
      "visible/api-routes.test.mjs › [REQ-008] T-206 /api/messages refuses a missing and a wrong bearer value",
    ],
  }),
];

const RUN_047_FAILED: readonly CriterionCoverage[] = [
  coverage({ criterionId: "REQ-006", testRefs: [T108, T207] }),
  coverage({ criterionId: "REQ-007", testRefs: [T109, T208] }),
  coverage({ criterionId: "REQ-009", testRefs: [T110, T209] }),
  coverage({ criterionId: "REQ-010", testRefs: [T111] }),
];

function run047f9872(): AdjudicationInput {
  return input({
    failures: [
      bootFailure(T108, ["REQ-006"], 39211, "2026-08-12T17_05_58_715Z", 153), // VERBATIM
      bootFailure(T109, ["REQ-007"], 36389, "2026-08-12T17_06_43_897Z", 178), // VERBATIM
      bootFailure(T110, ["REQ-009"], 41007, "2026-08-12T17_07_29_101Z", 203), // RECONSTRUCTED
      bootFailure(T111, ["REQ-010"], 38553, "2026-08-12T17_08_14_402Z", 228), // RECONSTRUCTED
      bootFailure(T207, ["REQ-006"], 44117, "2026-08-12T17_09_00_003Z", 61), // RECONSTRUCTED
      bootFailure(T208, ["REQ-007"], 33802, "2026-08-12T17_09_45_610Z", 88), // RECONSTRUCTED
      bootFailure(T209, ["REQ-009"], 40255, "2026-08-12T17_10_31_222Z", 115), // RECONSTRUCTED
    ],
    criterionCoverage: [...RUN_047_PASSED, ...RUN_047_FAILED],
  });
}

/** 047f9872 with ONLY the two failure messages this session could quote. */
function run047f9872VerifiedTextOnly(): AdjudicationInput {
  return input({
    failures: [
      bootFailure(T108, ["REQ-006"], 39211, "2026-08-12T17_05_58_715Z", 153),
      bootFailure(T109, ["REQ-007"], 36389, "2026-08-12T17_06_43_897Z", 178),
      failure({ titlePath: T110, criterionIds: ["REQ-009"] }),
      failure({ titlePath: T111, criterionIds: ["REQ-010"] }),
      failure({ titlePath: T207, criterionIds: ["REQ-006"] }),
      failure({ titlePath: T208, criterionIds: ["REQ-007"] }),
      failure({ titlePath: T209, criterionIds: ["REQ-009"] }),
    ],
    criterionCoverage: [...RUN_047_PASSED, ...RUN_047_FAILED],
  });
}

/* ---- 6ec44b2f ------------------------------------------------------------
 *
 * `run-2026-08-12T09-00-35-066Z-6ec44b2f`. The Playwright error is verbatim from
 * `suite-report.json` (message and stack both, ANSI included — the container
 * copies Playwright's coloured message without stripping it, which is why the
 * fixture keeps the escapes; the message is abridged in the middle, the head and
 * the diff tail being what the grammars read). T-7, T-8, T-11 and T-12 are
 * verbatim from `result.json`'s `GATE:suite-green` transcript, `expected` and
 * `actual` included — `actual: 401, expected: 200, operator: 'strictEqual'` for
 * the first two and `actual: false, expected: true, operator: '=='` for the
 * sqlite pair. T-43's block is past the transcript's truncation point and is
 * therefore left with no reason at all; see the note at it.
 */
const IMAGES = "holdout/images-and-motion.spec.mjs";
const T21 = `${IMAGES} › [REQ-020] T-21 every image keeps its own aspect ratio at 1440, 768 and 375`;
const SQLITE = "holdout/sqlite-storage.test.mjs";
const T11 = `${SQLITE} › [REQ-004] T-11 the served projects live in a SQLite file inside the artefact`;
const T12 = `${SQLITE} › [REQ-009] T-12 an accepted message is written into the SQLite file on disk`;
const CONTACT = "holdout/api-contact.test.mjs";
const T8 = `${CONTACT} › [REQ-008] T-8 accepted submissions read back, newest first, with what was submitted`;

const SQLITE_MESSAGE =
  "no file carrying the SQLite header was found under /opt/bakeoff-scorer, /opt, /app, /srv/app, /workspace";
const SQLITE_STACK =
  `AssertionError [ERR_ASSERTION]: ${SQLITE_MESSAGE}\n` +
  `    at TestContext.<anonymous> (file:///scorer/suite/${SQLITE}:99:10)\n` +
  `    at async Test.run (node:internal/test_runner/test:1332:7)\n` +
  `    at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3)`;

const RATIO_MESSAGE =
  "Error: images rendered at a shape their file does not have:\n" +
  "1440px / -> http://127.0.0.1:3000/assets/hero-desk.jpg file 1200x896 rendered 423x322\n" +
  "1440px / -> http://127.0.0.1:3000/assets/teewise.jpg file 1200x896 rendered 335x254\n\n" +
  `${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived${ESC}[39m${ESC}[2m).${ESC}[22mtoEqual${ESC}[2m(${ESC}[22m${ESC}[32mexpected${ESC}[39m${ESC}[2m) // deep equality${ESC}[22m\n\n` +
  `${ESC}[32m- Expected  - 1${ESC}[39m\n${ESC}[31m+ Received  + 13${ESC}[39m`;

function run6ec44b2f(): AdjudicationInput {
  return input({
    failures: [
      failure({
        titlePath: `${CONTACT} › [REQ-007] T-7 a refused submission is never stored`,
        criterionIds: ["REQ-007"],
        name: "AssertionError",
        code: "ERR_ASSERTION",
        operator: "strictEqual",
        message: "GET /api/messages with the credential answered 401: {\"error\":\"unauthorized\"}\n\n401 !== 200\n",
        expected: "200",
        actual: "401",
        stack: `AssertionError [ERR_ASSERTION]\n    at TestContext.<anonymous> (file:///scorer/suite/${CONTACT}:107:10)`,
      }),
      failure({
        titlePath: T8,
        criterionIds: ["REQ-008"],
        name: "AssertionError",
        code: "ERR_ASSERTION",
        operator: "strictEqual",
        message: "GET /api/messages with the credential answered 401: {\"error\":\"unauthorized\"}\n\n401 !== 200\n",
        expected: "200",
        actual: "401",
        stack: `AssertionError [ERR_ASSERTION]\n    at TestContext.<anonymous> (file:///scorer/suite/${CONTACT}:132:10)`,
      }),
      failure({
        titlePath: T11,
        criterionIds: ["REQ-004"],
        name: "AssertionError",
        code: "ERR_ASSERTION",
        operator: "==",
        message: SQLITE_MESSAGE,
        stack: SQLITE_STACK,
        expected: "true",
        actual: "false",
      }),
      failure({
        titlePath: T12,
        criterionIds: ["REQ-009"],
        name: "AssertionError",
        code: "ERR_ASSERTION",
        operator: "==",
        message: SQLITE_MESSAGE,
        stack: SQLITE_STACK,
        expected: "true",
        actual: "false",
      }),
      // T-43 CARRIES NO REASON HERE, AND THAT IS A MEASUREMENT, NOT LAZINESS.
      // The archived transcript is cut ("… (1163 more characters)") before this
      // failure's block, so its message, stack and expected/actual could not be
      // read in this session. Inventing them and calling them verbatim is the
      // fixture defect this file is trying not to commit. Left reasonless, it
      // also earns its keep: REQ-008 is now one ARTEFACT test and one UNKNOWN
      // one, which is the aggregation rule "an UNKNOWN sibling does not
      // contradict a test that watched the app answer" exercised on real data.
      failure({
        titlePath: "visible/contact-api.test.mjs › [REQ-008] T-43 an accepted submission is readable back with the credential",
        criterionIds: ["REQ-008"],
      }),
      failure({
        titlePath: T21,
        runner: "playwright",
        criterionIds: ["REQ-020"],
        name: "PlaywrightError",
        message: RATIO_MESSAGE,
        stack: `${RATIO_MESSAGE}\n    at /scorer/suite/${IMAGES}:78:100`,
      }),
    ],
    criterionCoverage: [
      coverage({
        criterionId: "REQ-001",
        tier: "BLOCKING",
        outcome: "passed",
        testRefs: [
          "holdout/api-boot.test.mjs › [REQ-001] T-1 GET /api/health answers 200 with ok true",
          "visible/contact-api.test.mjs › [REQ-001] T-40 GET /api/health answers 200 with ok true",
        ],
      }),
      coverage({
        criterionId: "REQ-005",
        outcome: "passed",
        testRefs: [
          `${CONTACT} › [REQ-005] T-5 a fully valid submission is accepted with 201 and the new id`,
          "visible/contact-api.test.mjs › [REQ-005] T-41 a valid submission answers 201 with an id",
        ],
      }),
      coverage({ criterionId: "REQ-004", testRefs: [T11] }),
      coverage({ criterionId: "REQ-007", testRefs: [`${CONTACT} › [REQ-007] T-7 a refused submission is never stored`] }),
      coverage({
        criterionId: "REQ-008",
        testRefs: [
          T8,
          "visible/contact-api.test.mjs › [REQ-008] T-43 an accepted submission is readable back with the credential",
        ],
      }),
      coverage({ criterionId: "REQ-009", testRefs: [T12] }),
      coverage({
        criterionId: "REQ-020",
        testRefs: [
          T21,
          "visible/site-pages.spec.mjs › [REQ-020] T-48 images on the home and about pages keep their own aspect ratio at 768",
        ],
      }),
      coverage({
        criterionId: "REQ-021",
        outcome: "passed",
        testRefs: [
          `${IMAGES} › [REQ-021] T-22 nothing animates under prefers-reduced-motion`,
          "visible/site-pages.spec.mjs › [REQ-021] T-49 the about page runs no animation under reduced motion",
        ],
      }),
    ],
  });
}

/* ---- e1c15359 ------------------------------------------------------------
 *
 * `run-2026-08-12T13-20-15-745Z-e1c15359`: the same frozen suite as 047f9872
 * (`suite_sha256` 2e5a43a9…), the same four `APP_DIR` grader failures, PLUS one
 * real build defect. It is the sharpest fixture available, because one call must
 * return PIPELINE and ARTEFACT for different criteria of the SAME result.
 *
 * PROVENANCE, AND HALF OF IT IS RECONSTRUCTED. REQ-022's message and stack are
 * VERBATIM from `suite-report.json`, ANSI included. The seven boot failures are
 * RECONSTRUCTED exactly as 047f9872's are — this run's transcript truncates in
 * the same place — with the ports and log stamps carried over and the hour
 * changed to match. So the PIPELINE half of this test rests on reconstruction
 * and the ARTEFACT half does not; a reader should not have to diff two fixtures
 * to learn that. What the archive DOES record independently is the shape: the
 * same two files 0-for-4 and 0-for-3 with the same siblings green.
 */
const STYLE = "holdout/style-and-access.spec.mjs";
const T127 = `${STYLE} › [REQ-022] T-127 every page carries the paper background and the uppercase top navigation`;

const NAV_MESSAGE =
  "Error: the sketchbook shell is not consistent across the pages\n\n" +
  `${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived${ESC}[39m${ESC}[2m).${ESC}[22mtoEqual${ESC}[2m(${ESC}[22m${ESC}[32mexpected${ESC}[39m${ESC}[2m) // deep equality${ESC}[22m\n\n` +
  `${ESC}[32m- Expected  - 1${ESC}[39m\n${ESC}[31m+ Received  + 5${ESC}[39m\n\n` +
  `${ESC}[32m- Array []${ESC}[39m\n${ESC}[31m+ Array [${ESC}[39m\n` +
  `${ESC}[31m+   "/work: the navigation label \\"skip to the content\\" is not uppercase",${ESC}[39m\n` +
  `${ESC}[31m+ ]${ESC}[39m`;

function runE1c15359(): AdjudicationInput {
  const req022 = failure({
    titlePath: T127,
    runner: "playwright",
    criterionIds: ["REQ-022"],
    name: "PlaywrightError",
    message: NAV_MESSAGE,
    stack: `${NAV_MESSAGE}\n    at /scorer/suite/${STYLE}:69:79`,
  });
  return input({
    failures: [
      bootFailure(T108, ["REQ-006"], 39211, "2026-08-12T13_05_58_715Z", 153),
      bootFailure(T109, ["REQ-007"], 36389, "2026-08-12T13_06_43_897Z", 178),
      bootFailure(T110, ["REQ-009"], 41007, "2026-08-12T13_07_29_101Z", 203),
      bootFailure(T111, ["REQ-010"], 38553, "2026-08-12T13_08_14_402Z", 228),
      bootFailure(T207, ["REQ-006"], 44117, "2026-08-12T13_09_00_003Z", 61),
      bootFailure(T208, ["REQ-007"], 33802, "2026-08-12T13_09_45_610Z", 88),
      bootFailure(T209, ["REQ-009"], 40255, "2026-08-12T13_10_31_222Z", 115),
      req022,
    ],
    criterionCoverage: [
      ...RUN_047_PASSED,
      ...RUN_047_FAILED,
      coverage({ criterionId: "REQ-022", testRefs: [T127] }),
      coverage({
        criterionId: "REQ-023",
        tier: "QUALITY",
        outcome: "passed",
        testRefs: [
          `${STYLE} › [REQ-023] T-128 the four pages fit their viewport at 1440, 768 and 375`,
          `${STYLE} › [REQ-023] T-129 every project page fits a 375 pixel viewport`,
        ],
      }),
    ],
  });
}

/* =========================================================================
 * 1. THE THREE GROUND TRUTHS
 * ====================================================================== */

/**
 * 047f9872 is the acceptance test's conjunct 1 (design §9.3): the lane must WAKE
 * on it, "classifying it pipeline rather than artefact". Its artefact was
 * hand-verified correct afterwards, so every ARTEFACT verdict here would be a
 * grader bug hidden behind an honest-looking DID NOT PASS.
 *
 * MUTATIONS RUN: `verdictFrom` returns UNKNOWN where it returned PIPELINE (M2);
 * `for (const pattern of BOOT_FAILURE_PATTERNS.slice(0, 0))` (M21g); a
 * `Math.random()` note (M26). All three red here.
 */
test("047f9872: seven boot failures across two files are PIPELINE, and the lane wakes", () => {
  const result = adjudicate(run047f9872());

  for (const id of ["REQ-006", "REQ-007", "REQ-009", "REQ-010"]) {
    assert.equal(verdictOf(result.criteria, id).verdict, "PIPELINE", `${id} must be PIPELINE`);
  }
  assert.equal(result.wakeRepairLane, true);
  assert.equal(result.evidenceComplete, true);
  assert.deepEqual(result.notes, []);
  assert.equal(
    result.criteria.some((row) => row.verdict === "ARTEFACT"),
    false,
    "no criterion in a run whose artefact was hand-verified correct may be blamed on the build",
  );
  // The reason must name the cause, not the criterion: it is what the owner's
  // email says the lane is about to go and fix.
  assert.match(verdictOf(result.criteria, "REQ-006").reason, /package-script|Missing script/);
});

/**
 * The same run with the five unquotable messages withdrawn. This is the fixture
 * that proves the FILE-SHAPE rule carries real structure on its own: the three
 * `inbox-token` failures have no message, no stack, no code — nothing but the
 * fact that they are three failures in a file with no survivors while three
 * other files are green.
 *
 * IT ALSO RECORDS THE HONEST FLOOR. REQ-010 is asserted by ONE test in a file
 * whose signatures no longer agree, so it lands UNKNOWN. That is the module
 * declining to guess on evidence this session could not read, and it is the
 * difference between the two fixtures.
 *
 * MUTATIONS RUN: `void shape` in place of the `whole-file-one-cause` push (M27);
 * `void signatures` in place of the shared-signature guard (M9 — with it gone,
 * `messages-persistence`'s two reasonless rows are swept up too and REQ-010
 * stops being UNKNOWN, which is the honest floor collapsing);
 * `verdictFrom` never returning PIPELINE (M2). All three red here.
 */
test("047f9872, verified text only: the file shape alone classifies inbox-token", () => {
  const result = adjudicate(run047f9872VerifiedTextOnly());
  const req006 = verdictOf(result.criteria, "REQ-006");
  const t207 = req006.failures.find((row) => row.titlePath === T207);
  assert.ok(t207 !== undefined);
  assert.equal(t207.verdict, "PIPELINE");
  assert.deepEqual(
    t207.evidence.map((item) => item.signal),
    ["whole-file-one-cause"],
    "the ONLY evidence for this failure is the shape of its file",
  );
  assert.match(t207.reason, /file-level cause, not 3 independent defects/);
  assert.equal(verdictOf(result.criteria, "REQ-010").verdict, "UNKNOWN");
  assert.equal(result.wakeRepairLane, true);
});

/**
 * 6ec44b2f REQ-020 — image aspect ratios 1.2–1.8% out against a 1% tolerance.
 * A REAL BUILD DEFECT. If this comes back PIPELINE the repair lane wakes on a
 * working grader and starts editing the harness to make a true failure go away,
 * which is grader-softening with extra steps (design §1.1).
 *
 * The same call must ALSO leave the sqlite pair PIPELINE: the byte-grep looked
 * under `/opt/bakeoff-scorer, /opt, /app, /srv/app, /workspace` and found
 * nothing, which is the grader searching the wrong roots.
 *
 * MUTATIONS RUN: any non-empty message counts as pipeline (M1) → REQ-020 becomes
 * a conflict; `isSubstantiveComparison` returns true for any pair (M3) → the
 * sqlite `expected:"true"/actual:"false"` reads as the app answering and
 * REQ-004/REQ-009 flip to ARTEFACT; `ERR_ASSERTION` added to
 * `HARNESS_ERROR_CODES` (M11); the artefact grammars switched off (M24); the
 * file rule's push deleted (M27, which is what carries the sqlite pair). Five
 * mutations, all red here.
 */
test("6ec44b2f: REQ-020 is ARTEFACT while the sqlite byte-grep stays PIPELINE", () => {
  const result = adjudicate(run6ec44b2f());

  const req020 = verdictOf(result.criteria, "REQ-020");
  assert.equal(req020.verdict, "ARTEFACT");
  assert.notEqual(req020.verdict, "PIPELINE");
  assert.ok(
    req020.failures[0]?.evidence.some((item) => item.signal === "rendered-measurement"),
    "the reason it is ARTEFACT is that the page rendered something and it was measured",
  );

  assert.equal(verdictOf(result.criteria, "REQ-004").verdict, "PIPELINE");
  assert.equal(verdictOf(result.criteria, "REQ-009").verdict, "PIPELINE");
  // AN OPEN QUESTION PINNED AS A TEST, NOT A DIAGNOSIS.
  //
  // REQ-008 carries `expected 200 / actual 401` and the message "GET
  // /api/messages WITH THE CREDENTIAL answered 401", so on this evidence the app
  // was reached and answered — the task's own ARTEFACT discriminator — and
  // ARTEFACT is what this module must return. Design §1.2 counts REQ-008 among
  // "4 — WAL byte-grep", i.e. a grader defect.
  //
  // THE RECORD CANNOT SETTLE IT, AND THE GAP IS NAMED HERE SO NOBODY LATER READS
  // THIS ASSERTION AS A RULING. What the archive shows is a status the app
  // produced. What it does NOT show is whether the bearer value the test
  // presented was the one the harness was supposed to inject: if the harness
  // failed to supply it, the app refused CORRECTLY, the test failed correctly,
  // and the cause is a grader defect wearing an HTTP status. That is exactly the
  // "false ARTEFACT hides a grader bug" direction the header calls the more
  // expensive mistake.
  //
  // If a later lane resolves it in §1.2's favour, the fix is a NEW signal family
  // — a credential/environment-injection failure that outranks a bare status —
  // and this assertion changes with it. It is not evidence that the doc is
  // wrong; it is evidence that the record is thin.
  assert.equal(verdictOf(result.criteria, "REQ-008").verdict, "ARTEFACT");
});

/**
 * e1c15359 — the sharpest control in the archive. Same frozen suite as
 * 047f9872, same four grader failures, plus REQ-022 which is a real build
 * defect and which PASSED in the sibling run. ONE call, TWO answers.
 *
 * A classifier that returns a single verdict for a run cannot pass this test,
 * and a classifier that reads the run-level facts (exit code, false_finish,
 * stop reason — all identical between these two runs) cannot either. That is
 * design §12.3 as an executable assertion.
 *
 * MUTATIONS RUN: any non-empty message counts as pipeline (M1) → REQ-022 becomes
 * a conflict; `verdictFrom` never returns PIPELINE (M2) → the four grader
 * criteria collapse; the artefact grammars switched off (M24) → REQ-022 loses
 * the only evidence that says the page answered. All three red here.
 */
test("e1c15359: REQ-022 is ARTEFACT in the same result whose REQ-006 is PIPELINE", () => {
  const result = adjudicate(runE1c15359());
  assert.equal(verdictOf(result.criteria, "REQ-022").verdict, "ARTEFACT");
  assert.equal(verdictOf(result.criteria, "REQ-006").verdict, "PIPELINE");
  assert.equal(verdictOf(result.criteria, "REQ-007").verdict, "PIPELINE");
  assert.equal(verdictOf(result.criteria, "REQ-009").verdict, "PIPELINE");
  assert.equal(verdictOf(result.criteria, "REQ-010").verdict, "PIPELINE");
  assert.equal(result.wakeRepairLane, true, "the four grader failures still wake the lane");
  assert.ok(
    verdictOf(result.criteria, "REQ-022").failures[0]?.evidence.some((item) => item.signal === "matcher-comparison"),
  );
});

/**
 * THE ROUTER'S OTHER HALF, AND THE ONE §3A CARES ABOUT MOST: an ARTEFACT-only
 * result means the main workflow did its job and the lane must STAY ASLEEP.
 * e1c15359's REQ-022 alone, with its four sibling criteria removed.
 *
 * MUTATIONS RUN: `wakeRepairLane: true` unconditionally (M25); and every
 * mutation that turns this ARTEFACT into a PIPELINE — M1, M12b, M21h, M24 — each
 * of which wakes the lane on a run the main workflow had already handled.
 */
test("an artefact-only result does not wake the repair lane", () => {
  const full = runE1c15359();
  const req022 = full.suiteExecution.failures.filter((row) => row.criterionIds.includes("REQ-022"));
  const result = adjudicate(
    input({
      failures: req022,
      criterionCoverage: full.criterionCoverage.filter(
        (row) => row.outcome === "passed" || row.criterionId === "REQ-022",
      ),
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-022").verdict, "ARTEFACT");
  assert.equal(result.wakeRepairLane, false);
  assert.equal(result.runEvidence.length, 0);
});

/* =========================================================================
 * 2. THE ARCHIVE AS IT ACTUALLY IS — no `failures` field at all
 * ====================================================================== */

/**
 * Every archived `result.json` predates `suiteExecution.failures`, so what the
 * router is really handed for a 2026-08-12 run is SEVEN counted failures and
 * ZERO reasons. It must answer UNKNOWN and it must not wake the lane: a title
 * cannot distinguish "the app answered 401" from "npm had no start script"
 * (design §12.3), and guessing here is what the whole design forbids.
 *
 * MUTATIONS RUN: give a criterion with no charged failure the PIPELINE default
 * (M5) → all four wake the lane on a record that says nothing;
 * `wakeRepairLane: true` (M25). Both red here.
 *
 * NOTE ON A MUTATION THAT DOES *NOT* KILL THIS TEST, because the difference
 * matters: forcing `shapeRulesUsable = true` (M30) leaves this green, since with
 * an empty `failures` list there is no failure for a shape rule to reach. The
 * guard that protects THIS case is the criterion-level default, not the shape
 * gate — the truncated-list test below is where the shape gate is on trial.
 */
test("an archived result with no failure reasons is UNKNOWN, and sleeps", () => {
  const result = adjudicate(
    input({ failures: [], testsFailed: 7, criterionCoverage: [...RUN_047_PASSED, ...RUN_047_FAILED] }),
  );
  for (const id of ["REQ-006", "REQ-007", "REQ-009", "REQ-010"]) {
    assert.equal(verdictOf(result.criteria, id).verdict, "UNKNOWN", `${id} must be UNKNOWN`);
  }
  assert.equal(result.wakeRepairLane, false);
  assert.equal(result.evidenceComplete, false);
  assert.match(result.notes.join(" "), /7 test\(s\) failed but 0 reason\(s\) reached the record/);
});

/**
 * A TRUNCATED list is more dangerous than an empty one, because it looks whole.
 * `MAX_PERSISTED_FAILURES` caps the writer at 60 and a whole-file wipe-out is
 * exactly the shape that hits a cap. With rows missing, "no test in this file
 * passed" is read off a list that is missing rows, so the shape rules must be
 * off — here the four `messages-persistence` reasons are gone and only the three
 * reasonless `inbox-token` rows remain.
 *
 * MUTATIONS RUN: `const shapeRulesUsable = true` (M30) → the inbox-token three
 * are upgraded to PIPELINE by a file rule reading a partial list; the PIPELINE
 * default for a reasonless criterion (M5); `wakeRepairLane: true` (M25). All
 * three red here.
 */
test("a truncated failure list switches the shape rules off", () => {
  const result = adjudicate(
    input({
      failures: [
        failure({ titlePath: T207, criterionIds: ["REQ-006"] }),
        failure({ titlePath: T208, criterionIds: ["REQ-007"] }),
        failure({ titlePath: T209, criterionIds: ["REQ-009"] }),
      ],
      testsFailed: 7,
      criterionCoverage: [...RUN_047_PASSED, ...RUN_047_FAILED],
    }),
  );
  assert.equal(result.evidenceComplete, false);
  assert.equal(verdictOf(result.criteria, "REQ-006").verdict, "UNKNOWN");
  assert.equal(result.wakeRepairLane, false);
  assert.match(result.notes.join(" "), /7 test\(s\) failed but 3 reason\(s\) reached the record/);
});

/* =========================================================================
 * 3. THE FILE RULE'S FIVE GUARDS — one control each
 *
 * Every test here is SYNTHETIC and says so. They exist because the guards
 * protect against a shape no archived run happens to have: an artefact defect
 * in one endpoint that every test in a file depends on looks exactly like a
 * grader defect from the outside, and the guards are the only thing between
 * that and an unsupervised lane rewriting a working harness.
 * ====================================================================== */

const GREEN_SIBLING = coverage({
  criterionId: "REQ-100",
  outcome: "passed",
  testRefs: ["holdout/green.test.mjs › [REQ-100] T-1 the app boots", "holdout/green.test.mjs › [REQ-100] T-2 and answers"],
});

/**
 * GUARD 2 — one failing test in a file is not a shape, it is a failing test.
 *
 * MUTATIONS RUN: relax `row.failed < 2` to `row.failed < 1` (M7) → the single
 * failure is called a file-level cause; `wakeRepairLane: true` (M25). Both red.
 */
test("file rule: a single failure in a file is not a file-level cause", () => {
  const result = adjudicate(
    input({
      failures: [failure({ titlePath: "holdout/lonely.test.mjs › [REQ-200] T-9 something", criterionIds: ["REQ-200"] })],
      criterionCoverage: [
        GREEN_SIBLING,
        coverage({ criterionId: "REQ-200", testRefs: ["holdout/lonely.test.mjs › [REQ-200] T-9 something"] }),
      ],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-200").verdict, "UNKNOWN");
  assert.equal(result.wakeRepairLane, false);
});

/**
 * GUARD 3 — a test in the same file that PASSED proves the file's harness ran,
 * so whatever killed the others is not a file-level cause.
 *
 * MUTATION RUN: drop `row.passedKnown > 0` from `fileLevelCause` (M6) → the two
 * failures are called a file-level cause and this test goes red. It is the only
 * mutation in the set that kills this test, which is what makes it the control
 * for that clause specifically.
 */
test("file rule: a passing sibling TEST in the same file blocks it", () => {
  const failing = [
    failure({ titlePath: "holdout/mixed.test.mjs › [REQ-201] T-1 alpha", criterionIds: ["REQ-201"] }),
    failure({ titlePath: "holdout/mixed.test.mjs › [REQ-201] T-2 beta", criterionIds: ["REQ-201"] }),
  ];
  const result = adjudicate(
    input({
      failures: failing,
      criterionCoverage: [
        GREEN_SIBLING,
        coverage({
          criterionId: "REQ-201",
          testRefs: [...failing.map((row) => row.titlePath), "holdout/mixed.test.mjs › [REQ-201] T-3 gamma"],
        }),
      ],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-201").verdict, "UNKNOWN");
});

/**
 * GUARD 4 — if every file is red, "this file is special" is not a claim the
 * evidence supports. A run where nothing at all worked is far more likely to be
 * an artefact that never built than a per-file grader defect, and either way the
 * shape says nothing.
 *
 * MUTATIONS RUN: return the evidence anyway when `greenSibling === undefined`
 * (M8) → both files are called file-level causes; `wakeRepairLane: true` (M25).
 * Both red.
 */
test("file rule: with no fully green sibling file, the shape says nothing", () => {
  const rows = [
    failure({ titlePath: "holdout/a.test.mjs › [REQ-202] T-1 alpha", criterionIds: ["REQ-202"] }),
    failure({ titlePath: "holdout/a.test.mjs › [REQ-202] T-2 beta", criterionIds: ["REQ-202"] }),
    failure({ titlePath: "holdout/b.test.mjs › [REQ-203] T-3 gamma", criterionIds: ["REQ-203"] }),
    failure({ titlePath: "holdout/b.test.mjs › [REQ-203] T-4 delta", criterionIds: ["REQ-203"] }),
  ];
  const result = adjudicate(
    input({
      failures: rows,
      criterionCoverage: [
        coverage({ criterionId: "REQ-202", testRefs: [rows[0]?.titlePath ?? "", rows[1]?.titlePath ?? ""] }),
        coverage({ criterionId: "REQ-203", testRefs: [rows[2]?.titlePath ?? "", rows[3]?.titlePath ?? ""] }),
      ],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-202").verdict, "UNKNOWN");
  assert.equal(verdictOf(result.criteria, "REQ-203").verdict, "UNKNOWN");
  assert.equal(result.wakeRepairLane, false);
});

/**
 * GUARD 5 — three different reasons in one file are three defects that share an
 * address, not one cause. The signature erases digits so that 047f9872's four
 * ephemeral port numbers still count as one cause; it must not erase so much
 * that genuinely different messages collapse together.
 *
 * MUTATIONS RUN: `void signatures` in place of the `signatures.size !== 1` check
 * (M9) → three unrelated failures are called one cause; the over-eager
 * classifier (M1) and a family widened to `/./` (M21h), both of which make the
 * three "pipeline" for a different wrong reason. All three red.
 */
test("file rule: failures that do not share a cause signature are not one cause", () => {
  const rows = [
    failure({ titlePath: "holdout/varied.test.mjs › [REQ-204] T-1 alpha", criterionIds: ["REQ-204"], message: "the widget list was empty" }),
    failure({ titlePath: "holdout/varied.test.mjs › [REQ-204] T-2 beta", criterionIds: ["REQ-204"], message: "the heading had no text" }),
    failure({ titlePath: "holdout/varied.test.mjs › [REQ-204] T-3 gamma", criterionIds: ["REQ-204"], message: "the footer carried no links" }),
  ];
  const result = adjudicate(
    input({
      failures: rows,
      criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-204", testRefs: rows.map((row) => row.titlePath) })],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-204").verdict, "UNKNOWN");
});

/**
 * GUARD 6 — THE DANGEROUS ONE, and the one no archived run exercises.
 *
 * A build defect in a single endpoint that every test in a file depends on
 * produces the file rule's exact silhouette: whole file red, siblings green, one
 * shared cause. The only thing that distinguishes it is that the app ANSWERED —
 * `expected 200 / actual 500` — for at least one of them. Without this guard,
 * the two failures that carry no reason of their own are swept up with the
 * evidenced ones and a broken build wakes the repair lane.
 *
 * SYNTHETIC, and deliberately so: the shape is absent from the archive, which is
 * why it needs a fixture rather than a comment.
 *
 * THE FIXTURE IS BUILT SO THAT GUARD 6 IS THE ONLY THING STANDING. All four
 * failures share one cause signature — same class, same code, same first line —
 * so guard 5 passes; the file has no survivors, so guard 3 passes; a green
 * sibling exists, so guard 4 passes. Two of the four ALSO carry `expected 200 /
 * actual 500`, which is the app answering. An earlier draft of this fixture gave
 * the reasonless rows a different message and guard 5 blocked the rule first,
 * which made this test pass with guard 6 deleted — the mutation run caught it,
 * and it is exactly the "the control never controlled anything" defect.
 *
 * MUTATIONS RUN: `void fileHasArtefactEvidence` in place of the early return
 * (M4) → the two reasonless failures become PIPELINE and a broken build wakes
 * the lane; also M1, M11, M21h and M25, each of which reaches the same wrong
 * answer down a different path.
 */
test("file rule: one answering test in the file protects the whole file from the shape rule", () => {
  const shared = {
    name: "AssertionError",
    code: "ERR_ASSERTION",
    message: "the order list did not come back as submitted",
  } as const;
  const answered = (title: string, id: string): AdjudicableFailure =>
    failure({ titlePath: title, criterionIds: [id], ...shared, operator: "strictEqual", expected: "200", actual: "500" });
  const silent = (title: string, id: string): AdjudicableFailure =>
    failure({ titlePath: title, criterionIds: [id], ...shared });
  const rows = [
    answered("holdout/orders.test.mjs › [REQ-205] T-1 an order is accepted", "REQ-205"),
    answered("holdout/orders.test.mjs › [REQ-206] T-2 an order reads back", "REQ-206"),
    silent("holdout/orders.test.mjs › [REQ-207] T-3 an order is listed", "REQ-207"),
    silent("holdout/orders.test.mjs › [REQ-208] T-4 an order is removed", "REQ-208"),
  ];
  const result = adjudicate(
    input({
      failures: rows,
      criterionCoverage: [
        GREEN_SIBLING,
        ...rows.map((row, index) =>
          coverage({ criterionId: `REQ-2${String(index + 5).padStart(2, "0")}`, testRefs: [row.titlePath] }),
        ),
      ],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-205").verdict, "ARTEFACT");
  assert.equal(verdictOf(result.criteria, "REQ-207").verdict, "UNKNOWN", "no reason of its own, and its file answered");
  assert.equal(verdictOf(result.criteria, "REQ-208").verdict, "UNKNOWN");
  assert.equal(result.wakeRepairLane, false, "a broken build must not wake the repair lane");
});

/**
 * GUARD 1' — the pass census is assembled from `testRefs`, which the scorer caps
 * at 10 per criterion (`scorer-container.ts:1299`). At the cap the census is
 * PROVABLY short, so "no test in this file passed" is no longer supportable and
 * the shape rules must switch off rather than run on a partial picture.
 *
 * MUTATIONS RUN: `>= 10` becomes `>= 11` (M10); `shapeRulesUsable = true`, which
 * drops `refCapHit` with it (M30). Both red: the two reasonless failures become
 * PIPELINE on a census that is known to be short.
 */
test("file rule: a criterion at the testRefs cap disables the shape rules", () => {
  const capped = coverage({
    criterionId: "REQ-300",
    outcome: "passed",
    testRefs: Array.from({ length: 10 }, (_unused, i) => `holdout/wide.test.mjs › [REQ-300] T-${i} case ${i}`),
  });
  const rows = [
    failure({ titlePath: "holdout/narrow.test.mjs › [REQ-301] T-1 alpha", criterionIds: ["REQ-301"] }),
    failure({ titlePath: "holdout/narrow.test.mjs › [REQ-301] T-2 beta", criterionIds: ["REQ-301"] }),
  ];
  const result = adjudicate(
    input({
      failures: rows,
      criterionCoverage: [capped, coverage({ criterionId: "REQ-301", testRefs: rows.map((row) => row.titlePath) })],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-301").verdict, "UNKNOWN");
  assert.match(result.notes.join(" "), /pass census is incomplete/);
});

/* =========================================================================
 * 4. PER-FAILURE SIGNALS, EACH WITH THE CONTROL THAT KEEPS IT HONEST
 * ====================================================================== */

/**
 * An OS/module/socket code means the test process could not do its job. The
 * CONTROL is the second half: `ERR_ASSERTION` must NOT be in that set, because
 * all seven of 047f9872's grader-caused failures carry it and so do both real
 * build defects — a classifier that read the error class would be right by
 * accident on some runs and wrong on the most important one.
 *
 * MUTATIONS RUN: `"ERR_ASSERTION"` added to `HARNESS_ERROR_CODES` (M11) → the
 * control half goes red, and so does the 6ec44b2f ground truth;
 * `HARNESS_ERROR_CODES.slice(0, 0)` (M28) → the first half goes red.
 */
test("a harness error code is PIPELINE; ERR_ASSERTION on its own is not", () => {
  const withCode = (code: string): AdjudicationInput =>
    input({
      failures: [failure({ titlePath: "holdout/boot.test.mjs › [REQ-400] T-1 imports", criterionIds: ["REQ-400"], code })],
      criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-400", testRefs: ["holdout/boot.test.mjs › [REQ-400] T-1 imports"] })],
    });

  assert.equal(verdictOf(adjudicate(withCode("ERR_MODULE_NOT_FOUND")).criteria, "REQ-400").verdict, "PIPELINE");
  assert.equal(verdictOf(adjudicate(withCode("ENOENT")).criteria, "REQ-400").verdict, "PIPELINE");
  assert.equal(
    verdictOf(adjudicate(withCode("ERR_ASSERTION")).criteria, "REQ-400").verdict,
    "UNKNOWN",
    "the error CLASS is not the discriminator — see 047f9872, whose grader defect is an AssertionError",
  );
});

/**
 * EVERY boot-failure family, one fixture each, plus the control.
 *
 * WHY EACH FAMILY NEEDS ITS OWN ROW. The table has six entries and 047f9872
 * exercises two of them (`package-script` and `boot-timeout`). A first mutation
 * run deleted the `module-resolution` family and the whole suite stayed GREEN —
 * a pattern no test can miss is a pattern nobody has seen fire, which is
 * `probe-needs-negative-control` pointed at a regex table. So each family is
 * asserted through the public function with a message of the kind it exists for.
 *
 * THE CONTROL IS THE LAST ROW: ordinary prose about the page's contents matches
 * no family and stays UNKNOWN. Without it, a family widened to `/./` would pass
 * every row above.
 *
 * MUTATIONS RUN: each of the six families neutered in turn to a pattern that
 * matches nothing (M21a–M21f) — every one of them turns this test red on its own
 * row and leaves the rest of the suite alone, which is what proves the six are
 * six and not one written six times. `BOOT_FAILURE_PATTERNS.slice(0, 0)` (M21g)
 * takes the whole table out. Widening one family to `/./` (M21h) turns the
 * CONTROL row red.
 */
test("each boot-failure family is recognised, and ordinary prose is not", () => {
  /*
   * TWO ARMS, ADDED 2026-08-16. Four of these families mean "the app was never
   * REACHED" and are unconditional; two mean "the app stopped answering" and are
   * only pipeline evidence when nothing in the run ever saw it answer.
   *
   * The narrowing exists because an artefact that HANGS OR CRASHES mid-suite was
   * producing a decisive PIPELINE verdict and waking the unsupervised repair
   * lane — against a working pipeline and a broken website. This test used to
   * assert that behaviour, with a fixture that carried a passing sibling.
   *
   * MUTATION: add "connection-refused" and "boot-timeout" to
   * UNCONDITIONAL_BOOT_FAMILIES -> the `appAnswered` arm goes RED. Remove
   * "package-script" from it -> the run-047f9872 tests above go RED, which is
   * the pair that keeps the narrowing honest.
   */
  const families: readonly { readonly family: string; readonly message: string; readonly conditional: boolean }[] = [
    { family: "module-resolution", message: "Cannot find module '/artifact/server.mjs' imported from /scorer/suite", conditional: false },
    { family: "package-script", message: 'npm error Missing script: "start"', conditional: false },
    { family: "process-spawn", message: "spawn npm ENOENT", conditional: false },
    { family: "browser-launch", message: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium", conditional: false },
    { family: "connection-refused", message: "connect ECONNREFUSED 127.0.0.1:41455", conditional: true },
    { family: "boot-timeout", message: "the app did not answer /api/health within 45s", conditional: true },
  ];
  const title = "holdout/boot-family.test.mjs \u203a [REQ-405] T-1 case";
  const run = (message: string, appAnswered: boolean): string =>
    verdictOf(
      adjudicate(
        input({
          failures: [failure({ titlePath: title, criterionIds: ["REQ-405"], message })],
          criterionCoverage: appAnswered
            ? [GREEN_SIBLING, coverage({ criterionId: "REQ-405", testRefs: [title] })]
            : [coverage({ criterionId: "REQ-405", testRefs: [title] })],
        }),
      ).criteria,
      "REQ-405",
    ).verdict;

  // ARM 1 — nothing in the run ever answered. Every family is the harness.
  for (const row of families) {
    assert.equal(run(row.message, false), "PIPELINE", `${row.family} with no passing criterion`);
  }

  // ARM 2 — a sibling criterion PASSED, so the app demonstrably answered.
  for (const row of families) {
    assert.equal(
      run(row.message, true),
      row.conditional ? "UNKNOWN" : "PIPELINE",
      `${row.family} once the app is known to have answered: a "stopped responding" message is then an app ` +
        "that died mid-suite just as easily as a harness that lost it, and neither side may be charged",
    );
  }

  // CONTROL — ordinary prose is not a boot failure under either arm.
  assert.equal(run("the about page carried no biography paragraph", false), "UNKNOWN");
  assert.equal(run("the about page carried no biography paragraph", true), "UNKNOWN");
});

/**
 * A frame inside the scorer's own install is the grader's code failing, not the
 * artefact's. The CONTROL is that a frame inside the mounted SUITE is not that
 * signal: `/scorer/suite` is the frozen test, and a test failing at its own
 * assertion line is the ordinary case, not evidence of anything.
 *
 * MUTATIONS RUN: read the MESSAGE instead of the parsed frames (M12) → the first
 * half goes red, and 6ec44b2f's sqlite failures pick the signal up for the wrong
 * reason, since their message NAMES `/opt/bakeoff-scorer` as a search root while
 * the failure happens at a suite frame. Widen the match to `/scorer` (M12b) →
 * the CONTROL half goes red, because the mounted suite lives under `/scorer`
 * too. One mutation per half, which is what a two-sided test owes.
 */
test("a stack frame under the scorer's install is PIPELINE; a suite frame is not that signal", () => {
  const withStack = (stack: string): AdjudicationInput =>
    input({
      failures: [failure({ titlePath: "holdout/x.test.mjs › [REQ-401] T-1 case", criterionIds: ["REQ-401"], stack })],
      criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-401", testRefs: ["holdout/x.test.mjs › [REQ-401] T-1 case"] })],
    });

  const inScorer = adjudicate(
    withStack("Error: boom\n    at collect (/opt/bakeoff-scorer/scorer-container.js:1218:9)\n    at async Test.run (node:internal/test_runner/test:1332:7)"),
  );
  const row = verdictOf(inScorer.criteria, "REQ-401");
  assert.equal(row.verdict, "PIPELINE");
  assert.ok(row.failures[0]?.evidence.some((item) => item.signal === "scorer-install-frame"));

  const inSuite = adjudicate(withStack("Error: boom\n    at /scorer/suite/holdout/x.test.mjs:44:7"));
  assert.equal(
    verdictOf(inSuite.criteria, "REQ-401").failures[0]?.evidence.some((item) => item.signal === "scorer-install-frame"),
    false,
  );
});

/**
 * The last resort before UNKNOWN: raised inside a helper the test called, rather
 * than at an assertion in the test body. This is the 047f9872 frame shape
 * (`at startServer (…messages-persistence.test.mjs:116:12)`) reached WITHOUT the
 * message, so the rule is exercised on its own rather than shadowed by the boot
 * grammar.
 *
 * THE CONTROL IS THE SECOND HALF and it is what stops this rule swallowing
 * everything: an assertion in the test body — Playwright's bare
 * `at /scorer/suite/…:78:100`, node:test's `TestContext.<anonymous>` — is NOT a
 * helper frame, and a failure with nothing else stays UNKNOWN.
 *
 * MUTATIONS RUN: `void TEST_BODY_FRAME_NAMES` in place of the body-name check
 * (M13) → `TestContext.<anonymous>` is called a helper and the control goes red;
 * treat a BARE frame as a helper too (M13b) → Playwright's assertion frame is
 * called a helper and the third assertion goes red.
 */
test("a helper frame is the last-resort PIPELINE signal; a test-body frame is not", () => {
  const withStack = (stack: string): AdjudicationInput =>
    input({
      failures: [failure({ titlePath: "holdout/y.test.mjs › [REQ-402] T-1 case", criterionIds: ["REQ-402"], stack })],
      criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-402", testRefs: ["holdout/y.test.mjs › [REQ-402] T-1 case"] })],
    });

  const helper = adjudicate(
    withStack("Error\n    at startServer (file:///scorer/suite/holdout/y.test.mjs:116:12)\n    at async TestContext.<anonymous> (file:///scorer/suite/holdout/y.test.mjs:153:17)"),
  );
  assert.equal(verdictOf(helper.criteria, "REQ-402").verdict, "PIPELINE");
  assert.ok(verdictOf(helper.criteria, "REQ-402").failures[0]?.evidence.some((item) => item.signal === "suite-helper-frame"));

  const body = adjudicate(
    withStack("Error\n    at async TestContext.<anonymous> (file:///scorer/suite/holdout/y.test.mjs:153:17)\n    at async Test.run (node:internal/test_runner/test:1332:7)"),
  );
  assert.equal(verdictOf(body.criteria, "REQ-402").verdict, "UNKNOWN");

  const playwrightBody = adjudicate(withStack("Error: nope\n    at /scorer/suite/holdout/y.spec.mjs:78:100"));
  assert.equal(verdictOf(playwrightBody.criteria, "REQ-402").verdict, "UNKNOWN");
});

/**
 * `assert.ok(x)` renders `expected:"true", actual:"false"` — a comparison in
 * shape and nothing in content. Unit-level, because this predicate is what keeps
 * a documented GRADER defect (6ec44b2f's byte-grep) out of the build lane.
 *
 * MUTATION RUN: `return true` after the null check (M3) → the four degenerate
 * pairs below report true, this test goes red, and so does the 6ec44b2f ground
 * truth, which is the same defect seen from the other end.
 */
test("a boolean assert pair is not a comparison; a status pair is", () => {
  assert.equal(isSubstantiveComparison("true", "false"), false);
  assert.equal(isSubstantiveComparison("false", "true"), false);
  assert.equal(isSubstantiveComparison("undefined", "null"), false);
  assert.equal(isSubstantiveComparison("", ""), false);
  assert.equal(isSubstantiveComparison("200", "401"), true);
  assert.equal(isSubstantiveComparison("true", "the header was missing"), true);
  assert.equal(isSubstantiveComparison(null, "401"), false, "one value is not a comparison");
});

/**
 * A failure that shows BOTH a dead harness and an answering app is a
 * contradiction, and the honest answer is UNKNOWN. Picking a side here is
 * exactly the guess the design forbids, and the direction of the guess decides
 * whether a broken build gets a repair agent or a broken grader gets ignored.
 *
 * MUTATIONS RUN: `verdictFrom` returns PIPELINE on a conflict (M17);
 * `wakeRepairLane: true` (M25); and — the interesting one — neutering the
 * `connection-refused` family (M21d) or the whole boot table (M21g), which
 * removes the contradiction and lets this failure read as a clean ARTEFACT.
 */
test("contradictory evidence is UNKNOWN, not a coin toss", () => {
  const result = adjudicate(
    input({
      failures: [
        failure({
          titlePath: "holdout/z.test.mjs › [REQ-403] T-1 case",
          criterionIds: ["REQ-403"],
          message: "connect ECONNREFUSED 127.0.0.1:3000 after the app answered 500 once",
          expected: "200",
          actual: "500",
        }),
      ],
      /*
       * NO PASSING SIBLING, ADDED 2026-08-16. With one, the app is known to have
       * answered, `connection-refused` is no longer pipeline evidence, and the
       * contradiction this test exists for does not arise — the verdict is then
       * ARTEFACT, correctly. The contradiction is real only when nothing in the
       * run answered AND the failure still shows the app responding, which is
       * the fixture below.
       */
      criterionCoverage: [coverage({ criterionId: "REQ-403", testRefs: ["holdout/z.test.mjs › [REQ-403] T-1 case"] })],
    }),
  );
  const row = verdictOf(result.criteria, "REQ-403");
  assert.equal(row.verdict, "UNKNOWN");
  assert.match(row.failures[0]?.reason ?? "", /contradicts itself/);
  assert.equal(result.wakeRepairLane, false);
});

/**
 * A criterion asserted by two tests that disagree about whose fault it is
 * cannot be routed: both may be true at once. The criterion-level rule is
 * separate code from the per-failure one and needs its own control.
 *
 * MUTATIONS RUN: the mixed arm resolves to PIPELINE instead of UNKNOWN (M18);
 * `wakeRepairLane: true` (M25); `HARNESS_ERROR_CODES.slice(0, 0)` (M28), which
 * removes the pipeline half and lets the criterion read as a clean ARTEFACT.
 */
test("a criterion whose tests disagree is UNKNOWN", () => {
  const titles = ["holdout/mix.test.mjs › [REQ-404] T-1 boots", "visible/mix2.test.mjs › [REQ-404] T-2 answers"];
  const result = adjudicate(
    input({
      failures: [
        failure({ titlePath: titles[0] ?? "", criterionIds: ["REQ-404"], code: "ERR_MODULE_NOT_FOUND" }),
        failure({ titlePath: titles[1] ?? "", criterionIds: ["REQ-404"], expected: "200", actual: "500" }),
      ],
      criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-404", testRefs: titles })],
    }),
  );
  const row = verdictOf(result.criteria, "REQ-404");
  assert.equal(row.verdict, "UNKNOWN");
  assert.match(row.reason, /1 test\(s\) show a dead harness and 1 show the app answering/);
  assert.equal(result.wakeRepairLane, false);
});

/* =========================================================================
 * 5. RUN-LEVEL FACTS
 * ====================================================================== */

/**
 * `infrastructureErrors` is the container saying its own machinery broke. It is
 * a pipeline defect whether or not a criterion failed, so it must wake the lane
 * on its own — a scorer that could not launch a browser and therefore failed
 * nothing is the quietest possible false finish.
 *
 * MUTATION RUN: drop `runEvidence.length > 0` from `wakeRepairLane` (M16) → the
 * lane sleeps through a scorer that could not run, and this test goes red. It is
 * the only mutation in the set that kills it.
 */
test("a scorer infrastructure error wakes the lane with no failing criterion at all", () => {
  const result = adjudicate(
    input({
      failures: [],
      criterionCoverage: [GREEN_SIBLING],
      infrastructureErrors: ["chromium failed to launch: missing shared library libnss3.so"],
    }),
  );
  assert.deepEqual(result.criteria, []);
  assert.equal(result.wakeRepairLane, true);
  assert.equal(result.runEvidence[0]?.signal, "scorer-infrastructure-error");
});

/**
 * A criterion no test asserts is a GRADER failure by construction: the suite is
 * frozen before the build runs, so nothing the builder did could remove a test
 * that was never written. The second half is the triage detail that matters —
 * "unasserted because the report did not parse" is the same verdict for a
 * completely different reason, and a repair agent handed the wrong one goes
 * looking for a missing test that exists.
 *
 * MUTATIONS RUN: return UNKNOWN for `unasserted` (M19) → the first half goes red;
 * collapse the two reason strings into the "no test carries it" one (M29) → the
 * second goes red.
 */
test("an unasserted criterion is PIPELINE, and says which kind", () => {
  const clean = adjudicate(input({ failures: [], criterionCoverage: [coverage({ criterionId: "REQ-500", outcome: "unasserted" })] }));
  const row = verdictOf(clean.criteria, "REQ-500");
  assert.equal(row.verdict, "PIPELINE");
  assert.match(row.reason, /no test in the frozen suite carries REQ-500/);
  assert.equal(clean.wakeRepairLane, true);

  const unparsed = adjudicate(
    input({
      failures: [],
      testsFailed: null,
      reportProblem: "no machine-readable report at /scorer/out/suite-report.json",
      criterionCoverage: [coverage({ criterionId: "REQ-500", outcome: "unasserted" })],
    }),
  );
  assert.match(verdictOf(unparsed.criteria, "REQ-500").reason, /looks unasserted because no report parsed/);
  assert.ok(unparsed.runEvidence.some((item) => item.signal === "no-machine-readable-report"));
});

/**
 * A criterion that failed with no reason in the record, in a run that otherwise
 * looks fine, is UNKNOWN — but the SAME criterion in a run whose report never
 * parsed is PIPELINE, because "nothing was measured" is itself the harness
 * failing. Two arms, one branch, and the second is the one an archived record
 * cannot reach.
 *
 * MUTATIONS RUN, ONE PER ARM: return PIPELINE in both arms (M5) → the first
 * assertion goes red and an archived record starts waking the lane; return
 * UNKNOWN in both arms (M31) → the second goes red and a run that measured
 * nothing is filed as inconclusive rather than as a harness failure. Also
 * `wakeRepairLane: true` (M25).
 */
test("a reasonless failing criterion is UNKNOWN, unless nothing was measured at all", () => {
  const quiet = adjudicate(input({ failures: [], testsFailed: 1, criterionCoverage: [coverage({ criterionId: "REQ-501" })] }));
  assert.equal(verdictOf(quiet.criteria, "REQ-501").verdict, "UNKNOWN");
  assert.equal(quiet.wakeRepairLane, false);

  const unmeasured = adjudicate(
    input({
      failures: [],
      testsFailed: null,
      reportProblem: "report root is not an object",
      criterionCoverage: [coverage({ criterionId: "REQ-501" })],
    }),
  );
  assert.equal(verdictOf(unmeasured.criteria, "REQ-501").verdict, "PIPELINE");
  assert.equal(unmeasured.wakeRepairLane, true);
});

/* =========================================================================
 * 6. HYGIENE — the small things that make the output usable and correct
 * ====================================================================== */

/**
 * Playwright's `message` carries ANSI colour verbatim and the container copies
 * it unchanged, so the escapes reach this module and would reach the owner's
 * email through {@link Evidence.detail}.
 *
 * MUTATION: make `stripAnsi` the identity → the e1c15359 fixture's evidence
 * detail carries `ESC[2m` and this test goes red.
 */
test("evidence detail is free of terminal escapes", () => {
  const result = adjudicate(runE1c15359());
  const details = result.criteria.flatMap((row) => [...row.evidence, ...row.failures.flatMap((f) => f.evidence)]).map((item) => item.detail);
  assert.ok(details.length > 0);
  for (const detail of details) assert.equal(detail.includes(ESC), false, `escape sequence survived into: ${detail}`);
});

/**
 * `testRefs` is capped at 200 characters and `titlePath` at 300, so one long
 * title arrives cut in one place and whole in the other. Compared naively, the
 * ref would not match the failure and the census would count a FAILING test as
 * a passing sibling — silently switching the file rule off (or, with the
 * polarity reversed one day, on).
 *
 * MUTATION RUN: widen `titleKey`'s window past the writer's cap —
 * `slice(0, 150)` becomes `slice(0, 250)` (M15) → the 200-character ref stops
 * matching the 254-character failure, `passedKnown` becomes 1, the file looks
 * like it had a survivor and the verdict falls to UNKNOWN. Red.
 */
test("a title truncated by one writer and not the other is still one test", () => {
  const long = `holdout/long.test.mjs › [REQ-600] T-1 ${"a very long title ".repeat(12)}`;
  const rows = [
    failure({ titlePath: long, criterionIds: ["REQ-600"] }),
    failure({ titlePath: "holdout/long.test.mjs › [REQ-600] T-2 short", criterionIds: ["REQ-600"] }),
  ];
  const result = adjudicate(
    input({
      failures: rows,
      criterionCoverage: [
        GREEN_SIBLING,
        coverage({
          criterionId: "REQ-600",
          // The writer's cap, applied exactly as `scorer-container.ts:1299` does.
          testRefs: [`${long.slice(0, 200)}… (${long.length - 200} more characters)`, "holdout/long.test.mjs › [REQ-600] T-2 short"],
        }),
      ],
    }),
  );
  assert.equal(verdictOf(result.criteria, "REQ-600").verdict, "PIPELINE", "both rows are failures, so the file has no survivors");
});

/**
 * A failure whose `criterionIds` is empty is not dropped: it is charged through
 * `testRefs` when the coverage row names it, and reported as unattributed when
 * nothing does. A failing test that carries no criterion id is invisible to
 * `criterionCoverage` entirely, and it is the one most likely to BE the suite
 * defect (`collectFailures`' own docblock says so).
 *
 * MUTATIONS RUN: drop the `refKeys.has(...)` half of the charging rule (M23) →
 * REQ-700 loses its failure and reads as "no reason reached this record";
 * `unattributedFailures.slice(0, 0)` (M22) → the orphan disappears silently.
 * Both red.
 */
test("an untagged failure is charged by testRefs, or reported as unattributed", () => {
  const tagged = "holdout/untagged.test.mjs › T-1 the thing works";
  const orphan = "holdout/untagged.test.mjs › T-2 nobody claims this";
  const result = adjudicate(
    input({
      failures: [
        failure({ titlePath: tagged, message: "connect ECONNREFUSED 127.0.0.1:3000" }),
        failure({ titlePath: orphan, message: "connect ECONNREFUSED 127.0.0.1:3000" }),
      ],
      criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-700", testRefs: [tagged] })],
    }),
  );
  const row = verdictOf(result.criteria, "REQ-700");
  assert.equal(row.failures.length, 1);
  assert.equal(row.verdict, "PIPELINE");
  assert.deepEqual(
    result.unattributedFailures.map((entry) => entry.titlePath),
    [orphan],
  );
});

/**
 * The file segment is what every shape rule is keyed on. A nested Playwright
 * `describe()` title must not be mistaken for a filename, or two halves of one
 * file's failures land in different buckets and the file rule stops seeing a
 * whole file.
 *
 * MUTATION RUN: drop the extension test from `fileOfTitlePath` (M20) → the last
 * two assertions go red. Only that mutation kills this test, which is what makes
 * it the control for that clause.
 */
test("the file segment is the leading path with a source extension, or nothing", () => {
  assert.equal(fileOfTitlePath(T108), "holdout/messages-persistence.test.mjs");
  assert.equal(fileOfTitlePath(`${IMAGES} › with reduced motion › [REQ-019] T-122 nothing animates`), IMAGES);
  assert.equal(fileOfTitlePath("with reduced motion › [REQ-019] T-122 nothing animates"), null);
  assert.equal(fileOfTitlePath("[REQ-006] T-108 a blank message is refused"), null);
});

/**
 * The header claims no filesystem, no clock, no network. The cheapest way to
 * keep that claim true is to assert that two calls on the same input are deeply
 * equal — a clock or a random tiebreak shows up here immediately.
 *
 * MUTATION RUN: seed `notes` with `String(Math.random())` (M26) → red here and,
 * loudly, on the 047f9872 ground truth, which asserts the notes are empty.
 */
test("the same result adjudicates identically twice", () => {
  assert.deepEqual(adjudicate(run6ec44b2f()), adjudicate(run6ec44b2f()));
  assert.deepEqual(adjudicate(run047f9872()), adjudicate(run047f9872()));
});

/* =========================================================================
 * A SUITE THAT NEVER RAN IS NOT A PIPELINE DEFECT
 *
 * Added 2026-08-16 after an adversarial review found the module over-firing on
 * a REAL archived record, and after the fix was measured to pass the whole
 * existing suite unchanged — i.e. the 28 tests above could not observe it.
 *
 * THE DEFECT, reproduced against
 * `dashboard/results/scorer-out/run-2026-07-30T20-16-40-242Z-052c6e02/result.json`:
 *
 *     before   {"PIPELINE": 16}   wakeRepairLane: true
 *     after    {"UNKNOWN": 16}    wakeRepairLane: false
 *
 * When the app never boots, `runFrozenSuite` (scorer-container.ts:1634) writes
 * `reportProblem: "the app never booted…"`, `testsFailed: null`, and the scorer
 * marks EVERY criterion `unasserted`. Reading that word as "no test carries this
 * token" charged sixteen criteria to the pipeline on a run whose artefact served
 * no root document — the purest ARTEFACT defect there is, which design §3A gives
 * to the main workflow. An unsupervised lane would have woken to patch the
 * machine over a website that does not run.
 *
 * WHY UNKNOWN AND NOT ARTEFACT: "the app never booted" does not say whose fault
 * that is. The build may be broken, or the frozen manifest may have declared no
 * start command — which is the spec seat, i.e. the pipeline. The field cannot
 * separate them, so neither side is charged.
 * ====================================================================== */

/** The three literals `scorer-container.ts` writes when the suite never ran. */
const NEVER_RAN = [
  "the app never booted, so the frozen suite was not executed",
  "the scorer's total time budget was exhausted before the frozen suite could run",
  "the scorer aborted before executing the suite",
] as const;

/** The 052c6e02 shape: no outcomes at all, every criterion `unasserted`. */
function suiteNeverRan(reportProblem: string): AdjudicationInput {
  return input({
    failures: [],
    testsFailed: null,
    reportProblem,
    criterionCoverage: [
      coverage({ criterionId: "REQ-001", outcome: "unasserted", tier: "BLOCKING" }),
      coverage({ criterionId: "REQ-002", outcome: "unasserted", tier: "FUNCTIONAL" }),
    ],
  });
}

/**
 * MUTATION: delete the `if (undecidableSuiteOutcome)` arm in `adjudicate`'s
 * `unasserted` branch, so it falls through to the unconditional PIPELINE. Both
 * assertions go RED. This is the exact code state the review found.
 */
test("a suite that never ran charges NEITHER side, and the lane stays asleep", () => {
  for (const reportProblem of NEVER_RAN) {
    const result = adjudicate(suiteNeverRan(reportProblem));
    assert.deepEqual(
      result.criteria.map((row) => row.verdict),
      ["UNKNOWN", "UNKNOWN"],
      `"${reportProblem}" must not charge the pipeline: the word "unasserted" is written for EVERY ` +
        `criterion when the suite produced no outcomes, so it says nothing about whether a test exists`,
    );
    assert.equal(
      result.wakeRepairLane,
      false,
      `an unsupervised repair lane must not wake on "${reportProblem}" — the artefact may simply not run`,
    );
  }
});

/**
 * THE CONTROL THAT STOPS THE FIX BEING OVER-CONSERVATIVE, and without it the
 * change above could have made EVERY unasserted criterion UNKNOWN and nothing
 * would have noticed.
 *
 * MUTATION: make `reportProblemIsHarnessFailure` return `false` unconditionally
 * (i.e. treat every report problem as undecidable). This goes RED while the test
 * above stays green — which is the pair that matters.
 */
test("a report the harness could not PARSE is still a pipeline defect", () => {
  const result = adjudicate(
    input({
      failures: [],
      testsFailed: null,
      // `parseNodeTestReport`'s own wording, scorer-container.ts:955.
      reportProblem: "no machine-readable report at /scorer/out/suite-report.json: ENOENT",
      criterionCoverage: [coverage({ criterionId: "REQ-001", outcome: "unasserted", tier: "BLOCKING" })],
    }),
  );
  assert.equal(
    verdictOf(result.criteria, "REQ-001").verdict,
    "PIPELINE",
    "a report that existed and could not be READ is the scorer's own defect and must still wake the lane",
  );
  assert.equal(result.wakeRepairLane, true);
});

/**
 * The absence table is quoted from its producers, so it can silently fall out of
 * step with them.
 *
 * MUTATION: remove any one entry from `SUITE_NEVER_RAN_PROBLEMS` -> that
 * literal's iteration in the first test goes RED. This test additionally pins
 * that the strings still EXIST in the producer, so a reworded message in
 * `scorer-container.ts` fails here rather than silently re-opening the hole.
 */
test("every literal in the absence table is still written by the scorer", async () => {
  const { readFileSync } = await import("node:fs");
  const producer = readFileSync(
    new URL("../../../bakeoff/src/scorer-container.ts", import.meta.url),
    "utf8",
  );
  for (const literal of NEVER_RAN) {
    assert.ok(
      producer.includes(literal),
      `"${literal}" is no longer written by bakeoff/src/scorer-container.ts. Either the message was ` +
        `reworded — in which case the absence table must be updated or the over-fire returns — or the ` +
        `producer was deleted and the entry is dead.`,
    );
  }
});

/**
 * THE SAME NARROWING, THROUGH THE OTHER DOOR.
 *
 * Found 2026-08-16 by a debugfix lens, in the fix made earlier the same day.
 * That fix made `connection-refused` and `boot-timeout` conditional on
 * `appAnswered` — but it only guarded the BOOT_FAILURE_PATTERNS loop. The
 * `runner-error-code` branch ABOVE it pushed `side: "pipeline"` unconditionally,
 * and `HARNESS_ERROR_CODES` contains ECONNREFUSED, ECONNRESET, ETIMEDOUT and
 * EPIPE — the identical class of socket death the narrowing was written to stop
 * deciding. Fixing one of two paths is not fixing it.
 *
 * MUTATION: remove the `APP_DIED_CODES && appAnswered` guard from the
 * `runner-error-code` branch -> the first assertion goes RED and an artefact
 * that crashed mid-suite wakes the unattended lane again.
 */
test("a socket CODE stops deciding once the app is known to have answered", () => {
  const title = "holdout/late.test.mjs › [REQ-301] T-1 the app is still up";
  const run = (appAnswered: boolean): string =>
    verdictOf(
      adjudicate(
        input({
          failures: [failure({ titlePath: title, criterionIds: ["REQ-301"], message: "socket closed", code: "ECONNREFUSED" })],
          criterionCoverage: appAnswered
            ? [GREEN_SIBLING, coverage({ criterionId: "REQ-301", testRefs: [title] })]
            : [coverage({ criterionId: "REQ-301", testRefs: [title] })],
        }),
      ).criteria,
      "REQ-301",
    ).verdict;

  assert.equal(run(true), "UNKNOWN", "the app answered, so a later refused connection blames nobody");
  assert.equal(run(false), "PIPELINE", "but with nothing ever answering it is still the harness — the control");
});

/**
 * THE OTHER HALF OF THE TABLE MUST STAY UNCONDITIONAL. A missing module is a
 * property of the environment; no working-then-crashing app produces one.
 *
 * MUTATION: add "ERR_MODULE_NOT_FOUND" to APP_DIED_CODES -> RED. Without this,
 * a fix that over-corrected by gating every code would look identical.
 */
test("a module or file CODE is the harness whether or not the app answered", () => {
  const title = "holdout/imports.test.mjs › [REQ-302] T-1 the suite loads";
  for (const code of ["ERR_MODULE_NOT_FOUND", "ENOENT", "EACCES"]) {
    const result = adjudicate(
      input({
        failures: [failure({ titlePath: title, criterionIds: ["REQ-302"], message: "load failed", code })],
        criterionCoverage: [GREEN_SIBLING, coverage({ criterionId: "REQ-302", testRefs: [title] })],
      }),
    );
    assert.equal(verdictOf(result.criteria, "REQ-302").verdict, "PIPELINE", `${code} must stay unconditional`);
  }
});

/**
 * THE FAILURE CLASS MOST LIKELY TO BE THE SUITE DEFECT WAS THE ONE CLASS THAT
 * COULD NEVER WAKE THE LANE.
 *
 * A test that carries no criterion id is invisible to `criterionCoverage` — this
 * module's own docblock says so, and says that is exactly why such failures are
 * reported rather than dropped. But `wakeRepairLane` read only `criteria` and
 * `runEvidence`, so a run whose ONLY pipeline evidence was an unattributed
 * failure went back to sleep, with nothing in `notes` to say it had.
 *
 * MUTATION: drop the `unattributedFailures.some(...)` clause -> RED.
 */
test("an unattributed failure carrying pipeline evidence wakes the lane", () => {
  const result = adjudicate(
    input({
      failures: [
        failure({
          titlePath: "holdout/helpers.test.mjs › the shared fixture boots",
          criterionIds: [],
          /*
           * `ERR_MODULE_NOT_FOUND`, NOT `ECONNREFUSED`, AND THE REASON IS THE
           * OTHER FIX INTERACTING CORRECTLY. A passing criterion means the app
           * answered, and once it has, a refused socket is undecidable (see the
           * APP_DIED_CODES narrowing). An unresolvable module never becomes
           * decidable that way — it is the environment, not the app. The first
           * draft of this fixture used ECONNREFUSED and went red, which is the
           * two guards agreeing rather than either one misbehaving.
           */
          message: "Cannot find module '/scorer/suite/helpers.mjs'",
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ],
      // Every criterion passed, so `criteria` carries nothing to route on.
      criterionCoverage: [coverage({ criterionId: "REQ-001", outcome: "passed" })],
    }),
  );
  assert.equal(result.criteria.filter((row) => row.verdict === "PIPELINE").length, 0, "the fixture must have no tagged pipeline row");
  assert.equal(result.unattributedFailures[0]?.verdict, "PIPELINE");
  assert.equal(result.wakeRepairLane, true, "the lane slept on a run holding pipeline evidence");
});

/**
 * THE CONTROL. An unattributed failure that shows the APP answering must not
 * wake the lane — otherwise the fix above turns every untagged test failure into
 * a repair-lane trigger, which is the over-fire this module keeps being bitten by.
 */
test("an unattributed failure that measured the app does NOT wake the lane", () => {
  const result = adjudicate(
    input({
      failures: [
        failure({
          titlePath: "holdout/pages.spec.mjs › the about page carries a biography",
          criterionIds: [],
          message: "expected 200, received 404",
          expected: "200",
          actual: "404",
        }),
      ],
      criterionCoverage: [coverage({ criterionId: "REQ-001", outcome: "passed" })],
    }),
  );
  assert.notEqual(result.unattributedFailures[0]?.verdict, "PIPELINE");
  assert.equal(result.wakeRepairLane, false);
});
