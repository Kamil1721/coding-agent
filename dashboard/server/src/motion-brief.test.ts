import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { MOTION_BLOCK_BEGIN, MOTION_BLOCK_END, motionBriefLines } from "./motion-brief.js";
import type { MotionEntry, MotionSpec } from "./motion-types.js";

const entry = (over: Partial<MotionEntry> = {}): MotionEntry => ({
  family: "scroll-reveal", role: "div.card", props: ["opacity", "transform"],
  durationMs: 500, staggerMs: 120, easing: "ease-out", iterations: 1,
  scrollRatio: null, parity: true, ...over,
});

const spec = (entries: readonly MotionEntry[]): MotionSpec => ({
  url: "https://example.com", capturedAt: "2026-08-04T00:00:00.000Z",
  entries, libraries: ["gsap"], respectsReducedMotion: true,
});

test("the block is delimited so ticketProse can strip it", () => {
  const lines = motionBriefLines(spec([entry()]));
  strictEqual(lines[0], MOTION_BLOCK_BEGIN);
  strictEqual(lines[lines.length - 1], MOTION_BLOCK_END);
});

test("a parity entry states its numbers", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  match(text, /500ms/);
  match(text, /120ms/);
  match(text, /opacity/);
});

test("a presence-only entry says what was NOT measured", () => {
  const text = motionBriefLines(spec([entry({ family: "canvas-ambient", parity: false })])).join("\n");
  match(text, /not compared/i);
});

test("NO PATH, NO FILENAME, NO ATTACHMENT SENTENCE ever reaches the brief", () => {
  // ticket-refs.ts:26-30 forbids these outright; a criterion written about an
  // artefact the spec seat cannot open grades green or red untraceably.
  const text = motionBriefLines(spec([entry({ role: "/Users/someone/thing.png" })])).join("\n");
  ok(!text.includes("/Users/"));
  ok(!/attach/i.test(text));
});

test("NO ABSOLUTE START TIME can appear, because the type carries none", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  ok(!/start(ed)? at/i.test(text));
});

test("an empty spec renders NOTHING rather than a heading over an empty list", () => {
  // The precedent is outlineLines' omit-an-empty-field rule (ticket-refs.ts:361).
  strictEqual(motionBriefLines(spec([])).length, 0);
});

test("the block names its own limits so the spec seat does not over-author", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  match(text, /automated reading/i);
});

test("reducedMotion is stated when the reference honours it", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  match(text, /reduced motion/i);
});

test("rendering is deterministic for the same spec", () => {
  const one = motionBriefLines(spec([entry(), entry({ role: "h1", family: "load-entrance" })]));
  const two = motionBriefLines(spec([entry(), entry({ role: "h1", family: "load-entrance" })]));
  strictEqual(one.join("\n"), two.join("\n"));
});
