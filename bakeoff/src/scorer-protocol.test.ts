/**
 * scorer-protocol.test.ts — unit tests for the QUALITY exception in
 * `GATE:suite-green`.
 *
 * WHY THESE EXIST SEPARATELY FROM THE e2e. `test/quality-gating.e2e.mjs` proves
 * the rule end-to-end through the real sealed container, which is the proof that
 * matters — but a container run cannot cheaply reach the cases that are only
 * dangerous when they are rare: a report whose failure count exceeds the
 * outcomes it emitted, a runner status neither vocabulary explains, a filename
 * that happens to contain a criterion id. Those decide whether the narrowing is
 * a scope or a hole, so they are asserted directly against the pure function.
 *
 * EVERY TEST HERE IS A NEGATIVE CONTROL EXCEPT THE FIRST. The change makes a
 * gate fire less often; the failure mode being guarded is the gate not firing at
 * all, so almost all of this file asserts that something STILL gates.
 *
 * Run with `npm test` (builds, then `node --test dist`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AcceptanceCriterion, CriterionTier } from "./contracts.js";
import {
  GATE_IDS,
  TITLE_PATH_SEPARATOR,
  criterionNamedInTestTitle,
  isSuiteTestFailure,
  collectManifestProblems,
  parseContainerResult,
  parseSuiteManifest,
  triageSuiteFailures,
} from "./scorer-protocol.js";
import type { ManifestProblem, SuiteTestOutcome } from "./scorer-protocol.js";
import { gateToCriterion } from "./scorer.js";

const criterion = (id: string, tier: CriterionTier): AcceptanceCriterion => ({
  id,
  tier,
  statement: `The system shall satisfy ${id}.`,
  evidenceRequired: `holdout test for ${id}`,
});

/** REQ-001 FUNCTIONAL, REQ-002 BLOCKING, REQ-900 QUALITY. */
const CRITERIA: readonly AcceptanceCriterion[] = [
  criterion("REQ-001", "FUNCTIONAL"),
  criterion("REQ-002", "BLOCKING"),
  criterion("REQ-900", "QUALITY"),
];

/** A failing outcome, titled the way both runners title one. */
const failing = (title: string, file = "holdout/site.spec.mjs"): SuiteTestOutcome => ({
  titlePath: [file, title].join(TITLE_PATH_SEPARATOR),
  ok: false,
  statuses: ["unexpected"],
});

const passing = (title: string, file = "holdout/site.spec.mjs"): SuiteTestOutcome => ({
  titlePath: [file, title].join(TITLE_PATH_SEPARATOR),
  ok: true,
  statuses: ["expected"],
});

/* -------------------------------------------------------------------------
 * The change: QUALITY reports, it never gates
 * ---------------------------------------------------------------------- */

test("a failure bound solely to a QUALITY criterion is excused, not gating", () => {
  const triage = triageSuiteFailures(CRITERIA, [passing("[REQ-001] T-1 ok"), failing("[REQ-900] T-9 a11y")], 1);
  assert.equal(triage.failures.length, 1);
  assert.equal(triage.qualityOnly.length, 1);
  assert.equal(triage.gating.length, 0);
  assert.equal(triage.excusable, true);
});

test("two QUALITY-only failures are excused together, and both are still reported", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-8 a11y"), failing("[REQ-900] T-9 contrast")], 2);
  assert.equal(triage.excusable, true);
  assert.equal(triage.qualityOnly.length, 2);
});

/* -------------------------------------------------------------------------
 * The negative controls: everything else STILL gates
 * ---------------------------------------------------------------------- */

test("an UNTAGGED failure gates — this is what the catch-all is for", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("T-9 nobody claims me")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.qualityOnly.length, 0);
  assert.equal(triage.excusable, false);
});

test("a failure naming a FUNCTIONAL criterion gates", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-001] T-9 the feature")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a failure naming a BLOCKING criterion gates", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-002] T-9 it boots")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a failure naming BOTH a QUALITY and a FUNCTIONAL criterion gates — 'solely' means solely", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] [REQ-001] T-9 both")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.qualityOnly.length, 0);
  assert.equal(triage.excusable, false);
});

