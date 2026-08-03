/**
 * project-handover.test.ts — the published folder becomes workable, or says why.
 *
 * WHAT THESE TESTS ARE GUARDING AGAINST, STATED SO THE ASSERTIONS CAN BE READ
 * AGAINST IT: every step here is a step that can silently do nothing. A schema
 * dump that writes an empty file, an environment table assembled from a
 * dependency tree, a README that overwrites the builder's, a commit that stages
 * the OWNER'S repository because the published folder sits inside it. Each of
 * those passes a "did it throw?" test. So every test below asserts CONTENT — the
 * bytes of `db/schema.sql`, the exact output of `git ls-files`, the sha at the
 * parent repository's HEAD before and after.
 *
 * REAL GIT RUNS IN THE TESTS THAT ASSERT HISTORY (2.50.1 on this machine). The
 * injected runner is used only where the point is a failure git will not perform
 * on demand — an uninstalled binary, an identity-less machine — because a git
 * path exercised solely by a fake is a git path nobody has run.
 *
 * ============================================================================
 * MUTATIONS RUN 2026-08-02, WATCHED FAIL, AND RESTORED — INCLUDING THE MISSES
 * ============================================================================
 *
 * S1  `stageTree`'s index verification short-circuited, so `add -A` is the last
 *     word again. 8 RED / 31 green.
 *     RED: the two `.gitignore`-negation tests, the filled-`.env.example` test,
 *     and the shapes `none at all`, `!app.db`, `!.env`, `!.env.example`,
 *     `nested negation`.
 *     STILL GREEN, AND THIS IS THE HONEST PART: the shapes `tmp/`, `*.db`,
 *     `node_modules/ + dist/`, the double-star `.sqlite3` glob and `no trailing
 *     newline`, plus
 *     every pre-2026-08-02 test in this file including "a builder-supplied .env
 *     is on disk and NEVER in the commit". None of them contains a negation, so
 *     `$GIT_DIR/info/exclude` alone still holds for them — correctly. They are
 *     blind to S1 BY CONSTRUCTION, which is why the table exists: no single
 *     fixture shape can see both mechanisms.
 * S2  a filled `.env.example` no longer treated as a secret (dropped from
 *     `forbiddenCommitPaths` AND from the exclude file's re-exclusion).
 *     10 RED — every shape in the table plus the dedicated test. Worth reading
 *     twice: the `tmp/` shape goes red here, and `tmp/` is the fixture that hid
 *     the original staging defect. The leak arrives through the negation in
 *     `HANDOVER_EXCLUDE_RULES` ITSELF (`!.env.example`, last-match-wins inside
 *     `info/exclude`) and, when the builder shipped no `.gitignore`, through the
 *     one this module writes — so the module defeated its own exclusion without
 *     any builder involvement at all.
 * S3  `schemaBasename` reverted to the basename form and `schemaPathsFor`
 *     unwired from `dumpDatabases`. RED: "databases whose names collide…" at
 *     `two databases share a schema file: db/app.schema.sql db/app.schema.sql
 *     db/my-app.schema.sql db/my-app.schema.sql db/my_app.schema.sql` — three
 *     unique paths for five databases.
 * S5  the `unchanged` outcome hard-coded to `withheld: []`. RED: "a re-publish
 *     keeps withholding the negated database". Without it that arm's field
 *     would be a documented state nothing ever produces.
 * S6  `preserveUncommittedWork` put back to a bare `git add -A` with no index
 *     verification. RED: "the PRESERVE commit refuses a negated `.env` too" at
 *     `the key is in the preserve commit: .env .gitignore README.md index.html`.
 *     That commit is made BEFORE the copy on a re-publish and lands in the same
 *     repository, so it was a second, separate way for the key to reach history.
 * S4  `redactStartScript` not applied (the pre-fix state). RED: "a start script
 *     carrying an inline assignment…" quoting the README line verbatim,
 *     `` `package.json` defines `start`: `API_KEY=sk-…-notarealkey0123456789
 *     DB_PASSWORD=hunter2 node server.mjs --port=3000`. ``
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  FALLBACK_IDENTITY,
  HANDOVER_EXCLUDE_FILE,
  HANDOVER_GITIGNORE_TEXT,
  discoverStartCommand,
  handoverProject,
  hasCommittedRepository,
  preserveUncommittedWork,
  renderReadme,
  scanEnvVars,
  schemaPathsFor,
  spawnGit,
} from "./project-handover.js";
import type { GitResult, GitRunner, HandoverRequest, PublishRunFacts } from "./project-handover.js";

const RUN: PublishRunFacts = {
  runId: "run-2026-07-30T20-16-40-242Z-052c6e02",
  ticketId: "ticket-9f2",
  ticketTitle: "Coglane landing page",
  modelId: "claude-opus-4-6",
  status: "passed",
  endedAt: "2026-07-30T21:02:11.000Z",
};

const WORKSPACE = "/tmp/dashboard/runs/run-x/workspace";

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dash-handover-"));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function request(directory: string, overrides: Partial<HandoverRequest> = {}): HandoverRequest {
  return {
    directory,
    run: RUN,
    workspace: WORKSPACE,
    publishedAt: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

/** A git that cannot be started — the shape of a machine with no git installed. */
const missingGit: GitRunner = () => ({ ok: false, stdout: "", stderr: "spawn git ENOENT", unavailable: true });

/** Real git, isolated from the machine's own config. */
function isolatedGit(homeDir: string): GitRunner {
  return (cwd, args): GitResult => {
    const run = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: homeDir,
        GIT_CONFIG_GLOBAL: join(homeDir, "gitconfig-that-does-not-exist"),
        GIT_CONFIG_SYSTEM: join(homeDir, "gitconfig-that-does-not-exist"),
      },
    });
    if (run.error !== undefined) return { ok: false, stdout: "", stderr: run.error.message, unavailable: true };
    return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "", unavailable: false };
  };
}

