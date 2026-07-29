"use client";

/**
 * inspector.tsx — one agent, in full.
 *
 * The card on the canvas caps what it shows so a graph of twelve agents stays
 * readable; this is where the rest lives. Every list here is uncapped up to the
 * reducer's own 64-distinct-names ceiling, and where that ceiling bit, the card
 * and this panel both say so through the call COUNT, which the reducer keeps
 * exact even for names that did not fit.
 *
 * `sdk.taskId` IS SHOWN AND IS NOT IDENTITY. The server's redactor rewrites any
 * long high-entropy token to one identical literal, so two different agents can
 * arrive carrying the same string — which is exactly why node identity is the
 * short server-assigned id and why this value appears only here, labelled, for
 * cross-referencing a transcript by eye.
 */

import type { ReactNode } from "react";

import type { GraphNode } from "@/lib/api-types";
import { formatDuration, formatTokens } from "@/lib/format";
import { Button, EmptyState, cx } from "@/components/ui";
import { Pill, shortToolName, stateLook } from "./agent-node";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="border-t border-line px-3 py-2.5">
      <h4 className="flex items-baseline gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        {title}
        {count !== undefined && <span className="numeric text-ink-faint/70">{count}</span>}
      </h4>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

export function AgentInspector({
  node,
  onClose,
}: {
  node: GraphNode | null;
  onClose: () => void;
}): ReactNode {
  if (node === null) {
    return (
      <EmptyState>
        Select an agent on the canvas, or in the list beside it, to see its skills,
        tools, hooks and result.
      </EmptyState>
    );
  }

  const look = stateLook(node.state);

  return (
    <div className="-mx-3 -my-2.5">
      <header className="flex items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-ink">
            {node.agent ?? "session"}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
            <span className="font-mono">{node.id}</span>
            <span aria-hidden="true">·</span>
            <span>{node.lane ?? "no lane"}</span>
            {node.ambient && (
              <>
                <span aria-hidden="true">·</span>
                <span title="The CLI marked this skip_transcript.">housekeeping</span>
              </>
            )}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} title="Clear the selection">
          close
        </Button>
      </header>

      <div className="px-3 pb-2.5">
        <p
          title={look.meaning}
          className={cx(
            "text-[12px]",
            look.tone === "accent" && "text-accent",
            look.tone === "pass" && "text-pass",
            look.tone === "fail" && "text-fail",
            look.tone === "warn" && "text-warn",
            look.tone === "neutral" && "text-ink-dim",
          )}
        >
          {look.label} — {look.meaning}
        </p>
        {node.attribution === "inferred" && (
          <p className="mt-1.5 rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-dim">
            This agent was attributed by the server rather than stated by the CLI.
            Hook messages carry no task identity, so the link to its parent is a
            considered guess, not a fact.
          </p>
        )}
      </div>

      <Section title="Task">
        <p className="text-[12px] leading-relaxed text-ink-dim">
          {node.description === "" ? "No task description was reported." : node.description}
        </p>
      </Section>

      {node.skills.length > 0 && (
        <Section title="Skills" count={node.skills.length}>
          <div className="flex flex-wrap gap-1">
            {node.skills.map((skill) => (
              <Pill
                key={`${skill.skill}:${skill.source}`}
                tone="info"
                title={`${skill.source} · used ${String(skill.count)}×`}
              >
                {skill.skill}
                {skill.count > 1 && (
                  <span className="text-ink-faint numeric">×{skill.count}</span>
                )}
              </Pill>
            ))}
          </div>
        </Section>
      )}

      {node.tools.length > 0 && (
        <Section title="Tools" count={node.tools.length}>
          <ul className="space-y-1">
            {node.tools.map((tool) => (
              <li
                key={tool.name}
                className="flex items-baseline justify-between gap-2 text-[11.5px]"
              >
                <span className="min-w-0 truncate">
                  {tool.mcpServer !== null && (
                    <span className="text-accent">{tool.mcpServer}/</span>
                  )}
                  <span className="text-ink-dim">
                    {shortToolName(tool.name, tool.mcpServer)}
                  </span>
                </span>
                <span className="shrink-0 text-ink-faint numeric">{tool.count}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {node.hooks.length > 0 && (
        <Section title="Hooks" count={node.hooks.length}>
          <ul className="space-y-1">
            {node.hooks.map((hook) => (
              <li
                key={`${hook.event}:${hook.tool}:${hook.decision}`}
                className="flex items-baseline justify-between gap-2 text-[11.5px]"
              >
                <span className="min-w-0 truncate text-ink-dim">
                  {hook.event}
                  {hook.tool !== "" && (
                    <span className="text-ink-faint"> · {hook.tool}</span>
                  )}
                </span>
                <span
                  className={cx(
                    "shrink-0",
                    hook.decision === "deny" ? "text-fail" : "text-ink-faint",
                  )}
                >
                  {hook.decision}
                  {hook.count > 1 && <span className="numeric"> ×{hook.count}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Result">
        {node.result === null ? (
          <p className="text-[11.5px] text-ink-faint">
            {node.state === "running"
              ? "Still working."
              : "No result message was recorded for this agent."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {node.result.summary !== "" && (
              <p className="text-[12px] leading-relaxed text-ink-dim">
                {node.result.summary}
              </p>
            )}
            <dl className="grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <dt className="text-ink-faint">tokens</dt>
                <dd className="numeric text-ink">
                  {node.result.totalTokens === null
                    ? "not reported"
                    : formatTokens(node.result.totalTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-faint">tool uses</dt>
                <dd className="numeric text-ink">
                  {node.result.toolUses === null ? "not reported" : node.result.toolUses}
                </dd>
              </div>
              <div>
                <dt className="text-ink-faint">duration</dt>
                <dd className="numeric text-ink">
                  {node.result.durationMs === null
                    ? "not reported"
                    : formatDuration(node.result.durationMs)}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </Section>

      <Section title="Calls">
        <p className="text-[11.5px] text-ink-dim numeric">
          {node.toolCalls} tool {node.toolCalls === 1 ? "call" : "calls"}
          {node.tools.length > 0 && (
            <span className="text-ink-faint">
              {" "}
              across {node.tools.length} distinct{" "}
              {node.tools.length === 1 ? "name" : "names"}
            </span>
          )}
        </p>
      </Section>

      {node.sdk !== null && (
        <Section title="SDK reference">
          <dl className="space-y-1 text-[11px]">
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-ink-faint">task</dt>
              <dd className="min-w-0 truncate font-mono text-ink-dim" title={node.sdk.taskId}>
                {node.sdk.taskId}
              </dd>
            </div>
            {node.sdk.toolUseId !== null && (
              <div className="flex items-baseline gap-2">
                <dt className="shrink-0 text-ink-faint">tool use</dt>
                <dd
                  className="min-w-0 truncate font-mono text-ink-dim"
                  title={node.sdk.toolUseId}
                >
                  {node.sdk.toolUseId}
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
            For cross-referencing a transcript only. Long ids are redacted to one
            shared literal before storage, so these are never used as identity.
          </p>
        </Section>
      )}
    </div>
  );
}
