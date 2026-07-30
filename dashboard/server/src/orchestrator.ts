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
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
  NetworkPolicy,
  RunRecord,
  SandboxSpec,
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
import { DELIVERY_LANES, shortlistFor } from "./agent-shortlist.js";
import { writeBacklog } from "./backlog.js";
import type { BacklogInput } from "./backlog.js";
import { graphResumeState, makeSegmentRemap, nextBuildSegment } from "./build-segment.js";
import {
  canWriteDir,
  designPreflight,
  designScriptPath,
  detectDesignCapability,
  execCommandRunner,
} from "./design-capability.js";
import type { CommandRunner, DesignPreflight } from "./design-capability.js";
import { designSubprocessEnv, designTmpDirFor } from "./design-env.js";
import { designLaneMode, designSurfaceGate } from "./design-lane.js";
import type { DesignLaneMode } from "./design-lane.js";
import {
  DESIGN_MOCKUP_LABEL,
  chosenMockupRef,
  designLockPolicy,
  designLockTimeoutMin,
  designLockExpired,
  fallbackChoice,
  lockManifest,
  publishedMockupPath,
  readChoiceFile,
  readDesignLock,
  writeDesignLock,
} from "./design-lock.js";
import type { LockAttempt } from "./design-lock.js";
import {
  countDesignPngs,
  pruneMissingRefs,
  readDesignDirection,
  readDesignManifest,
  refsDirFor,
  writeDesignManifest,
} from "./design-manifest.js";
import type { DesignManifest } from "./design-manifest.js";
import { classifyDesignLane, designLaneFailureMessage, writeDesignLaneRecord } from "./design-outcome.js";
import { designHandoffSection, designSegmentPrompt } from "./design-prompt.js";
import { defaultVideoCapabilityDeps, videoCapability } from "./design/video-capability.js";
import { defaultSpawnLeg, runVideoLane } from "./design/video-lane.js";
import { fixAllowedAgents } from "./fix-prompt.js";
import type { FixTask } from "./fix-triage.js";
import { archiveAttempt, readAttempt, scorerOutRoot } from "./gate-attempts.js";
// THE ONE DOOR. `renderEvidence` routes the judge's evidence bundle through the
// same allowlist the fix loop's prompts go through, rather than through a second
// copy of the same decision. See the docblock on `renderEvidence`.
import { toAgentVisible } from "./gate-report.js";
import { maxAttemptsFrom, runGateFixLoop } from "./gate-fix-loop.js";
import type { GateFixLoopResult, StopReason } from "./gate-fix-loop.js";
import type { ApiCriterion, ApiPhase, ApiProvider, ApiRunStatus, GraphSseEvent } from "./api-types.js";
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
import { ensureRunDirs, gateEnv, runPathsFor, safeSegment } from "./paths.js";
import type { DashboardPaths, RunPaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { writeAssumptions, writeRunVerdict } from "./run-report.js";
import { describeTokens, mergeTokenTotals, toApiTokens, zeroTokens } from "./tokens.js";
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
  /**
   * How a provider becomes a driver. Defaulted to the two real ones.
   *
   * IT IS HERE BECAUSE THE BUILD PHASE IS NOW A SEQUENCE, NOT A CALL. Two
   * `builder.build()` calls against one session, with a park, a lock and a
   * node-id remap between them — and every one of those decisions is invisible
   * to a test that cannot see the requests. Constructing the driver inline (as
   * this file did until Phase 2b) meant the ONLY way to observe the sequencing
   * was to spend the owner's subscription, which is a test nobody runs twice and
   * therefore a sequencing nobody checks.
   *
   * ONE FACTORY, BOTH CALL SITES — `#buildPhase` and `#runFixTask`. Two would
   * drift, and the drift would be a fix round running against a different driver
   * from the build it is fixing.
   */
  readonly makeBuilder?: (provider: ApiProvider) => SubscriptionBuilder;
  /**
   * How the DESIGN preflight probes the machine, and whether a directory is
   * writable. Defaulted to the real ones (`execCommandRunner`, `canWriteDir`).
   *
   * INJECTED FOR THE SAME REASON `design-capability.ts` injects them one level
   * down: the real runner spawns `npx impeccable`, which reaches a registry. A
   * preflight whose tests need a network is a preflight nobody runs, and a
   * SEQUENCING test that pays 20 seconds per run to learn nothing about
   * sequencing is worse than that.
   */
  readonly designRun?: CommandRunner;
  readonly designCanWrite?: (dir: string) => boolean;
}

/**
 * What the build phase came back with.
 *
 * THREE STATES, AND `parked` IS THE ONE THAT DID NOT EXIST BEFORE. `#buildPhase`
 * used to return `BuildOutcome | null`, and `#execute` read `null` as "the run
 * was cancelled" — it calls `#cancelled`, which calls `#finish("cancelled")`,
 * which makes `isTerminal` true. A design park returning `null` would therefore
 * mark the run cancelled AND unresumable, so the owner's click would land on a
 * run the resume route already refuses. The plan wrote `return null` here; this
 * discriminated union is what that line has to be instead, and
 * "an ASK run parks at awaiting_input" is the assertion that says so.
 */
type BuildPhaseResult =
  | { readonly kind: "outcome"; readonly outcome: BuildOutcome; readonly laneMode: DesignLaneMode }
  | { readonly kind: "cancelled" }
  | { readonly kind: "parked" };

/** No preflight was run, because the pure surface gate already said "off". */
const NO_PREFLIGHT: DesignPreflight = { checks: [], ok: true, blockers: [] };

interface ActiveRun {
  readonly runId: string;
  readonly abort: AbortController;
}

/**
 * What one gate attempt produced.
 *
 * Three states, kept apart on purpose: a `record` with a verdict, a `container`
 * with the machine-readable detail behind it, and a `failure` explaining a gate
 * that could not run at all. A gate that could not run must never be
 * indistinguishable from a gate that passed.
 */
interface GateOutcome {
  readonly record: ScoreRecord | null;
  readonly container: ContainerResult | null;
  readonly failure: string | null;
}

/* -------------------------------------------------------------------------
 * THE RECORDED NETWORK POLICY — derived from the builder's sandbox, never
 * asserted about it.
 *
 * `run.json`'s `heldConstants.sandbox.networkPolicy.egress` read `"denied"`
 * until 2026-07-30, and that was FALSE — disproved by execution, not by
 * reading: in the 2026-07-29 live run six `gemini-image.sh` calls made from
 * inside the sandboxed build reached `generativelanguage.googleapis.com` and
 * came back with image bytes. `builders/claude-builder.ts` configures
 * `sandbox.filesystem` and NO `sandbox.network` clause at all, so nothing
 * restricted egress and nothing ever had.
 *
 * It was the strongest claim in the record and the only one nobody had checked.
 * The two fields beside it go out of their way to say "not a container digest";
 * this one quietly certified a boundary that did not exist, and every score
 * taken with it carried that certification.
 * ---------------------------------------------------------------------- */

/**
 * The part of the CLI's `sandbox` settings that decides egress.
 *
 * Structurally typed against `SandboxSettings["network"]` from the agent SDK
 * rather than imported from it: this module records what the builder
 * configured, and a structural parameter keeps the recording independent of the
 * SDK's option surface while still accepting the real object (asserted in
 * orchestrator.test.ts, which passes `buildOptions(...).sandbox?.network`).
 */
export interface BuilderNetworkClause {
  readonly allowedDomains?: readonly string[];
  readonly deniedDomains?: readonly string[];
  readonly strictAllowlist?: boolean;
}

