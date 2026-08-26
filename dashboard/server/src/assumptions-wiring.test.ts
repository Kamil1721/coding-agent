/**
 * assumptions-wiring.test.ts — does a RUN hand the owner's answers to the tracer?
 *
 * WHY THIS IS A SECOND FILE. `assumptions-answered.test.ts` proves the RULE: given
 * pairs, the right criteria change label and the cheats are refused. It cannot
 * prove that any run ever produces a pair, because it never runs one — it builds
 * the pairs itself and passes them in. On its own it is exactly the shape this
 * repository has shipped green over features that did nothing: delete the
 * argument at the one call site in `orchestrator.ts#recordAssumptions` and every
 * assertion over there still holds.
 *
 * SO THIS DRIVES THE WHOLE `#execute`, the way `run-report.test.ts` does. A run
 * is submitted whose stored ticket text is an AMENDED brief, its `plan.json` is
 * on disk with one answered and one declined question in it, and what is
 * asserted is what the RUN wrote into `assumptions.md`, into the run row, and
 * into its own log.
 *
 * NO QUOTA IS SPENT, AND IT IS GUARDED RATHER THAN ASSUMED — the guard is
 * `run-report.ts`'s and the argument is copied with it. `#specPhase` swallows a
 * failed `assertSuiteIntact` and falls through to authoring a real suite against
 * the owner's subscription, so a suite frozen under the wrong id would spend
 * quota with nothing going red. Two things stop that: the suite is frozen under
 * `ticketFromText(row.ticketText)`, the exact expression the orchestrator uses,
 * `verifySuiteIntact` is asserted BEFORE the run starts, and the run's own log
 * is asserted to say "reusing the sealed acceptance suite". The build phase then
 * dies on `unknown_config` because the model id is not in the catalog, which is
 * after the assumptions file has been written and is not what is under test.
 *
 * ─── MUTATIONS, EACH APPLIED ALONE, WATCHED RED, RESTORED (2026-08-02) ───
 *
 * APPLIED TO `dist/orchestrator.js`, NOT TO THE SOURCE, and that is worth saying
 * out loud rather than hiding: another fleet was editing `orchestrator.ts` while
 * this ran, and a mutate-compile-restore cycle on a file someone else is writing
 * loses their edit. The emitted JS is a direct translation of the four lines
 * concerned, so what each mutation proves is unchanged; what it cannot catch is
 * a source/emit mismatch, and `npx tsc` immediately afterwards is what covers
 * that. Counts are what actually went red across this file and
 * `assumptions-answered.test.ts` run together.
 *
 *  W1  `#recordAssumptions` passes `[]` instead of
 *      `this.#answeredQuestions(runPaths)` — the state this whole change is
 *      about never leaves the disk                                    → 1 red
 *      (the second test stays GREEN, correctly: the log line is emitted from the
 *      record, so only the credited count moves. That is the control on W1.)
 *  W2  `#answeredQuestions` returns `[]` on every call                → 2 red
 *  W3  `#reportAnswersCredited` returns before emitting               → 2 red
 *  W4  `#reportAnswersCredited` suppresses the zero case as well as the
 *      no-question case (`if (answered === 0 || credited === 0) return`)
 *                                                                     → 1 red,
 *      the second test — the run where he answered and nothing was credited
 *
 * ─── AND THE SAME AGAIN FOR THE FIFTH SOURCE (2026-08-04) ───
 *
 * THE THIRD TEST BELOW EXISTS BECAUSE THE HOLE THIS FILE'S HEADER DESCRIBES WAS
 * DUG A SECOND TIME, ONE SOURCE ALONG. `AssumptionSource` gained `reference` and
 * `isStatedByOwner` gained its third case with NOTHING setting the label — the
 * tests over in `spec-assumptions.test.ts` pass the reading in themselves, so
 * they were green against an orchestrator that never read a manifest. Applied to
 * `dist-<slug>/`, not to the source, for the reason W1-W4 give:
 *
 *  W5  `#recordAssumptions` passes `null` instead of
 *      `this.#referenceReading(runId)` — the reading never leaves the disk,
 *      which is the exact state this change found                     → 1 red
 *      (the other two tests stay GREEN, correctly: no manifest is written for
 *      them. That is the control on W5.)
 *  W6  `isStatedByOwner` drops its `reference` case (`assumption.source ===
 *      "reference"` → `false`) — the label is set but counted as a guess, so
 *      `inferredCriteria` reads 2 for a run in which the owner supplied more
 *                                                     → 1 red here, 1 red in
 *      `spec-assumptions.test.ts`
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceSuite } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { acceptanceSuiteDigest, sha256Hex } from "bakeoff/dist/hash.js";
import { freezeSuite, verifySuiteIntact } from "bakeoff/dist/spec-freeze.js";
import { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "bakeoff/dist/spec-types.js";
import type { SuiteDraft } from "bakeoff/dist/spec-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { ModelCatalog } from "./models.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import type { MotionSpec } from "./motion-types.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, ensureRunDirs, resolvePaths, runPathsFor } from "./paths.js";
import { foldPlanIntoBrief } from "./plan-brief.js";
import { writePlanRecord } from "./plan-record.js";
import type { PlanQuestionState, PlanState } from "./plan-state.js";
import { PreviewHost } from "./preview.js";
import { ASSUMPTIONS_FILE } from "./run-report.js";
import { ticketFromStoredReferences } from "./ticket.js";
import type { ReferenceManifest } from "./ticket-refs.js";
import { referenceDirFor, writeReferenceManifest } from "./ticket-refs.js";

const PROSE = "I want a copy of my site, everything on it.";

/* -------------------------------------------------------------------------
 * The harness — `run-report.test.ts`'s, minus the HTTP server it does not need
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
  const dir = mkdtempSync(join(tmpdir(), "dash-assume-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const orchestrator = new Orchestrator({ store, bus, paths, catalog, auth, preview, env: {}, gateReadiness: READY_GATE_READINESS });
  return { dir, store, orchestrator, paths, cleanup: () => { store.close(); removeTree(dir); } };
}

/**
 * Two criteria: one the owner's reply names, one it says nothing about.
 *
 * THE SECOND IS THE CONTROL. A wiring that credited him with everything the
 * moment a plan record existed would satisfy every assertion about the first.
 *
 * THE FIRST STATEMENT IS OVERRIDABLE so the motion test below can put a
 * criterion carrying a MEASURED number where this one puts a criterion carrying
 * his reply. The default is unchanged, so every assertion already in this file
 * is measuring the same run it measured yesterday.
 */
