/**
 * project-runner.test.ts — real children, real ports, real kills.
 *
 * NOTHING IS MOCKED EXCEPT THE ONE THING THAT CANNOT BE PROVOKED. Every project
 * below is a real folder with a real `package.json`, started with a real `npm
 * run start`, probed over a real loopback socket and killed with a real signal.
 * The only injected seam is the port RANGE — a test needs a one-port window to
 * reach `no_free_port`, and a test that used 4400-4499 would fight the owner's
 * own dashboard if one happened to be up.
 *
 * WHY THE FIXTURES ARE SOURCE STRINGS AND NOT A SHARED SERVER. Each one differs
 * in exactly the way the test is about: this one honours `PORT`, that one
 * ignores it, that one never listens at all. A shared fixture with flags would
 * let a broken code path be observed through a fixture that had been quietly
 * taught to compensate.
 *
 * EVERY TEST THAT SPAWNS CLEANS UP IN `finally` — AND THAT WAS NOT ENOUGH.
 * Measured 2026-08-02: the `stranger` fixture in "reconcileOnBoot leaves alone a
 * pid it cannot verify" was killed on the LAST line of its `try`, after five
 * assertions. Perturbing the first of those assertions to fail left one
 * `node -e setInterval(() => {}, 1000)` reparented to ppid 1 and still alive
 * after the run — one orphan per failing run, and the owner's machine had
 * accumulated roughly twenty of them, which exhausts the port window and turns
 * later tests from failing into HANGING. Fixture teardown now runs through
 * {@link killFixture} on three paths that do not depend on a test reaching its
 * own last line; see {@link fixturePids}.
 *
 * NOTHING HERE WAITS ON A SOCKET WITHOUT A BOUND. Every `fetch` goes through
 * {@link get} and every test carries {@link TEST_OPTIONS}, because a test file
 * that hangs produces NO output at all — the run looks stuck rather than failed,
 * which is how twenty orphans went unnoticed.
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { ApiProject, ApiProjectProcess } from "./api-types.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { ProjectStartOutcome } from "./project-runner.js";
import {
  CHILD_ENV_ALLOWLIST,
  MAX_LOG_LINES,
  PROJECT_PORT_MAX,
  PROJECT_PORT_MIN,
  ProjectRunner,
  RUNNER_STATE_FILE,
  childEnv,
  listeningPortsForGroup,
  processSignature,
  projectSandboxProfile,
  resolveProjectDir,
  safeToSignalGroup,
  startCommandFor,
} from "./project-runner.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

/**
 * A server that does what a published project is supposed to do: read `PORT`
 * and `HOST` out of the environment and bind exactly there.
 *
 * It echoes `ANTHROPIC_API_KEY` because the environment-isolation test needs a
 * witness INSIDE the child — asserting from outside that we passed a small env
 * would only prove what the test itself constructed.
 */
const HONEST_SERVER = `import { createServer } from "node:http";
const port = Number(process.env.PORT ?? "0");
const host = process.env.HOST ?? "0.0.0.0";
createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("project-ok host=" + host + " key=" + (process.env.ANTHROPIC_API_KEY ?? "absent"));
}).listen(port, host, () => {
  console.log("listening on " + host + ":" + port);
});
`;

/** Starts, complains on stderr, and never listens on anything. */
const SILENT_SERVER = `process.stderr.write("cannot start: DATABASE_URL is not set\\n");
setInterval(() => {}, 1000);
`;

/** Exits immediately, the way a syntax error or a missing dependency does. */
const CRASHING_SERVER = `process.stderr.write("Error: Cannot find module 'express'\\n");
process.exit(1);
`;

/** Prints far more than the ring holds, including something key-shaped. */
const CHATTY_SERVER = `import { createServer } from "node:http";
for (let i = 0; i < 500; i += 1) {
  console.log("line " + i + " token=sk-ant-api03-" + "A".repeat(32));
}
createServer((_req, res) => res.end("ok")).listen(Number(process.env.PORT ?? "0"), "127.0.0.1", () => {
  console.log("listening");
});
`;

/** A detached stand-in for a child a dead dashboard left behind. */
const IDLE_FIXTURE = "setInterval(() => {}, 1000)";

/**
 * A `PATH` with no npm on it — the owner's reported spawn failure, provoked
 * without touching the spawn call. `childEnv` copies `PATH` out of the runner's
 * configured environment and libuv resolves the command with the CHILD's
 * `PATH`, so this is what a dashboard launched from a GUI login session gets.
 */
const NO_NPM_PATH = "/nonexistent-so-npm-cannot-be-resolved";

/* -------------------------------------------------------------------------
 * Teardown that does not depend on a test reaching its last line
 * ---------------------------------------------------------------------- */

/**
 * How long any one test may take before node:test calls it failed.
 *
 * NOT A STYLE CHOICE. The slowest test here is a deliberate 2.5 s start
 * timeout; 90 s is far above that and far below "forever". Its whole purpose is
 * that a socket which accepts and never answers — a leaked fixture holding a
 * port in one of this file's windows — produces a RED test with a name on it
 * instead of a run that prints nothing and never returns.
 *
 * STATED HONESTLY: node:test's timeout fails the test but does NOT cancel the
 * async body, which keeps running with its `finally` unreached. That is exactly
 * why {@link fixturePids} has a `process.on("exit")` layer under it.
 */
const TEST_OPTIONS = { timeout: 90_000 } as const;

/** Per HTTP probe in this file. See {@link get}. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * A GET that cannot hang.
 *
 * Bare `fetch` waits forever on a socket that accepts a connection and never
 * answers, and that is not hypothetical here: the ports these tests use are the
 * ports leaked fixtures were measured holding. A loopback fixture answers in
 * about a millisecond, so 10 s is a bound rather than a tuning knob.
 */
function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Every detached fixture this file spawns, so ONE teardown path reaches all of
 * them.
 *
 * MEASURED, NOT PRECAUTIONARY — see this file's header for the reproduction.
 *
 * THREE LAYERS, each covering a case the one above it cannot:
 *   1. {@link killFixture} in the test's own `finally` — the mechanism, and the
 *      only layer that frees the port promptly enough for the next test.
 *   2. `after()` — reached when a test throws before its `finally`, and when
 *      node:test's timeout abandons a body mid-await.
 *   3. `process.on("exit")` — synchronous, and the last thing standing when the
 *      runner exits over the top of a still-running body. `--test-force-exit`
 *      calls `process.exit`, which DOES run exit handlers; a SIGKILL to the
 *      runner does not, and nothing can help there.
 */
