/**
 * design-dialogue.test.ts — the four ways this driver can lie to the owner.
 *
 * WHAT AN INTEGRATION TEST CANNOT REACH, and why the seam is here. Every case
 * below needs a REAL parked run whose caps are part-spent, or a direction the
 * owner names that does not exist, or a generation that fails — states an
 * end-to-end run would have to fake anyway. So the seam is `DesignDialogueHost`
 * (the driver's whole contract with the orchestrator) and the store underneath is
 * REAL: `seq` numbering, delivery stamps and `pendingMessages`'s filter are the
 * mechanisms under test, and a fake store would let me define them to be whatever
 * the assertions wanted. `render` is the ONE fake, because the real one spends
 * the owner's Gemini key.
 *
 * ─── THE MUTATION WATCHED FOR EACH TEST, IN `design-dialogue.ts` ───
 *
 *   refused by name      — return the first direction from `matchDirection`
 *                          instead of null. RED: he asks for "direction 7", gets
 *                          a picture of direction 1, and nothing says it is not
 *                          what he asked for.
 *   the render cap       — drop the `designRendersExhausted` arm from
 *                          `#capRefusal`. RED: the seventh request generates.
 *   a refusal costs a turn — record `turnsUsed: record.turnsUsed` on the
 *                          unknown-direction path. RED: an unbounded exchange
 *                          runs on refusals alone.
 *   requested, not canvassed — write `origin: "canvass"` on the on-demand ref in
 *                          `#renderOnDemand`. RED at the manifest: the preview
 *                          the owner asked for becomes eligible to be the hero
 *                          the visual gate grades the whole build against.
 *   a failed render still spends — count only successes. RED: the cap becomes a
 *                          bound on luck rather than on spend.
 *   a label it does not use — put `versions?|number|nos?\.` back into
 *                          `LABELLED_ORDINAL`. RED: "put the phone number 2 lines
 *                          below the address in the footer" is claimed, drawn as
 *                          the footer in direction 2, and stamped delivered — so
 *                          the builder never sees the instruction.
 *   never attempted, never charged — `rendersUsed: still.rendersUsed + 1`
 *                          unconditionally. RED: a degraded park bills a render
 *                          for a tool it never invoked, and six honest refusals
 *                          exhaust a budget nothing ever drew against.
 *   an instruction beside a reference — `carriesBuildInstruction` returns false.
 *                          RED on ALL FIVE ARMS at once, which is the point of
 *                          the test that watches it: every one of the five
 *                          declined sentences resolves again, spends a turn and a
 *                          render drawing the thing the owner asked to CHANGE,
 *                          and is stamped delivered.
 *   the decline is legible — return null from `#sayItWasDeclined` before the log.
 *                          RED on all five arms: the message is declined for free
 *                          and reaches the builder, but the owner is told
 *                          nothing, so a man who wanted a picture gets silence.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "./db.js";
import {
  DESIGN_FROZEN_SUITE_NOTICE,
  DesignDialogueDriver,
  matchDirection,
  matchSection,
  parseDesignRequest,
} from "./design-dialogue.js";
import type { DesignDialogueHost, DesignRenderResult, DesignRequest } from "./design-dialogue.js";
import { emptyDesignLockRecord, readDesignLock, writeDesignLock } from "./design-lock.js";
import type { DesignLockRecord } from "./design-lock.js";
import type { DesignManifest } from "./design-manifest.js";
import { parseDesignManifest } from "./design-manifest.js";
import { MAX_DESIGN_LOCK_TURNS, MAX_DESIGN_ON_DEMAND_RENDERS } from "./design-prompt.js";
import { ticketFromText } from "./ticket.js";

const WS = "/runs/r1/workspace";

function canvassManifest(): DesignManifest {
  const ref = (slug: string, section: string): unknown => ({
    path: `${WS}/design-refs/${slug}-01-${section}.png`,
    section,
    aspect: "16:9",
    intent: "i",
    direction: slug,
  });
  return parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: [
        { slug: "editorial-slab", name: "Editorial slab", distinction: "a slab masthead", notes: null },
        { slug: "quiet-grid", name: "Quiet grid", distinction: "a hairline grid", notes: null },
        { slug: "warm-stack", name: "Warm stack", distinction: "stacked warm blocks", notes: null },
      ],
      refs: [
        ref("editorial-slab", "hero"),
        ref("editorial-slab", "work"),
        ref("quiet-grid", "hero"),
        ref("quiet-grid", "work"),
        ref("warm-stack", "hero"),
        ref("warm-stack", "work"),
      ],
    }),
    WS,
  ) as DesignManifest;
}

interface Rig {
  readonly driver: DesignDialogueDriver;
  readonly store: RunStore;
  readonly results: string;
  readonly logs: string[];
  /** One entry per call the driver actually made to `render` — the SPEND. */
  readonly rendered: DesignRequest[];
  /** What the next render returns. */
  readonly result: { value: DesignRenderResult };
  /**
   * Runs INSIDE the fake generation — the window the park can close in.
   *
   * The real `render` is one `await` that costs money and takes a minute, and
   * everything the orchestrator does to a run (the timer firing, the owner
   * clicking a direction, a cancel) can land in the middle of it. This hook is
   * the only way a test can put a write THERE rather than before or after.
   */
  readonly onRender: { fn: (() => void) | null };
  record(): DesignLockRecord | null;
  cleanup(): void;
}

