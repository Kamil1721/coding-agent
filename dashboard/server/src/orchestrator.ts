/**
 * orchestrator.ts — one ticket, end to end, with the gates that make it mean
 * something.
 *
 * THE PIPELINE, AND WHY EACH STEP IS WHERE IT IS:
 *
 *   spec  -> the EXISTING spec agent authors the acceptance suite FROM THE
 *            TICKET TEXT ALONE, before any implementation exists, audits it
 *            adversarially (28 deterministic checks plus a separate judge
 *            seat), regenerates it if the audit finds a blocking defect, and
 *            freezes it by digest. This is the single highest-value
 *            intervention measured anywhere in the research: +26.3pp
 *            (68.0% -> 94.3%) for a machine-checkable spec written before
 *            implementation, and the bad-test detector is where that effect
 *            lives. It cannot run after the build, because a suite authored
 *            with the implementation in view is not held out.
 *   build -> the chosen subscription SDK drives the build in a git-initialised
 *            workspace. The held-out half of the suite is NEVER in that
 *            workspace; only the visible subset is copied in, as a COPY, so the
 *            builder has a real feedback signal and the visible-vs-held-out gap
 *            stays measurable.
 *   gate  -> the EXISTING sealed scorer runs the frozen suite in a
 *            --network=none container from an image pinned by digest, against a
 *            staged copy of the artefact with .git and .bakeoff stripped. It
 *            runs the tier-0 gates (build, boot, typecheck, lint, exploit scan,
 *            screenshots, DOM findings) and computes `heldOutPass` through
 *            `computeHeldOutPass`. Nothing here recomputes it.
 *   judge -> a code-reading pass over the diff, for the one exploit class
 *            execution cannot catch. It gates NOTHING.
 *
 * WITHOUT THE GATE THIS IS A CHAT BOX. Every failure mode below therefore
 * distinguishes "the gate said no" (a result) from "the gate could not run"
 * (not a result). The second leaves `heldOutPass` NULL. `gateToCriterion` in
 * the scorer maps a `not_applicable` gate to `passed: true`, and the same trap
 * exists one level up: a gate that cannot run must never be indistinguishable
 * from a gate that passed.
 *
 * CONCURRENCY: ONE ACTIVE RUN. Not because of CPU — because the binding
 * constraint on a subscription is a rate-limit window shared by every run, and
 * two builds racing into the same 5-hour window get both of them throttled
 * instead of one of them finished.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BAKEOFF_SCHEMA_VERSION,
  BakeoffError,
  TOKEN_ACCOUNTING_RULE,
} from "bakeoff/dist/contracts.js";
import type {
  AcceptanceSuite,
  AnthropicSeat,
  BudgetPolicy,
  HeldConstants,
  RunRecord,
  ScoreRecord,
  Ticket,
} from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT, SPEC_SEAT } from "bakeoff/dist/config.js";
import { createGate } from "bakeoff/dist/gate.js";
import { readSelfReport, WORKSPACE } from "bakeoff/dist/runner.js";
import type { ContainerResult } from "bakeoff/dist/scorer-protocol.js";
import {
  assertSuiteIntact,
  authorAndFreezeSuite,
  materialiseVisibleSubset,
  readFrozenSuite,
  resolveHarnessIdentity,
} from "bakeoff/dist/spec-agent.js";
import { ReassemblingRedactor, redactForPersistence } from "bakeoff/dist/redact.js";
import { shortlistFor } from "./agent-shortlist.js";
import { archiveAttempt, readAttempt, scorerOutRoot } from "./gate-attempts.js";
import type { ApiCriterion, ApiPhase, ApiRunStatus } from "./api-types.js";
import { appendContextEvent } from "./build-context.js";
import type { ContextEvent } from "./build-context.js";
import { writeEnvironmentRecord } from "./build-environment.js";
import type { AuthProbe } from "./auth.js";
import { truncate } from "./claude-common.js";
import type { RateLimitState } from "./claude-common.js";
import { dashboardBuilderPrompt, resumeBuilderPrompt } from "./build-prompt.js";
import { ClaudeSubscriptionBuilder } from "./builders/claude-builder.js";
import { CodexSubscriptionBuilder } from "./builders/codex-builder.js";
import type { BuildEventSink, BuildOutcome, SubscriptionBuilder } from "./builders/types.js";
import type { RunRow, RunStore } from "./db.js";
import { isTerminal } from "./db.js";
import { RunEventBus } from "./bus.js";
import { judgeArtifact } from "./judge.js";
import type { ModelCatalog } from "./models.js";
import { ensureRunDirs, gateEnv, runPathsFor } from "./paths.js";
import type { DashboardPaths, RunPaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { writeAssumptions, writeRunVerdict } from "./run-report.js";
import { describeTokens, toApiTokens, zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";
import { SubscriptionSeatCaller } from "./subscription-caller.js";
import { ticketFromText } from "./ticket.js";
import { classifySurface } from "./surface.js";

const exec = promisify(execFile);

/**
 * Budget policy for the dashboard's own model calls.
 *
 * THE DOLLAR FIGURES HERE ARE INERT AND SAY SO. Subscription calls have no
 * per-token price, so `SpendCeiling` records 0 for every call and the cost
 * ceiling can never fire. It is set to a positive number only because
 * `BudgetPolicy` requires one and a 0 ceiling would refuse the first call.
 * The boundary that DOES fire is `maxWallClockMs`, checked before every seat
 * call. The real constraint is the provider's rate-limit window, which is not
 * a dollar amount and is handled as its own run state.
 */
export const DASHBOARD_BUDGET: BudgetPolicy = Object.freeze({
  maxCostUsd: 1,
  maxWallClockMs: 4 * 60 * 60 * 1000,
  maxCampaignCostUsd: 1,
  warnAtFraction: 0.8,
  perVendorMaxOutputTokens: null,
  vendorAdvisoryBudgets: [],
});

/** Model id for the spec and judge seats. Override to pin a specific model. */
export const SPEC_MODEL_ENV = "DASHBOARD_SPEC_MODEL";

