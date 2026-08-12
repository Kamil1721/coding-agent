/**
 * contracts.ts — THE FROZEN INTERFACE.
 *
 * Every other module in the bake-off (runner, spec agent, suite auditor,
 * scorer, reporter) is built against the symbols in this file. Treat it as
 * frozen: adding an optional field is safe, renaming or removing anything is
 * not.
 *
 * The protocol this implements is docs/research/03-model-decision-final.md
 * section 7 ("THE BAKE-OFF PROTOCOL"). Section references in the comments below
 * are to the research documents:
 *
 *   doc 03 = 03-model-decision-final.md            (the protocol)
 *   doc 04 = 04-cost-reduction-playbook.md         (caching + instrumentation)
 *   doc 02 = 02-credentials-verification-judge.md  (judge/gate design)
 *   doc 05 = 05-vals-terminal-bench-2-1-measured.md (the measured leaderboard)
 *
 * FIVE INVARIANTS ARE ENCODED HERE AND MUST NOT BE "IMPROVED" ON:
 *
 *  1. The acceptance suite is sealed and held out. It is authored by a separate
 *     agent from the ticket text alone, before any build run, hashed and
 *     frozen. The builder's self-report is RECORDED (`agentDeclaredDone`) and
 *     NEVER scores anything. 14.1-20.7pp of apparent quality is leakage
 *     (doc 03 section 5 rank 3); ImpossibleBench measured Claude-family models
 *     editing test files >79% of the time.
 *
 *  2. Co-primary metrics, both required: `heldOutPass` and `falseFinish`.
 *     `falseFinish` is DEFINED as `agentDeclaredDone && !heldOutPass` — see
 *     {@link deriveFalseFinish}, which is the only place that definition lives.
 *
 *  3. The cost ceiling is HARD, enforced OUT-OF-PROCESS, checked BEFORE each
 *     API call ({@link PreCallDecision}). Vendor task-budget parameters are
 *     ADVISORY ({@link VendorAdvisoryBudget}) and are recorded, never trusted.
 *     Termination happens on a budget boundary only ({@link KillReason}).
 *
 *  4. Token accounting is PER VENDOR and is never compared across vendors.
 *     Tokenizers differ. {@link VendorUsage} rows are never summed on their
 *     token fields; only {@link sumCostUsd} exists, and it sums dollars.
 *
 *  5. Six variables are held constant across every configuration
 *     ({@link HeldConstants}), and every run record carries them so that any
 *     result can be audited without reference to this source tree.
 */

/* -------------------------------------------------------------------------
 * 0. Schema version, errors
 * ---------------------------------------------------------------------- */

/**
 * Version of the persisted record shapes ({@link RunRecord},
 * {@link ScoreRecord}, {@link LedgerEvent}, {@link AcceptanceSuite}).
 * Bump on any breaking change and never reuse a number.
 */
export const BAKEOFF_SCHEMA_VERSION = 1 as const;

/** Machine-readable failure codes. Used for clean CLI messages, never stacks. */
export type BakeoffErrorCode =
  | "missing_credential"
  | "unknown_model_price"
  | "unpriced_usage"
  | "ambiguous_price_window"
  | "invalid_effort"
  | "invalid_usage_shape"
  | "duplicate_usage_row"
  | "unknown_config"
  | "suite_not_audited"
  | "suite_hash_mismatch"
  | "budget_exceeded"
  | "not_implemented";

/**
 * The single error type this harness throws. Carries a code so the CLI can
 * fail clean and explain itself instead of printing a stack trace.
 */
export class BakeoffError extends Error {
  readonly code: BakeoffErrorCode;
  /** Exact operator action that clears this error. Never contains a secret. */
  readonly remediation: string;