test("one excusable failure never carries a gating one with it", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-8 a11y"), failing("[REQ-001] T-9 feature")], 2);
  assert.equal(triage.qualityOnly.length, 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a QUALITY id in the FILE NAME cannot excuse an untagged test in that file", () => {
  // The leading segment of a title path is the file. If it counted, naming a
  // file `REQ-900-a11y.spec.mjs` would switch the catch-all off for everything
  // inside it — a gate disabled by a filename.
  const triage = triageSuiteFailures(CRITERIA, [failing("T-9 untagged", "holdout/REQ-900-a11y.spec.mjs")], 1);
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a title path with no test title at all names nothing, and gates", () => {
  const triage = triageSuiteFailures(
    CRITERIA,
    [{ titlePath: "holdout/REQ-900.spec.mjs", ok: false, statuses: ["unexpected"] }],
    1,
  );
  assert.equal(triage.gating.length, 1);
  assert.equal(triage.excusable, false);
});

test("a criterion id must be a WHOLE token — REQ-9000 is not REQ-900", () => {
  assert.equal(criterionNamedInTestTitle(`file.spec.mjs${TITLE_PATH_SEPARATOR}[REQ-9000] T-9`, "REQ-900"), false);
  assert.equal(criterionNamedInTestTitle(`file.spec.mjs${TITLE_PATH_SEPARATOR}[REQ-900] T-9`, "REQ-900"), true);
});

/* -------------------------------------------------------------------------
 * Excusing by silence is impossible
 * ---------------------------------------------------------------------- */

test("a report counting MORE failures than it emitted outcomes is never excusable", () => {
  // Two counted, one visible: the invisible one is unattributed, so it could be
  // anything — including a FUNCTIONAL failure. Excusing it would be excusing by
  // silence.
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-9 a11y")], 2);
  assert.equal(triage.attributionComplete, false);
  assert.equal(triage.excusable, false);
});

test("an unparseable failure count (null) is never excusable", () => {
  const triage = triageSuiteFailures(CRITERIA, [failing("[REQ-900] T-9 a11y")], null);
  assert.equal(triage.attributionComplete, false);
  assert.equal(triage.excusable, false);
});

test("a pass with NO failures is not excusable, so a bare crash exit can never be excused", () => {
  const triage = triageSuiteFailures(CRITERIA, [passing("[REQ-001] T-1 ok")], 0);
  assert.equal(triage.failures.length, 0);
  assert.equal(triage.excusable, false);
});

/* -------------------------------------------------------------------------
 * What counts as a failure at all
 * ---------------------------------------------------------------------- */

test("skipped and todo outcomes are not failures of this gate", () => {
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["skipped"] }), false);
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["todo"] }), false);
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: true, statuses: ["expected"] }), false);
});

test("a not-ok outcome with an UNRECOGNISED status counts as a failure and gates", () => {
  // The safe direction: a status neither runner's vocabulary explains becomes a
  // failure that must be excused explicitly, never one silently ignored.
  const odd: SuiteTestOutcome = { titlePath: `f.spec.mjs${TITLE_PATH_SEPARATOR}T-9`, ok: false, statuses: ["weird"] };
  assert.equal(isSuiteTestFailure(odd), true);
  assert.equal(triageSuiteFailures(CRITERIA, [odd], 1).excusable, false);
});

test("a not-ok outcome with NO statuses counts as a failure", () => {
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: [] }), true);
});

test("a retried test that ends skipped is not a failure; one that ends unexpected is", () => {
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["skipped", "skipped"] }), false);
  assert.equal(isSuiteTestFailure({ titlePath: "f › T-1", ok: false, statuses: ["skipped", "unexpected"] }), true);
});

/* -------------------------------------------------------------------------
 * `unknown`: the gate that did not run is not the gate that passed (#35)
 *
 * THIS IS THE WHOLE FIX, IN ONE ASSERTION. `unknown` only means anything
 * because `gateToCriterion` refuses to call it a pass; if that mapping ever
 * changes, `GATE:build` goes back to being switched off by a manifest that
 * declared a build step absent, and every test above would stay green while it
 * happened. The mapping is in scorer.ts and is READ here, never redefined.
 * ---------------------------------------------------------------------- */

test("an `unknown` gate is NOT a pass, and carries its reason into the criterion", () => {
  const unknown = gateToCriterion({
    id: GATE_IDS.build,
    name: "build succeeds",
    outcome: "unknown",
    detail: "THE BUILD GATE WAS NEVER EVALUATED, and this is not a pass.",
    durationMs: 0,
    command: null,
    exitCode: null,
  });
  assert.equal(unknown.passed, false, "an unevaluated BLOCKING gate must never score as passed");
  assert.equal(unknown.tier, "BLOCKING");
  assert.match(unknown.detail ?? "", /NEVER EVALUATED/, "a non-pass with no reason is unactionable");
});