/** Read something back out of a repository, as a person would. */
function git(cwd: string, args: readonly string[]): string {
  const run = spawnGit(cwd, args);
  assert.equal(run.ok, true, `git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function makeDatabase(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "create table messages (id integer primary key, body text not null, sent_at text);" +
      "create table subscribers (id integer primary key, email text unique);" +
      "create index messages_sent on messages(sent_at);" +
      "create view recent as select id from messages;",
  );
  db.exec("insert into messages (body, sent_at) values ('hello','2026-08-01'), ('again','2026-08-02');");
  db.exec("insert into subscribers (email) values ('a@example.com');");
  db.close();
}

/* -------------------------------------------------------------------------
 * The database — the owner's actual complaint
 * ---------------------------------------------------------------------- */

test("a published database is dumped to a schema a person can read, with its row counts", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));

    const record = handoverProject(request(s.dir, { git: missingGit }));

    assert.equal(record.databases.length, 1);
    const database = record.databases[0];
    assert.ok(database !== undefined);
    assert.equal(database.dumped, true, "the database was not dumped");
    if (!database.dumped) return;
    assert.equal(database.file, "app.db");
    assert.ok(database.bytes > 0);
    assert.equal(database.schemaPath, "db/schema.sql");

    // THE POSITIVE CONTROL IS THE TEXT. A dump that wrote an empty file, or one
    // that wrote only a header, satisfies "schema.sql exists".
    const sql = readFileSync(join(s.dir, "db", "schema.sql"), "utf8");
    assert.ok(sql.includes("CREATE TABLE messages"), sql);
    assert.ok(sql.includes("CREATE TABLE subscribers"), sql);
    assert.ok(sql.includes("CREATE INDEX messages_sent"), sql);
    assert.ok(sql.includes("CREATE VIEW recent"), sql);
    // Every statement is terminated, so the file runs against an empty database.
    assert.equal(sql.match(/;/g)?.length, 4);
    // SQLite's own bookkeeping is NOT re-created by hand.
    assert.equal(sql.includes("sqlite_"), false, sql);

    // The row counts, which are the part that says whose data this is.
    assert.deepEqual([...database.tables], [
      { name: "messages", rows: 2 },
      { name: "subscribers", rows: 1 },
    ]);
    assert.ok(sql.includes("messages: 2 rows"), sql);
    assert.ok(sql.includes("subscribers: 1 rows"), sql);

    // THE DATABASE ITSELF IS NEITHER DELETED NOR EMPTIED. That is the owner's call.
    const still = new DatabaseSync(join(s.dir, "app.db"), { readOnly: true });
    assert.equal(still.prepare("select count(*) as c from messages").get()?.["c"], 2);
    still.close();
  } finally {
    s.cleanup();
  }
});

test("a `.db` that is not a database is a NAMED refusal and leaves no half-written dump", () => {
  const s = scratch();
  try {
    makeDatabase(join(s.dir, "good.db"));
    writeFileSync(join(s.dir, "broken.db"), "this is not a database, it is a text file", "utf8");

    const record = handoverProject(request(s.dir, { git: missingGit }));

    const broken = record.databases.find((entry) => entry.file === "broken.db");
    assert.ok(broken !== undefined);
    assert.equal(broken.dumped, false);
    if (broken.dumped) return;
    assert.equal(broken.reason, "not-sqlite");
    assert.ok(broken.detail.length > 0, "a refusal with no reason is not a refusal");
    assert.equal(existsSync(join(s.dir, "db", "broken.schema.sql")), false);

    // POSITIVE CONTROL: the good database beside it was still dumped, so the
    // refusal is per-file and not "the dump gave up".
    const good = record.databases.find((entry) => entry.file === "good.db");
    assert.equal(good?.dumped, true);
    // Two databases means neither can be `db/schema.sql` — one schema per file.
    assert.ok(readFileSync(join(s.dir, "db", "good.schema.sql"), "utf8").includes("CREATE TABLE messages"));
    assert.equal(existsSync(join(s.dir, "db", "schema.sql")), false);
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * TWO DATABASES, ONE SCHEMA FILE
 *
 * The dump was named from the file's BASENAME, lower-cased with runs of
 * non-alphanumerics collapsed to `-`. `my-app.db`, `my_app.db` and `my app.db`
 * therefore all reduced to `my-app`, and `app.db` beside `data/app.db` both
 * reduced to `app`: the second write overwrote the first, and both entries in
 * the record said `dumped: true` against the same `schemaPath`.
 *
 * A CASE-ONLY COLLISION (`App.db` vs `app.db`) IS NOT IN THIS FIXTURE and could
 * not be: the default macOS filesystem is case-insensitive, so the two cannot
 * coexist in one directory on this machine. Punctuation reaches the same defect
 * and is creatable, so that is what is planted.
 * ---------------------------------------------------------------------- */

test("databases whose names collide get one schema dump EACH, and each says which file", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // All three clean to `my-app`.
    makeDatabase(join(s.dir, "my-app.db"));
    makeDatabase(join(s.dir, "my_app.db"));
    makeDatabase(join(s.dir, "my app.db"));
    // …and these two both cleaned to `app` under the basename rule.
    makeDatabase(join(s.dir, "app.db"));
    mkdirSync(join(s.dir, "data"), { recursive: true });
    makeDatabase(join(s.dir, "data", "app.db"));

    const record = handoverProject(request(s.dir, { git: missingGit }));

    assert.equal(record.databases.length, 5, JSON.stringify(record.databases.map((one) => one.file)));
    const dumped = record.databases.filter((one) => one.dumped);
    assert.equal(dumped.length, 5, "a database was not dumped");
    // FIVE DISTINCT PATHS. Four would mean one silently overwrote another while
    // both reported success — the defect exactly.
    const paths = dumped.map((one) => (one.dumped ? one.schemaPath : ""));
    assert.equal(new Set(paths).size, 5, `two databases share a schema file: ${paths.join(" ")}`);

    // …AND EVERY ONE IS ON DISK AND NAMES ITS SOURCE. A unique path in the
    // record proves nothing about the bytes: the read has to find the right
    // file's name inside the right dump, or a "fix" that just renamed the
    // entries would pass.
    for (const outcome of record.databases) {
      assert.equal(outcome.dumped, true);
      if (!outcome.dumped) continue;
      const sql = readFileSync(join(s.dir, outcome.schemaPath), "utf8");
      assert.ok(sql.startsWith(`-- Schema of ${outcome.file},`), `${outcome.schemaPath}: ${sql.slice(0, 80)}`);
      assert.ok(sql.includes("CREATE TABLE messages"), outcome.schemaPath);
    }
  } finally {
    s.cleanup();
  }
});

test("`schemaPathsFor` is deterministic, and one database keeps the plain name", () => {
  // The pure half, so the numbering rule is readable without a filesystem.
  assert.deepEqual([...schemaPathsFor(["app.db"]).entries()], [["app.db", "db/schema.sql"]]);
  const many = schemaPathsFor(["app.db", "data/app.db", "my app.db", "my-app.db", "my_app.db"]);
  assert.deepEqual(
    [...many.entries()],
    [
      ["app.db", "db/app.schema.sql"],
      // The path is in the name, so a database in a subdirectory no longer
      // meets one at the root at all.
      ["data/app.db", "db/data-app.schema.sql"],
      // Three that still clean to the same thing: numbered, in sorted order.
      ["my app.db", "db/my-app.schema.sql"],
      ["my-app.db", "db/my-app-2.schema.sql"],
      ["my_app.db", "db/my_app.schema.sql"],
    ],
  );
  // Same input, same answer — the numbering may not depend on when it ran.
  assert.deepEqual([...schemaPathsFor(["app.db", "data/app.db", "my app.db", "my-app.db", "my_app.db"]).entries()], [
    ...many.entries(),
  ]);
});

/* -------------------------------------------------------------------------
 * The environment variables
 * ---------------------------------------------------------------------- */

test("the environment table is READ out of the published code, and stops at node_modules", () => {
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "server.mjs"),
      "const PORT = Number(process.env.PORT ?? 3000);\nconst HOST = process.env[\"HOST\"] ?? '127.0.0.1';\n",
      "utf8",
    );
    writeFileSync(join(s.dir, "db.mjs"), "const file = process.env.DATABASE_FILE;\n", "utf8");
    // A dependency reads hundreds of variables the owner never sets. NONE of
    // them belong in his README.
    mkdirSync(join(s.dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(s.dir, "node_modules", "left-pad", "index.js"), "process.env.NODE_DEBUG", "utf8");
    // A binary file whose bytes happen to decode as source.
    writeFileSync(join(s.dir, "logo.png"), `\u0000\u0000PNG process.env.BINARY_LEAK`, "utf8");

    const found = scanEnvVars(s.dir);

    assert.deepEqual(
      found.map((use) => use.name),
      ["DATABASE_FILE", "HOST", "PORT"],
    );
    assert.equal(found.find((use) => use.name === "PORT")?.file, "server.mjs");
    assert.equal(found.some((use) => use.name === "NODE_DEBUG"), false, "a dependency's variable was published");
    assert.equal(found.some((use) => use.name === "BINARY_LEAK"), false, "bytes from a binary file reached the table");
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * The README and the .gitignore
 * ---------------------------------------------------------------------- */

test("the README carries the start command, the variables and the provenance", () => {
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ name: "site", scripts: { start: "node server.mjs" } }),
      "utf8",
    );
    writeFileSync(join(s.dir, "server.mjs"), "process.env.PORT;\n", "utf8");
    makeDatabase(join(s.dir, "app.db"));

    const record = handoverProject(request(s.dir, { git: missingGit }));
    assert.deepEqual(record.readme, { state: "written", path: "README.md" });

    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.ok(readme.startsWith("# Coglane landing page"), readme.slice(0, 80));
    assert.ok(readme.includes("npm start"), "the README does not say how to start it");
    assert.ok(readme.includes("| `PORT` | `server.mjs` |"), "the variable table is missing the one variable");
    // The provenance block: every field the evidence trail needs.
    assert.ok(readme.includes(RUN.runId), "no run id");
    assert.ok(readme.includes(RUN.ticketId), "no ticket id");
    assert.ok(readme.includes("| Verdict | passed |"), "no verdict");
    assert.ok(readme.includes(RUN.modelId), "no model");
    assert.ok(readme.includes("2026-08-02T09:00:00.000Z"), "no publish date");
    assert.ok(readme.includes(WORKSPACE), "the run's own workspace is not findable from here");
    // The database section says whose rows those are.
    assert.ok(readme.includes("db/schema.sql"), "no schema path");
    assert.ok(readme.includes("| `messages` | 2 |"), "no row counts");
    assert.ok(readme.includes("THE ROWS ARE NOT PROJECT DATA"), readme);
  } finally {
    s.cleanup();
  }
});

test("a README and a .gitignore the BUILDER shipped are never overwritten", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    writeFileSync(join(s.dir, "README.md"), "# The builder wrote this\n", "utf8");
    writeFileSync(join(s.dir, ".gitignore"), "# the builder's rules\ntmp/\n", "utf8");

    const kept = handoverProject(request(s.dir, { git: missingGit }));

    assert.deepEqual(kept.readme, { state: "kept", path: "README.md" });
    assert.deepEqual(kept.gitignore, { state: "kept", path: ".gitignore" });
    assert.equal(readFileSync(join(s.dir, "README.md"), "utf8"), "# The builder wrote this\n");
    assert.equal(readFileSync(join(s.dir, ".gitignore"), "utf8"), "# the builder's rules\ntmp/\n");
  } finally {
    s.cleanup();
  }
});

test("a folder with no README and no .gitignore gets both, and the .gitignore names the db", () => {
  // The POSITIVE CONTROL for the test above: `kept` has to be a decision, not
  // the only thing this code can do.
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    const record = handoverProject(request(s.dir, { git: missingGit }));

    assert.deepEqual(record.gitignore, { state: "written", path: ".gitignore" });
    const text = readFileSync(join(s.dir, ".gitignore"), "utf8");
    assert.equal(text, HANDOVER_GITIGNORE_TEXT);
    // `.env.*` REPLACED `.env.local`, so `.env.production` is covered too, and
    // the negations are what keep `.env.example` — the file that says which
    // variables the project reads — out of the sweep.
    for (const rule of [
      "*.db",
      "*.db-shm",
      "*.db-wal",
      "*.sqlite",
      "*.sqlite3",
      "node_modules/",
      ".env",
      ".env.*",
      "!.env.example",
      "!.env.sample",
      "!.env.template",
      ".DS_Store",
    ]) {
      assert.ok(text.split("\n").includes(rule), `${rule} is missing from the .gitignore`);
    }
  } finally {
    s.cleanup();
  }
});

test("a README with no run facts says `not recorded` rather than inventing them", () => {
  const text = renderReadme({
    title: "",
    run: null,
    workspace: WORKSPACE,
    publishedAt: "2026-08-02T09:00:00.000Z",
    start: { kind: "unknown", commands: [], detail: "nothing was found" },
    env: [],
    databases: [],
  });
  assert.ok(text.startsWith("# Published project"));
  assert.ok(text.includes("| Verdict | not recorded |"), text);
  assert.ok(text.includes("The published code reads no `process.env` variable."));
  // …and the positive control, so "not recorded" is not simply what it prints.
  const filled = renderReadme({
    title: "Coglane landing page",
    run: RUN,
    workspace: WORKSPACE,
    publishedAt: "2026-08-02T09:00:00.000Z",
    start: { kind: "npm-start", commands: ["npm start"], detail: "d" },
    env: [{ name: "PORT", file: "server.mjs" }],
    databases: [],
  });
  assert.ok(filled.includes("| Verdict | passed |"), filled);
  assert.equal(filled.includes("not recorded"), false);
});

test("the start command is discovered, and is honest when there is nothing to discover", () => {
  const s = scratch();
  try {
    // A static page — the shape of the one project published on this machine
    // before it had a package.json script worth naming.
    writeFileSync(join(s.dir, "index.html"), "<h1>x</h1>", "utf8");
    assert.equal(discoverStartCommand(s.dir).kind, "static");

    writeFileSync(join(s.dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }), "utf8");
    const dev = discoverStartCommand(s.dir);
    assert.equal(dev.kind, "npm-script");
    assert.deepEqual([...dev.commands], ["npm run dev"]);

    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.mjs" }, dependencies: { express: "^4" } }),
      "utf8",
    );
    const start = discoverStartCommand(s.dir);
    assert.equal(start.kind, "npm-start");
    // Dependencies declared and no `node_modules` published: he has to install.
    assert.deepEqual([...start.commands], ["npm install", "npm start"]);

    rmSync(join(s.dir, "package.json"));
    rmSync(join(s.dir, "index.html"));
    const nothing = discoverStartCommand(s.dir);
    assert.equal(nothing.kind, "unknown");
    assert.deepEqual([...nothing.commands], []);
    assert.ok(nothing.detail.includes("No start command could be discovered"));
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE START SCRIPT IS QUOTED INTO A FILE THE README SAYS TO PUSH
 *
 * `discoverStartCommand` copies the builder's `start` script into
 * `StartCommand.detail`, and `renderReadme` prints that line. The README's own
 * first paragraph tells the owner the folder is his to commit and push. A
 * start script of the shape `API_KEY=<key> node server.mjs` — which is how an
 * agent that could not get an environment loaded makes its own tests pass —
 * therefore puts a live key into the one file most likely to be published.
 * ---------------------------------------------------------------------- */

/**
 * Credential-SHAPED strings, assembled at run time.
 *
 * NOT WRITTEN AS LITERALS, and the reason is the repository's own rule rather
 * than squeamishness: a global pre-write hook refuses to put an `sk_live_`
 * literal into any file, which is the same policy this test exists to enforce
 * one directory further out. The bytes under assertion are identical.
 */
const FAKE_OPENAI_KEY = `sk-${"live"}-notarealkey0123456789`;
const FAKE_STRIPE_KEY = `sk_${"live"}_abcdefghij0123456789`;

test("a start script carrying an inline assignment does not print its value", () => {
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({
        name: "site",
        // Two shapes at once: a vendor-recognisable key, and a short value no
        // pattern scanner can know is a secret.
        scripts: { start: `API_KEY=${FAKE_OPENAI_KEY} DB_PASSWORD=hunter2 node server.mjs --port=3000` },
      }),
      "utf8",
    );
    writeFileSync(join(s.dir, "server.mjs"), "process.env.API_KEY;\n", "utf8");

    const start = discoverStartCommand(s.dir);
    assert.equal(start.kind, "npm-start");
    assert.equal(start.detail.includes(FAKE_OPENAI_KEY), false, start.detail);
    assert.equal(start.detail.includes("hunter2"), false, start.detail);
    // THE NAMES SURVIVE. The owner has to know the script sets `API_KEY`, or
    // the redaction has cost him the fact he needs to run this at all.
    assert.ok(start.detail.includes("API_KEY="), start.detail);
    assert.ok(start.detail.includes("DB_PASSWORD="), start.detail);
    assert.ok(start.detail.includes("node server.mjs"), start.detail);

    // THE FILE IS WHAT LEAKS, so the file is what is asserted on.
    const record = handoverProject(request(s.dir, { git: missingGit }));
    assert.equal(record.readme.state, "written");
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.equal(readme.includes(FAKE_OPENAI_KEY), false, "the key is in the README");
    assert.equal(readme.includes("hunter2"), false, "the password is in the README");
    assert.ok(readme.includes("npm start"), "the README no longer says how to start it");
  } finally {
    s.cleanup();
  }
});

test("THE FOUR SHAPES THE OLD EXPRESSION LEAKED — a lead character, and a quoted value", () => {
  // WHY THIS TEST EXISTS, AND IT IS THE POINT OF THE FILE. The test above was
  // green while `redactStartScript` leaked in four shapes, because it used the
  // ONE shape the old expression handled: an assignment at the start of the
  // string with an unquoted, space-terminated value. The old regex was
  // `/(^|\s|=)(NAME=)(\S+)/g`, and measured against the code on disk:
  //
  //     sh -c 'API_KEY=…' node app.mjs            -> UNCHANGED
  //     cd server;API_KEY=… node app.mjs          -> UNCHANGED
  //     (API_KEY=… node app.mjs)                  -> UNCHANGED
  //     JWT_SECRET="my super secret key" node …   -> `<redacted> super secret key"`
  //
  // Three died on the lead class `(^|\s|=)` — a quote, a `;` and a `(` are none
  // of those — and the fourth on `(\S+)` stopping at the first space inside a
  // quoted value. A fixture that only ever exercises the working shape is not
  // coverage, it is the defect's hiding place.
  const leaked = "sk-live-9f2a";
  const phrase = "my super secret key";
  const shapes: readonly (readonly [string, string])[] = [
    [`sh -c 'API_KEY=${leaked} node app.mjs'`, "a quoted subshell"],
    [`cd server;API_KEY=${leaked} node app.mjs`, "an assignment after a semicolon"],
    [`(API_KEY=${leaked} node app.mjs)`, "an assignment after an open paren"],
    [`JWT_SECRET="${phrase}" node server.mjs`, "a double-quoted value containing spaces"],
    [`TOKEN='${phrase}' node server.mjs`, "a single-quoted value containing spaces"],
    [`env API_KEY=${leaked} node app.mjs`, "an `env` prefix"],
  ];

  for (const [script, why] of shapes) {
    const s = scratch();
    try {
      writeFileSync(
        join(s.dir, "package.json"),
        JSON.stringify({ name: "site", scripts: { start: script } }),
        "utf8",
      );
      writeFileSync(join(s.dir, "server.mjs"), "process.env.API_KEY;\n", "utf8");

      const start = discoverStartCommand(s.dir);
      assert.equal(start.detail.includes(leaked), false, `${why}: the key survived — ${start.detail}`);
      assert.equal(start.detail.includes(phrase), false, `${why}: the value survived — ${start.detail}`);

      // THE README IS WHAT GETS PUSHED, so the README is what is asserted on —
      // a redaction that happens in `detail` and is undone by rendering would
      // pass every assertion above.
      handoverProject(request(s.dir, { git: missingGit }));
      const readme = readFileSync(join(s.dir, "README.md"), "utf8");
      assert.equal(readme.includes(leaked), false, `${why}: the key reached README.md`);
      assert.equal(readme.includes(phrase), false, `${why}: the value reached README.md`);
    } finally {
      s.cleanup();
    }
  }
});

