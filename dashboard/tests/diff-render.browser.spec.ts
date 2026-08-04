/**
 * THE GREEN AND RED LINES, ON A RUN THAT HAS ALREADY FINISHED.
 *
 * The owner's ask, verbatim: "when it starts editing it shows the added green
 * lines and taken away red lines etc". This file measures the three ways that
 * can be shipped broken while still looking finished:
 *
 *   1. the colours are drawn but SWAPPED, or applied to the wrong line;
 *   2. a CAPPED patch is drawn as if it were the whole edit;
 *   3. the component is beautiful and NEVER MOUNTED — the diff entry falls
 *      through the timeline's generic renderer and prints `editing page.tsx`,
 *      which looks like a working timeline and contains no patch at all.
 *
 * All three are asserted on CONTENT and on COMPUTED STYLE, never on presence: a
 * `toBeVisible()` on a diff container passes against every one of them.
 *
 * WHY `FINISHED_RUN_ID`, AND WHY THAT IS THE POINT. `use-run-stream.ts:820-822`
 * never constructs an EventSource for a terminal run, so the canvas on this page
 * is built from `GET /api/runs/:id/graph` and from nothing else — the run
 * detail, the criteria and the workspace routes are still answered live by the
 * harness API; it is the GRAPH that has no second source. A feature that reaches
 * the browser through the live `trace` sink renders nothing here. Measuring on the finished
 * run is therefore a check that the diffs survive a reload — the exact defect
 * class the findings doc records at §5 and the one this repository keeps
 * shipping.
 *
 * WHY THE GRAPH ROUTE IS INTERCEPTED RATHER THAN THE FIXTURE EXTENDED.
 * `tests/fixtures/build-run-fixture.ts` is owned by another lane this wave, and
 * `page.route` gives the same thing without a shared edit: every other route —
 * the run detail, the criteria, the events endpoint that this run must never
 * open — is still served by the real harness API. Only the snapshot is ours.
 *
 * THE SNAPSHOT IS FOLDED, NEVER WRITTEN DOWN. `foldGraphAll` is the SERVER's
 * reducer, re-exported by `src/lib/graph.ts` and used by the real route, so the
 * `GraphDiff` these assertions read is the one `capDiff` produced — including
 * its own capping arithmetic. A hand-written `GraphState` literal here would
 * keep answering after the fold broke, which is how a fixture quietly becomes a
 * second implementation.
 *
 * FIVE MUTATIONS WERE APPLIED TO PRODUCTION CODE AND WATCHED — 2026-08-04, each
 * applied, run, reverted, and run green again. The counts are what the runner
 * actually printed, not what was expected:
 *
 *   1. `run/diff.tsx#LINE_CLASS` — `added` and `removed` classes exchanged.
 *      2 of 6 RED. The structure, the text and the element counts survived it
 *      untouched, which is exactly what a presence assertion would have
 *      measured; the resolved colour is what caught it.
 *   2. `run/diff.tsx#CappedNotice` — an unconditional `return null` at the top.
 *      2 of 6 RED (both capped tests). The patch bodies, the counts and the
 *      attribution checks all stayed green, which is the shape of the defect:
 *      the diff looks perfect and is silently a fragment.
 *   3. `canvas/inspector.tsx#timelineItems` — the `entry.kind === "diff"` branch
 *      made unreachable, so a diff entry falls through to `describeActivity` and
 *      prints `writing bundle.ts` with no patch. 5 of 6 RED. This is the one
 *      that proves the component is MOUNTED rather than merely correct.
 *      The sixth — the carve-out sentence — stayed green ON PURPOSE and is not
 *      a gap: that note is rendered for an agent that ran `Bash` whether or not
 *      it has a single drawable patch, which is the case it exists for.
 *   4. `canvas/inspector.tsx` — `bashCalls` pinned to `null`, i.e. the note kept
 *      but its measured count dropped. 1 of 6 RED, and only the carve-out test.
 *      That is mutation 3's complement: between them every test in this file has
 *      a mutation that reddens it.
 *   5. `run/diff.tsx` — `overflow-auto` removed from the scroller AND
 *      `overflow-hidden` from the card, so the patch spills over the panel.
 *      1 of 6 RED: the scroller stopped having a scroll range at all (`0`).
 *      THE SAME MUTATION IS HOW THREE OTHER FORMS OF THAT TEST WERE DISQUALIFIED
 *      — two that stayed green against a spilling patch, and one that went red
 *      against a NEIGHBOUR'S layout in both builds, which is the more dangerous
 *      of the two failures because it looks like a working control. All three
 *      were removed rather than kept; the list is at the test itself, because
 *      "we tried to measure the spill and could not" is worth more to the next
 *      reader than a green line that means nothing.
 *
 * A SIXTH MUTATION IS RECORDED AS NOT REDDENING ANYTHING, because a control that
 * fails to control is worth more written down than deleted: removing `min-w-0`
 * from the timeline row in `inspector.tsx` left all six green. The diff's own
 * scroller holds the line without it. The comment there has been corrected to
 * claim a reason rather than an observation.
 */

