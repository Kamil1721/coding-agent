/**
 * config.ts — the configuration matrix and the held-constant controls.
 *
 * FIVE configurations, derived from the MEASURED leaderboard in
 * docs/research/05-vals-terminal-bench-2-1-measured.md (Vals AI, Terminal-Bench
 * 2.1, Terminus 2 harness, identical config for all systems, 89 tasks, pass@1,
 * page updated 2026-07-22):
 *
 *   rank 2  Claude Opus 5   84.64% +/-0.99   $0.89/test
 *   rank 3  Kimi K3         80.90% +/-0.65   $0.34/test
 *   rank 5  GPT-5.6 Luna    79.03% +/-0.99   $0.27/test
 *   rank 7  Claude Sonnet 5 74.53% +/-2.08   $0.80/test
 *   rank 35 DeepSeek V4     50.19% +/-1.5    $0.24/test
 *
 * Configs D (kimi-sub) and E (luna-sub) exist because the measured board shows
 * both beat Claude Sonnet 5 on BOTH score and cost/test — Kimi K3 by +6.37pp at
 * 2.4x lower cost/test, GPT-5.6 Luna by +4.50pp at 3.0x lower cost/test (doc 05,
 * "The three systems that beat Claude Sonnet 5 on score AND cost/test"). That is
 * the subagent-seat question this bake-off exists to settle, and no published
 * board answers it for a multi-hour greenfield build.
 *
 * DEVIATION FROM doc 03 SECTION 7.2, STATED SO IT IS NOT MISTAKEN FOR A BUG.
 * doc 03's own table lists four configurations: A baseline, B DeepSeek subagent,
 * C Kimi orchestrator, D all-DeepSeek. This matrix keeps A, B and C (as A, B, C)
 * and replaces the all-DeepSeek floor with two subagent swaps that the measured
 * board published on 2026-07-27 makes more informative:
 *   - the all-DeepSeek config was included "to bound the question, expect it to
 *     fail", and doc 03 section 7.4 already warns its result could not be read
 *     as a costed all-DeepSeek product configuration anyway;
 *   - doc 05 subsequently corrected the record that DeepSeek, GLM, MiniMax and
 *     Qwen were "absent from all independent boards" — DeepSeek V4 measures
 *     50.19%, 34.5pp below Opus 5 in the same harness, which bounds the floor
 *     without spending a single run on it.
 * Config B still carries the DeepSeek question, in the only seat doc 03 section
 * 3.4 considers defensible: a bounded subagent behind a deterministic gate it
 * cannot see.
 *
 * THE SPEC SEAT IS A CONTROL, NOT A VARIABLE UNDER TEST.
 * Every configuration uses the SAME spec seat (Claude Opus 5 at xhigh) to author
 * the held-out acceptance suite, and the SAME judge seat to run the adversarial
 * bad-test audit over it. That isolates the builder variable (doc 03 section
 * 7.4). It also means: A GOOD RESULT FOR A CONFIGURATION DOES NOT MEAN THAT
 * MODEL COULD AUTHOR ITS OWN ACCEPTANCE SUITES. A product built on config B's
 * subagent would still have Opus 5 writing the specs; a real all-DeepSeek
 * product would have a model with a measured 94% hallucination rate writing its
 * own acceptance criteria, which is a materially worse proposition than
 * anything measured here. Do not let a good number be read as a licence to
 * change the spec seat.
 */

import { BakeoffError, EFFORT_LADDERS, validateSeatEffort } from "./contracts.js";
import type {
  AnthropicSeat,
  BakeoffConfig,
  BudgetPolicy,
  DeepSeekSeat,
  HeldConstants,
  HarnessIdentity,
  ModelSeat,
  MoonshotSeat,
  OpenAISeat,
  RecordedEffort,
  SandboxSpec,
  TicketTier,
} from "./contracts.js";
import { TOKEN_ACCOUNTING_RULE } from "./contracts.js";

