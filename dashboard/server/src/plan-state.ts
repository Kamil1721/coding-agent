/**
 * plan-state.ts — which questions are still open, as a value rather than a story.
 *
 * NAMED `plan-state` AND NOT `plan-dialogue` ON PURPOSE: the design reserves
 * `plan-dialogue.ts` for the impure `PlanDriver` — timers, the store, the bus.
 * Nothing in this file touches any of them. It is a state machine over plain
 * data, so every case below can be driven in a test without a run, a seat call
 * or a clock.
 *
 * ─── THE DEFECT THIS SHAPE PREVENTS ───
 *
 * The owner must be able to reply with a question of his own — "what do you mean
 * by that?", "which of the two images?" — and an owner's question IS NOT AN
 * ANSWER. If the dialogue were a transcript, deciding whether a question is
 * still open would mean re-reading prose, and the obvious implementation is to
 * ask a model whether its own question got answered. It would say yes. The run
 * would proceed as though a question the owner never answered were resolved, and
 * the criteria would be authored against a guess wearing the owner's name — the
 * exact failure this whole phase exists to end, reproduced one level down.
 *
 * So {@link openQuestions} reads a status field, and the status only changes
 * through {@link applyOwnerTurn}, which is arbitrated by rules stated below.
 *
 * ─── WHAT IS STRUCTURAL AND WHAT IS INFERRED ───
 *
 * Classification is a LADDER, and every rung records which one it used in
 * {@link PlanAnswer.attribution}, so "how much of this dialogue rested on a
 * guess?" is a count rather than a judgement:
 *
 *   `structural` — the UI supplied the question id and the intent. The owner
 *                  pressed answer or decline on a specific question. Nothing is
 *                  inferred; this is the path the client should always take.
 *   `addressed`  — free-typed text containing a `PQ-n` id that is currently
 *                  open. The owner named the question himself.
 *   `inferred`   — free-typed text with exactly one question open, or a decline
 *                  phrase. THIS IS THE RUNG THAT CAN BE WRONG, and it is the
 *                  only one. Its two errors are bounded below.
 *
 * THE INFERRED RUNG'S ERRORS, STATED RATHER THAN HIDDEN. With one question open,
 * "I don't really understand what you mean by a hero section" is recorded as an
 * answer to it — unless it ends in a question mark, which is why the
 * question-mark rule sits ABOVE the single-open-question rule. And a free-typed
 * "you decide" with three open declines all three, because the phrase is global
 * in English.
 *
 * THE ONLY MITIGATION IS THAT HE SEES IT, AND THERE IS NO UNDO. Every accepted
 * resolution is echoed onto the run log while the dialogue is still open
 * (`PlanDriver#report`), so a wrong reading is in front of the owner within
 * seconds — but {@link applyOwnerTurn} only ever moves an `open` question, so a
 * later turn cannot take an answer back. A `reopenQuestion` verb was written for
 * this and deleted below, because nothing ever called it and no wire carries the
 * question id it would need. What the owner has instead is the ordinary mid-run
 * message channel, one phase later. This is a bound on how a wrong reading is
 * noticed, not a way to correct one.
 */

import type { DroppedQuestion, PlanQuestion } from "./plan-question.js";
import { MAX_OWNER_TURNS, mintQuestionId, questionIdsIn } from "./plan-question.js";
import type { PlanProposal, PlanSeatReply } from "./plan-turn.js";

/* -------------------------------------------------------------------------
 * The state
 * ---------------------------------------------------------------------- */

/**
 * Four states, and `declined` is NOT a weaker `answered`.
 *
 * A DECLINED QUESTION RECORDS EXACTLY WHAT AN EXPIRED ONE RECORDS — the
 * question's own `ifUnanswered`. That identity is the design's "you decide
 * without penalty" made mechanical: an owner who declines lands precisely where
 * the run would have landed had the question never been asked. There is a test
 * asserting the two assumptions are the same string.
 *
 * They stay distinguishable because the FOLD says which happened, and because
 * only `answered` produces a pair the assumptions tracer may credit to the
 * owner. Crediting a declined question's default to "words you wrote" would
 * stamp a criterion he explicitly refused to state as traced to him, and would
 * let declining everything game the very number this phase is measured by.
 */
