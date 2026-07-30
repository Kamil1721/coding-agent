/**
 * live-parse.unit.spec.ts — the CLIENT's SSE parser, which nothing tested.
 *
 * WHY THIS FILE EXISTS. `GraphNode.activity` carries a timestamp per step, and it was
 * verified by replaying a finished run: "388/388 events carry `at`, 304 distinct
 * timestamps spanning 104.9 minutes". That measured `graphSnapshot` — the SERVER fold
 * — and there are TWO paths into the graph. The other one is this parser, over the
 * live SSE stream, and it rebuilt each event field by field without `at`.
 *
 * So every step that arrived while you watched a run printed an em dash, and the
 * check went green because it never touched this code. A property proved on one of
 * two paths is proved on one path.
 */

import { expect, test } from "@playwright/test";

import { parseRunEvent, traceRowFor } from "@/lib/use-run-stream";

/** One SSE `data:` frame, as the server now writes it (`SseWireEvent`). */
const TOOL_FRAME = JSON.stringify({
  type: "graph_tool",
  node: "n1",
  name: "Bash",
  mcpServer: null,
  summary: "command: gemini-image.sh",
  attribution: "exact",
  at: "2026-07-30T00:49:13.000Z",
});

test("a LIVE graph_tool frame keeps the server's timestamp", () => {
  const event = parseRunEvent(TOOL_FRAME, "graph_tool");
  expect(event).not.toBeNull();
  expect(
    (event as { at?: string }).at,
    "the live parser dropped `at`, so every step arriving during a run showed no time",
  ).toBe("2026-07-30T00:49:13.000Z");
});

test("a LIVE graph_skill frame keeps the server's timestamp", () => {
  const frame = JSON.stringify({
    type: "graph_skill",
    node: "n1",
    skill: "imagegen-frontend-web",
    source: "invoked",
    attribution: "exact",
    at: "2026-07-30T00:48:27.832Z",
  });
  const event = parseRunEvent(frame, "graph_skill");
  expect(event).not.toBeNull();
  expect((event as { at?: string }).at).toBe("2026-07-30T00:48:27.832Z");
});

test("a frame with NO `at` parses, and carries no `at` key at all", () => {
  /*
   * Every run recorded before the wire carried `at`. It must still fold — and it must
   * produce a MISSING key rather than an explicit undefined, which is what
   * `exactOptionalPropertyTypes` and `instantOf`'s `"at" in event` both expect.
   */
  const frame = JSON.stringify({
    type: "graph_tool",
    node: "n1",
    name: "Read",
    mcpServer: null,
    summary: "file_path: /w/a.ts",
    attribution: "exact",
  });
  const event = parseRunEvent(frame, "graph_tool");
  expect(event).not.toBeNull();
  expect(Object.hasOwn(event as object, "at")).toBe(false);
});

test("a non-string `at` is refused rather than trusted", () => {
  // Wire data is untrusted; a number here would reach `new Date()` in the UI.
  const frame = JSON.stringify({
    type: "graph_tool",
    node: "n1",
    name: "Read",
    mcpServer: null,
    summary: "x",
    attribution: "exact",
    at: 1234567890,
  });
  const event = parseRunEvent(frame, "graph_tool");
  expect(Object.hasOwn(event as object, "at")).toBe(false);
});

/* -------------------------------------------------------------------------
 * rate_limit — the event that told a healthy run it was rate limited
 * ---------------------------------------------------------------------- */

/**
 * THE REGRESSION FOR `run-2026-07-30T13-31-38-076Z-c228e63b`.
 *
 * Two seconds into that run the timeline printed `rate limited; retry after
 * 253699s` — a 70.5-hour wait, on a subscription that was working. The run's own
 * row says `rate_limited = 0`: the provider had refused NOTHING. What the SDK
 * actually reported was when the seven-day window rolls over, which it does
 * routinely with `status: 'allowed'`.
 *
 * The number was never wrong. The event simply had no way to say "this is not a
 * refusal", so the server emitted it for both cases and this parser hard-coded
 * `limited: true` for whatever arrived.
 */
test("a LIVE rate_limit frame that refused nothing does not claim a limit", () => {
  const frame = JSON.stringify({ type: "rate_limit", limited: false, retryAfterSec: 253699 });
  const event = parseRunEvent(frame, "rate_limit");
  expect(event).not.toBeNull();
  expect(
    (event as { limited?: boolean }).limited,
    "the client read `limited: true` off every rate_limit frame, so window telemetry read as a refusal",
  ).toBe(false);
  expect(
    (event as { retryAfterSec?: number }).retryAfterSec,
    "the reset instant is still carried — it is worth showing as a window fills, just not as a refusal",
  ).toBe(253699);
});

