/**
 * plan-seat.ts — the call, and what the planning seat is shown.
 *
 * NOTHING HERE IMPORTS THE SDK. The caller arrives as {@link PlanSeatCaller}, a
 * structural type with one method, and every bakeoff import in this file is
 * `import type`. That is what makes the adversarial cases reachable in a unit
 * test at all: a seat that returns an essay, a seat that proposes five generic
 * questions, a seat that fabricates a quoted span. Wiring it to a real
 * `SubscriptionSeatCaller` is the orchestrator's job and it satisfies this
 * interface by construction.
 *
 * ─── REFERENCE IMAGES: THE SEAT LOOKS AT THE DESIGN (2026-08-02) ───
 *
 * WHAT THIS FILE USED TO DO AND WHY IT IS GONE. Until today this module exported
 * `PLAN_SEAT_CAN_READ_FILES = false` and told the seat, in capitals, "THE OWNER
 * ATTACHED N REFERENCE IMAGE(S), AND YOU CANNOT OPEN THEM … What you CAN do is
 * ask him about them, because he can see them." The measurement under that was
 * right — `SubscriptionSeatCaller` builds every call with `tools: []`, so a PATH
 * in a prompt names a file the seat cannot open — and the conclusion drawn from
 * it was wrong, because a path is not the only way a picture can travel. The
 * owner ruled the behaviour out in those terms: "the design images need to be
 * analysed and seen not quizzed by me as they are visual reference", and "there
 * would be no point me attaching the image if it cant read it".
 *
 * WHAT CHANGED UNDERNEATH. `subscription-caller.ts` now carries images as CONTENT
 * BLOCKS inside the same streamed user message documents already ride in
 * ({@link SeatImagePlan}, `planSeatImages`, `SubscriptionCallerOptions.images`),
 * measured by `subscription-caller.images.test.ts` and by a real send in
 * `subscription-caller.live.test.ts`. `tools: []` does not block them: an image
 * is CONTENT, not a tool call. So the seat sees the design, and this module's job
 * is no longer to apologise for a blindness that no longer exists.
 *
 * THE PROMPT DESCRIBES WHAT THE WIRE CARRIES, AND CANNOT DRIFT FROM IT.
 * {@link PlanSeatInput.images} is COUNTS, derived by {@link planSeatImagesFrom}
 * from the caller's own {@link SeatImagePlan} — the very value `seatPrompt` puts
 * on the wire (`orchestrator.ts#planSeat` reads `caller.imagePlan`). So "they ARE
 * IN THIS MESSAGE" is true by construction: delete the `images:` option from the
 * caller and the plan becomes `NO_SEAT_IMAGES`, and this prompt silently stops
 * claiming anything. THAT IS DELIBERATE, AND IT STANDS IN FOR A TEST THAT CANNOT
 * EXIST — the real caller's constructor runs only on the branch that spawns the
 * CLI, so no unit test can watch that one argument go missing. Deriving the
 * sentence from the plan means the failure it would cause is not "the prompt
 * lies" but "the prompt says nothing", which is safe.
 *
 * THREE STATES, NOT TWO. None attached; at least one carried; attached and NONE
 * carried (too large, unreadable, over the per-call budget). The third is real —
 * `MAX_SEAT_IMAGE_BYTES` is 4 MB and the intake accepts 8 — and it is NOT the old
 * branch wearing a new hat: "this file was 6 MB" is a fact about a file, and the
 * seat is told which one, by name, in a section `planSeatImages` puts in the same
 * message. No state says "you cannot open them", because that is no longer true.
 *
 * THE CLOSING RULE OF THE OLD BRANCH SURVIVES, because it was the correct half: a
 * criterion must be checkable on the finished page by someone who does NOT have
 * the picture. This seat is the only one in the run that ever sees it — the spec
 * seat and the grader do not — so "the hero matches the reference" is still a
 * wish and "the hero headline is condensed uppercase, at least 64px" is still a
 * criterion. `plan-question.ts` enforces it (`criterion-needs-an-attachment`) and
 * {@link IMAGE_QUESTION_EXAMPLE} is pinned against that enforcement by a test, so
 * the prompt cannot teach a shape the host discards.
 *
 * THE SPEC SEAT IS DELIBERATELY LEFT BLIND, AND THE RECORDED REASON STILL HOLDS.
 * `ticket-refs.ts` withholds images from it because "a criterion written about an
 * unseen image grades green or red for reasons nothing can trace" — an argument
 * about an UNSEEN image, which the spec seat's would still be. What reaches it is
 * the plan phase's output: the owner's own sentences, plus criteria this seat
 * wrote in words a text-only grader can check. That is traceable by construction,
 * which giving the spec seat the picture would not be — it would author from a
 * source its own auditor cannot see. `plan-brief.ts#redactHostPaths` keeps the
 * route closed on the way back through the fold.
 */

