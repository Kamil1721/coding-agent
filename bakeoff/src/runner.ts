/**
 * runner.ts — drives ONE (ticket, config, repeatIndex) triple.
 *
 * The runner's job is to produce a {@link RunRecord} that a later reader can
 * trust without trusting the agent that produced it. Four properties do that
 * work, and each is ASSERTED rather than assumed:
 *
 *  1. THE HELD-OUT SUITE IS UNREACHABLE. The runner never receives the suite at
 *     all — {@link RunRequest} carries only its freeze digest, inside
 *     `heldConstants`. On top of that structural fact the runner proves the
 *     negative: no forbidden path exists in the workspace before the build, none
 *     exists after it, none is reachable through git history, and the acceptance
 *     root is not inside the workspace nor the workspace inside it. A leaked-
 *     then-deleted file is still in the git object store, so the working tree
 *     alone is not enough evidence.
 *
 *  2. THE SANDBOX IS SEALED. `--network none` gives the container a network
 *     namespace with no route anywhere. Its only channel is a UNIX SOCKET
 *     bind-mounted from the host, carrying the budget proxy. A filesystem path
 *     is not a network route: nothing else becomes reachable by adding it.
 *     Cursor measured 14.1-20.7pp of apparent quality evaporating when exactly
 *     this was sealed, so the seal is verified from INSIDE the container by a
 *     probe that must fail to reach the internet and must succeed in reaching
 *     the proxy. A run whose probe disagrees does not start.
 *
 *  3. THE COMPLETION SIGNAL IS STRUCTURED, NOT PROSE. The builder writes
 *     `.bakeoff/self-report.json`. Exactly two fields are read from it: a status
 *     enum and a reason string. Nothing score-shaped is ever read from the
 *     workspace, and `agentDeclaredDone` scores nothing — it exists so
 *     `falseFinish` can be computed.
 *
 *  4. EVERY BYTE PERSISTED IS REDACTED FIRST. Container stdout is streamed
 *     through {@link ReassemblingRedactor}, which buffers across chunk
 *     boundaries: a regex applied per chunk cannot match a key split across two
 *     reads.
 *
 * WHAT THE RUNNER DELIBERATELY DOES NOT DO: guess. There is no stuck-detector,
 * no idle timeout, no no-progress heuristic. Wall clock and dollars are
 * boundaries; everything else runs to completion.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BakeoffError, seatFor } from "./contracts.js";
import type {
  BakeoffRunner,
  HarnessIdentity,
  ModelSeat,
  RunRecord,
  RunRequest,
  RunStatus,
  SandboxSpec,
  VendorAdvisoryBudget,
} from "./contracts.js";
import { pricingBasisOf, resolvePrice } from "./contracts.js";
import { BUILDER_FORBIDDEN_PATH_PREFIXES } from "./config.js";
import { ticketDigestMatches } from "./hash.js";
import { sha256Hex } from "./hash.js";
import {
  KillSwitch,
  PERSIST_REDACT_OPTIONS,
  PROXY_AUTH_TOKEN_ENV_NAME,
  RunLedger,
  runStatusForKill,
} from "./ledger.js";
import { BudgetProxy, generateProxyAuthToken } from "./proxy.js";
import type { ProxySeatRoute } from "./proxy.js";
import { ReassemblingRedactor, redactForPersistence } from "./redact.js";
import { suiteRootFor } from "./spec-freeze.js";
import { VISIBILITY_DIRNAME } from "./spec-types.js";
// The one port named in the builder prompt. Imported, not retyped: a builder
// told one port while the scorer probes another fails a boot gate for a reason
// that exists in neither program.
import { STATIC_SERVE_PORT } from "./scorer-protocol.js";

/* -------------------------------------------------------------------------
 * Layout inside the container and the workspace
 * ---------------------------------------------------------------------- */

/**
 * Paths the harness controls inside the sandbox.
 *
 * THE WRITABLE MOUNT IS NOT NESTED INSIDE THE READ-ONLY ONE. `/bakeoff` is
 * mounted read-only, and Docker creates a mountpoint by mkdir-ing it in the
 * target filesystem — so a read-write mount at `/bakeoff/out` fails with
 * "read-only file system" before the container ever starts. The output
 * directory therefore lives under `/run/bakeoff`, on the container's own
 * writable layer. Measured, not assumed: this exact invocation failed with
 * `mkdirat ... read-only file system` on Docker 29.4.0.
 */
export const CONTAINER = Object.freeze({
  workspace: "/workspace",
  harnessRoot: "/bakeoff",
  outDir: "/run/bakeoff/out",
  entrypoint: "/bakeoff/entrypoint.sh",
  /** Port the relay sidecar listens on, inside the sealed network. */
  relayPort: 8787,
});

/** Files the harness writes into, or reads out of, the builder's workspace. */
export const WORKSPACE = Object.freeze({
  /** The ticket brief, verbatim. The only thing the builder is told. */
  ticketFile: "TICKET.md",
  /**
   * The VISIBLE acceptance subset. Deliberately NOT named `acceptance/`:
   * that prefix is forbidden to the builder, and a visible copy living there
   * would make the forbidden-path assertion fire on every run.
   */
  visibleDir: "visible-acceptance",
  /** The builder's structured completion signal. */
  selfReport: ".bakeoff/self-report.json",
});

/** Status values the builder may write. Anything else is not a declaration. */
export type SelfReportStatus = "done" | "blocked" | "incomplete";

export interface SelfReport {
  readonly status: SelfReportStatus;
  readonly reason: string;
}

/* -------------------------------------------------------------------------
 * The builder command
 * ---------------------------------------------------------------------- */

