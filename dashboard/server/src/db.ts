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
import type {
  ApiCriterion,
  ApiCriterionResult,
  ApiCriterionTier,
  ApiMeteredSpend,
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

/** Who wrote a chat message. `run` is the orchestrator, `owner` is the human. */
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
   */
  readonly deliveredAt: string | null;
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
const PHASES: readonly ApiPhase[] = ["spec", "build", "gate", "judge", "done"];
// "moonshot" and "deepseek" left this list on 2026-07-30 with the model rows the
// owner removed. Nothing in this store can hold either: `POST /api/runs` refused
// every metered id with 409 for as long as they existed, so no run row was ever
// written with one, and `seat_spend.provider` comes from `TokenTotals`, whose
// vendor is only ever "anthropic" or "openai".
const PROVIDERS: readonly ApiProvider[] = ["anthropic", "openai"];
const TIERS: readonly ApiCriterionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];
const CRITERION_RESULTS: readonly ApiCriterionResult[] = ["pass", "fail", "pending"];
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
];

function migrateRuns(db: DatabaseSync): void {
  const present = new Set(
    db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((row) => str(row, "name")),
  );
  for (const column of ADDED_RUN_COLUMNS) {
    if (!present.has(column.name)) db.exec(column.ddl);
  }
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
        "spec" satisfies ApiPhase,
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

  getRun(runId: string): RunRow | null {
    const row = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(runId);
    return row === undefined ? null : toRunRow(row);
  }

  listRuns(): readonly RunRow[] {
    const rows = this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY started_at DESC, rowid DESC`).all();
    return rows.map(toRunRow);
  }

  /** Queued runs, oldest first — the order they will be executed in. */
  listQueued(): readonly RunRow[] {
    const rows = this.#db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'queued' ORDER BY started_at ASC, rowid ASC`)
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

    push("updated_at", new Date().toISOString());
    values.push(runId);
    this.#db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...values);

    const updated = this.getRun(runId);
    if (updated === null) {
      throw new BakeoffError("invalid_usage_shape", `run ${runId} does not exist`, "Check the run id.");
    }
    return updated;
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

  /** Every message on a run, oldest first. What the chat panel renders. */
  messages(runId: string): readonly ChatMessage[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, at, role, text, images, delivered_at FROM messages WHERE run_id = ? ORDER BY seq ASC",
      )
      .all(runId);
    return rows.map((row) => ({
      seq: num(row, "seq"),
      at: str(row, "at"),
      role: str(row, "role") === "run" ? "run" : "owner",
      text: str(row, "text"),
      images: str(row, "images") === "" ? [] : str(row, "images").split("\n"),
      deliveredAt: row["delivered_at"] === null ? null : str(row, "delivered_at"),
    }));
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
    updatedAt: str(row, "updated_at"),
  };
}
