/**
 * plan-seat.wiring.test.ts — did the owner's pictures actually reach the seat?
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `plan-seat.test.ts`. That file proves the
 * MESSAGE is right: given images, the prompt says they are in it and the blocks
 * are in it. It cannot prove that a RUN ever produces any, because it never runs
 * one — it hands the images to the composer itself. So on its own it is the shape
 * of check this repository has shipped green over features that did nothing: the
 * orchestrator could pass an empty list forever and every assertion there would
 * still hold.
 *
 * WHAT THIS DRIVES IS THE WHOLE `#execute`, for the reason `plan-phase.test.ts`
 * gives: a test that reached into `#planSeat` would prove the body and say
 * nothing about whether the run still calls it. A run is submitted with a
 * reference manifest on disk, `pump()` is called, and what is asserted is what
 * the RUN handed to the seat and what it wrote into its own log.
 *
 * NO QUOTA IS SPENT, GUARDED THE SAME TWO WAYS `plan-phase.test.ts` states: the
 * planning seat is injected (`OrchestratorDeps.makePlanSeat`), and the harness
 * env is `{}` so the non-injectable spec seat cannot reach a CLI and the run dies
 * there — which is not what is under test.
 *
 * ─── THE ONE THING NO TEST CAN WATCH, NAMED RATHER THAN IMPLIED ───
 *
 * `#planSeat`'s REAL branch constructs a `SubscriptionSeatCaller` with
 * `images`, and constructing one spawns the CLI, so no unit test can watch that
 * single argument go missing. The guard for it is structural instead of
 * behavioural and is recorded on the line itself: the prompt's image counts are
 * read back off `caller.imagePlan`, the same value `seatPrompt` puts on the wire,
 * so deleting the argument makes the prompt claim nothing rather than lie. What
 * THIS file covers is everything before that: the manifest is read, the bytes
 * become blocks, the refusals are named, on both the opening turn and the
 * follow-ups.
 *
 * ─── MUTATIONS, EACH APPLIED ALONE, WATCHED RED, RESTORED (2026-08-02) ───
 *
 * The count after each is what went red IN THIS FILE, which has three tests.
 *
 *  M1  orchestrator.ts `#planSeat` reads `seatImagesFor([])` instead of the run's
 *      manifest                                                          → 2 red
 *      (no block reaches the seat, and the follow-up carries none either; the
 *      no-references control stayed GREEN, which is what makes it a control)
 *  M2  orchestrator.ts `#reportSeatImages` returns before emitting        → 1 red
 *      ("timed out waiting for the image log line" — the run dropped one of the
 *      owner's pictures and its log never said so)
 *  M3  orchestrator.ts `#planFollowUp` passes `{carried: 0, missing: 0}`  → 1 red
 *      (the blocks ride the turn and the prompt does not mention them)
 *
 * AND FIVE OF THE SIX `plan-seat.ts` MUTATIONS LISTED IN `plan-seat.test.ts` REACH
 * THIS FILE TOO: M4, M5 and M8 turn one test here red, M6 turns two red, and M9
 * (the empty-state guard) turns the no-references control red. That overlap is
 * the point — the prompt and the wiring are checked against the same real run,
 * not against each other.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SeatCallRequest, SeatCallResult } from "bakeoff/dist/anthropic-seat.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { ModelCatalog } from "./models.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import { Orchestrator } from "./orchestrator.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import type { PlanSeatCaller } from "./plan-seat.js";
import { referenceDirFor, writeReferenceManifest } from "./ticket-refs.js";
import { ticketFromText } from "./ticket.js";
import type { SeatDocument, SeatImage } from "./subscription-caller.js";

/* -------------------------------------------------------------------------
 * The harness — the shape `plan-phase.test.ts` uses, minus what is not needed
 * ---------------------------------------------------------------------- */

/** What the host handed the seat factory. The whole point of the seam. */
interface SeatHandover {
  readonly runId: string;
  readonly documents: readonly SeatDocument[];
  readonly images: readonly SeatImage[];
}

