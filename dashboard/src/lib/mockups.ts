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
 * "REFERENCE" MEANS TWO DIFFERENT THINGS IN THIS PROGRAM AND ONLY ONE OF THEM IS
 * IN THIS FILE. Everything below — `CaptureSplit.references`, `designLock`'s
 * refs, `isPublishedAs` — is the DESIGN lane's own output: mockups `ui-designer`
 * generated and the workspace refs the lock was taken on. `RunDetail.references`
 * on the wire is something else entirely: the images the OWNER uploaded with the
 * ticket, served by `GET /api/runs/:id/references/:file` and rendered by
 * `components/run/attachments.tsx` on a different tab. Nothing here reads that
 * field and nothing there calls `splitCaptures`; the collision is in the English
 * word, not in the data, and merging the two under one heading is the mis-read
 * both files are written to prevent.
 *
 * THE TWO MIRRORED LITERALS BELOW ARE THE RISK IN THIS FILE. `MOCKUP_LABEL` is
 * the server's `DESIGN_MOCKUP_LABEL` (design-lock.ts) and `MOCKUP_COPY_PREFIX` is
 * the literal `#recordDesignMockups` prefixes each copy with. Neither is on the
 * wire, so nothing here can verify them at runtime, and BOTH FAIL SOFT ON
 * PURPOSE: an unrecognised label renders whole instead of blank, and a name that
 * matches nothing distinguishes no card instead of the wrong one. A drift is then
 * a cosmetic loss, never a wrong claim about which design was built.
 */

import type {
  DesignDirectionState,
  DesignLockState,
  DesignStage,
  DesignRenderRequest,
  RunDetail,
  Screenshot,
} from "./api-types";
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

/* ------------------------------------------------------------------ */
/* READING THE NINE FIELDS ADDED ON 2026-08-03                         */
/*                                                                     */
/* `api.ts` casts responses with `parsed as T` and validates nothing,  */
/* and the three runs on disk answer with a `designLock` that has none */
/* of these keys. `lock.directions.length` on one of those bodies is a */
/* TypeError inside a render — a blank run page. These three readers   */
/* are the only sanctioned way in, and every consumer uses them.       */
/* ------------------------------------------------------------------ */

/** `[]` for a lock recorded before directions existed. */
export function directionsOf(lock: DesignLockState): readonly DesignDirectionState[] {
  return Array.isArray(lock.directions) ? lock.directions : [];
}

/** `[]` for a lock recorded before the design dialogue existed. */
export function requestsOf(lock: DesignLockState): readonly DesignRenderRequest[] {
  return Array.isArray(lock.requests) ? lock.requests : [];
}

/**
 * `"none"` for a lock the server sent without a stage.
 *
 * IT IS NOT DERIVED FROM `directions.length` — the server owns the stage and a
 * second derivation here could disagree with it. The only thing decided here is
 * what an ABSENT value reads as, and it reads as the pre-2026-08-03 shape.
 */
export function stageOf(lock: DesignLockState): DesignStage {
  const stage: unknown = lock.stage;
  return stage === "canvass" || stage === "expanding" || stage === "settled" ? stage : "none";
}

