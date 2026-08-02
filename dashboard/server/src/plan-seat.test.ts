/**
 * plan-seat.test.ts — what goes on the wire, and what comes back off it.
 *
 * NO TEST HERE ASSERTS THAT A PROMPT CONTAINS A PHRASE FOR ITS OWN SAKE. The
 * prompt assertions that exist are each about a BOUNDARY the rest of the system
 * depends on — that the owner's pictures are IN the message the seat is told they
 * are in, that no host path reaches a seat which has no tools, that the owner's
 * message goes over verbatim so the quote check downstream has something to check
 * against. Everything else drives a stub seat and checks the value that came back.
 *
 * THE IMAGE TESTS COMPOSE THE REAL MESSAGE, not a string this file assembled.
 * `seatImagesFor` reads real files off a tmpdir, `planSeatImages` decides what
 * travels and `seatPrompt` builds the message — the same three functions
 * `SubscriptionSeatCaller.call` runs. A test that checked only `planOpeningTurn`'s
 * text would pass just as happily over a message carrying no image at all, which
 * is precisely the defect this phase shipped before today.
 *
 * THE STUB IS THE POINT FOR THE REST. `PlanSeatCaller` is one structurally-typed
 * method, so the adversarial cases — a seat that returns an essay, a seat that
 * proposes only generic questions — are reachable without a subprocess, a
 * subscription or a single token of the owner's quota.
 *
 * ─── THE IMAGE MUTATIONS, RUN 2026-08-02, EACH ALONE, WATCHED RED, RESTORED ───
 *
 * All five are in `plan-seat.ts`. The count after each is what actually went red
 * across THIS file and `plan-seat.wiring.test.ts` together, not what was expected
 * to.
 *
 *  M4  `imageLines`' carried arm never runs: `if (images.carried >= 0)`, so a
 *      message holding two pictures is described by the all-refused arm
 *                                                        → 3 red (2 here, 1 wiring)
 *  M5  the "N MORE WERE ATTACHED AND ARE NOT HERE" section never renders
 *      (`images.missing >= 0 ? [] : …`)                  → 2 red (1 here, 1 wiring)
 *  M6  `planSeatImagesFrom` counts what was ATTACHED instead of what the message
 *      holds: `{carried: plan.notes.length, missing: 0}`  → 4 red (2 here, 2 wiring)
 *  M7  `IMAGE_QUESTION_EXAMPLE.criterionIfAnswered` becomes "The nav matches the
 *      reference image on the second board"              → 1 red, against
 *                                                          `questionEarnsItsPlace`
 *                                                          itself
 *  M8  the images block never renders in `planFollowUpTurn`
 *      (`input.images.carried >= 0`)                     → 2 red (1 here, 1 wiring)
 *  M9  the empty-state guard becomes `images.missing === 1`, so an image-FREE run
 *      renders an image section                          → 3 red (2 here, 1 wiring)
 *
 * THE FOUR NON-IMAGE MUTATIONS BELOW WERE WATCHED BY THE PASS THAT WROTE THEIR
 * TESTS AND WERE NOT RE-RUN TODAY, because neither the tests nor the code paths
 * they cover changed:
 *
 *   a bad turn does not fail  — `runPlanOpening` throws when the parse refuses.
 *     the run                   RED (the test would error rather than assert).
 *   the schema is applied     — `jsonSchema: null`. RED.
 *   the owner's message goes  — send `classified.why` instead of `ownerText` in
 *     over verbatim             `planFollowUpTurn`. RED.
 *   a clarification is not a  — use the answer branch for every classification.
 *     resolution instruction    RED.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// TEST-ONLY, the same allowance `subscription-caller.images.test.ts` takes: the
// agent SDK is a transitive dependency this package does not declare, so the
// message shape is structural in `src` and checked against the real type here.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SeatCallRequest, SeatCallResult } from "bakeoff/dist/anthropic-seat.js";
import type { PlanQuestion } from "./plan-question.js";
import { questionEarnsItsPlace } from "./plan-question.js";
import type { ClassifiedReply } from "./plan-state.js";
import type { PlanSeatCaller, PlanSeatInput } from "./plan-seat.js";
import {
  IMAGE_QUESTION_EXAMPLE,
  NO_PLAN_SEAT_IMAGES,
  PLAN_SEAT_SYSTEM,
  planFollowUpTurn,
  planOpeningTurn,
  planSeatImagesFrom,
  runPlanFollowUp,
  runPlanOpening,
} from "./plan-seat.js";
// VALUES, NOT TYPES, AND THAT IS THE CHANGE THIS FILE MADE TODAY. The image
// assertions below compose the message through the caller's own three functions,
// so they can fail when the message and the prompt disagree. It costs loading the
// agent SDK into this test process and calls nothing in it.
import {
  MAX_SEAT_IMAGE_BYTES,
  NO_SEAT_DOCUMENTS,
  NO_SEAT_IMAGES,
  planSeatImages,
  seatImagesFor,
  seatPrompt,
} from "./subscription-caller.js";
import type { SubscriptionSeatCaller } from "./subscription-caller.js";

/*
 * THE WIRING SEAM, CHECKED BY THE COMPILER RATHER THAN BY A COMMENT.
 *
 * `true` is only assignable to this alias when the real caller satisfies the
 * one-method interface this module takes. If someone changes `call`'s signature
 * on either side, `npx tsc --noEmit` fails here — which is the earliest anything
 * could notice, since the orchestrator's own wiring is not written yet.
 */
