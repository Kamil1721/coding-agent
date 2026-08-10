/**
 * THE CONDUIT'S GAUGE AT THE ZOOM THE CANVAS ACTUALLY CHOOSES.
 *
 * WHAT WENT WRONG, in numbers rather than adjectives. `globals.css` stacks four
 * strokes per edge — rim 13, casing 10.5, body 4.5, core 1.35 — and that stack
 * is where the connector's whole perceived quality lives. React Flow scales the
 * edge SVG by the viewport transform, and the canvas fits the graph on load:
 * measured at 1440x900 the fit is around 0.57 zoom on this fixture and 0.363924
 * on a twelve-node run. At 0.57 the specular core lands on screen at 0.77px and
 * at 0.36 it lands at 0.49px — thinner than a device pixel, which the
 * compositor paints as a grey smear or not at all. The four layers merge, the
 * per-edge gradient reads as a flat tint, and the treatment is invisible at the
 * only zoom the reader is ever given automatically.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT AN ASSERTION ABOUT A CUSTOM PROPERTY. The
 * repair is one number, `--conduit-scale`, written onto the canvas shell by
 * `orchestration-canvas.tsx`. Reading that property back and multiplying by it
 * would be this suite asserting its own arithmetic: it would pass just as well
 * if the property never reached the paint. So every number below is the
 * EFFECTIVE SCREEN WIDTH — `getComputedStyle(path).strokeWidth * zoom`, both
 * halves read out of the rendered document — and the floor is compared against
 * what the SAME zoom would have produced WITHOUT the repair, which is the
 * literal the stylesheet used to carry.
 *
 * THREE REGIMES, BECAUSE A ONE-SIDED FIX IS THE OBVIOUS WAY TO GET THIS WRONG.
 * The naive repair is `width / zoom`, which holds the cable at its designed
 * screen width forever and puts a 108px rim over a graph drawn at the 0.12 zoom
 * floor. So there is a test for the middle (compensation on), a test for zoomed
 * IN (compensation off — the designed widths, unchanged, to the digit) and a
 * test for zoomed OUT past the cap (the cable is allowed to lose gauge again,
 * and may never be wider on screen than it was designed to be).
 *
 * THE ZOOM IS DRIVEN BY THE CONTROL THE READER HAS, not by an injected
 * transform: `react-flow__controls-zoomin/out` multiply by 1.2 per press, so
 * the arms below are deterministic. They are operated by keyboard because
 * `next dev` pins its badge over the bottom-left corner where the controls sit
 * and Playwright refuses a pointer click it would intercept — the same
 * workaround `rail.browser.spec.ts` and `result-surfaces.browser.spec.ts`
 * record.
 */

import { expect, test, type Page } from "@playwright/test";

import { FINISHED_RUN_ID } from "./fixtures/config";

/**
 * The designed widths, in user units, copied from `globals.css`.
 *
 * They are literals here on purpose: this file is the thing that notices when
 * the stylesheet's own numbers move, and a value read back out of the
 * stylesheet could not do that.
 */
const BASE = { rim: 13, casing: 10.5, body: 4.5, core: 1.35, bloom: 6.5 } as const;

/**
 * `BASE.bloom` IS THE **SETTLED** WIDTH, and this file may only measure it
 * because of which fixture it opens.
 *
 * `globals.css` carries two bloom widths — `.conduit-bloom` at 5px for an
 * energised wire and `.conduit-bloom[data-state="settled"]` at 6.5px for one
 * whose work is done. `openCanvas` opens `FINISHED_RUN_ID`, on which every real
 * edge is settled, so 6.5 is the rule that resolves. {@link gaugeOf} reads the
 * attribute back off the element it measured and the tests assert it, so if
 * `flow-edge.tsx` ever stops writing `data-state` this file says that rather
 * than silently comparing against the wrong literal.
 *
 * WHY IT IS HERE AT ALL — added 2026-08-09, after review. The settled bloom is
 * the entire visual difference between a finished run and a wireframe of one,
 * and its legibility at the default fit rests on exactly the multiplier this
 * file exists to guard, yet nothing measured it: `canvas-presence` reads counts,
 * filter primitives and opacity; `canvas-edges` counts it at zero on the
 * inferred edge. Deleting `var(--conduit-scale)` from `globals.css`'s two bloom
 * rules dropped the halo to ~2.4px on screen at the twelve-node fit and left the
 * whole browser suite green.
 */
const SETTLED = "settled";

/** The rule the whole repair is derived from: the thinnest layer stays paintable. */
const CORE_FLOOR_PX = 1;

/**
 * The floor for the settled halo, and the window it sits in.
 *
 * Compensation pins the bloom's effective screen width at `6.5 / 1.35 = 4.81px`
 * for the whole compensated range (the multiplier is `1 / (1.35 * zoom)`, so the
 * zoom cancels). WITHOUT it the same halo is `6.5 * zoom`: 3.71px at this
 * fixture's ~0.57 fit and 2.40px at the 0.369 fit of a twelve-node run. 4px is
 * chosen to sit inside that window — above every uncompensated value the
 * compensated range can produce below zoom 0.615, and below the 4.81px that
 * ships — and the test refuses to pass on a fixture whose fit has drifted far
 * enough that the uncompensated value would clear it anyway.
 */
