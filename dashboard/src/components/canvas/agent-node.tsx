"use client";

/**
 * agent-node.tsx — one agent, as a card.
 *
 * WHAT IT SHOWS IS EXACTLY WHAT THE SERVER SENDS. Skills come from
 * `graph_skill`, tool and MCP chips from `graph_tool` (an MCP call IS a tool
 * call whose name matches `mcp__<server>__<tool>`; the server splits the server
 * name out into `mcpServer`), hooks from `graph_hook`, the counters from
 * `graph_result`. Nothing on this card is computed from something adjacent to
 * the data, and nothing is shown that no event carries — which is why there is
 * no per-agent elapsed clock: the parsed event union drops the row's timestamp,
 * so a timer here would be a number this program invented.
 *
 * NO ICONS, DELIBERATELY. The reference image gives every node a coloured glyph
 * tile. This app ships no icon library, and the anti-slop rules ban hand-drawn
 * SVG glyphs outright — so the tile is replaced by the node's lane and its
 * server-assigned id in mono. That is strictly more information than a picture
 * of a gear, and it costs no dependency.
 */

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useMemo, type ReactNode } from "react";

import type { GraphNode, GraphNodeState } from "@/lib/api-types";
import type { Tone } from "@/lib/presentation";
import { formatTokens } from "@/lib/format";
import { cx } from "@/components/ui";
import { NODE_WIDTH, PILL_CAP } from "./layout";

/**
 * A type alias, not an interface: React Flow's `Node<T>` constrains `T` to
 * `Record<string, unknown>`, and only type aliases get the implicit index
 * signature that satisfies it.
 */
export type AgentNodeData = {
  readonly graphNode: GraphNode;
  /**
   * Selection is owned by the canvas, not by React Flow.
   *
   * `elementsSelectable` stays off — the spec's measured configuration — so
   * `NodeProps.selected` never becomes true. One value read by the card ring,
   * the inspector and the roster row beats three that can disagree.
   */
  readonly isSelected: boolean;
};

export type AgentFlowNode = Node<AgentNodeData, "agent">;

export interface StateLook {
  readonly label: string;
  readonly tone: Tone;
  /** What the state MEANS, in the tooltip. Never marketing, never a guess. */
  readonly meaning: string;
  readonly live: boolean;
  readonly card: string;
}

/**
 * State -> appearance, in ONE table.
 *
 * `unresolved` is the row worth reading. It means the run ended while this
 * agent still read `running` and the stream never said how it finished. It is
 * NOT failed — a cancelled run's in-flight agents did not fail — so it gets the
 * neutral palette and a dashed edge to the card, which reads as "we stopped
 * watching" rather than as an error.
 */
export function stateLook(state: GraphNodeState): StateLook {
  switch (state) {
    case "running":
      return {
        label: "running",
        tone: "accent",
        meaning: "This agent is working now.",
        live: true,
        card: "border-accent/55 shadow-[0_0_0_1px_rgba(110,168,254,0.10),0_14px_38px_-18px_rgba(110,168,254,0.75)]",
      };
    case "completed":
      return {
        label: "completed",
        tone: "pass",
        meaning: "The agent returned a result.",
        live: false,
        card: "border-pass/30",
      };
    case "failed":
      return {
        label: "failed",
        tone: "fail",
        meaning: "The agent reported a failure.",
        live: false,
        card: "border-fail/45 shadow-[0_12px_34px_-20px_rgba(248,113,113,0.6)]",
      };
    case "stopped":
      return {
        label: "stopped",
        tone: "warn",
        meaning: "The agent was stopped before it returned.",
        live: false,
        card: "border-warn/40",
      };
    case "unresolved":
      return {
        label: "unresolved",
        tone: "neutral",
        meaning:
          "The run ended while this agent still read running, and the stream never said how it finished. Not a failure — nobody was watching by then.",
        live: false,
        card: "border-dashed border-line-strong",
      };
    default:
      return {
        label: String(state),
        tone: "neutral",
        meaning: "A state this dashboard does not recognise, shown verbatim.",
        live: false,
        card: "border-line-strong",
      };
  }
}