export type PlanQuestionStatus = "open" | "answered" | "declined" | "expired";

/** Which rung of the classification ladder produced a resolution. */
export type PlanAttribution = "structural" | "addressed" | "inferred";

export interface PlanAnswer {
  /** The answer in words. The owner's own, unless the seat's paraphrase passed the quote check. */
  readonly text: string;
  /** The span of the owner's turn this rests on. `""` for a button press with no text. */
  readonly quoted: string;
  readonly at: string;
  readonly attribution: PlanAttribution;
  /** True when the wording above is the seat's paraphrase rather than the owner's literal turn. */
  readonly paraphrased: boolean;
}

export interface PlanQuestionState {
  readonly question: PlanQuestion;
  readonly status: PlanQuestionStatus;
  /** Present only when `status` is `answered`. */
  readonly answer: PlanAnswer | null;
  /** Present when `status` is `declined` or `expired`. Always the question's `ifUnanswered`. */
  readonly assumed: string | null;
}

/**
 * One exchange the owner started.
 *
 * IT IS ITS OWN KIND OF TURN, not an answer with a flag. Counting clarifications
 * separately is what lets the phase report "three turns, one answer, two
 * clarifications" — a dialogue that is going badly and a dialogue that is going
 * well have the same turn count and different shapes.
 */
export interface PlanClarification {
  readonly at: string;
  /** Question ids the owner referenced, if any. Empty when nothing could be attributed. */
  readonly about: readonly string[];
  /** The owner's own question, verbatim. */
  readonly asked: string;
  /** The seat's short answer. `""` when the seat said nothing. */
  readonly reply: string;
}

export type PlanClosureReason = "answered" | "declined" | "turn cap" | "window expired" | "nothing to ask";

/**
 * Why the dialogue stopped.
 *
 * NONE OF THESE IS A FAILURE, and that is the point of enumerating them. The run
 * proceeds in every case; what differs is how many questions carry an owner's
 * sentence and how many carry an assumption. `nothing to ask` is the outcome for
 * a detailed ticket and it is the best one available — it means the owner was
 * not interrupted because there was nothing worth interrupting him for.
 */
export interface PlanClosure {
  readonly reason: PlanClosureReason;
  readonly at: string;
  /** One sentence for the run log and the chat. Never empty. */
  readonly detail: string;
}

export interface PlanState {
  /** The seat's short plan, as shown to the owner. */
  readonly plan: readonly string[];
  readonly questions: readonly PlanQuestionState[];
  readonly clarifications: readonly PlanClarification[];
  /** Everything proposed that the owner never saw, with its reason. */
  readonly dropped: readonly DroppedQuestion[];
  /** How many questions the seat proposed across every turn, before refusals. */
  readonly proposed: number;
  /** Owner turns consumed. A clarifying turn costs one of these and no answer slot. */
  readonly turnsUsed: number;
  readonly closed: PlanClosure | null;
}

/* -------------------------------------------------------------------------
 * Opening
 * ---------------------------------------------------------------------- */

/**
 * The state after the seat's opening turn.
 *
 * A PROPOSAL WITH NO SURVIVING QUESTIONS CLOSES IMMEDIATELY, and closing here
 * rather than parking is the difference between a feature and a latency tax: a
 * park with no questions in it makes every run 20 minutes slower and asks
 * nothing. `detail` distinguishes the two ways to arrive — nothing proposed, or
 * everything proposed refused — because only the second is a defect.
 */
export function openPlanState(proposal: PlanProposal, at: string): PlanState {
  const questions = proposal.asked.map((question) => ({
    question,
    status: "open" as const,
    answer: null,
    assumed: null,
  }));

  const closed: PlanClosure | null =
    questions.length > 0
      ? null
      : {
          reason: "nothing to ask",
          at,
          detail:
            proposal.proposed === 0
              ? "the planning seat proposed no questions — the ticket already says what it wants"
              : `the planning seat proposed ${String(proposal.proposed)} question(s) and none earned a place; ` +
                `nothing was asked`,
        };

  return {
    plan: proposal.plan,
    questions,
    clarifications: [],
    dropped: proposal.dropped,
    proposed: proposal.proposed,
    turnsUsed: 0,
    closed,
  };
}