import type { SeatCallRequest, SeatCallResult } from "bakeoff/dist/anthropic-seat.js";
import type { PlanQuestion } from "./plan-question.js";
import { MAX_QUESTION_CHARS } from "./plan-question.js";
import type { ClassifiedReply } from "./plan-state.js";
import type { ParsedProposal, ParsedReply } from "./plan-turn.js";
import { MAX_PLAN_LINES, MAX_REPLY_CHARS, parsePlanProposal, parsePlanReply } from "./plan-turn.js";
// TYPE-ONLY, WHICH IS WHAT KEEPS THE HEADER'S FIRST CLAIM TRUE. `SeatImagePlan`
// is a shape; importing the module's VALUES would pull the agent SDK into every
// process that renders a prompt, and into this module's own unit test.
import type { SeatImagePlan } from "./subscription-caller.js";

/**
 * The subset of a seat caller this module needs.
 *
 * ONE METHOD, STRUCTURALLY TYPED. `SubscriptionSeatCaller` satisfies it without
 * being named here, and a test stub satisfies it in four lines.
 */
export interface PlanSeatCaller {
  call(request: SeatCallRequest): Promise<SeatCallResult>;
}

/**
 * Output tokens for one planning turn.
 *
 * ─── 4000 → 16000, BECAUSE THE NUMBER STOPPED BEING DECORATIVE (2026-08-04) ───
 *
 * WHAT THIS CONSTANT USED TO SAY: "CHOSEN. A plan of at most
 * {@link MAX_PLAN_LINES} lines and at most three one-sentence questions with two
 * candidate criteria each is a few hundred tokens; this leaves room for the
 * model's own preamble, which the parser throws away. It is small ON PURPOSE —
 * an overrun shows up as a truncated stop reason rather than as a seat that
 * wrote an essay nobody bounded."
 *
 * WHY THAT WAS SAFE TO BELIEVE AND IS NOT SAFE TO KEEP. On the subscription path
 * this number never reached the model: `subscription-caller.ts` had no SDK option
 * to put it in, so the CLI's own 64,000 default governed every plan turn ever
 * measured, and 4000 was an assertion checked after the fact against a
 * `stop_reason` that was itself unreachable. The caller now sends it as
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, so for the first time it CUTS.
 *
 * AND AT 4000 IT WOULD HAVE CUT REAL WORK. Seven plan turns are on record in
 * `dashboard/data/runs.db` (the `plan seat — anthropic: … N output` lines): 273,
 * 314, 324, 346, 710, 1149 and 3763 output tokens. The largest is 94% of 4000. A
 * ceiling one bad turn away from the largest thing ever measured is not a
 * boundary, it is a coin flip.
 *
 * WHERE THE 3763 WENT, WHICH IS THE ACTUAL DERIVATION. It is not plan text. The
 * parsed content is hard-bounded by this module's own parser — {@link
 * MAX_PLAN_LINES} lines plus at most three questions of {@link
 * MAX_QUESTION_CHARS} characters with three short criteria strings each, a few
 * hundred tokens in total — so nearly all of that turn was ADAPTIVE THINKING,
 * which is billed as output AND counts against `max_tokens` (the same coupling
 * `bakeoff/src/spec-types.ts` reasons about for the spec seat). Nothing in this
 * repository bounds a thinking pass. So the ceiling has to clear the largest
 * thinking pass observed, not the largest plan.
 *
 * 16000 IS FOUR TIMES THE LARGEST TURN ON RECORD, and it is still an eighth of
 * the streamable ceiling — so the old constant's real intent survives: this seat
 * remains bounded far below anything the spec seat may spend, and a genuinely
 * runaway turn is still cut. What it no longer does is cut the turn that
 * actually happened.
 *
 * IT IS SEVEN SAMPLES, AND THAT IS THE WEAKNESS. Every one of them was drawn
 * with no ceiling in force, which makes them an honest picture of what this seat
 * WANTS to spend, and none of them was drawn with a large attachment set. If a
 * plan turn ever comes back with `stopReason: "max_tokens"`, this number is the
 * thing to raise — the seat's parse will refuse and the phase will ask nothing,
 * which is a bad turn rather than a failed run, but it is still a loss.
 */
