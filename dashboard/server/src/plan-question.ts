/**
 * plan-question.ts — what makes a question worth an owner's attention.
 *
 * THE MEASUREMENT THIS EXISTS TO MOVE. Run `…3d4d1ccb` carried a detailed ticket
 * and `assumptions.md` recorded `inferredCriteria = 2`. Run `…052c6e02` carried
 * one sentence with two typos and recorded 16 — "Of 16 criteria: 15 inferred by
 * the grader, 1 house defaults, 0 traced to words you wrote". That run was
 * graded almost entirely against guesses. A phase that asks the owner two or
 * three questions BEFORE the suite is authored turns some of those guesses into
 * his own sentences, and the number falls.
 *
 * ─── THE FAILURE THIS FILE IS BUILT AGAINST, WHICH IS NOT "TOO FEW QUESTIONS" ───
 *
 * It is the generic question. "What colour scheme would you like?" costs the
 * owner attention, and whatever he answers, the criterion the spec seat writes
 * is the same sentence: the site has a coherent colour scheme. A phase that asks
 * five of those has spent five interruptions and moved `inferredCriteria` by
 * zero, while LOOKING like it worked. So the ranking is the feature and the
 * asking is not, and the rule below is CODE rather than a line in a prompt —
 * a prompt asking for good questions cannot be unit-tested, and this repository
 * has already shipped one docblock claiming four refusals over an implementation
 * with one.
 *
 * ─── THE RULE, MECHANICALLY ───
 *
 * A question earns its place iff the two acceptance criteria it names — the one
 * that gets authored if nobody answers, and the one that gets authored under a
 * different answer — DIFFER BY AT LEAST ONE CONTENT TOKEN.
 *
 * So the seat must emit, per question, both candidate criteria. A question that
 * cannot state what would differ has not made its case, and is dropped by this
 * module rather than argued with. Every other refusal here is a bound on the
 * owner's attention rather than on the question's value.
 *
 * WHY `contentTokens` AND NOT A NEW HEURISTIC. There is no vagueness lint in
 * this tree to reuse — grepped, none exists. `contentTokens`
 * (spec-assumptions.ts) is the only already-argued, already-tested content
 * filter here: STOPWORDS plus TICKET_BOILERPLATE, the second list built exactly
 * because "build, make, site, page, app, thing, nice, good" are contentful in
 * English and empty in this domain. A generic question's two candidates differ
 * only in those words. That is not a coincidence — it is the same observation
 * the assumptions tracer was built on, applied one phase earlier.
 *
 * THE NUMBERS BELOW ARE CHOSEN, NOT MEASURED. Five questions, three per turn,
 * 140 characters. Nothing has run yet that could calibrate them. They are named
 * constants so a measured change is a one-line change, and the only honest thing
 * to say about them today is written on each one.
 */

import { contentTokens } from "./spec-assumptions.js";

/* -------------------------------------------------------------------------
 * The model
 * ---------------------------------------------------------------------- */

/**
 * How much the answer would change, ordered by how much it would change.
 *
 * NOT A PRIORITY THE SEAT INVENTS FREELY — it is the first ranking key, so it is
 * the field a seat could use to push a favourite question to the top. It is
 * bounded by {@link questionEarnsItsPlace}, which does not read it: a BLOCKING
 * question whose two candidate criteria are identical is still refused, so the
 * tier can reorder the survivors and cannot create one.
 */
export type PlanQuestionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";

const TIER_RANK: Readonly<Record<PlanQuestionTier, number>> = Object.freeze({
  BLOCKING: 0,
  FUNCTIONAL: 1,
  QUALITY: 2,
});

/** Every tier, for the parser's membership test. Value export, not a type. */
export const PLAN_QUESTION_TIERS: readonly PlanQuestionTier[] = Object.freeze([
  "BLOCKING",
  "FUNCTIONAL",
  "QUALITY",
] as const);

/**
 * One question, with its own justification attached.
 *
 * `ifUnanswered` IS LOAD-BEARING IN THREE PLACES AND THAT IS WHY IT IS REQUIRED.
 * It is what the run assumes if the owner never answers; it is what a DECLINED
 * question records, so declining lands exactly where the run would have landed
 * had the question never been asked; and it is what an EXPIRED question writes
 * into `assumptions.md`. A question without one cannot be declined without
 * penalty, and "you decide" is a first-class answer in this design.
 */