/**
 * NOT ONE OF THE CONTRACT'S TWO VALUES, DELIBERATELY.
 *
 * `NetworkPolicy["egress"]` is `"denied" | "pinned-mirror-only"`
 * (bakeoff/src/contracts.ts) — a union in which BOTH members assert a
 * restriction. The dashboard builder enforces neither, so every value the type
 * offers is a false statement, and a false "denied" is exactly the defect being
 * fixed. The cast writes the truth instead and is safe here for a reason that
 * was checked rather than assumed: the dashboard writes `run.json` at ONE site
 * and NOTHING reads it back. `bakeoff`'s `loadRunRecords` discovers work by
 * scanning for `run.jsonl` (score-run.ts), `results-io.parseHeldConstants` is
 * never pointed at a dashboard record, and paths.ts keeps the dashboard's tree
 * outside `bakeoff/` so a campaign `score` cannot find one. Should that ever
 * change, `parseHeldConstants` REFUSING this value is the correct outcome — a
 * dashboard run must not aggregate into the bake-off's metrics, and the sibling
 * `imageDigest: "not-a-container-digest"` is already refused by
 * `assertSandboxSealed` for the same reason.
 */
const UNRESTRICTED_EGRESS_LABEL: string = "unrestricted-host-network (NOT a measured denial)";
const CONFIGURED_BUT_UNVERIFIED_LABEL: string = "restriction-configured-but-unmeasured";

/**
 * Does this clause restrict anything?
 *
 * AN EMPTY CLAUSE RESTRICTS NOTHING, and it must take the same branch as no
 * clause at all. Every field on `sandbox.network` is optional, so `{}` configures
 * no allow-list, no deny-list and no strict mode; reporting that as "a
 * restriction is configured" would be this module committing the exact defect it
 * exists to undo, one level down.
 */
function restrictsEgress(clause: BuilderNetworkClause): boolean {
  return (
    (clause.deniedDomains?.length ?? 0) > 0 ||
    (clause.allowedDomains?.length ?? 0) > 0 ||
    clause.strictAllowlist === true
  );
}

/**
 * What the run record may say about egress, given what the builder configured.
 *
 * IT CANNOT RETURN `"denied"`, and that is the point rather than an oversight.
 * A denial is a MEASUREMENT: `bakeoff`'s runner earns the word by running
 * `docker run --network none` and then probing a public address from inside the
 * container and requiring the probe to FAIL (runner.ts, `egressDenied`). This
 * function sees a configuration object, so the strongest thing it can honestly
 * report about a configured restriction is that one is configured and nobody
 * has probed it. A reader must not be able to mistake either return value for a
 * measured denial.
 */
export function recordedNetworkPolicy(clause: BuilderNetworkClause | undefined): NetworkPolicy {
  if (clause === undefined || !restrictsEgress(clause)) {
    return {
      egress: UNRESTRICTED_EGRESS_LABEL as NetworkPolicy["egress"],
      // NOT EMPTY, because "no hosts allowed" is how an empty list reads next to
      // an egress field, and the contract says as much ("Empty when egress is
      // `denied`"). The pseudo-entry follows `imageRef`/`imageDigest`'s
      // convention of saying plainly that the field does not hold what its name
      // promises.
      allowedHosts: ["<no allow-list: the build reaches any host the host machine can reach>"],
    };
  }
  return {
    egress: CONFIGURED_BUT_UNVERIFIED_LABEL as NetworkPolicy["egress"],
    allowedHosts: [...(clause.allowedDomains ?? [])],
  };
}

/**
 * The sandbox the dashboard builder actually runs in.
 *
 * `undefined` is the claim that `builders/claude-builder.ts` sets no
 * `sandbox.network`, and it is not left as a comment: orchestrator.test.ts calls
 * `buildOptions(...)` and requires `sandbox?.network === undefined`, so adding a
 * network clause to the builder turns this line red instead of leaving the
 * record behind.
 */
