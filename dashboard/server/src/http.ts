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
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./dashboard-url.js";
import { ADVERSARY_RECORD_FILE, adversaryPassFromRecord } from "./adversary.js";
import type {
  ApiAdversaryPass,
  ApiContext7Review,
  ApiCreativeDecisionResponse,
  ApiCreativeStatus,
  ApiDesignLock,
  ApiDesignStage,
  ApiErrorResponse,
  ApiProjectLogs,
  ApiProjectStartResponse,
  ApiProjectStopResponse,
  ApiProjectsResponse,
  ApiRepublishResponse,
  ApiSupervisorCommandResponse,
  ApiSupervisorDesired,
  ApiSupervisorProbe,
  ApiSupervisorState,
  ApiSupervisorTicketFiled,
  ApiSupervisorTicketRow,
  ApiSupervisorTicketView,
  ApiSupervisorTicketsResponse,
  ApiTicketAttachments,
  ApiTicketManifestState,
  CreateRunResponse,
  HealthResponse,
  MessageIntent,
  SendMessageResponse,
  ModelOption,
  RunDetail,
  ApiScreenshot,
  RunGraphResponse,
  RunSummary,
} from "./api-types.js";
import { readContext7ReviewRecord } from "./context7-review-record.js";
import { briefShape } from "./brief-shape.js";
import type { BriefShapeFinding } from "./brief-shape.js";
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
import type {
  MessageRequestReceipt,
  RunRow,
  RunStore,
  SupervisorState as StoredSupervisorState,
  SupervisorTicket,
  SupervisorTicketState,
} from "./db.js";
import { DESIGN_MOCKUP_COPY_PREFIX, DESIGN_MOCKUP_LABEL, readDesignLock } from "./design-lock.js";
import type { DesignLockRecord } from "./design-lock.js";
import { MAX_DESIGN_LOCK_TURNS, MAX_DESIGN_ON_DEMAND_RENDERS } from "./design-prompt.js";
import { validateDesignReuseSource, writeDesignReuseMarker } from "./design-reuse.js";
import { readMachineChecks } from "./machine-checks.js";
import {
  claimCreativeDecision,
  pilotMayPublish,
  readCreativePilotStatus,
  writeCreativePilotStatus,
} from "./creative-pilot.js";
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
import { briefHasContent, ticketFromStoredReferences, ticketWithReferences, titleFromBrief } from "./ticket.js";
import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  decodeReferenceDataUrl,
  digestBytes,
  documentDirFor,
  manifestDocuments,
  manifestMotion,
  readReferenceManifest,
  referenceDirFor,
  referenceIdentityMaterial,
  writeReferenceManifest,
} from "./ticket-refs.js";
import type { ReferenceDocument, ReferenceImage, ReferenceManifest } from "./ticket-refs.js";
import {
  ACCEPTED_DOCUMENT_MEDIA_TYPES,
  MAX_DOCUMENT_BODY_BYTES,
  MAX_REFERENCE_DOCUMENTS,
  decodeDocumentDataUrl,
} from "./document-intake.js";
import type { DecodedDocument } from "./document-intake.js";
import { captureSite, captureTargetFor, captureTargetIn } from "./site-capture.js";
import type { CaptureOptions, SiteCapture, SiteCaptureResult } from "./site-capture.js";
import { captureMotion } from "./motion-capture.js";
import type { MotionCaptureOptions } from "./motion-capture.js";
import { normaliseMotion } from "./motion-spec.js";
import type { MotionCaptureResult, MotionSpec } from "./motion-types.js";
import {
  copyContinuationReferences,
  continuationBrief,
  continuationRunId,
  stageContinuationWorkspace,
  writeContinuationRecord,
} from "./run-continuation.js";

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
  resume(runId: string, chosenMockup?: string | null, chosenDirection?: string | null): boolean;
  /**
   * Push an owner message into a RUNNING segment's session.
   *
   * Returns false when there is no open segment — parked, queued, or between
   * segments — and the router then leaves the message pending for the boundary
   * drain. `true` means the text is in the live input queue. The orchestrator's
   * consumption callback stamps it only when the SDK iterator asks for it.
   */
  pushLiveMessage(
    runId: string,
    message: {
      text: string;
      images: readonly string[];
      seq: number;
      delivery: "merge" | "next";
    },
  ): boolean;
  /**
   * Hand an owner message to a run parked in the PLAN dialogue.
   *
   * `true` means this run is waiting for an answer and will read the message as
   * one — a different fact from `pushLiveMessage`'s `true`, which means a live
   * session accepted it. Both are false for a queued run and for one between
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
  /**
   * Hand an owner message to a run parked on a DESIGN CANVASS.
   *
   * `true` means this run will read it as a request to render a named section in
   * a named direction. FALSE FOR A MESSAGE THAT NAMES NEITHER, even on a parked
   * run — that is a mid-run instruction, it stays pending, and it reaches the
   * next build segment. This is the one way it differs from `deliverPlanReply`,
   * where every message on a parked run is a candidate answer.
   *
   * OPTIONAL, AND WITH THE SAME COST STATED ON `deliverPlanReply`: `?.` swallows
   * a rename, so `orchestrator.test.ts` asserts the real `Orchestrator` still
   * carries it.
   */
  deliverDesignRequest?(runId: string): boolean;
}

/**
 * The one thing this router needs the SUPERVISOR OBJECT for.
 *
 * A PORT OF ONE METHOD, AND THAT NARROWNESS IS THE DESIGN. Everything the
 * surface reports — the desired state, the tickets, their `next_action`, the
 * attempt numbers — is already durable in `supervisor_state` and
 * `supervisor_tickets` (design §7.2) and is read here through `deps.store`,
 * which is the SAME source `SupervisorLoop.snapshot()` reads. A panel that says
 * "idle" and a loop that is stuck therefore cannot disagree, because there is no
 * second copy of the answer to drift. A fatter port would have created one.
 *
 * WHAT THE OBJECT IS STILL FOR: it is the evidence that something on this
 * machine will ACT on the row. START writes `desired='running'` and then nudges
 * the loop so the owner does not wait out the 30 s interval; with no loop
 * present, START refuses rather than writing a row nothing will read. That
 * distinction is the difference between a switch and a picture of a switch.
 *
 * NOTHING HERE CREATES A RUN. The loop claims a ticket and submits it (design
 * §7.3 step 4) through the extracted `submitRun`; this router never mints a
 * ticket identity of its own. A bypassed `createRun` mints a DIFFERENT ticket
 * id, which finds no frozen suite and pays for a whole fresh spec phase — with
 * no throw and no compile error, which is why it has to be designed out rather
 * than remembered.
 */
export interface SupervisorController {
  /**
   * Run one decision pass now, synchronously, re-entrancy-guarded by the loop.
   *
   * Called after START only. It is not called on GET: a status read that
   * advanced the state machine would make the dashboard's own polling a driver
   * of the system it is watching.
   */
  tick(): unknown;
}

/**
 * How the in-flight ticket is chosen, oldest first within the first non-empty
 * band.
 *
 * `claimed` IS IN THE LIST AND MUST BE. A ticket claimed with a null
 * `currentRunId` is the only readable evidence that a submission was lost
 * between the claim and the run row; dropping it from this list would render
 * that state as "idle", which is precisely the failure the surface exists to
 * catch.
 */
const SUPERVISOR_ACTIVE_STATES: readonly SupervisorTicketState[] = ["claimed", "running", "repairing", "waiting"];

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
   * How a page the owner named as a MOTION REFERENCE gets read. Defaults to real
   * chromium.
   *
   * A SECOND SEAM RATHER THAN A WIDENING OF THE FIRST, because the two drivers
   * answer different questions and take different options: `captureSite` writes
   * screenshots into a directory and parses markup, `captureMotion` opens two
   * contexts at two reduced-motion settings and samples computed style per frame.
   * One seam would force every test that stubs either to know about both.
   *
   * THE SAME REASON THE FIRST ONE EXISTS: this route decides the ticket's
   * identity from what comes back, and a test that had to launch a browser to
   * observe that is a test nobody runs. `api-references.test.ts` drives every
   * outcome — a reading, a failure, an empty reading — through this seam with no
   * browser, and `motion-capture.browser.test.ts` is the only file allowed to
   * claim the real driver works.
   */
  readonly captureMotion?: (options: MotionCaptureOptions) => Promise<MotionCaptureResult>;
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
  /**
   * The autonomy supervisor, if this process has one.
   *
   * OPTIONAL, AND THE ABSENT CASE IS A FIRST-CLASS ANSWER RATHER THAN A HOLE.
   * `GET /api/supervisor` with no supervisor returns **200 with
   * `probe.wired:false`** and a sentence, not a 503 and not a plausible-looking
   * `stopped`. Both alternatives were rejected for the same reason: a 503 is
   * indistinguishable from "the dashboard is down", and a synthetic `stopped`
   * is indistinguishable from a healthy idle system — so the one state the owner
   * most needs to see, *there is no supervisor behind your start button*, would
   * be the state that renders identically to two others. The three POSTs DO
   * refuse with 503, because a command that cannot be carried out must not
   * answer 200.
   */
  readonly supervisor?: SupervisorController;
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
  /** The boot arm check's verdict, carried onto every supervisor response. */
  readonly supervisorArm: { readonly armed: boolean; readonly armNote: string };
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

/** Hash-only Context7 review projection; the record never contains raw docs. */
function readContext7Review(resultsDir: string): ApiContext7Review | null {
  const record = readContext7ReviewRecord(resultsDir);
  if (record === null) return null;
  return {
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    status: record.outcome.status,
    capabilityApplicability: record.outcome.capabilityApplicability,
    code: record.outcome.code,
    packages: record.scope.claims
      .filter((claim) => claim.kind === "external")
      .map((claim) => ({ package: claim.package, versionOrRange: claim.versionOrRange })),
    source: record.source,
    verdict: record.outcome.verdict,
    evidence: record.outcome.evidence,
    lifecycle: record.outcome.lifecycle,
  };
}

/**
 * `design-lock.json`, as the panel needs it — READ FROM ONE FILE.
 *
 * THE DIRECTIONS ARE MIRRORED INTO THE RECORD BY THE HOST rather than read out of
 * the workspace manifest here, following §17.3 rule 5's existing precedent: this
 * record already duplicates `locked`/`lockedBy`/`reason` for exactly that reason
 * — the workspace is the ARTEFACT and `results/` is the RECORD, and `results/` is
 * what the API may open. The manifest stays the single source of truth; every
 * host write of `design-lock.json` recomputes the mirror.
 */
function designLockOf(lock: DesignLockRecord, screenshots: readonly ApiScreenshot[]): ApiDesignLock {
  /*
   * `expanding` IS CHECKED BEFORE `settled`, and that ordering is the whole
   * reason `stage` is on the wire. Between the direction choice and the hero lock
   * the record reads `{awaiting: false, locked: null, chosenDirection: "x"}` —
   * which every "locked, else awaiting, else unlocked" ladder reports as UNLOCKED
   * ("the DESIGN lane finished without a design to lock") for the whole stage-B
   * window, five to seven generations long.
   *
   * `expanded` RATHER THAN `locked !== null` decides `settled`, because a
   * DEGRADED run finishes stage B with no still to lock at all — deriving it from
   * the lock would leave a completed degraded run reading `expanding` for ever.
   */
  const stage: ApiDesignStage =
    lock.directions.length === 0
      ? "none"
      : lock.chosenDirection === null
        ? "canvass"
        : lock.expanded
          ? "settled"
          : "expanding";
  return {
    awaiting: lock.awaiting,
    // Filtered on the label the lane wrote, whose ONE definition is
    // `DESIGN_MOCKUP_LABEL` in design-lock.ts. A second spelling here
    // is how the owner's mockup cards quietly become empty.
    mockups: screenshots.filter((shot) => shot.label.startsWith(DESIGN_MOCKUP_LABEL)),
    locked: lock.locked,
    lockedBy: lock.lockedBy,
    reason: lock.reason,
    directions: lock.directions.map((direction) => ({
      slug: direction.slug,
      name: direction.name,
      distinction: direction.distinction,
      // DERIVED, never stored, so it cannot disagree with `chosenDirection`, and
      // FALSE WHILE THE CHOICE IS OPEN — nothing is discarded until something is
      // chosen, and showing two of three as discarded before the owner has picked
      // would be the panel answering a question he has not been asked.
      discarded: lock.chosenDirection !== null && lock.chosenDirection !== direction.slug,
      mockups: direction.mockups,
      notes: direction.notes,
    })),
    chosenDirection: lock.chosenDirection,
    chosenDirectionBy: lock.chosenDirectionBy,
    stage,
    turnsUsed: lock.turnsUsed,
    turnsMax: MAX_DESIGN_LOCK_TURNS,
    rendersUsed: lock.rendersUsed,
    rendersMax: MAX_DESIGN_ON_DEMAND_RENDERS,
    requests: lock.requests.map((request) => ({
      at: request.at,
      section: request.section,
      direction: request.direction,
      outcome: request.outcome,
      detail: request.detail,
      // THE PUBLISHED COPY, matching a card's `path` exactly — the workspace ref
      // the record carries is not servable and must never reach the browser.
      mockup: publishedCopyOf(request.path, screenshots),
    })),
  };
}

/**
 * The SERVED copy of a workspace ref, or null.
 *
 * MATCHED AGAINST THE SCREENSHOTS THE RUN ACTUALLY PUBLISHED rather than built by
 * string concatenation, so a request whose still failed to copy reports `null`
 * instead of a path the screenshot route would 404. The prefix is added, never
 * stripped — `publishedMockupPath`'s rule, and the reason a ref genuinely named
 * `design-hero.png` matches its own copy and nothing else's.
 */
function publishedCopyOf(refPath: string | null, screenshots: readonly ApiScreenshot[]): string | null {
  if (refPath === null) return null;
  const wanted = `${DESIGN_MOCKUP_COPY_PREFIX}${basename(refPath)}`;
  return screenshots.find((shot) => basename(shot.path) === wanted)?.path ?? null;
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
    /*
     * THE OTHER HALF OF THE GRADE, AND IT HAD NO ROUTE TO THE SCREEN AT ALL.
     *
     * `listCriteria` above returns the frozen suite's `REQ-*` rows and nothing
     * else — the twelve `GATE:*` results the scorer produces update no row and
     * are dropped in `#gatePhase` (see `machine-checks.ts` for the measurement).
     * So a run could print "8 of 8 must-pass checks green" while the check that
     * failed it was one of the twelve, unnamed anywhere on the page.
     *
     * READ PER REQUEST FROM `results/scores/<runId>.json`, exactly like
     * `readDesignLock` / `readAdversaryPass` / `readPublishedProject` below: one
     * small JSON file, server-side, no cache, and `results/` stays unbrowsable.
     * `null` is "this run never reached the gate" and is never `[]`.
     */
    machineChecks: readMachineChecks(paths, row.runId),
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
    /*
     * OFF THE MANIFEST ON DISK, like `references` and `documents` above, because
     * the reading was taken at intake and SQLite never held it.
     *
     * `null` NOW MEANS WHAT A RENDERER WOULD ASSUME IT MEANS — no motion
     * reference was read for this run — where until this commit it meant "this
     * server has no producer". The three states are still distinguishable and a
     * panel must keep them apart: `null` is "none was read", a spec with an
     * empty `entries` is "a page was read and nothing moved in the sampling
     * window", and a spec with entries is a reading. Only the first is an
     * absence of a reference.
     *
     * A THIRD READ OF THE SAME SMALL FILE, and that is deliberate rather than
     * unnoticed: `listAttachments` owns the other two and takes a directory
     * rather than a manifest, so sharing one read means changing that module's
     * signature for a JSON file of a few hundred bytes read once per detail
     * request. Said here so the next reader knows it was weighed.
     */
    motion: manifestMotion(readReferenceManifest(referenceDirFor(paths.runs, row.runId))),
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
    designLock: lock === null ? null : designLockOf(lock, screenshots),
    // ABSENT MEANS "NO PASS RECORD ON THIS RUN", which is what EVERY run says
    // today: the lane needs a `previewUrl` and has never executed. The
    // distinction this field is here for is the one INSIDE a record —
    // `findings: null` (the pass left no report) against `findings: []` (it
    // reported and found nothing) — and `adversaryPassFromRecord` owns it. See
    // api-types.ts's ApiAdversaryPass for the full truth table before rendering
    // any of it.
    adversary: readAdversaryPass(results),
    context7Review: readContext7Review(results),
    creative: creativeStatusOf(results),
  };
}