test("`not_applicable` still passes, and still says why — the corroborated case", () => {
  const na = gateToCriterion({
    id: GATE_IDS.build,
    name: "build succeeds",
    outcome: "not_applicable",
    detail: "the frozen manifest declares no build step, and the artefact agrees",
    durationMs: 0,
    command: null,
    exitCode: null,
  });
  assert.equal(na.passed, true);
  assert.match(na.detail ?? "", /^NOT APPLICABLE: /);
});

test("a container result carrying `unknown` parses; an invented outcome is refused", () => {
  // The host and the image are built from the same tree, but they are shipped
  // separately: an image built before this change emits no `unknown`, and a host
  // built before it REFUSES one. That asymmetry is the safe direction and it is
  // asserted here so the vocabulary cannot widen by accident.
  const result = parseContainerResult(containerResultWithBuildOutcome("unknown"));
  assert.equal(result.tier0[0]?.outcome, "unknown");
  assert.throws(
    () => parseContainerResult(containerResultWithBuildOutcome("skipped")),
    /tier0\[0\]\.outcome is "skipped"/,
  );
});

/** A minimal, valid container result whose single gate carries `outcome`. */
function containerResultWithBuildOutcome(outcome: string): unknown {
  return {
    protocolVersion: 1,
    ticketId: "T",
    acceptanceSuiteSha256: "0".repeat(64),
    startedAt: "2026-07-29T00:00:00.000Z",
    endedAt: "2026-07-29T00:00:01.000Z",
    nodeVersion: "v22.12.0",
    playwrightVersion: "1.62.0",
    tier0: [
      {
        id: GATE_IDS.build,
        name: "build succeeds",
        outcome,
        detail: "d",
        durationMs: 0,
        command: null,
        exitCode: null,
      },
    ],
    exploitFindings: [],
    suiteExecution: {
      exitCode: 0,
      durationMs: 1,
      testsTotal: 1,
      testsPassed: 1,
      testsFailed: 0,
      timedOut: false,
      reportProblem: null,
    },
    criterionCoverage: [],
    screenshots: [],
    domFindings: [],
    infrastructureErrors: [],
  };
}

/* -------------------------------------------------------------------------
 * COLLECT-ALL MANIFEST VALIDATION
 *
 * WHY IT EXISTS. `parseSuiteManifest`'s `fail()` is typed `never`: it throws at
 * the FIRST offending field, so an authoring feedback turn built from it names
 * exactly one. Run `a913c871` (2026-08-09) died on that channel after 1h26m54s —
 * told "missing id", it added `id` and was told "missing kind"; told "missing
 * kind", it added `kind` and dropped the `id` it had already got right. Seven
 * keys, one hint per attempt, three attempts.
 *
 * THE PROPERTY THESE TESTS DEFEND IS NOT "IT FINDS MORE". A collector that
 * reimplemented the rules would drift from the parser silently and start naming
 * fields the scorer does not care about, which costs an authoring attempt every
 * time. So the tests are mostly about AGREEMENT with the parser:
 *   - a document the parser accepts yields NO problems;
 *   - a document the parser rejects yields the parser's own first message FIRST,
 *     verbatim, always — the list can never say less than fail-fast said;
 *   - a document with exactly one defect yields exactly one problem, in
 *     particular for the cross-field `execution` rule, where a naive per-field
 *     probe invents a defect in a field the candidate got right.
 *
 * NEGATIVE CONTROLS. Mutations applied to production code, run, watched RED,
 * restored (2026-08-10) — recorded in the lane report; each is named on the test
 * it reddened in the assertion messages below.
 * ---------------------------------------------------------------------- */

const SERVER_EXECUTION = {
  install: null,
  build: null,
  typecheck: null,
  lint: null,
  start: "npm start",
  port: 8080,
  healthPath: "/api/health",
  bootTimeoutMs: null,
  commandTimeoutMs: null,
};

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    ticketId: "t-collect",
    target: "web",
    execution: SERVER_EXECUTION,
    sourceDirs: ["."],
    uiFlows: [{ id: "home", path: "/", description: "landing", waitForSelector: null }],
    dataExpectations: [
      { id: "db-1", kind: "sqlite", file: "data/app.db", table: "messages", sql: null, path: null, minRows: 1 },
    ],
    ...overrides,
  };
}

