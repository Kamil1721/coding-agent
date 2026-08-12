/**
 * spec-repair.test.ts — proof that the repair round saves the attempt, and the
 * negative control that proves the proof.
 *
 * THE FIXTURE IS RUN `ac275880` (2026-08-11), REDUCED. That run spent three
 * authoring attempts and died with one blocking finding: *test file
 * "holdout/motion-and-visuals.spec.mjs" contains credential-shaped literal(s)*.
 * The suite below has exactly the same shape — one credential-shaped literal in
 * one visible test file, everything else clean — and it was CONSTRUCTED BY
 * MEASUREMENT rather than by guessing: `deterministicAudit` returns exactly one
 * blocking finding over `LEAKY_SOURCE` and exactly zero over `CLEAN_SOURCE`.
 * Both halves are asserted below, because a fixture that blocks for two reasons
 * would let a repair round "succeed" while fixing neither.
 *
 * EVERY CLAIM HERE HAS A CONTROL. The claim is that repair saves an attempt, so
 * `maxRepairRounds: 0` runs the SAME scripted seat and asserts the attempt is
 * spent and the run dies. Without that arm, a test asserting "the suite came
 * back" would pass identically if the repair loop were deleted and the seat's
 * second response happened to be a good suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AnthropicSeat, AuditFinding, Ticket } from "./contracts.js";
import { BakeoffError } from "./contracts.js";
import { ticketDigest } from "./hash.js";
import { generateAuditedSuite } from "./spec-agent.js";
import {
  DEFAULT_MAX_REPAIR_ROUNDS,
  isRepairable,
  parseRepairResponse,
  renderRepairTurn,
  repairTargets,
} from "./spec-repair.js";
import { AnthropicSeatCaller } from "./anthropic-seat.js";
import type { SeatCallRequest, SeatCallResult } from "./anthropic-seat.js";
import { JUDGE_SEAT, SPEC_SEAT } from "./config.js";
import { AUTHORING_BUDGET } from "./spec-types.js";
import type { SuiteDraft } from "./spec-types.js";
import { deterministicAudit } from "./spec-validate.js";

/* -------------------------------------------------------------------------
 * The fixture
 * ---------------------------------------------------------------------- */

const BRIEF =
  "Build a contact form that stores submissions in SQLite and serves the project list " +
  "from the database. GET /api/messages requires a bearer token read from the environment.";

const TICKET: Ticket = Object.freeze({
  id: "t-b79ff5e2a1b314e4",
  brief: BRIEF,
  sha256: ticketDigest(BRIEF),
  tier: "medium",
  title: "repair fixture",
});

const VALID_MANIFEST = JSON.stringify(
  {
    manifestVersion: 1,
    ticketId: TICKET.id,
    target: "web",
    execution: {
      install: null,
      build: null,
      typecheck: null,
      lint: null,
      start: "npm start",
      port: 3000,
      healthPath: "/api/health",
      bootTimeoutMs: null,
      commandTimeoutMs: null,
    },
    sourceDirs: ["."],
    uiFlows: [{ id: "home", path: "/", description: "hero", waitForSelector: null }],
    dataExpectations: [
      {
        id: "db-query-7",
        kind: "sqlite",
        file: "data/app.db",
        table: "messages",
        sql: null,
        path: null,
        minRows: 1,
      },
    ],
  },
  null,
  2,
);

/** The defect. `sk-live-…` is the shape the credential scan blocks on. */
const LEAKY_SOURCE =
  'const AUTHORIZATION_HEADER = "Bearer sk-live-AbCdEf0123456789AbCdEf0123456789";\n' +
  'test("[REQ-001] T-1 messages are readable with the token", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/messages");\n' +
  "  if (r.status !== 200) throw new Error(String(r.status));\n" +
  "});\n";

/** The same test with the literal replaced. Nothing else about it differs. */
const CLEAN_SOURCE =
  'const TOKEN_FIXTURE = "not-a-real-token";\n' +
  'test("[REQ-001] T-1 messages are readable with the token", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/messages");\n' +
  "  if (r.status !== 200) throw new Error(String(r.status));\n" +
  "});\n";

