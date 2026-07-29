/**
 * bus.ts — the run event bus and the SSE attach protocol.
 *
 * THE ONLY INTERESTING PART IS THE ATTACH RACE, AND IT IS WORTH SPELLING OUT.
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
 */

import type { ServerResponse } from "node:http";
import type { SseEvent } from "./api-types.js";
import type { RunStore, StoredEvent } from "./db.js";

/** Heartbeat interval. An SSE comment, which EventSource ignores. */
export const HEARTBEAT_MS = 15_000;

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
  response: ServerResponse,
  bus: RunEventBus,
  store: RunStore,
  runId: string,
  lastEventId: number,
): () => void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // The dashboard is loopback-only and same-origin; no CORS header is set
    // on purpose. See http.ts.
    "X-Accel-Buffering": "no",
  });

  let live = false;
  const pending: StoredEvent[] = [];
  let watermark = lastEventId;

  const write = (stored: StoredEvent): void => {
    if (stored.seq <= watermark) return;
    watermark = stored.seq;
    response.write(`id: ${String(stored.seq)}\n`);
    response.write(`event: ${stored.event.type}\n`);
    response.write(`data: ${JSON.stringify(stored.event)}\n\n`);
  };

  // 1. Subscribe FIRST. Everything that arrives during the replay is buffered.
  const unsubscribe = bus.subscribe(runId, (stored) => {
    if (live) write(stored);
    else pending.push(stored);
  });

  // 2. Replay what is already durable.
  for (const stored of store.eventsSince(runId, lastEventId)) write(stored);

  // 3. Drain anything that arrived while we were replaying, deduped by seq.
  live = true;
  for (const stored of pending) write(stored);
  pending.length = 0;

  // 4. Heartbeat. A comment frame: EventSource ignores it, proxies and idle
  //    timeouts do not.
  const heartbeat = setInterval(() => {
    response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, HEARTBEAT_MS);
  // Do not let the heartbeat hold the event loop open at shutdown.
  heartbeat.unref();

  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
}

/** Parse a `Last-Event-ID` header. Anything unparseable replays from zero. */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return 0;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
