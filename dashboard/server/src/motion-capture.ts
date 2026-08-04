/**
 * motion-capture.ts — watch a page move, because asking it what moves returns
 * nothing.
 *
 * THE MEASUREMENT THAT DECIDED THIS FILE'S SHAPE. `document.getAnimations()` is
 * the obvious way to ask a page what it is animating, and on the pages this
 * feature exists for it answers with an empty array: sampled on gsap.com at six
 * scroll offsets, it reported 0 running animations at every one. GSAP, Framer
 * Motion, Lenis and every other rAF-driven library write inline styles frame by
 * frame; none of that is a web-animations object. So this module SAMPLES
 * COMPUTED STYLE per animation frame instead. Anyone tempted to "improve" this
 * back to `getAnimations()` should re-run that measurement first.
 *
 * THE SAMPLER IS INSTALLED WITH `addInitScript`, BEFORE THE PAGE'S OWN SCRIPTS.
 * Measured on the same page: 21 distinct moving elements for a sampler that
 * starts at document_start, against 5 for one that starts at `domcontentloaded`.
 * An entrance animation is over before `domcontentloaded` fires, and a sampler
 * that arrives late reports the page as calm.
 *
 * WHAT IT CAN AND CANNOT SEE — say this plainly, because the brief this feeds is
 * read as if it were a survey of the page. Six of the twelve {@link MotionFamily}
 * values are ever produced here: `load-entrance`, `ambient-loop`,
 * `scroll-reveal`, `scroll-linked`, `hover-focus`, and nothing else. The other
 * six — `split-text`, `path-draw`, `scroll-inertia`, `cursor-follow`, `tilt-3d`,
 * `route-transition`, `canvas-ambient` — are NEVER emitted by this driver. A
 * canvas that repaints has an unchanging computed style and would need its
 * pixels read back; a route transition needs a second navigation; a cursor
 * follower needs mouse movement this driver does not perform. `motion-brief.ts`
 * can render all twelve because a later capture may learn to produce them; this
 * one does not, and the brief it writes therefore under-reports rather than
 * over-reports.
 *
 * IT SAMPLES ONLY `transform` AND `opacity`. That is what the validated spike
 * sampled and it is what the overwhelming majority of web motion animates. A
 * page whose only motion is a colour cross-fade or a `clip-path` wipe reads here
 * as a page that does not move. That is a false negative this file accepts and
 * does not disguise.
 *
 * NEVER THROWS — the same contract as `captureSite`, for the same reason. This
 * runs inside `POST /api/runs`; a third-party page that hangs must degrade the
 * ticket, not refuse to create the run. The browser is closed on every path.
 *
 * MIRRORS `site-capture.ts`'s SEAM, WITH ONE DELIBERATE DIVERGENCE. There the
 * injected seam is `LaunchBrowser -> CaptureBrowser.newPage()`. Here it is
 * `LaunchMotionBrowser -> MotionBrowser.newContext()`, because `reducedMotion`
 * is a CONTEXT option in playwright, not a page one, and the reduced-motion
 * probe needs a second context in the same browser. Exposing `newPage` would
 * make the probe impossible to write.
 */

/* -------------------------------------------------------------------------
 * The seam
 * ---------------------------------------------------------------------- */

import type { MotionCaptureResult, MotionFamily, RawObservation } from "./motion-types.js";

/**
 * The slice of playwright this module uses.
 *
 * DECLARED STRUCTURALLY, WITH THE SAME LIMIT `site-capture.ts:253` records: the
 * real module arrives through a dynamic import with a non-literal specifier, so
 * TypeScript types it `any` and nothing checks that playwright's `Page` still
 * satisfies this. `motion-capture.browser.test.ts` is what checks it, by running
 * the real thing.
 */
