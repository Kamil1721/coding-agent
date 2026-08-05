"use client";

import type { ReactNode } from "react";

import type { ModelOption, RunDetail } from "@/lib/api-types";
import { cacheHitFraction, describeCost, totalTokens } from "@/lib/cost";
import { formatPercent, formatTokens } from "@/lib/format";
import { Explain } from "@/components/explain";
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
      {/*
       * 15px → 13px, WHICH IS BODY SIZE. This figure and the one below it were
       * two of the four largest explicit sizes in the whole client, alongside a
       * duplicate-task count — so on a run page the biggest text was SDK
       * bookkeeping. Nobody opens the Usage tab to be told a number loudly; they
       * open it to read four numbers and compare them, which is a job for
       * tabular figures at body size, and `.numeric` already supplies those.
       *
       * THE HIERARCHY IN THIS PANEL DID NOT COME FROM THE 15px AND STILL DOES
       * NOT. It comes from `emphasis` — input and output in `text-ink`, the two
       * cache rows in `text-ink-dim` — plus the 10px uppercase label above each
       * cell. Both survive this change untouched. What is lost is only the
       * shouting.
       *
       * NOT CONVERTED TO A SCALE TOKEN. 13px is `body`'s font-size, declared on
       * `body` in `globals.css` and not exposed as a `--text-*` rung, because the
       * two rungs added there are both ABOVE body. `text-[13px]` is the same
       * arbitrary value 20-odd other call sites already use; naming it would be a
       * separate, app-wide change.
       */}
      <div
        className={cx(
          "numeric mt-0.5 text-[13px] leading-tight",
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
        {/*
         * THIS 15px IS DELIBERATELY LEFT ALONE while the token cells above drop
         * to 13px, and the distinction is the point of the pass rather than an
         * omission from it. `cost.headline` is the panel's LEDE — the one line
         * that answers "what did this run cost me", and on a subscription run it
         * is the only honest answer there is. Dropping it with the token figures
         * would have flattened the whole panel to one size and removed the only
         * place its hierarchy was already correct.
         *
         * IT IS STILL OFF-SCALE, SAID OUT LOUD. `globals.css` now defines a
         * `--text-lede` rung at 16px whose entire purpose is this shape of
         * element, and this call site should become `text-lede` — a 1px change.
         * It is not made here because this pass was scoped to the run title, so
         * the rung ships with no call site. Do not read the 15px as a considered
         * value; it is an unconverted one.
         */}
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
              /*
               * THE 27-WORD `title` ON THIS ROW IS NOW AN `Explain`, 2026-08-05,
               * AND THAT IS THE ONLY COPY CHANGE IN THIS FILE.
               *
               * It was the one real explanation on the panel and the only string
               * here longer than a label. A `title` is a wall of prose that
               * happens to be hidden from sight only: it never opens on a
               * touchscreen, never opens on keyboard focus, and is not in the
               * accessibility tree the way `aria-describedby` is. The fact is
               * worth keeping — on a subscription run this row is the closest
               * thing to a cost, which is why anyone opens this panel — so it
               * moved to the affordance the rest of the app now uses.
               *
               * EVERYTHING ELSE HERE STAYED. The four `TokenCell` hints are
               * three words each ("Uncached input tokens."), which is a label's
               * gloss rather than a paragraph, and `cost.detail` under the
               * headline belongs to `lib/cost.ts`, another lane's file.
               */
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">
                  Cache hit rate
                  <Explain about="cache hit rate" className="ml-1" testId="explain-cache">
                    Cache reads as a share of the whole input side. On a
                    subscription plan it is the closest honest measure of how
                    expensive a long run is.
                  </Explain>
                </dt>
                <dd className="numeric text-ink-dim">{formatPercent(hitFraction, 1)}</dd>
              </div>
            )}
          </dl>

          {/*
           * THE CROSS-VENDOR CAVEAT WAS HERE AND IS GONE (2026-07-30).
           *
           * It read "Token counts are per-vendor and are not comparable across
           * vendors — a Claude token is not a Moonshot token", which was worth saying
           * while the model picker offered Kimi and DeepSeek rows. `isOfferedProvider`
           * in `server/src/models.ts` now admits `anthropic` and nothing else, and the
           * list is filtered by it, so every run this panel can be handed is an
           * Anthropic run and there is no second vendor to compare against — the
           * sentence warned about a comparison the UI can no longer produce, and named
           * a provider nothing in the product mentions any more. Same removal as
           * `providerLabel` in `lib/presentation.ts`.
           *
           * IF A SECOND VENDOR IS EVER OFFERED AGAIN, this caveat has to come back:
           * the numbers above are raw provider counts with no normalisation anywhere
           * in `lib/cost.ts`, so they would silently invite a false comparison.
           */}
        </>
      )}
    </Panel>
  );
}