function rig(manifest: DesignManifest | null = canvassManifest()): Rig {
  const dir = mkdtempSync(join(tmpdir(), "design-driver-"));
  const results = join(dir, "results");
  mkdirSync(results, { recursive: true });
  const store = RunStore.open(join(dir, "runs.db"));
  const logs: string[] = [];
  const rendered: DesignRequest[] = [];
  const result: { value: DesignRenderResult } = {
    // `attempted: true` — the host ran the tool and it produced this file, which
    // is what every test below assumes unless it says otherwise.
    value: {
      outcome: "rendered",
      detail: "here it is",
      path: `${WS}/design-refs/x-req-01-contact.png`,
      attempted: true,
    },
  };
  const onRender: { fn: (() => void) | null } = { fn: null };

  const host: DesignDialogueHost = {
    env: {},
    resultsDir: () => results,
    getRun: (runId) => store.getRun(runId),
    manifest: () => manifest,
    pendingMessages: (runId) => store.pendingMessages(runId),
    markDelivered: (runId, seqs) => {
      store.markMessagesDelivered(runId, seqs);
    },
    log: (_runId, level, text) => {
      logs.push(`${level}:${text}`);
    },
    render: (_runId, request) => {
      rendered.push(request);
      onRender.fn?.();
      return Promise.resolve(result.value);
    },
  };

  return {
    driver: new DesignDialogueDriver(host),
    store,
    results,
    logs,
    rendered,
    result,
    onRender,
    record: () => readDesignLock(results),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(store: RunStore, runId: string): void {
  const ticket = ticketFromText("Build me a portfolio site.");
  store.createRun({
    runId,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    ticketText: ticket.brief,
    ticketSha256: ticket.sha256,
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
    interactive: true,
  });
}

/** Park the run exactly as `#parkForDesignLock` does on a canvass. */
function park(r: Rig, runId: string, over: Partial<DesignLockRecord> = {}): void {
  seed(r.store, runId);
  r.store.updateRun(runId, { status: "awaiting_input", queuePosition: null });
  writeDesignLock(r.results, {
    ...emptyDesignLockRecord(new Date().toISOString()),
    awaiting: true,
    askedAfterSeq: 0,
    ...over,
  });
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ---- parsing: what he meant, and what he did not say ------------------- */

test("a direction is addressable by ORDINAL, SLUG and NAME — the panel numbers them", () => {
  const manifest = canvassManifest();
  assert.equal(matchDirection("show me the contact page in 3", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("design 2 please", manifest.directions)?.slug, "quiet-grid");
  // SLUG AND NAME NEED THE ASK THAT MAKES THEM A REQUEST — `A BARE NAME IS NOT A
  // RENDER REQUEST` below is the measurement. "the QUIET-GRID one" and "I like
  // Editorial Slab" resolved here until 2026-08-03 and were the loss it closes.
  assert.equal(matchDirection("show me the QUIET-GRID one", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("render Editorial Slab's hero", manifest.directions)?.slug, "editorial-slab");
  assert.equal(matchDirection("nothing in particular", manifest.directions), null);
  // AN ORDINAL PAST THE END IS NOT A DIRECTION. It must not wrap, clamp or take
  // the last one — every one of those would render a guess.
  assert.equal(matchDirection("design 7", manifest.directions), null);
  assert.equal(matchDirection("design 0", manifest.directions), null);
});

test("a section outside the brief is FOUND and FLAGGED, never silently dropped", () => {
  const manifest = canvassManifest();
  assert.deepEqual(matchSection("show me the hero", manifest), { section: "hero", offBrief: false });
  // `pricing` is nowhere in this run's refs. Refusing to draw it would be the
  // dashboard deciding what the owner may look at; drawing it silently would let
  // him believe the build will produce it.
  assert.deepEqual(matchSection("what about a pricing page", manifest), { section: "pricing", offBrief: true });
  assert.equal(matchSection("just make it nicer", manifest), null);
});

test("A BARE NUMBER IN PROSE IS A QUANTITY, NOT A DIRECTION", () => {
  /*
   * MEASURED 2026-08-03, and both of these were executed against the old regex
   * before this test existed. `matchDirection`'s ordinal had an OPTIONAL prefix
   * alternation and `\s*`, so it reduced to any bare `\b\d{1,2}\b`: `matchSection`
   * found `hero`, the ordinal found `2`, `parseDesignRequest` returned a resolved
   * request, and a render and a turn were spent drawing direction 2's hero — AND
   * the message was stamped delivered, so the instruction never reached the build
   * segment. A swallowed instruction is unrecoverable; a missed render is one more
   * sentence from the owner, which is why the tie-break runs this way.
   */
  const manifest = canvassManifest();
  for (const instruction of [
    "make the hero 2 lines instead of 3",
    "tighten the nav to 3 items",
    "the work grid should be 3 columns",
    "use 2 typefaces at most",
    // MARKER-FREE, AND THAT IS WHY IT IS HERE. The four above all trip the
    // instruction gate as well, so with that gate in place restoring the bare
    // `\b\d{1,2}\b` would leave them green and this round would have MASKED
    // round 2's proof. This sentence carries no instruction shape at all, so the
    // ordinal narrowing is the only thing declining it — put the bare digit back
    // and it resolves to direction 3 and draws the work section.
    "a 3 column work grid",
  ]) {
    assert.equal(matchDirection(instruction, manifest.directions), null, instruction);
    assert.equal(parseDesignRequest(instruction, manifest), null, instruction);
  }

  // AND A LABELLED NUMBER STILL IS ONE — the panel numbers the groups, and "in 3"
  // is the phrasing the park's own log line invites.
  assert.equal(matchDirection("show me the contact page in 3", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("the footer in 2, please", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("hero in #1", manifest.directions)?.slug, "editorial-slab");
});

test("A LABEL THIS PARK DOES NOT USE IS NOT A DIRECTION REFERENCE — `version 2`, `number 2`, `no. 3`", () => {
  /*
   * THE BARE DIGIT WAS CLOSED AND THE LABELLED ONE WAS NOT. `LABELLED_ORDINAL`
   * accepted `versions?`, `number` and `nos?\.` alongside the four words the
   * panel and this park actually use for a direction — so an ordinary build
   * instruction containing one of them plus a digit was read as a request for a
   * picture. Every sentence below is an INSTRUCTION, and the first is the worst
   * of them: it also names a section, so it parsed all the way to a resolved
   * request, spent a render drawing the footer in direction 2, and stamped the
   * message delivered — the instruction never reached the build segment.
   *
   * THE TIE-BREAK, WHICH IS THE DESIGN DECISION: when a message is ambiguous,
   * treat it as an instruction for the build rather than spend a render on it. A
   * swallowed instruction is unrecoverable; a missed render costs the owner one
   * more sentence, and costs him no turn because a message this declines is
   * never claimed.
   */
  const manifest = canvassManifest();
  for (const instruction of [
    "put the phone number 2 lines below the address in the footer",
    "bump the type scale to version 2 in the hero",
    "the contact form should be no. 3 in the footer",
    "use version 2 of the logo",
    // MARKER-FREE, for the reason the bare-digit test states: `put`, `bump`,
    // `should` and `use` all trip the instruction gate too, so without this line
    // restoring `versions?|number|nos?\.` to `LABELLED_ORDINAL` would leave the
    // whole list green and round 3's proof would be masked. This one names a
    // section and nothing else — put the label back and it resolves to direction
    // 2 and draws the footer.
    "the phone number 2 lines below the address in the footer",
  ]) {
    assert.equal(matchDirection(instruction, manifest.directions), null, instruction);
    assert.equal(parseDesignRequest(instruction, manifest), null, instruction);
  }

  // AND THE PARK'S OWN VOCABULARY STILL RESOLVES, which is what makes the four
  // above a measurement rather than a parser that stopped reading numbers.
  assert.equal(matchDirection("design 2 please", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("direction 3, the footer", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("option 1", manifest.directions)?.slug, "editorial-slab");
  assert.equal(matchDirection("variant 2", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("the hero in #3", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("show me the footer in 2", manifest.directions)?.slug, "quiet-grid");
});

test("AN INSTRUCTION WITH A LABELLED NUMBER IN IT COSTS NOTHING AND REACHES THE BUILDER", async () => {
  // THE OWNER-VISIBLE HALF of the parse above, on the sentence that used to cost
  // the most: a render he did not ask for, a turn, AND the instruction itself.
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", {
      role: "owner",
      text: "put the phone number 2 lines below the address in the footer",
      images: [],
    });
    assert.equal(r.driver.deliver("run-1"), false, "not a render request");
    assert.equal(r.rendered.length, 0, "no image is generated for it");
    assert.equal(r.store.pendingMessages("run-1").length, 1, "UNSTAMPED: the boundary drain carries it to the build");
    assert.equal(r.record()?.turnsUsed, 0, "and the refusal is free — nothing was claimed");
    assert.equal(r.record()?.rendersUsed, 0);
  } finally {
    r.cleanup();
  }
});

test("A NAME BESIDE AN INSTRUCTION IS AN INSTRUCTION — the sentence tells the build what to change", () => {
  /*
   * THE NAME ARM'S HALF OF THE SAME LOSS, MEASURED 2026-08-03. The digit shapes
   * were narrowed twice — first so a bare number in prose stopped resolving, then
   * so a label had to be one this park uses — and the SLUG/NAME arm above them was
   * never given an equivalent. It resolved on `String.includes` alone, so every
   * sentence below named a direction, named a section, parsed to a resolved
   * request, spent a turn AND a render drawing the thing the owner asked to
   * CHANGE, and was stamped delivered — so the instruction never reached the build
   * segment either.
   *
   * THE RULING, RESTATED 2026-08-03 AFTER IT WAS APPLIED TO ONE ARM OF FIVE. The
   * first cut of it asked "does the message ASK for a picture", which is a
   * question only the name arm could be made to answer — `the footer in 2,
   * please` asks for nothing and is a plain request, so the digit arms could not
   * carry the same gate and were left ungated. What separates these sentences
   * from a request is not a missing ask: it is that they also TELL THE BUILD WHAT
   * TO CHANGE. That question has the same answer on all five arms, and
   * `ONE RULE, FIVE ARMS` below is the measurement.
   */
  const manifest = canvassManifest();
  for (const instruction of [
    "I like editorial slab, but make the hero taller",
    "the quiet grid feels too sparse in the work section — tighten it",
    "go with warm stack and drop the hero image entirely",
    "editorial slab's type is too big for the hero",
    // AND THE INSTRUCTION SHAPES ARE BROAD ON PURPOSE, which is the inverse of
    // `LABELLED_ORDINAL`'s narrowing and for the same tie-break: a false positive
    // here declines a request the owner can retype, a false negative swallows a
    // sentence he cannot get back. Every one of these is a sentence an owner
    // would really type, and each names a direction.
    "don't show the nav on mobile in editorial slab",
    "draw the eye to the CTA in editorial slab",
    "add a preview of the work section in quiet grid",
    "the mockups are too dark in warm stack",
    "make the hero look bigger in warm stack",
  ]) {
    assert.equal(matchDirection(instruction, manifest.directions), null, instruction);
    assert.equal(parseDesignRequest(instruction, manifest), null, instruction);
  }

  /*
   * AND `the QUIET-GRID one` RESOLVES, WHICH IS A FLIP AND IS FORCED. It sat in
   * the list above while the gate was "does it ask", and it is word-for-word "the
   * second one" — which line 378 below requires to resolve and always has. No
   * uniform rule can send those two different ways, so the ask-gate's own test
   * file carried this round's defect: one arm judged by a rule its sibling was
   * exempt from.
   *
   * THE COST, NAMED. It carries no section, so the driver answers `no-section`,
   * which SPENDS A TURN and STAMPS the message delivered — it is not the free,
   * unstamped decline the sentences above get. That is the price of the symmetry,
   * and it is the price "the second one" has always paid.
   */
  assert.equal(matchDirection("the QUIET-GRID one", manifest.directions)?.slug, "quiet-grid");
  assert.equal(parseDesignRequest("the QUIET-GRID one", manifest)?.section, "");

  // AND A NAME IN A SENTENCE THAT INSTRUCTS NOTHING STILL RESOLVES, which is what
  // makes the list above a measurement rather than a parser that stopped reading
  // names. Both the SLUG and the NAME are addressable, in the park's own
  // invitation and in the phrasings an owner reaches for instead of it.
  assert.equal(matchDirection("show me the hero in editorial slab", manifest.directions)?.slug, "editorial-slab");
  assert.equal(matchDirection("can I see the work section in quiet-grid", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("render the footer in Warm stack", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("what does editorial slab's hero look like", manifest.directions)?.slug, "editorial-slab");
  assert.equal(matchDirection("I'd like to see the quiet grid hero", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("how does the work section look in warm stack", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("mock up the footer in quiet grid", manifest.directions)?.slug, "quiet-grid");

  // AND THE DIGIT ARMS STILL TAKE A SENTENCE THAT ASKS FOR NOTHING. Their proof is
  // the LABEL, which round 3 settled; demanding an ASK on top of it would refuse
  // the sentence the park's own log line invites, which is why the gate this file
  // measures is "does it also instruct" and not "does it ask".
  assert.equal(matchDirection("design 2 please", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("the footer in 2, please", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("the second one", manifest.directions)?.slug, "quiet-grid");
});

/**
 * THE FIVE ARMS, EACH WITH A SENTENCE THAT RESOLVES AND A SENTENCE THAT DECLINES.
 *
 * Every `declines` string below is reachable through ONE arm only — no other arm
 * matches it — so a gate that covered four of the five would leave exactly one row
 * of this table red, which is the failure mode of rounds 2, 3 and 4.
 */
const DIRECTION_ARMS: readonly {
  readonly arm: string;
  readonly resolves: string;
  readonly declines: string;
  readonly slug: string;
  readonly name: string;
}[] = [
  {
    arm: "SLUG/NAME",
    resolves: "show me the hero in editorial slab",
    declines: "I like editorial slab, but make the hero taller",
    slug: "editorial-slab",
    name: "Editorial slab",
  },
  {
    arm: "LABELLED_ORDINAL",
    resolves: "design 2 please",
    declines: "I like design 2, but make the hero taller",
    slug: "quiet-grid",
    name: "Quiet grid",
  },
  {
    arm: "HASH_ORDINAL",
    resolves: "#3, the footer",
    declines: "#3 is too dark, lighten the hero",
    slug: "warm-stack",
    name: "Warm stack",
  },
  {
    arm: "IN_ORDINAL",
    resolves: "the footer in 2, please",
    declines: "lighten the hero in 2",
    slug: "quiet-grid",
    name: "Quiet grid",
  },
  {
    arm: "WORD_ORDINAL",
    resolves: "the second one",
    declines: "the second one is too busy, tone down the hero",
    slug: "quiet-grid",
    name: "Quiet grid",
  },
];

/*
 * ONE TEST PER ARM, NOT ONE LOOP OVER FIVE — and the shape is deliberate. A loop
 * inside a single `test()` stops at the first failing arm, so a gate that covered
 * four of the five would show ONE red row and say nothing about the other four:
 * the runner output would look exactly like the round-4 fix that gated one arm.
 * Five named tests fail five named ways.
 *
 * THE ROUND-4 HOLE, MEASURED 2026-08-03 AGAINST `dist`. The name arm was gated on
 * an ASK and the four number arms on nothing, so two sentences one shape apart
 * went opposite ways:
 *
 *   "I like editorial slab, but make the hero taller" -> null (declined)
 *   "I like design 2, but make the hero taller"       -> {hero, quiet-grid}
 *
 * and with it "design 2 is too dark, lighten the hero", "#3 is too dark, lighten
 * the hero", "lighten the hero in 2" and "the second one is too busy, tone down
 * the hero". Each of those spent a turn and a render drawing the thing the owner
 * asked to CHANGE, and `markDelivered` stamped the sentence so the build segment
 * never saw the instruction.
 *
 * THE DISCRIMINATOR IS NOT "DOES IT ASK". `the footer in 2, please` asks for
 * nothing and is a plain request, so an ask-gate cannot be applied to the number
 * arms at all — which is how one arm came to be gated in the first place. It is
 * "does it ALSO CARRY AN INSTRUCTION", and that question has an answer on every
 * arm.
 */
for (const { arm, resolves, declines, slug } of DIRECTION_ARMS) {
  test(`ONE RULE, FIVE ARMS — ${arm}: an instruction beside a reference is an instruction`, () => {
    const manifest = canvassManifest();
    // THE NEGATIVE CONTROL IS IN THE SAME TEST. Without it this passes on a
    // parser that stopped reading this arm altogether.
    assert.equal(matchDirection(resolves, manifest.directions)?.slug, slug, `${arm} must resolve: ${resolves}`);
    assert.ok(parseDesignRequest(resolves, manifest) !== null, `${arm} must resolve: ${resolves}`);
    assert.equal(matchDirection(declines, manifest.directions), null, `${arm} must decline: ${declines}`);
    assert.equal(parseDesignRequest(declines, manifest), null, `${arm} must decline: ${declines}`);
  });
}

/*
 * THE SECOND HALF OF THE SAME FIX, AND THE HALF ROUND 6 WOULD OTHERWISE HAVE TO
 * WRITE. The near-miss notice tested only the NAME arm, so gating the four number
 * arms without touching it would turn four loud losses into four SILENT declines
 * — the owner types "design 2 is too dark, lighten the hero", gets no picture and
 * no sentence, and cannot tell the difference between "read as an instruction"
 * and "ignored". A refusal he cannot see is not a refusal.
 */
for (const { arm, declines, name } of DIRECTION_ARMS) {
  test(`EVERY ARM'S DECLINE IS SAID OUT LOUD — ${arm}: free, unstamped, and named back to him`, () => {
    const r = rig();
    try {
      park(r, "run-1");
      r.store.appendMessage("run-1", { role: "owner", text: declines, images: [] });
      assert.equal(r.driver.deliver("run-1"), false, `${arm}: ${declines}`);
      assert.equal(r.rendered.length, 0, `${arm}: no image of the thing he asked to CHANGE`);
      assert.equal(r.store.pendingMessages("run-1").length, 1, `${arm}: UNSTAMPED, so the build segment sees it`);
      assert.equal(r.record()?.turnsUsed, 0, `${arm}: free — nothing was claimed`);
      assert.equal(r.record()?.rendersUsed, 0, `${arm}: and nothing was spent`);
      assert.ok(
        r.logs.some((line) => line.startsWith("warn:") && line.includes(name) && line.includes("show me")),
        `${arm}: the decline has to name the direction and the phrasing that works: ${JSON.stringify(r.logs)}`,
      );
    } finally {
      r.cleanup();
    }
  });
}

test("AN INSTRUCTION THAT NAMES A DIRECTION THAT DOES NOT EXIST IS DECLINED FREE, AND NAMED BACK", async () => {
  /*
   * THE ARM OF THE DECLINE NOTICE THAT HAS NO `DesignDirection` TO NAME. "design
   * 7, but make the hero taller" carries an instruction and a reference this run
   * cannot resolve. Today it parses as a request and is REFUSED BY NAME — a turn
   * spent and, worse, `markDelivered` stamped, so the instruction is lost to a
   * refusal about a direction that never existed. It must decline like every
   * other instruction, and it must still be said out loud with the label he used.
   */
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "design 7, but make the hero taller", images: [] });
    assert.equal(r.driver.deliver("run-1"), false);
    assert.equal(r.rendered.length, 0);
    assert.equal(r.store.pendingMessages("run-1").length, 1, "UNSTAMPED: the instruction reaches the build");
    assert.equal(r.record()?.turnsUsed, 0, "and it costs no turn, because nothing was claimed");
    assert.ok(
      r.logs.some((line) => line.startsWith("warn:") && line.includes('"7"') && line.includes("show me")),
      `the label he used has to come back to him: ${JSON.stringify(r.logs)}`,
    );
  } finally {
    r.cleanup();
  }
});

test("A NAMED DIRECTION BESIDE AN INSTRUCTION IS DECLINED OUT LOUD — free, unstamped, rephraseable", async () => {
  /*
   * THE OWNER-VISIBLE HALF of the parse above, with its negative control in the
   * same test: the SAME direction in a sentence that instructs nothing must be
   * taken up. A fixture that only ever produced the declined shape would pass
   * with a parser that had simply stopped reading names.
   */
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", {
      role: "owner",
      text: "I like editorial slab, but make the hero taller",
      images: [],
    });
    assert.equal(r.driver.deliver("run-1"), false, "not a render request: he is discussing a direction");
    assert.equal(r.rendered.length, 0, "no image of the thing he asked to CHANGE");
    assert.equal(r.store.pendingMessages("run-1").length, 1, "UNSTAMPED: the boundary drain carries it to the build");
    assert.equal(r.record()?.turnsUsed, 0, "and it is free — nothing was claimed");
    assert.equal(r.record()?.rendersUsed, 0);
    // A REFUSAL HE CANNOT SEE IS NOT A REFUSAL. A missed render is only the cheap
    // side of the trade if he is told to ask again, and told how.
    assert.ok(
      r.logs.some((line) => line.startsWith("warn:") && line.includes("Editorial slab") && line.includes("show me")),
      `the near-miss has to be said out loud, naming the direction and the phrasing: ${JSON.stringify(r.logs)}`,
    );

    // THE CONTROL: the same words with an ask are a request, and they render.
    r.store.appendMessage("run-1", { role: "owner", text: "show me the hero in editorial slab", images: [] });
    assert.equal(r.driver.deliver("run-1"), true, "the ask is what makes it a request");
    await waitFor(() => !r.driver.busy("run-1"), "the render to finish");
    assert.equal(r.rendered.length, 1);
    assert.equal(r.rendered[0]?.resolved?.slug, "editorial-slab");
    assert.equal(r.rendered[0]?.section, "hero");
    assert.equal(
      r.store.pendingMessages("run-1").length,
      1,
      "and the INSTRUCTION is still pending — claiming the request did not claim it",
    );
  } finally {
    r.cleanup();
  }
});

test("`the third` IS ADDRESSABLE, which the docblock claimed and no branch matched", () => {
  // The claim was in writing and nothing implemented it: every ordinal branch was
  // numeric. A docblock that claims more than the code does is the same defect as
  // a comment that lies about a cap.
  const manifest = canvassManifest();
  assert.equal(matchDirection("show me the contact page in the third", manifest.directions)?.slug, "warm-stack");
  assert.equal(matchDirection("the second one", manifest.directions)?.slug, "quiet-grid");
  assert.equal(matchDirection("the first direction, with the contact section", manifest.directions)?.slug, "editorial-slab");
  // AND IT DOES NOT CLAIM EVERY SENTENCE THAT OPENS WITH AN ORDINAL WORD. "the
  // first thing I want" is an instruction, and it names `hero` — so a word
  // ordinal that matched here would swallow it exactly as the bare digit did.
  assert.equal(matchDirection("the first thing I want is a dark hero", manifest.directions), null);
  assert.equal(parseDesignRequest("the first thing I want is a dark hero", manifest), null);
});

test("a message that names NEITHER a section nor a direction is not a request", () => {
  // It is a mid-run instruction. Claiming it would consume it, stamp it delivered
  // and spend a turn — and the builder would never see the sentence he typed.
  const manifest = canvassManifest();
  assert.equal(parseDesignRequest("actually use a dark background everywhere", manifest), null);
  assert.equal(parseDesignRequest("", manifest), null);
  const request = parseDesignRequest("show me the contact section in 2", manifest);
  assert.equal(request?.section, "contact");
  assert.equal(request?.resolved?.slug, "quiet-grid");
});

/* ---- the turns themselves --------------------------------------------- */

test("AN ON-DEMAND REQUEST RENDERS THE NAMED SECTION IN THE NAMED DIRECTION", async () => {
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "show me the contact section in 3", images: [] });
    assert.equal(r.driver.deliver("run-1"), true, "the route tells the owner it was taken up");
    await waitFor(() => !r.driver.busy("run-1"), "the render to finish");

    assert.equal(r.rendered.length, 1, "exactly one generation — one request, one image, no retry");
    assert.equal(r.rendered[0]?.section, "contact");
    assert.equal(r.rendered[0]?.resolved?.slug, "warm-stack");

    const record = r.record();
    assert.equal(record?.rendersUsed, 1, "the spend is on disk, so a restart cannot reset it");
    assert.equal(record?.turnsUsed, 1);
    assert.equal(record?.requests.length, 1);
    assert.equal(record?.requests[0]?.outcome, "rendered");
    assert.equal(record?.requests[0]?.direction, "warm-stack");
    assert.equal(record?.requests[0]?.section, "contact");
    // THE PARK IS THE SAME PARK. `parkedAt` is untouched and `awaiting` is still
    // true — the clock keeps running through the dialogue, which is the whole
    // reason a chatty owner cannot park for ever.
    assert.equal(record?.awaiting, true);
    assert.deepEqual(r.store.pendingMessages("run-1"), [], "and the message is stamped, not left to the builder");
  } finally {
    r.cleanup();
  }
});

test("A DIRECTION THAT DOES NOT EXIST IS REFUSED BY NAME — no image, and it says which exist", async () => {
  const r = rig();
  try {
    park(r, "run-1", {
      directions: [
        { slug: "editorial-slab", name: "Editorial slab", distinction: "d", notes: null, mockups: [] },
        { slug: "quiet-grid", name: "Quiet grid", distinction: "d", notes: null, mockups: [] },
        { slug: "warm-stack", name: "Warm stack", distinction: "d", notes: null, mockups: [] },
      ],
    });
    r.store.appendMessage("run-1", { role: "owner", text: "show me the contact section in design 7", images: [] });
    assert.equal(r.driver.deliver("run-1"), true);
    await waitFor(() => !r.driver.busy("run-1"), "the refusal to be recorded");

    assert.equal(r.rendered.length, 0, "NEVER RENDER A GUESS AND PRESENT IT AS AN ANSWER");
    const record = r.record();
    assert.equal(record?.rendersUsed, 0, "a refusal costs no image");
    assert.equal(record?.turnsUsed, 1, "and it does cost a turn — every claimed message does");
    assert.equal(record?.requests[0]?.outcome, "unknown-direction");
    assert.match(String(record?.requests[0]?.detail), /no direction "7"/);
    assert.match(String(record?.requests[0]?.detail), /Editorial slab/, "it names the ones that DO exist");
    assert.match(String(record?.requests[0]?.detail), /Warm stack/);
    assert.ok(
      r.logs.some((line) => line.startsWith("warn:") && line.includes("no direction")),
      "and it is said out loud on the run's own log, not only in a JSON file",
    );
  } finally {
    r.cleanup();
  }
});

test("THE GENERATION CAP STOPS THE NEXT REQUEST AND SAYS SO — it does not silently ignore him", async () => {
  const r = rig();
  try {
    // Every render already spent, one turn left. The two caps are independent on
    // purpose, and this is the state that proves it.
    park(r, "run-1", { rendersUsed: MAX_DESIGN_ON_DEMAND_RENDERS, turnsUsed: 0 });
    r.store.appendMessage("run-1", { role: "owner", text: "one more — the footer in 1", images: [] });
    assert.equal(r.driver.deliver("run-1"), true);
    await waitFor(() => !r.driver.busy("run-1"), "the cap refusal");

    assert.equal(r.rendered.length, 0, "the cap is CODE: no model and no prompt can talk past it");
    const record = r.record();
    assert.equal(record?.rendersUsed, MAX_DESIGN_ON_DEMAND_RENDERS, "and it does not creep past the cap");
    assert.equal(record?.requests[0]?.outcome, "render-cap");
    assert.match(String(record?.requests[0]?.detail), /no more renders on this run/);
    assert.match(String(record?.requests[0]?.detail), /Pick one of the directions/);
    assert.ok(r.logs.some((line) => line.startsWith("warn:") && line.includes("no more renders")));
  } finally {
    r.cleanup();
  }
});

test("THE TURN CAP STOPS HIM TOO, and its sentence carries the frozen-suite notice", async () => {
  const r = rig();
  try {
    park(r, "run-1", { turnsUsed: MAX_DESIGN_LOCK_TURNS, rendersUsed: 0 });
    r.store.appendMessage("run-1", { role: "owner", text: "the footer in 1", images: [] });
    assert.equal(r.driver.deliver("run-1"), true);
    await waitFor(() => !r.driver.busy("run-1"), "the cap refusal");
    assert.equal(r.rendered.length, 0);
    const detail = String(r.record()?.requests[0]?.detail);
    assert.match(detail, /no more questions on this run/);
    // THE HONEST LIMIT, AND IT IS REQUIRED COPY. Nothing asked here can add or
    // change an acceptance criterion; the suite was frozen in the spec phase.
    assert.ok(detail.includes(DESIGN_FROZEN_SUITE_NOTICE));
  } finally {
    r.cleanup();
  }
});

test("A FAILED GENERATION STILL SPENDS ITS RENDER — the cap bounds spend, not luck", async () => {
  const r = rig();
  try {
    park(r, "run-1");
    // ATTEMPTED AND FAILED, which is the arm that must still be charged: the tool
    // was invoked and exited 1, so the money is gone whatever came back. The
    // never-attempted arm is the test below this one.
    r.result.value = { outcome: "failed", detail: "the image tool exited 1", path: null, attempted: true };
    r.store.appendMessage("run-1", { role: "owner", text: "the footer in 1", images: [] });
    r.driver.deliver("run-1");
    await waitFor(() => !r.driver.busy("run-1"), "the failed render");
    const record = r.record();
    assert.equal(record?.rendersUsed, 1, "the call was made and the money was spent");
    assert.equal(record?.requests[0]?.outcome, "failed");
    assert.equal(record?.requests[0]?.path, null);
  } finally {
    r.cleanup();
  }
});

test("A MESSAGE THAT PREDATES THE MOCKUPS IS NOT A REQUEST FOR ONE — the cut holds", async () => {
  const r = rig();
  try {
    seed(r.store, "run-1");
    // Typed while the lane was still generating: he cannot have been asking for a
    // direction he had not seen. `askedAfterSeq` is minted at the park.
    r.store.appendMessage("run-1", { role: "owner", text: "make the hero taller in general", images: [] });
    const early = r.store.pendingMessages("run-1")[0];
    assert.ok(early !== undefined);
    r.store.updateRun("run-1", { status: "awaiting_input", queuePosition: null });
    writeDesignLock(r.results, {
      ...emptyDesignLockRecord(new Date().toISOString()),
      awaiting: true,
      askedAfterSeq: early.seq,
    });

    assert.equal(r.driver.deliver("run-1"), false, "below the cut: not a request");
    assert.equal(r.rendered.length, 0);
    assert.equal(r.store.pendingMessages("run-1").length, 1, "and it is NOT stamped — the builder still gets it");
  } finally {
    r.cleanup();
  }
});

test("A MID-RUN INSTRUCTION IS DECLINED AND STAYS PENDING, even on a parked run", async () => {
  // THE ONE PLACE THIS DRIVER DIFFERS FROM `PlanDriver`, whose `deliver` claims
  // every message on a parked run. Here only some messages are requests, and
  // claiming an instruction would consume it and stamp it delivered.
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "remember to keep it accessible", images: [] });
    assert.equal(r.driver.deliver("run-1"), false);
    assert.equal(r.store.pendingMessages("run-1").length, 1);
    assert.equal(r.record()?.turnsUsed, 0, "and it costs nothing, because nothing was claimed");
  } finally {
    r.cleanup();
  }
});

test("AN INSTRUCTION WITH A NUMBER IN IT REACHES THE BUILDER, not the image tool", async () => {
  // The owner-visible half of the parse above. He is parked, he types a change he
  // wants BUILT, and the sentence happens to contain a digit. Claiming it renders
  // a picture he did not ask for, spends a turn and a render on it, and stamps the
  // message delivered — so the builder never sees the instruction at all.
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "make the hero 2 lines instead of 3", images: [] });
    assert.equal(r.driver.deliver("run-1"), false, "not a render request");
    assert.equal(r.rendered.length, 0, "and no image is generated for it");
    assert.equal(r.store.pendingMessages("run-1").length, 1, "UNSTAMPED: the segment boundary carries it to the build");
    assert.equal(r.record()?.turnsUsed, 0, "and it costs nothing, because nothing was claimed");
  } finally {
    r.cleanup();
  }
});