/* -------------------------------------------------------------------------
 * Counting, without re-reading prose
 * ---------------------------------------------------------------------- */

export function openQuestions(state: PlanState): readonly PlanQuestion[] {
  return withStatus(state, "open").map((entry) => entry.question);
}

export function answeredQuestions(state: PlanState): readonly PlanQuestionState[] {
  return withStatus(state, "answered");
}

export function declinedQuestions(state: PlanState): readonly PlanQuestionState[] {
  return withStatus(state, "declined");
}

export function expiredQuestions(state: PlanState): readonly PlanQuestionState[] {
  return withStatus(state, "expired");
}

/** True when nothing is outstanding and the dialogue may proceed on answers alone. */
export function planIsSettled(state: PlanState): boolean {
  return openQuestions(state).length === 0;
}

/** True when the dialogue has spent its turn budget. Reaching this is not a failure. */
export function planTurnsExhausted(state: PlanState): boolean {
  return state.turnsUsed >= MAX_OWNER_TURNS;
}

/**
 * The verified question-and-answer pairs, for the assumptions tracer.
 *
 * ONLY `answered` PRODUCES A PAIR. Declined and expired questions deliberately
 * produce none: their `ifUnanswered` is the house's guess, not the owner's
 * sentence, and a criterion resting on it must keep reading as `inferred`. That
 * is what stops "you decide" from moving the number this phase is judged by.
 */
export function answeredPairs(state: PlanState): readonly { readonly question: string; readonly answer: string }[] {
  return answeredQuestions(state).map((entry) => ({
    question: entry.question.text,
    answer: entry.answer?.text ?? "",
  }));
}

/**
 * Everything the run had to assume, in the order the questions were asked.
 *
 * Declined and expired both land here, carrying the same field. `assumptions.md`
 * is where these end up, labelled `inferred`, which is the honest label: nobody
 * stated them.
 */
export function planAssumptions(state: PlanState): readonly { readonly id: string; readonly assumed: string }[] {
  return state.questions
    .filter((entry) => entry.status === "declined" || entry.status === "expired")
    .map((entry) => ({ id: entry.question.id, assumed: entry.assumed ?? entry.question.ifUnanswered }));
}

function withStatus(state: PlanState, status: PlanQuestionStatus): readonly PlanQuestionState[] {
  return state.questions.filter((entry) => entry.status === status);
}

/* -------------------------------------------------------------------------
 * CLASSIFYING AN OWNER'S REPLY
 * ---------------------------------------------------------------------- */

/**
 * What the client sent.
 *
 * `questionId` AND `intent` ARE THE STRUCTURAL PATH AND THE CLIENT SHOULD ALWAYS
 * SUPPLY THEM. The UI answers a specific question by id and declines with a
 * button, which makes classification a fallback for free-typed text rather than
 * the primary mechanism. Both are nullable because the chat channel that
 * transports this (`POST /api/runs/:id/messages`) already exists and carries
 * neither, so free-typed text is a real case rather than a hypothetical.
 */
export interface OwnerReplyInput {
  readonly text: string;
  /** The question this reply is about, from the UI. `null` when free-typed. */
  readonly questionId: string | null;
  /** The button pressed. `null` when free-typed. */
  readonly intent: "answer" | "decline" | "clarify" | null;
}

export interface ClassifiedReply {
  readonly kind: "answer" | "decline" | "clarify";
  /** Which questions this reply is about. Empty on an unattributable clarification. */
  readonly targets: readonly string[];
  readonly attribution: PlanAttribution;
  /** One sentence naming the rung that decided it, for the run log. Never empty. */
  readonly why: string;
}

/**
 * Phrases that mean "you decide".
 *
 * A WHOLE-REPLY MATCH, NOT A SUBSTRING, AND THE LENGTH BOUND IS WHY. "You decide
 * the palette but there must be three project cards" contains "you decide" and is
 * an ANSWER — the owner stated a requirement. Requiring the reply to BE one of
 * these, or to start with one and be short, keeps that case out. The list and the
 * bound are both chosen, not measured.
 */
