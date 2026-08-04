/**
 * bus.ts — the run event bus and the SSE attach protocol.
 *
 * THE ATTACH RACE, AND IT IS WORTH SPELLING OUT.
 *
 * A client that connects late must see the whole run from the beginning. The
 * naive order — read the persisted rows, then subscribe — drops every event
 * emitted between the read and the subscribe. The reverse order — subscribe,
 * then read — duplicates them.
 *
 * So: SUBSCRIBE FIRST AND BUFFER, then read persisted rows up to a watermark,
 * emit those, then emit the buffered ones with `seq > watermark`, then go
 * live. Sequence numbers are allocated by the same synchronous block that
 * inserts the row (db.ts), so they totally order the run and the dedupe is
 * exact rather than heuristic.
 *
 * `Last-Event-ID` is honoured, so a browser's automatic EventSource reconnect
 * resumes instead of replaying from zero.
 *
 * BACKPRESSURE, AND WHY THIS FILE GREW A QUEUE (2026-08-04).
 *
 * Until now every send here was `response.write(...)` with the return value
 * thrown away. That boolean is Node's only backpressure signal: `false` means
 * the socket's outgoing buffer is already past its high-water mark and every
 * further byte is being held in *process memory* until the client reads. So a
 * single slow tab on a long run was an unbounded, unmeasured allocation, and
 * the replay loop — one synchronous pass over every durable row of the run —
 * was the fastest possible way to fill it. A finished run today is ~388 events;
 * the per-turn narration and per-edit diff work in flight raises that by one to
 * two orders of magnitude, which is what turns "unbounded in principle" into
 * "unbounded in practice".
 *
 * Three changes, all inside {@link attachSse}:
 *
 *   1. One funnel. Every byte — replay row, live event, heartbeat — goes
 *      through {@link SseChannel.send}. Once anything is queued, nothing writes
 *      directly, so the socket order is the queue order is the `seq` order.
 *   2. Paced replay. The rows are delivered in {@link SSE_REPLAY_CHUNK}-sized
 *      slices that yield to the event loop, and the pump waits for `drain`
 *      before the next slice. A big backlog can no longer block the loop.
 *   3. A bound, and a policy when it is hit. See {@link SSE_MAX_QUEUED_BYTES}.
 *
 * WHAT HAPPENS TO A CLIENT THAT CANNOT KEEP UP — and why it is not a lie.
 *
 * When the queue passes the byte bound we drop the queue and `destroy()` the
 * socket. That reads like data loss and is not, because of one property: the
 * client's `Last-Event-ID` is the id of the last frame it actually *parsed*,
 * which is by construction at or below our `watermark`, and the destroyed
 * bytes were never parsed. The browser reconnects automatically, sends that
 * id, and `eventsSince` hands back exactly the tail it missed — no gap, no
 * duplicate, and `foldGraph` (which is NOT idempotent) stays correct. `end()`
 * would be wrong here: it flushes the backlog first, which is the memory we
 * are trying to release.
 *
 * The drop is observable on both sides. Server-side, {@link SseAttachOptions.onOverflow}
 * fires with the watermark and the byte count. Client-side, `use-run-stream.ts`
 * counts the error, shows `reconnecting`, and after five *consecutive* failures
 * — a reconnect that delivers even one frame resets the counter — closes the
 * source, marks `offline` and appends a visible trace row saying so. What we
 * cannot do is deliver an in-band "you were cut off" event: EventSource only
 * surfaces named events its listener list declares (`EVENT_TYPES` in
 * `use-run-stream.ts`), so any frame invented here would be dropped by the
 * browser before a human saw it. That would need a new `SseEvent` type wired
 * through all seven declaration sites, which is not this file's business.
 */

import type { SseEvent, SseWireEvent } from "./api-types.js";
import type { RunStore, StoredEvent } from "./db.js";

/** Heartbeat interval. An SSE comment, which EventSource ignores. */
export const HEARTBEAT_MS = 15_000;

