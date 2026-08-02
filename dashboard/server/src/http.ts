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
 * ROUTES BEYOND THE FROZEN CONTRACT: thirteen, and every one of them is
 * additive — no existing shape has been narrowed, renamed or removed.
 *
 * `GET /api/runs/:id/screenshots/:file` serves a captured screenshot, because
 * `RunDetail.screenshots[].path` is an absolute host path that a browser cannot
 * open. It resolves ONE path segment inside that run's own screenshot
 * directory and nothing else.
 *
 * `GET /api/runs/:id/references/:file` and `GET /api/runs/:id/documents/:file`
 * serve THE OWNER'S OWN UPLOADS for the same reason and with a stricter lookup.
 * Measured before they existed: a PNG and a PDF pasted into the ticket form
 * render as bare text chips and `document.querySelectorAll('img')` returns zero
 * elements, because `ReferenceImage.path` is a filesystem path written for an
 * agent that calls `Read`. THEY DO NOT COPY `serveScreenshot`'S BASENAME-JOIN.
 * A run's screenshot directory holds nothing but harness PNGs; `references/`
 * additionally holds `references.json` — absolute host paths and digests off the
 * owner's machine — and the screenshots `runCapture` writes when a ticket names
 * a page. So the lookup is the MANIFEST's own entry list and the read is always
 * `join(<that run's directory>, file)`; `run-attachments.ts` owns all four
 * refusals and the content-type derivation, and this file does routing only, for
 * the same reason `code-files.ts` owns the workspace ones.
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
 * `GET /api/runs/:id/preview/*` serves that SAME workspace as a BROWSABLE SITE —
 * correct content types, `index.html` at the root, relative assets resolving —
 * because `RunDetail.previewUrl` is a dead address. That field is the
 * `http://127.0.0.1:<port>` a `deploy: true` run served on (`preview.ts`), and
 * the process that answered it exited with the run: measured at
 * `http://127.0.0.1:4321` with nothing listening while the artefact sat intact on
 * disk. A preview served from HERE is live whenever anyone is looking, because
 * the dashboard is the thing being looked at. It reuses `code-files.ts`'s
 * refusals rather than carrying its own — a second path check on a route that
 * streams raw bytes would be the copy that drifts, and the thing it would leak is
 * the owner's filesystem. See `servePreview` for the trailing slash, the CSP and
 * what neither of them covers.
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
 *
 * `POST /api/runs` NOW DECIDES A TICKET'S IDENTITY, AND DOES I/O TO GET THERE.
 * It accepts reference images (base64 data URLs, the chat's caps, from one
 * declaration in `ticket-refs.ts`), writes their bytes under
 * `runs/<id>/references/`, and — when the ticket names a page — CAPTURES THAT
 * PAGE with a headless browser before replying. That is the only moment in the
 * pipeline where the network is both present and permitted: the spec seat that
 * authors the pass/fail suite runs with `tools: []` and can never fetch
 * anything, and the scorer runs `docker run --network none` and must keep doing
 * so. Capturing here turns the page into TEXT the spec seat can read and
 * SCREENSHOTS the builder can open.
 *
 * The route therefore does file writes and, sometimes, ~25 s of network before
 * `store.createRun`. Both are fail-soft: a capture that fails still creates the
 * run, and says so on the run's own event stream rather than in the response.
 *
 * BOTH INTAKE ROUTES NOW TAKE DOCUMENTS TOO — `POST /api/runs` and
 * `POST /api/runs/:id/messages`, from one set of rules in `document-intake.ts`.
 * A ticket's documents are written to `runs/<id>/documents/`, recorded in the
 * reference manifest as PATHS AND DIGESTS ONLY, and their digests enter the
 * ticket id exactly as an image's do: a changed scope document is a different
 * ticket with its own frozen suite. A chat message's documents are written to
 * `runs/<id>/chat/` and are NOT identity, because the run's ticket id was fixed
 * when its row was written.
 *
 * WHAT NEITHER ROUTE DOES, STATED HERE BECAUSE IT IS THE THING A READER WILL
 * ASSUME: neither one puts a document in front of an agent. This file decodes,
 * stores and digests; whether a seat is given a document is decided by the build
 * and spec wiring, which reads the manifest later and is not this file's to
 * write. At the time this route was written nothing did — `builderReferenceSection`
 * and `designReferenceSection` render images and screenshots only, the chat's
 * delivery shape (`LiveMessage`, the `messages` table, `ownerMessageBlock`)
 * carries text and image paths only — so both routes emit a `warn` on the run's
 * event stream saying the attachment was STORED, not read. The wording is about
 * what the intake does rather than about what every other module does not,
 * because the second kind of sentence goes stale silently.
 *
 * THE FIVE NEWEST ROUTES ARE ABOUT A PROJECT AFTER THE RUN THAT BUILT IT.
 *
 * `GET /api/projects`, `POST /api/projects/:slug/start`,
 * `POST /api/projects/:slug/stop` and `GET /api/projects/:slug/logs` give a
 * published folder a supervised local lifecycle. `project-runner.ts` owns every
 * refusal, every path decision and every child process; this file routes and
 * serializes. TWO PROPERTIES OF THAT MODULE MATTER TO ANYONE EDITING HERE:
 * NOTHING STARTS WITHOUT AN EXPLICIT OWNER REQUEST (there is no auto-start, on
 * boot or anywhere else), and the slug reaches it STILL PERCENT-ENCODED — the
 * same construction the attachment routes use, and the reason a helpful
 * `decodeURIComponent` in the router would be a hole rather than a convenience.
 *
 * `POST /api/runs/:id/publish` re-runs the publish and handover for a run that
 * has already finished. It is keyed on the RUN because the publish seam is: the
 * folder is the output. Without it, `project-handover.ts` would only ever reach
 * runs that finish AFTER it was written, which is none of the runs on this
 * machine.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./dashboard-url.js";
import { ADVERSARY_RECORD_FILE, adversaryPassFromRecord } from "./adversary.js";
import type {
  ApiAdversaryPass,
  ApiErrorResponse,
  ApiProjectLogs,
  ApiProjectStartResponse,
  ApiProjectStopResponse,
  ApiProjectsResponse,
  ApiRepublishResponse,
  CreateRunResponse,
  HealthResponse,
  ModelOption,
  RunDetail,
  RunGraphResponse,
  RunSummary,
} from "./api-types.js";
import {
  PREVIEW_INDEX_DOCUMENT,
  decodePreviewPath,
  isRefusal,
  previewContentType,
  previewIndexRefusal,
  readWorkspaceFile,
  readWorkspaceTree,
  resolvePreviewTarget,
  resolveWorkspacePath,
} from "./code-files.js";
import { foldGraphAll } from "./graph.js";
import type { AuthProbe } from "./auth.js";
import { GateProbe } from "./health-gate.js";
import { attachSse, parseLastEventId } from "./bus.js";
import type { RunEventBus } from "./bus.js";
import { isTerminal } from "./db.js";
import type { RunRow, RunStore } from "./db.js";
import { DESIGN_MOCKUP_LABEL, readDesignLock } from "./design-lock.js";
import { isOfferedProvider } from "./models.js";
import type { ModelCatalog } from "./models.js";
import { describeError, silenceOf } from "./orchestrator.js";
import type { DashboardPaths } from "./paths.js";
import { readPublishedProject, republishProject } from "./project-publish.js";
import { ProjectRunner } from "./project-runner.js";
import { runPathsFor, safeSegment } from "./paths.js";
import { attachmentHeaders, isAttachmentKind, listAttachments, resolveAttachment } from "./run-attachments.js";
import type { AttachmentKind } from "./run-attachments.js";
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
import { ticketWithReferences } from "./ticket.js";
import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  decodeReferenceDataUrl,
  digestBytes,
  documentDirFor,
  referenceDirFor,
  writeReferenceManifest,
} from "./ticket-refs.js";
import type { ReferenceDocument, ReferenceImage } from "./ticket-refs.js";
import {
  ACCEPTED_DOCUMENT_MEDIA_TYPES,
  MAX_DOCUMENT_BODY_BYTES,
  MAX_REFERENCE_DOCUMENTS,
  decodeDocumentDataUrl,
} from "./document-intake.js";
import type { DecodedDocument } from "./document-intake.js";
import { captureSite, captureTargetFor, captureTargetIn } from "./site-capture.js";
import type { CaptureOptions, SiteCapture, SiteCaptureResult } from "./site-capture.js";

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

/**
 * The default request-body cap. Generous for JSON, and far too small for images.
 *
 * A MEASURED DEFECT LIVED HERE. `readBody` had this as its ONLY cap, so the chat
 * route's documented image limits — 6 images of 8 MB each — were unreachable by
 * a factor of ten: one 8 MB PNG is ~10.7 MB as a base64 data URL, so anything
 * over roughly 750 KB decoded died as "request body too large" long before
 * `decodeReferenceDataUrl` could apply the cap it advertises. The per-image
 * refusal message named a limit no request could ever reach.
 *
 * The fix is a per-route cap rather than one global one: raising this for every
 * route would let any endpoint buffer 64 MB of anything.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The envelope the IMAGES alone need.
 *
 * DERIVED FROM THE IMAGE CAPS, NOT TYPED AS A NUMBER, so the two can never
 * disagree again: base64 is 4/3 of the decoded size, and the slack covers the
 * data-URL prefixes, the JSON envelope and the ticket text riding alongside.
 *
 * NO LONGER PASSED TO `readBody` DIRECTLY — see {@link MAX_ATTACHMENT_BODY_BYTES},
 * which is what both attachment-bearing routes use now that a request may carry
 * documents as well.
 */