export interface PlanQuestion {
  /** `PQ-1`, `PQ-2`, … Minted by {@link mintQuestionId}, never by the seat. */
  readonly id: string;
  /** One sentence, at most {@link MAX_QUESTION_CHARS}. */
  readonly text: string;
  /** What the run will assume if this is never answered. */
  readonly ifUnanswered: string;
  /** The criterion authored under `ifUnanswered`. */
  readonly criterionIfDefault: string;
  /** The criterion authored under some different answer. */
  readonly criterionIfAnswered: string;
  readonly tier: PlanQuestionTier;
}

/**
 * Every way a proposed question fails to reach the owner.
 *
 * EACH ONE IS SUFFICIENT ALONE, AND EACH ONE HAS ITS OWN MUTATION IN THE TEST
 * FILE. That sentence is the reason this union is enumerated rather than
 * collapsed into a boolean: the work immediately before this one shipped a
 * header claiming four refusals over an implementation that had one, and its
 * suite was green over it. A union member with no test that turns red when its
 * branch is deleted is the same defect wearing a different name.
 */
export type PlanQuestionRefusal =
  /** The entry carried no question at all. Its own member so the log names the real cause. */
  | "no-text"
  /** The seat named no candidate criteria, or only one of the two. */
  | "no-criterion-pair"
  /** Both candidates survive `contentTokens` as the same set — nothing changes. */
  | "criteria-do-not-differ"
  /** No `ifUnanswered`, so the question cannot be declined without penalty. */
  | "no-default"
  /** More than one sentence. */
  | "not-one-sentence"
  /** Past {@link MAX_QUESTION_CHARS}. */
  | "too-long"
  /** Every content token is already in the brief — the owner answered it. */
  | "answered-by-the-brief"
  /** A candidate criterion could only be graded by looking at an attachment. */
  | "criterion-needs-an-attachment"
  /** Same content tokens as a question already accepted this turn. */
  | "duplicate"
  /** Survived the rule, lost to the cap. */
  | "over-cap";

/**
 * A question that did not reach the owner, kept rather than discarded.
 *
 * THE HOUSE RULE IS THAT A BOUNDED LIST SAYS WHAT IT BOUNDED. Two different
 * defects are invisible without this record and neither raises an error: a seat
 * that proposes five questions of which zero survive (so the phase burned a call
 * and asked nothing), and a cap set so low that a BLOCKING question is being
 * dropped every run. Both are measurable from this list and from nothing else.
 *
 * `text` IS BEST-EFFORT. A question refused at parse time may not have had a
 * usable `text` field at all, in which case this is `""` and `detail` says so.
 */
export interface DroppedQuestion {
  readonly text: string;
  readonly refusal: PlanQuestionRefusal;
  /** One sentence naming what was wrong, for the run log. Never empty. */
  readonly detail: string;
}

/* -------------------------------------------------------------------------
 * The caps
 * ---------------------------------------------------------------------- */

/**
 * Questions the whole dialogue may ask, across every turn.
 *
 * CHOSEN, NOT MEASURED. The reasoning is the owner's "we dont want a wall of
 * text": five one-sentence questions is a thing a person reads and answers; ten
 * is a form, and a form gets closed. The cost of it being too low is bounded and
 * visible — the sixth question lands in {@link DroppedQuestion} with
 * `over-cap`, so a run that keeps dropping BLOCKING questions is countable.
 */
export const MAX_QUESTIONS_ASKED = 5;

/**
 * Questions one turn may put in front of the owner.
 *
 * Three, so the first thing he sees is three lines rather than five. The
 * remainder is not lost: it stays in the dialogue's budget for the next turn.
 */
export const MAX_QUESTIONS_PER_TURN = 3;