type WiringHolds = SubscriptionSeatCaller extends PlanSeatCaller ? true : never;
const wiringHolds: WiringHolds = true;
void wiringHolds;

const BRIEF = "Build me a portfolio. Keep it calm and readable.";

const INPUT: PlanSeatInput = {
  brief: BRIEF,
  images: NO_PLAN_SEAT_IMAGES,
  documentNotes: [],
  capturedUrl: null,
  cap: 3,
  firstOrdinal: 1,
};

function seatResult(text: string): SeatCallResult {
  return {
    text,
    stopReason: "end_turn",
    usage: {
      provider: "anthropic",
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 50,
      costUsd: 0,
      modelId: "claude-opus-5",
      role: "spec",
      effort: "high",
      callCount: 1,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      thinkingTokens: null,
    },
    pricingBasis: {
      provider: "anthropic",
      modelId: "claude-opus-5",
      priceLabel: "subscription",
      priceEffectiveFrom: "2026-08-02",
      priceEffectiveUntil: null,
      pricedAt: "2026-08-02T10:00:00.000Z",
      fieldStatus: {
        input: "unverified",
        cacheRead: "unverified",
        cacheWrite5m: "unverified",
        cacheWrite1h: "unverified",
        output: "unverified",
      },
      assumedFields: [],
      assumedCacheWriteMultiplier: null,
      sourcedOn: "2026-08-02",
      source: "test stub",
    },
    precall: {
      allowed: true,
      killReason: null,
      cumulativeCostUsd: 0,
      ceilingUsd: 0,
      worstCaseNextCallUsd: 0,
      checkedAt: "2026-08-02T10:00:00.000Z",
    },
    inputEstimateMeasured: false,
    startedAt: "2026-08-02T10:00:00.000Z",
    endedAt: "2026-08-02T10:00:01.000Z",
  };
}

function stub(text: string): { caller: PlanSeatCaller; seen: SeatCallRequest[] } {
  const seen: SeatCallRequest[] = [];
  return {
    seen,
    caller: {
      call(request: SeatCallRequest): Promise<SeatCallResult> {
        seen.push(request);
        return Promise.resolve(seatResult(text));
      },
    },
  };
}

const GOOD = JSON.stringify({
  plan: ["A portfolio with a project list."],
  questions: [
    {
      text: "How many projects should the portfolio show?",
      ifUnanswered: "three project cards",
      criterionIfDefault: "The portfolio shows three project cards.",
      criterionIfAnswered: "The portfolio shows six project cards.",
      tier: "FUNCTIONAL",
    },
  ],
});

test("one call, the frozen system prompt, and the schema is applied rather than dropped", async () => {
  const { caller, seen } = stub(GOOD);
  const call = await runPlanOpening(caller, INPUT);

  assert.equal(seen.length, 1, "one turn is one call");
  assert.equal(seen[0]?.system, PLAN_SEAT_SYSTEM);
  assert.equal(seen[0]?.userTurns.length, 1);
  // A schema silently discarded here turns into "the seat keeps returning
  // unparseable turns" two layers up — subscription-caller.ts:804 says the same.
  assert.notEqual(seen[0]?.jsonSchema, null);
  assert.match(String(seen[0]?.purpose), /plan-phase/);

  assert.equal(call.parsed.ok, true);
  assert.equal(call.parsed.ok ? call.parsed.proposal.asked.length : -1, 1);
});

