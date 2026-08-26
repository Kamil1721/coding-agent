import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceGate, AcceptanceSuite, CriterionResult, RunRecord, ScoreRecord } from "bakeoff/dist/contracts.js";
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
import {
  GATE_RECOVERY_OWNER_FILE,
  GATE_RECOVERY_PROTOCOL_VERSION,
  GateRecoveryController,
  GateRecoveryRefusal,
  inventoryScorerVisibleWorkspace,
  validateGateRecoveryRequest,
} from "./gate-recovery.js";
import type { GateReadiness } from "./gate-readiness.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import type { DashboardPaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { ticketFromText } from "./ticket.js";

const IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;
const READY: GateReadiness = {
  checkFresh: async () => ({
    state: "ready",
    detail: "sealed scorer ready",
    remediation: "none",
    checkedAt: "2026-08-26T08:00:00.000Z",
    scorerImageDigest: IMAGE_DIGEST,
  }),
};

interface Harness {
  readonly root: string;
  readonly paths: DashboardPaths;
  readonly store: RunStore;
  readonly sourceRunId: string;
  readonly suite: AcceptanceSuite;
  cleanup(): void;
}

function frozenSuite(ticketText: string, acceptanceRoot: string): AcceptanceSuite {
  const ticket = ticketFromText(ticketText);
  const draft: SuiteDraft = {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [{
      id: "REQ-001",
      statement: "The recovered artifact shall remain scoreable.",
      evidenceRequired: "holdout T-2 passes",
      tier: "BLOCKING",
      holdoutTestIds: ["T-2"],
      visibleTestIds: ["T-1"],
      evidenceArtifacts: [],
    }],
    files: [
      {
        path: "visible/smoke.test.mjs",
        visibility: "visible",
        runner: "node-test",
        description: "visible twin",
        expectedTestIds: ["T-1"],
        criterionIds: ["REQ-001"],
        source: 'import test from "node:test";\ntest("T-1 visible", () => {});\n',
      },
      {
        path: "holdout/acceptance.test.mjs",
        visibility: "holdout",
        runner: "node-test",
        description: "held-out test",
        expectedTestIds: ["T-2"],
        criterionIds: ["REQ-001"],
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
    generatedByHarness: { id: "gate-recovery-security-test", version: "1", commit: "test" },
    authoringPromptSha256: sha256Hex("gate recovery negative-control fixture"),
    generatedAt: at,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: at,
  };
  freezeSuite({ suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [] }, { acceptanceRoot });
  return suite;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "gate-recovery-security-"));
  const paths = resolvePaths({
    DASHBOARD_HOME: join(root, "dashboard"),
    DASHBOARD_PROJECTS_DIR: join(root, "projects"),
  });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const ticketText = "Recover only the sealed gate result without rebuilding.";
  const ticket = ticketFromText(ticketText);
  const suite = frozenSuite(ticketText, paths.acceptance);
  const sourceRunId = "source-security-fixture";
  const sourcePaths = runPathsFor(paths, sourceRunId);
  mkdirSync(join(sourcePaths.workspace, ".bakeoff"), { recursive: true });
  mkdirSync(sourcePaths.results, { recursive: true });
  writeFileSync(join(sourcePaths.workspace, "app.txt"), "artifact bytes\n", "utf8");
  writeFileSync(join(sourcePaths.workspace, WORKSPACE.selfReport), '{"status":"done"}\n', "utf8");
  writeFileSync(sourcePaths.runLog, "source log\n", "utf8");
  writeFileSync(sourcePaths.ledger, "source ledger\n", "utf8");
  store.createRun({
    runId: sourceRunId,
    ticketId: ticket.id,
    ticketTitle: "Security fixture",
    ticketText,
    ticketSha256: ticket.sha256,
    modelId: "fixture",
    provider: "anthropic",
    deploy: false,
    startedAt: "2026-08-26T06:00:00.000Z",
    queuePosition: 1,
  });
  store.updateRun(sourceRunId, {
    status: "failed",
    phase: "done",
    endedAt: "2026-08-26T06:30:00.000Z",
    agentDeclaredDone: true,
    gateStopReason: "infra",
    suiteSha256: suite.sha256,
    artifactPath: sourcePaths.workspace,
    failureReason: "scorer infrastructure failure",
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
    root,
    paths,
    store,
    sourceRunId,
    suite,
    cleanup: () => {
      store.close();
      try { execFileSync("chmod", ["-R", "u+rwX", root], { stdio: "ignore" }); } catch { /* rm reports it */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    },
  };
}

function productionCriteria(suite: AcceptanceSuite, pass = true): CriterionResult[] {
  return [
    ...ALL_GATE_IDS.map((criterionId) => ({
      criterionId,
      tier: "BLOCKING" as const,
      passed: pass,
      evidenceRef: "sealed-machine-gate",
      detail: pass ? null : "machine gate failed",
    })),
    ...suite.criteria.map((criterion) => ({
      criterionId: criterion.id,
      tier: criterion.tier,
      passed: pass,
      evidenceRef: "T-2",
      detail: pass ? null : "held-out evidence failed",
    })),
    {
      criterionId: "QUALITY:blank_page",
      tier: "QUALITY" as const,
      passed: true,
      evidenceRef: null,
      detail: "DOM observation",
    },
  ];
}

function scoreFor(run: RunRecord, suite: AcceptanceSuite, criteriaResults = productionCriteria(suite)): ScoreRecord {
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: run.runId,
    ticketId: run.ticketId,
    acceptanceSuiteSha256: suite.sha256,
    heldOutPass: true,
    criteriaResults,
    falseFinish: false,
    agentDeclaredDone: true,
    scoredAt: "2026-08-26T08:01:00.000Z",
    scorerImageDigest: IMAGE_DIGEST,
    suiteExecution: {
      exitCode: 0,
      durationMs: 1,
      testsTotal: 1,
      testsPassed: 1,
      testsFailed: 0,
      logPath: null,
    },
    protectedPathViolations: [],
  };
}

function controllerFor(h: Harness, score: (run: RunRecord, suite: AcceptanceSuite) => ScoreRecord): GateRecoveryController {
  return new GateRecoveryController({
    store: h.store,
    paths: h.paths,
    readiness: READY,
    makeGate: async (): Promise<AcceptanceGate> => ({
      scorerImageDigest: IMAGE_DIGEST,
      score: async (run, suite) => score(run, suite),
    }),
  });
}

function rawTree(root: string): readonly string[] {
  const out: string[] = [];
  const visit = (directory: string, relative = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, rel);
      else out.push(`${rel}\0${readFileSync(absolute).toString("base64")}`);
    }
  };
  visit(root);
  return out;
}

