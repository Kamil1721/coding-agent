/**
 * cron-queue.ts — the owner's ticket directory, and ONE atomic claim.
 *
 * THE GAP THIS FILE EXISTS TO CLOSE. Between "the ticket left the queue" and "a
 * run exists" there is a window in which an unattended scheduler can lose work,
 * and the loss is invisible: the file is simply not in `queue/` any more. So the
 * move out of `queue/` is a single `renameSync` — atomic within a filesystem —
 * into `claimed/`, which is a directory whose entire purpose is to be READ AT
 * THE START OF THE NEXT TICK. A non-empty `claimed/` means a previous tick died
 * mid-submit, and that halts cron loudly instead of being guessed at.
 *
 * WHY NOT COPY-AND-DELETE. A copy that succeeds while the delete fails leaves the
 * ticket in BOTH places: the next tick claims it again and the owner pays for two
 * builds of one brief. `renameSync` cannot produce that state — it either moved
 * or it did not.
 *
 * WHY THE TEXT IS READ AFTER THE RENAME, from the claimed path: the bytes
 * submitted are then provably the bytes claimed. Reading first and renaming
 * second leaves a window where the owner edits the file between the two.
 *
 * FAIL-CLOSED ON A STRANDED CLAIM IS A CHOICE WITH A COST, stated here. It halts
 * all cron work until a human looks, because the alternative is guessing whether
 * a `POST` landed, and guessing wrong means a duplicate build. The journal's
 * intent row plus `GET /api/runs` makes the question answerable in one look.
 *
 * PLAINTEXT ON DISK, NOT REDACTED. Redaction happens at the STORE boundary
 * (`db.ts`), so a secret pasted into a queue file is redacted on its way into
 * `runs.ticket_text` — and is NOT redacted in `queue/`, `claimed/` or
 * `submitted/`. That is the same exposure as any file the owner writes under
 * their own home, and it is said rather than implied.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

export const CRON_DIRS = Object.freeze({
  queue: "queue",
  claimed: "claimed",
  submitted: "submitted",
  failed: "failed",
});

export function ensureCronDirs(root: string): void {
  for (const dir of Object.values(CRON_DIRS)) mkdirSync(join(root, dir), { recursive: true });
}

/** Absolute paths, lexicographic. Dotfiles and directories are ignored. */
function listFiles(dir: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(dir, name));
}

/**
 * The tickets waiting, in the order they will be claimed.
 *
 * LEXICOGRAPHIC, so `10-a.md` before `20-b.md` and the owner controls the order
 * by naming. Not mtime: a file the owner re-saved would jump the queue, which is
 * a surprising amount of behaviour to attach to an editor.
 */
export function listQueue(root: string): readonly string[] {
  return listFiles(join(root, CRON_DIRS.queue));
}

export type ClaimResult =
  | { readonly ok: true; readonly claimedPath: string; readonly ticketText: string }
  | { readonly ok: false; readonly why: string };

/**
 * Take one ticket, atomically. `ENOENT` is a lost race and is `ok: false`.
 *
 * The `tickId` is in the claimed filename so a stranded claim names the tick
 * that stranded it, and the journal's intent row for that tickId is findable.
 */
export function claim(root: string, ticketFile: string, tickId: string): ClaimResult {
  const claimedPath = join(root, CRON_DIRS.claimed, `${tickId}-${basename(ticketFile)}`);
  try {
    renameSync(ticketFile, claimedPath);
  } catch (error) {
    return {
      ok: false,
      why: `${basename(ticketFile)} could not be claimed: ${(error as Error).message}`,
    };
  }
  try {
    return { ok: true, claimedPath, ticketText: readFileSync(claimedPath, "utf8") };
  } catch (error) {
    // THE TICKET IS NOW IN `claimed/` AND UNREADABLE. Deliberately not moved
    // back: the next tick's stranded-claim check reports it by name, which is
    // louder than a silent re-queue of a file we could not read.
    return { ok: false, why: `${basename(claimedPath)} was claimed but could not be read: ${(error as Error).message}` };
  }
}

/**
 * Settle a claim that produced a run. The run id goes in the FILENAME, so the
 * ticket that produced a run is findable from either end without opening
 * anything.
 */
export function settleSubmitted(root: string, claimedPath: string, runId: string): string {
  const target = join(root, CRON_DIRS.submitted, `${runId}-${basename(claimedPath)}`);
  renameSync(claimedPath, target);
  return target;
}

/**
 * Settle a claim the dashboard refused.
 *
 * NOT RE-QUEUED. Retrying a ticket the server just rejected — an oversized
 * brief, an unknown model id — is an infinite loop against a 400, once a night,
 * forever. The reason is in the journal row beside it.
 */
export function settleFailed(root: string, claimedPath: string): string {
  const target = join(root, CRON_DIRS.failed, basename(claimedPath));
  renameSync(claimedPath, target);
  return target;
}

/** Claims left behind by a tick that died. NON-EMPTY MEANS STOP. */
export function strandedClaims(root: string): readonly string[] {
  return listFiles(join(root, CRON_DIRS.claimed));
}
