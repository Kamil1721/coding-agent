/**
 * subscription-caller.documents.test.ts — the watchers for the five ways the
 * spec seat's document path can lie.
 *
 * WHAT THIS FILE IS ABOUT, IN ORDER OF HOW BADLY EACH ONE HURTS:
 *
 *  1. THE NO-DOCUMENT PATH STOPS BEING THE OLD PATH. Every existing test, every
 *     frozen suite on disk and the whole bake-off depend on a seat call with no
 *     attachment being the single joined STRING it has always been. A change
 *     that "helpfully" streams every call would not fail anything else here —
 *     the model answers either way — so the string is asserted by value, by
 *     `typeof`, and together with the exact set of SDK option keys.
 *  2. THE REGENERATION LOSES THE DOCUMENT. `generateAuditedSuite` calls the same
 *     caller up to four times (three attempts plus one truncation retry). An
 *     async generator is SINGLE-USE, so a prompt built once per caller instead
 *     of once per call would send the PDF on attempt 1 and an empty message
 *     afterwards — and the suite that finally freezes would be the one authored
 *     WITHOUT the document, with nothing anywhere saying so. Test 2 drives two
 *     calls and asserts both.
 *  3. A DOCUMENT IS DROPPED IN SILENCE. Over budget, wrong media type, or no
 *     text supplied: each must produce a NAMED outcome the seat can read, never
 *     an unchanged prompt.
 *  4. THE ITERATOR IS "FIXED" INTO A PARKING ONE. `live-input.ts` parks forever
 *     because a long-lived build session dies when its input completes. A
 *     one-shot seat call is the opposite: it must END, or `call()` awaits a
 *     stream that never finishes. The completion is asserted directly.
 *  5. THE SEAM ITSELF. `startQuery` is a default argument, so a stub could
 *     silently replace the SDK for everyone. The default is pinned by identity —
 *     the same guard `claude-builder.test.ts` puts on `SessionFactory`.
 *
 * NO MODEL IS CALLED. The SDK's `query` is replaced by a factory that records
 * what it was handed and replays two fixed frames. What this file therefore does
 * NOT prove: that the CLI accepts a document block at all. That is a live
 * measurement (see the header of `subscription-caller.ts`), and it is not
 * repeated here because repeating it costs the owner's quota on every `npm test`.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
// TEST-ONLY, exactly as in `document-intake.test.ts`: `@anthropic-ai/sdk` is a
// TRANSITIVE dependency this package does not declare, so the block shape is
// declared structurally in `src` and checked against the real type only here.
import type { DocumentBlockParam } from "@anthropic-ai/sdk/resources";
import type { SeatCallRequest } from "bakeoff/dist/anthropic-seat.js";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";

import { DASHBOARD_BUDGET } from "./orchestrator.js";
import {
  DEFAULT_SEAT_NATIVE_BASE64_CHARS,
  NO_SEAT_DOCUMENTS,
  SubscriptionSeatCaller,
  describeSeatDocuments,
  planSeatDocuments,
  seatDocumentsFor,
  seatPrompt,
} from "./subscription-caller.js";
import type { SeatDocument, SeatSessionFactory } from "./subscription-caller.js";
import type { DocumentCapability } from "./document-capability.js";
import type { ExtractedDocument } from "./document-intake.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

/** The cheapest seat shape; nothing here reaches a model, so it is inert. */
const SEAT: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };

/**
 * A message as the CLI delivers it. CAST DELIBERATELY AND NARROWLY, for the
 * reason `claude-builder.test.ts` gives: `SDKMessage` is a large union carrying
 * `uuid`, `session_id` and full content blocks this loop never reads, and
 * writing them out would make the fixture about the SDK's types rather than
 * about the caller's behaviour.
 */
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
  usage: {
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

/** A factory that records every dispatch and replays the two frames above. */
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

/** The joined string the pre-document code path passed to `query`. */
const JOINED = request().userTurns.join("\n\n");

function callerWith(
  dispatches: { factory: SeatSessionFactory },
  documents: readonly SeatDocument[],
  nativeBudgetBase64Chars?: number,
): SubscriptionSeatCaller {
  return new SubscriptionSeatCaller(SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    // No Anthropic key: the base class only ever sees the sentinel, and nothing
    // in this file reaches a network either way.
    env: {},
    startQuery: dispatches.factory,
    documents,
    ...(nativeBudgetBase64Chars === undefined ? {} : { nativeBudgetBase64Chars }),
  });
}