export interface MotionPage {
  goto(
    url: string,
    options: { readonly waitUntil: "domcontentloaded"; readonly timeout: number },
  ): Promise<unknown>;
  /**
   * The string form on purpose: the sampler is injected as source text (see
   * {@link SAMPLER_SOURCE}), and every call here is a short expression against
   * the object that script installed.
   *
   * NO TIMEOUT ARGUMENT EXISTS FOR THIS CALL IN PLAYWRIGHT, which is why nothing
   * in the injected script ever awaits a frame that may not come: every function
   * on `window.__motionProbe` returns synchronously from a buffer the rAF loop
   * fills. A page whose rAF never fires yields an empty harvest rather than a
   * hang.
   */
  evaluate(expression: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  hover(selector: string, options: { readonly timeout: number }): Promise<unknown>;
}

export interface MotionContext {
  addInitScript(script: string): Promise<unknown>;
  newPage(): Promise<MotionPage>;
  close(): Promise<unknown>;
}

export interface MotionContextOptions {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly reducedMotion: "no-preference" | "reduce";
}

export interface MotionBrowser {
  newContext(options: MotionContextOptions): Promise<MotionContext>;
  close(): Promise<unknown>;
}

export type LaunchMotionBrowser = () => Promise<MotionBrowser>;

/* -------------------------------------------------------------------------
 * Budgets
 * ---------------------------------------------------------------------- */

/**
 * THE BOUNDED CALLS, AND THE HONEST TOTAL.
 *
 * Every playwright call here that ACCEPTS a timeout is given one, for the reason
 * `site-capture.ts:296` records: playwright's own default is 30 s and the
 * defaults multiply, so an untimed call is a submit button that silently costs
 * half a minute more than the number quoted to the owner.
 *
 * {@link MOTION_BUDGET_MS} IS THE SUM OF THOSE CALLS AND OF NOTHING ELSE — one
 * launch, two navigations, and one hover per {@link MAX_HOVER_TARGETS}. It is
 * NOT the cost of a capture. The phases are deliberate waits rather than
 * timeouts, and they are counted separately by {@link MOTION_PHASE_MS}, which is
 * what a HEALTHY capture actually costs. `page.evaluate` takes no timeout in
 * playwright and is in neither figure; see {@link MotionPage.evaluate} for why
 * that is survivable here.
 *
 * So: a healthy capture is about {@link MOTION_PHASE_MS}. A pathological one is
 * bounded by {@link MOTION_BUDGET_MS} plus that. Quoting either alone to the
 * owner would be wrong in a different direction.
 */
export const MOTION_LAUNCH_TIMEOUT_MS = 15_000;
/** One `goto`. Matches `site-capture.ts`'s so a slow site costs the same twice. */
export const MOTION_NAVIGATION_TIMEOUT_MS = 20_000;
/**
 * One hover. Short on purpose: a hover that cannot land (an element covered by a
 * cookie banner) is a normal outcome on a real page, not an error, and six of
 * them at playwright's default would be three minutes.
 */
export const HOVER_TIMEOUT_MS = 1_000;
/** How many interactive elements are hovered. Past six it stops being a sample. */
export const MAX_HOVER_TARGETS = 6;

export const MOTION_BUDGET_MS =
  MOTION_LAUNCH_TIMEOUT_MS +
  2 * MOTION_NAVIGATION_TIMEOUT_MS +
  MAX_HOVER_TARGETS * HOVER_TIMEOUT_MS;

/**
 * How long the page is watched with nothing else happening, from
 * document_start.
 *
 * 2.5 s COVERS AN ENTRANCE AND ITS DELAY. Hero entrances in the wild run 300 ms
 * to 1200 ms and are commonly staggered behind a 200-600 ms hold; the fixture's
 * is 800 ms. A shorter window would report a page's entrance as a page's
 * ambient motion, because the tail would land in the next phase.
 */
const ENTRANCE_MS = 2_500;
/** A second window with no scroll and no pointer: whatever still moves, loops. */
const AMBIENT_MS = 1_500;
/** How many scroll positions the ramp holds at. */
const SCROLL_STEPS = 6;
/** After `scrollTo`, before reading: an rAF-driven transform lags by a frame. */
const SCROLL_SETTLE_MS = 80;
/**
 * How long the ramp dwells at each offset.
 *
 * THE DWELL IS WHAT MAKES STAGGER MEASURABLE. A reveal fires when the element
 * intersects; its siblings follow on the PAGE's schedule, not on this driver's.
 * Scrolling straight past would time the siblings against the scroll cadence —
 * a number about this file, not about the page.
 */
const REVEAL_DWELL_MS = 400;
/** After each hover, before the next: long enough for a 250-400 ms transition. */
const HOVER_SETTLE_MS = 250;
/** The reduced-motion probe's whole window. Entrance only; it never scrolls. */
const REDUCED_PROBE_MS = 1_500;
/** Settling after scrolling back to the top, before the hover phase begins. */
const SCROLL_HOME_SETTLE_MS = 200;

/** What a healthy capture costs in deliberate waiting. See MOTION_BUDGET_MS. */
export const MOTION_PHASE_MS =
  ENTRANCE_MS +
  AMBIENT_MS +
  SCROLL_STEPS * (SCROLL_SETTLE_MS + REVEAL_DWELL_MS) +
  SCROLL_HOME_SETTLE_MS +
  MAX_HOVER_TARGETS * HOVER_SETTLE_MS +
  REDUCED_PROBE_MS;

const VIEWPORT = { width: 1280, height: 900 } as const;

/* -------------------------------------------------------------------------
 * The injected sampler
 * ---------------------------------------------------------------------- */

/** What is watched. Validated against gsap.com; 21 movers found with this set. */
const TRACK_SELECTOR = "section,header,footer,nav,main,h1,h2,h3,div,p,span,a,button,li,img,svg";
/**
 * How many elements are tracked.
 *
 * A CEILING, NOT A TARGET. Reading two computed styles per element per frame is
 * the only expensive thing the sampler does, and a page with 4000 divs would
 * drop the frame rate far enough to corrupt the timings it is trying to measure.
 * 120 is what the spike ran at.
 */
const MAX_TRACKED_ELEMENTS = 120;
/** Stamped on tracked elements so the driver can hover one by id. */
const PROBE_ATTRIBUTE = "data-motion-probe";

/**
 * The in-page recorder, as source text.
 *
 * INSTALLED AT document_start, WHERE THERE IS NO DOM YET. That is why it cannot
 * simply query elements the way the validated spike did: at install time
 * `document.body` is null. It starts a rAF loop that RE-SCANS for new elements
 * every frame, so an element created by the page's own script is picked up from
 * the frame it appears in.
 *
 * IT STAMPS AN ATTRIBUTE ON EVERY TRACKED ELEMENT. That is a mutation of a page
 * this program did not write, and it is defensible only because the page is a
 * throwaway context that is closed seconds later. A page with a CSS rule keyed
 * on `[data-motion-probe]` would be measured wrongly; nothing else is affected.
 *
 * ONLY CHANGES ARE KEPT, not frames. 120 elements at 60 fps for ten seconds is
 * 72000 samples; storing the first and last change per element instead makes the
 * buffer constant-size and is all the normalizer needs.
 */
const SAMPLER_SOURCE = `
(() => {
  if (window.__motionProbe !== undefined) return;
  var SELECTOR = ${JSON.stringify(TRACK_SELECTOR)};
  var MAX_ELEMENTS = ${String(MAX_TRACKED_ELEMENTS)};
  var ATTRIBUTE = ${JSON.stringify(PROBE_ATTRIBUTE)};

  var nextId = 0;
  var records = new Map();
  var t0 = performance.now();

  var roleOf = function (el) {
    var tag = el.tagName.toLowerCase();
    var raw = typeof el.className === "string" ? el.className : "";
    var first = raw.trim().split(/\\s+/)[0] || "";
    // A generated class name ("css-1x2y3z4") is as volatile as a frame count and
    // must not enter a ticket id, but there is no way to tell one from a hand
    // written name here. The length cap and the shape test only keep it from
    // being a selector or a path.
    var cls = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(first) ? "." + first : "";
    return tag + cls;
  };

  var read = function (el) {
    var cs = getComputedStyle(el);
    return cs.transform + "|" + cs.opacity;
  };

  var scan = function () {
    if (!document.body) return;
    var els = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < els.length; i++) {
      if (records.size >= MAX_ELEMENTS) return;
      var el = els[i];
      if (records.has(el)) continue;
      var id = nextId++;
      try { el.setAttribute(ATTRIBUTE, String(id)); } catch (e) { /* svg in some engines */ }
      records.set(el, { id: id, el: el, role: roleOf(el), prev: read(el),
                        firstMs: null, lastMs: null, opacity: false, transform: false });
    }
  };

  var tick = function () {
    var t = performance.now() - t0;
    scan();
    records.forEach(function (rec) {
      var now = read(rec.el);
      if (now !== rec.prev) {
        var a = now.split("|");
        var b = rec.prev.split("|");
        if (a[0] !== b[0]) rec.transform = true;
        if (a[1] !== b[1]) rec.opacity = true;
        if (rec.firstMs === null) rec.firstMs = t;
        rec.lastMs = t;
        rec.prev = now;
      }
    });
    requestAnimationFrame(tick);
  };

  /*
   * A comma-separated CSS value list, split on the commas that SEPARATE and not
   * on the ones inside a function.
   *
   * MEASURED DEFECT, FOUND BY READING A REAL CAPTURE. A plain .split(",") on
   * "cubic-bezier(0.16, 1, 0.3, 1)" yields "cubic-bezier(0.16" as the first
   * value, which is not a curve any classifier recognises — the hero's easing
   * came back null for a hero whose easing the fixture declares outright.
   */
  var splitList = function (raw) {
    var s = String(raw || ""), out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    var trimmed = [];
    for (var j = 0; j < out.length; j++) {
      var v = out[j].trim();
      if (v.length > 0) trimmed.push(v);
    }
    return trimmed;
  };
  var msList = function (raw) {
    return splitList(raw).map(function (v) {
      var n = parseFloat(v);
      if (!isFinite(n)) return 0;
      return v.indexOf("ms") >= 0 ? n : n * 1000;
    });
  };
  var firstOf = function (raw) {
    var parts = splitList(raw);
    return parts.length === 0 ? null : parts[0];
  };

  /*
   * What the page DECLARES, where it declares anything.
   *
   * Preferred over the sampled span because it is exact and does not move
   * between two readings. Null for motion written from requestAnimationFrame,
   * which declares nothing — that is the case the sampled span exists for.
   * A declared duration of ZERO is returned as zero rather than as null: a
   * transition explicitly set to 0s is a state flip, and the normalizer drops it.
   */
  var declaredOf = function (cs) {
    if (cs.animationName && cs.animationName !== "none") {
      var d = msList(cs.animationDuration);
      return { ms: Math.round(Math.max.apply(null, d)),
               easing: firstOf(cs.animationTimingFunction),
               infinite: String(cs.animationIterationCount).indexOf("infinite") >= 0 };
    }
    var tr = msList(cs.transitionDuration);
    var max = tr.length === 0 ? 0 : Math.max.apply(null, tr);
    if (max > 0) {
      return { ms: Math.round(max), easing: firstOf(cs.transitionTimingFunction), infinite: false };
    }
    return null;
  };

  var tyOf = function (raw) {
    var value = String(raw || "none");
    if (value === "none") return 0;
    var open = value.indexOf("(");
    if (open < 0) return null;
    var nums = value.slice(open + 1, value.lastIndexOf(")")).split(",").map(function (n) {
      return parseFloat(n.trim());
    });
    if (value.indexOf("matrix3d") === 0) return nums.length > 13 ? nums[13] : null;
    if (value.indexOf("matrix") === 0) return nums.length > 5 ? nums[5] : null;
    return null;
  };

  window.__motionProbe = {
    /** Start a phase: forget every change so far and re-baseline. */
    begin: function () {
      scan();
      t0 = performance.now();
      records.forEach(function (rec) {
        rec.firstMs = null; rec.lastMs = null;
        rec.opacity = false; rec.transform = false;
        rec.prev = read(rec.el);
      });
      return records.size;
    },
    /** Everything that changed since the last begin(). */
    harvest: function () {
      scan();
      var out = [];
      records.forEach(function (rec) {
        if (rec.firstMs === null) return;
        var cs = getComputedStyle(rec.el);
        var d = declaredOf(cs);
        var props = [];
        if (rec.opacity) props.push("opacity");
        if (rec.transform) props.push("transform");
        out.push({ id: rec.id, role: rec.role, props: props,
                   firstMs: Math.round(rec.firstMs),
                   spanMs: Math.round(rec.lastMs - rec.firstMs),
                   declaredMs: d === null ? null : d.ms,
                   easing: d === null ? null : d.easing,
                   infinite: d === null ? false : d.infinite });
      });
      return out;
    },
    /** Vertical translation of every tracked element at the current scroll. */
    snapshot: function () {
      scan();
      var items = [];
      records.forEach(function (rec) {
        var ty = tyOf(getComputedStyle(rec.el).transform);
        if (ty !== null) items.push({ id: rec.id, role: rec.role, ty: ty });
      });
      return { scrollY: Math.round(window.scrollY), items: items };
    },
    /** How far this page can be scrolled, in CSS pixels. */
    scrollRange: function () {
      return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    },
    /** Ids of up to "limit" interactive elements currently on screen. */
    targets: function (limit) {
      scan();
      var out = [];
      records.forEach(function (rec) {
        if (out.length >= limit) return;
        var tag = rec.el.tagName.toLowerCase();
        var role = rec.el.getAttribute ? rec.el.getAttribute("role") : null;
        if (tag !== "a" && tag !== "button" && tag !== "summary" && role !== "button") return;
        var r = rec.el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        if (r.bottom < 0 || r.top > window.innerHeight) return;
        out.push(rec.id);
      });
      return out;
    },
    /*
     * Motion libraries, by the global each one leaves behind.
     *
     * A NAME HERE IS EVIDENCE THE LIBRARY IS LOADED, NOT THAT IT IS ANIMATING
     * ANYTHING. A site that ships GSAP in a bundle and never calls it is
     * reported as using GSAP. The brief says as much ("this names what the
     * reference used"), and the entries above are the claim about actual motion.
     */
    libraries: function () {
      var found = [];
      var w = window;
      var pairs = [["gsap", "gsap"], ["gsap", "TweenMax"], ["gsap-scrolltrigger", "ScrollTrigger"],
                   ["anime.js", "anime"], ["motion", "Motion"], ["lenis", "Lenis"], ["lenis", "lenis"],
                   ["locomotive-scroll", "LocomotiveScroll"], ["aos", "AOS"], ["swiper", "Swiper"],
                   ["three.js", "THREE"], ["lottie", "lottie"], ["lottie", "bodymovin"],
                   ["barba", "barba"], ["scrollreveal", "ScrollReveal"], ["velocity", "Velocity"],
                   ["splittype", "SplitType"], ["splitting", "Splitting"], ["rellax", "Rellax"]];
      for (var i = 0; i < pairs.length; i++) {
        try { if (w[pairs[i][1]] !== undefined && w[pairs[i][1]] !== null) found.push(pairs[i][0]); }
        catch (e) { /* a cross-origin getter */ }
      }
      var scripts = document.querySelectorAll("script[src]");
      var sniff = [["gsap", /gsap/i], ["framer-motion", /framer-motion|motion\\.dev/i],
                   ["lenis", /lenis/i], ["anime.js", /animejs|anime\\.min/i],
                   ["aos", /\\baos\\b/i], ["three.js", /three(\\.min)?\\.js/i]];
      for (var s = 0; s < scripts.length; s++) {
        var src = scripts[s].getAttribute("src") || "";
        for (var k = 0; k < sniff.length; k++) if (sniff[k][1].test(src)) found.push(sniff[k][0]);
      }
      return found.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
    }
  };

  requestAnimationFrame(tick);
})();
`;

/**
 * A stylesheet that stops CSS motion, injected at document_start.
 *
 * THIS EXISTS BECAUSE `reducedMotion: "reduce"` ON ITS OWN DOES NOTHING TO A
 * PAGE THAT IGNORES THE PREFERENCE, and that was measured rather than assumed.
 * The playwright context option sets the `prefers-reduced-motion` MEDIA FEATURE;
 * it does not disable anything. Against `test-fixtures/motion-fixture.html`,
 * which carries no `@media (prefers-reduced-motion: reduce)` block:
 *
 *     no-preference   98 distinct h1 states in 1.2 s
 *     reduce          96 distinct h1 states   <- unchanged, the page ignores it
 *     reduce + this   1 distinct h1 state
 *
 * The first run of `motion-capture.browser.test.ts`'s negative control with the
 * media feature alone reported 1 load-entrance entry where it expected 0.
 *
 * (`animations: "disabled"`, which the sealed scorer uses, is a SCREENSHOT
 * option in playwright, not a context one. There is no context-level switch, so
 * the suppression has to be written out like this.)
 *
 * IT CANNOT STOP EVERYTHING, AND THAT IS USEFUL. Motion written to an inline
 * style from `requestAnimationFrame` — the parallax in the fixture, and every
 * GSAP/ScrollTrigger effect in the wild — is untouched by any stylesheet. The
 * negative control relies on exactly that: the scroll-linked entry must still be
 * found, or "the probe returned nothing" could not be told apart from "the probe
 * is broken".
 */
const SUPPRESS_MOTION_SOURCE = `
(() => {
  if (window.__motionSuppressed === true) return;
  window.__motionSuppressed = true;
  var css = "*,*::before,*::after{" +
    "animation:none!important;animation-duration:0s!important;" +
    "transition:none!important;transition-duration:0s!important;" +
    "scroll-behavior:auto!important}";
  var install = function () {
    var style = document.createElement("style");
    style.textContent = css;
    var host = document.head || document.documentElement;
    if (host) host.appendChild(style);
  };
  install();
  // Installed twice on purpose: the first call lands before <head> exists on
  // some documents, where appending to <html> works but can be reordered by the
  // parser. A duplicated <style> costs nothing; a missed one fails the control.
  document.addEventListener("DOMContentLoaded", install, { once: true });
})();
`;

/* -------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------- */

export interface MotionCaptureOptions {
  /** Already refused-or-accepted by `captureTargetFor` in `site-capture.ts`. */
  readonly url: string;
  /** Injected in tests. Defaults to real chromium. */
  readonly launch?: LaunchMotionBrowser;
  readonly navigationTimeoutMs?: number;
  readonly now?: () => Date;
  /**
   * Suppress the page's motion and read it anyway.
   *
   * THIS EXISTS FOR THE NEGATIVE CONTROL and nothing else. A probe that cannot
   * report zero for a still page can only observe success.
   */
  readonly forceReducedMotion?: boolean;
}

/* -------------------------------------------------------------------------
 * The driver
 * ---------------------------------------------------------------------- */

const PLAYWRIGHT_MODULE: string = "playwright";

/**
 * Launch chromium through the hoisted playwright, or throw a sentence saying why
 * not. Same specifier-in-a-string trick, and the same reason, as
 * `site-capture.ts:284`.
 */
export function playwrightMotionLaunch(): LaunchMotionBrowser {
  return async () => {
    let mod: {
      chromium?: { launch(options: { headless: boolean; timeout: number }): Promise<MotionBrowser> };
    };
    try {
      mod = await import(PLAYWRIGHT_MODULE);
    } catch (error) {
      throw new Error(
        `playwright could not be loaded (${messageOf(error)}). Run \`npm install\` in dashboard/.`,
      );
    }
    const chromium = mod.chromium;
    if (chromium === undefined) {
      throw new Error("the resolved playwright module exports no `chromium` launcher");
    }
    return await chromium.launch({ headless: true, timeout: MOTION_LAUNCH_TIMEOUT_MS });
  };
}

/**
 * Read how one page moves. NEVER THROWS.
 *
 * Every failure — playwright missing, chromium refusing to start, a navigation
 * timeout, an `evaluate` that throws, a page that moves not at all — comes back
 * as `{ok: false, reason}` or as an `ok` reading with no observations. Those two
 * are different answers and the caller must not conflate them: the first means
 * nothing was read, the second means the page was read and does not move.
 */
export async function captureMotion(options: MotionCaptureOptions): Promise<MotionCaptureResult> {
  const launch = options.launch ?? playwrightMotionLaunch();
  const navigationTimeout = options.navigationTimeoutMs ?? MOTION_NAVIGATION_TIMEOUT_MS;
  const clock = options.now ?? (() => new Date());
  const suppressed = options.forceReducedMotion === true;

  let browser: MotionBrowser;
  try {
    browser = await launch();
  } catch (error) {
    return { ok: false, reason: `the browser could not be started: ${messageOf(error)}` };
  }

  try {
    const observations: RawObservation[] = [];
    let libraries: readonly string[] = [];

    const context = await browser.newContext({
      viewport: VIEWPORT,
      // THE DEFAULT IS "no-preference" AND THAT IS LOAD-BEARING. The sealed
      // scorer's own capture runs at "reduce" (scorer-container.ts:625) and
      // measures a still page; a reference read the same way would report every
      // site as motionless.
      reducedMotion: suppressed ? "reduce" : "no-preference",
    });
    try {
      await context.addInitScript(SAMPLER_SOURCE);
      // The media feature above is not enough on its own — see
      // SUPPRESS_MOTION_SOURCE for the measurement that says so.
      if (suppressed) await context.addInitScript(SUPPRESS_MOTION_SOURCE);
      const page = await context.newPage();
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: navigationTimeout });

      /* PHASE 1 — the entrance. The sampler has been running since
       * document_start, so this window began before the page's own scripts did.
       * Nothing is reset first: that is the whole point. */
      await page.waitForTimeout(ENTRANCE_MS);
      const entrance = await harvest(page);
      const infinite = new Set(entrance.filter((r) => r.infinite).map((r) => r.id));
      for (const record of entrance) {
        observations.push(
          toObservation(record, record.infinite ? "ambient-loop" : "load-entrance"),
        );
      }

      /* PHASE 2 — ambient. No scroll, no pointer; whatever still moves loops.
       * Elements already counted as an entrance are skipped, or a long entrance
       * whose tail lands here would be reported twice under two families. */
      const seen = new Set(entrance.map((r) => r.id));
      await beginPhase(page);
      await page.waitForTimeout(AMBIENT_MS);
      for (const record of await harvest(page)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        infinite.add(record.id);
        observations.push(toObservation(record, "ambient-loop"));
      }

      /* PHASE 3 — the scroll ramp. Two questions at once: which elements reveal
       * when they come into view, and which ones track the scroll position
       * itself. The second is the one `getAnimations()` cannot answer at all. */
      const range = asNumber(await page.evaluate("window.__motionProbe.scrollRange()")) ?? 0;
      const snapshots: ProbeSnapshot[] = [];
      const revealed: ProbeRecord[] = [];
      /*
       * ONE REVEAL PER ELEMENT, THE FIRST ONE — and this is a measured defect,
       * not a precaution. Each step re-baselines the sampler, so an element
       * whose 500 ms transition is still running when the next step begins is
       * harvested AGAIN with a `firstMs` near zero. Three cards revealing 120 ms
       * apart produced six observations, and `staggerFor`'s median gap over the
       * duplicated start times came out at 20 ms for a fixture that declares
       * 120. The duplicates say nothing the first record did not.
       */
      const revealedIds = new Set<number>();
      for (let step = 0; step < SCROLL_STEPS; step++) {
        const y = range === 0 ? 0 : Math.round((range * step) / (SCROLL_STEPS - 1));
        await beginPhase(page);
        await page.evaluate(`window.scrollTo(0, ${String(y)})`);
        await page.waitForTimeout(SCROLL_SETTLE_MS);
        const snapshot = await snap(page);
        await page.waitForTimeout(REVEAL_DWELL_MS);
        snapshots.push(snapshot);
        for (const record of await harvest(page)) {
          // `seen` already holds every element counted as an entrance or a loop,
          // and an `infinite.has()` test here as well was verified DEAD by
          // mutation: removing it changed no output, because everything in
          // `infinite` is also in `seen`. One guard that is exercised beats two
          // where only one is.
          if (seen.has(record.id) || revealedIds.has(record.id)) continue;
          revealedIds.add(record.id);
          revealed.push(record);
        }
      }

      const linked = scrollLinked(snapshots);
      for (const entry of linked) {
        observations.push({
          family: "scroll-linked",
          role: entry.role,
          props: ["transform"],
          // NOT A MEASUREMENT OF THE PAGE, and it must not be read as one. A
          // scroll-linked element has no duration — it is wherever the scroll
          // put it. Zero would be dropped by `normaliseMotion` as a state flip,
          // so the entry is given the smallest value that survives a 50 ms
          // bucket. The number that carries the information is `scrollRatio`.
          durationMs: SCROLL_LINKED_PLACEHOLDER_MS,
          firstChangeMs: 0,
          easing: "linear",
          iterations: 1,
          scrollRatio: entry.ratio,
        });
      }

      const linkedIds = new Set(linked.map((entry) => entry.id));
      for (const record of revealed) {
        // A parallax also "changed while the page was scrolled". It has already
        // been reported with the number that describes it — a px-per-px ratio —
        // and reporting it a second time as a reveal would put a meaningless
        // duration for it in front of the spec seat.
        if (linkedIds.has(record.id)) continue;
        seen.add(record.id);
        observations.push(toObservation(record, "scroll-reveal"));
      }

      /* PHASE 4 — hover. Back to the top first, so the elements offered are the
       * ones a visitor meets, and so the parallax has stopped moving before the
       * phase's baseline is taken. */
      await page.evaluate("window.scrollTo(0, 0)");
      await page.waitForTimeout(SCROLL_HOME_SETTLE_MS);
      const targets = asIdList(await page.evaluate(`window.__motionProbe.targets(${String(MAX_HOVER_TARGETS)})`));
      await beginPhase(page);
      for (const id of targets) {
        try {
          await page.hover(`[${PROBE_ATTRIBUTE}="${String(id)}"]`, { timeout: HOVER_TIMEOUT_MS });
        } catch {
          // A hover that cannot land — an element under a cookie banner, an
          // element that moved — is a normal outcome on a real page. The other
          // targets are still worth trying.
        }
        await page.waitForTimeout(HOVER_SETTLE_MS);
      }
      for (const record of await harvest(page)) {
        if (infinite.has(record.id) || linkedIds.has(record.id)) continue;
        observations.push(toObservation(record, "hover-focus"));
      }

      libraries = asStringList(await page.evaluate("window.__motionProbe.libraries()"));
    } finally {
      await closeQuietly(context);
    }

