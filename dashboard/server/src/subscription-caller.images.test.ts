/**
 * subscription-caller.images.test.ts — the watchers for the ways the spec seat's
 * IMAGE path can lie.
 *
 * WHAT THIS FILE IS ABOUT, IN ORDER OF HOW BADLY EACH ONE HURTS:
 *
 *  1. THE PRE-IMAGE PATHS STOP BEING THEMSELVES. Two of them, not one: a seat
 *     with no attachments at all must still dispatch the joined STRING, and a
 *     seat with DOCUMENTS AND NO IMAGES must still dispatch exactly the message
 *     it did before this feature existed. The second is the regression surface
 *     `subscription-caller.documents.test.ts` cannot see, because it never
 *     constructs a caller that knows images exist.
 *  2. AN IMAGE IS DROPPED IN SILENCE. This is worse for a picture than for a
 *     document. A document over budget still arrives as extracted text, so the
 *     silence costs detail; an image over budget arrives as NOTHING, so silence
 *     is a prompt that has forgotten an attachment the owner made — while the
 *     run log still says he attached one. Every refusal is asserted to reach the
 *     seat by name.
 *  3. THE ROSTER AND THE BLOCKS DISAGREE. `ImageBlockParam` has no `title`, so
 *     the text roster is the ONLY thing saying which picture is which. If the
 *     labels drift out of block order the seat is confidently told the second
 *     mockup is the first — worse than telling it nothing.
 *  4. THE REGENERATION LOSES THE IMAGES. Same single-use-generator trap the
 *     document path has: `generateAuditedSuite` calls one caller up to four
 *     times, and a prompt built per CALLER instead of per CALL would send the
 *     mockups on attempt 1 and an empty message afterwards.
 *  5. A HOST PATH REACHES THE SEAT. The obvious implementation leaks one:
 *     `statSync`'s error message embeds the path it was given, and that string is
 *     rendered into the prompt.
 *
 * NO MODEL IS CALLED HERE. `query` is replaced by a factory that records what it
 * was handed. What this file therefore does NOT prove is that the CLI accepts an
 * image block at all — that is a live measurement, and unlike the document path
 * it HAS been taken: see `subscription-caller.live.test.ts`, which sends a real
 * PNG with a real output schema and is skipped unless DASHBOARD_LIVE_SMOKE=1.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// TEST-ONLY, exactly as in `subscription-caller.documents.test.ts`:
// `@anthropic-ai/sdk` is a TRANSITIVE dependency this package does not declare,
// so the block shape is declared structurally in `src` and checked against the
// real type only here.
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SeatCallRequest } from "bakeoff/dist/anthropic-seat.js";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";

import { DASHBOARD_BUDGET } from "./orchestrator.js";
import {
  DEFAULT_SEAT_IMAGE_BASE64_CHARS,
  MAX_SEAT_IMAGE_BYTES,
  NO_SEAT_IMAGES,
  SubscriptionSeatCaller,
  describeSeatImages,
  planSeatImages,
  seatImagesFor,
  seatPrompt,
} from "./subscription-caller.js";
import type {
  SeatDocument,
  SeatImage,
  SeatImageMediaType,
  SeatSessionFactory,
} from "./subscription-caller.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const SEAT: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };

/** Cast narrowly, for the reason the documents test gives: SDKMessage is large. */
function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

const ASSISTANT = envelope({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "AUTHORED" }] },
});

const RESULT = envelope({
  type: "result",
  subtype: "success",
  stop_reason: "end_turn",
  result: "AUTHORED",
  usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

function recordingQuery(): { factory: SeatSessionFactory; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      yield ASSISTANT;
      yield RESULT;
    })();
  };
  return { factory, dispatches };
}

function request(overrides: Partial<SeatCallRequest> = {}): SeatCallRequest {
  return {
    system: "author an acceptance suite",
    userTurns: ["TICKET: build a landing page", "FEEDBACK: criterion 3 is not falsifiable"],
    maxOutputTokens: 4_096,
    jsonSchema: null,
    purpose: "suite-authoring test attempt 1",
    ...overrides,
  };
}

const JOINED = request().userTurns.join("\n\n");

