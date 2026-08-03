/**
 * design-manifest.ts — the DESIGN lane's contract with everything downstream.
 *
 * THE SINGLE DECLARATION SITE. `visual-criteria.ts` carried a deliberately
 * minimal `DesignManifest` with a docblock saying Phase 2b owns the full one and
 * that a second declaration site "is a merge conflict with a wrong answer in it".
 * This is that file; visual-criteria.ts now imports from here.
 *
 * IT IS WRITTEN BY AN AGENT AND READ BY THE HOST, so every field is validated on
 * the way in. `refs[].path` becomes a `Read` target injected verbatim into every
 * build agent's prompt (spec §7.3) and, once locked, the image the visual gate
 * grades against (spec §7.4). An unvalidated absolute path there is a file-read
 * primitive with a prompt attached.
 *
 * TWO SPELLINGS OF ONE FIELD, ON PURPOSE. Spec §17.1 says the file "gains
 * `"locked": "<path>"`" and `visual-criteria.ts` already reads `lockedMockup`.
 * The disk key is `locked`; the parsed field is `lockedMockup`. Renaming either
 * would contradict something that is already written down.
 *
 * FORWARD COMPATIBILITY WITH 2c, WHICH IS A RULE AND NOT A HOPE. Spec §7.6.3
 * adds `animate: boolean` to a ref. Additive OPTIONAL fields do not bump
 * `version`; `version` moves only when the ABSENCE of a field would change the
 * meaning of a file that omits it. `aspect` is required here already because
 * §7.2 puts it in the 2b shape, so 2c's widening is exactly one optional field.
 *
 * THE CONTAINER KEY IS `refs`, AND PHASE 2c'S PLAN CURRENTLY READS `sections`.
 * `docs/superpowers/plans/2026-07-29-phase-2c-image-to-video.md` line 107 sketches
 * the on-disk shape as `{ "sections": [...] }` and its `planVideoLegs` reads
 * `manifestJson.sections`. Against a file this module writes, that yields an
 * empty array, zero legs and a lane 2c reports as "degraded" — a silent zero of
 * exactly the kind THE TRAP exists to forbid. The 2b Produces block, every 2b
 * test and Tasks 5-10 all say `refs`, so `refs` is what ships; 2c must read
 * `refs` (or `refs ?? sections`) before it is implemented. Flagged here because
 * this is the file a 2c author will open.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const DESIGN_REFS_DIR = "design-refs";
export const DESIGN_MANIFEST_FILE = "manifest.json";

/** Exactly `gemini-image.sh`'s `-a` set, read off the script rather than recalled. */
export type DesignAspect = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
export const DESIGN_ASPECTS: readonly DesignAspect[] = Object.freeze([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

/**
 * Who chose the locked mockup.
 *
 * `"fallback"` is NOT in spec §17.3 and is deliberately added: rule 3 names
 * `ui-designer` as the auto-chooser, and rule 4 says the choice is recorded
 * either way — so the case where `ui-designer` produced no usable choice needs a
 * name of its own. Recording it as `"ui-designer"` would be a lie about
 * provenance; recording nothing would make an unattended run unexplainable.
 */
export type DesignLockedBy = "owner" | "ui-designer" | "fallback";

/**
 * How a still came to exist. `"requested"` is written by the HOST when it
 * services an on-demand render, never by an agent — so a missing `origin` can
 * never be a lost `"requested"`.
 */
export type DesignRefOrigin = "canvass" | "requested" | "expansion";

/**
 * A direction slug, which is a FILENAME PREFIX AND A SERVED BASENAME.
 *
 * Validated on parse under the same wholesale-null rule `path` gets, and for the
 * same reason: `<slug>-01-hero.png` is written into `design-refs/` by an agent
 * and its basename is then published as `design-<slug>-01-hero.png` and served by
 * `GET /api/runs/:id/screenshots/:file`. That is a path-safety property, not a
 * taste one — a slug containing `/` or `..` would put an agent-authored string
 * into a path the host builds.
 */
const DIRECTION_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

/**
 * ONE of the distinct directions the canvass offered.
 *
 * THE UNCHOSEN ONES ARE A RECORD AND NOT A RESULT. They stay in this array after
 * a choice is made — `directionDiscarded` derives their status rather than a
 * field storing it — so a later reader can see what was offered. Nothing that
 * grades the build may name one: `designHandoffSection` and `visualGatePrompt`
 * both iterate `refs` and lean on `lockedMockup`, which stage B sets to the
 * CHOSEN direction's hero.
 */
export interface DesignDirection {
  readonly slug: string;
  /** Short human name, e.g. "Editorial slab". */
  readonly name: string;
  /** ONE sentence on what makes this different from the OTHER directions. */
  readonly distinction: string;
  /** `<refsDir>/direction-<slug>.md`, absolute, or null when none was written. */
  readonly notes: string | null;
}

/** Who chose the DIRECTION and why. Same vocabulary as `lockedBy`, §17.3 rule 4. */
export interface DesignDirectionChoice {
  readonly by: DesignLockedBy;
  readonly reason: string;
  readonly at: string;
}

export interface DesignRef {
  /** ABSOLUTE, and inside `<workspace>/design-refs/`. Both are enforced on parse. */
  readonly path: string;
  readonly section: string;
  readonly aspect: DesignAspect;
  readonly intent: string;
  /**
   * The direction this still belongs to. NULL MEANS A REF FROM A RUN THAT HAD NO
   * DIRECTIONS, which is every ref written before 2026-08-03.
   */
  readonly direction: string | null;
  /** Null for those same legacy refs. Absent on disk with directions present parses `"canvass"`. */
  readonly origin: DesignRefOrigin | null;
  /** Phase 2c. Absent means 2b never considered it — never `false` by invention. */
  readonly animate?: boolean;
}

/**
 * What the visual gate reads, and the ONLY thing it reads.
 *
 * `visualCriteriaFor` takes this rather than the whole manifest so that
 * `calibration/grade-fixture.ts`'s `visualCriteriaFor({ lockedMockup: null })`
 * keeps compiling while this file grows.
 */
export interface DesignLock {
  readonly lockedMockup: string | null;
}

export interface DesignManifest extends DesignLock {
  readonly version: 1;
  readonly refs: readonly DesignRef[];
  /**
   * Disk key `directions`. `[]` on every manifest written before 2026-08-03, and
   * `[]` is what makes such a manifest take today's single-direction path
   * everywhere — the orchestrator, the segment chooser and the wire all branch on
   * `directions.length > 0`.
   */
  readonly directions: readonly DesignDirection[];
  /** Disk key `chosenDirection`. Null while stage A is open, or when there are no directions. */
  readonly chosenDirection: string | null;
  /** Disk key `directionChoice`. Null EXACTLY when `chosenDirection` is null. */
  readonly directionChoice: DesignDirectionChoice | null;
  /** UNCHANGED MEANING: the one canonical still. Set at the END of stage B. */
  readonly lockedMockup: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
  readonly lockedAt: string | null;
}

/**
 * DERIVED, never stored, so it cannot disagree with `chosenDirection`.
 *
 * False while stage A is still open: nothing has been discarded until something
 * has been chosen, and rendering two of three as "discarded" before the owner has
 * picked would be the panel answering a question he has not been asked.
 */
export function directionDiscarded(manifest: DesignManifest, slug: string): boolean {
  return manifest.chosenDirection !== null && manifest.chosenDirection !== slug;
}

/**
 * The direction's stills, manifest order, `origin !== "requested"`.
 *
 * ON-DEMAND STILLS ARE EXCLUDED because they are previews the owner asked for
 * mid-park, not part of the set the lane offered or built — including one would
 * let a request for "the contact page in 3" become direction 3's hero, and the
 * gate would then grade the build against an image nobody designed the run
 * around. They are still in `refs` and still published; `origin` is what tells
 * the two apart, AT TWO SITES AND NOT ONE: here, which decides the hero and the
 * panel's per-direction groups, and {@link builtManifest}, which decides what the
 * build agent and the visual gate are shown. Until 2026-08-03 only this one
 * existed, so a preview stayed out of the lock and crossed both prompts anyway.
 *
 * A REF WHOSE `direction` IS NULL MATCHES NOTHING HERE. On a manifest that has
 * directions that is a defect, and it is reported: `classifyDesignLane` fails the
 * lane `manifest-invalid` rather than letting stage B silently produce no hero.
 */
export function refsForDirection(manifest: DesignManifest, slug: string): readonly DesignRef[] {
  return manifest.refs.filter((ref) => ref.direction === slug && ref.origin !== "requested");
}

/**
 * The canonical still of a direction: the FIRST of {@link refsForDirection}.
 *
 * FIRST IN MANIFEST ORDER, exactly as `fallbackChoice` picks, and said plainly:
 * the prompt asks the lane to put the hero first, so this is the hero when the
 * lane did as it was asked and an arbitrary-but-recorded still when it did not.
 * Null when the direction has no stills — a degraded run, where `refs` is empty
 * and no hero lock is applied at all.
 */
export function heroRefFor(manifest: DesignManifest, slug: string): DesignRef | null {
  return refsForDirection(manifest, slug)[0] ?? null;
}

/**
 * THE STILLS THE STAGE THAT JUST RAN OWED — the only count a per-stage floor may
 * be compared against.
 *
 * WHY THIS EXISTS. `classifyDesignLane` grades each design segment against that
 * stage's floor, and until 2026-08-03 it compared that floor against CUMULATIVE
 * inputs: `countDesignPngs` over the flat refs directory and `manifest.refs.length`
 * across every direction. Stage B's floor of 5 was therefore already satisfied by
 * stage A's 6 canvass stills, so `too-few-images` could not fire on an expansion
 * however little it produced — and an expansion that generated nothing left a
 * healthy-looking record while the lock fell back on a 2-section canvass still.
 *
 * THE STAGE IS DERIVED FROM THE MANIFEST rather than passed in, so it cannot
 * disagree with the file the same call is grading. It matches `#buildPhase`'s own
 * arm because of WHEN the choice is written: the canvass is classified BEFORE
 * `#applyDirectionChoice` runs, so `chosenDirection` is null there; the choice is
 * on disk before the expand segment starts, so it is set when the expansion is
 * classified.
 *
 *   no directions        — every ref. One stage, which is every run before
 *                          2026-08-03.
 *   a canvass (no choice) — every non-requested ref, ACROSS the directions: stage
 *                          A's deliverable is directions × sections, so the floor
 *                          this set meets is a TOTAL. It is not the whole of stage
 *                          A and must not be read as it: a total alone passed six
 *                          stills of one direction, so {@link auditCanvass} holds
 *                          the per-direction floor and the comparability, and
 *                          `classifyDesignLane` applies all three.
 *   an expansion         — the CHOSEN direction's set, which is what `expandBrief`
 *                          asks for: "at least MIN_DESIGN_REFS PNGs for the
 *                          direction", its canvass stills included ("Its 2 canvass
 *                          stills are already on disk and already in the
 *                          manifest"). Counting only `origin === "expansion"`
 *                          would grade against a floor of 5 NEW on top of the 2 —
 *                          a number no prompt asks for — and would fail a lane
 *                          that generated all five and did not write the field,
 *                          which `readOrigin` reads as `"canvass"`.
 *
 * A PREVIEW IS NEVER A STAGE'S OUTPUT. `origin: "requested"` is excluded at both
 * arms: three stills the owner asked for while choosing would otherwise let a
 * four-still canvass clear a floor of six.
 */
export function refsForStage(manifest: DesignManifest): readonly DesignRef[] {
  if (manifest.directions.length === 0) return manifest.refs;
  const chosen = manifest.chosenDirection;
  if (chosen === null) return manifest.refs.filter((ref) => ref.origin !== "requested");
  return refsForDirection(manifest, chosen);
}

/**
 * The manifest as ANYTHING THAT BUILDS OR GRADES must see it: only the stills the
 * LANE produced for the direction that was CHOSEN.
 *
 * TWO KINDS OF REF ARE REMOVED, FOR TWO DIFFERENT REASONS, and the second was
 * missing until 2026-08-03.
 *
 *  THE UNCHOSEN DIRECTIONS ARE A RECORD, NOT A RESULT. They stay on disk and in
 *  `directions`, so the panel can show what was offered and a later reader can
 *  see it — but nothing that BUILDS or GRADES may name one.
 *  `designHandoffSection` would otherwise hand a build agent nine stills of three
 *  incompatible designs and tell it to build to them; `visualGatePrompt` would
 *  ask the grader to compare the built page against a design nobody built; and
 *  `planVideoLegs` takes the FIRST marked refs, which on a canvass-then-expand
 *  manifest are the canvass ones — so a discarded direction's still would become
 *  the run's video.
 *
 *  AN ON-DEMAND STILL IS A PREVIEW FOR THE OWNER, NOT A BUILD REFERENCE. He asks
 *  "show me the pricing page in 2" while he is choosing, gets a ref with
 *  `origin: "requested"` and a section the ticket never asked for, and then picks
 *  that direction. Filtering on `direction` alone carried that picture into both
 *  prompts: the build agent was told to build to it, and the gate was told to
 *  read it as a pair against a site that has no pricing section — a gate failure
 *  manufactured out of a picture he asked for out of curiosity. It stays in
 *  `refs`, stays published and stays on his screen; it does not cross these two
 *  seams. EXCLUDED WHETHER OR NOT A CHOICE HAS BEEN MADE, because a preview is a
 *  preview one segment earlier too.
 *
 * IDENTITY WHEN THERE IS NOTHING TO REMOVE, which is every manifest written
 * before 2026-08-03 (`origin` is null there and `chosenDirection` with it) and
 * every stage-A manifest the owner asked nothing of.
 */
export function builtManifest(manifest: DesignManifest): DesignManifest {
  const chosen = manifest.chosenDirection;
  const refs = manifest.refs.filter(
    (ref) => ref.origin !== "requested" && (chosen === null || ref.direction === chosen),
  );
  if (refs.length === manifest.refs.length) return manifest;
  const lockedSurvives = manifest.lockedMockup !== null && refs.some((ref) => ref.path === manifest.lockedMockup);
  return {
    ...manifest,
    refs,
    lockedMockup: lockedSurvives ? manifest.lockedMockup : null,
    lockedBy: lockedSurvives ? manifest.lockedBy : null,
    lockedReason: lockedSurvives ? manifest.lockedReason : null,
    lockedAt: lockedSurvives ? manifest.lockedAt : null,
  };
}

/**
 * WHAT ONE DIRECTION ACTUALLY OFFERED, as the canvass's own claim can be checked
 * against it. One entry per DECLARED direction, including a direction with no
 * stills at all — an empty card is the fault, so it may not be an absent row.
 */
export interface CanvassDirectionAudit {
  readonly slug: string;
  /**
   * DISTINCT sections, normalised, in manifest order. Two stills of one section
   * are ONE section: the count that matters is how many things the owner can
   * compare, not how many files were written.
   */
  readonly sections: readonly string[];
  /** Sections the OTHER directions rendered and this one did not. */
  readonly missing: readonly string[];
  /** Distinct aspects this direction used, in manifest order. */
  readonly aspects: readonly DesignAspect[];
}

/**
 * A SECTION NAME IS AN AGENT'S FREE TEXT, so `"Hero"`, `"hero"` and `" hero "`
 * are one section. Comparing them raw would manufacture an incomparable canvass
 * out of prose casing — a failure the lane could not act on because nothing
 * visible would be wrong.
 */
function canvassSection(section: string): string {
  return section.trim().toLowerCase();
}

/**
 * THE CANVASS AUDITED PER DIRECTION — the half of stage A that `MIN_CANVASS_REFS`
 * cannot see, added 2026-08-03.
 *
 * WHY IT EXISTS. `MIN_CANVASS_REFS` is DESIGN_DIRECTION_COUNT ×
 * DESIGN_CANVASS_SECTIONS and was compared against the canvass's TOTAL, with no
 * per-direction floor anywhere. Six stills of ONE direction therefore cleared
 * stage A: the owner was offered a choice of one direction and two empty cards,
 * and — because {@link refsForStage} grades the CHOSEN direction's whole set —
 * choosing the fat one handed stage B a floor of 5 already met by canvass stills,
 * so an expansion that generated nothing was silent too. The reviewer's scenario
 * was reachable through a lopsided canvass, and this is where it is stopped.
 *
 * AND COMPARABILITY IS THE FEATURE, NOT A PREFERENCE. "Three distinct directions
 * rendering THE SAME SECTIONS at the same aspect" is what makes the canvass a
 * choice rather than three unrelated pictures; until now it was a sentence in a
 * prompt, and a request to a model is not a feature. Both properties are read off
 * fields the manifest already carries — `section` and `aspect` — so this is a
 * check and not a hope.
 *
 * WHAT IT CANNOT SEE, STATED SO NOTHING DOWNSTREAM OVERCLAIMS:
 *   - whether the three directions are VISUALLY distinct. `distinction` is a
 *     sentence the lane wrote about its own work; three renderings of one layout
 *     in three accent colours pass every check here.
 *   - whether the sections chosen are the ones THE TICKET makes important. A
 *     canvass of three comparable footers is comparable.
 *   - ORDER. The brief asks for the same sections in the same order and this
 *     compares SETS, because the panel groups by direction and a reader compares
 *     cards, not positions — a lane that emitted `work, hero` for one direction
 *     has not made the owner's choice harder, and failing a run for it would be a
 *     false alarm bought with nothing.
 *
 * THE LENGTH OF THIS ARRAY IS ITSELF ONE OF THE CHECKS. It is one entry per
 * DECLARED direction, so `classifyDesignLane` reads it to fail a canvass that
 * offered fewer directions than the lane was asked for — declaring one direction
 * and rendering six comparable sections of it satisfies every per-direction
 * property below, because a single direction has nothing to disagree with.
 *
 * EMPTY EXCEPT AT STAGE A, and the gate is the manifest's own, so it cannot
 * disagree with {@link refsForStage}: no directions is a pre-2026-08-03 run, and
 * a chosen direction means the expansion has run and the chosen direction is
 * SUPPOSED to carry sections the discarded ones do not. An empty result therefore
 * means "not a canvass" and never "a canvass with nothing wrong with it" — which
 * is why the count check above is gated on there being at least one entry.
 */
export function auditCanvass(manifest: DesignManifest): readonly CanvassDirectionAudit[] {
  if (manifest.directions.length === 0 || manifest.chosenDirection !== null) return [];
  const rendered = manifest.directions.map((direction) => {
    const refs = refsForDirection(manifest, direction.slug);
    return {
      slug: direction.slug,
      sections: [...new Set(refs.map((ref) => canvassSection(ref.section)))],
      aspects: [...new Set(refs.map((ref) => ref.aspect))],
    };
  });
  const every = [...new Set(rendered.flatMap((entry) => entry.sections))];
  return rendered.map((entry) => ({
    ...entry,
    missing: every.filter((section) => !entry.sections.includes(section)),
  }));
}

/**
 * Refs whose `direction` cannot be resolved against `directions`.
 *
 * TWO SHAPES, ONE REPORT, and neither is wholesale-null. A ref naming a slug that
 * was never declared, and — on a manifest that HAS directions — a ref naming no
 * direction at all. Both break `refsForDirection`, so both break the hero lock,
 * and a hero that never locks looks exactly like a degraded run: the build
 * proceeds, the gate falls back to the rule-based floor, and nothing says why.
 * Dropping the ref instead would hide the fault behind a smaller set.
 *
 * EMPTY ON EVERY MANIFEST WRITTEN BEFORE 2026-08-03, because `directions` is `[]`
 * there and the second shape is gated on it.
 */
export function unresolvedDirectionRefs(manifest: DesignManifest): readonly DesignRef[] {
  if (manifest.directions.length === 0) return [];
  const declared = new Set(manifest.directions.map((direction) => direction.slug));
  return manifest.refs.filter((ref) => ref.direction === null || !declared.has(ref.direction));
}

export function refsDirFor(workspace: string): string {
  return join(workspace, DESIGN_REFS_DIR);
}

export function manifestPathFor(workspace: string): string {
  return join(refsDirFor(workspace), DESIGN_MANIFEST_FILE);
}

export function emptyManifest(): DesignManifest {
  return {
    version: 1,
    refs: [],
    directions: [],
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: null,
    lockedBy: null,
    lockedReason: null,
    lockedAt: null,
  };
}

/** Inside `dir`, or `dir` itself. Not a permission check — a validation one. */
function insideDir(candidate: string, dir: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(dir, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOrigin(value: unknown, hasDirections: boolean): DesignRefOrigin | null {
  if (value === "canvass" || value === "requested" || value === "expansion") return value;
  // ABSENT WITH DIRECTIONS PRESENT IS `"canvass"`, NOT NULL. `"requested"` is
  // written only by the host, so defaulting can never manufacture one — the worst
  // this can get wrong is calling an expansion still a canvass one, which changes
  // nothing downstream (`refsForDirection` excludes only `"requested"`).
  return hasDirections ? "canvass" : null;
}

function readRef(raw: unknown, refsDir: string, hasDirections: boolean): DesignRef | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const path = readString(record["path"]);
  const section = readString(record["section"]);
  const intent = readString(record["intent"]);
  const aspect = record["aspect"];
  if (path === null || section === null || intent === null) return null;
  if (!insideDir(path, refsDir)) return null;
  if (typeof aspect !== "string" || !DESIGN_ASPECTS.includes(aspect as DesignAspect)) return null;
  const animate = record["animate"];
  // NOT VALIDATED AGAINST `directions` HERE, ON PURPOSE. A ref naming a slug
  // nobody declared is kept as written and reported by `unresolvedDirectionRefs`
  // → `classifyDesignLane`; dropping it wholesale would turn a loud, non-blocking
  // fault into a smaller set with no explanation. Only the SHAPE is checked, and
  // an unusable shape reads as "no direction" rather than as a path fragment.
  const direction = readString(record["direction"]);
  return {
    path,
    section,
    aspect: aspect as DesignAspect,
    intent,
    direction: direction !== null && DIRECTION_SLUG.test(direction) ? direction : null,
    origin: readOrigin(record["origin"], hasDirections),
    ...(typeof animate === "boolean" ? { animate } : {}),
  };
}

/**
 * One direction, or null — and null is WHOLESALE, exactly as an invalid `path`
 * is. The slug becomes a filename prefix and a served basename, so a manifest
 * that carries a bad one is not partially honoured.
 */
function readDirection(raw: unknown, refsDir: string): DesignDirection | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const slug = readString(record["slug"]);
  const name = readString(record["name"]);
  const distinction = readString(record["distinction"]);
  if (slug === null || name === null || distinction === null) return null;
  if (!DIRECTION_SLUG.test(slug)) return null;
  const notes = readString(record["notes"]);
  // A NOTES PATH IS A `Read` TARGET IN A PROMPT, the same seam `refs[].path`
  // guards: it is carried into the build segment's handoff, so it is fenced to
  // the refs directory or it is not carried at all.
  return { slug, name, distinction, notes: notes !== null && insideDir(notes, refsDir) ? notes : null };
}

function readLockedBy(value: unknown): DesignLockedBy | null {
  return value === "owner" || value === "ui-designer" || value === "fallback" ? value : null;
}

/**
 * The direction choice, or null.
 *
 * NULL HERE DROPS `chosenDirection` TOO — see `parseDesignManifest`. The pair is
 * written only by `chooseDirection`, so a file carrying a chosen slug and no
 * provenance is a claim an agent made without the authority to make it, and it is
 * dropped for the reason `locked` is dropped: recording it would let stage B
 * expand a direction nobody can be shown to have picked.
 */
function readDirectionChoice(raw: unknown): DesignDirectionChoice | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const by = readLockedBy(record["by"]);
  const reason = readString(record["reason"]);
  const at = readString(record["at"]);
  if (by === null || reason === null || at === null) return null;
  return { by, reason, at };
}

/**
 * Parse and VALIDATE. Null means "there is no usable manifest" — never a partial
 * one, because a partial manifest is what turns a degraded lane into a silent one.
 */
export function parseDesignManifest(text: string, workspace: string): DesignManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 1) return null;
  const rawRefs = record["refs"];
  if (!Array.isArray(rawRefs)) return null;

  const refsDir = refsDirFor(workspace);

  // ABSENT IS `[]`, WHICH IS EVERY MANIFEST WRITTEN BEFORE 2026-08-03 and is the
  // whole of the old-manifest compatibility story: three runs on disk carry no
  // `directions` key, parse to `[]`, and take the single-direction path
  // everywhere downstream. PRESENT-BUT-NOT-AN-ARRAY is wholesale-null, exactly as
  // a malformed `refs` is — a manifest whose shape we cannot read is not a
  // manifest we half-honour.
  const rawDirections = record["directions"];
  if (rawDirections !== undefined && !Array.isArray(rawDirections)) return null;
  const directions: DesignDirection[] = [];
  const slugs = new Set<string>();
  for (const entry of rawDirections ?? []) {
    const direction = readDirection(entry, refsDir);
    // UNIQUE WITHIN A MANIFEST, and a duplicate is wholesale-null rather than
    // last-one-wins: `<slug>-01-hero.png` is one filename, so two directions
    // sharing a slug write over each other's stills and `refsForDirection` then
    // returns one direction's set for both.
    if (direction === null || slugs.has(direction.slug)) return null;
    slugs.add(direction.slug);
    directions.push(direction);
  }

  const refs: DesignRef[] = [];
  for (const entry of rawRefs) {
    const ref = readRef(entry, refsDir, directions.length > 0);
    if (ref === null) return null;
    refs.push(ref);
  }

  // BOTH OR NEITHER. `directionChoice` is null exactly when `chosenDirection` is,
  // which is what lets every consumer test one field and read the other without a
  // second null check.
  const claimedDirection = readString(record["chosenDirection"]);
  const choice = readDirectionChoice(record["directionChoice"]);
  const chosenDirection = claimedDirection !== null && slugs.has(claimedDirection) && choice !== null ? claimedDirection : null;

  // A `locked` path the agent invented points the gate at a file nobody
  // generated. It is dropped rather than honoured, and dropping it is visible:
  // `lockedMockup: null` is exactly the degraded state visual-criteria.ts grades.
  const claimed = readString(record["locked"]);
  const locked = claimed !== null && refs.some((ref) => ref.path === claimed) ? claimed : null;

  return {
    version: 1,
    refs,
    directions,
    chosenDirection,
    directionChoice: chosenDirection === null ? null : choice,
    lockedMockup: locked,
    lockedBy: locked === null ? null : readLockedBy(record["lockedBy"]),
    lockedReason: locked === null ? null : readString(record["lockedReason"]),
    lockedAt: locked === null ? null : readString(record["lockedAt"]),
  };
}