test("a LIVE rate_limit frame that IS a refusal still says so", () => {
  const frame = JSON.stringify({ type: "rate_limit", limited: true, retryAfterSec: 900 });
  const event = parseRunEvent(frame, "rate_limit");
  expect((event as { limited?: boolean }).limited).toBe(true);
  expect((event as { retryAfterSec?: number }).retryAfterSec).toBe(900);
});

test("a rate_limit frame with no `limited` field is read as NOT limited", () => {
  /*
   * A frame from a server that predates the flag reports a window reset instant
   * and nothing about a refusal, so "not limited" is what it actually said. The
   * old default was the opposite, and that default IS the bug.
   */
  const frame = JSON.stringify({ type: "rate_limit", retryAfterSec: 253699 });
  const event = parseRunEvent(frame, "rate_limit");
  expect((event as { limited?: boolean }).limited).toBe(false);
});

/* -------------------------------------------------------------------------
 * The words the reader sees
 * ---------------------------------------------------------------------- */

/**
 * WHY THIS IS A UNIT TEST AND NOT A BROWSER ONE, STATED PLAINLY.
 *
 * The trace is LIVE-ONLY. Opening the recorded run that produced this defect
 * shows "This run finished before the page was opened, so there is no live trace
 * to replay" — verified in a real browser this session. The row the owner saw
 * existed only while the run was in flight, so there is no finished-run render
 * that can be inspected after the fact, and this function is the last thing
 * between the event and the sentence.
 */
test("a report that refused nothing does not get the word `rate limited`", () => {
  const row = traceRowFor({ type: "rate_limit", limited: false, retryAfterSec: 253_699 });
  expect(row).not.toBeNull();
  expect(
    row?.text,
    "`rate limited; retry after 253699s` on a healthy subscription is the sentence this fixes",
  ).not.toMatch(/rate limited/i);
  expect(row?.text).toMatch(/nothing refused/i);
  expect(row?.level, "and it is not a warning — nothing went wrong").toBe("info");
});

test("a real refusal still reads as one, and still warns", () => {
  const row = traceRowFor({ type: "rate_limit", limited: true, retryAfterSec: 900 });
  expect(row?.text).toMatch(/rate limited; retry after 900s/);
  expect(row?.level).toBe("warn");
});

/* -------------------------------------------------------------------------
 * The trace's clock — receipt time is not event time
 * ---------------------------------------------------------------------- */

/**
 * THIS REPOSITORY'S SIGNATURE DEFECT, CAUGHT BEFORE IT SHIPPED A THIRD TIME.
 *
 * `traceRowFor` stamped `Date.now()` — the moment the CLIENT received the frame.
 * That looks perfect while you watch a run stream and is silently wrong on
 * REPLAY, where refreshing the page re-delivers an hour of history in one burst
 * and every row claims to have just happened.
 *
 * It matters because the canvas now renders "last heard N min ago" during the
 * spec phase. MEASURED on the run that passed: that phase ran 79.5 minutes and
 * emitted six events, with gaps of 32 and 43 minutes. So the exact state this
 * clock is read in is "a run that has been silent for a long time" — and with
 * receipt time, a refresh would have reported "just now" about a forty-minute
 * silence. The reassuring answer, and the false one.
 */
test("a log row carries the SERVER's instant, not the moment it arrived", () => {
  const frame = JSON.stringify({
    type: "log",
    level: "info",
    text: "authoring the held-out acceptance suite",
    at: "2026-07-29T23:28:46.000Z",
  });
  const event = parseRunEvent(frame, "log");
  expect(event).not.toBeNull();
  expect((event as { at?: string }).at).toBe("2026-07-29T23:28:46.000Z");

  const row = traceRowFor(event as Parameters<typeof traceRowFor>[0]);
  expect(
    row?.atMs,
    "receipt time makes a 43-minute silence read as `just now` after any page refresh",
  ).toBe(Date.parse("2026-07-29T23:28:46.000Z"));
});

test("a log frame with NO `at` still folds, and falls back to receipt time", () => {
  // Every run recorded before the wire carried `at`. It must not vanish, and it
  // must not produce NaN — "NaN min ago" is worse than an approximate time.
  const before = Date.now();
  const event = parseRunEvent(JSON.stringify({ type: "log", level: "info", text: "old" }), "log");
  const row = traceRowFor(event as Parameters<typeof traceRowFor>[0]);
  expect(Object.hasOwn(event as object, "at")).toBe(false);
  expect(Number.isNaN(row?.atMs ?? Number.NaN)).toBe(false);
  expect(row?.atMs ?? 0).toBeGreaterThanOrEqual(before);
});

test("an UNPARSEABLE `at` falls back rather than rendering NaN", () => {
  const event = parseRunEvent(
    JSON.stringify({ type: "log", level: "info", text: "x", at: "not-a-date" }),
    "log",
  );
  const row = traceRowFor(event as Parameters<typeof traceRowFor>[0]);
  expect(Number.isNaN(row?.atMs ?? Number.NaN)).toBe(false);
});
