/**
 * dryrun.ts — exercise the whole pipeline for $0.
 *
 * WHY THIS EXISTS. The bake-off costs roughly $2,100. Every control it depends
 * on — the sealed gate, the pre-call ceiling, the redaction chokepoint, the
 * freeze — is a control that only matters if it actually fires, and none of
 * them fire until real money is moving. A harness whose seal is broken produces
 * a full, plausible, internally consistent set of numbers; that is precisely
 * the failure mode the protocol exists to prevent, and it is invisible in the
 * output. Nobody should spend $2,100 to discover the ceiling was checked after
 * the call instead of before it.
 *
 * WHAT IS STUBBED, AND ONLY THIS:
 *
 *   1. the MODEL RESPONSES — a local HTTP server speaking the Anthropic
 *      Messages API, returning canned content and canned usage counts;
 *   2. the BUILDER BINARY — a short node script instead of the Claude Code CLI;
 *   3. the SPEC SEAT's authoring call — a canned suite draft instead of an
 *      Opus 5 completion.
 *
 * EVERYTHING ELSE IS THE REAL THING. The real BudgetProxy, the real RunLedger
 * and its pre-call ceiling, the real price table, the real redactor, the real
 * deterministic bad-test audit, the real freeze and its digests, the real
 * DockerRunner and its `--internal` network, the real SealedScorerGate in its
 * `--network=none` container, the real aggregation and the real decision rule.
 * A dry run that short-circuited `verifySuiteIntact` or `assertSealedInvocation`
 * would validate the opposite of what the owner needs to know.
 *
 * THE OUTPUT IS NOT A RESULT. It is written to a separate root (default
 * `./dry-run`, a sibling of `./results`, so a plain `report` can never pick it
 * up) and every artefact carries a marker. The token counts are invented and
 * the dollar figures are arithmetic on invented counts.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

import { BAKEOFF_SCHEMA_VERSION, BakeoffError } from "./contracts.js";
import type { AcceptanceSuite, HeldConstants, ModelSeat, SandboxSpec, Ticket } from "./contracts.js";
import {
  DEFAULT_BUDGET,
  JUDGE_SEAT,
  SEALED_NETWORK_POLICY,
  SPEC_SEAT,
  getConfig,
  heldConstantsFor,
} from "./config.js";
import { acceptanceSuiteDigest, sha256Hex, ticketDigest } from "./hash.js";
import { KillSwitch, RunLedger } from "./ledger.js";
import { BudgetProxy } from "./proxy.js";
import { DockerRunner } from "./runner.js";
import { criteriaFromDraft, planFromDraft, testFileRefsFromDraft } from "./spec-types.js";
import { deterministicAudit } from "./spec-validate.js";
import { freezeSuite, verifySuiteIntact } from "./spec-freeze.js";
import { DEFAULT_ACCEPTANCE_ROOT } from "./spec-types.js";
import { formatScoringOutcome, scoreRuns } from "./score-run.js";
import { createGate } from "./gate.js";
import { writeReport } from "./report.js";
import { redactForPersistence } from "./redact.js";
import { PERSIST_REDACT_OPTIONS } from "./ledger.js";

/* -------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------- */

export interface DryRunContext {
  emit(text: string): void;
}

/** The marker that makes a dry-run tree impossible to mistake for a result. */
export const DRY_RUN_MARKER_FILENAME = "DRY-RUN-ONLY";
export const DRY_RUN_MARKER_TEXT =
  "THIS TREE IS A DRY RUN. Every token count in it was invented by a stub provider and every\n" +
  "dollar figure is arithmetic on an invented count. No vendor was called. No model was measured.\n" +
  "Nothing here may be quoted as a bake-off result. It exists to prove the HARNESS works.\n";

/**
 * A placeholder sandbox for the stages that never start a container.
 *
 * The digest is a literal zero digest, not a plausible-looking one: stage 2
 * never launches anything, and a realistic digest sitting in a HeldConstants
 * record would be a lie a reader could act on.
 */
const DRY_RUN_SANDBOX: SandboxSpec = Object.freeze({
  imageRef: "dry-run/no-container",
  imageDigest: `sha256:${"0".repeat(64)}`,
  networkPolicy: SEALED_NETWORK_POLICY,
});

/**
 * The placeholder credential the dry run uses, for every vendor.
 *
 * Deliberately not key-shaped: it is not a secret, it must never be mistaken
 * for one, and no credential-shaped literal belongs in this repository.
 *
 * IT REPLACES ANY REAL KEY IN THE SHELL. The proxy resolves credentials by
 * environment-variable NAME, so a dry run launched from a shell that happens to
 * hold a live key would otherwise hand that key to the stub upstream. Nothing
 * bad would follow — the stub is a local socket — but "the harness sent your
 * production key somewhere you did not intend" is not a sentence a dry run
 * should ever be able to produce. It also makes the leak assertions meaningful:
 * this exact string must not appear in any artefact.
 */
const DRY_RUN_PLACEHOLDER_CREDENTIAL = "DRY-RUN-PLACEHOLDER-NOT-A-CREDENTIAL";

/** An environment in which every vendor credential is the placeholder above. */
function dryRunEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: DRY_RUN_PLACEHOLDER_CREDENTIAL,
    MOONSHOT_API_KEY: DRY_RUN_PLACEHOLDER_CREDENTIAL,
    DEEPSEEK_API_KEY: DRY_RUN_PLACEHOLDER_CREDENTIAL,
    OPENAI_API_KEY: DRY_RUN_PLACEHOLDER_CREDENTIAL,
  };
}

/**
 * Remove a tree that the freeze has deliberately made read-only.
 *
 * `freezeSuite` chmods suite files to 0444 and the directories that hold them,
 * which is the point — but it also means a plain `rmSync(recursive, force)`
 * fails with ENOTEMPTY on the second dry run, and the whole value of a dry run
 * is that it is cheap to repeat. Restore write permission first, then remove.
 */
function forceRemove(target: string): void {
  if (!existsSync(target)) return;
  try {
    execFileSync("chmod", ["-R", "u+rwX", target], { stdio: "ignore" });
  } catch {
    // Best effort. If chmod is unavailable the rmSync below reports the real
    // problem, with the real path, which is more useful than a chmod error.
  }
  rmSync(target, { recursive: true, force: true });
}

