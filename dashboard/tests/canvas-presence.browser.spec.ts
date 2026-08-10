/**
 * WHAT A CONDUIT LOOKS LIKE WHEN NOTHING IS HAPPENING, AND WHAT MOVES WHEN
 * SOMETHING IS.
 *
 * TWO CLAIMS FROM THE OWNER'S OWN BAR, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 *   1. MOTION MUST STOP. `globals.css` has a rule the whole edge treatment is
 *      built on — "a settled edge nobody is pointing at does not move, which is
 *      what keeps the moving ones worth looking at" — and it was measured being
 *      broken once already (six comets alive four seconds after a 1,390ms sweep
 *      should have ended). Anything added here has to leave that intact.
 *
 *   2. LIGHT MUST NOT. Measured on this exact fixture before the change: a
 *      finished run's canvas carried `bloom 0, filters 0, comets 0,
 *      animations 0` at rest, on a graph with four real conduits. That is
 *      correct about the motion and wrong about the light. A bloom is not
 *      motion; it says "this cable carries current", which is still true after
 *      the run ends. Without it an hour of watching settles into a wireframe.
 *
 * So this file asserts BOTH HALVES OF EACH TEST. Every arm that demands light
 * also pins the absence of movement beside it, and every arm that demands
 * movement also pins that it is confined to the edges that earned it. A file
 * that only checked one direction would go green against the two opposite
 * defects.
 *
 * WHY THE MEASUREMENTS ARE COMPUTED STYLE AND rAF SAMPLES, NOT PIXELS. A
 * screenshot pair taken 250ms apart came back BYTE-IDENTICAL for both the
 * moving case and the reduced-motion case in this repository, because Chromium
 * freezes the animation clock during `captureScreenshot`. A method that gives
 * the same answer for both arms cannot discriminate and is not used here.
 * Everything below is read out of the rendered document: computed `stop-color`
 * sampled across real animation frames, the filter primitive list read off the
 * `<filter>` the paint actually resolves to, and computed opacity.
 *
 * THE ONE-VARIABLE CONTROLS.
 *   - Settled versus energised is read from ONE page: `BUILD_RUN_ID` has both
 *     states on the same canvas at the same instant, so the only difference
 *     between the two measurements is the state of the edge.
 *   - Moving versus stilled is `contextOptions: { reducedMotion: "reduce" }` on
 *     the same fixture, so the only difference is one media preference. That
 *     arm is also the positive assertion for the accessibility half: a reader
 *     who has asked for no motion must still be able to see which wires are
 *     live, and the static bloom is what tells them.
 *
 * `contextOptions`, NOT A BARE `reducedMotion` — the trap `canvas-edges` and
 * `model-picker` both record. Playwright 1.62 accepts the bare key in the
 * fixture type and never passes it to the browser.
 */

import { expect, test, type Page } from "@playwright/test";

import { BUILD_RUN_ID, FINISHED_RUN_ID } from "./fixtures/config";

/**
 * The flux keyframe's period and the lead the parent's stop gets, copied from
 * `globals.css` and `flow-edge.tsx`.
 *
 * Literals on purpose, the way `conduit-zoom.browser.spec.ts` copies the stroke
 * widths: this file is the thing that notices when those numbers move.
 */
const FLUX_PERIOD_MS = 2400;
const FLUX_LEAD_MS = 600;

/**
 * Open a run and wait until the canvas is genuinely at rest.
 *
 * NOT A SLEEP. The arrival sweep is a one-shot that energises every edge for
 * up to `maxDepth * 190 + 1200`ms after the first paint, and a census taken
 * during it reports blooms and comets on a finished run — the first draft of
 * this measurement did exactly that and reported the defect as already fixed.
 * The sweep's own class is the settle condition: when no `--sweep` comet is
 * left in the document, whatever is still moving is moving for a reason.
 */
async function settled(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.locator("path.conduit-rim").first()).toBeAttached();
  await expect
    .poll(async () => page.locator("path.conduit-comet--sweep").count(), { timeout: 20_000 })
    .toBe(0);
}