import { expect, test, type Page } from "@playwright/test";

import type { GraphAttribution, RunEvent, RunGraphResponse } from "../src/lib/api-types";
import { foldGraphAll } from "../src/lib/graph";
import { FINISHED_RUN_ID } from "./fixtures/config";

const EXACT: GraphAttribution = "exact";

/** `rgb(74, 222, 128)` — `--color-pass` from `globals.css`, resolved. */
const PASS_GREEN = "rgb(74, 222, 128)";
/** `rgb(248, 113, 113)` — `--color-fail`. */
const FAIL_RED = "rgb(248, 113, 113)";
/** `rgb(162, 171, 187)` — `--color-ink-dim`, the neutral a context line keeps. */
const CONTEXT_INK = "rgb(162, 171, 187)";

/**
 * A single line longer than the server's per-line budget.
 *
 * 200 characters against `DIFF_MAX_LINES`'s sibling `DIFF_LINE_CHARS` (160), so
 * the fold shortens it, sets `capped` and leaves BOTH dropped counts at zero —
 * the one case the `capped` flag exists for that no line count can express. It
 * is also what the horizontal-scroll assertion needs, so the third capped branch
 * costs nothing extra to cover.
 */
const LONG_LINE = `+  .hero { ${"background:linear-gradient(90deg,#0b0d11,#11141a);".repeat(4)} }`;

/**
 * TWO AGENTS, THREE EDITS, AND ONE OF THEM ON THE OTHER AGENT.
 *
 * The second node is not decoration. One node with one diff cannot distinguish a
 * renderer that draws THAT node's edits from one that pools every edit in the
 * run onto every card, and the pooled version looks perfect until two agents
 * edit at once. So `stylist` owns `globals.css` and nothing else, and both
 * inspectors are asserted in both directions.
 */