/**
 * EVERY FIELD OF THE INTERFACE, BY HAND, AND THAT IS THE HAZARD.
 *
 * This is an object literal rather than a spread, so a field added to
 * {@link DesignManifest} and not added here compiles, passes every type check,
 * and is ERASED by the next host write. That write is `#applyDesignLock` →
 * `writeDesignManifest` — the one that locks the hero at the END of stage B — so
 * the erasure would land on the last write of the run, after the panel had
 * already shown the directions: types green, tests green, feature gone.
 *
 * The control that condemns it was executed: deleting the `directions` key here
 * turns `parse → serialise → parse` red on the directions, and nothing else in
 * the suite notices.
 */
export function serialiseDesignManifest(manifest: DesignManifest): string {
  return `${JSON.stringify(
    {
      version: manifest.version,
      refs: manifest.refs,
      directions: manifest.directions,
      chosenDirection: manifest.chosenDirection,
      directionChoice: manifest.directionChoice,
      locked: manifest.lockedMockup,
      lockedBy: manifest.lockedBy,
      lockedReason: manifest.lockedReason,
      lockedAt: manifest.lockedAt,
    },
    null,
    2,
  )}\n`;
}

/** The projection the visual gate takes. Nothing else crosses that seam. */
export function toVisualManifest(manifest: DesignManifest): DesignLock {
  return { lockedMockup: manifest.lockedMockup };
}

