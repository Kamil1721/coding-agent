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

/**
 * Read computed properties AND the conduit scale in ONE evaluate.
 *
 * NOT TWO ROUND TRIPS, and that is a flake this suite would otherwise have
 * shipped into a file with exactly this history. The widths below are
 * `calc(base * var(--conduit-scale))`, and the scale is rewritten whenever the
 * viewport moves — including 400ms after a node arrives, now that the canvas
 * re-fits on growth. A width read in one `evaluate` and a scale read in the
 * next can straddle that write and disagree by 30% for no reason anybody could
 * reproduce. `conduit-zoom.browser.spec.ts` reads its zoom and its widths in one
 * pass for the same reason.
 */
async function styleOf(locator: Locator, props: readonly string[]): Promise<Style> {
  return locator.evaluate((element, names: readonly string[]): Style => {
    const computed = getComputedStyle(element);
    const out: Style = {};
    for (const name of names) out[name] = computed.getPropertyValue(name);
    const shell = document.querySelector(".react-flow");
    if (shell === null) throw new Error("no react-flow shell");
    const raw = getComputedStyle(shell).getPropertyValue("--conduit-scale").trim();
    // Unset is the documented default: `var(--conduit-scale, 1)`.
    out["--conduit-scale"] = raw === "" ? "1" : raw;
    return out;
  }, props);
}

/**
 * THE STROKE WIDTHS BELOW ARE NO LONGER LITERALS, AND THIS IS WHY — 2026-08-09.
 *
 * `globals.css` used to carry `stroke-width: 2.5` on the guess and `4.5` on the
 * body; it now carries `calc(2.5px * var(--conduit-scale, 1))`, because at the
 * zoom the canvas fits itself to, the designed widths landed on screen under a
 * device pixel and the whole four-layer construction collapsed to a hairline
 * (`conduit-zoom.browser.spec.ts` has the measurements and the argument). The
 * computed width is therefore a function of the viewport, and pinning `"2.5px"`
 * pinned the harness's window size rather than the design.
 *
 * WHAT IS PINNED INSTEAD: the BASE. `--conduit-scale` is read out of the
 * rendered shell and the expectation is `base * scale`, so the 2.5 and the 4.5
 * are still the numbers this file defends and a change to either still fails
 * here. What this can NOT tell you is whether the scale is the right scale —
 * that is deliberately somebody else's job, and `conduit-zoom.browser.spec.ts`
 * does it by measuring effective SCREEN width against a floor rather than by
 * multiplying by the same property it is checking.
 */
function scaleOf(style: Style): number {
  const raw = Number.parseFloat(style["--conduit-scale"] ?? "");
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("--conduit-scale did not resolve");
  return raw;
}

/** `stroke-width` as a number, so it can be compared against a scaled base. */
function widthPx(value: string | undefined): number {
  return Number.parseFloat(value ?? "");
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
    //
    // THE STROKE IS READ FROM THE TOKEN, NOT RETYPED. Updated 2026-08-03, when
    // the guess edge stopped being grey: this used to hardcode
    // `rgb(111, 120, 135)`, so the test pinned a literal that no longer had a
    // name anywhere. Three fixtures elsewhere in this repo drifted exactly that
    // way — each built its own object instead of reading the constant, and each
    // stayed green while describing a shape the code no longer produced.
    // Resolving `--edge-guess` here means a palette change still fails the
    // assertion below (the opacity and the dash are still literals, and the
    // colour must still differ from the settled edge), while a RENAME of the
    // token cannot pass by accident.
    const guess = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--edge-guess)";
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    });
    expect(guess, "--edge-guess is not defined").not.toBe("");

    /*
     * ONE SCALE, READ ALONGSIDE EACH WIDTH. They are asserted equal first: the
     * two edges are in the same shell, so a difference could only mean one of
     * the reads straddled a viewport change, and comparing a width against the
     * other read's scale would be comparing two moments.
     */
    const scale = scaleOf(inferred);
    expect(scaleOf(settled), "the two reads straddled a viewport change").toBe(scale);

    expect({ ...inferred, "stroke-width": "base", "--conduit-scale": "read" }).toEqual({
      stroke: guess,
      "stroke-width": "base",
      "stroke-dasharray": "2px, 7px",
      opacity: "0.72",
      "--conduit-scale": "read",
    } satisfies Record<EdgeProp | "--conduit-scale", string>);
    expect(widthPx(inferred["stroke-width"]), "the guess's base width").toBeCloseTo(
      2.5 * scale,
      3,
    );

    expect({ ...settled, "stroke-width": "base", "--conduit-scale": "read" }).toEqual({
      // A `<linearGradient>` reference, not a colour, and that is the fact worth
      // pinning: the settled body carries the PARENT's role hue into the CHILD's,
      // so a reader sees design work handed to a build agent without reading
      // either card. A flat stroke here would be that channel silently removed.
      stroke: 'url("#root-_reviewer-grad")',
      "stroke-width": "base",
      "stroke-dasharray": "none",
      opacity: "1",
      "--conduit-scale": "read",
    } satisfies Record<EdgeProp | "--conduit-scale", string>);
    expect(widthPx(settled["stroke-width"]), "the body's base width").toBeCloseTo(
      4.5 * scale,
      3,
    );
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

  test("names the claim it is uncertain about, on the edge itself", async ({ page }) => {
    await openCanvas(page);
    // ON THE CONNECTOR — scoped to React Flow's edge-label layer, not to the
    // page. The agent CARD also carries an `inferred` badge, and a page-wide
    // text match would be satisfied by the card alone while the edge carried
    // nothing.
    //
    // THE WORD CHANGED 2026-08-03 AND THE ASSERTION FOLLOWED THE MEANING, not
    // the string: `inferred` was this codebase's name for the server's
    // attribution step, and the edge's job is to say WHICH CLAIM is a guess —
    // that it knows who spawned whom. The card keeps `inferred` because there it
    // qualifies the agent and has a tooltip; the edge IS the claim.
    const label = page.locator(".react-flow__edgelabel-renderer").getByText("guessed parent", {
      exact: true,
    });
    await expect(label).toBeVisible();

    // AND IT IS NOT DRAWN AS CHROME. The label used to be grey on grey, which
    // put the one thing the server admits it does not know into the same visual
    // class as every dim border on the canvas. It now carries the same hue as
    // the stroke, and that hue is deliberately no role's — so this asserts the
    // colour is SET rather than inherited from the faint-ink default.
    const color = await label.evaluate((el) => getComputedStyle(el).color);
    expect(color, "the guessed-parent label is still drawn in default chrome grey").not.toBe("");
    const inkFaint = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-ink-faint").trim(),
    );
    expect(color).not.toBe(inkFaint);
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
    expect({ ...comet, "--conduit-scale": "read" }).toEqual({
      "--conduit-scale": "read",
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
    expect({ ...comet, "stroke-width": "base", "--conduit-scale": "read" }).toEqual({
      "animation-name": "none",
      "stroke-dasharray": "none",
      "stroke-width": "base",
      "--conduit-scale": "read",
    });
    // Thinner than the 2.2px it is when it moves: a stroke that sits on the
    // wire permanently would swamp the 1.35px specular core at full width. The
    // base is what is pinned; `--conduit-scale` multiplies it exactly as it
    // multiplies every other conduit width, including in this media query.
    const scale = scaleOf(comet);
    expect(widthPx(comet["stroke-width"])).toBeCloseTo(1.5 * scale, 3);
    expect(widthPx(comet["stroke-width"])).toBeLessThan(2.2 * scale);
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
