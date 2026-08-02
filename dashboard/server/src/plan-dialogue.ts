/**
 * plan-dialogue.ts — the plan park's LIVE half: timers, turns, and the drain.
 *
 * THE ADAPTER, NOT THE POLICY, which is the split `#gateFixLoop` already uses.
 * Every decision about what a turn MEANS lives in `plan-state.ts` (which question
 * is still open, what an owner's question does, what may be recorded) and every
 * decision about the clock lives in `plan-record.ts`. What is here is the three
 * things only a live process can do: hold a timer, notice a message arrived, and
 * call a seat.
 *
 * ─── WHY THE TURNS RUN OFF THE QUEUE ───
 *
 * The orchestrator runs ONE active run (`#active`). If every owner turn went
 * through `resume()` → `pump()` → `#execute`, an owner answering a question while
 * another run is building would wait behind a two-hour build WITH THE PARK CLOCK
 * RUNNING — the dialogue would expire because the queue was busy, and the phase
 * would fail precisely when the owner was doing the one thing it asked of him.
 *
 * So a turn runs here, while the row stays `awaiting_input`, and the run re-enters
 * `#execute` exactly once: when the dialogue is over. The cost is a seat call
 * concurrent with a builder, which is bounded by the turn cap and by the in-flight
 * guard below.
 *
 * ─── WHAT A TURN MAY WRITE, AND WHERE ───
 *
 * The seat's own sentences — its questions, its reply to a question of the
 * owner's — are `run` chat rows, on the same footing as `AgentReplyWatch`'s. The
 * HOST's sentences are not: db.ts's `ChatRole` is emphatic that "the server must
 * never write a `run` row of its own composition", because the owner reads that
 * channel as the run speaking. So everything this file wants to say ABOUT the
 * dialogue — which answer was recorded against which question, which proposal was
 * discarded and why, that the window has closed — goes on the event stream as a
 * `log`. Both surfaces are in front of the owner; only one of them claims to be
 * the run's own words.
 */

import type { RunRow } from "./db.js";
import { isTerminal } from "./db.js";
import type { ChatMessage } from "./db.js";
import type { PlanQuestion } from "./plan-question.js";
import type { PlanRecord } from "./plan-record.js";
import {
  planExpired,
  planRemainingMs,
  planTimeoutMin,
  quarantinePlanRecord,
  readPlanRecord,
  readPlanRecordOutcome,
  unaskedPlanState,
  writePlanRecord,
} from "./plan-record.js";
import type { ClassifiedReply, PlanState, PlanTurnOutcome } from "./plan-state.js";
import {
  answeredQuestions,
  applyOwnerTurn,
  classifyOwnerReply,
  closePlan,
  openQuestions,
  planIsSettled,
  planTurnsExhausted,
} from "./plan-state.js";
import type { PlanSeatReply } from "./plan-turn.js";

export type PlanLogLevel = "info" | "warn" | "error";

/**
 * Everything a turn needs that only the orchestrator can supply.
 *
 * `followUp` RETURNS `PlanSeatReply | null` AND NEVER THROWS, and that shape is
 * the point rather than an ergonomic choice. `applyOwnerTurn` takes a nullable
 * seat because a silent, unparseable or fabricating seat must cost a tidier
 * phrasing and never cost the answer: with `null` the recorded answer is the
 * owner's own words. An adapter that let a failed seat call throw would turn a
 * bad model turn into a lost answer, which is the opposite failure direction from
 * the one this phase can afford.
 */
export interface PlanDialogueHost {
  readonly env: NodeJS.ProcessEnv;
  /** `runs/<id>/results`, where `plan.json` lives. */
  resultsDir(runId: string): string;
  getRun(runId: string): RunRow | null;
  /** Owner messages this run has not taken up, oldest first. */
  pendingMessages(runId: string): readonly ChatMessage[];
  /** Stamp them consumed. Called only AFTER `plan.json` is written. */
  markDelivered(runId: string, seqs: readonly number[]): void;
  /** A `run` chat row. MODEL-PRODUCED TEXT ONLY — see the file header. */
  say(runId: string, text: string): void;
  log(runId: string, level: PlanLogLevel, text: string): void;
  /** Set `awaiting_input` and announce it. */
  markParked(runId: string): void;
  /** End the park: requeue the run so `#execute` can finish the phase. */
  resume(runId: string): void;
  /** One follow-up seat call. Returns null when the seat failed or could not be read. */
  followUp(
    runId: string,
    input: { readonly state: PlanState; readonly ownerText: string; readonly classified: ClassifiedReply },
  ): Promise<PlanSeatReply | null>;
}