/**
 * Wait, on a bounded deadline, for the ledger to record a usage row.
 *
 * A BOUNDARY, not a stuck-detector: it bounds one local HTTP round trip whose
 * bookkeeping is known to complete after the response body drains. It decides
 * nothing about any agent, and it terminates no run.
 */
async function waitForUsageRows(
  ledger: RunLedger,
  timeoutMs: number,
): Promise<ReturnType<RunLedger["usageRows"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = ledger.usageRows();
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

/** One line per integrity violation. Paths only — never suite content. */
function formatViolations(violations: readonly { kind: string; path: string | null; detail: string }[]): string {
  if (violations.length === 0) return "(no violations reported)";
  return violations.map((v) => `${v.kind}${v.path === null ? "" : ` @ ${v.path}`}: ${v.detail}`).join(" | ");
}

interface StageResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
  /** True when the stage could not run for an environmental reason. */
  readonly unavailable?: boolean;
}

/* -------------------------------------------------------------------------
 * The stub upstream
 * ---------------------------------------------------------------------- */

/**
 * Canned usage. Big cache-read numbers so the cache-hit metric has something
 * to chew on.
 *
 * `cache_creation` CARRIES THE 5m/1h SPLIT, and it must. Anthropic prices a
 * 5-minute and a 1-hour cache write at different rates, so a payload that
 * reports 900 write tokens without saying which TTL they were is not costable.
 * The adapter refuses it and kills the run as an infrastructure failure rather
 * than picking a rate — which is the correct behaviour, and which the first
 * version of this stub discovered the hard way by omitting the split.
 */
const STUB_USAGE = Object.freeze({
  input_tokens: 1_400,
  output_tokens: 620,
  cache_read_input_tokens: 18_000,
  cache_creation_input_tokens: 900,
  cache_creation: {
    ephemeral_5m_input_tokens: 900,
    ephemeral_1h_input_tokens: 0,
  },
});

/** The same payload with the TTL split removed: deliberately not costable. */
const STUB_USAGE_AMBIGUOUS = Object.freeze({
  input_tokens: 1_400,
  output_tokens: 620,
  cache_read_input_tokens: 18_000,
  cache_creation_input_tokens: 900,
});

interface StubUpstream {
  readonly url: string;
  calls(): number;
  close(): Promise<void>;
}

/**
 * A local server speaking enough of the Anthropic Messages API to be costed.
 *
 * It echoes back the `model` it was asked for, which is load-bearing: the proxy
 * asserts the response's model agrees with the seat it routed to, and that
 * assertion is what stops config B silently measuring deepseek-v4-flash when it
 * believes it is measuring v4-pro.
 */
async function startStubUpstream(usage: unknown = STUB_USAGE): Promise<StubUpstream> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    calls += 1;
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      let model = "unknown";
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed !== null && typeof parsed === "object") {
          const m = (parsed as Record<string, unknown>)["model"];
          if (typeof m === "string") model = m;
        }
      } catch {
        // A malformed body is the caller's problem; still answer in shape.
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "stub response" }],
          stop_reason: "end_turn",
          usage,
        }),
      );
    });
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", () => {
      r();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new BakeoffError(
      "invalid_usage_shape",
      "the stub upstream did not bind a TCP port",
      "This is a local socket problem, not a harness problem. Re-run; if it persists, something " +
        "else on this machine is refusing loopback binds.",
    );
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls: () => calls,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}

/* -------------------------------------------------------------------------
 * The canned suite
 * ---------------------------------------------------------------------- */

/** The single ticket the dry run builds. Deliberately tiny and deterministic. */
const DRY_RUN_BRIEF =
  "Build a page that greets a visitor. It writes a file called HELLO.txt containing the word " +
  "hello, and the greeting is served on the home page.\n";

function dryRunTicket(): Ticket {
  return {
    id: "DRYRUN",
    tier: "trivial",
    title: "dry-run reference ticket",
    brief: DRY_RUN_BRIEF,
    sha256: ticketDigest(DRY_RUN_BRIEF),
  };
}

/**
 * The suite manifest the sealed scorer requires.
 *
 * `build`, `lint`, `uiFlows` and `dataExpectations` are null/empty on purpose:
 * the dry-run artefact is a text file, so those gates report `not_applicable`,
 * which is the correct reading of "this suite declared nothing to check" rather
 * than "the builder omitted something".
 */
function suiteManifestSource(): string {
  return `${JSON.stringify(
    {
      manifestVersion: 1,
      ticketId: "DRYRUN",
      target: "web",
      execution: {
        // `install` is null: egress is denied at scoring time, so any command
        // that reaches a registry fails by design. The stub artefact has no
        // dependencies for exactly this reason.
        install: null,
        build: null,
        typecheck: null,
        lint: null,
        start: "node server.mjs",
        port: 3000,
        healthPath: "/health",
        bootTimeoutMs: 30_000,
        commandTimeoutMs: 60_000,
      },
      sourceDirs: ["."],
      uiFlows: [],
      dataExpectations: [],
    },
    null,
    2,
  )}\n`;
}

const APP_BASE = 'process.env.APP_BASE_URL ?? "http://127.0.0.1:3000"';

const HOLDOUT_SOURCE = `import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = ${APP_BASE};

test("[REQ-001] T-1 the home page greets the visitor", async () => {
  const body = await (await fetch(BASE + "/")).text();
  assert.match(body, /hello/i);
});

test("[REQ-002] T-2 the greeting is substantive, not empty padding", async () => {
  const body = await (await fetch(BASE + "/")).text();
  assert.ok(body.trim().length >= 5, "the greeting has no substantive content");
});
`;

const PLAYWRIGHT_SOURCE = `import { test, expect } from "@playwright/test";

test("[REQ-001] T-3 the greeting renders in a browser", async ({ page }) => {
  await page.goto(${APP_BASE});
  await expect(page.locator("#greeting")).toContainText("hello");
});
`;

const VISIBLE_SOURCE = `import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = ${APP_BASE};

test("[REQ-001] T-20 the home page answers", async () => {
  const res = await fetch(BASE + "/");
  assert.ok(res.status < 500, "the home page returned a server error");
});
`;