/** A counter the wire did not carry reads 0, NEVER "unlimited". */
export function countOf(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The direction the owner picked, or null while the canvass is open. */
export function chosenDirectionOf(lock: DesignLockState): DesignDirectionState | null {
  if (lock.chosenDirection === null || lock.chosenDirection === undefined) return null;
  return directionsOf(lock).find((direction) => direction.slug === lock.chosenDirection) ?? null;
}

/**
 * The lock as one of five renderable states.
 *
 * `settled` IS TESTED FIRST AND THAT ORDER IS LOAD-BEARING. A recorded choice is
 * the fact about this run whatever its status says; asking `awaiting` first would
 * let a stale park record repaint a locked run as still asking.
 *
 * `expanding` IS TESTED BEFORE `unlocked`, AND THAT ORDER IS THE 2026-08-03 BUG
 * THIS FUNCTION EXISTS TO NOT SHIP. Between the direction choice and the hero
 * lock the record reads `{awaiting: false, locked: null}` — for the whole of
 * stage B, which is a full per-section image set and minutes long. The old
 * ordering returned `unlocked` for that window, whose panel copy is "The DESIGN
 * lane finished without a design to lock": the exact opposite of what is
 * happening. `stage` is the only field that separates them.
 *
 * (It sits BELOW the `locked` test rather than above it because the two are
 * mutually exclusive by construction — the server moves the stage to `settled`
 * on the same write that locks the hero — and because `settled`-first is pinned
 * by `design-lock.unit.spec.ts` for the stale-park reason above. A run that
 * somehow carried both would be read as locked, which is the fact with evidence
 * behind it.)
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
export type DesignLockPhase = "pending" | "closing" | "expanding" | "settled" | "unlocked";

export function designLockPhase(
  status: RunDetail["status"],
  lock: DesignLockState,
): DesignLockPhase {
  if (lock.locked !== null) return "settled";
  if (stageOf(lock) === "expanding") return "expanding";
  if (!lock.awaiting) return "unlocked";
  return status === "awaiting_input" ? "pending" : "closing";
}

/** The published card the lock was taken on, or null when nothing matches. */
export function lockedMockup(lock: DesignLockState): Screenshot | null {
  const locked = lock.locked;
  if (locked === null) return null;
  return lock.mockups.find((shot) => isPublishedAs(shot.path, locked)) ?? null;
}

/**
 * A run's captures, split into THE SITE THE RUN BUILT and the design references
 * it was built from.
 *
 * WHY THE SPLIT IS POSSIBLE AT ALL. `RunDetail.screenshots` is one flat list
 * holding both, because a published mockup IS a screenshot row: the orchestrator
 * has exactly two writers of `addScreenshot` — `#recordDesignMockups`
 * (orchestrator.ts:1715, the five design refs copied into the served directory)
 * and `#recordScreenshots` (orchestrator.ts:2286, the scorer's captures of the
 * built site, labelled `<flowId> @ <breakpoint>`). Nothing else adds a row, so
 * "not a mockup" means "a capture of the artefact" on every run this code has
 * been read against.
 *
 * THE PRIMARY TEST IS PATH MEMBERSHIP IN THE SERVER'S OWN ANSWER. `http.ts:272`
 * builds `designLock.mockups` as `screenshots.filter(label.startsWith(
 * DESIGN_MOCKUP_LABEL))` — the same rows, so the path strings are identical and
 * a `Set` of them partitions the flat list exactly, with no string parsing on
 * this side and no second definition of what a mockup is.
 *
 * `MOCKUP_LABEL` IS A FAIL-SOFT SECONDARY, AND IT COVERS ONE REAL HOLE. The
 * server sends `designLock: null` when the lane wrote no `design-lock.json`
 * (http.ts's `readDesignLock` returns null), while `#recordDesignMockups` may
 * already have published the copies and written their rows — a lane that
 * produced images and then died before recording. In that state the primary set
 * is empty and only the label tells a mockup from a capture, so the two are
 * OR-ed rather than the label being ignored.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: if the server's label
 * constant ever drifts from `MOCKUP_LABEL` *and* `designLock` is null on the
 * same run, a mockup lands in the product group and is shown under a heading
 * that calls it the owner's site. Both halves have to fail together for that,
 * and the authoritative half does not depend on a mirrored literal at all.
 *
 * ORDER IS PRESERVED WITHIN EACH GROUP — the list arrives `captured_at ASC`
 * (`db.ts:929`) and nothing here re-sorts it. The panel changes which GROUP
 * comes first, not the order of the captures inside one.
 */
export interface CaptureSplit {
  /** Captures of the artefact this run built. */
  readonly product: readonly Screenshot[];
  /** The DESIGN lane's published mockups. */
  readonly references: readonly Screenshot[];
}

export function splitCaptures(
  screenshots: readonly Screenshot[],
  mockups: readonly Screenshot[],
): CaptureSplit {
  const published = new Set(mockups.map((shot) => shot.path));
  const product: Screenshot[] = [];
  const references: Screenshot[] = [];

  for (const shot of screenshots) {
    if (published.has(shot.path) || shot.label.startsWith(MOCKUP_LABEL)) {
      references.push(shot);
    } else {
      product.push(shot);
    }
  }

  return { product, references };
}

/**
 * The reference group, split again by WHAT EACH STILL IS — which after
 * 2026-08-03 is three different things under one heading.
 *
 * WHY THIS EXISTS. `splitCaptures` was written when every published mockup
 * belonged to the one direction the run was built to, so `references` could
 * honestly be labelled "the mockups the run was built to". A canvassed run
 * publishes stills from directions that were OFFERED AND DISCARDED, plus stills
 * the owner ASKED FOR while parked; two thirds of that heading is then a false
 * claim, and the discarded ones are the claim the whole two-stage shape exists
 * to avoid — the run was never graded against them.
 *
 * `requested` IS TESTED FIRST, and off `requests[].mockup` rather than off any
 * naming convention. That field is the host's own record of what it rendered on
 * demand, so it cannot disagree with itself; whether a direction's `mockups`
 * list happens to include its on-demand stills is then irrelevant here.
 *
 * `ungrouped` IS NOT AN ERROR AND IS THE WHOLE OF A PRE-DIRECTIONS RUN. With no
 * directions on the wire every reference lands here and the caller keeps its
 * original heading, which is what "old runs render unchanged" means mechanically.
 */
export interface ReferenceGroups {
  /** Stills of the direction the build was made to and graded against. */
  readonly built: readonly Screenshot[];
  /** Stills of a direction that was offered and NOT built. */
  readonly offered: readonly Screenshot[];
  /** Stills the owner asked for at the park. */
  readonly requested: readonly Screenshot[];
  /** Everything no direction claims — every still on a run that had none. */
  readonly ungrouped: readonly Screenshot[];
}

export function groupReferences(
  references: readonly Screenshot[],
  lock: DesignLockState | null,
): ReferenceGroups {
  const built: Screenshot[] = [];
  const offered: Screenshot[] = [];
  const requested: Screenshot[] = [];
  const ungrouped: Screenshot[] = [];

  const directions = lock === null ? [] : directionsOf(lock);
  const onDemand = new Set(
    (lock === null ? [] : requestsOf(lock))
      .map((request) => request.mockup)
      .filter((path): path is string => typeof path === "string" && path !== ""),
  );
  const chosen = lock === null ? null : lock.chosenDirection;
  const inChosen = new Set(
    directions.filter((direction) => direction.slug === chosen).flatMap((direction) => direction.mockups),
  );
  const inDiscarded = new Set(
    directions.filter((direction) => direction.slug !== chosen).flatMap((direction) => direction.mockups),
  );

  for (const shot of references) {
    if (onDemand.has(shot.path)) requested.push(shot);
    else if (inChosen.has(shot.path)) built.push(shot);
    else if (inDiscarded.has(shot.path)) offered.push(shot);
    else ungrouped.push(shot);
  }

  return { built, offered, requested, ungrouped };
}

