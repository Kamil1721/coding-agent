import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceGate, AcceptanceSuite, RunRecord, ScoreRecord } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { acceptanceSuiteDigest, sha256Hex } from "bakeoff/dist/hash.js";
import { WORKSPACE } from "bakeoff/dist/runner.js";
import { ALL_GATE_IDS } from "bakeoff/dist/scorer-protocol.js";
import { freezeSuite } from "bakeoff/dist/spec-freeze.js";
import { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "bakeoff/dist/spec-types.js";
import type { SuiteDraft } from "bakeoff/dist/spec-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { GATE_RECOVERY_OWNER_FILE, GATE_RECOVERY_PROTOCOL_VERSION, GateRecoveryController, GateRecoveryRefusal, inventoryScorerVisibleWorkspace, validateGateRecoveryRequest } from "./gate-recovery.js";
import type { GateReadiness } from "./gate-readiness.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import type { DashboardPaths } from "./paths.js";
import { ticketFromText } from "./ticket.js";

const IMAGE_DIGEST = `sha256:${"f".repeat(64)}`;
const READY: GateReadiness = {
  checkFresh: async () => ({
    state: "ready", detail: "sealed scorer ready", remediation: "none",
    checkedAt: "2026-08-26T08:00:00.000Z", scorerImageDigest: IMAGE_DIGEST,
  }),
};

interface RecoveryHarness {
  readonly root: string;
  readonly paths: DashboardPaths;
  readonly store: RunStore;
  readonly sourceRunId: string;
  readonly suite: AcceptanceSuite;
  cleanup(): void;
}

function freezeFor(ticketText: string, acceptanceRoot: string): AcceptanceSuite {
  const ticket = ticketFromText(ticketText);
  const draft: SuiteDraft = {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [{
      id: "REQ-001", statement: "The recovered artifact shall remain scoreable.",
      evidenceRequired: "holdout test T-2 PASS", tier: "BLOCKING",
      holdoutTestIds: ["T-2"], visibleTestIds: ["T-1"], evidenceArtifacts: [],
    }],
    files: [
      {
        path: "visible/smoke.test.mjs", visibility: "visible", runner: "node-test",
        description: "visible twin", expectedTestIds: ["T-1"], criterionIds: ["REQ-001"],
        source: 'import test from "node:test";\ntest("T-1 visible", () => {});\n',
      },
      {
        path: "holdout/acceptance.test.mjs", visibility: "holdout", runner: "node-test",
        description: "held-out test", expectedTestIds: ["T-2"], criterionIds: ["REQ-001"],
        source: 'import test from "node:test";\ntest("T-2 held", () => {});\n',
      },
    ],
  };
  const criteria = criteriaFromDraft(draft);
  const testFiles = testFileRefsFromDraft(draft);
  const at = "2026-08-26T07:00:00.000Z";
  const suite: AcceptanceSuite = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria,
    testFiles,
    sha256: acceptanceSuiteDigest({ ticketId: ticket.id, ticketSha256: ticket.sha256, criteria, testFiles }),
    generatedBy: SPEC_SEAT,
    generatedByHarness: { id: "gate-recovery-test", version: "1", commit: "test" },
    authoringPromptSha256: sha256Hex("gate recovery test fixture"),
    generatedAt: at,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: at,
  };
  freezeSuite({ suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [] }, { acceptanceRoot });
  return suite;
}

