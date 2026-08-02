"use client";

/**
 * run-hud.tsx — the one deliberate affordance the run's own facts live behind.
 *
 * THE BRIEF WAS "NOTHING AROUND THE SIDES", NOT "NOTHING". A run still has an
 * identity, a verdict and two actions that cannot wait behind a click — cancelling
 * a run that is going wrong is not a detail — so this is what stayed on screen:
 * one floating chip in the canvas's top-left corner carrying the status, a short
 * label DERIVED from the ticket (`ticketLabel`, with the ticket itself on the
 * heading's tooltip — see the block above the `h1`), the phase, the model and
 * the clock, plus Cancel and Resume when they are real, plus the button that
 * opens everything else.
 *
 * IT IS ONE OF THE FOUR THINGS ON SCREEN, AND THAT IS THE POINT. Where the
 * previous layout had five permanent panels of run-level facts, this has the
 * canvas, this chip, a legend and — only when the run is in a state that needs
 * one — a notice. `RunHeader` still exists; it is 148 lines of two-row header
 * for a page whose entire top edge is this one chip, so it is not used here.
 *
 * "44px OF CHIP" WAS THE ORIGINAL WORDING AND IT IS DELETED, not adjusted to a
 * new number. Nothing measured it — badge row plus title plus meta line plus
 * `py-2` was already well over 44px before the type scale landed, and the run
 * title going 13.5px → 24px below only widened the gap. A stated pixel height
 * for a box whose content wraps at `min(360px, 100vw-32px)` is a constant that
 * drifts silently, which is the exact failure `--run-chrome` was deleted from
 * `globals.css` for. `RunHeader` is unused because it has no importer, which is
 * a fact `grep` can check; the height was decoration on that argument.
 *
 * THE FACTS COME FROM THE SAME HELPERS `RunHeader` USES — `statusMeta`,
 * `elapsedBetween`, `formatDuration`, `phaseMeta`, and now `designLockPhase`
 * (`lib/mockups.ts`, the same import `runs/[runId]/page.tsx` and
 * `design-lock.tsx` take) — so a status that changes meaning changes in every
 * place at once. Nothing here is a second computation of anything.
 *
 * "CANCEL AND RESUME WHEN THEY ARE REAL" WAS NOT TRUE OF RESUME UNTIL
 * 2026-07-30, and the sentence above is what it was measured against. This chip
 * offered `Resume` on a `failed` run, which `Orchestrator.resume` refuses on its
 * second line (`isTerminal` → `false` → the route answers 409), and offered the
 * SAME button during a design park, where it posts no body and the server locks
 * the first mockup in manifest order "with no judgement applied" — throwing away
 * the one creative decision this tool stops to ask for. Both are gone below; see
 * the condition for exactly which states are left and why.
 */

import type { ReactNode } from "react";

import type { ModelOption, RunDetail } from "@/lib/api-types";
import { isTerminalStatus } from "@/lib/api-types";
import { elapsedBetween, formatDuration } from "@/lib/format";
import { designLockPhase } from "@/lib/mockups";
import { phaseMeta, statusMeta } from "@/lib/presentation";
import { ticketLabel, ticketTooltip } from "@/lib/ticket-title";
import { FalseFinishBadge, HeldOutBadge } from "@/components/outcome";
import { Badge, Button, Dot } from "@/components/ui";