const fixturePids = new Set<number>();

function spawnFixture(script: string): number {
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) assert.fail("the fixture did not spawn, so the test that wanted it can mean nothing");
  fixturePids.add(pid);
  return pid;
}

/**
 * Kill a fixture's whole process GROUP, and forget it.
 *
 * The negative pid is deliberate — these are spawned `detached: true`, so each
 * is its own group leader — and `pid > 1` is checked for the reason
 * `safeToSignalGroup` documents in the module under test: `kill(-0)` and
 * `kill(-1)` would reach this test runner and, in a terminal, the owner's shell.
 */
function killFixture(pid: number): void {
  fixturePids.delete(pid);
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: already gone, which is the outcome we wanted.
  }
}

function killAllFixtures(): void {
  for (const pid of [...fixturePids]) killFixture(pid);
}

interface WitnessResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly out: string;
}

/**
 * Run a script in a NODE PROCESS OF ITS OWN and report how it ended.
 *
 * WHY A SUBPROCESS IS THE ONLY HONEST WITNESS FOR AN UNHANDLED `error` EVENT.
 * node:test installs its own `uncaughtException` handler. Measured against the
 * unfixed runner: the assertion went red, but the test process SURVIVED and
 * node:test printed "would have caused the test to fail, but instead triggered
 * an uncaughtException event". The dashboard has no such handler — `index.ts`
 * and the rest of server/src install none — so a check that lives entirely
 * inside node:test CANNOT observe what the owner actually gets, which is a
 * process that exits 1 in the middle of a request. This runs the same code with
 * nothing standing over it.
 *
 * The child is tracked and killed like any other fixture: it is spawned
 * detached, so a witness that hangs is still reachable by every teardown layer.
 */
async function runWitness(script: string, timeoutMs: number): Promise<WitnessResult> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) assert.fail("the witness process did not spawn, so nothing below can mean anything");
  fixturePids.add(pid);
  let out = "";
  const collect = (chunk: string): void => {
    out += chunk;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  try {
    return await new Promise<WitnessResult>((resolve) => {
      const timer = setTimeout(() => {
        killFixture(pid);
        resolve({ code: null, timedOut: true, out });
      }, timeoutMs);
      child.once("exit", (code) => {
        clearTimeout(timer);
        // A tick, so the last stdout chunk is in `out` before it is read.
        setTimeout(() => {
          resolve({ code, timedOut: false, out });
        }, 0);
      });
    });
  } finally {
    killFixture(pid);
  }
}

after(killAllFixtures);
process.on("exit", killAllFixtures);

/**
 * Narrow to the success arm, FAILING rather than returning when it is not one.
 *
 * `if (!outcome.ok) return;` type-narrows, reads fine, and is a test that CANNOT
 * OBSERVE THE DEFECT IT WAS WRITTEN FOR: under a mutation that makes the start
 * refuse, the guard returns and the test passes green. Measured, not theorised —
 * mutations M8 (already-running spawns again) and M25 (children keyed by slug)
 * both SURVIVED against exactly that shape, and both turn red through these.
 */
function mustStart(outcome: ProjectStartOutcome): { readonly started: boolean; readonly project: ApiProject } {
  if (!outcome.ok) assert.fail(`expected a started project, got ${outcome.code}: ${outcome.message}`);
  return outcome;
}

function mustBeRunning(project: ApiProject): Extract<ApiProjectProcess, { state: "running" }> {
  if (project.process.state !== "running") {
    assert.fail(`expected ${project.slug} to be running, got ${project.process.state}`);
  }
  return project.process;
}

interface Harness {
  readonly root: string;
  readonly paths: DashboardPaths;
  readonly runner: ProjectRunner;
  cleanup(): Promise<void>;
}