/* ---- disk ------------------------------------------------------------- */

/**
 * ONE READ PATH FOR THE WHOLE PHASE. Every consumer — the segment chooser, the
 * handoff, the lock, the visual gate — goes through this, so the validation
 * above cannot be bypassed by a caller that reads the file itself.
 */
export function readDesignManifest(workspace: string): DesignManifest | null {
  const path = manifestPathFor(workspace);
  if (!existsSync(path)) return null;
  try {
    return parseDesignManifest(readFileSync(path, "utf8"), workspace);
  } catch {
    return null;
  }
}

/**
 * The manifest with every ref whose file is missing removed.
 *
 * WHAT THE HANDOFF IS BUILT FROM, AND WHY IT IS A SEPARATE FUNCTION. A partial
 * DESIGN lane (`too-few-images`, `manifest-invalid`) does NOT stop the run —
 * degrade-don't-block applies here as everywhere else — so the build segment
 * still gets a handoff. But §7.3 mechanism 2 works by putting absolute paths in
 * a prompt, and a path that resolves to nothing is a `Read` failure inside every
 * build agent, several turns deep, reported as an agent's confusion rather than
 * as a design fault. So the REPORT keeps the discrepancy (`classifyDesignLane`
 * compares the manifest's claim against the disk count) and the PROMPT carries
 * only files that exist.
 *
 * A locked mockup that is itself missing drops the lock: the gate then grades on
 * the rule-based floor, which is the honest answer, rather than against a
 * reference nobody can open.
 */
