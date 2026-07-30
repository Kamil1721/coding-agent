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
 * ROUTES BEYOND THE FROZEN CONTRACT: exactly five, and all five are additive.
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
 *
 * `GET /api/runs/:id/files` serves the code the run produced: the whole
 * workspace tree with no `?path`, one file's text with it. IT IS THE MOST
 * DANGEROUS ROUTE IN THIS FILE and every refusal it makes lives in
 * `code-files.ts`, not here — path shape, realpath containment, the credential
 * name list, the byte cap and the redaction self-check are one module because
 * the tree walk and the content read must not be able to disagree about what may
 * be served. This function does routing and nothing else.
 *
 * `GET|POST /api/secrets` and `GET /api/runs/:id/secrets` are the secret intake:
 * the owner pastes a credential into a form on this machine instead of into a
 * chat, and this process writes it to a 0600 file outside every run workspace.
 * THE VALUE TRAVELS IN ONE DIRECTION ONLY. No route returns one, no response
 * quotes one, and `sendSecretJson` refuses to send a body that contains one.
 * The POST answers `{ok, name}`; the GETs answer names and presence. Every
 * refusal is authored in `secret-intake.ts` from the NAME alone, and the JSON
 * parse failure below deliberately does not use `describeError` — a parse error
 * quotes the offending text, and here the offending text is the credential.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./dashboard-url.js";
import type {
  ApiErrorResponse,
  CreateRunResponse,
  HealthResponse,
  ModelOption,
  RunDetail,
  RunGraphResponse,
  RunSummary,
} from "./api-types.js";
import {
  isRefusal,
  readWorkspaceFile,
  readWorkspaceTree,
  resolveWorkspacePath,
} from "./code-files.js";
import { foldGraphAll } from "./graph.js";
import type { AuthProbe } from "./auth.js";
import { attachSse, parseLastEventId } from "./bus.js";
import type { RunEventBus } from "./bus.js";
import type { RunRow, RunStore } from "./db.js";
import { DESIGN_MOCKUP_LABEL, readDesignLock } from "./design-lock.js";
import { isOfferedProvider } from "./models.js";
import type { ModelCatalog } from "./models.js";
import { describeError } from "./orchestrator.js";
import type { DashboardPaths } from "./paths.js";
import { runPathsFor, safeSegment } from "./paths.js";
import {
  containsStoredSecret,
  declaredRuntimeMode,
  putSecret,
  refuseSecretName,
  refuseSecretValue,
  secretIntakeStatus,
  secretStoreFile,
} from "./secret-intake.js";
import type { SecretIntakeStatus } from "./secret-intake.js";
import { ticketFromText } from "./ticket.js";

/**
 * DECLARED IN `dashboard-url.ts`, RE-EXPORTED HERE.
 *
 * Not moved for tidiness: `index.ts` binds this port and the cron tick dials
 * it, and the tick cannot import this file at all — `describeError` below pulls
 * `orchestrator.js` in, which is the whole run pipeline. Two declarations of
 * one port number fail silently (the server binds 4321, a client dials 4176,
 * and the only symptom is a run that never appears), so there is one, and the
 * four existing importers of these names keep working unchanged.
 */
export { DEFAULT_PORT, LOOPBACK_HOST };

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
  /**
   * Continue a stopped run.
   *
   * `chosenMockup` is the owner's DESIGN-lock choice (spec §17.1) and is
   * OPTIONAL, because the route existed first for the rate-limit path and every
   * client on that path posts no body at all. `false` means "not resumable" —
   * a finished run, or a chosen path that is not one of this run's mockups. The
   * router turns that into a 409 and does not distinguish the two, because only
   * the orchestrator holds the manifest that could.
   */
  resume(runId: string, chosenMockup?: string | null): boolean;
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