export const PLAN_SEAT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * How many of the owner's pictures are in this message, and how many are not.
 *
 * COUNTS, NOT PATHS — a path names a file this seat still cannot open — AND NOT
 * LABELS EITHER. The labels are already in the message and are put there by the
 * code that decided them: `planSeatImages` renders a roster naming every carried
 * block IN BLOCK ORDER, and an `undelivered` section naming every image that
 * could not be carried and why. A second list here would be this module's own
 * account of the same facts, free to drift from the one on the wire.
 */
export interface PlanSeatImages {
  /** In this message as image blocks. `SeatImagePlan.blocks.length`. */
  readonly carried: number;
  /** Attached and absent — unreadable, empty, over the per-image cap or over budget. */
  readonly missing: number;
}

/** A turn with no pictures in it: the pre-image prompt, exactly. */
export const NO_PLAN_SEAT_IMAGES: PlanSeatImages = Object.freeze({ carried: 0, missing: 0 });

/**
 * Read the two counts off the plan that GOES ON THE WIRE.
 *
 * `notes` HAS EXACTLY ONE ENTRY PER IMAGE THE CALLER WAS GIVEN — `planSeatImages`
 * pushes one in the carried branch and one in the refused branch, and there is no
 * third — so `notes.length - blocks.length` is the number that did not travel,
 * computed from the plan rather than from a count this module was told separately.
 * That is the whole point: the prompt cannot claim an image the message lacks,
 * because both numbers come out of the message's own plan.
 */
export function planSeatImagesFrom(plan: SeatImagePlan): PlanSeatImages {
  return { carried: plan.blocks.length, missing: plan.notes.length - plan.blocks.length };
}

/**
 * The worked example the opening prompt shows once the seat can SEE the design.
 *
 * A CONSTANT RATHER THAN PROSE IN THE PROMPT BECAUSE IT IS PINNED: a test runs it
 * through `questionEarnsItsPlace`, the host's own filter, and it must survive.
 * A prompt that teaches a question shape the host silently discards is the exact
 * failure `plan-question.ts` exists to catch, moved one level earlier — and it
 * would be invisible, because the seat would look diligent and land nothing.
 *
 * WHY THIS QUESTION AND NOT "WHAT COLOUR SCHEME?". Looking harder at the boards
 * cannot settle it. Both are in front of the seat, they disagree, and only the
 * owner knows which one governs — and the two criteria it decides between are
 * both checkable on the finished page by someone holding no picture.
 */
export const IMAGE_QUESTION_EXAMPLE: Omit<PlanQuestion, "id"> = Object.freeze({
  text: "The two boards disagree on the nav — is it the fixed top bar or the side rail?",
  ifUnanswered: "the fixed top bar, which is what the first board shows",
  criterionIfDefault: "The nav is a bar fixed to the top of the viewport and stays put on scroll.",
  criterionIfAnswered: "The nav is a vertical rail down the left edge, visible without scrolling.",
  tier: "FUNCTIONAL",
});

/**
 * What the seat is given.
 *
 * `images` AND `documentNotes` RATHER THAN THE FILES. The pictures themselves
 * travel as content blocks in the same message, put there by the caller; what
 * this prompt needs is how many of them made it, so that what it SAYS about them
 * is what the message actually holds. Documents are still summarised as the
 * intake's own one-line notes.
 */
