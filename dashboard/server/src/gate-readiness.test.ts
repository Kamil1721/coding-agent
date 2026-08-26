import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import type { ScorerContainerSpec, ScorerRuntimeReadiness } from "bakeoff/dist/scorer.js";

import { FreshGateReadiness, checkGateReadinessFresh } from "./gate-readiness.js";
import { ensureDirs, resolvePaths } from "./paths.js";

function runtimeReady(spec: ScorerContainerSpec): ScorerRuntimeReadiness {
  return {
    imageRef: spec.imageRef,
    imageDigest: `sha256:${"b".repeat(64)}`,
    image: { id: `sha256:${"b".repeat(64)}`, repoDigests: [], repoTags: [] },
    smoke: {
      smokeVersion: 2,
      status: "ok",
      protocolVersion: 1,
      nodeVersion: "v24.7.0",
      playwrightVersion: "1.62.0",
      chromiumVersion: "Chromium 140.0.0.0",
      checkedFiles: ["dist/scorer-container.js"],
    },
  };
}

test("FreshGateReadiness probes the configured image on every call and reports the runtime facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-fresh-gate-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  const specs: ScorerContainerSpec[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const probe = async (spec: ScorerContainerSpec, env: NodeJS.ProcessEnv = {}): Promise<ScorerRuntimeReadiness> => {
    specs.push(spec);
    envs.push(env);
    return runtimeReady(spec);
  };
  try {
    const readiness = new FreshGateReadiness({
      paths,
      env: { PATH: "/safe/bin", HOME: "/safe/home", BAKEOFF_SCORER_IMAGE: "scorer@sha256:configured" },
      probe,
      now: () => new Date("2026-08-26T10:00:00.000Z"),
    });
    assert.equal((await readiness.checkFresh()).state, "ready");
    assert.equal((await readiness.checkFresh()).state, "ready");
    assert.equal(specs.length, 2, "fresh means no readiness cache between spend decisions");
    assert.equal(specs[0]?.imageRef, "scorer@sha256:configured");
    assert.equal(envs[0]?.["BAKEOFF_SCORER_IMAGE"], "scorer@sha256:configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh probes are admitted serially and excess callers fail closed without spawning Docker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-fresh-gate-admission-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const probe = async (spec: ScorerContainerSpec): Promise<ScorerRuntimeReadiness> => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      releases.push(() => { active -= 1; resolve(); });
    });
    return runtimeReady(spec);
  };
  try {
    const readiness = new FreshGateReadiness({
      paths,
      probe,
      maxConcurrentProbes: 1,
      maxQueuedProbes: 1,
    });
    const first = readiness.checkFresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = readiness.checkFresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saturated = await readiness.checkFresh();
    assert.equal(saturated.state, "unavailable");
    assert.match(saturated.detail, /admission is saturated/u);
    assert.equal(calls, 1, "a refused waiter must not spawn a third Docker probe");

    releases.shift()?.();
    assert.equal((await first).state, "ready");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    releases.shift()?.();
    assert.equal((await second).state, "ready");
    assert.equal(maxActive, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime probe errors are unavailable with their operator remediation; adapter throws become unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-fresh-gate-error-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  try {
    const readiness = new FreshGateReadiness({
      paths,
      probe: () => Promise.reject(new BakeoffError("invalid_usage_shape", "smoke exited 127", "rebuild image")),
    });
    const unavailable = await readiness.checkFresh();
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.detail, "[invalid_usage_shape] smoke exited 127");
    assert.equal(unavailable.remediation, "rebuild image");
    assert.notEqual(unavailable.checkedAt, null);

    const unknown = await checkGateReadinessFresh({
      checkFresh: () => Promise.reject(new Error("adapter exploded")),
    });
    assert.equal(unknown.state, "unknown");
    assert.match(unknown.detail, /adapter exploded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
