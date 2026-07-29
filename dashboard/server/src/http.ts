/**
 * http.ts — the frozen HTTP contract, and the bind that must never widen.
 *
 * 127.0.0.1 ONLY. NOT CONFIGURABLE TO ANYTHING ELSE.
 *
 * The dashboard drives the owner's PERSONAL SUBSCRIPTIONS through CLIs that are
 * already logged in. Anything that can reach this port can spend the owner's
 * Claude and Codex quota, read every ticket, and write files anywhere the
 * builder can write. Binding 0.0.0.0 would put that on the local network — and
 * on the providers' side, exposing a subscription-authenticated agent as a
 * service to other people is precisely what both terms of service forbid. So
 * the host is validated before `listen`, and the process REFUSES TO START on
 * anything else rather than starting in a state someone has to notice.
 *
 * No CORS header is set anywhere, for the same reason: the only page that may
 * talk to this API is the one this server serves.
 *
 * ROUTES BEYOND THE FROZEN CONTRACT: exactly two, and both are additive.
 *
 * `GET /api/runs/:id/screenshots/:file` serves a captured screenshot, because
 * `RunDetail.screenshots[].path` is an absolute host path that a browser cannot
 * open. It resolves ONE path segment inside that run's own screenshot
 * directory and nothing else.
 *
 * `GET /api/runs/:id/graph` returns the folded orchestration canvas plus the
 * durable watermark it was folded at (spec §9.2). It exists because the
 * alternative is the client replaying every event: measured on a 32,000-row run,
 * `eventsSince(runId, 0)` returns in 22.7 ms and parses in 11.7 ms and is
 * **7.01 MB on the wire**. THIS IS A WIRE-SIZE FIX, NOT A CPU ONE. It is folded
 * from `store.eventsSince(runId, 0)` — durable rows — and NEVER from live
 * orchestrator memory, because `attachSse` replays from durable rows too, and
 * that is the only reason the window between this response and the client's
 * `EventSource(…?lastEventId=atSeq)` is not a race.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import type {
  ApiErrorResponse,
  CreateRunResponse,
  HealthResponse,
  ModelOption,
  RunDetail,
  RunGraphResponse,
  RunSummary,
} from "./api-types.js";
import { foldGraphAll } from "./graph.js";
import type { AuthProbe } from "./auth.js";
import { attachSse, parseLastEventId } from "./bus.js";
import type { RunEventBus } from "./bus.js";
import type { RunRow, RunStore } from "./db.js";
import type { ModelCatalog } from "./models.js";
import { describeError } from "./orchestrator.js";
import type { DashboardPaths } from "./paths.js";
import { safeSegment } from "./paths.js";
import { ticketFromText } from "./ticket.js";

/** The only interface this server will bind. */
export const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_PORT = 4176;

/** Ticket text cap. A ticket is a brief, not an upload. */
export const MAX_TICKET_CHARS = 100_000;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * What the HTTP layer needs from the orchestrator, and nothing more.
 *
 * A narrow interface rather than the class: the router has no business
 * reaching into the run pipeline, and a seam here is what lets the routes be
 * tested without spawning a builder subprocess. `Orchestrator` satisfies it
 * structurally.
 */
export interface RunController {
  /** Recompute queue positions and start the next run if idle. */
  pump(): void;
  cancel(runId: string): boolean;
  resume(runId: string): boolean;
}

export interface HttpDeps {
  readonly store: RunStore;
  readonly bus: RunEventBus;
  readonly orchestrator: RunController;
  readonly catalog: ModelCatalog;
  readonly auth: AuthProbe;
  readonly paths: DashboardPaths;
}

/**
 * Reject any host that is not exactly the loopback literal.
 *
 * "localhost" is refused deliberately: what it resolves to is a property of
 * /etc/hosts and of the resolver, not of this program, and a bind decision
 * this consequential may not be delegated to name resolution.
 */
export function assertLoopback(host: string): void {
  if (host === LOOPBACK_HOST) return;
  throw new BakeoffError(
    "invalid_usage_shape",
    `refusing to bind ${JSON.stringify(host)}: the dashboard binds ${LOOPBACK_HOST} only`,
    "Do not set DASHBOARD_HOST, or set it to 127.0.0.1. This server drives CLIs that are already " +
      "logged in to the owner's personal Claude and Codex subscriptions: anything that can reach " +
      "this port can spend that quota and write files as this user. Exposing it off-machine would " +
      "also breach both providers' terms of service. If you need it on another device, forward the " +
      "port over SSH — that keeps the bind on loopback.",
  );
}

function toSummary(row: RunRow): RunSummary {
  return {
    runId: row.runId,
    ticketTitle: row.ticketTitle,
    modelId: row.modelId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    heldOutPass: row.heldOutPass,
    falseFinish: row.falseFinish,
  };
}