export interface PlanSeatInput {
  /** The composed brief — the owner's prose plus any site capture block. */
  readonly brief: string;
  /** How many reference images this message carries, and how many it does not. */
  readonly images: PlanSeatImages;
  /** One sentence per attached document, from `SeatDocumentPlan.notes`. */
  readonly documentNotes: readonly string[];
  /** The URL the dashboard read, when the ticket named one. */
  readonly capturedUrl: string | null;
  /** How many questions this turn may ask. */
  readonly cap: number;
  /** The next unused `PQ-n` ordinal. */
  readonly firstOrdinal: number;
}

export interface PlanFollowUpInput {
  readonly brief: string;
  readonly plan: readonly string[];
  /** The questions still outstanding, which are the only ones a turn may resolve. */
  readonly open: readonly PlanQuestion[];
  /** The owner's message, verbatim. The seat must quote from this and only this. */
  readonly ownerText: string;
  /** How the host classified it. The seat is TOLD, not asked. */
  readonly classified: ClassifiedReply;
  /**
   * The pictures THIS call carries — re-sent, because a call carries no memory of
   * the last one. A seat told about them only on the opening turn would be a seat
   * writing down the owner's answer with the design out of view.
   */
  readonly images: PlanSeatImages;
}

/* -------------------------------------------------------------------------
 * The system prompt
 * ---------------------------------------------------------------------- */

/**
 * Frozen, and it is the cache breakpoint — nothing per-run is interpolated here.
 *
 * IT DOES NOT ASK FOR GOOD QUESTIONS AND HOPE. Everything this prompt says about
 * worth is also checked in `plan-question.ts`, which is what makes the claim
 * testable; the prompt exists to raise the hit rate, not to be the mechanism.
 * Say the rule twice, enforce it once.
 */
export const PLAN_SEAT_SYSTEM = [
  "You are the PLANNING SEAT of an automated build dashboard. A person has just",
  "submitted a ticket. Before any acceptance criteria are written, you get one",
  "chance to ask him things.",
  "",
  "YOUR OUTPUT COSTS HIM ATTENTION AND NOTHING ELSE. Every question you ask is an",
  "interruption. A question is worth asking ONLY if a different answer would",
  "produce a DIFFERENT ACCEPTANCE CRITERION. 'What colour scheme would you like?'",
  "is worthless: whatever he answers, the criterion is 'the site has a coherent",
  "colour scheme'. 'How many projects should the portfolio show?' is worth asking:",
  "three cards and six cards are different criteria.",
  "",
  "SO YOU MUST STATE, FOR EVERY QUESTION, THE TWO CRITERIA IT DECIDES BETWEEN — the",
  "one that gets written if he never answers, and the one that gets written under",
  "some different answer. A question whose two criteria say the same thing in",
  "different words is DISCARDED by the host before he ever sees it. You are not",
  "arguing with anyone about this; you are being filtered.",
  "",
  "ASKING NOTHING IS A GOOD OUTCOME. A detailed ticket has nothing worth asking.",
  "Return an empty questions array and say so in the plan. Padding the list to look",
  "diligent wastes the one resource this phase spends.",
  "",
  "THE CRITERIA YOU NAME MUST BE GRADEABLE BY SOMETHING THAT CANNOT OPEN A FILE.",
  "The seat that writes the real criteria is text-only: it has no tools, cannot",
  "read an image and cannot open a URL. So 'the layout matches the reference image'",
  "is not a criterion, it is a wish. YOU MAY BE HOLDING HIS REFERENCE IMAGES — the",
  "turn below says so when you are, and you are the only seat in this run that ever",
  "sees them — so convert what you SEE into words: which layout, how many columns,",
  "how large the heading. Name criteria a person reading the built page could check",
  "without looking at anything else.",
  "",
  "BREVITY IS A HARD BOUND, NOT A PREFERENCE.",
  `  - Each question: ONE sentence, at most ${String(MAX_QUESTION_CHARS)} characters. Plain language.`,
  `  - The plan: at most ${String(MAX_PLAN_LINES)} short lines. He reads it in fifteen seconds.`,
  "  - Do not explain yourself pre-emptively. If he wants to know why you asked, he",
  "    will ask, and you answer then.",
  "",
  "RANK your questions by how much the answer changes the build, never by how easy",
  "they are to ask. Tier BLOCKING if the build cannot sensibly start without it,",
  "FUNCTIONAL if it changes what gets built, QUALITY if it changes how it looks.",
  "",
  "Reply with JSON only.",
].join("\n");

