/**
 * index.ts — start the dashboard.
 *
 * Startup order is deliberate:
 *   1. resolve paths and REFUSE if any of them is inside the bake-off tree —
 *      a dashboard run record found by the campaign's `score`/`report` would
 *      be aggregated into a ~$2,100 measurement it was never part of;
 *   2. validate the bind host and REFUSE anything but 127.0.0.1;
 *   3. open the database and reconcile runs left mid-flight by a dead server;
 *   4. listen;
 *   5. reconcile the two kinds of state a dead server leaves behind: runs
 *      (`orchestrator.reconcileOnBoot`) and PROJECT CHILD PROCESSES
 *      (`projects.reconcileOnBoot`). The second one only ever KILLS. Nothing in
 *      this file starts a project — that is always an explicit owner action.
 *
 * Every refusal is a named error with the exact action that clears it. Never a
 * stack trace, and never a silent downgrade: a dashboard that quietly binds
 * somewhere else, or quietly skips the gate, is worse than one that does not
 * start.
 */

import { pathToFileURL } from "node:url";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
// THE PORT THIS PROCESS BINDS IS THE PORT A LOCAL CLIENT DIALS, and `parsePort`
// used to live here privately. It is now declared once, in `dashboard-url.ts`,
// because the cron tick needs the same answer and cannot import `http.ts`.
import { LOOPBACK_HOST, parsePort } from "./dashboard-url.js";
import { RunStore } from "./db.js";
import { assertLoopback, createDashboardServer } from "./http.js";
import { ModelCatalog } from "./models.js";
import { Orchestrator } from "./orchestrator.js";
import { DASHBOARD_ENV, ensureDirs, resolvePaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { ProjectRunner } from "./project-runner.js";
import { SupervisorLoop } from "./supervisor.js";
import { createSupervisorSubmit, startSupervisor } from "./supervisor-boot.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = resolvePaths(env);
  ensureDirs(paths);

  const host = (env[DASHBOARD_ENV.host] ?? LOOPBACK_HOST).trim();
  assertLoopback(host);
  const port = parsePort(env[DASHBOARD_ENV.port]);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const auth = new AuthProbe({ env });
  const catalog = new ModelCatalog(auth, env);
  const preview = new PreviewHost();
  /*
   * THE SUPERVISOR AND THE ORCHESTRATOR NEED EACH OTHER, SO ONE OF THE TWO EDGES
   * IS LATE-BOUND. The loop submits through the orchestrator, and the
   * orchestrator tells the loop when a run has settled; the holder is what breaks
   * that cycle without a second `Orchestrator`, which is the corruption case
   * `cron/cron-tick.ts` designs out (two pumps against one runs.db).
   *
   * THE HOOK IS A LATENCY OPTIMISATION AND NEVER A CORRECTNESS REQUIREMENT. The
   * loop is correct on its 30 s interval alone, because every decision it takes
   * is read from the tables; the hook only saves the owner up to 30 s of a
   * finished run sitting unnoticed.
   */
  const supervisorHolder: { loop: SupervisorLoop | null } = { loop: null };
  const orchestrator = new Orchestrator({
    store,
    bus,
    paths,
    catalog,
    auth,
    preview,
    env,
    onRunSettled: () => {
      const loop = supervisorHolder.loop;
      if (loop === null) return;
      // MUST NOT THROW AND MUST NOT BLOCK — see `OrchestratorDeps.onRunSettled`.
      // A rejection here would otherwise turn a finished run into a harness fault.
      void Promise.resolve(loop.tick()).catch((error: unknown) => {
        process.stdout.write(
          `  supervisor tick after a settled run threw and was absorbed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    },
  });
  const supervisorLoop = new SupervisorLoop({
    store,
    submit: createSupervisorSubmit({ store, bus, catalog, orchestrator }),
    // THE CHEAP PATH (§7.5). A rate-limited run is resumed rather than
    // re-submitted, which is the difference between waiting out a limit and
    // paying for a second spec phase.
    resume: (runId) => orchestrator.resume(runId),
  });
  supervisorHolder.loop = supervisorLoop;
  // ONE INSTANCE, SHARED WITH THE SERVER. It holds the running children, so the
  // boot reconcile and the shutdown kill below must act on the same object the
  // routes act on — a second runner inside `createDashboardServer` would leave
  // every started project alive after this process exits.
  const projects = new ProjectRunner({ paths, env });

  const server = createDashboardServer({
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    projects,
    // WITHOUT THIS FIELD EVERY `POST /api/supervisor/*` ANSWERS 503 AND EVERY GET
    // ANSWERS `probe.wired: false`. It is the evidence that something on this
    // machine will act on the row START writes.
    supervisor: supervisorLoop,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The host is passed explicitly. Omitting it makes Node listen on every
    // interface, which is the failure this whole file exists to prevent.
    server.listen({ host, port }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const status = await auth.status();
  process.stdout.write(
    [
      `dashboard listening on http://${host}:${String(port)} (loopback only)`,
      `  data      ${paths.database}`,
      `  runs      ${paths.runs}`,
      `  suites    ${paths.acceptance}`,
      `  results   ${paths.results}`,
      `  claude    ${status.claude === "ok" ? "authenticated" : status.claudeDetail}`,
      `  codex     ${status.codex === "ok" ? "authenticated" : status.codexDetail}`,
      "",
    ].join("\n"),
  );

  orchestrator.reconcileOnBoot();

  // KILLS ONLY. A project left running by a dashboard that died is holding a
  // port on the owner's machine with nothing able to name it; this is what ends
  // that. It never starts anything, and it refuses to signal a pid it cannot
  // verify is the one this dashboard started — see `project-runner.ts`.
  for (const entry of projects.reconcileOnBoot().entries) {
    process.stdout.write(`  project   ${entry.slug}: ${entry.outcome} — ${entry.detail}\n`);
  }

  /*
   * THE SUPERVISOR IS ARMED AND STARTED LAST, AFTER BOTH RECONCILES.
   *
   * Order is load-bearing twice. `orchestrator.reconcileOnBoot()` has to have run
   * first, or the loop's first tick reads run rows a dead server left mid-flight
   * and treats a resumable run as a live one. And `startSupervisor` REFUSES to
   * install the interval if the boot arm check reports the health discriminator
   * blind — it forces `desired='stopped'` with the reason on the row instead, so
   * `GET /api/supervisor` reports the refusal rather than only this stdout.
   */
  const supervisor = startSupervisor({ loop: supervisorLoop, store });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal}: stopping. In-flight builds are aborted and stay resumable.\n`);
    // FIRST, AND SYNCHRONOUSLY: a tick that fires during teardown would claim a
    // ticket and submit a run into a process that is closing its database.
    supervisor.stop();
    // IN PARALLEL WITH THE ORCHESTRATOR, NOT AFTER IT, AND THE 3 s BELOW IS WHY.
    // That timer fires once this settles; a serial `stopAll` would run inside
    // the same budget the build teardown is already spending and the last child
    // would be orphaned by `process.exit`. `stopAll` kills its children in
    // parallel too, and `allSettled` means a child that refuses to die cannot
    // stop the database from closing.
    void Promise.allSettled([orchestrator.shutdown(), projects.stopAll()]).finally(() => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
      // A held-open SSE connection must not prevent exit.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    if (error instanceof BakeoffError) {
      process.stderr.write(`\n[${error.code}] ${error.message}\n\nfix: ${error.remediation}\n\n`);
      process.exit(2);
    }
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exit(2);
  });
}