/**
 * Default spec/judge model.
 *
 * "default" is a real id in the Claude CLI's own model list (verified: it
 * resolves to claude-opus-5[1m] on this machine) and means "the model the CLI
 * recommends". doc 03 section 7.4 wants the spec seat at Opus-class `xhigh`,
 * which is what that resolves to here; pinning a literal wire id that the CLI
 * might not accept would trade a true statement for a brittle one.
 */
export const DEFAULT_SPEC_MODEL = "default";

export interface OrchestratorDeps {
  readonly store: RunStore;
  readonly bus: RunEventBus;
  readonly paths: DashboardPaths;
  readonly catalog: ModelCatalog;
  readonly auth: AuthProbe;
  readonly preview: PreviewHost;
  readonly env: NodeJS.ProcessEnv;
}

interface ActiveRun {
  readonly runId: string;
  readonly abort: AbortController;
}

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  #active: ActiveRun | null = null;
  #pumping = false;
  #stopped = false;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  get activeRunId(): string | null {
    return this.#active?.runId ?? null;
  }

  /* ---- queue -------------------------------------------------------- */

  /**
   * Recompute and persist queue positions, then start the next run if idle.
   *
   * `RunSummary` is a frozen contract with no position field, so the position
   * is surfaced the only way the contract allows: as a log event on the run's
   * own SSE stream, emitted when it changes. It is also persisted, because the
   * queue has to survive a restart.
   */
  pump(): void {
    if (this.#stopped || this.#pumping) return;
    this.#pumping = true;
    try {
      const queued = this.assignQueuePositions();
      if (this.#active === null) {
        const next = queued[0];
        if (next !== undefined) void this.#start(next.runId);
      }
    } finally {
      this.#pumping = false;
    }
  }

  /**
   * Write each queued run's 1-based position and announce any change.
   *
   * Split out of `pump()` so it can be exercised on its own: the next thing
   * `pump()` does is spawn a builder, and a test that has to spend the owner's
   * subscription to check an integer is not a test anyone will keep running.
   */
  assignQueuePositions(): readonly RunRow[] {
    const queued = this.#deps.store.listQueued();
    let position = 1;
    for (const row of queued) {
      if (row.queuePosition !== position) {
        this.#deps.store.updateRun(row.runId, { queuePosition: position });
        this.#emitLog(row.runId, "info", `queued: position ${String(position)} of ${String(queued.length)}`);
      }
      position += 1;
    }
    return queued;
  }

  /** Cancel a run. A queued run is cancelled outright; an active one aborts. */
  cancel(runId: string): boolean {
    const row = this.#deps.store.getRun(runId);
    if (row === null || isTerminal(row.status)) return false;
    if (this.#active !== null && this.#active.runId === runId) {
      this.#active.abort.abort();
      return true;
    }
    this.#finish(runId, "cancelled", { queuePosition: null, endedAt: new Date().toISOString() });
    this.pump();
    return true;
  }

  /**
   * Requeue a run that stopped without finishing.
   *
   * Legitimate for `rate_limited` (the window will reset) and for a run left
   * `running` by a server that died. Refused for a terminal run: re-running a
   * scored artefact would overwrite a real result with a second one taken under
   * different conditions.
   */
  resume(runId: string): boolean {
    const row = this.#deps.store.getRun(runId);
    if (row === null || isTerminal(row.status)) return false;
    if (this.#active !== null && this.#active.runId === runId) return false;
    this.#deps.store.updateRun(runId, {
      status: "queued",
      resumeCount: row.resumeCount + 1,
      rateLimited: false,
      rateLimitRetryAfterSec: null,
    });
    this.#emit(runId, { type: "status", status: "queued" });
    this.#emitLog(runId, "info", `resuming from phase "${row.phase}" (resume #${String(row.resumeCount + 1)})`);
    this.pump();
    return true;
  }

  /**
   * Boot reconciliation.
   *
   * A run persisted as `running` is not running: its subprocess died with the
   * server. It is marked `rate_limited`... no — it is marked QUEUED only if the
   * owner asks, because silently restarting a build on server start would spend
   * quota without anyone present. It is moved to `awaiting_input`, which is the
   * contract's state for "a human has to decide", and the log says exactly what
   * happened and that `resume` will continue it.
   */
  reconcileOnBoot(): void {
    for (const row of this.#deps.store.listByStatus("running")) {
      this.#deps.store.updateRun(row.runId, { status: "awaiting_input", queuePosition: null });
      this.#emit(row.runId, { type: "status", status: "awaiting_input" });
      this.#emitLog(
        row.runId,
        "warn",
        "the dashboard restarted while this run was building, so its builder subprocess is gone. " +
          "The workspace and the frozen suite are intact. POST /api/runs/" +
          row.runId +
          "/resume continues it from where it stopped.",
      );
    }
    this.pump();
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.#active?.abort.abort();
    await this.#deps.preview.stop();
  }

  /* ---- one run ------------------------------------------------------ */

  async #start(runId: string): Promise<void> {
    const abort = new AbortController();
    this.#active = { runId, abort };
    try {
      await this.#execute(runId, abort.signal);
    } catch (error) {
      // A throw that escapes #execute is a harness fault, not a model result.
      const detail = describeError(error);
      this.#emitLog(runId, "error", detail);
      this.#finish(runId, "failed", {
        endedAt: new Date().toISOString(),
        failureReason: detail,
        queuePosition: null,
      });
    } finally {
      this.#active = null;
      this.pump();
    }
  }

  async #execute(runId: string, signal: AbortSignal): Promise<void> {
    const store = this.#deps.store;
    const row0 = store.getRun(runId);
    if (row0 === null) return;

    const runPaths = runPathsFor(this.#deps.paths, runId);
    ensureRunDirs(runPaths);

    const ticket = ticketFromText(row0.ticketText);
    const log = new BuildLog(runPaths.buildLog);

    store.updateRun(runId, {
      status: "running",
      queuePosition: 0,
      // Recorded as soon as the directory exists, not at the end: a run that
      // fails mid-build still produced a workspace, and "where is it?" is the
      // first thing anyone asks about a failure.
      artifactPath: runPaths.workspace,
    });
    this.#emit(runId, { type: "status", status: "running" });

    try {
      // ---- PHASE 1: the sealed acceptance suite ------------------------
      this.#setPhase(runId, "spec");
      const suite = await this.#specPhase(runId, ticket, signal);
      // SPEC-PHASE EXIT. Written here, above the abort check, for two reasons:
      // a run cancelled during the spec phase has still had criteria inferred on
      // its behalf and the record of them is exactly as useful, and this is the
      // last moment before the build starts — everything in that file is a
      // sentence the owner can add to the TICKET, which is the cheap correction.
      this.#recordAssumptions(runId, ticket, runPaths);
      if (signal.aborted) return this.#cancelled(runId, log);

      // ---- PHASE 2: build ---------------------------------------------
      this.#setPhase(runId, "build");
      const outcome = await this.#buildPhase(runId, ticket, runPaths, log, signal);
      if (outcome === null) return this.#cancelled(runId, log);

      if (outcome.rateLimit.limited) {
        log.close();
        this.#rateLimited(runId, outcome.rateLimit, outcome.sessionId);
        return;
      }

      const selfReport = readSelfReport(runPaths.workspace);
      const declaredDone = selfReport !== null && selfReport.status === "done";
      store.updateRun(runId, { agentDeclaredDone: declaredDone });
      this.#emitLog(
        runId,
        "info",
        selfReport === null
          ? "the builder wrote no self-report; recorded as not-declared-done"
          : `builder self-report: ${selfReport.status} — ${truncate(selfReport.reason, 200)}`,
      );

      // ---- PHASE 3: the sealed gate -----------------------------------
      this.#setPhase(runId, "gate");
      const scored = await this.#gatePhase(runId, ticket, suite, runPaths, declaredDone, signal, 1);

      // ---- PHASE 4: the code-reading judge ----------------------------
      this.#setPhase(runId, "judge");
      await this.#judgePhase(runId, ticket, suite, runPaths, scored.container, signal);

      // ---- done --------------------------------------------------------
      log.close();
      if (scored.record === null) {
        this.#setPhase(runId, "done");
        this.#finish(runId, "failed", {
          endedAt: new Date().toISOString(),
          heldOutPass: null,
          falseFinish: null,
          failureReason: scored.failure,
          queuePosition: null,
        });
        return;
      }

      await this.#maybePreview(runId, runPaths);
      this.#setPhase(runId, "done");
      const passed = scored.record.heldOutPass;
      this.#finish(runId, passed ? "passed" : "failed", {
        endedAt: new Date().toISOString(),
        heldOutPass: passed,
        falseFinish: scored.record.falseFinish,
        failureReason: passed ? null : "the frozen held-out suite did not go green in the sealed container",
        queuePosition: null,
      });
    } finally {
      log.close();
    }
  }

  /* ---- phase 1: spec ------------------------------------------------- */

  async #specPhase(runId: string, ticket: Ticket, signal: AbortSignal): Promise<AcceptanceSuite> {
    const acceptanceRoot = this.#deps.paths.acceptance;

    // Reuse an intact freeze. Re-authoring would spend quota to produce a
    // DIFFERENT yardstick for the same ticket text, and a resumed run would
    // then be measured against a suite its build never saw.
    let existing: AcceptanceSuite | null = null;
    try {
      existing = assertSuiteIntact(ticket.id, { acceptanceRoot }).suite;
    } catch {
      existing = null;
    }

    if (existing !== null) {
      this.#emitLog(
        runId,
        "info",
        `reusing the sealed acceptance suite for this ticket text (${existing.sha256.slice(0, 12)}…), ` +
          `authored ${String(existing.criteria.length)} criteria`,
      );
      this.#recordCriteria(runId, existing);
      return existing;
    }

    this.#emitLog(
      runId,
      "info",
      "authoring the held-out acceptance suite from the ticket text alone, before any implementation " +
        "exists, then auditing it adversarially",
    );

    const specSeat = this.#seat(SPEC_SEAT);
    const judgeSeat = this.#seat(JUDGE_SEAT);
    const abortController = childAbort(signal);
    const cwd = this.#deps.paths.home;

    const specCaller = new SubscriptionSeatCaller(specSeat, {
      budget: DASHBOARD_BUDGET,
      cwd,
      env: this.#deps.env,
      abortController,
      onRateLimit: (state) => this.#noteRateLimit(runId, state),
    });
    const judgeCaller = new SubscriptionSeatCaller(judgeSeat, {
      budget: DASHBOARD_BUDGET,
      // ONE ceiling for the whole authoring job, author and judge together —
      // the same reason `authorAndFreezeAllSuites` shares one: a per-call
      // ceiling is a ceiling that never fires.
      ceiling: specCaller.ceiling,
      cwd,
      env: this.#deps.env,
      abortController,
      onRateLimit: (state) => this.#noteRateLimit(runId, state),
    });

    const { suiteSha256 } = await authorAndFreezeSuite(ticket, {
      acceptanceRoot,
      specSeat,
      judgeSeat,
      specCaller,
      judgeCaller,
      ceiling: specCaller.ceiling,
      budget: DASHBOARD_BUDGET,
      harness: resolveHarnessIdentity(cwd),
      makeReadOnly: true,
      overwrite: false,
    });

    specCaller.assertUnused();
    judgeCaller.assertUnused();
    this.#emitLog(runId, "info", `spec seat — ${describeTokens(specCaller.tokens)}`);
    this.#emitLog(runId, "info", `audit seat — ${describeTokens(judgeCaller.tokens)}`);

    const record = readFrozenSuite(ticket.id, acceptanceRoot);
    this.#deps.store.updateRun(runId, { suiteSha256 });
    this.#emitLog(
      runId,
      "info",
      `sealed suite ${suiteSha256.slice(0, 12)}… frozen with ${String(record.suite.criteria.length)} criteria ` +
        `and ${String(record.suite.testFiles.length)} test file(s)`,
    );
    this.#recordCriteria(runId, record.suite);
    return record.suite;
  }

  /**
   * `assumptions.md`, plus the count the API reports.
   *
   * READ FROM THE STORE, NOT FROM THE SUITE, and that is a boundary rather than
   * a shortcut: `AcceptanceCriterion.evidenceRequired` names held-out test ids
   * by contract ("holdout test T-14 PASS ..."), and `ApiCriterion` has no such
   * field. `#recordCriteria` has just written the same criteria there, redacted.
   *
   * A failure to write it must NOT take the run down — this is the record of the
   * run, not the run — so it is logged as a warning, which is itself a record.
   */
  #recordAssumptions(runId: string, ticket: Ticket, runPaths: RunPaths): void {
    try {
      const record = writeAssumptions(
        runPaths.results,
        ticket.brief,
        this.#deps.store.listCriteria(runId),
      );
      this.#deps.store.updateRun(runId, { inferredCriteria: record.inferredCriteria });
      this.#emitLog(
        runId,
        record.inferredCriteria === 0 ? "info" : "warn",
        `${String(record.inferredCriteria)} of the criteria this run will be graded against were not ` +
          `stated in your ticket. What the grader assumed is recorded in ${record.path}; correcting the ` +
          "ticket is cheaper than debugging the verdict it produces.",
      );
    } catch (error) {
      this.#emitLog(runId, "warn", `the assumption record could not be written: ${describeError(error)}`);
    }
  }

  #recordCriteria(runId: string, suite: AcceptanceSuite): void {
    const criteria: ApiCriterion[] = suite.criteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      tier: criterion.tier,
      result: "pending" as const,
    }));
    this.#deps.store.putCriteria(runId, criteria);
    this.#deps.store.updateRun(runId, { suiteSha256: suite.sha256 });
  }

  /* ---- phase 2: build ------------------------------------------------ */

  async #buildPhase(
    runId: string,
    ticket: Ticket,
    runPaths: RunPaths,
    log: BuildLog,
    signal: AbortSignal,
  ): Promise<BuildOutcome | null> {
    const store = this.#deps.store;
    const row = store.getRun(runId);
    if (row === null) return null;

    await this.#prepareWorkspace(ticket, runPaths);

    // The visible subset only. The held-out half is never copied, listed or
    // named; it lives outside the workspace entirely.
    try {
      const copied = materialiseVisibleSubset(ticket.id, runPaths.workspace, {
        acceptanceRoot: this.#deps.paths.acceptance,
        // MEASURED: the default subdir is "tests", but the build prompt names
        // WORKSPACE.visibleDir. A first end-to-end run put the visible half in
        // tests/ while telling the builder to look in visible-acceptance/ —
        // a feedback signal the builder was told about and could not find.
        workspaceSubdir: WORKSPACE.visibleDir,
      });
      this.#emitLog(
        runId,
        "info",
        copied.length === 0
          ? "no visible acceptance tests for this ticket; the whole suite is held out"
          : `copied ${String(copied.length)} visible acceptance test file(s) into the workspace`,
      );
    } catch (error) {
      this.#emitLog(runId, "warn", `visible acceptance subset unavailable: ${describeError(error)}`);
    }

    const entry = await this.#deps.catalog.resolve(row.modelId);
    if (entry === null || !entry.option.available) {
      throw new BakeoffError(
        "unknown_config",
        `model ${row.modelId} is not available: ${entry?.option.reason ?? "not in the catalog"}`,
        "Pick an available model, or authenticate its CLI (`claude setup-token` / `codex login`) and " +
          "resume the run. No API key is required or accepted.",
      );
    }

    const builder: SubscriptionBuilder =
      entry.option.provider === "openai" ? new CodexSubscriptionBuilder() : new ClaudeSubscriptionBuilder();

    // ONE EXPRESSION, TWO CONSUMERS. This value is both what the prompt names
    // and what the Anthropic driver's `PreToolUse` hook allowlists
    // (`allowedAgents`, below — and NOT `canUseTool`, which probe A measured is
    // consulted for no tool at all when the model delegates). Calling
    // `shortlistFor` twice would compile and read fine and drift the moment one
    // call site changes — and the drift is silent in BOTH directions: an agent
    // named in the prompt but missing from the guard burns turns on calls that
    // can never succeed, and one allowed but unnamed is a specialist the
    // orchestrator never learns it has.
    //
    // Classified from `ticket.brief` — the same string the prompt is built from
    // on the next line, so what the surface was decided from is exactly what the
    // builder is asked to deliver. `classifySurface` is pure, total and keyword
    // -based on purpose (see surface.ts): it runs before the build session
    // exists, on the path that builds a permission boundary, and a boundary that
    // can time out or be refused is not a boundary. An unrecognisable ticket
    // classifies `fullstack`, the widest set, because under-delegation is the
    // failure nobody sees.
    const delegationShortlist = shortlistFor(classifySurface(ticket.brief));

    const resuming = row.builderSessionId !== null;
    const prompt = resuming
      ? resumeBuilderPrompt(
          row.rateLimited
            ? "the provider's rate-limit window was exhausted"
            : "the dashboard was interrupted",
        )
      : dashboardBuilderPrompt({
          ticketText: ticket.brief,
          workspaceDir: runPaths.workspace,
          allowedAgents: delegationShortlist,
        });
    // REDACTED ON THE WAY TO DISK. The prompt embeds the ticket text, and here
    // the ticket text is FREE-FORM OWNER INPUT typed into a web form — not a
    // frozen, harness-authored brief as in the bake-off. Every other persisted
    // string in this program goes through this chokepoint (db.ts, the build
    // log, the run record); these two file writes were the exceptions.
    // The provider still receives the prompt verbatim, because the ticket IS
    // the prompt: a secret pasted into a ticket has already left the machine by
    // the time this line runs. Not masking it here as well would simply leave a
    // second copy lying in the run directory.
    writeFileSync(runPaths.promptFile, redactForPersistence(prompt), "utf8");

    let tokens: TokenTotals = zeroTokens(entry.option.provider === "openai" ? "openai" : "anthropic");
    // WHY CONTEXT EVENTS APPEND WHERE THE ENVIRONMENT OVERWRITES. The environment
    // is one statement made once, at init; context usage and compaction are a
    // SERIES — a long build samples at every lane boundary and may compact more
    // than once, and each occurrence is separate evidence about a run that got
    // quietly worse. Overwriting would leave a file saying a four-hour build
    // measured its context exactly once.
    //
    // A failure here must NOT take the build down, for the same reason the
    // environment write must not: this is the record of the build, not the build.
    const recordContextEvent = (event: ContextEvent): void => {
      try {
        appendContextEvent(runPaths.results, event);
      } catch (error) {
        this.#emitLog(runId, "warn", `a context event could not be recorded: ${describeError(error)}`);
      }
    };
    const sink: BuildEventSink = {
      log: (level, text) => this.#emitLog(runId, level, text),
      tool: (name, summary) => this.#emit(runId, { type: "tool", name, summary }),
      tokens: (totals) => {
        tokens = totals;
        store.updateRun(runId, { tokens: toApiTokens(totals) });
        this.#emit(runId, { type: "tokens", ...toApiTokens(totals) });
      },
      rateLimit: (state) => this.#noteRateLimit(runId, state),
      session: (id) => {
        store.updateRun(runId, { builderSessionId: id });
      },
      // THE RUN'S ENVIRONMENT, ONTO DISK BESIDE ITS RECORD.
      //
      // `run.json` cannot carry this: `RunRecord` is a bake-off contract type and
      // `bakeoff/` is not ours to modify, so the inventory goes in its own file in
      // the same directory rather than being dropped for want of a field. The two
      // are read together; `environmentHash` is what tells two runs of the same
      // ticket apart when their output differs and the brief did not.
      //
      // A failure here must NOT take the build down. This is the record of the
      // build, not the build, and losing the record of a run that otherwise
      // succeeded to an EACCES on one file would be the tail wagging the dog. It
      // is logged as a warning instead, which is itself a record.
      environment: (environment) => {
        try {
          writeEnvironmentRecord(runPaths.results, environment);
        } catch (error) {
          this.#emitLog(runId, "warn", `the run environment could not be recorded: ${describeError(error)}`);
        }
      },
      // THE CANVAS, STRAIGHT ONTO THE EXISTING EVENT STREAM. No parallel
      // channel, no second table: a graph event is persisted, sequenced and
      // replayed by exactly the code that carries `status` and `phase`, which is
      // what makes "this agent was running inside a cancelled run" impossible to
      // render rather than merely unlikely.
      graph: (event) => this.#emit(runId, event),
      contextUsage: (sample) => {
        recordContextEvent(sample);
      },
      compaction: (record) => {
        recordContextEvent(record);
      },
      raw: (text) => log.write(text),
    };

    this.#emitLog(
      runId,
      "info",
      `${resuming ? "resuming" : "starting"} the build with ${entry.option.label}` +
        `${entry.effort === null ? "" : ` at effort ${entry.effort}`}`,
    );

    const outcome = await builder.build({
      runId,
      prompt,
      workspace: runPaths.workspace,
      // The sealed suite store, named so each driver can deny reads of it.
      // See builders/claude-builder.ts and builders/codex-builder.ts: the two
      // drivers do NOT enforce this equally, and neither enforces it as
      // strongly as the bake-off's container does.
      sealedRoots: [
        this.#deps.paths.acceptance,
        // ONE definition, shared with the attempt archive that lives inside it
        // (gate-attempts.ts). Spelling the path a second time here is how a
        // later attempt directory ends up outside the deny it was supposed to
        // inherit.
        scorerOutRoot(this.#deps.paths),
      ],
      // THE DELEGATION BOUNDARY. `settingSources: ["user"]` makes 144 agents
      // visible to the builder; this is the far smaller set it may actually
      // reach, enforced in the Anthropic driver's `PreToolUse` hook (NOT in
      // `canUseTool`, which is asked about no tool at all when it delegates).
      // Visibility is not permission, and widening one never substitutes for
      // the other.
      //
      // Now derived from the ticket's surface rather than pinned to the widest
      // set. Computed ONCE, above, so this boundary and the prompt that names
      // these agents cannot disagree.
      allowedAgents: delegationShortlist,
      modelId: row.modelId,
      effort: entry.effort,
      resumeSessionId: row.builderSessionId,
      signal,
      sink,
      env: this.#deps.env,
    });

    if (outcome.sessionId !== null) store.updateRun(runId, { builderSessionId: outcome.sessionId });
    if (outcome.tokens.callCount > 0) {
      store.updateRun(runId, { tokens: toApiTokens(outcome.tokens) });
      this.#emitLog(runId, "info", `builder — ${describeTokens(outcome.tokens)}`);
    } else if (tokens.callCount > 0) {
      this.#emitLog(runId, "info", `builder — ${describeTokens(tokens)}`);
    }
    if (outcome.cancelled) return null;
    if (outcome.failure !== null) {
      this.#emitLog(runId, "warn", `the build did not complete cleanly: ${outcome.failure}`);
      store.updateRun(runId, { failureReason: outcome.failure });
    }
    return outcome;
  }

  /**
   * Workspace preparation: git, the ticket file, and nothing else.
   *
   * git is initialised because the artefact's diff is the judge's only input
   * and because the Codex CLI checks for a repo before it will write. The
   * initial commit is empty, so `git diff` against it is exactly what the
   * builder produced.
   */
  async #prepareWorkspace(ticket: Ticket, runPaths: RunPaths): Promise<void> {
    mkdirSync(runPaths.workspace, { recursive: true });
    // Redacted for the same reason as the prompt file: this is owner-typed
    // text landing on disk, and it is also committed into the workspace repo,
    // where `deploy` may later serve the directory over loopback.
    writeFileSync(join(runPaths.workspace, WORKSPACE.ticketFile), redactForPersistence(ticket.brief), "utf8");
    if (existsSync(join(runPaths.workspace, ".git"))) return;
    await git(runPaths.workspace, ["init", "--quiet", "--initial-branch=main"]);
    await git(runPaths.workspace, ["config", "user.email", "dashboard@localhost"]);
    await git(runPaths.workspace, ["config", "user.name", "dashboard"]);
    await git(runPaths.workspace, ["commit", "--allow-empty", "--quiet", "-m", "workspace created"]);
  }

  /* ---- phase 3: the sealed gate --------------------------------------- */

  /**
   * One gate attempt.
   *
   * `attempt` is 1-based and is NOT decoration: the sealed scorer writes to a
   * fixed path per run id (`gate-attempts.ts` explains why that cannot be
   * changed from here), so attempt 2 clobbers attempt 1's `result.json` in
   * place. The result is archived under `attempt-<n>/` the moment the scorer
   * returns, and everything downstream reads the archive. Without that, a
   * three-round run would end holding one result and no record of why it took
   * three rounds.
   */
  async #gatePhase(
    runId: string,
    ticket: Ticket,
    suite: AcceptanceSuite,
    runPaths: RunPaths,
    declaredDone: boolean,
    signal: AbortSignal,
    attempt: number,
  ): Promise<{ record: ScoreRecord | null; container: ContainerResult | null; failure: string | null }> {
    if (signal.aborted) return { record: null, container: null, failure: "cancelled" };

    const runRecord = this.#runRecord(runId, ticket, suite, runPaths, declaredDone);
    writeFileSync(
      join(runPaths.results, "run.json"),
      `${JSON.stringify(redactForPersistence(runRecord), null, 2)}\n`,
      "utf8",
    );

    this.#emitLog(
      runId,
      "info",
      "running the frozen suite in a sealed container: no network, no workspace history, image pinned " +
        "by content digest",
    );

    let record: ScoreRecord;
    try {
      const gate = await createGate(gateEnv(this.#deps.paths, this.#deps.env));
      record = await gate.score(runRecord, suite);
      archiveAttempt(this.#deps.paths, runId, attempt);
    } catch (error) {
      // Archive whatever the scorer managed to write before it threw: a
      // container that failed halfway still produced evidence about this
      // attempt, and the next attempt is about to overwrite it.
      archiveAttempt(this.#deps.paths, runId, attempt);
      // heldOutPass stays NULL. "The gate could not run" is not "the gate said
      // no", and the two must not look alike in the run list.
      const failure = describeError(error);
      this.#emitLog(
        runId,
        "error",
        `the sealed gate could not run, so this run has NO held-out verdict: ${failure}`,
      );
      return { record: null, container: null, failure };
    }

    for (const criterion of record.criteriaResults) {
      this.#deps.store.setCriterionResult(
        runId,
        criterion.criterionId,
        criterion.passed ? "pass" : "fail",
        criterion.detail,
      );
      this.#emit(runId, {
        type: "criterion",
        id: criterion.criterionId,
        result: criterion.passed ? "pass" : "fail",
      });
    }

    const container = this.#readContainerResult(runId, attempt);
    if (container !== null) this.#recordScreenshots(runId, container);

    for (const violation of record.protectedPathViolations) {
      this.#emitLog(runId, "error", `protected path modified: ${violation}`);
    }

    this.#emitLog(
      runId,
      record.heldOutPass ? "info" : "warn",
      `held-out suite: ${record.heldOutPass ? "GREEN" : "NOT GREEN"} — ` +
        `${String(record.suiteExecution.testsPassed ?? 0)}/${String(record.suiteExecution.testsTotal ?? 0)} ` +
        `test(s) passed, scorer image ${record.scorerImageDigest.slice(0, 19)}…`,
    );
    if (record.falseFinish) {
      this.#emitLog(
        runId,
        "warn",
        "FALSE FINISH: the builder declared the ticket done and the held-out suite did not go green. " +
          "This is the failure mode that ships a broken app.",
      );
    }

    return { record, container, failure: null };
  }

  #runRecord(
    runId: string,
    ticket: Ticket,
    suite: AcceptanceSuite,
    runPaths: RunPaths,
    declaredDone: boolean,
  ): RunRecord {
    const row = this.#deps.store.getRun(runId);
    const startedAt = row?.startedAt ?? new Date().toISOString();
    const endedAt = new Date().toISOString();

    /**
     * HELD CONSTANTS — constructed here, by hand, rather than through
     * `heldConstantsFor()`.
     *
     * That helper refuses a sandbox reference that is not an immutable content
     * digest, and it is right to: the field's only purpose is certifying that
     * every configuration ran in the identical image. THE DASHBOARD BUILDER
     * RUNS ON THE HOST. There is no image and there is no digest, so the field
     * records what actually happened and says plainly that it is not a
     * container digest. A dashboard run is therefore NOT comparable with a
     * bake-off run, which is also why nothing the dashboard writes is stored
     * where the campaign's `score`/`report` would find it (paths.ts).
     */
    const heldConstants: HeldConstants = {
      efforts: [],
      harness: { id: "dashboard-server", version: "0.1.0", commit: "unversioned" },
      sandbox: {
        imageRef: "host-subprocess (no container: the dashboard builder runs on the host)",
        imageDigest: "not-a-container-digest",
        networkPolicy: { egress: "denied", allowedHosts: [] },
      },
      repeatCount: 1,
      acceptanceSuiteSha256: suite.sha256,
      tokenAccountingRule: TOKEN_ACCOUNTING_RULE,
    };

    return {
      schemaVersion: BAKEOFF_SCHEMA_VERSION,
      runId,
      ticketId: ticket.id,
      ticketSha256: ticket.sha256,
      configId: "dashboard",
      repeatIndex: 0,
      startedAt,
      endedAt,
      wallClockMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      status: "completed",
      killReason: null,
      agentDeclaredDone: declaredDone,
      selfReportPath: join(runPaths.workspace, WORKSPACE.selfReport),
      // No usage rows: a VendorUsage carries `costUsd`, and there is no cost
      // for a subscription call to report. Token counts live on the run row.
      usage: [],
      totalCostUsd: 0,
      pricingBasis: [],
      seats: [],
      heldConstants,
      budget: DASHBOARD_BUDGET,
      artifactPath: runPaths.workspace,
      logPath: runPaths.runLog,
      ledgerPath: runPaths.ledger,
      harnessErrors: [],
    };
  }

  /**
   * The archived result for one attempt.
   *
   * Reads the ARCHIVE, not the scorer's live output path. A later attempt has
   * already overwritten the latter by the time anyone asks, and reading it would
   * answer a question about attempt 1 with attempt 3's numbers.
   */
  #readContainerResult(runId: string, attempt: number): ContainerResult | null {
    return readAttempt(this.#deps.paths, runId, attempt);
  }

  #recordScreenshots(runId: string, container: ContainerResult): void {
    const dir = join(this.#deps.paths.results, "screenshots", runId);
    for (const shot of container.screenshots) {
      if (!shot.nonBlank) continue;
      const path = join(dir, shot.file);
      const label = `${shot.flowId} @ ${shot.breakpoint}`;
      this.#deps.store.addScreenshot(runId, { path, label, capturedAt: container.endedAt });
      this.#emit(runId, { type: "screenshot", path, label });
    }
  }

  /* ---- phase 4: the judge --------------------------------------------- */

  async #judgePhase(
    runId: string,
    ticket: Ticket,
    suite: AcceptanceSuite,
    runPaths: RunPaths,
    container: ContainerResult | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const auth = await this.#deps.auth.status();
    if (auth.claude !== "ok") {
      this.#emitLog(runId, "warn", `skipping the code-reading judge: ${auth.claudeDetail}`);
      return;
    }

    const diff = await workspaceDiff(runPaths.workspace);
    const report = await judgeArtifact({
      ticket,
      criteria: suite.criteria,
      diff,
      evidence: renderEvidence(container),
      seat: this.#seat(JUDGE_SEAT),
      budget: DASHBOARD_BUDGET,
      cwd: this.#deps.paths.home,
      env: this.#deps.env,
      signal,
    });

    if (report.tokens !== null && report.tokens.callCount > 0) {
      this.#emitLog(runId, "info", `judge — ${describeTokens(report.tokens)}`);
    }
    if (!report.ran || report.verdict === "unavailable") {
      this.#emitLog(runId, "warn", `code-reading judge: ${report.summary}`);
      return;
    }
    this.#emitLog(
      runId,
      report.findings.length === 0 ? "info" : "warn",
      `code-reading judge (${report.judgedBy}, non-gating): ${report.verdict} — ${report.summary}`,
    );
    for (const finding of report.findings) {
      this.#emitLog(
        runId,
        finding.severity === "high" ? "warn" : "info",
        `judge finding [${finding.kind}/${finding.severity}]` +
          `${finding.criterionId === null ? "" : ` ${finding.criterionId}`}: ${finding.detail}` +
          `${finding.evidence.length === 0 ? "" : ` — ${finding.evidence}`}`,
      );
    }
  }

  /* ---- helpers -------------------------------------------------------- */

  async #maybePreview(runId: string, runPaths: RunPaths): Promise<void> {
    const row = this.#deps.store.getRun(runId);
    if (row === null || !row.deploy) return;
    try {
      const url = await this.#deps.preview.serve(runId, runPaths.workspace);
      this.#deps.store.updateRun(runId, { previewUrl: url });
      this.#emitLog(
        runId,
        "info",
        `serving the artefact at ${url} (loopback only — nothing is published to the internet)`,
      );
    } catch (error) {
      this.#emitLog(runId, "warn", `could not start the local preview: ${describeError(error)}`);
    }
  }

  #seat(base: AnthropicSeat): AnthropicSeat {
    const model = (this.#deps.env[SPEC_MODEL_ENV] ?? "").trim();
    return { ...base, modelId: model.length > 0 ? model : DEFAULT_SPEC_MODEL };
  }

  #noteRateLimit(runId: string, state: RateLimitState): void {
    this.#deps.store.updateRun(runId, {
      rateLimited: state.limited,
      rateLimitRetryAfterSec: state.retryAfterSec,
      rateLimitKind: state.kind,
    });
    this.#emit(runId, { type: "rate_limit", retryAfterSec: state.retryAfterSec });
    if (state.limited) {
      this.#emitLog(
        runId,
        "warn",
        `rate limited${state.kind === null ? "" : ` (${state.kind} window)`}` +
          `${state.retryAfterSec === null ? "" : `, resets in ${String(state.retryAfterSec)}s`}. ` +
          "This is an expected state on a subscription, not a fault. The run is kept and can be resumed.",
      );
    }
  }

  #rateLimited(runId: string, state: RateLimitState, sessionId: string | null): void {
    this.#deps.store.updateRun(runId, {
      status: "rate_limited",
      queuePosition: null,
      rateLimited: true,
      rateLimitRetryAfterSec: state.retryAfterSec,
      rateLimitKind: state.kind,
      ...(sessionId === null ? {} : { builderSessionId: sessionId }),
    });
    this.#emit(runId, { type: "status", status: "rate_limited" });
    this.#emitLog(
      runId,
      "warn",
      "the build stopped on the provider's rate limit. The workspace, the session and the frozen suite " +
        "are all intact; resume the run when the window resets and it continues the same session.",
    );
  }

  #cancelled(runId: string, log: BuildLog): void {
    log.close();
    this.#finish(runId, "cancelled", { endedAt: new Date().toISOString(), queuePosition: null });
  }

  /**
   * The single funnel every terminal status passes through — and therefore the
   * one place `verdict.md` is written.
   *
   * `rate_limited` deliberately does not come through here: it is not terminal,
   * the window drains and the run resumes, and a verdict written for it would be
   * a verdict on a run that has not finished. `#rateLimited` writes its own
   * patch for exactly that reason.
   *
   * ORDER IS LOAD-BEARING. The patch is persisted FIRST so the verdict is
   * rendered from the run's final recorded state — the status it is ending in
   * and the failure reason that came with it, not the ones it had a moment ago.
   * The `verdict` event is then emitted BEFORE the `status` event, because a
   * client revalidates on a terminal status and must find `verdictPath` already
   * in the read model when it does.
   */
  #finish(runId: string, status: ApiRunStatus, patch: Parameters<RunStore["updateRun"]>[1]): void {
    const row = this.#deps.store.updateRun(runId, { ...patch, status });
    const verdictPath = this.#writeVerdict(runId, row);
    if (verdictPath !== null) {
      const updated = this.#deps.store.updateRun(runId, { verdictPath });
      this.#emit(runId, {
        type: "verdict",
        verdictPath,
        inferredCriteria: updated.inferredCriteria,
      });
    }
    this.#emit(runId, { type: "status", status });
  }

  /**
   * `verdict.md` for a run that has just ended.
   *
   * The branch between a real verdict and the no-verdict page lives inside
   * `writeRunVerdict`, not here. If this method chose, the choice would be
   * wiring no test reaches and whichever arm a test did not exercise would be
   * dead in the run while a unit test stood over it — the shape of defect this
   * project has already shipped twice.
   *
   * Every input comes from the persisted row and the criteria table, both
   * redacted on the way in and neither carrying a held-out test title.
   */
  #writeVerdict(runId: string, row: RunRow): string | null {
    try {
      return writeRunVerdict(runPathsFor(this.#deps.paths, runId).results, {
        ticketText: row.ticketText,
        criteria: this.#deps.store.listCriteria(runId),
        status: row.status,
        failureReason: row.failureReason,
      });
    } catch (error) {
      // The record of the run, not the run. A run that finished must not be
      // reported as a harness fault because one file could not be written.
      this.#emitLog(runId, "warn", `the verdict could not be written: ${describeError(error)}`);
      return null;
    }
  }

  #setPhase(runId: string, phase: ApiPhase): void {
    this.#deps.store.updateRun(runId, { phase });
    this.#emit(runId, { type: "phase", phase });
  }

  #emitLog(runId: string, level: "info" | "warn" | "error", text: string): void {
    this.#emit(runId, { type: "log", level, text });
  }

  #emit(runId: string, event: Parameters<RunEventBus["emit"]>[1]): void {
    this.#deps.bus.emit(runId, event);
  }
}