function makeHarness(options: {
  readonly portRange?: { readonly min: number; readonly max: number };
  readonly startTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly listeningPorts?: (pgid: number) => readonly number[];
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "dash-projects-"));
  const paths = resolvePaths({ DASHBOARD_HOME: join(root, "dashboard"), DASHBOARD_PROJECTS_DIR: join(root, "projects") });
  ensureDirs(paths);
  mkdirSync(paths.projects, { recursive: true });
  const runner = new ProjectRunner({
    paths,
    portRange: options.portRange ?? { min: 4560, max: 4589 },
    startTimeoutMs: options.startTimeoutMs ?? 25_000,
    env: options.env ?? process.env,
    listeningPorts: options.listeningPorts,
  });
  return {
    root,
    paths,
    runner,
    cleanup: async () => {
      await runner.stopAll();
      sweepStrays(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Kill anything still running out of this harness's own temp directory.
 *
 * NOT BELT AND BRACES — MEASURED. The mutation battery this file exists to
 * satisfy left 23 orphaned `node server.mjs` processes holding ports 4560-4573,
 * 4592, 4622, 4683 and 4702-4706 on the owner's machine: a mutated runner loses
 * track of a child, `stopAll` never sees it, and `--test-force-exit` takes the
 * test runner down over the top of it. Under green code this finds nothing.
 *
 * SCOPED BY CWD, and that is the whole safety argument: the only processes
 * signalled are ones whose working directory is inside a `mkdtemp` directory
 * created by this function's own harness moments ago. The owner's real published
 * project runs out of `projects/` and can never match.
 */
function sweepStrays(root: string): void {
  // `lsof` reports RESOLVED paths: `mkdtemp` hands back `/var/folders/…` and the
  // same directory reads as `/private/var/folders/…` there. Comparing the
  // spelled path would match nothing and this whole function would be a sweep
  // that can only observe an empty machine.
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    return;
  }
  let out = "";
  try {
    out = execFileSync("lsof", ["-a", "-d", "cwd", "-c", "node", "-c", "npm", "-Fpn"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return;
  }
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
    if (!line.startsWith("n") || pid <= 1) continue;
    if (!line.slice(1).startsWith(real)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function writeProject(
  paths: DashboardPaths,
  slug: string,
  options: { readonly start?: string | null; readonly server?: string } = {},
): string {
  const dir = join(paths.projects, slug);
  mkdirSync(dir, { recursive: true });
  const scripts = options.start === null ? {} : { scripts: { start: options.start ?? "node server.mjs" } };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: slug, private: true, ...scripts }, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "server.mjs"), options.server ?? HONEST_SERVER, "utf8");
  return dir;
}

/**
 * Hold a port the way something else on the machine would.
 *
 * EVERY ACCEPTED SOCKET IS DESTROYED BEFORE `close()`, and it is not tidiness:
 * the readiness probe opens a TCP connection to whatever is on the port, and a
 * bare `net` server never answers it — so `server.close()`, which waits for
 * existing connections to end, NEVER CALLS BACK and the test file hangs forever
 * with no output at all. Measured: under mutation M2b (port allocation trusts
 * the range), a single-test run produced no TAP output in 180 s.
 * (`closeAllConnections` is `http.Server`'s, not `net.Server`'s — hence the set.)
 */
function occupy(port: number): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/**
 * A port window whose FIRST port was just measured free.
 *
 * Deriving a second window by arithmetic from one measured port ("free + 4")
 * asserts nothing about the second: those ports are assumed, and a test that
 * hits a taken one refuses with `no_free_port` and goes red for a reason that
 * has nothing to do with what it was written for. Each window a test needs gets
 * its own measurement.
 */
async function freeWindow(from: number, to: number, size: number): Promise<{ readonly min: number; readonly max: number }> {
  const min = await firstFreePort(from, to);
  return { min, max: Math.min(min + size - 1, to) };
}

async function firstFreePort(from: number, to: number): Promise<number> {
  for (let port = from; port <= to; port += 1) {
    try {
      const held = await occupy(port);
      await held.close();
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`no free port between ${String(from)} and ${String(to)}`);
}

/**
 * The children the next boot would try to kill.
 *
 * A MISSING FILE IS AN EMPTY LIST, and the distinction matters: the runner
 * writes this file only when it has a child to write down, so a start that
 * failed before spawning leaves no file rather than an empty one. Reading it
 * directly would throw ENOENT and report a bug where there is none.
 */
function persistedChildren(paths: DashboardPaths): readonly unknown[] {
  const file = join(paths.data, RUNNER_STATE_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { children: readonly unknown[] };
  return parsed.children;
}

async function waitForGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (processSignature(pid) === null) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/* -------------------------------------------------------------------------
 * Start, stop, and the URL in between
 * ---------------------------------------------------------------------- */

test("a started project answers on the port the dashboard gave it, and stops when asked", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "shop");
    const started = await harness.runner.start("shop");
    assert.equal(started.ok, true, "the fixture reads PORT and binds it, so this must start");
    assert.equal(started.started, true);
    const process1 = started.project.process;
    assert.equal(process1.state, "running");

    // THE CLAIM UNDER TEST IS THE URL, so the URL is what is exercised.
    const answer = await get(process1.url);
    assert.equal(answer.status, 200);
    const body = await answer.text();
    assert.match(body, /^project-ok /, "the child that answered is the fixture, not something else on the port");
    assert.match(body, /host=127\.0\.0\.1/, "HOST is passed, and it is loopback");
    assert.ok(
      process1.port >= 4560 && process1.port <= 4589,
      `the port came from the configured range, got ${String(process1.port)}`,
    );

    const listed = harness.runner.list();
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0]?.process.state, "running");
    assert.equal(listed.projects[0]?.startCommand, "npm start");

    const stopped = await harness.runner.stop("shop");
    assert.equal(stopped.ok, true);
    const after = stopped.project.process;
    assert.equal(after.state, "stopped", "an owner-requested exit is `stopped`, never `exited`");
    assert.equal(after.lastExit?.requested, true);
    assert.equal(await waitForGone(process1.pid, 3_000), true, "the child process is gone, not merely forgotten");
    // The port is genuinely released: something else can bind it now.
    const rebound = await occupy(process1.port);
    await rebound.close();
  } finally {
    await harness.cleanup();
  }
});

test("starting a project that is already running returns the same URL and does not spawn a second server", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "shop");
    const first = mustBeRunning(mustStart(await harness.runner.start("shop")).project);
    const secondOutcome = mustStart(await harness.runner.start("shop"));
    const second = mustBeRunning(secondOutcome.project);
    assert.equal(secondOutcome.started, false, "the second call started nothing");
    assert.equal(second.pid, first.pid, "and it is the SAME process");
    assert.equal(second.url, first.url);
    assert.equal(harness.runner.list().projects.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("a symlink alias for a running project starts the SAME child, not a second server on one database", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "shop");
    // A link INSIDE projects/, pointing at a sibling. It resolves cleanly and is
    // rightly allowed — it never leaves the root.
    //
    // WHAT THIS TEST MEASURES AND WHAT IT DOES NOT, because it was offered as
    // proof of an invariant it does not cover. It measures ONE mechanism:
    // `realpathSync` collapses a symlink, so both slugs produce the same
    // resolved path and therefore the same key. It is NOT proof that "one
    // directory is one child" — it passed unchanged against the runner this
    // file shipped with, which keyed children by the resolved path STRING, and
    // that string is not one-per-directory on this filesystem. macOS
    // `realpathSync` resolves symlinks but does not case-fold (measured: with
    // `projects/shop` on disk, `realpathSync('…/projects/SHOP')` returns
    // `…/projects/SHOP`), and `SLUG_PATTERN` allows `A-Z` — so `shop` and
    // `SHOP` were two keys, two ports and two `npm start` processes in one
    // folder. That case is covered by "two spellings of one directory are one
    // child" below; this one covers only the link.
    symlinkSync(join(harness.paths.projects, "shop"), join(harness.paths.projects, "alias"));

    const direct = mustBeRunning(mustStart(await harness.runner.start("shop")).project);
    const aliasOutcome = mustStart(await harness.runner.start("alias"));
    const viaAlias = mustBeRunning(aliasOutcome.project);
    assert.equal(aliasOutcome.started, false, "the alias names a project that is already running");
    assert.equal(viaAlias.pid, direct.pid, "and it is the same process");
    assert.equal(viaAlias.port, direct.port, "on the same port");

    // Stopping through the alias stops the one child.
    const stopped = await harness.runner.stop("alias");
    assert.equal(stopped.ok, true);
    assert.equal(await waitForGone(direct.pid, 3_000), true);
  } finally {
    await harness.cleanup();
  }
});

/**
 * The case-variant reproduction, from the review of 2026-08-02.
 *
 * `start("shop")` gave pid 24124 on port 4460 and `start("SHOP")` gave pid 24153
 * on 4461 — two `npm start` processes in one folder, on the SQLite file
 * `project-handover.ts` dumps the schema of. `list()` showed only
 * `shop:running`, because it enumerates real directory names, so the second
 * child was invisible to GET /api/projects and unreachable by `stop("shop")`.
 *
 * BOTH HALVES ARE ASSERTED. Same pid is the first half; one project in `list()`
 * and nothing alive after one `stop` is the second, and without it a runner that
 * merely returned the first child's details while spawning a second would still
 * pass.
 */