const HOLDOUT_SOURCE =
  'test("[REQ-001] T-2 a submission is stored", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/contact", { method: "POST" });\n' +
  "  if (r.status !== 201) throw new Error(String(r.status));\n" +
  "});\n" +
  'test("[REQ-002] T-3 the project list is served", async () => {\n' +
  '  const r = await fetch("http://127.0.0.1:3000/api/projects");\n' +
  "  if (r.status !== 200) throw new Error(String(r.status));\n" +
  "});\n";

const VISIBLE_PATH = "visible/contact-api.test.mjs";
const HOLDOUT_PATH = "holdout/contact-api.test.mjs";

const CRITERIA = [
  {
    id: "REQ-001",
    statement:
      "When a visitor submits the contact form, the system shall store the submission in SQLite.",
    evidenceRequired: "holdout test T-2 PASS",
    tier: "BLOCKING",
    holdoutTestIds: ["T-2"],
    visibleTestIds: ["T-1"],
    evidenceArtifacts: [],
  },
  {
    id: "REQ-002",
    statement: "The system shall serve the project list from the database.",
    evidenceRequired: "holdout test T-3 PASS",
    tier: "FUNCTIONAL",
    holdoutTestIds: ["T-3"],
    visibleTestIds: [],
    evidenceArtifacts: [],
  },
] as const;

function testFiles(visibleSource: string): unknown[] {
  return [
    {
      path: HOLDOUT_PATH,
      visibility: "holdout",
      runner: "node-test",
      description: "held-out contact API checks",
      testIds: ["T-2", "T-3"],
      criterionIds: ["REQ-001", "REQ-002"],
      source: HOLDOUT_SOURCE,
    },
    {
      path: VISIBLE_PATH,
      visibility: "visible",
      runner: "node-test",
      description: "visible twin",
      testIds: ["T-1"],
      criterionIds: ["REQ-001"],
      source: visibleSource,
    },
    {
      path: "suite.manifest.json",
      visibility: "visible",
      runner: "node-test",
      description: "the scorer's execution manifest",
      testIds: [],
      criterionIds: [],
      source: VALID_MANIFEST,
    },
  ];
}

/** A whole authoring response, parseable by `parseSuiteDraft`. */
function authoringResponse(visibleSource: string): string {
  return JSON.stringify({ criteria: CRITERIA, testFiles: testFiles(visibleSource) });
}

/** A repair response returning ONLY the one file the finding named. */
function repairResponse(visibleSource: string): string {
  return JSON.stringify({
    criteria: [],
    testFiles: [
      {
        path: VISIBLE_PATH,
        visibility: "visible",
        runner: "node-test",
        description: "visible twin",
        testIds: ["T-1"],
        criterionIds: ["REQ-001"],
        source: visibleSource,
      },
    ],
  });
}

const JUDGE_USABLE = JSON.stringify({ verdict: "usable", findings: [] });

/** A draft as the harness holds it, for the unit tests below. */
function draftOf(visibleSource: string): SuiteDraft {
  return {
    ticketId: TICKET.id,
    ticketSha256: TICKET.sha256,
    criteria: CRITERIA.map((c) => ({
      id: c.id,
      statement: c.statement,
      evidenceRequired: c.evidenceRequired,
      tier: c.tier,
      holdoutTestIds: [...c.holdoutTestIds],
      visibleTestIds: [...c.visibleTestIds],
      evidenceArtifacts: [...c.evidenceArtifacts],
    })),
    files: [
      {
        path: HOLDOUT_PATH,
        visibility: "holdout",
        runner: "node-test",
        description: "held-out contact API checks",
        expectedTestIds: ["T-2", "T-3"],
        criterionIds: ["REQ-001", "REQ-002"],
        source: HOLDOUT_SOURCE,
      },
      {
        path: VISIBLE_PATH,
        visibility: "visible",
        runner: "node-test",
        description: "visible twin",
        expectedTestIds: ["T-1"],
        criterionIds: ["REQ-001"],
        source: visibleSource,
      },
      {
        path: "suite.manifest.json",
        visibility: "visible",
        runner: "node-test",
        description: "the scorer's execution manifest",
        expectedTestIds: [],
        criterionIds: [],
        source: VALID_MANIFEST,
      },
    ],
  };
}

