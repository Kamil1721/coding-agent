/**
 * orchestrator.spec-spend.test.ts — the spec phase when it FAILS, which is the
 * only shape it has ever taken on this machine and the one no fixture could see.
 *
 * ═══ THE CORPSE ═══
 *
 * `run-2026-08-09T21-04-00-713Z-a913c871` spent 1h26m54s in `spec`, dispatched
 * three authoring attempts, burned ≈628,441 output tokens by the CLI's own
 * session logs, and left:
 *
 *   · `seat_spend` — 0 rows. As did every other run on this machine, five of
 *     them, since the table shipped.
 *   · the attempt boundaries — nowhere in the product. Recovered afterwards from
 *     the Claude Code CLI's private session transcripts, keyed by the seat's
 *     working directory.
 *   · the progress channel — 0 rows across 1,816 events / 5 runs.
 *   · seven `rate_limit` frames across a phase that ran two different seats, with
 *     nothing saying which seat any of them belonged to.
 *
 * ═══ WHY NO EXISTING TEST COULD HAVE CAUGHT ANY OF IT ═══
 *
 * `orchestrator.test.ts`'s ledger fixture (the `B5` group) calls `freezeFor(...)`
 * before the run starts, so `#specPhase` returns at its reuse branch — before a
 * `SubscriptionSeatCaller` is constructed, before `authorAndFreezeSuite` is
 * called, before any of the code below exists. `seatOf("spec")` has no matches in
 * that file. Its mutation proof passed with the production path unreachable,
 * which is this repository's signature defect wearing a green tick.
 *
 * So this file does the opposite of every other orchestrator fixture: **it
 * freezes nothing.** The run reaches the authoring path for real and dies on it
 * for real.
 *
 * ═══ WHAT IS REAL HERE, AND THE ONE THING THAT IS NOT ═══
 *
 * Real: the `Orchestrator`, `#specPhase`, both `SubscriptionSeatCaller`s, the
 * shared `SpendCeiling`, `bakeoff`'s `authorAndFreezeSuite`, its attempt loop,
 * its parse failure, the `BakeoffError` it throws, the SQLite ledger, and the
 * `graph.ts` reducer the rows are folded through.
 *
 * Not real: the SDK's `query`. It is replaced through `OrchestratorDeps.seatQuery`
 * with a factory that answers in prose carrying no JSON — the same device
 * `spec-ladder-e2e.test.ts` uses, for the same reason: the alternative is an
 * hour of the owner's subscription per assertion.
 *
 * ═══ NEGATIVE CONTROLS — APPLIED TO PRODUCTION CODE, COMPILED, RUN, WATCHED RED,
 *     REVERTED (2026-08-10) ═══
 *
 * Recorded here rather than in a report, because the claim "this test can fail"
 * is worth exactly as much as the transcript behind it, and a report is not
 * durable. Ten mutations; the verbatim first line of each RED is quoted.
 *
 *   M1  delete `#recordSpend(runId,"spec",…)` from `#specPhase`'s `finally`
 *       → 10/11 pass, 1 fail — "THE LEDGER RECORDS A SPEC PHASE THAT DIED":
 *         `the spec seat spent 3 call(s) and the ledger has no row for it.`
 *
 *   M2  move BOTH `#recordSpend` calls back out of the `finally`, to just after
 *       the `await` — i.e. put the code back exactly as `a913c871` ran it.
 *       → run together with `orchestrator.test.js`: 109 tests, 108 pass, 1 fail,
 *         and the one failure is this file's. **All four `B5:` ledger tests stay
 *         GREEN under the defect that shipped.** That is why this file exists;
 *         M1 alone would not have discriminated it from the fixture it replaces.
 *
 *   M3  `laneNeutralLogText` → `… === LANE_PROBE || true`
 *       → 2 fail: `laneNeutralLogText is answering yes to everything; the
 *         assertions above prove nothing` and `control: the fold does recognise
 *         things`. The lane-neutrality claims are not vacuous.
 *
 *   M4  drop the `#emitLog` from the spec caller's `onEvent`
 *       → "EVERY AUTHORING ATTEMPT LEAVES A ROW" fails: `one row per dispatch.
 *         a913c871 ran three authoring attempts over 84 minutes and left none`
 *
 *   M5  `authoringLadderLine`'s first-attempt guard always taken
 *       → 2 fail, incl. `The input did not match /draft 3 .*draft 2 was refused/`
 *
 *   M6  the heartbeat interval fires but emits nothing
 *       → 2 fail: `expected the pulse to fire while the call was open; got 0
 *         row(s)` and the second test's own arm check.
 *
 *   M7  the disarm stops calling `clearInterval`
 *       → "THE PULSE STOPS WHEN THE PHASE DOES" fails: `the interval was not
 *         cleared: the run is over and rows are still landing` — 22 !== 13.
 *
 *   M8  `seat` → `null` in the `rate_limit` payload
 *       → `the closure knew the seat; the payload must carry it` — null !== 'spec'
 *
 *   M9  `#reportNoCapture` never called
 *       → `the sentence both readers match must be emitted exactly once`
 *
 *   M10 `graph.ts` stops passing the failure detail on a terminal `failed`
 *       → `stage author kept its running copy after a terminal failure`
 *
 * WHAT NO MUTATION HERE PROVES: that a real model, on a real subscription, gets
 * further than this. Every dispatch below is a stub. This file is about what the
 * ORCHESTRATOR records, not about what the seat writes.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import type { SseEvent } from "./api-types.js";
import { RunStore, isTerminal } from "./db.js";
import { foldGraphAll } from "./graph.js";
import { ModelCatalog } from "./models.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import {
  Orchestrator,
  SEAT_HEARTBEAT_INTERVAL_ENV,
  authoringLadderLine,
  laneNeutralLogText,
  seatHeartbeatLine,
  specPhaseCostLine,
} from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import type { SeatSessionFactory } from "./subscription-caller.js";
import { zeroTokens } from "./tokens.js";

/**
 * A ticket with NO URL in it, deliberately — so the same run also exercises the
 * `no reference capture` emit, whose reader has had no writer since it was
 * written. Also no attached documents, so `#seatDocuments` spawns nothing.
 */
