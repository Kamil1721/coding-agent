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
 *
 * ─── THE INVARIANT WAS RETIRED AND REPLACED — 2026-08-05 ───
 *
 * `flowWidth === windowWidth` was TRUE when it was written and is FALSE now, and
 * the difference is a feature rather than a regression: the icon rail
 * (`canvas/rail.tsx`) put a 48px column and a 400px panel to the LEFT of the
 * canvas, as flex SIBLINGS of it (`runs/[runId]/page.tsx` — "a push keeps every
 * node visible at a smaller zoom where an overlay would hide the ones he is
 * looking at"). Measured at 2000px: 48 + 400 + 1552. The old assertion failed on
 * exactly 448.
 *
 * DELETING IT WAS NOT AN OPTION. It is the only thing pinning the canvas to a
 * number, and the bug it was written for — a `max-width` on an ancestor that no
 * child can cancel — is silent, survives a redesign, and is invisible at the one
 * width everybody screenshots. So the assertion is now the ARITHMETIC rather than
 * the identity: every pixel between the window's left edge and the canvas's left
 * edge is accounted for by a box that is really there, and the canvas's right edge
 * is the window's. A stray margin, a re-introduced cap, or a panel that reserves
 * width it does not use all break it — which the identity form could not tell
 * apart from the rail existing at all.
 *
 * BOTH PANEL STATES ARE MEASURED, and that is what makes it arithmetic instead of
 * a second constant: with the panel open the canvas is `window - rail - panel`,
 * with it shut `window - rail`, and the difference between the two readings must
 * be the panel's own width. One state alone would pass a canvas frozen at either
 * number.
 *
 * WHETHER THE PANEL COUNTS IS READ OFF THE MECHANISM, NOT OFF THE WIDTH.
 * `rail.tsx:519-521` mounts it `absolute` and promotes it to `static` at
 * `min-[1120px]` — below that it OVERLAYS the canvas and subtracting it would be
 * wrong. So the sum reads `hidden` and the computed `position`, and only a panel
 * that is genuinely in the flex row is subtracted. Both widths measured here are
 * above 1120, so the overlay branch is documented rather than exercised.
 *
 * AND THE FOOTER ASSERTION WAS DELETED FOR CAUSE, which is the more embarrassing
 * half. `footerFullyVisible` read `document.querySelector("footer")` — but the
 * SHELL's footer was removed on 2026-07-30 ("there is no point in this bar at the
 * bottom this is only used by me", `app-shell.tsx`). The first `<footer>` in the
 * document is now the one inside a canvas CARD (`stage-node.tsx:407`), measured
 * here to be `mt-auto flex h-[14px] …`. So the check had been passing since that
 * day by measuring a node's own footer strip, which is always inside the pane it
 * is drawn in — a check that cannot go red. What it was guarding (main growing
 * past the viewport and pushing its last row off-screen) is now asserted directly:
 * `main` ends at the window's bottom edge and the canvas fills it.
 */

import { expect, test, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

interface Frame {
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly mainWidth: number;
  readonly mainBottom: number;
  readonly gutterLeft: number;
  readonly gutterRight: number;
  /** The rail's own box. `left` is asserted, not assumed, so 48 is never hard-coded. */
  readonly railLeft: number;
  readonly railRight: number;
  readonly railWidth: number;
  /** `hidden` is the attribute the rail closes the panel with — see `rail.tsx:513`. */
  readonly panelHidden: boolean;
  readonly panelPosition: string;
  readonly panelLeft: number;
  readonly panelRight: number;
  readonly panelWidth: number;
  readonly flowLeft: number;
  readonly flowRight: number;
  readonly flowWidth: number;
  readonly flowTop: number;
  readonly flowBottom: number;
  readonly scale: number;
  readonly clippedNodes: readonly string[];
  readonly nodeCount: number;
  readonly vScrollbar: boolean;
  readonly hScrollbar: boolean;
}

/**
 * Everything measured in one page-side pass. Callable more than once per page,
 * because the panel is opened and shut under it.
 */
async function measure(page: Page): Promise<Frame> {
  return page.evaluate((): Frame => {
    const main = document.querySelector("main");
    const flow = document.querySelector(".react-flow");
    const pane = document.querySelector<HTMLElement>(".react-flow__viewport");
    const rail = document.querySelector('[data-testid="run-rail"]');
    const panel = document.querySelector<HTMLElement>('[data-testid="rail-panel"]');
    if (main === null || flow === null || pane === null || rail === null || panel === null) {
      throw new Error("the run view did not render its shell");
    }

    const mainBox = main.getBoundingClientRect();
    const flowBox = flow.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
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
      windowHeight: window.innerHeight,
      mainWidth: Math.round(mainBox.width),
      mainBottom: Math.round(mainBox.bottom),
      gutterLeft: Math.round(mainBox.left),
      gutterRight: Math.round(window.innerWidth - mainBox.right),
      railLeft: Math.round(railBox.left),
      railRight: Math.round(railBox.right),
      railWidth: Math.round(railBox.width),
      panelHidden: panel.hidden,
      panelPosition: getComputedStyle(panel).position,
      panelLeft: Math.round(panelBox.left),
      panelRight: Math.round(panelBox.right),
      panelWidth: Math.round(panelBox.width),
      flowLeft: Math.round(flowBox.left),
      flowRight: Math.round(flowBox.right),
      flowWidth: Math.round(flowBox.width),
      flowTop: Math.round(flowBox.top),
      flowBottom: Math.round(flowBox.bottom),
      scale: scale === undefined ? 0 : Number(scale),
      clippedNodes: clipped,
      nodeCount: nodes.length,
      vScrollbar: de.scrollHeight > de.clientHeight,
      hScrollbar: de.scrollWidth > de.clientWidth,
    };
  });
}

/**
 * THE SUM THE CANVAS'S LEFT EDGE MUST EQUAL, derived from the boxes that are
 * really on the page rather than from 48 and 400.
 *
 * The panel counts only when it is in the flex row: `hidden` takes it out of the
 * layout entirely, and below 1120px `rail.tsx` leaves it `absolute`, where it
 * overlays the canvas and the canvas keeps the full remainder.
 */
function chromeRight(frame: Frame): number {
  const panelInRow = !frame.panelHidden && frame.panelPosition === "static";
  return panelInRow ? frame.panelRight : frame.railRight;
}

/**
 * The invariant that replaced `flowWidth === windowWidth`, asserted at every
 * width and in both panel states.
 */
function expectNoGutter(frame: Frame, where: string): void {
  // THE ORIGINAL BUG'S OWN ASSERTIONS, UNCHANGED. `main` is what the 1440px cap
  // was on, and nothing about the rail moved it.
  expect(
    frame.gutterLeft,
    `${where}: dead space on the left — \`main\` is still capped and centred on this route`,
  ).toBe(0);
  expect(
    frame.gutterRight,
    `${where}: dead space on the right — \`main\` is still capped and centred on this route`,
  ).toBe(0);
  expect(frame.mainWidth, `${where}: \`main\` is not the width of the window`).toBe(
    frame.windowWidth,
  );

  // The rail is flush to the window's left edge, so `railRight` really is the
  // width of everything to the canvas's left when no panel is open.
  expect(frame.railLeft, `${where}: the rail is not flush to the window's left edge`).toBe(0);

  // EVERY PIXEL LEFT OF THE CANVAS IS ACCOUNTED FOR BY A BOX THAT IS THERE.
  expect(
    frame.flowLeft,
    `${where}: unexplained gutter between the rail/panel and the canvas`,
  ).toBe(chromeRight(frame));
  expect(frame.flowRight, `${where}: the canvas does not reach the window's right edge`).toBe(
    frame.windowWidth,
  );
  expect(
    frame.flowWidth,
    `${where}: the canvas is not the window minus the rail and the open panel`,
  ).toBe(frame.windowWidth - chromeRight(frame));
}

/**
 * Open or shut the rail's panel by its own control, and wait for the canvas to
 * have finished moving.
 *
 * THE WAIT IS DELIBERATELY NOT THE ASSERTION. Polling until `flowLeft` equals the
 * value the test is about to assert would make every one of these tests pass by
 * waiting; it polls until the canvas's left edge has CHANGED from wherever it was
 * before the click, which is true of a correct layout and of a broken one.
 */
async function setPanel(page: Page, open: boolean): Promise<void> {
  const panel = page.getByTestId("rail-panel");
  const isOpen = async (): Promise<boolean> =>
    (await panel.evaluate((element) => (element as HTMLElement).hidden)) === false;
  if ((await isOpen()) === open) return;
  const before = (await measure(page)).flowLeft;
  await page.getByTestId("rail-overview").click();
  await expect.poll(isOpen, { message: "the rail panel did not change state" }).toBe(open);
  await expect
    .poll(async () => (await measure(page)).flowLeft, {
      message: "the canvas never moved after the panel changed state",
    })
    .not.toBe(before);
}

/**
 * Open the run and wait for the graph to settle, then measure.
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

  return measure(page);
}

test.describe("at 2000px — wider than the cap that used to bind", () => {
  test.use({ viewport: { width: 2000, height: 1200 } });

  test("the canvas fills the window minus the rail and the open panel", async ({
    page,
  }) => {
    const frame = await frameOf(page);

    /*
     * THE DEFAULT STATE OF THIS RUN. `runs/[runId]/page.tsx:567-572` opens
     * Overview when nothing has been chosen and there are no questions, so the
     * panel is in the row on first paint — which is why the old
     * `flowWidth === windowWidth` failed here at 1552 rather than intermittently.
     */
    expect(frame.panelHidden, "the panel is not open, so nothing is being subtracted").toBe(
      false,
    );
    expect(
      frame.panelPosition,
      "the panel is overlaying the canvas at 2000px instead of sitting in the row",
    ).toBe("static");

    // The three boxes are edge to edge with nothing between them.
    expect(frame.panelLeft, "a gap between the rail and the panel").toBe(frame.railRight);
    expectNoGutter(frame, "panel open");

    // AND THE SUM IS THE ONE THE DESIGN CLAIMS: 48 + 400 + 1552 at 2000px. The
    // literal is asserted only after the arithmetic above, so a rail or panel that
    // silently changed width reddens the identity rather than the invariant.
    expect(
      { rail: frame.railWidth, panel: frame.panelWidth, canvas: frame.flowWidth },
      "the rail/panel/canvas split is not 48 + 400 + the rest",
    ).toEqual({ rail: 48, panel: 400, canvas: 1552 });
  });

  test("shutting the panel gives the canvas back exactly the panel's width", async ({
    page,
  }) => {
    /*
     * THE SECOND STATE, AND WITHOUT IT THE TEST ABOVE IS A CONSTANT. A canvas
     * frozen at 1552 — a hard-coded width, a stale `ResizeObserver`, a panel whose
     * space is reserved whether or not it is open — passes every assertion above
     * and fails this one.
     */
    const open = await frameOf(page);
    await setPanel(page, false);
    const shut = await measure(page);

    expect(shut.panelHidden, "the panel did not close").toBe(true);
    expectNoGutter(shut, "panel shut");

    // The canvas grew by the panel's width and by nothing else.
    expect(
      shut.flowWidth - open.flowWidth,
      "the canvas did not take over exactly the space the panel gave up",
    ).toBe(open.panelWidth);
    expect(shut.flowLeft, "the canvas does not start where the rail ends").toBe(
      shut.railRight,
    );

    // And it goes back when it is re-opened, so the space is not lost either way.
    await setPanel(page, true);
    const reopened = await measure(page);
    expectNoGutter(reopened, "panel re-opened");
    expect(reopened.flowWidth).toBe(open.flowWidth);
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

    /*
     * WHAT THE DELETED `footerFullyVisible` WAS FOR, ASSERTED ON SOMETHING THAT
     * IS STILL ON THE PAGE. `min-h-0` on `main` (`app-shell.tsx`) is what lets the
     * flex child shrink; without it `main` grows to its content and its last row
     * is pushed below the fold of a shell that is `h-dvh overflow-hidden`, so
     * nothing scrolls and the rows past the bottom are simply gone. `main` ending
     * at the window's bottom edge is that property directly. 1px of tolerance for
     * the run view's own `border-y`.
     */
    expect(
      frame.windowHeight - frame.mainBottom,
      "`main` runs past the bottom of the window — its last row is unreachable",
    ).toBeLessThanOrEqual(1);
    expect(
      frame.mainBottom - frame.flowBottom,
      "the canvas stops short of the bottom of the space it was given",
    ).toBeLessThanOrEqual(1);
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

    // THE SAME ARITHMETIC, AT A SECOND WIDTH. 1440 - 48 - 400 = 992, and the
    // panel is still `static` here because 1440 is above the 1120px switch.
    expectNoGutter(frame, "1440px, panel open");
    expect(frame.flowWidth).toBe(992);
    expect(frame.clippedNodes).toEqual([]);
    expect(frame.vScrollbar).toBe(false);
    expect(frame.hScrollbar).toBe(false);
    expect(frame.windowHeight - frame.mainBottom).toBeLessThanOrEqual(1);
  });

  test("and with the panel shut, at the width the old cap was invisible at", async ({
    page,
  }) => {
    /*
     * BOTH STATES AT BOTH WIDTHS. The panel's width is a fixed 400px rather than a
     * fraction, so a canvas that were sized by percentage would be right at one of
     * these four readings and wrong at the others.
     */
    await frameOf(page);
    await setPanel(page, false);
    const shut = await measure(page);

    expectNoGutter(shut, "1440px, panel shut");
    expect(shut.flowWidth).toBe(1392);
    expect(shut.hScrollbar, "shutting the panel gave the page a horizontal scrollbar").toBe(
      false,
    );
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
