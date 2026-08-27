import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { canonicalJson, sha256Hex } from "./creative-contract.js";
import { ENVIRONMENT_FILE } from "./build-environment.js";
import {
  TerminalCreativeRecoveryController,
  TerminalCreativeRecoveryRefusal,
  terminalCreativeRecoveryRunId,
  validateTerminalCreativeRecoveryRequest,
} from "./creative-recovery.js";
import type { TerminalCreativeRecoveryWorkResult } from "./creative-recovery.js";
import {
  CREATIVE_AUTHOR_FILE,
  CREATIVE_COMPILE_FILE,
  CREATIVE_CONTRACT_FILE,
  CREATIVE_RENDER_DIRECTORY,
  hashCreativeArtifact,
  initialCreativePilotStatus,
  readCreativePilotStatus,
  writeCreativePilotStatus,
} from "./creative-pilot.js";
import { RunStore } from "./db.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { RENDER_PROFILE_IDS } from "./render-manifest.js";

function recoveryHarness(options: {
  readonly requestedModelId?: string;
  readonly resolvedModelId?: string;
  readonly environmentSessionId?: string;
} = {}): {
  readonly root: string;
  readonly store: RunStore;
  readonly paths: ReturnType<typeof resolvePaths>;
  readonly sourceRunId: string;
  readonly contractHash: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "creative-recovery-"));
  const paths = resolvePaths({ DASHBOARD_HOME: join(root, "dashboard"), DASHBOARD_PROJECTS_DIR: join(root, "projects") });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const sourceRunId = "terminal-creative-source";
  const source = runPathsFor(paths, sourceRunId);
  mkdirSync(source.workspace, { recursive: true });
  mkdirSync(source.results, { recursive: true });
  writeFileSync(join(source.workspace, "index.html"), '<main data-creative-route="r.home"></main>\n', "utf8");
  const contract = { schemaVersion: 1, contractId: "fixture", routes: [{ id: "home" }] };
  const contractHash = sha256Hex(canonicalJson(contract));
  writeFileSync(join(source.results, CREATIVE_CONTRACT_FILE), `${JSON.stringify(contract)}\n`, "utf8");
  writeFileSync(join(source.results, CREATIVE_AUTHOR_FILE), `${JSON.stringify({ status: "compiled", contractHash })}\n`, "utf8");
  writeFileSync(join(source.results, CREATIVE_COMPILE_FILE), `${JSON.stringify({ outcome: "passed", contractHash, findings: [], checkedAt: "2026-08-26T00:00:00.000Z" })}\n`, "utf8");
  const builderSessionId = "source-builder-session";
  const resolvedModelId = options.resolvedModelId ?? "fixture-model";
  writeFileSync(join(source.results, ENVIRONMENT_FILE), `${JSON.stringify({
    sessionId: options.environmentSessionId ?? builderSessionId,
    model: resolvedModelId,
  })}\n`, "utf8");
  writeCreativePilotStatus(source.results, {
    ...initialCreativePilotStatus(true, true),
    contractHash,
    compile: { outcome: "passed", contractHash, findings: [], checkedAt: "2026-08-26T00:00:00.000Z" },
    heldOutPass: true,
    reviewState: "creative_review_required",
    reviewStopReason: "artifact_contract",
  });
  store.createRun({
    runId: sourceRunId,
    ticketId: "ticket-fixture",
    ticketTitle: "Fixture",
    ticketText: "Build a static web page.",
    ticketSha256: "a".repeat(64),
    modelId: options.requestedModelId ?? "fixture-model",
    provider: "anthropic",
    deploy: false,
    startedAt: "2026-08-26T00:00:00.000Z",
    queuePosition: 1,
  });
  store.updateRun(sourceRunId, {
    status: "failed",
    phase: "done",
    endedAt: "2026-08-26T01:00:00.000Z",
    heldOutPass: true,
    falseFinish: false,
    agentDeclaredDone: true,
    artifactPath: source.workspace,
    suiteSha256: "b".repeat(64),
    failureReason: "deterministic creative artifact-contract mismatch",
    builderSessionId,
  });
  return { root, store, paths, sourceRunId, contractHash, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function terminalAccepted(
  h: ReturnType<typeof recoveryHarness>,
  targetRunId: string,
  values: Partial<TerminalCreativeRecoveryWorkResult> = {},
): TerminalCreativeRecoveryWorkResult {
  const sourcePaths = runPathsFor(h.paths, h.sourceRunId);
  const targetPaths = runPathsFor(h.paths, targetRunId);
  const outcome: TerminalCreativeRecoveryWorkResult = {
    terminalStatus: "passed",
    heldOutPass: true,
    falseFinish: false,
    failureReason: null,
    artifactHashBeforeMutation: hashCreativeArtifact(sourcePaths.workspace, join(sourcePaths.results, CREATIVE_RENDER_DIRECTORY)),
    artifactHashAfterMutation: hashCreativeArtifact(targetPaths.workspace, join(targetPaths.results, CREATIVE_RENDER_DIRECTORY)),
    renderManifestHash: "3".repeat(64),
    criticDisposition: "accept",
    criticAttempt: 1,
    iteration: 0,
    reviewStopReason: "accepted",
    gateAttempts: 1,
    gateStopReason: "green",
    ...values,
  };
  const creative = readCreativePilotStatus(targetPaths.results);
  assert.ok(creative !== null);
  const renderFresh = outcome.criticDisposition === "accept" && outcome.renderManifestHash !== null;
  writeCreativePilotStatus(targetPaths.results, {
    ...creative,
    heldOutPass: outcome.heldOutPass,
    renderManifestHash: outcome.renderManifestHash,
    renderFresh,
    renderProfiles: renderFresh
      ? RENDER_PROFILE_IDS.map((profileId) => ({ profileId, captureCount: 1, complete: true }))
      : null,
    criticDisposition: outcome.criticDisposition,
    criticAttempt: outcome.criticAttempt,
    reviewState: outcome.criticDisposition === "accept" ? "creative_ready" : creative.reviewState,
    reviewStopReason: outcome.reviewStopReason,
  });
  h.store.updateRun(targetRunId, {
    status: outcome.terminalStatus,
    phase: "done",
    endedAt: "2026-08-26T02:00:00.000Z",
    heldOutPass: outcome.heldOutPass,
    falseFinish: outcome.falseFinish,
    failureReason: outcome.failureReason,
    gateAttempts: outcome.gateAttempts,
    gateStopReason: outcome.gateStopReason,
  });
  return outcome;
}

test("terminal creative recovery creates one isolated child and replays without touching its source", async () => {
  const h = recoveryHarness();
  try {
    let calls = 0;
    const controller = new TerminalCreativeRecoveryController({
      store: h.store,
      paths: h.paths,
      run: async ({ targetRunId }) => {
        calls += 1;
        const workspace = runPathsFor(h.paths, targetRunId).workspace;
        const path = join(workspace, "index.html");
        writeFileSync(path, '<main data-creative-route="home"></main>\n', "utf8");
        return terminalAccepted(h, targetRunId, {
          renderManifestHash: "c".repeat(64),
        });
      },
    });
    const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: "repair-1", contractHash: h.contractHash });
    const sourceBefore = readFileSync(join(runPathsFor(h.paths, h.sourceRunId).workspace, "index.html"), "utf8");
    const first = await controller.recover(h.sourceRunId, request);
    const replay = await controller.recover(h.sourceRunId, request);
    assert.equal(first.targetRunId, terminalCreativeRecoveryRunId(h.sourceRunId, request));
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
    assert.equal(h.store.getRun(first.targetRunId)?.status, "passed");
    assert.equal(h.store.getRun(first.targetRunId)?.modelId, "fixture-model");
    assert.equal(first.resolvedModelId, "fixture-model");
    assert.notEqual(first.artifactHashBeforeMutation, first.artifactHashAfterMutation);
    assert.equal(readFileSync(join(runPathsFor(h.paths, h.sourceRunId).workspace, "index.html"), "utf8"), sourceBefore);
    assert.match(readFileSync(join(runPathsFor(h.paths, first.targetRunId).workspace, "index.html"), "utf8"), /data-creative-route="home"/u);

    await assert.rejects(
      controller.recover(h.sourceRunId, { ...request, contractHash: "d".repeat(64) }),
      (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_idempotency_conflict",
    );
    assert.equal(h.store.listRuns().length, 2);
  } finally { h.cleanup(); }
});

