/**
 * ledger.ts — OUT-OF-PROCESS SPEND CONTROL.
 *
 * This is the module that stops the bake-off costing more than it is budgeted
 * to cost. Everything else in the harness can be rebuilt from the research
 * documents; an uncapped runaway loop cannot be un-spent. doc 03 section 7.8:
 * Anthropic's Start tier is a $500/month cap after which "API usage pauses
 * until the next month", and at $85-124/ticket one runaway loop exhausts a
 * month.
 *
 * FIVE PROPERTIES, ALL LOAD-BEARING:
 *
 *  1. THE CEILING IS CHECKED BEFORE THE CALL, NEVER AFTER. {@link RunLedger.precall}
 *     is evaluated against the WORST-CASE cost of the request about to be
 *     dispatched. Checking afterwards lets the ceiling be exceeded by one
 *     arbitrarily expensive call.
 *
 *  2. IT IS OUT OF PROCESS RELATIVE TO THE AGENT. The ledger runs in the
 *     supervising process. The agent cannot see it, cannot write to it and
 *     cannot disable it. Vendor task-budget parameters — Claude Code's
 *     `--max-budget-usd`, Anthropic's `task_budget` beta — are recorded as
 *     {@link VendorAdvisoryBudget} and never trusted: Anthropic's own docs say
 *     "Claude may occasionally exceed the budget if it is in the middle of an
 *     action", and Moonshot and DeepSeek have no budget primitive at all.
 *
 *  3. TERMINATION HAPPENS ON A BOUNDARY, NEVER ON A GUESS. Dollars, tokens,
 *     wall clock, or a human. There is no stuck-detector, no idle timeout, no
 *     no-progress heuristic, and none may be added: Long-Horizon Terminal-Bench
 *     measured 79% of unresolved runs timing out WHILE STILL ACTIVELY MAKING
 *     PROGRESS (doc 03 section 8.1). Note that doc 04 section 9.4 does
 *     recommend an out-of-process loop detector — that advice is for the
 *     PRODUCT, where killing a doomed run saves money. It is wrong for this
 *     MEASUREMENT harness, where a heuristic kill silently deflates the
 *     held-out pass rate of whichever configuration happens to work slowly.
 *     doc 03 section 7.8 governs here.
 *
 *  4. TOKENS ARE NEVER SUMMED ACROSS VENDORS. Rows are kept per
 *     (provider, modelId, role). The only cross-vendor aggregate is dollars.
 *     The per-vendor output-token ceiling is per vendor for the same reason.
 *
 *  5. NOTHING IS HELD IN MEMORY THAT MATTERS. Every event is appended to disk
 *     synchronously as it happens, and campaign spend is recomputed FROM DISK,
 *     so a ceiling survives a crash, a resume, and concurrent runs in separate
 *     processes.
 *
 * Every string written by this module passes through the redaction chokepoint.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  BakeoffError,
  sumCostUsd,
  vendorCacheHitFraction,
} from "./contracts.js";
import type {
  BudgetPolicy,
  HeldConstants,
  KillReason,
  LedgerEvent,
  ModelSeat,
  PreCallDecision,
  Provider,
  RunStatus,
  VendorUsage,
} from "./contracts.js";
import { adapterFor, mergeVendorUsage } from "./adapters.js";
import { DEFAULT_KNOWN_ENV_NAMES, redactForPersistence } from "./redact.js";
import type { RedactOptions } from "./redact.js";

/* -------------------------------------------------------------------------
 * Persistence policy
 * ---------------------------------------------------------------------- */

/**
 * NAME of the environment variable holding the per-run token that authenticates
 * the sandbox to the budget proxy.
 *
 * It lives here, in the module that owns persistence, because its VALUE is a
 * secret that must be scrubbed from every artefact this harness writes — and
 * the redaction policy below is the one place that list is assembled. The value
 * is generated per run, exists only in the supervisor's environment and in the
 * sandbox's, and is never written to disk.
 */
export const PROXY_AUTH_TOKEN_ENV_NAME = "BAKEOFF_PROXY_TOKEN";

/** Redaction settings for everything this harness persists. */
export const PERSIST_REDACT_OPTIONS: RedactOptions = Object.freeze({
  knownEnvNames: Object.freeze([
    ...DEFAULT_KNOWN_ENV_NAMES,
    PROXY_AUTH_TOKEN_ENV_NAME,
  ]) as readonly string[],
});