export const DASHBOARD_SANDBOX: SandboxSpec = Object.freeze({
  imageRef: "host-subprocess (no container: the dashboard builder runs on the host)",
  imageDigest: "not-a-container-digest",
  networkPolicy: recordedNetworkPolicy(undefined),
});

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  #active: ActiveRun | null = null;
  #pumping = false;
  #stopped = false;
  /**
   * The live half of §17.3 rule 1's bound, one timer per parked run.
   *
   * IT IS THE LIVE HALF AND NOT THE BOUND. A timer lives in a process a restart
   * destroys, and `awaiting_input` has no other exit — so `reconcileOnBoot`
   * carries the durable half, reading `parkedAt` off `design-lock.json` and
   * either finishing an expired park or re-arming this map for the REMAINDER of
   * the window. Neither half alone bounds anything.
   */
  readonly #designLockTimers = new Map<string, NodeJS.Timeout>();

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
  resume(runId: string, chosenMockup: string | null = null): boolean {
    const row = this.#deps.store.getRun(runId);
    if (row === null || isTerminal(row.status)) return false;
    if (this.#active !== null && this.#active.runId === runId) return false;

    // THE DESIGN-LOCK BRANCH COMES FIRST, and the existing body below is exactly
    // what segment 2 needs afterwards: requeue, re-execute, and `nextBuildSegment`
    // takes the build arm because the manifest is now locked.
    //
    // GATED ON THE PARK RECORD, NOT ON `awaiting_input`. `reconcileOnBoot` sets
    // that status for ANY run whose builder subprocess died with the server,
    // including one interrupted halfway through the DESIGN segment — and locking
    // a half-finished manifest would skip the rest of the lane while looking like
    // an owner's choice. `design-lock.json` with `awaiting: true` is written by
    // `#parkForDesignLock` and by nothing else, so it names the one state a
    // chosen mockup applies to.
    const runPaths = runPathsFor(this.#deps.paths, runId);
    const park = readDesignLock(runPaths.results);
    if (row.status === "awaiting_input" && park !== null && park.awaiting) {
      const manifest = readDesignManifest(runPaths.workspace);
      if (manifest !== null && manifest.lockedMockup === null) {
        const at = new Date().toISOString();
        const attempt: LockAttempt | null =
          chosenMockup === null
            ? (readChoiceFile(refsDirFor(runPaths.workspace), manifest, at) ??
              fallbackChoice(manifest, at, "no owner choice arrived before the timeout"))
            : // TRANSLATED, BECAUSE A CLICK CANNOT CARRY A REF. What the owner
              // clicks is `designLock.mockups[].path` — the PUBLISHED COPY, which
              // is the only mockup path the screenshot route can serve and so the
              // only one on the wire — while `lockManifest` accepts a workspace
              // ref by exact equality. Passing the wire value straight through is
              // how this route came to refuse every real click.
              //
              // A PATH THAT IS NEITHER SURVIVES UNCHANGED and `lockManifest`
              // refuses it below, naming the path the client sent. The refusal is
              // the security property (an arbitrary path must never become the
              // gate's reference), so it stays in one place.
              {
                path: chosenMockupRef(manifest, this.#mockupDir(runId), chosenMockup),
                by: "owner",
                reason: "chosen by the owner in the dashboard",
                at,
              };
        // A REFUSED CHOICE LEAVES THE RUN PARKED. Resuming anyway would build to
        // no design at all while the API had just answered 200.
        if (!this.#applyDesignLock(runId, runPaths, manifest, attempt)) return false;
      }
    }
    this.#clearDesignLockTimer(runId);

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
    // §17.3 RULE 1, THE DURABLE HALF. Every design park is bounded by a timer,
    // and a timer lives in a process a restart destroys. WITHOUT THIS LOOP A
    // RESTART DURING A PARK IS AN INFINITE PARK: `awaiting_input` has no other
    // exit, and the run waits for a click that a cron submission was never going
    // to produce.
    for (const row of this.#deps.store.listByStatus("awaiting_input")) {
      const paths = runPathsFor(this.#deps.paths, row.runId);
      const park = readDesignLock(paths.results);
      if (park === null || !park.awaiting) continue;
      if (designLockExpired(park.parkedAt, new Date().toISOString(), designLockTimeoutMin(this.#deps.env))) {
        this.#emitLog(row.runId, "warn", "the design-lock window expired while the dashboard was down");
        this.resume(row.runId, null);
      } else {
        // RE-ARMED FOR THE REMAINDER, not for a fresh window: `#parkForDesignLock`
        // is given the ORIGINAL `parkedAt`, so a dashboard that restarts every
        // few minutes cannot push the deadline forward each time.
        this.#parkForDesignLock(row.runId, paths, park.parkedAt);
      }
    }
    this.pump();
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    // A pending park timer holds a callback that writes to the store. `unref()`
    // covers process exit and nothing else — a host that shuts the orchestrator
    // down and closes the database still has these armed.
    for (const runId of [...this.#designLockTimers.keys()]) this.#clearDesignLockTimer(runId);
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
      this.#recordUnmeasuredBacklog(runId, "infra", detail);
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
      // TWO SEGMENTS, ONE SESSION. `#buildPhase` runs the DESIGN segment and the
      // BUILD segment against one `session_id`, with the lock between them.
      this.#setPhase(runId, "build");
      const built = await this.#buildPhase(runId, ticket, runPaths, log, signal);
      if (built.kind === "cancelled") return this.#cancelled(runId, log);
      if (built.kind === "parked") {
        // NOT TERMINAL, AND NOT A VERDICT. The run is `awaiting_input` with its
        // mockups registered; segment 2 starts when `resume` applies a lock. No
        // `#finish`, so nothing writes a verdict for a run that has not finished.
        log.close();
        return;
      }
      const outcome = built.outcome;
      const laneMode = built.laneMode;

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

      // ---- PHASE 3: the sealed gate, then the bounded fix loop ---------
      this.#setPhase(runId, "gate");
      const loop = await this.#gateFixLoop(runId, ticket, suite, runPaths, log, declaredDone, laneMode, signal);
      const scored = loop.scored;

      // A fix round that ran into the provider's window is not a failed run.
      // The workspace, the session and the frozen suite are intact, exactly as
      // when the BUILD hits it, so it takes the same exit.
      if (loop.rateLimit !== null) {
        log.close();
        this.#rateLimited(runId, loop.rateLimit, this.#deps.store.getRun(runId)?.builderSessionId ?? null);
        return;
      }

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

  /**
   * The build phase: TWO `builder.build()` calls against ONE session.
   *
   * SEGMENT 1 IS THE DESIGN LANE, and its `allowedAgents` is narrowed to the SPEC
   * and DESIGN lanes — so the `PreToolUse` delegation hook, the slot probe A
   * measured the engine actually asks, is what stops BUILD starting before a
   * design is locked. Nothing depends on the model choosing to stop, and the
   * prompt's "do not start implementation" line is a courtesy on top of a
   * boundary rather than the boundary itself.
   *
   * SEGMENT 2 RESUMES SEGMENT 1's `session_id` with the locked mockup's absolute
   * path in its prompt. One session means one root node, real `parent_tool_use_id`
   * edges, and one id for the resume path to persist — which is precisely why
   * §6.1 rejected the lane-per-query model.
   *
   * BETWEEN THEM the run either PARKS (`designLock: "ask"`) or locks through
   * `ui-designer`'s `choice.json` (`"auto"`). A park returns `{kind:"parked"}`
   * and segment 2 starts on `resume`; there is no third call in either case.
   *
   * AND A LANE WITH `laneMode === "off"` TAKES EXACTLY ONE PASS with exactly the
   * prompt and the shortlist it had before this phase existed — `designHandoffSection`
   * returns "" for `off`, so a cli/api/library run's prompt is byte-identical.
   */
  async #buildPhase(
    runId: string,
    ticket: Ticket,
    runPaths: RunPaths,
    log: BuildLog,
    signal: AbortSignal,
  ): Promise<BuildPhaseResult> {
    const store = this.#deps.store;
    const row0 = store.getRun(runId);
    if (row0 === null) return { kind: "cancelled" };

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

    const entry = await this.#deps.catalog.resolve(row0.modelId);
    if (entry === null || !entry.option.available) {
      throw new BakeoffError(
        "unknown_config",
        `model ${row0.modelId} is not available: ${entry?.option.reason ?? "not in the catalog"}`,
        "Pick an available model, or authenticate its CLI (`claude setup-token` / `codex login`) and " +
          "resume the run. No API key is required or accepted.",
      );
    }

    const builder = this.#builderFor(entry.option.provider);

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
    const surface = classifySurface(ticket.brief);
    const laneMode = await this.#designLaneFor(runId, ticket, runPaths, surface);
    // NOW WITH THE LANE MODE, AT BOTH CALL SITES. `agent-shortlist.ts` says the
    // one-argument form defaults to `off` and under-delegates on purpose, which
    // was a live regression until this line and `#gateFixLoop`'s twin.
    const fullShortlist = shortlistFor(surface, laneMode);
    // SEGMENT 1's DELEGATION BOUNDARY. SPEC because `context-manager` "runs this
    // one first; it owns the context the later lanes read", DESIGN because that
    // is the lane, and nothing else — a BUILD-lane `subagent_type` is denied by
    // the hook rather than discouraged by the prompt.
    const designLanes = new Set<string>([...DELIVERY_LANES.spec, ...DELIVERY_LANES.design]);

    let last: BuildOutcome | null = null;
    // AT MOST TWO PASSES, and the bound is structural rather than defensive:
    // `nextBuildSegment` returns a design segment only while the design is
    // unfinished, and the first pass sets `designSegmentDone`.
    for (let pass = 0; pass < 2; pass += 1) {
      // RE-READ, because the previous pass wrote `builderSessionId` and
      // `designSegmentDone`, and those two are exactly what decides this one.
      const row = store.getRun(runId);
      if (row === null) return { kind: "cancelled" };
      const manifest = readDesignManifest(runPaths.workspace);
      const segment = nextBuildSegment({
        laneMode,
        manifestExists: manifest !== null,
        manifestLocked: manifest?.lockedMockup != null,
        sessionId: row.builderSessionId,
        designSegmentDone: row.designSegmentDone,
      });
      const designSegment = segment === "design" || segment === "design-resume";
      const allowedAgents = designSegment
        ? fullShortlist.filter((agent) => designLanes.has(agent))
        : fullShortlist;
      const policy = designLockPolicy(row.designLock, row.interactive);
      // FOLDED FROM THE DURABLE ROWS, not from memory, for the same reason
      // `graphSnapshot` is: a park can outlive the process, so there is no
      // in-memory segment-1 state to read on the second segment. Read HERE
      // rather than beside `remap` below because the video lane needs it too,
      // and it needs it before the prompt exists.
      const priorGraph = store
        .eventsSince(runId, 0)
        .map((stored) => stored.event)
        .filter((event): event is GraphSseEvent => event.type.startsWith("graph_"));

      /* ---- THE IMAGE→VIDEO LANE (spec §7.6), before the build is prompted --
       *
       * BUILD SEGMENT ONLY, AND THAT IS THE SPEND CONTROL. The design segment is
       * what WRITES `animate` into the manifest, so running the lane there would
       * plan against a file that does not exist yet; and the loop reaches a
       * non-design segment exactly once per entry (`if (!designSegment) return`
       * below). Re-entry by `resume` is guarded inside `runVideoLane`, by the
       * record this run already wrote.
       *
       * THE CAPABILITY IS RESOLVED FROM THE RUN'S OWN ENVIRONMENT, never
       * `process.env` — the same reason `designRun` in the tests hands the
       * orchestrator a temp `HOME`. `videoCapability` derives the script path
       * from `home`, so a run whose HOME has no `gemini-video.sh` degrades, and
       * no test on a machine that HAS the script can reach a metered Veo call by
       * accident.
       *
       * THE GRAPH EVENTS DO NOT GO THROUGH `sink.graph`. That applies `remap`,
       * which mints a FRESH id for any node it has not seen — and a fresh id is
       * one `foldGraph` has never heard of, so the pill would be dropped
       * (`graph.ts:180-183`). The lane's node is the run's existing ROOT, read
       * off the durable stream by the same `graphResumeState` the remap uses.
       */
      const videoCap = videoCapability({
        ...defaultVideoCapabilityDeps(),
        env: this.#deps.env,
        home: this.#deps.env["HOME"] ?? "",
      });
      const { prompt: videoPrompt } = designSegment
        ? { prompt: "" }
        : await runVideoLane({
            workspace: runPaths.workspace,
            recordPath: runPaths.videoRecord,
            node: graphResumeState(priorGraph).rootNode ?? "",
            env: this.#deps.env,
            capability: videoCap,
            // The manifest this pass already read. A second `readDesignManifest`
            // here would be a second derivation of one path, and the plan's own
            // hand-rolled `JSON.parse(join(workspace,"design-refs",…))` is
            // exactly that.
            readManifest: () => manifest,
            spawnLeg: defaultSpawnLeg(videoCap.scriptPath ?? ""),
            emitGraph: (event) => this.#emit(runId, event),
            writeRecord: (path, json) => {
              writeFileSync(path, json, "utf8");
            },
            ensureDir: (path) => {
              mkdirSync(path, { recursive: true });
            },
            fileExists: (path) => existsSync(path),
          });

      const prompt = designSegment
        ? designSegmentPrompt({
            ticketText: ticket.brief,
            workspace: runPaths.workspace,
            mode: laneMode,
            capability: this.#capability(),
            autoChoose: policy === "auto",
          })
        : // APPENDED UNCONDITIONALLY. `videoPrompt` is "" whenever there are no
          // legs, so a degraded lane adds nothing; §7.3 mechanism 2 is why the
          // ABSOLUTE paths have to be in the prompt at all — a path in a prompt
          // is what makes a `Read`/`fetch` actually happen.
          this.#buildSegmentPrompt(row, ticket, runPaths, manifest, laneMode, fullShortlist) +
          (videoPrompt === "" ? "" : `\n\n${videoPrompt}\n`);
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
      // WHAT THE ROW ALREADY HELD, CAPTURED BEFORE THIS SEGMENT WRITES TO IT.
      //
      // CAPTURED, NOT RE-READ, AND THAT IS LOAD-BEARING IN TWO DIRECTIONS. The
      // `tokens` sink below ASSIGNS the row on every token event, and the value
      // it is handed is cumulative WITHIN this segment (`claude-builder.ts`
      // builds it with `addTokens(running, …)`). So `carried + totals` is the
      // run's spend at every point in the stream, while `row.tokens + totals`
      // read live would add this segment's growing total to itself once per
      // event. `design-segment-probe.mjs` measured that totals are PER-CALL
      // across segments, which is why the merge is a sum at all.
      const carried = row.tokens;
      let imageCalls = 0;
      const imageScript = this.#capability().imageScript;
      const imageScriptName = imageScript === null ? null : basename(imageScript);
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
      // THE NODE-ID REMAP, AT THE SEAM IT PROTECTS. `GraphProjection` mints from
      // `n1` PER BUILD CALL and `foldGraph` IGNORES a repeated node id rather
      // than overwriting, so without this segment 2's `graph_agent` for `n2` is
      // dropped and every later `graph_tool{node:"n2"}` attaches to segment 1's
      // `n2` — the canvas renders perfectly and attributes the build's work to
      // the designer.
      const remap =
        priorGraph.length === 0
          ? (event: GraphSseEvent): GraphSseEvent => event
          : makeSegmentRemap(graphResumeState(priorGraph));

      const sink: BuildEventSink = {
        log: (level, text) => this.#emitLog(runId, level, text),
        tool: (name, summary) => {
          // THE DESIGN LANE'S SPEND, AS A COUNT. Attempts INCLUDING retries,
          // which is what makes a zero-image failure say "after 3 generation
          // attempts" rather than "after 0" — two sentences pointing at
          // completely different faults. Never a dollar figure: `gemini-image.sh`
          // prints an output path and the API response carries no price.
          if (designSegment && imageScriptName !== null && summary.includes(imageScriptName)) {
            imageCalls += 1;
          }
          this.#emit(runId, { type: "tool", name, summary });
        },
        tokens: (totals) => {
          tokens = totals;
          const merged = mergeTokenTotals(carried, toApiTokens(totals));
          store.updateRun(runId, { tokens: merged });
          this.#emit(runId, { type: "tokens", ...merged });
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
        graph: (event) => this.#emit(runId, remap(event)),
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
        `${row.builderSessionId === null ? "starting" : "resuming"} the ${designSegment ? "DESIGN" : "BUILD"} ` +
          `segment with ${entry.option.label}` +
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
        // NARROWED FURTHER ON SEGMENT 1, which is the whole two-segment design:
        // the design lock is enforced by what the hook denies, not by the model
        // agreeing to stop.
        allowedAgents,
        modelId: row.modelId,
        effort: entry.effort,
        resumeSessionId: row.builderSessionId,
        signal,
        sink,
        // TMPDIR INSIDE THE WORKSPACE AND THE MOTION-BAR FLIP (design-env.ts).
        // The motion bar is armed for the BUILD segment only: it is a Stop hook
        // that holds a session open until the page satisfies the Layer-2 motion
        // bar, and the DESIGN segment writes stills and prose rather than markup —
        // arming it there would hold the design lane open against a criterion it
        // was never going to meet.
        env: designSubprocessEnv(this.#deps.env, {
          workspace: runPaths.workspace,
          motionBar: !designSegment && laneMode !== "off",
        }),
      });

      last = outcome;
      if (outcome.sessionId !== null) store.updateRun(runId, { builderSessionId: outcome.sessionId });
      if (outcome.tokens.callCount > 0) {
        store.updateRun(runId, { tokens: mergeTokenTotals(carried, toApiTokens(outcome.tokens)) });
        this.#emitLog(runId, "info", `builder — ${describeTokens(outcome.tokens)}`);
      } else if (tokens.callCount > 0) {
        this.#emitLog(runId, "info", `builder — ${describeTokens(tokens)}`);
      }
      if (outcome.cancelled) return { kind: "cancelled" };
      if (outcome.failure !== null) {
        this.#emitLog(runId, "warn", `the build did not complete cleanly: ${outcome.failure}`);
        store.updateRun(runId, { failureReason: outcome.failure });
      }
      // A rate-limited segment stops here with its session intact; `resume`
      // re-enters this loop and `nextBuildSegment` picks the same segment up.
      if (outcome.rateLimit.limited) return { kind: "outcome", outcome, laneMode };
      if (!designSegment) return { kind: "outcome", outcome, laneMode };

      /* ---- the design segment came back; say what it produced ---------- */
      store.updateRun(runId, { designSegmentDone: true });
      const after = readDesignManifest(runPaths.workspace);
      const record = classifyDesignLane({
        mode: laneMode,
        manifest: after,
        // FROM DISK, never from the manifest's claims: `classifyDesignLane`
        // compares the two, and a count taken from the manifest would make "five
        // refs over three files" undetectable by construction.
        pngCount: countDesignPngs(refsDirFor(runPaths.workspace)),
        imageCalls,
        keySource: this.#capability().key.source,
        preflight: this.#preflight.checks,
      });
      writeDesignLaneRecord(runPaths.results, record);
      // THE TRAP. A DESIGN lane that produced zero images must never look
      // successful, so this is an error-level line and a `failureReason` rather
      // than an absence of PNGs nobody counted.
      const designFailure = designLaneFailureMessage(record);
      if (designFailure !== null) {
        this.#emitLog(runId, "error", designFailure);
        store.updateRun(runId, { failureReason: designFailure });
      }
      this.#recordDesignMockups(runId, after);

      if (after !== null && after.lockedMockup === null) {
        if (policy === "ask") {
          this.#parkForDesignLock(runId, runPaths);
          return { kind: "parked" };
        }
        const at = new Date().toISOString();
        const attempt =
          readChoiceFile(refsDirFor(runPaths.workspace), after, at) ??
          fallbackChoice(after, at, "ui-designer wrote no choice.json");
        this.#applyDesignLock(runId, runPaths, after, attempt);
      }
      // …and round again, into the BUILD segment, on the same session.
    }
    return last === null ? { kind: "cancelled" } : { kind: "outcome", outcome: last, laneMode };
  }

  /**
   * The driver for a provider. One factory, both call sites.
   *
   * `makeBuilder` is optional on {@link OrchestratorDeps}, so a host that does
   * not pass one gets exactly the two real drivers this file constructed inline
   * until Phase 2b.
   */
  #builderFor(provider: ApiProvider): SubscriptionBuilder {
    const make = this.#deps.makeBuilder;
    if (make !== undefined) return make(provider);
    return provider === "openai" ? new CodexSubscriptionBuilder() : new ClaudeSubscriptionBuilder();
  }

  /**
   * The DESIGN capability of this machine — which script, which key SOURCE.
   *
   * NEVER THE KEY VALUE. `GeminiKeyResolution` carries which of
   * `$GEMINI_API_KEY` / `$NANOBANANA_API_KEY` / `~/.gemini/api_key` resolved and
   * nothing else, and the two variables are deliberately absent from
   * `STRIPPED_ENV_NAMES` so they reach the subprocess — which is exactly why
   * nothing here may print one.
   */
  #capability(): ReturnType<typeof detectDesignCapability> {
    const homeDir = this.#deps.env["HOME"] ?? homedir();
    return detectDesignCapability({
      env: this.#deps.env,
      homeDir,
      imageScript: designScriptPath(this.#deps.env, homeDir),
    });
  }

  /**
   * The preflight this run computed. Set once by `#designLaneFor`, read by the
   * lane record so `degradeReasonFrom` can name the check that actually failed
   * instead of inventing a cause.
   *
   * ONE ACTIVE RUN, so one field is one run's — `#active` is the invariant this
   * leans on, and it is the same invariant the whole queue rests on.
   */
  #preflight: DesignPreflight = NO_PREFLIGHT;

  /**
   * Which of the DESIGN lane's three states this run is in.
   *
   * THE PURE GATE RUNS FIRST, AND THAT ORDER IS NOT A MICRO-OPTIMISATION.
   * `designSurfaceGate` is the only term that can answer "off", and the preflight
   * spawns `npx` — so a cli/api/library ticket would otherwise pay a registry
   * probe to be told it has no design lane.
   *
   * DEGRADE IS A STATE, NOT AN ABSENCE. A failing preflight moves the lane to
   * `degraded`, where `taste-frontend-expert` still art-directs and writes
   * `direction.md`; it never turns the lane off. Blocking a build on an absent
   * image key is a worse failure than shipping without mockups.
   */
  async #designLaneFor(
    runId: string,
    ticket: Ticket,
    runPaths: RunPaths,
    surface: ReturnType<typeof classifySurface>,
  ): Promise<DesignLaneMode> {
    const capability = this.#capability();
    this.#preflight = designSurfaceGate(surface, ticket.brief)
      ? await designPreflight({
          env: this.#deps.env,
          homeDir: this.#deps.env["HOME"] ?? homedir(),
          workspace: runPaths.workspace,
          capability,
          run: this.#deps.designRun ?? execCommandRunner,
          canWrite: this.#deps.designCanWrite ?? canWriteDir,
        })
      : NO_PREFLIGHT;
    for (const check of this.#preflight.checks) {
      if (!check.ok) {
        this.#emitLog(runId, check.blocking ? "warn" : "info", `design preflight — ${check.detail}`);
      }
    }
    const mode = designLaneMode({
      surface,
      ticketText: ticket.brief,
      capability,
      preflightOk: this.#preflight.ok,
    });
    if (mode !== "off") {
      this.#emitLog(
        runId,
        mode === "full" ? "info" : "warn",
        mode === "full"
          ? "the DESIGN lane runs in FULL mode: stills, a manifest, and a locked reference for the gate"
          : "the DESIGN lane is DEGRADED: written art direction, no stills, and the visual gate falls " +
              "back to rule-based scoring with no reference image",
      );
    }
    return mode;
  }

  /**
   * Segment 2's prompt: the existing build prompt PLUS §7.3's handoff block.
   *
   * THE ONLY PLACE THE TWO ARE JOINED, so a resumed build cannot lose the design
   * by taking a different branch — which is exactly what
   * `resumeBuilderPrompt("the dashboard was interrupted")` would do after a lock:
   * a sentence that is false and that names no mockup.
   *
   * THE HANDOFF GOES LAST, closest to the work, and an empty one appends nothing —
   * so a non-design run's prompt is byte-identical to what it was before this
   * phase.
   */
  #buildSegmentPrompt(
    row: RunRow,
    ticket: Ticket,
    runPaths: RunPaths,
    manifest: DesignManifest | null,
    laneMode: DesignLaneMode,
    shortlist: readonly string[],
  ): string {
    const base =
      row.builderSessionId === null
        ? dashboardBuilderPrompt({
            ticketText: ticket.brief,
            workspaceDir: runPaths.workspace,
            allowedAgents: shortlist,
          })
        : resumeBuilderPrompt(
            manifest?.lockedMockup != null
              ? "the design was locked and the build continues from there"
              : row.rateLimited
                ? "the provider's rate-limit window was exhausted"
                : "the dashboard was interrupted",
          );
    const handoff = designHandoffSection({
      // PRUNED, NOT RAW. `classifyDesignLane` has already recorded the
      // discrepancy for the report; the PROMPT must carry only paths that
      // resolve, or a partial lane becomes a `Read` failure inside every build
      // agent, several turns deep, reported as the agent's confusion rather than
      // as a design fault.
      manifest: manifest === null ? null : pruneMissingRefs(manifest),
      mode: laneMode,
      workspace: runPaths.workspace,
      dials: readDesignDirection(runPaths.workspace),
    });
    return handoff.length === 0 ? base : `${base}\n\n${handoff}`;
  }

  /**
   * The one directory a mockup is published into, DERIVED IN ONE PLACE.
   *
   * `#recordDesignMockups` writes the copies here and `resume` reconstructs their
   * paths from here to translate a click back into a ref. Deriving it twice is a
   * lock that refuses every click again the moment the two expressions drift — a
   * missing `safeSegment` on one side would be enough — and the symptom is a run
   * that parks for the full timeout, not an error.
   *
   * `safeSegment` because `serveScreenshot` in http.ts resolves the same directory
   * that way; a copy written outside it is a card the browser cannot load.
   * (`#recordScreenshots` builds the GATE captures' directory without it — a
   * pre-existing inconsistency this method deliberately does not silently change.)
   */
  #mockupDir(runId: string): string {
    return join(this.#deps.paths.results, "screenshots", safeSegment(runId));
  }

  /**
   * Every mockup, as a screenshot the EXISTING route already serves (§17.1).
   *
   * COPIED rather than referenced: `serveScreenshot` resolves under
   * `results/screenshots/<runId>/` and the workspace is the artefact, not a
   * served directory. Prefixed with `design-` so a mockup can never collide with
   * a gate screenshot's basename.
   *
   * A REF THAT CANNOT BE COPIED IS A WARNING, NEVER A THROW. `parseDesignManifest`
   * validates a ref's PATH, not its existence, so a `manifest-invalid` lane
   * (five refs over three files) reaches here with a path to nothing — and an
   * ENOENT escaping this method would surface as a harness fault and REPLACE the
   * loud-but-non-blocking design failure that was just recorded. This is the
   * record of the run, not the run.
   */
  #recordDesignMockups(runId: string, manifest: DesignManifest | null): void {
    if (manifest === null || manifest.refs.length === 0) return;
    const dir = this.#mockupDir(runId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.#emitLog(runId, "warn", `the mockups could not be published: ${describeError(error)}`);
      return;
    }
    for (const ref of manifest.refs) {
      const target = publishedMockupPath(dir, ref.path);
      try {
        copyFileSync(ref.path, target);
      } catch (error) {
        this.#emitLog(runId, "warn", `the mockup ${ref.path} could not be published: ${describeError(error)}`);
        continue;
      }
      const label = `${DESIGN_MOCKUP_LABEL}${ref.section}`;
      this.#deps.store.addScreenshot(runId, { path: target, label, capturedAt: new Date().toISOString() });
      this.#emit(runId, { type: "screenshot", path: target, label });
    }
  }

  /**
   * Validate the attempt, write it into BOTH places, and say whether it took.
   *
   * TWO PLACES ON PURPOSE: `manifest.json` inside the workspace, because that is
   * what the build agents and the visual gate read; and `design-lock.json` beside
   * the run record, because §17.3 rule 5 makes a locked design a recorded INPUT
   * to the gate and the workspace is the artefact, not the record.
   *
   * FALSE MEANS THE RUN STAYS PARKED. A refused choice that resumed anyway would
   * build to no design at all while the API had just answered 200.
   */
  #applyDesignLock(
    runId: string,
    runPaths: RunPaths,
    manifest: DesignManifest,
    attempt: LockAttempt | null,
  ): boolean {
    if (attempt === null) {
      this.#emitLog(runId, "warn", "there is nothing to lock: the DESIGN lane produced no mockups");
      return false;
    }
    const result = lockManifest(manifest, attempt);
    if (!result.ok) {
      this.#emitLog(runId, "warn", `the design lock was refused: ${result.error}`);
      return false;
    }
    writeDesignManifest(runPaths.workspace, result.manifest);
    writeDesignLock(runPaths.results, {
      awaiting: false,
      parkedAt: attempt.at,
      locked: attempt.path,
      lockedBy: attempt.by,
      reason: attempt.reason,
    });
    this.#emitLog(runId, "info", `design locked by ${attempt.by}: ${attempt.path} — ${attempt.reason}`);
    return true;
  }

  /**
   * The park: `awaiting_input`, the record on disk, and the timer that ends it.
   *
   * `parkedAt` IS AN ARGUMENT so `reconcileOnBoot` can re-arm for the REMAINDER
   * of the original window rather than starting a fresh one — a dashboard that
   * restarts every few minutes would otherwise push the deadline forward each
   * time and rule 1's "never blocks indefinitely" would hold only on paper.
   */
  #parkForDesignLock(runId: string, runPaths: RunPaths, parkedAt = new Date().toISOString()): void {
    writeDesignLock(runPaths.results, {
      awaiting: true,
      parkedAt,
      locked: null,
      lockedBy: null,
      reason: null,
    });
    this.#deps.store.updateRun(runId, { status: "awaiting_input", queuePosition: null });
    this.#emit(runId, { type: "status", status: "awaiting_input" });
    const timeoutMin = designLockTimeoutMin(this.#deps.env);
    this.#emitLog(
      runId,
      "info",
      `the DESIGN lane produced its mockups and the run is waiting for one to be chosen. ` +
        `POST /api/runs/${runId}/resume {"chosenMockup":"<path>"} locks it; with no choice inside ` +
        `${String(timeoutMin)} minutes, ui-designer picks and the choice is recorded as automatic.`,
    );
    const remaining = Math.max(0, timeoutMin * 60_000 - Math.max(0, Date.now() - Date.parse(parkedAt)));
    this.#clearDesignLockTimer(runId);
    const timer = setTimeout(() => {
      this.#designLockTimers.delete(runId);
      this.#emitLog(runId, "warn", "no design choice arrived before the timeout; selecting automatically");
      this.resume(runId, null);
    }, remaining);
    // §17.3 rule 1: never blocks indefinitely. `unref` so a park never holds the
    // process open on shutdown — which is NOT the same as cancelling it, hence
    // `shutdown()` clearing the map as well.
    timer.unref();
    this.#designLockTimers.set(runId, timer);
  }

  #clearDesignLockTimer(runId: string): void {
    const timer = this.#designLockTimers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#designLockTimers.delete(runId);
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
    // TWO CALLERS ARE REQUIRED AND ONE WITHOUT THE OTHER PRODUCES ZERO PNGs
    // SILENTLY (design-env.ts says so in its own words). `designSubprocessEnv`
    // only NAMES this directory; `mktemp -d` against a TMPDIR that does not
    // exist fails exactly as loudly as a sandbox denial — which is to say, not
    // at all, on a stream `autoAllowBashIfSandboxed: true` keeps the permission
    // layer away from. It is created here, unconditionally: a non-design run
    // gets one empty dot-directory, and a design run gets a temp dir inside the
    // one tree `sandbox.filesystem.allowWrite` permits.
    mkdirSync(designTmpDirFor(runPaths.workspace), { recursive: true });
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

  /* ---- phase 3: the sealed gate, and the loop around it ---------------- */

  /**
   * Gate, triage, fix, re-gate — bounded, and honest when it stops.
   *
   * THE ADAPTER, NOT THE POLICY. Every decision (when to stop, what a fixing
   * agent may see, how work is routed) lives in `gate-fix-loop.ts`,
   * `gate-report.ts` and `fix-triage.ts`, which are tested without spending a
   * subscription. What is here is the two things only the orchestrator can
   * supply: the real sealed gate, and a real agent to run a fix with.
   *
   * `scored` IS THE LAST ATTEMPT'S SCORE RECORD and that is deliberate.
   * `heldOutPass` means exactly what it meant before this phase existed — the
   * verdict of the frozen suite on the artefact as it finally stands. The loop
   * re-gates; it does not re-define the verdict.
   *
   * THE BACKLOG IS WRITTEN ON EVERY EXIT, including green. A run that stops
   * without saying what is left is unactionable, and a missing file cannot be
   * told apart from a step that never ran.
   */
  async #gateFixLoop(
    runId: string,
    ticket: Ticket,
    suite: AcceptanceSuite,
    runPaths: RunPaths,
    log: BuildLog,
    declaredDone: boolean,
    laneMode: DesignLaneMode,
    signal: AbortSignal,
  ): Promise<{ scored: GateOutcome; result: GateFixLoopResult; rateLimit: RateLimitState | null }> {
    let scored: GateOutcome = { record: null, container: null, failure: null };
    let rateLimit: RateLimitState | null = null;

    // A fix round that hits the provider's rate-limit window must stop the loop
    // rather than let it re-gate an unchanged artefact and call that
    // non-convergence. A child controller aborts the loop without touching the
    // run's own signal, which the caller still owns.
    const loopAbort = childAbort(signal);

    // COMPUTED ONCE, HERE, AND NOWHERE ELSE. `runGateFixLoop` restarts its
    // attempt numbering at 1 on every entry — including after a resume — so the
    // slot a result is archived under is `attempt + archiveBase`, not `attempt`.
    // Recomputing it per attempt would be worse than not having it: attempt 1
    // would raise the base it is measured from and attempt 2 would land two
    // slots away, leaving a hole that reads as a lost attempt.
    const archiveBase = highestArchivedAttempt(this.#deps.paths, runId);
    if (archiveBase > 0) {
      this.#emitLog(
        runId,
        "info",
        `gate attempts already archived for this run: ${String(archiveBase)}. This resume archives from ` +
          `attempt-${String(archiveBase + 1)} so the earlier rounds survive.`,
      );
    }

    const result = await runGateFixLoop({
      gate: async (attempt) => {
        scored = await this.#gatePhase(
          runId,
          ticket,
          suite,
          runPaths,
          declaredDone,
          signal,
          archiveBase + attempt,
        );
        return scored.container;
      },
      runFix: async (task, prompt) => {
        const state = await this.#runFixTask(runId, task, prompt, runPaths, log, signal);
        if (state !== null && state.limited) {
          rateLimit = state;
          loopAbort.abort();
        }
      },
      maxAttempts: maxAttemptsFrom(this.#deps.env),
      workspace: runPaths.workspace,
      // The same shortlist the build ran behind, from the same classification of
      // the same string AND the same lane mode — `agent-shortlist.ts`'s
      // one-argument form defaults to `off`, so passing `laneMode` at only one of
      // the two call sites would let triage route work to a DESIGN agent the
      // build was allowed and the fix loop was not. A fix round is bounded
      // further, to one agent, in `fixAllowedAgents`; this is the outer set
      // triage is checked against.
      allowedAgents: shortlistFor(classifySurface(ticket.brief), laneMode),
      signal: loopAbort.signal,
      log: (level, text) => this.#emitLog(runId, level, text),
    });

    this.#emitLog(
      runId,
      result.passed ? "info" : "warn",
      `the gate/fix loop stopped after ${String(result.attempts)} attempt(s): ${result.reason}`,
    );
    // THE SAME TWO NUMBERS, ON THE ROW RATHER THAN ONLY IN THE LOG. A log line is
    // not an answer to "what happened to the run that ran while I was asleep":
    // `api-types.ts` reserves `gateAttempts` / `gateStopReason` for exactly this
    // and said, until this line, that nothing wrote them — so every run reported
    // `0` / `null` forever and a cron report would say "no loop outcome recorded"
    // about every run it ever submitted.
    //
    // OUTSIDE THE `rateLimit === null` GUARD BELOW, DELIBERATELY. A rate-limited
    // run has genuinely performed those attempts and genuinely stopped for that
    // reason; the backlog is withheld because that run is not terminal, but the
    // count is a fact about work already done. It is patched again when the run
    // resumes and the loop runs to a new outcome.
    this.#deps.store.updateRun(runId, { gateAttempts: result.attempts, gateStopReason: result.reason });
    // NOT ON A RATE LIMIT. That run is not terminal — the window drains and it
    // resumes — and a backlog headed "Stopped: cancelled" for a run that is
    // going to continue is a false statement about work that is not finished.
    // The next attempt writes it.
    if (rateLimit === null) {
      this.#recordBacklog(runId, runPaths, {
        reason: result.reason,
        attempts: result.attempts,
        remaining: result.report.failures,
        heldOutUnmet: result.report.heldOutUnmet,
        denied: result.deniedTasks,
        infraFailure: result.report.infraFailure,
      });
    }
    return { scored, result, rateLimit };
  }

  /**
   * Run one fix task: the same subscription builder, resuming the same session,
   * bounded to the one agent triage routed the work to.
   *
   * WHY THE SAME SESSION. The fixer needs what the builder already knows about
   * this tree. Resuming keeps that; a fresh session would re-derive it, at the
   * cost of the context budget the loop is trying to spend on fixing.
   *
   * WHY THE SAME `sealedRoots`. A fixing agent is subject to every Phase 0/0.1/
   * 0.2 protection the builder is. It is the agent with the strongest motive to
   * read `results/scorer-out` — that directory holds the held-out test titles
   * that would tell it exactly what to write.
   *
   * Returns the rate-limit state so the caller can stop the loop, or null when
   * the fix could not be attempted at all.
   */
  async #runFixTask(
    runId: string,
    task: FixTask,
    prompt: string,
    runPaths: RunPaths,
    log: BuildLog,
    signal: AbortSignal,
  ): Promise<RateLimitState | null> {
    const row = this.#deps.store.getRun(runId);
    if (row === null) return null;
    const entry = await this.#deps.catalog.resolve(row.modelId);
    if (entry === null || !entry.option.available) {
      this.#emitLog(runId, "warn", `no model is available to run the ${task.agent} fix round; skipping it`);
      return null;
    }

    const builder = this.#builderFor(entry.option.provider);

    const outcome = await builder.build({
      runId,
      prompt,
      workspace: runPaths.workspace,
      sealedRoots: [this.#deps.paths.acceptance, scorerOutRoot(this.#deps.paths)],
      allowedAgents: fixAllowedAgents(task),
      modelId: row.modelId,
      effort: entry.effort,
      resumeSessionId: row.builderSessionId,
      signal,
      sink: this.#sink(runId, log),
      env: this.#deps.env,
    });

    if (outcome.sessionId !== null) this.#deps.store.updateRun(runId, { builderSessionId: outcome.sessionId });
    if (outcome.tokens.callCount > 0) this.#emitLog(runId, "info", `${task.agent} — ${describeTokens(outcome.tokens)}`);
    if (outcome.failure !== null) {
      this.#emitLog(runId, "warn", `the ${task.agent} fix round did not complete cleanly: ${outcome.failure}`);
    }
    return outcome.rateLimit;
  }

  /**
   * The event sink for a fix round.
   *
   * Deliberately thinner than the build's: no environment record (the run's
   * inventory was written at init and a fix round does not change it) and no
   * context events (they are sampled at lane boundaries in a build, and a fix
   * round is one lane). Everything the UI already renders — logs, tools, tokens,
   * the canvas graph — still flows.
   */
  #sink(runId: string, log: BuildLog): BuildEventSink {
    return {
      log: (level, text) => this.#emitLog(runId, level, text),
      tool: (name, summary) => this.#emit(runId, { type: "tool", name, summary }),
      tokens: (totals) => {
        this.#deps.store.updateRun(runId, { tokens: toApiTokens(totals) });
        this.#emit(runId, { type: "tokens", ...toApiTokens(totals) });
      },
      rateLimit: (state) => this.#noteRateLimit(runId, state),
      session: (id) => {
        this.#deps.store.updateRun(runId, { builderSessionId: id });
      },
      environment: () => undefined,
      contextUsage: () => undefined,
      compaction: () => undefined,
      graph: (event) => this.#emit(runId, event),
      raw: (text) => log.write(text),
    };
  }

  /**
   * `backlog.md`, on EVERY terminal outcome — including the ones that never
   * reached the gate.
   *
   * A run cancelled during the spec or the build, and a run that died of a
   * harness fault, are exactly the runs whose "what happened to my ticket?" is
   * least answerable. Writing nothing for them leaves a missing file, and a
   * missing file cannot be told apart from a step that never ran. What they get
   * instead says UNKNOWN in both sections, because nothing was measured and the
   * absence of a claim is the honest output (CLAUDE.md rule 7).
   *
   * A failure to write it must NOT take the run down — this is the record of the
   * run, not the run — so it is logged as a warning, which is itself a record.
   */
  #recordBacklog(runId: string, runPaths: RunPaths, input: BacklogInput): void {
    try {
      const path = writeBacklog(runPaths.results, input);
      this.#emitLog(runId, "info", `what this run did not close is recorded in ${path}`);
    } catch (error) {
      this.#emitLog(runId, "warn", `the backlog could not be written: ${describeError(error)}`);
    }
  }

  /** The backlog for a run that stopped before the gate ever produced a result. */
  #recordUnmeasuredBacklog(runId: string, reason: StopReason, why: string): void {
    this.#recordBacklog(runId, runPathsFor(this.#deps.paths, runId), {
      reason,
      attempts: 0,
      remaining: [],
      heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
      infraFailure: why,
    });
  }

  /**
   * One gate attempt.
   *
   * `slot` is 1-based and is NOT decoration: the sealed scorer writes to a fixed
   * path per run id (`gate-attempts.ts` explains why that cannot be changed from
   * here), so attempt 2 clobbers attempt 1's `result.json` in place. The result
   * is archived under `attempt-<slot>/` the moment the scorer returns, and
   * everything downstream reads the archive. Without that, a three-round run
   * would end holding one result and no record of why it took three rounds.
   *
   * IT IS A SLOT AND NOT THE LOOP'S ATTEMPT NUMBER, and the rename is the whole
   * of the resume fix. `runGateFixLoop` counts from 1 on every entry; the caller
   * offsets by `highestArchivedAttempt` once so a resumed run's first attempt
   * does not land on top of the pre-resume attempt 1. BOTH USES BELOW TAKE THE
   * SAME VALUE — `#archiveAttempt` and `#readContainerResult` offset together or
   * not at all, or attempt 3 is read out of attempt 1's directory, which is the
   * defect `#readContainerResult`'s own docblock warns about.
   */
  async #gatePhase(
    runId: string,
    ticket: Ticket,
    suite: AcceptanceSuite,
    runPaths: RunPaths,
    declaredDone: boolean,
    signal: AbortSignal,
    slot: number,
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
      this.#archiveAttempt(runId, slot);
    } catch (error) {
      // Archive whatever the scorer managed to write before it threw: a
      // container that failed halfway still produced evidence about this
      // attempt, and the next attempt is about to overwrite it.
      this.#archiveAttempt(runId, slot);
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

    const container = this.#readContainerResult(runId, slot);
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
     *
     * THE NETWORK POLICY IS DERIVED, NOT WRITTEN HERE. It said `egress:
     * "denied"` inline until 2026-07-30 and that was false; see
     * `DASHBOARD_SANDBOX` and `recordedNetworkPolicy` above for what replaced it
     * and for the live-run evidence that condemned it.
     */
    const heldConstants: HeldConstants = {
      efforts: [],
      harness: { id: "dashboard-server", version: "0.1.0", commit: "unversioned" },
      sandbox: DASHBOARD_SANDBOX,
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
   * Preserve this attempt's result before the next one overwrites it.
   *
   * NEVER THROWS. It is called on both arms of the gate's try/catch, and an
   * EACCES or a full disk in the catch arm would escape `#gatePhase` entirely
   * and turn a run that reached a real verdict into a harness fault. This is the
   * record of the attempt, not the attempt.
   */
  #archiveAttempt(runId: string, slot: number): void {
    try {
      archiveAttempt(this.#deps.paths, runId, slot);
    } catch (error) {
      this.#emitLog(runId, "warn", `gate attempt ${String(slot)} could not be archived: ${describeError(error)}`);
    }
  }

  /**
   * The archived result for one attempt.
   *
   * Reads the ARCHIVE, not the scorer's live output path. A later attempt has
   * already overwritten the latter by the time anyone asks, and reading it would
   * answer a question about attempt 1 with attempt 3's numbers.
   */
  #readContainerResult(runId: string, slot: number): ContainerResult | null {
    return readAttempt(this.#deps.paths, runId, slot);
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
    // Reached only from the spec and build phases — a cancel inside the loop
    // comes back through the loop, which writes its own backlog with whatever
    // the last completed gate knew.
    this.#recordUnmeasuredBacklog(runId, "cancelled", "the run was cancelled before the gate produced a result");
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
  // The DESIGN lane's TMPDIR (design-env.ts). It is inside the workspace
  // because `sandbox.filesystem.allowWrite` is `[workspace]` and `mktemp -d`
  // has to land somewhere writable — it is harness state, not artefact, and
  // `git add -A` would otherwise put a request body in the judge's reading
  // material. The sealed gate still sees the real workspace; this is a
  // pathspec exclude on the DIFF only.
  ":(exclude).design-tmp",
  ":(exclude).design-tmp/**",
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

/**
 * The highest `attempt-<n>` already archived for this run, or 0 when there are
 * none. The offset every later attempt's archive slot is measured from.
 *
 * WHY IT IS NEEDED AT ALL. `runGateFixLoop` numbers its attempts 1, 2, 3 — from
 * 1 on every entry, because it is a bounded loop and knows nothing about the run
 * that contains it. A RESUME re-enters it. So a resumed run's first gate attempt
 * was archived over `attempt-1/result.json` from before the resume, which is the
 * exact history loss `gate-attempts.ts` was written to prevent, one level up:
 * "a three-round run would end holding one result and no record of why it took
 * three rounds" becomes "a resumed run holds no record of the rounds it ran
 * before it was interrupted".
 *
 * WHY THE FILESYSTEM AND NOT `resumeCount * maxAttempts`. The stride is not
 * fixed: `maxAttemptsFrom(env)` is read from the environment on every entry, so
 * a run that burnt five attempts before a restart and resumed under a stride of
 * three would compute a base of 3 and overwrite `attempt-4/`. The directories
 * are the only record that cannot disagree with itself. `resumeCount` is still
 * the right thing for the LOG LINE, where "resume #2" is what an operator reads.
 *
 * A NAME THAT DOES NOT PARSE IS SKIPPED, NEVER TREATED AS ZERO. `attempt-x/`
 * counted as 0 would put the next slot back on top of `attempt-1/`.
 */
export function highestArchivedAttempt(paths: DashboardPaths, runId: string): number {
  const dir = join(scorerOutRoot(paths), safeSegment(runId));
  let highest = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^attempt-(\d+)$/.exec(entry.name);
      if (match === null) continue;
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > highest) highest = n;
    }
  } catch {
    // No directory yet: this run has never gated. Not an error, and not a reason
    // to fail anything — the worst case of a mis-read here is an archive slot.
  }
  return highest;
}

