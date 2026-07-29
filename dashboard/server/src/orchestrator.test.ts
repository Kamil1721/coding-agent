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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { ApiScreenshot, ApiTokens, GraphSseEvent } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import type { BuildOutcome, BuildRequest, SubscriptionBuilder } from "./builders/types.js";
import { NOT_RATE_LIMITED } from "./claude-common.js";
import { RunStore, isTerminal } from "./db.js";
import { DESIGN_MOCKUP_LABEL, readDesignLock, writeDesignLock } from "./design-lock.js";
import type { DesignLockRecord } from "./design-lock.js";
import { readDesignManifest, writeDesignManifest } from "./design-manifest.js";
import { readDesignLaneRecord } from "./design-outcome.js";
import { ModelCatalog } from "./models.js";
import type { CatalogEntry } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { ticketFromText } from "./ticket.js";
import { zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";

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

/* -------------------------------------------------------------------------
 * Phase 2b — two build segments against one session, with the lock between
 *
 * WHAT THESE DRIVE, AND WHY IT IS THE WHOLE `#execute` RATHER THAN `#buildPhase`.
 * The sequencing under test is a private method, and a test that reached into it
 * would prove the body and say nothing about whether the run still calls it —
 * the exact shape of defect this repository has shipped four times. So each test
 * below submits a run, calls `pump()`, and reads what the RUN left behind: the
 * durable `design-lock.json`, the screenshot rows, the persisted event stream,
 * and the requests a fake `SubscriptionBuilder` recorded.
 *
 * NO QUOTA IS SPENT, AND IT IS GUARDED RATHER THAN ASSUMED, exactly as
 * run-report.test.ts guards it: the acceptance suite is hand-frozen under
 * `ticketFromText(row.ticketText)` and `verifySuiteIntact` is asserted BEFORE the
 * run starts, because `#specPhase` swallows a mismatch and falls through to
 * `authorAndFreezeSuite`, which spawns the real CLI. The builder is a fake, the
 * catalog answers without the auth probe, and the sealed gate cannot reach docker
 * (the run's `PATH` is empty), so `runGateFixLoop` stops on `infra` at attempt 1
 * and runs no fix rounds — which is what makes "two build() calls, not three" a
 * statement about the two SEGMENTS.
 *
 * WHAT THESE DELIBERATELY DO NOT ASSERT: `RunDetail.designLock`. That field is
 * Task 11's and lands in `api-types.ts`/`http.ts` beside this work. Task 11's own
 * Interfaces block says it CONSUMES `readDesignLock` from here, so the disk
 * record and the screenshot rows are the seam this task owns, and asserting them
 * is not a weaker check — it is the same check one layer before the projection.
 * ---------------------------------------------------------------------- */

const DESIGN_TICKET = "a portfolio page with a considered visual design";

interface SegmentCall {
  readonly prompt: string;
  readonly allowedAgents: readonly string[];
  readonly resumeSessionId: string | null;
  readonly observedSessionId: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * A `SubscriptionBuilder` that never spawns a CLI.
 *
 * IT KEYS ITS BEHAVIOUR OFF THE REAL PROMPT, not off a flag the test sets. The
 * design segment is recognised by `designSegmentPrompt`'s own opening line, and
 * `choice.json` is written ONLY when the prompt asked for it — which is what
 * makes the `auto` run's `lockedBy === "ui-designer"` and the timeout run's
 * `lockedBy === "fallback"` two different facts rather than one fixture switch.
 */
interface FakeBuilderOptions {
  readonly workspace: () => string;
  /** How many PNGs the design segment writes. `0` is THE TRAP's arm. */
  readonly pngCount: number;
  /** Per-segment input token totals, in call order. */
  readonly segmentTokens: readonly number[];
  /** Write no manifest at all, whatever the png count says. */
  readonly writeManifest: boolean;
}

class FakeBuilder implements SubscriptionBuilder {
  readonly provider = "anthropic" as const;
  readonly calls: SegmentCall[] = [];
  #session: string | null = null;
  readonly #options: FakeBuilderOptions;

  constructor(options: FakeBuilderOptions) {
    this.#options = options;
  }

  async build(request: BuildRequest): Promise<BuildOutcome> {
    const index = this.calls.length;
    const resumeSessionId = request.resumeSessionId;
    const sessionId = resumeSessionId ?? `session-${String(index)}`;
    this.#session = sessionId;
    request.sink.session(sessionId);

    // ONE PROJECTION PER BUILD CALL, minting from `n1` again — this is what
    // `graph-emit.ts` does and therefore what the remap has to cope with.
    const agent = index === 0 ? "taste-frontend-expert" : "nextjs-developer";
    request.sink.graph({
      type: "graph_agent",
      node: "n1",
      parent: null,
      agent: null,
      lane: null,
      description: "the run's own session",
      ambient: false,
      attribution: "exact",
      sdk: null,
    });
    request.sink.graph({
      type: "graph_agent",
      node: "n2",
      parent: "n1",
      agent,
      lane: null,
      description: agent,
      ambient: false,
      attribution: "exact",
      sdk: null,
    });
    request.sink.graph({
      type: "graph_tool",
      node: "n2",
      name: "Bash",
      mcpServer: null,
      summary: `${agent} ran something`,
      attribution: "exact",
    });

    const design = request.prompt.startsWith("DESIGN LANE — art direction");
    if (design) this.#runDesignSegment(request);

    const inputTokens = this.#options.segmentTokens[index] ?? 0;
    const tokens: TokenTotals = {
      ...zeroTokens("anthropic"),
      inputTokens,
      callCount: 1,
    };
    // THROUGH THE SINK AS WELL AS THE OUTCOME. The real drivers report totals as
    // they arrive, and the sink writes them onto the row — so a merge that only
    // ran on the outcome would be reading a row segment 2 had already clobbered.
    request.sink.tokens(tokens);

    this.calls.push({
      prompt: request.prompt,
      allowedAgents: [...request.allowedAgents],
      resumeSessionId,
      observedSessionId: sessionId,
      env: request.env,
    });
    return {
      sessionId: this.#session,
      tokens,
      rateLimit: NOT_RATE_LIMITED,
      completed: true,
      cancelled: false,
      failure: null,
    };
  }

  #runDesignSegment(request: BuildRequest): void {
    const workspace = this.#options.workspace();
    const refsDir = join(workspace, "design-refs");
    mkdirSync(refsDir, { recursive: true });
    const refs = [];
    for (let n = 0; n < this.#options.pngCount; n += 1) {
      const path = join(refsDir, `0${String(n + 1)}-section.png`);
      writeFileSync(path, `not really a png ${String(n)}`, "utf8");
      refs.push({ path, section: `section-${String(n + 1)}`, aspect: "16:9" as const, intent: "x" });
      // The tool events the image-call counter reads. `summary` is the command,
      // which names the script by its absolute path.
      request.sink.tool("Bash", `${GEMINI_STUB_NAME} "a prompt" -a 16:9 -o ${path}`);
    }
    writeFileSync(join(refsDir, "direction.md"), "DESIGN_VARIANCE: 3\n", "utf8");
    if (!this.#options.writeManifest || refs.length === 0) return;
    writeDesignManifest(workspace, {
      version: 1,
      refs,
      lockedMockup: null,
      lockedBy: null,
      lockedReason: null,
      lockedAt: null,
    });
    if (request.prompt.includes("choice.json")) {
      writeFileSync(
        join(refsDir, "choice.json"),
        JSON.stringify({ chosen: refs[1]?.path ?? refs[0]?.path, reason: "the strongest hero of the set" }),
        "utf8",
      );
    }
  }
}

/** Answers `resolve` without an auth probe, so no test needs a logged-in CLI. */
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

const GEMINI_STUB_NAME = "gemini-image.sh";

interface DesignHarness {
  readonly runId: string;
  readonly orchestrator: Orchestrator;
  readonly store: RunStore;
  readonly builder: FakeBuilder;
  readonly paths: ReturnType<typeof resolvePaths>;
  readonly builderCalls: readonly SegmentCall[];
  lock(): DesignLockRecord | null;
  mockups(): readonly ApiScreenshot[];
  emittedGraph(): readonly GraphSseEvent[];
  status(): string;
  tokens(): ApiTokens | null;
  settle(timeoutMs?: number): Promise<void>;
  waitFor(ready: () => boolean, timeoutMs: number, what: string): Promise<void>;
  rewindParkTime(ms: number): void;
  cleanup(): Promise<void>;
}

/** `freezeSuite` writes 0444, so a plain rmSync cannot always remove the tree. */
function removeDesignTree(dir: string): void {
  try {
    execFileSync("chmod", ["-R", "u+rwX", dir], { stdio: "ignore" });
  } catch {
    /* best effort; rmSync reports the real problem with the real path */
  }
  rmSync(dir, { recursive: true, force: true });
}

function freezeFor(ticketText: string, acceptanceRoot: string): void {
  const ticket = ticketFromText(ticketText);
  const visible = ['import test from "node:test";', 'test("T-1 the document responds", () => {});', ""].join("\n");
  const heldOut = ['import test from "node:test";', 'test("T-2 the page renders", () => {});', ""].join("\n");
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
        criterionIds: ["REQ-001"],
        source: heldOut,
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
    generatedByHarness: { id: "dashboard-orchestrator-test", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("phase 2b task 10: hand-frozen suite. No model was called."),
    generatedAt: now,
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: now,
  };
  freezeSuite({ suite, plan: planFromDraft(draft), files: draft.files, auditFindings: [] }, { acceptanceRoot });
  const intact = verifySuiteIntact(ticket.id, { acceptanceRoot });
  assert.ok(
    intact.intact,
    "the hand-frozen suite does not verify, so #specPhase would author a real one against the owner's " +
      "subscription",
  );
}

async function designRun(options: {
  ticket?: string;
  designLock?: "auto" | "ask" | null;
  interactive?: boolean;
  noKey?: boolean;
  pngCount?: number;
  writeManifest?: boolean;
  segmentTokens?: readonly number[];
  env?: NodeJS.ProcessEnv;
}): Promise<DesignHarness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-design-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const script = join(dir, GEMINI_STUB_NAME);
  writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n", "utf8");

  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new FakeCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();

  const runId = "run-design";
  const ticketText = options.ticket ?? DESIGN_TICKET;
  const workspace = () => runPathsFor(paths, runId).workspace;
  const builder = new FakeBuilder({
    workspace,
    pngCount: options.pngCount ?? 5,
    segmentTokens: options.segmentTokens ?? [],
    writeManifest: options.writeManifest ?? true,
  });

  const env: NodeJS.ProcessEnv = {
    // The run's own HOME, so `geminiKeyAvailable` never reads the owner's real
    // ~/.gemini/api_key and a test's verdict never depends on whose machine it
    // runs on. No PATH, so the sealed gate cannot find docker and stops on
    // `infra` at attempt 1 rather than scoring a container for ten minutes.
    HOME: home,
    DASHBOARD_GEMINI_IMAGE_SCRIPT: script,
    ...(options.noKey === true ? {} : { GEMINI_API_KEY: "not-a-real-key-fixture" }),
    ...options.env,
  };

  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview,
    env,
    makeBuilder: () => builder,
    // The real preflight spawns `npx impeccable`, which reaches a registry. A
    // sequencing test that pays for that learns nothing about sequencing.
    designRun: async () => ({ code: 0, stderr: "" }),
    designCanWrite: () => true,
  });

  freezeFor(ticketText, paths.acceptance);
  store.createRun({
    runId,
    ticketId: "seeded-at-create",
    ticketTitle: "Portfolio",
    ticketText,
    ticketSha256: "b".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    designLock: options.designLock ?? null,
    interactive: options.interactive ?? false,
  });

  const settled = (): boolean => {
    const row = store.getRun(runId);
    return row !== null && (isTerminal(row.status) || row.status === "awaiting_input");
  };
  const waitUntil = async (ready: () => boolean, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (ready()) return;
      if (Date.now() > deadline) {
        throw new Error(`${what} (last status: ${store.getRun(runId)?.status ?? "gone"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const harness: DesignHarness = {
    runId,
    orchestrator,
    store,
    builder,
    paths,
    get builderCalls() {
      return builder.calls;
    },
    lock: () => readDesignLock(runPathsFor(paths, runId).results),
    mockups: () => store.listScreenshots(runId).filter((shot) => shot.label.startsWith(DESIGN_MOCKUP_LABEL)),
    emittedGraph: () =>
      store
        .eventsSince(runId, 0)
        .map((stored) => stored.event)
        .filter((event): event is GraphSseEvent => event.type.startsWith("graph_")),
    status: () => store.getRun(runId)?.status ?? "gone",
    tokens: () => store.getRun(runId)?.tokens ?? null,
    settle: (timeoutMs = 30_000) => waitUntil(settled, timeoutMs, "the run never settled"),
    waitFor: waitUntil,
    rewindParkTime: (ms) => {
      const results = runPathsFor(paths, runId).results;
      const park = readDesignLock(results);
      assert.ok(park !== null, "there is no park record to rewind");
      writeDesignLock(results, { ...park, parkedAt: new Date(Date.parse(park.parkedAt) - ms).toISOString() });
    },
    cleanup: async () => {
      await orchestrator.shutdown();
      store.close();
      removeDesignTree(dir);
    },
  };

  orchestrator.pump();
  await harness.settle();
  return harness;
}

test("an ASK run parks at awaiting_input with its mockups visible", async () => {
  const h = await designRun({ designLock: "ask" });
  try {
    // NOT `cancelled`. `#buildPhase` returning null would take `#execute`'s
    // cancel path, which calls `#finish` — and a run `isTerminal` says is over
    // is a run the resume route refuses, so the owner's click would 4xx.
    assert.equal(h.status(), "awaiting_input");
    const park = h.lock();
    assert.equal(park?.awaiting, true);
    assert.equal(park?.locked, null);
    assert.equal(h.mockups().length, 5, "the owner cannot click what the API does not list");
    assert.equal(h.builderCalls.length, 1, "segment 2 has not started");
  } finally {
    await h.cleanup();
  }
});

