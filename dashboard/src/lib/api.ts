import type {
  CreateRunRequest,
  CreateRunResponse,
  HealthState,
  ModelOption,
  OkResponse,
  ProjectLogs,
  ProjectStartResponse,
  ProjectStopResponse,
  ProjectsResponse,
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
  /** The run's workspace as a tree. */
  files: (runId: string): string =>
    `/api/runs/${encodeURIComponent(runId)}/files`,
  /**
   * One file in the run's workspace.
   *
   * `encodeURIComponent` ENCODES THE SLASHES TOO, and that is correct rather
   * than incidental: the value is one query parameter, the server reads it with
   * `searchParams.get` which decodes exactly once, and a path spelled
   * `visible-acceptance%2Fx.mjs` arrives as `visible-acceptance/x.mjs`. Leaving
   * the slashes raw would work today and break the first time a filename
   * contains an `&`.
   */
  file: (runId: string, path: string): string =>
    `/api/runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(path)}`,
  models: "/api/models",
  health: "/api/health",
  /** Every folder under `projects/`, with the process serving each. */
  projects: "/api/projects",
  /**
   * ONE PATH SEGMENT, ENCODED ONCE.
   *
   * `encodeURIComponent` here and NO decode on the server: `URL.pathname` does
   * not decode and the router does not either, so the runner's
   * `resolveProjectDir` sees the raw segment and applies its own
   * `[A-Za-z0-9._-]` allowlist to it. A slug is a directory name that gets
   * SPAWNED IN, so a second decode anywhere on that path is a traversal hole —
   * the same shape the attachment routes keep.
   */
  projectLogs: (slug: string): string =>
    `/api/projects/${encodeURIComponent(slug)}/logs`,
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

/**
 * `message` BEFORE `error`, and the order is the whole point.
 *
 * MEASURED, NOT REASONED ABOUT. Every error this backend sends is
 * `{error, message, remediation}` where `error` is a MACHINE CODE and `message`
 * is the sentence written for a person — `sendError` in `server/src/http.ts`
 * builds every one of them that way. Reading `error` first meant that refusing a
 * design choice painted the literal string `not_resumable` across the run page,
 * and a bad request painted `invalid_body`. The prose that says which path was
 * refused and why was on the wire the entire time and was never rendered.
 *
 * `error` stays as the fallback: nothing in the frozen contract promises a
 * `message`, and a code is still better than "409 Conflict".
 */
function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const candidate = record["message"] ?? record["error"];
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
      // "ask" BECAUSE THE CARDS NOW EXIST. This line was `"auto"` for exactly as
      // long as nothing in the app could answer a design park: the server treats
      // a dashboard submission as interactive, so a policy of "ask" with no card
      // UI meant every web-UI ticket parked at awaiting_input for the full
      // DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN and then fallback-locked the first
      // mockup. `DesignLockPanel` is the channel that was missing, so the park is
      // now a decision the owner can actually make.
      //
      // WHY IT IS STATED RATHER THAN INFERRED. The server has a second way to
      // read interactivity — a `Referer` from the dashboard origin
      // (`designLockInteractive` in server/src/http.ts) — and omitting the field
      // to lean on it would be the more elegant version of this. It is not taken:
      // `/api/*` reaches the backend through `next.config.ts`'s rewrite in the
      // normal deployment, and nothing on this side can prove that proxy forwards
      // `Referer`. A dropped header there would silently downgrade every
      // dashboard submission to "auto" and the cards would be UI nobody can
      // reach. A stated field cannot be lost by a header policy.
      //
      // AND THE ASYMMETRY §17.3 RULE 2 EXISTS FOR SURVIVES BY CONSTRUCTION. This
      // module is browser-only with one caller — the form submit in
      // `app/page.tsx` — so everything that reaches this function IS a person at
      // the dashboard. curl, cron and scripts never enter this file; they POST
      // /api/runs directly, carry no `designLock` and no dashboard `Referer`, and
      // `designLockPolicy(undefined, false)` gives them "auto". A mis-read
      // interactive request auto-selects and records the pick as automatic; a
      // mis-read cron request would park forever, and nothing here can hand a
      // cron request an "ask".
      //
      // WHERE IT STOPS TODAY, said rather than left to be discovered: the create
      // -run route validates `designLock` and does not pass it to
      // `store.createRun`, so no run created over HTTP parks yet whatever this
      // sends. `db.ts` already accepts and persists both fields. That seam is in
      // server/src/http.ts and is reported, not reached from here.
      designLock: "ask",
      // AFTER the default, so a caller that states a policy still wins.
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

/**
 * Continue a stopped run, optionally naming the mockup to lock.
 *
 * NO BODY AT ALL WHEN THERE IS NO CHOICE, byte-identically to before this
 * function learned about mockups. The route was built for the rate-limit path and
 * the server's header commits to an empty body still resuming; `{chosenMockup:
 * null}` would be a different request for no reason, on the path a rate-limited
 * run depends on.
 *
 * A CHOICE IS SENT ONLY WHEN THE OWNER MADE ONE. Omitting it does not mean "any
 * mockup" — it hands the pick to `ui-designer` and records it as automatic, which
 * is the timeout's behaviour and is a different fact about the run than a click.
 */
export function resumeRun(
  runId: string,
  chosenMockup?: string,
): Promise<OkResponse> {
  return request<OkResponse>(
    `/api/runs/${encodeURIComponent(runId)}/resume`,
    chosenMockup === undefined
      ? { method: "POST" }
      : { method: "POST", body: JSON.stringify({ chosenMockup }) },
  );
}

/**
 * Answer the CANVASS: continue the run in one of the directions it offered.
 *
 * A DIRECTION IS NOT A MOCKUP, AND THIS DELIBERATELY SENDS ONLY THE SLUG.
 * `chosenMockup` is validated against the manifest's refs — a published copy
 * path earns a 409 there, which is what `design-lock.browser.spec.ts`'s refusal
 * case records — so pairing a slug with a path could only convert a valid
 * direction choice into a refusal. The server resolves the direction from the
 * slug; a click that could not carry one does not go.
 *
 * IT IS THE SAME ROUTE `resumeRun` POSTS TO, because it is the same act: the
 * park ends and the run continues. What differs is which of the two irreversible
 * facts the body records — which design gets BUILT (this) or which single still
 * the gate GRADES against (`resumeRun`'s `chosenMockup`).
 */
export function resumeWithDirection(
  runId: string,
  chosenDirection: string,
): Promise<OkResponse> {
  return request<OkResponse>(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ chosenDirection }),
  });
}

