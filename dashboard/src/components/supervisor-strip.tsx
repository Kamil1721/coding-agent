"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage, startSupervisor, stopSupervisor } from "@/lib/api";
import { formatClock, formatDuration } from "@/lib/format";
import { useSupervisor, useSupervisorTickets } from "@/lib/hooks";
import {
  armSupervisorStrip,
  classifySupervisor,
  repairCycleSummary,
  repairSummary,
  type ArmReport,
  type SupervisorLiveness,
} from "@/lib/supervisor";
import type { CensusReading } from "@/lib/supervisor";
import type { SupervisorDefect } from "@/lib/api-types";
import type { Tone } from "@/lib/presentation";
import { Badge, Button, Dot, cx } from "./ui";

/**
 * THE STRIP THE OWNER READS WHEN HE COMES BACK AFTER EIGHT HOURS.
 *
 * ITS ONE JOB IS TELLING WORKING FROM STUCK IN UNDER FIVE SECONDS, and the
 * reason it exists is a measured failure: on 2026-08-09 this app said
 * "Writing the tests — WORKING" for 87 minutes while one manifest field was
 * rejected three times. Nothing lied; nothing had been asked.
 *
 * FOUR STATES, FOUR TONES, AND THE FOURTH IS NOT DECORATION. `running`, `idle`
 * and `stuck` are the three the owner asked for; `unreachable` is the one the
 * strip owes him when it cannot support any of the other three. Rendering a
 * kept-alive snapshot as live state is worse than saying the backend is down —
 * the preview card made the down-when-up mistake yesterday, and the inverse is
 * the one that wastes a night.
 *
 * WHY THE HEIGHT IS ~30px AND THE DETAIL IS AN OVERLAY. This mounts on every
 * route including `/runs/<id>`, whose shell is `h-dvh overflow-hidden` with the
 * canvas as a `flex-1 min-h-0` child. Every pixel this strip takes is a pixel
 * off the graph, and a detail pane that expanded IN FLOW would move the canvas
 * under the owner's cursor. So the row is one line and the detail is
 * `absolute`, which costs the canvas nothing when it is open.
 */

const LIVENESS_TONE: Readonly<Record<SupervisorLiveness, Tone>> = {
  running: "pass",
  idle: "neutral",
  stuck: "fail",
  /*
   * `blocked` SHARES `stuck`'s RED, AND THE SHARING IS THE CORRECT READ RATHER
   * THAN A SHORTAGE OF TONES. Both mean THE OWNER HAS TO ACT ON THE RUN; they
   * differ in when — `stuck` is a loop wedged now, `blocked` is a queue that
   * already ended badly. Amber was the wrong choice and the reason is written on
   * `SupervisorLiveness`: amber means THIS PAGE CANNOT SEE, and here the page sees
   * perfectly. The badge carries the word, exactly as it does for the two ambers.
   */
  blocked: "fail",
  unreachable: "warn",
  malformed: "warn",
};

/**
 * `unreachable` IS AMBER, NOT RED, AND THE DISTINCTION IS THE POINT. Red means
 * the loop is wedged and the owner has to act. Amber means this page cannot
 * see, which may be a restarting server. Two different actions, two different
 * colours, and neither of them is the green that says "carry on".
 *
 * `malformed` IS THE SAME AMBER AND A DIFFERENT WORD, WHICH IS ALSO ON PURPOSE.
 * It is a second way of not seeing, not a second kind of fault: a body this page
 * cannot read says nothing at all about the run, and painting it red would
 * announce a wedged loop over a supervisor that may be working perfectly. The
 * badge carries the word, so the two are tellable apart at the glance the strip
 * is budgeted for even though the colour is shared; the actionable half — that
 * waiting will not fix this one — is the first clause of the sentence beside it.
 */

function toneOf(liveness: SupervisorLiveness): Tone {
  return LIVENESS_TONE[liveness];
}

/**
 * THE NAME THE SERVER USES FOR THE TRAIL IT HAS NO PRODUCER FOR.
 *
 * READ FROM `probe.unsourced`, NOT HARDCODED HERE, and the difference is a real
 * failure mode rather than a preference. This component used to carry
 * `ATTEMPTS_NOT_ON_THE_WIRE = []` and would have gone on printing "the supervisor
 * does not report the authoring trail yet" for as long as nobody edited this file
 * — including the day a producer landed and the trail was arriving on every poll.
 * The wire names its own gaps; the panel reads the names.
 */
