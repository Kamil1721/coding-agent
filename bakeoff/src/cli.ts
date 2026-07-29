#!/usr/bin/env node
/**
 * cli.ts — the preflight and inspection entry point.
 *
 * SCOPE, STATED SO THE BOUNDARY IS LEGIBLE: this CLI reports what the harness
 * WOULD do. It resolves credentials, validates the configuration matrix, prices
 * the matrix and prints the held-constant controls. It executes no runs and
 * spends no money.
 *
 * The build runner, the spec/audit agents and the sealed scorer are separate
 * programs. They implement {@link BakeoffRunner}, {@link AcceptanceSuiteAuthor},
 * {@link AcceptanceSuiteAuditor} and {@link AcceptanceGate} from contracts.ts
 * and own their own entry points and npm scripts. Nothing in this scaffold
 * needs to be edited to add them.
 *
 * Every byte written to stdout passes through the redaction chokepoint. Not
 * because this CLI handles secrets — it does not — but because a chokepoint
 * with an exception is not a chokepoint.
 */

import { BakeoffError, PRICE_FIELDS, PRICE_TABLE } from "./contracts.js";
import {
  BASELINE_CONFIG_ID,
  BUILDER_FORBIDDEN_PATH_PREFIXES,
  CONFIGS,
  DEFAULT_BUDGET,
  HELD_CONSTANT_VARIABLES,
  PHASES,
  REFERENCE_TICKET_SLOTS,
  SEALED_NETWORK_POLICY,
  validateConfigMatrix,
} from "./config.js";
import { formatPreflightReport, preflight } from "./env.js";
import { redactForPersistence } from "./redact.js";
import { writeReport } from "./report.js";
import {
  CAMPAIGN_USAGE,
  cmdFinals,
  cmdFreeze,
  cmdScore,
  cmdScreen,
} from "./campaign.js";
import { DEFAULT_BUILDER_COMMAND, builderCommandDigest } from "./runner.js";
import { cmdDryRun } from "./dryrun.js";
import { PERSIST_REDACT_OPTIONS } from "./ledger.js";

const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;

function emit(text: string): void {
  process.stdout.write(`${redactForPersistence(text, PERSIST_REDACT_OPTIONS)}\n`);
}

/** Passed to the campaign commands so their output uses the same chokepoint. */
const commandContext = { emit };

function usage(): string {
  return [
    "bakeoff — model bake-off harness",
    "",
    "usage: npm run bakeoff -- <command> [options]",
    "",
    "validate the harness for $0 — DO THIS FIRST:",
    "  dry-run          run the WHOLE pipeline against a stub provider. No vendor is",
    "                   called and no money is spent. Proves the seal, the pre-call",
    "                   ceiling, the freeze, the sealed gate and the decision rule.",
    "    --root <dir>          output root (default ./dry-run, a SIBLING of ./results",
    "                          so a plain `report` can never pick it up)",
    "    --builder-image <ref> stand-in for the builder sandbox (default node:22)",
    "    --scorer-image <ref>  scorer image (default bakeoff-scorer:1)",
    "    --no-docker           stages 1, 2 and 5 only. Leaves the seal UNPROVED.",
    "",
    "read-only:",
    "  preflight        which configurations can run, and what blocks the rest (default)",
    "  configs          the configuration matrix, seat by seat, with its evidence",
    "  pricing          the price table, with the status of every field",
    "  protocol         the six held-constant variables, phases, budgets, forbidden paths",
    "  report           read results/*.jsonl, apply the decision rule, write results/REPORT.md",
    "  help             this text",
    "",
    ...CAMPAIGN_USAGE,
    "",
    "report options:",
    "  --results <dir>  directory holding results/*.jsonl (default: ./results)",
    "  --out <file>     output path (default: <results>/REPORT.md)",
    "",
    "exit codes:",
    "  0  every configuration is runnable / the report has no blocking alert",
    "  1  at least one configuration is blocked (never silently skipped), or the report",
    "     found a control the experiment depends on that did not hold",
    "  2  usage error, or the configuration matrix violates its own invariants",
  ].join("\n");
}

/** Read `--flag value` from an argument list. Returns null when absent. */
function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `${flag} requires a value`,
      `Pass a path after ${flag}, e.g. "${flag} ./results".`,
    );
  }
  return value;
}