/** The shape asked for on the opening turn. Applied as `output_config.format`. */
export const PLAN_PROPOSAL_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  properties: {
    plan: { type: "array", items: { type: "string" }, description: "at most six short lines" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "one sentence, plain language" },
          ifUnanswered: { type: "string", description: "what the run will assume if he never answers" },
          criterionIfDefault: { type: "string", description: "the criterion written under that assumption" },
          criterionIfAnswered: { type: "string", description: "the criterion written under a different answer" },
          tier: { type: "string", enum: ["BLOCKING", "FUNCTIONAL", "QUALITY"] },
        },
        required: ["text", "ifUnanswered", "criterionIfDefault", "criterionIfAnswered", "tier"],
      },
    },
  },
  required: ["plan", "questions"],
});

/** The shape asked for on a follow-up turn. */
export const PLAN_REPLY_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  properties: {
    reply: { type: "string", description: "a short answer to whatever he asked; empty if he asked nothing" },
    resolved: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "the PQ-n he addressed" },
          kind: { type: "string", enum: ["answer", "decline"] },
          answer: { type: "string", description: "his answer in his terms" },
          quoted: { type: "string", description: "the span of HIS message this rests on, verbatim" },
        },
        required: ["id", "kind", "answer", "quoted"],
      },
    },
  },
  required: ["reply", "resolved"],
});

/* -------------------------------------------------------------------------
 * The user turns
 * ---------------------------------------------------------------------- */

/**
 * The opening turn's prompt.
 *
 * THE ATTACHMENT BLOCK IS THE ONLY BRANCH, and every arm of it is honest about
 * what the message actually holds — see {@link imageLines}, whose three states
 * come from the caller's own plan rather than from an attachment count.
 */
export function planOpeningTurn(input: PlanSeatInput): string {
  const lines: string[] = [
    "THE TICKET, VERBATIM",
    "",
    input.brief,
    "",
    ...attachmentLines(input),
    `Ask at most ${String(input.cap)} question(s) this turn, or none.`,
  ];
  return lines.join("\n");
}

function attachmentLines(input: PlanSeatInput): readonly string[] {
  const lines: string[] = [];

  if (input.capturedUrl !== null) {
    lines.push(
      `THE TICKET NAMED ${input.capturedUrl}. The dashboard's reading of that page is in the`,
      "ticket above, between markers. It is a partial automated summary of one page's",
      "markup, not the page — anything it does not mention may still be there.",
      "",
    );
  }

  if (input.documentNotes.length > 0) {
    lines.push(
      `THE OWNER ATTACHED ${String(input.documentNotes.length)} DOCUMENT(S):`,
      ...input.documentNotes.map((note) => `  - ${note}`),
      "",
    );
  }

  return [...lines, ...imageLines(input.images)];
}

/**
 * What to say about the owner's pictures. THREE STATES, and the counts decide
 * which — never an attachment count, which is how a prompt comes to describe a
 * message it is not in.
 *
 * STATE 2 (at least one carried) IS WHAT THIS FEATURE IS FOR, and it says two
 * things the old blind branch could not: LOOK, and here is the shape of a
 * question that is still worth asking once you have looked. The second half is
 * not politeness — a seat holding the design and still asking "what colour
 * scheme?" has spent the owner's one interruption on something it could read off
 * the picture, which is the failure he named in the words this file's header
 * quotes.
 *
 * STATE 3 (attached, none carried) KEEPS THE OLD BRANCH'S ADVICE — ask him,
 * because he can see them — WITHOUT THE OLD BRANCH'S CLAIM. "You cannot open
 * them" was a statement about the seat; "this one is 6 MB and the cap is 4" is a
 * statement about a file, it is per-image, and `planSeatImages` has already put
 * the name and the reason in this same message.
 *
 * THE CLOSING RULE IS REPEATED IN BOTH ARMS ON PURPOSE. It is the one thing that
 * did not change when the seat gained eyes, and it is the thing eyes make easiest
 * to forget: everything downstream of this seat is still blind.
 */
