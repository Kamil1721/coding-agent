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

import type { MachineCheck, RunCriterion } from "@/lib/api-types";
import { criterionTone, tierMeta, TIER_ORDER, TONE_TEXT } from "@/lib/presentation";
import { Explain } from "@/components/explain";
import { Badge, EmptyState, Panel, cx } from "@/components/ui";

const RESULT_LABEL = { pass: "pass", fail: "fail", pending: "…" } as const;

/**
 * Plain-language group copy, keyed on `TierMeta.label`.
 *
 * "DOES NOT CHANGE PASS OR FAIL", NOT "does not change the verdict" —
 * 2026-08-05. The badge has to say that a failure in this group cannot fail the
 * run, and it has to say it in three or four words on one line; `verdict` is a
 * word the owner does not use and the rail no longer prints anywhere. Pass and
 * fail are the two words this panel already labels every row with.
 */
const GROUP_COPY: Readonly<Record<string, { heading: string; badge: string }>> = {
  Blocking: { heading: "Must build and run", badge: "must pass" },
  Functional: { heading: "Does what the ticket asked", badge: "must pass" },
  Quality: { heading: "Craft and polish", badge: "does not change pass or fail" },
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
      title: "Not graded yet — these have not been checked against the build.",
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

/**
 * THE THIRD SECTION — the twelve checks nobody wrote, which were on no screen.
 *
 * WHY IT IS HERE AND NOT ITS OWN PANEL. The two sections above answer "did the
 * run do what I asked"; this one answers "and does the thing actually work",
 * which is the same question the same reader is asking in the same breath. It
 * was also the missing half of the number in this panel's own header: the gate
 * scores twelve machine gates AND the criteria, the criteria table holds rows
 * only for the criteria, and so a run whose build never compiled could print "8
 * of 8 must-pass checks green" here with nothing on the page naming what failed
 * it.
 *
 * IT DOES NOT TOUCH THE HEADER'S COUNT, DELIBERATELY. That number means "how
 * much of your ticket was delivered" and folding twelve identical machine gates
 * into it would move a denominator the owner reads across runs. Two counts, each
 * over one kind of thing, is what makes either one legible.
 *
 * `null` IS A SENTENCE, NOT AN EMPTY LIST. A run that has not reached the gate
 * gets one line saying so — the same refusal as `heldOutPass: null` and
 * `gateAttempts: 0`: a check that has not run must never be drawn like a check
 * that passed, and twelve grey rows would be exactly that drawing.
 *
 * THE STATUS COLUMN IS WIDER THAN THE CRITERION ROWS' 34px and everything else
 * about it is identical — same mono, same uppercase, same right alignment, same
 * `TONE_TEXT` colours. "did not pass" does not fit in 34px, and the two words it
 * replaces ("fail") say something subtly different here: these gates are the
 * house's, so a red row is the machine reporting on itself rather than a verdict
 * on the owner's ticket.
 */
function MachineChecksSection({
  checks,
}: {
  checks: readonly MachineCheck[] | null;
}): ReactNode {
  const passed = checks === null ? 0 : checks.filter((check) => check.passed).length;

  return (
    <section data-testid="machine-checks">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-raised/50 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
          Machine checks
        </span>
        {/*
         * "ALWAYS ON" IS THE ONE FACT THAT SEPARATES THIS GROUP FROM THE TWO
         * ABOVE IT: the criteria differ per ticket and these do not. It sits in
         * the same badge slot the other sections use for "must pass", which is
         * also true of these — and is said there, not here, because a reader who
         * has read the two badges above already knows what this panel gates on.
         */}
        <Badge tone="neutral" title="The same twelve checks run on every ticket.">
          always on
        </Badge>
        <span
          /*
           * "GATE" IS NOT IN EITHER SENTENCE, and a `title` is exactly where a
           * term of art survives — this file's own rows demote the criterion id
           * to one, and `prose-guard.browser.spec.ts` harvests attributes for
           * the same reason. The word is precise in the code and means nothing
           * to the reader; "once the build is finished" is the same fact.
           */
          title={
            checks === null
              ? "They run once the build is finished. This one did not get that far."
              : "Every one of these has to pass for the run to pass."
          }
          className="ml-auto text-[11px] text-ink-faint"
        >
          {checks === null ? (
            "not run yet"
          ) : (
            <>
              <span className={cx("numeric", passed === checks.length && "text-pass")}>
                {passed}
              </span>{" "}
              of <span className="numeric">{checks.length}</span> passing
            </>
          )}
        </span>
      </header>
      {checks === null ? (
        <p className="px-3 py-2 text-[12.5px] leading-snug text-ink-faint">
          This run never got as far as these checks.
        </p>
      ) : (
        <ul>
          {checks.map((check) => (
            /*
             * NO `title={check.id}`, and that is the one place this row parts
             * company with `CriterionRow` above. `REQ-013` is a key the owner can
             * match against a verdict file; `GATE:suite-intact` is a key with a
             * word on his own banned list in it, and a hover attribute is exactly
             * where such words survive unread — `tests/prose-guard.browser.spec
             * .ts` harvests `title` for that reason. The id stays on the wire,
             * where a bug report can quote it.
             */
            <li
              key={check.id}
              className={cx(
                "flex items-start gap-2.5 border-b border-line/70 px-3 py-1.5 last:border-b-0",
                !check.passed && "bg-fail-dim/30",
              )}
            >
              <span
                className={cx(
                  "mt-[3px] w-[72px] shrink-0 text-right font-mono text-[10.5px] uppercase",
                  check.passed ? TONE_TEXT.pass : TONE_TEXT.fail,
                )}
              >
                {check.passed ? "pass" : "did not pass"}
              </span>
              <span className="min-w-0 text-[12.5px] leading-snug text-ink-dim">
                {check.label}
                {/*
                 * THE SECOND LINE IS THE MACHINE'S OWN WORDS, and it appears only
                 * under a row that failed. The server sends it for nine of the
                 * twelve — the ones whose detail is the artefact's own compiler,
                 * linter or HTTP output — and `null` for the three whose detail
                 * quotes the locked tests. A reader who cannot see it is not
                 * missing a fact the server had; there was no sentence to show.
                 */}
                {check.detail !== null && (
                  <span className="mt-0.5 block break-words font-mono text-[11px] leading-snug text-ink-faint">
                    {check.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CriteriaPanel({
  criteria,
  machineChecks,
}: {
  criteria: readonly RunCriterion[];
  /** `null` = this run never reached the gate. NEVER the same as `[]`. */
  machineChecks: readonly MachineCheck[] | null;
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
      /*
       * "LOCKED", NOT "frozen", AND THE PROMISE IS SPELLED OUT — 2026-08-05.
       * `freeze` is on the owner's banned list, and the sealing stage's own
       * label already reads "Sealing the tests" with the detail "Locks the tests
       * so the builder can never read them" (`server/src/graph.test.ts` asserts
       * both halves of that sentence). Dropping the word is free; dropping what
       * it promised — that nothing edited these after the build began — would be
       * a different product, so the sentence still says it in full.
       *
       * IT MOVED FROM `subtitle` TO AN `Explain` — 2026-08-05, and it moved
       * rather than being deleted. The fact is what makes a green count worth
       * anything: criteria written after the build, by the builder, grade
       * nothing. But it is not needed BEFORE reading a result, and it was on
       * screen TWICE — this sentence and the empty state's "They are written
       * from your ticket first, before any build starts" said the same thing two
       * lines apart, which is the repetition the owner screenshotted. The empty
       * state now says only that there are none yet.
       */
      /*
       * THE GLYPH IS TIED TO THE LAST WORD, AND THAT IS A MEASURED FIX RATHER
       * THAN A PRECAUTION. `Panel`'s header is `flex justify-between` with the
       * title in a `min-w-0` div, so the heading shrinks against the count on
       * its right — and an atomic inline box (this is an `inline-flex` span) is
       * a legal break opportunity after text even with no whitespace between
       * them, which is UAX#14's contingent break. Screenshotted on the passed
       * run at 380px: "ACCEPTANCE CRITERIA" on one line and the glyph alone on
       * the next. `whitespace-nowrap` on the last word plus the glyph keeps them
       * together and still lets the heading wrap at the space before it.
       *
       * `normal-case` IS NOT DECORATION, AND IT IS A DEFECT IN `Explain` THAT
       * THIS CALL SITE IS WORKING AROUND. Shut, the bubble is one `sr-only`
       * child of the wrapper span — no layout, still in the accessibility tree —
       * and `sr-only` sets no `text-transform`, so inside this `uppercase` `h2`
       * the hidden sentence INHERITS the transform. Measured, not deduced:
       * `panel-copy.browser.spec.ts`'s canary went red reading "WRITTEN FROM
       * YOUR TICKET BEFORE ANY CODE EXISTED, THEN LOCKED SO THE BUILD COULD NOT
       * EDIT THEM." out of `innerText`, and a screen reader is handed the same
       * string — which some voices spell out letter by letter. The open bubble
       * already carries `normal-case`; the shut one needs it from the wrapper.
       * The real fix belongs in `explain.tsx`, which is another lane's file: see
       * the hand-off.
       */
      title={
        <>
          Acceptance{" "}
          <span className="whitespace-nowrap">
            criteria
            <Explain about="acceptance criteria" className="ml-1 normal-case" testId="explain-criteria">
              Written from your ticket before any code existed, then locked so the
              build could not edit them.
            </Explain>
          </span>
        </>
      }
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
        // The second sentence — "They are written from your ticket first, before
        // any build starts" — is DELETED, not moved: the heading's `Explain`
        // directly above says it, and saying it twice on one panel is what this
        // pass exists to remove.
        //
        // THE MACHINE SECTION BELOW STILL RENDERS UNDER IT. A run with no
        // criteria has usually not reached the gate either, and the honest
        // rendering of that is a section saying so — not an absent section,
        // which reads as "there are no such checks".
        <EmptyState>No criteria yet.</EmptyState>
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
                    {copy?.badge ??
                      (group.meta.gating ? "must pass" : "does not change pass or fail")}
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
                {/*
                 * THE NON-GATING FOOTNOTE IS DELETED — 2026-08-05. It read "A
                 * failure in this group does not fail the run, and a clean sweep
                 * here does not raise the grade. It is reported so you can see
                 * it, nothing more." Thirty words restating the badge four lines
                 * above it, which says "does not change pass or fail" and covers
                 * both directions of the same claim. Nothing was moved behind an
                 * `Explain`: the badge is already the short form, and a glyph
                 * beside it would be a second affordance for a sentence the
                 * reader has already read.
                 */}
              </section>
            );
          })}
        </div>
      )}
      {/*
       * LAST, AND UNDER BOTH BRANCHES ABOVE. The two authored groups answer
       * "did it do what I asked"; this one answers "does it run at all", which
       * is the check a reader falls back on when the first answer is bad — and
       * for months it was the one answer this panel could not give.
       */}
      <MachineChecksSection checks={machineChecks} />
    </Panel>
  );
}
