/**
 * plan-turn.ts — reading one turn of the planning seat, strictly.
 *
 * THE PARSER IS WHERE A QUESTION IS REFUSED, NOT THE RANKER. A question that
 * cannot name the two criteria its answer would decide between never reaches the
 * owner and never reaches a rank; it lands in {@link DroppedQuestion}. That
 * placement is deliberate: ranking a worthless question low still leaves it able
 * to be asked on a turn where nothing better was proposed.
 *
 * BREVITY IS ENFORCED HERE, NOT REQUESTED IN THE PROMPT. The owner's constraint
 * was "we dont want a wall of text". A prompt that asks for brevity and a parser
 * that accepts an essay is the same defect as a docblock claiming four refusals
 * over an implementation with one — the claim lives somewhere nothing checks.
 * So the two overruns are handled differently and both are recorded:
 *   - A QUESTION that is not one sentence, or is past the character bound, is
 *     REFUSED. It is going in front of a person and there is no safe truncation
 *     of a question — cutting a question changes what was asked.
 *   - The PLAN and the seat's clarifying REPLY are TRUNCATED WITH A RECORD. They
 *     are prose the owner reads and nothing is graded against them, so the
 *     cheaper failure is a short plan rather than a discarded turn.
 *
 * NO SEAT CALL HAPPENS IN THIS FILE and nothing here imports the SDK. Everything
 * below takes a string and returns a value, which is what lets the adversarial
 * cases be tested at all: a seat that returns an essay, a seat that proposes five
 * generic questions, a seat that resolves a question the owner never addressed.
 */

import type { DroppedQuestion, PlanQuestion, PlanQuestionTier } from "./plan-question.js";
import {
  MAX_QUESTIONS_PER_TURN,
  PLAN_QUESTION_TIERS,
  mintQuestionId,
  questionEarnsItsPlace,
  selectQuestions,
} from "./plan-question.js";

/* -------------------------------------------------------------------------
 * Bounds on prose
 * ---------------------------------------------------------------------- */

/**
 * Lines of plan the owner sees.
 *
 * SIX IS CHOSEN, and the reasoning is the owner's fifteen seconds: "The plan is a
 * few lines a person reads in fifteen seconds, not a document." Nothing has been
 * measured that could set it more precisely.
 */
export const MAX_PLAN_LINES = 6;

/** One line of plan, in characters. Chosen to be about one line of chat. */
export const MAX_PLAN_LINE_CHARS = 160;

/**
 * The seat's answer to an owner's own question.
 *
 * "If the seat wants to explain itself it does so when asked, not pre-emptively"
 * — and when asked, it still answers in a few lines. 400 characters is chosen.
 */
export const MAX_REPLY_CHARS = 400;

/* -------------------------------------------------------------------------
 * The opening turn: a plan and a ranked, capped list of questions
 * ---------------------------------------------------------------------- */

export interface PlanProposal {
  /** At most {@link MAX_PLAN_LINES} lines, each at most {@link MAX_PLAN_LINE_CHARS}. */
  readonly plan: readonly string[];
  /** What the host had to do to the seat's plan prose, or null if nothing. */
  readonly planNote: string | null;
  /** Ranked, de-duplicated, capped, and given their `PQ-n` ids. */
  readonly asked: readonly PlanQuestion[];
  /** Everything the seat proposed that the owner will not see, and why. */
  readonly dropped: readonly DroppedQuestion[];
  /**
   * How many questions the seat proposed, before any refusal.
   *
   * THE NUMBER THAT MAKES A USELESS SEAT VISIBLE. `asked.length` alone cannot
   * tell "a detailed ticket left nothing worth asking" from "the seat proposed
   * five and every one was generic". Those have the same output and opposite
   * meanings, and only the second is a defect.
   */
  readonly proposed: number;
}

export type ParsedProposal =
  | { readonly ok: true; readonly proposal: PlanProposal }
  | { readonly ok: false; readonly refusal: "unparseable"; readonly detail: string };

export interface ProposalOptions {
  /** The composed brief. Used by the worth rule to refuse what it already says. */
  readonly brief: string;
  /**
   * How many questions this turn may ask, after ranking.
   *
   * CLAMPED TO {@link MAX_QUESTIONS_PER_TURN} BY THE PARSER, NOT TRUSTED. The
   * caller supplies the dialogue's remaining whole-run budget, which on the
   * opening turn is 5 — larger than any single turn may put in front of the
   * owner. A named cap that no code applies is a docblock claiming more than the
   * code does, which is the defect this module is surrounded by.
   */
  readonly cap: number;
  /** The next unused `PQ-n` ordinal. 1 on the opening turn. */
  readonly firstOrdinal: number;
}