const ATTEMPTS = "attempts";

function shortSignature(signature: string): string {
  return signature.length <= 12 ? signature : `${signature.slice(0, 12)}…`;
}

/**
 * THREE ANSWERS, BECAUSE THERE ARE THREE FACTS.
 *
 * `lastDefect` is the whole record and has no producer in this build;
 * `lastDefectId` is the one piece of it that IS durable today. A cell that read
 * only the first would render a ticket carrying a recorded defect exactly like a
 * ticket that never failed, which is the absence-as-success defect in a 60px
 * column.
 */
function defectCell(
  defect: SupervisorDefect | null,
  defectId: string | null,
): string {
  if (defect !== null) return shortSignature(defect.signature);
  if (defectId !== null) return shortSignature(defectId);
  return "none";
}

function defectTitle(defect: SupervisorDefect | null, defectId: string | null): string {
  if (defect !== null) {
    return `the last defect: ${defect.signature} (${defect.failureClass})`;
  }
  if (defectId !== null) {
    return `defect record ${defectId}; the route sends the id and not the record yet`;
  }
  return "no defect record has been written";
}

/**
 * THE 60px ANSWER TO "DID THE NIGHT WORK".
 *
 * FOUR AVAILABILITIES, FOUR DIFFERENT CELLS, AND NONE OF THEM IS BLANK. A blank
 * cell reads as *fine* — that is the whole failure this census exists to remove, so
 * "no census" is a printed word rather than an empty span. The three
 * not-readable answers say WHICH kind of not-readable, because "no route" and "the
 * route sent rubbish" ask for different things from the person reading.
 *
 * `done/blocked` AND NOT A PERCENTAGE. The owner's question at 7am is a count of
 * failures, and a percentage over two tickets is a number that hides the two.
 */
function censusCell(census: CensusReading): string {
  if (census.availability === "absent") return "no ticket list";
  if (census.availability === "unreachable") return "ticket list unread";
  if (census.availability === "malformed") return "ticket list unreadable";
  const counts = census.counts;
  if (counts === null || counts.total === 0) return "no tickets";
  return `${String(counts.done)} done · ${String(counts.failed)} blocked${
    counts.backlog + counts.inFlight === 0
      ? ""
      : ` · ${String(counts.backlog + counts.inFlight)} open`
  }`;
}

function Cell({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}): ReactNode {
  return (
    <span
      title={title}
      className="flex shrink-0 items-baseline gap-1 whitespace-nowrap text-[11px] text-ink-faint"
    >
      <span className="uppercase tracking-[0.07em]">{label}</span>
      <span className="font-mono text-[11px] text-ink-dim">{children}</span>
    </span>
  );
}

