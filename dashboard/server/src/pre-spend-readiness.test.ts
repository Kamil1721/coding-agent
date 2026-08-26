/**
 * Negative controls for the fresh scorer-runtime spend barrier.
 *
 * No test here launches Docker, Chromium, a builder or a subscription seat.
 * The point is the host sequencing around those boundaries.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AcceptanceGate } from "bakeoff/dist/contracts.js";

import type { ApiErrorResponse } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import type { GateReadiness, GateReadinessResult } from "./gate-readiness.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { MotionCaptureOptions } from "./motion-capture.js";
import type { MotionCaptureResult } from "./motion-types.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { DashboardPaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import type { CaptureOptions, SiteCaptureResult } from "./site-capture.js";

const MODEL = "opus[1m]";
const DASHBOARD_ORIGIN = "http://127.0.0.1:4319";
const MODELS: readonly ModelInfo[] = [{
  value: MODEL,
  resolvedModel: "claude-opus-5[1m]",
  displayName: "Opus",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
}];

function result(state: GateReadinessResult["state"], detail = `${state} in test`): GateReadinessResult {
  return {
    state,
    detail,
    remediation: "repair the scorer, then retry",
    checkedAt: state === "unknown" ? null : "2026-08-26T12:00:00.000Z",
  };
}

function mutableReadiness(initial: GateReadinessResult): {
  readonly readiness: GateReadiness;
  readonly calls: () => number;
  set(next: GateReadinessResult): void;
} {
  let current = initial;
  let calls = 0;
  return {
    readiness: {
      checkFresh: () => {
        calls += 1;
        return Promise.resolve(current);
      },
    },
    calls: () => calls,
    set: (next) => { current = next; },
  };
}

interface HttpHarness {
  readonly base: string;
  readonly paths: DashboardPaths;
  readonly store: RunStore;
  readonly pumpCalls: () => number;
  readonly captureCalls: () => number;
  close(): Promise<void>;
}

async function httpHarness(
  gateReadiness: GateReadiness,
  captureSite: (options: CaptureOptions) => Promise<SiteCaptureResult> = async () => ({
    ok: false,
    reason: "capture stub must not run on refusal",
  }),
  captureMotion: (options: MotionCaptureOptions) => Promise<MotionCaptureResult> = async () => ({
    ok: false,
    reason: "motion stub must not run on refusal",
  }),
): Promise<HttpHarness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-readiness-http-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const claudeBin = join(dir, "claude-stub");
  writeFileSync(claudeBin, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n', "utf8");
  chmodSync(claudeBin, 0o755);
  const auth = new AuthProbe({ claudeBin, codexBin: join(dir, "missing-codex") });
  const catalog = new ModelCatalog(auth, {}, async () => MODELS);
  let pumpCalls = 0;
  let captureCalls = 0;
  const orchestrator: RunController = {
    pump: () => { pumpCalls += 1; },
    cancel: () => false,
    resume: () => false,
    pushLiveMessage: () => false,
  };
  const gate = new GateProbe({
    paths,
    makeGate: () => Promise.resolve({ scorerImageDigest: `sha256:${"a".repeat(64)}` } as AcceptanceGate),
  });
  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate,
    gateReadiness,
    captureSite: async (options) => {
      captureCalls += 1;
      return await captureSite(options);
    },
    captureMotion: async (options) => await captureMotion(options),
  });
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    paths,
    store,
    pumpCalls: () => pumpCalls,
    captureCalls: () => captureCalls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postRun(harness: HttpHarness, extra: Record<string, unknown> = {}): Promise<Response> {
  return await fetch(`${harness.base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
    body: JSON.stringify({ ticketText: "Build a small static portfolio page.", modelId: MODEL, ...extra }),
  });
}

function assertNoCommittedRun(harness: HttpHarness): void {
  assert.equal(harness.store.listRuns().length, 0);
  assert.deepEqual(readdirSync(harness.paths.runs), []);
  assert.equal(harness.pumpCalls(), 0);
}

test("ready direct intake creates one row and pumps only after the fresh check", async () => {
  const fresh = mutableReadiness(result("ready"));
  const harness = await httpHarness(fresh.readiness);
  try {
    const response = await postRun(harness);
    assert.equal(response.status, 201);
    assert.equal(fresh.calls(), 1, "direct intake performs one fresh readiness check");
    assert.equal(harness.store.listRuns().length, 1);
    assert.equal(harness.pumpCalls(), 1);
  } finally {
    await harness.close();
  }
});

test("run intake refuses cross-origin and non-JSON writes before readiness or spend", async () => {
  const fresh = mutableReadiness(result("ready"));
  const harness = await httpHarness(fresh.readiness);
  try {
    const crossOrigin = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ ticketText: "Build a small static portfolio page.", modelId: MODEL }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(((await crossOrigin.json()) as ApiErrorResponse).error, "cross_origin_write");

    const plainText = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ticketText: "Build a small static portfolio page.", modelId: MODEL }),
    });
    assert.equal(plainText.status, 415);
    assert.equal(((await plainText.json()) as ApiErrorResponse).error, "unsupported_media_type");
    assert.equal(fresh.calls(), 0);
    assert.equal(harness.store.listRuns().length, 0);
    assert.equal(harness.captureCalls(), 0);
    assert.equal(harness.pumpCalls(), 0);
  } finally {
    await harness.close();
  }
});

test("a cached healthy /api/health answer cannot authorize POST after runtime becomes unavailable", async () => {
  const fresh = mutableReadiness(result("ready"));
  const harness = await httpHarness(fresh.readiness);
  try {
    const health = (await (await fetch(`${harness.base}/api/health`)).json()) as Record<string, unknown>;
    assert.equal((health["gate"] as Record<string, unknown>)["state"], "ok");

    // The health probe still has its cached `ok`; only the uncached spend check
    // sees the state change. This is the race the second reading closes.
    fresh.set(result("unavailable", "the scorer smoke container exited 127"));
    const response = await postRun(harness, { captureUrl: "https://example.com" });
    assert.equal(response.status, 503);
    const body = (await response.json()) as ApiErrorResponse;
    assert.equal(body.error, "scorer_unavailable");
    assert.match(body.message, /exited 127/);
    assert.equal(harness.store.listRuns().length, 0, "a refusal writes no run row");
    assert.deepEqual(readdirSync(harness.paths.runs), [], "and mints no run directory or attachment files");
    assert.equal(harness.captureCalls(), 0, "browser capture is below the barrier");
    assert.equal(harness.pumpCalls(), 0, "the queue is never nudged");
  } finally {
    await harness.close();
  }
});

test("unknown direct readiness fails closed with the explicit 503 error shape", async () => {
  const fresh = mutableReadiness(result("unknown", "the readiness adapter produced no answer"));
  const harness = await httpHarness(fresh.readiness);
  try {
    const response = await postRun(harness);
    assert.equal(response.status, 503);
    const body = (await response.json()) as ApiErrorResponse;
    assert.deepEqual(body, {
      error: "scorer_readiness_unknown",
      message: "the scorer runtime is unknown: the readiness adapter produced no answer",
      remediation: "repair the scorer, then retry",
    });
    assert.equal(harness.store.listRuns().length, 0);
    assert.equal(harness.captureCalls(), 0);
    assert.equal(harness.pumpCalls(), 0);
  } finally {
    await harness.close();
  }
});

test("a client disconnect during the fresh intake check cannot create an orphaned run", async () => {
  let announceStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let release: ((value: GateReadinessResult) => void) | null = null;
  let readinessSignal: AbortSignal | undefined;
  const harness = await httpHarness({
    checkFresh: (signal) => {
      readinessSignal = signal;
      announceStarted?.();
      return new Promise<GateReadinessResult>((resolve) => { release = resolve; });
    },
  });
  try {
    const controller = new AbortController();
    const pending = fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
      body: JSON.stringify({ ticketText: "Build a small static portfolio page.", modelId: MODEL }),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    // Let the socket close reach the server before the probe completes.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(readinessSignal?.aborted, true, "the abandoned request aborts the production probe port");
    assertNoCommittedRun(harness);
    assert.ok(release !== null);
    (release as unknown as (value: GateReadinessResult) => void)(result("ready"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertNoCommittedRun(harness);
    assert.equal(harness.captureCalls(), 0);
  } finally {
    await harness.close();
  }
});

test("a client disconnect during reference capture discards provisional files and never pumps", async () => {
  let announceCapture: (() => void) | null = null;
  const captureStarted = new Promise<void>((resolve) => { announceCapture = resolve; });
  let releaseCapture: ((value: SiteCaptureResult) => void) | null = null;
  const harness = await httpHarness(
    READY_GATE_READINESS,
    async () => {
      announceCapture?.();
      return await new Promise<SiteCaptureResult>((resolve) => { releaseCapture = resolve; });
    },
  );
  try {
    const controller = new AbortController();
    const pending = fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
      body: JSON.stringify({
        ticketText: "Build a small static portfolio page.",
        modelId: MODEL,
        captureUrl: "https://example.com/",
      }),
      signal: controller.signal,
    });
    await captureStarted;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.ok(releaseCapture !== null);
    (releaseCapture as unknown as (value: SiteCaptureResult) => void)({ ok: false, reason: "released after abort" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertNoCommittedRun(harness);
  } finally {
    await harness.close();
  }
});

test("a client disconnect during motion capture discards provisional files and never pumps", async () => {
  let announceMotion: (() => void) | null = null;
  const motionStarted = new Promise<void>((resolve) => { announceMotion = resolve; });
  let releaseMotion: ((value: MotionCaptureResult) => void) | null = null;
  const harness = await httpHarness(
    READY_GATE_READINESS,
    undefined,
    async () => {
      announceMotion?.();
      return await new Promise<MotionCaptureResult>((resolve) => { releaseMotion = resolve; });
    },
  );
  try {
    const controller = new AbortController();
    const pending = fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: DASHBOARD_ORIGIN },
      body: JSON.stringify({
        ticketText: "Build a small static portfolio page.",
        modelId: MODEL,
        motionUrl: "https://example.com/",
      }),
      signal: controller.signal,
    });
    await motionStarted;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertNoCommittedRun(harness);
    assert.ok(releaseMotion !== null);
    (releaseMotion as unknown as (value: MotionCaptureResult) => void)({ ok: false, reason: "released after abort" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertNoCommittedRun(harness);
  } finally {
    await harness.close();
  }
});

async function waitForStatus(store: RunStore, runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (store.getRun(runId)?.status !== status) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("queued start rechecks and parks unavailable without opening an attempt or calling a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-readiness-queue-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "missing-claude"), codexBin: join(dir, "missing-codex") });
  const catalog = new ModelCatalog(auth, {}, async () => MODELS);
  let modelCalls = 0;
  const readiness = mutableReadiness(result("unavailable", "Docker stopped while this run waited"));
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: {},
    gateReadiness: readiness.readiness,
    makePlanSeat: () => { modelCalls += 1; throw new Error("plan seat must not be constructed"); },
    makeBuilder: () => { modelCalls += 1; throw new Error("builder must not be constructed"); },
    seatQuery: () => { modelCalls += 1; throw new Error("subscription seat must not be called"); },
  });
  const runId = "run-readiness-race";
  store.createRun({
    runId,
    ticketId: "ticket-readiness-race",
    ticketTitle: "readiness race",
    ticketText: "Build a static page.",
    ticketSha256: "a".repeat(64),
    modelId: MODEL,
    provider: "anthropic",
    deploy: false,
    startedAt: "2026-08-26T12:00:00.000Z",
    queuePosition: 1,
  });
  try {
    orchestrator.pump();
    await waitForStatus(store, runId, "awaiting_input");
    assert.equal(readiness.calls(), 1, "queue entry performs a second fresh reading");
    assert.equal(store.listAttempts(runId).length, 0, "readiness refusal consumes no run attempt");
    assert.equal(modelCalls, 0, "no plan, spec or builder model boundary is reached");
    const row = store.getRun(runId);
    assert.ok(row !== null);
    assert.equal(row.endedAt, null, "the readiness park is durable and nonterminal");
    const log = store.eventsSince(runId, 0)
      .map((entry) => entry.event.type === "log" ? entry.event.text : "")
      .join("\n");
    assert.match(log, /before any run attempt or model spend/);
    assert.match(log, /repair the scorer, then retry/);
  } finally {
    await orchestrator.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner cancellation wins while the fresh queue check is still in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-readiness-cancel-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "missing-claude"), codexBin: join(dir, "missing-codex") });
  const catalog = new ModelCatalog(auth, {}, async () => MODELS);
  let release: ((value: GateReadinessResult) => void) | null = null;
  let readinessSignal: AbortSignal | undefined;
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: {},
    gateReadiness: {
      checkFresh: (signal) => {
        readinessSignal = signal;
        return new Promise<GateReadinessResult>((resolve) => { release = resolve; });
      },
    },
  });
  const runId = "run-readiness-cancel";
  store.createRun({
    runId,
    ticketId: "ticket-readiness-cancel",
    ticketTitle: "readiness cancel",
    ticketText: "Build a static page.",
    ticketSha256: "b".repeat(64),
    modelId: MODEL,
    provider: "anthropic",
    deploy: false,
    startedAt: "2026-08-26T12:00:00.000Z",
    queuePosition: 1,
  });
  try {
    orchestrator.pump();
    assert.equal(orchestrator.cancel(runId), true);
    assert.ok(release !== null, "the cancel lands during the fresh check, not before it starts");
    await waitForStatus(store, runId, "cancelled");
    assert.equal(readinessSignal?.aborted, true);
    assert.equal(store.listAttempts(runId).length, 0);
    (release as unknown as (value: GateReadinessResult) => void)(result("unavailable"));
  } finally {
    await orchestrator.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown interrupts an unresolved fresh queue check without terminalizing the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-readiness-shutdown-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "missing-claude"), codexBin: join(dir, "missing-codex") });
  const catalog = new ModelCatalog(auth, {}, async () => MODELS);
  let release: ((value: GateReadinessResult) => void) | null = null;
  let readinessSignal: AbortSignal | undefined;
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview: new PreviewHost(),
    env: {},
    gateReadiness: {
      checkFresh: (signal) => {
        readinessSignal = signal;
        return new Promise<GateReadinessResult>((resolve) => { release = resolve; });
      },
    },
  });
  const runId = "run-readiness-shutdown";
  store.createRun({
    runId,
    ticketId: "ticket-readiness-shutdown",
    ticketTitle: "readiness shutdown",
    ticketText: "Build a static page.",
    ticketSha256: "c".repeat(64),
    modelId: MODEL,
    provider: "anthropic",
    deploy: false,
    startedAt: "2026-08-26T12:00:00.000Z",
    queuePosition: 1,
  });
  try {
    orchestrator.pump();
    assert.ok(release !== null, "the shutdown lands during the fresh check");
    await orchestrator.shutdown();
    assert.equal(readinessSignal?.aborted, true);
    const row = store.getRun(runId);
    assert.ok(row !== null);
    assert.equal(row.status, "queued");
    assert.equal(row.endedAt, null);
    assert.equal(store.listAttempts(runId).length, 0);
    (release as unknown as (value: GateReadinessResult) => void)(result("ready"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the affirmative readiness fixture is explicit and never the production fallback", async () => {
  assert.equal((await READY_GATE_READINESS.checkFresh()).state, "ready");
});