type BloomFacts = {
  readonly bodies: number;
  readonly blooms: number;
  readonly settledBlooms: number;
  readonly energisedBlooms: number;
  /** Primitive tag names of the filter each bloom path's paint resolves to. */
  readonly resolvedPrimitives: readonly string[];
  /** Blooms whose computed `filter` did NOT resolve to a filter in the document. */
  readonly danglingFilters: number;
  readonly settledOpacity: number | null;
  readonly energisedOpacity: number | null;
  readonly comets: number;
  readonly travelAnimations: number;
  /**
   * Which reason energised the lit edges.
   *
   * Three things energise an edge and only one of them is a fact about the run:
   * the child is RUNNING, the reader is POINTING at an end, or the arrival sweep
   * is playing. The pointer starts at (0,0) in a fresh Playwright page, so a
   * hover should be impossible — but "should be impossible" is how a test ends
   * up asserting that the mouse happened to be somewhere. These two counts make
   * the reason explicit, so `energisedBlooms > 0` cannot be satisfied by an
   * accidental hover over a card.
   */
  readonly liveComets: number;
  readonly focusComets: number;
};

/**
 * Everything about the edges' light, in ONE round trip.
 *
 * One `evaluate`, for the reason `canvas-edges.browser.spec.ts` records: the
 * canvas re-fits 400ms after a node arrives and rewrites `--conduit-scale`, so
 * two reads taken in separate round trips can straddle that write. Nothing here
 * depends on the scale, but the counts and the opacities must describe the same
 * frame or a comparison between them means nothing.
 *
 * THE FILTER IS FOLLOWED, NOT ASSUMED. `getComputedStyle(path).filter` gives
 * `url("#id")`; this resolves that id against the document and reads the
 * primitives out of the element it lands on. A filter that was rendered into a
 * `<defs>` but never referenced — or referenced under an id that does not
 * exist, which is what an unescaped `>` in an edge id used to produce — is a
 * dangling reference here and not a bloom.
 */
async function bloomFacts(page: Page): Promise<BloomFacts> {
  return page.evaluate((): BloomFacts => {
    const blooms = [...document.querySelectorAll<SVGPathElement>("path.conduit-bloom")];
    const primitives: string[] = [];
    let dangling = 0;
    let settledOpacity: number | null = null;
    let energisedOpacity: number | null = null;

    for (const bloom of blooms) {
      const computed = getComputedStyle(bloom);
      const match = /url\("?#([^")]+)"?\)/.exec(computed.filter);
      const target = match === null ? null : document.getElementById(match[1] ?? "");
      if (target === null || target.tagName !== "filter") {
        dangling += 1;
      } else {
        primitives.push([...target.children].map((child) => child.tagName).join("+"));
      }
      const opacity = Number.parseFloat(computed.opacity);
      if (bloom.dataset["state"] === "settled") settledOpacity = opacity;
      if (bloom.dataset["state"] === "energised") energisedOpacity = opacity;
    }

    return {
      bodies: document.querySelectorAll("path.conduit-body").length,
      blooms: blooms.length,
      settledBlooms: document.querySelectorAll('path.conduit-bloom[data-state="settled"]').length,
      energisedBlooms: document.querySelectorAll('path.conduit-bloom[data-state="energised"]')
        .length,
      resolvedPrimitives: primitives,
      danglingFilters: dangling,
      settledOpacity,
      energisedOpacity,
      comets: document.querySelectorAll("path.conduit-comet").length,
      liveComets: document.querySelectorAll("path.conduit-comet--live").length,
      focusComets: document.querySelectorAll("path.conduit-comet--focus").length,
      travelAnimations: document
        .getAnimations()
        .filter(
          (animation) =>
            (animation as unknown as { animationName?: string }).animationName ===
            "conduit-travel",
        ).length,
    };
  });
}