const SENTINEL = ["BAKEOFF", "TEST", "NO", "API", "KEY"].join("-");

class ReplayCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];
  readonly #script: readonly string[];

  constructor(seat: AnthropicSeat, script: readonly string[]) {
    super(seat, { budget: AUTHORING_BUDGET, env: { [seat.envKeyName]: SENTINEL } });
    this.#script = script;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    return {
      text: this.#script[this.requests.length - 1] ?? "",
      stopReason: "end_turn",
      usage: { costUsd: 0 },
    } as unknown as SeatCallResult;
  }
}

/* -------------------------------------------------------------------------
 * PART 1 — the fixture is what it claims to be
 * ---------------------------------------------------------------------- */

test("THE FIXTURE, MEASURED: the leak is the ONLY blocking finding, and the fix clears it", () => {
  const leaky = deterministicAudit(draftOf(LEAKY_SOURCE), { syntaxCheck: false, ticketBrief: BRIEF });
  const blocking = leaky.filter((f) => f.mustRegenerate);
  assert.equal(
    blocking.length,
    1,
    `the fixture must block for exactly one reason, got:\n${blocking.map((f) => f.detail).join("\n")}`,
  );
  assert.match(blocking[0]?.detail ?? "", /credential-shaped literal/);
  assert.ok(
    (blocking[0]?.detail ?? "").includes(VISIBLE_PATH),
    "the finding must NAME the file, or nothing downstream can localise it",
  );

  // THE OTHER ARM. Without this, "the repair worked" could mean "the audit
  // never had anything to say about this suite in the first place".
  const clean = deterministicAudit(draftOf(CLEAN_SOURCE), {
    syntaxCheck: false,
    ticketBrief: BRIEF,
  });
  assert.equal(
    clean.filter((f) => f.mustRegenerate).length,
    0,
    "the repaired suite must have NO blocking finding, or the re-audit proves nothing",
  );
});

/* -------------------------------------------------------------------------
 * PART 2 — the loop
 * ---------------------------------------------------------------------- */

test("A REPAIRED SUITE IS ACCEPTED WITHOUT SPENDING A SECOND ATTEMPT", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [
    authoringResponse(LEAKY_SOURCE),
    repairResponse(CLEAN_SOURCE),
  ]);
  const judge = new ReplayCaller(JUDGE_SEAT, [JUDGE_USABLE]);

  const authored = await generateAuditedSuite(TICKET, {
    specCaller: spec,
    judgeCaller: judge,
    syntaxCheck: false,
  });

  assert.equal(authored.attempts.length, 1, "the repair must not consume a second attempt");
  const row = authored.attempts[0];
  assert.equal(row?.accepted, true);
  assert.equal(row?.repairRounds, 1);
  assert.equal(spec.requests.length, 2, "one authoring call and one repair call");

  // THE RECORD MUST STILL CARRY THE DEFECT. `findings` on this row is the
  // RE-audit's, which is clean; without `repairedProblems` the trail would say
  // this attempt never shipped a credential-shaped literal.
  assert.equal(row?.repairedProblems.length, 1);
  assert.match(row?.repairedProblems[0] ?? "", /credential-shaped literal/);

  // And the suite that came out is the SPLICED one, not the leaky draft.
  const visible = authored.files.find((f) => f.path === VISIBLE_PATH);
  assert.equal(visible?.source, CLEAN_SOURCE);
  assert.ok(
    !authored.files.some((f) => f.source.includes("sk-live-")),
    "no file in the frozen suite may still carry the literal",
  );
  // The untouched files came through by identity, not re-derived.
  assert.equal(authored.files.find((f) => f.path === HOLDOUT_PATH)?.source, HOLDOUT_SOURCE);
});

test("NEGATIVE CONTROL: the SAME script with repair disabled spends every attempt and dies", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [
    authoringResponse(LEAKY_SOURCE),
    repairResponse(CLEAN_SOURCE),
    authoringResponse(LEAKY_SOURCE),
  ]);
  const judge = new ReplayCaller(JUDGE_SEAT, []);

  await assert.rejects(
    generateAuditedSuite(TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      syntaxCheck: false,
      maxRepairRounds: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BakeoffError);
      assert.match(error.message, /credential-shaped literal/);
      // The both-directions sentence, in its disabled form.
      assert.match(error.message, /Repair before regenerate: DISABLED for this run/);
      return true;
    },
  );
  assert.equal(spec.requests.length, 3, "three authoring calls, one per attempt, and no repair call");
});

