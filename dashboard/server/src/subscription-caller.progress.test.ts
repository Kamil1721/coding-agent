/**
 * subscription-caller.progress.test.ts — the 51-minute black box, and the bound
 * on what replaces it.
 *
 * ─── THE RUN THIS FILE IS ABOUT ───
 *
 * `run-2026-08-04T11-08-10-487Z-162b186d` spent 51 minutes in the spec phase and
 * recorded 61 events across the WHOLE run: 36 `log`, 11 `status`, 9 `rate_limit`,
 * 4 `phase`, 1 `verdict`. Zero `tool`. Zero `graph_*`. A run that reached the
 * build recorded 388. The spec phase was not badly instrumented — this caller
 * emitted nothing at all, and the seat it drives has `tools: []`, so there was no
 * tool call for any other layer to notice either. The only signal a toolless seat
 * can produce is the text it is streaming, and `includePartialMessages` was
 * hardcoded `false`, so the SDK yielded exactly two frames for a fifty-minute
 * turn: the finished assistant message and the result.
 *
 * ─── WHAT IS ACTUALLY BEING CHECKED, AND WHAT CANNOT BE ───
 *
 * The fake `startQuery` yields whatever frames it is given REGARDLESS of the
 * options it was handed, so "progress arrived" alone would stay green with
 * `includePartialMessages: false` — the flag would be dead and the test would not
 * know. Test 1 therefore asserts the OPTION on the wire and the reports together;
 * the option is the half that fails when the flag is reverted.
 *
 * ─── NEGATIVE CONTROLS ───
 *
 * Each mutation applied to production code alone, run, WATCHED RED, reverted
 * (2026-08-04). See the file's tail for the recorded outcomes.
 *
 * NO MODEL IS CALLED. `startQuery` is replaced with a factory that replays fixed
 * frames, the same seam `subscription-caller.overflow.test.ts` uses.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SeatCallRequest } from "bakeoff/dist/anthropic-seat.js";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";

import { DASHBOARD_BUDGET } from "./orchestrator.js";
import {
  SEAT_PROGRESS_CHARS,
  SEAT_PROGRESS_INTERVAL_MS,
  SeatProgressCoalescer,
  SubscriptionSeatCaller,
  partialAssistantText,
} from "./subscription-caller.js";
import type { SeatProgress, SeatSessionFactory } from "./subscription-caller.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const SEAT: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };

function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

/** One `SDKPartialAssistantMessage` carrying a text delta (`sdk.d.ts:4150`). */
function textDelta(text: string): SDKMessage {
  return envelope({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
}

/**
 * The thinking form. MEASURED EMPTY: 7,037 thinking blocks across four models in
 * the local corpus, zero with any text, the `signature` beside them encrypted.
 * The delta exists on the wire; there is nothing in it.
 */
function thinkingDelta(text: string): SDKMessage {
  return envelope({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } },
  });
}

function assistantFrame(text: string): SDKMessage {
  return envelope({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function resultFrame(text: string): SDKMessage {
  return envelope({
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: text,
    usage: { input_tokens: 10, output_tokens: 20 },
  });
}

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

function replaying(frames: readonly SDKMessage[]): {
  factory: SeatSessionFactory;
  dispatches: Dispatch[];
} {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      for (const frame of frames) yield frame;
    })();
  };
  return { factory, dispatches };
}

function request(overrides: Partial<SeatCallRequest> = {}): SeatCallRequest {
  return {
    system: "author an acceptance suite",
    userTurns: ["TICKET: build a landing page"],
    maxOutputTokens: 64_000,
    jsonSchema: null,
    purpose: "suite-authoring t-progress attempt 1",
    ...overrides,
  };
}

function callerWith(
  factory: SeatSessionFactory,
  progress?: { readonly onProgress: (p: SeatProgress) => void; readonly progressIntervalMs?: number },
): SubscriptionSeatCaller {
  return new SubscriptionSeatCaller(SEAT, {
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    startQuery: factory,
    ...(progress ?? {}),
  });
}

