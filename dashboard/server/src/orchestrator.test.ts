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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { BAKEOFF_SCHEMA_VERSION } from "bakeoff/dist/contracts.js";
import type { AcceptanceSuite } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { acceptanceSuiteDigest, sha256Hex } from "bakeoff/dist/hash.js";
import { freezeSuite, verifySuiteIntact } from "bakeoff/dist/spec-freeze.js";
import { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "bakeoff/dist/spec-types.js";
import type { SuiteDraft } from "bakeoff/dist/spec-types.js";
import type { ApiErrorResponse, ApiScreenshot, ApiTokens, GraphSseEvent, RunDetail } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { MOTION_BAR_ENV, buildOptions } from "./builders/claude-builder.js";
import type { BuildOutcome, BuildRequest, SubscriptionBuilder } from "./builders/types.js";
import { NOT_RATE_LIMITED } from "./claude-common.js";
import { RunStore, isTerminal } from "./db.js";
import {
  DESIGN_MOCKUP_LABEL,
  chosenMockupRef,
  publishedMockupPath,
  readDesignLock,
  writeDesignLock,
} from "./design-lock.js";
import type { DesignLockRecord } from "./design-lock.js";
import {
  DESIGN_MANIFEST_FILE,
  heroRefFor,
  parseDesignManifest,
  readDesignManifest,
  refsForDirection,
  writeDesignManifest,
} from "./design-manifest.js";
import type { DesignManifest, DesignRef } from "./design-manifest.js";
import {
  DESIGN_DIRECTION_CHOICE_FILE,
  MAX_DESIGN_LOCK_TURNS,
  MAX_DESIGN_ON_DEMAND_RENDERS,
  MIN_CANVASS_REFS,
} from "./design-prompt.js";
import { readDesignLaneRecord } from "./design-outcome.js";
import { foldGraphAll } from "./graph.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { CatalogEntry } from "./models.js";
import {
  ABORT_CANCELLED,
  ABORT_SHUTDOWN,
  DASHBOARD_SANDBOX,
  Orchestrator,
  abortReasonOf,
  designPostSegmentAction,
  highestArchivedAttempt,
  recordedNetworkPolicy,
  renderEvidence,
} from "./orchestrator.js";
import type { DesignPostSegmentAction } from "./orchestrator.js";
import { attemptPath, liveResultPath, readAttempt, scorerOutRoot, scoresRoot } from "./gate-attempts.js";
import { containerFixture, coverageFixture, tier0Fixture } from "./container-fixture.js";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { AUTO_CONTINUE_MAX } from "./recovery.js";
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

/**
 * Poll a run's log stream until it says something.
 *
 * The run under test is driven by `pump()`, which is fire-and-forget by design
 * (`void this.#start(...)`), so there is no promise to await. A distinctive log
 * line is the run telling us it reached the branch, and polling for it is the
 * only handle a caller has.
 */
async function waitForLog(
  store: RunStore,
  runId: string,
  pattern: RegExp,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = store
      .eventsSince(runId, 0)
      .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
      .join(" | ");
    if (pattern.test(text)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${String(pattern)}. The run said: ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Wait until the run has stopped executing, WHICHEVER WAY IT WENT.
 *
 * Deliberately not `waitForLog` on the abandonment message: that message only
 * exists when the fix is present, so a regression would fail this test by
 * TIMING OUT after 30s instead of by saying what went wrong. Measured — with the
 * abort routing removed, the log-based wait failed at 30,069ms with "timed out",
 * while this settles in under a second and reports `status: failed`, which is
 * the actual defect. A slow, vague red is a red nobody reads.
 */
async function waitForRunToStop(store: RunStore, runId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getRun(runId);
    if (row !== null) {
      if (isTerminal(row.status)) return;
      const text = store
        .eventsSince(runId, 0)
        .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
        .join(" | ");
      if (/the dashboard stopped while this run was in flight/.test(text)) return;
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} never stopped`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * THE REGRESSION FOR `run-2026-07-30T13-31-38-076Z-c228e63b`.
 *
 * That run died in the SPEC phase with status `failed` and
 * `"Claude Code process aborted by user"` — nobody had aborted anything, and
 * `failed` is terminal, so `resume()` refused it and the owner's only button was
 * dead. The cause was that `#specPhase` THROWS on abort while the build phase
 * returns a discriminant, so the abort check below it never ran.
 *
 * NO QUOTA IS SPENT. The harness environment is `{}`, so the spec seat cannot
 * reach a CLI and fails almost immediately. That failure is not what is under
 * test — what is under test is that an abort OUTRANKS whatever was thrown.
 */
test("a shutdown during the spec phase leaves the run resumable, not failed", async () => {
  const h = harness();
  try {
    seed(h.store, "run-spec-abort", 1);

    // `#start` records the active run synchronously before it awaits, so the
    // shutdown that follows lands on a live signal rather than on nothing.
    h.orchestrator.pump();
    await h.orchestrator.shutdown();
    await waitForRunToStop(h.store, "run-spec-abort");

    const row = h.store.getRun("run-spec-abort");
    assert.ok(row !== null);
    assert.equal(
      row.status,
      "running",
      "a server stop must write NO terminal state — `running` is the exact set reconcileOnBoot scans",
    );
    assert.equal(isTerminal(row.status), false, "and terminal is the one thing it must never be");
    assert.equal(row.endedAt, null, "the run has not ended; it is being picked up again");
    assert.equal(row.failureReason, null, "a clean stop is not a failure and must not be recorded as one");

    const text = h.store
      .eventsSince("run-spec-abort", 0)
      .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
      .join(" | ");
    assert.doesNotMatch(
      text,
      /aborted by user/,
      "the CLI's wording blames the operator for a SIGTERM; it must not be the story the run tells",
    );

    // THE PROMISE THE STOP BANNER MAKES, ACTUALLY EXERCISED. "In-flight builds
    // are aborted and stay resumable" is only true if the next boot recovers it
    // AND resume() then accepts it. Asserting the status alone would prove the
    // button appears, not that it works.
    h.orchestrator.reconcileOnBoot();
    const recovered = h.store.getRun("run-spec-abort");
    assert.equal(recovered?.status, "awaiting_input", "the next boot must offer it back");
    assert.equal(
      h.orchestrator.resume("run-spec-abort"),
      true,
      "and resume must accept it — an enabled button that refuses is the same defect in a new hat",
    );
    assert.equal(h.store.getRun("run-spec-abort")?.status, "queued", "resume requeues it for the spec phase");
  } finally {
    await h.orchestrator.shutdown();
    h.cleanup();
  }
});

/**
 * The other branch of the same signal, kept honest.
 *
 * `#abandonedForShutdown` must NOT swallow a real cancel: an owner who cancels
 * gets a terminal `cancelled` run, exactly as before. Without this, "never write
 * a terminal state on abort" would be over-applied and cancel would silently
 * leave runs `running` forever — no reconciliation revisits them, because the
 * process is still alive.
 */
test("an owner cancel during the spec phase still finishes the run cancelled", async () => {
  const h = harness();
  try {
    seed(h.store, "run-spec-cancel", 1);

    h.orchestrator.pump();
    assert.equal(h.orchestrator.cancel("run-spec-cancel"), true, "the active run must be cancellable");
    await waitForLog(h.store, "run-spec-cancel", /backlog|did not close/i);

    const row = h.store.getRun("run-spec-cancel");
    assert.ok(row !== null);
    assert.equal(row.status, "cancelled", "the owner asked; that IS terminal");
    assert.equal(isTerminal(row.status), true);
    assert.equal(row.heldOutPass, null, "no verdict was reached, and none may be invented");
  } finally {
    await h.orchestrator.shutdown();
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
  /**
   * Captured 2026-07-30. Its absence is WHY the score-record leak survived: the
   * deny set the orchestrator hands each driver was never observable from a test,
   * so no assertion could name a root that was missing from it.
   */
  readonly sealedRoots: readonly string[];
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
  /**
   * Mark every ref `animate: true` — Phase 2c's field, which Phase 2b will one
   * day write for real. Default `false`, so every test above this one sees the
   * manifest it has always seen.
   */
  readonly animateRefs: boolean;
  /**
   * Reach the orchestrator's own callbacks the way a real driver does.
   *
   * `BuildRequest.rateLimit` is how a provider reports window state mid-build,
   * and it lands in `#noteRateLimit` — the only emitter of the `rate_limit` SSE
   * event. Without a seam, the only way to observe what that event carries is a
   * real rate-limited run, which is not a test anyone can schedule.
   */
  readonly onRequest?: (request: BuildRequest) => void;
  /**
   * CANVASS THREE DIRECTIONS, then expand the chosen one — the 2026-08-03 shape.
   *
   * Default `false`, and every test above this line therefore drives the
   * PRE-CANVASS lane verbatim: a manifest with no `directions`, which is exactly
   * what a run written before this date and a lane that ignored the ask both
   * produce. That those tests still pass unchanged IS the compatibility claim.
   */
  readonly directions?: boolean;
  /**
   * A MANIFEST WITH AN EMPTY `refs` ARRAY, WHICH 2026-08-03 MADE A NORMAL SHAPE.
   *
   * `design-prompt.ts`'s degraded canvass tells the lane to write the manifest
   * "with an EMPTY refs array — there are no stills on this run" and one entry
   * per written direction, because every park condition downstream reads
   * `directions.length > 0` off that file.
   *
   *   "canvass" — that file verbatim: no stills, three directions, three
   *               `direction-<slug>.md` documents.
   *   "bare"    — the same empty `refs` with NO directions, which is what the
   *               file looks like when the lane wrote it before it had named
   *               anything. No prompt asks for this one, and that is exactly why
   *               it is a fixture: the park's exit is the run's only exit, so it
   *               has to survive a manifest nobody asked for.
   */
  readonly emptyRefs?: "canvass" | "bare";
  /**
   * THE CANVASS WRITES THE CHOICE INTO THE MANIFEST ITSELF — six stills, three
   * directions, AND `chosenDirection` already set when stage A returns.
   *
   * A SHAPE THE OTHER FIXTURES CANNOT PRODUCE, WHICH IS WHY IT EXISTS. Round 3's
   * park test could only build "a manifest with a choice on it" through
   * `emptyRefs: "canvass"`, so every arm it drove had `refs: []` — and the arm
   * that reads `refs.length` looked guarded while the arm that reads `directions`
   * was not. The lane writes this whole file, `chosenDirection` included, so a
   * lane that picks while it draws produces exactly this; it is also what the
   * crash window in `#applyDirectionChoice` leaves on disk (manifest written,
   * `design-lock.json` not).
   */
  readonly canvassChoice?: string;
  /**
   * STAGE B WRITES THE MANIFEST BACK HAVING LOST SOMETHING — the two shapes the
   * post-expansion arms have to survive.
   *
   *   "choice"     — `directionChoice` truncated (no `at`). The both-or-neither
   *                  rule then reads `chosenDirection` as null, so the file READS
   *                  as an unanswered canvass with all three directions intact.
   *   "directions" — `directions: []` as well. The same rule kills the choice from
   *                  the other side (a slug no surviving direction declares) and
   *                  there is no direction left to lock at all.
   *
   * THE ROUTE IS THE REAL ONE AND IT IS WHY THIS IS A RAW `writeFileSync`. The
   * expansion's manifest is written by the AGENT, and `writeDesignManifest` cannot
   * express either shape: `DesignManifest.directionChoice` is typed, so a fixture
   * going through it would be testing a state the disk can hold and the type
   * cannot. The `at` key is the one omitted because `readDirectionChoice` requires
   * all three of `by`/`reason`/`at` and returns null for any of them.
   */
  readonly expandDrops?: "choice" | "directions";
  /**
   * THE PROVIDER REFUSES THIS CALL — the seam auto-recovery is measured through.
   *
   * `limitCalls: [0]` makes the FIRST `build()` come back with
   * `rateLimit.limited: true` and the reported window below, which is exactly
   * what the real driver returns when the subscription's window is shut. That is
   * the only honest way to drive `#rateLimited` and everything downstream of it —
   * `#armRecovery`, the timer, the automatic requeue — without a live refusal on
   * the owner's own quota, which is a test nobody can schedule and nobody should
   * pay for.
   *
   * THE INDEX IS THE CALL NUMBER, NOT A BOOLEAN, precisely so a test can say
   * "refused once, then fine" and observe the CONTINUATION rather than a run
   * that is refused for ever and can only be seen to stop.
   */
  readonly limitCalls?: readonly number[];
  /** Seconds until the reported window reopens. Small, so a test can wait it out. */
  readonly limitRetryAfterSec?: number;
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
    this.#options.onRequest?.(request);
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
    if (design) {
      const emptyRefs = this.#options.emptyRefs;
      if (emptyRefs !== undefined) this.#runEmptyRefsSegment(request, emptyRefs);
      else if (this.#options.directions === true) this.#runCanvassSegment(request);
      else this.#runDesignSegment(request);
    }

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
      sealedRoots: [...request.sealedRoots],
      resumeSessionId,
      observedSessionId: sessionId,
      env: request.env,
    });
    const refused = (this.#options.limitCalls ?? []).includes(index);
    return {
      sessionId: this.#session,
      tokens,
      rateLimit: refused
        ? {
            limited: true,
            retryAfterSec: this.#options.limitRetryAfterSec ?? 1,
            kind: "five_hour",
            utilization: null,
          }
        : NOT_RATE_LIMITED,
      completed: !refused,
      cancelled: false,
      failure: null,
    };
  }

  /**
   * The two-stage lane, driven off the PROMPT the host actually sent.
   *
   * THE STAGE IS READ, NOT COUNTED. A fixture that keyed on `calls.length`
   * would agree with the orchestrator's loop by construction and could not see
   * it ask for the expansion twice, or never — which is precisely the
   * regression the degraded path has.
   */
  #runCanvassSegment(request: BuildRequest): void {
    const workspace = this.#options.workspace();
    const refsDir = join(workspace, "design-refs");
    mkdirSync(refsDir, { recursive: true });
    const existing = readDesignManifest(workspace);
    const expanding = request.prompt.includes("STAGE B — EXPAND");
    const slugs = ["editorial-slab", "quiet-grid", "warm-stack"];
    const write = (slug: string, index: number, section: string): DesignRef => {
      const path = join(refsDir, `${slug}-${String(index).padStart(2, "0")}-${section}.png`);
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]));
      request.sink.tool(
        "Bash",
        `command: ${join(workspace, "..", "..", "..", GEMINI_STUB_NAME)} "a prompt" -a 16:9 -o ${path}`,
      );
      return {
        path,
        section,
        aspect: "16:9" as const,
        intent: "x",
        direction: slug,
        origin: expanding ? ("expansion" as const) : ("canvass" as const),
      };
    };

    if (!expanding) {
      const refs: DesignRef[] = [];
      for (const slug of slugs) {
        refs.push(write(slug, 1, "hero"));
        refs.push(write(slug, 2, "work"));
        writeFileSync(join(refsDir, `direction-${slug}.md`), `DESIGN_VARIANCE: 3 (${slug})\n`, "utf8");
      }
      const chosen = this.#options.canvassChoice ?? null;
      writeDesignManifest(workspace, {
        version: 1,
        refs,
        directions: slugs.map((slug) => ({
          slug,
          name: slug,
          distinction: `what ${slug} does that the others do not`,
          notes: join(refsDir, `direction-${slug}.md`),
        })),
        chosenDirection: chosen,
        directionChoice:
          chosen === null
            ? null
            : { by: "ui-designer", reason: "the lane picked while it drew", at: new Date().toISOString() },
        lockedMockup: null,
        lockedBy: null,
        lockedReason: null,
        lockedAt: null,
      });
      if (request.prompt.includes(DESIGN_DIRECTION_CHOICE_FILE)) {
        writeFileSync(
          join(refsDir, DESIGN_DIRECTION_CHOICE_FILE),
          JSON.stringify({ chosen: "quiet-grid", reason: "the grid carries the page at every width" }),
          "utf8",
        );
      }
      return;
    }

    // STAGE B: APPEND, never replace, and only for the chosen direction.
    if (existing === null || existing.chosenDirection === null) return;
    const chosen = existing.chosenDirection;
    const added: DesignRef[] = [];
    for (const [offset, section] of ["about", "contact", "footer", "services", "gallery"].entries()) {
      added.push(write(chosen, offset + 3, section));
    }
    writeFileSync(join(refsDir, "direction.md"), `DESIGN_VARIANCE: 3 (${chosen})\n`, "utf8");
    const refs = [...existing.refs, ...added];
    const drops = this.#options.expandDrops;
    if (drops !== undefined) {
      // THE AGENT'S OWN WRITE, in the agent's own currency: the on-disk keys, not
      // `DesignManifest`'s. `locked` is the disk spelling of `lockedMockup`
      // (design-manifest.ts:618) and getting it wrong here would silently drop a
      // lock rather than a choice, which is a different defect.
      writeFileSync(
        join(refsDir, DESIGN_MANIFEST_FILE),
        `${JSON.stringify(
          {
            version: 1,
            refs,
            directions: drops === "directions" ? [] : existing.directions,
            chosenDirection: chosen,
            // TRUNCATED, NOT ABSENT: `readDirectionChoice` needs all three of
            // `by`/`reason`/`at`. On the `"directions"` shape the choice dies of
            // the OTHER half of the same rule — a slug no surviving direction
            // declares — which is why one fixture reaches both.
            directionChoice: { by: "ui-designer", reason: "the grid carries the page at every width" },
            locked: existing.lockedMockup,
            lockedBy: existing.lockedBy,
            lockedReason: existing.lockedReason,
            lockedAt: existing.lockedAt,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return;
    }
    writeDesignManifest(workspace, { ...existing, refs });
  }

  /**
   * A design segment that generates NOTHING and writes the manifest anyway.
   *
   * THE DEGRADED LANE'S OWN INSTRUCTION, followed. `design-prompt.ts` asks for
   * `"refs": []` plus a `directions` entry per written direction when no image
   * generation is available, so this is the shape a keyless run produces — and
   * the "bare" variant is the same file from a lane that named nothing.
   */
  #runEmptyRefsSegment(request: BuildRequest, shape: "canvass" | "bare"): void {
    const workspace = this.#options.workspace();
    const refsDir = join(workspace, "design-refs");
    mkdirSync(refsDir, { recursive: true });
    const slugs = ["editorial-slab", "quiet-grid", "warm-stack"];
    // STAGE B WRITES THE CHOSEN DIRECTION'S DOCUMENT AND LEAVES THE MANIFEST
    // ALONE: there are no stills to append, and the prompt says so in as many
    // words ("LEAVE THE MANIFEST'S `directions`, `chosenDirection` … EXACTLY AS
    // THEY ARE"). A fixture that rewrote it here would erase the host's choice.
    if (request.prompt.includes("STAGE B — EXPAND")) {
      writeFileSync(join(refsDir, "direction.md"), "DESIGN_VARIANCE: 3 (written, not drawn)\n", "utf8");
      return;
    }
    if (shape === "bare") writeFileSync(join(refsDir, "direction.md"), "DESIGN_VARIANCE: 3\n", "utf8");
    else {
      for (const slug of slugs) {
        writeFileSync(join(refsDir, `direction-${slug}.md`), `DESIGN_VARIANCE: 3 (${slug})\n`, "utf8");
      }
    }
    // `writeManifest: false` REACHES THIS SEGMENT TOO, and it did not until
    // 2026-08-03. A degraded canvass that wrote its `direction-<slug>.md`
    // documents and no manifest is the one shape that makes `#buildPhase`'s
    // post-segment arms ALL miss — every one of them requires a manifest — and it
    // could not be built here, so the hole could not be measured.
    if (!this.#options.writeManifest) return;
    writeDesignManifest(workspace, {
      version: 1,
      refs: [],
      directions:
        shape === "bare"
          ? []
          : slugs.map((slug) => ({
              slug,
              name: slug,
              distinction: `what ${slug} does that the others do not`,
              notes: join(refsDir, `direction-${slug}.md`),
            })),
      chosenDirection: null,
      directionChoice: null,
      lockedMockup: null,
      lockedBy: null,
      lockedReason: null,
      lockedAt: null,
    });
  }

  #runDesignSegment(request: BuildRequest): void {
    const workspace = this.#options.workspace();
    const refsDir = join(workspace, "design-refs");
    mkdirSync(refsDir, { recursive: true });
    const refs = [];
    for (let n = 0; n < this.#options.pngCount; n += 1) {
      const path = join(refsDir, `0${String(n + 1)}-section.png`);
      // A REAL PNG SIGNATURE, because `countDesignPngs` counts content and no
      // longer counts the suffix. `"not really a png"` here used to make the
      // orchestrator's design arms pass over files that were not images — the
      // fixture agreed with the defect. The trailing byte keeps the files
      // distinguishable without making them decodable, which nothing reads.
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]));
      refs.push({
        path,
        section: `section-${String(n + 1)}`,
        aspect: "16:9" as const,
        intent: "x",
        direction: null,
        origin: null,
        ...(this.#options.animateRefs ? { animate: true } : {}),
      });
      // The tool events the image-call counter reads, IN THE DRIVER'S OWN SHAPE.
      // `summariseToolInput` (claude-common.ts:291) walks `file_path, path,
      // command, …` and returns `"<key>: <value>"` truncated to 160 chars, so a
      // Bash call arrives as `command: <the command line>`. Inventing a tidier
      // string here would test a format nothing produces.
      request.sink.tool("Bash", `command: ${join(workspace, "..", "..", "..", GEMINI_STUB_NAME)} "a prompt" -a 16:9 -o ${path}`);
    }
    writeFileSync(join(refsDir, "direction.md"), "DESIGN_VARIANCE: 3\n", "utf8");
    if (!this.#options.writeManifest || refs.length === 0) return;
    writeDesignManifest(workspace, {
      version: 1,
      refs,
      directions: [],
      chosenDirection: null,
      directionChoice: null,
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

/**
 * A `gemini-video.sh` that spends nothing, at the ONE path `videoCapability`
 * looks in: `<home>/.claude/scripts/`.
 *
 * IT IS A FAKE THAT STILL PROVES THINGS. It does `mktemp -d` first, exactly as
 * the real script does, so a TMPDIR that is merely NAMED and not created kills
 * it at exit 9 rather than passing quietly. It derives the poster from `-o` the
 * way the real script does (`${OUT%.*}-poster.webp`), so the path
 * `planVideoLegs` advertised in the prompt is the path something actually wrote.
 * And it records whether GEMINI_API_KEY arrived — by PRESENCE, never by value.
 */
function writeVideoStub(home: string): void {
  const dir = join(home, ".claude", "scripts");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "gemini-video.sh");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      "    -i|-a|-d|-r|-m) shift 2 ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      "# THE REAL SCRIPT'S FIRST ACT, IN ITS EXACT FORM (gemini-video.sh:133).",
      "# The explicit template is not stylistic: MEASURED on Darwin 25.6, a bare",
      "# `mktemp -d` IGNORES TMPDIR and lands in /var/folders/.../T — so a stub",
      "# using the bare form would pass against a TMPDIR the script never honoured",
      "# and prove nothing about the sandbox. It also fails outright when the",
      "# directory does not exist, which is the half a string assertion cannot see.",
      'work="$(mktemp -d "${TMPDIR:-/tmp}/gemini-video-stub.XXXXXXXX")" || exit 9',
      'mkdir -p "$(dirname "$out")"',
      "printf 'not really an mp4' > \"$out\"",
      "printf 'not really a webp' > \"${out%.*}-poster.webp\"",
      "key=absent",
      'if [ -n "${GEMINI_API_KEY:-}" ]; then key=present; fi',
      "printf 'out=%s tmpdir=%s work=%s key=%s\\n' \\",
      '  "$out" "${TMPDIR:-unset}" "$work" "$key" >> "$VIDEO_STUB_LOG"',
      'rmdir "$work"',
      "exit 0",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

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
  /** One line per `gemini-video.sh` invocation the stub saw. See `writeVideoStub`. */
  videoStubLog(): readonly string[];
  /**
   * THE REAL ROUTER OVER THIS REAL ORCHESTRATOR, which is the only shape that can
   * answer "does a click lock the run".
   *
   * `api.test.ts` cannot: its `resume` is a fixture whose rule is "is this one of
   * the run's screenshot rows", and a published mockup path IS one — so that
   * harness answers 200 to the exact request production refuses. The two halves of
   * this feature (a wire value, and a manifest that only accepts refs) live on
   * opposite sides of that stub, so they are joined here instead.
   */
  serve(): Promise<{ readonly base: string; close(): Promise<void> }>;
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
  animateRefs?: boolean;
  videoScript?: boolean;
  segmentTokens?: readonly number[];
  env?: NodeJS.ProcessEnv;
  onRequest?: (request: BuildRequest) => void;
  /** Drive the 2026-08-03 two-stage lane. Default false — see FakeBuilderOptions. */
  directions?: boolean;
  /** A design segment that draws nothing and writes the manifest — see FakeBuilderOptions. */
  emptyRefs?: "canvass" | "bare";
  /** A canvass that writes `chosenDirection` itself — see FakeBuilderOptions. */
  canvassChoice?: string;
  /** An EXPANSION whose manifest write loses the choice — see FakeBuilderOptions. */
  expandDrops?: "choice" | "directions";
  /** Which `build()` calls the provider refuses — see FakeBuilderOptions. */
  limitCalls?: readonly number[];
  limitRetryAfterSec?: number;
  /** Hand the harness back BEFORE the run starts. See the call site below. */
  autoStart?: boolean;
  /**
   * Runs INSIDE an ON-DEMAND generation, before its PNG exists.
   *
   * The real one is a minute of Gemini time, and everything the orchestrator does
   * to a parked run — the timer firing, the owner clicking a direction, a cancel —
   * can land in the middle of it. This is the only seam a test can put a write
   * THERE rather than before or after. Keyed on the `-req-` target because
   * `designPreflight` runs through this same injected runner.
   */
  duringRender?: () => void;
}): Promise<DesignHarness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-design-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const script = join(dir, GEMINI_STUB_NAME);
  writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  // THE VIDEO SCRIPT LIVES UNDER THE RUN'S OWN HOME, WHICH IS THE SAFETY
  // PROPERTY AND NOT A CONVENIENCE. `videoCapability` derives the script path
  // from `home`, and the orchestrator derives `home` from the run's env — so on
  // a machine where the REAL `~/.claude/scripts/gemini-video.sh` exists and a
  // key resolves, no test here can reach a metered Veo call. The stub below is
  // the only `gemini-video.sh` any of these runs can find.
  const videoLog = join(dir, "video-stub.log");
  if (options.videoScript === true) writeVideoStub(home);

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
    animateRefs: options.animateRefs ?? false,
    directions: options.directions ?? false,
    ...(options.emptyRefs === undefined ? {} : { emptyRefs: options.emptyRefs }),
    ...(options.canvassChoice === undefined ? {} : { canvassChoice: options.canvassChoice }),
    ...(options.expandDrops === undefined ? {} : { expandDrops: options.expandDrops }),
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    ...(options.limitCalls === undefined ? {} : { limitCalls: options.limitCalls }),
    ...(options.limitRetryAfterSec === undefined ? {} : { limitRetryAfterSec: options.limitRetryAfterSec }),
  });

  const env: NodeJS.ProcessEnv = {
    // The run's own HOME, so `geminiKeyAvailable` never reads the owner's real
    // ~/.gemini/api_key and a test's verdict never depends on whose machine it
    // runs on. No PATH, so the sealed gate cannot find docker and stops on
    // `infra` at attempt 1 rather than scoring a container for ten minutes.
    HOME: home,
    DASHBOARD_GEMINI_IMAGE_SCRIPT: script,
    // Where the video stub records what it was handed. It reaches the stub
    // because `videoLaneEnv` is a SUBTRACTION of metered credentials, never an
    // allowlist — the same property that keeps GEMINI_API_KEY on the way in.
    VIDEO_STUB_LOG: videoLog,
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
    // THE INJECTED IMAGE RUNNER, AND IT WRITES THE FILE. The real preflight
    // spawns `npx impeccable`, which reaches a registry — a sequencing test that
    // pays for that learns nothing about sequencing. But `#renderOnDemand` runs
    // through this same seam and checks the output EXISTS, so a runner that only
    // returns 0 could exercise nothing but the failure arm.
    designRun: async (_command: string, args: readonly string[]) => {
      const out = args.indexOf("-o");
      const target = out < 0 ? null : args[out + 1];
      // ON-DEMAND ONLY. `designPreflight` runs through this same runner at the top
      // of the build phase, long before the run parks, so an unconditional hook
      // would fire against a run that has no manifest yet.
      if (target !== undefined && target !== null && target.includes("-req-")) options.duringRender?.();
      if (target !== undefined && target !== null) {
        writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
      }
      return { code: 0, stderr: "" };
    },
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
    videoStubLog: () =>
      existsSync(videoLog)
        ? readFileSync(videoLog, "utf8")
            .split("\n")
            .filter((line) => line !== "")
        : [],
    settle: (timeoutMs = 30_000) => waitUntil(settled, timeoutMs, "the run never settled"),
    waitFor: waitUntil,
    serve: async () => {
      // THE SAME `orchestrator` THIS HARNESS BUILT, handed to the real router as
      // its `RunController`. Nothing here is stubbed: `POST /resume` reaches
      // `Orchestrator.resume` -> `#applyDesignLock` -> `lockManifest`.
      const server = createDashboardServer({ store, bus, orchestrator, catalog, auth, paths });
      await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
      const port = (server.address() as AddressInfo).port;
      return {
        base: `http://${LOOPBACK_HOST}:${String(port)}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    },
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

  /*
   * `autoStart: false` HANDS THE RUN BACK BEFORE IT STARTS, and it exists for one
   * state this harness otherwise cannot express: `rate_limited`.
   *
   * `settle()` waits for a TERMINAL status or `awaiting_input`, and a run parked
   * on the provider's window is neither — so a refusal test driven through the
   * default path either raced the continuation (the park is over before the
   * caller gets its handle) or hung for the full timeout when the continuation
   * was correctly refused. Both are the harness measuring itself. With this
   * false, the caller pumps and watches.
   */
  if (options.autoStart !== false) {
    orchestrator.pump();
    await harness.settle();
  }
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

/* -------------------------------------------------------------------------
 * THE DESIGN LOCK, END TO END — the assertion this feature never had
 *
 * These three replace the two measurements that BLOCKED Phase 4 Task 6. That
 * block was real and both halves of it were true at once: `POST /api/runs`
 * discarded `designLock`, so `designLockPolicy` never returned `"ask"` in
 * production; and had it been wired alone, every real click would have been
 * refused, because the only mockup path a client can send is the PUBLISHED COPY
 * and `lockManifest` accepts only a workspace ref. Wiring the route by itself
 * would have replaced "never asks" with "asks and cannot be answered", which is
 * strictly worse — a 30-minute park ending in a `fallback` lock.
 *
 * BOTH SEAMS ARE NOW CLOSED, so the pair of tests that recorded the block is
 * replaced by the pair that measures the behaviour, plus the one nobody could
 * write before: a real click, over the real router, on the real orchestrator.
 * ---------------------------------------------------------------------- */

test("the published path and the ref are still DIFFERENT strings — the translation is why a click works", () => {
  // THE MEASUREMENT THAT BLOCKED TASK 6, KEPT VERBATIM, because it is the reason
  // `chosenMockupRef` has to exist and it stays true forever:
  //
  //   #recordDesignMockups publishes  join(results, "screenshots", runId, `design-${basename(ref.path)}`)
  //     (orchestrator.ts — `path: target` is what reaches addScreenshot, and
  //      http.ts's toDetail reports those same rows as designLock.mockups[].path)
  //   lockManifest accepts ONLY       manifest.refs.some((r) => r.path === attempt.path)
  //     (design-lock.ts, exact equality — deliberately not loosened)
  const shots = join("/somewhere", "results", "screenshots", "r1");
  const ref = join("/somewhere", "runs", "r1", "workspace", "design-refs", "01-hero.png");
  const published = publishedMockupPath(shots, ref);
  assert.notEqual(published, ref, "if these were ever equal, no translation would be needed");
  // AND IT IS NOT AN ARTEFACT OF THIS FIXTURE'S DIRECTORIES. The `design-`
  // prefix alone makes the basenames differ, so no choice of results root,
  // run id or ref path can make the two equal.
  assert.notEqual(basename(published), basename(ref), "the design- prefix alone is enough to refuse every ref");

  // WHAT CHANGED: the wire value now resolves to the ref, and only to the ref.
  const manifest: DesignManifest = {
    version: 1,
    refs: [{ path: ref, section: "hero", aspect: "21:9", intent: "opening", direction: null, origin: null }],
    directions: [],
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: null,
    lockedBy: null,
    lockedReason: null,
    lockedAt: null,
  };
  assert.equal(chosenMockupRef(manifest, shots, published), ref, "the click resolves to the path the gate reads");
  assert.equal(chosenMockupRef(manifest, shots, "/etc/passwd"), "/etc/passwd", "and nothing else is translated");
});

test("A REAL CLICK LOCKS THE RUN: the wire path, through the real router, ends the park", async () => {
  // THE ASSERTION NOBODY COULD MAKE BEFORE. Every layer here is the production
  // one: `createDashboardServer`'s route parses the body, the REAL
  // `Orchestrator.resume` translates and applies it, `lockManifest` decides, and
  // the chosen path is read back off `GET /api/runs/:id` — the same document the
  // browser's cards are built from.
  //
  // THE FORGED PATH IS SENT FIRST, ON PURPOSE. A 200 for the real click means
  // nothing on its own — a route that answered 200 to everything would pass it —
  // so the same server refuses a path it does not own, on the same parked run,
  // moments earlier. The two answers together are the measurement.
  const h = await designRun({ designLock: "ask" });
  const api = await h.serve();
  try {
    assert.equal(h.status(), "awaiting_input", "the run is parked, which is the only state a click applies to");

    const parked = (await (await fetch(`${api.base}/api/runs/${h.runId}`)).json()) as RunDetail;
    const cards = parked.designLock?.mockups ?? [];
    assert.equal(cards.length, 5, "the owner cannot click what the API does not list");
    const wirePath = cards[1]?.path ?? "";
    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    const ref = manifest?.refs[1]?.path ?? "";
    assert.ok(wirePath.length > 0 && ref.length > 0);
    assert.notEqual(wirePath, ref, "the wire carries the published copy, which is the whole difficulty");

    // AND THE CARD IS LOADABLE, which is the other half of publishing into the
    // directory `serveScreenshot` resolves. A mockup written anywhere else is a
    // card that shows the fallback text — clickable, but blank — so the one
    // derivation in `#mockupDir` is checked against the ROUTE, not against itself.
    const image = await fetch(`${api.base}/api/runs/${h.runId}/screenshots/${basename(wirePath)}`);
    assert.equal(image.status, 200, "the published copy must be servable by the route that serves it");
    assert.equal(image.headers.get("content-type"), "image/png");

    const post = async (chosenMockup: string): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${api.base}/api/runs/${h.runId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chosenMockup }),
      });
      return { status: response.status, body: await response.json() };
    };

    // (1) A path this run does not own — INCLUDING the near miss, which is the
    // case that says the translation is not a basename match: the right file
    // name, in a directory this run never published into.
    for (const forged of ["/etc/passwd", join(tmpdir(), `design-${basename(ref)}`)]) {
      const refused = await post(forged);
      assert.equal(refused.status, 409, `${forged} must not be lockable`);
      assert.equal((refused.body as ApiErrorResponse).error, "not_resumable");
      assert.match(String((refused.body as ApiErrorResponse).message), /is not one of its mockups/u);
      assert.equal(h.status(), "awaiting_input", "a refused choice leaves the run parked");
      assert.equal(h.lock()?.awaiting, true);
      assert.equal(h.builderCalls.length, 1, "and starts no build segment behind the refusal");
    }

    // (2) THE OWNER'S CLICK, byte-for-byte what `design-lock.tsx` sends.
    const accepted = await post(wirePath);
    assert.equal(accepted.status, 200, "the published path a card carries must lock the run");
    assert.deepEqual(accepted.body, { ok: true });

    await h.settle();
    assert.notEqual(h.status(), "awaiting_input", "and the run LEAVES the park rather than waiting for the timeout");
    const park = h.lock();
    assert.equal(park?.awaiting, false);
    assert.equal(park?.locked, ref, "the lock is on the WORKSPACE ref: the path the build and the gate read");
    assert.equal(park?.lockedBy, "owner", "not `fallback` — a click is not a timeout");
    assert.equal(
      readDesignManifest(runPathsFor(h.paths, h.runId).workspace)?.lockedMockup,
      ref,
      "and the manifest the build agents read carries it too",
    );
    assert.equal(h.builderCalls.length, 2, "the build segment ran: two build() calls, not one and not three");

    // The card the browser will ring, resolved the way `lockedMockup()` does it.
    const after = (await (await fetch(`${api.base}/api/runs/${h.runId}`)).json()) as RunDetail;
    assert.equal(after.designLock?.locked, ref);
    assert.equal(after.designLock?.lockedBy, "owner");
  } finally {
    await api.close();
    await h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * PHASE 4 TASK 7 — the GATE/FIX loop's outcome reaches the run record.
 *
 * `api-types.ts` named the missing statement outright: until `#gateFixLoop` calls
 * `store.updateRun(runId, {gateAttempts, gateStopReason})`, every run reports
 * `0` / `null` forever — and an unattended run whose stop reason nobody can see
 * is §12's "automated disappointment" with the disappointment hidden.
 *
 * THE ARM MEASURED HERE IS `infra`, AND THAT IS THE ONE THIS HARNESS CAN REACH.
 * `designRun` gives the orchestrator an env with no `PATH`, so the sealed gate
 * cannot find docker, `report.infraFailure` is non-null and the loop stops at
 * attempt 1 before the green and cap branches. Reaching `green` / `retry-cap` /
 * `not-converging` needs a gate that returns real `ContainerResult`s across
 * attempts, and `#gatePhase` builds its gate from `createGate()` with no
 * injection seam — so those arms would need either Docker or a new seam in
 * orchestrator.ts, which is under concurrent edit. Stated rather than faked.
 * ---------------------------------------------------------------------- */

test("the run record carries the loop's attempts AND its stop reason, together", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    const row = h.store.getRun(h.runId);
    assert.equal(row?.gateAttempts, 1, "one gate run happened and the row says so");
    assert.equal(row?.gateStopReason, "infra", "NOT null, and not `green`: the scorer could not run");
  } finally {
    await h.cleanup();
  }
});

