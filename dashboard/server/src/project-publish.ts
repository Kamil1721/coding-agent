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
 * `.env` IS COPIED, AND IS NEVER COMMITTED. The two questions are separate and
 * they get different answers. On disk it is the only place the values the build
 * agent used exist, the README's "Run it" section is useless without them, and
 * `projects/` is itself gitignored inside the owner's repository — a copied
 * `.env` is a file on his own machine, which is where a `.env` belongs. In the
 * HISTORY it is a key that survives every later `.gitignore` edit and travels
 * with the first `git push`, and the README this publish writes tells him the
 * folder is his to push. So `project-handover.ts` keeps the whole `.env` family
 * (except `.env.example` and friends) out of the commit through the repository's
 * own exclude file, and the copy brings it across. Excluding it from the COPY
 * instead would hand the owner a project that cannot start and no statement of
 * what is missing beyond a table of variable NAMES.
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
 *
 * WHAT THE COPY ALONE DID NOT ANSWER, AND WHAT `project-handover.ts` ADDS. The
 * owner's next sentence about that folder was "what if I wanted to work in the
 * project after it was done? I don't have a file or a database to work from" —
 * a folder of files with no history, no README, no `.gitignore` and a binary
 * `.db` nobody can read. After the copy succeeds this module calls
 * {@link handoverProject}, which gives the published directory ITS OWN git
 * repository with one commit, a README (only when the builder shipped none),
 * a `.gitignore` (only when the builder shipped none) and `db/schema.sql` for
 * every SQLite file that came across. THE RUN'S OWN REPOSITORY IS NEVER
 * TOUCHED: `.git` is excluded from the copy, and the workspace's single
 * `workspace created` commit is the baseline `orchestrator.ts:3974` diffs
 * against to build the judge's reading material — a commit in there would empty
 * that diff.
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
import { isTerminal } from "./db.js";
import { handoverProject, inspectRepository, preserveUncommittedWork, spawnGit } from "./project-handover.js";
import type { GitRunner, HandoverRecord, PublishRunFacts } from "./project-handover.js";
import { runPathsFor } from "./paths.js";
import type { DashboardPaths } from "./paths.js";

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
 * `run-not-terminal`   {@link republishProject} only. A run that is still going
 *                      has a workspace being written underneath the copy.
 */
export type PublishDecline =
  | "workspace-missing"
  | "workspace-empty"
  | "no-free-name"
  | "copy-failed"
  | "run-not-terminal";

/**
 * Why a re-publish did NOT go back into this run's own earlier folder.
 *
 * `owner-commits`      the folder is a git repository whose HEAD is not the
 *                      commit this run last made there. Somebody has committed
 *                      since — the owner, or a tool of his. Publishing over it
 *                      would put a machine commit on top of his work.
 * `foreign-repository` there is a `.git` there that is not this directory's own
 *                      repository, or git could not answer at all.
 * `preserve-failed`    the folder had uncommitted changes and the commit that
 *                      would have saved them failed. Overwriting after that
 *                      would destroy the one state git cannot recover.
 */
export type ReuseRefusal = "owner-commits" | "foreign-repository" | "preserve-failed";