/* -------------------------------------------------------------------------
 * Seats
 *
 * EFFORT IS PINNED PER (model, role) AND IS IDENTICAL IN EVERY CONFIGURATION
 * THAT USES THAT PAIR. An unrecorded effort makes the whole experiment
 * uninterpretable — effort alone is worth 250-497 Elo on AA-Briefcase, against
 * an 11.24pp spread across frontier models (doc 03 section 5 ranks 4 and 5).
 *
 * RUNG NAMES ARE NOT COMPARABLE ACROSS VENDORS. Anthropic's ladder has five
 * rungs, Moonshot's three, DeepSeek's two, OpenAI's five under different names.
 * "medium" on Anthropic and "medium" on OpenAI are not the same setting and
 * must never be reported as a controlled variable. What is controlled is that
 * each seat's rung is fixed and recorded on every run.
 * ---------------------------------------------------------------------- */

/** Claude Opus 5 in the orchestrator seat. doc 03 section 1: "Start with high, the default". */
export const OPUS_5_ORCHESTRATOR: AnthropicSeat = Object.freeze({
  role: "orchestrator",
  provider: "anthropic",
  modelId: "claude-opus-5",
  effort: "high",
  effortSource: "task-spec",
  envKeyName: "ANTHROPIC_API_KEY",
  baseUrl: null,
  notes:
    "doc 03 section 1 and section 7.2 config A. Anthropic's own guidance for Opus 5 is to start at " +
    "high; xhigh buys +87 Elo for +37% cost and max buys +27 Elo for a further +25% — the worst " +
    "marginal return on the curve (doc 04 section 5.1). Do NOT turn the orchestrator down: Opus 5 at " +
    "medium (1470 Elo) ranks below Claude Fable 5 at max.",
});

/** Claude Sonnet 5 in the subagent seat. The baseline being challenged. */
export const SONNET_5_SUBAGENT: AnthropicSeat = Object.freeze({
  role: "subagent",
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  effort: "medium",
  effortSource: "task-spec",
  envKeyName: "ANTHROPIC_API_KEY",
  baseUrl: null,
  notes:
    "doc 03 section 1 and section 7.2 config A. Priced at the introductory rate through 2026-08-31 " +
    "and at $3/$0.30/$15 from 2026-09-01; a bake-off straddling that date costs each run at the rate " +
    "in force on its start date. Reopen trigger 7 in doc 03 section 9 is a measured effort sweep " +
    "showing medium failing after the price rise.",
});

/** Kimi K3 in the orchestrator seat (config C). */
export const KIMI_K3_ORCHESTRATOR: MoonshotSeat = Object.freeze({
  role: "orchestrator",
  provider: "moonshot",
  modelId: "kimi-k3",
  effort: "high",
  effortSource: "doc-03-7.2",
  envKeyName: "MOONSHOT_API_KEY",
  baseUrl: null,
  notes:
    "doc 03 section 7.2 config C. Moonshot's ladder is low/high/max with max as the DEFAULT, so 'high' " +
    "must be set explicitly. Not equivalent to Anthropic 'high'. This seat is also the only way to " +
    "measure Moonshot's undocumented cache TTL and cache-write charge, which decide whether the " +
    "orchestrator-seat saving is real: $14.60/ticket if the cache holds, $35.25/ticket if it does not " +
    "(doc 03 section 4.2/4.3, configs C and C').",
});

/** Kimi K3 in the subagent seat (config D). */
export const KIMI_K3_SUBAGENT: MoonshotSeat = Object.freeze({
  role: "subagent",
  provider: "moonshot",
  modelId: "kimi-k3",
  effort: "high",
  effortSource: "harness-choice",
  envKeyName: "MOONSHOT_API_KEY",
  baseUrl: null,
  notes:
    "HARNESS CHOICE, not prescribed by any source document. 'high' is the same rung K3 runs at in the " +
    "orchestrator seat (config C), so Kimi's effort is identical wherever Kimi appears and the two " +
    "Kimi results stay comparable to each other. It is NOT claimed to be equivalent to Sonnet 5's " +
    "'medium'. Note also that on price alone this seat saves nothing — $3/$0.30/$15 is identical to " +
    "the cent to Sonnet 5 from 2026-09-01 and strictly worse today (doc 03 section 2.2). It is in the " +
    "matrix because doc 05 measures K3 at +6.37pp over Sonnet 5 on score at 2.4x lower cost/test, " +
    "i.e. the case is a QUALITY-per-dollar case, not a sticker-price case.",
});

