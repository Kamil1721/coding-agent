/**
 * cron-lease.test.ts — two ticks in one minute, and the killed tick that must
 * not stop cron forever.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CRON_LEASE_FILE, DEFAULT_LEASE_TTL_MIN, acquireLease, releaseLease } from "./cron-lease.js";

const holder = (tickId: string, pid = 4242, at = "2026-07-30T02:00:00.000Z") => ({ tickId, pid, at });
const alive = (): boolean => true;
const dead = (): boolean => false;

test("the first tick takes the lease and the second is REFUSED, not queued", () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-lease-"));
  const first = acquireLease(dir, holder("t1"), DEFAULT_LEASE_TTL_MIN, alive);
  assert.equal(first.ok, true);
  assert.equal(existsSync(join(dir, CRON_LEASE_FILE)), true);
  const second = acquireLease(dir, holder("t2", 4243), DEFAULT_LEASE_TTL_MIN, alive);
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.heldBy?.tickId, "t1", "the refusal NAMES the holder");
});

test("a LIVE holder is never broken, however old the lease looks", () => {
  // Breaking a live holder is worse than refusing: two ticks then claim two
  // tickets and both count against one ceiling slot.
  const dir = mkdtempSync(join(tmpdir(), "cron-lease-live-"));
  acquireLease(dir, holder("t1", 4242, "2020-01-01T00:00:00.000Z"), 1, alive);
  const second = acquireLease(dir, holder("t2", 4243), 1, alive);
  assert.equal(second.ok, false);
  assert.match(!second.ok ? second.why : "", /still running/i);
});

test("a DEAD holder past the TTL is broken, and the break is RECORDED", () => {
  // trap row 3: without this, one killed tick stops cron forever and the only
  // symptom is that no run ever appears again.
  const dir = mkdtempSync(join(tmpdir(), "cron-lease-stale-"));
  acquireLease(dir, holder("t1", 4242, "2020-01-01T00:00:00.000Z"), 1, dead);
  const second = acquireLease(dir, holder("t2", 4243), 1, dead);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.brokeStale?.tickId, "t1", "a silent break is a break nobody can explain");
});

test("a dead holder INSIDE the TTL is still not broken", () => {
  // pid reuse is real: a live pid that is not our tick would read as alive, and
  // a dead pid inside the TTL may be a tick whose child is still finishing.
  const dir = mkdtempSync(join(tmpdir(), "cron-lease-young-"));
  acquireLease(dir, { ...holder("t1"), at: new Date().toISOString() }, DEFAULT_LEASE_TTL_MIN, dead);
  assert.equal(acquireLease(dir, holder("t2", 4243), DEFAULT_LEASE_TTL_MIN, dead).ok, false);
});

test("an UNREADABLE lease file is treated as HELD — fail closed, and say so", () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-lease-corrupt-"));
  writeFileSync(join(dir, CRON_LEASE_FILE), "{not json", "utf8");
  const result = acquireLease(dir, holder("t2"), DEFAULT_LEASE_TTL_MIN, dead);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.heldBy, null);
  assert.match(!result.ok ? result.why : "", /unreadable/i);
});

test("release is scoped to the holder and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-lease-rel-"));
  acquireLease(dir, holder("t1"), DEFAULT_LEASE_TTL_MIN, alive);
  releaseLease(dir, "t2");
  assert.equal(
    acquireLease(dir, holder("t3"), DEFAULT_LEASE_TTL_MIN, alive).ok,
    false,
    "t2 may not free t1's lease",
  );
  releaseLease(dir, "t1");
  releaseLease(dir, "t1");
  assert.equal(acquireLease(dir, holder("t3"), DEFAULT_LEASE_TTL_MIN, alive).ok, true);
});

test("the lease directory is created rather than assumed", () => {
  // The first tick on a fresh machine runs before anything has made the cron
  // root, and a lease that threw ENOENT there would exit 2 without journalling.
  const dir = join(mkdtempSync(join(tmpdir(), "cron-lease-fresh-")), "nested", "cron");
  assert.equal(acquireLease(dir, holder("t1"), DEFAULT_LEASE_TTL_MIN, alive).ok, true);
});
