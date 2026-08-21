/**
 * supervisor-route.test.ts — THE OWNER'S START/STOP SWITCH, AND ITS ARM CHECK.
 *
 * Four routes over a real loopback server, a real `RunStore` and the real
 * supervisor tables. The only stub is the LOOP — a one-method `tick()` recorder
 * — for the same reason the orchestrator is a stub in `api.test.ts`: the thing
 * under test is the CONTROL SURFACE. What the wire says, what it refuses, and
 * what it writes to the durable state. Not what the loop then does about it.
 *
 * EVERY CHECK HERE HAS TWO ARMS, AND THAT IS NOT DECORATION. This component is
 * the worst possible shape for a one-armed test:
 *
 *   · a status route's failure mode is "renders something plausible", so
 *     asserting 200-and-a-body is satisfied by a constant;
 *   · a drain-stop and an abort-stop BOTH leave `desired` changed, so asserting
 *     the state moved cannot tell the safe one from the destructive one — the
 *     stop test therefore asserts that nothing was cancelled;
 *   · a quiet clock that counts telemetry as progress reports a healthy run for
 *     ever, so the exclusion is tested against a run whose only frames ARE
 *     telemetry, with a positive control beside it.
 *
 * WHAT IT DOES NOT COVER: whether the loop behind `tick()` claims, submits or
 * settles correctly. That is `supervisor.test.ts` and another lane. This one
 * proves the switch is connected to the right wire, writes the right row, and
 * says so honestly when it is connected to nothing.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApiSupervisorCommandResponse,
  ApiSupervisorState,
  ApiSupervisorTicketFiled,
  ApiSupervisorTicketsResponse,
} from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { GateProbe } from "./health-gate.js";
import {
  LOOPBACK_HOST,
  SUPERVISOR_NO_NEXT_ACTION,
  SUPERVISOR_NOT_WIRED,
  armSupervisorRoute,
  composeSupervisorState,
  createDashboardServer,
  ticketAttachmentRoot,
} from "./http.js";
import type { RunController, SupervisorComposerInput, SupervisorController } from "./http.js";
import { CATALOG_FALLBACK_MODEL_ID, CODEX_DEFAULT_MODEL_ID, ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { SupervisorLoop } from "./supervisor.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import {
  CAPTURE_BLOCK_BEGIN,
  documentDirFor,
  manifestDocuments,
  manifestMotion,
  readReferenceManifest,
  referenceDirFor,
  writeReferenceManifest,
} from "./ticket-refs.js";
import { ticketWithReferences } from "./ticket.js";
import type { SiteCapture } from "./site-capture.js";
import type { MotionReading } from "./motion-types.js";

const NO_MODELS: readonly ModelInfo[] = [];
const DASHBOARD_OWNER_ORIGIN = `http://${LOOPBACK_HOST}:4319`;

function ownerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("Origin", DASHBOARD_OWNER_ORIGIN);
  return globalThis.fetch(url, { ...init, headers });
}

interface SupervisorCalls {
  /** Every `tick()` the router asked for. START nudges; nothing else may. */
  ticks: number;
  readonly cancelled: string[];
}

interface Harness {
  readonly base: string;
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  readonly calls: SupervisorCalls;
  /** Which URLs the two capture seams were asked for. Empty is an assertion. */
  readonly captures: CaptureCalls;
  close(): Promise<void>;
}

/**
 * @param wired false builds the server with NO loop — the third state the
 * surface has to be able to show, and the one a 503 on the GET would have
 * hidden behind "the dashboard is down".
 */
/**
 * The two capture seams, stubbed by default so no routing test can launch a
 * browser.
 *
 * THE DEFAULT IS A REFUSAL WITH A COUNTER, NOT AN ABSENT SEAM. `POST
 * /api/supervisor/tickets` now scans the brief for a URL exactly as `POST
 * /api/runs` does, so a test brief that happens to name a page would launch real
 * chromium against the real network from a routing test. Counting the calls also
 * gives the capture tests below their negative control: a brief with no URL must
 * leave `sites` at zero, which is the arm a "did it capture" assertion cannot
 * provide.
 */
interface CaptureCalls {
  readonly sites: string[];
  readonly motions: string[];
}

interface HarnessOptions {
  /** Return a capture for this URL, or `null` to refuse it. */
  readonly capture?: (url: string) => SiteCapture | null;
  /** Return a reading for this URL, or `null` to refuse it. */
  readonly motion?: (url: string) => MotionReading | null;
}

async function startHarness(wired: boolean, options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-supervisor-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({
    claudeBin: join(dir, "absent-claude"),
    codexBin: join(dir, "absent-codex"),
    env: process.env,
  });
  const catalog = new ModelCatalog(auth, {}, async () => NO_MODELS);
  const calls: SupervisorCalls = { ticks: 0, cancelled: [] };

  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: (runId) => {
      calls.cancelled.push(runId);
      return true;
    },
    resume: () => false,
    pushLiveMessage: () => false,
  };
  const supervisor: SupervisorController = {
    tick: () => {
      calls.ticks += 1;
    },
  };

  const captures: CaptureCalls = { sites: [], motions: [] };
  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    // Never spawn docker from a routing test; see `api.test.ts`.
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
    // NEVER THE REAL BROWSER. See {@link CaptureCalls}.
    captureSite: (o) => {
      captures.sites.push(o.url);
      const capture = options.capture?.(o.url) ?? null;
      return Promise.resolve(
        capture === null ? { ok: false, reason: "no capture stub in this test" } : { ok: true, capture },
      );
    },
    captureMotion: (o) => {
      captures.motions.push(o.url);
      const reading = options.motion?.(o.url) ?? null;
      return Promise.resolve(
        reading === null ? { ok: false, reason: "no motion stub in this test" } : { ok: true, reading },
      );
    },
    // `exactOptionalPropertyTypes` is on, so the unwired server OMITS the key
    // rather than passing `undefined` — which is also production's shape.
    ...(wired ? { supervisor } : {}),
  });
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    paths,
    calls,
    captures,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedRun(store: RunStore, runId: string, startedAt: string): void {
  store.createRun({
    runId,
    ticketId: "t-portfolio",
    ticketTitle: "the portfolio site",
    ticketText: "build the portfolio site",
    ticketSha256: "0".repeat(64),
    modelId: "opus[1m]",
    provider: "anthropic",
    deploy: false,
    startedAt,
    queuePosition: 0,
  });
}

/** The in-flight ticket, as the supervisor would have left it mid-run. */
function seedActiveTicket(store: RunStore, runId: string | null): void {
  store.enqueueSupervisorTicket({
    ticketKey: "t-portfolio",
    ticketText: "# The portfolio site\n\nBuild it.",
    modelId: "opus[1m]",
    nextAction: "waiting for the spec phase to reach a verdict",
  });
  store.updateSupervisorTicket("t-portfolio", { state: "running", attemptNo: 2, currentRunId: runId });
}

const COMPOSER_INPUT: SupervisorComposerInput = {
  state: { desired: "stopped", changedAt: "2026-08-10T00:00:00.000Z", changedBy: "boot", reason: "seed" },
  activeTicket: null,
  run: null,
  quietForMs: null,
  queueDepth: 0,
  ticketsSeen: 0,
  queuedRuns: 0,
  runsSeen: 0,
  eventsSeen: 0,
  wired: true,
  armed: true,
  armNote: "arming",
  at: "2026-08-10T00:00:00.000Z",
};