  constructor(code: BakeoffErrorCode, message: string, remediation: string) {
    super(message);
    this.name = "BakeoffError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Explicit "not implemented" marker. The style rule for this project is that
 * anything not implemented throws a clear reason rather than silently
 * returning a fake value. Never catch this to substitute a default.
 */
export function notImplemented(reason: string): never {
  throw new BakeoffError(
    "not_implemented",
    `not implemented: ${reason}`,
    "Implement this seam or remove the call site. Do not substitute a placeholder value.",
  );
}

/* -------------------------------------------------------------------------
 * 1. Providers, seats, reasoning effort
 * ---------------------------------------------------------------------- */

/** Vendors under test. One vendor = one token-accounting namespace. */
export type Provider = "anthropic" | "moonshot" | "deepseek" | "openai";

export const PROVIDERS: readonly Provider[] = ["anthropic", "moonshot", "deepseek", "openai"];

/**
 * Seat roles.
 *
 * - `orchestrator` / `subagent` are the variables UNDER TEST.
 * - `spec` authors the held-out acceptance suite. It is a HELD-CONSTANT
 *   CONTROL, identical in every configuration (doc 03 section 7.4).
 * - `judge` runs the adversarial bad-test audit over the suite before any
 *   build starts. Also held constant. In this bake-off it never scores a run:
 *   `heldOutPass` is decided deterministically by suite execution.
 */
export type SeatRole = "orchestrator" | "subagent" | "spec" | "judge";

/**
 * Per-vendor reasoning-effort ladders.
 *
 * RUNG NAMES ARE NOT COMPARABLE ACROSS VENDORS. Anthropic has five rungs,
 * Moonshot three, DeepSeek two, OpenAI five with different names. Effort alone
 * is worth 250-497 Elo on AA-Briefcase (doc 03 section 5 rank 4), which is far
 * larger than the model gap being measured — so effort is pinned per
 * (model, role), recorded on every seat and every run record, and never
 * treated as a controlled variable that means the same thing on two vendors.
 */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type MoonshotEffort = "low" | "high" | "max";
export type DeepSeekEffort = "high" | "max";
export type OpenAIEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type Effort = AnthropicEffort | MoonshotEffort | DeepSeekEffort | OpenAIEffort;

/** The ladders, for runtime validation. Ordered lowest to highest rung. */
export const EFFORT_LADDERS: Readonly<Record<Provider, readonly Effort[]>> = Object.freeze({
  anthropic: ["low", "medium", "high", "xhigh", "max"] as readonly Effort[],
  // Moonshot: reasoning_effort low/high/max, max is the default (doc 03 table 2.1).
  moonshot: ["low", "high", "max"] as readonly Effort[],
  // DeepSeek: a two-rung dial, no budget primitive at all (doc 03 table 2.1).
  deepseek: ["high", "max"] as readonly Effort[],
  openai: ["minimal", "low", "medium", "high", "xhigh"] as readonly Effort[],
});

/**
 * Where a seat's effort rung came from. An unrecorded effort makes the whole
 * experiment uninterpretable (doc 03 section 7.3 item 1); an unattributed one
 * makes it impossible to tell a prescribed rung from a judgement call.
 */
export type EffortSource =
  /** Pinned by doc 03 section 7.2 (the protocol's own configuration table). */
  | "doc-03-7.2"
  /** Pinned by the bake-off task specification. */
  | "task-spec"
  /** Chosen by this harness where neither source pins it. See seat notes. */
  | "harness-choice";

interface ModelSeatBase {
  readonly role: SeatRole;
  /**
   * Vendor API model identifier. Where the identifier itself is unverified,
   * say so in `notes` — an unverified model ID is a run that silently resolves
   * to a different model.
   */
  readonly modelId: string;
  /**
   * The NAME of the environment variable holding the credential.
   * NEVER a value. Nothing in this codebase stores, returns or logs a value.
   */
  readonly envKeyName: string;
  /**
   * Non-secret endpoint override, or null for the vendor's first-party
   * endpoint. `null` rather than `undefined` because seats are snapshotted
   * into {@link RunRecord} and `undefined` disappears through JSON.stringify.
   */
  readonly baseUrl: string | null;
  readonly effortSource: EffortSource;
  /** Provenance, uncertainty flags, ladder non-equivalences. Never a secret. */
  readonly notes: string;
}

export interface AnthropicSeat extends ModelSeatBase {
  readonly provider: "anthropic";
  readonly effort: AnthropicEffort;
}
export interface MoonshotSeat extends ModelSeatBase {
  readonly provider: "moonshot";
  readonly effort: MoonshotEffort;
}
export interface DeepSeekSeat extends ModelSeatBase {
  readonly provider: "deepseek";
  readonly effort: DeepSeekEffort;
}
export interface OpenAISeat extends ModelSeatBase {
  readonly provider: "openai";
  readonly effort: OpenAIEffort;
}

/**
 * A model in a role, with its effort rung and the NAME of the env var that
 * authenticates it. Discriminated on `provider` so that an effort rung the
 * vendor does not have fails to compile.
 */
export type ModelSeat = AnthropicSeat | MoonshotSeat | DeepSeekSeat | OpenAISeat;

export interface EffortValidation {
  readonly valid: boolean;
  /** Human-readable problem, or null when valid. */
  readonly problem: string | null;
}

/** Runtime check that a seat's rung exists on its provider's ladder. */
export function validateSeatEffort(seat: ModelSeat): EffortValidation {
  const ladder = EFFORT_LADDERS[seat.provider];
  if (!ladder.includes(seat.effort)) {
    return {
      valid: false,
      problem:
        `effort "${seat.effort}" is not on the ${seat.provider} ladder ` +
        `(${ladder.join(" < ")})`,
    };
  }
  return { valid: true, problem: null };
}

/* -------------------------------------------------------------------------
 * 2. Tickets
 * ---------------------------------------------------------------------- */

/** doc 03 section 7.1: six frozen reference tickets, two per tier. */
export type TicketTier = "trivial" | "medium" | "hard";

/**
 * A frozen reference ticket.
 *
 * The brief is the verbatim text the builder receives. It is NEVER edited
 * between runs (doc 03 section 7.1). `sha256` is the digest of the brief's raw
 * UTF-8 bytes with no normalisation and no trimming — see `ticketDigest` in
 * hash.ts, which is the only place that digest may be computed.
 */
export interface Ticket {
  readonly id: string;
  readonly tier: TicketTier;
  /** Short label for reports. Never given to the builder. */
  readonly title: string;
  /** Verbatim ticket text. The only thing the builder is told. */
  readonly brief: string;
  /** sha256 hex of `brief` as raw UTF-8 bytes. Does not cover this field. */
  readonly sha256: string;
}

/* -------------------------------------------------------------------------
 * 3. The sealed, held-out acceptance suite
 * ---------------------------------------------------------------------- */

/**
 * Criterion gating tier (doc 02 section 5.4).
 *
 * - BLOCKING   — builds, boots, suite runs, no protected-path modification.
 *                All must pass.
 * - FUNCTIONAL — one criterion per user story in the ticket. 100% required.
 * - QUALITY    — a11y, responsive, error/empty states. REPORTED, NEVER GATING.
 *                A passing quality score must never raise a grade.
 */
export type CriterionTier = "BLOCKING" | "FUNCTIONAL" | "QUALITY";

/**
 * One acceptance criterion.
 *
 * `statement` is EARS notation ("When <trigger>, the <system> shall <response>"
 * / "While <state>, ..." / "If <condition>, then ..." / "The <system> shall
 * ..."). `evidenceRequired` names the artefact that can satisfy it — a
 * criterion that names no artefact is how a judge passes a stub
 * (doc 02 section 5.4).
 */
export interface AcceptanceCriterion {
  /** Stable REQ-ID, e.g. "REQ-014". Referenced by score records and reports. */
  readonly id: string;
  /** EARS-notation requirement. */
  readonly statement: string;
  /** Named artefact, e.g. "holdout test T-14 PASS AND db-query-7 count >= 1". */
  readonly evidenceRequired: string;
  readonly tier: CriterionTier;
}

/** One test file in the frozen suite, with its content digest. */
export interface TestFileRef {
  /** POSIX-relative path inside the suite root. Sorted by path in digests. */
  readonly path: string;
  /** sha256 hex of the file's raw bytes. */
  readonly sha256: string;
  readonly bytes: number;
}

/** What the adversarial bad-test audit looks for (doc 03 section 7.4). */
export type AuditFindingKind =
  | "vacuous"
  | "tautological"
  | "mis_specified"
  | "trivially_satisfiable"
  | "ambiguous"
  | "leaks_implementation"
  | "other";

export interface AuditFinding {
  /** REQ-ID the finding attaches to, or null for a suite-level finding. */
  readonly criterionId: string | null;
  readonly kind: AuditFindingKind;
  readonly detail: string;
  /**
   * True when the suite must be regenerated rather than used. TDFlow's entire
   * +26.3pp effect lives in bad-test detection (doc 03 section 5 rank 1); a
   * suite that fails the audit must never have builds run against it.
   */
  readonly mustRegenerate: boolean;
  /**
   * WHAT WOULD CLOSE THIS FINDING: editing an artefact that exists, or ADDING
   * one that does not.
   *
   * THE DISTINCTION IS NOT COSMETIC AND IT COST A RUN. Run `d143e52d`
   * (2026-08-12) was rejected with a blocking finding whose own text read *"a
   * build with zero persistence passes 23/23 criteria"* and *"closing this
   * requires new criteria and tests, i.e. re-authoring"*. The finding NAMED
   * REQ-004, REQ-003, REQ-006, T-6 and T-33 — every one of them real — so the
   * repair loop localised it cleanly and sent those artefacts back. But repair
   * may only return artefacts it was given: it is structurally incapable of
   * adding a criterion. The round could not fix the defect, the fresh re-audit
   * did not re-raise it, and a correct rejection became an acceptance. The
   * frozen suite gates nothing on persistence.
   *
   * NAMING AN ARTEFACT IS NOT THE SAME AS BEING FIXABLE IN ONE. A finding about
   * something MISSING names the artefacts that fail to cover it while requiring
   * artefacts that do not exist yet, which is why `repairTargets` cannot infer
   * this from the detail text and the judge is asked for it directly.
   *
   * OPTIONAL, AND ABSENT MEANS `add`. Every consumer must treat "not stated" as
   * the unrepairable case: a finding whose remedy nobody declared is one nobody
   * has shown to be an edit, and the failure above is what happens when the
   * benefit of that doubt goes the other way.
   */
  readonly remedy?: "edit" | "add";
}

/** Who authored the suite, and with what. Held constant across all configs. */
export interface HarnessIdentity {
  readonly id: string;
  readonly version: string;
  /** git commit of the harness, or "unversioned" if not under VCS. */
  readonly commit: string;
}

/**
 * The sealed, held-out acceptance suite. One per ticket.
 *
 * Authored ONCE per ticket by the `spec` seat from the ticket text alone,
 * BEFORE any build run, with no access to any implementation. Hashed and
 * frozen. No builder in any configuration may read it, list it or modify it.
 * It executes in a clean container with no network and no access to the build
 * workspace history (doc 03 section 7.4).
 */
export interface AcceptanceSuite {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly ticketId: string;
  /** Digest of the ticket brief this suite was authored from. */
  readonly ticketSha256: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly testFiles: readonly TestFileRef[];
  /**
   * The freeze digest. Covers ticketId, ticketSha256, the criteria (sorted by
   * id) and the per-file content digests (sorted by path). It deliberately does
   * NOT cover `sha256`, `generatedAt`, `auditPassed` or `auditFindings`, so
   * that re-running the audit cannot change the freeze. Computed only by
   * `acceptanceSuiteDigest` in hash.ts.
   */
  readonly sha256: string;
  /** The spec seat that authored it. Recorded to prove it was held constant. */
  readonly generatedBy: ModelSeat;
  readonly generatedByHarness: HarnessIdentity;
  /** Digest of the authoring prompt, for reproducibility. */
  readonly authoringPromptSha256: string;
  /** ISO-8601 instant. */
  readonly generatedAt: string;
  /** False until the adversarial bad-test audit has passed. */
  readonly auditPassed: boolean;
  readonly auditFindings: readonly AuditFinding[];
  /** The judge seat that ran the audit, or null if the audit has not run. */
  readonly auditedBy: ModelSeat | null;
  /** ISO-8601 instant, or null if the audit has not run. */
  readonly auditedAt: string | null;
}

/**
 * Guard: refuses a suite that has not passed the adversarial bad-test audit.
 * Call this before dispatching any build run against a suite.
 */
export function assertSuiteUsable(suite: AcceptanceSuite): void {
  const blocking = suite.auditFindings.filter((f) => f.mustRegenerate);
  if (!suite.auditPassed || blocking.length > 0) {
    throw new BakeoffError(
      "suite_not_audited",
      `acceptance suite for ticket ${suite.ticketId} (sha256 ${suite.sha256}) is not usable: ` +
        `auditPassed=${String(suite.auditPassed)}, ${blocking.length} finding(s) require regeneration`,
      "Regenerate the suite with the spec seat and re-run the adversarial bad-test audit. " +
        "Do not start builds against a suite that failed the audit (doc 03 section 7.4).",
    );
  }
}

/* -------------------------------------------------------------------------
 * 4. Configurations
 * ---------------------------------------------------------------------- */

/**
 * One configuration under test. `seats` always contains exactly one
 * orchestrator, one subagent, one spec seat and one judge seat; the spec and
 * judge seats are identical in every configuration by construction.
 */
export interface BakeoffConfig {
  /** Stable short id, e.g. "A". Appears in every run record and report. */
  readonly id: string;
  /** Short human label, e.g. "baseline". */
  readonly label: string;
  readonly seats: readonly ModelSeat[];
  /** Why this configuration is in the bake-off, with its evidence. */
  readonly notes: string;
}

/** Look up the single seat filling a role. Throws if absent or duplicated. */
export function seatFor(config: BakeoffConfig, role: SeatRole): ModelSeat {
  const matches = config.seats.filter((s) => s.role === role);
  const first = matches[0];
  if (matches.length !== 1 || first === undefined) {
    throw new BakeoffError(
      "unknown_config",
      `config ${config.id} has ${matches.length} seats for role "${role}"; expected exactly 1`,
      "Fix the configuration matrix in src/config.ts.",
    );
  }
  return first;
}

/* -------------------------------------------------------------------------
 * 5. Pricing
 *
 * VERIFY BEFORE TRUSTING. Every figure below was sourced on 2026-07-27 from
 * docs/research/03-model-decision-final.md, which itself states that no live
 * web access was available in that session and that its quotes came through a
 * summarising fetch tool rather than rendered HTML. doc 03's own instruction:
 * "Before any figure below is used to justify spend above ~$1,000, confirm
 * that specific number in a browser." A bake-off costs ~$2,100. CONFIRM THE
 * PRICES IN A BROWSER BEFORE THE FIRST RUN.
 * ---------------------------------------------------------------------- */

/** The five priced fields on a model. */
export type PriceField =
  | "input"
  | "cacheRead"
  | "cacheWrite5m"
  | "cacheWrite1h"
  | "output";

export const PRICE_FIELDS: readonly PriceField[] = [
  "input",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
  "output",
];

/**
 * Confidence in a single price field.
 *
 * - `verified`   — primary-sourced list price as of `sourcedOn`.
 * - `assumed`    — the vendor does not document it; this harness supplies a
 *                  stated assumption. Every dollar figure derived from an
 *                  assumed field carries that provenance into the run record.
 * - `unverified` — no price is known. The field is null and any usage that
 *                  needs it throws rather than costing at zero.
 */
export type PriceStatus = "verified" | "assumed" | "unverified";

/**
 * A price window for one model. USD per million tokens.
 *
 * Windows exist because Claude Sonnet 5's introductory rate expires:
 * $2.00/$0.20/$10.00 through 2026-08-31, $3.00/$0.30/$15.00 from 2026-09-01
 * (doc 03 table 2.1). A run on 2026-09-02 must not be costed at the intro rate.
 */
export interface ModelPrice {
  readonly provider: Provider;
  readonly modelId: string;
  readonly label: string;
  /** Inclusive UTC calendar date, "YYYY-MM-DD". */
  readonly effectiveFrom: string;
  /** Exclusive UTC calendar date, or null for open-ended. */
  readonly effectiveUntil: string | null;
  readonly inputUsdPerMTok: number | null;
  readonly cacheReadUsdPerMTok: number | null;
  readonly cacheWrite5mUsdPerMTok: number | null;
  readonly cacheWrite1hUsdPerMTok: number | null;
  readonly outputUsdPerMTok: number | null;
  readonly fieldStatus: Readonly<Record<PriceField, PriceStatus>>;
  /**
   * When a cache-write price is `assumed`, the multiplier applied to the
   * cache-miss input rate to obtain it, so the assumption is auditable and
   * replaceable by measurement. Null when no write price is assumed.
   */
  readonly assumedCacheWriteMultiplier: number | null;
  /** Date the figures were sourced. */
  readonly sourcedOn: "2026-07-27";
  /** Where they came from. */
  readonly source: string;
  readonly notes: string;
}

/**
 * PER-PROVIDER PRICE MAP — USD per million tokens.
 *
 * >>> VERIFY BEFORE TRUSTING. Sourced 2026-07-27 from doc 03 table 2.1, which
 * >>> is itself a secondary retrieval. Re-confirm each figure on the vendor's
 * >>> pricing page before spending against it.
 *
 * Only models that appear in the configuration matrix are listed. Adding a
 * model without a price entry makes it unrunnable by design: the hard cost
 * ceiling (constraint 3) is unenforceable without a per-MTok price.
 */
export const PRICE_TABLE: readonly ModelPrice[] = Object.freeze([
  {
    provider: "anthropic",
    modelId: "claude-opus-5",
    label: "Claude Opus 5",
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    inputUsdPerMTok: 5.0,
    cacheReadUsdPerMTok: 0.5,
    cacheWrite5mUsdPerMTok: 6.25,
    cacheWrite1hUsdPerMTok: 10.0,
    outputUsdPerMTok: 25.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "doc 03 table 2.1 (Anthropic pricing page, verified live 2026-07-27)",
    notes:
      "Cache read 0.1x, 5m write 1.25x, 1h write 2.0x. Cache reads do not count toward ITPM. " +
      "Used by the orchestrator seat (configs A, B, D, E) and by the spec and judge seats in every config.",
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5 (introductory rate)",
    effectiveFrom: "2026-01-01",
    effectiveUntil: "2026-09-01",
    inputUsdPerMTok: 2.0,
    cacheReadUsdPerMTok: 0.2,
    cacheWrite5mUsdPerMTok: 2.5,
    cacheWrite1hUsdPerMTok: 4.0,
    outputUsdPerMTok: 10.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "doc 03 table 2.1",
    notes:
      "Introductory rate through 2026-08-31 inclusive. Write rates derived from the documented " +
      "1.25x / 2.0x multipliers on the $2.00 base input rate.",
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5 (from 2026-09-01)",
    effectiveFrom: "2026-09-01",
    effectiveUntil: null,
    inputUsdPerMTok: 3.0,
    cacheReadUsdPerMTok: 0.3,
    cacheWrite5mUsdPerMTok: 3.75,
    cacheWrite1hUsdPerMTok: 6.0,
    outputUsdPerMTok: 15.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "doc 03 table 2.1",
    notes:
      "Scheduled price rise. A bake-off that straddles 2026-09-01 costs each run at the rate in " +
      "force on that run's start date; the window used is recorded in RunRecord.pricingBasis.",
  },
  {
    provider: "moonshot",
    modelId: "kimi-k3",
    label: "Kimi K3",
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    inputUsdPerMTok: 3.0,
    cacheReadUsdPerMTok: 0.3,
    // ASSUMED. See notes and assumedCacheWriteMultiplier.
    cacheWrite5mUsdPerMTok: 3.0,
    cacheWrite1hUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "assumed",
      cacheWrite1h: "assumed",
      output: "verified",
    },
    assumedCacheWriteMultiplier: 1.0,
    sourcedOn: "2026-07-27",
    source: "doc 03 table 2.1 (Moonshot first-party pricing)",
    notes:
      "ASSUMPTION: Moonshot documents NEITHER a cache TTL NOR a cache-write charge (doc 03 table 2.1, " +
      "flagged [uncertain]). This harness assumes a write bills at the standard cache-miss input rate " +
      "(multiplier 1.0, no premium). doc 03 section 4.2 modelled it at zero, which is not defensible. " +
      "Sensitivity: at an Anthropic-style 1.25x premium the write rate is $3.75/MTok. Measuring " +
      "Moonshot's real cache behaviour is one of the two stated reasons Kimi configs are in the " +
      "bake-off at all (doc 03 section 7.2). Replace this assumption with the measured value and " +
      "re-cost from the raw token counts, which are recorded unchanged.",
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    inputUsdPerMTok: 0.435,
    cacheReadUsdPerMTok: 0.003625,
    cacheWrite5mUsdPerMTok: 0.435,
    cacheWrite1hUsdPerMTok: 0.435,
    outputUsdPerMTok: 0.87,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "doc 03 table 2.1 and section 3.1 (DeepSeek first-party pricing)",
    notes:
      "DeepSeek's cache is automatic with NO write premium and no separate write line item: a miss is " +
      "billed as ordinary input. Adapters MUST therefore report cacheWriteTokens = 0 and count misses " +
      "as inputTokens. The write rates above equal the input rate so that a mis-reporting adapter " +
      "cannot understate the bill. Cache TTL is documented as 'a few hours to a few days' on a " +
      "'best-effort basis' with no guarantee. Do NOT host via a Western reseller: DeepInfra is 3.0x on " +
      "tokens and 27.6x on cache hits, which erases the entire economic case (doc 03 section 3.1).",
  },
  // ---- OpenAI (owner decision D3, 2026-07-27) -----------------------------
  //
  // These three entries replace the deliberately unpriced `gpt-5.6-luna` row
  // that blocked config E at preflight. THE CACHE-WRITE LINE HAS A DIFFERENT
  // PROVENANCE FROM THE OTHER THREE FIELDS AND THE DIFFERENCE IS RECORDED IN
  // EACH ENTRY'S `notes`: input / cacheRead / output are double-confirmed
  // against the vendor's own price table, while the cache-WRITE rate rests on
  // the owner's live check of the pricing page. Nothing here is inferred from
  // doc 05's Cost/Test figure, which doc 05 caveat 1 forbids substituting into
  // a per-ticket model.
  //
  // OpenAI publishes NO 5-minute/1-hour cache TTL split — that is an Anthropic
  // construct — so both write windows carry the same rate. This follows the
  // DeepSeek precedent above: equal write rates mean an adapter that
  // mis-attributes a write to the wrong window cannot understate the bill.
  {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    inputUsdPerMTok: 1.0,
    cacheReadUsdPerMTok: 0.1,
    cacheWrite5mUsdPerMTok: 1.25,
    cacheWrite1hUsdPerMTok: 1.25,
    outputUsdPerMTok: 6.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "OpenAI pricing page https://developers.openai.com/api/docs/pricing, verified 2026-07-27",
    notes:
      "Config E's subagent. PROVENANCE, SPLIT BY FIELD: input $1.00, cacheRead $0.10 and output " +
      "$6.00 are recorded in docs/research/01-verification-corrections.md (the OpenAI API price " +
      "table, re-verified against developers.openai.com the same day, which lists input/cached/" +
      "output only). The cache-WRITE rate of 1.25x the uncached input rate comes from the same " +
      "pricing page but is NOT carried in that summary line; it rests on the live check recorded " +
      "in owner decision D3 of 2026-07-27. OpenAI documents no cache TTL split, so the 5m and 1h " +
      "windows carry the same rate. Config E remains blocked on the SECOND, independent reason in " +
      "STATUS.md 1.3: OpenAI does not speak the Anthropic Messages API, which is the only wire " +
      "protocol the budget proxy implements. This entry clears the price blocker only.",
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    inputUsdPerMTok: 5.0,
    cacheReadUsdPerMTok: 0.5,
    cacheWrite5mUsdPerMTok: 6.25,
    cacheWrite1hUsdPerMTok: 6.25,
    outputUsdPerMTok: 30.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "OpenAI pricing page https://developers.openai.com/api/docs/pricing, verified 2026-07-27",
    notes:
      "PRICED BUT NOT IN THE MATRIX, and the exclusion is on BEHAVIOUR, not price: METR measured " +
      "Sol's detected cheating rate as higher than any public model it has evaluated ON ITS ReAct " +
      "AGENT HARNESS (doc 03 table 2.1; the harness and detection scoping is doc 01's correction " +
      "and must be quoted with it). Priced here so that a future configuration cannot be added " +
      "unpriced, i.e. uncapped. Same field-level provenance split as the Luna entry: input " +
      "$5.00 / cacheRead $0.50 / output $30.00 are in the packet's price table; the 1.25x " +
      "cache-write rate rests on the owner's live check of 2026-07-27.",
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    inputUsdPerMTok: 2.5,
    cacheReadUsdPerMTok: 0.25,
    cacheWrite5mUsdPerMTok: 3.125,
    cacheWrite1hUsdPerMTok: 3.125,
    outputUsdPerMTok: 15.0,
    fieldStatus: {
      input: "verified",
      cacheRead: "verified",
      cacheWrite5m: "verified",
      cacheWrite1h: "verified",
      output: "verified",
    },
    assumedCacheWriteMultiplier: null,
    sourcedOn: "2026-07-27",
    source: "OpenAI pricing page https://developers.openai.com/api/docs/pricing, verified 2026-07-27",
    notes:
      "PRICED BUT NOT IN THE MATRIX. Recorded so that the mid-tier GPT-5.6 rung is capped in " +
      "advance rather than added unpriced later. Same field-level provenance split as the Luna " +
      "entry: input $2.50 / cacheRead $0.25 / output $15.00 are in the packet's price table; the " +
      "1.25x cache-write rate rests on the owner's live check of 2026-07-27.",
  },
]);

/** A price resolved for a specific instant, with its provenance. */
export interface ResolvedPrice {
  readonly price: ModelPrice;
  /** Fields whose value rests on a stated assumption rather than a source. */
  readonly assumedFields: readonly PriceField[];
  /** Fields with no known value. Usage touching one of these cannot be costed. */
  readonly unverifiedFields: readonly PriceField[];
}

const ISO_DATE_LENGTH = 10;

function utcDatePart(isoInstant: string): string {
  const datePart = isoInstant.slice(0, ISO_DATE_LENGTH);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    throw new BakeoffError(
      "ambiguous_price_window",
      `cannot read a UTC calendar date from "${isoInstant}"`,
      "Pass an ISO-8601 instant, e.g. 2026-07-27T10:00:00.000Z.",
    );
  }
  return datePart;
}

