/**
 * db.ts — SQLite persistence (node:sqlite, built into Node).
 *
 * THREE RULES, ENFORCED HERE RATHER THAN AT EVERY CALL SITE.
 *
 * 1. EVERY PERSISTED STRING GOES THROUGH `redactForPersistence`. There is one
 *    write path per table and it redacts on the way in. A caller cannot forget,
 *    because a caller never writes a string directly.
 *
 * 2. THERE IS NO COST COLUMN. Not `cost_usd`, not `estimated_cost_usd`, not a
 *    nullable one. A column that exists gets filled; a column that does not
 *    exist cannot leak a fabricated dollar figure into the UI. Subscription
 *    runs consume quota and are not billed per token — see api-types.ts.
 *    THIS APPLIES TO `seat_spend` AND `metered_spend` TOO, and it is the reason
 *    the metered table counts CALLS and DELIVERED SECONDS: those are quantities
 *    this program actually knows, and no price table exists to turn them into a
 *    bill.
 *
 * 3. A RUN SURVIVES A SERVER RESTART. Everything needed to resume — phase,
 *    builder session id, suite digest, workspace path — is a column, not
 *    in-memory state. `reconcileOnBoot` handles the runs that were mid-flight
 *    when the process died.
 *
 * node:sqlite is SYNCHRONOUS. Transactions are kept to single statements or
 * short bounded loops so the event loop is never held for long; the SSE stream
 * and the HTTP server share this thread.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import { SPEND_SEATS } from "./api-types.js";
import { stripAnnotationMarkup } from "./message-markup.js";
import type {
  ApiCriterion,
  ApiCriterionResult,
  ApiCriterionTier,
  ApiMeteredSpend,
  MessageDisposition,
  MessageIntent,
  ApiPhase,
  ApiProvider,
  ApiRunSpend,
  ApiRunStatus,
  ApiScreenshot,
  ApiSeatSpend,
  ApiSpendSeat,
  ApiTokens,
  SseEvent,
} from "./api-types.js";
/**
 * RUNTIME, NOT TYPE-ONLY, AND THAT IS THE POINT OF ROUTING THROUGH IT.
 *
 * `runSpend` derives the per-vendor totals with `addTokens`, which REFUSES to sum
 * two vendors. A store that assembled the record itself would be a second adder
 * with no such refusal — and the cross-vendor number it produced would be
 * indistinguishable from a real one.
 */
import { runSpend, toSeatSpend } from "./tokens.js";
import type { SeatContribution } from "./tokens.js";
/**
 * TYPE-ONLY, AND IT NARROWS THE WRITE AND NOTHING ELSE.
 *
 * `RunPatch.gateStopReason` takes the loop's own enum so a caller cannot persist
 * `"greenn"`, while {@link RunRow.gateStopReason} reads back a plain `string`:
 * a row written by a different version of this server must READ, not throw. A
 * `oneOf` guard on the way out would take down `GET /api/runs` — every row, for
 * every run — over one unrecognised word in one column, which is a far worse
 * failure than rendering a reason the UI has no prose for.
 *
 * `verbatimModuleSyntax` erases this, so it is not a runtime dependency of the
 * store on the loop and cannot become a module cycle.
 */
import type { StopReason } from "./gate-fix-loop.js";

/* -------------------------------------------------------------------------
 * Row shapes
 * ---------------------------------------------------------------------- */

/** One run, as persisted. Superset of `RunDetail`; includes resume state. */
export interface RunRow {
  readonly runId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly ticketText: string;
  readonly ticketSha256: string;
  readonly modelId: string;
  readonly provider: ApiProvider;
  readonly deploy: boolean;
  readonly status: ApiRunStatus;
  readonly phase: ApiPhase;
  /** 0 while running; 1-based position while queued; null once terminal. */
  readonly queuePosition: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly heldOutPass: boolean | null;
  readonly falseFinish: boolean | null;
  readonly agentDeclaredDone: boolean;
  readonly tokens: ApiTokens | null;
  readonly rateLimited: boolean;
  /**
   * When a call was actually REFUSED — the durable half of the rate-limit park.
   *
   * NOT THE SAME THING AS {@link RunRow.rateLimited}. That boolean is also
   * written from routine `limited: false` telemetry (`#noteRateLimit`), so it
   * says what the last SDK event reported; this column is written only by
   * `#rateLimited`, alongside `status = 'rate_limited'`, so it says when the
   * provider actually said no.
   *
   * It exists so an opt-in auto-resume survives a restart: the remaining wait is
   * `rateLimitRetryAfterSec` measured from HERE, never from boot time, which is
   * what stops a dashboard that restarts every few minutes from renewing the
   * window each time. NULL on every row written before this column existed, and
   * `planRateLimitResume` refuses to arm on a null rather than assuming `now`.
   */
  readonly rateLimitedAt: string | null;
  readonly rateLimitRetryAfterSec: number | null;
  /** e.g. "five_hour" / "seven_day". Recorded verbatim from the provider. */
  readonly rateLimitKind: string | null;
  readonly artifactPath: string | null;
  readonly previewUrl: string | null;
  readonly suiteSha256: string | null;
  /** SDK session/thread id, so a rate-limited or interrupted run can resume. */
  readonly builderSessionId: string | null;
  readonly resumeCount: number;
  /** Redacted, with remediation where one exists. Null on a clean run. */
  readonly failureReason: string | null;
  /** Criteria the owner did not state. See `RunDetail.inferredCriteria`. */
  readonly inferredCriteria: number;
  /** Path to `verdict.md`, or "" while the run has not reached a terminal state. */
  readonly verdictPath: string;
  /**
   * The DESIGN segment returned of its own accord (Phase 2b).
   *
   * WHY THE SESSION ID CANNOT ANSWER THIS. The build phase is two
   * `builder.build()` calls against one session, and `builderSessionId !== null`
   * is true in four situations that need three different prompts — a fresh run, a
   * design segment interrupted by a rate limit, a design segment finished and
   * waiting on the lock, and a build segment interrupted. `nextBuildSegment`
   * needs this column to tell the second from the third, and without it a
   * resumed run takes the "the dashboard was interrupted" prompt, which names no
   * locked mockup and loses the design with nothing reporting it.
   */
  readonly designSegmentDone: boolean;
  /**
   * The lock policy the run was CREATED with: `"auto"`, `"ask"`, or `""` for
   * "the request said nothing". Empty is not `"auto"`: `designLockPolicy` reads
   * it together with {@link RunRow.interactive} to apply §17.3 rule 2.
   */
  readonly designLock: string;
  /** The request that created this run came from a human at the dashboard. */
  readonly interactive: boolean;
  /**
   * Gate runs the GATE/FIX loop performed (Phase 2d). See
   * `RunDetail.gateAttempts`: 0 is "no outcome recorded", never "passed first
   * time", and it moves with {@link RunRow.gateStopReason}.
   */
  readonly gateAttempts: number;
  /**
   * Why the loop stopped — a `StopReason` on the way in, a plain string on the
   * way out. `null` is "it has not stopped", NEVER `"green"`.
   */
  readonly gateStopReason: string | null;
  /**
   * How many times THIS RUN has continued ITSELF — and it is NOT
   * {@link RunRow.resumeCount}.
   *
   * `resumeCount` counts every re-entry including the owner's own presses of
   * Resume (orchestrator.ts `resume()` increments it unconditionally, and the
   * plan and design parks call the same method), so binding automatic
   * continuation to it means a run the owner nursed by hand three times can
   * never continue itself. This column counts only the continuations NOBODY
   * ASKED FOR, and it is the cap `recovery.ts`'s `AUTO_CONTINUE_MAX` enforces.
   *
   * IT MOVES AT EXACTLY TWO SITES, both in orchestrator.ts and both at the
   * moment a continuation is COMMITTED TO rather than when one is considered:
   * `#armRecovery` (when the timer is armed, or immediately before a `continue`
   * requeue) and `reconcileOnBoot`'s interrupted sweep. It is deliberately NOT
   * incremented by `resume()` — the owner's button calls that too — and NOT once
   * per server restart, which would let three restarts during development
   * exhaust the budget of every live run. A cap read from a counter nothing
   * moves is not a cap, which is why the two sites are named here as well as
   * there.
   *
   * NOT NULL DEFAULT 0 on `gate_attempts`' reasoning: 0 is a real count that
   * happens to mean "none", and it is TRUE of every historical row — no run has
   * ever continued itself, because until this column existed nothing could.
   */
  readonly autoContinueCount: number;
  /**
   * The {@link import("./recovery.js").FailureClass} of the last failure this
   * run was classified with, or null.
   *
   * NULLABLE WITHOUT A DEFAULT on `gate_stop_reason`'s and `rate_limited_at`'s
   * reasoning: there is no word that means "we know why this historical run
   * stopped", and any word chosen would be a claim about four runs nothing
   * classified. Null is "nothing classified this", never "it was fine".
   */
  readonly recoveryClass: string | null;
  readonly updatedAt: string;
}

/** The fields a caller may change after creation. Everything else is frozen. */
export interface RunPatch {
  readonly status?: ApiRunStatus;
  readonly phase?: ApiPhase;
  readonly queuePosition?: number | null;
  readonly endedAt?: string | null;
  readonly heldOutPass?: boolean | null;
  readonly falseFinish?: boolean | null;
  readonly agentDeclaredDone?: boolean;
  readonly tokens?: ApiTokens | null;
  readonly rateLimited?: boolean;
  /** See {@link RunRow.rateLimitedAt}: the refusal instant, not the telemetry. */
  readonly rateLimitedAt?: string | null;
  readonly rateLimitRetryAfterSec?: number | null;
  readonly rateLimitKind?: string | null;
  readonly artifactPath?: string | null;
  readonly previewUrl?: string | null;
  readonly suiteSha256?: string | null;
  readonly builderSessionId?: string | null;
  readonly resumeCount?: number;
  readonly failureReason?: string | null;
  readonly inferredCriteria?: number;
  readonly verdictPath?: string;
  /**
   * ONLY `designSegmentDone` IS PATCHABLE OF THE THREE. The other two are stated
   * once, by the request that created the run, and a run whose lock policy could
   * change halfway through is a run whose park has no explanation.
   */
  readonly designSegmentDone?: boolean;
  /**
   * THE TWO MOVE TOGETHER OR NOT AT ALL, and nothing here enforces that because
   * a patch is a partial by construction. The caller is `runGateFixLoop`'s only
   * consumer, which holds both halves of one `GateFixLoopResult`; patching the
   * reason without the count would publish "not-converging after 0 attempts",
   * which is a sentence about nothing.
   */
  readonly gateAttempts?: number;
  readonly gateStopReason?: StopReason | null;
  /** See {@link RunRow.autoContinueCount}, which names its two increment sites. */
  readonly autoContinueCount?: number;
  readonly recoveryClass?: string | null;
}

/**
 * One entry into `#execute`, closed with how it ended.
 *
 * WHY A TABLE AND NOT A COUNT COLUMN. A run that continued itself has to be
 * able to STATE its history — how many attempts, how long it waited, whether
 * the expensive work was redone — and a single integer cannot say any of that.
 * The owner's rule is that a recovered run must not present as a clean pass;
 * this is the record that stops it.
 *
 * ZERO ROWS MEANS "THIS RUN PREDATES THE FEATURE", NEVER "ONE CLEAN ATTEMPT".
 * Every reader must render an empty history as NOTHING rather than as "1
 * attempt", which is why there is no `attempt_count` column on `runs`: a
 * `DEFAULT 1` would be a false claim about `run-…-052c6e02`, which entered
 * `#execute` three times (`resume_count = 2`), and every default in
 * `ADDED_RUN_COLUMNS` has to be true of every historical row.
 */
export interface RunAttempt {
  readonly runId: string;
  /** 1-based, in the order the entries happened. */
  readonly attemptNo: number;
  readonly startedAt: string;
  /** Null while this attempt is still the live one. */
  readonly endedAt: string | null;
  /** The phase the row was in when the attempt ended. */
  readonly phaseReached: string;
  /**
   * A `FailureClass` from `recovery.ts`, or `"completed"` for an attempt that
   * reached a verdict. Null while the attempt is open.
   */
  readonly endClass: string | null;
  /** `describeError()`, redacted, or the park's own sentence. */
  readonly endDetail: string | null;
  /** Wall clock waited BEFORE this attempt began, in seconds. */
  readonly waitedSec: number | null;
  /**
   * `'reused' | 'authored' | 'none'` — which branch of `#specPhase` this attempt
   * took. NOT inferred from the log: a machine-readable column and a prose fold
   * that agree is fine, a prose fold alone is not a record.
   */
  readonly suiteSource: string | null;
}

export interface NewRun {
  readonly runId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly ticketText: string;
  readonly ticketSha256: string;
  readonly modelId: string;
  readonly provider: ApiProvider;
  readonly deploy: boolean;
  readonly startedAt: string;
  readonly queuePosition: number;
  /**
   * §17.3 rule 2's two inputs, OPTIONAL so the HTTP layer can start supplying
   * them without this file's other callers changing. Absent means exactly what
   * an old row means: nothing was stated, and `designLockPolicy` decides from
   * `interactive` alone.
   */
  readonly designLock?: "auto" | "ask" | null;
  readonly interactive?: boolean;
}

/** One persisted SSE event, with the sequence number the replay depends on. */
export interface StoredEvent {
  readonly seq: number;
  readonly at: string;
  readonly event: SseEvent;
}

/**
 * THE DIRECTION OF ONE CHAT MESSAGE. `owner` is the human, `run` is the agent.
 *
 * IT IS A DIRECTION AND NOT AN AUTHOR ATTRIBUTION, and the difference decides
 * what may be written under `run`. Only text the agent ITSELF produced may carry
 * it — `AgentReplyWatch` in owner-message.ts stores the agent's last message of a
 * segment verbatim, and stores NOTHING when the segment produced none. The server
 * must never write a `run` row of its own composition ("working on it…"): the
 * owner reads this channel as the run speaking, and a sentence the run never said
 * is worse than the silence it replaces. Everything the SERVER wants to say about
 * a run goes on the event stream as a `log`, which is a different surface with a
 * different promise.
 *
 * BOTH MEMBERS HAVE EXISTED SINCE THE TABLE DID (2026-07-30, commit c82ad7e) —
 * `pendingMessages` has always filtered on `owner` so the run cannot re-inject its
 * own words — but until 2026-07-31 nothing anywhere wrote `run`, so the chat was
 * one-way in practice while reading two-way in the type. The owner asked a live
 * run "Give me the link to the website", it was delivered and stamped read, and
 * nothing came back, because no producer existed.
 */
export type ChatRole = "owner" | "run";