test("A GENERATION PAID FOR WHILE THE PARK CLOSED IS STILL CHARGED — to BOTH counters", async () => {
  /*
   * THE AWAIT WINDOW, ON THE BUDGET. The park can close under a generation three
   * ways — the timer fires, the owner clicks a direction, the run is cancelled —
   * and the post-await `#parked` check then returns null. Returning there BEFORE
   * `#commit` leaves an image that was generated and paid for charged to NEITHER
   * counter, and (with the manifest clobber this bug travelled with) a reopened
   * park handed the owner a fresh budget with the money already spent.
   *
   * AND IT MUST NOT RESURRECT THE PARK IT WAS WRITTEN INTO. The choice below is
   * exactly what `#applyDirectionChoice` writes; a commit that spread the
   * ENTRY-TIME record over it would set `awaiting` back to true and erase the
   * direction the owner just picked.
   */
  const r = rig();
  try {
    park(r, "run-1");
    r.onRender.fn = () => {
      const open = readDesignLock(r.results);
      assert.ok(open !== null);
      writeDesignLock(r.results, {
        ...open,
        awaiting: false,
        chosenDirection: "quiet-grid",
        chosenDirectionBy: "owner",
        chosenDirectionReason: "chosen by the owner in the dashboard",
      });
      r.store.updateRun("run-1", { status: "queued" });
    };
    r.store.appendMessage("run-1", { role: "owner", text: "the footer in 1", images: [] });
    assert.equal(r.driver.deliver("run-1"), true);
    await waitFor(() => !r.driver.busy("run-1"), "the render that outlived the park");

    assert.equal(r.rendered.length, 1, "the image was generated: the money is already gone");
    const record = r.record();
    assert.equal(record?.rendersUsed, 1, "so it is charged, whatever the park did underneath it");
    assert.equal(record?.turnsUsed, 1, "and the message that asked for it cost its turn");
    assert.equal(record?.requests.length, 1, "with the request on the record, where the panel reads it");
    assert.equal(record?.awaiting, false, "the closed park is NOT reopened by the write that charges it");
    assert.equal(record?.chosenDirection, "quiet-grid", "and the choice made under it survives");
  } finally {
    r.cleanup();
  }
});