    /* PHASE 5 — does the page honour prefers-reduced-motion? A SECOND CONTEXT,
     * because `reducedMotion` cannot be changed on an open one. Asked only when
     * the main pass was not already suppressed. */
    const respectsReducedMotion = suppressed
      ? observations.every((o) => o.family === "scroll-linked")
      : await probeReducedMotion(browser, options.url, navigationTimeout);

    return {
      ok: true,
      reading: {
        url: options.url,
        capturedAt: clock().toISOString(),
        observations,
        libraries,
        respectsReducedMotion,
      },
    };
  } catch (error) {
    return { ok: false, reason: `the page's motion could not be read: ${messageOf(error)}` };
  } finally {
    try {
      await browser.close();
    } catch {
      /* a browser that fails to close must not turn a good capture into a bad one */
    }
  }
}

/**
 * One bucket, and a placeholder rather than a reading. See the call site.
 */
const SCROLL_LINKED_PLACEHOLDER_MS = 50;

/**
 * Open the page again with `prefers-reduced-motion: reduce` and see whether it
 * still moves.
 *
 * THE ANSWER IS ABOUT TIME-DRIVEN MOTION ONLY, because this probe never
 * scrolls: a page whose only remaining motion is scroll-linked would be reported
 * as honouring the preference by a probe that sat still. It watches the entrance
 * window and asks whether anything moved.
 *
 * A FAILURE HERE IS `false`, NOT A THROWN ERROR — and `false` is also what an
 * honest "it does not honour it" looks like, so the two are indistinguishable
 * downstream. That is the conservative direction: the brief then says the
 * reference does NOT honour the preference and that anything built from it still
 * must, which is safe advice either way.
 */