/**
 * Resolve the price window in force for a model at an instant.
 *
 * Window comparison is on the UTC calendar date, lexicographically on
 * "YYYY-MM-DD". Throws — never guesses — when no window covers the instant or
 * when two windows overlap.
 */
export function resolvePrice(
  provider: Provider,
  modelId: string,
  atIsoInstant: string,
  table: readonly ModelPrice[] = PRICE_TABLE,
): ResolvedPrice {
  const day = utcDatePart(atIsoInstant);
  const matches = table.filter(
    (p) =>
      p.provider === provider &&
      p.modelId === modelId &&
      p.effectiveFrom <= day &&
      (p.effectiveUntil === null || day < p.effectiveUntil),
  );

  const price = matches[0];
  if (price === undefined) {
    throw new BakeoffError(
      "unknown_model_price",
      `no price window covers ${provider}/${modelId} on ${day}`,
      `Add a ModelPrice entry for ${provider}/${modelId} covering ${day} to PRICE_TABLE in src/contracts.ts. ` +
        "Do not run a configuration whose model has no price: the hard cost ceiling cannot be enforced without one.",
    );
  }
  if (matches.length > 1) {
    throw new BakeoffError(
      "ambiguous_price_window",
      `${matches.length} overlapping price windows cover ${provider}/${modelId} on ${day}`,
      "Make the effectiveFrom/effectiveUntil windows in PRICE_TABLE non-overlapping.",
    );
  }

  const assumedFields: PriceField[] = [];
  const unverifiedFields: PriceField[] = [];
  for (const field of PRICE_FIELDS) {
    const status = price.fieldStatus[field];
    if (status === "assumed") assumedFields.push(field);
    if (status === "unverified") unverifiedFields.push(field);
  }
  return { price, assumedFields, unverifiedFields };
}

