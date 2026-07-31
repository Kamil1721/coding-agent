/**
 * project-publish.ts — the finished code, in a folder the owner can find.
 *
 * THE ASK, VERBATIM: "the code will be saved into a folder within this
 * directory". What exists today is
 * `dashboard/runs/run-2026-07-30T20-16-40-242Z-052c6e02/workspace/` — a
 * 44-character generated id, three levels down, inside a server package the
 * owner has no other reason to open. He reported that he cannot find it. This
 * module COPIES that workspace to `projects/<slug-of-the-ticket-title>/` when a
 * run reaches a terminal state, and records where it put it.
 *
 * A COPY. NOT A MOVE, NOT A SYMLINK, AND EACH OF THOSE WAS REJECTED FOR A
 * MEASURED REASON:
 *
 *   MOVE breaks three things at once. `RunRow.artifactPath` names the workspace
 *   and is written the moment the directory exists ("where is it?" is the first
 *   question about a failure); `GET /api/runs/:id/files` serves the tree from
 *   there behind a workspace-only fence; and the sealed gate stages ITS copy out
 *   of the same directory. A moved workspace is a run whose own record points at
 *   nothing and whose re-score is impossible.
 *
 *   SYMLINK fails the ask on its own terms. A link inside a server package is
 *   the same undiscoverable path with a shortcut on top, and anything that
 *   follows it — an editor's search, a `rm -rf`, a `git add` in the published
 *   folder — is operating on the run's evidence.
 *
 *   COPY costs disk. Measured on this machine: 5.6 MB and 12 MB for the two
 *   workspaces that hold anything, and the exclusions below take the largest
 *   directories out of both. That is the price of the artefact staying immutable
 *   and the owner's folder being his to edit and delete.
 *
 * WHAT IS DELIBERATELY NOT COPIED — {@link PROJECT_EXCLUDED_ENTRIES}, matched by
 * NAME AT ANY DEPTH: `.git`, `.bakeoff`, `.claude`, `.design-tmp`, `design-refs`,
 * `ref-crops`, `visible-acceptance`. Six of those seven were named by the owner
 * ("the SITE, not the scaffolding"); `.bakeoff` was added on the citation in
 * `orchestrator.ts`'s own header, which describes the scorer staging "a copy of
 * the artefact with .git and .bakeoff stripped" — this codebase already treats
 * that directory as not-the-artefact, on the same footing as `.git`.
 *
 * WHAT IS *NOT* EXCLUDED, STATED SO NOBODY ASSUMES IT IS. `TICKET.md`, `.tmp/`
 * and `node_modules/` are copied if present. `TICKET.md` is arguably the
 * project's README; `.tmp/` exists in one workspace on this machine and nobody
 * has said what it is; `node_modules/` appears in NO workspace here today
 * (checked with `find`), which is exactly why it is not in the list — an
 * exclusion nothing has ever matched cannot be verified, and adding it would be
 * a guess about a build that has not happened yet. If a run ever installs
 * dependencies, this module will copy the whole tree and somebody must revisit
 * the list rather than discover it as a 400 MB folder.
 *
 * THIS MODULE DOES NOT PRUNE. There is no retention policy, no size cap and
 * nothing that deletes a published folder — one run publishes once, and a
 * hundred runs leave a hundred folders. Deciding when to delete somebody's work
 * is not a decision this program may make silently.
 *
 * IT IS ALSO NOT A DEPLOYMENT. `RunDetail.previewUrl` is a HISTORICAL RECORD of
 * an address served by a process that died with the run (measured: the one
 * finished run recorded `http://127.0.0.1:4321` and nothing has listened there
 * since). Publishing a folder does not serve it, does not open it and does not
 * make it run; it puts the files where the owner can open them himself.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type { ApiProjectExclusion, ApiPublishedProject } from "./api-types.js";

/** One thing that is never copied, and the sentence the owner is given for it. */
export interface ExcludedEntry {
  /** Matched against a directory entry's NAME, at any depth. */
  readonly name: string;
  readonly reason: string;
}