export function RunHud({
  run,
  model,
  nowMs,
  busy,
  onCancel,
  onResume,
  onOpenDetail,
}: {
  run: RunDetail;
  model: ModelOption | null;
  nowMs: number;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
  onOpenDetail: () => void;
}): ReactNode {
  const meta = statusMeta(run.status);
  const phase = phaseMeta(run.phase);
  const elapsed = elapsedBetween(run.startedAt, run.endedAt, nowMs);
  const terminal = isTerminalStatus(run.status);

  /*
   * WHICH KIND OF `awaiting_input` THIS IS, which is the only reason `Resume`
   * below is conditional on more than the status.
   *
   * The same one line `runs/[runId]/page.tsx` runs to place its notice and its
   * panel, from the same exported helper, over the same two fields of the same
   * `run`. It is derived here rather than threaded down as a prop on purpose: a
   * prop would be a second value that can disagree with the `run` this chip is
   * already rendering, and this component would have no way to tell which was
   * right. Nothing is recomputed — `designLockPhase` is one comparison chain and
   * it lives in `lib/mockups.ts` for exactly this reason.
   */
  const lockPhase =
    run.designLock === null ? null : designLockPhase(run.status, run.designLock);

  return (
    <div className="rounded border border-line bg-surface/95 px-2.5 py-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <Badge tone={meta.tone} title={meta.meaning}>
          <Dot tone={meta.tone} pulse={meta.live} />
          {meta.label}
        </Badge>
        <HeldOutBadge heldOutPass={run.heldOutPass} />
        <FalseFinishBadge falseFinish={run.falseFinish} />

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!terminal && (
            <Button variant="danger" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          {/*
           * THE TWO STATES A BODYLESS RESUME IS ACTUALLY FOR, and both removals
           * were read out of `Orchestrator.resume` rather than reasoned about.
           *
           * `failed` IS GONE BECAUSE THE SERVER REFUSES IT EVERY TIME. `resume`
           * returns false on `isTerminal(row.status)` before it does anything
           * else, and the route turns that into 409 `not_resumable` — so the one
           * primary button on a finished run's page could only ever produce an
           * error notice. `passed` and `cancelled` were never offered; `failed`
           * was, and it is the same terminal branch. Nothing replaces it here: a
           * scored artefact is not re-run, it is re-ticketed.
           *
           * A DESIGN PARK IS SUPPRESSED BECAUSE THE BUTTON ANSWERED THE QUESTION
           * WRONG. `onResume` posts no body (`act(resumeRun)`), and a bodyless
           * resume on a park takes `ui-designer`'s `choice.json` if one was left
           * and otherwise `fallbackChoice`, which locks `manifest.refs[0]` — the
           * FIRST mockup — with the recorded reason "…the first mockup in
           * manifest order was locked automatically, with no judgement applied".
           * Either way the owner's click records a pick the owner did not make.
           * The answer to a design park is a mockup card in `DesignLockPanel`,
           * which posts `chosenMockup` and is deliberately not routed through
           * `act` for this exact reason; `AwaitingInputNotice` is already
           * suppressed on the same phase by the page, so on the run page this
           * chip held the last bodyless resume rendered during a park.
           *
           * `=== "pending"` AND NOT the page's `lockIsBlocking`: `closing` is by
           * construction a park record still open under some status OTHER than
           * `awaiting_input` — the stale-read window after the timer auto-locks,
           * and equally a run cancelled while parked — so this condition cannot
           * reach it through the `awaiting_input` arm at all. Reached through
           * `rate_limited` instead, `resume`'s design branch is gated on
           * `row.status === "awaiting_input"` and does not run, so the click is a
           * plain requeue — which is what the rate-limit path wants.
           *
           * WHAT THIS DOES NOT COVER, stated rather than implied. A park with no
           * card to click — `designLock.mockups` empty, which `DesignLockPanel`
           * already has an empty state for — now offers no button here either.
           * When that reflects an empty manifest, the button was refused anyway
           * (`fallbackChoice` returns null on empty `refs`, `#applyDesignLock`
           * returns false, the route answers 409), so nothing was lost; when it
           * instead means the refs existed and publishing them did not — the wire
           * field is the published COPIES, not the manifest — the resume would
           * have succeeded by silently locking `refs[0]`, which is the pick this
           * change exists to stop. The one shape where this removes something
           * that would have worked is a park whose workspace manifest has
           * vanished, where `resume` skips the design branch and plainly
           * requeues; that has not been observed here and no escape hatch is
           * invented for it in this chip. If one is wanted it belongs in
           * `DesignLockPanel` beside the cards, carrying its OWN reason string —
           * never the shared "no owner choice arrived before the timeout", which
           * is true of the timer and would be a lie on a click.
           */}
          {/*
           * A PLAN PARK KEEPS THE BUTTON AND GAINS A SENTENCE — 2026-08-02.
           *
           * The design park's removal above was because a bodyless resume there
           * records a pick the owner did not make. A plan park is not that: a
           * manual resume with time left closes the dialogue as a DECLINE, which
           * `Orchestrator#closePlanDialogue` says in as many words, and every
           * question still open is recorded with the assumption it would have
           * carried had the window simply closed. That is a legitimate move — it
           * is the same landing spot as the panel's "you decide all" — and it is
           * the escape hatch if the panel below cannot render.
           *
           * What it is NOT is what "Resume" sounds like, which is "carry on where
           * you left off". Nothing here can rename a shared button per phase
           * without the label wrapping in a 360px chip, so the sentence goes on
           * the tooltip and the explicitly-labelled control lives in the panel.
           */}
          {(run.status === "rate_limited" ||
            (run.status === "awaiting_input" && lockPhase !== "pending")) && (
            <Button
              variant="primary"
              onClick={onResume}
              disabled={busy}
              title={
                run.phase === "plan" && run.status === "awaiting_input"
                  ? "Stop asking and carry on. Every question still open is recorded as an assumption — the same place the run lands if the window simply closes."
                  : "Put this run back in the queue."
              }
            >
              Resume
            </Button>
          )}
          <Button
            onClick={onOpenDetail}
            title="Ticket, verdict, code, agents, environment, usage and the raw trace."
          >
            run detail
          </Button>
        </div>
      </div>

      {/*
       * THE ONE THING ON THIS SCREEN THAT GETS DISPLAY SIZE — 13.5px → 24px
       * (`text-title`, the top rung of the scale added to `globals.css`).
       *
       * WHY IT WAS WRONG. 13.5px is the size of the ticket textarea's BODY COPY
       * on the home page. The name of the run the whole canvas is drawing was
       * set in the same type as a paragraph, one step under a `Notice` heading,
       * while a token count and a duplicate-task count were the largest figures
       * anywhere in the app. Nothing about the old value said "this is what you
       * are looking at".
       *
       * `tracking-[-0.01em]` IS GONE FROM HERE AND NOT LOST: it moved onto the
       * token as `-0.015em`, tightened one notch because negative tracking wants
       * to scale with size. That is the difference between a scale step and two
       * loose font sizes — the call site names a rung, and the rung carries its
       * own line-height and tracking.
       *
       * IT TRUNCATES SOONER, AND THAT IS THE PRICE. This chip is
       * `w-[min(360px,calc(100vw-32px))]` (`runs/[runId]/page.tsx`), so the
       * content box is ~340px. Estimated rather than measured, because nothing
       * in this tree measures text: at 13.5px that is somewhere near 50
       * characters and at 24px somewhere near 30, both at an assumed ~0.5em
       * average advance. Treat those as orders of magnitude.
       *
       * `truncate` AND THE `title` TOOLTIP WERE BOTH ALREADY HERE — this change
       * makes an existing affordance load-bearing rather than introducing a new
       * failure mode. The run sheet's header renders the same `run.ticketTitle`
       * (`sheet.tsx:623`) as `truncate text-[13.5px]` in a 560px panel with no
       * `title` of its own, so it clips too — later, and silently.
       *
       * WHAT THIS DOES NOT FIX, measured and named rather than left implied:
       * `canvas/agent-node.tsx:619` still renders a collapsed duplicate-task
       * COUNT at 22px on this same canvas. 24 > 22, so the run title is now the
       * largest text on the screen — but only by 2px, and against a figure that
       * has no business being display type at all. That file is outside this
       * pass; the fix is to move it down to `text-lede`.
       */}
      {/*
       * WHAT IS RENDERED IS NO LONGER THE TICKET — 2026-07-31, and the owner's
       * words for the old behaviour were "it looks horrible".
       *
       * WHAT HE SAW. `I want you to make a copy of t…`: four words of
       * throat-clearing followed by a cut in the middle of "this". Two separate
       * character cuts can produce that — `titleFromBrief` at 80 characters on
       * the server, then CSS `truncate` at ~30 in this box — and neither of them
       * knows what a word is. `ticketLabel` (`lib/ticket-title.ts`) drops the
       * recognised opener, keeps the first clause, reduces a URL to its host and
       * cuts on WORD boundaries inside a character budget derived from this
       * chip's own width. Fed that exact string it answers `Make a copy…`; fed
       * the whole sentence it answers `Make a copy of this website…`. Which of
       * the two the database actually holds was not read back, so neither this
       * comment nor the spec claims to know.
       *
       * WHY THE INPUT IS `ticketTitle` AND NOT `ticketText`. `ticketText` is
       * longer and would survive the server's 80-character cut, and it is safe
       * to reduce — `composeBrief` puts the owner's prose FIRST, so the first
       * meaningful line of the brief is the same line `titleFromBrief` reduced,
       * uncut. It is still not used, for one reason: `RunSummary` has no
       * `ticketText` (only `RunDetail` does), so the run LIST cannot read it,
       * and the same run would carry two different names on two screens. The cut
       * only bites when the subject sits past character 80 of the first line,
       * which is a smaller loss than that.
       *
       * IT DELETES, IT DOES NOT WRITE. The label is always words the owner
       * typed, in the owner's order, plus one capital letter — no model call, no
       * paraphrase, nothing that can be wrong ABOUT the run. That is the reason
       * it is safe to put a derived string in the largest type on the page.
       *
       * THE TOOLTIP GOT BIGGER, NOT SMALLER, and that is the trade this change
       * is only acceptable with. It carried `run.ticketTitle` — the server's
       * 80-character cut. It now carries `run.ticketText`: the owner's prose,
       * plus the composed capture block when the ticket named a page to read, so
       * hovering the heading recovers strictly more than the label removed.
       * `title` is a mouse affordance and reaches neither touch nor
       * every screen reader; the copy that does is the run sheet's ticket tab,
       * which renders `run.ticketText` verbatim in a `<pre>` (`sheet.tsx:697`),
       * one click away behind "run detail".
       *
       * THE `runId` FALLBACK IS GONE ON PURPOSE. An empty `ticketTitle` used to
       * put the run id in 24px display type; `ticketLabel` answers "Untitled
       * ticket" instead, which is what the SERVER already calls a wordless
       * ticket (`titleFromBrief`). The id did not disappear — it is on the meta
       * line below, in mono, where an identifier belongs. `runs/page.tsx` still
       * does the id fallback for the same field and is outside this pass.
       */}
      <h1
        className="mt-2 truncate text-title font-semibold text-ink"
        title={ticketTooltip(run.ticketTitle, run.ticketText)}
      >
        {ticketLabel(run.ticketTitle)}
      </h1>

      {/* `mt-1` rather than `mt-0.5`: the title above it grew by 10.5px, and 2px
          of gap under a 24px heading reads as a collision. */}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
        <span title={phase.blurb}>{phase.label}</span>
        <span aria-hidden="true">·</span>
        <span title={run.modelId}>{model?.label ?? run.modelId}</span>
        <span aria-hidden="true">·</span>
        <span className="numeric" title={run.endedAt === null ? "Elapsed" : "Took"}>
          {elapsed === null ? "n/a" : formatDuration(elapsed)}
        </span>
        <span aria-hidden="true">·</span>
        <span className="font-mono">{run.runId}</span>
      </p>
    </div>
  );
}