test("two spellings of one directory are one child, on a filesystem that does not care about case", TEST_OPTIONS, async (t) => {
  const harness = makeHarness();
  try {
    const dir = writeProject(harness.paths, "shop");
    const upper = join(harness.paths.projects, "SHOP");
    if (!existsSync(upper)) {
      // A case-SENSITIVE filesystem. `SHOP` is a genuinely different directory
      // there, two children WOULD be correct, and there is nothing here to
      // measure — so this says so instead of reporting a pass it did not earn.
      t.skip("case-sensitive filesystem: two spellings are two directories here, so the defect cannot occur");
      return;
    }
    // THE CAUSE, MEASURED IN THE TEST rather than asserted from the module's
    // own key. One directory by the filesystem's reckoning, two strings by
    // realpath's — which is exactly why the resolved path is not a usable key.
    assert.equal(statSync(upper).ino, statSync(dir).ino, "the two spellings are one directory");
    assert.equal(statSync(upper).dev, statSync(dir).dev);
    assert.ok(realpathSync(upper).endsWith("SHOP"), "realpathSync does not case-fold, and that is the defect's cause");

    const direct = mustBeRunning(mustStart(await harness.runner.start("shop")).project);
    const upperOutcome = mustStart(await harness.runner.start("SHOP"));
    const viaUpper = mustBeRunning(upperOutcome.project);
    assert.equal(upperOutcome.started, false, "the other spelling names a directory that is already running");
    assert.equal(viaUpper.pid, direct.pid, "and it is the SAME process, not a second npm start in one folder");
    assert.equal(viaUpper.port, direct.port, "on the same port");

    // THE INVISIBLE SECOND CHILD. This is what made the defect dangerous: a
    // child keyed under `SHOP` never appeared here and no stop could reach it.
    const listed = harness.runner.list().projects;
    assert.equal(listed.length, 1, `one folder on disk is one project, got ${JSON.stringify(listed.map((p) => p.slug))}`);
    assert.equal(listed[0]?.process.state, "running");

    const stopped = await harness.runner.stop("shop");
    assert.equal(stopped.ok, true);
    assert.equal(await waitForGone(direct.pid, 3_000), true, "one stop left nothing alive");
    // The port really came back, which a second child on a second port would
    // not have prevented — this is about the first one, and it is cheap.
    const rebound = await occupy(direct.port);
    await rebound.close();

    // THE IN-FLIGHT MAP IS KEYED THE SAME WAY, and the sequential pair above
    // cannot observe it: by the time the second call runs, the first has
    // finished and the in-flight entry is gone. Two clicks that arrive together
    // are what exercise it.
    const [a, b] = await Promise.all([harness.runner.start("shop"), harness.runner.start("SHOP")]);
    const firstOfTwo = mustBeRunning(mustStart(a).project);
    const secondOfTwo = mustBeRunning(mustStart(b).project);
    assert.equal(secondOfTwo.pid, firstOfTwo.pid, "two simultaneous starts of one folder are one server");
    assert.equal(harness.runner.list().projects.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("stopping a project that is not running is a named refusal, not a silent success", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "shop");
    const outcome = await harness.runner.stop("shop");
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail("expected a named refusal, got a success");
    assert.equal(outcome.code, "not_running");
    assert.equal(outcome.status, 409);
    assert.match(outcome.message, /shop/);
  } finally {
    await harness.cleanup();
  }
});

test("two projects run at once, on different ports, and stopping one leaves the other serving", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "one");
    writeProject(harness.paths, "two");
    const first = mustBeRunning(mustStart(await harness.runner.start("one")).project);
    const second = mustBeRunning(mustStart(await harness.runner.start("two")).project);

    assert.notEqual(first.port, second.port, "a hardcoded port would let only one project exist");
    assert.equal((await get(first.url)).status, 200);
    assert.equal((await get(second.url)).status, 200);

    await harness.runner.stop("one");
    assert.equal((await get(second.url)).status, 200, "the survivor is untouched by the other's stop");
  } finally {
    await harness.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * Ports
 * ---------------------------------------------------------------------- */

test("a range with nothing free is a named refusal, and the same range works once the port is released", TEST_OPTIONS, async () => {
  const free = await firstFreePort(4592, 4620);
  const held = await occupy(free);
  const harness = makeHarness({ portRange: { min: free, max: free } });
  try {
    writeProject(harness.paths, "shop");
    // THE WHOLE RANGE IS ONE PORT AND SOMETHING ELSE HOLDS IT. Freeness is
    // measured, so this must refuse rather than spawn a child onto a taken port.
    const refused = await harness.runner.start("shop");
    assert.equal(refused.ok, false);
    if (refused.ok) assert.fail("a fully occupied range must refuse, not spawn");
    assert.equal(refused.code, "no_free_port");
    assert.equal(refused.status, 503);

    await held.close();
    const started = mustBeRunning(mustStart(await harness.runner.start("shop")).project);
    assert.equal(started.port, free, "the same one-port range works the moment the port is released");
  } finally {
    await harness.cleanup();
  }
});

test("a port that something else already holds is skipped rather than handed to a child", TEST_OPTIONS, async () => {
  const first = await firstFreePort(4682, 4700);
  const held = await occupy(first);
  const harness = makeHarness({ portRange: { min: first, max: first + 3 } });
  try {
    writeProject(harness.paths, "shop");
    const started = mustBeRunning(mustStart(await harness.runner.start("shop")).project);
    assert.notEqual(
      started.port,
      first,
      "the first port in the range is taken; assuming a range is clear is the bug this asserts against",
    );
    assert.equal((await get(started.url)).status, 200, "and the port it did pick actually serves");
  } finally {
    await harness.cleanup();
    await held.close();
  }
});

test("the default port range is the dedicated one, and it is what a runner with no override reports", () => {
  assert.equal(PROJECT_PORT_MIN, 4400);
  assert.equal(PROJECT_PORT_MAX, 4499);
  const root = mkdtempSync(join(tmpdir(), "dash-projects-range-"));
  try {
    const paths = resolvePaths({ DASHBOARD_HOME: join(root, "dashboard"), DASHBOARD_PROJECTS_DIR: join(root, "projects") });
    const runner = new ProjectRunner({ paths });
    assert.deepEqual(runner.portRange, { min: 4400, max: 4499 });
    assert.deepEqual(runner.list().projects, [], "no projects directory is an empty list, not a throw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Failures to start
 * ---------------------------------------------------------------------- */

/**
 * The spawn that used to kill the dashboard, from the review of 2026-08-02.
 *
 * `#start` read `child.pid` and returned the `start_failed` refusal BEFORE
 * attaching `child.on("error")`. Node reports ENOENT and EACCES from `spawn`
 * ASYNCHRONOUSLY — `pid` is `undefined` and the `error` event lands on the next
 * tick — and an `error` event with no listener is an uncaught exception. There
 * is no `uncaughtException` handler anywhere in server/src, so the measured
 * outcome was: the call returns its helpful 500, and the process then dies with
 * `Error: spawn npm ENOENT`, exit 1. The refusal could never reach the owner
 * alive, `shutdown()` never ran, and every project child already running became
 * a detached orphan holding a port.
 *
 * THE ENVIRONMENT IS THE REPRODUCTION, and it is the owner's own failure mode
 * rather than a contrivance: `childEnv` copies `PATH` out of the runner's
 * configured environment, libuv resolves the command with the CHILD's `PATH`,
 * so a dashboard launched from a GUI with no npm on its `PATH` spawns exactly
 * this. Measured on node v25.9.0 before the fix: `pid = undefined`, then
 * `Unhandled 'error' event … Error: spawn npm ENOENT`, exit code 1.
 *
 * THIS TEST CANNOT PASS WITHOUT THE LISTENER. Against the old code it does not
 * fail — it takes the whole test runner down, which node:test reports as a
 * crashed file rather than a red assertion.
 */
test("a spawn that fails hands back the reason and leaves the dashboard alive", TEST_OPTIONS, async () => {
  // THREE SEPARATELY MEASURED WINDOWS, so that `no_free_port` cannot shadow the
  // branch under test: port allocation happens BEFORE the spawn, and a
  // contended range would make this test refuse for a reason that has nothing
  // to do with a failed spawn. See {@link freeWindow}.
  const brokenWindow = await freeWindow(4732, 4740, 3);
  const healthyWindow = await freeWindow(4741, 4750, 3);
  const witnessWindow = await freeWindow(4751, 4760, 3);
  const broken = makeHarness({
    portRange: brokenWindow,
    // No npm here, and nothing else either: the allowlist copies only names that
    // are present, so the child gets PATH, PORT and HOST.
    env: { PATH: NO_NPM_PATH },
  });
  // A SECOND RUNNER WITH A WORKING ENVIRONMENT, used after the failure as the
  // liveness witness. Asserting "we got here" would be circular in a process
  // that had already died; starting a real child proves the event loop, the
  // spawn path and this file's own bookkeeping all still work.
  const healthy = makeHarness({ portRange: healthyWindow });
  // A THIRD, for the out-of-process witness. Its runner is never used from
  // here — only its directories are, by the child in {@link runWitness}.
  const witness = makeHarness();
  try {
    writeProject(broken.paths, "shop");
    const outcome = await broken.runner.start("shop");

    assert.equal(outcome.ok, false, "npm is not on that PATH, so nothing can have started");
    if (outcome.ok) assert.fail("expected a named refusal, got a success");
    assert.equal(outcome.code, "start_failed", `got ${outcome.code}: ${outcome.message}`);
    assert.equal(outcome.status, 500);
    assert.match(outcome.message, /shop/);
    // THE REASON, NOT A GUESS. It arrives on the `error` event a tick after
    // `spawn` returns; a refusal that returned before waiting for it could only
    // ever say "npm did not start".
    assert.match(outcome.message, /ENOENT/, "the refusal carries what spawn actually reported");

    // Nothing was recorded as running, and nothing was left in the durable
    // state for the NEXT boot to go hunting for with a signal. The state file
    // does not exist at all here, which is stronger than an empty one and is
    // why this reads it through `persistedChildren`: a start that never
    // produced a process has nothing to write down.
    assert.equal(broken.runner.list().projects[0]?.process.state, "stopped");
    assert.equal(existsSync(join(broken.paths.data, RUNNER_STATE_FILE)), false);
    assert.deepEqual(persistedChildren(broken.paths), [], "a spawn that never produced a process leaves no record of one");

    // THE PROCESS SURVIVED, and the proof is work it does afterwards.
    writeProject(healthy.paths, "survivor");
    const after = mustBeRunning(mustStart(await healthy.runner.start("survivor")).project);
    assert.equal((await get(after.url)).status, 200, "the dashboard still starts projects after a failed spawn");

    // …AND IT SURVIVES WITH NOTHING CATCHING FOR IT. See {@link runWitness}:
    // node:test's own uncaughtException handler kept the two assertions above
    // reachable even against the unfixed runner, so on their own they do not
    // measure the defect. This one has no handler over it, exactly like the
    // dashboard.
    writeProject(witness.paths, "shop");
    const result = await runWitness(
      `const { ProjectRunner } = await import(${JSON.stringify(new URL("./project-runner.js", import.meta.url).href)});
const { resolvePaths } = await import(${JSON.stringify(new URL("./paths.js", import.meta.url).href)});
const paths = resolvePaths({
  DASHBOARD_HOME: ${JSON.stringify(witness.paths.home)},
  DASHBOARD_PROJECTS_DIR: ${JSON.stringify(witness.paths.projects)},
});
const runner = new ProjectRunner({
  paths,
  portRange: { min: ${String(witnessWindow.min)}, max: ${String(witnessWindow.max)} },
  env: { PATH: ${JSON.stringify(NO_NPM_PATH)} },
});
const outcome = await runner.start("shop");
console.log("REFUSED " + (outcome.ok ? "no" : outcome.code));
// The 'error' event lands a tick after spawn returns. Wait well past that with
// the loop turning, so a process that is going to die has died before this
// claims it did not.
await new Promise((resolve) => setTimeout(resolve, 750));
console.log("ALIVE");
`,
      20_000,
    );
    assert.equal(result.timedOut, false, `the witness never finished: ${result.out}`);
    assert.match(result.out, /REFUSED start_failed/, `the witness's own report was: ${result.out}`);
    assert.match(result.out, /ALIVE/, "a process with no uncaughtException handler must survive a failed spawn");
    assert.equal(result.code, 0, `the witness exited ${String(result.code)}, output: ${result.out}`);
    assert.doesNotMatch(result.out, /Unhandled 'error' event/, "nothing was left for the runtime to complain about");
  } finally {
    await witness.cleanup();
    await healthy.cleanup();
    await broken.cleanup();
  }
});

test("a project with no start script is refused before anything is spawned", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "static-site", { start: null });
    const outcome = await harness.runner.start("static-site");
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail("expected a named refusal, got a success");
    assert.equal(outcome.code, "no_start_script");
    assert.equal(outcome.status, 409);
    assert.equal(startCommandFor(join(harness.paths.projects, "static-site")), null);
    // Nothing was started, so nothing is listed as running.
    assert.equal(harness.runner.list().projects[0]?.process.state, "stopped");
    assert.equal(harness.runner.list().projects[0]?.startCommand, null);
  } finally {
    await harness.cleanup();
  }
});

test("a child that never listens is killed, and the refusal carries its own stderr", TEST_OPTIONS, async () => {
  const harness = makeHarness({ startTimeoutMs: 2_500 });
  try {
    writeProject(harness.paths, "broken", { server: SILENT_SERVER });
    const before = Date.now();
    const outcome = await harness.runner.start("broken");
    assert.equal(outcome.ok, false, "a spawn that succeeded is NOT a start that served");
    if (outcome.ok) assert.fail("expected a named refusal, got a success");
    assert.equal(outcome.code, "start_timeout");
    assert.equal(outcome.status, 504);
    assert.match(outcome.message, /DATABASE_URL is not set/, "the child's own complaint reaches the caller");
    assert.ok(Date.now() - before >= 2_000, "it really waited for the timeout rather than giving up on spawn");

    const listed = harness.runner.list().projects[0];
    assert.notEqual(listed?.process.state, "running", "a timed-out start must never be reported as running");
    // And it was killed: the state file records no live child.
    const state = JSON.parse(readFileSync(join(harness.paths.data, RUNNER_STATE_FILE), "utf8")) as {
      children: readonly unknown[];
    };
    assert.deepEqual(state.children, [], "the killed child is not left in the durable state either");
  } finally {
    await harness.cleanup();
  }
});

test("a child that exits immediately is reported as exited, with its error, and not as a timeout", TEST_OPTIONS, async () => {
  const harness = makeHarness({ startTimeoutMs: 20_000 });
  try {
    writeProject(harness.paths, "missing-dep", { server: CRASHING_SERVER });
    const outcome = await harness.runner.start("missing-dep");
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail("expected a named refusal, got a success");
    assert.equal(outcome.code, "start_exited", "a crash is a different fact from a hang, and waits 20 s less");
    assert.match(outcome.message, /Cannot find module/);
  } finally {
    await harness.cleanup();
  }
});

test("a project that ignores PORT and binds its own is refused by name, not handed back as a URL", TEST_OPTIONS, async () => {
  const fixed = await firstFreePort(4622, 4650);
  const harness = makeHarness({
    startTimeoutMs: 2_500,
    // The seam, holding the port the fixture really took. The DEFAULT
    // implementation is exercised for real by the lsof test below; injecting
    // here keeps this test about the refusal rather than about lsof's output
    // format.
    listeningPorts: () => [fixed],
  });
  try {
    writeProject(harness.paths, "stubborn", {
      server: `import { createServer } from "node:http";
createServer((_q, s) => s.end("fixed")).listen(${String(fixed)}, "127.0.0.1", () => console.log("bound ${String(fixed)}"));
`,
    });
    const outcome = await harness.runner.start("stubborn");
    assert.equal(outcome.ok, false, "the assigned port never answered, so there is no URL to hand over");
    if (outcome.ok) assert.fail("expected a named refusal, got a success");
    assert.equal(outcome.code, "bound_elsewhere");
    assert.match(outcome.message, new RegExp(String(fixed)), "the refusal names the port it actually took");
    // AND IT WAS STOPPED. A child we refuse to report must not be left holding
    // a port nothing in the dashboard can name — so the port it took is free.
    const rebound = await occupy(fixed);
    await rebound.close();
  } finally {
    await harness.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * The security boundary
 * ---------------------------------------------------------------------- */

test("a slug that escapes projects/ is refused — spelled, encoded, absolute, or through a symlink", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    const outside = join(harness.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "package.json"),
      `${JSON.stringify({ name: "outside", scripts: { start: "node -e \"process.exit(0)\"" } })}\n`,
      "utf8",
    );
    symlinkSync(outside, join(harness.paths.projects, "escape"));
    writeProject(harness.paths, "shop");

    for (const slug of ["..", "../..", "a/b", "%2e%2e%2fetc", "/etc/passwd", "..%2fshop", "", "shop/../.."]) {
      const outcome = await harness.runner.start(slug);
      assert.equal(outcome.ok, false, `start(${JSON.stringify(slug)}) must refuse`);
      if (outcome.ok) continue;
      assert.ok(
        outcome.code === "invalid_project" || outcome.code === "unknown_project",
        `${JSON.stringify(slug)} refused as ${outcome.code}`,
      );
    }

    // THE SYMLINK IS THE ONE THAT MATTERS: the name passes every character
    // check and only the realpath re-check catches it.
    const linked = await harness.runner.start("escape");
    assert.equal(linked.ok, false, "a link out of projects/ must not become a spawned process");
    if (linked.ok) assert.fail("a link out of projects/ was resolved instead of refused");
    assert.equal(linked.code, "invalid_project");
    assert.match(linked.message, /outside/);

    // The resolver agrees, called directly.
    const direct = resolveProjectDir(harness.paths.projects, "escape");
    assert.equal(direct.ok, false);
    const good = resolveProjectDir(harness.paths.projects, "shop");
    assert.equal(good.ok, true, "and a real project still resolves — the check is not simply refusing everything");
  } finally {
    await harness.cleanup();
  }
});

test("the dashboard's own environment does not reach the child", TEST_OPTIONS, async () => {
  const marker = `sk-ant-api03-${"Z".repeat(32)}`;
  const harness = makeHarness({ env: { ...process.env, ANTHROPIC_API_KEY: marker, DASHBOARD_SECRET_PROBE: marker } });
  try {
    writeProject(harness.paths, "shop");
    const started = mustBeRunning(mustStart(await harness.runner.start("shop")).project);

    // THE WITNESS IS INSIDE THE CHILD. It printed what it could actually see.
    const body = await (await get(started.url)).text();
    assert.match(body, /key=absent/, "a generated server must not be able to read the owner's provider credentials");
    assert.doesNotMatch(body, /sk-ant/);

    const logs = harness.runner.logs("shop");
    assert.equal(logs.ok, true);
    assert.doesNotMatch(JSON.stringify(logs.logs), /Z{10}/, "and the marker is nowhere in what we kept either");

    // The allowlist is what crossed, and PORT/HOST were added.
    const env = childEnv({ PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: marker }, 4400);
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "HOST", "PATH", "PORT"]);
    assert.equal(env["PORT"], "4400");
    assert.equal(env["HOST"], "127.0.0.1");
    assert.ok(!CHILD_ENV_ALLOWLIST.includes("ANTHROPIC_API_KEY"));
  } finally {
    await harness.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * Logs
 * ---------------------------------------------------------------------- */

test("logs are bounded, say what they dropped, and are redacted before they are kept", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "chatty", { server: CHATTY_SERVER });
    const started = await harness.runner.start("chatty");
    assert.equal(started.ok, true);

    const outcome = harness.runner.logs("chatty");
    assert.equal(outcome.ok, true);
    const logs = outcome.logs;
    assert.ok(logs.lines.length <= MAX_LOG_LINES, `kept ${String(logs.lines.length)} lines, cap is ${String(MAX_LOG_LINES)}`);
    assert.ok(logs.dropped > 0, "500 lines into a 200-line window must report the loss rather than hide it");
    assert.equal(logs.maxLines, MAX_LOG_LINES);

    const text = JSON.stringify(logs.lines);
    assert.doesNotMatch(text, /sk-ant-api03/, "an API-key shape in a project's own output never reaches the response");
    assert.match(text, /REDACTED/, "…and it is visibly redacted rather than silently dropped");
    assert.match(text, /line \d+/, "the surrounding output is still readable");
  } finally {
    await harness.cleanup();
  }
});

