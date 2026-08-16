/**
 * node-test-reporter.test.ts — the reporter, executed rather than read.
 *
 * WHY THIS FILE EXISTS. `docker/node-test-reporter.mjs` says at its own head
 * that it "is not typechecked by the harness … and is exercised end to end by
 * the scorer fixture rather than trusted by reading". That was true and it was
 * not enough: on 2026-08-16 the reporter shipped reading `details.error`
 * directly, which reports EVERY assertion in every frozen suite as a nameless
 * `Error` with null `expected` and null `actual`, because `node --test` hands
 * the reporter an `ERR_TEST_FAILURE` wrapper and puts the real error on
 * `cause`. A sealed-container re-score did not catch it — the one failure it
 * replayed had a message that happened to propagate through the wrapper, so a
 * general defect looked like a working feature.
 *
 * The only thing that catches that class is running the reporter against real
 * `node --test` events. So this test spawns one. It costs about a second.
 *
 * NOT A DUPLICATE OF `scorer-protocol.test.ts`. That file tests what happens to
 * a failure AFTER it is parsed. This one tests whether the failure is
 * observable at all.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/` at runtime, so the reporter is one directory up and across. */
const REPORTER = join(dirname(fileURLToPath(import.meta.url)), "..", "docker", "node-test-reporter.mjs");

interface ReportedTest {
  readonly kind: string;
  readonly outcome?: string;
  readonly titlePath?: readonly string[];
  readonly failure?: Record<string, string>;
}

/**
 * Run `node --test` under the REAL reporter and return what it emitted.
 *
 * The runner exits non-zero because the fixture is meant to fail, so a throwing
 * `execFileSync` is the expected path and its `stdout` is the payload.
 */
function reportOf(fixture: string): readonly ReportedTest[] {
  const dir = mkdtempSync(join(tmpdir(), "reporter-probe-"));
  const file = join(dir, "probe.test.mjs");
  writeFileSync(file, fixture, "utf8");

  /*
   * `NODE_TEST_CONTEXT` MUST BE STRIPPED, OR THIS TEST MEASURES NOTHING.
   *
   * This file is itself run by `node --test`, which exports that variable. A
   * child that sees it switches to the runner's internal serialized protocol
   * and IGNORES `--test-reporter` entirely — so the child emits no NDJSON, the
   * parse yields an empty array, and every assertion below fails with "emitted
   * no failure object" no matter what the reporter does. Watched red 2026-08-16
   * before the strip; the same command run from a shell was already green.
   */
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];

  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["--test", `--test-reporter=${REPORTER}`, file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? "");
  }

  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as ReportedTest);
}

const failureFor = (records: readonly ReportedTest[], needle: string): Record<string, string> | undefined =>
  records.find((r) => r.kind === "test" && r.outcome === "fail" && (r.titlePath ?? []).some((t) => t.includes(needle)))
    ?.failure;

/**
 * THE REGRESSION THIS FILE WAS WRITTEN FOR.
 *
 * MUTATION: delete the `ERR_TEST_FAILURE` unwrap in `describeFailure` so it
 * reads the wrapper. `name` becomes "Error", `code` becomes "ERR_TEST_FAILURE",
 * and `operator`/`expected`/`actual` all vanish — this goes red on four
 * assertions. That is the exact state the reporter shipped in for one build.
 */
test("an assertion failure reports the ASSERTION, not the test runner's wrapper", () => {
  const records = reportOf(
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("equality", () => { assert.equal("got-this", "wanted-that"); });',
    ].join("\n"),
  );

  const failure = failureFor(records, "equality");
  assert.ok(failure, "a failing test emitted no failure object at all");
  assert.equal(failure["name"], "AssertionError");
  assert.equal(failure["code"], "ERR_ASSERTION");
  assert.equal(failure["operator"], "strictEqual");
  // The two fields a triage agent actually wants, and the two the wrapper drops.
  assert.equal(failure["expected"], "wanted-that");
  assert.equal(failure["actual"], "got-this");
});