test("THE PAIR MOVES TOGETHER — an attempt count of 0 next to a reason is a false pair", async () => {
  // db.ts says these two move together or not at all. "not-converging after 0
  // attempts" is a sentence about nothing, and `gateAttempts: 0` beside a reason
  // is the same conflation `heldOutPass: null` exists to refuse. Written as one
  // equivalence so BOTH half-patches are red: attempts without a reason, and a
  // reason without attempts.
  const h = await designRun({ designLock: "auto" });
  try {
    const row = h.store.getRun(h.runId);
    assert.equal(
      (row?.gateAttempts ?? 0) > 0,
      row?.gateStopReason !== null,
      "a run has either both halves of a loop outcome or neither",
    );
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

/* ---------------------------------------------------------------------------
 * THE IMAGE→VIDEO LANE, DRIVEN BY THE RUN (spec §7.6).
 *
 * `video-lane.test.ts` drives `runVideoLane` directly and can never say whether
 * `#buildPhase` still calls it, whether the manifest it is handed is the shape
 * the DESIGN lane writes, or whether the node its graph events name is one the
 * canvas knows. Those are this file's questions, and the whole point is that a
 * unit test cannot ask them (instances 2, 3, 6, 7, 11).
 *
 * NO METERED CALL IS POSSIBLE HERE. The capability resolves from the run's own
 * `HOME`, which `designRun` points at a temp directory; the only
 * `gemini-video.sh` reachable is `writeVideoStub`'s. That is a structural
 * guarantee, not a convention — see the comment in `#buildPhase`.
 * ------------------------------------------------------------------------- */

test("THE VIDEO LANE RUNS INSIDE THE BUILD PHASE, and its pill lands on a node the canvas knows", async () => {
  const h = await designRun({ designLock: "auto", animateRefs: true, videoScript: true });
  try {
    // 1. IT SPENT, AND IT SPENT THE CAP. Five animate refs, two invocations —
    //    counted from the SCRIPT's own log, not from the plan we handed it.
    const log = h.videoStubLog();
    assert.equal(log.length, 2, "spec §7.6.3.2: at most 2 legs per run, counted at the script");
    assert.match(String(log[0]), /leg-1\.mp4/u);
    assert.match(String(log[1]), /leg-2\.mp4/u);

    // 2. TMPDIR WAS INSIDE THE WORKSPACE AND EXISTED. The stub's first act is
    //    `mktemp -d`, which exits 9 against a directory that was only named.
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    assert.match(String(log[0]), new RegExp(`tmpdir=${workspace}/\\.tmp\\b`, "u"));
    assert.match(String(log[0]), new RegExp(`work=${workspace}/\\.tmp/`, "u"));
    assert.match(String(log[0]), /key=present/u, "GEMINI_API_KEY is NOT stripped — spec §7.5");

    // 3. THE RECORD. costUsd null, spend in units, and the cap's source.
    const record = JSON.parse(readFileSync(runPathsFor(h.paths, h.runId).videoRecord, "utf8")) as {
      costUsd: unknown;
      legsProduced: number;
      meteredSeconds: number;
      capSource: string;
    };
    assert.equal(record.costUsd, null, "no price exists to record, so none is invented");
    assert.equal(record.legsProduced, 2);
    assert.equal(record.meteredSeconds, 8, "2 legs x 4 s — UNITS, which are real");
    assert.equal(record.capSource, "default");

    // 4. THE CANVAS. Not "an event was emitted" — the folded state, through the
    //    real reducer, which DROPS a graph_tool naming a node it does not know.
    const folded = foldGraphAll(h.emittedGraph());
    const withVideo = folded.nodes.filter((n) => n.tools.some((p) => p.name === "gemini-video.sh"));
    assert.equal(withVideo.length, 1, "the pill survived the fold");
    assert.equal(withVideo[0]?.tools.find((p) => p.name === "gemini-video.sh")?.count, 2);
    assert.equal(withVideo[0]?.parent, null, "and it hangs on the run's own root, not on an invented node");

    // 5. THE PROMPT THE BUILD AGENT ACTUALLY RECEIVED carries §7.6.4's pattern
    //    and the ABSOLUTE paths — which is what makes the fetch happen (§7.3).
    const buildPrompt = String(h.builderCalls[1]?.prompt);
    assert.match(buildPrompt, /scrub, do not play/iu);
    assert.match(buildPrompt, new RegExp(`${workspace}/assets/world/leg-1\\.mp4`, "u"));
    assert.match(buildPrompt, /leg-1-poster\.webp/u);
    assert.match(buildPrompt, /AUDIO IS GENERATED AND IGNORED/u);
    assert.ok(!buildPrompt.includes("not-a-real-key-fixture"), "and no key in the prompt");

    // 6. THE POSTER THE PROMPT ADVERTISES IS ON DISK. Two derivations of one
    //    path — planVideoLegs computed it for the prompt, the script computed
    //    `${OUT%.*}-poster.webp` and was never told the first.
    assert.equal(existsSync(join(workspace, "assets", "world", "leg-1-poster.webp")), true);
    assert.equal(existsSync(join(workspace, "assets", "world", "leg-1.mp4")), true);
  } finally {
    await h.cleanup();
  }
});

test("NO SCRIPT UNDER THE RUN'S HOME MEANS NO LANE — the build prompt is byte-identical", async () => {
  // The negative control for all six assertions above, and the property that
  // makes every other test in this file safe on a machine that HAS the real
  // script: the capability is derived from the RUN's HOME, so an absent stub is
  // an absent capability, no spend, no record, and a prompt with no video in it.
  const h = await designRun({ designLock: "auto", animateRefs: true });
  try {
    assert.equal(h.videoStubLog().length, 0, "nothing was invoked");
    // A DEGRADED LANE IS STILL EXPLAINABLE. The record is written either way —
    // an absent one would be indistinguishable from a lane that never ran.
    const record = JSON.parse(readFileSync(runPathsFor(h.paths, h.runId).videoRecord, "utf8")) as {
      capability: { available: boolean; reason: string; scriptSha256: string | null };
      legsProduced: number;
    };
    assert.equal(record.capability.available, false);
    assert.equal(record.capability.scriptSha256, null, "no script, so nothing to hash");
    assert.match(record.capability.reason, /gemini-video\.sh/u, "and it names what was missing");
    assert.equal(record.legsProduced, 0);
    const folded = foldGraphAll(h.emittedGraph());
    assert.equal(
      folded.nodes.filter((n) => n.tools.some((p) => p.name === "gemini-video.sh")).length,
      0,
    );
    assert.ok(!String(h.builderCalls[1]?.prompt).includes("scrub, do not play"));
  } finally {
    await h.cleanup();
  }
});

test("A MANIFEST WITH NO `animate` SPENDS NOTHING, even with the script and the key present", async () => {
  // Phase 2b writes `animate`; until it does, every real manifest yields zero
  // legs. That is the correct degraded state and it must be observed rather
  // than assumed — the script is RIGHT THERE and the key resolves.
  const h = await designRun({ designLock: "auto", videoScript: true });
  try {
    assert.equal(h.videoStubLog().length, 0, "no animate section, no leg, no spend");
    const record = JSON.parse(readFileSync(runPathsFor(h.paths, h.runId).videoRecord, "utf8")) as {
      legsProduced: number;
      capability: { available: boolean };
    };
    assert.equal(record.capability.available, true, "the capability WAS there — this is not a null result");
    assert.equal(record.legsProduced, 0);
    assert.ok(!String(h.builderCalls[1]?.prompt).includes("scrub, do not play"));
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
  } finally {
    await h.cleanup();
  }
});

test("the motion bar is armed for the BUILD segment and NOT for the DESIGN one", async () => {
  // A DEPARTURE FROM THE PLAN, AND THIS IS WHAT WATCHES IT. `design-env.ts` hands
  // the flip to this task as a per-RUN decision from the lane mode. It is applied
  // per-SEGMENT instead, because `MOTION_BAR_ENV` registers Layer-2 Stop hooks —
  // a completion gate that holds a session open until the PAGE satisfies the
  // motion bar — and the DESIGN segment writes stills and prose, never markup.
  // Armed there it would hold the design lane open against a criterion it was
  // never going to meet, which is a block dressed as a quality gate.
  //
  // BOTH ARMS ON ONE RUN. An `ask` harness has a single build call and therefore
  // structurally cannot check the arm that must be PRESENT.
  const h = await designRun({ designLock: "auto" });
  try {
    assert.equal(h.builderCalls.length, 2);
    assert.equal(h.builderCalls[0]?.env[MOTION_BAR_ENV], undefined, "the design segment writes no markup");
    assert.equal(h.builderCalls[1]?.env[MOTION_BAR_ENV], "1", "and the build segment is held to the bar");
  } finally {
    await h.cleanup();
  }
});

test("an operator's inherited DASHBOARD_MOTION_BAR does NOT arm a completion gate on a CLI ticket", async () => {
  // design-env.ts REMOVES an inherited value rather than respecting it, and that
  // `delete` branch had no reader. Phase 2a measured always-on blocking a
  // legitimate build of this repo's own client, so a variable left in a shell
  // must not decide whether a cli run can ever finish.
  const h = await designRun({
    ticket: "a cli that renames files in place",
    designLock: "auto",
    env: { [MOTION_BAR_ENV]: "1" },
  });
  try {
    assert.equal(h.builderCalls.length, 1);
    assert.equal(h.builderCalls[0]?.env[MOTION_BAR_ENV], undefined, "no design lane, no motion bar");
  } finally {
    await h.cleanup();
  }
});

test("resume only applies a lock to a run that is PARKED for one", async () => {
  // `reconcileOnBoot` sets `awaiting_input` for ANY run whose builder died with
  // the server — including one interrupted halfway through the DESIGN segment,
  // which has a manifest and no lock. The plan gated the lock branch on that
  // status alone; locking a half-finished manifest would skip the rest of the
  // lane and record it as the owner's choice. The gate is the park RECORD, which
  // `#parkForDesignLock` writes and nothing else does.
  const h = await designRun({ designLock: "auto" });
  try {
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    const results = runPathsFor(h.paths, h.runId).results;
    // Rebuild the mid-design-segment state: a manifest with refs and no lock,
    // `awaiting_input`, and NO park record.
    const manifest = readDesignManifest(workspace);
    assert.ok(manifest !== null && manifest.refs.length > 0);
    writeDesignManifest(workspace, { ...manifest, lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null });
    rmSync(join(results, "design-lock.json"), { force: true });
    h.store.updateRun(h.runId, { status: "awaiting_input", endedAt: null, heldOutPass: null });
    await h.orchestrator.shutdown();

    h.orchestrator.resume(h.runId, manifest.refs[0]?.path ?? "");
    assert.equal(
      readDesignManifest(workspace)?.lockedMockup,
      null,
      "an interrupted design segment was locked as though the owner had chosen",
    );
  } finally {
    await h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE JUDGE'S EVIDENCE BUNDLE — the held-out boundary, one door down
 *
 * `gate-report.ts` exists so that a fixing agent never learns the held-out
 * suite by name. `renderEvidence` was handing the SAME bytes to the judge:
 * `container.tier0` printed every gate's `detail` verbatim, and
 * `GATE:suite-green`'s detail is assembled in `bakeoff/src/scorer-container.ts`
 * out of the held-out runner's output tail and the `titlePath` of each excused
 * failure; `container.criterionCoverage` printed every coverage `detail`, which
 * is the assertion message that produced it.
 *
 * WHAT THIS TEST CAN AND CANNOT SEE, stated because the difference is the
 * defect this repo keeps shipping. `judge.ts:renderInputs` is not exported, so
 * this asserts on `renderEvidence` — the value `#judgePhase` passes as
 * `evidence:` — and NOT on the assembled prompt. The other three inputs to that
 * prompt were checked BY READING `judge.ts:renderInputs` and named here so the
 * reading is auditable rather than implied:
 *   - `request.ticket.brief`  — the owner's own text. Never touches a container.
 *   - `request.criteria`      — id, tier and statement of each VISIBLE criterion.
 *                               Authored by the spec seat before any build; the
 *                               verdict page renders the same strings.
 *   - `request.diff`          — `workspaceDiff` over the BUILDER's workspace.
 *                               The frozen suite is mounted into the sealed
 *                               container, never into that tree.
 * `evidence` is therefore the only container-derived string in the prompt, and
 * it is the one asserted below.
 * ---------------------------------------------------------------------- */

/** A title that could only have come from the held-out suite. */
const HELD_OUT_TITLE = "T-7 the contact form confirms on submit › REQ-004";

/** A container that carries that title in every field the old renderer read. */
function leakyContainer(): ContainerResult {
  return containerFixture({
    tier0: [
      tier0Fixture({
        id: "GATE:suite-green",
        name: "acceptance suite is green",
        outcome: "fail",
        detail: `2 test(s) failed. ${HELD_OUT_TITLE} — expected 1 confirmation, got 0`,
      }),
      // A gate that PASSED, whose detail also quotes the runner. `toAgentVisible`
      // reports only fail/unknown, so this one must render outcome-only.
      tier0Fixture({
        id: "GATE:suite-intact",
        name: "frozen suite intact",
        outcome: "pass",
        detail: `all 9 frozen files match, including ${HELD_OUT_TITLE}`,
      }),
      // ALLOWLISTED. Its detail is the artefact's own compiler talking, and it
      // must still cross — a redactor that withheld everything would pass this
      // test while making the judge useless.
      tier0Fixture({
        id: "GATE:build",
        name: "build succeeds",
        outcome: "fail",
        detail: "src/app.ts(12,3): error TS2345: Argument of type 'string'",
        command: "npm run build",
        exitCode: 2,
      }),
    ],
    criterionCoverage: [
      coverageFixture({
        criterionId: "REQ-004",
        outcome: "failed",
        testRefs: [HELD_OUT_TITLE],
        detail: `${HELD_OUT_TITLE}: expected the confirmation to be visible`,
      }),
    ],
  });
}

test("NO HELD-OUT TEST TITLE REACHES THE JUDGE — not via a gate detail, not via coverage", () => {
  const evidence = renderEvidence(leakyContainer());
  assert.ok(
    !evidence.includes(HELD_OUT_TITLE),
    `the held-out suite's identities reached the judge prompt:\n${evidence}`,
  );
  assert.ok(!evidence.includes("T-7"), "the bare test id is an identity too");
});

test("and the redaction is not a blanket one — the compiler's own error still crosses", () => {
  // THE OTHER HALF OF THE CONTROL. Withholding every detail would satisfy the
  // test above and leave the judge reading a list of enum values. The
  // allowlisted gates are the ones whose detail is the ARTEFACT's toolchain
  // talking about the artefact, and they must survive.
  const evidence = renderEvidence(leakyContainer());
  assert.match(evidence, /error TS2345/, "GATE:build is allowlisted and its detail must cross");
  assert.match(evidence, /GATE:suite-green: fail/, "which gate failed is not held out; what it SAID is");
  assert.match(evidence, /GATE:suite-intact: pass/, "a passing gate still has to appear");
  assert.match(evidence, /REQ-004: failed/, "criterion ids are already in the prompt's criteria block");
  assert.doesNotMatch(evidence, /GATE:suite-intact: pass —/, "a passing gate's detail must not render");
});

test("evidence never reads as an all-clear when the SCORER was the thing that broke", () => {
  // `toAgentVisible` returns an EMPTY failure list on an infrastructure error,
  // so a renderer that only printed failures would emit a clean-looking page for
  // a run where no browser ever launched.
  const evidence = renderEvidence(
    containerFixture({
      infrastructureErrors: ["chromium failed to launch: missing shared library"],
      tier0: [tier0Fixture({ id: "GATE:boot", outcome: "unknown", detail: "never ran" })],
    }),
  );
  assert.match(evidence, /scorer infrastructure/i);
  assert.match(evidence, /chromium failed to launch/);
});

/* -------------------------------------------------------------------------
 * ATTEMPT ARCHIVES ACROSS A RESUME
 *
 * `gate-attempts.ts` exists so attempt 2 does not clobber attempt 1's
 * `result.json`. `runGateFixLoop` numbers its attempts from 1 on EVERY entry,
 * and a resume is another entry — so the same history loss the archive prevents
 * inside one loop happened across two, one level up. A resumed run's first gate
 * attempt landed on `attempt-1/result.json` and the pre-resume round was gone.
 *
 * WHAT THIS TEST DRIVES, AND IT IS THE PRODUCTION PATH. A real `Orchestrator`
 * runs with no PATH, so `createGate` cannot find docker and `#gatePhase` takes
 * its catch arm — which still calls `#archiveAttempt(runId, slot)`, the line
 * under test. The pre-resume history is PLANTED as `attempt-1/` before the run
 * starts, which is exactly the state a resumed run finds on disk; driving a real
 * restart would add a process boundary and measure nothing extra.
 * ---------------------------------------------------------------------- */

const PRE_RESUME_MARK = "2020-01-01T00:00:00.000Z";
const THIS_ATTEMPT_MARK = "2026-07-29T12:00:00.000Z";

test("a resumed run archives BESIDE the earlier attempts, never on top of them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-slot-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new FakeCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const runId = "run-slot";
  const builder = new FakeBuilder({
    workspace: () => runPathsFor(paths, runId).workspace,
    pngCount: 0,
    segmentTokens: [],
    writeManifest: false,
    animateRefs: false,
  });
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview,
    // No PATH: the sealed gate cannot find docker and stops on infra at attempt
    // 1, having archived whatever the scorer left behind.
    env: { HOME: home },
    makeBuilder: () => builder,
    designRun: async () => ({ code: 0, stderr: "" }),
    designCanWrite: () => true,
  });

  const ticketText = "Build a portfolio site. No design lane.";
  freezeFor(ticketText, paths.acceptance);
  store.createRun({
    runId,
    ticketId: "seeded-at-create",
    ticketTitle: "Portfolio",
    ticketText,
    ticketSha256: "c".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    designLock: null,
    interactive: false,
  });

  try {
    // The state a resumed run finds: one round already archived, and a live
    // `result.json` the scorer wrote for THIS round.
    const earlier = attemptPath(paths, runId, 1);
    mkdirSync(dirname(earlier), { recursive: true });
    writeFileSync(earlier, JSON.stringify(containerFixture({ startedAt: PRE_RESUME_MARK })), "utf8");
    const live = liveResultPath(paths, runId);
    mkdirSync(dirname(live), { recursive: true });
    writeFileSync(live, JSON.stringify(containerFixture({ startedAt: THIS_ATTEMPT_MARK })), "utf8");

    orchestrator.pump();
    for (const deadline = Date.now() + 30_000; ; ) {
      const row = store.getRun(runId);
      if (row !== null && (isTerminal(row.status) || row.status === "awaiting_input")) break;
      if (Date.now() > deadline) throw new Error(`the run never settled (${store.getRun(runId)?.status ?? "gone"})`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(
      readAttempt(paths, runId, 1)?.startedAt,
      PRE_RESUME_MARK,
      "the resumed run overwrote the earlier round's result.json — the exact history loss the archive exists to prevent",
    );
    assert.equal(
      readAttempt(paths, runId, 2)?.startedAt,
      THIS_ATTEMPT_MARK,
      "this round was not archived beside the earlier one",
    );
  } finally {
    await orchestrator.shutdown();
    store.close();
    removeDesignTree(dir);
  }
});

test("the archive slot and the READ slot move together, or attempt 3 reports attempt 1's numbers", () => {
  // `#archiveAttempt` and `#readContainerResult` take the same `slot`. Offsetting
  // one and not the other is the failure `#readContainerResult`'s own docblock
  // warns about, and it would be silent: every file is present and the numbers
  // are simply the wrong round's. This pins the shared offset itself.
  const dir = mkdtempSync(join(tmpdir(), "dash-slotbase-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  try {
    assert.equal(highestArchivedAttempt(paths, "never-gated"), 0, "no directory is not attempt 1");
    const root = dirname(attemptPath(paths, "r", 1));
    mkdirSync(root, { recursive: true });
    mkdirSync(dirname(attemptPath(paths, "r", 2)), { recursive: true });
    mkdirSync(dirname(attemptPath(paths, "r", 10)), { recursive: true });
    // A name that does not parse must be SKIPPED, not read as zero: counting it
    // as 0 would put the next slot back on top of attempt-1.
    mkdirSync(join(dirname(root), "attempt-x"), { recursive: true });
    assert.equal(highestArchivedAttempt(paths, "r"), 10, "10 sorts after 2 numerically, not lexically");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * THE RECORDED NETWORK POLICY — a field that asserted a boundary nobody had
 * configured.
 *
 * `run.json` carried `heldConstants.sandbox.networkPolicy.egress: "denied"`
 * until 2026-07-30. Disproved by EXECUTION: in the 2026-07-29 live run six
 * `gemini-image.sh` calls from inside the sandboxed build reached
 * `generativelanguage.googleapis.com` and returned image bytes.
 *
 * THESE TESTS READ THE BUILDER'S OWN OBJECT, not this file's idea of it, which
 * is the only version that can go red for the right reason. `claude-builder.ts`
 * builds `Options.sandbox` in `buildOptions`, so a future `sandbox.network`
 * clause fails the first assertion below and forces the record to follow rather
 * than leaving it behind. A test that asserted `egress !== "denied"` against the
 * literal in orchestrator.ts would pass forever and measure nothing.
 * ---------------------------------------------------------------------- */

/** The minimum BuildRequest `buildOptions` needs. No build is started. */
function egressProbeRequest(): BuildRequest {
  return {
    runId: "egress-probe",
    prompt: "build it",
    workspace: join(tmpdir(), "egress-probe-ws"),
    sealedRoots: [join(tmpdir(), "egress-probe-sealed")],
    allowedAgents: [],
    modelId: "claude-opus-5",
    effort: null,
    resumeSessionId: null,
    signal: new AbortController().signal,
    sink: {
      log() {},
      tool() {},
      tokens() {},
      rateLimit() {},
      session() {},
      environment() {},
      graph() {},
      contextUsage() {},
      compaction() {},
      raw() {},
    },
    env: {},
  };
}

test("the builder configures NO egress restriction, and the run record says so", () => {
  const sandbox = buildOptions(egressProbeRequest(), false).sandbox;

  // 1. THE MECHANISM, from the object the SDK is handed. The filesystem clause is
  //    asserted alongside it so "no network clause" cannot be read as "no sandbox
  //    at all" — the sandbox is on, and it restricts writes and not hosts.
  assert.equal(sandbox?.enabled, true);
  assert.ok(sandbox?.filesystem, "the sandbox restricts the filesystem");
  assert.equal(sandbox?.network, undefined, "the builder now configures egress; the run record must be updated to match");

  // 2. THE RECORD, DERIVED FROM (1). Not a copy of the constant: the same
  //    function applied to the builder's real sandbox must produce what the
  //    record holds, so the two cannot drift apart silently.
  assert.deepEqual(DASHBOARD_SANDBOX.networkPolicy, recordedNetworkPolicy(sandbox?.network));

  // 3. WHAT IT MAY NOT SAY. `"denied"` is a MEASURED property in this project —
  //    bakeoff earns it with `--network none` plus a probe that must fail — and
  //    nothing here measured anything.
  const egress = String(DASHBOARD_SANDBOX.networkPolicy.egress);
  assert.notEqual(egress, "denied", "the record claims a denial the builder does not configure");
  assert.notEqual(egress, "pinned-mirror-only", "no mirror is configured either");
  //    The value must not read as a denial to a careless reader either. It is
  //    allowed to CONTAIN the disclaimer ("NOT a measured denial"); what it may
  //    not contain is the bare claim.
  assert.doesNotMatch(egress, /\bdenied\b/i, "a reader must not be able to read this as a denial");
  assert.doesNotMatch(egress, /\bsealed\b/i);
  assert.match(egress, /^unrestricted/i, "it must say what is true, first");
  // An empty allow-list next to an egress field reads as "no hosts permitted",
  // which is the same false denial by another route.
  assert.ok(DASHBOARD_SANDBOX.networkPolicy.allowedHosts.length > 0);

  // The two sibling fields still say plainly that they are not a container's.
  assert.match(DASHBOARD_SANDBOX.imageDigest, /not-a-container-digest/);
  assert.match(DASHBOARD_SANDBOX.imageRef, /runs on the host/);
});

test("recordedNetworkPolicy reports a configured restriction WITHOUT promoting it to a denial", () => {
  // The negative control for the test above: a function that always returned the
  // unrestricted label would pass every assertion there while being blind to its
  // input. This is the branch a builder with a network clause would take.
  const configured = recordedNetworkPolicy({ allowedDomains: ["registry.npmjs.org"], strictAllowlist: true });
  assert.notDeepEqual(configured, DASHBOARD_SANDBOX.networkPolicy, "the input is not being read");
  assert.deepEqual([...configured.allowedHosts], ["registry.npmjs.org"]);
  const egress = String(configured.egress);
  assert.match(egress, /unmeasured/, "a configured restriction is still not a measured one");
  assert.notEqual(egress, "denied");
  assert.doesNotMatch(egress, /denied|denial/i);

  // AN EMPTY CLAUSE IS NOT A RESTRICTION. `sandbox.network = {}` configures no
  // allow-list, no deny-list and no strict mode, so it must report exactly what
  // no clause at all reports. Calling it "configured" would be the same
  // overstatement one level down.
  assert.deepEqual(recordedNetworkPolicy({}), recordedNetworkPolicy(undefined));
  assert.deepEqual(recordedNetworkPolicy({ allowedDomains: [] }), recordedNetworkPolicy(undefined));
  // A strict allow-list with nothing on it restricts everything, and is still not
  // a MEASURED denial — nobody probed it.
  assert.match(String(recordedNetworkPolicy({ strictAllowlist: true }).egress), /unmeasured/);
  assert.match(String(recordedNetworkPolicy({ deniedDomains: ["*"] }).egress), /unmeasured/);
  assert.doesNotMatch(String(recordedNetworkPolicy({ deniedDomains: ["*"] }).egress), /\bdenied\b/i);
});

/* -------------------------------------------------------------------------
 * `run.json` — the artefact nobody was asserting on
 *
 * FOUND BY AN INDEPENDENT VERIFICATION PASS, 2026-07-30, and it is the one fix in
 * that wave that turned out to be decoration. `recordedNetworkPolicy` and
 * `DASHBOARD_SANDBOX` are both well pinned, and the WRITE SITE was not: mutating
 * `#runRecord`'s `sandbox:` back to a literal `{egress: "denied", allowedHosts: []}`
 * left the whole suite GREEN at 850/848/0. The verifier measured that the site
 * executes 23 times per suite run and writes the live value to disk each time — so
 * the record was being produced under test, with the false value in it, and
 * nothing looked.
 *
 * The gap covered the ENTIRE `heldConstants` block, not just the network policy:
 * `harness`, `imageRef`, `imageDigest`, `acceptanceSuiteSha256` and
 * `tokenAccountingRule` were equally unasserted.
 *
 * WHY THIS TEST READS THE FILE rather than calling a helper. Extracting the
 * assembly into an exported function and testing that would move the hole one
 * line — instance 6 of this repo's signature defect, where a fix was reverted at
 * its sole production call site and the suite stayed byte-identical because every
 * assertion lived where the function was called directly. `run.json` on disk is
 * what a later reader, `score-run.ts`, and any audit actually consume, so that is
 * what gets asserted.
 * ---------------------------------------------------------------------- */

test("run.json cannot claim an egress denial the builder does not configure", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    const recordPath = join(runPathsFor(h.paths, h.runId).results, "run.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      heldConstants: { sandbox: { networkPolicy: { egress: string; allowedHosts: string[] } } };
    };
    const policy = record.heldConstants.sandbox.networkPolicy;

    // The builder sets no `sandbox.network` — asserted separately by the
    // `buildOptions` test — so the only honest recorded value is the unrestricted
    // one. `deepEqual` against the function rather than against a literal, so the
    // label can be reworded in one place without this going stale.
    assert.deepEqual(
      policy,
      recordedNetworkPolicy(undefined),
      "the written record disagrees with what the builder actually configures",
    );

    // Belt as well as braces, and NOT redundant: the deepEqual above would also
    // pass if `recordedNetworkPolicy` itself started returning a denial. This
    // clause is about the WORD, and it is the one an auditor greps for.
    assert.doesNotMatch(
      policy.egress,
      /^denied$/,
      "run.json claims a measured egress denial; six live Gemini calls from inside " +
        "the sandboxed build disproved that on 2026-07-29",
    );
  } finally {
    await h.cleanup();
  }
});

test("run.json's held constants are all present, so none can quietly go missing", async () => {
  // The network policy above is one field of a block that was wholly unasserted.
  // A record whose `acceptanceSuiteSha256` or `tokenAccountingRule` vanished would
  // have been just as invisible, and both are load-bearing for comparing scores.
  const h = await designRun({ designLock: "auto" });
  try {
    const record = JSON.parse(
      readFileSync(join(runPathsFor(h.paths, h.runId).results, "run.json"), "utf8"),
    ) as { heldConstants: Record<string, unknown> };
    const hc = record.heldConstants;
    for (const field of [
      "harness",
      "sandbox",
      "repeatCount",
      "acceptanceSuiteSha256",
      "tokenAccountingRule",
    ]) {
      assert.ok(hc[field] !== undefined, `heldConstants.${field} is missing from run.json`);
    }
    assert.equal(
      hc["acceptanceSuiteSha256"],
      h.store.getRun(h.runId)?.suiteSha256,
      "the record's suite digest must be the one the run actually froze",
    );
  } finally {
    await h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * The score records are denied to the builder
 *
 * FOUND 2026-07-30 by looking at a real run's output instead of the code. The live
 * end-to-end run's committed ScoreRecord carries held-out test titles VERBATIM —
 * 24 of them, e.g. `criterionCoverage[0].testRefs[0]` =
 * `holdout/coglane-delivery.test.mjs › [REQ-001] T-1 the root document answers 200
 * …` — and `results/scores` appeared in NO deny layer. `sealedRoots` was
 * `[acceptance, scorer-out]`.
 *
 * The suite is frozen per ticket and reused across attempts, so a builder that read
 * a PREVIOUS run's score record would learn the titles it is about to be graded
 * against, and `heldOutPass` would stay `true` while meaning nothing. There is no
 * detector for that: it is a read the builder was permitted to make, in a directory
 * whose name says "results" rather than "answers".
 *
 * This asserts the SET THE ORCHESTRATOR PASSES, because that is what the drivers
 * enforce. Asserting a literal here would pass forever and measure nothing — the
 * same trap the egress tests above call out.
 * ---------------------------------------------------------------------- */

test("the builder is denied the score records, not just the scorer output", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    const call = h.builderCalls[0];
    assert.ok(call !== undefined, "a build must have started, or this asserts nothing");
    const sealed = call.sealedRoots;

    const scores = scoresRoot(h.paths);
    assert.ok(
      sealed.includes(scores),
      `results/scores must be sealed — it carries held-out test titles verbatim. Got: ${sealed.join(", ")}`,
    );
    // And the two older roots are still there. A "fix" that replaced rather than
    // added would trade one leak for two.
    assert.ok(sealed.includes(h.paths.acceptance), "the suite store is still sealed");
    assert.ok(sealed.includes(scorerOutRoot(h.paths)), "the scorer output is still sealed");
  } finally {
    await h.cleanup();
  }
});

/**
 * THE OTHER HALF OF `run-2026-07-30T13-31-38-076Z-c228e63b`.
 *
 * Two seconds into that run the dashboard announced a rate limit with a
 * 253,699-second wait — 70.5 hours — while the subscription was working and the
 * run's own row recorded `rate_limited = 0`. The number was CORRECT: it is when
 * the seven-day window rolls over, which the SDK reports routinely with nothing
 * refused. The event simply had no field for "this is not a refusal", so one was
 * emitted for both cases and the client assumed the worse one.
 *
 * `SseEvent` now requires `limited`, so a missing field is a compile error. What
 * a compiler cannot check is whether the RIGHT value goes on it — hard-coding
 * `true` here would type-check perfectly and reproduce the bug exactly. That is
 * what this test is for, and it reaches the real emitter rather than asserting
 * on a private method.
 *
 * WHICH CALLBACK THIS ACTUALLY DRIVES, SAID PLAINLY. It reports through
 * `BuildRequest.sink.rateLimit` — the BUILD phase. The run named above never
 * reached a builder; it died in the SPEC phase, whose report arrives through
 * `SubscriptionSeatCaller`'s `onRateLimit` instead. BOTH are one-line lambdas
 * closing over the same `#noteRateLimit`, which is the only emitter of this
 * event and is what is under test — but the spec-phase lambda itself is reached
 * by no test, because driving it needs a live seat call. Stating that is the
 * point: this proves the emitter, not the spec phase's wiring to it.
 */
test("a rate-limit report that refused nothing is not announced as a refusal", async () => {
  const seen: { limited: boolean; retryAfterSec: number | null }[] = [];
  const h = await designRun({
    designLock: "auto",
    onRequest: (request) => {
      // Exactly what the Agent SDK reports at session start on a healthy
      // subscription: the current window's reset instant, status `allowed`.
      request.sink.rateLimit({
        limited: false,
        retryAfterSec: 253_699,
        kind: "seven_day",
        utilization: 0.4,
      });
    },
  });
  try {
    await h.settle();

    for (const entry of h.store.eventsSince("run-design", 0)) {
      if (entry.event.type === "rate_limit") {
        seen.push({ limited: entry.event.limited, retryAfterSec: entry.event.retryAfterSec });
      }
    }

    assert.equal(seen.length > 0, true, "the report must still reach the stream — silence is not the fix");
    for (const event of seen) {
      assert.equal(
        event.limited,
        false,
        "the provider refused nothing; an event that cannot say so is what printed `rate limited` on a healthy run",
      );
    }
    assert.equal(
      seen[0]?.retryAfterSec,
      253_699,
      "and the reset instant is still carried — worth showing as a window fills, just not as a refusal",
    );

    // THE ROW AGREES WITH THE WIRE. `rate_limited = 0` is what the recorded run
    // already said while its event stream said the opposite.
    assert.equal(h.store.getRun("run-design")?.rateLimited, false, "the row must not record a limit either");
    assert.notEqual(
      h.store.getRun("run-design")?.status,
      "rate_limited",
      "a run that was never refused must not be PARKED as rate limited either",
    );
  } finally {
    await h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE BUILD SEGMENT IS TOLD THE ENVIRONMENT — AT THE SEAM, NOT IN THE MODULE.
 *
 * WHY THESE EXIST WHEN build-prompt.test.ts ALREADY PINS THE TEXT. That file
 * calls the two prompt functions directly, so it proves the strings contain the
 * facts and nothing about whether a run still sends them. This repository's
 * signature defect is exactly that gap. `designRun` drives the whole `#execute`,
 * and `builderCalls[n].prompt` is the string the driver was actually handed.
 *
 * TWO ARMS, BECAUSE THE ORCHESTRATOR HAS TWO AND THEY TAKE DIFFERENT FUNCTIONS:
 *
 *   NO LANE      one segment, `builderSessionId === null`, so
 *                `#buildSegmentPrompt` renders `dashboardBuilderPrompt`.
 *   DESIGN LANE  segment 1 is the design prompt and segment 2 RESUMES it, so the
 *                first BUILD turn takes the `resumeBuilderPrompt` branch and the
 *                first-turn prompt is never sent AT ALL. Measured on a real run:
 *                `runs/run-2026-07-30T20-16-40-242Z-052c6e02/results/prompt.txt`
 *                opens "Your previous turn ended early: the design was locked"
 *                and carries no working agreement. That run's build.log ends with
 *                the builder discovering `listen()` EPERM in prose — the second
 *                arm is the one that produced the defect.
 *
 * Each arm is red on its own deletion and green on the other's, which is what
 * makes them two tests rather than one written twice.
 * ---------------------------------------------------------------------- */

test("a run with NO lane: the single build segment carries the harness facts", async () => {
  const h = await designRun({ ticket: "a cli that renames files in place", designLock: "auto" });
  try {
    assert.equal(h.builderCalls.length, 1);
    const p = String(h.builderCalls[0]?.prompt);
    assert.match(p, /cannot open a port/i);
    assert.match(p, /EPERM/, "the error it will otherwise meet at the end");
    assert.match(p, /NO NETWORK/, "the container the artefact is judged in");
    assert.match(p, /node:sqlite/, "and what needs no install");
    assert.match(p, /README\.md/);
  } finally {
    await h.cleanup();
  }
});

test("A LANE RUN'S BUILD SEGMENT CARRIES THEM TOO — the arm the first-turn prompt never reaches", async () => {
  const h = await designRun({ designLock: "auto" });
  try {
    assert.equal(h.builderCalls.length, 2);
    const p = String(h.builderCalls[1]?.prompt);
    // The branch is named as well as the content, so a future change that made
    // segment 2 take the fresh-prompt path could not pass this quietly.
    assert.match(p, /Your previous turn ended early/, "segment 2 RESUMES; it is not a first turn");
    assert.match(p, /cannot open a port/i);
    assert.match(p, /EPERM/);
    assert.match(p, /NO NETWORK/);
    assert.match(p, /node:sqlite/);
    assert.match(p, /README\.md/);
  } finally {
    await h.cleanup();
  }
});

/**
 * THE DEFAULT IN `abortReasonOf`, WHICH IS LOAD-BEARING AND EASY TO GET BACKWARDS.
 *
 * An `abort()` with no reason — a path that predates the reasons, or a future one
 * that forgets to pass one — must be read as a CANCEL, not as a shutdown. The
 * asymmetry is the whole argument: a wrongly-terminal run is visible and
 * re-runnable, while a row wrongly left `running` is invisible forever, because
 * `reconcileOnBoot` only sweeps at boot and the process is still alive.
 *
 * TESTED ON THE FUNCTION, NOT THROUGH `cancel()`. Both real callers now pass a
 * reason, so neither can produce the unreasoned signal this guards — driving one
 * of them would assert the default while never reaching it.
 */
test("an abort signal with no reason is read as a cancel, never as a shutdown", () => {
  const bare = new AbortController();
  bare.abort();
  assert.equal(
    abortReasonOf(bare.signal),
    ABORT_CANCELLED,
    "the safe direction is terminal and visible, not a row left `running` that nothing revisits",
  );

  const garbage = new AbortController();
  garbage.abort(new Error("something threw"));
  assert.equal(abortReasonOf(garbage.signal), ABORT_CANCELLED, "an unrecognised reason defaults the same way");

  const stopping = new AbortController();
  stopping.abort(ABORT_SHUTDOWN);
  assert.equal(abortReasonOf(stopping.signal), ABORT_SHUTDOWN, "and the one reason that IS recognised still is");
});

/**
 * THE THIRD PHASE, AND THE ONE THE FIRST FIX MISSED.
 *
 * MEASURED ON A REAL RUN. A SIGTERM landed while
 * `run-2026-07-30T20-16-40-242Z-052c6e02` was in the gate. The fix loop noticed
 * and returned `cancelled`; nothing checked, so the run walked on through the
 * judge and finished `failed` with "the frozen held-out suite did not go green
 * in the sealed container" — about a suite that never got the chance. The owner
 * was told his build had failed its tests when someone had stopped the server.
 *
 * Spec THROWS, build returns a `cancelled` DISCRIMINANT, the gate returns a
 * `cancelled` REASON. Three shapes, and each one was missed in turn — which is
 * exactly why the check is on the SIGNAL and not on the shape.
 */
test("a shutdown during the GATE leaves the run resumable, not failed on a suite it never ran", async () => {
  const h = harness();
  try {
    seed(h.store, "run-gate-abort", 1);
    // Straight to the state the real run was in: past the build, at the gate.
    h.store.updateRun("run-gate-abort", {
      status: "running",
      phase: "gate",
      builderSessionId: "session-gate",
    });

    await h.orchestrator.shutdown();
    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun("run-gate-abort");
    assert.ok(row !== null);
    assert.equal(
      row.status,
      "awaiting_input",
      "a server stop during the gate must be recoverable, not a verdict",
    );
    assert.equal(
      row.heldOutPass,
      null,
      "NOTHING WAS SCORED. `false` here would be the exact lie the real run told — a claim " +
        "about a suite that never ran",
    );
    assert.equal(row.failureReason, null, "and no failure reason, because nothing failed");
  } finally {
    await h.orchestrator.shutdown();
    h.cleanup();
  }
});

/* ══ THE TWO-STAGE DESIGN LANE (2026-08-03) ════════════════════════════════ */

test("AUTO: canvass, choose, EXPAND, then build — three passes in one #buildPhase entry", async () => {
  // THE COST ARGUMENT MADE EXECUTABLE. Stage A renders MIN_CANVASS_REFS stills
  // across three directions; the chosen one is then expanded to today's shape;
  // the other two stay on disk and are never built or graded against.
  //
  // CONTROL: revert `for (let pass = 0; pass < 3; …)` to `< 2` in `#buildPhase`
  // and this goes red at the segment count — the auto run reaches the gate with
  // an unexpanded canvass, which is three pictures of a page nobody built.
  const h = await designRun({ designLock: "auto", directions: true });
  try {
    await h.settle(60_000);
    const design = h.builderCalls.filter((call) => call.prompt.startsWith("DESIGN LANE — art direction"));
    assert.equal(design.length, 2, "one canvass and one expansion");
    assert.match(String(design[0]?.prompt), /STAGE A — CANVASS/);
    assert.match(String(design[1]?.prompt), /STAGE B — EXPAND/);
    assert.equal(h.builderCalls.length, 3, "and then the BUILD segment, on the same session");
    assert.equal(h.builderCalls[2]?.resumeSessionId, h.builderCalls[0]?.observedSessionId, "one session throughout");

    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.ok(manifest !== null);
    assert.equal(manifest.directions.length, 3, "all three stay on disk as a record of what was offered");
    assert.equal(manifest.chosenDirection, "quiet-grid", "ui-designer's direction-choice.json was honoured");
    assert.equal(manifest.directionChoice?.by, "ui-designer");

    // THE HERO LOCK IS THE LAST THING STAGE B DOES, and it lands on the CHOSEN
    // direction's first still — `lockedMockup` keeps its meaning exactly.
    const hero = heroRefFor(manifest, "quiet-grid");
    assert.ok(hero !== null);
    assert.equal(manifest.lockedMockup, hero.path, "the canonical still is the chosen direction's hero");
    assert.ok(String(manifest.lockedMockup).includes("quiet-grid"), "and not one of the discarded directions'");
    assert.equal(manifest.lockedBy, "ui-designer", "the provenance is the DIRECTION choice's, carried forward");
    assert.match(String(manifest.lockedReason), /quiet-grid/, "and the reason names the direction");
    assert.ok(
      refsForDirection(manifest, "quiet-grid").length >= MIN_CANVASS_REFS,
      "the chosen direction was expanded past its two canvass stills",
    );
    assert.equal(refsForDirection(manifest, "editorial-slab").length, 2, "the discarded ones were NOT expanded");

    // AND THE BUILD SEGMENT SEES ONE DESIGN, NOT THREE. A handoff naming nine
    // stills of three incompatible designs is an instruction to build to "it".
    const build = String(h.builderCalls[2]?.prompt);
    assert.ok(build.includes("quiet-grid"), "the chosen direction's stills cross the handoff");
    assert.ok(!build.includes("editorial-slab"), "a discarded direction never reaches the build");
    assert.ok(!build.includes("warm-stack"));
  } finally {
    await h.cleanup();
  }
});

test("THE RECORD AND THE WIRE CARRY THE DIRECTIONS, and stage is `settled` once expanded", async () => {
  const h = await designRun({ designLock: "auto", directions: true });
  try {
    await h.settle(60_000);
    const record = h.lock();
    assert.ok(record !== null);
    assert.equal(record.directions.length, 3, "mirrored into results/, which is what toDetail may read");
    assert.equal(record.chosenDirection, "quiet-grid");
    assert.equal(record.chosenDirectionBy, "ui-designer");
    assert.equal(record.expanded, true, "NOT derived from `locked`: a degraded run never locks a still");

    // THE MIRROR CARRIES PUBLISHED PATHS, byte-identical to the cards' own, so a
    // client groups by Set membership with no filename parsing.
    const cards = new Set(h.mockups().map((shot) => shot.path));
    for (const direction of record.directions) {
      assert.ok(direction.mockups.length > 0, `${direction.slug} has published stills`);
      for (const path of direction.mockups) {
        assert.ok(cards.has(path), `${path} must be one of the cards the API lists`);
      }
    }

    const server = await h.serve();
    try {
      const detail = (await (await fetch(`${server.base}/api/runs/${h.runId}`)).json()) as RunDetail;
      assert.equal(detail.designLock?.stage, "settled");
      assert.equal(detail.designLock?.directions.length, 3);
      // FROM THE CONSTANTS, NOT FROM TWO LITERALS. The panel says these numbers to
      // the owner, so what has to hold is that the wire carries the caps the
      // driver enforces — a second spelling here would keep agreeing with itself
      // while the two drifted apart, which is how `turnsMax: 4` sat under
      // `rendersMax: 6` and made the render cap unreachable.
      assert.equal(
        detail.designLock?.rendersMax,
        MAX_DESIGN_ON_DEMAND_RENDERS,
        "the caps are on the wire so the panel can say them",
      );
      assert.equal(detail.designLock?.turnsMax, MAX_DESIGN_LOCK_TURNS);
      const discarded = detail.designLock?.directions.filter((direction) => direction.discarded) ?? [];
      assert.equal(discarded.length, 2, "offered, not built — and marked as such");
      assert.ok(discarded.every((direction) => direction.slug !== "quiet-grid"));
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("ASK: the run PARKS on the canvass, and the panel is told the suite is frozen", async () => {
  const h = await designRun({ designLock: "ask", directions: true, interactive: true });
  try {
    assert.equal(h.status(), "awaiting_input");
    const record = h.lock();
    assert.equal(record?.awaiting, true);
    assert.equal(record?.chosenDirection, null, "nothing is chosen until he chooses");
    assert.equal(record?.directions.length, 3);
    assert.equal(readDesignManifest(runPathsFor(h.paths, h.runId).workspace)?.lockedMockup, null, "and nothing is locked");

    // REQUIRED PANEL COPY, and it is on the run log when the park opens. An owner
    // who asks for a whole new page here is asking for something the verdict will
    // not check, and letting him believe otherwise is the failure.
    const logs = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log")
      .map((event) => JSON.stringify(event));
    assert.ok(
      logs.some((line) => line.includes("frozen in the spec phase")),
      "the frozen-suite sentence must be on the run log when the park opens",
    );
    assert.ok(logs.some((line) => line.includes("show me the contact section")), "and how to ask for a render");

    const server = await h.serve();
    try {
      const detail = (await (await fetch(`${server.base}/api/runs/${h.runId}`)).json()) as RunDetail;
      assert.equal(detail.designLock?.stage, "canvass");
      assert.equal(detail.designLock?.awaiting, true);
      assert.deepEqual(
        detail.designLock?.directions.map((direction) => direction.discarded),
        [false, false, false],
        "NOTHING is discarded before anything is chosen",
      );
      assert.ok(
        detail.designLock?.directions.every((direction) => direction.notes !== null),
        "each direction's written art direction is a Read target on the wire",
      );
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("THE OWNER CHOOSES A DIRECTION over HTTP, the run expands it, and the hero locks", async () => {
  const h = await designRun({ designLock: "ask", directions: true, interactive: true });
  try {
    assert.equal(h.status(), "awaiting_input");
    const server = await h.serve();
    try {
      const response = await fetch(`${server.base}/api/runs/${h.runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chosenDirection: "warm-stack" }),
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
    await h.settle(60_000);

    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.equal(manifest?.chosenDirection, "warm-stack");
    assert.equal(manifest?.directionChoice?.by, "owner", "his choice is recorded as HIS, not as automatic");
    assert.equal(manifest?.lockedMockup, heroRefFor(manifest, "warm-stack")?.path);
    assert.equal(manifest?.lockedBy, "owner");
    assert.ok(refsForDirection(manifest as DesignManifest, "warm-stack").length > 2, "and it was expanded");

    // A DIRECTION THAT DOES NOT EXIST IS REFUSED AND THE RUN STAYS PARKED — the
    // same property `#applyDesignLock` has, one stage earlier.
    const second = await designRun({ designLock: "ask", directions: true, interactive: true });
    try {
      const srv = await second.serve();
      try {
        const bad = await fetch(`${srv.base}/api/runs/${second.runId}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chosenDirection: "no-such-direction" }),
        });
        assert.equal(bad.status, 409, "a refused choice is a 409, not a silent proceed");
      } finally {
        await srv.close();
      }
      assert.equal(second.status(), "awaiting_input", "and the run is still waiting for a real one");
      assert.equal(second.lock()?.chosenDirection, null);
    } finally {
      await second.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test("A CLICK ON A CANVASS CARD NAMES ITS DIRECTION — the published path is the only handle", async () => {
  const h = await designRun({ designLock: "ask", directions: true, interactive: true });
  try {
    const card = h.mockups().find((shot) => shot.path.includes("editorial-slab"));
    assert.ok(card !== undefined, "the canvass stills are published as cards");
    const server = await h.serve();
    try {
      const response = await fetch(`${server.base}/api/runs/${h.runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chosenMockup: card.path }),
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
    await h.settle(60_000);
    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.equal(manifest?.chosenDirection, "editorial-slab", "the click resolved to the card's DIRECTION");
    // AND IT DID NOT LOCK THE CARD. That still is a canvass still of two
    // sections; locking it would have made `lockManifest` refuse the real hero.
    assert.equal(manifest?.lockedMockup, heroRefFor(manifest, "editorial-slab")?.path);
  } finally {
    await h.cleanup();
  }
});

test("THE CANVASS PARK EXPIRES AND PROCEEDS — no owner, no answer, still a built design", async () => {
  // §17.3 rule 1, on the new park: the window is finite and its lapse RESOLVES
  // the run rather than leaving it waiting. `ui-designer`'s direction-choice.json
  // is honoured on the way through, exactly as `choice.json` was.
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0.01" },
  });
  try {
    assert.equal(h.status(), "awaiting_input");
    await h.waitFor(() => h.status() !== "awaiting_input", 20_000, "the park never expired");
    await h.settle(60_000);
    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    // AN `ask` RUN NEVER ASKED FOR A CHOICE FILE — `autoChoose` is false, so the
    // prompt does not name `direction-choice.json` and the lane writes none. The
    // fallback is what resolves it, and it says so rather than dressing an
    // arbitrary pick up as a judgement.
    assert.equal(manifest?.chosenDirection, "editorial-slab", "first in manifest order");
    assert.equal(manifest?.directionChoice?.by, "fallback", "recording it as ui-designer would be a lie");
    assert.match(String(manifest?.directionChoice?.reason), /no judgement applied/);
    assert.equal(manifest?.lockedMockup, heroRefFor(manifest, "editorial-slab")?.path, "and the hero still locked");
    assert.equal(h.lock()?.expanded, true, "the expansion ran after the expiry, not instead of it");
    assert.equal(h.lock()?.chosenDirectionBy, "fallback");
  } finally {
    await h.cleanup();
  }
});

test("A PARK NOTHING CAN ANSWER IS STILL ENDED BY ITS OWN EXIT — the run proceeds, it does not wait for ever", async () => {
  /*
   * THE ONE FAILURE THIS FEATURE MUST NOT HAVE: A PARK WITH NO EXIT — and
   * 2026-08-03 made its input a NORMAL shape, because the degraded canvass is
   * now told to write `refs: []`.
   *
   * WHAT THIS TEST'S SUBJECT ACTUALLY IS, STATED SO THE DOCBLOCK DOES NOT CLAIM
   * MORE THAN THE CODE BELOW MEASURES: the DURABLE PAIR — a park record saying
   * `awaiting: true` beside a manifest whose question is already answered — and
   * what the automatic exit does when handed it. The pair is written here
   * directly, and it is the crash window in `#applyDirectionChoice`: that method
   * writes the MANIFEST (`writeDesignManifest`) and then `design-lock.json`
   * (`#mergeDesignLock`), so a dashboard that dies between the two comes back
   * holding exactly this. READ OFF THAT METHOD, not measured here; if those two
   * writes are ever reordered or made atomic this test still holds, because its
   * subject is the pair, whatever produced it.
   *
   * WHICH ARM ANSWERS IT, CORRECTED 2026-08-03 WITH THE CODE. This used to fall
   * to the MOCKUP arm — the choice is made, so the direction arm is skipped, and
   * that arm's guard did not check `directions` — where `fallbackChoice` over an
   * empty `refs` was null and the park closed on "nothing to lock". That was the
   * right ending reached through the wrong arm, and on a manifest with STILLS the
   * same route locked the first direction's canvass still on a run pointed
   * somewhere else (`THE OWNER CLICKS ONE DIRECTION AND GETS THAT ONE`). The pair
   * is now answered by `#closeSettledPark`, which closes the record BECAUSE the
   * question is already answered and mirrors the manifest's answer onto it.
   *
   * MEASURED BEFORE THE ORIGINAL FIX: this test failed at the wait below with
   *   "the park was never resolved (last status: awaiting_input)".
   */
  const h = await designRun({
    designLock: "ask",
    emptyRefs: "canvass",
    noKey: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    // THE CONTROL FOR EVERY ASSERTION BELOW: the park is real, the fixture
    // reached it, and it is the DEGRADED one — words, no stills, nothing to click.
    assert.equal(h.status(), "awaiting_input", "the degraded canvass parks: three directions and no images");
    assert.equal(h.lock()?.awaiting, true);
    assert.equal(h.lock()?.directions.length, 3, "on WORDS: the directions are on the record, the stills do not exist");
    assert.equal(h.mockups().length, 0, "and there is not one card to click");

    // The pair, written as the two files it consists of. They are two files and
    // they CAN disagree — asserted rather than assumed, because a record that
    // could not lag its manifest would make this state unreachable and this test
    // a check on nothing.
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    const manifest = readDesignManifest(workspace);
    assert.ok(manifest !== null);
    writeDesignManifest(workspace, {
      ...manifest,
      chosenDirection: "quiet-grid",
      directionChoice: { by: "owner", reason: "chosen by the owner in the dashboard", at: new Date().toISOString() },
    });
    assert.equal(
      readDesignManifest(workspace)?.chosenDirection,
      "quiet-grid",
      "the manifest carries the choice…",
    );
    assert.equal(h.lock()?.chosenDirection, null, "…and the record beside it does not: two files, two writes");
    assert.equal(h.lock()?.awaiting, true, "so the record still says the run is waiting — that IS the state");

    // THE WINDOW LAPSES AND THE DASHBOARD COMES BACK UP — the durable half of
    // the bound, which is the path that has to resolve a park no timer survives.
    h.rewindParkTime(31 * 60_000);
    h.orchestrator.reconcileOnBoot();
    await h.waitFor(() => h.status() !== "awaiting_input", 20_000, "the park was never resolved");
    await h.settle(60_000);

    const park = h.lock();
    assert.equal(park?.awaiting, false, "the record must not still say the run is waiting for a click");
    assert.equal(park?.locked, null, "nothing was locked, because there was nothing to lock");
    assert.ok(
      String(park?.reason).includes('already chosen the "quiet-grid" direction'),
      `the park closed on a RECORDED reason that names the answer it found: ${String(park?.reason)}`,
    );
    // AND THE RECORD WAS RECONCILED TO THE MANIFEST, not merely closed: the
    // panel's `stage` is derived from THIS field, so a close that left it null
    // would report a run that is expanding and then building as still asking.
    assert.equal(park?.chosenDirection, "quiet-grid");
    // AND IT PROCEEDED: the expansion and the build both ran on the direction
    // that was chosen. A park that ends by giving up is not what rule 1 asks for.
    assert.equal(readDesignManifest(workspace)?.chosenDirection, "quiet-grid");
    assert.equal(h.lock()?.expanded, true, "stage B ran after the park ended");
    assert.equal(h.builderCalls.length, 3, "canvass, expand, build — the run finished the work it parked in the middle of");
  } finally {
    await h.cleanup();
  }
});

test("A LEGACY PARK OVER A MANIFEST THAT NAMES NOTHING still ends on `nothing to lock`", async () => {
  /*
   * THE MOCKUP ARM'S `attempt === null` BRANCH, WHICH ITS OWN COMMENT NOW CLAIMS
   * ONLY A NARROW PATH FOR — and this is that path, driven. `#buildPhase` stopped
   * OPENING a park on a manifest with nothing to choose between, so nothing
   * produces this shape fresh; what reaches the branch is a park record written
   * before that entry guard existed, sitting on disk beside a manifest that names
   * neither a direction nor a still.
   *
   * WITHOUT THIS TEST THE BRANCH IS UNREACHED BY THE SUITE. `A PARK NOTHING CAN
   * ANSWER` drove it until the mockup arm's guard was completed and now takes the
   * `#closeSettledPark` arm instead — so a comment that says "the records it
   * answers are on disk" would be a claim with no measurement behind it.
   */
  const h = await designRun({
    designLock: "ask",
    emptyRefs: "canvass",
    noKey: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.equal(h.status(), "awaiting_input", "the degraded canvass parks: three directions and no images");
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    const manifest = readDesignManifest(workspace);
    assert.ok(manifest !== null);
    // THE LEGACY SHAPE: a lane that named nothing. No directions, no refs, no
    // lock — so the mockup arm takes it and has nothing to fall back on.
    writeDesignManifest(workspace, { ...manifest, directions: [] });
    assert.equal(h.lock()?.awaiting, true, "and the park record is still open beside it");

    h.rewindParkTime(31 * 60_000);
    h.orchestrator.reconcileOnBoot();
    await h.waitFor(() => h.status() !== "awaiting_input", 20_000, "the park was never resolved");
    await h.settle(60_000);

    const park = h.lock();
    assert.equal(park?.awaiting, false, "the park ended rather than hanging");
    assert.equal(park?.locked, null, "and nothing was locked, because there was nothing to lock");
    assert.ok(
      String(park?.reason).includes("no mockups"),
      `it closed on a RECORDED fallback that says why: ${String(park?.reason)}`,
    );
    assert.equal(h.builderCalls.length, 2, "canvass, then build — no expansion, because nothing was chosen");
  } finally {
    await h.cleanup();
  }
});

test("A PARK WITH NOTHING TO CHOOSE BETWEEN IS NOT ENTERED — an empty manifest builds, it does not wait", async () => {
  /*
   * THE OTHER HALF OF THE SAME BUG, AT THE ENTRY. `#buildPhase`'s pre-canvass
   * arm parks an `ask` run whenever `lockedMockup` is null, without asking
   * whether there is a single mockup to choose from — and its log line then
   * tells the owner to `POST /resume {"chosenMockup":"<path>"}` with no path in
   * existence. Nothing he can do ends that park.
   *
   * MEASURED BEFORE THE FIX: this test failed at the first assertion with
   *   "there is nothing to click, so the question has no answer: 'awaiting_input' != 'awaiting_input'".
   */
  const h = await designRun({
    designLock: "ask",
    emptyRefs: "bare",
    noKey: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.notEqual(h.status(), "awaiting_input", "there is nothing to click, so the question has no answer");
    // THE CONTROL: the design lane RAN. "It never parked" is only a result if the
    // segment that would have produced the mockups actually happened — an `off`
    // lane would pass the assertion above and measure nothing.
    assert.ok(String(h.builderCalls[0]?.prompt).startsWith("DESIGN LANE"), "the design segment ran");
    assert.equal(h.builderCalls.length, 2, "and the BUILD segment ran rather than waiting the window out");
    // NO RECORD AT ALL, which is `a DEGRADED lane still runs both segments`'s
    // rule: nothing was locked and nothing was asked, so nothing is invented.
    assert.equal(h.lock(), null, "no park was opened and no choice was recorded");
    const warnings = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log" && event.level === "warn")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      warnings.some((text) => text.includes("nothing to choose between")),
      `an ask run that does not ask must SAY so: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("THE OWNER CLICKS ONE DIRECTION AND GETS THAT ONE — a canvass park is never answered by the MOCKUP arm", async () => {
  /*
   * `resume`'s MOCKUP ARM WAS GATED ON `lockedMockup === null` ALONE, with no test
   * that this is a manifest with no DIRECTIONS — which is the one thing the arm is
   * for. Its sibling's own comment says why that guard is load-bearing ("falling
   * through would set `lockedMockup` to an image of two sections"), and the guard
   * it had only covered `chosenDirection === null`.
   *
   * THE INPUT IS THE CRASH WINDOW IN `#applyDirectionChoice`, which writes the
   * MANIFEST and then `design-lock.json`: a dashboard that dies between the two
   * comes back with a choice on the manifest beside an `awaiting: true` record.
   * The owner then clicks a direction — and the DIRECTION arm is skipped, because
   * `chosenDirection` is non-null ON THE MANIFEST, so the arm below runs with
   * `chosenMockup` null and `fallbackChoice` locks `refs[0]`: EDITORIAL SLAB's
   * canvass still, on a run he pointed at QUIET GRID. `#applyDesignLock` succeeds
   * and the route answers 200.
   *
   * MEASURED BEFORE THE FIX: this test failed at the `lockedMockup` assertion with
   *   "the hero of the direction HE CLICKED, not refs[0] of the one he did not:
   *    '…/editorial-slab-01-hero.png' !== '…/quiet-grid-01-hero.png'".
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.equal(h.status(), "awaiting_input", "the canvass park is real and the fixture reached it");
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    const canvassed = readDesignManifest(workspace);
    assert.ok(canvassed !== null);
    // THE CONTROL FOR THE WHOLE TEST: this manifest has STILLS. Round 3's park
    // test could only reach this pair through `emptyRefs: "canvass"`, so the
    // non-empty branch — the one where a wrong lock is possible — was uncovered.
    assert.equal(canvassed.refs.length, 6, "three directions, two comparable sections each");

    // The pair, written as the two files it is. They CAN disagree, and that is the
    // state: the manifest carries the choice, the record beside it does not.
    writeDesignManifest(workspace, {
      ...canvassed,
      chosenDirection: "quiet-grid",
      directionChoice: { by: "owner", reason: "chosen by the owner in the dashboard", at: new Date().toISOString() },
    });
    assert.equal(h.lock()?.chosenDirection, null, "two files, two writes");
    assert.equal(h.lock()?.awaiting, true, "so the record still says the run is waiting — that IS the state");

    const server = await h.serve();
    try {
      const response = await fetch(`${server.base}/api/runs/${h.runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chosenDirection: "quiet-grid" }),
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
    await h.settle(60_000);

    const manifest = readDesignManifest(workspace);
    assert.ok(manifest !== null);
    assert.equal(manifest.chosenDirection, "quiet-grid");
    assert.equal(
      manifest.lockedMockup,
      heroRefFor(manifest, "quiet-grid")?.path,
      "the hero of the direction HE CLICKED, not refs[0] of the one he did not",
    );
    assert.ok(
      !String(manifest.lockedMockup).includes("editorial-slab"),
      `the gate must not grade a quiet-grid build against editorial slab: ${String(manifest.lockedMockup)}`,
    );
    assert.ok(refsForDirection(manifest, "quiet-grid").length > 2, "and stage B ran: the choice was EXPANDED");

    /* THE RECORD IS RECONCILED TO THE MANIFEST, NOT MERELY CLOSED. `designLockOf`
     * (http.ts) derives the panel's `stage` from the RECORD — `directions.length >
     * 0 && chosenDirection === null` reads as `"canvass"` — so an else-arm that
     * flipped `awaiting` and left `chosenDirection` null would swap one wire lie
     * for another: no countdown, and a run that is expanding and then building
     * reported as still asking. */
    const park = h.lock();
    assert.equal(park?.awaiting, false, "the record must not still say the run is waiting for a click");
    assert.equal(park?.chosenDirection, "quiet-grid", "and the panel's stage is read off THIS field");
    assert.equal(park?.chosenDirectionBy, "owner");
    assert.equal(park?.expanded, true);
    assert.equal(park?.locked, heroRefFor(manifest, "quiet-grid")?.path);
  } finally {
    await h.cleanup();
  }

  /* ---- AND A LATE CLICK IS DISCARDED OUT LOUD, NOT APPLIED --------------
   *
   * WHAT THIS FIX DOES NOT DO, MEASURED SO IT IS NOT LEFT AS PROSE. The arm
   * above stops the wrong IMAGE being locked; it does not make a click that
   * arrives after the run has already settled take effect, and it cannot:
   * `chooseDirection` refuses a second choice because the expansion has already
   * spent its generations on the first, so re-choosing would leave the manifest
   * pointing at a direction the stills were never drawn for. So the route still
   * answers 200 and the run still builds what it had chosen — and the ONE
   * defence against that being invisible is that the log names both. This
   * asserts that sentence exists, because a defence nothing checks is prose.
   */
  const late = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    const workspace = runPathsFor(late.paths, late.runId).workspace;
    const canvassed = readDesignManifest(workspace);
    assert.ok(canvassed !== null);
    writeDesignManifest(workspace, {
      ...canvassed,
      chosenDirection: "quiet-grid",
      directionChoice: { by: "owner", reason: "chosen by the owner in the dashboard", at: new Date().toISOString() },
    });

    assert.equal(late.orchestrator.resume(late.runId, null, "warm-stack"), true);
    await late.settle(60_000);

    const manifest = readDesignManifest(workspace);
    assert.ok(manifest !== null);
    assert.equal(manifest.chosenDirection, "quiet-grid", "the settled choice stands: a second one is refused");
    assert.equal(manifest.lockedMockup, heroRefFor(manifest, "quiet-grid")?.path);
    const warnings = late.store
      .eventsSince(late.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log" && event.level === "warn")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      warnings.some((text) => text.includes('"warm-stack"') && text.includes('"quiet-grid"')),
      `a click that was NOT applied must name itself and the choice that stood: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await late.cleanup();
  }
});

test("A PARK NEITHER ARM CAN ANSWER IS CLOSED BY AN EXPLICIT ELSE — nothing is left saying `awaiting`", async () => {
  /*
   * THE SECOND SYMPTOM OF THE SAME MISSING ARM. `resume`'s design-lock block was
   * two `if`s and no `else`, so every input neither one matched — an unreadable
   * manifest, or directions+choice+lock all present after the crash window in
   * `#applyDesignLock` — fell straight through to the timer clear and proceeded
   * with `awaiting: true` LEFT ON DISK. Nothing ever closed that record:
   * `designLockOf` puts `awaiting` on the wire ungated by run status, so the panel
   * shows an open park with a countdown on a run that is building or already
   * finished, and every later `reconcileOnBoot` re-parks it.
   *
   * MEASURED BEFORE THE FIX: this test failed at the first post-resume assertion
   *   "the record must not still say the run is waiting: true !== false".
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.equal(h.status(), "awaiting_input");
    const workspace = runPathsFor(h.paths, h.runId).workspace;
    // NEITHER ARM CAN READ THIS. `readDesignManifest` answers null for a corrupt
    // file by design (it is a `try`/`catch`), and null is what both arms test
    // first — so this is the input that matches nothing at all.
    writeFileSync(join(workspace, "design-refs", "manifest.json"), "{ this is not json", "utf8");
    assert.equal(readDesignManifest(workspace), null, "the control: the manifest really is unreadable");
    assert.equal(h.lock()?.awaiting, true);

    assert.equal(h.orchestrator.resume(h.runId, null, "quiet-grid"), true, "the park still has to END");
    await h.settle(60_000);

    const park = h.lock();
    assert.equal(park?.awaiting, false, "the record must not still say the run is waiting");
    assert.ok(
      String(park?.reason).length > 0,
      `and it says WHY it closed, so the panel is not left inventing one: ${String(park?.reason)}`,
    );
    const warnings = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log" && event.level === "warn")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      warnings.some((text) => text.includes("could not be read")),
      `a park that ends on nothing must SAY so on the run's own log: ${JSON.stringify(warnings)}`,
    );

    /* THE CONTROL FOR "NOTHING EVER CLOSES IT": the record is what
     * `reconcileOnBoot` reads, and a dead builder leaves its row `running`. With
     * `awaiting: true` still on disk the next boot re-parks a run that had already
     * left the park — for ever, once per boot. */
    h.store.updateRun(h.runId, { status: "running" });
    h.orchestrator.reconcileOnBoot();
    assert.equal(h.lock()?.awaiting, false, "and the next boot does not re-park a run whose park is over");
  } finally {
    await h.cleanup();
  }
});

test("A CANVASS THAT ALREADY CARRIES A CHOICE DOES NOT PARK FOR A MOCKUP — `#buildPhase`'s third arm", async () => {
  /*
   * THE SAME SHAPE AT THE OTHER SITE. `#buildPhase`'s last arm is commented "NO
   * DIRECTIONS: verbatim the pre-2026-08-03 branch" and its condition checked no
   * such thing: round 3 added a guard on `refs.length`, not on `directions`. So a
   * canvass that returns with a choice already on it — three directions, six
   * stills, `chosenDirection` set — took the MOCKUP arm, parked the owner in front
   * of six canvass cards, and told him to `POST /resume {"chosenMockup":"<path>"}`
   * on a run whose direction was already settled. Whichever card he clicked,
   * `lockManifest` would set `lockedMockup` to an image of TWO SECTIONS and refuse
   * the real hero at the end of stage B.
   *
   * MEASURED BEFORE THE FIX: this test failed at the first assertion with
   *   "the direction is already settled, so there is no question to ask:
   *    'awaiting_input' != 'awaiting_input'".
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    canvassChoice: "warm-stack",
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.notEqual(h.status(), "awaiting_input", "the direction is already settled, so there is no question to ask");
    // THE CONTROL: the design lane RAN and produced the cards it would have parked
    // on. "It never parked" is only a result if there was something to park over.
    assert.ok(String(h.builderCalls[0]?.prompt).startsWith("DESIGN LANE"), "the canvass segment ran");
    assert.equal(h.mockups().length > 0, true, "and it published cards — this is not an empty-refs run");
    assert.equal(h.builderCalls.length, 3, "canvass, expand, build — it went round rather than waiting");

    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.ok(manifest !== null);
    assert.equal(manifest.chosenDirection, "warm-stack");
    assert.equal(
      manifest.lockedMockup,
      heroRefFor(manifest, "warm-stack")?.path,
      "the EXPANDED direction's hero is what locks, never one of the canvass stills",
    );
    assert.ok(refsForDirection(manifest, "warm-stack").length > 2, "and stage B actually ran");
    // AND THE FOURTH ARM SAID SO. A shape that matches none of the three deciding
    // arms passes through in silence unless this line exists, and silence is what
    // made the third arm's guard look adequate for three rounds.
    const infos = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log" && event.level === "info")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      infos.some((text) => text.includes("already answers the park's question") && text.includes("warm-stack")),
      `the arm that decided NOT to ask has to say so: ${JSON.stringify(infos.slice(0, 40))}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("A RESTART DURING A CANVASS PARK RE-ARMS FOR THE REMAINDER, and the clock does not restart", async () => {
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    const before = h.lock()?.parkedAt;
    assert.ok(before !== undefined);
    // 29 of the 30 minutes gone. A boot that re-minted `parkedAt` would give the
    // run another 30, and a dashboard restarted every few minutes would park for
    // ever while the code claimed a bound.
    h.rewindParkTime(29 * 60_000);
    const rewound = h.lock()?.parkedAt;
    h.orchestrator.reconcileOnBoot();
    assert.equal(h.status(), "awaiting_input", "still parked: the window has not lapsed");
    assert.equal(h.lock()?.parkedAt, rewound, "and the deadline did not walk forward");
    assert.equal(h.lock()?.chosenDirection, null);
  } finally {
    await h.cleanup();
  }
});

test("THE ORCHESTRATOR STILL CARRIES deliverDesignRequest — `?.` swallows a rename", async () => {
  // `RunController.deliverDesignRequest` is OPTIONAL, for the reason
  // `deliverPlanReply` is: eight test doubles implement that interface. The cost
  // is that renaming the method here would silently disable the design intake
  // rather than fail to compile, so the real class is asserted to carry it.
  const h = await designRun({ designLock: "ask", directions: true, interactive: true });
  try {
    assert.equal(typeof h.orchestrator.deliverDesignRequest, "function");
    // A message that does not name a DIRECTION is DECLINED, so it stays pending
    // and reaches the next build segment. A section alone is not enough, and
    // neither is a digit in a sentence — design-dialogue.ts owns that judgement.
    h.store.appendMessage(h.runId, { role: "owner", text: "keep it accessible", images: [] });
    assert.equal(h.orchestrator.deliverDesignRequest(h.runId), false);
    assert.equal(h.store.pendingMessages(h.runId).length, 1);
    // AND THE SAME ROUTE, ON A SENTENCE THAT NAMES A SECTION AND A NUMBER: still
    // an instruction, still unclaimed, still on its way to the builder.
    h.store.appendMessage(h.runId, {
      role: "owner",
      text: "put the phone number 2 lines below the address in the footer",
      images: [],
    });
    assert.equal(h.orchestrator.deliverDesignRequest(h.runId), false);
    assert.equal(h.store.pendingMessages(h.runId).length, 2);
    assert.equal(h.lock()?.rendersUsed, 0, "and it cost him no render");
    assert.equal(h.lock()?.turnsUsed, 0, "and no turn");
  } finally {
    await h.cleanup();
  }
});

test("AN ON-DEMAND RENDER JOINS THE MANIFEST MARKED `requested`, and can never become the hero", async () => {
  // THE HOST WRITES `origin`, never an agent, which is what makes a missing
  // `origin` unable to be a lost `"requested"`. `refsForDirection` excludes them,
  // so a preview the owner asked for mid-park cannot become the still the visual
  // gate grades the whole build against.
  //
  // CONTROL: write `origin: "canvass"` on the ref in `#renderOnDemand` and this
  // goes red at `refsForDirection` — the preview enters the direction's set.
  const h = await designRun({ designLock: "ask", directions: true, interactive: true });
  try {
    h.store.appendMessage(h.runId, { role: "owner", text: "show me the contact section in 1", images: [] });
    assert.equal(h.orchestrator.deliverDesignRequest(h.runId), true, "it is heard as a request");
    await h.waitFor(() => (h.lock()?.requests.length ?? 0) > 0, 30_000, "the render was never recorded");

    const record = h.lock();
    assert.equal(record?.rendersUsed, 1, "one generation, on disk, so a restart cannot make it free");
    assert.equal(record?.turnsUsed, 1);
    const request = record?.requests[0];
    assert.equal(request?.direction, "editorial-slab");
    assert.equal(request?.section, "contact");
    // OFF-BRIEF, AND SAID SO. The canvass rendered hero and work; `contact` is
    // not one of the sections this build will produce, so the still is drawn —
    // refusing would be the dashboard deciding what he may look at — and reported
    // as a look at the DIRECTION rather than a preview of the page.
    assert.equal(request?.outcome, "rendered-off-brief", `the stub script returns 0: ${String(request?.detail)}`);
    assert.match(String(request?.detail), /NOT one of the sections this build will produce/);
    assert.match(String(request?.detail), /frozen in the spec phase/);

    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.ok(manifest !== null);
    const requested = manifest.refs.filter((ref) => ref.origin === "requested");
    assert.equal(requested.length, 1, "the ref joined the manifest");
    assert.equal(requested[0]?.direction, "editorial-slab");
    assert.ok(String(requested[0]?.path).includes("-req-"), "and the distinction survives on disk as well");
    assert.ok(
      !refsForDirection(manifest, "editorial-slab").some((ref) => ref.origin === "requested"),
      "and it is OUT of the direction's set, so it can never be the hero",
    );

    // THE PARK IS THE SAME PARK. `parkedAt` unchanged, still awaiting, still
    // nothing chosen — the clock kept running through the exchange.
    assert.equal(record?.awaiting, true);
    assert.equal(record?.chosenDirection, null);
    assert.equal(h.status(), "awaiting_input");
    // AND THE STILL IS IN THE PANEL, which IS the answer: there is no `run` chat
    // row for a host-composed sentence.
    assert.ok(
      h.mockups().some((shot) => shot.path.includes("-req-")),
      "the on-demand still is published as a card",
    );

    // AND A SECTION THE CANVASS DID RENDER IS ON-BRIEF, which is what makes the
    // flag above a measurement rather than a constant.
    h.store.appendMessage(h.runId, { role: "owner", text: "now the hero in 2", images: [] });
    assert.equal(h.orchestrator.deliverDesignRequest(h.runId), true);
    await h.waitFor(() => (h.lock()?.requests.length ?? 0) > 1, 30_000, "the second render");
    const second = h.lock()?.requests[1];
    assert.equal(second?.outcome, "rendered");
    assert.equal(second?.direction, "quiet-grid");
    assert.equal(h.lock()?.rendersUsed, 2, "two generations, counted twice");

    // AND THE SPEND SURVIVES THE CHOICE. `#applyDirectionChoice` writes
    // `design-lock.json` on the way past; a caller that REBUILT that record
    // instead of merging onto it would reset `rendersUsed` to 0 and the renders
    // he already paid for would become free again — with the images already
    // generated and the record of what he asked for gone.
    assert.equal(h.orchestrator.resume(h.runId, null, "quiet-grid"), true);
    await h.settle(60_000);
    const after = h.lock();
    assert.equal(after?.rendersUsed, 2, "the spend survived the write that recorded the choice");
    assert.equal(after?.turnsUsed, 2);
    assert.equal(after?.requests.length, 2, "and so did the record of what he asked for");
    assert.equal(after?.chosenDirection, "quiet-grid");
  } finally {
    await h.cleanup();
  }
});

test("A GENERATION THAT WAS NEVER ATTEMPTED IS NOT CHARGED — the cap bounds SPEND", async () => {
  /*
   * THE DEGRADED PARK'S BILL. With no key `#renderOnDemand` returns before it
   * runs anything — there is nothing to draw with, and it says so — and the
   * driver charged that non-event a render anyway. Two docblocks said the
   * opposite in as many words ("the call was made and the money was spent";
   * "what makes `rendersUsed` count requests and generations identically"), so
   * on the one lane where the answer is always "no image generation on this
   * machine" the owner was told, after six questions, that he had spent a budget
   * nothing had ever drawn against.
   *
   * MEASURED BEFORE THE FIX: `rendersUsed` was 1 with `attempts` at 0.
   */
  let attempts = 0;
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    noKey: true,
    duringRender: () => {
      attempts += 1;
    },
  });
  try {
    h.store.appendMessage(h.runId, { role: "owner", text: "show me the contact section in 1", images: [] });
    assert.equal(h.orchestrator.deliverDesignRequest(h.runId), true, "the question is still heard");
    await h.waitFor(() => (h.lock()?.requests.length ?? 0) > 0, 30_000, "the answer was never recorded");

    const record = h.lock();
    assert.equal(attempts, 0, "no image tool was invoked: there is no key on this run");
    assert.equal(record?.rendersUsed, 0, "so nothing was charged — the cap bounds spend, and none happened");
    assert.equal(record?.turnsUsed, 1, "the TURN is still spent: he asked, and the park answered him");
    assert.equal(record?.requests[0]?.outcome, "failed");
    assert.match(String(record?.requests[0]?.detail), /no image generation on this machine/);
    // AND THE PARK IS UNCHANGED underneath the answer — same clock, same question.
    assert.equal(record?.awaiting, true);
    assert.equal(h.status(), "awaiting_input");
  } finally {
    await h.cleanup();
  }
});

test("A DIRECTION CHOSEN WHILE A RENDER IS IN FLIGHT SURVIVES THE RENDER'S OWN WRITE", async () => {
  /*
   * THE READ-MODIFY-WRITE WINDOW, AND IT IS THE WORST FAILURE THIS PARK HAS.
   * `#renderOnDemand` read the manifest at entry and wrote `{...manifest, refs}`
   * after the generation — one `await` wide, with no re-read — so any write that
   * landed in between was clobbered.
   *
   * THE SCENARIO, VERBATIM: the owner asks for a still, then clicks a direction
   * while the image is generating. `resume` → `#applyDirectionChoice` writes
   * `chosenDirection`; the render's stale write erases it back to null;
   * `#buildPhase` re-reads the manifest, sees `directionChosen: false` with
   * `designSegmentDone: true`, and `nextBuildSegment` returns `design` — SO THE
   * CANVASS RE-RUNS, six more generations no cap counts, then re-parks, and that
   * park's timer falls to `fallbackDirectionChoice` and builds DIRECTION 1,
   * recorded as "no owner choice arrived before the timeout" rather than the
   * direction he clicked.
   *
   * THE SENTINEL IS THE PUBLISHED CARD, NOT THE RECORD. `design-lock.json` is not
   * written at all on the buggy path — the same await window returns before
   * `#commit` — so waiting on `requests.length` would hang instead of failing.
   */
  const during: { fire: () => void } = { fire: () => undefined };
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    duringRender: () => {
      during.fire();
    },
  });
  try {
    // THE CLICK, through the same public entry the HTTP route uses.
    during.fire = () => {
      assert.equal(h.orchestrator.resume(h.runId, null, "quiet-grid"), true, "the click was accepted");
    };
    h.store.appendMessage(h.runId, { role: "owner", text: "show me the contact section in 1", images: [] });
    assert.equal(h.orchestrator.deliverDesignRequest(h.runId), true, "the request is heard");
    await h.waitFor(
      () => h.mockups().some((shot) => shot.path.includes("-req-")),
      30_000,
      "the on-demand still was never published",
    );

    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.equal(manifest?.chosenDirection, "quiet-grid", "the render's write must not erase the direction he chose");
    assert.equal(manifest?.directionChoice?.by, "owner", "and the record must not say nobody chose");

    await h.settle(60_000);
    const canvasses = h.builderCalls.filter((call) => call.prompt.includes("STAGE A — CANVASS"));
    assert.equal(canvasses.length, 1, "the canvass ran ONCE: a lost choice is six more generations no cap counts");
    assert.equal(h.lock()?.chosenDirectionBy, "owner", "and the built direction is the one he clicked");
  } finally {
    await h.cleanup();
  }
});

test("A RE-ARMED PARK ANNOUNCES THE REMAINDER, not a window it is not giving him", async () => {
  /*
   * ONE NUMBER, TWO CONSUMERS. `#parkForDesignLock` arms its timer for the
   * REMAINDER of the original window (`reconcileOnBoot` hands it the original
   * `parkedAt`) while its log line named the FULL `timeoutMin` — and that line is
   * the only place the deadline is published: `ApiDesignLock` carries neither
   * `parkedAt` nor the timeout, so `designParkClock` (dashboard/src/lib) parses
   * this sentence and draws the owner's countdown from it. A line naming 30 on a
   * park with one minute left is a clock he can plan around and be wrong about.
   *
   * IT ALSO COMPUTED `remaining` FROM THE ARGUMENT rather than from the record it
   * had just merged. The two agree on this path; on a re-park with the argument
   * defaulted they do not, and the timer then runs a fresh full window while the
   * record — the durable half of the bound — keeps the original instant.
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    const windows = (of: DesignHarness): number[] =>
      of.store
        .eventsSince(of.runId, 0)
        .map((stored) => JSON.stringify(stored.event))
        .filter((line) => line.includes("DESIGN lane") && line.includes("to be chosen"))
        .map((line) => Number.parseFloat(/inside (\d+(?:\.\d+)?) minutes/u.exec(line)?.[1] ?? "NaN"));

    assert.deepEqual(windows(h), [30], "the opening park names the whole window, because it has the whole window");

    // 25 of the 30 minutes gone, then the dashboard comes back up.
    h.rewindParkTime(25 * 60_000);
    h.orchestrator.reconcileOnBoot();
    assert.equal(h.status(), "awaiting_input", "still parked: the window has not lapsed");

    const announced = windows(h);
    assert.equal(announced.length, 2, "the re-arm announced itself");
    const remaining = announced[1] ?? Number.NaN;
    assert.ok(
      remaining > 4 && remaining <= 5,
      `the re-arm must name the ~5 minutes it is actually giving him, not a fresh window: ${String(remaining)}`,
    );

    // THE PRE-CANVASS PARK SAYS IT THE SAME WAY, and it is the sentence
    // `dashboard/tests/design-park-clock.unit.spec.ts` quotes as the producer. A
    // fresh park must still read `30` — the remainder is computed in tenths of a
    // minute, and `29.9` here would be six seconds of the owner's countdown lost
    // to arithmetic rather than to time.
    const mockupPark = await designRun({
      designLock: "ask",
      interactive: true,
      env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
    });
    try {
      assert.deepEqual(windows(mockupPark), [30], "a run with no directions parks with the whole window named");
      assert.ok(
        mockupPark.store
          .eventsSince(mockupPark.runId, 0)
          .map((stored) => JSON.stringify(stored.event))
          .some((line) => line.includes("with no choice inside 30 minutes, ui-designer picks")),
        "and the pre-2026-08-03 sentence is unchanged, word for word",
      );
    } finally {
      await mockupPark.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test("A RUN WITH NO DIRECTIONS TAKES THE PRE-2026-08-03 PATH, VERBATIM", async () => {
  // A lane that ignored the canvass ask degrades to today's behaviour rather than
  // hanging: it parks for a MOCKUP, `stage` is `"none"`, and the client renders
  // exactly what it rendered before.
  const h = await designRun({ designLock: "auto" });
  try {
    await h.settle(60_000);
    const manifest = readDesignManifest(runPathsFor(h.paths, h.runId).workspace);
    assert.deepEqual(manifest?.directions, []);
    assert.equal(manifest?.chosenDirection, null);
    assert.ok(manifest?.lockedMockup !== null, "and a still is still locked, by choice.json");
    const design = h.builderCalls.filter((call) => call.prompt.startsWith("DESIGN LANE — art direction"));
    assert.equal(design.length, 1, "one design segment, not two: there is nothing to expand");

    const server = await h.serve();
    try {
      const detail = (await (await fetch(`${server.base}/api/runs/${h.runId}`)).json()) as RunDetail;
      assert.equal(detail.designLock?.stage, "none");
      assert.deepEqual(detail.designLock?.directions, []);
      assert.equal(detail.designLock?.rendersUsed, 0, "a falsy absent value must never read as unlimited");
      assert.equal(detail.designLock?.turnsUsed, 0);
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

/* ==================================================================== *
 * ROUND 5 — `#buildPhase`'s POST-SEGMENT ARMS, CLOSED OVER (STAGE × STATE)
 * ==================================================================== */

test("FINDING O: AN EXPANSION THAT LOSES THE CHOICE NEVER RE-OPENS STAGE A's PARK", async () => {
  /*
   * THE SECOND PARK IS INVISIBLE, WHICH IS WHAT MAKES IT WORSE THAN A LOUD ONE.
   * `#buildPhase`'s stage-A arm guarded on `after.directions.length > 0 &&
   * after.chosenDirection === null` and did NOT test `expandSegment`, while its
   * sibling did — so a pass that ran the EXPAND segment could fall into stage A's
   * park. The route is real: the expansion's manifest is written by the AGENT, and
   * `parseDesignManifest`'s both-or-neither rule drops `chosenDirection` the moment
   * `directionChoice` will not parse.
   *
   * `#parkForDesignLock` merges `awaiting: true` onto the record but never clears
   * `chosenDirection`, so `designLockOf` computes `stage: "expanding"` — the panel
   * renders "your direction is chosen, the rest is being rendered now" while the
   * run sits waiting for a click nobody was asked for.
   *
   * CONTROL: revert `#buildPhase`'s expand arm to `expandSegment && after !== null
   * && after.chosenDirection !== null` and put the stage-A arm back in front of it
   * without `!expandSegment`, and this goes red at `awaiting_input`.
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    expandDrops: "choice",
    // THE FULL WINDOW, DELIBERATELY. A short timeout would let the park's own
    // timer resolve the run and the test would measure the timer rather than the
    // arm: 30 minutes means a run that is still parked when `settle` returns is
    // parked because this arm parked it.
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.equal(h.status(), "awaiting_input", "stage A's park, which is the one this test is NOT about");
    assert.equal(h.orchestrator.resume(h.runId, null, "quiet-grid"), true, "the owner picks a direction");
    await h.waitFor(() => h.status() !== "awaiting_input", 30_000, "the run never left the canvass park");
    await h.settle(60_000);

    // THE CONTROL, FIRST. "It never parked again" is also true of a run that
    // stopped before stage B ever ran, so the segments are asserted before the
    // status is.
    const prompts = h.builderCalls.map((call) => call.prompt);
    assert.equal(prompts.filter((p) => p.includes("STAGE A — CANVASS")).length, 1, "exactly one canvass");
    assert.equal(prompts.filter((p) => p.includes("STAGE B — EXPAND")).length, 1, "and exactly one expansion");

    assert.notEqual(h.status(), "awaiting_input", "the expansion must not re-open the canvass park");
    const record = h.lock();
    assert.equal(record?.awaiting, false, "and nothing on disk may say this run is waiting");
    assert.equal(record?.expanded, true, "the expansion happened, and the record is what says so");
    assert.equal(record?.chosenDirection, "quiet-grid", "the direction he clicked is the one carried forward");
    assert.ok(
      prompts.some((p) => !p.startsWith("DESIGN LANE — art direction")),
      "and the BUILD segment ran rather than the run stalling on a park nobody answered",
    );

    /*
     * AND THE REPAIR IS SAID OUT LOUD, WITH ITS SOURCE. Recording `expanded: true`
     * over a choice-less manifest is not on its own enough to make the run
     * terminate: `nextBuildSegment` reads `directionChosen` off the MANIFEST, so
     * leaving it null sends the run to `design-resume` and the CANVASS re-runs.
     * The choice has to go back on the file, and an owner reading the log has to
     * be able to tell a restored choice from one he made.
     */
    const lines = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      lines.some((text) => text.includes("its own write dropped the choice")),
      `the dropped choice must be named, not silently repaired: ${JSON.stringify(lines.slice(-6))}`,
    );
    assert.ok(
      lines.some((text) => text.includes("restored from this run's own design-lock record")),
      "and the source of the restored direction is on the record, so it is not read as a fresh judgement",
    );
    assert.equal(
      readDesignManifest(runPathsFor(h.paths, h.runId).workspace)?.chosenDirection,
      "quiet-grid",
      "the MANIFEST carries it too — `nextBuildSegment` reads that file, not the record",
    );

    /*
     * AND THE BUILD SEES ONE DESIGN, NOT THREE. MEASURED: with the restore removed
     * this run still LOCKS its hero (`refsForDirection` filters on `ref.direction`,
     * not on `chosenDirection`) and still terminates, so every assertion above
     * except the two log lines goes on passing — but `builtManifest` and
     * `refsForStage` DO filter on `chosenDirection`, so a manifest left choice-less
     * hands the build agent nine stills of three incompatible designs and tells it
     * to build to "it". This is the assertion that catches that.
     */
    const build = prompts.find((prompt) => !prompt.startsWith("DESIGN LANE — art direction")) ?? "";
    assert.ok(build.includes("quiet-grid"), "the chosen direction's stills cross the handoff");
    assert.ok(!build.includes("editorial-slab"), "and a direction nobody chose never reaches the build");
    assert.ok(!build.includes("warm-stack"));
  } finally {
    await h.cleanup();
  }
});

test("FINDING P: A CANCELLED RUN DOES NOT KEEP AN ARMED DESIGN TIMER", async () => {
  /*
   * `cancel()` cleared `#plan.clearTimer` ALONE. `#clearDesignLockTimer` had three
   * call sites — `resume`, `shutdown`, `#parkForDesignLock` — and `cancel` was not
   * among them, and nothing on the cancel path wrote `awaiting: false`. A parked
   * run has `#active === null`, so cancel takes the `#finish` branch and never
   * touches the design timer.
   *
   * THE SCENARIO: the owner cancels a run parked on a canvass. Up to thirty
   * minutes later the timer fires and writes "no design choice arrived before the
   * timeout; selecting automatically" onto the CANCELLED run at warn level, then
   * calls `resume`, which refuses because the row is terminal — so nothing is
   * selected and the sentence is false. `design-lock.json` keeps `awaiting: true`
   * for ever.
   *
   * CONTROL: remove the `#clearDesignLockTimer(runId)` line from `cancel()` and the
   * timeout sentence reappears on the cancelled run; remove the park close and
   * `awaiting` stays true.
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    // 0.01 min = 600ms. The park must be able to OUTLIVE the cancel inside this
    // test, or "the timer never fired" is a statement about the test's runtime.
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0.01" },
  });
  try {
    assert.equal(h.status(), "awaiting_input", "the run is parked on the canvass");
    assert.equal(h.lock()?.awaiting, true, "with an open park on disk");
    assert.equal(h.orchestrator.cancel(h.runId), true, "the owner cancels it");
    assert.equal(h.status(), "cancelled");

    // PAST THE DEADLINE, MEASURED RATHER THAN ASSUMED. 600ms is the whole window,
    // so a timer still armed has fired by the time this resolves.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const lines = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      !lines.some((text) => text.includes("no design choice arrived before the timeout")),
      `a cancelled run must not be told a choice is being made for it: ${JSON.stringify(lines)}`,
    );
    assert.equal(h.lock()?.awaiting, false, "and the park record is closed, not left saying the run waits");
    assert.equal(h.status(), "cancelled", "the cancel still stands");

    /*
     * THE SHAPE THE CANCEL LEAVES ON THE WIRE, PINNED HERE RATHER THAN GUESSED AT.
     * `designLockOf` derives `stage` from `directions`/`chosenDirection`/`expanded`
     * and puts `awaiting` beside it ungated, so a cancelled canvass park publishes
     * `{stage: "canvass", awaiting: false}` — a pair the contract already admits
     * (api.test.ts pins stage over exactly those three fields and never over
     * `awaiting`) and one the panel previously only saw in passing. The directions
     * survive because `#closeDesignParkOnCancel` passes no manifest and
     * `#mergeDesignLock` keeps `base.directions` in that case.
     */
    const server = await h.serve();
    try {
      const detail = (await (await fetch(`${server.base}/api/runs/${h.runId}`)).json()) as RunDetail;
      assert.equal(detail.designLock?.awaiting, false, "the wire says the park is over");
      assert.equal(detail.designLock?.stage, "canvass", "and still says which stage the run stopped in");
      assert.equal(detail.designLock?.directions.length, 3, "what was offered is not erased by the cancel");
      assert.equal(detail.designLock?.locked, null, "nothing was chosen and nothing is claimed to be");
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("FINDING Q: A DESIGN SEGMENT THAT RETURNS NO READABLE MANIFEST SAYS SO", async () => {
  /*
   * `#buildPhase`'s post-segment arms ALL required `after !== null` and there was
   * no else. On a FULL lane the hole is loud — `classifyDesignLane` returns
   * `no-manifest` and an error line is emitted — but on a DEGRADED lane
   * `design-outcome.ts` returns `failure: null` with a detail saying the lane ran
   * fine, so NOTHING was logged at all.
   *
   * THE SCENARIO: a degraded `ask` run's canvass writes its three
   * `direction-<slug>.md` documents and no manifest. `after` is null, no arm fires,
   * no park opens, nothing is written; `nextBuildSegment` then sees
   * `manifestExists: false` with `designSegmentDone: true` and goes straight to
   * build-resume. The owner is never asked which direction to build and the run log
   * says nothing at all.
   *
   * CONTROL: delete the `no-manifest` arm and this goes red on the log assertion
   * while every other assertion here still passes — which is exactly how the hole
   * survived four rounds.
   */
  const h = await designRun({
    designLock: "ask",
    interactive: true,
    noKey: true,
    emptyRefs: "canvass",
    writeManifest: false,
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    await h.settle(60_000);
    // THE CONTROLS. The lane RAN and it ran DEGRADED — the two facts that make the
    // silence a defect rather than an absence of anything to say.
    assert.ok(String(h.builderCalls[0]?.prompt).startsWith("DESIGN LANE"), "the design segment ran");
    const lane = readDesignLaneRecord(runPathsFor(h.paths, h.runId).results);
    assert.equal(lane?.mode, "degraded", "and degraded, where the lane record reports no failure at all");
    assert.equal(lane?.failure, null, "which is why nothing else on this path can speak");
    assert.equal(readDesignManifest(runPathsFor(h.paths, h.runId).workspace), null, "and there is no manifest");

    const lines = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log" && (event.level === "warn" || event.level === "error"))
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      lines.some((text) => text.includes("could not be read")),
      `an unreadable manifest must be named on the run log: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((text) => text.includes("is not asked")),
      `and an ASK run that cannot ask must say the owner is not asked: ${JSON.stringify(lines)}`,
    );
  } finally {
    await h.cleanup();
  }
});

/**
 * A manifest in exactly the shape a given (state) row needs, and nothing else.
 *
 * HAND-BUILT RATHER THAN ROUND-TRIPPED THROUGH `parseDesignManifest`, because the
 * table below has to name states the PARSER guarantees are impossible in order to
 * say they are impossible — and a builder that went through the parser could only
 * produce the states the parser already allows.
 */
function tableManifest(input: {
  readonly directions?: readonly string[];
  readonly chosen?: string | null;
  readonly locked?: string | null;
  /** A stage-B still (`origin: "expansion"`) naming this direction. */
  readonly drewFor?: string | null;
}): DesignManifest {
  const at = "2026-08-03T00:00:00.000Z";
  const locked = input.locked ?? null;
  const chosen = input.chosen ?? null;
  const drewFor = input.drewFor ?? null;
  const refs: DesignRef[] = [];
  if (locked !== null) {
    refs.push({ path: locked, section: "hero", aspect: "16:9", intent: "x", direction: chosen, origin: null });
  }
  if (drewFor !== null) {
    refs.push({
      path: `/refs/${drewFor}-03-about.png`,
      section: "about",
      aspect: "16:9",
      intent: "x",
      direction: drewFor,
      origin: "expansion",
    });
  }
  return {
    version: 1,
    refs,
    directions: (input.directions ?? []).map((slug) => ({
      slug,
      name: slug,
      distinction: `what ${slug} does that the others do not`,
      notes: null,
    })),
    chosenDirection: chosen,
    directionChoice: chosen === null ? null : { by: "owner", reason: "he clicked it", at },
    lockedMockup: locked,
    lockedBy: locked === null ? null : "owner",
    lockedReason: locked === null ? null : "the strongest hero of the set",
    lockedAt: locked === null ? null : at,
  };
}

test("THE POST-SEGMENT TABLE IS CLOSED: every (STAGE × STATE) pair has exactly one arm", () => {
  /*
   * WHAT ROUNDS 2, 3 AND 4 EACH MISSED, MEASURED AS A TABLE INSTEAD OF AS A RUN.
   * `#buildPhase`'s arms can only be exercised one pair per real run — each one
   * spawns builder segments and a sealed gate — so a per-arm proof through
   * `designRun` is a proof nobody will keep running, and the arms drifted for
   * three rounds underneath tests that each drove one input.
   *
   * THE STAGE IS HALF THE KEY, AND THAT IS FINDING O. A table over the six
   * manifest states alone would have passed on every round-4 build while the
   * stage-A arm was being entered by EXPAND returns.
   */
  const canvassStills = "/refs/quiet-grid-01-hero.png";
  const rows: readonly {
    readonly state: string;
    readonly manifest: DesignManifest | null;
    readonly onCanvass: DesignPostSegmentAction["kind"];
    readonly onExpand: DesignPostSegmentAction["kind"];
  }[] = [
    { state: "1. unreadable or absent", manifest: null, onCanvass: "no-manifest", onExpand: "no-manifest" },
    {
      state: "2. directions, no choice",
      manifest: tableManifest({ directions: ["a", "b"] }),
      onCanvass: "canvass-choice",
      onExpand: "expand",
    },
    {
      state: "3. directions, a choice, no lock",
      manifest: tableManifest({ directions: ["a", "b"], chosen: "a" }),
      onCanvass: "settled",
      onExpand: "expand",
    },
    {
      state: "4. directions, a choice, a lock",
      manifest: tableManifest({ directions: ["a", "b"], chosen: "a", locked: canvassStills }),
      onCanvass: "settled",
      onExpand: "expand",
    },
    { state: "5. no directions, no lock", manifest: tableManifest({}), onCanvass: "mockup-choice", onExpand: "expand" },
    {
      state: "6. no directions, a lock",
      manifest: tableManifest({ locked: canvassStills }),
      onCanvass: "settled",
      onExpand: "expand",
    },
  ];

  const produced = new Set<string>();
  for (const row of rows) {
    for (const expandSegment of [false, true]) {
      const action = designPostSegmentAction({ expandSegment, manifest: row.manifest, recordedDirection: null });
      const expected = expandSegment ? row.onExpand : row.onCanvass;
      assert.equal(
        action.kind,
        expected,
        `${row.state} on the ${expandSegment ? "EXPAND" : "CANVASS"} pass must reach ${expected}`,
      );
      produced.add(action.kind);
      // FINDING O AS A PROPERTY RATHER THAN AS ONE ROW: no expand return may reach
      // either arm that can open a park. The parks belong to the stages whose
      // questions they are, and stage B's question was answered before it ran.
      if (expandSegment) {
        assert.notEqual(action.kind, "canvass-choice", `${row.state} must not re-open stage A's park`);
        assert.notEqual(action.kind, "mockup-choice", `${row.state} must not open the mockup park after stage B`);
      }
    }
  }

  // THE CONTROL ON THE TABLE ITSELF. Five kinds, five arms: a kind no row produces
  // is an arm no row proves, and a table that quietly stopped producing one would
  // otherwise go on passing.
  assert.deepEqual(
    [...produced].sort(),
    ["canvass-choice", "expand", "mockup-choice", "no-manifest", "settled"],
    "every arm of the union is reached by this table",
  );

  // THE SEVENTH STATE THE PARSER MAKES UNCONSTRUCTIBLE, stated so the count of six
  // is a claim and not an assumption: `parseDesignManifest` drops a chosen slug
  // that is not one of the declared directions (design-manifest.ts:582), so
  // `directions.length === 0 && chosenDirection !== null` cannot be read off disk.
  assert.equal(
    parseDesignManifest(
      JSON.stringify({
        version: 1,
        refs: [],
        directions: [],
        chosenDirection: "a",
        directionChoice: { by: "owner", reason: "r", at: "2026-08-03T00:00:00.000Z" },
      }),
      "/nowhere",
    )?.chosenDirection,
    null,
    "a chosen slug with no declared directions does not survive the parser",
  );
});

test("THE EXPANDED DIRECTION IS RESOLVED IN ONE ORDER: manifest, record, what was drawn, then order", () => {
  /*
   * THE REPAIR'S OWN LADDER, WHICH IS THE HALF OF FINDING O THAT DECIDES WHETHER
   * THE RUN TERMINATES. Recording `expanded: true` over a choice-less manifest is
   * not enough on its own: `nextBuildSegment` reads `directionChosen` off the
   * MANIFEST, so `directionsOffered && !directionChosen` sends the run back to
   * `design-resume` — the canvass re-runs, six more generations no cap counts, and
   * the pass bound is gone before the build segment. The choice has to go back on
   * the file, and where it comes from has to be honest.
   */
  const drew = tableManifest({ directions: ["a", "b", "c"], drewFor: "b" });

  assert.deepEqual(
    designPostSegmentAction({
      expandSegment: true,
      manifest: tableManifest({ directions: ["a", "b"], chosen: "b" }),
      recordedDirection: "a",
    }),
    {
      kind: "expand",
      manifest: tableManifest({ directions: ["a", "b"], chosen: "b" }),
      direction: { slug: "b", source: "manifest" },
    },
    "the manifest is the source of truth and the record never overrides it",
  );

  const fromRecord = designPostSegmentAction({ expandSegment: true, manifest: drew, recordedDirection: "a" });
  assert.deepEqual(
    fromRecord.kind === "expand" ? fromRecord.direction : null,
    { slug: "a", source: "record" },
    "the host's own record beats the stills, because the host is what applied the choice",
  );

  const fromStills = designPostSegmentAction({ expandSegment: true, manifest: drew, recordedDirection: null });
  assert.deepEqual(
    fromStills.kind === "expand" ? fromStills.direction : null,
    { slug: "b", source: "expansion" },
    "with no record, the direction the expansion DREW is the run's own receipt for the spend",
  );

  // AN UNDECLARED RECORDED SLUG IS NOT HONOURED. `chooseDirection` would refuse it
  // and the repair would leave the manifest choice-less — so the ladder has to
  // skip it here rather than hand it on and log a refusal.
  const bogus = designPostSegmentAction({ expandSegment: true, manifest: drew, recordedDirection: "not-a-slug" });
  assert.deepEqual(
    bogus.kind === "expand" ? bogus.direction : null,
    { slug: "b", source: "expansion" },
    "a recorded slug the manifest never declared is skipped, not passed on to be refused",
  );

  const noneLeft = designPostSegmentAction({
    expandSegment: true,
    manifest: tableManifest({ directions: ["a", "b"] }),
    recordedDirection: null,
  });
  assert.deepEqual(
    noneLeft.kind === "expand" ? noneLeft.direction : null,
    { slug: "a", source: "fallback" },
    "and last the first in manifest order, the same fallback the auto arm and the park's timer take",
  );

  // NOTHING TO BE WRONG ABOUT: no directions at all is the one shape with no
  // direction to resolve, and it must report that rather than invent one.
  const nothing = designPostSegmentAction({
    expandSegment: true,
    manifest: tableManifest({}),
    recordedDirection: "a",
  });
  assert.equal(nothing.kind === "expand" ? nothing.direction : "wrong-kind", null);
});

test("FINDING O, THE OTHER HALF: AN EXPANSION THAT LOSES THE DIRECTIONS TOO STILL FINISHES", async () => {
  /*
   * THE ARM THE TABLE NAMES AND NO RUN REACHED. States 5 and 6 (no directions)
   * on the EXPAND pass resolve to `expand` with `direction: null`, and before this
   * round they fell into the MOCKUP arm instead — which for an `ask` policy called
   * `#parkForDesignLock` and returned `{kind: "parked"}`. So the old code answered
   * a lost canvass by opening a SECOND park, for a mockup, after the expansion had
   * already been paid for; the new code records the expansion as done and goes on.
   * Asserting that only in the pure table would be asserting the decision and not
   * the arm.
   *
   * CONTROL: delete the `chosen === null` branch from `#buildPhase`'s expand arm
   * and this throws on `heroRefFor(expanded, chosen.slug)` with `chosen` null —
   * the compiler catches that one, which is the point of carrying `direction` as
   * a single nullable field rather than as two.
   */
  const h = await designRun({
    designLock: "ask",
    directions: true,
    interactive: true,
    expandDrops: "directions",
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "30" },
  });
  try {
    assert.equal(h.status(), "awaiting_input", "stage A's park");
    assert.equal(h.orchestrator.resume(h.runId, null, "quiet-grid"), true, "the owner picks a direction");
    await h.waitFor(() => h.status() !== "awaiting_input", 30_000, "the run never left the canvass park");
    await h.settle(60_000);

    const prompts = h.builderCalls.map((call) => call.prompt);
    assert.equal(prompts.filter((p) => p.includes("STAGE B — EXPAND")).length, 1, "the expansion ran");
    assert.notEqual(h.status(), "awaiting_input", "and no second park was opened after it");
    assert.equal(
      readDesignManifest(runPathsFor(h.paths, h.runId).workspace)?.directions.length,
      0,
      "the manifest really did come back with its directions gone",
    );
    assert.equal(h.lock()?.expanded, true, "the expansion is recorded as done so the run is not sent round it again");
    assert.equal(h.lock()?.awaiting, false, "and nothing on disk says the run is waiting");
    const lines = h.store
      .eventsSince(h.runId, 0)
      .map((stored) => stored.event)
      .filter((event) => event.type === "log" && event.level === "warn")
      .map((event) => (event.type === "log" ? event.text : ""));
    assert.ok(
      lines.some((text) => text.includes("names no directions at all")),
      `the case must be named rather than passed over: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      prompts.some((p) => !p.startsWith("DESIGN LANE — art direction")),
      "and the BUILD segment ran",
    );
  } finally {
    await h.cleanup();
  }
});

/* =========================================================================
 * AUTO-RECOVERY — a run that continues ITSELF
 *
 * WHAT THESE ARE WATCHING FOR, and it is not "did the retry work". This feature
 * spends the owner's subscription while nobody is present, so the failure to
 * fear is not a run that gives up too early — he can press Resume — but a run
 * that re-enters a fifty-minute phase for ever with nothing counting. Every test
 * below therefore asserts a NUMBER as well as a state: the automatic budget the
 * run charged, and the attempts it recorded. A check that can only observe a
 * successful continuation is exactly the defect this repository keeps finding.
 *
 * NOT ONE OF THEM MAKES A METERED CALL. The refusal comes from `FakeBuilder`'s
 * `limitCalls`, the reported window is one second, and the suite is hand-frozen
 * so `#specPhase` reuses it instead of authoring against the subscription.
 * ====================================================================== */

/** Every log line a run emitted, in order. */
function runLog(h: DesignHarness): readonly string[] {
  return h.store
    .eventsSince(h.runId, 0)
    .map((stored) => stored.event)
    .filter((event) => event.type === "log")
    .map((event) => (event.type === "log" ? event.text : ""));
}

test("A REFUSED RUN CONTINUES ITSELF, reaches a later phase, and CHARGES ITS BUDGET", async () => {
  // The first build call comes back refused with a one-second window; nothing in
  // this test calls `resume()`, presses anything, or answers anything.
  const h = await designRun({
    autoStart: false,
    env: { DASHBOARD_AUTO_RECOVER: "1" },
    limitCalls: [0],
    limitRetryAfterSec: 1,
  });
  try {
    h.orchestrator.pump();
    await h.waitFor(() => h.status() === "rate_limited", 20_000, "the refusal never parked the run");
    // NOT TERMINAL. This is the whole reason 52 minutes and 12 hours of real
    // work were lost: `#finish("failed")` makes `isTerminal` true and `resume()`
    // refuses outright, so a recoverable failure that passes through a terminal
    // status can never come back.
    assert.equal(isTerminal("rate_limited" as never), false, "the fixture's premise");

    await h.settle(30_000);

    const row = h.store.getRun(h.runId);
    assert.ok(row !== null);
    assert.ok(isTerminal(row.status), `the run continued to a verdict: ${row.status}`);
    // THE BUDGET MOVED, AND THIS IS THE ASSERTION THE WHOLE CAP RESTS ON. A cap
    // enforced against a counter nothing increments is dead code, and the run
    // would continue itself without bound.
    assert.equal(row.autoContinueCount, 1, "exactly one continuation was charged to the automatic budget");
    assert.equal(row.resumeCount, 1, "and it is a re-entry, so the owner-facing total moved too");

    const attempts = h.store.listAttempts(h.runId);
    assert.equal(attempts.length, 2, `two entries into the pipeline, recorded: ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0]?.endClass, "throttled", "the first attempt says WHY it ended");
    assert.equal(attempts[1]?.endClass, "completed");
    // THE EXPENSIVE WORK RAN ONCE. `#specPhase`'s reuse branch is the difference
    // between a continuation and a restart, and the column is written from the
    // branch actually taken rather than folded out of a log line.
    assert.equal(attempts[0]?.suiteSource, "reused");
    assert.equal(attempts[1]?.suiteSource, "reused", "the continuation did NOT re-author the suite");
    assert.ok(
      runLog(h).some((text) => /this run took 2 attempt\(s\)/.test(text)),
      `a recovered run must not present as a clean pass: ${JSON.stringify(runLog(h).slice(-4))}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("THE WAIT IS SERVED, not skipped — the run is still parked while the window runs", async () => {
  const h = await designRun({
    autoStart: false,
    env: { DASHBOARD_AUTO_RECOVER: "1" },
    limitCalls: [0],
    limitRetryAfterSec: 3,
  });
  try {
    h.orchestrator.pump();
    await h.waitFor(() => h.status() === "rate_limited", 20_000, "the refusal never parked the run");
    const armed = runLog(h).filter((text) => /automatic resume armed/i.test(text));
    assert.equal(armed.length, 1, "exactly one arm, announced with the instant it fires");
    assert.match(String(armed[0]), /2026|20\d\d-/, "the announcement carries an INSTANT, not a duration");

    // HALF A SECOND INTO A THREE-SECOND WINDOW. An implementation that armed a
    // zero-length wait — or clamped an unrepresentable one to "fire now" — would
    // already have requeued this run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(h.status(), "rate_limited", "the reported window has not elapsed, so nothing may continue yet");
    assert.equal(h.store.getRun(h.runId)?.autoContinueCount, 1, "the charge happens when the arm is decided");

    await h.settle(40_000);
    assert.ok(isTerminal(h.store.getRun(h.runId)?.status ?? "queued"), "and then it continued by itself");
    // AND THE LEDGER MEASURED THE SAME WAIT. `waitedSec` is computed from the
    // previous attempt's own `ended_at`, so it counts wall-clock time whether it
    // was served by a timer or by a server that was down for it — and a "wait 0"
    // implementation records a 0 here while every status assertion above it can
    // still be made to pass by a fast enough machine.
    const attempts = h.store.listAttempts(h.runId);
    assert.equal(attempts.length, 2);
    assert.ok(
      (attempts[1]?.waitedSec ?? -1) >= 2,
      `the continuation waited out the reported window: ${JSON.stringify(attempts[1])}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("A RUN AT ITS CAP PARKS AND ARMS NOTHING — driven through the refusal, not the policy's arguments", async () => {
  const h = await designRun({
    autoStart: false,
    env: { DASHBOARD_AUTO_RECOVER: "1" },
    limitCalls: [0],
    limitRetryAfterSec: 1,
  });
  try {
    // Already at the cap. This is the state three continuations leave behind,
    // and the only thing that must happen next is a park with a sentence.
    h.store.updateRun(h.runId, { autoContinueCount: AUTO_CONTINUE_MAX });
    h.orchestrator.pump();
    await h.waitFor(() => h.status() === "rate_limited", 20_000, "the refusal never parked the run");

    // THE WINDOW IS ONE SECOND. A run that was going to continue would have done
    // so well inside this.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const row = h.store.getRun(h.runId);
    assert.equal(row?.status, "rate_limited", "at the cap, nothing picks the run up again");
    assert.equal(row?.autoContinueCount, AUTO_CONTINUE_MAX, "and nothing was charged for a continuation that did not happen");
    const said = runLog(h);
    assert.ok(
      said.some((text) => /no automatic resume is armed.*continued itself/is.test(text)),
      `the refusal has to say why, on the run's own log: ${JSON.stringify(said.slice(-3))}`,
    );
    assert.ok(
      !said.some((text) => /automatic resume armed:/i.test(text)),
      "nothing may be armed at the cap",
    );
  } finally {
    await h.cleanup();
  }
});

test("A CANCEL DURING AN ARMED WAIT WINS IMMEDIATELY, and the timer says nothing afterwards", async () => {
  const h = await designRun({
    autoStart: false,
    env: { DASHBOARD_AUTO_RECOVER: "1" },
    limitCalls: [0],
    limitRetryAfterSec: 1,
  });
  try {
    h.orchestrator.pump();
    await h.waitFor(() => h.status() === "rate_limited", 20_000, "the refusal never parked the run");
    assert.ok(runLog(h).some((text) => /automatic resume armed/i.test(text)), "the fixture must have armed one");

    assert.equal(h.orchestrator.cancel(h.runId), true);
    assert.equal(h.status(), "cancelled", "a cancel is immediate; it does not wait out the window");

    // PAST THE INSTANT THE TIMER WOULD HAVE FIRED. Before `cancel` disarmed it,
    // that timer wrote "the reported rate-limit window has elapsed; resuming
    // automatically" onto a CANCELLED run and then called `resume()`, which
    // refuses a terminal row — so nothing resumed and the sentence was false.
    await new Promise((resolve) => setTimeout(resolve, 1_400));

    assert.equal(h.status(), "cancelled", "nothing picked the cancelled run up");
    assert.ok(
      !runLog(h).some((text) => /window has elapsed; resuming automatically/i.test(text)),
      `a disarmed timer says nothing: ${JSON.stringify(runLog(h).slice(-3))}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("AN INTERRUPTED RUN CONTINUES AT BOOT — three times, and the fourth boot says why not", async () => {
  const h = await designRun({ autoStart: false, env: { DASHBOARD_AUTO_RECOVER: "1" } });
  try {
    // `shutdown()` first, on this file's own convention: `#stopped` neuters
    // `pump()` alone, so every transition under test still happens and asserts
    // while no builder is ever spawned.
    await h.orchestrator.shutdown();

    for (let boot = 1; boot <= AUTO_CONTINUE_MAX; boot += 1) {
      // The state a dead process leaves behind: a row that says `running` with
      // nothing running. `#abandonedForShutdown` writes no terminal state for
      // exactly this reason.
      h.store.updateRun(h.runId, { status: "running" });
      h.orchestrator.reconcileOnBoot();
      const row = h.store.getRun(h.runId);
      assert.equal(row?.status, "queued", `boot ${String(boot)}: nothing was wrong with the run`);
      assert.equal(row?.autoContinueCount, boot, `boot ${String(boot)}: the crash-loop brake moved`);
    }

    // THE FOURTH. boot -> queue -> start -> crash -> the process dies -> the
    // supervisor restarts -> boot is a loop with no other brake, and this is it.
    h.store.updateRun(h.runId, { status: "running" });
    h.orchestrator.reconcileOnBoot();
    const row = h.store.getRun(h.runId);
    assert.equal(row?.status, "awaiting_input", "at the cap a human takes over");
    assert.equal(row?.autoContinueCount, AUTO_CONTINUE_MAX, "and the refusal charges nothing");
    assert.ok(
      runLog(h).some((text) => /Nothing will do it by itself.*continued itself/is.test(text)),
      `the run has to say who resumes it now: ${JSON.stringify(runLog(h).slice(-2))}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("WITH THE FLAG OFF, an interrupted run waits for a human exactly as it always did", async () => {
  const h = await designRun({ autoStart: false });
  try {
    await h.orchestrator.shutdown();
    h.store.updateRun(h.runId, { status: "running" });

    h.orchestrator.reconcileOnBoot();

    const row = h.store.getRun(h.runId);
    // THE DISCRIMINATING ASSERTION IS THE COUNTER, not the status. With the flag
    // on, this same row is requeued and charged; "awaiting_input with a budget
    // still at zero" is a state the enabled sweep could not have produced.
    assert.equal(row?.status, "awaiting_input", "the default install spends nothing unattended");
    assert.equal(row?.autoContinueCount, 0);
    assert.ok(
      runLog(h).some((text) => /automatic recovery is opt-in and is off/i.test(text)),
      `and it names the switch: ${JSON.stringify(runLog(h))}`,
    );
  } finally {
    await h.cleanup();
  }
});