test("terminal creative recovery seeds closed publication state and durably replays a pre-gate failure", async () => {
  const h = recoveryHarness();
  try {
    let calls = 0;
    const controller = new TerminalCreativeRecoveryController({
      store: h.store,
      paths: h.paths,
      run: async ({ targetRunId }) => {
        calls += 1;
        const status = readCreativePilotStatus(runPathsFor(h.paths, targetRunId).results);
        assert.ok(status !== null);
        assert.equal(status.contractHash, h.contractHash);
        assert.equal(status.heldOutPass, null);
        assert.equal(status.criticDisposition, null);
        assert.equal(status.ownerDecision, null);
        assert.equal(status.reviewState, "reviewing");
        return terminalAccepted(h, targetRunId, {
          terminalStatus: "failed",
          heldOutPass: null,
          falseFinish: false,
          failureReason: "builder failed before the sealed gate",
          renderManifestHash: null,
          criticDisposition: null,
          criticAttempt: null,
          iteration: null,
          reviewStopReason: "prerequisite_unknown",
          gateAttempts: 0,
          gateStopReason: "infra",
        });
      },
    });
    const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: "pre-gate-failure", contractHash: h.contractHash });
    const first = await controller.recover(h.sourceRunId, request);
    const replay = await controller.recover(h.sourceRunId, request);
    assert.equal(first.terminalStatus, "failed");
    assert.equal(first.gateAttempts, 0);
    assert.equal(first.gateStopReason, "infra");
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, first);
    assert.equal(calls, 1);
  } finally { h.cleanup(); }
});