/** DeepSeek V4 Pro in the subagent seat (config B). */
export const DEEPSEEK_V4_PRO_SUBAGENT: DeepSeekSeat = Object.freeze({
  role: "subagent",
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
  effort: "max",
  effortSource: "doc-03-7.2",
  envKeyName: "DEEPSEEK_API_KEY",
  baseUrl: null,
  notes:
    "doc 03 section 7.2 config B pins reasoning_effort: max. DeepSeek's ladder has only two rungs " +
    "(high|max) and no budget or pacing primitive at all, so there is NO rung comparable to Sonnet 5's " +
    "'medium' — this is a recorded non-equivalence, not a controlled match. doc 04 section 8.4's " +
    "'never max' rule is Anthropic-specific and does not govern this seat. V4 PRO, not V4 Flash: " +
    "AA-Briefcase puts Flash (833) below Sonnet 5 at low (928) (doc 03 section 3.4). Doc 03 section " +
    "3.4 considers this seat defensible ONLY behind a deterministic gate the model cannot see and " +
    "where it never reports its own completion — which is exactly the sealed gate this harness runs.",
});

/** GPT-5.6 Luna in the subagent seat (config E). */
export const GPT_5_6_LUNA_SUBAGENT: OpenAISeat = Object.freeze({
  role: "subagent",
  provider: "openai",
  modelId: "gpt-5.6-luna",
  effort: "medium",
  effortSource: "harness-choice",
  envKeyName: "OPENAI_API_KEY",
  baseUrl: null,
  notes:
    "HARNESS CHOICE. The rung name mirrors the baseline subagent's, but OpenAI's ladder is not " +
    "Anthropic's and the two are not equivalent. THE PRICE BLOCKER IS CLEARED: owner decision D3 " +
    "(2026-07-27) put verified per-MTok prices for gpt-5.6-luna into PRICE_TABLE ($1.00 input / " +
    "$0.10 cache read / $6.00 output, cache write at 1.25x input), so preflight no longer reports " +
    "unpriced_model. doc 05's $0.27 is still NOT the basis for any of it: that is Cost/Test on an " +
    "89-task suite and doc 05 caveat 1 forbids substituting it into a per-ticket model. TWO THINGS " +
    "STILL BLOCK THIS CONFIG: (1) OpenAI does not speak the Anthropic Messages API, the only wire " +
    "protocol the budget proxy implements, and a translator would be a second harness (held-constant " +
    "variable 2); (2) the API model ID is unverified — doc 05 lists a display name only, and the " +
    "price entry is keyed on this same string. " +
    "Separately: GPT-5.6 SOL is EXCLUDED from this matrix on behaviour, not price — METR found its " +
    "detected cheating rate higher than any public model they have evaluated, with documented " +
    "packaging exploits to reveal hidden test suites (doc 03 table 2.1). Luna is a different model " +
    "and no such finding is published for it, but that absence is not evidence of good behaviour; " +
    "the sealed gate is what makes including it safe to measure.",
});

/**
 * THE SPEC SEAT — held constant in every configuration.
 *
 * doc 03 section 7.4: the acceptance suite is written once per ticket by a
 * separate Claude Opus 5 xhigh agent from the ticket text alone, before any
 * build run, with no access to any implementation. xhigh rather than high
 * because the Spec Architect is split out precisely so it can run hotter
 * without changing effort mid-conversation on the orchestrator, which would
 * destroy the prompt cache (doc 03 section 1, doc 04 section 3.3 item 9).
 */
export const SPEC_SEAT: AnthropicSeat = Object.freeze({
  role: "spec",
  provider: "anthropic",
  modelId: "claude-opus-5",
  effort: "xhigh",
  effortSource: "doc-03-7.2",
  envKeyName: "ANTHROPIC_API_KEY",
  baseUrl: null,
  notes:
    "HELD-CONSTANT CONTROL. Identical in every configuration. Must run as a structurally separate " +
    "agent with NO shared conversation history with any builder: Anthropic measured a model tasked " +
    "with writing its own reward-hack classifier attempting sabotage 12% of the time, with all " +
    "non-hacking baselines at 0% (doc 02 section 5.6).",
});

