"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import useSWR from "swr";

import {
  isRunStatus,
  isStalledStatus,
  isTerminalStatus,
  type CriterionResult,
  type GraphAgentState,
  type GraphAttribution,
  type GraphMcpServer,
  type GraphSdkRef,
  type GraphState,
  type LogLevel,
  type RunDetail,
  type RunEvent,
  type RunEventType,
  type RunLane,
  type RunStatus,
} from "./api-types";
import { KEY, apiUrl, swrFetcher } from "./api";
import { seqOf, useRunGraph } from "./use-run-graph";

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
const EVENT_TYPES = [
  "phase",
  "log",
  "tool",
  "criterion",
  "screenshot",
  "tokens",
  "rate_limit",
  "verdict",
  "status",
  // The orchestration canvas, spec §9.1. These seven are the reason the guard
  // below exists: they were added to four hand-maintained declaration sites in
  // one commit, and forgetting THIS one still compiles clean on both sides —
  // only `contract-parity.test.ts` says so.
  "graph_agent",
  "graph_agent_status",
  "graph_tool",
  "graph_skill",
  "graph_hook",
  "graph_result",
  "graph_inventory",
] as const satisfies readonly RunEventType[];

/**
 * THE GUARD. The SSE union is declared in FOUR hand-maintained places — the
 * server's `api-types.ts`, this package's `api-types.ts`, the runtime array
 * above, and `parseRunEvent`'s switch below. NO COMPILER ENFORCES AGREEMENT
 * ACROSS THEM: widening one and forgetting another COMPILES CLEAN ON BOTH SIDES
 * AND SILENTLY RENDERS AN EMPTY CANVAS, because a backend using NAMED SSE events
 * only delivers what a listener is registered for, and `readonly RunEventType[]`
 * is just as valid when it is short. What does enforce it is a TEST, named at the
 * bottom of this comment; this guard covers one edge of the four.
 *
 * `as const satisfies` above is what makes this checkable: it pins the array to
 * its literal members while still requiring every one of them to be a real
 * event type. `Missing` is then the set of union members nobody listens for, and
 * the assignment fails to compile unless that set is empty.
 *
 * MUTATION-PROVEN, NOT ASSERTED. Executed twice on 2026-07-29:
 *
 *   - deleting `"graph_skill"` failed `npm run typecheck` with, verbatim,
 *     `src/lib/use-run-stream.ts(134,7): error TS2322: Type 'true' is not
 *     assignable to type 'never'.` — run twice over, because `incremental: true`
 *     is set and a stale result would have proven nothing;
 *   - deleting `"graph_inventory"` failed `npm run build`, not merely the type
 *     check: `Type error: Type 'true' is not assignable to type 'never'` at this
 *     line, `Next.js build worker exited with code: 1`.
 *
 * Both restored, and both clean again. A guard nobody has watched fail is not a
 * guard.
 *
 * WHAT IT DOES NOT COVER, IN THESE WORDS: it ties THIS package's `RunEventType`
 * to THIS array, and it is ONE-DIRECTIONAL. A member ADDED to the server's
 * `SseEvent` union and to nothing else leaves this guard green — a mirror that
 * has never heard of an event type is a perfectly valid mirror — and the UI then
 * drops those events silently, which is this guard's own failure mode reached
 * from the side it cannot see. It also says nothing about `parseRunEvent` below,
 * which drops an unhandled type at its `default` with no type error available,
 * because `type` there is `string | null`.
 *
 * WHAT COVERS THOSE TWO, BY NAME: `dashboard/server/src/contract-parity.test.ts`,
 * which imports the server's `SSE_EVENT_TYPES` — a real value, proven complete
 * against `SseEvent` by an `Exclude` guard next to it — and reads THIS FILE and
 * this package's `api-types.ts` as text. Its three checks are "the client's
 * RunEvent union names exactly the server's SseEvent members", "the client
 * registers an SSE listener for every server event type" and "parseRunEvent has a
 * case for every server event type". Adding a member to the server union and to
 * `SSE_EVENT_TYPES`, with this file untouched, turned all three red on
 * 2026-07-29; misnaming `case "graph_inventory"` below turned the third red while
 * `npm run typecheck` here stayed clean. If `EVENT_TYPES` is renamed or moved,
 * that test fails loudly on a missing anchor — re-point it, do not delete it.
 */
