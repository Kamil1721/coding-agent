/**
 * A RUN THAT OUTGROWS ITS OWN FRAME, AND THE PAN THAT MUST STOP IT BEING
 * RE-FRAMED.
 *
 * WHAT WAS MEASURED. `orchestration-canvas.tsx` fits the graph exactly once, and
 * that is deliberate: a re-fit that ignored the reader would fight a drag, and
 * the file's contract is that a dragged card keeps its position forever. But a
 * live run keeps SPAWNING. Probed on the harness's live run, 2 of 12 nodes sat
 * entirely outside the pane at t=1.5s and were still outside at t=7.5s with the
 * viewport transform byte-identical — the run grew past its frame and nothing
 * looked again. A new node is not a drag.
 *
 * HOW THE GROWTH IS STAGED, because the fixture normally lands its whole graph
 * before the first paint and there would be nothing to observe. Two routes:
 *
 *   1. `/graph` is truncated to the ROOT NODE ALONE, with `atSeq: 0`. The
 *      snapshot's watermark is what `useRunGraph` dedups the replay against, so
 *      zeroing it is what lets the stream re-deliver every row. Re-delivering
 *      `root` is safe by the reducer's own rule — `graph.ts:785`, "a repeat of a
 *      node id is IGNORED rather than merged".
 *   2. `/events` is held for three seconds. The socket does not open until the
 *      snapshot has settled anyway, so this simply widens the window between
 *      "the canvas has fitted one card" and "eleven more arrive" into one a test
 *      can act inside.
 *
 * THE PAIR VARIES EXACTLY ONE THING: whether the pane is dragged during that
 * window. Same fixture, same two routes, same delay, same assertions. The first
 * test says the graph is re-framed; the second says it is not, because the
 * viewport stopped being the canvas's to choose the moment the reader moved it.
 * Either one alone would be satisfied by a canvas that never re-fits at all, or
 * by one that re-fits over the top of anybody.
 */

import { expect, test, type Page } from "@playwright/test";

import { API_ORIGIN, BUILD_RUN_ID } from "./fixtures/config";

/** Long enough to drag inside, short enough to stay well under the timeout. */
const EVENTS_HELD_MS = 3_000;

/**
 * Serve a one-node snapshot and hold the stream back.
 *
 * The snapshot is derived from the REAL one rather than written out here: a
 * hand-built `RunGraphResponse` is a second source of truth for a shape the
 * server owns, and this file would keep passing after that shape changed.
 */