test("an AUTO run never parks, and records who chose and why", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    assert.notEqual(h.status(), "awaiting_input");
    const park = h.lock();
    assert.ok(park !== null, "the choice is recorded either way (§17.3 rule 4)");
    assert.notEqual(park.locked, null);
    assert.equal(park.awaiting, false);
    assert.equal(park.lockedBy, "ui-designer", "the auto-chooser is ui-designer, not the mockup's author");
    assert.ok(String(park.reason).length > 0);
  } finally {
    await h.cleanup();
  }
});

test("resuming with a chosen mockup locks THAT mockup and starts the build segment", async () => {
  const h = await designRun({ designLock: "ask" });
  try {
    const chosen = h.mockups()[1]?.path ?? "";
    // The screenshot copy is what the API serves; the LOCK is on the workspace
    // ref, which is what the build agents and the visual gate read.
    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    const ref = manifest?.refs[1]?.path ?? "";
    assert.ok(chosen.length > 0 && ref.length > 0);

    assert.equal(h.orchestrator.resume(h.runId, ref), true);
    await h.settle();
    assert.equal(h.lock()?.locked, ref);
    assert.equal(h.lock()?.lockedBy, "owner");
    assert.equal(h.builderCalls.length, 2, "two build() calls, not one and not three");
  } finally {
    await h.cleanup();
  }
});

