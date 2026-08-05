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
import { basename, join } from "node:path";
import type { DesignLockedBy, DesignManifest } from "./design-manifest.js";
import { DESIGN_CHOICE_FILE, DESIGN_DIRECTION_CHOICE_FILE } from "./design-prompt.js";

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

/**
 * How much of this park's window is left, in milliseconds.
 *
 * FROM THE RECORD'S OWN `parkedAt`, WHICH IS THE DURABLE HALF OF THE BOUND. The
 * park record is merged rather than rebuilt, so `parkedAt` survives every re-park
 * — and a timer armed from anything else (a caller's defaulted argument, a fresh
 * `Date.now()`) walks the deadline forward every time the park is re-announced
 * while the record keeps the original instant. This is the same reading
 * {@link designLockExpired} makes, in the same direction: `remaining === 0`
 * exactly when that returns true, so the two can never disagree about whether a
 * park is over.
 *
 * A BLANK OR UNPARSEABLE `parkedAt` GETS THE FULL WINDOW rather than zero. That
 * is a record written before the field existed, and `setTimeout(NaN)` fires
 * immediately — an expiry the owner never had a chance to answer. The boot path
 * reads such a record as expired and resolves it there, where it can say so.
 */
export function designLockRemainingMs(parkedAt: string, now: number, timeoutMin: number): number {
  const full = timeoutMin * 60_000;
  const parked = Date.parse(parkedAt);
  if (!Number.isFinite(parked) || !Number.isFinite(now)) return full;
  return Math.max(0, full - Math.max(0, now - parked));
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
 *
 * THE OWNER'S OWN ATTACHED IMAGE IS NOT LOCKABLE HERE, AND THAT IS THE ANSWER
 * RATHER THAN THE PROBLEM (2026-08-05 design-fidelity spec §4.2). His image
 * lives in `runs/<id>/references/`, so the `manifest.refs` test below refuses it
 * exactly as it refuses any other path — and the refusal must stay. The refs
 * test is not a membership formality; it is what keeps the header's file-read
 * primitive shut, and it cannot distinguish "a path the host wrote" from "a path
 * an agent wrote into the manifest" because by the time a path reaches this
 * function both are just strings. Widening it for the owner's image would widen
 * it for every agent-authored path in the same edit.
 *
 * SO THE OWNER'S IMAGE TRAVELS BY A DIFFERENT ROAD, and it is worth naming here
 * because "why can't the thing he actually sent be the reference" is the first
 * question anyone reading this file asks. `owner-reference.ts` validates it out
 * of `references/references.json` — host-written, outside the build sandbox's
 * `allowWrite` — and `visual-criteria.ts` points a QUALITY criterion at it. It
 * is a second REFERENT for grading, never a lock candidate: `lockedMockup` keeps
 * meaning "the generated design that was CHOSEN", which is what the gate prompt,
 * the mockup cards and every record on disk already take it to mean.
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

/* ---- the DIRECTION choice, one stage earlier --------------------------- */

export interface DirectionAttempt {
  readonly slug: string;
  readonly by: DesignLockedBy;
  readonly reason: string;
  readonly at: string;
}

/**
 * Mirrors {@link lockManifest} exactly: it refuses a second choice, a slug the
 * manifest never declared, and a blank reason.
 *
 * A SECOND CHOICE IS REFUSED FOR A DIFFERENT REASON FROM A SECOND LOCK, and the
 * difference is worth the sentence. A second LOCK would let the gate grade
 * against a reference the build never saw. A second DIRECTION would be worse: the
 * expansion has already spent five to seven generations on the first choice, so
 * re-choosing would either strand that spend or produce a manifest whose
 * `chosenDirection` disagrees with the stills that were actually built.
 *
 * A BLANK REASON IS REFUSED because the whole value of the record is that it
 * explains an unattended run afterwards — the owner comes back to a built site
 * and needs to know which of the three he was offered it came from and why.
 */
export function chooseDirection(manifest: DesignManifest, attempt: DirectionAttempt): LockResult {
  if (manifest.chosenDirection !== null) {
    return {
      ok: false,
      error:
        `this run already chose the "${manifest.chosenDirection}" direction; a second choice would ` +
        `leave the expansion already under way pointing at a direction nobody picked`,
    };
  }
  if (!manifest.directions.some((direction) => direction.slug === attempt.slug)) {
    return {
      ok: false,
      error: `"${attempt.slug}" is not one of this run's ${String(manifest.directions.length)} directions`,
    };
  }
  if (attempt.reason.trim().length === 0) {
    return { ok: false, error: "a direction choice needs a reason: an unattended run has to be explainable afterwards" };
  }
  return {
    ok: true,
    manifest: {
      ...manifest,
      chosenDirection: attempt.slug,
      directionChoice: { by: attempt.by, reason: attempt.reason.trim(), at: attempt.at },
    },
  };
}

/**
 * §17.3 rule 3, one stage earlier: `ui-designer` scores the DIRECTIONS and writes
 * this file; the HOST reads it and applies the choice.
 *
 * A SLUG, NOT A PATH, and that is the whole difference from {@link readChoiceFile}.
 * A `choice.json` written at stage A would lock a CANVASS still as the canonical
 * mockup, and `lockManifest` would then refuse the real hero at the end of stage B
 * — the choice arriving one stage too early and blocking the one that matters.
 */
export function readDirectionChoiceFile(
  refsDir: string,
  manifest: DesignManifest,
  at: string,
): DirectionAttempt | null {
  const path = join(refsDir, DESIGN_DIRECTION_CHOICE_FILE);
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
  if (typeof chosen !== "string" || !manifest.directions.some((direction) => direction.slug === chosen)) return null;
  const text = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "no reason given";
  return { slug: chosen, by: "ui-designer", reason: text, at };
}

/**
 * The last resort, named as such — {@link fallbackChoice}'s twin.
 *
 * `by: "fallback"` rather than `"ui-designer"`, for the same reason: recording an
 * arbitrary pick as a judgement would be a lie about provenance, and recording
 * nothing would leave a run that offered three directions with none chosen and no
 * expansion at all. First in manifest order, said plainly.
 */
export function fallbackDirectionChoice(manifest: DesignManifest, at: string, why: string): DirectionAttempt | null {
  const first = manifest.directions[0];
  if (first === undefined) return null;
  return {
    slug: first.slug,
    by: "fallback",
    reason: `${why}; the first direction in manifest order ("${first.name}") was chosen automatically, with no judgement applied`,
    at,
  };
}

/* ---- the click, translated back into a ref ----------------------------- */

/**
 * The prefix `#recordDesignMockups` publishes each ref under, DECLARED ONCE.
 *
 * `orchestrator.ts` builds the served copy's name with it and
 * {@link chosenMockupRef} rebuilds that same name to translate a click back into
 * the ref it names. Two spellings of this literal is a lock that refuses every
 * real click — while a unit test that constructs both sides from one string stays
 * green — so both sides go through {@link publishedMockupPath}.
 *
 * The client mirrors it as `MOCKUP_COPY_PREFIX` (dashboard/src/lib/mockups.ts)
 * for its own "which card was built to" ring. That copy cannot be checked from
 * here: the prefix is not on the wire, which is exactly why the browser has to
 * know it too.
 */
export const DESIGN_MOCKUP_COPY_PREFIX = "design-";

/**
 * Where `#recordDesignMockups` puts the SERVED copy of a workspace ref.
 *
 * The copy exists because `GET /api/runs/:id/screenshots/:file` resolves inside
 * `results/screenshots/<runId>/` and the workspace is the artefact, not a served
 * directory; the prefix keeps a mockup clear of a gate capture's basename.
 */
export function publishedMockupPath(screenshotsDir: string, refPath: string): string {
  return join(screenshotsDir, `${DESIGN_MOCKUP_COPY_PREFIX}${basename(refPath)}`);
}

/**
 * The workspace ref a chosen path names — or the chosen path, unchanged.
 *
 * THIS IS THE ONLY REASON A CLICK CAN LOCK A RUN. `DesignLockState.mockups[].path`
 * carries the PUBLISHED COPY, because that is the path the screenshot route can
 * serve, so the published copy is the only value any client can send. `lockManifest`
 * accepts only a manifest ref, by exact equality. Without a translation between
 * the two, every real click is refused and an `"ask"` run parks until its timeout
 * and then fallback-locks — which is strictly worse than never asking.
 *
 * PREFIX-ADD, NEVER PREFIX-STRIP, the same rule the client's `isPublishedAs`
 * states: the candidate copy's full path is BUILT from the ref and compared, so a
 * ref genuinely named `design-hero.png` (published as `design-design-hero.png`)
 * matches its own copy and nothing else's.
 *
 * A PATH THAT MATCHES NEITHER IS RETURNED UNCHANGED, and that is deliberate:
 * `lockManifest` stays the ONE place a choice is refused, and its refusal then
 * names the path the client actually sent instead of a translation of it. This
 * function must never widen that refusal — it maps one exact string to one exact
 * string, so an arbitrary path still cannot become the gate's reference.
 */
export function chosenMockupRef(manifest: DesignManifest, screenshotsDir: string, chosen: string): string {
  // A REF WINS OVER A COPY, so the host's own paths (`readChoiceFile`,
  // `fallbackChoice`, `reconcileOnBoot`) travel through here unchanged.
  if (manifest.refs.some((ref) => ref.path === chosen)) return chosen;
  const published = manifest.refs.find((ref) => publishedMockupPath(screenshotsDir, ref.path) === chosen);
  return published?.path ?? chosen;
}

/**
 * The DIRECTION a click on a published canvass still names, or null.
 *
 * WHY A CLICK CAN STILL CHOOSE, NOW THAT THE CHOICE IS A DIRECTION. The panel
 * shows the canvass stills grouped by direction, and the owner picks by clicking
 * one of them; the wire value is the PUBLISHED COPY, exactly as it was for the
 * mockup lock. This is {@link chosenMockupRef} composed with the ref's own
 * `direction`, so both translations stay in one file and neither invents a value.
 *
 * NULL WHEN THE PATH NAMES NOTHING — a stale card, a hand-made request, a run
 * with no directions at all. The caller then has no slug and leaves the run
 * parked rather than choosing a direction the owner did not name.
 */
export function directionForMockup(manifest: DesignManifest, screenshotsDir: string, chosen: string): string | null {
  const refPath = chosenMockupRef(manifest, screenshotsDir, chosen);
  return manifest.refs.find((ref) => ref.path === refPath)?.direction ?? null;
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
/** What became of one on-demand render request. */
export type DesignRenderOutcome =
  | "rendered"
  | "rendered-off-brief"
  | "unknown-direction"
  | "no-section"
  | "turn-cap"
  | "render-cap"
  | "failed";

export interface DesignRenderRequest {
  /** The owner message `seq` this came from. */
  readonly seq: number;
  readonly at: string;
  readonly section: string;
  readonly direction: string;
  readonly outcome: DesignRenderOutcome;
  readonly detail: string;
  /** The WORKSPACE ref it produced, or null. */
  readonly path: string | null;
}

/**
 * The record's mirror of one direction.
 *
 * §17.3 rule 5's PRECEDENT, applied one field wider: this file already duplicates
 * `locked`/`lockedBy`/`reason` out of the manifest, because the workspace is the
 * artefact and `results/` is the record — and `results/` is what `toDetail` can
 * read without opening a directory a build can write to. The manifest stays the
 * single source of truth; every host write of this file recomputes the mirror.
 */
export interface DesignDirectionRecord {
  readonly slug: string;
  readonly name: string;
  readonly distinction: string;
  readonly notes: string | null;
  /** PUBLISHED copies, in manifest order. Recomputed on every write of this file. */
  readonly mockups: readonly string[];
}

export interface DesignLockRecord {
  readonly awaiting: boolean;
  readonly parkedAt: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly reason: string | null;
  /* ── added 2026-08-03. `readDesignLock` DEFAULTS EACH ONE — see below. ── */
  /** Default `[]`. */
  readonly directions: readonly DesignDirectionRecord[];
  /** Default `null`. */
  readonly chosenDirection: string | null;
  /** Default `null`. */
  readonly chosenDirectionBy: DesignLockedBy | null;
  /** Default `null`. */
  readonly chosenDirectionReason: string | null;
  /** Stage B returned. Default `false`. NOT derived from `locked`: a degraded run never locks a still. */
  readonly expanded: boolean;
  /** Default `0`. */
  readonly turnsUsed: number;
  /** Default `0`. A falsy absent value must never read as "unlimited". */
  readonly rendersUsed: number;
  /** Default `[]`. */
  readonly requests: readonly DesignRenderRequest[];
  /** Default `null` = every pending message is a candidate. Mirrors `PlanRecord.askedAfterSeq`. */
  readonly askedAfterSeq: number | null;
}

export function writeDesignLock(resultsDir: string, record: DesignLockRecord): void {
  writeFileSync(join(resultsDir, DESIGN_LOCK_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function readOutcome(value: unknown): DesignRenderOutcome | null {
  const outcomes: readonly string[] = [
    "rendered",
    "rendered-off-brief",
    "unknown-direction",
    "no-section",
    "turn-cap",
    "render-cap",
    "failed",
  ];
  return typeof value === "string" && outcomes.includes(value) ? (value as DesignRenderOutcome) : null;
}

function readRecordString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readDirectionRecord(raw: unknown): DesignDirectionRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const slug = readRecordString(record["slug"]);
  if (slug === null) return null;
  const mockups = record["mockups"];
  return {
    slug,
    name: readRecordString(record["name"]) ?? slug,
    distinction: readRecordString(record["distinction"]) ?? "",
    notes: readRecordString(record["notes"]),
    mockups: Array.isArray(mockups) ? mockups.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function readRenderRequest(raw: unknown): DesignRenderRequest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const outcome = readOutcome(record["outcome"]);
  const at = readRecordString(record["at"]);
  if (outcome === null || at === null) return null;
  return {
    seq: typeof record["seq"] === "number" ? record["seq"] : 0,
    at,
    section: readRecordString(record["section"]) ?? "",
    direction: readRecordString(record["direction"]) ?? "",
    outcome,
    detail: readRecordString(record["detail"]) ?? "",
    path: readRecordString(record["path"]),
  };
}

/**
 * NORMALISED FIELD BY FIELD, WHICH IT WAS NOT BEFORE 2026-08-03.
 *
 * This used to be `JSON.parse(...) as DesignLockRecord` — a cast, which is a
 * claim the compiler checks about the TYPE and nothing checks about the BYTES.
 * Three `design-lock.json` files exist on this machine and none of them carries
 * any of the eleven fields added that day, so the cast alone would have left
 * `turnsUsed` and `rendersUsed` `undefined` at runtime while `tsc` stayed green.
 * `undefined >= MAX_DESIGN_LOCK_TURNS` is FALSE, so both caps would have read as
 * unlimited on exactly the runs that predate them — a spend bound that types say
 * exists and bytes say does not.
 *
 * IT STILL RETURNS `null` ONLY FOR A MISSING OR UNPARSEABLE FILE. The record is
 * written by the HOST into `results/`, which sits outside the build's
 * `allowWrite`, so nothing in a run can forge it; what is guarded here is the
 * ABSENCE of fields in an older file, not an adversary.
 */
export function readDesignLock(resultsDir: string): DesignLockRecord | null {
  const path = join(resultsDir, DESIGN_LOCK_RECORD_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const directions = record["directions"];
  const requests = record["requests"];
  const askedAfterSeq = record["askedAfterSeq"];
  return {
    awaiting: record["awaiting"] === true,
    parkedAt: readRecordString(record["parkedAt"]) ?? "",
    locked: readRecordString(record["locked"]),
    lockedBy: readLockedByRecord(record["lockedBy"]),
    reason: readRecordString(record["reason"]),
    directions: Array.isArray(directions)
      ? directions.map(readDirectionRecord).filter((entry): entry is DesignDirectionRecord => entry !== null)
      : [],
    chosenDirection: readRecordString(record["chosenDirection"]),
    chosenDirectionBy: readLockedByRecord(record["chosenDirectionBy"]),
    chosenDirectionReason: readRecordString(record["chosenDirectionReason"]),
    expanded: record["expanded"] === true,
    // `Number.isFinite` RATHER THAN `?? 0`: a file carrying `"turnsUsed": null`
    // or a string would otherwise pass `??` untouched and compare as unlimited.
    turnsUsed: typeof record["turnsUsed"] === "number" && Number.isFinite(record["turnsUsed"]) ? record["turnsUsed"] : 0,
    rendersUsed:
      typeof record["rendersUsed"] === "number" && Number.isFinite(record["rendersUsed"]) ? record["rendersUsed"] : 0,
    requests: Array.isArray(requests)
      ? requests.map(readRenderRequest).filter((entry): entry is DesignRenderRequest => entry !== null)
      : [],
    askedAfterSeq: typeof askedAfterSeq === "number" && Number.isFinite(askedAfterSeq) ? askedAfterSeq : null,
  };
}

function readLockedByRecord(value: unknown): DesignLockedBy | null {
  return value === "owner" || value === "ui-designer" || value === "fallback" ? value : null;
}

/**
 * A fresh record, for a caller that has no file to merge onto.
 *
 * EVERY `writeDesignLock` CALLER MUST SPREAD ONTO A RECORD RATHER THAN BUILD A
 * LITERAL, and this is what makes that possible without a null check at each
 * site. `#applyDesignLock` and `#parkForDesignLock` both built fresh literals
 * before 2026-08-03; after the dialogue landed, a fresh literal at either site
 * silently resets `turnsUsed`, `rendersUsed` and `requests` — so the render the
 * owner already paid for becomes free again, and the record of what he asked for
 * disappears on the write that records the choice.
 */
export function emptyDesignLockRecord(parkedAt: string): DesignLockRecord {
  return {
    awaiting: false,
    parkedAt,
    locked: null,
    lockedBy: null,
    reason: null,
    directions: [],
    chosenDirection: null,
    chosenDirectionBy: null,
    chosenDirectionReason: null,
    expanded: false,
    turnsUsed: 0,
    rendersUsed: 0,
    requests: [],
    askedAfterSeq: null,
  };
}