function claimPrepared(h: Harness, clientRequestId: string, targetRunId: string) {
  const source = h.store.getRun(h.sourceRunId);
  assert.ok(source !== null);
  const request = validateGateRecoveryRequest({ clientRequestId });
  return h.store.claimGateRecovery({
    sourceRunId: h.sourceRunId,
    clientRequestId,
    payloadSha256: request.payloadSha256,
    target: {
      runId: targetRunId,
      ticketId: source.ticketId,
      ticketTitle: "recovery child",
      ticketText: source.ticketText,
      ticketSha256: source.ticketSha256,
      modelId: source.modelId,
      provider: source.provider,
      deploy: false,
      startedAt: "2026-08-26T08:00:00.000Z",
      queuePosition: 0,
    },
    targetArtifactPath: runPathsFor(h.paths, targetRunId).workspace,
    ticketSha256: source.ticketSha256,
    suiteSha256: h.suite.sha256,
    criteria: h.suite.criteria.map(({ id, statement, tier }) => ({ id, statement, tier })),
    createdAt: "2026-08-26T08:00:00.000Z",
  });
}

function writeScore(paths: DashboardPaths, score: ScoreRecord): void {
  const directory = join(paths.results, "scores");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${score.runId}.json`), `${JSON.stringify(score, null, 2)}\n`, "utf8");
}

function prepareScoringCrash(h: Harness, clientRequestId: string, targetRunId: string): RunRecord {
  const claim = claimPrepared(h, clientRequestId, targetRunId);
  assert.equal(claim.kind, "created");
  const targetPaths = runPathsFor(h.paths, targetRunId);
  mkdirSync(join(targetPaths.workspace, ".bakeoff"), { recursive: true });
  mkdirSync(targetPaths.results, { recursive: true });
  writeFileSync(join(targetPaths.workspace, "app.txt"), "artifact bytes\n", "utf8");
  writeFileSync(join(targetPaths.workspace, WORKSPACE.selfReport), '{"status":"done"}\n', "utf8");
  const digest = inventoryScorerVisibleWorkspace(targetPaths.workspace).sha256;
  assert.notEqual(h.store.transitionGateRecovery(targetRunId, "prepared", "staging", "2026-08-26T08:00:01.000Z"), null);
  assert.notEqual(h.store.transitionGateRecovery(targetRunId, "staging", "ready_to_score", "2026-08-26T08:00:02.000Z", {
    sourceArtifactSha256: digest,
    targetArtifactSha256: digest,
  }), null);
  assert.notEqual(h.store.claimGateRecoveryScoring(targetRunId, "2026-08-26T08:00:03.000Z"), null);
  const source = h.store.getRun(h.sourceRunId);
  assert.ok(source !== null);
  const runRecord = {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    runId: targetRunId,
    ticketId: source.ticketId,
    ticketSha256: source.ticketSha256,
    artifactPath: targetPaths.workspace,
    agentDeclaredDone: true,
  } as unknown as RunRecord;
  writeFileSync(join(targetPaths.results, "run.json"), `${JSON.stringify(runRecord)}\n`, "utf8");
  writeFileSync(join(targetPaths.results, "recovery.json"), `${JSON.stringify({
    readiness: { scorerImageDigest: IMAGE_DIGEST },
  })}\n`, "utf8");
  return runRecord;
}

test("production machine and DOM criteria are accepted, but only frozen criteria are persisted", async () => {
  const h = harness();
  try {
    const controller = controllerFor(h, scoreFor);
    const result = await controller.recover(
      h.sourceRunId,
      validateGateRecoveryRequest({ clientRequestId: "production-shape" }),
    );
    assert.equal(result.recoveryState, "completed");
    assert.deepEqual(h.store.listCriteria(result.targetRunId).map((criterion) => criterion.id), ["REQ-001"]);
    const criterionEvents = h.store.eventsSince(result.targetRunId, 0)
      .filter((entry) => entry.event.type === "criterion")
      .map((entry) => entry.event.type === "criterion" ? entry.event.id : "");
    assert.deepEqual(criterionEvents, ["REQ-001"]);
    await assert.rejects(
      controller.recover(result.targetRunId, validateGateRecoveryRequest({ clientRequestId: "no-recovery-chains" })),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_target_as_source",
    );
  } finally { h.cleanup(); }
});

test("unexpected, duplicate, and malformed score criteria fail closed with no verdict", async (t) => {
  const cases: readonly { readonly name: string; readonly mutate: (criteria: CriterionResult[]) => CriterionResult[] }[] = [
    {
      name: "unexpected criterion",
      mutate: (criteria) => [...criteria, { criterionId: "ATTACKER:invented", tier: "QUALITY", passed: true, evidenceRef: null, detail: null }],
    },
    {
      name: "duplicate frozen criterion",
      mutate: (criteria) => [...criteria, criteria.find((criterion) => criterion.criterionId === "REQ-001")!],
    },
    {
      name: "malformed machine tier",
      mutate: (criteria) => criteria.map((criterion) => criterion.criterionId === ALL_GATE_IDS[0]
        ? { ...criterion, tier: "QUALITY" as const }
        : criterion),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = harness();
      try {
        const controller = controllerFor(h, (run, suite) => scoreFor(run, suite, scenario.mutate(productionCriteria(suite))));
        const result = await controller.recover(
          h.sourceRunId,
          validateGateRecoveryRequest({ clientRequestId: scenario.name.replaceAll(" ", "-") }),
        );
        assert.equal(result.recoveryState, "infra_failed");
        assert.equal(result.heldOutPass, null);
        assert.equal(result.falseFinish, null);
        assert.match(h.store.getRun(result.targetRunId)?.failureReason ?? "", /identity|record/u);
      } finally { h.cleanup(); }
    });
  }
});

test("a source-root symlink is refused before readiness or durable recovery writes", async () => {
  const h = harness();
  try {
    symlinkSync(join(h.root, "outside"), join(runPathsFor(h.paths, h.sourceRunId).workspace, "escape"));
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
      controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "source-symlink" })),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_symlink_refused",
    );
    assert.equal(readinessCalls, 0);
    assert.equal(h.store.listRuns().length, 1);
    assert.equal(h.store.gateRecovery(h.sourceRunId, "source-symlink"), null);
  } finally { h.cleanup(); }
});

test("workspace-root symlinks are refused for both source eligibility and target inventory", async (t) => {
  await t.test("source root", async () => {
    const h = harness();
    try {
      const workspace = runPathsFor(h.paths, h.sourceRunId).workspace;
      const outside = join(h.root, "source-workspace-outside");
      renameSync(workspace, outside);
      symlinkSync(outside, workspace);
      await assert.rejects(
        controllerFor(h, scoreFor).recover(
          h.sourceRunId,
          validateGateRecoveryRequest({ clientRequestId: "source-root-symlink" }),
        ),
        (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_workspace_missing",
      );
      assert.equal(h.store.gateRecovery(h.sourceRunId, "source-root-symlink"), null);
    } finally { h.cleanup(); }
  });
  await t.test("target inventory root", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-recovery-target-symlink-"));
    try {
      const real = join(root, "real");
      const linked = join(root, "linked");
      mkdirSync(real);
      symlinkSync(real, linked);
      assert.throws(
        () => inventoryScorerVisibleWorkspace(linked),
        (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_workspace_missing",
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("an unowned precreated target root receives zero filesystem writes", async () => {
  const h = harness();
  try {
    const targetRunId = "precreated-target";
    const targetRoot = runPathsFor(h.paths, targetRunId).root;
    mkdirSync(join(targetRoot, "owner-data"), { recursive: true });
    writeFileSync(join(targetRoot, "owner-data", "sentinel.txt"), "must remain byte-identical\n", "utf8");
    const before = rawTree(targetRoot);
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      newRunId: () => targetRunId,
      makeGate: async () => { throw new Error("must not construct gate"); },
    });
    await assert.rejects(
      controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "precreated-target" })),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_target_exists",
    );
    assert.deepEqual(rawTree(targetRoot), before);
    assert.equal(h.store.listRuns().length, 1);
    assert.equal(h.store.gateRecovery(h.sourceRunId, "precreated-target"), null);
  } finally { h.cleanup(); }
});

test("boot rejects scores whose heldOutPass and falseFinish contradict their evidence", async (t) => {
  const cases = [
    { clientRequestId: "boot-green-false-finish", heldOutPass: true, falseFinish: true },
    { clientRequestId: "boot-red-no-false-finish", heldOutPass: false, falseFinish: false },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.clientRequestId, async () => {
      const h = harness();
      try {
        const targetRunId = `target-${scenario.clientRequestId}`;
        const run = prepareScoringCrash(h, scenario.clientRequestId, targetRunId);
        const score = {
          ...scoreFor(run, h.suite),
          heldOutPass: scenario.heldOutPass,
          falseFinish: scenario.falseFinish,
        };
        writeScore(h.paths, score);
        let scoreCalls = 0;
        const controller = new GateRecoveryController({
          store: h.store,
          paths: h.paths,
          readiness: READY,
          makeGate: async () => ({
            scorerImageDigest: IMAGE_DIGEST,
            score: async () => { scoreCalls += 1; throw new Error("must not rescore"); },
          }),
        });
        await controller.reconcileOnBoot();
        assert.equal(scoreCalls, 0);
        assert.equal(h.store.gateRecoveryForTarget(targetRunId)?.state, "infra_failed");
        assert.equal(h.store.getRun(targetRunId)?.heldOutPass, null);
        assert.equal(h.store.getRun(targetRunId)?.falseFinish, null);
      } finally { h.cleanup(); }
    });
  }
});

test("direct Orchestrator cancel and resume refuse a controller-owned recovery child", async () => {
  const h = harness();
  const bus = new RunEventBus(h.store);
  const auth = new AuthProbe({
    claudeBin: join(h.root, "absent-claude"),
    codexBin: join(h.root, "absent-codex"),
  });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const orchestrator = new Orchestrator({
    store: h.store,
    bus,
    paths: h.paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: {},
    gateReadiness: READY,
  });
  try {
    const targetRunId = "controller-owned-target";
    assert.equal(claimPrepared(h, "controller-owned", targetRunId).kind, "created");
    const before = h.store.getRun(targetRunId);
    const eventsBefore = h.store.eventsSince(targetRunId, 0);
    assert.equal(orchestrator.cancel(targetRunId), false);
    assert.equal(orchestrator.resume(targetRunId), false);
    assert.deepEqual(h.store.getRun(targetRunId), before);
    assert.deepEqual(h.store.eventsSince(targetRunId, 0), eventsBefore);
    assert.equal(existsSync(h.paths.projects), false, "a refused direct action must not publish anything");
  } finally {
    await orchestrator.shutdown();
    h.cleanup();
  }
});

test("a different request ID is blocked by non-infra recovery lineage but allowed after infra failure", async (t) => {
  await t.test("prepared lineage blocks a second request ID", async () => {
    const h = harness();
    try {
      assert.equal(claimPrepared(h, "first-prepared", "first-prepared-target").kind, "created");
      const controller = controllerFor(h, scoreFor);
      await assert.rejects(
        controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "second-while-prepared" })),
        (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_source_already_claimed",
      );
      assert.equal(h.store.listRuns().length, 2);
      assert.equal(h.store.gateRecovery(h.sourceRunId, "second-while-prepared"), null);
    } finally { h.cleanup(); }
  });

  await t.test("completed lineage blocks a second request ID", async () => {
    const h = harness();
    try {
      const controller = controllerFor(h, scoreFor);
      await controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "first-completed" }));
      await assert.rejects(
        controller.recover(h.sourceRunId, validateGateRecoveryRequest({ clientRequestId: "second-after-completed" })),
        (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_source_already_claimed",
      );
      assert.equal(h.store.listRuns().length, 2);
      assert.equal(h.store.gateRecovery(h.sourceRunId, "second-after-completed"), null);
    } finally { h.cleanup(); }
  });

  await t.test("infra-failed lineage permits one fresh request ID and then exhausts the source", async () => {
    const h = harness();
    try {
      const failed = new GateRecoveryController({
        store: h.store,
        paths: h.paths,
        readiness: READY,
        makeGate: async () => ({
          scorerImageDigest: IMAGE_DIGEST,
          score: async () => { throw new Error("injected scorer infrastructure failure"); },
        }),
      });
      const first = await failed.recover(
        h.sourceRunId,
        validateGateRecoveryRequest({ clientRequestId: "first-infra-failed" }),
      );
      assert.equal(first.recoveryState, "infra_failed");
      const secondFailure = new GateRecoveryController({
        store: h.store,
        paths: h.paths,
        readiness: READY,
        makeGate: async () => ({
          scorerImageDigest: IMAGE_DIGEST,
          score: async () => { throw new Error("second injected scorer infrastructure failure"); },
        }),
      });
      const second = await secondFailure.recover(
        h.sourceRunId,
        validateGateRecoveryRequest({ clientRequestId: "second-after-infra" }),
      );
      assert.equal(second.recoveryState, "infra_failed");
      assert.notEqual(second.targetRunId, first.targetRunId);
      assert.equal(h.store.listRuns().length, 3);
      await assert.rejects(
        controllerFor(h, scoreFor).recover(
          h.sourceRunId,
          validateGateRecoveryRequest({ clientRequestId: "third-after-two-infra" }),
        ),
        (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_attempts_exhausted",
      );
      assert.equal(h.store.listRuns().length, 3, "the exhausted source must not create a third child");
    } finally { h.cleanup(); }
  });
});

test("precreated scorer output symlinks are refused without touching their targets", async () => {
  const h = harness();
  try {
    const target = join(h.root, "outside-score.json");
    writeFileSync(target, "outside must remain unchanged\n", "utf8");
    const targetRunId = "score-output-symlink-target";
    const scores = join(h.paths.results, "scores");
    mkdirSync(scores, { recursive: true });
    symlinkSync(target, join(scores, `${targetRunId}.json`));
    let scoreCalls = 0;
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      newRunId: () => targetRunId,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async () => { scoreCalls += 1; throw new Error("must not invoke scorer"); },
      }),
    });
    const result = await controller.recover(
      h.sourceRunId,
      validateGateRecoveryRequest({ clientRequestId: "score-output-symlink" }),
    );
    assert.equal(result.recoveryState, "infra_failed");
    assert.equal(result.heldOutPass, null);
    assert.equal(scoreCalls, 0);
    assert.equal(readFileSync(target, "utf8"), "outside must remain unchanged\n");
    assert.equal(lstatSync(join(scores, `${targetRunId}.json`)).isSymbolicLink(), true);
  } finally { h.cleanup(); }
});

test("precreated scorer-out run directories are refused before plan.json can follow a symlink", async () => {
  const h = harness();
  try {
    const target = join(h.root, "outside-plan.json");
    writeFileSync(target, "outside plan must remain unchanged\n", "utf8");
    const targetRunId = "scorer-out-symlink-target";
    const scorerOut = join(h.paths.results, "scorer-out", targetRunId);
    mkdirSync(scorerOut, { recursive: true });
    symlinkSync(target, join(scorerOut, "plan.json"));
    let scoreCalls = 0;
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      newRunId: () => targetRunId,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async () => { scoreCalls += 1; throw new Error("must not invoke scorer"); },
      }),
    });
    const result = await controller.recover(
      h.sourceRunId,
      validateGateRecoveryRequest({ clientRequestId: "scorer-out-symlink" }),
    );
    assert.equal(result.recoveryState, "infra_failed");
    assert.equal(scoreCalls, 0);
    assert.equal(readFileSync(target, "utf8"), "outside plan must remain unchanged\n");
    assert.equal(lstatSync(join(scorerOut, "plan.json")).isSymbolicLink(), true);
  } finally { h.cleanup(); }
});

test("precreated tamper-report symlinks are refused before scorer construction", async () => {
  const h = harness();
  try {
    const target = join(h.root, "outside-tamper.json");
    writeFileSync(target, "outside tamper must remain unchanged\n", "utf8");
    const targetRunId = "tamper-symlink-target";
    const tamper = join(h.paths.results, "tamper");
    mkdirSync(tamper, { recursive: true });
    symlinkSync(target, join(tamper, `${targetRunId}.json`));
    let scoreCalls = 0;
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      newRunId: () => targetRunId,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async () => { scoreCalls += 1; throw new Error("must not invoke scorer"); },
      }),
    });
    const result = await controller.recover(
      h.sourceRunId,
      validateGateRecoveryRequest({ clientRequestId: "tamper-symlink" }),
    );
    assert.equal(result.recoveryState, "infra_failed");
    assert.equal(scoreCalls, 0);
    assert.equal(readFileSync(target, "utf8"), "outside tamper must remain unchanged\n");
    assert.equal(lstatSync(join(tamper, `${targetRunId}.json`)).isSymbolicLink(), true);
  } finally { h.cleanup(); }
});

test("a symlinked quarantine directory is never followed during an uncertain score", async () => {
  const h = harness();
  try {
    const outside = join(h.root, "outside-quarantine");
    mkdirSync(outside);
    const scores = join(h.paths.results, "scores");
    mkdirSync(scores, { recursive: true });
    symlinkSync(outside, join(scores, "recovery-uncertain"));
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async (run, suite) => {
          const score = scoreFor(run, suite);
          writeScore(h.paths, score);
          writeFileSync(join(run.artifactPath, "app.txt"), "mutated during score\n", "utf8");
          return score;
        },
      }),
    });
    const result = await controller.recover(
      h.sourceRunId,
      validateGateRecoveryRequest({ clientRequestId: "quarantine-symlink" }),
    );
    assert.equal(result.recoveryState, "infra_failed");
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(lstatSync(join(scores, "recovery-uncertain")).isSymbolicLink(), true);
  } finally { h.cleanup(); }
});

test("quarantine never replaces an existing dangling target symlink", async () => {
  const h = harness();
  try {
    const request = validateGateRecoveryRequest({ clientRequestId: "quarantine-dangling-target" });
    const targetRunId = "quarantine-dangling-target";
    const scores = join(h.paths.results, "scores");
    const owned = join(scores, "recovery-uncertain", targetRunId);
    const danglingTarget = join(owned, `${targetRunId}.json`);
    const controller = new GateRecoveryController({
      store: h.store,
      paths: h.paths,
      readiness: READY,
      newRunId: () => targetRunId,
      makeGate: async () => ({
        scorerImageDigest: IMAGE_DIGEST,
        score: async (run, suite) => {
          mkdirSync(owned, { recursive: true });
          writeFileSync(join(owned, GATE_RECOVERY_OWNER_FILE), `${JSON.stringify({
            protocolVersion: GATE_RECOVERY_PROTOCOL_VERSION,
            sourceRunId: h.sourceRunId,
            clientRequestId: request.clientRequestId,
            payloadSha256: request.payloadSha256,
            targetRunId,
          })}\n`, "utf8");
          symlinkSync(join(h.root, "missing-quarantine-target"), danglingTarget);
          const score = scoreFor(run, suite);
          writeScore(h.paths, score);
          writeFileSync(join(run.artifactPath, "app.txt"), "mutated during score\n", "utf8");
          return score;
        },
      }),
    });
    const result = await controller.recover(h.sourceRunId, request);
    assert.equal(result.recoveryState, "infra_failed");
    assert.equal(lstatSync(danglingTarget).isSymbolicLink(), true);
    assert.equal(lstatSync(join(scores, `${targetRunId}.json`)).isFile(), true);
  } finally { h.cleanup(); }
});

test("a symlinked runs root is refused before recovery creates a child", async () => {
  const h = harness();
  try {
    const realRuns = `${h.paths.runs}-real`;
    renameSync(h.paths.runs, realRuns);
    symlinkSync(realRuns, h.paths.runs);
    const before = h.store.listRuns().length;
    await assert.rejects(
      controllerFor(h, scoreFor).recover(
        h.sourceRunId,
        validateGateRecoveryRequest({ clientRequestId: "runs-root-symlink" }),
      ),
      (error: unknown) => error instanceof GateRecoveryRefusal && error.code === "gate_recovery_runs_root_unsafe",
    );
    assert.equal(h.store.listRuns().length, before);
  } finally { h.cleanup(); }
});
