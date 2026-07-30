/**
 * activity.unit.spec.ts — the humaniser, driven by summaries taken off the
 * recorded run.
 *
 * WHY THE INPUTS ARE COPIED RATHER THAN INVENTED. This module's failure mode is
 * invisible: a mis-parsed path still renders as a tidy line, so a test written
 * against a convenient fixture passes while the real stream comes out as
 * "generating a design reference" for everything. Every summary below was read out
 * of `data/runs.db` for `run-2026-07-29T23-28-46-665Z-3d4d1ccb` with the
 * timestamps that came with it — paths, em dashes, truncation and all.
 */

import { expect, test } from "@playwright/test";

import { collapseAdjacent, describeActivity, readableSummary } from "@/lib/activity";
import type { GraphActivityEntry } from "@/lib/api-types";

const WORKSPACE =
  "/Users/kamilborzecki/Projects/coding-agent/dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace";

function entry(overrides: Partial<GraphActivityEntry>): GraphActivityEntry {
  return {
    at: "2026-07-30T00:49:13.000Z",
    kind: "tool",
    name: "Bash",
    detail: "",
    truncated: false,
    ...overrides,
  };
}

test("the image-generation call reads as designing the thing it names", () => {
  // VERBATIM from the run: this is what six of its calls looked like.
  const line = describeActivity(
    entry({
      name: "Bash",
      detail:
        'command: /Users/kamilborzecki/.claude/scripts/gemini-image.sh "A premium website design comp — hero section for \'Coglane\', a neighbourhood bicycle repair shop in a converted railway arch"',
    }),
  );

  expect(line.verb).toBe("generating");
  expect(line.object).toBe("hero section reference");
  expect(line.kind).toBe("design");
  // The full command is always recoverable — nothing is thrown away.
  expect(line.raw).toContain("gemini-image.sh");
});

test("each section of the real run gets its own subject, not one generic label", () => {
  /*
   * THE CHECK THAT CAN ACTUALLY FAIL. A parser that returns "a design reference"
   * for everything satisfies "it produced a readable line" and destroys the entire
   * point, which is telling the hero step from the services step. Six prompts, six
   * distinct subjects.
   */
  const prompts = [
    ["hero section", "hero section reference"],
    ["services section", "services section reference"],
    ["opening hours section", "opening hours section reference"],
    ["booking modal section", "booking modal section reference"],
  ] as const;

  const seen = new Set<string>();
  for (const [section, expected] of prompts) {
    const line = describeActivity(
      entry({
        detail: `command: /Users/kamilborzecki/.claude/scripts/gemini-image.sh "A premium website design comp — ${section} for 'Coglane', a neighbourhood bicycle repair shop"`,
      }),
    );
    expect(line.object, `the ${section} prompt lost its subject`).toBe(expected);
    seen.add(line.object);
  }
  expect(seen.size, "every prompt collapsed to the same label").toBe(prompts.length);
});

test("reading an image is `looking at`, and it is design work", () => {
  const line = describeActivity(
    entry({ name: "Read", detail: `file_path: ${WORKSPACE}/design-refs/01-hero.png` }),
  );

  expect(line.verb).toBe("looking at");
  // The 92-character absolute path is gone; the filename is what identifies it.
  expect(line.object).toBe("01-hero.png");
  expect(line.kind).toBe("design");
});

test("reading source is `reading`, and it is not design work", () => {
  const line = describeActivity(
    entry({ name: "Read", detail: `file_path: ${WORKSPACE}/index.html` }),
  );
  expect(line.verb).toBe("reading");
  expect(line.object).toBe("index.html");
  expect(line.kind).toBe("read");
});

test("housekeeping is classed as housekeeping so it cannot outshout the design", () => {
  const line = describeActivity(
    entry({ detail: `command: mkdir -p "${WORKSPACE}/design-refs" && ls -la "${WORKSPACE}"` }),
  );
  expect(line.verb).toBe("ran");
  expect(line.object).toBe("mkdir");
  expect(line.kind).toBe("housekeeping");
});

test("the Skill tool's JSON summary yields the skill name", () => {
  // The one summary in the set that is not `key: value`.
  const line = describeActivity(entry({ name: "Skill", detail: '{"skill":"imagegen-frontend-web"}' }));
  expect(line.verb).toBe("loading skill");
  expect(line.object).toBe("imagegen-frontend-web");
});

test("a Skill summary that is not JSON degrades to the raw detail, not a broken brace", () => {
  const line = describeActivity(entry({ name: "Skill", detail: "{not json" }));
  expect(line.object).toBe("{not json");
});

test("a delegation names the task it delegated", () => {
  const line = describeActivity(
    entry({ name: "Agent", detail: "description: Gather design context for ui-designer" }),
  );
  expect(line.verb).toBe("delegating");
  expect(line.object).toBe("Gather design context for ui-designer");
  expect(line.kind).toBe("delegate");
});