export const MAX_IMAGE_BODY_BYTES =
  MAX_REFERENCE_IMAGES * Math.ceil((MAX_REFERENCE_IMAGE_BYTES * 4) / 3) + 256 * 1024;

/**
 * The body cap on the two routes that carry ATTACHMENTS — images, documents, or
 * both in the same request.
 *
 * THE SUM, NEVER THE LARGER OF THE TWO, and `document-intake.ts` states the same
 * rule where `MAX_DOCUMENT_BODY_BYTES` is declared: a request may legitimately
 * carry six reference images AND four documents, and a cap of `Math.max(...)`
 * would refuse it while every per-attachment limit the API advertises says it is
 * fine. That is the shape of the defect this file already carried once — a
 * documented per-image limit unreachable by a factor of ten because the route
 * used the 1 MB default envelope, so an oversized attachment died as "request
 * body too large" quoting a limit no request could reach. `api-documents.test.ts`
 * asserts the arithmetic rather than trusting review to catch a "simplification"
 * back to a max.
 *
 * IT IS A REAL MEMORY COST, AND IT HAS ROUGHLY DOUBLED. `readBody` buffers the
 * whole body before parsing, so a maximal request now holds ~128 MB of base64
 * (~64 MB of images plus ~64 MB of documents) plus the decoded copies. That is
 * acceptable here and only here: this server binds loopback, serves one human,
 * and processes one such request at a time in practice. It would not be
 * acceptable on anything shared, and a route that does not carry attachments
 * must keep the {@link MAX_BODY_BYTES} default.
 */
export const MAX_ATTACHMENT_BODY_BYTES = MAX_IMAGE_BODY_BYTES + MAX_DOCUMENT_BODY_BYTES;

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
  /**
   * Push an owner message into a RUNNING segment's session.
   *
   * Returns false when there is no open segment — parked, queued, or between
   * segments — and the router then leaves the message pending for the boundary
   * drain. `true` means the text is in the live session's input queue, so the
   * router stamps it delivered.
   */
  pushLiveMessage(runId: string, message: { text: string; images: readonly string[] }): boolean;
  /**
   * Hand an owner message to a run parked in the PLAN dialogue.
   *
   * `true` means this run is waiting for an answer and will read the message as
   * one — a different fact from `pushLiveMessage`'s `true`, which means a live
   * session took it. Both are false for a queued run and for one between
   * segments, which is the case the boundary drain exists for.
   *
   * IT DOES NOT STAMP `delivered_at` AND THE ROUTER MUST NOT EITHER: the turn is
   * asynchronous, and the orchestrator stamps only once the answer is durable.
   *
   * OPTIONAL FOR THE REASON `HttpDeps.env` IS: this interface is implemented by
   * eight test doubles across six files, two of them another fleet's untracked
   * work in progress, and a required member would break all of them for a method
   * none of them exercises. THE COST IS THAT A RENAME WOULD SILENTLY DISABLE THE
   * PLAN INTAKE rather than fail to compile — `?.` swallows a missing method — so
   * `plan-phase.test.ts` asserts the real `Orchestrator` still carries it, both
   * at the type level and at run time.
   */
  deliverPlanReply?(runId: string): boolean;
}

export interface HttpDeps {
  readonly store: RunStore;
  readonly bus: RunEventBus;
  readonly orchestrator: RunController;
  readonly catalog: ModelCatalog;
  readonly auth: AuthProbe;
  readonly paths: DashboardPaths;
  /**
   * The environment the RUN gets, for the gate probe below.
   *
   * OPTIONAL SO THAT `index.ts` NEED NOT CHANGE, and the default is truthful
   * only because of how `main` is called: `index.ts:46` hands the orchestrator
   * its own `env` and `index.ts:48` passes none here, but `main()` is invoked
   * with no argument in the only production path, so both are the same
   * `process.env` object. If `main(customEnv)` ever becomes real, index.ts must
   * pass `env` here too — otherwise the gate probe answers for a different
   * `BAKEOFF_SCORER_IMAGE` than the gate phase will use. See
   * `GateProbeOptions.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The cached scorer-gate probe. Built by {@link createDashboardServer} when
   * absent, which is every production caller; the seam exists so a test can hand
   * in a probe that does not spawn docker.
   */
  readonly gate?: GateProbe;
  /**
   * How a page named in a ticket gets captured. Defaults to real chromium.
   *
   * THE SEAM EXISTS BECAUSE THE ALTERNATIVE IS AN UNTESTABLE ROUTE. `POST
   * /api/runs` decides the ticket's identity from the capture's outline, and a
   * test that had to launch a browser to observe that would be a test nobody
   * runs. Injecting the capture lets the route's own behaviour — the fail-soft,
   * the manifest, the id — be checked with no network and no browser.
   */
  readonly captureSite?: (options: CaptureOptions) => Promise<SiteCaptureResult>;
  /**
   * The supervisor for locally-started published projects.
   *
   * OPTIONAL FOR THE SAME REASON `gate` IS — every existing caller builds this
   * server without one — but it is NOT interchangeable per request: it holds
   * the child processes, so a runner built inside `handle()` would forget every
   * project it started. `createDashboardServer` resolves it once.
   *
   * `index.ts` PASSES ITS OWN, and must: the boot reconcile and the shutdown
   * kill are called on that instance, and a server holding a different one
   * would leave its children running after exit.
   */
  readonly projects?: ProjectRunner;
}

/**
 * `HttpDeps` with the optional wiring resolved, exactly once, per server.
 *
 * The probe holds the cache and the in-flight promise, so it must be ONE object
 * for the life of the server — resolving it inside `handle()` would build a new
 * one per request and probe docker on every poll. The project runner holds live
 * child processes and has the same requirement, one layer up.
 */