/**
 * Owner turns the dialogue may consume before it proceeds on what it has.
 *
 * SIX, AND REACHING IT IS NOT A FAILURE. A clarifying turn costs a turn and does
 * NOT cost an answer slot — that asymmetry is what makes "the owner can ask
 * back" free to use — so the cap has to leave room for a few of them alongside
 * the answers. On reaching it the run proceeds and records the rest as
 * assumptions, exactly as the park clock expiring does.
 */
export const MAX_OWNER_TURNS = 6;

/**
 * The longest a question may be.
 *
 * 140 characters is CHOSEN. It is roughly one line of chat, and the owner's
 * constraint was "a question is one sentence", not "a question is N characters"
 * — the character bound exists because a single sentence can still be a
 * paragraph, and {@link isOneSentence} is deliberately shallow.
 */
export const MAX_QUESTION_CHARS = 140;

/* -------------------------------------------------------------------------
 * Brevity
 * ---------------------------------------------------------------------- */

/**
 * One sentence, judged shallowly and deliberately so.
 *
 * THE TEST: strip trailing terminators, then look for a terminator followed by
 * whitespace and a capital. That misses "Should it have a contact form? a
 * newsletter?" (lowercase after the mark) and it misses an abbreviation split
 * ("Should the copy say Inc. or Ltd.?" is NOT flagged, because `or` is
 * lowercase — the capitalised variant would be).
 *
 * SHALLOW IS THE SAFE DIRECTION, for the reason spec-assumptions.ts gives about
 * stemming: an aggressive splitter manufactures refusals the way an aggressive
 * stemmer manufactures overlap, and a refused GOOD question costs the owner the
 * one thing this phase is for. A missed two-sentence question costs him a
 * slightly long line. The errors are not symmetric and this breaks toward
 * asking.
 */
export function isOneSentence(text: string): boolean {
  const body = text.trim().replace(/[.?!]+$/, "");
  return !/[.?!]\s+[A-Z]/.test(body);
}

/* -------------------------------------------------------------------------
 * THE WORTH RULE
 * ---------------------------------------------------------------------- */

export type QuestionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: PlanQuestionRefusal; readonly detail: string };

const EARNED: QuestionVerdict = Object.freeze({ ok: true });

/**
 * Words that name something the criteria author cannot open.
 *
 * WHY A CRITERION CARRYING ONE IS REFUSED. `ticket-refs.ts`'s header states the
 * rule this enforces: the spec seat runs `tools: []` and is TEXT ONLY, so "a
 * criterion written about an unseen image is worse than no criterion, because it
 * grades green or red for reasons nothing can trace". The plan phase is the first
 * seat allowed to KNOW an image exists, and the temptation it creates is a
 * question whose answer produces "the layout matches the reference image" — a
 * sentence that reads like a requirement and cannot be graded by anything.
 *
 * THE RULE APPLIES TO THE TWO CANDIDATE CRITERIA AND NOT TO THE QUESTION TEXT,
 * and that asymmetry is the entire point of asking. The QUESTION goes to the
 * owner, who can see his own attachment — "which of the two should the layout
 * follow?" is a fair thing to ask him. The CRITERION goes to a seat that cannot,
 * so it has to be his answer in words: "the page is a two-column grid", not "the
 * page matches the image". A question that cannot state its criteria that way has
 * not converted the picture into a sentence, which was the only reason to ask.
 *
 * `photo` AND `photograph` ARE DELIBERATELY ABSENT. "the hero shows a photograph
 * of the owner" is gradeable by looking at the artefact's markup; it names a
 * thing on the page rather than a file the grader would have to open.
 */
const UNGRADEABLE_REFERENCES: readonly string[] = [
  "image",
  "images",
  "screenshot",
  "screenshots",
  "mockup",
  "mockups",
  "attachment",
  "attachments",
  "attached",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "pdf",
  "docx",
];

/**
 * Does this question earn an interruption?
 *
 * FIVE REFUSALS, AND EVERY ONE OF THEM IS REACHABLE ON ITS OWN. `no-criterion-pair`
 * and `no-default` are checked here as well as at the parse boundary, because a
 * field can be present and blank; the parser rejects absent, this rejects empty.
 * The order below is the order they are checked, and it is the order of how
 * cheaply each can be decided — nothing depends on it.
 *
 * WHAT THIS FUNCTION CANNOT DO. It reads the two candidate criteria the SEAT
 * wrote. A seat that invents a plausible pair for a worthless question passes
 * this check. The bound is that it must invent a pair that differs in a word the
 * domain filter keeps, which is a much narrower kind of lie than "ask anything",
 * and the pair is recorded so a human reading the run can see the claim. It is a
 * bound, not a proof, and the test file drives exactly that adversarial case.
 */