interface Draft {
  readonly ticketId: string;
  readonly ticketSha256: string;
  readonly criteria: readonly unknown[];
  readonly files: readonly unknown[];
}

function dryRunDraft(ticket: Ticket): Draft {
  return {
    ticketId: ticket.id,
    ticketSha256: ticket.sha256,
    criteria: [
      {
        id: "REQ-001",
        tier: "BLOCKING",
        statement: "The system shall write a file named HELLO.txt containing a greeting.",
        evidenceRequired: "holdout test T-1 PASS against the staged artefact",
        holdoutTestIds: ["T-1"],
        visibleTestIds: ["T-20"],
        evidenceArtifacts: ["HELLO.txt"],
      },
      {
        id: "REQ-002",
        tier: "FUNCTIONAL",
        statement: "When the greeting file is read, the system shall provide substantive content.",
        evidenceRequired: "holdout test T-2 PASS against the staged artefact",
        holdoutTestIds: ["T-2"],
        visibleTestIds: [],
        evidenceArtifacts: ["HELLO.txt"],
      },
    ],
    files: [
      {
        path: "holdout/greeting.test.mjs",
        visibility: "holdout",
        runner: "node-test",
        description: "greeting file content",
        expectedTestIds: ["T-1", "T-2"],
        criterionIds: ["REQ-001", "REQ-002"],
        source: HOLDOUT_SOURCE,
      },
      {
        path: "visible/greeting.test.mjs",
        visibility: "visible",
        runner: "node-test",
        description: "visible twin",
        expectedTestIds: ["T-20"],
        criterionIds: ["REQ-001"],
        source: VISIBLE_SOURCE,
      },
      {
        // A Playwright spec, so the dry run exercises BOTH runners. It is not
        // optional decoration: the scorer container invokes Playwright over
        // `*.spec.mjs` separately from `node --test` over `*.test.mjs`, and the
        // whole point of STATUS.md blocker 1.1 is that a suite exercising only
        // one of them cannot prove the other one runs. (A suite with no spec at
        // all is now legal — Playwright is simply not invoked, and an unused
        // runner is explicitly not a failure — but then this dry run would stop
        // proving that the Playwright half still works.)
        path: "holdout/greeting.spec.mjs",
        visibility: "holdout",
        runner: "playwright",
        description: "the greeting renders in a browser",
        expectedTestIds: ["T-3"],
        criterionIds: ["REQ-001"],
        source: PLAYWRIGHT_SOURCE,
      },
      {
        // At the suite ROOT, by exact name. This is the file the sealed scorer
        // refuses to run without, and it is not a test — see the allowlist in
        // spec-types.pathProblems and the guard in scorer.verifySuiteIntact.
        path: "suite.manifest.json",
        visibility: "holdout",
        runner: "node-test",
        description: "the scorer's execution manifest — a declaration, not a test",
        expectedTestIds: [],
        criterionIds: [],
        source: suiteManifestSource(),
      },
    ],
  };
}

