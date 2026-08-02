/**
 * project-publish.test.ts — the publish, and the three ways it must refuse.
 *
 * EVERY REFUSAL IS PAIRED WITH A POSITIVE CONTROL, because the failure this
 * repository keeps finding is a check that can only observe success — and its
 * mirror image, a check that can only observe refusal. A `publishProject` that
 * copied NOTHING would satisfy "`.git` is not in the published folder" and every
 * exclusion assertion below; a `publishProject` that copied everything into a
 * fresh folder every time would satisfy "the second run got a different path"
 * while having flattened the first run's work. So:
 *
 *   the exclusion test asserts `index.html` and `assets/logo.svg` ARRIVED,
 *   the collision test asserts the earlier folder's BYTES ARE UNCHANGED,
 *   the decline tests assert the NAMED REASON, not merely that nothing threw.
 *
 * NO DASHBOARD, NO SERVER, NO DATABASE. `publishProject` takes four paths and a
 * title, which is what makes this file able to drive the failure branches at
 * all — `workspace-missing` and `no-free-name` are unreachable from an
 * end-to-end run without breaking the run.
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BAKEOFF_ROOT, resolvePaths, runPathsFor } from "./paths.js";
import { spawnGit } from "./project-handover.js";
import type { GitRunner, PublishRunFacts } from "./project-handover.js";
import {
  MAX_NAME_ATTEMPTS,
  PROJECT_EXCLUDED_ENTRIES,
  PROJECT_PUBLISH_RECORD,
  projectSlug,
  publishProject,
  publishedProjectFromRecord,
  readPublishedProject,
  republishProject,
  runIdSuffix,
} from "./project-publish.js";
import type { PublishRequest } from "./project-publish.js";

const RUN_ID = "run-2026-07-30T20-16-40-242Z-052c6e02";
const TITLE = "Coglane landing page";

/** The marker that proves a real file made it across, not just a directory. */
const SITE_MARKER = "<h1>coglane</h1>";

interface Scratch {
  readonly root: string;
  readonly workspace: string;
  readonly results: string;
  readonly projects: string;
  readonly request: PublishRequest;
  readonly cleanup: () => void;
}

