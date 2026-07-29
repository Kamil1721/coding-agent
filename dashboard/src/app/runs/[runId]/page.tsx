"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";

import { CriteriaPanel } from "@/components/run/criteria";
import { RunHeader } from "@/components/run/header";
import {
  ApiDownNotice,
  AwaitingInputNotice,
  DeliveryNotice,
  OutcomeNotice,
  RateLimitNotice,
} from "@/components/run/notices";
import { ScreenshotsPanel } from "@/components/run/screenshots";
import { TracePane } from "@/components/run/trace";
import { UsagePanel } from "@/components/run/usage";
import { Notice, Panel, Skeleton } from "@/components/ui";
import { ApiError, cancelRun, errorMessage, resumeRun } from "@/lib/api";
import { findModel } from "@/lib/cost";
import { useModels } from "@/lib/hooks";
import { useLiveRun, useNow } from "@/lib/use-run-stream";

function useRunIdParam(): string | null {
  const params = useParams();
  const raw = params["runId"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

export default function RunPage(): ReactNode {
  const runId = useRunIdParam();
  const { run, error, isLoading, trace, stream, refresh, reconnect } = useLiveRun(runId);
  const { data: models } = useModels();
  const nowMs = useNow(1_000);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    (action: (id: string) => Promise<unknown>) => (): void => {
      if (runId === null || busy) return;
      setBusy(true);
      setActionError(null);
      void action(runId)
        .then(() => refresh())
        .catch((cause: unknown) => setActionError(errorMessage(cause)))
        .finally(() => setBusy(false));
    },
    [runId, busy, refresh],
  );

  const onCancel = act(cancelRun);
  const onResume = act(resumeRun);

  if (runId === null) {
    return (
      <Notice tone="fail" title="No run id in the URL">
        <Link href="/runs" className="text-accent underline underline-offset-2">
          Back to runs
        </Link>
      </Notice>
    );
  }

  if (run === undefined) {
    if (error instanceof ApiError && error.status === 0) {
      return <ApiDownNotice message={error.message} />;
    }
    if (error !== undefined) {
      return (
        <Notice tone="fail" title="Cannot load this run">
          <p>{errorMessage(error)}</p>
          <p className="mt-1.5">
            <Link href="/runs" className="text-accent underline underline-offset-2">
              Back to runs
            </Link>
          </p>
        </Notice>
      );
    }
    return (
      <Panel title="Run">
        {isLoading ? <Skeleton rows={6} /> : null}
      </Panel>
    );
  }

  const model = findModel(models, run.modelId);

  return (
    <div className="space-y-3">
      <RunHeader
        run={run}
        model={model}
        nowMs={nowMs}
        busy={busy}
        onCancel={onCancel}
        onResume={onResume}
      />

      {actionError !== null && (
        <Notice tone="fail" title="That action did not go through">
          <p>{actionError}</p>
        </Notice>
      )}

      {run.status === "rate_limited" && (
        <RateLimitNotice run={run} onResume={onResume} busy={busy} />
      )}
      {run.status === "awaiting_input" && (
        <AwaitingInputNotice onResume={onResume} onCancel={onCancel} busy={busy} />
      )}

      <OutcomeNotice run={run} />
      <DeliveryNotice run={run} />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-3">
          <TracePane trace={trace} stream={stream} onReconnect={reconnect} />
          <CriteriaPanel criteria={run.criteria} />
          <ScreenshotsPanel runId={run.runId} screenshots={run.screenshots} />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <UsagePanel run={run} model={model} />
          <Panel title="Ticket" bodyClassName="p-0">
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-ink-dim">
              {run.ticketText}
            </pre>
          </Panel>
        </div>
      </div>
    </div>
  );
}
