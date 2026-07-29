/**
 * security.test.ts — the invariants that are not allowed to regress.
 *
 * Every check here corresponds to a way this program could quietly become
 * dangerous: bound to the wrong interface, writing into the bake-off's results
 * tree, persisting a credential, or requiring an API key it was built not to
 * need.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCredential } from "bakeoff/dist/env.js";
import { assertRedacted, redactForPersistence } from "bakeoff/dist/redact.js";
import { assertLoopback, LOOPBACK_HOST } from "./http.js";
import { BAKEOFF_ROOT, assertOutsideBakeoff, gateEnv, resolvePaths, safeSegment } from "./paths.js";
import { SUBSCRIPTION_SENTINEL, sentinelEnv, subscriptionPricingBasis, subscriptionUsage } from "./subscription-caller.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";
import { zeroTokens } from "./tokens.js";
import { RunStore } from "./db.js";
import {
  STRIPPED_ENV_NAMES,
  subscriptionSubprocessEnv,
  subscriptionSubprocessEnvStrings,
} from "./subprocess-env.js";

test("the server binds 127.0.0.1 and refuses every other host", () => {
  assert.doesNotThrow(() => assertLoopback(LOOPBACK_HOST));
  for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.10", "", "127.0.0.2"]) {
    assert.throws(
      () => assertLoopback(host),
      (error: unknown) => {
        // The refusal must say why, not just that.
        const message = error instanceof Error ? `${error.message}` : String(error);
        assert.match(message, /binds 127\.0\.0\.1 only/);
        return true;
      },
      `expected ${JSON.stringify(host)} to be refused`,
    );
  }
});

test("no dashboard path may live inside the bake-off tree", () => {
  assert.throws(() => assertOutsideBakeoff(BAKEOFF_ROOT, "home"), /inside the bake-off tree/);
  assert.throws(() => assertOutsideBakeoff(join(BAKEOFF_ROOT, "results"), "results"), /inside the bake-off tree/);
  assert.throws(
    () => assertOutsideBakeoff(join(BAKEOFF_ROOT, "results", "dashboard"), "results"),
    /inside the bake-off tree/,
  );
  assert.doesNotThrow(() => assertOutsideBakeoff(join(BAKEOFF_ROOT, "..", "dashboard"), "home"));
});

test("resolvePaths refuses a DASHBOARD_HOME inside bakeoff/", () => {
  assert.throws(() => resolvePaths({ DASHBOARD_HOME: BAKEOFF_ROOT }), /inside the bake-off tree/);
});

test("the gate environment redirects the scorer away from the campaign's directories", () => {
  const home = mkdtempSync(join(tmpdir(), "dash-paths-"));
  try {
    const paths = resolvePaths({ DASHBOARD_HOME: home });
    const env = gateEnv(paths, { PATH: "/usr/bin", HOME: home, BAKEOFF_SCORER_IMAGE: "bakeoff-scorer:1" });
    assert.equal(env["BAKEOFF_RESULTS_DIR"], paths.results);
    assert.equal(env["BAKEOFF_ACCEPTANCE_ROOT"], paths.acceptance);
    assert.equal(env["BAKEOFF_SCORER_IMAGE"], "bakeoff-scorer:1");
    // Nothing that looks like a credential is forwarded to a container that has
    // no network and nothing to authenticate to.
    for (const key of Object.keys(env)) {
      assert.doesNotMatch(key, /API_KEY|TOKEN|SECRET/i, `gate env must not carry ${key}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("safeSegment cannot produce a path traversal", () => {
  assert.equal(safeSegment("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeSegment(""), "unnamed");
  assert.equal(safeSegment("run-2026-07-27T10-00-00-000Z-abcd1234"), "run-2026-07-27T10-00-00-000Z-abcd1234");
});

test("the subscription sentinel satisfies checkCredential and is not a credential", () => {
  const env = sentinelEnv("ANTHROPIC_API_KEY", {});
  const check = checkCredential("ANTHROPIC_API_KEY", env);
  assert.equal(check.present, true, "the base seat caller must accept it or the spec agent cannot construct");
  assert.equal(check.problem, null);

  // It must not look like any real key, and it must survive redaction
  // unchanged — a sentinel that gets redacted would be replaced by a
  // placeholder that checkCredential then rejects.
  assert.doesNotMatch(SUBSCRIPTION_SENTINEL, /^sk-/);
  assert.doesNotMatch(SUBSCRIPTION_SENTINEL, /^ghp_/);
  assert.doesNotThrow(() => assertRedacted(SUBSCRIPTION_SENTINEL));
  assert.equal(redactForPersistence(SUBSCRIPTION_SENTINEL), SUBSCRIPTION_SENTINEL);
});

test("a subscription usage row carries tokens and no priced fields", () => {
  const usage = subscriptionUsage(SPEC_SEAT, { ...zeroTokens("anthropic"), inputTokens: 10, outputTokens: 5 }, null);
  assert.equal(usage.costUsd, 0, "there is no bill for a subscription call");
  assert.equal(usage.cacheWrite5mTokens, null, "unreported must be null, never 0");
  assert.equal(usage.cacheWrite1hTokens, null);
  assert.equal(usage.inputTokens, 10);

  const basis = subscriptionPricingBasis("default", "2026-07-27T10:00:00.000Z");
  // Every field unverified: contracts.ts defines that as "no known value:
  // usage touching one of these cannot be costed", which is the literal truth.
  for (const status of Object.values(basis.fieldStatus)) {
    assert.equal(status, "unverified");
  }
  assert.equal(basis.assumedCacheWriteMultiplier, null);
});

test("persisted strings go through the redaction chokepoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-db-"));
  try {
    const store = RunStore.open(join(dir, "runs.db"));
    // Assembled at runtime so this file contains no key-shaped literal.
    const fakeKey = `sk-ant-api03-${"A1b2C3d4E5f6G7h8".repeat(6)}`;
    store.createRun({
      runId: "run-1",
      ticketId: "t-abc",
      ticketTitle: "leaky ticket",
      ticketText: `use this key: ${fakeKey}`,
      ticketSha256: "a".repeat(64),
      modelId: "default",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
    const row = store.getRun("run-1");
    assert.notEqual(row, null);
    assert.ok(row !== null);
    assert.ok(!row.ticketText.includes(fakeKey), "the raw key must not be persisted");
    assert.doesNotThrow(() => assertRedacted(row.ticketText));

    store.appendEvent("run-1", { type: "log", level: "info", text: `leaked ${fakeKey}` });
    const events = store.eventsSince("run-1", 0);
    const first = events[0];
    assert.ok(first !== undefined);
    const logged = first.event;
    assert.equal(logged.type, "log");
    if (logged.type === "log") {
      assert.ok(!logged.text.includes(fakeKey));
      assert.doesNotThrow(() => assertRedacted(logged.text));
    }

    // The digest must NOT be redacted: the whole freeze chain compares against
    // it, and a rewritten digest would read as tampering.
    assert.equal(row.ticketSha256, "a".repeat(64));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no metered credential reaches an SDK subprocess", () => {
  // Assembled at runtime: this file contains no key-shaped literal.
  const fakeAnthropic = `sk-ant-api03-${"Z9y8X7w6V5u4T3s2".repeat(6)}`;
  const fakeOpenAi = `sk-proj-${"Q1w2E3r4T5y6U7i8".repeat(4)}`;
  const dirty: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/owner",
    CODEX_HOME: "/home/owner/.codex",
    ANTHROPIC_API_KEY: fakeAnthropic,
    ANTHROPIC_AUTH_TOKEN: fakeAnthropic,
    ANTHROPIC_BASE_URL: "https://gateway.example.invalid",
    OPENAI_API_KEY: fakeOpenAi,
    CODEX_API_KEY: fakeOpenAi,
    MOONSHOT_API_KEY: fakeOpenAi,
    DEEPSEEK_API_KEY: fakeOpenAi,
  };

  const clean = subscriptionSubprocessEnv(dirty);
  for (const name of STRIPPED_ENV_NAMES) {
    assert.equal(clean[name], undefined, `${name} must not reach a subscription CLI`);
  }
  // A CLI that cannot find its own login is worse than one that finds a key:
  // the subtraction must keep everything it needs to authenticate itself.
  assert.equal(clean["PATH"], "/usr/bin");
  assert.equal(clean["HOME"], "/home/owner");
  assert.equal(clean["CODEX_HOME"], "/home/owner/.codex");
  assert.ok(!JSON.stringify(clean).includes(fakeAnthropic));
  assert.ok(!JSON.stringify(clean).includes(fakeOpenAi));

  const strings = subscriptionSubprocessEnvStrings({ ...dirty, UNDEFINED_ONE: undefined });
  assert.equal("UNDEFINED_ONE" in strings, false, "an undefined value must be dropped, not stringified");
  assert.ok(!JSON.stringify(strings).includes(fakeAnthropic));
  assert.equal(strings["CODEX_HOME"], "/home/owner/.codex");
});
