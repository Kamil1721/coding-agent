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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  BAKEOFF_SCHEMA_VERSION,
  BakeoffError,
  TOKEN_ACCOUNTING_RULE,
} from "bakeoff/dist/contracts.js";
import type {
  AcceptanceGate,
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
import {
  ADVERSARY_AGENT,
  ADVERSARY_RECORD_FILE,
  adversaryRecord,
  parseAdversaryFindings,
  parseAgentDenylist,
  runAdversaryLane,
  summariseAdversary,
  withAdversaryFindings,
} from "./adversary.js";
import type {
  AdversaryCall,
  AdversaryFinding,
  AdversaryLaneResult,
  AdversarySpawnResult,
} from "./adversary.js";
import { DELIVERY_LANES, shortlistFor } from "./agent-shortlist.js";
import { writeBacklog } from "./backlog.js";
import type { BacklogInput } from "./backlog.js";
import { graphResumeState, makeSegmentRemap, nextBuildSegment } from "./build-segment.js";
import { LiveInput } from "./live-input.js";
import { AgentReplyWatch, ownerMessageBlock } from "./owner-message.js";
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
import { archiveAttempt, readAttempt, scorerOutRoot, scoresRoot } from "./gate-attempts.js";
// THE ONE DOOR. `renderEvidence` routes the judge's evidence bundle through the
// same allowlist the fix loop's prompts go through, rather than through a second
// copy of the same decision. See the docblock on `renderEvidence`.
import { toAgentVisible } from "./gate-report.js";
import { maxAttemptsFrom, runGateFixLoop } from "./gate-fix-loop.js";
import type { GateFixLoopResult, StopReason } from "./gate-fix-loop.js";
import type {
  ApiCriterion,
  ApiPhase,
  ApiProvider,
  ApiRunSilence,
  ApiRunStatus,
  GraphSseEvent,
} from "./api-types.js";
import { appendContextEvent } from "./build-context.js";
import type { ContextEvent } from "./build-context.js";
import { writeEnvironmentRecord } from "./build-environment.js";
import type { AuthProbe } from "./auth.js";
import { truncate } from "./claude-common.js";
import type { RateLimitState } from "./claude-common.js";
import { dashboardBuilderPrompt, resumeBuilderPrompt } from "./build-prompt.js";
import { canonicaliseForDecision, ClaudeSubscriptionBuilder } from "./builders/claude-builder.js";
import { CodexSubscriptionBuilder } from "./builders/codex-builder.js";
import type { BuildEventSink, BuildOutcome, SubscriptionBuilder } from "./builders/types.js";
import type { RunRow, RunStore } from "./db.js";
/**
 * RUNTIME, AND THE IMPORT IS THE MECHANISM RATHER THAN A CONVENIENCE.
 *
 * `SILENCE_NOTICE_PREFIX` is the sentence `RunStore.lastRunEventAt` filters out
 * of its own measurement. Retyping it here instead of importing it would give
 * the emitter and the filter two spellings, the filter would match nothing, and
 * every announcement the watch made would reset the clock it had just read —
 * silently, with the first warning still arriving and every test that only
 * checks the first warning still green.
 */
import { SILENCE_NOTICE_PREFIX, isTerminal } from "./db.js";
import { RunEventBus } from "./bus.js";
import { judgeArtifact } from "./judge.js";
import type { ModelCatalog } from "./models.js";
import { ensureRunDirs, gateEnv, runPathsFor, safeSegment } from "./paths.js";
import type { DashboardPaths, RunPaths } from "./paths.js";
import { PreviewHost } from "./preview.js";
import { publishProject } from "./project-publish.js";
import { writeAssumptions, writeRunVerdict } from "./run-report.js";
import { describeTokens, mergeTokenTotals, toApiTokens, zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";
import { SubscriptionSeatCaller, describeSeatDocuments, seatDocumentsFor } from "./subscription-caller.js";
import type { SeatDocument } from "./subscription-caller.js";
import { extractorIsUsable, probeDocumentCapability } from "./document-capability.js";
import { routeFor } from "./document-intake.js";
import { ticketFromStoredReferences } from "./ticket.js";
import {
  builderReferenceSection,
  designReferenceSection,
  manifestDocuments,
  readReferenceManifest,
  referenceDirFor,
  ticketProse,
} from "./ticket-refs.js";
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
  /**
   * How the human-factors adversary pass is actually spawned. Defaulted to the
   * real one (`#spawnAdversaryWithBuilder`).
   *
   * INJECTED BECAUSE THE REAL ONE POINTS A SUBSCRIPTION AGENT AT A LIVE APP. Every
   * test in this repository that drove it for real would spend the owner's quota
   * and attack a running preview, so the SEQUENCING — does the lane spawn on a run
   * that qualifies, and does it stay silent on one that does not — is only
   * observable through this seam. The live arm is therefore untested by design and
   * said so in `adversary.ts`'s header rather than implied to work.
   */
  readonly spawnAdversary?: AdversarySpawner;
  /**
   * How the sealed gate is constructed. Defaulted to bakeoff's own `createGate`,
   * which is the only thing production ever uses.
   *
   * WHY THE SEAM EXISTS AT ALL, STATED PLAINLY BECAUSE IT LOOKS LIKE A HOLE IN
   * THE SEAL. `createGate` resolves a container image digest from the docker
   * daemon before it will score anything, so a test machine with no docker — every
   * test in this suite runs with an EMPTY `PATH` on purpose — cannot get a
   * `ScoreRecord` at all. `#execute` returns early when `scored.record === null`,
   * so WITHOUT this seam the phases after the gate (`#maybePreview`,
   * `#adversaryPhase`) are unreachable from any test, and "does the adversary lane
   * spawn on a run that qualifies" becomes a question only a live metered run
   * could answer. That is exactly the shape of gap this repository keeps shipping.
   *
   * WHAT IT DOES NOT WEAKEN. Nothing in production passes it; `heldOutPass` still
   * comes from the sealed container, the suite is still verified intact before the
   * build, and a gate handed in here cannot reach the frozen suite store — it is
   * given the same `gateEnv` the real one is. The bake-off CLI already treats this
   * as a legitimate seam ("swapping it for a different gate is a visible act on
   * the command line", bakeoff/src/gate.ts) and this is the in-process spelling of
   * the same act.
   */
  readonly makeGate?: (env: NodeJS.ProcessEnv) => Promise<AcceptanceGate>;
}

/** The one thing `#adversaryPhase` cannot do without spending money. */
export type AdversarySpawner = (input: {
  readonly runId: string;
  readonly call: AdversaryCall;
  readonly signal: AbortSignal;
}) => Promise<AdversarySpawnResult>;

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
 * WHY AN ABORT CARRIES A REASON.
 *
 * Two very different events call `abort()` on the same controller — the owner
 * cancelling one run, and the server stopping — and the thrown error cannot
 * tell them apart. What surfaces is the CLI's own wording, "Claude Code process
 * aborted by user", which is wrong about a SIGTERM and blames the operator
 * either way. The controller's `reason` is the only thing that still knows.
 *
 * The two demand OPPOSITE terminal handling, which is why guessing was never
 * an option:
 *
 * - `cancelled` — the owner asked. Terminal, and `#cancelled` records it.
 * - `shutdown` — the process is going away. **Nothing terminal may be
 *   written.** The row stays `running` so `reconcileOnBoot` moves it to
 *   `awaiting_input` on the next boot, which is what makes the stop banner's
 *   promise — "In-flight builds are aborted and stay resumable" — true.
 *
 * Before this, an abort during the SPEC phase escaped as a thrown
 * `SeatCallError`, sailed past the `signal.aborted` check below it, and was
 * caught by `#start` as a harness fault: status `failed`, which `resume()`
 * refuses outright. A server restart permanently killed the run and told the
 * owner a user had done it.
 */
export const ABORT_CANCELLED = "cancelled" as const;
export const ABORT_SHUTDOWN = "shutdown" as const;
type AbortReason = typeof ABORT_CANCELLED | typeof ABORT_SHUTDOWN;

/**
 * Read the reason back off a signal.
 *
 * Defaults to `cancelled` when the reason is absent or unrecognised — an abort
 * from a path that predates this, or a future one that forgets to pass a
 * reason, is treated as the owner cancelling. That is the SAFE default: it
 * writes a terminal `cancelled` the owner can see and re-run, rather than
 * leaving a row `running` that no reconciliation will ever revisit because the
 * process is still alive.
 */
export function abortReasonOf(signal: AbortSignal): AbortReason {
  return signal.reason === ABORT_SHUTDOWN ? ABORT_SHUTDOWN : ABORT_CANCELLED;
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

/* -------------------------------------------------------------------------
 * The rate-limit park: opt-in auto-resume, OFF by default
 * ---------------------------------------------------------------------- */

/**
 * The environment variable that turns automatic resume on. Nothing else does.
 *
 * WHAT WAS BROKEN. Nothing armed anything on `rate_limited`. The status is not
 * terminal, `pump()` only ever picks up `queued`, and the sole exit was a human
 * pressing Resume — while `cron/cron-policy.ts` skipped every tick saying "That
 * run resumes when the window drains", describing a resume NO CODE PERFORMED.
 * An unattended overnight queue therefore stopped at the first refusal and
 * stayed stopped until morning.
 *
 * WHY OPT-IN AND NOT THE DEFAULT. Every automatic resume spends the owner's
 * subscription with nobody watching, and the number the decision rests on comes
 * from the provider: `retryAfterSec` is derived from ONE `resetsAt`
 * (claude-common.ts), which names when the CURRENT window rolls over and cannot
 * distinguish the 5-hour window from the weekly cap. A resume timed off that
 * number can be wrong, repeatedly, in the direction of spending. Default OFF
 * means a wrong number costs nothing.
 *
 * UNRECOGNISED VALUES ARE OFF, WHICH INVERTS `designLockPolicy`'s RULE. There
 * the safe direction is the one that FINISHES a park; here the safe direction is
 * the one that does not spend, so a typo in a launchd plist cannot enrol a
 * machine into unattended quota burn.
 */
export const RATE_LIMIT_AUTO_RESUME_ENV = "DASHBOARD_RATE_LIMIT_AUTO_RESUME";

const RATE_LIMIT_AUTO_RESUME_ON: readonly string[] = ["1", "true", "yes", "on"];

export function rateLimitAutoResume(env: NodeJS.ProcessEnv): boolean {
  return RATE_LIMIT_AUTO_RESUME_ON.includes((env[RATE_LIMIT_AUTO_RESUME_ENV] ?? "").trim().toLowerCase());
}

/**
 * The longest wait this will arm, and the reason a longer one is REFUSED rather
 * than clamped.
 *
 * `setTimeout` stores its delay in a signed 32-bit integer: a delay above
 * 2_147_483_647 ms does not wait longer, it FIRES IMMEDIATELY (Node prints
 * `TimeoutOverflowWarning` and substitutes 1 ms). For this feature that is the
 * worst possible inversion — a run that should wait 115 days would resume in a
 * millisecond, unattended, into a window that is certainly still shut. A wait
 * this program cannot represent is a wait it must not claim, so it is disabled
 * with a reason instead.
 *
 * Real windows sit far below the ceiling (a seven-day cap is 604_800_000 ms), so
 * only a nonsense `resetsAt` reaches it.
 */
export const RATE_LIMIT_RESUME_MAX_DELAY_MS = 2_147_483_647;

/**
 * How many times a run may have been resumed before auto-resume stops offering.
 *
 * IT COUNTS THE OWNER'S RESUMES TOO, and that is a limitation rather than a
 * design: `RunRow.resumeCount` is one integer and does not record who pressed
 * it. The bound is therefore on TOTAL re-entries into a run, not on automatic
 * ones, and a run an owner has already resumed three times will not arm.
 *
 * It exists because one `resetsAt` cannot tell a 5-hour rollover from the weekly
 * cap. Under a weekly cap the reported instant is minutes away while the real
 * refusal is days long, so an unbounded arm would resume, be refused, re-arm,
 * and grind through the quota in short steps for a week. Three re-entries, then
 * a human.
 */
export const RATE_LIMIT_AUTO_RESUME_MAX_RESUMES = 3;

export type RateLimitResumePlan =
  | { readonly kind: "armed"; readonly delayMs: number }
  | { readonly kind: "due" }
  | { readonly kind: "disabled"; readonly reason: string };

export interface RateLimitResumeInput {
  readonly enabled: boolean;
  /**
   * When the provider REFUSED — `RunRow.rateLimitedAt`, written only by
   * `#rateLimited`. NOT the last `rate_limit` telemetry event: that one fires
   * routinely with `limited: false` to report a window filling, and arming off
   * it would resume runs nothing ever refused.
   */
  readonly rateLimitedAt: string | null;
  readonly retryAfterSec: number | null;
  readonly resumeCount: number;
  readonly now: string;
}

/**
 * Should this run resume itself, when, and if not — WHY NOT.
 *
 * PURE, for `cron-policy.ts`'s stated reason: a decision that can only be
 * observed by spending the owner's quota is a decision nobody checks. Every arm
 * below is reachable from a unit test with no timer and no clock.
 *
 * THE `disabled` REASON IS THE PRODUCT, not an afterthought. It is emitted onto
 * the run's own log at the moment of the refusal, so a run that is going to sit
 * there until morning SAYS so when it stops instead of going quiet.
 *
 * TWO DELIBERATE INVERSIONS OF `designLockExpired`, WHICH IS THE PRECEDENT THIS
 * OTHERWISE FOLLOWS:
 *
 *  - An ABSENT OR UNPARSEABLE instant is `disabled` here, where `designLockExpired`
 *    returns "expired" and ends the park. Ending a park costs nothing; resuming a
 *    build spends. If we do not know WHEN the refusal happened we do not know what
 *    remains of the wait, and arming from `now` would be a FRESH window wearing the
 *    old one's name — the exact thing re-arming from the original instant exists to
 *    prevent.
 *
 *  - `retryAfterSec === 0` is `disabled` rather than "already drained".
 *    `claude-common.ts` produces it via `Math.max(0, ...)` when the provider
 *    refused a call while naming a reset instant already in the past: a refusal
 *    with no wait attached, which answered immediately walks straight back into
 *    itself. NOTE that the CLIENT conflates 0 with "not reported"
 *    (`use-run-stream.ts:349` maps a null to 0); on this side, reading `RunRow`,
 *    the two are separate values and stay separate.
 *
 * WHAT IT DOES NOT DO: it does not establish that the window actually drained.
 * Nothing here can — the only evidence is the next call being accepted. It
 * computes the wait the provider itself reported, and stops there.
 */
export function planRateLimitResume(input: RateLimitResumeInput): RateLimitResumePlan {
  if (!input.enabled) {
    return {
      kind: "disabled",
      reason:
        `automatic resume is opt-in and is off. Set ${RATE_LIMIT_AUTO_RESUME_ENV}=1 to let a rate-limited ` +
        `run restart itself; until then a human has to resume this run — nothing will do it for them.`,
    };
  }
  if (input.retryAfterSec === null) {
    return {
      kind: "disabled",
      reason:
        "the provider reported no reset instant with this refusal, so nothing here knows when the window " +
        "reopens. A countdown from a number nobody reported is an invention, so no timer is armed and a " +
        "human has to resume this run.",
    };
  }
  if (!Number.isFinite(input.retryAfterSec) || input.retryAfterSec <= 0) {
    return {
      kind: "disabled",
      reason:
        `the provider refused the call while reporting a reset instant that is not in the future ` +
        `(retryAfterSec ${String(input.retryAfterSec)}). A resume with no wait attached re-enters the same ` +
        `refusal, so no timer is armed and a human has to resume this run.`,
    };
  }
  const refusedAt = input.rateLimitedAt === null ? Number.NaN : Date.parse(input.rateLimitedAt);
  const at = Date.parse(input.now);
  if (!Number.isFinite(refusedAt) || !Number.isFinite(at)) {
    return {
      kind: "disabled",
      reason:
        `there is no usable record of when the provider refused (${input.rateLimitedAt ?? "none recorded"}), ` +
        `so the remaining wait cannot be computed. Arming from now would restart the whole window on every ` +
        `boot, which is the one thing this must never do; a human has to resume this run.`,
    };
  }
  if (input.resumeCount >= RATE_LIMIT_AUTO_RESUME_MAX_RESUMES) {
    return {
      kind: "disabled",
      reason:
        `this run has been resumed ${String(input.resumeCount)} time(s) and the cap is ` +
        `${String(RATE_LIMIT_AUTO_RESUME_MAX_RESUMES)}. The cap counts the owner's own resumes too — the row ` +
        `does not record who pressed it — so it bounds total re-entries rather than automatic ones.`,
    };
  }
  // ELAPSED IS FLOORED AT ZERO, exactly as `#parkForDesignLock` floors it: a
  // clock that moved backwards must not lengthen the wait beyond what was
  // reported.
  const elapsed = Math.max(0, at - refusedAt);
  const delayMs = input.retryAfterSec * 1000 - elapsed;
  if (delayMs <= 0) return { kind: "due" };
  if (delayMs > RATE_LIMIT_RESUME_MAX_DELAY_MS) {
    return {
      kind: "disabled",
      reason:
        `the reported wait is ${String(Math.round(delayMs / 86_400_000))} day(s), longer than a timer on this ` +
        `platform can hold — setTimeout keeps its delay in 32 bits and a longer one fires IMMEDIATELY. ` +
        `Refused rather than clamped, because firing immediately is the opposite of waiting.`,
    };
  }
  return { kind: "armed", delayMs };
}

/* -------------------------------------------------------------------------
 * THE SILENCE WATCH — report, never act
 *
 * WHAT WENT WRONG, MEASURED IN THIS REPOSITORY'S OWN `events` TABLE. Run
 * `run-2026-07-30T20-16-40-242Z-052c6e02` has a 506.6-MINUTE gap between event
 * seq 328 (2026-07-30T21:09:57Z) and seq 329 (2026-07-31T05:36:35Z). For eight
 * and a half hours the row said `running`, the subprocess was idle, and nothing
 * in the dashboard, the API or the log distinguished that from a working build.
 * The cause is fixed (f01fa9f, the streaming-input session that never ended);
 * NOTHING WATCHED FOR IT, which is the part this block is about, and the next
 * hang will have a different cause.
 *
 * WHAT IT MAY NOT DO. It may not kill, requeue, restart or fail a run. doc 03
 * §7.8: LHTB found 79% of unresolved runs time out WHILE STILL ACTIVELY MAKING
 * PROGRESS, and the section's instruction is explicit — "Do not build 'the agent
 * seems stuck' heuristics ... Terminate on a budget boundary, never on a guess."
 * A silence is not evidence of death: a model thinking for an hour, a socket
 * blocked forever and a crashed subprocess are indistinguishable from here. So
 * this measures a gap and says so, and every string it produces is phrased as
 * what was OBSERVED rather than what is WRONG.
 * ---------------------------------------------------------------------- */

/** Minutes of silence before the watch says so. Overrides {@link DEFAULT_SILENCE_WARN_MIN}. */
export const SILENCE_WARN_ENV = "DASHBOARD_SILENCE_WARN_MIN";

/**
 * Ninety minutes, and the number is derived from this machine's own event rows
 * rather than chosen for feel.
 *
 * THE EVIDENCE, WITH ITS SIZE STATED. There is exactly ONE finished run on this
 * machine (`run-2026-07-29T23-28-46-665Z-3d4d1ccb`, 388 events). Its largest
 * quiet gap is 43.5 min, at seq 8, in the spec phase — a legitimately silent
 * stretch in which the run was working. Its second largest is 31.8 min; every
 * other gap in that run is under 4.1 min. So this default is "a little over
 * twice the largest gap measured on the only finished run this machine has",
 * which is a weaker claim than "twice the largest legitimate gap" and is the one
 * the data supports. n = 1.
 *
 * THE OTHER END OF THE RANGE IS THE FAILURE ITSELF: 506.6 min. Ninety minutes
 * would have reported that hang before 23:00 instead of leaving it until
 * morning, while leaving the measured 43.5-minute quiet spec phase alone.
 *
 * A SHORTER THRESHOLD IS NOT FREE AND THE COST IS TESTABLE. At 30 min the very
 * same 43.5-minute gap — a run that was working — is reported as silence;
 * `stall-watch.test.ts` proves exactly that, so the justification for this
 * number can be re-run rather than believed. Raise the env var on a machine
 * whose runs are quieter than this one's; lowering it below 43.5 buys false
 * alarms on the only evidence available.
 */
export const DEFAULT_SILENCE_WARN_MIN = 90;

/**
 * The largest quiet gap MEASURED on a run that was working, in minutes.
 *
 * A CONSTANT SO THE DEFAULT'S JUSTIFICATION CAN BE ASSERTED. `stall-watch.test.ts`
 * requires `DEFAULT_SILENCE_WARN_MIN > MEASURED_QUIET_GAP_MIN`, which turns red
 * if someone lowers the default under the one measurement it rests on. Update it
 * only with a new measurement and say which run it came from.
 */
export const MEASURED_QUIET_GAP_MIN = 43.5;

/** How often the watch looks. Bounds how late an announcement can be, nothing else. */
export const SILENCE_CHECK_MS = 60_000;

export function silenceWarnMin(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat((env[SILENCE_WARN_ENV] ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_WARN_MIN;
}

export interface SilenceInput {
  readonly status: ApiRunStatus;
  readonly startedAt: string;
  /** `RunStore.lastRunEventAt` — the watch's own notices already filtered out. */
  readonly lastEventAt: string | null;
  readonly now: string;
  readonly thresholdMin: number;
}

/**
 * How long this run has been quiet — or `null` when there is nothing to say.
 *
 * PURE, for the reason `planRateLimitResume` is pure: a decision that can only
 * be observed by spending the owner's subscription is a decision nobody checks.
 * Every branch below is reachable from a unit test with no timer and no clock,
 * including the one that matters most — a run whose events keep arriving, which
 * must NEVER cross the threshold however long the run lasts.
 *
 * IT KEYS ON THE GAP, NEVER ON THE RUN'S AGE. A four-hour run that speaks every
 * five minutes is not quiet; a ten-minute-old run that has said nothing for nine
 * of them is. Reading age instead of gap is how every previous attempt at this
 * display ended up calling long silences normal.
 *
 * ONLY `running` IS WATCHED. `queued` has not started, `awaiting_input` and
 * `rate_limited` are parks that are SUPPOSED to be quiet and are bounded by
 * their own timers, and a terminal run is finished. `null` for all of them means
 * NOT WATCHED and must never be rendered as a clean bill of health.
 *
 * THE ONE OTHER `null`, STATED BECAUSE IT IS THE EXCEPTION TO THAT SENTENCE: an
 * instant this program cannot parse. `now` is ours and always parses; `since`
 * comes from a row, so a database written by a different program could carry
 * one. A `quietMin` computed from `NaN` would be a number where there is no
 * measurement, which is worse than the absence.
 *
 * ELAPSED IS FLOORED AT ZERO, exactly as `#parkForDesignLock` and
 * `planRateLimitResume` floor theirs: a clock that moved backwards must not
 * invent silence that did not happen.
 */
export function describeSilence(input: SilenceInput): ApiRunSilence | null {
  if (input.status !== "running") return null;
  const sinceKind = input.lastEventAt === null ? "run-start" : "last-event";
  const since = input.lastEventAt ?? input.startedAt;
  const from = Date.parse(since);
  const at = Date.parse(input.now);
  if (!Number.isFinite(from) || !Number.isFinite(at)) return null;
  const quietMin = Math.floor(Math.max(0, at - from) / 60_000);
  return {
    since,
    sinceKind,
    quietMin,
    thresholdMin: input.thresholdMin,
    // `>=`, matching `designLockExpired`'s reasoning: the instant the watch's
    // own timer would fire is the instant this must already read as over, or the
    // two halves of one feature disagree at exactly the boundary.
    overThreshold: quietMin >= input.thresholdMin,
  };
}

/**
 * The read-only derivation, for a caller that must not emit anything.
 *
 * THIS IS WHAT `http.ts#toDetail` CALLS. A GET must not write to the run's event
 * stream, so the announcing path ({@link Orchestrator.noteSilence}) is not
 * available to it — and both go through this one function so the number on the
 * wire and the number in the warning cannot drift apart.
 *
 * NOTHING IS PERSISTED. The measurement is `lastRunEventAt` plus the clock, both
 * read at call time, which is why a restarted dashboard reports true silences
 * immediately: there is no timer to have missed and no column to have gone
 * stale. That is this feature's durable half, and it is a different shape from
 * the design park's (`reconcileOnBoot` re-arming a timer) because the evidence
 * here is already on disk in the `events` table.
 */
export function silenceOf(
  row: RunRow,
  store: RunStore,
  env: NodeJS.ProcessEnv,
  now: string = new Date().toISOString(),
): ApiRunSilence | null {
  // The store read is skipped for a run that is not watched — `toDetail` runs on
  // every list item and a `SELECT ... ORDER BY seq DESC` per finished run is a
  // query nobody needs.
  if (row.status !== "running") return null;
  return describeSilence({
    status: row.status,
    startedAt: row.startedAt,
    lastEventAt: store.lastRunEventAt(row.runId),
    now,
    thresholdMin: silenceWarnMin(env),
  });
}

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

  /**
   * The live half of the RATE-LIMIT park, one timer per auto-resuming run.
   *
   * Same two-halves shape as {@link Orchestrator.#designLockTimers} and for the
   * same reason: a timer lives in a process a restart destroys, so
   * `reconcileOnBoot` re-arms from `RunRow.rateLimitedAt` — the ORIGINAL instant,
   * never `now` — and neither half alone bounds anything.
   *
   * ONE DIFFERENCE FROM THE DESIGN PARK: this map is EMPTY BY DESIGN on a default
   * install. Auto-resume is opt-in ({@link RATE_LIMIT_AUTO_RESUME_ENV}), and with
   * it off a rate-limited run waits for a human — which the run's log says, at
   * the moment it stops, rather than leaving the owner to infer it.
   */
  readonly #rateLimitTimers = new Map<string, NodeJS.Timeout>();

  /**
   * The SILENCE WATCH's live half — one interval per run that is actually
   * running in THIS process.
   *
   * THE DURABLE HALF IS NOT A SECOND TIMER, AND THAT IS THE ONE PLACE THIS
   * DEPARTS FROM {@link Orchestrator.#designLockTimers}. There, the park's
   * deadline exists only in a timer, so `reconcileOnBoot` has to re-arm it from
   * `design-lock.json` or the park never ends. Here the evidence is already
   * durable: the silence IS the gap between rows in the `events` table, so
   * `silenceOf` reports it correctly the first time a restarted server answers
   * `GET /api/runs/:id`, before any timer exists.
   *
   * THERE IS ALSO NOTHING FOR `reconcileOnBoot` TO ARM, and the reason is
   * mechanical rather than an omission: its first loop moves EVERY `running` row
   * to `awaiting_input`, because a run's subprocess died with the server. A
   * watched run cannot survive a boot, so a sweep here would be a loop over an
   * empty set — dead code standing in for a bound. The watch is armed where a
   * run actually starts running (`#execute`) and cleared where one stops
   * (`#start`'s `finally`, and `shutdown()`).
   */
  readonly #silenceTimers = new Map<string, NodeJS.Timeout>();

  /**
   * The `since` instant of the silence already announced for a run, so one quiet
   * stretch produces ONE warning instead of one a minute.
   *
   * KEYED ON THE INSTANT, NOT A BOOLEAN, so a run that speaks and then goes
   * quiet again gets a NEW warning — the second silence is a new fact. Cleared
   * with the timer in `#clearSilenceWatch`, so a resumed run cannot inherit a
   * stale episode key and swallow its first announcement.
   *
   * IT IS NOT WHAT KEEPS THE MEASUREMENT HONEST. That is the filter in
   * `RunStore.lastRunEventAt`: this map only bounds the LOG. Without the filter
   * the warning would reset the very clock it reports, and this map would then
   * be hiding the fact by never letting a second one be attempted.
   */
  readonly #silenceAnnounced = new Map<string, string>();

  /**
   * Open input channels, by run id — one per in-flight build segment.
   *
   * A run appears here only while a segment is actually executing, which is exactly
   * the window in which a mid-run message can be delivered live. `pushLiveMessage`
   * returns false outside it, and the caller falls back to the queue.
   */
  readonly #liveInputs = new Map<string, LiveInput>();
  /**
   * The reply watch for the segment currently running, per run.
   *
   * PAIRED WITH `#liveInputs` AND FOR THE SAME REASON: a message pushed into a
   * live session has to arm the watch that is listening to that session, or the
   * agent answers and nothing records it until the segment ends. Set and deleted
   * on exactly the same lines as the channel, so the two cannot drift.
   */
  readonly #replyWatches = new Map<string, AgentReplyWatch>();

  /**
   * Deliver an owner message into a RUNNING session.
   *
   * Returns false when this run has no open segment — a parked, queued or finished
   * run — in which case the message stays pending and the segment-boundary drain
   * picks it up. The two paths together are why a message is never lost and never
   * delivered twice: `delivered_at` is stamped by whichever one takes it.
   */
  pushLiveMessage(
    runId: string,
    message: { text: string; images: readonly string[] },
  ): boolean {
    const channel = this.#liveInputs.get(runId);
    if (channel === undefined || channel.closed) return false;
    const pushed = channel.push(message);
    /*
     * ARM THE REPLY ONLY IF THE MESSAGE ACTUALLY LANDED. A refused push is not a
     * question the agent ever saw, and owing a reply for it would attribute the
     * agent's next unrelated sentence to a message it never received.
     */
    if (pushed) this.#replyWatches.get(runId)?.expectReply(this.#deps.store, runId);
    return pushed;
  }

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
      this.#active.abort.abort(ABORT_CANCELLED);
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
    // THE RATE-LIMIT PARK ENDS HERE TOO, whichever way it was ended. A timer
    // left armed across a manual resume would fire mid-build and requeue a
    // RUNNING run; the row's `rateLimitedAt` is cleared with it so a later boot
    // cannot re-arm from an instant that no longer describes anything.
    this.#clearRateLimitTimer(runId);

    this.#deps.store.updateRun(runId, {
      status: "queued",
      resumeCount: row.resumeCount + 1,
      rateLimited: false,
      rateLimitedAt: null,
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
    // THE DURABLE HALF OF THE RATE-LIMIT PARK. Same argument as the loop above:
    // the timer died with the process and `rate_limited` has no other automatic
    // exit, so without this a restart during an armed wait is a run that waits
    // forever — the very defect this feature was added to remove, reintroduced
    // by the restart.
    //
    // GATED ON THE FLAG BEFORE THE SWEEP, not inside it, so a default install
    // does nothing and says nothing here. The "no timer is armed, a human has to
    // resume this" sentence was already emitted onto each of these runs' logs
    // when they stopped; repeating it on every boot would bury the one that
    // mattered. `#armRateLimitResume` re-checks the flag anyway — it is also the
    // refusal-time path, where the off-reason IS the thing worth saying.
    if (rateLimitAutoResume(this.#deps.env)) {
      for (const row of this.#deps.store.listByStatus("rate_limited")) {
        // RE-ARMED FOR THE REMAINDER: the row's ORIGINAL `rateLimitedAt` goes in,
        // so a dashboard that restarts every few minutes cannot push the deadline
        // forward each time. A row that predates the column carries `null` and is
        // refused rather than restarted — see `planRateLimitResume`.
        this.#armRateLimitResume(row.runId, row);
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
    // Same argument for the rate-limit timers: `unref()` covers process exit and
    // nothing else, and a callback that calls `resume()` against a closed store
    // is a crash on a host that stops the orchestrator without stopping the
    // process. The next boot re-arms them from `rateLimitedAt`.
    for (const runId of [...this.#rateLimitTimers.keys()]) this.#clearRateLimitTimer(runId);
    // Same argument once more: an interval whose callback reads the store is a
    // crash on a host that stops the orchestrator and closes the database while
    // the process lives. Nothing is lost by clearing it — the measurement lives
    // in the events table, so the next boot's first `GET /api/runs/:id` reports
    // the same silence without any timer having run.
    for (const runId of [...this.#silenceTimers.keys()]) this.#clearSilenceWatch(runId);
    // REASONED, so the run being torn down is not recorded as a failure. See
    // ABORT_SHUTDOWN: this path must leave the row `running` for
    // `reconcileOnBoot`. `#stopped` is already set above, so the `pump()` in
    // `#start`'s finally cannot start the next queued run on the way out.
    this.#active?.abort.abort(ABORT_SHUTDOWN);
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
      // THE WATCH ENDS WHERE THE RUN'S TIME IN THIS PROCESS ENDS — in the
      // `finally`, so a throw, a cancel, a rate-limit park and a design park all
      // disarm it. A watch left running on a parked run would announce a silence
      // that is the park working correctly.
      this.#clearSilenceWatch(runId);
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

    /*
     * THE TICKET IS DERIVED, NOT READ OFF THE ROW — AND NOW IT NEEDS THE
     * REFERENCE MANIFEST TO DERIVE THE SAME ANSWER THE INTAKE DID.
     *
     * `ticketFromText(row.ticketText)` was enough until a ticket could carry
     * reference IMAGES. Their sha256 digests are part of the ticket's identity
     * (the owner's explicit decision — see `ticketWithReferences`) and they are
     * not recoverable from the text, so the digests have to come off the
     * manifest `http.ts` wrote beside the run.
     *
     * WHY NOT SIMPLY `row.ticketId`, WHICH HOLDS EXACTLY THIS STRING. Because
     * the orchestrator has never trusted that column, and two sequencing tests
     * depend on not trusting it: they seed `ticketId: "seeded-at-create"` and
     * hand-freeze the suite under `ticketFromText(row.ticketText)`, which is
     * their guard that no test spends quota. `#specPhase` swallows a suite
     * mismatch and falls through to `authorAndFreezeSuite`, which spawns the
     * real CLI — so reading the row here would have turned a green test suite
     * into a quota bill.
     *
     * A MISSING MANIFEST DEGRADES TO THE PROSE-ONLY ID, which for a run that had
     * reference images is the WRONG ticket and would author a second suite. That
     * is worth a loud line rather than a silent divergence, so the two ids are
     * compared below when a manifest exists.
     *
     * THE WHOLE MANIFEST GOES IN, NOT `manifest.images` — CHANGED 2026-07-30 WITH
     * ATTACHED DOCUMENTS. Document digests now enter the ticket id exactly as
     * image digests do (`referenceIdentityMaterial`, and the owner's rule that a
     * different reference is a different ticket). `ticketFromStoredBrief` takes
     * images ALONE and so cannot see them: keeping it here would have computed a
     * prose+images id at run time against a prose+images+documents id computed at
     * intake, which does not fail to compile and does not throw — it silently
     * misses `assertSuiteIntact`, authors a SECOND suite on the owner's quota,
     * and grades the run against a yardstick the row's own `ticketId` does not
     * name. `ticketFromStoredReferences` is the read-back path ticket.ts declares
     * for exactly this, and folding a future manifest list in stays a one-place
     * change there rather than a fifth argument here.
     */
    const manifest = readReferenceManifest(referenceDirFor(this.#deps.paths.runs, runId));
    const ticket: Ticket = ticketFromStoredReferences(row0.ticketText, manifest);
    if (manifest !== null && ticket.id !== row0.ticketId) {
      this.#emitLog(
        runId,
        "warn",
        `this run's ticket derives to ${ticket.id} but was recorded as ${row0.ticketId}. Its reference ` +
          "manifest has changed or been lost since the ticket was submitted, so the run will be graded " +
          "against a suite authored for a different set of references.",
      );
    }
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
    // ARMED THE MOMENT THE ROW SAYS `running`, because that is the moment the
    // dashboard starts claiming this run is working. Everything below — the spec
    // seat, both build segments, the gate/fix loop, the judge — is inside the
    // window it covers.
    this.#armSilenceWatch(runId);

    try {
      // ---- PHASE 1: the sealed acceptance suite ------------------------
      this.#setPhase(runId, "spec");
      let suite: AcceptanceSuite;
      try {
        suite = await this.#specPhase(runId, ticket, signal);
      } catch (error) {
        // AN ABORT IS NOT A FAILURE, AND THIS IS WHERE THAT WAS LOST.
        //
        // `#specPhase` reaches the model through `SubscriptionSeatCaller`, which
        // THROWS on abort — the SDK's own `Claude Code process aborted by user`,
        // wrapped as a `SeatCallError`. A throw skips the `signal.aborted` check
        // below, so the abort was caught by `#start` as a harness fault and the
        // run was finished `failed`: terminal, refused by `resume()`, with a
        // message blaming a user who did nothing. The BUILD phase never had this
        // hole because it returns a `{kind: "cancelled"}` discriminant instead of
        // throwing; the spec phase had no equivalent.
        //
        // The order matters: check the SIGNAL, not the message. The CLI's wording
        // is identical whoever aborted, and matching on it would be a guess about
        // a vendor string that is free to change.
        if (signal.aborted) return this.#aborted(runId, log, signal);
        throw error;
      }
      // SPEC-PHASE EXIT. Written here, above the abort check, for two reasons:
      // a run cancelled during the spec phase has still had criteria inferred on
      // its behalf and the record of them is exactly as useful, and this is the
      // last moment before the build starts — everything in that file is a
      // sentence the owner can add to the TICKET, which is the cheap correction.
      this.#recordAssumptions(runId, ticket, runPaths);
      if (signal.aborted) return this.#aborted(runId, log, signal);

      // ---- PHASE 2: build ---------------------------------------------
      // TWO SEGMENTS, ONE SESSION. `#buildPhase` runs the DESIGN segment and the
      // BUILD segment against one `session_id`, with the lock between them.
      this.#setPhase(runId, "build");
      const built = await this.#buildPhase(runId, ticket, runPaths, log, signal);
      // SAME SPLIT AS THE SPEC PHASE. `kind: "cancelled"` only says the signal
      // fired; a build torn down by a server stop is resumable and must not be
      // finished `cancelled`, which is terminal.
      if (built.kind === "cancelled") return this.#aborted(runId, log, signal);
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
      // ---- PHASE 5: the human-factors adversary (`/debugfix --web --max`) ----
      //
      // HERE AND NOWHERE EARLIER, for one mechanical reason: `#maybePreview` on
      // the line above is where a `previewUrl` first exists, and a pass with no
      // URL to attack is a lane that spends turns and reports nothing. It is also
      // after the gate on purpose — the artefact it attacks is the one that was
      // scored, and its findings are QUALITY tier, so they must not reach
      // anything `isGreen` reads.
      await this.#adversaryPhase(runId, ticket, runPaths, loop.result, signal);
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

    /*
     * THE ATTACHED DOCUMENTS, READ ONLY NOW — AFTER THE REUSE BRANCH ABOVE HAS
     * DECLINED. Two spawns for the capability probe plus one extraction per
     * document is real work, and a resumed or repeated run that reuses its
     * frozen suite makes no seat call for them to reach.
     *
     * SKIPPING THEM ON THE REUSE PATH IS SAFE ONLY BECAUSE DOCUMENT DIGESTS ARE
     * PART OF THE TICKET ID (`referenceIdentityMaterial`, via
     * `ticketFromStoredReferences` at the top of `#start`). A reused suite is a
     * suite authored under the same id, therefore under the same document bytes.
     * If that identity rule is ever relaxed, this becomes a suite authored from
     * one scope being reused for a run carrying another, and the fetch has to
     * move above the reuse branch with a loud line attached.
     */
    const documents = await this.#seatDocuments(runId);

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
      // EVERY CALL THIS SEAT MAKES CARRIES THEM — the first authoring attempt
      // and every regeneration after it. An empty list is the pre-document
      // path, byte for byte; see `seatPrompt`.
      documents,
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
      // NO DOCUMENTS, DELIBERATELY, AND IT HAS A COST. The audit seat runs the
      // deterministic bad-test checks and the adversarial judge pass over the
      // DRAFT SUITE; giving it the PDF too would re-send those bytes on a call
      // that grades the suite's shape rather than its fidelity to the document.
      // What that buys in quota it gives up in coverage: a criterion the spec
      // seat mis-derived from page 4 of the owner's scope is not something the
      // auditor can catch, because the auditor never sees page 4.
    });

    if (documents.length > 0) {
      this.#emitLog(
        runId,
        "info",
        `the spec seat will see ${String(documents.length)} attached document(s) on every call it ` +
          `makes: ${specCaller.documentPlan.notes.join("; ")}`,
      );
    }

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
    if (specCaller.documentPlan.notes.length > 0) {
      // THE REPEAT COST, AS A MEASUREMENT. `describeTokens` above already says
      // what the seat spent; this says how much of it was the same attachment
      // sent again, which is the number nobody agreed to in advance. Both
      // figures are counted by the caller, not estimated here.
      this.#emitLog(
        runId,
        "info",
        `spec seat documents — ${describeSeatDocuments(specCaller.documentPlan, specCaller.documentCalls)}`,
      );
    }

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
   * The documents this run's owner attached, in the form the spec seat takes.
   *
   * OFF DISK, NOT OUT OF THE ROW — the same decision the reference images take
   * (`#buildPhase` says why): a 4 MB PDF has no business in SQLite, so the bytes
   * are files under the run and the manifest beside them is the record. This is
   * therefore the ONE place the spec seat's attachments come from, and a run
   * whose manifest was lost carries none rather than half.
   *
   * THE PROBE HAPPENS ONLY WHEN SOMETHING IS ATTACHED, and it happens EVERY time
   * something is: `probeDocumentCapability` spawns two version flags and
   * `document-capability.ts` deliberately keeps no TTL cache, so the cost is
   * ~two spawns per run with documents and exactly zero for every run without.
   *
   * AN UNUSABLE EXTRACTOR IS NAMED HERE RATHER THAN LEFT TO THE PROMPT. The
   * per-document consequence still reaches the seat (`documentPromptText`
   * renders the degradation), but the owner reading a run's log needs the
   * machine-level cause once, at the top, in the probe's own words —
   * `brew install poppler` is not something the model can tell them.
   *
   * `ReferenceDocument` IS PASSED STRAIGHT THROUGH. It carries `path` and
   * `mediaType`, which is exactly `AttachedDocument`; its `sha256` and `bytes`
   * are identity and provenance that the seat has no use for. No mapping step
   * means no place for one to drift.
   */
  async #seatDocuments(runId: string): Promise<readonly SeatDocument[]> {
    const manifest = readReferenceManifest(referenceDirFor(this.#deps.paths.runs, runId));
    const attached = manifestDocuments(manifest);
    if (attached.length === 0) return [];

    const capability = await probeDocumentCapability();
    for (const [route, health] of [
      ["pdftotext", capability.pdftotext] as const,
      ["textutil", capability.textutil] as const,
    ]) {
      const needed = attached.some((document) => routeFor(document.mediaType) === route);
      if (needed && !extractorIsUsable(health)) {
        this.#emitLog(
          runId,
          "warn",
          `${route} is not usable on this machine, so text extraction is unavailable for at least one ` +
            `attached document: ${health.detail}`,
        );
      }
    }

    return seatDocumentsFor(attached, { capability });
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
   *
   * MEASURED AGAINST THE OWNER'S PROSE, NOT THE COMPOSED BRIEF, AND THIS IS A
   * DELIBERATE CHOICE WITH A COST. `writeAssumptions` counts a criterion as
   * inferred when it is not traceable to the ticket, and the sentence it feeds
   * says "not stated in YOUR TICKET". Once a captured page's headings are part
   * of `ticket.brief`, passing the brief here would silently reclassify every
   * criterion the spec seat derived from that capture as something the owner
   * wrote — and the whole value of this document is that it lists what was
   * assumed ON THEIR BEHALF, which a machine reading of somebody's nav bar
   * squarely is.
   *
   * THE COST: a run whose ticket named a site will now report MORE inferred
   * criteria than one whose ticket spelled the same structure out by hand, even
   * though the capture is what made those criteria good. That is the honest
   * direction to be wrong in — it over-reports what the owner did not say — but
   * it does mean `RunDetail.inferredCriteria` is not comparable between a
   * captured ticket and a hand-written one.
   *
   * ATTACHED DOCUMENTS MAKE THAT COST BIGGER AND SHARPER (2026-07-30). A scope
   * or a brief now reaches the spec seat as a PDF or as extracted text, and NONE
   * of it is in `ticketProse(ticket.brief)` — the manifest holds the document,
   * the brief does not. So every criterion the seat derived from the owner's own
   * scope counts as INFERRED, and the sentence below tells the owner it was "not
   * stated in YOUR TICKET" about a requirement they wrote down and attached.
   * The input is still deliberately the prose: folding document text in would
   * reclassify a machine reading of a 40-page PDF as something the owner said,
   * which is the failure this record exists to prevent, and it is the larger of
   * the two wrongs. The consequence to carry forward is that
   * `RunDetail.inferredCriteria` is now non-comparable across THREE cases, not
   * two: prose-only, prose+capture, and prose+attached documents.
   */
  #recordAssumptions(runId: string, ticket: Ticket, runPaths: RunPaths): void {
    try {
      const record = writeAssumptions(
        runPaths.results,
        ticketProse(ticket.brief),
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
    // Classified from THE OWNER'S OWN WORDS, which is `ticket.brief` minus the
    // capture block `ticket-refs.ts` may have composed into it. It used to be the
    // whole brief, on the grounds that the surface should be decided from exactly
    // the string the builder is handed; that reasoning stops holding the moment
    // part of the brief is a machine reading of somebody else's page. A captured
    // navigation carrying "Blog", "API" and "CLI" is precisely the input that
    // flips this keyword classifier — and the surface decides the delegation
    // shortlist AND the design lane, so a nav bar would be choosing the run's
    // agents. `ticketProse` returns the brief unchanged when there is no capture,
    // so every run without one classifies byte-identically to before.
    //
    // `classifySurface` is pure, total and keyword-based on purpose (see
    // surface.ts): it runs before the build session exists, on the path that
    // builds a permission boundary, and a boundary that can time out or be
    // refused is not a boundary. An unrecognisable ticket classifies `fullstack`,
    // the widest set, because under-delegation is the failure nobody sees.
    const surface = classifySurface(ticketProse(ticket.brief));
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

      /* ---- THE OWNER'S MID-FLIGHT MESSAGES, DRAINED AT THIS BOUNDARY ------
       *
       * This is the one place in the run where a new instruction can be handed to
       * the builder without interrupting a subprocess mid-thought: the segment
       * boundary, where the prompt is composed fresh from durable rows anyway.
       *
       * WHY NOT MID-SEGMENT. There is no supported way to push a turn into a
       * running Claude Agent SDK session from outside it, and killing the
       * subprocess to restart it with more text would throw away the session the
       * two build segments deliberately share (the token totals SUM across them,
       * which is how the shared session was proved). So "mid-flight" means
       * "between agents", which is what the owner is shown.
       *
       * READ HERE, MARKED DELIVERED AFTER THE PROMPT IS WRITTEN. If the process
       * dies between the two, the message stays pending and the next attempt
       * re-injects it — losing a stamp is recoverable, losing an instruction is
       * not.
       */
      /*
       * THE WINDOW THIS SEGMENT'S REPLY IS MEASURED OVER, TAKEN BEFORE THE DRAIN.
       *
       * `AgentReplyWatch.record` at the end of this segment only stores a reply if
       * the owner actually said something to it, and "said something" means an
       * owner message whose `delivered_at` lands at or after this instant. It has to
       * be read HERE, before `markMessagesDelivered` runs a few lines below, or the
       * boundary drain's own stamps would fall outside the window and a boundary
       * message would never get an answer — the live-push case would work and the
       * queued case would silently not, which is the harder of the two to notice.
       */
      const segmentWindowStart = new Date().toISOString();
      const pending = store.pendingMessages(runId);
      const ownerNote = ownerMessageBlock(pending);

      /* ---- THE TICKET'S REFERENCE IMAGES AND SITE CAPTURE ------------------
       *
       * READ OFF DISK, NOT OUT OF THE ROW. The bytes live under
       * `runs/<id>/references/` and the manifest beside them; SQLite holds
       * neither, for the same reason the chat images are files. Re-read on every
       * segment because a park can outlive the process, so there is no in-memory
       * state from segment 1 to carry forward.
       *
       * TWO AUDIENCES, TWO WORDINGS, AND NEITHER GOES NEAR THE SPEC SEAT. The
       * spec seat has already run by the time this line executes, and what it saw
       * was `ticket.brief` — TEXT ONLY, containing the captured outline and no
       * path. These blocks carry ABSOLUTE PATHS and exist only in the build and
       * design prompts, where the agent has a filesystem.
       *
       * `null` MANIFEST AND EMPTY MANIFEST BOTH RENDER "", so this appends
       * unconditionally: the same shape `videoPrompt` and `ownerNote` use, and
       * the reason there is no `if` here to forget.
       */
      const references = readReferenceManifest(referenceDirFor(this.#deps.paths.runs, runId));

      const prompt = designSegment
        ? designSegmentPrompt({
            ticketText: ticket.brief,
            workspace: runPaths.workspace,
            mode: laneMode,
            capability: this.#capability(),
            autoChoose: policy === "auto",
          }) +
          designReferenceSection(references) +
          ownerNote
        : // APPENDED UNCONDITIONALLY. `videoPrompt` is "" whenever there are no
          // legs, so a degraded lane adds nothing; §7.3 mechanism 2 is why the
          // ABSOLUTE paths have to be in the prompt at all — a path in a prompt
          // is what makes a `Read`/`fetch` actually happen.
          this.#buildSegmentPrompt(row, ticket, runPaths, manifest, laneMode, fullShortlist) +
          builderReferenceSection(references) +
          (videoPrompt === "" ? "" : `\n\n${videoPrompt}\n`) +
          ownerNote;
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

      /*
       * MARKED ONLY NOW — after the text is in the prompt AND the prompt is on disk.
       *
       * The ordering is the whole guarantee. Stamped at read time, a crash between
       * read and prompt would leave a message recorded as delivered that no builder
       * ever saw, and the owner would believe a redirection landed. Stamped here, the
       * worst case is re-injecting an instruction, which is visible and harmless.
       */
      if (pending.length > 0) {
        store.markMessagesDelivered(runId, pending.map((message) => message.seq));
        /*
         * `bus.emit` RATHER THAN `sink.log`: `sink` is declared below this point and a
         * `sink.log` here is a use-before-declaration (caught by tsc, not by a test).
         * The event is the same shape either way — the sink is a thin wrapper over
         * this bus — and the owner needs this line in the trace, because it is the
         * only durable record that the instruction was actually taken up.
         */
        this.#deps.bus.emit(runId, {
          type: "log",
          level: "info",
          text: `${String(pending.length)} owner message(s) folded into the ${designSegment ? "DESIGN" : "BUILD"} segment prompt`,
        });
      }

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

      /*
       * THE REPLY CHANNEL'S CAPTURE POINT. One watch per segment, because it holds
       * the last thing the agent said and segment 1's last words are not segment 2's
       * reply. It reads the raw seam below and writes at most one `messages` row at
       * the end of this segment — or none, which is the case it exists to preserve.
       */
      const reply = new AgentReplyWatch();

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
        /*
         * THE BUILD LOG FIRST, THE CHAT SECOND, AND BOTH FROM THE SAME STRING.
         *
         * `observe` only remembers the chunks tagged `[assistant]`; everything else
         * on this seam (`[command]`, `[patch]`, `[reasoning]`, `[result]`) passes
         * through to the log untouched. The log write stays first so that a chat
         * capture that ever threw could not cost the run its transcript — the
         * transcript is the record every other diagnosis is made from, and it is
         * also where a truncated reply says the whole message lives.
         */
        raw: (text) => {
          log.write(text);
          reply.observe(text);
        },
      };

      this.#emitLog(
        runId,
        "info",
        `${row.builderSessionId === null ? "starting" : "resuming"} the ${designSegment ? "DESIGN" : "BUILD"} ` +
          `segment with ${entry.option.label}` +
          `${entry.effort === null ? "" : ` at effort ${entry.effort}`}`,
      );

      /*
       * THE LIVE CHANNEL FOR THIS SEGMENT.
       *
       * Registered against the run id so `POST /api/runs/:id/messages` can push into
       * the RUNNING session — the switch from boundary-only delivery. It is torn down
       * in the `finally` below; the builder also closes the iterable itself, which is
       * what lets the subprocess exit.
       *
       * Both paths stay live and that is deliberate, not redundant: a message typed
       * while a segment RUNS goes down this channel, and a message that arrives while
       * the run is PARKED (awaiting_input, rate_limited) or between segments has no
       * open session to push into, so the boundary drain above still carries it.
       */
      const liveInput = new LiveInput(prompt);
      this.#liveInputs.set(runId, liveInput);
      this.#replyWatches.set(runId, reply);

      const outcome = await builder.build({
        runId,
        prompt,
        liveInput,
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
          // AND the score records. `ScoreRecord.criterionCoverage[].testRefs`
          // carries held-out test titles verbatim — measured on the live run,
          // 24 of them in one file — and the suite is frozen per ticket and
          // reused across attempts, so a builder reading a PREVIOUS run's score
          // would learn the titles it is about to be graded against while
          // `heldOutPass` stayed true and meant nothing. Named 2026-07-30; it
          // was in no deny layer before that.
          scoresRoot(this.#deps.paths),
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

      /*
       * THE SEGMENT'S CHANNEL IS DONE. The builder already closed the iterable in its
       * own `finally` (which is what let the subprocess exit); this drops the map
       * entry so the next segment installs a fresh one.
       *
       * A LEAKED ENTRY WOULD BE INERT RATHER THAN WRONG — `pushLiveMessage` refuses a
       * channel whose `closed` flag is set, so a message would fall through to the
       * queue exactly as it does for a parked run. Removed anyway: a map that grows
       * with every segment of every run is a leak even when each entry is harmless.
       */
      this.#liveInputs.delete(runId);
      this.#replyWatches.delete(runId);

      /* ---- THE RUN'S REPLY, IF IT MADE ONE -------------------------------
       *
       * WHAT THIS CLOSES. Until 2026-07-31 the chat was one-way: the owner asked a
       * live run "Give me the link to the website", the row shows it delivered and
       * stamped read, and nothing came back, because nothing turned what the agent
       * said into a message. It is stored here rather than announced, because the
       * chat is the surface he asked the question on.
       *
       * NOTHING IS STORED UNLESS THE AGENT SAID SOMETHING AND THE OWNER SPOKE FIRST.
       * `record` returns null for either, and null is a correct outcome the UI is
       * meant to render as "the run did not answer" — there is deliberately no
       * fallback sentence. Read `AgentReplyWatch` before adding one.
       *
       * BEFORE THE FOUR RETURNS BELOW, AND THAT PLACEMENT IS THE POINT. A cancelled,
       * failed or rate-limited segment is exactly when an owner is waiting on an
       * answer; recording after `if (outcome.cancelled) return` would answer only
       * the runs that finished cleanly.
       *
       * WHAT IT STILL MISSES, STATED RATHER THAN IMPLIED: a throw OUT of
       * `builder.build()` skips this line, because this loop has no `try`. Both
       * drivers catch their own errors and return them as `outcome.failure`
       * (claude-builder.ts:1526, codex-builder.ts:187), so that path is a driver
       * bug rather than a normal ending — but it is not covered, and wrapping a
       * 50-line call in a `try` in a file three agents are editing is a larger
       * change than the gap it closes.
       */
      const stored = reply.record(
        store,
        runId,
        store.ownerMessagesDeliveredSince(runId, segmentWindowStart),
      );
      if (stored !== null) {
        // ON THE TRACE TOO, because the chat panel refetches on send and on tab
        // focus rather than on an event (`page.tsx`), so a reply can sit unread in
        // a tab the owner is not looking at. This line is the pointer, not the
        // reply: the text is in the chat, where the question was asked.
        this.#emitLog(runId, "info", "the run answered in the chat");
      }

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
    // NOT ON A RATE LIMIT. That run is not terminal — it stops until something
    // resumes it, whether that is the owner or the opt-in timer — and a backlog
    // headed "Stopped: cancelled" for a run that is going to continue is a false
    // statement about work that is not finished. The next attempt writes it.
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
      sealedRoots: [
        this.#deps.paths.acceptance,
        scorerOutRoot(this.#deps.paths),
        scoresRoot(this.#deps.paths),
      ],
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
      const gate = await (this.#deps.makeGate ?? createGate)(gateEnv(this.#deps.paths, this.#deps.env));
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

  /* ---- phase 5: the human-factors adversary ---------------------------- */

  /**
   * `/debugfix --web --max`'s adversarial phase, as a lane — the command itself
   * declares `disable-model-invocation: true` and a subagent cannot invoke a slash
   * command at all, so what runs is its PROCEDURE, compiled here.
   *
   * IT NEVER BLOCKS, AND THAT IS MECHANICAL RATHER THAN INTENDED. This method is
   * reached AFTER the gate/fix loop has stopped and after `scored.record` was
   * found non-null; it writes no status, no `heldOutPass` and no `failureReason`,
   * and the only report it folds findings into is the BACKLOG. The owner's
   * standing decision for the visual gate applies verbatim: subjective judgement
   * informs a run, it does not false-fail one.
   *
   * IT IS ALSO ALLOWED TO FAIL. Everything here is the record of a run that has
   * already produced its verdict, so every failure path logs and continues — a
   * pass that cannot spawn must not turn a passed run into a harness fault.
   */
  async #adversaryPhase(
    runId: string,
    ticket: Ticket,
    runPaths: RunPaths,
    loop: GateFixLoopResult,
    signal: AbortSignal,
  ): Promise<void> {
    const surface = classifySurface(ticket.brief);
    const previewUrl = this.#deps.store.getRun(runId)?.previewUrl ?? null;
    // A SIBLING OF THE ARTEFACT, NEVER INSIDE IT. This is the session's `cwd`, so
    // `buildOptions` scopes the CLI sandbox's `allowWrite` and the workspace-write
    // guard to it — which is what makes the pass unable to edit the thing it is
    // judging. `adversaryRefusal` re-checks the isolation through
    // `canonicaliseForDecision` (the same resolver those two layers use) and
    // refuses to spawn if this is ever pointed at the workspace.
    const scratchDir = join(runPaths.results, "adversary-scratch");

    // THE CANVAS NODE IS EMITTED BEFORE THE LANE RUNS, unconditionally, and both
    // halves of that matter. BEFORE, because `foldGraph` DROPS any event naming a
    // node it has not seen (`graph.ts:180-183`) — the session's own remapped tool
    // pills arrive during the spawn, so a node announced afterwards would lose
    // them. UNCONDITIONALLY, because "the pass was considered and did not apply"
    // is a fact about the run, and a canvas that shows nothing cannot be told
    // apart from a build of this program that never had this lane.
    const priorGraph = this.#deps.store
      .eventsSince(runId, 0)
      .map((stored) => stored.event)
      .filter((event): event is GraphSseEvent => event.type.startsWith("graph_"));
    const base = graphResumeState(priorGraph);
    const node = `n${String(base.minted + 1)}`;
    this.#emit(runId, {
      type: "graph_agent",
      node,
      // PARENTED ONTO THE RUN'S ROOT, AS AN INFERENCE. This was `parent: null`
      // with `attribution: "exact"`, on the reasoning that the harness started
      // this session so an edge from the build root would be a claim no message
      // made. That reasoning was right about the edge and wrong about the cost of
      // omitting it, in two places that were only visible on the client:
      //
      //   · `layout.ts#columnOf` reads `parent === null` as "this is the root"
      //     and puts the node in the column captioned "The run's own session" —
      //     so a review pass rendered as a SECOND orchestrator session sitting
      //     beside the real one. Parentless is not a neutral value on this
      //     canvas; it is a specific claim, and a louder one than the edge.
      //   · The chat composer mounts only for `parent === null`
      //     (`runs/[runId]/page.tsx:410`), so selecting this node offered a text
      //     box that could not reach anything: this session has already ended by
      //     the time the node is selectable, and it was never the run's own
      //     session to inject into.
      //
      // `attribution: "inferred"` is what keeps the edge honest. It is the exact
      // idiom `graph-emit.ts:276-278` already uses for "we know the node, we
      // worked out its parent" — the edge is drawn as a guess (dashed, no bloom,
      // `flow-edge.tsx:20-25`) rather than as a delegation the builder reported.
      // WHAT IT COSTS: the node also gets the client's `inferred` chip, whose
      // tooltip explains itself with "Hook messages carry no task identity" —
      // true of every other inferred node and not of this one. That copy lives in
      // `agent-node.tsx:337-344` and is not touched here.
      //
      // IT ALSO RESTORES AN INVARIANT ANOTHER FILE ALREADY DEPENDS ON.
      // `build-segment.ts:139-149` states that `parent === null` names exactly
      // one node per segment, says no branch could produce a second one, and
      // names itself as the line that must change if one ever appears. This was
      // that second branch — latent only because the lane has never executed on a
      // real run (it needs a `previewUrl`, which needs a scored run).
      //
      // `base.rootNode` IS NULL ONLY WHEN NO BUILD NODE EXISTS AT ALL, which is a
      // run whose build emitted no `graph_agent`. There is nothing to point at
      // then, so the node stays parentless and `exact` — the pre-existing
      // behaviour, in the one case where "the only session on the canvas" is not
      // a false statement.
      parent: base.rootNode,
      agent: ADVERSARY_AGENT,
      lane: "review",
      description: "the /debugfix --web --max human-factors pass — read-only, non-gating",
      ambient: false,
      attribution: base.rootNode === null ? "exact" : "inferred",
      sdk: null,
    });

    const result = await runAdversaryLane({
      surface,
      previewUrl,
      scratchDir,
      artefactDir: runPaths.workspace,
      agentDenylist: () => this.#adversaryAgentDenylist(),
      canonicalise: canonicaliseForDecision,
      spawn: (call, spawnSignal) =>
        (this.#deps.spawnAdversary ?? ((input) => this.#spawnAdversaryWithBuilder(input, node)))({
          runId,
          call,
          signal: spawnSignal,
        }),
      log: (level, text) => this.#emitLog(runId, level, text),
      signal,
    });

    this.#emit(runId, {
      type: "graph_result",
      node,
      // `stopped`, NEVER `failed`, for a refusal. A lane that declined to run
      // because the run has no browsable preview did not fail, and this codebase
      // refuses that conflation everywhere else (`heldOutPass: null` is not
      // `false`).
      state: result.stop === "ran" ? "completed" : "stopped",
      summary: summariseAdversary(result),
      totalTokens: null,
      toolUses: null,
      durationMs: null,
      attribution: "exact",
    });

    for (const finding of result.findings) {
      this.#emitLog(
        runId,
        finding.severity === "CRITICAL" || finding.severity === "HIGH" ? "warn" : "info",
        `adversary finding [${finding.severity}/${finding.klass}] ${finding.summary}` +
          `${finding.detail === undefined || finding.detail.length === 0 ? "" : ` — ${finding.detail}`}`,
      );
    }

    this.#recordAdversary(runId, runPaths, result, surface, previewUrl);

    // THE BACKLOG, REWRITTEN AS A STRICT SUPERSET. `#gateFixLoop` already wrote it
    // with this loop's reason, attempts and unmet counts; this write repeats all
    // three unchanged and appends the findings as remaining work, because the
    // backlog is the file the owner opens the morning after and a finding only in
    // a log line is a finding nobody reads. `withAdversaryFindings` copies
    // `heldOutUnmet` untouched — that is the sealed verdict and this pass is not a
    // second grader.
    if (result.findings.length > 0) {
      this.#recordBacklog(runId, runPaths, {
        reason: loop.reason,
        attempts: loop.attempts,
        remaining: withAdversaryFindings(loop.report, result.findings).failures,
        heldOutUnmet: loop.report.heldOutUnmet,
        denied: loop.deniedTasks,
        infraFailure: loop.report.infraFailure,
      });
    }
  }

  /**
   * The agent file's own `disallowedTools:`, read at the call site.
   *
   * THE FILE IS THE MECHANISM ON THE DELEGATED ROUTE, so it is read on every pass
   * rather than trusted once: `ADVERSARY_DISALLOWED_TOOLS` is a mirror of it, and
   * a mirror drifts. An unreadable or denylist-free file makes
   * `adversaryRefusal` refuse the pass outright (/debugfix §0.4).
   */
  #adversaryAgentDenylist(): readonly string[] | null {
    const path = join(this.#deps.env["HOME"] ?? homedir(), ".claude", "agents", `${ADVERSARY_AGENT}.md`);
    try {
      return parseAgentDenylist(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * The real spawn: one fresh subscription session whose only permitted delegation
   * is the adversary.
   *
   * A FRESH SESSION, NOT THE BUILDER'S. `resumeSessionId` is null and
   * `builderSessionId` is deliberately NOT written by this sink — /debugfix §5
   * requires the adversary to run "in its own context (must NOT read the
   * implementation first)", and resuming the build's session would hand it the
   * whole tree it is supposed to attack blind. Writing the row's session id would
   * be worse than useless: `resume` would then continue the ADVERSARY's session
   * instead of the build's.
   *
   * THE ARTEFACT IS OUT OF REACH BY CONSTRUCTION, not by instruction. `workspace`
   * is the scratch directory, so `buildOptions` sets `cwd` there and scopes both
   * write layers to it; the sealed roots are still named so the held-out titles
   * stay unreadable to a pass that has no business with them.
   *
   * THE FINDINGS COME BACK THROUGH A FILE because `BuildOutcome` has no field for
   * them and the adversary has no Write tool to leave one — the SESSION writes it.
   * Whether a live session complies is UNTESTED here (no test spends quota), so
   * an absent file is recorded as "left no report", which is not the same
   * statement as "found nothing".
   */
  async #spawnAdversaryWithBuilder(
    input: { readonly runId: string; readonly call: AdversaryCall; readonly signal: AbortSignal },
    node: string,
  ): Promise<AdversarySpawnResult> {
    const { runId, call } = input;
    const row = this.#deps.store.getRun(runId);
    if (row === null) return { findings: [], failure: "the run row is gone" };
    const entry = await this.#deps.catalog.resolve(row.modelId);
    if (entry === null || !entry.option.available) {
      return { findings: [], failure: "no model is available to run the adversary pass" };
    }
    // ANTHROPIC ONLY, AND IT IS THE DELEGATION BOUNDARY THAT DECIDES. `allowedAgents`
    // is enforced in the Anthropic driver's PreToolUse hook and the Codex driver
    // "ignores this field completely" (builders/types.ts) — so on Codex this pass
    // would be an unbounded session with no delegation boundary, attacking a live
    // app. There is also no `human-factors-adversary` for it to reach.
    if (entry.option.provider !== "anthropic") {
      return {
        findings: [],
        failure:
          `the adversary pass is not run on ${entry.option.provider}: its driver ignores allowedAgents, ` +
          "so the delegation boundary this pass depends on would not exist",
      };
    }

    mkdirSync(call.scratchDir, { recursive: true });
    // ONE REMAP, ROOTED ON THE NODE ALREADY ANNOUNCED. This is a second session, so
    // `GraphProjection` mints from `n1` again; without the remap its `graph_agent`
    // for `n1` collides with the build's and every later pill attaches to the
    // BUILD's first agent (`build-segment.ts` documents the same failure at the
    // resume seam). `rootNode: node` maps this session's own parentless root onto
    // the node emitted above — `foldGraph` ignores the duplicate — and its
    // delegated child mints fresh ids above the run's high-water mark.
    const remap = makeSegmentRemap({ rootNode: node, minted: Number.parseInt(node.slice(1), 10) });
    const carried = row.tokens;

    const outcome = await this.#builderFor(entry.option.provider).build({
      runId,
      prompt: call.sessionPrompt,
      workspace: call.scratchDir,
      sealedRoots: [this.#deps.paths.acceptance, scorerOutRoot(this.#deps.paths), scoresRoot(this.#deps.paths)],
      allowedAgents: call.allowedAgents,
      modelId: row.modelId,
      effort: entry.effort,
      resumeSessionId: null,
      signal: input.signal,
      sink: {
        log: (level, text) => this.#emitLog(runId, level, text),
        tool: (name, summary) => this.#emit(runId, { type: "tool", name, summary }),
        tokens: (totals) => {
          const merged = mergeTokenTotals(carried, toApiTokens(totals));
          this.#deps.store.updateRun(runId, { tokens: merged });
          this.#emit(runId, { type: "tokens", ...merged });
        },
        rateLimit: (state) => this.#noteRateLimit(runId, state),
        // DELIBERATELY NOT `store.updateRun({builderSessionId})` — see the docblock.
        session: () => undefined,
        environment: () => undefined,
        contextUsage: () => undefined,
        compaction: () => undefined,
        graph: (event) => this.#emit(runId, remap(event)),
        // The build log is closed by the time this phase runs, so this session's
        // raw JSONL is not persisted. Its curated lines are events on the run and
        // its findings are the report file; said here rather than left as a
        // surprising gap in `build.log`.
        raw: () => undefined,
      },
      env: this.#deps.env,
    });

    if (outcome.tokens.callCount > 0) {
      this.#emitLog(runId, "info", `${ADVERSARY_AGENT} — ${describeTokens(outcome.tokens)}`);
    }

    let findings: readonly AdversaryFinding[] = [];
    let reportWritten = false;
    let readFailure: string | null = null;
    try {
      if (existsSync(call.findingsPath)) {
        reportWritten = true;
        findings = parseAdversaryFindings(readFileSync(call.findingsPath, "utf8"));
      } else {
        readFailure = "the session left no report file, so this run recorded no findings";
      }
    } catch (error) {
      readFailure = `the report file could not be read: ${describeError(error)}`;
    }
    return { findings, reportWritten, failure: outcome.failure ?? readFailure };
  }

  /**
   * `adversary.json`, written whether the pass ran or not.
   *
   * A MISSING FILE CANNOT BE TOLD APART FROM A STEP THAT NEVER RAN — the same
   * reason `#recordBacklog` writes on every exit — so a refusal gets a record
   * naming its reason. A failure to write it is logged and swallowed: this is the
   * record of a run that has already produced its verdict.
   *
   * IT IS ALSO NOW THE UI'S SOURCE, AND THAT RAISES THE COST OF THIS `catch`.
   * `http.ts#toDetail` reads this file into `RunDetail.adversary`, so a write
   * that fails here is a run whose pass ran, logged its findings to the trace,
   * and then reports `adversary: null` — "no pass on this run" — to the browser.
   * The swallow is still correct (a record-keeping failure must not fail a run
   * that already has its verdict) and the warning below is still the only signal,
   * but the consequence is no longer confined to a file nobody opens.
   *
   * THE FILENAME COMES FROM {@link ADVERSARY_RECORD_FILE} rather than a literal:
   * the reader in `http.ts` spells it from the same constant, and a writer and a
   * reader that spell a filename twice eventually spell it differently.
   *
   * WHY NO SSE EVENT ACCOMPANIES IT. This runs inside `#adversaryPhase`, which
   * `#execute` awaits BEFORE `#finish` emits the terminal status, and the client
   * revalidates the run response on a terminal status — so the record is on disk
   * before the fetch that reads it. An event type would need three additions in
   * the client package and would carry nothing this file does not.
   */
  #recordAdversary(
    runId: string,
    runPaths: RunPaths,
    result: AdversaryLaneResult,
    surface: ReturnType<typeof classifySurface>,
    previewUrl: string | null,
  ): void {
    const record = adversaryRecord({ result, surface, previewUrl });
    try {
      const path = join(runPaths.results, ADVERSARY_RECORD_FILE);
      writeFileSync(path, `${JSON.stringify(redactForPersistence(record), null, 2)}\n`, "utf8");
      this.#emitLog(
        runId,
        "info",
        `the human-factors adversary pass is recorded in ${path} (QUALITY tier — it never fails a run)`,
      );
    } catch (error) {
      this.#emitLog(runId, "warn", `the adversary record could not be written: ${describeError(error)}`);
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
    // `limited` GOES ON THE WIRE. It is the difference between "the provider
    // refused this call" and "the window you are in reopens at T", and the two
    // arrive through the same SDK event. Emitting without it made every routine
    // window reading render as a refusal. See the `rate_limit` docblock in
    // api-types.ts for the run that proved it.
    this.#emit(runId, {
      type: "rate_limit",
      limited: state.limited,
      retryAfterSec: state.retryAfterSec,
    });
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

  /**
   * The provider REFUSED. Park the run, record when, and decide about a resume.
   *
   * THE ONLY WRITER OF `rateLimitedAt`, and that is what makes the field mean
   * "the instant a call was refused" rather than "the last time the SDK
   * mentioned a window". `#noteRateLimit` also writes `rateLimited`, from
   * routine `limited: false` telemetry, so THAT boolean is not the refusal and
   * nothing arms off it.
   */
  #rateLimited(runId: string, state: RateLimitState, sessionId: string | null): void {
    const at = new Date().toISOString();
    const row = this.#deps.store.updateRun(runId, {
      status: "rate_limited",
      queuePosition: null,
      rateLimited: true,
      rateLimitedAt: at,
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
    // AFTER the sentence above, never instead of it: whether or not a timer is
    // armed, the owner is told what happened first and what will (or will not)
    // happen about it second.
    this.#armRateLimitResume(runId, row, at);
  }

  /**
   * Decide, SAY the decision on the run's own log, and arm a timer if there is
   * one to arm.
   *
   * WHY THE LOG IS NOT OPTIONAL. The failure this feature exists to remove is a
   * run that stops with nobody able to tell whether anything will pick it up
   * again. Both outcomes are therefore announced: an armed wait names the
   * instant it will fire, and a refusal names the reason it will not. Silence is
   * the one thing this must never produce.
   *
   * THE TIMER'S ONLY ACTION IS `resume()` — the same path the owner's button
   * takes, with the same refusals (terminal runs, the active run) and the same
   * `resumeCount` increment. Nothing here shortcuts into `#start`.
   *
   * THE `due` ARM IS UNREACHABLE FROM `#rateLimited` AND THAT IS LOAD-BEARING.
   * At a refusal `rateLimitedAt` is `now`, so the remaining wait is the whole
   * reported window and cannot be <= 0; only the boot sweep, where real time has
   * passed, can reach it. If it were reachable at the refusal, `resume()` would
   * be called while this run is still `#active` and would return FALSE — an
   * announced resume that silently did nothing.
   *
   * `#stopped` IS NOT CHECKED, deliberately. `shutdown()` clears the map, and
   * `resume()`'s `pump()` is already a no-op once stopped — so a decision taken
   * during teardown moves a row and starts no subprocess. That is also what lets
   * a test call `shutdown()` first and then observe `reconcileOnBoot` without
   * spending the owner's subscription.
   */
  #armRateLimitResume(runId: string, row: RunRow, now = new Date().toISOString()): void {
    this.#clearRateLimitTimer(runId);
    const plan = planRateLimitResume({
      enabled: rateLimitAutoResume(this.#deps.env),
      rateLimitedAt: row.rateLimitedAt,
      retryAfterSec: row.rateLimitRetryAfterSec,
      resumeCount: row.resumeCount,
      now,
    });
    if (plan.kind === "disabled") {
      this.#emitLog(runId, "warn", `no automatic resume is armed: ${plan.reason}`);
      return;
    }
    if (plan.kind === "due") {
      // The wait was served in wall-clock time while the dashboard was down.
      this.#emitLog(
        runId,
        "info",
        "the rate-limit window the provider reported has already elapsed, so this run is resuming " +
          "automatically. Nothing checked that the window really reopened — that is the provider's own " +
          "reported instant, and if it was wrong the run comes straight back here.",
      );
      this.resume(runId);
      return;
    }
    const firesAt = new Date(Date.parse(now) + plan.delayMs).toISOString();
    this.#emitLog(
      runId,
      "info",
      `automatic resume armed: this run restarts itself in ${String(Math.round(plan.delayMs / 60_000))} min ` +
        `(${firesAt}), because ${RATE_LIMIT_AUTO_RESUME_ENV} is set. That instant is the provider's own ` +
        `reported reset, not a verified one; a refusal on the way back parks the run again.`,
    );
    const timer = setTimeout(() => {
      this.#rateLimitTimers.delete(runId);
      this.#emitLog(runId, "info", "the reported rate-limit window has elapsed; resuming automatically");
      this.resume(runId);
    }, plan.delayMs);
    // `unref` so an armed wait never holds the process open — which is NOT the
    // same as cancelling it, hence `shutdown()` clearing the map as well.
    timer.unref();
    this.#rateLimitTimers.set(runId, timer);
  }

  #clearRateLimitTimer(runId: string): void {
    const timer = this.#rateLimitTimers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#rateLimitTimers.delete(runId);
  }

  /* ---- the silence watch --------------------------------------------- */

  /**
   * Measure how long this run has been quiet and, ONCE per quiet stretch, say so
   * on the run's own log. Returns the measurement, or `null` when the run is not
   * watched.
   *
   * PUBLIC AND TAKING `now`, ON `assignQueuePositions`' PRECEDENT. The only other
   * way to observe this behaviour is to start a real build and wait ninety
   * minutes, which is a test nobody runs — so the timer's whole callback body is
   * this method, and `stall-watch.test.ts` drives it directly with an instant of
   * its own. There is no second copy of the decision for the timer to take.
   *
   * IT ANNOUNCES AND CHANGES NOTHING ELSE. No status write, no requeue, no
   * abort, no `failureReason`. See the block comment above
   * {@link DEFAULT_SILENCE_WARN_MIN}: on this project's own evidence a run that
   * looks stuck is usually still working, and killing it on a heuristic is how
   * real work is lost. The owner is told; the decision stays theirs.
   *
   * THE WARNING IT WRITES IS ITSELF AN EVENT — `RunEventBus.emit` persists before
   * it delivers — WHICH IS WHY {@link SILENCE_NOTICE_PREFIX} LEADS THE TEXT.
   * `lastRunEventAt` filters that sentence out of its own measurement, so the
   * next call still sees the ORIGINAL `since` and the silence keeps growing. Take
   * the prefix off and this method quietly becomes a one-shot: it would report
   * the first ninety minutes of a hang and then measure its own footprints.
   */
  noteSilence(runId: string, now: string = new Date().toISOString()): ApiRunSilence | null {
    const row = this.#deps.store.getRun(runId);
    if (row === null) return null;
    const silence = silenceOf(row, this.#deps.store, this.#deps.env, now);
    if (silence === null || !silence.overThreshold) return silence;
    if (this.#silenceAnnounced.get(runId) === silence.since) return silence;
    this.#silenceAnnounced.set(runId, silence.since);
    this.#emitLog(
      runId,
      "warn",
      SILENCE_NOTICE_PREFIX +
        `${String(silence.quietMin)} min` +
        (silence.sinceKind === "run-start"
          ? " — it has emitted NOTHING since it started"
          : ` (last event ${silence.since})`) +
        `, and this server expects to hear something within ${String(silence.thresholdMin)} min ` +
        `(${SILENCE_WARN_ENV}). ` +
        "THAT IS A MEASUREMENT OF SILENCE, NOT A DIAGNOSIS: nothing here can tell a model that is " +
        "thinking from a subprocess that has died, and doc 03 §7.8 records that 79% of unresolved " +
        "long-horizon runs time out while still actively making progress. NOTHING HAS BEEN KILLED, " +
        "requeued or failed on account of this line — the run is untouched and this is the only thing " +
        "that happened." +
        (row.artifactPath === null
          ? ""
          : ` Look at the workspace to decide: ${row.artifactPath}.`),
    );
    return silence;
  }

  /**
   * Start watching a run that is now actually running.
   *
   * AN INTERVAL, NOT A TIMEOUT, because a silence that has already been
   * announced can still grow into a second one after the run speaks again, and
   * because the threshold is a floor rather than a deadline. `SILENCE_CHECK_MS`
   * bounds only how LATE an announcement can be; the number in it is measured
   * from the events table at the moment it fires, so a slow tick under-reports
   * nothing.
   *
   * `unref` FOR `#parkForDesignLock`'s REASON — a watch must never hold the
   * process open — which is NOT the same as cancelling it, hence `shutdown()`
   * clearing the map as well.
   */
  #armSilenceWatch(runId: string): void {
    this.#clearSilenceWatch(runId);
    const timer = setInterval(() => {
      this.noteSilence(runId);
    }, SILENCE_CHECK_MS);
    timer.unref();
    this.#silenceTimers.set(runId, timer);
  }

  /** Stop watching, and forget which silence was announced. Both, always. */
  #clearSilenceWatch(runId: string): void {
    const timer = this.#silenceTimers.get(runId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.#silenceTimers.delete(runId);
    }
    // NOT CONDITIONAL ON THE TIMER EXISTING. A run resumed after a park would
    // otherwise carry the previous segment's announced instant into its next
    // watch, and the first silence of the new segment — which is a new fact —
    // would be swallowed as a repeat if it happened to start from the same event.
    this.#silenceAnnounced.delete(runId);
  }

  /**
   * An abort fired. Route on WHO aborted, not on what was thrown.
   *
   * The single place that reads {@link abortReasonOf}, so the two outcomes stay
   * one decision rather than being re-derived at every call site.
   */
  #aborted(runId: string, log: BuildLog, signal: AbortSignal): void {
    if (abortReasonOf(signal) === ABORT_SHUTDOWN) {
      this.#abandonedForShutdown(runId, log);
      return;
    }
    this.#cancelled(runId, log);
  }

  /**
   * The server is stopping mid-run. WRITES NO TERMINAL STATE, ON PURPOSE.
   *
   * The row is deliberately left `running`, because that is the exact set
   * `reconcileOnBoot` scans on the next start — it moves those rows to
   * `awaiting_input` and tells the owner `resume` continues them. Writing
   * `failed` or `cancelled` here would hide the run from that sweep forever
   * (`isTerminal` covers both) and make the stop banner's "In-flight builds are
   * aborted and stay resumable" a false statement.
   *
   * NO BACKLOG IS RECORDED EITHER. `#recordUnmeasuredBacklog` writes "what this
   * run did not close", which is a statement about a run that ENDED. This one
   * has not ended; it is being picked up again.
   *
   * The log is closed because the file handle dies with the process regardless,
   * and the warning is emitted before that so the reason is durable in the event
   * stream the next boot will replay.
   */
  #abandonedForShutdown(runId: string, log: BuildLog): void {
    this.#emitLog(
      runId,
      "warn",
      "the dashboard stopped while this run was in flight, so its subprocess was aborted. Nothing is " +
        "lost: the run stays resumable and the next start moves it to awaiting_input with a resume " +
        "button. This is a clean stop, not a failure of the run.",
    );
    log.close();
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
   * `rate_limited` deliberately does not come through here: it is not terminal
   * and a verdict written for it would be a verdict on a run that has not
   * finished. `#rateLimited` writes its own patch for exactly that reason.
   * (WHO resumes it is a separate question with two answers — a human, or the
   * opt-in timer in `#armRateLimitResume` — and this funnel is correct under
   * both, because neither has happened yet at the moment it is skipped.)
   *
   * ORDER IS LOAD-BEARING. The patch is persisted FIRST so the verdict is
   * rendered from the run's final recorded state — the status it is ending in
   * and the failure reason that came with it, not the ones it had a moment ago.
   * The `verdict` event is then emitted BEFORE the `status` event, because a
   * client revalidates on a terminal status and must find `verdictPath` already
   * in the read model when it does. THE PUBLISH OBEYS THE SAME RULE and for the
   * same reason: `project-publish.json` is on disk before the terminal `status`
   * goes out, so the revalidation finds `publishedProject` too.
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
    this.#publishProject(runId, row);
    this.#emit(runId, { type: "status", status });
  }

  /**
   * COPY THE FINISHED CODE SOMEWHERE THE OWNER CAN FIND IT, and say where.
   *
   * WHY IT HANGS OFF `#finish` RATHER THAN OFF THE PASSED BRANCH. Every terminal
   * status comes through here, and a FAILED or CANCELLED run's code is still the
   * thing the owner asked to be able to open — "where is it?" is the first
   * question about a failure, which is the same sentence `artifactPath`'s write
   * site already carries. `rate_limited` deliberately does not reach this method,
   * because it does not reach `#finish`: that run is stopped, not finished, and
   * publishing it would put a half-built site in a folder named after the ticket
   * while the run is still resumable.
   *
   * IT IS SYNCHRONOUS, INSIDE THE TERMINAL PATH. Measured on this machine the
   * two non-empty workspaces are 5.6 MB and 12 MB before exclusions, so the copy
   * is a short pause at the very end of a build that has been running for hours,
   * on a server that runs ONE run at a time. Making it async would put the record
   * write after the terminal `status` event and reintroduce exactly the race the
   * verdict write is ordered to avoid.
   *
   * IT CANNOT FAIL THE RUN. `publishProject` returns a named decline instead of
   * throwing for every failure it can name, and the `catch` covers the rest: a
   * filesystem problem in the publish must never turn a passed run into a harness
   * fault, for the same reason `#writeVerdict` swallows its own.
   *
   * THE LOG LINE IS THE SURFACE THAT ACTUALLY REACHES HIM. `RunDetail
   * .publishedProject` is on the wire for the UI to render, but it needs a panel
   * somebody has written; the run's log wall is already open on the page, so the
   * path is stated there in full — absolute, copy-pasteable, and next to the
   * sentence that says the folder is a copy he owns.
   */
  #publishProject(runId: string, row: RunRow): void {
    const runPaths = runPathsFor(this.#deps.paths, runId);
    try {
      const record = publishProject({
        runId,
        ticketTitle: row.ticketTitle,
        workspace: runPaths.workspace,
        projectsDir: this.#deps.paths.projects,
        resultsDir: runPaths.results,
      });
      if (record.published) {
        this.#emitLog(
          runId,
          "info",
          `YOUR CODE IS SAVED AT ${record.path} — ${String(record.fileCount)} files, ${String(record.bytes)} bytes, ` +
            `${String(record.excluded.length)} entries left out as scaffolding. That folder is a COPY and it is ` +
            `yours: edit it, move it, delete it. The run's own copy stays at ${runPaths.workspace} — that is the one ` +
            "the gate scored, and editing it would not change any verdict.",
        );
      } else {
        this.#emitLog(
          runId,
          "warn",
          `the finished code was NOT copied to ${this.#deps.paths.projects} (${record.reason}): ${record.detail} ` +
            `The run's own copy is still at ${runPaths.workspace}.`,
        );
      }
    } catch (error) {
      // Reached only by a bug in `publishProject` — it returns a decline for
      // every failure it can name. The run has already ended successfully or
      // otherwise, and one uncopied folder does not change that.
      this.#emitLog(
        runId,
        "warn",
        `the finished code could not be published: ${describeError(error)}. The run's own copy is at ` +
          `${runPaths.workspace}.`,
      );
    }
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
