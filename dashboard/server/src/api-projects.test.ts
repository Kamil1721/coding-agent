/**
 * api-projects.test.ts — the four project routes and the re-publish route, over
 * a real loopback server.
 *
 * THE ROUTER IS THE THING UNDER TEST, not the runner: `project-runner.test.ts`
 * drives the child processes, the ports and the kills directly. What is checked
 * here is the layer between — that a refusal keeps its own status and code
 * instead of becoming a 500, that the slug reaches the resolver STILL ENCODED,
 * that a running project's URL survives serialization, and that
 * `POST /api/runs/:id/publish` really does give the one folder on disk a
 * repository.
 *
 * The orchestrator is stubbed for `api.test.ts`'s reason: starting a real run
 * spawns a builder and spends the owner's quota. The publish path is NOT
 * stubbed — it copies real files and runs real git into a temp directory,
 * because "the owner's existing project gains a repository" is the whole claim.
 *
 * EVERY HARNESS HERE STARTS REAL CHILD PROCESSES, so teardown does not depend on
 * a test reaching its own last line: see {@link openHarnesses}. And nothing
 * waits on a socket without a bound — every request goes through {@link ask} and
 * every test carries {@link TEST_OPTIONS} — because the failure this file was
 * measured hitting under a contended port range was not a red test, it was a run
 * that printed nothing and never returned.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type {
  ApiErrorResponse,
  ApiProjectLogs,
  ApiProjectStartResponse,
  ApiProjectStopResponse,
  ApiProjectsResponse,
  ApiRepublishResponse,
} from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";
import { ProjectRunner } from "./project-runner.js";

const HONEST_SERVER = `import { createServer } from "node:http";
createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("project-ok");
}).listen(Number(process.env.PORT ?? "0"), process.env.HOST ?? "127.0.0.1", () => {
  console.log("listening on " + process.env.PORT);
});
`;

/**
 * How long any one test here may take before node:test calls it failed.
 *
 * The slowest test starts one real `npm start` and waits for it to answer —
 * under a second, measured. 90 s is a bound rather than a tuning knob, and its
 * purpose is that a request to a port some leaked process is holding produces a
 * RED test with a name on it instead of a run that hangs. Stated honestly: the
 * timeout fails the test but does NOT cancel the body, which is why
 * {@link openHarnesses} exists underneath it.
 */
const TEST_OPTIONS = { timeout: 90_000 } as const;

/** Per request in this file. See {@link ask}. */
const FETCH_TIMEOUT_MS = 10_000;
const DASHBOARD_ORIGIN = `http://${LOOPBACK_HOST}:4319`;

/**
 * A request that cannot hang.
 *
 * Bare `fetch` waits forever on a socket that accepts and never answers, which
 * is exactly what a leaked child holding a port in this file's window looks
 * like. Everything on loopback here answers in milliseconds.
 */
function ask(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("Origin", DASHBOARD_ORIGIN);
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

interface Harness {
  readonly base: string;
  readonly root: string;
  readonly paths: DashboardPaths;
  readonly store: RunStore;
  readonly runner: ProjectRunner;
  close(): Promise<void>;
}

/**
 * Harnesses that have not been closed yet, so ONE teardown path reaches all of
 * them.
 *
 * MEASURED, NOT PRECAUTIONARY. Every harness here owns real `npm start`
 * children, spawned `detached: true` — they do NOT die with this process. A test
 * body abandoned by node:test's timeout never reaches its `finally`, and the
 * children it started go on holding ports in this file's 4702-4729 window for
 * the rest of the session. `after()` runs even for a file whose tests failed or
 * timed out, and {@link Harness.close} is idempotent so the ordinary `finally`
 * and this net cannot fight.
 */
const openHarnesses = new Set<Harness>();

after(async () => {
  for (const harness of [...openHarnesses]) await harness.close();
});

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "dash-api-projects-"));
  const paths = resolvePaths({ DASHBOARD_HOME: join(root, "dashboard"), DASHBOARD_PROJECTS_DIR: join(root, "projects") });
  ensureDirs(paths);
  mkdirSync(paths.projects, { recursive: true });

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ claudeBin: join(root, "no-claude"), codexBin: join(root, "no-codex"), env: process.env });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => false,
    resume: () => false,
    pushLiveMessage: () => false,
  };
  const runner = new ProjectRunner({
    paths,
    // A window of this test file's own, so it cannot collide with a dashboard
    // the owner has running on the real 4400-4499.
    portRange: { min: 4702, max: 4729 },
    startTimeoutMs: 20_000,
    env: process.env,
  });
  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    projects: runner,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
  });
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;
  let closed = false;
  const harness: Harness = {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    root,
    paths,
    store,
    runner,
    // IDEMPOTENT, because two teardown paths reach it: the test's own `finally`
    // and the `after()` net above. Closing an already-closed RunStore throws,
    // and a throw in `after()` would mask the failure the test was reporting.
    close: async () => {
      if (closed) return;
      closed = true;
      openHarnesses.delete(harness);
      await runner.stopAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  openHarnesses.add(harness);
  return harness;
}

function writeProject(paths: DashboardPaths, slug: string, withStart = true): string {
  const dir = join(paths.projects, slug);
  mkdirSync(dir, { recursive: true });
  const scripts = withStart ? { scripts: { start: "node server.mjs" } } : {};
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: slug, private: true, ...scripts }, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "server.mjs"), HONEST_SERVER, "utf8");
  return dir;
}