test("a project that has never run answers with an empty log window, and an unknown one with a refusal", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "shop");
    const quiet = harness.runner.logs("shop");
    assert.equal(quiet.ok, true);
    assert.deepEqual(quiet.logs.lines, [], "nothing recorded is an empty window, not an error");
    assert.equal(quiet.logs.dropped, 0);

    const missing = harness.runner.logs("no-such-project");
    assert.equal(missing.ok, false);
    if (missing.ok) assert.fail("an unknown project must be refused, not answered");
    assert.equal(missing.code, "unknown_project");
    assert.equal(missing.status, 404);
  } finally {
    await harness.cleanup();
  }
});

/* -------------------------------------------------------------------------
 * No orphans
 * ---------------------------------------------------------------------- */

test("shutdown kills every child, and the state file it leaves behind names none", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    writeProject(harness.paths, "one");
    writeProject(harness.paths, "two");
    const first = mustBeRunning(mustStart(await harness.runner.start("one")).project);
    const second = mustBeRunning(mustStart(await harness.runner.start("two")).project);
    const pids = [first.pid, second.pid];
    const ports = [first.port, second.port];

    const startedAt = Date.now();
    await harness.runner.stopAll();
    const spent = Date.now() - startedAt;

    for (const pid of pids) {
      assert.equal(await waitForGone(pid, 3_000), true, `pid ${String(pid)} survived shutdown`);
    }
    for (const port of ports) {
      const rebound = await occupy(port);
      await rebound.close();
    }
    // BUDGETED AGAINST `index.ts`'s 3 s HARD EXIT. Two well-behaved children
    // must be gone in a fraction of it, or the last one is orphaned by
    // `process.exit`.
    assert.ok(spent < 3_000, `stopAll took ${String(spent)} ms, which is inside the shutdown budget`);
    const state = JSON.parse(readFileSync(join(harness.paths.data, RUNNER_STATE_FILE), "utf8")) as {
      children: readonly unknown[];
    };
    assert.deepEqual(state.children, []);
  } finally {
    await harness.cleanup();
  }
});

