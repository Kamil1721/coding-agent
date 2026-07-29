/**
 * dashboard-url.ts — ONE answer to "which door is the dashboard behind".
 *
 * WHY THIS FILE EXISTS AND IS NOT TWO LINES IN `http.ts`. Two things need the
 * same number and they cannot share `http.ts`:
 *
 *   - `index.ts` needs the port to BIND, and had its own private `parsePort`;
 *   - the cron tick needs the port to DIAL, and cannot import `http.ts` at all,
 *     because `http.ts` imports `describeError` from `./orchestrator.js` and
 *     therefore drags the whole run pipeline — the `Orchestrator`, the builder
 *     SDKs, the sealed gate — into a short-lived scheduler process whose entire
 *     design property is that it cannot start a run itself.
 *
 * A SECOND DECLARATION IS NOT A STYLE PROBLEM, IT IS A SILENT ONE. A tick that
 * POSTs to 4176 while the server bound 4321 gets `ECONNREFUSED`, journals
 * "unreachable", and looks — to anyone reading the number of runs the next
 * morning — exactly like a night when the queue was empty. So the bind side and
 * the dial side read the same constant and the same parser, and `http.ts`
 * re-exports these names rather than declaring them, so its four existing
 * importers are untouched.
 *
 * THIS MODULE IMPORTS NODE BUILT-INS, `paths.ts` (for the env NAME only) and
 * `bakeoff/dist/contracts.js`. Nothing here may reach `orchestrator.ts`, or the
 * paragraph above stops being true.
 */

import { BakeoffError } from "bakeoff/dist/contracts.js";
import { DASHBOARD_ENV } from "./paths.js";

/** The only interface this server will bind. See http.ts's header. */
export const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_PORT = 4176;

/**
 * `DASHBOARD_PORT` → a port number, or a REFUSAL.
 *
 * Nonsense is refused rather than defaulted, and that direction is the whole
 * point: a typo'd `DASHBOARD_PORT` that silently became 4176 would make the
 * server bind one port and every local client dial another. Absent or blank IS
 * the default, because that is the documented way to ask for it.
 *
 * The message and remediation are `index.ts`'s own, moved verbatim — they were
 * already right, and a scheduler that fails at 03:00 should fail with the
 * sentence the owner has already read once.
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${DASHBOARD_ENV.port} must be a port number, got ${JSON.stringify(raw)}`,
      `Unset ${DASHBOARD_ENV.port} to use ${String(DEFAULT_PORT)}, or set it to a number between 1 and 65535.`,
    );
  }
  return port;
}

/**
 * `http://127.0.0.1:<port>` — the one URL a local client should use, with no
 * trailing slash so callers can append `/api/...` without doubling it.
 *
 * The HOST is not configurable here even though `DASHBOARD_HOST` exists: that
 * variable can only ever hold `127.0.0.1` (`assertLoopback` refuses everything
 * else before `listen`), so reading it would suggest a choice that does not
 * exist.
 */
export function dashboardBaseUrl(env: NodeJS.ProcessEnv): string {
  return `http://${LOOPBACK_HOST}:${String(parsePort(env[DASHBOARD_ENV.port]))}`;
}