/**
 * Read the seat's opening turn.
 *
 * ZERO QUESTIONS IS A SUCCESS, NOT A REFUSAL — and this is the case most likely
 * to be got wrong, because it looks like failure. A detailed ticket that already
 * states what it wants leaves nothing whose answer would change a criterion, and
 * the correct behaviour is to say so and proceed. Run `…3d4d1ccb` recorded
 * `inferredCriteria = 2` from a detailed ticket; a phase that insisted on
 * interrogating that owner anyway would make his run worse to make a thin one
 * better.
 *
 * `unparseable` IS RESERVED FOR "THIS IS NOT THE SHAPE ASKED FOR". A response
 * with a plan and no `questions` key is a legitimate zero-question turn. A
 * response that is not a JSON object, or that carries neither a plan nor a
 * questions array, is unparseable.
 */
export function parsePlanProposal(raw: string, options: ProposalOptions): ParsedProposal {
  const root = extractJsonObject(raw);
  if (root === null) {
    return { ok: false, refusal: "unparseable", detail: "no JSON object in the seat's response" };
  }

  const hasPlan = "plan" in root;
  const hasQuestions = Array.isArray(root["questions"]);
  if (!hasPlan && !hasQuestions) {
    return {
      ok: false,
      refusal: "unparseable",
      detail: "the response carried neither a plan nor a questions array",
    };
  }

  const plan = trimPlan(planLines(root["plan"]));
  const { questions, dropped: refusedAtParse } = readQuestions(root["questions"], options.brief);
  const proposed = countProposed(root["questions"]);
  const selected = selectQuestions(questions, Math.min(options.cap, MAX_QUESTIONS_PER_TURN));

  return {
    ok: true,
    proposal: {
      plan: plan.lines,
      planNote: plan.note,
      // IDS ARE MINTED HERE, AFTER SELECTION, so the owner sees PQ-1, PQ-2, PQ-3
      // rather than PQ-1, PQ-4, PQ-7. A gap in the numbering is a question he was
      // never shown, and he would reasonably ask where it went.
      asked: selected.asked.map((question, offset) => ({
        ...question,
        id: mintQuestionId(options.firstOrdinal + offset),
      })),
      dropped: [...refusedAtParse, ...selected.dropped],
      proposed,
    },
  };
}

/* -------------------------------------------------------------------------
 * A follow-up turn: what the seat claims the owner just resolved
 * ---------------------------------------------------------------------- */

/**
 * The seat's CLAIM about one question, which is not yet a resolution.
 *
 * `quoted` MUST BE THE OWNER'S OWN WORDS, and `plan-state.ts` checks that it is a
 * literal substring of the turn before anything is recorded. The field exists so
 * that check is possible at all: without a span to verify, a seat asserting "he
 * answered PQ-2 with three" is unfalsifiable.
 */
export interface SeatResolution {
  readonly id: string;
  readonly kind: "answer" | "decline";
  /** The answer in the owner's terms, as the seat read it. */
  readonly answer: string;
  /** The span of the owner's turn the seat is reading it from. */
  readonly quoted: string;
}

export interface PlanSeatReply {
  /** The seat's short answer to whatever the owner asked. `""` when it said nothing. */
  readonly reply: string;
  /** What the host had to do to that reply, or null. */
  readonly replyNote: string | null;
  readonly resolutions: readonly SeatResolution[];
}

export type ParsedReply =
  | { readonly ok: true; readonly value: PlanSeatReply }
  | { readonly ok: false; readonly refusal: "unparseable"; readonly detail: string };

/**
 * Read a follow-up turn.
 *
 * A TURN WITH NO RESOLUTIONS IS ORDINARY, not an error: it is what the seat
 * returns when the owner asked a question of his own. A turn with neither a
 * reply nor resolutions is unparseable — the seat was called and said nothing at
 * all, and silently treating that as "no resolutions" would let a broken seat
 * burn the whole turn budget invisibly.
 */
export function parsePlanReply(raw: string): ParsedReply {
  const root = extractJsonObject(raw);
  if (root === null) {
    return { ok: false, refusal: "unparseable", detail: "no JSON object in the seat's response" };
  }

  const rawResolutions = Array.isArray(root["resolved"]) ? root["resolved"] : [];
  const replyText = typeof root["reply"] === "string" ? root["reply"].trim() : "";
  if (replyText.length === 0 && rawResolutions.length === 0) {
    return {
      ok: false,
      refusal: "unparseable",
      detail: "the response carried neither a reply nor any resolution",
    };
  }

  const reply = truncate(replyText, MAX_REPLY_CHARS);
  const resolutions: SeatResolution[] = [];
  for (const entry of rawResolutions) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = text(row["id"]);
    const quoted = text(row["quoted"]);
    if (id.length === 0 || quoted.length === 0) continue;
    const kind = row["kind"] === "decline" ? "decline" : "answer";
    resolutions.push({ id, kind, answer: text(row["answer"]), quoted });
  }

  return {
    ok: true,
    value: { reply: reply.value, replyNote: reply.note, resolutions },
  };
}

