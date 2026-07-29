/**
 * The three edge treatments, measured in a browser because that is the only
 * place they exist.
 *
 * WHAT IS ACTUALLY BEING DEFENDED. `flow-edge.tsx` renders a GUESS differently
 * from a FACT: an edge whose child was attributed by inference is dim, thin,
 * dotted and labelled, and an edge that settled is a flat hairline. That
 * distinction is FOUR COMPUTED PROPERTIES and a word. It is not the class name —
 * both branches ship `edge-line` — so a check that asserts on class names, or on
 * "an element with the inferred id exists", passes happily while the two render
 * identically and the canvas quietly stops admitting what it does not know.
 * Hence: computed style, both branches, every property, and an explicit
 * assertion that no property matches.
 *
 * The values below were MEASURED in Chromium against this tree, not derived
 * from the source: `1px, 5px` is how a computed `stroke-dasharray` serialises,
 * and `oklab(...)` is what `color-mix` resolves to. Reading them off the CSS
 * would have produced strings that never match.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

const EDGE_PROPS = ["stroke", "stroke-width", "stroke-dasharray", "opacity"] as const;

type EdgeProp = (typeof EDGE_PROPS)[number];
type Style = Record<string, string>;

async function styleOf(locator: Locator, props: readonly string[]): Promise<Style> {
  return locator.evaluate((element, names: readonly string[]): Style => {
    const computed = getComputedStyle(element);
    const out: Style = {};
    for (const name of names) out[name] = computed.getPropertyValue(name);
    return out;
  }, props);
}

/** Open the run and wait until React Flow has actually drawn its edges. */
async function openCanvas(page: Page): Promise<void> {
  await page.goto(`/runs/${RUN_ID}`);
  // The fixture is shaped so there is exactly one of each: one inferred edge,
  // one settled edge, one flowing core. A count assertion is the gate, so a
  // fixture that drifts fails here rather than silently pointing the style
  // assertions at whichever path happened to render.
  await expect(page.locator('path[id$="-inferred"]')).toHaveCount(1);
  await expect(page.locator('path[id$="-settled"]')).toHaveCount(1);
  await expect(page.locator("path.edge-core--flowing")).toHaveCount(1);
}

test.describe("the inferred edge", () => {
  test("does not render as the settled hairline", async ({ page }) => {
    await openCanvas(page);

    const inferred = await styleOf(page.locator('path[id$="-inferred"]'), EDGE_PROPS);
    const settled = await styleOf(page.locator('path[id$="-settled"]'), EDGE_PROPS);

    // THE INVARIANT, STATED FIRST: not one of the four properties may agree.
    // This is the assertion that goes red when the inferred branch is restyled
    // to match the settled one while keeping its class and its label.
    for (const prop of EDGE_PROPS) {
      expect(
        inferred[prop],
        `inferred and settled edges share ${prop} — a guess is being drawn as a fact`,
      ).not.toBe(settled[prop]);
    }

    // And the direction of each difference, so an inverted mutant — the
    // inferred edge drawn as the CONFIDENT one — cannot satisfy the above.
    expect(Number(inferred["opacity"])).toBeLessThan(Number(settled["opacity"]));
    expect(Number.parseFloat(inferred["stroke-width"] ?? "")).toBeLessThan(
      Number.parseFloat(settled["stroke-width"] ?? ""),
    );
    expect(inferred["stroke-dasharray"]).not.toBe("none");
    expect(settled["stroke-dasharray"]).toBe("none");

    // The recorded values. A palette change is allowed to fail this — it should
    // be a decision, not a drift.
    expect(inferred).toEqual({
      stroke: "rgb(111, 120, 135)",
      "stroke-width": "1.25px",
      "stroke-dasharray": "1px, 5px",
      opacity: "0.5",
    } satisfies Record<EdgeProp, string>);
    expect(settled).toEqual({
      stroke: "rgb(51, 58, 72)",
      "stroke-width": "1.5px",
      "stroke-dasharray": "none",
      opacity: "1",
    } satisfies Record<EdgeProp, string>);
  });

  test("carries the word `inferred` on the edge itself", async ({ page }) => {
    await openCanvas(page);
    // ON THE CONNECTOR — scoped to React Flow's edge-label layer, not to the
    // page. The agent card also says `inferred`, and a page-wide text match
    // would be satisfied by the card alone while the edge carried nothing.
    await expect(
      page.locator(".react-flow__edgelabel-renderer").getByText("inferred", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("never flows, even though its child agent is running", async ({ page }) => {
    await openCanvas(page);
    // The fixture's inferred child is `running`. If attribution were ignored
    // there would be two flowing cores instead of one, and the inferred path
    // would be animated.
    await expect(page.locator("path.edge-core--flowing")).toHaveCount(1);
    await expect(page.locator('path[id$="-inferred"]')).toHaveCSS(
      "animation-name",
      "none",
    );
  });
});

test.describe("motion, allowed", () => {
  test("the live edge's core travels, and the live dots pulse", async ({ page }) => {
    await openCanvas(page);

    // THE NEGATIVE CONTROL for the reduced-motion specs below: without the
    // emulation, both animations are on. Without this, a suite could assert
    // "nothing animates" against an app where nothing ever animated.
    const core = await styleOf(page.locator("path.edge-core--flowing"), [
      "animation-name",
      "animation-duration",
      "stroke-dasharray",
    ]);
    expect(core).toEqual({
      "animation-name": "edge-flow",
      "animation-duration": "1.15s",
      "stroke-dasharray": "2px, 11px",
    });

    const pulses = page.locator(".animate-pulse");
    expect(await pulses.count()).toBeGreaterThan(0);
    const names = await pulses.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).animationName),
    );
    expect([...new Set(names)]).toEqual(["pulse"]);
  });
});

test.describe("motion, refused", () => {
  /*
   * `contextOptions`, NOT a bare `reducedMotion`. Playwright 1.62 dropped the
   * top-level test option; written the old way it is accepted at runtime,
   * emulates nothing, and the specs below quietly measure an un-emulated
   * browser. Caught here by `npm run typecheck` — `test.use({ reducedMotion })`
   * fails with TS2353 — which is the reason this package type-checks its own
   * harness rather than only transpiling it.
   */
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the travelling dash stops AND the core goes solid", async ({ page }) => {
    await openCanvas(page);

    // `animation: none` alone is not the requirement. A frozen dash pattern
    // reads as an inferred edge to exactly the readers who cannot use motion to
    // tell the two apart, so the reduced-motion rule also replaces the dash with
    // a solid stroke. Both halves are asserted.
    const core = await styleOf(page.locator("path.edge-core--flowing"), [
      "animation-name",
      "stroke-dasharray",
      "stroke-width",
    ]);
    expect(core).toEqual({
      "animation-name": "none",
      "stroke-dasharray": "none",
      "stroke-width": "1.5px",
    });
  });

  test("every pulsing dot in the app is stilled", async ({ page }) => {
    await openCanvas(page);

    const pulses = page.locator(".animate-pulse");
    // There must BE some, or this asserts nothing.
    expect(await pulses.count()).toBeGreaterThan(0);
    const names = await pulses.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).animationName),
    );
    expect([...new Set(names)]).toEqual(["none"]);
  });
});
