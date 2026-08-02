/**
 * The three edge treatments, measured in a browser because that is the only
 * place they exist.
 *
 * WHAT IS ACTUALLY BEING DEFENDED. `flow-edge.tsx` renders a GUESS differently
 * from a FACT: an edge whose child was attributed by inference is an EMPTY
 * conduit — it keeps the rim and the casing every wire on the canvas gets, and
 * the groove has nothing in it — while a settled edge is filled with a per-edge
 * role gradient. That distinction is FOUR COMPUTED PROPERTIES and a word. It is
 * NOT the presence of a path and it is NOT the id: every non-inferred edge, live
 * or settled, carries `…-settled` on its body. So a check that asserts on ids,
 * or on "an element with the inferred id exists", passes happily while the two
 * render identically and the canvas quietly stops admitting what it does not
 * know. Hence: computed style, both branches, every property, and an explicit
 * assertion that no property matches.
 *
 * RE-POINTED 2026-08-02, AND THE GAP IS THE REASON THIS NOTE IS LONG. This file
 * was written at `5ee7209` against the edge design of `f25d736` — an `edge-line`
 * hairline with an `edge-core--flowing` dash travelling along it. `0d0eaab`
 * replaced that design wholesale with the conduit (`globals.css`, "the version
 * this replaces was a translucent 9px tube … and the owner's verdict on it was
 * 'mega basic'"), and this file was not re-pointed. Every assertion below was
 * therefore unreachable: all six tests died in `openCanvas` on
 * `path[id$="-settled"]` — expected 1, received 2 — because `-settled` changed
 * meaning from "not flowing" to "not inferred" and the fixture has two
 * non-inferred edges. `edge-line`, `edge-core--flowing` and the `edge-flow`
 * keyframes do not exist anywhere in `globals.css` any more.
 *
 * THAT MADE A DOCBLOCK IN `globals.css` FALSE FOR THE WHOLE GAP. `.conduit-guess`
 * says "`canvas-edges.browser.spec.ts` asserts all four and the sign of each, so
 * a restyle that closed the gap goes red". Nothing was asserted; the gate threw
 * first. It is true again from here, which is why that comment is left standing
 * rather than edited.
 *
 * THE VALUES BELOW WERE MEASURED in Chromium against this tree, not derived from
 * the source: `2px, 7px` is how a computed `stroke-dasharray` serialises a
 * `stroke-dasharray: 2 7`, `70px, 930px` is what the comet's `pathLength`-relative
 * dash serialises to, and `url("#root-_reviewer-grad")` is what a `stroke` filled
 * by a `<linearGradient>` reads back as. Reading them off the CSS would have
 * produced strings that never match.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { RUN_ID } from "./fixtures/config";

const EDGE_PROPS = ["stroke", "stroke-width", "stroke-dasharray", "opacity"] as const;

type EdgeProp = (typeof EDGE_PROPS)[number];
type Style = Record<string, string>;

/*
 * THE THREE EDGES, ADDRESSED ONE BY ONE INSTEAD OF BY SUFFIX.
 *
 * `flow-edge.tsx` ids each layer `${safeId(edgeId)}-${layer}`, and `safeId` is a
 * plain character-class replace (`/[^A-Za-z0-9_-]/g` → `_`), so `root->reviewer`
 * is `root-_reviewer` and the ids are stable rather than index-derived. Naming
 * the edges is deliberate: `run-fixture.ts` documents which edge exists to carry
 * which treatment — `root->builder` FLOWING, `root->reviewer` SETTLED,
 * `root->guard` INFERRED — and a suffix match cannot tell them apart now that
 * two of the three share the `-settled` suffix. A fixture that stops producing
 * any one of them fails the gate by name.
 */
const INFERRED = "path#root-_guard-inferred";
const SETTLED = "path#root-_reviewer-settled";
/** The hot stroke of the live edge's comet — the one comet layer with an id. */
const LIVE_COMET = "path#root-_builder-hot";
/** The inferred edge's whole group, for asserting what is NOT inside it. */
const INFERRED_GROUP = `g.react-flow__edge:has(${INFERRED})`;

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
  // The fixture is shaped so there is exactly one of each treatment. A count
  // assertion is the gate, so a fixture that drifts fails here rather than
  // silently pointing the style assertions at whichever path happened to render.
  await expect(page.locator(INFERRED)).toHaveCount(1);
  await expect(page.locator(SETTLED)).toHaveCount(1);
  await expect(page.locator(LIVE_COMET)).toHaveCount(1);
  /*
   * EXACTLY ONE EDGE IS ENERGISED BY BEING LIVE, and this is the count that
   * makes "the inferred edge never flows" mean something rather than being an
   * assertion about a path with no animation rule on it. Three paths, not one:
   * the comet is one dash drawn three times — halo, mid, hot — which is how it
   * gets a feathered falloff without a filter.
   *
   * `--live` AND NOT `.conduit-comet`, because the arrival sweep is real. For
   * `maxDepth × 190 + 1200` ms after the first paint every settled edge also
   * carries a `--sweep` comet, so a bare `.conduit-comet` count is 9 and then 3
   * and any assertion racing that boundary is a coin flip. `--live` is set from
   * the child agent's state alone and never from the sweep, so it is the same
   * number at every instant of the page's life.
   */
  await expect(page.locator("path.conduit-comet--live")).toHaveCount(3);
}