/**
 * THE JUDGE SEAT — the adversarial bad-test auditor, held constant.
 *
 * In this bake-off the judge NEVER grades a run: held-out pass is decided
 * deterministically by executing the frozen suite in the clean container. Its
 * only job is doc 03 section 7.4's bad-test audit — finding criteria that are
 * vacuous, tautological, mis-specified or trivially satisfiable, before any
 * build starts. TDFlow's entire +26.3pp effect lives in that detector.
 *
 * RESIDUAL RISK, STATED: doc 02 section 5.1 requires a genuinely different
 * model FAMILY for a blocking-tier VERDICT, because self-preference is driven
 * by low perplexity / familiarity and Opus-judging-Sonnet does not remove it.
 * That requirement governs the product's completion judge, where an LLM decides
 * pass/fail. Here nothing is LLM-decided, so the same-family exposure is
 * confined to which bad tests get caught. Claude Fable 5 was considered as the
 * cross-model option and rejected: it was fully suspended 2026-06-12 to 06-30 on
 * three days' notice and returns stop_reason "refusal" as HTTP 200, which is an
 * unacceptable dependency for a frozen control (doc 03 table 2.1). Revisit if a
 * cross-family model is ever verified.
 */
export const JUDGE_SEAT: AnthropicSeat = Object.freeze({
  role: "judge",
  provider: "anthropic",
  modelId: "claude-opus-5",
  effort: "xhigh",
  effortSource: "doc-03-7.2",
  envKeyName: "ANTHROPIC_API_KEY",
  baseUrl: null,
  notes:
    "HELD-CONSTANT CONTROL. Runs the adversarial bad-test audit over the suite before any build. " +
    "Structurally separate agent, no shared conversation history with the spec seat or any builder. " +
    "Never scores a run.",
});

/* -------------------------------------------------------------------------
 * The matrix
 * ---------------------------------------------------------------------- */