test("A SEAT THAT RETURNS PROSE DOES NOT FAIL THE RUN — it asks nothing and moves on", async () => {
  const { caller } = stub("I think the ticket is clear enough, honestly.");
  const call = await runPlanOpening(caller, INPUT);
  // The refusal is a VALUE. Throwing would turn a bad turn into a failed run, and
  // this phase must never make a run worse than not having it.
  assert.equal(call.parsed.ok, false);
  assert.equal(call.raw, "I think the ticket is clear enough, honestly.");
});

test("a seat that proposes only generic questions asks nothing, and the log can prove it", async () => {
  const generic = JSON.stringify({
    plan: ["A portfolio."],
    questions: [
      {
        text: "What colour scheme would you like?",
        ifUnanswered: "a coherent palette",
        criterionIfDefault: "The site has a coherent colour scheme.",
        criterionIfAnswered: "The page has a coherent colour scheme.",
        tier: "BLOCKING",
      },
      {
        text: "How would you like it to feel?",
        ifUnanswered: "calm",
        criterionIfDefault: "The site feels calm.",
        criterionIfAnswered: "The page feels calm.",
        tier: "BLOCKING",
      },
    ],
  });
  const call = await runPlanOpening(stub(generic).caller, INPUT);
  assert.equal(call.parsed.ok, true);
  if (!call.parsed.ok) throw new Error("unreachable");

  assert.equal(call.parsed.proposal.asked.length, 0);
  // TWO PROPOSED, ZERO ASKED — the pair of numbers that separates "the ticket was
  // detailed" from "the seat spent a call and landed nothing". Without both, a
  // useless seat is invisible.
  assert.equal(call.parsed.proposal.proposed, 2);
  assert.equal(call.parsed.proposal.dropped.length, 2);
});

/* -------------------------------------------------------------------------
 * The owner's pictures
 * ---------------------------------------------------------------------- */

/**
 * The message the plan seat actually receives, composed the way the caller
 * composes it: read the files, decide what fits, build the prompt.
 *
 * THE OPENING TURN IS TAKEN FROM `runPlanOpening`'s OWN REQUEST rather than from
 * a direct `planOpeningTurn` call, so nothing here can assert about a string the
 * call would not have sent. And `images` is derived from the plan by
 * {@link planSeatImagesFrom} — the same expression `orchestrator.ts#planOpening`
 * uses — so prompt and payload cannot be made to agree by the test.
 */
async function messageFor(paths: readonly string[]): Promise<{
  readonly blocks: readonly string[];
  readonly mediaTypes: readonly string[];
  readonly text: string;
  readonly streamed: boolean;
}> {
  const plan = planSeatImages(seatImagesFor(paths.map((path) => ({ path }))));
  const { caller, seen } = stub(GOOD);
  await runPlanOpening(caller, { ...INPUT, images: planSeatImagesFrom(plan) });
  const request = seen[0];
  assert.ok(request !== undefined, "the seat was called");

  const prompt = seatPrompt(request, NO_SEAT_DOCUMENTS, plan);
  if (typeof prompt === "string") return { blocks: [], mediaTypes: [], text: prompt, streamed: false };

  const messages: SDKUserMessage[] = [];
  for await (const message of prompt) messages.push(message);
  assert.equal(messages.length, 1, "a seat call is one user message");
  const content = messages[0]?.message.content;
  assert.ok(Array.isArray(content), "an attachment message carries content BLOCKS");
  const text = content.find((block) => (block as { type: string }).type === "text");
  return {
    blocks: content.map((block) => (block as { type: string }).type),
    mediaTypes: content.flatMap((block) => {
      const image = block as { type: string; source?: { media_type?: string } };
      return image.type === "image" ? [String(image.source?.media_type)] : [];
    }),
    text: String((text as { text?: string } | undefined)?.text ?? ""),
    streamed: true,
  };
}

function tempImages(files: readonly { readonly name: string; readonly bytes: Buffer }[]): {
  readonly paths: readonly string[];
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "plan-seat-images-"));
  const paths = files.map((file) => {
    const path = join(dir, file.name);
    writeFileSync(path, file.bytes);
    return path;
  });
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The bytes are never decoded by anything under test — the extension carries the type. */
const PIXELS = Buffer.from("PNG-ish bytes, never decoded by this path");

