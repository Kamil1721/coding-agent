/**
 * project-handover.ts — the published copy becomes a REPOSITORY, not a folder.
 *
 * THE ASK, VERBATIM: "what if I wanted to work in the project after it was done?
 * I don't have a file or a database to work from." `project-publish.ts` already
 * puts the finished code in `projects/<slug>/`; measured on the one published
 * project on this machine, that folder is eight files with no history, no
 * README, no `.gitignore` and — for a run that builds a backend — a `.db` full
 * of rows the build agent wrote while testing itself. `npm start` works. Nothing
 * else about it is workable: there is no baseline to diff against, no statement
 * of how to start it, no list of what it reads from the environment, and no way
 * to recreate the database from empty.
 *
 * This module runs AFTER the copy and turns that folder into: one commit
 * containing everything published, a README (only when the builder shipped
 * none), a `.gitignore` (only when the builder shipped none), and `db/schema.sql`
 * for every SQLite file that came across.
 *
 * IT DOES NOT TOUCH THE RUN'S OWN REPOSITORY, AND THAT IS THE WHOLE POINT OF
 * SEPARATING IT FROM THE BUILD. `runs/<id>/workspace/.git` holds a single
 * `workspace created` commit which is the BASELINE `orchestrator.ts:3974` diffs
 * against to produce the judge's reading material; a commit made in there empties
 * that diff and blinds the judge. Every git command here runs with `cwd` set to
 * the PUBLISHED directory, `.git` is never copied (`PROJECT_EXCLUDED_ENTRIES`),
 * and {@link commitPublishedTree} refuses to run `add` at all until
 * `rev-parse --absolute-git-dir` has confirmed the repository it is talking to is
 * the published directory's own.
 *
 * THAT CONFIRMATION IS NOT PARANOIA — MEASURED. `projects/` is a sibling of
 * `dashboard/`, i.e. INSIDE the owner's own repository (it is gitignored there,
 * `/projects/` at `.gitignore:56`, so it is invisible rather than absent). A
 * `git status` run in the published folder BEFORE `git init` reports the OWNER'S
 * repository — verified in a scratch tree, it printed `?? projects/` — and
 * `git add -A` with no pathspec stages the whole work tree from the repository
 * root, not from the cwd. So the order is fixed: look for `.git` on the
 * filesystem, init if it is absent, verify the git dir, and only then run a
 * command that reads or writes an index.
 *
 * WHAT IS DELIBERATELY NOT COMMITTED — `node_modules`, every published SQLite
 * file and its `-wal`/`-shm`, the `.env` family, and an `.env.example` that
 * turns out to hold VALUES rather than names ({@link envTemplateHasValues}).
 *
 * IT TAKES TWO MECHANISMS AND THIS FILE USED TO CLAIM ONE. The `.gitignore`
 * this module writes covers the same ground but is written ONLY when the
 * builder shipped none, so it can never be what holds. `<git dir>/info/exclude`
 * — written every time, never committed because it lives inside `.git`, never
 * in conflict with the builder's file because it does not replace it — was
 * described here as the thing that holds, and it is not sufficient:
 * gitignore(5) ranks a working-tree `.gitignore` ABOVE `$GIT_DIR/info/exclude`,
 * so a builder rule of `!app.db` or `!.env` un-ignores a path we named and
 * `git add -A` stages it. Measured on git 2.50.1; the transcript is on
 * {@link handoverExcludeText}. So the exclude file is the first mechanism and
 * {@link stageTree} is the second: it READS THE INDEX BACK after `add` and
 * takes any forbidden path out of it, which is a measurement of the outcome
 * rather than trust in a rule. Tests drive nine different builder `.gitignore`
 * shapes, negations included, and one with none at all.
 *
 * THE RESIDUAL, STATED EXACTLY. Two things are still true. (1) The owner's OWN
 * later `git add -A` is governed by the exclude file alone — nothing here runs
 * again — so a builder negation can still let HIM commit a database on the next
 * `git commit -am`; the README's Database section is where he is told the file
 * is his to keep out. (2) A path already committed by an older build of this
 * program stays in that old commit; {@link stageTree} untracks it going forward
 * and names it on the record, and removing it from history needs a rewrite,
 * which is not something a publish step may do to somebody's repository.
 *
 * IT USED TO BE A PATHSPEC — `git add -A -- . :(exclude)node_modules …` — AND
 * THAT DEFEATED ITSELF. MEASURED, git 2.50.1 (Apple Git-155): git collects a
 * path into its "ignored" list whenever a pathspec's literal prefix names it and
 * does NOT care that the pathspec was an exclusion, so
 * `add -A -- . ':(exclude,literal)app.db'` in a tree whose `.gitignore` says
 * `*.db` prints "The following paths are ignored by one of your .gitignore
 * files: app.db" and EXITS 1 — leaving a correct index and no commit. The
 * `.gitignore` this module writes names `*.db` and `node_modules/`, so any
 * project carrying a database or a dependency tree hit that intersection with
 * itself and published with an empty `.git`. `--force` would have silenced it by
 * overriding EVERY rule the builder wrote, including one naming a key, so the
 * intersection was removed instead: nothing is named to `git add` any more.
 *
 * CREDENTIALS ARE NEVER READ. The only git configuration this module asks for is
 * `user.name` and `user.email`, so that the commit is attributed to the machine's
 * own identity rather than to a fiction; when git has neither, it falls back to
 * {@link FALLBACK_IDENTITY} instead of failing the publish. `credential.helper`,
 * tokens, remotes and `~/.git-credentials` are never touched, no remote is ever
 * added and nothing here can push.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type { ApiRunStatus } from "./api-types.js";

/* -------------------------------------------------------------------------
 * What the handover is told about the run
 * ---------------------------------------------------------------------- */

/**
 * The run facts the README's provenance block needs.
 *
 * STRUCTURAL ON PURPOSE — `RunRow` (db.ts) satisfies it as-is, so the call site
 * in `orchestrator.ts#publishProject`, which already holds the row, needs one
 * added field and no mapping layer. Declaring it here rather than importing
 * `RunRow` keeps this module off the database's dependency edge.
 */
export interface PublishRunFacts {
  readonly runId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly modelId: string;
  readonly status: ApiRunStatus;
  readonly endedAt: string | null;
}

/* -------------------------------------------------------------------------
 * Running git
 * ---------------------------------------------------------------------- */

/** One git invocation's result. Never throws; a failure is `ok: false`. */
export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** The binary could not be started at all — git not installed, or EACCES. */
  readonly unavailable: boolean;
}

/**
 * INJECTED so the failure branches are drivable.
 *
 * A test cannot uninstall git, and the git path is where this module can hurt
 * somebody: the "git failed, the copy survived" guarantee is only worth what its
 * test proves, and that test needs a runner that fails on demand. Real git still
 * runs in the tests that assert history, so the seam is not the only thing
 * exercised.
 */
export type GitRunner = (cwd: string, args: readonly string[]) => GitResult;

/** No git command may hang a terminal run. Generous; a large `add` is seconds. */
export const GIT_TIMEOUT_MS = 60_000;

export const spawnGit: GitRunner = (cwd, args) => {
  const run = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: gitEnv(),
  });
  if (run.error !== undefined) {
    return { ok: false, stdout: "", stderr: run.error.message, unavailable: true };
  }
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "", unavailable: false };
};

/**
 * The environment every git command here runs in.
 *
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are stripped because an inherited
 * one points every command below at a DIFFERENT repository — the exact failure
 * the git-dir verification exists to catch, arriving through the environment
 * instead of through the filesystem. `GIT_TERMINAL_PROMPT=0` is belt and braces:
 * nothing here talks to a remote, and a git that decided to ask for a password
 * would hang the terminal path of a run rather than fail it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  delete env["GIT_OBJECT_DIRECTORY"];
  delete env["GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  return env;
}

/** Used only when git itself has no `user.name`/`user.email` configured. */
export const FALLBACK_IDENTITY = Object.freeze({
  name: "Local dashboard",
  email: "dashboard@localhost",
});

/* -------------------------------------------------------------------------
 * The record
 * ---------------------------------------------------------------------- */

/** A file this module owns: written, already there, or refused with a reason. */
export type HandoverFile =
  | { readonly state: "written"; readonly path: string }
  /** The BUILDER shipped one. Never overwritten — his is the better document. */
  | { readonly state: "kept"; readonly path: string }
  | { readonly state: "declined"; readonly detail: string };

export interface SqliteTableCount {
  readonly name: string;
  /** `null` when counting threw — a view over a missing table, a virtual table. */
  readonly rows: number | null;
}

/**
 * Why a published `.db` produced no schema dump.
 *
 * `not-sqlite`   the header says it is not a database. A `.db` written by
 *                something else entirely, or a truncated copy.
 * `unreadable`   sqlite opened it and then refused — corruption, an encrypted
 *                file, a WAL that needs a recovery this read-only handle cannot
 *                perform.
 * `write-failed` the schema was read but `db/schema.sql` could not be written.
 */
export type DatabaseDecline = "not-sqlite" | "unreadable" | "write-failed";