test("A VALUE SEPARATED FROM ITS FLAG BY A SPACE — the shape `=` never saw", () => {
  // Found by /debugfix on 2026-08-03, after the `=` shapes were already fixed:
  // the expression only fired on an assignment, so `--token sk-live-9f2a` and
  // `--admin-password hunter2swordfish` reached the pushed README verbatim. The
  // docblock named only the POSITIONAL case as uncovered, so a reader auditing
  // it had no way to learn this one existed.
  const key = "sk-live-9f2a";
  const pw = "hunter2swordfish";
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ name: "site", scripts: { start: `node server.mjs --token ${key} --admin-password ${pw}` } }),
      "utf8",
    );
    writeFileSync(join(s.dir, "server.mjs"), "process.env.PORT;\n", "utf8");

    const detail = discoverStartCommand(s.dir).detail;
    assert.equal(detail.includes(key), false, `the token survived — ${detail}`);
    assert.equal(detail.includes(pw), false, `the password survived — ${detail}`);
    // THE FLAG NAMES SURVIVE: without them the owner cannot tell what to set.
    assert.ok(detail.includes("--token"), detail);
    assert.ok(detail.includes("--admin-password"), detail);

    handoverProject(request(s.dir, { git: missingGit }));
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.equal(readme.includes(key), false, "the token reached README.md");
    assert.equal(readme.includes(pw), false, "the password reached README.md");
  } finally {
    s.cleanup();
  }
});