const TICKET_TEXT =
  "Build a page that lists three projects, each with a title and a one-line summary. " +
  "Store nothing; there is no database and no API.";

const USAGE = {
  input_tokens: 11,
  output_tokens: 2_222,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 5,
};

function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

/**
 * Every dispatch answers with prose carrying no JSON object, after a real delay.
 *
 * UNPARSEABLE RATHER THAN WRONG-SHAPED, and the difference is deliberate. A
 * manifest with a missing field would exercise `bakeoff`'s validator, which is
 * the other lane's subject and moves the scorer digest. What this file is about
 * is what the ORCHESTRATOR does when authoring ends in a throw, and any throw
 * from `authorAndFreezeSuite` reaches the same `finally`.
 *
 * THE DELAY IS LOAD-BEARING, NOT PADDING. With `DASHBOARD_SEAT_HEARTBEAT_MS` set
 * to a few milliseconds it is what puts a heartbeat inside the call, which is the
 * only way to observe a timer that is armed before an await and cleared after it.
 *
 * THE `rate_limit_event` FRAME IS ALSO LOAD-BEARING. It is the SDK's routine
 * window telemetry (`status: "allowed"`, i.e. NOT a refusal — the distinction
 * `api-types.ts` records a run for), and it is the only way the seat attribution
 * added to that event can be observed at all.
 */
function unparseable(delayMs: number): { factory: SeatSessionFactory; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      yield envelope({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: Math.floor(Date.now() / 1000) + 600,
          rateLimitType: "five_hour",
          utilization: 0.4,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield envelope({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "I would rather describe it." }] },
      });
      yield envelope({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "I would rather describe it.",
        usage: USAGE,
      });
    })();
  };
  return { factory, dispatches };
}

interface DeadSpecRun {
  readonly store: RunStore;
  readonly runId: string;
  readonly dispatches: readonly Dispatch[];
  readonly logs: readonly string[];
  readonly events: readonly { type: string; payload: Record<string, unknown> }[];
  /** The same rows, in the shape `foldGraphAll` takes. */
  readonly wire: readonly SseEvent[];
  readonly cleanup: () => void;
}

