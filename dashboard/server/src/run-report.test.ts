/**
 * run-report.test.ts — the two files a run leaves behind, and the proof that a
 * RUN writes them rather than a test calling the writer.
 *
 * THE WIRING TEST IS THE POINT OF THIS FILE. Phase 1.1 Task 5 shipped a test
 * that covered an extracted function's body while its call site could be
 * reverted with 229 tests still green, and a "wiring test" elsewhere in this
 * repo grepped source TEXT and stayed green when the code under test was
 * deleted. So `writeAssumptions` and `writeRunVerdict` are never called directly
 * by the tests that claim the run emits these files: those tests drive
 * `Orchestrator.pump()` and `Orchestrator.cancel()` and then look on disk. Both
 * go red when the call site in `#finish` is removed, which is the measurement,
 * not a claim about it.
 *
 * NO QUOTA IS SPENT, AND THAT IS GUARDED RATHER THAN ASSUMED. `#specPhase`
 * wraps `assertSuiteIntact` in `try/catch { existing = null }`, so a frozen
 * suite this file gets slightly wrong — wrong ticket id, wrong digest, wrong
 * acceptance root — would be swallowed and the run would fall through to
 * `authorAndFreezeSuite`, which spawns the real Claude CLI against the owner's
 * subscription. Nothing would fail; quota would simply leave. Two things stop
 * that: the suite is frozen under `ticketFromText(row.ticketText)`, the exact
 * expression the orchestrator uses, and `verifySuiteIntact` is asserted BEFORE
 * the run starts. The run's own log is then asserted to contain "reusing the
 * sealed acceptance suite", which is the reuse branch saying so in its own
 * words.
 *
 * THE HELD-OUT PLANT. The frozen suite's `evidenceRequired` carries a held-out
 * test title, because `contracts.ts` documents that field's own example as
 * "holdout test T-14 PASS AND db-query-7 count >= 1" — it names held-out test
 * ids BY CONTRACT, and it is the field most likely to walk one back out through
 * `results/`, which the UI is served from. The same title is in the held-out
 * file's source. Neither emitted file may contain it.
 *
 * AND ONE OF THE TWO FILES IS PROVED, THE OTHER IS WATCHED. `assumptions.md`
 * renders criterion prose, so the plant reaches it if anything upstream widens:
 * folding `evidenceRequired` into `statement` in `Orchestrator.#recordCriteria`
 * turns this file RED at 1 of 10 (MEASURED 2026-07-29). `verdict.md` on this run
 * is the no-verdict page, which prints no criterion prose at all, so its two
 * assertions cannot fire here and are labelled at the assertion site rather than
 * left to look equally earned. The scored page's leak direction is proved in
 * `verdict.test.ts` instead, against `detail`/`evidenceRef` — fields that exist.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceSuite } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { acceptanceSuiteDigest, sha256Hex } from "bakeoff/dist/hash.js";
import { freezeSuite, verifySuiteIntact } from "bakeoff/dist/spec-freeze.js";
import { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "bakeoff/dist/spec-types.js";
import type { SuiteDraft } from "bakeoff/dist/spec-types.js";
import type { ApiCriterion, RunDetail } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore, isTerminal } from "./db.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { PreviewHost } from "./preview.js";
import {
  ASSUMPTIONS_FILE,
  NO_VERDICT_HEADING,
  VERDICT_FILE,
  assumptionsFor,
  countInferredAssumptions,
  gateProducedResults,
  renderRunVerdict,
} from "./run-report.js";
import { ticketFromText } from "./ticket.js";
import { renderVerdict } from "./verdict.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

/** A title that exists only in the sealed store. It may reach no emitted file. */
const HELD_OUT_TITLE = "renders the hero heading at 1440px";

const TICKET = "portfolio website";

function criterion(
  id: string,
  statement: string,
  tier: ApiCriterion["tier"],
  result: ApiCriterion["result"],
): ApiCriterion {
  return { id, statement, tier, result };
}

/** A run the sealed gate actually scored: results are pass/fail, not pending. */
const SCORED: readonly ApiCriterion[] = [
  criterion("REQ-001", "The system shall serve a document at the root URL.", "BLOCKING", "pass"),
  criterion("REQ-002", "The system shall present at least three project entries.", "FUNCTIONAL", "fail"),
];