const DECLINE_PHRASES: readonly string[] = [
  "you decide",
  "you choose",
  "your call",
  "up to you",
  "whatever you think",
  "whatever you like",
  "no preference",
  "dont mind",
  "no strong feelings",
  "skip",
  "doesnt matter",
  "either is fine",
  "surprise me",
];

const MAX_DECLINE_CHARS = 40;

/**
 * Which question the owner just replied to, and whether it was a reply at all.
 *
 * THE ORDER OF THE RUNGS IS THE DESIGN. In particular the question-mark rule sits
 * ABOVE the single-open-question fallback: with one question open, "why does that
 * matter?" must be a clarification, and a ladder that attributed it first would
 * record it as the answer. That single ordering is what makes "the owner can ask
 * back" safe, and there is a test that swaps the two rungs and watches it fail.
 */
export function classifyOwnerReply(input: OwnerReplyInput, state: PlanState): ClassifiedReply {
  const open = new Set(openQuestions(state).map((question) => question.id));
  const body = input.text.trim();

  // 1. STRUCTURAL — the UI named the question and the intent.
  if (input.intent !== null && input.questionId !== null && open.has(input.questionId)) {
    return {
      kind: input.intent,
      targets: [input.questionId],
      attribution: "structural",
      why: `the client sent intent=${input.intent} for ${input.questionId}`,
    };
  }
  // 1b. STRUCTURAL, NO ID — the "you decide, all of it" button.
  if (input.intent === "decline" && input.questionId === null && open.size > 0) {
    return {
      kind: "decline",
      targets: [...open],
      attribution: "structural",
      why: `the client declined every open question (${String(open.size)})`,
    };
  }

  // 2. ADDRESSED — the owner typed a PQ-n that is currently open.
  const named = questionIdsIn(body).filter((id) => open.has(id));
  if (named.length > 0) {
    /*
     * THE ADDRESSING COMES OFF BEFORE THE INTENT IS READ, AND MEASURING IT WAS
     * THE POINT. `declineIntent` flattens its input to letters, digits and
     * spaces, so "PQ-2 you decide" reached it as `pq2 you decide`, matched no
     * phrase, and this rung returned `answer`. `applyOwnerTurn` then stripped
     * the id and recorded the WORDS "you decide" as PQ-2's answer — measured,
     * `classified.kind` was "answer" — which is the outcome the whole design
     * forbids: `answeredPairs` hands the tracer a pair, so a criterion resting
     * on a refusal to state a preference reads as traced to words the owner
     * wrote, and declining everything would move the number this phase is
     * judged by.
     */
    const said = stripQuestionIds(body);
    const kind = endsWithQuestion(said) ? "clarify" : declineIntent(said) ? "decline" : "answer";
    return {
      kind,
      targets: named,
      attribution: "addressed",
      why: `the owner named ${named.join(", ")} in the reply`,
    };
  }

  // 3. A QUESTION IS NEVER AN ANSWER. Above the fallback, deliberately.
  if (endsWithQuestion(body)) {
    return {
      kind: "clarify",
      targets: [],
      attribution: input.intent === "clarify" ? "structural" : "inferred",
      why: "the reply ends in a question mark, so it asks rather than answers",
    };
  }

  // 4. A GLOBAL DECLINE.
  if (declineIntent(body) && open.size > 0) {
    return {
      kind: "decline",
      targets: [...open],
      attribution: "inferred",
      why: `"${body}" reads as declining every open question (${String(open.size)})`,
    };
  }

  // 5. ONE QUESTION OPEN — the only thing it could be about.
  if (open.size === 1 && body.length > 0) {
    const [only] = [...open];
    return {
      kind: "answer",
      targets: only === undefined ? [] : [only],
      attribution: "inferred",
      why: "exactly one question was open, so the reply is taken as its answer",
    };
  }

  // 6. NOTHING CAN BE ATTRIBUTED. Resolves nothing, on purpose.
  return {
    kind: "clarify",
    targets: [],
    attribution: "inferred",
    why:
      open.size === 0
        ? "no question was open"
        : `${String(open.size)} questions were open and the reply named none of them`,
  };
}