test("recovery freezes a resolved model alias and refuses environment evidence from another session", async () => {
  const alias = recoveryHarness({ requestedModelId: "default", resolvedModelId: "claude-opus-5[1m]" });
  try {
    const response = await new TerminalCreativeRecoveryController({
      store: alias.store,
      paths: alias.paths,
      run: async ({ targetRunId }) => terminalAccepted(alias, targetRunId),
    }).recover(alias.sourceRunId, { clientRequestId: "resolved-alias", contractHash: alias.contractHash });
    assert.equal(response.resolvedModelId, "claude-opus-5[1m]");
    assert.equal(alias.store.getRun(response.targetRunId)?.modelId, "default", "the owner selector stays recorded beside the frozen resolved identity");
  } finally { alias.cleanup(); }

  const mismatch = recoveryHarness({ environmentSessionId: "different-session" });
  try {
    await assert.rejects(
      new TerminalCreativeRecoveryController({
        store: mismatch.store,
        paths: mismatch.paths,
        run: async () => { throw new Error("must not run"); },
      }).recover(mismatch.sourceRunId, { clientRequestId: "resolved-mismatch", contractHash: mismatch.contractHash }),
      (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_resolved_model_mismatch",
    );
    assert.equal(mismatch.store.listRuns().length, 1);
  } finally { mismatch.cleanup(); }
});

test("the durable recovery preserves a multi-attempt gate history exactly", async () => {
  const h = recoveryHarness();
  try {
    const response = await new TerminalCreativeRecoveryController({
      store: h.store,
      paths: h.paths,
      run: async ({ targetRunId }) => terminalAccepted(h, targetRunId, { gateAttempts: 3, gateStopReason: "green" }),
    }).recover(h.sourceRunId, { clientRequestId: "multi-gate", contractHash: h.contractHash });
    assert.equal(response.gateAttempts, 3);
    assert.equal(response.gateStopReason, "green");
    assert.equal(h.store.getRun(response.targetRunId)?.gateAttempts, 3);
    assert.equal(h.store.getRun(response.targetRunId)?.gateStopReason, "green");
    const record = JSON.parse(readFileSync(join(runPathsFor(h.paths, response.targetRunId).results, "creative-recovery.json"), "utf8")) as Record<string, unknown>;
    assert.equal(record["gateAttempts"], 3);
    assert.equal(record["gateStopReason"], "green");
  } finally { h.cleanup(); }
});

test("the controller admits only one in-flight recovery across distinct request IDs", async () => {
  const h = recoveryHarness();
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = new TerminalCreativeRecoveryController({
      store: h.store,
      paths: h.paths,
      run: async ({ targetRunId }) => {
        await blocked;
        return terminalAccepted(h, targetRunId);
      },
    });
    const first = controller.recover(h.sourceRunId, { clientRequestId: "source-flight-a", contractHash: h.contractHash });
    await assert.rejects(
      controller.recover(h.sourceRunId, { clientRequestId: "source-flight-b", contractHash: h.contractHash }),
      (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_busy",
    );
    assert.equal(h.store.listRuns().length, 2);
    release();
    await first;
  } finally { h.cleanup(); }
});

test("terminal creative recovery refuses a symlink before child creation or builder access", async () => {
  const h = recoveryHarness();
  try {
    symlinkSync("index.html", join(runPathsFor(h.paths, h.sourceRunId).workspace, "alias.html"));
    let calls = 0;
    const controller = new TerminalCreativeRecoveryController({
      store: h.store,
      paths: h.paths,
      run: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });
    const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: "symlink", contractHash: h.contractHash });
    await assert.rejects(
      controller.recover(h.sourceRunId, request),
      (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_symlink_refused",
    );
    assert.equal(calls, 0);
    assert.equal(h.store.listRuns().length, 1);
    assert.equal(existsSync(runPathsFor(h.paths, terminalCreativeRecoveryRunId(h.sourceRunId, request)).root), false);
  } finally { h.cleanup(); }
});

