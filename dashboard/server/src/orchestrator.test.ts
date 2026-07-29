/**
 * orchestrator.test.ts — the state machine, without spending quota.
 *
 * These exercise the paths a real run cannot cover cheaply: what happens to a
 * run when the server dies mid-build, what cancel does to a run that has not
 * started, and whether a rate-limited run comes back. The build itself is
 * covered by the end-to-end run, not here.
 *
 * `shutdown()` is called before any transition that would otherwise start a
 * queued run. That is deliberate and it is the honest way to test a queue whose
 * next action is "spawn a builder subprocess": the transition under test is the
 * state change, and the pump is stopped so the test cannot spend the owner's
 * subscription to prove it.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";

function harness(): {
  store: RunStore;
  bus: RunEventBus;
  orchestrator: Orchestrator;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "dash-orch-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const orchestrator = new Orchestrator({ store, bus, paths, catalog, auth, preview, env: {} });
  return {
    store,
    bus,
    orchestrator,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(store: RunStore, runId: string, queuePosition: number): void {
  store.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: runId,
    ticketText: `build ${runId}`,
    ticketSha256: "d".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date(Date.now() + queuePosition * 1000).toISOString(),
    queuePosition,
  });
}

test("a run left running by a dead server becomes awaiting_input, not failed", async () => {
  const h = harness();
  try {
    seed(h.store, "run-a", 1);
    h.store.updateRun("run-a", { status: "running", phase: "build", builderSessionId: "session-xyz" });
    await h.orchestrator.shutdown();

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-a");
    assert.ok(row !== null);
    assert.equal(row.status, "awaiting_input", "its subprocess is gone; that is not the model failing");
    assert.equal(row.heldOutPass, null, "no verdict was reached, and none may be invented");
    assert.equal(row.builderSessionId, "session-xyz", "the session id is what makes resume possible");

    const events = h.store.eventsSince("run-a", 0);
    const logs = events.filter((entry) => entry.event.type === "log");
    assert.ok(logs.length > 0, "the run must say what happened to it");
    const text = logs.map((entry) => (entry.event.type === "log" ? entry.event.text : "")).join(" ");
    assert.match(text, /resume/, "and how to continue it");
  } finally {
    h.cleanup();
  }
});

test("queue positions are persisted in submission order and announced on the run's stream", async () => {
  const h = harness();
  try {
    seed(h.store, "run-1", 0);
    seed(h.store, "run-2", 0);
    seed(h.store, "run-3", 0);
    await h.orchestrator.shutdown(); // nothing may start; only the bookkeeping is under test

    const queued = h.orchestrator.assignQueuePositions();
    assert.deepEqual(
      queued.map((row) => row.runId),
      ["run-1", "run-2", "run-3"],
      "oldest first: a queue, not a stack",
    );
    assert.equal(h.store.getRun("run-1")?.queuePosition, 1);
    assert.equal(h.store.getRun("run-2")?.queuePosition, 2);
    assert.equal(h.store.getRun("run-3")?.queuePosition, 3);

    // `RunSummary` has no position field, so the only contract-legal way to
    // surface it is the run's own event stream. Each run must be told its own
    // position, and no other run's.
    for (const [runId, position] of [["run-1", 1], ["run-2", 2], ["run-3", 3]] as const) {
      const texts = h.store
        .eventsSince(runId, 0)
        .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
        .join(" ");
      assert.match(texts, new RegExp(`position ${String(position)} of 3`), `${runId} was not told its position`);
    }

    // Idempotent: a second pass changes nothing and announces nothing.
    const before = h.store.latestSeq("run-2");
    h.orchestrator.assignQueuePositions();
    assert.equal(h.store.latestSeq("run-2"), before, "an unchanged position must not spam the stream");
  } finally {
    h.cleanup();
  }
});

test("cancelling a queued run finishes it without starting anything", async () => {
  const h = harness();
  try {
    seed(h.store, "run-q", 1);
    await h.orchestrator.shutdown();

    assert.equal(h.orchestrator.cancel("run-q"), true);
    const row = h.store.getRun("run-q");
    assert.ok(row !== null);
    assert.equal(row.status, "cancelled");
    assert.notEqual(row.endedAt, null);
    assert.equal(row.heldOutPass, null, "cancelled is not failed: no verdict was reached");
    assert.equal(row.queuePosition, null);

    // A terminal run cannot be cancelled twice, and cannot be resumed.
    assert.equal(h.orchestrator.cancel("run-q"), false);
    assert.equal(h.orchestrator.resume("run-q"), false);
    assert.equal(h.orchestrator.cancel("no-such-run"), false);
  } finally {
    h.cleanup();
  }
});

test("a rate-limited run is resumable and keeps its session", async () => {
  const h = harness();
  try {
    seed(h.store, "run-rl", 1);
    h.store.updateRun("run-rl", {
      status: "rate_limited",
      phase: "build",
      rateLimited: true,
      rateLimitRetryAfterSec: 900,
      rateLimitKind: "five_hour",
      builderSessionId: "session-rl",
      queuePosition: null,
    });
    await h.orchestrator.shutdown();

    assert.equal(h.orchestrator.resume("run-rl"), true);
    const row = h.store.getRun("run-rl");
    assert.ok(row !== null);
    assert.equal(row.status, "queued");
    assert.equal(row.resumeCount, 1);
    assert.equal(row.rateLimited, false, "the flag clears on resume; the window is being retried");
    assert.equal(row.builderSessionId, "session-rl", "resume continues the session, it does not restart");
    assert.equal(row.phase, "build", "and it resumes at the phase it stopped in");
  } finally {
    h.cleanup();
  }
});

test("the local preview serves the artefact on loopback and nowhere else", async () => {
  const h = harness();
  const preview = new PreviewHost();
  try {
    const site = mkdtempSync(join(tmpdir(), "dash-site-"));
    writeFileSync(join(site, "index.html"), "<!doctype html><title>t</title><h1>Hello</h1>", "utf8");

    const url = await preview.serve("run-p", site);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, "loopback only: nothing is published anywhere");

    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Hello/);

    // No SPA fallback: a 404 stays a 404, the same rule the sealed scorer's
    // static mode follows. A catch-all would make a missing page look present.
    assert.equal((await fetch(`${url}/nope`)).status, 404);

    await preview.stop();
    assert.equal(preview.active, null);
  } finally {
    await preview.stop();
    h.cleanup();
  }
});
