"use client";

/**
 * The run view. THE CANVAS IS THE PAGE.
 *
 * WHAT CHANGED AND WHY. This screen used to be a column of panels — trace,
 * criteria, screenshots, usage, ticket — which described a multi-agent run as a
 * list of things that had happened to it. The orchestration canvas shows the
 * same run as the shape it actually has: who delegated to whom, what each agent
 * loaded, and which of those branches is moving right now. The panels that
 * survive are the ones carrying facts the graph does not hold — the verdict's
 * criteria, the artefacts, the token spend, the raw trace — and each appears
 * exactly once. There is no second telling of the same story anywhere on this
 * page.
 *
 * WHAT WAS DELIBERATELY NOT BUILT, from the owner's reference image: the MCP
 * Connect/Disconnect controls, the SYSTEM ISSUES panel with Resolve buttons,
 * and the DATABASE INTEGRATION panel with its API KEY field. No endpoint backs
 * any of the three. A dashboard that looks like it can resolve a blockage and
 * cannot is worse than one that shows neither, and a secret typed into a web
 * form is a security decision nobody has made on this project.
 *
 * THE MOUNT ORDER MATTERS. `run === undefined` early-returns above the canvas,
 * which is the boundary spec §9.3 requires the canvas to live below: rendering
 * it above would remount React Flow the moment the run detail arrived and throw
 * away the viewport.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { CriteriaPanel } from "@/components/run/criteria";
import { DesignLockPanel } from "@/components/run/design-lock";
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
import { EnvironmentPanel } from "@/components/canvas/environment";
import { AgentInspector } from "@/components/canvas/inspector";
import { OrchestrationCanvas } from "@/components/canvas/orchestration-canvas";
import { AgentRoster } from "@/components/canvas/roster";
import { Notice, Panel, Skeleton } from "@/components/ui";
import { ApiError, cancelRun, errorMessage, resumeRun } from "@/lib/api";
import { findModel } from "@/lib/cost";
import { useModels } from "@/lib/hooks";
import { designLockPhase } from "@/lib/mockups";
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
  const { run, error, isLoading, trace, graph, graphReady, stream, refresh, reconnect } =
    useLiveRun(runId);
  const { data: models } = useModels();
  const nowMs = useNow(1_000);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAmbient, setShowAmbient] = useState(false);

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

  /*
   * NOT ROUTED THROUGH `act`, and not because of its signature.
   *
   * `act(resumeRun)` resumes with NO body, which hands the pick to `ui-designer`
   * and records it as automatic. A click that quietly did that would put the
   * owner's name on nobody's decision — or worse, `ui-designer`'s name on the
   * owner's. The choice travels or the request does not.
   */
  const onChooseMockup = useCallback(
    (chosenMockup: string): void => {
      if (runId === null || busy) return;
      setBusy(true);
      setActionError(null);
      void resumeRun(runId, chosenMockup)
        .then(() => refresh())
        .catch((cause: unknown) => setActionError(errorMessage(cause)))
        .finally(() => setBusy(false));
    },
    [runId, busy, refresh],
  );

  // Looked up rather than stored: hiding the housekeeping agents, or a run that
  // ends and re-folds, must not leave the inspector holding a node the canvas
  // no longer draws.
  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const visibleAgents = useMemo(
    () => (showAmbient ? graph.nodes : graph.nodes.filter((node) => !node.ambient)),
    [graph.nodes, showAmbient],
  );

  const clearSelection = useCallback((): void => {
    setSelectedId(null);
  }, []);

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
      <Panel title="Run">{isLoading ? <Skeleton rows={6} /> : null}</Panel>
    );
  }

  const model = findModel(models, run.modelId);

  /*
   * WHICH KIND OF `awaiting_input` THIS IS, WHICH IS THE ONLY REASON THE NOTICE
   * BELOW IS CONDITIONAL.
   *
   * `awaiting_input` is also what `reconcileOnBoot` sets for any run whose
   * builder subprocess died with the dashboard, and that run has no mockups and
   * no question these cards can answer — its two moves really are resume and
   * cancel, which is what `AwaitingInputNotice` says. Only a DESIGN park may
   * replace it: there, the notice's "this dashboard has no channel to answer a
   * mid-run question" is false, and the cards are the channel.
   */
  const lockPhase =
    run.designLock === null ? null : designLockPhase(run.status, run.designLock);
  const lockIsBlocking = lockPhase === "pending" || lockPhase === "closing";

  const designLockPanel =
    lockPhase === null ? null : (
      <DesignLockPanel
        run={run}
        busy={busy}
        onChoose={onChooseMockup}
        onRefresh={refresh}
      />
    );

  return (
    <div className="flex flex-col gap-3">
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
      {run.status === "awaiting_input" && lockPhase !== "pending" && (
        <AwaitingInputNotice onResume={onResume} onCancel={onCancel} busy={busy} />
      )}

      {/*
       * ABOVE THE CANVAS WHILE IT BLOCKS, BESIDE THE ARTEFACTS ONCE IT DOES NOT.
       * A decision the run is stopped on belongs where the eye lands first; the
       * same panel, after the choice is recorded, is one more thing the run
       * produced and sits with the rest of the record.
       */}
      {lockIsBlocking && designLockPanel}

      <OutcomeNotice run={run} />
      <DeliveryNotice run={run} />

      {/*
       * The orchestration row, at three widths.
       *
       *   < lg   one column. The canvas leads (`order-1`), then the ticket and
       *          roster, then the inspector.
       *   lg     two columns, [1fr, 324px]. The canvas keeps `order-1` and so
       *          takes the WIDE track; the ticket/roster rail sits beside it and
       *          the inspector wraps underneath.
       *   xl     three columns, [264px, 1fr, 324px], every `order` reset so the
       *          rails flank the canvas in source order.
       *
       * THE `lg:order-*` OVERRIDES THIS BLOCK USED TO CARRY WERE A BUG. They
       * swapped the rail ahead of the canvas at `lg`, which handed the canvas
       * the 324px track — a 324px-wide, 520px-tall graph pane. Every screenshot
       * was taken at 1440px, which is `xl`, so nothing that was measured could
       * see it. Grid order decides which track a child lands in; there is no
       * separate placement to check.
       */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_324px] xl:grid-cols-[264px_minmax(0,1fr)_324px]">
        {/*
         * The rail is a flex column with `min-h-0`, so the roster's scroll area
         * ENDS EXACTLY WHERE THE CANVAS DOES instead of at an arbitrary
         * max-height. A fixed cap cuts the last visible agent through the middle
         * of its row, which reads as a rendering fault rather than as a list
         * that continues.
         */}
        <div className="order-2 flex min-h-0 min-w-0 flex-col gap-3 xl:order-none">
          <Panel title="Ticket" bodyClassName="p-0" className="shrink-0">
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-ink-dim">
              {run.ticketText}
            </pre>
          </Panel>

          <Panel
            title={`Agents · ${String(visibleAgents.length)}`}
            subtitle="The canvas as a list. This is the keyboard-reachable equivalent; the graph itself offers partial affordances only."
            className="flex min-h-[240px] flex-col overflow-hidden xl:min-h-0 xl:flex-1"
            bodyClassName="min-h-0 flex-1 overflow-y-auto p-0"
          >
            <AgentRoster
              graph={graph}
              selectedId={selectedId}
              onSelect={setSelectedId}
              showAmbient={showAmbient}
            />
          </Panel>
        </div>

        {/*
         * ONE MOUNT, NO CONDITION AROUND IT, NO CHANGING KEY. Loading and empty
         * are overlays inside the canvas component; wrapping this element in a
         * ternary is what resets pan and zoom the moment the first agent lands.
         */}
        <section className="order-1 min-w-0 overflow-hidden rounded border border-line bg-canvas xl:order-none">
          <div className="h-[clamp(520px,66vh,820px)] w-full">
            <OrchestrationCanvas
              graph={graph}
              ready={graphReady}
              selectedId={selectedId}
              onSelect={setSelectedId}
              showAmbient={showAmbient}
              onShowAmbient={setShowAmbient}
            />
          </div>
        </section>

        <div className="order-3 flex min-w-0 flex-col gap-3">
          <Panel
            title={selected === null ? "Inspector" : "Agent"}
            subtitle={
              selected === null ? undefined : "Everything the run recorded about this agent."
            }
          >
            <AgentInspector node={selected} onClose={clearSelection} />
          </Panel>

          <Panel
            title="Environment"
            subtitle="Reported once, by the CLI, at the start of the run."
          >
            <EnvironmentPanel inventory={graph.inventory} />
          </Panel>

          <UsagePanel run={run} model={model} />
        </div>
      </div>

      {/*
       * Under the canvas: the record. The trace is the raw stream the canvas is
       * folded from, the criteria are the verdict, the screenshots are what the
       * run produced. None of the three is derivable from the graph.
       */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
        <TracePane trace={trace} stream={stream} onReconnect={reconnect} />
        <CriteriaPanel criteria={run.criteria} />
      </div>

      {!lockIsBlocking && designLockPanel}

      <ScreenshotsPanel runId={run.runId} screenshots={run.screenshots} />
    </div>
  );
}
