"use client";

/**
 * sheet.tsx — detail on demand, which is the whole shape of this screen now.
 *
 * WHAT THIS REPLACED. The run view used to put a TICKET card and an AGENTS list
 * down the left, the canvas in a squeezed middle track, and an INSPECTOR,
 * ENVIRONMENT and USAGE stack down the right. Five panels of run-level facts were
 * on screen at all times whether or not anyone was reading them, and the graph —
 * the thing the screen is for — got about a third of the width. The owner's
 * instruction was exact: "there is too much info that i dont need around the
 * sides… the info i require only comes up when i press on the node."
 *
 * SO THERE ARE EXACTLY TWO SHEETS, AND NEITHER IS OPEN BY DEFAULT.
 *
 *   `DetailSheet` — one agent, opened by clicking or Entering its card. Right
 *     docked, 420px, and it deliberately does NOT cover the graph: the card it
 *     describes stays visible with its ring on and its connectors energised, so
 *     the sheet reads as an annotation of the canvas rather than as a page you
 *     navigated to.
 *
 *   `RunSheet` — every run-level fact, behind ONE affordance: the run chip in the
 *     canvas's top-left corner. Six tabs, because six things are genuinely
 *     different questions and stacking them all in a column is the rail this
 *     screen just deleted.
 *
 * NEITHER IS A MODAL AND NEITHER TRAPS FOCUS. There is no scrim, no
 * `aria-modal`, and nothing that swallows Tab: the canvas behind stays live and
 * keyboard-reachable, which matters because the sheet's own agent index selects
 * cards on it. Escape closes, from anywhere inside.
 *
 * WHY THE AGENT INDEX SURVIVED. Spec §9.3 requires an accessible equivalent of
 * the canvas and the old left rail was it — its caption said the graph "offers
 * partial affordances only". The canvas is now properly navigable itself (roving
 * tabindex, arrow keys, Enter, Escape — see `orchestration-canvas.tsx`), so the
 * list is no longer the ONLY way in. It is still here, one tab deep, for two
 * reasons that are not accessibility theatre: it is the faster read when you
 * already know which agent you want, and it is the ungrouped truth — a folded
 * group hides nothing from it, so no agent can be reachable only by expanding
 * something.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { GraphNode, GraphState, ModelOption, RunDetail } from "@/lib/api-types";
import type { StreamState, TraceEntry } from "@/lib/use-run-stream";
import { Button, cx } from "@/components/ui";
import { CodeBrowser } from "@/components/run/code-browser";
import { CriteriaPanel } from "@/components/run/criteria";
import { DeliveryNotice, OutcomeNotice } from "@/components/run/notices";
import { ScreenshotsPanel } from "@/components/run/screenshots";
import { TracePane } from "@/components/run/trace";
import { UsagePanel } from "@/components/run/usage";
import { EnvironmentPanel } from "./environment";
import { AgentInspector } from "./inspector";
import { AgentRoster } from "./roster";
import { RoleChip } from "./agent-node";
import { roleOf } from "./roles";

/* ------------------------------------------------------------------ */
/* The shell                                                           */
/* ------------------------------------------------------------------ */

