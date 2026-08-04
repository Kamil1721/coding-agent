/**
 * motion-capture.test.ts — the ways a motion capture fails, and the one way it
 * returns nothing without having failed.
 *
 * NO BROWSER IS LAUNCHED BY THIS FILE. Everything here drives the injected
 * {@link LaunchMotionBrowser} seam, for the reason `site-capture.test.ts:1`
 * gives: the failure modes are control flow, and control flow is cheap to pin
 * and expensive to reproduce with a real chromium. What a fake CANNOT check is
 * that playwright's own objects still satisfy these interfaces, or that the
 * injected sampler measures anything — `motion-capture.browser.test.ts` runs a
 * real chromium against a fixture with declared numbers for exactly that, and
 * the two files are only worth anything together.
 *
 * THE DISTINCTION THIS FILE EXISTS TO PIN. "The capture failed" and "the page
 * was read and does not move" are different answers, and a module that returned
 * the same thing for both would let a broken sampler read as a still page
 * forever. One is `{ok: false}` with a sentence; the other is `{ok: true}` with
 * an empty observation list.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  HOVER_TIMEOUT_MS,
  MAX_HOVER_TARGETS,
  MOTION_BUDGET_MS,
  MOTION_LAUNCH_TIMEOUT_MS,
  MOTION_NAVIGATION_TIMEOUT_MS,
  captureMotion,
} from "./motion-capture.js";
import type {
  LaunchMotionBrowser,
  MotionBrowser,
  MotionContext,
  MotionContextOptions,
  MotionPage,
} from "./motion-capture.js";

/* -------------------------------------------------------------------------
 * A browser that never was
 * ---------------------------------------------------------------------- */

interface FakeState {
  /** Every explicit timeout the driver asked for, in call order. */
  readonly timeouts: number[];
  /** Every deliberate wait. Not a timeout; see MOTION_BUDGET_MS's docblock. */
  readonly waits: number[];
  readonly initScripts: string[];
  readonly contextOptions: MotionContextOptions[];
  readonly evaluated: string[];
  readonly hovered: string[];
  /** Order matters: an init script installed after `goto` misses the entrance. */
  readonly order: string[];
  contextsClosed: number;
  browserClosed: boolean;
}

interface FakeOptions {
  /** Records each harvest returns, in harvest order; the last one repeats. */
  readonly harvests?: readonly unknown[];
  readonly failGoto?: string;
  readonly failEvaluate?: string;
  readonly failNewContext?: string;
  readonly targets?: readonly number[];
  readonly snapshotItems?: (call: number) => unknown;
}

function fakeBrowser(options: FakeOptions = {}): { browser: MotionBrowser; state: FakeState } {
  const state: FakeState = {
    timeouts: [],
    waits: [],
    initScripts: [],
    contextOptions: [],
    evaluated: [],
    hovered: [],
    order: [],
    contextsClosed: 0,
    browserClosed: false,
  };

  let harvestCall = 0;
  let snapshotCall = 0;

  const page: MotionPage = {
    goto(_url, gotoOptions) {
      state.order.push("goto");
      state.timeouts.push(gotoOptions.timeout);
      if (options.failGoto !== undefined) return Promise.reject(new Error(options.failGoto));
      return Promise.resolve(null);
    },
    evaluate(expression) {
      state.evaluated.push(expression);
      if (options.failEvaluate !== undefined) return Promise.reject(new Error(options.failEvaluate));
      if (expression.includes("harvest()")) {
        const list = options.harvests ?? [];
        const value = list.length === 0 ? [] : (list[Math.min(harvestCall, list.length - 1)] ?? []);
        harvestCall += 1;
        return Promise.resolve(value);
      }
      if (expression.includes("snapshot()")) {
        const items = options.snapshotItems === undefined ? [] : options.snapshotItems(snapshotCall);
        snapshotCall += 1;
        return Promise.resolve({ scrollY: snapshotCall * 400, items });
      }
      if (expression.includes("scrollRange()")) return Promise.resolve(2000);
      if (expression.includes("targets(")) return Promise.resolve([...(options.targets ?? [])]);
      if (expression.includes("libraries()")) return Promise.resolve(["gsap"]);
      return Promise.resolve(null);
    },
    waitForTimeout(ms) {
      state.waits.push(ms);
      return Promise.resolve(null);
    },
    hover(selector, hoverOptions) {
      state.hovered.push(selector);
      state.timeouts.push(hoverOptions.timeout);
      return Promise.resolve(null);
    },
  };

  const context: MotionContext = {
    addInitScript(script) {
      state.order.push("addInitScript");
      state.initScripts.push(script);
      return Promise.resolve(null);
    },
    newPage() {
      return Promise.resolve(page);
    },
    close() {
      state.contextsClosed += 1;
      return Promise.resolve(null);
    },
  };

  const browser: MotionBrowser = {
    newContext(contextOptions) {
      state.contextOptions.push(contextOptions);
      if (options.failNewContext !== undefined) {
        return Promise.reject(new Error(options.failNewContext));
      }
      return Promise.resolve(context);
    },
    close() {
      state.browserClosed = true;
      return Promise.resolve(null);
    },
  };

  return { browser, state };
}