interface ResolvedHttpDeps extends HttpDeps {
  readonly gate: GateProbe;
  readonly projects: ProjectRunner;
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

/**
 * The human-factors pass's record, off the run's own `results/` directory.
 *
 * THE SAME SHAPE AS `readDesignLock`, ON PURPOSE: a per-request read of one
 * small JSON file beside the run, absent for every run that never produced one.
 * No cache — a cached copy would be a second source of truth for a field whose
 * producer has never run, and the whole point of `#adversaryPhase` writing the
 * record on every exit is that the file IS the answer.
 *
 * THE RUN ID COMES OFF THE STORE ROW, NEVER OFF THE REQUEST. `runPathsFor` is
 * handed `row.runId`, which the store already resolved, so this adds no path
 * surface: an id that reaches here has already matched a persisted run.
 *
 * `results/` IS NOT SERVED AND MUST NOT BE. It holds held-out test titles and
 * the scorer's output; `code-files.ts`'s workspace-only fence is a security
 * control. This reads ONE known filename inside it, server-side, and puts four
 * values on the response — no route, no browsable directory.
 *
 * EVERY FAILURE IS `null`. An unreadable, corrupt or absent record all report
 * "no pass on this run", and api-types.ts says so where the field is declared:
 * the distinction that IS preserved is the one inside a readable record, between
 * a pass that filed no report and a pass that found nothing.
 */
function readAdversaryPass(resultsDir: string): ApiAdversaryPass | null {
  const path = join(resultsDir, ADVERSARY_RECORD_FILE);
  if (!existsSync(path)) return null;
  try {
    return adversaryPassFromRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function toDetail(
  row: RunRow,
  store: RunStore,
  paths: DashboardPaths,
  env: NodeJS.ProcessEnv,
): RunDetail {
  const screenshots = store.listScreenshots(row.runId);
  // ABSENT MEANS "NO DESIGN LANE", AND THAT IS NOT THE SAME AS AN EMPTY LOCK.
  // The record is written by the lane itself, so a run that never had one has
  // no file — and `null` here says exactly that, while a file saying
  // `{awaiting: false, locked: null}` says the lane ran and locked nothing.
  const results = runPathsFor(paths, row.runId).results;
  const lock = readDesignLock(results);
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
    /*
     * HOW LONG THIS RUN HAS BEEN QUIET — DERIVED PER REQUEST, PERSISTED NOWHERE.
     *
     * `silenceOf` owns every rule, including the one a call site would get wrong:
     * it returns `null` for anything that is not `running`, and `null` MEANS "NOT
     * WATCHED" rather than "healthy". A queued run has not started, the two parks
     * are supposed to be quiet, and a terminal run is finished — none of them is a
     * measurement, and none of them may render as a green tick. Read
     * `ApiRunSilence` before rendering any of it.
     *
     * `deps.env ?? process.env` is the same default the gate probe takes above,
     * and for the same reason: `main()` is invoked with no argument in the only
     * production path, so the two are the same object.
     */
    silence: silenceOf(row, store, env),
    screenshots,
    /*
     * WHAT THE OWNER ATTACHED, WITH AN ADDRESS A PAGE CAN OPEN.
     *
     * OFF THE MANIFEST ON DISK, per request, like `readDesignLock` and
     * `readAdversaryPass` above — the bytes and their digests were never in
     * SQLite, so the row cannot answer this. `listAttachments` reads
     * `references/references.json` for BOTH lists and returns `[]` when it is
     * absent or unreadable; api-types.ts states that flattening where the fields
     * are declared.
     *
     * `row.runId`, NEVER THE REQUEST'S STRING, exactly as the `results` read
     * above: the id reaching here has already matched a persisted run, so this
     * adds no path surface.
     *
     * THESE ARE NOT `designLock.mockups`. Those are generated proposals; these
     * are the owner's own uploads, and the two answer different questions.
     */
    references: listAttachments(paths.runs, row.runId, "references"),
    documents: listAttachments(paths.runs, row.runId, "documents"),
    artifactPath: row.artifactPath,
    previewUrl: row.previewUrl,
    /*
     * WHERE THE FINISHED CODE WAS COPIED, or `null` when no publish was recorded.
     *
     * THREE STATES, NOT TWO. `null` is "nothing was attempted, as far as this
     * server can tell" — no record file, a run that has not gone terminal, or one
     * that finished before the lane existed; `{published: false}` is "it was
     * attempted and declined", with the refusal named. Collapsing them into "no
     * folder" is the conflation `ApiPublishedProject` exists to refuse.
     *
     * READ SERVER-SIDE FROM `results/`, which is NOT opened to the browser and
     * must not be: it holds held-out test titles, and the workspace-only fence in
     * `code-files.ts` is a security control rather than a routing convenience.
     */
    publishedProject: readPublishedProject(results),
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
    // STRAIGHT OFF THE ROW, WHICH IS THE REDACTED COPY: `db.ts:746` is the only
    // writer of this column and it runs `redactForPersistence` over the text
    // first. It is NOT a status — a run parked at `awaiting_input` carries the
    // DESIGN lane's failure while it is still live and still resumable — and it
    // is last-write-wins across five writers, so it names the LAST thing that
    // went wrong and not necessarily the one that ended the run. api-types.ts
    // carries both caveats for the client that renders it.
    failureReason: row.failureReason,
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
    // ABSENT MEANS "NO PASS RECORD ON THIS RUN", which is what EVERY run says
    // today: the lane needs a `previewUrl` and has never executed. The
    // distinction this field is here for is the one INSIDE a record —
    // `findings: null` (the pass left no report) against `findings: []` (it
    // reported and found nothing) — and `adversaryPassFromRecord` owns it. See
    // api-types.ts's ApiAdversaryPass for the full truth table before rendering
    // any of it.
    adversary: readAdversaryPass(results),
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

/**
 * Buffer a request body, refusing one that is too big for its route.
 *
 * `maxBytes` DEFAULTS TO THE SMALL CAP, so a route that says nothing gets the
 * conservative one. Only the two attachment-bearing routes opt into
 * {@link MAX_ATTACHMENT_BODY_BYTES}, and the refusal names the limit that
 * actually applied — the previous message said only "request body too large",
 * which for an oversized upload pointed the reader at the image cap rather than
 * at the envelope cap that had really fired.
 *
 * THE REFUSAL IS A THROW, NOT A RESPONSE, and what the caller sees therefore
 * depends on the route: `createRun` and `postMessage` catch it and answer 400
 * `invalid_body` with this message inside, while a route that does not catch it
 * (`POST /api/runs/:id/resume`) surfaces it through `createDashboardServer`'s
 * handler as a 500 `internal_error` carrying the same sentence.
 * `api-documents.test.ts` pins both, because the second one is the negative
 * control proving the cap really is per-route rather than global.
 */
async function readBody(request: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * What {@link readBody} throws when a body exceeds its route's cap.
 *
 * A TYPE RATHER THAN A MESSAGE PREFIX, because both attachment routes have to
 * tell this apart from a JSON parse error and answer differently — and the chat
 * route in particular MUST NOT answer "body must be JSON" to an owner whose 10 MB
 * scope document was refused by the envelope, which is what it did before: the
 * one thing wrong with the request was the only thing the message did not
 * mention. Matching on `error.message.startsWith(…)` would work today and break
 * silently the first time the sentence is reworded.
 *
 * THE MESSAGE NAMES THE LIMIT THAT ACTUALLY FIRED, which is the whole point of
 * per-route caps: quoting the per-image or per-document limit here would send
 * the reader after a cap their request never reached.
 */
export class BodyTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`request body too large (over ${String(maxBytes)} bytes)`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export function createDashboardServer(deps: HttpDeps): Server {
  const resolved: ResolvedHttpDeps = {
    ...deps,
    gate:
      deps.gate ??
      new GateProbe({ paths: deps.paths, env: deps.env ?? process.env }),
    // A DEFAULT RUNNER SPAWNS NOTHING until a route asks it to, so building one
    // for a server that never serves `/api/projects` costs an object.
    projects: deps.projects ?? new ProjectRunner({ paths: deps.paths, env: deps.env ?? process.env }),
  };
  const server = createServer((request, response) => {
    void handle(resolved, request, response).catch((error: unknown) => {
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

async function handle(deps: ResolvedHttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments[0] !== "api") {
    sendError(response, 404, "not_found", `no route for ${method} ${path}`, null);
    return;
  }

  // GET /api/health
  //
  // TWO INDEPENDENT PROBES, AND `ok` STILL ANSWERS FOR AUTH ALONE. The gate is a
  // separate field rather than a term in `ok` because the two failures have
  // different remedies and different consequences: no login means no run at all,
  // while no docker means a run that builds, produces code and cannot be SCORED.
  // `cron-tick.ts:261-270` reads `ok` and journals "no CLI is authenticated" when
  // it is false, so folding docker in would stop the unattended scheduler with a
  // sentence naming the wrong cause.
  //
  // BOTH ARE AWAITED TOGETHER because they are two independent subprocess
  // spawns, both cached, and neither depends on the other's answer. The gate
  // probe has its own deadline (`health-gate.ts`) and cannot hold this response
  // open for the docker CLI's own 120 s.
  if (segments.length === 2 && segments[1] === "health" && method === "GET") {
    const [auth, gate] = await Promise.all([deps.auth.status(), deps.gate.status()]);
    const body: HealthResponse = {
      ok: auth.claude === "ok" || auth.codex === "ok",
      claudeAuth: auth.claude,
      codexAuth: auth.codex,
      gate,
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

  /* GET /api/projects
   * POST /api/projects/:slug/start   |  POST /api/projects/:slug/stop
   * GET  /api/projects/:slug/logs                    (additive; see the file header)
   *
   * THE SLUG IS NEVER TOUCHED HERE. `segments` are still percent-encoded
   * (`URL.pathname` does not decode) and nothing below decodes them, exactly as
   * for the attachment routes: `resolveProjectDir` owns the allowlist, the join
   * and the realpath containment re-check, and its character class has no `%`.
   * A router that helpfully decoded first would reopen the double-decode hole on
   * the one route in this file that SPAWNS A PROCESS from the path it resolves.
   */
  if (segments[1] === "projects") {
    if (segments.length === 2 && method === "GET") {
      const body: ApiProjectsResponse = deps.projects.list();
      sendJson(response, 200, body);
      return;
    }
    if (segments.length === 4) {
      const slug = segments[2] ?? "";
      const action = segments[3];
      /* THE SAME CROSS-ORIGIN REFUSAL THE SECRET INTAKE MAKES, AND FOR A BIGGER
       * REASON. A page the owner did not open cannot READ this API — no CORS
       * header is ever set — but without a preflight it can still POST, and the
       * effect of these two routes is not a stored value: it is a PROCESS
       * SPAWNED or KILLED on the owner's machine. `originIsDashboard` allows an
       * absent `Origin` (curl, the cron tick) and refuses a present one that is
       * not loopback, including the literal "null" a sandboxed iframe sends. */
      if (method === "POST" && !originIsDashboard(request.headers.origin)) {
        sendError(
          response,
          403,
          "cross_origin_write",
          "a project may only be started or stopped from the dashboard's own page",
          "Use the dashboard at http://127.0.0.1:4319, or send the request with no Origin header.",
        );
        return;
      }
      if (action === "start" && method === "POST") {
        const outcome = await deps.projects.start(slug);
        if (!outcome.ok) {
          sendError(response, outcome.status, outcome.code, outcome.message, outcome.remediation);
          return;
        }
        const body: ApiProjectStartResponse = { started: outcome.started, project: outcome.project };
        sendJson(response, 200, body);
        return;
      }
      if (action === "stop" && method === "POST") {
        const outcome = await deps.projects.stop(slug);
        if (!outcome.ok) {
          sendError(response, outcome.status, outcome.code, outcome.message, outcome.remediation);
          return;
        }
        const body: ApiProjectStopResponse = { stopped: outcome.stopped, project: outcome.project };
        sendJson(response, 200, body);
        return;
      }
      if (action === "logs" && method === "GET") {
        const outcome = deps.projects.logs(slug);
        if (!outcome.ok) {
          sendError(response, outcome.status, outcome.code, outcome.message, outcome.remediation);
          return;
        }
        const body: ApiProjectLogs = outcome.logs;
        sendJson(response, 200, body);
        return;
      }
    }
    sendError(response, 404, "not_found", `no route for ${method} ${path}`, null);
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
    sendJson(response, 200, toDetail(row, deps.store, deps.paths, deps.env ?? process.env));
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

  /* GET /api/runs/:id/messages — the owner↔run chat, oldest first.
   *
   * BOTH DIRECTIONS, IN ONE SEQUENCE. `role` is `owner` or `run`, and ordering by
   * `seq` (which `RunStore.messages` does) is what makes a reply readable as a
   * reply — a client sorting by `at` would be sorting two clocks that agree only
   * by luck. `run` rows have had a producer since 2026-07-31: the agent's own last
   * message of a segment, stored verbatim by `AgentReplyWatch` and stored only
   * when it actually said something. A run that answered nothing has no row here,
   * and that ABSENCE is the honest state — this route never manufactures one.
   *
   * Served from the durable table, like everything else here. `deliveredAt: null`
   * on an OWNER message means the run has not folded it into a prompt yet — and on
   * a FINISHED run it means it never did, which the UI renders as such rather than
   * implying the instruction landed. On a `run` row it is always null and means
   * NOTHING: nothing here can know whether the owner read a reply. The chat panel
   * gates the delivery line on `role === "owner"` for exactly that reason. */
  if (segments.length === 4 && segments[3] === "messages" && method === "GET") {
    sendJson(response, 200, { messages: deps.store.messages(runId) });
    return;
  }

  /* POST /api/runs/:id/messages — say something to a run that is already going.
   *
   * Accepts `{ text, images?, documents? }` as JSON, both arrays of data URLs.
   *
   * WHY DATA URLs AND NOT MULTIPART. The only client is one fetch in this app's own
   * chat box, `secret-intake.ts` is the only multipart parser here and it is
   * deliberately narrow, and a hand-rolled second one is a boundary parser written
   * for one caller. `FileReader.readAsDataURL` on the browser side costs 33% in
   * base64 over a loopback socket for images that are screenshots, not video.
   *
   * The bytes are written under `runs/<id>/chat/` and the ROW STORES PATHS: the
   * builder needs a path to `Read`, and a 2MB PNG does not belong in SQLite. */
  if (segments.length === 4 && segments[3] === "messages" && method === "POST") {
    await postMessage(deps, runId, row, request, response);
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

  /* POST /api/runs/:id/publish  (additive; see the file header)
   *
   * KEYED ON THE RUN, NOT ON THE PROJECT FOLDER, because that is what
   * `republishProject` takes: it works out `runs/<id>/workspace` itself and the
   * folder is an OUTPUT of the publish, not an input to it. `ApiProject.runId`
   * is how the projects list reaches this route.
   *
   * WITHOUT IT THE HANDOVER ONLY EVER HELPS FUTURE RUNS. `publishProject` is
   * called from the orchestrator's terminal path, and every run on this machine
   * is already terminal — so the one published project would never gain a
   * repository, a README or a schema dump.
   */
  if (segments.length === 4 && segments[3] === "publish" && method === "POST") {
    // It writes into `projects/`, commits, and can preserve the owner's own
    // uncommitted work under a machine-authored message. Same guard, same
    // reason as the two project routes above.
    if (!originIsDashboard(request.headers.origin)) {
      sendError(
        response,
        403,
        "cross_origin_write",
        "a run may only be published from the dashboard's own page",
        "Use the dashboard at http://127.0.0.1:4319, or send the request with no Origin header.",
      );
      return;
    }
    republishRoute(deps, row, response);
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

  /* GET /api/runs/:id/preview/*  (additive; see the file header)
   *
   * `>= 4`, NOT `=== n`: everything after `preview` is the path inside the
   * workspace, and a site's assets are at arbitrary depth. `url` is passed whole
   * rather than the tidied `path` computed at the top of this function, because
   * that one has had its TRAILING SLASH STRIPPED and the trailing slash is the
   * difference between `styles.css` resolving inside the preview and one level
   * above it. `segments` are still percent-encoded here — `URL.pathname` does not
   * decode — which is what `decodePreviewPath` is for. */
  if (segments.length >= 4 && segments[3] === "preview" && method === "GET") {
    servePreview(deps, runId, segments.slice(4), url, response);
    return;
  }

  // GET /api/runs/:id/screenshots/:file  (additive; see the file header)
  if (segments.length === 5 && segments[3] === "screenshots" && method === "GET") {
    serveScreenshot(deps, runId, segments[4] ?? "", response);
    return;
  }

  /* GET /api/runs/:id/references/:file  and  GET /api/runs/:id/documents/:file
   * (additive; see the file header)
   *
   * BELOW THE `row === null` CHECK ABOVE, WHICH IS LOAD-BEARING. An unknown run
   * id is answered `unknown_run` by the dispatcher before any handler sees it,
   * so this route cannot be used to ask whether a run exists in a second,
   * differently-worded way. `api-attachments.test.ts` asserts the error CODE
   * and not just the status, so moving this branch above that check is red.
   *
   * The kind is the same string as the directory name and the same string as the
   * URL segment — see `AttachmentKind`. `segments` are still percent-encoded
   * here (`URL.pathname` does not decode) and NOTHING BELOW DECODES THEM: the
   * filename allowlist in `run-attachments.ts` has no `%` in its character
   * class, which is how the double-decode hole stays closed by construction. */
  if (segments.length === 5 && method === "GET") {
    const kind = segments[3] ?? "";
    if (isAttachmentKind(kind)) {
      serveAttachment(deps, runId, kind, segments[4] ?? "", response);
      return;
    }
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
/**
 * The chat's image caps ARE the ticket form's image caps, and there is now one
 * declaration of each.
 *
 * They were duplicated here as `MAX_CHAT_IMAGE_BYTES`/`MAX_CHAT_IMAGES` with the
 * same values `ticket-refs.ts` now owns; the decoder was duplicated too. Two
 * intakes with independently-editable caps is how one of them quietly stops
 * accepting what the other documents. The NUMBERS AND THE REGEX ARE UNCHANGED,
 * so the chat route behaves exactly as it did — apart from the body cap above,
 * which it was silently failing under.
 */

/** How long one message may be. Generous; a paste of a spec is legitimate. */
const MAX_CHAT_TEXT_CHARS = 8_000;

/**
 * Accept one owner message, with optional images and documents, and queue it for
 * the run.
 *
 * REFUSED ON A TERMINAL RUN, and that refusal is the honest part. A finished run has
 * no further segment boundary to drain at, so accepting the message would store an
 * instruction nothing will ever read while showing the owner a sent message. Better
 * to say the run is over.
 *
 * WHAT A DOCUMENT ON THIS ROUTE DOES AND — TODAY — DOES NOT DO. The bytes are
 * decoded under the same rules as the ticket form's (one `document-intake.ts`,
 * not a second dialect), written under `runs/<id>/chat/` beside the chat images,
 * and their paths are reported on the run's own event stream. THEY ARE NOT
 * DELIVERED TO THE RUNNING AGENT, and this route cannot make them be: the
 * `messages` table has a single `images` column (`db.ts:485`), `LiveMessage`
 * carries `{text, images}` only (`live-input.ts:33`), and `ownerMessageBlock`
 * renders "N image(s)" (`owner-message.ts`). Putting document paths into the
 * `images` field would deliver them and would make all three of those say
 * "image" about a PDF — a name that lies is the defect this repository keeps
 * finding, and here it would also feed a `Read` instruction about an image that
 * is not one.
 *
 * SO THE GAP IS ANNOUNCED RATHER THAN PAPERED OVER: a `warn` on the run's stream
 * names each stored path and says the running session was not given it. That
 * line is asserted by `api-documents.test.ts`, so wiring delivery without
 * removing the warning — or removing the warning without wiring delivery — fails
 * a test rather than quietly changing what an attachment means.
 */
async function postMessage(
  deps: HttpDeps,
  runId: string,
  row: RunRow,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (isTerminal(row.status)) {
    sendError(
      response,
      409,
      "run_finished",
      `run ${runId} is ${row.status}, so it has no remaining segment to read a message at`,
      "Start a new run with the revised brief instead.",
    );
    return;
  }

  let payload: unknown;
  try {
    // THE ATTACHMENT CAP, because this route carries images AND documents. See
    // MAX_ATTACHMENT_BODY_BYTES: under the default envelope cap the documented
    // 8 MB-per-image limit was unreachable and every oversized attachment failed
    // as a body error naming a limit no request could reach.
    payload = JSON.parse(await readBody(request, MAX_ATTACHMENT_BODY_BYTES));
  } catch (error) {
    /*
     * TWO FAILURES, TWO SENTENCES. A parse error still answers "body must be
     * JSON" WITHOUT quoting the body: `JSON.parse`'s own message includes the
     * offending text, and the offending text here is whatever the owner typed
     * into a chat box — the same reason the secret route refuses to use
     * `describeError` (see the file header). An oversized envelope is not a
     * parse error and must say so, or the one thing wrong with the request is
     * the only thing the refusal does not mention.
     */
    if (error instanceof BodyTooLargeError) {
      sendError(
        response,
        400,
        "body_too_large",
        error.message,
        `One message may carry ${String(MAX_REFERENCE_IMAGES)} image(s) and ` +
          `${String(MAX_REFERENCE_DOCUMENTS)} document(s). Send fewer, or smaller ones.`,
      );
      return;
    }
    sendError(response, 400, "invalid_body", "body must be JSON", null);
    return;
  }
  if (typeof payload !== "object" || payload === null) {
    sendError(response, 400, "invalid_body", "body must be a JSON object", null);
    return;
  }

  const record = payload as Record<string, unknown>;
  const text = typeof record["text"] === "string" ? record["text"].trim() : "";
  const rawImages = Array.isArray(record["images"]) ? record["images"] : [];

  // THE SAME VALIDATION THE TICKET FORM USES, from the same function, because
  // two intakes with independently-editable rules is how one of them quietly
  // stops accepting what the other documents — the reason the image caps were
  // moved into `ticket-refs.ts` in the first place.
  const documentIntake = readReferenceDocuments(record["documents"]);
  if (!documentIntake.ok) {
    sendError(response, documentIntake.status, documentIntake.code, documentIntake.message, documentIntake.remediation);
    return;
  }
  const rawDocuments = documentIntake.documents;

  if (text === "" && rawImages.length === 0 && rawDocuments.length === 0) {
    sendError(
      response,
      400,
      "empty_message",
      "a message needs text, at least one image, or at least one document",
      null,
    );
    return;
  }
  if (text.length > MAX_CHAT_TEXT_CHARS) {
    sendError(
      response,
      400,
      "message_too_long",
      `text is ${String(text.length)} characters; the limit is ${String(MAX_CHAT_TEXT_CHARS)}`,
      null,
    );
    return;
  }
  if (rawImages.length > MAX_REFERENCE_IMAGES) {
    sendError(
      response,
      400,
      "too_many_images",
      `${String(rawImages.length)} images; the limit is ${String(MAX_REFERENCE_IMAGES)}`,
      null,
    );
    return;
  }

  // `runPathsFor` is how every other route resolves a run directory; there is no
  // `paths.runDir`, and inventing a second way to join `runs/<id>` is how two
  // places end up disagreeing about where a run lives.
  const chatDir = join(deps.paths.runs, runId, "chat");
  mkdirSync(chatDir, { recursive: true });

  const written: string[] = [];
  for (const [index, raw] of rawImages.entries()) {
    const decoded = decodeReferenceDataUrl(raw);
    if (decoded === null) {
      sendError(
        response,
        400,
        "invalid_image",
        `image ${String(index + 1)} is not a base64 data URL of a supported type, or exceeds ${String(MAX_REFERENCE_IMAGE_BYTES)} bytes`,
        "Supported: png, jpeg, webp, gif.",
      );
      return;
    }
    // Named by message time and ordinal so the directory sorts chronologically and
    // an owner uploading `Screenshot.png` twice cannot overwrite the first one.
    const name = `${String(Date.now())}-${String(index + 1)}.${decoded.ext}`;
    const path = join(chatDir, name);
    writeFileSync(path, decoded.bytes);
    written.push(path);
  }

  /*
   * THE DOCUMENTS GO TO `runs/<id>/chat/`, NOT `runs/<id>/documents/`.
   *
   * `documents/` holds the TICKET's attachments, whose digests are in the ticket
   * id. A mid-run attachment is not and must not become part of that identity —
   * the row's `ticketId` was written when the run was created and the frozen
   * suite is addressed by it — so keeping the two directories apart means a
   * future pass that folds "everything under documents/" into an id cannot
   * silently swallow a chat attachment and re-point a live run at a different
   * suite. `ticket-refs.ts#documentDirFor` states the same split from the other
   * side.
   *
   * `-doc-` IS IN THE NAME so a directory listing distinguishes these from the
   * chat images, which use the same timestamp-and-ordinal scheme.
   */
  const writtenDocuments: string[] = [];
  for (const [index, decoded] of rawDocuments.entries()) {
    const path = join(chatDir, `${String(Date.now())}-doc-${String(index + 1)}.${decoded.extension}`);
    writeFileSync(path, decoded.bytes);
    writtenDocuments.push(path);
  }

  const message = deps.store.appendMessage(runId, { role: "owner", text, images: written });

  /*
   * TRY THE LIVE SESSION FIRST — the switch away from boundary-only delivery.
   *
   * The SDK takes `prompt: string | AsyncIterable<SDKUserMessage>`, and a segment that
   * is running right now has an open channel (`LiveInput`) whose iterator is parked
   * waiting for exactly this. `shouldQuery: false` has the CLI fold the text into the
   * agent's next turn rather than interrupt a tool call — the behaviour of typing into
   * the interactive CLI while it works.
   *
   * STAMPED HERE ONLY IF IT LANDED. `pushLiveMessage` returns false for a parked,
   * queued or between-segments run; the row then stays pending and the boundary drain
   * carries it. Exactly one of the two paths stamps `delivered_at`, which is what
   * makes delivery at-most-once across both.
   */
  const live = deps.orchestrator.pushLiveMessage(runId, { text, images: written });
  if (live) deps.store.markMessagesDelivered(runId, [message.seq]);

  /*
   * A RUN PARKED IN THE PLAN DIALOGUE READS THIS AS AN ANSWER, NOT AS A
   * MID-RUN REDIRECTION — and it is the SAME intake, deliberately. Building a
   * second route for answers would mean two message tables, two delivery stamps
   * and two chances for one of them to drop the owner's sentence; the chat
   * channel already carries text and images to a specific run and already renders
   * both directions.
   *
   * ONLY WHEN THE LIVE PUSH DECLINED. A parked run has no open segment, so the
   * two are mutually exclusive by construction; asking in this order means a
   * running build's channel is never shadowed by a stale plan record.
   *
   * NOT STAMPED HERE. The turn itself is asynchronous — it makes a seat call —
   * and `PlanDriver` stamps the row only after `plan.json` is written. Stamping
   * here would lose an answer to a crash in between; leaving it pending costs at
   * worst a repeated turn.
   */
  const planned = live ? false : (deps.orchestrator.deliverPlanReply?.(runId) ?? false);

  /*
   * ON THE EVENT STREAM TOO, so the trace shows the redirection in the same
   * timeline as the work it changed. Without this the run record would show the
   * behaviour changing with no visible cause.
   */
  deps.bus.emit(runId, {
    type: "log",
    level: "info",
    text:
      (live
        ? "owner message delivered into the running session"
        : planned
          ? "owner message taken up by the plan dialogue, before any criteria are written"
          : "owner message queued for the next segment boundary") +
      (written.length > 0 ? ` with ${String(written.length)} image(s)` : "") +
      `: ${text.slice(0, 200)}`,
  });

  /*
   * THE DOCUMENTS GET THEIR OWN LINE, AND IT IS A `warn`.
   *
   * Not folded into the sentence above, which reports a DELIVERY. These were not
   * delivered: they are on disk and no seat has been told they exist. Reporting
   * that as part of "owner message delivered into the running session" would be
   * the message claiming more than the mechanism does, which is precisely what
   * the run's own trace exists to prevent.
   *
   * `warn` RATHER THAN `info` because a stored-but-unread attachment is a
   * degraded outcome the owner needs to see: they attached a scope expecting the
   * run to act on it. The paths are printed so it can be handed over by hand
   * (`@path` in the chat box, or a `Read` the owner asks for in words) until the
   * wiring exists.
   */
  if (writtenDocuments.length > 0) {
    deps.bus.emit(runId, {
      type: "log",
      level: "warn",
      text:
        `${String(writtenDocuments.length)} document(s) attached to this message were STORED, NOT ` +
        "DELIVERED. The chat channel carries text and image paths — the messages table has no " +
        "documents column and the live-session message shape has no field for one — so this message " +
        "did not hand them to the run, and no agent has been told they exist. Name the path in a " +
        "follow-up message if you need this run to open one. They are at: " +
        writtenDocuments.join(", "),
    });
  }

  // `live` lets the UI say "delivered now" instead of "waiting". Re-read so the
  // response carries the stamp the push just wrote.
  //
  // `documents` IS ON THE RESPONSE AND NOT ON `message`. The stored row has no
  // such column, and inventing one on the way out would show the owner a message
  // that the next `GET /api/runs/:id/messages` does not agree with.
  const stored = deps.store.messages(runId).find((m) => m.seq === message.seq) ?? message;
  sendJson(response, 202, { message: stored, live, documents: writtenDocuments });
}

function graphSnapshot(store: RunStore, runId: string): RunGraphResponse {
  const rows = store.eventsSince(runId, 0);
  /*
   * `row.at` TRAVELS INTO THE FOLD, and this line used to drop it.
   *
   * It was `rows.map((row) => row.event)`, which threw away the one column that
   * makes `GraphNode.activity` a timeline rather than a list. The row already had
   * it — `eventsSince` selects `at` — so the timestamp was read from SQLite and
   * discarded two expressions later.
   *
   * This is the SNAPSHOT path, which is what a reader of a FINISHED run gets;
   * the live path is `attachSse`. Both have to carry the time or the canvas shows
   * times on a running run and none on a completed one.
   */
  const state = foldGraphAll(rows.map((row) => ({ ...row.event, at: row.at })));
  return { atSeq: rows[rows.length - 1]?.seq ?? 0, ...state };
}

/**
 * Everything a create-run request said about references, validated.
 *
 * A DISCRIMINATED RESULT RATHER THAN A THROW, because every branch here is a
 * 400 with its own wording and `createRun` is already a wall of them.
 */
type ReferenceIntake =
  | { readonly ok: true; readonly images: readonly { readonly ext: string; readonly bytes: Buffer }[] }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly remediation: string | null };

function readReferenceImages(raw: unknown): ReferenceIntake {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_body",
      message: "references must be an array of base64 image data URLs when present",
      remediation: "Omit it entirely if the ticket has no reference images.",
    };
  }
  if (raw.length > MAX_REFERENCE_IMAGES) {
    return {
      ok: false,
      status: 400,
      code: "too_many_images",
      message: `${String(raw.length)} reference images; the limit is ${String(MAX_REFERENCE_IMAGES)}`,
      remediation: null,
    };
  }
  const images: { readonly ext: string; readonly bytes: Buffer }[] = [];
  for (const [index, value] of raw.entries()) {
    const decoded = decodeReferenceDataUrl(value);
    if (decoded === null) {
      return {
        ok: false,
        status: 400,
        code: "invalid_image",
        message:
          `reference ${String(index + 1)} is not a base64 data URL of a supported type, ` +
          `or exceeds ${String(MAX_REFERENCE_IMAGE_BYTES)} bytes`,
        remediation: "Supported: png, jpeg, webp, gif.",
      };
    }
    images.push(decoded);
  }
  return { ok: true, images };
}

/**
 * The same shape for DOCUMENTS, used by BOTH intake routes.
 *
 * ONE FUNCTION FOR TWO ROUTES, and it decodes through `document-intake.ts`
 * rather than re-stating any cap: the count, the per-file size, the accepted
 * media types and the base64 alphabet are that module's, and a second copy here
 * is how the ticket form and the chat box end up disagreeing about what a
 * document is.
 *
 * THE REFUSAL SENTENCE IS THE MODULE'S OWN. `decodeDocumentDataUrl` returns a
 * NAMED code with a sentence naming the actual cap or the actual type — "the
 * application/pdf payload is 18874368 bytes decoded; the limit is 12582912" —
 * and re-wording it here would produce a second, vaguer explanation of the same
 * refusal. Only the ordinal ("document 2") and the remediation are added.
 *
 * IT DOES NOT WRITE ANYTHING. Both callers need every document validated BEFORE
 * any bytes hit the disk, so that a request refused on its third attachment
 * leaves no half-written intake behind.
 */
type DocumentIntake =
  | { readonly ok: true; readonly documents: readonly DecodedDocument[] }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly remediation: string | null;
    };

function readReferenceDocuments(raw: unknown): DocumentIntake {
  if (raw === undefined || raw === null) return { ok: true, documents: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_body",
      message: "documents must be an array of base64 data URLs when present",
      remediation: "Omit it entirely if there are no documents.",
    };
  }
  if (raw.length > MAX_REFERENCE_DOCUMENTS) {
    return {
      ok: false,
      status: 400,
      code: "too_many_documents",
      message: `${String(raw.length)} documents; the limit is ${String(MAX_REFERENCE_DOCUMENTS)}`,
      remediation: null,
    };
  }
  const documents: DecodedDocument[] = [];
  for (const [index, value] of raw.entries()) {
    const decoded = decodeDocumentDataUrl(value);
    if (!decoded.ok) {
      return {
        ok: false,
        status: 400,
        code: "invalid_document",
        message: `document ${String(index + 1)}: ${decoded.detail}`,
        remediation:
          decoded.code === "unsupported-media-type"
            ? `Accepted: ${ACCEPTED_DOCUMENT_MEDIA_TYPES.join(", ")}.`
            : null,
      };
    }
    documents.push(decoded);
  }
  return { ok: true, documents };
}

/**
 * Decide which page, if any, this request wants captured.
 *
 * THREE INPUTS COLLAPSE TO ONE ANSWER. An explicit `captureUrl` string names a
 * page; an explicit `null` is the OPT-OUT and suppresses the scan entirely;
 * absent means "look in the ticket text", which is the case the owner's ask is
 * about ("make a copy of kamilborzecki.dev" carries no separate field).
 *
 * THE OPT-OUT EXISTS BECAUSE THE SCAN HAS A REAL FALSE-POSITIVE COST. A brief
 * that merely cites a URL would otherwise spend up to half a minute capturing a
 * documentation page, and — because the outline lands in the brief — would mint
 * a ticket id that moves whenever that page does.
 */
function requestedCaptureTarget(body: Record<string, unknown>, ticketText: string): ReturnType<typeof captureTargetIn> {
  const explicit = body["captureUrl"];
  if (explicit === null) return { kind: "none" };
  if (typeof explicit === "string" && explicit.trim().length > 0) return captureTargetFor(explicit.trim());
  return captureTargetIn(ticketText);
}

async function createRun(deps: HttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let payload: unknown;
  try {
    // THE ATTACHMENT CAP. This route carries reference images AND documents, so
    // it needs the same envelope the chat route needs — the SUM of the two, not
    // the larger; see MAX_ATTACHMENT_BODY_BYTES.
    payload = JSON.parse(await readBody(request, MAX_ATTACHMENT_BODY_BYTES));
  } catch (error) {
    // THE ENVELOPE REFUSAL IS ITS OWN CODE, so a client can tell "your JSON is
    // malformed" from "your attachments are 130 MB" without parsing prose.
    if (error instanceof BodyTooLargeError) {
      sendError(
        response,
        400,
        "body_too_large",
        error.message,
        `A ticket may carry ${String(MAX_REFERENCE_IMAGES)} image(s) and ` +
          `${String(MAX_REFERENCE_DOCUMENTS)} document(s). Send fewer, or smaller ones.`,
      );
      return;
    }
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
  const captureUrl = body["captureUrl"];
  if (captureUrl !== undefined && captureUrl !== null && typeof captureUrl !== "string") {
    sendError(
      response,
      400,
      "invalid_body",
      "captureUrl must be a string, null or absent",
      "null suppresses the capture; absent means the first URL in the ticket text is captured.",
    );
    return;
  }
  const intake = readReferenceImages(body["references"]);
  if (!intake.ok) {
    sendError(response, intake.status, intake.code, intake.message, intake.remediation);
    return;
  }
  // BOTH INTAKES RUN BEFORE ANY BYTES ARE WRITTEN. A ticket refused on its
  // second document must leave nothing behind: the run id below is minted after
  // this point, so a refusal here costs no directory and no row.
  const documentIntake = readReferenceDocuments(body["documents"]);
  if (!documentIntake.ok) {
    sendError(
      response,
      documentIntake.status,
      documentIntake.code,
      documentIntake.message,
      documentIntake.remediation,
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

  /*
   * THE RUN ID IS MINTED BEFORE THE TICKET, WHICH IS A REVERSAL.
   *
   * References are bytes, and bytes need a directory. The directory is the run's
   * own (`runs/<id>/references/`, the shape the chat images already use), so the
   * run id has to exist first — and it can, because it is a timestamp plus a
   * uuid and depends on nothing about the ticket. The TICKET is then minted from
   * the prose plus whatever those references turned out to be, and its id covers
   * them.
   */
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const referenceDir = referenceDirFor(deps.paths.runs, runId);
  const images: ReferenceImage[] = [];
  if (intake.images.length > 0) mkdirSync(referenceDir, { recursive: true });
  for (const [index, decoded] of intake.images.entries()) {
    // Ordinal-named, so the manifest order and the on-disk order are the same
    // reading, and a builder listing the directory sees the owner's sequence.
    const path = join(referenceDir, `reference-${String(index + 1)}.${decoded.ext}`);
    writeFileSync(path, decoded.bytes);
    images.push({ path, sha256: digestBytes(decoded.bytes), bytes: decoded.bytes.byteLength });
  }

  /*
   * THE DOCUMENTS, IN THEIR OWN DIRECTORY, AS PATHS AND DIGESTS.
   *
   * `runs/<id>/documents/` rather than beside the images, which is the owner's
   * ask spelled literally and costs nothing because the manifest records
   * ABSOLUTE paths — see `documentDirFor` for the second reason (the chat's
   * documents must not be able to land in the same place).
   *
   * ONLY THE PATH, THE DIGEST, THE SIZE AND THE MEDIA TYPE ARE RECORDED. The
   * bytes stay on disk: a 12 MB PDF has no business in a JSON manifest that is
   * re-read on every build, and `document-intake.ts` additionally states that a
   * document's base64 cannot be redacted — persisting it would persist any
   * credential the file happens to contain, in a form `redactForPersistence`
   * cannot see into.
   */
  const documentDir = documentDirFor(deps.paths.runs, runId);
  const documents: ReferenceDocument[] = [];
  if (documentIntake.documents.length > 0) mkdirSync(documentDir, { recursive: true });
  for (const [index, decoded] of documentIntake.documents.entries()) {
    const path = join(documentDir, `document-${String(index + 1)}.${decoded.extension}`);
    writeFileSync(path, decoded.bytes);
    documents.push({
      path,
      sha256: digestBytes(decoded.bytes),
      bytes: decoded.bytes.byteLength,
      mediaType: decoded.mediaType,
    });
  }

  /*
   * THE CAPTURE HAPPENS HERE, INSIDE THE POST, AND IT COULD NOT HAPPEN ANYWHERE
   * ELSE.
   *
   * The outline it produces is composed into the brief, so it decides the
   * ticket's identity — and the identity has to be settled before `createRun`
   * writes the row that everything downstream reads. Doing it later, in the
   * orchestrator, would mean the row's `ticketId` and the ticket the run is
   * actually graded under were different strings.
   *
   * IT IS ALSO THE ONLY MOMENT THE NETWORK IS BOTH PRESENT AND ALLOWED: the
   * builder has egress but produces nothing durable for the spec seat, and the
   * gate runs `--network none` by design and must keep doing so. Capturing at
   * ticket time turns one page into a durable artefact that the offline half of
   * the pipeline can be compared against LATER — by a human reading the Verdict
   * tab, or by a criterion the spec seat wrote from the outline. It does NOT
   * give the gate a way to diff the build against the live site, and nothing
   * here should be read as claiming that.
   *
   * THE COST IS A SLOWER POST, AND IT IS NOT SMALL. At most one capture per
   * submission, but its bounded parts sum to `CAPTURE_BUDGET_MS` — launch plus
   * navigation plus one screenshot per width, ~65 s today — and two DOM reads
   * carry playwright's own default on top of that. A healthy page is a few
   * seconds; a hanging one is most of a minute with no progress shown, because
   * this is a plain POST with no streamed status.
   */
  const target = requestedCaptureTarget(body, ticketText);
  const capture = await runCapture(deps, target, referenceDir);

  const ticket = ticketWithReferences({ prose: ticketText, images, documents, capture: capture.capture });
  if (images.length > 0 || documents.length > 0 || capture.capture !== null) {
    // `mkdirSync` HERE TOO, and not only in the loops above: a ticket whose only
    // attachment is a document creates `documents/` and never `references/`, and
    // `writeReferenceManifest` deliberately does not create its own directory
    // (`ticket-refs.test.ts` pins that). Without this line such a ticket throws
    // ENOENT out of a route that had already decoded and written its bytes.
    mkdirSync(referenceDir, { recursive: true });
    writeReferenceManifest(referenceDir, { images, capture: capture.capture, documents });
  }
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

  /*
   * THE REFERENCE STORY, ON THE RUN'S OWN STREAM, INCLUDING THE FAILURES.
   *
   * Emitted AFTER `createRun` because the bus persists against a row that has to
   * exist. This is the only place a failed capture is reported: the response is
   * still a 201 with a run id, deliberately — a third-party site being slow is
   * not a reason to refuse to build the ticket — so if this line is removed, a
   * ticket that says "copy this site" silently becomes a ticket graded from the
   * sentence alone, which is the exact failure this whole change exists to fix.
   *
   * `warn` FOR A FAILED CAPTURE, not `error`: the run is fine, it is just less
   * well specified than the owner asked for.
   */
  for (const line of captureNotes(capture, images.length, documents)) {
    deps.bus.emit(runId, { type: "log", level: line.level, text: line.text });
  }

  deps.orchestrator.pump();

  const body2: CreateRunResponse = { runId };
  sendJson(response, 201, body2);
}

/** A capture attempt as `createRun` needs it: the artefact, plus why not. */
interface CaptureAttempt {
  readonly capture: SiteCapture | null;
  /** null when nothing was attempted; a sentence when something went wrong. */
  readonly failure: string | null;
  /** The address that was tried, for the log line. */
  readonly url: string | null;
}

/**
 * Run the capture, or explain in one sentence why there is none.
 *
 * NEVER THROWS AND NEVER REFUSES THE RUN. `captureSite` already promises not to
 * throw; the try/catch is for the injected seam and for `mkdirSync`, because a
 * ticket must not be rejected because a directory could not be made for an
 * optional artefact.
 */
async function runCapture(
  deps: HttpDeps,
  target: ReturnType<typeof captureTargetIn>,
  dir: string,
): Promise<CaptureAttempt> {
  if (target.kind === "none") return { capture: null, failure: null, url: null };
  if (target.kind === "refused") {
    // The refusal reason is a clause, so it reads as one sentence in
    // `captureNotes` ("… was NOT captured: it names this machine.").
    return { capture: null, failure: target.reason, url: target.url };
  }
  try {
    mkdirSync(dir, { recursive: true });
    const capture = await (deps.captureSite ?? captureSite)({ url: target.url, dir });
    if (!capture.ok) return { capture: null, failure: capture.reason, url: target.url };
    return { capture: capture.capture, failure: null, url: target.url };
  } catch (error) {
    return { capture: null, failure: describeError(error), url: target.url };
  }
}

/**
 * What the owner is told about their references, on the run's event stream.
 *
 * SEPARATED FROM THE ROUTE SO IT CAN BE TESTED WITHOUT A SOCKET, and because the
 * wording is the only thing standing between a silently-unreferenced run and a
 * visible one.
 */
function captureNotes(
  attempt: CaptureAttempt,
  imageCount: number,
  documents: readonly ReferenceDocument[],
): readonly { readonly level: "info" | "warn"; readonly text: string }[] {
  const notes: { readonly level: "info" | "warn"; readonly text: string }[] = [];
  if (imageCount > 0) {
    notes.push({
      level: "info",
      text:
        `${String(imageCount)} reference image(s) attached to this ticket. They are part of the ` +
        "ticket's identity, so the same words with different references are a different ticket " +
        "with its own acceptance suite.",
    });
  }
  /*
   * THE DOCUMENT NOTE SAYS TWO THINGS, AND THE SECOND ONE IS THE UNCOMFORTABLE
   * ONE.
   *
   * What this intake genuinely does: it stores the bytes and folds their digests
   * into the ticket id, so a changed scope re-authors the suite — which is what
   * the owner asked for and is a real, checkable behaviour.
   *
   * What it does NOT do, today: put the document in front of any seat. Nothing
   * in this process reads `manifest.documents` — `builderReferenceSection` and
   * `designReferenceSection` render images and screenshots only (and
   * `hasReferences` deliberately does not count documents, so they cannot make
   * an empty "READ EACH ONE" block appear), and the spec seat is text-only. So
   * this line is a `warn` and says so in words. If it is ever demoted to `info`
   * without the prompts being wired, the run's own trace starts claiming an
   * attachment was used when nothing opened it — the exact failure the reference
   * notes exist to prevent.
   */
  if (documents.length > 0) {
    notes.push({
      level: "warn",
      text:
        `${String(documents.length)} document(s) attached to this ticket (` +
        documents.map((document) => `${document.mediaType}, ${String(document.bytes)} bytes`).join("; ") +
        "). Their digests ARE part of this ticket's identity, so changing one is a different ticket " +
        "with its own acceptance suite. STORED, NOT READ: this intake writes the bytes and records " +
        "their paths and digests, and hands them to no agent — whether a seat is given a document is " +
        "decided by the build and spec wiring, and if nothing later in this run quotes the document, " +
        "that is where to look. They are on disk at: " +
        documents.map((document) => document.path).join(", "),
    });
  }
  if (attempt.capture !== null) {
    notes.push({
      level: "info",
      text:
        `captured ${attempt.capture.url} at ${String(attempt.capture.shots.length)} width(s) and read ` +
        `${String(attempt.capture.outline.headings.length)} heading(s) off it. The written outline is ` +
        "part of the ticket text the acceptance suite is authored from; the screenshots are for the " +
        "builder to read. The sealed scorer still has no network and never compares the build to the " +
        "live page.",
    });
  } else if (attempt.failure !== null) {
    notes.push({
      level: "warn",
      text:
        `${attempt.url ?? "the page named in this ticket"} was NOT captured: ${attempt.failure}. ` +
        "The acceptance suite for this run will be written from your words alone, with no knowledge " +
        "of what that page looks like.",
    });
  }
  return notes;
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
 * Publish (or re-publish) a finished run's code, and answer with what happened
 * to the folder.
 *
 * SYNCHRONOUS, AND THAT IS A REAL COST: `republishProject` copies the workspace
 * on this thread, so the event loop is held for the duration. Measured on the
 * one published project here — 12 files, 1.37 MB — that is milliseconds; a run
 * that installed `node_modules` would be seconds, and the owner would see the
 * dashboard stall. It is still synchronous because the publish module is, and a
 * second, asynchronous copy path would be a second set of rules about
 * overwriting somebody's folder.
 *
 * A DECLINE IS THE ERROR ENVELOPE, NOT A 200. Nothing was published, so the
 * response says so in the shape every other refusal in this file uses; the
 * decline's own vocabulary becomes the error code. `run-not-terminal` is
 * deliberately never written to `results/` by the publish module — it would
 * overwrite the record the LIVE run will write when it finishes — so this
 * response body is the only place it is ever reported.
 */
function republishRoute(deps: ResolvedHttpDeps, row: RunRow, response: ServerResponse): void {
  const record = republishProject({ run: row, paths: deps.paths });
  if (!record.published) {
    sendError(
      response,
      record.reason === "copy-failed" ? 500 : 409,
      record.reason.replace(/-/g, "_"),
      record.detail,
      record.reason === "run-not-terminal" ? "Wait for the run to finish, or cancel it, then publish." : null,
    );
    return;
  }
  const repository = record.handover.repository;
  const body: ApiRepublishResponse = {
    runId: record.runId,
    path: record.path,
    publishedAt: record.publishedAt,
    fileCount: record.fileCount,
    bytes: record.bytes,
    repository: repository.state,
    commit: repository.state === "declined" ? null : repository.commit,
    repositoryDetail: repository.state === "declined" ? repository.detail : null,
    readme: record.handover.readme.state,
    gitignore: record.handover.gitignore.state,
    databases: record.handover.databases.map((database) => ({
      file: database.file,
      schema: database.dumped ? database.schemaPath : null,
    })),
    redirectedFrom: record.redirected?.from ?? null,
  };
  sendJson(response, 200, body);
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
 * The policy every preview response carries.
 *
 * IT IS NOT A SANDBOX AND MUST NOT BE READ AS ONE. The document is served from
 * the dashboard's OWN ORIGIN — there is only one port — so the run's JavaScript
 * runs beside the dashboard's. What this header removes is the single capability
 * that fact creates: `connect-src 'none'` stops fetch, XHR, EventSource,
 * WebSocket and `sendBeacon`, and `form-action 'none'` stops a form POST, so a
 * built page cannot call `POST /api/runs` (spending the owner's subscription),
 * `POST /api/runs/:id/cancel`, or read any route's body. `base-uri 'none'` stops
 * a `<base>` tag re-pointing every relative asset out of the preview.
 *
 * THERE IS NO `default-src`, DELIBERATELY. `default-src 'self'` would block the
 * inline `<style>` and inline `<script>` that essentially every generated site
 * uses, and a preview that renders blank is worse than no preview: a white page
 * is exactly what a broken build looks like, so the two become
 * indistinguishable. Third-party fonts and CDNs keep working for the same
 * reason. `sandbox allow-scripts` was the other candidate and was rejected on
 * mechanism, not taste — it puts the document on an opaque origin, which makes
 * ES modules require CORS the dashboard does not send and makes `localStorage`
 * THROW, killing the first script of a site that remembers a theme.
 *
 * WHAT IT DOES NOT COVER, stated because a reader will assume otherwise: a
 * top-level navigation or a subresource GET (`<img src="/api/…">`) to another
 * route is still possible. Every such route is read-only, and none returns a
 * credential value — `sendSecretJson` refuses to send a body containing one, and
 * the secret store lives outside every workspace. `frame-ancestors 'self'` lets
 * the dashboard's own page frame this and nothing else; since the server binds
 * loopback there is no other origin that could try.
 */
const PREVIEW_CSP =
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/**
 * Serve the run's workspace as a website.
 *
 * ROUTING AND HTTP ONLY. Which paths exist and which are refused is
 * `code-files.ts`'s — `resolvePreviewTarget` runs the same shape check, deny
 * list, realpath containment and bake-off assertion the code browser runs, which
 * is why `results/` is unreachable from here: it is a SIBLING of the workspace
 * (`runs/<id>/results/`) and three levels up (`<home>/results/`), so the fence
 * that keeps everything inside `workspace/` keeps the held-out test titles out
 * with no name-based rule to forget to extend.
 *
 * THE REDIRECT IS THE PART THAT LOOKS COSMETIC AND IS NOT. A document fetched at
 * `…/preview` resolves its own `styles.css` against `…/`, i.e. `/api/runs/:id/`,
 * where nothing lives — the page renders unstyled and scriptless and reads as a
 * failed build rather than a mis-linked one. So a directory reached WITHOUT a
 * trailing slash answers 302 to the same path with one, exactly as every static
 * server does, and only then is `index.html` read. `url.search` is carried
 * across so a query the client uses for its own bookkeeping survives the hop.
 *
 * A MISSING `index.html` IS A NAMED 409, not a 404 and not a blank 200; see
 * `previewIndexRefusal` for why the status is a conflict rather than a
 * not-found. Every other refusal arrives already worded from `code-files.ts`.
 */
/**
 * Candidate document roots, in order, when the workspace root has no entry
 * document.
 *
 * MEASURED, NOT GUESSED. `run-2026-07-30T20-16-40-242Z-052c6e02` — the owner's
 * kamilborzecki.dev copy — put its site at `site/index.html` and left
 * `package.json` and `server.mjs` at the workspace root. So the preview answered
 * its own honest refusal, "the build produced no index.html", about a build that
 * had produced one. Correct about the root it looked in, and useless to the
 * owner.
 *
 * THIS IS A LOOKUP, NOT A SEARCH. Six conventional names, one level deep, in a
 * fixed order — never a recursive hunt for any `index.html` anywhere, which
 * would happily serve a fixture out of `visible-acceptance/` and call it the
 * build.
 *
 * The empty string is FIRST and is the workspace root itself, so a build that
 * does put its entry document at the top is unaffected and pays nothing.
 */
const PREVIEW_ROOT_CANDIDATES: readonly string[] = ["", "site", "dist", "public", "build", "out"];

/**
 * The first candidate root that actually holds an entry document, or null.
 *
 * Returns the PREFIX to join in front of the request path, so assets resolve
 * against the same root the index came from — serving `site/index.html` and then
 * reading its `styles.css` from the workspace root renders an unstyled page and
 * reads as a broken build rather than a misrouted one.
 */
function previewRootPrefix(workspace: string): string | null {
  for (const candidate of PREVIEW_ROOT_CANDIDATES) {
    const indexPath =
      candidate === "" ? PREVIEW_INDEX_DOCUMENT : `${candidate}/${PREVIEW_INDEX_DOCUMENT}`;
    if (resolvePreviewTarget(workspace, indexPath).kind === "file") return candidate;
  }
  return null;
}

function servePreview(
  deps: HttpDeps,
  runId: string,
  rest: readonly string[],
  url: URL,
  response: ServerResponse,
): void {
  const workspace = runPathsFor(deps.paths, runId).workspace;

  const decoded = decodePreviewPath(rest);
  if (!decoded.ok) {
    const { status, code, message, remediation } = decoded.refusal;
    sendError(response, status, code, message, remediation);
    return;
  }

  /*
   * THE DOCUMENT ROOT APPLIES TO EVERY REQUEST, NOT JUST THE INDEX.
   *
   * A first version prefixed only `index.html` and would have served
   * `site/index.html` while resolving its `styles.css` against the workspace
   * root — an unstyled page that reads as a broken build rather than a misrouted
   * one, which is the exact failure the redirect above exists to prevent. So the
   * root is resolved ONCE here and every path is taken relative to it, which is
   * what a static server does.
   *
   * Empty prefix for a build whose entry document is at the top, so that path is
   * byte-for-byte what it was before this existed.
   */
  const previewRoot = previewRootPrefix(workspace) ?? "";
  const rooted = [previewRoot, decoded.path].filter((part) => part !== "").join("/");

  const resolved = resolvePreviewTarget(workspace, rooted);
  if (resolved.kind === "refusal") {
    const { status, code, message, remediation } = resolved.refusal;
    sendError(response, status, code, message, remediation);
    return;
  }

  if (resolved.kind === "directory") {
    if (!url.pathname.endsWith("/")) {
      // 302 AND NOT 301: a permanent redirect is cached by the browser for the
      // life of the profile, and this one is a statement about a directory that
      // a running build can turn into a file.
      response.writeHead(302, {
        Location: `${url.pathname}/${url.search}`,
        "Cache-Control": "no-store",
        "Content-Length": 0,
      });
      response.end();
      return;
    }
    const indexPath =
      resolved.path === "" ? PREVIEW_INDEX_DOCUMENT : `${resolved.path}/${PREVIEW_INDEX_DOCUMENT}`;
    const index = resolvePreviewTarget(workspace, indexPath);
    if (index.kind !== "file") {
      // EVERY non-file answer here becomes the SAME named refusal — missing,
      // itself a directory, or refused on its way through. The distinction the
      // owner needs is "your build has no entry document", and reporting
      // `not_found` for a path the client never asked for would send them
      // looking for a file called `index.html` in a URL they never typed.
      const { status, code, message, remediation } = previewIndexRefusal(resolved.target, resolved.path);
      sendError(response, status, code, message, remediation);
      return;
    }
    sendPreviewFile(index.target, indexPath, response);
    return;
  }

  sendPreviewFile(resolved.target, resolved.path, response);
}

/**
 * Stream one file of the preview.
 *
 * NO `Content-Length`, SO THE RESPONSE IS CHUNKED. A run's workspace is written
 * while the run is going, so a size measured before the read can be wrong by the
 * time the read finishes — and a body that disagrees with its own
 * `Content-Length` is a hung tab or a truncated asset, neither of which reads as
 * "the file changed". Chunked costs a few bytes per response on a loopback
 * socket.
 *
 * NO BYTE CAP EITHER, which is the opposite of `readWorkspaceFile`'s
 * `MAX_FILE_BYTES`. That cap exists because a 12 MB transcript rendered into a
 * JSON string in a browser tab freezes it; a browser streaming a 12 MB image
 * handles it natively, and truncating a PNG produces a broken image with no
 * explanation. Nothing is buffered in this process either way.
 *
 * THE STREAM'S `error` IS HANDLED. Headers are already sent by then, so there is
 * no status left to change and the only honest move is to break the connection —
 * but an unhandled `error` on a stream takes the whole server down, and a file
 * disappearing mid-read is a thing a live workspace genuinely does.
 */
function sendPreviewFile(target: string, relPath: string, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": previewContentType(relPath),
    // The workspace changes under a running run; a cached asset would show the
    // owner a build that no longer exists.
    "Cache-Control": "no-store",
    // With the octet-stream fallback in `previewContentType`, this means an
    // extension the table has never heard of DOWNLOADS instead of rendering.
    // That is the deliberate direction: the alternative is a browser sniffing an
    // unknown file into HTML and running it on the dashboard's own origin.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PREVIEW_CSP,
  });
  const stream = createReadStream(target);
  stream.on("error", () => {
    response.destroy();
  });
  stream.pipe(response);
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

/**
 * Serve one file the OWNER attached to this run's ticket.
 *
 * ROUTING ONLY. Every refusal, the containment check and the content type live
 * in `run-attachments.ts`, for the reason the file header gives: the list this
 * server advertises on `RunDetail` and the bytes it hands back must not be able
 * to disagree about what may be served, so one module decides both.
 *
 * ONE STATUS FOR EVERY REFUSAL, AND IT IS 404 RATHER THAN 403. A hostile
 * filename, an attachment this run never had, and a symlink that escapes the
 * directory are indistinguishable from outside — a route that answered 403 for
 * the third would be an existence oracle for the owner's filesystem, which this
 * process can read in full because it runs as his UID.
 *
 * THE STREAM'S `error` IS HANDLED, which `serveScreenshot` above does not do.
 * Headers are already sent by then so there is no status left to change, but an
 * unhandled `error` on a stream takes the whole server down — and unlike a
 * harness screenshot, an attachment sits in a directory the owner can and does
 * open in Finder. Same handling as `sendPreviewFile`.
 */
function serveAttachment(
  deps: HttpDeps,
  runId: string,
  kind: AttachmentKind,
  file: string,
  response: ServerResponse,
): void {
  const resolved = resolveAttachment(deps.paths.runs, runId, kind, file);
  if (resolved === null) {
    const noun = kind === "references" ? "reference" : "document";
    sendError(response, 404, "not_found", `no such ${noun} on this run`, null);
    return;
  }
  response.writeHead(200, attachmentHeaders(resolved));
  const stream = createReadStream(resolved.realPath);
  stream.on("error", () => {
    response.destroy();
  });
  stream.pipe(response);
}
