"use client";

/**
 * use-run-graph.ts — the canvas's state, and the ONLY place the snapshot and the
 * live tail are joined.
 *
 * THE REDUCER IS NOT DECLARED HERE. It is `foldGraph`, imported through
 * `./graph`, which re-exports the SERVER's module. There is no client mirror to
 * keep in step; see that file's header for why an import beats a copy plus a
 * fixture.
 *
 * THE SHAPE, AND THE TWO FACTS THAT FORCE IT
 *
 * 1. A FINISHED RUN OPENS NO SOCKET AT ALL. `useLiveRun` derives `streamClosed`
 *    from a terminal status and never constructs an `EventSource`, because one
 *    left open on a normally-closed stream reconnects forever. So for every run
 *    the owner opens after it ended — which is most of them — the SNAPSHOT IS
 *    THE ONLY SOURCE. That rules out "just fold the socket from seq 0 and skip
 *    the endpoint": it would render an empty canvas for every finished run.
 *
 * 2. THE SOCKET REPLAYS FROM ZERO. `useLiveRun` opens `/events` with no
 *    `lastEventId`, and `attachSse` replays every durable row from 0, because
 *    the TRACE pane needs the whole history. Those rows are the same rows the
 *    snapshot already folded. `foldGraph` is NOT idempotent — `graph_tool` bumps
 *    a call count — so folding them twice does not produce a stale canvas, it
 *    produces a WRONG one: every tool pill on the run reads roughly double.
 *
 * Hence: the snapshot is the base, and a tail event is folded only when its
 * `seq` is past the snapshot's watermark. `seq` is on the wire already —
 * `bus.ts` writes `id: <seq>` before every frame, so the browser hands it back
 * as `MessageEvent.lastEventId`. Nothing new had to be added to the contract.
 *
 * THE ONE RACE, AND WHY THERE IS NO BUFFER FOR IT. Between the snapshot request
 * and its response, a live run can emit rows. If the socket were already open,
 * those rows would arrive, be deduped against a watermark that does not exist
 * yet, and vanish. Rather than buffer them and invent an overflow state, the
 * socket does not open until the snapshot has SETTLED — resolved or errored.
 * On error the base is `emptyGraph()` and the watermark is 0, so the tail folds
 * from the beginning and the canvas is still correct; it just paid for the
 * replay it was trying to avoid. The failure path degrades into the slow
 * version of the right answer instead of into a flag nobody will read.
 */

import { useCallback, useMemo, useReducer } from "react";
import useSWR from "swr";

import type { GraphState, RunEvent, RunGraphResponse } from "./api-types";
import { KEY, swrFetcher } from "./api";
import { emptyGraph, foldGraph } from "./graph";

/**
 * A seq the browser could not give us.
 *
 * `bus.ts` writes `id:` before EVERY frame, so this should be unreachable. It is
 * handled anyway because the alternative to a total function here is a canvas
 * that silently stops updating if a future server ever drops the id line.
 *
 * WHAT ACTUALLY BACKS THAT, NAMED RATHER THAN ASSERTED. Nothing checks
 * `lastEventId` directly — but the browser harness asserts the orchestrator's
 * `Read` pill reads `×2` after the tail has streamed, and if ids stopped
 * arriving EVERY event would take the fold-anyway branch below and that pill
 * would read `×4`. Executed as a mutation on 2026-07-29 by deleting the dedup
 * guard: the check went red with exactly `Read, called 4×`. So the id line is
 * covered transitively, and this sentence says which check does it instead of
 * claiming one that does not exist.
 */
export const UNKNOWN_SEQ = -1;

export interface RunGraph {
  /** The folded canvas. `emptyGraph()` for every run recorded before Phase 3. */
  readonly state: GraphState;
  /**
   * True once the snapshot has resolved OR failed. `useLiveRun` holds the
   * socket shut until this flips; see the header.
   */
  readonly settled: boolean;
  /** The snapshot's own failure, if it had one. Never the stream's. */
  readonly error: unknown;
  /** Fold one tail event. Ignores anything the snapshot already covered. */
  readonly ingest: (event: RunEvent, seq: number) => void;
}

interface Accumulator {
  /**
   * Which run this state belongs to.
   *
   * Carried IN the state rather than cleared by an effect. An effect runs after
   * paint, so navigating from one run to another would paint one frame of the
   * PREVIOUS run's agents on the new run's page — a canvas showing work that
   * belongs to something else, which is worse than a blank one.
   */
  readonly runId: string | null;
  readonly state: GraphState;
  /**
   * The highest seq already folded. Rises as the tail is consumed, so a
   * reconnect that replays a frame the client already saw cannot double-count
   * it either.
   */
  readonly atSeq: number;
  readonly settled: boolean;
}

