"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { FalseFinishBadge, HeldOutBadge } from "@/components/outcome";
import { Badge, Dot, EmptyState, Panel, Skeleton, cx } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import type { RunStatus, RunSummary } from "@/lib/api-types";
import { elapsedBetween, formatDuration, formatRelative } from "@/lib/format";
import { useModels, useRuns } from "@/lib/hooks";
import { findModel } from "@/lib/cost";
import { statusMeta } from "@/lib/presentation";
import { useNow } from "@/lib/use-run-stream";

type Filter = "all" | "active" | "attention" | "finished";

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "attention", label: "Needs attention" },
  { id: "finished", label: "Finished" },
];

function matchesFilter(status: RunStatus, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return status === "queued" || status === "running";
    case "attention":
      return status === "rate_limited" || status === "awaiting_input";
    case "finished":
      return status === "passed" || status === "failed" || status === "cancelled";
    default:
      return true;
  }
}

function RunRow({
  run,
  nowMs,
  modelLabel,
}: {
  run: RunSummary;
  nowMs: number;
  modelLabel: string;
}): ReactNode {
  const meta = statusMeta(run.status);
  const elapsed = elapsedBetween(run.startedAt, run.endedAt, nowMs);

  return (
    <tr className="group border-b border-line last:border-b-0 hover:bg-surface-raised/60">
      <td className="py-1.5 pl-3 pr-2 align-top">
        <Badge tone={meta.tone} title={meta.meaning}>
          <Dot tone={meta.tone} pulse={meta.live} />
          {meta.label}
        </Badge>
      </td>
      <td className="min-w-0 py-1.5 pr-3 align-top">
        <Link
          href={`/runs/${encodeURIComponent(run.runId)}`}
          className="block truncate text-[13px] text-ink underline-offset-2 hover:underline"
          title={run.ticketTitle}
        >
          {run.ticketTitle === "" ? run.runId : run.ticketTitle}
        </Link>
        <code className="font-mono text-[10.5px] text-ink-faint">{run.runId}</code>
      </td>
      <td className="py-1.5 pr-3 align-top text-[12px] text-ink-dim">
        <span className="block truncate" title={run.modelId}>
          {modelLabel}
        </span>
      </td>
      <td className="numeric py-1.5 pr-3 align-top text-[12px] text-ink-dim whitespace-nowrap">
        {formatRelative(run.startedAt, nowMs)}
      </td>
      <td className="numeric py-1.5 pr-3 align-top text-[12px] text-ink-dim whitespace-nowrap">
        {elapsed === null ? "" : formatDuration(elapsed)}
      </td>
      <td className="py-1.5 pr-3 align-top">
        <span className="flex flex-wrap items-center gap-1.5">
          <HeldOutBadge heldOutPass={run.heldOutPass} compact />
          <FalseFinishBadge falseFinish={run.falseFinish} />
        </span>
      </td>
    </tr>
  );
}

export default function RunsPage(): ReactNode {
  const { data: runs, error, isLoading } = useRuns();
  const { data: models } = useModels();
  const nowMs = useNow(1_000);
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(
    () => (runs ?? []).filter((run) => matchesFilter(run.status, filter)),
    [runs, filter],
  );

  const counts = useMemo(() => {
    const all = runs ?? [];
    return {
      total: all.length,
      attention: all.filter((run) => matchesFilter(run.status, "attention")).length,
      active: all.filter((run) => matchesFilter(run.status, "active")).length,
    };
  }, [runs]);

  return (
    <Panel
      title="Runs"
      subtitle={
        runs === undefined
          ? "History, newest first."
          : `${counts.total} run${counts.total === 1 ? "" : "s"} · ${counts.active} active · ${counts.attention} needing attention`
      }
      actions={
        <div className="flex items-center gap-1">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              className={cx(
                "rounded-sm border px-1.5 py-[2px] text-[11px] transition-colors",
                filter === entry.id
                  ? "border-line-strong bg-surface-raised text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-dim",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
      bodyClassName="p-0"
    >
      {error !== undefined && runs === undefined ? (
        <p className="px-3 py-4 text-[12px] text-warn">{errorMessage(error)}</p>
      ) : isLoading && runs === undefined ? (
        <div className="px-3 py-3">
          <Skeleton rows={5} />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState>
          {(runs ?? []).length === 0
            ? "No runs yet. Submit a ticket to start one."
            : "No runs match this filter."}
        </EmptyState>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {/* Wide enough for the longest badge ("awaiting input"), which
                  otherwise overflows a table-fixed cell into the ticket title. */}
              <th className="w-[136px] py-1.5 pl-3 pr-2 font-semibold">Status</th>
              <th className="py-1.5 pr-3 font-semibold">Ticket</th>
              <th className="w-[190px] py-1.5 pr-3 font-semibold">Model</th>
              <th className="w-[110px] py-1.5 pr-3 font-semibold">Started</th>
              <th className="w-[92px] py-1.5 pr-3 font-semibold">Elapsed</th>
              <th className="w-[220px] py-1.5 pr-3 font-semibold">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                nowMs={nowMs}
                modelLabel={findModel(models, run.modelId)?.label ?? run.modelId}
              />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