test("GET /api/supervisor reports the machine state, and the three surfaces differ", async () => {
  const wired = await startHarness(true);
  const unwired = await startHarness(false);
  try {
    wired.store.setSupervisorState("running", "owner", "the owner pressed START");
    seedRun(wired.store, "run-1", "2026-08-10T03:20:00.000Z");
    wired.store.updateRun("run-1", { status: "running", phase: "spec" });
    seedActiveTicket(wired.store, "run-1");
    // A second run the OWNER queued from the page. STOP does not touch it, so it
    // has to be a separate number from the supervisor's own backlog.
    seedRun(wired.store, "run-2", "2026-08-10T03:25:00.000Z");

    const running = (await (await ownerFetch(`${wired.base}/api/supervisor`)).json()) as ApiSupervisorState;
    assert.equal(running.desired, "running");
    assert.equal(running.changedBy, "owner");
    assert.equal(running.reason, "the owner pressed START");
    assert.ok(Date.parse(running.at) > 0, "the server states its own clock, or the strip cannot spot a stale read");
    assert.equal(running.ticket?.ticketKey, "t-portfolio");
    assert.equal(running.ticket?.title, "The portfolio site", "the title comes off the brief's first heading");
    assert.equal(running.ticket?.attemptNo, 2, "attempt N of M comes from supervisor_tickets, never run_attempts");
    assert.equal(running.ticket?.maxAttempts, 3);
    assert.equal(running.run?.runId, "run-1");
    assert.equal(running.run?.status, "running", "the run's own status, read from the store");
    assert.equal(running.run?.phase, "spec");
    assert.equal(typeof running.run?.quietForMs, "number");
    assert.equal(running.nextAction, "waiting for the spec phase to reach a verdict");
    assert.equal(running.queueDepth, 0, "the supervisor's backlog");
    assert.equal(running.queuedRuns, 1, "and, separately, the runs queue STOP does not control");
    assert.equal(running.probe.wired, true);
    assert.equal(running.probe.armed, true, "the boot arm check must have found the composer live");
    assert.equal(running.probe.ticketsSeen, 1);
    assert.equal(running.probe.runsSeen, 2);
    // The fields with no producer are NAMED, so an empty attempts list reads as
    // "nobody writes one yet" and not as "nothing happened".
    assert.deepEqual([...running.probe.unsourced].sort(), ["attempts", "lastDefect", "lastRepair"]);
    assert.deepEqual(running.attempts, []);

    // STATE TWO: wired, stopped, nothing queued. The sentence has to be its own.
    wired.store.updateSupervisorTicket("t-portfolio", { state: "done", currentRunId: null });
    wired.store.setSupervisorState("stopped", "owner", "the owner pressed STOP");
    const idle = (await (await ownerFetch(`${wired.base}/api/supervisor`)).json()) as ApiSupervisorState;
    assert.equal(idle.desired, "stopped");
    assert.equal(idle.ticket, null);
    assert.equal(idle.run, null, "no ticket in flight means no run, and no clock");
    assert.match(idle.nextAction, /stopped, and nothing is queued/);
    assert.equal(idle.probe.wired, true);

    // STATE THREE: nothing behind the route at all. 200, NOT 503 — a 503 reads
    // to a client exactly like "the dashboard is down", and this is the one
    // state the owner most needs to be able to tell apart.
    const response = await ownerFetch(`${unwired.base}/api/supervisor`);
    assert.equal(response.status, 200, "an unwired supervisor is an ANSWER, not a transport failure");
    const blind = (await response.json()) as ApiSupervisorState;
    assert.equal(blind.probe.wired, false);
    assert.equal(blind.nextAction, SUPERVISOR_NOT_WIRED);
    assert.equal(blind.probe.armNote, SUPERVISOR_NOT_WIRED);

    // THE ARM: three states, three different bodies. A composer that has gone
    // constant passes every assertion above that names one field.
    const bodies = new Set(
      [running, idle, blind].map((state) => JSON.stringify({ ...state, at: "", probe: { ...state.probe, wired: true } })),
    );
    assert.equal(bodies.size, 3, "the surface must render three DISTINGUISHABLE states");
  } finally {
    await wired.close();
    await unwired.close();
  }
});

test("the quiet clock ignores rate_limit frames, which is why a913c871 looked alive", async () => {
  const harness = await startHarness(true);
  try {
    /* `appendEvent` stamps `at` with the store's own clock, so the past is built
     * from `startedAt` rather than from backdated rows — which is the honest
     * shape of the measured failure anyway: the run had been going 90 minutes
     * and every frame it had produced was telemetry. */
    const now = Date.now();
    seedRun(harness.store, "run-1", new Date(now - 5_400_000).toISOString());
    harness.store.updateRun("run-1", { status: "running", phase: "spec" });
    seedActiveTicket(harness.store, "run-1");

    // Seven `rate_limit` frames and nothing else, exactly as run a913c871
    // recorded across the 84 minutes in which its spec seat produced nothing.
    // `runs.last_event_at` resets on every one of them, which is why the
    // 90-minute silence watch never fired.
    for (let i = 0; i < 7; i += 1) {
      harness.store.appendEvent("run-1", { type: "rate_limit", limited: false, retryAfterSec: null, seat: "spec" });
    }

    const stalled = (await (await ownerFetch(`${harness.base}/api/supervisor`)).json()) as ApiSupervisorState;
    assert.equal(stalled.probe.eventsSeen, 7, "the frames are there — the clock is ignoring them, not missing them");
    assert.ok(
      (stalled.run?.quietForMs ?? 0) > 5_000_000,
      "this run has produced nothing but telemetry since it started 90 minutes ago, so the clock must read " +
        `~5,400,000 ms, not ~0 (read ${String(stalled.run?.quietForMs)})`,
    );

    // THE NEGATIVE CONTROL. A clock that always returns a large number is as
    // useless as one that always returns a small one: one real frame now must
    // reset it.
    harness.store.appendEvent("run-1", { type: "log", level: "info", text: "spec seat — wrote a file" });
    const alive = (await (await ownerFetch(`${harness.base}/api/supervisor`)).json()) as ApiSupervisorState;
    assert.ok(
      (alive.run?.quietForMs ?? 9_999_999) < 60_000,
      `a real frame just landed, so the clock must reset (read ${String(alive.run?.quietForMs)})`,
    );
  } finally {
    await harness.close();
  }
});