/** Recorded when a re-publish went to a NEW folder rather than the old one. */
export interface PublishRedirect {
  /** The folder this run published to last time and did not write into now. */
  readonly from: string;
  readonly reason: ReuseRefusal;
  readonly detail: string;
}

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
  /**
   * What was done to make the copy workable — the repository, the README, the
   * `.gitignore`, the schema dumps. SERVER-SIDE ONLY today: `ApiPublishedProject`
   * has no mirror for it yet, and `publishedProjectFromRecord` neither reads nor
   * forwards it, so a client sees the same six fields it always has.
   */
  readonly handover: HandoverRecord;
  /** Non-null only when this run's own earlier folder was left alone. */
  readonly redirected: PublishRedirect | null;
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
  /**
   * The run row, for the README's provenance block and the commit message.
   *
   * OPTIONAL BECAUSE THE CALL SITE IS IN ANOTHER AGENT'S FILE. `RunRow`
   * satisfies {@link PublishRunFacts} structurally and `orchestrator.ts
   * #publishProject` already holds the row, so wiring it is one added line
   * (`run: row,`). Until that line exists the README says "not recorded" for the
   * run id, ticket id, verdict and model rather than inventing them.
   */
  readonly run?: PublishRunFacts | undefined;
  /** TESTS ONLY. The seam that makes "git failed" reachable without breaking git. */
  readonly git?: GitRunner | undefined;
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
 *
 * …AND THAT REUSE IS NOW CONDITIONAL, BECAUSE THE FOLDER IS A REPOSITORY. The
 * rule, decided here and enforced by {@link checkReuse}:
 *
 *   THE FOLDER IS STILL OURS ONLY WHILE ITS HEAD IS THE COMMIT WE LEFT THERE.
 *   The published record carries the sha of the commit this run made; on a
 *   re-publish that sha is compared with the folder's actual HEAD. Equal means
 *   nobody has committed since and the copy may write over files it wrote in the
 *   first place. Different — including a repository that exists where our record
 *   remembers none — means the owner has been working here, and a machine commit
 *   on top of his history is exactly what item 6 forbids. That case publishes to
 *   `<slug>-<run id>` instead and records {@link PublishRedirect}, so nothing is
 *   lost and nothing is silent.
 *
 *   WHY HEAD AND NOT "IS THE TREE CLEAN". A database the builder's own
 *   `.gitignore` does not mention is untracked forever, so a cleanliness test
 *   would report owner work on every single re-publish and mint a new folder each
 *   time — idempotence gone, for a file we deliberately do not commit. Dirtiness
 *   is measured under the commit's own exclusions and handled separately: TRACKED
 *   edits that were never committed are saved as their own commit BEFORE the copy
 *   overwrites them ({@link preserveUncommittedWork}), because an uncommitted edit
 *   is the one state git cannot get back.
 *
 *   A FOLDER WITH NO `.git` IS STILL OURS. The one project published on this
 *   machine predates the handover and has no repository; re-publishing it is how
 *   it gets one.
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
  let redirected: PublishRedirect | null = null;
  let preservedCommit: string | null = null;
  try {
    if (!statSync(request.workspace).isDirectory()) {
      return decline("workspace-missing", `${request.workspace} is not a directory`);
    }
    const previous = ownPreviousPublish(request.resultsDir, request.runId);
    if (previous !== null) {
      const reuse = checkReuse(previous, request.git ?? spawnGit);
      if (reuse.ok) {
        destination = previous.path;
        preservedCommit = reuse.preserved;
      } else {
        redirected = { from: previous.path, reason: reuse.reason, detail: reuse.detail };
      }
    }
    if (destination === "") {
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

    const publishedAt = new Date().toISOString();
    const record: PublishedProjectRecord = {
      published: true,
      runId: request.runId,
      path: destination,
      source: request.workspace,
      publishedAt,
      fileCount: tally.files,
      bytes: tally.bytes,
      excluded: tally.excluded,
      // AFTER THE COPY AND INSIDE THE SAME `try`, but it cannot reach the
      // `catch`: `handoverProject` names its own failures and returns them.
      // The wrapper below is for the failure it cannot name — a bug in it — and
      // exists so that a folder that was copied correctly is still reported as
      // published when the thing that makes it workable falls over.
      handover: runHandover({
        directory: destination,
        run: request.run ?? null,
        workspace: request.workspace,
        publishedAt,
        preservedCommit,
        git: request.git,
      }),
      redirected,
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

/** This run's own previous publish, when its folder still exists on disk. */
interface PreviousPublish {
  readonly path: string;
  /**
   * The commit this run left at that folder's HEAD, or null when it never made
   * one — a record written before the handover existed, or a publish whose git
   * step declined. Null is not "no repository": it is "we know of no commit",
   * and {@link checkReuse} treats a repository that has one anyway as the
   * owner's.
   */
  readonly commit: string | null;
}

function ownPreviousPublish(resultsDir: string, runId: string): PreviousPublish | null {
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
    if (!existsSync(previous)) return null;
    return { path: previous, commit: recordedCommit(parsed) };
  } catch {
    return null;
  }
}

/**
 * The commit sha out of a record's handover block, VALIDATED not cast.
 *
 * The file was written by an older build of this same program — one that had no
 * handover block at all — so every level of this access can be absent, and an
 * `undefined` reaching the HEAD comparison would silently read as "the owner has
 * committed" and send every re-publish to a new folder.
 *
 * WHAT `null` COSTS, STATED BECAUSE IT IS A REAL SEQUENCE. Publish once with git
 * broken (no repository, no sha recorded), then make the folder a repository by
 * hand, then re-publish: the HEAD comparison sees a commit where the record
 * remembers none and redirects to `<slug>-<run id>`, permanently forking the
 * name. That is the safe side of a question this program cannot answer — a
 * commit it has no record of making is indistinguishable from one the owner
 * made — and the alternative, writing over a repository on the strength of a
 * path alone, is the mistake that costs work rather than a folder name.
 */
function recordedCommit(record: Record<string, unknown>): string | null {
  const handover = record["handover"];
  if (!isObject(handover)) return null;
  const repository = handover["repository"];
  if (!isObject(repository)) return null;
  const commit = repository["commit"];
  return typeof commit === "string" && commit.length > 0 ? commit : null;
}

type ReuseCheck =
  | { readonly ok: true; readonly preserved: string | null }
  | { readonly ok: false; readonly reason: ReuseRefusal; readonly detail: string };

/**
 * May this run write into the folder it published to last time?
 *
 * THE RULE IS DEFENDED IN `publishProject`'s DOCBLOCK. This is the mechanism:
 * HEAD is the discriminator, uncommitted TRACKED edits are saved first, and
 * every refusal names the folder that was left alone.
 */
function checkReuse(previous: PreviousPublish, git: GitRunner): ReuseCheck {
  const state = inspectRepository(previous.path, git);
  if (state.kind === "absent") return { ok: true, preserved: null };
  if (state.kind === "foreign") {
    return {
      ok: false,
      reason: "foreign-repository",
      detail:
        `${previous.path} holds a git repository this program cannot verify as its own (${state.detail}), so it was ` +
        "left untouched and this run published elsewhere.",
    };
  }
  if (state.head !== previous.commit) {
    return {
      ok: false,
      reason: "owner-commits",
      detail:
        `${previous.path} is at commit ${state.head ?? "(none)"} and the last commit this run made there was ` +
        `${previous.commit ?? "(none recorded)"}. Somebody has committed since, so that folder is now the owner's ` +
        "work: it was left exactly as it is and this run published to a new folder beside it.",
    };
  }
  if (!state.dirty) return { ok: true, preserved: null };
  const saved = preserveUncommittedWork(previous.path, git);
  if (saved.commit === null) {
    return {
      ok: false,
      reason: "preserve-failed",
      detail:
        `${previous.path} has changes that were never committed and committing them first failed (${saved.detail}). ` +
        "Copying over them would have destroyed the one state git cannot recover, so the folder was left alone.",
    };
  }
  return { ok: true, preserved: saved.commit };
}

/**
 * The handover, wrapped so that a bug in it cannot un-publish a good copy.
 *
 * `handoverProject` returns named failures rather than throwing, which is its
 * contract; this is the belt for the day that contract is broken by an edit. The
 * files are already on disk when it runs — reporting `published: false` because
 * a README could not be rendered would be a lie about the folder the owner is
 * about to open.
 */
function runHandover(request: Parameters<typeof handoverProject>[0]): HandoverRecord {
  try {
    return handoverProject(request);
  } catch (error) {
    return {
      readme: { state: "declined", detail: "the handover step threw" },
      gitignore: { state: "declined", detail: "the handover step threw" },
      databases: [],
      envVars: [],
      repository: {
        state: "declined",
        reason: "handover-crashed",
        detail: redactForPersistence(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

/* -------------------------------------------------------------------------
 * Re-publishing a run that has already finished
 * ---------------------------------------------------------------------- */

/**
 * The seam a route hangs off. `RunRow` satisfies {@link PublishRunFacts}, so the
 * handler is `republishProject({ run, paths })` and nothing else.
 */
export interface RepublishRequest {
  readonly run: PublishRunFacts;
  readonly paths: DashboardPaths;
  /** TESTS ONLY. See {@link PublishRequest.git}. */
  readonly git?: GitRunner | undefined;
}

/**
 * PUBLISH A RUN THAT HAS ALREADY FINISHED. Same rules, same declines, safe to
 * call twice.
 *
 * WITHOUT THIS, THE WHOLE HANDOVER ONLY HELPS THE NEXT RUN. `publishProject` is
 * called from `#finish`, and every run on this machine is already terminal — so
 * nothing above would ever reach the one project the owner actually has. This is
 * the same function with the paths worked out from the run id, exported for a
 * route to call.
 *
 * IT REFUSES A RUN THAT IS STILL GOING, and that refusal is not bureaucracy: a
 * live run's workspace is being written underneath the copy, so the folder would
 * be a torn half-state named after a ticket that has not finished. `queued`,
 * `running`, `awaiting_input` and `rate_limited` are all still going — the last
 * one especially, since it is resumable and its half-built site would be
 * published as if it were the answer.
 *
 * IT CANNOT FAIL ANYTHING EITHER. Same contract as `publishProject`: every
 * failure it can name is a record, not a throw.
 */
export function republishProject(request: RepublishRequest): ProjectPublishRecord {
  const runPaths = runPathsFor(request.paths, request.run.runId);
  if (!isTerminal(request.run.status)) {
    const record: DeclinedProjectRecord = {
      published: false,
      runId: request.run.runId,
      source: runPaths.workspace,
      reason: "run-not-terminal",
      detail:
        `run ${request.run.runId} is ${request.run.status}: its workspace is still being written, so publishing it ` +
        "now would copy a half-finished tree into a folder named after the ticket. Nothing was copied.",
      attemptedAt: new Date().toISOString(),
    };
    // NOT WRITTEN TO `results/`. A refusal to publish a RUNNING run must not
    // overwrite the record of the publish that run will make when it finishes.
    return record;
  }
  return publishProject({
    runId: request.run.runId,
    ticketTitle: request.run.ticketTitle,
    workspace: runPaths.workspace,
    projectsDir: request.paths.projects,
    resultsDir: runPaths.results,
    run: request.run,
    git: request.git,
  });
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