test("THE REPAIR PROMPT CARRIES THE NAMED FILE AND NOT THE REST OF THE SUITE", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [
    authoringResponse(LEAKY_SOURCE),
    repairResponse(CLEAN_SOURCE),
  ]);
  const judge = new ReplayCaller(JUDGE_SEAT, [JUDGE_USABLE]);
  await generateAuditedSuite(TICKET, { specCaller: spec, judgeCaller: judge, syntaxCheck: false });

  const repairTurns = (spec.requests[1]?.userTurns ?? []).join("\n");
  assert.ok(repairTurns.includes(LEAKY_SOURCE), "the seat must be shown the artefact it is fixing");
  assert.match(repairTurns, /credential-shaped literal/);
  assert.ok(repairTurns.includes(TICKET.brief), "the ticket stays in turn 1");

  // THE COST CLAIM, TESTED. Sending the whole draft back was rejected on prompt
  // size (see AuthoringRetryContext). A repair that quietly echoed every file
  // would pass every other assertion in this file.
  assert.ok(
    !repairTurns.includes(HOLDOUT_SOURCE),
    "a file no finding named must not be in the repair prompt",
  );
  assert.ok(
    !repairTurns.includes(VALID_MANIFEST),
    "the manifest was not named by any finding and must not be in the repair prompt",
  );
});

test("A REPAIR THAT DOES NOT FIX IT FALLS THROUGH TO THE REGENERATION IT WOULD HAVE HAD", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [
    authoringResponse(LEAKY_SOURCE), // attempt 1
    repairResponse(LEAKY_SOURCE), // its repair round: still leaky
    authoringResponse(LEAKY_SOURCE), // attempt 2
    repairResponse(LEAKY_SOURCE),
    authoringResponse(LEAKY_SOURCE), // attempt 3
    repairResponse(LEAKY_SOURCE),
  ]);
  const judge = new ReplayCaller(JUDGE_SEAT, []);

  await assert.rejects(
    generateAuditedSuite(TICKET, { specCaller: spec, judgeCaller: judge, syntaxCheck: false }),
    (error: unknown) => {
      assert.ok(error instanceof BakeoffError);
      assert.match(error.message, /Repair before regenerate: 3 round\(s\) fired, on attempt\(s\) 1, 2, 3/);
      return true;
    },
  );
  assert.equal(spec.requests.length, 6, "three attempts, each with one repair round");
});

test("AN UNLOCALISABLE BLOCKING FINDING DECLINES THE ROUND RATHER THAN GUESSING", async () => {
  // A suite with no FUNCTIONAL-tier criterion blocks with a SUITE-LEVEL finding:
  // it names no criterion id and no file path, so there is no artefact to hand
  // back. Measured, not assumed — the assertion below reads the finding.
  const oneCriterion = JSON.stringify({
    criteria: [CRITERIA[0]],
    testFiles: testFiles(CLEAN_SOURCE).map((f) => {
      const file = f as Record<string, unknown>;
      return file["path"] === HOLDOUT_PATH
        ? { ...file, testIds: ["T-2"], criterionIds: ["REQ-001"], source: HOLDOUT_SOURCE }
        : file;
    }),
  });
  const spec = new ReplayCaller(SPEC_SEAT, [oneCriterion, oneCriterion, oneCriterion]);
  const judge = new ReplayCaller(JUDGE_SEAT, []);

  await assert.rejects(
    generateAuditedSuite(TICKET, { specCaller: spec, judgeCaller: judge, syntaxCheck: false }),
    (error: unknown) => {
      assert.ok(error instanceof BakeoffError);
      assert.match(error.message, /no FUNCTIONAL-tier criterion/);
      assert.match(error.message, /NO round fired/);
      assert.match(error.message, /declined as unlocalisable/);
      return true;
    },
  );
  assert.equal(spec.requests.length, 3, "no repair call was dispatched for an unlocalisable finding");
});

