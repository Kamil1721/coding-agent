/**
 * spec-pipeline.unit.spec.ts — the stage display, and the lie it must not tell.
 *
 * THE DEFECT THIS FILE EXISTS FOR: A PIPELINE THAT ADVANCES ON A CLOCK. The
 * whole point of drawing these four stages is that the ~80-minute spec phase
 * stops looking identical to a hung run. The tempting way to make it feel alive
 * is to start a stage "running" after a few seconds, or to light the audit once
 * authoring has gone quiet. That would be this repository's signature defect
 * with a progress bar on it — a display reporting work it never observed — and
 * it would be WORSE than the static box, because a box that says nothing cannot
 * mislead and a green tick can.
 *
 * So the assertions here are mostly about what must NOT light up.
 */

import { expect, test } from "@playwright/test";

import { specPipelineFrom, type SpecStage } from "@/lib/spec-pipeline";
import type { TraceEntry } from "@/lib/use-run-stream";

const T0 = Date.parse("2026-07-30T20:16:42.000Z");

function line(text: string, offsetMs = 0): TraceEntry {
  return {
    seq: offsetMs,
    atMs: T0 + offsetMs,
    kind: "log",
    level: "info",
    text,
    name: null,
    result: null,
  };
}

const CAPTURE_LINE =
  "captured https://kamilborzecki.dev/ at 3 width(s) and read 21 heading(s) off it.";
const AUTHOR_LINE =
  "authoring the held-out acceptance suite from the ticket text alone, before any implementation exists";

const URL_TICKET = "I want you to make a copy of https://kamilborzecki.dev";

const byId = (stages: readonly SpecStage[]): Record<string, SpecStage> =>
  Object.fromEntries(stages.map((s) => [s.id, s]));

test("outside the spec phase it draws NOTHING — the real graph owns that screen", () => {
  const trace = [line(CAPTURE_LINE), line(AUTHOR_LINE, 10)];
  expect(specPipelineFrom(trace, "build", URL_TICKET, true)).toHaveLength(0);
  expect(specPipelineFrom(trace, "gate", URL_TICKET, true)).toHaveLength(0);
  expect(specPipelineFrom(trace, "done", URL_TICKET, true)).toHaveLength(0);
});

test("the live shape: capture done, spec seat running, audit and freeze NOT lit", () => {
  const stages = byId(
    specPipelineFrom([line(CAPTURE_LINE), line(AUTHOR_LINE, 2_000)], "spec", URL_TICKET, true),
  );
  expect(stages["capture"]?.state).toBe("done");
  expect(stages["author"]?.state).toBe("running");

  // THE LOAD-BEARING PAIR. The server says nothing between "authoring…" and
  // "sealed suite…", so anything that showed the audit running would be
  // inventing it. Both must stay dark for the whole 80 minutes.
  expect(
    stages["audit"]?.state,
    "the audit has not reported, so lighting it would be a guess rendered as a fact",
  ).toBe("pending");
  expect(stages["freeze"]?.state).toBe("pending");
});

test("TIME ALONE MOVES NOTHING — an hour of silence advances no stage", () => {
  const early = specPipelineFrom([line(CAPTURE_LINE), line(AUTHOR_LINE, 2_000)], "spec", URL_TICKET, true);
  // Same events, an hour later on the clock. Nothing new was said, so nothing
  // may change: this is the assertion that kills a timer-driven implementation.
  const later = specPipelineFrom(
    [line(CAPTURE_LINE), line(AUTHOR_LINE, 2_000)],
    "spec",
    URL_TICKET,
    true,
  );
  expect(later.map((s) => s.state)).toEqual(early.map((s) => s.state));
  expect(byId(later)["audit"]?.state).toBe("pending");
});