/** The same option-key set the documents test pins. Images must not widen it. */
const OPTION_KEYS = [
  "abortController",
  "cwd",
  "effort",
  "env",
  "includePartialMessages",
  "maxTurns",
  "model",
  "settingSources",
  "systemPrompt",
  "tools",
];

function callerWith(
  recorder: { factory: SeatSessionFactory },
  images: readonly SeatImage[],
  extra: { documents?: readonly SeatDocument[]; imageBudgetBase64Chars?: number } = {},
): SubscriptionSeatCaller {
  return new SubscriptionSeatCaller(SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    startQuery: recorder.factory,
    images,
    ...extra,
  });
}

/**
 * The media type is the NON-NULLABLE {@link SeatImageMediaType}, not
 * `SeatImage["mediaType"]`. That field is nullable because a refused image has no
 * type, and taking the nullable form here would force a cast to satisfy
 * `Base64ImageSource` — a cast that would be a lie the moment a caller passed
 * "image/jpeg". A fixture that carries a block always knows its type.
 */
function image(label: string, base64: string, mediaType: SeatImageMediaType = "image/png"): SeatImage {
  return {
    label,
    mediaType,
    block: { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    declined: null,
  };
}

function pdf(label: string, base64: string): SeatDocument {
  return {
    label,
    mediaType: "application/pdf",
    block: {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
      title: label,
    },
    text: `(extracted text of ${label})`,
    nativeDeclined: null,
  };
}

async function drain(prompt: string | AsyncIterable<SDKUserMessage>): Promise<readonly SDKUserMessage[]> {
  assert.notEqual(typeof prompt, "string", "expected the streaming form");
  const messages: SDKUserMessage[] = [];
  for await (const message of prompt as AsyncIterable<SDKUserMessage>) messages.push(message);
  return messages;
}

function contentOf(message: SDKUserMessage): readonly unknown[] {
  const content = message.message.content;
  assert.ok(Array.isArray(content), "an attachment message must carry content BLOCKS, not a string");
  return content;
}

function blockTypes(content: readonly unknown[]): readonly string[] {
  return content.map((block) => (block as { type: string }).type);
}

/* -------------------------------------------------------------------------
 * 1. The pre-image paths are still themselves
 * ---------------------------------------------------------------------- */

test("NO IMAGES AND NO DOCUMENTS: the prompt is the joined string and the options are unchanged", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, []);

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  assert.equal(typeof dispatch.prompt, "string", "a seat with no attachment must not stream");
  assert.equal(dispatch.prompt, JOINED, "byte-identical to the pre-image expression");
  assert.deepEqual(Object.keys(dispatch.options).sort(), OPTION_KEYS);
  assert.deepEqual(dispatch.options.tools, [], "carrying images must NEVER give this seat tools");
  assert.equal(caller.imageCalls, 0);
  assert.equal(caller.imagePlan, NO_SEAT_IMAGES);
});

test("DOCUMENTS BUT NO IMAGES: the message is exactly the document message, unwidened", async () => {
  /*
   * THE REGRESSION SURFACE THE DOCUMENTS TEST CANNOT SEE. It never constructs a
   * caller that knows images exist, so a `seatPrompt` that appended an empty
   * roster, or emitted a stray separator line, or a zero-length image block,
   * would leave it green and change every real spec call.
   */
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [], { documents: [pdf("scope.pdf", "QkFTRTY0UERG")] });

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  const content = contentOf((await drain(dispatch.prompt))[0] as SDKUserMessage);
  assert.deepEqual(blockTypes(content), ["document", "text"], "no image block, empty or otherwise");
  const text = content[1] as { type: string; text: string };
  assert.equal(text.text, JOINED, "the user turns arrive whole, with nothing appended for images");
  assert.equal(caller.imageCalls, 0);
  assert.equal(caller.imagePlan.text, "", "an empty image plan contributes no text");
  // And the document side is untouched in value, which orchestrator.ts reads.
  assert.equal(caller.documentCalls, 1);
  assert.equal(caller.documentPlan.blocks.length, 1);
});

test("seatPrompt's image argument DEFAULTS to nothing — two-argument callers are unchanged", () => {
  const plan = planSeatImages([image("hero.png", "UE5H")]);
  // Two arguments: the pre-image signature. Must be the plain string.
  assert.equal(seatPrompt(request(), { blocks: [], text: "", base64Chars: 0, notes: [] }), JOINED);
  // The negative control: the same call WITH images must not be a string.
  const withImages = seatPrompt(request(), { blocks: [], text: "", base64Chars: 0, notes: [] }, plan);
  assert.notEqual(typeof withImages, "string");
});