/* -------------------------------------------------------------------------
 * PART 3 — localisation and splicing, directly
 * ---------------------------------------------------------------------- */

const finding = (detail: string, criterionId: string | null = null): AuditFinding => ({
  criterionId,
  kind: "other",
  detail,
  mustRegenerate: true,
});

test("repairTargets selects by the draft's own identifiers, in draft order", () => {
  const draft = draftOf(LEAKY_SOURCE);
  const targets = repairTargets(
    draft,
    [finding(`test file "${VISIBLE_PATH}" contains credential-shaped literal(s)`), finding("x", "REQ-002")],
    ["p1", "p2"],
  );
  assert.deepEqual(
    targets.files.map((f) => f.path),
    [VISIBLE_PATH],
  );
  assert.deepEqual(
    targets.criteria.map((c) => c.id),
    ["REQ-002"],
  );
  assert.equal(targets.unlocalised.length, 0);
  assert.equal(isRepairable(targets), true);
});

test("an id match cannot be satisfied by a longer id that contains it", () => {
  const draft: SuiteDraft = {
    ...draftOf(CLEAN_SOURCE),
    criteria: [
      { ...draftOf(CLEAN_SOURCE).criteria[0], id: "REQ-01" } as SuiteDraft["criteria"][number],
      { ...draftOf(CLEAN_SOURCE).criteria[1], id: "REQ-013" } as SuiteDraft["criteria"][number],
    ],
  };
  const targets = repairTargets(draft, [finding("REQ-013: statement matches no EARS template")], ["p"]);
  assert.deepEqual(
    targets.criteria.map((c) => c.id),
    ["REQ-013"],
    "REQ-01 must not be dragged in by substring",
  );
});

test("a finding that names nothing in the draft is reported, not silently dropped", () => {
  const targets = repairTargets(draftOf(CLEAN_SOURCE), [finding("the suite gates on nothing")], ["p1"]);
  assert.equal(isRepairable(targets), false);
  assert.deepEqual(targets.unlocalised, ["p1"]);
});

test("the splice replaces only the returned artefacts and keeps every position", () => {
  const draft = draftOf(LEAKY_SOURCE);
  const targets = repairTargets(
    draft,
    [finding(`test file "${VISIBLE_PATH}" contains credential-shaped literal(s)`)],
    ["p1"],
  );
  const result = parseRepairResponse(JSON.parse(repairResponse(CLEAN_SOURCE)), draft, targets);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.draft.files.map((f) => f.path),
    draft.files.map((f) => f.path),
  );
  assert.equal(result.draft.files[1]?.source, CLEAN_SOURCE);
  assert.equal(result.draft.files[0], draft.files[0], "an untouched file keeps its object");
  assert.deepEqual(result.draft.criteria, draft.criteria);
});

test("a repair may not introduce an artefact it was not sent", () => {
  const draft = draftOf(LEAKY_SOURCE);
  const targets = repairTargets(
    draft,
    [finding(`test file "${VISIBLE_PATH}" contains credential-shaped literal(s)`)],
    ["p1"],
  );
  const smuggled = {
    criteria: [],
    testFiles: [
      {
        path: "holdout/extra.test.mjs",
        visibility: "holdout",
        runner: "node-test",
        description: "new",
        testIds: ["T-9"],
        criterionIds: ["REQ-001"],
        source: "test('[REQ-001] T-9 x', () => {});\n",
      },
    ],
  };
  const result = parseRepairResponse(smuggled, draft, targets);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.problems[0] ?? "", /was not one of the files sent for repair/);
});

test("a repair that returns nothing at all is rejected", () => {
  const draft = draftOf(LEAKY_SOURCE);
  const targets = repairTargets(
    draft,
    [finding(`test file "${VISIBLE_PATH}" contains credential-shaped literal(s)`)],
    ["p1"],
  );
  const result = parseRepairResponse({ criteria: [], testFiles: [] }, draft, targets);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.problems[0] ?? "", /returned no artefact at all/);
});

