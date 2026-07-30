"use client";

/**
 * run-hud.tsx — the one deliberate affordance the run's own facts live behind.
 *
 * THE BRIEF WAS "NOTHING AROUND THE SIDES", NOT "NOTHING". A run still has an
 * identity, a verdict and two actions that cannot wait behind a click — cancelling
 * a run that is going wrong is not a detail — so this is what stayed on screen:
 * one floating chip in the canvas's top-left corner carrying the status, the
 * ticket's title, the phase, the model and the clock, plus Cancel and Resume when
 * they are real, plus the button that opens everything else.
 *
 * IT IS ONE OF THE FOUR THINGS ON SCREEN, AND THAT IS THE POINT. Where the
 * previous layout had five permanent panels of run-level facts, this has the
 * canvas, this chip, a legend and — only when the run is in a state that needs
 * one — a notice. `RunHeader` still exists and is still correct; it is 148 lines
 * of two-row header for a page whose entire top edge is now 44px of chip, so it
 * is not used here.
 *
 * THE FACTS COME FROM THE SAME HELPERS `RunHeader` USES — `statusMeta`,
 * `elapsedBetween`, `formatDuration`, `phaseMeta` — so a status that changes
 * meaning changes in both places at once. Nothing here is a second computation of
 * anything.
 */

import type { ReactNode } from "react";

import type { ModelOption, RunDetail } from "@/lib/api-types";
import { isTerminalStatus } from "@/lib/api-types";
import { elapsedBetween, formatDuration } from "@/lib/format";
import { phaseMeta, statusMeta } from "@/lib/presentation";
import { FalseFinishBadge, HeldOutBadge } from "@/components/outcome";
import { Badge, Button, Dot } from "@/components/ui";

export function RunHud({
  run,
  model,
  nowMs,
  busy,
  onCancel,
  onResume,
  onOpenDetail,
}: {
  run: RunDetail;
  model: ModelOption | null;
  nowMs: number;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
  onOpenDetail: () => void;
}): ReactNode {
  const meta = statusMeta(run.status);
  const phase = phaseMeta(run.phase);
  const elapsed = elapsedBetween(run.startedAt, run.endedAt, nowMs);
  const terminal = isTerminalStatus(run.status);

  return (
    <div className="rounded border border-line bg-surface/95 px-2.5 py-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <Badge tone={meta.tone} title={meta.meaning}>
          <Dot tone={meta.tone} pulse={meta.live} />
          {meta.label}
        </Badge>
        <HeldOutBadge heldOutPass={run.heldOutPass} />
        <FalseFinishBadge falseFinish={run.falseFinish} />

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
          <Button
            onClick={onOpenDetail}
            title="Ticket, verdict, code, agents, environment, usage and the raw trace."
          >
            run detail
          </Button>
        </div>
      </div>

      <h1
        className="mt-1.5 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink"
        title={run.ticketTitle}
      >
        {run.ticketTitle === "" ? run.runId : run.ticketTitle}
      </h1>

      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
        <span title={phase.blurb}>{phase.label}</span>
        <span aria-hidden="true">·</span>
        <span title={run.modelId}>{model?.label ?? run.modelId}</span>
        <span aria-hidden="true">·</span>
        <span className="numeric" title={run.endedAt === null ? "Elapsed" : "Took"}>
          {elapsed === null ? "n/a" : formatDuration(elapsed)}
        </span>
        <span aria-hidden="true">·</span>
        <span className="font-mono">{run.runId}</span>
      </p>
    </div>
  );
}