/** One message on the owner↔run channel. Mirrors the server's `ChatMessage`. */
export interface ChatMessage {
  readonly seq: number;
  readonly at: string;
  readonly role: "owner" | "run";
  readonly text: string;
  readonly images: readonly string[];
  /** Null while waiting; on a finished run, null means it was never read. */
  readonly deliveredAt: string | null;
}

export function runMessages(runId: string): Promise<{ messages: readonly ChatMessage[] }> {
  return request<{ messages: readonly ChatMessage[] }>(
    `/api/runs/${encodeURIComponent(runId)}/messages`,
  );
}

/**
 * Queue an instruction for the run's next segment boundary.
 *
 * `images` are `data:image/…;base64,…` URLs. The server decodes them to files under
 * `runs/<id>/chat/` and stores PATHS, because the builder needs a path to `Read` and
 * a PNG has no business in a SQLite row. Base64 over loopback costs 33% on
 * screenshots, which is cheaper than a second multipart parser in this codebase.
 */
export function sendRunMessage(
  runId: string,
  text: string,
  images: readonly string[],
): Promise<{ message: ChatMessage }> {
  return request<{ message: ChatMessage }>(
    `/api/runs/${encodeURIComponent(runId)}/messages`,
    { method: "POST", body: JSON.stringify({ text, images }) },
  );
}

/* ------------------------------------------------------------------ */
/* Published projects                                                  */
/* ------------------------------------------------------------------ */

export function listProjects(): Promise<ProjectsResponse> {
  return request<ProjectsResponse>(KEY.projects);
}

/**
 * Start a published project, and RESOLVE ONLY WHEN ITS PORT ANSWERS.
 *
 * That is the server's contract, not a courtesy: `project-runner.ts` polls the
 * child with a real HTTP GET and holds this response until it answers or until
 * `DEFAULT_START_TIMEOUT_MS` (30 s) is up. So this promise being in flight IS
 * the "starting" state — there is no `starting` member on `ProjectProcess` to
 * poll for, and a caller that shows a spinner off its own timer would be
 * inventing a state the server never claimed.
 *
 * IT REJECTS WITH THE SERVER'S OWN SENTENCE. A child that exited immediately
 * comes back as `start_exited` with its stderr tail INSIDE the message, and one
 * that never bound comes back as `start_timeout` or `bound_elsewhere`.
 * `messageFromBody` caps that at 400 characters, so render `GET
 * /api/projects/:slug/logs` beside it rather than presenting the message as the
 * whole failure.
 */
export function startProject(slug: string): Promise<ProjectStartResponse> {
  return request<ProjectStartResponse>(
    `/api/projects/${encodeURIComponent(slug)}/start`,
    { method: "POST" },
  );
}

export function stopProject(slug: string): Promise<ProjectStopResponse> {
  return request<ProjectStopResponse>(
    `/api/projects/${encodeURIComponent(slug)}/stop`,
    { method: "POST" },
  );
}

export function projectLogs(slug: string): Promise<ProjectLogs> {
  return request<ProjectLogs>(KEY.projectLogs(slug));
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
