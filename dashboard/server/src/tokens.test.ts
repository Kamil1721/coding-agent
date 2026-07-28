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
import {
  addTokens,
  describeTokens,
  modelRows,
  toApiTokens,
  unattributedTokens,
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

test("addition is order-independent", () => {
  const a = totals({ inputTokens: 11, outputTokens: 2, callCount: 1 });
  const b = totals({ inputTokens: 5, cacheReadTokens: 9, callCount: 3 });
  assert.deepEqual(addTokens(a, b), addTokens(b, a));
  assert.equal(addTokens(a, b).callCount, 4);
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