function buildSuite(draft: Draft): AcceptanceSuite {
  const criteria = criteriaFromDraft(draft as never);
  const testFiles = testFileRefsFromDraft(draft as never);
  return {
    schemaVersion: BAKEOFF_SCHEMA_VERSION,
    ticketId: draft.ticketId,
    ticketSha256: draft.ticketSha256,
    criteria,
    testFiles,
    sha256: acceptanceSuiteDigest({
      ticketId: draft.ticketId,
      ticketSha256: draft.ticketSha256,
      criteria,
      testFiles,
    }),
    generatedBy: SPEC_SEAT,
    generatedByHarness: { id: "bakeoff-dry-run", version: "0.1.0", commit: "unversioned" },
    authoringPromptSha256: sha256Hex("dry-run: canned draft, no model was called"),
    generatedAt: new Date().toISOString(),
    auditPassed: true,
    auditFindings: [],
    auditedBy: JUDGE_SEAT,
    auditedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------
 * Stage 1 — the seal
 * ---------------------------------------------------------------------- */

interface SealOutcome {
  readonly results: readonly StageResult[];
  readonly suite: AcceptanceSuite | null;
  readonly acceptanceRoot: string;
}

/**
 * Author, audit and freeze a suite; then prove the seal detects tampering.
 *
 * The audit run here is the REAL deterministic bad-test audit — all 28
 * structural checks — not a stub. If the canned draft ever stops passing it,
 * that is a genuine signal about the audit, and the dry run reports it rather
 * than freezing an unaudited suite.
 */
function stageSeal(ctx: DryRunContext, root: string, ticket: Ticket): SealOutcome {
  const results: StageResult[] = [];
  const acceptanceRoot = join(root, DEFAULT_ACCEPTANCE_ROOT);
  forceRemove(acceptanceRoot);

  const draft = dryRunDraft(ticket);

  const findings = deterministicAudit(draft as never);
  const blocking = findings.filter((f) => f.mustRegenerate);
  results.push({
    name: "the real bad-test audit runs and clears the canned draft",
    passed: blocking.length === 0,
    detail:
      blocking.length === 0
        ? `${String(findings.length)} finding(s), none requiring regeneration`
        : `BLOCKING: ${blocking.map((f) => f.detail).join(" | ")}`,
  });
  if (blocking.length > 0) return { results, suite: null, acceptanceRoot };

  const suite = buildSuite(draft);
  const plan = planFromDraft(draft as never);
  freezeSuite(
    { suite, plan, files: draft.files as never, auditFindings: [...findings] },
    { acceptanceRoot },
  );

  const intact = verifySuiteIntact(ticket.id, { acceptanceRoot });
  results.push({
    name: "the frozen suite verifies intact immediately after freezing",
    passed: intact.intact,
    detail: intact.intact ? `digest ${suite.sha256.slice(0, 16)}...` : formatViolations(intact.violations),
  });

  // TAMPER PROOF. Flip one byte in a held-out file and confirm the seal notices.
  // Restored afterwards so the rest of the dry run scores against a valid suite.
  const holdoutPath = join(acceptanceRoot, ticket.id, "suite", "holdout", "greeting.test.mjs");
  let tamperDetected = false;
  let tamperDetail = "the held-out file could not be written to, so tampering was not simulated";
  if (existsSync(holdoutPath)) {
    const original = readFileSync(holdoutPath, "utf8");
    try {
      // The freeze chmods suite files to 0444, so this needs the mode restored
      // first. That the write requires an explicit chmod is itself part of the
      // seal, and is reported.
      execFileSync("chmod", ["u+w", holdoutPath], { stdio: "ignore" });
      writeFileSync(holdoutPath, `${original}// tampered\n`, "utf8");
      const after = verifySuiteIntact(ticket.id, { acceptanceRoot });
      tamperDetected = !after.intact;
      tamperDetail = after.intact
        ? "THE SEAL DID NOT NOTICE A MODIFIED HELD-OUT TEST FILE"
        : `detected: ${formatViolations(after.violations).slice(0, 120)}`;
      writeFileSync(holdoutPath, original, "utf8");
      execFileSync("chmod", ["0444", holdoutPath], { stdio: "ignore" });
    } catch (error) {
      tamperDetail = `could not simulate tampering: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  results.push({
    name: "a one-byte edit to a held-out test file is detected",
    passed: tamperDetected,
    detail: tamperDetail,
  });

  const restored = verifySuiteIntact(ticket.id, { acceptanceRoot });
  results.push({
    name: "the suite verifies intact again after the tamper test restores it",
    passed: restored.intact,
    detail: restored.intact ? "restored" : formatViolations(restored.violations),
  });

  ctx.emit("");
  return { results, suite, acceptanceRoot };
}

/* -------------------------------------------------------------------------
 * Stage 2 — the ceiling
 * ---------------------------------------------------------------------- */

/**
 * Prove the hard ceiling is enforced BEFORE the call, out of process.
 *
 * This is the single most important control in the harness and the one whose
 * failure is most expensive. The test sets a ceiling low enough that the very
 * next call's WORST CASE exceeds it, then confirms the proxy refuses and — the
 * part that matters — that the stub upstream's call counter did not move. A
 * ceiling checked after the response has already been billed is not a ceiling.
 */
async function stageCeiling(root: string): Promise<readonly StageResult[]> {
  const upstream = await startStubUpstream();
  // EVERY exit from here closes the stub server. Without this the first thrown
  // BakeoffError left a listening socket holding the event loop open, and the
  // dry run reported its failure and then hung forever instead of exiting.
  try {
    return await runCeilingChecks(root, upstream);
  } catch (error) {
    return [
      {
        name: "the hard ceiling is enforced before each call",
        passed: false,
        detail:
          error instanceof BakeoffError
            ? `[${error.code}] ${error.message} :: ${error.remediation}`
            : error instanceof Error
              ? error.message
              : String(error),
      },
    ];
  } finally {
    await upstream.close();
  }
}

async function runCeilingChecks(
  root: string,
  upstream: StubUpstream,
): Promise<readonly StageResult[]> {
  const results: StageResult[] = [];
  const env = dryRunEnv();
  const campaignDir = join(root, "ledger-ceiling");
  const runResultsDir = join(root, "runs-ceiling");
  mkdirSync(campaignDir, { recursive: true });
  mkdirSync(runResultsDir, { recursive: true });

  const killSwitch = new KillSwitch(join(campaignDir, "KILL"));
  const config = getConfig("A");
  const seat = config.seats.find((s) => s.role === "orchestrator");
  if (seat === undefined) throw new BakeoffError("invalid_usage_shape", "config A has no orchestrator seat", "");
  const routedSeat = { ...seat, baseUrl: upstream.url };

  const heldConstants = heldConstantsFor({
    config,
    harness: { id: "bakeoff-dry-run", version: "0.1.0", commit: "unversioned" },
    sandbox: DRY_RUN_SANDBOX,
    repeatCount: 1,
    acceptanceSuiteSha256: "0".repeat(64),
  });

  const ledger = RunLedger.open({
    runId: "dryrun-ceiling",
    phase: "screen",
    configId: "A",
    ticketId: "DRYRUN",
    repeatIndex: 0,
    heldConstants,
    // A ceiling of one cent. The next call's WORST CASE must exceed it.
    budget: { ...DEFAULT_BUDGET, maxCostUsd: 0.01, maxCampaignCostUsd: 1000 },
    runResultsDir,
    campaignDir,
    killSwitch,
    startedAt: new Date().toISOString(),
  });

  const authToken = "dry-run-token";
  const proxy = await BudgetProxy.start({
    ledger,
    authToken,
    routes: [{ seat: routedSeat, requestModelPrefixes: ["claude-"] }],
    env,
  });

  try {
    const callsBefore = upstream.calls();
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": authToken },
      body: JSON.stringify({
        model: routedSeat.modelId,
        // Worst case on this many output tokens exceeds a $0.01 ceiling.
        max_tokens: 60_000,
        messages: [{ role: "user", content: "dry run" }],
      }),
    });
    const callsAfter = upstream.calls();
    const bodyText = await response.text();

    results.push({
      name: "a call whose worst case breaches the ceiling is REFUSED",
      passed: response.status === 403,
      detail: `HTTP ${String(response.status)}${response.status === 403 ? " (budget boundary)" : ""}`,
    });
    results.push({
      name: "the refused call NEVER REACHED the upstream (checked before, not after)",
      passed: callsAfter === callsBefore,
      detail:
        callsAfter === callsBefore
          ? "upstream call counter did not move"
          : `THE UPSTREAM WAS BILLED ANYWAY: ${String(callsAfter - callsBefore)} call(s)`,
    });
    results.push({
      name: "the refusal names a boundary, not a progress judgement",
      passed: bodyText.includes("boundary") && !/stuck|no progress|idle/i.test(bodyText),
      detail: bodyText.slice(0, 160),
    });

    // Now a call that fits, to prove the allowed path still costs correctly.
    const roomy = RunLedger.open({
      runId: "dryrun-allowed",
      phase: "screen",
      configId: "A",
      ticketId: "DRYRUN",
      repeatIndex: 0,
      heldConstants,
      budget: { ...DEFAULT_BUDGET, maxCostUsd: 50, maxCampaignCostUsd: 1000 },
      runResultsDir: join(root, "runs-allowed"),
      campaignDir,
      killSwitch,
      startedAt: new Date().toISOString(),
    });
    const roomyProxy = await BudgetProxy.start({
      ledger: roomy,
      authToken,
      routes: [{ seat: routedSeat, requestModelPrefixes: ["claude-"] }],
      env,
    });
    try {
      const ok = await fetch(`${roomyProxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": authToken },
        body: JSON.stringify({
          model: routedSeat.modelId,
          max_tokens: 1_000,
          messages: [{ role: "user", content: "dry run" }],
        }),
      });
      await ok.text();
      // The proxy streams the response to the client and records usage AFTER
      // the body is drained, so "the client has the bytes" does not imply "the
      // ledger has the row". Poll on a bounded deadline rather than assuming
      // either ordering: this is a real async boundary in the proxy, not a
      // flake, and a fixed sleep would be a guess in both directions.
      const rows = await waitForUsageRows(roomy, 5_000);
      const total = roomy.totalCostUsd();
      results.push({
        name: "an in-budget call is forwarded and costed from the vendor's own usage payload",
        passed: ok.status === 200 && rows.length === 1 && total > 0,
        detail: `HTTP ${String(ok.status)}, ${String(rows.length)} usage row(s), $${total.toFixed(6)}`,
      });
      const row = rows[0];
      results.push({
        name: "cache_read tokens are recorded separately, per vendor",
        passed: row !== undefined && row.cacheReadTokens === STUB_USAGE.cache_read_input_tokens,
        detail:
          row === undefined
            ? "no usage row"
            : `input=${String(row.inputTokens)} cacheRead=${String(row.cacheReadTokens)} ` +
              `cacheWrite=${String(row.cacheWriteTokens)} output=${String(row.outputTokens)}`,
      });
      // An unauthenticated request must be refused: the sandbox token is the
      // only thing standing between any process on the host and this proxy.
      const anon = await fetch(`${roomyProxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: routedSeat.modelId, max_tokens: 10, messages: [] }),
      });
      await anon.text();
      results.push({
        name: "an unauthenticated request to the proxy is refused",
        passed: anon.status === 401,
        detail: `HTTP ${String(anon.status)}`,
      });

      // A payload that cannot be costed must KILL the run, not be recorded as
      // zero. A silently-uncosted call under-reports the bill, and the whole
      // point of the exercise is the bill.
      results.push(await checkUncostableIsRefused(root, routedSeat, killSwitch, heldConstants, env));
    } finally {
      await roomyProxy.stop();
    }
  } finally {
    await proxy.stop();
  }
  return results;
}

/**
 * A vendor payload the harness cannot price must stop the run.
 *
 * Anthropic's 5-minute and 1-hour cache writes are priced differently, so
 * `cache_creation_input_tokens` with no TTL split is genuinely ambiguous. The
 * only two honest options are "refuse" and "record the raw counts and refuse to
 * cost them"; "assume 5m" is neither, and it would understate or overstate the
 * bill silently. This confirms the refusal fires.
 */
async function checkUncostableIsRefused(
  root: string,
  routedSeat: ModelSeat,
  killSwitch: KillSwitch,
  heldConstants: HeldConstants,
  env: NodeJS.ProcessEnv,
): Promise<StageResult> {
  const upstream = await startStubUpstream(STUB_USAGE_AMBIGUOUS);
  try {
    const ledger = RunLedger.open({
      runId: "dryrun-uncostable",
      phase: "screen",
      configId: "A",
      ticketId: "DRYRUN",
      repeatIndex: 0,
      heldConstants,
      budget: { ...DEFAULT_BUDGET, maxCostUsd: 50, maxCampaignCostUsd: 1000 },
      runResultsDir: join(root, "runs-uncostable"),
      campaignDir: join(root, "ledger-uncostable"),
      killSwitch,
      startedAt: new Date().toISOString(),
    });
    const proxy = await BudgetProxy.start({
      ledger,
      authToken: "dry-run-token",
      routes: [{ seat: { ...routedSeat, baseUrl: upstream.url }, requestModelPrefixes: ["claude-"] }],
      env,
    });
    try {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "dry-run-token" },
        body: JSON.stringify({
          model: routedSeat.modelId,
          max_tokens: 1_000,
          messages: [{ role: "user", content: "dry run" }],
        }),
      });
      await res.text();
      // Give the post-response bookkeeping the same bounded window.
      const deadline = Date.now() + 5_000;
      while (ledger.killSignal() === null && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      const kill = ledger.killSignal();
      return {
        name: "a vendor payload that cannot be priced KILLS the run instead of costing it as zero",
        passed: kill !== null && kill.reason === "infrastructure_failure",
        detail:
          kill === null
            ? "THE RUN CONTINUED WITH AN UNCOSTED CALL — the dollar total would under-report the bill"
            : `killed: ${kill.reason} — ${kill.detail.slice(0, 120)}`,
      };
    } finally {
      await proxy.stop();
    }
  } finally {
    await upstream.close();
  }
}

/* -------------------------------------------------------------------------
 * Stage 3 — the sealed build container
 * ---------------------------------------------------------------------- */

/** The builder stub. Writes the artefact and a STRUCTURED self-report. */
const STUB_BUILDER_SCRIPT = `
const { mkdirSync, writeFileSync } = await import("node:fs");

// Spend through the proxy exactly as a real builder would.
const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_AUTH_TOKEN },
  body: JSON.stringify({
    model: process.env.ANTHROPIC_MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: "dry run" }],
  }),
});
console.log("stub builder: proxy replied " + res.status);