test("terminal creative recovery refuses symlinks hidden under scorer-excluded workspace directories", async () => {
  for (const directory of [".bakeoff", ".git"] as const) {
    const h = recoveryHarness();
    try {
      const sourceWorkspace = runPathsFor(h.paths, h.sourceRunId).workspace;
      mkdirSync(join(sourceWorkspace, directory), { recursive: true });
      symlinkSync("../index.html", join(sourceWorkspace, directory, "hidden-link"));
      let calls = 0;
      const controller = new TerminalCreativeRecoveryController({
        store: h.store,
        paths: h.paths,
        run: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      });
      const request = validateTerminalCreativeRecoveryRequest({
        clientRequestId: `hidden-symlink-${directory.slice(1)}`,
        contractHash: h.contractHash,
      });
      const targetRunId = terminalCreativeRecoveryRunId(h.sourceRunId, request);
      const target = runPathsFor(h.paths, targetRunId);
      await assert.rejects(
        controller.recover(h.sourceRunId, request),
        (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_symlink_refused",
      );
      assert.equal(calls, 0, `${directory} symlink must be refused before worker access`);
      assert.equal(h.store.getRun(targetRunId), null);
      assert.equal(h.store.listRuns().length, 1, `${directory} refusal must not create a child row`);
      assert.equal(existsSync(target.root), false, `${directory} refusal must not create a child root`);
    } finally { h.cleanup(); }
  }
});

test("terminal creative recovery refuses symlinked copied result authorities before staging", async () => {
  for (const file of [CREATIVE_CONTRACT_FILE, CREATIVE_AUTHOR_FILE, CREATIVE_COMPILE_FILE, ENVIRONMENT_FILE] as const) {
    const h = recoveryHarness();
    try {
      const results = runPathsFor(h.paths, h.sourceRunId).results;
      const authority = join(results, file);
      writeFileSync(join(results, `${file}.real`), readFileSync(authority));
      rmSync(authority);
      symlinkSync(`${file}.real`, authority);
      let calls = 0;
      const controller = new TerminalCreativeRecoveryController({
        store: h.store,
        paths: h.paths,
        run: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      });
      const request = validateTerminalCreativeRecoveryRequest({
        clientRequestId: `result-symlink-${file.replace(/[^a-z]/gu, "-")}`,
        contractHash: h.contractHash,
      });
      const targetRunId = terminalCreativeRecoveryRunId(h.sourceRunId, request);
      await assert.rejects(
        controller.recover(h.sourceRunId, request),
        (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_symlink_refused",
      );
      assert.equal(calls, 0);
      assert.equal(h.store.getRun(targetRunId), null);
      assert.equal(existsSync(runPathsFor(h.paths, targetRunId).root), false);
    } finally { h.cleanup(); }
  }
});

test("terminal creative recovery refuses symlinked workspace, references, and documents roots", async () => {
  for (const rootName of ["workspace", "references", "documents"] as const) {
    const h = recoveryHarness();
    try {
      const source = runPathsFor(h.paths, h.sourceRunId);
      const root = rootName === "workspace" ? source.workspace : join(source.root, rootName);
      const external = join(h.root, `external-${rootName}`);
      mkdirSync(external, { recursive: true });
      if (rootName === "workspace") {
        writeFileSync(join(external, "index.html"), '<main data-creative-route="r.home"></main>\n', "utf8");
      }
      rmSync(root, { recursive: true, force: true });
      symlinkSync(external, root);
      let calls = 0;
      const request = validateTerminalCreativeRecoveryRequest({
        clientRequestId: `root-symlink-${rootName}`,
        contractHash: h.contractHash,
      });
      const targetRunId = terminalCreativeRecoveryRunId(h.sourceRunId, request);
      await assert.rejects(
        new TerminalCreativeRecoveryController({
          store: h.store,
          paths: h.paths,
          run: async () => {
            calls += 1;
            throw new Error("must not run");
          },
        }).recover(h.sourceRunId, request),
        (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal && error.code === "creative_recovery_symlink_refused",
      );
      assert.equal(calls, 0);
      assert.equal(h.store.getRun(targetRunId), null);
      assert.equal(existsSync(runPathsFor(h.paths, targetRunId).root), false);
    } finally { h.cleanup(); }
  }
});

test("terminal creative recovery preserves regular .bakeoff and .git workspace trees", async () => {
  const h = recoveryHarness();
  try {
    const sourceWorkspace = runPathsFor(h.paths, h.sourceRunId).workspace;
    mkdirSync(join(sourceWorkspace, ".bakeoff"), { recursive: true });
    mkdirSync(join(sourceWorkspace, ".git", "objects"), { recursive: true });
    writeFileSync(join(sourceWorkspace, ".bakeoff", "self-report.json"), "{}\n", "utf8");
    writeFileSync(join(sourceWorkspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    let calls = 0;
    const controller = new TerminalCreativeRecoveryController({
      store: h.store,
      paths: h.paths,
      run: async ({ targetRunId }) => {
        calls += 1;
        const targetWorkspace = runPathsFor(h.paths, targetRunId).workspace;
        assert.equal(readFileSync(join(targetWorkspace, ".bakeoff", "self-report.json"), "utf8"), "{}\n");
        assert.equal(readFileSync(join(targetWorkspace, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
        writeFileSync(join(targetWorkspace, "index.html"), '<main data-creative-route="home"></main>\n', "utf8");
        return terminalAccepted(h, targetRunId);
      },
    });
    const response = await controller.recover(h.sourceRunId, {
      clientRequestId: "regular-metadata-trees",
      contractHash: h.contractHash,
    });
    assert.equal(calls, 1);
    assert.equal(h.store.getRun(response.targetRunId)?.status, "passed");
  } finally { h.cleanup(); }
});

test("creative-recovery POST enforces owner origin and returns the durable child on replay", async () => {
  const h = recoveryHarness();
  const controller = new TerminalCreativeRecoveryController({
    store: h.store,
    paths: h.paths,
    run: async ({ targetRunId }) => {
      const path = join(runPathsFor(h.paths, targetRunId).workspace, "index.html");
      writeFileSync(path, '<main data-creative-route="home"></main>\n', "utf8");
      return terminalAccepted(h, targetRunId, {
        renderManifestHash: "c".repeat(64),
      });
    },
  });
  const auth = new AuthProbe({ claudeBin: join(h.root, "absent-claude"), codexBin: join(h.root, "absent-codex") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const orchestrator: RunController = { pump: () => {}, cancel: () => false, resume: () => false, pushLiveMessage: () => false };
  const readiness = { checkFresh: async () => ({ state: "unavailable" as const, detail: "unused", remediation: "unused", checkedAt: null }) };
  const server = createDashboardServer({
    store: h.store,
    bus: new RunEventBus(h.store),
    orchestrator,
    catalog,
    auth,
    paths: h.paths,
    creativeRecovery: controller,
    gateReadiness: readiness,
    gate: new GateProbe({ paths: h.paths, makeGate: () => Promise.reject(new Error("not used")) }),
  });
  try {
    await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://${LOOPBACK_HOST}:${String(address.port)}/api/runs/${h.sourceRunId}/creative-recovery`;
    const body = JSON.stringify({ clientRequestId: "http-1", contractHash: h.contractHash });
    const denied = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body });
    assert.equal(denied.status, 403);
    const headers = { "Content-Type": "application/json", Origin: `http://${LOOPBACK_HOST}:4319` };
    const created = await fetch(endpoint, { method: "POST", headers, body });
    assert.equal(created.status, 201);
    const first = await created.json() as { targetRunId: string; replayed: boolean };
    assert.equal(first.replayed, false);
    const replay = await fetch(endpoint, { method: "POST", headers, body });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { targetRunId: string; replayed: boolean };
    assert.equal(replayBody.targetRunId, first.targetRunId);
    assert.equal(replayBody.replayed, true);
    const blocked = await fetch(`http://${LOOPBACK_HOST}:${String(address.port)}/api/runs/${first.targetRunId}/cancel`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { error: string }).error, "creative_recovery_target_controller_owned");
    const unsupportedDecision = await fetch(`http://${LOOPBACK_HOST}:${String(address.port)}/api/runs/${first.targetRunId}/creative-decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "revision_requested", reason: "do more" }),
    });
    assert.equal(unsupportedDecision.status, 409);
    assert.equal((await unsupportedDecision.json() as { error: string }).error, "creative_recovery_decision_unsupported");
    const approve = () => fetch(`http://${LOOPBACK_HOST}:${String(address.port)}/api/runs/${first.targetRunId}/creative-decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "approved" }),
    });
    const approved = await approve();
    assert.equal(approved.status, 200);
    const approval = await approved.json() as { ownerDecision: string; mayPublish: boolean; published: boolean };
    assert.deepEqual(approval, {
      runId: first.targetRunId,
      ownerDecision: "approved",
      mayPublish: true,
      published: true,
      targetRunId: null,
    });
    const approvalReplay = await approve();
    assert.equal(approvalReplay.status, 200);
    assert.deepEqual(await approvalReplay.json(), approval);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.cleanup();
  }
});

test("a fully staged child with a lost DB claim resumes from its owner marker", async () => {
  const h = recoveryHarness();
  try {
    const mutable = h.store as RunStore & { createRun: RunStore["createRun"] };
    const original = h.store.createRun.bind(h.store);
    let failClaim = true;
    mutable.createRun = (...args: Parameters<RunStore["createRun"]>) => {
      if (failClaim) throw new Error("simulated DB claim interruption");
      return original(...args);
    };
    const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: "stage-replay", contractHash: h.contractHash });
    const worker = async ({ targetRunId }: { readonly targetRunId: string }) => terminalAccepted(h, targetRunId);
    const first = new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker });
    await assert.rejects(first.recover(h.sourceRunId, request), /simulated DB claim interruption/u);
    const target = terminalCreativeRecoveryRunId(h.sourceRunId, request);
    assert.equal(existsSync(runPathsFor(h.paths, target).root), true);
    assert.equal(h.store.getRun(target), null);
    failClaim = false;
    const replay = await new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker })
      .recover(h.sourceRunId, request);
    assert.equal(replay.targetRunId, target);
    assert.equal(h.store.getRun(target)?.status, "passed");
  } finally { h.cleanup(); }
});