function imageLines(images: PlanSeatImages): readonly string[] {
  if (images.carried === 0 && images.missing === 0) return [];

  if (images.carried === 0) {
    return [
      `THE OWNER ATTACHED ${String(images.missing)} REFERENCE IMAGE(S) AND NONE OF THEM COULD BE CARRIED`,
      "INTO THIS MESSAGE. A section below names each one and the reason it is absent —",
      "that reason is about the file, not about what you are able to do. Do not describe",
      "them and do not guess what is in them.",
      "",
      "What you CAN do is ask him about them, because he can see them. Ask which one",
      "governs, or what he wants taken from it — and the two criteria you name must be",
      "checkable on the finished page by someone who does not have the picture.",
      "",
    ];
  }

  return [
    `THE OWNER ATTACHED ${String(images.carried)} REFERENCE IMAGE(S) AND THEY ARE IN THIS MESSAGE, as`,
    "image blocks. LOOK AT THEM. They are visual reference — he attached them so that",
    "they would be seen — and a roster below names them in the order they appear.",
    "",
    ...(images.missing === 0
      ? []
      : [
          `${String(images.missing)} MORE WERE ATTACHED AND ARE NOT HERE; a section below names each and why.`,
          "You are looking at part of the design and not all of it. Do not describe those,",
          "and say so plainly if what you cannot see is what a question was going to be about.",
          "",
        ]),
    "SO DO NOT ASK HIM WHAT IS IN A PICTURE YOU ARE HOLDING. Ask what the picture",
    "LEAVES OPEN — what looking harder cannot settle:",
    "  - two references disagree and only he knows which one governs;",
    "  - something you can see could be decoration or could be a requirement;",
    "  - a placeholder is hand-lettered or greeked and only he knows what it should say;",
    "  - a count you can see may be a sketch rather than the number he wants.",
    "",
    "ONE THAT EARNS ITS PLACE, IN FULL:",
    `  ask: ${IMAGE_QUESTION_EXAMPLE.text}`,
    `  if he never answers: ${IMAGE_QUESTION_EXAMPLE.criterionIfDefault}`,
    `  under a different answer: ${IMAGE_QUESTION_EXAMPLE.criterionIfAnswered}`,
    "",
    "AND THE CRITERIA YOU NAME MUST BE CHECKABLE BY SOMEONE WHO DOES NOT HAVE THE",
    "PICTURE, because nothing downstream of you has it. 'The hero matches the",
    "reference' is not a criterion, it is a wish. 'The hero headline is condensed",
    "uppercase and at least 64px' is one: it is what you SAW, written so that a person",
    "looking only at the finished page can say yes or no. A candidate criterion naming",
    "an image, a mockup or an attachment is DISCARDED by the host before he ever sees",
    "the question.",
    "",
  ];
}

/**
 * A follow-up turn's prompt.
 *
 * THE HOST'S CLASSIFICATION IS STATED, NOT REQUESTED. The seat is told whether
 * this message was an answer, a decline or a question, and which question it was
 * about, because `plan-state.ts` has already decided — from the client's own
 * structural signal where there was one. A seat asked to classify the message
 * would be a model deciding whether its own question got answered, which is the
 * failure the whole state machine exists to prevent.
 *
 * THE PICTURES RIDE THIS TURN TOO, AND THAT IS THE CALLER'S DOING RATHER THAN
 * THIS FUNCTION'S. `SubscriptionCallerOptions.images` is fixed at construction
 * and `seatPrompt` rebuilds the message per call, so every follow-up carries the
 * blocks the opening carried. What is needed HERE is to say so: a call carries no
 * memory of the last one, and a seat that is holding the design without being
 * told will write the owner's answer down without looking at it.
 */