type Missing = Exclude<RunEventType, (typeof EVENT_TYPES)[number]>;
const _noneMissing: Missing extends never ? true : never = true;
void _noneMissing;

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

/* ---- canvas narrowing, spec §9.1 ---------------------------------- */

/**
 * These stay DUMB ON PURPOSE. Whether an emitter is honest about `attribution`
 * is a server-side property and is asserted server-side, where it is
 * mutation-provable; all this side can do is refuse a value that is not one of
 * the two literals. An event that fails any check here is DROPPED, exactly like
 * a `verdict` with no path: a graph event whose node or attribution cannot be
 * read is not a weaker graph event, it is not one.
 */
function asAttribution(value: unknown): GraphAttribution | null {
  return value === "exact" || value === "inferred" ? value : null;
}

function asAgentState(value: unknown): GraphAgentState | null {
  return value === "running" || value === "completed" || value === "failed" || value === "stopped"
    ? value
    : null;
}

function asLane(value: unknown): RunLane | null {
  return value === "spec" ||
    value === "design" ||
    value === "build" ||
    value === "review" ||
    value === "gate"
    ? value
    : null;
}

/** A node id, or null. Empty is null: "" names no node. */
function asNode(value: unknown): string | null {
  const text = asString(value);
  return text === null || text.length === 0 ? null : text;
}

/** Null when the CLI reported nothing. NEVER 0, which would be a claim. */
function asNullableNumber(value: unknown): number | null {
  return asNumber(value);
}

function asStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text !== null) out.push(text);
  }
  return out;
}

function asSdkRef(value: unknown): GraphSdkRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const taskId = asString(record["taskId"]);
  if (taskId === null) return null;
  return { taskId, toolUseId: asString(record["toolUseId"]) };
}

