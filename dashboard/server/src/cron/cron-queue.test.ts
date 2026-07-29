/**
 * cron-queue.test.ts — exactly-once, and the stranded claim that must halt.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  CRON_DIRS,
  claim,
  ensureCronDirs,
  listQueue,
  settleFailed,
  settleSubmitted,
  strandedClaims,
} from "./cron-queue.js";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "cron-queue-"));
  ensureCronDirs(dir);
  return dir;
}
function enqueue(dir: string, name: string, body = "build me a thing"): string {
  const path = join(dir, CRON_DIRS.queue, name);
  writeFileSync(path, body, "utf8");
  return path;
}

test("the queue is lexicographic, and dotfiles are not tickets", () => {
  const dir = root();
  enqueue(dir, "20-b.md");
  enqueue(dir, "10-a.md");
  enqueue(dir, ".DS_Store");
  assert.deepEqual(
    listQueue(dir).map((p) => basename(p)),
    ["10-a.md", "20-b.md"],
  );
});

test("a claim is ATOMIC: the second claimer of one ticket gets nothing", () => {
  // The rename is the claim, so exactly-once holds even if the lease were
  // somehow bypassed. Two runs from one ticket is duplicated spend.
  const dir = root();
  const path = enqueue(dir, "a.md");
  const first = claim(dir, path, "t1");
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.ticketText, "build me a thing");
  const second = claim(dir, path, "t2");
  assert.equal(second.ok, false);
  assert.equal(listQueue(dir).length, 0);
  assert.equal(readdirSync(join(dir, CRON_DIRS.claimed)).length, 1);
});

test("A CLAIM MOVES THE TICKET — it is never in the queue AND claimed at once", () => {
  // THE MUTATION THIS EXISTS FOR, because the sequential double-claim above
  // cannot see it: copy-then-delete is also exactly-once for a second claimer
  // that runs afterwards. What separates a rename from a copy is what happens
  // when the delete half FAILS — the ticket ends up in both places and the next
  // tick pays for a second build of the same brief.
  //
  // A read-only `queue/` makes the delete half fail: `rename` needs write
  // permission on the source directory to remove the entry, so a rename REFUSES
  // and leaves nothing behind, while a copy would succeed into `claimed/` and
  // then be unable to unlink.
  const dir = root();
  enqueue(dir, "a.md");
  const queueDir = join(dir, CRON_DIRS.queue);
  chmodSync(queueDir, 0o555);
  try {
    const result = claim(dir, join(queueDir, "a.md"), "t1");
    assert.equal(result.ok, false, "an unwritable queue directory cannot yield a claim");
    assert.equal(listQueue(dir).length, 1, "the ticket is still queued, exactly once");
    assert.equal(strandedClaims(dir).length, 0, "and nothing was left half-claimed");
  } finally {
    chmodSync(queueDir, 0o755);
  }
});

test("settling names the RUN in the filename, so either end finds the other", () => {
  const dir = root();
  const claimed = claim(dir, enqueue(dir, "a.md"), "t1");
  assert.ok(claimed.ok);
  const settled = settleSubmitted(dir, claimed.claimedPath, "run-2026-07-30-abcd1234");
  assert.match(basename(settled), /^run-2026-07-30-abcd1234-.*a\.md$/);
  assert.equal(existsSync(claimed.claimedPath), false, "a settled ticket does not stay claimed");
  assert.equal(strandedClaims(dir).length, 0);
});

test("a rejected ticket lands in failed/ and is NOT retried by the next tick", () => {
  // Retrying a ticket the server just refused is an infinite loop against a
  // 400, once a night, forever.
  const dir = root();
  const claimed = claim(dir, enqueue(dir, "a.md"), "t1");
  assert.ok(claimed.ok);
  settleFailed(dir, claimed.claimedPath);
  assert.equal(listQueue(dir).length, 0);
  assert.equal(readdirSync(join(dir, CRON_DIRS.failed)).length, 1);
});

test("A STRANDED CLAIM IS REPORTED, NOT SKIPPED — trap row 4", () => {
  // A tick killed between the rename and the POST leaves this. Silently
  // re-queueing risks a duplicate run; silently ignoring loses the ticket.
  const dir = root();
  const claimed = claim(dir, enqueue(dir, "a.md"), "t1");
  assert.ok(claimed.ok);
  assert.deepEqual(
    strandedClaims(dir).map((p) => basename(p)),
    [basename(claimed.claimedPath)],
  );
});

test("an unreadable ticket is a refusal with a reason, not an empty submission", () => {
  const dir = root();
  const missing = join(dir, CRON_DIRS.queue, "gone.md");
  const result = claim(dir, missing, "t1");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.why : "", /gone\.md/);
});
