/**
 * health-gate.test.ts — THE NEGATIVE CONTROL FOR THE GATE PROBE.
 *
 * The probe exists so that a down Docker daemon is visible BEFORE a run spends
 * ~1h45 on a spec phase and a full build only to come back `unscored`. A probe
 * that reports a cheerful state when it has learned nothing would be worse than
 * no probe at all: it would move the surprise later and add confidence to it.
 *
 * So every assertion here is aimed at a FAILURE path. `health-gate.ts`'s own
 * docblock says it plainly — "a test that cannot reach a branch is how this
 * repository ends up with checks that only ever observe success" — and the
 * seams (`makeGate`, `nowMs`, `cacheMs`, `deadlineMs`) exist for exactly this.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AcceptanceGate } from "bakeoff/dist/contracts.js";
import { GateProbe } from "./health-gate.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

function scratch(): { paths: DashboardPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dash-gate-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A gate that resolved. Only `scorerImageDigest` is read by the probe. */
function fakeGate(digest: string): AcceptanceGate {
  return { scorerImageDigest: digest } as unknown as AcceptanceGate;
}

test("a refusing daemon reports `unavailable` AND carries the reason", async () => {
  const s = scratch();
  try {
    const probe = new GateProbe({
      paths: s.paths,
      makeGate: () => Promise.reject(new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")),
      deadlineMs: 1_000,
    });

    const health = await probe.status();
    assert.equal(health.state, "unavailable");
    assert.match(
      health.detail,
      /Cannot connect to the Docker daemon/,
      "a bare `unavailable` tells the owner nothing they can act on; the daemon's own words are the fix",
    );
    assert.notEqual(health.checkedAt, null, "a real measurement was taken, so it is stamped");
  } finally {
    s.cleanup();
  }
});

test("a HUNG daemon reports `unknown` — never ok — and does not pile up subprocesses", async () => {
  const s = scratch();
  try {
    let starts = 0;
    const probe = new GateProbe({
      paths: s.paths,
      makeGate: () => {
        starts += 1;
        // Never settles: the shape of a daemon that has stopped answering. The
        // real `docker image inspect` is given 120s while the route waits 5s.
        return new Promise<AcceptanceGate>(() => {});
      },
      deadlineMs: 5,
    });

    const first = await probe.status();
    assert.equal(
      first.state,
      "unknown",
      "NOTHING WAS LEARNED. A gate whose state is unknown must never render like a healthy one",
    );
    assert.equal(first.checkedAt, null, "and it must not claim a measurement instant it never took");
    assert.equal(starts, 1);

    // The in-flight probe is memoised. Without that, every poll during a 120s
    // docker hang starts another child process — on exactly the machine state
    // the probe exists to report.
    const second = await probe.status();
    assert.equal(second.state, "unknown");
    assert.equal(starts, 1, "a second poll during a hang must not spawn a second `docker image inspect`");
  } finally {
    s.cleanup();
  }
});

test("a STALE answer is served immediately and refreshed behind it — the poll never waits", async () => {
  const s = scratch();
  try {
    let nowMs = 1_000_000;
    let starts = 0;
    let release: ((gate: AcceptanceGate) => void) | null = null;

    const probe = new GateProbe({
      paths: s.paths,
      cacheMs: 60_000,
      deadlineMs: 1_000,
      nowMs: () => nowMs,
      makeGate: () => {
        starts += 1;
        if (starts === 1) return Promise.resolve(fakeGate("sha256:aaaaaaaaaaaaaaaaaaaa"));
        return new Promise<AcceptanceGate>((resolve) => {
          release = resolve;
        });
      },
    });

    const fresh = await probe.status();
    assert.equal(fresh.state, "ok");
    assert.match(fresh.detail, /sha256:aaaaaaaaaaaa/, "the digest prefix is what makes two answers comparable by eye");
    assert.equal(starts, 1);

    // Inside the TTL: served from cache, no subprocess at all.
    nowMs += 30_000;
    assert.equal((await probe.status()).state, "ok");
    assert.equal(starts, 1, "a poll inside the TTL must not touch the daemon");

    // Past the TTL: the OLD answer comes back immediately even though the
    // refresh has not settled. This is the assertion that proves the route
    // cannot block on docker once any answer exists.
    nowMs += 40_000;
    const stale = await probe.status();
    assert.equal(stale.state, "ok", "the last known answer is served rather than waited on");
    assert.equal(starts, 2, "and a refresh was started behind it");
    assert.ok(release !== null, "the refresh really is still in flight, so the read above did not wait for it");

    // Let the refresh land, and prove it replaces the cached answer.
    (release as unknown as (gate: AcceptanceGate) => void)(fakeGate("sha256:bbbbbbbbbbbbbbbbbbbb"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    nowMs += 1;
    const refreshed = await probe.status();
    assert.match(refreshed.detail, /sha256:bbbbbbbbbbbb/, "the refresh must actually replace what the cache serves");
  } finally {
    s.cleanup();
  }
});

test("a probe that throws leaves the LAST KNOWN answer alone rather than inventing one", async () => {
  const s = scratch();
  try {
    let nowMs = 2_000_000;
    let starts = 0;
    const probe = new GateProbe({
      paths: s.paths,
      cacheMs: 10,
      deadlineMs: 1_000,
      nowMs: () => nowMs,
      makeGate: () => {
        starts += 1;
        if (starts === 1) return Promise.resolve(fakeGate("sha256:cccccccccccccccccccc"));
        // Not a refusal FROM the daemon — a fault in the probing itself.
        throw new Error("the probe itself blew up");
      },
    });

    assert.equal((await probe.status()).state, "ok");
    nowMs += 1_000;
    const after = await probe.status();
    assert.equal(
      after.state,
      "ok",
      "recording `unavailable` here would report the probe's OWN bug as a fact about the daemon",
    );
    assert.match(after.detail, /sha256:cccccccccccc/);
  } finally {
    s.cleanup();
  }
});
