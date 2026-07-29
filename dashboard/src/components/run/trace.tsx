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
  verdict: "verdict",
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

function streamBadge(stream: StreamState): { tone: Tone; label: string; hint: string } {
  switch (stream) {
    case "open":
      return { tone: "pass", label: "live", hint: "Streaming from /events." };
    case "connecting":
      return { tone: "info", label: "connecting", hint: "Opening the event stream." };
    case "reconnecting":
      return {
        tone: "warn",
        label: "reconnecting",
        hint: "The stream dropped. The run itself is unaffected; state is being re-read from the API.",
      };
    case "offline":
      return {
        tone: "warn",
        label: "not streaming",
        hint: "Gave up on the event stream and fell back to polling. Use reconnect to try again.",
      };
    case "closed":
      return {
        tone: "neutral",
        label: "closed",
        hint: "The run reached a terminal state, so the stream was closed deliberately.",
      };
    case "idle":
      return { tone: "neutral", label: "idle", hint: "No stream open." };
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
      title="Trace"
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
          <EmptyState>
            {stream === "closed"
              ? "This run finished before the page was opened, so there is no live trace to replay. The criteria and artefacts below are the record."
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