/* -------------------------------------------------------------------------
 * 1. The seat is no longer silent
 * ---------------------------------------------------------------------- */

test("the seat asks for partial messages and reports what streams past it", async () => {
  // Long enough to cross SEAT_PROGRESS_CHARS, which is what fires the leading
  // report; the interval never elapses in a synchronous replay.
  const deltas = ["criterion C-001: the hero ", "renders above the fold. ".repeat(20)];
  const { factory, dispatches } = replaying([
    ...deltas.map(textDelta),
    assistantFrame("the finished suite"),
    resultFrame("the finished suite"),
  ]);
  const seen: SeatProgress[] = [];
  const caller = callerWith(factory, { onProgress: (p) => seen.push(p) });

  await caller.call(request());

  // THE HALF THAT FAILS WHEN THE FLAG IS REVERTED. The fake factory yields the
  // deltas whatever the options say, so without this assertion the test would
  // pass against a caller that never asked the SDK for a single partial frame.
  assert.equal(dispatches[0]?.options.includePartialMessages, true);

  assert.ok(seen.length >= 1, "the seat reported nothing while it was streaming");
  const first = seen[0];
  assert.ok(first !== undefined);
  assert.equal(first.purpose, "suite-authoring t-progress attempt 1");
  assert.ok(first.text.length > 0, "a progress report carried no text");
  assert.ok(first.chars >= SEAT_PROGRESS_CHARS);
  assert.ok(first.elapsedMs >= 0);
});

/* -------------------------------------------------------------------------
 * 2. No consumer, no cost
 * ---------------------------------------------------------------------- */

/**
 * PINS A CLAIM THAT WOULD OTHERWISE BE AN ASSERTION IN A DOCBLOCK. `judge.ts`
 * builds its own caller and passes no `onProgress`; every existing test does the
 * same. A 64,000-token response streams as 20,000-30,000 `content_block_delta`
 * frames over the subprocess pipe, and paying for them where nothing reads them
 * is a regression wearing a feature's clothes.
 */
test("a seat with nothing listening does not ask the SDK for deltas", async () => {
  const { factory, dispatches } = replaying([assistantFrame("done"), resultFrame("done")]);
  const caller = callerWith(factory);

  await caller.call(request());

  assert.equal(dispatches[0]?.options.includePartialMessages, false);
  assert.equal(caller.reportsProgress, false);
});

/* -------------------------------------------------------------------------
 * 3. The bound
 * ---------------------------------------------------------------------- */

/**
 * 2,000 DELTAS, ONE ROW. Every one of them is pushed through the real `call()`
 * loop and the real coalescer at the production interval; the replay finishes in
 * milliseconds, so the 30-second interval never elapses and only the leading
 * report fires. Without the throttle this is 2,000 durable rows in `events` and
 * 2,000 frames through `bus.ts`'s per-client queue, for one seat call.
 */
test("two thousand deltas coalesce into a single progress row", async () => {
  const deltas = Array.from({ length: 2000 }, (_unused, index) => textDelta(`chunk ${String(index)} `));
  const { factory } = replaying([...deltas, assistantFrame("done"), resultFrame("done")]);
  const seen: SeatProgress[] = [];
  const caller = callerWith(factory, { onProgress: (p) => seen.push(p) });

  await caller.call(request());

  assert.equal(seen.length, 1);
  // The one report is the LEADING one, which fires the moment
  // `SEAT_PROGRESS_CHARS` have arrived — so its `chars` is that threshold and not
  // the ~17,000 the call went on to stream. That the total keeps counting past a
  // report is the fake-clock test below; this one is about the count of rows.
  assert.ok((seen[0]?.chars ?? 0) >= SEAT_PROGRESS_CHARS);
  assert.ok(
    (seen[0]?.text.length ?? 0) <= SEAT_PROGRESS_CHARS + 1,
    "the excerpt was not clipped (the +1 is the leading ellipsis)",
  );
});