test("resuming with a path that is not a mockup is REFUSED and the run stays parked", async () => {
  const h = await designRun({ designLock: "ask" });
  try {
    assert.equal(h.orchestrator.resume(h.runId, "/etc/passwd"), false);
    assert.equal(h.status(), "awaiting_input");
    assert.equal(h.lock()?.awaiting, true, "and the park record still says so");
    assert.equal(h.builderCalls.length, 1, "no build segment started behind the refusal");
  } finally {
    await h.cleanup();
  }
});

test("ONE SESSION ACROSS BOTH SEGMENTS — this is what keeps §6.1's edges real", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    const [first, second] = h.builderCalls;
    assert.equal(h.builderCalls.length, 2);
    assert.equal(first?.resumeSessionId, null, "segment 1 starts a session");
    assert.equal(second?.resumeSessionId, first?.observedSessionId, "segment 2 resumes THAT session");
  } finally {
    await h.cleanup();
  }
});

test("segment 1 CANNOT reach a build agent — the boundary is the guard, not the prompt", async () => {
  const h = await designRun({ designLock: "ask" });
  try {
    const allowed = h.builderCalls[0]?.allowedAgents ?? [];
    assert.ok(allowed.includes("taste-frontend-expert"));
    assert.ok(allowed.includes("context-manager"), "the SPEC lane runs first; it owns the context DESIGN reads");
    assert.equal(allowed.includes("nextjs-developer"), false);
    assert.equal(allowed.includes("code-reviewer"), false);
  } finally {
    await h.cleanup();
  }
});