const DIFF_EVENTS: readonly RunEvent[] = [
  {
    type: "graph_agent",
    node: "root",
    parent: null,
    agent: null,
    lane: null,
    description: "The session that fielded the ticket.",
    ambient: false,
    attribution: EXACT,
    sdk: null,
  },
  {
    type: "graph_agent",
    node: "builder",
    parent: "root",
    agent: "frontend-developer",
    lane: "build",
    description: "Wire the diff renderer into the inspector.",
    ambient: false,
    attribution: EXACT,
    sdk: null,
  },
  {
    type: "graph_agent",
    node: "stylist",
    parent: "root",
    agent: "ui-designer",
    lane: "design",
    description: "Keep the patch colours inside the run's palette.",
    ambient: false,
    attribution: EXACT,
    sdk: null,
  },

  /*
   * A READ AND TWO SHELL CALLS BEFORE THE FIRST EDIT.
   *
   * The `Bash` calls are what the carve-out sentence counts: an agent that edits
   * through `sed -i` produces no `FileEditOutput` and therefore no card, ever,
   * and a list of diffs with nothing beside it reads as the list of edits. The
   * `Read` is here so the diff has to be placed IN a timeline rather than in a
   * list of its own.
   */
  {
    type: "graph_tool",
    node: "builder",
    name: "Read",
    mcpServer: null,
    summary: "file_path: src/app/page.tsx",
    attribution: EXACT,
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Bash",
    mcpServer: null,
    summary: "command: sed -i '' 's/red/green/' src/styles/tokens.css",
    attribution: EXACT,
  },
  {
    type: "graph_tool",
    node: "builder",
    name: "Bash",
    mcpServer: null,
    summary: "command: npm init -y",
    attribution: EXACT,
  },

  /*
   * THE PLAIN EDIT — one context line, one added, one removed, and NOT capped.
   * Every colour assertion in this file reads this patch, and the absence of a
   * capped notice on it is what stops "the notice is always printed" from
   * passing test 2.
   */
  {
    type: "graph_diff",
    node: "builder",
    path: "src/app/page.tsx",
    tool: "Edit",
    change: "modified",
    additions: 2,
    deletions: 1,
    hunks: [
      {
        oldStart: 11,
        oldLines: 3,
        newStart: 11,
        newLines: 4,
        lines: [
          "   const runId = useRunId();",
          "-  const answer = 41;",
          "+  const answer = 42;",
          "+  const diffs = useDiffs(runId);",
        ],
      },
    ],
    capped: false,
    droppedHunks: 0,
    droppedLines: 0,
    attribution: EXACT,
  },

  /*
   * THE CAPPED EDIT. The emitter withheld 220 lines and 3 whole hunks; the
   * counts (+180 -60) are of the WHOLE patch and the three drawn lines are not.
   * A renderer that prints the counts over three lines with no notice is stating
   * that this is the edit.
   */
  {
    type: "graph_diff",
    node: "builder",
    path: "src/generated/bundle.ts",
    tool: "Write",
    change: "added",
    additions: 180,
    deletions: 60,
    hunks: [
      {
        oldStart: 1,
        oldLines: 240,
        newStart: 1,
        newLines: 360,
        lines: ["+export const TOKENS = {", "+  hero: 1,", "+};"],
      },
    ],
    capped: true,
    droppedHunks: 3,
    droppedLines: 220,
    attribution: EXACT,
  },

  /*
   * THE OTHER AGENT'S EDIT, carrying the over-long line. Its `capped` is FALSE
   * on the wire and TRUE by the time it is drawn: `capDiff` shortens the line
   * and sets the flag itself. That is deliberate — it makes the third notice
   * branch a fact about the fold rather than about this fixture.
   */
  {
    type: "graph_diff",
    node: "stylist",
    path: "src/app/globals.css",
    tool: "Edit",
    change: "modified",
    additions: 1,
    deletions: 0,
    hunks: [{ oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, lines: [LONG_LINE] }],
    capped: false,
    droppedHunks: 0,
    droppedLines: 0,
    attribution: EXACT,
  },
];

const SNAPSHOT: RunGraphResponse = {
  ...foldGraphAll(DIFF_EVENTS),
  atSeq: DIFF_EVENTS.length,
};

/**
 * Serve OUR snapshot for this run's graph, and nothing else.
 *
 * `Access-Control-Allow-Origin` is not optional: the app is on 4322 and the
 * fixture API on 4177, so a fulfilled response without it is rejected by the
 * browser, SWR takes its `snapshot_failed` branch, and the canvas comes up empty
 * — a failure that looks exactly like "the fixture never arrived". The header
 * mirrors `tests/fixtures/api-server.ts`, which sends `*` for the same reason.
 */