/* -------------------------------------------------------------------------
 * Reading the parts
 * ---------------------------------------------------------------------- */

interface ReadQuestions {
  readonly questions: readonly PlanQuestion[];
  readonly dropped: readonly DroppedQuestion[];
}

/**
 * Every proposed question, split into those that earn a place and those that do
 * not — with a reason attached to each of the second kind.
 *
 * THE ID IS BLANK AT THIS POINT AND THAT IS DELIBERATE. Selection reorders and
 * discards; a number assigned before it would either leave gaps in what the
 * owner sees or would have to be rewritten anyway. Nothing between here and
 * {@link parsePlanProposal}'s final map reads `id`.
 */
function readQuestions(raw: unknown, brief: string): ReadQuestions {
  if (!Array.isArray(raw)) return { questions: [], dropped: [] };

  const questions: PlanQuestion[] = [];
  const dropped: DroppedQuestion[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      dropped.push({ text: "", refusal: "no-criterion-pair", detail: "the entry was not an object" });
      continue;
    }
    const row = entry as Record<string, unknown>;
    const candidate: PlanQuestion = {
      id: "",
      text: text(row["text"]),
      ifUnanswered: text(row["ifUnanswered"]),
      criterionIfDefault: text(row["criterionIfDefault"]),
      criterionIfAnswered: text(row["criterionIfAnswered"]),
      tier: tierOf(row["tier"]),
    };

    const verdict = questionEarnsItsPlace(candidate, brief);
    if (!verdict.ok) {
      dropped.push({ text: candidate.text, refusal: verdict.refusal, detail: verdict.detail });
      continue;
    }
    questions.push(candidate);
  }

  return { questions, dropped };
}

function countProposed(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

/**
 * An unrecognised tier becomes QUALITY — the LOWEST rank.
 *
 * THE DIRECTION IS THE WHOLE DECISION. Defaulting to BLOCKING would let a seat
 * that emits a typo'd tier push a question to the front of the owner's attention,
 * which is the one resource this phase is spending. Failing towards the back
 * costs a good question a place in the ordering; failing towards the front costs
 * the owner an interruption he did not need.
 */
function tierOf(raw: unknown): PlanQuestionTier {
  const found = PLAN_QUESTION_TIERS.find((tier) => tier === raw);
  return found ?? "QUALITY";
}

function planLines(raw: unknown): readonly string[] {
  const joined = Array.isArray(raw) ? raw.filter((line) => typeof line === "string").join("\n") : text(raw);
  return joined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface TrimmedPlan {
  readonly lines: readonly string[];
  readonly note: string | null;
}

/**
 * Cut the plan to size and say what was cut.
 *
 * TWO CUTS, ONE NOTE. Lines past the limit are dropped and over-long lines are
 * shortened; both are recorded in one sentence, because the run log wants one
 * line and the owner wants to know that what he is reading is not all of it.
 */
function trimPlan(lines: readonly string[]): TrimmedPlan {
  if (lines.length === 0) {
    return { lines: [], note: "the seat returned no plan" };
  }

  const kept = lines.slice(0, MAX_PLAN_LINES);
  const notes: string[] = [];
  if (lines.length > MAX_PLAN_LINES) {
    notes.push(
      `the plan ran to ${String(lines.length)} lines; the last ${String(lines.length - MAX_PLAN_LINES)} were cut`,
    );
  }

  let shortened = 0;
  const bounded = kept.map((line) => {
    if (line.length <= MAX_PLAN_LINE_CHARS) return line;
    shortened += 1;
    return `${line.slice(0, MAX_PLAN_LINE_CHARS - 1)}…`;
  });
  if (shortened > 0) {
    notes.push(`${String(shortened)} line(s) were longer than ${String(MAX_PLAN_LINE_CHARS)} characters and were cut`);
  }

  return { lines: bounded, note: notes.length === 0 ? null : notes.join("; ") };
}

interface Truncated {
  readonly value: string;
  readonly note: string | null;
}

function truncate(value: string, limit: number): Truncated {
  if (value.length <= limit) return { value, note: null };
  return {
    value: `${value.slice(0, limit - 1)}…`,
    note: `the seat's reply ran to ${String(value.length)} characters and was cut to ${String(limit)}`,
  };
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The first JSON object in the response.
 *
 * FIRST BRACE TO LAST BRACE, because a seat asked for JSON routinely wraps it in
 * a fenced block or prefaces it with a sentence, and `judge.ts#parseReport`
 * already takes the first-brace approach for the same reason. The last-brace
 * bound is the one addition: `judge.ts` slices to the end of the string, which
 * fails on any trailing prose after the object, and a trailing "Let me know if
 * you'd like me to adjust these." is the single most common thing a chat model
 * appends.
 *
 * A NON-OBJECT JSON VALUE IS NOT AN OBJECT. `JSON.parse("[1,2]")` succeeds and is
 * rejected here, because everything downstream reads named fields.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
