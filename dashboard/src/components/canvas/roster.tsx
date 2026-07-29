"use client";

/**
 * roster.tsx — the canvas as a list, and the reason the canvas is allowed to be
 * a picture.
 *
 * SPEC §9.3 SAYS: "do not claim the canvas provides accessibility. React Flow
 * gives partial affordances only. Keep an accessible equivalent representation
 * and say so in the UI." The Phase 3 report then recorded that `TracePane` had
 * quietly stopped being that equivalent — `traceRowFor` returns `null` for all
 * seven `graph_*` types, so not one graph event produces a trace row. The claim
 * was live and unbacked.
 *
 * THIS IS THE BACKING. A real `<ul>` of real `<button>`s, in the same first-
 * sighting order the canvas lays out, carrying the same facts: who the agent
 * is, what state it is in, who delegated to it, whether that link was inferred,
 * and how much it did. It is keyboard reachable and it is not visually hidden —
 * it is the left rail, because a list of eleven agents with their states is
 * genuinely the faster read when you already know what you are looking for.
 *
 * NOT A SECOND PRESENTATION OF THE RUN. It is the same selection state as the
 * canvas: clicking a row highlights the card, clicking a card highlights the
 * row. One model, two fidelities.
 */

import { useMemo, type ReactNode } from "react";

import type { GraphNode, GraphState } from "@/lib/api-types";
import { EmptyState, cx } from "@/components/ui";
import { stateLook } from "./agent-node";

const ROW_TONE = {
  pass: "text-pass",
  fail: "text-fail",
  warn: "text-warn",
  info: "text-info",
  accent: "text-accent",
  neutral: "text-ink-faint",
} as const;

function parentLabel(node: GraphNode, byId: ReadonlyMap<string, GraphNode>): string {
  if (node.parent === null) return "the run's own session";
  const parent = byId.get(node.parent);
  return parent?.agent ?? parent?.id ?? node.parent;
}

export function AgentRoster({
  graph,
  selectedId,
  onSelect,
  showAmbient,
}: {
  graph: GraphState;
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
  showAmbient: boolean;
}): ReactNode {
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );

  const rows = useMemo(
    () => (showAmbient ? graph.nodes : graph.nodes.filter((node) => !node.ambient)),
    [graph.nodes, showAmbient],
  );

  if (rows.length === 0) {
    return (
      <EmptyState>
        No agents recorded. Delegation appears here as soon as the run starts one.
      </EmptyState>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {rows.map((node) => {
        const look = stateLook(node.state);
        const selected = node.id === selectedId;
        return (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => onSelect(selected ? null : node.id)}
              aria-pressed={selected}
              className={cx(
                "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
                "hover:bg-surface-raised active:translate-y-[1px]",
                selected && "bg-accent-dim/25",
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "mt-[5px] inline-block size-[6px] shrink-0 rounded-full",
                  look.tone === "accent" && "bg-accent animate-pulse",
                  look.tone === "pass" && "bg-pass",
                  look.tone === "fail" && "bg-fail",
                  look.tone === "warn" && "bg-warn",
                  look.tone === "neutral" && "bg-ink-faint",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12.5px] font-medium text-ink">
                    {node.agent ?? "session"}
                  </span>
                  <span className={cx("shrink-0 text-[10.5px]", ROW_TONE[look.tone])}>
                    {look.label}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                  {node.lane ?? "no lane"} · delegated by {parentLabel(node, byId)}
                  {node.attribution === "inferred" && " (inferred)"}
                </span>
                {(node.toolCalls > 0 || node.skills.length > 0 || node.hooks.length > 0) && (
                  <span className="mt-1 block text-[10.5px] text-ink-faint numeric">
                    {node.toolCalls} calls · {node.skills.length} skills ·{" "}
                    {node.hooks.length} hooks
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