/* -------------------------------------------------------------------------
 * 2. An image travels, on EVERY call, after the documents
 * ---------------------------------------------------------------------- */

test("AN IMAGE BECOMES A BASE64 IMAGE BLOCK, followed by the roster and the user turns", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [image("hero.png", "UE5HQkFTRTY0")]);

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  const messages = await drain(dispatch.prompt);
  assert.equal(messages.length, 1, "a seat call is one user message");
  const message = messages[0];
  assert.ok(message !== undefined);
  assert.equal(message.type, "user");
  assert.equal(message.parent_tool_use_id, null);

  const content = contentOf(message);
  assert.deepEqual(blockTypes(content), ["image", "text"]);
  const block = content[0] as ImageBlockParam;
  assert.deepEqual(block.source, { type: "base64", media_type: "image/png", data: "UE5HQkFTRTY0" });

  const text = content[1] as { type: string; text: string };
  assert.ok(text.text.startsWith(JOINED), "the user turns keep their place at the top");
  assert.match(text.text, /1\. hero\.png \(image\/png\)/, "the roster names it in block order");
  assert.equal(caller.imageCalls, 1);

  /*
   * THE OPTIONS ARE UNTOUCHED BY THE ATTACHMENT, ASSERTED ON THE VALUES AND NOT
   * ONLY ON THE KEY NAMES. The key set alone is not enough here: a change like
   * `tools: images.length > 0 ? ["Read"] : []` keeps the key set identical, and
   * would be caught only on the no-images path — which is the path that does not
   * matter. Giving THIS seat a file-reading tool is the one thing the feature is
   * forbidden to do, so it is checked where the images actually are.
   */
  assert.deepEqual(Object.keys(dispatch.options).sort(), OPTION_KEYS);
  assert.deepEqual(dispatch.options.tools, [], "carrying an image must NEVER give this seat tools");
  assert.deepEqual(dispatch.options.settingSources, [], "nor the owner's settings");
});

test("DOCUMENTS FIRST, THEN IMAGES, THEN TEXT — and the roster numbers only the images", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [image("hero.png", "UE5H"), image("nav.jpg", "SlBH", "image/jpeg")], {
    documents: [pdf("scope.pdf", "UERG")],
  });

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  const content = contentOf((await drain(dispatch.prompt))[0] as SDKUserMessage);
  assert.deepEqual(blockTypes(content), ["document", "image", "image", "text"]);

  const text = (content[3] as { text: string }).text;
  // THE NUMBERING IS AMONG THE IMAGES, not among all blocks. With a document at
  // position 0, numbering by absolute position would call hero.png "2" and send
  // the seat looking for a picture that is a PDF.
  assert.match(text, /1\. hero\.png \(image\/png\)/);
  assert.match(text, /2\. nav\.jpg \(image\/jpeg\)/);
  assert.equal(caller.documentCalls, 1);
  assert.equal(caller.imageCalls, 1, "one dispatch is one image call, not two");
});

test("THE ROSTER'S ORDER IS THE BLOCKS' ORDER — labels and blocks stay in lockstep", () => {
  const plan = planSeatImages([
    image("first.png", "QQ"),
    image("second.gif", "QkI", "image/gif"),
    image("third.webp", "Q0ND", "image/webp"),
  ]);

  assert.equal(plan.blocks.length, 3);
  assert.deepEqual(plan.labels, ["first.png", "second.gif", "third.webp"]);
  assert.deepEqual(
    plan.blocks.map((block) => block.source.data),
    ["QQ", "QkI", "Q0ND"],
  );
  // The rendered roster must agree with both, in the same order.
  const positions = ["first.png", "second.gif", "third.webp"].map((label) => plan.text.indexOf(label));
  assert.ok(positions.every((at) => at >= 0), "every carried image is named in the roster");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "named in block order");
  assert.match(plan.text, /no filename and no citation anchor/i);
});