// The artefact. A real, bootable, dependency-free web app: the sealed scorer
// requires execution.start / port / healthPath, boots the app inside a
// --network=none container and drives the frozen suite against it over
// loopback. A text file would not exercise any of that.
writeFileSync(
  "/workspace/server.mjs",
  [
    'import { createServer } from "node:http";',
    'const PORT = Number(process.env.PORT ?? 3000);',
    'createServer((req, res) => {',
    '  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(\\'{"ok":true}\\'); return; }',
    '  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });',
    '  res.end("<!doctype html><html><body><h1 id=\\\\"greeting\\\\">hello from the dry run</h1></body></html>");',
    '}).listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));',
    '',
  ].join("\\n"),
);
writeFileSync(
  "/workspace/package.json",
  JSON.stringify({ name: "dry-run-artifact", private: true, type: "module", version: "0.0.0" }, null, 2) + "\\n",
);

// agentDeclaredDone comes from THIS FILE and nothing else. No prose is parsed.
mkdirSync("/workspace/.bakeoff", { recursive: true });
writeFileSync(
  "/workspace/.bakeoff/self-report.json",
  JSON.stringify({ status: "done", reason: "wrote HELLO.txt" }),
);
`;

/** Resolve a local image's content digest. Never hard-coded: hosts differ. */
function localImageDigest(imageRef: string): string | null {
  try {
    const raw = execFileSync(
      "docker",
      ["image", "inspect", imageRef, "--format", "{{index .RepoDigests 0}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const at = raw.lastIndexOf("@");
    if (at === -1) return null;
    const digest = raw.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

interface BuildOutcome {
  readonly results: readonly StageResult[];
  readonly runResultsDir: string | null;
}

async function stageBuild(
  ctx: DryRunContext,
  root: string,
  ticket: Ticket,
  suite: AcceptanceSuite,
  acceptanceRoot: string,
  builderImage: string,
): Promise<BuildOutcome> {
  const results: StageResult[] = [];
  const digest = localImageDigest(builderImage);
  if (digest === null) {
    results.push({
      name: "sealed build container",
      passed: false,
      unavailable: true,
      detail:
        `the builder image ${builderImage} is not present locally with a content digest. ` +
        `Run: docker pull ${builderImage}    (the runner refuses an image that is not pinned ` +
        "by digest, which is the point — an unpinned image silently varies held-constant variable 3).",
    });
    return { results, runResultsDir: null };
  }

  const upstream = await startStubUpstream();
  const campaignDir = join(root, "ledger");
  const runId = "dryrun-A-DRYRUN-r0";
  const runResultsDir = join(root, "runs", runId);
  const base = getConfig("A");
  const config = {
    ...base,
    seats: base.seats.map((s) =>
      s.role === "orchestrator" || s.role === "subagent" ? { ...s, baseUrl: upstream.url } : s,
    ),
  };
  const sandbox: SandboxSpec = {
    imageRef: builderImage,
    imageDigest: digest,
    networkPolicy: SEALED_NETWORK_POLICY,
  };
  const harness = { id: "bakeoff", version: "0.1.0", commit: "unversioned" };

  try {
    const runner = new DockerRunner({
      harness,
      sandbox,
      campaignDir,
      killSwitch: new KillSwitch(join(campaignDir, "KILL")),
      phase: "screen",
      acceptanceRoot,
      // The runner starts its OWN budget proxy and resolves credentials by
      // environment-variable name. Without the placeholder env it demands a
      // real ANTHROPIC_API_KEY and fails the run as an infrastructure failure —
      // correctly, but it makes a $0 dry run impossible.
      env: dryRunEnv(),
      builderCommand: {
        argv: ["node", "-e", STUB_BUILDER_SCRIPT],
        notes: "dry-run stub builder — stands in for the Claude Code CLI, spends nothing",
      },
    });

    ctx.emit("  starting the sealed build container (this takes a few seconds)...");
    const record = await runner.run({
      runId,
      ticket,
      config,
      repeatIndex: 0,
      budget: { ...DEFAULT_BUDGET, maxWallClockMs: 300_000, maxCostUsd: 5 },
      heldConstants: heldConstantsFor({
        config,
        harness,
        sandbox,
        repeatCount: 1,
        acceptanceSuiteSha256: suite.sha256,
      }),
      workspaceDir: join(root, "workspaces", runId),
      resultsDir: runResultsDir,
    });

    const outcomePath = join(runResultsDir, "runner-outcome.json");
    const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as {
      sealProbe: { egressDenied: boolean; proxyReachable: boolean; detail: string } | null;
      forbiddenPathViolations: readonly string[];
      selfReport: { status: string } | null;
    };

    results.push({
      name: "the run completed and produced a run record",
      passed: record.status === "completed" && existsSync(join(runResultsDir, "run.jsonl")),
      detail: `status=${record.status}`,
    });
    results.push({
      name: "EGRESS DENIED — verified from inside the container, on this run",
      passed: outcome.sealProbe?.egressDenied === true,
      detail: outcome.sealProbe === null ? "no probe result" : outcome.sealProbe.detail.slice(0, 160),
    });
    results.push({
      name: "the only route out is this run's own budget proxy, and it demands auth",
      passed:
        outcome.sealProbe?.proxyReachable === true &&
        outcome.sealProbe.detail.includes("status 401"),
      detail: outcome.sealProbe === null ? "no probe result" : "proxy answered 401 to an unauthenticated probe",
    });
    results.push({
      name: "agentDeclaredDone came from the structured self-report file",
      passed: record.agentDeclaredDone === true && outcome.selfReport?.status === "done",
      detail: `agentDeclaredDone=${String(record.agentDeclaredDone)}, self-report status=${String(outcome.selfReport?.status)}`,
    });
    results.push({
      name: "the builder touched no forbidden path",
      passed: outcome.forbiddenPathViolations.length === 0,
      detail:
        outcome.forbiddenPathViolations.length === 0
          ? "none"
          : outcome.forbiddenPathViolations.join(", "),
    });
    results.push({
      name: "the builder spent through the proxy and was costed",
      passed: record.usage.length > 0 && record.totalCostUsd > 0,
      detail: `${String(record.usage.length)} usage row(s), $${record.totalCostUsd.toFixed(6)} (INVENTED tokens)`,
    });

    // The credential check. The sandbox holds a random per-run token; the real
    // key never enters the container. Confirm neither survives into artefacts.
    const logPath = join(runResultsDir, "run.log");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const argv = readFileSync(join(runResultsDir, "docker-argv.json"), "utf8");
    const key = process.env["ANTHROPIC_API_KEY"];
    const keyLeaked = key !== undefined && key.length > 0 && (log.includes(key) || argv.includes(key));
    results.push({
      name: "no credential value survives into the run log or the recorded docker argv",
      passed: !keyLeaked,
      detail: key === undefined || key.length === 0
        ? "no ANTHROPIC_API_KEY was set, so the strongest form of this check did not run"
        : "the key set in this shell appears in neither artefact",
    });

    // The visible half must be in the workspace and the held-out half must not.
    const workspace = join(root, "workspaces", runId);
    // The runner materialises the visible half at WORKSPACE.visibleDir.
    const visibleCopied = existsSync(join(workspace, "visible-acceptance", "greeting.test.mjs"));
    const holdoutLeaked =
      existsSync(join(workspace, "visible-acceptance", "holdout")) ||
      existsSync(join(workspace, ".bakeoff", "suite", "holdout"));
    results.push({
      name: "the VISIBLE half reached the workspace and the HELD-OUT half did not",
      passed: visibleCopied && !holdoutLeaked,
      detail: `visible present=${String(visibleCopied)}, holdout present=${String(holdoutLeaked)}`,
    });

    return { results, runResultsDir };
  } catch (error) {
    results.push({
      name: "sealed build container",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { results, runResultsDir: null };
  } finally {
    await upstream.close();
  }
}

/* -------------------------------------------------------------------------
 * Stage 4 — the sealed gate
 * ---------------------------------------------------------------------- */

async function stageScore(
  ctx: DryRunContext,
  root: string,
  acceptanceRoot: string,
  scorerImage: string,
): Promise<readonly StageResult[]> {
  const results: StageResult[] = [];
  if (localImageDigest(scorerImage) === null && !imageExistsLocally(scorerImage)) {
    results.push({
      name: "sealed acceptance gate",
      passed: false,
      unavailable: true,
      detail:
        `the scorer image ${scorerImage} is not built. From bakeoff/:\n` +
        "      docker build --provenance=false --sbom=false -f docker/scorer.Dockerfile -t bakeoff-scorer:1 .",
    });
    return results;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BAKEOFF_SCORER_IMAGE: scorerImage,
    BAKEOFF_RESULTS_DIR: root,
    BAKEOFF_ACCEPTANCE_ROOT: acceptanceRoot,
  };

  try {
    const gate = await createGate(env);
    results.push({
      name: "the gate resolves the scorer image by CONTENT DIGEST",
      passed: /^sha256:[0-9a-f]{64}$/.test(gate.scorerImageDigest),
      detail: gate.scorerImageDigest,
    });

    ctx.emit("  scoring in the sealed --network=none container...");
    const outcome = await scoreRuns({
      resultsRoot: join(root, "runs"),
      acceptanceRoot,
      gate,
      emit: (t) => {
        ctx.emit(`  ${t.trim()}`);
      },
    });
    results.push({
      name: "the sealed gate scored the run and produced a score record",
      passed: outcome.scored === 1 && outcome.failed.length === 0,
      detail: formatScoringOutcome(outcome).split("\n")[0] ?? "",
    });
    // THE CHECK THAT MAKES THE OTHERS MEAN SOMETHING. A gate that fails every
    // artefact is indistinguishable, in the final report, from five models that
    // all failed — and it produces a complete, plausible, entirely wrong result.
    // The stub artefact is honest and complete by construction, so it MUST pass.
    results.push({
      name: "the gate PASSES an honest artefact (a gate that can never pass is not a gate)",
      passed: outcome.heldOutPasses === 1 && outcome.falseFinishes === 0,
      detail:
        outcome.heldOutPasses === 1
          ? "heldOutPass=true, falseFinish=false on a correct artefact"
          : "THE HONEST ARTEFACT FAILED THE HELD-OUT SUITE. Read the score record before " +
            "spending: a uniform failure across configurations would look exactly like this.",
    });
    if (outcome.failed.length > 0) {
      for (const f of outcome.failed) {
        results.push({ name: `scoring ${f.runId}`, passed: false, detail: f.reason.slice(0, 300) });
      }
    }
  } catch (error) {
    results.push({
      name: "sealed acceptance gate",
      passed: false,
      detail: error instanceof BakeoffError
        ? `[${error.code}] ${error.message} :: ${error.remediation}`
        : error instanceof Error
          ? error.message
          : String(error),
    });
  }
  return results;
}

function imageExistsLocally(imageRef: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", imageRef], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------
 * Stage 5 — the report
 * ---------------------------------------------------------------------- */

function stageReport(root: string): readonly StageResult[] {
  const results: StageResult[] = [];
  // With no build stage there are no run records, and "the reporter refused to
  // report on zero runs" is the reporter working correctly. Reporting it as a
  // FAILURE would train the owner to ignore a red line in the one output whose
  // job is to be trusted.
  if (!existsSync(join(root, "runs"))) {
    results.push({
      name: "aggregation, decision rule, report",
      passed: false,
      unavailable: true,
      detail:
        "no run records exist, because stage 3 did not run. The reporter's refusal to report on " +
        "zero runs is correct behaviour and was not exercised further. Re-run without --no-docker.",
    });
    return results;
  }
  try {
    const written = writeReport({ resultsDir: join(root, "runs"), outPath: join(root, "REPORT.md") });
    const markdown = readFileSync(written.outPath, "utf8");
    results.push({
      name: "the reporter joined the records and wrote a report",
      passed: written.aggregation.runCount > 0 && markdown.length > 0,
      detail:
        `${String(written.aggregation.runCount)} run record(s), ` +
        `${String(written.aggregation.scoreCount)} score record(s) -> ${written.outPath}`,
    });
    results.push({
      name: "the decision rule was applied and printed",
      passed: markdown.includes("DECISION RULE") || markdown.toLowerCase().includes("decision rule"),
      detail: `${String(markdown.split("\n").length)} lines`,
    });
  } catch (error) {
    const message = error instanceof BakeoffError ? `[${error.code}] ${error.message}` : String(error);
    results.push({ name: "the reporter ran", passed: false, detail: message });
  }
  return results;
}

/* -------------------------------------------------------------------------
 * Driver
 * ---------------------------------------------------------------------- */

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

const BANNER = [
  "===============================================================================",
  " DRY RUN — NO VENDOR IS CALLED, NO MONEY IS SPENT, NOTHING HERE IS A RESULT",
  "===============================================================================",
  "",
  "Stubbed: the model responses, the builder binary, and the spec seat's authoring",
  "call. Everything else is the real thing — the real budget proxy and its pre-call",
  "ceiling, the real freeze and its digests, the real bad-test audit, the real",
  "sealed build container, the real --network=none acceptance gate, the real",
  "decision rule. The token counts below are INVENTED and every dollar figure is",
  "arithmetic on an invented count.",
  "",
].join("\n");

export interface DryRunOptions {
  readonly root: string;
  readonly builderImage: string;
  readonly scorerImage: string;
  readonly skipDocker: boolean;
}

export function parseDryRunOptions(flags: ReadonlyMap<string, string>, booleans: ReadonlySet<string>): DryRunOptions {
  return {
    root: absolute(flags.get("root") ?? "dry-run"),
    builderImage: flags.get("builder-image") ?? "node:22",
    scorerImage: flags.get("scorer-image") ?? "bakeoff-scorer:1",
    skipDocker: booleans.has("no-docker"),
  };
}

function renderStage(ctx: DryRunContext, title: string, results: readonly StageResult[]): { failed: number; unavailable: number } {
  ctx.emit(title);
  let failed = 0;
  let unavailable = 0;
  for (const r of results) {
    if (r.unavailable === true) {
      unavailable += 1;
      ctx.emit(`  SKIP  ${r.name}`);
      ctx.emit(`        ${r.detail}`);
      continue;
    }
    if (!r.passed) failed += 1;
    ctx.emit(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.passed || r.detail.length > 0) ctx.emit(`        ${r.detail}`);
  }
  ctx.emit("");
  return { failed, unavailable };
}

/**
 * Run the whole pipeline against stubs.
 *
 * Returns 0 only when every stage that COULD run did run and passed. A stage
 * that could not run for an environmental reason (no Docker, unbuilt image) is
 * reported as SKIP and returns 1 — the owner must know the pipeline was only
 * partly proved, and a silent partial validation is worse than none.
 */
export async function cmdDryRun(ctx: DryRunContext, argv: readonly string[]): Promise<number> {
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
  const options = parseDryRunOptions(flags, booleans);

  ctx.emit(BANNER);
  ctx.emit(`root: ${options.root}`);
  ctx.emit("");

  forceRemove(options.root);
  mkdirSync(options.root, { recursive: true });
  writeFileSync(join(options.root, DRY_RUN_MARKER_FILENAME), DRY_RUN_MARKER_TEXT, "utf8");

  let failed = 0;
  let unavailable = 0;
  const ticket = dryRunTicket();

  // ---- 1. the seal ------------------------------------------------------
  const seal = stageSeal(ctx, options.root, ticket);
  {
    const s = renderStage(ctx, "STAGE 1 — THE SEAL (no Docker, no credentials)", seal.results);
    failed += s.failed;
    unavailable += s.unavailable;
  }
  if (seal.suite === null) {
    ctx.emit("The suite could not be frozen, so no later stage can run. Stopping.");
    return 1;
  }

  // ---- 2. the ceiling ---------------------------------------------------
  {
    const s = renderStage(
      ctx,
      "STAGE 2 — THE HARD CEILING, CHECKED BEFORE EACH CALL (no Docker, no credentials)",
      await stageCeiling(options.root),
    );
    failed += s.failed;
    unavailable += s.unavailable;
  }

  // ---- 3 + 4. Docker ----------------------------------------------------
  if (options.skipDocker) {
    ctx.emit("STAGE 3 + 4 — SKIPPED by --no-docker.");
    ctx.emit(
      "  The sealed build container and the sealed acceptance gate were NOT exercised.\n" +
        "  Those two stages are the seal. Re-run without --no-docker before spending.\n",
    );
    unavailable += 2;
  } else {
    const build = await stageBuild(
      ctx,
      options.root,
      ticket,
      seal.suite,
      seal.acceptanceRoot,
      options.builderImage,
    );
    const s3 = renderStage(ctx, "STAGE 3 — THE SEALED BUILD CONTAINER", build.results);
    failed += s3.failed;
    unavailable += s3.unavailable;

    if (build.runResultsDir === null) {
      ctx.emit("STAGE 4 — SKIPPED: no run record was produced to score.\n");
      unavailable += 1;
    } else {
      const s4 = renderStage(
        ctx,
        "STAGE 4 — THE SEALED ACCEPTANCE GATE (--network=none)",
        await stageScore(ctx, options.root, seal.acceptanceRoot, options.scorerImage),
      );
      failed += s4.failed;
      unavailable += s4.unavailable;
    }
  }

  // ---- 5. the report ----------------------------------------------------
  {
    const s = renderStage(ctx, "STAGE 5 — AGGREGATION, DECISION RULE, REPORT", stageReport(options.root));
    failed += s.failed;
    unavailable += s.unavailable;
  }

  // Re-stamp the marker: writeReport may have created directories around it.
  writeFileSync(join(options.root, DRY_RUN_MARKER_FILENAME), DRY_RUN_MARKER_TEXT, "utf8");

  ctx.emit("===============================================================================");
  if (failed === 0 && unavailable === 0) {
    ctx.emit("DRY RUN COMPLETE — every stage ran and every check passed.");
    ctx.emit("");
    ctx.emit("This proves the HARNESS. It proves nothing about any model. The numbers in");
    ctx.emit(`${join(options.root, "REPORT.md")} came from a stub and are not results.`);
    return 0;
  }
  ctx.emit(
    `DRY RUN INCOMPLETE — ${String(failed)} check(s) failed, ${String(unavailable)} stage(s) could not run.`,
  );
  ctx.emit("");
  ctx.emit("Do NOT start a paid campaign on this. Every SKIP above names the exact command");
  ctx.emit("that clears it, and every FAIL is a control the experiment depends on.");
  return 1;
}

/** Persist-safe summary for callers that want the marker text redacted-checked. */
export function dryRunMarker(): string {
  return redactForPersistence(DRY_RUN_MARKER_TEXT, PERSIST_REDACT_OPTIONS);
}
