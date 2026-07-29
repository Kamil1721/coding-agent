/**
 * video-legs.test.ts — the cost control of spec §7.6.3.2, watched at BOTH the
 * places it is enforced.
 *
 * EVERY CAP ASSERTION HERE COUNTS INVOCATIONS OR LEGS, never reads a number back
 * out of the object that produced it. A cap that is only ever read back is a
 * comment: `plan.cap === 2` is true under a planner that emitted five legs.
 *
 * The two seams are independent on purpose, so the mutation that kills one must
 * leave the other's test GREEN — otherwise there is one check wearing two names.
 * The observations are recorded in the Task 7 commit message.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { VideoCapability } from "./video-capability.js";
import {
  DEFAULT_VIDEO_LEG_CAP,
  MAX_VIDEO_LEG_CAP,
  planVideoLegs,
  renderVideoSpend,
  resolveLegCap,
  runVideoLegs,
  type VideoLeg,
  type VideoLegPlan,
} from "./video-legs.js";

const WS = "/ws";

/** One leg of a HAND-BUILT plan — the shape a caller that skipped the planner produces. */
function leg(index: number): VideoLeg {
  return {
    index,
    still: `/ws/design-refs/0${index}-sec.png`,
    section: `sec-${index}`,
    aspect: "16:9",
    out: `/ws/assets/world/leg-${index}.mp4`,
    poster: `/ws/assets/world/leg-${index}-poster.webp`,
  };
}

function cap(): VideoCapability {
  return {
    available: true,
    reason: "ok",
    scriptPath: "/home/u/.claude/scripts/gemini-video.sh",
    scriptSha256: "a".repeat(64),
    keySource: "GEMINI_API_KEY",
  };
}

function manifest(n: number, aspect = "16:9"): unknown {
  return {
    sections: Array.from({ length: n }, (_, i) => ({
      path: `/ws/design-refs/0${i + 1}-sec.png`,
      section: `sec-${i + 1}`,
      aspect,
      intent: "a leg of the world journey",
      animate: true,
    })),
  };
}

/** An invoker that records the order it was called in and always succeeds. */
function recorder(): { calls: number[]; invoke: (l: VideoLeg) => Promise<{ ok: boolean; detail: string }> } {
  const calls: number[] = [];
  return {
    calls,
    invoke: async (l) => {
      calls.push(l.index);
      return Promise.resolve({ ok: true, detail: "" });
    },
  };
}

// ── SEAM 1: the planner ───────────────────────────────────────────────────────

test("THE CAP IS 2 BY DEFAULT — five animate sections yield two legs", () => {
  const plan = planVideoLegs(manifest(5), WS, resolveLegCap({}));
  assert.equal(DEFAULT_VIDEO_LEG_CAP, 2);
  assert.equal(plan.legs.length, 2, "spec §7.6.3.2: at most 2 video legs per run, by default");
  assert.equal(plan.droppedByCap, 3, "and the drop is RECORDED, not silent");
  assert.deepEqual(
    plan.legs.map((l) => l.index),
    [1, 2],
  );
  assert.match(plan.legs[0]!.out, /leg-1\.mp4$/);
  assert.match(plan.legs[0]!.poster, /leg-1-poster\.webp$/);
});

// ── SEAM 2: where money is actually spent ─────────────────────────────────────

test("THE SPENDING SEAM CAPS TOO, even handed an over-long plan", async () => {
  // A cap that lives only in the planner is a cap in name only: any caller that
  // loops the manifest itself walks straight past it. This test hand-builds an
  // INCONSISTENT plan so the planner's clamp cannot mask the seam's.
  const overlong: VideoLegPlan = {
    legs: Array.from({ length: 5 }, (_, i) => leg(i + 1)),
    cap: 2,
    capSource: "default",
    droppedByCap: 0,
    rejected: [],
  };
  const { calls, invoke } = recorder();
  const summary = await runVideoLegs(overlong, invoke);
  assert.deepEqual(calls, [1, 2], "the invoker ran twice — this is where money is spent");
  assert.equal(summary.attempted, 2);
});

test("THE SEAM HAS AN ABSOLUTE CEILING — a hand-built plan does not get to set its own cap", async () => {
  // The test above only catches a plan that is inconsistent WITH ITSELF. A caller
  // that hand-builds twelve legs and writes `cap: 12` beside them is consistent,
  // and `slice(0, plan.cap)` waves it through — twelve metered calls, from a seam
  // whose whole reason for existing is "a future caller that builds a plan by
  // hand". The ceiling is the one number in this module that no caller supplies.
  const forged: VideoLegPlan = {
    legs: Array.from({ length: 12 }, (_, i) => leg(i + 1)),
    cap: 99,
    capSource: "default",
    droppedByCap: 0,
    rejected: [],
  };
  const { calls, invoke } = recorder();
  const summary = await runVideoLegs(forged, invoke);
  // The literal is pinned separately from the constant on purpose: asserting
  // `calls.length === MAX_VIDEO_LEG_CAP` alone is circular — it stays green when
  // someone raises the constant to 99, which is the change this test exists for.
  assert.equal(MAX_VIDEO_LEG_CAP, 8, "the ceiling, pinned as a literal so raising it is a visible diff");
  assert.equal(calls.length, 8, "eight invocations, not the ninety-nine the plan asked for");
  assert.equal(summary.attempted, 8);
});

