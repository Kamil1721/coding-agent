"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import useSWR from "swr";

import {
  isRunStatus,
  isStalledStatus,
  isTerminalStatus,
  type CriterionResult,
  type LogLevel,
  type RunDetail,
  type RunEvent,
  type RunEventType,
  type RunStatus,
} from "./api-types";
import { KEY, apiUrl, swrFetcher } from "./api";

/* ------------------------------------------------------------------ */
/* Trace                                                               */
/* ------------------------------------------------------------------ */

export type TraceKind =
  | "log"
  | "tool"
  | "phase"
  | "criterion"
  | "screenshot"
  | "rate_limit"
  | "verdict"
  | "status"
  | "client";

export interface TraceEntry {
  readonly seq: number;
  readonly atMs: number;
  readonly kind: TraceKind;
  readonly level: LogLevel;
  readonly text: string;
  /** Set on `tool` rows. */
  readonly name: string | null;
  /** Set on `criterion` rows. */
  readonly result: CriterionResult | null;
}

/** Bounded: a long agent run can emit tens of thousands of lines. */
const MAX_TRACE_ENTRIES = 3000;

interface TraceState {
  readonly entries: readonly TraceEntry[];
  readonly seq: number;
}

type TraceAction =
  | { readonly kind: "append"; readonly entry: Omit<TraceEntry, "seq"> }
  | { readonly kind: "reset" };

const EMPTY_TRACE: TraceState = { entries: [], seq: 0 };

function traceReducer(state: TraceState, action: TraceAction): TraceState {
  if (action.kind === "reset") return EMPTY_TRACE;
  const entry: TraceEntry = { ...action.entry, seq: state.seq };
  const next = [...state.entries, entry];
  return {
    entries:
      next.length > MAX_TRACE_ENTRIES
        ? next.slice(next.length - MAX_TRACE_ENTRIES)
        : next,
    seq: state.seq + 1,
  };
}

/* ------------------------------------------------------------------ */
/* Event parsing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every member of `RunEvent["type"]`, because a backend that uses NAMED SSE
 * events only delivers the ones a listener is registered for. A type missing
 * from this list is a type the UI never receives — silently, with a clean
 * compile, since `readonly RunEventType[]` is just as valid when short.
 */
const EVENT_TYPES: readonly RunEventType[] = [
  "phase",
  "log",
  "tool",
  "criterion",
  "screenshot",
  "tokens",
  "rate_limit",
  "verdict",
  "status",
];

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asCount(value: unknown): number {
  const num = asNumber(value);
  return num === null || num < 0 ? 0 : num;
}

/**
 * Parse one SSE payload.
 *
 * `fallbackType` covers a backend that uses NAMED SSE events
 * (`event: phase\ndata: {...}`) and omits `type` from the JSON body. The
 * contract documents `{type:"phase", phase}` objects, which arrive as default
 * `message` events; both spellings are accepted because guessing wrong here
 * silently blanks the entire live trace.
 */
export function parseRunEvent(
  raw: string,
  fallbackType: RunEventType | null,
): RunEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const type = asString(record["type"]) ?? fallbackType;

  switch (type) {
    case "phase": {
      const phase = asString(record["phase"]);
      if (phase === null) return null;
      return { type: "phase", phase: phase as RunDetail["phase"] };
    }
    case "log": {
      const text = asString(record["text"]);
      if (text === null) return null;
      const rawLevel = asString(record["level"]);
      const level: LogLevel =
        rawLevel === "warn" || rawLevel === "error" ? rawLevel : "info";
      return { type: "log", level, text };
    }
    case "tool": {
      const name = asString(record["name"]);
      if (name === null) return null;
      return { type: "tool", name, summary: asString(record["summary"]) ?? "" };
    }
    case "criterion": {
      const id = asString(record["id"]);
      const result = asString(record["result"]);
      if (id === null) return null;
      if (result !== "pass" && result !== "fail" && result !== "pending") {
        return null;
      }
      return { type: "criterion", id, result };
    }
    case "screenshot": {
      const path = asString(record["path"]);
      if (path === null) return null;
      return {
        type: "screenshot",
        path,
        label: asString(record["label"]) ?? path,
      };
    }
    case "tokens":
      return {
        type: "tokens",
        inputTokens: asCount(record["inputTokens"]),
        outputTokens: asCount(record["outputTokens"]),
        cacheReadTokens: asCount(record["cacheReadTokens"]),
        cacheWriteTokens: asCount(record["cacheWriteTokens"]),
      };
    case "rate_limit": {
      const retryAfterSec = asNumber(record["retryAfterSec"]);
      return { type: "rate_limit", retryAfterSec: retryAfterSec ?? 0 };
    }
    case "verdict": {
      const verdictPath = asString(record["verdictPath"]);
      // A verdict event without a path is not a verdict. Dropped rather than
      // folded in as "", which would read as "no verdict was written" — the
      // opposite of what the event says.
      if (verdictPath === null || verdictPath.length === 0) return null;
      return {
        type: "verdict",
        verdictPath,
        inferredCriteria: asCount(record["inferredCriteria"]),
      };
    }
    case "status": {
      const status = asString(record["status"]);
      if (status === null || !isRunStatus(status)) return null;
      return { type: "status", status };
    }
    default:
      return null;
  }
}