const fieldsOf = (problems: readonly ManifestProblem[]): readonly string[] =>
  [...new Set(problems.map((p) => p.field))].sort();

test("a manifest the sealed parser accepts produces no problems at all", () => {
  // THE ANCHOR. Every count assertion below is meaningless if the collector
  // reports something on a document that is fine — and a collector that cried
  // wolf would spend an authoring attempt per run, for ever.
  assert.doesNotThrow(() => parseSuiteManifest(manifest()));
  assert.deepEqual(collectManifestProblems(manifest()), []);
});

test("three fields wrong in one entry are named in ONE rejection", () => {
  // ATTEMPT 3 OF RUN a913c871, verbatim in shape: it had been told to add
  // `kind`, so it emitted {kind, method, path, expectStatus, description} and
  // lost the `id` it had got right on attempt 2. Under fail-fast it would have
  // been told about `id` and nothing else, for the third time.
  const problems = collectManifestProblems(
    manifest({
      dataExpectations: [{ kind: "http", method: "GET", path: "/api/messages", expectStatus: 200, description: "x" }],
    }),
  );

  for (const field of ["dataExpectations[0].id", "dataExpectations[0].file", "dataExpectations[0].minRows"]) {
    assert.ok(
      fieldsOf(problems).includes(field),
      `${field} is not in the rejection: ${fieldsOf(problems).join(", ")}. Discovering a seven-key ` +
        "object one key per attempt in three attempts is arithmetically impossible.",
    );
  }
  assert.ok(problems.length >= 3, `expected at least three problems, got ${String(problems.length)}`);

  // AND EVERY ONE CARRIES THE PARSER'S OWN REMEDIATION. A field name without
  // one is what the seat cannot act on.
  for (const problem of problems) {
    assert.ok(problem.remediation.length > 0, `${problem.field} has no remediation`);
    assert.ok(problem.message.length > 0, `${problem.field} has no message`);
  }
});

test("attempt 1's shape — the FIRST rejection is the one that stops the cascade", () => {
  // {entity, source, expectation}: what run a913c871's first attempt emitted,
  // having never been shown the object. Fail-fast told it "missing id" and
  // nothing else, and the next two attempts each learned one more field.
  //
  // `kind` is invalid here, and `kind` decides which of file/table/sql/path are
  // required — so those four are deliberately NOT named (naming them against a
  // guessed kind sends the seat to fix fields it may not need). `id` and
  // `minRows` are the two `kind` does not govern, and they ARE named.
  const problems = collectManifestProblems(
    manifest({ dataExpectations: [{ entity: "messages", source: "sqlite", expectation: "one row" }] }),
  );

  assert.deepEqual(fieldsOf(problems), [
    "dataExpectations[0].id",
    "dataExpectations[0].kind",
    "dataExpectations[0].minRows",
  ]);
  assert.ok(
    problems.some((p) => /minRows/.test(p.message)),
    "minRows appeared in no message. No attempt of run a913c871 ever emitted that field and none was " +
      "ever told it exists.",
  );
});

/* -------------------------------------------------------------------------
 * `sql` — the seventh key, which no probe could name until 2026-08-10
 * ---------------------------------------------------------------------- */

/**
 * WHY NO EXISTING TEST COULD HAVE CAUGHT THIS, stated so the gap is not
 * re-opened: every `dataExpectations` fixture above carries `sql` present, so
 * the field was never the thing under test. `table` and `sql` were probed as ONE
 * substitution hardcoded to the label `${where}.table`, and there was no `.sql`
 * probe in the file at all — measured, not assumed: against run a913c871's
 * attempt-3 shape the collector returned eight problems and the word `sql`
 * appeared in none of them. A seat that repairs all eight is rejected again on
 * the attempt after, which finally names `sql`. That extra round trip is the
 * entire remaining slack of a 3-attempt budget, in the round that exists
 * because a 3-attempt budget ran out.
 */
