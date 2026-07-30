"use client";

/**
 * criteria.tsx — the verdict, in the owner's language rather than the grader's.
 *
 * WHAT WAS WRONG WITH THE OLD RENDERING. It spoke the grading harness's
 * vocabulary at every level: a fixed 74px column held `REQ-013` beside every
 * statement, each group badged itself "gating" or "non-gating · reported only",
 * and the QUALITY group printed a bare `3/4` in the same shape as the gating
 * counter — so a run that PASSED could show a number that reads exactly like a
 * partial failure, on the panel that is supposed to say whether it passed.
 *
 * SO: the id is demoted to a `title` (it addresses nothing the owner can act on,
 * and hovering still gets it for anyone matching this against a verdict file),
 * the group headings and badges are plain sentences, and every count is
 * qualified by what it can and cannot do to the outcome.
 *
 * THE PLAIN COPY LIVES HERE, NOT IN `tierMeta`. `src/lib/presentation.ts` is
 * being edited by another agent in this same pass, so `tierMeta` keeps its
 * `label`/`gating`/`note` and this file maps them to owner-facing strings.
 * `GROUP_COPY` is therefore keyed on `TierMeta.label` — the value `grouped`
 * already resolved, including its deliberate decision to file an unrecognised
 * tier under QUALITY's meta — so nothing about which criteria land in which
 * group changes here. A miss falls back to the meta's own label, and the raw
 * tier stays reachable in the heading's `title`.
 */

import { useMemo, type ReactNode } from "react";

import type { RunCriterion } from "@/lib/api-types";
import { criterionTone, tierMeta, TIER_ORDER, TONE_TEXT } from "@/lib/presentation";
import { Badge, Dot, EmptyState, Panel, cx } from "@/components/ui";

const RESULT_LABEL = { pass: "pass", fail: "fail", pending: "…" } as const;

/** Plain-language group copy, keyed on `TierMeta.label`. */
const GROUP_COPY: Readonly<Record<string, { heading: string; badge: string }>> = {
  Blocking: { heading: "Must build and run", badge: "must pass" },
  Functional: { heading: "Does what the ticket asked", badge: "must pass" },
  Quality: { heading: "Craft and polish", badge: "does not change the verdict" },
};

interface Tally {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly pending: number;
}

function tally(items: readonly RunCriterion[]): Tally {
  return {
    total: items.length,
    pass: items.filter((item) => item.result === "pass").length,
    fail: items.filter((item) => item.result === "fail").length,
    pending: items.filter((item) => item.result === "pending").length,
  };
}

function CriterionRow({ criterion, gating }: { criterion: RunCriterion; gating: boolean }): ReactNode {
  const tone = criterionTone(criterion.result, gating);
  const label = RESULT_LABEL[criterion.result] ?? criterion.result;

  return (
    /*
     * THE ID IS ON THE ROW, NOT IN IT. `REQ-013` is the grader's join key: it
     * appears in `verdict.md` and in the gate report, so it cannot be deleted —
     * but it is not something the reader of this panel can click, search or act
     * on, and as a monospace column it took a fixed 74px from the statement,
     * which is the part they came to read. `title` on the `<li>` means hovering
     * anywhere on the row gets it back.
     */
    <li
      title={criterion.id}
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

/**
 * The per-group count, qualified so it cannot be read as a verdict it is not.
 *
 * THREE CASES, AND THE FIRST IS WHY THIS IS A FUNCTION. A group whose criteria
 * have all not been graded yet used to print `0/4` — which is the same shape as
 * four failures on a run that has simply not reached the gate. It now says so.
 * The non-gating wording avoids "passing" entirely: those criteria are reported,
 * and calling three of four "passing" invites the missing one to be read as a
 * failure of the run, which is exactly what it is not.
 *
 * `.numeric` IS ON THE FIGURES ONLY, NOT ON THE PHRASE. That utility
 * (`globals.css:80`) swaps the font family to the mono stack as well as turning
 * on tabular numerals, so wrapping "3 of 4 clean" in it would set four words in a
 * different typeface inside a sans header. The digits get it, the words do not.
 */
function groupCount(counts: Tally, gating: boolean): { node: ReactNode; title: string } {
  if (counts.total > 0 && counts.pending === counts.total) {
    return {
      node: (
        <>
          <span className="numeric">{counts.total}</span> to check
        </>
      ),
      title: "Not graded yet — the gate has not returned a verdict for these.",
    };
  }
  return {
    node: (
      <>
        <span className="numeric">{counts.pass}</span> of{" "}
        <span className="numeric">{counts.total}</span> {gating ? "passing" : "clean"}
      </>
    ),
    title: gating
      ? "Every one of these has to pass for the run to pass."
      : "Reported only — a failure here does not fail the run.",
  };
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
  const gatingTotals = useMemo(
    () => tally(criteria.filter((criterion) => tierMeta(criterion.tier).gating)),
    [criteria],
  );

  return (
    <Panel
      title="Acceptance criteria"
      subtitle="Authored from the ticket before any code was written, then frozen."
      actions={
        gatingTotals.total === 0 ? null : gatingTotals.pending === gatingTotals.total ? (
          /*
           * NOT `0 of 4 green`. On a run that has not reached the gate every
           * gating criterion is pending, and a zero numerator beside the word
           * green is a failure to anyone reading quickly.
           */
          <span className="text-[11.5px] text-ink-faint">
            {gatingTotals.total} checks that must pass — not graded yet
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-dim">
            <span className="numeric text-pass">{gatingTotals.pass}</span>
            {" of "}
            <span className="numeric">{gatingTotals.total}</span>
            {" must-pass checks green"}
            {gatingTotals.fail > 0 && (
              <span className="text-fail"> · {gatingTotals.fail} failed</span>
            )}
            {gatingTotals.pending > 0 && (
              <span className="text-ink-faint"> · {gatingTotals.pending} still to check</span>
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
          {grouped.map((group) => {
            const copy = GROUP_COPY[group.meta.label];
            const counts = tally(group.items);
            const count = groupCount(counts, group.meta.gating);
            return (
              <section key={group.tier}>
                <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-raised/50 px-3 py-1">
                  {/*
                   * The raw tier rides along in the tooltip with the grader's own
                   * note — the same demotion the criterion id gets. An
                   * unrecognised tier has no plain heading to map to, so it keeps
                   * `tierMeta`'s label and renders exactly as it does today.
                   */}
                  <span
                    title={`${group.tier} · ${group.meta.note}`}
                    className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim"
                  >
                    {copy?.heading ?? group.meta.label}
                  </span>
                  <Badge tone={group.meta.gating ? "neutral" : "info"} title={group.meta.note}>
                    {copy?.badge ?? (group.meta.gating ? "must pass" : "does not change the verdict")}
                  </Badge>
                  <span title={count.title} className="ml-auto text-[11px] text-ink-faint">
                    {count.node}
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
            );
          })}
        </div>
      )}
    </Panel>
  );
}
