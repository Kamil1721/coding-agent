/**
 * orchestrator.spec-model.test.ts — the spec seat cannot be handed a model that
 * silently caps below the rung the spec agent climbs to.
 *
 * ─── THE CORPSE ───
 *
 * `run-2026-08-04T11-08-10-487Z-162b186d` died in the spec phase after 49
 * minutes with the CLI's own words: "Claude's response exceeded the 64000
 * output token maximum. To configure this behavior, set the
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable." The harness now sets
 * that variable and `spec-agent` climbs to {@link MAX_STREAMABLE_OUTPUT_TOKENS}
 * on a truncation — but the climb is worth nothing if the model at the other
 * end caps lower, because THE CLI CAPS SILENTLY. Measured 2026-08-09 against
 * the SDK's own bundled binary: `CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000` on a
 * Haiku-4.5 dispatch logged `Capped from 128000 to 64000` on a `[DEBUG]` line
 * and the call still returned `subtype=success`. Nothing in this harness reads
 * that line. There is no error to catch and no field to assert on; the only
 * place the ceiling can be checked is BEFORE the call, against the model id.
 *
 * ─── WHY THE TEST IS ON THE FUNCTION AND NOT ONLY ON THE CONSTANT ───
 *
 * A run gets its model from two places: {@link DEFAULT_SPEC_MODEL} and the
 * `DASHBOARD_SPEC_MODEL` override (`orchestrator.ts` `#seat`). Pinning the
 * default and testing only the default would leave the override — the very
 * lever the state report recommends pulling — unchecked. So the unsafe cases
 * are driven through {@link specModelCeilingWarning} by id.
 *
 * ─── THE NEGATIVE CONTROLS ───
 *
 * Three, because "the default is safe" is a claim that can be satisfied by a
 * function that says yes to everything:
 *
 *   · a 32k model (`claude-opus-4-1`) must be refused,
 *   · a 64k model (`claude-haiku-4-5`) must be refused — this is the exact id
 *     the probe caught being capped,
 *   · the literal `"default"` must be refused, because it is resolved by the
 *     CLI at runtime and this process cannot know what it will land on.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLI_DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_STREAMABLE_OUTPUT_TOKENS,
} from "bakeoff/dist/spec-types.js";
import { DEFAULT_SPEC_MODEL, outputCeilingFor, specModelCeilingWarning } from "./orchestrator.js";

test("the DEFAULT spec/judge model can deliver the rung the spec agent climbs to", () => {
  const ceiling = outputCeilingFor(DEFAULT_SPEC_MODEL);
  assert.notEqual(
    ceiling,
    null,
    `DEFAULT_SPEC_MODEL is "${DEFAULT_SPEC_MODEL}", whose output ceiling is unknown to this process. ` +
      "An unknown ceiling is not a safe one: the CLI caps a request above a model's limit silently, so " +
      "the 128k retry rung would be a no-op and nothing would say so.",
  );
  assert.ok(
    (ceiling ?? 0) >= MAX_STREAMABLE_OUTPUT_TOKENS,
    `DEFAULT_SPEC_MODEL is "${DEFAULT_SPEC_MODEL}", which caps output at ${String(ceiling)} tokens — below ` +
      `the ${String(MAX_STREAMABLE_OUTPUT_TOKENS)}-token rung spec-agent retries at.`,
  );
  assert.equal(
    specModelCeilingWarning(DEFAULT_SPEC_MODEL),
    null,
    "the default must not be a model the run has to warn about",
  );
});

test("the id is pinned to a literal, not to a name the CLI resolves at runtime", () => {
  // `"default"` is a real id and it resolved correctly on 2026-08-09. It is
  // still refused HERE, because what it resolves to is decided inside the CLI
  // at call time and four ids currently in that list cap below the rung.
  assert.notEqual(
    DEFAULT_SPEC_MODEL,
    "default",
    "an unattended run must not depend on what the CLI happens to recommend on the day it runs",
  );
});

test("the context-window suffix does not hide a model from the ceiling table", () => {
  // The pinned id carries `[1m]`. The CLI canonicalises that away before it
  // looks the ceiling up; a table that did not would read every suffixed id as
  // an unknown model, and the guard above would pass for the wrong reason.
  assert.equal(outputCeilingFor("claude-opus-5[1m]"), outputCeilingFor("claude-opus-5"));
  assert.equal(outputCeilingFor("claude-opus-5[1m]"), 128_000);
});

/*
 * THESE TWO ARE ABOUT THE SENTENCE, NOT ABOUT THE RUN — and they were RENAMED on
 * 2026-08-09 because they said "is refused", which is now true of one of them
 * and false of the other.
 *
 * `specModelCeilingWarning` answers one question: does this model reach the rung
 * it is asked about, and if not, what is the sentence. Both ids below fail that
 * question against the default 128,000 rung and both still get a sentence. What
 * the ORCHESTRATOR does with the sentence is a separate decision and it is not
 * the same for the two: 32,000 is below the spec seat's first call and refuses
 * the run; 64,000 serves every seat and only loses the truncation retry, so it
 * warns and proceeds. That split is measured behaviourally in
 * `orchestrator.test.ts`, and structurally by the threshold assertion below.
 */