const SCORED_CLEAN: readonly ApiCriterion[] = SCORED.map((entry) => ({ ...entry, result: "pass" as const }));

/** The same criteria before the gate ran. Frozen `pending`, never scored. */
const UNSCORED: readonly ApiCriterion[] = SCORED.map((entry) => ({ ...entry, result: "pending" as const }));

/* -------------------------------------------------------------------------
 * The branch inside the single entry point
 * ---------------------------------------------------------------------- */

test("a run the gate scored gets the verdict, and the headline is verdict.ts's", () => {
  const md = renderRunVerdict({
    ticketText: TICKET,
    criteria: SCORED,
    status: "failed",
    failureReason: "the frozen held-out suite did not go green in the sealed container",
  });
  assert.ok(md.startsWith("# DID NOT PASS"), `verdict began ${JSON.stringify(md.slice(0, 40))}`);
  assert.match(md, /three project entries/, "the unmet requirement is named in the owner's words");
  assert.doesNotMatch(md, new RegExp(NO_VERDICT_HEADING));
});

test("a scored run that met everything renders as a pass — the arm that must not be stuck", () => {
  // Without this, a `gateProducedResults` that always returned false, or a
  // branch wired to the no-verdict page, would pass every other test here.
  const md = renderRunVerdict({
    ticketText: TICKET,
    criteria: SCORED_CLEAN,
    status: "passed",
    failureReason: null,
  });
  assert.ok(md.startsWith("# PASSED"), `verdict began ${JSON.stringify(md.slice(0, 40))}`);
  assert.doesNotMatch(md, new RegExp(NO_VERDICT_HEADING));
});