const BLOOM_FLOOR_PX = 4;

/** `CONDUIT_SCALE_MAX` in `orchestration-canvas.tsx`. */
const SCALE_CAP = 2.4;

type Gauge = {
  readonly zoom: number;
  readonly rim: number;
  readonly casing: number;
  readonly body: number;
  readonly core: number;
  readonly bloom: number;
  readonly bloomState: string | null;
};

/**
 * Read the viewport scale and the four stroke widths out of the rendered
 * document.
 *
 * The zoom comes off `.react-flow__viewport`'s computed `transform` — the same
 * matrix the browser is painting through — rather than from React Flow's API,
 * so a scale that never reached the DOM cannot satisfy it.
 */
async function gaugeOf(page: Page): Promise<Gauge> {
  return page.evaluate((): Gauge => {
    const viewport = document.querySelector(".react-flow__viewport");
    if (viewport === null) throw new Error("no react-flow viewport");
    const matrix = getComputedStyle(viewport).transform;
    const zoom = Number.parseFloat(matrix.replace("matrix(", "").split(",")[0] ?? "NaN");

    const widthOf = (selector: string): number => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`no ${selector} on the canvas`);
      return Number.parseFloat(getComputedStyle(element).strokeWidth);
    };

    return {
      zoom,
      rim: widthOf("path.conduit-rim"),
      casing: widthOf("path.conduit-casing"),
      body: widthOf("path.conduit-body"),
      core: widthOf("path.conduit-core"),
      bloom: widthOf("path.conduit-bloom"),
      bloomState: document.querySelector("path.conduit-bloom")?.getAttribute("data-state") ?? null,
    };
  });
}

/**
 * A settled canvas: fitted, drawn, and past the arrival sweep.
 *
 * `FINISHED_RUN_ID` and not a live one — a terminal run opens no socket
 * (`use-run-stream.ts`), so nothing is moving the graph underneath the
 * measurement.
 *
 * IT ALSO WAITS OUT THE ARRIVAL SWEEP, added 2026-08-09 with the bloom census
 * and MEASURED, not assumed: without the wait the very first `gaugeOf` on this
 * fixture reads `data-state="energised"` on every bloom, because `flow-edge.tsx`
 * derives that flag from `live || focused || sweep` and the sweep is still
 * running under a second-old page. The four original layers are the same width
 * in both states so they never noticed; the bloom is 5px energised and 6.5px
 * settled, so a census taken mid-sweep measures a transient against the wrong
 * literal. Polled on the state itself rather than slept on.
 */
