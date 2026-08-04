/**
 * motion-capture.browser.test.ts — REAL CHROMIUM, against a fixture on disk.
 *
 * THIS IS THE TEST `site-capture.ts` NEVER HAD. That file's own header says it
 * outright (`site-capture.ts:50-55`): nothing in it was ever run against a real
 * browser, every path is exercised against an injected fake, and "the fake here
 * satisfies the interface BY CONSTRUCTION, which is exactly the thing a fake
 * cannot check". `motion-capture.test.ts` is the equivalent seam suite for this
 * module; this file is the half that seam suite cannot supply.
 *
 * WHY A LOCAL FILE AND NOT A REAL SITE. A test that reaches gsap.com is a test
 * that fails when the network is down and re-fails when they redesign. The
 * fixture declares its own numbers in CSS — 800 ms hero, 500 ms cards 120 ms
 * apart, a 3000 ms infinite loop, a 250 ms hover, and a parallax at 0.25 px per
 * px — so an assertion here is against a number a human wrote, not against a
 * number a previous run of this same code produced.
 *
 * THE CONTROLS ARE TWO TESTS, NOT ONE, BECAUSE SUPPRESSION IS TWO MECHANISMS.
 * A probe that cannot report ZERO for a page that is not moving can only ever
 * observe success — break the sampler outright and the measuring tests look
 * exactly as they do now. So the second test asserts BOTH halves: no
 * time-driven motion AND the scroll-linked parallax still found, because
 * "returned nothing" and "was still looking and found nothing" are different
 * results and only the second one is a control.
 *
 * That test covers the INJECTED STYLESHEET and only that. It runs against
 * `motion-fixture.html`, which declares no `prefers-reduced-motion` block, so
 * the capture's `reducedMotion` CONTEXT OPTION is a measured no-op there. It was
 * proven no-op by mutation: replacing that option with an unconditional "reduce"
 * left all five of the tests below green. The LAST test in this file is the one
 * that covers the context option, against a second fixture that honours the
 * preference. Neither control substitutes for the other, and a change to either
 * mechanism should be checked against the test that names it.
 *
 * WHAT THIS FILE DOES NOT PROVE. It runs one chromium, on one machine, against
 * one hand-written page. It says nothing about a real site's motion being
 * legible, and nothing about the capture surviving a page that never stops
 * loading; `motion-capture.test.ts` owns the failure modes, and Task 9 of the
 * plan owns the real site.
 */

import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { captureMotion } from "./motion-capture.js";
import { normaliseMotion } from "./motion-spec.js";

/*
 * `import.meta.dirname` is `dashboard/server/<outDir>` at run time and `tsc`
 * only emits what `tsconfig.json`'s `include` names — `src/**\/*.ts`. An .html
 * file is therefore NEVER copied into the build directory, so the fixture has to
 * be read out of `src`. This is the same one-level-up idiom, and the same
 * reason, as `contract-parity.test.ts:50` and `messages.test.ts:49`.
 */
const FIXTURE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "src", "test-fixtures", "motion-fixture.html"),
).href;

/**
 * The page that HONOURS `prefers-reduced-motion`, and why it is a second file.
 *
 * `motion-fixture.html` carries no `@media (prefers-reduced-motion: reduce)`
 * block, and that absence is a recorded MEASUREMENT rather than an oversight:
 * `SUPPRESS_MOTION_SOURCE`'s docblock and the negative control below both quote
 * the 98-vs-96 h1-state reading taken against it. Adding a media block there
 * would falsify two written measurements and would leave the negative control
 * with both suppression mechanisms firing at once — the exact confusion that let
 * the context option go untested.
 */
const HONOURING_FIXTURE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "src", "test-fixtures", "motion-fixture-reduced.html"),
).href;

test("REAL CHROMIUM: the declared 800ms hero entrance is measured within a bucket", async () => {
  // Measured this session with the validated spike: host 796 ms, sealed
  // container 799 ms, against a declared 800 ms. The driver prefers the
  // DECLARED `animation-duration` where the computed style states one, so this
  // is exact rather than 796-rounding-to-800 by luck; the sampled span is the
  // fallback for rAF-driven motion, which declares nothing.
  const result = await captureMotion({ url: FIXTURE_URL });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  const hero = spec.entries.find((e) => e.family === "load-entrance" && e.role.startsWith("h1"));
  strictEqual(hero?.durationMs, 800);
});