test("the warning names the ceiling — 32k, which is below the seats' own first call", () => {
  const warning = specModelCeilingWarning("claude-opus-4-1");
  assert.notEqual(warning, null, "claude-opus-4-1 caps at 32000 and must not be handed the spec seat");
  assert.match(String(warning), /32000/, "the warning has to name the ceiling it measured");
});

test("the warning names the ceiling — 64k, the id the probe caught being capped", () => {
  const warning = specModelCeilingWarning("claude-haiku-4-5");
  assert.notEqual(warning, null, "claude-haiku-4-5 caps at 64000 — this is run-…162b186d's death, by id");
  assert.match(String(warning), /64000/);
  /*
   * AND THE FUNCTION IS RUNG-RELATIVE, which is what makes the orchestrator's
   * two thresholds expressible at all. Asked about the budget the seats START
   * on, this same id has nothing to warn about — that is precisely why it now
   * proceeds.
   */
  assert.equal(
    specModelCeilingWarning("claude-haiku-4-5", CLI_DEFAULT_MAX_OUTPUT_TOKENS),
    null,
    "a 64,000 model serves a 64,000 first call; a warning here would mean the refusal threshold can " +
      "never be set at the start budget",
  );
});

test("a model nobody has measured is refused, and `default` is one of them", () => {
  assert.equal(outputCeilingFor("default"), null, "the CLI resolves this one at runtime");
  assert.notEqual(specModelCeilingWarning("default"), null);
  assert.notEqual(specModelCeilingWarning("some-model-shipped-next-month"), null);
});

test("and the guard is not a blanket refusal — a 128k model passes", () => {
  // Without this, every assertion above is satisfied by a function that returns
  // a warning for every string it is given.
  assert.equal(specModelCeilingWarning("claude-opus-5"), null);
  assert.equal(specModelCeilingWarning("claude-sonnet-5"), null);
  assert.equal(specModelCeilingWarning("claude-opus-4-6"), null);
});

/* -------------------------------------------------------------------------
 * DOES THE PIN GOVERN ALL FOUR SEATS?
 *
 * The run recipe says the plan, spec, audit and judge seats all run on one
 * model. They do — every one of them is built by `Orchestrator#seat`, which is
 * the only place `DASHBOARD_SPEC_MODEL` and `DEFAULT_SPEC_MODEL` are read. That
 * is a claim about a SHAPE the type system does not hold: `SPEC_SEAT` and
 * `JUDGE_SEAT` are exported `AnthropicSeat` constants, so
 * `new SubscriptionSeatCaller(SPEC_SEAT, …)` — the pin bypassed, the seat left
 * on whatever `bakeoff/config.ts` last set — compiles perfectly and fails
 * nothing. It would ship a run where three seats obey the pin and one does not,
 * and the only symptom would be an output maximum an hour in.
 *
 * SO IT IS CHECKED ON THE SOURCE, which is the only artefact that holds it. The
 * precedent is `adversary.test.ts`, which reads `http.ts` for the same reason.
 * The check is on EVERY occurrence rather than on the four known ones: a fifth
 * seat added bare is precisely the regression, and a test that greps for the
 * four strings it already knows about stays green through it.
 * ---------------------------------------------------------------------- */

test("every seat in the orchestrator takes its model from #seat — all four of them", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf8");
  // Two regexes for one pattern, deliberately: a `/g` regex carries `lastIndex`
  // across `.test()` calls, so filtering with the same object that counts would
  // skip every second line and the test would under-report on purpose.
  const seatToken = /\b(?:SPEC_SEAT|JUDGE_SEAT)\b/g;
  const hasSeatToken = /\b(?:SPEC_SEAT|JUDGE_SEAT)\b/;

  // Comment lines are prose about the seats, not uses of them, and the import
  // is where the names arrive. Everything else is a construction site.
  const uses = source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return false;
      if (trimmed.startsWith("import ")) return false;
      return hasSeatToken.test(line);
    });

  assert.equal(
    uses.length,
    4,
    "the orchestrator builds four seats — plan, spec, audit, judge. This number changed, so a seat was " +
      `added or removed: ${JSON.stringify(uses.map((use) => `${String(use.number)}: ${use.line.trim()}`))}`,
  );
  for (const { line, number } of uses) {
    const occurrences = line.match(seatToken)?.length ?? 0;
    const wired = line.match(/this\.#seat\(runId, (?:SPEC_SEAT|JUDGE_SEAT)\)/g)?.length ?? 0;
    assert.equal(
      wired,
      occurrences,
      `orchestrator.ts:${String(number)} builds a seat WITHOUT the pin — "${line.trim()}". Every seat has ` +
        "to go through #seat, or DASHBOARD_SPEC_MODEL governs three seats out of four and the fourth runs " +
        "on whatever bakeoff/config.ts froze into the constant.",
    );
  }
});