/**
 * The pricing provenance of one usage row, snapshotted into the run record so
 * that every dollar figure can be audited without this source tree.
 */
export interface PricingBasis {
  readonly provider: Provider;
  readonly modelId: string;
  readonly priceLabel: string;
  readonly priceEffectiveFrom: string;
  readonly priceEffectiveUntil: string | null;
  /** The instant used to resolve the window (normally the run's startedAt). */
  readonly pricedAt: string;
  readonly fieldStatus: Readonly<Record<PriceField, PriceStatus>>;
  readonly assumedFields: readonly PriceField[];
  readonly assumedCacheWriteMultiplier: number | null;
  readonly sourcedOn: string;
  readonly source: string;
}

export function pricingBasisOf(resolved: ResolvedPrice, pricedAt: string): PricingBasis {
  return {
    provider: resolved.price.provider,
    modelId: resolved.price.modelId,
    priceLabel: resolved.price.label,
    priceEffectiveFrom: resolved.price.effectiveFrom,
    priceEffectiveUntil: resolved.price.effectiveUntil,
    pricedAt,
    fieldStatus: resolved.price.fieldStatus,
    assumedFields: resolved.assumedFields,
    assumedCacheWriteMultiplier: resolved.price.assumedCacheWriteMultiplier,
    sourcedOn: resolved.price.sourcedOn,
    source: resolved.price.source,
  };
}