test("THE OWNER'S DESIGN IS IN THE MESSAGE, and the seat is told to look at it", async () => {
  /*
   * THE OWNER'S INSTRUCTION, VERBATIM: "the design images need to be analysed and
   * seen not quizzed by me as they are visual reference." Until today this prompt
   * said "YOU CANNOT OPEN THEM … ask him about them", which is the behaviour he
   * ruled out. The assertion that matters is the pair: a message that CARRIES the
   * picture, and a prompt that says so.
   */
  const files = tempImages([
    { name: "hero.png", bytes: PIXELS },
    { name: "grid.jpg", bytes: PIXELS },
  ]);
  try {
    const message = await messageFor(files.paths);

    assert.deepEqual(message.blocks, ["image", "image", "text"], "the pictures are content, not prose");
    assert.deepEqual(message.mediaTypes, ["image/png", "image/jpeg"]);

    assert.ok(!message.text.includes("YOU CANNOT OPEN THEM"), "the branch the owner ruled out is gone");
    assert.match(message.text, /ATTACHED 2 REFERENCE IMAGE\(S\) AND THEY ARE IN THIS MESSAGE/);
    assert.match(message.text, /LOOK AT THEM/);
    assert.match(message.text, /DO NOT ASK HIM WHAT IS IN A PICTURE YOU ARE HOLDING/);
    // THE CLOSING RULE OF THE OLD BRANCH, WHICH WAS RIGHT AND IS KEPT: everything
    // downstream of this seat is still blind.
    assert.match(message.text, /CHECKABLE BY SOMEONE WHO DOES NOT HAVE THE/);

    // NO HOST PATH REACHES THE SEAT — unchanged, and now it does not need to.
    assert.ok(!message.text.includes(files.paths[0] ?? "/"), "no absolute path");
    // The roster (the caller's, not this module's) is what names them.
    assert.match(message.text, /1\. hero\.png \(image\/png\)/);
  } finally {
    files.cleanup();
  }
});

test("AN IMAGE THAT COULD NOT BE CARRIED IS NAMED, and the seat is not told it saw it", async () => {
  /*
   * THE THIRD STATE, WHICH THE OLD TWO-BRANCH PROMPT COULD NOT EXPRESS. The
   * intake accepts 8 MB and this seat's per-image cap is 4, so "attached" and "in
   * the message" are different numbers — and a seat that saw half the design and
   * does not know it is worse than one that saw none.
   */
  const files = tempImages([
    { name: "hero.png", bytes: PIXELS },
    { name: "huge.png", bytes: Buffer.alloc(MAX_SEAT_IMAGE_BYTES + 1) },
  ]);
  try {
    const message = await messageFor(files.paths);

    assert.deepEqual(message.blocks, ["image", "text"], "one travelled, one did not");
    assert.match(message.text, /ATTACHED 1 REFERENCE IMAGE\(S\) AND THEY ARE IN THIS MESSAGE/);
    assert.match(message.text, /1 MORE WERE ATTACHED AND ARE NOT HERE/);
    assert.match(message.text, /huge\.png/, "the absent one is named, by the caller's own section");
    assert.ok(!message.text.includes("YOU CANNOT OPEN THEM"));
  } finally {
    files.cleanup();
  }
});

test("EVERY image refused: the seat is told to ask him, and is NOT told it is blind", async () => {
  // The manifest names a file that is not on disk. The reason is about the FILE
  // ("ENOENT"), which is the difference from the deleted branch's claim about the
  // seat — and the old branch's advice, ask him, is correct here and is kept.
  const message = await messageFor([join(tmpdir(), "plan-seat-absent", "gone.png")]);

  assert.equal(message.streamed, false, "no block means nothing to stream");
  assert.match(message.text, /ATTACHED 1 REFERENCE IMAGE\(S\) AND NONE OF THEM COULD BE CARRIED/);
  assert.match(message.text, /gone\.png/);
  assert.match(message.text, /ENOENT/);
  assert.match(message.text, /ask him about them/);
  assert.ok(!message.text.includes("YOU CANNOT OPEN THEM"));
  assert.ok(!message.text.includes("LOOK AT THEM"), "it saw nothing, so it is not told it did");
});