const launcher = (browser: MotionBrowser): LaunchMotionBrowser => () => Promise.resolve(browser);

/** One harvest record shaped the way the injected sampler returns them. */
const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  role: "h1",
  props: ["opacity", "transform"],
  firstMs: 120,
  spanMs: 640,
  declaredMs: 800,
  easing: "ease-out",
  infinite: false,
  ...over,
});

/* -------------------------------------------------------------------------
 * The failures
 * ---------------------------------------------------------------------- */

test("the browser failing to start is a named refusal, not a throw", async () => {
  const result = await captureMotion({
    url: "https://example.com",
    launch: () => Promise.reject(new Error("Executable doesn't exist at .../chrome")),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /browser could not be started/);
  assert.match(result.reason, /Executable doesn't exist/, "the real cause survives, or nobody can fix it");
});

test("an unresolvable playwright is reported as a missing dependency, not as a bad page", async () => {
  const result = await captureMotion({
    url: "https://example.com",
    launch: () =>
      Promise.reject(new Error("playwright could not be loaded (Cannot find module 'playwright').")),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /Cannot find module 'playwright'/);
});

test("a navigation timeout closes the browser and reports the page, not the browser", async () => {
  const fake = fakeBrowser({ failGoto: "Timeout 20000ms exceeded" });
  const result = await captureMotion({
    url: "https://slow.example",
    launch: launcher(fake.browser),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /motion could not be read/);
  assert.match(result.reason, /Timeout 20000ms exceeded/);
  assert.equal(fake.state.browserClosed, true, "a leaked chromium is a process the owner finds later");
  assert.equal(fake.state.contextsClosed, 1, "the context is closed even when the navigation failed");
});

test("an evaluate that throws is a failed capture, not a page that does not move", async () => {
  // The two outcomes must never be confused: this one means the sampler could
  // not be reached at all. Reporting it as an empty reading would tell the owner
  // his reference is motionless.
  const fake = fakeBrowser({ failEvaluate: "Execution context was destroyed" });
  const result = await captureMotion({
    url: "https://example.com",
    launch: launcher(fake.browser),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /Execution context was destroyed/);
  assert.equal(fake.state.browserClosed, true);
});

test("a context that cannot be opened is a failed capture, and the browser still closes", async () => {
  const fake = fakeBrowser({ failNewContext: "Target page, context or browser has been closed" });
  const result = await captureMotion({
    url: "https://example.com",
    launch: launcher(fake.browser),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /has been closed/);
  assert.equal(fake.state.browserClosed, true);
});

/* -------------------------------------------------------------------------
 * The one that succeeds by finding nothing
 * ---------------------------------------------------------------------- */

test("a page that returns ZERO observations is a successful reading, not a failure", async () => {
  /*
   * THE DISTINCTION THIS WHOLE FILE IS FOR. A still page and a broken capture
   * must not produce the same value. Here every harvest is empty and the result
   * is `ok: true` with no observations — the caller can then say "this page does
   * not appear to move", which is a fact, rather than "the reference could not
   * be read", which is a different fact with a different remedy.
   */
  const fake = fakeBrowser({ harvests: [[]] });
  const result = await captureMotion({ url: "https://static.example", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reading.observations.length, 0);
  assert.equal(result.reading.url, "https://static.example");
  assert.equal(
    result.reading.respectsReducedMotion,
    true,
    "nothing moved under reduce either, which is what honouring the preference looks like",
  );
});

test("an entrance harvest becomes a load-entrance observation with the DECLARED duration", async () => {
  // The sampled span is 640ms and the stylesheet declares 800ms. The declared
  // number wins: it is exact and identical between two readings, and a sampled
  // span is quantised to the frame rate.
  const fake = fakeBrowser({ harvests: [[record()], []] });
  const result = await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const entrance = result.reading.observations.find((o) => o.family === "load-entrance");
  assert.equal(entrance?.durationMs, 800);
  assert.equal(entrance?.role, "h1");
  assert.equal(entrance?.iterations, 1);
});

test("a record with no declared duration falls back to the sampled span", async () => {
  // The rAF-driven case — GSAP, Framer Motion, the fixture's parallax. Nothing
  // is declared anywhere in the computed style, so the span is all there is.
  const fake = fakeBrowser({ harvests: [[record({ declaredMs: null, spanMs: 640 })], []] });
  const result = await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reading.observations[0]?.durationMs, 640);
});

test("an infinite iteration count becomes ambient-loop with null iterations", async () => {
  // `null` is what `motion-brief.ts` renders as "repeating without end". An
  // infinite element must also never be reported a second time as a scroll
  // reveal merely because it kept looping while the page was scrolled.
  const fake = fakeBrowser({ harvests: [[record({ infinite: true, declaredMs: 3000 })]] });
  const result = await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const families = result.reading.observations.map((o) => o.family);
  assert.deepEqual(families, ["ambient-loop"], "counted once, under one family");
  assert.equal(result.reading.observations[0]?.iterations, null);
});

test("a transform that is a CONSISTENT multiple of the scroll is scroll-linked", async () => {
  // The parallax test, at the seam. Every snapshot puts the element at 0.25x the
  // scroll position, so the ratio agrees at every step.
  const fake = fakeBrowser({
    harvests: [[]],
    snapshotItems: (call) => [{ id: 9, role: "div.para", ty: (call + 1) * 400 * 0.25 }],
  });
  const result = await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const linked = result.reading.observations.find((o) => o.family === "scroll-linked");
  assert.equal(linked?.scrollRatio, 0.25);
  assert.equal(linked?.role, "div.para");
});

test("a scroll-linked element is reported ONCE, never also as a reveal or a hover", async () => {
  /*
   * FOUND BY MUTATION, NOT BY DESIGN. Deleting the `linkedIds` guard left all
   * sixteen other tests in this file green: the parallax is an element whose
   * transform changes while the page is scrolled, which is also the definition
   * of a reveal, and it changes again when the driver scrolls back to the top
   * before hovering. The duplicate carries a DURATION — a placeholder for a
   * thing that has none — so the spec seat would be handed "div.para reveals
   * over 50ms" beside the ratio that actually describes it.
   */
  const fake = fakeBrowser({
    harvests: [[], [], [record({ id: 9, role: "div.para", declaredMs: null, spanMs: 400 })]],
    snapshotItems: (call) => [{ id: 9, role: "div.para", ty: (call + 1) * 400 * 0.25 }],
  });
  const result = await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.reading.observations.map((o) => o.family),
    ["scroll-linked"],
    "one element, one family, one entry",
  );
});

test("NEGATIVE CONTROL: an element that moves erratically while scrolling is NOT scroll-linked", async () => {
  /*
   * Without this the detector could be "anything whose transform changed during
   * the ramp", which would call every reveal a parallax and print a fabricated
   * px-per-px ratio into the brief — a number the spec seat would then be
   * invited to write a criterion about. The test is CONSISTENCY, and this
   * element's offset is not a multiple of anything.
   */
  const erratic = [0, 90, 12, 500, 7, 310];
  const fake = fakeBrowser({
    harvests: [[]],
    snapshotItems: (call) => [{ id: 9, role: "div.noise", ty: erratic[call] ?? 0 }],
  });
  const result = await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reading.observations.filter((o) => o.family === "scroll-linked").length, 0);
});

/* -------------------------------------------------------------------------
 * The context options, which decide whether anything can be measured at all
 * ---------------------------------------------------------------------- */

test("the sampler is installed BEFORE the navigation, or the entrance is already over", async () => {
  /*
   * MEASURED: 21 distinct moving elements for a sampler installed at
   * document_start against 5 for one that starts at `domcontentloaded`. An
   * `addInitScript` called after `goto` is the second of those two, and it looks
   * identical in every other respect — same call, same script, a page that reads
   * as calm.
   */
  const fake = fakeBrowser({ harvests: [[]] });
  await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(fake.state.order[0], "addInitScript");
  assert.equal(fake.state.order.indexOf("goto") > 0, true);
});

test("the reading context is opened at no-preference, never at reduce", async () => {
  /*
   * THE DEFECT THIS PREVENTS IS ALREADY IN THE TREE, WORKING AS INTENDED
   * SOMEWHERE ELSE. The sealed scorer's screenshot capture runs
   * reducedMotion:"reduce" (scorer-container.ts:625) because it wants still
   * pictures. A reference read the same way measures zero motion on every site
   * and the whole feature reports that nothing on the web moves.
   */
  const fake = fakeBrowser({ harvests: [[]] });
  await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });
  assert.equal(fake.state.contextOptions[0]?.reducedMotion, "no-preference");
  assert.equal(
    fake.state.contextOptions[1]?.reducedMotion,
    "reduce",
    "the SECOND context is the reduced-motion probe, and only it",
  );
});

test("forceReducedMotion suppresses the page and skips the second context", async () => {
  // Two things, because the media feature alone was measured to change nothing
  // about a page that ignores it: the context asks for `reduce` AND a stylesheet
  // that stops animation is injected. And there is no separate probe context,
  // because the main pass is already the reduced one.
  const fake = fakeBrowser({ harvests: [[]] });
  await captureMotion({
    url: "https://example.com",
    launch: launcher(fake.browser),
    forceReducedMotion: true,
  });
  assert.equal(fake.state.contextOptions.length, 1, "no second context: this pass IS the reduced pass");
  assert.equal(fake.state.contextOptions[0]?.reducedMotion, "reduce");
  assert.equal(fake.state.initScripts.length, 2, "the sampler, and the stylesheet that stills the page");
  assert.match(fake.state.initScripts[1] ?? "", /animation:none!important/);
});

/* -------------------------------------------------------------------------
 * The budget
 * ---------------------------------------------------------------------- */

test("EVERY playwright call that can hang is given a timeout, and they sum to the stated budget", () => {
  /*
   * THE DEFECT THIS PINS SHIPPED ONCE ALREADY IN `site-capture.ts`'s first
   * draft: three screenshots without timeouts inherited playwright's 30 s
   * default, turning a request documented at ~25 s into one whose real ceiling
   * was over 90. A missing timeout is invisible — the code reads fine, the tests
   * pass, and only a hanging site shows it.
   *
   * Asserted THROUGH THE FAKE, which records what it was actually asked for, so
   * this fails if a timeout is dropped at a call site rather than merely if a
   * constant is renamed.
   *
   * `page.evaluate` and `page.waitForTimeout` are NOT in this count. Playwright
   * gives `evaluate` no timeout argument at all, and the waits are deliberate
   * phase lengths rather than ceilings — MOTION_PHASE_MS carries those, and
   * MOTION_BUDGET_MS's docblock says so rather than implying it covers them.
   */
  return (async () => {
    const fake = fakeBrowser({
      harvests: [[]],
      targets: [0, 1, 2, 3, 4, 5],
    });
    await captureMotion({ url: "https://example.com", launch: launcher(fake.browser) });

    assert.equal(
      fake.state.timeouts.length,
      2 + MAX_HOVER_TARGETS,
      "two navigations — the reading and the reduced-motion probe — plus one hover per target",
    );
    assert.ok(
      fake.state.timeouts.every((value) => value > 0),
      "a zero or absent timeout is playwright's 30 s default wearing a number",
    );
    assert.equal(
      fake.state.timeouts.reduce((sum, value) => sum + value, 0) + MOTION_LAUNCH_TIMEOUT_MS,
      MOTION_BUDGET_MS,
      "the constant quoted to the owner is the sum of what is actually requested",
    );
    assert.equal(
      MOTION_BUDGET_MS,
      MOTION_LAUNCH_TIMEOUT_MS + 2 * MOTION_NAVIGATION_TIMEOUT_MS + MAX_HOVER_TARGETS * HOVER_TIMEOUT_MS,
      "and the constant is written as that sum, not as a number someone typed",
    );
  })();
});

test("a hover that cannot land does not lose the other targets or the capture", async () => {
  // A cookie banner over the first button is the normal case on a real site.
  const fake = fakeBrowser({ harvests: [[]], targets: [0, 1, 2] });
  const failing: MotionBrowser = {
    ...fake.browser,
    newContext: async (options) => {
      const context = await fake.browser.newContext(options);
      return {
        ...context,
        newPage: async () => {
          const page = await context.newPage();
          return {
            ...page,
            hover: (selector, hoverOptions) => {
              fake.state.hovered.push(selector);
              fake.state.timeouts.push(hoverOptions.timeout);
              return Promise.reject(new Error("element is outside of the viewport"));
            },
          };
        },
      };
    },
  };
  const result = await captureMotion({ url: "https://example.com", launch: launcher(failing) });
  assert.equal(result.ok, true, "a hover that misses is not a failed capture");
  assert.equal(fake.state.hovered.length, 3, "every target is still attempted");
});
