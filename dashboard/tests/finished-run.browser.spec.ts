/**
 * WHAT A COMPLETED RUN LOOKS LIKE WHEN YOU OPEN IT COLD — the branch this suite
 * had never once executed.
 *
 * THE HOLE THIS FILLS. `use-run-stream.ts:819-822` derives
 *
 *     const streamClosed = status !== undefined && isTerminalStatus(status);
 *     …
 *     if (runId === null || streamClosed || !graphReady) return;   // no EventSource
 *
 * — correct on its own terms (a finished run must not hold a socket open and
 * reconnect forever), and it means everything the page derives from the live
 * `trace` sink EXISTS ONLY WHILE YOU ARE WATCHING. Open the run afterwards and
 * it is gone. Every fixture in this harness was non-terminal, so no spec here
 * could see that: a feature that rendered live and vanished on replay passed
 * every check in the tree.
 *
 * THE MEASUREMENT IS A MATCHED PAIR, which is the only reason the negative half
 * says anything. `BUILD_RUN_ID` and `FINISHED_RUN_ID` are folded from ONE event
 * list (`fixtures/build-run-fixture.ts`) and differ in status and in one
 * appended terminal row. Both are served the identical `/events` bytes,
 * including a `socket-echo` node that is in NEITHER snapshot. So:
 *
 *   live run     → the echo card is drawn      (the socket opened and was read)
 *   finished run → the echo card never appears (no socket was ever constructed)
 *
 * An absence asserted alone would pass against a page that failed to load. The
 * live twin drawing the same frame is what converts it into a fact.
 *
 * WITH ONE HONEST QUALIFICATION, because measuring it turned up an asymmetry.
 * The echo's PRESENCE on the live twin is decisive. Its ABSENCE on the finished
 * run is only corroborating: the finished run's stream writes the echo after the
 * terminal `status` row, so a socket that opened, ingested that status and tore
 * itself down would miss the echo and satisfy the absence anyway — which is
 * exactly what happened under mutation 2 below. What actually caught a socket
 * being opened on a finished run was the EDGE COUNT in the first test (4 -> 5).
 * Both assertions are kept; only one of them is load-bearing, and it is said so
 * at the assertion rather than left for the next reader to discover.
 *
 * WHAT THESE TESTS ARE GREEN AGAINST TODAY, and why that is the deliverable
 * rather than a weakness. `useRunGraph` fetches `GET /api/runs/:id/graph` on
 * every run, terminal or not, so a canvas folded by `foldGraphAll` already
 * survives replay — and these assertions pass on current main. Their value is
 * that they GO RED when it stops being true. THREE MUTATIONS WERE APPLIED TO
 * PRODUCTION CODE AND WATCHED, on 2026-08-04, then reverted and watched green
 * again — written down because a repository whose signature defect is checks
 * that can only observe success does not get to claim this without the record:
 *
 *   1. `server/src/graph.ts#foldGraphAll` returning
 *      `{...state, nodes: state.nodes.slice(0, -1)}` — one node dropped from the
 *      fold. Three of the four tests failed; the `guard` card was simply not
 *      there. This is what pins the snapshot to the REDUCER: a hand-written
 *      `GraphState` literal in the fixture would have survived it untouched.
 *   2. `FINISHED_SUMMARY.status` flipped from `failed` to `running` in the
 *      fixture. "never opens the event stream" failed — the trace pane filled
 *      with replayed rows instead of printing its finished-run sentence. This is
 *      what pins the fixture to the TERMINAL branch.
 *   3. `use-run-stream.ts` — `streamClosed ||` deleted from the EventSource
 *      effect's guard, i.e. the exact defect this file exists to notice. TWO
 *      tests failed: the trace pane acquired a row, and the canvas acquired a
 *      FIFTH `conduit-core` edge, because the socket-only `socket-echo` node
 *      arrived and was drawn on a finished run.
 *
 * The one thing that does NOT work yet is marked `fixme` at the bottom with the
 * wave that turns it on; it is not weakened into something that passes.
 */

import { expect, test, type Page } from "@playwright/test";

import { BUILD_RUN_ID, FINISHED_RUN_ID } from "./fixtures/config";

/**
 * Wait until the canvas has actually been folded and laid out.
 *
 * NOT A TIMEOUT, AND NOT JUST THE ROOT CARD. React Flow mounts, measures and
 * fits across a couple of frames; `root` is drawn before the children are
 * placed. `probe` is the deepest node in the fixture — root → builder → probe —
 * so its card existing means the whole fold reached the renderer, which is the
 * precondition every assertion below depends on.
 */
