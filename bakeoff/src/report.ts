/**
 * report.ts — results/*.jsonl -> results/REPORT.md.
 *
 * The report has one job: APPLY the decision rule that was written down before
 * anything ran, and disclose everything that bears on whether its inputs mean
 * what they appear to mean. It does not choose a winner, it does not rank, and
 * it does not offer an alternative reading of the rule. doc 03 section 7.6:
 * "Commit to this rule before seeing results."
 *
 * Structure, and why it is in this order:
 *
 *   1. THE DECISION RULE, before any result. Stated, then applied mechanically,
 *      per configuration, as plain PASS/FAIL.
 *   2. Integrity and validity alerts. A cost comparison built on a silent cache
 *      failure, or a pass rate built on a scorer that disagrees with its own
 *      criteria, is worse than no comparison — so the reader meets those
 *      findings before the tables, not after.
 *   3-8. The measurements.
 *   9. What this does NOT tell you.
 *
 * Every table in this file is ordered by configuration id. NOTHING IS EVER
 * SORTED BY A METRIC: with one run per (config, ticket) cell, an ordering is a
 * ranking, and this report refuses to produce one.
 *
 * The rendered markdown passes through the redaction chokepoint and is
 * self-checked with `assertRedacted` before it is written.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BakeoffError, PROVIDERS, TOKEN_ACCOUNTING_RULE } from "./contracts.js";
import {
  BASELINE_CONFIG_ID,
  CONFIGS,
  HELD_CONSTANT_VARIABLES,
  PHASES,
} from "./config.js";
import { assertRedacted, redactForPersistence } from "./redact.js";
import { loadResults } from "./results-io.js";
import { aggregate } from "./aggregate.js";
import type {
  Aggregation,
  Alert,
  AlertSeverity,
  ConfigSummary,
  PhaseReport,
} from "./aggregate.js";
import type { DifferenceEstimate, Interval, ProportionEstimate } from "./analyze.js";
import { CONFIDENCE_95 } from "./analyze.js";

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

const NA = "—";

function pct(value: number | null, digits = 1): string {
  return value === null ? NA : `${(value * 100).toFixed(digits)}%`;
}

function pp(value: number | null, digits = 1): string {
  if (value === null) return NA;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}pp`;
}

function usd(value: number | null, digits = 2): string {
  return value === null ? NA : `$${value.toFixed(digits)}`;
}

/** Deterministic thousands grouping. `toLocaleString` is locale-dependent. */
function groupDigits(value: number): string {
  const whole = Math.round(value).toString();
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function duration(ms: number | null): string {
  if (ms === null) return NA;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
  return `${String(seconds)}s`;
}

function interval(value: Interval | null, digits = 1): string {
  if (value === null) return NA;
  return `[${(value.low * 100).toFixed(digits)}%, ${(value.high * 100).toFixed(digits)}%]`;
}

function intervalPp(value: Interval | null, digits = 1): string {
  if (value === null) return NA;
  return `[${(value.low * 100).toFixed(digits)}pp, ${(value.high * 100).toFixed(digits)}pp]`;
}

function passFail(met: boolean): string {
  return met ? "**PASS**" : "**FAIL**";
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function rate(estimate: ProportionEstimate | null): string {
  if (estimate === null) return NA;
  return `${pct(estimate.rate)} (${String(estimate.successes)}/${String(estimate.n)})`;
}

/* -------------------------------------------------------------------------
 * Section 1 — the decision rule
 * ---------------------------------------------------------------------- */

const RULE_STATEMENT = [
  "> **doc 03 section 7.6, quoted before any number in this report is shown.**",
  "> Switch away from Config A **only if all three hold**:",
  "> 1. The alternative's held-out pass rate is **within one standard error** of baseline;",
  "> 2. Its **$ per held-out pass is at least 30% lower**;",
  "> 3. Its **false-finish rate is not higher** than baseline.",
  ">",
  "> Otherwise **the question is closed for 90 days** or until a doc 03 section 9 trigger fires.",
  "> Commit to this rule before seeing results.",
].join("\n");

function ruleMechanics(): string {
  return [
    "The rule is applied mechanically below. It is not reinterpreted here, and this report offers",
    "no alternative formulation of it: it was committed to before any result existed, and choosing",
    "a different statistic after seeing the results is the failure the commitment exists to prevent.",
    "",
    "**Operative forms, exactly as implemented in `applyDecisionRule()` in `src/contracts.ts`:**",
    "",
    table(
      ["#", "Condition", "Operative form", "Note"],
      [
        [
          "(i)",
          "held-out pass rate within one standard error of baseline",
          "`candidate ≥ baseline − SE(baseline)`",
          "ONE-SIDED. A candidate ABOVE baseline always satisfies it. SE is the Wald standard error of the baseline proportion, `sqrt(p(1−p)/n)`.",
        ],
        [
          "(ii)",
          "$ per held-out pass at least 30% lower",
          "`candidate ≤ 0.70 × baseline`",
          "Undefined for either side when that configuration has no held-out pass; the condition then FAILS rather than being skipped.",
        ],
        [
          "(iii)",
          "false-finish rate not higher",
          "`candidate ≤ baseline`",
          "The metric that decides whether a configuration ships broken apps.",
        ],
      ],
    ),
  ].join("\n");
}

function decisionBlock(phase: PhaseReport): string {
  const out: string[] = [];
  out.push(`### Phase \`${phase.phaseId}\` (repeat count ${String(phase.repeatCount)})`);
  out.push("");

  if (!phase.baselinePresent) {
    out.push(
      `**The rule cannot be applied in this phase.** Baseline config \`${phase.baselineConfigId}\` has ` +
        "no counted attempts here, so there is nothing to measure a challenger against. The " +
        "descriptive tables below still apply; no verdict follows from them.",
    );
    out.push("");
    return out.join("\n");
  }

  if (phase.decisions.length === 0) {
    out.push("**No challenger configuration has counted attempts in this phase.** Nothing to decide.");
    out.push("");
    return out.join("\n");
  }

  out.push(
    table(
      [
        "Config",
        "(i) pass rate",
        "(ii) $/held-out pass −30%",
        "(iii) false finish",
        "VERDICT",
      ],
      phase.decisions.map((d) => [
        `\`${d.configId}\``,
        passFail(d.result.withinOneStandardError),
        passFail(d.result.costReductionAtLeast30Percent),
        passFail(d.result.falseFinishNotWorse),
        d.result.switchRecommended ? "**SWITCH CONDITIONS MET**" : "**DO NOT SWITCH**",
      ]),
    ),
  );
  out.push("");

  for (const d of phase.decisions) {
    out.push(`**Config \`${d.configId}\` vs baseline \`${phase.baselineConfigId}\` — the arithmetic**`);
    out.push("");
    out.push(`- (i) ${passFail(d.result.withinOneStandardError)} — \`${d.conditionOneArithmetic}\``);
    out.push(`- (ii) ${passFail(d.result.costReductionAtLeast30Percent)} — \`${d.conditionTwoArithmetic}\``);
    out.push(`- (iii) ${passFail(d.result.falseFinishNotWorse)} — \`${d.conditionThreeArithmetic}\``);
    out.push(`- Verdict: ${d.result.switchRecommended ? "**SWITCH CONDITIONS MET**" : "**DO NOT SWITCH**"} — ${d.result.explanation}`);
    out.push("");

    if (d.baselineStdErrDegenerate) {
      const perfect = d.baselineHeldOutPassRate >= 1;
      out.push(
        `  - **The standard error used in condition (i) is exactly 0**, because the baseline's ` +
          `held-out pass rate is ${d.baselineHeldOutPassRate.toFixed(3)} and the Wald estimator has ` +
          "no variation to measure at that point. " +
          (perfect
            ? "Condition (i) therefore reads `candidate ≥ 1.000`: no imperfect challenger can " +
              "satisfy it, and the condition is at its strictest possible setting."
            : "Condition (i) therefore reads `candidate ≥ 0.000`: every challenger satisfies it " +
              "trivially, and the condition carries no information in this phase."),
      );
    }
    if (d.costConventionInvariant === false) {
      out.push(
        "  - **Condition (ii) is NOT invariant to the cost convention.** This report divides " +
          "spend on COUNTED attempts by held-out passes; doc 04 section 9.4 argues for total spend " +
          "across ALL attempts. The two conventions disagree about condition (ii) for this " +
          "configuration, so harness-error and unscored spend is deciding the verdict. Both figures " +
          "are in the per-config table.",
      );
    }
    if (d.assumedPriceInvariant === false) {
      out.push(
        `  - **Condition (ii) is NOT invariant to an ASSUMED price.** Re-costing this ` +
          `configuration's cache writes at the alternative multiplier changes its spend by ` +
          `${usd(d.assumedPriceDeltaUsd)} and flips condition (ii). A price this harness assumed — ` +
          "not one a vendor documented — is deciding the verdict. Retrieve the real price before " +
          "acting on it.",
      );
    } else if (d.assumedPriceInvariant === true && d.assumedPriceDeltaUsd !== 0) {
      out.push(
        `  - Condition (ii) survives the assumed-cache-write sensitivity (${usd(d.assumedPriceDeltaUsd)} ` +
          "on this configuration), but the dollar figure itself still rests on an assumption.",
      );
    }
    out.push("");
  }

  const met = phase.decisions
    .filter((d) => d.result.switchRecommended)
    .map((d) => d.configId)
    .sort();
  out.push("**Configurations meeting all three conditions in this phase** (listed in configuration-id order — this list is UNORDERED and is not a ranking):");
  out.push("");
  out.push(met.length === 0 ? "- none" : met.map((id) => `- \`${id}\``).join("\n"));
  out.push("");

  if (phase.repeatCount < 3) {
    out.push(
      "> **A verdict from this phase is not decision-grade.** doc 03 section 7.7 runs the screen at " +
        "one repeat and the finals at three, and section 7.7 is explicit that dropping the repeat " +
        "count on the finalists is exactly the noise problem that makes every published open-weight " +
        "cost figure unreliable. A `SWITCH CONDITIONS MET` verdict here promotes a configuration " +
        "into the finals. It never selects one. See section 7.",
    );
    out.push("");
  }

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 2 — alerts
 * ---------------------------------------------------------------------- */

const SEVERITY_LABEL: Readonly<Record<AlertSeverity, string>> = {
  blocking: "BLOCKING",
  critical: "CRITICAL",
  warning: "WARNING",
  note: "NOTE",
};

function alertLines(alerts: readonly Alert[]): string {
  if (alerts.length === 0) return "_No alerts._";
  return alerts
    .map((alert) => {
      const affected =
        alert.affected.length === 0
          ? ""
          : `\n  - affected (${String(alert.affected.length)}): ${alert.affected
              .slice(0, 24)
              .join(", ")}${alert.affected.length > 24 ? ", …" : ""}`;
      return `- **[${SEVERITY_LABEL[alert.severity]}] ${alert.title}** (\`${alert.kind}\`)\n  - ${alert.detail}${affected}`;
    })
    .join("\n");
}

/* -------------------------------------------------------------------------
 * Section 3 — per-config results
 * ---------------------------------------------------------------------- */

function configTables(phase: PhaseReport): string {
  const out: string[] = [];

  out.push(
    table(
      [
        "Config",
        "label",
        "n",
        "held-out pass (± SE)",
        "**FALSE-FINISH RATE**",
        "timeout",
        "BLOCKED",
        "mean wall clock",
        "$ / attempt",
        "$ / held-out pass",
      ],
      phase.configs.map((c) => [
        `\`${c.configId}\``,
        c.label ?? "(not in the matrix)",
        c.outcome === null ? "0" : String(c.outcome.attempts),
        c.heldOut === null
          ? NA
          : `${rate(c.heldOut)} ± ${(c.heldOut.standardError * 100).toFixed(1)}pp`,
        c.falseFinish === null ? NA : `**${rate(c.falseFinish)}**`,
        c.outcome === null ? NA : pct(c.outcome.timeoutRate),
        c.outcome === null ? NA : pct(c.outcome.blockedRate),
        duration(c.meanWallClockMs),
        usd(c.cost.dollarsPerAttempt),
        usd(c.cost.dollarsPerHeldOutPass),
      ]),
    ),
  );
  out.push("");
  out.push(
    "**FALSE-FINISH RATE is called out because it is the metric that decides whether a " +
      "configuration ships broken apps.** It is defined as `agentDeclaredDone && !heldOutPass` — the " +
      "agent declared the work done and the sealed suite failed. Long-Horizon Terminal-Bench measures " +
      "this mode at 19% of unresolved runs; in the product it does not cost a retry, it ships a " +
      "broken app to a paying customer. A low held-out pass rate with a low false-finish rate is a " +
      "configuration that fails honestly. The two co-primary metrics are required together and " +
      "neither alone decides anything.",
  );
  out.push("");
  out.push("**Secondary and derived figures, and the excluded runs.**");
  out.push("");
  out.push(
    table(
      [
        "Config",
        "held-out 95% CI (Wilson)",
        "false-finish 95% CI",
        "budget-exceeded",
        "median wall clock",
        "counted spend",
        "$ / pass (all spend)",
        "harness errors (excluded)",
        "unscored (excluded)",
      ],
      phase.configs.map((c) => [
        `\`${c.configId}\``,
        interval(c.heldOut === null ? null : c.heldOut.interval),
        interval(c.falseFinish === null ? null : c.falseFinish.interval),
        c.outcome === null ? NA : pct(c.outcome.budgetExceededRate),
        duration(c.medianWallClockMs),
        usd(c.cost.countedSpendUsd),
        usd(c.cost.dollarsPerHeldOutPassAllSpend),
        `${String(c.errorRunIds.length)} (${usd(c.cost.harnessErrorSpendUsd)})`,
        `${String(c.unscoredRunIds.length)} (${usd(c.cost.unscoredSpendUsd)})`,
      ]),
    ),
  );
  out.push("");
  out.push(
    "`$ / held-out pass` in the first table divides spend on COUNTED attempts by held-out passes. " +
      "`$ / pass (all spend)` is doc 04 section 9.4's convention — every dollar the configuration " +
      "spent, including harness-error and unscored runs, over the same denominator. Section 1 states " +
      "whether the decision-rule verdict is invariant between the two. Runs with `status: \"error\"` " +
      "are excluded from every rate because a harness failure is not a model outcome " +
      "(`ConfigOutcome` mandates this); runs with no score record are excluded because their " +
      "outcome is unknown and counting them either way is a guess.",
  );

  const bounded = phase.configs.filter((c) => c.unscoredRunIds.length > 0 && c.heldOut !== null);
  if (bounded.length > 0) {
    out.push("");
    out.push(
      "**Bounds on the co-primary metrics if every excluded unscored run had failed.** Exclusion " +
        "removes a potential false finish from the numerator AND the denominator, which is the " +
        "direction that flatters the configuration, so both co-primaries are bounded here rather " +
        "than only the pass rate.",
    );
    out.push("");
    out.push(
      table(
        ["Config", "held-out pass (reported)", "held-out pass (worst case)", "false finish (reported)", "false finish (worst case)"],
        bounded.map((c) => {
          const heldOut = c.heldOut as ProportionEstimate;
          const falseFinish = c.falseFinish as ProportionEstimate;
          const n = heldOut.n + c.unscoredRunIds.length;
          const worstPass = heldOut.successes / n;
          const worstFalseFinish =
            (falseFinish.successes + c.unscoredDeclaredDoneRunIds.length) / n;
          return [
            `\`${c.configId}\``,
            rate(heldOut),
            `${pct(worstPass)} (${String(heldOut.successes)}/${String(n)})`,
            rate(falseFinish),
            `${pct(worstFalseFinish)} (${String(falseFinish.successes + c.unscoredDeclaredDoneRunIds.length)}/${String(n)})`,
          ];
        }),
      ),
    );
  }

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 4 — visible vs held-out
 * ---------------------------------------------------------------------- */

function gapSection(aggregation: Aggregation, phase: PhaseReport): string {
  const out: string[] = [];
  const measured = aggregation.visibleRecordsPresent;

  if (measured) {
    out.push(
      "The gap between the tests the builder could see and the sealed suite it could not IS the " +
        "reward-hacking metric (doc 02 section 5.4). It widens ~27pp per 10x LOC and reaches 100pp " +
        "above 25K LOC (doc 03 section 5 rank 3; doc 02 section 5.4 states 28pp per tenfold), so it " +
        "is widest on exactly the ambitious tickets this product is sold on.",
    );
  } else {
    out.push(
      "> **THE REWARD-HACKING GAP IS NOT MEASURED IN THIS DATASET.** doc 02 section 5.4's gap " +
        "compares two TEST SUITES: the builder's own visible tests against the sealed held-out " +
        "suite. No `visible_run_result` records were supplied, so no visible-test pass rate exists " +
        "here. The figures below substitute the agent's self-report (`agentDeclaredDone`), which is " +
        "a DIFFERENT QUANTITY — an agent can declare done without running a test at all.",
    );
    out.push("");
    out.push(
      "What the substituted number is, exactly: with `visible = declared done`, the identity is",
      "",
      "```",
      "gap = P(declared) − P(held-out pass)",
      "    = P(declared ∧ ¬pass) − P(pass ∧ ¬declared)",
      "    = false_finish_rate − P(passed without declaring)",
      "```",
      "",
      "so the proxy gap is a **lower bound on the false-finish rate**, not a measurement of reward " +
        "hacking. To measure the real gap, have the runner emit `visible_run_result` records " +
        "(`src/visible.ts`) carrying the builder's own suite outcome.",
    );
  }
  out.push("");

  out.push(
    table(
      [
        "Config",
        measured ? "visible-test pass rate" : "self-reported done rate (proxy)",
        "held-out pass rate",
        measured ? "**GAP**" : "**GAP (proxy)**",
        "source",
      ],
      phase.configs.map((c) => [
        `\`${c.configId}\``,
        rate(c.visible),
        rate(c.heldOut),
        `**${pp(c.gapPp)}**`,
        c.visibleSource === "measured"
          ? "measured visible suite"
          : c.visibleSource === "self-report-proxy"
            ? "self-report proxy"
            : NA,
      ]),
    ),
  );
  out.push("");

  if (phase.tiers.length > 0) {
    out.push(
      "**By ticket tier, pooled across configurations.** Descriptive only — pooling configurations " +
        "mixes the variable under test, and tiers carry two tickets each. It is here because the " +
        "gap's documented behaviour is that it GROWS with code size, and a gap that does not widen " +
        "from trivial to hard is itself worth knowing.",
    );
    out.push("");
    out.push(
      table(
        ["Tier", "attempts", "held-out passes", measured ? "visible passes" : "declared done", "gap"],
        phase.tiers.map((t) => [
          t.tier,
          String(t.attempts),
          String(t.heldOutPasses),
          String(t.visiblePasses),
          pp(t.gapPp),
        ]),
      ),
    );
  }
  out.push("");
  out.push(
    "The agent's self-report is RECORDED AND SCORES NOTHING. It appears in this report only in the " +
      "definition of `false_finish` and in this section's proxy. No number in this report treats it " +
      "as a measure of quality.",
  );

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 5 — per-vendor token accounting
 * ---------------------------------------------------------------------- */

const TOKEN_WARNING = [
  "> **TOKEN COUNTS BELOW ARE NOT COMPARABLE ACROSS THESE TABLES.** Tokenizers differ; a Claude",
  "> token is not a Moonshot token is not a DeepSeek token. Anthropic's own documentation states its",
  "> 4.7+ tokenizer produces approximately 30% more tokens for the same text than earlier Claude",
  "> models, and nobody has measured tokens-per-identical-source-text across vendors at all",
  "> (doc 03 section 4.1 footnote). **COMPARE DOLLARS AND OUTCOMES ONLY.** Each vendor gets its own",
  "> table for exactly this reason, and there is deliberately no total row across vendors — the",
  `> harness ships no token-summing helper of any kind (held-constant variable 6: \`${TOKEN_ACCOUNTING_RULE}\`).`,
].join("\n");

function vendorTables(phase: PhaseReport): string {
  const out: string[] = [TOKEN_WARNING, ""];
  let any = false;

  for (const provider of PROVIDERS) {
    const rows = phase.configs.flatMap((c) =>
      c.vendors
        .filter((v) => v.provider === provider)
        .map((v) => [
          `\`${c.configId}\``,
          v.modelId,
          v.role,
          v.effort,
          groupDigits(v.callCount),
          groupDigits(v.inputTokens),
          groupDigits(v.cacheReadTokens),
          groupDigits(v.cacheWriteTokens),
          groupDigits(v.outputTokens),
          v.thinkingTokens === null ? "not reported" : groupDigits(v.thinkingTokens),
          usd(v.costUsd),
        ]),
    );
    if (rows.length === 0) continue;
    any = true;
    out.push(`### ${provider}`);
    out.push("");
    out.push(
      table(
        [
          "Config",
          "model",
          "role",
          "effort",
          "calls",
          "input (cache-miss)",
          "cache_read",
          "cache_write",
          "output",
          "thinking",
          "cost",
        ],
        rows,
      ),
    );
    out.push("");
  }

  if (!any) out.push("_No usage rows recorded._");

  out.push(
    "`input (cache-miss)` is the vendor's `input_tokens` field. On Anthropic it counts only the " +
      "tokens AFTER the last cache breakpoint and is never the total input (doc 04 section 3.4). " +
      "`thinking` reads `not reported` where the vendor did not report it — never 0, which would be " +
      "indistinguishable from a model that did no thinking. Effort rungs are shown per row and are " +
      "NOT comparable across vendors: Anthropic's ladder has five rungs, Moonshot's three, " +
      "DeepSeek's two, OpenAI's five under different names.",
  );

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 6 — cache
 * ---------------------------------------------------------------------- */

function cacheSection(phase: PhaseReport): string {
  const out: string[] = [];

  const rows = phase.configs.flatMap((c) =>
    c.providerCache.map((p) => [
      `\`${c.configId}\``,
      p.provider,
      p.hitFraction === null ? NA : pct(p.hitFraction),
      groupDigits(p.cacheReadTokens),
      groupDigits(p.cacheWriteTokens),
      groupDigits(p.inputTokens),
      groupDigits(p.billedInputTokens),
      p.notCachedAtAll
        ? "**NO CACHING OBSERVED**"
        : p.hitFraction !== null && p.hitFraction < 0.2
          ? "**NEAR-ZERO**"
          : p.hitFraction !== null && p.hitFraction < 0.5
            ? "low"
            : "ok",
    ]),
  );

  const alarming = phase.alerts.filter(
    (a) => a.kind === "cache_not_used" || a.kind === "cache_hit_rate_near_zero",
  );
  if (alarming.length > 0) {
    out.push(
      "> **CACHE FAILURE — THE COST COMPARISON IN THIS REPORT IS NOT VALID UNTIL THIS IS FIXED.**",
      ">",
      "> The 0%-to-85% caching spread is **~$103 per ticket** on the modelled baseline — larger than",
      "> every other optimisation in doc 04 combined — and the marginal value is **$1.215 per",
      "> percentage point** of hit rate (doc 04 section 0.2). Those two figures are derived on the",
      "> Anthropic baseline blend and are ILLUSTRATIVE when applied to a Moonshot or DeepSeek miss,",
      "> but the direction is not in doubt: a silent cache failure moves a configuration's dollar",
      "> figures by more than any model difference this bake-off can detect, and condition (ii) of",
      "> the decision rule is denominated in dollars.",
      ">",
      ...alarming.map((a) => `> - **${a.title}** — ${a.detail}`),
      "",
    );
  }

  out.push(
    table(
      [
        "Config",
        "vendor",
        "cache-hit fraction",
        "cache_read",
        "cache_write",
        "input",
        "billed input",
        "status",
      ],
      rows,
    ),
  );
  out.push("");
  out.push(
    "Fraction is `cache_read / (cache_read + cache_write + input)`, computed from SUMMED token " +
      "counts within one vendor — never as the mean of per-run fractions, which would weight a " +
      "300-token call the same as a 3M-token one. It is a per-vendor number and is never averaged " +
      "across vendors.",
  );
  out.push("");
  out.push(
    "**Reading a zero.** On Anthropic and Moonshot, `cache_read` and `cache_write` both zero means " +
      "the prompt was not cached at all — almost always a prefix below the model's minimum cacheable " +
      "length (512 tokens on Opus 5, 1,024 on Sonnet 5), which fails SILENTLY with no error returned " +
      "and is a 10x price increase on that block. **On DeepSeek the same test would cry wolf:** its " +
      "cache carries no write premium and no separate write line item, so `PRICE_TABLE` requires " +
      "adapters to report `cacheWriteTokens = 0` and bill misses as ordinary input. For DeepSeek the " +
      "no-caching signal used here is `cache_read == 0` alone.",
  );
  out.push("");
  out.push(
    "Measuring Moonshot's cache behaviour is one of the two stated reasons the Kimi configurations " +
      "are in this matrix at all: Moonshot documents neither a cache TTL nor a cache-write charge, " +
      "and the modelled orchestrator cost swings from $14.60/ticket cached to $35.25/ticket uncached " +
      "on that single undocumented mechanism.",
  );

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 7 — statistical honesty
 * ---------------------------------------------------------------------- */

function differenceRow(configId: string, d: DifferenceEstimate | null): readonly string[] {
  if (d === null) return [`\`${configId}\``, NA, NA, NA, NA];
  return [
    `\`${configId}\``,
    pp(d.difference * 100),
    intervalPp(d.interval),
    d.insideNoise ? "**inside noise**" : "outside noise",
    d.z === null ? "undefined (SE = 0)" : d.z.toFixed(2),
  ];
}

function statisticsSection(phase: PhaseReport): string {
  const out: string[] = [];

  const cellsPerConfig = phase.configs
    .map((c) => `\`${c.configId}\`: n=${String(c.heldOut === null ? 0 : c.heldOut.n)}`)
    .join(", ");

  out.push(
    `**n, stated everywhere it matters.** Repeat count in this phase is ` +
      `**${String(phase.repeatCount)}** per (configuration, ticket) cell across ` +
      `${String(phase.ticketIds.length)} ticket(s). Counted attempts per configuration: ${cellsPerConfig}.`,
  );
  out.push("");

  if (phase.repeatCount === 1) {
    out.push(
      "> **WITH ONE RUN PER CELL, NO WINNER IS REPORTED AND NONE MAY BE INFERRED.** Each " +
        "(configuration, ticket) outcome here is a single Bernoulli draw. A configuration that " +
        "passes a ticket its neighbour failed has demonstrated nothing about the models; it has " +
        "produced one sample. doc 03 section 7.7 is explicit: do not economise by dropping the " +
        "repeat count on the finalists, because a single run is exactly the noise problem that makes " +
        "every open-weight cost figure in doc 03 section 4 unreliable. **This report refuses to " +
        "declare a finalist from the screen phase alone.**",
    );
    out.push("");
  }

  if (phase.decisions.length > 0) {
    out.push(
      `**Held-out pass rate, each configuration minus baseline \`${phase.baselineConfigId}\`.** ` +
        `${(CONFIDENCE_95 * 100).toFixed(0)}% Newcombe hybrid score interval on the difference of two ` +
        "independent proportions. A difference whose interval contains zero is not distinguishable " +
        "from chance at this sample size — it is noise, and it must not be described as a lead.",
    );
    out.push("");
    out.push(
      table(
        ["Config", "difference vs baseline", "95% CI on the difference", "verdict", "Wald z"],
        phase.decisions.map((d) => differenceRow(d.configId, d.heldOutDifference)),
      ),
    );
    out.push("");
    out.push("**False-finish rate, each configuration minus baseline.**");
    out.push("");
    out.push(
      table(
        ["Config", "difference vs baseline", "95% CI on the difference", "verdict", "Wald z"],
        phase.decisions.map((d) => differenceRow(d.configId, d.falseFinishDifference)),
      ),
    );
    out.push("");
    out.push(
      "The Wald z column is shown for completeness and decides nothing: at 0/n or n/n the Wald " +
        "standard error is exactly 0 and the z is undefined or infinite, which would declare a " +
        "two-run difference significant. The interval does not have that failure mode. Intervals are " +
        "Wilson-based throughout; the Wald standard error is reported and is fed to the decision " +
        "rule unchanged, because that is the statistic the rule was written in terms of.",
    );
    out.push("");
  }

  const degenerate = phase.decisions.filter((d) => d.baselineStdErrDegenerate);
  if (degenerate.length > 0) {
    out.push(
      "**The baseline standard error in condition (i) is exactly 0 in this phase.** See the note " +
        "under each verdict in section 1 for which way that cuts. This is a small-sample artefact of " +
        "the Wald estimator, not evidence about the models.",
    );
    out.push("");
  }

  const challengers = phase.decisions.length;
  out.push(
    `**Three limits on every interval in this report.** (1) The tickets are ` +
      `${String(phase.ticketIds.length)} FIXED ticket(s) chosen to span the tiers, not a random ` +
      "sample from a population of tickets; a binomial interval treats them as exchangeable trials, " +
      "so it describes uncertainty about THESE tickets and understates uncertainty about any other " +
      "ticket. (2) Repeats of the same ticket are not independent of each other in the way the " +
      "binomial model assumes. (3) No correction for multiple comparisons is applied: with " +
      `${String(challengers)} challenger${challengers === 1 ? "" : "s"} against one baseline, the ` +
      "chance that at least one crosses a threshold by luck is higher than the nominal rate, and it " +
      "rises with the number of arms.",
  );

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 8 — per-ticket matrix
 * ---------------------------------------------------------------------- */

function outcomeCell(config: ConfigSummary, ticketId: string): string {
  const counted = config.counted.filter((c) => c.run.ticketId === ticketId);
  if (counted.length === 0) {
    if (config.unscoredRunIds.length > 0 || config.errorRunIds.length > 0) return "excluded";
    return NA;
  }
  return counted
    .map((c) => {
      const base = c.heldOutPass ? "PASS" : c.falseFinish ? "FAIL*" : "FAIL";
      return c.run.status === "completed" ? base : `${base} (${c.run.status})`;
    })
    .join(", ");
}

function ticketMatrix(phase: PhaseReport): string {
  const out: string[] = [];
  out.push(
    table(
      ["Ticket", "tier", ...phase.configs.map((c) => `\`${c.configId}\``)],
      phase.ticketIds.map((ticketId) => {
        const tier = phase.configs
          .flatMap((c) => c.counted)
          .find((c) => c.run.ticketId === ticketId);
        return [
          ticketId,
          tier === undefined ? "unknown" : tier.tier,
          ...phase.configs.map((c) => outcomeCell(c, ticketId)),
        ];
      }),
    ),
  );
  out.push("");
  out.push(
    "`PASS` = the frozen suite went green in the clean container. `FAIL*` = FALSE FINISH: the agent " +
      "declared done and the suite failed. A status in parentheses is the harness's view of how the " +
      "run ended. `BLOCKED` is a first-class outcome, not a failure of the harness: shipping partial " +
      "progress with an honest status beats shipping a confident false finish, and Long-Horizon " +
      "Terminal-Bench found 62.8% of runs earn partial credit that binary grading discards.",
  );
  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * Section 9 — what this does not tell you
 * ---------------------------------------------------------------------- */

function limitsSection(aggregation: Aggregation): string {
  const dates = aggregation.phases
    .flatMap((p) => p.configs.flatMap((c) => c.counted.map((r) => r.run.startedAt.slice(0, 10))))
    .sort();
  const first = dates[0] ?? "unknown";
  const last = dates[dates.length - 1] ?? "unknown";
  // The UNION across phases, not the sum: the same ticket appears in the screen
  // phase and again in the finals, and adding them overstates what was measured.
  const distinctTickets = new Set(aggregation.phases.flatMap((p) => p.ticketIds)).size;

  return [
    `**This report measures ${String(distinctTickets)} distinct ticket(s) on this harness at these ` +
      `effort settings between ${first} and ${last}. ` +
      "It is not a general model ranking, and nothing in it should be quoted as one.**",
    "",
    "- **It is not a leaderboard.** Six tickets on one harness with one sandbox image is not " +
      "Terminal-Bench and cannot be compared to it. Published boards disagree with each other by " +
      "~4pp on the same benchmark and the same harness family — larger than the model gap this " +
      "bake-off is trying to detect.",
    "- **Effort rungs are not comparable across vendors.** Anthropic has five, Moonshot three, " +
      "DeepSeek two, OpenAI five under different names. What is controlled is that each seat's rung " +
      "was fixed and recorded, not that two vendors were run at 'the same' effort. Effort alone is " +
      "worth 250-497 Elo on AA-Briefcase against an 11.24pp spread across frontier models — a " +
      "mis-set rung would dominate everything measured here.",
    "- **Token counts are not comparable across vendors.** Only dollars and outcomes are.",
    "- **A good result does not mean that model could author its own acceptance suites.** The spec " +
      "and judge seats are held-constant controls (Claude Opus 5 at `xhigh`) in every configuration. " +
      "A product built on a challenger's subagent would still have Opus 5 writing the specs. Reading " +
      "any result here as a licence to change the spec seat is exactly the misreading doc 03 " +
      "section 7.4 warns against.",
    "- **Prices are list prices sourced 2026-07-27 from a secondary retrieval**, and doc 03 " +
      "instructs that any figure used to justify spend above ~$1,000 be confirmed in a browser " +
      "first. Fields recorded as `assumed` are flagged wherever they touch a dollar figure.",
    "- **'The frozen suite went green' is not 'a human would ship this.'** METR found roughly half " +
      "of test-passing SWE-bench Verified PRs would not be merged by maintainers, a merge rate ~24pp " +
      "below the grader score. The Verification Horizon argument is stronger still: every verifier " +
      "is a proxy for human intent, never the intent itself, and for a full app build 'the tests are " +
      "green' carries close to zero information about real quality.",
    "- **It does not measure whether an unattended multi-hour greenfield build works.** No published " +
      "independent evidence says any model reliably completes one. The best measured long-horizon " +
      "result is 28.3% pass@1, and 29 of 46 tasks on that benchmark were never solved by any model.",
    "- **It does not confirm the frozen suite was fit to be run.** A run record carries the suite's " +
      "freeze digest but no audit status, and this report reads no `AcceptanceSuite` records — so it " +
      "confirms WHICH suite executed, never that the adversarial bad-test audit passed on it. That " +
      "audit is a pre-run gate (doc 03 section 7.4) and TDFlow's entire +26.3pp effect lives in it. " +
      "A suite full of vacuous or trivially satisfiable criteria would produce a high held-out pass " +
      "rate here and nothing in these tables would show it.",
    "- **It says nothing about a configuration not in the matrix**, and a configuration blocked at " +
      "preflight (no verified price, unverified model id) is absent from these tables because it was " +
      "never run — not because it lost.",
    "- **Timeouts are budget boundaries, not verdicts.** 79% of unresolved long-horizon runs time " +
      "out while still actively making progress. A run terminated at a ceiling may have been " +
      "converging; it is recorded as a timeout and never as a model failure.",
  ].join("\n");
}

/* -------------------------------------------------------------------------
 * Section 10 — method
 * ---------------------------------------------------------------------- */

function methodSection(aggregation: Aggregation): string {
  const out: string[] = [];

  out.push("**The six held-constant variables (doc 03 section 7.3), audited in section 2.**");
  out.push("");
  out.push(
    table(
      ["#", "Variable", "Rule"],
      HELD_CONSTANT_VARIABLES.map((v) => [String(v.n), v.name, v.rule]),
    ),
  );
  out.push("");
  out.push("**Configuration matrix as defined in `src/config.ts`** (configurations with no runs in this results set are still listed, so an absent arm is visible rather than invisible):");
  out.push("");
  out.push(
    table(
      ["Config", "label", "orchestrator", "subagent", "runs in this results set"],
      CONFIGS.map((config) => {
        const orchestrator = config.seats.find((s) => s.role === "orchestrator");
        const subagent = config.seats.find((s) => s.role === "subagent");
        const runs = aggregation.phases.reduce(
          (total, phase) =>
            total +
            phase.configs
              .filter((c) => c.configId === config.id)
              .reduce((n, c) => n + c.counted.length + c.unscoredRunIds.length + c.errorRunIds.length, 0),
          0,
        );
        return [
          `\`${config.id}\``,
          config.label,
          orchestrator === undefined
            ? NA
            : `${orchestrator.provider}/${orchestrator.modelId} @ ${orchestrator.effort}`,
          subagent === undefined ? NA : `${subagent.provider}/${subagent.modelId} @ ${subagent.effort}`,
          String(runs),
        ];
      }),
    ),
  );
  out.push("");

  const assumptions = [
    ...new Set(aggregation.phases.flatMap((p) => p.configs.flatMap((c) => c.assumedPriceNotes))),
  ].sort();
  out.push("**Pricing provenance carried by these runs.**");
  out.push("");
  out.push(
    assumptions.length === 0
      ? "_Every price field touched by these runs is recorded as `verified`._"
      : assumptions.map((note) => `- ${note}`).join("\n"),
  );
  out.push("");

  const sensitivities = aggregation.phases.flatMap((p) =>
    p.configs.flatMap((c) =>
      c.sensitivities.map((s) => [
        `\`${c.configId}\``,
        `${s.provider}/${s.modelId}`,
        groupDigits(s.cacheWriteTokens),
        `${s.assumedMultiplier.toFixed(2)}x`,
        `${s.alternativeMultiplier.toFixed(2)}x`,
        usd(s.deltaUsd),
      ]),
    ),
  );
  if (sensitivities.length > 0) {
    out.push(
      "**Assumed-cache-write sensitivity.** Moonshot documents neither a cache TTL nor a cache-write " +
        "charge. This harness assumes a write bills at the standard input rate (multiplier 1.00) and " +
        "tests the stated alternative, Anthropic's documented 1.25x 5-minute premium. Section 1 " +
        "states whether condition (ii) survives it.",
    );
    out.push("");
    out.push(
      table(
        ["Config", "model", "cache_write tokens", "assumed", "alternative", "Δ spend"],
        sensitivities,
      ),
    );
    out.push("");
  }

  out.push("**Provenance of this file.**");
  out.push("");
  out.push(
    [
      `- Files read (${String(aggregation.files.length)}): ${aggregation.files.map((f) => `\`${f}\``).join(", ")}`,
      `- Records: ${String(aggregation.runCount)} run, ${String(aggregation.scoreCount)} score, ` +
        `${String(aggregation.visibleCount)} visible-test, ${String(aggregation.ledgerEventCount)} ledger ` +
        `(recorded, never scoring), ${String(aggregation.unrecognisedLineCount)} unrecognised, from ` +
        `${String(aggregation.totalLines)} non-empty line(s).`,
      "- Phases are DERIVED from `heldConstants.repeatCount` and are never pooled " +
        `(\`screen\` = ${String(PHASES.screen.repeatCount)} repeat, \`finals\` = ${String(PHASES.finals.repeatCount)} repeats).`,
      "- `heldOutPass` and `falseFinish` are RECOMPUTED with `computeHeldOutPass()` and " +
        "`deriveFalseFinish()` from `src/contracts.ts` rather than read from the persisted fields; " +
        "any disagreement is raised in section 2.",
      "- Every byte of this report passed through `redactForPersistence()` and was verified with " +
        "`assertRedacted()` before being written. No credential value is read, stored or logged " +
        "anywhere in this harness; only variable NAMES appear.",
    ].join("\n"),
  );

  return out.join("\n");
}

/* -------------------------------------------------------------------------
 * The report
 * ---------------------------------------------------------------------- */

export function renderReport(aggregation: Aggregation): string {
  const blocking = aggregation.alerts.filter((a) => a.severity === "blocking").length;
  const phaseSummary = aggregation.phases
    .map(
      (p) =>
        `\`${p.phaseId}\` (repeat ${String(p.repeatCount)}, ${String(p.runCount)} run(s), ` +
        `${String(p.configs.length)} config(s))`,
    )
    .join(" · ");

  const out: string[] = [];

  out.push("# Bake-off decision report");
  out.push("");
  out.push(
    `**Generated** ${aggregation.generatedAt} · **produced by** \`src/report.ts\` · ` +
      `**baseline** \`${BASELINE_CONFIG_ID}\``,
  );
  out.push("");
  out.push(`**Phases present:** ${phaseSummary || "none"}`);
  out.push("");
  if (blocking > 0) {
    out.push(
      `> **STOP — ${String(blocking)} BLOCKING alert(s).** At least one control this experiment ` +
        "depends on did not hold. Read section 2 before any number below. A verdict computed from " +
        "data with a broken control is not a verdict.",
    );
    out.push("");
  }
  out.push("---");
  out.push("");

  out.push("## 1. THE DECISION RULE — stated before any result in this report");
  out.push("");
  out.push(RULE_STATEMENT);
  out.push("");
  out.push(ruleMechanics());
  out.push("");
  for (const phase of aggregation.phases) {
    out.push(decisionBlock(phase));
  }
  out.push("---");
  out.push("");

  out.push("## 2. Integrity and validity — read before the numbers");
  out.push("");
  out.push("**Across all phases:**");
  out.push("");
  out.push(alertLines(aggregation.alerts));
  out.push("");
  for (const phase of aggregation.phases) {
    out.push(`**Phase \`${phase.phaseId}\`:**`);
    out.push("");
    out.push(alertLines(phase.alerts));
    out.push("");
  }
  out.push("---");
  out.push("");

  for (const phase of aggregation.phases) {
    out.push(`## Phase \`${phase.phaseId}\` — repeat count ${String(phase.repeatCount)}`);
    out.push("");
    out.push("### 3. Per-configuration results");
    out.push("");
    out.push(configTables(phase));
    out.push("");
    out.push("### 4. Visible vs held-out pass rate");
    out.push("");
    out.push(gapSection(aggregation, phase));
    out.push("");
    out.push("### 5. Token accounting, per vendor");
    out.push("");
    out.push(vendorTables(phase));
    out.push("");
    out.push("### 6. Measured cache-hit fraction, per vendor");
    out.push("");
    out.push(cacheSection(phase));
    out.push("");
    out.push("### 7. Statistical honesty");
    out.push("");
    out.push(statisticsSection(phase));
    out.push("");
    out.push("### 8. Per-ticket outcomes");
    out.push("");
    out.push(ticketMatrix(phase));
    out.push("");
    out.push("---");
    out.push("");
  }

  out.push("## 9. What this report does NOT tell you");
  out.push("");
  out.push(limitsSection(aggregation));
  out.push("");
  out.push("---");
  out.push("");
  out.push("## 10. Method and provenance");
  out.push("");
  out.push(methodSection(aggregation));
  out.push("");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

export interface ReportOptions {
  /** Directory containing results/*.jsonl. Read recursively. */
  readonly resultsDir?: string;
  /** Output path. Defaults to `<resultsDir>/REPORT.md`. */
  readonly outPath?: string;
  /** ISO-8601 instant stamped on the report. Defaults to now. */
  readonly generatedAt?: string;
}

export interface ReportResult {
  readonly outPath: string;
  readonly markdown: string;
  readonly aggregation: Aggregation;
  /** True when at least one control the experiment depends on did not hold. */
  readonly hasBlockingAlerts: boolean;
}

/**
 * Read `results/*.jsonl`, apply the decision rule, write `results/REPORT.md`.
 *
 * Throws a {@link BakeoffError} — never a stack trace — when the results
 * directory is missing, contains no run records, or contains a record this
 * harness cannot read without guessing.
 */
export function writeReport(options: ReportOptions = {}): ReportResult {
  const resultsDir = resolve(options.resultsDir ?? join(process.cwd(), "results"));
  const outPath = resolve(options.outPath ?? join(resultsDir, "REPORT.md"));
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const loaded = loadResults(resultsDir);
  const aggregation = aggregate(loaded, { generatedAt });
  const markdown = redactForPersistence(renderReport(aggregation));

  try {
    assertRedacted(markdown);
  } catch (error) {
    throw new BakeoffError(
      "invalid_usage_shape",
      "the rendered report still matches a credential pattern after redaction",
      "This is a redaction defect, not a data defect. The report was NOT written. Investigate " +
        "src/redact.ts against the offending rule before regenerating; the value is deliberately " +
        `not reproduced here. Underlying check: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf8");

  return {
    outPath,
    markdown,
    aggregation,
    hasBlockingAlerts: aggregation.alerts.some((a) => a.severity === "blocking"),
  };
}