/** The five configurations under test. Frozen. */
export const CONFIGS: readonly BakeoffConfig[] = Object.freeze([
  Object.freeze({
    id: "A",
    label: "baseline",
    seats: [OPUS_5_ORCHESTRATOR, SONNET_5_SUBAGENT, SPEC_SEAT, JUDGE_SEAT],
    notes:
      "BASELINE. doc 03 section 7.2 config A. Modelled at $64.97/ticket clean at introductory rates " +
      "and $84.73 from 2026-09-01, with a 1.3x wastage factor taking the effective figure to $84.46 / " +
      "$110.15 (doc 03 sections 4.3 and 4.4). Every one of those numbers is MODELLED, anchored on a " +
      "47.5M-token-per-ticket estimate that doc 03 section 4.5 names as the single largest source of " +
      "error in the document. Replacing them with measured figures is the point of this bake-off. " +
      "The decision rule (doc 03 section 7.6) is written down before anything runs: switch away from " +
      "A only if a challenger's held-out pass rate is within one standard error, its dollars per " +
      "held-out pass is at least 30% lower, AND its false-finish rate is not higher.",
  }),
  Object.freeze({
    id: "B",
    label: "deepseek-sub",
    seats: [OPUS_5_ORCHESTRATOR, DEEPSEEK_V4_PRO_SUBAGENT, SPEC_SEAT, JUDGE_SEAT],
    notes:
      "The only order-of-magnitude cost lever that exists: DeepSeek V4 Pro's cache-hit input rate is " +
      "138x below Opus 5's and its cache is automatic, carries no write premium and lives 'a few hours " +
      "to a few days' — mechanically better suited to an hours-long run with idle gaps than " +
      "Anthropic's 5-minute/1-hour TTLs (doc 03 section 3.1). Everything else argues against it: " +
      "6.5% pass@1 on Long-Horizon Terminal-Bench at 14.45M tokens/task against GPT-5.6-sol's 4.32M; " +
      "50.19% on Vals TB2.1, 34.5pp below Opus 5 in the identical harness (doc 05); NIST/CAISI " +
      "measured 74% on public SWE-bench Verified against 44% on held-out PortBench, a -30pp collapse " +
      "where GPT-5.5 lost 3pp; 94% hallucination rate; no pacing primitive. THE -30pp HELD-OUT " +
      "COLLAPSE IS WHY THIS BAKE-OFF USES A HELD-OUT GATE: your tickets are the held-out distribution.",
  }),
  Object.freeze({
    id: "C",
    label: "kimi-orch",
    seats: [KIMI_K3_ORCHESTRATOR, SONNET_5_SUBAGENT, SPEC_SEAT, JUDGE_SEAT],
    notes:
      "The only orchestrator-seat saving anyone found, and the only way to measure Moonshot's " +
      "undocumented cache TTL and cache-write charge (doc 03 section 7.2 config C). Modelled at " +
      "$54.12/ticket if the cache holds and $74.77 if it does not — a 38% swing on an undocumented " +
      "mechanism, which is exactly the kind of question a leaderboard cannot answer. Kimi K3 measures " +
      "80.90% +/-0.65 on Vals TB2.1 at $0.34/test against Opus 5's 84.64% +/-0.99 at $0.89/test " +
      "(doc 05), but note doc 05 caveat 5: short-task cost efficiency need not survive an hours-long " +
      "run when caching is ~59% of the bill and neither TTL nor write charge is documented.",
  }),
  Object.freeze({
    id: "D",
    label: "kimi-sub",
    seats: [OPUS_5_ORCHESTRATOR, KIMI_K3_SUBAGENT, SPEC_SEAT, JUDGE_SEAT],
    notes:
      "In the matrix because doc 05 measures Kimi K3 beating Claude Sonnet 5 on BOTH axes: +6.37pp on " +
      "score (80.90% vs 74.53%) at 2.4x lower cost/test ($0.34 vs $0.80), same harness, same config, " +
      "89 tasks, pass@1. That is a subagent-seat swap the sticker price alone would have closed — " +
      "K3 is $3/$0.30/$15, identical to the cent to Sonnet 5 post-2026-09-01 and worse today. The " +
      "measured board is the reason to test it anyway. Kimi K3's Terminal-Bench 2.1 effort setting is " +
      "UNDISCLOSED by Vals AI (doc 03 section 2.3), so the published 80.90% cannot be attributed to " +
      "the rung this seat runs at; that is one more reason to measure rather than infer.",
  }),
  Object.freeze({
    id: "E",
    label: "luna-sub",
    seats: [OPUS_5_ORCHESTRATOR, GPT_5_6_LUNA_SUBAGENT, SPEC_SEAT, JUDGE_SEAT],
    notes:
      "In the matrix because doc 05 measures GPT-5.6 Luna beating Claude Sonnet 5 on BOTH axes: " +
      "+4.50pp on score (79.03% vs 74.53%) at 3.0x lower cost/test ($0.27 vs $0.80), and at the " +
      "lowest latency of any system above 74% (355.8s). The PRICE half of the block is cleared by " +
      "owner decision D3 (2026-07-27): PRICE_TABLE now carries a verified per-MTok price for " +
      "gpt-5.6-luna, so the hard cost ceiling is enforceable and preflight no longer reports " +
      "unpriced_model. doc 05's Cost/Test figure remains explicitly not substitutable into a " +
      "per-ticket model and was not used. STILL BLOCKED, on the wire protocol: OpenAI does not " +
      "speak the Anthropic Messages API, so the budget proxy refuses the seat with not_implemented, " +
      "and the API model ID is still unverified. This is a fail-clean block with a stated " +
      "remediation, not a silent skip.",
  }),
]);

export const CONFIG_IDS: readonly string[] = Object.freeze(CONFIGS.map((c) => c.id));

/** The baseline every challenger is measured against (doc 03 section 7.6). */
export const BASELINE_CONFIG_ID = "A";

/** Look up a configuration by id. Throws clean rather than returning undefined. */
export function getConfig(id: string): BakeoffConfig {
  const found = CONFIGS.find((c) => c.id === id);
  if (found === undefined) {
    throw new BakeoffError(
      "unknown_config",
      `no configuration with id "${id}"`,
      `Known configuration ids: ${CONFIG_IDS.join(", ")}.`,
    );
  }
  return found;
}

/* -------------------------------------------------------------------------
 * Held constants
 * ---------------------------------------------------------------------- */