function draftFor(
  ticketId: string,
  ticketSha256: string,
  firstStatement = "The site shall render four project entries with their taglines.",
): SuiteDraft {
  const visible = ["import test from \"node:test\";", "test(\"T-1 the document responds\", () => {});", ""].join("\n");
  const heldOut = ["import test from \"node:test\";", "test(\"T-2 the entries are there\", () => {});", ""].join("\n");
  return {
    ticketId,
    ticketSha256,
    criteria: [
      {
        id: "REQ-001",
        statement: firstStatement,
        evidenceRequired: "holdout test T-2 PASS",
        tier: "FUNCTIONAL",
        holdoutTestIds: ["T-2"],
        visibleTestIds: ["T-1"],
        evidenceArtifacts: [],
      },
      {
        id: "REQ-002",
        statement: "The site shall expose a contact route that accepts a message.",
        evidenceRequired: "holdout test T-2 PASS",
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
    generatedByHarness: { id: "dashboard-assumptions-wiring-test", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("hand-frozen suite. No model was called."),
    generatedAt: now,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: now,
  };
}

function question(id: string, text: string, ifUnanswered: string): PlanQuestionState["question"] {
  return {
    id,
    text,
    ifUnanswered,
    criterionIfDefault: `the run proceeds on: ${ifUnanswered}`,
    criterionIfAnswered: "the run proceeds on what he says instead",
    tier: "FUNCTIONAL",
  };
}

/**
 * One answered question and one DECLINED one, in the state the driver leaves.
 *
 * THE DECLINED QUESTION IS THE SECOND CONTROL, and it is the one that matters
 * most: its `ifUnanswered` names the contact route in the same words as REQ-002,
 * so a wiring that fed the whole record to the tracer instead of the answers
 * would report "you specified it" about the one thing he explicitly refused to
 * decide.
 */
function planStateFor(): PlanState {
  return {
    plan: ["copy the page the ticket names"],
    questions: [
      {
        question: question("PQ-1", "How many project entries should the copy carry, and with taglines?", "four entries"),
        status: "answered",
        answer: {
          text: "Four project entries, with the taglines.",
          quoted: "Four project entries, with the taglines.",
          at: "2026-08-02T09:00:00.000Z",
          attribution: "structural",
          paraphrased: false,
        },
        assumed: null,
      },
      {
        question: question(
          "PQ-2",
          "Should the copy expose a contact route that accepts a message?",
          "the site exposes a contact route that accepts a message",
        ),
        status: "declined",
        answer: null,
        assumed: "the site exposes a contact route that accepts a message",
      },
    ],
    clarifications: [],
    dropped: [],
    proposed: 2,
    turnsUsed: 1,
    closed: { reason: "answered", at: "2026-08-02T09:01:00.000Z", detail: "one answered, one left to the dashboard" },
  };
}

async function waitForTerminal(store: RunStore, runId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = store.getRun(runId);
    if (row !== null && (row.status === "passed" || row.status === "failed" || row.status === "cancelled")) return;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached a terminal status (last: ${row?.status ?? "gone"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function logTextFor(store: RunStore, runId: string): string {
  return store
    .eventsSince(runId, 0)
    .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
    .join("\n");
}

/**
 * Run a run whose plan dialogue is already on disk, and hand back what it wrote.
 *
 * `folded: true` because that is the state a resumed run finds: `PlanDriver` has
 * already amended the brief, so `#planPhase` returns immediately and the stored
 * text is the amended one. Anything else here would be testing the plan phase
 * rather than the record it feeds.
 *
 * THE MANIFEST IS WRITTEN BEFORE THE TICKET IS DERIVED, AND THE SUITE IS FROZEN
 * UNDER THE DERIVED ID RATHER THAN UNDER `ticketFromText`. `orchestrator.ts:1738`
 * reads the manifest and calls `ticketFromStoredReferences`, and a motion
 * reading's URL is folded into the identity material there — so freezing under
 * the prose-only id would miss `assertSuiteIntact` and send `#specPhase` off to
 * author a real suite against the owner's subscription. That is the quota hazard
 * this file's header describes, and the `verifySuiteIntact` assertion below plus
 * the "reusing the sealed acceptance suite" log line are what hold it shut.
 */
async function runWith(
  h: Harness,
  runId: string,
  state: PlanState,
  options: { readonly motion?: MotionSpec; readonly firstStatement?: string } = {},
): Promise<string> {
  const amended = foldPlanIntoBrief(PROSE, state);
  h.store.createRun({
    runId,
    ticketId: "seeded-at-create",
    ticketTitle: "Copy of the site",
    ticketText: amended,
    ticketSha256: "e".repeat(64),
    // NOT IN THE CATALOG: the build phase throws `unknown_config` before any
    // builder subprocess exists, so the run ends without spending anything.
    modelId: "no-such-model",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });

  const runPaths = runPathsFor(h.paths, runId);
  ensureRunDirs(runPaths);
  writePlanRecord(runPaths.results, {
    awaiting: false,
    parkedAt: "2026-08-02T09:00:00.000Z",
    folded: true,
    state,
  });

  const manifest: ReferenceManifest | null =
    options.motion === undefined ? null : { images: [], capture: null, documents: [], motion: options.motion };
  if (manifest !== null) {
    const referenceDir = referenceDirFor(h.paths.runs, runId);
    mkdirSync(referenceDir, { recursive: true });
    writeReferenceManifest(referenceDir, manifest);
  }

  const row = h.store.getRun(runId);
  assert.ok(row !== null);
  // `ticketFromStoredReferences(text, null)` IS `ticketFromText(text)` — the
  // read-back path documents that degradation — so the runs with no manifest
  // freeze under the identical id they froze under before this parameter existed.
  const ticket = ticketFromStoredReferences(row.ticketText, manifest);
  const draft = draftFor(ticket.id, ticket.sha256, options.firstStatement);
  freezeSuite(
    { suite: suiteFrom(draft), plan: planFromDraft(draft), files: draft.files, auditFindings: [] },
    { acceptanceRoot: h.paths.acceptance },
  );
  assert.ok(
    verifySuiteIntact(ticket.id, { acceptanceRoot: h.paths.acceptance }).intact,
    "the hand-frozen suite does not verify, so #specPhase would author a real one against the owner's quota",
  );

  h.orchestrator.pump();
  await waitForTerminal(h.store, runId);
  assert.match(
    logTextFor(h.store, runId),
    /reusing the sealed acceptance suite/,
    "the spec phase did not take the reuse branch, which means it called the spec seat",
  );
  return readFileSync(join(runPaths.results, ASSUMPTIONS_FILE), "utf8");
}

test("a run hands the answers off its own plan.json to the tracer, and says so on its log", async () => {
  const h = harness();
  try {
    const runId = "run-answered";
    const assumptions = await runWith(h, runId, planStateFor());

    // WHAT HE ANSWERED IS CREDITED TO HIM, quoted in his own words.
    assert.match(assumptions, /## ANSWERED BY YOU/);
    assert.match(
      assumptions.slice(assumptions.indexOf("## ANSWERED BY YOU")),
      /REQ-001[\s\S]*Four project entries, with the taglines\./,
      "the criterion his reply names is not credited to him, or is credited without quoting him",
    );

    // AND WHAT HE DECLINED IS NOT. `ifUnanswered` names the contact route in the
    // same words REQ-002 does; only a wiring that fed the record's assumptions
    // to the tracer could move it.
    const inferred = assumptions.slice(
      assumptions.indexOf("## INFERRED"),
      assumptions.indexOf("## ANSWERED BY YOU"),
    );
    assert.match(inferred, /REQ-002/, "'you decide' came back reported as 'you specified it'");

    // THE NUMBER THE PHASE IS JUDGED BY, off the run row rather than recomputed.
    const row = h.store.getRun(runId);
    assert.equal(row?.inferredCriteria, 1, "one criterion is his; the other is still the grader's");
    assert.match(assumptions, /Of 2 criteria: 1 inferred by the grader, 0 house defaults, 0 traced to words you wrote, 1 answered by you when the dashboard asked\./);

    // AND THE RUN SAYS ON ITS LOG WHAT ANSWERING BOUGHT.
    assert.match(
      logTextFor(h.store, runId),
      /you answered 1 question\(s\) before this run was frozen, and 1 of its criteria are credited to those answers/,
    );
  } finally {
    h.cleanup();
  }
});

/**
 * A reading of a page the owner named, as `readReferenceManifest` hands it back.
 *
 * The `h1` entry is the one a criterion below traces to; the `div.card` entry is
 * there so the tracer has to CHOOSE, rather than having one observation and no
 * way to be wrong about which it quoted.
 */
const MOTION: MotionSpec = {
  url: "https://example.com/moves",
  capturedAt: "2026-08-04T00:00:00.000Z",
  entries: [
    {
      family: "load-entrance",
      role: "h1",
      props: ["opacity"],
      durationMs: 800,
      staggerMs: null,
      easing: "ease-out",
      iterations: 1,
      scrollRatio: null,
      parity: true,
    },
    {
      family: "scroll-reveal",
      role: "div.card",
      props: ["opacity", "transform"],
      durationMs: 500,
      staggerMs: 120,
      easing: "ease-out",
      iterations: 1,
      scrollRatio: null,
      parity: true,
    },
  ],
  libraries: ["gsap"],
  respectsReducedMotion: true,
};

test("a run hands the motion reading off its own manifest to the tracer", async () => {
  // THE GAP THIS CLOSES, AND IT IS THE SAME SHAPE AS THE ONE THE HEADER OF THIS
  // FILE DESCRIBES. `AssumptionSource` gained `reference` and `isStatedByOwner`
  // gained its third case on 2026-08-04, and `grep -rn 'source: "reference"'`
  // over the sources returned NOTHING: the bucket was set by no code path, so
  // every criterion authored out of a captured motion block still counted as the
  // grader's guess and the run log still escalated to `warn` about it.
  //
  // `spec-assumptions.test.ts` cannot catch that. It passes the reading in
  // itself, so deleting `this.#referenceReading(runId)` at the one call site in
  // `orchestrator.ts#recordAssumptions` leaves every assertion over there green.
  // This test drives the whole `#execute` and reads what the RUN wrote.
  const h = harness();
  try {
    const runId = "run-motion";
    const assumptions = await runWith(h, runId, planStateFor(), {
      motion: MOTION,
      // Carries `opacity` and `800ms` — both MEASURED off the page, neither
      // anywhere in his prose or in his reply.
      firstStatement: "The hero heading shall fade in opacity over 800ms.",
    });

    // WHAT WAS MEASURED IS CREDITED TO THE PAGE HE CHOSE, and the record names
    // the page and quotes the observation, so the one check it invites — go and
    // look — is one he can run.
    assert.match(assumptions, /## READ FROM THE PAGE YOU REFERENCED/);
    const read = assumptions.slice(assumptions.indexOf("## READ FROM THE PAGE YOU REFERENCED"));
    assert.match(
      read,
      /REQ-001[\s\S]*example\.com\/moves/,
      "the criterion carrying a measured duration is not credited to the page it was read off",
    );
    assert.match(read, /h1 —/, "the record does not quote the observation the spec seat actually read");

    // AND THE OTHER CRITERION IS THE CONTROL. REQ-002 is about a contact route:
    // nothing on that page was measured about it, and a wiring that credited
    // everything the moment a manifest existed would move it too.
    const inferred = assumptions.slice(
      assumptions.indexOf("## INFERRED"),
      assumptions.indexOf("## ANSWERED BY YOU"),
    );
    assert.match(inferred, /REQ-002/, "a criterion the reading says nothing about was credited to it anyway");
    assert.doesNotMatch(inferred, /REQ-001/);

    // THE NUMBER THE FEATURE IS JUDGED BY, off the run row. Without the call
    // site both criteria are the grader's guess and this is 2 — which is the
    // measurement that says whether capturing the page bought anything.
    assert.equal(h.store.getRun(runId)?.inferredCriteria, 1);
    assert.match(assumptions, /1 read from the page you referenced\./);
  } finally {
    h.cleanup();
  }
});

test("a run whose answers matched nothing says so, rather than staying quiet about it", async () => {
  // THE UNFLATTERING CASE, AND IT IS THE ONE WORTH PRINTING. The seat asked, he
  // answered, and no criterion could be traced to what he said — which is the
  // plan phase costing him attention and buying nothing. A log line that
  // appeared only when the number moved would leave that silent, and silence is
  // how this repository has repeatedly shipped features that did nothing.
  const h = harness();
  try {
    const runId = "run-unmatched";
    const base = planStateFor();
    const first = base.questions[0];
    assert.ok(first !== undefined && first.answer !== null);
    const state: PlanState = {
      ...base,
      questions: [
        { ...first, answer: { ...first.answer, text: "up to you really", quoted: "up to you really" } },
        ...base.questions.slice(1),
      ],
    };
    const assumptions = await runWith(h, runId, state);

    assert.match(assumptions, /## ANSWERED BY YOU[^#]*_none_/s, "nothing may be credited to a contentless reply");
    assert.equal(h.store.getRun(runId)?.inferredCriteria, 2);
    assert.match(
      logTextFor(h.store, runId),
      /you answered 1 question\(s\) before this run was frozen, and 0 of its criteria are credited to those answers/,
    );
  } finally {
    h.cleanup();
  }
});
