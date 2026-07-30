"use client";

/**
 * run-hud.tsx — the one deliberate affordance the run's own facts live behind.
 *
 * THE BRIEF WAS "NOTHING AROUND THE SIDES", NOT "NOTHING". A run still has an
 * identity, a verdict and two actions that cannot wait behind a click — cancelling
 * a run that is going wrong is not a detail — so this is what stayed on screen:
 * one floating chip in the canvas's top-left corner carrying the status, the
 * ticket's title, the phase, the model and the clock, plus Cancel and Resume when
 * they are real, plus the button that opens everything else.
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
          {(run.status === "rate_limited" ||
            (run.status === "awaiting_input" && lockPhase !== "pending")) && (
            <Button variant="primary" onClick={onResume} disabled={busy}>
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
       * failure mode. THE TOOLTIP IS THE ONLY PLACE THE WHOLE STRING IS, and
       * that is worth stating because the obvious second answer is wrong: the
       * run sheet's header renders the same `run.ticketTitle` (`sheet.tsx:287`)
       * but it is `truncate text-[13.5px]` in a 560px panel with no `title` of
       * its own, so it clips too — later, and silently. A long ticket title has
       * no fully-rendered home on this screen and did not have one before.
       *
       * WHAT THIS DOES NOT FIX, measured and named rather than left implied:
       * `canvas/agent-node.tsx:619` still renders a collapsed duplicate-task
       * COUNT at 22px on this same canvas. 24 > 22, so the run title is now the
       * largest text on the screen — but only by 2px, and against a figure that
       * has no business being display type at all. That file is outside this
       * pass; the fix is to move it down to `text-lede`.
       */}
      <h1
        className="mt-2 truncate text-title font-semibold text-ink"
        title={run.ticketTitle}
      >
        {run.ticketTitle === "" ? run.runId : run.ticketTitle}
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