test.describe("a run that ended still looks like something ran", () => {
  test("every settled conduit carries light, and nothing on the canvas moves", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page, FINISHED_RUN_ID);

    const facts = await bloomFacts(page);

    /*
     * THE PRECONDITION. Four of this fixture's five delegation edges are exact
     * and one is inferred. If the fixture ever stops drawing real conduits the
     * counts below become statements about an empty canvas, and every `toBe(0)`
     * in the second half would pass for the wrong reason.
     */
    expect(facts.bodies, "no settled conduits on this fixture — the rest is vacuous").toBe(4);

    // ONE BLOOM PER CONDUIT. Not "at least one": a canvas that lit a single
    // edge would satisfy a floor and still be the wireframe this fixes.
    expect(facts.blooms).toBe(facts.bodies);
    expect(facts.settledBlooms).toBe(facts.bodies);
    expect(facts.energisedBlooms).toBe(0);

    /*
     * AND THE LIGHT REACHES THE PAINT. Every bloom's computed filter resolves
     * to a real `<filter>`, and the settled form is the SINGLE pass — one
     * `feGaussianBlur`, no merge. Half the Gaussians of an energised edge,
     * which is the whole reason this was affordable to ship on every edge.
     */
    expect(facts.danglingFilters, "a bloom references a filter that is not in the document").toBe(
      0,
    );
    /*
     * COUNTED AND SET-COMPARED, NOT DEEP-EQUALLED AGAINST A LITERAL ARRAY. The
     * array is built by walking the blooms in document order, so an
     * order-sensitive equality would pin the fixture's edge ORDER while
     * appearing to pin the filter's shape, and the next edge added to the
     * fixture would fail here with a message about nothing.
     */
    expect(new Set(facts.resolvedPrimitives)).toEqual(new Set(["feGaussianBlur"]));
    expect(facts.resolvedPrimitives).toHaveLength(facts.bodies);

    /*
     * THE OTHER HALF, AND IT IS NOT DECORATION. Light was added to a settled
     * canvas; motion must not have come with it. A finished run opens no socket
     * and has no live child, so there is nothing on this canvas that has earned
     * a comet — and `conduit-travel` is the animation that used to survive its
     * own sweep and run forever.
     */
    expect(facts.comets, "a finished run has no live child and must have no comet").toBe(0);
    expect(facts.travelAnimations).toBe(0);
  });

  test("the guess gets no light either", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page, FINISHED_RUN_ID);

    /*
     * An inferred edge is a GUESS about who spawned whom, and `globals.css`
     * commits to giving it "no role gradient, no specular core, no bloom, no
     * comet, ever". Un-gating the bloom is safe only because `flow-edge.tsx`
     * returns before the `<defs>` for an inferred edge — a refactor that moved
     * the bloom above that early return would dress a guess as a fact and every
     * other assertion in this file would stay green.
     */
    const guessGroup = page.locator("g.react-flow__edge:has(path.conduit-guess)");
    await expect(guessGroup).toHaveCount(1);
    await expect(guessGroup.locator("path.conduit-bloom")).toHaveCount(0);
    await expect(guessGroup.locator("filter")).toHaveCount(0);

    // POSITIVE CONTROL, so the zeroes above are a fact about the guess branch
    // and not about a selector that matches nothing on this page.
    const settledGroup = page.locator("g.react-flow__edge:has(path.conduit-body)").first();
    await expect(settledGroup.locator("path.conduit-bloom")).toHaveCount(1);
  });

  test("an energised wire is still the brightest thing on the canvas", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page, BUILD_RUN_ID);

    /*
     * BOTH STATES, ONE PAGE, ONE INSTANT. This fixture has a running child and
     * three finished delegations, so the settled and the energised numbers
     * below come off the same canvas in the same `evaluate`. Comparing a
     * finished RUN against a live one would confound the state with the
     * fixture, which is the mistake this repository's own report was corrected
     * for.
     */
    const facts = await bloomFacts(page);
    expect(facts.settledBlooms, "no settled edge on this fixture").toBeGreaterThan(0);
    expect(facts.energisedBlooms, "no energised edge on this fixture").toBeGreaterThan(0);
    // And it is energised because a child is RUNNING, not because the pointer
    // drifted over a card between the navigation and the measurement.
    expect(facts.liveComets).toBeGreaterThan(0);
    expect(facts.focusComets, "an edge is lit by hover — this measurement is not about a live run").toBe(0);

    expect(facts.settledOpacity).not.toBeNull();
    expect(facts.energisedOpacity).not.toBeNull();
    /*
     * THE ORDERING IS THE ASSERTION, not either number. A settled cable may
     * glow; it may not glow as hard as one with work moving down it, or the
     * canvas has stopped distinguishing "this happened" from "this is
     * happening" — which is the failure mode that adding light to everything
     * invites.
     */
    expect(facts.energisedOpacity ?? 0).toBeGreaterThan((facts.settledOpacity ?? 0) * 1.4);

    // And the two states are two different filters, not one filter dimmed.
    const shapes = new Set(facts.resolvedPrimitives);
    expect(shapes.has("feGaussianBlur")).toBe(true);
    expect(shapes.has("feGaussianBlur+feGaussianBlur+feMerge")).toBe(true);
  });
});