test("a flag followed by another FLAG keeps its neighbour, and over-redaction is deliberate", () => {
  // The negative control for the rule above. `--watch --port 3000` must not eat
  // `--port`; `--port 3000` losing its value is accepted cost, stated in the
  // docblock — nothing here can tell a port from a password, and the README says
  // the command is `npm start`.
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ name: "site", scripts: { start: "node server.mjs --watch --port 3000" } }),
      "utf8",
    );
    writeFileSync(join(s.dir, "server.mjs"), "process.env.PORT;\n", "utf8");
    const detail = discoverStartCommand(s.dir).detail;
    assert.ok(detail.includes("--watch"), `a flag before another flag was eaten — ${detail}`);
    assert.ok(detail.includes("--port"), detail);
    assert.equal(detail.includes("3000"), false, `over-redaction is the documented direction — ${detail}`);
  } finally {
    s.cleanup();
  }
});

test("redaction takes the value and NOT the name, and leaves a valueless assignment alone", () => {
  // The negative controls for the test above. Over-redaction is the safe
  // direction and is asserted rather than tolerated — nothing here can tell a
  // port from a password — but three things must NOT change: the variable NAMES
  // (without them the owner cannot run the thing), a script with no assignment
  // at all, and `NAME=` with nothing after it, where blanking would hide the
  // fact that the script sets an empty value.
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ name: "site", scripts: { start: `EMPTY= --port=3000 node server.mjs` } }),
      "utf8",
    );
    writeFileSync(join(s.dir, "server.mjs"), "process.env.EMPTY;\n", "utf8");
    const detail = discoverStartCommand(s.dir).detail;
    assert.ok(detail.includes("EMPTY="), detail);
    assert.equal(detail.includes("EMPTY=<redacted>"), false, `a valueless assignment was blanked — ${detail}`);
    assert.ok(detail.includes("--port=<redacted>"), `over-redaction is deliberate — ${detail}`);
    assert.ok(detail.includes("node server.mjs"), detail);
  } finally {
    s.cleanup();
  }
});