test("THE RENDER CAP IS REACHABLE — every render spends a turn, so turns must outnumber renders", async () => {
  /*
   * `rendersMax` IS ON THE WIRE AND THE PANEL SAYS IT OUT LOUD ("6 renders left").
   * With MAX_DESIGN_LOCK_TURNS at 4 against MAX_DESIGN_ON_DEMAND_RENDERS at 6 the
   * render cap was structurally unreachable — the turn cap fired first, every
   * time — so the owner was shown a budget he could never approach. Measured
   * 2026-08-03: a burst of six requests produced four images and a turn-cap
   * refusal on the fifth.
   */
  assert.ok(
    MAX_DESIGN_LOCK_TURNS > MAX_DESIGN_ON_DEMAND_RENDERS,
    `every render also spends a turn, so ${String(MAX_DESIGN_LOCK_TURNS)} turns cannot pay for ` +
      `${String(MAX_DESIGN_ON_DEMAND_RENDERS)} renders`,
  );
  const r = rig();
  try {
    park(r, "run-1");
    const sections = ["hero", "work", "footer", "contact", "about", "pricing"];
    for (let n = 0; n < MAX_DESIGN_ON_DEMAND_RENDERS; n += 1) {
      const section = sections[n % sections.length] ?? "hero";
      r.store.appendMessage("run-1", { role: "owner", text: `the ${section} in ${String((n % 3) + 1)}`, images: [] });
    }
    r.driver.deliver("run-1");
    await waitFor(() => !r.driver.busy("run-1"), "the whole budget");

    assert.equal(r.rendered.length, MAX_DESIGN_ON_DEMAND_RENDERS, "the budget the panel shows is the budget he has");
    assert.equal(r.record()?.rendersUsed, MAX_DESIGN_ON_DEMAND_RENDERS);
    assert.ok(
      !(r.record()?.requests ?? []).some((request) => request.outcome === "turn-cap"),
      "the turn cap must not fire before the render cap it is meant to sit above",
    );

    // AND THE NEXT ONE IS THE RENDER CAP, BY NAME. The cap the panel names is the
    // cap he actually hits — which is what makes `rendersMax` true on the wire.
    r.store.appendMessage("run-1", { role: "owner", text: "one more — the hero in 2", images: [] });
    assert.equal(r.driver.deliver("run-1"), true);
    await waitFor(() => !r.driver.busy("run-1"), "the cap refusal");
    assert.equal(r.rendered.length, MAX_DESIGN_ON_DEMAND_RENDERS, "and nothing past it is generated");
    assert.equal(r.record()?.requests[MAX_DESIGN_ON_DEMAND_RENDERS]?.outcome, "render-cap");
  } finally {
    r.cleanup();
  }
});