async function openCanvas(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId("rf__node-root")).toBeVisible();
  await expect(page.getByTestId("rf__node-probe")).toBeVisible();
}

test.describe("a finished run, opened cold", () => {
  test("draws the whole delegation graph out of the REST snapshot", async ({ page }) => {
    await openCanvas(page, FINISHED_RUN_ID);

    /*
     * EVERY NODE, INCLUDING THE GRANDCHILD. `probe`'s parent is `builder`, not
     * `root`; a regression that pinned every node to the root would still draw
     * five cards, so the depth is checked by the edge count below rather than
     * by the presence of the card alone.
     */
    for (const node of ["root", "builder", "probe", "api", "reviewer", "guard"]) {
      await expect(
        page.getByTestId(`rf__node-${node}`),
        `the ${node} card is missing — the snapshot did not reach the canvas`,
      ).toBeVisible();
    }

    /*
     * FIVE PARENT→CHILD EDGES, SPLIT FOUR AND ONE, and the split is the point.
     *
     * root→builder, root→api, root→reviewer and builder→probe are `exact` and
     * draw the full connector, whose settled stroke is `conduit-core`
     * (`run-layout.browser.spec.ts` records the rename from `edge-*`).
     * root→guard is `inferred`, and `flow-edge.tsx:143-149` gives a guess NO
     * casing, no bloom and no core — it draws `conduit-guess` instead, because
     * "an inferred edge must not be dressed as a fact" is a claim the canvas
     * makes and this is where it is kept on a REPLAYED graph. Asserting a flat
     * total of 5 would have passed just as well against a canvas that had
     * forgotten the attribution.
     */
    await expect(page.locator("path.conduit-core")).toHaveCount(4);
    await expect(
      page.locator("path.conduit-guess"),
      "the inferred edge to `guard` lost its attribution somewhere between the snapshot and the canvas",
    ).toHaveCount(1);

    /*
     * THE TOOL COUNTS, which are arithmetic the fold did and nothing else could
     * have. `builder` called `Edit` on three files; `root` called `Read` twice
     * and `Task` three times. A snapshot that arrived but was not folded — or
     * was folded twice — reads different numbers here while every card above
     * still exists.
     */
    await expect(
      page.getByTestId("rf__node-builder").getByTitle("Edit, called 3×"),
    ).toBeVisible();
    await expect(
      page.getByTestId("rf__node-root").getByTitle("Read, called 2×"),
    ).toBeVisible();
    await expect(
      page.getByTestId("rf__node-root").getByTitle("Task, called 3×"),
    ).toBeVisible();
  });

  test("resolves the agents that were still in flight — a fold only a replay can do", async ({
    page,
  }) => {
    await openCanvas(page, FINISHED_RUN_ID);

    /*
     * THE SHARPEST ASSERTION IN THIS FILE.
     *
     * `api` and `guard` carry no `graph_result` and no closing status, so
     * `foldGraph` leaves them at the `running` its `graph_agent` arm seeds
     * (`server/src/graph.ts:233`). The trailing terminal `status` row rewrites
     * exactly those two to `unresolved` (`server/src/graph.ts:367-383`).
     *
     * Nothing but the fold produces that word. It is not in any event, it is
     * not a CSS state, and the live twin — same nodes, same events, no terminal
     * row — reads `running` on both cards. So a page rendering these from
     * anywhere other than the folded snapshot cannot say `unresolved` here.
     */
    await expect(
      page.getByTestId("rf__node-api"),
      "`api` was still running when the run ended and should read `unresolved`",
    ).toContainText("unresolved");
    await expect(page.getByTestId("rf__node-guard")).toContainText("unresolved");

    // And the settled ones are untouched by that arm: it only rewrites nodes
    // whose state IS `running`, so a blanket rewrite would show up here.
    await expect(page.getByTestId("rf__node-reviewer")).toContainText("completed");
    await expect(page.getByTestId("rf__node-builder")).toContainText("completed");
    await expect(page.getByTestId("rf__node-probe")).toContainText("completed");
  });

  test("never opens the event stream, and says so where the trace would be", async ({
    page,
  }) => {
    await openCanvas(page, FINISHED_RUN_ID);

    await page.getByRole("button", { name: "run detail" }).click();
    await page.getByRole("tab", { name: "Trace" }).click();
    const trace = page.locator("#run-panel-trace");

    /*
     * A PRECONDITION, NOT THE MEASUREMENT — and this comment used to claim the
     * opposite, which is worth writing down rather than quietly correcting.
     *
     * It called this badge "the deterministic anchor … the terminal branch being
     * taken". It is not. `stream` is `streamClosed ? "closed" : socket` and
     * `streamClosed` is derived from `status` ALONE, so the badge reports what
     * the detail route said and knows nothing about whether the effect ran.
     * MEASURED: it kept reading `closed` under all three mutations recorded in
     * this file's header — including the one that deleted the effect's guard and
     * demonstrably opened a socket, whose replayed rows were visible in the same
     * pane beside the word `closed`.
     *
     * So it earns exactly one sentence: the detail route answered and reported a
     * terminal status, which is what the rest of this test needs to be true
     * before it can mean anything. It says nothing about the socket.
     */
    await expect(trace.getByText("closed", { exact: true })).toBeVisible();

    /*
     * THIS IS THE MEASUREMENT. The empty-trace sentence needs BOTH
     * `stream === "closed"` AND a trace that never received a single row — the
     * second half is the part no status field can fake, because one delivered
     * frame of any kind replaces this sentence with a list. It went red under
     * mutation 2 and mutation 3.
     */
    await expect(trace).toContainText(
      "This run finished before the page was opened, so there is no live trace to replay.",
    );

    /*
     * AND THE ECHO, WHICH IS CORROBORATION RATHER THAN PROOF — stated plainly,
     * because the header calls the echo's presence on the live twin decisive and
     * the same claim does NOT transfer to its absence here.
     *
     * The finished run's stream writes the echo AFTER the terminal `status` row.
     * Under mutation 2 the socket opened, ingested that status, and tore itself
     * down before the echo landed — so this assertion PASSED while the run was
     * streaming. It is kept because it is free and because the failure it does
     * catch is real, but the thing that caught the guard deletion was the edge
     * count in the first test of this file (4 -> 5, the echo's own connector),
     * and that is where the load is.
     */
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("rf__node-socket-echo"),
      "a socket-only row reached the canvas — the finished run opened an EventSource",
    ).toHaveCount(0);
  });
});

