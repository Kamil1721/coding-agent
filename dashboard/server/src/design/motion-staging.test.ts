/**
 * motion-staging.test.ts — THIS FILE GUARDS A NON-CHANGE, AND THAT IS THE POINT.
 *
 * Spec §7.1a asks for the Layer-2 satisfier list to be gated on a capability
 * flag. Phase 2a shipped the staging by DISJUNCTION instead: `decideMotion`
 * already lists scroll-scrubbed video first and unconditionally, and a
 * disjunction cannot demand any one of its terms. See CONCERN 2 in the Phase 2c
 * plan for why implementing §7.1a's mechanism literally would be a REGRESSION —
 * a flag that gates a satisfier list can only ever REMOVE satisfiers, and with
 * capability=false it would fail a hand-authored scroll-scrubbed mp4, which is
 * exactly what the owner's own reference site ships.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ASSERTIONS BELOW ARE NOT THE ONES THE PLAN DRAFTED. Measured, this
 * session, by mutating the COMPILED `decideMotion` into the exact regression
 * this file exists to catch — a `capability = { video: false }` default
 * parameter gating the scroll-scrubbed-video branch — and re-running:
 *
 *   ✔ decideMotion takes no capability argument …            PASS
 *   ✔ the motion bar is satisfied by a video-free build …    PASS
 *   ✔ scroll-scrubbed video is already a satisfier …         PASS
 *   ℹ pass 3 · fail 0
 *
 * Three green tests over a live regression, for two independent reasons:
 *
 *   1. `Function.length` counts parameters BEFORE the first defaulted one, so
 *      `(files, capability = …)` still reports 1. Only a REQUIRED second
 *      parameter moves it. Hence the extra call below that passes a second
 *      argument and asserts the verdict does not budge.
 *   2. The drafted fixture drove `.currentTime` from inside
 *      `requestAnimationFrame`, so branch 3 — "rAF-driven element scrubbing" —
 *      satisfied it anyway and `kind: "satisfied"` never changed. The fixture
 *      here is rAF-free, and the assertion is on the SATISFIER STRING, so
 *      removing the video term is visible rather than absorbed by a sibling term.
 *
 * The hook test at the bottom is here because a satisfier list nothing calls is
 * not a gate: `antislop-hook.ts:393` is the production caller, it passes exactly
 * one argument, and it is what turns a verdict into `{ decision: "block" }`.
 * (Its failure mode is NOT a subset of `antislop-hook.test.ts`'s
 * allows-authored-motion test, which uses a rAF fixture with no video in it.)
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { HookJSONOutput, StopHookInput } from "@anthropic-ai/claude-agent-sdk";

import { makeMotionStopHook } from "../builders/antislop-hook.js";
import { decideMotion, type MotionVerdict, type WorkspaceFile } from "../builders/antislop-rules.js";

/**
 * A hand-authored scroll-scrubbed video and NOTHING ELSE — no
 * `requestAnimationFrame`, no GSAP, no `useScroll`. Every other satisfier in the
 * disjunction is absent on purpose: this workspace is satisfied by the video
 * term or it is not satisfied at all, which is what makes gating that term
 * observable here.
 *
 * It is also the shape the owner's own reference site ships, which is the whole
 * reason a `capability: false` flag over this list would be a regression rather
 * than a stricter bar.
 */
const SCRUBBED_VIDEO_ONLY: readonly WorkspaceFile[] = [
  { path: "/ws/index.html", text: "<video id='leg1' muted playsinline poster='leg-1-poster.webp'></video>" },
  {
    path: "/ws/world.js",
    text: "window.addEventListener('scroll', () => { video.currentTime = (window.scrollY / h) * 4; });",
  },
];

test("decideMotion takes no capability argument — the flag must never reach it", () => {
  assert.equal(decideMotion.length, 1, "one parameter: the workspace files, and nothing else");
});

test("a second argument changes nothing — a defaulted capability parameter is invisible to `length`", () => {
  // `Function.length` stops at the first defaulted parameter, so test 1 alone
  // would not see `(files, capability = { video: false })` land. This one calls
  // through the cast with a capability-shaped second argument that says NO, and
  // demands the same verdict.
  const asFlagged = decideMotion as unknown as (files: readonly WorkspaceFile[], capability: unknown) => MotionVerdict;
  const flagged = asFlagged(SCRUBBED_VIDEO_ONLY, { video: false, available: false });
  assert.equal(flagged.kind, "satisfied", "a capability-shaped argument may not remove a satisfier");
  assert.match((flagged as { satisfier: string }).satisfier, /scroll-scrubbed video/);
});

test("the motion bar is satisfied by a video-free build, and 2c does not change that", () => {
  const gsapOnly: readonly WorkspaceFile[] = [
    { path: "/ws/index.html", text: "<main id='app'></main>" },
    { path: "/ws/main.js", text: "gsap.timeline({ scrollTrigger: { trigger: '#app', scrub: true } })" },
  ];
  const verdict = decideMotion(gsapOnly);
  assert.equal(verdict.kind, "satisfied");
  assert.match(
    (verdict as { satisfier: string }).satisfier,
    /GSAP/,
    "satisfied BY THE GSAP TERM — `kind` alone cannot tell which term answered",
  );
});

test("scroll-scrubbed video is already a satisfier, so 2c adds nothing to the list", () => {
  const verdict = decideMotion(SCRUBBED_VIDEO_ONLY);
  assert.equal(verdict.kind, "satisfied");
  assert.match(
    (verdict as { satisfier: string }).satisfier,
    /scroll-scrubbed video/,
    "the VIDEO term answered — gating it on a capability flag turns this red",
  );
});

test("THE PRODUCTION CALLER: the Stop hook lets a hand-authored scrubbed video finish", async () => {
  // The list is only a gate through `makeMotionStopHook` -> `decideMotion(files)`
  // (antislop-hook.ts:393), which is where an `unsatisfied` verdict becomes
  // `{ decision: "block" }` and a build stops being allowed to declare done.
  // Gate the video term and this workspace — no rAF, no GSAP — starts getting
  // blocked for shipping the technique the reference site ships.
  const hook = makeMotionStopHook(async () => SCRUBBED_VIDEO_ONLY);
  const callback = hook.hooks[0];
  assert.ok(callback);
  const stop: StopHookInput = {
    hook_event_name: "Stop",
    session_id: "s-1",
    transcript_path: "/tmp/dash/runs/r1/transcript.jsonl",
    cwd: "/ws",
    stop_hook_active: false,
  } as StopHookInput;
  const answer = (await callback(stop, undefined, { signal: new AbortController().signal })) as HookJSONOutput & {
    continue?: boolean;
    decision?: string;
    reason?: string;
  };
  assert.equal(answer.continue, true, "not blocked");
  assert.equal(answer.decision, undefined, "and not blocked by the other spelling either");
});