export function pruneMissingRefs(manifest: DesignManifest): DesignManifest {
  const refs = manifest.refs.filter((ref) => existsSync(ref.path));
  // A NOTES PATH IS A `Read` TARGET TOO, and the argument above is the whole of
  // the argument here: `designHandoffSection` puts `direction-<slug>.md` in front
  // of a build agent, and a file nobody wrote surfaces as that agent's confusion
  // several turns deep rather than as a design fault. The DIRECTION survives with
  // `notes: null` — losing the name and the distinction would lose the record of
  // what was offered, which is the one thing the unchosen directions are for.
  const directions = manifest.directions.map((direction) =>
    direction.notes !== null && !existsSync(direction.notes) ? { ...direction, notes: null } : direction,
  );
  const notesChanged = directions.some((direction, index) => direction !== manifest.directions[index]);
  if (refs.length === manifest.refs.length && !notesChanged) return manifest;
  const lockedSurvives = manifest.lockedMockup !== null && refs.some((r) => r.path === manifest.lockedMockup);
  return {
    ...manifest,
    refs,
    directions,
    lockedMockup: lockedSurvives ? manifest.lockedMockup : null,
    lockedBy: lockedSurvives ? manifest.lockedBy : null,
    lockedReason: lockedSurvives ? manifest.lockedReason : null,
    lockedAt: lockedSurvives ? manifest.lockedAt : null,
  };
}

