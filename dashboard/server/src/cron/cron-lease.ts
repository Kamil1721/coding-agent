/**
 * cron-lease.ts — single-flight for the TICK, and nothing wider.
 *
 * THREE DIFFERENT OVERLAPS, KEPT APART, because conflating them would put a
 * false justification in this file:
 *
 *   AT THE API LEVEL      two POSTs while a run is active are a QUEUE. `pump()`
 *                         starts one and positions the rest; workspaces are
 *                         per-run. Safe — but not wanted, which is `cron-policy`.
 *   AT THE PROCESS LEVEL  two `Orchestrator`s against one `runs.db` is
 *                         CORRUPTION. That is prevented by the tick's dependency
 *                         type, which carries no store — not by this lease.
 *   AT THE TICK LEVEL     two ticks in the same minute would both claim a
 *                         ticket, both journal, and both spend a ceiling slot.
 *                         THAT is what this lease prevents, and it is all it
 *                         prevents.
 *
 * `O_EXCL` IS THE WHOLE MECHANISM. `writeFileSync(path, …, {flag: "wx"})` either
 * creates the file or fails with `EEXIST`, in one syscall — so there is no
 * read-then-write window for two ticks to both pass. A `existsSync` check
 * followed by a write would be exactly that window.
 *
 * FAILING CLOSED IS THE CHOSEN DIRECTION, and the cost is stated: refusing while
 * a lease MIGHT be live costs one tick (which journals `lease-held`, so it is
 * visible); breaking a live one costs a duplicate claim and duplicate spend.
 * `process.kill(pid, 0)` cannot tell a recycled pid from ours, so a genuinely
 * dead tick's lease can survive to its TTL — up to `DEFAULT_LEASE_TTL_MIN`
 * minutes of visible refusals rather than one invisible double-spend.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CRON_LEASE_FILE = "tick.lease";

/**
 * Who holds the lease. Recorded so a refusal can NAME the holder: "another tick
 * is running" that cannot say which one is a message nobody can act on.
 */
export interface LeaseHolder {
  readonly tickId: string;
  readonly pid: number;
  readonly at: string;
}

export type LeaseResult =
  | { readonly ok: true; readonly path: string; readonly brokeStale: LeaseHolder | null }
  | { readonly ok: false; readonly heldBy: LeaseHolder | null; readonly why: string };

/**
 * Long enough that a tick doing real work (two `GET`s and a `POST` against a
 * loopback server) never has its lease broken under it; short enough that a
 * killed tick costs at most this many minutes of refused ticks.
 */
export const DEFAULT_LEASE_TTL_MIN = 15;

/** `process.kill(pid, 0)` signals nothing; it only asks whether the pid exists. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM MEANS ALIVE. A pid we are not permitted to signal is a pid that
    // exists, and treating it as dead would break a live holder's lease.
    return (error as { code?: string }).code === "EPERM";
  }
}

function readHolder(path: string): LeaseHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseHolder>;
    if (typeof parsed.tickId !== "string" || typeof parsed.pid !== "number" || typeof parsed.at !== "string") {
      return null;
    }
    return { tickId: parsed.tickId, pid: parsed.pid, at: parsed.at };
  } catch {
    return null;
  }
}

function write(path: string, holder: LeaseHolder): boolean {
  try {
    writeFileSync(path, `${JSON.stringify(holder)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lease, or say who has it and why it was not broken.
 *
 * The directory is created rather than assumed: the first tick on a fresh
 * machine runs before anything has made the cron root, and an ENOENT here would
 * exit before the journal existed to record it.
 */
export function acquireLease(
  dir: string,
  holder: LeaseHolder,
  ttlMin: number,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): LeaseResult {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CRON_LEASE_FILE);
  if (write(path, holder)) return { ok: true, path, brokeStale: null };

  const held = readHolder(path);
  if (held === null) {
    // A HALF-WRITTEN OR HAND-EDITED LEASE IS HELD, NOT ABSENT. Deleting a file
    // we cannot read is how a live tick loses its lease to a parse error.
    return {
      ok: false,
      heldBy: null,
      why: `the lease at ${path} is unreadable, so it is treated as held; delete it once no tick is running`,
    };
  }
  if (isAlive(held.pid)) {
    return {
      ok: false,
      heldBy: held,
      why: `tick ${held.tickId} (pid ${String(held.pid)}) is still running; it took the lease at ${held.at}`,
    };
  }
  const ageMs = Date.now() - Date.parse(held.at);
  if (!Number.isFinite(ageMs) || ageMs < ttlMin * 60_000) {
    return {
      ok: false,
      heldBy: held,
      why:
        `tick ${held.tickId} (pid ${String(held.pid)}) is gone but its lease from ${held.at} is inside the ` +
        `${String(ttlMin)}-minute TTL; a dead pid may still have a child finishing`,
    };
  }
  // BREAK: remove, then re-create with `wx`. Two racing breakers both remove,
  // and exactly one of them creates.
  rmSync(path, { force: true });
  if (!write(path, holder)) {
    return { ok: false, heldBy: null, why: `another tick broke ${held.tickId}'s stale lease first` };
  }
  return { ok: true, path, brokeStale: held };
}

/**
 * Release ONLY our own lease.
 *
 * Scoped by `tickId` because an unscoped release turns a stale-lease break into
 * a double free: the tick whose lease was broken finishes, deletes the lease the
 * breaker now holds, and a third tick starts alongside the second.
 */
export function releaseLease(dir: string, tickId: string): void {
  const path = join(dir, CRON_LEASE_FILE);
  const held = readHolder(path);
  if (held === null || held.tickId !== tickId) return;
  rmSync(path, { force: true });
}