/**
 * THE NUMBER THIS LANE PROMISED, MEASURED RATHER THAN ARGUED. Fifty minutes of
 * steady streaming, driven on a fake clock through the production interval.
 *
 * THE BOUND IS 101 AND THE OBSERVED VALUE IS 100, and the difference is worth a
 * sentence rather than a fudged assertion. The leading report is not free of the
 * grid: it fires as soon as `SEAT_PROGRESS_CHARS` have arrived (here at t=5s, the
 * sixth 48-character delta), and every later report is measured from IT, so the
 * interval grid starts at 5s instead of 0 and the last one that fits inside 3,000
 * seconds is the 99th. `1 + floor(3000/30) = 101` is the ceiling — reached only
 * by a call whose leading report lands at t=0 — and no drive can exceed it.
 *
 * The failed run's ENTIRE event stream was 61 rows.
 */
test("a fifty-minute call reports about a hundred times, never more than 101", () => {
  const DELTA = "some prose that the seat is streaming right now. ";
  let clock = 0;
  const seen: SeatProgress[] = [];
  const coalescer = new SeatProgressCoalescer("suite-authoring", (p) => seen.push(p), {
    now: () => clock,
  });
  // One delta per simulated second for 50 minutes.
  for (let second = 0; second < 3000; second += 1) {
    clock = second * 1000;
    coalescer.push(DELTA);
  }

  assert.equal(seen.length, 100);
  assert.ok(seen.length <= 101);
  assert.equal(coalescer.reports, 100);
  assert.equal(SEAT_PROGRESS_INTERVAL_MS, 30_000);
  // NOTHING IS LOST BY COALESCING, ONLY WITHHELD: the character total is of
  // everything that streamed, including the deltas no report ever showed. The
  // last report cannot include the deltas that arrived AFTER it, so the bound is
  // "one interval's worth may be unreported at any instant" — 30 deltas here —
  // and there is deliberately no end-of-call flush: a final row saying what the
  // seat's own `spec seat — …` token line is about to say is a duplicate.
  const streamed = 3000 * DELTA.length;
  const last = seen[seen.length - 1]?.chars ?? 0;
  assert.ok(last <= streamed && last >= streamed - 30 * DELTA.length, String(last));
  // Cumulative and monotonic: a report never restates an earlier total.
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok((seen[index]?.chars ?? 0) > (seen[index - 1]?.chars ?? 0));
  }
});

/* -------------------------------------------------------------------------
 * 4. Isolation is not weakened
 * ---------------------------------------------------------------------- */

/**
 * `tools: []` AND `settingSources: []` ARE LOAD-BEARING (doc 03 §7.4): the spec
 * seat must be a structurally separate agent with no shared history and no access
 * to any implementation. Observability is a host-side switch and must not become
 * a hole in that boundary — so this is asserted on the SAME dispatch that carries
 * the progress flag, rather than in a separate call that could drift away from it.
 */
test("turning progress on gives the seat no capability", async () => {
  const { factory, dispatches } = replaying([
    textDelta("x".repeat(SEAT_PROGRESS_CHARS + 1)),
    assistantFrame("done"),
    resultFrame("done"),
  ]);
  const seen: SeatProgress[] = [];
  const caller = callerWith(factory, { onProgress: (p) => seen.push(p) });

  await caller.call(request());

  const options = dispatches[0]?.options;
  assert.ok(options !== undefined);
  assert.equal(options.includePartialMessages, true);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(seen.length, 1, "the progress path under test did not actually run");
});

/* -------------------------------------------------------------------------
 * 5. The deltas change nothing downstream
 * ---------------------------------------------------------------------- */

