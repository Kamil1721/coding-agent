"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { formatTimeOnly } from "@/lib/format";
import type { StreamState, TraceEntry, TraceKind } from "@/lib/use-run-stream";
import { Badge, Button, Dot, EmptyState, Panel, cx } from "@/components/ui";
import type { Tone } from "@/lib/presentation";

const KIND_LABEL: Readonly<Record<TraceKind, string>> = {
  log: "log",
  tool: "tool",
  phase: "phase",
  criterion: "crit",
  screenshot: "shot",
  rate_limit: "limit",
  /*
   * "grade", NOT "verdict" — 2026-08-05, and the column width is the second
   * reason rather than the first. The panel this pane is mounted in is called
   * ACTIVITY, and the owner's rule is one vocabulary: a row labelled `VERDICT`
   * inside it is the product contradicting its own rail. `grade` is what the
   * event records — the gate wrote its per-criterion result file — and at five
   * characters it also fits the 38px column that `verdict` overflowed.
   *
   * THE SENTENCE BESIDE IT STILL SAYS "verdict written", and that string is NOT
   * this file's: it is written in `lib/use-run-stream.ts:783-784`, another
   * lane's file this pass. Named here so the mismatch is a recorded hand-off
   * rather than something the next reader has to rediscover.
   */
  verdict: "grade",
  status: "state",
  client: "ui",
};

const KIND_CLASS: Readonly<Record<TraceKind, string>> = {
  log: "text-ink-faint",
  tool: "text-accent",
  phase: "text-info",
  criterion: "text-info",
  screenshot: "text-info",
  rate_limit: "text-warn",
  verdict: "text-accent",
  status: "text-info",
  client: "text-ink-faint",
};

const LEVEL_CLASS = {
  info: "text-ink-dim",
  warn: "text-warn",
  error: "text-fail",
} as const;

/*
 * THE SIX HINTS ARE THE BADGE'S `title`, AND THEY WERE REWRITTEN IN PLAIN WORDS
 * ON 2026-08-05 RATHER THAN SHORTENED FOR THE SAKE OF IT. Each one still says
 * the same thing about the same state; what went is the vocabulary only this
 * repository uses — `/events` (a route the reader cannot visit), "polling",
 * "the API", "a terminal state". "The run itself is unaffected" is the one
 * clause here worth its length: a dropped connection looks like a broken run,
 * and that sentence is the only thing that says it is not.
 */
function streamBadge(stream: StreamState): { tone: Tone; label: string; hint: string } {
  switch (stream) {
    case "open":
      return { tone: "pass", label: "live", hint: "Events are arriving as they happen." };
    case "connecting":
      return { tone: "info", label: "connecting", hint: "Opening the live connection." };
    case "reconnecting":
      return {
        tone: "warn",
        label: "reconnecting",
        hint: "The live connection dropped. The run itself is unaffected, and this page keeps refreshing.",
      };
    case "offline":
      return {
        tone: "warn",
        label: "not streaming",
        hint: "No live connection. This page refreshes on a timer instead — use reconnect to try again.",
      };
    case "closed":
      return {
        tone: "neutral",
        label: "closed",
        hint: "The run finished, so the live connection was closed.",
      };
    case "idle":
      return { tone: "neutral", label: "idle", hint: "No live connection." };
    default:
      return { tone: "neutral", label: String(stream), hint: "" };
  }
}

export function TracePane({
  trace,
  stream,
  onReconnect,
}: {
  trace: readonly TraceEntry[];
  stream: StreamState;
  onReconnect: () => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const badge = streamBadge(stream);

  useEffect(() => {
    if (!follow) return;
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [trace, follow]);

  function onScroll(): void {
    const node = scrollRef.current;
    if (node === null) return;
    const atBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setFollow(atBottom);
  }

  return (
    <Panel
      /*
       * "Activity", NOT "Trace" — 2026-08-05. This pane is mounted by
       * `ActivityPanel` (canvas/sheet.tsx) inside the rail entry the owner reads
       * as ACTIVITY, and a card headed TRACE inside a panel headed Activity is a
       * contradiction he can see on one screen. `trace` stays the name of the
       * prop, the type and the stream state, where it is precise; it is not a
       * word for a heading.
       *
       * THE HEADING IS NOT DEAD WEIGHT NEXT TO THE PANEL'S OWN. It carries the
       * stream badge, `reconnect` and `follow` — the controls that say whether
       * what is below is still arriving — so the strip has to exist whatever it
       * is called.
       */
      title="Activity"
      actions={
        <>
          <Badge tone={badge.tone} title={badge.hint}>
            <Dot tone={badge.tone} pulse={stream === "open"} />
            {badge.label}
          </Badge>
          {(stream === "offline" || stream === "reconnecting") && (
            <Button variant="ghost" onClick={onReconnect}>
              reconnect
            </Button>
          )}
          {!follow && (
            <Button
              variant="ghost"
              onClick={() => {
                setFollow(true);
                const node = scrollRef.current;
                if (node !== null) node.scrollTop = node.scrollHeight;
              }}
            >
              follow
            </Button>
          )}
        </>
      }
      bodyClassName="p-0"
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cx(
          "overflow-y-auto overscroll-contain px-2 py-1.5",
          // A live pane keeps a fixed height so arriving lines do not reflow
          // the page under the reader. An empty one collapses instead of
          // reserving 380px of nothing on a finished run.
          trace.length === 0 ? "h-auto" : "h-[380px]",
        )}
      >
        {trace.length === 0 ? (
          /*
           * "ON RESULT", NOT "BELOW" — corrected 2026-08-05 with the word
           * TRACE. This pane used to sit at the bottom of a scrolling sheet with
           * the criteria and the captures under it, and that sentence was true
           * of that layout. `ActivityPanel` mounts this pane and NOTHING ELSE,
           * so "below" now points at the end of the panel. The facts did not
           * move — they are on the Result panel — so the sentence names it.
           *
           * CUT TO TWO CLAUSES LATER THE SAME DAY, and the clause that went was
           * "so there is nothing left to watch arrive": an empty pane on a
           * finished run does not need to be told it is empty. The pointer at
           * Result is the only part of this string a reader can act on, so it is
           * the part that stayed.
           */
          <EmptyState>
            {stream === "closed"
              ? "This run finished before you opened this page. The criteria and captures are on Result."
              : "Waiting for the first event."}
          </EmptyState>
        ) : (
          <ol className="font-mono text-[11.5px] leading-[1.55]">
            {trace.map((entry) => (
              <li key={entry.seq} className="flex gap-2 py-[1px]">
                <span className="w-[58px] shrink-0 text-ink-faint/70 tabular-nums">
                  {formatTimeOnly(new Date(entry.atMs).toISOString())}
                </span>
                <span
                  className={cx(
                    "w-[38px] shrink-0 uppercase",
                    KIND_CLASS[entry.kind],
                  )}
                >
                  {KIND_LABEL[entry.kind]}
                </span>
                <span
                  className={cx(
                    "min-w-0 flex-1 whitespace-pre-wrap break-words",
                    LEVEL_CLASS[entry.level],
                  )}
                >
                  {entry.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}
