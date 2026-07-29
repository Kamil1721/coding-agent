"use client";

/**
 * environment.tsx — what the CLI was actually holding when it ran.
 *
 * EVERY FIELD COMES FROM ONE `graph_inventory` EVENT and nothing here is
 * computed, defaulted or filled in. `inventory: null` means NOTHING WAS
 * RECORDED — which is what an old run and a Codex-provider run both look like —
 * and it says exactly that instead of rendering zeroes, because "0 MCP servers"
 * and "we never asked" are different claims.
 *
 * WHAT THIS PANEL IS NOT. The reference image puts a Connect / Disconnect
 * control beside every MCP server. There is no endpoint behind that, so there
 * is no button: an MCP list that looks like it can disconnect a server and
 * cannot is worse than a list that plainly reports. The same reasoning removed
 * the reference's DATABASE INTEGRATION panel with its API KEY field — secrets
 * on this project go through `.env` and the provider's own store, never through
 * a text input in a dashboard.
 */

import type { ReactNode } from "react";

import type { GraphInventory } from "@/lib/api-types";
import { EmptyState, cx } from "@/components/ui";

function Stat({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[13px] text-ink numeric">{value}</dd>
    </div>
  );
}

/**
 * An MCP server's status string, as the CLI said it.
 *
 * Rendered through a lookup rather than interpolated into a class name: a
 * status this dashboard has not seen gets the neutral treatment and is shown
 * verbatim, never colour-coded by guess.
 */
function serverTone(status: string): string {
  const normalised = status.toLowerCase();
  if (normalised === "connected") return "text-pass";
  if (normalised === "failed" || normalised === "error") return "text-fail";
  if (normalised === "pending" || normalised === "connecting") return "text-warn";
  return "text-ink-dim";
}

export function EnvironmentPanel({
  inventory,
}: {
  inventory: GraphInventory | null;
}): ReactNode {
  if (inventory === null) {
    return (
      <EmptyState>
        No environment was recorded for this run. Runs from before the canvas
        existed, and runs on the Codex provider, carry no inventory event.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Stat label="Model" value={inventory.model === "" ? "not reported" : inventory.model} />
        <Stat
          label="CLI"
          value={
            inventory.claudeCodeVersion === "" ? "not reported" : inventory.claudeCodeVersion
          }
        />
        <Stat label="Agents available" value={inventory.agents} />
        <Stat label="Skills available" value={inventory.skills} />
        <Stat label="Tools available" value={inventory.tools} />
        <Stat label="Plugins" value={inventory.plugins.length} />
      </dl>

      {inventory.mcpServers.length > 0 && (
        <div className="border-t border-line pt-2.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            MCP servers
          </h4>
          <ul className="mt-1.5 space-y-1">
            {inventory.mcpServers.map((server) => (
              <li
                key={server.name}
                className="flex items-baseline justify-between gap-2 text-[11.5px]"
              >
                <span className="min-w-0 truncate text-ink-dim">{server.name}</span>
                <span className={cx("shrink-0", serverTone(server.status))}>
                  {server.status === "" ? "no status" : server.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inventory.allowedAgents.length > 0 && (
        <div className="border-t border-line pt-2.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Agents this run was allowed to call
          </h4>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">
            {inventory.allowedAgents.join(", ")}
          </p>
        </div>
      )}

      {inventory.environmentHash !== "" && (
        <div className="border-t border-line pt-2.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Environment hash
          </h4>
          <p
            className="mt-1 truncate font-mono text-[11px] text-ink-dim"
            title={inventory.environmentHash}
          >
            {inventory.environmentHash}
          </p>
        </div>
      )}
    </div>
  );
}
