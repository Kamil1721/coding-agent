"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { RunDetail } from "@/lib/api-types";
import { formatCountdown } from "@/lib/format";
import { useNow } from "@/lib/use-run-stream";
import { Explain } from "@/components/explain";
import { Button, CommandLine, MonoPath, Notice } from "@/components/ui";

/**
 * RATE LIMITED — an expected state, not an error.
 *
 * Both subscription providers enforce a 5-hour rolling window plus a weekly
 * cap. A 429 means the window has to drain; the run is persisted and both SDKs
 * support session resume. This screen is one the owner will actually read, so
 * it says what happened, when it clears, and what to do — and it does not
 * colour itself like a crash.
 */
export function RateLimitNotice({
  run,
  onResume,
  onCancel,
  busy,
}: {
  run: RunDetail;
  onResume: () => void;
  onCancel: () => void;
  busy: boolean;
}): ReactNode {
  const retryAfterSec = run.rateLimit?.retryAfterSec ?? null;
  const nowMs = useNow(1_000);

  // The API reports a DURATION, not an instant, so the countdown has to be
  // anchored to the moment that duration arrived — and re-anchored whenever a
  // fresh one does. This is the sanctioned "adjust state during render"
  // pattern; an effect would render one stale frame on every new value.
  const [anchor, setAnchor] = useState<{ key: number | null; atMs: number }>(
    () => ({ key: retryAfterSec, atMs: Date.now() }),
  );
  if (anchor.key !== retryAfterSec) {
    // `nowMs`, not `Date.now()`: reading the wall clock during render is
    // impure. The tick is 1s and the countdown can be hours, so anchoring to
    // the last tick costs nothing.
    setAnchor({ key: retryAfterSec, atMs: nowMs });
  }

  const remaining =
    retryAfterSec === null
      ? null
      : Math.max(0, retryAfterSec - (nowMs - anchor.atMs) / 1_000);

  const clear = remaining !== null && remaining <= 0;

  return (
    <Notice
      tone="warn"
      /*
       * THE FIRST PARAGRAPH IS GONE AND HALF OF IT IS BEHIND THE `Explain` —
       * 2026-08-05.
       *
       * DELETED: "This is a normal state on a subscription plan, not a failure."
       * The notice is `tone="warn"` and titled "Rate limited"; a sentence whose
       * job is to stop the reader panicking about the sentence above it is the
       * shape of prose this pass removes.
       *
       * MOVED, NOT DELETED: the refill window and "resuming does not restart".
       * That pair changes what the reader DOES — without it the move is to
       * cancel and start a fresh run, which spends the quota that is already
       * gone and throws away a run that is intact. Hidden is fine; lost is not.
       *
       * KEPT INLINE: the countdown, because it is the only thing here that says
       * WHEN to act and the reader is deciding that now.
       */
      title={
        <>
          Rate limited — the plan&rsquo;s quota is used up for{" "}
          {/* Last word and glyph bound together — `criteria.tsx` records why. */}
          <span className="whitespace-nowrap">
            now
            <Explain about="rate limits" className="ml-1" testId="explain-rate-limit">
              Quota refills on a 5-hour rolling window, with a weekly cap on top.
              Resuming continues the same session where it stopped; it does not restart
              the run.
            </Explain>
          </span>
        </>
      }
      /*
       * CANCEL LANDED HERE ON 2026-08-09, AND IT IS A CORRECTION RATHER THAN AN
       * ADDITION.
       *
       * `runs/[runId]/page.tsx` suppresses the run chip whenever any notice is
       * up, and justified it in as many words: "`AwaitingInputNotice` and
       * `RateLimitNotice` carry their own Cancel and Resume." Half of that was
       * false. This component took `{ run, onResume, busy }` and rendered one
       * button, so on a rate-limited run with the rail's panel shut the screen
       * carried NO Cancel at all — which is verbatim the defect the chip was
       * brought back to close ("a control that stops a run does not belong
       * behind two clicks"), reappearing in the one state where the run is
       * stopped and the reader is deciding what to do with it.
       *
       * THE TWO MOVES ARE THE SAME TWO `AwaitingInputNotice` OFFERS, and for the
       * same reason: a stopped run either continues or it does not. Resume stays
       * `primary` because the countdown above says when it will work; Cancel is
       * `danger` and second, because a quota that will refill on its own is not
       * a reason to throw the run away — the notice's own `Explain` says
       * resuming does not restart it. It is here for the owner who has decided
       * the run is going wrong and does not want to wait five hours to stop it.
       */
      actions={
        <>
          <Button variant="primary" onClick={onResume} disabled={busy}>
            {busy ? "Resuming…" : "Resume run"}
          </Button>
          <Button variant="danger" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <p>
        {remaining === null ? (
          <>The provider did not say how long to wait. Try again in a few minutes.</>
        ) : clear ? (
          <>
            The window should have cleared. <strong className="text-ink">Resume now.</strong>
          </>
        ) : (
          <>
            Retry after{" "}
            <strong className="numeric text-warn">{formatCountdown(remaining)}</strong>.
            Resuming earlier will just be limited again.
          </>
        )}
      </p>
    </Notice>
  );
}

/**
 * AWAITING INPUT — parked on a question, and there IS now a way to answer it.
 *
 * CORRECTED 2026-07-30. This notice used to say "this dashboard's API has no
 * channel to answer a mid-run question", which was true when it was written and
 * has been false since the chat shipped (`POST /api/runs/:id/messages`,
 * `server/src/http.ts`; the composer is `components/canvas/orchestrator-chat.tsx`).
 * A tool telling its owner that the feature it ships does not exist is the exact
 * defect class this file's other notices exist to avoid, so the copy now names
 * the click path instead.
 *
 * THE ORDER IS THE WHOLE POINT, AND IT IS EASY TO STATE BACKWARDS. A message sent
 * while the run is parked is NOT delivered: `Orchestrator.pushLiveMessage` returns
 * false when the run has no open segment, the row stays pending, and it is folded
 * into the prompt only when `resume` composes the next segment (`store.pendingMessages`
 * → `ownerMessageBlock` in `orchestrator.ts`). So it is "answer, THEN resume" —
 * never "answer OR resume", and never "resume, then answer": resuming first
 * composes the prompt without the answer in it, and the message then arrives
 * mid-flight at the agent's next step rather than at the top of its instructions.
 *
 * WHAT IT DOES NOT COVER. This renders only for a NON-design park —
 * `runs/[runId]/page.tsx` suppresses it while a design lock is pending, because
 * there the mockup cards are the channel and this text would contradict them.
 *
 * THE CLICK PATH WAS WRONG AND IS CORRECTED — 2026-08-05. It said "open the
 * run's own session card — the one under the Session heading on the canvas — and
 * the chat is at the top of the panel that opens", which described the deleted
 * tabbed sheet. The canvas no longer opens anything on a card click
 * (`runs/[runId]/page.tsx` passes `onSelect={setSelectedId}` and nothing else);
 * the composer is a RAIL panel, mounted at the run view's level and merely
 * hidden when another panel is open (`page.tsx`, `chatMounted`), so it exists
 * for any non-terminal run whether or not the canvas drew a card. The paragraph
 * that hedged against "no cards at all, nowhere to type" therefore described a
 * state that can no longer happen, and went with it.
 *
 * THE ORDER FACT IS BEHIND THE `Explain` RATHER THAN DELETED. See the block at
 * the call site: it changes the ORDER of the two things the reader is about to
 * do, which is the one category the glyph exists for.
 */
export function AwaitingInputNotice({
  onResume,
  onCancel,
  busy,
}: {
  onResume: () => void;
  onCancel: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <Notice
      tone="warn"
      /*
       * THE TITLE IS UNCHANGED, AND THAT IS A DECISION RATHER THAN AN OMISSION.
       * "Stopped — it is waiting for you" was written, screenshotted and
       * reverted: it is plainer, but "Waiting on input" carries none of the
       * banned vocabulary and is not what the owner objected to. Renaming it
       * costs three existing assertions
       * (`design-lock.browser.spec.ts:512,524`, `plan-dialogue.browser.spec.ts:250`
       * all read `getByText("Waiting on input")`, one of them `exact`) and — the
       * part that matters — it would silently VOID two more:
       * `design-lock.browser.spec.ts:465` and `plan-dialogue.browser.spec.ts:112`
       * assert this notice is ABSENT by that string, so a rename leaves them
       * green over a screen that renders it. A cosmetic title is not worth two
       * checks that can no longer go red.
       */
      title="Waiting on input"
      actions={
        <>
          <Button variant="primary" onClick={onResume} disabled={busy}>
            Resume
          </Button>
          <Button variant="danger" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      {/*
       * ONE LINE, AND IT IS THE TWO STEPS IN ORDER.
       *
       * DELETED: "The run paused for something it wanted from you and will not
       * move again on its own" — the title says stopped and waiting, and a
       * stopped run that moved on its own would not be stopped.
       *
       * DELETED: the whole third paragraph ("Resuming with nothing typed is a
       * real choice… tighten it and start a new run rather than resuming
       * repeatedly"). Both halves describe what to make of an outcome AFTER an
       * action the reader has not taken: the first is what a bare Resume means,
       * which the button already offers unconditionally, and the second is
       * advice about a NEXT run, on the screen for this one.
       *
       * MOVED BEHIND THE GLYPH: what happens to a message sent now. It is the
       * type specimen from `explain.tsx`'s docblock — knowing it changes the
       * order of two things the reader is about to do, so the paragraph may be
       * hidden and the fact may not be dropped.
       */}
      <p>
        Type your answer in the <strong className="text-ink">Chat</strong> panel, then
        press <strong className="text-ink">Resume</strong> — in that{" "}
        <span className="whitespace-nowrap">
          order.
          <Explain about="answering before you resume" className="ml-1" testId="explain-answer-order">
            A message sent to a stopped run is held, not delivered; Resume is what
            hands it over. Resume first and the next prompt is written without your
            answer.
          </Explain>
        </span>
      </p>
    </Notice>
  );
}

/**
 * FALSE FINISH — the agent declared done and the held-out gate disagreed.
 *
 * The co-primary failure metric, and the one that ships a broken app while
 * claiming success. It gets the loudest treatment on the page.
 */
export function FalseFinishNotice(): ReactNode {
  return (
    /*
     * "THE TESTS IT NEVER SAW", NOT "the held-out suite" — 2026-08-05. The word
     * `suite` is on the owner's banned list and means nothing to him; what it
     * was carrying is the ONE fact that makes this notice worth reading — the
     * tests were written before the build and kept away from the builder, so
     * failing them cannot be explained away as a test the agent wrote to suit
     * itself. That clause is spelled out rather than compressed into a term of
     * art, and it is now in the title where "the gate says otherwise" was.
     */
    <Notice
      tone="fail"
      title="SAID DONE, NOT DONE — it called the work finished. The tests it never saw disagree."
    >
      {/*
       * THE ONE SENTENCE THAT SURVIVES, AND IT IS KEPT INLINE RATHER THAN HIDDEN.
       *
       * The reader has to know the agent's own summary is unreliable BEFORE they
       * read it — and this screen is where they read it. A fact they must have
       * before acting, and cannot recover from missing, is the one category
       * `explain.tsx` reserves for staying on screen.
       *
       * DELETED: "The failing criteria are the specification of what is actually
       * missing", which restated "the criteria below are the evidence" in the
       * grader's own register, one line below it.
       */}
      <p>
        Its own account of this run is not reliable — the criteria below are the
        evidence, its summary is not.
      </p>
    </Notice>
  );
}

export function OutcomeNotice({ run }: { run: RunDetail }): ReactNode {
  if (run.falseFinish === true) return <FalseFinishNotice />;

  if (run.status === "passed" && run.heldOutPass === true) {
    return (
      /*
       * THE BODY WAS HALF A DUPLICATE OF THE PANEL BELOW IT — 2026-08-05, and
       * both halves are accounted for.
       *
       * DELETED: "The tests were written from your ticket and locked before the
       * build started, so the builder could not read them or edit them."
       * `CriteriaPanel`, three blocks down the same Result panel, carries that
       * sentence behind its own heading glyph. Two statements of one fact on one
       * scroll is the repetition the owner screenshotted.
       *
       * MOVED: where they ran. It is the strength of the claim rather than the
       * claim — it says the pass could not have come from a network fetch or
       * from the build's own history — so it is a fact worth keeping and not one
       * the reader needs before doing anything.
       */
      <Notice
        tone="pass"
        title={
          <>
            Passed the tests it was never{" "}
            {/* Last word and glyph bound together — `criteria.tsx` records why. */}
            <span className="whitespace-nowrap">
              shown
              <Explain about="how the tests were run" className="ml-1" testId="explain-held-out">
                Every one of them passed in a locked box: no network, and no sight
                of how the site was built.
              </Explain>
            </span>
          </>
        }
      />
    );
  }

  if (run.status === "failed") {
    return (
      <Notice tone="fail" title="Failed">
        {/*
         * THE FRAMING SENTENCE STAYS, and it is the part that matters most on the
         * `heldOutPass === null` branch: a run that died before the suite could
         * answer says nothing about the artefact, and an owner who reads a harness
         * fault as a verdict throws away work that was never judged.
         *
         * WHAT IT COULD NOT SAY WAS *WHY*. `failureReason` is written at five sites
         * in `orchestrator.ts` and until now reached no screen — the cause existed
         * only in the raw trace. It is appended below rather than folded into the
         * sentence because it is MACHINE TEXT: one writer passes `describeError(error)`
         * straight through (`orchestrator.ts` `#start`'s catch), and that function
         * returns `[CODE] message\nfix: remediation` for a `BakeoffError` — a
         * multi-line, bracketed error string, not a sentence written for a reader.
         * Prose styling would dress it up as one.
         */}
        {/*
          * BOTH SENTENCES REWORDED 2026-08-05, AND THE DISTINCTION BETWEEN THEM
          * IS THE WHOLE REASON THIS IS A TERNARY. `null` means the tests never
          * returned an answer at all — nothing was graded, so nothing here is a
          * statement about the work. `false` means they ran and the work did not
          * pass them. "Was never graded" and "did not pass" must not be
          * substitutable for one another in plainer words either.
          */}
        <p>
          {run.heldOutPass === null
            ? "The run ended before the acceptance tests could return an answer, so the work was never graded — this is a harness or infrastructure failure, not a judgement about what was built."
            : "The run finished and the work did not pass the acceptance tests."}
        </p>
        {/*
         * CONDITIONED ON THE FIELD, NOT ON THE BRANCH — and the cost of that is
         * visible, so it is named here.
         *
         * On the ordinary gate-failure path (`heldOutPass === false`) the server
         * currently writes the fixed string "the frozen held-out suite did not go
         * green in the sealed container", which restates the sentence directly above
         * it. That reads as a near-duplicate. It is kept anyway: suppressing it by
         * comparing the two strings would silently break the first time either is
         * reworded, and gating on `heldOutPass` would hide the cause the moment a
         * sixth writer sets a reason alongside a gate verdict. Labelled as a record
         * of what the server wrote, a restatement reads as provenance rather than
         * repetition.
         *
         * "LAST", NOT "THE": one column, five writers — see the `failureReason`
         * docblock in `lib/api-types.ts`. A run whose design lane failed and which
         * then reached the gate reports the gate's answer and nothing about the lane,
         * so this is the last cause recorded, not a history and not necessarily the
         * worst thing that happened.
         *
         * SCROLLED AND WRAPPED because the string is unbounded and provably contains
         * newlines (the `\nfix:` above), and an unwrapped `pre` inside this notice's
         * `min-w-0` column would push the whole HUD sideways.
         */}
        {run.failureReason !== null && (
          <div className="mt-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              Last recorded cause
            </div>
            <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-dim">
              {run.failureReason}
            </pre>
          </div>
        )}
      </Notice>
    );
  }

  if (run.status === "cancelled") {
    // "Partial artefacts, if any, are listed below" is DELETED: the panel below
    // lists what there is, and a line whose whole content is "look down" is the
    // caption this pass removes. "Stopped by you" stays because it is the one
    // thing the status alone does not say — that nothing failed.
    return (
      <Notice tone="neutral" title="Cancelled">
        <p>Stopped by you.</p>
      </Notice>
    );
  }

  return null;
}

/** Where the work landed. Deploy is off by default, so a local path is the normal answer. */
export function DeliveryNotice({ run }: { run: RunDetail }): ReactNode {
  if (run.artifactPath === null && run.previewUrl === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded border border-line bg-surface px-3 py-2">
      {run.artifactPath !== null && (
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Artifact
          </span>
          <MonoPath path={run.artifactPath} max={80} />
        </span>
      )}
      {run.previewUrl !== null && (
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Preview
          </span>
          <Link
            href={run.previewUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[12.5px] text-accent underline underline-offset-2"
          >
            {run.previewUrl}
          </Link>
        </span>
      )}
    </div>
  );
}

/** Shown when the API itself cannot be reached — the local-tool failure mode. */
export function ApiDownNotice({ message }: { message: string }): ReactNode {
  return (
    <Notice tone="fail" title="The dashboard API is not answering">
      <p>{message}</p>
      {/*
       * KEPT INLINE, ALL OF IT. This is the one screen in the app where nothing
       * else works: the reader cannot open a panel, hover a glyph or read a
       * criterion, because there is no data behind any of them. Recovery
       * instructions on a broken app are the definition of "needed before
       * acting, unrecoverable if missed".
       */}
      <p className="mt-1.5">
        Start the backend, then reload. If it is on another port, set{" "}
        <code className="font-mono text-[11.5px] text-ink">DASHBOARD_API_ORIGIN</code>{" "}
        and restart:
      </p>
      <p className="mt-1.5">
        <CommandLine command="DASHBOARD_API_ORIGIN=http://127.0.0.1:8787 npm run dev" />
      </p>
    </Notice>
  );
}