function creativeStatusOf(resultsDir: string): ApiCreativeStatus | null {
  const status = readCreativePilotStatus(resultsDir);
  if (status === null || !status.enabled) return null;
  return {
    applicable: status.applicable,
    enabled: status.enabled,
    contractHash: status.contractHash,
    compileOutcome: status.compile.outcome,
    compileFindings: status.compile.findings.map((finding) => ({
      code: finding.code,
      path: finding.path,
      message: finding.message,
    })),
    renderManifestHash: status.renderManifestHash,
    renderFresh: status.renderFresh,
    renderProfiles: status.renderProfiles,
    criticDisposition: status.criticDisposition,
    criticFindings: status.criticFindings,
    criticAttempt: status.criticAttempt,
    reviewState: status.reviewState,
    reviewStopReason: status.reviewStopReason,
    ownerDecision: status.ownerDecision,
    ownerDecisionReason: status.ownerDecisionReason,
    ownerDecisionTargetRunId: status.ownerDecisionTargetRunId,
  };
}

/**
 * Hosts a `Referer` may name for the request to count as coming from the
 * dashboard's own page. The server binds loopback only (see the file header),
 * so nothing else can be one.
 */
const DASHBOARD_ORIGIN_HOSTS: readonly string[] = [LOOPBACK_HOST, "localhost"];
const DASHBOARD_OWNER_ORIGINS: ReadonlySet<string> = new Set([
  `http://${LOOPBACK_HOST}:4319`,
  "http://localhost:4319",
]);

/**
 * Is this create-run request INTERACTIVE, in the sense spec §17.3 rule 2 leaves
 * undefined?
 *
 * Rule 2 says a cron run auto-selects, and never says what makes a request a
 * cron run. Defined narrowly here: a request is interactive when it asks to be
 * (`designLock: "ask"`), or when it carries a `Referer` from a loopback page and
 * has not explicitly opted out with `designLock: "auto"`. Everything else —
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
  // `"auto"` IS AN OPT-OUT AND IS ANSWERED FIRST, BEFORE THE `Referer` RULE.
  //
  // CORRECTED 2026-08-09. This line used to read `requested === "auto" ||
  // requested === "ask"`, folding both explicit values into "a deliberate
  // caller". That is true of the caller and false of the QUESTION: the dashboard
  // always sends this field (`page.tsx:365`), and its two choices are "Ask me
  // which to build" and "Let ui-designer pick" — the second is the only control
  // on the screen that says *do not ask me anything*, and it produced
  // `interactive = true` exactly like the first.
  //
  // The mockup lock survived that, because `designLockPolicy` reads `requested`
  // before it reads this flag. The PLAN phase did not: `planPolicy(true)` is
  // `"ask"`, so an owner who picked the unattended-looking radio and walked away
  // paid a plan seat to compose questions and then a 20-minute park waiting for
  // an answer nobody was there to give.
  //
  // THE FAILURE DIRECTION IS UNCHANGED. Everything not explicitly `"auto"` still
  // falls through to the `Referer` rule, so a dashboard submission that states
  // nothing is still interactive and still asks; only the value that spells out
  // "pick for me" is taken at its word.
  if (requested === "auto") return false;
  if (requested === "ask") return true;
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

/* ----------------------------------------------------------------------
 * THE SUPERVISOR CONTROL SURFACE.
 *
 * Four routes and one composer. The composer is exported because the boot ARM
 * CHECK drives it directly: a panel whose failure mode is "renders the same
 * thing whatever happened" is exactly the defect this project keeps catching,
 * and the only way to know the composer can produce different answers is to
 * make it produce them while the answer is known.
 * ---------------------------------------------------------------------- */

/** What `nextAction` reads when the supervisor supplied nothing. Never blank. */
export const SUPERVISOR_NO_NEXT_ACTION =
  "the supervisor reported no next action — that is a supervisor defect, not an idle state";

/** What `probe.armNote` reads when there is nothing behind the route. */
export const SUPERVISOR_NOT_WIRED =
  "no supervisor is wired into this server: nothing will claim a ticket, and start/stop will refuse";

const SUPERVISOR_NO_REASON = "the supervisor recorded no reason for this state";

function nonBlank(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

/**
 * Milliseconds since this run last did something that was NOT routine telemetry.
 *
 * THE `rate_limit` EXCLUSION IS THE ENTIRE VALUE OF THIS FUNCTION, and it is
 * measured rather than tasteful: on run `a913c871` seven `rate_limit` frames
 * arrived during one 84m31s stretch in which the spec seat produced nothing, so
 * `runs.last_event_at` — which every event resets — showed a largest gap of
 * 25.2 minutes. Both numbers sit under `DEFAULT_SILENCE_WARN_MIN = 90`, which is
 * why nothing fired for an hour and a half. A quiet clock that counts telemetry
 * as progress reports a working system for as long as the provider keeps
 * answering.
 *
 * IT DOES NOT USE `store.lastRunEventAt`, deliberately: that reader is the
 * resets-on-anything one. The scan walks this run's events backwards and stops
 * at the first non-telemetry frame.
 *
 * With no such event the clock runs from `startedAt`, because "this run has
 * produced nothing at all" is the loudest version of quiet, not the absence of
 * an answer.
 */
export function supervisorQuietMs(store: RunStore, row: RunRow, nowMs: number): number {
  const events = store.eventsSince(row.runId, 0);
  let since = row.startedAt;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const stored = events[i];
    if (stored === undefined) continue;
    if (stored.event.type === "rate_limit") continue;
    since = stored.at;
    break;
  }
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, nowMs - parsed);
}

/**
 * Everything the composer reads, gathered once so the composer itself is pure.
 *
 * THE ARM CHECK IS THE REASON IT IS PURE. A composer that reached into the store
 * could only be armed by writing fake rows into the owner's database, which is
 * to say it would not be armed at all.
 */
export interface SupervisorComposerInput {
  readonly state: StoredSupervisorState;
  /** The ticket the loop is on, chosen by {@link SUPERVISOR_ACTIVE_STATES}. */
  readonly activeTicket: SupervisorTicket | null;
  readonly run: RunRow | null;
  readonly quietForMs: number | null;
  /** `supervisor_tickets` in state `queued`. */
  readonly queueDepth: number;
  /** Every supervisor ticket row, terminal ones included. */
  readonly ticketsSeen: number;
  readonly queuedRuns: number;
  readonly runsSeen: number;
  readonly eventsSeen: number;
  readonly wired: boolean;
  readonly armed: boolean;
  readonly armNote: string;
  readonly at: string;
}

/**
 * The wire fields that have no producer in this build, named on the wire.
 *
 * THIS IS NOT AN APOLOGY, IT IS THE CONTROL. `attempts: []`, `lastDefect: null`
 * and `lastRepair: null` are indistinguishable, to a reader, from "three
 * attempts happened and none is recorded" — which is exactly how run a913c871's
 * authoring trail was lost. Naming them means an empty attempts list can be read
 * as *nobody is writing one yet* rather than as *nothing happened*, and the day
 * a producer lands the name disappears from this array and the test that counts
 * it goes red.
 */
const SUPERVISOR_UNSOURCED = ["attempts", "lastDefect", "lastRepair"] as const;

/**
 * What `nextAction` says when no ticket is carrying its own sentence.
 *
 * EVERY BRANCH RETURNS A DIFFERENT ONE, and that is the requirement rather than
 * a nicety: this is the field the owner reads after eight hours away, and design
 * §7.2 gives `next_action` no default for the same reason — a state that has
 * nothing to say about itself is a state nobody can act on.
 */
function supervisorIdleAction(input: SupervisorComposerInput): string {
  if (!input.wired) return SUPERVISOR_NOT_WIRED;
  const queued = `${String(input.queueDepth)} ticket(s) queued`;
  if (input.state.desired === "stopped") {
    return input.queueDepth === 0
      ? "stopped, and nothing is queued — POST /api/supervisor/start after filing a ticket"
      : `stopped with ${queued}; nothing will be claimed until START`;
  }
  if (input.state.desired === "draining") {
    return input.run === null
      ? `draining with nothing in flight; the next tick settles to stopped, holding ${queued}`
      : `draining: ${input.run.runId} runs to its own verdict and no new ticket will be claimed`;
  }
  return input.queueDepth === 0
    ? "running with an empty queue; there is nothing to claim"
    : `running: the next tick claims the oldest of ${queued}`;
}

/**
 * Compose the wire body.
 *
 * Every never-blank promise in `ApiSupervisorState` is kept HERE rather than
 * trusted from the store, because the router is the last place that can keep
 * it: a blank `nextAction` renders as an empty line, which reads as "idle" and
 * in fact means a ticket was written into a state with nothing to say about
 * itself.
 */
export function composeSupervisorState(input: SupervisorComposerInput): ApiSupervisorState {
  const ticket: ApiSupervisorTicketView | null =
    input.activeTicket === null
      ? null
      : {
          ticketKey: input.activeTicket.ticketKey,
          title: titleFromBrief(input.activeTicket.ticketText),
          state: input.activeTicket.state,
          attemptNo: input.activeTicket.attemptNo,
          maxAttempts: input.activeTicket.maxAttempts,
        };
  const probe: ApiSupervisorProbe = {
    ticketsSeen: input.ticketsSeen,
    runsSeen: input.runsSeen,
    eventsSeen: input.eventsSeen,
    wired: input.wired,
    armed: input.armed,
    armNote: input.wired ? input.armNote : SUPERVISOR_NOT_WIRED,
    unsourced: SUPERVISOR_UNSOURCED,
  };
  return {
    desired: input.state.desired,
    changedAt: input.state.changedAt,
    changedBy: input.state.changedBy,
    reason: nonBlank(input.state.reason, SUPERVISOR_NO_REASON),
    at: input.at,
    ticket,
    run:
      input.run === null
        ? null
        : { runId: input.run.runId, phase: input.run.phase, status: input.run.status, quietForMs: input.quietForMs },
    attempts: [],
    lastDefect: null,
    lastDefectId: input.activeTicket?.lastDefectId ?? null,
    lastRepair: null,
    lastPatchId: input.activeTicket?.patchId ?? null,
    nextAction:
      input.activeTicket === null
        ? supervisorIdleAction(input)
        : nonBlank(input.activeTicket.nextAction, SUPERVISOR_NO_NEXT_ACTION),
    nextActionAt: input.activeTicket?.nextActionAt ?? null,
    queueDepth: input.queueDepth,
    queuedRuns: input.queuedRuns,
    probe,
  };
}

/** The three synthetic states the boot arm check drives the composer with. */
const ARM_STATE: StoredSupervisorState = {
  desired: "stopped",
  changedAt: "2026-08-10T00:00:00.000Z",
  changedBy: "boot",
  reason: "arm check",
};

const ARM_TICKET: SupervisorTicket = {
  ticketKey: "arm-check",
  ticketText: "arm check",
  modelId: "opus[1m]",
  designLock: "auto",
  state: "running",
  attemptNo: 2,
  maxAttempts: 3,
  classCounts: "{}",
  currentRunId: "arm-run",
  lastRunId: null,
  lastClass: null,
  lastDefectId: null,
  patchId: null,
  enqueuedAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  nextAction: "waiting for arm-run to reach a verdict",
  nextActionAt: null,
};

const ARM_INPUT: SupervisorComposerInput = {
  state: ARM_STATE,
  activeTicket: null,
  run: null,
  quietForMs: null,
  queueDepth: 0,
  ticketsSeen: 0,
  queuedRuns: 0,
  runsSeen: 0,
  eventsSeen: 0,
  wired: true,
  armed: true,
  armNote: "arming",
  at: "2026-08-10T00:00:00.000Z",
};

/**
 * THE ROUTE'S START-UP ARM CHECK, run once per server while the answer is known.
 *
 * TWO ARMS, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 * ARM ONE drives {@link composeSupervisorState} with three inputs that MUST
 * produce three different bodies — not wired, stopped with an empty queue, and
 * running on a ticket. A composer that has gone constant (an early `return`, a
 * swallowed argument) passes every "is it 200 with a body" test ever written and
 * fails this one. THE `probe` BLOCK IS STRIPPED BEFORE COMPARING, and that is
 * not tidiness: `probe.wired` and the counters are assembled outside the
 * composer's own branches, so they differ between these three inputs even when
 * everything the OWNER reads has collapsed to one constant. Measured, on this
 * file: a mutation that made the composer always return the not-wired body left
 * an unstripped arm reporting "3 distinguishable states" while three route
 * assertions went red. Comparing the state alone is what makes the arm strictly
 * stronger than the tests it guards.
 *
 * ARM TWO READS THE LIVE STORE ONCE and prints what it measured, in the idiom
 * that caught a real bug on 2026-08-09 (`ARM CHECK: seat matcher finds N
 * process(es); ceiling reads '64000'`). Arm one cannot see the failure this
 * component will actually have — a surface reading a different database, or a
 * loop nobody drives — and the cheap defence is to make the boot log state, in
 * measured values, what it read and whether anything will act on it.
 *
 * IT DOES NOT THROW, IN EITHER ARM. The owner's requirement is a system that
 * does not stop, and refusing to boot the dashboard because a status composer
 * looked odd would trade the whole surface for one panel. A blind composer sets
 * `probe.armed:false` on EVERY response instead, so the blindness travels on the
 * wire and the panel can say so.
 */