export interface ChatMessage {
  readonly seq: number;
  readonly at: string;
  readonly role: ChatRole;
  readonly text: string;
  /** Absolute paths under `runs/<id>/chat/`. Empty when none were attached. */
  readonly images: readonly string[];
  /**
   * When the run folded this into a prompt, or null while it is still waiting.
   *
   * NULL ON A FINISHED RUN MEANS IT WAS NEVER SEEN, and the UI must say so rather
   * than imply the redirection landed.
   *
   * IT IS A PROPERTY OF AN `owner` ROW ONLY, AND IS ALWAYS NULL ON A `run` ROW —
   * "delivered to whom?" has no answer for a reply, this program has no signal
   * that the owner read anything, and stamping one to make the column look
   * uniform would be a second fabrication on top of the first. So a `run` row's
   * null means NOTHING AT ALL, not "never read", and a renderer must not put the
   * delivery line under one. The chat panel gates that line on `role === "owner"`
   * (`orchestrator-chat.tsx`), which is where the rule is enforced today.
   */
  readonly deliveredAt: string | null;
}

export interface MessageRequestReceipt {
  readonly clientMessageId: string;
  readonly payloadSha256: string;
  readonly intent: MessageIntent;
  readonly message: ChatMessage;
  readonly documents: readonly string[];
  readonly disposition: Exclude<MessageDisposition, "refused"> | null;
  readonly targetRunId: string | null;
}

export type BeginMessageRequest =
  | { readonly kind: "created" | "replay"; readonly receipt: MessageRequestReceipt }
  | { readonly kind: "conflict"; readonly receipt: MessageRequestReceipt };

export interface RunContinuation {
  readonly sourceRunId: string;
  readonly ownerMessageSeq: number;
  readonly targetRunId: string;
  readonly createdAt: string;
}

/** One durable idempotency receipt for an isolated gate-only recovery. */
export type GateRecoveryState =
  | "prepared"
  | "staging"
  | "ready_to_score"
  | "scoring"
  | "finalizing"
  | "completed"
  | "infra_failed";

/** Initial recovery plus one fresh-key retry after an attributable infrastructure failure. */
export const GATE_RECOVERY_MAX_ATTEMPTS_PER_SOURCE = 2;

export interface GateRecoveryRow {
  readonly sourceRunId: string;
  readonly clientRequestId: string;
  readonly payloadSha256: string;
  readonly targetRunId: string;
  /** Recovery-time scorer-visible workspace digest, never a terminal-time claim. */
  readonly sourceArtifactSha256: string | null;
  readonly targetArtifactSha256: string | null;
  readonly ticketSha256: string;
  readonly suiteSha256: string;
  readonly state: GateRecoveryState;
  readonly protocolVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scoringStartedAt: string | null;
  readonly completedAt: string | null;
  readonly terminalError: string | null;
}

export type GateRecoveryClaim =
  | { readonly kind: "created"; readonly recovery: GateRecoveryRow; readonly target: RunRow }
  | { readonly kind: "replay"; readonly recovery: GateRecoveryRow; readonly target: RunRow }
  | { readonly kind: "conflict"; readonly recovery: GateRecoveryRow; readonly target: RunRow }
  | { readonly kind: "source_blocked"; readonly recovery: GateRecoveryRow; readonly target: RunRow };

export interface NewGateRecovery {
  readonly sourceRunId: string;
  readonly clientRequestId: string;
  readonly payloadSha256: string;
  readonly target: NewRun;
  readonly targetArtifactPath: string;
  readonly ticketSha256: string;
  readonly suiteSha256: string;
  /** Criteria read from the just-verified frozen suite, never from mutable source projections. */
  readonly criteria: readonly {
    readonly id: string;
    readonly statement: string;
    readonly tier: ApiCriterion["tier"];
  }[];
  readonly createdAt: string;
}

export interface GateRecoveryFinalize {
  readonly targetRunId: string;
  readonly state: "completed" | "infra_failed";
  readonly endedAt: string;
  readonly status: "passed" | "failed";
  readonly heldOutPass: boolean | null;
  readonly falseFinish: boolean | null;
  readonly failureReason: string | null;
  readonly verdictPath: string | null;
  readonly gateStopReason: StopReason;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly result: ApiCriterionResult;
    readonly detail: string | null;
  }[];
  readonly screenshots: readonly ApiScreenshot[];
}

/* -------------------------------------------------------------------------
 * Narrowing helpers
 *
 * `get()` returns Record<string, SQLOutputValue> and `noUncheckedIndexedAccess`
 * makes every lookup `| undefined`. One set of helpers here keeps the cast out
 * of forty call sites.
 * ---------------------------------------------------------------------- */

type Row = Record<string, SQLOutputValue>;

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new BakeoffError(
      "invalid_usage_shape",
      `column ${key} is ${value === undefined ? "absent" : typeof value}, expected string`,
      "The database schema and the row reader have diverged. Delete dashboard/data/runs.db to " +
        "rebuild it, or migrate the existing file.",
    );
  }
  return value;
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new BakeoffError(
    "invalid_usage_shape",
    `column ${key} is ${value === undefined ? "absent" : typeof value}, expected number`,
    "The database schema and the row reader have diverged.",
  );
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function boolOrNull(row: Row, key: string): boolean | null {
  const value = numOrNull(row, key);
  return value === null ? null : value !== 0;
}

