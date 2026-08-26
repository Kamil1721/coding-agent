/**
 * orchestrator.design-reuse.test.ts — BOTH ARMS of the reused design lane, driven
 * through a real `Orchestrator` against a real workspace.
 *
 * ─── WHY BOTH ARMS ARE IN ONE FILE, AND WHY THE SECOND ONE EXISTS ───
 *
 * The reuse arm's headline assertion is a NEGATIVE — no image was generated — and
 * a negative is satisfied by a lane that cannot generate at all. The two arms run
 * the SAME harness, the SAME ticket and the SAME fake builder, differing only in
 * whether the marker file is on disk, so:
 *
 *   reuse arm   — the builder is asked for ONE segment, a BUILD segment, and the
 *                 image script is never named in a tool call.
 *   control arm — the builder is asked for a DESIGN segment first, and the image
 *                 script IS named: `design-lane.json` comes back `mode: "full"`
 *                 with a non-zero `imageCalls`.
 *
 * Without the control, a lane wired to skip the design segment unconditionally
 * would pass every assertion in the reuse arm.
 *
 * ─── WHAT "ZERO IMAGE CALLS" IS MEASURED ON ───
 *
 * `#buildPhase` counts a generation when a design segment's tool summary names the
 * image script's basename. The fake builder below emits exactly that tool event on
 * a design segment, so the counter is live in this harness — proved by the control
 * arm's non-zero count — and the reuse arm's zero is therefore a measurement
 * rather than the absence of an instrument.
 *
 * ─── THE NUMBERS ───
 *
 * The source fixture is `run-2026-08-12T09-00-35-066Z-6ec44b2f`'s measured shape:
 * 11 stills over 3 directions, one locked (`"images": 11, "imageCalls": 5` in that
 * run's `results/design-lane.json`). The reuse arm inherits all 11 and spends 0.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceSuite } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { acceptanceSuiteDigest, sha256Hex } from "bakeoff/dist/hash.js";
import { freezeSuite, verifySuiteIntact } from "bakeoff/dist/spec-freeze.js";
import { WORKSPACE } from "bakeoff/dist/runner.js";
import { SUITE_MANIFEST_PATH, criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "bakeoff/dist/spec-types.js";
import type { SuiteDraft } from "bakeoff/dist/spec-types.js";
import type { SseEvent } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import type { BuildOutcome, BuildRequest, SubscriptionBuilder } from "./builders/types.js";
import { NOT_RATE_LIMITED } from "./claude-common.js";
import { RunStore, isTerminal } from "./db.js";
import { readDesignLock } from "./design-lock.js";
import type { DesignManifest } from "./design-manifest.js";
import { readDesignManifest, refsDirFor, writeDesignManifest } from "./design-manifest.js";
import { readDesignLaneRecord } from "./design-outcome.js";
import { FIXTURE_IMAGE_COUNT, FIXTURE_PNG, writeReusableDesign } from "./design-reuse-fixture.js";
import { copyDesignAssets, validateDesignReuseSource, writeDesignReuseMarker } from "./design-reuse.js";
import { ModelCatalog } from "./models.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import type { CatalogEntry } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { ticketFromText } from "./ticket.js";
import { zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";

const SOURCE_RUN_ID = "run-2026-08-12T09-00-35-066Z-6ec44b2f";
const RUN_ID = "run-reuse-under-test";
const TICKET = "Build a portfolio page; make the design feel considered, not templated";
const IMAGE_SCRIPT_NAME = "gemini-image.sh";
/** The first line of `designSegmentPrompt`, which is how the fake reads the stage. */
const DESIGN_PROMPT_PREFIX = "DESIGN LANE — art direction";

class FakeCatalog extends ModelCatalog {
  override async resolve(): Promise<CatalogEntry | null> {
    return {
      option: {
        id: "default",
        label: "fake builder",
        provider: "anthropic",
        tier: "included",
        available: true,
        reason: null,
      },
      effort: null,
    };
  }
}

