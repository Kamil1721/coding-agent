/**
 * index.ts — start the dashboard.
 *
 * Startup order is deliberate:
 *   1. resolve paths and REFUSE if any of them is inside the bake-off tree —
 *      a dashboard run record found by the campaign's `score`/`report` would
 *      be aggregated into a ~$2,100 measurement it was never part of;
 *   2. validate the bind host and REFUSE anything but 127.0.0.1;
 *   3. open the database and reconcile runs left mid-flight by a dead server;
 *   4. listen.
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
  const orchestrator = new Orchestrator({ store, bus, paths, catalog, auth, preview, env });

  const server = createDashboardServer({ store, bus, orchestrator, catalog, auth, paths });

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

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal}: stopping. In-flight builds are aborted and stay resumable.\n`);
    void orchestrator.shutdown().finally(() => {
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