/* -------------------------------------------------------------------------
 * 6. Per-vendor token accounting
 * ---------------------------------------------------------------------- */

/**
 * Token counts and cost for ONE (provider, model, role) within one run.
 *
 * >>> NEVER SUM TOKEN COUNTS ACROSS PROVIDERS. Tokenizers differ; a Claude
 * >>> token is not a Moonshot token. Anthropic's own docs state its 4.7+
 * >>> tokenizer produces approximately 30% more tokens for the same text than
 * >>> earlier Claude models — and nobody has measured tokens-per-identical-
 * >>> source-text across vendors (doc 03 section 4.1 footnote). COMPARE DOLLARS
 * >>> AND OUTCOMES ONLY. This module deliberately ships {@link sumCostUsd} and
 * >>> no token-summing helper of any kind.
 *
 * Field names `provider`, `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
 * `outputTokens` and `costUsd` are part of the frozen interface. The remaining
 * fields are additive detail required by doc 04 section 9.1.
 */
export interface VendorUsage {
  readonly provider: Provider;
  /**
   * Tokens billed at the cache-MISS input rate. On Anthropic this is the
   * API's `input_tokens`, which counts only tokens AFTER the last cache
   * breakpoint — never treat it as the total (doc 04 section 3.4).
   */
  readonly inputTokens: number;
  /** Anthropic `cache_read_input_tokens`. Billed at 0.1x on Claude models. */
  readonly cacheReadTokens: number;
  /**
   * Anthropic `cache_creation_input_tokens`. MUST be 0 for DeepSeek, which
   * bills no separate write line item.
   */
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /**
   * Cost in USD for this row, computed by {@link priceVendorUsage}. This is
   * the ONLY quantity that may be compared or summed across vendors.
   */
  readonly costUsd: number;

  // ---- additive detail -------------------------------------------------
  readonly modelId: string;
  readonly role: SeatRole;
  readonly effort: Effort;
  /** Number of API calls aggregated into this row. */
  readonly callCount: number;
  /** Anthropic `cache_creation.ephemeral_5m_input_tokens`, else null. */
  readonly cacheWrite5mTokens: number | null;
  /** Anthropic `cache_creation.ephemeral_1h_input_tokens`, else null. */
  readonly cacheWrite1hTokens: number | null;
  /**
   * `usage.output_tokens_details.thinking_tokens` where the vendor reports it,
   * else null. NEVER 0 as a substitute for "not reported" (doc 04 section 4.2).
   */
  readonly thinkingTokens: number | null;
}

/**
 * Measured cache-hit token fraction for ONE vendor.
 *
 * `cache_read / (cache_read + cache_write + input)` per doc 04 section 3.4.
 * Returns null when no input tokens were billed at all. A secondary metric of
 * the bake-off, reported PER VENDOR and never averaged across vendors.
 *
 * A reading of exactly 0 with cacheWriteTokens also 0 means the prompt was not
 * cached at all — almost always a prefix below the model's minimum cacheable
 * length, which is a 10x silent price increase (doc 04 section 3.4). Alert on it.
 */
export function vendorCacheHitFraction(usage: VendorUsage): number | null {
  const total = usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens;
  if (total <= 0) return null;
  return usage.cacheReadTokens / total;
}

/** Options for costing a usage row. */
export interface PriceUsageOptions {
  /**
   * When the vendor does not report a 5m/1h cache-write split and its 5m and
   * 1h rates differ, pass the TTL the harness configured. Omit it and the call
   * throws rather than guessing the cheaper rate.
   */
  readonly assumeWriteTtl?: "5m" | "1h";
}

/** Token counts needed to compute a cost. */
export interface UsageCounts {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite5mTokens: number | null;
  readonly cacheWrite1hTokens: number | null;
}

const TOKENS_PER_MTOK = 1_000_000;

function requirePrice(
  value: number | null,
  field: PriceField,
  price: ModelPrice,
  tokens: number,
): number {
  if (value === null) {
    throw new BakeoffError(
      "unpriced_usage",
      `${price.provider}/${price.modelId} billed ${tokens} ${field} tokens but no ${field} price is known ` +
        `(status: ${price.fieldStatus[field]})`,
      `Retrieve the ${field} list price for ${price.provider}/${price.modelId} from the vendor's pricing ` +
        "page and add it to PRICE_TABLE in src/contracts.ts. Costing at zero is never an acceptable fallback.",
    );
  }
  return value;
}

/**
 * Cost one usage row in USD. Throws rather than costing an unpriced field at
 * zero, and throws rather than silently assuming a cache-write TTL.
 */
export function priceVendorUsage(
  counts: UsageCounts,
  resolved: ResolvedPrice,
  options: PriceUsageOptions = {},
): number {
  const p = resolved.price;
  let usd = 0;

  if (counts.inputTokens > 0) {
    usd += (counts.inputTokens / TOKENS_PER_MTOK) * requirePrice(p.inputUsdPerMTok, "input", p, counts.inputTokens);
  }
  if (counts.cacheReadTokens > 0) {
    usd +=
      (counts.cacheReadTokens / TOKENS_PER_MTOK) *
      requirePrice(p.cacheReadUsdPerMTok, "cacheRead", p, counts.cacheReadTokens);
  }
  if (counts.outputTokens > 0) {
    usd +=
      (counts.outputTokens / TOKENS_PER_MTOK) * requirePrice(p.outputUsdPerMTok, "output", p, counts.outputTokens);
  }

  if (counts.cacheWriteTokens > 0) {
    const split5m = counts.cacheWrite5mTokens;
    const split1h = counts.cacheWrite1hTokens;
    const hasSplit = split5m !== null && split1h !== null;

    if (hasSplit) {
      if (split5m + split1h !== counts.cacheWriteTokens) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `cache-write split ${split5m}+${split1h} does not equal cacheWriteTokens ${counts.cacheWriteTokens} ` +
            `for ${p.provider}/${p.modelId}`,
          "Fix the provider adapter's usage normalisation. Do not reconcile the difference by rounding.",
        );
      }
      if (split5m > 0) {
        usd += (split5m / TOKENS_PER_MTOK) * requirePrice(p.cacheWrite5mUsdPerMTok, "cacheWrite5m", p, split5m);
      }
      if (split1h > 0) {
        usd += (split1h / TOKENS_PER_MTOK) * requirePrice(p.cacheWrite1hUsdPerMTok, "cacheWrite1h", p, split1h);
      }
    } else {
      const ratesEqual =
        p.cacheWrite5mUsdPerMTok !== null && p.cacheWrite5mUsdPerMTok === p.cacheWrite1hUsdPerMTok;
      const ttl = options.assumeWriteTtl;
      if (!ratesEqual && ttl === undefined) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `${p.provider}/${p.modelId} reported ${counts.cacheWriteTokens} cache-write tokens with no 5m/1h split, ` +
            "and its 5m and 1h write rates differ",
          "Have the provider adapter report cache_creation.ephemeral_5m_input_tokens and " +
            "ephemeral_1h_input_tokens, or pass assumeWriteTtl explicitly so the assumption is recorded. " +
            "Defaulting to the cheaper rate would understate the bill and weaken the cost ceiling.",
        );
      }
      const field: PriceField = ttl === "1h" ? "cacheWrite1h" : "cacheWrite5m";
      const rate = field === "cacheWrite1h" ? p.cacheWrite1hUsdPerMTok : p.cacheWrite5mUsdPerMTok;
      usd +=
        (counts.cacheWriteTokens / TOKENS_PER_MTOK) *
        requirePrice(rate, field, p, counts.cacheWriteTokens);
    }
  }

  return usd;
}

