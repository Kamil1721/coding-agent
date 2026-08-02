/**
 * api.test.ts — the frozen HTTP contract and the SSE attach protocol, over a
 * real loopback server.
 *
 * The orchestrator is stubbed HERE AND ONLY HERE: starting a real run spawns a
 * builder subprocess and spends the owner's quota, which a test must never do.
 * Everything else — the router, the store, the bus, the SSE replay, the auth
 * probe, the model catalog — is the real code path. The auth probe is pointed
 * at two throwaway executables so that "logged in" and "not logged in" are both
 * exercised against the actual `execFile` probe rather than a mock of it.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApiDesignLock,
  ApiErrorResponse,
  CreateRunResponse,
  GraphState,
  ModelOption,
  RunDetail,
  RunGraphResponse,
  RunSummary,
  SseEvent,
} from "./api-types.js";
import { foldGraph, foldGraphAll } from "./graph.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import type { StoredEvent } from "./db.js";
import { DESIGN_MOCKUP_LABEL, designLockPolicy, writeDesignLock } from "./design-lock.js";
import type { DesignLockRecord } from "./design-lock.js";
import type { DesignLockedBy } from "./design-manifest.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer, designLockInteractive } from "./http.js";
import type { RunController } from "./http.js";
import { CODEX_DEFAULT_MODEL_ID, ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, ensureRunDirs, resolvePaths, runPathsFor } from "./paths.js";

const FAKE_MODELS: readonly ModelInfo[] = [
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { value: "haiku", displayName: "Haiku", description: "", supportsEffort: false },
];

interface ResumeCall {
  readonly runId: string;
  readonly chosenMockup: string | null;
}

interface Harness {
  readonly base: string;
  readonly store: RunStore;
  readonly bus: RunEventBus;
  readonly paths: DashboardPaths;
  readonly calls: { pump: number; cancelled: string[]; resumed: ResumeCall[] };
  close(): Promise<void>;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

async function startHarness(claudeLoggedIn: boolean): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-api-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const claudeBin = join(dir, "claude-stub");
  writeExecutable(
    claudeBin,
    claudeLoggedIn
      ? '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com"}\'\n'
      : "#!/bin/sh\nexit 1\n",
  );
  const codexBin = join(dir, "codex-stub");
  writeExecutable(codexBin, '#!/bin/sh\necho "Not logged in"\nexit 1\n');

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin, codexBin, env: process.env });
  const catalog = new ModelCatalog(auth, {}, async () => FAKE_MODELS);
  const calls = { pump: 0, cancelled: [] as string[], resumed: [] as ResumeCall[] };
  const orchestrator: RunController = {
    pump: () => {
      calls.pump += 1;
    },
    cancel: (runId) => {
      calls.cancelled.push(runId);
      store.updateRun(runId, { status: "cancelled", endedAt: new Date().toISOString() });
      return true;
    },
    /**
     * A FIXTURE, NOT THE THING UNDER TEST.
     *
     * Whether a chosen path is one of the run's mockups is decided inside the
     * real `Orchestrator` — it holds the manifest and the lock. This stub mimics
     * that decision only so the ROUTER's two jobs can be observed: forwarding
     * the parsed `chosenMockup`, and turning a `false` into a 409 that names the
     * path. Nothing below may be read as proof that the SERVER validates the
     * path; the check that the value crossed the seam at all is
     * `calls.resumed`.
     */
    resume: (runId, chosenMockup = null) => {
      calls.resumed.push({ runId, chosenMockup: chosenMockup ?? null });
      const row = store.getRun(runId);
      if (row === null || row.status !== "awaiting_input") return false;
      if (chosenMockup === null || chosenMockup === undefined) return true;
      return store.listScreenshots(runId).some((shot) => shot.path === chosenMockup);
    },
    // No live segment in a routing test, so every message falls to the queue.
    pushLiveMessage: () => false,
  };

  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    // INJECTED SO A ROUTING TEST CANNOT TOUCH THE DAEMON. Without this the
    // health route cold-starts a real `createGate`, which shells out to
    // `docker image inspect` — so this test's outcome would depend on whether
    // the machine running it happens to have Docker up, and it would spawn a
    // child process a routing test has no business spawning.
    gate: new GateProbe({
      paths,
      makeGate: () => Promise.reject(new Error("no docker in a routing test")),
    }),
  });
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    bus,
    paths,
    calls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("GET /api/health reports each CLI's login state, and nothing else about it", async () => {
  const harness = await startHarness(true);
  try {
    const response = await fetch(`${harness.base}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["claudeAuth", "codexAuth", "gate", "ok"]);
    assert.equal(body["claudeAuth"], "ok");
    assert.equal(body["codexAuth"], "missing", "codex is genuinely not logged in on this machine");
    // THE GATE IS REPORTED, AND `ok` DELIBERATELY STILL MEANS AUTH ONLY.
    // `cron-tick.ts` journals "no CLI is authenticated" on `ok: false`; folding
    // a down daemon into that flag would stop the scheduler while naming the
    // wrong cause.
    const gate = body["gate"] as Record<string, unknown>;
    assert.equal(gate["state"], "unavailable", "the injected gate refuses, and that must surface as a state");
    assert.match(String(gate["detail"]), /no docker in a routing test/, "with the REASON, not a bare flag");
    assert.equal(body["ok"], true, "a down gate is not an auth failure and must not flip `ok`");
    // The stub printed an email. It must not appear anywhere in the response.
    assert.doesNotMatch(JSON.stringify(body), /example\.com/);
  } finally {
    await harness.close();
  }
});

test("GET /api/models is truthful about what can actually run", async () => {
  const harness = await startHarness(true);
  try {
    const models = (await (await fetch(`${harness.base}/api/models`)).json()) as ModelOption[];
    const byId = new Map(models.map((model) => [model.id, model]));

    const opus = byId.get("opus[1m]");
    assert.ok(opus !== undefined, "the Anthropic rows come from the CLI's own model list");
    assert.equal(opus.provider, "anthropic");
    assert.equal(opus.tier, "included");
    assert.equal(opus.available, true);
    assert.equal(opus.reason, null);

    // THE WHOLE LIST, BY ID. Asserted as a set rather than by probing for rows
    // that should be present: every check below this line about what is ABSENT is
    // a check that passes when nothing is there, and the only way to make those
    // fail for the right reason is to pin what IS there.
    assert.deepEqual(
      models.map((model) => model.id).sort(),
      ["haiku", "opus[1m]"],
      "the offered catalog is the CLI's Anthropic rows and nothing else",
    );

    // CLAUDE ONLY — owner, 2026-07-30. These three are positive assertions on
    // purpose. The version of this test before the removal said
    // `for (const metered of models.filter(...))` and would have gone on passing
    // over an empty array, reporting nothing about a catalog that no longer had a
    // metered row in it.
    assert.equal(
      models.filter((model) => model.tier === "metered").length,
      0,
      "the owner removed the metered vendors: no served row carries that tier",
    );
    assert.equal(
      models.filter((model) => model.provider !== "anthropic").length,
      0,
      "Claude only: every offered row is an Anthropic row",
    );
    assert.equal(
      byId.has(CODEX_DEFAULT_MODEL_ID),
      false,
      "Codex is scoped out (spec section 14) and must not be offered, even though it still resolves",
    );
    for (const gone of ["kimi-k3", "deepseek-v4-pro"]) {
      assert.equal(byId.has(gone), false, `${gone} was removed by the owner on 2026-07-30`);
    }
  } finally {
    await harness.close();
  }
});

test("the Codex row still RESOLVES, and says it is out of scope rather than unauthenticated", async () => {
  const harness = await startHarness(true);
  try {
    // Not offered by `/api/models` (asserted above) but still resolvable, so a
    // stale caller — cron, curl, a bookmarked script — gets 409 and the reason
    // instead of 400 "unknown model", which would read as a typo.
    const response = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketText: "anything", modelId: CODEX_DEFAULT_MODEL_ID }),
    });
    assert.equal(response.status, 409, "resolvable, therefore not unknown_model");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["error"], "model_unavailable");
    assert.match(String(body["message"]), /scoped the Codex provider out/);
    assert.doesNotMatch(
      String(body["remediation"]),
      /Authenticate/,
      "no login fixes a scope decision; sending the owner to `codex login` would be a wrong instruction",
    );
    assert.match(String(body["remediation"]), /Pick a Claude model/);
  } finally {
    await harness.close();
  }
});

test("every model is unavailable, with a reason, when the CLI is not logged in", async () => {
  const harness = await startHarness(false);
  try {
    const models = (await (await fetch(`${harness.base}/api/models`)).json()) as ModelOption[];
    // THE EXACT ROW, NOT A COUNT. `length > 0` plus a loop was the old shape here
    // and it is the weaker one twice over: it passes on a one-row list that says
    // nothing useful, and after the Claude-only removal it would also pass on a
    // list that had lost the row this test exists to check.
    assert.deepEqual(
      models.map((model) => model.id),
      ["default"],
      "with no CLI login there is no model list to ask for, so the catalog falls back to one row",
    );
    for (const model of models) {
      assert.equal(model.available, false);
      assert.ok((model.reason ?? "").length > 0, `${model.id} must say why`);
      assert.match(
        model.reason ?? "",
        /claude/i,
        "the reason has to name the CLI to log in to, since that is the fix",
      );
    }
    const health = (await (await fetch(`${harness.base}/api/health`)).json()) as Record<string, unknown>;
    assert.equal(health["claudeAuth"], "missing");
    assert.equal(health["ok"], false);
  } finally {
    await harness.close();
  }
});

test("POST /api/runs creates a queued run; costUsd is null and heldOutPass undetermined", async () => {
  const harness = await startHarness(true);
  try {
    const created = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketText: "# Portfolio\n\nBuild a one-page portfolio site.", modelId: "opus[1m]" }),
    });
    assert.equal(created.status, 201);
    const { runId } = (await created.json()) as { runId: string };
    assert.match(runId, /^run-/);
    assert.equal(harness.calls.pump, 1, "creating a run must ask the queue to advance");

    const summaries = (await (await fetch(`${harness.base}/api/runs`)).json()) as RunSummary[];
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.ok(summary !== undefined);
    assert.equal(summary.status, "queued");
    assert.equal(summary.ticketTitle, "Portfolio");
    assert.equal(summary.heldOutPass, null, "not determined is not the same as failed");
    assert.equal(summary.falseFinish, null);

    const detail = (await (await fetch(`${harness.base}/api/runs/${runId}`)).json()) as RunDetail;
    assert.equal(detail.costUsd, null, "a subscription run has no dollar cost and must never invent one");
    assert.equal(detail.tokens, null);
    // `plan`, NOT `spec`, SINCE 2026-08-02. A queued run has not reached any
    // phase, so this field is a statement about what it will do FIRST, and the
    // plan phase is now that — `createRun` seeds it and `db.ts`'s `PHASES` leads
    // with it. Leaving `spec` here would have every queued run render one phase
    // ahead of where it actually starts.
    assert.equal(detail.phase, "plan");
    assert.deepEqual(detail.criteria, []);
    assert.deepEqual(detail.screenshots, []);
    assert.equal(detail.previewUrl, null);
    assert.deepEqual(detail.rateLimit, { limited: false, retryAfterSec: null });
  } finally {
    await harness.close();
  }
});

test("POST /api/runs refuses an unavailable model rather than queueing work that cannot run", async () => {
  // 409 NEEDS A MODEL THAT IS OFFERED BUT CANNOT RUN. Before 2026-07-30 that was
  // `kimi-k3`, which was permanently unavailable; with the metered rows gone the
  // only remaining case is a Claude row with the CLI logged out, so this arm now
  // runs on the logged-out harness. Losing the arm entirely would have left the
  // 409 branch of `http.ts` unexercised.
  const loggedOut = await startHarness(false);
  try {
    const response = await fetch(`${loggedOut.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketText: "anything", modelId: "default" }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["error"], "model_unavailable");
    assert.match(String(body["remediation"]), /Authenticate the provider's CLI/);
    assert.equal(loggedOut.calls.pump, 0, "a refused model must not advance the queue");
  } finally {
    await loggedOut.close();
  }

  const harness = await startHarness(true);
  try {
    // THE REMOVED IDS ARE NOW UNKNOWN, NOT DISABLED. This is the assertion that
    // proves the removal reached the resolver and not just the served list.
    for (const removed of ["kimi-k3", "deepseek-v4-pro"]) {
      const gone = await fetch(`${harness.base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketText: "anything", modelId: removed }),
      });
      assert.equal(gone.status, 400, `${removed} is gone from the catalog, so it is an unknown id`);
      assert.equal(((await gone.json()) as Record<string, unknown>)["error"], "unknown_model");
    }

    const unknown = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketText: "anything", modelId: "gpt-9000" }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as Record<string, unknown>)["error"], "unknown_model");

    const empty = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketText: "   ", modelId: "opus[1m]" }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await harness.close();
  }
});

test("cancel and resume answer honestly, including when they refuse", async () => {
  const harness = await startHarness(true);
  try {
    const { runId } = (await (
      await fetch(`${harness.base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketText: "build a thing", modelId: "opus[1m]" }),
      })
    ).json()) as { runId: string };

    const cancelled = await fetch(`${harness.base}/api/runs/${runId}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { ok: true });
    assert.deepEqual(harness.calls.cancelled, [runId]);

    const resumed = await fetch(`${harness.base}/api/runs/${runId}/resume`, { method: "POST" });
    assert.equal(resumed.status, 409, "a finished run is not resumable");
    assert.match(String(((await resumed.json()) as Record<string, unknown>)["remediation"]), /new run/);

    const missing = await fetch(`${harness.base}/api/runs/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

/**
 * The attach race.
 *
 * A client that connects late must see the run from the beginning, exactly
 * once. This emits events BEFORE the connection, then more DURING the replay
 * window, and asserts the delivered sequence is complete and duplicate-free.
 */
test("SSE replays history, then streams live, with no gap and no duplicate", async () => {
  const harness = await startHarness(true);
  try {
    const runId = "run-sse";
    harness.store.createRun({
      runId,
      ticketId: "t-sse",
      ticketTitle: "sse",
      ticketText: "sse",
      ticketSha256: "b".repeat(64),
      modelId: "opus[1m]",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
    // Three events exist before anyone is listening.
    harness.bus.emit(runId, { type: "status", status: "queued" });
    harness.bus.emit(runId, { type: "phase", phase: "spec" });
    harness.bus.emit(runId, { type: "log", level: "info", text: "before-connect" });

    const response = await fetch(`${harness.base}/api/runs/${runId}/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: { id: number; event: SseEvent }[] = [];
    let buffer = "";
    let emittedDuringReplay = false;

    while (seen.length < 5) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Emit two more the moment the first byte arrives: the window in which a
      // naive read-then-subscribe would drop them.
      if (!emittedDuringReplay) {
        emittedDuringReplay = true;
        harness.bus.emit(runId, { type: "log", level: "info", text: "during-replay" });
        harness.bus.emit(runId, { type: "status", status: "running" });
      }

      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const idLine = /^id: (\d+)$/m.exec(frame);
        const dataLine = /^data: (.*)$/m.exec(frame);
        if (idLine !== null && dataLine !== null) {
          seen.push({ id: Number(idLine[1]), event: JSON.parse(dataLine[1] ?? "{}") as SseEvent });
        }
        index = buffer.indexOf("\n\n");
      }
    }
    await reader.cancel();

    assert.equal(seen.length, 5, "three replayed plus two emitted during the replay window");
    assert.deepEqual(
      seen.map((entry) => entry.id),
      [1, 2, 3, 4, 5],
      "sequence ids must be gap-free and in order",
    );
    const texts = seen
      .map((entry) => (entry.event.type === "log" ? entry.event.text : entry.event.type))
      .join("|");
    assert.match(texts, /before-connect/);
    assert.match(texts, /during-replay/);
    assert.equal(new Set(seen.map((entry) => entry.id)).size, 5, "no duplicates");
  } finally {
    await harness.close();
  }
});

test("Last-Event-ID resumes an SSE stream instead of replaying it", async () => {
  const harness = await startHarness(true);
  try {
    const runId = "run-resume-sse";
    harness.store.createRun({
      runId,
      ticketId: "t-r",
      ticketTitle: "r",
      ticketText: "r",
      ticketSha256: "c".repeat(64),
      modelId: "opus[1m]",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
    for (let i = 0; i < 4; i += 1) {
      harness.bus.emit(runId, { type: "log", level: "info", text: `event-${String(i)}` });
    }

    const response = await fetch(`${harness.base}/api/runs/${runId}/events`, {
      headers: { "Last-Event-ID": "2" },
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const ids: number[] = [];
    while (ids.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const match of buffer.matchAll(/^id: (\d+)$/gm)) ids.push(Number(match[1]));
      if (ids.length >= 2) break;
    }
    await reader.cancel();
    assert.deepEqual(ids, [3, 4], "only events after the last one the client saw");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * GET /api/runs/:id/graph — the snapshot (spec §9.2)
 * ---------------------------------------------------------------------- */

function seedRun(harness: Harness, runId: string): void {
  harness.store.createRun({
    runId,
    ticketId: "t-g",
    ticketTitle: "g",
    ticketText: "g",
    ticketSha256: "d".repeat(64),
    modelId: "opus[1m]",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
}

const ROOT: SseEvent = {
  type: "graph_agent",
  node: "n1",
  parent: null,
  agent: "orchestrator",
  lane: null,
  description: "the run's own session",
  ambient: false,
  attribution: "exact",
  sdk: null,
};

const REVIEWER: SseEvent = {
  type: "graph_agent",
  node: "n2",
  parent: "n1",
  agent: "code-reviewer",
  lane: "review",
  description: "review the diff",
  ambient: false,
  attribution: "exact",
  sdk: { taskId: "task-1", toolUseId: "toolu_1" },
};

test("GET /api/runs/:id/graph folds DURABLE ROWS, and atSeq is the last one folded", async () => {
  const harness = await startHarness(true);
  try {
    const runId = "run-graph";
    seedRun(harness, runId);
    // Interleaved with ordinary events on purpose: the canvas rides the SAME
    // stream as `status`/`phase`, which is what makes "this agent was running
    // inside a cancelled run" impossible to render rather than merely unlikely.
    harness.bus.emit(runId, { type: "status", status: "running" });
    harness.bus.emit(runId, ROOT);
    harness.bus.emit(runId, { type: "log", level: "info", text: "working" });
    harness.bus.emit(runId, REVIEWER);
    harness.bus.emit(runId, {
      type: "graph_tool",
      node: "n2",
      name: "Read",
      mcpServer: null,
      summary: "file_path: /w/a.ts",
      attribution: "exact",
    });

    const response = await fetch(`${harness.base}/api/runs/${runId}/graph`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as RunGraphResponse;

    // THE WATERMARK IS THE LAST ROW THAT WENT INTO THIS FOLD. Five events were
    // appended, so the fold saw seq 1..5 and the client must resume at 5.
    assert.equal(body.atSeq, 5);
    assert.deepEqual(
      body.nodes.map((node) => node.id),
      ["n1", "n2"],
    );
    assert.deepEqual(body.edges, [{ from: "n1", to: "n2", attribution: "exact" }]);
    assert.equal(body.nodes[1]?.toolCalls, 1);
    // Nothing recorded an inventory, and that is not the same as an empty one.
    assert.equal(body.inventory, null);
  } finally {
    await harness.close();
  }
});

test("GRAPH: the snapshot plus the tail from atSeq equals folding from zero", async () => {
  // THE INVARIANT THE ENDPOINT EXISTS TO PRESERVE. `atSeq` must be the seq of the
  // last row actually folded, never `store.latestSeq()`: the client opens
  // `EventSource(…?lastEventId=atSeq)`, which replays rows with `seq > atSeq`, so
  // a watermark AHEAD of the fold drops every event in the gap from BOTH channels
  // and reads as a canvas that is merely a little stale.
  //
  // THE RACE IS FORCED, NOT HOPED FOR, AND THAT IS THE WHOLE TEST. The first
  // draft of this appended events after calling `fetch()` and awaited the
  // response — and it stayed GREEN under the exact mutation it was written to
  // catch, because those appends all land before the server ever reads the
  // table, leaving `latestSeq()` and "the last row folded" equal. A test that
  // cannot distinguish the two implementations is not a test of the invariant.
  //
  // So the append is injected INTO the read: the store's own `eventsSince` is
  // wrapped for the duration, and a row is written the instant the handler has
  // taken its rows. That is exactly the window a live run creates, and it is the
  // only way to open it deterministically from out here.
  const harness = await startHarness(true);
  try {
    const runId = "run-graph-race";
    seedRun(harness, runId);
    harness.bus.emit(runId, ROOT);
    harness.bus.emit(runId, REVIEWER);

    const store = harness.store as unknown as {
      eventsSince: (runId: string, after: number) => readonly StoredEvent[];
    };
    const realEventsSince = store.eventsSince.bind(harness.store);
    let raced = false;
    store.eventsSince = (id: string, after: number): readonly StoredEvent[] => {
      const rows = realEventsSince(id, after);
      if (!raced) {
        raced = true;
        harness.bus.emit(id, {
          type: "graph_tool",
          node: "n2",
          name: "Write",
          mcpServer: null,
          summary: "file_path: /w/b.ts",
          attribution: "exact",
        });
        harness.bus.emit(id, {
          type: "graph_agent_status",
          node: "n2",
          state: "completed",
          attribution: "exact",
        });
      }
      return rows;
    };

    const body = (await (
      await fetch(`${harness.base}/api/runs/${runId}/graph`)
    ).json()) as RunGraphResponse;
    store.eventsSince = realEventsSince;
    assert.ok(raced, "the read seam was never exercised, so no race was forced");
    assert.equal(body.atSeq, 2, "atSeq must be the last row FOLDED, not the table's newest");

    // Resume exactly where the snapshot stopped, as the client does.
    const tail = harness.store.eventsSince(runId, body.atSeq).map((row) => row.event);
    let state: GraphState = { nodes: body.nodes, edges: body.edges, inventory: body.inventory };
    for (const event of tail) state = foldGraph(state, event);

    const fromZero = foldGraphAll(harness.store.eventsSince(runId, 0).map((row) => row.event));
    assert.deepEqual(state, fromZero, "the snapshot->tail seam lost or duplicated an event");
    assert.equal(state.nodes[1]?.state, "completed");
    assert.equal(state.nodes[1]?.toolCalls, 1);
  } finally {
    await harness.close();
  }
});

test("GRAPH: a run recorded before the canvas existed returns an EMPTY canvas, not an error", async () => {
  // No feature flag exists, because there is nothing to flag: an old run is a
  // stream of `log`/`tool`/`status` rows and the reducer returns those unchanged.
  // A fold that threw on an unrecognised type would take this endpoint down on
  // every historical run — the requirement, inverted.
  const harness = await startHarness(true);
  try {
    const runId = "run-graph-legacy";
    seedRun(harness, runId);
    harness.bus.emit(runId, { type: "status", status: "queued" });
    harness.bus.emit(runId, { type: "phase", phase: "build" });
    harness.bus.emit(runId, { type: "log", level: "info", text: "an old run" });
    harness.bus.emit(runId, { type: "tool", name: "Read", summary: "a.ts" });
    harness.bus.emit(runId, { type: "status", status: "passed" });

    const response = await fetch(`${harness.base}/api/runs/${runId}/graph`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as RunGraphResponse;
    assert.deepEqual(body, { atSeq: 5, nodes: [], edges: [], inventory: null });
  } finally {
    await harness.close();
  }
});

test("GRAPH: a run that exists but has said nothing is 200-and-empty, and an unknown run is 404", async () => {
  // WHAT THIS TEST CARRIES: EXISTENCE, NOT THE WATERMARK.
  //
  // A run that has emitted nothing yet — queued, or a builder that has not
  // spoken — must be answerable and empty, while a run id that was never issued
  // must be a 404. Collapsing those two is how an additive read route turns into
  // an id oracle in one direction, and how a freshly created run's canvas turns
  // into an error page in the other. Proved able to fail on 2026-07-29 by making
  // `graphSnapshot` 404 a run with zero rows: THIS test went red on the 200 below
  // and the race test below stayed green.
  //
  // WHAT IT DOES NOT CARRY, MEASURED: the `atSeq` line below is NOT coverage of
  // the watermark invariant. Under the mutation `atSeq := store.latestSeq(runId)`
  // — the exact defect the watermark exists to prevent — this test stays GREEN,
  // because `latestSeq` of a run with no rows is also 0. Its failure mode there
  // is a strict subset of another check's, which makes it not a second check.
  // The test that carries that invariant is "GRAPH: the snapshot plus the tail
  // from atSeq equals folding from zero", which forces an append INTO the read so
  // that the two implementations can differ at all.
  const harness = await startHarness(true);
  try {
    seedRun(harness, "run-graph-silent");
    const response = await fetch(`${harness.base}/api/runs/run-graph-silent/graph`);
    assert.equal(
      response.status,
      200,
      "a run that exists and has emitted nothing is not a missing run",
    );
    const body = (await response.json()) as RunGraphResponse;
    // Spelling, not the invariant: read the note above before trusting this line.
    assert.equal(body.atSeq, 0, "an empty run must hand the client a replay-from-zero watermark");
    assert.deepEqual(body.nodes, []);

    const missing = await fetch(`${harness.base}/api/runs/no-such-run/graph`);
    assert.equal(missing.status, 404, "the additive route must not become a way to probe run ids");
  } finally {
    await harness.close();
  }
});

test("GRAPH: the REAL redactor runs over graph rows, and node identity survives it", async () => {
  // THE DESIGN RULE OF THIS WHOLE PHASE, AGAINST THE ACTUAL FUNCTION THAT FORCED
  // IT. Everywhere else the collision is SIMULATED by typing the literal
  // `[REDACTED:HIGH_ENTROPY_TOKEN]` into a fixture; here two genuinely distinct
  // 40+ char mixed-case-and-digit task ids go through
  // `bus.emit` -> `store.appendEvent` -> `redactForPersistence` and come back
  // from the table. If they come back identical — and they do — then a canvas
  // keyed on `sdk.taskId` merges two agents into one node, with every short-id
  // fixture in the suite still green. That is why ids are minted `n1`, `n2`.
  const harness = await startHarness(true);
  try {
    const runId = "run-graph-redaction";
    seedRun(harness, runId);
    const taskA = "TaskId7f3aB9c2D4e6F8a0B1c3D5e7F9a1B3c5D7e9F1a3B5c7";
    const taskB = "TaskIdQ2w3E4r5T6y7U8i9O0p1A2s3D4f5G6h7J8k9L0z1X2c";
    assert.notEqual(taskA, taskB, "the fixture ids must differ before persistence");

    harness.bus.emit(runId, { ...ROOT, sdk: { taskId: taskA, toolUseId: null } });
    harness.bus.emit(runId, { ...REVIEWER, sdk: { taskId: taskB, toolUseId: null } });
    // A real sha256 of the environment. It must SURVIVE: a fingerprint that is
    // byte-identical on every run looks exactly like a working hash and
    // distinguishes nothing, which is the failure build-environment.ts's header
    // was written about.
    const hash = "9f2b7c1e5a08d4f36b9e0c7a1d8f2e5b4c6a9d0e3f7b1c5a8d2e6f0b4c7a9d13";
    harness.bus.emit(runId, {
      type: "graph_inventory",
      agents: 154,
      skills: 162,
      tools: 42,
      allowedAgents: ["code-reviewer"],
      mcpServers: [{ name: "context7", status: "connected" }],
      plugins: ["railway"],
      model: "claude-opus-5",
      claudeCodeVersion: "2.1.220",
      environmentHash: hash,
    });

    const persisted = harness.store.eventsSince(runId, 0).map((row) => row.event);
    const agents = persisted.filter((event) => event.type === "graph_agent");
    assert.equal(agents.length, 2);
    const [first, second] = agents;
    assert.ok(first?.type === "graph_agent" && second?.type === "graph_agent");

    // THE COLLISION IS REAL, NOT SIMULATED.
    assert.equal(
      first.sdk?.taskId,
      second.sdk?.taskId,
      "the redactor no longer collapses long task ids — re-read the rationale before relying on it",
    );
    assert.notEqual(first.sdk?.taskId, taskA, "the raw id was persisted unredacted");
    // AND THE NODE IDS DO NOT COLLIDE, because nothing rewrites `n1`/`n2`.
    assert.deepEqual([first.node, second.node], ["n1", "n2"]);

    const folded = foldGraphAll(persisted);
    assert.deepEqual(
      folded.nodes.map((node) => node.agent),
      ["orchestrator", "code-reviewer"],
      "two agents were merged into one node after a round-trip through the real redactor",
    );

    const inventory = persisted.find((event) => event.type === "graph_inventory");
    assert.ok(inventory?.type === "graph_inventory");
    assert.equal(
      inventory.environmentHash,
      hash,
      "the environment fingerprint was scrubbed, which makes every run's hash identical",
    );
  } finally {
    await harness.close();
  }
});

test("GRAPH: ?lastEventId= resumes, because EventSource cannot send a header", async () => {
  // THE HANDOFF THE SNAPSHOT EXISTS FOR RIDES ON THIS BRANCH AND ONLY THIS ONE.
  // The client opens `EventSource(/api/runs/:id/events?lastEventId=atSeq)`, and
  // `EventSource` cannot set request headers — so the `Last-Event-ID` path that
  // the existing resume test covers is NOT the path the canvas uses. If the query
  // branch is wrong the client silently replays from zero and pulls the 7.01 MB
  // this endpoint exists to avoid, which reads as a slow first paint rather than
  // as a bug.
  const harness = await startHarness(true);
  try {
    const runId = "run-graph-resume";
    seedRun(harness, runId);
    harness.bus.emit(runId, ROOT);
    harness.bus.emit(runId, REVIEWER);
    const atSeq = harness.store.latestSeq(runId);
    harness.bus.emit(runId, {
      type: "graph_agent_status",
      node: "n2",
      state: "completed",
      attribution: "exact",
    });

    const response = await fetch(
      `${harness.base}/api/runs/${runId}/events?lastEventId=${String(atSeq)}`,
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const ids: number[] = [];
    while (ids.length < 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const match of buffer.matchAll(/^id: (\d+)$/gm)) ids.push(Number(match[1]));
    }
    await reader.cancel();
    assert.deepEqual(ids, [3], "the snapshot's watermark did not resume the stream");
    assert.match(buffer, /event: graph_agent_status/, "named events are what the client listens for");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The DESIGN lock on the HTTP contract — spec §17, Phase 2b Task 11
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE. The orchestrator is stubbed here (see
 * the file header), so nothing below runs a DESIGN lane. What is under test is
 * the ROUTER: the `designLock` value it accepts on `POST /api/runs`, the
 * `{chosenMockup}` it parses off `POST /api/runs/:id/resume` and forwards, and
 * the projection `toDetail` builds from `results/design-lock.json` plus the
 * run's screenshot rows. The lane that writes those two artefacts is tested in
 * `orchestrator.test.ts`.
 * ---------------------------------------------------------------------- */

const MODEL = "opus[1m]";

/** A real 1x1 PNG. The screenshots route types by extension, but bytes are cheap. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function postJson(
  harness: Harness,
  path: string,
  body: unknown,
  /**
   * Extra request headers, for the ONE route that reads one: `createRun` derives
   * `interactive` from `Referer` (§17.3 rule 2). Node's `fetch` forwards it —
   * browsers forbid setting it, undici does not — which is what makes the
   * dashboard shape and the cron shape distinguishable from a test.
   */
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(`${harness.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function detailOf(harness: Harness, runId: string): Promise<RunDetail> {
  const response = await fetch(`${harness.base}/api/runs/${runId}`);
  assert.equal(response.status, 200);
  return (await response.json()) as RunDetail;
}

async function newRun(
  harness: Harness,
  ticketText: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await postJson(harness, "/api/runs", { ticketText, modelId: MODEL, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body as CreateRunResponse).runId;
}

/**
 * A run whose DESIGN lane has already happened, assembled from OUTSIDE the
 * orchestrator.
 *
 * The real `Orchestrator` writes `results/design-lock.json` and registers each
 * mockup through `store.addScreenshot`; it is stubbed here for the reason the
 * file header gives. So this writes exactly the two artefacts `toDetail` reads,
 * plus the PNGs on disk that `GET /api/runs/:id/screenshots/:file` serves. It
 * also registers ONE screenshot that is NOT a mockup, so that the label filter
 * has something to exclude — otherwise `mockups === screenshots` would satisfy
 * a filter that does nothing.
 */
async function designRun(
  harness: Harness,
  record: DesignLockRecord,
  mockupCount: number,
): Promise<{ runId: string; mockups: readonly string[] }> {
  const runId = await newRun(harness, "a portfolio page");
  const shotDir = join(harness.paths.results, "screenshots", runId);
  mkdirSync(shotDir, { recursive: true });

  const mockups: string[] = [];
  for (let index = 1; index <= mockupCount; index += 1) {
    const path = join(shotDir, `0${String(index)}-section.png`);
    writeFileSync(path, ONE_PIXEL_PNG);
    harness.store.addScreenshot(runId, {
      path,
      label: `${DESIGN_MOCKUP_LABEL}section ${String(index)}`,
      capturedAt: new Date().toISOString(),
    });
    mockups.push(path);
  }
  const notAMockup = join(shotDir, "built-page.png");
  writeFileSync(notAMockup, ONE_PIXEL_PNG);
  harness.store.addScreenshot(runId, {
    path: notAMockup,
    label: "the built page",
    capturedAt: new Date().toISOString(),
  });

  const runPaths = runPathsFor(harness.paths, runId);
  ensureRunDirs(runPaths);
  writeDesignLock(runPaths.results, record);
  if (record.awaiting) harness.store.updateRun(runId, { status: "awaiting_input" });
  return { runId, mockups };
}

const PARKED_AT = "2026-07-29T10:00:00.000Z";

function parkedRecord(): DesignLockRecord {
  return { awaiting: true, parkedAt: PARKED_AT, locked: null, lockedBy: null, reason: null };
}

test("POST /api/runs accepts designLock and refuses anything that is not auto, ask or absent", async () => {
  const harness = await startHarness(true);
  try {
    for (const value of ["ask", "auto", null]) {
      const created = await postJson(harness, "/api/runs", {
        ticketText: "a portfolio page",
        modelId: MODEL,
        designLock: value,
      });
      assert.equal(created.status, 201, `designLock: ${JSON.stringify(value)} must be accepted`);
    }
    const absent = await postJson(harness, "/api/runs", { ticketText: "a portfolio page", modelId: MODEL });
    assert.equal(absent.status, 201, "absent is not an error — §17.3 rule 2 defaults it");

    for (const value of [7, "sometimes", true, {}, []]) {
      const refused = await postJson(harness, "/api/runs", {
        ticketText: "a portfolio page",
        modelId: MODEL,
        designLock: value,
      });
      assert.equal(refused.status, 400, `designLock: ${JSON.stringify(value)} must not be accepted`);
      assert.equal((refused.body as ApiErrorResponse).error, "invalid_body");
      assert.match(
        String((refused.body as ApiErrorResponse).message),
        /designLock/,
        "an error that does not name the field is not actionable",
      );
    }
  } finally {
    await harness.close();
  }
});

test("RunDetail.designLock is null for a run that never had a DESIGN lane", async () => {
  const harness = await startHarness(true);
  try {
    const runId = await newRun(harness, "a cli that renames files");
    const detail = await detailOf(harness, runId);
    assert.equal(detail.designLock, null);
  } finally {
    await harness.close();
  }
});

test("a lane that RAN and locked nothing is {awaiting:false, locked:null} — which null could not say", async () => {
  // THE REASON THIS IS ONE NULLABLE FIELD RATHER THAN FOUR FLAT ONES.
  //
  // `null` means "this run has no DESIGN lane". `{awaiting:false, locked:null}`
  // means "the lane ran and produced nothing to lock" — degraded, or failed.
  // Those are different facts, the UI says different things about them, and a
  // flat `awaiting: boolean` + `locked: string | null` pair could not tell them
  // apart: both would read as `false, null`.
  const harness = await startHarness(true);
  try {
    const { runId } = await designRun(
      harness,
      { awaiting: false, parkedAt: PARKED_AT, locked: null, lockedBy: null, reason: null },
      0,
    );
    const detail = await detailOf(harness, runId);
    assert.notEqual(detail.designLock, null, "a lane that ran is not a run with no lane");
    assert.equal(detail.designLock?.awaiting, false);
    assert.equal(detail.designLock?.locked, null);
    assert.deepEqual(detail.designLock?.mockups, []);
  } finally {
    await harness.close();
  }
});

test("a PARKED run reports awaiting:true and lists the mockups the owner has to choose between", async () => {
  const harness = await startHarness(true);
  try {
    const { runId, mockups } = await designRun(harness, parkedRecord(), 5);
    const detail = await detailOf(harness, runId);
    assert.equal(detail.status, "awaiting_input");
    assert.equal(detail.designLock?.awaiting, true);
    assert.equal(detail.designLock?.locked, null);
    assert.deepEqual(
      detail.designLock?.mockups.map((shot) => shot.path),
      mockups,
      "the owner cannot click what the API does not list",
    );
  } finally {
    await harness.close();
  }
});

test("a locked run carries WHO chose and WHY, not just the path (§17.3 rule 4)", async () => {
  const harness = await startHarness(true);
  try {
    const { runId, mockups } = await designRun(
      harness,
      {
        awaiting: false,
        parkedAt: PARKED_AT,
        locked: "",
        lockedBy: "fallback",
        reason: "the timeout expired; the first mockup in manifest order was locked automatically",
      },
      3,
    );
    // The record is rewritten with a path the fixture now knows.
    writeDesignLock(runPathsFor(harness.paths, runId).results, {
      awaiting: false,
      parkedAt: PARKED_AT,
      locked: mockups[0] ?? "",
      lockedBy: "fallback",
      reason: "the timeout expired; the first mockup in manifest order was locked automatically",
    });
    const detail = await detailOf(harness, runId);
    assert.equal(detail.designLock?.locked, mockups[0]);
    assert.equal(detail.designLock?.lockedBy, "fallback");
    assert.match(String(detail.designLock?.reason), /timeout expired/);
  } finally {
    await harness.close();
  }
});

test("designLock.mockups is the DESIGN lane's screenshots and not every screenshot", async () => {
  // The filter is on `ApiScreenshot.label`, and `DESIGN_MOCKUP_LABEL` has ONE
  // definition (design-lock.ts) which both this test and the orchestrator's
  // writer import. Typing the string here instead would let the const drift
  // while every assertion stayed green.
  const harness = await startHarness(true);
  try {
    const { runId, mockups } = await designRun(harness, parkedRecord(), 2);
    const detail = await detailOf(harness, runId);
    assert.equal(detail.screenshots.length, 3, "the fixture registered a non-mockup screenshot too");
    assert.equal(detail.designLock?.mockups.length, 2);
    for (const shot of detail.designLock?.mockups ?? []) {
      assert.ok(shot.label.startsWith(DESIGN_MOCKUP_LABEL), `${shot.label} is not a mockup`);
    }
    assert.deepEqual(detail.designLock?.mockups.map((shot) => shot.path), mockups);
  } finally {
    await harness.close();
  }
});

test("the mockups the API lists are fetchable from the screenshots route", async () => {
  // §17.1: "The screenshots route already serves images by basename." If the
  // mockup is not under results/screenshots/<runId>/, the owner sees five
  // broken cards and nothing anywhere reports an error.
  const harness = await startHarness(true);
  try {
    const { runId } = await designRun(harness, parkedRecord(), 5);
    const detail = await detailOf(harness, runId);
    const first = detail.designLock?.mockups[0];
    assert.ok(first !== undefined, "a parked run with no listed mockup cannot be unparked from the UI");
    const image = await fetch(
      `${harness.base}/api/runs/${runId}/screenshots/${basename(first.path)}`,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    // The BYTES, not just the status line. Also: an unread streamed body keeps
    // the keep-alive connection open and `server.close()` then waits out
    // `keepAliveTimeout`, which turned this test into a 63-second one.
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), ONE_PIXEL_PNG);
  } finally {
    await harness.close();
  }
});

test("costUsd is STILL null on a run whose DESIGN lane spent real money on images", async () => {
  // The lane spends through a key resolved from ~/.gemini/api_key. That spend
  // is a CALL COUNT in design-lane.json and it never becomes a dollar figure
  // here: `costUsd: null` is system-wide for a subscription run.
  const harness = await startHarness(true);
  try {
    const { runId } = await designRun(harness, parkedRecord(), 5);
    const detail = await detailOf(harness, runId);
    assert.equal(detail.costUsd, null);
    assert.doesNotMatch(
      JSON.stringify(detail.designLock),
      /usd|cost|dollar|price/i,
      "nothing in the design record may look like money",
    );
  } finally {
    await harness.close();
  }
});

test("POST /api/runs/:id/resume still accepts an EMPTY body — the rate-limit path is untouched", async () => {
  // Every existing client posts nothing at all. Requiring a body would break
  // resume for rate-limited runs, which is the path this route was built for.
  const harness = await startHarness(true);
  try {
    const { runId } = await designRun(harness, parkedRecord(), 3);
    const empty = await postJson(harness, `/api/runs/${runId}/resume`, undefined);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { ok: true });
    assert.deepEqual(
      harness.calls.resumed,
      [{ runId, chosenMockup: null }],
      "an empty body must reach the orchestrator as `null`, not as a missing call",
    );
  } finally {
    await harness.close();
  }
});

test("POST /api/runs/:id/resume FORWARDS {chosenMockup} to the orchestrator", async () => {
  // The router's whole job on this route. A body that parses but is dropped
  // would leave every test above green and the owner's click doing nothing.
  const harness = await startHarness(true);
  try {
    const { runId, mockups } = await designRun(harness, parkedRecord(), 3);
    const chosen = mockups[1] ?? "";
    const resumed = await postJson(harness, `/api/runs/${runId}/resume`, { chosenMockup: chosen });
    assert.equal(resumed.status, 200);
    assert.deepEqual(harness.calls.resumed, [{ runId, chosenMockup: chosen }]);
  } finally {
    await harness.close();
  }
});

test("a chosenMockup the run does not own is 409, and a refused choice leaves it parked", async () => {
  const harness = await startHarness(true);
  try {
    const { runId } = await designRun(harness, parkedRecord(), 3);
    const bad = await postJson(harness, `/api/runs/${runId}/resume`, { chosenMockup: "/etc/passwd" });
    assert.equal(bad.status, 409);
    assert.equal((bad.body as ApiErrorResponse).error, "not_resumable");
    assert.match(
      String((bad.body as ApiErrorResponse).message),
      /\/etc\/passwd/,
      "a refusal that does not name the path it refused is not diagnosable",
    );
    const detail = await detailOf(harness, runId);
    assert.equal(detail.status, "awaiting_input", "a refused choice leaves the run parked");
    assert.equal(detail.designLock?.awaiting, true);
  } finally {
    await harness.close();
  }
});

test("resume refuses a chosenMockup that is not a string, and a body that is not JSON", async () => {
  const harness = await startHarness(true);
  try {
    const { runId } = await designRun(harness, parkedRecord(), 3);
    const wrongType = await postJson(harness, `/api/runs/${runId}/resume`, { chosenMockup: 7 });
    assert.equal(wrongType.status, 400);
    assert.match(String((wrongType.body as ApiErrorResponse).message), /chosenMockup/);

    const notJson = await fetch(`${harness.base}/api/runs/${runId}/resume`, {
      method: "POST",
      body: "{not json",
    });
    assert.equal(notJson.status, 400);
    assert.deepEqual(harness.calls.resumed, [], "a body that never parsed must not reach the orchestrator");
  } finally {
    await harness.close();
  }
});

test("CONTRACT: the wire's lockedBy union names exactly the domain's DesignLockedBy", () => {
  // api-types.ts is DEPENDENCY-FREE on purpose — the frozen wire contract does
  // not import domain modules — so `"owner" | "ui-designer" | "fallback"` is
  // typed out in three places (server api-types, client api-types,
  // design-manifest). Two of those are joined here, at compile time: each
  // `Record` demands every member of its key union, and the two assignments
  // demand mutual assignability, so a value added to or removed from either
  // side fails to compile rather than drifting.
  const domain: Record<DesignLockedBy, true> = { owner: true, "ui-designer": true, fallback: true };
  const wire: Record<NonNullable<ApiDesignLock["lockedBy"]>, true> = domain;
  const back: Record<DesignLockedBy, true> = wire;
  assert.deepEqual(Object.keys(back).sort(), ["fallback", "owner", "ui-designer"]);
});

test("designLockInteractive is §17.3 rule 2's missing definition", () => {
  // CONCERN 6: "not interactive" is undefined in the spec, so it is defined
  // narrowly — an explicit `designLock`, or a `Referer` from a loopback page.
  // Everything else (curl, cron, a script) is non-interactive and therefore
  // `auto`, because a mis-classified cron request would park forever.
  //
  // ITS CALLER IS `createRun`, which writes the result into the `interactive`
  // column; the test below drives that end of it over real HTTP. This one is the
  // unit, and it is kept separate because the two failures are different: a
  // wrong rule here, a dropped field there.
  assert.equal(designLockInteractive("ask", undefined), true, "an explicit designLock is a deliberate caller");
  assert.equal(designLockInteractive("auto", undefined), true);
  assert.equal(designLockInteractive(null, undefined), false, "curl sends no Referer and asks for nothing");
  assert.equal(designLockInteractive(undefined, undefined), false);
  assert.equal(designLockInteractive(null, "http://127.0.0.1:4319/runs/run-1"), true);
  assert.equal(designLockInteractive(null, "http://localhost:4176/"), true);
  assert.equal(designLockInteractive(null, "https://evil.example.com/"), false);
  assert.equal(designLockInteractive(null, "not a url"), false, "an unparseable Referer is not a dashboard");
});

test("POST /api/runs PERSISTS the lock policy, and the two request shapes resolve DIFFERENTLY", async () => {
  // WRITTEN AS AN INEQUALITY BECAUSE THE PREVIOUS VERSION OF THIS CHECK WAS
  // VACUOUS. While the route discarded `designLock`, every shape stored `''` /
  // `0` and `designLockPolicy` answered `"auto"` for all of them — so a test that
  // asserted "a cron request gets auto" passed for a reason that had nothing to
  // do with cron, and could not have failed. The three shapes are resolved here
  // through the SAME function the build segment calls, and the assertion is that
  // two of them DISAGREE: that cannot hold if the field is thrown away again.
  const harness = await startHarness(true);
  const policyOf = (runId: string): string => {
    const row = harness.store.getRun(runId);
    assert.ok(row !== null);
    return designLockPolicy(row.designLock, row.interactive);
  };
  try {
    // (1) THE CRON SHAPE: no `designLock`, no `Referer`. `curl`, cron, a script.
    const cron = await newRun(harness, "a cli that renames files in place");
    // (2) THE DASHBOARD SHAPE: the page's own submission. `dashboard/src/lib/api.ts`
    // states `designLock: "ask"` rather than leaning on the header, because the
    // `/api/*` rewrite in front of this server may not forward `Referer`.
    const asked = await newRun(harness, "a one-page portfolio", { designLock: "ask" });

    // THE INEQUALITY COMES FIRST, so that a route which drops the field again
    // fails HERE — on the claim that cannot be satisfied by a discarded field —
    // rather than on one of the per-shape assertions below, which would report a
    // missing column and leave this line unexecuted.
    assert.notEqual(policyOf(asked), policyOf(cron), "the two shapes must genuinely differ, or nothing is wired");

    const cronRow = harness.store.getRun(cron);
    assert.equal(cronRow?.designLock, "", "nothing was stated, which is not the same fact as `auto`");
    assert.equal(cronRow?.interactive, false);
    assert.equal(policyOf(cron), "auto", "a scheduled run that parks waiting for a click is rule 2's whole point");
    assert.equal(harness.store.getRun(asked)?.designLock, "ask");
    assert.equal(harness.store.getRun(asked)?.interactive, true, "stating a policy IS a deliberate caller");
    assert.equal(policyOf(asked), "ask");

    // (3) A LOOPBACK `Referer` ALONE, with no stated policy — the browser
    // submission the header path is for.
    const fromPage = await postJson(harness, "/api/runs", {
      ticketText: "a landing page for a bakery",
      modelId: MODEL,
    }, { Referer: `${harness.base}/` });
    assert.equal(fromPage.status, 201);
    const pageRunId = (fromPage.body as CreateRunResponse).runId;
    assert.equal(harness.store.getRun(pageRunId)?.designLock, "", "the page stated nothing; the header carried it");
    assert.equal(harness.store.getRun(pageRunId)?.interactive, true);
    assert.equal(policyOf(pageRunId), "ask");

    // (4) THE FIELD WINS OVER THE HEADER. An explicit `auto` from the dashboard
    // page is a person choosing not to be asked, and it must not be upgraded to
    // `ask` by the `Referer` that request also carries.
    const explicitAuto = await postJson(harness, "/api/runs", {
      ticketText: "a status page",
      modelId: MODEL,
      designLock: "auto",
    }, { Referer: `${harness.base}/` });
    assert.equal(explicitAuto.status, 201);
    const autoRunId = (explicitAuto.body as CreateRunResponse).runId;
    assert.equal(harness.store.getRun(autoRunId)?.designLock, "auto");
    assert.equal(harness.store.getRun(autoRunId)?.interactive, true, "it is interactive — it simply asked for auto");
    assert.equal(policyOf(autoRunId), "auto", "a stated policy is not overridden by the header");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The GATE/FIX loop's outcome, over the real HTTP contract — Phase 2d Task 7
 *
 * `store.updateRun` -> `runs` -> `toDetail` -> the wire is the whole path these
 * two fields have, and it is exercised here end to end. WHAT IS NOT EXERCISED,
 * said here rather than left to be assumed: the step BEFORE `updateRun`.
 * `orchestrator.ts#gateFixLoop` holds the `GateFixLoopResult` next to the run id
 * and does not yet persist it, so in production every run still answers `0` /
 * `null`. That file belongs to another wave; the seam it plugs into is below,
 * and it is proved to carry a value the moment something writes one.
 * ---------------------------------------------------------------------- */

test("RunDetail reports no gate outcome for a run that has not reached the gate", async () => {
  const harness = await startHarness(true);
  try {
    const runId = await newRun(harness, "a cli that renames files");
    const detail = await detailOf(harness, runId);
    assert.equal(detail.gateAttempts, 0, "a queued run has gated zero times, and 0 is the true count");
    assert.equal(detail.gateStopReason, null, "NOT `green` — nothing has been measured about this run");
  } finally {
    await harness.close();
  }
});

test("RunDetail carries the loop's attempts and stop reason once they are persisted", async () => {
  // The pair travels together and neither half is invented on the way out: a
  // `toDetail` that hardcoded either (0, or "green", or the other field's value)
  // would satisfy the test above and fail here.
  const harness = await startHarness(true);
  try {
    const runId = await newRun(harness, "a portfolio page");
    harness.store.updateRun(runId, { gateAttempts: 3, gateStopReason: "not-converging" });
    const detail = await detailOf(harness, runId);
    assert.equal(detail.gateAttempts, 3);
    assert.equal(detail.gateStopReason, "not-converging");

    // A green gate is a RECORDED outcome. It must not serialise back to the
    // "nothing happened" shape the previous test asserts.
    harness.store.updateRun(runId, { gateAttempts: 1, gateStopReason: "green" });
    const green = await detailOf(harness, runId);
    assert.equal(green.gateAttempts, 1);
    assert.equal(green.gateStopReason, "green");
  } finally {
    await harness.close();
  }
});