function toDetail(row: RunRow, store: RunStore, paths: DashboardPaths): RunDetail {
  const screenshots = store.listScreenshots(row.runId);
  // ABSENT MEANS "NO DESIGN LANE", AND THAT IS NOT THE SAME AS AN EMPTY LOCK.
  // The record is written by the lane itself, so a run that never had one has
  // no file — and `null` here says exactly that, while a file saying
  // `{awaiting: false, locked: null}` says the lane ran and locked nothing.
  const lock = readDesignLock(runPathsFor(paths, row.runId).results);
  return {
    ...toSummary(row),
    ticketText: row.ticketText,
    phase: row.phase,
    criteria: store.listCriteria(row.runId),
    tokens: row.tokens,
    // ALWAYS null. A subscription consumes quota and is not billed per token;
    // there is no dollar figure to report and none is invented. See
    // api-types.ts and claude-common.ts. The DESIGN lane spends against a
    // Gemini key and that spend is a CALL COUNT in design-lane.json; it does
    // not become a dollar figure here or anywhere else.
    costUsd: null,
    rateLimit: { limited: row.rateLimited, retryAfterSec: row.rateLimitRetryAfterSec },
    screenshots,
    artifactPath: row.artifactPath,
    previewUrl: row.previewUrl,
    // Both straight off the row, and both mean "nothing recorded yet" at their
    // zero value rather than "unknown". See api-types.ts.
    inferredCriteria: row.inferredCriteria,
    verdictPath: row.verdictPath,
    // Straight off the row, and the PAIR travels together. `0`/`null` is "the
    // GATE/FIX loop has not produced an outcome", which is what a queued,
    // building, rate-limited or cancelled-before-the-gate run is — never "the
    // gate passed". See api-types.ts for who is still not writing them.
    gateAttempts: row.gateAttempts,
    gateStopReason: row.gateStopReason,
    designLock:
      lock === null
        ? null
        : {
            awaiting: lock.awaiting,
            // Filtered on the label the lane wrote, whose ONE definition is
            // `DESIGN_MOCKUP_LABEL` in design-lock.ts. A second spelling here
            // is how the owner's mockup cards quietly become empty.
            mockups: screenshots.filter((shot) => shot.label.startsWith(DESIGN_MOCKUP_LABEL)),
            locked: lock.locked,
            lockedBy: lock.lockedBy,
            reason: lock.reason,
          },
  };
}

/**
 * Hosts a `Referer` may name for the request to count as coming from the
 * dashboard's own page. The server binds loopback only (see the file header),
 * so nothing else can be one.
 */
const DASHBOARD_ORIGIN_HOSTS: readonly string[] = [LOOPBACK_HOST, "localhost"];

/**
 * Is this create-run request INTERACTIVE, in the sense spec §17.3 rule 2 leaves
 * undefined?
 *
 * Rule 2 says a cron run auto-selects, and never says what makes a request a
 * cron run. Defined narrowly here: a request is interactive when it carries an
 * explicit `designLock`, or a `Referer` from a loopback page. Everything else —
 * `curl`, cron, a script — is non-interactive and therefore `auto`. The failure
 * direction was chosen deliberately: a mis-classified interactive request
 * auto-selects (a mockup the owner did not pick, recorded as automatic), while
 * a mis-classified cron request would park forever, which is the failure rule 2
 * exists to prevent.
 *
 * ITS ONE CONSUMER IS THE `interactive` COLUMN, written by `createRun` below
 * from the request's own `Referer`. It is persisted BESIDE the requested policy
 * rather than folded into it, because `designLockPolicy` needs both and the two
 * say different things: an empty `design_lock` is "the request stated nothing",
 * which is not the same fact as "the request asked for auto".
 */
