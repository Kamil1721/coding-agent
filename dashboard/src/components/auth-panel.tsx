"use client";

import type { ReactNode } from "react";

import type { HealthState } from "@/lib/api-types";
import { useHealth } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { Badge, CommandLine, Panel, Skeleton } from "./ui";

/**
 * `/api/health` reports exactly two providers, because exactly two are
 * authenticated by a SUBSCRIPTION login rather than an API key:
 *
 *   - Anthropic, via `claude setup-token` (a long-lived OAuth token held by
 *     the Claude CLI)
 *   - OpenAI, via `codex login` (browser OAuth, credentials under CODEX_HOME)
 *
 * Neither needs an API key and neither must ever ask for one. Moonshot and
 * DeepSeek are metered and have no health field at all — their availability
 * arrives per-model as `ModelOption.available` + `reason`, and is shown inline
 * in the picker. Rendering four provider rows here would leave two of them
 * permanently "unknown".
 */
const SUBSCRIPTION_PROVIDERS = [
  {
    key: "claudeAuth",
    name: "Anthropic",
    detail: "Claude Agent SDK, driven as a subprocess",
    command: "claude setup-token",
  },
  {
    key: "codexAuth",
    name: "OpenAI",
    detail: "Codex SDK, driven as a subprocess",
    command: "codex login",
  },
] as const satisfies readonly {
  key: keyof Pick<HealthState, "claudeAuth" | "codexAuth">;
  name: string;
  detail: string;
  command: string;
}[];

export function AuthPanel(): ReactNode {
  const { data, error, isLoading } = useHealth();

  return (
    <Panel
      title="Subscription auth"
      subtitle="Both providers run from your own plan login. No API key is involved."
    >
      {isLoading && data === undefined ? (
        <Skeleton rows={2} />
      ) : error !== undefined && data === undefined ? (
        <p className="text-[12px] text-warn">
          Cannot read <code className="font-mono text-[11.5px]">/api/health</code>:{" "}
          {errorMessage(error)}
        </p>
      ) : data === undefined ? null : (
        <ul className="divide-y divide-line">
          {SUBSCRIPTION_PROVIDERS.map((provider) => {
            const ok = data[provider.key] === "ok";
            return (
              <li
                key={provider.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0"
              >
                <span className="w-[76px] shrink-0 text-[12.5px] font-medium text-ink">
                  {provider.name}
                </span>
                <Badge tone={ok ? "pass" : "warn"}>
                  {ok ? "signed in" : "not signed in"}
                </Badge>
                <span className="text-[11.5px] text-ink-faint">{provider.detail}</span>
                {!ok && (
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-[11.5px] text-ink-dim">run</span>
                    <CommandLine command={provider.command} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