test("reconcileOnBoot kills a survivor it can verify, and starts nothing", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  // A stand-in for a child a dead dashboard left behind: detached, so it is its
  // own process group exactly as a real one is. Registered before the `try`
  // opens so that no assertion can be reached without a teardown behind it.
  const pid = spawnFixture(IDLE_FIXTURE);
  try {
    writeProject(harness.paths, "shop");
    writeFileSync(
      join(harness.paths.data, RUNNER_STATE_FILE),
      `${JSON.stringify({
        writtenAt: new Date().toISOString(),
        children: [
          {
            slug: "shop",
            directory: join(harness.paths.projects, "shop"),
            port: 4571,
            pid,
            pgid: pid,
            startedAt: new Date().toISOString(),
            signature: processSignature(pid),
          },
        ],
      })}\n`,
      "utf8",
    );

    const report = harness.runner.reconcileOnBoot();
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0]?.outcome, "killed");
    assert.equal(await waitForGone(pid, 3_000), true, "the orphan is gone");
    // AND NOTHING WAS STARTED. Boot never spawns.
    assert.equal(harness.runner.list().projects[0]?.process.state, "stopped");
    const state = JSON.parse(readFileSync(join(harness.paths.data, RUNNER_STATE_FILE), "utf8")) as {
      children: readonly unknown[];
    };
    assert.deepEqual(state.children, [], "and the stale record is cleared, so the next boot does not retry it");
  } finally {
    killFixture(pid);
    await harness.cleanup();
  }
});