test("THE THREE DRIVERS ARE DISJOINT: a run that is not parked on a CANVASS is declined", async () => {
  // A run parked for a MOCKUP on a single-direction lane is `awaiting_input` with
  // an `awaiting: true` record too, and its owner has nothing to ask for. And a
  // run whose direction is already CHOSEN is past the question.
  const noDirections = rig(parseDesignManifest(JSON.stringify({ version: 1, refs: [] }), WS));
  try {
    park(noDirections, "run-1");
    noDirections.store.appendMessage("run-1", { role: "owner", text: "the hero in 1", images: [] });
    assert.equal(noDirections.driver.deliver("run-1"), false, "no directions: not a canvass park");
  } finally {
    noDirections.cleanup();
  }

  const chosen = rig({ ...canvassManifest(), chosenDirection: "quiet-grid" });
  try {
    park(chosen, "run-1");
    chosen.store.appendMessage("run-1", { role: "owner", text: "the hero in 1", images: [] });
    assert.equal(chosen.driver.deliver("run-1"), false, "already chosen: the question is over");
  } finally {
    chosen.cleanup();
  }

  const running = rig();
  try {
    park(running, "run-1");
    running.store.updateRun("run-1", { status: "running" });
    running.store.appendMessage("run-1", { role: "owner", text: "the hero in 1", images: [] });
    assert.equal(running.driver.deliver("run-1"), false, "the ROW is asked too, not only the record");
  } finally {
    running.cleanup();
  }
});

