/**
 * tokens.test.ts — the token arithmetic, and the per-model split that makes a
 * delegated run's spend readable (Phase 1.1 Task 5).
 *
 * THE DEFECT THIS PROTECTS AGAINST. A run reported ONE token figure and the UI
 * labelled it with the run's `modelId`. Delegation is the whole architecture
 * here: the orchestrator can be haiku while three quarters of the spend runs on
 * opus subagents, and a single figure under one model name is not a smaller
 * truth — it is a false statement about which model did the work.
 *
 * WHAT IS ASSERTED, AND WHY IT MATTERS MORE THAN IT LOOKS. `TokenTotals` had no
 * test file at all before this one, so `zeroTokens`/`addTokens` — the arithmetic
 * every seat and every driver runs through — carried three guarantees nobody
 * checked: zero is an identity, the sum is order-independent, and adding across
 * vendors THROWS rather than producing a number that means nothing. They are
 * asserted here first, so the per-model rows added on top cannot quietly break
 * them.
 *
 * THE INVARIANT THE WHOLE FEATURE RESTS ON: the per-model rows must sum to the
 * scalar totals. A breakdown that disagrees with the total it breaks down is the
 * exact failure this task exists to fix, so it is checked after arbitrary
 * sequences of additions, not just once.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ApiSeatSpend, ApiSpendSeat } from "./api-types.js";
import {
  NOT_PRICED,
  addTokens,
  describeTokens,
  mergeTokenTotals,
  modelRows,
  runSpend,
  spendByVendor,
  toApiTokens,
  toSeatSpend,
  unattributedTokens,
  vendorSpend,
  zeroTokens,
} from "./tokens.js";
import type { ModelTokens, TokenTotals } from "./tokens.js";

function totals(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return { ...zeroTokens("anthropic"), inputTokens: 100, outputTokens: 20, callCount: 1, ...overrides };
}

function row(model: string, overrides: Partial<ModelTokens> = {}): ModelTokens {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

/** Per-field sum of a set of rows — what the scalar totals must equal. */
function sumOf(rows: readonly ModelTokens[]): Record<string, number> {
  return {
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
    cacheReadTokens: rows.reduce((n, r) => n + r.cacheReadTokens, 0),
    cacheWriteTokens: rows.reduce((n, r) => n + r.cacheWriteTokens, 0),
  };
}

/* ── the guarantees that already existed, asserted for the first time ────── */

test("zero is an identity on both sides, and adds no call", () => {
  const zero = zeroTokens("anthropic");
  const some = totals({ cacheReadTokens: 7, cacheWriteTokens: 3, callCount: 4 });
  assert.deepEqual(addTokens(zero, some), some);
  assert.deepEqual(addTokens(some, zero), some);
  assert.equal(zero.callCount, 0);
});

test("addition is order-independent IN THE SUMS — row ORDER is not canonical", () => {
  const a = totals({ inputTokens: 11, outputTokens: 2, callCount: 1 });
  const b = totals({ inputTokens: 5, cacheReadTokens: 9, callCount: 3 });
  assert.deepEqual(addTokens(a, b), addTokens(b, a));
  assert.equal(addTokens(a, b).callCount, 4);

  // WHAT THE THREE LINES ABOVE DO NOT PROVE. Both fixtures leave `byModel`
  // EMPTY, so the whole-object comparison sees four scalars and a call count and
  // nothing else — the test was titled for a guarantee it never reached. With
  // rows present the two results are NOT deep-equal, and that is DELIBERATE:
  // mergeModelRows orders FIRST-SEEN, because the orchestrator's own model is
  // the first thing a run reports and a reader scanning the log reads the models
  // in the order the run acquired them.
  const withHaiku = totals({
    inputTokens: 100,
    outputTokens: 10,
    callCount: 1,
    byModel: [row("claude-haiku-4-5", { inputTokens: 100, outputTokens: 10 })],
  });
  const withOpus = totals({
    inputTokens: 200,
    outputTokens: 20,
    callCount: 2,
    byModel: [row("claude-opus-5[1m]", { inputTokens: 200, outputTokens: 20 })],
  });
  const forward = addTokens(withHaiku, withOpus);
  const backward = addTokens(withOpus, withHaiku);

  // THE SUMS ARE ORDER-INSENSITIVE: the four scalars, the call count, and each
  // model's own row. This is the guarantee the title claims, asserted on a
  // fixture that can actually break it.
  assert.deepEqual(toApiTokens(forward), toApiTokens(backward));
  assert.equal(forward.callCount, backward.callCount);
  assert.equal(forward.callCount, 3);
  const sorted = (t: TokenTotals): ModelTokens[] =>
    [...modelRows(t)].sort((x, y) => x.model.localeCompare(y.model));
  assert.deepEqual(sorted(forward), sorted(backward));

  // THE ROW ORDER IS NOT, and it is pinned rather than left for the next reader
  // to discover by writing `deepEqual(addTokens(a, b), addTokens(b, a))` and
  // watching it fail. `deepEqual` on the whole object is exactly that assertion,
  // and it goes red here — demonstrated before this line replaced it.
  assert.deepEqual(
    modelRows(forward).map((r) => r.model),
    ["claude-haiku-4-5", "claude-opus-5[1m]"],
  );
  assert.deepEqual(
    modelRows(backward).map((r) => r.model),
    ["claude-opus-5[1m]", "claude-haiku-4-5"],
  );
});