/**
 * THE EXCLUSION LIST. One declaration, reasons included.
 *
 * MATCHED BY NAME AT ANY DEPTH, not only at the workspace root. A `.git`
 * checked out inside a subdirectory is the same scaffolding as one at the top,
 * and a rule that only looked at the root would ship it. The cost is stated
 * rather than hidden: a legitimate project directory that happens to be called
 * `design-refs` anywhere in the tree is dropped, and the drop is reported in
 * {@link PublishedProjectRecord.excluded} rather than being silent.
 *
 * `visible-acceptance` IS NOT A SECURITY CONTROL HERE. It holds the VISIBLE
 * subset of the acceptance suite, which the builder was given on purpose; the
 * held-out half is never in the workspace at all. It is excluded because it is
 * test scaffolding the owner did not ask for, not because publishing it would
 * leak anything. The fence that matters is in `code-files.ts`, and this module
 * reads nothing outside the workspace.
 */
export const PROJECT_EXCLUDED_ENTRIES: readonly ExcludedEntry[] = Object.freeze([
  Object.freeze({ name: ".git", reason: "git metadata, not the project" }),
  Object.freeze({ name: ".bakeoff", reason: "harness state; the scorer strips it too" }),
  Object.freeze({ name: ".claude", reason: "agent configuration, not the project" }),
  Object.freeze({ name: ".design-tmp", reason: "design lane scratch" }),
  Object.freeze({ name: "design-refs", reason: "design reference images, not the site" }),
  Object.freeze({ name: "ref-crops", reason: "design reference crops, not the site" }),
  Object.freeze({ name: "visible-acceptance", reason: "acceptance tests, not the site" }),
]);

/** The record file, under `runs/<id>/results/`. NOT reachable from the browser. */
export const PROJECT_PUBLISH_RECORD = "project-publish.json";

/**
 * Longest slug this module will produce.
 *
 * Ticket titles are prose and are not bounded anywhere upstream. 60 characters
 * is a folder name a person can read in a file picker; the run-id suffix that
 * disambiguates a collision is added AFTER this cut, so the cap cannot merge two
 * titles into one folder — it can only make two folders whose names share a
 * prefix.
 */
export const MAX_SLUG_CHARS = 60;

/** Used when a title reduces to nothing at all (punctuation, emoji, `..`). */
export const PROJECT_SLUG_FALLBACK = "untitled-project";

/**
 * How deep the copy walks before it stops and says so.
 *
 * Symlinks are excluded, so a cycle cannot exist and this is not a loop guard —
 * it is a bound on a pathological tree that would otherwise blow the call stack
 * with an error nobody could read. A directory past the bound is REPORTED as an
 * exclusion, not dropped quietly.
 */
export const MAX_PUBLISH_DEPTH = 24;

/**
 * How many folder names are tried before the publish declines.
 *
 * The sequence is `<slug>`, `<slug>-<short run id>`, `<slug>-<short run id>-2`,
 * … A run out of names is a run whose title collides with fifty existing
 * folders AND whose run-id suffix is already taken, which cannot happen by
 * accident — so the bound exists to make the impossible case a NAMED refusal
 * rather than an infinite loop.
 */
export const MAX_NAME_ATTEMPTS = 50;

/**
 * Why nothing was published. A CLOSED union here; `string` on the wire.
 *
 * `workspace-missing`  there is no workspace directory to copy.
 * `workspace-empty`    the directory exists and holds no publishable file — a
 *                      run cancelled out of the queue, or one whose entire
 *                      content was scaffolding.
 * `no-free-name`       {@link MAX_NAME_ATTEMPTS} candidate folder names were all
 *                      taken. Nothing was overwritten.
 * `copy-failed`        the filesystem refused mid-way. `detail` is what it said.
 */
export type PublishDecline = "workspace-missing" | "workspace-empty" | "no-free-name" | "copy-failed";