test("A RUN WITH NO IMAGES IS UNCHANGED — a plain string, byte for byte", async () => {
  /*
   * THE REGRESSION THAT WOULD MATTER MOST AND SHOW LEAST. `seatPrompt` streams
   * only when there is a block; a prompt that quietly became a stream, or grew a
   * roster with nothing in it, would change EVERY image-free run in the tree while
   * every assertion about images stayed green. Asserted on the composed form, not
   * on the turn text.
   */
  const { caller, seen } = stub(GOOD);
  await runPlanOpening(caller, INPUT);
  const request = seen[0];
  assert.ok(request !== undefined);

  const prompt = seatPrompt(request, NO_SEAT_DOCUMENTS, NO_SEAT_IMAGES);
  assert.equal(typeof prompt, "string", "no attachment must not stream");
  assert.equal(prompt, request.userTurns.join("\n\n"), "byte-identical to the pre-image expression");
  assert.ok(!String(prompt).includes("REFERENCE IMAGE"), "no image block, empty or otherwise");
  assert.deepEqual(planSeatImagesFrom(NO_SEAT_IMAGES), NO_PLAN_SEAT_IMAGES);
});

test("THE WORTH RULE IS NOT WEAKENED FOR A PICTURE — and the prompt's own example survives it", () => {
  /*
   * A SEAT THAT CAN SEE THE DESIGN IS A SEAT THAT CAN WRITE "the layout matches
   * the mockup" WITH CONVICTION. `plan-question.ts` refuses that, and this test
   * pins the prompt to the refusal: an example the host would discard would teach
   * the seat to spend the owner's one interruption on a question that lands
   * nothing, and would look diligent doing it.
   */
  const example = questionEarnsItsPlace({ id: "PQ-1", ...IMAGE_QUESTION_EXAMPLE }, BRIEF);
  assert.equal(example.ok, true, "the prompt must not teach a shape the host discards");

  // A GENERIC QUESTION ABOUT A PICTURE IS STILL WORTHLESS: whatever he answers,
  // the same criterion gets written.
  const generic = questionEarnsItsPlace(
    {
      id: "PQ-2",
      text: "What sort of look are you going for in the design you sent?",
      ifUnanswered: "the look of the design",
      criterionIfDefault: "The site has the look of the design.",
      criterionIfAnswered: "The page has the look of the design.",
      tier: "QUALITY",
    },
    BRIEF,
  );
  assert.equal(generic.ok, false);
  assert.equal(generic.ok ? "" : generic.refusal, "criteria-do-not-differ");

  // AND A CRITERION THAT COULD ONLY BE GRADED BY OPENING THE PICTURE IS STILL
  // REFUSED, which is what keeps the spec seat's blindness survivable.
  const ungradeable = questionEarnsItsPlace(
    {
      id: "PQ-3",
      text: "Should the hero follow the first board or the second?",
      ifUnanswered: "the first board",
      criterionIfDefault: "The hero matches the first reference image.",
      criterionIfAnswered: "The hero is a full-bleed photograph with the headline over it.",
      tier: "FUNCTIONAL",
    },
    BRIEF,
  );
  assert.equal(ungradeable.ok, false);
  assert.equal(ungradeable.ok ? "" : ungradeable.refusal, "criterion-needs-an-attachment");
});

test("documents and a captured URL are named; nothing else is", () => {
  const turn = planOpeningTurn({
    ...INPUT,
    documentNotes: ["scope.pdf — 4 pages, sent natively"],
    capturedUrl: "https://example.com",
  });
  assert.match(turn, /ATTACHED 1 DOCUMENT\(S\)/);
  assert.match(turn, /scope\.pdf/);
  assert.match(turn, /THE TICKET NAMED https:\/\/example\.com/);
  assert.ok(turn.includes(BRIEF), "the ticket goes over verbatim");
});

/* -------------------------------------------------------------------------
 * The follow-up turn
 * ---------------------------------------------------------------------- */

function open(id: string): PlanQuestion {
  return {
    id,
    text: "How many projects should the portfolio show?",
    ifUnanswered: "three project cards",
    criterionIfDefault: "The portfolio shows three project cards.",
    criterionIfAnswered: "The portfolio shows six project cards.",
    tier: "FUNCTIONAL",
  };
}

