/**
 * plan-dialogue.test.ts — the four ways the driver can lose an owner's message,
 * and the one way it can lose a run.
 *
 * WHY THIS FILE EXISTS AT ALL. `plan-phase.test.ts` drives the whole
 * orchestrator and proves the phase parks, expires, folds and resumes. It cannot
 * reach any of the cases below, because each one needs the RECORD and the ROW to
 * disagree, or a message to exist before the park, or an attachment on an answer
 * — three states an integration test would have to fake anyway. So the seam here
 * is `PlanDialogueHost`, which is the driver's whole contract with the
 * orchestrator, and the store underneath it is REAL: seq numbering, delivery
 * stamps and `pendingMessages`'s filter are the mechanisms under test, and a
 * fake store would let me define them to be whatever the assertions wanted.
 *
 * ─── THE MUTATION WATCHED FOR EACH TEST, IN `plan-dialogue.ts` ───
 *
 *   one authority        — restore `deliver`'s own `readPlanRecord` guard (record
 *                          only) while `#drain` keeps `#parked`. RED: the route
 *                          tells the owner his message was "taken up by the plan
 *                          dialogue" and nothing ever reads it.
 *   after the questions  — `#answers` returns `pendingMessages(runId)` unfiltered.
 *                          RED: the instruction he sent before the questions
 *                          existed is recorded as the answer to PQ-1 and stamped
 *                          delivered, so the builder never sees it either.
 *   the cut is minted once — make `park` always take `#pendingHighWater(runId)`.
 *                          RED, "timed out waiting for the second answer": the
 *                          message that arrived while the first turn's seat call
 *                          was in flight falls below the new cut and is never
 *                          read. THE FIRST VERSION OF THAT TEST DID NOT CATCH
 *                          THIS — it queued the second answer AFTER the turn
 *                          finished, by which point the first was already stamped
 *                          and the high-water mark had not moved. The mutation
 *                          was run, came back green, and the test was rewritten
 *                          around `seat.duringTurn` until it failed.
 *   attachments refused  — delete the `message.images.length > 0` branch. RED: the
 *                          design board is consumed, stamped and dropped with
 *                          nothing said.
 *   an unreadable record — restore `reconcile`'s `return false` for a record that
 *                          exists and cannot be read. RED: the run sits in
 *                          `awaiting_input` with no timer, no record and no exit.
 *
 * EVERY ASSERTION BELOW WAS WATCHED FAILING BEFORE THE FIX IT NAMES. The quoted
 * first failures are in the report that accompanied this change.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "./db.js";
import { PlanDriver } from "./plan-dialogue.js";
import type { PlanDialogueHost } from "./plan-dialogue.js";
import type { PlanQuestion } from "./plan-question.js";
import { PLAN_RECORD_FILE, readPlanRecord, writePlanRecord } from "./plan-record.js";
import type { PlanRecord } from "./plan-record.js";
import { openPlanState } from "./plan-state.js";
import type { PlanState } from "./plan-state.js";
import type { PlanSeatReply } from "./plan-turn.js";
import { ticketFromText } from "./ticket.js";

const QUESTION: PlanQuestion = {
  id: "PQ-1",
  text: "How many projects should the portfolio show?",
  ifUnanswered: "three project cards",
  criterionIfDefault: "The portfolio shows three project cards.",
  criterionIfAnswered: "The portfolio shows six project cards.",
  tier: "FUNCTIONAL",
};

function openState(): PlanState {
  return openPlanState(
    { plan: ["A portfolio with a project list."], planNote: null, asked: [QUESTION], dropped: [], proposed: 1 },
    new Date().toISOString(),
  );
}

interface Rig {
  readonly driver: PlanDriver;
  readonly store: RunStore;
  readonly results: string;
  /**
   * Every host call the driver made, in order.
   *
   * ORDER IS AN ASSERTION AND NOT A CONVENIENCE — the attachment refusal has to
   * be emitted BEFORE the delivery stamp, so that a crash between them loses the
   * stamp rather than the notice.
   */
  readonly events: string[];
  /** The owner text handed to a seat call, one entry per turn actually taken. */
  readonly seatTurns: string[];
  /**
   * What the next seat call returns, and a hook that runs INSIDE one.
   *
   * `duringTurn` IS THE ONLY WAY TO REACH THE RACE THIS DRIVER IS BUILT AROUND —
   * an owner message that arrives while a seat call is in flight. It fires once
   * and clears itself, so the turn it triggers cannot re-trigger it.
   */
  readonly seat: { reply: PlanSeatReply | null; duringTurn: (() => void) | null };
  record(): PlanRecord | null;
  cleanup(): void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "plan-driver-"));
  const results = join(dir, "results");
  mkdirSync(results, { recursive: true });
  const store = RunStore.open(join(dir, "runs.db"));
  const events: string[] = [];
  const seatTurns: string[] = [];
  const seat: { reply: PlanSeatReply | null; duringTurn: (() => void) | null } = {
    reply: null,
    duringTurn: null,
  };

  const host: PlanDialogueHost = {
    env: {},
    resultsDir: () => results,
    getRun: (runId) => store.getRun(runId),
    pendingMessages: (runId) => store.pendingMessages(runId),
    markDelivered: (runId, seqs) => {
      events.push(`delivered:${seqs.join(",")}`);
      store.markMessagesDelivered(runId, seqs);
    },
    say: (runId, text) => {
      events.push(`say:${text}`);
      store.appendMessage(runId, { role: "run", text, images: [] });
    },
    log: (_runId, level, text) => {
      events.push(`log:${level}:${text}`);
    },
    markParked: (runId) => {
      events.push("parked");
      store.updateRun(runId, { status: "awaiting_input", queuePosition: null });
    },
    resume: (runId) => {
      events.push("resume");
      store.updateRun(runId, { status: "queued" });
    },
    followUp: (_runId, input) => {
      seatTurns.push(input.ownerText);
      const hook = seat.duringTurn;
      seat.duringTurn = null;
      hook?.();
      return Promise.resolve(seat.reply);
    },
  };

  const driver = new PlanDriver(host);
  return {
    driver,
    store,
    results,
    events,
    seatTurns,
    seat,
    record: () => readPlanRecord(results),
    cleanup: () => {
      for (const runId of driver.parkedRunIds()) driver.clearTimer(runId);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(store: RunStore, runId: string): void {
  const ticket = ticketFromText("Build me a portfolio site.");
  store.createRun({
    runId,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    ticketText: ticket.brief,
    ticketSha256: ticket.sha256,
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    interactive: true,
  });
}

/** Park a run the way `#planPhase` does, then post the questions as it does. */
function parkWithQuestions(r: Rig, runId: string): void {
  r.driver.park(runId, { awaiting: true, parkedAt: new Date().toISOString(), folded: false, state: openState() });
  r.store.appendMessage(runId, { role: "run", text: `${QUESTION.id}: ${QUESTION.text}`, images: [] });
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Give the drain every chance to run.
 *
 * A NEGATIVE ASSERTION NEEDS THIS AND A POSITIVE ONE DOES NOT: "the message was
 * not consumed" is only worth anything if the loop that would have consumed it
 * has had time to. The seat here resolves immediately, so a handful of macrotask
 * turns is several orders of magnitude more than the drain needs.
 */
async function quiesce(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/* -------------------------------------------------------------------------
 * ONE AUTHORITY — the record and the row must not be asked separately
 * ---------------------------------------------------------------------- */

/**
 * `deliver()` READ THE RECORD AND `#drain` READ THE ROW, so a message could be
 * ACCEPTED as an answer by one and refused by the other. The window is not
 * exotic: it is every expiry. The timer fires, `resume()` requeues the run, and
 * `plan.json` still says `awaiting: true` until `#execute` re-enters and
 * `#closePlanDialogue` writes the closure. For that interval `deliver()` returned
 * true — and `http.ts` then tells the owner, on his own run's log, "owner message
 * taken up by the plan dialogue, before any criteria are written" — while
 * `#drain` looked at the row, saw `queued`, and returned without reading it.
 *
 * The message is not lost: it stays pending and reaches the builder. What is lost
 * is the truth of the sentence the owner is shown.
 */
test("a message arriving for a run that has LEFT the park is not accepted as an answer", async () => {
  const r = rig();
  try {
    seed(r.store, "run-gone");
    parkWithQuestions(r, "run-gone");

    // POSITIVE CONTROL FIRST, so a `false` that means "this driver never accepts
    // anything" cannot pass for the property under test.
    assert.equal(r.driver.deliver("run-gone"), true, "while it really is parked, a message IS an answer");

    // THE DISAGREEMENT: the timer has fired and requeued the run, and the record
    // has not been closed yet.
    r.store.updateRun("run-gone", { status: "queued" });
    r.driver.clearTimer("run-gone");
    assert.equal(r.record()?.awaiting, true, "the record still says parked — that is the whole point");

    const message = r.store.appendMessage("run-gone", { role: "owner", text: "six", images: [] });
    assert.equal(
      r.driver.deliver("run-gone"),
      false,
      "the run has moved on, so this is a mid-run message and the route must say so",
    );

    await quiesce();
    assert.deepEqual(r.seatTurns, [], "no turn was taken against a run that is no longer parked");
    assert.deepEqual(
      r.store.pendingMessages("run-gone").map((m) => m.seq),
      [message.seq],
      "his sentence stays pending, which is how it reaches the builder instead",
    );
    assert.equal(r.record()?.state.questions[0]?.status, "open");
  } finally {
    r.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE ANSWER IS THE MESSAGE THAT CAME AFTER THE QUESTIONS
 * ---------------------------------------------------------------------- */

/**
 * `#drain` TOOK `pendingMessages(runId)[0]` — THE OLDEST UNDELIVERED MESSAGE.
 *
 * The plan phase is the FIRST phase, and a run sits in the queue before it. An
 * owner who submits a ticket and then types "also make it dark mode" while it
 * starts has a pending message before any question exists. When the questions
 * arrive and he answers, the drain read his EARLIER sentence, handed it to the
 * seat as his answer to PQ-1, recorded it against the question and stamped it
 * delivered — which costs twice: a criterion authored from a sentence that was
 * not an answer, and an instruction the builder now never sees, because the stamp
 * is what keeps a plan answer out of the next prompt.
 */
test("a message the owner sent BEFORE the questions is not consumed as an answer to them", async () => {
  const r = rig();
  try {
    seed(r.store, "run-early");
    const early = r.store.appendMessage("run-early", {
      role: "owner",
      text: "also make it dark mode",
      images: [],
    });
    parkWithQuestions(r, "run-early");

    assert.equal(r.driver.deliver("run-early"), true, "the run IS parked, so the route is right to say so");
    await quiesce();

    assert.deepEqual(r.seatTurns, [], "there was nothing in front of him to answer when he typed that");
    assert.equal(r.record()?.state.questions[0]?.status, "open", "PQ-1 is still open");
    assert.equal(r.record()?.state.turnsUsed, 0, "and no turn was spent on it");
    assert.deepEqual(
      r.store.pendingMessages("run-early").map((m) => m.seq),
      [early.seq],
      "still pending — it is an instruction, and the builder gets it",
    );

    // POSITIVE CONTROL: the answer he types AFTER the questions IS consumed, and
    // the earlier instruction is still not.
    const answer = r.store.appendMessage("run-early", { role: "owner", text: "six", images: [] });
    assert.equal(r.driver.deliver("run-early"), true);
    await waitFor(() => r.record()?.state.questions[0]?.status === "answered", "the answer to be recorded");

    assert.deepEqual(r.seatTurns, ["six"], "exactly one turn, on the message that came after the questions");
    assert.equal(r.record()?.state.questions[0]?.answer?.text, "six");
    assert.deepEqual(
      r.store.pendingMessages("run-early").map((m) => m.seq),
      [early.seq],
      "the answer is stamped and the instruction is not",
    );
    assert.ok(answer.seq > early.seq);
  } finally {
    r.cleanup();
  }
});

/**
 * THE CUT IS MINTED ONCE AND A RE-PARK CARRIES IT, WHICH IS THE WHOLE FIX.
 *
 * A dialogue re-parks after every owner turn, and `park()` is the function that
 * writes the cut. If it re-minted on each call, the high-water mark would be
 * taken AFTER the turn that just ran — so a message the owner sent while the seat
 * call was in flight would fall below the new cut and never be read, which is the
 * exact message `#drain`'s loop exists to pick up. The turn cap and the window
 * would then end the dialogue with an answer sitting unread in the table.
 *
 * MUTATION: in `park`, replace the `askedAfterSeq === undefined` guard with an
 * unconditional `this.#pendingHighWater(runId)`. The second answer below is never
 * taken up: `seatTurns` stays at one entry and PQ-2 is still open. Watched red,
 * restored.
 */
test("a re-park does not move the cut — a message sent DURING a turn is still an answer", async () => {
  const r = rig();
  try {
    seed(r.store, "run-two-turns");
    const early = r.store.appendMessage("run-two-turns", { role: "owner", text: "also dark mode", images: [] });
    const second: PlanQuestion = { ...QUESTION, id: "PQ-2", text: "Should the contact form send email?" };
    r.driver.park("run-two-turns", {
      awaiting: true,
      parkedAt: new Date().toISOString(),
      folded: false,
      state: openPlanState(
        { plan: [], planNote: null, asked: [QUESTION, second], dropped: [], proposed: 2 },
        new Date().toISOString(),
      ),
    });
    const cut = r.record()?.askedAfterSeq;
    assert.equal(cut, early.seq, "the cut is the newest message that predates the questions");

    // THE SECOND ANSWER ARRIVES WHILE THE FIRST TURN'S SEAT CALL IS IN FLIGHT.
    // That is the only moment the re-mint is observable, and it is the moment the
    // drain loop exists for: the route has already answered, so nothing else will
    // ever come back for this message.
    r.seat.duringTurn = () => {
      r.store.appendMessage("run-two-turns", { role: "owner", text: "PQ-2 yes", images: [] });
    };
    r.store.appendMessage("run-two-turns", { role: "owner", text: "PQ-1 six", images: [] });
    assert.equal(r.driver.deliver("run-two-turns"), true);
    await waitFor(() => r.record()?.state.questions[1]?.status === "answered", "the second answer");

    assert.equal(r.record()?.askedAfterSeq, cut, "the cut did not move with the re-park");
    assert.deepEqual(
      r.seatTurns,
      ["PQ-1 six", "PQ-2 yes"],
      "both turns ran, the second on a message that arrived mid-turn",
    );
    assert.equal(r.record()?.state.questions[0]?.status, "answered");
    assert.equal(r.record()?.state.questions[1]?.answer?.text, "yes");
    assert.deepEqual(
      r.store.pendingMessages("run-two-turns").map((m) => m.seq),
      [early.seq],
      "and the instruction from before the questions is STILL pending after two turns",
    );
  } finally {
    r.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * AN ATTACHMENT IS EITHER CARRIED OR REFUSED BY NAME
 * ---------------------------------------------------------------------- */

/**
 * THE OWNER ATTACHES A SECOND DESIGN BOARD WHILE ANSWERING, AND IT VANISHED.
 *
 * `#turn` reads `message.text` and nothing else, then stamps the whole row
 * delivered — so the image was consumed, marked as taken up, and never shown to
 * any seat, with nothing said on any surface. Silently accepting and discarding
 * is the one option this cannot take.
 *
 * CARRYING IT IS THE RIGHT ANSWER AND IT IS NOT AVAILABLE HERE. The follow-up
 * call is `PlanDialogueHost.followUp`, which takes state, text and the
 * classification; putting images in front of the planning seat is `plan-seat.ts`
 * work that another fleet is doing right now. So the refusal is what ships, it is
 * named so the UI can match it without parsing prose, and it says what to do
 * instead — `live-input.ts` really does hand a mid-run message's images to the
 * builder, so the advice is checkable rather than reassuring.
 */
test("an image attached to a plan answer is REFUSED by name, before the message is stamped", async () => {
  const r = rig();
  try {
    seed(r.store, "run-board");
    parkWithQuestions(r, "run-board");
    const message = r.store.appendMessage("run-board", {
      role: "owner",
      text: "six",
      images: [join(r.results, "board.png")],
    });

    assert.equal(r.driver.deliver("run-board"), true);
    await waitFor(() => r.record()?.state.questions[0]?.status === "answered", "the answer to be recorded");

    const refusal = r.events.findIndex((event) => event.includes("plan-attachments-refused"));
    assert.ok(refusal >= 0, `nothing was said about the attachment: ${r.events.join(" | ")}`);
    assert.match(r.events[refusal] ?? "", /^log:warn:/, "a dropped attachment is a degraded outcome, not an aside");
    assert.match(r.events[refusal] ?? "", /board\.png/, "the file is named, so it can be handed over by hand");

    const stamp = r.events.findIndex((event) => event.startsWith("delivered:"));
    assert.ok(stamp >= 0, "the answer itself was still taken up");
    assert.ok(
      refusal < stamp,
      "the refusal must be emitted BEFORE the stamp: a crash between the two must lose the stamp, " +
        "which leaves the message pending and the images bound for the builder",
    );

    // AND THE ANSWER STILL LANDED. Refusing the attachment must not cost the
    // sentence — that would trade a silent drop for a lost answer.
    assert.equal(r.record()?.state.questions[0]?.answer?.text, "six");
    assert.deepEqual(r.store.pendingMessages("run-board"), []);
    assert.ok(r.store.messages("run-board").find((m) => m.seq === message.seq)?.deliveredAt !== null);

    // NEGATIVE CONTROL: an answer with no attachment says nothing about
    // attachments, so the warning cannot be a fixture that always fires.
    const quiet = rig();
    try {
      seed(quiet.store, "run-plain");
      parkWithQuestions(quiet, "run-plain");
      quiet.store.appendMessage("run-plain", { role: "owner", text: "six", images: [] });
      quiet.driver.deliver("run-plain");
      await waitFor(() => quiet.record()?.state.questions[0]?.status === "answered", "the plain answer");
      assert.equal(
        quiet.events.some((event) => event.includes("plan-attachments-refused")),
        false,
        quiet.events.join(" | "),
      );
    } finally {
      quiet.cleanup();
    }
  } finally {
    r.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * AN UNREADABLE RECORD MUST STILL END THE PARK
 * ---------------------------------------------------------------------- */

/**
 * `awaiting_input` HAS NO OTHER EXIT, WHICH IS THE WHOLE REASON `plan.json`
 * EXISTS — and `reconcile` returned false for a record it could not read, which
 * is the one state where the durable half is gone AND the live timer died with
 * the process. `reconcileOnBoot` then falls through to the design-lock loop,
 * finds no `design-lock.json`, and `continue`s. The run waits for ever for an
 * answer to questions nobody can now render, and nothing reports it.
 *
 * THE RESOLUTION IS THE DESIGN'S OWN EXPIRY BEHAVIOUR: the run proceeds on what
 * it has, and what it had to assume is recorded. The corrupt bytes are moved
 * aside rather than overwritten, because a record that cannot be parsed is a
 * defect somebody will want to read.
 */
test("a plan.json that cannot be read ENDS the park instead of wedging the run", async () => {
  const r = rig();
  try {
    seed(r.store, "run-corrupt");
    parkWithQuestions(r, "run-corrupt");
    // The process died with the timer, which is the only case this path covers.
    r.driver.clearTimer("run-corrupt");
    writeFileSync(join(r.results, PLAN_RECORD_FILE), '{"awaiting": true, "parkedAt": "now", "folded": false}', "utf8");

    assert.equal(
      r.driver.reconcile("run-corrupt"),
      true,
      "the boot loop must not walk past this run — there is no other exit from awaiting_input",
    );
    assert.deepEqual(
      r.events.filter((event) => event === "resume"),
      ["resume"],
      "the run PROCEEDS, which is what an expiry does",
    );
    assert.ok(
      r.events.some((event) => event.startsWith("log:warn:") && event.includes("could not be read")),
      `the reason is on the run's own log: ${r.events.join(" | ")}`,
    );

    // AND THE RECORD IS RESOLVED, so the next `#execute` entry folds and moves on
    // instead of asking the seat all over again.
    const after = r.record();
    assert.ok(after !== null, "the replacement record parses");
    assert.equal(after.awaiting, false);
    assert.equal(after.folded, true);
    assert.equal(after.state.closed?.reason, "nothing to ask");
    assert.match(after.state.closed?.detail ?? "", /could not be read/);

    // THE BYTES ARE KEPT. A corrupt record is evidence.
    assert.equal(
      readPlanRecord(r.results) === null,
      false,
      "the quarantined copy must not be left where readPlanRecord looks",
    );
    assert.ok(r.events.some((event) => event.includes("plan.json.unreadable")), r.events.join(" | "));

    // NEGATIVE CONTROL: a run with NO plan.json is not a plan park at all, and
    // reconcile must keep saying so — the design-lock loop behind it depends on
    // being reached, and a boot that resumed every awaiting_input run would
    // restart builds nobody asked to restart.
    const empty = rig();
    try {
      seed(empty.store, "run-nofile");
      empty.store.updateRun("run-nofile", { status: "awaiting_input" });
      assert.equal(empty.driver.reconcile("run-nofile"), false);
      assert.deepEqual(empty.events, []);
    } finally {
      empty.cleanup();
    }
  } finally {
    r.cleanup();
  }
});

/**
 * A PARK THAT IS STILL WITHIN ITS WINDOW IS RE-ARMED, NOT RESOLVED — the
 * positive control for the test above, so "resolve everything" cannot pass for
 * "resolve what cannot be read".
 */
test("a readable park within its window is re-armed on boot, not ended", () => {
  const r = rig();
  try {
    seed(r.store, "run-warm");
    parkWithQuestions(r, "run-warm");
    r.driver.clearTimer("run-warm");
    const parked = r.record();
    assert.ok(parked !== null);

    assert.equal(r.driver.reconcile("run-warm"), true);
    assert.equal(r.events.includes("resume"), false, "it still has time and a question the owner can answer");
    assert.deepEqual(r.driver.parkedRunIds(), ["run-warm"], "the timer is back");
    assert.equal(r.record()?.parkedAt, parked.parkedAt, "and the deadline did not move");
    assert.equal(r.record()?.awaiting, true);
  } finally {
    r.cleanup();
  }
});

/**
 * A FOLDED RECORD IS NOT A PARK, whatever the row says. `reconcileOnBoot` reads
 * the plan record FIRST, and a run that planned, built and then parked for a
 * MOCKUP holds both files; resolving on the plan record would hijack the design
 * park and skip the owner's choice.
 */
test("a folded record is not a plan park, so the design-lock loop is still reached", () => {
  const r = rig();
  try {
    seed(r.store, "run-mockup");
    r.store.updateRun("run-mockup", { status: "awaiting_input" });
    writePlanRecord(r.results, {
      awaiting: false,
      parkedAt: new Date().toISOString(),
      folded: true,
      state: openState(),
    });
    assert.equal(r.driver.reconcile("run-mockup"), false);
    assert.deepEqual(r.events, [], "nothing was said and nothing was resumed");
  } finally {
    r.cleanup();
  }
});