test("POST /api/supervisor/stop DRAINS: it writes `draining` and cancels nothing", async () => {
  const harness = await startHarness(true);
  try {
    harness.store.setSupervisorState("running", "owner", "started");
    seedRun(harness.store, "run-1", new Date().toISOString());
    harness.store.updateRun("run-1", { status: "running", phase: "build" });
    seedActiveTicket(harness.store, "run-1");

    const response = await ownerFetch(`${harness.base}/api/supervisor/stop`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as ApiSupervisorCommandResponse;
    assert.equal(body.desired, "draining", "STOP is a drain, and `stopped` would be a lie while a run is live");
    assert.equal(body.changed, true);
    assert.match(body.note, /run-1 runs to its own verdict/);
    assert.equal(body.run?.runId, "run-1", "the command answers with the WHOLE state, as the client is typed for");
    assert.equal(harness.store.readSupervisorState().desired, "draining", "and it is durable, not just reported");

    // THE ARM THAT MATTERS. An implementation that aborted the run would ALSO
    // have moved `desired`, so the assertion above cannot tell drain from abort.
    // A cancelled run is terminal, `resume()` refuses it, and the classifier
    // calls it intentional at bound 0 — an abort here destroys exactly the work
    // the drain exists to preserve.
    assert.deepEqual(harness.calls.cancelled, [], "STOP must not cancel anything");
    assert.equal(harness.store.getRun("run-1")?.status, "running", "the in-flight run is untouched");
    assert.equal(harness.calls.ticks, 0, "and STOP does not nudge a loop it has just told to stop claiming");

    // Idempotent, and it says so rather than reporting a change that did not
    // happen: a strip that flashes "changed" on every click teaches the owner to
    // ignore it.
    const again = (await (
      await ownerFetch(`${harness.base}/api/supervisor/stop`, { method: "POST" })
    ).json()) as ApiSupervisorCommandResponse;
    assert.equal(again.changed, false);
    assert.match(again.note, /already draining/);
  } finally {
    await harness.close();
  }
});

test("POST /api/supervisor/start writes `running` and nudges the loop once", async () => {
  const harness = await startHarness(true);
  try {
    const body = (await (
      await ownerFetch(`${harness.base}/api/supervisor/start`, { method: "POST" })
    ).json()) as ApiSupervisorCommandResponse;
    assert.equal(body.desired, "running");
    assert.equal(body.changed, true);
    assert.equal(harness.store.readSupervisorState().desired, "running");
    assert.equal(harness.store.readSupervisorState().changedBy, "owner");
    // THE NUDGE. Without it the owner waits out the 30 s interval and reads the
    // pause as a dead button.
    assert.equal(harness.calls.ticks, 1);

    // THE NEGATIVE ARM: a GET must NOT advance the machine. A status read that
    // drove the loop would make the dashboard's own polling a driver of the
    // system it is watching.
    await ownerFetch(`${harness.base}/api/supervisor`);
    await ownerFetch(`${harness.base}/api/supervisor`);
    assert.equal(harness.calls.ticks, 1, "two polls, no extra ticks");
  } finally {
    await harness.close();
  }
});

test("POST /api/supervisor/abort-now refuses without a confirm, and refuses honestly with one", async () => {
  const harness = await startHarness(true);
  try {
    seedRun(harness.store, "run-1", new Date().toISOString());
    harness.store.updateRun("run-1", { status: "running", phase: "build" });
    seedActiveTicket(harness.store, "run-1");

    const refused = await ownerFetch(`${harness.base}/api/supervisor/abort-now`, { method: "POST" });
    assert.equal(refused.status, 400);
    const error = (await refused.json()) as Record<string, unknown>;
    assert.equal(error["error"], "confirm_required");
    assert.match(String(error["remediation"]), /\/api\/supervisor\/stop/, "and it names the safe alternative");

    /* WITH a confirm it still does not abort, and that is the current honest
     * answer rather than a gap: cancelling the run without moving its ticket to
     * `blocked` would leave the next START re-spending on the run the owner just
     * killed, and the ticket writer belongs to the loop. A 501 naming the
     * missing half beats a half-done abort. */
    const confirmed = await ownerFetch(`${harness.base}/api/supervisor/abort-now`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(confirmed.status, 501);
    assert.equal(((await confirmed.json()) as Record<string, unknown>)["error"], "abort_not_wired");
    assert.deepEqual(harness.calls.cancelled, [], "nothing was cancelled, in either arm");
    assert.equal(harness.store.getRun("run-1")?.status, "running");
    assert.equal(harness.store.readSupervisorState().desired, "stopped", "and the desired state was not touched");
  } finally {
    await harness.close();
  }
});

test("the supervisor POSTs require the exact dashboard owner origin", async () => {
  const harness = await startHarness(true);
  try {
    for (const origin of ["https://evil.example", "http://127.0.0.1:4321", null]) {
      const refused = await globalThis.fetch(`${harness.base}/api/supervisor/start`, {
        method: "POST",
        ...(origin === null ? {} : { headers: { origin } }),
      });
      assert.equal(refused.status, 403, `accepted ${origin ?? "an absent origin"}`);
      assert.equal(((await refused.json()) as Record<string, unknown>)["error"], "cross_origin_write");
      assert.equal(harness.store.readSupervisorState().desired, "stopped", "a refused command changes nothing");
      assert.equal(harness.calls.ticks, 0);
    }

    // Positive arm: the exact dashboard UI origin still controls the machine.
    assert.equal((await ownerFetch(`${harness.base}/api/supervisor/start`, { method: "POST" })).status, 200);
    const own = await ownerFetch(`${harness.base}/api/supervisor/stop`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4319" },
    });
    assert.equal(own.status, 200);
    assert.equal(harness.store.readSupervisorState().desired, "draining");
  } finally {
    await harness.close();
  }
});

test("the supervisor ticket intake rejects preview-origin and non-JSON writes", async () => {
  const harness = await startHarness(true);
  try {
    const body = JSON.stringify({ ticketText: "do not enqueue this", modelId: "opus[1m]" });
    const preview = await globalThis.fetch(`${harness.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4321" },
      body,
    });
    assert.equal(preview.status, 403);

    const noOrigin = await globalThis.fetch(`${harness.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(noOrigin.status, 403);

    const plainText = await globalThis.fetch(`${harness.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: DASHBOARD_OWNER_ORIGIN },
      body,
    });
    assert.equal(plainText.status, 415);
    assert.deepEqual(harness.store.listSupervisorTickets(), []);
  } finally {
    await harness.close();
  }
});

test("with no loop wired the commands refuse 503 and write nothing; the GET still answers 200", async () => {
  const harness = await startHarness(false);
  try {
    for (const action of ["start", "stop"]) {
      const response = await ownerFetch(`${harness.base}/api/supervisor/${action}`, { method: "POST" });
      assert.equal(response.status, 503, `${action} must not answer 200 when nothing can carry it out`);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body["error"], "supervisor_not_wired");
      assert.ok(String(body["remediation"]).length > 0);
    }
    // THE ARM: a start button that persists `running` while nothing can claim is
    // the signature defect with a label on it.
    assert.equal(harness.store.readSupervisorState().desired, "stopped");

    // The confirm is checked BEFORE the wiring, so a client discovering the
    // route learns it is destructive whether or not a loop is running.
    const abort = await ownerFetch(`${harness.base}/api/supervisor/abort-now`, { method: "POST" });
    assert.equal(abort.status, 400);
    assert.equal(((await abort.json()) as Record<string, unknown>)["error"], "confirm_required");

    assert.equal((await ownerFetch(`${harness.base}/api/supervisor`)).status, 200);
    assert.equal((await ownerFetch(`${harness.base}/api/supervisor/nonsense`, { method: "POST" })).status, 404);
    assert.equal((await ownerFetch(`${harness.base}/api/supervisor/start`)).status, 404, "GET is not a command");
  } finally {
    await harness.close();
  }
});

test("the route keeps the never-blank promises the panel depends on", () => {
  const ticket = {
    ticketKey: "t-blank",
    ticketText: "# A ticket\n",
    modelId: "opus[1m]",
    designLock: "auto",
    state: "running" as const,
    attemptNo: 1,
    maxAttempts: 3,
    classCounts: "{}",
    currentRunId: null,
    lastRunId: null,
    lastClass: null,
    lastDefectId: null,
    patchId: null,
    enqueuedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    nextAction: "",
    nextActionAt: null,
  };
  const blanked = composeSupervisorState({
    ...COMPOSER_INPUT,
    state: { ...COMPOSER_INPUT.state, reason: "   " },
    activeTicket: ticket,
  });
  // A blank `nextAction` renders as an empty line, which reads as "idle" and in
  // fact means a ticket was written into a state with nothing to say about
  // itself. The router is the last place that can catch it.
  assert.equal(blanked.nextAction, SUPERVISOR_NO_NEXT_ACTION);
  assert.ok(blanked.reason.trim().length > 0);

  // THE NEGATIVE CONTROL: a substitution that fired on everything would hide the
  // supervisor's real sentences, which are the useful ones.
  const real = composeSupervisorState({
    ...COMPOSER_INPUT,
    activeTicket: { ...ticket, nextAction: "waiting for run-1 to reach a verdict" },
  });
  assert.equal(real.nextAction, "waiting for run-1 to reach a verdict");
  assert.equal(real.reason, "seed");

  // AND THE IDLE SENTENCES ARE FOUR DIFFERENT SENTENCES. `nextAction` is what
  // the owner reads after eight hours away; a single "idle" for every reason to
  // be idle is the field failing at its only job.
  const idles = new Set(
    (["stopped", "draining", "running"] as const).flatMap((desired) =>
      [0, 3].map((queueDepth) =>
        composeSupervisorState({ ...COMPOSER_INPUT, state: { ...COMPOSER_INPUT.state, desired }, queueDepth })
          .nextAction,
      ),
    ),
  );
  assert.equal(idles.size, 6, "three desired states × queued/empty must be six distinguishable sentences");
  assert.equal(
    composeSupervisorState({ ...COMPOSER_INPUT, wired: false }).nextAction,
    SUPERVISOR_NOT_WIRED,
    "and the unwired sentence outranks all six",
  );
});

test("the boot ARM CHECK measures the composer and reads the live store", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-supervisor-arm-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  try {
    store.setSupervisorState("running", "owner", "armed for the test");
    seedActiveTicket(store, "run-9");

    const lines: string[] = [];
    const armed = armSupervisorRoute(store, { tick: () => undefined }, (line) => lines.push(line));
    assert.equal(armed.armed, true);
    // ARM ONE proves the composer is not constant.
    assert.match(lines[0] ?? "", /ARM CHECK: supervisor route composer renders 3 distinguishable states/);
    // ARM TWO prints MEASURED values from the store the route will read, in the
    // idiom of `ARM CHECK: seat matcher finds N process(es)`. Its job is the
    // failure arm one cannot see: a surface reading a store nobody drives.
    assert.match(lines[1] ?? "", /desired='running' since 20/);
    assert.match(lines[1] ?? "", /1 ticket\(s\), 0 queued, active=t-portfolio\/running/);
    assert.match(lines[1] ?? "", /loop=wired/);

    const unwired: string[] = [];
    armSupervisorRoute(store, undefined, (line) => unwired.push(line));
    assert.match(unwired[1] ?? "", /loop=NOT WIRED — nothing will claim a ticket and START will refuse/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
 * FILING A TICKET — the last stop, and the one that made every other
 * fix in this round unreachable.
 *
 * MEASURED 2026-08-10: `enqueueSupervisorTicket` had callers ONLY in
 * `supervisor.test.ts` and this file. No route, no client function, no UI
 * control. So the queue was permanently empty in production and START answered
 * its own message — "stopped, and nothing is queued — POST /api/supervisor/start
 * after filing a ticket" — for a filing endpoint that did not exist. The loop
 * would arm, tick every 30 s for eight hours over an empty queue, and report
 * `idle` truthfully the whole time.
 * ================================================================== */

test("POST /api/supervisor/tickets files a durable ticket the LOOP then claims", async () => {
  const h = await startHarness(true);
  try {
    const before = await ownerFetch(`${h.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketText: "build a portfolio site with a dark hero", modelId: "opus[1m]" }),
    });
    assert.equal(before.status, 201, `filing a ticket answered ${String(before.status)}`);
    const filed = (await before.json()) as { ticketKey: string; queuedTickets: number };
    assert.match(filed.ticketKey, /^t-[0-9a-f]{16}$/, `the key is not a minted digest: ${filed.ticketKey}`);
    assert.equal(filed.queuedTickets, 1);

    // DURABLE, AND IN THE QUEUE THE LOOP READS. Not "the route answered 201".
    const queued = h.store.listSupervisorTickets(["queued"]);
    assert.equal(queued.length, 1, "the route answered 201 and filed nothing");
    assert.equal(queued[0]?.ticketText, "build a portfolio site with a dark hero");
    assert.equal(queued[0]?.modelId, "opus[1m]");
    assert.equal(queued[0]?.maxAttempts, 3);
    assert.notEqual(queued[0]?.nextAction.trim(), "");

    /*
     * THE ASSERTION THAT CLOSES THE LOOP, AND NOTHING ELSE IN THIS ROUND HAS IT:
     * the queue the ROUTE writes is the queue the LOOP reads. A route that filed
     * into a different table, or a loop that read a different state, would pass
     * every assertion above and still leave the owner's eight hours empty.
     */
    const submitted: string[] = [];
    h.store.setSupervisorState("running", "owner", "the test pressed start");
    const loop = new SupervisorLoop({
      store: h.store,
      submit: (spec) => {
        submitted.push(spec.ticketText);
        return Promise.resolve({ runId: "run-from-a-filed-ticket" });
      },
      log: () => {},
    });
    await loop.tick();
    assert.deepEqual(submitted, ["build a portfolio site with a dark hero"], "the loop never claimed the filed ticket");
    assert.equal(h.store.getSupervisorTicket(filed.ticketKey)?.state, "running");
  } finally {
    await h.close();
  }
});

test("a blank brief is refused with 400 and writes NO row; a duplicate brief is refused with 409", async () => {
  const h = await startHarness(true);
  const file = (body: unknown): Promise<Response> =>
    ownerFetch(`${h.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    // A brief of only invisible characters trims to a non-empty string while
    // rendering as an empty field, and this queue is the one that spends money.
    for (const bad of [{ modelId: "opus[1m]" }, { ticketText: "   ", modelId: "opus[1m]" }, { ticketText: "​​", modelId: "opus[1m]" }, { ticketText: "ok", modelId: "" }]) {
      const answer = await file(bad);
      assert.equal(answer.status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.deepEqual(h.store.listSupervisorTickets(), [], `${JSON.stringify(bad)} wrote a row anyway`);
    }

    // NEGATIVE HALF: a good brief IS filed, so the 400s above are about the
    // input and not about the route being broken.
    assert.equal((await file({ ticketText: "build it", modelId: "opus[1m]" })).status, 201);
    assert.equal(h.store.listSupervisorTickets().length, 1);

    /*
     * THE SAME BRIEF TWICE IS A 409, NOT A 500 AND NOT A SECOND TICKET.
     * `enqueueSupervisorTicket` is deliberately `INSERT OR IGNORE`-free — "a
     * duplicate key is a caller bug worth a throw" — and the key is minted from
     * the brief, so a double-submitted form would have thrown out of the router.
     */
    const again = await file({ ticketText: "build it", modelId: "opus[1m]" });
    assert.equal(again.status, 409, `a duplicate brief answered ${String(again.status)}`);
    assert.equal(h.store.listSupervisorTickets().length, 1, "the duplicate was filed as a second ticket");
    // `error` is this API's code field (`ApiErrorResponse`), so the client can tell
    // a duplicate from a bad brief without parsing prose.
    const detail = (await again.json()) as { error?: string };
    assert.equal(detail.error, "ticket_already_queued");
  } finally {
    await h.close();
  }
});

test("a ticket can be filed against a server with NO loop — the row is durable and the next boot claims it", async () => {
  const h = await startHarness(false);
  try {
    /*
     * DELIBERATELY NOT A 503, unlike start/stop. A command that cannot be
     * carried out must not answer 200 — but FILING is not a command to the loop,
     * it is a durable write, and it is still true after this process dies. A 503
     * here would collapse "no loop is wired" into "there is no queue", which is
     * the exact conflation the whole strip exists to prevent.
     */
    const answer = await ownerFetch(`${h.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketText: "file this while nothing is wired", modelId: "opus[1m]" }),
    });
    assert.equal(answer.status, 201, `filing against an unwired server answered ${String(answer.status)}`);
    assert.equal(h.store.listSupervisorTickets(["queued"]).length, 1);

    // NEGATIVE HALF: start/stop on the SAME unwired server still refuse, so this
    // is a considered difference between the two routes and not a lost guard.
    const started = await ownerFetch(`${h.base}/api/supervisor/start`, { method: "POST" });
    assert.equal(started.status, 503);
  } finally {
    await h.close();
  }
});