/**
 * The argv the sandbox runs, and its digest.
 *
 * HELD-CONSTANT VARIABLE 2 IS "one harness, ours, for every configuration".
 * That is only true if every configuration runs the SAME command, so the argv
 * template is digested and the digest is written into every run's artefacts;
 * `report` refuses to compare runs whose digests differ. Only the environment
 * varies between configurations, and only in the model aliases and the proxy
 * address.
 *
 * The default targets the Claude Code CLI in headless mode. It is a DEFAULT,
 * not a verified fact about the pinned image: the flags below were read from
 * `claude --help` on CLI 2.1.220, and the image's own version must be confirmed
 * before the first spend. Override it if the image ships a different runtime.
 */
export interface BuilderCommandSpec {
  /**
   * Placeholders substituted at run time:
   *   {{PROMPT_FILE}} path of the prompt file inside the container
   *   {{MODEL}}       orchestrator model alias
   *   {{EFFORT}}      orchestrator effort rung
   *   {{MAX_BUDGET}}  advisory vendor budget in USD
   */
  readonly argv: readonly string[];
  readonly notes: string;
}

export const DEFAULT_BUILDER_COMMAND: BuilderCommandSpec = Object.freeze({
  argv: Object.freeze([
    "claude",
    "--print",
    "--model",
    "{{MODEL}}",
    "--effort",
    "{{EFFORT}}",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--max-budget-usd",
    "{{MAX_BUDGET}}",
  ]) as readonly string[],
  notes:
    "Flags read from `claude --help` on Claude Code CLI 2.1.220. " +
    "--dangerously-skip-permissions is safe here and nowhere else: the container has no network " +
    "route and no credential. --max-budget-usd is ADVISORY and is recorded as a " +
    "VendorAdvisoryBudget, never trusted — Anthropic's own docs say Claude may exceed a budget " +
    "mid-action, and Moonshot and DeepSeek have no budget primitive at all. The out-of-process " +
    "ceiling in the budget proxy is the only real control.",
});

export function builderCommandDigest(spec: BuilderCommandSpec): string {
  return sha256Hex(spec.argv.join("\u0000"));
}

/* -------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------- */

export interface DockerRunnerOptions {
  readonly harness: HarnessIdentity;
  readonly sandbox: SandboxSpec;
  /** Shared campaign directory: the kill sentinel and the spend log live here. */
  readonly campaignDir: string;
  readonly killSwitch: KillSwitch;
  /** "screen" or "finals". Tags every call record (doc 04 section 9.1). */
  readonly phase: string;
  /**
   * Root of the sealed acceptance suites, e.g. `<repo>/acceptance`. Used ONLY
   * to locate the visible subset and to prove containment. The holdout half is
   * never opened, listed or mounted.
   */
  readonly acceptanceRoot: string;
  readonly builderCommand?: BuilderCommandSpec;
  readonly env?: NodeJS.ProcessEnv;
  /** `docker` binary. Overridable for a pinned client. */
  readonly dockerBin?: string;
  /** `git` binary. */
  readonly gitBin?: string;
}

/** Extra detail about one attempt, written beside the run record. */
export interface RunnerOutcome {
  readonly runId: string;
  readonly containerExitCode: number | null;
  readonly containerSignal: string | null;
  readonly builderCommandDigest: string;
  readonly builderArgv: readonly string[];
  readonly sealProbe: SealProbeResult | null;
  readonly proxyRequests: number;
  readonly proxyDenied: number;
  readonly proxyUncosted: number;
  readonly selfReport: SelfReport | null;
  readonly forbiddenPathViolations: readonly string[];
}

/** What the in-container probe reported. */
export interface SealProbeResult {
  /** True when egress to the public internet FAILED, which is what we want. */
  readonly egressDenied: boolean;
  /** True when the budget proxy was reachable through the bridge. */
  readonly proxyReachable: boolean;
  readonly detail: string;
}

/* -------------------------------------------------------------------------
 * Generated sandbox files
 * ---------------------------------------------------------------------- */

/**
 * THE RELAY SIDECAR — the builder's only route out, and the reason the seal
 * holds on a developer machine.
 *
 * TOPOLOGY, ARRIVED AT BY MEASUREMENT RATHER THAN BY DESIGN TASTE:
 *
 *   builder  --[per-run `--internal` docker network, no route to anywhere]-->  relay
 *   relay    --[default bridge]-->  host  -->  budget proxy  -->  vendor
 *
 * Three topologies were tried on Docker 29.4.0 / Docker Desktop for macOS:
 *   - `--network none` plus a bind-mounted UNIX SOCKET: the seal held (1.1.1.1
 *     ENETUNREACH, DNS EAI_AGAIN) but the container could not CONNECT to a host
 *     socket through the file-sharing layer. The forwarder accepted and then
 *     read zero bytes. Rejected on evidence.
 *   - a normal bridge network plus `host.docker.internal`: reachable, but the
 *     container also has full internet, so the seal probe correctly refuses.
 *   - THIS ONE: `docker network create --internal` measured as ENETUNREACH for
 *     1.1.1.1 and EAI_AGAIN for DNS, while docker's embedded DNS still resolves
 *     container names on the network. The relay is attached to that network AND
 *     to the default bridge, which is what gives it — and only it — a way out.
 *
 * The relay runs the SAME PINNED IMAGE as the builder, so it introduces no
 * second image to hold constant. It forwards bytes and holds no credential: the
 * key stays in the supervisor process on the host, and the builder holds only a
 * random per-run token.
 */
const RELAY_SCRIPT = `const { createServer, connect } = require("node:net");
const PORT = Number(process.env.BAKEOFF_RELAY_PORT);
const HOST_PORT = Number(process.env.BAKEOFF_HOST_PORT);
const HOST = process.env.BAKEOFF_HOST_NAME;
createServer((client) => {
  const upstream = connect(HOST_PORT, HOST);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(PORT, "0.0.0.0", () => console.error("relay: listening on " + PORT));`;