/**
 * Rows delivered per event-loop turn during replay.
 *
 * The point is not the size, it is that there IS one: between slices the pump
 * yields, so a 32,000-row replay cannot starve the HTTP server that is serving
 * the rest of the dashboard while it runs.
 */
export const SSE_REPLAY_CHUNK = 256;

/**
 * How many bytes we will hold for one client that has stopped reading.
 *
 * This bounds OUR queue, not Node's socket buffer — by the time we queue at
 * all, `write()` has already said the kernel/stream side is full. Past this,
 * see the overflow policy in the file header.
 */
export const SSE_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/**
 * How many live events may buffer while the replay pump is still running.
 *
 * The attach race buffer (`pending`) used to be unbounded too, and a paced
 * replay makes it matter more, not less: replay now takes real time, and a run
 * emitting hard during it fills the buffer instead of the socket. Same policy —
 * everything in here is already durable, so dropping it costs a reconnect.
 */
export const SSE_MAX_PENDING_EVENTS = 10_000;

/**
 * The half of `ServerResponse` this file touches.
 *
 * Narrowed deliberately: a test cannot construct a real `ServerResponse` whose
 * `write()` returns `false` on demand, and a backpressure path that is never
 * exercised with `false` is not tested at all. `ServerResponse` satisfies this
 * structurally; `attachSse`'s caller in http.ts passes one unchanged.
 */
export interface SseSink {
  writeHead(status: number, headers: Record<string, string>): unknown;
  /** Node's backpressure signal. `false` = buffered in memory, stop sending. */
  write(chunk: string): boolean;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  destroy(): unknown;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
}

/** Why a client's socket was dropped, for the server-side record. */
export interface SseOverflow {
  readonly runId: string;
  /** The last `seq` we handed to the socket. The client resumes at or below it. */
  readonly watermark: number;
  readonly queuedBytes: number;
  readonly pendingEvents: number;
}

export interface SseAttachOptions {
  /** Fires when a slow client is dropped. See the file header. */
  readonly onOverflow?: (overflow: SseOverflow) => void;
  /** Test seam: byte bound for the outgoing queue. */
  readonly maxQueuedBytes?: number;
  /** Test seam: event bound for the attach-race buffer. */
  readonly maxPendingEvents?: number;
  /** Test seam: rows per event-loop turn during replay. */
  readonly replayChunk?: number;
}

/**
 * One client's ordered byte pipe, with backpressure.
 *
 * INVARIANT: a direct `write()` happens only when nothing is queued and the
 * sink is not corked. Everything else appends. That is what keeps socket order
 * equal to call order, which is what keeps it equal to `seq` order.
 */
class SseChannel {
  readonly #sink: SseSink;
  readonly #maxQueuedBytes: number;
  readonly #queue: { text: string; bytes: number }[] = [];
  #queuedBytes = 0;
  /** True between a `write()` returning false and its `drain`. */
  #corked = false;
  #closed = false;
  #overflowed = false;
  #drainListener: (() => void) | null = null;
  #idleWaiters: (() => void)[] = [];
  #onOverflow: ((queuedBytes: number) => void) | null = null;

  constructor(sink: SseSink, maxQueuedBytes: number) {
    this.#sink = sink;
    this.#maxQueuedBytes = maxQueuedBytes;
  }

