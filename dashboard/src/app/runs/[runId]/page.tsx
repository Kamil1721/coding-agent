"use client";

/**
 * The run view. THE CANVAS IS NOW LITERALLY THE PAGE.
 *
 * WHAT CHANGED AND WHY. This screen has been through three shapes and this is
 * the third. It began as a column of panels — trace, criteria, screenshots,
 * usage, ticket — which described a multi-agent run as a list of things that had
 * happened to it. It then became a three-column orchestration row: a TICKET card
 * and AGENTS list down the left, the canvas in the middle track, an INSPECTOR,
 * ENVIRONMENT and USAGE stack down the right, and the record underneath. The
 * owner's verdict on that shape was specific and correct:
 *
 *   "there is too much info that i dont need around the sides. The main screen is
 *   the canvas screen and the info i require only comes up when i press on the
 *   node… runs is permanently under fullscreen canvas with it been zoomed in on
 *   the whole flow by default."
 *
 * So: one canvas, the size of the viewport, fitted to the whole graph on load.
 * Every panel that used to flank it is behind one of two sheets — `DetailSheet`
 * for an agent, `RunSheet` for the run — and neither is open until asked for. See
 * `canvas/sheet.tsx` for what went where, and for why the agent index survived
 * the cut.
 *
 * FOUR THINGS ARE STILL UNCONDITIONALLY ON SCREEN, and each earns it:
 *
 *   - the canvas;
 *   - the run chip (`RunHud`): status, title, phase, clock, Cancel, Resume. A
 *     control that stops a run going wrong does not belong behind a click;
 *   - the role legend, because colour that has to be looked up is not working;
 *   - a notice, WHEN the run is in a state that needs one.
 *
 * WHERE `CodeBrowser` WENT, because it was mounted here by another task while
 * this one was in flight and its call site has moved rather than vanished. It is
 * now the `RunSheet`'s "Code" tab, with the same one-prop contract — `runId`, and
 * nothing else. The reasoning it arrived with ("a tree plus a file needs two
 * columns of its own, so it gets the full width") is answered rather than
 * overruled: in the sheet it gets 560px and its own full-height scroll container,
 * which is more usable width than the 324px rail it was avoiding, and it is no
 * longer competing with the graph for the first screen. It is reachable in two
 * keystrokes from anywhere on the canvas.
 *
 * WHY THE NOTICES AND THE DESIGN LOCK ARE DOCKED RATHER THAN TABBED. Both are
 * about a run that is STOPPED and waiting on the reader. `awaiting_input`,
 * `rate_limited` and a pending design lock are not detail, they are the only
 * thing on the screen that matters at that moment, and a decision hidden behind a
 * tab is a decision nobody makes. The design lock stays docked in its settled
 * phases too: a lock that has already resolved is the record of a choice the
 * owner made, and `design-lock.browser.spec.ts` asserts the panel is visible
 * without a click in all four of the shapes `RunDetail.designLock` arrives in.
 *
 * FULL BLEED WITHOUT TOUCHING `AppShell`. The shell is not this task's file, so
 * the wrapper below cancels `main`'s horizontal padding and its top padding with
 * negative margins and takes `100dvh` minus `--run-chrome` — the three boxes it
 * cannot remove (the 44px sticky header, `main`'s bottom padding, the footer).
 * That number is defended rather than trusted: `run-canvas.browser.spec.ts` fails
 * if this page ever acquires a vertical scrollbar, which is what a wrong
 * subtraction produces.
 *
 * THE MOUNT ORDER STILL MATTERS. `run === undefined` early-returns above the
 * canvas, which is the boundary spec §9.3 requires the canvas to live below:
 * rendering it above would remount React Flow the moment the run detail arrived
 * and throw away the viewport.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { DesignLockPanel } from "@/components/run/design-lock";
import {
  ApiDownNotice,
  AwaitingInputNotice,
  RateLimitNotice,
} from "@/components/run/notices";
import { OrchestrationCanvas } from "@/components/canvas/orchestration-canvas";
import { RunHud } from "@/components/canvas/run-hud";
import { DetailSheet, RunSheet } from "@/components/canvas/sheet";
import { Notice, Panel, Skeleton, cx } from "@/components/ui";
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
  const [runSheetOpen, setRunSheetOpen] = useState(false);

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
  // ends and re-folds, must not leave the sheet holding a node the canvas no
  // longer draws.
  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const clearSelection = useCallback((): void => {
    setSelectedId(null);
  }, []);

  const openRunSheet = useCallback((): void => {
    setRunSheetOpen(true);
  }, []);

  const closeRunSheet = useCallback((): void => {
    setRunSheetOpen(false);
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
    return <Panel title="Run">{isLoading ? <Skeleton rows={6} /> : null}</Panel>;
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

  return (
    <div
      className={cx(
        // Cancel `main`'s px-4 and pt-4; take the viewport minus the chrome that
        // is not this file's to remove.
        "relative -mx-4 -mt-4 overflow-hidden border-y border-line bg-canvas",
        "h-[calc(100dvh-var(--run-chrome))] min-h-[460px]",
      )}
    >
      <OrchestrationCanvas
        graph={graph}
        ready={graphReady}
        selectedId={selectedId}
        onSelect={setSelectedId}
        showAmbient={showAmbient}
        onShowAmbient={setShowAmbient}
        /*
         * `DetailSheet`'s own width — `w-[min(420px,100%)]` — and only while it is
         * open. The canvas clamps this against its measured pane, because on a
         * viewport narrower than 420px the sheet IS the pane and there is nowhere
         * to pan a card to.
         */
        rightInset={selected === null ? 0 : 420}
        hud={
          /*
           * THE DOCK IS CAPPED IN BOTH AXES, and both caps were added after
           * looking at it.
           *
           * Width is the same 360px the canvas's fit reserves on the left, so the
           * two cannot disagree about how much room this takes. Height is 62% of
           * the canvas with its own scroll: a run parked on a design choice has a
           * panel taller than the pane, and unconstrained it covered the graph
           * completely — which is the complaint this redesign exists to answer,
           * reintroduced by the fix for it.
           *
           * Below 900px there is no room to flank anything, so the fit reserves
           * the TOP instead and this dock overlaps the graph. That is the honest
           * outcome of a 375px canvas rather than a defect: the reader pans, and
           * every card is still reachable from the keyboard without touching the
           * pane at all.
           *
           * A `{/* … *\/}` COMMENT CANNOT GO HERE. `hud={…}` is an expression
           * position, not a JSX children position, so a JSX comment there parses
           * as an object literal followed by an element with no operator between
           * them: "Expected '</', got 'ident'". It cost a whole screenshot pass.
           */
          <div className="pointer-events-auto flex max-h-[40%] w-[min(360px,calc(100vw-32px))] flex-col gap-2 overflow-y-auto min-[900px]:max-h-[62%]">
            <RunHud
              run={run}
              model={model}
              nowMs={nowMs}
              busy={busy}
              onCancel={onCancel}
              onResume={onResume}
              onOpenDetail={openRunSheet}
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

            {lockPhase !== null && (
              <div
                className={cx(
                  "overflow-y-auto rounded",
                  /*
                   * CONSTRAINED, AND MEASURED BEFORE IT WAS.
                   *
                   * `DesignLockPanel` renders five mockup cards at full size. Docked
                   * unconstrained it came out 880px wide and taller than the pane,
                   * covering the entire graph on the one run this redesign was built
                   * against — the exact complaint the redesign exists to answer,
                   * reintroduced by the fix for it. It keeps its own internal scroll
                   * instead: every element the four `design-lock.browser.spec.ts`
                   * shapes assert on is still rendered and still visible (Playwright's
                   * visibility is a non-empty box, not in-viewport), and the reader
                   * gets a panel rather than a takeover.
                   *
                   * A decision the run is STOPPED on gets more room and a ring; the
                   * same panel as a record gets less. Same panel, two weights.
                   */
                  lockIsBlocking
                    ? "ring-2 ring-accent/50"
                    : "max-h-[132px] opacity-90 min-[900px]:max-h-[200px]",
                )}
              >
                <DesignLockPanel
                  run={run}
                  busy={busy}
                  onChoose={onChooseMockup}
                  onRefresh={refresh}
                />
              </div>
            )}
          </div>
        }
      />

      {selected !== null && <DetailSheet node={selected} onClose={clearSelection} />}

      {runSheetOpen && (
        <RunSheet
          run={run}
          model={model}
          graph={graph}
          trace={trace}
          stream={stream}
          onReconnect={reconnect}
          selectedId={selectedId}
          onSelect={setSelectedId}
          showAmbient={showAmbient}
          onClose={closeRunSheet}
        />
      )}
    </div>
  );
}
