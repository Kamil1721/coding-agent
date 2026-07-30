"use client";

import type { ReactNode } from "react";

import type { HealthState } from "@/lib/api-types";
import { useHealth } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { Badge, CommandLine, Panel, Skeleton } from "./ui";

/**
 * ONE ROW, BECAUSE ONE PROVIDER CAN RUN A TICKET (2026-07-30).
 *
 * This panel used to render two: Anthropic via `claude setup-token`, and OpenAI
 * via `codex login`. The OpenAI row is gone — not because the probe stopped
 * working, but because the owner scoped the Codex provider out on 2026-07-28
 * (spec section 14), so `/api/models` no longer offers a Codex model and nothing
 * on this screen can select one. A row telling the owner to run `codex login`
 * would be an instruction to fix something that would still not be selectable
 * afterwards — the same wrong-remediation defect the server's 409 avoids.
 *
 * `/api/health` STILL REPORTS `codexAuth`, and that is deliberate rather than
 * missed: the field is part of the frozen contract, `auth.ts` probes both CLIs,
 * and narrowing the wire because one renderer stopped reading it is a larger
 * change than a UI request should make. It has no reader in this client now.
 *
 * The Moonshot and DeepSeek models this docblock used to mention were removed by
 * the owner on the same day; they were metered API-key vendors and never had a
 * health field at all.
 */
const SUBSCRIPTION_PROVIDERS = [
  {
    key: "claudeAuth",
    name: "Anthropic",
    command: "claude setup-token",
  },
] as const satisfies readonly {
  key: keyof Pick<HealthState, "claudeAuth">;
  name: string;
  command: string;
}[];

export function AuthPanel(): ReactNode {
  const { data, error, isLoading } = useHealth();

  return (
    /*
     * SUBTITLE REMOVED 2026-07-30. It read "Claude runs from your own plan login. No
     * API key is involved." — addressed to the person who ran `claude setup-token`
     * himself. The panel's job is the signed-in/not-signed-in state and the command
     * to fix it; everything else here was reassurance nobody needed.
     */
    <Panel title="Subscription auth">
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