  get closed(): boolean {
    return this.#closed || this.#sink.destroyed || this.#sink.writableEnded;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  /** Bytes currently held in process memory for this client. */
  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  /** True when the sink is taking bytes now — nothing queued, no cork. */
  get idle(): boolean {
    return !this.#corked && this.#queue.length === 0;
  }

  onOverflow(handler: (queuedBytes: number) => void): void {
    this.#onOverflow = handler;
  }

  send(text: string): void {
    if (this.closed) return;
    if (!this.idle) {
      this.#enqueue(text);
      return;
    }
    if (!this.#sink.write(text)) this.#cork();
  }

  /** Resolves when the sink is accepting bytes again (immediately, if it is). */
  ready(): Promise<void> {
    if (this.closed || this.idle) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  /** Detach without killing the socket: the caller's `close` handler owns that. */
  release(): void {
    this.#closed = true;
    this.#dropQueue();
    this.#releaseWaiters();
  }

  #enqueue(text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    this.#queue.push({ text, bytes });
    this.#queuedBytes += bytes;
    if (this.#queuedBytes > this.#maxQueuedBytes) this.overflow();
  }

  /**
   * The slow-consumer policy: drop what we are holding and cut the socket.
   * Safe because the client resumes from what it PARSED, never from what we
   * merely buffered. See the file header.
   */
  overflow(): void {
    if (this.#closed) return;
    // Snapshot before the drop, or the report of how much was being held is
    // taken after we stopped holding it — always zero, always useless.
    const held = this.#queuedBytes;
    this.#overflowed = true;
    this.#closed = true;
    this.#dropQueue();
    this.#releaseWaiters();
    // destroy(), not end(): end() would flush the backlog we are trying to free.
    if (!this.#sink.destroyed) this.#sink.destroy();
    this.#onOverflow?.(held);
  }

  #cork(): void {
    if (this.#corked) return;
    this.#corked = true;
    const listener = (): void => {
      this.#drainListener = null;
      this.#corked = false;
      this.#flush();
    };
    this.#drainListener = listener;
    this.#sink.once("drain", listener);
  }

  #flush(): void {
    while (this.#queue.length > 0) {
      if (this.closed) return;
      // Bytes travel with the frame: recomputing byteLength on the way out is
      // how the accounting drifts away from what was actually added.
      const next = this.#queue.shift();
      if (next === undefined) break;
      this.#queuedBytes -= next.bytes;
      if (!this.#sink.write(next.text)) {
        this.#cork();
        return;
      }
    }
    if (this.idle) this.#releaseWaiters();
  }

  #dropQueue(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    // A client that disappears while corked must not leave a closure holding
    // the queue alive on the response object.
    if (this.#drainListener !== null) {
      this.#sink.off("drain", this.#drainListener);
      this.#drainListener = null;
    }
    this.#corked = false;
  }

  #releaseWaiters(): void {
    const waiters = [...this.#idleWaiters];
    this.#idleWaiters.length = 0;
    for (const waiter of waiters) waiter();
  }
}

type Listener = (stored: StoredEvent) => void;

export class RunEventBus {
  readonly #store: RunStore;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(store: RunStore) {
    this.#store = store;
  }

  /**
   * Persist an event, then deliver it live.
   *
   * Persist-then-deliver is deliberate: a listener that throws must not be able
   * to lose an event that the run's own history depends on.
   */
  emit(runId: string, event: SseEvent): StoredEvent {
    const stored = this.#store.appendEvent(runId, event);
    const listeners = this.#listeners.get(runId);
    if (listeners !== undefined) {
      for (const listener of [...listeners]) {
        try {
          listener(stored);
        } catch {
          // A broken pipe on one browser tab must not stop the run or the
          // other subscribers. The event is already durable.
        }
      }
    }
    return stored;
  }

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.#listeners.get(runId);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(runId, set);
    }
    set.add(listener);
    return (): void => {
      const current = this.#listeners.get(runId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(runId);
    };
  }

  subscriberCount(runId: string): number {
    return this.#listeners.get(runId)?.size ?? 0;
  }
}

/**
 * Attach one SSE client to a run: replay, then stream.
 *
 * Returns a detach function. The caller must call it on 'close' — an SSE
 * response that is never detached keeps a heartbeat timer alive, and a live
 * timer keeps the process alive.
 */