/**
 * THE OTHER END OF THE WIRE PIN — AND IT IS HALF OF A FIX, NOT A TEST ON ITS OWN.
 *
 * `dashboard/src/lib/api-types.ts` mirrors `ApiSupervisorState` BY HAND, and on
 * 2026-08-10 it disagreed in fifteen fields: `since` for `changedAt`, three flat
 * fields for a nested `run`, `quietForSeconds` for `run.quietForMs`,
 * `queuedTickets` for `queueDepth`, a non-nullable `lastRepair` carrying a
 * `summary` this route has never sent, an invented `ticket.currentRunId`, and four
 * wire fields the client did not declare at all. Nothing could see it: no module
 * imports both declarations, so all three typecheckers were clean, and the client's
 * fixture API serves no `/api/supervisor`, so both suites were green. Measured
 * against a real server, the strip read amber `MALFORMED` on every route — the same
 * amber it shows when a loop is genuinely wedged.
 *
 * `../tests/fixtures/supervisor-wire.golden.json` was GENERATED from this very
 * function (`../tests/fixtures/supervisor-wire.golden.mjs`) and is asserted from
 * both ends:
 *
 *   HERE                                  the composer must still produce it, so a
 *                                         change on the SERVER side reddens here
 *   tests/supervisor-strip.unit.spec.ts   the client classifier must read it as
 *                                         idle / running / unreachable, so a change
 *                                         on the CLIENT side reddens there
 *
 * NEITHER TEST CAN BE SATISFIED BY EDITING ONE SIDE, which is the property a
 * hand-written fixture cannot have. If this assertion fails because the route
 * legitimately grew a field, regenerate the golden and the client test will tell you
 * whether the mirror has caught up.
 */
test("the composer still produces the golden body the dashboard client is pinned to", () => {
  const golden = JSON.parse(
    readFileSync(new URL("../../tests/fixtures/supervisor-wire.golden.json", import.meta.url), "utf8"),
  ) as Record<string, ApiSupervisorState>;

  const state = {
    desired: "running" as const,
    changedAt: "2026-08-10T02:00:00.000Z",
    changedBy: "owner",
    reason: "the owner pressed start",
  };
  const base = {
    activeTicket: null,
    run: null,
    quietForMs: null,
    queueDepth: 0,
    ticketsSeen: 0,
    queuedRuns: 0,
    runsSeen: 0,
    eventsSeen: 0,
    wired: true,
    armed: true,
    armNote: "composer renders 3 distinguishable states",
    at: "2026-08-10T03:00:00.000Z",
  };
  const ticket = {
    ticketKey: "t-b17e54c98f1a0617",
    ticketText: "a portfolio site for a ceramicist, with a booking form",
    modelId: "haiku",
    designLock: "auto" as const,
    state: "running" as const,
    attemptNo: 1,
    maxAttempts: 3,
    classCounts: "{}",
    currentRunId: "run-2026-08-10T11-19-00-192Z-36f87c2b",
    lastRunId: null,
    lastClass: null,
    lastDefectId: null,
    patchId: null,
    enqueuedAt: "2026-08-10T02:00:00.000Z",
    updatedAt: "2026-08-10T02:59:00.000Z",
    nextAction: "waiting for run-2026-08-10T11-19-00-192Z-36f87c2b to reach a verdict",
    nextActionAt: null,
  };

  const produced = {
    idle: composeSupervisorState({
      ...base,
      state: { ...state, desired: "stopped", reason: "the owner pressed stop" },
    }),
    claimed: composeSupervisorState({
      ...base,
      state,
      activeTicket: ticket,
      run: {
        runId: "run-2026-08-10T11-19-00-192Z-36f87c2b",
        phase: "spec",
        status: "running",
      } as SupervisorComposerInput["run"],
      quietForMs: 42_000,
      queueDepth: 1,
      ticketsSeen: 2,
      runsSeen: 6,
      eventsSeen: 412,
    }),
    notWired: composeSupervisorState({
      ...base,
      state: { ...state, changedBy: "boot", reason: "boot default" },
      queueDepth: 2,
      ticketsSeen: 2,
      runsSeen: 6,
      wired: false,
      armNote: "arming",
    }),
  };

  /*
   * THE ROUND TRIP IS THE MEASUREMENT. `JSON.stringify` DELETES keys whose value is
   * `undefined`, so a field this route leaves undefined rather than null arrives at
   * the client ABSENT — and `absent` is a failure wherever the contract says
   * `| null`. Comparing the parsed bodies compares what the client receives.
   */
  for (const name of ["idle", "claimed", "notWired"] as const) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(produced[name])),
      golden[name],
      `composeSupervisorState no longer produces the golden '${name}' body the dashboard client is pinned to — ` +
        "regenerate ../tests/fixtures/supervisor-wire.golden.json and check that dashboard/src/lib/api-types.ts agrees",
    );
  }

  /*
   * AND THE NEGATIVE HALF, BECAUSE A DEEP-EQUAL AGAINST A FILE PROVES NOTHING ABOUT
   * DISCRIMINATION: the three golden bodies must differ from one another. A composer
   * that had gone constant would deep-equal one of them and fail the other two, but a
   * golden file regenerated FROM a constant composer would agree with itself
   * perfectly. So the file is asserted to hold three different bodies.
   */
  const distinct = new Set(["idle", "claimed", "notWired"].map((name) => JSON.stringify(golden[name])));
  assert.equal(distinct.size, 3, "the golden file no longer holds three distinguishable bodies");
  assert.equal(golden["claimed"]?.ticket?.ticketKey, "t-b17e54c98f1a0617");
  assert.equal(golden["claimed"]?.run?.quietForMs, 42_000);
  assert.equal(golden["notWired"]?.probe.wired, false);
});

/* ------------------------------------------------------------------ */
/* THE TYPO GUARD ON `POST /api/supervisor/tickets`                     */
/* ------------------------------------------------------------------ */

/**
 * THE MODELS A HEALTHY CATALOG ENUMERATES — QUOTED FROM THIS MACHINE'S OWN CLI, and
 * the `default` row is the whole reason this list is not the shorter one from
 * `api.test.ts`.
 *
 * MEASURED 2026-08-10 against a booted `dist/index.js`: `GET /api/models` answered
 * `['default', 'opus[1m]', 'claude-fable-5[1m]', 'sonnet', 'haiku']`. The CLI
 * enumerates a model whose id is literally `default`, which is ALSO the id
 * `ModelCatalog` uses for its "the enumeration failed" fallback row. The first
 * version of the guard below inferred "the catalog could not enumerate" from that
 * id's presence, passed a fixture list that had no such row, and answered 201 to
 * `no-such-model` against the real server anyway. The fixture carries the row now,
 * so the test can fail the way production did.
 *
 * `haiku` and `opus[1m]` are the ids the supervisor proof run actually filed with; a
 * guard that refused either would block the night it exists to protect.
 */
