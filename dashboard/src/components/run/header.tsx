"use client";

import type { ReactNode } from "react";

import type { ModelOption, RunDetail } from "@/lib/api-types";
import { isTerminalStatus } from "@/lib/api-types";
import { elapsedBetween, formatClock, formatDuration } from "@/lib/format";
import { PHASE_ORDER, phaseIndex, phaseMeta, statusMeta } from "@/lib/presentation";
import { FalseFinishBadge, HeldOutBadge } from "@/components/outcome";
import { Badge, Button, Dot, cx } from "@/components/ui";

function PhaseRail({ run }: { run: RunDetail }): ReactNode {
  const current = phaseIndex(run.phase);
  const stalled = run.status === "rate_limited" || run.status === "awaiting_input";
  const failedHere = run.status === "failed" && run.phase !== "done";

  return (
    <ol className="flex flex-wrap items-center gap-1">
      {PHASE_ORDER.map((phase, index) => {
        const meta = phaseMeta(phase);
        const done = index < current;
        const active = index === current;
        return (
          <li key={phase} className="flex items-center gap-1">
            <span
              title={meta.blurb}
              className={cx(
                "flex items-center gap-1.5 rounded-sm border px-1.5 py-[2px] text-[11px]",
                active
                  ? failedHere
                    ? "border-fail/45 bg-fail-dim text-fail"
                    : stalled
                      ? "border-warn/40 bg-warn-dim text-warn"
                      : "border-accent/50 bg-accent-dim/40 text-accent"
                  : done
                    ? "border-line-strong bg-surface-raised text-ink-dim"
                    : "border-line text-ink-faint",
              )}
            >
              {active && !stalled && !failedHere && <Dot tone="accent" pulse />}
              {meta.label}
            </span>
            {index < PHASE_ORDER.length - 1 && (
              <span aria-hidden="true" className="text-ink-faint/60">
                ›
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function RunHeader({
  run,
  model,
  nowMs,
  busy,
  onCancel,
  onResume,
}: {
  run: RunDetail;
  model: ModelOption | null;
  nowMs: number;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
}): ReactNode {
  const meta = statusMeta(run.status);
  const elapsed = elapsedBetween(run.startedAt, run.endedAt, nowMs);
  const terminal = isTerminalStatus(run.status);

  return (
    <header className="rounded border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={meta.tone} title={meta.meaning}>
              <Dot tone={meta.tone} pulse={meta.live} />
              {meta.label}
            </Badge>
            <HeldOutBadge heldOutPass={run.heldOutPass} />
            <FalseFinishBadge falseFinish={run.falseFinish} />
          </div>
          <h1
            className="mt-1.5 truncate text-[16px] font-semibold tracking-tight text-ink"
            title={run.ticketTitle}
          >
            {run.ticketTitle === "" ? run.runId : run.ticketTitle}
          </h1>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">
            {meta.meaning}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!terminal && (
            <Button variant="danger" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          {(run.status === "rate_limited" ||
            run.status === "awaiting_input" ||
            run.status === "failed") && (
            <Button variant="primary" onClick={onResume} disabled={busy}>
              Resume
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-3 py-2">
        <PhaseRail run={run} />
        <dl className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px]">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Model</dt>
            <dd className="text-ink-dim" title={run.modelId}>
              {model?.label ?? run.modelId}
              {model !== null && (
                <span className="ml-1.5 text-ink-faint">
                  {model.tier === "included" ? "· included" : "· metered"}
                </span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Started</dt>
            <dd className="numeric text-ink-dim">{formatClock(run.startedAt)}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">{run.endedAt === null ? "Elapsed" : "Took"}</dt>
            <dd className="numeric text-ink-dim">
              {elapsed === null ? "n/a" : formatDuration(elapsed)}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-faint">Run</dt>
            <dd>
              <code className="font-mono text-[11px] text-ink-faint">{run.runId}</code>
            </dd>
          </div>
        </dl>
      </div>
    </header>
  );
}