test("the repair turn shows the artefacts before the complaints", () => {
  const draft = draftOf(LEAKY_SOURCE);
  const targets = repairTargets(
    draft,
    [finding(`test file "${VISIBLE_PATH}" contains credential-shaped literal(s)`)],
    ["[other] contains credential-shaped literal(s)"],
  );
  const turn = renderRepairTurn(targets, TICKET);
  assert.ok(turn.indexOf(LEAKY_SOURCE) < turn.indexOf("WHAT THE AUDIT SAID"));
  assert.ok(turn.includes("[other] contains credential-shaped literal(s)"));
});

test("the default is one round", () => {
  assert.equal(DEFAULT_MAX_REPAIR_ROUNDS, 1);
});

/* -------------------------------------------------------------------------
 * PART 4 — the record a repaired suite leaves behind
 * ---------------------------------------------------------------------- */

test("a repair does NOT overwrite the authoring prompt's digest", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [
    authoringResponse(LEAKY_SOURCE),
    repairResponse(CLEAN_SOURCE),
  ]);
  const judge = new ReplayCaller(JUDGE_SEAT, [JUDGE_USABLE]);
  const authored = await generateAuditedSuite(TICKET, {
    specCaller: spec,
    judgeCaller: judge,
    syntaxCheck: false,
  });

  const row = authored.attempts[0];
  assert.equal(row?.repairRounds, 1, "the fixture must actually repair, or this proves nothing");

  // BOTH PROMPTS SURVIVE. A repaired suite is the product of two, and a single
  // field holding whichever came last drops the other silently. The authoring
  // digest is the one `AcceptanceSuite.authoringPromptSha256` has always meant.
  assert.equal(
    authored.suite.authoringPromptSha256,
    row?.promptSha256,
    "the suite must carry the AUTHORING prompt's digest, not the repair prompt's",
  );
  assert.ok(typeof row?.repairPromptSha256 === "string" && row.repairPromptSha256.length > 0);
  assert.notEqual(
    row?.repairPromptSha256,
    row?.promptSha256,
    "the two digests must differ, or one of them is not being recorded",
  );
});

test("an attempt that was not repaired records null, not a stale digest", async () => {
  const spec = new ReplayCaller(SPEC_SEAT, [authoringResponse(CLEAN_SOURCE)]);
  const judge = new ReplayCaller(JUDGE_SEAT, [JUDGE_USABLE]);
  const authored = await generateAuditedSuite(TICKET, {
    specCaller: spec,
    judgeCaller: judge,
    syntaxCheck: false,
  });
  assert.equal(authored.attempts[0]?.repairRounds, 0);
  assert.equal(authored.attempts[0]?.repairPromptSha256, null);
  assert.equal(authored.suite.authoringPromptSha256, authored.attempts[0]?.promptSha256);
});

/**
 * THE FOUR REAL REJECTIONS, REPLAYED FROM `runs.failure_reason`.
 *
 * These strings are not written for this test — they are the blocking problems
 * the harness actually recorded for the four spec-phase deaths in this
 * repository's history, copied out of `dashboard/data/runs.db`. The claim the
 * whole module rests on is that a real rejection names a real artefact, and the
 * only honest way to check it is against real rejections.
 */
const RECORDED_REJECTIONS: readonly { readonly run: string; readonly detail: string; readonly names: string }[] =
  Object.freeze([
    {
      run: "a913c871",
      detail:
        'the suite manifest "suite.manifest.json" is not executable by the sealed scorer: ' +
        "dataExpectations[0].id must be a non-empty string :: Set dataExpectations[0].id.",
      names: "suite.manifest.json",
    },
    {
      run: "0629aa6c",
      detail: 'test file "holdout/site-routes.test.mjs" contains a "not implemented" marker.',
      names: "holdout/site-routes.test.mjs",
    },
    {
      run: "ac275880",
      detail:
        'test file "holdout/motion-and-visuals.spec.mjs" contains credential-shaped literal(s): ' +
        "SECRET_ASSIGNMENT x1. Use an obviously-fake fixture that no redaction rule matches.",
      names: "holdout/motion-and-visuals.spec.mjs",
    },
    {
      run: "aa6e721e",
      detail: "REQ-013: statement matches no EARS template. Use one of: ...",
      names: "REQ-013",
    },
  ]);

