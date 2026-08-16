"use client";

/**
 * repair-questions-panel.tsx — what the repair lane ASKED, grouped by what the
 * answer did to the diagnosis.
 *
 * THE ASK, in the owner's words on 2026-08-16: "I want the review orchestrator to
 * have a section where I can see the questions that where asked." This is the
 * owner's window into a lane that runs while they are asleep — it replaces the
 * thing it displaces, which is sitting in a chat watching the reasoning happen.
 * The spec is `docs/DESIGN-repair-lane-2026-08-16.md` §11.
 *
 * ─── IT HAS NO CALL SITE YET, AND THAT IS SAID RATHER THAN IMPLIED ───
 *
 * MEASURED 2026-08-16: `grep -rn RepairQuestionsPanel src/ tests/` finds this file
 * and its unit spec, and nothing else. §11.1 puts this section inside the REPAIR
 * NODE — between what broke and the patch — and that node does not exist in this
 * tree, so nothing mounts it and it is on no screen. It is written as a section
 * body rather than as a card so it drops into that node's panel beside the other
 * three sections without a wrapper.
 *
 * Stated because this codebase states it: `presentation.ts` records that
 * `run/header.tsx` "is not a fourth surface until something does" import it, and
 * `globals.css` says of an unspent token that "if you are reading this and it still
 * has zero call sites, deleting it is a legitimate outcome". The same standard
 * applies here. If the repair node is abandoned, this file is dead code and should
 * go with it.
 *
 * ─── GROUPED BY OUTCOME, NEVER CHRONOLOGICALLY, AND THAT IS THE WHOLE DESIGN ───
 *
 * §11.2: "Chronological order is close to useless: most questions confirm what was
 * already assumed, and burying the two that did not inside eighteen that did is how
 * a panel becomes wallpaper." Three groups, in this order, always:
 *
 *   NEEDS YOU              tagged `OWNER`. Pinned, never collapsible. The owner's
 *                          queue, and the same set that populates the second half
 *                          of the emailed report (§10.4) — one source, two
 *                          renderings, so the panel and the email cannot drift.
 *   CHANGED THE DIAGNOSIS  the answer was not what was assumed. Open.
 *   CONFIRMED              the assumption held. Collapsed, count only.
 *
 * THE GROUPING IS SOURCE-FIRST AND ONLY THEN OUTCOME, which is the one thing in
 * this file most likely to be "simplified" into a switch on `outcome` alone. It
 * cannot be: `outcome` has no `OWNER` member, so a question the lane could not
 * answer from any evidence source can carry ANY outcome the writer chose —
 * including `CONFIRMED`. Grouped on outcome alone, an `OWNER` question with
 * `outcome: "CONFIRMED"` lands in the collapsed group and the owner's queue
 * silently loses a row. That exact input is the first fixture in
 * `tests/repair-questions.unit.spec.ts` and the mutation that file names.
 *
 * `UNANSWERED` GOES TO THE OWNER'S QUEUE TOO, and the reason is §10.3 rather than
 * taste: `CONFIRMED` asserts that the assumption held, which is a claim, and it is
 * false of a question nobody answered. There is no honest third place for it —
 * "CHANGED THE DIAGNOSIS" is also a claim about an answer that does not exist — so
 * an unanswered question is a question that still needs somebody, and it is put
 * where somebody will see it. Where it differs from an `OWNER` row is in what the
 * row itself says: see {@link answerLine}, which reads a non-`OWNER` source with no
 * answer as the lane having named an evidence source and then not produced it.
 *
 * ─── THE SECOND METRIC CAN KILL THIS FEATURE, SO IT IS RENDERED, NOT HIDDEN ───
 *
 * §11.3 asks the panel to carry two counts, and is explicit that the second one is
 * self-refuting: "a Codex asker whose questions never change a diagnosis is
 * ceremony, and the honest response is to delete the step rather than keep paying
 * for it. A feature that cannot display its own failure is the defect this repo is
 * named for." So {@link askerEarnedNothing} is a predicate a test can call, and
 * when it holds the panel says so in a sentence at full reading weight ABOVE the
 * collapsed group rather than leaving the reader to notice a zero.
 *
 * WHAT THAT PREDICATE DELIBERATELY DOES NOT COVER, stated rather than left to be
 * discovered: it fires only when EVERY question confirmed — nothing changed the
 * diagnosis AND nothing came back to the owner. A run with four confirmations, one
 * `OWNER` question and zero changed diagnoses does not trip it, because an `OWNER`
 * question is something the asker produced that the lane could not have reached
 * alone, and because the NEEDS YOU group is already the loudest thing on screen in
 * that case. If the owner later wants the stricter reading — "zero changed, full
 * stop" — this is the one function to change and the two tests around it say which
 * behaviour is which.
 *
 * ─── NO HOOKS, AND THAT IS A TESTABILITY CONSTRAINT, NOT A STYLE ───
 *
 * The collapse is a `<details>` element, matching `inspector.tsx:568`. It is not
 * `useState`, and the reason is measured in this repository rather than assumed:
 * the unit suite calls components as plain functions — `RunHud({...})` at
 * `tests/ticket-title.unit.spec.ts:363` — and React's dispatcher is null outside a
 * renderer, so one `useState` at the top of this component turns every assertion in
 * the sibling spec into "Invalid hook call". `<details>` also keeps the fold
 * working with no JavaScript, is focusable, and toggles on Enter with no handler of
 * ours. NEEDS YOU is deliberately NOT a `<details>` at all: "always open" has to be
 * a property of the markup, or a future default-shut summary can quietly close the
 * owner's queue.
 *
 * EVERYTHING COMPOSES THROUGH `children`, for the same reason. That spec's tree
 * walk follows `props.children` and nothing else, so a subtree handed through any
 * other prop is invisible to it and every negative assertion over that subtree
 * would pass vacuously.
 *
 * ─── THE ASKER IS A PANEL-LEVEL FACT BECAUSE THE RECORD HAS NO ASKER FIELD ───
 *
 * §11.2 asks each row to carry "asker · question · source tag · answer · citation",
 * and the record it names carries five fields, none of them an asker. That is not
 * an omission: §10.5 puts Codex at the front of the loop as the asker of every
 * question in the corpus ("CODEX ask: what must be known before anyone claims to
 * understand this?"), so the asker is constant for the whole set. It is stated once
 * in the caption. A constant `CODEX` stamped on eighteen rows would be wallpaper of
 * exactly the kind §11.2 exists to prevent, and printing a per-row asker this
 * component cannot source would be the display claiming more than its data
 * supports. {@link ASKED_BY} is the line that becomes per-row on the day
 * `repair-questions.ts` grows the field.
 *
 * ─── THE PROP TYPE IS A MIRROR, AND ITS SOURCE OF TRUTH IS THE SERVER ───
 *
 * `dashboard/server/src/repair-questions.ts` owns {@link RepairQuestion}. MEASURED
 * 2026-08-16 in this worktree: that file does not exist yet (`ls
 * dashboard/server/src/repair-questions.ts` → no such file; the repair files
 * present are `repair-author.ts` and its test), so the shape below is taken from
 * this lane's brief and from §11.2's worked row and is UNVERIFIED against the
 * server. Two fields are declared non-nullable — `answer` and `citation` — because
 * the stated shape names no nullability; if the server makes either `| null`, this
 * declaration is wrong in a way TypeScript here cannot see, and {@link blank} is
 * the single place the render tolerates the difference.
 *
 * The boundary that catches that is `dashboard/server/src/contract-parity.test.ts`,
 * which compares FIELD SETS IN BOTH DIRECTIONS across the two packages by parsing
 * the client's declaration as text (see its header: the two halves are separate
 * TypeScript programs, so nothing type-level can span them). The interface below is
 * therefore written flat — one field per line, union members spelled out as
 * literals — so that check can be extended to this shape without first reformatting
 * it. Adding a field here that the server does not have is meant to fail there.
 *
 * ─── PALETTE ───
 *
 * No new colour. Everything is `globals.css`'s theme (`:13-41`). Colour carries one
 * thing in this panel and one only: `warn` means A HUMAN HAS TO LOOK, which is the
 * same job it already does for `awaiting_input` in `lib/presentation.ts:84` ("The
 * run stopped for a decision from you"). It is spent in exactly two places, and
 * they are the same place twice — the `OWNER` source tag and the NEEDS YOU block
 * that tag routes a row into. Everything else separates on CONTRAST rather than
 * hue — full ink for the group that changed the diagnosis, faint for the
 * confirmations — the same axis `inspector.tsx:86-94` uses to keep sixty
 * housekeeping calls from burying six design steps, and the two caveats (an
 * uncited answer, a round that returned nothing) take `inspector.tsx:579`'s
 * dashed-and-dim treatment rather than a tint of their own.
 *
 * NOTHING MECHANICALLY CHECKS THAT, for this file. `prebuild-lane.browser.spec.ts`
 * scans `stage-node.tsx` and the pre-build panel for colour names the theme does
 * not define — the failure that once shipped `bg-run`, an invisible marker — and it
 * does not read this file. Every stem used here (`warn`, `warn-dim`, `line`,
 * `line-strong`, `ink`, `ink-dim`, `ink-faint`, `canvas`, and the `numeric` class)
 * was checked against `globals.css` by hand on 2026-08-16.
 */