test("A BURST OF REQUESTS RUNS ONE AT A TIME AND NONE IS LOST", async () => {
  // `#inFlight` with a re-reading drain loop. Two turns racing would both read
  // the same record and the second write would erase the first's `rendersUsed` —
  // a cap defeated by typing quickly, with both images already generated.
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "the hero in 1", images: [] });
    r.store.appendMessage("run-1", { role: "owner", text: "the footer in 2", images: [] });
    r.driver.deliver("run-1");
    await waitFor(() => !r.driver.busy("run-1"), "both renders");
    assert.equal(r.rendered.length, 2);
    assert.equal(r.record()?.rendersUsed, 2, "two generations, counted twice — not once");
    assert.equal(r.record()?.turnsUsed, 2);
    assert.deepEqual(r.store.pendingMessages("run-1"), []);
  } finally {
    r.cleanup();
  }
});

test("THE PARK EXPIRES AND PROCEEDS WITH THE DIALOGUE OPEN — the row is what ends it", async () => {
  // THE EXPIRY IS `#parkForDesignLock`'s TIMER AND THIS DRIVER OWNS NO CLOCK. It
  // resumes the run, which flips the row out of `awaiting_input`; the very next
  // question this driver asks then declines, WITHOUT the record having been
  // rewritten. That is what "expires and PROCEEDS" means: the run goes on, mid
  // conversation, and the messages he had not sent yet reach the builder instead.
  const r = rig();
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "the hero in 1", images: [] });
    r.driver.deliver("run-1");
    await waitFor(() => !r.driver.busy("run-1"), "the first render");
    assert.equal(r.rendered.length, 1);

    // The timer fires: `resume()` requeues the run. `design-lock.json` still says
    // `awaiting: true` until `#applyDirectionChoice` rewrites it, which is
    // exactly the window where the record and the row disagree.
    r.store.updateRun("run-1", { status: "queued" });
    assert.equal(r.record()?.awaiting, true, "the record has not caught up yet — that is the window");

    r.store.appendMessage("run-1", { role: "owner", text: "and the footer in 2", images: [] });
    assert.equal(r.driver.deliver("run-1"), false, "no further turn is taken on a run that has moved on");
    assert.equal(r.rendered.length, 1, "and no image is generated for it");
    assert.equal(
      r.store.pendingMessages("run-1").length,
      1,
      "the message he sent after the window closed is NOT lost — it reaches the build segment",
    );
    assert.equal(r.record()?.turnsUsed, 1, "and it costs no turn on a run that is no longer asking");
  } finally {
    r.cleanup();
  }
});

