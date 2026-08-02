"use client";

/**
 * plan-dialogue.tsx — the run has stopped to ask, and this is where it asks.
 *
 * THE OWNER'S BRIEF, IN HIS WORDS: "make sure the plan phase is easy enough to
 * understand and user can ask follow up questions, we dont want a wall of text.
 * But we also dont want the orchestrator to be left not knowing something."
 * Every decision below is one of those three sentences.
 *
 * ─── IT IS THE CHAT, NOT A FORM OVER THE CHAT ───
 *
 * Underneath, this is `POST /api/runs/:id/messages` and the `messages` table —
 * the same channel `OrchestratorChat` renders, and the Chat tab shows every row
 * this panel shows. So the rows here are drawn in that panel's language (owner
 * rows indented right with an accent tint, run rows left on a raised surface) and
 * the questions sit INLINE in the thread rather than in a separate pane. A form
 * on one screen and a transcript on another would be two features stapled
 * together, which the brief rules out by name.
 *
 * WHAT IS ADDED ON TOP IS ADDRESSING, and only addressing. The wire carries
 * `text` and `images`; the server's classifier reads the question id back out of
 * the text (`classifyOwnerReply`'s ADDRESSED rung). So every control here
 * composes a string in a form that was MEASURED against the compiled classifier —
 * see `lib/plan-dialogue.ts`, which records the run, including the composition
 * that looks obviously right and silently marks a declined question ANSWERED.
 *
 * ─── NO WALL OF TEXT, ENFORCED HERE BECAUSE THIS IS THE LAST PLACE THAT CAN ───
 *
 *   · The seat's plan is CLAMPED TO THREE LINES with an unfold. If the seat
 *     returns an essay, the owner sees the top of it and chooses. `ReasonBlock`
 *     in `design-lock.tsx` is the same device for the same reason, and it exists
 *     because an unclamped 480-character string in this dock earned the verdict
 *     "either too much text or its formated poorly causing it to be just a wall
 *     of text".
 *   · A SUPERSEDED QUESTION BLOCK IS NOT RENDERED. The server re-asks the open
 *     set after every turn, so a four-turn dialogue about three questions posts
 *     twelve question lines. They are one list, at the bottom, in their current
 *     state (`planDialogueFrom` drops the rest).
 *   · Nothing explains itself pre-emptively. "Why does this matter" is a control,
 *     not a paragraph.
 *
 * ─── OPEN VERSUS ANSWERED, AT A GLANCE, PER QUESTION ───
 *
 * The stated worst outcome on this screen is an owner who asks for clarification
 * and cannot tell whether he has now answered. Three separate signals carry it,
 * so no single one has to be noticed: an amber left spine on an open card and
 * none on a settled one, an amber `open` badge against a green `answered` one,
 * and the presence or absence of the input itself — a settled question has no box
 * to type in.
 *
 * It is also structurally true rather than styled: a clarifying turn cannot
 * consume an answer slot (the server's question-mark rung sits above its answer
 * rung), the still-open set is re-posted, and this panel reads the open set out
 * of that newest block. The card stays open because the question is open.
 */

import { Fragment, useCallback, useState, type ReactNode } from "react";

import { formatTimeOnly } from "@/lib/format";
import {
  DECLINE_ALL,
  composeAnswer,
  composeAsk,
  composeDecline,
  endsWithQuestionMark,
  planCountdown,
  type PlanDialogue,
  type PlanQuestionState,
  type PlanQuestionView,
} from "@/lib/plan-dialogue";
import type { Tone } from "@/lib/presentation";
import { Badge, Button, Panel, cx } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* Glyphs — inline SVG at the stroke weight the rest of the app uses    */
/* ------------------------------------------------------------------ */

/**
 * 1.5, like `attachment-chips.tsx` and `project/controls.tsx`. Kept inline rather
 * than pulled from an icon package: this app ships none, and adding one for two
 * 12px marks would be a new dependency and a second visual language.
 */
function CheckGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

/** The settled-without-an-answer mark. A rule, not a cross: nothing failed. */
function RuleGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 8h9" />
    </svg>
  );
}

function ClockGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The seat's plan                                                     */
/* ------------------------------------------------------------------ */

/**
 * Three lines, then an unfold — the same shape as `design-lock.tsx`'s
 * `ReasonBlock` and for the same measured reason.
 *
 * IT IS NOT LABELLED "SUMMARY" OR PARAPHRASED. This is the seat's own text,
 * verbatim, in the channel the owner reads as the run speaking. Clamping hides
 * text; rewriting it would put this panel's words in the run's mouth.
 */
function PlanBlock({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const long = lines.length > 3 || text.length > 220;

  return (
    <div className="rounded-sm border-l-2 border-line-strong bg-canvas/40 py-2 pl-2.5 pr-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        what it plans to build
      </p>
      <div
        className={cx(
          "mt-1 space-y-1 text-[12px] leading-relaxed text-ink-dim",
          // `line-clamp` needs one block to clamp, so the collapsed state is a
          // single paragraph and the split only applies once it is open.
          !open && "line-clamp-3",
        )}
      >
        {open ? (
          lines.map((line, index) => <p key={String(index)}>{line}</p>)
        ) : (
          <p>{text}</p>
        )}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          className="mt-1.5 text-[11px] text-accent underline-offset-2 hover:underline"
        >
          {open ? "fold" : `unfold (${String(lines.length)} lines)`}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long he is being waited on for, and what happens at the end of it.
 *
 * THE NUMBER IS ABSENT WHEN THE WIRE DID NOT CARRY IT, and the sentence is not.
 * The deadline is derived from the park log line's own timestamp and the minute
 * count inside it (`lib/plan-dialogue.ts`); a run whose trace has been capped
 * past that line has no number, and inventing one from a hardcoded default would
 * be wrong on any machine that set `DASHBOARD_PLAN_TIMEOUT_MIN`. The CONSEQUENCE
 * is a property of the phase, not of the clock, so it is stated either way.
 *
 * IT MUST NOT READ AS A FAILURE STATE. Expiry is a designed outcome: the run
 * proceeds and records what it assumed. So this is `info`, never `warn`, and the
 * word "deadline" is not used.
 */
function PlanClock({
  deadlineMs,
  windowMin,
  nowMs,
}: {
  deadlineMs: number | null;
  windowMin: number | null;
  nowMs: number;
}): ReactNode {
  const countdown = planCountdown(deadlineMs, nowMs);

  return (
    <div className="flex items-start gap-2 rounded-sm border border-info/25 bg-info-dim/40 px-2 py-1.5">
      <span className="mt-[1px] text-info">
        <ClockGlyph />
      </span>
      <div className="min-w-0">
        {countdown !== null && (
          <p className="text-[12px] font-medium text-info">
            {countdown.kind === "closing" ? (
              "The window has closed — it is carrying on now."
            ) : (
              <>
                <span className="numeric">
                  {countdown.minutes < 1 ? "under 1" : String(countdown.minutes)}
                </span>{" "}
                {countdown.minutes === 1 ? "minute" : "minutes"} left
                {windowMin !== null && (
                  <span className="font-normal text-ink-faint">
                    {" "}
                    of {String(windowMin)}
                  </span>
                )}
              </>
            )}
          </p>
        )}
        <p className={cx("text-[11px] leading-relaxed text-ink-dim", countdown !== null && "mt-0.5")}>
          When it closes, the run carries on and records what it assumed — not a failure. Asking
          back costs a reply, and replies are bounded too.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One question                                                        */
/* ------------------------------------------------------------------ */

interface StateBadge {
  readonly tone: Tone;
  readonly label: string;
  readonly glyph: "check" | "rule" | null;
}

/**
 * Four settled states and one open one, and none of the four is a failure.
 *
 * `declined` READS AS A DECISION because it is one: the server records the
 * question's own `ifUnanswered` against it, byte for byte what an expiry records,
 * so an owner who says "you decide" lands exactly where the run would have landed
 * anyway. Labelling that "skipped" or "unanswered" would make a legitimate move
 * look like a lapse, which the brief rules out explicitly.
 */
function badgeFor(state: PlanQuestionState): StateBadge {
  switch (state) {
    case "open":
      return { tone: "warn", label: "open", glyph: null };
    case "answered":
      return { tone: "pass", label: "answered", glyph: "check" };
    case "declined":
      return { tone: "info", label: "left to the run", glyph: "check" };
    case "assumed":
      return { tone: "neutral", label: "assumed", glyph: "rule" };
    default:
      // `settled`: no log line said how it closed. Saying "answered" here would
      // assert an outcome this display never read.
      return { tone: "neutral", label: "closed", glyph: "rule" };
  }
}

/** What the run wrote down, phrased for the state it wrote it in. */
function recordLead(state: PlanQuestionState): string {
  if (state === "answered") return "recorded";
  if (state === "declined") return "so it is assuming";
  return "assuming";
}

function QuestionCard({
  question,
  sending,
  onAnswer,
  onDecline,
  onAsk,
  awaitingUptake,
}: {
  question: PlanQuestionView;
  /** True while ANY send is in flight — every control on the panel is inert. */
  sending: boolean;
  /** Resolves TRUE when the server took it. False keeps the owner's text. */
  onAnswer: (id: string, text: string) => Promise<boolean>;
  onDecline: (id: string) => void;
  onAsk: (id: string, text: string) => Promise<boolean>;
  /** This card's reply is posted and the run has not spoken since. */
  awaitingUptake: boolean;
}): ReactNode {
  const [text, setText] = useState("");
  const badge = badgeFor(question.state);
  const open = question.state === "open";
  /*
   * THE PRIMARY BUTTON MIRRORS THE SERVER'S OWN ROUTING RULE rather than owning a
   * mode of its own. `classifyOwnerReply` puts its question-mark rung ABOVE its
   * answer rung — that single ordering is what makes asking back safe — so text
   * ending in "?" is going to be read as a question whatever this button says.
   * Saying "answer" over it would be the one place on this screen where the label
   * and the mechanism disagree, and the disagreement would cost him the answer
   * slot he thought he had used.
   */
  const asks = endsWithQuestionMark(text);
  const canSend = text.trim().length > 0 && !sending;

  /*
   * THE BOX IS CLEARED ON SUCCESS AND ON NOTHING ELSE, which is
   * `orchestrator-chat.tsx`'s rule verbatim — "Only on SUCCESS: a rejected send
   * keeps the chips" — and the first version of this file broke it. `setText("")`
   * ran synchronously beside a fire-and-forget post, so a 409 (the run left the
   * park between the paint and the click, which `PlanDriver.deliver`'s guards
   * exist for) or a dropped connection took the sentence he had just written and
   * left an error where it had been.
   */
  const submit = useCallback((): void => {
    const body = text.trim();
    if (body.length === 0 || sending) return;
    void (asks ? onAsk(question.id, body) : onAnswer(question.id, body)).then((ok) => {
      if (ok) setText("");
    });
  }, [asks, onAnswer, onAsk, question.id, sending, text]);

  return (
    <li
      /*
       * ADDRESSED IN THE DOM THE WAY IT IS ADDRESSED ON THE WIRE. `PQ-n` appears
       * in the card's heading, in its textarea's `aria-label` and inside every
       * string its buttons compose, so a text locator matches four things and a
       * browser spec asserting "PQ-1 is open" could be reading PQ-3's card. This
       * is the same `data-testid` device `agent-node.tsx` uses for the live rim.
       */
      data-testid={`plan-question-${question.id}`}
      className={cx(
        "rounded-sm border py-1.5 pl-2 pr-2",
        open
          ? "border-line-strong border-l-2 border-l-warn bg-surface-raised"
          : "border-line bg-surface-raised/40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="numeric text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {question.id}
        </span>
        <Badge tone={badge.tone} className="ml-auto">
          {badge.glyph === "check" && <CheckGlyph />}
          {badge.glyph === "rule" && <RuleGlyph />}
          {badge.label}
        </Badge>
      </div>

      <p className={cx("mt-1 text-[12.5px] leading-snug", open ? "text-ink" : "text-ink-dim")}>
        {question.text}
      </p>

      {!open && question.recorded !== null && question.recorded.length > 0 && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
          {recordLead(question.state)}:{" "}
          <span className="text-ink-dim">{question.recorded}</span>
        </p>
      )}

      {open && (
        <div className="mt-1.5 space-y-1.5">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, 2_000))}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline — the same convention the
              // chat composer uses two panels away, so it needs no label.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            aria-label={`Answer ${question.id}: ${question.text}`}
            placeholder="answer in a few words…"
            className="w-full resize-y rounded-sm border border-line bg-canvas px-2 py-1 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="primary" onClick={submit} disabled={!canSend}>
              {asks ? "ask" : "answer"}
            </Button>
            {/*
              * A FIRST-CLASS BUTTON, NOT A THING HE HAS TO TYPE, and it sits
              * beside the answer rather than under a "more" affordance. It posts
              * `you decide (PQ-n)`, which the server records as a DECLINE against
              * this question alone — the id is last because the decline phrase has
              * to come first for the classifier to see it. `lib/plan-dialogue.ts`
              * carries the measurement.
              */}
            <Button
              onClick={() => onDecline(question.id)}
              disabled={sending}
              title="Record the run's own default for this one and move on. It lands exactly where it would have landed if you had never been asked."
            >
              you decide
            </Button>
            {/*
              * WHY IT MATTERS IS A QUESTION BACK, AND IT HAS TO BE. The seat's
              * argument for interrupting him — what it will assume, and the two
              * criteria that differ — lives in `plan.json` and never reaches the
              * API, so there is nothing cached to disclose. Asking is the phase's
              * own supported move: the seat replies in this thread and the
              * question stays open, which is what the badge above will keep
              * saying.
              */}
            <button
              type="button"
              onClick={() => {
                void onAsk(question.id, "why does that matter?");
              }}
              disabled={sending}
              title="Sends the question to the run and leaves this one open. It costs a reply — the exchange is bounded by replies as well as by the clock."
              className="ml-auto text-[11px] text-ink-dim underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-40"
            >
              why does this matter?
            </button>
          </div>

          {asks && (
            <p className="text-[10.5px] leading-relaxed text-ink-faint">
              That ends in a question mark, so the run reads it as a question and answers it.{" "}
              {question.id} stays open.
            </p>
          )}

          {awaitingUptake && (
            <p className="text-[10.5px] leading-relaxed text-accent">
              Sent. It is still shown as open until the run says what it recorded.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* The thread                                                          */
/* ------------------------------------------------------------------ */

/**
 * One turn of the conversation, drawn the way `OrchestratorChat` draws one.
 *
 * THE THREE DISTINCTIONS ARE COPIED DELIBERATELY — indent, surface, label — for
 * the reason that panel gives: colour alone is not a distinction, and a reader
 * looking at a greyscale screenshot still has to see whose turn a row is. Copied
 * rather than imported because that component owns delivery state and a composer
 * this panel must not grow a second copy of.
 */
function TurnRow({ who, text, at }: { who: "run" | "you"; text: string; at: string }): ReactNode {
  const mine = who === "you";
  return (
    <li
      className={cx(
        "rounded-sm border px-2 py-1.5",
        mine ? "ml-5 border-accent/30 bg-accent/[0.06]" : "mr-5 border-line-strong bg-surface-raised",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          {mine ? "you" : "the run"}
        </span>
        <span className="numeric text-[10px] text-ink-faint">{formatTimeOnly(at)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-dim">
        {text}
      </p>
    </li>
  );
}

/* ------------------------------------------------------------------ */

export function PlanDialoguePanel({
  dialogue,
  nowMs,
  onSend,
}: {
  dialogue: PlanDialogue;
  nowMs: number;
  /** Posts one chat message. Rejects with a sentence this panel shows verbatim. */
  onSend: (text: string) => Promise<void>;
}): ReactNode {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * How many things THE RUN had said when the last reply went out.
   *
   * WHAT IT IS FOR: the POST returns 202 and the turn runs behind it — a seat
   * call, which can take tens of seconds — so between the click and the run's
   * answer the question is still open and nothing on screen would have changed.
   * A dialogue that appears to swallow a reply is this screen failing.
   *
   * IT COUNTS THE RUN'S ROWS AND NOT THE THREAD'S, which is not a detail: the
   * refetch that follows a successful send adds the OWNER's own row first, so a
   * thread-length watermark clears itself one tick after the click and the
   * waiting state is never seen. The observable is the run speaking.
   */
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const saidByRun = dialogue.items.filter(
    (item) => item.kind === "said" && item.who === "run",
  ).length;
  if (sentAt !== null && saidByRun > sentAt) {
    // The sanctioned adjust-during-render pattern, as in `DesignLockPanel`: it
    // clears in the same paint as the row that supersedes it, with no frame of
    // stale "Sent" that an effect would cost.
    setSentAt(null);
    setSentFor(null);
  }

  const post = useCallback(
    async (id: string | null, text: string, runRows: number): Promise<boolean> => {
      // THE ONE GUARD AGAINST A DOUBLE FIRE, and it is checked here rather than
      // only disabling the buttons: Enter in the textarea reaches `submit`
      // directly, and a second Enter before React has painted the disabled state
      // would post the same answer twice.
      if (sending) return false;
      setSending(true);
      setError(null);
      try {
        await onSend(text);
        setSentAt(runRows);
        setSentFor(id);
        return true;
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setSending(false);
      }
    },
    [onSend, sending],
  );

  const count = saidByRun;
  const answer = useCallback(
    (id: string, text: string) => post(id, composeAnswer(id, text), count),
    [post, count],
  );
  const ask = useCallback(
    (id: string, text: string) => post(id, composeAsk(id, text), count),
    [post, count],
  );
  const decline = useCallback(
    (id: string) => {
      void post(id, composeDecline(id), count);
    },
    [post, count],
  );
  const declineAll = useCallback((): void => {
    void post(null, DECLINE_ALL, count);
  }, [post, count]);

  const open = dialogue.questions.filter((question) => question.state === "open");
  const settled = dialogue.questions.filter((question) => question.state !== "open");

  return (
    <Panel
      title="Plan"
      subtitle={
        dialogue.parked
          ? // FIFTEEN SECONDS IS THE BUDGET, AND EVERY LINE ABOVE THE FIRST
            // QUESTION SPENDS IT. The first version of this ran to ten lines
            // before PQ-1 — subtitle, plan, and four lines of clock — which is
            // the wall of text this panel exists to refuse, written by the panel.
            "Answers go into the brief before any criterion is written."
          : "What it asked before the acceptance criteria were written."
      }
      actions={
        dialogue.parked ? (
          <Badge tone="warn">
            {String(open.length)} open
          </Badge>
        ) : (
          <Badge tone="neutral">closed</Badge>
        )
      }
      bodyClassName="p-0"
    >
      <div className="space-y-2.5 px-3 py-2.5">
        {dialogue.plan !== null && <PlanBlock text={dialogue.plan} />}

        {dialogue.parked && (
          <PlanClock
            deadlineMs={dialogue.deadlineMs}
            windowMin={dialogue.windowMin}
            nowMs={nowMs}
          />
        )}

        {/*
          * WHILE PARKED, THE OPEN QUESTIONS COME FIRST — AND THAT ORDER WAS
          * CHANGED AFTER LOOKING AT IT, not designed on paper.
          *
          * Chronological order is the honest order and it was the first version:
          * plan, clock, his last message, the seat's reply, then the questions,
          * because the seat's re-ask really is the last thing that happened. In
          * the dock, at 900px, that put every question BELOW THE FOLD — the first
          * screenshot of this panel shows the plan, the clock and his own message,
          * and not one of the things the run is stopped on. A decision behind a
          * scroll is a decision behind a click.
          *
          * So the ask is at the top and the exchange is under it, still in the
          * same panel, in the same language, with the same rows. Once the
          * dialogue is over there is nothing outstanding to hoist and the thread
          * goes back to being chronological.
          */}
        {dialogue.parked && open.length > 0 && (
          <ul className="space-y-1.5">
            {open.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                sending={sending}
                onAnswer={answer}
                onDecline={decline}
                onAsk={ask}
                awaitingUptake={sentFor === question.id}
              />
            ))}
          </ul>
        )}

        {dialogue.parked && dialogue.items.length > 0 && (
          <p className="border-t border-line pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
            the exchange so far
          </p>
        )}

        <ul className="space-y-1.5">
          {dialogue.items.map((item) =>
            item.kind === "said" ? (
              <TurnRow key={item.seq} who={item.who} text={item.text} at={item.at} />
            ) : (
              /*
               * THE QUESTIONS SIT WHERE THEY WERE ASKED, in the thread, not in a
               * panel beside it. Open ones first and then the settled ones, which
               * is the order the reader needs rather than the order they closed
               * in: what is still wanted from him is the top of the list.
               *
               * A FRAGMENT AND NOT A NESTED `<ul>`. Each card is already an
               * `<li>`, so wrapping them put a list inside a list item and every
               * question card had an ancestor list item containing all the
               * others — which reads fine and makes "the row for PQ-1" ambiguous
               * to anything walking the tree, a screen reader included.
               */
              <Fragment key={item.seq}>
                {/*
                  * THE OPEN ONES ARE ALREADY ABOVE while parked, so this slot
                  * carries the settled ones only and nothing is rendered twice.
                  * With the dialogue over there is nothing above and this is the
                  * whole list, where it was asked.
                  */}
                {(dialogue.parked ? settled : [...open, ...settled]).map((question) => (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    sending={sending}
                    onAnswer={answer}
                    onDecline={decline}
                    onAsk={ask}
                    awaitingUptake={sentFor === question.id}
                  />
                ))}
              </Fragment>
            ),
          )}
        </ul>

        {error !== null && <p className="text-[11px] text-fail">{error}</p>}

        {dialogue.parked && open.length > 1 && (
          /*
           * ONE CLICK FOR "ALL OF IT". It posts a bare `you decide`, which the
           * server's global rung takes as a decline of every currently open
           * question — the same landing spot as declining each in turn, without
           * three round trips. Shown only when there is more than one open, so it
           * never duplicates the per-question button.
           */
          <button
            type="button"
            onClick={declineAll}
            disabled={sending}
            className="text-[11px] text-ink-dim underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            you decide all {String(open.length)}
          </button>
        )}

        {dialogue.closedNote !== null && !dialogue.parked && (
          <p className="rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-[11px] leading-relaxed text-ink-dim">
            {dialogue.closedNote}
          </p>
        )}

        {/*
          * WHERE THIS SITS IN THE APP, SAID ONCE. The rows above are the run's
          * chat, not a parallel inbox, and a reader who does not know that will
          * look for the answers he gave in a second place and not find them.
          */}
        <p className="text-[10.5px] leading-relaxed text-ink-faint">
          {dialogue.parked
            ? "This is the run's chat. Anything you send here — including from the Chat tab — is read as part of this exchange, and the whole exchange goes into the brief the criteria are written from."
            : "The whole exchange was written into the brief before the acceptance criteria were authored. It is also in the Chat tab, verbatim."}
        </p>
      </div>
    </Panel>
  );
}