async function probeReducedMotion(
  browser: MotionBrowser,
  url: string,
  navigationTimeout: number,
): Promise<boolean> {
  let context: MotionContext;
  try {
    context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
  } catch {
    return false;
  }
  try {
    await context.addInitScript(SAMPLER_SOURCE);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
    await page.waitForTimeout(REDUCED_PROBE_MS);
    return (await harvest(page)).length === 0;
  } catch {
    return false;
  } finally {
    await closeQuietly(context);
  }
}

/* -------------------------------------------------------------------------
 * Reading what the sampler returns
 * ---------------------------------------------------------------------- */

interface ProbeRecord {
  readonly id: number;
  readonly role: string;
  readonly props: readonly string[];
  readonly firstMs: number;
  readonly spanMs: number;
  readonly declaredMs: number | null;
  readonly easing: string | null;
  readonly infinite: boolean;
}

interface ProbeSnapshot {
  readonly scrollY: number;
  readonly items: readonly { readonly id: number; readonly role: string; readonly ty: number }[];
}

/**
 * A record becomes an observation.
 *
 * THE DECLARED DURATION WINS WHERE THERE IS ONE. A sampled span is quantised to
 * the frame rate and drifts by a frame or two between readings; `0.8s` in a
 * stylesheet is exact and identical every time. The sampled span is the fallback
 * for rAF-driven motion, which declares nothing at all — the case this whole
 * module exists for. A DECLARED ZERO is kept as zero: an explicit
 * `transition: 0s` is a state flip and `normaliseMotion` drops it.
 */