test("THE LEGS RUN ONE AT A TIME — two metered calls in flight double the blast radius", async () => {
  const plan = planVideoLegs(manifest(2), WS, resolveLegCap({}));
  let inFlight = 0;
  let maxInFlight = 0;
  const summary = await runVideoLegs(plan, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // A REAL SUSPENSION POINT, AND IT IS THE WHOLE TEST. An invoker whose body
    // never yields runs to completion inside `Promise.all`'s map callback before
    // the next one is created, so `maxInFlight` is 1 under a parallel
    // implementation too and this check could only ever observe success.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    inFlight -= 1;
    return { ok: true, detail: "" };
  });
  assert.equal(maxInFlight, 1, "one leg in flight at a time: each call is minutes long and metered");
  assert.equal(summary.attempted, 2, "and both still ran — sequential, not skipped");
});

// ── the opt-in, and the record that explains it afterwards ───────────────────

test("raising the cap is an opt-in, and the opt-in is recorded", () => {
  const raised = resolveLegCap({ DASHBOARD_VIDEO_LEG_CAP: "3" });
  assert.deepEqual(raised, { cap: 3, capSource: "run-opt-in" });
  const plan = planVideoLegs(manifest(5), WS, raised);
  assert.equal(plan.legs.length, 3);
  assert.equal(plan.droppedByCap, 2, "the drop is recorded on the raised path too, not only the default one");
  assert.equal(
    renderVideoSpend({
      capability: cap(),
      plan,
      summary: { attempted: 3, produced: 3, failures: [] },
      model: "veo-3.1-generate-preview",
      resolution: "720p",
      durationSeconds: 4,
      timeoutSeconds: 900,
    }).capSource,
    "run-opt-in",
    "an unattended run must be explainable after the fact",
  );
});

test("a junk cap falls back to the default rather than to infinity — AND is not recorded as an opt-in", () => {
  // `cap >= 1 && cap <= 8` is not this assertion: it is green when a junk value
  // resolves to the CEILING. And the capSource half is a separate failure — a
  // junk value recorded as "run-opt-in" makes the run record claim a deliberate
  // raise that nobody made.
  for (const bad of ["", "0", "-1", "nine", "999999", "9", "  "]) {
    assert.deepEqual(
      resolveLegCap({ DASHBOARD_VIDEO_LEG_CAP: bad }),
      { cap: DEFAULT_VIDEO_LEG_CAP, capSource: "default" },
      `${JSON.stringify(bad)} must fall back to the default, and to "default" as the source`,
    );
  }
  assert.deepEqual(resolveLegCap({}), { cap: 2, capSource: "default" }, "an unset var is the default, not an opt-in");
  assert.deepEqual(resolveLegCap({ DASHBOARD_VIDEO_LEG_CAP: "8" }), { cap: 8, capSource: "run-opt-in" }, "8 is the ceiling and it is reachable");
});

// ── what the manifest is allowed to ask for ──────────────────────────────────

test("a non-Veo aspect is REJECTED with a reason, never silently resized", () => {
  // Spec §7.6.3.1: gemini-image.sh accepts 1:1..21:9; Veo does not. A section
  // marked animate at 1:1 is a DESIGN-lane mistake and must be reported back,
  // not quietly re-cropped into something the art direction did not choose.
  const plan = planVideoLegs(manifest(2, "1:1"), WS, resolveLegCap({}));
  assert.equal(plan.legs.length, 0);
  assert.equal(plan.rejected.length, 2);
  assert.match(plan.rejected[0]!.why, /16:9|9:16/);
  assert.equal(plan.rejected[0]!.section, "sec-1", "the reason is attached to the section a human can go fix");
});

test("a rejected section does not consume a leg NUMBER — leg-1.mp4 is the first leg that exists", () => {
  // Numbering from the manifest index instead of the surviving count would emit
  // leg-2.mp4 with no leg-1.mp4 beside it, and §7.6.4's consumption pattern
  // hard-codes leg-1 first. The cap counts survivors, so this also pins that a
  // rejected section is not quietly charged against the two legs a run is allowed.
  const mixed = {
    sections: [
      { path: "/ws/design-refs/01-sec.png", section: "sec-1", aspect: "1:1", intent: "i", animate: true },
      { path: "/ws/design-refs/02-sec.png", section: "sec-2", aspect: "16:9", intent: "i", animate: true },
      { path: "/ws/design-refs/03-sec.png", section: "sec-3", aspect: "9:16", intent: "i", animate: true },
    ],
  };
  const plan = planVideoLegs(mixed, WS, resolveLegCap({}));
  assert.equal(plan.legs.length, 2, "the 1:1 section was rejected, not counted against the cap");
  assert.equal(plan.legs[0]!.index, 1);
  assert.equal(plan.legs[0]!.still, "/ws/design-refs/02-sec.png", "leg-1 is the FIRST SURVIVOR, not the first section");
  assert.equal(plan.legs[0]!.aspect, "16:9");
  assert.equal(plan.legs[1]!.aspect, "9:16", "9:16 is legal too — the filter is not 16:9-only");
  assert.match(plan.legs[0]!.out, /leg-1\.mp4$/);
  assert.equal(plan.droppedByCap, 0);
});