test("THE REGENERATION CARRIES THE SAME IMAGES — the single-use generator trap", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [image("hero.png", "UE5HQkFTRTY0")]);

  // Two calls on ONE caller: what `generateAuditedSuite` does when the bad-test
  // audit returns a blocking finding.
  await caller.call(request({ purpose: "attempt 1" }));
  await caller.call(request({ purpose: "attempt 2" }));

  assert.equal(recorder.dispatches.length, 2);
  for (const [index, dispatch] of recorder.dispatches.entries()) {
    const message = (await drain(dispatch.prompt))[0];
    assert.ok(message !== undefined, `call ${String(index + 1)} sent no message`);
    const block = contentOf(message)[0] as ImageBlockParam;
    assert.equal(block.type, "image", `call ${String(index + 1)} lost the image block`);
    assert.deepEqual(block.source, { type: "base64", media_type: "image/png", data: "UE5HQkFTRTY0" });
  }
  assert.equal(caller.imageCalls, 2, "both dispatches carried the pictures");
});

/* -------------------------------------------------------------------------
 * 3. Nothing is dropped in silence — the five named refusals
 * ---------------------------------------------------------------------- */

test("AN IMAGE OVER THE PER-CALL BUDGET IS DROPPED, NAMED, AND ANNOUNCED TO THE SEAT", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [image("small.png", "Q".repeat(100)), image("huge.png", "Q".repeat(4_000))], {
    imageBudgetBase64Chars: 1_000,
  });

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  const content = contentOf((await drain(dispatch.prompt))[0] as SDKUserMessage);
  assert.deepEqual(blockTypes(content), ["image", "text"], "only the one that fits travels");
  assert.equal(caller.imagePlan.base64Chars, 100);
  assert.deepEqual(caller.imagePlan.labels, ["small.png"]);

  const text = (content[1] as { text: string }).text;
  assert.match(text, /huge\.png/, "the dropped image is named in the prompt");
  assert.match(text, /IT IS NOT IN THIS MESSAGE/);
  assert.match(text, /per-call budget is 1000/);
  assert.match(text, /AN IMAGE HAS NO TEXT FORM/);
  assert.match(text, /Do not describe it, do not guess what is in it/);
  // And the run log carries the same fact.
  assert.match(caller.imagePlan.notes.join(" "), /huge\.png: carrying it would put 4100 base64 chars/);
});

test("THE BUDGET IS THE SUM ACROSS IMAGES, NOT PER IMAGE", () => {
  const half = "Q".repeat(600);
  const plan = planSeatImages([image("a.png", half), image("b.png", half)], 1_000);

  assert.equal(plan.blocks.length, 1, "only the first fits");
  assert.equal(plan.base64Chars, 600);
  assert.deepEqual(plan.labels, ["a.png"]);
  assert.match(plan.notes.join(" "), /a\.png \(image\/png\): sent as an image block, 600 base64 chars/);
  assert.match(plan.notes.join(" "), /b\.png: carrying it would put 1200 base64 chars/);
});

test("EVERY IMAGE REFUSED means the prompt stays a STRING and says so, rather than going quiet", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [
    { label: "gone.png", mediaType: "image/png", block: null, declined: "its bytes could not be read off disk (ENOENT), so it is dropped" },
  ]);

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  // With no block left there is nothing to stream, so this is the string path —
  // but it must NOT be the plain joined string.
  assert.equal(typeof dispatch.prompt, "string");
  assert.notEqual(dispatch.prompt, JOINED, "a refused attachment must change the prompt");
  assert.match(String(dispatch.prompt), /gone\.png/);
  assert.match(String(dispatch.prompt), /ENOENT/);
  assert.equal(caller.imageCalls, 1, "a refused attachment is still an attachment");
  assert.equal(caller.imagePlan.blocks.length, 0);
});