function endsWithQuestion(text: string): boolean {
  return text.replace(/["'”’)\]]+$/, "").trimEnd().endsWith("?");
}

function declineIntent(text: string): boolean {
  const flat = normalise(text).replace(/[^a-z0-9 ]/g, "");
  return DECLINE_PHRASES.some(
    (phrase) => flat === phrase || (flat.startsWith(phrase) && flat.length <= MAX_DECLINE_CHARS),
  );
}

/* -------------------------------------------------------------------------
 * APPLYING A TURN — the arbiter
 * ---------------------------------------------------------------------- */

export interface OwnerTurn {
  readonly at: string;
  /** The owner's message, verbatim. The quote check runs against this. */
  readonly ownerText: string;
  readonly classified: ClassifiedReply;
  /** The seat's reading of the same turn, or null when the seat call failed. */
  readonly seat: PlanSeatReply | null;
}

/**
 * Why a resolution the seat proposed was not recorded.
 *
 * EACH MEMBER IS SUFFICIENT ALONE AND EACH HAS ITS OWN MUTATION IN THE TEST FILE.
 */
export type ResolutionRejection =
  /** The turn was a clarification, so nothing in it could resolve anything. */
  | "clarifying-turn"
  /** The owner did not address this question in this turn. */
  | "not-addressed"
  /** The question is not currently open. */
  | "not-open"
  /** The quoted span is not in the owner's turn. */
  | "quote-not-in-turn"
  /** A refinement with no wording in it. */
  | "empty-answer";

export interface RejectedResolution {
  readonly id: string;
  readonly reason: ResolutionRejection;
  readonly detail: string;
}

export interface AcceptedResolution {
  readonly id: string;
  readonly status: "answered" | "declined";
  /** What was recorded. For a decline this is the question's `ifUnanswered`. */
  readonly recorded: string;
  readonly attribution: PlanAttribution;
}

export interface PlanTurnOutcome {
  readonly state: PlanState;
  readonly accepted: readonly AcceptedResolution[];
  readonly rejected: readonly RejectedResolution[];
}

/**
 * Consume one owner turn.
 *
 * ─── THE FIVE RULES, EACH SUFFICIENT ALONE TO LEAVE A QUESTION OPEN ───
 *
 *  1. A CLARIFYING TURN RESOLVES NOTHING, by construction rather than by the
 *     model classifying its own input. If {@link classifyOwnerReply} called it a
 *     clarification, every resolution the seat proposed is rejected.
 *  2. THE HOST OWNS THE OPEN SET. A resolution naming a question that is not
 *     currently open is rejected — the model does not get to decide what was
 *     outstanding.
 *  3. THE HOST OWNS THE ATTRIBUTION. A resolution naming a question the owner
 *     did not address in THIS turn is rejected, however plausible it reads.
 *  4. A QUOTED SPAN MUST BE IN THE OWNER'S TURN, after whitespace and case
 *     normalisation. This bounds fabrication.
 *  5. AN EMPTY ANSWER IS NOT AN ANSWER. A turn that records no words leaves the
 *     question open, whichever rung attributed it.
 *  6. TURNS ARE COUNTED WHATEVER THEY CONTAINED. `turnsUsed` increments here and
 *     nowhere else, so a clarifying turn costs a turn and no answer slot — the
 *     asymmetry that makes asking back cheap.
 *
 * ─── WHAT THE SEAT CAN AND CANNOT DO ───
 *
 * The seat cannot resolve a question. It can only REFINE the wording of one the
 * owner already addressed, and only if its quoted span is really in the turn.
 * When it is silent, unparseable, or caught fabricating, the answer recorded is
 * the owner's own text — so a broken seat costs a tidier phrasing and never
 * costs the answer. That is the opposite failure direction from a design where
 * the seat proposes and the host merely validates, and it is the reason this
 * function takes `seat: PlanSeatReply | null`.
 *
 * ─── THE RESIDUAL, AND IT IS NOT CLOSED ───
 *
 * Rules 2-4 bound FABRICATION. They do not eliminate MISATTRIBUTION: on a turn
 * where the owner addressed PQ-2, a seat can still cite a fragment of his
 * sentence and paraphrase it into something he did not mean. The mitigation is
 * visibility ALONE — every {@link AcceptedResolution} is echoed onto the run log
 * by `PlanDriver#report` while the dialogue is open, and there it stops: a
 * question that has left `open` cannot be moved by a later turn, and no verb in
 * this file puts it back. This docblock claims a bound, not soundness, and it no
 * longer claims an undo.
 */
export function applyOwnerTurn(state: PlanState, turn: OwnerTurn): PlanTurnOutcome {
  const accepted: AcceptedResolution[] = [];
  const rejected: RejectedResolution[] = [];
  const openNow = new Set(openQuestions(state).map((question) => question.id));
  const targets = turn.classified.targets.filter((id) => openNow.has(id));
  const haystack = normalise(turn.ownerText);
  const resolutions = turn.seat?.resolutions ?? [];

  // RULE 1 + RULES 2/3: judge every proposal the seat made before recording anything.
  const refinements = new Map<string, string>();
  for (const proposal of resolutions) {
    if (turn.classified.kind === "clarify") {
      rejected.push({
        id: proposal.id,
        reason: "clarifying-turn",
        detail: "the owner asked a question; nothing in this turn could resolve anything",
      });
      continue;
    }
    if (!openNow.has(proposal.id)) {
      rejected.push({
        id: proposal.id,
        reason: "not-open",
        detail: "that question is not currently open",
      });
      continue;
    }
    if (!targets.includes(proposal.id)) {
      rejected.push({
        id: proposal.id,
        reason: "not-addressed",
        detail: "the owner did not address that question in this turn",
      });
      continue;
    }
    if (!haystack.includes(normalise(proposal.quoted)) || normalise(proposal.quoted).length === 0) {
      rejected.push({
        id: proposal.id,
        reason: "quote-not-in-turn",
        detail: `the seat quoted "${proposal.quoted}", which is not in the owner's message`,
      });
      continue;
    }
    if (proposal.kind === "answer" && proposal.answer.length === 0) {
      rejected.push({ id: proposal.id, reason: "empty-answer", detail: "the refinement carried no wording" });
      continue;
    }
    if (proposal.kind === "answer") refinements.set(proposal.id, proposal.answer);
  }

  const owner = turn.ownerText.trim();
  // ONE MESSAGE CAN CARRY SEVERAL ANSWERS, AND EACH ONE IS ITS OWN SPAN. See
  // {@link answerSpans}: before it, every question the owner named recorded the
  // WHOLE message, so "PQ-1 six. PQ-2 a mailto link." gave both questions the
  // same string and handed the tracer two pairs that were not two answers.
  const spans = answerSpans(owner);
  const questions = state.questions.map((entry) => {
    if (!targets.includes(entry.question.id) || entry.status !== "open") return entry;
    if (turn.classified.kind === "clarify") return entry;

    if (turn.classified.kind === "decline") {
      accepted.push({
        id: entry.question.id,
        status: "declined",
        recorded: entry.question.ifUnanswered,
        attribution: turn.classified.attribution,
      });
      // THE DECLINED ASSUMPTION IS THE QUESTION'S OWN DEFAULT, byte for byte the
      // same string an expiry records. Declining costs the owner nothing.
      return { ...entry, status: "declined" as const, answer: null, assumed: entry.question.ifUnanswered };
    }

    const refined = refinements.get(entry.question.id);
    const recorded = refined ?? spans.get(entry.question.id) ?? stripQuestionIds(owner);
    if (recorded.length === 0) {
      // AN EMPTY ANSWER RESOLVES NOTHING, and this guard is on the RECORDED value
      // rather than on the input because two different inputs reach here empty: a
      // structural `{text: "", questionId: "PQ-1", intent: "answer"}` from a
      // client that let an empty box through, and a free-typed "PQ-1" with
      // nothing after it, which strips to nothing. Rung 5 of the classifier
      // checks `body.length`, rungs 1 and 2 do not — and rung 1 is the path the
      // client is supposed to always take, so the hole was on the safest route.
      //
      // WHAT IT COSTS TO GET WRONG: `answeredPairs` would hand the tracer a pair
      // whose answer is "", and the question's own text alone shares enough
      // content tokens with a criterion to have it stamped `answered` — a
      // criterion credited to the owner on the strength of nothing.
      rejected.push({
        id: entry.question.id,
        reason: "empty-answer",
        detail: "the owner's message carried no words to record",
      });
      return entry;
    }
    accepted.push({
      id: entry.question.id,
      status: "answered",
      recorded,
      attribution: turn.classified.attribution,
    });
    return {
      ...entry,
      status: "answered" as const,
      assumed: null,
      answer: {
        text: recorded,
        quoted: owner,
        at: turn.at,
        attribution: turn.classified.attribution,
        paraphrased: refined !== undefined,
      },
    };
  });

  const clarifications =
    turn.classified.kind === "clarify"
      ? [
          ...state.clarifications,
          {
            at: turn.at,
            about: turn.classified.targets,
            asked: owner,
            reply: turn.seat?.reply ?? "",
          },
        ]
      : state.clarifications;

  // RULE 5.
  return {
    state: { ...state, questions, clarifications, turnsUsed: state.turnsUsed + 1 },
    accepted,
    rejected,
  };
}

/*
 * ─── TWO VERBS WERE DELETED HERE, AND THE DELETION IS THE RECORD ───
 *
 * `reopenQuestion(state, id)` and `addQuestions(state, proposal)` lived here,
 * were documented as live mechanisms, and had tests. NOTHING IN THE RUNNING
 * PROGRAM EVER CALLED EITHER — measured by grep across `src/`: every reference
 * outside this file was a test or a docblock citing them. `questionBudget` went
 * with `addQuestions`, its only caller.
 *
 * A tested export with no caller is worse than a missing feature: the suite
 * turns green over it and the docblocks above went on describing a mitigation
 * the owner did not have. `plan-state.test.ts` now asserts these three names
 * stay unexported, and says what each would need in order to come back.
 */

/**
 * Stop the dialogue and record what had to be assumed.
 *
 * EVERY STILL-OPEN QUESTION BECOMES `expired` CARRYING ITS `ifUnanswered`, and
 * the run PROCEEDS. Reaching the turn cap and the park window expiring are
 * mechanically identical here on purpose: both are bounds on the owner's time,
 * neither is a verdict about the work, and a phase that failed a run because
 * nobody was at the desk would be worse than the guessing it replaces.
 *
 * CLOSING AN ALREADY-CLOSED STATE IS A NO-OP. The first reason stands: a run that
 * expired and was then closed again by a late turn would report the wrong cause
 * in `assumptions.md`.
 */
export function closePlan(state: PlanState, reason: PlanClosureReason, at: string): PlanState {
  if (state.closed !== null) return state;

  const stillOpen = openQuestions(state).length;
  return {
    ...state,
    questions: state.questions.map((entry) =>
      entry.status === "open"
        ? { ...entry, status: "expired" as const, assumed: entry.question.ifUnanswered }
        : entry,
    ),
    closed: {
      reason,
      at,
      detail: closureDetail(reason, stillOpen, answeredQuestions(state).length, declinedQuestions(state).length),
    },
  };
}

function closureDetail(reason: PlanClosureReason, stillOpen: number, answered: number, declined: number): string {
  const tail =
    stillOpen === 0
      ? `${String(answered)} answered, ${String(declined)} left to the dashboard`
      : `${String(answered)} answered, ${String(declined)} left to the dashboard, ` +
        `${String(stillOpen)} unanswered and now assumed`;
  switch (reason) {
    case "answered":
      return `every question was settled — ${tail}`;
    case "declined":
      return `the owner left the remaining questions to the dashboard — ${tail}`;
    case "turn cap":
      return `the plan dialogue reached its ${String(MAX_OWNER_TURNS)}-turn bound and proceeded — ${tail}`;
    case "window expired":
      return `the plan window expired and the run proceeded — ${tail}`;
    case "nothing to ask":
      return `nothing was worth asking — ${tail}`;
  }
}

/* -------------------------------------------------------------------------
 * Normalisation
 * ---------------------------------------------------------------------- */

/**
 * Lower-cased, whitespace collapsed. The form the quote check compares in.
 *
 * CASE-FOLDING DOES NOT WEAKEN THE FABRICATION BOUND. Fabrication means words the
 * owner never typed, and folding case invents no words — it only forgives a seat
 * that re-capitalised the start of the span it quoted. Whitespace collapsing
 * forgives a seat that re-wrapped a line. Neither lets an invented sentence
 * through, and both keep a legitimate paraphrase from being thrown away in
 * favour of the raw turn.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * `PQ-2 three of them` -> `three of them`. The id is addressing, not content.
 *
 * IT STRIPS ONLY THE LEADING RUN OF IDS, which is why {@link answerSpans} exists
 * as well: this function alone made a three-answer message record the same whole
 * string against all three questions.
 *
 * A MESSAGE THAT IS NOTHING BUT IDS STRIPS TO NOTHING, and that is the point
 * rather than an edge case to paper over. An earlier draft fell back to the
 * original text when stripping emptied it, which turned a bare "PQ-1" into an
 * answer whose recorded wording was "PQ-1" — a question marked answered by an
 * owner who had typed only its number. `applyOwnerTurn`'s empty-answer rule then
 * had nothing to catch, because the string was no longer empty. The test drives
 * exactly that input.
 */
function stripQuestionIds(text: string): string {
  return text.replace(/^\s*(?:\bPQ-\d+\b[\s:,.-]*)+/i, "").trim();
}

/**
 * Words that can sit BETWEEN two ids and answer neither of them.
 *
 * "PQ-1 and PQ-2 yes" is the shape. Taking the span rule literally there would
 * record the word "and" as PQ-1's answer — a sentence the owner never meant,
 * carrying his name into the criteria, which is strictly worse than the
 * whole-message fallback it would replace. The list is CHOSEN, not measured, and
 * it is small on purpose: every word on it costs a real answer if the owner ever
 * types it alone, so "no" and "yes" are deliberately absent even though "no" is
 * a stopword in `contentTokens` — a one-word answer to a yes/no question is the
 * likeliest answer there is.
 */
const SPAN_CONNECTORS: ReadonlySet<string> = new Set(["and", "or", "plus", "also", "with", "then"]);

/**
 * Which part of one message belongs to which question the owner named.
 *
 * THE DOCBLOCK ON `questionText` PROMISED THIS AND NOTHING IMPLEMENTED IT.
 * `stripQuestionIds` removes only the LEADING ids, so before this function
 * "PQ-1 six cards. PQ-2 no, a mailto link. PQ-3 yes, the wordmark" recorded — as
 * measured, in the test that drove this — the identical string
 * "six cards. PQ-2 no, a mailto link. PQ-3 yes, the wordmark" against ALL THREE
 * questions. Every question was marked answered, two of the three answers were
 * mostly other questions' answers, and `answeredPairs` reported three pairs that
 * were not three answers.
 *
 * A SPAN RUNS FROM ONE ID TO THE NEXT, which is the only rule that needs no
 * model and no grammar: the owner is writing a list, and the ids are the list
 * markers he was asked to use.
 *
 * A SPAN THIS FUNCTION REFUSES IS ABSENT FROM THE MAP, NOT EMPTY IN IT, so the
 * caller's `?? stripQuestionIds(owner)` fallback lands on exactly the behaviour
 * that shipped before — an id with nothing after it, or with only a connector
 * after it, records what it always recorded. This function can improve a
 * recorded answer and cannot invent one.
 */
function answerSpans(text: string): ReadonlyMap<string, string> {
  const spans = new Map<string, string>();
  const marks = [...text.matchAll(/\bPQ-(\d+)\b/gi)];
  for (const [position, mark] of marks.entries()) {
    const digits = mark[1];
    if (digits === undefined) continue;
    const start = mark.index + mark[0].length;
    const end = marks[position + 1]?.index ?? text.length;
    // The separators an owner puts after an id — "PQ-1: six", "PQ-1 - six",
    // "PQ-1, six" — are addressing too, and they are not part of his answer.
    const span = text.slice(start, end).replace(/^[\s:,.\-–—)\]]+/, "").trim();
    if (span.length === 0 || SPAN_CONNECTORS.has(span.toLowerCase().replace(/[^a-z]/g, ""))) continue;
    const id = mintQuestionId(Number(digits));
    // FIRST WINS. "PQ-2 three of them, and PQ-1 yes, PQ-2 again" is a message
    // that names one question twice; the second mention is a repetition, and
    // preferring it would let a trailing afterthought overwrite the answer.
    if (!spans.has(id)) spans.set(id, span);
  }
  return spans;
}