test("REAL CHROMIUM: a page with animations disabled reports NO motion", async () => {
  // THE NEGATIVE CONTROL. The sealed scorer's existing capture runs
  // reducedMotion:"reduce" + animations:"disabled" (scorer-container.ts:625,674)
  // and measures exactly zero. A probe that cannot return zero when there IS
  // none is a probe that can only observe success.
  //
  // MEASURED, AND IT IS WHY `forceReducedMotion` DOES TWO THINGS: this fixture
  // carries no `prefers-reduced-motion` block, so the media feature alone
  // changes nothing about it — 96 distinct h1 states in 1.2 s under
  // reducedMotion:"reduce" against 98 under "no-preference". Only the injected
  // stylesheet stills it (1 state).
  const result = await captureMotion({ url: FIXTURE_URL, forceReducedMotion: true });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  // EVERY TIME-DRIVEN FAMILY THIS DRIVER CAN PRODUCE, named one by one rather
  // than asserted as a total, so a family that starts surviving suppression is
  // pointed at instead of hidden inside a count.
  strictEqual(spec.entries.filter((e) => e.family === "load-entrance").length, 0);
  strictEqual(spec.entries.filter((e) => e.family === "ambient-loop").length, 0);
  strictEqual(spec.entries.filter((e) => e.family === "scroll-reveal").length, 0);
  strictEqual(spec.entries.filter((e) => e.family === "hover-focus").length, 0);

  /*
   * WHAT IS ACTUALLY DOING THE WORK HERE, because it is not only the stylesheet.
   * Measured on the suppressed page, the RAW observation list is not empty — it
   * holds a load-entrance, three scroll-reveals and a hover-focus, every one of
   * them with `durationMs: 0`. Suppression does not stop the class flips; it
   * removes their duration, and `normaliseMotion`'s MIN_DURATION_MS rule ("a 0ms
   * change is a state flip, not motion") is what drops them. So this control
   * spans two modules, and a change to that rule in `motion-spec.ts` would
   * redden this test in `motion-capture.ts`. That coupling is real and is better
   * written down than discovered.
   */
  ok(
    result.reading.observations.some((o) => o.durationMs === 0),
    "the flips still happened and were still recorded; it is their duration that went",
  );

  // AND THE PROBE WAS STILL LOOKING. The parallax is written to an inline style
  // from requestAnimationFrame, so no stylesheet can stop it and a working
  // sampler still finds it. Without this half, a sampler that returned an empty
  // array for any reason at all would pass the assertions above.
  ok(
    spec.entries.some((e) => e.family === "scroll-linked"),
    "the suppressed page still moves with the scroll, and a live probe still sees it",
  );
});

test("REAL CHROMIUM: two captures of the same page produce an IDENTICAL spec", async () => {
  // The determinism gate. If this fails, every resubmission of the same ticket
  // mints a new id and re-authors the acceptance suite on the owner's quota.
  // This is also what calibrates STAGGER_BUCKET_MS.
  const a = await captureMotion({ url: FIXTURE_URL });
  const b = await captureMotion({ url: FIXTURE_URL });
  ok(a.ok && b.ok);
  const one = normaliseMotion(a.reading);
  const two = normaliseMotion(b.reading);
  strictEqual(
    JSON.stringify({ ...one, capturedAt: "" }),
    JSON.stringify({ ...two, capturedAt: "" }));
});

test("REAL CHROMIUM: the declared 120ms sibling stagger survives quantization", async () => {
  /*
   * NOT IN THE PLAN'S FOUR, AND ADDED BECAUSE THE PLAN ASKS FOR
   * STAGGER_BUCKET_MS TO BE CALIBRATED HERE. Nothing else in this file reads
   * `staggerMs`, and a capture that reported the wrong stagger passed all four
   * of the tests above — it did, on the first real run: the three cards were
   * harvested twice each, once mid-transition at the following scroll step, and
   * the median gap over the six duplicated start times came out at 20 ms
   * against a fixture that declares 120.
   *
   * THE CALIBRATION, MEASURED OVER FOUR CONSECUTIVE CAPTURES. Raw sibling start
   * times were [18,135,252], [20,136,252], [24,140,257], [26,143,268] ms, so the
   * median gap ranged 116-125 ms against a declared 120 — the shortfall is the
   * frame the sampler needs to notice each flip. STAGGER_BUCKET_MS is 20, whose
   * boundaries here are 110 and 130, so the measured range sits inside one
   * bucket with about 5 ms of headroom on the upper side. That headroom is thin
   * and is the number to re-measure if this ever flaps.
   *
   * WIDENING THE BUCKET WOULD MAKE THIS WORSE, WHICH IS WHY IT WAS NOT DONE. At
   * STAGGER_BUCKET_MS = 50 the boundary falls at 125 — exactly where run four
   * landed — and the same four captures would have reported 100 ms and 150 ms.
   * If this assertion starts flapping, the fix is a finer measurement, not a
   * coarser bucket, and never a loosened assertion.
   */
  const result = await captureMotion({ url: FIXTURE_URL });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  const cards = spec.entries.find((e) => e.family === "scroll-reveal" && e.role === "div.card");
  strictEqual(cards?.durationMs, 500);
  strictEqual(cards?.staggerMs, 120);
});