/**
 * One run, driven to a real death in the spec phase.
 *
 * `interactive: false` so the plan phase records "nobody was there to answer" and
 * returns WITHOUT a seat call — the phase under test has to be the one that
 * spends. No `freezeFor`, so the reuse branch declines and the authoring path is
 * entered. Empty `PATH`, so nothing downstream can find docker.
 */
async function deadSpecRun(options: {
  delayMs: number;
  heartbeatMs?: number;
  ticketText?: string;
}): Promise<DeadSpecRun> {
  const dir = mkdtempSync(join(tmpdir(), "dash-spec-spend-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const { factory, dispatches } = unparseable(options.delayMs);

  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview,
    env: {
      HOME: dir,
      PATH: "",
      ...(options.heartbeatMs === undefined
        ? {}
        : { [SEAT_HEARTBEAT_INTERVAL_ENV]: String(options.heartbeatMs) }),
    },
    gateReadiness: READY_GATE_READINESS,
    seatQuery: factory,
  });

  const runId = "run-spec-death";
  store.createRun({
    runId,
    ticketId: "seeded-at-create",
    ticketTitle: "Three projects",
    ticketText: options.ticketText ?? TICKET_TEXT,
    ticketSha256: "c".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    interactive: false,
  });

  orchestrator.pump();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = store.getRun(runId);
    if (row !== null && isTerminal(row.status)) break;
    if (Date.now() > deadline) {
      throw new Error(`the run never reached a terminal status (last: ${store.getRun(runId)?.status ?? "gone"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await orchestrator.shutdown();

  const stored = store.eventsSince(runId, 0);
  const events = stored.map((row) => ({
    type: String((row.event as unknown as { type: unknown }).type),
    payload: row.event as unknown as Record<string, unknown>,
  }));
  const logs = events
    .filter((event) => event.type === "log")
    .map((event) => String(event.payload["text"] ?? ""));
  const wire = stored.map((row) => row.event);

  return {
    store,
    runId,
    dispatches,
    logs,
    events,
    wire,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * N2 — the ledger
 * ══════════════════════════════════════════════════════════════════════════ */

test("THE LEDGER RECORDS A SPEC PHASE THAT DIED — the row a913c871 never got", async () => {
  const run = await deadSpecRun({ delayMs: 1 });
  try {
    const row = run.store.getRun(run.runId);
    assert.equal(row?.status, "failed", "the fixture must reach the failure path, not the success path");
    assert.match(
      row?.failureReason ?? "",
      /suite_not_audited/,
      "and it must die in AUTHORING — a fixture that died in, say, document intake would prove nothing " +
        "about the seats, because neither caller would have dispatched",
    );

    /*
     * THE ARM CHECK, AND IT COMES BEFORE THE ASSERTION IT ARMS. `#recordSpend`
     * no-ops on `callCount <= 0`, so a fixture that threw before the first
     * dispatch would produce no row and this test would pass for the exact
     * reason it exists to forbid: a check that can only observe success. So the
     * spend is proved to be NON-ZERO first, from the dispatch count, and only
     * then is the ledger asked about it.
     */
    assert.equal(
      run.dispatches.length,
      3,
      "the authoring loop must actually dispatch (3 attempts is bakeoff's DEFAULT_MAX_AUTHORING_ATTEMPTS); " +
        "with zero dispatches there is no spend to record and the ledger assertion below is vacuous",
    );

    const seats = run.store.listSeatSpend(run.runId);
    const spec = seats.find((seat) => seat.seat === "spec");
    assert.notEqual(
      spec,
      undefined,
      `the spec seat spent ${String(run.dispatches.length)} call(s) and the ledger has no row for it. ` +
        "This is the a913c871 defect: the writes sit below an await that threw.",
    );
    assert.equal(spec?.callCount, 3, "every attempt is on the row, not just the last one");
    assert.equal(spec?.tokens.outputTokens, USAGE.output_tokens * 3, "summed across the attempts");
    assert.equal(spec?.tokens.inputTokens, USAGE.input_tokens * 3);

    // THE DELIBERATE INVARIANT, ASSERTED RATHER THAN ASSUMED. A subscription call
    // has no per-token price and this system has no price table; a `finally`
    // changes WHEN the row is written and must never change WHAT it says. The
    // check is on the KEYS, because `ApiSeatSpend` has no money member to compare
    // against — which is the invariant, and this catches an untyped one arriving
    // through the store.
    assert.deepEqual(
      Object.keys(spec ?? {})
        .filter((key) => /cost|usd|price|dollar/i.test(key))
        .sort(),
      [],
      "no price may be invented on the failure path either",
    );

    // AND THE SEAT THAT NEVER RAN GETS NO ROW. The parse fails before the draft
    // reaches the auditor, so the judge caller dispatched nothing —
    // `#recordSpend`'s `callCount <= 0` guard has to hold inside the `finally`
    // too, or every failed run acquires a phantom audit row of zeroes.
    assert.equal(
      seats.find((seat) => seat.seat === "audit"),
      undefined,
      "a seat that made no call is not the same fact as a seat that made a call costing nothing",
    );
  } finally {
    run.cleanup();
  }
});