test("the five refusals reach a SeatImage by name, each with its own sentence", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-images-"));
  const empty = join(dir, "empty.png");
  const big = join(dir, "big.png");
  const good = join(dir, "good.png");
  writeFileSync(empty, Buffer.alloc(0));
  writeFileSync(big, Buffer.alloc(4_096, 7));
  writeFileSync(good, Buffer.from([1, 2, 3, 4]));

  const images = seatImagesFor(
    [
      { path: join(dir, "missing.png") },
      { path: join(dir, "notes.txt") },
      { path: empty },
      { path: big },
      { path: good },
    ],
    { maxImageBytes: 1_024 },
  );

  const [missing, wrongType, zero, oversized, ok] = images;
  assert.ok(missing !== undefined && wrongType !== undefined && zero !== undefined);
  assert.ok(oversized !== undefined && ok !== undefined);

  // 1. unreadable file — the fs CODE, never the message (which embeds the path).
  assert.equal(missing.block, null);
  assert.match(String(missing.declined), /could not be read off disk \(ENOENT\)/);
  // 2. unsupported media type — decided from the extension, no read attempted.
  assert.equal(wrongType.block, null);
  assert.equal(wrongType.mediaType, null);
  assert.match(String(wrongType.declined), /extension \(\.txt\) names no image media type/);
  assert.match(String(wrongType.declined), /image\/png, image\/jpeg, image\/webp, image\/gif/);
  // 3. zero bytes — distinct from unreadable, because the fix is different.
  assert.equal(zero.block, null);
  assert.match(String(zero.declined), /zero bytes long/);
  // 4. over the per-image cap — names both numbers.
  assert.equal(oversized.block, null);
  assert.match(String(oversized.declined), /it is 4096 bytes and this seat's per-image cap is 1024 bytes/);
  // 5. and the one that works.
  assert.equal(ok.mediaType, "image/png");
  assert.equal(ok.block?.source.data, Buffer.from([1, 2, 3, 4]).toString("base64"));
  assert.equal(ok.declined, null);
});

test("NO HOST PATH REACHES THE SEAT, not even through an fs error message", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-images-leak-"));
  const images = seatImagesFor([{ path: join(dir, "missing.png") }]);
  const prompt = String(seatPrompt(request(), { blocks: [], text: "", base64Chars: 0, notes: [] }, planSeatImages(images)));

  assert.match(prompt, /missing\.png/, "the basename is how the seat names it");
  assert.doesNotMatch(prompt, /seat-images-leak-/, "the containing directory must not appear");
  assert.doesNotMatch(prompt, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  // `statSync`'s own message is "ENOENT: no such file or directory, stat '<path>'".
  assert.doesNotMatch(prompt, /no such file or directory/);
});

test("the extension map covers what the intake writes, and .jpeg as well as .jpg", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-images-ext-"));
  const paths: readonly string[] = ["a.png", "b.jpg", "c.jpeg", "d.webp", "e.gif", "f.PNG"];
  for (const name of paths) writeFileSync(join(dir, name), Buffer.from([9]));

  const images = seatImagesFor(paths.map((name) => ({ path: join(dir, name) })));
  assert.deepEqual(
    images.map((carried) => carried.mediaType),
    ["image/png", "image/jpeg", "image/jpeg", "image/webp", "image/gif", "image/png"],
  );
  assert.ok(images.every((carried) => carried.block !== null), "all six become blocks");
});

/* -------------------------------------------------------------------------
 * 4. The budgets are stated, and derived rather than re-chosen
 * ---------------------------------------------------------------------- */

test("the per-call image budget is three images' worth, DERIVED from the per-image cap", () => {
  // If `MAX_SEAT_IMAGE_BYTES` moves and this is not re-derived, the two budgets
  // disagree and an image inside the per-image cap is refused by the per-call
  // one for no stated reason. 4 MB decoded -> 5,592,406 base64 chars each.
  assert.equal(MAX_SEAT_IMAGE_BYTES, 4_194_304);
  assert.equal(DEFAULT_SEAT_IMAGE_BASE64_CHARS, 3 * 5_592_406);
  assert.equal(DEFAULT_SEAT_IMAGE_BASE64_CHARS, 16_777_218);
});

/**
 * THE SIZE IN THIS TEST IS A MEASURED FILE, NOT A ROUND NUMBER.
 *
 * An earlier version of this test used "six 400 KB mockups", which was the same
 * guess the budget's docblock was making — the test confirmed the assumption
 * using the assumption's own number and was therefore evidence of nothing.
 * 1,961,940 is the size of `capture-1280.png` in this repository's own
 * `runs/run-2026-07-30T20-16-40-242Z-052c6e02/references/`, measured with
 * stat(1); it is the LARGEST reference image in the tree. Six of the largest
 * real thing is the realistic worst case, and it must fit.
 */