function appendJsonLine(path: string, value: unknown): void {
  const redacted = redactForPersistence(value, PERSIST_REDACT_OPTIONS);
  appendFileSync(path, `${JSON.stringify(redacted)}\n`, { encoding: "utf8" });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/* -------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------- */

/**
 * Where the ledger writes.
 *
 * NOTHING HERE MAY BE INSIDE A BUILDER-VISIBLE MOUNT. `.bakeoff/ledger/` is on
 * {@link BUILDER_FORBIDDEN_PATH_PREFIXES} because a naive implementation would
 * put it in the workspace; this one does not put it there at all. A builder
 * that can read the ledger learns its own budget, and a builder that can write
 * it can buy itself more.
 */
export interface LedgerLayout {
  /** Shared across every run in the campaign. */
  readonly campaignDir: string;
  /** Per-run contract-shaped {@link LedgerEvent} stream. */
  readonly runEventsPath: string;
  /** Per-call instrumentation stream (doc 04 section 9.1). */
  readonly runCallsPath: string;
  /** Per-run alert stream (doc 04 section 9.2). */
  readonly runAlertsPath: string;
  /** Campaign-wide append-only spend log, read back for the campaign ceiling. */
  readonly campaignSpendPath: string;
  /** The kill sentinel. Its presence halts every run in every process. */
  readonly sentinelPath: string;
}

/**
 * FILE EXTENSIONS ARE LOad-BEARING HERE.
 *
 * The reporter collects every `*.jsonl` file under the results tree and
 * classifies each line as a run record, a score record, a visible result or a
 * ledger event; anything else is counted and surfaced as an unrecognised line.
 * The contract-shaped {@link LedgerEvent} stream is therefore `.jsonl`, and the
 * two harness-internal streams — per-call instrumentation and alerts, neither
 * of which the reporter consumes — are `.ndjson`. Same format, different name,
 * so a run's several thousand call records do not arrive in the report as
 * several thousand unrecognised lines.
 */
export function ledgerLayout(campaignDir: string, runResultsDir: string): LedgerLayout {
  return {
    campaignDir,
    runEventsPath: join(runResultsDir, "ledger.jsonl"),
    runCallsPath: join(runResultsDir, "calls.ndjson"),
    runAlertsPath: join(runResultsDir, "alerts.ndjson"),
    campaignSpendPath: join(campaignDir, "campaign-spend.ndjson"),
    sentinelPath: join(campaignDir, "KILL"),
  };
}

/* -------------------------------------------------------------------------
 * Kill switch
 * ---------------------------------------------------------------------- */

/** A kill, with the boundary that caused it. Never a heuristic. */
export interface KillSignal {
  readonly reason: KillReason;
  readonly detail: string;
  /** ISO-8601 instant. */
  readonly at: string;
  readonly source: "sentinel" | "signal" | "local";
}

const KILL_REASONS: readonly KillReason[] = [
  "cost_ceiling_usd",
  "campaign_cost_ceiling_usd",
  "wall_clock_ceiling",
  "vendor_output_token_ceiling",
  "operator_abort",
  "infrastructure_failure",
  "credential_failure",
];

function parseKillSentinel(raw: string): KillSignal {
  const fallback: KillSignal = {
    reason: "operator_abort",
    detail: "kill sentinel present with no machine-readable body",
    at: new Date().toISOString(),
    source: "sentinel",
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return fallback;
    const record = parsed as Record<string, unknown>;
    const reason = record["reason"];
    if (typeof reason !== "string" || !KILL_REASONS.includes(reason as KillReason)) return fallback;
    return {
      reason: reason as KillReason,
      detail: typeof record["detail"] === "string" ? record["detail"] : "",
      at: typeof record["at"] === "string" ? record["at"] : fallback.at,
      source: "sentinel",
    };
  } catch {
    return fallback;
  }
}

/**
 * THE GLOBAL KILL SWITCH: a sentinel file plus SIGTERM/SIGINT handlers.
 *
 * The sentinel is a FILE because the campaign spans processes: a second
 * harness process, a supervisor on another terminal, or an operator with
 * nothing but a shell must all be able to halt every in-flight run. Writing
 * `results/ledger/KILL` is that mechanism, and it needs no running process to
 * cooperate.
 *
 * Signals set the same sentinel so that a Ctrl-C in one terminal stops runs in
 * every other. A run halted this way ends cleanly with a recorded status — it
 * does not crash, and it does not lose its ledger.
 */
export class KillSwitch {
  readonly #sentinelPath: string;
  #local: KillSignal | null = null;
  #installed = false;
  #handler: ((signal: NodeJS.Signals) => void) | null = null;
  /** Cache so precall does not stat the sentinel on a hot path more than needed. */
  #lastSentinelCheckMs = 0;
  #cachedSentinel: KillSignal | null = null;

  constructor(sentinelPath: string) {
    this.#sentinelPath = sentinelPath;
    ensureDir(dirname(sentinelPath));
  }

  get sentinelPath(): string {
    return this.#sentinelPath;
  }

  /**
   * Engage the switch. Writes the sentinel so other processes see it, and
   * records the reason so a human abort is never mistaken for a budget event.
   */
  engage(reason: KillReason, detail: string): KillSignal {
    const signal: KillSignal = {
      reason,
      detail,
      at: new Date().toISOString(),
      source: this.#local === null ? "local" : this.#local.source,
    };
    if (this.#local === null) this.#local = signal;
    try {
      writeFileSync(
        this.#sentinelPath,
        `${JSON.stringify(redactForPersistence({ reason, detail, at: signal.at }, PERSIST_REDACT_OPTIONS))}\n`,
        { encoding: "utf8" },
      );
    } catch {
      // A sentinel we cannot write still kills THIS process via #local. Losing
      // the cross-process signal is degraded, not fatal, and must not throw on
      // the shutdown path.
    }
    this.#cachedSentinel = signal;
    this.#lastSentinelCheckMs = Date.now();
    return signal;
  }

  /** Non-null when this run must stop. Checks memory first, then the sentinel. */
  engaged(): KillSignal | null {
    if (this.#local !== null) return this.#local;
    const now = Date.now();
    if (now - this.#lastSentinelCheckMs < SENTINEL_POLL_MS && this.#cachedSentinel !== null) {
      return this.#cachedSentinel;
    }
    this.#lastSentinelCheckMs = now;
    try {
      if (!existsSync(this.#sentinelPath)) {
        this.#cachedSentinel = null;
        return null;
      }
      this.#cachedSentinel = parseKillSentinel(readFileSync(this.#sentinelPath, "utf8"));
      return this.#cachedSentinel;
    } catch {
      this.#cachedSentinel = null;
      return null;
    }
  }

  /**
   * Install SIGINT/SIGTERM handlers.
   *
   * The first signal engages the switch and returns, letting the runner unwind
   * cleanly: stop the container, close the ledger, write the run record. A
   * SECOND signal exits immediately — an operator pressing Ctrl-C twice means
   * it, and refusing to die is its own failure mode.
   */
  installSignalHandlers(onEngage?: (signal: KillSignal) => void): void {
    if (this.#installed) return;
    this.#installed = true;
    let signalled = false;
    this.#handler = (name: NodeJS.Signals): void => {
      if (signalled) {
        process.exit(130);
      }
      signalled = true;
      const engaged = this.engage(
        "operator_abort",
        `received ${name}; halting in-flight runs on a boundary, not a heuristic`,
      );
      const withSource: KillSignal = { ...engaged, source: "signal" };
      this.#local = withSource;
      if (onEngage !== undefined) onEngage(withSource);
    };
    process.on("SIGINT", this.#handler);
    process.on("SIGTERM", this.#handler);
  }

  dispose(): void {
    if (this.#handler !== null) {
      process.removeListener("SIGINT", this.#handler);
      process.removeListener("SIGTERM", this.#handler);
      this.#handler = null;
    }
    this.#installed = false;
  }

  /**
   * Clear the sentinel. Only an operator starting a fresh campaign does this,
   * and only deliberately: the sentinel is what stops a campaign that has
   * already crossed a boundary from silently resuming.
   */
  static clear(sentinelPath: string): boolean {
    if (!existsSync(sentinelPath)) return false;
    rmSync(sentinelPath, { force: true });
    return true;
  }

  /** The recorded kill, or null. Readable without a live switch instance. */
  static read(sentinelPath: string): KillSignal | null {
    if (!existsSync(sentinelPath)) return null;
    return parseKillSentinel(readFileSync(sentinelPath, "utf8"));
  }
}

const SENTINEL_POLL_MS = 1000;

/**
 * Map a kill boundary to the run's terminal status.
 *
 * A wall-clock boundary is a TIMEOUT, not a budget event — 79% of unresolved
 * long-horizon runs are still making progress when they hit one, so the
 * distinction carries real information. Infrastructure and credential failures
 * are `error`: they are not model outcomes and must be excluded from the rate
 * denominators (doc 03 section 7.5). Everything else, including an operator
 * abort, is recorded as `budget_exceeded` per the harness specification — but
 * `killReason` preserves which it was, so an operator abort can be told apart
 * from a real ceiling in any later analysis.
 */
export function runStatusForKill(reason: KillReason): RunStatus {
  switch (reason) {
    case "wall_clock_ceiling":
      return "timeout";
    case "infrastructure_failure":
    case "credential_failure":
      return "error";
    case "cost_ceiling_usd":
    case "campaign_cost_ceiling_usd":
    case "vendor_output_token_ceiling":
    case "operator_abort":
      return "budget_exceeded";
    default:
      return "error";
  }
}

/* -------------------------------------------------------------------------
 * Campaign spend — recomputed from disk, across processes
 * ---------------------------------------------------------------------- */

/** One line of the campaign spend log. Dollars only; never tokens. */
interface CampaignSpendLine {
  readonly runId: string;
  readonly at: string;
  readonly costUsd: number;
}

/**
 * The campaign-wide spend total, read from disk.
 *
 * Append-only and read incrementally by byte offset, so the cost of a check is
 * proportional to what is new rather than to the campaign's whole history. A
 * torn final line (another process mid-append) is left unconsumed and re-read
 * next time rather than being parsed as truncated JSON.
 *
 * IT MUST BE READ FROM DISK, NOT HELD IN MEMORY. The $3,500 campaign ceiling
 * spans processes, resumes and concurrent runs; an in-memory total silently
 * becomes a per-process ceiling, which is not the ceiling that was budgeted.
 */
export class CampaignSpendLog {
  readonly #path: string;
  #offset = 0;
  #totalUsd = 0;

  constructor(path: string) {
    this.#path = path;
    ensureDir(dirname(path));
    if (!existsSync(path)) writeFileSync(path, "", { encoding: "utf8" });
  }

  get path(): string {
    return this.#path;
  }

  /** Append one spend line. Called once per recorded usage row. */
  append(line: CampaignSpendLine): void {
    appendFileSync(this.#path, `${JSON.stringify(line)}\n`, { encoding: "utf8" });
  }

  /** Total campaign spend in USD, including every other process's runs. */
  totalUsd(): number {
    let size: number;
    try {
      size = statSync(this.#path).size;
    } catch {
      return this.#totalUsd;
    }
    if (size < this.#offset) {
      // The file was truncated or replaced. Re-read from the beginning rather
      // than trusting a stale total: under-counting spend is the failure this
      // whole class exists to prevent.
      this.#offset = 0;
      this.#totalUsd = 0;
    }
    if (size === this.#offset) return this.#totalUsd;

    const fd = openSync(this.#path, "r");
    try {
      const length = size - this.#offset;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, this.#offset);
      const text = buffer.subarray(0, read).toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return this.#totalUsd;
      const complete = text.slice(0, lastNewline);
      this.#offset += Buffer.byteLength(complete, "utf8") + 1;
      for (const raw of complete.split("\n")) {
        if (raw.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(raw);
          const record = parsed as { costUsd?: unknown };
          if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd)) {
            this.#totalUsd += record.costUsd;
          }
        } catch {
          // An unparseable line is a corrupted append. Skipping it under-counts
          // spend, so it is surfaced rather than swallowed.
          throw new BakeoffError(
            "invalid_usage_shape",
            `campaign spend log ${this.#path} contains an unparseable line`,
            "Do not delete the line. Inspect it: a corrupted spend log means the campaign ceiling " +
              "is being enforced against an under-count. Reconstruct the total from the per-run " +
              "ledger.jsonl files (kind=usage_recorded) before resuming.",
          );
        }
      }
    } finally {
      closeSync(fd);
    }
    return this.#totalUsd;
  }
}

/* -------------------------------------------------------------------------
 * Per-call instrumentation (doc 04 section 9.1)
 * ---------------------------------------------------------------------- */

/**
 * One API call, fully tagged.
 *
 * doc 04 section 9.1 requires logging per call tagged
 * `{ticket_id, phase, agent_role, model, effort}`. The frozen
 * {@link LedgerEvent} union carries usage and cumulative cost but has no
 * `phase` member and cannot be extended, so this parallel stream carries the
 * full tag set. Both streams are written; neither is derived from the other.
 */
export interface CallRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly ticketId: string;
  readonly configId: string;
  readonly phase: string;
  readonly seatRole: string;
  readonly provider: Provider;
  readonly modelId: string;
  readonly effort: string;
  readonly usage: VendorUsage;
  readonly costUsd: number;
  /** Cumulative for this RUN, in dollars. Never a token total. */
  readonly cumulativeCostUsd: number;
  /** Cumulative for the CAMPAIGN, read from disk. */
  readonly campaignCostUsd: number;
  /**
   * Cache-hit token fraction for THIS CALL, per doc 04 section 3.4.
   * Null when no input tokens were billed at all.
   */
  readonly cacheHitFraction: number | null;
  /**
   * Wall-clock milliseconds since the previous call on this thread. doc 04
   * section 9.1 names it the only way to decide the 5m-vs-1h TTL question,
   * because only IDLE time expires a cache — turn count and run duration are
   * irrelevant. Null on the first call.
   */
  readonly msSincePreviousCall: number | null;
  /** HTTP status the upstream returned, or null when not applicable. */
  readonly httpStatus: number | null;
  /** True when the response was streamed (SSE). */
  readonly streamed: boolean;
}

/* -------------------------------------------------------------------------
 * Alerts (doc 04 section 9.2)
 * ---------------------------------------------------------------------- */

export type AlertKind =
  /**
   * BOTH cache usage fields were 0 across consecutive calls in one call class.
   * doc 04 section 3.4: "If both cache_creation_input_tokens and
   * cache_read_input_tokens are 0, the prompt was not cached at all, almost
   * certainly because it fell below the minimum cacheable length ... This is a
   * 10x price increase on that block, invisible in every log except these two
   * fields." Worth more than any other optimisation in the playbook.
   */
  | "cache_never_engaged"
  /** Measured hit fraction below threshold for a call class, after enough calls. */
  | "cache_hit_fraction_low"
  /** A usage payload could not be normalised. The call was spent but not costed. */
  | "usage_not_costed"
  /** The upstream served a different model from the one requested. */
  | "model_substitution"
  /** A pre-call check denied a request. Paired with a kill_issued event. */
  | "precall_denied";

export interface LedgerAlert {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly at: string;
  readonly kind: AlertKind;
  /** `provider|modelId|role` — the call class. Never averaged across classes. */
  readonly callClass: string;
  readonly detail: string;
  /** What the operator should do. Never contains a secret. */
  readonly remediation: string;
}

/**
 * Consecutive both-zero calls before the cache alert fires.
 *
 * Two, not one: the first call of a conversation legitimately writes the cache
 * (`cache_creation > 0`, `cache_read == 0`), and a single both-zero reading can
 * be a trivially short request. Two consecutive both-zero calls in the same
 * class is not a cold start.
 */
export const CACHE_ALERT_CONSECUTIVE_THRESHOLD = 2;

/** Calls in a class before its hit fraction is judged at all. */
export const CACHE_HIT_FRACTION_MIN_CALLS = 12;

/**
 * Hit-fraction alert threshold.
 *
 * A HARNESS CHOICE with no empirical basis, stated as such. doc 04 section 9
 * records that the widely-circulated 85% figure "circulates widely as a
 * convention with NO published empirical basis found in any lens", and that
 * measuring the real number is experiment 1 of 3. 0.5 is set low deliberately:
 * it is a smoke alarm for a broken cache, not a performance target.
 */
export const CACHE_HIT_FRACTION_ALERT_THRESHOLD = 0.5;

interface CallClassState {
  calls: number;
  consecutiveBothZero: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  alertedNeverEngaged: boolean;
  alertedLowHitFraction: boolean;
}

/* -------------------------------------------------------------------------
 * The run ledger
 * ---------------------------------------------------------------------- */

/** What the ledger needs to open a run. */
export interface RunLedgerOptions {
  readonly runId: string;
  readonly ticketId: string;
  readonly configId: string;
  readonly repeatIndex: number;
  readonly phase: string;
  readonly budget: BudgetPolicy;
  readonly heldConstants: HeldConstants;
  /** Per-run results directory. NEVER inside a builder-visible mount. */
  readonly runResultsDir: string;
  /** Shared campaign directory. Holds the sentinel and the spend log. */
  readonly campaignDir: string;
  /** ISO-8601. Also the instant prices are resolved at. */
  readonly startedAt: string;
  /** Shared switch, so one signal halts every concurrent run. */
  readonly killSwitch: KillSwitch;
  /** Monotonic clock source, injectable for tests. Defaults to Date.now. */
  readonly nowMs?: () => number;
}

/** A pre-call request. Everything needed to price the worst case. */
export interface PreCallRequest {
  readonly seat: ModelSeat;
  /** The request's `max_tokens`. Priced in full: the model may use all of it. */
  readonly plannedMaxOutputTokens: number;
  /** Deliberately over-estimated. See `estimatorBasis`. */
  readonly estimatedInputTokens: number;
  /**
   * How `estimatedInputTokens` was produced, e.g. "request-bytes/2". Recorded
   * so a kill that lands near a boundary can be audited: the estimator, not the
   * model, may have been what crossed the line.
   */
  readonly estimatorBasis: string;
}

/**
 * The per-run spend ledger.
 *
 * One writer per run. `seq` is monotonic and gap-free within a run; a gap in a
 * persisted ledger means the file was truncated, and that is worth noticing.
 */
export class RunLedger {
  readonly #options: RunLedgerOptions;
  readonly #layout: LedgerLayout;
  readonly #campaign: CampaignSpendLog;
  readonly #nowMs: () => number;
  readonly #startedAtMs: number;
  readonly #usage = new Map<string, VendorUsage>();
  readonly #classes = new Map<string, CallClassState>();
  readonly #outputTokensByProvider = new Map<Provider, number>();
  readonly #harnessErrors: string[] = [];

  #seq = 0;
  #warned = false;
  #closed = false;
  #kill: KillSignal | null = null;
  #lastCallAtMs: number | null = null;
  #agentDeclaredDone = false;
  #selfReportPath: string | null = null;
  #blockedReason: string | null = null;

  private constructor(options: RunLedgerOptions, layout: LedgerLayout) {
    this.#options = options;
    this.#layout = layout;
    this.#campaign = new CampaignSpendLog(layout.campaignSpendPath);
    this.#nowMs = options.nowMs ?? ((): number => Date.now());
    this.#startedAtMs = this.#nowMs();
  }

  /** Open a ledger and write the `run_started` event. */
  static open(options: RunLedgerOptions): RunLedger {
    ensureDir(options.runResultsDir);
    ensureDir(options.campaignDir);
    const layout = ledgerLayout(options.campaignDir, options.runResultsDir);
    const ledger = new RunLedger(options, layout);
    ledger.#emit({
      kind: "run_started",
      configId: options.configId,
      ticketId: options.ticketId,
      repeatIndex: options.repeatIndex,
      budget: options.budget,
      heldConstants: options.heldConstants,
    });
    return ledger;
  }

  get layout(): LedgerLayout {
    return this.#layout;
  }

  get runId(): string {
    return this.#options.runId;
  }

  /* ---------------------------------------------------------------------
   * The pre-call gate
   * ------------------------------------------------------------------ */

  /**
   * THE GATE. Called before the request leaves the harness — never after.
   *
   * Boundaries are checked in escalating order of blast radius: an engaged kill
   * switch, then the wall clock, then this vendor's output-token ceiling, then
   * the run's dollar ceiling, then the campaign's. Every denial records a
   * `precall_check` event and a `kill_issued` event, so the ledger shows both
   * the decision and its consequence.
   *
   * The worst case is priced by the seat's provider adapter: input at the
   * highest input-side rate and output at the FULL planned `max_tokens`.
   */
  precall(request: PreCallRequest): PreCallDecision {
    this.#assertOpen();
    const checkedAt = new Date().toISOString();
    const cumulativeCostUsd = this.totalCostUsd();
    const ceilingUsd = this.#options.budget.maxCostUsd;

    let worstCaseNextCallUsd: number;
    try {
      worstCaseNextCallUsd = adapterFor(request.seat.provider).worstCaseCallCostUsd(
        request.seat,
        request.plannedMaxOutputTokens,
        request.estimatedInputTokens,
        this.#options.startedAt,
      );
    } catch (error) {
      // An unpriceable call cannot be gated, so it is not dispatched. This is
      // the "running unpriced means running uncapped" rule, enforced at the
      // last possible moment rather than trusted to preflight alone.
      const detail = error instanceof BakeoffError ? error.message : String(error);
      return this.#deny(
        "credential_failure",
        checkedAt,
        cumulativeCostUsd,
        ceilingUsd,
        Number.POSITIVE_INFINITY,
        `cannot price the pending call: ${detail}`,
        request,
      );
    }

    const engaged = this.#killSwitchEngaged();
    if (engaged !== null) {
      return this.#deny(
        engaged.reason,
        checkedAt,
        cumulativeCostUsd,
        ceilingUsd,
        worstCaseNextCallUsd,
        `kill switch engaged (${engaged.source}): ${engaged.detail}`,
        request,
      );
    }

    const elapsedMs = this.#nowMs() - this.#startedAtMs;
    if (elapsedMs >= this.#options.budget.maxWallClockMs) {
      return this.#deny(
        "wall_clock_ceiling",
        checkedAt,
        cumulativeCostUsd,
        ceilingUsd,
        worstCaseNextCallUsd,
        `wall clock ${Math.round(elapsedMs / 1000)}s reached the ${Math.round(
          this.#options.budget.maxWallClockMs / 1000,
        )}s boundary. This is a BOUNDARY, not a judgement that the run was stuck: ` +
          "79% of unresolved long-horizon runs time out while still actively making progress.",
        request,
      );
    }

    const vendorCeiling = this.#options.budget.perVendorMaxOutputTokens;
    if (vendorCeiling !== null && vendorCeiling !== undefined) {
      const limit = vendorCeiling[request.seat.provider];
      if (limit !== undefined) {
        const used = this.#outputTokensByProvider.get(request.seat.provider) ?? 0;
        if (used + request.plannedMaxOutputTokens > limit) {
          return this.#deny(
            "vendor_output_token_ceiling",
            checkedAt,
            cumulativeCostUsd,
            ceilingUsd,
            worstCaseNextCallUsd,
            `${request.seat.provider} output tokens ${used} + planned ${request.plannedMaxOutputTokens} ` +
              `would exceed its ceiling of ${limit}. Per-vendor, never a cross-vendor total: ` +
              "tokenizers differ and the counts are not comparable.",
            request,
          );
        }
      }
    }

    if (cumulativeCostUsd + worstCaseNextCallUsd > ceilingUsd) {
      return this.#deny(
        "cost_ceiling_usd",
        checkedAt,
        cumulativeCostUsd,
        ceilingUsd,
        worstCaseNextCallUsd,
        `run spend $${cumulativeCostUsd.toFixed(4)} plus a worst case of ` +
          `$${worstCaseNextCallUsd.toFixed(4)} would exceed the hard per-run ceiling of ` +
          `$${ceilingUsd.toFixed(2)} (estimator: ${request.estimatorBasis})`,
        request,
      );
    }

    const campaignUsd = this.#campaign.totalUsd();
    const campaignCeiling = this.#options.budget.maxCampaignCostUsd;
    if (campaignUsd + worstCaseNextCallUsd > campaignCeiling) {
      return this.#deny(
        "campaign_cost_ceiling_usd",
        checkedAt,
        cumulativeCostUsd,
        ceilingUsd,
        worstCaseNextCallUsd,
        `campaign spend $${campaignUsd.toFixed(2)} plus a worst case of ` +
          `$${worstCaseNextCallUsd.toFixed(4)} would exceed the campaign ceiling of ` +
          `$${campaignCeiling.toFixed(2)}. A campaign ceiling reached mid-experiment leaves a ` +
          "partial matrix that must NOT be read as a result.",
        request,
      );
    }

    const decision: PreCallDecision = {
      allowed: true,
      killReason: null,
      cumulativeCostUsd,
      ceilingUsd,
      worstCaseNextCallUsd,
      checkedAt,
    };
    this.#emit({
      kind: "precall_check",
      provider: request.seat.provider,
      modelId: request.seat.modelId,
      decision,
    });
    this.#maybeWarn(cumulativeCostUsd, ceilingUsd);
    return decision;
  }

  #deny(
    reason: KillReason,
    checkedAt: string,
    cumulativeCostUsd: number,
    ceilingUsd: number,
    worstCaseNextCallUsd: number,
    detail: string,
    request: PreCallRequest,
  ): PreCallDecision {
    const decision: PreCallDecision = {
      allowed: false,
      killReason: reason,
      cumulativeCostUsd,
      ceilingUsd,
      worstCaseNextCallUsd: Number.isFinite(worstCaseNextCallUsd) ? worstCaseNextCallUsd : 0,
      checkedAt,
    };
    this.#emit({
      kind: "precall_check",
      provider: request.seat.provider,
      modelId: request.seat.modelId,
      decision,
    });
    this.alert(
      "precall_denied",
      callClassKey(request.seat.provider, request.seat.modelId, request.seat.role),
      detail,
      "This is a boundary, not a failure of the model. Record the run as terminated on a boundary.",
    );
    this.kill(reason, detail);
    return decision;
  }

  #maybeWarn(cumulativeCostUsd: number, ceilingUsd: number): void {
    if (this.#warned || ceilingUsd <= 0) return;
    const fraction = cumulativeCostUsd / ceilingUsd;
    if (fraction < this.#options.budget.warnAtFraction) return;
    this.#warned = true;
    this.#emit({
      kind: "budget_warning",
      cumulativeCostUsd,
      ceilingUsd,
      fractionUsed: fraction,
    });
  }

  #killSwitchEngaged(): KillSignal | null {
    if (this.#kill !== null) return this.#kill;
    return this.#options.killSwitch.engaged();
  }

  /* ---------------------------------------------------------------------
   * Recording
   * ------------------------------------------------------------------ */

  /**
   * Record one completed API call.
   *
   * Order matters and is deliberate: the campaign spend line is appended
   * FIRST, so a crash between the two writes over-counts campaign spend rather
   * than under-counting it. An over-count stops the campaign early and is
   * recoverable; an under-count silently raises the ceiling.
   */
  recordUsage(
    usage: VendorUsage,
    context: { readonly httpStatus: number | null; readonly streamed: boolean },
  ): void {
    this.#assertOpen();
    const at = new Date().toISOString();
    this.#campaign.append({ runId: this.#options.runId, at, costUsd: usage.costUsd });

    const key = callClassKey(usage.provider, usage.modelId, usage.role);
    const existing = this.#usage.get(key);
    this.#usage.set(key, existing === undefined ? usage : mergeVendorUsage(existing, usage));
    this.#outputTokensByProvider.set(
      usage.provider,
      (this.#outputTokensByProvider.get(usage.provider) ?? 0) + usage.outputTokens,
    );

    const cumulativeCostUsd = this.totalCostUsd();
    this.#emit({ kind: "usage_recorded", usage, cumulativeCostUsd });

    const nowMs = this.#nowMs();
    const msSincePreviousCall = this.#lastCallAtMs === null ? null : nowMs - this.#lastCallAtMs;
    this.#lastCallAtMs = nowMs;

    const call: CallRecord = {
      schemaVersion: 1,
      runId: this.#options.runId,
      seq: this.#seq,
      at,
      ticketId: this.#options.ticketId,
      configId: this.#options.configId,
      phase: this.#options.phase,
      seatRole: usage.role,
      provider: usage.provider,
      modelId: usage.modelId,
      effort: usage.effort,
      usage,
      costUsd: usage.costUsd,
      cumulativeCostUsd,
      campaignCostUsd: this.#campaign.totalUsd(),
      cacheHitFraction: vendorCacheHitFraction(usage),
      msSincePreviousCall,
      httpStatus: context.httpStatus,
      streamed: context.streamed,
    };
    appendJsonLine(this.#layout.runCallsPath, call);

    this.#updateCacheAlerts(key, usage);
    this.#maybeWarn(cumulativeCostUsd, this.#options.budget.maxCostUsd);
  }

  #updateCacheAlerts(key: string, usage: VendorUsage): void {
    const state: CallClassState = this.#classes.get(key) ?? {
      calls: 0,
      consecutiveBothZero: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      alertedNeverEngaged: false,
      alertedLowHitFraction: false,
    };
    state.calls += 1;
    state.inputTokens += usage.inputTokens;
    state.cacheReadTokens += usage.cacheReadTokens;
    state.cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.cacheReadTokens === 0 && usage.cacheWriteTokens === 0) {
      state.consecutiveBothZero += 1;
    } else {
      state.consecutiveBothZero = 0;
    }
    this.#classes.set(key, state);

    if (
      !state.alertedNeverEngaged &&
      state.consecutiveBothZero >= CACHE_ALERT_CONSECUTIVE_THRESHOLD
    ) {
      state.alertedNeverEngaged = true;
      this.alert(
        "cache_never_engaged",
        key,
        `${state.consecutiveBothZero} consecutive calls with BOTH cache_read_input_tokens and ` +
          "cache_creation_input_tokens at 0. The prompt is not being cached at all.",
        "Almost always a cached prefix below the model minimum (512 tokens on Opus 5, 1,024 on " +
          "Sonnet 5), which fails SILENTLY with no error. It is a 10x price increase on that block, " +
          "invisible in every log except these two fields, and caching is ~59% of the bill. Check " +
          "for a timestamp, ticket id, run id or decrementing budget counter interpolated before " +
          "the last breakpoint, a tool set that varies per request, or unsorted JSON keys.",
      );
    }

    if (
      !state.alertedLowHitFraction &&
      state.calls >= CACHE_HIT_FRACTION_MIN_CALLS
    ) {
      const total = state.cacheReadTokens + state.cacheWriteTokens + state.inputTokens;
      if (total > 0) {
        const fraction = state.cacheReadTokens / total;
        if (fraction < CACHE_HIT_FRACTION_ALERT_THRESHOLD) {
          state.alertedLowHitFraction = true;
          this.alert(
            "cache_hit_fraction_low",
            key,
            `measured cache-hit token fraction ${(fraction * 100).toFixed(1)}% over ${state.calls} ` +
              `calls, below the ${(CACHE_HIT_FRACTION_ALERT_THRESHOLD * 100).toFixed(0)}% alert ` +
              "threshold for this call class",
            "The threshold is a harness choice with no empirical basis — the widely-quoted 85% has " +
              "none either. Treat this as a smoke alarm: read the per-class fractions in the run " +
              "report before concluding anything, and never average them across vendors.",
          );
        }
      }
    }
  }

  /** Record an alert. Alerts never terminate a run; boundaries do. */
  alert(kind: AlertKind, callClass: string, detail: string, remediation: string): void {
    const alert: LedgerAlert = {
      schemaVersion: 1,
      runId: this.#options.runId,
      at: new Date().toISOString(),
      kind,
      callClass,
      detail,
      remediation,
    };
    appendJsonLine(this.#layout.runAlertsPath, alert);
  }

  /** A harness-level error, redacted, surfaced on the run record. */
  recordHarnessError(message: string): void {
    const redacted = redactForPersistence(message, PERSIST_REDACT_OPTIONS);
    this.#harnessErrors.push(redacted);
  }

  /**
   * The agent said it was finished.
   *
   * >>> RECORDED. IT SCORES NOTHING. This exists so `falseFinish` can be
   * >>> computed — agent declared done AND the held-out suite failed — and for
   * >>> no other purpose.
   */
  recordAgentDeclaredDone(selfReportPath: string | null): void {
    this.#agentDeclaredDone = true;
    this.#selfReportPath = selfReportPath;
    this.#emit({ kind: "agent_declared_done", selfReportPath });
  }

  /** BLOCKED is a first-class outcome, not a failure (doc 03 section 8.3). */
  recordAgentBlocked(reason: string): void {
    this.#blockedReason = reason;
    this.#emit({ kind: "agent_reported_blocked", reason });
  }

  /** Terminate on a boundary. Idempotent: the FIRST boundary is the one recorded. */
  kill(reason: KillReason, detail: string): KillSignal {
    if (this.#kill !== null) return this.#kill;
    const signal: KillSignal = {
      reason,
      detail,
      at: new Date().toISOString(),
      source: "local",
    };
    this.#kill = signal;
    this.#emit({
      kind: "kill_issued",
      reason,
      cumulativeCostUsd: this.totalCostUsd(),
      detail,
    });
    // A campaign-wide boundary must stop every other in-flight run too. A
    // per-run boundary must not.
    if (reason === "campaign_cost_ceiling_usd") {
      this.#options.killSwitch.engage(reason, detail);
    }
    return signal;
  }

  /* ---------------------------------------------------------------------
   * Reading
   * ------------------------------------------------------------------ */

  /** One row per (provider, modelId, role), sorted for stable records. */
  usageRows(): readonly VendorUsage[] {
    return [...this.#usage.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, usage]) => usage);
  }

  /** Total run spend. The only cross-vendor aggregate in the harness. */
  totalCostUsd(): number {
    return sumCostUsd(this.usageRows());
  }

  /** Campaign spend, read from disk across every process. */
  campaignCostUsd(): number {
    return this.#campaign.totalUsd();
  }

  /**
   * Measured cache-hit token fraction PER VENDOR.
   *
   * A secondary metric of the bake-off. Computed per provider by summing that
   * provider's own rows — never across providers, because the token counts are
   * not comparable.
   */
  cacheHitFractionByProvider(): Readonly<Partial<Record<Provider, number>>> {
    const totals = new Map<Provider, { read: number; write: number; input: number }>();
    for (const usage of this.#usage.values()) {
      const t = totals.get(usage.provider) ?? { read: 0, write: 0, input: 0 };
      t.read += usage.cacheReadTokens;
      t.write += usage.cacheWriteTokens;
      t.input += usage.inputTokens;
      totals.set(usage.provider, t);
    }
    const out: Partial<Record<Provider, number>> = {};
    for (const [provider, t] of totals) {
      const denominator = t.read + t.write + t.input;
      if (denominator > 0) out[provider] = t.read / denominator;
    }
    return out;
  }

  killSignal(): KillSignal | null {
    return this.#kill;
  }

  agentDeclaredDone(): boolean {
    return this.#agentDeclaredDone;
  }

  selfReportPath(): string | null {
    return this.#selfReportPath;
  }

  blockedReason(): string | null {
    return this.#blockedReason;
  }

  harnessErrors(): readonly string[] {
    return [...this.#harnessErrors];
  }

  /** Close the ledger and write `run_ended`. Idempotent. */
  close(status: RunStatus): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit({
      kind: "run_ended",
      status,
      totalCostUsd: this.totalCostUsd(),
      killReason: this.#kill?.reason ?? null,
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `ledger for run ${this.#options.runId} is closed`,
        "Do not record against a closed ledger: the run record has already been written and the " +
          "spend it reports would no longer match the ledger.",
      );
    }
  }

  #emit(event: LedgerEventBody): void {
    this.#seq += 1;
    const full = {
      schemaVersion: 1 as const,
      eventId: `${this.#options.runId}-${this.#seq}`,
      runId: this.#options.runId,
      seq: this.#seq,
      at: new Date().toISOString(),
      ...event,
    } as LedgerEvent;
    appendJsonLine(this.#layout.runEventsPath, full);
  }
}