/**
 * The seal probe, run inside the container before the builder starts.
 *
 * Two assertions, both required:
 *   - egress to a public address must FAIL. Held-constant variable 3 says the
 *     sandbox is sealed: no upstream repos, no package registry except a
 *     pinned mirror, no issue trackers. A run with egress measures a different
 *     experiment from one without, and the difference Cursor measured is
 *     14.1-20.7pp — several times the model gap this bake-off is detecting.
 *   - the budget proxy must be REACHABLE. A sealed sandbox that cannot reach
 *     the proxy produces a zero-cost run that looks like a fast failure.
 *
 * Probing DNS and a raw IP separately matters: a container can have a resolver
 * and no route, or a route and no resolver, and only one of those is a seal.
 */
const PROBE_SCRIPT = `// generated by bakeoff runner. Do not edit.
import { writeFileSync } from "node:fs";
const OUT = process.env.BAKEOFF_PROBE_OUT;
const RELAY = process.env.BAKEOFF_RELAY_URL;
const notes = [];
async function reach(url, timeoutMs) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (error) {
    // A refused connection and a 404 are both "the network works". Only a
    // transport-level failure counts as unreachable.
    const code = error?.cause?.code ?? error?.code ?? "";
    return !(code === "ENETUNREACH" || code === "EAI_AGAIN" || code === "ENOTFOUND" ||
             code === "ECONNREFUSED" || code === "ETIMEDOUT" || error?.name === "TimeoutError");
  }
}
const publicIp = await reach("http://1.1.1.1/", 5000);
notes.push("http 1.1.1.1 " + (publicIp ? "REACHED" : "unreachable"));
const dnsEgress = await reach("https://registry.npmjs.org/", 5000);
notes.push("https registry.npmjs.org " + (dnsEgress ? "RESOLVED AND REACHED" : "unreachable"));

// The relay must lead to THIS harness's budget proxy, and to nothing else.
// "Something answered" is not the property being asserted: a stale relay from
// an earlier run, a port collision or a hijacked destination would all satisfy
// it. So the probe sends a DELIBERATELY UNAUTHENTICATED request and requires
// the proxy's own 401 plus its identity header. That costs nothing — the proxy
// rejects it before reading a body — and it proves two things at once: the
// route ends at our proxy, and the proxy's authentication is actually on.
let proxyReachable = false;
try {
  const res = await fetch(RELAY + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  const identity = res.headers.get("x-bakeoff-proxy");
  proxyReachable = res.status === 401 && identity === "1";
  notes.push("relay -> proxy: status " + res.status + ", identity " + (identity ?? "absent"));
} catch (error) {
  notes.push("relay -> proxy: " + (error?.cause?.code ?? error?.name ?? "failed"));
}
const result = {
  egressDenied: !publicIp && !dnsEgress,
  proxyReachable,
  detail: notes.join("; "),
};
writeFileSync(OUT, JSON.stringify(result));
process.exit(result.egressDenied && result.proxyReachable ? 0 : 3);
`;