function pdf(label: string, base64: string, text = `(extracted text of ${label})`): SeatDocument {
  return {
    label,
    mediaType: "application/pdf",
    block: {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
      title: label,
    },
    text,
    nativeDeclined: null,
  };
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The blocks of a recorded streaming prompt, drained. */
async function drain(prompt: string | AsyncIterable<SDKUserMessage>): Promise<readonly SDKUserMessage[]> {
  assert.notEqual(typeof prompt, "string", "expected the streaming form");
  const messages: SDKUserMessage[] = [];
  for await (const message of prompt as AsyncIterable<SDKUserMessage>) messages.push(message);
  return messages;
}

function contentOf(message: SDKUserMessage): readonly unknown[] {
  const content = message.message.content;
  assert.ok(Array.isArray(content), "a document message must carry content BLOCKS, not a string");
  return content;
}

/* -------------------------------------------------------------------------
 * 1. The no-document path is the old path, byte for byte
 * ---------------------------------------------------------------------- */

/**
 * THE KEY SET IS PART OF THE ASSERTION, not decoration. `assert.equal` on the
 * prompt catches a prompt that changed shape; it says nothing about an
 * options object that grew a document-related field, which is the other half of
 * "the previous path exactly".
 */
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

test("NO DOCUMENTS: the dispatched prompt is the joined string, and the options are unchanged", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, []);

  await caller.call(request());

  assert.equal(recorder.dispatches.length, 1);
  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  assert.equal(typeof dispatch.prompt, "string", "a seat with no attachment must not stream");
  assert.equal(dispatch.prompt, JOINED, "byte-identical to the pre-document expression");
  assert.deepEqual(Object.keys(dispatch.options).sort(), OPTION_KEYS);
  assert.deepEqual(dispatch.options.tools, []);
  assert.deepEqual(dispatch.options.settingSources, []);
  assert.equal(caller.documentCalls, 0);
  assert.equal(caller.documentPlan, NO_SEAT_DOCUMENTS);
});

test("NO DOCUMENTS: a json schema still adds outputFormat and nothing else", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, []);

  await caller.call(request({ jsonSchema: { type: "object" } }));

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  assert.deepEqual(Object.keys(dispatch.options).sort(), [...OPTION_KEYS, "outputFormat"].sort());
  assert.equal(dispatch.prompt, JOINED);
});

test("seatPrompt with an empty plan returns the joined turns and nothing else", () => {
  const prompt = seatPrompt(request(), NO_SEAT_DOCUMENTS);
  assert.equal(typeof prompt, "string");
  assert.equal(prompt, JOINED);
  // The negative control: the same call WITH a document must not be a string.
  const withDocument = seatPrompt(request(), planSeatDocuments([pdf("scope.pdf", "QkFTRTY0")]));
  assert.notEqual(typeof withDocument, "string");
});

/* -------------------------------------------------------------------------
 * 2. A PDF travels natively, on EVERY call
 * ---------------------------------------------------------------------- */

test("A PDF becomes a document block with citations, followed by the user turns", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [pdf("scope.pdf", "QkFTRTY0UERG")]);

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
  assert.equal(content.length, 2, "the document block, then the text");
  const block = content[0] as DocumentBlockParam;
  assert.equal(block.type, "document");
  assert.deepEqual(block.source, { type: "base64", media_type: "application/pdf", data: "QkFTRTY0UERG" });
  // Page-anchored citations are the whole reason for the native path.
  assert.deepEqual(block.citations, { enabled: true });
  assert.equal(block.title, "scope.pdf");

  const text = content[1] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.equal(text.text, JOINED, "the user turns arrive whole and unchanged");

  // The options are the seat's own, unchanged by the attachment.
  assert.deepEqual(Object.keys(dispatch.options).sort(), OPTION_KEYS);
});

test("THE REGENERATION CARRIES THE SAME DOCUMENT — the single-use generator trap", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [pdf("scope.pdf", "QkFTRTY0UERG")]);

  // Two calls on ONE caller: exactly what `generateAuditedSuite` does when the
  // bad-test audit returns a blocking finding.
  await caller.call(request({ purpose: "suite-authoring attempt 1" }));
  await caller.call(request({ purpose: "suite-authoring attempt 2" }));

  assert.equal(recorder.dispatches.length, 2);
  for (const [index, dispatch] of recorder.dispatches.entries()) {
    const messages = await drain(dispatch.prompt);
    const message = messages[0];
    assert.ok(message !== undefined, `call ${String(index + 1)} sent no message`);
    const block = contentOf(message)[0] as DocumentBlockParam;
    assert.equal(block.type, "document", `call ${String(index + 1)} lost the document block`);
    assert.deepEqual(block.source, {
      type: "base64",
      media_type: "application/pdf",
      data: "QkFTRTY0UERG",
    });
  }
  assert.equal(caller.documentCalls, 2, "both dispatches carried the attachment");
  assert.equal(caller.callCount, 2);
});