/**
 * A builder that draws when it is asked to draw — and says so through the ONE seam
 * the orchestrator counts generations on.
 *
 * IT KEYS ON THE PROMPT, NOT ON THE CALL INDEX. A fixture that counted calls would
 * agree with the orchestrator's own loop by construction and could not observe it
 * skipping — or failing to skip — the design segment, which is the entire question
 * this file asks.
 */
class DrawingBuilder implements SubscriptionBuilder {
  readonly provider = "anthropic" as const;
  readonly prompts: string[] = [];
  /** Every `-o` target the fake "generated". Empty means nothing was drawn. */
  readonly generated: string[] = [];
  readonly #workspace: () => string;

  constructor(workspace: () => string) {
    this.#workspace = workspace;
  }

  get designSegments(): number {
    return this.prompts.filter((prompt) => prompt.startsWith(DESIGN_PROMPT_PREFIX)).length;
  }

  async build(request: BuildRequest): Promise<BuildOutcome> {
    const index = this.prompts.length;
    this.prompts.push(request.prompt);
    request.sink.session(request.resumeSessionId ?? `session-${String(index)}`);

    if (request.prompt.startsWith(DESIGN_PROMPT_PREFIX)) this.#draw(request);
    else this.#declareDone();

    const tokens: TokenTotals = { ...zeroTokens("anthropic"), inputTokens: 1, callCount: 1 };
    request.sink.tokens(tokens);
    return {
      sessionId: request.resumeSessionId ?? `session-${String(index)}`,
      tokens,
      rateLimit: NOT_RATE_LIMITED,
      completed: true,
      cancelled: false,
      failure: null,
    };
  }

  /**
   * FIVE STILLS AND A MANIFEST — the single-direction shape, so the lane settles in
   * ONE design segment (`designPostSegmentAction` → `mockup-choice` → the auto
   * lock) rather than canvassing and expanding. The two-stage lane is measured in
   * `orchestrator.test.ts`; what this file needs is a control arm that GENERATES.
   */
  #draw(request: BuildRequest): void {
    const workspace = this.#workspace();
    const refsDir = refsDirFor(workspace);
    mkdirSync(refsDir, { recursive: true });
    const refs = [];
    for (const [index, section] of ["hero", "work", "about", "contact", "footer"].entries()) {
      const path = join(refsDir, `0${String(index + 1)}-${section}.png`);
      writeFileSync(path, FIXTURE_PNG);
      this.generated.push(path);
      // THE SEAM THE ORCHESTRATOR COUNTS ON. `#buildPhase` increments its image
      // counter when a design segment's tool summary contains the image script's
      // basename, so this is what makes `imageCalls` non-zero in the control arm.
      request.sink.tool("Bash", `${IMAGE_SCRIPT_NAME} "a ${section}" -a 16:9 -o ${path}`);
      refs.push({
        path,
        section,
        aspect: "16:9" as const,
        intent: `the ${section}`,
        direction: null,
        origin: null,
      });
    }
    const manifest: DesignManifest = {
      version: 1,
      refs,
      directions: [],
      chosenDirection: null,
      directionChoice: null,
      lockedMockup: null,
      lockedBy: null,
      lockedReason: null,
      lockedAt: null,
    };
    writeDesignManifest(workspace, manifest);
    writeFileSync(join(refsDir, "direction.md"), "# freshly art-directed\n", "utf8");
  }

  #declareDone(): void {
    const workspace = this.#workspace();
    writeFileSync(join(workspace, "index.html"), "<!doctype html><title>fixture</title>", "utf8");
    const reportPath = join(workspace, WORKSPACE.selfReport);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ status: "done", reason: "the fake builder finished" }), "utf8");
  }
}