const ANSWERED: ClassifiedReply = {
  kind: "answer",
  targets: ["PQ-1"],
  attribution: "structural",
  why: "the client sent intent=answer for PQ-1",
};

const ASKED_BACK: ClassifiedReply = {
  kind: "clarify",
  targets: ["PQ-1"],
  attribution: "addressed",
  why: "the owner named PQ-1 in the reply",
};

test("the owner's message goes over VERBATIM — the quote check has nothing to check otherwise", () => {
  const ownerText = "Six of them, and put the newest first.";
  const turn = planFollowUpTurn({
    brief: BRIEF,
    plan: ["A portfolio."],
    open: [open("PQ-1")],
    ownerText,
    classified: ANSWERED,
    images: NO_PLAN_SEAT_IMAGES,
  });

  assert.ok(turn.includes(ownerText), "the seat must be able to copy a span out of it");
  assert.match(turn, /HE ANSWERED: PQ-1/);
  assert.match(turn, /copied verbatim/);
  assert.match(turn, /PQ-1: How many projects/);
});

test("a clarification is instructed to resolve NOTHING, and that is a different prompt", () => {
  const asking = planFollowUpTurn({
    brief: BRIEF,
    plan: ["A portfolio."],
    open: [open("PQ-1")],
    ownerText: "PQ-1 what do you mean by a project card?",
    classified: ASKED_BACK,
    images: NO_PLAN_SEAT_IMAGES,
  });

  assert.match(asking, /It is NOT an answer to anything/);
  assert.match(asking, /return an empty `resolved` array/);
  // POSITIVE CONTROL: the answer branch says the opposite, so the two really are
  // different prompts rather than one prompt with a decoration.
  const answering = planFollowUpTurn({
    brief: BRIEF,
    plan: ["A portfolio."],
    open: [open("PQ-1")],
    ownerText: "Six of them.",
    classified: ANSWERED,
    images: NO_PLAN_SEAT_IMAGES,
  });
  assert.ok(!answering.includes("It is NOT an answer to anything"));
  assert.match(answering, /Put his answer in `resolved`/);
});

test("THE PICTURES RIDE THE FOLLOW-UP TOO, and the seat is told to look again", () => {
  /*
   * A CALL CARRIES NO MEMORY OF THE LAST ONE. The blocks are re-sent by the
   * caller (they are fixed at construction and the message is rebuilt per call);
   * what could go missing is the SENTENCE, and a seat holding the design without
   * being told is a seat that writes the owner's answer down without looking at
   * it — the same defect as not sending the picture, minus the bytes.
   */
  const withImages = planFollowUpTurn({
    brief: BRIEF,
    plan: ["A portfolio."],
    open: [open("PQ-1")],
    ownerText: "Six of them.",
    classified: ANSWERED,
    images: { carried: 2, missing: 0 },
  });
  assert.match(withImages, /HIS 2 REFERENCE IMAGE\(S\) ARE IN THIS MESSAGE TOO/);
  // THE CLOSING RULE TRAVELS WITH IT: seeing more does not license writing a
  // criterion only a viewer could check.
  assert.match(withImages, /WITHOUT the picture/);

  // POSITIVE CONTROL: a run with no pictures says nothing about pictures, so this
  // is not a line the prompt always carries.
  const without = planFollowUpTurn({
    brief: BRIEF,
    plan: ["A portfolio."],
    open: [open("PQ-1")],
    ownerText: "Six of them.",
    classified: ANSWERED,
    images: NO_PLAN_SEAT_IMAGES,
  });
  assert.ok(!without.includes("REFERENCE IMAGE"));
});

test("a follow-up call carries its own purpose, so two turns are distinguishable in the ledger", async () => {
  const { caller, seen } = stub(JSON.stringify({ reply: "Because they are different pages.", resolved: [] }));
  const call = await runPlanFollowUp(
    caller,
    {
      brief: BRIEF,
      plan: [],
      open: [open("PQ-1")],
      ownerText: "Why?",
      classified: ASKED_BACK,
      images: NO_PLAN_SEAT_IMAGES,
    },
    2,
  );
  assert.equal(seen[0]?.purpose, "plan-phase owner turn 2");
  assert.equal(call.parsed.ok, true);
  assert.equal(call.parsed.ok ? call.parsed.value.reply : "", "Because they are different pages.");
});