/**
 * A ledger event minus the fields the ledger itself stamps.
 *
 * `Omit` over a union is NOT distributive — `Omit<LedgerEvent, ...>` collapses
 * to the fields every member shares and would silently erase `kind`. This maps
 * over the union member by member so the discriminant survives.
 */
type LedgerEventBody = LedgerEvent extends infer Member
  ? Member extends LedgerEvent
    ? Omit<Member, "schemaVersion" | "eventId" | "runId" | "seq" | "at">
    : never
  : never;

/** `provider|modelId|role`. The call-class key, per doc 04 section 3.4. */
export function callClassKey(provider: Provider, modelId: string, role: string): string {
  return `${provider}|${modelId}|${role}`;
}

/**
 * Read a per-run ledger back from disk.
 *
 * Verifies that `seq` is monotonic and gap-free. A gap means the file was
 * truncated, and a truncated ledger under-reports spend.
 */
export function readLedgerEvents(path: string): readonly LedgerEvent[] {
  if (!existsSync(path)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `no ledger at ${path}`,
      "Run the build first, or point the reader at the run's results directory.",
    );
  }
  const events: LedgerEvent[] = [];
  let expected = 1;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as LedgerEvent;
    if (parsed.seq !== expected) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `ledger ${path} jumps from seq ${expected - 1} to ${parsed.seq}`,
        "The ledger is append-only and gap-free by construction, so a gap means it was truncated " +
          "or interleaved by a second writer. Treat this run's spend as under-reported and exclude " +
          "it from the campaign total until reconciled.",
      );
    }
    expected += 1;
    events.push(parsed);
  }
  return events;
}