async function stageGrowth(page: Page): Promise<void> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${BUILD_RUN_ID}/graph`);
  const graph = (await seed.json()) as Record<string, unknown>;
  const nodes = graph["nodes"];
  expect(Array.isArray(nodes), "the graph fixture has no nodes array").toBe(true);
  const all = nodes as unknown[];
  expect(all.length, "the graph fixture is too small to grow").toBeGreaterThan(3);

  const truncated = JSON.stringify({
    ...graph,
    nodes: all.slice(0, 1),
    edges: [],
    stages: [],
    atSeq: 0,
  });

  await page.route(
    (url) => url.pathname === `/api/runs/${BUILD_RUN_ID}/graph`,
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: truncated,
      });
    },
  );

  await page.route(
    (url) => url.pathname === `/api/runs/${BUILD_RUN_ID}/events`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, EVENTS_HELD_MS));
      await route.continue();
    },
  );
}

/** The viewport's own scale, off the matrix the browser is painting through. */
async function zoomOf(page: Page): Promise<number> {
  return page.evaluate((): number => {
    const viewport = document.querySelector(".react-flow__viewport");
    if (viewport === null) throw new Error("no react-flow viewport");
    const matrix = getComputedStyle(viewport).transform;
    return Number.parseFloat(matrix.replace("matrix(", "").split(",")[0] ?? "NaN");
  });
}

/** How many drawn cards sit entirely outside the pane. */
async function offscreenCount(page: Page): Promise<number> {
  return page.evaluate((): number => {
    const pane = document.querySelector(".react-flow");
    if (pane === null) throw new Error("no react-flow pane");
    const box = pane.getBoundingClientRect();
    let outside = 0;
    for (const node of document.querySelectorAll(".react-flow__node")) {
      const rect = node.getBoundingClientRect();
      const clear =
        rect.right < box.left ||
        rect.left > box.right ||
        rect.bottom < box.top ||
        rect.top > box.bottom;
      if (clear) outside += 1;
    }
    return outside;
  });
}

async function nodeCount(page: Page): Promise<number> {
  return page.locator(".react-flow__node").count();
}

/**
 * Navigate, and wait for the small canvas the truncated snapshot produces.
 *
 * IT IS NOT ASSERTED TO BE EXACTLY ONE CARD. Measured: the truncated snapshot
 * draws TWO — the root agent and the canvas's own preview/lane placement around
 * it — and pinning 1 made this helper fail on a fixture that was behaving. What
 * matters is only that the pre-growth canvas is much smaller than the grown one,
 * which the returned count is asserted against below.
 */
async function openTruncated(page: Page): Promise<number> {
  await page.goto(`/runs/${BUILD_RUN_ID}`);
  await expect.poll(async () => nodeCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
  // The fit runs a frame or two after React Flow has measured those cards.
  await expect.poll(async () => zoomOf(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  const drawn = await nodeCount(page);
  expect(drawn, "the snapshot was not truncated — there is no growth to observe").toBeLessThan(
    4,
  );
  return drawn;
}

/** Drag the empty pane — a pan, which is the reader taking the viewport. */
async function panPane(page: Page): Promise<void> {
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (box === null) throw new Error("the pane has no box");
  // The bottom-right quarter: the one-node canvas puts its single card in the
  // middle, so this is empty ground and the drag cannot become a node drag.
  const x = box.x + box.width * 0.8;
  const y = box.y + box.height * 0.8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 140, y - 90, { steps: 10 });
  await page.mouse.up();
}

test.describe("a growing run is re-framed, unless the reader has taken the view", () => {
  test("nodes that arrive after the fit are brought into the pane", async ({ page }) => {
    await stageGrowth(page);
    const drawnBefore = await openTruncated(page);

    const before = await zoomOf(page);

    // The held stream lands and the graph grows from one card to the whole run.
    await expect
      .poll(async () => nodeCount(page), { timeout: 15_000 })
      .toBeGreaterThan(3);
    // Past the 400ms debounce and the 320ms ease.
    await page.waitForTimeout(1_500);

    const after = await zoomOf(page);

    /*
     * THE GRAPH GOT BIGGER, SO THE FRAME GOT WIDER. A fit-once canvas leaves
     * this byte-identical, which is exactly what the probe measured.
     */
    expect(after, `zoom did not move: ${before} -> ${after}`).toBeLessThan(before);

    // And the point of moving it: everything that arrived is on screen.
    expect(await offscreenCount(page), "cards arrived outside the pane and stayed there").toBe(
      0,
    );
    expect(
      await nodeCount(page),
      "the graph never actually grew",
    ).toBeGreaterThan(drawnBefore);
  });

  test("a pan during the same window keeps the viewport the reader chose", async ({
    page,
  }) => {
    await stageGrowth(page);
    const drawnBefore = await openTruncated(page);

    await panPane(page);
    const chosen = await zoomOf(page);

    await expect
      .poll(async () => nodeCount(page), { timeout: 15_000 })
      .toBeGreaterThan(3);
    await page.waitForTimeout(1_500);

    /*
     * BYTE-IDENTICAL, and that is the assertion. A pan is the reader saying
     * which part of the graph they are looking at; a canvas that re-frames over
     * the top of it is worse than one that never re-frames, because the thing
     * being thrown away was chosen.
     *
     * ZOOM RATHER THAN THE WHOLE MATRIX: this drag is a translation, so the
     * scale is the component `fitView` would change and the translation is the
     * one the pan already changed. Comparing the full transform would be
     * comparing the pan against itself.
     */
    expect(await zoomOf(page), "the re-fit fought the reader's pan").toBe(chosen);

    // The control for THIS test: the graph really did grow while the viewport
    // was left alone, so the equality above is a refusal and not a no-op.
    expect(
      await nodeCount(page),
      "the graph never grew, so nothing was refused",
    ).toBeGreaterThan(drawnBefore);
  });
});