export type DatabaseOutcome =
  | {
      readonly dumped: true;
      /** Relative to the published directory, forward slashes. */
      readonly file: string;
      readonly bytes: number;
      readonly schemaPath: string;
      readonly tables: readonly SqliteTableCount[];
      readonly objects: number;
    }
  | {
      readonly dumped: false;
      readonly file: string;
      readonly bytes: number;
      readonly reason: DatabaseDecline;
      readonly detail: string;
    };

/**
 * Why nothing was committed. Every one of these leaves the copied files exactly
 * where they are — a publish that cannot become a repository is still a publish.
 *
 * `git-unavailable`    git is not installed, or could not be started.
 * `init-failed`        `git init` refused. A read-only disk looks like this.
 * `not-our-repository` the directory's git dir is not `<directory>/.git`. The
 *                      case this refuses is the published folder sitting inside
 *                      ANOTHER repository with no `.git` of its own — staging
 *                      there would stage somebody else's work tree.
 * `stage-failed`       `git add` refused.
 * `commit-failed`      `git commit` refused. A pre-commit hook, a signing key
 *                      that is not there, a full disk.
 * `nothing-to-commit`  staging produced no change AND the repository has no
 *                      commit to point at. Distinct from the `unchanged` arm
 *                      below, which is the ordinary idempotent re-publish.
 * `handover-crashed`   {@link handoverProject} threw, which its contract says it
 *                      cannot. Named separately from `init-failed` so that a
 *                      broken contract is never read as a broken git.
 */
export type RepositoryDecline =
  | "git-unavailable"
  | "init-failed"
  | "not-our-repository"
  | "stage-failed"
  | "commit-failed"
  | "nothing-to-commit"
  | "handover-crashed";

export type RepositoryOutcome =
  | {
      readonly state: "committed";
      readonly commit: string;
      readonly branch: string;
      /** Files in the commit's tree. `node_modules` and databases are not in it. */
      readonly files: number;
      /** False when the repository already existed — a re-publish, not a first. */
      readonly initialised: boolean;
      /**
       * The commit made to PRESERVE uncommitted owner edits before the copy
       * wrote over them. Null in the ordinary case.
       */
      readonly preserved: string | null;
      /**
       * Paths that WERE staged and were taken back out before the commit.
       *
       * Non-empty means a builder `.gitignore` negation un-ignored something
       * this module refuses to commit — a database, a `.env`, a filled-in
       * `.env.example`, a dependency tree — and {@link stageTree} caught it in
       * the index. Every one of them is still on disk. Empty is the ordinary
       * case and is not a claim that nothing was excluded: the exclude file
       * keeps most paths from ever being staged, so they never appear here.
       */
      readonly withheld: readonly string[];
    }
  | {
      /** Re-publish of an unchanged run: the tree already matches. No new commit. */
      readonly state: "unchanged";
      readonly commit: string;
      readonly branch: string;
      /** As above. Non-empty here means the only staged change was refused. */
      readonly withheld: readonly string[];
    }
  | { readonly state: "declined"; readonly reason: RepositoryDecline; readonly detail: string };

/** Everything this module did to the published directory. */
export interface HandoverRecord {
  readonly readme: HandoverFile;
  readonly gitignore: HandoverFile;
  readonly databases: readonly DatabaseOutcome[];
  readonly repository: RepositoryOutcome;
  /** Names read from `process.env` in the published code. See {@link scanEnvVars}. */
  readonly envVars: readonly EnvVarUse[];
}

export interface HandoverRequest {
  /** The published copy. Everything here is written INSIDE this directory. */
  readonly directory: string;
  /** Null when the caller has no run row — the README then says so rather than lying. */
  readonly run: PublishRunFacts | null;
  /** `runs/<id>/workspace` — named in the README so the evidence stays findable. */
  readonly workspace: string;
  readonly publishedAt: string;
  /**
   * A commit made just before the copy to save uncommitted owner edits.
   * Reported on the outcome so the owner can find his work by sha.
   */
  readonly preservedCommit?: string | null;
  readonly git?: GitRunner | undefined;
}

/* -------------------------------------------------------------------------
 * The handover
 * ---------------------------------------------------------------------- */

/**
 * Make the published directory workable. NEVER THROWS.
 *
 * Every step is individually fallible — a read-only disk, a `.db` that is not a
 * database, a git that is not installed — and every one of them degrades to a
 * NAMED entry on {@link HandoverRecord} rather than to an exception. That is a
 * hard requirement, not a nicety: this runs inside `publishProject`, which runs
 * inside the orchestrator's terminal path, and a throw here would turn a passed
 * run into a harness fault.
 *
 * ORDER MATTERS. The databases are read first because the README quotes their
 * row counts and the commit must exclude their files; the commit is last because
 * it is the only step that must see everything the others wrote.
 *
 * WHAT IT COSTS THE TERMINAL PATH: 133, 199, 162, 126, 133 ms across five runs
 * against a copy of the one real published project on this machine (14 files,
 * 91 KB, no database), and 128, 116, 114, 116, 108 ms re-measured on 2026-08-02
 * against the same shape AFTER {@link stageTree}'s index read was added. Almost
 * all of it is git: eleven invocations on the ordinary first publish (init,
 * rev-parse, add, ls-files, diff, two configs, commit, two rev-parses,
 * ls-files), one more than before that read. An earlier version of this
 * paragraph said "six", which was never the count. The copy this follows is
 * 5.6–12 MB, so it is a fraction of a step the orchestrator already documents
 * as a short pause at the end of a build measured in hours.
 */
export function handoverProject(request: HandoverRequest): HandoverRecord {
  const git = request.git ?? spawnGit;
  const databases = dumpDatabases(request.directory);
  const gitignore = writeGitignore(request.directory);
  const envVars = scanEnvVars(request.directory);
  const readme = writeReadme(request, databases, envVars);
  const repository = commitPublishedTree({
    directory: request.directory,
    git,
    message: commitMessage(request),
    databases,
    preserved: request.preservedCommit ?? null,
  });
  return { readme, gitignore, databases, repository, envVars };
}

/* -------------------------------------------------------------------------
 * .gitignore
 * ---------------------------------------------------------------------- */

export const HANDOVER_GITIGNORE = ".gitignore";

/**
 * Rules that hold for ANY published tree, wherever they are written.
 *
 * Shared by the `.gitignore` below and by {@link handoverExcludeText}, which is
 * the copy that actually runs: one list, so a rule cannot be tightened in the
 * file the owner reads and left loose in the file that decides the commit.
 *
 * THE `.env` BLOCK IS THREE RULES, NOT ONE. `.env` alone misses
 * `.env.production`; a blanket `.env*` would take `.env.example` with it, and
 * that file is the documentation of which variables the project needs — the one
 * `.env` you WANT in the history.
 *
 * THE NEGATIONS ARE CONDITIONAL, AND THE CONDITION IS NOW CHECKED. `.env.example`
 * is safe to commit for exactly one reason: it holds variable NAMES and no
 * VALUES. That is a claim about the file's contents, and until 2026-08-02
 * nothing read the contents — a builder that filled in a working key while
 * testing itself (which happens) had it committed by these three lines. So
 * {@link handoverExcludeText} takes the exception back, BY NAME, for any
 * template that assigns a non-empty value; see {@link envTemplateHasValues}.
 * The negations stay here because they are still right for the file the rule
 * was written for, and the `.gitignore` this module writes is a courtesy for
 * the owner's own future files rather than the mechanism (see below).
 */
const HANDOVER_EXCLUDE_RULES: readonly string[] = Object.freeze([
  "# A dependency tree is not the project, and it is tens of thousands of files.",
  "node_modules/",
  "",
  "# Secrets. `.env.example` and friends are kept ONLY while they hold names and",
  "# no values; one that assigns a value is re-excluded by name further down.",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "",
  ".DS_Store",
]);

/**
 * WRITTEN ONLY WHEN THE BUILDER SHIPPED NONE.
 *
 * It is a courtesy for the owner's own future commits, NOT the mechanism that
 * keeps a database or a key out of this repository — see
 * {@link handoverExcludeText}, which holds whether or not this file exists.
 */
export const HANDOVER_GITIGNORE_TEXT = [
  "# SQLite artefacts. The published copy may carry a database the build agent",
  "# filled while testing itself; those rows are not part of the project, and a",
  "# generated database is not something to keep in version control.",
  "*.db",
  "*.db-shm",
  "*.db-wal",
  "*.sqlite",
  "*.sqlite3",
  "",
  ...HANDOVER_EXCLUDE_RULES,
  "",
].join("\n");

function writeGitignore(directory: string): HandoverFile {
  const path = join(directory, HANDOVER_GITIGNORE);
  if (existsSync(path)) return { state: "kept", path: HANDOVER_GITIGNORE };
  try {
    writeFileSync(path, HANDOVER_GITIGNORE_TEXT, "utf8");
    return { state: "written", path: HANDOVER_GITIGNORE };
  } catch (error) {
    return { state: "declined", detail: redactForPersistence(messageOf(error)) };
  }
}

/* -------------------------------------------------------------------------
 * The databases
 * ---------------------------------------------------------------------- */

export const HANDOVER_DB_DIR = "db";
export const HANDOVER_SCHEMA_FILE = "schema.sql";