function cmdReport(args: readonly string[]): number {
  const resultsDir = flagValue(args, "--results");
  const outPath = flagValue(args, "--out");

  const result = writeReport({
    ...(resultsDir === null ? {} : { resultsDir }),
    ...(outPath === null ? {} : { outPath }),
  });

  const lines: string[] = [];
  lines.push(`wrote ${result.outPath}`);
  lines.push(
    `  ${String(result.aggregation.runCount)} run record(s), ` +
      `${String(result.aggregation.scoreCount)} score record(s), ` +
      `${String(result.aggregation.visibleCount)} visible-test record(s)`,
  );
  for (const phase of result.aggregation.phases) {
    lines.push(
      `  phase ${phase.phaseId}: ${String(phase.configs.length)} config(s), ` +
        `${String(phase.runCount)} run(s), repeat count ${String(phase.repeatCount)}`,
    );
    for (const decision of phase.decisions) {
      lines.push(
        `    config ${decision.configId}: ` +
          `(i) ${decision.result.withinOneStandardError ? "PASS" : "FAIL"}  ` +
          `(ii) ${decision.result.costReductionAtLeast30Percent ? "PASS" : "FAIL"}  ` +
          `(iii) ${decision.result.falseFinishNotWorse ? "PASS" : "FAIL"}  ` +
          `=> ${decision.result.switchRecommended ? "SWITCH CONDITIONS MET" : "DO NOT SWITCH"}`,
      );
    }
  }
  const blocking = result.aggregation.alerts.filter((a) => a.severity === "blocking");
  if (blocking.length > 0) {
    lines.push("");
    lines.push(`BLOCKING (${String(blocking.length)}): a control this experiment depends on did not hold.`);
    for (const alert of blocking) lines.push(`  - [${alert.kind}] ${alert.title}`);
    lines.push("Read section 2 of the report before acting on any number in it.");
  }
  emit(lines.join("\n"));

  return result.hasBlockingAlerts ? EXIT_BLOCKED : EXIT_OK;
}

function cmdPreflight(): number {
  const report = preflight();
  emit(formatPreflightReport(report));
  return report.blockedConfigIds.length === 0 ? EXIT_OK : EXIT_BLOCKED;
}

function cmdConfigs(): number {
  const problems = validateConfigMatrix();
  const out: string[] = [];
  out.push("configuration matrix");
  out.push(`  baseline: config ${BASELINE_CONFIG_ID}`);
  out.push("");
  for (const config of CONFIGS) {
    out.push(`config ${config.id} (${config.label})`);
    for (const seat of config.seats) {
      out.push(
        `  ${seat.role.padEnd(12)} ${seat.provider}/${seat.modelId}  effort=${seat.effort} ` +
          `(source: ${seat.effortSource})  env=${seat.envKeyName}` +
          (seat.baseUrl === null ? "" : `  baseUrl=${seat.baseUrl}`),
      );
      out.push(`      ${seat.notes}`);
    }
    out.push(`  why: ${config.notes}`);
    out.push("");
  }
  if (problems.length > 0) {
    out.push("MATRIX INVARIANT VIOLATIONS:");
    for (const p of problems) out.push(`  - config ${p.configId}: ${p.problem}`);
  }
  emit(out.join("\n"));
  return problems.length === 0 ? EXIT_OK : EXIT_USAGE;
}

function cmdPricing(): number {
  const out: string[] = [];
  out.push("price table — USD per million tokens");
  out.push("  >>> VERIFY BEFORE TRUSTING. Sourced 2026-07-27 from a secondary retrieval.");
  out.push("  >>> A bake-off costs roughly $2,100. Confirm each figure on the vendor's page first.");
  out.push("");
  for (const price of PRICE_TABLE) {
    const window = `${price.effectiveFrom} .. ${price.effectiveUntil ?? "open"}`;
    out.push(`${price.provider}/${price.modelId} — ${price.label}`);
    out.push(`  window: ${window}   sourced: ${price.sourcedOn}`);
    const fmt = (v: number | null): string => (v === null ? "unknown" : v.toString());
    out.push(
      `  input=${fmt(price.inputUsdPerMTok)}  cacheRead=${fmt(price.cacheReadUsdPerMTok)}  ` +
        `cacheWrite5m=${fmt(price.cacheWrite5mUsdPerMTok)}  cacheWrite1h=${fmt(price.cacheWrite1hUsdPerMTok)}  ` +
        `output=${fmt(price.outputUsdPerMTok)}`,
    );
    out.push(`  status: ${PRICE_FIELDS.map((f) => `${f}=${price.fieldStatus[f]}`).join("  ")}`);
    if (price.assumedCacheWriteMultiplier !== null) {
      out.push(`  assumed cache-write multiplier on the input rate: ${price.assumedCacheWriteMultiplier}`);
    }
    out.push(`  source: ${price.source}`);
    out.push(`  notes: ${price.notes}`);
    out.push("");
  }
  emit(out.join("\n"));
  return EXIT_OK;
}