const PILL_TONE: Readonly<Record<Tone, string>> = {
  pass: "border-pass/30 bg-pass-dim/70 text-pass",
  fail: "border-fail/40 bg-fail-dim/70 text-fail",
  warn: "border-warn/35 bg-warn-dim/60 text-warn",
  info: "border-info/30 bg-info-dim/60 text-info",
  accent: "border-accent/35 bg-accent-dim/45 text-accent",
  neutral: "border-line-strong bg-canvas/70 text-ink-dim",
};

export function Pill({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full border px-2 py-[2px] text-[10.5px] leading-[15px] whitespace-nowrap",
        PILL_TONE[tone],
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** `mcp__github__create_issue` reads as `create_issue` once the server is a chip of its own. */
export function shortToolName(name: string, mcpServer: string | null): string {
  if (mcpServer === null) return name;
  const prefix = `mcp__${mcpServer}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function Count({ value }: { value: number }): ReactNode {
  if (value <= 1) return null;
  return <span className="text-ink-faint numeric">×{value}</span>;
}

/**
 * A group of pills with a `+N` chip once it passes the display cap.
 *
 * The overflow chip is not decoration: the reducer keeps up to 64 distinct
 * names per node and the card shows a handful, so without it a node that used
 * thirty tools would look like a node that used six.
 */
function PillGroup({
  label,
  hidden,
  children,
}: {
  label: string;
  hidden: number;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap gap-1" aria-label={label}>
      {children}
      {hidden > 0 && (
        <Pill title={`${String(hidden)} more not shown`}>+{hidden}</Pill>
      )}
    </div>
  );
}

export function AgentCard({ node }: { node: GraphNode }): ReactNode {
  const look = stateLook(node.state);

  const skills = node.skills.slice(0, PILL_CAP.skills);
  const tools = node.tools.slice(0, PILL_CAP.tools);
  const hooks = node.hooks.slice(0, PILL_CAP.hooks);

  const denied = useMemo(
    () => node.hooks.some((hook) => hook.decision === "deny"),
    [node.hooks],
  );

  return (
    <article
      style={{ width: NODE_WIDTH }}
      className={cx(
        "relative rounded-[10px] border bg-surface px-4 py-4 text-left transition-colors",
        // A single low radial highlight instead of a flat fill or a 45-degree
        // gradient — the card reads as lit from above without becoming glassy.
        "bg-[radial-gradient(120%_80%_at_18%_0%,rgba(110,168,254,0.05),transparent_60%)]",
        look.card,
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            {node.lane ?? "session"}
          </span>
          <span className="font-mono text-[9.5px] text-ink-faint/60">{node.id}</span>
        </span>
        <span
          title={look.meaning}
          className={cx(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[1px] text-[10px] font-medium",
            PILL_TONE[look.tone],
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "inline-block size-[5px] rounded-full",
              look.tone === "accent" && "bg-accent animate-pulse",
              look.tone === "pass" && "bg-pass",
              look.tone === "fail" && "bg-fail",
              look.tone === "warn" && "bg-warn",
              look.tone === "neutral" && "bg-ink-faint",
            )}
          />
          {look.label}
        </span>
      </header>

      <h3 className="mt-2 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink">
        {node.agent ?? "session"}
      </h3>

      <p className="mt-1 line-clamp-2 h-[32px] text-[11.5px] leading-[16px] text-ink-dim">
        {node.description === "" ? "No task description was reported." : node.description}
      </p>

      {node.attribution === "inferred" && (
        <p className="mt-1.5">
          <Pill
            title="This agent was attributed by the server, not stated by the CLI. Hook messages carry no task identity."
          >
            <span className="underline decoration-dotted underline-offset-2">inferred</span>
          </Pill>
        </p>
      )}

      {(skills.length > 0 || tools.length > 0 || hooks.length > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3">
          {skills.length > 0 && (
            <PillGroup label="Skills" hidden={node.skills.length - skills.length}>
              {skills.map((skill) => (
                <Pill
                  key={`${skill.skill}:${skill.source}`}
                  tone="info"
                  title={`Skill ${skill.skill}, ${skill.source}`}
                >
                  {skill.skill}
                  <Count value={skill.count} />
                </Pill>
              ))}
            </PillGroup>
          )}

          {tools.length > 0 && (
            <PillGroup label="Tools" hidden={node.tools.length - tools.length}>
              {tools.map((tool) => (
                <Pill
                  key={tool.name}
                  tone={tool.mcpServer === null ? "neutral" : "accent"}
                  title={
                    tool.mcpServer === null
                      ? `${tool.name}, called ${String(tool.count)}×`
                      : `MCP server ${tool.mcpServer}: ${tool.name}, called ${String(tool.count)}×`
                  }
                >
                  {tool.mcpServer !== null && (
                    <span className="text-accent/70">{tool.mcpServer}/</span>
                  )}
                  {shortToolName(tool.name, tool.mcpServer)}
                  <Count value={tool.count} />
                </Pill>
              ))}
            </PillGroup>
          )}

          {hooks.length > 0 && (
            <PillGroup label="Hooks" hidden={node.hooks.length - hooks.length}>
              {hooks.map((hook) => (
                <Pill
                  key={`${hook.event}:${hook.tool}:${hook.decision}`}
                  tone={hook.decision === "deny" ? "fail" : "neutral"}
                  title={`${hook.event} on ${hook.tool === "" ? "any tool" : hook.tool} → ${hook.decision}`}
                >
                  {hook.event}
                  {hook.tool !== "" && (
                    <span className="text-ink-faint">·{hook.tool}</span>
                  )}
                  <Count value={hook.count} />
                </Pill>
              ))}
            </PillGroup>
          )}
        </div>
      )}

      {(node.toolCalls > 0 || node.result !== null) && (
        <footer className="mt-3 flex items-center gap-2 border-t border-line pt-2 text-[10.5px] text-ink-faint">
          <span className="numeric">
            {node.toolCalls} {node.toolCalls === 1 ? "call" : "calls"}
          </span>
          {node.result?.totalTokens != null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="numeric">{formatTokens(node.result.totalTokens)} tok</span>
            </>
          )}
          {denied && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-fail">hook denied a call</span>
            </>
          )}
        </footer>
      )}
    </article>
  );
}

/**
 * The React Flow wrapper.
 *
 * Handles are rendered but never connectable — `nodesConnectable={false}` on
 * the flow. They exist so the edge has a real anchor point on the card's edge,
 * which is what lets the connector read as a tube plugging into it rather than
 * a line ending near it.
 */
export function AgentNode({ data }: NodeProps<AgentFlowNode>): ReactNode {
  const node = data.graphNode;
  const look = stateLook(node.state);
  return (
    <div
      className={cx(
        "cursor-pointer rounded-[10px] transition-transform active:scale-[0.985]",
        data.isSelected && "ring-2 ring-accent/70 ring-offset-2 ring-offset-canvas",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={cx(
          "!size-[7px] !border-0",
          look.live ? "!bg-accent" : "!bg-line-strong",
        )}
      />
      <AgentCard node={node} />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={cx(
          "!size-[7px] !border-0",
          look.live ? "!bg-accent" : "!bg-line-strong",
        )}
      />
    </div>
  );
}

/** The column header. A node so it pans and zooms with the graph it labels. */
export type LaneNodeData = {
  readonly label: string;
  readonly count: number;
};

export type LaneFlowNode = Node<LaneNodeData, "lane">;

export function LaneNode({ data }: NodeProps<LaneFlowNode>): ReactNode {
  return (
    <div style={{ width: NODE_WIDTH }} className="select-none">
      <div className="flex items-baseline gap-2 border-b border-line pb-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-dim">
          {data.label}
        </span>
        <span className="numeric text-[10.5px] text-ink-faint">{data.count}</span>
      </div>
    </div>
  );
}