function entrypointScript(argv: readonly string[], promptPath: string): string {
  const quoted = argv.map(shellQuote).join(" ");
  // `set -e` on the probe only: a non-zero exit from the BUILDER is a model
  // outcome and must be reported, not turned into a shell failure.
  return `#!/bin/sh
# generated by bakeoff runner. Do not edit.
set -e
node ${CONTAINER.harnessRoot}/probe.mjs
set +e
cd ${CONTAINER.workspace}
${quoted} < ${promptPath}
exit $?
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* -------------------------------------------------------------------------
 * The builder prompt
 * ---------------------------------------------------------------------- */

/**
 * The prompt, identical in every configuration except for the ticket text.
 *
 * TWO THINGS IT DOES NOT SAY, DELIBERATELY:
 *
 *  - It contains no anti-cheating scolding. Anthropic measured that framing
 *    ("only dangerously misaligned AIs would hack") produced HIGHER
 *    misalignment than neutral framing (doc 02 section 5.6). The defence
 *    against test tampering is filesystem reality and a diff gate, not a
 *    sentence in a prompt.
 *  - It never mentions a held-out suite's contents, location or existence
 *    beyond the fact that acceptance is judged elsewhere. Telling the builder
 *    what is being measured is the leak the sealed gate exists to prevent.
 *
 * It DOES describe the self-report contract, because a structured completion
 * signal has to be specified to be produced, and because BLOCKED is a
 * first-class outcome worth making easy to choose (doc 03 section 8.3).
 */
export function builderPrompt(ticketBrief: string): string {
  return [
    "You are building a complete, working implementation of the ticket below.",
    "",
    "WORKING AGREEMENT",
    `- Your workspace is ${CONTAINER.workspace}. Everything you build lives there.`,
    "- The sandbox has no network access. Work with what is installed.",
    `- The ticket text is also at ${WORKSPACE.ticketFile}.`,
    `- If a directory named ${WORKSPACE.visibleDir}/ exists, it holds a SUBSET of the acceptance`,
    "  tests, provided so you have a real feedback signal. Run them as often as you like.",
    "  Passing them is necessary and not sufficient: acceptance is judged separately, by tests",
    "  you have not seen, executed elsewhere against your final workspace.",
    "",
    "SHIP THE SIMPLEST THING THE TICKET ACTUALLY ASKS FOR",
    "- If the ticket needs no server-side behaviour, plain HTML and CSS is a COMPLETE answer.",
    "  You are not expected to add a server, a framework or a build step to prove effort, and",
    "  you are not penalised for leaving them out.",
    `- Put the entry document at the root of ${CONTAINER.workspace}, named index.html, so the`,
    "  site is openable as it stands. Reference assets by relative path.",
    `- If the ticket DOES need a server, start it on port ${String(STATIC_SERVE_PORT)} and bind`,
    '  127.0.0.1 or 0.0.0.0 — never "localhost" only.',
    "",
    "WHEN YOU FINISH, OR WHEN YOU CANNOT",
    `Write ${WORKSPACE.selfReport} with exactly this shape:`,
    '  {"status": "done" | "blocked" | "incomplete", "reason": "<one or two sentences>"}',
    "",
    '- "done"       you believe the ticket is fully implemented.',
    '- "blocked"    something outside your control stops you. Say what. Partial work with an',
    "               honest blocked status is a better outcome than a confident false finish,",
    "               and it is recorded as such.",
    '- "incomplete" you ran out of room but were still making progress.',
    "",
    "This file is your report about yourself. It is recorded. It does not grade your work.",
    "",
    "THE TICKET",
    "",
    ticketBrief,
  ].join("\n");
}

/* -------------------------------------------------------------------------
 * The runner
 * ---------------------------------------------------------------------- */

export class DockerRunner implements BakeoffRunner {
  readonly harness: HarnessIdentity;
  readonly #options: DockerRunnerOptions;

  constructor(options: DockerRunnerOptions) {
    this.#options = options;
    this.harness = options.harness;
  }

  async run(request: RunRequest): Promise<RunRecord> {
    const options = this.#options;
    const env = options.env ?? process.env;
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const command = options.builderCommand ?? DEFAULT_BUILDER_COMMAND;

    const orchestrator = seatFor(request.config, "orchestrator");
    const subagent = seatFor(request.config, "subagent");

    assertTicketIntegrity(request);
    assertSandboxSealed(options.sandbox);
    assertPathsDisjoint(request.workspaceDir, options.acceptanceRoot);

    mkdirSync(request.resultsDir, { recursive: true });
    const sandboxDir = join(request.resultsDir, "sandbox");
    const outDir = join(request.resultsDir, "container-out");
    const socketDir = join(request.resultsDir, "sock");
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });

    const ledger = RunLedger.open({
      runId: request.runId,
      ticketId: request.ticket.id,
      configId: request.config.id,
      repeatIndex: request.repeatIndex,
      phase: options.phase,
      budget: request.budget,
      heldConstants: request.heldConstants,
      runResultsDir: request.resultsDir,
      campaignDir: options.campaignDir,
      startedAt,
      killSwitch: options.killSwitch,
    });

    const logPath = join(request.resultsDir, "run.log");
    writeFileSync(logPath, "", { encoding: "utf8" });

    let proxy: BudgetProxy | null = null;
    let containerExitCode: number | null = null;
    let containerSignal: string | null = null;
    let sealProbe: SealProbeResult | null = null;
    let selfReport: SelfReport | null = null;
    let forbiddenViolations: readonly string[] = [];
    let terminalStatus: RunStatus = "error";

    try {
      // ---- workspace ---------------------------------------------------
      this.#prepareWorkspace(request);
      forbiddenViolations = this.#forbiddenPathViolations(request.workspaceDir);
      if (forbiddenViolations.length > 0) {
        throw new BakeoffError(
          "suite_hash_mismatch",
          `the workspace for run ${request.runId} contains forbidden path(s) before the build: ` +
            forbiddenViolations.join(", "),
          "The builder must have no path to the acceptance suite. Remove it from the workspace " +
            "template and re-run: a build that can read the suite measures nothing.",
        );
      }

      // ---- proxy -------------------------------------------------------
      const authToken = generateProxyAuthToken();
      // The token is a secret. Registering it in the supervisor's environment
      // under a known NAME is what makes the redaction chokepoint scrub it from
      // every log and artefact; the value itself is never written to disk.
      const childEnv: NodeJS.ProcessEnv = { ...env, [PROXY_AUTH_TOKEN_ENV_NAME]: authToken };
      process.env[PROXY_AUTH_TOKEN_ENV_NAME] = authToken;

      // Bound to the loopback interface: the relay reaches it through Docker
      // Desktop's host gateway, and nothing off this machine can.
      proxy = await BudgetProxy.start({
        ledger,
        routes: proxyRoutes(orchestrator, subagent),
        authToken,
        env,
        host: "127.0.0.1",
        port: 0,
      });

      // ---- sandbox files ----------------------------------------------
      writeFileSync(join(sandboxDir, "prompt.txt"), builderPrompt(request.ticket.brief), {
        encoding: "utf8",
      });
      writeFileSync(join(sandboxDir, "probe.mjs"), PROBE_SCRIPT, { encoding: "utf8" });
      const argv = substituteArgv(command.argv, {
        MODEL: modelAliasFor(orchestrator),
        EFFORT: orchestrator.effort,
        MAX_BUDGET: request.budget.maxCostUsd.toFixed(2),
        PROMPT_FILE: `${CONTAINER.harnessRoot}/prompt.txt`,
      });
      writeFileSync(
        join(sandboxDir, "entrypoint.sh"),
        entrypointScript(argv, `${CONTAINER.harnessRoot}/prompt.txt`),
        { encoding: "utf8", mode: 0o755 },
      );

      // ---- container ---------------------------------------------------
      const result = await this.#runContainer({
        request,
        sandboxDir,
        outDir,
        proxyPort: proxy.port,
        orchestrator,
        subagent,
        authToken,
        childEnv,
        logPath,
        ledger,
        startedAtMs,
      });
      containerExitCode = result.exitCode;
      containerSignal = result.signal;
      sealProbe = readSealProbe(outDir);

      // NO PROBE AT ALL IS AN INFRASTRUCTURE FAILURE, NOT A MODEL RESULT.
      // The probe runs before the builder, so its absence means the container
      // never got that far — a bad mount, a missing image, no `node` in the
      // image, `docker` itself refusing. Recording that as a completed attempt
      // would put a harness fault in the denominator and charge it to whichever
      // configuration happened to hit it. Docker reserves 125/126/127 for its
      // own failures, which is reported here as corroborating detail rather
      // than relied on.
      if (sealProbe === null) {
        const dockerLevel =
          containerExitCode !== null && containerExitCode >= 125 && containerExitCode <= 127;
        throw new BakeoffError(
          "invalid_usage_shape",
          `the sandbox never reached the seal probe for run ${request.runId} ` +
            `(container exit ${containerExitCode ?? "none"}${containerSignal === null ? "" : `, signal ${containerSignal}`}` +
            `${dockerLevel ? ", a docker-level failure" : ""}). ` +
            "No build was attempted.",
          "Read the run log: this is a harness or image fault, not a model outcome, and it is " +
            "recorded as status=error so it stays out of every rate denominator. Check that the " +
            "image exists locally at the pinned digest, that it contains `node` and `/bin/sh`, and " +
            "that the mounts are accepted.",
        );
      }

      if (!(sealProbe.egressDenied && sealProbe.proxyReachable)) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `the sandbox seal probe failed for run ${request.runId}: ${sealProbe.detail}`,
          "Held-constant variable 3 requires an identical, SEALED sandbox for every run. Egress " +
            "reachable means this run is not comparable to any other — Cursor measured 14.1-20.7pp " +
            "of apparent quality evaporating when exactly this was sealed. Fix the container " +
            "network configuration (`--network none` plus the proxy socket mount) and re-run. Do " +
            "not score this attempt.",
        );
      }

      // ---- what the builder said about itself --------------------------
      selfReport = readSelfReport(request.workspaceDir);
      if (selfReport !== null) {
        if (selfReport.status === "done") {
          ledger.recordAgentDeclaredDone(join(request.workspaceDir, WORKSPACE.selfReport));
        } else if (selfReport.status === "blocked") {
          ledger.recordAgentBlocked(selfReport.reason);
        }
      }

      // ---- the seal, proved after the fact -----------------------------
      forbiddenViolations = [
        ...this.#forbiddenPathViolations(request.workspaceDir),
        ...this.#gitHistoryViolations(request.workspaceDir),
      ];
      for (const violation of forbiddenViolations) {
        ledger.recordHarnessError(`forbidden path reachable from the workspace: ${violation}`);
      }

      terminalStatus = this.#terminalStatus(ledger, selfReport);
    } catch (error) {
      const message = error instanceof BakeoffError ? error.message : String(error);
      ledger.recordHarnessError(message);
      ledger.kill("infrastructure_failure", message);
      terminalStatus = "error";
    } finally {
      if (proxy !== null) {
        try {
          await proxy.stop();
        } catch {
          /* the run is already ending; a failed close must not mask the result */
        }
      }
      delete process.env[PROXY_AUTH_TOKEN_ENV_NAME];
    }

    const endedAt = new Date().toISOString();
    const usage = ledger.usageRows();
    const record: RunRecord = {
      schemaVersion: 1,
      runId: request.runId,
      ticketId: request.ticket.id,
      ticketSha256: request.ticket.sha256,
      configId: request.config.id,
      repeatIndex: request.repeatIndex,
      startedAt,
      endedAt,
      wallClockMs: Date.now() - startedAtMs,
      status: terminalStatus,
      killReason: ledger.killSignal()?.reason ?? null,
      agentDeclaredDone: ledger.agentDeclaredDone(),
      selfReportPath: ledger.selfReportPath(),
      usage,
      totalCostUsd: ledger.totalCostUsd(),
      pricingBasis: usage.map((row) =>
        pricingBasisOf(resolvePrice(row.provider, row.modelId, startedAt), startedAt),
      ),
      seats: request.config.seats,
      heldConstants: request.heldConstants,
      budget: {
        ...request.budget,
        vendorAdvisoryBudgets: advisoryBudgetsFor(request.budget.maxCostUsd, orchestrator, subagent),
      },
      artifactPath: request.workspaceDir,
      logPath,
      ledgerPath: ledger.layout.runEventsPath,
      harnessErrors: ledger.harnessErrors(),
    };

    ledger.close(terminalStatus);

    const outcome: RunnerOutcome = {
      runId: request.runId,
      containerExitCode,
      containerSignal,
      builderCommandDigest: builderCommandDigest(command),
      builderArgv: command.argv,
      sealProbe,
      proxyRequests: proxy?.stats().requests ?? 0,
      proxyDenied: proxy?.stats().denied ?? 0,
      proxyUncosted: proxy?.stats().uncosted ?? 0,
      selfReport,
      forbiddenPathViolations: forbiddenViolations,
    };

    // `run.jsonl` (one line) is what the reporter collects; `runner-outcome.json`
    // is harness detail the reporter does not consume, so it deliberately does
    // not carry a `.jsonl` extension.
    writeJsonLine(join(request.resultsDir, "run.jsonl"), record);
    writeJson(join(request.resultsDir, "runner-outcome.json"), outcome);
    return record;
  }

  /* ---------------------------------------------------------------------
   * Workspace
   * ------------------------------------------------------------------ */

  #prepareWorkspace(request: RunRequest): void {
    const { workspaceDir } = request;
    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir, { recursive: true });

    writeFileSync(join(workspaceDir, WORKSPACE.ticketFile), request.ticket.brief, {
      encoding: "utf8",
    });

    const visibleSource = this.visibleSubsetDir(request.ticket.id);
    if (visibleSource !== null) {
      cpSync(visibleSource, join(workspaceDir, WORKSPACE.visibleDir), { recursive: true });
    }

    const git = this.#options.gitBin ?? "git";
    const run = (args: readonly string[]): void => {
      execFileSync(git, [...args], { cwd: workspaceDir, stdio: "pipe" });
    };
    run(["init", "--quiet"]);
    run(["config", "user.email", "harness@bakeoff.invalid"]);
    run(["config", "user.name", "bakeoff harness"]);
    run(["add", "-A"]);
    run(["commit", "--quiet", "--allow-empty", "-m", "bakeoff: workspace baseline"]);
  }

  /**
   * The VISIBLE half of the suite for a ticket, or null when none exists.
   *
   * The holdout half sits beside it and is never touched. This method resolves
   * exactly one directory name and never lists the ticket's suite root, so the
   * harness cannot accidentally enumerate what it must not see.
   */
  visibleSubsetDir(ticketId: string): string | null {
    // Derived from the ONE definition of the acceptance layout (spec-freeze /
    // spec-types), not re-spelled here. A second spelling of a sealed path is
    // how a builder ends up with a directory the seal does not know about.
    const candidate = join(
      suiteRootFor(ticketId, this.#options.acceptanceRoot),
      VISIBILITY_DIRNAME.visible,
    );
    if (!existsSync(candidate)) return null;
    if (!statSync(candidate).isDirectory()) return null;
    return candidate;
  }

  /** Any path in the working tree under a forbidden prefix. */
  #forbiddenPathViolations(workspaceDir: string): readonly string[] {
    const violations: string[] = [];
    for (const prefix of BUILDER_FORBIDDEN_PATH_PREFIXES) {
      const target = join(workspaceDir, prefix);
      if (existsSync(target)) violations.push(prefix);
    }
    // A forbidden prefix can also appear nested. Walk once, shallowly enough to
    // stay cheap on a large workspace but deep enough to catch a copy.
    walkShallow(workspaceDir, 6, (relPath) => {
      const posix = relPath.split(sep).join("/");
      for (const prefix of BUILDER_FORBIDDEN_PATH_PREFIXES) {
        if (posix === prefix.replace(/\/$/, "") || posix.startsWith(prefix)) {
          if (!violations.includes(posix)) violations.push(posix);
        }
      }
    });
    return violations;
  }

  /**
   * Any forbidden path that ever existed in git history.
   *
   * A builder that copied the suite in, read it and deleted it leaves a clean
   * working tree and a dirty object store. The scorer additionally runs with no
   * access to workspace history, so this check is about detecting the leak, not
   * containing it.
   */
  #gitHistoryViolations(workspaceDir: string): readonly string[] {
    const git = this.#options.gitBin ?? "git";
    let output: string;
    try {
      output = execFileSync(git, ["log", "--all", "--name-only", "--pretty=format:"], {
        cwd: workspaceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return [];
    }
    const violations: string[] = [];
    for (const line of output.split("\n")) {
      const path = line.trim();
      if (path.length === 0) continue;
      for (const prefix of BUILDER_FORBIDDEN_PATH_PREFIXES) {
        if (path.startsWith(prefix) && !violations.includes(`git-history:${path}`)) {
          violations.push(`git-history:${path}`);
        }
      }
    }
    return violations;
  }

  /* ---------------------------------------------------------------------
   * Container
   * ------------------------------------------------------------------ */

  async #runContainer(input: {
    readonly request: RunRequest;
    readonly sandboxDir: string;
    readonly outDir: string;
    /** Host TCP port the budget proxy listens on. Reached via the relay. */
    readonly proxyPort: number;
    readonly orchestrator: ModelSeat;
    readonly subagent: ModelSeat;
    readonly authToken: string;
    readonly childEnv: NodeJS.ProcessEnv;
    readonly logPath: string;
    readonly ledger: RunLedger;
    readonly startedAtMs: number;
  }): Promise<{ exitCode: number | null; signal: string | null }> {
    const { request, ledger } = input;
    const docker = this.#options.dockerBin ?? "docker";
    const slug = request.runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
    const containerName = `bakeoff-${slug}`;
    const relayName = `bakeoff-relay-${slug}`;
    const networkName = `bakeoff-net-${slug}`;
    const image = imageReference(this.#options.sandbox);
    const relayUrl = `http://${relayName}:${CONTAINER.relayPort}`;

    const dockerSync = (dockerArgs: readonly string[]): void => {
      execFileSync(docker, [...dockerArgs], { stdio: ["ignore", "pipe", "pipe"] });
    };
    const dockerQuiet = (dockerArgs: readonly string[]): void => {
      try {
        dockerSync(dockerArgs);
      } catch {
        /* teardown is best effort and must never mask a run's result */
      }
    };

    // ---- the sealed network + the relay --------------------------------
    // Torn down together on any failure: a leaked `--internal` network and a
    // leaked relay would be inherited by the next run of the same id, and an
    // inherited network is a held-constant variable that quietly stopped being
    // constant.
    dockerQuiet(["network", "rm", networkName]);
    dockerQuiet(["rm", "-f", relayName]);
    try {
      dockerSync(["network", "create", "--internal", networkName]);
      dockerSync([
        "run",
        "-d",
        "--name",
        relayName,
        "--network",
        networkName,
        "-e",
        `BAKEOFF_RELAY_PORT=${CONTAINER.relayPort}`,
        "-e",
        `BAKEOFF_HOST_PORT=${input.proxyPort}`,
        "-e",
        "BAKEOFF_HOST_NAME=host.docker.internal",
        // Docker Desktop provides host.docker.internal; native Linux does not,
        // and needs this mapping. VERIFIED ON macOS / Docker Desktop 29.4.0
        // ONLY. On native Linux `host-gateway` resolves to the docker0 bridge
        // address, which a proxy bound to 127.0.0.1 does NOT answer on — bind
        // the proxy to the bridge address there, and do not simply widen it to
        // 0.0.0.0, which would expose the run's spend endpoint to the network.
        "--add-host=host.docker.internal:host-gateway",
        "--entrypoint",
        "node",
        image,
        "-e",
        RELAY_SCRIPT,
      ]);
      // The relay needs a way OUT, which the internal network deliberately does
      // not have. Attaching it to the default bridge as well makes it — and only
      // it — able to reach the host. The builder never joins that network.
      dockerSync(["network", "connect", "bridge", relayName]);
    } catch (error) {
      dockerQuiet(["rm", "-f", relayName]);
      dockerQuiet(["network", "rm", networkName]);
      throw new BakeoffError(
        "invalid_usage_shape",
        `could not stand up the sealed network for run ${request.runId}: ` +
          (error instanceof Error ? error.message : String(error)),
        "The builder runs on a per-run `docker network create --internal` network with a relay " +
          "sidecar as its only route out. Check that the docker daemon is running, that the " +
          "pinned image exists locally, and that no container or network is left over from a " +
          "previous run of the same id.",
      );
    }

    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      // THE SEAL: an `--internal` network. Measured on Docker 29.4.0 as
      // ENETUNREACH to a public address and EAI_AGAIN for external DNS, while
      // container-name resolution still works. The probe below re-verifies it
      // from inside the container on every single run, because a seal that is
      // assumed rather than checked is how 14.1-20.7pp of apparent quality
      // walks back in.
      "--network",
      networkName,
      "--workdir",
      CONTAINER.workspace,
      "-v",
      `${resolve(request.workspaceDir)}:${CONTAINER.workspace}`,
      "-v",
      `${resolve(input.outDir)}:${CONTAINER.outDir}`,
      "-v",
      `${resolve(input.sandboxDir)}:${CONTAINER.harnessRoot}:ro`,
      "-e",
      `ANTHROPIC_BASE_URL=${relayUrl}`,
      // The sandbox holds a random per-run token, never a vendor credential.
      // The real key is injected by the budget proxy, in the supervisor process.
      "-e",
      `ANTHROPIC_AUTH_TOKEN=${input.authToken}`,
      "-e",
      `ANTHROPIC_API_KEY=${input.authToken}`,
      "-e",
      `ANTHROPIC_MODEL=${modelAliasFor(input.orchestrator)}`,
      "-e",
      `CLAUDE_CODE_SUBAGENT_MODEL=${modelAliasFor(input.subagent)}`,
      "-e",
      `BAKEOFF_RELAY_URL=${relayUrl}`,
      "-e",
      `BAKEOFF_PROBE_OUT=${CONTAINER.outDir}/probe.json`,
      "--entrypoint",
      "/bin/sh",
      image,
      CONTAINER.entrypoint,
    ];

    // The argv is recorded so a reader can reconstruct the invocation without
    // this source tree. The auth token inside it is scrubbed by the redaction
    // chokepoint, which knows the token by its environment variable NAME.
    writeJson(join(request.resultsDir, "docker-argv.json"), { docker, args });

    return await new Promise<{ exitCode: number | null; signal: string | null }>((resolvePromise) => {
      const child = spawn(docker, args, {
        env: input.childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Container output is streamed through the reassembling redactor: a regex
      // applied per chunk cannot match a credential split across two reads.
      const redactor = new ReassemblingRedactor(PERSIST_REDACT_OPTIONS);
      const appendLog = (text: string): void => {
        if (text.length > 0) {
          writeFileSync(input.logPath, text, { encoding: "utf8", flag: "a" });
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        appendLog(redactor.write(chunk));
      });
      child.stderr.on("data", (chunk: string) => {
        appendLog(redactor.write(chunk));
      });

      let settled = false;
      const stopContainer = (): void => {
        try {
          execFileSync(docker, ["kill", containerName], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      };

      // WALL CLOCK: a boundary, not a progress judgement. 79% of unresolved
      // long-horizon runs are still actively working when they hit one.
      const remainingMs = request.budget.maxWallClockMs - (Date.now() - input.startedAtMs);
      const wallClockTimer = setTimeout(
        () => {
          ledger.kill(
            "wall_clock_ceiling",
            `wall-clock ceiling of ${Math.round(request.budget.maxWallClockMs / 1000)}s reached`,
          );
          stopContainer();
        },
        Math.max(remainingMs, 1),
      );

      // The kill switch is polled rather than pushed so that a sentinel written
      // by ANOTHER process — or by a human with nothing but a shell — stops this
      // container too.
      const killPoll = setInterval(() => {
        const engaged = ledger.killSignal() ?? this.#options.killSwitch.engaged();
        if (engaged === null) return;
        ledger.kill(engaged.reason, engaged.detail);
        stopContainer();
      }, 1000);

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(wallClockTimer);
        clearInterval(killPoll);
        appendLog(redactor.finish());
        // Teardown. The relay's own log is captured first: "relay upstream:
        // ECONNREFUSED" is the difference between a broken harness and a
        // model that did nothing, and it is invisible from the builder's side.
        try {
          const relayLog = execFileSync(docker, ["logs", relayName], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          if (relayLog.trim().length > 0) appendLog(`\n[relay] ${relayLog.trim()}\n`);
        } catch {
          /* the relay may already be gone */
        }
        dockerQuiet(["rm", "-f", relayName]);
        dockerQuiet(["network", "rm", networkName]);
        if (redactor.forcedFlushes() > 0) {
          ledger.recordHarnessError(
            `the log redactor forced ${redactor.forcedFlushes()} flush(es) with no safe cut point; ` +
              "treat this run's logs as suspect",
          );
        }
        resolvePromise({ exitCode, signal });
      };

      child.on("error", (error) => {
        ledger.recordHarnessError(`failed to start the sandbox: ${error.message}`);
        finish(null, null);
      });
      child.on("close", (code, signal) => {
        finish(code, signal);
      });
    });
  }

  /**
   * Terminal status.
   *
   * A NON-ZERO EXIT CODE FROM THE BUILDER IS NOT AN ERROR STATUS. `error` means
   * a HARNESS or infrastructure failure and is excluded from the rate
   * denominators (doc 03 section 7.5); classifying a model that crashed as a
   * harness failure would quietly delete its worst results from the comparison.
   * Only a boundary, a blocked self-report, or a harness fault decides anything
   * here.
   */
  #terminalStatus(ledger: RunLedger, selfReport: SelfReport | null): RunStatus {
    const kill = ledger.killSignal();
    if (kill !== null) return runStatusForKill(kill.reason);
    if (selfReport !== null && selfReport.status === "blocked") return "blocked";
    return "completed";
  }
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/**
 * Routes for the two seats under test.
 *
 * The spec and judge seats are deliberately absent: they author and audit the
 * acceptance suite BEFORE any build run, in a different program, and no builder
 * may reach them. A route for either would be a path from the builder to the
 * agent that wrote its acceptance criteria.
 */
export function proxyRoutes(orchestrator: ModelSeat, subagent: ModelSeat): readonly ProxySeatRoute[] {
  return [
    { seat: orchestrator, requestModelPrefixes: ["claude-opus", "opus"] },
    { seat: subagent, requestModelPrefixes: ["claude-sonnet", "sonnet", "claude-haiku", "haiku"] },
  ];
}

/**
 * The alias the builder is told to ask for.
 *
 * Claude-shaped names, because the builder is a Claude-shaped client, and
 * because held-constant variable 2 requires every configuration to run the same
 * command. The proxy maps the alias to the seat and rewrites the model to the
 * vendor's real id, so a Kimi or DeepSeek seat is never reached under a Claude
 * name.
 */
export function modelAliasFor(seat: ModelSeat): string {
  return seat.role === "orchestrator" ? "claude-opus-4-5" : "claude-sonnet-4-5";
}

/**
 * Vendor task-budget parameters actually set, RECORDED AND NEVER TRUSTED.
 *
 * Only Claude Code's `--max-budget-usd` is set, and only on the orchestrator
 * invocation. Moonshot and DeepSeek have no budget primitive at all, which is
 * recorded here as the absence it is rather than being silently omitted.
 */
export function advisoryBudgetsFor(
  maxCostUsd: number,
  orchestrator: ModelSeat,
  subagent: ModelSeat,
): readonly VendorAdvisoryBudget[] {
  const budgets: VendorAdvisoryBudget[] = [
    {
      provider: orchestrator.provider,
      parameterName: "claude-code:--max-budget-usd",
      value: maxCostUsd.toFixed(2),
      enforced: false,
    },
  ];
  if (subagent.provider !== orchestrator.provider) {
    budgets.push({
      provider: subagent.provider,
      parameterName: "(none published)",
      value: "unavailable",
      enforced: false,
    });
  }
  return budgets;
}

function substituteArgv(
  argv: readonly string[],
  values: Readonly<Record<string, string>>,
): readonly string[] {
  return argv.map((token) =>
    token.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => values[name] ?? whole),
  );
}

/** `imageRef@digest`, unless the reference already pins a digest. */
export function imageReference(sandbox: SandboxSpec): string {
  return sandbox.imageRef.includes("@sha256:")
    ? sandbox.imageRef
    : `${sandbox.imageRef}@${sandbox.imageDigest}`;
}

function assertTicketIntegrity(request: RunRequest): void {
  if (!ticketDigestMatches(request.ticket.brief, request.ticket.sha256)) {
    throw new BakeoffError(
      "suite_hash_mismatch",
      `ticket ${request.ticket.id} does not match its recorded digest`,
      "The ticket text is frozen verbatim and never edited between runs (doc 03 section 7.1). " +
        "Restore the frozen brief or re-freeze deliberately — an edited ticket makes every earlier " +
        "run in the campaign incomparable.",
    );
  }
}

function assertSandboxSealed(sandbox: SandboxSpec): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(sandbox.imageDigest)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `sandbox image is not pinned by digest: "${sandbox.imageDigest}"`,
      "Pin the image by content digest. A moving tag silently varies held-constant variable 3 " +
        "between runs and invalidates every comparison in the bake-off.",
    );
  }
  if (sandbox.networkPolicy.egress !== "denied" && sandbox.networkPolicy.allowedHosts.length === 0) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `network policy claims "${sandbox.networkPolicy.egress}" but allows no hosts`,
      "State the policy the run actually enforces. This runner implements egress denial via " +
        "`--network none`; a pinned-mirror policy needs a mirror host and a different topology.",
    );
  }
}