function toObservation(record: ProbeRecord, family: MotionFamily): RawObservation {
  return {
    family,
    role: record.role,
    props: [...record.props],
    durationMs: record.declaredMs ?? record.spanMs,
    firstChangeMs: record.firstMs,
    easing: record.easing,
    // `null` means "repeats without end" to `motion-brief.ts`. Anything with a
    // declared iteration count that is not `infinite` is reported as 1: this
    // sampler cannot count repeats it did not watch begin.
    iterations: record.infinite ? null : 1,
    scrollRatio: null,
  };
}

/**
 * Which tracked elements move as a function of the scroll position.
 *
 * THE TEST IS CONSISTENCY, NOT MOVEMENT. An element that happens to animate
 * while the page is being scrolled moves too; what distinguishes a parallax is
 * that its offset is the SAME multiple of the scroll at every offset. So a ratio
 * is taken per step and the entry is kept only if every ratio agrees with the
 * median to within {@link SCROLL_RATIO_TOLERANCE}.
 *
 * THE MEDIAN IS REPORTED, not the mean: one step where the read landed a frame
 * early would otherwise pull the number the brief prints.
 */
const MIN_SCROLL_RATIO = 0.02;
const SCROLL_RATIO_TOLERANCE = 0.05;

function scrollLinked(
  snapshots: readonly ProbeSnapshot[],
): readonly { readonly id: number; readonly role: string; readonly ratio: number }[] {
  if (snapshots.length < 3) return [];
  const byId = new Map<number, { role: string; points: { y: number; ty: number }[] }>();
  for (const snapshot of snapshots) {
    for (const item of snapshot.items) {
      const entry = byId.get(item.id) ?? { role: item.role, points: [] };
      entry.points.push({ y: snapshot.scrollY, ty: item.ty });
      byId.set(item.id, entry);
    }
  }

  const found: { id: number; role: string; ratio: number }[] = [];
  for (const [id, entry] of byId) {
    if (entry.points.length < 3) continue;
    const ratios: number[] = [];
    for (let i = 1; i < entry.points.length; i++) {
      const previous = entry.points[i - 1];
      const current = entry.points[i];
      if (previous === undefined || current === undefined) continue;
      const dy = current.y - previous.y;
      if (Math.abs(dy) < 1) continue;
      ratios.push((current.ty - previous.ty) / dy);
    }
    if (ratios.length < 2) continue;
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (Math.abs(median) < MIN_SCROLL_RATIO) continue;
    if (!ratios.every((value) => Math.abs(value - median) <= SCROLL_RATIO_TOLERANCE)) continue;
    found.push({ id, role: entry.role, ratio: median });
  }
  return found;
}

