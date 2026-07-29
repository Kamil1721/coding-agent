"use client";

import type { ReactNode } from "react";

import type { ModelOption, RunDetail } from "@/lib/api-types";
import { cacheHitFraction, describeCost, totalTokens } from "@/lib/cost";
import { formatPercent, formatTokens } from "@/lib/format";
import { Panel, cx } from "@/components/ui";

function TokenCell({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint: string;
  emphasis?: boolean;
}): ReactNode {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </div>
      <div
        className={cx(
          "numeric mt-0.5 text-[15px] leading-tight",
          emphasis ? "text-ink" : "text-ink-dim",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Usage.
 *
 * A subscription run has NO dollar figure — the API sends `costUsd: null` and
 * inventing one would be a fabrication. What exists is the token counts and
 * the quota state, so those are what this panel leads with. `describeCost`
 * decides which of the three honest readings applies; see `src/lib/cost.ts`.
 */
export function UsagePanel({
  run,
  model,
}: {
  run: RunDetail;
  model: ModelOption | null;
}): ReactNode {
  const cost = describeCost(run.costUsd, model);
  const tokens = run.tokens;
  const hitFraction = tokens === null ? null : cacheHitFraction(tokens);

  return (
    <Panel title="Usage">
      <div
        className={cx(
          "rounded-sm border px-2.5 py-2",
          cost.kind === "included"
            ? "border-info/35 bg-info-dim/40"
            : cost.kind === "amount"
              ? "border-line-strong bg-surface-raised"
              : "border-line bg-surface-raised/60",
        )}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {cost.kind === "amount" ? "Cost" : "Billing"}
        </div>
        <div
          className={cx(
            "mt-0.5 text-[15px] font-medium leading-tight",
            cost.kind === "included" ? "text-info" : "text-ink",
            cost.kind === "amount" && "numeric",
          )}
        >
          {cost.headline}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink-faint">{cost.detail}</p>
      </div>

      {tokens === null ? (
        <p className="mt-3 text-[12px] text-ink-faint">
          No token counts reported yet.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            <TokenCell
              label="Input"
              value={formatTokens(tokens.inputTokens)}
              hint="Uncached input tokens."
              emphasis
            />
            <TokenCell
              label="Output"
              value={formatTokens(tokens.outputTokens)}
              hint="Generated tokens."
              emphasis
            />
            <TokenCell
              label="Cache read"
              value={formatTokens(tokens.cacheReadTokens)}
              hint="Tokens served from the prompt cache."
            />
            <TokenCell
              label="Cache write"
              value={formatTokens(tokens.cacheWriteTokens)}
              hint="Tokens written into the prompt cache."
            />
          </div>

          <dl className="mt-3 space-y-1 border-t border-line pt-2 text-[11.5px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">Total tokens</dt>
              <dd className="numeric text-ink-dim">{formatTokens(totalTokens(tokens))}</dd>
            </div>
            {hitFraction !== null && (
              <div
                className="flex items-baseline justify-between gap-3"
                title="Cache reads as a share of the whole input side. On a subscription plan this is the closest honest proxy for how expensive a long run is."
              >
                <dt className="text-ink-faint">Cache hit rate</dt>
                <dd className="numeric text-ink-dim">{formatPercent(hitFraction, 1)}</dd>
              </div>
            )}
          </dl>

          <p className="mt-2 text-[10.5px] leading-snug text-ink-faint">
            Token counts are per-vendor and are not comparable across vendors — a
            Claude token is not a Moonshot token.
          </p>
        </>
      )}
    </Panel>
  );
}