/** A hand-frozen suite, so the spec phase never calls a model. */
function freezeFor(ticketText: string, acceptanceRoot: string): void {
  const ticket = ticketFromText(ticketText);
  const draft: SuiteDraft = {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [
      {
        id: "REQ-001",
        statement: "The system shall serve a document at the root URL.",
        evidenceRequired: "holdout test T-2 PASS",
        tier: "BLOCKING",
        holdoutTestIds: ["T-2"],
        visibleTestIds: ["T-1"],
        evidenceArtifacts: [],
      },
    ],
    files: [
      {
        path: SUITE_MANIFEST_PATH,
        visibility: "holdout",
        runner: "node-test",
        description: "the scorer execution contract",
        expectedTestIds: [],
        criterionIds: [],
        source: JSON.stringify({
          manifestVersion: 1,
          ticketId: ticket.id,
          target: "web",
          execution: {
            install: null,
            build: null,
            typecheck: null,
            lint: null,
            start: null,
            port: null,
            healthPath: null,
            bootTimeoutMs: null,
            commandTimeoutMs: null,
          },
          sourceDirs: ["."],
          uiFlows: [],
          dataExpectations: [],
        }),
      },
      {
        path: "visible/smoke.test.mjs",
        visibility: "visible",
        runner: "node-test",
        description: "the visible twin",
        expectedTestIds: ["T-1"],
        criterionIds: ["REQ-001"],
        source: 'import test from "node:test";\ntest("T-1 the document responds", () => {});\n',
      },
      {
        path: "holdout/acceptance.test.mjs",
        visibility: "holdout",
        runner: "node-test",
        description: "the held-out half",
        expectedTestIds: ["T-2"],
        criterionIds: ["REQ-001"],
        source: 'import test from "node:test";\ntest("T-2 the page renders", () => {});\n',
      },
    ],
  };
  const criteria = criteriaFromDraft(draft);
  const testFiles = testFileRefsFromDraft(draft);
  const now = new Date().toISOString();
  const suite: AcceptanceSuite = {
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
    generatedByHarness: { id: "dashboard-design-reuse-test", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("design reuse: hand-frozen suite. No model was called."),
    generatedAt: now,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: now,
  };
  freezeSuite({ suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [] }, { acceptanceRoot });
  assert.ok(verifySuiteIntact(ticket.id, { acceptanceRoot }).intact, "the hand-frozen suite must verify");
}

interface Harness {
  readonly builder: DrawingBuilder;
  readonly paths: ReturnType<typeof resolvePaths>;
  readonly runPaths: ReturnType<typeof runPathsFor>;
  readonly sourcePaths: ReturnType<typeof runPathsFor>;
  /**
   * Every command the INJECTED image runner was asked to run.
   *
   * THE SEAM THE TASK ASKED FOR, AND IT IS NOT THE BUILDER'S BOOKKEEPING. `designRun`
   * is what `designPreflight` spawns `npx` and `python3` through and what
   * `#renderOnDemand` generates through, so an empty list is the host itself never
   * having reached for the image chain — a stronger negative than a fake builder
   * reporting that it drew nothing, because the fake decides that from the prompt it
   * was handed.
   */
  readonly runnerCalls: string[];
  /** Every `log` line the run emitted, in order. */
  logs(): readonly string[];
  cleanup(): void;
}

/**
 * One run, driven to a stop.
 *
 * THE ENVIRONMENT IS THE RUN'S OWN, never the machine's: `HOME` is a temp
 * directory, so `geminiKeyAvailable` cannot read the owner's real
 * `~/.gemini/api_key`, and `DASHBOARD_GEMINI_IMAGE_SCRIPT` points at a stub that
 * exits 0. `GEMINI_API_KEY` is a fixture string, which is what puts the CONTROL
 * arm in `full` mode. No `PATH`, so the sealed gate cannot find docker and stops
 * on infra rather than scoring a container for ten minutes.
 */
async function runOnce(options: {
  readonly reuse: boolean;
  /** Runs after the row and the marker exist, BEFORE the run starts. */
  readonly beforePump?: (runPaths: ReturnType<typeof runPathsFor>, sourcePaths: ReturnType<typeof runPathsFor>) => void;
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-reuse-orch-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const script = join(dir, IMAGE_SCRIPT_NAME);
  writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(script, 0o755);

  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new FakeCatalog(auth, {}, async () => []);

  const sourcePaths = runPathsFor(paths, SOURCE_RUN_ID);
  writeReusableDesign(sourcePaths);

  const runPaths = runPathsFor(paths, RUN_ID);
  const builder = new DrawingBuilder(() => runPaths.workspace);
  const runnerCalls: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: {
      HOME: home,
      DASHBOARD_GEMINI_IMAGE_SCRIPT: script,
      GEMINI_API_KEY: "not-a-real-key-fixture",
    },
    gateReadiness: READY_GATE_READINESS,
    makeBuilder: () => builder,
    // THE INJECTED IMAGE RUNNER. The real preflight spawns `npx impeccable`, which
    // reaches a registry; this records every command instead, so "the image runner
    // was never invoked" is a measurement rather than an inference.
    designRun: async (command: string, args: readonly string[]) => {
      runnerCalls.push([command, ...args].join(" "));
      return { code: 0, stderr: "" };
    },
    designCanWrite: () => true,
  });

  freezeFor(TICKET, paths.acceptance);
  const ticket = ticketFromText(TICKET);
  store.createRun({
    runId: RUN_ID,
    ticketId: ticket.id,
    ticketTitle: "Portfolio",
    ticketText: TICKET,
    ticketSha256: ticket.sha256,
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    designLock: "auto",
    interactive: false,
  });
  // THE MARKER, EXACTLY AS `POST /api/runs` WRITES IT. The route's own half is
  // measured in `api-reuse-design.test.ts`; this file starts from the file on disk.
  if (options.reuse) {
    writeDesignReuseMarker(runPaths.root, { sourceRunId: SOURCE_RUN_ID, requestedAt: new Date().toISOString() });
  }

  options.beforePump?.(runPaths, sourcePaths);

  orchestrator.pump();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = store.getRun(RUN_ID);
    if (row !== null && (isTerminal(row.status) || row.status === "awaiting_input")) break;
    if (Date.now() > deadline) throw new Error(`the run never settled (status: ${row?.status ?? "gone"})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return {
    builder,
    paths,
    runPaths,
    sourcePaths,
    runnerCalls,
    logs: () =>
      store
        .eventsSince(RUN_ID, 0)
        .map((stored) => stored.event as SseEvent)
        .filter((event): event is Extract<SseEvent, { type: "log" }> => event.type === "log")
        .map((event) => event.text),
    cleanup: () => {
      store.close();
      // `freezeSuite` writes 0444, so a plain rmSync cannot always remove the tree.
      try {
        execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
      } catch {
        /* best effort */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------
 * ARM 1 — the run reuses
 * ---------------------------------------------------------------------- */

test("REUSE: every file is copied, ZERO images are generated, and no design segment runs", async () => {
  const h = await runOnce({ reuse: true });
  try {
    assert.equal(
      h.builder.designSegments,
      0,
      `a reused lane must never run a design segment; prompts were ${JSON.stringify(
        h.builder.prompts.map((p) => p.slice(0, 40)),
      )}`,
    );
    assert.deepEqual(h.builder.generated, [], "the builder was never asked to draw, so it drew nothing");
    // THE INJECTED RUNNER, WHICH IS THE HOST'S OWN SEAM AND NOT THE FAKE'S. Empty
    // means the orchestrator never spawned the image chain at all — and it also
    // measures the claim in `#designLaneFor`'s docblock that a reused run skips the
    // preflight, which runs `python3` and `npx impeccable` through this same
    // function. The control arm below asserts the seam is live.
    assert.deepEqual(
      h.runnerCalls,
      [],
      `the image runner must never be invoked on a reused run; it was asked to run ${JSON.stringify(h.runnerCalls)}`,
    );

    const record = readDesignLaneRecord(h.runPaths.results);
    assert.equal(record?.imageCalls, 0, "THE POINT OF THE FEATURE: no generation was attempted");
    assert.equal(record?.images, FIXTURE_IMAGE_COUNT, "all eleven of the source's stills landed");

    // EVERY FILE, not just the stills: the notes, `direction.md` and the choice
    // file are what the handoff and the panel read.
    const refsDir = refsDirFor(h.runPaths.workspace);
    for (const name of ["direction.md", "direction-choice.json", "direction-desk-scatter.md", "manifest.json"]) {
      assert.equal(existsSync(join(refsDir, name)), true, `${name} did not cross`);
    }
  } finally {
    h.cleanup();
  }
});