test("a manifest whose ONLY defect is a missing `sql` is told the word `sql`", () => {
  const problems = collectManifestProblems(
    manifest({
      dataExpectations: [
        // Everything the parser wants except `sql`. `table` is VALID here, which
        // is the point: the at-least-one-of-table-or-sql rule is satisfied, so
        // the only thing left to fail on is `sql`'s own shape.
        { id: "db-1", kind: "sqlite", file: "data/app.db", table: "messages", path: null, minRows: 1 },
      ],
    }),
  );

  assert.deepEqual(
    fieldsOf(problems),
    ["dataExpectations[0].sql"],
    `the sole defect was an absent \`sql\` and the rejection named ${fieldsOf(problems).join(", ") || "nothing"}`,
  );
  assert.ok(
    problems.some((p) => /\bsql\b/.test(p.message)),
    "no message contains the word `sql`, so the seat is handed a rejection it cannot act on",
  );
});

/**
 * THE CASE THAT ACTUALLY COST THE ROUND, kept separate from the one above
 * because only this one is invisible in the sentence the seat reads.
 *
 * `spec-validate` renders `problem.message` and `problem.remediation` and never
 * `problem.field`, so on a single-defect document the old collector was merely
 * MISLABELLED — the seat still read "dataExpectations[0].sql must be …". Here
 * `table` is wrong TOO. The paired probe then spends its one report on `table`,
 * the sql substitution is gone, and the word `sql` disappears from every
 * message in the list. Measured on run a913c871's attempt-3 shape before the
 * fix: eleven problems, `sql` in none of them. That is a seat repairing every
 * field it was handed and being rejected again for the one it was not.
 */
test("when `table` is wrong too, `sql` is STILL named and not swallowed by the pair", () => {
  const problems = collectManifestProblems(
    manifest({
      dataExpectations: [{ id: "db-1", kind: "sqlite", file: "data/app.db", path: null, minRows: 1 }],
    }),
  );

  assert.ok(
    problems.some((p) => /\bsql\b/.test(p.message)),
    "the seat is told about `table` and never about `sql`, so its next attempt is rejected for `sql` " +
      `alone — one more round trip out of a 3-attempt budget. Got: ${problems.map((p) => p.message).join(" | ")}`,
  );
  assert.ok(
    problems.some((p) => /\btable\b/.test(p.message)),
    "the cross-field table rule stopped being reported, which trades one blind spot for another",
  );
});

/**
 * THE NEGATIVE CONTROLS, and they are the half that matters.
 *
 * A probe that reports a problem on a LEGAL document sends the seat to repair a
 * field that was already right — the same wasted attempt this collector exists
 * to prevent, inverted, and strictly worse because it is unfixable. `sql: null`
 * with a real `table`, and `sql: "…"` with `table: null`, are both accepted by
 * the sealed parser; `parseSuiteManifest` is asserted on each one directly so
 * that these cases cannot silently become invalid documents that pass for the
 * wrong reason.
 */
test("a legal `sql` — null beside a table, or a query with no table — is not reported", () => {
  const sqlNull = manifest({
    dataExpectations: [
      { id: "db-1", kind: "sqlite", file: "data/app.db", table: "messages", sql: null, path: null, minRows: 1 },
    ],
  });
  const sqlQuery = manifest({
    dataExpectations: [
      {
        id: "db-1",
        kind: "sqlite",
        file: "data/app.db",
        table: null,
        sql: "select count(*) from messages",
        path: null,
        minRows: 1,
      },
    ],
  });

  for (const [label, candidate] of [
    ["sql: null beside a real table", sqlNull],
    ["a query with table: null", sqlQuery],
  ] as const) {
    assert.doesNotThrow(
      () => parseSuiteManifest(candidate),
      `${label} is supposed to be a document the sealed parser accepts`,
    );
    assert.deepEqual(
      collectManifestProblems(candidate),
      [],
      `${label} is legal and the collector reported on it anyway`,
    );
  }
});

