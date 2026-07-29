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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
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
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { CODEX_DEFAULT_MODEL_ID, ModelCatalog } from "./models.js";
import { ensureDirs, resolvePaths } from "./paths.js";

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

interface Harness {
  readonly base: string;
  readonly store: RunStore;
  readonly bus: RunEventBus;
  readonly calls: { pump: number; cancelled: string[]; resumed: string[] };
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
  const calls = { pump: 0, cancelled: [] as string[], resumed: [] as string[] };
  const orchestrator: RunController = {
    pump: () => {
      calls.pump += 1;
    },
    cancel: (runId) => {
      calls.cancelled.push(runId);
      store.updateRun(runId, { status: "cancelled", endedAt: new Date().toISOString() });
      return true;
    },
    resume: (runId) => {
      calls.resumed.push(runId);
      return false;
    },
  };

  const server = createDashboardServer({ store, bus, orchestrator, catalog, auth, paths });
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    bus,
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
    assert.deepEqual(Object.keys(body).sort(), ["claudeAuth", "codexAuth", "ok"]);
    assert.equal(body["claudeAuth"], "ok");
    assert.equal(body["codexAuth"], "missing", "codex is genuinely not logged in on this machine");
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

    const codex = byId.get(CODEX_DEFAULT_MODEL_ID);
    assert.ok(codex !== undefined);
    assert.equal(codex.available, false, "codex login status said Not logged in");
    assert.match(codex.reason ?? "", /codex login/);

    for (const metered of models.filter((model) => model.tier === "metered")) {
      assert.equal(metered.available, false, `${metered.id} needs an API key the dashboard does not hold`);
      assert.match(metered.reason ?? "", /API key/);
    }
  } finally {
    await harness.close();
  }
});

test("every model is unavailable, with a reason, when the CLI is not logged in", async () => {
  const harness = await startHarness(false);
  try {
    const models = (await (await fetch(`${harness.base}/api/models`)).json()) as ModelOption[];
    assert.ok(models.length > 0, "the list must not be empty: the UI needs something to explain");
    for (const model of models) {
      assert.equal(model.available, false);
      assert.ok((model.reason ?? "").length > 0, `${model.id} must say why`);
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
    assert.equal(detail.phase, "spec");
    assert.deepEqual(detail.criteria, []);
    assert.deepEqual(detail.screenshots, []);
    assert.equal(detail.previewUrl, null);
    assert.deepEqual(detail.rateLimit, { limited: false, retryAfterSec: null });
  } finally {
    await harness.close();
  }
});

test("POST /api/runs refuses an unavailable model rather than queueing work that cannot run", async () => {
  const harness = await startHarness(true);
  try {
    const response = await fetch(`${harness.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketText: "anything", modelId: "kimi-k3" }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["error"], "model_unavailable");
    assert.match(String(body["remediation"]), /no API key/);

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

test("GRAPH: a run with no events at all answers atSeq 0, and an unknown run is still a 404", async () => {
  const harness = await startHarness(true);
  try {
    seedRun(harness, "run-graph-silent");
    const body = (await (
      await fetch(`${harness.base}/api/runs/run-graph-silent/graph`)
    ).json()) as RunGraphResponse;
    assert.equal(body.atSeq, 0, "a client must replay from zero, not from a guessed watermark");
    assert.deepEqual(body.nodes, []);

    const missing = await fetch(`${harness.base}/api/runs/no-such-run/graph`);
    assert.equal(missing.status, 404, "the additive route must not become a way to probe run ids");
  } finally {
    await harness.close();
  }
});
