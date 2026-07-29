/**
 * Which grid track the canvas lands in, at the width where getting it wrong is
 * visible.
 *
 * THE BUG THIS EXISTS FOR. The orchestration row is `[minmax(0,1fr) 324px]` at
 * `lg` and `[264px minmax(0,1fr) 324px]` at `xl`. Grid ORDER decides which track
 * a child takes, and an `lg:order-2` on the canvas put it behind the rail — so
 * between 1024px and 1280px the graph pane was 324px wide and 520px tall while
 * the ticket text got the wide track. EVERY SCREENSHOT OF THIS APP WAS TAKEN AT
 * 1440px, which is `xl`, where the orders reset and the layout is correct. The
 * defect was not subtle; it was simply never measured at a width where it
 * existed.
 *
 * So this file measures at BOTH, and the two cases assert different things
 * because the correct layout is different: at `lg` the canvas leads and the rail
 * follows, at `xl` the rail flanks it. The `xl` case is deliberately kept even
 * though it cannot catch the bug — it is the record of why one width was not
 * enough.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no box — it did not render`);
  return box;
}

interface Row {
  readonly canvas: Box;
  readonly rail: Box;
  readonly inspector: Box;
}

/**
 * The three children of the orchestration grid, found through the canvas
 * itself rather than by a test-only attribute: the `<section>` that contains
 * React Flow, and its two sibling `<div>`s in source order (ticket + roster
 * rail, then inspector column).
 */
async function orchestrationRow(page: Page): Promise<Row> {
  await page.goto(`/runs/${RUN_ID}`);

  const canvas = page.locator("section:has(.react-flow)");
  await expect(canvas).toHaveCount(1);
  // Wait for the graph to be drawn, so the row is measured in its settled state.
  await expect(page.locator("path.edge-core--flowing")).toHaveCount(1);

  const grid = page.locator("div:has(> section:has(.react-flow))");
  await expect(grid).toHaveCount(1);
  const columns = grid.locator("> div");
  await expect(columns).toHaveCount(2);

  return {
    canvas: await boxOf(canvas, "the canvas section"),
    rail: await boxOf(columns.nth(0), "the ticket/roster rail"),
    inspector: await boxOf(columns.nth(1), "the inspector column"),
  };
}

test.describe("at lg — 1100px, the width every screenshot missed", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("the canvas takes the wide track and the rail sits beside it", async ({
    page,
  }) => {
    const { canvas, rail } = await orchestrationRow(page);

    // Two columns, side by side: same row, canvas FIRST.
    expect(Math.abs(canvas.y - rail.y)).toBeLessThan(2);
    expect(
      canvas.x,
      "the canvas is not in the first grid track — an order override has put the rail ahead of it",
    ).toBeLessThan(rail.x);

    // And it is the WIDE one. 324px is the rail's track; anything close to that
    // means the canvas is in it.
    expect(canvas.width).toBeGreaterThan(rail.width);
    expect(
      canvas.width,
      "the canvas collapsed into the narrow rail track",
    ).toBeGreaterThan(600);
    expect(rail.width).toBeLessThan(340);
  });

  test("the inspector wraps underneath rather than squeezing the canvas", async ({
    page,
  }) => {
    const { canvas, inspector } = await orchestrationRow(page);
    expect(inspector.y).toBeGreaterThan(canvas.y + canvas.height - 2);
  });
});

test.describe("at xl — 1440px, where the same bug is invisible", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the rails flank the canvas in source order", async ({ page }) => {
    const { canvas, rail, inspector } = await orchestrationRow(page);

    // Three columns on one row: rail, canvas, inspector.
    expect(Math.abs(canvas.y - rail.y)).toBeLessThan(2);
    expect(Math.abs(canvas.y - inspector.y)).toBeLessThan(2);
    expect(rail.x).toBeLessThan(canvas.x);
    expect(canvas.x).toBeLessThan(inspector.x);

    // The canvas holds the only flexible track.
    expect(canvas.width).toBeGreaterThan(600);
    expect(canvas.width).toBeGreaterThan(rail.width + inspector.width);
  });
});
