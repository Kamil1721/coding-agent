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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface DesignRef {
  /** ABSOLUTE, and inside `<workspace>/design-refs/`. Both are enforced on parse. */
  readonly path: string;
  readonly section: string;
  readonly aspect: DesignAspect;
  readonly intent: string;
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
  readonly lockedMockup: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
  readonly lockedAt: string | null;
}

export function refsDirFor(workspace: string): string {
  return join(workspace, DESIGN_REFS_DIR);
}

export function manifestPathFor(workspace: string): string {
  return join(refsDirFor(workspace), DESIGN_MANIFEST_FILE);
}

export function emptyManifest(): DesignManifest {
  return { version: 1, refs: [], lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null };
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

function readRef(raw: unknown, refsDir: string): DesignRef | null {
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
  return {
    path,
    section,
    aspect: aspect as DesignAspect,
    intent,
    ...(typeof animate === "boolean" ? { animate } : {}),
  };
}

function readLockedBy(value: unknown): DesignLockedBy | null {
  return value === "owner" || value === "ui-designer" || value === "fallback" ? value : null;
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
  const refs: DesignRef[] = [];
  for (const entry of rawRefs) {
    const ref = readRef(entry, refsDir);
    if (ref === null) return null;
    refs.push(ref);
  }

  // A `locked` path the agent invented points the gate at a file nobody
  // generated. It is dropped rather than honoured, and dropping it is visible:
  // `lockedMockup: null` is exactly the degraded state visual-criteria.ts grades.
  const claimed = readString(record["locked"]);
  const locked = claimed !== null && refs.some((ref) => ref.path === claimed) ? claimed : null;

  return {
    version: 1,
    refs,
    lockedMockup: locked,
    lockedBy: locked === null ? null : readLockedBy(record["lockedBy"]),
    lockedReason: locked === null ? null : readString(record["lockedReason"]),
    lockedAt: locked === null ? null : readString(record["lockedAt"]),
  };
}

export function serialiseDesignManifest(manifest: DesignManifest): string {
  return `${JSON.stringify(
    {
      version: manifest.version,
      refs: manifest.refs,
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
  if (refs.length === manifest.refs.length) return manifest;
  const lockedSurvives = manifest.lockedMockup !== null && refs.some((r) => r.path === manifest.lockedMockup);
  return {
    ...manifest,
    refs,
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
  const path = join(refsDirFor(workspace), "direction.md");
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * How many stills actually exist.
 *
 * COUNTED FROM DISK, NEVER FROM THE MANIFEST, and that is the whole point: the
 * manifest is a claim an agent wrote, and `classifyDesignLane` compares the two
 * to catch a manifest that lists five refs over three files.
 */
export function countDesignPngs(refsDir: string): number {
  if (!existsSync(refsDir)) return 0;
  try {
    return readdirSync(refsDir).filter((name) => name.toLowerCase().endsWith(".png")).length;
  } catch {
    return 0;
  }
}