export function planFollowUpTurn(input: PlanFollowUpInput): string {
  const open =
    input.open.length === 0
      ? ["  (none)"]
      : input.open.map((question) => `  ${question.id}: ${question.text}`);

  const instruction =
    input.classified.kind === "clarify"
      ? [
          "HE ASKED YOU SOMETHING. It is NOT an answer to anything and you may not",
          "record it as one: return an empty `resolved` array.",
          `Answer him in at most ${String(MAX_REPLY_CHARS)} characters, plainly, and stop.`,
        ]
      : [
          `HE ${input.classified.kind === "decline" ? "LEFT THIS TO THE DASHBOARD" : "ANSWERED"}: ${input.classified.targets.join(", ")}.`,
          "Put his answer in `resolved` for THOSE ids and no others. `quoted` must be a",
          "span copied verbatim out of his message below — if you cannot copy one, do not",
          "resolve the question. The host checks this and discards what it cannot find.",
        ];

  return [
    "THE TICKET, VERBATIM",
    "",
    input.brief,
    "",
    ...(input.images.carried === 0
      ? []
      : [
          `HIS ${String(input.images.carried)} REFERENCE IMAGE(S) ARE IN THIS MESSAGE TOO, as image blocks.`,
          "Look again before you write his",
          "answer down: a detail you can take from the picture is one he does not have to",
          "type, and a criterion is still only worth writing if someone WITHOUT the picture",
          "could check it on the finished page.",
          "",
        ]),
    "THE PLAN YOU GAVE HIM",
    ...input.plan.map((line) => `  ${line}`),
    "",
    "QUESTIONS STILL OPEN",
    ...open,
    "",
    "HIS MESSAGE, VERBATIM",
    "",
    input.ownerText,
    "",
    ...instruction,
  ].join("\n");
}

/* -------------------------------------------------------------------------
 * The calls
 * ---------------------------------------------------------------------- */

export interface PlanTurnCall<T> {
  readonly parsed: T;
  /** The seat's raw text, for the run log when the parse refused. */
  readonly raw: string;
  readonly result: SeatCallResult;
}

/**
 * The opening turn: one call, one plan, a ranked and capped list of questions.
 *
 * THE PARSE HAPPENS HERE AND ITS REFUSAL IS RETURNED, NOT THROWN. A seat that
 * returns prose must leave the run able to proceed — `parsed.ok === false` means
 * the phase asked nothing and the run goes on to spec, which is the same landing
 * spot as a detailed ticket. Throwing would turn a bad turn into a failed run,
 * and this phase must never make a run worse than not having it.
 */
export async function runPlanOpening(
  caller: PlanSeatCaller,
  input: PlanSeatInput,
): Promise<PlanTurnCall<ParsedProposal>> {
  const result = await caller.call({
    system: PLAN_SEAT_SYSTEM,
    userTurns: [planOpeningTurn(input)],
    maxOutputTokens: PLAN_SEAT_MAX_OUTPUT_TOKENS,
    jsonSchema: PLAN_PROPOSAL_SCHEMA,
    purpose: "plan-phase opening turn",
  });
  return {
    parsed: parsePlanProposal(result.text, {
      brief: input.brief,
      cap: input.cap,
      firstOrdinal: input.firstOrdinal,
    }),
    raw: result.text,
    result,
  };
}

/** One follow-up turn. Same refusal discipline as {@link runPlanOpening}. */
export async function runPlanFollowUp(
  caller: PlanSeatCaller,
  input: PlanFollowUpInput,
  turnOrdinal: number,
): Promise<PlanTurnCall<ParsedReply>> {
  const result = await caller.call({
    system: PLAN_SEAT_SYSTEM,
    userTurns: [planFollowUpTurn(input)],
    maxOutputTokens: PLAN_SEAT_MAX_OUTPUT_TOKENS,
    jsonSchema: PLAN_REPLY_SCHEMA,
    purpose: `plan-phase owner turn ${String(turnOrdinal)}`,
  });
  return { parsed: parsePlanReply(result.text), raw: result.text, result };
}