/**
 * THE PARSER MUST RECEIVE EXACTLY WHAT IT RECEIVED BEFORE. `spec-agent` parses
 * `SeatCallResult.text`, and the partial frames are a SECOND copy of the same
 * turn — accumulating both would hand the JSON extractor every criterion twice.
 * The coalescer keeps its own buffer and drops it.
 */
test("streaming deltas do not reach the text the parser is given", async () => {
  const { factory } = replaying([
    textDelta("{\"criteria\": ["),
    textDelta("…the whole suite again…"),
    assistantFrame("{\"criteria\": [] }"),
    resultFrame("{\"criteria\": [] }"),
  ]);
  const caller = callerWith(factory, { onProgress: () => undefined, progressIntervalMs: 0 });

  const result = await caller.call(request());

  assert.equal(result.text, "{\"criteria\": [] }");
});

/* -------------------------------------------------------------------------
 * 6. What a delta frame is, read by shape
 * ---------------------------------------------------------------------- */

test("only text deltas are read, and an unknown frame folds to nothing", () => {
  assert.equal(partialAssistantText(textDelta("hello")), "hello");
  // NOT RENDERED AS EMPTY — SKIPPED. Counting a thinking delta would let the
  // character total claim progress with no text behind it.
  assert.equal(partialAssistantText(thinkingDelta("reasoning")), "");
  assert.equal(partialAssistantText(assistantFrame("hello")), "");
  assert.equal(partialAssistantText(envelope({ type: "stream_event" })), "");
  assert.equal(
    partialAssistantText(envelope({ type: "stream_event", event: { type: "message_stop" } })),
    "",
  );
});

/* -------------------------------------------------------------------------
 * 7. The excerpt is the tail, redacted, on one line
 * ---------------------------------------------------------------------- */

test("the excerpt is the newest text, whitespace-collapsed and redacted", () => {
  let clock = 0;
  const seen: SeatProgress[] = [];
  const coalescer = new SeatProgressCoalescer("audit", (p) => seen.push(p), {
    intervalMs: 1000,
    chars: 40,
    now: () => clock,
  });

  coalescer.push("the beginning of the turn\n\n   which is old news by now, and then the newest words");
  clock = 2000;
  coalescer.push("x");

  const report = seen[0];
  assert.ok(report !== undefined);
  // THE TAIL, NOT THE HEAD: the question a liveness row answers is "what is it
  // doing NOW".
  assert.ok(report.text.endsWith("the newest words"), report.text);
  assert.ok(report.text.startsWith("…"), report.text);
  assert.ok(!report.text.includes("\n"), "a log row must be one line");

  seen.length = 0;
  clock = 10_000;
  coalescer.push(`token sk-ant-${"a1B2".repeat(8)} trailing`);
  const redacted = seen[0];
  assert.ok(redacted !== undefined);
  assert.ok(!redacted.text.includes("sk-ant-a1B2"), redacted.text);
  assert.ok(redacted.text.includes("[REDACTED:"), redacted.text);
});

/**
 * A CREDENTIAL SPLIT ACROSS A REPORT BOUNDARY — the defect `orchestrator.ts`
 * names when it says `redact.ts` ships no per-chunk function "because a
 * credential split across two writes cannot be matched by a regex applied to each
 * write separately". A report boundary is a write boundary, so a coalescer that
 * redacted `#pending` alone would be exactly that forbidden per-chunk redact.
 *
 * AND THE HALF THIS CANNOT FIX IS ASSERTED TOO, deliberately, because a test that
 * only showed the win would be claiming a whole repair. The first half is shown by
 * report 1, at a moment when the second half does not exist and no rule can match
 * what is there. Nothing short of withholding the tail — which is what
 * `ReassemblingRedactor` does, at 16,384 characters, 68x this excerpt — closes it,
 * and withholding the tail is withholding the liveness signal.
 */