test("the failure path's cost row does NOT claim the tests were written", async () => {
  const run = await deadSpecRun({ delayMs: 1 });
  try {
    const cost = run.logs.filter((text) => text.startsWith("the spec phase stopped without"));
    assert.equal(cost.length, 1, "one row, on the path that produced no suite");

    /*
     * THE REASON THIS ROW IS NOT `spec seat — …`.
     *
     * The fix was filed as "move the two `describeTokens` lines into the
     * finally". Done literally, the failure path would emit `spec seat — …`,
     * which `graph.ts` folds with `/^spec seat —/i` into "the AUTHOR stage
     * finished" — so a run that authored nothing would render "Writing the
     * tests — done". The fold below is the real reducer, not a copy of its
     * regexes, and it is asserted on the string production actually emitted.
     */
    assert.equal(
      run.logs.some((text) => /^spec seat —/i.test(text)),
      false,
      "the folding sentence belongs to the success path only",
    );
    assert.equal(
      run.logs.some((text) => /^audit seat —/i.test(text)),
      false,
    );
    for (const text of cost) {
      assert.equal(laneNeutralLogText(text), true, `this row must not move the pre-build lane: ${text}`);
    }

    // THE CONTROL FOR THE CONTROL. If `laneNeutralLogText` were vacuously true,
    // every assertion above would pass against a row that flips a stage. A
    // sentence the fold DOES recognise must come back false.
    assert.equal(
      laneNeutralLogText("spec seat — 3 call(s)"),
      false,
      "laneNeutralLogText is answering yes to everything; the assertions above prove nothing",
    );

    // AND THE STAGE ITSELF, THROUGH THE REDUCER THE FINISHED-RUN CANVAS USES.
    const graph = foldGraphAll(run.wire);
    const author = graph.stages?.find((stage) => stage.id === "author");
    assert.notEqual(author, undefined, "the pre-build lane must exist on a run that reached the spec phase");
    assert.notEqual(
      author?.state,
      "done",
      "a run that never sealed a suite must not render its authoring stage as finished",
    );
  } finally {
    run.cleanup();
  }
});

test("specPhaseCostLine reports BOTH seats, including one that never called", () => {
  const line = specPhaseCostLine(zeroTokens("anthropic"), zeroTokens("anthropic"));
  assert.match(line, /writing: /);
  assert.match(line, /checking: /);
  assert.equal(laneNeutralLogText(line), true);
});

/* ══════════════════════════════════════════════════════════════════════════
 * N5 — the audit ladder
 * ══════════════════════════════════════════════════════════════════════════ */

test("EVERY AUTHORING ATTEMPT LEAVES A ROW — the boundary that needed CLI forensics", async () => {
  const run = await deadSpecRun({ delayMs: 1 });
  try {
    const ladder = run.logs.filter((text) => /^seat call \d+ of this phase:/.test(text));
    assert.equal(
      ladder.length,
      3,
      "one row per dispatch. a913c871 ran three authoring attempts over 84 minutes and left none:\n" +
        run.logs.join("\n"),
    );
    assert.match(ladder[0] ?? "", /first draft/, "the first row must not accuse anyone of a refusal");
    assert.match(
      ladder[1] ?? "",
      /draft 2 .*was refused/,
      "the second row is the one that would have let the owner kill the run at 21:31 instead of 22:31",
    );
    assert.match(ladder[2] ?? "", /draft 3 .*was refused/);

    // WHAT THE ROW MAY NOT DO IS GUESS. The refusal findings live inside bakeoff
    // and reach this process only on the success path, so the row says the
    // reason is not carried rather than inventing one.
    assert.match(ladder[1] ?? "", /reason is not carried/);

    for (const text of ladder) {
      assert.equal(laneNeutralLogText(text), true, `a ladder row must not move the pre-build lane: ${text}`);
    }
  } finally {
    run.cleanup();
  }
});