test("an owned pre-worker DB child resumes preparation without replaying mutation", async () => {
  const h = recoveryHarness();
  try {
    const mutable = h.store as RunStore & { updateRun: RunStore["updateRun"] };
    const original = h.store.updateRun.bind(h.store);
    let interruptPreparation = true;
    mutable.updateRun = (...args: Parameters<RunStore["updateRun"]>) => {
      if (interruptPreparation && args[0] !== h.sourceRunId && args[1].status === "running") {
        interruptPreparation = false;
        throw new Error("simulated preparation interruption");
      }
      return original(...args);
    };
    let calls = 0;
    const worker = async ({ targetRunId }: { readonly targetRunId: string }) => {
      calls += 1;
      return terminalAccepted(h, targetRunId, { renderManifestHash: "9".repeat(64) });
    };
    const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: "prepare-replay", contractHash: h.contractHash });
    const first = new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker });
    await assert.rejects(first.recover(h.sourceRunId, request), /simulated preparation interruption/u);
    const target = terminalCreativeRecoveryRunId(h.sourceRunId, request);
    assert.equal(h.store.getRun(target)?.status, "queued");
    assert.equal(calls, 0);
    const replay = await new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker })
      .recover(h.sourceRunId, request);
    assert.equal(replay.targetRunId, target);
    assert.equal(h.store.getRun(target)?.status, "passed");
    assert.equal(calls, 1);
  } finally { h.cleanup(); }
});

