/**
 * bus.test.ts — the SSE attach protocol under a client that stops reading.
 *
 * WHY A FAKE SOCKET AND NOT AN HTTP HARNESS. `api.test.ts:422` already drives
 * this code over a real loopback socket, and it proves ordering and dedupe on a
 * client that keeps up. It cannot prove anything about the one that does not:
 * you cannot make a real `ServerResponse.write()` return `false` on demand, and
 * a backpressure path never exercised with `false` is a backpressure path that
 * was never tested. Hence {@link FakeSink}, which models the part of a socket
 * that matters here:
 *
 *   - `write()` returns `accepting`; a `false` return still ACCEPTS the bytes,
 *     because that is what Node does — `false` means "this is now sitting in
 *     process memory", not "this was rejected". Modelling it as a rejection
 *     would hide the exact leak this lane exists to close.
 *   - bytes written while refusing sit in `buffered` until `drain()`. They are
 *     NOT `delivered`, and `destroy()` throws them away — which is precisely
 *     why a dropped client may resume from the last id it was DELIVERED and
 *     cannot resume from the last id it was written.
 *
 * Every test here names the production mutation it dies under; see the notes on
 * each one.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachSse, RunEventBus } from "./bus.js";
import type { SseAttachOptions, SseOverflow, SseSink } from "./bus.js";
import { RunStore } from "./db.js";

/** A `ServerResponse` stand-in whose backpressure is under the test's control. */
class FakeSink implements SseSink {
  /** Frames the client actually read. The only thing it can resume from. */
  readonly delivered: string[] = [];
  /** Frames handed to the socket while it was refusing: process memory. */
  readonly buffered: string[] = [];
  /** Every `write()` call, accepted or not. The backpressure witness. */
  writes = 0;
  accepting = true;
  destroyed = false;
  writableEnded = false;
  headers: Record<string, string> | null = null;
  #drainListeners: (() => void)[] = [];

  writeHead(_status: number, headers: Record<string, string>): void {
    this.headers = headers;
  }

  write(chunk: string): boolean {
    // Node emits `error` on a destroyed stream, and nothing in bus.ts listens
    // for it — so a write that reaches here after destroy is a real defect.
    assert.equal(this.destroyed, false, "wrote to a destroyed socket");
    this.writes += 1;
    if (this.accepting) {
      this.delivered.push(chunk);
      return true;
    }
    this.buffered.push(chunk);
    return false;
  }

  once(event: string, listener: () => void): void {
    if (event === "drain") this.#drainListeners.push(listener);
  }

  off(event: string, listener: () => void): void {
    if (event !== "drain") return;
    const index = this.#drainListeners.indexOf(listener);
    if (index >= 0) this.#drainListeners.splice(index, 1);
  }

  destroy(): void {
    this.destroyed = true;
    // The backlog dies with the socket. This is the whole reason a resume is
    // safe: the client never saw these.
    this.buffered.length = 0;
    this.#drainListeners.length = 0;
  }

  /** The client caught up: flush what was buffered and wake the writer. */
  drain(): void {
    this.accepting = true;
    this.delivered.push(...this.buffered);
    this.buffered.length = 0;
    const listeners = [...this.#drainListeners];
    this.#drainListeners.length = 0;
    for (const listener of listeners) listener();
  }

  get drainListenerCount(): number {
    return this.#drainListeners.length;
  }
}

/** Ids of the frames the client actually read, in the order it read them. */
function deliveredIds(sink: FakeSink): number[] {
  const ids: number[] = [];
  for (const frame of sink.delivered) {
    const match = /^id: (\d+)$/m.exec(frame);
    if (match !== null) ids.push(Number(match[1]));
  }
  return ids;
}

/** One event-loop turn: `setImmediate`, which is what the replay pump yields to. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Enough turns for a paced replay of `rows` rows to finish, plus slack. */
async function settle(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) await tick();
}

interface Fixture {
  readonly store: RunStore;
  readonly bus: RunEventBus;
  readonly runId: string;
  close(): void;
}