function harness(): RecoveryHarness {
  const root = mkdtempSync(join(tmpdir(), "gate-recovery-"));
  const paths = resolvePaths({ DASHBOARD_HOME: join(root, "dashboard"), DASHBOARD_PROJECTS_DIR: join(root, "projects") });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const ticketText = "Recover the sealed gate result without rebuilding the artifact.";
  const ticket = ticketFromText(ticketText);
  const suite = freezeFor(ticketText, paths.acceptance);
  const sourceRunId = "source-infra-no-verdict";
  const sourcePaths = runPathsFor(paths, sourceRunId);
  mkdirSync(join(sourcePaths.workspace, ".bakeoff"), { recursive: true });
  mkdirSync(sourcePaths.results, { recursive: true });
  writeFileSync(join(sourcePaths.workspace, "app.txt"), "artifact bytes\n", "utf8");
  writeFileSync(join(sourcePaths.workspace, WORKSPACE.selfReport), '{"status":"done"}\n', "utf8");
  writeFileSync(sourcePaths.runLog, "source log\n", "utf8");
  writeFileSync(sourcePaths.ledger, "source ledger\n", "utf8");
  store.createRun({
    runId: sourceRunId, ticketId: ticket.id, ticketTitle: "Recovery fixture", ticketText,
    ticketSha256: ticket.sha256, modelId: "fixture", provider: "anthropic", deploy: false,
    startedAt: "2026-08-26T06:00:00.000Z", queuePosition: 1,
  });
  store.updateRun(sourceRunId, {
    status: "failed", phase: "done", endedAt: "2026-08-26T06:30:00.000Z",
    agentDeclaredDone: true, gateStopReason: "infra", suiteSha256: suite.sha256,
    artifactPath: sourcePaths.workspace, failureReason: "scorer infrastructure failure",
  });
  const record = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: sourceRunId,
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    agentDeclaredDone: true,
    artifactPath: sourcePaths.workspace,
    heldConstants: { acceptanceSuiteSha256: suite.sha256 },
  } as unknown as RunRecord;
  writeFileSync(join(sourcePaths.results, "run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    root, paths, store, sourceRunId, suite,
    cleanup: () => {
      store.close();
      try { execFileSync("chmod", ["-R", "u+rwX", root], { stdio: "ignore" }); } catch { /* rm reports it */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    },
  };
}

function scoreFor(run: RunRecord, suite: AcceptanceSuite, pass = true): ScoreRecord {
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: run.runId,
    ticketId: run.ticketId,
    acceptanceSuiteSha256: suite.sha256,
    heldOutPass: pass,
    criteriaResults: [
      ...ALL_GATE_IDS.map((criterionId) => ({
        criterionId, tier: "BLOCKING" as const, passed: pass,
        evidenceRef: "sealed-machine-gate", detail: pass ? null : "machine gate failed",
      })),
      ...suite.criteria.map((criterion) => ({
        criterionId: criterion.id, tier: criterion.tier, passed: pass,
        evidenceRef: "T-2", detail: pass ? "held-out evidence passed" : "held-out evidence failed",
      })),
      { criterionId: "QUALITY:runtime_observation", tier: "QUALITY" as const, passed: true, evidenceRef: null, detail: null },
    ],
    falseFinish: !pass,
    agentDeclaredDone: true,
    scoredAt: "2026-08-26T08:01:00.000Z",
    scorerImageDigest: IMAGE_DIGEST,
    suiteExecution: {
      exitCode: pass ? 0 : 1, durationMs: 1, testsTotal: 1,
      testsPassed: pass ? 1 : 0, testsFailed: pass ? 0 : 1,
      logPath: null,
    },
    protectedPathViolations: [],
  };
}