export function designLockInteractive(requested: unknown, referer: string | undefined): boolean {
  if (requested === "auto" || requested === "ask") return true;
  if (referer === undefined || referer.length === 0) return false;
  try {
    return DASHBOARD_ORIGIN_HOSTS.includes(new URL(referer).hostname);
  } catch {
    return false;
  }
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

  // GET /api/secrets  |  POST /api/secrets   (additive; see the file header)
  if (segments.length === 2 && segments[1] === "secrets") {
    if (method === "GET") {
      sendSecretStatus(deps, response, secretIntakeStatus({ file: secretStoreFile(deps.paths) }));
      return;
    }
    if (method === "POST") {
      await putSecretRoute(deps, request, response);
      return;
    }
    sendError(response, 405, "method_not_allowed", `${method} is not allowed on ${path}`, null);
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

  // GET /api/runs/:id/secrets  (additive; see the file header)
  //
  // THE RUN-SCOPED FORM IS WHERE DETECTION LIVES, because both of its inputs are
  // per-run: the frozen manifest is keyed by this run's ticket id, and the source
  // scan needs this run's workspace. The store itself is dashboard-level and the
  // unscoped route above reports it without either.
  if (segments.length === 4 && segments[3] === "secrets" && method === "GET") {
    sendSecretStatus(
      deps,
      response,
      secretIntakeStatus({
        file: secretStoreFile(deps.paths),
        runtimeDeclared: declaredRuntimeMode(deps.paths.acceptance, row.ticketId),
        inferredFrom: runPathsFor(deps.paths, runId).workspace,
      }),
    );
    return;
  }

  // GET /api/runs/:id
  if (segments.length === 3 && method === "GET") {
    sendJson(response, 200, toDetail(row, deps.store, deps.paths));
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
  //
  // AN EMPTY BODY STILL RESUMES, byte-identically to before this route learned
  // about mockups. The route exists for the rate-limit path and every client on
  // it posts nothing; requiring a body would break resuming a rate-limited run
  // in order to add a feature that path has no opinion about.
  if (segments.length === 4 && segments[3] === "resume" && method === "POST") {
    let chosenMockup: string | null = null;
    const text = await readBody(request);
    if (text.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        sendError(response, 400, "invalid_body", describeError(error), "POST a JSON object, or no body at all.");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        sendError(response, 400, "invalid_body", "the body must be a JSON object", "Or send no body at all.");
        return;
      }
      const chosen = (parsed as Record<string, unknown>)["chosenMockup"];
      if (chosen !== undefined && chosen !== null && typeof chosen !== "string") {
        sendError(response, 400, "invalid_body", "chosenMockup must be a string when present", null);
        return;
      }
      chosenMockup = typeof chosen === "string" ? chosen : null;
    }
    const resumed: boolean = deps.orchestrator.resume(runId, chosenMockup);
    if (!resumed) {
      sendError(
        response,
        409,
        "not_resumable",
        `run ${runId} is ${row.status} and cannot be resumed` +
          (chosenMockup === null ? "" : `, or ${chosenMockup} is not one of its mockups`),
        "A finished run is not resumed: re-running a scored artefact would overwrite a real result " +
          "with a second one taken under different conditions. Submit a new run instead.",
      );
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // GET /api/runs/:id/files[?path=…]  (additive; see the file header)
  //
  // `url.searchParams.get` HAS ALREADY PERCENT-DECODED ONCE, which is why
  // `?path=%2e%2e%2fx` arrives here as `../x` and is refused on shape. Nothing
  // below decodes it a second time: that would turn `%252e%252e%252f` into `../`
  // and hand the caller the traversal the check exists to stop.
  if (segments.length === 4 && segments[3] === "files" && method === "GET") {
    serveCode(deps, runId, url.searchParams.get("path"), response);
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
  const designLock = body["designLock"];

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
  if (designLock !== undefined && designLock !== null && designLock !== "auto" && designLock !== "ask") {
    sendError(
      response,
      400,
      "invalid_body",
      'designLock must be "auto", "ask", null or absent',
      "Absent means auto for a non-interactive caller (spec §17.3 rule 2): a scheduled run that " +
        "parks forever waiting for a click is the failure unattended operation exists to avoid.",
    );
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
      // TWO DIFFERENT FIXES, AND ONE OF THEM IS "THERE IS NO FIX". A model whose
      // provider is not offered at all (Codex, since the owner's 2026-07-28 scope
      // decision) cannot be authenticated into working, so telling the caller to
      // log a CLI in would send them after the wrong thing. The old branch here
      // was `tier === "metered"`, which became unreachable when the Kimi and
      // DeepSeek rows were removed on 2026-07-30.
      isOfferedProvider(entry.option.provider)
        ? "Authenticate the provider's CLI in a terminal, then try again. No API key is required."
        : "Pick a Claude model. GET /api/models lists every id that can actually run.",
    );
    return;
  }

  const ticket = ticketFromText(ticketText);
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  // §17.3 RULE 2'S TWO INPUTS, PERSISTED. Both are stated once, by the request
  // that created the run, and neither is patchable afterwards (db.ts says why:
  // a run whose lock policy could change halfway through is a run whose park has
  // no explanation). `designLockPolicy` reads them together at the top of each
  // build segment.
  //
  // THE TERNARY IS THE NARROWING, not a second validation: the check above has
  // already refused everything that is not one of these, and `body["designLock"]`
  // is `unknown` until something compares it to a literal.
  const requestedLock: "auto" | "ask" | null = designLock === "auto" || designLock === "ask" ? designLock : null;
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
    designLock: requestedLock,
    // FROM THIS REQUEST'S OWN HEADER. A run submitted from the dashboard page is
    // interactive and therefore asks; `curl` and cron carry neither an explicit
    // policy nor a loopback `Referer`, and get `auto` — the whole point of rule 2.
    interactive: designLockInteractive(designLock, request.headers.referer),
  });
  deps.bus.emit(runId, { type: "status", status: "queued" });
  deps.bus.emit(runId, { type: "phase", phase: "spec" });
  deps.orchestrator.pump();

  const body2: CreateRunResponse = { runId };
  sendJson(response, 201, body2);
}

/* -------------------------------------------------------------------------
 * The secret intake
 * ---------------------------------------------------------------------- */

/**
 * Send an intake status, or refuse to send anything at all.
 *
 * THE GUARD IS THE POINT OF THIS FUNCTION. `SecretIntakeStatus` has no value
 * field, so this can only fire if a future edit puts one there or smuggles a
 * value into a `why` string — which is exactly the regression worth catching, and
 * catching it as a 500 the owner sees beats shipping the value to a page that
 * will be screenshotted. It is a last line, not the mechanism: the mechanism is
 * that no code path reads a value on the way to this type.
 *
 * IT IS DELIBERATELY NOT IN `sendJson`. Applying it to every response in this
 * file would mean a synchronous read of the store on every poll of every route,
 * and the alternative — caching the values in the server heap to avoid the read —
 * keeps credentials in memory between requests for the sake of a check. So the
 * guard sits on the two routes that could plausibly grow one, and every OTHER
 * path's protection is that it never holds a value: the store is outside the
 * workspace, so `code-files.ts` cannot serve it, and `redactForPersistence`
 * covers the database and the event stream (with the coverage limit measured in
 * `secret-intake.test.ts`).
 */
function sendSecretJson(deps: HttpDeps, response: ServerResponse, status: number, body: unknown): void {
  if (containsStoredSecret(JSON.stringify(body), secretStoreFile(deps.paths))) {
    sendError(
      response,
      500,
      "secret_value_in_response",
      "refusing to send this response: it contains a stored credential value",
      "This is a defect in the dashboard, not in your request. The secret intake never returns a " +
        "value; report this.",
    );
    return;
  }
  sendJson(response, status, body);
}

/** The GET shape, through the guard above. */
function sendSecretStatus(deps: HttpDeps, response: ServerResponse, status: SecretIntakeStatus): void {
  sendSecretJson(deps, response, 200, status);
}

/**
 * Hosts an `Origin` may name on a write to the intake.
 *
 * WHY A WRITE NEEDS THIS AND A READ DOES NOT. The read cannot leak a value —
 * there is none in the response — but a write from a page the owner did not open
 * could REPLACE their real credential with an attacker's while looking like a
 * success. The server sets no CORS header, so a cross-site `fetch` can never
 * read the reply; what it can still do, without a preflight, is a
 * `text/plain`/form-encoded POST. Hence two refusals below: a non-JSON
 * content-type, and an `Origin` that is present and is not loopback. An ABSENT
 * `Origin` is allowed, because `curl` and a cron tick send none and a browser
 * always sends one on a POST.
 */
function originIsDashboard(origin: string | undefined): boolean {
  if (origin === undefined || origin.length === 0) return true;
  try {
    return DASHBOARD_ORIGIN_HOSTS.includes(new URL(origin).hostname);
  } catch {
    // Includes the literal "null" a sandboxed iframe or a file:// page sends.
    return false;
  }
}

/**
 * Store one credential.
 *
 * THE RESPONSE CARRIES THE NAME AND NEVER THE VALUE — not echoed, not masked,
 * not measured. Nothing in this function logs, and the value is not interpolated
 * into any error: every refusal it can produce is authored in
 * `secret-intake.ts` from the NAME alone.
 */
async function putSecretRoute(deps: HttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!originIsDashboard(request.headers.origin)) {
    sendError(
      response,
      403,
      "cross_origin_write",
      "a credential may only be stored from the dashboard's own page",
      "Open the dashboard on 127.0.0.1 and use the form there. A write from another origin could " +
        "replace your credential with someone else's and look like a success.",
    );
    return;
  }
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "POST a JSON body with Content-Type: application/json",
      "A form-encoded or text/plain POST is not preflighted by a browser, so it is the one shape a " +
        "page from another origin could send. It is refused here.",
    );
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    // describeError is NOT used here: a JSON parse error quotes the offending
    // text, and the offending text is the credential.
    sendError(response, 400, "invalid_body", "the body is not valid JSON", "POST {\"name\":\"…\",\"value\":\"…\"}.");
    return;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    sendError(response, 400, "invalid_body", "the body must be a JSON object", null);
    return;
  }
  const body = payload as Record<string, unknown>;
  const nameRefusal = refuseSecretName(body["name"]);
  if (nameRefusal !== null) {
    sendError(response, 400, nameRefusal.code, nameRefusal.message, nameRefusal.remediation);
    return;
  }
  const valueRefusal = refuseSecretValue(body["value"]);
  if (valueRefusal !== null) {
    sendError(response, 400, valueRefusal.code, valueRefusal.message, valueRefusal.remediation);
    return;
  }

  const name = body["name"] as string;
  const file = secretStoreFile(deps.paths);
  putSecret(file, name, body["value"] as string);
  // THE NAME AND A BOOLEAN. Not the value, not a masked form of it, not its
  // length — `redact.ts` says a partial is still a leak and nothing here emits a
  // prefix, a suffix, a last-4 or a length. The client re-reads GET /api/secrets
  // for the rest; that response has no value field either.
  sendSecretJson(deps, response, 200, { ok: true, name });
}