test("a manifest with no animate flag yields no legs — Phase 2b writes that field", () => {
  const preV2b = { sections: [{ path: "/ws/design-refs/01.png", section: "hero", aspect: "16:9" }] };
  assert.equal(planVideoLegs(preV2b, WS, resolveLegCap({})).legs.length, 0);
  assert.equal(planVideoLegs(null, WS, resolveLegCap({})).legs.length, 0, "and junk is not a crash");
  assert.equal(planVideoLegs({ sections: "nope" }, WS, resolveLegCap({})).legs.length, 0);
  assert.equal(planVideoLegs("[]", WS, resolveLegCap({})).legs.length, 0, "an unparsed string is not a manifest");
});

test("a section marked animate with no still is rejected, not spawned against an empty path", () => {
  const noPath = { sections: [{ section: "hero", aspect: "16:9", animate: true }] };
  const plan = planVideoLegs(noPath, WS, resolveLegCap({}));
  assert.equal(plan.legs.length, 0);
  assert.match(plan.rejected[0]!.why, /path/);
});

// ── failure accounting ───────────────────────────────────────────────────────

test("a failing leg is recorded and does not abort the other one", async () => {
  const plan = planVideoLegs(manifest(2), WS, resolveLegCap({}));
  const s = await runVideoLegs(plan, async (l) =>
    l.index === 1 ? { ok: false, detail: "exit 4: truncated download" } : { ok: true, detail: "" },
  );
  assert.equal(s.attempted, 2);
  assert.equal(s.produced, 1);
  assert.match(s.failures[0]!, /truncated/);
  assert.match(s.failures[0]!, /leg-1/, "which leg, by the name that is on disk");
});

test("costUsd is null and no dollar figure is invented", () => {
  const record = renderVideoSpend({
    capability: cap(),
    plan: planVideoLegs(manifest(2), WS, resolveLegCap({})),
    summary: { attempted: 2, produced: 2, failures: [] },
    model: "veo-3.1-generate-preview",
    resolution: "720p",
    durationSeconds: 4,
    timeoutSeconds: 900,
  });
  assert.equal(record.costUsd, null, "spec §7.5: costUsd stays null; metered spend is its own line");
  assert.equal(record.meteredSeconds, 8, "2 legs × 4 s — UNITS, which are real");
  assert.ok(!JSON.stringify(record).includes("$"), "no invented price: the spec carries no price table");
});

test("meteredSeconds counts seconds DELIVERED, and legsAttempted is what shows the gap", () => {
  // A leg that failed at exit 4 — truncated download — was generated and billed,
  // and lands here as produced:0. The invoker carries no spend signal, so any
  // other number would be a guess dressed as a measurement, which is what
  // costUsd:null exists to prevent. The honest mitigation is that BOTH counts are
  // in the record: a reader who sees attempted 2 / produced 1 knows the delivered
  // figure is a floor. Pinned so nobody reads meteredSeconds as a bill.
  const record = renderVideoSpend({
    capability: cap(),
    plan: planVideoLegs(manifest(2), WS, resolveLegCap({})),
    summary: { attempted: 2, produced: 1, failures: ["leg-1 (sec-1): exit 4: truncated download"] },
    model: "veo-3.1-generate-preview",
    resolution: "720p",
    durationSeconds: 4,
    timeoutSeconds: 900,
  });
  assert.equal(record.legsAttempted, 2, "the attempt is visible beside the delivery");
  assert.equal(record.legsProduced, 1);
  assert.equal(record.meteredSeconds, 4, "delivered seconds — a FLOOR on what was billed, never a bill");
  assert.equal(record.failures.length, 1);
  assert.equal(record.timeoutSeconds, 900, "§6.2: the timeout that bounded the run is part of the record");
  assert.equal(record.cap, 2);
  assert.equal(record.capSource, "default");
  assert.equal(record.model, "veo-3.1-generate-preview");
  assert.equal(record.capability.scriptSha256, "a".repeat(64), "§6.2: the script outside the repo is recorded by hash");
});

test("THE KEY IS NOT IN THE SPEND RECORD — it is serialised to results/video.json", () => {
  // The capability object is embedded whole. video-capability.test.ts proves the
  // object itself is clean; this proves the embedding did not re-add anything.
  const KEY = "AIza-SENTINEL-NEVER-PRINT-1234567890";
  const record = renderVideoSpend({
    capability: cap(),
    plan: planVideoLegs(manifest(2), WS, resolveLegCap({})),
    summary: { attempted: 2, produced: 2, failures: [] },
    model: "veo-3.1-generate-preview",
    resolution: "720p",
    durationSeconds: 4,
    timeoutSeconds: 900,
  });
  assert.ok(!JSON.stringify(record).includes(KEY));
  assert.equal(record.capability.keySource, "GEMINI_API_KEY", "the SOURCE is what a reader needs");
});
