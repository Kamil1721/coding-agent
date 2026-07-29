/**
 * campaign.ts — the commands that spend money, and the freeze that must precede
 * them.
 *
 * ORDER IS THE WHOLE DESIGN:
 *
 *   freeze  ->  preflight  ->  estimate  ->  --yes  ->  first dollar
 *
 * `screen` and `finals` run preflight themselves and REFUSE to start if any
 * SELECTED configuration is blocked. A silently skipped configuration turns a
 * five-arm experiment into a four-arm one without saying so, and the missing arm
 * is invisible in every result that follows. Skipping one has to be an explicit
 * act: name the configurations you mean.
 *
 * The estimate printed before the confirmation is MODELLED, and says so on every
 * line. Replacing those numbers with measured ones is the reason the harness
 * exists.
 *
 * These commands live outside cli.ts so that the read-only inspection surface
 * and the spending surface stay separately readable.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BakeoffError, assertSuiteUsable } from "./contracts.js";
import type {
  AcceptanceGate,
  AcceptanceSuite,
  BakeoffConfig,
  BudgetPolicy,
  HarnessIdentity,
  RunRecord,
  RunRequest,
  SandboxSpec,
  Ticket,
} from "./contracts.js";
import {
  BASELINE_CONFIG_ID,
  CONFIG_IDS,
  DEFAULT_BUDGET,
  PHASES,
  SEALED_NETWORK_POLICY,
  getConfig,
  heldConstantsFor,
} from "./config.js";
import { formatPreflightReport, preflight } from "./env.js";
import { KillSwitch } from "./ledger.js";
import { DockerRunner } from "./runner.js";
import { estimateCampaign } from "./estimates.js";
import { TICKETS_DIR, formatTicketSummary, freezeTickets, verifyFrozen } from "./tickets.js";
// THE ACCEPTANCE-PATH CONVENTION HAS EXACTLY ONE DEFINITION.
//
// Integration finding: it used to have three. The spec agent authored suites at
// `acceptance/generated/<id>/FROZEN.json` (spec-types.DEFAULT_ACCEPTANCE_ROOT),
// this file looked for them at `acceptance/<id>/FROZEN.json`, and the scorer
// looked for the test files one directory level too high. None of that is
// type-visible, so `tsc` was clean while `freeze` would have reported six
// tickets BLOCKED with the suites sitting on disk a directory away — and the
// campaign default would have written sealed suites to a path .gitignore does
// not cover. Every consumer now derives its paths from these helpers.
import { frozenManifestFor } from "./spec-freeze.js";
import { DEFAULT_ACCEPTANCE_ROOT } from "./spec-types.js";
import { formatScoringOutcome, scoreRuns } from "./score-run.js";
import { pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;

const HARNESS_ID = "bakeoff";
const HARNESS_VERSION = "0.1.0";

/** Injected so every byte still leaves through the CLI's redaction chokepoint. */
export interface CommandContext {
  emit(text: string): void;
}

/** Help lines for the commands in this module. */
export const CAMPAIGN_USAGE: readonly string[] = Object.freeze([
  "state-changing:",
  "  freeze           seal the ticket set and verify the sealed acceptance suites",
  "  screen           every runnable config x every ticket x 1     SPENDS MONEY",
  "  finals           the finalists x the hard tickets x 3         SPENDS MONEY",
  "  score            load and verify the sealed acceptance gate",
  "",
  "campaign options:",
  "  --yes                        confirm spending. Required by screen and finals.",
  "  --results <dir>              results root (default ./results)",
  "  --tickets <dir>              ticket directory (default ./tickets)",
  `  --acceptance <dir>           sealed suite root (default ./${DEFAULT_ACCEPTANCE_ROOT})`,
  "  --configs A,B,...            restrict to these configurations (never a silent skip)",
  "  --only-tickets T1,T5         restrict to these tickets",
  "  --sandbox-image <ref>        builder image reference",
  "  --sandbox-digest <sha256:..> builder image content digest (required to run)",
  "  --max-cost-usd <n>           per-run hard ceiling",
  "  --max-campaign-usd <n>       campaign hard ceiling",
  "  --max-wall-clock-h <n>       per-run wall-clock ceiling in hours",
  "  --gate <module>              module exporting createGate(): AcceptanceGate",
]);