const REAL_MODELS: readonly ModelInfo[] = [
  { value: "default", displayName: "Claude (CLI default)", description: "", supportsEffort: false },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: false },
  { value: "haiku", displayName: "Haiku", description: "", supportsEffort: false },
];

/**
 * A SERVER WHOSE CATALOG CAN ANSWER — which the default harness above deliberately
 * cannot: its `AuthProbe` points at absent binaries, so `entries()` falls back to a
 * single `default` row and CANNOT tell a typo from an outage. Both states are
 * needed, and mixing them up is the whole subtlety of this guard.
 *
 * @param enumerates false reproduces the outage: the CLI is logged in and the model
 * list THROWS, which is the branch that must still FILE the ticket.
 */
async function startCatalogHarness(enumerates: boolean): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-supervisor-catalog-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const claudeBin = join(dir, "claude-stub");
  writeFileSync(
    claudeBin,
    '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com"}\'\n',
    "utf8",
  );
  chmodSync(claudeBin, 0o755);
  const codexBin = join(dir, "codex-stub");
  writeFileSync(codexBin, '#!/bin/sh\necho "Not logged in"\nexit 1\n', "utf8");
  chmodSync(codexBin, 0o755);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin, codexBin, env: process.env });
  const catalog = new ModelCatalog(auth, {}, async () => {
    if (!enumerates) throw new Error("the model list could not be fetched");
    return REAL_MODELS;
  });
  const calls: SupervisorCalls = { ticks: 0, cancelled: [] };
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => true,
    resume: () => false,
    pushLiveMessage: () => false,
  };
  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
    // NEVER THE REAL BROWSER, for the same reason as the default harness: the
    // ticket route scans the brief for a URL, and these briefs are about model
    // ids rather than pages, so the seams exist only to make that unmissable.
    captureSite: () => Promise.resolve({ ok: false, reason: "no browser in a catalog test" }),
    captureMotion: () => Promise.resolve({ ok: false, reason: "no browser in a catalog test" }),
    supervisor: {
      tick: () => {
        calls.ticks += 1;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    paths,
    calls,
    captures: { sites: [], motions: [] },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function file(base: string, ticketText: string, modelId: string): Promise<Response> {
  return ownerFetch(`${base}/api/supervisor/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketText, modelId }),
  });
}

/**
 * A MODEL ID THAT CANNOT RUN IS REFUSED AT FILING TIME — AND THE TWO IDS THAT CAN
 * ARE NOT.
 *
 * MEASURED BEFORE THE FIX (2026-08-10): `{"modelId":"no-such-model"}` answered 201,
 * the ticket queued, and the typo surfaced two ticks later in the SUBMIT step —
 * `supervisor_log` seq 7, "the submission threw…: no-such-model is not in the
 * catalog, so this ticket cannot be submitted" — which spends an attempt and leaves
 * a terminal `blocked` ticket. Nothing spun and no run row was orphaned, so this was
 * never fatal; it is a brief filed at midnight that never runs, found in the
 * morning. STATE §7.2 promises `400 invalid_model` among the legible refusals.
 *
 * THE THREE BRANCHES ARE ASSERTED TOGETHER BECAUSE THE GUARD IS ONLY CORRECT AS A
 * TRIO. A refusal that fired on every unknown id would reject every real model the
 * moment the CLI probe failed — which is the failure the route's own docblock was
 * written to avoid — and a guard that never fired is the bug being fixed.
 */
test("a model id that cannot run is refused at filing time, and NOTHING is queued", async () => {
  const h = await startCatalogHarness(true);
  try {
    const refused = await file(h.base, "a portfolio site for a ceramicist", "no-such-model");
    assert.equal(refused.status, 400);
    const problem = (await refused.json()) as Record<string, unknown>;
    assert.equal(problem["error"], "invalid_model");
    assert.match(String(problem["message"]), /no-such-model is not in the catalog/);
    // THE ROW IS THE ASSERTION THAT MATTERS: a 400 that still queued the ticket
    // would be the same brief that never runs, with a tidier response.
    assert.equal(h.store.listSupervisorTickets().length, 0, "a refused ticket was queued anyway");

    /*
     * NEGATIVE HALF ONE: the two ids the owner actually uses are filed. `haiku` is
     * the id the supervisor proof run filed with, and a guard that refused it would
     * have blocked the whole eight-hour night it exists to protect.
     */
    for (const modelId of ["opus[1m]", "haiku"]) {
      const filed = await file(h.base, `build something with ${modelId}`, modelId);
      assert.equal(filed.status, 201, `${modelId} was refused by the typo guard`);
    }
    assert.equal(h.store.listSupervisorTickets().length, 2);

    /*
     * NEGATIVE HALF TWO: an id that IS in the catalog and is NOT available is still
     * filed. `codex-default` is retained-unofferable, i.e. permanently unavailable
     * with a reason — the same shape a lapsed Claude login produces — and the
     * route's rule is that auth may come back before the loop claims the ticket.
     * This is the assertion that keeps the fix from becoming "refuse anything
     * unusable", which would make the queue depend on a live probe.
     */
    const unavailable = await file(h.base, "file this against an unavailable model", CODEX_DEFAULT_MODEL_ID);
    assert.equal(unavailable.status, 201, "an unavailable BUT KNOWN id must still be filed");
    assert.equal(h.store.listSupervisorTickets().length, 3);

    /*
     * NEGATIVE HALF THREE, AND IT IS THE ONE THE LIVE SERVER TAUGHT. This catalog
     * enumerated AND contains a model whose id is `default` — the same id
     * `ModelCatalog` gives its fallback row — because the real CLI lists one. A guard
     * that read that id as "the catalog is degraded" would go quiet on exactly the
     * machine it has to work on, which is what the first version of it did.
     */
    assert.equal(
      (await (await ownerFetch(`${h.base}/api/models`)).json() as readonly { readonly id: string }[])
        .some((model) => model.id === CATALOG_FALLBACK_MODEL_ID),
      true,
      "the fixture no longer reproduces the real CLI's `default` row, so the refusal above proves less",
    );
    const stillRefused = await file(h.base, "a brief filed against another typo", "opus[2m]");
    assert.equal(stillRefused.status, 400, "the guard went quiet on a catalog that lists `default`");
  } finally {
    await h.close();
  }
});

/**
 * AND WHEN THE CATALOG CANNOT ENUMERATE, THE TICKET IS FILED — INCLUDING THE TYPO.
 *
 * `ModelCatalog.entries()` collapses to a single `default` row when the model list
 * throws or the CLI is not logged in. In that state "not in the catalog" means "the
 * catalog does not know anything", so a refusal would reject `opus[1m]` at 2am
 * because a network read failed, and the brief would be lost. Filing is the lesser
 * error: the submit step still names the failure on the ticket.
 *
 * THIS TEST IS WHY THE GUARD READS `CATALOG_FALLBACK_MODEL_ID` RATHER THAN COUNTING
 * ROWS. It is the case that turns a plausible one-line fix into a wrong one.
 */
test("with a catalog that could not enumerate, the SAME ids are filed rather than refused", async () => {
  const h = await startCatalogHarness(false);
  try {
    const filed = await file(h.base, "a portfolio site for a ceramicist", "opus[1m]");
    assert.equal(filed.status, 201, "a real id was refused because the model probe failed");

    // AND SO IS THE TYPO, deliberately: this build cannot tell the two apart, and
    // saying so by filing is better than losing a brief on a guess.
    const typo = await file(h.base, "a different brief entirely", "no-such-model");
    assert.equal(typo.status, 201);
    assert.equal(h.store.listSupervisorTickets().length, 2);

    /*
     * THE CONTROL FOR THIS CONTROL: the catalog really is in the fallback state, so
     * this test is not passing because the guard was deleted. One row, and its id is
     * the fallback id.
     */
    const models = (await (await ownerFetch(`${h.base}/api/models`)).json()) as readonly {
      readonly id: string;
    }[];
    assert.deepEqual(
      models.map((model) => model.id),
      [CATALOG_FALLBACK_MODEL_ID],
      "the catalog was not in the fallback state, so this test proves nothing",
    );
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* THE QUEUE READOUT AND THE ATTACHMENTS — lane `ticket-intake`         */
/* ------------------------------------------------------------------ */

/** A base64 image data URL of `bytes` identical bytes. `api-references.test.ts`'s shape. */
function pngDataUrl(bytes: number, seed: string): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, seed.charCodeAt(0)).toString("base64")}`;
}

/** A base64 PDF data URL. The owner's real ticket carries one of these. */
function pdfDataUrl(bytes: number, seed: string): string {
  return `data:application/pdf;base64,${Buffer.alloc(bytes, seed.charCodeAt(0)).toString("base64")}`;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileTicket(base: string, body: unknown): Promise<Response> {
  return ownerFetch(`${base}/api/supervisor/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readQueue(base: string): Promise<ApiSupervisorTicketsResponse> {
  const answer = await ownerFetch(`${base}/api/supervisor/tickets`);
  assert.equal(answer.status, 200, `GET /api/supervisor/tickets answered ${String(answer.status)}`);
  return (await answer.json()) as ApiSupervisorTicketsResponse;
}

/**
 * `GET /api/supervisor/tickets` — THE MORNING READOUT, WHICH WAS A MEASURED 404.
 *
 * WHAT WAS BROKEN. `GET /api/supervisor` reports the ACTIVE ticket only, so a
 * ticket that terminated at `blocked` overnight existed for the owner only in
 * `supervisor_tickets.next_action` and in the server's stdout — the morning
 * readout required opening runs.db in a SQL client. Eight unattended hours
 * produce a LIST.
 *
 * THE EMPTY ARM IS THE ONE THAT MATTERS. A queue readout's failure mode is
 * rendering nothing, so "no tickets" and "the reader is blind" must not produce
 * the same body: `probe.ticketsSeen` is asserted on both a populated and an
 * empty store.
 */
test("GET /api/supervisor/tickets lists every ticket, its state, its attempts and its sentence", async () => {
  const h = await startHarness(true);
  try {
    const empty = await readQueue(h.base);
    assert.deepEqual(empty.tickets, [], "an empty store did not answer an empty list");
    assert.equal(empty.probe.ticketsSeen, 0);
    assert.equal(empty.probe.armed, true, "the route reported itself blind on an empty store");

    h.store.enqueueSupervisorTicket({
      ticketKey: "t-blocked",
      ticketText: "# A blocked one\n\nBuild it.",
      modelId: "haiku",
      // A SECOND, DIFFERENT VALUE FOR EVERY FIELD BELOW. `seedActiveTicket` files
      // `opus[1m]` at attempt 2 of the default 3 with a different heading, so each
      // per-field assertion has two arms and a hardcoded constant cannot pass —
      // this test was one-armed on five fields when it was first written.
      maxAttempts: 5,
      nextAction: "nothing — the gate could not be reached and no repair driver is wired",
    });
    h.store.updateSupervisorTicket("t-blocked", {
      state: "blocked",
      attemptNo: 3,
      lastRunId: "run-old",
      lastClass: "structural",
      lastDefectId: "abc123ef",
      nextAction: "nothing — the gate could not be reached and no repair driver is wired",
    });
    seedRun(h.store, "run-live", "2026-08-10T04:00:00.000Z");
    seedActiveTicket(h.store, "run-live");

    const queue = await readQueue(h.base);
    assert.equal(queue.probe.ticketsSeen, 2, "the readout did not see both tickets");
    assert.deepEqual(
      queue.tickets.map((row) => row.ticketKey),
      ["t-blocked", "t-portfolio"],
      "the readout is not in enqueued order",
    );

    const blocked = queue.tickets[0];
    assert.equal(blocked?.state, "blocked");
    assert.equal(blocked?.attemptNo, 3);
    assert.equal(blocked?.maxAttempts, 5);
    assert.equal(
      blocked?.nextAction,
      "nothing — the gate could not be reached and no repair driver is wired",
      "the blocked ticket's whole explanation is missing from the readout",
    );
    // THE RUN IT HAD, on a ticket that is no longer running. Without this the
    // owner cannot open the run whose failure the sentence describes.
    assert.equal(blocked?.runId, "run-old");
    assert.equal(blocked?.currentRunId, null, "a blocked ticket must not claim a current run");
    assert.equal(blocked?.lastDefectId, "abc123ef");
    assert.equal(blocked?.modelId, "haiku");
    assert.equal(blocked?.title, "A blocked one", "the title is not read from the brief");

    /*
     * THE SECOND ARM OF EVERY FIELD ABOVE. Each of these differs from the blocked
     * row's value, so a row assembled from constants — the failure mode of a
     * readout, and the one this repository has catalogued twenty-two times — cannot
     * satisfy both halves.
     */
    const running = queue.tickets[1];
    assert.equal(running?.state, "running");
    assert.equal(running?.attemptNo, 2, "attempt counts are not read per ticket");
    assert.equal(running?.maxAttempts, 3, "maxAttempts is not read per ticket");
    assert.equal(running?.modelId, "opus[1m]", "the model id is not read per ticket");
    assert.equal(running?.title, "The portfolio site", "the title is not read per ticket");
    assert.equal(running?.lastDefectId, null, "a ticket with no recorded defect carries one anyway");
    assert.equal(running?.currentRunId, "run-live");
    assert.equal(running?.runId, "run-live");
    assert.notEqual(running?.nextAction.trim(), "");
    assert.notEqual(running?.nextAction, blocked?.nextAction, "both rows carry one sentence");
  } finally {
    await h.close();
  }
});

/**
 * THE OWNER'S REAL TICKET — A BRIEF THAT SAYS "CONTENT COMES FROM THE ATTACHED
 * CV", PLUS THE CV.
 *
 * MEASURED BEFORE THIS ROUND: the route accepted `ticketText` and `modelId` and
 * nothing else, so the only way to file that ticket WITH its attachments was
 * `POST /api/runs`, which bypasses the supervisor entirely. Tonight's run was
 * submitted that way.
 *
 * THE ENVELOPE IS HALF THE FIX AND IT HAS NO OTHER TEST. `readBody`'s default cap
 * is 1 MiB; the image below is 1 MB of bytes, ~1.37 MB as base64, so a route that
 * kept the default envelope refuses this request before any decoder runs — and
 * the refusal would quote per-image limits no request could reach, which is the
 * exact defect `MAX_ATTACHMENT_BODY_BYTES` was declared to end.
 *
 * THE COUNTS ARE READ BACK OFF THE DISK, NOT ECHOED. The response's `attachments`
 * block comes from re-reading the manifest that was just written, so a filing
 * whose bytes did not land cannot answer with the request's own numbers.
 */
test("a ticket carries reference images and documents, and the bytes are durable", async () => {
  const h = await startHarness(true);
  try {
    const imageBytes = Buffer.alloc(1024 * 1024, "i".charCodeAt(0));
    const docBytes = Buffer.alloc(80 * 1024, "d".charCodeAt(0));
    const answer = await fileTicket(h.base, {
      ticketText: "a one-page CV site. Content comes from the attached CV; match the reference image.",
      modelId: "opus[1m]",
      references: [`data:image/png;base64,${imageBytes.toString("base64")}`],
      documents: [`data:application/pdf;base64,${docBytes.toString("base64")}`],
    });
    assert.equal(answer.status, 201, `filing with attachments answered ${String(answer.status)}`);
    const filed = (await answer.json()) as ApiSupervisorTicketFiled;
    assert.deepEqual(
      filed.attachments,
      { manifest: "read", images: 1, documents: 1, capture: false, motion: false, carriedIntoRun: null },
      "the 201 does not report what was kept",
    );

    // THE BYTES, ON DISK, UNDER THE TICKET'S OWN KEY — not under a run id, because
    // no run exists until the loop claims this ticket.
    const ticketRoot = ticketAttachmentRoot(h.paths.runs);
    const image = join(referenceDirFor(ticketRoot, filed.ticketKey), "reference-1.png");
    const document = join(documentDirFor(ticketRoot, filed.ticketKey), "document-1.pdf");
    assert.equal(existsSync(image), true, `no image at ${image}`);
    assert.equal(existsSync(document), true, `no document at ${document}`);
    assert.equal(readFileSync(image).byteLength, imageBytes.byteLength, "the image was truncated");
    assert.equal(readFileSync(document).byteLength, docBytes.byteLength, "the document was truncated");

    // AND THE MANIFEST, which is what a submission has to read to re-attach them.
    const manifest = readReferenceManifest(referenceDirFor(ticketRoot, filed.ticketKey));
    assert.notEqual(manifest, null, "no manifest was written, so nothing downstream can find the CV");
    assert.deepEqual(
      manifest?.images.map((entry) => entry.sha256),
      [sha256Of(imageBytes)],
      "the manifest does not digest the image that was sent",
    );
    assert.deepEqual(
      manifestDocuments(manifest).map((entry) => [entry.sha256, entry.mediaType]),
      [[sha256Of(docBytes), "application/pdf"]],
      "the manifest does not digest the document that was sent",
    );

    // The readout agrees with the filing. One derivation, two routes.
    const queue = await readQueue(h.base);
    assert.deepEqual(queue.tickets[0]?.attachments, filed.attachments);
  } finally {
    await h.close();
  }
});

/**
 * WHAT AN ATTACHMENT MEANS FOR THE TICKET KEY — DECIDED, AND BOTH DIRECTIONS
 * PINNED.
 *
 * THE DECISION: the key covers the brief AND the bytes the owner attached. The
 * same brief with a DIFFERENT CV is a DIFFERENT ticket, because the artefact is
 * built from the CV's contents and graded against criteria written from them —
 * two such tickets are two pieces of work, and answering 409 to the second would
 * silently discard the corrected CV. The same brief with the SAME bytes is still
 * ONE ticket, so a retried POST after a dropped connection is still a decidable
 * 409 rather than a second night's spend.
 *
 * THE DERIVATION IS `referenceIdentityMaterial`, WHICH IS WHY THE TEXT-ONLY KEY
 * DID NOT MOVE. That function is documented byte-identical to the brief for
 * empty lists, so every ticket filed before this round hashes to the same key it
 * always did — asserted below against a hardcoded golden rather than against the
 * implementation, in the `ticket-refs.test.ts` idiom.
 *
 * NEITHER `captureUrl` NOR `motionUrl` IS IN THE KEY, and that is deliberate: a
 * key that folded a live page reading would move whenever the page did, so a
 * double-submitted form would file two tickets. The key is a function of what the
 * OWNER supplied.
 */
test("the ticket key covers the attached bytes: the same brief with a different CV is a different ticket", async () => {
  const h = await startHarness(true);
  try {
    const brief = "a one-page CV site. Content comes from the attached CV.";

    // THE GOLDEN: no attachments, and the key is the plain brief digest this route
    // has always minted. A derivation change that moved this orphans every ticket
    // already filed.
    const plain = (await (await fileTicket(h.base, { ticketText: "build it", modelId: "opus[1m]" })).json()) as ApiSupervisorTicketFiled;
    assert.equal(
      plain.ticketKey,
      `t-${createHash("sha256").update("build it", "utf8").digest("hex").slice(0, 16)}`,
      "the text-only ticket key moved, which orphans every ticket already filed",
    );

    const first = await fileTicket(h.base, {
      ticketText: brief,
      modelId: "opus[1m]",
      documents: [pdfDataUrl(2048, "a")],
    });
    assert.equal(first.status, 201);
    const one = (await first.json()) as ApiSupervisorTicketFiled;

    // SAME BYTES, SAME TICKET. The retried POST.
    const retried = await fileTicket(h.base, {
      ticketText: brief,
      modelId: "opus[1m]",
      documents: [pdfDataUrl(2048, "a")],
    });
    assert.equal(retried.status, 409, `a byte-identical re-POST answered ${String(retried.status)}`);
    assert.equal(((await retried.json()) as { error?: string }).error, "ticket_already_queued");

    // DIFFERENT BYTES, DIFFERENT TICKET.
    const second = await fileTicket(h.base, {
      ticketText: brief,
      modelId: "opus[1m]",
      documents: [pdfDataUrl(2048, "b")],
    });
    assert.equal(second.status, 201, "the same brief with a different CV was refused as a duplicate");
    const two = (await second.json()) as ApiSupervisorTicketFiled;
    assert.notEqual(two.ticketKey, one.ticketKey, "two different CVs minted one key");
    assert.equal(h.store.listSupervisorTickets().length, 3, "the queue does not hold the three distinct tickets");

    // AND THE TWO KEYS DIFFER FROM THE TEXT-ONLY ONE, so the digests are really in
    // the material rather than the two tickets differing by luck.
    const textOnly = `t-${createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 16)}`;
    assert.notEqual(one.ticketKey, textOnly, "the attachment digests are not in the key");
  } finally {
    await h.close();
  }
});

/**
 * THE REFUSALS — THE SAME CODES `POST /api/runs` ANSWERS, AND NOTHING IS LEFT
 * BEHIND.
 *
 * `readReferenceImages` and `readReferenceDocuments` are REUSED rather than
 * restated, so these assertions are on the codes and sentences those functions
 * own. A second copy of the caps in this route is how the ticket form and the
 * chat box end up disagreeing about what a document is.
 *
 * THE ROW AND THE DIRECTORY ARE BOTH ASSERTED ABSENT. A refusal that had already
 * written bytes would leave an orphan directory under a key nothing will ever
 * claim, and a refusal that had already inserted the row would file a ticket
 * whose attachments were rejected.
 */
test("attachment refusals answer the same codes as POST /api/runs, and write nothing", async () => {
  const h = await startHarness(true);
  try {
    const cases: readonly { readonly body: Record<string, unknown>; readonly code: string }[] = [
      { body: { references: Array.from({ length: 7 }, (_, i) => pngDataUrl(16, String(i))) }, code: "too_many_images" },
      { body: { references: ["not a data url"] }, code: "invalid_image" },
      { body: { references: "one image, honest" }, code: "invalid_body" },
      { body: { documents: Array.from({ length: 5 }, (_, i) => pdfDataUrl(16, String(i))) }, code: "too_many_documents" },
      { body: { documents: [`data:application/x-msdownload;base64,${Buffer.from("MZ").toString("base64")}`] }, code: "invalid_document" },
      { body: { documents: { one: "document" } }, code: "invalid_body" },
      { body: { captureUrl: 7 }, code: "invalid_body" },
      { body: { motionUrl: ["https://example.com/"] }, code: "invalid_body" },
    ];
    for (const [index, { body, code }] of cases.entries()) {
      const answer = await fileTicket(h.base, {
        ticketText: `refusal case ${String(index)}`,
        modelId: "opus[1m]",
        ...body,
      });
      assert.equal(answer.status, 400, `${JSON.stringify(body).slice(0, 60)} answered ${String(answer.status)}`);
      const problem = (await answer.json()) as { error?: string; message?: string };
      assert.equal(problem.error, code, `${JSON.stringify(body).slice(0, 60)} answered ${String(problem.error)}`);
      assert.notEqual(problem.message?.trim(), "", "a refusal with no sentence");
    }
    assert.deepEqual(h.store.listSupervisorTickets(), [], "a refused filing wrote a row");
    assert.equal(
      existsSync(ticketAttachmentRoot(h.paths.runs)),
      false,
      "a refused filing left a ticket directory behind",
    );

    // NEGATIVE HALF: the same route, with attachments inside every cap, files.
    const good = await fileTicket(h.base, {
      ticketText: "the positive control",
      modelId: "opus[1m]",
      references: [pngDataUrl(64, "p")],
      documents: [pdfDataUrl(64, "q")],
    });
    assert.equal(good.status, 201, "the refusals above are the route being broken, not the input");
    assert.equal(h.store.listSupervisorTickets().length, 1);
  } finally {
    await h.close();
  }
});

/**
 * DID THE CV REACH THE RUN? — THE THREE-VALUED PROBE, AND THE BLIND MANIFEST.
 *
 * THIS IS THE FIELD THE OWNER'S QUESTION MAPS ONTO. Measured 2026-08-10:
 * `createSupervisorSubmit` calls `ticketWithReferences` with `images: []` and
 * `documents: []`, so a ticket carrying a CV is submitted as prose alone. The
 * readout compares the ticket's manifest digests against the RUN's, so it reports
 * that drop today and will report `true` the day the submission path carries them
 * — with nothing here edited.
 *
 * FOUR STATES, AND TWO OF THEM ARE THE CONTROLS a one-armed version would miss:
 * a ticket with nothing to carry must read `null` rather than `false`, and a
 * manifest that EXISTS AND WILL NOT PARSE must read `unreadable` rather than
 * zero attachments — `readReferenceManifest` flattens those two and this readout
 * is the one place that must not.
 */
test("the readout says whether a ticket's attachments reached its run, and when it cannot tell", async () => {
  const h = await startHarness(true);
  try {
    const docBytes = Buffer.alloc(4096, "c".charCodeAt(0));
    const filed = (await (
      await fileTicket(h.base, {
        ticketText: "a CV site from the attached CV",
        modelId: "opus[1m]",
        documents: [`data:application/pdf;base64,${docBytes.toString("base64")}`],
      })
    ).json()) as ApiSupervisorTicketFiled;

    // STATE ONE: attachments, no run yet. NOT `false` — nothing has had the chance
    // to drop them.
    const before = await readQueue(h.base);
    assert.equal(before.tickets[0]?.attachments.carriedIntoRun, null, "a ticket with no run claimed a verdict");
    assert.equal(before.probe.attachmentsDropped, 0);

    // STATE TWO: a run exists and its manifest does NOT list the digest — DROPPED.
    // This is what `createSupervisorSubmit` produces today.
    seedRun(h.store, "run-without-the-cv", "2026-08-10T05:00:00.000Z");
    h.store.updateSupervisorTicket(filed.ticketKey, { state: "running", currentRunId: "run-without-the-cv" });
    const dropped = await readQueue(h.base);
    assert.equal(
      dropped.tickets[0]?.attachments.carriedIntoRun,
      false,
      "the readout cannot see that the run was submitted without the CV",
    );
    assert.equal(dropped.probe.attachmentsDropped, 1);

    /*
     * STATE TWO AND A HALF, AND IT IS THE ARM A MUTATION FOUND MISSING. The run
     * now HAS a manifest and it lists a DIFFERENT document. Without this case the
     * `false` above is produced by "the run has no manifest at all", so a probe
     * that skipped the digest comparison entirely and answered `true` whenever a
     * manifest existed passed every other assertion here — measured, 2026-08-10.
     */
    const runRefs = referenceDirFor(h.paths.runs, "run-without-the-cv");
    mkdirSync(runRefs, { recursive: true });
    writeReferenceManifest(runRefs, {
      images: [],
      capture: null,
      documents: [
        {
          path: join(runRefs, "..", "documents", "someone-elses.pdf"),
          sha256: sha256Of(Buffer.alloc(4096, "z".charCodeAt(0))),
          bytes: 4096,
          mediaType: "application/pdf",
        },
      ],
      motion: null,
    });
    const wrongFile = await readQueue(h.base);
    assert.equal(
      wrongFile.tickets[0]?.attachments.carriedIntoRun,
      false,
      "a run carrying a DIFFERENT document read as carrying the ticket's CV",
    );

    // STATE THREE: the run's manifest carries the same digest — CARRIED. The
    // positive control, and the shape the submission path has to produce.
    writeReferenceManifest(runRefs, {
      images: [],
      capture: null,
      documents: [
        {
          path: join(runRefs, "..", "documents", "document-1.pdf"),
          sha256: sha256Of(docBytes),
          bytes: docBytes.byteLength,
          mediaType: "application/pdf",
        },
      ],
      motion: null,
    });
    const carried = await readQueue(h.base);
    assert.equal(carried.tickets[0]?.attachments.carriedIntoRun, true, "a run carrying the digest still read as dropped");
    assert.equal(carried.probe.attachmentsDropped, 0);

    // STATE FOUR: the TICKET's manifest exists and will not parse. `unreadable`,
    // never "no attachments" — the distinction the manifest reader flattens.
    const ticketRefs = referenceDirFor(ticketAttachmentRoot(h.paths.runs), filed.ticketKey);
    writeFileSync(join(ticketRefs, "references.json"), "{ this is not json", "utf8");
    const blind = await readQueue(h.base);
    assert.equal(blind.tickets[0]?.attachments.manifest, "unreadable", "a corrupt manifest read as no attachments");
    assert.equal(blind.tickets[0]?.attachments.documents, 0);
    assert.equal(blind.tickets[0]?.attachments.carriedIntoRun, null, "an unreadable manifest cannot judge the run");
    assert.equal(blind.probe.manifestsUnreadable, 1);

    // AND THE CONTROL FOR THAT CONTROL: a ticket that attached nothing reads
    // `none`, not `unreadable`, and its verdict is `null` rather than `false`.
    const bare = (await (await fileTicket(h.base, { ticketText: "no attachments here", modelId: "opus[1m]" })).json()) as ApiSupervisorTicketFiled;
    const both = await readQueue(h.base);
    const bareRow = both.tickets.find((row) => row.ticketKey === bare.ticketKey);
    assert.equal(bareRow?.attachments.manifest, "none");
    assert.equal(bareRow?.attachments.carriedIntoRun, null, "a ticket with nothing to carry read as dropped");
    assert.equal(both.probe.manifestsUnreadable, 1, "the bare ticket was counted as unreadable");
  } finally {
    await h.close();
  }
});

/**
 * `captureUrl` AND `motionUrl` — READ ONCE, AT FILING TIME, AND FROZEN.
 *
 * WHY AT FILING TIME AND NOT AT SUBMISSION. `supervisor-boot.ts` states the
 * constraint: a capture is a live network read, so two attempts at the same
 * ticket would fold two different outlines into the brief, mint two different
 * ticket ids, find no frozen acceptance suite and pay for a second spec phase.
 * Its docblock's own remedy is "a supervisor ticket that needs a captured page
 * must carry the outline in its text" — which is what this route now does: the
 * reading is composed into `ticket_text` ONCE, so every attempt submits the same
 * bytes.
 *
 * THE IDEMPOTENCE ASSERTION IS THE LOAD-BEARING ONE. `createSupervisorSubmit`
 * re-composes the stored text through `ticketWithReferences` with a null capture;
 * `composeBrief` returns the prose unchanged in that case, so re-composition must
 * be a no-op. If it ever double-wraps, every supervisor retry mints a new id.
 *
 * THREE ARMS ON THE SCAN: an explicit `captureUrl`, a URL found in the brief, and
 * the `null` opt-out on the SAME brief. The stub counts calls, so "nothing was
 * captured" is provable rather than assumed.
 */
test("a captured page and a motion reading are frozen into the ticket at filing time", async () => {
  const h = await startHarness(true, {
    capture: (url) => ({
      url,
      capturedAt: "2026-08-10T06:00:00.000Z",
      shots: [],
      outline: { url, title: "Kamil Borzecki", headings: [{ level: 1, text: "Selected work" }], links: ["About"], palette: ["#101010"] },
    }),
    motion: (url) => ({ url, capturedAt: "2026-08-10T06:00:00.000Z", observations: [], libraries: ["framer-motion"], respectsReducedMotion: true }),
  });
  try {
    const filed = (await (
      await fileTicket(h.base, {
        ticketText: "copy this portfolio",
        modelId: "opus[1m]",
        captureUrl: "https://example.com/",
        motionUrl: "https://example.com/motion",
      })
    ).json()) as ApiSupervisorTicketFiled;
    assert.deepEqual(h.captures.sites, ["https://example.com/"], "the capture seam was not asked for the named page");
    assert.deepEqual(h.captures.motions, ["https://example.com/motion"]);
    assert.equal(filed.attachments.capture, true);
    // A READING WITH NO ENTRIES IS STILL A READING — `null` means no page was
    // read, an empty spec means nothing moved. The two must not collapse.
    assert.equal(filed.attachments.motion, true, "a motion reading with no entries was dropped");

    const stored = h.store.getSupervisorTicket(filed.ticketKey);
    assert.notEqual(stored, null);
    assert.match(
      stored?.ticketText ?? "",
      new RegExp(CAPTURE_BLOCK_BEGIN.replace(/[-]/g, "\\$&")),
      "the page reading is not in the text the loop will submit",
    );
    assert.match(stored?.ticketText ?? "", /Selected work/, "the outline's heading did not reach the brief");

    // THE IDEMPOTENCE OF THE RE-COMPOSITION — what keeps every retry on one id.
    const submitted = ticketWithReferences({ prose: stored?.ticketText ?? "", images: [], documents: [], capture: null, motion: null });
    assert.equal(submitted.brief, stored?.ticketText, "re-composing the stored brief changed it, so every retry mints a new id");
    assert.equal(
      ticketWithReferences({ prose: stored?.ticketText ?? "", images: [], documents: [], capture: null, motion: null }).id,
      submitted.id,
      "the id is not stable across two submissions of one ticket",
    );

    // The manifest holds the reading, so a submission can re-attach it.
    const manifest = readReferenceManifest(referenceDirFor(ticketAttachmentRoot(h.paths.runs), filed.ticketKey));
    assert.equal(manifest?.capture?.url, "https://example.com/");
    assert.equal(manifestMotion(manifest)?.url, "https://example.com/motion");

    // ARM TWO: a URL in the BRIEF is scanned for, exactly as POST /api/runs does.
    const scanned = (await (
      await fileTicket(h.base, { ticketText: "make a copy of https://example.com/scanned please", modelId: "opus[1m]" })
    ).json()) as ApiSupervisorTicketFiled;
    assert.deepEqual(h.captures.sites, ["https://example.com/", "https://example.com/scanned"]);
    assert.equal(scanned.attachments.capture, true);

    // ARM THREE: `captureUrl: null` on a brief that names a page suppresses the
    // scan entirely, and NOTHING is captured. Without this arm the two above are
    // satisfied by a route that captures unconditionally.
    const optedOut = (await (
      await fileTicket(h.base, {
        ticketText: "do NOT read https://example.com/opted-out, just build from the brief",
        modelId: "opus[1m]",
        captureUrl: null,
      })
    ).json()) as ApiSupervisorTicketFiled;
    assert.equal(h.captures.sites.length, 2, "the opt-out still opened the page");
    assert.equal(optedOut.attachments.capture, false);
    assert.equal(optedOut.attachments.motion, false, "a ticket that named no motion reference got one");
  } finally {
    await h.close();
  }
});

/**
 * THE THIRD ARM OF THE BOOT ARM CHECK: DOES THE TICKET KEY SEE ATTACHMENTS?
 *
 * WHY AN ARM AND NOT ONLY A TEST. The key derivation's failure mode is silent and
 * expensive: a key that ignored the attachment digests would answer 409 to the
 * owner's corrected CV — a REFUSAL that looks exactly like the duplicate guard
 * working — and every "does it 201" test in this file would stay green. The arm
 * drives the derivation with and without a digest and reports whether the two
 * answers differ, in the idiom of the composer arm above.
 *
 * IT MUST BE ABLE TO SAY BLIND. Asserted by the mutation recorded in this round's
 * report: dropping the digests from the material collapses the two keys to one
 * and the boot line reads `BLIND: the ticket key ignores attachments`.
 */
test("the boot arm check measures the ticket key against attachments and the ticket manifests", async () => {
  const h = await startHarness(true);
  try {
    await fileTicket(h.base, {
      ticketText: "a ticket with a manifest",
      modelId: "opus[1m]",
      documents: [pdfDataUrl(512, "m")],
    });
    const lines: string[] = [];
    const armed = armSupervisorRoute(h.store, undefined, (line) => lines.push(line), h.paths);
    const keyLine = lines.find((line) => line.includes("ticket key"));
    assert.notEqual(keyLine, undefined, `no arm check line named the ticket key: ${lines.join(" | ")}`);
    assert.match(String(keyLine), /folds attachments/, `the key arm reported blind: ${String(keyLine)}`);
    assert.doesNotMatch(String(keyLine), /BLIND/);
    assert.equal(armed.armed, true);

    // AND IT READS THE REAL DIRECTORY, so a boot on a tree whose manifests are
    // corrupt says so rather than reporting a healthy queue.
    const intake = lines.find((line) => line.includes("ticket intake"));
    assert.match(String(intake), /1 ticket\(s\) with attachments, 0 unreadable/, `the intake arm did not measure: ${String(intake)}`);

    /*
     * AND THE BLIND ARM REACHES THE WIRE — the arm that could not look must not be
     * indistinguishable from the arm that looked and found nothing wrong.
     *
     * MEASURED: dropping `deps.paths` at the one call site in
     * `createDashboardServer` failed NO test, because this test calls the function
     * directly. Both halves are asserted: with no paths the note says so, and the
     * running server's own `probe.armNote` does not.
     */
    const blind = armSupervisorRoute(h.store, undefined, (line) => lines.push(line));
    assert.match(blind.armNote, /ticket intake BLIND: no runs root was passed/, `a blind arm four is invisible: ${blind.armNote}`);
    const wire = await readQueue(h.base);
    assert.doesNotMatch(wire.probe.armNote, /BLIND/, `the running server's arm four never looked: ${wire.probe.armNote}`);
    assert.equal(wire.probe.armed, true);
  } finally {
    await h.close();
  }
});