test("A DEGRADED PARK STILL TAKES QUESTIONS AND ANSWERS THEM HONESTLY", async () => {
  // With no key there are no stills, so `refs` is empty and only `directions` is
  // populated. The owner can still ask; the answer is that there is nothing to
  // draw with, said in words rather than as a silent no-op.
  const degraded = parseDesignManifest(
    JSON.stringify({
      version: 1,
      refs: [],
      directions: [
        { slug: "editorial-slab", name: "Editorial slab", distinction: "d", notes: null },
        { slug: "quiet-grid", name: "Quiet grid", distinction: "d", notes: null },
        { slug: "warm-stack", name: "Warm stack", distinction: "d", notes: null },
      ],
    }),
    WS,
  );
  const r = rig(degraded);
  try {
    park(r, "run-1");
    r.result.value = {
      outcome: "failed",
      detail: "there is no image generation on this machine",
      path: null,
      attempted: false,
    };
    r.store.appendMessage("run-1", { role: "owner", text: "show me the contact section in 2", images: [] });
    assert.equal(r.driver.deliver("run-1"), true, "the question is heard");
    await waitFor(() => !r.driver.busy("run-1"), "the answer");
    assert.match(String(r.record()?.requests[0]?.detail), /no image generation/);
    // AND IT IS NOT BILLED. Nothing was invoked, so nothing was spent — a lane
    // that can never draw would otherwise exhaust its render budget on six
    // honest refusals and then tell him the budget was the reason.
    assert.equal(r.record()?.rendersUsed, 0, "a generation nobody attempted is not a render");
    assert.equal(r.record()?.turnsUsed, 1, "the turn IS spent: he asked, and the park answered him");
  } finally {
    r.cleanup();
  }
});

