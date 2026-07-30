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

import { parseRunEvent } from "@/lib/use-run-stream";

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