test.describe("the inferred edge", () => {
  test("does not render as a filled conduit", async ({ page }) => {
    await openCanvas(page);

    const inferred = await styleOf(page.locator(INFERRED), EDGE_PROPS);
    const settled = await styleOf(page.locator(SETTLED), EDGE_PROPS);

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
      "stroke-width": "2.5px",
      "stroke-dasharray": "2px, 7px",
      opacity: "0.55",
    } satisfies Record<EdgeProp, string>);
    expect(settled).toEqual({
      // A `<linearGradient>` reference, not a colour, and that is the fact worth
      // pinning: the settled body carries the PARENT's role hue into the CHILD's,
      // so a reader sees design work handed to a build agent without reading
      // either card. A flat stroke here would be that channel silently removed.
      stroke: 'url("#root-_reviewer-grad")',
      "stroke-width": "4.5px",
      "stroke-dasharray": "none",
      opacity: "1",
    } satisfies Record<EdgeProp, string>);
  });

  test("gets none of the layers that mean `something went through here`", async ({
    page,
  }) => {
    await openCanvas(page);
    /*
     * THE OTHER HALF OF THE FOUR-PROPERTY CLAIM, and it is a claim about paths
     * rather than about styles: `globals.css` says an inferred connector gets
     * "no role gradient, no specular core, no bloom, no comet, ever". Each of
     * those is a separate `<path>` in the settled branch, so their absence is
     * countable — and a restyle that re-added the specular core to a guess would
     * satisfy every style assertion above while putting a fact's ceremony back on
     * a guess.
     *
     * Scoped to the inferred edge's own group, because all three are present
     * elsewhere on this canvas; a page-wide count of zero would be a claim about
     * the settled edges too and would be false.
     */
    const group = page.locator(INFERRED_GROUP);
    await expect(group).toHaveCount(1);
    await expect(group.locator("path.conduit-core")).toHaveCount(0);
    await expect(group.locator("path.conduit-body")).toHaveCount(0);
    await expect(group.locator("path.conduit-bloom")).toHaveCount(0);
    await expect(group.locator("path.conduit-comet")).toHaveCount(0);

    // POSITIVE CONTROL: the settled edge has the three static ones, so the
    // zeroes above are a fact about the inferred branch and not about a selector
    // that matches nothing on this page.
    const settledGroup = page.locator(`g.react-flow__edge:has(${SETTLED})`);
    await expect(settledGroup.locator("path.conduit-core")).toHaveCount(1);
    await expect(settledGroup.locator("path.conduit-body")).toHaveCount(1);
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
    // there would be two live comets instead of one — six paths, not three — and
    // the inferred path would be animated.
    await expect(page.locator("path.conduit-comet--live")).toHaveCount(3);
    await expect(page.locator(INFERRED_GROUP).locator("path.conduit-comet")).toHaveCount(
      0,
    );
    await expect(page.locator(INFERRED)).toHaveCSS("animation-name", "none");
  });
});

test.describe("motion, allowed", () => {
  test("the live edge's comet travels, and the live dots pulse", async ({ page }) => {
    await openCanvas(page);

    // THE NEGATIVE CONTROL for the reduced-motion specs below: without the
    // emulation, both animations are on. Without this, a suite could assert
    // "nothing animates" against an app where nothing ever animated.
    const comet = await styleOf(page.locator(LIVE_COMET), [
      "animation-name",
      "animation-duration",
      "stroke-dasharray",
    ]);
    expect(comet).toEqual({
      "animation-name": "conduit-travel",
      // 1.6s is the LIVE loop; `--focus` is 1.15s and `--sweep` is 1s over the
      // same keyframes, so the duration is what says which of the three reasons
      // this wire is moving for.
      "animation-duration": "1.6s",
      // ONE dash of 70 and a gap of 930 against `pathLength={1000}`, so exactly
      // one comet is on the wire and a 300px hop and a 900px hop get the same
      // comet at the same speed. A repeating pattern here would be the cheap
      // sliding-dash effect the conduit exists to replace.
      "stroke-dasharray": "70px, 930px",
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

  test("the travelling comet stops AND goes solid", async ({ page }) => {
    await openCanvas(page);

    // `animation: none` alone is not the requirement. A frozen comet is worse
    // here than a frozen dash was — it parks one bright blob at an arbitrary
    // point on the wire, which reads as a rendering fault — so the reduced-motion
    // rule also replaces the dash with a solid stroke, turning the three stacked
    // strokes into a steady bright overlay along the whole conduit. An energised
    // edge therefore still reads as brighter than a settled one with no motion
    // carrying the difference. All three halves are asserted.
    const comet = await styleOf(page.locator(LIVE_COMET), [
      "animation-name",
      "stroke-dasharray",
      "stroke-width",
    ]);
    expect(comet).toEqual({
      "animation-name": "none",
      "stroke-dasharray": "none",
      // Thinner than the 2.2px it is when it moves: a stroke that sits on the
      // wire permanently would swamp the 1.35px specular core at full width.
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