function cmdProtocol(): number {
  const out: string[] = [];
  out.push("THE SIX HELD-CONSTANT VARIABLES (doc 03 section 7.3)");
  for (const v of HELD_CONSTANT_VARIABLES) {
    out.push(`  ${v.n}. ${v.name}`);
    out.push(`     ${v.rule}`);
  }
  out.push("");
  out.push("CO-PRIMARY METRICS — both required, neither alone (doc 03 section 7.5)");
  out.push("  held_out_pass  the frozen suite goes green in the clean container");
  out.push("  false_finish   the agent DECLARED DONE and the held-out suite FAILED");
  out.push("secondary: timeout rate, wall clock, BLOCKED rate, cache-hit fraction PER VENDOR, $ per attempt");
  out.push("derived (not primary): $ per held-out pass");
  out.push("");
  out.push("PHASES");
  for (const phase of Object.values(PHASES)) {
    out.push(`  ${phase.id}: repeatCount=${phase.repeatCount} — ${phase.description}`);
  }
  out.push("");
  out.push("REFERENCE TICKETS (text is owner-authored and frozen verbatim; slots only here)");
  for (const slot of REFERENCE_TICKET_SLOTS) {
    out.push(`  ${slot.id}  ${slot.tier.padEnd(8)} ${slot.purpose}`);
  }
  out.push("");
  out.push("HARD BUDGET — enforced out-of-process, checked BEFORE each API call");
  out.push(`  per run:      $${DEFAULT_BUDGET.maxCostUsd}`);
  out.push(`  wall clock:   ${DEFAULT_BUDGET.maxWallClockMs / 3_600_000} h`);
  out.push(`  per campaign: $${DEFAULT_BUDGET.maxCampaignCostUsd}`);
  out.push(`  warn at:      ${DEFAULT_BUDGET.warnAtFraction * 100}% of the run ceiling`);
  out.push("  Vendor task-budget parameters are ADVISORY and are recorded, never trusted.");
  out.push("  Termination happens on a budget boundary only. There is no stuck-detection heuristic:");
  out.push("  79% of unresolved long-horizon runs time out while still actively making progress.");
  out.push("");
  out.push("THE BUILDER COMMAND — identical in every configuration (held-constant variable 2)");
  out.push(`  argv digest: ${builderCommandDigest(DEFAULT_BUILDER_COMMAND)}`);
  out.push(`  ${DEFAULT_BUILDER_COMMAND.argv.join(" ")}`);
  out.push("  Only the environment differs between configurations, and only in the model aliases");
  out.push("  and the proxy address. Vendor budget flags in it are ADVISORY and never load-bearing.");
  out.push("");
  out.push("SEALED NETWORK POLICY (identical for every run)");
  out.push(`  egress: ${SEALED_NETWORK_POLICY.egress}`);
  out.push(`  allowed hosts: ${SEALED_NETWORK_POLICY.allowedHosts.join(", ") || "(none)"}`);
  out.push("  Enforced as `docker run --network none`: a network namespace with no route anywhere.");
  out.push("  The container's only channel is a unix socket carrying the budget proxy, and a probe");
  out.push("  inside the container must confirm the internet is unreachable before the builder starts.");
  out.push("");
  out.push("PATHS NO BUILDER MAY READ, LIST OR MODIFY");
  for (const p of BUILDER_FORBIDDEN_PATH_PREFIXES) out.push(`  ${p}`);
  out.push("  Enforce with filesystem permissions AND a diff gate. A prompt instruction is not enough.");
  emit(out.join("\n"));
  return EXIT_OK;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "preflight";
  const rest = argv.slice(1);
  switch (command) {
    case "preflight":
      return cmdPreflight();
    case "configs":
      return cmdConfigs();
    case "pricing":
      return cmdPricing();
    case "protocol":
      return cmdProtocol();
    case "report":
      return cmdReport(rest);
    case "freeze":
      return cmdFreeze(commandContext, rest);
    case "screen":
      return await cmdScreen(commandContext, rest);
    case "finals":
      return await cmdFinals(commandContext, rest);
    case "score":
      return await cmdScore(commandContext, rest);
    case "dry-run":
    case "--dry-run":
      return await cmdDryRun(commandContext, rest);
    case "help":
    case "--help":
    case "-h":
      emit(usage());
      return EXIT_OK;
    default:
      emit(`unknown command "${command}"\n\n${usage()}`);
      return EXIT_USAGE;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof BakeoffError) {
    // Fail clean: a named code, the problem, and the exact action that clears it.
    emit(`error [${error.code}]: ${error.message}\nfix: ${error.remediation}`);
    process.exitCode = error.code === "budget_exceeded" ? EXIT_BLOCKED : EXIT_USAGE;
  } else {
    // Never a stack trace. A harness that crashes at the operator is a harness
    // that gets run with the ceiling disabled.
    emit(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_USAGE;
  }
}