/* ---------------------------------------------------------------------- */

test("GET /api/projects lists the published folders and the port window they run in", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    writeProject(harness.paths, "coglane-landing");
    writeProject(harness.paths, "static-thing", false);
    const response = await ask(`${harness.base}/api/projects`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as ApiProjectsResponse;
    assert.deepEqual(
      body.projects.map((project) => project.slug),
      ["coglane-landing", "static-thing"],
    );
    assert.deepEqual(body.portRange, { min: 4702, max: 4729 });
    assert.equal(body.projects[0]?.startCommand, "npm start");
    assert.equal(body.projects[1]?.startCommand, null, "a folder with no start script says so before a button is drawn");
    assert.equal(body.projects[0]?.process.state, "stopped");
  } finally {
    await harness.close();
  }
});

test("POST start returns a URL that answers, POST stop ends it, and GET logs shows what it said", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    writeProject(harness.paths, "shop");
    const started = await ask(`${harness.base}/api/projects/shop/start`, { method: "POST" });
    // THE BODY IS READ BEFORE THE STATUS IS ASSERTED, so that a refusal names
    // itself. This assertion was measured failing as a bare `true !== false` on
    // a machine whose 4702-4729 window had been exhausted by leaked children:
    // the route had answered 503 `no_free_port` and said so, and the test threw
    // that away and reported a boolean.
    const body = (await started.json()) as ApiProjectStartResponse;
    assert.equal(started.status, 200, `POST start answered ${String(started.status)}: ${JSON.stringify(body)}`);
    assert.equal(body.started, true, `expected a project that started, got ${JSON.stringify(body)}`);
    if (body.project.process.state !== "running") {
      assert.fail(`expected a running project, got ${body.project.process.state}`);
    }
    const url = body.project.process.url;
    assert.match(url, /^http:\/\/127\.0\.0\.1:47\d\d$/, "loopback, in this runner's window");

    // THE URL IS THE PRODUCT. If it does not answer, the route lied.
    assert.equal(await (await ask(url)).text(), "project-ok");

    const logs = (await (await ask(`${harness.base}/api/projects/shop/logs`)).json()) as ApiProjectLogs;
    assert.equal(logs.slug, "shop");
    assert.ok(
      logs.lines.some((line) => line.text.includes("listening on")),
      `expected the child's own startup line, got ${JSON.stringify(logs.lines)}`,
    );

    const stopped = await ask(`${harness.base}/api/projects/shop/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    const stopBody = (await stopped.json()) as ApiProjectStopResponse;
    assert.equal(stopBody.stopped, true);
    assert.equal(stopBody.project.process.state, "stopped");

    // And the URL is dead, which is what "stopped" has to mean.
    await assert.rejects(ask(url), "nothing answers on the port after a stop");
  } finally {
    await harness.close();
  }
});

test("a second start answers 200 with the SAME url and started:false, not a second process", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    writeProject(harness.paths, "shop");
    const first = (await (await ask(`${harness.base}/api/projects/shop/start`, { method: "POST" })).json()) as
      ApiProjectStartResponse;
    const second = (await (await ask(`${harness.base}/api/projects/shop/start`, { method: "POST" })).json()) as
      ApiProjectStartResponse;
    assert.equal(second.started, false);
    if (first.project.process.state !== "running" || second.project.process.state !== "running") {
      assert.fail("both responses must describe a running project");
    }
    assert.equal(second.project.process.url, first.project.process.url);
    assert.equal(second.project.process.pid, first.project.process.pid);
  } finally {
    await harness.close();
  }
});

test("every project refusal keeps its own status and code in the error envelope", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    writeProject(harness.paths, "static-thing", false);

    const cases: readonly { path: string; method: string; status: number; code: string }[] = [
      { path: "/api/projects/nope/start", method: "POST", status: 404, code: "unknown_project" },
      { path: "/api/projects/static-thing/start", method: "POST", status: 409, code: "no_start_script" },
      { path: "/api/projects/static-thing/stop", method: "POST", status: 409, code: "not_running" },
      // STILL PERCENT-ENCODED WHEN IT REACHES THE RESOLVER. `URL.pathname` does
      // not decode and nothing in the router does either, so the `%` fails the
      // slug allowlist — the double-decode hole stays closed by construction.
      { path: "/api/projects/..%2fetc/start", method: "POST", status: 400, code: "invalid_project" },
      { path: "/api/projects/%2e%2e%2f%2e%2e/start", method: "POST", status: 400, code: "invalid_project" },
      { path: "/api/projects/nope/logs", method: "GET", status: 404, code: "unknown_project" },
      // Shape errors are the router's own.
      { path: "/api/projects/shop/restart", method: "POST", status: 404, code: "not_found" },
      { path: "/api/projects/shop/start", method: "GET", status: 404, code: "not_found" },
    ];
    for (const testCase of cases) {
      const response = await ask(`${harness.base}${testCase.path}`, { method: testCase.method });
      const body = (await response.json()) as ApiErrorResponse;
      assert.equal(response.status, testCase.status, `${testCase.method} ${testCase.path} -> ${String(response.status)}`);
      assert.equal(body.error, testCase.code, `${testCase.method} ${testCase.path} -> ${body.error}`);
      assert.equal(typeof body.message, "string");
    }
  } finally {
    await harness.close();
  }
});

test("a cross-origin POST cannot start, stop or publish — the routes that spawn and commit refuse it", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    writeProject(harness.paths, "shop");
    const runId = "run-2026-08-02T12-00-00-000Z-cccc4444";
    seedFinishedRun(harness, runId, "A shop");
    harness.store.updateRun(runId, { status: "failed", endedAt: new Date().toISOString() });

    for (const path of [`/api/projects/shop/start`, `/api/projects/shop/stop`, `/api/runs/${runId}/publish`]) {
      const response = await ask(`${harness.base}${path}`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(response.status, 403, `${path} answered ${String(response.status)}`);
      assert.equal(((await response.json()) as ApiErrorResponse).error, "cross_origin_write");
    }
    for (const path of [`/api/projects/shop/start`, `/api/projects/shop/stop`]) {
      for (const origin of ["http://127.0.0.1:4321", undefined]) {
        const init: RequestInit = {
          method: "POST",
          ...(origin === undefined ? {} : { headers: { Origin: origin } }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        };
        const response =
          origin === undefined ? await fetch(`${harness.base}${path}`, init) : await ask(`${harness.base}${path}`, init);
        assert.equal(response.status, 403, `${path} accepted ${origin ?? "an absent origin"}`);
      }
    }
    for (const origin of ["http://127.0.0.1:4321", undefined]) {
      const init: RequestInit = {
        method: "POST",
        ...(origin === undefined ? {} : { headers: { Origin: origin } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      };
      const response =
        origin === undefined
          ? await fetch(`${harness.base}/api/runs/${runId}/publish`, init)
          : await ask(`${harness.base}/api/runs/${runId}/publish`, init);
      assert.equal(response.status, 403, `publish accepted owner impersonation from ${origin ?? "no origin"}`);
    }

    // NOTHING HAPPENED. No child, and no folder was published — a 403 that
    // arrived after the side effect would be worse than no check at all.
    const listed = (await (await ask(`${harness.base}/api/projects`)).json()) as ApiProjectsResponse;
    assert.equal(listed.projects.find((project) => project.slug === "shop")?.process.state, "stopped");
    assert.equal(existsSync(join(runPathsFor(harness.paths, runId).results, "project-publish.json")), false);

    // Owner-authority publication requires the exact dashboard UI origin.
    const allowed = await ask(`${harness.base}/api/runs/${runId}/publish`, {
      method: "POST",
      headers: { Origin: DASHBOARD_ORIGIN },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await harness.close();
  }
});

/* ---------------------------------------------------------------------- */

function seedFinishedRun(harness: Harness, runId: string, title: string): void {
  harness.store.createRun({
    runId,
    ticketId: `ticket-${runId}`,
    ticketTitle: title,
    ticketText: title,
    ticketSha256: "0".repeat(64),
    modelId: "opus",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 0,
  });
  const workspace = runPathsFor(harness.paths, runId).workspace;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "index.html"), "<!doctype html><title>shop</title>\n", "utf8");
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "shop", private: true, scripts: { start: "node server.mjs" } }, null, 2)}\n`,
    "utf8",
  );
}