export function armSupervisorRoute(
  store: RunStore,
  supervisor: SupervisorController | undefined,
  log: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
  /**
   * OPTIONAL, AND THE ABSENT CASE REPORTS ITSELF.
   *
   * Arm four reads the ticket attachment directory off the real runs root. Given
   * no paths it CANNOT look, and says so on the boot line rather than printing a
   * confident "0 unreadable" for a directory it never opened — that number would
   * be the same one a healthy tree produces.
   */
  paths?: DashboardPaths,
): { readonly armed: boolean; readonly armNote: string } {
  const stateOnly = (state: ApiSupervisorState): string => {
    const { probe: _probe, ...rest } = state;
    void _probe;
    return JSON.stringify(rest);
  };
  const bodies = [
    stateOnly(composeSupervisorState({ ...ARM_INPUT, wired: false })),
    stateOnly(composeSupervisorState(ARM_INPUT)),
    stateOnly(
      composeSupervisorState({
        ...ARM_INPUT,
        state: { ...ARM_STATE, desired: "running" },
        activeTicket: ARM_TICKET,
        ticketsSeen: 1,
      }),
    ),
  ];
  const distinct = new Set(bodies).size;
  const composerArmed = distinct === bodies.length;
  const composerNote = composerArmed
    ? `composer renders ${String(distinct)} distinguishable states`
    : `BLIND: the composer renders only ${String(distinct)} of ${String(bodies.length)} states`;
  log(`ARM CHECK: supervisor route ${composerNote}`);

  const state = store.readSupervisorState();
  const tickets = store.listSupervisorTickets();
  const active = tickets.find((candidate) => SUPERVISOR_ACTIVE_STATES.includes(candidate.state)) ?? null;
  log(
    `ARM CHECK: supervisor route reads desired='${state.desired}' since ${state.changedAt}, ` +
      `${String(tickets.length)} ticket(s), ${String(tickets.filter((t) => t.state === "queued").length)} queued, ` +
      `active=${active === null ? "none" : `${active.ticketKey}/${active.state}`}, ` +
      `loop=${supervisor === undefined ? "NOT WIRED — nothing will claim a ticket and START will refuse" : "wired"}`,
  );

  /*
   * ARM THREE: DOES THE TICKET KEY SEE AN ATTACHMENT?
   *
   * THE FAILURE IT COVERS IS SILENT, EXPENSIVE AND SHAPED LIKE SUCCESS. If
   * `supervisorTicketKey` ever stops folding the attachment digests, the owner's
   * corrected CV under an unchanged brief answers 409 `ticket_already_queued` —
   * a REFUSAL that is indistinguishable from the duplicate guard working
   * properly, on the one route that decides what tonight is spent on. Every
   * "does it answer 201" test in the tree stays green through that.
   *
   * A PURE FUNCTION, TWO INPUTS, ONE COMPARISON, in arm one's idiom: the same
   * brief with and without a digest must not mint one key. The synthetic entry is
   * built here rather than read from disk so the arm costs nothing and cannot be
   * defeated by an empty tree.
   */
  const withoutAttachments = supervisorTicketKey("arm check brief", [], []);
  const withAttachment = supervisorTicketKey(
    "arm check brief",
    [{ path: "reference-1.png", sha256: "f".repeat(64), bytes: 1 }],
    [],
  );
  const keyArmed = withoutAttachments !== withAttachment;
  const keyNote = keyArmed
    ? `ticket key folds attachments (${withoutAttachments} vs ${withAttachment})`
    : `BLIND: the ticket key ignores attachments — both derive ${withoutAttachments}, so a corrected CV answers 409`;
  log(`ARM CHECK: supervisor ${keyNote}`);

  /*
   * ARM FOUR: WHAT IS ACTUALLY ON DISK UNDER `runs/tickets`.
   *
   * Arms one and three are pure; neither can see the failure this component will
   * really have, which is a filed CV that no longer parses — the state
   * `GET /api/supervisor/tickets` reports as `manifest: "unreadable"`. Printing
   * the two counts at boot is the cheap version of the same measurement, and with
   * no paths it says it could not look rather than printing a healthy-looking
   * zero.
   */
  const intakeNote =
    paths === undefined
      ? "BLIND: no runs root was passed, so no ticket manifest was read"
      : (() => {
          const readings = tickets.map((ticket) => readTicketManifest(paths.runs, ticket.ticketKey));
          return (
            `reads ${String(readings.filter((r) => r.state === "read").length)} ticket(s) with attachments, ` +
            `${String(readings.filter((r) => r.state === "unreadable").length)} unreadable, ` +
            `under ${ticketAttachmentRoot(paths.runs)}`
          );
        })();
  log(`ARM CHECK: supervisor ticket intake ${intakeNote}`);

  /*
   * `armed` IS THE CONJUNCTION OF THE TWO ARMS THAT CAN BE WRONG ABOUT A
   * BEHAVIOUR — the composer and the key. Arms two and four are MEASUREMENTS of a
   * live tree: an empty store is not a defect, so counting them here would set
   * `probe.armed:false` on every fresh install and train the owner to ignore it.
   *
   * ARM FOUR'S BLINDNESS DOES REACH THE WIRE, THOUGH, AND IT HAS TO. `paths` is
   * optional, so a caller that forgets it gets an arm that never looked — and a
   * boot line nobody reads is exactly how "0 unreadable" comes to mean "I did not
   * check". Measured: a mutation that dropped `deps.paths` at the one call site in
   * `createDashboardServer` was invisible to every test, because the arm's own
   * test calls this function directly. Folding the sentence into `armNote` puts it
   * on `GET /api/supervisor` and `GET /api/supervisor/tickets`, where a test — and
   * the owner — can see it.
   */
  const armed = composerArmed && keyArmed;
  const armNote = [composerNote, keyArmed ? null : keyNote, paths === undefined ? `ticket intake ${intakeNote}` : null]
    .filter((note): note is string => note !== null)
    .join("; ");
  return { armed, armNote };
}

/**
 * `GET /api/supervisor` — the whole machine-readable state, in one poll.
 *
 * READ FROM THE STORE, WHICH IS THE SAME SOURCE THE LOOP DECIDES FROM. There is
 * no second copy of the answer, so a panel that says "idle" and a loop that is
 * stuck cannot disagree. The counts and the quiet clock are computed here for
 * the same reason: a pass-through field is one whose only provable property is
 * that it was passed through.
 *
 * `probe.eventsSeen` is scoped to the CURRENT RUN, not to the database, because
 * its job is to say whether the quiet clock had anything to look at.
 */
function supervisorSnapshot(deps: ResolvedHttpDeps): ApiSupervisorState {
  const tickets = deps.store.listSupervisorTickets();
  const activeTicket = tickets.find((candidate) => SUPERVISOR_ACTIVE_STATES.includes(candidate.state)) ?? null;
  const runId = activeTicket?.currentRunId ?? null;
  const run = runId === null ? null : deps.store.getRun(runId);
  const runs = deps.store.listRuns();
  return composeSupervisorState({
    state: deps.store.readSupervisorState(),
    activeTicket,
    run,
    quietForMs: run === null ? null : supervisorQuietMs(deps.store, run, Date.now()),
    queueDepth: tickets.filter((candidate) => candidate.state === "queued").length,
    ticketsSeen: tickets.length,
    queuedRuns: runs.filter((candidate) => candidate.status === "queued").length,
    runsSeen: runs.length,
    eventsSeen: run === null ? 0 : deps.store.latestSeq(run.runId),
    wired: deps.supervisor !== undefined,
    armed: deps.supervisorArm.armed,
    armNote: deps.supervisorArm.armNote,
    at: new Date().toISOString(),
  });
}

/** The three commands, and nothing else answers on this prefix. */
const SUPERVISOR_ACTIONS = ["start", "stop", "abort-now"] as const;
type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];

function isSupervisorAction(value: string): value is SupervisorAction {
  return (SUPERVISOR_ACTIONS as readonly string[]).includes(value);
}

/* =========================================================================
 * TICKET ATTACHMENTS — the owner's uploads, filed BEFORE any run exists
 *
 * THE PROBLEM THIS SOLVES. `POST /api/runs` writes a ticket's images and
 * documents under `runs/<runId>/`, because that route mints the run id itself. A
 * SUPERVISOR ticket has no run: the loop mints one when it claims the ticket,
 * possibly hours later and possibly more than once. So the bytes need a home
 * that is named by the TICKET, and the ticket key is the only durable name it
 * has.
 *
 * MEASURED 2026-08-10, WHICH IS WHY THIS EXISTS. The route accepted `ticketText`
 * and `modelId` and nothing else. The owner's real ticket — "content comes from
 * the attached CV", an 80 KB PDF and a 560 KB reference image — answered 201 and
 * DROPPED both attachments silently, so the only way to run it was `POST
 * /api/runs`, which bypasses the supervisor entirely.
 * ====================================================================== */

/**
 * `runs/tickets` — the parent of every filed ticket's attachment directory.
 *
 * UNDER `runs/`, AND NESTED ONE LEVEL DEEPER THAN A RUN. Two reasons, both
 * measured rather than aesthetic:
 *
 *   IT IS GITIGNORED. `.gitignore` lists `dashboard/runs/`; it does NOT list a
 *   hypothetical `dashboard/tickets/`. A 560 KB reference image under an
 *   unignored path is one `git add -A` away from the repository, which is the
 *   exact accident the per-agent `dist-*` rule in that file was written about.
 *
 *   IT IS ONE DIRECTORY, NOT N PSEUDO-RUNS. `project-runner.ts:1213`
 *   `readdirSync`s the runs root and treats each directory as a run (it then
 *   skips anything with no publish record, so this is safe today). Putting
 *   tickets directly in the runs root would grow that scan by one entry per
 *   ticket for ever; this way it grows by exactly one, ever.
 *
 * `referenceDirFor` AND `documentDirFor` ARE THEN REUSED UNCHANGED, so a ticket's
 * attachments sit in the same `references/` + `documents/` shape a run's do — and
 * a submission that copies them into a run has nothing to translate.
 */
export function ticketAttachmentRoot(runsRoot: string): string {
  return join(runsRoot, "tickets");
}

/**
 * The manifest's filename, restated ONCE and knowingly.
 *
 * `ticket-refs.ts` keeps `MANIFEST_FILE` private and this module is not its
 * owner, so the one thing that cannot be imported is the name of the file whose
 * PRESENCE distinguishes "this ticket attached nothing" from "this ticket's
 * manifest will not parse" — a distinction `readReferenceManifest` deliberately
 * flattens to `null` and this readout must not (see {@link ApiTicketManifestState}).
 *
 * DRIFT IS CAUGHT BY A TEST, NOT BY REVIEW: `supervisor-route.test.ts` writes
 * corrupt JSON to this exact name and asserts the readout says `unreadable`, so a
 * rename in `ticket-refs.ts` turns that assertion red rather than silently
 * downgrading every corrupt manifest to "none".
 */
const TICKET_MANIFEST_FILE = "references.json";

/**
 * THE TICKET KEY, AND WHAT AN ATTACHMENT MEANS FOR IT.
 *
 * THE DECISION: the key covers the brief AND the bytes the owner attached. So
 *
 *   the same brief with the SAME attachments  -> the SAME ticket, and the second
 *                                               POST is a decidable 409. A form
 *                                               submitted twice, or a POST
 *                                               retried after a dropped
 *                                               connection, is not two nights of
 *                                               spend.
 *   the same brief with a DIFFERENT CV        -> a DIFFERENT ticket. The artefact
 *                                               is built from the CV's contents
 *                                               and graded against criteria
 *                                               written from them, so these are
 *                                               two pieces of work. Answering 409
 *                                               would silently discard the
 *                                               corrected CV — a refusal
 *                                               indistinguishable from the
 *                                               duplicate guard doing its job.
 *
 * NEITHER `captureUrl` NOR `motionUrl` IS IN THE MATERIAL, and that is the one
 * place this deliberately differs from a RUN's ticket id. A page reading is a
 * live network read: folding it in would move the key whenever the page moved, so
 * a double-submitted form would file two tickets instead of one. The key is a
 * function of what the OWNER supplied and of nothing the network returned.
 *
 * THE DERIVATION IS `referenceIdentityMaterial`, WHICH IS WHY NO EXISTING KEY
 * MOVED. That function is documented (and pinned in `ticket-refs.test.ts`) to be
 * byte-identical to the brief for empty lists, so a text-only ticket still hashes
 * to `t-<sha256(ticketText)[0..16]>` — the key every ticket filed before this
 * round already has. A second, hand-rolled concatenation here would have been a
 * second answer to "what is this ticket", which is how a run ends up graded under
 * a suite it never authored.
 */
export function supervisorTicketKey(
  prose: string,
  images: readonly ReferenceImage[],
  documents: readonly ReferenceDocument[],
): string {
  const material = referenceIdentityMaterial(prose, images, documents);
  return `t-${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16)}`;
}

/** A ticket's manifest, and WHY it is not there when it is not there. */
interface TicketManifestReading {
  readonly state: ApiTicketManifestState;
  readonly manifest: ReferenceManifest | null;
}

function readTicketManifest(runsRoot: string, ticketKey: string): TicketManifestReading {
  const dir = referenceDirFor(ticketAttachmentRoot(runsRoot), ticketKey);
  const manifest = readReferenceManifest(dir);
  if (manifest !== null) return { state: "read", manifest };
  // THE FILE'S PRESENCE IS THE WHOLE QUESTION. Absent means this ticket attached
  // nothing; present-and-unparsed means it attached something that will NOT reach
  // a builder, and the owner has to be told which.
  return { state: existsSync(join(dir, TICKET_MANIFEST_FILE)) ? "unreadable" : "none", manifest: null };
}

/** Every sha256 a manifest names, images and documents together. */
function manifestDigests(manifest: ReferenceManifest): readonly string[] {
  return [...manifest.images.map((image) => image.sha256), ...manifestDocuments(manifest).map((doc) => doc.sha256)];
}

/**
 * DID THIS TICKET'S ATTACHMENTS REACH THE RUN IT PRODUCED?
 *
 * DIGESTS, NOT PATHS AND NOT COUNTS. A submission may copy the bytes into the
 * run's own directory or record the ticket directory's absolute paths in place;
 * both are legitimate and the digests are identical either way, so this probe
 * does not constrain that choice. Counts would pass for a run that carried a
 * DIFFERENT file.
 *
 * `null` IS NOT `false`. Nothing to carry, no run yet, or a manifest that could
 * not be read are all "no verdict"; `false` is reserved for the one measured
 * fact — a run exists and its manifest does not name what the ticket filed.
 * Measured today: `createSupervisorSubmit` calls `ticketWithReferences` with
 * `images: []`, so every attachment-bearing supervisor ticket reads `false`.
 */
function attachmentsCarriedIntoRun(runsRoot: string, manifest: ReferenceManifest | null, runId: string | null): boolean | null {
  if (manifest === null) return null;
  const digests = manifestDigests(manifest);
  if (digests.length === 0) return null;
  if (runId === null) return null;
  const runManifest = readReferenceManifest(referenceDirFor(runsRoot, runId));
  if (runManifest === null) return false;
  const inRun = new Set(manifestDigests(runManifest));
  return digests.every((digest) => inRun.has(digest));
}

/** One ticket's attachment block, for both the 201 and the readout. */
function ticketAttachments(runsRoot: string, ticketKey: string, runId: string | null): ApiTicketAttachments {
  const reading = readTicketManifest(runsRoot, ticketKey);
  const manifest = reading.manifest;
  return {
    manifest: reading.state,
    images: manifest?.images.length ?? 0,
    documents: manifestDocuments(manifest).length,
    capture: manifest !== null && manifest.capture !== null,
    motion: manifestMotion(manifest) !== null,
    carriedIntoRun: attachmentsCarriedIntoRun(runsRoot, manifest, runId),
  };
}

/**
 * `GET /api/supervisor/tickets` — THE MORNING READOUT.
 *
 * WHY IT HAD TO EXIST. `GET /api/supervisor` answers about the ACTIVE ticket, so
 * a ticket that terminated at `blocked` overnight was readable only in
 * `supervisor_tickets.next_action` and in this process's stdout: the owner's
 * eight-hour readout required a SQL client. This route is the list — every
 * ticket, its state, its attempt count, its sentence, and the run it names.
 *
 * ONE SOURCE, NO SECOND COPY. Everything comes from `listSupervisorTickets()`,
 * which is the same read `SupervisorLoop.snapshot()` and the strip use, so a
 * readout that says `blocked` and a loop that thinks otherwise cannot disagree.
 *
 * THE PROBE IS NOT DECORATION. An empty list is what a broken queue readout looks
 * like, so the response states how many rows it saw, how many manifests it could
 * not read, and how many tickets had their attachments dropped.
 */
function supervisorTicketsSnapshot(deps: ResolvedHttpDeps): ApiSupervisorTicketsResponse {
  const runsRoot = deps.paths.runs;
  const tickets = deps.store.listSupervisorTickets().map((ticket): ApiSupervisorTicketRow => {
    // THE CURRENT RUN IF THERE IS ONE, ELSE THE LAST. The reader's question is
    // "which run do I open", and a blocked ticket's answer is its last one.
    const runId = ticket.currentRunId ?? ticket.lastRunId;
    return {
      ticketKey: ticket.ticketKey,
      title: titleFromBrief(ticket.ticketText),
      state: ticket.state,
      modelId: ticket.modelId,
      attemptNo: ticket.attemptNo,
      maxAttempts: ticket.maxAttempts,
      nextAction: nonBlank(ticket.nextAction, SUPERVISOR_NO_NEXT_ACTION),
      nextActionAt: ticket.nextActionAt,
      runId,
      currentRunId: ticket.currentRunId,
      lastClass: ticket.lastClass,
      lastDefectId: ticket.lastDefectId,
      patchId: ticket.patchId,
      enqueuedAt: ticket.enqueuedAt,
      updatedAt: ticket.updatedAt,
      attachments: ticketAttachments(runsRoot, ticket.ticketKey, runId),
    };
  });
  return {
    tickets,
    probe: {
      ticketsSeen: tickets.length,
      manifestsUnreadable: tickets.filter((row) => row.attachments.manifest === "unreadable").length,
      attachmentsDropped: tickets.filter((row) => row.attachments.carriedIntoRun === false).length,
      armed: deps.supervisorArm.armed,
      armNote: deps.supervisorArm.armNote,
      at: new Date().toISOString(),
    },
  };
}