test("a finalizing record reconciles the child verdict without rerunning the worker", async () => {
  const h = recoveryHarness();
  try {
    let calls = 0;
    const worker = async ({ targetRunId }: { readonly targetRunId: string }) => {
      calls += 1;
      return terminalAccepted(h, targetRunId, { renderManifestHash: "6".repeat(64) });
    };
    const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: "finalize-replay", contractHash: h.contractHash });
    const controller = new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker });
    const first = await controller.recover(h.sourceRunId, request);
    const recordPath = join(runPathsFor(h.paths, first.targetRunId).results, "creative-recovery.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath, `${JSON.stringify({ ...record, state: "finalizing" }, null, 2)}\n`, "utf8");
    const replay = await new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker })
      .recover(h.sourceRunId, request);
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
    assert.equal(h.store.getRun(replay.targetRunId)?.status, "passed");
  } finally { h.cleanup(); }
});

test("completed recovery replay rejects foreign target, creative evidence, and resolved-model tampering without rerunning", async () => {
  const cases = [
    ["foreign-target", (record: Record<string, unknown>) => ({ ...record, targetRunId: "run-foreign-target" })],
    ["creative-evidence", (record: Record<string, unknown>) => ({ ...record, renderManifestHash: "a".repeat(64) })],
    ["resolved-model", (record: Record<string, unknown>) => ({ ...record, resolvedModelId: "different-resolved-model" })],
  ] as const;
  for (const [name, tamper] of cases) {
    const h = recoveryHarness();
    try {
      let calls = 0;
      const worker = async ({ targetRunId }: { readonly targetRunId: string }) => {
        calls += 1;
        const target = runPathsFor(h.paths, targetRunId);
        writeFileSync(join(target.workspace, "index.html"), `<main data-creative-route="home">${name}</main>\n`, "utf8");
        return terminalAccepted(h, targetRunId);
      };
      const request = validateTerminalCreativeRecoveryRequest({ clientRequestId: `tamper-${name}`, contractHash: h.contractHash });
      const first = await new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker })
        .recover(h.sourceRunId, request);
      const recordPath = join(runPathsFor(h.paths, first.targetRunId).results, "creative-recovery.json");
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
      writeFileSync(recordPath, `${JSON.stringify(tamper(record), null, 2)}\n`, "utf8");
      await assert.rejects(
        new TerminalCreativeRecoveryController({ store: h.store, paths: h.paths, run: worker })
          .recover(h.sourceRunId, request),
        (error: unknown) => error instanceof TerminalCreativeRecoveryRefusal &&
          (error.code === "creative_recovery_terminal_conflict" || error.code === "creative_recovery_idempotency_conflict"),
      );
      assert.equal(calls, 1, `${name} tampering must not rerun the recovery worker`);
    } finally { h.cleanup(); }
  }
});
