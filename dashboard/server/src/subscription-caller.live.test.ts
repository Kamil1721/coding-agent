/**
 * subscription-caller.live.test.ts — the one test that actually talks to the
 * subscription.
 *
 * IT IS OFF BY DEFAULT. `npm test` must never spend the owner's quota, so this
 * file no-ops unless DASHBOARD_LIVE_SMOKE=1. Run it deliberately:
 *
 *   DASHBOARD_LIVE_SMOKE=1 npm test
 *
 * WHAT IT PROVES, WHICH NOTHING ELSE CAN. Every other test stubs the model. The
 * claim this module rests on is that the EXISTING spec agent's seat-call path
 * can be driven with NO API KEY, over the CLI's subscription login, and that
 * the placeholder credential never reaches the network. That is only knowable
 * by running it: a passing type-check proves the subclass compiles, not that
 * the base class's HTTP client stayed unused.
 *
 * It is deliberately the SMALLEST call that can prove it — a five-word prompt
 * at the lowest effort rung — rather than a full suite authoring pass, because
 * the point is the wiring, not the output.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";
import { DASHBOARD_BUDGET } from "./orchestrator.js";
import { SubscriptionSeatCaller } from "./subscription-caller.js";

const LIVE = (process.env["DASHBOARD_LIVE_SMOKE"] ?? "") === "1";

test(
  "the spec seat runs over the subscription with no API key in the environment",
  { skip: LIVE ? false : "set DASHBOARD_LIVE_SMOKE=1 to spend a small amount of quota on this" },
  async () => {
    // The lowest rung this seat's ladder allows, and the CLI's own default
    // model. Both chosen to make the call cheap; neither is what a real spec
    // seat uses (doc 03 section 7.4 pins Opus-class xhigh).
    const seat: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };

    // The environment handed to the caller has NO Anthropic key. If the
    // subscription path were not working, the base class's client would be the
    // only way out, and it holds nothing but the sentinel.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    delete env["ANTHROPIC_BASE_URL"];

    const caller = new SubscriptionSeatCaller(seat, {
      budget: DASHBOARD_BUDGET,
      cwd: tmpdir(),
      env,
    });

    const result = await caller.call({
      system: "Reply with the single word: ready. Nothing else.",
      userTurns: ["Are you there?"],
      maxOutputTokens: 64,
      jsonSchema: null,
      purpose: "dashboard live smoke",
    });

    assert.match(result.text.toLowerCase(), /ready/, `unexpected reply: ${result.text.slice(0, 200)}`);
    assert.ok(result.usage.outputTokens > 0, "the subscription reported no output tokens");
    assert.equal(result.usage.costUsd, 0, "a subscription call has no dollar cost");
    assert.equal(caller.tokens.callCount, 1);
    assert.ok(caller.tokens.inputTokens > 0, "input tokens should be reported");

    // THE LOAD-BEARING ASSERTION: the base class recorded no usage, which means
    // its API-key client was never dispatched. Only the overridden call() ran.
    assert.doesNotThrow(() => caller.assertUnused());
    assert.equal(caller.hasUsage, false);
  },
);

test(
  "a SeatCallRequest's jsonSchema is APPLIED, not silently dropped",
  { skip: LIVE ? false : "set DASHBOARD_LIVE_SMOKE=1 to spend a small amount of quota on this" },
  async () => {
    // spec-agent sends `AUTHORING_JSON_SCHEMA` on every authoring call. If the
    // override quietly ignored it, the failure would present three layers up as
    // "the model keeps returning unparseable suites" — the most expensive way
    // possible to discover a dropped option. STATUS section 4 names this exact
    // parameter combination as the one that could not be verified without a
    // live credential; this verifies it over the subscription instead.
    const seat: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];

    const caller = new SubscriptionSeatCaller(seat, { budget: DASHBOARD_BUDGET, cwd: tmpdir(), env });
    const result = await caller.call({
      system: "You answer with structured data only.",
      userTurns: ["The colour is blue and the count is 3."],
      maxOutputTokens: 256,
      jsonSchema: {
        type: "object",
        properties: { colour: { type: "string" }, count: { type: "integer" } },
        required: ["colour", "count"],
        additionalProperties: false,
      },
      purpose: "dashboard schema smoke",
    });

    const parsed = JSON.parse(result.text) as { colour: string; count: number };
    assert.equal(parsed.colour.toLowerCase(), "blue");
    assert.equal(parsed.count, 3);
    assert.doesNotThrow(() => caller.assertUnused());
  },
);