test.describe("the live twin — the same events under a running status", () => {
  test("opens the stream and folds a row the snapshot never carried", async ({ page }) => {
    await openCanvas(page, BUILD_RUN_ID);

    /*
     * THE POSITIVE CONTROL FOR THE TEST ABOVE. Identical bytes on an identical
     * route; the only difference is `status: "running"`. If this card failed to
     * appear, the finished run's `toHaveCount(0)` would be measuring a broken
     * fixture rather than a closed socket, and it would pass for the wrong
     * reason forever.
     */
    await expect(
      page.getByTestId("rf__node-socket-echo"),
      "the socket-only row never arrived — the fixture's stream is not delivering, so the finished-run absence proves nothing",
    ).toBeVisible();

    // And the same two cards the finished run reads as `unresolved` read
    // `running` here, because no terminal row was ever folded.
    await expect(page.getByTestId("rf__node-api")).toContainText("running");
    await expect(page.getByTestId("rf__node-guard")).toContainText("running");
  });
});

/*
 * NOT YET TRUE, AND DELIBERATELY NOT WEAKENED INTO SOMETHING THAT PASSES.
 *
 * Ask D in the findings: the pre-build stages should stay on the canvas next to
 * the agent graph instead of disappearing at the build boundary. THREE verified
 * reasons this cannot pass today, and all three have to go — a wave that fixes
 * two of them will watch this stay red and conclude the fixme was wrong:
 *
 *   1. `src/lib/spec-pipeline.ts:246` — `if (phase !== "spec") return [];`. The
 *      lane deletes itself the moment the run leaves the spec phase, so a run
 *      in `build` or `gate` has no stages at all.
 *   2. `specPipelineFrom` reads `trace`, and `trace` is the LIVE sink. On this
 *      run id the socket is never opened, so even inside the spec phase the
 *      array would be empty on a reload. This is the one THIS FILE exists for.
 *   3. `canvas/orchestration-canvas.tsx:1846` — "Before the build" is inside the
 *      `showEmptyOverlay || !ready` branch, i.e. it is an OVERLAY drawn only
 *      while the canvas has zero nodes. This run has six. So even with (1) and
 *      (2) repaired, the stages have nowhere to appear until the overlay stops
 *      being an overlay; the findings call that out as ask D's actual layout
 *      work rather than as a side effect of the data fix.
 *
 * Enabled by the wave that moves the pre-build lane onto `GraphState` via
 * `foldGraph` and re-lays the canvas — sequencing steps 2 and 6 of the findings
 * doc, together.
 */
test.fixme(
  "a finished run still shows the stages that ran before the build",
  async ({ page }) => {
    await openCanvas(page, FINISHED_RUN_ID);
    await expect(page.getByText("Before the build")).toBeVisible();
  },
);