/** The six held-constant variables, for documentation and for reports. */
export const HELD_CONSTANT_VARIABLES: readonly { readonly n: number; readonly name: string; readonly rule: string }[] =
  Object.freeze([
    Object.freeze({
      n: 1,
      name: "Reasoning effort",
      rule:
        "Fixed per (model, role) and RECORDED on every run. Effort alone is worth 250-497 Elo, more " +
        "than the gap being measured. Rung names are not comparable across vendors.",
    }),
    Object.freeze({
      n: 2,
      name: "Harness",
      rule:
        "One harness, ours, for every configuration. Never compare our harness against a vendor-native " +
        "runner: the measured harness delta is 0 to +5.1pp and only when harness and model share a " +
        "vendor, and it reverses for at least one vendor.",
    }),
    Object.freeze({
      n: 3,
      name: "Sandbox image and network policy",
      rule:
        "Identical image digest and identical egress policy for every run. Sealed: no upstream repos, " +
        "no package registry except a pinned mirror, no issue trackers. Cursor measured 14.1-20.7pp " +
        "of apparent quality evaporating when exactly this was sealed.",
    }),
    Object.freeze({
      n: 4,
      name: "Repeat count",
      rule: "Same for every configuration within a phase. 1 for the screen, 3 for the finalists.",
    }),
    Object.freeze({
      n: 5,
      name: "The held-out acceptance suite",
      rule:
        "One suite per ticket, authored by the spec seat before any build, audited, hashed and frozen. " +
        "Every configuration builds against the same suite for the same ticket.",
    }),
    Object.freeze({
      n: 6,
      name: "Token accounting",
      rule:
        "Per vendor, never compared across vendors. Raw input / cache_read / cache_write / output " +
        "recorded separately per vendor. COMPARE DOLLARS AND OUTCOMES ONLY.",
    }),
  ]);

/**
 * Paths a builder must never be able to read, list or modify.
 *
 * A prompt instruction is NOT sufficient: enforce with filesystem permissions
 * AND a diff gate, and treat any touched path as an instant fail (doc 02
 * section 5.6). ImpossibleBench measured Claude-family models editing test
 * files more than 79% of the time when they could.
 */
export const BUILDER_FORBIDDEN_PATH_PREFIXES: readonly string[] = Object.freeze([
  "acceptance/",
  ".bakeoff/suite/",
  ".bakeoff/ledger/",
]);

/** Effort snapshot for a configuration, for the run record's held constants. */
export function recordedEffortsFor(config: BakeoffConfig): readonly RecordedEffort[] {
  return config.seats.map((seat: ModelSeat) => ({
    role: seat.role,
    provider: seat.provider,
    modelId: seat.modelId,
    effort: seat.effort,
    effortSource: seat.effortSource,
  }));
}

const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface HeldConstantsInput {
  readonly config: BakeoffConfig;
  readonly harness: HarnessIdentity;
  readonly sandbox: SandboxSpec;
  readonly repeatCount: number;
  readonly acceptanceSuiteSha256: string;
}

/**
 * Build the held-constants block for a run.
 *
 * Validates the two fields most likely to be left as a placeholder: a mutable
 * image tag instead of a digest silently varies variable 3 across runs, and an
 * absent suite digest makes variable 5 unverifiable after the fact.
 */
export function heldConstantsFor(input: HeldConstantsInput): HeldConstants {
  if (!IMAGE_DIGEST_RE.test(input.sandbox.imageDigest)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `sandbox.imageDigest "${input.sandbox.imageDigest}" is not an immutable content digest`,
      "Pin the sandbox by digest (sha256:<64 hex>), not by tag. A moving tag silently varies " +
        "held-constant variable 3 between runs and invalidates every comparison in the bake-off.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.acceptanceSuiteSha256)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      "acceptanceSuiteSha256 is not a sha256 hex digest",
      "Pass the freeze digest returned by acceptanceSuiteDigest() in src/hash.ts.",
    );
  }
  if (!Number.isInteger(input.repeatCount) || input.repeatCount < 1) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `repeatCount must be a positive integer, got ${String(input.repeatCount)}`,
      "Use PHASES.screen.repeatCount or PHASES.finals.repeatCount.",
    );
  }
  return {
    efforts: recordedEffortsFor(input.config),
    harness: input.harness,
    sandbox: input.sandbox,
    repeatCount: input.repeatCount,
    acceptanceSuiteSha256: input.acceptanceSuiteSha256,
    tokenAccountingRule: TOKEN_ACCOUNTING_RULE,
  };
}