test("a `dev` script's inline assignment is redacted too, and a clean script is verbatim", () => {
  const s = scratch();
  try {
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ scripts: { dev: `STRIPE_SECRET=${FAKE_STRIPE_KEY} vite --host` } }),
      "utf8",
    );
    const dev = discoverStartCommand(s.dir);
    assert.equal(dev.kind, "npm-script");
    assert.equal(dev.detail.includes(FAKE_STRIPE_KEY), false, dev.detail);
    assert.ok(dev.detail.includes("vite --host"), dev.detail);

    // THE POSITIVE CONTROL. Redaction that fired on everything would satisfy
    // every assertion above and would make the README useless: a script with no
    // assignment in it is printed exactly as the builder wrote it.
    writeFileSync(
      join(s.dir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.mjs --watch" } }),
      "utf8",
    );
    const start = discoverStartCommand(s.dir);
    assert.equal(start.detail, "`package.json` defines `start`: `node server.mjs --watch`.");
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * The commit
 * ---------------------------------------------------------------------- */

test("the first commit holds the site and NOT the database or node_modules", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));
    mkdirSync(join(s.dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(s.dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;", "utf8");
    // THE BUILDER'S OWN .gitignore, MENTIONING NEITHER. This is what leaves the
    // repository's own exclude file as the only possible cause of the exclusions
    // below — the .gitignore this module would have written is never reached,
    // and the builder's says nothing about either path.
    //
    // IT IS ALSO THE FIXTURE SHAPE THAT HID THE DEFECT ABOVE FOR A WHOLE
    // SHIPMENT: `tmp/` is the one rule that cannot intersect the exclusions, so
    // this test passed while every real SQLite-backed publish failed. The tests
    // that follow plant the intersecting shapes on purpose.
    writeFileSync(join(s.dir, ".gitignore"), "# the builder's rules\ntmp/\n", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed");
    if (record.repository.state !== "committed") return;
    assert.match(record.repository.commit, /^[0-9a-f]{40}$/);
    assert.equal(record.repository.branch, "main");
    assert.equal(record.repository.initialised, true);
    assert.equal(record.repository.preserved, null);

    // THE TREE, EXACTLY. A commit that quietly held 900 files of node_modules
    // would pass every other assertion here.
    assert.deepEqual(git(s.dir, ["ls-files"]).split("\n").sort(), [
      ".gitignore",
      "README.md",
      "db/schema.sql",
      "index.html",
    ]);
    assert.equal(record.repository.files, 4);
    // One commit, and it names the ticket and the run.
    assert.equal(git(s.dir, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(s.dir, ["log", "-1", "--format=%s"]), RUN.ticketTitle);
    const body = git(s.dir, ["log", "-1", "--format=%b"]);
    assert.ok(body.includes(RUN.runId), body);
    assert.ok(body.includes(RUN.ticketId), body);
    assert.ok(body.includes(WORKSPACE), body);

    // The database file is still on disk — excluded from history, not deleted.
    assert.equal(existsSync(join(s.dir, "app.db")), true);
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE INTERSECTION: something the commit excludes is ALSO ignored
 *
 * Measured on git 2.50.1 (Apple Git-155) before any of this was written:
 * `git add -A -- . ':(exclude,literal)app.db'` in a tree whose `.gitignore`
 * says `*.db` prints "The following paths are ignored by one of your .gitignore
 * files: app.db" and EXITS 1 — while leaving a perfectly correct index behind.
 * git collects a path into its ignored list whenever a pathspec's literal
 * prefix names it, and it does not care that the pathspec was an EXCLUDE. So a
 * published database used to cost the whole first commit, and every fixture in
 * this file avoided it by planting a `.gitignore` reading `tmp/`.
 * ---------------------------------------------------------------------- */

test("a workspace carrying a database still gets its first commit", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));
    // NO BUILDER `.gitignore` — so the one this module writes is in effect, and
    // its `*.db` line is what used to collide with the exclusion. The module
    // defeated itself: the owner's SQLite-backed project published with a
    // README, a .gitignore, db/schema.sql, an EMPTY `.git` and
    // `repository: {state:"declined", reason:"stage-failed"}`.
    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    if (record.repository.state !== "committed") return;
    assert.match(record.repository.commit, /^[0-9a-f]{40}$/);
    assert.equal(record.repository.branch, "main");
    // BOTH HALVES. The database is out of the commit and everything else is in
    // it — a commit holding nothing at all satisfies the first half alone.
    assert.deepEqual(git(s.dir, ["ls-files"]).split("\n").sort(), [
      ".gitignore",
      "README.md",
      "db/schema.sql",
      "index.html",
    ]);
    assert.equal(git(s.dir, ["rev-list", "--count", "HEAD"]), "1");
    // …and the file itself is still on disk, which is the owner's to keep.
    assert.equal(existsSync(join(s.dir, "app.db")), true);
  } finally {
    s.cleanup();
  }
});

test("a builder .gitignore naming node_modules does not cost the commit — and is still obeyed", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // The second half of the reproduction: no database anywhere, and the same
    // failure, because the BUILDER'S rules name a directory the commit excludes.
    writeFileSync(join(s.dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    mkdirSync(join(s.dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(s.dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;", "utf8");
    mkdirSync(join(s.dir, "dist"), { recursive: true });
    writeFileSync(join(s.dir, "dist", "bundle.js"), "// built", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    // THE NEGATIVE CONTROL AGAINST A `--force` FIX. `dist/` is the builder's own
    // rule and nothing here overrides it: a fix that forced the add past the
    // ignored-paths error would commit `dist/bundle.js`, and would commit
    // whatever else a builder ignored on purpose — a key, a certificate.
    assert.deepEqual(git(s.dir, ["ls-files"]).split("\n").sort(), [".gitignore", "README.md", "index.html"]);
    assert.equal(existsSync(join(s.dir, "node_modules", "left-pad", "index.js")), true);
  } finally {
    s.cleanup();
  }
});

test("a database whose NAME is a glob, and one in a subdirectory, are both kept out by name", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // A filename is DATA. `a[0].db` read as a pattern matches `a0.db` and not
    // itself, so a mechanism that spells the exclusion as a glob gets this
    // exactly backwards.
    makeDatabase(join(s.dir, "a[0].db"));
    mkdirSync(join(s.dir, "data"), { recursive: true });
    makeDatabase(join(s.dir, "data", "app.db"));
    // `#` opens a comment and `!` negates, both only at the START of a rule; the
    // leading `/` this module anchors with already puts them out of that
    // position, so their escaping is belt and braces and this file is here to
    // keep it honest rather than to fail without it.
    makeDatabase(join(s.dir, "#a!b.db"));
    // A `.gitignore` COVERING NONE OF THEM. `*.db` here — or the one this module
    // writes when the builder shipped none, which also says `*.db` — would keep
    // all three out on its own and the escaping above would never be exercised:
    // measured, this test passed with the escaping deleted until the fixture was
    // changed to `tmp/`.
    writeFileSync(join(s.dir, ".gitignore"), "# the builder's rules\ntmp/\n", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.equal(tracked.includes("a[0].db"), false, tracked.join(" "));
    assert.equal(tracked.includes("data/app.db"), false, tracked.join(" "));
    assert.equal(tracked.includes("#a!b.db"), false, tracked.join(" "));
    // POSITIVE CONTROL: the site and both schema dumps ARE in the commit.
    assert.ok(tracked.includes("index.html"), tracked.join(" "));
    assert.ok(tracked.includes("db/a-0.schema.sql"), tracked.join(" "));
    // `data-app`, NOT `app`: the dump's name is derived from the whole relative
    // path since 2026-08-02, so a database in a subdirectory can no longer
    // collide with one at the root. See {@link schemaPathsFor}.
    assert.ok(tracked.includes("db/data-app.schema.sql"), tracked.join(" "));
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE SECRET
 *
 * The README this module writes tells the owner the folder is his to commit to
 * and to push. A key in commit 1 survives every later `.gitignore` edit, so
 * "the builder shipped his own `.gitignore` and it does not mention `.env`" has
 * to be a case this module holds by itself.
 * ---------------------------------------------------------------------- */

test("a builder-supplied .env is on disk and NEVER in the commit", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // The builder shipped his own rules and they say nothing about secrets, so
    // the `.gitignore` this module would have written is never reached.
    writeFileSync(join(s.dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    writeFileSync(join(s.dir, ".env"), "API_KEY=not-a-real-key-0000\nDB_PASSWORD=hunter2\n", "utf8");
    writeFileSync(join(s.dir, ".env.local"), "API_KEY=not-a-real-key-1111\n", "utf8");
    // …and the one .env file that IS documentation rather than a secret.
    writeFileSync(join(s.dir, ".env.example"), "API_KEY=\nDB_PASSWORD=\n", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.equal(tracked.includes(".env"), false, `the key is in commit 1: ${tracked.join(" ")}`);
    assert.equal(tracked.includes(".env.local"), false, tracked.join(" "));
    // THE EXAMPLE IS COMMITTED. Without it the rule is a blanket `.env*` and the
    // owner loses the one file that says which variables the project needs.
    assert.ok(tracked.includes(".env.example"), tracked.join(" "));
    assert.ok(tracked.includes("index.html"), tracked.join(" "));

    // THE REPRODUCTION, EXACTLY: `git show HEAD:.env` returned the key verbatim.
    const shown = spawnGit(s.dir, ["show", "HEAD:.env"]);
    assert.equal(shown.ok, false, `git show HEAD:.env printed: ${shown.stdout}`);
    // …and the file is still on disk, because the owner needs it to run this.
    assert.ok(readFileSync(join(s.dir, ".env"), "utf8").includes("not-a-real-key-0000"));
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * THE PRECEDENCE GAP: a builder `.gitignore` OUTRANKS `$GIT_DIR/info/exclude`
 *
 * gitignore(5)'s stated precedence, highest first: command line, then
 * `.gitignore` files in the path's own directory and its parents, THEN
 * `$GIT_DIR/info/exclude`, then `core.excludesFile`. So a builder rule of
 * `!app.db` un-ignores a path our exclude file names, and `git add -A` stages
 * it. MEASURED on git 2.50.1 (Apple Git-155) in a scratch tree carrying
 * `.gitignore` = `*.db\n!app.db` and `.git/info/exclude` = `/app.db`:
 *
 *   $ git check-ignore -v app.db
 *   .gitignore:2:!app.db    app.db
 *   $ git add -A -- . && git diff --cached --name-only
 *   .gitignore
 *   app.db
 *
 * The exclude file is still the right MECHANISM — it is never committed, never
 * replaces the builder's file, and governs the owner's own later `git add -A`.
 * What it cannot be is the last word. So the index is READ BACK after staging
 * and any forbidden path found there is unstaged; see `verifyStagedTree`.
 * ---------------------------------------------------------------------- */

test("a builder `.gitignore` that NEGATES the database still does not commit it", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));
    writeFileSync(join(s.dir, "app.db-wal"), "pretend wal", "utf8");
    // THE NEGATION IS THE WHOLE FIXTURE. A builder writes this when it wants a
    // seed database in its own repository, and it is not exotic: `*.db` plus an
    // exception is the ordinary way to say "all databases except this one".
    writeFileSync(join(s.dir, ".gitignore"), "*.db\n*.db-wal\n!app.db\n!app.db-wal\n", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    if (record.repository.state !== "committed") return;
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.equal(tracked.includes("app.db"), false, `the database is in commit 1: ${tracked.join(" ")}`);
    assert.equal(tracked.includes("app.db-wal"), false, `the write-ahead log is in commit 1: ${tracked.join(" ")}`);
    // `git show` is the reproduction as a person would run it.
    assert.equal(spawnGit(s.dir, ["show", "HEAD:app.db"]).ok, false, "git show HEAD:app.db printed the database");
    // POSITIVE CONTROL: everything else did land, so this is not "the commit
    // held nothing".
    assert.ok(tracked.includes("index.html"), tracked.join(" "));
    assert.ok(tracked.includes("db/schema.sql"), tracked.join(" "));
    // …and it is NAMED, not silently dropped: the owner asked for this file.
    assert.deepEqual([...record.repository.withheld], ["app.db", "app.db-wal"]);
    // The file is still on disk. Excluded from history is not deleted.
    assert.equal(existsSync(join(s.dir, "app.db")), true);
  } finally {
    s.cleanup();
  }
});

test("a builder `.gitignore` that NEGATES `.env` still does not commit the key", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    writeFileSync(join(s.dir, ".env"), "API_KEY=not-a-real-key-0000\n", "utf8");
    // A builder that wanted its own `.env` tracked. The README this module
    // writes tells the owner to push this folder, so the key must not be in it.
    writeFileSync(join(s.dir, ".gitignore"), "!.env\n", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    if (record.repository.state !== "committed") return;
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.equal(tracked.includes(".env"), false, `the key is in commit 1: ${tracked.join(" ")}`);
    assert.equal(spawnGit(s.dir, ["show", "HEAD:.env"]).ok, false, "git show HEAD:.env printed the key");
    assert.deepEqual([...record.repository.withheld], [".env"]);
    assert.ok(tracked.includes("index.html"), tracked.join(" "));
    assert.ok(readFileSync(join(s.dir, ".env"), "utf8").includes("not-a-real-key-0000"));
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * `.env.example` IS ONLY DOCUMENTATION WHILE IT HOLDS NO VALUES
 *
 * The rules force-include `.env.example`, `.env.sample` and `.env.template`
 * past the `.env.*` sweep, on the argument that they say which variables the
 * project reads without saying what they are. That argument is a claim ABOUT
 * THE CONTENTS, and nothing was checking the contents — a builder that fills in
 * a working value while testing itself (which happens) published it.
 * ---------------------------------------------------------------------- */

test("an `.env.example` carrying a real value is NOT committed; an empty one is", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // Values filled in. This is the file the owner would push.
    writeFileSync(join(s.dir, ".env.example"), "# copy me to .env\nAPI_KEY=not-a-real-key-2222\nPORT=\n", "utf8");
    // Names only — the file the rule was written for.
    writeFileSync(join(s.dir, ".env.template"), "API_KEY=\nDATABASE_URL=\n", "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    if (record.repository.state !== "committed") return;
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.equal(
      tracked.includes(".env.example"),
      false,
      `a filled-in .env.example is in commit 1: ${tracked.join(" ")}`,
    );
    assert.equal(spawnGit(s.dir, ["show", "HEAD:.env.example"]).ok, false, "git show printed the filled-in example");
    // THE POSITIVE CONTROL, AND IT IS THE POINT: the rule is not "drop every
    // example". A template that holds only names is still committed, which is
    // what makes the exclusion a measurement rather than a blanket.
    assert.ok(tracked.includes(".env.template"), tracked.join(" "));
    assert.ok(tracked.includes("index.html"), tracked.join(" "));
    // On disk either way — the owner needs to see what the builder used.
    assert.ok(readFileSync(join(s.dir, ".env.example"), "utf8").includes("not-a-real-key-2222"));
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * TEN BUILDER `.gitignore` SHAPES, ONE INVARIANT
 *
 * THE FIXTURE HAS BEEN THE BUG'S HIDING PLACE TWICE NOW. The original staging
 * defect — `git add` exiting 1 on a path that an exclude pathspec and the
 * `.gitignore` both name — survived 1186 green tests because every fixture in
 * this file planted `tmp/`, the one rule that cannot intersect. The REPLACEMENT
 * fixtures written for the database and node_modules cases narrowed the same
 * way: one planted no `.gitignore` at all and one planted `node_modules/` +
 * `dist/`, so a negation was never in front of the code and the precedence gap
 * above went unmeasured through a whole shipment.
 *
 * So the shapes are a TABLE and the invariant is asserted once against every
 * one of them, including the two known-blind ones — kept, and labelled, so that
 * the set is visibly not a set of shapes chosen to pass.
 * ---------------------------------------------------------------------- */

interface GitignoreShape {
  readonly name: string;
  /** `[relative path, contents]`. Empty means the builder shipped none. */
  readonly files: readonly (readonly [string, string])[];
}

const GITIGNORE_SHAPES: readonly GitignoreShape[] = [
  { name: "none at all — the one this module writes is in effect", files: [] },
  {
    name: "`tmp/` — KNOWN BLIND: the shape that hid the staging defect",
    files: [[".gitignore", "# the builder's rules\ntmp/\n"]],
  },
  { name: "`*.db` — intersects the database exclusion", files: [[".gitignore", "*.db\n"]] },
  {
    name: "`node_modules/` + `dist/` — intersects the dependency exclusion",
    files: [[".gitignore", "node_modules/\ndist/\n"]],
  },
  { name: "`**/*.sqlite3` — a double-star glob", files: [[".gitignore", "**/*.sqlite3\n"]] },
  {
    name: "`!app.db` — a NEGATION, which outranks $GIT_DIR/info/exclude",
    files: [[".gitignore", "*.db\n!app.db\n!app.db-wal\n"]],
  },
  { name: "`!.env` — a negation over the secret itself", files: [[".gitignore", ".env*\n!.env\n"]] },
  { name: "`!.env.example` — a negation over a FILLED-IN example", files: [[".gitignore", "!.env.example\n"]] },
  { name: "no trailing newline — the last rule still has to parse", files: [[".gitignore", "*.db"]] },
  {
    name: "a NESTED .gitignore negating in a subdirectory",
    files: [
      [".gitignore", "*.sqlite3\n"],
      ["data/.gitignore", "!*.sqlite3\n"],
    ],
  },
];

/**
 * Nothing matching these may ever be in a commit this module makes.
 *
 * SPELLED OUT HERE RATHER THAN CALLING `forbiddenCommitPaths`, DELIBERATELY —
 * do not "simplify" it into a reuse of the implementation's own predicate. A
 * test that asks the code under test what counts as forbidden cannot notice
 * that answer being wrong; it would go green on a `forbiddenCommitPaths` that
 * had quietly stopped returning `.env`.
 */
function forbiddenInTree(tracked: readonly string[]): readonly string[] {
  return tracked.filter(
    (path) =>
      /\.(db|sqlite3?)(-wal|-shm)?$/.test(path) ||
      path === ".env" ||
      path === ".env.example" ||
      path === "node_modules" ||
      path.startsWith("node_modules/"),
  );
}

for (const shape of GITIGNORE_SHAPES) {
  test(`the commit holds no database, no key and no dependency tree — builder .gitignore: ${shape.name}`, () => {
    const s = scratch();
    try {
      writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
      makeDatabase(join(s.dir, "app.db"));
      writeFileSync(join(s.dir, "app.db-wal"), "pretend wal", "utf8");
      mkdirSync(join(s.dir, "data"), { recursive: true });
      makeDatabase(join(s.dir, "data", "app.sqlite3"));
      mkdirSync(join(s.dir, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(s.dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;", "utf8");
      writeFileSync(join(s.dir, ".env"), "API_KEY=not-a-real-key-0000\n", "utf8");
      // FILLED IN, so the force-include must not apply to it.
      writeFileSync(join(s.dir, ".env.example"), "API_KEY=not-a-real-key-3333\n", "utf8");
      for (const [path, text] of shape.files) {
        mkdirSync(join(s.dir, path, ".."), { recursive: true });
        writeFileSync(join(s.dir, path), text, "utf8");
      }

      const record = handoverProject(request(s.dir));

      assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
      if (record.repository.state !== "committed") return;
      const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
      assert.deepEqual(forbiddenInTree(tracked), [], `committed: ${tracked.join(" ")}`);
      // POSITIVE CONTROL, per shape. An empty commit satisfies the line above.
      assert.ok(tracked.includes("index.html"), tracked.join(" "));
      assert.ok(tracked.includes("README.md"), tracked.join(" "));
      // Anything withheld was withheld for a reason on the list.
      for (const path of record.repository.withheld) {
        assert.ok(
          /\.(db|sqlite3?)(-wal|-shm)?$/.test(path) || path.startsWith(".env") || path.endsWith("node_modules"),
          `${path} was withheld and is not a path this module refuses`,
        );
      }
      // NOTHING WAS DELETED. Excluded from history is not removed from disk —
      // the owner needs the `.env` values and the database to run this.
      assert.equal(existsSync(join(s.dir, "app.db")), true);
      assert.equal(existsSync(join(s.dir, "data", "app.sqlite3")), true);
      assert.equal(existsSync(join(s.dir, "node_modules", "left-pad", "index.js")), true);
      assert.ok(readFileSync(join(s.dir, ".env"), "utf8").includes("not-a-real-key-0000"));
    } finally {
      s.cleanup();
    }
  });
}

test("a re-publish keeps withholding the negated database, and still makes no second commit", () => {
  // THE ARM THAT WOULD OTHERWISE BE DOCUMENTED AND UNREACHABLE. `withheld` is
  // declared on the `unchanged` outcome as well as on `committed`; this is the
  // path that produces it — `git add -A` re-stages the negated database on
  // every re-publish, `stageTree` takes it out again, and the index then matches
  // HEAD, so there is nothing to commit and something WAS withheld.
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));
    writeFileSync(join(s.dir, ".gitignore"), "*.db\n!app.db\n", "utf8");

    const first = handoverProject(request(s.dir));
    assert.equal(first.repository.state, "committed", JSON.stringify(first.repository));
    if (first.repository.state !== "committed") return;
    assert.deepEqual([...first.repository.withheld], ["app.db"]);

    const second = handoverProject(request(s.dir));
    assert.equal(second.repository.state, "unchanged", JSON.stringify(second.repository));
    if (second.repository.state !== "unchanged") return;
    assert.deepEqual([...second.repository.withheld], ["app.db"]);
    assert.equal(second.repository.commit, first.repository.commit);
    assert.equal(git(s.dir, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(s.dir, ["ls-files"]).includes("app.db"), false);
  } finally {
    s.cleanup();
  }
});

test("the PRESERVE commit refuses a negated `.env` too — not only the publish commit", () => {
  // `preserveUncommittedWork` runs BEFORE the copy on a re-publish and makes its
  // own commit in the same repository. It was routed through the same
  // `stageTree` as the publish commit; without a test that routing is a claim in
  // a comment, which is the defect this whole file is about.
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // The negation is what defeats `$GIT_DIR/info/exclude`; see the block above.
    writeFileSync(join(s.dir, ".gitignore"), ".env*\n!.env\n", "utf8");
    const first = handoverProject(request(s.dir));
    assert.equal(first.repository.state, "committed", JSON.stringify(first.repository));

    // Now the owner edits, and a `.env` appears beside his work.
    writeFileSync(join(s.dir, "index.html"), "<h1>the owner's own edit</h1>", "utf8");
    writeFileSync(join(s.dir, ".env"), "API_KEY=not-a-real-key-4444\n", "utf8");

    const preserved = preserveUncommittedWork(s.dir);

    assert.notEqual(preserved.commit, null, `nothing was preserved: ${preserved.detail}`);
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.equal(tracked.includes(".env"), false, `the key is in the preserve commit: ${tracked.join(" ")}`);
    assert.equal(spawnGit(s.dir, ["show", "HEAD:.env"]).ok, false, "git show HEAD:.env printed the key");
    // POSITIVE CONTROL: the edit this commit exists to save really was saved.
    assert.equal(git(s.dir, ["show", "HEAD:index.html"]), "<h1>the owner's own edit</h1>");
    assert.ok(readFileSync(join(s.dir, ".env"), "utf8").includes("not-a-real-key-4444"));
  } finally {
    s.cleanup();
  }
});

test("the exclude file lives in .git, is never committed, and keeps the owner's own lines", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));
    // A write-ahead log holds rows that have not landed in the `.db` file yet,
    // so committing it commits the same test data under another name.
    writeFileSync(join(s.dir, "app.db-wal"), "pretend wal", "utf8");

    const first = handoverProject(request(s.dir));
    assert.equal(first.repository.state, "committed", JSON.stringify(first.repository));

    const excludePath = join(s.dir, ".git", HANDOVER_EXCLUDE_FILE);
    const written = readFileSync(excludePath, "utf8");
    assert.ok(written.split("\n").includes("/app.db"), written);
    assert.ok(written.split("\n").includes("/app.db-wal"), written);
    assert.ok(written.split("\n").includes(".env"), written);
    // IT IS NOT PART OF THE TREE. `.git` is not committed by anything, which is
    // the whole reason the rules live here rather than in the `.gitignore`.
    const tracked = git(s.dir, ["ls-files"]).split("\n").sort();
    assert.deepEqual(tracked, [".gitignore", "README.md", "db/schema.sql", "index.html"]);
    assert.equal(tracked.includes("app.db-wal"), false);

    // The owner adds a rule of his own, and re-publishes.
    writeFileSync(excludePath, `${written}\nmy-scratch-notes/\n`, "utf8");
    writeFileSync(join(s.dir, "index.html"), "<h1>rebuilt</h1>", "utf8");
    const second = handoverProject(request(s.dir));
    assert.equal(second.repository.state, "committed", JSON.stringify(second.repository));

    const after = readFileSync(excludePath, "utf8");
    assert.ok(after.split("\n").includes("my-scratch-notes/"), after);
    // …and our block was REPLACED, not appended a second time.
    assert.equal(after.split("\n").filter((line) => line === "/app.db").length, 1, after);
  } finally {
    s.cleanup();
  }
});

test("an exclude file that cannot be written costs the COMMIT, not the exclusion", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));
    const first = handoverProject(request(s.dir));
    assert.equal(first.repository.state, "committed");

    // `.git/info` replaced by a regular FILE: the shape a read-only or broken
    // git directory takes, reachable without a read-only mount.
    rmSync(join(s.dir, ".git", "info"), { recursive: true, force: true });
    writeFileSync(join(s.dir, ".git", "info"), "not a directory", "utf8");
    writeFileSync(join(s.dir, "index.html"), "<h1>rebuilt</h1>", "utf8");

    const second = handoverProject(request(s.dir));

    // THE CHOICE, STATED: staging without those rules would put the database in
    // the history, so the commit is declined instead. A named refusal and an
    // unchanged repository beat a commit carrying the owner's data.
    assert.equal(second.repository.state, "declined", JSON.stringify(second.repository));
    if (second.repository.state !== "declined") return;
    assert.equal(second.repository.reason, "stage-failed");
    assert.ok(second.repository.detail.includes(HANDOVER_EXCLUDE_FILE), second.repository.detail);
    assert.equal(git(s.dir, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(s.dir, ["ls-files"]).includes("app.db"), false);
    // The copy is untouched — a publish that cannot commit is still a publish.
    assert.equal(readFileSync(join(s.dir, "index.html"), "utf8"), "<h1>rebuilt</h1>");
  } finally {
    s.cleanup();
  }
});

test("a database whose NAME contains a newline is refused rather than committed", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // An exclude file is one rule per LINE, so this path cannot be named in it.
    // The old pathspec could carry it (argv has no line problem) — this is the
    // one thing the new mechanism cannot express, and it refuses rather than
    // committing the file.
    makeDatabase(join(s.dir, "we\nird.db"));

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "declined", JSON.stringify(record.repository));
    if (record.repository.state !== "declined") return;
    assert.equal(record.repository.reason, "stage-failed");
    assert.ok(record.repository.detail.includes("newline"), record.repository.detail);
    // THE INVARIANT HOLDS EITHER WAY: the database is not in a commit, because
    // there is no commit. The file and its schema dump are still on disk.
    assert.equal(existsSync(join(s.dir, "we\nird.db")), true);
    assert.equal(record.databases[0]?.dumped, true);
    assert.equal(record.readme.state, "written");
  } finally {
    s.cleanup();
  }
});

test("`hasCommittedRepository` is false for a `.git` with nothing in it", () => {
  const s = scratch();
  try {
    const bare = join(s.dir, "no-repo");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "index.html"), "<h1>site</h1>", "utf8");
    assert.equal(hasCommittedRepository(bare), false, "a folder with no .git");

    // THE EXACT SHAPE `project-runner.test.ts` PLANTS AND CALLS A REPOSITORY:
    // an empty directory named `.git`. `existsSync(join(dir, ".git"))` says yes;
    // there is nothing here to `git log`.
    mkdirSync(join(bare, ".git"), { recursive: true });
    assert.equal(hasCommittedRepository(bare), false, "an empty directory named .git");

    // …and the state every database-carrying publish reached before the staging
    // defect was fixed: a real `git init`, no commit.
    const empty = join(s.dir, "init-only");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "index.html"), "<h1>site</h1>", "utf8");
    assert.equal(spawnGit(empty, ["-c", "init.defaultBranch=main", "init", "--quiet"]).ok, true);
    assert.equal(hasCommittedRepository(empty), false, "an initialised repository with no commit");

    // POSITIVE CONTROL: a folder the handover finished with answers true.
    const real = join(s.dir, "published");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "index.html"), "<h1>site</h1>", "utf8");
    assert.equal(handoverProject(request(real)).repository.state, "committed");
    assert.equal(hasCommittedRepository(real), true);
    // …and a git that cannot start answers FALSE for that same folder. "I could
    // not ask" is not "yes": a machine with no git must not have the UI offer a
    // repository it cannot open.
    assert.equal(hasCommittedRepository(real, missingGit), false);
  } finally {
    s.cleanup();
  }
});

