/**
 * design-lock.ts — the one place a human pause is worth it, bounded so it never
 * costs an unattended run.
 *
 * WHY THIS IS A GRADER FEATURE AND NOT A UI FEATURE (spec §17.2). The visual gate
 * compares the built site against the design — but against WHICH of five? A
 * locked reference turns "does this resemble something we generated" into "does
 * this match the design that was CHOSEN". `visual-criteria.ts` already grades
 * against `lockedMockup` and falls back to the rule-based floor when it is null;
 * this file is what makes it non-null.
 *
 * EVERY VALIDATION HERE GUARDS THE SAME SEAM: the locked path arrives either from
 * an HTTP body or from a file an agent wrote, and it is then injected into every
 * build agent's prompt and `Read` by the visual gate. An unvalidated path there
 * is a file-read primitive. It must be one of the manifest's own refs, or there
 * is no lock.
 *
 * RULE 1 IS A BEHAVIOUR, NOT A CONSTANT. `designLockTimeoutMin` bounds the park
 * and `designLockExpired` decides an expiry the same way on both of the two paths
 * that can end one: the live timer Task 10 arms, and `reconcileOnBoot` after a
 * restart. They agree AT the deadline (`>=`, not `>`) — a park the timer would
 * have resolved at exactly T+delay, that the boot path then reads as "still
 * waiting", is a park with no remaining mechanism to end it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignLockedBy, DesignManifest } from "./design-manifest.js";
import { DESIGN_CHOICE_FILE } from "./design-prompt.js";

export type DesignLockPolicy = "auto" | "ask";

export const DESIGN_LOCK_TIMEOUT_ENV = "DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN";

/**
 * Spec §17.3 rule 1 says "pick a sane finite value, not infinity". Thirty
 * minutes: long enough for an owner who stepped away from the dashboard, short
 * enough that a forgotten run still finishes within the hour.
 */
export const DEFAULT_DESIGN_LOCK_TIMEOUT_MIN = 30;

/**
 * §17.3 rule 2. `auto` when the request is not interactive — a cron run that
 * parks forever waiting for a click is the exact failure unattended operation
 * exists to avoid. An UNRECOGNISED value is `auto` rather than an error, on the
 * same principle: the safe direction is the one that finishes.
 */
export function designLockPolicy(requested: unknown, interactive: boolean): DesignLockPolicy {
  if (requested === "ask") return "ask";
  if (requested === "auto") return "auto";
  return interactive ? "ask" : "auto";
}

export function designLockTimeoutMin(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat((env[DESIGN_LOCK_TIMEOUT_ENV] ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DESIGN_LOCK_TIMEOUT_MIN;
}

/**
 * Computed from the PARK TIME rather than from a live timer, so a dashboard
 * restart during a park does not reset the clock — `reconcileOnBoot` asks this
 * and finishes an expired park instead of leaving it forever.
 *
 * `>=` is load-bearing: the live timer fires at exactly `timeoutMin * 60_000`
 * after the park, so the instant it fires this must already read as expired.
 */
export function designLockExpired(parkedAt: string, now: string, timeoutMin: number): boolean {
  const parked = Date.parse(parkedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(parked) || !Number.isFinite(at)) return true;
  return at - parked >= timeoutMin * 60_000;
}

export interface LockAttempt {
  readonly path: string;
  readonly by: DesignLockedBy;
  readonly reason: string;
  readonly at: string;
}

export type LockResult =
  | { readonly ok: true; readonly manifest: DesignManifest }
  | { readonly ok: false; readonly error: string };

/**
 * §17.3 rule 4: the choice is recorded either way, with who made it and why. A
 * blank reason is refused rather than defaulted, because the whole value of the
 * record is that it explains an unattended run after the fact.
 */
export function lockManifest(manifest: DesignManifest, attempt: LockAttempt): LockResult {
  if (manifest.lockedMockup !== null) {
    return {
      ok: false,
      error:
        `this run already locked ${manifest.lockedMockup}; a second lock would let the gate grade ` +
        `against a reference the build never saw`,
    };
  }
  if (!manifest.refs.some((ref) => ref.path === attempt.path)) {
    return { ok: false, error: `${attempt.path} is not one of this run's ${String(manifest.refs.length)} mockups` };
  }
  if (attempt.reason.trim().length === 0) {
    return { ok: false, error: "a lock needs a reason: an unattended run has to be explainable afterwards" };
  }
  return {
    ok: true,
    manifest: {
      ...manifest,
      lockedMockup: attempt.path,
      lockedBy: attempt.by,
      lockedReason: attempt.reason.trim(),
      lockedAt: attempt.at,
    },
  };
}

/**
 * §17.3 rule 3: the auto-chooser is `ui-designer`, not the author. The prompt
 * asks `ui-designer` to write this file; the HOST reads it and applies the lock,
 * so the provenance recorded is the provenance the host observed rather than a
 * field an agent filled in about itself.
 */
export function readChoiceFile(refsDir: string, manifest: DesignManifest, at: string): LockAttempt | null {
  const path = join(refsDir, DESIGN_CHOICE_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const chosen = record["chosen"];
  const reason = record["reason"];
  if (typeof chosen !== "string" || !manifest.refs.some((ref) => ref.path === chosen)) return null;
  const text = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "no reason given";
  return { path: chosen, by: "ui-designer", reason: text, at };
}

/**
 * The last resort, named as such.
 *
 * `by: "fallback"` is deliberately NOT one of §17.3's two choosers: recording an
 * arbitrary pick as `ui-designer` would be a lie about provenance, and recording
 * nothing would leave the gate with no reference on a run that had five mockups.
 * First by manifest order, said plainly rather than dressed up as a judgement.
 */
export function fallbackChoice(manifest: DesignManifest, at: string, why: string): LockAttempt | null {
  const first = manifest.refs[0];
  if (first === undefined) return null;
  return {
    path: first.path,
    by: "fallback",
    reason: `${why}; the first mockup in manifest order was locked automatically, with no judgement applied`,
    at,
  };
}

/* ---- the record beside the run record --------------------------------- */

/**
 * ONE DEFINITION OF THE LABEL. `#recordDesignMockups` writes it onto each
 * screenshot and `toDetail` filters on it; typing the string twice is how the
 * owner's mockup cards quietly become empty six months from now.
 */
export const DESIGN_MOCKUP_LABEL = "design mockup — ";

export const DESIGN_LOCK_RECORD_FILE = "design-lock.json";

/**
 * §17.3 rule 5: "A locked design is an input to the gate, so it is recorded in
 * the run record alongside the ticket."
 *
 * IN ITS OWN FILE, FOR THE REASON `writeEnvironmentRecord` IS: `RunRecord` is a
 * bake-off contract type and `bakeoff/` is not ours to modify, so a field cannot
 * be added to it. The two are read together.
 *
 * `parkedAt` is what makes the timeout survive a restart — the park's clock is
 * on disk, not in a timer.
 */
export interface DesignLockRecord {
  readonly awaiting: boolean;
  readonly parkedAt: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly reason: string | null;
}

export function writeDesignLock(resultsDir: string, record: DesignLockRecord): void {
  writeFileSync(join(resultsDir, DESIGN_LOCK_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function readDesignLock(resultsDir: string): DesignLockRecord | null {
  const path = join(resultsDir, DESIGN_LOCK_RECORD_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesignLockRecord;
  } catch {
    return null;
  }
}