test("POST /api/runs/:id/publish gives a finished run's folder a repository, and the list then names the run", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    const runId = "run-2026-08-02T10-00-00-000Z-abcd1234";
    seedFinishedRun(harness, runId, "A shop that sells nothing");
    harness.store.updateRun(runId, { status: "failed", endedAt: new Date().toISOString() });

    const response = await ask(`${harness.base}/api/runs/${runId}/publish`, {
      method: "POST",
      headers: { Origin: DASHBOARD_ORIGIN },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as ApiRepublishResponse;
    assert.equal(body.runId, runId);
    assert.equal(body.fileCount, 2);
    assert.equal(body.repository, "committed", "the point of the route is that the folder becomes a repository");
    assert.equal(typeof body.commit, "string");
    assert.equal(body.readme, "written");
    assert.equal(body.gitignore, "written");
    assert.equal(body.redirectedFrom, null);
    assert.equal(existsSync(join(body.path, ".git")), true);
    assert.equal(existsSync(join(body.path, "README.md")), true);
    assert.equal(existsSync(join(body.path, "index.html")), true);

    // AND THE LOOP CLOSES: the projects list now names the run, which is the
    // only way a client can reach this route a second time.
    const listed = (await (await ask(`${harness.base}/api/projects`)).json()) as ApiProjectsResponse;
    // `ApiProject.path` is the RESOLVED path (the runner refuses anything whose
    // realpath leaves `projects/`), and on macOS a temp directory's real path is
    // `/private/var/…` while the publish record's is `/var/…`. They are the same
    // directory, and in the owner's real tree the two spellings are identical.
    const project = listed.projects.find((entry) => entry.path === realpathSync(body.path));
    assert.equal(project?.runId, runId);
    assert.equal(project?.hasRepository, true);
    assert.equal(project?.startCommand, "npm start");
  } finally {
    await harness.close();
  }
});

test("POST /api/runs/:id/publish refuses a run that is still going, and an id that is not a run", TEST_OPTIONS, async () => {
  const harness = await startHarness();
  try {
    const runId = "run-2026-08-02T11-00-00-000Z-livelive";
    seedFinishedRun(harness, runId, "Still building");
    harness.store.updateRun(runId, { status: "running" });

    const response = await ask(`${harness.base}/api/runs/${runId}/publish`, {
      method: "POST",
      headers: { Origin: DASHBOARD_ORIGIN },
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as ApiErrorResponse;
    assert.equal(body.error, "run_not_terminal");
    assert.match(body.message, /still being written/);
    assert.equal(existsSync(join(harness.paths.projects, "still-building")), false, "and nothing was copied");
    // THE REFUSAL IS NOT WRITTEN TO `results/`, because the live run will write
    // its own record when it finishes.
    assert.equal(existsSync(join(runPathsFor(harness.paths, runId).results, "project-publish.json")), false);

    const unknown = await ask(`${harness.base}/api/runs/run-does-not-exist/publish`, { method: "POST" });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as ApiErrorResponse).error, "unknown_run");
  } finally {
    await harness.close();
  }
});