function scratch(runId = RUN_ID, title = TITLE): Scratch {
  const root = mkdtempSync(join(tmpdir(), "dash-publish-"));
  const workspace = join(root, "runs", runId, "workspace");
  const results = join(root, "runs", runId, "results");
  const projects = join(root, "projects");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(results, { recursive: true });
  return {
    root,
    workspace,
    results,
    projects,
    request: { runId, ticketTitle: title, workspace, projectsDir: projects, resultsDir: results },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A workspace shaped like the one real finished run on this machine. */
function fillWorkspace(workspace: string): void {
  writeFileSync(join(workspace, "index.html"), SITE_MARKER, "utf8");
  writeFileSync(join(workspace, "styles.css"), "body{}", "utf8");
  writeFileSync(join(workspace, "TICKET.md"), "the ticket", "utf8");
  mkdirSync(join(workspace, "assets"), { recursive: true });
  writeFileSync(join(workspace, "assets", "logo.svg"), "<svg/>", "utf8");
  for (const rule of PROJECT_EXCLUDED_ENTRIES) {
    mkdirSync(join(workspace, rule.name), { recursive: true });
    writeFileSync(join(workspace, rule.name, "inside.txt"), `must not be published: ${rule.name}`, "utf8");
  }
}

/**
 * Every file under `dir`, relative, forward slashes, sorted — EXCEPT `.git`.
 *
 * The published folder is given its own repository (`project-handover.ts`), and
 * git's internals are several hundred files that say nothing about what was
 * published. What the repository holds is asserted where it belongs, with
 * `git ls-files`, rather than by walking `.git` here.
 */
function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Read a repository, as a person would. Fails loudly rather than returning "". */
function git(cwd: string, args: readonly string[]): string {
  const run = spawnGit(cwd, args);
  assert.equal(run.ok, true, `git ${args.join(" ")} in ${cwd} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/** The identity the tests commit under. Never the machine's, so nothing leaks. */
const AS_OWNER: readonly string[] = ["-c", "user.name=Owner", "-c", "user.email=owner@example.com"];

/**
 * The run's own repository, in the shape `orchestrator.ts` leaves it: ONE empty
 * `workspace created` commit, with the builder's files untracked on top. That
 * commit is the baseline the judge's diff is taken against, so every assertion
 * about it below is an assertion about whether the judge can still read the run.
 */
function makeWorkspaceRepo(workspace: string): void {
  git(workspace, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
  git(workspace, [...AS_OWNER, "commit", "-q", "--allow-empty", "-m", "workspace created"]);
}

const RUN_FACTS: PublishRunFacts = {
  runId: RUN_ID,
  ticketId: "ticket-9f2",
  ticketTitle: TITLE,
  modelId: "claude-opus-4-6",
  status: "passed",
  endedAt: "2026-07-30T21:02:11.000Z",
};

/** A git that cannot be started at all. Every step that needs it must decline. */
const missingGit: GitRunner = () => ({ ok: false, stdout: "", stderr: "spawn git ENOENT", unavailable: true });

/** A real SQLite file with rows in it, the way a finished backend leaves one. */
function makeDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("create table messages (id integer primary key, body text);");
  db.exec("insert into messages (body) values ('written while the agent tested itself');");
  db.close();
}

test("the exclusion list actually excludes — and the site actually arrives", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;

    const published = filesUnder(record.path);
    // POSITIVE CONTROL FIRST. Without these two lines every assertion below is
    // satisfied by a publish that copied nothing at all.
    //
    // `.gitignore` and `README.md` are NOT from the workspace: the handover
    // writes them because this fixture's builder shipped neither. `fileCount`
    // below still counts four, because it counts what was COPIED.
    assert.deepEqual(published, [
      ".gitignore",
      "README.md",
      "TICKET.md",
      "assets/logo.svg",
      "index.html",
      "styles.css",
    ]);
    assert.equal(readFileSync(join(record.path, "index.html"), "utf8"), SITE_MARKER);

    // …and now the refusals. Every excluded name is gone, by name.
    //
    // `.git` IS ASSERTED BY ITS CONTENTS RATHER THAN BY ITS ABSENCE, and the
    // difference is new: the published folder now has a `.git` of its OWN, made
    // by the handover. What must not be there is the WORKSPACE'S — the marker
    // file `fillWorkspace` puts inside each excluded directory is the thing that
    // can only have arrived by being copied.
    for (const rule of PROJECT_EXCLUDED_ENTRIES) {
      assert.equal(existsSync(join(record.path, rule.name, "inside.txt")), false, `${rule.name} was published`);
      if (rule.name !== ".git") {
        assert.equal(existsSync(join(record.path, rule.name)), false, `${rule.name} was published`);
      }
      assert.ok(
        record.excluded.some((entry) => entry.path === rule.name && entry.reason === rule.reason),
        `${rule.name} was dropped without being reported`,
      );
    }
    // The `.git` that IS there is this folder's own, one commit deep.
    assert.equal(git(record.path, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(record.fileCount, 4);
    assert.ok(record.bytes > 0);

    // The workspace is READ ONLY. Nothing was moved out of it.
    assert.equal(existsSync(join(s.workspace, "index.html")), true);
    assert.equal(existsSync(join(s.workspace, ".git")), true);
  } finally {
    s.cleanup();
  }
});

test("an excluded name is excluded AT ANY DEPTH, not only at the workspace root", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // A vendored checkout three levels down: the case a root-only rule ships.
    const nested = join(s.workspace, "assets", "vendor", "widget");
    mkdirSync(join(nested, ".git"), { recursive: true });
    writeFileSync(join(nested, ".git", "config"), "[core]", "utf8");
    writeFileSync(join(nested, "widget.js"), "export {}", "utf8");

    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;
    // Positive control: the sibling file at the same depth DID come across, so
    // this is a name rule and not a depth cut-off.
    assert.equal(existsSync(join(record.path, "assets", "vendor", "widget", "widget.js")), true);
    assert.equal(existsSync(join(record.path, "assets", "vendor", "widget", ".git")), false);
    assert.ok(record.excluded.some((entry) => entry.path === "assets/vendor/widget/.git"));
  } finally {
    s.cleanup();
  }
});

test("a colliding title does NOT overwrite the project that is already there", () => {
  const s = scratch();
  try {
    // Somebody's earlier work, under the exact name this title slugs to.
    const earlier = join(s.projects, projectSlug(TITLE));
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "index.html"), "EARLIER RUN — DO NOT LOSE ME", "utf8");
    writeFileSync(join(earlier, "notes-the-owner-added.md"), "hand-written", "utf8");

    fillWorkspace(s.workspace);
    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;

    // THE ASSERTION THAT MATTERS IS THE BYTES, NOT THE PATH. A publish that
    // clobbered the directory and then reported a different path would pass a
    // `notEqual` on the path alone.
    assert.equal(readFileSync(join(earlier, "index.html"), "utf8"), "EARLIER RUN — DO NOT LOSE ME");
    assert.equal(existsSync(join(earlier, "notes-the-owner-added.md")), true);

    assert.notEqual(record.path, earlier);
    assert.equal(record.path, join(s.projects, `${projectSlug(TITLE)}-${runIdSuffix(RUN_ID)}`));
    // And the new folder really did receive this run's code.
    assert.equal(readFileSync(join(record.path, "index.html"), "utf8"), SITE_MARKER);
  } finally {
    s.cleanup();
  }
});

test("a workspace that does not exist DECLINES with a named reason, and does not throw", () => {
  const s = scratch();
  try {
    rmSync(s.workspace, { recursive: true, force: true });
    const record = publishProject(s.request);
    assert.equal(record.published, false);
    if (record.published) return;
    // The NAME, not merely "it returned something". A decline whose reason was
    // `copy-failed` here would be this module blaming the filesystem for a run
    // that simply never built anything.
    assert.equal(record.reason, "workspace-missing");
    assert.ok(record.detail.includes(s.workspace), "the refusal must name the path it looked at");
    // Nothing was created for a run with nothing to publish.
    assert.equal(existsSync(s.projects), false);
    // …and the refusal is DURABLE: an absent record cannot be told apart from a
    // step that never ran, which is why a decline writes a record too.
    const wire = readPublishedProject(s.results);
    assert.notEqual(wire, null);
    assert.equal(wire?.published, false);
  } finally {
    s.cleanup();
  }
});

test("a workspace holding only scaffolding declines `workspace-empty` and leaves NO empty folder", () => {
  const s = scratch();
  try {
    // The shape of a run cancelled out of the queue, plus a design lane that got
    // as far as writing references and no further.
    mkdirSync(join(s.workspace, "design-refs"), { recursive: true });
    writeFileSync(join(s.workspace, "design-refs", "ref-1.png"), "not a site", "utf8");

    const record = publishProject(s.request);
    assert.equal(record.published, false);
    if (record.published) return;
    assert.equal(record.reason, "workspace-empty");
    // THE POINT OF THE TEST. A folder named after the ticket, containing
    // nothing, is worse than no folder: it reads as "your code is here" and is
    // empty. Both the claimed directory and `projects/` itself must be gone.
    assert.equal(existsSync(s.projects), false);
  } finally {
    s.cleanup();
  }
});

test("`projects/` is left alone when it already holds somebody else's work", () => {
  const s = scratch();
  try {
    // Same empty-workspace decline as above, but this time the directory is not
    // ours to remove. The non-recursive rmdir must fail and be ignored.
    const other = join(s.projects, "another-project");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "index.html"), "someone else's work", "utf8");

    const record = publishProject(s.request);
    assert.equal(record.published, false);
    assert.equal(readFileSync(join(other, "index.html"), "utf8"), "someone else's work");
    assert.deepEqual(readdirSync(s.projects), ["another-project"]);
  } finally {
    s.cleanup();
  }
});

test("a ticket title that is a path traversal cannot escape `projects/`", () => {
  const s = scratch(RUN_ID, "../../etc/passwd");
  try {
    fillWorkspace(s.workspace);
    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;
    // The slug keeps `[a-z0-9-]` only, so the dots and separators are gone
    // before a path is ever built.
    assert.equal(projectSlug("../../etc/passwd"), "etc-passwd");
    assert.equal(record.path, join(s.projects, "etc-passwd"));
    assert.deepEqual(readdirSync(s.projects), ["etc-passwd"]);
    // Nothing landed beside the scratch root.
    assert.equal(existsSync(join(s.root, "passwd")), false);
  } finally {
    s.cleanup();
  }
});

test("a title that reduces to nothing gets a name a person can still open", () => {
  assert.equal(projectSlug("..."), "untitled-project");
  assert.equal(projectSlug("   "), "untitled-project");
  assert.equal(projectSlug("🚀🚀🚀"), "untitled-project");
  assert.equal(projectSlug("Make a COPY of kamilborzecki.dev"), "make-a-copy-of-kamilborzecki-dev");
  // Capped, and never left ending in a dash by the cut.
  const long = projectSlug("a".repeat(200));
  assert.equal(long.length, 60);
  assert.equal(projectSlug(`${"b".repeat(59)} tail`), "b".repeat(59));
});

test("symlinks are NOT followed, and the drop is reported", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const outside = join(s.root, "outside-the-workspace");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "must not be copied", "utf8");
    symlinkSync(outside, join(s.workspace, "escape"));
    symlinkSync(join(s.workspace, "index.html"), join(s.workspace, "alias.html"));

    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;
    assert.equal(existsSync(join(record.path, "escape")), false);
    assert.equal(existsSync(join(record.path, "alias.html")), false);
    // Reported, not silently dropped — a folder that is quietly missing a file
    // is indistinguishable from a copy that failed halfway.
    for (const name of ["escape", "alias.html"]) {
      assert.ok(
        record.excluded.some((entry) => entry.path === name && entry.reason.startsWith("symbolic link")),
        `${name} was dropped without being reported`,
      );
    }
    // Positive control: the real files still came across.
    assert.equal(readFileSync(join(record.path, "index.html"), "utf8"), SITE_MARKER);
  } finally {
    s.cleanup();
  }
});

test("re-publishing the SAME run reuses its own folder instead of minting a second one", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const first = publishProject(s.request);
    assert.equal(first.published, true);
    if (!first.published) return;

    writeFileSync(join(s.workspace, "index.html"), "<h1>rebuilt</h1>", "utf8");
    const second = publishProject(s.request);
    assert.equal(second.published, true);
    if (!second.published) return;

    assert.equal(second.path, first.path);
    assert.deepEqual(readdirSync(s.projects), [projectSlug(TITLE)]);
    assert.equal(readFileSync(join(second.path, "index.html"), "utf8"), "<h1>rebuilt</h1>");
  } finally {
    s.cleanup();
  }
});

test("a record naming a DIFFERENT run does not hand this run somebody else's folder", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // The shape of the bug this guards: a results directory carrying a record
    // from another run — a copied fixture, a re-used id — must not make this run
    // write into that run's published folder.
    const foreign = join(s.projects, "foreign-project");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "index.html"), "FOREIGN", "utf8");
    writeFileSync(
      join(s.results, PROJECT_PUBLISH_RECORD),
      JSON.stringify({ published: true, runId: "run-somebody-else", path: foreign, fileCount: 1, bytes: 7 }),
      "utf8",
    );

    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;
    assert.notEqual(record.path, foreign);
    assert.equal(readFileSync(join(foreign, "index.html"), "utf8"), "FOREIGN");
  } finally {
    s.cleanup();
  }
});

test("running out of folder names is a NAMED refusal, not an overwrite and not a loop", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const slug = projectSlug(TITLE);
    const suffix = runIdSuffix(RUN_ID);
    // Every candidate the generator will offer, taken, each with a file in it.
    mkdirSync(join(s.projects, slug), { recursive: true });
    writeFileSync(join(s.projects, slug, "keep.txt"), "taken", "utf8");
    mkdirSync(join(s.projects, `${slug}-${suffix}`), { recursive: true });
    for (let n = 2; n <= MAX_NAME_ATTEMPTS; n += 1) {
      mkdirSync(join(s.projects, `${slug}-${suffix}-${String(n)}`), { recursive: true });
    }

    const record = publishProject(s.request);
    assert.equal(record.published, false);
    if (record.published) return;
    assert.equal(record.reason, "no-free-name");
    // Nothing was written into any of them.
    assert.equal(readFileSync(join(s.projects, slug, "keep.txt"), "utf8"), "taken");
    assert.deepEqual(readdirSync(join(s.projects, `${slug}-${suffix}`)), []);
  } finally {
    s.cleanup();
  }
});

test("the record round-trips onto the wire, and anything else is null", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const record = publishProject(s.request);
    assert.equal(record.published, true);
    if (!record.published) return;

    const wire = readPublishedProject(s.results);
    assert.notEqual(wire, null);
    assert.equal(wire?.published, true);
    if (wire === null || !wire.published) return;
    assert.equal(wire.path, record.path);
    assert.equal(wire.fileCount, record.fileCount);
    assert.equal(wire.excluded.length, record.excluded.length);
    // `source` and `runId` are on the record and NOT on the wire. If that ever
    // changes, the client's mirror has to change with it.
    assert.deepEqual(Object.keys(wire).sort(), ["bytes", "excluded", "fileCount", "path", "published", "publishedAt"]);
  } finally {
    s.cleanup();
  }
});

test("a corrupt or foreign record reads as `null` rather than as a published project", () => {
  // The negative control for the reader. Each of these once had a plausible
  // failure mode where a cast would have produced `path: undefined` on a field
  // the client's type says is a string.
  assert.equal(publishedProjectFromRecord("{}"), null);
  assert.equal(publishedProjectFromRecord("[]"), null);
  assert.equal(publishedProjectFromRecord('{"published":true}'), null);
  assert.equal(publishedProjectFromRecord('{"published":true,"path":""}'), null);
  assert.equal(publishedProjectFromRecord('{"published":true,"path":"/x","publishedAt":"t","fileCount":"2"}'), null);
  assert.equal(publishedProjectFromRecord('{"published":false,"reason":"x"}'), null);
  assert.throws(() => publishedProjectFromRecord("not json at all"));

  // …and the positive control, so the six nulls above are not the only outcome
  // this function can produce.
  const ok = publishedProjectFromRecord(
    '{"published":true,"path":"/p","publishedAt":"t","fileCount":2,"bytes":9,"excluded":[{"path":".git","reason":"r"},{"nope":1}]}',
  );
  assert.equal(ok?.published, true);
  if (ok === null || !ok.published) return;
  // The malformed exclusion entry is dropped; the well-formed one survives.
  assert.deepEqual(ok.excluded, [{ path: ".git", reason: "r" }]);
});

/* -------------------------------------------------------------------------
 * WHERE `projects/` IS — the one dashboard directory outside `DASHBOARD_HOME`
 *
 * Tested here rather than in a paths test of its own because the failure it
 * guards is this module's: a `projects` that ignored its override would make
 * every test in this package publish into the system temp root, and one that
 * ignored `DASHBOARD_HOME` would make them publish into the owner's real
 * repository, where the folders would look exactly like his.
 * ---------------------------------------------------------------------- */

test("`projects` is the SIBLING of home, is overridable, and is inside the bake-off fence", () => {
  const home = join(tmpdir(), "some-home", "dashboard");
  assert.equal(resolvePaths({ DASHBOARD_HOME: home }).projects, join(tmpdir(), "some-home", "projects"));

  // The DEFAULT is stated as a relationship rather than a literal, so this stays
  // true whether it is read from `src/` or from a per-agent `dist-*/`.
  const fromDefault = resolvePaths({});
  assert.equal(fromDefault.projects, join(dirname(fromDefault.home), "projects"));

  const overridden = resolvePaths({ DASHBOARD_HOME: home, DASHBOARD_PROJECTS_DIR: join(tmpdir(), "elsewhere") });
  assert.equal(overridden.projects, join(tmpdir(), "elsewhere"));

  // THE NEGATIVE CONTROL. `projects` is derived from home's PARENT, so it is the
  // one path that can land inside the bake-off tree while every other one is
  // outside it. A publish under `bakeoff/` is what the fence exists to stop.
  assert.throws(
    () => resolvePaths({ DASHBOARD_HOME: home, DASHBOARD_PROJECTS_DIR: join(BAKEOFF_ROOT, "results", "projects") }),
    /inside the bake-off tree/,
  );
});

test("an unreadable results directory loses the RECORD, not the copy", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // A results directory that cannot be written: the record write is swallowed
    // on purpose, and this is the test that says what that costs — the wire
    // field is null while the folder exists on disk.
    const request: PublishRequest = { ...s.request, resultsDir: join(s.workspace, "index.html", "not-a-dir") };
    const record = publishProject(request);
    assert.equal(record.published, true);
    if (!record.published) return;
    assert.equal(existsSync(join(record.path, "index.html")), true);
    assert.equal(readPublishedProject(request.resultsDir), null);
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE HANDOVER — the published folder is a repository the owner can work in
 *
 * The trap these tests exist to hold shut: the run's own repository must not be
 * committed to. `runs/<id>/workspace/.git` holds a single `workspace created`
 * commit, and `orchestrator.ts:3974` diffs the working tree against it to build
 * the JUDGE'S READING MATERIAL. A publish that committed there would empty that
 * diff and the judge would score a run that appears to have changed nothing.
 * ---------------------------------------------------------------------- */

test("the published folder gets ITS OWN repository, and the run's baseline commit is untouched", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    makeWorkspaceRepo(s.workspace);
    const baseline = git(s.workspace, ["rev-parse", "HEAD"]);
    const judgeMaterial = git(s.workspace, ["status", "--porcelain"]);
    assert.ok(judgeMaterial.includes("index.html"), "the fixture is wrong: nothing for the judge to read");

    const record = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(record.published, true);
    if (!record.published) return;

    // The published copy is a repository with exactly one commit, naming the
    // ticket and the run.
    assert.equal(record.handover.repository.state, "committed", JSON.stringify(record.handover.repository));
    if (record.handover.repository.state !== "committed") return;
    assert.equal(record.handover.repository.initialised, true);
    assert.equal(git(record.path, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(record.path, ["log", "-1", "--format=%s"]), TITLE);
    assert.ok(git(record.path, ["log", "-1", "--format=%b"]).includes(RUN_ID));
    assert.deepEqual(git(record.path, ["ls-files"]).split("\n").sort(), [
      ".gitignore",
      "README.md",
      "TICKET.md",
      "assets/logo.svg",
      "index.html",
      "styles.css",
    ]);

    // THE TRAP, ASSERTED. Same baseline commit, same untracked-file list: the
    // diff the judge reads is exactly what it was before the publish ran.
    assert.equal(git(s.workspace, ["rev-parse", "HEAD"]), baseline);
    assert.equal(git(s.workspace, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(s.workspace, ["status", "--porcelain"]), judgeMaterial);
    assert.equal(git(s.workspace, ["diff", "--cached", "--name-only"]), "");
  } finally {
    s.cleanup();
  }
});

test("a workspace with a database, node_modules and a .env publishes a repository with none of them in it", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // THE SHAPE ON THE OWNER'S CRITICAL PATH: a SQLite-backed site whose builder
    // shipped his own `.gitignore` naming the very things the commit excludes.
    // Measured against the built dist before this test existed: the publish
    // produced a folder with an EMPTY `.git` and
    // `repository: {state:"declined", reason:"stage-failed"}` — no commit at all.
    writeFileSync(join(s.workspace, ".gitignore"), "node_modules/\n*.db\n", "utf8");
    makeDatabase(join(s.workspace, "app.db"));
    mkdirSync(join(s.workspace, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(s.workspace, "node_modules", "left-pad", "index.js"), "module.exports = 1;", "utf8");
    writeFileSync(join(s.workspace, ".env"), "API_KEY=not-a-real-key-0000\n", "utf8");

    const record = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(record.published, true);
    if (!record.published) return;
    assert.equal(record.handover.repository.state, "committed", JSON.stringify(record.handover.repository));

    // THE COMMIT, EXACTLY. The site, the ticket, the README and the schema dump
    // are in it; the database, the dependency tree and the key are not.
    assert.deepEqual(git(record.path, ["ls-files"]).split("\n").sort(), [
      ".gitignore",
      "README.md",
      "TICKET.md",
      "assets/logo.svg",
      "db/schema.sql",
      "index.html",
      "styles.css",
    ]);
    assert.equal(git(record.path, ["rev-list", "--count", "HEAD"]), "1");
    // …and all three are still ON DISK, which is what "published" means.
    assert.equal(existsSync(join(record.path, "app.db")), true);
    assert.equal(existsSync(join(record.path, "node_modules", "left-pad", "index.js")), true);
    assert.ok(readFileSync(join(record.path, ".env"), "utf8").includes("not-a-real-key-0000"));
    // The secret is not readable out of the history the owner is told to push.
    assert.equal(spawnGit(record.path, ["show", "HEAD:.env"]).ok, false);
  } finally {
    s.cleanup();
  }
});

test("re-publishing an unchanged run reuses the folder and makes NO second commit", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // A published database whose `.gitignore` — the BUILDER'S — does not mention
    // it. Measured hazard: an untracked file makes `git status` non-empty
    // forever, so a re-publish rule that keyed on "is the tree clean" would mint
    // a new folder on every single call and idempotence would be gone.
    writeFileSync(join(s.workspace, ".gitignore"), "# the builder's rules\ntmp/\n", "utf8");
    makeDatabase(join(s.workspace, "app.db"));

    const first = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(first.published, true);
    if (!first.published) return;
    assert.equal(first.handover.repository.state, "committed");
    if (first.handover.repository.state !== "committed") return;

    const second = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(second.published, true);
    if (!second.published) return;

    assert.equal(second.path, first.path, "the second publish minted a new folder");
    assert.equal(second.redirected, null);
    assert.deepEqual(readdirSync(s.projects), [projectSlug(TITLE)]);
    assert.equal(second.handover.repository.state, "unchanged", JSON.stringify(second.handover.repository));
    if (second.handover.repository.state !== "unchanged") return;
    assert.equal(second.handover.repository.commit, first.handover.repository.commit);
    assert.equal(git(first.path, ["rev-list", "--count", "HEAD"]), "1");
    // The database is on disk and out of the history, both times.
    assert.equal(existsSync(join(first.path, "app.db")), true);
    assert.equal(git(first.path, ["ls-files"]).includes("app.db"), false);

    // POSITIVE CONTROL: a rebuilt workspace still produces a real second commit,
    // so `unchanged` is a measurement rather than this path's only answer.
    writeFileSync(join(s.workspace, "index.html"), "<h1>rebuilt</h1>", "utf8");
    const third = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(third.published, true);
    if (!third.published) return;
    assert.equal(third.path, first.path);
    assert.equal(third.handover.repository.state, "committed");
    assert.equal(git(first.path, ["rev-list", "--count", "HEAD"]), "2");
    assert.equal(readFileSync(join(first.path, "index.html"), "utf8"), "<h1>rebuilt</h1>");
  } finally {
    s.cleanup();
  }
});

test("a folder the owner has COMMITTED to is never written over — the re-publish goes beside it", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const first = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(first.published, true);
    if (!first.published) return;

    // The owner opens his project and works on it. This is the whole point of
    // handing him a repository, and it must not be punished by a re-publish.
    writeFileSync(join(first.path, "index.html"), "<h1>MINE NOW</h1>", "utf8");
    writeFileSync(join(first.path, "notes.md"), "my notes", "utf8");
    git(first.path, [...AS_OWNER, "add", "-A"]);
    git(first.path, [...AS_OWNER, "commit", "-q", "-m", "my own work"]);
    const ownerHead = git(first.path, ["rev-parse", "HEAD"]);

    const second = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(second.published, true);
    if (!second.published) return;

    // HIS FOLDER IS BYTE-FOR-BYTE WHERE HE LEFT IT.
    assert.equal(readFileSync(join(first.path, "index.html"), "utf8"), "<h1>MINE NOW</h1>");
    assert.equal(readFileSync(join(first.path, "notes.md"), "utf8"), "my notes");
    assert.equal(git(first.path, ["rev-parse", "HEAD"]), ownerHead);
    assert.equal(git(first.path, ["rev-list", "--count", "HEAD"]), "2");

    // …and the re-publish landed beside it, under the run-id name, and SAYS SO.
    assert.equal(second.path, join(s.projects, `${projectSlug(TITLE)}-${runIdSuffix(RUN_ID)}`));
    assert.equal(second.redirected?.reason, "owner-commits");
    assert.equal(second.redirected?.from, first.path);
    assert.ok(second.redirected?.detail.includes(ownerHead), second.redirected?.detail);
    assert.equal(readFileSync(join(second.path, "index.html"), "utf8"), SITE_MARKER);
    assert.equal(git(second.path, ["rev-list", "--count", "HEAD"]), "1");
  } finally {
    s.cleanup();
  }
});

test("an UNCOMMITTED owner edit is committed before the copy writes over it", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // THE FIXTURE CARRIES A DATABASE AND A BUILDER `.gitignore` THAT NAMES IT.
    // Without those two lines this test could not see the defect it now guards:
    // `preserveUncommittedWork` staged with exclude pathspecs, which git refuses
    // when the .gitignore in effect names the same path, so the preserving
    // commit failed and the re-publish redirected to a NEW folder — the owner's
    // half-finished edit left behind in the old one, exactly the loss the
    // preserving commit exists to prevent.
    writeFileSync(join(s.workspace, ".gitignore"), "*.db\nnode_modules/\n", "utf8");
    makeDatabase(join(s.workspace, "app.db"));
    const first = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(first.published, true);
    if (!first.published) return;

    // Edited and not committed: the one state git cannot get back on its own.
    writeFileSync(join(first.path, "index.html"), "<h1>half an afternoon of work</h1>", "utf8");

    writeFileSync(join(s.workspace, "index.html"), "<h1>rebuilt by the run</h1>", "utf8");
    const second = publishProject({ ...s.request, run: RUN_FACTS });
    assert.equal(second.published, true);
    if (!second.published) return;

    // Same folder — an uncommitted edit is not a reason to abandon it.
    assert.equal(second.path, first.path);
    assert.equal(second.redirected, null);
    assert.equal(second.handover.repository.state, "committed");
    if (second.handover.repository.state !== "committed") return;
    const preserved = second.handover.repository.preserved;
    assert.ok(preserved !== null && /^[0-9a-f]{40}$/.test(preserved), `no preserving commit: ${String(preserved)}`);

    // HIS WORK IS RECOVERABLE, BY SHA, FROM THE RECORD.
    assert.equal(git(first.path, ["show", `${preserved}:index.html`]), "<h1>half an afternoon of work</h1>");
    // …and the working copy is the run's newest code, which is what he asked for.
    assert.equal(readFileSync(join(first.path, "index.html"), "utf8"), "<h1>rebuilt by the run</h1>");
    assert.equal(git(first.path, ["rev-list", "--count", "HEAD"]), "3");
  } finally {
    s.cleanup();
  }
});

test("a git that cannot run at all still leaves a published folder with the code in it", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    const record = publishProject({ ...s.request, run: RUN_FACTS, git: missingGit });

    // THE PROPERTY THAT MATTERS: the publish is a publish. `publishProject`
    // cannot fail a run, and every new step it grew has to keep that true —
    // `orchestrator.ts#finish` has already written the terminal status by the
    // time this returns, and a throw here would turn a passed run into a
    // harness fault.
    assert.equal(record.published, true);
    if (!record.published) return;
    assert.equal(readFileSync(join(record.path, "index.html"), "utf8"), SITE_MARKER);
    assert.equal(record.fileCount, 4);
    assert.equal(existsSync(join(record.path, ".git")), false);

    // The failure is NAMED, on the record and on disk.
    assert.equal(record.handover.repository.state, "declined");
    if (record.handover.repository.state !== "declined") return;
    assert.equal(record.handover.repository.reason, "git-unavailable");
    assert.ok(record.handover.repository.detail.includes("ENOENT"));
    // …and the rest of the handover happened anyway.
    assert.equal(record.handover.readme.state, "written");
    assert.equal(record.handover.gitignore.state, "written");
    assert.equal(existsSync(join(record.path, "README.md")), true);

    // The wire still says published, because the code IS published.
    assert.equal(readPublishedProject(s.results)?.published, true);
  } finally {
    s.cleanup();
  }
});

test("a handover that THROWS still leaves the run published, under its own name", () => {
  const s = scratch();
  try {
    fillWorkspace(s.workspace);
    // `handoverProject`'s contract is that it never throws. This is the belt for
    // the day an edit breaks that contract: a runner that throws rather than
    // returning a failure is the only way to reach it from outside, and without
    // this test the wrapper in `publishProject` is a guard nobody has run.
    const explodingGit: GitRunner = () => {
      throw new Error("the runner exploded");
    };
    const record = publishProject({ ...s.request, run: RUN_FACTS, git: explodingGit });

    assert.equal(record.published, true);
    if (!record.published) return;
    assert.equal(readFileSync(join(record.path, "index.html"), "utf8"), SITE_MARKER);
    assert.equal(record.handover.repository.state, "declined");
    if (record.handover.repository.state !== "declined") return;
    // NAMED SEPARATELY FROM A GIT FAILURE. "the handover threw" and "git is not
    // installed" have different fixes, and one reason for both would hide it.
    assert.equal(record.handover.repository.reason, "handover-crashed");
    assert.ok(record.handover.repository.detail.includes("the runner exploded"));
    assert.equal(readPublishedProject(s.results)?.published, true);
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * `republishProject` — the seam a route hangs off
 *
 * Without it the handover only ever helps the NEXT run: `publishProject` fires
 * at terminal state, and every run on this machine is already terminal.
 * ---------------------------------------------------------------------- */

test("`republishProject` refuses a run that is still going, and publishes one that has finished", () => {
  const root = mkdtempSync(join(tmpdir(), "dash-republish-"));
  try {
    const paths = resolvePaths({ DASHBOARD_HOME: join(root, "dashboard") });
    const runPaths = runPathsFor(paths, RUN_ID);
    mkdirSync(runPaths.workspace, { recursive: true });
    mkdirSync(runPaths.results, { recursive: true });
    fillWorkspace(runPaths.workspace);

    for (const status of ["queued", "running", "awaiting_input", "rate_limited"] as const) {
      const refused = republishProject({ paths, run: { ...RUN_FACTS, status } });
      assert.equal(refused.published, false, `${status} was published`);
      if (refused.published) return;
      assert.equal(refused.reason, "run-not-terminal");
      assert.ok(refused.detail.includes(status), refused.detail);
    }
    // Nothing was created, and — the part that would be a real defect — the
    // refusal did NOT write a record over the one the run will write when it
    // finishes.
    assert.equal(existsSync(paths.projects), false);
    assert.equal(readPublishedProject(runPaths.results), null);

    // …and a terminal run publishes, with the whole handover.
    const record = republishProject({ paths, run: RUN_FACTS });
    assert.equal(record.published, true);
    if (!record.published) return;
    assert.equal(record.path, join(paths.projects, projectSlug(TITLE)));
    assert.equal(readFileSync(join(record.path, "index.html"), "utf8"), SITE_MARKER);
    assert.equal(record.handover.repository.state, "committed");
    assert.ok(readFileSync(join(record.path, "README.md"), "utf8").includes(RUN_ID));

    // SAFE TO CALL TWICE. The button the UI will put on this can be pressed
    // twice, and the second press must not mint a folder or a commit.
    const again = republishProject({ paths, run: RUN_FACTS });
    assert.equal(again.published, true);
    if (!again.published) return;
    assert.equal(again.path, record.path);
    assert.equal(again.handover.repository.state, "unchanged");
    assert.deepEqual(readdirSync(paths.projects), [projectSlug(TITLE)]);
    assert.equal(git(record.path, ["rev-list", "--count", "HEAD"]), "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