/** Used only by the HOST, when it applies a lock. The agent writes the refs. */
export function writeDesignManifest(workspace: string, manifest: DesignManifest): void {
  mkdirSync(refsDirFor(workspace), { recursive: true });
  writeFileSync(manifestPathFor(workspace), serialiseDesignManifest(manifest), "utf8");
}

/**
 * The written art direction. Empty string when absent — the handoff renders
 * nothing rather than a heading over a hole.
 */
export function readDesignDirection(workspace: string): string {
  const path = designDirectionPath(workspace);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * `direction.md` — THE CHOSEN DIRECTION'S DOCUMENT, and its meaning is unchanged
 * by the two-stage canvass.
 *
 * `readDesignDirection` and `designHandoffSection`'s `dials.length > 0` test are
 * its two consumers, and both must not go blind: stage B's prompt asks the lane
 * to write it, and the host copies `direction-<slug>.md` over it if the lane did
 * not. Declared as a function so the two spellings of the filename cannot drift.
 */
export function designDirectionPath(workspace: string): string {
  return join(refsDirFor(workspace), "direction.md");
}

/** `<refsDir>/direction-<slug>.md`. The per-direction art direction, chosen or not. */
export function directionNotesPath(workspace: string, slug: string): string {
  return join(refsDirFor(workspace), `direction-${slug}.md`);
}

/**
 * The first bytes of the two formats the image chain demonstrably emits.
 *
 * PNG: the 8-byte signature from the spec. JPEG: SOI + the first marker byte,
 * which is `FF D8 FF` for every JFIF and Exif file (the fourth byte varies —
 * `E0` for JFIF, `E1` for Exif — so it is not part of the test).
 */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Object.freeze([0xff, 0xd8, 0xff]);

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Is this file an image, by its CONTENT?
 *
 * The name is not consulted at all. A zero-byte file has no signature and is
 * therefore not an image, which is the case that matters: `writeFileSync(p, "")`
 * is what a broken generator leaves behind.
 */
export function isDesignImageFile(path: string): boolean {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(8);
    const read = readSync(handle, head, 0, 8, 0);
    const bytes = head.subarray(0, read);
    return startsWith(bytes, PNG_SIGNATURE) || startsWith(bytes, JPEG_SIGNATURE);
  } catch {
    return false;
  } finally {
    closeSync(handle);
  }
}