/**
 * `captureUrl` and `motionUrl`, validated ONCE for both intake routes.
 *
 * EXTRACTED RATHER THAN COPIED. These two sentences are the API's statement of
 * what the fields mean — one scans the brief, the other never does — and a second
 * copy on the ticket route is how the ticket form and the chat box end up
 * describing the same field differently. `null` means "this body is fine".
 */
function refuseCaptureFields(
  body: Record<string, unknown>,
): { readonly code: string; readonly message: string; readonly remediation: string } | null {
  const captureUrl = body["captureUrl"];
  if (captureUrl !== undefined && captureUrl !== null && typeof captureUrl !== "string") {
    return {
      code: "invalid_body",
      message: "captureUrl must be a string, null or absent",
      remediation: "null suppresses the capture; absent means the first URL in the ticket text is captured.",
    };
  }
  const motionUrl = body["motionUrl"];
  if (motionUrl !== undefined && motionUrl !== null && typeof motionUrl !== "string") {
    return {
      code: "invalid_body",
      message: "motionUrl must be a string, null or absent",
      // A DIFFERENT SENTENCE FROM `captureUrl`'S, because the two fields behave
      // differently and one wording for both would document a scan that this
      // field deliberately does not have.
      remediation:
        "It names a page whose ANIMATION you want read. Absent or null means none — the ticket text is " +
        "never scanned for one, unlike captureUrl.",
    };
  }
  return null;
}

/**
 * The brief, read against what this request actually carries — for both intake
 * routes, from one place, on the same inputs.
 *
 * ONE VALIDATOR FOR BOTH ROUTES, the rule `refuseCaptureFields` above states:
 * `POST /api/runs` and the supervisor queue take the same brief and the same
 * attachments, and a second copy of "what counts as a dangling promise" is how
 * the unattended queue ends up spending the night on a brief the attended route
 * would have refused at the button. See `brief-shape.ts` for run `dfd5a050`,
 * which is why this exists at all.
 *
 * WHERE THE FOUR SLOTS COME FROM, AND WHICH WAY THIS ERRS.
 *
 * `images` and `documents` are exact: both intakes have decoded by the time this
 * runs, so the count is the number of attachments this request really carries.
 *
 * `motion` and `capture` are NOT counts and cannot be, because the readings have
 * not happened yet — both routes capture AFTER this point (deliberately: a
 * refusal here must cost neither a browser launch nor a byte). What is knowable
 * now is whether the request named a page at all, and that is what is passed:
 *
 *   `kind === "none"`  the request named no page, by field or by URL in the
 *                      prose, so no reading can ever exist. PROVABLY EMPTY, and
 *                      the only case the blocking rule may fire on. It is run
 *                      `dfd5a050`'s case exactly.
 *   anything else      a reading was asked for and will be ATTEMPTED. It may
 *                      fail — `refused`, a slow page, a browser that will not
 *                      launch — and the house rule for every one of those is
 *                      already "a failed capture must not fail the request"
 *                      (see `runCapture`'s callers). Treated as FILLED.
 *
 * SO THE ERROR THIS MAKES IS ALWAYS THE SILENT ONE. A brief promising a motion
 * reading whose capture then fails is not refused here; the failure is reported
 * on the run's own stream by `captureNotes`, as it already was. The opposite
 * error — refusing a brief whose reading would have arrived — would be a 400 in
 * the owner's face for a promise the request was keeping, and no amount of
 * remediation prose makes that acceptable on a blocking rule.
 *
 * ONE CONSEQUENCE WORTH NAMING: `requestedCaptureTarget` scans the PROSE for a
 * URL, so a brief that merely cites a link reads as `capture: true` here and its
 * capture-slot claims can never fire. That is the same conservative direction,
 * reached by a different road.
 */
function briefShapeFindings(
  body: Record<string, unknown>,
  ticketText: string,
  images: number,
  documents: number,
): readonly BriefShapeFinding[] {
  return briefShape(ticketText, {
    images,
    documents,
    motion: requestedMotionTarget(body).kind !== "none",
    capture: requestedCaptureTarget(body, ticketText).kind !== "none",
  });
}

/**
 * `POST /api/supervisor/tickets` — the only way a ticket ever enters the queue.
 *
 * THE KEY IS MINTED HERE, FROM THE BRIEF, AND THE CALLER MAY NOT SUPPLY ONE.
 * `store.enqueueSupervisorTicket` is deliberately `INSERT OR IGNORE`-free ("a
 * duplicate key is a caller bug worth a throw"), which is right for a library and
 * fatal for a route: a double-submitted form would throw out of the router as a
 * 500. Minting from the brief digest makes the duplicate case DECIDABLE — the
 * same brief is the same ticket, and the second POST is a 409 that says so — and
 * removes an entire class of caller error. It also means a retried POST after a
 * dropped connection cannot file the work twice.
 *
 * THE MODEL ID IS CHECKED AGAINST THE CATALOG, AND ONLY WHEN THE CATALOG CAN
 * ACTUALLY ANSWER (added 2026-08-10 — this docblock used to say it was not checked
 * at all, and gave the right reason for the wrong rule).
 *
 * WHAT WAS MEASURED. `{"modelId":"no-such-model"}` answered 201 and queued the
 * ticket; the typo became a failure two ticks later, in the SUBMIT step —
 * `supervisor_log`: "the submission threw…: no-such-model is not in the catalog, so
 * this ticket cannot be submitted" — which spends an attempt and leaves a `blocked`
 * ticket. Nothing spins and nothing is orphaned, so this was never fatal; it is
 * simply a brief that never runs, discovered in the morning. The docs the owner is
 * told to read promise `400 invalid_model` among the legible refusals, and now it
 * exists.
 *
 * AND WHY THE OLD RULE'S REASONING IS KEPT RATHER THAN OVERRULED. A ticket filed at
 * 2am against a provider whose auth has lapsed must still be FILED: auth can come
 * back before the loop claims it, and the queue must not depend on a network read.
 * Those are two different facts and {@link ModelCatalog} separates them —
 * `entries()` keeps an unavailable row WITH its reason. So:
 *
 *   the id is in the catalog                  -> FILE, whatever `available` says
 *   the id is absent and the catalog enumerated -> 400 `invalid_model`; a typo can
 *                                                  never run, at any hour
 *   the id is absent and the catalog       -> FILE, because a failed probe cannot
 *     could not ENUMERATE                     tell a typo from an outage, and losing
 *                                             the brief is the worse of the two
 *
 * The third branch is not hypothetical: `ModelCatalog.entries()` collapses to a
 * single fallback row when `fetchAnthropicModels` throws OR when the Claude CLI is
 * not logged in, so a rule that refused on absence alone would reject every real
 * model id the moment the probe failed. That is the failure the previous rule was
 * written to avoid, and it is still avoided — `catalog.enumerated()` is the field
 * that separates the two, and it is asked rather than inferred: inferring it from the
 * row ids read a HEALTHY catalog as degraded on this machine, because the real CLI
 * lists a model whose id is `default`.
 */