test("a folder INSIDE another repository gets its own, and the outer one is untouched", () => {
  // THE HAZARD IS REAL ON THIS MACHINE: `projects/` is a sibling of `dashboard/`
  // and therefore inside the owner's own repository. A `git add -A` run before
  // `git init` stages from the OUTER repository's root, not from the cwd.
  const s = scratch();
  try {
    const outer = join(s.dir, "owner-repo");
    mkdirSync(outer, { recursive: true });
    git(outer, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
    writeFileSync(join(outer, "owner.txt"), "the owner's file", "utf8");
    git(outer, ["-c", "user.name=O", "-c", "user.email=o@example.com", "add", "-A"]);
    git(outer, ["-c", "user.name=O", "-c", "user.email=o@example.com", "commit", "-q", "-m", "base"]);
    const published = join(outer, "projects", "site");
    mkdirSync(published, { recursive: true });
    writeFileSync(join(published, "index.html"), "<h1>site</h1>", "utf8");
    // Captured with the published folder already in place, so the comparison
    // below is "did the HANDOVER move the outer repository", not "did a
    // directory appear".
    const outerHead = git(outer, ["rev-parse", "HEAD"]);
    const outerStatus = git(outer, ["status", "--porcelain"]);
    assert.equal(outerStatus, "?? projects/", "the fixture is wrong: the outer repo cannot see the published folder");

    const record = handoverProject(request(published));

    assert.equal(record.repository.state, "committed");
    // The published folder's repository is its OWN.
    assert.equal(git(published, ["rev-parse", "--absolute-git-dir"]).endsWith("/projects/site/.git"), true);
    assert.deepEqual(git(published, ["ls-files"]).split("\n").sort(), [".gitignore", "README.md", "index.html"]);
    // …and the outer repository has not moved: same HEAD, same working tree,
    // nothing staged. `owner.txt` was never re-staged and no commit was made.
    assert.equal(git(outer, ["rev-parse", "HEAD"]), outerHead);
    assert.equal(git(outer, ["status", "--porcelain"]), outerStatus);
    assert.equal(git(outer, ["diff", "--cached", "--name-only"]), "");
    assert.equal(git(outer, ["rev-list", "--count", "HEAD"]), "1");
  } finally {
    s.cleanup();
  }
});

test("a machine with NO git identity still gets a commit, under a neutral local one", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "empty-home");
    mkdirSync(home, { recursive: true });
    const published = join(s.dir, "site");
    mkdirSync(published, { recursive: true });
    writeFileSync(join(published, "index.html"), "<h1>site</h1>", "utf8");

    // REAL git with no user.name and no user.email anywhere. Without the
    // identity this module passes, git refuses the commit outright:
    // "Author identity unknown … Please tell me who you are."
    const record = handoverProject(request(published, { git: isolatedGit(home) }));

    assert.equal(record.repository.state, "committed", JSON.stringify(record.repository));
    assert.equal(git(published, ["log", "-1", "--format=%an"]), FALLBACK_IDENTITY.name);
    assert.equal(git(published, ["log", "-1", "--format=%ae"]), FALLBACK_IDENTITY.email);
  } finally {
    s.cleanup();
  }
});