test("THE INPUT ITERABLE COMPLETES — a seat call must end, unlike a live build session", async () => {
  /*
   * `live-input.ts` parks on a promise so a long-lived session is not ended by
   * an exhausted queue. THIS iterator must do the opposite: `call()` drains the
   * output stream and returns, so an input that never completes leaves the CLI
   * subprocess alive and the seat call awaiting a result that cannot arrive.
   * A future "consistency" edit that gives this the LiveInput shape turns this
   * assertion red instead of hanging a run.
   */
  const prompt = seatPrompt(request(), planSeatDocuments([pdf("scope.pdf", "QkFTRTY0")]));
  assert.notEqual(typeof prompt, "string");
  const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  const second = await iterator.next();
  assert.equal(second.done, true, "the generator must RETURN after the one message");
});

/* -------------------------------------------------------------------------
 * 3. Nothing is dropped in silence
 * ---------------------------------------------------------------------- */

test("A PDF OVER THE PER-CALL BUDGET falls back to extracted text, and says why", async () => {
  const recorder = recordingQuery();
  const big = "Q".repeat(4_096);
  const caller = callerWith(recorder, [pdf("scope.pdf", big, "SCOPE: ship the checkout flow")], 1_024);

  await caller.call(request());

  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  assert.equal(typeof dispatch.prompt, "string", "with no block left there is nothing to stream");
  assert.equal(caller.documentPlan.blocks.length, 0);
  assert.equal(caller.documentPlan.base64Chars, 0);
  assert.ok(String(dispatch.prompt).startsWith(JOINED), "the ticket turns keep their place");
  assert.match(String(dispatch.prompt), /SCOPE: ship the checkout flow/);
  assert.match(
    caller.documentPlan.notes.join(" "),
    /per-call budget is 1024, so it falls back to extracted text/,
  );
  assert.equal(caller.documentCalls, 1, "a text-only attachment is still an attachment");
});

test("A NON-PDF NEVER BECOMES A BLOCK — Base64PDFSource is typed application/pdf", () => {
  const plan = planSeatDocuments([
    {
      label: "cv.docx",
      mediaType: DOCX,
      block: null,
      text: "CV: eight years of backend work",
      nativeDeclined: null,
    },
  ]);
  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.base64Chars, 0);
  assert.match(plan.text, /CV: eight years of backend work/);
  assert.match(plan.notes.join(" "), /no native base64 document source/);
});

test("A DOCUMENT WITH NEITHER BYTES NOR TEXT IS ANNOUNCED, NOT DROPPED", () => {
  /*
   * THE SILENT-DROP WATCHER. If this branch returned "" the prompt would be
   * identical to one with no attachment at all, the run log would still say a
   * document was attached, and the criteria would be authored as if the owner
   * had attached nothing. The assertion is therefore on the DIFFERENCE from the
   * plain prompt as well as on the wording.
   */
  const plan = planSeatDocuments([
    { label: "scan.pdf", mediaType: "application/pdf", block: null, text: "", nativeDeclined: null },
  ]);
  const prompt = seatPrompt(request(), plan);
  assert.equal(typeof prompt, "string");
  assert.notEqual(prompt, JOINED, "an unreadable attachment must change the prompt");
  assert.match(String(prompt), /scan\.pdf/);
  assert.match(String(prompt), /ITS CONTENTS ARE NOT BELOW/);
  assert.match(String(prompt), /Do not guess what it said/);
});

test("THE BUDGET IS THE SUM, NOT PER DOCUMENT — the second PDF falls back", () => {
  const half = "Q".repeat(600);
  const plan = planSeatDocuments([pdf("a.pdf", half), pdf("b.pdf", half)], 1_000);

  assert.equal(plan.blocks.length, 1, "only the first fits");
  assert.equal(plan.base64Chars, 600);
  assert.match(plan.text, /extracted text of b\.pdf/);
  assert.match(plan.notes.join(" "), /a\.pdf .*sent as a native document block/);
  assert.match(plan.notes.join(" "), /b\.pdf .*falls back to extracted text/);
});