/** The record written when a copy was made. */
export interface PublishedProjectRecord {
  readonly published: true;
  readonly runId: string;
  /** Absolute host path of the copy. */
  readonly path: string;
  /** The workspace it was copied FROM, which still exists and is unchanged. */
  readonly source: string;
  readonly publishedAt: string;
  /** Regular files copied. Directories are not counted. */
  readonly fileCount: number;
  readonly bytes: number;
  readonly excluded: readonly ApiProjectExclusion[];
}

/** The record written when the publish was attempted and declined. */
export interface DeclinedProjectRecord {
  readonly published: false;
  readonly runId: string;
  readonly source: string;
  readonly reason: PublishDecline;
  readonly detail: string;
  readonly attemptedAt: string;
}

/**
 * WRITTEN WHETHER IT PUBLISHED OR NOT, for `AdversaryRecord`'s reason: a missing
 * file cannot be told apart from a step that never ran. The absence of this file
 * means the run never reached `#finish`; a file saying `published: false` means
 * it reached it and declined, and says why.
 */
export type ProjectPublishRecord = PublishedProjectRecord | DeclinedProjectRecord;

export interface PublishRequest {
  readonly runId: string;
  /** The ticket's title. Owner-supplied prose; {@link projectSlug} sanitises it. */
  readonly ticketTitle: string;
  /** `runs/<id>/workspace` — read only. Nothing here writes to it. */
  readonly workspace: string;
  /** `DashboardPaths.projects`. Created on first use. */
  readonly projectsDir: string;
  /** `runs/<id>/results` — where {@link PROJECT_PUBLISH_RECORD} is written. */
  readonly resultsDir: string;
}

/**
 * A filesystem-safe, human-readable folder name for a ticket title.
 *
 * NOT `safeSegment` FROM paths.ts, AND THE DIFFERENCE IS THE TRUST CLASS. That
 * function exists for run ids, which this process generates, and its regex
 * (`[^A-Za-z0-9._-]`) keeps dots — so `safeSegment("..")` returns `".."`, a
 * traversal, and `safeSegment("...")` returns a folder no picker will show. A
 * ticket title is owner-supplied text that arrives over HTTP. This reduction
 * keeps `[a-z0-9]` and nothing else, which cannot produce `.`, `..`, a
 * separator, a leading dash or an empty name.
 *
 * The caller still checks containment before creating anything — a sanitiser
 * that is the only defence is one edit away from not being a defence.
 */
export function projectSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    // The slice can leave a trailing dash when it lands on one.
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : PROJECT_SLUG_FALLBACK;
}

/**
 * The disambiguating suffix: the last dash-separated piece of the run id.
 *
 * Run ids are `run-2026-07-30T20-16-40-242Z-052c6e02`, so this is the 8-character
 * random tail — short enough to read, and the only part of the id that is not
 * shared with every other run started in the same second. It is sanitised the
 * same way the slug is, because a run id that ever changed shape must not be
 * able to put a separator in a folder name.
 */
export function runIdSuffix(runId: string): string {
  const pieces = runId.split("-").filter((piece) => piece.length > 0);
  const last = pieces.length > 0 ? pieces[pieces.length - 1] : undefined;
  const cleaned = (last ?? runId).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 12) : "run";
}

/**
 * PUBLISH THE RUN'S CODE. Returns the record it wrote; never throws for a
 * failure it can name.
 *
 * WHAT IT WILL NOT DO, IN ORDER OF HOW BADLY IT WOULD HURT:
 *
 *   IT NEVER OVERWRITES A DIRECTORY IT DID NOT CREATE. Two runs from the same
 *   ticket title are the ordinary case — a re-run after a failure is exactly
 *   that — and the first one's folder is somebody's work. The name is claimed
 *   with a NON-RECURSIVE `mkdirSync`, which fails with `EEXIST` if anything is
 *   already there; that is atomic, unlike `existsSync` followed by a create, and
 *   the atomicity is why it is written that way even though this server runs one
 *   run at a time.
 *
 *   IT NEVER TOUCHES THE WORKSPACE. Read only, no `rm`, no `rename`.
 *
 *   IT NEVER LEAVES AN EMPTY FOLDER BEHIND. A workspace with nothing
 *   publishable in it declines with `workspace-empty` and removes the directory
 *   it had just claimed — but only when it created that directory in this call.
 *
 * RE-PUBLISHING THE SAME RUN REUSES THE SAME FOLDER. If this run's own record
 * names a directory that still exists, the copy goes back into it rather than
 * minting `<slug>-<id>-2` for the same work. Overwriting your own earlier copy
 * of the same run is not overwriting somebody else's; overwriting a folder whose
 * record does not name this run id is, and that is the case the `EEXIST` claim
 * refuses. Files the owner ADDED to his copy are left alone — this writes over
 * the names it copies and deletes nothing.
 */