test("SIX OF THE LARGEST REAL REFERENCE IMAGE IN THIS TREE travel whole, none dropped", () => {
  const largestRealCapture = 1_961_940;
  const asBase64 = "Q".repeat(Math.ceil((largestRealCapture * 4) / 3));
  const plan = planSeatImages(
    Array.from({ length: 6 }, (_unused, index) => image(`capture-${String(index + 1)}.png`, asBase64)),
  );

  assert.equal(plan.blocks.length, 6, "all six of a real intake travel");
  assert.equal(plan.base64Chars, 15_695_520);
  assert.ok(
    plan.base64Chars < DEFAULT_SEAT_IMAGE_BASE64_CHARS,
    `six real captures (${String(plan.base64Chars)}) must fit the budget`,
  );
  assert.equal(plan.text.includes("NOT IN THIS PROMPT"), false, "nothing was dropped, so nothing is announced");
});

test("THE LARGEST REAL REFERENCE IMAGE IS COMFORTABLY INSIDE THE PER-IMAGE CAP", () => {
  // The regression this guards: the cap was once 2 MB, and the largest real
  // reference image in this tree is 1,961,940 bytes — within 4% of it. A cap
  // that close to the real data refuses the owner's actual references the first
  // time a page capture comes out slightly wider.
  assert.ok(
    MAX_SEAT_IMAGE_BYTES >= 2 * 1_961_940,
    "the per-image cap must be at least double the largest reference image measured in this repository",
  );
});

/* -------------------------------------------------------------------------
 * 5. The caller can say what it sent
 * ---------------------------------------------------------------------- */

test("the delivery line multiplies the REAL size by the REAL number of calls", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [image("hero.png", "Q".repeat(100))]);

  await caller.call(request());
  await caller.call(request());

  const line = describeSeatImages(caller.imagePlan, caller.imageCalls);
  assert.match(line, /1 attached image\(s\)/);
  assert.match(line, /1 image block\(s\) in order \(hero\.png\)/);
  assert.match(line, /100 base64 chars, re-sent on each of 2 call\(s\) = 200 base64 chars in total/);
  // No token figure: this file cannot convert bytes to tokens and must not
  // invent a per-image number in a line the owner reads as measurement.
  assert.doesNotMatch(line, /token/i);
});

test("'THE SEAT NEVER GOT THE PICTURE' IS DISTINGUISHABLE FROM 'THE SEAT ASKED A BAD QUESTION'", () => {
  /*
   * THE WHOLE REASON THIS DESCRIBER EXISTS. After a run that produced a vague
   * criterion about a mockup, the two explanations are "the seat saw it and
   * wrote badly" and "the seat never saw it". If the log line for both is
   * "1 attached image(s)", nothing can tell them apart afterwards.
   */
  const carried = describeSeatImages(planSeatImages([image("hero.png", "QQ")]), 1);
  const refused = describeSeatImages(
    planSeatImages([{ label: "hero.png", mediaType: "image/png", block: null, declined: "the file on disk is zero bytes long, so it is dropped" }]),
    1,
  );

  assert.notEqual(carried, refused);
  assert.match(carried, /1 image block\(s\) in order \(hero\.png\)/);
  assert.match(refused, /NO IMAGE REACHED THE SEAT/);
  assert.match(refused, /zero bytes long/);
});

test("a seat with no images says so rather than reporting an empty attachment", () => {
  assert.equal(describeSeatImages(NO_SEAT_IMAGES, 0), "no images were attached to this seat");
});

/* -------------------------------------------------------------------------
 * 6. The SDK's own types
 * ---------------------------------------------------------------------- */

/**
 * THE SDK-DRIFT WATCHER, the instrument `subscription-caller.documents.test.ts`
 * ends with. The block travels as a structural type because `@anthropic-ai/sdk`
 * is transitive here; this assignment is what makes a renamed field or a narrowed
 * `media_type` union fail `npm run build` instead of returning a 400 from a live
 * call.
 */
test("the image block is still assignable to the SDK's ImageBlockParam", () => {
  const plan = planSeatImages([image("hero.png", "UE5H")]);
  const block = plan.blocks[0];
  assert.ok(block !== undefined);
  const asSdkBlock: ImageBlockParam = block;
  assert.equal(asSdkBlock.type, "image");
  assert.equal(asSdkBlock.source.type, "base64");
});
