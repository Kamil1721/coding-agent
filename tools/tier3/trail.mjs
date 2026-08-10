/**
 * TIER 3 — THE APPEND-ONLY AUDIT TRAIL.
 *
 * REUSE, DON'T INVENT: `dashboard/server/probes/README.md` already specifies
 * this shape — an immutable `history/<stamp>.json`, an append-only
 * `index.jsonl`, a mutable `latest.json` pointer — and it already names the
 * anti-pattern, with a confession: before 2026-07-28 the writer silently
 * overwrote, so *"re-run until it goes green" was frictionless and invisible*.
 * DESIGN §6.7 measures that `calibration-4a.mjs` STILL writes that way today
 * (one `outFile`, no history, no index line), for the single most important
 * measurement in the gate.
 *
 * SO THE IMMUTABILITY IS ENFORCED, NOT DOCUMENTED: `appendTrail` REFUSES to
 * write a history file that already exists. Arm A5 proves the refusal at
 * start-up by attempting it while the answer is known.
 *
 * LOCATION, AND A DELIBERATE DEPARTURE FROM DESIGN §6.7. The design puts the
 * trail under `dashboard/server/probes/results/tier3/`, which is inside the
 * FROZEN-DATA prefix `dashboard/server/probes/results/`. Writing the trail
 * there would move the frozen manifest on every cycle, so the gate's own
 * output would invalidate the gate's own integrity check. The trail therefore
 * defaults to `dashboard/data/tier3/` — runtime data, beside the defect
 * records of the shared contract — and is overridable with TIER3_TRAIL_DIR.
 *
 * `humanReviewed` starts null and only a human sets it, so *"has anyone ever
 * looked at this?"* is a field and not a memory.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TRAIL_SCHEMA_VERSION = 1;

export function trailDir(repoRoot) {
  const fromEnv = process.env.TIER3_TRAIL_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return join(repoRoot, "dashboard", "data", "tier3");
}

export function historyName(stamp, slug) {
  return `${stamp}-${slug}.json`;
}

/**
 * Append one cycle. Returns `{ok:false, reason}` rather than throwing when the
 * history file exists, so the caller records the refusal in its own verdict
 * instead of dying on it.
 */
export function appendTrail(record, dir) {
  mkdirSync(join(dir, "history"), { recursive: true });
  const stamp = record.runStamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const slug = record.change ?? "unnamed";
  const file = join(dir, "history", historyName(stamp, slug));

  if (existsSync(file)) {
    return {
      ok: false,
      reason:
        `the immutable history record ${historyName(stamp, slug)} already exists. It is NOT overwritten: ` +
        "a writer that overwrites makes re-running until green frictionless and invisible, which is the " +
        "defect probes/README.md confesses for the pre-2026-07-28 writer and DESIGN §6.7 measures in " +
        "calibration-4a.mjs today.",
      file,
    };
  }

  const full = { schemaVersion: TRAIL_SCHEMA_VERSION, humanReviewed: null, ...record, runStamp: stamp, change: slug };
  writeFileSync(file, `${JSON.stringify(full, null, 2)}\n`);
  appendFileSync(
    join(dir, "index.jsonl"),
    `${JSON.stringify({
      at: full.at ?? new Date().toISOString(),
      runStamp: stamp,
      change: slug,
      signature: full.signature ?? null,
      route: full.route ?? null,
      verdict: full.verdict ?? null,
      applied: full.applied ?? false,
      applyToken: full.applyToken ?? null,
      humanReviewed: null,
      file: historyName(stamp, slug),
    })}\n`,
  );
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(full, null, 2)}\n`);
  return { ok: true, file, index: join(dir, "index.jsonl"), latest: join(dir, "latest.json") };
}

export function readIndex(dir) {
  const path = join(dir, "index.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

export function historyFiles(dir) {
  const path = join(dir, "history");
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((n) => n.endsWith(".json")).sort();
}

/**
 * The un-reviewed backlog. The owner's question is "has anyone ever looked at
 * these?", and it must be answerable without reading every record.
 */
export function unreviewed(dir) {
  return readIndex(dir).filter((row) => row.humanReviewed === null && row.applied === true);
}