function scoreFile(paths: DashboardPaths, score: ScoreRecord): void {
  const dir = join(paths.results, "scores");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${score.runId}.json`), `${JSON.stringify(score, null, 2)}\n`, "utf8");
}

function rawTree(root: string): readonly string[] {
  const out: string[] = [];
  const visit = (dir: string, rel = ""): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, childRel);
      else out.push(`${childRel}\0${readFileSync(absolute).toString("base64")}`);
    }
  };
  visit(root);
  return out;
}

test("gate recovery passes once under concurrent replay and leaves every source-owned surface unchanged", async () => {
  const h = harness();
  try {
    let calls = 0;
    const controller = new GateRecoveryController({
      store: h.store, paths: h.paths, readiness: READY,
      makeGate: async (): Promise<AcceptanceGate> => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async (run, suite) => {
          calls += 1;
          const score = scoreFor(run, suite);
          scoreFile(h.paths, score);
          await Promise.resolve();
          return score;
        },
      }),
    });
    const request = validateGateRecoveryRequest({ clientRequestId: "single-flight-1" });
    const sourceLogicalState = JSON.stringify({
      run: h.store.getRun(h.sourceRunId),
      criteria: h.store.listCriteria(h.sourceRunId),
      events: h.store.eventsSince(h.sourceRunId, 0),
      messages: h.store.messages(h.sourceRunId),
      screenshots: h.store.listScreenshots(h.sourceRunId),
      attempts: h.store.listAttempts(h.sourceRunId),
      seatSpend: h.store.listSeatSpend(h.sourceRunId),
      meteredSpend: h.store.listMeteredSpend(h.sourceRunId),
    });
    const sourceFiles = rawTree(runPathsFor(h.paths, h.sourceRunId).root);
    const [first, replay] = await Promise.all([
      controller.recover(h.sourceRunId, request), controller.recover(h.sourceRunId, request),
    ]);
    assert.equal(first.targetRunId, replay.targetRunId);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(first.tasteCritic, "not_run_gate_only");
    assert.equal(calls, 1);
    assert.equal(h.store.getRun(first.targetRunId)?.status, "passed");
    assert.equal(h.store.getRun(first.targetRunId)?.heldOutPass, true);
    assert.equal(h.store.getRun(first.targetRunId)?.gateAttempts, 1);
    assert.equal(h.store.listQueued().some((row) => row.runId === first.targetRunId), false);
    assert.equal(JSON.stringify({
      run: h.store.getRun(h.sourceRunId),
      criteria: h.store.listCriteria(h.sourceRunId),
      events: h.store.eventsSince(h.sourceRunId, 0),
      messages: h.store.messages(h.sourceRunId),
      screenshots: h.store.listScreenshots(h.sourceRunId),
      attempts: h.store.listAttempts(h.sourceRunId),
      seatSpend: h.store.listSeatSpend(h.sourceRunId),
      meteredSpend: h.store.listMeteredSpend(h.sourceRunId),
    }), sourceLogicalState);
    assert.deepEqual(rawTree(runPathsFor(h.paths, h.sourceRunId).root), sourceFiles);
    assert.equal(existsSync(join(h.paths.results, "scores", `${h.sourceRunId}.json`)), false);
    const recovery = h.store.gateRecoveryForTarget(first.targetRunId);
    assert.equal(recovery?.sourceArtifactSha256, recovery?.targetArtifactSha256);
    assert.match(readFileSync(join(runPathsFor(h.paths, first.targetRunId).results, "recovery.json"), "utf8"), /recovery-time-scorer-visible-snapshot/);
    await assert.rejects(
      controller.recover(h.sourceRunId, { ...request, payloadSha256: "0".repeat(64) }),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_idempotency_conflict",
    );
    assert.equal(calls, 1, "an idempotency conflict must not score or create another child");
    assert.equal(h.store.listRuns().length, 2);
  } finally { h.cleanup(); }
});

test("concurrent reuse of an active key with a different payload is rejected before either payload can alias", async () => {
  const h = harness();
  try {
    const ready = await READY.checkFresh();
    let release!: (value: Awaited<ReturnType<GateReadiness["checkFresh"]>>) => void;
    let entered!: () => void;
    const reachedReadiness = new Promise<void>((resolve) => { entered = resolve; });
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: {
        checkFresh: async () => {
          entered();
          return await new Promise((resolve) => { release = resolve; });
        },
      },
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async (run, suite) => {
          const score = scoreFor(run, suite);
          scoreFile(h.paths, score);
          return score;
        },
      }),
    });
    const request = validateGateRecoveryRequest({ clientRequestId: "active-conflict" });
    const first = controller.recover(h.sourceRunId, request);
    await reachedReadiness;
    await assert.rejects(
      controller.recover(h.sourceRunId, { ...request, payloadSha256: "0".repeat(64) }),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_idempotency_conflict",
    );
    release(ready);
    assert.equal((await first).recoveryState, "completed");
    assert.equal(h.store.listRuns().length, 2);
  } finally { h.cleanup(); }
});

test("boot resumes a renamed staging snapshot even when source directories have non-default modes", async () => {
  const h = harness();
  try {
    const sourcePaths = runPathsFor(h.paths, h.sourceRunId);
    const privateDir = join(sourcePaths.workspace, "private-dir");
    mkdirSync(privateDir);
    writeFileSync(join(privateDir, "data.txt"), "mode-sensitive source\n", "utf8");
    chmodSync(privateDir, 0o700);
    const storeWithHook = h.store as RunStore & {
      transitionGateRecovery: RunStore["transitionGateRecovery"];
    };
    const transition = h.store.transitionGateRecovery.bind(h.store);
    let stopAfterRename = true;
    storeWithHook.transitionGateRecovery = (...args: Parameters<RunStore["transitionGateRecovery"]>) => {
      if (stopAfterRename && args[1] === "staging" && args[2] === "ready_to_score") return null;
      return transition(...args);
    };
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async (run, suite) => {
          const score = scoreFor(run, suite);
          scoreFile(h.paths, score);
          return score;
        },
      }),
    });
    const request = validateGateRecoveryRequest({ clientRequestId: "boot-staging-mode" });
    const interrupted = await controller.recover(h.sourceRunId, request);
    assert.equal(interrupted.recoveryState, "staging");
    stopAfterRename = false;
    await controller.reconcileOnBoot();
    const recovery = h.store.gateRecovery(h.sourceRunId, request.clientRequestId);
    assert.equal(recovery?.state, "completed");
    assert.equal(h.store.getRun(recovery?.targetRunId ?? "")?.heldOutPass, true);
  } finally { h.cleanup(); }
});

test("gate recovery readiness refusal makes no durable write", async () => {
  const h = harness();
  try {
    const before = h.store.listRuns().length;
    const controller = new GateRecoveryController({
      store: h.store, paths: h.paths,
      readiness: { checkFresh: async () => ({ state: "unavailable", detail: "docker down", remediation: "start docker", checkedAt: null }) },
      makeGate: async () => { throw new Error("must not construct gate"); },
    });
    await assert.rejects(
      controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "not-ready" })),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.status === 503,
    );
    assert.equal(h.store.listRuns().length, before);
    assert.equal(h.store.gateRecovery(h.sourceRunId, "not-ready"), null);
  } finally { h.cleanup(); }
});

test("an ineligible source is refused before readiness and child creation", async () => {
  const h = harness();
  try {
    h.store.updateRun(h.sourceRunId, { heldOutPass: false, falseFinish: true });
    let readinessCalls = 0;
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: {
        checkFresh: async () => {
          readinessCalls += 1;
          return await READY.checkFresh();
        },
      },
      makeGate: async () => { throw new Error("must not construct gate"); },
    });
    await assert.rejects(
      controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "ineligible" })),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_ineligible",
    );
    assert.equal(readinessCalls, 0);
    assert.equal(h.store.listRuns().length, 1);
    assert.equal(h.store.gateRecovery(h.sourceRunId, "ineligible"), null);
  } finally { h.cleanup(); }
});

test("a completed red sealed score is a real failed verdict, not an infrastructure failure", async () => {
  const h = harness();
  try {
    const controller = new GateRecoveryController({
      store: h.store, paths: h.paths, readiness: READY,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async (run, suite) => {
          const score = scoreFor(run, suite, false);
          scoreFile(h.paths, score);
          return score;
        },
      }),
    });
    const result = await controller.recover(
      h.sourceRunId,
      validateGateRecoveryRequest({ clientRequestId: "red-verdict" }),
    );
    assert.equal(result.recoveryState, "completed");
    assert.equal(result.status, "failed");
    assert.equal(result.heldOutPass, false);
    assert.equal(result.falseFinish, true);
    assert.equal(h.store.getRun(result.targetRunId)?.gateStopReason, "not-converging");
    assert.match(h.store.getRun(result.targetRunId)?.failureReason ?? "", /did not go green/);
  } finally { h.cleanup(); }
});

test("scorer failure and post-score child mutation both end failed with no verdict", async (t) => {
  await t.test("scorer infrastructure failure", async () => {
    const h = harness();
    try {
      let calls = 0;
      const controller = new GateRecoveryController({
        store: h.store, paths: h.paths, readiness: READY,
        makeGate: async () => ({ scorerImageDigest: IMAGE_DIGEST, score: async () => { calls += 1; throw new Error("daemon vanished"); } }),
      });
      const result = await controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "infra" }));
      assert.equal(calls, 1);
      assert.equal(result.recoveryState, "infra_failed");
      assert.equal(result.heldOutPass, null);
      assert.equal(result.falseFinish, null);
      assert.equal(h.store.getRun(result.targetRunId)?.gateAttempts, 1);
      assert.match(h.store.getRun(result.targetRunId)?.failureReason ?? "", /daemon vanished/);
      const replay = await controller.recover(
        h.sourceRunId,
        validateGateRecoveryRequest({ clientRequestId: "infra" }),
      );
      assert.equal(replay.targetRunId, result.targetRunId);
      assert.equal(replay.replayed, true);
      assert.equal(calls, 1, "terminal infra replay must not invoke the scorer again");
    } finally { h.cleanup(); }
  });
  await t.test("workspace mutation after the score", async () => {
    const h = harness();
    try {
      const controller = new GateRecoveryController({
        store: h.store, paths: h.paths, readiness: READY,
        makeGate: async () => ({
          scorerImageDigest: IMAGE_DIGEST,
          score: async (run, suite) => {
            const score = scoreFor(run, suite);
            scoreFile(h.paths, score);
            writeFileSync(join(run.artifactPath, "app.txt"), "mutated during score\n", "utf8");
            return score;
          },
        }),
      });
      const result = await controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "mutated" }));
      assert.equal(result.recoveryState, "infra_failed");
      assert.equal(result.heldOutPass, null);
      assert.match(h.store.getRun(result.targetRunId)?.failureReason ?? "", /changed during the sealed score call/);
    } finally { h.cleanup(); }
  });
});

test("boot finalizes a valid scoring-state score without invoking the scorer again", async () => {
  const h = harness();
  try {
    const request = validateGateRecoveryRequest({ clientRequestId: "boot-score" });
    const source = h.store.getRun(h.sourceRunId);
    assert.ok(source !== null);
    const targetRunId = "recovery-boot-target";
    const targetPaths = runPathsFor(h.paths, targetRunId);
    mkdirSync(join(targetPaths.workspace, ".bakeoff"), { recursive: true });
    mkdirSync(targetPaths.results, { recursive: true });
    writeFileSync(join(targetPaths.workspace, "app.txt"), "artifact bytes\n", "utf8");
    writeFileSync(join(targetPaths.workspace, WORKSPACE.selfReport), '{"status":"done"}\n', "utf8");
    const digest = inventoryScorerVisibleWorkspace(targetPaths.workspace).sha256;
    const claim = h.store.claimGateRecovery({
      sourceRunId: h.sourceRunId, clientRequestId: request.clientRequestId, payloadSha256: request.payloadSha256,
      target: {
        runId: targetRunId, ticketId: source.ticketId, ticketTitle: "boot recovery", ticketText: source.ticketText,
        ticketSha256: source.ticketSha256, modelId: source.modelId, provider: source.provider,
        deploy: false, startedAt: "2026-08-26T08:00:00.000Z", queuePosition: 0,
      },
      targetArtifactPath: targetPaths.workspace, ticketSha256: source.ticketSha256, suiteSha256: h.suite.sha256,
      criteria: h.suite.criteria.map(({ id, statement, tier }) => ({ id, statement, tier })),
      createdAt: "2026-08-26T08:00:00.000Z",
    });
    assert.equal(claim.kind, "created");
    writeFileSync(join(targetPaths.root, GATE_RECOVERY_OWNER_FILE), `${JSON.stringify({
      protocolVersion: GATE_RECOVERY_PROTOCOL_VERSION,
      sourceRunId: h.sourceRunId,
      clientRequestId: request.clientRequestId,
      payloadSha256: request.payloadSha256,
      targetRunId,
    })}\n`, "utf8");
    assert.notEqual(h.store.transitionGateRecovery(targetRunId, "prepared", "staging", "2026-08-26T08:00:01.000Z"), null);
    assert.notEqual(h.store.transitionGateRecovery(targetRunId, "staging", "ready_to_score", "2026-08-26T08:00:02.000Z", {
      sourceArtifactSha256: digest, targetArtifactSha256: digest,
    }), null);
    assert.notEqual(h.store.claimGateRecoveryScoring(targetRunId, "2026-08-26T08:00:03.000Z"), null);
    const runRecord = {
      schemaVersion: BAKEOFF_SCHEMA_VERSION, runId: targetRunId, ticketId: source.ticketId,
      ticketSha256: source.ticketSha256, artifactPath: targetPaths.workspace, agentDeclaredDone: true,
    } as unknown as RunRecord;
    writeFileSync(join(targetPaths.results, "run.json"), `${JSON.stringify(runRecord)}\n`, "utf8");
    writeFileSync(join(targetPaths.results, "recovery.json"), `${JSON.stringify({ readiness: { scorerImageDigest: IMAGE_DIGEST } })}\n`, "utf8");
    scoreFile(h.paths, scoreFor(runRecord, h.suite));
    let scoreCalls = 0;
    const controller = new GateRecoveryController({
      store: h.store, paths: h.paths, readiness: READY,
      makeGate: async () => ({ scorerImageDigest: IMAGE_DIGEST, score: async () => { scoreCalls += 1; throw new Error("must not rescore"); } }),
    });
    await controller.reconcileOnBoot();
    assert.equal(scoreCalls, 0);
    assert.equal(h.store.gateRecoveryForTarget(targetRunId)?.state, "completed");
    assert.equal(h.store.getRun(targetRunId)?.heldOutPass, true);
  } finally { h.cleanup(); }
});

test("gate-recovery HTTP writes require owner origin and JSON; recovery children reject generic actions", async () => {
  const h = harness();
  const bus = new RunEventBus(h.store);
  const auth = new AuthProbe({
    claudeBin: join(h.root, "absent-claude"),
    codexBin: join(h.root, "absent-codex"),
  });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  let cancelCalls = 0;
  const orchestrator: RunController = {
    pump: () => {},
    cancel: () => { cancelCalls += 1; return true; },
    resume: () => false,
    pushLiveMessage: () => false,
  };
  let scoreCalls = 0;
  const controller = new GateRecoveryController({
    store: h.store,
    paths: h.paths,
    readiness: READY,
    makeGate: async () => ({
      scorerImageDigest: IMAGE_DIGEST,
      score: async (run, suite) => {
        scoreCalls += 1;
        const score = scoreFor(run, suite);
        scoreFile(h.paths, score);
        return score;
      },
    }),
  });
  const clientRequestId = "http-boundary";
  const recovered = await controller.recover(
    h.sourceRunId,
    validateGateRecoveryRequest({ clientRequestId }),
  );
  const server = createDashboardServer({
    store: h.store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths: h.paths,
    gateRecovery: controller,
    gateReadiness: READY,
    gate: new GateProbe({ paths: h.paths, makeGate: () => Promise.reject(new Error("not used")) }),
  });
  try {
    await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
    const address = server.address() as AddressInfo;
    const base = `http://${LOOPBACK_HOST}:${String(address.port)}`;
    const endpoint = `${base}/api/runs/${h.sourceRunId}/gate-recovery`;
    const ownerHeaders = { "Content-Type": "application/json", Origin: `http://${LOOPBACK_HOST}:4319` };

    const crossOrigin = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ clientRequestId }),
    });
    assert.equal(crossOrigin.status, 403);

    const wrongMedia = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: ownerHeaders.Origin },
      body: JSON.stringify({ clientRequestId }),
    });
    assert.equal(wrongMedia.status, 415);

    const replay = await fetch(endpoint, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ clientRequestId }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { targetRunId: string }).targetRunId, recovered.targetRunId);
    assert.equal(scoreCalls, 1);

    const detailResponse = await fetch(`${base}/api/runs/${recovered.targetRunId}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as {
      gateRecovery?: { sourceRunId: string; tasteCritic: string; artifactDigestSemantics: string } | null;
    };
    assert.deepEqual(detail.gateRecovery, {
      sourceRunId: h.sourceRunId,
      state: "completed",
      artifactSha256: h.store.gateRecoveryForTarget(recovered.targetRunId)?.targetArtifactSha256,
      artifactDigestSemantics: "recovery-time-scorer-visible-snapshot",
      tasteCritic: "not_run_gate_only",
    });

    const blocked = await fetch(`${base}/api/runs/${recovered.targetRunId}/cancel`, {
      method: "POST",
      headers: ownerHeaders,
      body: "{}",
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { error: string }).error, "gate_recovery_target_controller_owned");
    assert.equal(cancelCalls, 0, "the generic action must be blocked before the orchestrator sees it");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.cleanup();
  }
});
