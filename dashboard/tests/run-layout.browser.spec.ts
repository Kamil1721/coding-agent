/**
 * The run view fills the window, and nothing on it is cut off.
 *
 * WHAT THIS FILE USED TO BE, because the replacement is the point. It measured a
 * three-column orchestration grid — `[264px minmax(0,1fr) 324px]`, a ticket rail
 * beside the canvas, an inspector column flanking it — and it asserted, at two
 * widths, which grid track the canvas landed in. That layout was deleted when the
 * canvas became the whole page. The file was not deleted with it, so all three of
 * its tests failed in the shared `orchestrationRow()` helper on
 *
 *     locator('section:has(.react-flow)')  Expected: 1  Received: 0
 *
 * — the canvas root is a `<div>` now. HANDOVER.md recorded this file as "still
 * asserts *the rail sits beside it* and STILL PASSES". It did not pass. A dead
 * spec that fails loudly is recoverable; the danger was the belief that something
 * here was still being checked.
 *
 * THE BUG THE NEW VERSION EXISTS FOR, which nothing caught. `AppShell` capped
 * `main` at `max-w-[1440px] mx-auto` for every route. The run page tried to escape
 * with `-mx-4 -mt-4`, which cancels 16px of PADDING and cannot touch a parent's
 * `max-width`. So on a 2000px window the "fullscreen canvas" was 1440px wide with
 * 280px of dead gutter down each side, and the graph was squeezed to `scale(0.63)`
 * to fit a pane 560px narrower than the window it was in.
 *
 * Every screenshot of this app was taken at 1440px — the exact width where the cap
 * is invisible because the window IS the cap. Same lesson as the file this
 * replaces, one layer out: the defect was not subtle, it was never measured at a
 * width where it existed. So the wide case here is 2000px, and 1440px is kept as
 * the control that CANNOT catch it.
 *
 * AND THE SCROLLBAR ASSERTION, which is a debt being paid. `globals.css` and the
 * run page both claimed `--run-chrome` was "defended rather than trusted" by
 * `run-canvas.browser.spec.ts` going red if the page ever acquired a scrollbar.
 * That file never existed. The subtraction is gone now (the shell flex-fills), and
 * the assertion it claimed lives here for real.
 */

import { expect, test, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

interface Frame {
  readonly windowWidth: number;
  readonly mainWidth: number;
  readonly gutterLeft: number;
  readonly gutterRight: number;
  readonly flowWidth: number;
  readonly scale: number;
  readonly clippedNodes: readonly string[];
  readonly nodeCount: number;
  readonly vScrollbar: boolean;
  readonly hScrollbar: boolean;
  readonly footerFullyVisible: boolean;
}

/**
 * Everything measured in one page-side pass, after the graph has settled.
 *
 * Waits on a drawn edge rather than a timeout: React Flow measures its nodes and
 * fits across a couple of frames, and a fit read mid-flight reports the pre-fit
 * transform and passes for the wrong reason.
 */
async function frameOf(page: Page): Promise<Frame> {
  await page.goto(`/runs/${RUN_ID}`);
  await expect(page.locator(".react-flow")).toHaveCount(1);

  /*
   * WAIT ON THE NODES AND A DRAWN CONNECTOR, not on a timeout.
   *
   * `path.conduit-core` is the settled connector stroke. The obvious wait —
   * `path.edge-core--flowing`, which `canvas-edges.browser.spec.ts` still uses —
   * MATCHES NOTHING: the redesign renamed the whole edge vocabulary to
   * `conduit-*` (`conduit-rim`, `conduit-casing`, `conduit-core`, `conduit-comet`)
   * and that spec's six failures are this same rename, not a real defect.
   */
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.locator("path.conduit-core").first()).toBeAttached();
  // The fit lands a frame or two after the edges do.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const pane = document.querySelector<HTMLElement>(".react-flow__viewport");
          return pane?.style.transform ?? "";
        }),
      { message: "the viewport transform never settled" },
    )
    .not.toBe("");

  return page.evaluate((): Frame => {
    const main = document.querySelector("main");
    const flow = document.querySelector(".react-flow");
    const pane = document.querySelector<HTMLElement>(".react-flow__viewport");
    const footer = document.querySelector("footer");
    if (main === null || flow === null || pane === null || footer === null) {
      throw new Error("the run view did not render its shell");
    }

    const mainBox = main.getBoundingClientRect();
    const flowBox = flow.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    const de = document.documentElement;

    const nodes = [...document.querySelectorAll(".react-flow__node")];
    const clipped: string[] = [];
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      // 1px of tolerance: sub-pixel rounding is not clipping.
      if (box.right > flowBox.right + 1 || box.left < flowBox.left - 1) {
        clipped.push(node.getAttribute("data-id") ?? "(unidentified node)");
      }
    }

    const scale = /scale\(([\d.]+)\)/.exec(pane.style.transform)?.[1];

    return {
      windowWidth: window.innerWidth,
      mainWidth: Math.round(mainBox.width),
      gutterLeft: Math.round(mainBox.left),
      gutterRight: Math.round(window.innerWidth - mainBox.right),
      flowWidth: Math.round(flowBox.width),
      scale: scale === undefined ? 0 : Number(scale),
      clippedNodes: clipped,
      nodeCount: nodes.length,
      vScrollbar: de.scrollHeight > de.clientHeight,
      hScrollbar: de.scrollWidth > de.clientWidth,
      footerFullyVisible:
        footerBox.bottom <= window.innerHeight + 1 && footerBox.top >= 0,
    };
  });
}

