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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ApiSupervisorCommandResponse, ApiSupervisorState } from "./api-types.js";
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
} from "./http.js";
import type { RunController, SupervisorComposerInput, SupervisorController } from "./http.js";
import { CATALOG_FALLBACK_MODEL_ID, CODEX_DEFAULT_MODEL_ID, ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { SupervisorLoop } from "./supervisor.js";
import { ensureDirs, resolvePaths } from "./paths.js";

const NO_MODELS: readonly ModelInfo[] = [];

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
  close(): Promise<void>;
}

/**
 * @param wired false builds the server with NO loop — the third state the
 * surface has to be able to show, and the one a 503 on the GET would have
 * hidden behind "the dashboard is down".
 */
async function startHarness(wired: boolean): Promise<Harness> {
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

  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    // Never spawn docker from a routing test; see `api.test.ts`.
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
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

    const running = (await (await fetch(`${wired.base}/api/supervisor`)).json()) as ApiSupervisorState;
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
    const idle = (await (await fetch(`${wired.base}/api/supervisor`)).json()) as ApiSupervisorState;
    assert.equal(idle.desired, "stopped");
    assert.equal(idle.ticket, null);
    assert.equal(idle.run, null, "no ticket in flight means no run, and no clock");
    assert.match(idle.nextAction, /stopped, and nothing is queued/);
    assert.equal(idle.probe.wired, true);

    // STATE THREE: nothing behind the route at all. 200, NOT 503 — a 503 reads
    // to a client exactly like "the dashboard is down", and this is the one
    // state the owner most needs to be able to tell apart.
    const response = await fetch(`${unwired.base}/api/supervisor`);
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

    const stalled = (await (await fetch(`${harness.base}/api/supervisor`)).json()) as ApiSupervisorState;
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
    const alive = (await (await fetch(`${harness.base}/api/supervisor`)).json()) as ApiSupervisorState;
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

    const response = await fetch(`${harness.base}/api/supervisor/stop`, { method: "POST" });
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
      await fetch(`${harness.base}/api/supervisor/stop`, { method: "POST" })
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
      await fetch(`${harness.base}/api/supervisor/start`, { method: "POST" })
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
    await fetch(`${harness.base}/api/supervisor`);
    await fetch(`${harness.base}/api/supervisor`);
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

    const refused = await fetch(`${harness.base}/api/supervisor/abort-now`, { method: "POST" });
    assert.equal(refused.status, 400);
    const error = (await refused.json()) as Record<string, unknown>;
    assert.equal(error["error"], "confirm_required");
    assert.match(String(error["remediation"]), /\/api\/supervisor\/stop/, "and it names the safe alternative");

    /* WITH a confirm it still does not abort, and that is the current honest
     * answer rather than a gap: cancelling the run without moving its ticket to
     * `blocked` would leave the next START re-spending on the run the owner just
     * killed, and the ticket writer belongs to the loop. A 501 naming the
     * missing half beats a half-done abort. */
    const confirmed = await fetch(`${harness.base}/api/supervisor/abort-now`, {
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

test("the supervisor POSTs refuse a foreign Origin and allow an absent one", async () => {
  const harness = await startHarness(true);
  try {
    const foreign = await fetch(`${harness.base}/api/supervisor/start`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    assert.equal(((await foreign.json()) as Record<string, unknown>)["error"], "cross_origin_write");
    assert.equal(harness.store.readSupervisorState().desired, "stopped", "a refused command changes nothing");
    assert.equal(harness.calls.ticks, 0);

    // BOTH ALLOWED ARMS, because a guard that refuses everything is as broken as
    // one that refuses nothing: curl and the cron tick send no Origin at all,
    // and the dashboard's own page sends a loopback one.
    assert.equal((await fetch(`${harness.base}/api/supervisor/start`, { method: "POST" })).status, 200);
    const own = await fetch(`${harness.base}/api/supervisor/stop`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4319" },
    });
    assert.equal(own.status, 200);
    assert.equal(harness.store.readSupervisorState().desired, "draining");
  } finally {
    await harness.close();
  }
});

test("with no loop wired the commands refuse 503 and write nothing; the GET still answers 200", async () => {
  const harness = await startHarness(false);
  try {
    for (const action of ["start", "stop"]) {
      const response = await fetch(`${harness.base}/api/supervisor/${action}`, { method: "POST" });
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
    const abort = await fetch(`${harness.base}/api/supervisor/abort-now`, { method: "POST" });
    assert.equal(abort.status, 400);
    assert.equal(((await abort.json()) as Record<string, unknown>)["error"], "confirm_required");

    assert.equal((await fetch(`${harness.base}/api/supervisor`)).status, 200);
    assert.equal((await fetch(`${harness.base}/api/supervisor/nonsense`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${harness.base}/api/supervisor/start`)).status, 404, "GET is not a command");
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
    const before = await fetch(`${h.base}/api/supervisor/tickets`, {
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
    fetch(`${h.base}/api/supervisor/tickets`, {
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
    const answer = await fetch(`${h.base}/api/supervisor/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketText: "file this while nothing is wired", modelId: "opus[1m]" }),
    });
    assert.equal(answer.status, 201, `filing against an unwired server answered ${String(answer.status)}`);
    assert.equal(h.store.listSupervisorTickets(["queued"]).length, 1);

    // NEGATIVE HALF: start/stop on the SAME unwired server still refuse, so this
    // is a considered difference between the two routes and not a lost guard.
    const started = await fetch(`${h.base}/api/supervisor/start`, { method: "POST" });
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
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function file(base: string, ticketText: string, modelId: string): Promise<Response> {
  return fetch(`${base}/api/supervisor/tickets`, {
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
      (await (await fetch(`${h.base}/api/models`)).json() as readonly { readonly id: string }[])
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
    const models = (await (await fetch(`${h.base}/api/models`)).json()) as readonly {
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