test("A DECLINE IS STILL SAID WHEN ANOTHER REQUEST IS ALREADY PENDING — the guard's own blind spot", async () => {
  /*
   * REPRODUCED BY AN AUDIT AGAINST `dist`, and it is this file's own pattern one
   * level down: `deliver` asked "does ANY eligible pending message parse as a
   * request" while the state that owes a notice is "the message that JUST
   * ARRIVED was declined". The two differ the moment a second message is queued:
   *
   *   he asks   "show me the hero in editorial slab"   -> a render starts
   *   he types  "I like design 2, but make the hero taller"
   *
   * The first is still in `#requests`, so the old guard found one, skipped the
   * notice ON ALL FIVE ARMS at once, and `http.ts` logged that his message had
   * been "taken up ... as a request to render a section" — an affirmative
   * sentence about a message nothing would ever render. He then waits out the
   * park's clock for a picture that is not coming.
   *
   * The instruction itself was never lost — it stays pending for the build — so
   * what the old guard cost was the NOTICE and the truth of that log line.
   */
  const r = rig();
  try {
    park(r, "run-1");
    // A genuine request, left pending: this is the message whose presence used to
    // suppress the notice for everything queued behind it.
    r.store.appendMessage("run-1", { role: "owner", text: "show me the hero in editorial slab", images: [] });
    // ...and the instruction he types while that one is still in the queue.
    r.store.appendMessage("run-1", {
      role: "owner",
      text: "I like design 2, but make the hero taller",
      images: [],
    });

    const claimed = r.driver.deliver("run-1");

    assert.equal(claimed, false, "the newest message is an instruction, so the route must not claim it");
    assert.ok(
      r.logs.some((line) => line.startsWith("warn:") && line.includes("Quiet grid") && line.includes("show me")),
      `the decline has to be said even with another request queued: ${JSON.stringify(r.logs)}`,
    );
    // The properties the notice exists to protect, unchanged by the queue.
    assert.equal(r.record()?.turnsUsed, 0, "free");
    assert.equal(r.record()?.rendersUsed, 0, "and nothing spent");
    assert.equal(
      r.store.pendingMessages("run-1").length,
      2,
      "NEITHER message is stamped: the request is still to be served, the instruction still reaches the build",
    );
  } finally {
    r.cleanup();
  }
});

test("A DIRECTION WHOSE NAME READS AS AN INSTRUCTION IS OFFERED BY NUMBER, NOT BY THAT NAME", () => {
  /*
   * `BUILD_INSTRUCTION` is matched against the whole message and `cut` and `drop`
   * are both imperatives, so for a direction the lane called "Cut paper",
   * `show me the hero in cut paper` is DECLINED — and the notice used to answer
   * that by advising the identical sentence. Measured against `dist` with these
   * exact names before the fix.
   *
   * The ordinal never carries the name, so it always works; when the name cannot,
   * it leads alone rather than sitting behind a suggestion that provably fails.
   */
  const manifest = canvassManifest();
  const renamed: DesignManifest = {
    ...manifest,
    directions: manifest.directions.map((d, i) => (i === 0 ? { ...d, name: "Cut paper", slug: "cut-paper" } : d)),
  };
  const r = rig(renamed);
  try {
    park(r, "run-1");
    r.store.appendMessage("run-1", { role: "owner", text: "show me the hero in cut paper", images: [] });
    assert.equal(r.driver.deliver("run-1"), false, "the direction's own name trips the veto, so it is declined");
    const notice = r.logs.find((line) => line.startsWith("warn:"));
    assert.ok(notice !== undefined, `expected a decline notice: ${JSON.stringify(r.logs)}`);
    assert.ok(notice.includes('"show me the hero in 1"'), `the ordinal must be offered: ${notice}`);
    assert.equal(
      notice.includes('"show me the hero in Cut paper"'),
      false,
      `the notice advised the exact sentence that just failed: ${notice}`,
    );
  } finally {
    r.cleanup();
  }
});