/**
 * Serve the run's workspace: the tree, or one file.
 *
 * ROUTING ONLY. Every decision about what may be served is `code-files.ts`'s,
 * and both branches below go through it — the tree walk and the content read
 * call the SAME `denyReason`, so there is no spelling of `?path` that reaches a
 * file the sidebar was built to hide.
 *
 * `runPathsFor` is what maps the run id to a directory, and it applies
 * `safeSegment` to the id exactly as every other per-run path does. The relative
 * path is NOT passed through `safeSegment`: that function mangles rather than
 * rejects, and turning `../../x` into the filename `.._.._x` produces a 404 for
 * the wrong reason while corrupting every legitimate path that contains a
 * separator.
 */
function serveCode(deps: HttpDeps, runId: string, rawPath: string | null, response: ServerResponse): void {
  const workspace = runPathsFor(deps.paths, runId).workspace;

  if (rawPath === null) {
    const tree = readWorkspaceTree(workspace, runId);
    if (isRefusal(tree)) {
      sendError(response, tree.status, tree.code, tree.message, tree.remediation);
      return;
    }
    sendJson(response, 200, tree);
    return;
  }

  const resolved = resolveWorkspacePath(workspace, rawPath);
  if (!resolved.ok) {
    const { status, code, message, remediation } = resolved.refusal;
    sendError(response, status, code, message, remediation);
    return;
  }
  const file = readWorkspaceFile(resolved.target, rawPath, runId);
  if (isRefusal(file)) {
    sendError(response, file.status, file.code, file.message, file.remediation);
    return;
  }
  sendJson(response, 200, file);
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