/**
 * A TIMEOUT IS A FAILURE MODE WITH NO ASSERTION BEHIND IT, and the reporter
 * must still report it. This is the shape every one of the seven 2026-08-12
 * failures actually took: killed at 45s waiting for a health check.
 *
 * MUTATION: narrow `describeFailure` to assertion errors —
 * `if (error.name !== "AssertionError") return undefined;`. This goes red while
 * the assertion test above stays green, which is the pair that matters: a
 * reporter that only explains assertions explains none of the failures this
 * repo has actually had.
 *
 * CORRECTED 2026-08-16, BEFORE SHIPPING. This test first claimed to pin a
 * wrapper-message fallback. Mutation showed the fallback was reached by
 * nothing; it was deleted rather than kept green over a dead branch.
 */
test("a timed-out test reports its reason rather than failing blank", () => {
  const records = reportOf(
    [
      'import test from "node:test";',
      'test("slow", { timeout: 40 }, async () => { await new Promise((r) => setTimeout(r, 2000)); });',
    ].join("\n"),
  );

  const failure = failureFor(records, "slow");
  assert.ok(failure, "a timed-out test emitted no failure object");
  assert.match(failure["message"] ?? "", /timed out/i);
});

/**
 * MUTATION: `failure: describeFailure(details) ?? { name: "none" }` -> RED.
 *
 * CORRECTED 2026-08-16, AND THE CORRECTION IS THE POINT. This docblock used to
 * name the mutation "emit `failure` unconditionally instead of only on
 * `test:fail`". Run literally — `failure: describeFailure(details)` — the suite
 * stays GREEN, because a passing test has no `details.error`, `describeFailure`
 * returns `undefined`, and `JSON.stringify` drops an undefined value. A debugfix
 * lens caught the mismatch; running it confirmed the lens and not the docblock.
 *
 * SO BE PRECISE ABOUT WHAT THIS TEST PINS. It pins that a passing record carries
 * no `failure` key. It does NOT pin the `type === "test:fail"` spread guard,
 * whose only effect is to skip the call — the emitted line is byte-identical
 * either way. That guard is an optimisation, not a correctness property, and
 * nothing here observes it. Saying so is better than a mutation note that reads
 * as coverage and is not.
 */
test("a PASSING test carries no failure key at all", () => {
  const records = reportOf(
    ['import test from "node:test";', 'test("fine", () => {});', 'test("broken", () => { throw new Error("x"); });'].join(
      "\n",
    ),
  );

  const passing = records.find((r) => r.kind === "test" && (r.titlePath ?? []).some((t) => t.includes("fine")));
  assert.ok(passing, "the passing test was not reported");
  assert.equal(passing.outcome, "pass");
  assert.equal(passing.failure, undefined, "a pass must not carry a failure object");
  assert.ok(failureFor(records, "broken"), "the failing sibling must still carry one");
});

/**
 * A THROWN NON-ERROR IS STILL A REASON. `throw "boom"` is legal and a frozen
 * suite may contain it.
 *
 * MUTATION: delete `put("message", …)`. This goes red.
 *
 * WHAT THIS DOES NOT PIN, MEASURED: it does not exercise `describeFailure`'s
 * non-object branch. node wraps a thrown string in an `ERR_TEST_FAILURE` Error
 * carrying the text as its own message, so the string never arrives raw. The
 * branch is labelled defensive-only at its site. Recorded here because a test
 * whose docblock claims a branch it never enters is how this repo has shipped
 * seventeen checks over nothing.
 */
test("a thrown string's text survives to the failure record", () => {
  const records = reportOf(
    ['import test from "node:test";', 'test("rude", () => { throw "just a string"; });'].join("\n"),
  );
  assert.match(failureFor(records, "rude")?.["message"] ?? "", /just a string/);
});