test("REUSE: the lane record names the SOURCE RUN and says the mode is `reused`", async () => {
  const h = await runOnce({ reuse: true });
  try {
    const record = readDesignLaneRecord(h.runPaths.results);
    assert.notEqual(record, null, "a reused run must leave a lane record — a missing file is not an answer");
    assert.equal(record?.mode, "reused", "a run that copied its art must never read as one that made it");
    assert.equal(record?.reusedFrom, SOURCE_RUN_ID, "and it must name WHICH run the art came from");
    assert.equal(record?.failure, null, "a complete copy is not a failure");
    assert.match(String(record?.detail), new RegExp(SOURCE_RUN_ID), "the sentence names the source too");
    assert.match(
      String(record?.detail),
      /not.*evidence about a design lane|did not art-direct/,
      "the record must say what this run's verdict is NOT evidence of",
    );
  } finally {
    h.cleanup();
  }
});

test("REUSE: the lock points INSIDE this run's own workspace — asserted by path, in both records", async () => {
  const h = await runOnce({ reuse: true });
  try {
    const mine = refsDirFor(h.runPaths.workspace);
    const theirs = refsDirFor(h.sourcePaths.workspace);

    const manifest = readDesignManifest(h.runPaths.workspace);
    assert.notEqual(manifest, null, "the copied manifest must parse against THIS workspace");
    assert.ok(
      String(manifest?.lockedMockup).startsWith(mine),
      `the manifest's lock is ${String(manifest?.lockedMockup)}, which is not inside ${mine}`,
    );
    assert.equal(existsSync(String(manifest?.lockedMockup)), true, "and the file it names is on disk");
    assert.ok(!String(manifest?.lockedMockup).startsWith(theirs), "it must not be the SOURCE run's file");

    const lock = readDesignLock(h.runPaths.results);
    assert.ok(
      String(lock?.locked).startsWith(mine),
      `design-lock.json's locked is ${String(lock?.locked)}, which belongs to another run`,
    );
    assert.equal(lock?.locked, manifest?.lockedMockup, "the record and the manifest must name the SAME still");
    assert.equal(lock?.expanded, true, "the design is settled; a reused run is not still expanding");
    assert.equal(lock?.chosenDirection, "desk-scatter", "the source's chosen direction carries over");

    // NOT ONE PATH IN EITHER FILE NAMES THE SOURCE RUN. The `startsWith`
    // assertions above are per-field and a forgotten field would slip past them.
    for (const file of [join(mine, "manifest.json"), join(h.runPaths.results, "design-lock.json")]) {
      assert.equal(
        readFileSync(file, "utf8").includes(SOURCE_RUN_ID),
        false,
        `${file} still contains the source run id: some path was not rewritten`,
      );
    }
  } finally {
    h.cleanup();
  }
});

