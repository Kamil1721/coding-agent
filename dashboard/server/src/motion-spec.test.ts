import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { normaliseMotion } from "./motion-spec.js";
import type { MotionReading, RawObservation } from "./motion-types.js";

const obs = (over: Partial<RawObservation> = {}): RawObservation => ({
  family: "scroll-reveal", role: "div.card", props: ["opacity", "transform"],
  durationMs: 487, firstChangeMs: 200, easing: "ease-out", iterations: 1,
  scrollRatio: null, ...over,
});

const reading = (observations: readonly RawObservation[]): MotionReading => ({
  url: "https://example.com", capturedAt: "2026-08-04T00:00:00.000Z",
  observations, libraries: ["gsap"], respectsReducedMotion: false,
});

test("a duration is bucketed to 50ms, so 487 and 502 agree", () => {
  const a = normaliseMotion(reading([obs({ durationMs: 487 })]));
  const b = normaliseMotion(reading([obs({ durationMs: 502 })]));
  strictEqual(a.entries[0]?.durationMs, 500);
  deepStrictEqual(a.entries, b.entries);
});

test("THE MEASURED DEFECT: a drifting firstChangeMs cannot change the spec", () => {
  // Measured on gsap.com: the same element reported 200ms and 600ms across two
  // cold runs while its duration was identical both times. If this test fails,
  // every ticket re-mints its id on resubmission and re-authors the suite.
  const a = normaliseMotion(reading([obs({ firstChangeMs: 200 })]));
  const b = normaliseMotion(reading([obs({ firstChangeMs: 600 })]));
  strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test("stagger is DERIVED from sibling firstChange deltas, not from absolute time", () => {
  const spec = normaliseMotion(reading([
    obs({ role: "div.card", firstChangeMs: 100 }),
    obs({ role: "div.card", firstChangeMs: 218 }),
    obs({ role: "div.card", firstChangeMs: 340 }),
  ]));
  strictEqual(spec.entries[0]?.staggerMs, 120);
});

test("a lone role has no stagger rather than a stagger of zero", () => {
  const spec = normaliseMotion(reading([obs({ role: "h1" })]));
  strictEqual(spec.entries[0]?.staggerMs, null);
});

test("entries sort deterministically regardless of observation order", () => {
  const one = normaliseMotion(reading([obs({ role: "z.last" }), obs({ role: "a.first" })]));
  const two = normaliseMotion(reading([obs({ role: "a.first" }), obs({ role: "z.last" })]));
  deepStrictEqual(one.entries, two.entries);
});

test("presence-only families are marked parity:false", () => {
  const spec = normaliseMotion(reading([obs({ family: "canvas-ambient" }), obs({ family: "scroll-reveal" })]));
  const canvas = spec.entries.find((e) => e.family === "canvas-ambient");
  const reveal = spec.entries.find((e) => e.family === "scroll-reveal");
  strictEqual(canvas?.parity, false);
  strictEqual(reveal?.parity, true);
});

test("a 0ms change is a state flip, not motion, and is dropped", () => {
  const spec = normaliseMotion(reading([obs({ durationMs: 0 })]));
  strictEqual(spec.entries.length, 0);
});

test("easing collapses to a named family, so two cubic-beziers agree", () => {
  const a = normaliseMotion(reading([obs({ easing: "cubic-bezier(0.16, 1, 0.3, 1)" })]));
  const b = normaliseMotion(reading([obs({ easing: "cubic-bezier(0.17, 1, 0.29, 1)" })]));
  strictEqual(a.entries[0]?.easing, b.entries[0]?.easing);
});

test("a scroll ratio is rounded to two decimals", () => {
  const spec = normaliseMotion(reading([obs({ family: "scroll-linked", scrollRatio: 0.2537 })]));
  strictEqual(spec.entries[0]?.scrollRatio, 0.25);
});

test("NEGATIVE CONTROL: an empty reading produces an empty spec, not a fabricated one", () => {
  const spec = normaliseMotion(reading([]));
  strictEqual(spec.entries.length, 0);
  strictEqual(spec.libraries.length, 1);
});