export function questionEarnsItsPlace(question: PlanQuestion, brief: string): QuestionVerdict {
  const text = question.text.trim();

  if (text.length === 0) {
    // ITS OWN MEMBER, not the criterion-pair one. Without the branch this falls
    // through to `answered-by-the-brief` — the empty token set is trivially a
    // subset of anything — and the run log would name the ticket as the reason a
    // question the seat never wrote was dropped.
    return { ok: false, refusal: "no-text", detail: "the entry carried no question" };
  }
  if (text.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      refusal: "too-long",
      detail: `${String(text.length)} characters, past the ${String(MAX_QUESTION_CHARS)}-character bound on one line of chat`,
    };
  }
  if (!isOneSentence(text)) {
    return { ok: false, refusal: "not-one-sentence", detail: "more than one sentence in a question" };
  }
  if (question.ifUnanswered.trim().length === 0) {
    return {
      ok: false,
      refusal: "no-default",
      detail: "no stated assumption, so declining it could not be free of penalty",
    };
  }

  const ifDefault = new Set(contentTokens(question.criterionIfDefault));
  const ifAnswered = new Set(contentTokens(question.criterionIfAnswered));
  if (question.criterionIfDefault.trim().length === 0 || question.criterionIfAnswered.trim().length === 0) {
    return {
      ok: false,
      refusal: "no-criterion-pair",
      detail: "the question did not name both criteria, so nothing shows what the answer would change",
    };
  }
  if (sameSet(ifDefault, ifAnswered)) {
    return {
      ok: false,
      refusal: "criteria-do-not-differ",
      detail:
        "both criteria carry the same content words, so whatever the owner answers the same criterion gets written",
    };
  }

  const ungradeable = namesAnAttachment(question.criterionIfDefault) || namesAnAttachment(question.criterionIfAnswered);
  if (ungradeable !== null) {
    return {
      ok: false,
      refusal: "criterion-needs-an-attachment",
      detail: `a candidate criterion says "${ungradeable}" — the seat that grades it runs tools: [] and cannot open one`,
    };
  }

  const briefTokens = new Set(contentTokens(brief));
  const asked = contentTokens(text);
  if (asked.every((token) => briefTokens.has(token))) {
    return {
      ok: false,
      refusal: "answered-by-the-brief",
      detail: "every content word in the question is already in the ticket",
    };
  }

  return EARNED;
}

/**
 * How far apart the two candidate criteria are, in content tokens.
 *
 * The size of the symmetric difference. This is the second ranking key and it is
 * exported because it is the number a test can assert against: a question whose
 * answer swings the criterion from three cards to six scores higher than one
 * that swings a heading's wording, and that ordering is checkable without
 * reading any prose.
 */
export function questionSeparation(question: PlanQuestion): number {
  const a = new Set(contentTokens(question.criterionIfDefault));
  const b = new Set(contentTokens(question.criterionIfAnswered));
  let apart = 0;
  for (const token of a) if (!b.has(token)) apart += 1;
  for (const token of b) if (!a.has(token)) apart += 1;
  return apart;
}

/* -------------------------------------------------------------------------
 * Ranking and the cap
 * ---------------------------------------------------------------------- */

/**
 * Rank by how much the answer would change the build, never by how easy it is
 * to ask.
 *
 * Tier first, then separation descending, then the seat's own order to keep the
 * sort stable and reproducible. A NEW ARRAY IS RETURNED — the input is not
 * sorted in place, because the caller's order is the tiebreak and mutating it
 * would make the tiebreak depend on how many times this ran.
 */