/* -------------------------------------------------------------------------
 * Arguments
 * ---------------------------------------------------------------------- */

interface Args {
  readonly flags: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      booleans.add(name);
    }
  }
  return { flags, booleans };
}

function flag(args: Args, name: string, fallback: string): string {
  return args.flags.get(name) ?? fallback;
}

function list(args: Args, name: string): readonly string[] | null {
  const raw = args.flags.get(name);
  if (raw === undefined) return null;
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return values.length === 0 ? null : values;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Turn a `--gate` argument into something `import()` accepts.
 *
 * A bare package specifier ("./dist/gate.js" is a path, "some-pkg" is not) must
 * stay a specifier; a filesystem path must become a file:// URL, because on
 * Windows an absolute path like `C:\...` is parsed as a URL scheme. Resolving
 * everything to an absolute path unconditionally, as this did, made a gate
 * shipped as a package unloadable.
 */
function gateSpecifier(raw: string): string {
  if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("/") || isAbsolute(raw)) {
    return pathToFileURL(absolute(raw)).href;
  }
  return raw;
}

/* -------------------------------------------------------------------------
 * The sealed suite, read through the frozen contract only
 * ---------------------------------------------------------------------- */

/**
 * Read `acceptance/<ticketId>/FROZEN.json`.
 *
 * Reads the freeze manifest and NOTHING ELSE under that directory. The holdout
 * test files sit beside it and are never opened, listed or copied by any code
 * on the build path — the runner is not even given the suite, only its digest.
 */