function bool(row: Row, key: string): boolean {
  return num(row, key) !== 0;
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function flagOrNull(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

/* -------------------------------------------------------------------------
 * The supervisor's row shapes
 * ---------------------------------------------------------------------- */

/**
 * What the OWNER last asked for, not what is happening.
 *
 * `draining` is the whole of STOP: the loop stops claiming and the in-flight
 * run runs to its own verdict. Aborting instead would convert a resumable run
 * into a terminal one (`isTerminal`), which is the loss `reconcileOnBoot`'s
 * docblock exists to end.
 */
export type SupervisorDesired = "running" | "draining" | "stopped";

export interface SupervisorState {
  readonly desired: SupervisorDesired;
  readonly changedAt: string;
  /** `owner` | `boot` | `guard` — who moved it, never blank. */
  readonly changedBy: string;
  /** Why. Never blank; {@link RunStore.setSupervisorState} refuses an empty one. */
  readonly reason: string;
}

/**
 * A supervisor ticket's state.
 *
 * `queued` and `claimed` are the two halves of one instant and must stay
 * separate: a crash between the claim and the submission leaves a `claimed`
 * ticket with a null `currentRunId`, and that pair is the ONLY readable
 * evidence that a submission was lost. Collapsing them would make a lost
 * submission indistinguishable from an idle queue — which is the failure this
 * whole lane exists to catch.
 */
export type SupervisorTicketState =
  | "queued"
  | "claimed"
  | "running"
  | "repairing"
  | "waiting"
  | "blocked"
  | "done"
  | "abandoned";

export interface SupervisorTicket {
  readonly ticketKey: string;
  readonly ticketText: string;
  readonly modelId: string;
  readonly designLock: string;
  readonly state: SupervisorTicketState;
  readonly attemptNo: number;
  readonly maxAttempts: number;
  /** JSON, the per-class budgets of the design's §3.5. Carried, not parsed here. */
  readonly classCounts: string;
  /*
   * `repair_counts` IS DELIBERATELY NOT A FIELD ON THIS INTERFACE, and the
   * reason is a cross-lane one worth writing down.
   *
   * The column exists (see the schema and {@link RunStore.readSupervisorRepairCounts})
   * and `SupervisorTicketPatch` can write it, but adding a REQUIRED field here
   * breaks every hand-built `SupervisorTicket` literal in the tree — including
   * `http.ts`'s own arm-check fixture, which another lane owns — and adding an
   * OPTIONAL one would make "no cycles spent" and "this fixture does not model
   * the counter" the same value on a brake. The counter has exactly one reader,
   * `supervisor.ts#readRepairCounts`, so it is fetched by the one method that
   * needs it instead of travelling on every row.
   */
  readonly currentRunId: string | null;
  readonly lastRunId: string | null;
  readonly lastClass: string | null;
  readonly lastDefectId: string | null;
  readonly patchId: string | null;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  /** Always a sentence. Never `''`; the schema has no default and this is why. */
  readonly nextAction: string;
  readonly nextActionAt: string | null;
}

export interface NewSupervisorTicket {
  readonly ticketKey: string;
  readonly ticketText: string;
  readonly modelId: string;
  readonly nextAction: string;
  readonly maxAttempts?: number;
  readonly designLock?: string;
}

export interface SupervisorTicketPatch {
  readonly state?: SupervisorTicketState;
  readonly attemptNo?: number;
  readonly classCounts?: string;
  readonly repairCounts?: string;
  readonly currentRunId?: string | null;
  readonly lastRunId?: string | null;
  readonly lastClass?: string | null;
  readonly lastDefectId?: string | null;
  readonly patchId?: string | null;
  readonly nextAction?: string;
  readonly nextActionAt?: string | null;
}

/**
 * One line of the supervisor's journal.
 *
 * `cron-tick.ts:14-20` is the precedent, verbatim in intent: six of the seven
 * ways a tick can end produce the identical observable, so every terminal path
 * appends exactly one row naming the decision and why.
 */
export interface SupervisorLogEntry {
  readonly seq: number;
  readonly at: string;
  readonly ticketKey: string | null;
  readonly runId: string | null;
  readonly decision: string;
  readonly reason: string;
}

const SUPERVISOR_DESIRED: readonly SupervisorDesired[] = ["running", "draining", "stopped"];

const SUPERVISOR_TICKET_STATES: readonly SupervisorTicketState[] = [
  "queued",
  "claimed",
  "running",
  "repairing",
  "waiting",
  "blocked",
  "done",
  "abandoned",
];

/**
 * The state a database that has never seen a supervisor reports.
 *
 * STOPPED, not running: a process that boots and starts spending because a
 * table was empty is the opposite of an owner-controlled switch. The reason
 * string is non-empty here for the same rule the column enforces.
 */
const SUPERVISOR_STATE_SEED: SupervisorState = {
  desired: "stopped",
  changedAt: "",
  changedBy: "boot",
  reason: "the supervisor has never been started on this database",
};

/* -------------------------------------------------------------------------
 * Enum guards — a column is text, and text can be anything
 * ---------------------------------------------------------------------- */

const RUN_STATUSES: readonly ApiRunStatus[] = [
  "queued",
  "running",
  "awaiting_input",
  "rate_limited",
  "passed",
  "failed",
  "cancelled",
];
/**
 * `plan` LEADS, AND ADDING IT MIGRATES NOTHING.
 *
 * This list has exactly one consumer — `oneOf(PHASES, str(row, "phase"), "phase")`
 * in `toRunRow` — and `oneOf` is a MEMBERSHIP test, not an index. So every run row
 * already on disk holds one of the original five, all of which are still members,
 * and no backfill exists to be forgotten. `plan-phase.test.ts` inserts a row whose
 * phase is `spec` and reads it back through this guard, so the claim is checked
 * rather than argued.
 *
 * THE ORDER IS FOR READERS, NOT FOR THIS FILE. Nothing here indexes it; the
 * client's `PHASE_ORDER` does, and that is where adding a member at the front has
 * a visible cost (an old run whose first recorded phase was `spec` renders as
 * though it completed a plan phase it never had).
 */
const PHASES: readonly ApiPhase[] = ["plan", "spec", "build", "review", "gate", "judge", "done"];
// "moonshot" and "deepseek" left this list on 2026-07-30 with the model rows the
// owner removed. Nothing in this store can hold either: `POST /api/runs` refused
// every metered id with 409 for as long as they existed, so no run row was ever
// written with one, and `seat_spend.provider` comes from `TokenTotals`, whose
// vendor is only ever "anthropic" or "openai".
const PROVIDERS: readonly ApiProvider[] = ["anthropic", "openai"];
const TIERS: readonly ApiCriterionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];
const CRITERION_RESULTS: readonly ApiCriterionResult[] = ["pass", "fail", "pending"];
const GATE_RECOVERY_STATES: readonly GateRecoveryState[] = [
  "prepared",
  "staging",
  "ready_to_score",
  "scoring",
  "finalizing",
  "completed",
  "infra_failed",
];
const GATE_RECOVERY_SELECT_COLUMNS = `source_run_id, client_request_id, payload_sha256, target_run_id,
  source_artifact_sha256, target_artifact_sha256, ticket_sha256, suite_sha256, state,
  protocol_version, created_at, updated_at, scoring_started_at, completed_at, terminal_error`;
/**
 * THE SEAT VOCABULARY IS IMPORTED, NOT RETYPED — the one list above that is.
 *
 * Every other list in this block is a hand-written copy of a union, which is a
 * declaration site that can drift; `api-types.ts` exports `SPEND_SEATS` as a
 * value precisely so this guard and the wire union cannot name different seats. A
 * copy here that missed `fix` would throw `spend seat "fix" is not one of …` on a
 * row THIS STORE ITSELF WROTE, and only on the seat that reports last.
 *
 * AND IT IS GUARDED ON THE WAY OUT, unlike `gate_stop_reason` two guards below.
 * The difference is who owns the vocabulary: a stop reason's words live in
 * `gate-fix-loop.ts` and a row written by a newer server must READ rather than
 * throw, while a seat name is this contract's own and IS the attribution. An
 * unrecognised seat read through as a plain string would file spend under a name
 * no renderer has a line for, which is the silent drop this record exists to end.
 */
const METERED_KINDS: readonly ApiMeteredSpend["kind"][] = ["image", "video"];

function oneOf<T extends string>(values: readonly T[], raw: string, label: string): T {
  const found = values.find((v) => v === raw);
  if (found === undefined) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${label} ${JSON.stringify(raw)} is not one of ${values.join(", ")}`,
      "A row was written by a different version of this server. Delete dashboard/data/runs.db, or " +
        "migrate it.",
    );
  }
  return found;
}

/** True for a status that can never change again. */
export function isTerminal(status: ApiRunStatus): boolean {
  return status === "passed" || status === "failed" || status === "cancelled";
}

/**
 * The opening words of the silence watch's own warning — the ONE sentence
 * {@link RunStore.lastRunEventAt} refuses to hear.
 *
 * IT LIVES HERE, NEXT TO THE QUERY THAT FILTERS ON IT, AND NOT NEXT TO THE
 * ORCHESTRATOR THAT EMITS IT. Two spellings of this string is a filter that
 * matches nothing: the watch would go on announcing, each announcement would
 * reset the clock it just read, and every test that only ever checks the FIRST
 * warning would stay green. One declaration site, imported by the emitter.
 *
 * A TEXT PREFIX RATHER THAN A VISIBLE `[marker]`, because this text is rendered
 * to the owner in the run's log panel and a machine-readable tag in the middle
 * of a sentence is noise the owner has to learn to ignore. The events table has
 * no column that records WHO wrote a row — adding one would mean a migration
 * plus a new argument on `RunEventBus.emit`, which every emitter in the server
 * would have to pass — so the sentence itself is the identifier.
 *
 * NO `%` AND NO `_`: the query interpolates this into a `LIKE` pattern with no
 * `ESCAPE` clause, where both are wildcards. `stall-watch.test.ts` asserts the
 * absence rather than trusting the reader to remember it.
 */
export const SILENCE_NOTICE_PREFIX = "no event has been recorded on this run's stream for ";

/* -------------------------------------------------------------------------
 * The store
 * ---------------------------------------------------------------------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id                     TEXT PRIMARY KEY,
  ticket_id                  TEXT NOT NULL,
  ticket_title               TEXT NOT NULL,
  ticket_text                TEXT NOT NULL,
  ticket_sha256              TEXT NOT NULL,
  model_id                   TEXT NOT NULL,
  provider                   TEXT NOT NULL,
  deploy                     INTEGER NOT NULL,
  status                     TEXT NOT NULL,
  phase                      TEXT NOT NULL,
  queue_position             INTEGER,
  started_at                 TEXT NOT NULL,
  ended_at                   TEXT,
  held_out_pass              INTEGER,
  false_finish               INTEGER,
  agent_declared_done        INTEGER NOT NULL DEFAULT 0,
  input_tokens               INTEGER,
  output_tokens              INTEGER,
  cache_read_tokens          INTEGER,
  cache_write_tokens         INTEGER,
  rate_limited               INTEGER NOT NULL DEFAULT 0,
  rate_limited_at            TEXT,
  rate_limit_retry_after_sec INTEGER,
  rate_limit_kind            TEXT,
  artifact_path              TEXT,
  preview_url                TEXT,
  suite_sha256               TEXT,
  builder_session_id         TEXT,
  resume_count               INTEGER NOT NULL DEFAULT 0,
  failure_reason             TEXT,
  inferred_criteria          INTEGER NOT NULL DEFAULT 0,
  verdict_path               TEXT NOT NULL DEFAULT '',
  design_segment_done        INTEGER NOT NULL DEFAULT 0,
  design_lock                TEXT NOT NULL DEFAULT '',
  interactive                INTEGER NOT NULL DEFAULT 0,
  gate_attempts              INTEGER NOT NULL DEFAULT 0,
  gate_stop_reason           TEXT,
  auto_continue_count        INTEGER NOT NULL DEFAULT 0,
  recovery_class             TEXT,
  updated_at                 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);

CREATE TABLE IF NOT EXISTS events (
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

/*
 * THE ATTEMPT LEDGER. See {@link RunAttempt} for why this is a table and why an
 * empty history must never render as "1 attempt".
 *
 * A NEW TABLE IS FREE ON AN EXISTING DATABASE — CREATE TABLE IF NOT EXISTS
 * creates it empty and the owner's four historical runs get zero rows — which is
 * why this needs no entry in ADDED_RUN_COLUMNS. The columns of "runs" do; see
 * the docblock there for the asymmetry that makes a missed entry visible only on
 * the owner's own machine. (No backticks in this comment: the whole schema is a
 * template literal, and one would end it.)
 */
CREATE TABLE IF NOT EXISTS run_attempts (
  run_id        TEXT    NOT NULL,
  attempt_no    INTEGER NOT NULL,
  started_at    TEXT    NOT NULL,
  ended_at      TEXT,
  phase_reached TEXT    NOT NULL,
  end_class     TEXT,
  end_detail    TEXT,
  waited_sec    INTEGER,
  suite_source  TEXT,
  PRIMARY KEY (run_id, attempt_no)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS criteria (
  run_id       TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  statement    TEXT NOT NULL,
  tier         TEXT NOT NULL,
  result       TEXT NOT NULL,
  detail       TEXT,
  PRIMARY KEY (run_id, criterion_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS screenshots (
  run_id      TEXT NOT NULL,
  path        TEXT NOT NULL,
  label       TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, path)
) WITHOUT ROWID;

/*
 * THE OWNER-TO-RUN CHANNEL. Until 2026-07-30 there was none: the only way to say
 * anything to a run was POST /api/runs/:id/resume with an optional chosenMockup,
 * which is one string from a fixed set of five.
 *
 * NOTE FOR EDITORS: this comment sits inside a template literal, so it must contain
 * no backticks. An earlier draft quoted identifiers the way the rest of the codebase
 * does and terminated the SCHEMA string mid-sentence.
 *
 * delivered_at IS THE WHOLE DESIGN. It is NULL while a message waits and is stamped
 * when the run has actually folded it into a prompt. That keeps three states apart
 * that a boolean would collapse:
 *
 *   - queued and not yet seen (the UI says it is waiting for the next boundary),
 *   - taken up at a known instant (the UI can say when),
 *   - never taken up, because the run ended first -- which must not read as
 *     "delivered", or the owner believes a redirection landed that the build never
 *     saw.
 *
 * Stamping at pickup rather than at insert is also what makes delivery AT MOST ONCE
 * across a resume: the drain selects on delivered_at IS NULL, so a run that restarts
 * cannot re-inject an instruction it already acted on.
 *
 * images is newline-joined ABSOLUTE paths, not blobs. The bytes live under
 * runs/<id>/chat/, the same shape the screenshots table already uses: a SQLite row is
 * the wrong place for a 2MB PNG, and the builder needs a path to Read anyway.
 *
 * role IS THE DIRECTION: owner or run. It has been on this table since the table
 * existed, and ADDED_MESSAGE_COLUMNS carries it anyway -- see that constant for what
 * that migration does and does not defend against. delivered_at above describes an
 * owner row only; on a run row it is always NULL and means nothing (ChatMessage).
 */
CREATE TABLE IF NOT EXISTS messages (
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  at           TEXT NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT NOT NULL,
  images       TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

/*
 * IDEMPOTENCY RECEIPTS FOR CHAT INTAKE. The owner message remains in messages;
 * this table binds one client action to that row and to the closed disposition
 * returned by the route. A null disposition is a crash-recovery state: the row
 * was committed, but delivery was not yet decided.
 */
CREATE TABLE IF NOT EXISTS message_requests (
  run_id            TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  message_seq       INTEGER NOT NULL,
  intent            TEXT NOT NULL,
  documents         TEXT NOT NULL DEFAULT '',
  disposition       TEXT,
  target_run_id     TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, client_message_id)
) WITHOUT ROWID;

/* A terminal run never reopens. Its follow-up is a new run linked to exactly
 * one durable owner message; the composite primary key is the identity anchor. */
CREATE TABLE IF NOT EXISTS run_continuations (
  source_run_id    TEXT NOT NULL,
  owner_message_seq INTEGER NOT NULL,
  target_run_id    TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (source_run_id, owner_message_seq)
) WITHOUT ROWID;

/* Gate-only recovery has its own identity and lineage. It deliberately does
 * not overload chat continuations: no owner message, builder, or reopened
 * source exists on this path. */
CREATE TABLE IF NOT EXISTS gate_recoveries (
  source_run_id          TEXT NOT NULL,
  client_request_id      TEXT NOT NULL CHECK (length(client_request_id) BETWEEN 1 AND 128),
  payload_sha256         TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_run_id          TEXT NOT NULL UNIQUE,
  source_artifact_sha256 TEXT CHECK (source_artifact_sha256 IS NULL OR (length(source_artifact_sha256) = 64 AND source_artifact_sha256 NOT GLOB '*[^0-9a-f]*')),
  target_artifact_sha256 TEXT CHECK (target_artifact_sha256 IS NULL OR (length(target_artifact_sha256) = 64 AND target_artifact_sha256 NOT GLOB '*[^0-9a-f]*')),
  ticket_sha256          TEXT NOT NULL CHECK (length(ticket_sha256) = 64 AND ticket_sha256 NOT GLOB '*[^0-9a-f]*'),
  suite_sha256           TEXT NOT NULL CHECK (length(suite_sha256) = 64 AND suite_sha256 NOT GLOB '*[^0-9a-f]*'),
  state                  TEXT NOT NULL CHECK (state IN ('prepared','staging','ready_to_score','scoring','finalizing','completed','infra_failed')),
  protocol_version       INTEGER NOT NULL CHECK (protocol_version = 1),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  scoring_started_at     TEXT,
  completed_at           TEXT,
  terminal_error         TEXT,
  PRIMARY KEY (source_run_id, client_request_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS seat_spend (
  run_id             TEXT NOT NULL,
  seat               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  call_count         INTEGER NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (run_id, seat, provider, model_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS metered_spend (
  run_id                  TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  model                   TEXT NOT NULL,
  ordinal                 INTEGER NOT NULL,
  calls                   INTEGER NOT NULL,
  delivered_seconds_floor INTEGER,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, model)
) WITHOUT ROWID;

/*
 * ─── THE SUPERVISOR'S THREE TABLES ───
 *
 * They are NEW TABLES, which is the cheap half of this schema: CREATE TABLE IF
 * NOT EXISTS makes them empty on the owner's existing database and nothing in
 * ADDED_RUN_COLUMNS has to know about them. No column is added to "runs" here,
 * deliberately -- the supervisor's counters answer a different question from
 * runs.auto_continue_count and recovery.ts is explicit that mixing two counters
 * into one is how a bound stops working.
 *
 * WHY THE STATE IS A TABLE AND NOT A FIELD ON THE PROCESS. The whole point of
 * the loop is that it survives its own restart: which ticket is in flight, and
 * whether the owner asked for RUNNING or STOPPED, must be readable by a process
 * that has just booted and remembers nothing.
 *
 * next_action TEXT NOT NULL WITH NO DEFAULT IS THE ANTI-SIGNATURE-DEFECT
 * MEASURE, AT THE SCHEMA LEVEL. This repository's catalogued failure is a
 * display that reports work it never observed; a ticket row that could be
 * written with nothing to say about itself is that defect with a database
 * behind it. SQLite refuses the INSERT instead. Adding DEFAULT '' to this
 * column would turn supervisor.test.ts's "a ticket cannot be filed mute" red,
 * which is the point of writing it down here.
 *
 * (No backticks anywhere in this comment: the whole schema is a template
 * literal and one would end it.)
 */
CREATE TABLE IF NOT EXISTS supervisor_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  desired    TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  reason     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supervisor_tickets (
  ticket_key     TEXT PRIMARY KEY,
  ticket_text    TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  design_lock    TEXT NOT NULL DEFAULT 'auto',
  state          TEXT NOT NULL,
  attempt_no     INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  class_counts   TEXT NOT NULL DEFAULT '{}',
  repair_counts  TEXT NOT NULL DEFAULT '{}',
  current_run_id TEXT,
  last_run_id    TEXT,
  last_class     TEXT,
  last_defect_id TEXT,
  patch_id       TEXT,
  enqueued_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  next_action    TEXT NOT NULL,
  next_action_at TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS supervisor_tickets_state ON supervisor_tickets (state, enqueued_at);

CREATE TABLE IF NOT EXISTS supervisor_log (
  seq        INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  ticket_key TEXT,
  run_id     TEXT,
  decision   TEXT NOT NULL,
  reason     TEXT NOT NULL
);
`;

const RUN_COLUMNS = [
  "run_id",
  "ticket_id",
  "ticket_title",
  "ticket_text",
  "ticket_sha256",
  "model_id",
  "provider",
  "deploy",
  "status",
  "phase",
  "queue_position",
  "started_at",
  "ended_at",
  "held_out_pass",
  "false_finish",
  "agent_declared_done",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "rate_limited",
  "rate_limited_at",
  "rate_limit_retry_after_sec",
  "rate_limit_kind",
  "artifact_path",
  "preview_url",
  "suite_sha256",
  "builder_session_id",
  "resume_count",
  "failure_reason",
  "inferred_criteria",
  "verdict_path",
  "design_segment_done",
  "design_lock",
  "interactive",
  "gate_attempts",
  "gate_stop_reason",
  "auto_continue_count",
  "recovery_class",
  "updated_at",
].join(", ");

/**
 * Columns added to `runs` after the first release, and the DDL that adds them.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a database created before this column existed would be read by a reader that
 * selects it — and `str()`/`num()` would throw "column absent" on the owner's
 * own `dashboard/data/runs.db` while every test, which starts from `mkdtemp`,
 * stayed green. That asymmetry is why the migration has its own test rather
 * than being trusted to the schema.
 *
 * Each entry must be additive and must carry a constant default: SQLite's
 * `ALTER TABLE ... ADD COLUMN` accepts `NOT NULL` only with one, and an existing
 * row has to mean something the moment the column appears. Both defaults here
 * are the "nothing recorded yet" value, which is true of every historical row.
 */
const ADDED_RUN_COLUMNS: readonly { readonly name: string; readonly ddl: string }[] = [
  {
    name: "inferred_criteria",
    ddl: "ALTER TABLE runs ADD COLUMN inferred_criteria INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "verdict_path",
    ddl: "ALTER TABLE runs ADD COLUMN verdict_path TEXT NOT NULL DEFAULT ''",
  },
  // Phase 2b (the DESIGN lane). All three defaults are the "nothing recorded
  // yet" value and all three are TRUE of every historical row: no run before
  // this phase had a design segment, stated a lock policy, or was marked
  // interactive.
  {
    name: "design_segment_done",
    ddl: "ALTER TABLE runs ADD COLUMN design_segment_done INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "design_lock",
    ddl: "ALTER TABLE runs ADD COLUMN design_lock TEXT NOT NULL DEFAULT ''",
  },
  {
    name: "interactive",
    ddl: "ALTER TABLE runs ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0",
  },
  // Phase 2d (the GATE/FIX loop's outcome). Both defaults are the "nothing
  // recorded yet" value and both are TRUE of every historical row: no run before
  // this phase persisted an attempt count or a stop reason anywhere. Note the
  // asymmetry — 0 is a real count that happens to mean "none", while the reason
  // has no such value, so its column is NULLABLE and takes no default rather
  // than defaulting to a word ("green") that would be a claim.
  {
    name: "gate_attempts",
    ddl: "ALTER TABLE runs ADD COLUMN gate_attempts INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "gate_stop_reason",
    ddl: "ALTER TABLE runs ADD COLUMN gate_stop_reason TEXT",
  },
  // The rate-limit park's durable half. NULLABLE AND WITHOUT A DEFAULT, on
  // `gate_stop_reason`'s reasoning rather than `gate_attempts`': there is no
  // value that means "we know when this run was refused" for a historical row,
  // and a default of the migration's own timestamp would hand every old
  // rate-limited run a fresh window it never waited. Null is refused by
  // `planRateLimitResume`, which is the correct treatment of "unknown".
  {
    name: "rate_limited_at",
    ddl: "ALTER TABLE runs ADD COLUMN rate_limited_at TEXT",
  },
  // Auto-recovery. THE SAME ASYMMETRY AS `gate_attempts`/`gate_stop_reason`, and
  // for the same reasons: 0 is a real count that happens to mean "none" and is
  // true of every historical row (no run has ever continued itself, because
  // nothing could), while there is no word that means "we know why this
  // historical run stopped" — so the class column is nullable and takes no
  // default rather than defaulting to a claim.
  //
  // OMITTING EITHER OF THESE BREAKS THE OWNER'S MACHINE ALONE. Every test starts
  // from `mkdtemp`, where the `CREATE TABLE IF NOT EXISTS` above always carries
  // the newest column and this list is never consulted; `dashboard/data/runs.db`
  // is the only database in existence that takes the ALTER path. That is what
  // `db.test.ts`'s DROP COLUMN fixture reproduces.
  {
    name: "auto_continue_count",
    ddl: "ALTER TABLE runs ADD COLUMN auto_continue_count INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "recovery_class",
    ddl: "ALTER TABLE runs ADD COLUMN recovery_class TEXT",
  },
];

/**
 * The same treatment for `messages`, ONE TABLE OVER — and read the second
 * paragraph before believing it protects anything on this machine.
 *
 * WHAT IT DEFENDS AGAINST TODAY: NO DATABASE THAT HAS EVER EXISTED. The
 * `messages` table and its `role` column shipped in the SAME COMMIT (c82ad7e,
 * 2026-07-30), so no build of this server ever created the table without it, and
 * the owner's own `dashboard/data/runs.db` was inspected on 2026-07-31 and has
 * the column with its single row already reading `owner`. Saying that plainly is
 * the point: a migration entry is not evidence that a broken database was found,
 * and the next reader must not infer one from its presence.
 *
 * WHY IT IS HERE ANYWAY. `runs` had no additive hook either until a column was
 * added and `str()` began throwing "column design_lock is absent" on the owner's
 * machine and nowhere else — every test starts from `mkdtemp`, where
 * `CREATE TABLE IF NOT EXISTS` always includes the newest column and the
 * migration path is never taken. This is that hook, installed on `messages`
 * BEFORE the first column is added to it rather than after, so the second entry
 * in this list costs one line instead of one incident.
 *
 * The default is `'owner'` and it is the only defensible one: every row that
 * could predate the column was written by `postMessage`, which passes
 * `role: "owner"` at its single call site, and the reply producer did not exist.
 */
const ADDED_MESSAGE_COLUMNS: readonly { readonly name: string; readonly ddl: string }[] = [
  {
    name: "role",
    ddl: "ALTER TABLE messages ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'",
  },
];

/**
 * Add whichever of `columns` the table does not already have.
 *
 * ONE LOOP FOR BOTH TABLES rather than two near-identical ones: a second copy is
 * a second place for the `PRAGMA`/`ALTER` pair to drift, and the pair is the
 * whole mechanism. It reads the live schema rather than a version number, so it
 * is idempotent and safe to run on every open.
 */
function addMissingColumns(
  db: DatabaseSync,
  table: string,
  columns: readonly { readonly name: string; readonly ddl: string }[],
): void {
  const present = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => str(row, "name")),
  );
  for (const column of columns) {
    if (!present.has(column.name)) db.exec(column.ddl);
  }
}