test("the default per-call budget is one document's worth of base64, derived not re-chosen", () => {
  // If `MAX_NATIVE_PDF_BYTES` moves and this is not re-derived, the two budgets
  // disagree and a document the intake accepted is rejected here for no stated
  // reason. 4 MB decoded -> 5,592,406 base64 characters.
  assert.equal(DEFAULT_SEAT_NATIVE_BASE64_CHARS, 5_592_406);
});

test("A PDF WITH NO BLOCK AND NO REASON IS NOT BLAMED ON ITS MEDIA TYPE", () => {
  /*
   * THE LIE THIS WATCHES FOR. The obvious default sentence — "<type> has no
   * native base64 document source" — is true for a .docx and FALSE for a PDF,
   * whose base64 source is precisely what the API does define. Printed against a
   * PDF whose bytes merely could not be read, it sends the reader to look for an
   * API limitation that does not exist.
   */
  const plan = planSeatDocuments([
    { label: "scope.pdf", mediaType: "application/pdf", block: null, text: "SCOPE", nativeDeclined: null },
  ]);
  const notes = plan.notes.join(" ");
  assert.doesNotMatch(notes, /application\/pdf has no native base64 document source/);
  assert.match(notes, /no reason was given/);
});

test("the caller's own reason for a missing block is the one that gets logged", () => {
  const plan = planSeatDocuments([
    {
      label: "scope.pdf",
      mediaType: "application/pdf",
      block: null,
      text: "SCOPE",
      nativeDeclined: "the PDF is 9000000 bytes and the native budget is 4194304",
    },
  ]);
  assert.match(plan.notes.join(" "), /9000000 bytes and the native budget is 4194304/);
});

/* -------------------------------------------------------------------------
 * 4. seatDocumentsFor — from a path on disk to both halves
 * ---------------------------------------------------------------------- */

const READY: DocumentCapability = {
  pdftotext: { id: "pdftotext", state: "ok", detail: "pdftotext version 26.04.0", checkedAt: "t" },
  textutil: { id: "textutil", state: "ok", detail: "textutil usage", checkedAt: "t" },
};

function extractedOf(path: string, mediaType: string, text: string): ExtractedDocument {
  return {
    path,
    mediaType,
    via: mediaType === "application/pdf" ? "pdftotext" : "textutil",
    text,
    degraded: null,
    outputCapped: false,
    label: path.split("/").pop() ?? path,
  };
}

/** An extractor and a byte reader that never touch the filesystem. */
function sources(text: string, bytes: Buffer | null): {
  readonly extract: NonNullable<Parameters<typeof seatDocumentsFor>[1]["extract"]>;
  readonly readBytes: NonNullable<Parameters<typeof seatDocumentsFor>[1]["readBytes"]>;
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    extract: (path, mediaType) => Promise.resolve(extractedOf(path, mediaType, text)),
    readBytes: (path) => {
      reads.push(path);
      return bytes;
    },
    reads,
  };
}

test("a PDF on disk arrives with BOTH a native block and its extracted text", async () => {
  const { extract, readBytes } = sources("SCOPE: ship the checkout flow", Buffer.from("%PDF-1.7 fake"));
  const documents = await seatDocumentsFor(
    [{ path: "/runs/r1/documents/Project Scope.pdf", mediaType: "application/pdf" }],
    { capability: READY, extract, readBytes },
  );

  const document = documents[0];
  assert.ok(document !== undefined);
  assert.equal(document.label, "Project Scope.pdf", "the basename, never the host path");
  assert.notEqual(document.block, null, "a PDF inside budget goes native");
  assert.equal(document.block?.source.data, Buffer.from("%PDF-1.7 fake").toString("base64"));
  assert.equal(document.nativeDeclined, null);
  // The fallback exists even though the block does — the per-call budget across
  // ALL documents is decided later, and a document without text can only be
  // dropped at that point.
  assert.match(document.text, /SCOPE: ship the checkout flow/);
  assert.doesNotMatch(document.text, /\/runs\/r1/, "no host path in seat-facing text");
});

test("A PDF WHOSE BYTES CANNOT BE READ still reaches the seat, as text, with the real reason", async () => {
  const { extract, readBytes, reads } = sources("SCOPE: ship the checkout flow", null);
  const documents = await seatDocumentsFor(
    [{ path: "/runs/r1/documents/gone.pdf", mediaType: "application/pdf" }],
    { capability: READY, extract, readBytes },
  );

  const document = documents[0];
  assert.ok(document !== undefined);
  assert.deepEqual(reads, ["/runs/r1/documents/gone.pdf"]);
  assert.equal(document.block, null);
  assert.match(String(document.nativeDeclined), /bytes could not be read within the 4194304-byte native budget/);
  assert.match(document.text, /SCOPE: ship the checkout flow/);
  // And the plan repeats the caller's reason rather than inventing one.
  assert.match(planSeatDocuments(documents).notes.join(" "), /bytes could not be read/);
});