function asMcpServers(value: unknown): readonly GraphMcpServer[] {
  if (!Array.isArray(value)) return [];
  const out: GraphMcpServer[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = asString(record["name"]);
    if (name === null) continue;
    out.push({ name, status: asString(record["status"]) ?? "" });
  }
  return out;
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
export /**
 * The server's recorded instant, if the frame carried one.
 *
 * Spread rather than assigned so a frame WITHOUT `at` produces an object with no `at`
 * key at all — `exactOptionalPropertyTypes` refuses an explicit `undefined`, and a
 * missing key is also what `instantOf` expects for a pre-timestamp row.
 */
function atOf(record: Record<string, unknown>): { at?: string } {
  const at = record["at"];
  return typeof at === "string" ? { at } : {};
}

/**
 * EXPORTED FOR TESTING, and the reason is a bug it let through.
 *
 * The live timeline lost every timestamp because this function dropped `at`, and the
 * only check that existed exercised the SERVER's fold over a finished run. Nothing
 * could reach this path from a test, so nothing did. `use-run-stream.unit.spec.ts`
 * now drives it directly.
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
      // DEFAULTS TO NOT-LIMITED when the field is absent or not a boolean.
      // A frame from a server that predates `limited` reports a window reset
      // instant and nothing about a refusal, so reading it as "not limited" is
      // what it actually said. The old default was the opposite and that is the
      // whole bug: `true` turned every routine window reading into a refusal.
      return {
        type: "rate_limit",
        limited: record["limited"] === true,
        retryAfterSec: retryAfterSec ?? 0,
      };
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

    /* ---- the canvas, spec §9.1 -------------------------------------- */
    //
    // THESE CASES ARE LOAD-BEARING AND NO TYPE CATCHES THEIR ABSENCE. The guard
    // at `EVENT_TYPES` proves a LISTENER is registered for every union member;
    // it says nothing about this switch, whose `default` returns null and whose
    // `type` is `string | null`, so no exhaustiveness check is available. A
    // `graph_*` event with no case here arrives, is dropped, and the canvas
    // renders empty with a clean compile — measured on 2026-07-29 by misnaming
    // `case "graph_inventory"`, after which `npm run typecheck` exited 0.
    //
    // WHAT DOES CATCH IT, since no type can: the third check in
    // `dashboard/server/src/contract-parity.test.ts`, "parseRunEvent has a case
    // for every server event type", which reads these labels out of this file
    // and compares them to the server's `SSE_EVENT_TYPES`. Under that mutation it
    // was red while this package's `tsc` exited 0, and it is the only check in
    // either package with a path into this file — which is why it is the only one
    // that could have seen it. It sees a LABEL, not a correct body.
    case "graph_agent": {
      const node = asNode(record["node"]);
      const attribution = asAttribution(record["attribution"]);
      if (node === null || attribution === null) return null;
      return {
        type: "graph_agent",
        node,
        parent: asNode(record["parent"]),
        // Null is a REPORTED value here, not a parse failure: `subagent_type`
        // is optional in the SDK's own typing and ambient tasks carry none.
        agent: asString(record["agent"]),
        lane: asLane(record["lane"]),
        description: asString(record["description"]) ?? "",
        ambient: record["ambient"] === true,
        attribution,
        sdk: asSdkRef(record["sdk"]),
      };
    }
    case "graph_agent_status": {
      const node = asNode(record["node"]);
      const state = asAgentState(record["state"]);
      const attribution = asAttribution(record["attribution"]);
      if (node === null || state === null || attribution === null) return null;
      return { type: "graph_agent_status", node, state, attribution };
    }
    case "graph_tool": {
      const node = asNode(record["node"]);
      const name = asString(record["name"]);
      const attribution = asAttribution(record["attribution"]);
      if (node === null || name === null || attribution === null) return null;
      /*
       * `at` IS CARRIED, AND DROPPING IT MADE THE LIVE TIMELINE USELESS.
       *
       * This parser rebuilds each event field by field — which is right, it is
       * validating untrusted wire data — and `at` was simply not in the list. The
       * server put it on the wire (`SseWireEvent`), `foldGraph` reads it via
       * `instantOf`, and this line threw it away in between. Result: every step that
       * arrived WHILE YOU WATCHED folded to `at: null` and the timeline printed an em
       * dash for it. Only steps already durable at page load — folded server-side by
       * `graphSnapshot` — had times.
       *
       * THE CHECK THAT MISSED IT: "388/388 events carry `at`, 304 distinct timestamps"
       * was run against the SNAPSHOT path on a finished run. It exercised the server
       * fold and never this function, so it could not have caught this no matter how
       * green it went. A property proved on one of two paths is proved on one path.
       */
      return {
        type: "graph_tool",
        node,
        name,
        mcpServer: asString(record["mcpServer"]),
        summary: asString(record["summary"]) ?? "",
        attribution,
        ...atOf(record),
      };
    }
    case "graph_skill": {
      const node = asNode(record["node"]);
      const skill = asString(record["skill"]);
      const source = record["source"];
      const attribution = asAttribution(record["attribution"]);
      if (node === null || skill === null || attribution === null) return null;
      if (source !== "preloaded" && source !== "invoked") return null;
      return { type: "graph_skill", node, skill, source, attribution, ...atOf(record) };
    }
    case "graph_hook": {
      const node = asNode(record["node"]);
      const decision = record["decision"];
      const attribution = asAttribution(record["attribution"]);
      if (node === null || attribution === null) return null;
      if (decision !== "allow" && decision !== "deny") return null;
      return {
        type: "graph_hook",
        node,
        event: asString(record["event"]) ?? "",
        tool: asString(record["tool"]) ?? "",
        decision,
        reason: asString(record["reason"]) ?? "",
        attribution,
      };
    }
    case "graph_result": {
      const node = asNode(record["node"]);
      const state = asAgentState(record["state"]);
      const attribution = asAttribution(record["attribution"]);
      if (node === null || state === null || attribution === null) return null;
      return {
        type: "graph_result",
        node,
        state,
        summary: asString(record["summary"]) ?? "",
        // NULL, NOT 0. A run that reported no usage did not report zero usage.
        totalTokens: asNullableNumber(record["totalTokens"]),
        toolUses: asNullableNumber(record["toolUses"]),
        durationMs: asNullableNumber(record["durationMs"]),
        attribution,
      };
    }
    case "graph_inventory":
      return {
        type: "graph_inventory",
        agents: asCount(record["agents"]),
        skills: asCount(record["skills"]),
        tools: asCount(record["tools"]),
        allowedAgents: asStrings(record["allowedAgents"]),
        mcpServers: asMcpServers(record["mcpServers"]),
        plugins: asStrings(record["plugins"]),
        model: asString(record["model"]) ?? "",
        claudeCodeVersion: asString(record["claudeCodeVersion"]) ?? "",
        environmentHash: asString(record["environmentHash"]) ?? "",
      };

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
          // FROM THE EVENT, NOT HARD-CODED. This read `limited: true` for every
          // rate_limit frame, so a window-reset reading two seconds into a
          // healthy run set the same state a real refusal does.
          limited: event.limited,
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

/**
 * EXPORTED SO A TEST CAN REACH IT, for the reason `parseRunEvent` was.
 *
 * This is the function that writes the words the reader actually sees in the
 * trace, and nothing could call it from outside this module — so the sentence
 * `rate limited; retry after 253699s` was never checked by anything. The trace
 * is LIVE-ONLY (a finished run renders "no live trace to replay"), so a browser
 * cannot show these rows after the fact either: a unit test is not a shortcut
 * here, it is the only reachable check.
 */
export function traceRowFor(event: RunEvent): Omit<TraceEntry, "seq"> | null {
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
      // TWO DIFFERENT SENTENCES, because they are two different facts. A
      // not-limited frame is the provider saying when the window you are in
      // reopens — worth showing as it fills, at `info`, in words that do not
      // claim anything was refused. Only a real refusal is a warning.
      return {
        ...base,
        kind: "rate_limit",
        level: event.limited ? "warn" : "info",
        text: event.limited
          ? event.retryAfterSec > 0
            ? `rate limited; retry after ${event.retryAfterSec}s`
            : "rate limited"
          : event.retryAfterSec > 0
            ? `provider quota: nothing refused; this window reopens in ${event.retryAfterSec}s`
            : "provider quota reported; nothing refused",
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
  /**
   * The orchestration canvas.
   *
   * ITS OWN ACCUMULATOR, NEVER DERIVED FROM `trace`. `MAX_TRACE_ENTRIES` slices
   * oldest-first, so a canvas rebuilt from trace rows would delete its earliest
   * agents 3,000 events into a long run — nodes vanishing mid-run with nothing
   * in the UI to explain it (spec §9.3).
   */
  readonly graph: GraphState;
  /** False until the graph snapshot has settled; the socket waits on it. */
  readonly graphReady: boolean;
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
  const graph = useRunGraph(runId);
  const graphReady = graph.settled;
  const graphIngest = graph.ingest;

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
    // THE SOCKET WAITS FOR THE GRAPH SNAPSHOT. `attachSse` replays from row 0,
    // and those rows are the ones the snapshot has already folded — so opening
    // before the watermark exists would leave `useRunGraph` deduping against a
    // number it does not have yet, and `foldGraph` is not idempotent. One
    // loopback round trip of "connecting" is the whole cost, and on the error
    // path the watermark settles at 0 so nothing waits forever.
    if (runId === null || streamClosed || !graphReady) return;

    let disposed = false;
    let consecutiveErrors = 0;
    const source = new EventSource(apiUrl(KEY.events(runId)));
    const mark = (state: StreamState): void =>
      setSocketState({ gen: socketGen, state });

    const ingest = (
      raw: string,
      fallbackType: RunEventType | null,
      seq: number,
    ): void => {
      const event = parseRunEvent(raw, fallbackType);
      if (event === null) return;

      // The canvas sees EVERY event, including `status` — a terminal one is
      // what resolves an agent still reading `running` to `unresolved` rather
      // than leaving it spinning forever inside a cancelled run.
      graphIngest(event, seq);

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
      ingest(message.data, null, seqOf(message));
    };

    // A backend that uses named SSE events instead of the default `message`.
    const namedListeners = EVENT_TYPES.map((type) => {
      const listener = (message: Event): void => {
        if (disposed) return;
        consecutiveErrors = 0;
        mark("open");
        const framed = message as MessageEvent<string>;
        ingest(framed.data, type, seqOf(framed));
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
  }, [runId, streamClosed, graphReady, graphIngest, socketGen, mutate]);

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
      graph: graph.state,
      graphReady,
      stream,
      refresh,
      reconnect,
    }),
    [
      data,
      error,
      isLoading,
      trace.entries,
      graph.state,
      graphReady,
      stream,
      refresh,
      reconnect,
    ],
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
