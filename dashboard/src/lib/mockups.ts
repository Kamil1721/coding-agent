/**
 * The DESIGN lock, reduced to the four states the UI actually renders — and the
 * one string comparison that says which card was chosen.
 *
 * WHY `locked` AND `mockups[].path` ARE NOT THE SAME STRING, which is the whole
 * reason this file exists. The orchestrator COPIES each design ref out of the
 * run's workspace into `results/screenshots/<runId>/design-<basename>`, because
 * that directory is what `GET /api/runs/:id/screenshots/:file` serves and the
 * workspace is the artefact rather than a served directory. So
 * `designLock.mockups[].path` is the COPY, while `designLock.locked` is the
 * WORKSPACE REF the lock was taken on — the path the build agents and the visual
 * gate read. Comparing the two with `===` finds no locked card, ever, on a run
 * that definitely locked one.
 *
 * PREFIX-ADD, NEVER PREFIX-STRIP. `isPublishedAs` builds the copy's name from the
 * ref and compares, rather than cutting `design-` off the front of the copy: a
 * ref genuinely named `design-hero.png` is published as `design-design-hero.png`,
 * and stripping one prefix off either end of that pair matches the wrong file.
 * Adding is exact in both directions.
 *
 * THE TWO MIRRORED LITERALS BELOW ARE THE RISK IN THIS FILE. `MOCKUP_LABEL` is
 * the server's `DESIGN_MOCKUP_LABEL` (design-lock.ts) and `MOCKUP_COPY_PREFIX` is
 * the literal `#recordDesignMockups` prefixes each copy with. Neither is on the
 * wire, so nothing here can verify them at runtime, and BOTH FAIL SOFT ON
 * PURPOSE: an unrecognised label renders whole instead of blank, and a name that
 * matches nothing distinguishes no card instead of the wrong one. A drift is then
 * a cosmetic loss, never a wrong claim about which design was built.
 */

import type { DesignLockState, RunDetail, Screenshot } from "./api-types";
import { basename } from "./screenshots";

/** The server's `DESIGN_MOCKUP_LABEL`. The dash is an em dash; do not "clean" it. */
export const MOCKUP_LABEL = "design mockup — ";

/** The server's copy prefix, keeping a mockup clear of a gate capture's basename. */
export const MOCKUP_COPY_PREFIX = "design-";

/**
 * The section this mockup is of.
 *
 * The label is the ONLY place a section reaches the browser — `DesignRef.intent`
 * and `DesignRef.aspect` exist on the server's manifest and are not on the wire,
 * so nothing here can show them and nothing here invents them.
 */
export function mockupSection(label: string): string {
  const trimmed = label.startsWith(MOCKUP_LABEL) ? label.slice(MOCKUP_LABEL.length) : label;
  return trimmed.trim() === "" ? label : trimmed;
}

/** Is `mockupPath` the published copy of the ref at `refPath`? */
export function isPublishedAs(mockupPath: string, refPath: string): boolean {
  if (mockupPath === refPath) return true;
  const ref = basename(refPath);
  return ref !== "" && basename(mockupPath) === `${MOCKUP_COPY_PREFIX}${ref}`;
}

/**
 * The lock as one of four renderable states.
 *
 * `settled` IS TESTED FIRST AND THAT ORDER IS LOAD-BEARING. A recorded choice is
 * the fact about this run whatever its status says; asking `awaiting` first would
 * let a stale park record repaint a locked run as still asking.
 *
 * `closing` IS NOT `unlocked`. When the timeout fires, the server locks
 * automatically and moves the run to `queued` — and `status` arrives over SSE
 * while `designLock` only refreshes on the next REST read, so for one poll
 * interval the cached record still reads `{awaiting: true, locked: null}`. That
 * shape is ALSO what a lane which produced nothing to lock looks like, and the
 * two mean opposite things: one is a choice being recorded, the other is a
 * degraded lane. The status is what separates them, so it is what this switches
 * on — and `closing` is the cue to re-read, never a claim about an outcome.
 */
export type DesignLockPhase = "pending" | "closing" | "settled" | "unlocked";

export function designLockPhase(
  status: RunDetail["status"],
  lock: DesignLockState,
): DesignLockPhase {
  if (lock.locked !== null) return "settled";
  if (!lock.awaiting) return "unlocked";
  return status === "awaiting_input" ? "pending" : "closing";
}

/** The published card the lock was taken on, or null when nothing matches. */
export function lockedMockup(lock: DesignLockState): Screenshot | null {
  const locked = lock.locked;
  if (locked === null) return null;
  return lock.mockups.find((shot) => isPublishedAs(shot.path, locked)) ?? null;
}