/**
 * How many stills actually exist.
 *
 * COUNTED FROM DISK, NEVER FROM THE MANIFEST, and that is the whole point: the
 * manifest is a claim an agent wrote, and `classifyDesignLane` compares the two
 * to catch a manifest that lists five refs over three files.
 *
 * COUNTED BY CONTENT, NEVER BY FILENAME, and that half was a measured defect
 * rather than a preference. Until 2026-07-30 this was
 * `readdirSync(...).filter(n => n.endsWith(".png")).length`, and the executed
 * control is what condemns it: a directory of FIVE ZERO-BYTE FILES named
 * `*.png` counted 5, and five real PNGs named `*.jpg` counted 0. Every one of
 * `classifyDesignLane`'s four failure branches is a comparison against this
 * number, so a lane that wrote five empty files classified `failure: null` — the
 * loud branch defeated by a suffix.
 *
 * JPEG COUNTS, AND THAT IS NOT GENEROSITY. Measured on the 2026-07-29 live run
 * (dashboard/results/screenshots/run-2026-07-29T23-28-46-665Z-3d4d1ccb): all
 * five `design-0*.png` stills are `JPEG image data, JFIF standard 1.01,
 * 1376x768`. The generator emits JPEG under a `.png` name, so a PNG-only content
 * test would have flipped a working lane to `no-images` — the suffix was doing
 * all the work in BOTH directions.
 *
 * THE NAME STILL SAYS `Png` and the count no longer does. Renaming the export
 * reaches `orchestrator.ts` (two sites) and three test files, which is outside
 * the grant this change was made under; it is recorded here and in the findings
 * as a follow-up rather than left for a reader to discover.
 */
export function countDesignPngs(refsDir: string): number {
  if (!existsSync(refsDir)) return 0;
  try {
    return readdirSync(refsDir).filter((name) => isDesignImageFile(join(refsDir, name))).length;
  } catch {
    return 0;
  }
}
