/**
 * claude-common.test.ts — reading a run's REAL token spend off the result frame
 * (Phase 1.1 Task 5).
 *
 * THE DEFECT. `extractTokens(result.usage)` returns four scalars and no model
 * name, so a run that delegated most of its work reported one number and the UI
 * labelled it with the run's own `modelId`. Measured on a live Phase 1 build:
 * three quarters of the spend ran on OPUS subagents while the run said `haiku`.
 *
 * WHAT THE SDK ACTUALLY CARRIES, verified against
 * `@anthropic-ai/claude-agent-sdk@0.3.220`'s `sdk.d.ts` and the CLI binary it
 * ships, because a field name invented here would be a fabricated number
 * downstream:
 *
 *   `SDKResultMessage.modelUsage: Record<string, ModelUsage>` — per model, with
 *   `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
 *   `cacheCreationInputTokens` (and `costUSD`, which this module drops at the
 *   boundary; see the header of claude-common.ts).
 *
 *   `SDKResultMessage.usage` — in the shipped CLI this is COMPUTED as the
 *   per-field sum over `modelUsage`, so the scalar and the breakdown describe
 *   the same quantity. The breakdown is therefore the finer-grained statement of
 *   the total, not a second opinion about it.
 *
 *   `task_notification.usage.total_tokens` and the Agent tool's own report are
 *   NOT billed figures (a progress estimate and a last-turn snapshot
 *   respectively) and are deliberately never added to a total. See the report in
 *   the commit message.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractTokens, resultTokens, usageDisagreement } from "./claude-common.js";
import type { ResultUsageEnvelope } from "./claude-common.js";
import { modelRows } from "./tokens.js";

/**
 * A `ModelUsage` entry as the SDK really declares it — the token counts PLUS the
 * modelled dollar figure and the web-search count. Written out in full so the
 * "cost is dropped at the boundary" test is run against the real shape rather
 * than against a fixture that already omits the field.
 */
type SdkModelUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUSD: number;
};

const DELEGATED_MODEL_USAGE: Readonly<Record<string, SdkModelUsage>> = {
  "claude-haiku-4-5-20251001": {
    inputTokens: 2_400,
    outputTokens: 960,
    cacheReadInputTokens: 480,
    cacheCreationInputTokens: 120,
    webSearchRequests: 0,
    costUSD: 0.42,
  },
  "claude-opus-5[1m]": {
    inputTokens: 7_600,
    outputTokens: 3_040,
    cacheReadInputTokens: 1_520,
    cacheCreationInputTokens: 380,
    webSearchRequests: 0,
    costUSD: 13.37,
  },
};

/**
 * A result frame shaped like the SDK's: a haiku orchestrator that delegated most
 * of the work to opus subagents. The numbers are the shape of the measured
 * failure — 76% of the spend on a model the run never claimed to be using.
 */
function delegatedResult(overrides: Partial<ResultUsageEnvelope> = {}): ResultUsageEnvelope {
  return {
    usage: {
      input_tokens: 10_000,
      output_tokens: 4_000,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 500,
    },
    modelUsage: DELEGATED_MODEL_USAGE,
    num_turns: 12,
    ...overrides,
  };
}

/**
 * The same frame with its scalar `usage` SKEWED away from its own rows.
 *
 * IT IS THE ONLY FIXTURE THAT DISCRIMINATES, and that is why it is hoisted here
 * rather than left inline in the one test that used it. `delegatedResult()`'s
 * rows sum EXACTLY to its scalar — 2400+7600 = 10000, 960+3040 = 4000,
 * 480+1520 = 2000, 120+380 = 500 — because that is what the shipped CLI
 * produces. Every assertion built on it therefore passes whether `resultTokens`
 * takes its totals from the rows or from the scalar, so the claim in this
 * module's header ("the totals below are taken from the rows") was documented,
 * commented, and pinned by NOTHING. 40,000 input against a row sum of 10,000 is
 * what makes the two paths give different answers.
 */
function skewedResult(): ResultUsageEnvelope {
  return delegatedResult({
    usage: {
      input_tokens: 40_000,
      output_tokens: 4_000,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 500,
    },
  });
}

test("the run's tokens are keyed PER MODEL, not collapsed onto the orchestrator", () => {
  const tokens = resultTokens(delegatedResult());
  assert.deepEqual(modelRows(tokens), [
    {
      model: "claude-haiku-4-5-20251001",
      inputTokens: 2_400,
      outputTokens: 960,
      cacheReadTokens: 480,
      cacheWriteTokens: 120,
    },
    {
      model: "claude-opus-5[1m]",
      inputTokens: 7_600,
      outputTokens: 3_040,
      cacheReadTokens: 1_520,
      cacheWriteTokens: 380,
    },
  ]);
});

test("the total covers every model, and the rows sum to it", () => {
  const tokens = resultTokens(delegatedResult());
  assert.equal(tokens.inputTokens, 10_000);
  assert.equal(tokens.outputTokens, 4_000);
  assert.equal(tokens.cacheReadTokens, 2_000);
  assert.equal(tokens.cacheWriteTokens, 500);
  assert.equal(
    modelRows(tokens).reduce((n, r) => n + r.outputTokens, 0),
    tokens.outputTokens,
  );
});

