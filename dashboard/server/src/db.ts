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
import type {
  ApiCriterion,
  ApiCriterionResult,
  ApiCriterionTier,
  ApiPhase,
  ApiProvider,
  ApiRunStatus,
  ApiScreenshot,
  ApiTokens,
  SseEvent,
} from "./api-types.js";

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
const PROVIDERS: readonly ApiProvider[] = ["anthropic", "openai", "moonshot", "deepseek"];
const TIERS: readonly ApiCriterionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];
const CRITERION_RESULTS: readonly ApiCriterionResult[] = ["pass", "fail", "pending"];

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
    updatedAt: str(row, "updated_at"),
  };
}