function Sheet({
  title,
  eyebrow,
  width,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  width: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const shell = useRef<HTMLDivElement | null>(null);

  /*
   * Escape closes, and the listener is on the sheet rather than on the window.
   *
   * A window listener would also close the sheet when the reader pressed Escape
   * with focus on a canvas card — which already means something else there
   * (clear the selection) and would fire both.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    },
    [onClose],
  );

  /*
   * Focus moves into the sheet on open, so Escape works without a click first
   * and a screen reader is told something appeared. `preventScroll` because the
   * sheet is inside a fixed-height canvas and scrolling it into view would move
   * the whole page by a pixel.
   */
  useEffect(() => {
    shell.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={shell}
      tabIndex={-1}
      role="region"
      aria-label={title}
      onKeyDown={onKeyDown}
      className={cx(
        "sheet-in absolute inset-y-0 right-0 z-20 flex flex-col border-l border-line bg-surface/97 backdrop-blur",
        "shadow-[-24px_0_48px_-32px_rgba(0,0,0,0.9)]",
        width,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
            {eyebrow}
          </p>
          <h2 className="truncate text-[13.5px] font-semibold text-ink">{title}</h2>
        </div>
        <Button variant="ghost" onClick={onClose} title="Close (Escape)">
          close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One agent                                                           */
/* ------------------------------------------------------------------ */

export function DetailSheet({
  node,
  onClose,
  chat,
}: {
  node: GraphNode;
  onClose: () => void;
  /**
   * The chat panel, or undefined for a node that has no session to steer.
   *
   * PASSED IN RATHER THAN BUILT HERE, because deciding WHICH node is steerable
   * needs the run's status and its message list, and this sheet has neither. It
   * renders what it is given, above everything else — the owner asked for the chat
   * at the top of the panel.
   */
  chat?: ReactNode;
}): ReactNode {
  const role = roleOf(node.agent, node.lane);
  return (
    <Sheet
      eyebrow="agent"
      title={node.agent ?? "session"}
      width="w-[min(420px,100%)]"
      onClose={onClose}
    >
      <div className="border-b border-line px-3 py-2">
        <RoleChip role={role} />
      </div>
      {chat}
      <div className="px-3 py-2.5">
        {/* `header={false}`: the sheet's own chrome already carries this agent's
            name and its close button. */}
        <AgentInspector node={node} onClose={onClose} header={false} />
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: "ticket", label: "Ticket" },
  { id: "verdict", label: "Verdict" },
  { id: "code", label: "Code" },
  { id: "agents", label: "Agents" },
  { id: "env", label: "Run" },
  { id: "trace", label: "Trace" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function TabBody({ children }: { children: ReactNode }): ReactNode {
  return <div className="space-y-3 p-3">{children}</div>;
}

export interface RunSheetProps {
  readonly run: RunDetail;
  readonly model: ModelOption | null;
  readonly graph: GraphState;
  readonly trace: readonly TraceEntry[];
  readonly stream: StreamState;
  readonly onReconnect: () => void;
  readonly selectedId: string | null;
  readonly onSelect: (nodeId: string | null) => void;
  readonly showAmbient: boolean;
  readonly onClose: () => void;
  /** Which tab to open on. The chip opens `ticket`; the artefact link opens `code`. */
  readonly initialTab?: TabId;
}

export function RunSheet({
  run,
  model,
  graph,
  trace,
  stream,
  onReconnect,
  selectedId,
  onSelect,
  showAmbient,
  onClose,
  initialTab = "ticket",
}: RunSheetProps): ReactNode {
  const [tab, setTab] = useState<TabId>(initialTab);

  return (
    <Sheet
      eyebrow="run"
      title={run.ticketTitle}
      width="w-[min(560px,100%)]"
      onClose={onClose}
    >
      <div
        role="tablist"
        aria-label="Run detail"
        className="sticky top-0 z-10 flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface/97 px-2 py-1.5 backdrop-blur"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`run-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`run-panel-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={cx(
              "shrink-0 rounded-sm px-2 py-1 text-[12px] transition-colors",
              tab === entry.id
                ? "bg-surface-raised text-ink"
                : "text-ink-dim hover:bg-surface-raised hover:text-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`run-panel-${tab}`}
        aria-labelledby={`run-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "ticket" && (
          <TabBody>
            <OutcomeNotice run={run} />
            <DeliveryNotice run={run} />
            <div className="rounded border border-line bg-canvas/40">
              <p className="border-b border-line px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
                the ticket, verbatim
              </p>
              <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-ink-dim">
                {run.ticketText}
              </pre>
            </div>
          </TabBody>
        )}

        {tab === "verdict" && (
          <TabBody>
            <CriteriaPanel criteria={run.criteria} />
            <ScreenshotsPanel runId={run.runId} screenshots={run.screenshots} />
          </TabBody>
        )}

        {/*
         * THE CODE SLOT.
         *
         * CONTRACT, so the component arriving here needs no coordination beyond
         * it: this tab renders exactly one child, it is handed the run id and
         * nothing else, and it owns its own fetching, loading, empty and error
         * states. It gets a full-height scroll container with no padding — the
         * tree and the file pane manage their own — and it must not assume a
         * width above 320px, because at a 375px viewport this sheet is the
         * viewport. Nothing in the canvas reads anything back out of it, and it
         * is not told which agent is selected: the workspace is a fact about the
         * RUN, and a file tree that changed under you as you clicked cards on the
         * graph would be a worse tool, not a better one. If a per-agent view is
         * ever wanted it should arrive as its own prop rather than by reusing the
         * selection.
         */}
        {tab === "code" && (
          <div className="h-full min-h-[420px]">
            <CodeBrowser runId={run.runId} />
          </div>
        )}

        {tab === "agents" && (
          <div>
            <p className="border-b border-line px-3 py-2 text-[11.5px] leading-relaxed text-ink-faint">
              Every agent this run started, in arrival order and never folded —
              picking one here selects its card on the canvas. The canvas itself is
              navigable with the arrow keys; this is the faster read when you
              already know the name.
            </p>
            <AgentRoster
              graph={graph}
              selectedId={selectedId}
              onSelect={onSelect}
              showAmbient={showAmbient}
            />
          </div>
        )}

        {tab === "env" && (
          <TabBody>
            <div className="rounded border border-line bg-canvas/40">
              <p className="border-b border-line px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
                environment · reported once, by the CLI, at the start of the run
              </p>
              <div className="px-3 py-2.5">
                <EnvironmentPanel inventory={graph.inventory} />
              </div>
            </div>
            <UsagePanel run={run} model={model} />
          </TabBody>
        )}

        {tab === "trace" && (
          <div className="p-3">
            <TracePane trace={trace} stream={stream} onReconnect={onReconnect} />
          </div>
        )}
      </div>
    </Sheet>
  );
}