async function openCanvas(page: Page): Promise<void> {
  await page.goto(`/runs/${FINISHED_RUN_ID}`);
  await expect(page.locator("path.conduit-core").first()).toBeAttached();
  await expect(page.locator("path.conduit-rim").first()).toBeAttached();
  await expect(page.locator('path.conduit-bloom[data-state="energised"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  // The fit runs after React Flow has measured its nodes, and the gauge is
  // written from the fit. Poll for it rather than sleeping on it.
  await expect
    .poll(async () => (await gaugeOf(page)).zoom, { timeout: 10_000 })
    .toBeLessThan(1);
}

/** Press a zoom control n times, by keyboard. */
async function press(page: Page, control: "zoomin" | "zoomout", times: number): Promise<void> {
  const button = page.locator(`button.react-flow__controls-${control}`);
  await expect(button).toHaveCount(1);
  for (let index = 0; index < times; index += 1) {
    await button.focus();
    await page.keyboard.press("Enter");
  }
}

test.describe("the four-layer conduit survives the zoom the canvas picks", () => {
  test("at the default fit the specular core still lands on a whole pixel", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);

    const gauge = await gaugeOf(page);

    /*
     * THE PRECONDITION, AND IT IS NOT DECORATION. Everything below is a claim
     * about the COMPENSATED range. If this fixture ever fits at 0.74 or above
     * the scale is 1 by design, the assertions become statements about the
     * unmodified stylesheet, and this test would pass while measuring nothing.
     * Below 0.31 the cap binds instead and the floor is deliberately given up.
     */
    expect(
      gauge.zoom,
      "this fixture no longer fits inside the compensated zoom range, so this test is vacuous",
    ).toBeGreaterThan(0.31);
    expect(gauge.zoom).toBeLessThan(0.74);

    /*
     * WHAT THE STYLESHEET USED TO PRODUCE AT THIS EXACT ZOOM — the same
     * measurement with the repair removed, computed rather than re-measured
     * because the zoom is the thing being held fixed. It is under a device
     * pixel, which is the defect.
     */
    const uncompensatedCore = BASE.core * gauge.zoom;
    expect(uncompensatedCore).toBeLessThan(CORE_FLOOR_PX);

    const screenCore = gauge.core * gauge.zoom;
    expect(
      screenCore,
      `the specular core renders at ${screenCore.toFixed(3)}px at zoom ${gauge.zoom.toFixed(6)}`,
    ).toBeGreaterThanOrEqual(CORE_FLOOR_PX - 0.02);

    // And it is the repair doing it, not a coincidence of rounding: strictly
    // more than the stylesheet's own literal would have given at this zoom.
    expect(screenCore).toBeGreaterThan(uncompensatedCore * 1.2);

    /*
     * THE SETTLED HALO IS THE FIFTH LAYER AND IT IS COMPENSATED TOO.
     *
     * On a finished run this is the only light on the canvas — the crisp body is
     * still drawn, but what says "this cable carried current" is the blur around
     * it, and a blur that lands at 2.4px on screen is a smudge rather than a
     * halo. Same construction as the core above: the uncompensated value first,
     * as the negative control, so a fixture that drifted out of the window
     * cannot make this pass by arithmetic.
     */
    expect(
      gauge.bloomState,
      "this fixture's edges are no longer settled, so 6.5px is the wrong literal to measure against",
    ).toBe(SETTLED);

    const uncompensatedBloom = BASE.bloom * gauge.zoom;
    expect(
      uncompensatedBloom,
      `at zoom ${gauge.zoom.toFixed(6)} the un-repaired halo would already clear the floor, so this ` +
        `assertion measures nothing`,
    ).toBeLessThan(BLOOM_FLOOR_PX);

    const screenBloom = gauge.bloom * gauge.zoom;
    expect(
      screenBloom,
      `the settled halo renders at ${screenBloom.toFixed(3)}px at zoom ${gauge.zoom.toFixed(6)}, ` +
        `against ${uncompensatedBloom.toFixed(3)}px with the compensation removed`,
    ).toBeGreaterThanOrEqual(BLOOM_FLOOR_PX);

    /*
     * THE STACK IS STILL A STACK. One multiplier for all five layers is what
     * keeps the groove reading as a groove; a repair that thickened only the
     * core would satisfy the floor above and destroy the construction.
     */
    expect(gauge.rim / gauge.core).toBeCloseTo(BASE.rim / BASE.core, 3);
    expect(gauge.casing / gauge.core).toBeCloseTo(BASE.casing / BASE.core, 3);
    expect(gauge.body / gauge.core).toBeCloseTo(BASE.body / BASE.core, 3);
    expect(gauge.bloom / gauge.core).toBeCloseTo(BASE.bloom / BASE.core, 3);

    // Ordering, so an inverted mutant cannot satisfy the ratios by accident.
    expect(gauge.rim).toBeGreaterThan(gauge.casing);
    expect(gauge.casing).toBeGreaterThan(gauge.body);
    expect(gauge.body).toBeGreaterThan(gauge.core);
  });

  test("zoomed in, the cable is exactly the width it was designed at", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);

    // Nine presses at 1.2x each takes ~0.57 past 1.0 and into the 1.5 ceiling's
    // neighbourhood, which is where a `width / zoom` repair would be fattening
    // the cable instead of leaving it alone.
    await press(page, "zoomin", 9);
    await expect.poll(async () => (await gaugeOf(page)).zoom).toBeGreaterThan(1);

    const gauge = await gaugeOf(page);
    expect(gauge.rim).toBeCloseTo(BASE.rim, 3);
    expect(gauge.casing).toBeCloseTo(BASE.casing, 3);
    expect(gauge.body).toBeCloseTo(BASE.body, 3);
    expect(gauge.core).toBeCloseTo(BASE.core, 3);
    expect(gauge.bloomState).toBe(SETTLED);
    expect(gauge.bloom).toBeCloseTo(BASE.bloom, 3);
  });

  test("zoomed out past the cap, the wiring does not swallow the graph", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);

    await press(page, "zoomout", 5);
    await expect.poll(async () => (await gaugeOf(page)).zoom).toBeLessThan(0.31);

    const gauge = await gaugeOf(page);

    // The cap has bound: the compensation stops at 2.4x and no further.
    expect(gauge.rim).toBeLessThanOrEqual(BASE.rim * SCALE_CAP + 0.01);
    expect(gauge.core).toBeLessThanOrEqual(BASE.core * SCALE_CAP + 0.01);
    expect(gauge.bloom).toBeLessThanOrEqual(BASE.bloom * SCALE_CAP + 0.01);

    /*
     * THE ANTI-BLOB INVARIANT, and it is the one that rules out the naive
     * `width / zoom`: however far out the reader goes, a cable may never occupy
     * MORE screen than the design gives it at 1:1. Full compensation would sit
     * exactly on 13px here and reach it at every zoom below.
     */
    expect(gauge.rim * gauge.zoom).toBeLessThan(BASE.rim);
    expect(gauge.rim * gauge.zoom).toBeGreaterThan(BASE.rim * gauge.zoom);
  });
});