/**
 * Reject duplicate usage rows. One row per (provider, modelId, role); a
 * duplicate means an adapter appended instead of merging, which double-counts
 * the bill and corrupts the per-vendor cache-hit fraction.
 */
export function assertNoDuplicateUsageRows(usages: readonly VendorUsage[]): void {
  const seen = new Set<string>();
  for (const u of usages) {
    const key = `${u.provider}|${u.modelId}|${u.role}`;
    if (seen.has(key)) {
      throw new BakeoffError(
        "duplicate_usage_row",
        `duplicate VendorUsage row for ${key}`,
        "Merge usage rows per (provider, modelId, role) before writing the run record.",
      );
    }
    seen.add(key);
  }
}

/**
 * Total cost of a run in USD.
 *
 * This is the ONLY cross-vendor aggregation in the harness, and it aggregates
 * dollars. There is deliberately no equivalent for tokens — see the warning on
 * {@link VendorUsage}.
 */
export function sumCostUsd(usages: readonly VendorUsage[]): number {
  assertNoDuplicateUsageRows(usages);
  return usages.reduce((acc, u) => acc + u.costUsd, 0);
}

/* -------------------------------------------------------------------------
 * 7. Held-constant variables (doc 03 section 7.3)
 * ---------------------------------------------------------------------- */

/**
 * Sandbox network policy.
 *
 * doc 03 section 7.3 item 3: identical and sealed — no egress to upstream
 * repos, no package registry except a pinned mirror, no issue trackers. Cursor
 * measured 14.1-20.7pp of apparent quality evaporating when exactly this was
 * sealed.
 */
export interface NetworkPolicy {
  readonly egress: "denied" | "pinned-mirror-only";
  /** Exact hosts permitted. Empty when egress is "denied". */
  readonly allowedHosts: readonly string[];
}

export interface SandboxSpec {
  readonly imageRef: string;
  /** Immutable content digest, e.g. "sha256:...". Identical for every config. */
  readonly imageDigest: string;
  readonly networkPolicy: NetworkPolicy;
}

/** One seat's recorded effort, for the run record's held-constants block. */
export interface RecordedEffort {
  readonly role: SeatRole;
  readonly provider: Provider;
  readonly modelId: string;
  readonly effort: Effort;
  readonly effortSource: EffortSource;
}

/**
 * THE SIX HELD-CONSTANT VARIABLES, snapshotted into every run record.
 *
 * Five come from the measurement-integrity finding that Artificial Analysis
 * and Vals AI both run Terminal-Bench 2.1 on a Terminus 2 harness and differ by
 * ~4pp — larger than the model gap being detected (doc 03 section 7.3).
 */
export interface HeldConstants {
  /** 1. Reasoning effort — fixed per (model, role) and RECORDED. */
  readonly efforts: readonly RecordedEffort[];
  /** 2. Harness — one harness, ours, for every configuration. */
  readonly harness: HarnessIdentity;
  /** 3. Sandbox image and network isolation policy — identical and sealed. */
  readonly sandbox: SandboxSpec;
  /** 4. Repeat count — same for every configuration in a phase. */
  readonly repeatCount: number;
  /** 5. The held-out acceptance suite — the freeze digest actually executed. */
  readonly acceptanceSuiteSha256: string;
  /**
   * 6. Token accounting rule. A literal type, so the rule cannot be varied by
   * a future edit without a compile error.
   */
  readonly tokenAccountingRule: "per-vendor-never-summed-only-dollars-compared";
}

export const TOKEN_ACCOUNTING_RULE = "per-vendor-never-summed-only-dollars-compared" as const;

/* -------------------------------------------------------------------------
 * 8. Budget, kill switch, ledger
 * ---------------------------------------------------------------------- */

/**
 * Why a run was terminated.
 *
 * >>> THERE IS DELIBERATELY NO "stuck", "looping", "no progress" OR
 * >>> "plateau" REASON, AND NONE MAY BE ADDED.
 * >>> Long-Horizon Terminal-Bench measured 79% of unresolved runs timing out
 * >>> WHILE STILL ACTIVELY MAKING PROGRESS (doc 03 section 8.1). A heuristic
 * >>> stuck-detector kills runs that were converging, which silently inflates
 * >>> the timeout rate and deflates the held-out pass rate of whichever
 * >>> configuration happens to work slowly. Terminate on a budget boundary,
 * >>> never on a guess (doc 03 section 7.8).
 */
export type KillReason =
  /** Cumulative run spend reached the hard USD ceiling. */
  | "cost_ceiling_usd"
  /** Campaign-wide spend reached the hard USD ceiling. */
  | "campaign_cost_ceiling_usd"
  /** Wall-clock ceiling reached. A boundary, not a progress judgement. */
  | "wall_clock_ceiling"
  /** Per-vendor output-token ceiling reached. Never a cross-vendor total. */
  | "vendor_output_token_ceiling"
  /** A human stopped it. */
  | "operator_abort"
  /** Sandbox, network or harness failure. Not a model outcome. */
  | "infrastructure_failure"
  /** A credential was missing, invalid or expired mid-run. */
  | "credential_failure";

/**
 * A vendor-side task-budget parameter.
 *
 * RECORDED, NEVER LOAD-BEARING. Anthropic's own docs on the `task_budget` beta:
 * "Claude may occasionally exceed the budget if it is in the middle of an
 * action." Sonnet 5 has no task_budget at all, Moonshot and DeepSeek have no
 * budget primitive of any kind (doc 03 table 2.1). The only real control is the
 * out-of-process ceiling below.
 *
 * Setting one has a cost side-effect worth knowing: decrementing a remaining-
 * budget counter inside the prompt on every follow-up request changes the
 * cached prefix and silently destroys the prompt cache (doc 04 section 3.3
 * item 2).
 */
export interface VendorAdvisoryBudget {
  readonly provider: Provider;
  readonly parameterName: string;
  readonly value: string;
  readonly enforced: false;
}

/** The out-of-process ceilings. All are hard boundaries. */
export interface BudgetPolicy {
  /** Hard per-run USD ceiling. Checked BEFORE each API call. */
  readonly maxCostUsd: number;
  /** Hard per-run wall-clock ceiling in milliseconds. */
  readonly maxWallClockMs: number;
  /** Hard campaign-wide USD ceiling across every run. */
  readonly maxCampaignCostUsd: number;
  /** Emit a ledger warning at this fraction of the run ceiling, e.g. 0.8. */
  readonly warnAtFraction: number;
  /**
   * Optional per-vendor output-token ceilings, keyed by provider. Per-vendor
   * because token counts are never comparable across vendors. Null disables.
   */
  readonly perVendorMaxOutputTokens: Readonly<Partial<Record<Provider, number>>> | null;
  /** Recorded for the experiment log. Never used as a control. */
  readonly vendorAdvisoryBudgets: readonly VendorAdvisoryBudget[];
}

/**
 * The result of the pre-call budget check.
 *
 * MUST be evaluated in the supervising process, BEFORE the request is
 * dispatched, using the WORST-CASE cost of the call about to be made
 * (planned max output tokens at the output rate, plus estimated input at the
 * cache-MISS rate). Checking after the fact means the ceiling can be exceeded
 * by one arbitrarily expensive call.
 */