export function publishProject(request: PublishRequest): ProjectPublishRecord {
  const attemptedAt = new Date().toISOString();
  const decline = (reason: PublishDecline, detail: string): DeclinedProjectRecord => {
    const record: DeclinedProjectRecord = {
      published: false,
      runId: request.runId,
      source: request.workspace,
      reason,
      detail: redactForPersistence(detail),
      attemptedAt,
    };
    writeRecord(request.resultsDir, record);
    return record;
  };

  if (!existsSync(request.workspace)) {
    return decline(
      "workspace-missing",
      `there is no workspace at ${request.workspace}, so this run produced no code to publish`,
    );
  }

  let createdHere = false;
  let destination = "";
  try {
    if (!statSync(request.workspace).isDirectory()) {
      return decline("workspace-missing", `${request.workspace} is not a directory`);
    }
    const reuse = ownPreviousPath(request.resultsDir, request.runId);
    if (reuse !== null) {
      destination = reuse;
    } else {
      const claimed = claimDestination(request.projectsDir, projectSlug(request.ticketTitle), runIdSuffix(request.runId));
      if (claimed === null) {
        return decline(
          "no-free-name",
          `every one of the ${String(MAX_NAME_ATTEMPTS + 1)} candidate folder names under ${request.projectsDir} is ` +
            "already taken. Nothing was overwritten and nothing was published; rename or move the existing folders.",
        );
      }
      destination = claimed;
      createdHere = true;
    }

    const tally: CopyTally = { files: 0, bytes: 0, excluded: [] };
    copyTree(request.workspace, destination, "", 0, tally);

    if (tally.files === 0) {
      // The directory we claimed a moment ago holds nothing — remove it, so a
      // cancelled-out-of-the-queue run does not leave an empty folder named
      // after a ticket that produced no code. Only when WE created it: a reused
      // path is the owner's copy of an earlier publish and is not ours to delete.
      if (createdHere) {
        rmSync(destination, { recursive: true, force: true });
        // …and `projects/` itself if claiming the name is what created it. A
        // NON-recursive rmdir, so it fails with ENOTEMPTY the moment any other
        // run has published — the owner's other projects are never in reach of
        // this line, which is the whole reason it is not an `rmSync`.
        try {
          rmdirSync(request.projectsDir);
        } catch {
          // Other projects live here, or somebody else owns the directory.
        }
      }
      return decline(
        "workspace-empty",
        `the workspace at ${request.workspace} holds no publishable file — ` +
          `${String(tally.excluded.length)} entr${tally.excluded.length === 1 ? "y was" : "ies were"} excluded and ` +
          "nothing else was there. A run cancelled before the builder wrote anything looks exactly like this.",
      );
    }

    const record: PublishedProjectRecord = {
      published: true,
      runId: request.runId,
      path: destination,
      source: request.workspace,
      publishedAt: new Date().toISOString(),
      fileCount: tally.files,
      bytes: tally.bytes,
      excluded: tally.excluded,
    };
    writeRecord(request.resultsDir, record);
    return record;
  } catch (error) {
    // A HALF-COPY IS LEFT ON DISK ON PURPOSE. Deleting it would destroy the only
    // evidence of what went wrong, and the record below says `copy-failed`, so
    // nothing reports the folder as complete. The workspace is untouched either
    // way, which is the invariant that matters.
    return decline(
      "copy-failed",
      `copying ${request.workspace} to ${destination === "" ? request.projectsDir : destination} failed: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/* -------------------------------------------------------------------------
 * The copy
 * ---------------------------------------------------------------------- */

interface CopyTally {
  files: number;
  bytes: number;
  excluded: ApiProjectExclusion[];
}

/**
 * Copy `srcDir` into `destDir`, recording what it refused.
 *
 * DESTINATION DIRECTORIES ARE CREATED LAZILY — only when a file is about to be
 * written into them. An empty directory in the workspace is therefore NOT
 * reproduced, and neither is one whose whole contents were excluded (`.git`'s
 * parent is fine; a directory holding only `design-refs` disappears). WHAT THAT
 * DOES NOT COVER: a project that depends on an empty directory existing — a
 * placeholder `uploads/` — loses it, and nothing here can tell that case from
 * leftover scratch.
 *
 * SYMLINKS ARE NOT FOLLOWED AND NOT RECREATED. Following one copies whatever it
 * points at, which may be outside the workspace entirely; recreating it leaves a
 * link into `dashboard/runs/…` inside the folder that exists precisely so the
 * owner never has to go there. Both are worse than an entry in `excluded`.
 */
function copyTree(srcDir: string, destDir: string, relPrefix: string, depth: number, tally: CopyTally): void {
  if (depth > MAX_PUBLISH_DEPTH) {
    tally.excluded.push({
      path: relPrefix,
      reason: `deeper than ${String(MAX_PUBLISH_DEPTH)} directories`,
    });
    return;
  }
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const childRel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    const excluded = PROJECT_EXCLUDED_ENTRIES.find((rule) => rule.name === entry.name);
    if (excluded !== undefined) {
      tally.excluded.push({ path: childRel, reason: excluded.reason });
      continue;
    }
    const childSrc = join(srcDir, entry.name);
    const childDest = join(destDir, entry.name);
    if (entry.isSymbolicLink()) {
      tally.excluded.push({
        path: childRel,
        reason: "symbolic link — following it would copy whatever it points at, which may be outside the workspace",
      });
      continue;
    }
    if (entry.isDirectory()) {
      copyTree(childSrc, childDest, childRel, depth + 1, tally);
      continue;
    }
    if (!entry.isFile()) {
      tally.excluded.push({ path: childRel, reason: "not a regular file (socket, fifo or device)" });
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(childSrc, childDest);
    tally.files += 1;
    tally.bytes += statSync(childDest).size;
  }
}

/**
 * Claim a folder name under `projectsDir`, or `null` when every candidate is
 * taken.
 *
 * The claim is a NON-RECURSIVE `mkdirSync`: it succeeds only if it created the
 * directory, so a name that already belongs to another run's project can never
 * be written into. `recursive: true` would silently succeed on an existing
 * directory, which is exactly the overwrite this refuses.
 */
function claimDestination(projectsDir: string, slug: string, suffix: string): string | null {
  mkdirSync(projectsDir, { recursive: true });
  for (const name of candidateNames(slug, suffix)) {
    const candidate = join(projectsDir, name);
    // BELT AND BRACES over `projectSlug`. The slug cannot contain a separator or
    // a dot today; this is the check that would still hold if it could.
    if (!isDirectChild(projectsDir, candidate)) continue;
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  return null;
}

function* candidateNames(slug: string, suffix: string): Generator<string> {
  yield slug;
  yield `${slug}-${suffix}`;
  for (let n = 2; n <= MAX_NAME_ATTEMPTS; n += 1) yield `${slug}-${suffix}-${String(n)}`;
}

/** True when `child` is an immediate child of `parent` — no `..`, no separator. */
function isDirectChild(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
}

/* -------------------------------------------------------------------------
 * The record
 * ---------------------------------------------------------------------- */

/**
 * NOT RUN THROUGH `redactForPersistence` AS A WHOLE, and that is a decision.
 *
 * Every string in a `published` record is a path this server constructed or a
 * slug reduced to `[a-z0-9-]`, and the one redaction rule that could match a
 * long path segment (`HIGH_ENTROPY_TOKEN`, 40+ mixed-case characters) would
 * replace the very path the owner is being told to open — the same failure mode
 * `GraphSdkRef` documents, where redaction merges two ids into one string. The
 * `detail` of a DECLINE is the only field carrying text this module did not
 * build, so `decline()` redacts that one at its source.
 */
function writeRecord(resultsDir: string, record: ProjectPublishRecord): void {
  try {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, PROJECT_PUBLISH_RECORD), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    // SWALLOWED, AND HERE IS WHAT IS LOST. The copy itself has already happened
    // or already been declined; what fails is the record of it, so
    // `RunDetail.publishedProject` stays `null` — "nothing recorded" — while the
    // folder exists. The orchestrator's log line still names the path, and that
    // line is what the owner reads. Throwing here would turn an unwritable
    // results directory into a failed publish for a copy that succeeded.
  }
}

/** This run's own previous publish, when it still exists on disk. */
function ownPreviousPath(resultsDir: string, runId: string): string | null {
  const path = join(resultsDir, PROJECT_PUBLISH_RECORD);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(parsed)) return null;
    if (parsed["published"] !== true) return null;
    const previous = parsed["path"];
    // The run id guard is the point: a record naming a DIFFERENT run must never
    // hand this run a directory to write into.
    if (parsed["runId"] !== runId || typeof previous !== "string" || previous.length === 0) return null;
    return existsSync(previous) ? previous : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The read path — `http.ts#toDetail`
 * ---------------------------------------------------------------------- */

/**
 * Map the record's TEXT onto the wire shape, or `null` when it is not a record
 * this server recognises.
 *
 * FS-FREE, like `adversaryPassFromRecord`, so every part of it that can be wrong
 * is a pure function a test can drive. It VALIDATES rather than casts: the file
 * is written by an older or newer build of this same program, and a cast would
 * put `undefined` on a field the client's type says is a string.
 *
 * A record that parses but does not match either arm returns `null`, which the
 * wire contract defines as "nothing recorded". That conflates a corrupt record
 * with an absent one — stated because it is a real loss — and the untruncated
 * file is still on disk under `runs/<id>/results/` for whoever is debugging it.
 */
export function publishedProjectFromRecord(text: string): ApiPublishedProject | null {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) return null;
  if (parsed["published"] === true) {
    const path = parsed["path"];
    const publishedAt = parsed["publishedAt"];
    const fileCount = parsed["fileCount"];
    const bytes = parsed["bytes"];
    if (typeof path !== "string" || path.length === 0) return null;
    if (typeof publishedAt !== "string" || typeof fileCount !== "number" || typeof bytes !== "number") return null;
    return {
      published: true,
      path,
      publishedAt,
      fileCount,
      bytes,
      excluded: exclusionsFrom(parsed["excluded"]),
    };
  }
  if (parsed["published"] === false) {
    const reason = parsed["reason"];
    const detail = parsed["detail"];
    const attemptedAt = parsed["attemptedAt"];
    if (typeof reason !== "string" || typeof detail !== "string" || typeof attemptedAt !== "string") return null;
    return { published: false, reason, detail, attemptedAt };
  }
  return null;
}

/**
 * Read the record for one run. Every failure — absent, unreadable, corrupt — is
 * `null`, which the wire contract defines as "no publish recorded".
 *
 * It lives here rather than in `http.ts` so that the route's line is one call:
 * the FS shape `readDesignLock` and `readAdversaryPass` have is the same, but
 * those were written before there was a module to put it in.
 */
export function readPublishedProject(resultsDir: string): ApiPublishedProject | null {
  const path = join(resultsDir, PROJECT_PUBLISH_RECORD);
  if (!existsSync(path)) return null;
  try {
    return publishedProjectFromRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function exclusionsFrom(value: unknown): readonly ApiProjectExclusion[] {
  if (!Array.isArray(value)) return [];
  const out: ApiProjectExclusion[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isObject(item)) continue;
    const path = item["path"];
    const reason = item["reason"];
    if (typeof path !== "string" || typeof reason !== "string") continue;
    out.push({ path, reason });
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