test("a skill-kind entry is a skill load regardless of tool name", () => {
  const line = describeActivity(
    entry({ kind: "skill", name: "superpowers:brainstorming", detail: "invoked" }),
  );
  expect(line.verb).toBe("loading skill");
  expect(line.object).toBe("superpowers:brainstorming");
});

test("one skill load reported down BOTH channels renders as ONE line, not ×2", () => {
  /*
   * OBSERVED IN THE PANEL, not imagined. The CLI reports a skill load twice — a
   * `Skill` tool call and a `graph_skill` event — with the same recorded instant,
   * and the timeline showed both:
   *
   *     02:48:27  loading skill imagegen-frontend-web
   *     02:48:27  loaded skill imagegen-frontend-web
   *
   * One act, so one line, and the count must NOT say ×2 — the agent did not load it
   * twice and the display must not claim it did.
   */
  // THE REAL TIMESTAMPS, 3ms apart — seq 25 and seq 27 of the recorded run. An
  // equality check passes a test written with one shared `at` and still shows "×2"
  // in the panel, which is exactly what happened on the first attempt.
  const runs = collapseAdjacent([
    describeActivity(
      entry({ at: "2026-07-30T00:48:27.829Z", name: "Skill", detail: '{"skill":"imagegen-frontend-web"}' }),
    ),
    describeActivity(
      entry({ at: "2026-07-30T00:48:27.832Z", kind: "skill", name: "imagegen-frontend-web", detail: "invoked" }),
    ),
  ]);

  expect(runs).toHaveLength(1);
  expect(runs[0]?.repeats, "the same act at the same instant is not a repeat").toBe(1);
  expect(runs[0]?.object).toBe("imagegen-frontend-web");
});

test("a genuine repeat at a LATER instant still counts", () => {
  // The other side of the same-instant rule: this must not be swallowed too.
  const runs = collapseAdjacent([
    describeActivity(entry({ at: "2026-07-30T00:49:22.000Z", name: "Read", detail: "file_path: /w/a.ts" })),
    describeActivity(entry({ at: "2026-07-30T00:49:41.000Z", name: "Read", detail: "file_path: /w/a.ts" })),
  ]);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.repeats).toBe(2);
});

test("two untimed identical entries still count as two", () => {
  /*
   * On a pre-timestamp run EVERY entry is `at: null`. Treating null==null as "the
   * same instant" would silently merge every real repeat on every historical run —
   * a data-loss bug that looks like a tidier list.
   */
  const runs = collapseAdjacent([
    describeActivity(entry({ at: null, name: "Read", detail: "file_path: /w/a.ts" })),
    describeActivity(entry({ at: null, name: "Read", detail: "file_path: /w/a.ts" })),
  ]);
  expect(runs[0]?.repeats).toBe(2);
});

test("an unknown tool prints as itself rather than being dressed in a verb", () => {
  /*
   * THE ANTI-PLAUSIBILITY CHECK. An MCP tool this file has never heard of must look
   * unhandled. Mapping it onto a friendly verb would make a wrong description
   * indistinguishable from a right one, which is the defect shape this repository
   * keeps recording.
   */
  const line = describeActivity(
    entry({ name: "mcp__context7__query-docs", detail: "library: react" }),
  );
  expect(line.verb).toBe("mcp__context7__query-docs");
  expect(line.object).toBe("react");
});

test("a null `at` stays null — no clock is ever invented", () => {
  const line = describeActivity(entry({ at: null, name: "Read", detail: "file_path: /w/a.ts" }));
  expect(line.at).toBeNull();
});

test("the server's truncation flag survives to the line", () => {
  const line = describeActivity(entry({ truncated: true, detail: "command: npm run build" }));
  expect(line.truncated).toBe(true);
});

test("adjacent repeats collapse to a count WITHOUT reordering anything", () => {
  /*
   * The property that matters: a build segment reads the same file forty times and
   * buries the two design steps. Collapsing is ADJACENT-ONLY, so a later repeat of
   * an earlier line stays where it happened — a group-by would hoist it and turn
   * the timeline into a histogram.
   */
  // DISTINCT INSTANTS, because these are three separate reads. Reusing one
  // timestamp would make them the same act reported three times, which the
  // same-instant rule in `collapseAdjacent` correctly folds to a single line.
  const lines = [
    describeActivity(entry({ at: "2026-07-30T00:49:01.000Z", name: "Read", detail: "file_path: /w/a.ts" })),
    describeActivity(entry({ at: "2026-07-30T00:49:02.000Z", name: "Read", detail: "file_path: /w/a.ts" })),
    describeActivity(entry({ at: "2026-07-30T00:49:03.000Z", name: "Read", detail: "file_path: /w/a.ts" })),
    describeActivity(entry({ at: "2026-07-30T00:49:04.000Z", name: "Write", detail: "file_path: /w/b.ts" })),
    // The SAME read again, but later. It must not merge with the first group.
    describeActivity(entry({ at: "2026-07-30T00:49:05.000Z", name: "Read", detail: "file_path: /w/a.ts" })),
  ];

  const runs = collapseAdjacent(lines);
  expect(runs.map((r) => `${r.verb} ${r.object} x${String(r.repeats)}`)).toEqual([
    "reading a.ts x3",
    "writing b.ts x1",
    "reading a.ts x1",
  ]);
});