test.describe("at 2000px — wider than the cap that used to bind", () => {
  test.use({ viewport: { width: 2000, height: 1200 } });

  test("the canvas spans the whole window, with no gutter either side", async ({
    page,
  }) => {
    const frame = await frameOf(page);

    // THE ASSERTION THAT WOULD HAVE CAUGHT IT. Before the fix these were 280
    // and 280, and `mainWidth` was 1440 in a 2000px window.
    expect(
      frame.gutterLeft,
      "dead space on the left — `main` is still capped and centred on this route",
    ).toBe(0);
    expect(
      frame.gutterRight,
      "dead space on the right — `main` is still capped and centred on this route",
    ).toBe(0);
    expect(frame.mainWidth).toBe(frame.windowWidth);
    expect(
      frame.flowWidth,
      "the flow pane is narrower than the window it is supposed to fill",
    ).toBe(frame.windowWidth);
  });

  test("the extra width is spent on the graph, not left empty", async ({ page }) => {
    const frame = await frameOf(page);

    /*
     * A pane can be full width and still show a graph fitted for a narrower one:
     * the fit runs once on mount, so a pane that grows after that keeps its old
     * transform and the graph sits bunched in a corner. That is the same complaint
     * as the gutters in different clothes, so it gets its own assertion.
     *
     * At 1440px the fit produced `scale(0.63)`. Anything at or below that here
     * means the 560px this fix recovered went nowhere.
     */
    expect(
      frame.scale,
      "the graph is still fitted for a ~1440px pane — the pane grew and the fit did not follow",
    ).toBeGreaterThan(0.7);
  });

  test("no node is cut off, and the page does not scroll in either axis", async ({
    page,
  }) => {
    const frame = await frameOf(page);

    expect(frame.nodeCount, "no nodes were drawn, so nothing was measured").toBeGreaterThan(
      0,
    );
    expect(
      frame.clippedNodes,
      "these cards extend past the pane and are cut off",
    ).toEqual([]);

    // The debt from `--run-chrome`: this is the assertion its comment promised.
    expect(frame.vScrollbar, "the run view acquired a vertical scrollbar").toBe(false);
    expect(frame.hScrollbar, "the run view acquired a horizontal scrollbar").toBe(false);
    expect(frame.footerFullyVisible, "the footer was pushed off-screen").toBe(true);
  });
});

test.describe("at 1440px — the control, where the old cap was invisible", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /*
   * KEPT DELIBERATELY, and it cannot catch the gutter bug: at exactly 1440px a
   * `max-w-[1440px]` cap and no cap produce the identical box. It is the record of
   * why one viewport width was not enough — and it still earns its place, because
   * the clipping and scrollbar checks below are real at any width.
   */
  test("still full width, nothing clipped, no scrollbars", async ({ page }) => {
    const frame = await frameOf(page);

    expect(frame.gutterLeft).toBe(0);
    expect(frame.gutterRight).toBe(0);
    expect(frame.clippedNodes).toEqual([]);
    expect(frame.vScrollbar).toBe(false);
    expect(frame.hScrollbar).toBe(false);
    expect(frame.footerFullyVisible).toBe(true);
  });
});

test.describe("the list route keeps the cap", () => {
  test.use({ viewport: { width: 2000, height: 1200 } });

  /*
   * THE OTHER HALF OF THE FIX, and the one a careless change breaks. The escape is
   * scoped to `/runs/<id>`; deleting the cap outright would also have handed the
   * new-ticket form and this list the full 2000px, which is worse than the bug —
   * a 2000px-wide textarea. `isFullBleed` takes exactly one path segment after
   * `/runs`, and this is what holds it to that.
   */
  test("/runs is still capped and centred at 2000px", async ({ page }) => {
    await page.goto("/runs");
    const box = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main === null) throw new Error("no main");
      const b = main.getBoundingClientRect();
      return {
        width: Math.round(b.width),
        left: Math.round(b.left),
        windowWidth: window.innerWidth,
      };
    });

    expect(box.width, "the run LIST lost its max-width — the bleed leaked past /runs/<id>").toBe(
      1440,
    );
    expect(box.left, "the run list is no longer centred").toBeGreaterThan(0);
  });
});