test("a non-PDF is never even read off disk — there is no native form to build", async () => {
  const { extract, readBytes, reads } = sources("CV: eight years of backend work", Buffer.from("PK"));
  const documents = await seatDocumentsFor([{ path: "/runs/r1/documents/cv.docx", mediaType: DOCX }], {
    capability: READY,
    extract,
    readBytes,
  });

  const document = documents[0];
  assert.ok(document !== undefined);
  assert.deepEqual(reads, [], "a .docx must not be read off disk: no native block can be built from it");
  assert.equal(document.block, null);
  assert.equal(document.nativeDeclined, null, "the media type IS the reason here, and it is true");
  assert.match(document.text, /CV: eight years of backend work/);
});

test("an UNREADABLE document is announced to the seat rather than omitted", async () => {
  // The extractor's own degraded shape — a scanned PDF with no text layer —
  // rendered by `documentPromptText`, plus no bytes to fall back on.
  const extract = (path: string, mediaType: string): Promise<ExtractedDocument> =>
    Promise.resolve({
      path,
      mediaType,
      via: "none" as const,
      text: "",
      degraded: { code: "no-text-extracted" as const, detail: "pdftotext exited 0 but produced no text" },
      outputCapped: false,
      label: "scan.pdf",
    });
  const documents = await seatDocumentsFor([{ path: "/runs/r1/documents/scan.pdf", mediaType: "application/pdf" }], {
    capability: READY,
    extract,
    readBytes: () => null,
  });

  const prompt = String(seatPrompt(request(), planSeatDocuments(documents)));
  assert.notEqual(prompt, JOINED);
  assert.match(prompt, /IT COULD NOT BE READ/);
  assert.match(prompt, /pdftotext exited 0 but produced no text/);
});

/* -------------------------------------------------------------------------
 * 5. The cost is reported as a measurement
 * ---------------------------------------------------------------------- */

test("the delivery line multiplies the REAL size by the REAL number of calls", async () => {
  const recorder = recordingQuery();
  const caller = callerWith(recorder, [pdf("scope.pdf", "Q".repeat(100))]);

  await caller.call(request());
  await caller.call(request());

  const line = describeSeatDocuments(caller.documentPlan, caller.documentCalls);
  assert.match(line, /1 attached document\(s\)/);
  assert.match(line, /100 base64 chars, re-sent on each of 2 call\(s\) = 200 base64 chars in total/);
  // No token figure: this file cannot convert bytes to tokens and must not
  // invent a per-page number in a line the owner reads as measurement.
  assert.doesNotMatch(line, /token/i);
});

test("a seat with no documents says so rather than reporting an empty attachment", () => {
  assert.equal(describeSeatDocuments(NO_SEAT_DOCUMENTS, 0), "no documents were attached to this seat");
});

/* -------------------------------------------------------------------------
 * 5. The seam, and the SDK's own types
 * ---------------------------------------------------------------------- */

test("the DEFAULT session factory is the SDK's own query, by identity", () => {
  const caller = new SubscriptionSeatCaller(SEAT, { budget: DASHBOARD_BUDGET, cwd: tmpdir(), env: {} });
  // A default argument can be swapped for a stub and every test above would
  // still pass. This is the only assertion that would not.
  assert.equal(caller.startQuery, query);
});

/**
 * THE SDK-DRIFT WATCHER, the same instrument `document-intake.test.ts` ends
 * with. The block travels as a structural type because `@anthropic-ai/sdk` is
 * transitive here; this assignment is what makes a renamed field or a narrowed
 * union fail `npm run build` instead of returning a 400 from a live call.
 */
test("the citation-enabled block is still assignable to the SDK's DocumentBlockParam", () => {
  const plan = planSeatDocuments([pdf("scope.pdf", "QkFTRTY0")]);
  const block = plan.blocks[0];
  assert.ok(block !== undefined);
  const asSdkBlock: DocumentBlockParam = block;
  assert.equal(asSdkBlock.type, "document");
  assert.deepEqual(asSdkBlock.citations, { enabled: true });
});