export function attachSse(
  response: SseSink,
  bus: RunEventBus,
  store: RunStore,
  runId: string,
  lastEventId: number,
  options: SseAttachOptions = {},
): () => void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // The dashboard is loopback-only and same-origin; no CORS header is set
    // on purpose. See http.ts.
    "X-Accel-Buffering": "no",
  });

  const maxPendingEvents = options.maxPendingEvents ?? SSE_MAX_PENDING_EVENTS;
  const replayChunk = Math.max(1, options.replayChunk ?? SSE_REPLAY_CHUNK);
  const channel = new SseChannel(response, options.maxQueuedBytes ?? SSE_MAX_QUEUED_BYTES);

  let live = false;
  const pending: StoredEvent[] = [];
  let watermark = lastEventId;

  channel.onOverflow((queuedBytes) => {
    options.onOverflow?.({ runId, watermark, queuedBytes, pendingEvents: pending.length });
  });

  const write = (stored: StoredEvent): void => {
    if (stored.seq <= watermark) return;
    watermark = stored.seq;
    /*
     * `stored.at` TRAVELS, and until 2026-07-30 it did not.
     *
     * This line serialised `stored.event` alone. `events.at` was written on every
     * insert and read back by `eventsSince`, so the server knew the instant of all
     * 388 events of a finished run and told the client none of them.
     *
     * It matters that the time comes from HERE rather than from the client's clock
     * on arrival: replay pushes a whole finished run down the socket at once, so a
     * client-side stamp would give every event of a two-hour run the same
     * timestamp — and would look perfectly correct on a live run, which is the
     * only one anybody would have tested. See {@link SseWireEvent}.
     */
    const wire: SseWireEvent = { ...stored.event, at: stored.at };
    // ONE frame, ONE write. Three writes per event made the backpressure signal
    // arrive in the middle of a frame and made the queue account for a third of
    // an event at a time; the bytes on the wire are identical.
    channel.send(
      `id: ${String(stored.seq)}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(wire)}\n\n`,
    );
  };

  // 1. Subscribe FIRST. Everything that arrives during the replay is buffered.
  const unsubscribe = bus.subscribe(runId, (stored) => {
    if (live) {
      write(stored);
      return;
    }
    pending.push(stored);
    // The attach-race buffer is bounded like the socket queue, and for the same
    // reason: these rows are durable, so a drop costs a reconnect, not an event.
    if (pending.length > maxPendingEvents) channel.overflow();
  });

  /*
   * 2. Replay what is already durable — PACED, not in one burst.
   *
   * `store.eventsSince` has no `limit`, so this still materialises every row of
   * the run in one query (http.ts:1596 does the same, and re-querying per slice
   * would make replay O(n²) over `seq`). What is paced is DELIVERY: a slice,
   * then a wait for the socket to accept more, then a yield. That is what stops
   * a 32,000-row backlog from both blocking the event loop and landing in the
   * write buffer all at once.
   *
   * Every await is a place where the client can vanish, so liveness is
   * re-checked after each one rather than only on entry: `write()` on a
   * destroyed response emits `error`, and nothing here listens for it.
   */
  const replay = async (): Promise<void> => {
    const rows = store.eventsSince(runId, lastEventId);
    for (let index = 0; index < rows.length; index += replayChunk) {
      if (channel.closed) return;
      const end = Math.min(index + replayChunk, rows.length);
      for (let cursor = index; cursor < end; cursor += 1) {
        const stored = rows[cursor];
        if (stored !== undefined) write(stored);
      }
      await channel.ready();
      if (channel.closed) return;
      if (end < rows.length) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  // 3. Drain anything that arrived while we were replaying, deduped by seq, and
  //    go live. No await between the flip and the flush: an interleaving there
  //    is exactly the reordering the whole protocol exists to prevent.
  const goLive = (): void => {
    live = true;
    for (const stored of pending) write(stored);
    pending.length = 0;
  };

  void replay().then(goLive, goLive);

  // 4. Heartbeat. A comment frame: EventSource ignores it, proxies and idle
  //    timeouts do not.
  const heartbeat = setInterval(() => {
    // A socket that is visibly refusing bytes does not need a keepalive, and
    // queueing one behind a backlog would only add to the backlog.
    if (!channel.idle) return;
    channel.send(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, HEARTBEAT_MS);
  // Do not let the heartbeat hold the event loop open at shutdown.
  heartbeat.unref();

  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    clearInterval(heartbeat);
    unsubscribe();
    channel.release();
  };
}

/** Parse a `Last-Event-ID` header. Anything unparseable replays from zero. */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return 0;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