function migrateRuns(db: DatabaseSync): void {
  addMissingColumns(db, "runs", ADDED_RUN_COLUMNS);
}

function migrateMessages(db: DatabaseSync): void {
  addMissingColumns(db, "messages", ADDED_MESSAGE_COLUMNS);
}

/**
 * The same hook on `supervisor_tickets`, and this one DOES defend a database
 * that exists.
 *
 * `supervisor_tickets` was created by a build that ran against the owner's own
 * `dashboard/data/runs.db` earlier today, WITHOUT `repair_counts`.
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * without this entry `toSupervisorTicket` would throw "column repair_counts is
 * absent" on that one database and on no other — every test starts from
 * `mkdtemp`, where the newest schema is always complete. That asymmetry is
 * exactly the `design_lock` incident this file already records, and it is why
 * `db.test.ts` reproduces it with a DROP COLUMN fixture rather than trusting the
 * schema.
 *
 * `'{}'` is the honest default: no historical ticket has ever had a repair cycle,
 * because nothing could run one.
 */
const ADDED_SUPERVISOR_TICKET_COLUMNS: readonly { readonly name: string; readonly ddl: string }[] = [
  {
    name: "repair_counts",
    ddl: "ALTER TABLE supervisor_tickets ADD COLUMN repair_counts TEXT NOT NULL DEFAULT '{}'",
  },
];

function migrateSupervisorTickets(db: DatabaseSync): void {
  addMissingColumns(db, "supervisor_tickets", ADDED_SUPERVISOR_TICKET_COLUMNS);
}