test("REAL CHROMIUM: scroll-linked motion is told apart from time-driven motion", async () => {
  // getAnimations() reports NOTHING for this — measured on gsap.com: 0 running
  // animations at every one of six scroll offsets. It is found only by sampling
  // the computed transform against the scroll position.
  const result = await captureMotion({ url: FIXTURE_URL });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  const parallax = spec.entries.find((e) => e.family === "scroll-linked");
  strictEqual(parallax?.scrollRatio, 0.25);
});

test("REAL CHROMIUM: a page that HONOURS reduced motion is still read as moving", async () => {
  /*
   * THE CONTROL FOR THE CONTEXT OPTION, WHICH THE ONE ABOVE DOES NOT PROVIDE.
   *
   * An adversarial reviewer replaced `captureMotion`'s context option
   *
   *     reducedMotion: suppressed ? "reduce" : "no-preference"
   *
   * with an unconditional "reduce", and all five tests above stayed green:
   * `motion-fixture.html` ignores the preference, so playwright's media feature
   * is a no-op against it and the negative control was only ever exercising the
   * injected stylesheet. PRODUCTION CONSEQUENCE HAD IT REGRESSED: `POST
   * /api/runs` is the only caller and never sets `forceReducedMotion`, so every
   * reference site that does honour the preference would have been captured
   * motionless and no test would have gone red.
   *
   * TWO ASSERTIONS, TWO DIFFERENT MUTATIONS, AND NEITHER ONE IS SUFFICIENT.
   * Both mutations were RUN, not reasoned about, and each reddened this test on a
   * different line while the other five stayed green:
   *
   *   the 800ms hero entry     kills the MAIN context's option. Replacing it with
   *                            an unconditional "reduce" stills this page and
   *                            there is no `load-entrance` to find:
   *                            `undefined !== 800`. It says NOTHING about
   *                            `probeReducedMotion`, which opens its own context
   *                            with its own hardcoded value — under that mutation
   *                            `respectsReducedMotion` was still `true`, so this
   *                            assertion alone is what caught it.
   *
   *   respectsReducedMotion    kills `probeReducedMotion`'s hardcoded "reduce".
   *                            Flipping that one to "no-preference" left the hero
   *                            assertion GREEN and reddened this one instead:
   *                            `false !== true`. It is also what proves the
   *                            fixture's @media block parses at all — without it a
   *                            typo'd media query would pass the hero assertion
   *                            and the first mutation would stop reddening.
   *
   * WHAT NEITHER ASSERTION COVERS: the injected `SUPPRESS_MOTION_SOURCE`
   * stylesheet, which this test never turns on. The negative control above owns
   * that mechanism and owns nothing here.
   *
   * WHY THE HERO NUMBER AND NOT A NON-EMPTY COUNT: 800ms is declared in the
   * fixture's stylesheet by a human, so this stays an assertion against a written
   * number rather than against whatever a previous run produced.
   */
  const result = await captureMotion({ url: HONOURING_FIXTURE_URL });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  const hero = spec.entries.find((e) => e.family === "load-entrance" && e.role.startsWith("h1"));
  strictEqual(
    hero?.durationMs,
    800,
    "the default capture must read a honouring page at no-preference, or it reports every such reference as motionless",
  );
  strictEqual(
    result.reading.respectsReducedMotion,
    true,
    "this fixture's @media block is the point of the file; a false here means the preference never reached the page",
  );
});