/* -------------------------------------------------------------------------
 * Free functions
 * ---------------------------------------------------------------------- */

/**
 * The build transcript file.
 *
 * `ReassemblingRedactor` is used here and NOT a per-chunk redact: a credential
 * split across two writes cannot be matched by a regex applied to each write
 * separately, which is why redact.ts ships no per-chunk function at all. The
 * redactor holds back a 16 KiB tail, so this file lags the live stream — which
 * is fine for a file and is why the live SSE trace carries whole, already
 * complete SDK messages instead of stream deltas.
 */
class BuildLog {
  readonly #path: string;
  readonly #redactor = new ReassemblingRedactor();
  #closed = false;

  constructor(path: string) {
    this.#path = path;
    writeFileSync(path, "", "utf8");
  }

  write(text: string): void {
    if (this.#closed) return;
    const safe = this.#redactor.write(text);
    if (safe.length > 0) appendFile(this.#path, safe);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const tail = this.#redactor.finish();
    if (tail.length > 0) appendFile(this.#path, tail);
  }
}

function appendFile(path: string, text: string): void {
  try {
    writeFileSync(path, text, { encoding: "utf8", flag: "a" });
  } catch {
    // A full disk must not take down a run that is otherwise fine. The
    // authoritative record is the events table.
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Directories whose contents are not the artefact.
 *
 * A pathspec exclude, so they are still STAGED (and therefore still scored —
 * the sealed gate sees the real workspace, not this diff); they are only kept
 * out of the judge's reading material.
 */
const VENDOR_EXCLUDES: readonly string[] = Object.freeze([
  ":(exclude)node_modules",
  ":(exclude)**/node_modules/**",
  ":(exclude)package-lock.json",
  ":(exclude)pnpm-lock.yaml",
  ":(exclude)yarn.lock",
  ":(exclude).venv",
  ":(exclude)vendor",
  ":(exclude)**/*.png",
  ":(exclude)**/*.jpg",
  ":(exclude)**/*.webp",
  ":(exclude)**/*.woff2",
]);

/**
 * The artefact's diff against the empty initial commit.
 *
 * `git add -A` first so untracked files — which is most of what a greenfield
 * build produces — are in it. Binary files are excluded from the text; a diff
 * is for reading.
 */
export async function workspaceDiff(workspace: string): Promise<string> {
  try {
    await git(workspace, ["add", "-A"]);
    // NO --stat / --stat-width here. `--stat-width` implies `--stat`, which
    // replaces the patch body with a summary table — measured: the judge
    // reported "the diff body was withheld (diffstat only)" and could cite no
    // code, which is the entire input it exists to read.
    //
    // The pathspec excludes are not cosmetic either: `git add -A` stages
    // node_modules if the build installed anything, and vendored code would
    // fill the judge's character cap before a line of the artefact appeared.
    return await git(workspace, [
      "diff",
      "--cached",
      "--no-color",
      "--text",
      "HEAD",
      "--",
      ".",
      ...VENDOR_EXCLUDES,
    ]);
  } catch {
    try {
      return await git(workspace, ["diff", "--cached", "--no-color", "HEAD"]);
    } catch {
      return "";
    }
  }
}

/** The evidence bundle handed to the judge. Execution facts only. */
export function renderEvidence(container: ContainerResult | null): string {
  if (container === null) return "The sealed container produced no machine-readable result.";
  const lines: string[] = [];
  for (const gate of container.tier0) {
    lines.push(`${gate.id}: ${gate.outcome} — ${truncate(gate.detail, 200)}`);
  }
  lines.push(
    `suite: exit ${String(container.suiteExecution.exitCode)}, ` +
      `${String(container.suiteExecution.testsPassed ?? 0)}/${String(container.suiteExecution.testsTotal ?? 0)} passed`,
  );
  for (const coverage of container.criterionCoverage) {
    lines.push(`${coverage.criterionId}: ${coverage.outcome} — ${truncate(coverage.detail, 160)}`);
  }
  for (const finding of container.exploitFindings) {
    lines.push(`exploit scan: ${finding.kind} in ${finding.path} — ${truncate(finding.detail, 160)}`);
  }
  for (const shot of container.screenshots) {
    lines.push(`screenshot ${shot.flowId} @ ${shot.breakpoint}: ${String(shot.bytes)} bytes, nonBlank=${String(shot.nonBlank)}`);
  }
  return redactForPersistence(lines.join("\n"));
}

function childAbort(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

export function describeError(error: unknown): string {
  if (error instanceof BakeoffError) {
    return redactForPersistence(`[${error.code}] ${error.message}\nfix: ${error.remediation}`);
  }
  return redactForPersistence(error instanceof Error ? error.message : String(error));
}