/**
 * The evidence bundle handed to the judge. Execution facts only.
 *
 * IT GOES THROUGH `gate-report.ts`, AND THAT IS THE POINT OF THIS FUNCTION.
 * Until 2026-07-29 it iterated `container.tier0` printing every gate's `detail`
 * verbatim and `container.criterionCoverage` printing every coverage `detail`
 * verbatim. `GATE:suite-green`'s detail is assembled in `scorer-container.ts`
 * from the held-out runner's own output tail and the `titlePath` of each excused
 * failure; a coverage `detail` is the assertion message that produced it. So the
 * judge prompt carried held-out test titles — the exact bytes `gate-report.ts`
 * exists to keep out of a fixing agent's prompt, leaving by a different door.
 *
 * IT IS NOT A `heldOutPass` PROBLEM, and the fix is deliberate rather than
 * reflexive. The judge gates nothing (`#judgePhase` only emits log lines) and
 * its output never re-enters the GATE/FIX loop, so no measurement is corrupted
 * by it. What IS corrupted is the claim the sealed store makes: that the
 * held-out suite's identities exist in exactly one place. A verdict-shaped
 * document quoting a held-out title is the same leak with a smaller blast
 * radius, and "smaller" is not a boundary.
 *
 * ONE DOOR, NOT TWO. `toAgentVisible` owns the allowlist — a gate id nobody has
 * reasoned about gets its detail withheld, so a gate added upstream fails closed
 * here for free. Re-deriving that decision in this file would be a second
 * redactor, and two redactors drift the first time either is edited.
 *
 * WHAT SURVIVES AND WHY, field by field:
 *   - gate `outcome`: always. It is an enum the protocol defines, not text the
 *     container wrote. A gate that PASSED gets no detail at all, because
 *     `toAgentVisible` only reports `fail`/`unknown` and a passing
 *     `GATE:suite-green` detail still quotes the runner's tail.
 *   - gate `detail`: only for the allowlisted ids, only when failing.
 *   - `criterionCoverage[].criterionId` and `.outcome`: kept. The ids are ALREADY
 *     in this prompt — `judge.ts:renderInputs` prints every criterion id, tier
 *     and statement in its FROZEN ACCEPTANCE CRITERIA block — so withholding
 *     them here would be theatre, not a boundary. `.detail` and `.testRefs` are
 *     the held-out half and are gone.
 *   - `infraFailure`: emitted. `toAgentVisible` returns an EMPTY failure list
 *     when the container hit infrastructure errors, and evidence that reads as
 *     "no gate had anything to say" when the browser would not launch is a
 *     fabricated all-clear.
 *   - non-blocking exploit findings: kept as kind + path, never `detail`.
 *     `toAgentVisible` drops them for a reason that does not apply here — they
 *     gate nothing, so a FIXER should not spend a round on them — whereas a
 *     reviewer is exactly who they were reported for.
 */