test("segment 2's prompt carries the locked mockup's ABSOLUTE path", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    const locked = String(h.lock()?.locked);
    assert.ok(locked.length > 0 && locked !== "null");
    assert.ok(h.builderCalls[1]?.prompt.includes(locked), "§7.3 mechanism 2, at the seam it crosses");
    // And the resume sentence is the true one. "the dashboard was interrupted"
    // is what a session-id-only resume would have said, and it names no mockup.
    assert.match(String(h.builderCalls[1]?.prompt), /the design was locked/);
  } finally {
    await h.cleanup();
  }
});

test("TOKENS ACCUMULATE ACROSS SEGMENTS — segment 2 must not clobber segment 1", async () => {
  // The harness makes segment 2 SMALLER on purpose (1000 in, then 10), which is
  // what makes this red-able without knowing whether a resumed session reports
  // per-call or cumulative totals. Under a clobber the row reads 10.
  const h = await designRun({ designLock: "auto", segmentTokens: [1000, 10] });
  try {
    assert.equal(h.builderCalls.length, 2);
    assert.ok(
      (h.tokens()?.inputTokens ?? 0) >= 1000,
      `the run reports ${String(h.tokens()?.inputTokens)}, which is less than the design segment spent`,
    );
  } finally {
    await h.cleanup();
  }
});