export class RunStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(databasePath: string): RunStore {
    const db = new DatabaseSync(databasePath);
    // WAL so a long-running read (an SSE replay of a big run) cannot block a
    // write from the orchestrator on the same thread's next tick.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    migrateRuns(db);
    // AFTER the SCHEMA exec, which is what guarantees the table exists at all: a
    // database that predates the `messages` table gets it from
    // `CREATE TABLE IF NOT EXISTS` above, complete, and this then sees every
    // column present and does nothing. `PRAGMA table_info` on a missing table
    // returns no rows, so the order also decides whether an ALTER would be
    // attempted against nothing.
    migrateMessages(db);
    migrateSupervisorTickets(db);
    return new RunStore(db);
  }

  close(): void {
    this.#db.close();
  }

  /* ---- runs --------------------------------------------------------- */

  createRun(run: NewRun): RunRow {
    // ONE redaction call covering every string on the way in. The ticket text
    // is owner-authored and could contain a pasted key; it is persisted, so it
    // is redacted like everything else.
    const safe = redactForPersistence({
      runId: run.runId,
      ticketId: run.ticketId,
      ticketTitle: run.ticketTitle,
      ticketText: run.ticketText,
      modelId: run.modelId,
    });
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO runs (run_id, ticket_id, ticket_title, ticket_text, ticket_sha256, model_id,
           provider, deploy, status, phase, queue_position, started_at, design_lock, interactive,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        safe.runId,
        safe.ticketId,
        safe.ticketTitle,
        safe.ticketText,
        // NOT redacted, and it must not be: this is a sha256 of the brief and
        // the whole freeze chain compares against it. `isDigestSafeKey` exists
        // in redact.ts for exactly this reason.
        run.ticketSha256,
        safe.modelId,
        run.provider,
        flag(run.deploy),
        "queued" satisfies ApiRunStatus,
        // A QUEUED RUN HAS NOT REACHED ANY PHASE, so this is a statement about
        // what it will do first rather than what it has done. `plan` is now that
        // phase; leaving `spec` here would have every queued run render one phase
        // ahead of where it will actually start.
        "plan" satisfies ApiPhase,
        run.queuePosition,
        run.startedAt,
        // NOT REDACTED, AND IT CANNOT BE: this is one of two literals or the
        // empty string, and `redactForPersistence` on a short enum is a no-op
        // that would still have to be read back through a guard.
        run.designLock ?? "",
        flag(run.interactive ?? false),
        now,
      );
    const created = this.getRun(run.runId);
    if (created === null) {
      throw new BakeoffError("invalid_usage_shape", `run ${run.runId} vanished after insert`, "Retry.");
    }
    return created;
  }

  /* ---- isolated gate recovery -------------------------------------- */

  gateRecovery(sourceRunId: string, clientRequestId: string): GateRecoveryRow | null {
    const row = this.#db
      .prepare(
        `SELECT ${GATE_RECOVERY_SELECT_COLUMNS}
         FROM gate_recoveries WHERE source_run_id = ? AND client_request_id = ?`,
      )
      .get(sourceRunId, clientRequestId);
    return row === undefined ? null : toGateRecoveryRow(row);
  }

  gateRecoveryForTarget(targetRunId: string): GateRecoveryRow | null {
    const row = this.#db
      .prepare(
        `SELECT ${GATE_RECOVERY_SELECT_COLUMNS}
         FROM gate_recoveries WHERE target_run_id = ?`,
      )
      .get(targetRunId);
    return row === undefined ? null : toGateRecoveryRow(row);
  }

  listRunningGateRecoveries(): readonly { readonly recovery: GateRecoveryRow; readonly target: RunRow }[] {
    const recoveries = this.#db
      .prepare(
        `SELECT g.source_run_id, g.client_request_id, g.payload_sha256, g.target_run_id,
           g.source_artifact_sha256, g.target_artifact_sha256, g.ticket_sha256, g.suite_sha256,
           g.state, g.protocol_version, g.created_at, g.updated_at, g.scoring_started_at,
           g.completed_at, g.terminal_error
         FROM gate_recoveries g WHERE EXISTS
           (SELECT 1 FROM runs r WHERE r.run_id = g.target_run_id AND r.status = 'running')`,
      )
      .all()
      .map(toGateRecoveryRow);
    return recoveries.map((recovery) => {
      const target = this.getRun(recovery.targetRunId);
      if (target === null) throw new Error(`gate recovery target ${recovery.targetRunId} vanished`);
      return { recovery, target };
    });
  }

  listIncompleteGateRecoveries(): readonly { readonly recovery: GateRecoveryRow; readonly target: RunRow }[] {
    const recoveries = this.#db
      .prepare(
        `SELECT g.source_run_id, g.client_request_id, g.payload_sha256, g.target_run_id,
           g.source_artifact_sha256, g.target_artifact_sha256, g.ticket_sha256, g.suite_sha256,
           g.state, g.protocol_version, g.created_at, g.updated_at, g.scoring_started_at,
           g.completed_at, g.terminal_error
         FROM gate_recoveries g
         WHERE g.state NOT IN ('completed', 'infra_failed')
         ORDER BY g.created_at ASC`,
      )
      .all()
      .map(toGateRecoveryRow);
    return recoveries.map((recovery) => {
      const target = this.getRun(recovery.targetRunId);
      if (target === null) throw new Error(`gate recovery target ${recovery.targetRunId} vanished`);
      return { recovery, target };
    });
  }

  isGateRecoveryTarget(runId: string): boolean {
    return this.#db.prepare("SELECT 1 AS found FROM gate_recoveries WHERE target_run_id = ?").get(runId) !== undefined;
  }

  /** Compare-and-swap the durable protocol state. */
  transitionGateRecovery(
    targetRunId: string,
    from: GateRecoveryState,
    to: GateRecoveryState,
    at: string,
    patch: {
      readonly sourceArtifactSha256?: string;
      readonly targetArtifactSha256?: string;
      readonly scoringStartedAt?: string;
      readonly completedAt?: string;
      readonly terminalError?: string | null;
    } = {},
  ): GateRecoveryRow | null {
    const sets = ["state = ?", "updated_at = ?"];
    const values: SQLInputValue[] = [to, at];
    const add = (column: string, value: SQLInputValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.sourceArtifactSha256 !== undefined) add("source_artifact_sha256", patch.sourceArtifactSha256);
    if (patch.targetArtifactSha256 !== undefined) add("target_artifact_sha256", patch.targetArtifactSha256);
    if (patch.scoringStartedAt !== undefined) add("scoring_started_at", patch.scoringStartedAt);
    if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);
    if (patch.terminalError !== undefined) {
      add("terminal_error", patch.terminalError === null ? null : redactForPersistence(patch.terminalError));
    }
    values.push(targetRunId, from);
    const result = this.#db
      .prepare(`UPDATE gate_recoveries SET ${sets.join(", ")} WHERE target_run_id = ? AND state = ?`)
      .run(...values);
    return result.changes === 1 ? this.gateRecoveryForTarget(targetRunId) : null;
  }

  /** The only durable transition that grants permission to invoke gate.score. */
  claimGateRecoveryScoring(targetRunId: string, at: string): GateRecoveryRow | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#db
        .prepare(
          `UPDATE gate_recoveries SET state = 'scoring', scoring_started_at = ?, updated_at = ?
           WHERE target_run_id = ? AND state = 'ready_to_score'`,
        )
        .run(at, at, targetRunId);
      if (changed.changes !== 1) {
        this.#db.exec("COMMIT");
        return null;
      }
      this.updateRun(targetRunId, { gateAttempts: 1 });
      const recovery = this.gateRecoveryForTarget(targetRunId);
      this.#db.exec("COMMIT");
      return recovery;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Claim one recovery and create its child in one IMMEDIATE transaction.
   *
   * The child is born RUNNING in GATE, never QUEUED. The ordinary orchestrator
   * therefore has no observable state in which it can claim this row. Frozen
   * criteria are inserted under the same lock so every later score update is
   * child-owned and does not trust a mutable source projection.
   */
  claimGateRecovery(input: NewGateRecovery): GateRecoveryClaim {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.gateRecovery(input.sourceRunId, input.clientRequestId);
      if (existing !== null) {
        const target = this.getRun(existing.targetRunId);
        if (target === null) {
          throw new BakeoffError(
            "invalid_usage_shape",
            `gate recovery target ${existing.targetRunId} is missing`,
            "Do not create another child under the same idempotency key; repair the database lineage first.",
          );
        }
        this.#db.exec("COMMIT");
        return {
          kind: existing.payloadSha256 === input.payloadSha256 ? "replay" : "conflict",
          recovery: existing,
          target,
        };
      }

      const priorRecoveries = this.#db.prepare(
        `SELECT ${GATE_RECOVERY_SELECT_COLUMNS}
         FROM gate_recoveries WHERE source_run_id = ?
         ORDER BY created_at DESC`,
      ).all(input.sourceRunId).map(toGateRecoveryRow);
      const blockingRecovery = priorRecoveries.find((row) => row.state !== "infra_failed") ??
        (priorRecoveries.length >= GATE_RECOVERY_MAX_ATTEMPTS_PER_SOURCE ? priorRecoveries[0] : undefined);
      if (blockingRecovery !== undefined) {
        const recovery = blockingRecovery;
        const target = this.getRun(recovery.targetRunId);
        if (target === null) throw new Error(`gate recovery target ${recovery.targetRunId} vanished`);
        this.#db.exec("COMMIT");
        return { kind: "source_blocked", recovery, target };
      }

      const source = this.getRun(input.sourceRunId);
      if (
        source === null || source.status !== "failed" || source.heldOutPass !== null ||
        source.falseFinish !== null || source.gateStopReason !== "infra" ||
        !source.agentDeclaredDone || source.ticketSha256 !== input.ticketSha256 ||
        source.suiteSha256 !== input.suiteSha256
      ) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `source run ${input.sourceRunId} changed before the gate recovery could be claimed`,
          "Re-read the source run. Recovery is allowed only while its failed/no-verdict infra identity is unchanged.",
        );
      }

      this.createRun(input.target);
      const target = this.updateRun(input.target.runId, {
        status: "running",
        phase: "gate",
        queuePosition: null,
        agentDeclaredDone: true,
        artifactPath: input.targetArtifactPath,
        suiteSha256: input.suiteSha256,
        gateAttempts: 0,
        gateStopReason: "infra",
      });
      const insertCriterion = this.#db.prepare(
        `INSERT INTO criteria (run_id, criterion_id, ordinal, statement, tier, result, detail)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL)`,
      );
      for (const [ordinal, criterion] of input.criteria.entries()) {
        insertCriterion.run(input.target.runId, criterion.id, ordinal, criterion.statement, criterion.tier);
      }
      this.#db
        .prepare(
          `INSERT INTO gate_recoveries
             (source_run_id, client_request_id, payload_sha256, target_run_id, ticket_sha256,
              suite_sha256, state, protocol_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?)`,
        )
        .run(
          input.sourceRunId,
          input.clientRequestId,
          input.payloadSha256,
          input.target.runId,
          input.ticketSha256,
          input.suiteSha256,
          input.createdAt,
          input.createdAt,
        );
      const recovery = this.gateRecovery(input.sourceRunId, input.clientRequestId);
      if (recovery === null) throw new Error("gate recovery vanished after insert");
      this.appendEvent(input.target.runId, { type: "phase", phase: "gate" });
      this.appendEvent(input.target.runId, {
        type: "log",
        level: "info",
        text:
          `gate-only recovery child of ${input.sourceRunId}; copied recovery-time snapshot only. ` +
          "No builder, fixer, model, critic, Context7, judge, adversary, or publisher is allowed on this run.",
      });
      this.appendEvent(input.target.runId, { type: "status", status: "running" });
      this.#db.exec("COMMIT");
      return { kind: "created", recovery, target };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Recovery-specific terminal commit. Files are written before this call;
   * every child-owned DB surface and the lineage terminal state move together.
   * The terminal status event is appended last.
   */
  finalizeGateRecovery(input: GateRecoveryFinalize): RunRow {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const recovery = this.gateRecoveryForTarget(input.targetRunId);
      if (recovery === null || recovery.state !== "finalizing") {
        throw new BakeoffError(
          "invalid_usage_shape",
          `gate recovery ${input.targetRunId} is not ready to finalize`,
          "Only the recovery controller that owns finalizing may commit a terminal child.",
        );
      }
      for (const criterion of input.criteria) {
        this.setCriterionResult(input.targetRunId, criterion.criterionId, criterion.result, criterion.detail);
        this.appendEvent(input.targetRunId, {
          type: "criterion",
          id: criterion.criterionId,
          result: criterion.result,
        });
      }
      for (const shot of input.screenshots) {
        this.addScreenshot(input.targetRunId, shot);
        this.appendEvent(input.targetRunId, { type: "screenshot", path: shot.path, label: shot.label });
      }
      this.appendEvent(input.targetRunId, {
        type: "log",
        level: input.state === "completed" ? "info" : "error",
        text: input.state === "completed"
          ? "gate-only recovery finished; Taste Critic was not run because this path makes no model calls"
          : `gate-only recovery ended with no held-out verdict: ${input.failureReason ?? "no error recorded"}`,
      });
      if (input.verdictPath !== null) {
        this.appendEvent(input.targetRunId, {
          type: "verdict",
          verdictPath: input.verdictPath,
          inferredCriteria: 0,
        });
      }
      const target = this.updateRun(input.targetRunId, {
        status: input.status,
        phase: "done",
        queuePosition: null,
        endedAt: input.endedAt,
        heldOutPass: input.heldOutPass,
        falseFinish: input.falseFinish,
        failureReason: input.failureReason,
        ...(input.verdictPath === null ? {} : { verdictPath: input.verdictPath }),
        gateStopReason: input.gateStopReason,
      });
      const changed = this.transitionGateRecovery(input.targetRunId, "finalizing", input.state, input.endedAt, {
        completedAt: input.endedAt,
        terminalError: input.failureReason,
      });
      if (changed === null) throw new Error("gate recovery terminal transition lost its finalizing claim");
      // LAST: clients reacting to terminal status already observe every surface above.
      this.appendEvent(input.targetRunId, { type: "status", status: input.status });
      this.#db.exec("COMMIT");
      return target;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): RunRow | null {
    const row = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(runId);
    return row === undefined ? null : toRunRow(row);
  }

  /**
   * Replace a run's brief and the identity derived from it — the PLAN PHASE'S one
   * write, and the only write in this file that may change a ticket id.
   *
   * NOT THREE NEW FIELDS ON {@link RunPatch}. That type's comment — "the fields a
   * caller may change after creation; everything else is frozen" — is load-bearing,
   * and widening it to the ticket columns is exactly how a caller two months from
   * now mutates a ticket AFTER its suite is frozen with nothing to stop it. A
   * separate method can carry the guard, and does:
   *
   * IT REFUSES ONCE `suite_sha256` IS SET, OR ONCE THE RUN IS TERMINAL. The
   * acceptance suite is written to `acceptance/<ticketId>/` and a run is bound to
   * it by that column; amending the brief afterwards would leave the row naming a
   * suite it was not graded against, and the next `#execute` entry would miss
   * `assertSuiteIntact` and author a SECOND suite on the owner's quota — the exact
   * failure `ticket.ts` documents for the wrong read-back function. The plan phase
   * runs before `#specPhase`, so this refusal never fires in the ordinary path;
   * that is what makes it a check on the ordering rather than a comment about it.
   *
   * THE CALLER MUST PASS THE DIGEST OF THE STRING IT IS STORING, and that is why
   * this method does not redact. `createRun` redacts the text on the way in while
   * taking a `ticketSha256` computed upstream, which is why the orchestrator has
   * a mismatch `warn` at all. Here the two must agree exactly: the next
   * `#execute` entry re-derives the id from `ticket_text` as stored, so a digest
   * taken over the unredacted brief would name a ticket nothing can compute
   * again. The orchestrator redacts, derives from the redacted string, and passes
   * all three; `plan-phase.test.ts` amends and then re-derives from the stored row
   * to check it.
   *
   * `ticket_title` IS NOT TOUCHED. It comes from the owner's prose
   * (`titleFromBrief(references.prose)`), and the exchange is appended after it —
   * his answers are not a new headline for his run.
   */
  amendBrief(
    runId: string,
    amendment: { readonly ticketText: string; readonly ticketId: string; readonly ticketSha256: string },
  ): RunRow {
    const row = this.getRun(runId);
    if (row === null) {
      throw new BakeoffError("invalid_usage_shape", `run ${runId} does not exist`, "Check the run id.");
    }
    if (row.suiteSha256 !== null) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `run ${runId} is already bound to suite ${row.suiteSha256}, so its ticket can no longer change`,
        "A brief may only be amended before the acceptance suite is authored and frozen.",
      );
    }
    if (isTerminal(row.status)) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `run ${runId} is ${row.status}, so its ticket can no longer change`,
        "Start a new run with the revised brief instead.",
      );
    }
    this.#db
      .prepare("UPDATE runs SET ticket_text = ?, ticket_id = ?, ticket_sha256 = ?, updated_at = ? WHERE run_id = ?")
      .run(amendment.ticketText, amendment.ticketId, amendment.ticketSha256, new Date().toISOString(), runId);
    const updated = this.getRun(runId);
    if (updated === null) {
      throw new BakeoffError("invalid_usage_shape", `run ${runId} vanished during amendment`, "Retry.");
    }
    return updated;
  }

  listRuns(): readonly RunRow[] {
    const rows = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY started_at DESC, rowid DESC`).all();
    return rows.map(toRunRow);
  }

  /** Queued runs, oldest first — the order they will be executed in. */
  listQueued(): readonly RunRow[] {
    const rows = this.#db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM runs
         WHERE status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM gate_recoveries g WHERE g.target_run_id = runs.run_id)
         ORDER BY started_at ASC, rowid ASC`,
      )
      .all();
    return rows.map(toRunRow);
  }

  listByStatus(status: ApiRunStatus): readonly RunRow[] {
    const rows = this.#db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE status = ? ORDER BY started_at ASC`)
      .all(status);
    return rows.map(toRunRow);
  }

  updateRun(runId: string, patch: RunPatch): RunRow {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    const push = (column: string, value: SQLInputValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.status !== undefined) push("status", patch.status);
    if (patch.phase !== undefined) push("phase", patch.phase);
    if (patch.queuePosition !== undefined) push("queue_position", patch.queuePosition);
    if (patch.endedAt !== undefined) push("ended_at", patch.endedAt);
    if (patch.heldOutPass !== undefined) push("held_out_pass", flagOrNull(patch.heldOutPass));
    if (patch.falseFinish !== undefined) push("false_finish", flagOrNull(patch.falseFinish));
    if (patch.agentDeclaredDone !== undefined) push("agent_declared_done", flag(patch.agentDeclaredDone));
    if (patch.tokens !== undefined) {
      const t = patch.tokens;
      push("input_tokens", t === null ? null : t.inputTokens);
      push("output_tokens", t === null ? null : t.outputTokens);
      push("cache_read_tokens", t === null ? null : t.cacheReadTokens);
      push("cache_write_tokens", t === null ? null : t.cacheWriteTokens);
    }
    if (patch.rateLimited !== undefined) push("rate_limited", flag(patch.rateLimited));
    // NOT REDACTED, like `started_at` and `ended_at` above it: an ISO instant
    // this program generated has nothing in it to redact, and running it through
    // the redactor would cost a cast for a guaranteed no-op.
    if (patch.rateLimitedAt !== undefined) push("rate_limited_at", patch.rateLimitedAt);
    if (patch.rateLimitRetryAfterSec !== undefined) {
      push("rate_limit_retry_after_sec", patch.rateLimitRetryAfterSec);
    }
    if (patch.rateLimitKind !== undefined) {
      push("rate_limit_kind", patch.rateLimitKind === null ? null : redactForPersistence(patch.rateLimitKind));
    }
    if (patch.artifactPath !== undefined) {
      push("artifact_path", patch.artifactPath === null ? null : redactForPersistence(patch.artifactPath));
    }
    if (patch.previewUrl !== undefined) {
      push("preview_url", patch.previewUrl === null ? null : redactForPersistence(patch.previewUrl));
    }
    // A suite digest is a digest. Redacting it would corrupt the one value the
    // tamper check compares against.
    if (patch.suiteSha256 !== undefined) push("suite_sha256", patch.suiteSha256);
    if (patch.builderSessionId !== undefined) push("builder_session_id", patch.builderSessionId);
    if (patch.resumeCount !== undefined) push("resume_count", patch.resumeCount);
    if (patch.failureReason !== undefined) {
      push("failure_reason", patch.failureReason === null ? null : redactForPersistence(patch.failureReason));
    }
    if (patch.inferredCriteria !== undefined) push("inferred_criteria", patch.inferredCriteria);
    if (patch.verdictPath !== undefined) push("verdict_path", redactForPersistence(patch.verdictPath));
    if (patch.designSegmentDone !== undefined) push("design_segment_done", flag(patch.designSegmentDone));
    if (patch.gateAttempts !== undefined) push("gate_attempts", patch.gateAttempts);
    // NOT REDACTED, AND IT CANNOT USEFULLY BE: this is one of five short enum
    // literals or null, exactly like `design_lock` above. `redactForPersistence`
    // on a word like "not-converging" is a no-op that would still cost a cast on
    // the way in and a widened type on the way out.
    if (patch.gateStopReason !== undefined) push("gate_stop_reason", patch.gateStopReason);
    if (patch.autoContinueCount !== undefined) push("auto_continue_count", patch.autoContinueCount);
    // NOT REDACTED, on `gate_stop_reason`'s reasoning: this is one of six short
    // enum literals from `recovery.ts` or null, and running a word like
    // "throttled" through the redactor is a no-op that costs a cast.
    if (patch.recoveryClass !== undefined) push("recovery_class", patch.recoveryClass);

    push("updated_at", new Date().toISOString());
    values.push(runId);
    this.#db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...values);

    const updated = this.getRun(runId);
    if (updated === null) {
      throw new BakeoffError("invalid_usage_shape", `run ${runId} does not exist`, "Check the run id.");
    }
    return updated;
  }

  /**
   * Terminal transition guard for the interactive creative pilot.
   *
   * The pending-message check and the row transition share one IMMEDIATE
   * transaction, so a message insert cannot land in the gap between "none
   * pending" and a terminal status. The loser waits, then observes either a
   * queued source it can steer or a terminal source it must continue under a
   * new identity.
   */
  finishUnlessOwnerMessagePending(
    runId: string,
    terminalPatch: RunPatch,
  ): { readonly row: RunRow; readonly requeued: boolean } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.#db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE run_id = ? AND role = 'owner' AND delivered_at IS NULL")
        .get(runId);
      const count = pending === undefined ? 0 : num(pending, "count");
      const row = count > 0
        ? this.updateRun(runId, { status: "queued", queuePosition: null, endedAt: null })
        : this.updateRun(runId, terminalPatch);
      this.#db.exec("COMMIT");
      return { row, requeued: count > 0 };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /* ---- the attempt ledger -------------------------------------------- */

  /**
   * Open an attempt row for an entry into `#execute`, and return it.
   *
   * THE NUMBER IS ALLOCATED INSIDE THE SAME SYNCHRONOUS BLOCK AS THE INSERT, on
   * `appendEvent`'s precedent: two entries in the same tick cannot collide on
   * the primary key.
   *
   * `waitedSec` IS COMPUTED FROM THE PREVIOUS ATTEMPT'S `ended_at` and not from
   * a timer, because the wait a run actually served is wall-clock time that
   * includes a server that was down for it. A timer that was never armed still
   * produces a real wait here, which is the number the owner cares about.
   */
  openAttempt(runId: string, startedAt: string, phase: string): RunAttempt {
    const previous = this.#db
      .prepare("SELECT attempt_no, ended_at FROM run_attempts WHERE run_id = ? ORDER BY attempt_no DESC LIMIT 1")
      .get(runId);
    const attemptNo = previous === undefined ? 1 : num(previous, "attempt_no") + 1;
    const previousEnd = previous === undefined ? null : strOrNull(previous, "ended_at");
    const gap = previousEnd === null ? Number.NaN : Date.parse(startedAt) - Date.parse(previousEnd);
    // FLOORED AT ZERO, exactly as the recovery module floors its own elapsed: a
    // clock that moved backwards must not report a negative wait, and an
    // unparseable pair reports NOTHING rather than a zero that reads as "no
    // wait was served".
    const waitedSec = Number.isFinite(gap) ? Math.max(0, Math.round(gap / 1000)) : null;
    this.#db
      .prepare(
        "INSERT INTO run_attempts (run_id, attempt_no, started_at, ended_at, phase_reached, end_class, " +
          "end_detail, waited_sec, suite_source) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, NULL)",
      )
      .run(runId, attemptNo, startedAt, phase, waitedSec);
    return {
      runId,
      attemptNo,
      startedAt,
      endedAt: null,
      phaseReached: phase,
      endClass: null,
      endDetail: null,
      waitedSec,
      suiteSource: null,
    };
  }

  /**
   * Close the newest OPEN attempt for a run. A no-op when there is none.
   *
   * IT TARGETS THE OPEN ONE RATHER THAN THE NEWEST, and the difference is the
   * whole point: the orchestrator has several ends per entry (three `#finish`
   * sites, the rate-limit park, the plan park, the design park, cancel), and a
   * second close on an already-closed attempt would overwrite a real ending
   * with a later, less specific one. Closing is therefore idempotent in the
   * direction that keeps the FIRST answer.
   */
  closeAttempt(
    runId: string,
    end: {
      readonly endedAt: string;
      readonly endClass: string;
      readonly endDetail: string | null;
      readonly phaseReached?: string;
      readonly suiteSource?: string | null;
    },
  ): void {
    const open = this.#db
      .prepare("SELECT attempt_no FROM run_attempts WHERE run_id = ? AND ended_at IS NULL ORDER BY attempt_no DESC LIMIT 1")
      .get(runId);
    if (open === undefined) return;
    const sets = ["ended_at = ?", "end_class = ?", "end_detail = ?"];
    const values: SQLInputValue[] = [
      end.endedAt,
      end.endClass,
      end.endDetail === null ? null : redactForPersistence(end.endDetail),
    ];
    if (end.phaseReached !== undefined) {
      sets.push("phase_reached = ?");
      values.push(end.phaseReached);
    }
    if (end.suiteSource !== undefined) {
      sets.push("suite_source = ?");
      values.push(end.suiteSource);
    }
    values.push(runId, num(open, "attempt_no"));
    this.#db
      .prepare(`UPDATE run_attempts SET ${sets.join(", ")} WHERE run_id = ? AND attempt_no = ?`)
      .run(...values);
  }

  /** Record which branch of `#specPhase` the OPEN attempt took. */
  noteAttemptSuiteSource(runId: string, source: string): void {
    this.#db
      .prepare(
        "UPDATE run_attempts SET suite_source = ? WHERE run_id = ? AND ended_at IS NULL AND suite_source IS NULL",
      )
      .run(source, runId);
  }

  listAttempts(runId: string): readonly RunAttempt[] {
    return this.#db
      .prepare("SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_no")
      .all(runId)
      .map((row) => ({
        runId: str(row, "run_id"),
        attemptNo: num(row, "attempt_no"),
        startedAt: str(row, "started_at"),
        endedAt: strOrNull(row, "ended_at"),
        phaseReached: str(row, "phase_reached"),
        endClass: strOrNull(row, "end_class"),
        endDetail: strOrNull(row, "end_detail"),
        waitedSec: numOrNull(row, "waited_sec"),
        suiteSource: strOrNull(row, "suite_source"),
      }));
  }

  /* ---- events ------------------------------------------------------- */

  /**
   * Append one event and return it with its sequence number.
   *
   * The seq is allocated INSIDE the same synchronous block as the insert, so
   * two events appended in the same tick cannot collide. It is the ordering
   * key SSE replay depends on: a client that connects late replays rows up to
   * a watermark, then resumes the live stream from `seq > watermark`.
   */
  appendEvent(runId: string, event: SseEvent): StoredEvent {
    const safe = redactForPersistence(event);
    const at = new Date().toISOString();
    const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?").get(runId);
    const seq = (row === undefined ? 0 : num(row, "m")) + 1;
    this.#db
      .prepare("INSERT INTO events (run_id, seq, at, payload) VALUES (?, ?, ?, ?)")
      .run(runId, seq, at, JSON.stringify(safe));
    return { seq, at, event: safe };
  }

  /**
   * Record one chat message. `seq` is allocated in the same synchronous block that
   * inserts, exactly as `appendEvent` does, so messages are totally ordered.
   */
  appendMessage(
    runId: string,
    message: { role: ChatRole; text: string; images: readonly string[] },
  ): ChatMessage {
    const at = new Date().toISOString();
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE run_id = ?")
      .get(runId);
    const seq = (row === undefined ? 0 : num(row, "m")) + 1;
    /*
     * REDACTED LIKE ANY OTHER PERSISTED TEXT. An owner typing a redirection may
     * paste a key into it — that is exactly the mistake `secret-intake.ts` exists to
     * prevent elsewhere — and this text is written to SQLite AND folded into a
     * subprocess prompt. Running it through the same redactor the event stream uses
     * means a pasted token cannot reach either.
     */
    const safe = redactForPersistence({ type: "log", level: "info", text: message.text });
    const text = safe.type === "log" ? safe.text : message.text;
    this.#db
      .prepare(
        "INSERT INTO messages (run_id, seq, at, role, text, images, delivered_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(runId, seq, at, message.role, text, message.images.join("\n"));
    return { seq, at, role: message.role, text, images: [...message.images], deliveredAt: null };
  }

  /**
   * Insert one owner message and its replay key in the same transaction.
   * Reusing a key with different bytes is a conflict, never a second message.
   */
  beginMessageRequest(input: {
    readonly runId: string;
    readonly clientMessageId: string;
    readonly payloadSha256: string;
    readonly intent: MessageIntent;
    readonly text: string;
    readonly images: readonly string[];
    readonly documents: readonly string[];
  }): BeginMessageRequest {
    const existing = this.messageRequest(input.runId, input.clientMessageId);
    if (existing !== null) {
      return {
        kind: existing.payloadSha256 === input.payloadSha256 ? "replay" : "conflict",
        receipt: existing,
      };
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // A second process may have inserted after the optimistic read.
      const raced = this.messageRequest(input.runId, input.clientMessageId);
      if (raced !== null) {
        this.#db.exec("COMMIT");
        return {
          kind: raced.payloadSha256 === input.payloadSha256 ? "replay" : "conflict",
          receipt: raced,
        };
      }
      const message = this.appendMessage(input.runId, {
        role: "owner",
        text: input.text,
        images: input.images,
      });
      this.#db
        .prepare(
          `INSERT INTO message_requests
             (run_id, client_message_id, payload_sha256, message_seq, intent, documents, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.clientMessageId,
          input.payloadSha256,
          message.seq,
          input.intent,
          input.documents.join("\n"),
          new Date().toISOString(),
        );
      this.#db.exec("COMMIT");
      return {
        kind: "created",
        receipt: {
          clientMessageId: input.clientMessageId,
          payloadSha256: input.payloadSha256,
          intent: input.intent,
          message,
          documents: [...input.documents],
          disposition: null,
          targetRunId: null,
        },
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  messageRequest(runId: string, clientMessageId: string): MessageRequestReceipt | null {
    const row = this.#db
      .prepare(
        `SELECT client_message_id, payload_sha256, message_seq, intent, documents,
                disposition, target_run_id
           FROM message_requests WHERE run_id = ? AND client_message_id = ?`,
      )
      .get(runId, clientMessageId);
    if (row === undefined) return null;
    const messageSeq = num(row, "message_seq");
    const message = this.messages(runId).find((entry) => entry.seq === messageSeq);
    if (message === undefined) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `message request ${clientMessageId} on ${runId} points to absent message ${String(messageSeq)}`,
        "Restore the messages row or remove the orphaned idempotency receipt.",
      );
    }
    const rawDisposition = strOrNull(row, "disposition");
    const dispositions: readonly Exclude<MessageDisposition, "refused">[] = [
      "delivered_live",
      "queued_boundary",
      "plan_reply",
      "design_request",
      "continuation_created",
    ];
    return {
      clientMessageId: str(row, "client_message_id"),
      payloadSha256: str(row, "payload_sha256"),
      intent: oneOf(["send", "steer"] as const, str(row, "intent"), "message intent"),
      message,
      documents: str(row, "documents") === "" ? [] : str(row, "documents").split("\n"),
      disposition:
        rawDisposition === null ? null : oneOf(dispositions, rawDisposition, "message disposition"),
      targetRunId: strOrNull(row, "target_run_id"),
    };
  }

  completeMessageRequest(
    runId: string,
    clientMessageId: string,
    disposition: Exclude<MessageDisposition, "refused">,
    targetRunId: string,
  ): MessageRequestReceipt {
    this.#db
      .prepare(
        `UPDATE message_requests SET disposition = ?, target_run_id = ?
          WHERE run_id = ? AND client_message_id = ? AND disposition IS NULL`,
      )
      .run(disposition, targetRunId, runId, clientMessageId);
    const receipt = this.messageRequest(runId, clientMessageId);
    if (receipt === null) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `message request ${clientMessageId} on ${runId} vanished before completion`,
        "Retry the message.",
      );
    }
    return receipt;
  }

  continuationFor(sourceRunId: string, ownerMessageSeq: number): RunContinuation | null {
    const row = this.#db
      .prepare(
        `SELECT source_run_id, owner_message_seq, target_run_id, created_at
           FROM run_continuations WHERE source_run_id = ? AND owner_message_seq = ?`,
      )
      .get(sourceRunId, ownerMessageSeq);
    return row === undefined
      ? null
      : {
          sourceRunId: str(row, "source_run_id"),
          ownerMessageSeq: num(row, "owner_message_seq"),
          targetRunId: str(row, "target_run_id"),
          createdAt: str(row, "created_at"),
        };
  }

  /** Atomically create a new run and bind it to a terminal owner message. */
  createContinuationRun(
    sourceRunId: string,
    ownerMessageSeq: number,
    run: NewRun,
  ): { readonly continuation: RunContinuation; readonly run: RunRow; readonly created: boolean } {
    const existing = this.continuationFor(sourceRunId, ownerMessageSeq);
    if (existing !== null) {
      const target = this.getRun(existing.targetRunId);
      if (target === null) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `continuation from ${sourceRunId} message ${String(ownerMessageSeq)} points to absent run ${existing.targetRunId}`,
          "Restore the target run or remove the orphaned continuation link.",
        );
      }
      return { continuation: existing, run: target, created: false };
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.continuationFor(sourceRunId, ownerMessageSeq);
      if (raced !== null) {
        const target = this.getRun(raced.targetRunId);
        if (target === null) throw new Error(`continuation target ${raced.targetRunId} is absent`);
        this.#db.exec("COMMIT");
        return { continuation: raced, run: target, created: false };
      }
      const target = this.createRun(run);
      const createdAt = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO run_continuations (source_run_id, owner_message_seq, target_run_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sourceRunId, ownerMessageSeq, target.runId, createdAt);
      this.#db.exec("COMMIT");
      return {
        continuation: { sourceRunId, ownerMessageSeq, targetRunId: target.runId, createdAt },
        run: target,
        created: true,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Every message on a run, oldest first. What the chat panel renders.
   *
   * MODEL ANNOTATION MARKUP IS STRIPPED FROM `run` ROWS HERE, ON THE WAY OUT.
   * The stored text is left exactly as the run said it — `message-markup.ts`
   * argues at length why the transcript stays verbatim on disk and why the
   * already-leaked row is repaired by reading rather than by a migration. The
   * gate is `role === "run"` and that is load-bearing, not tidiness: OWNER rows
   * come back out of this same method through `pendingMessages` below and are
   * folded into the next segment's prompt, so an owner who writes "<cite>" must
   * have it reach the model byte for byte.
   */
  messages(runId: string): readonly ChatMessage[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, at, role, text, images, delivered_at FROM messages WHERE run_id = ? ORDER BY seq ASC",
      )
      .all(runId);
    return rows.map((row) => {
      const role: ChatRole = str(row, "role") === "run" ? "run" : "owner";
      const stored = str(row, "text");
      return {
        seq: num(row, "seq"),
        at: str(row, "at"),
        role,
        text: role === "run" ? stripAnnotationMarkup(stored) : stored,
        images: str(row, "images") === "" ? [] : str(row, "images").split("\n"),
        deliveredAt: row["delivered_at"] === null ? null : str(row, "delivered_at"),
      };
    });
  }

  /**
   * Owner messages the run has not folded into a prompt yet, oldest first.
   *
   * `role = 'owner'` matters: a message the RUN wrote is already in its own context
   * and re-injecting it would have the orchestrator answering itself.
   */
  pendingMessages(runId: string): readonly ChatMessage[] {
    return this.messages(runId).filter(
      (message) => message.role === "owner" && message.deliveredAt === null,
    );
  }

  /**
   * Stamp messages as taken up. Called by the run AFTER they are in a prompt, never
   * before — a crash between the two must lose the stamp, not the instruction.
   */
  markMessagesDelivered(runId: string, seqs: readonly number[]): void {
    if (seqs.length === 0) return;
    const at = new Date().toISOString();
    const update = this.#db.prepare(
      "UPDATE messages SET delivered_at = ? WHERE run_id = ? AND seq = ? AND delivered_at IS NULL",
    );
    for (const seq of seqs) update.run(at, runId, seq);
  }

  /**
   * Acknowledge one message handed to the live SDK and close its replay receipt
   * in the same transaction. Queue acceptance alone is not delivery.
   */
  markLiveMessageDelivered(runId: string, seq: number): void {
    const at = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "UPDATE messages SET delivered_at = ? WHERE run_id = ? AND seq = ? AND delivered_at IS NULL",
        )
        .run(at, runId, seq);
      this.#db
        .prepare(
          `UPDATE message_requests SET disposition = 'delivered_live', target_run_id = ?
            WHERE run_id = ? AND message_seq = ? AND disposition IS NULL`,
        )
        .run(runId, runId, seq);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * How many OWNER messages this run actually took up at or after `since`.
   *
   * WHAT IT IS FOR: deciding whether a segment has anything to reply TO. The reply
   * producer (`AgentReplyWatch` in owner-message.ts) stores the agent's last
   * message of a segment only when this is non-zero, so an ordinary run — where
   * the owner said nothing — puts no build narration in the chat, and a run that
   * was spoken to gets an answer.
   *
   * IT COUNTS DELIVERY, NOT ARRIVAL, AND THAT IS WHY IT COVERS BOTH PATHS. There
   * are two ways a message reaches a live run and they land at different moments:
   * the boundary drain stamps a batch as the next prompt is composed
   * (`orchestrator.ts`), and `postMessage` stamps a single message the instant it
   * pushes it into the running session (`http.ts`). Both write `delivered_at`, so
   * one query over that column sees both, with no cross-module signal to forget.
   * A message that arrived and was never taken up is correctly NOT counted: there
   * is nothing for the agent to have answered.
   *
   * `since` IS COMPARED AS TEXT, which is chronological only because every stamp
   * in this store is `new Date().toISOString()` — fixed width, UTC, `Z`-suffixed.
   * A caller passing any other spelling of an instant gets a comparison that is
   * silently wrong rather than an error.
   *
   * IT IS DURABLE STATE, NOT MEMORY, so a segment that resumes after a restart
   * still sees what it was told.
   */
  ownerMessagesDeliveredSince(runId: string, since: string): number {
    return this.messages(runId).filter(
      (message) =>
        message.role === "owner" && message.deliveredAt !== null && message.deliveredAt >= since,
    ).length;
  }

  /**
   * The instant of the newest event on this run's stream that the SILENCE WATCH
   * did not write itself. `null` when the run has no such event at all.
   *
   * WHY THE EXCLUSION EXISTS, AND WHY IT IS THE WHOLE POINT OF THIS METHOD.
   * `RunEventBus.emit` PERSISTS before it delivers (bus.ts), so the watch's own
   * warning is an event on the very stream it is measuring. Without the filter
   * the first warning would reset the clock it just read: the run would report
   * "quiet for 90 minutes", then "quiet for 0 minutes" one tick later, and a
   * second minute of silence could never be reported however long the build
   * stayed dead. That is the can't-fail shape this repository keeps finding, so
   * the filter is here, in the one query both the watch and `toDetail` read
   * through, rather than in either caller.
   *
   * IT COUNTS EVERY OTHER EVENT, INCLUDING ONES THE SERVER WROTE ABOUT THE RUN,
   * AND THAT IS MEASURED RATHER THAN PREFERRED. Restricting this to the event
   * types the build pipeline produces (`tool`, `graph_*`, `tokens`, …) was tried
   * against the one finished run on this machine and made the signal WORSE: the
   * largest legitimate quiet gap grew from 43.5 min to 79.5 min, because during
   * that stretch the run was speaking through `log` and `rate_limit` events and
   * nothing else. So "we have heard something" means any row on the stream.
   *
   * THE ONE GAP THAT LEAVES, STATED BECAUSE IT IS REACHABLE TODAY. `postMessage`
   * in http.ts emits a `log` line when the owner types into a run, so an owner
   * message RESETS this clock — precisely the run an owner is most likely to be
   * typing into is the one that has gone quiet. Closing it needs a marker in a
   * file this change does not own; `stall-watch.test.ts` pins the behaviour as it
   * stands so a future fix has to update the test that documents it rather than
   * discovering the gap again.
   *
   * `NOT LIKE` WITH NO `ESCAPE` CLAUSE IS SAFE ONLY WHILE THE PREFIX HAS NO `%`
   * OR `_`, which {@link SILENCE_NOTICE_PREFIX} asserts of itself in its own
   * test. An underscore added to that sentence would silently widen this filter
   * to match one extra character in every position.
   */
  lastRunEventAt(runId: string): string | null {
    const row = this.#db
      .prepare(
        "SELECT at FROM events WHERE run_id = ? AND payload NOT LIKE ? ORDER BY seq DESC LIMIT 1",
      )
      .get(runId, `%${SILENCE_NOTICE_PREFIX}%`);
    return row === undefined ? null : str(row, "at");
  }

  /** Persisted events with `seq > after`, oldest first. */
  eventsSince(runId: string, after: number): readonly StoredEvent[] {
    const rows = this.#db
      .prepare("SELECT seq, at, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
      .all(runId, after);
    return rows.map((row) => ({
      seq: num(row, "seq"),
      at: str(row, "at"),
      event: JSON.parse(str(row, "payload")) as SseEvent,
    }));
  }

  latestSeq(runId: string): number {
    const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?").get(runId);
    return row === undefined ? 0 : num(row, "m");
  }

  /* ---- criteria ----------------------------------------------------- */

  /** Replace the criterion set for a run. Called once when the suite freezes. */
  putCriteria(runId: string, criteria: readonly ApiCriterion[]): void {
    const insert = this.#db.prepare(
      `INSERT INTO criteria (run_id, criterion_id, ordinal, statement, tier, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (run_id, criterion_id) DO UPDATE SET
         ordinal = excluded.ordinal, statement = excluded.statement, tier = excluded.tier`,
    );
    let ordinal = 0;
    for (const criterion of criteria) {
      const safe = redactForPersistence({ id: criterion.id, statement: criterion.statement });
      insert.run(runId, safe.id, ordinal, safe.statement, criterion.tier, criterion.result);
      ordinal += 1;
    }
  }

  setCriterionResult(runId: string, criterionId: string, result: ApiCriterionResult, detail: string | null): void {
    this.#db
      .prepare("UPDATE criteria SET result = ?, detail = ? WHERE run_id = ? AND criterion_id = ?")
      .run(result, detail === null ? null : redactForPersistence(detail), runId, criterionId);
  }

  listCriteria(runId: string): readonly ApiCriterion[] {
    const rows = this.#db
      .prepare("SELECT criterion_id, statement, tier, result FROM criteria WHERE run_id = ? ORDER BY ordinal ASC")
      .all(runId);
    return rows.map((row) => ({
      id: str(row, "criterion_id"),
      statement: str(row, "statement"),
      tier: oneOf(TIERS, str(row, "tier"), "criterion tier"),
      result: oneOf(CRITERION_RESULTS, str(row, "result"), "criterion result"),
    }));
  }

  /* ---- screenshots -------------------------------------------------- */

  addScreenshot(runId: string, shot: ApiScreenshot): void {
    const safe = redactForPersistence({ path: shot.path, label: shot.label });
    this.#db
      .prepare(
        `INSERT INTO screenshots (run_id, path, label, captured_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id, path) DO UPDATE SET label = excluded.label`,
      )
      .run(runId, safe.path, safe.label, shot.capturedAt);
  }

  listScreenshots(runId: string): readonly ApiScreenshot[] {
    const rows = this.#db
      .prepare("SELECT path, label, captured_at FROM screenshots WHERE run_id = ? ORDER BY captured_at ASC")
      .all(runId);
    return rows.map((row) => ({
      path: str(row, "path"),
      label: str(row, "label"),
      capturedAt: str(row, "captured_at"),
    }));
  }

  /* ---- spend, attributed by seat ------------------------------------ */

  /**
   * Add one seat's spend to what this run has already recorded for that seat.
   *
   * IT ADDS. IT DOES NOT ASSIGN, AND THE DIFFERENCE IS THE DEFECT THIS TABLE
   * EXISTS TO CLOSE. Every seat here reports more than once — the builder is two
   * `builder.build()` calls against one session, the GATE/FIX loop runs a round
   * per attempt, and `mergeTokenTotals`'s docblock records what assignment did to
   * the run row: a design segment that spent 1000 followed by a build segment
   * reporting 10 left the run claiming 10. `ON CONFLICT DO UPDATE SET x = x +
   * excluded.x` puts that arithmetic in the one place a caller cannot skip.
   *
   * SO CALL IT ONCE PER COMPLETED CALL OR ROUND, FROM THE RETURNED OUTCOME — AND
   * NEVER FROM A `BuildEventSink.tokens` CALLBACK. That callback fires repeatedly
   * with a total that is already cumulative WITHIN the call (`claude-builder.ts`
   * builds it with `addTokens(running, …)`, which is why orchestrator.ts:1003
   * captures `carried` BEFORE the segment rather than re-reading the row), so
   * ADDING from it records T1 + (T1+T2) + (T1+T2+T3) and inflates the run by a
   * multiple — the mirror image of the defect this table closes, and the harder one
   * to notice, because that number only ever looks too big. The right sources are
   * `outcome.tokens` after `builder.build()` RETURNS (the `builder` seat, once per
   * segment; the `fix` seat, once per round — orchestrator.ts:1101 and :1643),
   * `caller.tokens` after `assertUnused()` (the `spec` and `audit` seats, whose
   * `SubscriptionSeatCaller` totals are already cumulative across that seat's own
   * calls — subscription-caller.ts:312 — which is exactly why orchestrator.ts:679
   * and :680 log them once), and `report.tokens` from the judge at :1952.
   *
   * THE KEY IS (run, seat, provider, model) AND EVERY PART OF IT IS LOAD-BEARING.
   * Seat, because the attribution is the point. Provider, because a run whose
   * builder is OpenAI still has three Anthropic seats and their counts must never
   * meet. Model, because a seat whose model changed mid-run — a resumed run
   * against a different `DASHBOARD_SPEC_MODEL` — spent on two models and one row
   * would label all of it with whichever was written last.
   *
   * `ordinal` IS FIRST-SEEN ORDER AND IT IS A COLUMN RATHER THAN THE PRIMARY
   * KEY'S ORDER BECAUSE THE PRIMARY KEY IS ALPHABETICAL. A `WITHOUT ROWID` table
   * scans in key order, which would list `audit` before `spec` — reversing the
   * only two seats whose order a reader can check against the log — and `builder`
   * before `fix`, which is right by luck rather than by construction. The
   * conflict path deliberately does NOT touch it: a seat keeps the position it
   * first appeared in, however many times it reports.
   */
  recordSeatSpend(runId: string, entry: SeatContribution): ApiSeatSpend {
    const row = toSeatSpend(entry);
    // ONE redaction call, matching `createRun`: `modelId` is redacted there and
    // is redacted here. `seat`, `provider` and `kind` are short enum literals —
    // `redactForPersistence` on one is a no-op that would still cost a cast on
    // the way in and a widened type on the way out, exactly as `design_lock` and
    // `gate_stop_reason` argue above.
    const safeModelId = redactForPersistence(row.modelId);
    const now = new Date().toISOString();
    const seen = this.#db
      .prepare("SELECT COALESCE(MAX(ordinal), 0) AS m FROM seat_spend WHERE run_id = ?")
      .get(runId);
    const ordinal = (seen === undefined ? 0 : num(seen, "m")) + 1;
    this.#db
      .prepare(
        `INSERT INTO seat_spend (run_id, seat, provider, model_id, ordinal, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, call_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, seat, provider, model_id) DO UPDATE SET
           input_tokens       = seat_spend.input_tokens       + excluded.input_tokens,
           output_tokens      = seat_spend.output_tokens      + excluded.output_tokens,
           cache_read_tokens  = seat_spend.cache_read_tokens  + excluded.cache_read_tokens,
           cache_write_tokens = seat_spend.cache_write_tokens + excluded.cache_write_tokens,
           call_count         = seat_spend.call_count         + excluded.call_count,
           updated_at         = excluded.updated_at`,
      )
      .run(
        runId,
        row.seat,
        row.provider,
        safeModelId,
        ordinal,
        row.tokens.inputTokens,
        row.tokens.outputTokens,
        row.tokens.cacheReadTokens,
        row.tokens.cacheWriteTokens,
        row.callCount,
        now,
      );
    const stored = this.#seatSpendRow(runId, row.seat, row.provider, safeModelId);
    if (stored === null) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `seat spend for ${runId}/${row.seat} vanished after insert`,
        "Retry.",
      );
    }
    return stored;
  }

  #seatSpendRow(
    runId: string,
    seat: ApiSpendSeat,
    provider: ApiProvider,
    modelId: string,
  ): ApiSeatSpend | null {
    const row = this.#db
      .prepare(
        `SELECT seat, provider, model_id, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, call_count
         FROM seat_spend WHERE run_id = ? AND seat = ? AND provider = ? AND model_id = ?`,
      )
      .get(runId, seat, provider, modelId);
    return row === undefined ? null : toSeatSpendRow(row);
  }

  /**
   * Add one metered image/video contribution.
   *
   * SAME ADDITION, DIFFERENT UNITS. `calls` is attempts including retries — the
   * count that makes a zero-image lane say "after 3 generation attempts" rather
   * than "after 0", which are two sentences about completely different faults
   * (design-outcome.ts). `delivered_seconds_floor` sums the same way, and
   * NULL + NULL STAYS NULL: an image call is not a duration, and turning that
   * into `0` would report "zero seconds of video" for a run that generated no
   * video at all — a measurement where there was none.
   */
  recordMeteredSpend(runId: string, entry: ApiMeteredSpend): ApiMeteredSpend {
    const safeModel = redactForPersistence(entry.model);
    const now = new Date().toISOString();
    const seen = this.#db
      .prepare("SELECT COALESCE(MAX(ordinal), 0) AS m FROM metered_spend WHERE run_id = ?")
      .get(runId);
    const ordinal = (seen === undefined ? 0 : num(seen, "m")) + 1;
    this.#db
      .prepare(
        `INSERT INTO metered_spend (run_id, kind, model, ordinal, calls, delivered_seconds_floor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, kind, model) DO UPDATE SET
           calls = metered_spend.calls + excluded.calls,
           delivered_seconds_floor =
             CASE
               WHEN metered_spend.delivered_seconds_floor IS NULL
                 AND excluded.delivered_seconds_floor IS NULL THEN NULL
               ELSE COALESCE(metered_spend.delivered_seconds_floor, 0)
                  + COALESCE(excluded.delivered_seconds_floor, 0)
             END,
           updated_at = excluded.updated_at`,
      )
      .run(runId, entry.kind, safeModel, ordinal, entry.calls, entry.deliveredSecondsFloor, now);
    const row = this.#db
      .prepare(
        `SELECT kind, model, calls, delivered_seconds_floor FROM metered_spend
         WHERE run_id = ? AND kind = ? AND model = ?`,
      )
      .get(runId, entry.kind, safeModel);
    if (row === undefined) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `metered spend for ${runId}/${entry.kind} vanished after insert`,
        "Retry.",
      );
    }
    return toMeteredSpendRow(row);
  }

  /** Seat rows in the order the run acquired them. Empty means NOTHING RECORDED. */
  listSeatSpend(runId: string): readonly ApiSeatSpend[] {
    const rows = this.#db
      .prepare(
        `SELECT seat, provider, model_id, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, call_count
         FROM seat_spend WHERE run_id = ? ORDER BY ordinal ASC`,
      )
      .all(runId);
    return rows.map(toSeatSpendRow);
  }

  listMeteredSpend(runId: string): readonly ApiMeteredSpend[] {
    const rows = this.#db
      .prepare(
        `SELECT kind, model, calls, delivered_seconds_floor FROM metered_spend
         WHERE run_id = ? ORDER BY ordinal ASC`,
      )
      .all(runId);
    return rows.map(toMeteredSpendRow);
  }

  /**
   * EVERYTHING THIS RUN SPENT, per seat and per vendor.
   *
   * The per-vendor totals are derived by `tokens.ts#runSpend` on every read and
   * are stored nowhere, so they cannot disagree with the rows they total. A run
   * with no recorded seats returns empty lists and the `pricing` literal — which
   * is "nothing was recorded", not "this run was free"; `ApiRunSpend`'s docblock
   * is where that distinction is written down.
   */
  runSpend(runId: string): ApiRunSpend {
    return runSpend(this.listSeatSpend(runId), this.listMeteredSpend(runId));
  }

  /* ---- the supervisor ------------------------------------------------ */

  /**
   * What the owner last asked for. A database with no row reports
   * {@link SUPERVISOR_STATE_SEED} — stopped — rather than throwing or guessing.
   */
  readSupervisorState(): SupervisorState {
    const row = this.#db.prepare(`SELECT * FROM supervisor_state WHERE id = 1`).get() as Row | undefined;
    if (row === undefined) return SUPERVISOR_STATE_SEED;
    return {
      desired: oneOf(SUPERVISOR_DESIRED, str(row, "desired"), "supervisor desired state"),
      changedAt: str(row, "changed_at"),
      changedBy: str(row, "changed_by"),
      reason: str(row, "reason"),
    };
  }

  /**
   * Move the switch, and say who and why.
   *
   * THE BLANK-REASON THROW IS NOT DEFENSIVE PROGRAMMING. Every transition here
   * is something the owner will later ask about — "why did it stop at 03:00" —
   * and a row that answers `''` is the signature defect wearing a state
   * machine. The schema cannot enforce non-empty, so the writer does.
   */
  setSupervisorState(desired: SupervisorDesired, changedBy: string, reason: string): SupervisorState {
    if (reason.trim() === "") throw new Error("a supervisor state change needs a reason; '' is not one");
    if (changedBy.trim() === "") throw new Error("a supervisor state change needs an author; '' is not one");
    const at = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO supervisor_state (id, desired, changed_at, changed_by, reason)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET desired = excluded.desired, changed_at = excluded.changed_at,
           changed_by = excluded.changed_by, reason = excluded.reason`,
      )
      .run(desired, at, changedBy, reason);
    return { desired, changedAt: at, changedBy, reason };
  }

  /**
   * File a ticket for the supervisor to run.
   *
   * `INSERT OR IGNORE`-free on purpose: a duplicate key is a caller bug worth a
   * throw, not a silently dropped brief.
   */
  enqueueSupervisorTicket(input: NewSupervisorTicket): SupervisorTicket {
    if (input.nextAction.trim() === "") {
      throw new Error("a supervisor ticket needs a nextAction sentence; '' is not one");
    }
    // The brief is owner-authored and persisted, so it takes the same redaction
    // pass `createRun` gives `ticketText`.
    const safe = redactForPersistence({ ticketText: input.ticketText, nextAction: input.nextAction });
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO supervisor_tickets (ticket_key, ticket_text, model_id, design_lock, state,
           attempt_no, max_attempts, class_counts, repair_counts, enqueued_at, updated_at, next_action)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, '{}', '{}', ?, ?, ?)`,
      )
      .run(
        input.ticketKey,
        safe.ticketText,
        input.modelId,
        input.designLock ?? "auto",
        input.maxAttempts ?? 3,
        now,
        now,
        safe.nextAction,
      );
    const ticket = this.getSupervisorTicket(input.ticketKey);
    if (ticket === null) throw new Error(`supervisor ticket ${input.ticketKey} vanished immediately after insert`);
    return ticket;
  }

  /**
   * The per-signature repair-cycle counter, as stored JSON.
   *
   * ITS OWN READER because it is not on {@link SupervisorTicket} — see the note
   * where the field is deliberately absent. Returns '{}' for a ticket that does
   * not exist, which is the same answer as a ticket that has had no cycle: this
   * value only ever gates whether ANOTHER cycle may start, and there is no cycle
   * to start for a row that is gone.
   */
  readSupervisorRepairCounts(ticketKey: string): string {
    const row = this.#db.prepare(`SELECT repair_counts FROM supervisor_tickets WHERE ticket_key = ?`).get(ticketKey) as
      | Row
      | undefined;
    return row === undefined ? "{}" : str(row, "repair_counts");
  }

  getSupervisorTicket(ticketKey: string): SupervisorTicket | null {
    const row = this.#db.prepare(`SELECT * FROM supervisor_tickets WHERE ticket_key = ?`).get(ticketKey) as
      | Row
      | undefined;
    return row === undefined ? null : toSupervisorTicket(row);
  }

  /** Oldest first, so the queue is a queue. */
  listSupervisorTickets(states?: readonly SupervisorTicketState[]): readonly SupervisorTicket[] {
    const rows =
      states === undefined
        ? (this.#db.prepare(`SELECT * FROM supervisor_tickets ORDER BY enqueued_at ASC`).all() as Row[])
        : (this.#db
            .prepare(
              `SELECT * FROM supervisor_tickets WHERE state IN (${states.map(() => "?").join(",")})
               ORDER BY enqueued_at ASC`,
            )
            .all(...states) as Row[]);
    return rows.map(toSupervisorTicket);
  }

  /**
   * The conditional claim, and the boolean is the whole contract.
   *
   * `WHERE state = 'queued'` plus `changes() === 1` is what makes a double tick
   * (the 30 s interval and the `#finish` hook landing together) unable to claim
   * the same ticket twice. A read-then-write would race even on one thread,
   * because the read and the write are two statements with an `await` between
   * them in every real caller.
   */
  claimSupervisorTicket(ticketKey: string, nextAction: string): boolean {
    if (nextAction.trim() === "") throw new Error("a claim needs a nextAction sentence; '' is not one");
    const result = this.#db
      .prepare(
        `UPDATE supervisor_tickets SET state = 'claimed', updated_at = ?, next_action = ?
         WHERE ticket_key = ? AND state = 'queued'`,
      )
      .run(new Date().toISOString(), nextAction, ticketKey);
    return Number(result.changes) === 1;
  }

  updateSupervisorTicket(ticketKey: string, patch: SupervisorTicketPatch): SupervisorTicket {
    if (patch.nextAction !== undefined && patch.nextAction.trim() === "") {
      throw new Error("a supervisor ticket cannot be patched to a blank nextAction");
    }
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [new Date().toISOString()];
    const put = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.attemptNo !== undefined) put("attempt_no", patch.attemptNo);
    if (patch.classCounts !== undefined) put("class_counts", patch.classCounts);
    if (patch.repairCounts !== undefined) put("repair_counts", patch.repairCounts);
    if (patch.currentRunId !== undefined) put("current_run_id", patch.currentRunId);
    if (patch.lastRunId !== undefined) put("last_run_id", patch.lastRunId);
    if (patch.lastClass !== undefined) put("last_class", patch.lastClass);
    if (patch.lastDefectId !== undefined) put("last_defect_id", patch.lastDefectId);
    if (patch.patchId !== undefined) put("patch_id", patch.patchId);
    if (patch.nextAction !== undefined) put("next_action", patch.nextAction);
    if (patch.nextActionAt !== undefined) put("next_action_at", patch.nextActionAt);
    values.push(ticketKey);
    this.#db.prepare(`UPDATE supervisor_tickets SET ${sets.join(", ")} WHERE ticket_key = ?`).run(...values);
    const ticket = this.getSupervisorTicket(ticketKey);
    if (ticket === null) throw new Error(`supervisor ticket ${ticketKey} is absent`);
    return ticket;
  }

  logSupervisorDecision(entry: {
    readonly ticketKey: string | null;
    readonly runId: string | null;
    readonly decision: string;
    readonly reason: string;
  }): SupervisorLogEntry {
    if (entry.reason.trim() === "") throw new Error(`supervisor decision '${entry.decision}' was logged with no reason`);
    const at = new Date().toISOString();
    const result = this.#db
      .prepare(`INSERT INTO supervisor_log (at, ticket_key, run_id, decision, reason) VALUES (?, ?, ?, ?, ?)`)
      .run(at, entry.ticketKey, entry.runId, entry.decision, entry.reason);
    return { seq: Number(result.lastInsertRowid), at, ...entry };
  }

  /** Newest first — the journal is read from its end. */
  listSupervisorLog(limit = 50): readonly SupervisorLogEntry[] {
    const rows = this.#db
      .prepare(`SELECT * FROM supervisor_log ORDER BY seq DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((row) => ({
      seq: num(row, "seq"),
      at: str(row, "at"),
      ticketKey: strOrNull(row, "ticket_key"),
      runId: strOrNull(row, "run_id"),
      decision: str(row, "decision"),
      reason: str(row, "reason"),
    }));
  }
}

function toSupervisorTicket(row: Row): SupervisorTicket {
  return {
    ticketKey: str(row, "ticket_key"),
    ticketText: str(row, "ticket_text"),
    modelId: str(row, "model_id"),
    designLock: str(row, "design_lock"),
    state: oneOf(SUPERVISOR_TICKET_STATES, str(row, "state"), "supervisor ticket state"),
    attemptNo: num(row, "attempt_no"),
    maxAttempts: num(row, "max_attempts"),
    classCounts: str(row, "class_counts"),
    currentRunId: strOrNull(row, "current_run_id"),
    lastRunId: strOrNull(row, "last_run_id"),
    lastClass: strOrNull(row, "last_class"),
    lastDefectId: strOrNull(row, "last_defect_id"),
    patchId: strOrNull(row, "patch_id"),
    enqueuedAt: str(row, "enqueued_at"),
    updatedAt: str(row, "updated_at"),
    nextAction: str(row, "next_action"),
    nextActionAt: strOrNull(row, "next_action_at"),
  };
}

function toSeatSpendRow(row: Row): ApiSeatSpend {
  return {
    seat: oneOf(SPEND_SEATS, str(row, "seat"), "spend seat"),
    provider: oneOf(PROVIDERS, str(row, "provider"), "provider"),
    modelId: str(row, "model_id"),
    // NOT the all-or-nothing treatment `toRunRow` gives the run row's tokens:
    // every column here is `NOT NULL`, so a partially reported set cannot exist
    // to be misread. `num` throws if one is ever absent, which would mean the
    // schema and this reader had diverged rather than that a count was unknown.
    tokens: {
      inputTokens: num(row, "input_tokens"),
      outputTokens: num(row, "output_tokens"),
      cacheReadTokens: num(row, "cache_read_tokens"),
      cacheWriteTokens: num(row, "cache_write_tokens"),
    },
    callCount: num(row, "call_count"),
  };
}

function toMeteredSpendRow(row: Row): ApiMeteredSpend {
  return {
    kind: oneOf(METERED_KINDS, str(row, "kind"), "metered spend kind"),
    model: str(row, "model"),
    calls: num(row, "calls"),
    // `numOrNull`, and the null is the field's meaning rather than a missing
    // value: an image call is billed per call and has no duration at all.
    deliveredSecondsFloor: numOrNull(row, "delivered_seconds_floor"),
  };
}

function toGateRecoveryRow(row: Row): GateRecoveryRow {
  return {
    sourceRunId: str(row, "source_run_id"),
    clientRequestId: str(row, "client_request_id"),
    payloadSha256: str(row, "payload_sha256"),
    targetRunId: str(row, "target_run_id"),
    sourceArtifactSha256: strOrNull(row, "source_artifact_sha256"),
    targetArtifactSha256: strOrNull(row, "target_artifact_sha256"),
    ticketSha256: str(row, "ticket_sha256"),
    suiteSha256: str(row, "suite_sha256"),
    state: oneOf(GATE_RECOVERY_STATES, str(row, "state"), "gate recovery state"),
    protocolVersion: num(row, "protocol_version"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    scoringStartedAt: strOrNull(row, "scoring_started_at"),
    completedAt: strOrNull(row, "completed_at"),
    terminalError: strOrNull(row, "terminal_error"),
  };
}

function toRunRow(row: Row): RunRow {
  const input = numOrNull(row, "input_tokens");
  const output = numOrNull(row, "output_tokens");
  const cacheRead = numOrNull(row, "cache_read_tokens");
  const cacheWrite = numOrNull(row, "cache_write_tokens");
  // Tokens are all-or-nothing: a partially reported set would present an
  // unreported field as 0, which contracts.ts refuses to do everywhere else.
  const tokens: ApiTokens | null =
    input === null || output === null || cacheRead === null || cacheWrite === null
      ? null
      : { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };

  return {
    runId: str(row, "run_id"),
    ticketId: str(row, "ticket_id"),
    ticketTitle: str(row, "ticket_title"),
    ticketText: str(row, "ticket_text"),
    ticketSha256: str(row, "ticket_sha256"),
    modelId: str(row, "model_id"),
    provider: oneOf(PROVIDERS, str(row, "provider"), "provider"),
    deploy: bool(row, "deploy"),
    status: oneOf(RUN_STATUSES, str(row, "status"), "run status"),
    phase: oneOf(PHASES, str(row, "phase"), "phase"),
    queuePosition: numOrNull(row, "queue_position"),
    startedAt: str(row, "started_at"),
    endedAt: strOrNull(row, "ended_at"),
    heldOutPass: boolOrNull(row, "held_out_pass"),
    falseFinish: boolOrNull(row, "false_finish"),
    agentDeclaredDone: bool(row, "agent_declared_done"),
    tokens,
    rateLimited: bool(row, "rate_limited"),
    rateLimitedAt: strOrNull(row, "rate_limited_at"),
    rateLimitRetryAfterSec: numOrNull(row, "rate_limit_retry_after_sec"),
    rateLimitKind: strOrNull(row, "rate_limit_kind"),
    artifactPath: strOrNull(row, "artifact_path"),
    previewUrl: strOrNull(row, "preview_url"),
    suiteSha256: strOrNull(row, "suite_sha256"),
    builderSessionId: strOrNull(row, "builder_session_id"),
    resumeCount: num(row, "resume_count"),
    failureReason: strOrNull(row, "failure_reason"),
    inferredCriteria: num(row, "inferred_criteria"),
    verdictPath: str(row, "verdict_path"),
    designSegmentDone: bool(row, "design_segment_done"),
    designLock: str(row, "design_lock"),
    interactive: bool(row, "interactive"),
    gateAttempts: num(row, "gate_attempts"),
    // `strOrNull`, not `oneOf`: see the import of `StopReason` at the top. An
    // unrecognised word reads through and renders oddly; a guard here would
    // throw and take every run in the list with it.
    gateStopReason: strOrNull(row, "gate_stop_reason"),
    autoContinueCount: num(row, "auto_continue_count"),
    // `strOrNull`, not `oneOf`, on `gate_stop_reason`'s reasoning: a class word
    // written by a future version reads through and renders oddly, where a guard
    // would throw and take every run in the list with it.
    recoveryClass: strOrNull(row, "recovery_class"),
    updatedAt: str(row, "updated_at"),
  };
}