/**
 * Fold one event into the cached `RunDetail`.
 *
 * Returns the same object when nothing changed, so SWR does not re-render, and
 * `null` when there is no cached detail to fold into yet (the caller then
 * revalidates from REST instead of inventing a record).
 */
export function applyRunEvent(
  previous: RunDetail | undefined,
  event: RunEvent,
): RunDetail | undefined {
  if (previous === undefined) return undefined;

  switch (event.type) {
    case "phase":
      return previous.phase === event.phase
        ? previous
        : { ...previous, phase: event.phase };

    case "status":
      return previous.status === event.status
        ? previous
        : {
            ...previous,
            status: event.status,
            // The stream cannot know `endedAt`; leave it to the REST
            // reconciliation rather than stamping a client clock into it.
          };

    case "tokens":
      return {
        ...previous,
        tokens: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
        },
      };

    case "rate_limit":
      return {
        ...previous,
        rateLimit: {
          limited: true,
          retryAfterSec: event.retryAfterSec > 0 ? event.retryAfterSec : null,
        },
      };

    case "criterion": {
      let touched = false;
      const criteria = previous.criteria.map((criterion) => {
        if (criterion.id !== event.id || criterion.result === event.result) {
          return criterion;
        }
        touched = true;
        return { ...criterion, result: event.result };
      });
      // A criterion the cached record has never seen carries no statement or
      // tier on the wire, so it cannot be synthesised here. Signalled to the
      // caller by returning `previous` unchanged; the caller revalidates.
      return touched ? { ...previous, criteria } : previous;
    }

    case "screenshot": {
      // Appended optimistically so a capture shows the instant it happens.
      // `GET /api/runs/:id` stays authoritative, which means the BACKEND MUST
      // RECORD A SCREENSHOT BEFORE IT EMITS THE EVENT: any revalidation after
      // an event whose capture is not yet in the read model will drop it from
      // view until the backend catches up. Deduped by path, so a capture that
      // arrives on both channels is never shown twice.
      if (previous.screenshots.some((shot) => shot.path === event.path)) {
        return previous;
      }
      return {
        ...previous,
        screenshots: [
          ...previous.screenshots,
          {
            path: event.path,
            label: event.label,
            capturedAt: new Date().toISOString(),
          },
        ],
      };
    }

    case "verdict":
      return previous.verdictPath === event.verdictPath &&
        previous.inferredCriteria === event.inferredCriteria
        ? previous
        : {
            ...previous,
            verdictPath: event.verdictPath,
            inferredCriteria: event.inferredCriteria,
          };

    case "log":
    case "tool":
      return previous;

    default:
      return previous;
  }
}