export class PlanDriver {
  readonly #host: PlanDialogueHost;

  /**
   * The live half of the bound, one timer per parked run.
   *
   * IT IS THE LIVE HALF AND NOT THE BOUND, exactly as `#designLockTimers` says of
   * itself: a timer lives in a process a restart destroys, so `plan.json` carries
   * `parkedAt` and `reconcileOnBoot` re-arms this map for the REMAINDER. Neither
   * half alone bounds anything.
   */
  readonly #timers = new Map<string, NodeJS.Timeout>();

  /**
   * Runs with a turn in flight.
   *
   * TWO MESSAGES ARRIVING A SECOND APART MUST NOT RUN TWO TURNS, because both
   * would read the same `plan.json`, and the second write would erase the first
   * answer while still stamping its message delivered — an answer the owner typed
   * and the run silently dropped. The drain loop re-reads pending messages after
   * every turn, so a message that arrives during one is picked up by the same
   * loop rather than lost.
   */
  readonly #inFlight = new Set<string>();

  constructor(host: PlanDialogueHost) {
    this.#host = host;
  }

  /**
   * Park the run for an answer.
   *
   * `record.parkedAt` IS THE ORIGINAL INSTANT AND THIS FUNCTION NEVER MINTS ONE.
   * That is the one place a plausible implementation silently breaks the bound: a
   * dialogue re-parks after every owner turn, and a re-park that took `now` would
   * reset the deadline each time the owner spoke — "the clock keeps running
   * through the dialogue" would hold only on paper, and a chatty exchange would
   * park forever. The caller reads `parkedAt` back off `plan.json` and hands it
   * in; there is no default for it to fall through to.
   */
  park(runId: string, record: PlanRecord): void {
    writePlanRecord(this.#host.resultsDir(runId), {
      ...record,
      awaiting: true,
      // MINTED ONCE, LIKE `parkedAt`, AND FOR A SYMMETRICAL REASON. The opening
      // park passes no `askedAfterSeq` at all, and that absence is what says "the
      // questions have not gone out yet"; every re-park spreads the record it
      // read back, so the cut stays where the FIRST ask put it. Re-minting here
      // would silently strand the message that arrived while the previous turn's
      // seat call was in flight — the exact message `#drain`'s loop exists to
      // pick up. See {@link PlanRecord.askedAfterSeq}.
      askedAfterSeq: record.askedAfterSeq === undefined ? this.#pendingHighWater(runId) : record.askedAfterSeq,
    });
    this.#host.markParked(runId);
    this.#arm(runId, record.parkedAt);
  }

  /**
   * Re-arm after a restart, for the REMAINDER of the original window.
   *
   * TRUE MEANS "THIS RUN IS THE PLAN PHASE'S PROBLEM AND IT IS NOW RESOLVED OR
   * BOUNDED", which is what `reconcileOnBoot` needs in order to know whether to
   * look for a design lock next. Three answers, and only one of them leaves the
   * run waiting:
   *
   *   no record        false. Not a plan park — a design park and a run whose
   *                    builder died with the server both look exactly like this,
   *                    and resuming them here would restart work nobody asked to.
   *   unreadable       true, AND THE PARK IS ENDED. See {@link #resolveUnreadable}.
   *   readable         true if it is an open dialogue: expired ones resume, live
   *                    ones get their timer back for the remainder.
   */
  reconcile(runId: string): boolean {
    const results = this.#host.resultsDir(runId);
    const outcome = readPlanRecordOutcome(results);
    if (outcome.kind === "none") return false;
    if (outcome.kind === "unreadable") {
      this.#resolveUnreadable(runId, results, outcome.detail);
      return true;
    }
    const record = outcome.record;
    if (!record.awaiting || record.folded) return false;
    if (planExpired(record.parkedAt, new Date().toISOString(), planTimeoutMin(this.#host.env))) {
      this.#host.log(runId, "warn", "the plan window expired while the dashboard was down");
      this.#host.resume(runId);
      return true;
    }
    this.#arm(runId, record.parkedAt);
    return true;
  }

  /**
   * A park whose record cannot be read, ended the way an expiry ends.
   *
   * THIS IS THE ONE STATE WITH NO OTHER EXIT. The live timer died with the
   * process, `awaiting_input` has no automatic exit of its own, and the durable
   * half is exactly what is missing — so a `return false` here left the run
   * waiting for an answer to questions nothing could render, with nothing
   * reporting it. Every other unreadable path is survivable: `deliver` refuses a
   * message (it becomes a mid-run instruction), `#drain` stops (the timer still
   * fires), and `#planPhase` on re-entry finds no record and asks afresh.
   *
   * THE RUN PROCEEDS ON WHAT IT HAS, WHICH IS THE DESIGN'S OWN CHOICE ELSEWHERE:
   * the window expiring, the turn cap, a seat that could not be reached — all of
   * them proceed and record what had to be assumed. Nothing recoverable is
   * thrown away, because nothing in the record could be read in the first place;
   * what is recorded is that fact, in the words `#planPhase`'s other unasked
   * paths use.
   *
   * IT CAN ALSO FIRE FOR A DESIGN PARK whose `plan.json` was corrupted after the
   * dialogue folded, and the answer is still right: `resume()` takes the
   * design-lock branch, applies the fallback choice, and the run goes on. A
   * resolution the owner can see beats a wait nobody can end.
   */
  #resolveUnreadable(runId: string, results: string, detail: string): void {
    const at = new Date().toISOString();
    const kept = quarantinePlanRecord(results);
    const detailSentence =
      `this run's plan record could not be read (${detail}), so the dialogue could not be resumed and the ` +
      "run proceeded on the ticket alone; anything the owner had already answered is not recoverable";
    // WRITTEN BEFORE THE RESUME. `#planPhase` reads this file the moment the run
    // re-enters `#execute`; without a folded record there it would take the fresh
    // path, call the seat again and re-open a dialogue against a window that has
    // no clock left.
    writePlanRecord(results, {
      awaiting: false,
      parkedAt: at,
      folded: true,
      state: unaskedPlanState(at, detailSentence),
      askedAfterSeq: null,
    });
    this.#host.log(
      runId,
      "warn",
      `${detailSentence}${kept === null ? "" : `. The unreadable bytes are kept at ${kept}`}`,
    );
    this.#host.resume(runId);
  }

  /**
   * An owner message arrived. Returns true when this run is in a plan dialogue
   * AND is still parked in it — {@link PlanDriver.#parked}, which is the same
   * question `#drain` asks, because the two used to be asked differently.
   *
   * THE RETURN VALUE IS ABOUT THE RUN, NOT ABOUT THE TURN. The turn itself is
   * asynchronous — it makes a seat call — and the HTTP request that carried the
   * message must not wait for a model. `true` means the message will be read as
   * an answer rather than handed to a builder, which is what the route needs to
   * say, and what it tells the owner on his own run's log.
   *
   * IT IS NOT A PROMISE THAT A TURN WILL HAPPEN, and one case makes that
   * explicit: a message that arrived BEFORE the questions did is not an answer to
   * them, so `deliver` returns true (the run is parked, and the next message he
   * sends will be read) while `#drain` correctly consumes nothing.
   */
  deliver(runId: string): boolean {
    if (this.#parked(runId) === null) return false;
    void this.#drain(runId);
    return true;
  }

  /** True while a turn is running for this run. */
  busy(runId: string): boolean {
    return this.#inFlight.has(runId);
  }

  clearTimer(runId: string): void {
    const timer = this.#timers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(runId);
  }

  /** Every parked run, for `shutdown()`. */
  parkedRunIds(): readonly string[] {
    return [...this.#timers.keys()];
  }

  #arm(runId: string, parkedAt: string): void {
    const timeoutMin = planTimeoutMin(this.#host.env);
    const remaining = planRemainingMs(parkedAt, Date.now(), timeoutMin);
    this.clearTimer(runId);
    const timer = setTimeout(() => {
      this.#timers.delete(runId);
      this.#host.log(
        runId,
        "warn",
        `no answer arrived within ${String(timeoutMin)} minutes, so the run is proceeding on what it has. ` +
          "Anything still unanswered is recorded as an assumption, and a message sent from here on " +
          "cannot change what this run is graded against.",
      );
      this.#host.resume(runId);
    }, remaining);
    // A PARK MUST NEVER HOLD THE PROCESS OPEN — `#parkForDesignLock`'s argument,
    // including its second half: `unref` is not the same as cancelling, which is
    // why `shutdown()` clears the map as well.
    timer.unref();
    this.#timers.set(runId, timer);
  }

  /**
   * Consume every pending owner message, one turn each, until the dialogue ends.
   *
   * A LOOP AND NOT A SINGLE TURN because the in-flight guard would otherwise drop
   * a message that arrived while a seat call was in flight: the route has already
   * answered 202 and nothing else would ever read it.
   */
  async #drain(runId: string): Promise<void> {
    if (this.#inFlight.has(runId)) return;
    this.#inFlight.add(runId);
    try {
      for (;;) {
        const record = this.#parked(runId);
        if (record === null) return;
        const message = this.#answers(runId, record)[0];
        if (message === undefined) return;
        const carryOn = await this.#turn(runId, record, message);
        if (!carryOn) return;
      }
    } finally {
      this.#inFlight.delete(runId);
    }
  }

  /**
   * The pending messages that could be answers to the questions in front of him.
   *
   * OLDEST FIRST, AS `pendingMessages` HANDS THEM OVER, but only from the cut in
   * {@link PlanRecord.askedAfterSeq}. `[0]` alone was the defect: the oldest
   * undelivered message is often one the owner typed BEFORE the questions
   * existed, and consuming it recorded an instruction as an answer AND stamped it
   * delivered, so the builder never saw it either.
   *
   * A MESSAGE THIS SKIPS IS NOT LOST AND MUST NOT BLOCK THE LOOP — it stays
   * pending, which is exactly how a mid-run instruction reaches the next build
   * segment. That is why this filters rather than stopping at the first
   * ineligible message.
   */
  #answers(runId: string, record: PlanRecord): readonly ChatMessage[] {
    const cut = record.askedAfterSeq;
    const pending = this.#host.pendingMessages(runId);
    // `null` IS A RECORD FROM BEFORE THE CUT EXISTED — a park in flight across the
    // upgrade. It keeps the old behaviour rather than inventing a boundary.
    return cut === null || cut === undefined ? pending : pending.filter((message) => message.seq > cut);
  }

  /** The highest owner message the run has not taken up yet, or 0 for none. */
  #pendingHighWater(runId: string): number {
    let high = 0;
    for (const message of this.#host.pendingMessages(runId)) high = Math.max(high, message.seq);
    return high;
  }

  /** One owner turn. Returns false when the dialogue ended or the run moved on. */
  async #turn(runId: string, record: PlanRecord, message: ChatMessage): Promise<boolean> {
    const classified = classifyOwnerReply(
      // NO STRUCTURAL SIGNAL, BECAUSE THE WIRE HAS NONE. `POST /api/runs/:id/messages`
      // carries `text` and `images` and nothing else, so every plan answer today
      // arrives free-typed and classification falls to the ladder. `OwnerReplyInput`
      // keeps the two fields nullable for exactly this reason, and the UI agent
      // adding a per-question reply control is what turns this into `structural`.
      { text: message.text, questionId: null, intent: null },
      record.state,
    );
    const seat = await this.#host.followUp(runId, {
      state: record.state,
      ownerText: message.text,
      classified,
    });

    // RE-CHECKED AFTER THE AWAIT, and this is not belt-and-braces. `cancel()`
    // aborts `#active`, and a plan turn is not `#active` — so a cancel during a
    // seat call finishes the row TERMINAL while this function is still running.
    // Writing `plan.json` and stamping the message delivered onto a cancelled run
    // would leave a terminal run holding an open dialogue. THE SAME AUTHORITY as
    // the entry check, so the record closing mid-turn (the timer fired and
    // `#closePlanDialogue` folded it) is caught here too, not only the row moving.
    if (this.#parked(runId) === null) {
      this.#host.log(
        runId,
        "warn",
        "this run left the plan park while a turn was in flight — cancelled, or the window expired — so " +
          "the message was not taken up as an answer",
      );
      return false;
    }

    const outcome = applyOwnerTurn(record.state, {
      at: new Date().toISOString(),
      ownerText: message.text,
      classified,
      seat,
    });
    const timeoutMin = planTimeoutMin(this.#host.env);
    const closure = closureFor(outcome.state, record.parkedAt, timeoutMin);
    const next: PlanState = closure === null ? outcome.state : closePlan(outcome.state, closure, isoNow());

    // WRITTEN BEFORE THE STAMP, for the ordering `pendingMessages` already
    // documents: a crash between the two must lose the STAMP, not the answer.
    // Re-reading a turn costs a repeated turn, which is visible; losing one costs
    // the owner's sentence, which is not.
    writePlanRecord(this.#host.resultsDir(runId), { ...record, state: next, awaiting: closure === null });
    this.#refuseAttachments(runId, message);
    this.#host.markDelivered(runId, [message.seq]);
    this.#report(runId, outcome, seat);

    if (closure !== null) {
      this.clearTimer(runId);
      this.#host.log(runId, "info", `the plan dialogue is over: ${next.closed?.detail ?? closure}`);
      this.#host.resume(runId);
      return false;
    }

    // RE-PARKED ON THE ORIGINAL INSTANT. See `park`.
    this.park(runId, { ...record, state: next });
    this.#reask(runId, next);
    return true;
  }

  /**
   * The record IF this run is still in the dialogue that record describes.
   *
   * ONE AUTHORITY, ASKED THE SAME WAY EVERYWHERE, AND THE TWO HALVES DISAGREE
   * ROUTINELY. `deliver()` used to consult the RECORD and `#drain` the ROW, and
   * the window where they differ is not exotic — it is every expiry. The timer
   * fires, `resume()` requeues the run, and `plan.json` still says
   * `awaiting: true` until `#execute` re-enters and `#closePlanDialogue` writes
   * the closure. In that interval `deliver()` returned true, so `http.ts` told
   * the owner on his own run's log that his message was "taken up by the plan
   * dialogue", and `#drain` then saw a `queued` row and returned without reading
   * it. The message survives — it stays pending and reaches the builder — but the
   * sentence he was shown did not describe anything that happened.
   *
   * BOTH HALVES ARE NECESSARY AND NEITHER IS SUFFICIENT. The RECORD knows whether
   * a dialogue is open (a run parked for a MOCKUP is `awaiting_input` too, and its
   * plan record is folded); the ROW knows whether this run is still parked at all
   * (cancelled, expired, resumed by hand). Asking only one of them is how a
   * message gets accepted and never processed.
   */
  #parked(runId: string): PlanRecord | null {
    const record = readPlanRecord(this.#host.resultsDir(runId));
    if (record === null || !record.awaiting || record.folded) return null;
    const row = this.#host.getRun(runId);
    // `awaiting_input` EXCLUDES EVERY TERMINAL STATUS BY ITSELF; `isTerminal` is
    // named as well because it is the property that matters — a finished run must
    // never take another turn — and a future status is more likely to be added to
    // that list than to this comparison.
    if (row === null || isTerminal(row.status) || row.status !== "awaiting_input") return null;
    return record;
  }

  /**
   * An attachment on a plan answer is REFUSED BY NAME, never silently dropped.
   *
   * WHAT USED TO HAPPEN: `#turn` reads `message.text` and nothing else, then
   * stamps the whole row delivered. An owner who answered a question and attached
   * a second design board had that board consumed, marked as taken up, shown to
   * no seat, and mentioned nowhere. Silently accepting and discarding is the one
   * option this phase cannot take — the run would be graded against criteria
   * authored without a file the owner believed he had supplied.
   *
   * CARRYING IT IS THE RIGHT ANSWER AND IT IS NOT AVAILABLE YET. The follow-up
   * call goes through {@link PlanDialogueHost.followUp}, which carries state,
   * text and the classification; putting an owner's mid-dialogue image in front
   * of the planning seat is `plan-seat.ts` work (another fleet holds that file
   * today). When it lands, this refusal is what should be replaced.
   *
   * EMITTED BEFORE `markDelivered`, DELIBERATELY, and it is the same ordering
   * argument as `writePlanRecord`'s: a crash between the two must lose the STAMP
   * — which leaves the message pending and its images bound for the builder,
   * where `live-input.ts` really does hand image paths to the session — rather
   * than lose the notice.
   *
   * `plan-attachments-refused` IS A STABLE SLUG so the UI can match it without
   * parsing prose, exactly like the `STORED, NOT DELIVERED` line `http.ts`
   * already emits for documents.
   */
  #refuseAttachments(runId: string, message: ChatMessage): void {
    if (message.images.length === 0) return;
    this.#host.log(
      runId,
      "warn",
      `${String(message.images.length)} image(s) attached to this answer were STORED, NOT READ ` +
        "(plan-attachments-refused). The planning seat sees the run's reference images and nothing else, so " +
        "an image attached to an answer reaches no seat and cannot change the criteria; your words were " +
        "recorded against the question and the file was not. Send it again once the build starts — a " +
        "mid-run message's images ARE handed to the builder — or add it to the run's references. " +
        `Stored at: ${message.images.join(", ")}`,
    );
  }

  /**
   * What the turn did, on the LOG.
   *
   * NOT IN THE CHAT, and the distinction is db.ts's: these are the server's own
   * sentences about the dialogue. The one thing the owner reads as the run
   * speaking is the seat's reply, which is model-produced and goes out as a `run`
   * row below.
   *
   * THE ACCEPTED RESOLUTIONS ARE ECHOED BECAUSE THE ARBITER'S RESIDUAL NEEDS
   * THEM. `applyOwnerTurn` bounds fabrication and does not eliminate
   * misattribution: on a turn that addressed PQ-2, a seat can still paraphrase
   * the owner's sentence into something he did not mean. The mitigation is that
   * he sees what was recorded, in the surface he is already watching, while the
   * dialogue is still open.
   */
  #report(runId: string, outcome: PlanTurnOutcome, seat: PlanSeatReply | null): void {
    for (const accepted of outcome.accepted) {
      this.#host.log(
        runId,
        "info",
        `recorded against ${accepted.id} (${accepted.status}, ${accepted.attribution}): ${accepted.recorded}`,
      );
    }
    for (const rejected of outcome.rejected) {
      this.#host.log(runId, "warn", `${rejected.id} is still open — ${rejected.detail}`);
    }
    const reply = seat?.reply ?? "";
    if (reply.trim().length > 0) this.#host.say(runId, reply);
  }

  /** Put the still-open questions back in front of the owner, in rank order. */
  #reask(runId: string, state: PlanState): void {
    const open = openQuestions(state);
    if (open.length === 0) return;
    this.#host.say(runId, questionText(open));
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * The questions, as the owner reads them.
 *
 * THE `PQ-n` PREFIX IS ADDRESSING AND IT IS NOT DECORATION. It is what lets him
 * answer three questions in one message and have each land on the right one, and
 * that claim stood here for a while over an implementation that did not do it:
 * `classifyOwnerReply`'s `addressed` rung read the ids out and marked all three
 * questions answered, but `stripQuestionIds` removes only the LEADING run of
 * ids, so every one of them recorded the WHOLE message. Measured, before the fix
 * — "PQ-1 six cards. PQ-2 no, a mailto link. PQ-3 yes, the wordmark" gave all
 * three questions the identical string "six cards. PQ-2 no, a mailto link. PQ-3
 * yes, the wordmark". `answerSpans` (plan-state.ts) is what makes the sentence
 * above true; there is a test that drives exactly that message.
 *
 * WITHOUT THE IDS a multi-question turn falls to the inferred rung, which is the
 * one that can be wrong.
 */
export function questionText(questions: readonly PlanQuestion[]): string {
  return questions.map((question) => `${question.id}: ${question.text}`).join("\n");
}

/**
 * Why this dialogue should stop now, or `null` to keep going.
 *
 * ORDERED, AND THE ORDER IS THE HONESTY OF `assumptions.md`. A settled dialogue
 * is reported as settled even if the window happened to lapse in the same turn,
 * because nothing was left to expire; a dialogue with questions still open is
 * reported as expired rather than answered, because something was.
 *
 * `declined` IS RESERVED FOR A SETTLED DIALOGUE WITH NO ANSWER IN IT — the owner
 * left every question to the dashboard. It is not a failure and it is not an
 * error; `closureDetail` says so in the words the fold carries into the brief.
 */
export function closureFor(
  state: PlanState,
  parkedAt: string,
  timeoutMin: number,
  now: string = isoNow(),
): "answered" | "declined" | "turn cap" | "window expired" | null {
  if (planIsSettled(state)) return answeredQuestions(state).length > 0 ? "answered" : "declined";
  if (planExpired(parkedAt, now, timeoutMin)) return "window expired";
  if (planTurnsExhausted(state)) return "turn cap";
  return null;
}