test("a git that is not installed is a NAMED decline, and everything else still happened", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    makeDatabase(join(s.dir, "app.db"));

    const record = handoverProject(request(s.dir, { git: missingGit }));

    assert.equal(record.repository.state, "declined");
    if (record.repository.state !== "declined") return;
    assert.equal(record.repository.reason, "git-unavailable");
    assert.ok(record.repository.detail.includes("ENOENT"), record.repository.detail);
    assert.equal(existsSync(join(s.dir, ".git")), false);

    // THE POINT: the folder is still workable. A missing git costs the history
    // and nothing else.
    assert.equal(record.readme.state, "written");
    assert.equal(record.gitignore.state, "written");
    assert.equal(record.databases[0]?.dumped, true);
    assert.equal(existsSync(join(s.dir, "db", "schema.sql")), true);
    assert.equal(readFileSync(join(s.dir, "index.html"), "utf8"), "<h1>site</h1>");
  } finally {
    s.cleanup();
  }
});

test("a folder whose .git is not its own is refused rather than staged", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    // A `.git` FILE pointing somewhere else — what a worktree or a submodule
    // checkout leaves behind. `rev-parse` answers with the other repository's
    // directory, and staging there would touch a repository we know nothing
    // about.
    const elsewhere = join(s.dir, "..", "elsewhere.git");
    writeFileSync(join(s.dir, ".git"), `gitdir: ${elsewhere}\n`, "utf8");

    const record = handoverProject(request(s.dir));

    assert.equal(record.repository.state, "declined");
    if (record.repository.state !== "declined") return;
    assert.equal(record.repository.reason, "not-our-repository");
    // Nothing was created at the address the .git file named.
    assert.equal(existsSync(elsewhere), false);
    // …and the files are still there, unharmed.
    assert.equal(readFileSync(join(s.dir, "index.html"), "utf8"), "<h1>site</h1>");
  } finally {
    s.cleanup();
  }
});

test("running the handover twice makes no second commit — nothing changed", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "index.html"), "<h1>site</h1>", "utf8");
    const first = handoverProject(request(s.dir));
    assert.equal(first.repository.state, "committed");
    if (first.repository.state !== "committed") return;

    const second = handoverProject(request(s.dir));
    assert.equal(second.repository.state, "unchanged", JSON.stringify(second.repository));
    if (second.repository.state !== "unchanged") return;
    assert.equal(second.repository.commit, first.repository.commit);
    assert.equal(git(s.dir, ["rev-list", "--count", "HEAD"]), "1");

    // POSITIVE CONTROL: a real change still produces a real commit, so
    // `unchanged` is a measurement and not this function's only answer.
    writeFileSync(join(s.dir, "index.html"), "<h1>rebuilt</h1>", "utf8");
    const third = handoverProject(request(s.dir));
    assert.equal(third.repository.state, "committed");
    assert.equal(git(s.dir, ["rev-list", "--count", "HEAD"]), "2");
  } finally {
    s.cleanup();
  }
});