/** Extensions treated as a SQLite database. `-wal`/`-shm` are not databases. */
const DATABASE_SUFFIXES: readonly string[] = Object.freeze([".db", ".sqlite", ".sqlite3"]);

/** Never walked, by name at any depth: a dependency tree is not the project. */
const UNSCANNED_DIRECTORIES: readonly string[] = Object.freeze([".git", "node_modules"]);

/** Bound on the walk. Deeper than {@link MAX_PUBLISH_DEPTH}'s sibling would be a cycle. */
const MAX_WALK_DEPTH = 12;

/**
 * Every published SQLite file, relative to the published directory, sorted.
 *
 * Exported because `project-publish.ts` needs the same list BEFORE the copy, to
 * decide whether a re-published directory is dirty: an untracked database that
 * the builder's own `.gitignore` does not cover would otherwise make every
 * re-publish look like owner work in progress, forever.
 */
export function findPublishedDatabases(directory: string): readonly string[] {
  const out: string[] = [];
  walkFiles(directory, "", 0, (rel) => {
    const lower = rel.toLowerCase();
    if (DATABASE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) out.push(rel);
  });
  return out.sort();
}

/** `.env`, `.env.local`, `.env.production` — but never `.env.example`. */
const ENV_FILE = /^\.env(\..+)?$/;

/** The `.env` files that carry names rather than values. These ARE committed. */
const ENV_TEMPLATE_SUFFIXES: readonly string[] = Object.freeze(["example", "sample", "template"]);

/** True for a `.env` file whose contents are a secret rather than a template. */
export function isSecretEnvFile(name: string): boolean {
  if (!ENV_FILE.test(name)) return false;
  // `.env` itself slices to "", which is in no template list — a secret.
  return !ENV_TEMPLATE_SUFFIXES.includes(name.slice(".env.".length).toLowerCase());
}

/** True for `.env.example`, `.env.sample`, `.env.template` — and nothing else. */
export function isEnvTemplateFile(name: string): boolean {
  return ENV_FILE.test(name) && !isSecretEnvFile(name);
}

/**
 * Does this `.env` template ASSIGN a value, or does it only name variables?
 *
 * THE WHOLE ARGUMENT FOR COMMITTING `.env.example` RESTS ON THE ANSWER. The rule
 * that force-includes it says the file "says which variables the project reads
 * without saying what they are" — true of `API_KEY=`, false of
 * `API_KEY=sk-live-…`, and a build agent that fills one in to get its own tests
 * green produces the second. So the claim is measured rather than assumed.
 *
 * ANY NON-EMPTY VALUE COUNTS, AND THERE IS DELIBERATELY NO PLACEHOLDER
 * ALLOW-LIST. `API_KEY=your-key-here` and `API_KEY=sk-live-…` are not
 * distinguishable by this function, by a regex, or by anything short of asking
 * the vendor — so a list of "obviously fake" values would be a guess presented
 * as a guarantee, which is the defect this module keeps finding in itself. The
 * cost of the strict rule is named rather than hidden: an example holding
 * `PORT=3000` is dropped from the history too, and the file is still on disk,
 * still beside the code, still readable. Losing a committed `PORT=3000` is the
 * cheap direction of the error.
 *
 * WHAT IT PARSES. `NAME=`, `export NAME=`, a `#` comment line, a trailing
 * ` # comment` after a value, and single- or double-quoted values (`PORT=""` is
 * empty). It does NOT parse multi-line values, `$(…)` substitution, or a here-doc
 * — none of which appear in a `.env`, and each of which would be read as an
 * assignment with a value, i.e. it errs toward excluding the file.
 */
export function envTemplateHasValues(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/.exec(line);
    if (assignment === null) continue;
    // A `#` only opens a comment after whitespace, so `PASS="a#b"` keeps its value.
    const value = (assignment[1] ?? "").trim().replace(/\s+#.*$/, "").trim();
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if ((quoted?.[2] ?? value).trim() !== "") return true;
  }
  return false;
}

/**
 * Every published `.env` TEMPLATE that carries a value — i.e. every one the
 * force-include above must not apply to.
 *
 * AN UNREADABLE TEMPLATE COUNTS AS FILLED. "I could not open it" is not
 * evidence that it holds no key, and the cost of being wrong runs one way only.
 */
export function findFilledEnvTemplates(directory: string): readonly string[] {
  const out: string[] = [];
  walkFiles(directory, "", 0, (rel) => {
    if (!isEnvTemplateFile(basename(rel))) return;
    let text: string;
    try {
      text = readFileSync(join(directory, rel), "utf8");
    } catch {
      out.push(rel);
      return;
    }
    if (envTemplateHasValues(text)) out.push(rel);
  });
  return out.sort();
}

/**
 * Every published `.env` that is a secret, relative to the published directory.
 *
 * Used for the DIRTINESS measurement in {@link inspectRepository}, which has to
 * see the same exclusions the commit does — a `.env` counted as owner work would
 * send a re-publish through {@link preserveUncommittedWork} for a file that is
 * deliberately never committed. The commit itself excludes these by RULE
 * ({@link HANDOVER_EXCLUDE_RULES}), not by this list, so a `.env` the owner
 * writes tomorrow is covered too.
 */
export function findPublishedEnvFiles(directory: string): readonly string[] {
  const out: string[] = [];
  walkFiles(directory, "", 0, (rel) => {
    if (isSecretEnvFile(basename(rel))) out.push(rel);
  });
  return out.sort();
}

function walkFiles(directory: string, prefix: string, depth: number, visit: (rel: string) => void): void {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of safeReaddir(directory)) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (UNSCANNED_DIRECTORIES.includes(entry.name)) continue;
      walkFiles(join(directory, entry.name), rel, depth + 1, visit);
      continue;
    }
    if (entry.isFile()) visit(rel);
  }
}

/** An unreadable directory is walked as an empty one — the copy already happened. */
function safeReaddir(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export interface SqliteObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

export interface SqliteSchema {
  readonly objects: readonly SqliteObject[];
  readonly tables: readonly SqliteTableCount[];
}

/**
 * Read a SQLite file's schema and per-table row counts. READ-ONLY.
 *
 * `readOnly: true` is the point: this is the OWNER'S database and the rows in it
 * are evidence of what the build agent did. Measured on this machine's Node
 * (v25.9.0) — a write through a read-only handle fails with `ERR_SQLITE_ERROR`,
 * and a file that is not a database opens without complaint and throws
 * `file is not a database` on the first read, which is why the caller treats a
 * THROWN error as the not-a-database signal rather than trusting `open`.
 *
 * Throws for a file that is not a readable database. The caller names it.
 */
export function readSqliteSchema(file: string): SqliteSchema {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("select type, name, sql from sqlite_master where sql is not null order by name").all();
    const objects: SqliteObject[] = [];
    for (const row of rows) {
      const type = row["type"];
      const name = row["name"];
      const sql = row["sql"];
      if (typeof type !== "string" || typeof name !== "string" || typeof sql !== "string") continue;
      // `sqlite_%` is SQLite's own bookkeeping (`sqlite_sequence`, autoindexes).
      // Re-creating it by hand is an error; SQLite makes it when it needs it.
      if (name.toLowerCase().startsWith("sqlite_")) continue;
      objects.push({ type, name, sql });
    }
    const tables: SqliteTableCount[] = [];
    for (const object of objects) {
      if (object.type !== "table") continue;
      tables.push({ name: object.name, rows: countRows(db, object.name) });
    }
    return { objects, tables };
  } finally {
    db.close();
  }
}

/**
 * `null` RATHER THAN A THROW, per table.
 *
 * A view over a dropped table and a virtual table with a missing module both
 * fail this query while the rest of the schema is perfectly readable. Losing one
 * count is a footnote; losing the dump is the owner's complaint again.
 */
function countRows(db: DatabaseSync, table: string): number | null {
  try {
    const row = db.prepare(`select count(*) as c from "${table.replace(/"/g, '""')}"`).get();
    const value = row === undefined ? null : row["c"];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    return null;
  } catch {
    return null;
  }
}

/**
 * Dump every published database's schema. One outcome per file, whatever happens.
 *
 * NAMING RULE, STATED BECAUSE IT IS ARBITRARY: one database gets
 * `db/schema.sql`; two or more get one file each, named by
 * {@link schemaPathsFor}, because merging two schemas into one file produces a
 * script that cannot be run (two `users` tables) and picking a winner hides the
 * other.
 *
 * `db/` IS NOT CREATED UNTIL A READ HAS FULLY SUCCEEDED. A corrupt database must
 * leave no empty directory and no half-written `schema.sql` — a file that exists
 * and is wrong is worse than one that is absent and named in the record.
 */