type FluxSample = {
  readonly stops: number;
  readonly animatedStops: number;
  readonly frames: number;
  readonly distinctParent: number;
  readonly distinctChild: number;
  /** ms from the start of sampling to each stop's brightest frame. */
  readonly peakParentMs: number;
  readonly peakChildMs: number;
  /** Whether any FILTERED path paints from the animated gradient. */
  readonly filteredPathsOnFlux: number;
  readonly endStopsAnimated: number;
};

/**
 * Sample one energised edge's gradient across a full flux cycle.
 *
 * WHY LIGHTNESS AND NOT THE STRING. The two animated stops sit at opposite ends
 * of a role gradient and therefore never share a colour, so "the two strings
 * differ" is true even with the animation deleted. What the animation claims is
 * that a band of light CROSSES the wire — the parent's stop peaks first and the
 * child's follows `FLUX_LEAD_MS` later — and that is a claim about WHEN each
 * stop is brightest. So each sample keeps the L of `oklab(L a b)` against a
 * real timestamp, and the assertion is on the distance between the two maxima.
 * With the lead set to zero the whole conduit breathes in unison and that
 * distance collapses, which no count of distinct values would notice.
 *
 * OVER A FULL PERIOD AND A BIT. A window shorter than 2400ms can miss one of
 * the two peaks entirely and make the distance meaningless.
 */