test("authoringLadderLine reads the purpose strings bakeoff actually emits", () => {
  // Copied from `bakeoff/src/spec-agent.ts:918` and `:1019`. If those change, the
  // rows degrade to the neutral wording rather than lying — asserted below.
  assert.match(authoringLadderLine(1, "suite-authoring t-abc attempt 1"), /first draft/);
  assert.match(authoringLadderLine(4, "suite-authoring t-abc attempt 3"), /draft 3 .*draft 2 was refused/);
  assert.match(authoringLadderLine(2, "suite-audit t-abc"), /bad-test check/);
  assert.match(authoringLadderLine(9, "something nobody has written yet"), /first draft/);
  assert.match(authoringLadderLine(9, "something nobody has written yet"), /^seat call 9 /);
});

/* ══════════════════════════════════════════════════════════════════════════
 * R1 — the heartbeat
 * ══════════════════════════════════════════════════════════════════════════ */

test("A SEAT CALL IN FLIGHT HAS A PULSE, and it does not depend on the model streaming", async () => {
  // The delay is inside the SDK stream, i.e. inside the await the heartbeat
  // brackets, and NOTHING is streamed during it. That is the exact condition
  // under which the delta-driven progress channel has emitted 0 rows in 1,816
  // events, so a row appearing here can only have come from the timer.
  const run = await deadSpecRun({ delayMs: 120, heartbeatMs: 20 });
  try {
    const beats = run.logs.filter((text) => /has been running for .* and has not come back yet/.test(text));
    assert.ok(
      beats.length >= 2,
      `expected the pulse to fire while the call was open; got ${String(beats.length)} row(s):\n` +
        run.logs.join("\n"),
    );
    for (const text of beats) {
      assert.equal(laneNeutralLogText(text), true, `a heartbeat must not move the pre-build lane: ${text}`);
      // IT MAY NOT CLAIM HEALTH. A timer knows the call is open and nothing else.
      assert.match(text, /not a report from the model/);
    }
  } finally {
    run.cleanup();
  }
});

test("THE PULSE STOPS WHEN THE PHASE DOES — a timer that outlives its call is a lie", async () => {
  const run = await deadSpecRun({ delayMs: 60, heartbeatMs: 15 });
  try {
    const before = run.logs.filter((text) => /has not come back yet/.test(text)).length;
    assert.ok(before >= 1, "arm check: the pulse must have fired at all, or the wait below proves nothing");
    // Long enough for several more ticks had the interval survived the `finally`.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = run.store
      .eventsSince(run.runId, 0)
      .map((row) => String((row.event as unknown as { text?: unknown }).text ?? ""))
      .filter((text) => /has not come back yet/.test(text)).length;
    assert.equal(after, before, "the interval was not cleared: the run is over and rows are still landing");
  } finally {
    run.cleanup();
  }
});

test("seatHeartbeatLine is inert against the real fold, and the fold is not vacuous", () => {
  const line = seatHeartbeatLine("writing and checking the acceptance tests", 84 * 60 * 1000 + 31_000);
  assert.match(line, /1h?|84m/, "the elapsed figure is the part that cannot be dropped");
  assert.equal(laneNeutralLogText(line), true);
  assert.equal(laneNeutralLogText("sealed suite abc… frozen"), false, "control: the fold does recognise things");
});

/* ══════════════════════════════════════════════════════════════════════════
 * R2 — which seat the provider was answering
 * ══════════════════════════════════════════════════════════════════════════ */

