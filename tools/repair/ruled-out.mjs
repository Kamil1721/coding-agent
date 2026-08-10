/**
 * WHAT WAS RULED OUT — failed proposals are first-class records, not discards.
 *
 * A corpus that stores only what worked will re-suggest a failed repair forever. This is
 * also the run a913c871 shape at the repair level: attempt 3 re-proposed attempt 1's answer
 * because nothing on disk said "already tried, did not clear it".
 *
 * Append-only, content-addressed by defect signature, one JSON object per line. Every
 * verdict is written — ACCEPTED, REFUSED and COULD_NOT_REPRODUCE alike — because a refusal
 * that leaves no row is indistinguishable from a refusal that never ran.
 *
 * The production store is `dashboard/data/defects/ruled-out/`, alongside the defect stream
 * another lane owns. This module never assumes that directory: the caller passes one.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where this belongs in production. Not used as a default: callers pass a directory. */
export const PRODUCTION_LEDGER_DIR = "dashboard/data/defects/ruled-out";

const SAFE = /^[a-f0-9]{8,128}$/i;

function fileFor(dir, signature) {
  const sig = String(signature ?? "").trim();
  if (!SAFE.test(sig)) throw new Error(`ruled-out ledger: refusing a signature that is not a hex digest: ${JSON.stringify(sig)}`);
  return join(dir, `${sig}.jsonl`);
}

export function openLedger(dir) {
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("ruled-out ledger: a directory is required");

  /** Append one record. Returns the record as written. */
  function append(record) {
    const row = {
      at: record.at ?? new Date().toISOString(),
      signature: record.signature,
      verdict: record.verdict,
      proposalFingerprint: record.proposalFingerprint ?? null,
      filesChanged: record.filesChanged ?? [],
      reasons: (record.reasons ?? []).map((r) => (typeof r === "string" ? { code: r, detail: "" } : r)),
      note: record.note ?? null,
    };
    mkdirSync(dir, { recursive: true });
    appendFileSync(fileFor(dir, row.signature), JSON.stringify(row) + "\n", "utf8");
    return row;
  }

  /** Every record ever written for this signature, oldest first. */
  function read(signature) {
    const path = fileFor(dir, signature);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }

  /** The diff fingerprints already known not to clear this signature. */
  function ruledOutFingerprints(signature) {
    return [
      ...new Set(
        read(signature)
          .filter((r) => r.verdict !== "ACCEPTED" && typeof r.proposalFingerprint === "string")
          .map((r) => r.proposalFingerprint),
      ),
    ];
  }

  return { dir, append, read, ruledOutFingerprints, fileFor: (sig) => fileFor(dir, sig) };
}