type Action =
  | { readonly kind: "snapshot"; readonly state: GraphState; readonly atSeq: number }
  | { readonly kind: "snapshot_failed" }
  | { readonly kind: "event"; readonly event: RunEvent; readonly seq: number }
  | { readonly kind: "reset"; readonly runId: string | null };

const EMPTY: Accumulator = {
  runId: null,
  state: emptyGraph(),
  atSeq: 0,
  settled: false,
};

export function graphReducer(state: Accumulator, action: Action): Accumulator {
  switch (action.kind) {
    case "reset":
      return { ...EMPTY, runId: action.runId };

    case "snapshot":
      // A second snapshot for the same run — SWR revalidates on focus — must
      // not throw away tail events already folded on top of the first one.
      // Once settled, the base is fixed and the tail owns the canvas.
      if (state.settled) return state;
      return {
        runId: state.runId,
        state: action.state,
        atSeq: action.atSeq,
        settled: true,
      };

    case "snapshot_failed":
      if (state.settled) return state;
      // Base stays empty and the watermark stays 0, so the socket's
      // replay-from-zero rebuilds the whole canvas by itself.
      return { ...state, settled: true };

    case "event": {
      if (!state.settled) return state;
      // The snapshot already folded this row. Not stale — ALREADY COUNTED.
      if (action.seq !== UNKNOWN_SEQ && action.seq <= state.atSeq) return state;
      const next = foldGraph(state.state, action.event);
      const atSeq = action.seq === UNKNOWN_SEQ ? state.atSeq : action.seq;
      // `foldGraph` returns the SAME object for an event it does not recognise —
      // which is every `log` and `tool` row, i.e. the overwhelming majority of
      // the stream. Returning `state` unchanged there is what keeps the canvas
      // from re-rendering on every log line.
      if (next === state.state && atSeq === state.atSeq) return state;
      return { ...state, state: next, atSeq };
    }

    default:
      return state;
  }
}

/**
 * Read a frame's seq off the `MessageEvent`.
 *
 * `EventSource` keeps a "last event ID buffer" that PERSISTS across frames
 * which omit `id:`, so a missing id does not read as empty — it reads as the
 * previous frame's id, which would look like a duplicate and be dropped. That
 * is a failure this function cannot detect from the inside; see `UNKNOWN_SEQ`
 * above for the check that would catch it and how it was proved.
 */
export function seqOf(message: MessageEvent<string>): number {
  const raw = message.lastEventId;
  if (typeof raw !== "string" || raw === "") return UNKNOWN_SEQ;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : UNKNOWN_SEQ;
}

export function useRunGraph(runId: string | null): RunGraph {
  const [accumulator, dispatch] = useReducer(graphReducer, EMPTY);

  const key = runId === null ? null : KEY.graph(runId);
  const { data, error } = useSWR<RunGraphResponse>(key, swrFetcher<RunGraphResponse>, {
    // The snapshot is a base, not a live view. Re-fetching it buys nothing —
    // the socket already carries everything past `atSeq` — and a revalidation
    // that landed mid-run would be discarded by the reducer anyway.
    revalidateOnFocus: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });

  /*
   * ALL THREE TRANSITIONS RUN DURING RENDER, not in an effect. React supports a
   * component adjusting its OWN state while rendering, and each branch below is
   * guarded by the condition it clears, so none of them can loop. The reason to
   * pay for that rather than reach for `useEffect` is that an effect fires after
   * paint: the run-switch would paint the old run's nodes for one frame, and the
   * snapshot would paint an empty canvas for one frame — on a finished run, that
   * blank frame IS the canvas, briefly claiming the run delegated to nobody.
   */
  if (accumulator.runId !== runId) {
    dispatch({ kind: "reset", runId });
  } else if (data !== undefined && !accumulator.settled) {
    dispatch({
      kind: "snapshot",
      state: { nodes: data.nodes, edges: data.edges, inventory: data.inventory },
      atSeq: data.atSeq,
    });
  } else if (error !== undefined && !accumulator.settled) {
    dispatch({ kind: "snapshot_failed" });
  }

  const ingest = useCallback((event: RunEvent, seq: number): void => {
    dispatch({ kind: "event", event, seq });
  }, []);

  // While the accumulator still belongs to the previous run, report the empty
  // canvas rather than the stale one. The dispatch above has already been
  // queued; this only covers the render it was queued during.
  const current = accumulator.runId === runId ? accumulator : EMPTY;

  return useMemo(
    (): RunGraph => ({
      state: current.state,
      settled: current.settled,
      error,
      ingest,
    }),
    [current.state, current.settled, error, ingest],
  );
}