test("every rejection this repository has actually recorded is localisable", () => {
  const named = (path: string) => ({
    path,
    visibility: "holdout" as const,
    runner: "node-test" as const,
    description: "d",
    expectedTestIds: [],
    criterionIds: [],
    source: "x",
  });
  const draft: SuiteDraft = {
    ticketId: TICKET.id,
    ticketSha256: TICKET.sha256,
    criteria: [
      {
        id: "REQ-013",
        statement: "The site shall do the thing.",
        evidenceRequired: "e",
        tier: "BLOCKING",
        holdoutTestIds: [],
        visibleTestIds: [],
        evidenceArtifacts: [],
      },
    ],
    files: [
      named("suite.manifest.json"),
      named("holdout/site-routes.test.mjs"),
      named("holdout/motion-and-visuals.spec.mjs"),
    ],
  };

  for (const rejection of RECORDED_REJECTIONS) {
    const targets = repairTargets(
      draft,
      [{ criterionId: null, kind: "other", detail: rejection.detail, mustRegenerate: true }],
      [rejection.detail],
    );
    assert.equal(
      isRepairable(targets),
      true,
      `run ${rejection.run}'s rejection was not localisable, so repair would have declined it`,
    );
    const selected = [...targets.files.map((f) => f.path), ...targets.criteria.map((c) => c.id)];
    assert.deepEqual(
      selected,
      [rejection.names],
      `run ${rejection.run}'s rejection selected ${JSON.stringify(selected)}`,
    );
  }
});

/* -------------------------------------------------------------------------
 * PART 5 — what a repair round COSTS, and what happens when it never returns
 * ---------------------------------------------------------------------- */

/** Charges a fixed price per call, so an attempt's ledger can be added up. */
class CostingCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];
  readonly #script: readonly string[];
  readonly #price: number;

  constructor(seat: AnthropicSeat, script: readonly string[], price: number) {
    super(seat, { budget: AUTHORING_BUDGET, env: { [seat.envKeyName]: SENTINEL } });
    this.#script = script;
    this.#price = price;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    return {
      text: this.#script[this.requests.length - 1] ?? "",
      stopReason: "end_turn",
      usage: { costUsd: this.#price },
    } as unknown as SeatCallResult;
  }
}

/**
 * THE LEDGER MUST COVER FOUR CALLS, NOT ONE.
 *
 * A repaired attempt spends: the authoring call, the first audit's judge call
 * (skipped here — the deterministic pass blocks first), the repair call, and the
 * RE-audit's judge call. `costUsd` on the attempt row is the only per-attempt
 * figure anything reports, and a repair loop that forgot to add its own calls to
 * it would make repaired attempts look cheaper than unrepaired ones — the exact
 * direction that would make the feature look better than it is.
 */
test("an attempt's recorded cost includes the repair call AND the re-audit", async () => {
  const spec = new CostingCaller(
    SPEC_SEAT,
    [authoringResponse(LEAKY_SOURCE), repairResponse(CLEAN_SOURCE)],
    2,
  );
  const judge = new CostingCaller(JUDGE_SEAT, [JUDGE_USABLE], 5);

  const authored = await generateAuditedSuite(TICKET, {
    specCaller: spec,
    judgeCaller: judge,
    syntaxCheck: false,
  });

  assert.equal(spec.requests.length, 2, "authoring call + repair call");
  assert.equal(judge.requests.length, 1, "the first audit blocked deterministically; the re-audit judged");
  assert.equal(
    authored.attempts[0]?.costUsd,
    2 + 2 + 5,
    "the attempt row must carry every call this attempt made",
  );
});

/** Never answers. Used to abandon a repair call on the deadline. */
class HangingRepairCaller extends AnthropicSeatCaller {
  readonly requests: SeatCallRequest[] = [];
  readonly #first: string;

  constructor(seat: AnthropicSeat, first: string) {
    super(seat, { budget: AUTHORING_BUDGET, env: { [seat.envKeyName]: SENTINEL } });
    this.#first = first;
  }

  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    this.requests.push(request);
    // The FIRST call of each attempt answers (the authoring call); every repair
    // call hangs, which is the case under test.
    if (request.purpose.startsWith("suite-authoring")) {
      return { text: this.#first, stopReason: "end_turn", usage: { costUsd: 0 } } as unknown as SeatCallResult;
    }
    return new Promise<SeatCallResult>(() => undefined);
  }
}