test("a credential split across a report boundary is caught by the carried window", () => {
  // Long enough that the leading report fires on push 1 — which is what puts the
  // seam between the two halves instead of joining them in one buffer.
  const PAD = "acceptance criteria for the landing page, continued. ".repeat(3);
  const HALF_ONE = "sk-ant-a1B2a1B2";
  const HALF_TWO = "a1B2a1B2a1B2 and then some ordinary prose";
  let clock = 0;
  const seen: SeatProgress[] = [];
  const coalescer = new SeatProgressCoalescer("audit", (p) => seen.push(p), {
    intervalMs: 1000,
    chars: 120,
    now: () => clock,
  });

  coalescer.push(PAD + HALF_ONE);
  clock = 2000;
  coalescer.push(HALF_TWO);

  assert.equal(seen.length, 2);
  // THE RESIDUE, STATED. Half a key, shown before the rest of it arrived. It is
  // not a key yet and `ANTHROPIC_KEY_SHAPE` requires 16 characters after the
  // prefix, so nothing here could have matched it.
  const first = seen[0]?.text ?? "";
  assert.ok(first.includes(HALF_ONE), first);
  assert.equal(first.includes("[REDACTED:"), false);

  // THE REPAIR. Report 2's window reaches back over the seam, the whole key
  // matches, and neither half survives into the row that is persisted.
  const second = seen[1]?.text ?? "";
  assert.ok(second.includes("[REDACTED:ANTHROPIC_KEY_SHAPE]"), second);
  assert.ok(!second.includes(HALF_ONE), second);
  assert.ok(!second.includes("a1B2a1B2a1B2"), second);
  assert.ok(second.endsWith("and then some ordinary prose"), second);
});

/* -------------------------------------------------------------------------
 * 8. A report with nothing to say is not made
 * ---------------------------------------------------------------------- */

test("an empty delta neither reports nor counts", () => {
  const seen: SeatProgress[] = [];
  const coalescer = new SeatProgressCoalescer("plan", (p) => seen.push(p), {
    intervalMs: 0,
    chars: 1,
    now: () => 0,
  });

  coalescer.push("");
  assert.equal(seen.length, 0);

  coalescer.push("a");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.chars, 1);
});

/*
 * ─── MUTATIONS, EACH APPLIED ALONE, WATCHED RED, RESTORED (2026-08-04) ───
 *
 *  M1  subscription-caller.ts: `includePartialMessages: false` (hardcoded, as it
 *      was before this lane)                                            → test 1
 *      and test 4 red. This is the task's first named control.
 *  M2  subscription-caller.ts: `includePartialMessages: true` (hardcoded)
 *                                                                       → test 2
 *      red — the "no consumer, no cost" claim is a check, not a comment.
 *  M3  subscription-caller.ts: `SeatProgressCoalescer.push` sets `const due =
 *      true` (the throttle removed)                                     → 3 red.
 *      The task's second control. Test 3 (2,000 reports instead of 1), the
 *      fifty-minute test (3,000 instead of 100), and test 1 — which fell over on
 *      `chars >= SEAT_PROGRESS_CHARS`, because with no throttle the first report
 *      fires on the first 25-character delta and carries nothing worth reading.
 *  M4  subscription-caller.ts: `tools: ["Read"]` in the options literal  → test 4
 *      red. The task's third control.
 *  M5  subscription-caller.ts: the stream loop accumulates
 *      `text += partialAssistantText(message)`                          → test 5
 *      red (the suite arrives twice).
 *  M6  subscription-caller.ts: `partialAssistantText` accepts
 *      `thinking_delta` as well                                         → test 6
 *      red.
 *  M7  subscription-caller.ts: `tail()` returns the HEAD (`text.slice(0, max)`)
 *                                                                       → test 7
 *      red.
 *  M8  subscription-caller.ts: `const window = this.#pending` (the carried
 *      redaction context removed, which is the per-chunk redact
 *      `orchestrator.ts:5895-5898` forbids)                    → "a credential
 *      split across a report boundary" red.
 */
