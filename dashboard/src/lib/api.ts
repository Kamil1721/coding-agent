import type {
  CreateRunRequest,
  CreateRunResponse,
  HealthState,
  ModelOption,
  OkResponse,
  RunDetail,
  RunSummary,
} from "./api-types";

/**
 * THE single place the API origin is read.
 *
 * Empty string = same origin, which is the normal case: either the backend
 * ships as Route Handlers in this app, or `DASHBOARD_API_ORIGIN` makes
 * `next.config.ts` rewrite `/api/*` to it. Setting
 * `NEXT_PUBLIC_API_BASE_URL` moves `fetch` AND `EventSource` off the rewrite
 * together — which is the escape hatch if the rewrite ever buffers the SSE
 * stream on `/api/runs/:id/events`.
 */
export const API_BASE: string = (
  process.env["NEXT_PUBLIC_API_BASE_URL"] ?? ""
).replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** Stable SWR keys. Also the fetch paths — one string, one meaning. */
export const KEY = {
  runs: "/api/runs",
  run: (runId: string): string => `/api/runs/${encodeURIComponent(runId)}`,
  events: (runId: string): string =>
    `/api/runs/${encodeURIComponent(runId)}/events`,
  /** The folded orchestration canvas, spec §9.2. Snapshot first, then subscribe. */
  graph: (runId: string): string =>
    `/api/runs/${encodeURIComponent(runId)}/graph`,
  models: "/api/models",
  health: "/api/health",
} as const;

/**
 * An HTTP failure carrying whatever the server was willing to say.
 *
 * The API contract does not specify an error body, so nothing is assumed about
 * its shape: a JSON `error`/`message` string is used when present, otherwise
 * the status line. The body is never rendered raw beyond that single string,
 * so a server that echoes something sensitive cannot paint it across the UI.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const candidate = record["error"] ?? record["message"];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim().slice(0, 400);
    }
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch {
    // A connection refused here is the normal "backend is not running yet"
    // case for a local tool. Say that, rather than surfacing "Failed to fetch".
    throw new ApiError(
      0,
      `Cannot reach the dashboard API at ${API_BASE === "" ? "this origin" : API_BASE}. Is the backend process running?`,
    );
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      messageFromBody(parsed, `${response.status} ${response.statusText}`),
    );
  }

  return parsed as T;
}

export const fetchJson = request;

/** SWR fetcher. The key IS the path. */
export function swrFetcher<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function listRuns(): Promise<readonly RunSummary[]> {
  return request<readonly RunSummary[]>(KEY.runs);
}

export function getRun(runId: string): Promise<RunDetail> {
  return request<RunDetail>(KEY.run(runId));
}

export function listModels(): Promise<readonly ModelOption[]> {
  return request<readonly ModelOption[]>(KEY.models);
}

export function getHealth(): Promise<HealthState> {
  return request<HealthState>(KEY.health);
}

export function createRun(
  body: CreateRunRequest,
): Promise<CreateRunResponse> {
  return request<CreateRunResponse>(KEY.runs, {
    method: "POST",
    body: JSON.stringify({
      // AUTO UNTIL THE MOCKUP CARDS EXIST, AND THIS LINE IS NOT OPTIONAL.
      //
      // The server treats a dashboard submission as interactive, so its lock
      // policy would be "ask" — and no card UI ships in this phase, so there is
      // nothing in the app that can choose a mockup. Joined up, every web-UI
      // ticket submitted from here would park at awaiting_input for the full
      // DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN and then fallback-lock the first
      // mockup: worse than either end of the design, produced by two
      // individually-correct decisions. Delete this in the same commit that
      // ships the cards, and not before. `contract-parity.test.ts` asserts it.
      designLock: "auto",
      ...body,
    }),
  });
}

export function cancelRun(runId: string): Promise<OkResponse> {
  return request<OkResponse>(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

export function resumeRun(runId: string): Promise<OkResponse> {
  return request<OkResponse>(
    `/api/runs/${encodeURIComponent(runId)}/resume`,
    { method: "POST" },
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