function toDetail(row: RunRow, store: RunStore): RunDetail {
  return {
    ...toSummary(row),
    ticketText: row.ticketText,
    phase: row.phase,
    criteria: store.listCriteria(row.runId),
    tokens: row.tokens,
    // ALWAYS null. A subscription consumes quota and is not billed per token;
    // there is no dollar figure to report and none is invented. See
    // api-types.ts and claude-common.ts.
    costUsd: null,
    rateLimit: { limited: row.rateLimited, retryAfterSec: row.rateLimitRetryAfterSec },
    screenshots: store.listScreenshots(row.runId),
    artifactPath: row.artifactPath,
    previewUrl: row.previewUrl,
    // Both straight off the row, and both mean "nothing recorded yet" at their
    // zero value rather than "unknown". See api-types.ts.
    inferredCriteria: row.inferredCriteria,
    verdictPath: row.verdictPath,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function sendError(
  response: ServerResponse,
  status: number,
  error: string,
  message: string,
  remediation: string | null,
): void {
  const body: ApiErrorResponse = { error, message, remediation };
  sendJson(response, status, body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createDashboardServer(deps: HttpDeps): Server {
  const server = createServer((request, response) => {
    void handle(deps, request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendError(response, 500, "internal_error", describeError(error), null);
      } else {
        response.end();
      }
    });
  });
  // A hung SSE client must not keep a shutdown waiting forever.
  server.keepAliveTimeout = 65_000;
  return server;
}

async function handle(deps: HttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments[0] !== "api") {
    sendError(response, 404, "not_found", `no route for ${method} ${path}`, null);
    return;
  }

  // GET /api/health
  if (segments.length === 2 && segments[1] === "health" && method === "GET") {
    const auth = await deps.auth.status();
    const body: HealthResponse = {
      ok: auth.claude === "ok" || auth.codex === "ok",
      claudeAuth: auth.claude,
      codexAuth: auth.codex,
    };
    sendJson(response, 200, body);
    return;
  }

  // GET /api/models
  if (segments.length === 2 && segments[1] === "models" && method === "GET") {
    const models: readonly ModelOption[] = await deps.catalog.list();
    sendJson(response, 200, models);
    return;
  }

  if (segments[1] !== "runs") {
    sendError(response, 404, "not_found", `no route for ${method} ${path}`, null);
    return;
  }

  // GET /api/runs  |  POST /api/runs
  if (segments.length === 2) {
    if (method === "GET") {
      const summaries: readonly RunSummary[] = deps.store.listRuns().map(toSummary);
      sendJson(response, 200, summaries);
      return;
    }
    if (method === "POST") {
      await createRun(deps, request, response);
      return;
    }
    sendError(response, 405, "method_not_allowed", `${method} is not allowed on ${path}`, null);
    return;
  }

  const runId = segments[2] ?? "";
  const row = deps.store.getRun(runId);
  if (row === null) {
    sendError(response, 404, "unknown_run", `no run ${runId}`, "Check the run id in GET /api/runs.");
    return;
  }

  // GET /api/runs/:id
  if (segments.length === 3 && method === "GET") {
    sendJson(response, 200, toDetail(row, deps.store));
    return;
  }

  // GET /api/runs/:id/events
  if (segments.length === 4 && segments[3] === "events" && method === "GET") {
    const lastEventId = Math.max(
      parseLastEventId(request.headers["last-event-id"]),
      Number.parseInt(url.searchParams.get("lastEventId") ?? "", 10) || 0,
    );
    const detach = attachSse(response, deps.bus, deps.store, runId, lastEventId);
    request.on("close", detach);
    response.on("close", detach);
    return;
  }

  // GET /api/runs/:id/graph  (additive; see the file header)
  if (segments.length === 4 && segments[3] === "graph" && method === "GET") {
    sendJson(response, 200, graphSnapshot(deps.store, runId));
    return;
  }

  // POST /api/runs/:id/cancel
  if (segments.length === 4 && segments[3] === "cancel" && method === "POST") {
    const cancelled = deps.orchestrator.cancel(runId);
    if (!cancelled) {
      sendError(
        response,
        409,
        "not_cancellable",
        `run ${runId} is ${row.status} and cannot be cancelled`,
        "Only a queued, running, rate-limited or awaiting-input run can be cancelled.",
      );
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // POST /api/runs/:id/resume
  if (segments.length === 4 && segments[3] === "resume" && method === "POST") {
    const resumed = deps.orchestrator.resume(runId);
    if (!resumed) {
      sendError(
        response,
        409,
        "not_resumable",
        `run ${runId} is ${row.status} and cannot be resumed`,
        "A finished run is not resumed: re-running a scored artefact would overwrite a real result " +
          "with a second one taken under different conditions. Submit a new run instead.",
      );
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // GET /api/runs/:id/screenshots/:file  (additive; see the file header)
  if (segments.length === 5 && segments[3] === "screenshots" && method === "GET") {
    serveScreenshot(deps, runId, segments[4] ?? "", response);
    return;
  }

  sendError(response, 404, "not_found", `no route for ${method} ${path}`, null);
}

/**
 * The folded canvas, and the watermark it was folded at.
 *
 * `atSeq` IS THE SEQ OF THE LAST ROW THAT WENT INTO THIS FOLD — never
 * `store.latestSeq()`. The two differ whenever a run appends between the read
 * and the reply, and the difference is not cosmetic: the client opens
 * `EventSource(…?lastEventId=atSeq)`, which replays rows with `seq > atSeq`, so
 * a watermark AHEAD of the fold silently drops every event in the gap from BOTH
 * channels. It reads as a canvas that is merely a little stale.
 *
 * Folded from durable rows, and from nothing else. There is no path from here to
 * the orchestrator's in-memory state, deliberately: a snapshot taken from live
 * memory could not be resumed from by a client, because `attachSse` replays the
 * table.
 *
 * IT NEVER THROWS ON AN OLD RUN. Every run recorded before this phase is a
 * stream of `log`/`tool`/`status` rows with no `graph_*` member in it at all,
 * and `foldGraph` returns those unchanged — so an old run answers 200 with an
 * empty canvas and `inventory: null`, with no feature flag to forget to remove.
 */
function graphSnapshot(store: RunStore, runId: string): RunGraphResponse {
  const rows = store.eventsSince(runId, 0);
  const state = foldGraphAll(rows.map((row) => row.event));
  return { atSeq: rows[rows.length - 1]?.seq ?? 0, ...state };
}

async function createRun(deps: HttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    sendError(response, 400, "invalid_body", describeError(error), "POST a JSON object.");
    return;
  }
  if (typeof payload !== "object" || payload === null) {
    sendError(response, 400, "invalid_body", "the body must be a JSON object", null);
    return;
  }
  const body = payload as Record<string, unknown>;
  const ticketText = body["ticketText"];
  const modelId = body["modelId"];
  const deploy = body["deploy"];

  if (typeof ticketText !== "string" || ticketText.trim().length === 0) {
    sendError(response, 400, "invalid_ticket", "ticketText must be a non-empty string", null);
    return;
  }
  if (ticketText.length > MAX_TICKET_CHARS) {
    sendError(
      response,
      400,
      "invalid_ticket",
      `ticketText is ${String(ticketText.length)} characters; the cap is ${String(MAX_TICKET_CHARS)}`,
      "Split the work into separate tickets. A brief this long is usually two tickets.",
    );
    return;
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    sendError(response, 400, "invalid_model", "modelId must be a string", "GET /api/models lists them.");
    return;
  }
  if (deploy !== undefined && typeof deploy !== "boolean") {
    sendError(response, 400, "invalid_body", "deploy must be a boolean when present", null);
    return;
  }

  const entry = await deps.catalog.resolve(modelId);
  if (entry === null) {
    sendError(
      response,
      400,
      "unknown_model",
      `${modelId} is not in the catalog`,
      "GET /api/models lists every id this dashboard accepts.",
    );
    return;
  }
  if (!entry.option.available) {
    sendError(
      response,
      409,
      "model_unavailable",
      `${modelId} is not available: ${entry.option.reason ?? "no reason recorded"}`,
      entry.option.tier === "metered"
        ? "The dashboard drives only the two subscription CLIs and holds no API key."
        : "Authenticate the provider's CLI in a terminal, then try again. No API key is required.",
    );
    return;
  }

  const ticket = ticketFromText(ticketText);
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  deps.store.createRun({
    runId,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    ticketText: ticket.brief,
    ticketSha256: ticket.sha256,
    modelId,
    provider: entry.option.provider,
    deploy: deploy === true,
    startedAt: new Date().toISOString(),
    queuePosition: deps.store.listQueued().length + 1,
  });
  deps.bus.emit(runId, { type: "status", status: "queued" });
  deps.bus.emit(runId, { type: "phase", phase: "spec" });
  deps.orchestrator.pump();

  const body2: CreateRunResponse = { runId };
  sendJson(response, 201, body2);
}

/**
 * Serve one screenshot.
 *
 * The filename is reduced to its basename and re-joined under the run's own
 * directory, so no value from the URL can walk out of it. Anything that is not
 * a regular file inside that directory is a 404.
 */
function serveScreenshot(deps: HttpDeps, runId: string, file: string, response: ServerResponse): void {
  const dir = join(deps.paths.results, "screenshots", safeSegment(runId));
  const target = join(dir, basename(file));
  if (!target.startsWith(`${dir}/`) || !existsSync(target) || !statSync(target).isFile()) {
    sendError(response, 404, "not_found", "no such screenshot", null);
    return;
  }
  response.writeHead(200, {
    "Content-Type": target.endsWith(".png") ? "image/png" : "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  createReadStream(target).pipe(response);
}