test("and the LIVE token stream never goes backwards either", async () => {
  // A SEPARATE CHECK, BECAUSE THE ROW ALONE CANNOT SEE THIS. The post-call merge
  // fixes the row up afterwards, so removing the merge from the `tokens` SINK
  // leaves every other test in this file green — MEASURED, which is why this one
  // exists. What it breaks is the live stream: the client renders each `tokens`
  // event as it arrives, so segment 2's first event would drop the figure the
  // owner is looking at from 1000 to 10 and then raise it again.
  const h = await designRun({ designLock: "auto", segmentTokens: [1000, 10] });
  try {
    const reported = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "tokens")
      .map((event) => (event.type === "tokens" ? event.inputTokens : 0));
    assert.ok(reported.length >= 2, `only ${String(reported.length)} token event(s) reached the stream`);
    assert.ok(Math.max(...reported) >= 1000, "the design segment's spend was never announced");
    for (const [index, value] of reported.entries()) {
      assert.ok(
        value >= (reported[index - 1] ?? 0),
        `the stream reported ${String(value)} after ${String(reported[index - 1])}: ${JSON.stringify(reported)}`,
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("RULE 1: a parked run auto-selects when the timeout expires", async () => {
  // The timer is an external mechanism; this asserts it FIRES, not that it exists.
  const h = await designRun({ designLock: "ask", env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0.01" } });
  try {
    // POLLED ON THE OUTCOME, NOT ON A TRANSIENT `running`. The second segment is
    // a fake builder and finishes in single-digit milliseconds, so a poll for the
    // intermediate status is a race the timer usually wins — and a test that
    // fails because the thing it was waiting for already happened is a test that
    // gets deleted rather than fixed. What has to be true is that the PARK ENDED
    // without an owner, which is exactly what `awaiting: false` records.
    await h.waitFor(() => h.lock()?.awaiting === false, 15_000, "the design-lock timeout never fired");
    await h.settle();
    assert.notEqual(h.lock()?.locked, null);
    assert.equal(h.lock()?.lockedBy, "fallback", "no chooser ran, and it says so");
    assert.equal(h.builderCalls.length, 2, "and the timeout started the build segment");
  } finally {
    await h.cleanup();
  }
});

test("RULE 1: a restart during a park does not make the park infinite", async () => {
  const h = await designRun({ designLock: "ask" });
  try {
    assert.equal(h.status(), "awaiting_input");
    h.rewindParkTime(60 * 60 * 1000); // parked an hour ago; the process that held the timer is gone
    h.orchestrator.reconcileOnBoot();
    await h.settle();
    assert.notEqual(h.status(), "awaiting_input");
    assert.equal(h.lock()?.awaiting, false);
    assert.equal(h.builderCalls.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("a park that has NOT expired is re-armed on boot rather than resumed or abandoned", async () => {
  // The other arm of the same branch. Without it, a `reconcileOnBoot` that
  // resumed every park would pass the test above while destroying the owner's
  // chance to choose, and the two would be indistinguishable.
  const h = await designRun({ designLock: "ask" });
  try {
    h.orchestrator.reconcileOnBoot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.status(), "awaiting_input", "the window has not expired; the owner may still click");
    assert.equal(h.builderCalls.length, 1);
    // Re-armed for the REMAINDER: the park's clock did not restart.
    const park = h.lock();
    assert.ok(park !== null);
    assert.ok(Date.now() - Date.parse(park.parkedAt) >= 0);
  } finally {
    await h.cleanup();
  }
});

test("segment 2's canvas nodes extend segment 1's instead of colliding with them", async () => {
  // GraphProjection mints from n1 per build call and foldGraph IGNORES a repeat,
  // so an unremapped segment 2 puts the build agent's pills on the designer's
  // node — rendering cleanly and attributing the build's work to the designer.
  const h = await designRun({ designLock: "auto" });
  try {
    const agents = h.emittedGraph().filter((event) => event.type === "graph_agent");
    const ids = agents.map((event) => event.node);
    assert.equal(new Set(ids).size, ids.length - 1, "exactly one repeat: the resumed session's root");
    const roots = agents
      .filter((event) => event.type === "graph_agent" && event.parent === null)
      .map((event) => event.node);
    assert.equal(new Set(roots).size, 1, "one session, one root node");
    // And the build's tool pill is on the build's own node, not the designer's.
    const tools = h.emittedGraph().filter((event) => event.type === "graph_tool");
    assert.equal(new Set(tools.map((event) => event.node)).size, 2, "two segments, two tool owners");
  } finally {
    await h.cleanup();
  }
});

test("a DEGRADED lane still runs both segments and hands over the written direction", async () => {
  const h = await designRun({ designLock: "auto", noKey: true, pngCount: 0, writeManifest: false });
  try {
    assert.equal(h.builderCalls.length, 2);
    assert.match(String(h.builderCalls[1]?.prompt), /direction\.md/);
    assert.equal(h.lock(), null, "nothing to lock, and nothing invented");
    const record = readDesignLaneRecord(runPathsFor(h.paths, h.runId).results);
    assert.equal(record?.mode, "degraded");
    assert.equal(record?.failure, null, "a degraded lane is expected, not broken");
    assert.ok(String(record?.degradeReason).length > 0, "and it names why");
  } finally {
    await h.cleanup();
  }
});

test("THE TRAP: a FULL lane that produced zero images still runs both segments AND says so", async () => {
  // `degraded` and `full`-with-zero produce the same directory listing and must
  // never produce the same report. This is the second of those two.
  const h = await designRun({ designLock: "auto", pngCount: 0, writeManifest: false });
  try {
    assert.equal(h.builderCalls.length, 2, "a zero-image lane must not strand the run at one segment");
    const record = readDesignLaneRecord(runPathsFor(h.paths, h.runId).results);
    assert.equal(record?.mode, "full");
    assert.equal(record?.failure, "no-images");
    const logs = h.store
      .eventsSince(h.runId, 0)
      .filter((stored) => stored.event.type === "log" && stored.event.level === "error")
      .map((stored) => (stored.event.type === "log" ? stored.event.text : ""));
    assert.ok(
      logs.some((text) => text.includes("DESIGN LANE FAILED (no-images)")),
      `no error-level line named the failure; got ${JSON.stringify(logs)}`,
    );
    assert.match(String(h.builderCalls[1]?.prompt), /EXPECTED TO/, "and the build agent is told, not left guessing");
    // MEASURED 2026-07-29, AND WRITTEN DOWN BECAUSE IT CONTRADICTS THE PLAN'S
    // DEFINITION OF DONE. That document claims a zero-image lane is loud in FOUR
    // places, one of them `failureReason`. It is written there — the next test
    // proves it, at the park, where nothing has overwritten it yet — but
    // `failureReason` is a single last-write-wins column, and any run that goes
    // on to reach the gate replaces it with the gate's own answer (here:
    // "docker image inspect ... spawn docker ENOENT"). The DURABLE places are
    // `results/design-lane.json` and the error-level event above, both of which
    // survive; the column does not, and no assertion here pretends otherwise.
    assert.notEqual(
      h.store.getRun(h.runId)?.failureReason,
      null,
      "the run must carry SOME failure reason; which one it ends up with is the gate's, not the lane's",
    );
  } finally {
    await h.cleanup();
  }
});

test("a partial lane writes its failure onto the run row, at the moment it happens", async () => {
  // THE `failureReason` HALF OF THE TRAP, observed where it is still readable:
  // a parked run has not reached the gate, so nothing has overwritten the
  // column yet. Three PNGs of five required is `too-few-images` — a lane that
  // ran, produced something, and does not cover the page.
  const h = await designRun({ designLock: "ask", pngCount: 3 });
  try {
    assert.equal(h.status(), "awaiting_input");
    assert.match(
      String(h.store.getRun(h.runId)?.failureReason),
      /DESIGN LANE FAILED \(too-few-images\)/,
      "a partial set must not be reported as a design",
    );
    const record = readDesignLaneRecord(runPathsFor(h.paths, h.runId).results);
    assert.equal(record?.failure, "too-few-images");
    assert.equal(record?.images, 3);
    // AND IT DOES NOT BLOCK. Degrade-don't-block applies here as everywhere
    // else: the mockups that DO exist are still registered and still clickable.
    assert.equal(h.mockups().length, 3);
  } finally {
    await h.cleanup();
  }
});

test("the DESIGN lane's spend is a COUNT of generation attempts, and never money", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    const record = readDesignLaneRecord(runPathsFor(h.paths, h.runId).results);
    assert.equal(record?.imageCalls, 5, "counted from the Bash calls that named the script");
    assert.equal(record?.keySource, "GEMINI_API_KEY", "WHICH source resolved, never the value");
    const json = JSON.stringify(record);
    assert.doesNotMatch(json, /not-a-real-key-fixture/, "the key value never reaches a record");
    assert.doesNotMatch(json, /usd|cost|price|\$\d/i, "no field here may look like money");
    assert.equal(h.store.getRun(h.runId)?.tokens !== undefined, true);
  } finally {
    await h.cleanup();
  }
});

test("a run with NO design lane takes exactly one segment, with the full shortlist", async () => {
  // The arm that must not move. `designHandoffSection` returns "" for `off`, so
  // a cli ticket's prompt is what it was before this phase existed — and a
  // segment chooser stuck on "design" would be invisible in every test above.
  const h = await designRun({ ticket: "a cli that renames files in place", designLock: "auto" });
  try {
    assert.equal(h.builderCalls.length, 1);
    const allowed = h.builderCalls[0]?.allowedAgents ?? [];
    assert.ok(allowed.includes("cli-developer"));
    assert.equal(allowed.includes("taste-frontend-expert"), false, "no design lane, no design agents");
    assert.equal(h.lock(), null);
    assert.equal(readDesignLaneRecord(runPathsFor(h.paths, h.runId).results), null, "nothing is claimed");
    assert.doesNotMatch(String(h.builderCalls[0]?.prompt), /THE DESIGN IS ALREADY MADE/);
  } finally {
    await h.cleanup();
  }
});

test("the DESIGN subprocess environment names a TMPDIR that EXISTS inside the workspace", async () => {
  // design-env.ts: two callers are required and one without the other produces
  // zero PNGs silently — `mktemp -d` against a TMPDIR that does not exist fails
  // on a stream the permission layer cannot see.
  const h = await designRun({ designLock: "ask" });
  try {
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    const tmp = h.builderCalls[0]?.env["TMPDIR"] ?? "";
    assert.equal(tmp, join(workspace, ".design-tmp"));
    assert.ok(existsSync(tmp), "the variable names a directory nothing created");
    assert.notEqual(h.builderCalls[0]?.env["MOTION_BAR"], "1");
  } finally {
    await h.cleanup();
  }
});
