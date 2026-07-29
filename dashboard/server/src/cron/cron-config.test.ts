/**
 * cron-config.test.ts — every refusal, and the knob that must not exist.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BAKEOFF_ROOT } from "../paths.js";
import { CRON_ENV, readCronConfig } from "./cron-config.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "cron-config-"));
const withModel = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DASHBOARD_HOME: tmp(),
  DASHBOARD_CRON_MODEL: "opus[1m]",
  ...over,
});

test("the model is REQUIRED — a default here is a guess about spend", () => {
  const result = readCronConfig({ DASHBOARD_HOME: tmp() });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.why : "", /DASHBOARD_CRON_MODEL/);
});

test("a cron config may not ask for a design park", () => {
  // There is no such env var, and that is the point: the only way to express
  // "ask" is through the HTTP field, which the tick hardcodes to "auto". If a
  // later edit adds one, this test says why it must not.
  assert.equal(
    Object.values(CRON_ENV).some((name) => /DESIGN|LOCK|ASK/i.test(name)),
    false,
  );
});

test("the ceiling and the window default, and refuse nonsense rather than clamping", () => {
  const ok = readCronConfig(withModel());
  assert.ok(ok.ok && ok.config.maxRunsPerWindow === 4 && ok.config.windowHours === 24);
  const bad = readCronConfig(withModel({ DASHBOARD_CRON_MAX_RUNS_PER_WINDOW: "0" }));
  assert.equal(bad.ok, false, "a ceiling of 0 means nothing may run; say so instead of running 4");
  const huge = readCronConfig(withModel({ DASHBOARD_CRON_MAX_RUNS_PER_WINDOW: "999" }));
  assert.equal(huge.ok, false, "a clamp would read in the journal as if the number had been honoured");
  assert.match(!huge.ok ? huge.why : "", /refused rather than clamped/);
  assert.equal(readCronConfig(withModel({ DASHBOARD_CRON_MAX_RUNS_PER_WINDOW: "4.5" })).ok, false);
  assert.equal(readCronConfig(withModel({ DASHBOARD_CRON_MAX_RUNS_PER_WINDOW: "four" })).ok, false);
});

test("every bound has a default AND a refusal, so none of them is silently unbounded", () => {
  for (const name of [
    CRON_ENV.maxRuns,
    CRON_ENV.windowHours,
    CRON_ENV.leaseTtlMin,
    CRON_ENV.expectEveryMin,
  ]) {
    assert.equal(readCronConfig(withModel({ [name]: "0" })).ok, false, `${name} accepted 0`);
    assert.equal(readCronConfig(withModel({ [name]: "999999" })).ok, false, `${name} accepted 999999`);
    assert.equal(readCronConfig(withModel({ [name]: "" })).ok, true, `${name} blank must fall back`);
  }
});

test("deploy is a flag, and an unrecognised value is refused rather than read as false", () => {
  // A typo'd DASHBOARD_CRON_DEPLOY=yes that quietly meant "no" is a night of
  // runs that never deployed, with nothing saying why.
  assert.equal(readCronConfig(withModel()).ok && readCronConfig(withModel()).ok, true);
  const on = readCronConfig(withModel({ DASHBOARD_CRON_DEPLOY: "1" }));
  assert.equal(on.ok && on.config.deploy, true);
  const off = readCronConfig(withModel({ DASHBOARD_CRON_DEPLOY: "0" }));
  assert.equal(off.ok && off.config.deploy, false);
  assert.equal(readCronConfig(withModel({ DASHBOARD_CRON_DEPLOY: "yes" })).ok, false);
});

test("the cron root is refused inside the bake-off tree", () => {
  const result = readCronConfig({ DASHBOARD_CRON_DIR: join(BAKEOFF_ROOT, "cron"), DASHBOARD_CRON_MODEL: "opus[1m]" });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.why : "", /bake-off tree/);
});

test("the cron root defaults under DASHBOARD_HOME, and DASHBOARD_CRON_DIR overrides it", () => {
  const home = tmp();
  const under = readCronConfig({ DASHBOARD_HOME: home, DASHBOARD_CRON_MODEL: "opus[1m]" });
  assert.equal(under.ok && under.config.root, join(home, "cron"));
  const elsewhere = tmp();
  const over = readCronConfig({ DASHBOARD_CRON_DIR: elsewhere, DASHBOARD_CRON_MODEL: "opus[1m]" });
  assert.equal(over.ok && over.config.root, elsewhere);
});

test("the base URL comes from the ONE resolver, so a port override moves both", () => {
  const result = readCronConfig(withModel({ DASHBOARD_PORT: "4321" }));
  assert.ok(result.ok && result.config.baseUrl.endsWith(":4321"));
  assert.ok(result.ok && result.config.baseUrl.startsWith("http://127.0.0.1:"));
  assert.equal(readCronConfig(withModel({ DASHBOARD_PORT: "nope" })).ok, false, "a bad port is refused, not defaulted");
});
