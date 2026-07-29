"use client";

import { useMemo, type ReactNode } from "react";

import type { RunCriterion } from "@/lib/api-types";
import { criterionTone, tierMeta, TIER_ORDER, TONE_TEXT } from "@/lib/presentation";
import { Badge, Dot, EmptyState, Panel, cx } from "@/components/ui";

const RESULT_LABEL = { pass: "pass", fail: "fail", pending: "…" } as const;

function CriterionRow({ criterion, gating }: { criterion: RunCriterion; gating: boolean }): ReactNode {
  const tone = criterionTone(criterion.result, gating);
  const label = RESULT_LABEL[criterion.result] ?? criterion.result;

  return (
    <li
      className={cx(
        "flex items-start gap-2.5 border-b border-line/70 px-3 py-1.5 last:border-b-0",
        criterion.result === "fail" && gating && "bg-fail-dim/30",
      )}
    >
      <span
        className={cx(
          "mt-[3px] w-[34px] shrink-0 text-right font-mono text-[10.5px] uppercase",
          TONE_TEXT[tone],
        )}
      >
        {label}
      </span>
      <code className="mt-[2px] w-[74px] shrink-0 font-mono text-[11px] text-ink-faint">
        {criterion.id}
      </code>
      <span
        className={cx(
          "min-w-0 text-[12.5px] leading-snug",
          criterion.result === "pending" ? "text-ink-faint" : "text-ink-dim",
        )}
      >
        {criterion.statement}
      </span>
    </li>
  );
}

export function CriteriaPanel({
  criteria,
}: {
  criteria: readonly RunCriterion[];
}): ReactNode {
  const grouped = useMemo(() => {
    const known = TIER_ORDER.map((tier) => ({
      tier,
      meta: tierMeta(tier),
      items: criteria.filter((criterion) => criterion.tier === tier),
    }));
    const unknown = criteria.filter(
      (criterion) => !TIER_ORDER.includes(criterion.tier),
    );
    if (unknown.length > 0) {
      known.push({
        tier: unknown[0]?.tier ?? "QUALITY",
        meta: tierMeta("QUALITY"),
        items: unknown,
      });
    }
    return known.filter((group) => group.items.length > 0);
  }, [criteria]);

  // The gate is BLOCKING + FUNCTIONAL only. QUALITY is deliberately excluded
  // from this arithmetic: it is reported, never gating, and a failing quality
  // criterion must not make a passing run read as failed.
  const gatingTotals = useMemo(() => {
    const gating = criteria.filter((criterion) => tierMeta(criterion.tier).gating);
    return {
      total: gating.length,
      passed: gating.filter((criterion) => criterion.result === "pass").length,
      failed: gating.filter((criterion) => criterion.result === "fail").length,
      pending: gating.filter((criterion) => criterion.result === "pending").length,
    };
  }, [criteria]);

  return (
    <Panel
      title="Acceptance criteria"
      subtitle="Authored from the ticket before any code was written, then frozen."
      actions={
        gatingTotals.total === 0 ? null : (
          <span className="numeric text-[11.5px] text-ink-dim">
            <span className="text-pass">{gatingTotals.passed}</span>
            {" / "}
            {gatingTotals.total} gating
            {gatingTotals.failed > 0 && (
              <span className="text-fail"> · {gatingTotals.failed} failed</span>
            )}
            {gatingTotals.pending > 0 && (
              <span className="text-ink-faint"> · {gatingTotals.pending} pending</span>
            )}
          </span>
        )
      }
      bodyClassName="p-0"
    >
      {criteria.length === 0 ? (
        <EmptyState>
          No criteria yet. They are authored during the spec phase, before the build
          starts.
        </EmptyState>
      ) : (
        <div>
          {grouped.map((group) => (
            <section key={group.tier}>
              <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-raised/50 px-3 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
                  {group.meta.label}
                </span>
                {group.meta.gating ? (
                  <Badge tone="neutral" title={group.meta.note}>
                    gating
                  </Badge>
                ) : (
                  <Badge tone="info" title={group.meta.note}>
                    non-gating · reported only
                  </Badge>
                )}
                <span className="numeric ml-auto text-[11px] text-ink-faint">
                  {group.items.filter((item) => item.result === "pass").length}/
                  {group.items.length}
                </span>
              </header>
              <ul>
                {group.items.map((criterion) => (
                  <CriterionRow
                    key={criterion.id}
                    criterion={criterion}
                    gating={group.meta.gating}
                  />
                ))}
              </ul>
              {!group.meta.gating && (
                <p className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-[11px] leading-snug text-ink-faint last:border-b-0">
                  <Dot tone="info" className="mt-[5px]" />
                  <span>
                    A failure in this group does not fail the run, and a clean sweep here
                    does not raise the grade. It is reported so you can see it, nothing
                    more.
                  </span>
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