test("A RATE-LIMIT FRAME NAMES ITS SEAT — seven anonymous rows were one of a913c871's dead ends", async () => {
  const run = await deadSpecRun({ delayMs: 1 });
  try {
    const limits = run.events.filter((event) => event.type === "rate_limit");
    assert.equal(limits.length, 3, `one per dispatch; got:\n${JSON.stringify(limits, null, 2)}`);
    for (const frame of limits) {
      assert.equal(frame.payload["seat"], "spec", "the closure knew the seat; the payload must carry it");
      // THE FIELD THAT WAS MISSING FOR THIS EVENT'S WHOLE LIFE STAYS CORRECT.
      // `status: "allowed"` is a window filling, not a refusal, and rendering it
      // as a refusal is a measured past regression.
      assert.equal(frame.payload["limited"], false);
    }
    assert.equal(
      run.store.getRun(run.runId)?.rateLimited,
      false,
      "and routine telemetry must not park the run",
    );
  } finally {
    run.cleanup();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * R3 — the reader that had no writer
 * ══════════════════════════════════════════════════════════════════════════ */

test("A TICKET THAT NAMES NO PAGE SAYS SO, and the stage settles", async () => {
  const run = await deadSpecRun({ delayMs: 1 });
  try {
    const rows = run.logs.filter((text) => /no reference capture/i.test(text));
    assert.equal(rows.length, 1, `the sentence both readers match must be emitted exactly once:\n${run.logs.join("\n")}`);

    // THROUGH THE REAL REDUCER, ON THE REAL ROW. `graph.ts:455` and
    // `dashboard/src/lib/spec-pipeline.ts:123` have matched this since they were
    // written and nothing has ever emitted it, so `capture` sat at `pending`
    // forever on every ticket without a URL.
    const graph = foldGraphAll(run.wire);
    const capture = graph.stages?.find((stage) => stage.id === "capture");
    assert.equal(
      capture?.state,
      "skipped",
      `"Reading the reference page" must settle on a ticket that names no page; it read ` +
        `${String(capture?.state)}`,
    );
  } finally {
    run.cleanup();
  }
});

test("NEGATIVE CONTROL: a ticket that DOES name a page gets no such row", async () => {
  /*
   * THE CONTROL THE EMIT NEEDS MOST. `no reference capture` settles the stage to
   * "No URL in the ticket, so nothing was captured" — a sentence that is FALSE on
   * a run whose ticket names a page whose fetch then failed. An unconditional
   * emit would pass every assertion in the test above and put that sentence on
   * every run in the system.
   *
   * NOTE THE MANIFEST IS NULL HERE TOO, exactly as in the passing case. So this
   * is not "the artefact exists"; it is the ticket-text guard, on its own, doing
   * the work. The residual gap — an explicit `captureUrl` in the REQUEST BODY,
   * not in the ticket text, whose capture failed — is named in
   * `#reportNoCapture`'s docblock and is not closable from this process.
   */
  const run = await deadSpecRun({ delayMs: 1, ticketText: `${TICKET_TEXT} Copy https://example.com/about.` });
  try {
    assert.equal(
      run.logs.filter((text) => /no reference capture/i.test(text)).length,
      0,
      "the run must not claim its ticket named no page when its ticket names one",
    );
    // ARM CHECK: the run really did take the same path, so the absence above is
    // the guard's doing and not a fixture that never reached the emit.
    assert.equal(run.dispatches.length, 3, "the same authoring path must have been walked");
    assert.equal(
      run.logs.some((text) => /^seat call 1 of this phase:/.test(text)),
      true,
    );
  } finally {
    run.cleanup();
  }
});

test("A RUN THAT FAILED SAYS SO ON THE STAGE THAT WAS STILL OPEN", async () => {
  const run = await deadSpecRun({ delayMs: 1 });
  try {
    const graph = foldGraphAll(run.wire);
    const open = (graph.stages ?? []).filter((stage) => stage.state === "unresolved");
    assert.ok(
      open.length >= 1,
      `arm check: at least one stage must have been left open by the death, or this test is vacuous. ` +
        `stages: ${JSON.stringify(graph.stages)}`,
    );
    for (const stage of open) {
      // The client's static copy for `unresolved` reads "Not a failure. Nobody
      // was watching by then." On this run it WAS the failure, and the reason is
      // three rows below on the same stream.
      assert.match(
        stage.detail,
        /The run failed while this was still working/,
        `stage ${stage.id} kept its running copy after a terminal failure`,
      );
      assert.match(stage.detail, /Nothing said this step was the cause/, "and it may not name a culprit");
    }
  } finally {
    run.cleanup();
  }
});