export function rankQuestions(questions: readonly PlanQuestion[]): readonly PlanQuestion[] {
  return questions
    .map((question, index) => ({ question, index, apart: questionSeparation(question) }))
    .sort((left, right) => {
      const tier = TIER_RANK[left.question.tier] - TIER_RANK[right.question.tier];
      if (tier !== 0) return tier;
      if (left.apart !== right.apart) return right.apart - left.apart;
      return left.index - right.index;
    })
    .map((entry) => entry.question);
}

export interface CappedQuestions {
  readonly asked: readonly PlanQuestion[];
  readonly dropped: readonly DroppedQuestion[];
}

/**
 * Apply the cap AFTER ranking, and say what it dropped.
 *
 * THE RECORD IS THE POINT. A bare `slice` here would be shorter and would make
 * the two defects named on {@link DroppedQuestion} invisible: a cap that is
 * eating BLOCKING questions every run looks identical, from outside, to a cap
 * that never binds. The `detail` names the rank the question held, so the log
 * can say "dropped at rank 6 of 7" rather than "dropped".
 *
 * A NON-POSITIVE CAP IS NOT AN ERROR. It is the state of a dialogue that has
 * already spent its whole budget, and the correct behaviour is that everything
 * is recorded as `over-cap` and nothing is asked.
 */
export function capQuestions(ranked: readonly PlanQuestion[], cap: number): CappedQuestions {
  const limit = Math.max(0, cap);
  const asked = ranked.slice(0, limit);
  const dropped = ranked.slice(limit).map((question, offset) => ({
    text: question.text,
    refusal: "over-cap" as const,
    detail:
      `ranked ${String(limit + offset + 1)} of ${String(ranked.length)}, past the ${String(limit)} this turn could ask ` +
      `— it assumes: ${question.ifUnanswered}`,
  }));
  return { asked, dropped };
}

/**
 * Rank, drop duplicates, cap. The whole selection, in the order it must happen.
 *
 * DUPLICATES ARE DROPPED AFTER RANKING AND NOT BEFORE, so the survivor of a pair
 * is the better-ranked one rather than whichever the seat happened to write
 * first. Two questions are duplicates when their texts reduce to the same
 * content-token set: "How many projects should the portfolio show?" and "Show
 * how many projects in the portfolio?" are one question asked twice, and asking
 * both is the wall of text in miniature.
 */
export function selectQuestions(questions: readonly PlanQuestion[], cap: number): CappedQuestions {
  const ranked = rankQuestions(questions);
  const seen: Set<string>[] = [];
  const unique: PlanQuestion[] = [];
  const dropped: DroppedQuestion[] = [];

  for (const question of ranked) {
    const tokens = new Set(contentTokens(question.text));
    if (seen.some((earlier) => sameSet(earlier, tokens))) {
      dropped.push({
        text: question.text,
        refusal: "duplicate",
        detail: "the same content words as a question already accepted this turn",
      });
      continue;
    }
    seen.push(tokens);
    unique.push(question);
  }

  const capped = capQuestions(unique, cap);
  return { asked: capped.asked, dropped: [...dropped, ...capped.dropped] };
}

/* -------------------------------------------------------------------------
 * Ids
 * ---------------------------------------------------------------------- */

/**
 * `PQ-<n>`, minted by the host.
 *
 * THE SEAT NEVER SUPPLIES AN ID, and that is a boundary rather than tidiness.
 * The host's open-question set is keyed by these; a seat that could choose its
 * own id could name one that is already answered, or one that never existed, and
 * the arbiter in `plan-state.ts` would then be checking a claim against a key the
 * claimant chose. Ids are handed out here and only matched there.
 */
export function mintQuestionId(ordinal: number): string {
  return `PQ-${String(ordinal)}`;
}

/** Every `PQ-<n>` in a string, in order of appearance, de-duplicated. */
export function questionIdsIn(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bPQ-(\d+)\b/gi)) {
    found.add(mintQuestionId(Number(match[1])));
  }
  return [...found];
}

/** The offending word, or null. Returns the word so the refusal can name it. */
function namesAnAttachment(criterion: string): string | null {
  const words = new Set(criterion.toLowerCase().split(/[^a-z0-9]+/));
  return UNGRADEABLE_REFERENCES.find((word) => words.has(word)) ?? null;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