function seatResult(text: string): SeatCallResult {
  return {
    text,
    stopReason: "end_turn",
    usage: {
      provider: "anthropic",
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 50,
      costUsd: 0,
      modelId: "claude-opus-5",
      role: "spec",
      effort: "high",
      callCount: 1,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      thinkingTokens: null,
    },
    pricingBasis: {
      provider: "anthropic",
      modelId: "claude-opus-5",
      priceLabel: "subscription",
      priceEffectiveFrom: "2026-08-02",
      priceEffectiveUntil: null,
      pricedAt: "2026-08-02T10:00:00.000Z",
      fieldStatus: {
        input: "unverified",
        cacheRead: "unverified",
        cacheWrite5m: "unverified",
        cacheWrite1h: "unverified",
        output: "unverified",
      },
      assumedFields: [],
      assumedCacheWriteMultiplier: null,
      sourcedOn: "2026-08-02",
      source: "test stub",
    },
    precall: {
      allowed: true,
      killReason: null,
      cumulativeCostUsd: 0,
      ceilingUsd: 0,
      worstCaseNextCallUsd: 0,
      checkedAt: "2026-08-02T10:00:00.000Z",
    },
    inputEstimateMeasured: false,
    startedAt: "2026-08-02T10:00:00.000Z",
    endedAt: "2026-08-02T10:00:01.000Z",
  };
}

/**
 * A seat that records BOTH halves of the seam: what it was constructed with, and
 * what it was asked.
 *
 * THE CURSOR IS SHARED ACROSS EVERY CALLER THIS FACTORY MAKES, the trap
 * `plan-phase.test.ts` recorded: the host builds a fresh caller per turn, so a
 * cursor held inside one caller would restart at zero on the follow-up and answer
 * the second turn with the first turn's script.
 */
function scriptedSeats(
  script: readonly string[],
  handovers: SeatHandover[],
  seen: SeatCallRequest[],
): (options: SeatHandover & { readonly signal: AbortSignal }) => PlanSeatCaller {
  let index = 0;
  return (options) => {
    handovers.push({ runId: options.runId, documents: options.documents, images: options.images });
    return {
      call(request: SeatCallRequest): Promise<SeatCallResult> {
        seen.push(request);
        const text = script[Math.min(index, script.length - 1)] ?? "{}";
        index += 1;
        return Promise.resolve(seatResult(text));
      },
    };
  };
}

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: Orchestrator;
  readonly runsRoot: string;
  readonly handovers: readonly SeatHandover[];
  readonly seatCalls: readonly SeatCallRequest[];
  settle(): Promise<void>;
  cleanup(): void;
}