test(
  "reconcileOnBoot leaves alone a pid it cannot verify, and refuses an unsafe process group outright",
  TEST_OPTIONS,
  async () => {
  const harness = makeHarness();
  // THIS FIXTURE IS THE ONE THAT LEAKED. `reconcileOnBoot` is required NOT to
  // kill it — that is the claim — so the test itself is the only thing that
  // ever will, and the kill used to sit after five assertions inside the `try`.
  const pid = spawnFixture(IDLE_FIXTURE);
  try {
    writeFileSync(
      join(harness.paths.data, RUNNER_STATE_FILE),
      `${JSON.stringify({
        writtenAt: new Date().toISOString(),
        children: [
          // A RECYCLED PID: alive, but not the process we started. The recorded
          // signature does not match what `ps` says now.
          { slug: "recycled", directory: "/tmp/x", port: 4572, pid, pgid: pid, startedAt: "", signature: "node -e something-else" },
          // Group 0 is THIS process's group. Signalling it would kill the
          // dashboard, and on this machine, the test runner.
          { slug: "zero", directory: "/tmp/x", port: 4573, pid: 999_999, pgid: 0, startedAt: "", signature: "x" },
          { slug: "self", directory: "/tmp/x", port: 4574, pid: process.pid, pgid: process.pid, startedAt: "", signature: "x" },
        ],
      })}\n`,
      "utf8",
    );

    const report = harness.runner.reconcileOnBoot();
    const byslug = new Map(report.entries.map((entry) => [entry.slug, entry.outcome]));
    assert.equal(byslug.get("recycled"), "unverifiable");
    assert.equal(byslug.get("zero"), "refused-unsafe-group");
    assert.equal(byslug.get("self"), "refused-unsafe-group");
    assert.equal(processSignature(pid) !== null, true, "the process we could not verify is still running");

    // The guard, stated directly.
    assert.equal(safeToSignalGroup(0, { pid: 10, pgid: 11 }), false);
    assert.equal(safeToSignalGroup(1, { pid: 10, pgid: 11 }), false);
    assert.equal(safeToSignalGroup(10, { pid: 10, pgid: 11 }), false);
    assert.equal(safeToSignalGroup(11, { pid: 10, pgid: 11 }), false);
    assert.equal(safeToSignalGroup(4321, { pid: 10, pgid: 11 }), true);
  } finally {
    killFixture(pid);
    await harness.cleanup();
  }
  },
);