test("a cancelled run is NOT a failed one, even when the gate had already scored it", () => {
  // orchestrator.test.ts: "cancelled is not failed: no verdict was reached".
  // Rendering DID NOT PASS here would be the same conflation the null
  // `heldOutPass` exists to prevent, in the other direction.
  const md = renderRunVerdict({
    ticketText: TICKET,
    criteria: SCORED,
    status: "cancelled",
    failureReason: null,
  });
  assert.ok(md.startsWith(NO_VERDICT_HEADING));
  assert.match(md, /cancelled/i);
  assert.doesNotMatch(md, /^#\s*PASSED/m);
  assert.doesNotMatch(md, /PASSED WITH NOTES/);
  assert.doesNotMatch(md, /DID NOT PASS/);
});

test("a run that ended before the gate ran says so, and names the reason", () => {
  const md = renderRunVerdict({
    ticketText: TICKET,
    criteria: UNSCORED,
    status: "failed",
    failureReason: "[unknown_config] model no-such-model is not available",
  });
  assert.ok(md.startsWith(NO_VERDICT_HEADING));
  assert.match(md, /no-such-model/, "an unactionable failure is the thing this file exists to prevent");
  assert.doesNotMatch(md, /^#\s*PASSED/m);
  assert.doesNotMatch(md, /PASSED WITH NOTES/);
});

test("a run with no criteria at all cannot render as a pass", () => {
  // The catastrophic direction: an empty criteria list makes every
  // `findingCount` zero, and `computeOutcome` over nothing is "pass".
  const md = renderRunVerdict({ ticketText: TICKET, criteria: [], status: "failed", failureReason: null });
  assert.ok(md.startsWith(NO_VERDICT_HEADING));
  assert.doesNotMatch(md, /^#\s*PASSED/m);
  assert.doesNotMatch(md, /PASSED WITH NOTES/);
});

test("the gate-ran predicate discriminates in both directions", () => {
  // A predicate stuck at false sends every run to the no-verdict page and the
  // rendered verdict becomes dead code with a unit test standing over it.
  assert.equal(gateProducedResults(SCORED), true);
  assert.equal(gateProducedResults(SCORED_CLEAN), true);
  assert.equal(gateProducedResults(UNSCORED), false);
  assert.equal(gateProducedResults([]), false, "a run with no criteria never reached the gate");
});

/* -------------------------------------------------------------------------
 * One number, two documents
 * ---------------------------------------------------------------------- */

test("the inferred count reported by the API is the number the verdict prints", () => {
  // Two numbers under one name is how an owner learns to distrust both.
  // `verdict.ts` counts `source !== "ticket"`; so must this.
  const criteria = [
    criterion("REQ-001", "The system shall present a scroll-scrubbed masthead.", "FUNCTIONAL", "pass"),
    criterion("REQ-002", "The system shall present at least three project entries.", "FUNCTIONAL", "pass"),
    criterion("REQ-003", "The system shall expose a contact route that accepts a message.", "FUNCTIONAL", "pass"),
  ];
  const assumptions = assumptionsFor("portfolio website with a contact route", criteria);
  const counted = countInferredAssumptions(assumptions);
  assert.ok(counted > 0, "a thin ticket cannot support three criteria; the fixture is wrong if it does");
  assert.ok(counted <= criteria.length);

  const md = renderVerdict({
    ticket: "portfolio website with a contact route",
    criteriaResults: criteria.map((entry) => ({
      criterionId: entry.id,
      tier: entry.tier,
      passed: true,
      evidenceRef: null,
      detail: null,
    })),
    qualityFindings: [],
    assumptions,
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
  });
  assert.match(
    md,
    new RegExp(`${String(counted)} of ${String(criteria.length)} criteria were inferred`),
    `the verdict and RunDetail.inferredCriteria disagree: the API would report ${String(counted)}`,
  );
});

/* -------------------------------------------------------------------------
 * The wiring: a RUN writes these files
 * ---------------------------------------------------------------------- */

interface Harness {
  readonly dir: string;
  readonly store: RunStore;
  readonly orchestrator: Orchestrator;
  readonly paths: ReturnType<typeof resolvePaths>;
  cleanup(): void;
}

/** `freezeSuite` writes 0444, so a plain rmSync cannot always remove the tree. */
function removeTree(dir: string): void {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* best effort; rmSync reports the real problem with the real path */
  }
  rmSync(dir, { recursive: true, force: true });
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dash-report-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const orchestrator = new Orchestrator({ store, bus, paths, catalog, auth, preview, env: {} });
  return {
    dir,
    store,
    orchestrator,
    paths,
    cleanup: () => {
      store.close();
      removeTree(dir);
    },
  };
}

function draftFor(ticketId: string, ticketSha256: string): SuiteDraft {
  // No "holdout/" substring anywhere in the visible source: `spec-freeze.ts`
  // refuses to hand a builder a visible file that names the held-out half.
  const visible = ["import test from \"node:test\";", "test(\"T-1 the document responds\", () => {});", ""].join("\n");
  const heldOut = ["import test from \"node:test\";", `test("T-2 ${HELD_OUT_TITLE}", () => {});`, ""].join("\n");
  const evidence = `holdout test T-2 PASS — "${HELD_OUT_TITLE}"`;
  return {
    ticketId,
    ticketSha256,
    criteria: [
      {
        id: "REQ-001",
        statement: "The system shall serve a document at the root URL.",
        evidenceRequired: evidence,
        tier: "BLOCKING",
        holdoutTestIds: ["T-2"],
        visibleTestIds: ["T-1"],
        evidenceArtifacts: [],
      },
      {
        id: "REQ-002",
        statement: "The system shall present at least three project entries.",
        evidenceRequired: evidence,
        tier: "FUNCTIONAL",
        holdoutTestIds: ["T-2"],
        visibleTestIds: [],
        evidenceArtifacts: [],
      },
    ],
    files: [
      {
        path: "visible/smoke.test.mjs",
        visibility: "visible",
        runner: "node-test",
        description: "the visible twin",
        expectedTestIds: ["T-1"],
        criterionIds: ["REQ-001"],
        source: visible,
      },
      {
        path: "holdout/acceptance.test.mjs",
        visibility: "holdout",
        runner: "node-test",
        description: "the held-out half",
        expectedTestIds: ["T-2"],
        criterionIds: ["REQ-001", "REQ-002"],
        source: heldOut,
      },
    ],
  };
}

function suiteFrom(draft: SuiteDraft): AcceptanceSuite {
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
    generatedByHarness: { id: "dashboard-run-report-test", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("phase 2e task 5: hand-frozen suite. No model was called."),
    generatedAt: now,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: now,
  };
}

async function waitForTerminal(store: RunStore, runId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = store.getRun(runId);
    if (row !== null && isTerminal(row.status)) return;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached a terminal status (last: ${row?.status ?? "gone"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a run emits assumptions.md at spec exit and verdict.md at the end, and RunDetail carries both", async () => {
  const h = harness();
  const runId = "run-wire";
  let close: (() => Promise<void>) | null = null;
  try {
    h.store.createRun({
      runId,
      ticketId: "seeded-at-create",
      ticketTitle: "Portfolio",
      ticketText: TICKET,
      ticketSha256: "e".repeat(64),
      // NOT IN THE CATALOG. The build phase throws `unknown_config` before any
      // builder subprocess exists, so the run ends without spending anything.
      modelId: "no-such-model",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });

    // Frozen under the id the ORCHESTRATOR will derive, from the text as
    // STORED (redaction runs on the way in and a changed byte is a changed
    // ticket id). Getting this wrong is silently swallowed by `#specPhase` and
    // spends the owner's subscription, so it is verified below rather than
    // assumed.
    const row = h.store.getRun(runId);
    assert.ok(row !== null);
    const ticket = ticketFromText(row.ticketText);
    const draft = draftFor(ticket.id, ticket.sha256);
    const suite = suiteFrom(draft);
    freezeSuite(
      { suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [] },
      { acceptanceRoot: h.paths.acceptance },
    );
    const intact = verifySuiteIntact(ticket.id, { acceptanceRoot: h.paths.acceptance });
    assert.ok(
      intact.intact,
      "the hand-frozen suite does not verify, so #specPhase would swallow the mismatch and author a " +
        "real one against the owner's subscription",
    );

    const bus = new RunEventBus(h.store);
    const server = createDashboardServer({
      store: h.store,
      bus,
      orchestrator: h.orchestrator,
      catalog: new ModelCatalog(
        new AuthProbe({ claudeBin: join(h.dir, "absent"), codexBin: join(h.dir, "absent") }),
        {},
        async () => [],
      ),
      auth: new AuthProbe({ claudeBin: join(h.dir, "absent"), codexBin: join(h.dir, "absent") }),
      paths: h.paths,
    });
    await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
    const base = `http://${LOOPBACK_HOST}:${String((server.address() as AddressInfo).port)}`;
    close = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    h.orchestrator.pump();
    await waitForTerminal(h.store, runId);

    /* ---- the reuse branch ran; nothing was authored ---- */
    const logText = h.store
      .eventsSince(runId, 0)
      .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
      .join("\n");
    assert.match(
      logText,
      /reusing the sealed acceptance suite/,
      "the spec phase did not take the reuse branch, which means it called the spec seat",
    );

    /* ---- the two files are on disk ---- */
    const results = runPathsFor(h.paths, runId).results;
    const assumptionsPath = join(results, ASSUMPTIONS_FILE);
    const verdictPath = join(results, VERDICT_FILE);
    assert.ok(existsSync(assumptionsPath), `the run wrote no ${ASSUMPTIONS_FILE}`);
    assert.ok(existsSync(verdictPath), `the run wrote no ${VERDICT_FILE}`);

    const assumptions = readFileSync(assumptionsPath, "utf8");
    const verdict = readFileSync(verdictPath, "utf8");

    /* ---- RunDetail, over the real HTTP contract ---- */
    const detail = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as RunDetail;
    assert.equal(typeof detail.inferredCriteria, "number");
    assert.equal(typeof detail.verdictPath, "string");
    assert.equal(detail.verdictPath, verdictPath, "the reported path is the file that was written");
    assert.equal(
      detail.inferredCriteria,
      detail.criteria.length,
      "a two-word ticket cannot support any criterion; every one of them is the grader's",
    );
    assert.equal(detail.criteria.length, 2, "the frozen suite's criteria reached the run");

    /* ---- the verdict is honest about not being one ---- */
    assert.ok(
      verdict.startsWith(NO_VERDICT_HEADING),
      `verdict began ${JSON.stringify(verdict.slice(0, 60))} — this run never reached the gate`,
    );
    assert.doesNotMatch(verdict, /^#\s*PASSED/m, "a run that never reached the gate must never read as a pass");
    assert.doesNotMatch(verdict, /PASSED WITH NOTES/);
    assert.match(verdict, /no-such-model/, "the reason a run produced no verdict is the actionable half");

    /* ---- the assumption record leads with the inferences ---- */
    assert.match(assumptions, /INFERRED/);
    assert.ok(
      assumptions.indexOf("INFERRED") < assumptions.indexOf("FROM YOUR TICKET"),
      "the inferences are what needs review; they lead",
    );
    assert.match(assumptions, /three project entries/, "every criterion is accounted for");

    /* ---- NOTHING HELD OUT LEAKED ----
     *
     * TWO FILES, AND THEY ARE NOT EQUALLY VERIFIED. That is written out, and the
     * loop that used to cover both was split, because four `doesNotMatch` calls
     * under one heading read as four guards of the same standing and only two of
     * them can currently fire. Which two was MEASURED, not reasoned about.
     */

    /* assumptions.md — MUTATION-PROVEN, at the seam that carries the leak.
     *
     * The seam is NOT `forAssumptions` in run-report.ts. Passing the source
     * criterion's `evidenceRequired` through there instead of blanking it to ""
     * leaves all ten tests in this file GREEN, because `ApiCriterion` has no
     * `evidenceRequired` field for a value to arrive on: that blank is a
     * TYPE-LEVEL INVARIANT, not a guard anything watches.
     *
     * The seam is `Orchestrator.#recordCriteria`, which is where the frozen
     * suite's `AcceptanceCriterion` — evidenceRequired and all — is narrowed to
     * the `ApiCriterion` rows the store keeps. MEASURED 2026-07-29: folding
     * `evidenceRequired` into `statement` there turns this test RED, 1 of 10,
     * with "assumptions.md contains a held-out test title, which results/ serves
     * to the UI", and the emitted record carries both the title and `holdout
     * test T-2` in the criterion prose under INFERRED. Restored; orchestrator.ts
     * sha256 28d42703… before and after, `git diff HEAD` on it empty.
     */
    assert.doesNotMatch(
      assumptions,
      new RegExp(HELD_OUT_TITLE),
      `${ASSUMPTIONS_FILE} contains a held-out test title, which results/ serves to the UI`,
    );
    assert.doesNotMatch(
      assumptions,
      /holdout test T-2/,
      `${ASSUMPTIONS_FILE} carries evidenceRequired, which names held-out ids`,
    );

    /* verdict.md — NOT EXERCISED BY THIS RUN. A regression detector, not evidence.
     *
     * This run never reaches the gate (`no-such-model`), so `renderRunVerdict`
     * takes the no-verdict branch, and `renderNoVerdict` prints the ticket and
     * boilerplate and NO criterion prose at all — there is nothing for a
     * criterion-borne leak to ride in on. MEASURED rather than assumed: rendering
     * that page from criteria whose statements carried BOTH the held-out title
     * and `holdout test T-2` produced 807 bytes containing neither (753 for the
     * cancelled arm), while the same criteria marked scored produced 1879 bytes
     * containing both.
     *
     * So these two stay — they go live the day this run reaches the gate, or the
     * day the no-verdict page starts listing criteria — but they are not what
     * proves the boundary holds. THE MUTATION-PROVEN GUARD FOR THE SCORED PAGE IS
     * `verdict.test.ts`, "the verdict NEVER contains a held-out test title",
     * which plants the leak in `CriterionResult.detail` and `evidenceRef` —
     * fields that exist on that type, so a value can actually arrive on them.
     */
    assert.doesNotMatch(
      verdict,
      new RegExp(HELD_OUT_TITLE),
      `${VERDICT_FILE} contains a held-out test title, which results/ serves to the UI`,
    );
    assert.doesNotMatch(
      verdict,
      /holdout test T-2/,
      `${VERDICT_FILE} carries evidenceRequired, which names held-out ids`,
    );

    /* ---- the stream said so, before it said the run ended ---- */
    const events = h.store.eventsSince(runId, 0);
    const verdictEvents = events.filter((entry) => entry.event.type === "verdict");
    assert.equal(verdictEvents.length, 1, "one verdict, announced once");
    const announced = verdictEvents[0];
    assert.ok(announced !== undefined && announced.event.type === "verdict");
    assert.equal(announced.event.verdictPath, detail.verdictPath);
    assert.equal(announced.event.inferredCriteria, detail.inferredCriteria);
    const terminalStatus = events.find(
      (entry) => entry.event.type === "status" && isTerminal(entry.event.status),
    );
    assert.ok(terminalStatus !== undefined);
    assert.ok(
      announced.seq < terminalStatus.seq,
      "a client revalidates on a terminal status; the verdict must already be in the read model",
    );
  } finally {
    if (close !== null) await close();
    await h.orchestrator.shutdown();
    h.cleanup();
  }
});

test("cancelling a queued run writes a verdict that cannot be read as a pass", async () => {
  // The run directory does not exist yet — this run never started — so this
  // also covers the path where the results directory has to be created.
  const h = harness();
  try {
    h.store.createRun({
      runId: "run-cancelled",
      ticketId: "t-cancelled",
      ticketTitle: "Portfolio",
      ticketText: TICKET,
      ticketSha256: "f".repeat(64),
      modelId: "no-such-model",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
    await h.orchestrator.shutdown(); // nothing may start; the cancel is under test

    assert.equal(h.orchestrator.cancel("run-cancelled"), true);

    const row = h.store.getRun("run-cancelled");
    assert.ok(row !== null);
    assert.notEqual(row.verdictPath, "", "a cancelled run still leaves a page saying what happened");
    assert.ok(existsSync(row.verdictPath));
    const verdict = readFileSync(row.verdictPath, "utf8");
    assert.ok(verdict.startsWith(NO_VERDICT_HEADING));
    assert.doesNotMatch(verdict, /^#\s*PASSED/m, "cancelled is not passed");
    assert.doesNotMatch(verdict, /PASSED WITH NOTES/);
    assert.doesNotMatch(verdict, /DID NOT PASS/, "cancelled is not failed either");
    assert.equal(row.heldOutPass, null, "and no verdict was invented for it");
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * The migration
 * ---------------------------------------------------------------------- */

test("a database written before these columns existed gains them on open", () => {
  // Every other test in this repo starts from `mkdtemp`, so `CREATE TABLE IF
  // NOT EXISTS` always includes the new columns and the migration is never
  // exercised. The owner's dashboard/data/runs.db predates them: without this,
  // a green suite would sit beside a server that throws "column absent" on the
  // first read.
  const dir = mkdtempSync(join(tmpdir(), "dash-migrate-"));
  try {
    const databasePath = join(dir, "old.db");
    const old = RunStore.open(databasePath);
    old.createRun({
      runId: "run-old",
      ticketId: "t-old",
      ticketTitle: "Portfolio",
      ticketText: TICKET,
      ticketSha256: "a".repeat(64),
      modelId: "default",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
    old.close();

    // Drop the two columns to reproduce the pre-Phase-2e schema exactly.
    // `DROP COLUMN` is a real ALTER in SQLite 3.35+, which Node 24 ships.
    const stripper = new DatabaseSync(databasePath);
    stripper.exec("ALTER TABLE runs DROP COLUMN inferred_criteria");
    stripper.exec("ALTER TABLE runs DROP COLUMN verdict_path");
    const columns = stripper
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((row) => String(row["name"]));
    assert.ok(!columns.includes("verdict_path"), "the fixture did not actually reproduce the old schema");
    stripper.close();

    const migrated = RunStore.open(databasePath);
    try {
      const row = migrated.getRun("run-old");
      assert.ok(row !== null, "the pre-existing run must still be readable");
      assert.equal(row.inferredCriteria, 0, "nothing was assumed on a run that predates the record");
      assert.equal(row.verdictPath, "", "and no verdict path may be invented for it");
      // The columns are writable, not merely present.
      const updated = migrated.updateRun("run-old", { inferredCriteria: 4, verdictPath: "/tmp/verdict.md" });
      assert.equal(updated.inferredCriteria, 4);
      assert.equal(updated.verdictPath, "/tmp/verdict.md");
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