async function serveDiffGraph(page: Page): Promise<void> {
  await page.route(`**/api/runs/${FINISHED_RUN_ID}/graph`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(SNAPSHOT),
    });
  });
}

/**
 * Open one agent's inspector, through the roster rather than the canvas.
 *
 * NOT A NODE CLICK. `onNodeClick` is a TOGGLE over React Flow's own hit testing
 * and the cards carry their own buttons; the roster is a plain `<ul>` of plain
 * `<button>`s built for exactly this ("picking one here selects its card on the
 * canvas"), and it reaches the same `DetailSheet`. It also matches the
 * `run detail` → tab idiom every other browser spec in this tree uses.
 */
async function openAgent(page: Page, agent: string): Promise<void> {
  await page.goto(`/runs/${FINISHED_RUN_ID}`);
  await expect(page.getByTestId("rf__node-root")).toBeVisible();
  await page.getByRole("button", { name: "run detail" }).click();
  await page.getByRole("tab", { name: "Agents" }).click();
  /*
   * SCOPED TO THE TAB PANEL, because the canvas card behind it is ALSO a
   * `role="button"` named after the same agent (`agent-shell-<id>`, with an
   * `aria-label` for the keyboard walk). An unscoped `getByRole` resolves to
   * both and Playwright refuses it — correctly, since clicking either would have
   * opened the sheet and only one of them is the deterministic path this helper
   * claims to use.
   */
  await page
    .locator("#run-panel-agents")
    .getByRole("button", { name: new RegExp(agent) })
    .click();
}

test.beforeEach(async ({ page }) => {
  await serveDiffGraph(page);
});