function harness(script: readonly string[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dash-seat-images-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(dir, "absent"), codexBin: join(dir, "absent") });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const preview = new PreviewHost();
  const handovers: SeatHandover[] = [];
  const seatCalls: SeatCallRequest[] = [];
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview,
    // `{}` IS THE SPEC-SEAT GUARD, not an oversight.
    env: {},
    gateReadiness: READY_GATE_READINESS,
    makePlanSeat: scriptedSeats(script, handovers, seatCalls),
  });
  return {
    store,
    orchestrator,
    runsRoot: paths.runs,
    handovers,
    seatCalls,
    settle: async () => {
      await orchestrator.shutdown();
      await waitFor(() => orchestrator.activeRunIds.length === 0, "the run to stop executing", 30_000);
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(store: RunStore, runId: string): void {
  const text = "Build me a portfolio site from the boards I attached.";
  const ticket = ticketFromText(text);
  store.createRun({
    runId,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    ticketText: text,
    ticketSha256: ticket.sha256,
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    interactive: true,
  });
}

/**
 * One real image on disk and one path that names nothing.
 *
 * THE SECOND IS NOT PADDING. "A dropped image is named in the run log" is the
 * requirement that keeps a seat which saw half the design from looking like one
 * that saw all of it, and it is unobservable unless a run actually drops one. An
 * absent file is the cheapest of the five refusals to stage — the alternative is
 * writing a 4 MB fixture to exercise the per-image cap, which
 * `subscription-caller.images.test.ts` already covers at that level.
 *
 * THE BYTES ARE NOT A REAL PNG and nothing here decodes them: the media type
 * comes from the intake-chosen extension (`IMAGE_MEDIA_TYPES`), and the API's
 * rejection of mislabelled bytes is a live concern this level cannot reach.
 */
function seedReferences(runsRoot: string, runId: string): { readonly present: string; readonly absent: string } {
  const dir = referenceDirFor(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  const present = join(dir, "reference-1.png");
  const absent = join(dir, "reference-2.png");
  writeFileSync(present, Buffer.from("not really a PNG, and nothing here decodes it"));
  writeReferenceManifest(dir, {
    images: [
      { path: present, sha256: "a".repeat(64), bytes: 45 },
      { path: absent, sha256: "b".repeat(64), bytes: 90 },
    ],
    capture: null,
    documents: [],
  });
  return { present, absent };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function logText(store: RunStore, runId: string): string {
  return store
    .eventsSince(runId, 0)
    .map((entry) => (entry.event.type === "log" ? entry.event.text : ""))
    .join(" | ");
}

const NO_QUESTIONS = JSON.stringify({
  plan: ["A portfolio, built to the boards.", "Nothing is unclear."],
  questions: [],
});

const ONE_QUESTION = JSON.stringify({
  plan: ["A portfolio, built to the boards."],
  questions: [
    {
      text: "The two boards disagree on the nav — is it the fixed top bar or the side rail?",
      ifUnanswered: "the fixed top bar",
      criterionIfDefault: "The nav is a bar fixed to the top of the viewport on scroll.",
      criterionIfAnswered: "The nav is a vertical rail down the left edge.",
      tier: "FUNCTIONAL",
    },
  ],
});

const RESOLVES = JSON.stringify({
  reply: "",
  resolved: [{ id: "PQ-1", kind: "answer", answer: "the side rail", quoted: "side rail" }],
});

/* -------------------------------------------------------------------------
 * The opening turn
 * ---------------------------------------------------------------------- */

test("A RUN'S REFERENCE IMAGES REACH THE PLANNING SEAT AS BLOCKS, and the refused one is named", async () => {
  const h = harness([NO_QUESTIONS]);
  try {
    seed(h.store, "run-images");
    const files = seedReferences(h.runsRoot, "run-images");
    h.orchestrator.pump();
    await waitFor(() => h.seatCalls.length > 0, "the opening turn");

    // 1. THE HOST READ THE MANIFEST AND TURNED IT INTO CONTENT. Not a path, not a
    // count: the bytes of the file the owner attached, base64, with the media
    // type recovered from the intake's extension.
    const handover = h.handovers[0];
    assert.ok(handover !== undefined, "the seat was constructed");
    assert.equal(handover.images.length, 2, "both attachments are accounted for, carried or not");

    const carried = handover.images.filter((image) => image.block !== null);
    assert.equal(carried.length, 1);
    assert.equal(carried[0]?.block?.source.media_type, "image/png");
    assert.equal(carried[0]?.block?.source.type, "base64");
    assert.ok((carried[0]?.block?.source.data.length ?? 0) > 0, "the picture's own bytes");
    assert.equal(carried[0]?.label, "reference-1.png");
    assert.ok(!(carried[0]?.label ?? "/").includes("/"), "a label, never a host path");

    const refused = handover.images.filter((image) => image.block === null);
    assert.equal(refused.length, 1);
    assert.match(String(refused[0]?.declined), /ENOENT/);
    assert.ok(!String(refused[0]?.declined).includes(files.absent), "the reason carries no host path");

    // 2. THE PROMPT SAYS WHAT THE MESSAGE HOLDS. One carried, one not — the state
    // the old two-branch prompt could not express.
    const opening = String(h.seatCalls[0]?.userTurns[0]);
    assert.match(opening, /ATTACHED 1 REFERENCE IMAGE\(S\) AND THEY ARE IN THIS MESSAGE/);
    assert.match(opening, /LOOK AT THEM/);
    assert.match(opening, /1 MORE WERE ATTACHED AND ARE NOT HERE/);
    assert.ok(!opening.includes("YOU CANNOT OPEN THEM"), "the behaviour the owner ruled out is gone");
    assert.ok(!opening.includes(files.present), "no host path reaches a seat that has no tools");

    // 3. THE RUN LOG NAMES THE ONE THAT DID NOT TRAVEL. A seat that saw half the
    // design and does not say so is worse than one that saw none, and after the
    // run this line is the only place the difference survives.
    await waitFor(() => logText(h.store, "run-images").includes("attached image(s)"), "the image log line");
    const log = logText(h.store, "run-images");
    assert.match(log, /reference-2\.png: its bytes could not be read off disk \(ENOENT\)/);
    assert.match(log, /1 image block\(s\) in order \(reference-1\.png\)/);
  } finally {
    await h.settle();
    h.cleanup();
  }
});

test("A RUN WITH NO REFERENCE IMAGES HANDS OVER NOTHING AND SAYS NOTHING", async () => {
  /*
   * THE CONTROL FOR THE TEST ABOVE. Without it, an orchestrator that attached a
   * phantom image to every run — or a prompt that always claimed one — would pass
   * everything else in this file.
   */
  const h = harness([NO_QUESTIONS]);
  try {
    seed(h.store, "run-bare");
    h.orchestrator.pump();
    await waitFor(() => h.seatCalls.length > 0, "the opening turn");

    assert.deepEqual(h.handovers[0]?.images, [], "nothing attached, nothing carried");
    const opening = String(h.seatCalls[0]?.userTurns[0]);
    assert.ok(!opening.includes("REFERENCE IMAGE"), "the prompt is the pre-image prompt");
    assert.ok(!logText(h.store, "run-bare").includes("attached image(s)"), "and the log is silent");
  } finally {
    await h.settle();
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * The follow-up turns
 * ---------------------------------------------------------------------- */

test("THE FOLLOW-UP TURN CARRIES THE PICTURES TOO, and is told so", async () => {
  /*
   * A CALL CARRIES NO MEMORY OF THE LAST ONE, so the blocks are re-sent per turn
   * — the host builds a fresh caller for every owner message. The failure this
   * watches for is the cheap one: the images ride along and the follow-up prompt
   * forgets to say so, leaving the seat to write the owner's answer down with the
   * design in front of it and no reason to look.
   */
  const h = harness([ONE_QUESTION, RESOLVES]);
  try {
    seed(h.store, "run-turns");
    seedReferences(h.runsRoot, "run-turns");
    h.orchestrator.pump();
    await waitFor(() => h.store.getRun("run-turns")?.status === "awaiting_input", "the plan park");

    // THE ANSWER ARRIVES THROUGH THE EXISTING CHAT CHANNEL — the same table and
    // route a mid-run instruction uses, exactly as `plan-phase.test.ts` drives it.
    h.store.appendMessage("run-turns", { role: "owner", text: "Use the side rail.", images: [] });
    assert.equal(h.orchestrator.deliverPlanReply("run-turns"), true, "a parked run reads this as an answer");
    await waitFor(() => h.seatCalls.length > 1, "the follow-up turn");

    const second = h.handovers[1];
    assert.ok(second !== undefined, "a fresh caller per turn");
    assert.equal(second.images.filter((image) => image.block !== null).length, 1, "re-read and re-carried");

    const followUp = String(h.seatCalls[1]?.userTurns[0]);
    assert.match(followUp, /HIS 1 REFERENCE IMAGE\(S\) ARE IN THIS MESSAGE TOO/);
    assert.ok(followUp.includes("Use the side rail."), "his message still goes over verbatim");
  } finally {
    await h.settle();
    h.cleanup();
  }
});
