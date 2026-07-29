/**
 * estimates.ts — the MODELLED per-ticket costs used for the spend prompt.
 *
 * >>> EVERY NUMBER IN THIS FILE IS MODELLED, NOT MEASURED. Replacing them with
 * >>> measured figures is the entire purpose of the bake-off. They exist for one
 * >>> job: telling the operator what a command is about to cost BEFORE it spends
 * >>> anything. They must never appear in a result, a report or a decision.
 *
 * Source: doc 03 section 4.3 per-ticket configuration costs, as recorded in the
 * campaign-sizing comment on `DEFAULT_BUDGET` in src/config.ts. Those figures
 * are anchored on a 47.5M-token-per-ticket estimate that doc 03 section 4.5
 * names as the single largest source of error in the document.
 *
 * WHERE A CONFIGURATION HAS A RANGE, THE PLANNER USES THE DOWNSIDE. Config C is
 * $54.12/ticket if Moonshot's undocumented cache holds and $74.77 if it does
 * not; config B is $29.78 sticker and $39.91 adjusted for its measured token
 * burn. Quoting the upside would make the estimate an advertisement. A campaign
 * ceiling set below planned spend terminates the experiment mid-matrix, on a
 * boundary, leaving a partial matrix that looks like a result.
 */

import { BakeoffError } from "./contracts.js";

export type EstimateBasis = "modelled" | "unknown";

export interface ConfigCostEstimate {
  readonly configId: string;
  readonly basis: EstimateBasis;
  /** USD per ticket used for planning. Null when no defensible figure exists. */
  readonly plannedUsdPerTicket: number | null;
  /** The optimistic end of the range, when the source gives one. */
  readonly optimisticUsdPerTicket: number | null;
  readonly source: string;
  readonly notes: string;
}

/** MODELLED per-ticket costs. Never a measurement. */
export const MODELLED_TICKET_COST_USD: readonly ConfigCostEstimate[] = Object.freeze([
  Object.freeze({
    configId: "A",
    basis: "modelled" as const,
    plannedUsdPerTicket: 64.97,
    optimisticUsdPerTicket: 64.97,
    source: "doc 03 section 4.3 (baseline, clean, introductory Sonnet 5 rates)",
    notes:
      "$84.73/ticket from 2026-09-01 when Sonnet 5's introductory rate expires, and $84.46 / " +
      "$110.15 with doc 03 section 4.4's 1.3x wastage factor. The clean introductory figure is " +
      "used here so the estimate is comparable to the other arms, all of which are also clean.",
  }),
  Object.freeze({
    configId: "B",
    basis: "modelled" as const,
    plannedUsdPerTicket: 39.91,
    optimisticUsdPerTicket: 29.78,
    source: "doc 03 section 4.3 (deepseek-sub: $29.78 sticker, $39.91 adjusted)",
    notes:
      "The adjusted figure is planned against. DeepSeek V4 Pro burns 14.45M tokens/task on " +
      "Long-Horizon Terminal-Bench against GPT-5.6-sol's 4.32M, so the sticker price understates " +
      "the bill for a long-horizon run.",
  }),
  Object.freeze({
    configId: "C",
    basis: "modelled" as const,
    plannedUsdPerTicket: 74.77,
    optimisticUsdPerTicket: 54.12,
    source: "doc 03 section 4.3 (kimi-orch: $54.12 cached, $74.77 uncached)",
    notes:
      "A 38% swing on an UNDOCUMENTED mechanism: Moonshot publishes neither a cache TTL nor a " +
      "cache-write charge. The uncached figure is planned against because the cached one assumes " +
      "the answer to the question this configuration exists to measure.",
  }),
  Object.freeze({
    configId: "D",
    basis: "modelled" as const,
    plannedUsdPerTicket: 81.84,
    optimisticUsdPerTicket: 81.84,
    source: "doc 03 section 4.3 (kimi-sub)",
    notes:
      "The most expensive arm in the matrix. It is included because doc 05 measures Kimi K3 " +
      "beating Claude Sonnet 5 on BOTH score and cost/test, which is a quality-per-dollar case " +
      "rather than a sticker-price one.",
  }),
  Object.freeze({
    configId: "E",
    basis: "unknown" as const,
    plannedUsdPerTicket: null,
    optimisticUsdPerTicket: null,
    source: "no primary source in the research packet",
    notes:
      "NO PER-MTOK PRICE EXISTS for GPT-5.6 Luna. doc 05's $0.27 is Cost/Test on an 89-task suite " +
      "and doc 05 caveat 1 explicitly forbids substituting it into a per-ticket model. This " +
      "configuration is blocked at preflight and cannot be estimated, because a dollar-denominated " +
      "ceiling cannot be enforced without a per-MTok price: running unpriced means running uncapped.",
  }),
]);

export function estimateFor(configId: string): ConfigCostEstimate {
  const found = MODELLED_TICKET_COST_USD.find((e) => e.configId === configId);
  if (found === undefined) {
    throw new BakeoffError(
      "unknown_config",
      `no modelled cost estimate for configuration "${configId}"`,
      "Add an entry to MODELLED_TICKET_COST_USD in src/estimates.ts, with its source. A " +
        "configuration with no cost estimate cannot be quoted to the operator before it spends.",
    );
  }
  return found;
}

export interface CampaignEstimate {
  readonly runs: number;
  /** Sum of the planned per-ticket figures over every run. */
  readonly plannedUsd: number;
  /** Configurations with no defensible estimate. */
  readonly unpricedConfigIds: readonly string[];
  readonly lines: readonly string[];
}

/**
 * Estimate a set of runs.
 *
 * An unpriced configuration is NOT costed at zero and is NOT silently dropped:
 * it is listed, and the caller decides. Zero is the number that makes an
 * uncapped arm look free.
 */
export function estimateCampaign(
  plan: readonly { readonly configId: string; readonly ticketId: string }[],
): CampaignEstimate {
  const perConfig = new Map<string, number>();
  const unpriced = new Set<string>();
  let plannedUsd = 0;

  for (const run of plan) {
    const estimate = estimateFor(run.configId);
    if (estimate.plannedUsdPerTicket === null) {
      unpriced.add(run.configId);
      continue;
    }
    plannedUsd += estimate.plannedUsdPerTicket;
    perConfig.set(run.configId, (perConfig.get(run.configId) ?? 0) + estimate.plannedUsdPerTicket);
  }

  const lines: string[] = [];
  for (const [configId, usd] of [...perConfig.entries()].sort()) {
    const estimate = estimateFor(configId);
    const runs = plan.filter((p) => p.configId === configId).length;
    lines.push(
      `  ${configId}  ${String(runs).padStart(3)} run(s) x $${(estimate.plannedUsdPerTicket ?? 0).toFixed(2)} ` +
        `= $${usd.toFixed(2)}   [MODELLED: ${estimate.source}]`,
    );
  }
  for (const configId of [...unpriced].sort()) {
    lines.push(`  ${configId}  UNPRICED — cannot be estimated. ${estimateFor(configId).source}`);
  }

  return {
    runs: plan.length,
    plannedUsd,
    unpricedConfigIds: [...unpriced].sort(),
    lines,
  };
}
