"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { RunDetail } from "@/lib/api-types";
import { formatCountdown } from "@/lib/format";
import { useNow } from "@/lib/use-run-stream";
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
  busy,
}: {
  run: RunDetail;
  onResume: () => void;
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
      title="Rate limited — the provider's rolling window is exhausted"
      actions={
        <Button variant="primary" onClick={onResume} disabled={busy}>
          {busy ? "Resuming…" : "Resume run"}
        </Button>
      }
    >
      <p>
        This is a normal state on a subscription plan, not a failure. Quota refills on
        a 5-hour rolling window with a weekly cap on top. The run is preserved — the
        session resumes where it stopped, it does not restart.
      </p>
      <p className="mt-1.5">
        {remaining === null ? (
          <>
            The provider did not say how long to wait. Try resuming in a few minutes; if
            it limits again, the weekly cap is the likelier constraint.
          </>
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
 * there the mockup cards are the channel and this text would contradict them. And
 * the click path it names needs a card on the canvas to exist; a run that parked
 * before emitting its first agent has nowhere to type, which the last paragraph
 * says rather than leaving the owner hunting for a composer that has not mounted.
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
      <p>
        The run paused for something it wanted from you and will not move again on its
        own. You can answer it: open the run&rsquo;s own session card — the one under
        the <strong className="text-ink">Session</strong> heading on the canvas — and
        the chat is at the top of the panel that opens.{" "}
        <span className="text-ink-faint">
          If the canvas has no cards at all, this run parked before it emitted its
          first agent and there is nowhere to type; resume and cancel are then the only
          two moves.
        </span>
      </p>
      <p className="mt-1.5">
        Then press <strong className="text-ink">Resume</strong>, in that order. A
        message sent to a parked run is queued rather than delivered; it is read when
        Resume composes the next prompt. Resume first and that prompt is written
        without your answer — the agent carries on using its own judgement, and
        anything typed afterwards reaches it mid-step instead of up front.
      </p>
      <p className="mt-1.5 text-ink-faint">
        Resuming with nothing typed is a real choice, not a failure: it means
        &ldquo;carry on, decide it yourself&rdquo;. If it stalls here again on the same
        ticket, the brief is ambiguous — tighten it and start a new run rather than
        resuming repeatedly.
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
    <Notice tone="fail" title="FALSE FINISH — the agent said it was done. The gate says otherwise.">
      {/*
        * "THE TESTS IT NEVER SAW", NOT "the held-out suite" — 2026-08-05. The
        * word `suite` is on the owner's banned list and means nothing to him;
        * what it was carrying is the ONE fact that makes this notice worth
        * reading — the tests were written before the build and kept away from
        * the builder, so failing them cannot be explained away as a test the
        * agent wrote to suit itself. That clause is spelled out rather than
        * compressed into a term of art.
        */}
      <p>
        The build reported completion and the tests it was never shown failed in the
        sealed container. Treat the agent&rsquo;s own account of this run as
        unreliable: the per-criterion results below are the evidence, its summary is
        not.
      </p>
      <p className="mt-1.5 text-ink-faint">
        The failing criteria are the specification of what is actually missing.
      </p>
    </Notice>
  );
}

export function OutcomeNotice({ run }: { run: RunDetail }): ReactNode {
  if (run.falseFinish === true) return <FalseFinishNotice />;

  if (run.status === "passed" && run.heldOutPass === true) {
    return (
      <Notice tone="pass" title="Passed the tests it was never shown">
        <p>
          Every acceptance test passed in a sealed container with no network and no
          access to the build workspace history. The tests were written from your
          ticket and locked before the build started, so the builder could not read
          them or edit them.
        </p>
      </Notice>
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
    return (
      <Notice tone="neutral" title="Cancelled">
        <p>Stopped by you. Partial artefacts, if any, are listed below.</p>
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
      <p className="mt-1.5">
        Start the backend process, then reload. If it runs on another port, set{" "}
        <code className="font-mono text-[11.5px] text-ink">DASHBOARD_API_ORIGIN</code>{" "}
        and restart the dashboard:
      </p>
      <p className="mt-1.5">
        <CommandLine command="DASHBOARD_API_ORIGIN=http://127.0.0.1:8787 npm run dev" />
      </p>
    </Notice>
  );
}