async function fluxSample(page: Page, windowMs: number): Promise<FluxSample> {
  return page.evaluate(async (duration: number): Promise<FluxSample> => {
    const gradient = [...document.querySelectorAll("linearGradient")].find(
      (candidate) => candidate.querySelectorAll("stop.conduit-flux-stop").length === 2,
    );
    if (gradient === undefined) throw new Error("no gradient with two animated stops");
    const animated = [...gradient.querySelectorAll<SVGStopElement>("stop.conduit-flux-stop")];
    const parent = animated[0];
    const child = animated[1];
    if (parent === undefined || child === undefined) throw new Error("missing flux stop");

    const lightnessOf = (element: Element): number => {
      const raw = getComputedStyle(element).stopColor;
      const value = /oklab\(\s*([\d.]+)/.exec(raw);
      if (value !== null) return Number.parseFloat(value[1] ?? "0");
      // Any non-oklab serialisation: fall back to the luma of the rgb triple so
      // the sample degrades to a real number instead of throwing.
      const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(raw);
      if (rgb === null) return 0;
      return (
        (Number(rgb[1]) * 0.2126 + Number(rgb[2]) * 0.7152 + Number(rgb[3]) * 0.0722) / 255
      );
    };

    const parentSeen = new Set<string>();
    const childSeen = new Set<string>();
    const parentTrack: [number, number][] = [];
    const childTrack: [number, number][] = [];
    const started = performance.now();

    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const now = performance.now() - started;
        parentSeen.add(getComputedStyle(parent).stopColor);
        childSeen.add(getComputedStyle(child).stopColor);
        parentTrack.push([now, lightnessOf(parent)]);
        childTrack.push([now, lightnessOf(child)]);
        if (now >= duration) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const peakOf = (track: readonly [number, number][]): number =>
      track.reduce((best, entry) => (entry[1] > best[1] ? entry : best), track[0] ?? [0, 0])[0];

    // Which paths paint from THIS gradient, and whether any of them is filtered.
    const reference = `url("#${gradient.id}")`;
    const filteredOnFlux = [...document.querySelectorAll<SVGPathElement>("path")].filter(
      (path) => {
        const computed = getComputedStyle(path);
        return computed.stroke === reference && computed.filter !== "none";
      },
    ).length;

    return {
      stops: gradient.querySelectorAll("stop").length,
      animatedStops: animated.length,
      frames: parentTrack.length,
      distinctParent: parentSeen.size,
      distinctChild: childSeen.size,
      peakParentMs: peakOf(parentTrack),
      peakChildMs: peakOf(childTrack),
      filteredPathsOnFlux: filteredOnFlux,
      endStopsAnimated: [...gradient.querySelectorAll("stop")].filter(
        (stop) =>
          !stop.classList.contains("conduit-flux-stop") &&
          getComputedStyle(stop).animationName !== "none",
      ).length,
    };
  }, windowMs);
}

test.describe("the gradient stops carry energy down a live wire", () => {
  test("the band of light crosses the conduit in the direction the work went", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page, BUILD_RUN_ID);

    const sample = await fluxSample(page, FLUX_PERIOD_MS + 400);

    // The shape of the gradient: four stops, of which exactly the two interior
    // ones animate. The ends hold their role's hue, which is what keeps each
    // role identifiable where the wire meets its card.
    expect(sample.stops).toBe(4);
    expect(sample.animatedStops).toBe(2);
    expect(
      sample.endStopsAnimated,
      "an end stop is animating — the role hue washes out where the wire meets the card",
    ).toBe(0);

    // It really is moving, on both stops, across real animation frames.
    expect(sample.frames).toBeGreaterThan(60);
    expect(sample.distinctParent).toBeGreaterThan(30);
    expect(sample.distinctChild).toBeGreaterThan(30);

    /*
     * AND IT TRAVELS. The parent's stop peaks first; the child's follows one
     * `FLUX_LEAD_MS` later, wrapped into the period because the sampling window
     * starts wherever the animation happens to be. A lead of zero — the obvious
     * way to write this wrong — puts both peaks on the same frame and lands
     * this at 0 or at the full period.
     */
    const lag =
      ((sample.peakChildMs - sample.peakParentMs) % FLUX_PERIOD_MS + FLUX_PERIOD_MS) %
      FLUX_PERIOD_MS;
    expect(
      lag,
      `the child's stop peaked ${lag.toFixed(0)}ms after the parent's, not ~${String(FLUX_LEAD_MS)}ms — the wire is breathing, not carrying`,
    ).toBeGreaterThan(FLUX_LEAD_MS * 0.45);
    expect(lag).toBeLessThan(FLUX_LEAD_MS * 2.2);

    /*
     * THE COST RULE, ASSERTED STRUCTURALLY RATHER THAN TIMED. A gradient is a
     * paint server: every element painting with it repaints when a stop
     * changes. If a FILTERED path ever painted from this gradient, the browser
     * would re-rasterise its Gaussian on every one of those frames — the exact
     * expense `flow-edge.tsx` avoids by never filtering the comet. The bloom
     * therefore keeps the static gradient, and this is the assertion that
     * notices if someone points it at the animated one.
     */
    expect(
      sample.filteredPathsOnFlux,
      "a filtered path paints from the animated gradient — that is a Gaussian re-rasterised every frame",
    ).toBe(0);
  });

  test.describe("with motion switched off", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the stops hold still and the light stays", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await settled(page, BUILD_RUN_ID);

      const sample = await fluxSample(page, 1000);

      /*
       * ONE VARIABLE. Same fixture, same viewport, same code path as the test
       * above; the only difference is the media preference. Exactly one
       * computed value per stop across sixty-odd real frames.
       */
      expect(sample.frames).toBeGreaterThan(30);
      expect(sample.distinctParent).toBe(1);
      expect(sample.distinctChild).toBe(1);

      /*
       * AND THE READER IS NOT LEFT WITH NOTHING. This is the positive half:
       * stilling the motion must not still the signal. The bloom is static
       * paint, so it survives `prefers-reduced-motion` intact — an energised
       * wire is brighter than a settled one with every animation switched off,
       * which is the whole reason the settled bloom was worth adding rather
       * than just brightening the live ones.
       */
      const facts = await bloomFacts(page);
      expect(facts.travelAnimations, "the comet is still running under reduced motion").toBe(0);
      expect(facts.blooms).toBeGreaterThan(0);
      expect(facts.danglingFilters).toBe(0);
      expect(facts.settledBlooms).toBeGreaterThan(0);
      expect(facts.energisedBlooms).toBeGreaterThan(0);
      expect(facts.liveComets).toBeGreaterThan(0);
      expect(facts.focusComets).toBe(0);
      expect(facts.energisedOpacity ?? 0).toBeGreaterThan((facts.settledOpacity ?? 0) * 1.4);
    });
  });
});