/**
 * A REPAIR THAT NEVER RETURNS MUST NOT HANG THE PHASE.
 *
 * The repair call goes through the same `callWithDeadline` the authoring call
 * does, so an abandoned one has to leave the loop, be named on the attempt row,
 * and let the regeneration proceed — the run is no worse off than if repair had
 * never been attempted, which is the whole safety argument for adding it.
 */
test("a repair call abandoned on the deadline stops the loop and is recorded", async () => {
  const spec = new HangingRepairCaller(SPEC_SEAT, authoringResponse(LEAKY_SOURCE));
  const judge = new ReplayCaller(JUDGE_SEAT, []);

  await assert.rejects(
    generateAuditedSuite(TICKET, {
      specCaller: spec,
      judgeCaller: judge,
      syntaxCheck: false,
      attemptTimeoutMs: 150,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BakeoffError);
      // The phase still died of the ORIGINAL defect, not of the repair.
      assert.match(error.message, /credential-shaped literal/);
      assert.match(error.message, /3 round\(s\) fired/);
      return true;
    },
  );

  // Three attempts, each: one authoring call that answered, one repair call that
  // did not. Six in total means no attempt spun on the abandoned repair.
  assert.equal(spec.requests.length, 6);
});

/**
 * THE MIXED CASE, WHICH IS THE ONE THE PREDICATE EXISTS FOR.
 *
 * FOUND BY MUTATION, NOT BY READING (2026-08-12). Deleting the
 * `unlocalised.length === 0` guard from `isRepairable` left all nineteen tests
 * in this file green, because every one of them had findings that ALL localised
 * or findings that NONE did — and in the none case the artefact lists are empty,
 * so the weakened predicate answers `false` anyway and the mutation hides.
 *
 * The case that separates them is one finding naming a file and another naming
 * nothing. Repairing the first would return a suite the second still blocks, so
 * the round buys a rejection at the price of a call. Declining the whole round
 * is the documented behaviour and, until this test, was untested behaviour.
 */
test("a round with ONE unlocalisable finding among localisable ones is declined whole", () => {
  const draft = draftOf(LEAKY_SOURCE);
  const targets = repairTargets(
    draft,
    [
      finding(`test file "${VISIBLE_PATH}" contains credential-shaped literal(s)`),
      finding("the suite gates on nothing a reader would notice"),
    ],
    ["p1", "p2"],
  );

  assert.equal(targets.files.length, 1, "the localisable finding must still select its file");
  assert.deepEqual(targets.unlocalised, ["p2"]);
  assert.equal(
    isRepairable(targets),
    false,
    "a round was dispatched that could not clear every blocking finding, so the re-audit was " +
      "guaranteed to reject it and the call was spent for nothing",
  );
});

test("end to end: a mixed rejection dispatches NO repair call", async () => {
  // The same shape through the real loop: the leak names a file, and a suite
  // with no FUNCTIONAL criterion adds a suite-level finding that names nothing.
  const mixed = JSON.stringify({
    criteria: [CRITERIA[0]],
    testFiles: testFiles(LEAKY_SOURCE).map((f) => {
      const file = f as Record<string, unknown>;
      return file["path"] === HOLDOUT_PATH
        ? { ...file, testIds: ["T-2"], criterionIds: ["REQ-001"], source: HOLDOUT_SOURCE }
        : file;
    }),
  });
  const spec = new ReplayCaller(SPEC_SEAT, [mixed, mixed, mixed]);
  const judge = new ReplayCaller(JUDGE_SEAT, []);

  await assert.rejects(
    generateAuditedSuite(TICKET, { specCaller: spec, judgeCaller: judge, syntaxCheck: false }),
    (error: unknown) => {
      assert.ok(error instanceof BakeoffError);
      assert.match(error.message, /NO round fired/);
      assert.match(error.message, /declined as unlocalisable/);
      return true;
    },
  );
  assert.equal(spec.requests.length, 3, "a repair call was dispatched for a round it could not finish");
});