export function readFrozenSuite(acceptanceRoot: string, ticketId: string): AcceptanceSuite | null {
  const path = frozenManifestFor(ticketId, acceptanceRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new BakeoffError(
      "suite_not_audited",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "Regenerate the suite freeze manifest with the spec agent. A manifest that cannot be read " +
        "cannot be proved to be the suite that was audited.",
    );
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const suite = record["suite"] ?? record;
  if (suite === null || typeof suite !== "object") return null;
  const candidate = suite as Partial<AcceptanceSuite>;
  if (
    typeof candidate.sha256 !== "string" ||
    typeof candidate.ticketSha256 !== "string" ||
    !Array.isArray(candidate.criteria) ||
    !Array.isArray(candidate.testFiles)
  ) {
    throw new BakeoffError(
      "suite_not_audited",
      `${path} does not carry a complete AcceptanceSuite`,
      "The freeze manifest must contain the suite verbatim: its freeze digest, the ticket digest " +
        "it was authored from, its criteria and its test-file digests.",
    );
  }
  return suite as AcceptanceSuite;
}

/** Why a ticket cannot be built against. Never a silent omission. */
interface SuiteProblem {
  readonly ticketId: string;
  readonly detail: string;
}

function resolveSuites(
  acceptanceRoot: string,
  tickets: readonly Ticket[],
): { readonly suites: ReadonlyMap<string, AcceptanceSuite>; readonly problems: readonly SuiteProblem[] } {
  const suites = new Map<string, AcceptanceSuite>();
  const problems: SuiteProblem[] = [];

  for (const ticket of tickets) {
    let suite: AcceptanceSuite | null;
    try {
      suite = readFrozenSuite(acceptanceRoot, ticket.id);
    } catch (error) {
      problems.push({
        ticketId: ticket.id,
        detail: error instanceof BakeoffError ? error.message : String(error),
      });
      continue;
    }
    if (suite === null) {
      problems.push({
        ticketId: ticket.id,
        detail:
          `no ${frozenManifestFor(ticket.id, acceptanceRoot)}. The suite is authored ONCE per ` +
          "ticket by the spec seat, from the ticket text alone, before any build run.",
      });
      continue;
    }
    if (suite.ticketSha256 !== ticket.sha256) {
      problems.push({
        ticketId: ticket.id,
        detail:
          `the suite was authored from a different brief (suite ${suite.ticketSha256.slice(0, 12)}..., ` +
          `ticket ${ticket.sha256.slice(0, 12)}...). Re-author it: a suite written against an older ` +
          "brief tests something the builder was never asked to build.",
      });
      continue;
    }
    try {
      assertSuiteUsable(suite);
    } catch (error) {
      problems.push({
        ticketId: ticket.id,
        detail: error instanceof BakeoffError ? error.message : String(error),
      });
      continue;
    }
    suites.set(ticket.id, suite);
  }

  return { suites, problems };
}

/* -------------------------------------------------------------------------
 * freeze
 * ---------------------------------------------------------------------- */

/**
 * Seal the ticket set, then prove every ticket has an audited suite.
 *
 * This command AUTHORS NOTHING. The suite is written by a structurally separate
 * agent with no shared conversation history with any builder — Anthropic
 * measured a model tasked with writing its own reward-hack classifier attempting
 * sabotage 12% of the time, against 0% for every non-hacking baseline.
 */
export function cmdFreeze(ctx: CommandContext, argv: readonly string[]): number {
  const args = parseArgs(argv);
  const ticketsDir = absolute(flag(args, "tickets", TICKETS_DIR));
  const acceptanceRoot = absolute(flag(args, "acceptance", DEFAULT_ACCEPTANCE_ROOT));
  const out: string[] = [];

  const freeze = freezeTickets(ticketsDir);
  const verified = verifyFrozen(ticketsDir);
  out.push("tickets");
  out.push(`  frozen at:  ${freeze.frozenAt}`);
  out.push(`  set digest: ${freeze.setDigest}`);
  out.push(formatTicketSummary(verified.tickets));
  out.push("");

  const { suites, problems } = resolveSuites(acceptanceRoot, verified.tickets);
  out.push("sealed acceptance suites");
  for (const ticket of verified.tickets) {
    const suite = suites.get(ticket.id);
    if (suite === undefined) continue;
    out.push(
      `  ${ticket.id}  sealed  digest=${suite.sha256.slice(0, 16)}...  ` +
        `criteria=${suite.criteria.length}  files=${suite.testFiles.length}  ` +
        `audited=${suite.auditedAt ?? "(not recorded)"}`,
    );
  }
  for (const problem of problems) {
    out.push(`  ${problem.ticketId}  BLOCKED — ${problem.detail}`);
  }

  out.push("");
  out.push(
    problems.length === 0
      ? "Every ticket has a sealed, audited acceptance suite. The campaign may start."
      : `${problems.length} ticket(s) have no usable suite. The campaign must NOT start: a run ` +
          "against a missing or unaudited suite produces neither co-primary metric, and TDFlow's " +
          "entire +26.3pp effect lives in the bad-test audit that has not passed here.",
  );
  ctx.emit(out.join("\n"));
  return problems.length === 0 ? EXIT_OK : EXIT_BLOCKED;
}

/* -------------------------------------------------------------------------
 * screen / finals
 * ---------------------------------------------------------------------- */

interface PlannedRun {
  readonly configId: string;
  readonly ticketId: string;
  readonly repeatIndex: number;
}

function budgetFrom(args: Args): BudgetPolicy {
  const read = (name: string, fallback: number): number => {
    const value = Number(flag(args, name, String(fallback)));
    if (!Number.isFinite(value) || value <= 0) {
      throw new BakeoffError(
        "invalid_usage_shape",
        `--${name} must be a positive number`,
        "A ceiling that is not a positive number is not a ceiling.",
      );
    }
    return value;
  };
  return {
    ...DEFAULT_BUDGET,
    maxCostUsd: read("max-cost-usd", DEFAULT_BUDGET.maxCostUsd),
    maxCampaignCostUsd: read("max-campaign-usd", DEFAULT_BUDGET.maxCampaignCostUsd),
    maxWallClockMs: Math.round(
      read("max-wall-clock-h", DEFAULT_BUDGET.maxWallClockMs / 3_600_000) * 3_600_000,
    ),
  };
}

function sandboxFrom(args: Args): SandboxSpec {
  const imageRef = args.flags.get("sandbox-image");
  const imageDigest = args.flags.get("sandbox-digest");
  if (imageRef === undefined || imageDigest === undefined) {
    throw new BakeoffError(
      "invalid_usage_shape",
      "--sandbox-image and --sandbox-digest are both required to run a build",
      "Pin the builder image by CONTENT DIGEST, not by tag: " +
        "`docker image inspect <ref> --format '{{index .RepoDigests 0}}'`. Held-constant variable 3 " +
        "requires an identical image for every run in the campaign, and a moving tag varies it " +
        "silently between configurations — which is exactly the kind of difference that shows up " +
        "as a model result.",
    );
  }
  return { imageRef, imageDigest, networkPolicy: SEALED_NETWORK_POLICY };
}

function harnessIdentity(): HarnessIdentity {
  return { id: HARNESS_ID, version: HARNESS_VERSION, commit: "unversioned" };
}

function selectConfigs(args: Args, defaults: readonly string[]): readonly BakeoffConfig[] {
  return (list(args, "configs") ?? defaults).map((id) => getConfig(id));
}

function selectTickets(
  args: Args,
  tickets: readonly Ticket[],
  tiers: readonly string[] | null,
): readonly Ticket[] {
  const only = list(args, "only-tickets");
  let selected = tickets;
  if (tiers !== null) selected = selected.filter((t) => tiers.includes(t.tier));
  if (only !== null) selected = selected.filter((t) => only.includes(t.id));
  return selected;
}

export async function cmdScreen(ctx: CommandContext, argv: readonly string[]): Promise<number> {
  return await runPhase(ctx, argv, "screen");
}

export async function cmdFinals(ctx: CommandContext, argv: readonly string[]): Promise<number> {
  return await runPhase(ctx, argv, "finals");
}

async function runPhase(
  ctx: CommandContext,
  argv: readonly string[],
  phase: "screen" | "finals",
): Promise<number> {
  const args = parseArgs(argv);
  const ticketsDir = absolute(flag(args, "tickets", TICKETS_DIR));
  const acceptanceRoot = absolute(flag(args, "acceptance", DEFAULT_ACCEPTANCE_ROOT));
  const resultsRoot = absolute(flag(args, "results", "results"));
  const repeatCount = PHASES[phase].repeatCount;

  const configs = selectConfigs(args, phase === "screen" ? CONFIG_IDS : [BASELINE_CONFIG_ID]);

  // ---- preflight, before anything else ---------------------------------
  // First, because it is the check the operator most needs to see and the one
  // that costs nothing to run. A missing credential discovered after the ticket
  // set has been validated is the same blocker reported later and less usefully.
  const report = preflight();
  const blocked = configs.filter((c) => report.blockedConfigIds.includes(c.id));
  if (blocked.length > 0) {
    ctx.emit(formatPreflightReport(report));
    ctx.emit(
      "\nREFUSING TO START.\n" +
        `${blocked.length} of the ${configs.length} selected configuration(s) cannot run: ` +
        `${blocked.map((c) => `${c.id} (${c.label})`).join(", ")}.\n\n` +
        "Every blocker above names the exact action that clears it. Nothing here is skipped for " +
        "you: dropping an arm turns this into a smaller experiment, and the missing arm is " +
        "invisible in every number that follows.\n\n" +
        "Clear the blockers: set the missing credential, or retrieve the missing price and " +
        "complete its PRICE_TABLE entry. A ceiling denominated in dollars cannot be enforced " +
        "without a per-million-token price, so an unpriced model is an uncapped model.\n" +
        (report.runnableConfigIds.length === 0
          ? "No configuration is currently runnable, so there is no reduced matrix to fall back to."
          : "Or run the remainder DELIBERATELY, naming them: --configs " +
            `${report.runnableConfigIds.join(",")}\n` +
            "and record in the write-up that the matrix was reduced, and why."),
    );
    return EXIT_BLOCKED;
  }

  // ---- the frozen ticket set -------------------------------------------
  const verified = verifyFrozen(ticketsDir);
  const tickets = selectTickets(args, verified.tickets, phase === "finals" ? ["hard"] : null);
  if (tickets.length === 0) {
    ctx.emit(
      "No tickets selected. Freeze the ticket set first (`freeze`), or widen --only-tickets." +
        (phase === "finals" ? " The finals phase runs the HARD tier only." : ""),
    );
    return EXIT_USAGE;
  }

  // ---- every ticket must have a sealed, audited suite -------------------
  const { suites, problems } = resolveSuites(acceptanceRoot, tickets);
  if (problems.length > 0) {
    ctx.emit(
      "REFUSING TO START. No usable sealed acceptance suite for:\n" +
        problems.map((p) => `  ${p.ticketId} — ${p.detail}`).join("\n") +
        "\n\nRun `freeze` for the full diagnosis. Without a sealed suite there is no held-out pass " +
        "and no false finish, which is the entire measurement.",
    );
    return EXIT_BLOCKED;
  }

  // ---- the plan and its modelled price ---------------------------------
  const plan: PlannedRun[] = [];
  for (const config of configs) {
    for (const ticket of tickets) {
      for (let repeat = 0; repeat < repeatCount; repeat += 1) {
        plan.push({ configId: config.id, ticketId: ticket.id, repeatIndex: repeat });
      }
    }
  }
  const budget = budgetFrom(args);
  const estimate = estimateCampaign(plan);

  const preamble: string[] = [];
  preamble.push(`phase ${phase}: ${PHASES[phase].description}`);
  preamble.push(
    `plan: ${configs.length} config(s) x ${tickets.length} ticket(s) x ${repeatCount} repeat(s) ` +
      `= ${plan.length} run(s)`,
  );
  preamble.push("");
  preamble.push("ESTIMATED SPEND — MODELLED, NEVER MEASURED");
  preamble.push(...estimate.lines);
  preamble.push(`  total: $${estimate.plannedUsd.toFixed(2)}`);
  preamble.push("");
  preamble.push(
    "  Every figure above is from doc 03 section 4.3 and rests on a 47.5M-token-per-ticket",
  );
  preamble.push(
    "  estimate that doc 03 section 4.5 names as the single largest source of error in the",
  );
  preamble.push("  document. Replacing them with measured numbers is the point of this campaign.");
  preamble.push("");
  preamble.push("HARD CEILINGS — out of process, checked BEFORE each API call");
  preamble.push(`  per run:      $${budget.maxCostUsd.toFixed(2)}`);
  preamble.push(`  per campaign: $${budget.maxCampaignCostUsd.toFixed(2)}`);
  preamble.push(`  wall clock:   ${(budget.maxWallClockMs / 3_600_000).toFixed(1)} h per run`);
  if (estimate.plannedUsd > budget.maxCampaignCostUsd) {
    preamble.push("");
    preamble.push(
      "  WARNING: planned spend EXCEEDS the campaign ceiling. A campaign ceiling below planned " +
        "spend is a planning error that presents as a budget event: the campaign terminates " +
        "mid-experiment, on a boundary, and the partial matrix looks like a result. Raise " +
        "--max-campaign-usd deliberately, or cut the plan.",
    );
  }
  if (estimate.unpricedConfigIds.length > 0) {
    preamble.push(
      `  NOTE: configuration(s) ${estimate.unpricedConfigIds.join(", ")} have no defensible cost ` +
        "estimate and are NOT in the total above. They are not free; they are unmeasurable.",
    );
  }
  ctx.emit(preamble.join("\n"));

  if (!args.booleans.has("yes")) {
    ctx.emit("\nNothing has been spent. Re-run with --yes to start.");
    return EXIT_OK;
  }

  // ---- run ---------------------------------------------------------------
  const campaignDir = join(resultsRoot, "ledger");
  mkdirSync(campaignDir, { recursive: true });
  const killSwitch = new KillSwitch(join(campaignDir, "KILL"));

  const alreadyEngaged = killSwitch.engaged();
  if (alreadyEngaged !== null) {
    ctx.emit(
      `REFUSING TO START: the kill sentinel is present (${alreadyEngaged.reason}: ${alreadyEngaged.detail}).\n` +
        `Delete ${killSwitch.sentinelPath} deliberately, once you have decided the campaign should ` +
        "continue. It exists so that a campaign which crossed a boundary cannot silently resume " +
        "and spend past it.",
    );
    return EXIT_BLOCKED;
  }
  killSwitch.installSignalHandlers((signal) => {
    ctx.emit(`\nkill switch engaged (${signal.reason}). Stopping in-flight runs on a boundary.`);
  });

  const sandbox = sandboxFrom(args);
  const runner = new DockerRunner({
    harness: harnessIdentity(),
    sandbox,
    campaignDir,
    killSwitch,
    phase,
    acceptanceRoot,
  });

  const ticketsById = new Map(tickets.map((t) => [t.id, t]));
  const records: RunRecord[] = [];
  let stoppedEarly = false;

  for (const planned of plan) {
    if (killSwitch.engaged() !== null) {
      stoppedEarly = true;
      break;
    }
    const ticket = ticketsById.get(planned.ticketId);
    const suite = suites.get(planned.ticketId);
    if (ticket === undefined || suite === undefined) continue;
    const config = getConfig(planned.configId);
    const runId = `${phase}-${config.id}-${ticket.id}-r${planned.repeatIndex}`;

    const request: RunRequest = {
      runId,
      ticket,
      config,
      repeatIndex: planned.repeatIndex,
      budget,
      heldConstants: heldConstantsFor({
        config,
        harness: harnessIdentity(),
        sandbox,
        repeatCount,
        acceptanceSuiteSha256: suite.sha256,
      }),
      workspaceDir: join(resultsRoot, "workspaces", runId),
      resultsDir: join(resultsRoot, "runs", runId),
    };

    ctx.emit(`\n=== ${runId}   ${config.label} / ${ticket.tier}`);
    const record = await runner.run(request);
    records.push(record);
    ctx.emit(
      `    status=${record.status}  kill=${record.killReason ?? "-"}  ` +
        `declaredDone=${String(record.agentDeclaredDone)}  ` +
        `cost=$${record.totalCostUsd.toFixed(2)}  wall=${Math.round(record.wallClockMs / 1000)}s`,
    );
    for (const error of record.harnessErrors) ctx.emit(`    harness error: ${error}`);
  }

  killSwitch.dispose();

  const spent = records.reduce((acc, r) => acc + r.totalCostUsd, 0);
  const tail: string[] = [];
  tail.push("");
  tail.push(`${records.length} of ${plan.length} planned run(s) executed. Measured spend: $${spent.toFixed(2)}.`);
  tail.push(
    "NOTHING IS SCORED YET. The builders' self-reports are recorded and score nothing. Run the " +
      "sealed gate, then `report`.",
  );
  if (stoppedEarly) {
    tail.push(
      "The campaign stopped early on a boundary. The partial matrix is NOT a result: an arm that " +
        "did not finish has no held-out pass rate, and comparing it to one that did is the error " +
        "the boundary exists to make visible.",
    );
  }
  ctx.emit(tail.join("\n"));
  return stoppedEarly ? EXIT_BLOCKED : EXIT_OK;
}

/* -------------------------------------------------------------------------
 * score
 * ---------------------------------------------------------------------- */

/**
 * Load the sealed acceptance gate.
 *
 * The gate is a SEPARATE PROGRAM by design: it executes the frozen suite in a
 * clean container with no network and no access to the build workspace history,
 * and it receives nothing the builder wrote about itself. This command wires it
 * in through a module exporting `createGate(): AcceptanceGate` and verifies the
 * seam and the scorer image digest.
 *
 * It deliberately embeds no fallback gate. A stand-in that ran in this process,
 * beside the runner and the workspace, would not be a held-out gate, and the
 * number it produced would be exactly the leakage the protocol exists to remove
 * — 14.1-20.7pp of it, measured.
 */
export async function cmdScore(ctx: CommandContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const resultsRoot = absolute(flag(args, "results", "results"));
  const gateModule = args.flags.get("gate");

  if (gateModule === undefined) {
    throw new BakeoffError(
      "not_implemented",
      "not implemented: no acceptance gate module was given",
      "Pass --gate <module>, where the module exports `createGate(): AcceptanceGate`. This " +
        "harness will not substitute a stand-in gate: a gate running in the same process as the " +
        "runner is not a held-out gate, and its number would carry the leakage the sealed gate " +
        "exists to remove.",
    );
  }

  const imported: unknown = await import(gateSpecifier(gateModule));
  const factory = (imported as { createGate?: unknown }).createGate;
  if (typeof factory !== "function") {
    throw new BakeoffError(
      "not_implemented",
      `not implemented: ${gateModule} does not export createGate()`,
      "Export `createGate(): AcceptanceGate` from the gate module.",
    );
  }
  // AWAITED. The real gate resolves the scorer image's content digest from the
  // daemon before it will score anything, which is asynchronous. A synchronous
  // call here forced a gate to either lie about the digest or not check it.
  const gate = (await (factory as () => AcceptanceGate | Promise<AcceptanceGate>)()) as AcceptanceGate;
  if (typeof gate.scorerImageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(gate.scorerImageDigest)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the gate reports scorerImageDigest "${String(gate.scorerImageDigest)}", which is not a content digest`,
      "The scorer container must be pinned by digest and identical for every configuration. A " +
        "moving scorer is a moving gate, and a moving gate makes two configurations incomparable.",
    );
  }
  if (typeof gate.score !== "function") {
    throw new BakeoffError(
      "not_implemented",
      `not implemented: the gate from ${gateModule} has no score() method`,
      "An AcceptanceGate is `{ scorerImageDigest, score(run, suite) }`. A gate that cannot score " +
        "produces neither co-primary metric.",
    );
  }

  const acceptanceRoot = absolute(flag(args, "acceptance", DEFAULT_ACCEPTANCE_ROOT));
  ctx.emit(
    [
      `gate module:  ${gateModule}`,
      `scorer image: ${gate.scorerImageDigest}`,
      `results root: ${resultsRoot}`,
      `acceptance:   ${acceptanceRoot}`,
      "",
      "Scoring runs the frozen suite in a clean container with no network and no build-workspace",
      "history, and receives nothing the builder wrote about itself.",
      "",
    ].join("\n"),
  );

  const outcome = await scoreRuns({
    resultsRoot,
    acceptanceRoot,
    gate,
    rescore: args.booleans.has("rescore"),
    emit: ctx.emit,
  });
  ctx.emit(formatScoringOutcome(outcome));

  // A run that could not be scored is not a neutral event: it is a hole in both
  // co-primary metrics, and exclusion drops a potential false finish from the
  // numerator AND the denominator — the direction that flatters a configuration.
  return outcome.failed.length > 0 || outcome.skipped.length > 0 ? EXIT_BLOCKED : EXIT_OK;
}