function dumpDatabases(directory: string): readonly DatabaseOutcome[] {
  const files = findPublishedDatabases(directory);
  // COMPUTED FOR THE WHOLE SET UP FRONT, not per file, because collision
  // resolution needs to see the names already taken. See {@link schemaPathsFor}.
  const paths = schemaPathsFor(files);
  const out: DatabaseOutcome[] = [];
  for (const file of files) {
    const absolute = join(directory, file);
    let bytes = 0;
    try {
      bytes = statSync(absolute).size;
    } catch {
      bytes = 0;
    }
    let schema: SqliteSchema;
    try {
      schema = readSqliteSchema(absolute);
    } catch (error) {
      const detail = redactForPersistence(messageOf(error));
      out.push({
        dumped: false,
        file,
        bytes,
        reason: /not a database|file is encrypted|malformed/i.test(detail) ? "not-sqlite" : "unreadable",
        detail,
      });
      continue;
    }
    const schemaPath = paths.get(file) ?? `${HANDOVER_DB_DIR}/${HANDOVER_SCHEMA_FILE}`;
    try {
      mkdirSync(join(directory, HANDOVER_DB_DIR), { recursive: true });
      writeFileSync(join(directory, schemaPath), renderSchemaSql(file, schema), "utf8");
    } catch (error) {
      out.push({ dumped: false, file, bytes, reason: "write-failed", detail: redactForPersistence(messageOf(error)) });
      continue;
    }
    out.push({ dumped: true, file, bytes, schemaPath, tables: schema.tables, objects: schema.objects.length });
  }
  return out;
}

/** `data/app.db` → `data-app`, reduced to characters a filename can carry. */
function schemaBasename(relative: string): string {
  const name = relative.replace(/\.[^./]+$/, "");
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "database";
}

/**
 * Where each published database's schema dump goes — COLLISION-FREE BY
 * CONSTRUCTION.
 *
 * WHAT WENT WRONG, AND IT WAS SILENT. The name was the file's BASENAME, lower
 * cased with every run of non-alphanumerics collapsed to `-`. So `my-app.db`,
 * `my_app.db` and `my app.db` all became `my-app`, and `app.db` beside
 * `data/app.db` both became `app`: two dumps, one path, the second
 * `writeFileSync` overwriting the first, both reported `dumped: true` with the
 * same `schemaPath`. The owner got one schema and a record saying he had two.
 *
 * TWO CHANGES, AND THE SECOND IS THE ONE THAT CANNOT FAIL. The name is now
 * derived from the WHOLE relative path, so `data/app.db` is `data-app` and no
 * longer meets `app.db` — that fixes the common case and cannot fix the general
 * one, because the cleaning is lossy on purpose (a filename must survive a
 * `.gitignore`, a shell and a case-insensitive filesystem). So every name is
 * then checked against the ones already taken and a colliding one gets `-2`,
 * `-3`, … appended. Deterministic because {@link findPublishedDatabases}
 * returns a SORTED list, so the same tree always numbers them the same way.
 *
 * A NUMBERED NAME IS ONLY HONEST BECAUSE THE DUMP SAYS WHICH FILE IT IS:
 * {@link renderSchemaSql} writes `-- Schema of <relative path>` as its first
 * line, so `db/my-app-2.schema.sql` is not a riddle — opening it names
 * `my_app.db`. Without that line this scheme would trade a silent overwrite for
 * a silent mislabel.
 *
 * ONE DATABASE STILL GETS `db/schema.sql`, unnumbered and unprefixed: it is the
 * overwhelmingly common case and `db/schema.sql` is the name a person looks for.
 */
export function schemaPathsFor(files: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (files.length === 1 && files[0] !== undefined) {
    out.set(files[0], `${HANDOVER_DB_DIR}/${HANDOVER_SCHEMA_FILE}`);
    return out;
  }
  const taken = new Set<string>();
  for (const file of files) {
    const base = schemaBasename(file);
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${String(n)}`;
    taken.add(name);
    out.set(file, `${HANDOVER_DB_DIR}/${name}.${HANDOVER_SCHEMA_FILE}`);
  }
  return out;
}

/** The dump. Readable top to bottom, and runnable against an empty database. */
export function renderSchemaSql(file: string, schema: SqliteSchema): string {
  const lines: string[] = [
    `-- Schema of ${file}, read when this project was published.`,
    "--",
    "-- The database FILE is published beside this dump and is kept out of the",
    "-- repository: its rows are whatever the build agent left there while testing",
    "-- itself, not project data. Delete the file and run this script against an",
    "-- empty database when you want a clean start.",
    "--",
  ];
  if (schema.tables.length === 0) {
    lines.push("-- No tables.");
  } else {
    lines.push("-- Rows at publish time:");
    for (const table of schema.tables) {
      lines.push(`--   ${table.name}: ${table.rows === null ? "not countable" : `${String(table.rows)} rows`}`);
    }
  }
  lines.push("");
  for (const object of schema.objects) {
    lines.push(`${object.sql.trimEnd()};`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/* -------------------------------------------------------------------------
 * The environment variables
 * ---------------------------------------------------------------------- */

export interface EnvVarUse {
  readonly name: string;
  /** The first published file that reads it, relative, forward slashes. */
  readonly file: string;
}

/** Files above this are not source. Reading them to grep would cost more than it finds. */
const MAX_SCAN_BYTES = 512 * 1024;
/** A bound, so a published `dist/` of ten thousand chunks cannot stall the terminal path. */
const MAX_SCAN_FILES = 4_000;

const ENV_DOT = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_INDEX = /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g;

/**
 * Every environment variable the PUBLISHED code reads, discovered by reading it.
 *
 * NOT GUESSED, AND NOT COMPLETE — both halves matter. It finds `process.env.X`
 * and `process.env["X"]`, which is what the one real published artefact on this
 * machine uses (`server.mjs` reads `PORT` and `HOST` in the dot form). It does
 * NOT find a destructure (`const { PORT } = process.env`), a dynamic key
 * (`process.env[name]`), or a variable read by a dependency rather than by this
 * code. The README says so in that many words rather than presenting the table
 * as exhaustive.
 *
 * `node_modules` IS NOT SCANNED. A dependency tree reads hundreds of variables
 * none of which the owner configures, and a README listing them would be noise
 * that hides the two that matter.
 *
 * Binary files are skipped by looking for a NUL byte in the decoded text rather
 * than by extension, so an unfamiliar binary format cannot leak bytes that
 * happen to spell `process.env` into the table.
 */
export function scanEnvVars(directory: string): readonly EnvVarUse[] {
  const found = new Map<string, string>();
  let scanned = 0;
  walkFiles(directory, "", 0, (rel) => {
    if (scanned >= MAX_SCAN_FILES) return;
    const absolute = join(directory, rel);
    let text: string;
    try {
      if (statSync(absolute).size > MAX_SCAN_BYTES) return;
      text = readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    scanned += 1;
    // The binary test is a NUL byte rather than an extension allow-list: an
    // unfamiliar binary format must not be able to contribute bytes that happen
    // to decode as `process.env` to a table the owner will trust.
    if (text.includes("\0")) return;
    for (const pattern of [ENV_DOT, ENV_INDEX]) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        const name = match[1];
        if (name !== undefined && !found.has(name)) found.set(name, rel);
        match = pattern.exec(text);
      }
    }
  });
  return [...found.entries()]
    .map(([name, file]) => ({ name, file }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------
 * The README
 * ---------------------------------------------------------------------- */

export const HANDOVER_README = "README.md";

/** A README the builder shipped, under any of the names one arrives as. */
const README_PATTERN = /^readme(\.(md|markdown|txt|rst))?$/i;

export interface StartCommand {
  readonly kind: "npm-start" | "npm-script" | "static" | "unknown";
  readonly commands: readonly string[];
  readonly detail: string;
}

/** What a redacted assignment's value is replaced BY. Visible, and not a length. */
export const REDACTED_VALUE = "<redacted>";

/**
 * A builder's script as the README may print it — every `NAME=VALUE` reduced to
 * `NAME=<redacted>`.
 *
 * WHY IT IS REDACTED RATHER THAN REFUSED, WHICH WAS THE OTHER OPTION. The
 * README's first paragraph tells the owner this folder is his to commit and to
 * push, and `discoverStartCommand` was copying the `start` script into it
 * verbatim — so `API_KEY=sk-… node server.mjs`, which is exactly what an agent
 * writes when it cannot get an environment loaded and needs its own tests
 * green, put a live key in the most publishable file in the tree. Refusing to
 * print the script at all would also have closed that, and it costs something
 * real: the RUNNABLE command is `npm start`, but the script body is how the
 * owner learns the thing needs `API_KEY` set before it will boot. Redacting the
 * VALUE and keeping the NAME loses nothing he needs and removes the credential.
 *
 * WHAT IS CAUGHT, EXACTLY, BECAUSE THE PRECISION IS THE POINT:
 *
 *   · every `NAME=VALUE` token — leading `FOO=bar` assignments, `env FOO=bar`,
 *     and `--flag=value` too, structurally, without knowing what any of them
 *     mean. `--port=3000` is redacted along with `--token=…`, which is
 *     over-redaction and is the safe direction: nothing here can tell a port
 *     from a password, and the README says the command is `npm start`.
 *   · `NAME=` with nothing after it is left alone: there is no value to hide,
 *     and blanking it would hide the fact that the script sets an empty one.
 *   · whatever `redactForPersistence` recognises in what is LEFT — vendor key
 *     shapes (`sk-ant-…`, `AKIA…`, JWTs, PEM blocks), a credential in a URL's
 *     userinfo, and 40+ character mixed-case-plus-digit tokens.
 *
 * WHAT IS NOT CAUGHT, AND THIS SENTENCE IS THE ONE THAT MUST NOT BE DROPPED: a
 * secret passed as a bare POSITIONAL argument (`node server.mjs hunter2`) is
 * caught only if `redactForPersistence` recognises its shape, and a short
 * arbitrary value has no shape. This is a redaction, not a guarantee.
 */
export function redactStartScript(script: string): string {
  // CORRECTED 2026-08-03, AND THE OLD SHAPE IS NAMED BECAUSE ITS TEST WAS GREEN
  // OVER IT. The previous expression was
  // `/(^|\s|=)(NAME=)(\S+)/g` and it leaked in four measured shapes, three of
  // them from the lead class alone:
  //
  //     sh -c 'API_KEY=sk-live-9f2a node app.mjs'   -> unchanged
  //     cd server;API_KEY=sk-live-9f2a node app.mjs -> unchanged
  //     (API_KEY=sk-live-9f2a node app.mjs)         -> unchanged
  //     JWT_SECRET="my super secret key" node …     -> `<redacted> super secret key"`
  //
  // `(^|\s|=)` requires the assignment to begin the string or follow a space or
  // an `=`, so a quote, a `;` or a `(` in front of it defeated the whole rule;
  // and `(\S+)` stops at the first space INSIDE a quoted value, printing its
  // tail. Only the unquoted space-separated shape was tested
  // (`project-handover.test.ts`), which is why the suite stayed green over all
  // four. The test now carries every shape above.
  //
  // A LOOKBEHIND, NOT A LEAD GROUP: the boundary that matters is "the character
  // before is not part of a name", which is exactly what must not be enumerated
  // by hand — enumerating it is how the first three escaped. And the value is
  // matched quote-aware, longest form first, so a quoted value goes whole.
  const named = script.replace(
    /(?<![A-Za-z0-9_])((?:[A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z0-9][A-Za-z0-9_-]*)=)(?:"[^"]*"|'[^']*'|\S+)/g,
    (_whole, name: string) => `${name}${REDACTED_VALUE}`,
  );
  return redactForPersistence(named);
}

/**
 * How to start the published project, read out of what was published.
 *
 * The one real artefact on this machine has `"start": "node server.mjs"`, so
 * `npm start` is right for it — but a static page with no `package.json` has no
 * start command at all, and inventing one ("just run npm start") is the kind of
 * README line that wastes an evening. The `unknown` arm says what was looked for
 * and found missing instead.
 *
 * THE SCRIPT IS QUOTED THROUGH {@link redactStartScript} AND NEVER RAW. `detail`
 * is rendered into `README.md`, which the README itself tells the owner to
 * commit and push.
 */
export function discoverStartCommand(directory: string): StartCommand {
  const manifest = readPackageJson(directory);
  if (manifest !== null) {
    const install = needsInstall(directory, manifest) ? ["npm install"] : [];
    const start = manifest.scripts?.["start"];
    if (typeof start === "string") {
      return {
        kind: "npm-start",
        commands: [...install, "npm start"],
        detail: `\`package.json\` defines \`start\`: \`${redactStartScript(start)}\`.`,
      };
    }
    for (const name of ["dev", "serve"]) {
      const script = manifest.scripts?.[name];
      if (typeof script === "string") {
        return {
          kind: "npm-script",
          commands: [...install, `npm run ${name}`],
          detail: `\`package.json\` has no \`start\` script; \`${name}\` is \`${redactStartScript(script)}\`.`,
        };
      }
    }
  }
  if (existsSync(join(directory, "index.html"))) {
    return {
      kind: "static",
      commands: ["python3 -m http.server 8000"],
      detail:
        "There is no `package.json` with a start script, and there is an `index.html` — this is a static page. " +
        "Open `index.html` directly, or serve the folder and visit http://127.0.0.1:8000.",
    };
  }
  return {
    kind: "unknown",
    commands: [],
    detail:
      "No start command could be discovered: there is no `package.json` with a `start`, `dev` or `serve` script " +
      "and no `index.html` at the top level. Read the code before running anything.",
  };
}

interface PackageManifest {
  readonly scripts: Record<string, unknown> | undefined;
  readonly dependencies: Record<string, unknown> | undefined;
  readonly devDependencies: Record<string, unknown> | undefined;
}

function readPackageJson(directory: string): PackageManifest | null {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      scripts: asRecord(record["scripts"]),
      dependencies: asRecord(record["dependencies"]),
      devDependencies: asRecord(record["devDependencies"]),
    };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Dependencies declared and no `node_modules` published — he has to install. */
function needsInstall(directory: string, manifest: PackageManifest): boolean {
  const declared =
    Object.keys(manifest.dependencies ?? {}).length + Object.keys(manifest.devDependencies ?? {}).length;
  return declared > 0 && !existsSync(join(directory, "node_modules"));
}

function writeReadme(
  request: HandoverRequest,
  databases: readonly DatabaseOutcome[],
  envVars: readonly EnvVarUse[],
): HandoverFile {
  const existing = existingReadme(request.directory);
  // THE BUILDER'S README WINS, ALWAYS. It was written by something that knows
  // what the project is; this one is assembled from a directory listing.
  if (existing !== null) return { state: "kept", path: existing };
  try {
    writeFileSync(
      join(request.directory, HANDOVER_README),
      renderReadme({
        title: request.run?.ticketTitle ?? "Published project",
        run: request.run,
        workspace: request.workspace,
        publishedAt: request.publishedAt,
        start: discoverStartCommand(request.directory),
        env: envVars,
        databases,
      }),
      "utf8",
    );
    return { state: "written", path: HANDOVER_README };
  } catch (error) {
    return { state: "declined", detail: redactForPersistence(messageOf(error)) };
  }
}

function existingReadme(directory: string): string | null {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && README_PATTERN.test(entry.name)) return entry.name;
    }
  } catch {
    return null;
  }
  return null;
}