import type { ReactNode } from "react";

import { cx } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* The record                                                          */
/* ------------------------------------------------------------------ */

/**
 * Where an answer came from. §10.3's table, verbatim, and the order is its order.
 *
 * The rule that makes this list load-bearing rather than decorative: "every
 * self-asked question must name its evidence source BEFORE it is answered", and "a
 * question that cannot be assigned one of the first four IS the fifth". So `OWNER`
 * is not a sixth kind of evidence — it is the absence of the other four, which is
 * why it routes to a group rather than to a colour alone.
 */
export type RepairQuestionSource =
  | "CODE"
  | "DATA"
  | "EXPERIMENT"
  | "CODEX"
  | "OWNER";

/** What the answer did to the diagnosis. §11.2's three groups, less the OWNER cut. */
export type RepairQuestionOutcome =
  | "CHANGED_DIAGNOSIS"
  | "CONFIRMED"
  | "UNANSWERED";

/**
 * One question the repair lane asked, as the server records it.
 *
 * SOURCE OF TRUTH: `dashboard/server/src/repair-questions.ts`. This is a hand
 * mirror of it and nothing here may add a field — see the header for the parity
 * check that is meant to catch a mirror that drifted, and for the measurement
 * showing that file does not exist yet.
 */
export interface RepairQuestion {
  /** What was asked, in the asker's own words. */
  readonly question: string;
  /** The evidence source named BEFORE the answer was written. */
  readonly source: RepairQuestionSource;
  /** The answer, from that source. Empty when nobody answered it. */
  /**
   * `string | null`, MATCHING THE SERVER. `repair-questions.ts`'s `OwnerQuestion`
   * declares `answer: null` and `citation: null` — not `""` — and this mirror
   * declared both `string`, so {@link blank} called `.trim()` on null and the
   * panel THREW on the one row it exists to pin above the fold. The unit spec
   * could not see it because every OWNER fixture used `""`; a fixture carrying
   * the server's real nulls was added with this fix.
   */
  readonly answer: string | null;
  /** Where the answer came from: a `file:line`, a query, an exit code. */
  readonly citation: string | null;
  /** What the answer did to the diagnosis. */
  readonly outcome: RepairQuestionOutcome;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

/** The three groups of §11.2, in the order they are drawn. */
export interface RepairQuestionGroups {
  /** Tagged `OWNER`, or unanswered. Pinned, always open. */
  readonly needsYou: readonly RepairQuestion[];
  /** The answer was not what was assumed. Open. */
  readonly changed: readonly RepairQuestion[];
  /** The assumption held. Collapsed, count only. */
  readonly confirmed: readonly RepairQuestion[];
}

/**
 * Every question, in exactly one group, in the order it was recorded.
 *
 * A PARTITION, AND THE TESTS ASSERT IT AS ONE. Nothing is dropped and nothing is
 * counted twice: the sum of the three lengths is the input's length, and that is
 * checked rather than claimed, because a grouping function that silently swallows a
 * row would make the owner's queue short by one with every count on screen still
 * internally consistent.
 *
 * THE PRECEDENCE IS THE POINT — see the file header. `source` decides first,
 * `outcome` decides second, and the switch below is deliberately written in that
 * order rather than as one switch on `outcome` with an `OWNER` special case bolted
 * on, so that the reason survives the next edit.
 *
 * ORDER WITHIN A GROUP IS THE RECORD'S ORDER. No sort: §11.2 rejects chronology as
 * the ORGANISING principle, not as a tiebreak, and any comparator here would
 * silently reorder rows whose keys tie.
 */
export function groupRepairQuestions(
  questions: readonly RepairQuestion[],
): RepairQuestionGroups {
  const needsYou: RepairQuestion[] = [];
  const changed: RepairQuestion[] = [];
  const confirmed: RepairQuestion[] = [];

  for (const question of questions) {
    // First cut: the lane could not answer it from any of the four evidence
    // sources. §10.3 — this is the owner's queue and the email's second half, and
    // no outcome the writer chose may move it out.
    if (question.source === "OWNER") {
      needsYou.push(question);
      continue;
    }
    // Second cut: nobody answered it. `CONFIRMED` would assert that an assumption
    // held, and there is no answer to hold it up.
    if (question.outcome === "UNANSWERED") {
      needsYou.push(question);
      continue;
    }
    if (question.outcome === "CHANGED_DIAGNOSIS") {
      changed.push(question);
      continue;
    }
    confirmed.push(question);
  }

  return { needsYou, changed, confirmed };
}

/**
 * §11.3's second metric, as a boolean the panel renders and a test can call.
 *
 * TRUE MEANS THE ASKER RETURNED NOTHING THIS ROUND: questions were asked, every one
 * of them confirmed what was already assumed, none changed the diagnosis and none
 * came back to the owner. §11.3 is explicit about what that reading is for — "the
 * honest response is to delete the step rather than keep paying for it" — so this
 * is a load-bearing negative, not a nag.
 *
 * FALSE ON AN EMPTY SET, and that is not the same fact. A lane that asked nothing
 * has not shown that asking is worthless; it has shown that the asker never ran.
 * The panel says that in its own sentence instead — see {@link RepairQuestionsPanel}.
 */
export function askerEarnedNothing(groups: RepairQuestionGroups): boolean {
  return (
    groups.confirmed.length > 0 &&
    groups.changed.length === 0 &&
    groups.needsYou.length === 0
  );
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/**
 * The asker, said once. See the header: the record has no per-row asker field and
 * §10.5 makes Codex the asker of the whole corpus, so this is the honest place for
 * it and the line that becomes per-row if that ever stops being true.
 */
const ASKED_BY = "Asked by Codex before the diagnosis was written.";

/**
 * What each source tag means, on the tag's own tooltip. §10.3's table in the
 * reader's language rather than in the design doc's.
 *
 * `OWNER` IS PHRASED AS AN ABSENCE, because that is what it is: not a fifth kind of
 * evidence, but the state of having none of the other four.
 */
const SOURCE_MEANING: Readonly<Record<RepairQuestionSource, string>> = {
  CODE: "Answered from the code itself — the citation is a file and a line.",
  DATA: "Answered from the recorded runs — the citation is the query that was run.",
  EXPERIMENT: "Answered by running something — the citation is what came back.",
  CODEX: "Answered by an independent read from the other model, not from this one's own assumptions.",
  OWNER:
    "Nothing in the code, the recorded runs, an experiment or the other model could answer this. It needs you.",
};

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/**
 * Nothing to show: absent, or present and empty.
 *
 * `null` IS ONE OF THE CASES, not a defensive extra. The server distinguishes
 * "there is no answer" (`null`, what an OWNER row carries) from "the answer is
 * an empty string" (a defect in the answerer). The panel renders both the same
 * way — as an absence — but it must not CRASH on the first one, which is what
 * `value.trim()` did while the mirror claimed the field was always a string.
 */
function blank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/**
 * The answer line, and the two different silences it has to tell apart.
 *
 * A row with no answer is not one fact. An `OWNER` row with no answer is the system
 * working as designed — §10.3 says an `OWNER` question is precisely one no evidence
 * source can settle, so there is nothing missing and the row is a handover. A
 * `CODE`/`DATA`/`EXPERIMENT`/`CODEX` row with no answer is the opposite: the lane
 * named an evidence source, which under §10.3 is the promise that makes the
 * question legitimate, and then never produced what it promised.
 *
 * PRINTING ONE SENTENCE FOR BOTH IS THE CONFLATION THIS CODEBASE REFUSES ELSEWHERE
 * (`heldOutPass: null` is not `false`; `inspector.tsx:198-205` gives three empty
 * timelines three sentences). So each gets its own, and the second one is written
 * to read as a defect, because it is one.
 *
 * "THIS REPAIR", NEVER "THE LANE", and that is a copy rule rather than a
 * preference. "Lane" is this project's internal word for the machinery; the empty
 * state a few lines below says "this repair" for the same subject, and one referent
 * with two names in one panel is what `rail.tsx`'s copy note and
 * `panel-copy.browser.spec.ts` exist to stop. Nothing mechanically checks THIS
 * file — that spec scans the rail's panels, not the canvas nodes — so it is written
 * down here instead.
 */
function answerLine(question: RepairQuestion): { text: string; missing: boolean } {
  // `?? ""` IS UNREACHABLE, AND KEPT ONLY TO SATISFY THE NARROWING. `blank`
  // returns true for null, so a null answer never gets here — but TypeScript
  // cannot see through the helper, and an assertion would be a lie the compiler
  // could not check.
  if (!blank(question.answer)) return { text: question.answer ?? "", missing: false };
  if (question.source === "OWNER") {
    return { text: "No answer — this one is yours.", missing: true };
  }
  return {
    text: `Not answered, although this repair named ${question.source} as the source it would answer from.`,
    missing: true,
  };
}

/**
 * The source tag: a fixed-width monospace column, so the tags form a ruler down the
 * left rather than a ragged edge. Same device as `inspector.tsx`'s `StepTime`, and
 * the width is set for `EXPERIMENT`, the longest member of the union.
 *
 * ONLY `OWNER` TAKES A COLOUR. Five tinted tags would spend five hues on an axis
 * that is not the panel's subject and would compete with the grouping, which IS.
 */
function SourceTag({ source }: { source: RepairQuestionSource }): ReactNode {
  return (
    <span
      title={SOURCE_MEANING[source]}
      data-source={source}
      className={cx(
        "w-[76px] shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em]",
        source === "OWNER" ? "text-warn" : "text-ink-faint",
      )}
    >
      {source}
    </span>
  );
}

/**
 * One question: source tag, question, answer, citation.
 *
 * THE UNCITED ANSWER IS MARKED RATHER THAN LEFT LOOKING CLEAN. §10.3's rule is that
 * an answer names its evidence before it is written — "a question you also answer
 * yourself is not a question" — so an answered row whose citation is empty is the
 * exact defect the rule exists for, and rendering nothing there would make it
 * indistinguishable from a cited row at a glance. An `OWNER` row is exempt by
 * definition: its whole content is that no source applies, so there is nothing for
 * it to cite.
 */
function QuestionRow({ question }: { question: RepairQuestion }): ReactNode {
  const answer = answerLine(question);
  const cited = !blank(question.citation);
  return (
    <li className="flex items-baseline gap-2 py-[3px]">
      <SourceTag source={question.source} />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-relaxed text-ink">{question.question}</p>
        <p
          className={cx(
            "mt-0.5 text-[11.5px] leading-relaxed",
            answer.missing ? "text-ink-faint" : "text-ink-dim",
          )}
        >
          {answer.text}
        </p>
        {cited ? (
          <code className="mt-1 inline-block max-w-full truncate rounded-sm bg-canvas px-1.5 py-[2px] font-mono text-[11px] text-ink-dim">
            {question.citation}
          </code>
        ) : (
          !answer.missing &&
          question.source !== "OWNER" && (
            /*
             * DASHED AND DIM, NOT TINTED. This is an honesty caveat, and
             * `inspector.tsx:579` already fixes what one looks like in this app —
             * a dashed `line-strong` rule in `ink-dim`, the same treatment the
             * inferred-attribution note gets and the same one the earned-nothing
             * sentence gets ten lines below. Spending `warn` here would give that
             * colour a second meaning and put a small tinted mark in competition
             * with the NEEDS YOU block, which is the one thing on this panel that
             * is allowed to shout.
             */
            <p className="mt-1 rounded-sm border border-dashed border-line-strong px-1.5 py-[2px] text-[11px] text-ink-dim">
              No citation — this answer names no evidence.
            </p>
          )
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

/** The shared group heading: a word, and the count beside it. */
function GroupHeading({
  title,
  count,
  className,
}: {
  title: string;
  count: number;
  className: string;
}): ReactNode {
  return (
    <span
      /*
       * `inline-flex` IN THE BASE, AND NO CALLER MAY ADD A SECOND DISPLAY
       * UTILITY. All three call sites want the same box — a heading that sits on
       * its own line above a `<ul>`, and inside a `<summary>` next to the ▸ — so
       * the base owns it outright. The first version put `flex` here and
       * `inline-flex` on the summary's caller, which puts two display utilities on
       * one element and makes the outcome depend on the order Tailwind emits them
       * in: it renders correctly today and breaks silently on an upgrade, with the
       * heading dropping below the marker. `ui.tsx`'s `BUTTON_SIZE` docblock
       * refuses exactly that bet for exactly that reason, and no test in this
       * package could see it — the unit suite reads the tree, never computed
       * style.
       */
      className={cx(
        "inline-flex items-baseline gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em]",
        className,
      )}
    >
      {title}
      <span className="numeric opacity-70">{count}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

/**
 * The QUESTIONS section of the repair node (§11.1), between what broke and the
 * patch.
 *
 * PROPS-DRIVEN AND PURE. It fetches nothing, holds no state, and reads no clock:
 * the repair node owns the data and this draws it. That is what lets the unit suite
 * call it as a function.
 *
 * IT KEEPS ITS HEADING WHEN THERE IS NOTHING TO SHOW, deliberately. A section that
 * disappears on an empty set leaves a reader unable to tell "this lane asked
 * nothing" from "this panel is broken", and the first of those is a finding: §10.5
 * puts an asker at the front of the loop precisely because the defects this repo
 * ships are missing questions, so a repair that asked none is worth a sentence of
 * its own.
 */
export function RepairQuestionsPanel({
  questions,
}: {
  readonly questions: readonly RepairQuestion[];
}): ReactNode {
  const groups = groupRepairQuestions(questions);
  const earnedNothing = askerEarnedNothing(groups);

  return (
    <section
      data-testid="repair-questions"
      className="border-t border-line px-3 py-2.5"
    >
      <h4 className="flex items-baseline gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        Questions
        <span className="numeric text-ink-faint/70">{questions.length}</span>
      </h4>

      {questions.length === 0 ? (
        /*
         * THE EMPTY SET IS NOT THE SAME CLAIM AS `askerEarnedNothing`, and the two
         * sentences are kept apart for that reason. This one says the step did not
         * run; that one says it ran and returned nothing.
         */
        <p
          data-testid="repair-questions-none"
          className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint"
        >
          Nothing was asked. This repair reached its diagnosis without a single
          question, so there is no reasoning here for you to check.
        </p>
      ) : (
        <>
          {/*
            * THE TWO METRICS OF §11.3, ON ONE LINE. Both are counts of THIS run;
            * the trend over runs is not this component's to draw and is not
            * implied here.
            */}
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            {ASKED_BY}{" "}
            <span className="numeric text-ink-dim">
              {groups.changed.length} changed the diagnosis
            </span>{" "}
            ·{" "}
            <span
              className={cx(
                "numeric",
                groups.needsYou.length > 0 ? "text-warn" : "text-ink-dim",
              )}
            >
              {groups.needsYou.length} need{groups.needsYou.length === 1 ? "s" : ""}{" "}
              you
            </span>
          </p>

          {/*
            * NEEDS YOU IS FIRST, TINTED, AND IS NOT A `<details>`.
            *
            * "Pinned, always open" (§11.2) is a property of the markup here rather
            * than of a default: there is no summary to click shut, so no later
            * change to a shared collapse can close the owner's queue. The warn
            * border and fill are `Notice`'s (`ui.tsx:363-370`), unmodified — this
            * is the same class of thing as an awaiting-input notice and must not
            * invent a second look for it.
            */}
          {groups.needsYou.length > 0 && (
            <div
              data-testid="repair-questions-needs-you"
              data-group="needs-you"
              className="mt-2.5 rounded-sm border border-warn/45 bg-warn-dim/60 px-2 py-1.5"
            >
              <GroupHeading
                title="needs you"
                count={groups.needsYou.length}
                className="text-warn"
              />
              <ul className="mt-1">
                {groups.needsYou.map((question, index) => (
                  <QuestionRow key={`needs-you:${String(index)}`} question={question} />
                ))}
              </ul>
            </div>
          )}

          {groups.changed.length > 0 && (
            <div
              data-testid="repair-questions-changed"
              data-group="changed"
              className="mt-2.5"
            >
              <GroupHeading
                title="changed the diagnosis"
                count={groups.changed.length}
                className="text-ink"
              />
              <ul className="mt-1">
                {groups.changed.map((question, index) => (
                  <QuestionRow key={`changed:${String(index)}`} question={question} />
                ))}
              </ul>
            </div>
          )}

          {/*
            * §11.3's self-refutation, printed. Above the confirmations rather than
            * inside them: a sentence saying "this step returned nothing" hidden
            * behind the fold it is describing would be the feature declining to
            * display its own failure.
            */}
          {earnedNothing && (
            <p
              data-testid="repair-questions-earned-nothing"
              className="mt-2.5 rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-dim"
            >
              Every question confirmed what was already assumed. Nothing changed the
              diagnosis and nothing came back to you, so this round of asking
              returned nothing.
            </p>
          )}

          {/*
            * THE BORING MAJORITY, SHUT. `<details>` and not state — see the header.
            * The count is on the summary because the count is the whole of what a
            * reader needs from this group until they want a specific one.
            */}
          {groups.confirmed.length > 0 && (
            <details
              data-testid="repair-questions-confirmed"
              data-group="confirmed"
              className="group mt-2.5 border-t border-line pt-2"
            >
              <summary className="cursor-pointer list-none text-ink-faint hover:text-ink-dim">
                <span
                  aria-hidden="true"
                  className="mr-1 inline-block w-3 transition-transform group-open:rotate-90"
                >
                  ▸
                </span>
                <GroupHeading
                  title="confirmed"
                  count={groups.confirmed.length}
                  className="text-inherit"
                />
              </summary>
              <ul className="mt-1">
                {groups.confirmed.map((question, index) => (
                  <QuestionRow key={`confirmed:${String(index)}`} question={question} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