test("two GENUINE rapid repeats are never merged, however close together", () => {
  /*
   * THE CASE THE FIRST VERSION OF THE SAME-ACT WINDOW GOT WRONG, and that no
   * measurement of the recorded run could have surfaced — every step in that run
   * waits on a subprocess, so nothing was ever <250ms apart.
   *
   * A build segment doing two consecutive `Edit`s on one file inside the window
   * would have been silently folded into a single line: real work vanishing from the
   * record to make the list look tidier. The window is now restricted to `skill`,
   * where the double-report actually comes from, so this must count as two.
   */
  const runs = collapseAdjacent([
    describeActivity(entry({ at: "2026-07-30T00:49:22.100Z", name: "Edit", detail: "file_path: /w/index.html" })),
    describeActivity(entry({ at: "2026-07-30T00:49:22.140Z", name: "Edit", detail: "file_path: /w/index.html" })),
  ]);

  expect(runs).toHaveLength(1);
  expect(runs[0]?.repeats, "40ms apart, but two real edits — not one").toBe(2);
});

test("the reported summary loses the absolute path and the markdown, not the facts", () => {
  /*
   * VERBATIM from `ui-designer` on the recorded run — the string the owner called "a
   * wall of text". Two thirds of it is one absolute path.
   */
  const raw =
    "Chosen: `01-hero.png` — written to " +
    "`/Users/kamilborzecki/Projects/coding-agent/dashboard/runs/run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/design-refs/choice.json`. " +
    "Per-ref verdicts: - **01-hero**: strongest overall — eyebrow, display headline, tagline.";

  const clean = readableSummary(raw);

  // The path is gone, the file it named is not.
  expect(clean).not.toContain("/Users/kamilborzecki");
  expect(clean).not.toContain("dashboard/runs");
  expect(clean).toContain("choice.json");

  // Markdown that nothing renders is gone; the words it wrapped stay.
  expect(clean).not.toContain("**");
  expect(clean).not.toContain("`");
  expect(clean).toContain("01-hero");
  expect(clean).toContain("strongest overall");

  // EVERY FACT SURVIVES — this is a substitution, not a paraphrase, which is why it
  // can still be labelled "what it reported".
  expect(clean).toContain("Chosen");
  expect(clean).toContain("written to");
  expect(clean).toContain("Per-ref verdicts");
  expect(clean).toContain("display headline");

  // And it is materially shorter, which was the point.
  expect(clean.length).toBeLessThan(raw.length - 100);
});

test("a summary with no paths or markdown is returned essentially unchanged", () => {
  // The cleaner must not mangle an already-clean message.
  const plain = "Two findings: the booking form accepts an empty email, and the hero lacks alt text.";
  expect(readableSummary(plain)).toBe(plain);
});

test("text containing slashes is NOT mistaken for a path — the corruption bug", () => {
  /*
   * OBSERVED IN THE PANEL. The first cleaner had an unanchored path pattern and turned
   *
   *   "plain HTML/CSS/JS, no build step"   into   "plain HTMLJS, no build step"
   *
   * — silent content corruption, which is worse than the wall of text it was cleaning
   * because it reads as something the agent actually wrote. A path's slash must START
   * the token; `HTML/CSS/JS` has a letter before its first slash.
   */
  const clean = readableSummary("One-page static site — plain HTML/CSS/JS, no build step.");
  expect(clean).toContain("HTML/CSS/JS");

  // And the real path in the same sentence still collapses.
  const mixed = readableSummary("plain HTML/CSS/JS written to `/Users/o/proj/run/workspace/index.html`.");
  expect(mixed).toContain("HTML/CSS/JS");
  expect(mixed).toContain("index.html");
  expect(mixed).not.toContain("/Users/o");
});

test("markdown headings do not survive as literal hashes", () => {
  const clean = readableSummary("## Handoff Summary for ui-designer\n\n(a) Core product brief");
  expect(clean).not.toContain("##");
  expect(clean).toContain("Handoff Summary for ui-designer");
});