export interface ReadmeFacts {
  readonly title: string;
  readonly run: PublishRunFacts | null;
  readonly workspace: string;
  readonly publishedAt: string;
  readonly start: StartCommand;
  readonly env: readonly EnvVarUse[];
  readonly databases: readonly DatabaseOutcome[];
}

/**
 * PURE, so every claim it makes is drivable from a test without a filesystem.
 *
 * It states what it does not know. A run whose facts were not passed gets
 * "not recorded" in the provenance table rather than a plausible blank, because
 * a README that quietly omits the run id is one the owner cannot use to find the
 * evidence — which is the entire reason the block exists.
 */
export function renderReadme(facts: ReadmeFacts): string {
  const lines: string[] = [`# ${facts.title.trim() === "" ? "Published project" : facts.title.trim()}`, ""];
  lines.push(
    "This folder is the code from a finished run on the local dashboard, copied out of the run's own workspace.",
    "It is a COPY and it is yours: edit it, commit to it, move it, delete it. Nothing writes here again unless you",
    "re-publish the same run, and the run's own copy — the one that was scored — stays where the provenance block",
    "below says it is.",
    "",
    "## Run it",
    "",
  );
  if (facts.start.commands.length > 0) {
    lines.push("```sh", ...facts.start.commands, "```", "");
  }
  lines.push(facts.start.detail, "");

  lines.push("## Environment", "");
  if (facts.env.length === 0) {
    lines.push("The published code reads no `process.env` variable.", "");
  } else {
    lines.push("| Variable | First read in |", "| --- | --- |");
    for (const use of facts.env) lines.push(`| \`${use.name}\` | \`${use.file}\` |`);
    lines.push("");
  }
  lines.push(
    "Found by reading the published files for `process.env.NAME` and `process.env[\"NAME\"]`. A variable read by",
    "destructuring (`const { PORT } = process.env`), by a dynamic key, or by a dependency is NOT in that table —",
    "so treat it as the list to start from, not as a complete one.",
    "",
  );

  if (facts.databases.length > 0) {
    lines.push("## Database", "");
    for (const database of facts.databases) {
      if (database.dumped) {
        const rows = database.tables.reduce((sum, table) => sum + (table.rows ?? 0), 0);
        lines.push(
          `\`${database.file}\` — ${String(database.bytes)} bytes, ${String(database.tables.length)} table(s), ` +
            `${String(rows)} row(s). Schema dumped to \`${database.schemaPath}\`.`,
          "",
        );
        if (database.tables.length > 0) {
          lines.push("| Table | Rows at publish time |", "| --- | --- |");
          for (const table of database.tables) {
            lines.push(`| \`${table.name}\` | ${table.rows === null ? "not countable" : String(table.rows)} |`);
          }
          lines.push("");
        }
      } else {
        lines.push(
          `\`${database.file}\` — ${String(database.bytes)} bytes. NO schema was dumped (${database.reason}): ` +
            `${database.detail}`,
          "",
        );
      }
    }
    lines.push(
      "THE ROWS ARE NOT PROJECT DATA. They are whatever the build agent wrote while testing itself. The file is",
      "published, is kept out of this repository's history, and is not deleted or emptied for you — that is your",
      "call. Re-create it from the schema dump when you want to start clean.",
      "",
    );
  }

  lines.push("## Provenance", "", "| | |", "| --- | --- |");
  lines.push(`| Run | \`${facts.run?.runId ?? "not recorded"}\` |`);
  lines.push(`| Ticket | \`${facts.run?.ticketId ?? "not recorded"}\` |`);
  lines.push(`| Verdict | ${facts.run?.status ?? "not recorded"} |`);
  lines.push(`| Model | \`${facts.run?.modelId ?? "not recorded"}\` |`);
  lines.push(`| Finished | ${facts.run?.endedAt ?? "not recorded"} |`);
  lines.push(`| Published | ${facts.publishedAt} |`);
  lines.push(`| Evidence | \`${facts.workspace}\` |`);
  lines.push(
    "",
    "The evidence path is the run's own workspace: the tree the gate and the judge actually read. It is still",
    "there, it is not this folder, and editing this folder cannot change any verdict.",
    "",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * The commit
 * ---------------------------------------------------------------------- */

/** Subject line length. Git's own convention, and what a log viewer shows. */
const MAX_SUBJECT_CHARS = 72;

function commitMessage(request: HandoverRequest): CommitMessage {
  const title = (request.run?.ticketTitle ?? "").trim().split("\n")[0] ?? "";
  const subject = title === "" ? "Published project" : title.slice(0, MAX_SUBJECT_CHARS);
  const body = [
    `Published from run ${request.run?.runId ?? "(not recorded)"} on the local dashboard.`,
    `Ticket: ${request.run?.ticketId ?? "(not recorded)"}. Verdict: ${request.run?.status ?? "(not recorded)"}.`,
    `The run's own copy of this tree stays at ${request.workspace}.`,
  ].join("\n");
  return { subject, body };
}

interface CommitMessage {
  readonly subject: string;
  readonly body: string;
}

interface CommitRequest {
  readonly directory: string;
  readonly git: GitRunner;
  readonly message: CommitMessage;
  readonly databases: readonly DatabaseOutcome[];
  readonly preserved: string | null;
}

/**
 * The same exclusions spelled as PATHSPECS — for `git status` only.
 *
 * NOT FOR `git add`, AND THE DIFFERENCE IS MEASURED. git collects a path into
 * its "ignored" list whenever a pathspec's literal prefix names it, without
 * regard for the pathspec being an EXCLUSION, and `git add` then refuses the
 * whole invocation with exit 1 ("The following paths are ignored by one of your
 * .gitignore files"). `git status` does no such thing — verified on git 2.50.1
 * with `status --porcelain -- . ':(exclude,literal)app.db'` in a tree ignoring
 * `*.db`: exit 0. So the dirtiness measurement can still name paths, and the
 * staging path names none; see {@link handoverExcludeText}.
 *
 * `literal` on the discovered paths because a filename is data: a project with a
 * file called `a[0].db` must not be read as a glob.
 */
export function excludedPathspecs(paths: readonly string[]): readonly string[] {
  return [
    ".",
    ":(exclude)node_modules",
    ":(exclude)node_modules/**",
    ":(exclude)**/node_modules/**",
    ...paths.map((file) => `:(exclude,literal)${file}`),
  ];
}

/** Where a repository's own ignore rules live, relative to its git dir. */
export const HANDOVER_EXCLUDE_FILE = "info/exclude";

/** The block this module owns inside that file. Anything outside it is kept. */
const EXCLUDE_BLOCK_START = "# --- published by the local dashboard: rules that keep this repository clean";
const EXCLUDE_BLOCK_END = "# --- end of the local dashboard's rules";

/**
 * The repository's OWN ignore rules — the mechanism that keeps the database,
 * the dependency tree and the `.env` out of the history.
 *
 * WHY HERE AND NOT IN THE `.gitignore`: the `.gitignore` belongs to the project
 * and is the builder's when he shipped one, which this module never edits — so a
 * rule written there is absent exactly when it is needed. `<git dir>/info/exclude`
 * is the repository's own file: it is never committed, never pushed, never in
 * the tree the owner reads, and it applies to HIS `git add -A` as well as to the
 * one below. That second half is the point for `.env`: the README tells him this
 * folder is his to commit to and push, and without this file his first
 * `git commit -am` would put the key in the history.
 *
 * IT IS NOT THE LAST WORD, AND THE DOCBLOCK USED TO SAY IT WAS. gitignore(5)
 * states the precedence, highest first: the command line, then `.gitignore`
 * files in the path's own directory and its parents, THEN
 * `$GIT_DIR/info/exclude`, then `core.excludesFile`. A builder `.gitignore`
 * therefore OUTRANKS this file, and one containing a negation defeats it.
 * MEASURED on git 2.50.1 (Apple Git-155), `.gitignore` = `*.db` + `!app.db`
 * against `info/exclude` = `/app.db`:
 *
 *   $ git check-ignore -v app.db
 *   .gitignore:2:!app.db    app.db
 *
 * — and `git add -A` then stages the database. What closes that gap is not this
 * file but {@link stageTree}, which READS THE INDEX BACK after staging and
 * takes any forbidden path out of it. This file is what governs the OWNER'S own
 * later `git add -A`, which nothing else can reach; the residual there is
 * unchanged and stated on {@link handoverProject}.
 *
 * The database paths are LITERAL, escaped so that `a[0].db` names that file and
 * not the pattern `a0.db`. `-wal` and `-shm` go with each one — a write-ahead log
 * holds rows that have not landed in the database file yet, so committing it
 * commits the same test data by another name.
 *
 * `filledTemplates` TAKES THE `.env.example` EXCEPTION BACK, by name, for the
 * templates that turned out to hold values. It is appended AFTER the negations
 * because gitignore is last-match-wins within one file — measured, same git:
 * with `!.env.example` on line 3 and `/.env.example` on line 4,
 * `git check-ignore -v .env.example` prints
 * `.git/info/exclude:4:/.env.example`.
 */
export function handoverExcludeText(
  databases: readonly string[],
  filledTemplates: readonly string[] = [],
): string {
  const lines: string[] = [
    EXCLUDE_BLOCK_START,
    "#",
    "# This file is inside .git/. It is NEVER committed and never pushed, and it",
    "# is what keeps the published database, node_modules and your .env out of",
    "# the first commit — and out of yours. To commit one of these anyway,",
    "# delete its line or run `git add -f <path>` once.",
    "#",
    ...HANDOVER_EXCLUDE_RULES,
  ];
  if (databases.length > 0) {
    lines.push(
      "",
      "# The SQLite files published beside the code. Their rows are whatever the",
      "# build agent wrote while testing itself; `db/*.schema.sql` is the part",
      "# worth keeping, and it IS committed.",
    );
    for (const file of databases) {
      lines.push(excludeRuleForPath(file), `${excludeRuleForPath(file)}-shm`, `${excludeRuleForPath(file)}-wal`);
    }
  }
  if (filledTemplates.length > 0) {
    lines.push(
      "",
      "# `.env.example` and friends are force-included above BECAUSE they hold",
      "# names and no values. These assign a value, so the exception is taken",
      "# back for them by name: a filled-in example is a .env under another name.",
    );
    for (const file of filledTemplates) lines.push(excludeRuleForPath(file));
  }
  lines.push(EXCLUDE_BLOCK_END, "");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * What may never be in the index
 * ---------------------------------------------------------------------- */

/**
 * Every published path this module refuses to let into a commit.
 *
 * ONE LIST FOR TWO JOBS: it is what {@link handoverExcludeText} spells as
 * gitignore rules, and it is what {@link stageTree} checks the index against
 * afterwards. Keeping it in one place is the point — the rules and the
 * verification drifting apart is how "we exclude X" becomes true of the file
 * nobody reads and false of the commit.
 */
export function forbiddenCommitPaths(directory: string, databases: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const file of databases) {
    out.add(file);
    out.add(`${file}-wal`);
    out.add(`${file}-shm`);
  }
  for (const file of findPublishedEnvFiles(directory)) out.add(file);
  for (const file of findFilledEnvTemplates(directory)) out.add(file);
  return [...out].sort();
}

/**
 * `node_modules` AT ANY DEPTH, collapsed to the directory it lives under.
 *
 * Returned rather than matched so that a withheld dependency tree is reported
 * as one line and not as nine thousand — and so the unstage below can name the
 * directory once with `git rm -r`.
 */
function nodeModulesRoot(path: string): string | null {
  if (path === "node_modules" || path.startsWith("node_modules/")) return "node_modules";
  const at = path.indexOf("/node_modules/");
  if (at !== -1) return path.slice(0, at + "/node_modules".length);
  return path.endsWith("/node_modules") ? path : null;
}

/**
 * What a staged path must be reported and removed AS, or null when it may stay.
 *
 * A dependency tree is matched structurally rather than by list, because
 * {@link walkFiles} never descends into one and so cannot enumerate it.
 */
export function withholdAs(path: string, forbidden: ReadonlySet<string>): string | null {
  if (forbidden.has(path)) return path;
  return nodeModulesRoot(path);
}

type StageOutcome =
  | { readonly ok: true; readonly withheld: readonly string[] }
  | { readonly ok: false; readonly reason: RepositoryDecline; readonly detail: string };

/** `git rm` takes a pathspec list; a bound keeps argv off any platform's limit. */
const MAX_PATHS_PER_REMOVE = 100;

/**
 * Stage everything, then READ THE INDEX BACK and take out what may not be
 * committed.
 *
 * THIS IS THE HALF THAT ACTUALLY HOLDS, and it exists because the exclude file
 * does not outrank the builder's `.gitignore` — see {@link handoverExcludeText}
 * for the measurement. A builder that writes `!app.db` or `!.env` un-ignores a
 * path we named, `git add -A` stages it, and before this check the key went
 * into commit 1. Verifying the index is the negative control the rules alone
 * cannot be: it observes the outcome instead of trusting the mechanism.
 *
 * IT UNSTAGES RATHER THAN DECLINING, deliberately. Declining would cost the
 * owner his entire history because a build agent wrote one negation, while
 * unstaging costs him one file he can still `git add -f` himself in a second —
 * and the file is never deleted from disk. A removal that FAILS does decline,
 * because staged-and-uncommitted is the one state that must not reach `commit`.
 *
 * WHAT IT DOES NOT DO: reach into history. A database committed by an older
 * build of this program stays in that old commit; this untracks it going
 * forward and says so on the record. Removing it from history needs a rewrite,
 * which is not a thing a publish step may do to the owner's repository.
 */
function stageTree(directory: string, git: GitRunner, forbidden: ReadonlySet<string>): StageOutcome {
  // NO PATHSPEC NAMES AN EXCLUDED PATH. See {@link excludedPathspecs}: naming one
  // that the .gitignore in effect also names makes git refuse the whole add.
  const staged = git(directory, ["-c", "core.excludesFile=/dev/null", "add", "-A", "--", "."]);
  if (!staged.ok) return { ok: false, reason: staged.unavailable ? "git-unavailable" : "stage-failed", detail: staged.stderr };

  // `-z` because a filename is data: `--name-only` quotes and escapes a path
  // containing a newline or a non-ASCII byte, and a mangled path compares equal
  // to nothing — the check would pass by failing to recognise the leak.
  const index = git(directory, ["ls-files", "-z"]);
  if (!index.ok) return { ok: false, reason: index.unavailable ? "git-unavailable" : "stage-failed", detail: index.stderr };

  const withheld = new Set<string>();
  for (const path of index.stdout.split("\0")) {
    if (path === "") continue;
    const as = withholdAs(path, forbidden);
    if (as !== null) withheld.add(as);
  }
  if (withheld.size === 0) return { ok: true, withheld: [] };

  const paths = [...withheld].sort();
  for (let i = 0; i < paths.length; i += MAX_PATHS_PER_REMOVE) {
    const batch = paths.slice(i, i + MAX_PATHS_PER_REMOVE);
    // `literal` for the same reason the exclude rules escape: `a[0].db` is a
    // filename, not a character class. `-r` is for the collapsed
    // `node_modules` directory; on a file it does nothing.
    const removed = git(directory, ["rm", "-r", "--cached", "--quiet", "--", ...batch.map((path) => `:(literal)${path}`)]);
    if (!removed.ok) {
      return {
        ok: false,
        reason: removed.unavailable ? "git-unavailable" : "stage-failed",
        detail: `${batch.join(", ")} is staged and must not be committed, and could not be unstaged: ${removed.stderr}`,
      };
    }
  }
  return { ok: true, withheld: paths };
}

/**
 * A published path as a gitignore pattern that matches THAT PATH AND NOTHING
 * ELSE.
 *
 * Anchored with a leading `/` so `app.db` at the root does not also silence
 * `vendor/app.db`, and every character gitignore treats as syntax is escaped:
 * `*?[]\` are wildcards, `!` at the front negates, `#` at the front comments,
 * and a trailing space is dropped unless it is escaped. A backslash escape is
 * how gitignore's own documentation says to spell a literal one.
 *
 * THE WILDCARDS ARE THE MEASURED HALF. With the escaping deleted, a database
 * called `a[0].db` lands in the commit — `/a[0].db` is a character class that
 * matches `a0.db` and not the file itself; a test drives exactly that. `!` and
 * `#` only mean anything at the START of a rule and the leading `/` already
 * displaces them, so escaping those two is belt and braces.
 */
export function excludeRuleForPath(relative: string): string {
  const escaped = relative.replace(/[\\*?[\]!#]/g, (character) => `\\${character}`).replace(/ $/, "\\ ");
  return `/${escaped}`;
}

/** A path git cannot be told about: a gitignore file is one rule per LINE. */
function unrepresentable(paths: readonly string[]): readonly string[] {
  return paths.filter((path) => /[\n\r]/.test(path));
}

interface ExcludeWrite {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Write our rules into the repository's exclude file, KEEPING WHATEVER ELSE IS
 * THERE.
 *
 * The owner may have put his own rules in this file, and git ships it with a
 * comment header; both survive, because our block is delimited and only our
 * block is replaced. Written before every `add` rather than only at init, so a
 * folder published by an older build of this program gets the rules too.
 *
 * A FAILURE HERE STOPS THE COMMIT. Staging without these rules would put the
 * database and the `.env` in the history — the exact defect this replaced — so
 * the caller declines and the copy stays as it is, which is the trade this
 * module makes everywhere else too.
 */
function writeRepositoryExcludes(
  gitDir: string,
  databases: readonly string[],
  filledTemplates: readonly string[],
): ExcludeWrite {
  const impossible = unrepresentable([...databases, ...filledTemplates]);
  if (impossible.length > 0) {
    return {
      ok: false,
      detail:
        `${impossible.join(", ")} — a published database whose name contains a newline cannot be named in ` +
        "a git exclude file, and committing it is not an option, so nothing was staged",
    };
  }
  const path = join(gitDir, HANDOVER_EXCLUDE_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      mergeExcludeText(readIfPresent(path), handoverExcludeText(databases, filledTemplates)),
      "utf8",
    );
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: `${path} could not be written: ${messageOf(error)}` };
  }
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Our block replaces our block; every other line of the file is left alone. */
export function mergeExcludeText(existing: string, block: string): string {
  const lines = existing.split("\n");
  const start = lines.indexOf(EXCLUDE_BLOCK_START);
  const end = lines.indexOf(EXCLUDE_BLOCK_END);
  const kept = start !== -1 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const preserved = kept.join("\n").replace(/\n+$/, "");
  return preserved.trim() === "" ? block : `${preserved}\n${block}`;
}

function commitPublishedTree(request: CommitRequest): RepositoryOutcome {
  const { directory, git } = request;
  const initialised = !existsSync(join(directory, ".git"));
  if (initialised) {
    // `init.defaultBranch` is passed rather than left to the machine's config so
    // the branch name in the record is the one the owner will actually see.
    const init = git(directory, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
    if (!init.ok) {
      return declineRepo(init.unavailable ? "git-unavailable" : "init-failed", init.stderr);
    }
  }
  // NOTHING WRITES INSIDE `.git` UNTIL IT IS KNOWN TO BE OURS, which is why the
  // exclude file is written from the git dir git itself reported and not from
  // `join(directory, ".git")`.
  const owned = ownGitDir(directory, git);
  if (!owned.ok) return owned.outcome;

  const databaseFiles = request.databases.map((database) => database.file);
  const forbidden = forbiddenCommitPaths(directory, databaseFiles);
  const excludes = writeRepositoryExcludes(owned.gitDir, databaseFiles, findFilledEnvTemplates(directory));
  if (!excludes.ok) return declineRepo("stage-failed", excludes.detail);

  const staged = stageTree(directory, git, new Set(forbidden));
  if (!staged.ok) return declineRepo(staged.reason, staged.detail);

  const pending = git(directory, ["diff", "--cached", "--name-only"]);
  if (!pending.ok) return declineRepo(pending.unavailable ? "git-unavailable" : "stage-failed", pending.stderr);
  if (pending.stdout.trim() === "") {
    // NOTHING CHANGED — the idempotent re-publish. Reporting a decline here
    // would make "the second publish did nothing because there was nothing to
    // do" indistinguishable from "the second publish failed".
    const head = headOf(directory, git);
    if (head === null) {
      return declineRepo("nothing-to-commit", "staging produced no change and the repository has no commit");
    }
    return { state: "unchanged", commit: head.commit, branch: head.branch, withheld: staged.withheld };
  }

  const identity = resolveIdentity(directory, git);
  const commit = git(directory, [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    // A machine with commit signing on globally would otherwise block on a
    // passphrase prompt inside a run's terminal path, and hooks belong to
    // whoever configured them, not to a folder this program just created.
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "-m",
    request.message.subject,
    "-m",
    request.message.body,
  ]);
  if (!commit.ok) return declineRepo(commit.unavailable ? "git-unavailable" : "commit-failed", commit.stderr);

  const head = headOf(directory, git);
  if (head === null) return declineRepo("commit-failed", "the commit reported success and HEAD does not resolve");
  const listed = git(directory, ["ls-files"]);
  const files = listed.ok ? listed.stdout.split("\n").filter((line) => line.trim() !== "").length : 0;
  return {
    state: "committed",
    commit: head.commit,
    branch: head.branch,
    files,
    initialised,
    preserved: request.preserved,
    withheld: staged.withheld,
  };
}

function declineRepo(reason: RepositoryDecline, detail: string): RepositoryOutcome {
  return { state: "declined", reason, detail: redactForPersistence(detail.trim()) };
}

/** The git dir when it is this directory's own, or the refusal to use it. */
type OwnGitDir =
  | { readonly ok: true; readonly gitDir: string }
  | { readonly ok: false; readonly outcome: RepositoryOutcome };

/**
 * The repository at `directory`, confirmed to BE `directory/.git`.
 *
 * THE CASE THIS REFUSES, MEASURED: `projects/` sits inside the owner's own
 * repository. A published folder with no `.git` of its own answers every git
 * command from the OWNER'S repository — a `git status` there printed the
 * owner's untracked paths — and `git add -A` stages from the repository ROOT,
 * not from the cwd. Confirming the git dir before the first index command is
 * what makes that impossible rather than unlikely.
 *
 * IT RETURNS THE PATH RATHER THAN A YES, because the exclude file is written
 * INSIDE the git dir and the only address safe to write to is the one git just
 * confirmed — `join(directory, ".git")` is a guess that is wrong for a `.git`
 * file, which is exactly the shape this refuses in the other direction.
 *
 * Both sides are resolved through `realpathSync` because git answers with the
 * PHYSICAL path: on macOS `mkdtemp` hands out `/var/folders/…`, which is a
 * symlink to `/private/var/folders/…`, and a raw string compare fails for every
 * scratch directory in the test suite while passing in production.
 */
function ownGitDir(directory: string, git: GitRunner): OwnGitDir {
  const answer = git(directory, ["rev-parse", "--absolute-git-dir"]);
  if (!answer.ok) {
    return {
      ok: false,
      outcome: declineRepo(answer.unavailable ? "git-unavailable" : "not-our-repository", answer.stderr),
    };
  }
  const reported = answer.stdout.trim();
  const expected = join(directory, ".git");
  if (reported !== expected && realpath(reported) !== realpath(expected)) {
    return {
      ok: false,
      outcome: declineRepo(
        "not-our-repository",
        `git reports the repository for ${directory} is ${reported}, not ${expected}; nothing was staged`,
      ),
    };
  }
  return { ok: true, gitDir: reported };
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

interface Head {
  readonly commit: string;
  readonly branch: string;
}

function headOf(directory: string, git: GitRunner): Head | null {
  const commit = git(directory, ["rev-parse", "HEAD"]);
  if (!commit.ok || commit.stdout.trim() === "") return null;
  const branch = git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { commit: commit.stdout.trim(), branch: branch.ok ? branch.stdout.trim() : "" };
}

/**
 * The machine's own git identity, or a neutral local one.
 *
 * READS EXACTLY TWO CONFIGURATION KEYS, both of which are the point of a commit
 * author and neither of which is a credential. A machine with no identity
 * configured gets {@link FALLBACK_IDENTITY} rather than a failed publish — git
 * would otherwise refuse the commit with "please tell me who you are", which
 * would turn "your project has no history" into "your project has no history
 * and no explanation".
 */
function resolveIdentity(directory: string, git: GitRunner): { name: string; email: string } {
  const name = git(directory, ["config", "--get", "user.name"]);
  const email = git(directory, ["config", "--get", "user.email"]);
  const cleanName = name.ok ? name.stdout.trim() : "";
  const cleanEmail = email.ok ? email.stdout.trim() : "";
  return {
    name: cleanName === "" ? FALLBACK_IDENTITY.name : cleanName,
    email: cleanEmail === "" ? FALLBACK_IDENTITY.email : cleanEmail,
  };
}

/* -------------------------------------------------------------------------
 * What `project-publish.ts` needs to decide whether a folder is still ours
 * ---------------------------------------------------------------------- */

/**
 * The state of a published folder's own repository, before anything is written.
 *
 * `absent`  no `.git` of its own. Either an older publish (this module is newer
 *           than the one project on disk) or a copy nobody has turned into a
 *           repository. Safe to write into and to init.
 * `foreign` there is a repository but it is not this directory's own, or git
 *           could not answer. NEVER written into.
 * `repo`    this directory's own repository. `head` is null before the first
 *           commit; `dirty` is anything `git status --porcelain` reports under
 *           the same exclusions the commit uses — a tracked edit, a deletion, OR
 *           an untracked file, since `--porcelain` lists those too.
 */
export type RepoInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign"; readonly detail: string }
  | { readonly kind: "repo"; readonly head: string | null; readonly dirty: boolean };

export function inspectRepository(directory: string, git: GitRunner = spawnGit): RepoInspection {
  if (!existsSync(join(directory, ".git"))) return { kind: "absent" };
  const owned = ownGitDir(directory, git);
  if (!owned.ok) {
    return {
      kind: "foreign",
      detail: owned.outcome.state === "declined" ? owned.outcome.detail : "the git directory is not ours",
    };
  }
  const head = git(directory, ["rev-parse", "HEAD"]);
  // DIRTINESS IS MEASURED UNDER THE COMMIT'S OWN EXCLUSIONS. A published
  // database or `.env` that the builder's `.gitignore` does not mention is
  // untracked forever; counting it as owner work would send every single
  // re-publish to a new folder and break idempotence outright.
  //
  // The paths are named here — unlike in the staging path — because `git status`
  // does not refuse a pathspec that the .gitignore in effect also names, which
  // `git add` does. Measured; see {@link excludedPathspecs}.
  const status = git(directory, [
    "-c",
    "core.excludesFile=/dev/null",
    "status",
    "--porcelain",
    "--",
    ...excludedPathspecs([...findPublishedDatabases(directory), ...findPublishedEnvFiles(directory)]),
  ]);
  return {
    kind: "repo",
    head: head.ok && head.stdout.trim() !== "" ? head.stdout.trim() : null,
    dirty: status.ok && status.stdout.trim() !== "",
  };
}

/**
 * TRUE ONLY WHEN THERE IS A COMMIT TO OPEN.
 *
 * `existsSync(join(directory, ".git"))` is NOT this question, and the difference
 * is what the owner is told: a `.git` that git init created and that no commit
 * ever landed in — the exact state every SQLite-backed publish reached before
 * the defect above was fixed — is a directory named `.git`, not a repository he
 * can `git log`. A folder inside ANOTHER repository with no `.git` of its own
 * answers false here for the same reason it is never staged into.
 */
export function hasCommittedRepository(directory: string, git: GitRunner = spawnGit): boolean {
  if (!existsSync(join(directory, ".git"))) return false;
  const owned = ownGitDir(directory, git);
  if (!owned.ok) return false;
  const head = git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.ok && head.stdout.trim() !== "";
}

/**
 * Commit whatever the owner has edited but not committed, BEFORE the copy writes
 * over it. Returns the commit, or null with a reason.
 *
 * WHY THIS EXISTS. Re-publishing a run copies the workspace over the published
 * folder by name. A file the owner has committed survives in history; a file he
 * has edited and NOT committed is the one thing git cannot get back, and the
 * copy would silently destroy it. So the last state before the overwrite is
 * saved as its own commit, with the owner's own identity, and the sha is
 * reported so he can find it.
 *
 * IT RUNS BEFORE THE COPY, WHICH MEANS IT CAN RUN FOR A PUBLISH THAT THEN
 * DECLINES. A re-publish of a run whose workspace has since been emptied
 * commits the owner's edits and then declines `workspace-empty`, so the message
 * on this commit names a re-publish that did not happen. That is the right way
 * round — the commit had to be made before it was known whether the copy would
 * find anything, and an extra commit costs nothing while a lost afternoon does.
 */
export function preserveUncommittedWork(
  directory: string,
  git: GitRunner = spawnGit,
): { readonly commit: string | null; readonly detail: string } {
  // SAME STAGING RULE AS THE COMMIT, for the same measured reason: a pathspec
  // naming a path the .gitignore in effect also names makes `git add` exit 1,
  // and this add is the one standing between the owner's uncommitted work and a
  // copy that writes over it. It ran with exclude pathspecs until 2026-08-02 and
  // returned `preserve-failed` for every project carrying a database.
  const owned = ownGitDir(directory, git);
  if (!owned.ok) {
    return {
      commit: null,
      detail: owned.outcome.state === "declined" ? owned.outcome.detail : "the git directory is not ours",
    };
  }
  const databases = findPublishedDatabases(directory);
  const excludes = writeRepositoryExcludes(owned.gitDir, databases, findFilledEnvTemplates(directory));
  if (!excludes.ok) return { commit: null, detail: redactForPersistence(excludes.detail) };
  // THE SAME INDEX VERIFICATION AS THE PUBLISH COMMIT, and for the same reason:
  // this commit lands in the same repository, so a builder negation that
  // un-ignores the `.env` would put the key in HERE instead. What it withholds
  // is not reported on this return — the caller uses it to find a sha, and the
  // invariant it needs is that no commit this module makes carries such a path.
  const staged = stageTree(directory, git, new Set(forbiddenCommitPaths(directory, databases)));
  if (!staged.ok) return { commit: null, detail: redactForPersistence(staged.detail) };
  const identity = resolveIdentity(directory, git);
  const commit = git(directory, [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "-m",
    "Your uncommitted changes, saved before this run was re-published",
    "-m",
    "Made by the dashboard so that re-copying the finished code could not overwrite work that was never committed.",
  ]);
  if (!commit.ok) return { commit: null, detail: redactForPersistence(commit.stderr.trim()) };
  const head = headOf(directory, git);
  return { commit: head?.commit ?? null, detail: "" };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