export function renderEvidence(container: ContainerResult | null): string {
  if (container === null) return "The sealed container produced no machine-readable result.";
  const report = toAgentVisible(container);
  const redactedDetail = new Map(report.failures.map((failure) => [failure.id, failure.detail] as const));

  const lines: string[] = [];
  if (report.infraFailure !== null) {
    lines.push(`scorer infrastructure (the SCORER's failure, not the artefact's): ${report.infraFailure}`);
  }
  for (const gate of container.tier0) {
    const detail = redactedDetail.get(gate.id);
    lines.push(
      detail === undefined
        ? `${gate.id}: ${gate.outcome}`
        : `${gate.id}: ${gate.outcome} — ${truncate(detail, 200)}`,
    );
  }
  lines.push(
    `suite: exit ${String(container.suiteExecution.exitCode)}, ` +
      `${String(container.suiteExecution.testsPassed ?? 0)}/${String(container.suiteExecution.testsTotal ?? 0)} passed`,
  );
  for (const coverage of container.criterionCoverage) {
    lines.push(`${coverage.criterionId}: ${coverage.outcome}`);
  }
  for (const failure of report.failures) {
    if (failure.id.startsWith("exploit:")) {
      lines.push(`exploit scan: ${failure.summary} — ${truncate(failure.detail, 160)}`);
    } else if (failure.id.startsWith("dom:")) {
      lines.push(`dom: ${failure.summary} — ${truncate(failure.detail, 160)}`);
    }
  }
  for (const finding of container.exploitFindings) {
    if (finding.blocking) continue; // already above, with its detail
    lines.push(`exploit scan (non-blocking): ${finding.kind} in ${finding.path}`);
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