/**
 * The sealed network policy. Identical for every configuration.
 *
 * `allowedHosts` is empty by default: doc 03 section 7.3 requires no egress to
 * upstream repos, no package registry except a pinned mirror and no issue
 * trackers. If a pinned mirror is needed, add exactly that host and nothing
 * else, and record it — the allowlist is part of held-constant variable 3, so
 * changing it mid-bake-off invalidates the comparison.
 */
export const SEALED_NETWORK_POLICY = Object.freeze({
  egress: "denied" as const,
  allowedHosts: Object.freeze([]) as readonly string[],
});

/* -------------------------------------------------------------------------
 * Phases, tickets, budgets
 * ---------------------------------------------------------------------- */

export interface Phase {
  readonly id: "screen" | "finals";
  readonly repeatCount: number;
  readonly description: string;
}

/** doc 03 sections 7.3 item 4 and 7.7. */
export const PHASES: Readonly<Record<"screen" | "finals", Phase>> = Object.freeze({
  screen: Object.freeze({
    id: "screen",
    repeatCount: 1,
    description: "5 configs x 6 tickets x 1 run = 30 runs. Screens the matrix.",
  }),
  finals: Object.freeze({
    id: "finals",
    repeatCount: 3,
    description:
      "Top 2 configs x 2 hardest tickets x 3 repeats = 12 runs. Do NOT economise by dropping the " +
      "repeat count here: a single run is exactly the noise problem that makes every open-weight cost " +
      "figure in doc 03 section 4 unreliable.",
  }),
});

/**
 * The six frozen reference-ticket slots (doc 03 section 7.1).
 *
 * The brief TEXT is owner-authored and lives outside this file: it is real
 * product work, it is frozen verbatim, it is never edited between runs, and its
 * digest is recorded (see `ticketDigest` in hash.ts). This module defines the
 * SHAPE of the set, not its content — inventing ticket text here would make the
 * bake-off measure fabricated work instead of the owner's own tickets, which is
 * the entire reason the protocol exists.
 */
export interface TicketSlot {
  readonly id: string;
  readonly tier: TicketTier;
  readonly purpose: string;
}

export const REFERENCE_TICKET_SLOTS: readonly TicketSlot[] = Object.freeze([
  Object.freeze({ id: "T1", tier: "trivial", purpose: "Establishes the floor; catches harness bugs cheaply." }),
  Object.freeze({ id: "T2", tier: "trivial", purpose: "Second floor sample." }),
  Object.freeze({ id: "T3", tier: "medium", purpose: "The modal ticket." }),
  Object.freeze({ id: "T4", tier: "medium", purpose: "Second modal sample." }),
  Object.freeze({
    id: "T5",
    tier: "hard",
    purpose: "The ticket the product is sold on: data model + external API + persisted state + tests.",
  }),
  Object.freeze({ id: "T6", tier: "hard", purpose: "Second hard sample; the long-horizon regime." }),
]);

/**
 * DEFAULT BUDGET — hard ceilings, enforced OUT-OF-PROCESS, checked BEFORE each
 * API call. Confirm these against your own account limits before the first run.
 *
 * PER-RUN SIZING: maxCostUsd is roughly 2x the modelled baseline ticket
 * ($64.97 clean, doc 03 section 4.3), so a hard ticket has headroom while a
 * runaway loop is stopped early — the cheapest failure is an early one
 * (doc 04 section 9.4).
 *
 * CAMPAIGN SIZING — RECOMPUTED FOR THIS MATRIX, NOT doc 03's.
 * doc 03 section 7.7 budgets ~$2,100 for 36 runs, but that arithmetic is for
 * its FOUR-config table whose fourth arm was all-DeepSeek at $109 for six
 * tickets. This matrix has FIVE configs and replaces that cheap arm with
 * kimi-sub, which doc 03 section 4.3 prices at $81.84/ticket — the most
 * expensive arm in the matrix. Screen phase, 6 tickets each, from doc 03
 * section 4.3 per-ticket figures:
 *
 *   A baseline                    $64.97/ticket          ~$390
 *   B deepseek-sub    $29.78 sticker / $39.91 adjusted   ~$240
 *   C kimi-orch       $54.12 cached / $74.77 uncached    ~$450 (plan the downside)
 *   D kimi-sub                    $81.84/ticket          ~$491
 *   E luna-sub                    UNKNOWN — unpriced     ~$400 assumed placeholder
 *                                                        ------
 *                                                        ~$1,970
 *   Finals: 2 configs x 2 hard tickets x 3 repeats, 12 runs   ~$900
 *   Failed runs, spec regeneration, contingency                ~$300
 *                                                        ------
 *                                              planned    ~$3,170
 *
 * The ceiling is set at $3,500, roughly 10% above planned spend. A CAMPAIGN
 * CEILING SET BELOW PLANNED SPEND IS A PLANNING ERROR THAT PRESENTS AS A BUDGET
 * EVENT: the campaign terminates mid-experiment, on a boundary, and the partial
 * matrix looks like a result. Recompute this constant if config E's real price
 * lands above the placeholder, or if any arm's measured cost exceeds its model.
 *
 * TWO WARNINGS FROM doc 03 SECTION 7.8, BOTH LOAD-BEARING:
 *   - Vendor task_budget parameters are ADVISORY. Anthropic's own docs: "Claude
 *     may occasionally exceed the budget if it is in the middle of an action."
 *     Sonnet 5 has no task_budget at all; Moonshot and DeepSeek have no budget
 *     primitive of any kind. The out-of-process ceiling is the only real control.
 *   - Anthropic's Start tier is a $500/month spend cap after which API usage
 *     pauses until the next month. At $85-124/ticket one runaway loop exhausts
 *     a month. REQUEST A LIMIT INCREASE BEFORE YOU START.
 */