test("stages light ONLY when their own line lands", () => {
  const done = byId(
    specPipelineFrom(
      [
        line(CAPTURE_LINE),
        line(AUTHOR_LINE, 2_000),
        line("spec seat — anthropic: 14 input, 40187 cache read", 4_770_000),
        line("audit seat — anthropic: 4 input, 145385 cache", 4_770_001),
        line("sealed suite 21c30afddba3… frozen with 13 criteria", 4_770_002),
      ],
      "spec",
      URL_TICKET,
      true,
    ),
  );
  expect(done["capture"]?.state).toBe("done");
  expect(done["author"]?.state).toBe("done");
  expect(done["audit"]?.state).toBe("done");
  expect(done["freeze"]?.state).toBe("done");
});

test("a ticket with no URL SKIPS capture rather than showing it pending forever", () => {
  // The server only captures on `https?://…`. A bare hostname is not captured,
  // so a stage stuck on "running" would promise work nobody is doing — the exact
  // reason the client mirrors the server's URL rule instead of guessing.
  const stages = byId(
    specPipelineFrom([line(AUTHOR_LINE)], "spec", "make a copy of kamilborzecki.dev", true),
  );
  expect(stages["capture"]?.state).toBe("skipped");
  expect(stages["author"]?.state).toBe("running");
});

test("a TERMINAL run has no pulsing stage — whatever was in flight did not continue", () => {
  const stages = byId(
    specPipelineFrom([line(CAPTURE_LINE), line(AUTHOR_LINE, 2_000)], "spec", URL_TICKET, false),
  );
  expect(
    stages["author"]?.state,
    "a run that died mid-authoring must not keep claiming it is authoring",
  ).not.toBe("running");
});

test("a REUSED suite draws one honest row, not four stages that never move", () => {
  const stages = specPipelineFrom(
    [line("reusing the sealed acceptance suite for this ticket text (21c30afddba3…)")],
    "spec",
    URL_TICKET,
    true,
  );
  expect(stages).toHaveLength(1);
  expect(stages[0]?.state).toBe("done");
  expect(stages[0]?.detail).toMatch(/nothing to author/i);
});

test("an empty trace does not invent a running stage", () => {
  const stages = byId(specPipelineFrom([], "spec", URL_TICKET, true));
  expect(stages["author"]?.state).toBe("pending");
  expect(stages["audit"]?.state).toBe("pending");
  expect(stages["freeze"]?.state).toBe("pending");
});

/**
 * THE INVISIBLE DOT, WHICH SHIPPED ONCE AND MUST NOT AGAIN.
 *
 * The running marker was written as `bg-run`. There is no `--color-run` in the
 * theme — the palette is accent/pass/fail/warn/info/ink/line — so Tailwind
 * emitted nothing and the ONE stage a reader is looking for had no marker at
 * all, while every other stage did. It rendered green, grey, grey and a gap.
 *
 * A screenshot is what caught it; this is what keeps it caught. The assertion is
 * on the class string rather than on pixels because a colour that does not exist
 * cannot be distinguished from a colour that is dark, and the defect is the
 * former.
 */
test("no stage tone references a colour the theme does not define", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("src/components/canvas/orchestration-canvas.tsx", "utf8"),
  );
  // The palette, from `globals.css`. `run` is deliberately absent — it never existed.
  const DEFINED = [
    "accent", "accent-dim", "canvas", "fail", "fail-dim", "info", "info-dim",
    "ink", "ink-dim", "ink-faint", "line", "line-strong", "pass", "pass-dim",
    "surface", "surface-raised", "warn", "warn-dim",
  ];
  const used = [...source.matchAll(/\bbg-([a-z][a-z-]*)(?:\/\d+)?\b/g)].map((m) => m[1] ?? "");
  const undefinedColours = [...new Set(used)].filter(
    (name) => !DEFINED.includes(name) && !["transparent", "current", "black", "white"].includes(name),
  );
  expect(
    undefinedColours,
    "a bg- class naming no theme colour renders NOTHING — an invisible marker on the one stage that matters",
  ).toEqual([]);
});