test("the parser's own first complaint is always first, so the list can never say less", () => {
  const corpus: readonly Record<string, unknown>[] = [
    manifest({ manifestVersion: 2 }),
    manifest({ ticketId: "" }),
    manifest({ target: "ios" }),
    manifest({ sourceDirs: [] }),
    manifest({ sourceDirs: ["/abs"] }),
    manifest({ execution: { ...SERVER_EXECUTION, port: null, healthPath: null } }),
    manifest({ execution: { ...SERVER_EXECUTION, healthPath: "https://example.test/health" } }),
    manifest({ uiFlows: [{ id: "a b", path: "/", description: "x", waitForSelector: null }] }),
    manifest({ uiFlows: [{ id: "home", path: "nope", description: "x", waitForSelector: null }] }),
    manifest({ dataExpectations: [{ entity: "messages", source: "sqlite", expectation: "one row" }] }),
    manifest({ dataExpectations: [{ id: "d", description: "x", entity: "m", minRowCount: 1, readBack: true }] }),
    manifest({ dataExpectations: [{ id: "d", kind: "sqlite", file: "data/a.db", table: null, sql: null, path: null, minRows: 1 }] }),
    manifest({ dataExpectations: [{ id: "d", kind: "http", file: null, table: null, sql: null, path: null, minRows: 1 }] }),
    manifest({ dataExpectations: [{ id: "d", kind: "sqlite", file: "../etc/x", table: "t", sql: null, path: null, minRows: 0 }] }),
  ];

  for (const candidate of corpus) {
    let thrown: string | null = null;
    try {
      parseSuiteManifest(candidate);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    const problems = collectManifestProblems(candidate);

    assert.ok(thrown !== null, `this corpus entry parses cleanly and proves nothing: ${JSON.stringify(candidate)}`);
    assert.ok(problems.length > 0, `collect returned nothing for a document the parser rejects: ${thrown}`);
    assert.equal(
      problems[0]?.message,
      thrown,
      "the parser's own first complaint is not the first problem. It must be, unconditionally: that " +
        "is what makes this list a superset of the fail-fast behaviour rather than a second opinion.",
    );
  }
});

test("a document with exactly ONE defect produces exactly one problem", () => {
  // NO INVENTED WORK. Every field named costs the seat an edit, and a field it
  // did not get wrong costs it an attempt. The `execution` case is the one that
  // catches a naive collector: substituting a perfectly good `"start": "npm
  // start"` into a base whose port and healthPath are null trips the cross-field
  // rule and reports `execution.start` on a manifest that declared all three.
  const singles: readonly [string, Record<string, unknown>][] = [
    ["manifestVersion", manifest({ manifestVersion: 2 })],
    ["ticketId", manifest({ ticketId: "" })],
    ["target", manifest({ target: "ios" })],
    ["sourceDirs", manifest({ sourceDirs: [] })],
    [
      "execution cross-field",
      manifest({ execution: { ...SERVER_EXECUTION, port: null, healthPath: null } }),
    ],
    [
      "dataExpectations minRows",
      manifest({
        dataExpectations: [
          { id: "db-1", kind: "sqlite", file: "data/app.db", table: "messages", sql: null, path: null, minRows: 0 },
        ],
      }),
    ],
    [
      "uiFlows path",
      manifest({ uiFlows: [{ id: "home", path: "nope", description: "landing", waitForSelector: null }] }),
    ],
  ];

  for (const [name, candidate] of singles) {
    const problems = collectManifestProblems(candidate);
    assert.equal(
      problems.length,
      1,
      `"${name}" has one defect and produced ${String(problems.length)}: ` +
        problems.map((p) => `${p.field} (${p.message})`).join(" | "),
    );
  }
});

test("a duplicate id is a property of the LIST, and no per-entry probe can see one", () => {
  const dup = manifest({
    dataExpectations: [
      { id: "same", kind: "sqlite", file: "data/app.db", table: "m", sql: null, path: null, minRows: 1 },
      { id: "same", kind: "http", file: null, table: null, sql: null, path: "/api/m", minRows: 1 },
    ],
  });
  const problems = collectManifestProblems(dup);
  assert.equal(problems.length, 1, problems.map((p) => p.field).join(", "));
  assert.match(problems[0]?.message ?? "", /duplicate dataExpectations id/);

  const dupFlows = manifest({
    uiFlows: [
      { id: "home", path: "/", description: "a", waitForSelector: null },
      { id: "home", path: "/b", description: "b", waitForSelector: null },
    ],
  });
  assert.match(collectManifestProblems(dupFlows)[0]?.message ?? "", /duplicate uiFlows id/);
});

test("a manifest that is not an object at all produces the parser's complaint and stops", () => {
  for (const junk of [null, 42, "a string", [1, 2, 3]]) {
    const problems = collectManifestProblems(junk);
    assert.equal(problems.length, 1, `${JSON.stringify(junk)} produced ${String(problems.length)} problems`);
    assert.match(problems[0]?.message ?? "", /is not a JSON object|manifestVersion/);
  }
});