test("REUSE: the build prompt carries THIS run's copies, and the run says where the art came from", async () => {
  const h = await runOnce({ reuse: true });
  try {
    const prompt = h.builder.prompts[0] ?? "";
    const mine = refsDirFor(h.runPaths.workspace);
    assert.ok(prompt.includes(mine), "the handoff must name this run's own refs directory");
    assert.ok(
      !prompt.includes(refsDirFor(h.sourcePaths.workspace)),
      "no path in the build prompt may point into the source run's workspace",
    );
    assert.ok(
      prompt.includes("THE DESIGN IS ALREADY MADE"),
      "a reused lane must take the handoff's HAS-STILLS branch, not the degraded one",
    );
  } finally {
    h.cleanup();
  }
});

test("REUSE IS IDEMPOTENT — a re-entry does not copy over a design that is already there", async () => {
  /*
   * THE RESUME PATH, AS A PRE-STATE RATHER THAN AS A SECOND RUN.
   *
   * The marker is durable, so EVERY re-entry into `#buildPhase` — a rate-limit
   * resume, a boot reconciliation, an owner clicking resume — reaches
   * `#reuseDesignFor` again with the copy already on disk. That state is exactly
   * what is seeded here: the copy performed, plus a SENTINEL the second copy would
   * destroy, because `copyDesignAssets` `rm`s the destination refs directory before
   * it renames the staging one into place.
   *
   * The sentinel stands for the two things a re-copy would really throw away: an
   * on-demand still the owner asked for while looking at the design, and any
   * manifest edit the run has made since. A test that only counted files could not
   * see either.
   */
  const h = await runOnce({
    reuse: true,
    beforePump: (runPaths, sourcePaths) => {
      const check = validateDesignReuseSource(SOURCE_RUN_ID, sourcePaths);
      assert.ok(check.ok, "the fixture must be lendable before the pre-state is built");
      mkdirSync(runPaths.workspace, { recursive: true });
      const copied = copyDesignAssets(check.source, runPaths);
      assert.ok(copied.ok, "the pre-state IS a completed copy — the shape a resumed run finds");
      writeFileSync(join(refsDirFor(runPaths.workspace), "sentinel-a-preview-the-owner-asked-for.png"), FIXTURE_PNG);
    },
  });
  try {
    assert.equal(
      existsSync(join(refsDirFor(h.runPaths.workspace), "sentinel-a-preview-the-owner-asked-for.png")),
      true,
      "the design-refs directory was replaced on re-entry: a second copy rm's it, and anything the run " +
        "added since the first copy goes with it",
    );
    assert.ok(
      h.logs().some((line) => line.includes("already in this run's workspace")),
      `the run must say it did NOT copy again; got ${JSON.stringify(h.logs().slice(0, 6))}`,
    );
    // AND IT IS STILL A REUSED LANE WITH AN HONEST RECORD. Skipping the copy must
    // not skip the record: a resumed run that left `design-lane.json` unwritten
    // would be a run whose art came from elsewhere with nothing on disk saying so.
    const record = readDesignLaneRecord(h.runPaths.results);
    assert.equal(record?.mode, "reused");
    assert.equal(record?.reusedFrom, SOURCE_RUN_ID);
    assert.equal(record?.imageCalls, 0);
    assert.equal(
      record?.images,
      FIXTURE_IMAGE_COUNT + 1,
      "the count is read from disk, so it includes the sentinel — a number taken from the copy's own " +
        "bookkeeping could not have noticed it",
    );
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * ARM 2 — THE CONTROL: the same harness, no marker
 * ---------------------------------------------------------------------- */

test("CONTROL: with no reuseDesignFrom the lane is FULL, a design segment runs, and the generator IS called", async () => {
  const h = await runOnce({ reuse: false });
  try {
    assert.ok(h.builder.designSegments >= 1, "without a marker the run must art-direct for itself");
    assert.ok(h.builder.generated.length > 0, "and it must actually draw");
    // THE INSTRUMENT CHECK FOR THE REUSE ARM'S EMPTY LIST. The preflight runs
    // through this seam on a lane that is going to generate, so a non-empty list
    // here is what makes the other arm's `deepEqual([], …)` a measurement rather
    // than a runner nobody wired up.
    assert.ok(
      h.runnerCalls.length > 0,
      "the injected image runner was never called on a FULL lane either — the seam the reuse arm asserts " +
        "emptiness on is not connected, so that assertion proves nothing",
    );

    const record = readDesignLaneRecord(h.runPaths.results);
    assert.equal(record?.mode, "full", "this is what a run that produced its own design records");
    assert.equal(record?.reusedFrom, null, "and it names no source run, because there was none");
    assert.ok(
      (record?.imageCalls ?? 0) > 0,
      "THE INSTRUMENT CHECK: the orchestrator's generation counter is live in this harness, so the reuse " +
        "arm's zero is a measurement and not a missing instrument",
    );
    assert.equal(record?.images, 5, "the five stills the fake builder drew — not the source's eleven");

    // AND NOTHING OF THE SOURCE RUN IS IN THIS RUN'S WORKSPACE. The fixture is on
    // disk in both arms, so a copy that ran unconditionally would show up here.
    const manifest = readDesignManifest(h.runPaths.workspace);
    assert.ok(
      !String(manifest?.lockedMockup).includes(SOURCE_RUN_ID),
      "a run with no marker must not inherit the source's still",
    );
    assert.equal(
      existsSync(join(refsDirFor(h.runPaths.workspace), "desk-scatter-01-hero.png")),
      false,
      "the source's stills must not be in a run that never asked for them",
    );
  } finally {
    h.cleanup();
  }
});