export interface PreCallDecision {
  readonly allowed: boolean;
  /** Non-null exactly when `allowed` is false. */
  readonly killReason: KillReason | null;
  readonly cumulativeCostUsd: number;
  readonly ceilingUsd: number;
  readonly worstCaseNextCallUsd: number;
  readonly checkedAt: string;
}

/** Base fields on every ledger event. */
interface LedgerEventBase {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  /** Monotonic, gap-free within a run. A gap means the ledger was truncated. */
  readonly seq: number;
  /** ISO-8601 instant. */
  readonly at: string;
}

/**
 * The append-only, out-of-process spend ledger.
 *
 * Written by the supervising process, not by the agent. Every string field in
 * every event must pass through `redactForPersistence` (redact.ts) before it
 * is written.
 */
export type LedgerEvent =
  | (LedgerEventBase & {
      readonly kind: "run_started";
      readonly configId: string;
      readonly ticketId: string;
      readonly repeatIndex: number;
      readonly budget: BudgetPolicy;
      readonly heldConstants: HeldConstants;
    })
  | (LedgerEventBase & {
      readonly kind: "precall_check";
      readonly provider: Provider;
      readonly modelId: string;
      readonly decision: PreCallDecision;
    })
  | (LedgerEventBase & {
      readonly kind: "usage_recorded";
      readonly usage: VendorUsage;
      readonly cumulativeCostUsd: number;
    })
  | (LedgerEventBase & {
      readonly kind: "budget_warning";
      readonly cumulativeCostUsd: number;
      readonly ceilingUsd: number;
      readonly fractionUsed: number;
    })
  | (LedgerEventBase & {
      readonly kind: "kill_issued";
      readonly reason: KillReason;
      readonly cumulativeCostUsd: number;
      readonly detail: string;
    })
  | (LedgerEventBase & {
      /** The agent said it was finished. RECORDED. It scores nothing. */
      readonly kind: "agent_declared_done";
      readonly selfReportPath: string | null;
    })
  | (LedgerEventBase & {
      /** BLOCKED is a first-class outcome, not a failure (doc 03 section 8.3). */
      readonly kind: "agent_reported_blocked";
      readonly reason: string;
    })
  | (LedgerEventBase & {
      readonly kind: "run_ended";
      readonly status: RunStatus;
      readonly totalCostUsd: number;
      readonly killReason: KillReason | null;
    });

/* -------------------------------------------------------------------------
 * 9. Run records
 * ---------------------------------------------------------------------- */

/**
 * Terminal status of a build run. NOTE that this is the HARNESS's view of the
 * run; it says nothing about whether the work is correct. Only
 * {@link ScoreRecord} does that.
 *
 * - `completed`       — the agent finished within its budget.
 * - `blocked`         — the agent reported BLOCKED. A first-class outcome:
 *                       shipping partial progress with an honest status beats
 *                       shipping a confident false finish (doc 03 section 8.3).
 * - `timeout`         — wall-clock boundary reached.
 * - `budget_exceeded` — dollar or token boundary reached.
 * - `error`           — harness or infrastructure failure. Not a model result;
 *                       exclude from rate denominators and report separately.
 */
export type RunStatus = "completed" | "blocked" | "timeout" | "budget_exceeded" | "error";

/** One build attempt: one ticket, one configuration, one repeat. */
export interface RunRecord {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly runId: string;
  readonly ticketId: string;
  /** Digest of the exact brief text used. Proves the ticket was not edited. */
  readonly ticketSha256: string;
  readonly configId: string;
  /** 0-based index within the repeat count for this phase. */
  readonly repeatIndex: number;
  /** ISO-8601 instant. Also the instant used to resolve prices. */
  readonly startedAt: string;
  /** ISO-8601 instant. */
  readonly endedAt: string;
  readonly wallClockMs: number;
  readonly status: RunStatus;
  /** Non-null exactly when the run was terminated on a boundary. */
  readonly killReason: KillReason | null;
  /**
   * The agent's self-report: did it declare the work done?
   *
   * >>> RECORDED, NEVER SCORING. This field exists solely so that
   * >>> `falseFinish` can be computed (agent declared done AND the held-out
   * >>> suite failed). It must never influence heldOutPass, and no report may
   * >>> present it as a quality measure.
   */
  readonly agentDeclaredDone: boolean;
  /** Path to the verbatim self-report, recorded for inspection. */
  readonly selfReportPath: string | null;
  /** One row per (provider, modelId, role). Token counts never cross-summed. */
  readonly usage: readonly VendorUsage[];
  /** Sum of `usage[].costUsd`. The only cross-vendor aggregate. */
  readonly totalCostUsd: number;
  /** Pricing provenance for every usage row. */
  readonly pricingBasis: readonly PricingBasis[];
  /** Snapshot of the seats actually used, including effort rungs. */
  readonly seats: readonly ModelSeat[];
  readonly heldConstants: HeldConstants;
  readonly budget: BudgetPolicy;
  /** Directory holding the produced workspace artefact. */
  readonly artifactPath: string;
  /** Path to the (redacted) run log. */
  readonly logPath: string;
  /** Path to the append-only spend ledger for this run. */
  readonly ledgerPath: string;
  /** Harness-level errors, redacted. Empty for a clean run. */
  readonly harnessErrors: readonly string[];
}

/* -------------------------------------------------------------------------
 * 10. Scoring — the sealed gate
 * ---------------------------------------------------------------------- */

export interface CriterionResult {
  readonly criterionId: string;
  readonly tier: CriterionTier;
  readonly passed: boolean;
  /** Identifier of the artefact that decided it, e.g. "T-14" or "db-query-7". */
  readonly evidenceRef: string | null;
  /** Redacted failure detail, or null when passed. */
  readonly detail: string | null;
}

/**
 * The outcome of executing the frozen suite in the clean container.
 *
 * Produced by the scorer, which runs in a container with NO network and NO
 * access to the build agent's workspace history, from an image whose digest is
 * recorded. Nothing the builder said is an input.
 */
export interface ScoreRecord {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly runId: string;
  readonly ticketId: string;
  /** The freeze digest of the suite actually executed. */
  readonly acceptanceSuiteSha256: string;
  /**
   * CO-PRIMARY METRIC 1. True when the frozen suite goes green in the clean
   * container: all BLOCKING criteria pass, FUNCTIONAL is 100%, and no
   * protected path was modified. QUALITY never gates.
   * Compute only via {@link computeHeldOutPass}.
   */
  readonly heldOutPass: boolean;
  readonly criteriaResults: readonly CriterionResult[];
  /**
   * CO-PRIMARY METRIC 2, and the metric that matters:
   * `agentDeclaredDone && !heldOutPass`. Compute only via
   * {@link deriveFalseFinish}.
   */
  readonly falseFinish: boolean;
  /** Copied from the run record so this record stands alone. */
  readonly agentDeclaredDone: boolean;
  /** ISO-8601 instant. */
  readonly scoredAt: string;
  /** Immutable digest of the scorer container image. Identical for all configs. */
  readonly scorerImageDigest: string;
  readonly suiteExecution: SuiteExecution;
  /**
   * Paths the builder modified that it was forbidden to touch. Any entry is an
   * instant fail: tests are read-only via filesystem permissions AND a diff
   * gate, because a prompt instruction is not sufficient (doc 02 section 5.6).
   */
  readonly protectedPathViolations: readonly string[];
}

export interface SuiteExecution {
  readonly exitCode: number;
  readonly durationMs: number;
  /** Null when the runner produced no machine-readable report. Never 0. */
  readonly testsTotal: number | null;
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
  /** Redacted stdout/stderr tail path, for triage. Never a scoring input. */
  readonly logPath: string | null;
}

/**
 * THE definition of held-out pass. Do not reimplement it anywhere else.
 *
 * SHIP = all BLOCKING pass AND FUNCTIONAL = 100% (doc 02 section 5.4). QUALITY
 * criteria are reported and never gate; a passing quality result may not raise
 * the grade. Any protected-path violation is an instant fail regardless of
 * test results.
 */
export function computeHeldOutPass(
  criteriaResults: readonly CriterionResult[],
  protectedPathViolations: readonly string[],
): boolean {
  if (protectedPathViolations.length > 0) return false;
  const gating = criteriaResults.filter((c) => c.tier === "BLOCKING" || c.tier === "FUNCTIONAL");
  if (gating.length === 0) return false; // an empty gate is never a pass
  return gating.every((c) => c.passed);
}