/**
 * Neither directory may contain the other.
 *
 * A workspace inside the acceptance root would put the whole suite one `..`
 * away; an acceptance root inside the workspace would mount it outright.
 */
function assertPathsDisjoint(workspaceDir: string, acceptanceRoot: string): void {
  const workspace = resolve(workspaceDir);
  const acceptance = resolve(acceptanceRoot);
  if (contains(acceptance, workspace) || contains(workspace, acceptance)) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `the workspace (${workspace}) and the acceptance root (${acceptance}) are nested`,
      "Put the sealed suites outside every builder-visible path. A nested layout means the " +
        "builder is one relative path away from the tests it is being measured against.",
    );
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function walkShallow(root: string, maxDepth: number, visit: (relPath: string) => void): void {
  const stack: { dir: string; depth: number; rel: string }[] = [{ dir: root, depth: 0, rel: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > maxDepth) continue;
    let entries: readonly string[];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const rel = current.rel.length === 0 ? entry : `${current.rel}${sep}${entry}`;
      const abs = join(current.dir, entry);
      visit(rel);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) stack.push({ dir: abs, depth: current.depth + 1, rel });
    }
  }
}

/**
 * Read the builder's self-report.
 *
 * EXACTLY TWO FIELDS ARE READ: the status enum and the reason string. The
 * builder controls this file, so nothing score-shaped may be taken from it —
 * and nothing here is. An absent, malformed or unknown-status file is simply
 * not a declaration of completion, which is the safe reading: an agent that
 * cannot say it finished did not say it finished.
 */
export function readSelfReport(workspaceDir: string): SelfReport | null {
  const path = join(workspaceDir, WORKSPACE.selfReport);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const status = record["status"];
  if (status !== "done" && status !== "blocked" && status !== "incomplete") return null;
  const reason = record["reason"];
  return { status, reason: typeof reason === "string" ? reason.slice(0, 2000) : "" };
}

function readSealProbe(outDir: string): SealProbeResult | null {
  const path = join(outDir, "probe.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      egressDenied: parsed["egressDenied"] === true,
      proxyReachable: parsed["proxyReachable"] === true,
      detail: typeof parsed["detail"] === "string" ? parsed["detail"] : "",
    };
  } catch {
    return null;
  }
}

function writeJsonLine(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(redactForPersistence(value, PERSIST_REDACT_OPTIONS))}\n`, {
    encoding: "utf8",
  });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(redactForPersistence(value, PERSIST_REDACT_OPTIONS), null, 2)}\n`, {
    encoding: "utf8",
  });
}