test.describe("an applied edit, drawn on a run that has already finished", () => {
  test("green lines are the added ones and red lines are the removed ones", async ({
    page,
  }) => {
    await openAgent(page, "frontend-developer");

    const patch = page.locator('[data-diff-path="src/app/page.tsx"]');
    await expect(patch).toBeVisible();

    /*
     * THE PREFIXES ARE PART OF THE TEXT, and asserting them here is not
     * decoration. Colour is the second signal; the `+`/`-` glyph is the first,
     * and it is the only one a reader with a red-green deficiency — or anyone
     * copying the block into a terminal — has. A renderer that strips the
     * prefix and keeps the colour fails on these two lines.
     */
    const added = patch.locator('[data-diff-line="added"]');
    const removed = patch.locator('[data-diff-line="removed"]');
    const context = patch.locator('[data-diff-line="context"]');

    await expect(added).toHaveCount(2);
    await expect(removed).toHaveCount(1);
    await expect(context).toHaveCount(1);

    await expect(added.first()).toHaveText("+  const answer = 42;");
    await expect(removed).toHaveText("-  const answer = 41;");

    /*
     * THE MEASUREMENT. Text and structure survive a swap of the two classes
     * untouched; the resolved colour does not. `--color-pass` and `--color-fail`
     * are CSS custom properties, so this is also the check that could not have
     * been written under jsdom — see `playwright.config.ts`'s header.
     */
    await expect(added.first()).toHaveCSS("color", PASS_GREEN);
    await expect(added.nth(1)).toHaveCSS("color", PASS_GREEN);
    await expect(removed).toHaveCSS("color", FAIL_RED);
    await expect(
      context,
      "an unchanged line was coloured — the diff is claiming a change the patch does not contain",
    ).toHaveCSS("color", CONTEXT_INK);

    // The counts, in the same two glyphs, from `additions`/`deletions` — NOT
    // from the fold's clipped one-line `detail`.
    await expect(patch.getByTestId("diff-additions")).toHaveText("+2");
    await expect(patch.getByTestId("diff-deletions")).toHaveText("-1");
    await expect(patch.getByTestId("diff-additions")).toHaveCSS("color", PASS_GREEN);
    await expect(patch.getByTestId("diff-deletions")).toHaveCSS("color", FAIL_RED);

    // And this patch is WHOLE, so it must carry no capped notice. Without this,
    // a component that printed the notice unconditionally would pass the next
    // test for the wrong reason.
    await expect(patch.getByTestId("diff-capped")).toHaveCount(0);
  });

  test("a capped patch says so, in numbers", async ({ page }) => {
    await openAgent(page, "frontend-developer");

    const capped = page.locator('[data-diff-path="src/generated/bundle.ts"]');
    await expect(capped).toBeVisible();

    // The counts are of the WHOLE patch and stay exact...
    await expect(capped.getByTestId("diff-additions")).toHaveText("+180");
    await expect(capped.getByTestId("diff-deletions")).toHaveText("-60");
    // ...and three lines are drawn under them.
    await expect(capped.locator("[data-diff-line]")).toHaveCount(3);

    /*
     * SO THE PANEL HAS TO RECONCILE THEM, IN NUMBERS. "3 of 223" is arithmetic
     * over what actually arrived (`droppedLines` plus the lines in hand), not a
     * copy of a constant, and "3 further hunks" is the other half of the same
     * fact. A vaguer sentence — "truncated" — would satisfy a reader and tell
     * them nothing about how much is missing.
     */
    const notice = capped.getByTestId("diff-capped");
    await expect(notice).toContainText("Showing 3 of 223 lines.");
    await expect(notice).toContainText("3 further hunks are not shown.");
    await expect(notice).toContainText("The counts above are of the whole edit.");
  });

  test("a line cut short is capped too, even though no line is missing", async ({
    page,
  }) => {
    await openAgent(page, "ui-designer");

    const patch = page.locator('[data-diff-path="src/app/globals.css"]');
    await expect(patch).toBeVisible();

    /*
     * THE CASE `capped` EXISTS FOR. This event arrived with `capped: false` and
     * both dropped counts at zero; the fold shortened its 200-character line to
     * 160 and set the flag. Every line the patch had is on screen, so a notice
     * derived from `droppedLines > 0` would be silent here while half the line
     * is gone.
     */
    const line = patch.locator('[data-diff-line="added"]');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveCSS("color", PASS_GREEN);
    const text = (await line.innerText()).trim();
    expect(
      text.length,
      "the over-long line was not cut by the fold — this test is no longer measuring the shortening branch",
    ).toBe(160);

    const notice = patch.getByTestId("diff-capped");
    await expect(notice).toContainText("A line was too long and is shown cut short.");
    await expect(notice).not.toContainText("Showing");
  });

  test("each agent's edits are on that agent's card, and only there", async ({ page }) => {
    /*
     * ONE NODE WITH ONE DIFF CANNOT SEE A RENDERER THAT POOLS EVERY EDIT IN THE
     * RUN ONTO EVERY CARD — it looks perfect until two agents edit at once, and
     * then it is wrong on both. Both directions are asserted.
     */
    await openAgent(page, "frontend-developer");
    await expect(page.locator('[data-diff-path="src/app/page.tsx"]')).toBeVisible();
    await expect(
      page.locator('[data-diff-path="src/app/globals.css"]'),
      "the ui-designer's edit is showing on the frontend-developer's card",
    ).toHaveCount(0);

    await openAgent(page, "ui-designer");
    await expect(page.locator('[data-diff-path="src/app/globals.css"]')).toBeVisible();
    await expect(page.locator('[data-diff-path="src/app/page.tsx"]')).toHaveCount(0);
  });

  test("the edits it can never draw are accounted for beside the ones it can", async ({
    page,
  }) => {
    await openAgent(page, "frontend-developer");

    /*
     * THE PERMANENT CARVE-OUT. `sed -i` and `npm init` changed files on this
     * agent and produce no `FileEditOutput`, so no card above can ever exist for
     * them. Two diffs with nothing beside them read as "these are the edits",
     * which is the same class of untruth as drawing a capped patch whole.
     */
    const note = page.getByTestId("diff-shell-note");
    await expect(note).toContainText("Only edits made with the file tools leave a patch.");
    await expect(
      note,
      "the count comes from this agent's own recorded Bash calls, not from a fixed sentence",
    ).toContainText("This agent also ran Bash 2 times");
  });

  test("a 160-character patch line scrolls inside its own box, not the page", async ({
    page,
  }) => {
    await openAgent(page, "ui-designer");
    await expect(page.locator('[data-diff-path="src/app/globals.css"]')).toBeVisible();

    /*
     * `whitespace-pre` IS THE RIGHT CHOICE AND IT HAS A COST, so the cost is
     * measured. THE FIRST VERSION OF THIS TEST MEASURED THE WRONG THING and is
     * recorded rather than quietly replaced: it compared the DOCUMENT's
     * `scrollWidth` to its `clientWidth`, which cannot fail here. The sheet is
     * `absolute` inside a canvas wrapper that is `relative h-full
     * overflow-hidden`, so the document's scroll width is unmoved whatever
     * happens in the panel — that assertion stayed green with `min-w-0` deleted
     * AND with the diff's `overflow-auto` and the card's `overflow-hidden` both
     * removed, i.e. against a patch spilling straight over the panel. A check
     * that could only observe success is this repository's signature defect, so
     * it was replaced rather than kept for comfort.
     */
    const scroller = page
      .locator('[data-diff-path="src/app/globals.css"]')
      .getByTestId("diff-scroller");

    /*
     * IT SCROLLS — asked of the element by MOVING it, which is the only form of
     * this question that distinguishes a real scroll container from a box whose
     * content merely overflows. `scrollWidth` does NOT: it reports the content's
     * extent for an `overflow: visible` box too, so it stays greater than
     * `clientWidth` on a patch that is spilling over the panel. Setting
     * `scrollLeft` on a non-scrollable element leaves it at 0.
     */
    const scrolledTo = await scroller.evaluate((node) => {
      node.scrollLeft = 10_000;
      const moved = node.scrollLeft;
      node.scrollLeft = 0;
      return moved;
    });
    expect(
      scrolledTo,
      "the diff did not scroll horizontally — either the 160-character line wrapped, or it is overflowing something that is not a scroller",
    ).toBeGreaterThan(0);

    /*
     * AND THE OTHER HALF OF THE CLAIM — "nothing escapes the box" — IS NOT
     * ASSERTED, BECAUSE THREE FORMS OF IT WERE TRIED AND NONE COULD FAIL.
     * Written down rather than deleted: a check that can only observe success is
     * this repository's signature defect, and three of them were written here in
     * one sitting before the mutation caught them out. All three stayed GREEN
     * with the diff's `overflow-auto` and the card's `overflow-hidden` both
     * removed, i.e. against a patch actually spilling:
     *
     *   · `document.documentElement.scrollWidth` — the sheet is `absolute` inside
     *     a canvas wrapper that is `relative h-full overflow-hidden`, so the
     *     document's scroll width cannot move whatever happens in here.
     *   · `elementFromPoint` twenty pixels right of the card — the sheet is
     *     docked to the RIGHT EDGE of the viewport, so that point is off-screen
     *     and the call returns `null` regardless of what is painted.
     *   · walking every ancestor for `scrollWidth > clientWidth` — and THIS ONE
     *     did go red under the mutation, which is why it survived two rounds
     *     before being caught. It named `DIV.relative h-full overflow-hidden
     *     border-y`: React Flow's own canvas wrapper, whose transformed viewport
     *     legitimately has a scroll range and has nothing to do with this patch.
     *     It named the same element in the CORRECT build too, so its red and its
     *     green were both measuring a neighbour. The sheet's own scroll container
     *     reported no horizontal range in either build, spilling or not — which
     *     is the fact that makes this whole family of checks unusable here.
     *
     * So the scroll range above is the whole of what is measured here, and it is
     * enough: a line that had escaped would not have left one behind.
     */
  });
});