/**
 * THE definition of false finish. Do not reimplement it anywhere else.
 *
 * The agent DECLARED DONE and the held-out suite FAILED. LHTB measures this
 * mode at 19% of unresolved runs; in the product it is the failure that ships
 * a broken app to a paying customer (doc 03 section 7.5).
 */
export function deriveFalseFinish(agentDeclaredDone: boolean, heldOutPass: boolean): boolean {
  return agentDeclaredDone && !heldOutPass;
}

/* -------------------------------------------------------------------------
 * 11. Aggregate metrics (doc 03 section 7.5)
 * ---------------------------------------------------------------------- */

/**
 * Aggregate outcome for one configuration.
 *
 * Co-primary metrics are `heldOutPassRate` and `falseFinishRate`; BOTH are
 * required and NEITHER alone decides anything. `dollarsPerHeldOutPass` is
 * DERIVED and is explicitly not primary.
 */
export interface ConfigOutcome {
  readonly configId: string;
  /** Runs counted in the denominators (status "error" excluded). */
  readonly attempts: number;
  /** Runs excluded as harness/infrastructure failures. Reported separately. */
  readonly harnessErrors: number;
  // co-primary
  readonly heldOutPassRate: number;
  readonly falseFinishRate: number;
  // secondary
  readonly timeoutRate: number;
  readonly blockedRate: number;
  readonly budgetExceededRate: number;
  readonly medianWallClockMs: number;
  /** Per vendor, keyed by provider. Never averaged across vendors. */
  readonly cacheHitFractionByProvider: Readonly<Partial<Record<Provider, number>>>;
  readonly dollarsPerAttempt: number;
  // derived
  readonly dollarsPerHeldOutPass: number | null;
}

/**
 * Dollars per held-out pass. Null when no run passed — a configuration with
 * zero passes has an undefined cost per pass and must never be reported as
 * cheap.
 */
export function dollarsPerHeldOutPass(totalCostUsd: number, heldOutPasses: number): number | null {
  if (heldOutPasses <= 0) return null;
  return totalCostUsd / heldOutPasses;
}

/**
 * The decision rule, written down before anything runs (doc 03 section 7.6).
 *
 * Switch away from the baseline ONLY IF ALL THREE HOLD:
 *  1. the alternative's held-out pass rate is within one standard error of
 *     baseline;
 *  2. its dollars per held-out pass is at least 30% lower;
 *  3. its false-finish rate is NOT higher than baseline.
 * Otherwise the question is closed for 90 days.
 */
export interface DecisionRuleInput {
  readonly baseline: ConfigOutcome;
  readonly candidate: ConfigOutcome;
  /** Standard error of the baseline's held-out pass rate. */
  readonly baselineHeldOutPassStdErr: number;
}

export interface DecisionRuleResult {
  readonly switchRecommended: boolean;
  readonly withinOneStandardError: boolean;
  readonly costReductionAtLeast30Percent: boolean;
  readonly falseFinishNotWorse: boolean;
  readonly explanation: string;
}

export function applyDecisionRule(input: DecisionRuleInput): DecisionRuleResult {
  const { baseline, candidate, baselineHeldOutPassStdErr } = input;

  const withinOneStandardError =
    candidate.heldOutPassRate >= baseline.heldOutPassRate - baselineHeldOutPassStdErr;

  const baseCost = baseline.dollarsPerHeldOutPass;
  const candCost = candidate.dollarsPerHeldOutPass;
  const costReductionAtLeast30Percent =
    baseCost !== null && candCost !== null && candCost <= baseCost * 0.7;

  const falseFinishNotWorse = candidate.falseFinishRate <= baseline.falseFinishRate;

  const switchRecommended =
    withinOneStandardError && costReductionAtLeast30Percent && falseFinishNotWorse;

  const reasons: string[] = [];
  if (!withinOneStandardError) reasons.push("held-out pass rate is more than one standard error below baseline");
  if (!costReductionAtLeast30Percent) {
    reasons.push(
      candCost === null || baseCost === null
        ? "dollars per held-out pass is undefined for at least one configuration (no passes)"
        : "dollars per held-out pass is not at least 30% lower than baseline",
    );
  }
  if (!falseFinishNotWorse) reasons.push("false-finish rate is higher than baseline");

  return {
    switchRecommended,
    withinOneStandardError,
    costReductionAtLeast30Percent,
    falseFinishNotWorse,
    explanation: switchRecommended
      ? `all three conditions hold for ${candidate.configId} against ${baseline.configId}`
      : `do not switch to ${candidate.configId}: ${reasons.join("; ")}`,
  };
}

/* -------------------------------------------------------------------------
 * 12. Seams other modules implement
 * ---------------------------------------------------------------------- */

/**
 * A vendor integration.
 *
 * The adapter never receives, stores or returns a credential VALUE. It
 * declares the NAME of the variable it needs; the supervising process forwards
 * that variable into the sandbox by name.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  readonly displayName: string;
  /** NAMES of the environment variables this seat requires. Never values. */
  requiredEnvNames(seat: ModelSeat): readonly string[];
  /** Non-secret endpoint for this seat, or null for the first-party endpoint. */
  resolveBaseUrl(seat: ModelSeat): string | null;
  validateEffort(seat: ModelSeat): EffortValidation;
  /**
   * Convert a vendor-native usage payload into a {@link VendorUsage} row.
   *
   * MUST throw `invalid_usage_shape` when a field is absent. A field the vendor
   * did not report is NEVER recorded as 0: an unreported cache-write count
   * silently understates the bill and corrupts the cache-hit fraction.
   */
  normalizeUsage(raw: unknown, seat: ModelSeat, atIsoInstant: string): VendorUsage;
  /**
   * Worst-case USD cost of the call about to be dispatched, for the pre-call
   * ceiling check. Input is priced at the cache-MISS rate and output at the
   * full planned `max_tokens`; a ceiling checked against an optimistic estimate
   * is not a ceiling.
   */
  worstCaseCallCostUsd(
    seat: ModelSeat,
    plannedMaxOutputTokens: number,
    estimatedInputTokens: number,
    atIsoInstant: string,
  ): number;
}

/** Authors the sealed suite. Sees the ticket text and nothing else. */
export interface AcceptanceSuiteAuthor {
  readonly seat: ModelSeat;
  author(ticket: Ticket): Promise<AcceptanceSuite>;
}

/**
 * The adversarial bad-test audit (doc 03 section 7.4). A structurally separate
 * agent with no shared conversation history with the author: a model tasked
 * with writing its own reward-hack classifier attempted sabotage 12% of the
 * time (doc 02 section 5.6).
 */
export interface AcceptanceSuiteAuditor {
  readonly seat: ModelSeat;
  audit(suite: AcceptanceSuite, ticket: Ticket): Promise<readonly AuditFinding[]>;
}

/** What a runner needs to execute exactly one build attempt. */
export interface RunRequest {
  readonly runId: string;
  readonly ticket: Ticket;
  readonly config: BakeoffConfig;
  readonly repeatIndex: number;
  readonly budget: BudgetPolicy;
  readonly heldConstants: HeldConstants;
  /** Workspace the builder may write to. Never contains the suite. */
  readonly workspaceDir: string;
  /** Where the run record, ledger and redacted logs are written. */
  readonly resultsDir: string;
}

/**
 * The build runner. Implemented outside this scaffold; this interface is the
 * hand-off boundary. A runner MUST enforce {@link BudgetPolicy} out of process
 * and MUST NOT give the builder any path to the acceptance suite.
 */
export interface BakeoffRunner {
  readonly harness: HarnessIdentity;
  run(request: RunRequest): Promise<RunRecord>;
}

/**
 * The sealed gate. Executes the frozen suite against a run's artefact in a
 * clean container with no network and no build-workspace history, and receives
 * nothing the builder wrote about itself.
 */
export interface AcceptanceGate {
  readonly scorerImageDigest: string;
  score(run: RunRecord, suite: AcceptanceSuite): Promise<ScoreRecord>;
}