export const DEFAULT_BUDGET: BudgetPolicy = Object.freeze({
  maxCostUsd: 120,
  // 4 hours. A boundary, not a progress judgement: 79% of unresolved
  // long-horizon runs time out while still actively making progress, so a run
  // stopped here may well have been converging. Record it as a timeout and
  // never as a model failure.
  maxWallClockMs: 4 * 60 * 60 * 1000,
  maxCampaignCostUsd: 3500,
  warnAtFraction: 0.8,
  perVendorMaxOutputTokens: null,
  vendorAdvisoryBudgets: Object.freeze([]),
});

/* -------------------------------------------------------------------------
 * Self-check
 * ---------------------------------------------------------------------- */

export interface MatrixProblem {
  readonly configId: string;
  readonly problem: string;
}

/**
 * Validate the matrix's own invariants. Called by the CLI before anything runs.
 *
 * Checks that every configuration has exactly one seat per role, that every
 * effort rung exists on its provider's ladder, and — the invariant that makes
 * the experiment interpretable — that the spec and judge seats are byte-for-byte
 * identical across all five configurations.
 */
export function validateConfigMatrix(configs: readonly BakeoffConfig[] = CONFIGS): readonly MatrixProblem[] {
  const problems: MatrixProblem[] = [];
  const roles: readonly ModelSeat["role"][] = ["orchestrator", "subagent", "spec", "judge"];

  const fingerprint = (seat: ModelSeat): string =>
    `${seat.provider}|${seat.modelId}|${seat.effort}|${seat.envKeyName}|${seat.baseUrl ?? ""}`;

  const controlFingerprints = new Map<string, string>();

  for (const config of configs) {
    for (const role of roles) {
      const seats = config.seats.filter((s) => s.role === role);
      if (seats.length !== 1) {
        problems.push({
          configId: config.id,
          problem: `expected exactly 1 "${role}" seat, found ${seats.length}`,
        });
        continue;
      }
      const seat = seats[0] as ModelSeat;

      const effort = validateSeatEffort(seat);
      if (!effort.valid) {
        problems.push({
          configId: config.id,
          problem: `${role} seat: ${effort.problem ?? "invalid effort"} ` +
            `(ladder: ${EFFORT_LADDERS[seat.provider].join(" < ")})`,
        });
      }

      if (role === "spec" || role === "judge") {
        const fp = fingerprint(seat);
        const known = controlFingerprints.get(role);
        if (known === undefined) {
          controlFingerprints.set(role, fp);
        } else if (known !== fp) {
          problems.push({
            configId: config.id,
            problem:
              `${role} seat differs from the other configurations (${fp} vs ${known}). ` +
              "The spec and judge seats are held-constant controls; varying one turns the " +
              "acceptance gate into a variable under test and invalidates every comparison.",
          });
        }
      }
    }
  }

  return problems;
}