export function SupervisorStrip(): ReactNode {
  const { data, error, mutate } = useSupervisor();
  /*
   * THE CENSUS IS A SECOND POLL AND ITS FAILURE IS NOT THIS STRIP'S FAILURE.
   *
   * `GET /api/supervisor/tickets` has no producer in this build (measured
   * 2026-08-10), so `censusError` is a 404 on every tick today. That must not turn
   * the strip amber: the STATE route is fine, and painting a fault over a healthy
   * supervisor is the preview-card inversion this whole component was rewritten to
   * stop. `classifySupervisor` keeps the two readings separate — the census only
   * ever ADDS a verdict it can support — and the census cell says which of its four
   * answers applies.
   *
   * THE BODY IS PASSED RAW. It is typed `unknown` all the way from the hook, so
   * this component cannot dereference it even by accident; `readCensus` inside the
   * classifier is the only thing that reads it. That ordering is not a preference,
   * it is the fix for a crash: see the docblock on `SupervisorReadingInput`, where
   * the pre-parsed `attempts` input was removed for exactly this reason.
   */
  const census = useSupervisorTickets();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<null | "start" | "stop">(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /*
   * THE CLOCK IS STATE, NOT `Date.now()` READ DURING RENDER.
   *
   * `classifySupervisor` ages the reading, so a component that read the wall
   * clock inline would produce a different tree on the server and on the
   * client and would also freeze between polls — a strip that says "4s ago"
   * for a minute is the stale-reading bug wearing the fix's clothes. This ticks
   * at 1 s, which is also what makes the STALE arm reachable without a poll.
   */
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    // BOTH WRITES ARE IN CALLBACKS, and the zero-delay one is not a lint dodge:
    // `Date.now()` in the effect BODY is a synchronous setState that React
    // flags as a cascading render, and in the render body it is a hydration
    // mismatch. A macrotask after mount is the first moment a clock is both
    // legal and honest.
    const first = window.setTimeout(() => {
      setNowMs(Date.now());
    }, 0);
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  /*
   * THE START-UP ARM CHECK — §4 of the brief, and the precedent is
   * a913c871's watcher, which printed a healthy seat forever after the seat
   * died. `armSupervisorStrip` pushes four inputs with KNOWN answers through
   * the REAL classifier and requires four distinct correct answers, plus the
   * comparator in both directions. It runs at mount, while the answer is
   * known, and it says so loudly when it fails: a blind strip is worse than no
   * strip, because a blind strip is trusted.
   */
  const [arm] = useState<ArmReport>(armSupervisorStrip);
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    if (arm.armed) {
      console.info(arm.line);
    } else {
      console.error(arm.line);
    }
  }, [arm]);

  /*
   * `useSupervisor` STAMPS THE BODY IN THE FETCHER, so freshness needs no ref
   * and no effect here. With `keepPreviousData` on, a failing poll leaves the
   * last GOOD `{body, receivedAtMs}` pair in place — history with an honest
   * age on it, which is exactly what the stale arm reads.
   */
  const reading = classifySupervisor({
    snapshot: data?.body ?? null,
    /*
     * THE TRAIL IS NOT PASSED IN. `classifySupervisor` reads `attempts` off the
     * body it has just validated, which is the only safe order: handing it
     * `data.body.attempts` from here would put `.map` on an unchecked field
     * inside the function whose job is to survive an unchecked body.
     */
    error: error ?? null,
    receivedAtMs: nowMs === null ? null : (data?.receivedAtMs ?? null),
    // Before the first tick there is no clock, and `receivedAtMs: null` above
    // is what makes ARM 3 fire on the first paint instead of a green bar.
    nowMs: nowMs ?? 0,
    censusBody: census.data,
    censusError: census.error ?? null,
  });

  /*
   * `reading.snapshot` IS EITHER NULL OR FULLY VALIDATED — the classifier's own
   * invariant, and the reason this component may dereference the fields below
   * without checking each one. It is null on an unreachable route AND on a 200
   * whose body is not this contract.
   */
  const snapshot = reading.snapshot;
  const tone = toneOf(reading.liveness);
  /*
   * THE TRAIL AND ITS COMPARISON BOTH COME FROM THE READING, so the rows this
   * pane paints red and the headline the strip shows cannot disagree about which
   * attempt broke. `unsourced` is what decides between "nobody writes this yet"
   * and "this ticket has no attempts", which are opposite facts.
   */
  const attempts = snapshot?.attempts ?? [];
  const trailUnsourced = snapshot?.probe.unsourced.includes(ATTEMPTS) ?? false;
  const recurring = reading.recurringPaths;

  const run = async (which: "start" | "stop"): Promise<void> => {
    setPending(which);
    setControlError(null);
    try {
      /*
       * THE COMMAND ANSWERS WITH A COMMAND RESPONSE, NOT WITH STATE, so this
       * REVALIDATES rather than writing the reply into the cache. STOP returns
       * `draining` while a run is still in flight and the loop only reaches
       * `stopped` later; a strip that painted the reply as final would say
       * STOPPED over a live builder.
       */
      const result = which === "start" ? await startSupervisor() : await stopSupervisor();
      setNote(result.note);
      await mutate();
    } catch (caught) {
      setControlError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  };

  /*
   * `desired` IS NULL ON AN UNWIRED ROUTE, AND THAT IS THE SAME RULE ARM 4
   * ENFORCES ONE LAYER DOWN. With `probe.wired === false` every field the route
   * sent is a DEFAULT, `desired` included — and reading it here disabled START
   * against a supervisor that does not exist, next to a headline saying it does
   * not exist. A control greyed out by a default nobody chose is the panel
   * lying in the one place the owner can act.
   */
  const wired = snapshot !== null && snapshot.probe.wired;
  const desired = wired ? snapshot.desired : null;
  const disabledNote =
    desired === null
      ? "the supervisor has not reported a state, so this cannot be sent yet"
      : null;

  return (
    <div
      data-testid="supervisor-strip"
      data-liveness={reading.liveness}
      data-stale={reading.stale ? "true" : "false"}
      data-armed={arm.armed ? "true" : "false"}
      className="relative"
    >
      <div className="flex h-[30px] w-full items-center gap-3 overflow-hidden">
        <span
          data-testid="supervisor-liveness"
          className="flex shrink-0 items-center gap-1.5"
        >
          <Badge tone={tone}>
            <Dot tone={tone} pulse={reading.liveness === "running"} />
            <span className="font-mono uppercase tracking-[0.08em]">
              {reading.liveness}
            </span>
          </Badge>
          <span className="whitespace-nowrap text-[11.5px] text-ink">
            {reading.headline}
          </span>
        </span>

        {/*
          THE SENTENCE IS NOT IN THE ROW — owner's call, 2026-08-18: "remove the
          explanatory sentences". `reading.because` still exists and the detail
          pane renders it in full, one click away; the row carries the headline
          and the cells only. The spacer keeps the cells right-aligned where the
          sentence used to push them.
        */}
        <span className="min-w-0 flex-1" aria-hidden />

        {/*
          THE OUTCOME CELL — THE ONE THING THE ROW COULD NOT SAY.

          IT IS OUTSIDE THE `snapshot !== null` BLOCK ON PURPOSE. The census is a
          different route; it can be readable while the state route is amber, and a
          count that vanished whenever the state read failed would be a second
          surface with the state route's failure mode.

          NO `title`, AND THE OMISSION IS MEASURED RATHER THAN LAZY.
          `prose-guard.browser.spec.ts` budgets 40 words per passage and COUNTS
          `title` attributes summed across the blocks under one parent; this row
          already carries five. The census's sentence is long — it has to name which
          of four answers applies — so it belongs in the detail pane, which is a
          different parent, is reachable from a keyboard and appears on touch. A
          paragraph in a `title` here would redden a guard on every route in the app
          and would still be invisible to half the readers.
        */}
        <Cell label="outcome">
          <span data-testid="supervisor-census">{censusCell(reading.census)}</span>
        </Cell>

        {snapshot !== null && (
          <>
            {snapshot.ticket !== null && (
              <Cell label="ticket" title={snapshot.ticket.title}>
                {snapshot.ticket.ticketKey} · {String(snapshot.ticket.attemptNo)}/
                {String(snapshot.ticket.maxAttempts)}
              </Cell>
            )}
            <Cell
              label="quiet"
              title={
                snapshot.run === null
                  ? "there is no current run, so there is no clock"
                  : `time since the last event on ${snapshot.run.runId}, rate-limit frames excluded`
              }
            >
              {reading.quietForMs === null ? "nothing running" : formatDuration(reading.quietForMs)}
            </Cell>
            {/* THE SIGNATURE IF THE ROUTE HAS ONE, THE ID IF THAT IS ALL IT HAS,
                AND "none" ONLY WHEN THERE IS NEITHER. `lastDefect` has no producer
                in this build and `lastDefectId` does, so reading only the first
                would render a ticket with a recorded defect identically to one
                that never failed. */}
            <Cell
              label="problem"
              title={defectTitle(snapshot.lastDefect, snapshot.lastDefectId)}
            >
              {defectCell(snapshot.lastDefect, snapshot.lastDefectId)}
            </Cell>
            {/* ONE SENTENCE, COMPOSED IN `lib/supervisor.ts` — the wire carries no
                `summary`, and two components inventing one is how they disagree. */}
            <Cell label="repair" title={repairSummary(snapshot.lastRepair)}>
              {snapshot.lastRepair?.patchId ?? snapshot.lastPatchId ?? "none"}
            </Cell>
            {/* TWO QUEUES, TWO QUESTIONS. STOP does not touch `queuedRuns`. */}
            <Cell
              label="queue"
              title={`${String(snapshot.queueDepth)} supervisor ticket(s), ${String(
                snapshot.queuedRuns,
              )} queued run(s) — STOP does not touch the second number`}
            >
              {String(snapshot.queueDepth)}/{String(snapshot.queuedRuns)}
            </Cell>
          </>
        )}

        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            variant={desired === "running" ? "ghost" : "primary"}
            disabled={pending !== null || desired === "running"}
            onClick={() => {
              void run("start");
            }}
            title={disabledNote ?? "claim the oldest queued ticket, and keep claiming"}
            className="px-2 py-[2px] text-[11px]"
          >
            {pending === "start" ? "starting…" : "start"}
          </Button>
          <Button
            variant="default"
            disabled={pending !== null || desired === "stopped"}
            onClick={() => {
              void run("stop");
            }}
            /* DESIGN §7.5: STOP DRAINS, and the label says so because an owner
               who reads "stop" as "abort" has been told the run will die and it
               will not.

               THE SCOPE SENTENCE LIVES IN THE DETAIL PANE, NOT IN THIS `title`,
               and that is a measured constraint rather than an edit for taste:
               `prose-guard.browser.spec.ts` budgets 40 words per passage and
               COUNTS `title` attributes, summed across the blocks under one
               parent. Three controls with paragraph tooltips is how this strip
               would redden a guard on every route in the app. */
            title={disabledNote ?? "drain: stop claiming new tickets; the run in flight finishes"}
            className="px-2 py-[2px] text-[11px]"
          >
            {pending === "stop" ? "draining…" : "stop (drain)"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen((was) => !was);
            }}
            data-testid="supervisor-detail-toggle"
            title="attempts, rejections, the arm check"
            className="px-2 py-[2px] text-[11px]"
          >
            {open ? "hide" : "detail"}
          </Button>
        </span>
      </div>

      {!arm.armed && (
        <p
          data-testid="supervisor-arm-alarm"
          className="border-t border-fail/40 bg-fail-dim px-1 py-1 text-[11px] font-medium text-fail"
        >
          {arm.line}
        </p>
      )}

      {open && (
        <div
          data-testid="supervisor-detail"
          className="absolute right-0 top-full z-30 mt-1 max-h-[60vh] w-[min(680px,92vw)] overflow-auto rounded border border-line bg-surface p-3 shadow-lg"
        >
          <p data-testid="supervisor-because" className="text-[11px] leading-snug text-ink-dim">
            {reading.because}
          </p>

          {snapshot !== null && (
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-ink-faint">desired</dt>
              <dd className="font-mono text-ink-dim">
                {snapshot.desired} since {formatClock(snapshot.changedAt)} (
                {snapshot.changedBy}) — {snapshot.reason}
              </dd>
              <dt className="text-ink-faint">stop</dt>
              <dd className="text-ink-dim">
                STOP drains: it stops the loop claiming new tickets and lets the
                run in flight finish. It does not stop a run you submit from this
                page, and it never aborts one.
              </dd>
              <dt className="text-ink-faint">next action</dt>
              <dd className="text-ink-dim">
                {snapshot.nextAction}
                {snapshot.nextActionAt === null
                  ? ""
                  : ` (at ${formatClock(snapshot.nextActionAt)})`}
              </dd>
              <dt className="text-ink-faint">probe</dt>
              <dd className="font-mono text-ink-dim">
                wired={String(snapshot.probe.wired)} armed={String(snapshot.probe.armed)};{" "}
                {String(snapshot.probe.ticketsSeen)} ticket row(s),{" "}
                {String(snapshot.probe.runsSeen)} run row(s),{" "}
                {String(snapshot.probe.eventsSeen)} event(s) read — {snapshot.probe.armNote}
              </dd>
              <dt className="text-ink-faint">reading</dt>
              {/* BOTH CLOCKS, AND THE SERVER'S IS THE ONE NOTHING AGES AGAINST
                  YET. `at` is when the server composed the answer; the receipt
                  time beside it is what the stale arm measures. Printing both is
                  what lets a reader see a skew this page does not act on. */}
              <dd className="font-mono text-ink-dim">
                composed {snapshot.at}; received{" "}
                {data === undefined ? "never" : new Date(data.receivedAtMs).toISOString()}
                {reading.stale ? " (STALE: shown as history)" : ""}
              </dd>
              <dt className="text-ink-faint">last repair</dt>
              <dd className="text-ink-dim">
                {repairSummary(snapshot.lastRepair)}
                {snapshot.lastRepair === null ||
                snapshot.lastRepair.filesChanged.length === 0
                  ? ""
                  : ` (${snapshot.lastRepair.filesChanged.join(", ")})`}
              </dd>
              {/*
                ITEM C — THE REPAIR CYCLE, WHICH IS NOT THE SAME ROW AS THE LAST
                PATCH ABOVE IT. `lastRepair` describes an APPLIED patch and is null
                for three of the four outcomes `decideRepairOutcome` can produce, so
                "no patch has been applied" is true and useless for a cycle that ran,
                consulted the ruled-out ledger and refused a proposal on sight. This
                row is the only place that difference is visible, and it prints WHICH
                fields the producer did not send rather than a blank.
              */}
              <dt className="text-ink-faint">repair cycle</dt>
              <dd
                data-testid="supervisor-repair-cycle"
                data-cycle={repairCycleSummary(snapshot.lastRepairCycle).kind}
                className="text-ink-dim"
              >
                {repairCycleSummary(snapshot.lastRepairCycle).sentence}
              </dd>
            </dl>
          )}

          {/*
            ─────────────────────────────────────────────────────────────────────
            THE CENSUS BLOCK — ITEMS A AND B, AND IT IS OUTSIDE THE `snapshot`
            GUARD ABOVE FOR THE SAME REASON THE OUTCOME CELL IS.
            ─────────────────────────────────────────────────────────────────────
          */}
          <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-dim">
            ticket list — {reading.census.availability}
          </h3>
          <p
            data-testid="supervisor-census-note"
            className={cx(
              "mt-1 text-[11px] leading-snug",
              reading.census.availability === "readable" ? "text-ink-dim" : "text-warn",
            )}
          >
            {reading.census.note}
          </p>
          {reading.census.absentFields.length > 0 && (
            <p
              data-testid="supervisor-census-absent"
              className="mt-1 text-[11px] leading-snug text-warn"
            >
              {/* THE CLIENT-SIDE `probe.unsourced`. A column the route sends on no
                  row is reported as unreported — never as null, and never as a
                  zero. A count computed from a column that does not exist is the
                  absence-as-a-value defect with a number in front of it. */}
              this build&apos;s census does not carry {reading.census.absentFields.join(", ")}, so
              anything below that would come from those columns is missing rather than empty.
            </p>
          )}
          {reading.census.failedRows.length > 0 && (
            <ul data-testid="supervisor-census-failed" className="mt-1 space-y-1">
              {reading.census.failedRows.map((row) => (
                <li
                  key={row.ticketKey}
                  className="rounded-sm border border-fail/40 bg-fail-dim px-2 py-1 text-[11px]"
                >
                  <span className="font-mono text-ink-dim">
                    {row.ticketKey} · {row.state}
                    {typeof row.lastClass === "string" && row.lastClass.trim() !== ""
                      ? ` · ${row.lastClass}`
                      : ""}
                  </span>
                  {/*
                    ITEM B — `supervisor_tickets.next_action`, WHICH UNTIL NOW
                    EXISTED ONLY IN THE DATABASE.

                    NOT `SupervisorState.nextAction`: that is the SUPERVISOR's next
                    action and is rendered eleven lines up. This is the column on
                    this ticket's own row, `TEXT NOT NULL` with no default because
                    (its schema comment) a ticket that cannot say what to do next is
                    a dead end filed as a record. A blocked ticket carries
                    NO_REPAIR_DRIVER plus the sentence that says what to run by hand.
                  */}
                  <p className="mt-0.5 text-ink-dim">
                    {typeof row.nextAction === "string" && row.nextAction.trim() !== ""
                      ? row.nextAction
                      : row.nextAction === undefined
                        ? "the census does not carry next_action for this row, so the sentence that says what to run by hand is still only in supervisor_tickets.next_action."
                        : "the census carries next_action for this row and it is empty — nothing on this page can say what to run by hand."}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p
            data-testid="supervisor-census-probe"
            className="mt-1 font-mono text-[10.5px] text-ink-faint"
          >
            {reading.census.probeNote}
          </p>
          {reading.census.availability === "readable" &&
            reading.census.counts !== null &&
            reading.census.counts.unrecognised.length > 0 && (
              <p
                data-testid="supervisor-census-unrecognised"
                className="mt-1 text-[11px] leading-snug text-warn"
              >
                {/* AN UNKNOWN STATE IS COUNTED NOWHERE AND BLOCKS EVERY VERDICT. The
                    server types `state` as a string so a ninth state cannot break
                    this client — which means a ninth state will arrive, and folding
                    it into `done` would report a finished queue built out of a word
                    this build cannot read. */}
                {reading.census.counts.unrecognised.join(", ")} — this build does not recognise
                these ticket states, so they are counted in no bucket and no
                finished/blocked verdict is claimed while they are present.
              </p>
            )}

          <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-dim">
            authoring attempts — {reading.progress}
            {reading.escalatesAtAttempt === null
              ? ""
              : `, stopped shrinking at attempt ${String(reading.escalatesAtAttempt)}`}
          </h3>
          {/*
            THIS IS PART C, AND IT IS WHY THE 87 MINUTES WERE INVISIBLE. The
            rejections existed on the wire the whole time; nothing on any screen
            put attempt N's beside attempt N-1's, so "the same field again" was
            a thing only a post-mortem could see.
          */}
          {attempts.length === 0 ? (
            /*
              AN HONEST BLANK, NOT AN EMPTY BOX — AND TWO DIFFERENT BLANKS, WHICH
              IS THE POINT. `probe.unsourced` naming `attempts` means NOBODY WRITES
              THIS YET; an empty list that the server does source means THIS TICKET
              HAS NO ATTEMPTS. Rendering one sentence for both would say "not
              recorded" over a real converged run, or "nothing happened" over the
              three rejections that cost 87 minutes. The sentence says which.
            */
            <p data-testid="supervisor-attempts-absent" className="mt-1 text-[11px] text-warn">
              {trailUnsourced || snapshot === null
                ? `the supervisor does not report the authoring trail yet, so the
                   attempt-to-attempt comparison that catches a non-converging loop cannot
                   run on live data. The comparator is armed — see the line below.`
                : `the supervisor reports this trail and has recorded no attempt for the
                   current ticket. This is an empty list, not a missing one.`}
            </p>
          ) : (
            <ol data-testid="supervisor-attempts" className="mt-1 space-y-1">
              {attempts.map((attempt) => (
                <li
                  key={`${String(attempt.n)}-${attempt.at}`}
                  className="rounded-sm border border-line bg-surface-raised px-2 py-1 text-[11px]"
                >
                  <span className="font-mono text-ink-dim">
                    attempt {String(attempt.n)} · {formatClock(attempt.at)}
                  </span>
                  <ul className="mt-0.5 space-y-0.5">
                    {attempt.problems.length === 0 ? (
                      <li className="text-ink-faint">
                        no blocking finding was recorded for this attempt.
                      </li>
                    ) : (
                      attempt.problems.map((problem) => (
                        <li
                          key={problem}
                          className={cx(
                            "font-mono",
                            recurring.includes(problem.trim()) ? "text-fail" : "text-ink-dim",
                          )}
                        >
                          {problem}
                          {recurring.includes(problem.trim())
                            ? "  <- rejected, fixed, rejected again"
                            : ""}
                        </li>
                      ))
                    )}
                  </ul>
                </li>
              ))}
            </ol>
          )}

          {/*
            THE ARM LINE IS ALWAYS HERE, PASS OR FAIL. A report that only
            appears when it failed is a report nobody has ever seen working,
            which is how a probe gets to be blind for months.
          */}
          <p
            data-testid="supervisor-arm-line"
            className={cx(
              "mt-3 border-t border-line pt-2 font-mono text-[10.5px]",
              arm.armed ? "text-ink-faint" : "text-fail",
            )}
          >
            {arm.line}
          </p>

          {note !== null && <p className="mt-2 text-[11px] text-ink-dim">{note}</p>}
          {controlError !== null && (
            <p className="mt-2 text-[11px] text-fail">{controlError}</p>
          )}
        </div>
      )}
    </div>
  );
}