function traceRowFor(event: RunEvent): Omit<TraceEntry, "seq"> | null {
  const base = { atMs: Date.now(), name: null, result: null } as const;
  switch (event.type) {
    case "log":
      return { ...base, kind: "log", level: event.level, text: event.text };
    case "tool":
      return {
        ...base,
        kind: "tool",
        level: "info",
        text: event.summary === "" ? event.name : `${event.name} — ${event.summary}`,
        name: event.name,
      };
    case "phase":
      return {
        ...base,
        kind: "phase",
        level: "info",
        text: `phase → ${event.phase}`,
      };
    case "criterion":
      return {
        ...base,
        kind: "criterion",
        level: event.result === "fail" ? "warn" : "info",
        text: `${event.id} → ${event.result}`,
        result: event.result,
      };
    case "screenshot":
      return {
        ...base,
        kind: "screenshot",
        level: "info",
        text: `screenshot — ${event.label}`,
      };
    case "rate_limit":
      return {
        ...base,
        kind: "rate_limit",
        level: "warn",
        text:
          event.retryAfterSec > 0
            ? `rate limited; retry after ${event.retryAfterSec}s`
            : "rate limited",
      };
    case "verdict":
      return {
        ...base,
        kind: "verdict",
        level: "info",
        // The count leads, because it is the line worth reading on a PASS: a
        // run graded against criteria nobody wrote is the failure that looks
        // like a success.
        text:
          event.inferredCriteria === 0
            ? `verdict written — every criterion traced to your ticket — ${event.verdictPath}`
            : `verdict written — ${event.inferredCriteria} criteria were not stated in your ticket — ${event.verdictPath}`,
      };
    case "status":
      return {
        ...base,
        kind: "status",
        level: event.status === "failed" ? "error" : "info",
        text: `status → ${event.status}`,
      };
    // Token updates land in the counters panel; putting them in the trace
    // would bury the lines that carry meaning.
    case "tokens":
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

export type StreamState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "offline"
  | "closed";

export interface LiveRun {
  readonly run: RunDetail | undefined;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly trace: readonly TraceEntry[];
  readonly stream: StreamState;
  readonly refresh: () => void;
  readonly reconnect: () => void;
}

/** Give up on the socket after this many consecutive failures and poll instead. */
const MAX_CONSECUTIVE_STREAM_ERRORS = 5;

function pollIntervalFor(status: RunStatus | undefined, stream: StreamState): number {
  if (status === undefined) return 0;
  if (isTerminalStatus(status)) return 0;
  // A rate-limited run can sit for hours; poll it lazily. While the socket is
  // healthy the stream carries the load and polling is only a safety net.
  if (status === "rate_limited" || status === "awaiting_input") return 20_000;
  return stream === "open" ? 15_000 : 4_000;
}

/**
 * One run, one state tree.
 *
 * SSE deltas are written INTO the SWR cache rather than into a parallel
 * `useState`. Two independent trees is the classic source of flicker here: a
 * background revalidation would otherwise stomp fresher stream state.
 */
export function useLiveRun(runId: string | null): LiveRun {
  const key = runId === null ? null : KEY.run(runId);
  const [trace, dispatchTrace] = useReducer(traceReducer, EMPTY_TRACE);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  /**
   * One socket lifetime, identified by run + reconnect attempt. The state is
   * stamped with the generation it belongs to, so "connecting" falls out of
   * the derivation the instant a new socket is warranted — no effect writes
   * it, and a late callback from a torn-down socket cannot revive a stale
   * status.
   */
  const socketGen = `${runId ?? ""}#${reconnectNonce}`;
  const [socketState, setSocketState] = useState<{
    gen: string;
    state: StreamState;
  }>(() => ({ gen: socketGen, state: "connecting" }));
  const socket: StreamState =
    runId === null
      ? "idle"
      : socketState.gen === socketGen
        ? socketState.state
        : "connecting";

  const { data, error, isLoading, mutate } = useSWR<RunDetail>(
    key,
    swrFetcher<RunDetail>,
    {
      revalidateOnFocus: true,
      shouldRetryOnError: true,
      errorRetryInterval: 5_000,
    },
  );

  const status = data?.status;

  // EventSource reconnects indefinitely on a normally-closed stream, so a
  // finished run must not hold one open. Derived, not written by an effect:
  // the socket's own state is irrelevant once the run is terminal.
  const streamClosed = status !== undefined && isTerminalStatus(status);
  const stream: StreamState = streamClosed ? "closed" : socket;

  const refreshInterval = pollIntervalFor(status, stream);

  // Bound the poll to the SWR instance without re-subscribing on every render.
  useEffect(() => {
    if (key === null || refreshInterval === 0) return;
    const timer = window.setInterval(() => {
      void mutate();
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [key, refreshInterval, mutate]);

  useEffect(() => {
    if (runId === null || streamClosed) return;

    let disposed = false;
    let consecutiveErrors = 0;
    const source = new EventSource(apiUrl(KEY.events(runId)));
    const mark = (state: StreamState): void =>
      setSocketState({ gen: socketGen, state });

    const ingest = (raw: string, fallbackType: RunEventType | null): void => {
      const event = parseRunEvent(raw, fallbackType);
      if (event === null) return;

      const row = traceRowFor(event);
      if (row !== null) dispatchTrace({ kind: "append", entry: row });

      let unresolvedCriterion = false;
      void mutate(
        (previous) => {
          const next = applyRunEvent(previous, event);
          if (
            event.type === "criterion" &&
            previous !== undefined &&
            next === previous
          ) {
            // The criterion is not in the cached record yet — the authoritative
            // list has to come from REST; it is never fabricated here.
            unresolvedCriterion = true;
          }
          return next;
        },
        { revalidate: false },
      );

      // Reconcile against REST only where REST carries fields the stream
      // cannot: a terminal status settles `endedAt`, `heldOutPass`,
      // `falseFinish`, `artifactPath` and `previewUrl`; a stalled one settles
      // `rateLimit`. A `running` -> `running` refetch would buy nothing and
      // gives a backend whose read model lags its event bus a chance to flap
      // the status backwards.
      const settlesExtraFields =
        event.type === "status" &&
        (isTerminalStatus(event.status) || isStalledStatus(event.status));

      if (unresolvedCriterion || settlesExtraFields) {
        void mutate();
      }
    };

    source.onopen = (): void => {
      if (disposed) return;
      consecutiveErrors = 0;
      mark("open");
    };

    source.onmessage = (message: MessageEvent<string>): void => {
      if (disposed) return;
      consecutiveErrors = 0;
      mark("open");
      ingest(message.data, null);
    };

    // A backend that uses named SSE events instead of the default `message`.
    const namedListeners = EVENT_TYPES.map((type) => {
      const listener = (message: Event): void => {
        if (disposed) return;
        consecutiveErrors = 0;
        mark("open");
        ingest((message as MessageEvent<string>).data, type);
      };
      source.addEventListener(type, listener);
      return { type, listener } as const;
    });

    source.onerror = (): void => {
      if (disposed) return;
      consecutiveErrors += 1;
      // Do not trust accumulated stream state across a drop: re-read the run
      // from REST, which is authoritative.
      void mutate();
      if (consecutiveErrors >= MAX_CONSECUTIVE_STREAM_ERRORS) {
        source.close();
        mark("offline");
        dispatchTrace({
          kind: "append",
          entry: {
            atMs: Date.now(),
            kind: "client",
            level: "warn",
            text: `Live trace disconnected after ${consecutiveErrors} attempts. Falling back to polling; the run itself is unaffected.`,
            name: null,
            result: null,
          },
        });
        return;
      }
      mark("reconnecting");
    };

    return () => {
      disposed = true;
      for (const { type, listener } of namedListeners) {
        source.removeEventListener(type, listener);
      }
      source.close();
    };
  }, [runId, streamClosed, socketGen, mutate]);

  // A new run id gets a clean trace.
  useEffect(() => {
    dispatchTrace({ kind: "reset" });
  }, [runId]);

  const refresh = useCallback((): void => {
    void mutate();
  }, [mutate]);

  const reconnect = useCallback((): void => {
    setReconnectNonce((nonce) => nonce + 1);
    void mutate();
  }, [mutate]);

  return useMemo(
    (): LiveRun => ({
      run: data,
      error,
      isLoading,
      trace: trace.entries,
      stream,
      refresh,
      reconnect,
    }),
    [data, error, isLoading, trace.entries, stream, refresh, reconnect],
  );
}

/**
 * A ticking clock.
 *
 * The initializer runs again on the client during hydration, so `now` is
 * already the browser's clock — and nothing derived from it is rendered before
 * wire data arrives anyway, which is what keeps elapsed times and countdowns
 * out of hydration-mismatch territory.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