async function fileSupervisorTicket(
  deps: ResolvedHttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Filing is owner authority: a preview on another loopback port must not be
  // able to enqueue work that spends the owner's quota.
  if (!originIsDashboardOwner(request.headers.origin)) {
    sendError(
      response,
      403,
      "cross_origin_write",
      "a supervisor ticket may only be filed from the dashboard's own page",
      "Use the dashboard at http://127.0.0.1:4319.",
    );
    return;
  }
  if (!requestIsJson(request)) {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "POST a JSON body with Content-Type: application/json",
      "The supervisor ticket route accepts JSON from the dashboard only.",
    );
    return;
  }

  let parsed: unknown;
  try {
    /*
     * THE ATTACHMENT ENVELOPE, AND IT IS HALF THE FIX.
     *
     * MEASURED AT HEAD: this route read the body under the 1 MiB default, so the
     * owner's real ticket — an 80 KB CV plus a 560 KB reference image, ~860 KB as
     * base64 — sat just under the cliff, and one 1 MB image answered `400
     * invalid_body: request body too large (over 1048576 bytes)` with a
     * remediation naming only `ticketText` and `modelId`. Adding the decoders
     * without this line would have advertised per-image limits no request could
     * reach — the exact defect `MAX_ATTACHMENT_BODY_BYTES` was declared to end.
     */
    parsed = JSON.parse(await readBody(request, MAX_ATTACHMENT_BODY_BYTES));
  } catch (error) {
    // THE ENVELOPE REFUSAL IS ITS OWN CODE, the same one `POST /api/runs`
    // answers, so a client can tell "your JSON is malformed" from "your
    // attachments are 130 MB" without parsing prose.
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
    sendError(response, 400, "invalid_body", describeError(error), "POST a JSON object with ticketText and modelId.");
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendError(response, 400, "invalid_body", "the body must be a JSON object", null);
    return;
  }
  const body = parsed as Record<string, unknown>;
  const ticketText = body["ticketText"];
  const modelId = body["modelId"];

  // `briefHasContent`, NOT `.trim()`: a brief of zero-width or format characters
  // trims to a non-empty string while rendering as an empty field, and this queue
  // is the one that spends money unattended. Same function `POST /api/runs` uses.
  if (typeof ticketText !== "string" || !briefHasContent(ticketText)) {
    sendError(
      response,
      400,
      "invalid_ticket",
      "ticketText must be a non-empty string — a brief of only invisible characters is empty",
      null,
    );
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
  if (typeof modelId !== "string" || modelId.trim() === "") {
    sendError(response, 400, "invalid_model", "modelId must be a non-empty string", "GET /api/models lists them.");
    return;
  }
  /*
   * THE TYPO GUARD. See this function's docblock for why absence alone is not
   * enough: the fallback row means the catalog could not enumerate, and refusing
   * then would lose a good brief to a network failure.
   */
  if ((await deps.catalog.resolve(modelId)) === null) {
    /*
     * `catalog.enumerated()`, NOT AN INSPECTION OF THE ROWS. The first version of
     * this guard inferred "the catalog answered" from the ABSENCE of the fallback
     * row's id, and the live CLI falsified it the same hour: this machine's
     * `/api/models` lists `default` ALONGSIDE `opus[1m]`, `sonnet` and `haiku`,
     * because the CLI enumerates a model of its own with that id. The catalog knows
     * whether it enumerated; nothing else can work it out.
     */
    if (await deps.catalog.enumerated()) {
      sendError(
        response,
        400,
        "invalid_model",
        `${modelId} is not in the catalog, so this ticket could never be submitted`,
        "GET /api/models lists every id that can actually run. Nothing was queued.",
      );
      return;
    }
  }
  const maxAttempts = body["maxAttempts"];
  if (maxAttempts !== undefined && (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) {
    sendError(
      response,
      400,
      "invalid_body",
      "maxAttempts must be an integer between 1 and 10 when present",
      "It is the ceiling on how many runs this one brief may cost. Absent means 3.",
    );
    return;
  }

  /*
   * THE ATTACHMENTS, VALIDATED BEFORE ANYTHING IS WRITTEN AND BEFORE THE KEY IS
   * MINTED. Both functions are the ones `POST /api/runs` uses, so the caps, the
   * accepted media types and the refusal codes are stated once for both routes.
   * A request refused on its third document leaves no directory, no row and no
   * key.
   */
  const captureRefusal = refuseCaptureFields(body);
  if (captureRefusal !== null) {
    sendError(response, 400, captureRefusal.code, captureRefusal.message, captureRefusal.remediation);
    return;
  }
  const intake = readReferenceImages(body["references"]);
  if (!intake.ok) {
    sendError(response, intake.status, intake.code, intake.message, intake.remediation);
    return;
  }
  const documentIntake = readReferenceDocuments(body["documents"]);
  if (!documentIntake.ok) {
    sendError(response, documentIntake.status, documentIntake.code, documentIntake.message, documentIntake.remediation);
    return;
  }

  /*
   * THE BRIEF, READ AGAINST WHAT THIS TICKET WILL ACTUALLY CARRY — and this is
   * the route where it matters most, because nobody is watching. A dangling
   * promise filed here is claimed by the loop on the next tick and spends a
   * whole spec phase overnight before the contradiction is visible anywhere.
   *
   * BEFORE THE KEY, BEFORE THE DIRECTORY, BEFORE THE CAPTURE. The refusal must
   * cost nothing, and everything below this line costs something: bytes under
   * the ticket's key, a browser launch, a row the loop can claim.
   */
  const shape = briefShapeFindings(body, ticketText, intake.images.length, documentIntake.documents.length);
  const dangling = shape.find((finding) => finding.blocking);
  if (dangling !== undefined) {
    // `dangling.code` RATHER THAN THE LITERAL, so this stays true if a second
    // blocking rule is ever added. Today there is exactly one and it is
    // `dangling_attachment`.
    sendError(response, 400, dangling.code, dangling.detail, dangling.remediation);
    return;
  }
  const briefWarnings = shape.filter((finding) => !finding.blocking);

  /*
   * THE DIGESTS COME BEFORE THE DIRECTORY, WHICH LOOKS BACKWARDS AND IS NOT.
   *
   * The key is a function of the bytes, and the directory those bytes live in is
   * named by the key — so the digest has to be taken first and the entries below
   * carry a FILENAME in `path` until there is a directory to join it to.
   * `referenceIdentityMaterial` reads only `sha256`, so the placeholder never
   * reaches the identity; the loops after the 409 rewrite `path` to the absolute
   * one that goes in the manifest.
   */
  const pendingImages: readonly ReferenceImage[] = intake.images.map((decoded, index) => ({
    path: `reference-${String(index + 1)}.${decoded.ext}`,
    sha256: digestBytes(decoded.bytes),
    bytes: decoded.bytes.byteLength,
  }));
  const pendingDocuments: readonly ReferenceDocument[] = documentIntake.documents.map((decoded, index) => ({
    path: `document-${String(index + 1)}.${decoded.extension}`,
    sha256: digestBytes(decoded.bytes),
    bytes: decoded.bytes.byteLength,
    mediaType: decoded.mediaType,
  }));

  const ticketKey = supervisorTicketKey(ticketText, pendingImages, pendingDocuments);
  /*
   * THE DUPLICATE CHECK RUNS BEFORE ANY WRITE AND BEFORE ANY CAPTURE, so a
   * double-submitted form costs neither bytes on disk nor a browser launch. It is
   * not a lock: two concurrent POSTs of the same brief AND the same bytes both
   * pass here and both write byte-identical files under the same key, and the
   * loser of the INSERT gets the 409 from the catch below. Benign, and cheaper
   * than serialising a route the owner uses once an hour.
   */
  if (deps.store.getSupervisorTicket(ticketKey) !== null) {
    sendError(
      response,
      409,
      "ticket_already_queued",
      `this exact brief${pendingImages.length + pendingDocuments.length > 0 ? " with these exact attachments" : ""} is already filed as ${ticketKey}`,
      "Change the brief, or attach a different file, or read the existing ticket on GET /api/supervisor/tickets. " +
        "A retried POST is not a second ticket.",
    );
    return;
  }

  /*
   * THE BYTES, UNDER THE TICKET'S OWN KEY. See {@link ticketAttachmentRoot} for
   * why they are not under a run id: there is no run, and there may be several
   * before this ticket is done.
   */
  const attachmentRoot = ticketAttachmentRoot(deps.paths.runs);
  const referenceDir = referenceDirFor(attachmentRoot, ticketKey);
  const documentDir = documentDirFor(attachmentRoot, ticketKey);
  const images: ReferenceImage[] = [];
  if (pendingImages.length > 0) mkdirSync(referenceDir, { recursive: true });
  for (const [index, decoded] of intake.images.entries()) {
    const pending = pendingImages[index];
    if (pending === undefined) continue;
    const path = join(referenceDir, pending.path);
    writeFileSync(path, decoded.bytes);
    images.push({ ...pending, path });
  }
  const documents: ReferenceDocument[] = [];
  if (pendingDocuments.length > 0) mkdirSync(documentDir, { recursive: true });
  for (const [index, decoded] of documentIntake.documents.entries()) {
    const pending = pendingDocuments[index];
    if (pending === undefined) continue;
    const path = join(documentDir, pending.path);
    writeFileSync(path, decoded.bytes);
    documents.push({ ...pending, path });
  }

  /*
   * THE PAGE READINGS HAPPEN HERE, ONCE, AND THAT IS THE WHOLE REASON THEY ARE ON
   * THIS ROUTE AND NOT ON THE SUBMISSION.
   *
   * `supervisor-boot.ts` states the constraint it could not solve on its own: a
   * capture is a live network read, so capturing at SUBMIT time would fold a
   * different outline into the brief on every attempt, mint a different ticket
   * id, find no frozen acceptance suite and pay for a whole second spec phase —
   * with no throw and no compile error. Its docblock's own remedy is "a
   * supervisor ticket that needs a captured page must carry the outline in its
   * text", and that is exactly what is stored below: the reading is composed into
   * `ticket_text` ONCE, at filing time, so every attempt submits the same bytes.
   *
   * THE COST IS A SLOW POST, and it is the same cost `POST /api/runs` pays —
   * `CAPTURE_BUDGET_MS` for the markup read plus `MOTION_BUDGET_MS` and
   * `MOTION_PHASE_MS` again if a motion reference is named. Sequenced, never
   * parallel, so a failure names itself.
   */
  const capture = await runCapture(deps, requestedCaptureTarget(body, ticketText), referenceDir);
  const motion = await runMotionCapture(deps, requestedMotionTarget(body));

  /*
   * THE STORED TEXT IS THE COMPOSED BRIEF, NOT THE OWNER'S PROSE.
   *
   * `composeBrief` returns the prose UNCHANGED when there is neither reading, so
   * a ticket that named no page stores exactly what it always stored. When there
   * IS a reading, the composed brief is what `createSupervisorSubmit` re-composes
   * with a null capture — a no-op by that same property — so the run's ticket id
   * is a function of these bytes and is identical on attempt 3 and attempt 1.
   * `supervisor-route.test.ts` asserts that idempotence directly, because if it
   * ever stops holding every retry silently re-authors the acceptance suite.
   */
  const composed = ticketWithReferences({
    prose: ticketText,
    images,
    documents,
    capture: capture.capture,
    motion: motion.spec,
  });
  if (images.length > 0 || documents.length > 0 || capture.capture !== null || motion.spec !== null) {
    // `mkdirSync` HERE TOO: a ticket whose only attachment is a document creates
    // `documents/` and never `references/`, and `writeReferenceManifest`
    // deliberately does not create its own directory.
    mkdirSync(referenceDir, { recursive: true });
    writeReferenceManifest(referenceDir, { images, capture: capture.capture, documents, motion: motion.spec });
  }

  /*
   * THE ROW IS WRITTEN LAST, AFTER THE BYTES ARE DURABLE.
   *
   * The loop can claim a `queued` ticket on its next tick, and a ticket claimed
   * while its CV was still being written would be submitted without it. Nothing
   * before this point is visible to the loop, so a failure anywhere above leaves
   * an unreferenced directory rather than a half-filed ticket.
   */
  let filed;
  try {
    filed = deps.store.enqueueSupervisorTicket({
      ticketKey,
      ticketText: composed.brief,
      modelId,
      designLock: "auto",
      ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
      // NEVER BLANK BY CONTRACT — the store throws on an empty one — and it says
      // what the owner still has to do, because a filed ticket on a STOPPED
      // supervisor is work that will never start until someone presses start.
      nextAction:
        deps.store.readSupervisorState().desired === "running"
          ? "waiting for the supervisor to claim it, which is the next tick"
          : "nothing until the supervisor is running — POST /api/supervisor/start",
    });
  } catch (error) {
    /*
     * THE INSERT THREW, WHICH FOR THIS TABLE MEANS THE KEY IS TAKEN.
     * `enqueueSupervisorTicket` is deliberately `INSERT OR IGNORE`-free, so the
     * concurrent-POST window between the check above and this line surfaces here.
     * A 409 says the same true thing the pre-check says; letting it out as a 500
     * would tell the owner the queue is broken when his form was double-clicked.
     */
    if (deps.store.getSupervisorTicket(ticketKey) !== null) {
      sendError(
        response,
        409,
        "ticket_already_queued",
        `this exact brief is already filed as ${ticketKey}`,
        "Two POSTs of the same brief raced. Nothing was queued twice.",
      );
      return;
    }
    throw error;
  }
  deps.store.logSupervisorDecision({
    ticketKey: filed.ticketKey,
    runId: null,
    decision: "claimed",
    reason: `the owner filed this ticket from the dashboard: ${composed.title}`,
  });
  const body2: ApiSupervisorTicketFiled = {
    ticketKey: filed.ticketKey,
    title: composed.title,
    state: filed.state,
    maxAttempts: filed.maxAttempts,
    nextAction: filed.nextAction,
    queuedTickets: deps.store.listSupervisorTickets(["queued"]).length,
    desired: deps.store.readSupervisorState().desired,
    // OMITTED ENTIRELY WHEN THERE ARE NONE, not sent as `[]`: the field means
    // "here is something to read", and an empty array on every clean filing
    // trains the reader to stop looking. `exactOptionalPropertyTypes` makes the
    // spread the only way to express that.
    ...(briefWarnings.length > 0 ? { briefWarnings } : {}),
    /*
     * READ BACK OFF THE DISK, NEVER ECHOED FROM THE REQUEST. `ticketAttachments`
     * re-reads the manifest that was just written, so a filing whose bytes did
     * not land answers `manifest: "unreadable"` or a count of zero instead of
     * repeating the request's own numbers back at the owner. The run id is `null`
     * because no run exists a millisecond after filing.
     */
    attachments: ticketAttachments(deps.paths.runs, ticketKey, null),
  };
  sendJson(response, 201, body2);
}

async function supervisorCommand(
  deps: ResolvedHttpDeps,
  action: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isSupervisorAction(action)) {
    sendError(response, 404, "not_found", `no route for POST /api/supervisor/${action}`, null);
    return;
  }
  /* These commands are owner authority: accepting any loopback port would let
   * an artefact preview start or stop the unattended supervisor. */
  if (!originIsDashboardOwner(request.headers.origin)) {
    sendError(
      response,
      403,
      "cross_origin_write",
      "the supervisor may only be started or stopped from the dashboard's own page",
      "Use the dashboard at http://127.0.0.1:4319.",
    );
    return;
  }

  let body: Record<string, unknown> = {};
  const text = await readBody(request).catch((error: unknown) => {
    sendError(response, 400, "invalid_body", describeError(error), "POST a small JSON object, or no body at all.");
    return null;
  });
  if (text === null) return;
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
    body = parsed as Record<string, unknown>;
  }

  /* THE CONFIRM IS CHECKED BEFORE THE WIRING, so that a client discovering this
   * route learns it is destructive whether or not a loop happens to be running.
   * It is only on abort-now: START and STOP are both non-destructive, and a
   * confirm on STOP would train the owner to click through the one that
   * matters. */
  if (action === "abort-now" && body["confirm"] !== true) {
    sendError(
      response,
      400,
      "confirm_required",
      "aborting now cancels the in-flight run, and a cancelled run is TERMINAL: resume() refuses it, the " +
        "classifier calls it intentional at bound 0, and nothing will auto-continue it. The workspace and the " +
        "session are lost.",
      'POST {"confirm":true} if that is what you want. To stop WITHOUT losing the run, POST /api/supervisor/stop, ' +
        "which drains: it stops claiming new tickets and lets the current run finish.",
    );
    return;
  }

  /* A SWITCH WITH NOTHING BEHIND IT REFUSES RATHER THAN WRITING A ROW.
   * `setSupervisorState` would happily persist `desired='running'` here, and the
   * next GET would report a confident RUNNING that nothing on this machine can
   * act on — a start button that reports success and starts nothing is this
   * repository's signature defect with a label on it. The GET still answers 200
   * and says `probe.wired:false`, which is the honest version of the same fact. */
  if (deps.supervisor === undefined) {
    sendError(
      response,
      503,
      "supervisor_not_wired",
      "no supervisor loop is wired into this server, so nothing would act on a change to the desired state",
      "This build has the control surface but not the loop. GET /api/supervisor reports the same thing with " +
        "probe.wired:false and refuses to guess.",
    );
    return;
  }

  const reason =
    typeof body["reason"] === "string" && body["reason"].trim().length > 0
      ? body["reason"]
      : `the owner posted /api/supervisor/${action}`;
  const before = deps.store.readSupervisorState();
  const inFlight =
    deps.store
      .listSupervisorTickets()
      .find((candidate) => SUPERVISOR_ACTIVE_STATES.includes(candidate.state))?.currentRunId ?? null;

  if (action === "abort-now") {
    /* THE DESTRUCTIVE PATH STOPS HERE, DELIBERATELY UNFINISHED RATHER THAN HALF
     * DONE. Cancelling the run without moving its ticket to `blocked` would
     * leave the next START re-spending on the run the owner just killed, and the
     * ticket writer is the supervisor's, not this router's. A 501 naming the
     * missing half is honest; a partial abort is not. */
    sendError(
      response,
      501,
      "abort_not_wired",
      "the supervisor cannot yet park an aborted ticket as `blocked`, and cancelling the run without that " +
        "would make the next START re-spend on the run you just killed",
      "POST /api/supervisor/stop to drain, or cancel the run directly with POST /api/runs/:id/cancel and " +
        "accept that its ticket stays claimed.",
    );
    return;
  }

  const desired: ApiSupervisorDesired = action === "start" ? "running" : "draining";
  const changed = before.desired !== desired;
  if (changed) deps.store.setSupervisorState(desired, "owner", reason);
  /* THE NUDGE IS AFTER THE WRITE AND ONLY ON START. The loop reads the row it
   * decides from, so ticking before the write would decide on the old state;
   * and ticking on STOP would be asking a loop that has just been told to stop
   * claiming to go and have a look. */
  if (action === "start") deps.supervisor.tick();

  const state = supervisorSnapshot(deps);
  const answer: ApiSupervisorCommandResponse = {
    ...state,
    changed,
    note: changed
      ? action === "start"
        ? `the supervisor is running; ${String(state.queueDepth)} ticket(s) queued`
        : inFlight === null
          ? "draining with nothing in flight; the next tick settles to stopped"
          : `draining: ${inFlight} runs to its own verdict and no new ticket will be claimed`
      : `the supervisor was already ${before.desired}; nothing changed`,
  };
  sendJson(response, 200, answer);
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
    // ONCE PER SERVER, AT BOOT, WHILE THE ANSWER IS KNOWN. Never per request:
    // an arm check that runs when the thing it checks is already suspect is a
    // post-mortem, not an arm check.
    // `deps.paths` SO ARM FOUR CAN LOOK. Without it the boot line says it could
    // not read a ticket manifest, which is the honest version of "0 unreadable".
    supervisorArm: armSupervisorRoute(deps.store, deps.supervisor, undefined, deps.paths),
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
      /* Starting or stopping a process is owner authority. The exact UI origin
       * prevents another loopback app or artefact preview from exercising it. */
      if (method === "POST" && !originIsDashboardOwner(request.headers.origin)) {
        sendError(
          response,
          403,
          "cross_origin_write",
          "a project may only be started or stopped from the dashboard's own page",
          "Use the dashboard at http://127.0.0.1:4319.",
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

  /* GET  /api/supervisor
   * POST /api/supervisor/start  |  /api/supervisor/stop  |  /api/supervisor/abort-now
   *
   * ── WHAT STOP MEANS, AND WHY IT MAY NOT ABORT ──────────────────────────────
   *
   * STOP DRAINS. It sets `desired='draining'`: the loop stops CLAIMING new
   * tickets, the run already in flight keeps going to its own verdict, and the
   * state becomes `stopped` when nothing is in flight. The reason is in the
   * code, not in taste — aborting converts a RESUMABLE run into an UNRESUMABLE
   * one:
   *
   *   · `cancel()` aborts the active run and `#finish` writes a terminal status;
   *   · `resume()` refuses a terminal row (`orchestrator.ts:1494/1518`, and
   *     `db.ts:496` names `passed|failed|cancelled` terminal);
   *   · the classifier then answers `intentional`, and `boundFor("intentional")`
   *     is 0 (`recovery.ts:144-145`), so nothing will ever auto-continue it.
   *
   * So an abort-flavoured STOP throws away the workspace and the session, which
   * is the precise loss `reconcileOnBoot`'s own docblock exists to end: "that is
   * how 52 minutes and 12 hours of real work came to be waiting on a click."
   * A drain needs no new terminal status, no new abort path and no change to
   * `isTerminal`.
   *
   * ABORT-NOW IS A SEPARATE ROUTE, SEPARATELY NAMED, AND REQUIRES `{"confirm":
   * true}` in the body. It is the destructive one. Its ticket goes to `blocked`
   * rather than `queued` so the next START does not immediately re-spend on the
   * run the owner just killed.
   *
   * ── SCOPE: THIS IS THE SUPERVISOR'S SWITCH, NOT THE ORCHESTRATOR'S ─────────
   *
   * STOP does not touch `pump()`. A run the owner submits from the page still
   * starts while the supervisor is stopped, and `queuedRuns` in the body is the
   * number that shows it. Any UI for this must say so or it lies about its
   * scope.
   *
   * ── NO RUN IS CREATED HERE ────────────────────────────────────────────────
   *
   * START sets the desired state and lets the loop claim; it does not submit.
   * Submission goes through the extracted `submitRun` on the supervisor's side,
   * because bypassing `createRun`'s body mints a DIFFERENT ticket identity — no
   * frozen suite, a second paid spec phase, no throw and no compile error.
   *
   * ── WHY THE GET IS 200 WHEN NOTHING IS WIRED ──────────────────────────────
   *
   * See `HttpDeps.supervisor`. Three states have to be distinguishable by the
   * client: stopped-with-tickets, stopped-with-an-empty-queue, and no supervisor
   * at all. A 503 for the third collapses it into "the dashboard is unreachable".
   * The POSTs answer 503, because a command that cannot be carried out must not
   * answer 200. */
  if (segments[1] === "supervisor") {
    if (segments.length === 2 && method === "GET") {
      sendJson(response, 200, supervisorSnapshot(deps));
      return;
    }
    /*
     * FILING IS NOT A COMMAND, SO IT IS NOT ROUTED THROUGH `supervisorCommand`.
     *
     * BEFORE THIS ROUTE EXISTED THE QUEUE COULD NOT BE NON-EMPTY. Measured
     * 2026-08-10: `enqueueSupervisorTicket` had callers only in two test files —
     * no route, no client function, no control — so START ran a loop over an
     * empty queue for eight hours and answered its own message, "stopped, and
     * nothing is queued — POST /api/supervisor/start after filing a ticket", for
     * a filing endpoint that did not exist.
     *
     * IT IS BRANCHED BEFORE THE COMMAND DISPATCH, AND THE DIFFERENCE IS NOT
     * COSMETIC. `supervisorCommand` answers 503 with no loop wired, correctly: a
     * command that cannot be carried out must not answer 200. A FILING can always
     * be carried out — it is a durable row that outlives this process and is
     * claimed by the next boot's first tick — so refusing it would collapse "no
     * loop is wired" into "there is no queue", which is the conflation the whole
     * status surface exists to prevent.
     */
    if (segments.length === 3 && segments[2] === "tickets" && method === "POST") {
      await fileSupervisorTicket(deps, request, response);
      return;
    }
    /*
     * THE MORNING READOUT, AND IT WAS A MEASURED 404 UNTIL THIS ROUND.
     *
     * `GET /api/supervisor` answers about the ACTIVE ticket only, so a ticket that
     * terminated at `blocked` overnight existed for the owner in
     * `supervisor_tickets.next_action` and in this process's stdout and NOWHERE
     * ELSE — the readout after eight unattended hours required opening runs.db in
     * a SQL client. See `supervisorTicketsSnapshot`.
     */
    if (segments.length === 3 && segments[2] === "tickets" && method === "GET") {
      sendJson(response, 200, supervisorTicketsSnapshot(deps));
      return;
    }
    if (segments.length === 3 && method === "POST") {
      await supervisorCommand(deps, segments[2] ?? "", request, response);
      return;
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
    if (!originIsDashboardOwner(request.headers.origin)) {
      sendError(response, 403, "cross_origin_write", "a run message may only come from the dashboard", null);
      return;
    }
    if (!requestIsJson(request)) {
      sendError(response, 415, "unsupported_media_type", "POST a JSON body with Content-Type: application/json", null);
      return;
    }
    await postMessage(deps, runId, row, request, response);
    return;
  }

  // POST /api/runs/:id/cancel
  if (segments.length === 4 && segments[3] === "cancel" && method === "POST") {
    if (!originIsDashboardOwner(request.headers.origin)) {
      sendError(response, 403, "cross_origin_write", "a run may only be cancelled from the dashboard", null);
      return;
    }
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
    if (!originIsDashboardOwner(request.headers.origin)) {
      sendError(response, 403, "cross_origin_write", "a run may only be resumed from the dashboard", null);
      return;
    }
    let chosenMockup: string | null = null;
    let chosenDirection: string | null = null;
    const text = await readBody(request);
    if (text.trim().length > 0) {
      if (!requestIsJson(request)) {
        sendError(response, 415, "unsupported_media_type", "POST a JSON body with Content-Type: application/json", null);
        return;
      }
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
      // THE DIRECTION CHOICE TRAVELS ON THE SAME ROUTE, added 2026-08-03. A
      // canvass park is ended by naming a DIRECTION (a slug the panel already
      // has) or by clicking one of its cards, which arrives as `chosenMockup`
      // and is translated by `directionForMockup`. A second route would be a
      // second way to end one park.
      const direction = (parsed as Record<string, unknown>)["chosenDirection"];
      if (direction !== undefined && direction !== null && typeof direction !== "string") {
        sendError(response, 400, "invalid_body", "chosenDirection must be a string when present", null);
        return;
      }
      chosenDirection = typeof direction === "string" ? direction : null;
    }
    const resumed: boolean = deps.orchestrator.resume(runId, chosenMockup, chosenDirection);
    if (!resumed) {
      sendError(
        response,
        409,
        "not_resumable",
        `run ${runId} is ${row.status} and cannot be resumed` +
          (chosenMockup === null ? "" : `, or ${chosenMockup} is not one of its mockups`) +
          (chosenDirection === null ? "" : `, or ${chosenDirection} is not one of its directions`),
        "A finished run is not resumed: re-running a scored artefact would overwrite a real result " +
          "with a second one taken under different conditions. Submit a new run instead.",
      );
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // POST /api/runs/:id/creative-decision
  //
  // The owner authority changes only its own durable column. Approval cannot
  // waive either deterministic gate or a critic revision; a subjective waiver
  // requires a bounded reason. A waiver may publish only when both deterministic
  // authorities are green; the subjective exception remains recorded.
  if (segments.length === 4 && segments[3] === "creative-decision" && method === "POST") {
    if (!originIsDashboardOwner(request.headers.origin)) {
      sendError(response, 403, "cross_origin_write", "a creative decision may only come from the dashboard", null);
      return;
    }
    if (!requestIsJson(request)) {
      sendError(response, 415, "unsupported_media_type", "POST a JSON body with Content-Type: application/json", null);
      return;
    }
    const resultsDir = runPathsFor(deps.paths, runId).results;
    const creative = readCreativePilotStatus(resultsDir);
    if (creative === null || !creative.enabled || !creative.applicable) {
      sendError(response, 409, "creative_pilot_not_applicable", "this run has no active creative pilot record", null);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await readBody(request)); }
    catch (error) {
      sendError(response, 400, "invalid_body", describeError(error), "POST a JSON object with decision and optional reason.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(response, 400, "invalid_body", "the body must be a JSON object", null);
      return;
    }
    const body = parsed as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => key !== "decision" && key !== "reason");
    if (unknownKeys.length > 0) {
      sendError(response, 400, "unknown_creative_decision_field", `unknown field: ${unknownKeys[0] ?? "unknown"}`, null);
      return;
    }
    const rawDecision = body["decision"];
    const choices = ["approved", "revision_requested", "waived", "cancelled"] as const;
    if (!choices.some((choice) => choice === rawDecision)) {
      sendError(response, 400, "invalid_creative_decision", "decision must be approved, revision_requested, waived, or cancelled", null);
      return;
    }
    const decision = rawDecision as (typeof choices)[number];
    if (body["reason"] !== undefined && typeof body["reason"] !== "string") {
      sendError(response, 400, "invalid_creative_reason", "reason must be a string when present", null);
      return;
    }
    const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
    if (reason.length > 1_000) {
      sendError(response, 400, "creative_reason_too_long", "reason must be at most 1000 characters", null);
      return;
    }
    if ((decision === "waived" || decision === "revision_requested") && reason.length === 0) {
      sendError(response, 400, "creative_reason_required", `${decision} requires a non-empty owner reason`, null);
      return;
    }
    if (!isTerminal(row.status)) {
      sendError(response, 409, "creative_decision_too_early", `${decision} is available only after the run is terminal and staged`, null);
      return;
    }

    if (creative.ownerDecision !== null) {
      if (creative.ownerDecision !== decision || (creative.ownerDecisionReason ?? "") !== reason) {
        sendError(response, 409, "creative_decision_conflict", "this run already has a different closed owner decision", null);
        return;
      }
      let existingPublish = readPublishedProject(resultsDir);
      if (pilotMayPublish(creative) && existingPublish?.published !== true) {
        republishProject({ run: row, paths: deps.paths });
        existingPublish = readPublishedProject(resultsDir);
      }
      const receipt: ApiCreativeDecisionResponse = {
        runId,
        ownerDecision: decision,
        mayPublish: pilotMayPublish(creative),
        published: existingPublish?.published === true,
        targetRunId: creative.ownerDecisionTargetRunId,
      };
      sendJson(response, 200, receipt);
      return;
    }

    if (decision === "approved" && !(
      creative.heldOutPass === true &&
      creative.compile.outcome === "passed" &&
      creative.criticDisposition === "accept" &&
      creative.reviewState === "creative_ready"
    )) {
      sendError(response, 409, "creative_not_approvable", "approval requires functional and compiler green plus an accepting critic record", null);
      return;
    }
    if (decision === "waived" && !(
      creative.heldOutPass === true &&
      creative.compile.outcome === "passed" &&
      creative.criticDisposition === "revise" &&
      creative.criticFindings.length > 0
    )) {
      sendError(response, 409, "creative_not_waivable", "only a subjective critic revision can be waived; functional/compiler red cannot", null);
      return;
    }

    const claim = claimCreativeDecision(resultsDir, decision, reason.length === 0 ? null : reason);
    if (claim.kind === "conflict") {
      sendError(response, 409, "creative_decision_conflict", "a concurrent owner decision already won this run", null);
      return;
    }
    if (claim.kind === "replay") {
      const settled = readCreativePilotStatus(resultsDir);
      if (settled?.ownerDecision !== null && settled?.ownerDecision !== undefined) {
        const existingPublish = readPublishedProject(resultsDir);
        const receipt: ApiCreativeDecisionResponse = {
          runId,
          ownerDecision: settled.ownerDecision,
          mayPublish: pilotMayPublish(settled),
          published: existingPublish?.published === true,
          targetRunId: settled.ownerDecisionTargetRunId,
        };
        sendJson(response, 200, receipt);
        return;
      }
      // The claim and all finalization below are synchronous within one request.
      // A replay that observes an unsettled claim therefore means the claimant
      // process stopped; resume its deterministic operation immediately.
    }

    let targetRunId: string | null = null;
    if (decision === "revision_requested") {
      const clientMessageId = `creative-decision-${createHash("sha256").update(`${decision}\n${reason}`).digest("hex")}`;
      const begun = deps.store.beginMessageRequest({
        runId,
        clientMessageId,
        payloadSha256: createHash("sha256").update(reason).digest("hex"),
        intent: "steer",
        text: reason,
        images: [],
        documents: [],
      });
      if (begun.kind === "conflict") {
        sendError(response, 409, "creative_revision_conflict", "the durable revision request conflicts with its prior payload", null);
        return;
      }
      const message = begun.receipt.message;
      targetRunId = createTerminalContinuation(deps, row, message, []);
      if (targetRunId === null) {
        sendError(response, 409, "creative_revision_unavailable", "the terminal workspace could not be continued safely", null);
        return;
      }
      deps.store.completeMessageRequest(runId, clientMessageId, "continuation_created", targetRunId);
    }

    const decided = {
      ...creative,
      ownerDecision: decision,
      ownerDecisionReason: reason.length === 0 ? null : reason,
      ownerDecisionTargetRunId: targetRunId,
      updatedAt: new Date().toISOString(),
    };
    writeCreativePilotStatus(resultsDir, decided);
    deps.bus.emit(runId, {
      type: "log",
      level: decision === "approved" ? "info" : "warn",
      text: `owner creative decision recorded: ${decision}${targetRunId === null ? "" : `; continuation ${targetRunId}`}`,
    });

    let published = false;
    if ((decision === "approved" || decision === "waived") && pilotMayPublish(decided)) {
      published = republishProject({ run: row, paths: deps.paths }).published;
    }
    const receipt: ApiCreativeDecisionResponse = {
      runId,
      ownerDecision: decision,
      mayPublish: pilotMayPublish(decided),
      published,
      targetRunId,
    };
    sendJson(response, 200, receipt);
    deps.orchestrator.pump();
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
    if (!originIsDashboardOwner(request.headers.origin)) {
      sendError(
        response,
        403,
        "cross_origin_write",
        "a run may only be published from the dashboard's own page",
        "Use the dashboard at http://127.0.0.1:4319.",
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
 * A TERMINAL RUN IS NEVER REOPENED. Its message is the immutable anchor for a
 * newly queued continuation run with a copied workspace and a newly derived
 * ticket identity. The source verdict, suite and scored artefacts are untouched.
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
  const intent: MessageIntent = record["intent"] === "steer" ? "steer" : "send";
  if (record["intent"] !== undefined && record["intent"] !== "send" && record["intent"] !== "steer") {
    sendError(response, 400, "invalid_intent", 'intent must be "send" or "steer"', null);
    return;
  }
  const clientMessageId = record["clientMessageId"];
  if (
    clientMessageId !== undefined &&
    (typeof clientMessageId !== "string" ||
      clientMessageId.length === 0 ||
      clientMessageId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(clientMessageId))
  ) {
    sendError(
      response,
      400,
      "invalid_client_message_id",
      "clientMessageId must be 1-128 letters, digits, dots, underscores, colons or hyphens",
      null,
    );
    return;
  }
  const requestId = typeof clientMessageId === "string" ? clientMessageId : null;
  const payloadSha256 = createHash("sha256")
    .update(JSON.stringify({ intent, text, images: rawImages, documents: record["documents"] ?? [] }))
    .digest("hex");

  const prior = requestId === null ? null : deps.store.messageRequest(runId, requestId);
  if (prior !== null && prior.payloadSha256 !== payloadSha256) {
    sendMessageRefusal(
      response,
      `clientMessageId ${requestId} was already used for different message bytes`,
    );
    return;
  }
  if (prior?.disposition !== null && prior?.disposition !== undefined) {
    sendMessageReceipt(response, prior, runId, 200);
    return;
  }

  // THE SAME VALIDATION THE TICKET FORM USES, from the same function, because
  // two intakes with independently-editable rules is how one of them quietly
  // stops accepting what the other documents — the reason the image caps were
  // moved into `ticket-refs.ts` in the first place.
  const documentIntake = prior === null ? readReferenceDocuments(record["documents"]) : null;
  if (documentIntake !== null && !documentIntake.ok) {
    sendError(response, documentIntake.status, documentIntake.code, documentIntake.message, documentIntake.remediation);
    return;
  }
  const rawDocuments = documentIntake?.ok === true ? documentIntake.documents : [];

  if (prior === null && text === "" && rawImages.length === 0 && rawDocuments.length === 0) {
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
  if (prior === null && rawImages.length > MAX_REFERENCE_IMAGES) {
    sendError(
      response,
      400,
      "too_many_images",
      `${String(rawImages.length)} images; the limit is ${String(MAX_REFERENCE_IMAGES)}`,
      null,
    );
    return;
  }

  let message = prior?.message ?? null;
  let writtenDocuments = prior?.documents === undefined ? [] : [...prior.documents];
  if (message === null) {
    const decodedImages = rawImages.map((raw) => decodeReferenceDataUrl(raw));
    const invalidImage = decodedImages.findIndex((decoded) => decoded === null);
    if (invalidImage !== -1) {
      sendError(
        response,
        400,
        "invalid_image",
        `image ${String(invalidImage + 1)} is not a base64 data URL of a supported type, or exceeds ${String(MAX_REFERENCE_IMAGE_BYTES)} bytes`,
        "Supported: png, jpeg, webp, gif.",
      );
      return;
    }

    const chatDir = join(deps.paths.runs, runId, "chat");
    mkdirSync(chatDir, { recursive: true });
    const fileStamp =
      requestId === null
        ? String(Date.now())
        : `${createHash("sha256").update(requestId).digest("hex").slice(0, 16)}-${payloadSha256.slice(0, 16)}`;
    const written: string[] = [];
    for (const [index, decoded] of decodedImages.entries()) {
      if (decoded === null) continue;
      const path = join(chatDir, `${fileStamp}-${String(index + 1)}.${decoded.ext}`);
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
    writtenDocuments = [];
    for (const [index, decoded] of rawDocuments.entries()) {
      const path = join(chatDir, `${fileStamp}-doc-${String(index + 1)}.${decoded.extension}`);
      writeFileSync(path, decoded.bytes);
      writtenDocuments.push(path);
    }

    if (requestId === null) {
      message = deps.store.appendMessage(runId, { role: "owner", text, images: written });
    } else {
      const begun = deps.store.beginMessageRequest({
        runId,
        clientMessageId: requestId,
        payloadSha256,
        intent,
        text,
        images: written,
        documents: writtenDocuments,
      });
      if (begun.kind === "conflict") {
        sendMessageRefusal(response, `clientMessageId ${requestId} was already used for different message bytes`);
        return;
      }
      if (begun.receipt.disposition !== null) {
        sendMessageReceipt(response, begun.receipt, runId, 200);
        return;
      }
      message = begun.receipt.message;
      writtenDocuments = [...begun.receipt.documents];
    }
  }

  const current = deps.store.getRun(runId) ?? row;
  if (isTerminal(current.status)) {
    let targetRunId: string | null;
    try {
      targetRunId = createTerminalContinuation(deps, current, message, writtenDocuments);
    } catch (error) {
      sendMessageRefusal(response, `continuation creation failed: ${describeError(error)}`);
      return;
    }
    if (targetRunId === null) {
      sendMessageRefusal(response, `run ${runId} ended without a workspace that could be continued safely`);
      return;
    }
    const completed =
      requestId === null
        ? null
        : deps.store.completeMessageRequest(runId, requestId, "continuation_created", targetRunId);
    const body: SendMessageResponse = {
      disposition: "continuation_created",
      message: completed?.message ?? message,
      documents: completed?.documents ?? writtenDocuments,
      targetRunId,
      sourceRunId: runId,
      sourceMessageSeq: message.seq,
    };
    sendJson(response, 202, body);
    deps.orchestrator.pump();
    return;
  }

  /*
   * TRY THE LIVE SESSION FIRST — the switch away from boundary-only delivery.
   *
   * The SDK takes `prompt: string | AsyncIterable<SDKUserMessage>`, and a segment that
   * is running right now has an open channel (`LiveInput`) whose iterator is parked
   * waiting for exactly this. `shouldQuery: false` has the CLI fold the text into the
   * agent's next turn rather than interrupt a tool call — the behaviour of typing into
   * the interactive CLI while it works.
   *
   * NOT STAMPED ON INSERTION. `pushLiveMessage` returns false for a parked,
   * queued or between-segments run; the row then stays pending and the boundary
   * drain carries it. For a live push, the orchestrator callback stamps only
   * when the SDK iterator consumes the item. A process dying with it still
   * queued therefore leaves the row available to the next boundary.
   */
  const live = deps.orchestrator.pushLiveMessage(runId, {
    text: message.text,
    images: message.images,
    seq: message.seq,
    delivery: intent === "steer" ? "next" : "merge",
  });

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
  const planned =
    live || intent === "steer" ? false : (deps.orchestrator.deliverPlanReply?.(runId) ?? false);

  /*
   * THE THIRD RUNG, AND THE LAST. A run parked on a DESIGN CANVASS reads a
   * message that names a section and a direction as a request to render it —
   * "show me the contact section in 2" — and answers with the still, in the same
   * panel, before he commits to anything.
   *
   * THE THREE ARE DISJOINT BY CONSTRUCTION, not by luck: `pushLiveMessage`
   * refuses a parked run, `PlanDriver` refuses a FOLDED `plan.json` (which is
   * exactly what a run parked for a design has), and the design driver requires a
   * canvass with no choice yet.
   *
   * NOT STAMPED HERE, for `deliverPlanReply`'s reason: the render is
   * asynchronous, and the driver stamps only after `design-lock.json` is written.
   *
   * THE DIRECTION IS WHAT MAKES A MESSAGE A REQUEST, AND A SECTION ALONE IS NOT
   * ENOUGH. A message that does not name one of the directions on offer — in
   * this park's own words, not in any sentence with a digit in it — is DECLINED
   * and stays pending, because it is a mid-run instruction ("make the hero
   * taller" names a section and asks for a change) and the boundary drain carries
   * it to the build. `matchDirectionReference` in design-dialogue.ts is the whole
   * of that judgement and states the tie-break it turns on.
   */
  const designed =
    live || planned || intent === "steer"
      ? false
      : (deps.orchestrator.deliverDesignRequest?.(runId) ?? false);
  const disposition = live
    ? "delivered_live"
    : planned
      ? "plan_reply"
      : designed
        ? "design_request"
        : "queued_boundary";
  const completed =
    requestId === null || live
      ? null
      : deps.store.completeMessageRequest(runId, requestId, disposition, runId);

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
        ? "owner message accepted by the running session input; durable delivery records when the SDK consumes it"
        : planned
          ? "owner message taken up by the plan dialogue, before any criteria are written"
          : designed
            ? "owner message taken up at the design park as a request to render a section in one of the " +
              "directions on offer"
            : "owner message queued for the next segment boundary") +
      (message.images.length > 0 ? ` with ${String(message.images.length)} image(s)` : "") +
      `: ${message.text.slice(0, 200)}`,
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

  // `live` lets the UI say that the open SDK channel accepted the message. Its
  // durable receipt remains open until LiveInput hands the item to the SDK; the
  // consumption callback then stamps the message and closes the receipt in one
  // transaction. A crash before that point therefore recovers as pending.
  //
  // `documents` IS ON THE RESPONSE AND NOT ON `message`. The stored row has no
  // such column, and inventing one on the way out would show the owner a message
  // that the next `GET /api/runs/:id/messages` does not agree with.
  const body: SendMessageResponse = {
    disposition,
    message: completed?.message ?? message,
    documents: completed?.documents ?? writtenDocuments,
    targetRunId: runId,
  };
  sendJson(response, 202, body);
}

function sendMessageRefusal(response: ServerResponse, reason: string): void {
  const body: SendMessageResponse = { disposition: "refused", reason, targetRunId: null };
  sendJson(response, 409, body);
}

function sendMessageReceipt(
  response: ServerResponse,
  receipt: MessageRequestReceipt,
  sourceRunId: string,
  status: number,
): void {
  if (receipt.disposition === null || receipt.targetRunId === null) {
    sendMessageRefusal(response, "the previous request was recorded but has no delivery disposition yet");
    return;
  }
  const body: SendMessageResponse =
    receipt.disposition === "continuation_created"
      ? {
          disposition: "continuation_created",
          message: receipt.message,
          documents: receipt.documents,
          targetRunId: receipt.targetRunId,
          sourceRunId,
          sourceMessageSeq: receipt.message.seq,
        }
      : {
          disposition: receipt.disposition,
          message: receipt.message,
          documents: receipt.documents,
          targetRunId: receipt.targetRunId,
        };
  sendJson(response, status, body);
}

function createTerminalContinuation(
  deps: HttpDeps,
  source: RunRow,
  message: MessageRequestReceipt["message"],
  documents: readonly string[],
): string | null {
  const linked = deps.store.continuationFor(source.runId, message.seq);
  if (linked !== null) return linked.targetRunId;

  const targetRunId = continuationRunId(source.runId, message.seq);
  if (deps.store.getRun(targetRunId) !== null) return null;
  const sourcePaths = runPathsFor(deps.paths, source.runId);
  const targetPaths = runPathsFor(deps.paths, targetRunId);
  let durableTarget = false;
  try {
    if (!stageContinuationWorkspace(sourcePaths, targetPaths)) return null;

    const sourceManifest = readReferenceManifest(referenceDirFor(deps.paths.runs, source.runId));
    const manifest = copyContinuationReferences(
      sourceManifest,
      message.images,
      documents.map((path) => ({ path, mediaType: continuationDocumentMediaType(path) })),
      referenceDirFor(deps.paths.runs, targetRunId),
      documentDirFor(deps.paths.runs, targetRunId),
    );
    if (manifest !== null) {
      writeReferenceManifest(referenceDirFor(deps.paths.runs, targetRunId), manifest);
    }
    const targetFollowupDocuments =
      documents.length === 0 ? [] : manifestDocuments(manifest).slice(-documents.length).map((entry) => entry.path);
    const brief = continuationBrief(source.ticketText, source.runId, message.seq, message.text);
    const ticket = ticketFromStoredReferences(brief, manifest);
    const created = deps.store.createContinuationRun(source.runId, message.seq, {
      runId: targetRunId,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketText: ticket.brief,
      ticketSha256: ticket.sha256,
      modelId: source.modelId,
      provider: source.provider,
      deploy: source.deploy,
      startedAt: new Date().toISOString(),
      queuePosition: deps.store.listQueued().length + 1,
      designLock: source.designLock === "auto" || source.designLock === "ask" ? source.designLock : null,
      interactive: true,
    });
    durableTarget = true;
    if (created.created) {
      deps.bus.emit(targetRunId, { type: "status", status: "queued" });
      deps.bus.emit(targetRunId, { type: "phase", phase: "plan" });
      deps.bus.emit(targetRunId, {
        type: "log",
        level: "info",
        text: `linked continuation of terminal run ${source.runId}, anchored to owner message ${String(message.seq)}`,
      });
      if (targetFollowupDocuments.length > 0) {
        deps.bus.emit(targetRunId, {
          type: "log",
          level: "warn",
          text:
            `${String(targetFollowupDocuments.length)} follow-up document(s) are recorded on this continuation ticket, but ` +
            "the current chat delivery path does not place document bytes in an agent turn. Their target-owned paths are: " +
            targetFollowupDocuments.join(", "),
        });
      }
      writeContinuationRecord(targetPaths, {
        sourceRunId: source.runId,
        sourceMessageSeq: message.seq,
        targetRunId,
        createdAt: created.continuation.createdAt,
      });
    }
    return created.continuation.targetRunId;
  } catch (error) {
    if (!durableTarget && deps.store.getRun(targetRunId) === null) {
      rmSync(targetPaths.root, { recursive: true, force: true });
    }
    throw error;
  }
}

function continuationDocumentMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".csv": return "text/csv";
    case ".json": return "application/json";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".doc": return "application/msword";
    case ".rtf": return "application/rtf";
    default: return "application/octet-stream";
  }
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

/**
 * Decide which page, if any, this request wants the MOTION of.
 *
 * TWO INPUTS, NOT THREE, AND THE MISSING ONE IS THE POINT. There is no scan of
 * the ticket text here. A URL in the prose means "copy this site", which is why
 * {@link requestedCaptureTarget} looks for one; wanting a page's MOVEMENT is
 * never implied by mentioning it, and inferring it would spend most of a minute
 * on the submit button for every ticket that cites a documentation page, and
 * would tie the ticket id to how that page happens to animate today. So absent,
 * `null` and an empty string all mean the same thing: no motion reference.
 *
 * THE REFUSAL LIST IS `captureTargetFor`'S, reached through the same function
 * the outline capture uses rather than copied. localhost, private and link-local
 * ranges are refused identically for both, and a second list here would drift
 * from the first — this route's own API lives on exactly such an address.
 */
function requestedMotionTarget(body: Record<string, unknown>): ReturnType<typeof captureTargetFor> {
  const explicit = body["motionUrl"];
  if (typeof explicit !== "string" || explicit.trim().length === 0) return { kind: "none" };
  return captureTargetFor(explicit.trim());
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

  // `briefHasContent`, NOT `.trim()`: a brief of zero-width or format characters
  // trims to a non-empty string while rendering as an empty field, and this
  // route is the one that spends money. See the function's own docblock for the
  // measurement.
  if (typeof ticketText !== "string" || !briefHasContent(ticketText)) {
    sendError(
      response,
      400,
      "invalid_ticket",
      "ticketText must be a non-empty string — a brief of only invisible characters is empty",
      null,
    );
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
  // ONE VALIDATOR FOR BOTH INTAKE ROUTES — see `refuseCaptureFields`. These two
  // sentences ARE the API's statement of what the fields mean, and a second copy
  // on the ticket route is how the two forms end up describing one field twice.
  const captureRefusal = refuseCaptureFields(body);
  if (captureRefusal !== null) {
    sendError(response, 400, captureRefusal.code, captureRefusal.message, captureRefusal.remediation);
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

  /*
   * THE BRIEF, READ AGAINST WHAT THIS REQUEST ACTUALLY CARRIES.
   *
   * HERE BECAUSE THIS IS THE FIRST LINE THAT HAS BOTH HALVES. The claim lives in
   * `ticketText` and the manifest is `intake` plus `documentIntake`, and the
   * decoders above are what make the second half knowable — so the check cannot
   * be higher. It also must not be lower: the comment on the intakes above states
   * the invariant this refusal honours — the run id is minted BELOW this point,
   * so a ticket refused here costs no directory, no row, no capture and no spec
   * phase. That is the entire point of the rule; a shape check that fired after
   * the run existed would be paying for the thing it is supposed to prevent.
   *
   * IT THEREFORE RUNS BEFORE THE MODEL IS RESOLVED, and a request that is wrong
   * in both ways hears about the brief first. That is the right order: the model
   * id is a typo the caller fixes in a second, and the brief is the thing that
   * would have cost hours.
   */
  const shape = briefShapeFindings(body, ticketText, intake.images.length, documentIntake.documents.length);
  const dangling = shape.find((finding) => finding.blocking);
  if (dangling !== undefined) {
    // `dangling.code` RATHER THAN THE LITERAL, so this stays true if a second
    // blocking rule is ever added. Today there is exactly one and it is
    // `dangling_attachment`.
    sendError(response, 400, dangling.code, dangling.detail, dangling.remediation);
    return;
  }
  const briefWarnings = shape.filter((finding) => !finding.blocking);

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
   * REUSE ANOTHER RUN'S DESIGN — THE LAST REFUSAL BEFORE ANYTHING IS MINTED.
   *
   * WHY IT IS THE LAST ONE. Every check above reads the request; this one opens
   * four files in another run's directory, so a submission that is also missing a
   * `modelId` hears about the typo it can fix in a second before it hears about a
   * run directory it may have to go and look for. It still sits ABOVE the mint,
   * which is the invariant the intake comments above state and the one that
   * matters: a refused submission costs no run id, no directory, no row, no
   * capture and no spec phase.
   *
   * WHY IT IS ON DISK RATHER THAN ON THE SOURCE RUN'S STATUS. A run row says
   * `completed` when the gate finished, which says nothing about its DESIGN lane:
   * a `degraded` run completes with no stills at all, and a `full` run whose image
   * chain died completes with a manifest listing refs nobody wrote
   * (`classifyDesignLane`'s `manifest-invalid` arm is that exact shape). The
   * question here is "is there a complete design set on disk", and only disk
   * answers it.
   *
   * A PARTIAL COPY IS WORSE THAN NO COPY, which is what these four codes are for:
   * half a direction puts the build agent in front of `Read` targets that resolve
   * to nothing and the visual gate in front of a missing reference, and both
   * surface as somebody else's fault several turns deep.
   */
  const reuseDesignFrom = body["reuseDesignFrom"];
  let reuseSourceRunId: string | null = null;
  if (reuseDesignFrom !== undefined && reuseDesignFrom !== null) {
    if (typeof reuseDesignFrom !== "string" || reuseDesignFrom.trim().length === 0) {
      sendError(
        response,
        400,
        "invalid_body",
        "reuseDesignFrom must be a non-empty run id string, null or absent",
        "Absent means this run generates its own design, which is what every run did before " +
          "2026-08-12.",
      );
      return;
    }
    const sourceRunId = reuseDesignFrom.trim();
    const check = validateDesignReuseSource(sourceRunId, runPathsFor(deps.paths, sourceRunId));
    if (!check.ok) {
      sendError(response, 400, check.code, check.message, check.remediation);
      return;
    }
    reuseSourceRunId = sourceRunId;
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
  /*
   * THE REUSE INTENT, INTO THE RUN'S OWN DIRECTORY, BESIDE ITS REFERENCES.
   *
   * A FILE RATHER THAN A COLUMN, and the reasoning is on
   * {@link DESIGN_REUSE_MARKER_FILE}: no migration, and the fact is about bytes on
   * disk, which is exactly what the two directories written below this line are.
   *
   * THE COPY ITSELF DOES NOT HAPPEN HERE. The workspace does not exist yet —
   * `#prepareWorkspace` creates and git-initialises it at the top of the build
   * phase — and the copied manifest's paths have to be rewritten to a workspace
   * that exists. Copying at intake would also charge every submission for a
   * directory the run may never reach: a queued run can be cancelled, and a run
   * that is refused a model never builds.
   */
  if (reuseSourceRunId !== null) {
    writeDesignReuseMarker(runPathsFor(deps.paths, runId).root, {
      sourceRunId: reuseSourceRunId,
      requestedAt: new Date().toISOString(),
    });
  }
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
   *
   * AND A SUBMISSION THAT ALSO NAMES A MOTION REFERENCE PAYS AGAIN, SEPARATELY.
   * The motion reading is a SECOND browser launch with its own budget
   * (`MOTION_BUDGET_MS` for its bounded calls, plus `MOTION_PHASE_MS` of
   * deliberate waiting that no timeout covers because a healthy capture spends
   * it on purpose). The two run one after the other, so a ticket carrying both a
   * captured page and a motion reference is the sum of both figures. Nothing
   * here is parallel: they are sequenced so that a failure of one names itself
   * in the log rather than being lost in a `Promise.all` rejection.
   */
  const target = requestedCaptureTarget(body, ticketText);
  const capture = await runCapture(deps, target, referenceDir);
  /*
   * BEFORE `ticketWithReferences`, AND THAT ORDER IS THE WHOLE REQUIREMENT.
   *
   * The reading's prose is composed into the brief and its address is folded
   * into the identity material, so it decides the ticket id — which is written
   * to the row below and is the name of the frozen acceptance suite. Reading it
   * afterwards would mean the row's `ticketId` and the ticket the run is graded
   * under were different strings, silently, on the owner's quota.
   */
  const motion = await runMotionCapture(deps, requestedMotionTarget(body));

  const ticket = ticketWithReferences({
    prose: ticketText,
    images,
    documents,
    capture: capture.capture,
    motion: motion.spec,
  });
  if (images.length > 0 || documents.length > 0 || capture.capture !== null || motion.spec !== null) {
    // `mkdirSync` HERE TOO, and not only in the loops above: a ticket whose only
    // attachment is a document creates `documents/` and never `references/`, and
    // `writeReferenceManifest` deliberately does not create its own directory
    // (`ticket-refs.test.ts` pins that). Without this line such a ticket throws
    // ENOENT out of a route that had already decoded and written its bytes.
    mkdirSync(referenceDir, { recursive: true });
    // THE MOTION SPEC IS PERSISTED HERE OR THE RUN AUTHORS A SECOND SUITE.
    // `ticketFromStoredReferences` rebuilds the ticket at build time from
    // `row.ticketText` plus this file; the address folded into the id above
    // lives nowhere else. A manifest written without it derives a different id,
    // finds no frozen suite, and pays to author another one — with no throw and
    // no compile error. `api-references.test.ts` asserts the two ids agree.
    writeReferenceManifest(referenceDir, { images, capture: capture.capture, documents, motion: motion.spec });
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
  for (const line of captureNotes(capture, images.length, documents, motion)) {
    deps.bus.emit(runId, { type: "log", level: line.level, text: line.text });
  }

  // THE REUSE, ON THE RUN'S OWN STREAM, FROM THE MOMENT IT WAS ASKED FOR. The
  // orchestrator says it again when the files actually land — this line is the
  // record that the REQUEST carried it, which is the half a reader of the trace
  // cannot otherwise recover if the run is cancelled before it builds.
  if (reuseSourceRunId !== null) {
    deps.bus.emit(runId, {
      type: "log",
      level: "info",
      text:
        `this run will REUSE run ${reuseSourceRunId}'s design instead of generating one: its ` +
        `design-refs/ are copied into this run's workspace before the build, and no image is ` +
        `generated. Its verdict is a build against that run's design, not evidence about a design lane.`,
    });
  }

  deps.orchestrator.pump();

  // THE WARNINGS RIDE THE 201, AND ONLY WHEN THERE ARE SOME. They are readings
  // of English rather than facts about this request (see `brief-shape.ts`), so
  // they may not refuse the run — but the owner is standing at the submit button
  // with the brief still editable, which is the only moment they are cheap to
  // act on. The field is OMITTED when empty rather than sent as `[]`:
  // `exactOptionalPropertyTypes` makes the spread the way to say that, and a
  // client that sees the key at all knows there is something to read.
  const body2: CreateRunResponse = { runId, ...(briefWarnings.length > 0 ? { briefWarnings } : {}) };
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

/** A motion reading as `createRun` needs it: the spec, plus why there is none. */
interface MotionAttempt {
  /**
   * The quantized reading, or `null`.
   *
   * `null` MEANS NO READING WAS TAKEN — no reference named, a refused address, a
   * browser that would not start. It is NOT "the page does not move": that is a
   * spec whose `entries` is empty, and the two are kept apart all the way to the
   * ticket id (see `referenceIdentityMaterial`) because conflating them is how a
   * probe ends up unable to report zero.
   */
  readonly spec: MotionSpec | null;
  /** null when nothing was attempted; a sentence when something went wrong. */
  readonly failure: string | null;
  /** The address that was tried, for the log line. */
  readonly url: string | null;
}

/**
 * Read the reference's motion, or explain in one sentence why there is none.
 *
 * NEVER THROWS AND NEVER REFUSES THE RUN — the same contract as {@link runCapture}
 * and for the same reason. `captureMotion` already promises not to throw; the
 * try/catch is for the injected seam, and for the case where the module itself
 * fails to load, because a ticket must not be rejected over an optional reading.
 *
 * IT NORMALISES HERE RATHER THAN IN THE DRIVER. `captureMotion` returns a RAW
 * reading carrying `firstChangeMs` — an absolute start time measured to differ
 * by 400 ms between two readings of the same page — and `normaliseMotion` is
 * what drops it. Anything that persisted or hashed the raw reading would put
 * that number in the ticket id, so the quantization happens before this function
 * returns and the raw form never leaves it.
 */
async function runMotionCapture(
  deps: HttpDeps,
  target: ReturnType<typeof captureTargetFor>,
): Promise<MotionAttempt> {
  if (target.kind === "none") return { spec: null, failure: null, url: null };
  if (target.kind === "refused") {
    // The reason is a clause, so it reads as one sentence in `captureNotes`
    // ("… was NOT read: it names this machine.").
    return { spec: null, failure: target.reason, url: target.url };
  }
  try {
    const result = await (deps.captureMotion ?? captureMotion)({ url: target.url });
    if (!result.ok) return { spec: null, failure: result.reason, url: target.url };
    return { spec: normaliseMotion(result.reading), failure: null, url: target.url };
  } catch (error) {
    return { spec: null, failure: describeError(error), url: target.url };
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
  motion: MotionAttempt,
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
  /*
   * THE MOTION NOTE, IN THREE STATES RATHER THAN TWO.
   *
   * A reading with entries, a reading with NONE, and no reading at all are three
   * different facts about this submission and each gets its own sentence. The
   * middle one is the state a two-state note would lose: "the page was opened
   * and nothing moved inside the sampling window" is a real answer about the
   * reference, and printing it as a failure would tell the owner his link was
   * broken when it was not.
   *
   * IT SAYS WHAT NOTHING DOES, WHICH IS THE HALF THAT COSTS MOST TO OMIT. The
   * reading reaches the brief the acceptance suite is authored from and reaches
   * the build and design prompts — that much is genuinely wired, in this commit.
   * No gate compares what gets built to it: there is no motion check in the
   * sealed scorer, which runs `--network none` and never loads that page. A note
   * that let the owner believe otherwise would describe a mechanism that does
   * not exist, which is the same failure the documents note is a `warn` about.
   */
  if (motion.spec !== null && motion.spec.entries.length > 0) {
    notes.push({
      level: "info",
      text:
        `read how ${motion.spec.url} MOVES and found ${String(motion.spec.entries.length)} thing(s) in ` +
        "motion. That reading is part of the ticket text the acceptance suite is authored from, and it " +
        "reaches the builder and the design lane. Durations are rounded, because two readings of the " +
        "same page never agree exactly. NOTHING IN THIS RUN COMPARES what gets built to that page: " +
        "there is no motion gate, and the sealed scorer has no network.",
    });
  } else if (motion.spec !== null) {
    notes.push({
      level: "warn",
      text:
        `${motion.spec.url} was read, and NOTHING WAS OBSERVED TO MOVE in the sampling window. That is ` +
        "not the same as the page being static — the reading watches transform and opacity for a bounded " +
        "time and reports what changed inside it. No motion block was added to your ticket text, so the " +
        "acceptance suite will say nothing about movement.",
    });
  } else if (motion.failure !== null) {
    notes.push({
      level: "warn",
      text:
        `${motion.url ?? "the page you named as a motion reference"} was NOT read: ${motion.failure}. ` +
        "The acceptance suite for this run will be written with no knowledge of how that page moves.",
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

/** Owner-authority writes are browser actions and require the exact UI origin. */
function originIsDashboardOwner(origin: string | undefined): boolean {
  if (origin === undefined || origin.length === 0) return false;
  try {
    return DASHBOARD_OWNER_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function requestIsJson(request: IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
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
  const creative = readCreativePilotStatus(runPathsFor(deps.paths, row.runId).results);
  if (creative?.enabled === true && creative.applicable && !pilotMayPublish(creative)) {
    sendError(
      response,
      409,
      "creative_owner_approval_required",
      "WEB pilot publication requires functional/compiler green and either critic acceptance plus approval or a reasoned owner waiver of subjective findings",
      "Record an approved or waived creative decision first.",
    );
    return;
  }
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

/**
 * Re-point every ROOT-ABSOLUTE reference in a served document at the preview
 * mount, because the owner's builds write their sites for an origin root and
 * this route serves them four segments deep.
 *
 * THE ARTEFACT THAT FORCED THIS, quoted from disk rather than imagined:
 *
 *   runs/run-2026-07-30T20-16-40-242Z-052c6e02/workspace/index.html
 *     <link rel="stylesheet" href="/styles.css">
 *     <script src="/main.js"></script>
 *     <video poster="/assets/world/leg-1-poster.webp">
 *   …/workspace/server.mjs:6-8
 *     "The artefact directory itself is the document root … Serving anything
 *      deeper would 404 the root document."
 *
 * Served at `/api/runs/<id>/preview/`, that document asked the ORIGIN root for
 * its stylesheet and its script. Both 404'd, and — this is the part that made it
 * survive — a 404 stylesheet is not an error a browser shows anyone. The page
 * painted in Times New Roman with browser-default blue links, which is
 * indistinguishable from a build that produced nothing. Measured with a negative
 * control: the OTHER finished run links its stylesheet relatively and renders
 * fully styled through the same route in the same second, so the preview server
 * was never the broken part.
 *
 * WHY NOT `<base href>`, WHICH IS THE OBVIOUS FIX AND IS NOT A FIX AT ALL. It
 * cannot work here for a reason that has nothing to do with this route's CSP:
 * a root-absolute URL is resolved against the base URL's ORIGIN, not its path,
 * so `/styles.css` under `<base href="/api/runs/<id>/preview/">` still resolves
 * to `http://127.0.0.1:4176/styles.css`. `<base>` moves RELATIVE references, and
 * the relative ones already work. (The CSP would have blocked it as well —
 * `base-uri 'none'` at `PREVIEW_CSP` — so it would have shipped green twice
 * over.)
 *
 * WHY NOT AN ORIGIN-ROOT SERVER, which is the architecturally right answer. It
 * needs a second loopback port per run, the client's URL builder to point at it
 * (`src/lib/spec-pipeline.ts`, another module's file), and `frame-ancestors
 * 'self'` to become an explicit origin so the dashboard can still frame it. That
 * is a day's work overlapping the project runner's published-folder server, and
 * it is the correct thing to do if previews ever leave this machine.
 *
 * WHAT THIS DOES NOT COVER, said plainly because the alternative is a reader
 * assuming it is complete:
 *
 *   - URLS BUILT AT RUN TIME BY JAVASCRIPT. Nothing here can see them, and
 *     rewriting string literals inside a script is a transform that would
 *     eventually corrupt one. STRUCTURAL, NOT OBSERVED: the one candidate on
 *     this machine is `052c6e02`'s `main.js:56`, `fetch("/assets/world/leg-1.mp4")`
 *     — and `connect-src 'none'` in `PREVIEW_CSP` already stops that fetch
 *     whatever its path, while the artefact's own `.catch` leaves the poster in
 *     place. Measured through the client origin with a full scroll of the page:
 *     zero non-200 responses and zero failed requests.
 *   - UNQUOTED ATTRIBUTES (`src=/main.js`). Legal HTML, not emitted by any
 *     generator seen here, and the pattern below requires the quotes.
 *   - ANY FILE THAT IS NOT `text/html` OR `text/css`. An SVG with a
 *     root-absolute `xlink:href`, or a JSON manifest of asset paths, goes out
 *     byte-for-byte.
 *   - A DOCUMENT THAT IS NOT UTF-8. The two rewritten types are read and
 *     re-emitted as UTF-8, which is what their `Content-Type` has always
 *     claimed; a latin-1 HTML file that previously went out byte-for-byte and
 *     rendered by luck now goes out transcoded. Nothing built here has produced
 *     one.
 */
function rewriteRootAbsolute(source: string, mount: string, kind: "html" | "css"): string {
  // `url(/…)` covers the inline `<style>` block, the `style="…"` attribute and
  // every rule of a served stylesheet, which is where a generated site puts its
  // background images.
  const withUrls = source.replace(
    /url\(\s*(['"]?)(\/(?!\/)[^)'"]*)\1\s*\)/gi,
    (_match, quote: string, path: string) => `url(${quote}${mount}${path}${quote})`,
  );
  if (kind === "css") return withUrls;

  // A FUNCTION REPLACER THROUGHOUT, not a `$1` string: a run id is part of
  // `mount`, and `$&`/`$1` inside a replacement string are substitution
  // patterns rather than text.
  const withAttributes = withUrls.replace(
    /\b(href|src|poster|action|formaction)=(["'])(\/(?!\/)[^"']*)\2/gi,
    (_match, attribute: string, quote: string, path: string) =>
      `${attribute}=${quote}${mount}${path}${quote}`,
  );

  // `srcset` IS A LIST, and a naive URL rewrite over it eats the descriptors.
  // Each candidate is `url [descriptor]`, comma-separated.
  return withAttributes.replace(
    /\b(srcset|imagesrcset)=(["'])([^"']*)\2/gi,
    (_match, attribute: string, quote: string, value: string) => {
      const rewritten = value
        .split(",")
        .map((candidate) => {
          const trimmed = candidate.trim();
          if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return candidate;
          return candidate.replace(trimmed, `${mount}${trimmed}`);
        })
        .join(",");
      return `${attribute}=${quote}${rewritten}${quote}`;
    },
  );
}

/**
 * The size above which a document is streamed unrewritten.
 *
 * The rewrite has to buffer, and a preview is served from a workspace a run may
 * still be writing. Four megabytes is far beyond any entry document or
 * stylesheet a build here has produced (the largest measured: 31 KB of HTML,
 * 43 KB of CSS) and far below anything that would matter to this process's
 * memory. A file past the cap goes out byte-for-byte, which is the behaviour
 * this route had before the rewrite existed.
 */
const PREVIEW_REWRITE_MAX_BYTES = 4 * 1024 * 1024;

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

  /*
   * THE MOUNT, TAKEN FROM THE CLIENT'S OWN SPELLING RATHER THAN REBUILT.
   *
   * `/api/runs/<id>/preview` — the first five segments of the request path,
   * still percent-encoded exactly as they arrived. Rebuilding it from `runId`
   * would re-encode the id a second way and hand the browser an address that
   * does not match the one it is already on, which is a cache miss at best and a
   * second redirect at worst. `rewriteRootAbsolute` prefixes it onto every
   * root-absolute reference in the document.
   */
  const mount = url.pathname.split("/").slice(0, 5).join("/");

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
    sendPreviewFile(index.target, indexPath, mount, response);
    return;
  }

  sendPreviewFile(resolved.target, resolved.path, mount, response);
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
 * explanation. Nothing is buffered in this process either way —
 * EXCEPT the two text types the mount rewrite has to read whole; see
 * `rewriteRootAbsolute` and `PREVIEW_REWRITE_MAX_BYTES`.
 *
 * THE STREAM'S `error` IS HANDLED. Headers are already sent by then, so there is
 * no status left to change and the only honest move is to break the connection —
 * but an unhandled `error` on a stream takes the whole server down, and a file
 * disappearing mid-read is a thing a live workspace genuinely does.
 */
function sendPreviewFile(
  target: string,
  relPath: string,
  mount: string,
  response: ServerResponse,
): void {
  const contentType = previewContentType(relPath);
  response.writeHead(200, {
    "Content-Type": contentType,
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

  /*
   * THE ONLY TRANSFORM POINT ON THIS PIPE, and it is here rather than in
   * `servePreview` because both call sites — the resolved file and a
   * directory's `index.html` — have to get it.
   *
   * `statSync` rather than reading first and measuring: the point of the cap is
   * not to hold the file. A file that vanishes between the stat and the read
   * throws, and the `catch` falls through to the stream, which has its own
   * `error` handler for exactly that race.
   */
  const kind = contentType.startsWith("text/html")
    ? "html"
    : contentType.startsWith("text/css")
      ? "css"
      : null;
  if (kind !== null) {
    try {
      if (statSync(target).size <= PREVIEW_REWRITE_MAX_BYTES) {
        response.end(rewriteRootAbsolute(readFileSync(target, "utf8"), mount, kind));
        return;
      }
    } catch {
      // Fall through to the stream, whose `error` handler is the one place this
      // race is already handled.
    }
  }

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