test("the SUBAGENT model is the majority of the spend, and it is visible as such", () => {
  const rows = modelRows(resultTokens(delegatedResult()));
  const opus = rows.find((r) => r.model.startsWith("claude-opus"));
  assert.ok(opus !== undefined, "the opus subagent spend was not reported at all");
  assert.equal(opus.outputTokens, 3_040);
});

test("THE COST FIELD IS DROPPED — no dollar figure survives the boundary", () => {
  const serialised = JSON.stringify(resultTokens(delegatedResult()));
  assert.equal(/cost|usd/i.test(serialised), false, `a cost field reached the boundary: ${serialised}`);
  assert.equal(serialised.includes("13.37"), false);
});

test("the model key is recorded VERBATIM — no alias is normalised away", () => {
  const rows = modelRows(resultTokens(delegatedResult()));
  assert.deepEqual(
    rows.map((r) => r.model),
    ["claude-haiku-4-5-20251001", "claude-opus-5[1m]"],
  );
});

test("turns are the call count, as before", () => {
  assert.equal(resultTokens(delegatedResult()).callCount, 12);
  assert.equal(resultTokens(delegatedResult({ num_turns: 1 })).callCount, 1);
});

test("no per-model report means no models CLAIMED — the totals still stand", () => {
  const tokens = resultTokens({
    usage: { input_tokens: 10, output_tokens: 2 },
    modelUsage: {},
    num_turns: 1,
  });
  assert.deepEqual(modelRows(tokens), []);
  assert.equal(tokens.inputTokens, 10);
  assert.equal(tokens.outputTokens, 2);
});

test("a field the CLI did not report is 0, and nothing is invented", () => {
  const tokens = resultTokens({
    usage: { input_tokens: 5 },
    modelUsage: { "claude-opus-5": { inputTokens: 5 } },
    num_turns: 1,
  });
  assert.deepEqual(modelRows(tokens), [
    {
      model: "claude-opus-5",
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
  assert.equal(tokens.provider, "anthropic");
});

test("the breakdown and the scalar agreeing is checked, not assumed", () => {
  assert.equal(usageDisagreement(delegatedResult()), null);
  assert.equal(usageDisagreement({ usage: { input_tokens: 3 }, num_turns: 1 }), null);
});

test("a CLI whose scalar and breakdown disagree is REPORTED, not silently trusted", () => {
  const said = usageDisagreement(skewedResult());
  assert.ok(said !== null, "a 30,000-token disagreement was not reported");
  assert.match(said, /40000|40,000/);
  assert.match(said, /10000|10,000/);
});

test("THE TOTALS COME FROM THE ROWS, not from the frame's own scalar", () => {
  // WHAT NO OTHER TEST HERE CAN SEE. On `delegatedResult()` the rows sum exactly
  // to the scalar, so `sumRows(rows)` and `extractTokens(result.usage)` return
  // the same four numbers and every assertion above holds under either
  // implementation. On this frame they differ by 30,000 input, so this is the
  // assertion that says WHICH one runs — the claim made in the header of
  // claude-common.ts, in the header of tokens.ts and in a code comment, and
  // until now checked by nothing.
  const tokens = resultTokens(skewedResult());

  assert.equal(tokens.inputTokens, 10_000, "the CLI's scalar was reported instead of its rows");
  assert.equal(
    JSON.stringify(tokens).includes("40000"),
    false,
    "no part of the scalar-sourced total may survive",
  );
  // The rows are untouched by the skew and still sum to what was reported: the
  // breakdown cannot disagree with the total it breaks down.
  assert.equal(
    modelRows(tokens).reduce((n, r) => n + r.inputTokens, 0),
    tokens.inputTokens,
  );
  // And the same frame is what `usageDisagreement` speaks up about, so the total
  // and the warning are two views of one check rather than two opinions.
  assert.ok(usageDisagreement(skewedResult()) !== null);
});

test("NO rows means the scalar STANDS — the fallback path, and it is the other answer", () => {
  // The negative control on the test above. "Take the totals from the rows" must
  // not become "report 0 when a vendor states no breakdown": the Codex-shaped
  // case is a frame with no `modelUsage` at all, and there the scalar is the only
  // statement anyone made.
  const tokens = resultTokens({ usage: { input_tokens: 40_000, output_tokens: 4_000 }, num_turns: 3 });
  assert.equal(tokens.inputTokens, 40_000);
  assert.equal(tokens.callCount, 3);
  assert.deepEqual(modelRows(tokens), []);
});

test("REGRESSION GUARD: extractTokens still reads one usage payload the old way", () => {
  assert.deepEqual(
    extractTokens(
      {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      } as never,
      4,
    ),
    {
      provider: "anthropic",
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      callCount: 4,
      byModel: [],
    },
  );
});