function fixture(label: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `dash-bus-${label}-`));
  const store = RunStore.open(join(dir, "runs.db"));
  const runId = `run-${label}`;
  store.createRun({
    runId,
    ticketId: `t-${label}`,
    ticketTitle: label,
    ticketText: "a portfolio page",
    ticketSha256: "e".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
  return {
    store,
    bus: new RunEventBus(store),
    runId,
    close(): void {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function emitLog(fix: Fixture, text: string): void {
  fix.bus.emit(fix.runId, { type: "log", level: "info", text });
}

function attach(fix: Fixture, sink: FakeSink, options: SseAttachOptions = {}): () => void {
  return attachSse(sink, fix.bus, fix.store, fix.runId, 0, options);
}

/* -------------------------------------------------------------------------
 * 1. Backpressure
 * ---------------------------------------------------------------------- */

/*
 * THE ASSERTION WITH TEETH IS THE MIDDLE ONE.
 *
 * "everything arrived, in order" is green with backpressure deleted — ignoring
 * `write()`'s return value still delivers every frame in order, straight into
 * the buffer we are trying not to fill. The assertion that dies is `writes`
 * NOT GROWING while the socket refuses: it says the bytes are being held by US,
 * where they are counted and bounded, instead of by Node, where they are not.
 *
 * NEGATIVE CONTROL (run, red): in `SseChannel.send`, replace
 *   `if (!this.#sink.write(text)) this.#cork();`
 * with `this.#sink.write(text);` — i.e. discard the boolean exactly as the code
 * did before 2026-08-04. Then `writes` is 51 instead of 1.
 */
test("a refusing socket is written to ONCE, and the rest waits for drain", async () => {
  const fix = fixture("backpressure");
  const sink = new FakeSink();
  const detach = attach(fix, sink);
  try {
    await settle();
    assert.equal(sink.writes, 0, "nothing durable yet, so nothing to replay");

    // The socket stops reading. The first frame is what discovers that.
    sink.accepting = false;
    emitLog(fix, "frame-0");
    assert.equal(sink.writes, 1, "one write is how backpressure is learned at all");

    for (let index = 1; index <= 50; index += 1) emitLog(fix, `frame-${String(index)}`);
    assert.equal(
      sink.writes,
      1,
      "50 further events must sit in OUR bounded queue, not in Node's unbounded one",
    );
    assert.equal(sink.delivered.length, 0, "the client read none of it");
    assert.equal(sink.drainListenerCount, 1, "and exactly one drain listener is armed");

    sink.drain();
    assert.equal(sink.writes, 51, "drain releases the queue");
    assert.deepEqual(
      deliveredIds(sink),
      Array.from({ length: 51 }, (_unused, index) => index + 1),
      "in seq order, once each",
    );
  } finally {
    detach();
    fix.close();
  }
});

/*
 * A detached client must not leave its queue anchored to the response.
 *
 * NEGATIVE CONTROL (run, red): delete the `this.#sink.off("drain", ...)` block
 * in `SseChannel.#dropQueue`. The listener count stays 1 after detach, and that
 * closure holds the whole queue.
 */
test("detaching while corked removes the drain listener", async () => {
  const fix = fixture("detach-corked");
  const sink = new FakeSink();
  const detach = attach(fix, sink);
  try {
    await settle();
    sink.accepting = false;
    emitLog(fix, "one");
    emitLog(fix, "two");
    assert.equal(sink.drainListenerCount, 1);

    detach();
    assert.equal(sink.drainListenerCount, 0, "no closure left holding the queue");
  } finally {
    detach();
    fix.close();
  }
});

/* -------------------------------------------------------------------------
 * 2. Paced replay: order and dedupe
 * ---------------------------------------------------------------------- */

/*
 * Replay used to be one synchronous loop; it is now sliced across event-loop
 * turns, which opens a window for live events to interleave. This asserts the
 * window is handled the way the file header claims: history first, buffered
 * live events after, one strictly increasing sequence.
 *
 * NEGATIVE CONTROL (run, red): in `attachSse`, hoist `live = true` from
 * `goLive` to just before `void replay()`. Live events then jump ahead of the
 * history still being paced out, and the delivered ids are no longer sorted.
 */
test("a paced replay stays in seq order when live events land mid-replay", async () => {
  const fix = fixture("paced");
  for (let index = 0; index < 10; index += 1) emitLog(fix, `history-${String(index)}`);

  const sink = new FakeSink();
  // Two rows per turn: five turns of replay, so the interleaving window is real.
  const detach = attach(fix, sink, { replayChunk: 2 });
  try {
    assert.ok(
      sink.writes < 10,
      `replay must not burst: ${String(sink.writes)} frames went out synchronously`,
    );

    await tick();
    emitLog(fix, "live-during-replay-a");
    await tick();
    emitLog(fix, "live-during-replay-b");

    await settle();
    const ids = deliveredIds(sink);
    assert.deepEqual(
      ids,
      Array.from({ length: 12 }, (_unused, index) => index + 1),
      "history 1..10 then the two live ones, in order, no gap",
    );
    assert.equal(new Set(ids).size, ids.length, "and no duplicates");
  } finally {
    detach();
    fix.close();
  }
});

/*
 * THE ATTACH RACE ITSELF, reproduced rather than hoped for.
 *
 * The header's claim is that an event landing between `bus.subscribe` and the
 * durable read is delivered exactly once: it is in `pending` AND in the replay
 * rows, and the `seq <= watermark` guard is what collapses the two. Nothing in
 * the HTTP tests can hit that window, so it is manufactured here by a store
 * whose `eventsSince` emits before it returns.
 *
 * NEGATIVE CONTROL (run, red): delete `if (stored.seq <= watermark) return;`
 * from `write` in `attachSse`. The raced event is delivered twice.
 */
test("an event that lands during the durable read is delivered exactly once", async () => {
  const fix = fixture("attach-race");
  emitLog(fix, "history-0");

  let raced = false;
  const racyStore = {
    eventsSince(runId: string, after: number) {
      if (!raced) {
        raced = true;
        // Inserted AFTER the subscribe, BEFORE the rows come back: this row is
        // now in both halves of the protocol.
        fix.bus.emit(runId, { type: "log", level: "info", text: "raced" });
      }
      return fix.store.eventsSince(runId, after);
    },
  } as unknown as RunStore;

  const sink = new FakeSink();
  const detach = attachSse(sink, fix.bus, racyStore, fix.runId, 0);
  try {
    await settle();
    assert.equal(raced, true, "the fixture must actually have raced");
    const ids = deliveredIds(sink);
    assert.deepEqual(ids, [1, 2], "both events, in order");
    assert.equal(new Set(ids).size, ids.length, "the raced event is not delivered twice");
  } finally {
    detach();
    fix.close();
  }
});

/* -------------------------------------------------------------------------
 * 3. The slow-consumer policy
 * ---------------------------------------------------------------------- */

/*
 * NEGATIVE CONTROL (run, red): delete
 *   `if (this.#queuedBytes > this.#maxQueuedBytes) this.overflow();`
 * from `SseChannel.#enqueue` — the "keep buffering forever" behaviour this lane
 * removes. The socket is never destroyed, `onOverflow` never fires, and the
 * queue holds every byte, which is the leak.
 */
test("a client that stops reading is dropped once its queue passes the bound", async () => {
  const fix = fixture("overflow");
  const sink = new FakeSink();
  const overflows: SseOverflow[] = [];
  const detach = attach(fix, sink, {
    maxQueuedBytes: 2_048,
    onOverflow: (overflow) => overflows.push(overflow),
  });
  try {
    await settle();
    sink.accepting = false;
    const filler = "x".repeat(512);
    for (let index = 0; index < 40; index += 1) emitLog(fix, `${filler}-${String(index)}`);

    assert.equal(sink.destroyed, true, "the socket is cut, not fed");
    assert.equal(overflows.length, 1, "and the drop is reported, not silent");
    const overflow = overflows[0];
    assert.ok(overflow !== undefined);
    assert.equal(overflow.runId, fix.runId);
    assert.ok(overflow.queuedBytes > 2_048, "reported the bytes actually held, not zero");
    assert.ok(overflow.watermark > 0, "and where the client may resume from");

    // Emitting into a dead socket must stay harmless: FakeSink.write asserts it
    // is never called after destroy.
    emitLog(fix, "after-the-drop");
  } finally {
    detach();
    fix.close();
  }
});

/*
 * THE BOUND APPLIES TO REPLAY, not just to the live tail.
 *
 * The overflow test above drops a client that had already finished replaying.
 * This one refuses from the very first byte, which is the realistic shape — a
 * tab opened on a long finished run, on a slow pipe — and the one that used to
 * hand the entire run to Node's buffer in a single synchronous loop.
 *
 * NEGATIVE CONTROL (run, red): delete
 *   `if (this.#queuedBytes > this.#maxQueuedBytes) this.overflow();`
 * from `SseChannel.#enqueue`. All 60 rows land in the queue, nothing is
 * dropped, and both assertions fail.
 *
 * NOT a negative control, and I ran it expecting one: deleting the
 * `channel.closed` guards in the replay row loop and in `write` leaves this
 * GREEN. `onOverflow` fires synchronously at the moment the bound is crossed,
 * so the reported watermark is already taken before any of that extra work
 * happens, and `SseChannel.send` no-ops once closed. Those guards stop the pump
 * doing pointless `JSON.stringify` into a dead socket; they change nothing
 * observable, and no assertion here should pretend otherwise.
 */
test("a client refusing from the first byte is dropped mid-replay, not fed the run", async () => {
  const fix = fixture("mid-slice");
  const filler = "z".repeat(600);
  for (let index = 0; index < 60; index += 1) emitLog(fix, `${filler}-${String(index)}`);

  const sink = new FakeSink();
  sink.accepting = false;
  const overflows: SseOverflow[] = [];
  const detach = attach(fix, sink, {
    replayChunk: 60,
    maxQueuedBytes: 2_048,
    onOverflow: (overflow) => overflows.push(overflow),
  });
  try {
    await settle();
    assert.equal(sink.destroyed, true);
    const overflow = overflows[0];
    assert.ok(overflow !== undefined, "the drop is reported");
    assert.ok(
      overflow.watermark < 20,
      `dropped early in the run, not after handing over all 60 rows (watermark ${String(overflow.watermark)})`,
    );
  } finally {
    detach();
    fix.close();
  }
});

/*
 * The attach-race buffer is bounded on the same terms as the socket queue —
 * otherwise a run emitting hard during a paced replay just moves the unbounded
 * growth from one array to the other.
 *
 * NEGATIVE CONTROL (run, red): delete
 *   `if (pending.length > maxPendingEvents) channel.overflow();`
 * from the subscribe callback in `attachSse`. `pending` grows without limit and
 * the socket is never dropped.
 */
test("the mid-replay buffer is bounded too", async () => {
  const fix = fixture("pending-bound");
  for (let index = 0; index < 8; index += 1) emitLog(fix, `history-${String(index)}`);

  const sink = new FakeSink();
  const detach = attach(fix, sink, { replayChunk: 1, maxPendingEvents: 2 });
  try {
    // One turn in, the pump is mid-replay, so these queue in `pending`.
    await tick();
    for (let index = 0; index < 5; index += 1) emitLog(fix, `live-${String(index)}`);
    assert.equal(sink.destroyed, true, "a full mid-replay buffer drops the client");
    await settle();
  } finally {
    detach();
    fix.close();
  }
});

/*
 * THE TEST THAT MAKES THE POLICY HONEST RATHER THAN MERELY TERMINAL.
 *
 * A dropped client reconnects with the last id it PARSED. This asserts the two
 * halves splice into one gap-free, duplicate-free sequence — which is the whole
 * defence of destroying the socket instead of buffering for it.
 *
 * NEGATIVE CONTROL (run, red): in `attachSse`, ignore the resume point —
 * `lastEventId = 0;` as the first statement. The second half re-delivers frames
 * 1 and 2, which the client had already folded.
 *
 * NOT a negative control, and worth writing down because I ran it expecting one:
 * changing only the query to `store.eventsSince(runId, 0)` leaves this test
 * GREEN. `watermark` still starts at `lastEventId`, and the `seq <= watermark`
 * guard drops the re-read rows before they reach the socket. Two independent
 * defences, and the mutation has to defeat both — which is why the mutation
 * above moves the binding they share.
 */
test("a dropped client resumes from what it read, with no gap and no duplicate", async () => {
  const fix = fixture("resume");
  const first = new FakeSink();
  const detachFirst = attach(fix, first, { maxQueuedBytes: 1_024 });
  const total = 30;
  try {
    await settle();
    // Read the first few, then stop reading entirely.
    emitLog(fix, "read-me-0");
    emitLog(fix, "read-me-1");
    first.accepting = false;
    const filler = "y".repeat(512);
    for (let index = 2; index < total; index += 1) emitLog(fix, `${filler}-${String(index)}`);
    assert.equal(first.destroyed, true);
  } finally {
    detachFirst();
  }

  const readIds = deliveredIds(first);
  assert.deepEqual(readIds, [1, 2], "only the frames that reached the client count");

  const second = new FakeSink();
  const resumeFrom = readIds[readIds.length - 1] ?? 0;
  const detachSecond = attachSse(second, fix.bus, fix.store, fix.runId, resumeFrom);
  try {
    await settle();
    const all = [...readIds, ...deliveredIds(second)];
    assert.deepEqual(
      all,
      Array.from({ length: total }, (_unused, index) => index + 1),
      "the two halves splice into one complete sequence",
    );
    assert.equal(new Set(all).size, all.length, "foldGraph is not idempotent: never twice");
  } finally {
    detachSecond();
    fix.close();
  }
});