async function beginPhase(page: MotionPage): Promise<void> {
  await page.evaluate("window.__motionProbe.begin()");
}

async function harvest(page: MotionPage): Promise<readonly ProbeRecord[]> {
  return asRecords(await page.evaluate("window.__motionProbe.harvest()"));
}

async function snap(page: MotionPage): Promise<ProbeSnapshot> {
  const raw = await page.evaluate("window.__motionProbe.snapshot()");
  if (!isRecordObject(raw)) return { scrollY: 0, items: [] };
  const items: { id: number; role: string; ty: number }[] = [];
  const rawItems = raw["items"];
  if (Array.isArray(rawItems)) {
    for (const item of rawItems) {
      if (!isRecordObject(item)) continue;
      const id = item["id"];
      const role = item["role"];
      const ty = item["ty"];
      if (typeof id !== "number" || typeof role !== "string" || typeof ty !== "number") continue;
      items.push({ id, role, ty });
    }
  }
  const scrollY = raw["scrollY"];
  return { scrollY: typeof scrollY === "number" ? scrollY : 0, items };
}

/*
 * EVERYTHING CROSSING THE BROWSER BOUNDARY IS `unknown` AND IS VALIDATED HERE.
 * `page.evaluate` returns whatever the page returned; TypeScript knows nothing
 * about it, and the seam tests inject fakes that can return anything at all. A
 * cast would move the failure from this file to whatever read the field.
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecords(value: unknown): readonly ProbeRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ProbeRecord[] = [];
  for (const item of value) {
    if (!isRecordObject(item)) continue;
    const id = item["id"];
    const role = item["role"];
    const firstMs = item["firstMs"];
    const spanMs = item["spanMs"];
    if (typeof id !== "number" || typeof role !== "string") continue;
    if (typeof firstMs !== "number" || typeof spanMs !== "number") continue;
    const declaredMs = item["declaredMs"];
    const easing = item["easing"];
    const props = item["props"];
    out.push({
      id,
      role,
      props: Array.isArray(props) ? props.filter((p): p is string => typeof p === "string") : [],
      firstMs,
      spanMs,
      declaredMs: typeof declaredMs === "number" ? declaredMs : null,
      easing: typeof easing === "string" ? easing : null,
      infinite: item["infinite"] === true,
    });
  }
  return out;
}

function asStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asIdList(value: unknown): readonly number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function closeQuietly(context: MotionContext): Promise<void> {
  try {
    await context.close();
  } catch {
    /* nothing to do about it, and nothing worth saying */
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