test("tokens are NEVER summed across vendors — it throws", () => {
  assert.throws(() => addTokens(zeroTokens("anthropic"), zeroTokens("openai")), /never summed|refusing/i);
});

test("toApiTokens ships the four counts and nothing else — no vendor, no models", () => {
  const withModels = totals({ byModel: [row("claude-opus-5", { inputTokens: 100, outputTokens: 20 })] });
  assert.deepEqual(toApiTokens(withModels), {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

/* ── the per-model split ─────────────────────────────────────────────────── */

test("a row with no breakdown reports no models rather than a made-up one", () => {
  assert.deepEqual(modelRows(zeroTokens("anthropic")), []);
  assert.deepEqual(modelRows(totals()), []);
});

test("adding merges rows PER MODEL — a haiku orchestrator and opus subagents stay apart", () => {
  const first = totals({
    inputTokens: 300,
    outputTokens: 30,
    byModel: [
      row("claude-haiku-4-5", { inputTokens: 100, outputTokens: 10 }),
      row("claude-opus-5[1m]", { inputTokens: 200, outputTokens: 20 }),
    ],
  });
  const second = totals({
    inputTokens: 400,
    outputTokens: 5,
    byModel: [row("claude-opus-5[1m]", { inputTokens: 400, outputTokens: 5 })],
  });

  const merged = addTokens(first, second);
  assert.deepEqual(modelRows(merged), [
    row("claude-haiku-4-5", { inputTokens: 100, outputTokens: 10 }),
    row("claude-opus-5[1m]", { inputTokens: 600, outputTokens: 25 }),
  ]);
  assert.equal(merged.inputTokens, 700);
});

test("a model seen only on the right-hand side is appended, not dropped", () => {
  const merged = addTokens(
    totals({ inputTokens: 10, outputTokens: 0, byModel: [row("claude-haiku-4-5", { inputTokens: 10 })] }),
    totals({ inputTokens: 0, outputTokens: 7, byModel: [row("claude-opus-5", { outputTokens: 7 })] }),
  );
  assert.deepEqual(
    modelRows(merged).map((r) => r.model),
    ["claude-haiku-4-5", "claude-opus-5"],
  );
});

test("THE INVARIANT: the rows sum to the totals, after any sequence of additions", () => {
  let running: TokenTotals = zeroTokens("anthropic");
  const contributions: readonly TokenTotals[] = [
    totals({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      byModel: [
        row("claude-haiku-4-5", { inputTokens: 40, outputTokens: 4, cacheReadTokens: 5 }),
        row("claude-opus-5", { inputTokens: 60, outputTokens: 6, cacheWriteTokens: 1 }),
      ],
    }),
    totals({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 2,
      byModel: [row("claude-opus-5", { inputTokens: 7, outputTokens: 3, cacheWriteTokens: 2 })],
    }),
    totals({
      inputTokens: 1,
      outputTokens: 1,
      byModel: [row("claude-sonnet-5", { inputTokens: 1, outputTokens: 1 })],
    }),
  ];
  for (const contribution of contributions) {
    running = addTokens(running, contribution);
    assert.deepEqual(sumOf(modelRows(running)), {
      inputTokens: running.inputTokens,
      outputTokens: running.outputTokens,
      cacheReadTokens: running.cacheReadTokens,
      cacheWriteTokens: running.cacheWriteTokens,
    });
  }
  assert.equal(modelRows(running).length, 3);
});

test("tokens NO model claimed are reported as unattributed, not folded into one", () => {
  // A vendor that reports no per-model split at all (the Codex driver) is the
  // ordinary case: everything is unattributed and nothing is invented.
  assert.deepEqual(unattributedTokens(totals({ inputTokens: 100, outputTokens: 20 })), {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // A fully attributed row has no remainder.
  const attributed = totals({
    inputTokens: 100,
    outputTokens: 20,
    byModel: [row("claude-opus-5", { inputTokens: 100, outputTokens: 20 })],
  });
  assert.deepEqual(unattributedTokens(attributed), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("a partly attributed row keeps the remainder visible instead of dropping it", () => {
  const partial = totals({
    inputTokens: 100,
    outputTokens: 20,
    byModel: [row("claude-opus-5", { inputTokens: 90, outputTokens: 15 })],
  });
  assert.deepEqual(unattributedTokens(partial), {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

/* ── the human-readable line, which is where the defect was visible ──────── */

test("the log line NAMES EVERY MODEL — this is the line that lied about haiku", () => {
  const line = describeTokens(
    totals({
      inputTokens: 300,
      outputTokens: 30,
      callCount: 2,
      byModel: [
        row("claude-haiku-4-5", { inputTokens: 100, outputTokens: 10 }),
        row("claude-opus-5[1m]", { inputTokens: 200, outputTokens: 20 }),
      ],
    }),
  );
  assert.match(line, /anthropic: 300 input/);
  assert.match(line, /claude-haiku-4-5: 100 input/);
  assert.match(line, /claude-opus-5\[1m\]: 200 input/);
});

test("with no breakdown the line is exactly what it always was", () => {
  assert.equal(
    describeTokens(totals({ inputTokens: 100, outputTokens: 20, callCount: 1 })),
    "anthropic: 100 input, 0 cache read, 0 cache write, 20 output over 1 call(s)",
  );
});

test("an unexplained remainder is SAID, not hidden inside a model's figure", () => {
  const line = describeTokens(
    totals({
      inputTokens: 100,
      outputTokens: 20,
      byModel: [row("claude-opus-5", { inputTokens: 90, outputTokens: 20 })],
    }),
  );
  assert.match(line, /unattributed: 10 input/);
});

/* -------------------------------------------------------------------------
 * The two-segment merge
 * ---------------------------------------------------------------------- */

test("a second segment never LOWERS the run's reported totals", () => {
  // THE DEFECT, EXACTLY. The build phase is two builder.build() calls against
  // one session, and the orchestrator wrote toApiTokens(outcome.tokens) onto the
  // row after each. A design segment that spent 1000 followed by a build segment
  // that reported 10 left the run claiming 10 — a number smaller than what the
  // owner had already been shown.
  const afterDesign = { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 3 };
  const segmentTwo = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const merged = mergeTokenTotals(afterDesign, segmentTwo);
  assert.ok(merged.inputTokens >= afterDesign.inputTokens);
  assert.equal(merged.inputTokens, 1010, "per-call totals, so the run's spend is their sum");
});

test("EVERY field is carried, including the ones the FIRST segment led on", () => {
  // WHY A SUM AND NOT A MAX, and this is the assertion that tells them apart.
  // `design-segment-probe.mjs` measured a resumed session reporting LESS than its
  // first segment on cacheWrite (2469 -> 91), which is only possible for per-call
  // totals. Under a field-wise max, segment 2's 91 cache-write and its 71 output
  // would vanish entirely because segment 1 happened to lead on both.
  const first = { inputTokens: 10, outputTokens: 61, cacheReadTokens: 15232, cacheWriteTokens: 2469 };
  const resumed = { inputTokens: 10, outputTokens: 71, cacheReadTokens: 17701, cacheWriteTokens: 91 };
  assert.deepEqual(mergeTokenTotals(first, resumed), {
    inputTokens: 20,
    outputTokens: 132,
    cacheReadTokens: 32933,
    cacheWriteTokens: 2560,
  });
});

test("the merge is field-wise, so no field borrows another's number", () => {
  const previous = { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 };
  const incoming = { inputTokens: 20, outputTokens: 700, cacheReadTokens: 1, cacheWriteTokens: 60 };
  assert.deepEqual(mergeTokenTotals(previous, incoming), {
    inputTokens: 1020,
    outputTokens: 705,
    cacheReadTokens: 901,
    cacheWriteTokens: 60,
  });
});

/* -------------------------------------------------------------------------
 * Spend, attributed by seat
 *
 * The four measured OUTPUT figures from the live run — spec 416,111, audit
 * 17,603, judge 3,228, builder 88,529 — are used as fixtures throughout, so a
 * failure names the seat that was dropped rather than reporting that 6 is not 4.
 * ---------------------------------------------------------------------- */

function seatRow(seat: ApiSpendSeat, provider: "anthropic" | "openai", output: number): ApiSeatSpend {
  return toSeatSpend({
    seat,
    modelId: `${provider}-model`,
    totals: { ...zeroTokens(provider), inputTokens: 5, outputTokens: output, callCount: 1 },
  });
}

const MEASURED_SEATS: readonly ApiSeatSpend[] = [
  seatRow("spec", "anthropic", 416_111),
  seatRow("audit", "anthropic", 17_603),
  seatRow("judge", "anthropic", 3_228),
  seatRow("builder", "anthropic", 88_529),
];

test("a contribution carries its seat's VENDOR — the row cannot be filed under another", () => {
  const row = toSeatSpend({
    seat: "builder",
    modelId: "gpt-6-codex",
    totals: { ...zeroTokens("openai"), outputTokens: 88_529, callCount: 2 },
  });
  assert.equal(row.provider, "openai", "the vendor comes from the totals, not from a caller's argument");
  assert.equal(row.callCount, 2);
  assert.equal(row.tokens.outputTokens, 88_529);
});

test("THE TOTAL IS EVERY SEAT: 525,471 output, and 88,529 is one seat of four", () => {
  const vendors = spendByVendor(MEASURED_SEATS);
  assert.equal(vendors.length, 1);
  assert.equal(vendors[0]?.tokens.outputTokens, 525_471);
  assert.notEqual(vendors[0]?.tokens.outputTokens, 88_529, "that is the builder's row, not the run's total");
  assert.equal(vendors[0]?.callCount, 4);
  assert.deepEqual([...(vendors[0]?.seats ?? [])], ["spec", "audit", "judge", "builder"]);
});

test("two vendors are two rows — the cross-vendor sum is never produced", () => {
  // A Codex run: OpenAI builder, three Anthropic control seats. `addTokens`
  // THROWS on a vendor mismatch, so a reduce over this list would not return a
  // wrong number — it would take down whatever was writing the record. Grouping
  // first is why this returns at all, and the assertions pin both halves.
  const mixed: readonly ApiSeatSpend[] = [
    seatRow("spec", "anthropic", 416_111),
    seatRow("builder", "openai", 88_529),
    seatRow("audit", "anthropic", 17_603),
    seatRow("judge", "anthropic", 3_228),
  ];
  const vendors = spendByVendor(mixed);
  assert.equal(vendors.length, 2);
  // FIRST-SEEN ORDER, the same rule `mergeModelRows` follows: anthropic appeared
  // first in the list, so it is first here.
  assert.deepEqual(
    vendors.map((row) => row.provider),
    ["anthropic", "openai"],
  );
  assert.equal(vendors[0]?.tokens.outputTokens, 436_942);
  assert.equal(vendors[1]?.tokens.outputTokens, 88_529);
  for (const row of vendors) {
    assert.notEqual(row.tokens.outputTokens, 525_471, "the two vendors were added together");
  }
});

test("a seat that reports on two models is named ONCE in its vendor row", () => {
  const vendors = spendByVendor([
    seatRow("spec", "anthropic", 400_000),
    { ...seatRow("spec", "anthropic", 16_111), modelId: "claude-haiku-4-5" },
  ]);
  assert.equal(vendors[0]?.tokens.outputTokens, 416_111, "both models are in the total");
  assert.deepEqual([...(vendors[0]?.seats ?? [])], ["spec"], "one seat, however many models it ran on");
});

test("an empty seat list produces NO vendor row — never a zeroed one", () => {
  // A zeroed row would read as "this vendor was measured and spent nothing",
  // which is the claim `ApiRunSpend`'s docblock refuses: an empty record means
  // nothing was recorded.
  assert.deepEqual(spendByVendor([]), []);
  const spend = runSpend([], []);
  assert.deepEqual(spend.byVendor, []);
  assert.deepEqual(spend.bySeat, []);
  assert.equal(vendorSpend(spend, "anthropic"), null, "and asking for one answers null, not a zero row");
});

test("the record's per-vendor totals are DERIVED, so they cannot disagree with the seats", () => {
  const spend = runSpend(MEASURED_SEATS, [
    { kind: "image", model: "gemini-3.1-flash-image-preview", calls: 5, deliveredSecondsFloor: null },
  ]);
  const fromSeats = spend.bySeat.reduce((total, row) => total + row.tokens.outputTokens, 0);
  assert.equal(vendorSpend(spend, "anthropic")?.tokens.outputTokens, fromSeats);
  assert.equal(fromSeats, 525_471);
  // The metered rows carry no tokens and are folded into no token total.
  assert.equal(spend.metered.length, 1);
  assert.equal(spend.metered[0]?.deliveredSecondsFloor, null, "an image call is not billed by time");
});

test("the pricing basis is a STATEMENT, not a zero", () => {
  // `costUsd: null` and `run.json`'s `totalCostUsd: 0` are both read as "free" at
  // the end of a long build. This literal is the only thing on the wire that says
  // otherwise, so it is pinned verbatim here and in the client's mirror.
  assert.equal(NOT_PRICED, "not-priced-subscription-seat");
  assert.equal(runSpend(MEASURED_SEATS, []).pricing, NOT_PRICED);
  assert.notEqual(String(runSpend([], []).pricing), "0");
});

test("a run with nothing recorded yet takes the incoming row verbatim, never zeroes", () => {
  // `RunRow.tokens` is null until the first token event. Treating null as a zero
  // row would work by accident here and would be a claim ("this run reported 0")
  // the moment any field of `incoming` were absent.
  const incoming = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(mergeTokenTotals(null, incoming), incoming);
});