test("#seat is the only place the seat model is spelled, and it consults the ceiling", () => {
  /*
   * THE SECOND HALF OF THE SAME SHAPE. Wiring all four seats through `#seat`
   * buys nothing if a second reader of `DASHBOARD_SPEC_MODEL` grows elsewhere in
   * the file with its own `?? DEFAULT_SPEC_MODEL` fallback: it would drift from
   * this one silently, and it would not consult the ceiling table — which is
   * what `#seat` did until the guard was wired, with `specModelCeilingWarning`
   * exported, tested seven times and called nowhere.
   */
  const source = readFileSync(join(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");

  assert.equal(
    code.match(/env\[SPEC_MODEL_ENV\]/g)?.length ?? 0,
    1,
    "two readers of the override variable is two fallbacks, and they drift",
  );
  /*
   * AND THE SAME COUNT ON THE LITERAL, because the assertion above is evadable
   * by exactly the defect it exists to stop — corrected 2026-08-09 after review.
   * `env[SPEC_MODEL_ENV]` is a bracket expression; a second reader written
   * `this.#deps.env["DASHBOARD_SPEC_MODEL"]` reads the same variable, carries
   * its own fallback, consults no ceiling, and leaves the count above at 1.
   * Both spellings are now counted: the constant's declaration is the one place
   * the string may appear.
   */
  assert.equal(
    code.match(/"DASHBOARD_SPEC_MODEL"/g)?.length ?? 0,
    1,
    "the override variable's NAME is spelled more than once — the second spelling is a second reader " +
      "that the SPEC_MODEL_ENV count above cannot see",
  );
  assert.ok(
    /outputCeilingFor\(modelId\)/.test(code),
    "the resolved model id is never measured against the ceiling table — the guard is unwired again",
  );
  /*
   * THE REFUSAL IS ASSERTED STRUCTURALLY, NOT AS TWO STRINGS THAT APPEAR
   * SOMEWHERE — corrected 2026-08-09. It used to be
   * `/throw new Error\(detail\)/.test(code) && /refusing to run/.test(code)`,
   * which stays green if the throw is moved into a branch nothing reaches. What
   * is matched now is the COMPARISON that selects the refusal, so a threshold
   * moved back onto the recovery rung (`MAX_STREAMABLE_OUTPUT_TOKENS`) fails
   * here as well as behaviourally.
   *
   * THE BEHAVIOURAL PROOF IS NOT DUPLICATED HERE. That a run actually stops, at
   * zero spend, with the ceiling and the variable named, is
   * `orchestrator.test.ts`'s "a run whose seat model MEASURES below the START
   * budget is refused BEFORE anything is spent" — driven through a real
   * `Orchestrator`, which source text cannot be. This assertion's only job is
   * the threshold's IDENTITY.
   */
  assert.match(
    code,
    /ceiling\s*<\s*CLI_DEFAULT_MAX_OUTPUT_TOKENS/,
    "the refusal is not gated on the START budget. Gating it on MAX_STREAMABLE_OUTPUT_TOKENS refuses " +
      "every 64,000 model — Sonnet 4.5, Opus 4.5, Haiku 4.5 — over a truncation-recovery rung that only " +
      "a retry ever asks for, which is a hard outage in place of a degradation",
  );
  /*
   * AND `#seat` ITSELF MUST BE THE ONE THAT ASKS — added because the mutation
   * that cuts the check out of `#seat` (`this.#usableSpecModel(runId)` →
   * `this.#specModelId()`) SURVIVED every other test in this lane: the preflight
   * in `#execute` still threw, so all three behavioural tests stayed green while
   * the chokepoint went back to applying `DASHBOARD_SPEC_MODEL` verbatim. A
   * guard with a caller and no test is the same defect as a guard with tests and
   * no caller, one level down.
   */
  assert.match(
    code,
    /#seat\([^)]*\)[^{]*\{[^}]*#usableSpecModel\(runId\)/,
    "#seat resolves the seat model WITHOUT consulting the ceiling. The preflight in #execute would still " +
      "refuse a bad model today, but the chokepoint every seat is built at — including a fifth one added " +
      "later, or a path that never reaches the preflight — no longer checks anything.",
  );
});