/* -------------------------------------------------------------------------
 * The lsof helper, for real
 * ---------------------------------------------------------------------- */

test("listeningPortsForGroup finds a real listening port, and answers nothing for a group that has none", TEST_OPTIONS, async () => {
  const port = await firstFreePort(4652, 4680);
  const pid = spawnFixture(
    `require("node:net").createServer().listen(${String(port)}, "127.0.0.1", () => setInterval(() => {}, 1000));`,
  );
  try {
    // Give it a moment to bind before asking.
    let found: readonly number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      found = listeningPortsForGroup(pid);
      if (found.includes(port)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(found.includes(port), `expected ${String(port)} in ${JSON.stringify(found)}`);
    // A pgid that cannot be a real group answers empty rather than listing the
    // whole machine — which is what the missing `-a` would do.
    assert.deepEqual(listeningPortsForGroup(0), []);
    assert.deepEqual(listeningPortsForGroup(-5), []);
  } finally {
    killFixture(pid);
  }
});

/* -------------------------------------------------------------------------
 * The list
 * ---------------------------------------------------------------------- */

test("the list names the run that published each folder, and says whether it has a repository", TEST_OPTIONS, async () => {
  const harness = makeHarness();
  try {
    const dir = writeProject(harness.paths, "shop");
    mkdirSync(join(dir, ".git"), { recursive: true });
    const results = join(harness.paths.runs, "run-abc", "results");
    mkdirSync(results, { recursive: true });
    writeFileSync(
      join(results, "project-publish.json"),
      `${JSON.stringify({ published: true, runId: "run-abc", path: dir, publishedAt: "", fileCount: 1, bytes: 1 })}\n`,
      "utf8",
    );

    const listed = harness.runner.list().projects;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.slug, "shop");
    assert.equal(listed[0]?.runId, "run-abc", "without this the projects list cannot reach POST /api/runs/:id/publish");
    assert.equal(listed[0]?.hasRepository, true);
    assert.equal(existsSync(join(dir, ".git")), true);
  } finally {
    await harness.cleanup();
  }
});

test("A STARTED PROJECT CANNOT READ THE SEALED SUITE — the reproduction, as a test", TEST_OPTIONS, async () => {
  // REPRODUCED against this code on 2026-08-03, before the seatbelt existed. A
  // published project's package.json was {"scripts":{"start":"node server.mjs"}}
  // and its server.mjs read `../../dashboard/acceptance/<file>`; the bytes came
  // back out of `GET /api/projects/:slug/logs`:
  //
  //     "text":"READ-UP-TWO: SEALED-SUITE-REACHABILITY-SENTINEL-1785733812"
  //
  // Every step is ordinary use — a build agent writes the start script,
  // `project-publish.ts` copies package.json verbatim, the owner clicks Start.
  // STATUS.md §0 credits FOUR layers with keeping a build out of the sealed
  // suite; all four are Claude-CLI `Options`, and a bare `spawn` reaches none of
  // them.
  const harness = makeHarness();
  try {
    const sentinel = "SEALED-REACHABILITY-SENTINEL-DO-NOT-LEAK";
    mkdirSync(harness.paths.acceptance, { recursive: true });
    const target = join(harness.paths.acceptance, "sentinel.txt");
    writeFileSync(target, sentinel, "utf8");

    writeProject(harness.paths, "sealed-probe", {
      server: [
        'import { readFileSync } from "node:fs";',
        'import { createServer } from "node:http";',
        `try { console.log("SEALED-READ:", readFileSync(${JSON.stringify(target)}, "utf8").trim()); }`,
        'catch (e) { console.log("SEALED-READ-REFUSED:", e.code); }',
        'createServer((_q, s) => s.end("ok")).listen(Number(process.env.PORT ?? 3000), "127.0.0.1");',
      ].join("\n"),
    });

    const started = await harness.runner.start("sealed-probe");
    // A boundary that breaks the feature is not a fix: it must still start.
    assert.equal(started.ok, true, `the project did not start: ${JSON.stringify(started)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const text = JSON.stringify(harness.runner.logs("sealed-probe"));

    // THE ASSERTION THAT MATTERS IS ON THE SENTINEL, not on the refusal message:
    // a future change that stops the child printing anything would satisfy
    // "no EPERM appears" while leaking exactly as badly.
    assert.equal(text.includes(sentinel), false, `the sealed suite reached the log ring: ${text}`);
    assert.ok(text.includes("SEALED-READ-REFUSED"), `expected a refused read, got: ${text}`);
  } finally {
    await harness.cleanup();
  }
});

test("the sandbox profile names every root whose contents decide a verdict or hold a credential", () => {
  // A deny-list, so an omission is silent. `projects` must NOT be on it — it is
  // the child's own cwd, and denying it would mean nothing ever starts.
  const harness = makeHarness();
  try {
    const profile = projectSandboxProfile(harness.paths);
    for (const root of ["acceptance", "data", "results", "runs"] as const) {
      mkdirSync(harness.paths[root], { recursive: true });
      assert.ok(
        profile.includes(JSON.stringify(realpathSync(harness.paths[root]))) ||
          profile.includes(JSON.stringify(harness.paths[root])),
        `${root} is not denied:\n${profile}`,
      );
    }
    assert.equal(
      profile.includes(`(subpath ${JSON.stringify(harness.paths.projects)})`),
      false,
      "denying the child its own cwd would break every start",
    );
    assert.ok(profile.startsWith("(version 1)"), profile);
  } finally {
    void harness.cleanup();
  }
});
