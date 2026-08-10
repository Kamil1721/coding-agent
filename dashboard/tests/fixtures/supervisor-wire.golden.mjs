/**
 * THE GENERATOR FOR `supervisor-wire.golden.json`, CHECKED IN BESIDE IT.
 *
 * WHY THE GOLDEN IS GENERATED AND NOT WRITTEN. `dashboard/src/lib/api-types.ts`
 * mirrors `server/src/api-types.ts` by hand, and on 2026-08-10 the mirror
 * disagreed with the wire in fifteen fields: the strip read amber `MALFORMED` on
 * every route against the real server, three typecheckers passed (nothing imports
 * both declarations), and both suites were green (the fixture API serves no
 * `/api/supervisor`). A HAND-WRITTEN golden would have been a third copy of the
 * same guess and would have agreed with whichever side its author read.
 *
 * So this runs the server's own `composeSupervisorState` — the function the route
 * calls — and prints what it produces. The output is pinned from BOTH ends:
 *
 *   server/src/supervisor-route.test.ts   deep-equals the composer against the
 *                                         golden, so SERVER drift goes red there
 *   tests/supervisor-strip.unit.spec.ts   classifies the golden through the real
 *                                         client classifier, so MIRROR drift goes
 *                                         red there
 *   tests/supervisor-strip.browser.spec.ts serves the golden to the real client in
 *                                         a real browser
 *
 * THREE BODIES, AND THEY MUST CLASSIFY THREE DIFFERENT WAYS — idle, running,
 * unreachable. One body would prove the shape and not the discrimination, which is
 * this repository's signature defect: a check that can only observe success.
 * `claimed` is the load-bearing one, because it is the only one whose `ticket` and
 * `run` objects are non-null, and a mirror that invents a nested field (the first
 * one invented `ticket.currentRunId`) only fails on a body that HAS a ticket.
 *
 * TO REGENERATE, from `dashboard/server`:
 *   npm run build --silent
 *   node ../tests/fixtures/supervisor-wire.golden.mjs > ../tests/fixtures/supervisor-wire.golden.json
 *
 * It reads `server/dist`, i.e. build output, ON PURPOSE and only here: a TEST that
 * imported `dist` could pass against a stale build, which is why the tests read the
 * checked-in JSON instead.
 */

import { composeSupervisorState } from "../../server/dist/http.js";

const state = {
  desired: "running",
  changedAt: "2026-08-10T02:00:00.000Z",
  changedBy: "owner",
  reason: "the owner pressed start",
};

/** Wired, stopped, nothing queued. Must read `idle`. */
const idle = composeSupervisorState({
  state: { ...state, desired: "stopped", reason: "the owner pressed stop" },
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
});

/**
 * A REAL TICKET FROM THE SUPERVISOR PROOF RUN, not an invented key: the gate
 * filed `t-b17e54c98f1a0617` and watched the loop drive it to a real run.
 * `composeSupervisorState` reads five of these fields and titles the brief itself.
 */
const ticket = {
  ticketKey: "t-b17e54c98f1a0617",
  ticketText: "a portfolio site for a ceramicist, with a booking form",
  modelId: "haiku",
  designLock: "auto",
  state: "running",
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

/** Claimed, with a run and a 42 s clock. Must read `running`. */
const claimed = composeSupervisorState({
  state,
  activeTicket: ticket,
  run: {
    runId: "run-2026-08-10T11-19-00-192Z-36f87c2b",
    phase: "spec",
    status: "running",
  },
  quietForMs: 42_000,
  queueDepth: 1,
  ticketsSeen: 2,
  queuedRuns: 0,
  runsSeen: 6,
  eventsSeen: 412,
  wired: true,
  armed: true,
  armNote: "composer renders 3 distinguishable states",
  at: "2026-08-10T03:00:00.000Z",
});

/**
 * THE ROUTE IS UP AND NOTHING IS BEHIND IT — `desired` says running and no loop
 * exists to claim anything. Must read `unreachable`, never `running`: every field
 * beside `probe` is a default nobody chose.
 */
const notWired = composeSupervisorState({
  state: { ...state, changedBy: "boot", reason: "boot default" },
  activeTicket: null,
  run: null,
  quietForMs: null,
  queueDepth: 2,
  ticketsSeen: 2,
  queuedRuns: 0,
  runsSeen: 6,
  eventsSeen: 0,
  wired: false,
  armed: true,
  armNote: "arming",
  at: "2026-08-10T03:00:00.000Z",
});

process.stdout.write(`${JSON.stringify({ idle, claimed, notWired }, null, 2)}\n`);
